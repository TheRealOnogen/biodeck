// Post flood and spam protection.
const crypto = require('crypto');
const { getStmt } = require('../db/connection');
const { logAudit } = require('../moderation');
const { renderMessagePage } = require('../render/pages');
const { formatDuration } = require('../util');

// Post spam protection
// (a) Flood timeout: POST_FLOOD_MAX accepted posts/replies inside POST_FLOOD_WINDOW_MS puts the
// account in a POST_FLOOD_TIMEOUT_MS.
const POST_FLOOD_MAX = 3;
const POST_FLOOD_WINDOW_MS = 10 * 1000;
const POST_FLOOD_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const NEW_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000;
const NEW_ACCOUNT_POST_GAP_MS = 15 * 1000;
const NEW_ACCOUNT_MAX_LINKS = 2;
const MAX_MENTIONS_PER_POST = 5;
const DUPLICATE_POST_WINDOW_MS = 5 * 60 * 1000;
const CROSS_USER_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const CROSS_USER_DUPLICATE_MAX_USERS = 4; // the 4th different account posting identical text is refused

const postAttemptLog = new Map();   // userId -> [attempt timestamps]
const recentPostsByUser = new Map(); // userId -> [{ h: contentHash|null, ts }]
const recentPostContent = new Map(); // contentHash -> { users: Set<userId>, ts }

setInterval(() => {
    const now = Date.now();
    postAttemptLog.forEach((arr, k) => { if (!arr.length || now - arr[arr.length - 1] > POST_FLOOD_WINDOW_MS) postAttemptLog.delete(k); });
    recentPostsByUser.forEach((arr, k) => { if (!arr.length || now - arr[arr.length - 1].ts > DUPLICATE_POST_WINDOW_MS) recentPostsByUser.delete(k); });
    recentPostContent.forEach((e, k) => { if (now - e.ts > CROSS_USER_DUPLICATE_WINDOW_MS) recentPostContent.delete(k); });
    try { getStmt(`DELETE FROM Post_Timeouts WHERE expires_ts < ?`).run(now); } catch (e) { /* table not ready yet */ }
}, 5 * 60 * 1000).unref();

// Milliseconds left on this user's posting timeout (0 = none). Expired rows
// are deleted on sight.
function getPostTimeoutLeftMs(userId) {
    try {
        const row = getStmt(`SELECT expires_ts FROM Post_Timeouts WHERE user_id = ?`).get(userId);
        if (!row) return 0;
        const left = row.expires_ts - Date.now();
        if (left <= 0) { getStmt(`DELETE FROM Post_Timeouts WHERE user_id = ?`).run(userId); return 0; }
        return left;
    } catch (e) {
        console.error('Post timeout lookup error:', e.message);
        return 0; // a broken lookup must never block everyone from posting
    }
}

function startPostTimeout(userId, username) {
    const until = Date.now() + POST_FLOOD_TIMEOUT_MS;
    try {
        getStmt(`INSERT INTO Post_Timeouts (user_id, username, expires_ts, reason) VALUES (?, ?, ?, ?)
                 ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, expires_ts = excluded.expires_ts, reason = excluded.reason, created_at = CURRENT_TIMESTAMP`)
            .run(userId, username, until, 'post flood');
    } catch (e) {
        console.error('Post timeout save error:', e.message);
    }
    logAudit('post_timeout', 'System', username,
        `${POST_FLOOD_MAX} posts within ${POST_FLOOD_WINDOW_MS / 1000}s - posting disabled for ${POST_FLOOD_TIMEOUT_MS / 3600000}h`);
}

// Same body for both clients: the web UI posts with fetch (Accept: */*) and shows the JSON "error"
// in its red toast.
function sendPostRejection(req, res, status, message) {
    if (String(req.headers.accept || '').includes('text/html')) {
        return res.status(status).send(renderMessagePage('Slow down', message,
            `<button type="button" class="button" style="width: 150px" onclick="history.back();">Go back</button>`));
    }
    return res.status(status).json({ error: message });
}

// Runs BEFORE the multipart upload middleware on purpose: while an account is in a timeout.
function postFloodGuard(req, res, next) {
    if (!req.session || !req.session.userId || req.isAdmin) return next();
    const left = getPostTimeoutLeftMs(req.session.userId);
    if (left > 0) {
        return sendPostRejection(req, res, 429, `You're in a posting timeout for another ${formatDuration(left)}.`);
    }
    next();
}

