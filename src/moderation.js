// Audit log, warnings, standing and mute checks.
const path = require('path');
const fs = require('fs');
const { APP_BASE_URL } = require('./config');
const { db } = require('./db/connection');
const { ROOT_DIR } = require('./paths');
const { renderAttachmentsHTML } = require('./render/attachments');
const { escapeHTML } = require('./render/html');

// Writes one row to the audit trail. actor is who performed the action ('System' for self-service
// events like registration).
function logAudit(action, actor, target, details) {
    db.run(`INSERT INTO Audit_Log (action, actor, target, details) VALUES (?, ?, ?, ?)`,
        [action, actor || 'System', target || null, details || null],
        (err) => { if (err) console.error('Audit log insert error:', err.message); });
}

// Account-standing thresholds, based on the number of currently-active (non-expired) warnings.
const STANDING_LEVELS = [
    { min: 20, label: 'Severely at risk', color: 'var(--danger-strong-color)' },
    { min: 10, label: 'At risk', color: 'var(--danger-color)' },
    { min: 1, label: 'Be careful', color: 'var(--warning-color, #d9a441)' },
    { min: 0, label: 'All good', color: 'var(--success-color)' }
];
function getStanding(activeWarningCount) {
    const level = STANDING_LEVELS.find(l => activeWarningCount >= l.min);
    return { count: activeWarningCount, label: level.label, color: level.color };
}

// A warning counts toward standing until its expires_at passes.
function isWarningActive(w) {
    if (!w.expires_at) return true;
    return new Date(w.expires_at).getTime() > Date.now();
}

// Fetches every warning for a user.
function getWarningsForUser(username, cb) {
    db.all(`SELECT id, username, reason, issued_by, created_at, expires_at, mute_chat, removed_content, removed_attachments_json, report_id, account_action FROM Warnings WHERE username = ? ORDER BY created_at DESC`, [username], (err, rows) => {
        if (err) return cb(err);
        cb(null, rows || []);
    });
}

// True while a warning that has mute_chat set is still active for this user - blocks DM/group-chat
// sending.
function isUserMuted(username, cb) {
    db.all(`SELECT expires_at FROM Warnings WHERE username = ? AND mute_chat = 1`, [username], (err, rows) => {
        if (err) return cb(err);
        const active = (rows || []).filter(isWarningActive);
        if (!active.length) return cb(null, null);
        const neverExpires = active.some(w => !w.expires_at);
        const expiresAt = neverExpires ? null : active.reduce((latest, w) =>
            (!latest || new Date(w.expires_at) > new Date(latest)) ? w.expires_at : latest, null);
        cb(null, { expiresAt });
    });
}

// Shared "extras" line(s) for a single warning - shown after the reason on the warning email and
// anywhere warnings are listed.
function getWarningExtras(w, format, opts) {
    // format: 'html' or 'text'. opts.activeOnly.
    const activeOnly = !opts || opts.activeOnly !== false;
    const stillActive = isWarningActive(w);
    const attachments = (() => {
        if (!w.removed_attachments_json) return [];
        try { return JSON.parse(w.removed_attachments_json) || []; } catch (e) { return []; }
    })();
    const parts = [];
    if (w.account_action) {
        const label = w.account_action === 'temp_ban' ? 'Your account has been temporarily banned.'
            : w.account_action === 'perm_ban' ? 'Your account has been permanently banned.'
            : w.account_action === 'delete' ? 'Your account has been deleted.'
            : null;
        if (label) {
            parts.push(format === 'html'
                ? `<p style="margin:6px 0;"><strong>${label}</strong></p>`
                : label);
        }
    }
    if (w.mute_chat && (!activeOnly || stillActive)) {
        parts.push(format === 'html'
            ? `<p style="margin:6px 0;"><strong>You're not able to chat or post to the feed until this warning expires${w.expires_at ? ' (' + escapeHTML(new Date(w.expires_at).toLocaleString()) + ')' : ''}.</strong></p>`
            : `You're not able to chat or post to the feed until this warning expires${w.expires_at ? ' (' + new Date(w.expires_at).toLocaleString() + ')' : ''}.`);
    }
    if (w.removed_content !== null && w.removed_content !== undefined) {
        if (format === 'html') {
            let html = `<p style="margin:6px 0 2px;">A piece of content has been removed:</p><p style="white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;opacity:0.85;">${escapeHTML(w.removed_content) || '<span style="opacity:0.5;">(no text)</span>'}</p>`;
            if (attachments.length) html += renderAttachmentsHTML(attachments, 300, '400px');
            parts.push(html);
        } else {
            let text = `A piece of content has been removed:\n${w.removed_content || '(no text)'}`;
            if (attachments.length) {
                text += `\n` + attachments.map(a => `- ${a.name}: ${APP_BASE_URL}/uploads/${path.basename(a.path)}`).join('\n');
            }
            parts.push(text);
        }
    }
    return parts;
}

// Extra usernames to DM on every new registration, on top of the user with id 1.
const ACTIVATION_PING_FILE = path.join(ROOT_DIR, 'activation-pings.txt');
function getActivationPingUsernames() {
    try {
        const raw = fs.readFileSync(ACTIVATION_PING_FILE, 'utf8');
        return raw.split(',').map(u => u.trim()).filter(Boolean);
    } catch (e) {
        return [];
    }
}

module.exports = {
    getActivationPingUsernames,
    getStanding,
    getWarningExtras,
    getWarningsForUser,
    isUserMuted,
    isWarningActive,
    logAudit,
};
