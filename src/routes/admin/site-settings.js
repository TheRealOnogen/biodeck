// Admin site switches and post timeouts.
const { requireAdmin, requireHeadAdmin } = require('../../admin/helpers');
const { app } = require('../../app');
const { db } = require('../../db/connection');
const { logAudit } = require('../../moderation');
const { postAttemptLog } = require('../../security/post-spam');
const {
    LOCKDOWN_INDEFINITE,
    isRegistrationLockdownIndefinite,
    getRegistrationLockdownLeftMs,
    setFullLockdown,
    setReadOnlyMode,
    setRegistrationGateEnabled,
    setRegistrationLockdown,
} = require('../../site-state');
const siteState = require('../../site-state');

// Registration gate: ON = new signups are created banned pending manual activation and admins get
// pinged.
app.get('/admin/registration-gate', requireAdmin, (req, res) => {
    res.json({ enabled: siteState.registrationGateEnabled });
});

app.post('/admin/registration-gate', requireAdmin, requireHeadAdmin, (req, res) => {
    const enabled = !!req.body.enabled;
    setRegistrationGateEnabled(enabled, (err) => {
        if (err) return res.status(500).json({ error: 'db error' });
        logAudit(enabled ? 'registration_gate_enabled' : 'registration_gate_disabled', req.session.userUsername, null, null);
        res.json({ ok: true, enabled: siteState.registrationGateEnabled });
    });
});

// Registration lockdown: starts by itself when LOCKDOWN_REG_MAX accounts are created inside
// LOCKDOWN_REG_WINDOW_MS.
app.get('/admin/registration-lockdown', requireAdmin, (req, res) => {
    const leftMs = getRegistrationLockdownLeftMs();
    const indefinite = leftMs > 0 && isRegistrationLockdownIndefinite();
    res.json({ active: leftMs > 0, indefinite, until: leftMs > 0 && !indefinite ? new Date(siteState.registrationLockdownUntil).toISOString() : null, leftMs });
});

app.post('/admin/registration-lockdown', requireAdmin, requireHeadAdmin, (req, res) => {
    const active = !!(req.body && req.body.active);
    // Optional "hours": without it a manual lockdown stays on until it is ended.
    const hours = parseFloat(req.body && req.body.hours);
    const timed = Number.isFinite(hours) && hours > 0;
    const hoursClamped = Math.min(hours, 24 * 30);
    setRegistrationLockdown(active ? (timed ? Date.now() + hoursClamped * 3600000 : LOCKDOWN_INDEFINITE) : 0);
    logAudit(active ? 'registration_lockdown_started' : 'registration_lockdown_ended', req.session.userUsername, null,
        active ? (timed ? `manual, ${hoursClamped}h` : 'manual, no time limit') : 'ended manually');
    const leftMs = getRegistrationLockdownLeftMs();
    res.json({ ok: true, active: leftMs > 0, indefinite: leftMs > 0 && isRegistrationLockdownIndefinite(), leftMs });
});

// Full lockdown (register + login off, existing sessions unaffected, staff can still log in).
app.get('/admin/full-lockdown', requireAdmin, (req, res) => {
    res.json({ enabled: siteState.fullLockdownEnabled });
});

app.post('/admin/full-lockdown', requireAdmin, requireHeadAdmin, (req, res) => {
    const enabled = !!(req.body && req.body.enabled);
    setFullLockdown(enabled);
    logAudit(enabled ? 'full_lockdown_enabled' : 'full_lockdown_disabled', req.session.userUsername, null, null);
    res.json({ ok: true, enabled: siteState.fullLockdownEnabled });
});

// Read-only mode (see "Read-only mode" near isStaffUser).
app.get('/admin/read-only-mode', requireAdmin, (req, res) => {
    res.json({ enabled: siteState.readOnlyModeEnabled });
});

app.post('/admin/read-only-mode', requireAdmin, requireHeadAdmin, (req, res) => {
    const enabled = !!(req.body && req.body.enabled);
    setReadOnlyMode(enabled);
    logAudit(enabled ? 'read_only_mode_enabled' : 'read_only_mode_disabled', req.session.userUsername, null, null);
    res.json({ ok: true, enabled: siteState.readOnlyModeEnabled });
});

// Posting timeouts handed out by the post-flood guard.
app.get('/admin/post-timeouts', requireAdmin, (req, res) => {
    db.all(`SELECT username, expires_ts, reason FROM Post_Timeouts WHERE expires_ts > ? ORDER BY expires_ts DESC`, [Date.now()], (err, rows) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({ timeouts: (rows || []).map(r => ({ username: r.username, expiresAt: new Date(r.expires_ts).toISOString(), reason: r.reason })) });
    });
});

// Lifts a timeout early (false positive).
app.post('/admin/post-timeout/clear/:username', requireAdmin, (req, res) => {
    const target = req.params.username;
    db.get(`SELECT id FROM User_Data WHERE username = ?`, [target], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'User not found.' });
        postAttemptLog.delete(user.id);
        db.run(`DELETE FROM Post_Timeouts WHERE user_id = ?`, [user.id], function (err2) {
            if (err2) return res.status(500).json({ error: 'db error' });
            if (this.changes > 0) logAudit('post_timeout_cleared', req.session.userUsername, target, null);
            res.json({ ok: true, cleared: this.changes > 0 });
        });
    });
});
