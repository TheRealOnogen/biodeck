// Admin guards and table row builders.
const path = require('path');
const { db } = require('../db/connection');
const { sendBanExpiredEmail } = require('../mail');
const { getStanding, isWarningActive } = require('../moderation');
const { ROOT_DIR } = require('../paths');
const { escapeHTML } = require('../render/html');

function requireAdmin(req, res, next) {
    if (!req.session.userId) return res.redirect('/');
    db.get(`SELECT IsOwner, IsAdmin, IsHeadAdmin FROM User_Data WHERE id = ?`, [req.session.userId], (err, user) => {
        if (err || !user || (!user.IsOwner && !user.IsAdmin && !user.IsHeadAdmin)) {
            return res.status(403).sendFile(path.join(ROOT_DIR, 'admin_access_denied.html'));
        }
        req.isOwner = !!user.IsOwner;
        req.isHeadAdmin = !!(user.IsHeadAdmin || user.IsOwner);
        next();
    });
}

// Stricter gate for routes that only Owners/Head Admins should be able to hit (e.g. toggling
// registration).
function requireHeadAdmin(req, res, next) {
    if (!req.isHeadAdmin) return res.status(403).json({ error: 'Head Admin or Owner only.' });
    next();
}

// Admin dashboard table rendering (shared between the full page render
// and the /admin/tables-partial endpoint used to refresh tables without a full page reload after an
// admin action). -----.
function buildAdminUserRows(users, activeWarningCounts) {
    return (users || []).map(u => {
        const badges = [
            u.IsOwner ? '<span style="color:var(--gold-color);font-weight:700;">Owner</span>' : '',
            u.IsHeadAdmin ? '<span style="color:var(--danger-strong-color);font-weight:700;">Head Admin</span>' : '',
            u.IsAdmin ? '<span style="color:var(--admin-color);font-weight:700;">Admin</span>' : '',
            u.IsDeveloper ? '<span style="color:var(--accent-color);font-weight:700;">Dev</span>' : '',
            u.IsSupporter ? '<span style="color:var(--purple-color);font-weight:700;">Supporter</span>' : '',
            u.IsVerified ? '<span style="color:var(--accent-color, #1d9bf0);font-weight:700;">Verified</span>' : '',
            u.IsDeleted ? '<span style="color:var(--gray-color);font-weight:700;">Deleted</span>' : (u.IsBanned ? '<span style="color:var(--danger-color);font-weight:700;">Banned</span>' : ''),
        ].filter(Boolean).join(' ');
        const ipBtn = u.last_ip
            ? `<button class="button" style="font-size:0.75em;padding:2px 8px;margin-left:6px;" onclick="prefillIPBan('${escapeHTML(u.last_ip)}')">IP Ban</button>`
            : '';
        const nicknameSuffix = (u.Nickname && u.Nickname.trim()) ? ` <span style="opacity:0.5;font-weight:400;">(${escapeHTML(u.Nickname.trim())})</span>` : '';
        const banExpirySuffix = (u.IsBanned && u.BanExpiresAt) ? ` (until ${escapeHTML(new Date(u.BanExpiresAt).toLocaleString())})` : '';
        const statusReason = u.IsDeleted ? escapeHTML(u.DeleteReason || '') : (u.IsBanned ? escapeHTML(u.BanReason || '') + banExpirySuffix : '');
        const standing = getStanding(activeWarningCounts[u.username] || 0);
        const standingBtn = `<button class="button" style="font-size:0.72em;padding:2px 8px;margin-left:6px;" onclick="prefillWarnUsername('${escapeHTML(u.username)}')">Warn</button>`;
        return `<tr>
            <td><a href="/user/${escapeHTML(u.username)}" style="color:var(--text-color);text-decoration:none;">@${escapeHTML(u.username)}</a>${nicknameSuffix}</td>
            <td style="font-size:0.85em; word-break: break-word; overflow-wrap: break-word">${badges || '<span style="opacity:0.4;">-</span>'}</td>
            <td style="font-size:0.8em;opacity:0.6;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; word-break: break-word; overflow-wrap: break-word">${statusReason}</td>
            <td style="font-size:0.85em;white-space:nowrap; word-break: break-word; overflow-wrap: break-word"><span style="color:${standing.color};font-weight:700;">${escapeHTML(standing.label)}</span> <span style="opacity:0.5;">(${standing.count})</span>${standingBtn}</td>
            <td style="font-size:0.78em;opacity:0.5; word-break: break-word; overflow-wrap: break-word">${u.last_ip ? escapeHTML(u.last_ip) : '<span style="opacity:0.3;">-</span>'}${ipBtn}</td>
        </tr>`;
    }).join('');
}

