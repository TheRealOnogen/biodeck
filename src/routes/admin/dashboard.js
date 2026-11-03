// Admin dashboard page.
const {
    buildAdminAuditRows,
    buildAdminIPBanRows,
    buildAdminUserRows,
    getActiveWarningCounts,
    requireAdmin,
} = require('../../admin/helpers');
const { app } = require('../../app');
const { db } = require('../../db/connection');
const { escapeHTML } = require('../../render/html');
const {
    LOCKDOWN_DURATION_MS,
    LOCKDOWN_REG_MAX,
    LOCKDOWN_REG_WINDOW_MS,
    getRegistrationLockdownLeftMs,
    isRegistrationLockdownIndefinite,
} = require('../../site-state');
const { formatDuration } = require('../../util');
const siteState = require('../../site-state');

// Returns just the refreshed table bodies.
app.get('/admin/tables-partial', requireAdmin, (req, res) => {
    db.all(`SELECT username, Nickname, IsBanned, BanReason, BanExpiresAt, IsDeleted, DeleteReason, IsOwner, IsAdmin, IsHeadAdmin, IsDeveloper, IsSupporter, IsVerified, last_ip FROM User_Data ORDER BY username ASC`, [], (err, users) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        db.all(`SELECT username, expires_at FROM Warnings`, [], (errW, allWarnings) => {
            const userRows = buildAdminUserRows(users, getActiveWarningCounts(allWarnings));
            db.all(`SELECT ip, reason, banned_by, created_at FROM IP_Bans ORDER BY created_at DESC`, [], (err2, ipbans) => {
                const ipBanRows = buildAdminIPBanRows(ipbans);
                db.all(`SELECT action, actor, target, details, created_at FROM Audit_Log ORDER BY id DESC LIMIT 150`, [], (err3, auditEntries) => {
                    const auditRows = buildAdminAuditRows(auditEntries);
                    res.json({ userRows, ipBanRows, auditRows });
                });
            });
        });
    });
});

