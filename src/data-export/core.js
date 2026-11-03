// Data export constants and small helpers.
const path = require('path');
const fs = require('fs');
const { db } = require('../db/connection');
const { ROOT_DIR } = require('../paths');

const DATA_DIR = path.join(ROOT_DIR, 'data');
const DATA_EXPORTS_DIR = path.join(DATA_DIR, 'exports');
fs.mkdirSync(DATA_EXPORTS_DIR, { recursive: true, mode: 0o700 });

const DATA_EXPORT_MAX_EMAIL_BYTES = Math.max(0.001, parseFloat(process.env.DATA_EXPORT_MAX_EMAIL_MB || '15')) * 1024 * 1024;
const DATA_EXPORT_LINK_TTL_MS = Math.max(0.01, parseFloat(process.env.DATA_EXPORT_LINK_TTL_HOURS || '168')) * 60 * 60 * 1000;
const DATA_EXPORT_MAX_PER_DAY = Math.max(1, parseInt(process.env.DATA_EXPORT_MAX_PER_DAY || '3', 10) || 3);
const DATA_EXPORT_COOLDOWN_DAYS = Math.max(0.001, parseFloat(process.env.DATA_EXPORT_COOLDOWN_DAYS || '7') || 7);
const DATA_EXPORT_COOLDOWN_MS = DATA_EXPORT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const DATA_EXPORT_UNLIMITED = ['1', 'true', 'yes', 'on'].includes(String(process.env.DATA_EXPORT_UNLIMITED || '').toLowerCase());
const DATA_EXPORT_MAX_TOTAL_BYTES = Math.max(1, parseFloat(process.env.DATA_EXPORT_MAX_TOTAL_MB || '2048') || 2048) * 1024 * 1024;
const DATA_EXPORT_MAX_SIZE_BYTES = Math.max(1, parseFloat(process.env.DATA_EXPORT_MAX_SIZE_MB || '1024') || 1024) * 1024 * 1024;
function dxTooLargeError(bytes) {
    const mb = (b) => (b / (1024 * 1024)).toFixed(b >= 10 * 1024 * 1024 ? 0 : 1) + ' MB';
    return new DxUserError(`Your data is ${mb(bytes)}, which is over the ${mb(DATA_EXPORT_MAX_SIZE_BYTES)} export limit. Try again with fewer categories selected (for example, leave out DMs), or contact support.`);
}
const DATA_EXPORT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const DATA_EXPORT_COOKIE = 'dx_token';

const DATA_EXPORT_CATEGORIES = [
    { key: 'posts',   label: 'Posts',                                   dir: 'posts/' },
    { key: 'dms',     label: 'DMs (and your group chat messages)',      dir: 'dms/' },
    { key: 'account', label: 'Account info',                            dir: 'account/' },
    { key: 'support', label: 'Support tickets',                         dir: 'support/' }
];

// Returns the valid category keys in canonical order ([] if none were valid).
function parseExportCategories(input) {
    const arr = Array.isArray(input) ? input : (typeof input === 'string' ? input.split(',') : []);
    const wanted = new Set(arr.map(s => String(s).trim().toLowerCase()));
    return DATA_EXPORT_CATEGORIES.filter(c => wanted.has(c.key)).map(c => c.key);
}

// Promise wrappers around the db shim.
function dxAll(sql, params) { return new Promise((resolve, reject) => db.all(sql, params || [], (e, r) => e ? reject(e) : resolve(r || []))); }
function dxGet(sql, params) { return new Promise((resolve, reject) => db.get(sql, params || [], (e, r) => e ? reject(e) : resolve(r))); }
function dxRun(sql, params) {
    return new Promise((resolve, reject) => db.run(sql, params || [], function (e) {
        if (e) reject(e); else resolve({ lastID: this.lastID, changes: this.changes });
    }));
}

// An error whose message is safe to show to the person who made the request.
class DxUserError extends Error {}

// Weekly limit
// One request per account per DATA_EXPORT_COOLDOWN_DAYS (7).
function dxWindowParam() { return '-' + Math.ceil(DATA_EXPORT_COOLDOWN_MS / 1000) + ' seconds'; }

// created_at of the newest counted request inside the window, or null.
async function dxLastCountedRequest(subject, email) {
    const row = await dxGet(`SELECT MAX(created_at) AS last FROM Data_Export_Requests
        WHERE status != 'failed' AND created_at > datetime('now', ?)
        AND ((subject_type = ? AND subject_id = ?) OR lower(email) = lower(?))`,
        [dxWindowParam(), subject.type, subject.id, email || '']);
    return row && row.last ? row.last : null;
}
function dxNextAllowedAt(lastCreatedAt) {
    if (!lastCreatedAt) return null;
    const t = new Date(dxIso(lastCreatedAt)).getTime();
    return Number.isFinite(t) ? new Date(t + DATA_EXPORT_COOLDOWN_MS) : null;
}

// Total size of the exports folder, so a flood of accounts can't fill the disk even if each one
// stays within its own limit.
function dxExportsDirBytes() {
    let total = 0;
    try {
        for (const name of fs.readdirSync(DATA_EXPORTS_DIR)) {
            try { total += fs.statSync(path.join(DATA_EXPORTS_DIR, name)).size; } catch (e) {}
        }
    } catch (e) {}
    return total;
}

function dxMaskEmail(email) {
    const s = String(email || '');
    const at = s.indexOf('@');
    if (at < 1) return '***';
    return s.slice(0, 1) + '***' + s.slice(at);
}

function dxIso(ts) {
    if (typeof ts === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(ts)) return ts.replace(' ', 'T') + 'Z';
    return ts == null ? null : ts;
}

module.exports = {
    DATA_DIR,
    DATA_EXPORTS_DIR,
    DATA_EXPORT_CATEGORIES,
    DATA_EXPORT_COOKIE,
    DATA_EXPORT_COOLDOWN_DAYS,
    DATA_EXPORT_COOLDOWN_MS,
    DATA_EXPORT_LINK_TTL_MS,
    DATA_EXPORT_MAX_EMAIL_BYTES,
    DATA_EXPORT_MAX_PER_DAY,
    DATA_EXPORT_MAX_SIZE_BYTES,
    DATA_EXPORT_MAX_TOTAL_BYTES,
    DATA_EXPORT_TOKEN_TTL_MS,
    DATA_EXPORT_UNLIMITED,
    DxUserError,
    dxAll,
    dxExportsDirBytes,
    dxGet,
    dxIso,
    dxLastCountedRequest,
    dxMaskEmail,
    dxNextAllowedAt,
    dxRun,
    dxTooLargeError,
    dxWindowParam,
    parseExportCategories,
};