function buildAdminIPBanRows(ipbans) {
    return (ipbans || []).map(b => `<tr>
        <td style="font-family:monospace; word-break: break-word; overflow-wrap: break-word">${escapeHTML(b.ip)}</td>
        <td style="font-size:0.8em;opacity:0.7; word-break: break-word; overflow-wrap: break-word">${escapeHTML(b.reason || '')}</td>
        <td style="font-size:0.78em;opacity:0.5; word-break: break-word; overflow-wrap: break-word">${escapeHTML(b.banned_by || '')}</td>
        <td><button class="button" style="font-size:0.75em;padding:2px 8px;" onclick="unIPBan('${escapeHTML(b.ip)}')">Unban</button></td>
    </tr>`).join('');
}

const ADMIN_AUDIT_ACTION_LABELS = {
    account_created: 'Account Created',
    account_banned: 'Account Banned',
    account_unbanned: 'Account Unbanned',
    account_deleted: 'Account Deleted',
    registration_gate_enabled: 'Registration Gate ON',
    registration_gate_disabled: 'Registration Gate OFF',
    ip_banned: 'IP Banned',
    ip_unbanned: 'IP Unbanned',
    warning_issued: 'Warning Issued',
    warning_revoked: 'Warning Revoked',
    content_reported: 'Content Reported',
    report_resolved: 'Report Resolved',
    report_reopened: 'Report Reopened',
    report_content_deleted: 'Reported Content Deleted'
};
const ADMIN_AUDIT_IP_ACTIONS = new Set(['ip_banned', 'ip_unbanned']);
function buildAdminAuditRows(auditEntries) {
    return (auditEntries || []).map(a => {
        let targetDisplay = '<span style="opacity:0.3;">-</span>';
        if (a.target) {
            targetDisplay = ADMIN_AUDIT_IP_ACTIONS.has(a.action)
                ? `<span style="font-family:monospace;">${escapeHTML(a.target)}</span>`
                : '@' + escapeHTML(a.target);
        }
        return `<tr>
        <td style="font-size:0.78em;opacity:0.5;white-space:nowrap; word-break: break-word; overflow-wrap: break-word">${escapeHTML(a.created_at || '')}</td>
        <td style="font-size:0.85em; word-break: break-word; overflow-wrap: break-word">${escapeHTML(ADMIN_AUDIT_ACTION_LABELS[a.action] || a.action)}</td>
        <td style="font-size:0.85em; word-break: break-word; overflow-wrap: break-word">${escapeHTML(a.actor || '')}</td>
        <td style="font-size:0.85em; word-break: break-word; overflow-wrap: break-word">${targetDisplay}</td>
        <td style="font-size:0.8em;opacity:0.7;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; word-break: break-word; overflow-wrap: break-word">${escapeHTML(a.details || '')}</td>
    </tr>`;
    }).join('');
}

function getActiveWarningCounts(allWarnings) {
    const activeWarningCounts = {};
    (allWarnings || []).forEach(w => {
        if (isWarningActive(w)) activeWarningCounts[w.username] = (activeWarningCounts[w.username] || 0) + 1;
    });
    return activeWarningCounts;
}

// Parses a ban duration like "30m", "6h", "3d", "2w", or a bare number (treated as minutes).
function parseBanDuration(str) {
    const s = String(str).trim().toLowerCase();
    if (!s) return null;
    const match = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w|y)?$/);
    if (!match) return null;
    const amount = parseFloat(match[1]);
    if (!isFinite(amount) || amount <= 0) return null;
    const unitMs = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        w: 7 * 24 * 60 * 60 * 1000,
        y: 365 * 24 * 60 * 60 * 1000
    };
    const unit = match[2] || 'm';
    return Math.round(amount * unitMs[unit]);
}

// Clears an expired timed ban and emails the user that access has been restored.
function clearExpiredBan(userId) {
    db.run(`UPDATE User_Data SET IsBanned = 0, BanReason = NULL, BanExpiresAt = NULL WHERE id = ?`, [userId], (err) => {
        if (err) return;
        db.get(`SELECT username, email FROM User_Data WHERE id = ?`, [userId], (err2, row) => {
            if (!err2 && row && row.email) sendBanExpiredEmail(row.email, row.username);
        });
    });
}

module.exports = {
    buildAdminAuditRows,
    buildAdminIPBanRows,
    buildAdminUserRows,
    clearExpiredBan,
    getActiveWarningCounts,
    parseBanDuration,
    requireAdmin,
    requireHeadAdmin,
};
