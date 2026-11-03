// DM and group chat send limits.
const crypto = require('crypto');
const { MAX_MSG_LENGTH, envNum } = require('../config');
const { getStmt } = require('../db/connection');
const { NEW_ACCOUNT_AGE_MS, normalizePostText } = require('./post-spam');
const { cleanupAttachmentFiles } = require('../uploads/files');
const { formatDuration } = require('../util');

// DM / group chat send limits
// Posts have their own flood guard above; DMs and group chats had nothing.
const CHAT_BURST_MAX = Math.max(1, Math.floor(envNum('CHAT_BURST_MAX', 10)));
const CHAT_BURST_WINDOW_MS = Math.max(1, envNum('CHAT_BURST_WINDOW_SECONDS', 10)) * 1000;
const CHAT_MINUTE_CHARS = Math.max(MAX_MSG_LENGTH, Math.floor(envNum('CHAT_MINUTE_CHARS', 16000)));
const CHAT_HOUR_CHARS = Math.max(CHAT_MINUTE_CHARS, Math.floor(envNum('CHAT_HOUR_CHARS', 120000)));
const CHAT_NEW_ACCOUNT_FACTOR = Math.min(1, Math.max(0.1, envNum('CHAT_NEW_ACCOUNT_FACTOR', 0.5)));
const CHAT_DUPLICATE_WINDOW_MS = envNum('CHAT_DUPLICATE_WINDOW_SECONDS', 60) * 1000;
const CHAT_DUPLICATE_MIN_CHARS = 50;
const chatSendLog = new Map(); // userId -> [{ ts, chars, h }]

setInterval(() => {
    const now = Date.now();
    chatSendLog.forEach((arr, k) => {
        const kept = arr.filter(e => now - e.ts < 60 * 60 * 1000);
        if (kept.length) chatSendLog.set(k, kept); else chatSendLog.delete(k);
    });
}, 5 * 60 * 1000).unref();

// ms until `need` more characters would fit under `limit` for the given window (0 = fits now).
function chatRetryForBudget(entries, windowMs, limit, need, now) {
    const inWin = entries.filter(e => now - e.ts < windowMs);
    const total = inWin.reduce((s, e) => s + e.chars, 0);
    const excess = total + need - limit;
    if (excess <= 0) return 0;
    let freed = 0;
    for (const e of inWin) {
        freed += e.chars;
        if (freed >= excess) return Math.max(1000, e.ts + windowMs - now);
    }
    return windowMs;
}

function chatIsNewAccount(userId, now) {
    try {
        const row = getStmt(`SELECT created_ts FROM Registration_IPs WHERE user_id = ? ORDER BY created_ts DESC LIMIT 1`).get(userId);
        return !!row && (now - row.created_ts) < NEW_ACCOUNT_AGE_MS;
    } catch (e) { return false; } // fail open
}

// Returns null (allowed) or { status, message, retryMs }. Does not record anything.
function chatLimitVerdict(userId, chars, hash) {
    const now = Date.now();
    const log = chatSendLog.get(userId) || [];
    const factor = chatIsNewAccount(userId, now) ? CHAT_NEW_ACCOUNT_FACTOR : 1;
    const burst = log.filter(e => now - e.ts < CHAT_BURST_WINDOW_MS);
    if (burst.length >= CHAT_BURST_MAX) {
        const retryMs = Math.max(1000, burst[0].ts + CHAT_BURST_WINDOW_MS - now);
        return { status: 429, retryMs, message: `You're sending messages too fast. Please wait ${formatDuration(retryMs)}.` };
    }
    const need = Math.max(1, chars);
    const minuteWait = chatRetryForBudget(log, 60 * 1000, Math.floor(CHAT_MINUTE_CHARS * factor), need, now);
    const hourWait = chatRetryForBudget(log, 60 * 60 * 1000, Math.floor(CHAT_HOUR_CHARS * factor), need, now);
    const wait = Math.max(minuteWait, hourWait);
    if (wait > 0) {
        return { status: 429, retryMs: wait, message: `You've sent a lot of text in a short time. Please wait ${formatDuration(wait)} before sending more.` };
    }
    if (hash && log.some(e => e.h === hash && now - e.ts < CHAT_DUPLICATE_WINDOW_MS)) {
        return { status: 422, retryMs: 0, message: 'You already sent that a moment ago.' };
    }
    return null;
}

// stage 'pre' : runs BEFORE the upload middleware.
function chatSendGuard(stage, opts) {
    const dedupe = !(opts && opts.dedupe === false);
    return (req, res, next) => {
        if (!req.session || !req.session.userId || req.isAdmin) return next();
        const userId = req.session.userId;
        const content = stage === 'post' ? String((req.body && req.body.content) || '').trim() : '';
        let hash = null;
        if (stage === 'post' && dedupe && content.length >= CHAT_DUPLICATE_MIN_CHARS) {
            hash = crypto.createHash('sha1').update(normalizePostText(content)).digest('hex');
        }
        const verdict = chatLimitVerdict(userId, stage === 'post' ? content.length : 0, hash);
        if (verdict) {
            if (req.files && req.files.length) cleanupAttachmentFiles(req.files.map(f => ({ path: f.path, name: f.originalname, size: f.size })));
            if (verdict.retryMs) res.set('Retry-After', String(Math.ceil(verdict.retryMs / 1000)));
            return res.status(verdict.status).json({ error: verdict.message, code: 'chat_rate_limited', retryAfterMs: verdict.retryMs });
        }
        if (stage === 'post') {
            const log = chatSendLog.get(userId) || [];
            log.push({ ts: Date.now(), chars: content.length, h: hash });
            chatSendLog.set(userId, log.slice(-500));
        }
        next();
    };
}

module.exports = { chatSendGuard };