// Counts one post that has already passed validation and checkPostSpam.
function checkPostFlood(req) {
    if (req.isAdmin) return null;
    const userId = req.session.userId;
    const now = Date.now();
    const attempts = (postAttemptLog.get(userId) || []).filter(t => now - t < POST_FLOOD_WINDOW_MS);
    attempts.push(now);
    if (attempts.length >= POST_FLOOD_MAX) {
        postAttemptLog.delete(userId);
        startPostTimeout(userId, req.session.userUsername);
        return { status: 429, message: `You posted too many times too quickly, so posting is disabled on your account for ${formatDuration(POST_FLOOD_TIMEOUT_MS)}.` };
    }
    postAttemptLog.set(userId, attempts);
    return null;
}

function normalizePostText(content) {
    return (content || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Content-level checks, run once the post has been parsed and validated.
function checkPostSpam(req, content) {
    if (req.isAdmin) return null;
    const userId = req.session.userId;
    const now = Date.now();
    const text = (content || '').trim();

    const mentions = new Set((text.match(/@[a-zA-Z0-9_]{1,32}/g) || []).map(m => m.toLowerCase()));
    if (mentions.size > MAX_MENTIONS_PER_POST) {
        return { status: 422, message: `Too many mentions - you can mention at most ${MAX_MENTIONS_PER_POST} people per post.` };
    }

    // Account age comes from Registration_IPs (written for every signup); accounts that predate
    // that table simply count as established.
    let newAccount = false;
    try {
        const row = getStmt(`SELECT created_ts FROM Registration_IPs WHERE user_id = ? ORDER BY created_ts DESC LIMIT 1`).get(userId);
        newAccount = !!row && (now - row.created_ts) < NEW_ACCOUNT_AGE_MS;
    } catch (e) { /* fail open */ }

    const recent = (recentPostsByUser.get(userId) || []).filter(p => now - p.ts < DUPLICATE_POST_WINDOW_MS);

    if (newAccount) {
        const last = recent.length ? recent[recent.length - 1].ts : 0;
        if (last && now - last < NEW_ACCOUNT_POST_GAP_MS) {
            const wait = Math.ceil((NEW_ACCOUNT_POST_GAP_MS - (now - last)) / 1000);
            return { status: 429, message: `New accounts can post once every ${NEW_ACCOUNT_POST_GAP_MS / 1000} seconds - try again in ${wait}s.` };
        }
        const links = (text.match(/https?:\/\/|www\./gi) || []).length;
        if (links > NEW_ACCOUNT_MAX_LINKS) {
            return { status: 422, message: `New accounts can include at most ${NEW_ACCOUNT_MAX_LINKS} links per post.` };
        }
    }

    const norm = normalizePostText(text);
    if (norm.length >= 10) {
        const hash = crypto.createHash('sha1').update(norm).digest('hex');
        if (recent.some(p => p.h === hash)) {
            return { status: 422, message: 'You already posted that a moment ago.' };
        }
        if (norm.length >= 20) {
            const entry = recentPostContent.get(hash);
            if (entry && now - entry.ts < CROSS_USER_DUPLICATE_WINDOW_MS && !entry.users.has(userId)
                && entry.users.size >= CROSS_USER_DUPLICATE_MAX_USERS - 1) {
                return { status: 422, message: 'That exact message is being posted by a lot of accounts right now, so it was blocked as spam.' };
            }
        }
    }
    return null;
}

// Remembers a post that went through, for the duplicate / slow-mode checks.
function recordAcceptedPost(req, content) {
    if (req.isAdmin) return;
    const userId = req.session.userId;
    const now = Date.now();
    const norm = normalizePostText(content);
    const hash = norm.length >= 10 ? crypto.createHash('sha1').update(norm).digest('hex') : null;
    const recent = (recentPostsByUser.get(userId) || []).filter(p => now - p.ts < DUPLICATE_POST_WINDOW_MS);
    recent.push({ h: hash, ts: now });
    recentPostsByUser.set(userId, recent.slice(-10));
    if (hash && norm.length >= 20) {
        const entry = recentPostContent.get(hash);
        if (!entry || now - entry.ts >= CROSS_USER_DUPLICATE_WINDOW_MS) recentPostContent.set(hash, { users: new Set([userId]), ts: now });
        else entry.users.add(userId);
    }
}

module.exports = {
    NEW_ACCOUNT_AGE_MS,
    checkPostFlood,
    checkPostSpam,
    normalizePostText,
    postAttemptLog,
    postFloodGuard,
    recordAcceptedPost,
    sendPostRejection,
};
