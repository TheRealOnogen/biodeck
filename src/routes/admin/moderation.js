// Admin ban / warn actions.
const { parseBanDuration, requireAdmin } = require('../../admin/helpers');
const { app } = require('../../app');
const { db } = require('../../db/connection');
const { userBus } = require('../../live/events');
const {
    sendAccountBannedEmail,
    sendAccountUnbannedEmail,
    sendWarningEmail,
    sendWarningRevokedEmail,
} = require('../../mail');
const { getStanding, getWarningsForUser, isWarningActive, logAudit } = require('../../moderation');

app.post('/admin/ban/:username', requireAdmin, (req, res) => {
    const target = req.params.username;
    const reason = (req.body.reason || 'Banned by admin').substring(0, 500);
    if (target === req.session.userUsername) return res.status(400).json({ error: 'cannot ban yourself' });

    // Optional duration field (e.g.
    let expiresAt = null;
    if (req.body.duration && String(req.body.duration).trim()) {
        const ms = parseBanDuration(req.body.duration);
        if (ms === null) return res.status(400).json({ error: 'invalid duration - use e.g. 45s, 30m, 6h, 3d, 2w, 1y' });
        expiresAt = new Date(Date.now() + ms).toISOString();
    }

    db.run(`UPDATE User_Data SET IsBanned = 1, BanReason = ?, BanExpiresAt = ? WHERE username = ?`, [reason, expiresAt, target], function(err) {
        if (err) return res.status(500).json({ error: 'db error' });
        if (this.changes === 0) return res.status(404).json({ error: 'user not found' });
        logAudit('account_banned', req.session.userUsername, target, expiresAt ? `${reason} (until ${expiresAt})` : reason);
        // Push ban event to any open SSE streams for this user, and email them
        db.get(`SELECT id, email FROM User_Data WHERE username = ?`, [target], (err2, row) => {
            if (!err2 && row) {
                userBus.emit(`user:${row.id}`, { event: 'banned', type: 'account', reason, expiresAt });
                if (row.email) sendAccountBannedEmail(row.email, target, reason, expiresAt);
            }
        });
        res.json({ ok: true, banned: true, username: target, expiresAt });
    });
});

app.post('/admin/unban/:username', requireAdmin, (req, res) => {
    const target = req.params.username;
    db.run(`UPDATE User_Data SET IsBanned = 0, BanReason = NULL, BanExpiresAt = NULL WHERE username = ?`, [target], function(err) {
        if (err) return res.status(500).json({ error: 'db error' });
        if (this.changes === 0) return res.status(404).json({ error: 'user not found' });
        logAudit('account_unbanned', req.session.userUsername, target, null);
        db.get(`SELECT email FROM User_Data WHERE username = ?`, [target], (err2, row) => {
            if (!err2 && row && row.email) sendAccountUnbannedEmail(row.email, target);
        });
        res.json({ ok: true, banned: false, username: target });
    });
});

// Issues a warning against an account's standing.
app.post('/admin/warn/:username', requireAdmin, (req, res) => {
    const target = req.params.username;
    const reason = (req.body.reason || '').trim().substring(0, 500);
    if (!reason) return res.status(400).json({ error: 'a reason is required' });
    const muteChat = req.body.mute ? 1 : 0;
    let expiresAt = null;
    if (req.body.duration && String(req.body.duration).trim()) {
        const ms = parseBanDuration(req.body.duration);
        if (ms === null) return res.status(400).json({ error: 'invalid expiration - use e.g. 45s, 30m, 6h, 3d, 2w, 1y, or leave blank to never expire' });
        expiresAt = new Date(Date.now() + ms).toISOString();
    }
    const reportId = parseInt(req.body.reportId, 10);
    // accountAction records what this warning was issued alongside (a ban or an account deletion),
    // if anything.
    const ACCOUNT_ACTIONS = ['temp_ban', 'perm_ban', 'delete'];
    const accountAction = ACCOUNT_ACTIONS.includes(req.body.accountAction) ? req.body.accountAction : null;

    db.get(`SELECT id, email FROM User_Data WHERE username = ?`, [target], (err, user) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!user) return res.status(404).json({ error: 'user not found' });

        function insertWarning(removedContent, removedAttachmentsJson, linkedReportId) {
            db.run(`INSERT INTO Warnings (username, reason, issued_by, expires_at, mute_chat, removed_content, removed_attachments_json, report_id, account_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [target, reason, req.session.userUsername, expiresAt, muteChat, removedContent, removedAttachmentsJson, linkedReportId || null, accountAction], function(err2) {
                    if (err2) return res.status(500).json({ error: 'db error' });
                    logAudit('warning_issued', req.session.userUsername, target, expiresAt ? `${reason} (expires ${expiresAt})` : `${reason} (never expires)`);
                    if (user.email) {
                        sendWarningEmail(user.email, target, reason, expiresAt, {
                            mute_chat: muteChat,
                            removed_content: removedContent,
                            removed_attachments_json: removedAttachmentsJson
                        });
                    }
                    getWarningsForUser(target, (err3, warnings) => {
                        const activeCount = err3 ? null : warnings.filter(isWarningActive).length;
                        res.json({ ok: true, id: this.lastID, username: target, expiresAt, mute: !!muteChat, standing: activeCount === null ? null : getStanding(activeCount) });
                    });
                });
        }

        if (Number.isInteger(reportId)) {
            db.get(`SELECT reported_username, content, attachments_json FROM Reports WHERE id = ?`, [reportId], (errR, report) => {
                // Only attach the snapshot if the report actually matches this target.
                if (!errR && report && report.reported_username === target) {
                    insertWarning(report.content, report.attachments_json, reportId);
                } else {
                    insertWarning(null, null, null);
                }
            });
        } else {
            insertWarning(null, null, null);
        }
    });
});

// Lists every warning (active + expired) for a user, plus their current standing.
app.get('/admin/warnings/:username', requireAdmin, (req, res) => {
    const target = req.params.username;
    getWarningsForUser(target, (err, warnings) => {
        if (err) return res.status(500).json({ error: 'db error' });
        const decorated = warnings.map(w => ({ ...w, active: isWarningActive(w) }));
        const activeCount = decorated.filter(w => w.active).length;
        res.json({ username: target, standing: getStanding(activeCount), warnings: decorated });
    });
});

// Manually expires a warning early (pulls expires_at back to now) instead of deleting it.
app.post('/admin/warnings/:id/revoke', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid warning id' });
    db.get(`SELECT id, username, reason, expires_at FROM Warnings WHERE id = ?`, [id], (err, warning) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!warning) return res.status(404).json({ error: 'warning not found' });
        if (!isWarningActive(warning)) return res.status(400).json({ error: 'warning is already expired' });
        const now = new Date().toISOString();
        db.run(`UPDATE Warnings SET expires_at = ? WHERE id = ?`, [now, id], (err2) => {
            if (err2) return res.status(500).json({ error: 'db error' });
            logAudit('warning_revoked', req.session.userUsername, warning.username, `warning #${id}`);
            db.get(`SELECT email FROM User_Data WHERE username = ?`, [warning.username], (err3, row) => {
                if (!err3 && row && row.email) sendWarningRevokedEmail(row.email, warning.username, warning.reason);
            });
            res.json({ ok: true, id });
        });
    });
});