app.get('/admin/dashboard', requireAdmin, (req, res) => {
    db.all(`SELECT username, Nickname, IsBanned, BanReason, BanExpiresAt, IsDeleted, DeleteReason, IsOwner, IsAdmin, IsHeadAdmin, IsDeveloper, IsSupporter, IsVerified, last_ip FROM User_Data ORDER BY username ASC`, [], (err, users) => {
        if (err) return res.status(500).send('DB error');
        db.all(`SELECT username, expires_at FROM Warnings`, [], (errW, allWarnings) => {
        const activeWarningCounts = getActiveWarningCounts(allWarnings);
        const userRows = buildAdminUserRows(users, activeWarningCounts);

        db.all(`SELECT ip, reason, banned_by, created_at FROM IP_Bans ORDER BY created_at DESC`, [], (err2, ipbans) => {
            const ipBanRows = buildAdminIPBanRows(ipbans);

        db.all(`SELECT action, actor, target, details, created_at FROM Audit_Log ORDER BY id DESC LIMIT 150`, [], (err3, auditEntries) => {
            const auditRows = buildAdminAuditRows(auditEntries);

        res.send(`<!DOCTYPE html>
<html lang="en" class="page-admin">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Admin Dashboard</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
<style>
    /* Force wide tables (like All Users) to scroll horizontally inside their
       own panel instead of overflowing past it, regardless of anything
       theme.css sets on .panel/table. */
    .table-scroll-wrap {
        display: block !important;
        width: 100% !important;
        max-width: 100% !important;
        overflow-x: auto !important;
        -webkit-overflow-scrolling: touch;
    }
    .table-scroll-wrap > table {
        width: max-content !important;
        min-width: 100% !important;
    }
</style>
</head>
<body class="page-admin">
<div id="topbar">
    <strong>Admin Dashboard</strong>
    <div id="topbar-right" style="position:relative;display:flex;align-items:center;">
        <a href="/feed">Feed</a>
        <a href="/admin/reports">Reports</a>
        <a href="/admin/support">Support Tickets</a>
        <a href="/edit">Dashboard</a>
        <a href="/logout">Logout</a>
        <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
        <nav id="nav-dropdown">
            <a href="/feed">Feed</a>
            <a href="/admin/reports">Reports</a>
            <a href="/admin/support">Support Tickets</a>
            <a href="/edit">Dashboard</a>
            <a href="/logout">Logout</a>
        </nav>
    </div>
</div>
<div id="content">
    <h1>Admin Dashboard</h1>
    <p style="opacity:0.5;margin-top:4px;">Logged in as <strong>${escapeHTML(req.session.userUsername)}</strong></p>

    <div class="panel" style="border-color:rgba(255,255,255,0.2);">
        <h2>Registration Gate</h2>
        <p style="opacity:0.5;font-size:0.8em;margin-top:-6px;">When <strong>ON</strong>, new signups are created banned pending activation and admins get pinged (Activations group chat + DM) to manually activate them. When <strong>OFF</strong>, registration is fully open - new accounts are created active immediately, with no pings.</p>
        <p style="margin-top:10px;">Status: <span id="reg-gate-status">${siteState.registrationGateEnabled ? '<span style="color:var(--success-color);font-weight:700;">ON</span>' : '<span style="color:var(--danger-color);font-weight:700;">OFF</span>'}</span></p>
        ${req.isHeadAdmin ? `
        <div class="action-row">
            <button class="button" onclick="toggleRegistrationGate(true)" style="width:100px;">Turn ON</button>
            <button class="button" onclick="toggleRegistrationGate(false)" style="width:100px;">Turn OFF</button>
        </div>
        <div id="reg-gate-result"></div>` : `<p style="opacity:0.4;font-size:0.78em;margin-top:10px;">Only Owners and Head Admins can change this setting.</p>`}
    </div>

    <div class="panel" style="border-color:rgba(255,255,255,0.2);">
        <h2>Registration Lockdown</h2>
        <p style="opacity:0.5;font-size:0.8em;margin-top:-6px;">Starts automatically when ${LOCKDOWN_REG_MAX} accounts are created within ${LOCKDOWN_REG_WINDOW_MS / 1000} seconds. While active, <strong>nobody</strong> can register (even with the gate OFF) for ${LOCKDOWN_DURATION_MS / 3600000} hours (automatic start) or until it is ended here. A manual start has no time limit unless you enter hours.</p>
        <p style="margin-top:10px;">Status: <span id="reg-lockdown-status">${getRegistrationLockdownLeftMs() > 0 ? '<span style="color:var(--danger-color);font-weight:700;">ACTIVE</span> - ' + (isRegistrationLockdownIndefinite() ? 'until you end it' : 'ends in about ' + escapeHTML(formatDuration(getRegistrationLockdownLeftMs()))) : '<span style="color:var(--success-color);font-weight:700;">Not active</span>'}</span></p>
        ${req.isHeadAdmin ? `
        <div class="action-row">
            <input id="reg-lockdown-hours" type="number" min="1" max="720" step="any" placeholder="Hours (empty = no limit)" style="width:190px;">
            <button class="button" onclick="toggleRegistrationLockdown(true)" style="width:140px;">Start lockdown</button>
            <button class="button" onclick="toggleRegistrationLockdown(false)" style="width:140px;">End lockdown</button>
        </div>
        <div id="reg-lockdown-result"></div>` : `<p style="opacity:0.4;font-size:0.78em;margin-top:10px;">Only Owners and Head Admins can change this setting.</p>`}
    </div>

    <div class="panel" style="border-color:rgba(255,255,255,0.2);">
        <h2>Full Lockdown</h2>
        <p style="opacity:0.5;font-size:0.8em;margin-top:-6px;">When <strong>ON</strong>, nobody can register <strong>or log in</strong> (including via the emailed verification link). People who are already logged in are not affected, and Admin / Head Admin / Owner accounts can still log in so this can be turned off. It stays on until it is ended here.</p>
        <p style="margin-top:10px;">Status: <span id="full-lockdown-status">${siteState.fullLockdownEnabled ? '<span style="color:var(--danger-color);font-weight:700;">ON</span>' : '<span style="color:var(--success-color);font-weight:700;">OFF</span>'}</span></p>
        ${req.isHeadAdmin ? `
        <div class="action-row">
            <button class="button" onclick="toggleFullLockdown(true)" style="width:140px;">Turn ON</button>
            <button class="button" onclick="toggleFullLockdown(false)" style="width:140px;">Turn OFF</button>
        </div>
        <div id="full-lockdown-result"></div>` : `<p style="opacity:0.4;font-size:0.78em;margin-top:10px;">Only Owners and Head Admins can change this setting.</p>`}
    </div>

    <div class="panel" style="border-color:rgba(255,255,255,0.2);">
        <h2>Read-only Mode</h2>
        <p style="opacity:0.5;font-size:0.8em;margin-top:-6px;">When <strong>ON</strong>, nobody can register or export their data, and regular accounts can log in and read but can't post, send, edit, delete or change anything (a banner is shown on every page and text fields are removed). Admin / Head Admin / Owner accounts can still chat and use the admin tools. It stays on until it is ended here.</p>
        <p style="margin-top:10px;">Status: <span id="read-only-status">${siteState.readOnlyModeEnabled ? '<span style="color:var(--danger-color);font-weight:700;">ON</span>' : '<span style="color:var(--success-color);font-weight:700;">OFF</span>'}</span></p>
        ${req.isHeadAdmin ? `
        <div class="action-row">
            <button class="button" onclick="toggleReadOnlyMode(true)" style="width:140px;">Turn ON</button>
            <button class="button" onclick="toggleReadOnlyMode(false)" style="width:140px;">Turn OFF</button>
        </div>
        <div id="read-only-result"></div>` : `<p style="opacity:0.4;font-size:0.78em;margin-top:10px;">Only Owners and Head Admins can change this setting.</p>`}
    </div>

    <div class="panel">
        <h2>Ban / Unban User</h2>
        <label>Username</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="target-username" placeholder="e.g. testuser" autocomplete="off">
        <label>Reason <span style="opacity:0.4;">(required for ban, ignored for unban)</span></label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="ban-reason" placeholder="e.g. Spamming" maxlength="500">
        <label>Duration <span style="opacity:0.4;">(optional, ignored for unban - blank = permanent)</span></label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="ban-duration" placeholder="e.g. 45s, 30m, 6h, 3d, 2w, 1y" maxlength="20">
        <label>Action</label>
        <select id="action">
            <option value="ban">Ban</option>
            <option value="unban">Unban</option>
        </select>
        <div class="action-row">
            <button class="button" id="submit-btn" onclick="submitAction()" style="width:140px;">Apply</button>
        </div>
        <div id="result"></div>
    </div>

    <div class="panel" style="border-color:rgba(255,255,255,0.2);">
        <h2 style="color:var(--text-dim-color);">IP Ban / Unban</h2>
        <label>IP Address</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="target-ip" placeholder="e.g. 192.168.1.1" autocomplete="off">
        <label>Reason <span style="opacity:0.4;">(required for ban, ignored for unban)</span></label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="ip-ban-reason" placeholder="e.g. Ban evasion" maxlength="500">
        <label>Action</label>
        <select id="ip-action">
            <option value="ipban">IP Ban</option>
            <option value="unipban">IP Unban</option>
        </select>
        <div class="action-row">
            <button class="button" onclick="submitIPAction()" style="width:140px;">Apply</button>
        </div>
        <div id="ip-result"></div>
    </div>

    <div class="panel" style="rgba(255,255,255,0.2);">
        <h2 style="color:var(--text-dim-color);">Banned IPs</h2>
        <table>
            <thead><tr><th>IP Address</th><th>Reason</th><th>Banned By</th><th></th></tr></thead>
            <tbody id="ip-ban-table">
                ${ipBanRows || '<tr><td colspan="4" style="opacity:0.4; word-break: break-word; overflow-wrap: break-word">No IP bans.</td></tr>'}
            </tbody>
        </table>
    </div>

    <div class="panel" style="border-color:rgba(255,255,255,0.2;">
        <h2 style="color:var(--text-dim-color);">Delete Account</h2>
        <p style="opacity:0.5;font-size:0.8em;margin-top:-6px;">Does not remove the account from the database. Resets the avatar to the default, sets the display name to "Account Deleted", clears the bio, marks the account as deleted, and deletes all of its posts. The username is kept.</p>
        <label>Username</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="delete-username" placeholder="e.g. testuser" autocomplete="off">
        <label>Reason <span style="opacity:0.4;">(required)</span></label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="delete-reason" placeholder="e.g. ToS violation" maxlength="500">
        <div class="action-row">
            <button class="button" onclick="submitDeleteAccount()" style="width:160px;">Delete Account</button>
        </div>
        <div id="delete-result"></div>
        ${req.isHeadAdmin ? `
        <hr style="border-color:rgba(255,80,80,0.3);margin:18px 0;">
        <h3 style="color:var(--danger-strong-color);margin-bottom:4px;">Delete From Database</h3>
        <p style="opacity:0.6;font-size:0.8em;margin-top:-2px;">Permanently erases the account and everything tied to it - posts, DMs, group chat messages/memberships, follows, friends, friend requests, and notifications. This cannot be undone and the username becomes available again. Head Admin / Owner only.</p>
        <label>Username</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="hard-delete-username" placeholder="e.g. testuser" autocomplete="off">
        <label>Reason <span style="opacity:0.4;">(required)</span></label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="hard-delete-reason" placeholder="e.g. GDPR erasure request" maxlength="500">
        <div class="action-row">
            <button class="button" onclick="submitHardDeleteAccount()" style="width:200px;">Delete From Database</button>
        </div>
        <div id="hard-delete-result"></div>
        ` : ''}
    </div>

    <div class="panel">
        <h2>Edit User Profile</h2>
        <p style="opacity:0.5;font-size:0.8em;margin-top:-6px;">View and fix up anyone's avatar, nickname, or bio - useful for removing an inappropriate pfp or bio without deleting the account.</p>
        <label>Username</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="profile-username" placeholder="e.g. testuser" autocomplete="off">
        <div class="action-row">
            <button class="button" onclick="loadProfile()" style="width:140px;">Load</button>
        </div>
        <div id="profile-avatar-preview" style="margin:10px 0;display:flex;align-items:center;gap:12px;"></div>
        <label>Nickname</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="profile-nickname" placeholder="(none)" maxlength="32">
        <label>Bio</label>
        <textarea id="profile-bio" maxlength="1000" style="width:100%;min-height:80px;border-radius:12px;padding:8px;box-sizing:border-box;"></textarea>
        <div class="action-row">
            <button class="button" onclick="saveProfileText()" style="width:140px;">Save Text</button>
        </div>
        <label style="margin-top:14px;">Email</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="profile-email" placeholder="(none)" autocomplete="off">
        <div class="action-row">
            <button class="button" onclick="saveProfileEmail()" style="width:140px;">Save Email</button>
        </div>
        <label style="margin-top:14px;">Replace Avatar</label>
        <input type="file" id="profile-avatar-file" accept="image/*">
        <div class="action-row">
            <button class="button" onclick="uploadProfileAvatar()" style="width:160px;">Upload Avatar</button>
            <button class="button" onclick="resetProfileAvatar()" style="width:160px;">Reset to Default</button>
        </div>
        <div id="profile-result"></div>
    </div>

    <div class="panel">
        <h2>Manage Badges</h2>
        <label>Username</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="badge-username" placeholder="e.g. testuser" autocomplete="off">
        <label style="margin-top:14px;">Badges</label>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:6px;">
            ${req.isOwner ? `<label style="display:flex;align-items:center;gap:6px;margin:0;text-transform:none;font-size:0.95em;opacity:1;"><input type="checkbox" id="badge-headadmin" style="width:auto;"> Head Admin</label>` : ''}
            ${req.isHeadAdmin ? `<label style="display:flex;align-items:center;gap:6px;margin:0;text-transform:none;font-size:0.95em;opacity:1;"><input type="checkbox" id="badge-admin" style="width:auto;"> Admin</label>` : ''}
            <label style="display:flex;align-items:center;gap:6px;margin:0;text-transform:none;font-size:0.95em;opacity:1;"><input type="checkbox" id="badge-supporter" style="width:auto;"> Supporter</label>
            <label style="display:flex;align-items:center;gap:6px;margin:0;text-transform:none;font-size:0.95em;opacity:1;"><input type="checkbox" id="badge-developer" style="width:auto;"> Developer</label>
            <label style="display:flex;align-items:center;gap:6px;margin:0;text-transform:none;font-size:0.95em;opacity:1;"><input type="checkbox" id="badge-verified" style="width:auto;"> Verified</label>
            ${req.isOwner ? `<label style="display:flex;align-items:center;gap:6px;margin:0;text-transform:none;font-size:0.95em;opacity:1;"><input type="checkbox" id="badge-owner" style="width:auto;"> Owner</label>` : ''}
        </div>
        ${!req.isOwner ? `<p style="opacity:0.4;font-size:0.78em;margin-top:6px;">Only Owners and Head Admins can grant or revoke the Admin badge.</p>` : ''}
        <p style="opacity:0.4;font-size:0.8em;margin-top:8px;">Load a user's current badges first, tick/untick what you want, then save.</p>
        <div class="action-row">
            <button class="button" onclick="loadBadges()" style="width:140px;">Load</button>
            <button class="button" onclick="saveBadges()" style="width:140px;">Save</button>
        </div>
        <div id="badge-result"></div>
    </div>

    <div class="panel">
        <h2>Issue Warning</h2>
        <p style="opacity:0.5;font-size:0.8em;margin-top:-6px;">Warnings affect account standing: <strong>0</strong> = All good, <strong>1-9</strong> = Be careful, <strong>10-19</strong> = At risk, <strong>20+</strong> = Severely at risk. Once a warning expires it stops counting toward standing but stays in the user's warnings list. Leave the expiration blank to have it never expire.</p>
        <label>Username</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="warn-username" placeholder="e.g. testuser" autocomplete="off">
        <label>Reason <span style="opacity:0.4;">(required)</span></label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="warn-reason" placeholder="e.g. Harassment in DMs" maxlength="500">
        <label>Expires In <span style="opacity:0.4;">(optional, e.g. 45s, 30m, 6h, 3d, 2w, 1y - blank = never expires)</span></label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="warn-duration" placeholder="e.g. 2w" maxlength="20">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:0.85em;opacity:0.85;margin-top:8px;">
            <input type="checkbox" id="warn-mute" style="width:auto;height:auto;">
            Mute user (blocks DMs, group chat, and feed posts/replies) until this warning expires
        </label>
        <div class="action-row">
            <button class="button" id="warn-submit-btn" onclick="submitWarn()" style="width:140px;">Issue Warning</button>
        </div>
        <div id="warn-result"></div>
    </div>

    <div class="panel">
        <h2>View / Manage Warnings</h2>
        <label>Username</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="warnings-lookup-username" placeholder="e.g. testuser" autocomplete="off">
        <div class="action-row">
            <button class="button" onclick="loadWarnings()" style="width:140px;">Load</button>
        </div>
        <div id="warnings-standing" style="margin:10px 0;"></div>
        <div class="table-scroll-wrap">
        <table>
            <thead><tr><th>Reason</th><th>Issued By</th><th>Issued</th><th>Expires</th><th>Status</th><th></th></tr></thead>
            <tbody id="warnings-table">
                <tr><td colspan="6" style="opacity:0.4;">Load a user to see their warnings.</td></tr>
            </tbody>
        </table>
        </div>
    </div>

    <div class="panel">
        <h2>All Users</h2>
        <div class="table-scroll-wrap">
        <table>
            <thead><tr><th>Username</th><th>Badges</th><th>Ban Reason</th><th>Standing</th><th>Last IP</th></tr></thead>
            <tbody id="user-table">
                ${userRows || '<tr><td colspan="5" style="opacity:0.4; word-break: break-word; overflow-wrap: break-word">No users found.</td></tr>'}
            </tbody>
        </table>
        </div>
    </div>

    <div class="panel">
        <h2>Audit Log</h2>
        <p style="opacity:0.5;font-size:0.8em;margin-top:-6px;">Most recent 150 events - account creations, bans/unbans, deletions, and registration gate changes.</p>
        <div class="table-scroll-wrap">
        <table>
            <thead><tr><th>Time</th><th>Action</th><th>Actor</th><th>Target</th><th>Details</th></tr></thead>
            <tbody id="audit-table">
                ${auditRows || '<tr><td colspan="5" style="opacity:0.4; word-break: break-word; overflow-wrap: break-word">No audit events yet.</td></tr>'}
            </tbody>
        </table>
        </div>
    </div>
</div>

<script>
    // Event delegation so buttons injected later (e.g. after refreshAdminTables()
    // repopulates a table) still get the click animation without re-binding.
    document.addEventListener('mousedown', (e) => {
        const btn = e.target.closest('.button');
        if (btn) { btn.classList.add('clicked'); setTimeout(() => btn.classList.remove('clicked'), 150); }
    });

    // Refreshes the Users, Banned IPs, and Audit Log tables in place by
    // fetching just their rows - avoids a full page reload (and re-running
    // every query on the page) after a ban/unban/warn/delete/etc.
    async function refreshAdminTables() {
        try {
            const r = await fetch('/admin/tables-partial');
            if (!r.ok) return;
            const d = await r.json();
            const userTable = document.getElementById('user-table');
            const ipBanTable = document.getElementById('ip-ban-table');
            const auditTable = document.getElementById('audit-table');
            if (userTable) userTable.innerHTML = d.userRows || '<tr><td colspan="5" style="opacity:0.4;">No users found.</td></tr>';
            if (ipBanTable) ipBanTable.innerHTML = d.ipBanRows || '<tr><td colspan="4" style="opacity:0.4;">No IP bans.</td></tr>';
            if (auditTable) auditTable.innerHTML = d.auditRows || '<tr><td colspan="5" style="opacity:0.4;">No audit events yet.</td></tr>';
        } catch (e) { /* leave existing tables as-is on network error */ }
    }

    async function toggleRegistrationGate(enable) {
        const result = document.getElementById('reg-gate-result');
        result.className = ''; result.textContent = 'Updating...';
        try {
            const r = await fetch('/admin/registration-gate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: enable })
            });
            const d = await r.json();
            if (!r.ok) { result.className = 'err'; result.textContent = d.error || 'Error.'; return; }
            document.getElementById('reg-gate-status').innerHTML = d.enabled
                ? '<span style="color:var(--success-color);font-weight:700;">ON</span>'
                : '<span style="color:var(--danger-color);font-weight:700;">OFF</span>';
            result.className = 'ok'; result.textContent = 'Saved.';
            setTimeout(() => { result.textContent = ''; }, 1500);
        } catch (e) { result.className = 'err'; result.textContent = 'Network error.'; }
    }

    async function toggleFullLockdown(enable) {
        if (enable && !confirm('Turn ON full lockdown? Nobody except staff will be able to log in or register until you turn it off. People already logged in are not affected.')) return;
        const result = document.getElementById('full-lockdown-result');
        result.className = ''; result.textContent = 'Updating...';
        try {
            const r = await fetch('/admin/full-lockdown', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: enable })
            });
            const d = await r.json();
            if (!r.ok) { result.className = 'err'; result.textContent = d.error || 'Error.'; return; }
            document.getElementById('full-lockdown-status').innerHTML = d.enabled
                ? '<span style="color:var(--danger-color);font-weight:700;">ON</span>'
                : '<span style="color:var(--success-color);font-weight:700;">OFF</span>';
            result.className = 'ok'; result.textContent = 'Saved.';
            setTimeout(() => { result.textContent = ''; }, 1500);
        } catch (e) { result.className = 'err'; result.textContent = 'Network error.'; }
    }

    async function toggleReadOnlyMode(enable) {
        if (enable && !confirm('Turn ON read-only mode? Regular accounts will be able to log in and read, but nothing else. Nobody can register or export data. Staff can still chat.')) return;
        const result = document.getElementById('read-only-result');
        result.className = ''; result.textContent = 'Updating...';
        try {
            const r = await fetch('/admin/read-only-mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: enable })
            });
            const d = await r.json();
            if (!r.ok) { result.className = 'err'; result.textContent = d.error || 'Error.'; return; }
            document.getElementById('read-only-status').innerHTML = d.enabled
                ? '<span style=\"color:var(--danger-color);font-weight:700;\">ON</span>'
                : '<span style=\"color:var(--success-color);font-weight:700;\">OFF</span>';
            result.className = 'ok'; result.textContent = 'Saved. Reload to see the banner.';
        } catch (e) { result.className = 'err'; result.textContent = 'Network error.'; }
    }

    async function toggleRegistrationLockdown(active) {
        const result = document.getElementById('reg-lockdown-result');
        result.className = ''; result.textContent = 'Updating...';
        try {
            const r = await fetch('/admin/registration-lockdown', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active: active, hours: document.getElementById('reg-lockdown-hours').value })
            });
            const d = await r.json();
            if (!r.ok) { result.className = 'err'; result.textContent = d.error || 'Error.'; return; }
            document.getElementById('reg-lockdown-status').innerHTML = d.active
                ? '<span style="color:var(--danger-color);font-weight:700;">ACTIVE</span> - ' + (d.indefinite ? 'until you end it' : 'ends in about ' + Math.ceil(d.leftMs / 60000) + ' minutes')
                : '<span style="color:var(--success-color);font-weight:700;">Not active</span>';
            result.className = 'ok'; result.textContent = 'Saved.';
            setTimeout(() => { result.textContent = ''; }, 1500);
        } catch (e) { result.className = 'err'; result.textContent = 'Network error.'; }
    }

    function renderProfileAvatarPreview(avatarUrl, username) {
        const el = document.getElementById('profile-avatar-preview');
        if (avatarUrl) {
            el.innerHTML = '<img src="' + avatarUrl + '" alt="avatar" style="width:56px;height:56px;border-radius:50%;object-fit:cover;border:1px solid rgba(255,255,255,0.2);">' +
                '<span style="opacity:0.5;font-size:0.8em;">Current avatar for @' + username + '</span>';
        } else {
            el.innerHTML = '<span style="opacity:0.4;font-size:0.8em;">No avatar set.</span>';
        }
    }

    async function loadProfile() {
        const username = document.getElementById('profile-username').value.trim();
        const resultEl = document.getElementById('profile-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        resultEl.className = ''; resultEl.textContent = 'Loading...';
        try {
            const res = await fetch('/admin/profile/' + encodeURIComponent(username));
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            document.getElementById('profile-nickname').value = data.Nickname || '';
            document.getElementById('profile-bio').value = data.bio || '';
            document.getElementById('profile-email').value = data.email || '';
            renderProfileAvatarPreview(data.avatar_url, data.username);
            resultEl.className = 'ok'; resultEl.textContent = 'Loaded profile for @' + username + '.';
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }

    async function saveProfileText() {
        const username = document.getElementById('profile-username').value.trim();
        const resultEl = document.getElementById('profile-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        const nickname = document.getElementById('profile-nickname').value.trim();
        const bio = document.getElementById('profile-bio').value;
        resultEl.className = ''; resultEl.textContent = 'Saving...';
        try {
            const res = await fetch('/admin/profile/' + encodeURIComponent(username) + '/text', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nickname, bio })
            });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            resultEl.className = 'ok'; resultEl.textContent = 'Profile text updated for @' + username + '.';
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }

    async function saveProfileEmail() {
        const username = document.getElementById('profile-username').value.trim();
        const resultEl = document.getElementById('profile-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        const email = document.getElementById('profile-email').value.trim();
        resultEl.className = ''; resultEl.textContent = 'Saving...';
        try {
            const res = await fetch('/admin/profile/' + encodeURIComponent(username) + '/email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            resultEl.className = 'ok'; resultEl.textContent = 'Email updated for @' + username + '.';
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }

    async function uploadProfileAvatar() {
        const username = document.getElementById('profile-username').value.trim();
        const resultEl = document.getElementById('profile-result');
        const fileInput = document.getElementById('profile-avatar-file');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        if (!fileInput.files[0]) { resultEl.className = 'err'; resultEl.textContent = 'Choose an image file first.'; return; }
        const formData = new FormData();
        formData.append('avatar', fileInput.files[0]);
        resultEl.className = ''; resultEl.textContent = 'Uploading...';
        try {
            const res = await fetch('/admin/profile/' + encodeURIComponent(username) + '/avatar', { method: 'POST', body: formData });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            renderProfileAvatarPreview(data.avatar_url, username);
            fileInput.value = '';
            resultEl.className = 'ok'; resultEl.textContent = 'Avatar updated for @' + username + '.';
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }

    async function resetProfileAvatar() {
        const username = document.getElementById('profile-username').value.trim();
        const resultEl = document.getElementById('profile-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        if (!confirm('Reset @' + username + '\\'s avatar to the default image?')) return;
        resultEl.className = ''; resultEl.textContent = 'Resetting...';
        try {
            const res = await fetch('/admin/profile/' + encodeURIComponent(username) + '/reset-avatar', { method: 'POST' });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            renderProfileAvatarPreview(data.avatar_url, username);
            resultEl.className = 'ok'; resultEl.textContent = 'Avatar reset for @' + username + '.';
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }

    async function loadBadges() {
        const username = document.getElementById('badge-username').value.trim();
        const resultEl = document.getElementById('badge-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        resultEl.className = ''; resultEl.textContent = 'Loading...';
        try {
            const res = await fetch('/admin/badges/' + encodeURIComponent(username));
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            document.getElementById('badge-admin') && (document.getElementById('badge-admin').checked = !!data.IsAdmin);
            document.getElementById('badge-headadmin') && (document.getElementById('badge-headadmin').checked = !!data.IsHeadAdmin);
            document.getElementById('badge-supporter').checked = !!data.IsSupporter;
            document.getElementById('badge-developer').checked = !!data.IsDeveloper;
            document.getElementById('badge-verified').checked = !!data.IsVerified;
            const ownerBox = document.getElementById('badge-owner');
            if (ownerBox) ownerBox.checked = !!data.IsOwner;
            resultEl.className = 'ok'; resultEl.textContent = 'Loaded badges for @' + username + '.';
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }

    async function saveBadges() {
        const username = document.getElementById('badge-username').value.trim();
        const resultEl = document.getElementById('badge-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        const ownerBox = document.getElementById('badge-owner');
        const adminBox = document.getElementById('badge-admin');
        const headadminBox = document.getElementById('badge-headadmin');
        const body = {
            IsSupporter: document.getElementById('badge-supporter').checked,
            IsDeveloper: document.getElementById('badge-developer').checked,
            IsVerified: document.getElementById('badge-verified').checked
        };
        if (adminBox) body.IsAdmin = adminBox.checked;
        if (ownerBox) body.IsHeadAdmin = headadminBox.checked;
        if (ownerBox) body.IsOwner = ownerBox.checked;
        resultEl.className = ''; resultEl.textContent = 'Saving...';
        try {
            const res = await fetch('/admin/badges/' + encodeURIComponent(username), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            resultEl.className = 'ok'; resultEl.textContent = 'Badges updated for @' + username + '.';
            setTimeout(() => refreshAdminTables(), 1000);
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }


    async function submitAction() {
        const username = document.getElementById('target-username').value.trim();
        const reason = document.getElementById('ban-reason').value.trim();
        const duration = document.getElementById('ban-duration').value.trim();
        const action = document.getElementById('action').value;
        const resultEl = document.getElementById('result');

        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Username is required.'; return; }
        if (action === 'ban' && !reason) { resultEl.className = 'err'; resultEl.textContent = 'A reason is required to ban.'; return; }

        resultEl.className = ''; resultEl.textContent = 'Working…';

        try {
            const res = await fetch('/admin/' + action + '/' + encodeURIComponent(username), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: action === 'ban' ? JSON.stringify({ reason, duration }) : '{}'
            });
            const data = await res.json();
            if (!res.ok) {
                resultEl.className = 'err';
                resultEl.textContent = 'Error: ' + (data.error || res.status);
            } else {
                resultEl.className = 'ok';
                resultEl.textContent = action === 'ban'
                    ? '@' + username + ' has been banned' + (data.expiresAt ? ' until ' + new Date(data.expiresAt).toLocaleString() : ' permanently') + '.'
                    : '@' + username + ' has been unbanned.';
                document.getElementById('target-username').value = '';
                document.getElementById('ban-reason').value = '';
                document.getElementById('ban-duration').value = '';
                setTimeout(() => refreshAdminTables(), 1200);
            }
        } catch (e) {
            resultEl.className = 'err';
            resultEl.textContent = 'Network error.';
        }
    }

    // Used by both delete buttons below. If the server could not save an archive of the account it
    // refuses (code archive_failed); we then ask twice and resend with skipArchive.
    async function postDeleteWithArchiveFallback(url, payload, username) {
        let res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        let data = await res.json();
        if (!res.ok && data && data.code === 'archive_failed') {
            if (!confirm('A copy of the data for @' + username + ' could NOT be saved, so the account was NOT deleted.\\n\\nDelete it WITHOUT an archive? The data will be gone for good and can never be emailed to the user.\\n\\n(Confirmation 1 of 2)')) return { res, data };
            if (!confirm('Final confirmation (2 of 2): delete @' + username + ' with NO archive? This cannot be undone.')) return { res, data };
            res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, payload, { skipArchive: true, confirmations: 2 })) });
            data = await res.json();
        }
        return { res, data };
    }

    async function submitDeleteAccount() {
        const username = document.getElementById('delete-username').value.trim();
        const reason = document.getElementById('delete-reason').value.trim();
        const resultEl = document.getElementById('delete-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Username is required.'; return; }
        if (!reason) { resultEl.className = 'err'; resultEl.textContent = 'A reason is required to delete an account.'; return; }
        if (!confirm('This will reset @' + username + '\\'s avatar, name, and bio, mark the account as deleted, and delete all of its posts. The account stays in the database and the username is kept. Continue?')) return;

        resultEl.className = ''; resultEl.textContent = 'Working…';
        try {
            const { res, data } = await postDeleteWithArchiveFallback('/admin/delete-account/' + encodeURIComponent(username), { reason }, username);
            if (!res.ok) {
                resultEl.className = 'err';
                resultEl.textContent = 'Error: ' + (data.error || res.status);
            } else {
                resultEl.className = 'ok';
                resultEl.textContent = '@' + username + ' has been deleted.';
                document.getElementById('delete-username').value = '';
                document.getElementById('delete-reason').value = '';
                setTimeout(() => refreshAdminTables(), 1200);
            }
        } catch (e) {
            resultEl.className = 'err';
            resultEl.textContent = 'Network error.';
        }
    }

    async function submitHardDeleteAccount() {
        const username = document.getElementById('hard-delete-username').value.trim();
        const reason = document.getElementById('hard-delete-reason').value.trim();
        const resultEl = document.getElementById('hard-delete-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Username is required.'; return; }
        if (!reason) { resultEl.className = 'err'; resultEl.textContent = 'A reason is required to delete an account.'; return; }
        if (!confirm('This PERMANENTLY deletes @' + username + ' and everything tied to it (posts, DMs, group chat messages/memberships, follows, friends, friend requests, notifications) from the database. This CANNOT be undone. Continue?')) return;
        if (!confirm('Are you absolutely sure? Press OK to permanently erase @' + username + '.')) return;

        resultEl.className = ''; resultEl.textContent = 'Working…';
        try {
            const { res, data } = await postDeleteWithArchiveFallback('/admin/delete-account-permanent/' + encodeURIComponent(username), { reason }, username);
            if (!res.ok) {
                resultEl.className = 'err';
                resultEl.textContent = 'Error: ' + (data.error || res.status);
            } else {
                resultEl.className = 'ok';
                resultEl.textContent = '@' + username + ' has been permanently deleted from the database.';
                document.getElementById('hard-delete-username').value = '';
                document.getElementById('hard-delete-reason').value = '';
                setTimeout(() => refreshAdminTables(), 1200);
            }
        } catch (e) {
            resultEl.className = 'err';
            resultEl.textContent = 'Network error.';
        }
    }

    async function submitIPAction() {
        const ip = document.getElementById('target-ip').value.trim();
        const reason = document.getElementById('ip-ban-reason').value.trim();
        const action = document.getElementById('ip-action').value;
        const resultEl = document.getElementById('ip-result');

        if (!ip) { resultEl.className = 'err'; resultEl.textContent = 'IP address is required.'; return; }
        if (action === 'ipban' && !reason) { resultEl.className = 'err'; resultEl.textContent = 'A reason is required to IP ban.'; return; }

        resultEl.className = ''; resultEl.textContent = 'Working…';

        try {
            const endpoint = action === 'ipban' ? '/admin/ipban' : '/admin/unipban';
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ip, reason })
            });
            const data = await res.json();
            if (!res.ok) {
                resultEl.className = 'err';
                resultEl.textContent = 'Error: ' + (data.error || res.status);
            } else {
                resultEl.className = 'ok';
                resultEl.textContent = action === 'ipban'
                    ? ip + ' has been IP banned.'
                    : ip + ' has been IP unbanned.';
                document.getElementById('target-ip').value = '';
                document.getElementById('ip-ban-reason').value = '';
                setTimeout(() => refreshAdminTables(), 1200);
            }
        } catch (e) {
            resultEl.className = 'err';
            resultEl.textContent = 'Network error.';
        }
    }

    function escClient(str) {
        const d = document.createElement('div');
        d.textContent = str == null ? '' : String(str);
        return d.innerHTML;
    }

    async function submitWarn() {
        const username = document.getElementById('warn-username').value.trim();
        const reason = document.getElementById('warn-reason').value.trim();
        const duration = document.getElementById('warn-duration').value.trim();
        const mute = document.getElementById('warn-mute').checked;
        const resultEl = document.getElementById('warn-result');

        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Username is required.'; return; }
        if (!reason) { resultEl.className = 'err'; resultEl.textContent = 'A reason is required.'; return; }

        resultEl.className = ''; resultEl.textContent = 'Working…';
        try {
            const res = await fetch('/admin/warn/' + encodeURIComponent(username), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason, duration, mute })
            });
            const data = await res.json();
            if (!res.ok) {
                resultEl.className = 'err';
                resultEl.textContent = 'Error: ' + (data.error || res.status);
            } else {
                resultEl.className = 'ok';
                resultEl.textContent = '@' + username + ' has been warned (' + (data.expiresAt ? 'expires ' + new Date(data.expiresAt).toLocaleString() : 'never expires') + (data.mute ? ', chat muted' : '') + ').';
                document.getElementById('warn-username').value = '';
                document.getElementById('warn-reason').value = '';
                document.getElementById('warn-duration').value = '';
                document.getElementById('warn-mute').checked = false;
                setTimeout(() => refreshAdminTables(), 1200);
            }
        } catch (e) {
            resultEl.className = 'err';
            resultEl.textContent = 'Network error.';
        }
    }

    function prefillWarnUsername(username) {
        document.getElementById('warn-username').value = username;
        document.getElementById('warn-username').focus();
        document.getElementById('warn-username').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function renderStandingLine(standing) {
        return '<strong>' + standing.label + '</strong> <span style="opacity:0.6;">(' + standing.count + ' active warning' + (standing.count === 1 ? '' : 's') + ')</span>';
    }

    async function loadWarnings() {
        const username = document.getElementById('warnings-lookup-username').value.trim();
        const standingEl = document.getElementById('warnings-standing');
        const tableEl = document.getElementById('warnings-table');
        if (!username) { standingEl.className = 'err'; standingEl.textContent = 'Enter a username.'; return; }
        standingEl.className = ''; standingEl.textContent = 'Loading...';
        tableEl.innerHTML = '<tr><td colspan="6" style="opacity:0.4;">Loading...</td></tr>';
        try {
            const res = await fetch('/admin/warnings/' + encodeURIComponent(username));
            const data = await res.json();
            if (!res.ok) { standingEl.className = 'err'; standingEl.textContent = 'Error: ' + (data.error || res.status); tableEl.innerHTML = '<tr><td colspan="6" style="opacity:0.4;">-</td></tr>'; return; }
            standingEl.className = '';
            standingEl.innerHTML = '@' + escClient(username) + ' standing: ' + renderStandingLine(data.standing);
            if (!data.warnings.length) {
                tableEl.innerHTML = '<tr><td colspan="6" style="opacity:0.4;">No warnings on record.</td></tr>';
                return;
            }
            tableEl.innerHTML = data.warnings.map(w => {
                const statusHtml = w.active ? '<span style="color:var(--danger-color);font-weight:700;">Active</span>' : '<span style="opacity:0.5;">Expired</span>';
                const revokeBtn = w.active ? '<button class="button" style="font-size:0.72em;padding:2px 8px;" onclick="revokeWarning(' + w.id + ')">Revoke</button>' : '';
                let extras = '';
                if (w.account_action) {
                    const actionLabel = w.account_action === 'temp_ban' ? 'Your account has been temporarily banned.'
                        : w.account_action === 'perm_ban' ? 'Your account has been permanently banned.'
                        : w.account_action === 'delete' ? 'Your account has been deleted.'
                        : null;
                    if (actionLabel) extras += '<div style="opacity:0.7;margin-top:4px;"><strong>' + actionLabel + '</strong></div>';
                }
                if (w.mute_chat && w.active) extras += '<div style="opacity:0.7;margin-top:4px;">🔇 Muted (chat + feed) until this warning expires</div>';
                if (w.removed_content !== null && w.removed_content !== undefined) {
                    extras += '<div style="opacity:0.7;margin-top:4px;">Removed content' + (w.report_id ? ' (report #' + w.report_id + ')' : '') + ': <span style="white-space:pre-wrap;word-break:break-word;">' + (escClient(w.removed_content) || '<span style="opacity:0.5;">(no text)</span>') + '</span></div>';
                }
                return '<tr>' +
                    '<td style="font-size:0.85em; word-break: break-word; overflow-wrap: break-word">' + escClient(w.reason) + extras + '</td>' +
                    '<td style="font-size:0.85em;">' + escClient(w.issued_by) + '</td>' +
                    '<td style="font-size:0.78em;opacity:0.6;white-space:nowrap;">' + new Date(w.created_at.replace(' ','T')+'Z').toLocaleString() + '</td>' +
                    '<td style="font-size:0.78em;opacity:0.6;white-space:nowrap;">' + (w.expires_at ? new Date(w.expires_at).toLocaleString() : 'Never') + '</td>' +
                    '<td>' + statusHtml + '</td>' +
                    '<td>' + revokeBtn + '</td>' +
                '</tr>';
            }).join('');
        } catch (e) {
            standingEl.className = 'err'; standingEl.textContent = 'Network error.';
        }
    }

    async function revokeWarning(id) {
        if (!confirm('Revoke this warning early? It will stop counting toward standing but stay listed.')) return;
        try {
            const res = await fetch('/admin/warnings/' + id + '/revoke', { method: 'POST' });
            const data = await res.json();
            if (!res.ok) { alert('Error: ' + (data.error || res.status)); return; }
            loadWarnings();
        } catch (e) {
            alert('Network error.');
        }
    }

    function prefillIPBan(ip) {
        document.getElementById('target-ip').value = ip;
        document.getElementById('ip-action').value = 'ipban';
        document.getElementById('target-ip').focus();
        document.getElementById('target-ip').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    async function unIPBan(ip) {
        const resultEl = document.getElementById('ip-result');
        resultEl.className = ''; resultEl.textContent = 'Working…';
        try {
            const res = await fetch('/admin/unipban', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ip })
            });
            const data = await res.json();
            if (!res.ok) {
                resultEl.className = 'err';
                resultEl.textContent = 'Error: ' + (data.error || res.status);
            } else {
                resultEl.className = 'ok';
                resultEl.textContent = ip + ' has been IP unbanned.';
                setTimeout(() => refreshAdminTables(), 1200);
            }
        } catch (e) {
            resultEl.className = 'err';
            resultEl.textContent = 'Network error.';
        }
    }

    document.getElementById('target-username').addEventListener('keydown', e => { if (e.key === 'Enter') submitAction(); });
    document.getElementById('ban-reason').addEventListener('keydown', e => { if (e.key === 'Enter') submitAction(); });
    document.getElementById('target-ip').addEventListener('keydown', e => { if (e.key === 'Enter') submitIPAction(); });
    document.getElementById('ip-ban-reason').addEventListener('keydown', e => { if (e.key === 'Enter') submitIPAction(); });

    function toggleNav() {
        const dropdown = document.getElementById('nav-dropdown');
        const btn = document.getElementById('nav-hamburger');
        dropdown.classList.toggle('open');
        btn.textContent = dropdown.classList.contains('open') ? '✕' : '☰';
    }
    document.addEventListener('click', function(e) {
        const dropdown = document.getElementById('nav-dropdown');
        const btn = document.getElementById('nav-hamburger');
        if (dropdown && btn && !dropdown.contains(e.target) && e.target !== btn) {
            dropdown.classList.remove('open');
            btn.textContent = '☰';
        }
    });
</script>

</body>
</html>`);
        });
        });
    });
    });
});
