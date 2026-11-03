// Dashboard (/edit) and standing pages.
const { app } = require('../app');
const {
    EMOJI_SCRIPT,
    NOTIF_BADGE_SCRIPT,
    REACTION_SCRIPT,
    REPORT_SCRIPT,
    SOUND_SCRIPT,
    USER_EVENTS_SCRIPT,
} = require('../client-scripts');
const { dxCategoryCheckboxesHTML } = require('../data-export/html');
const { db } = require('../db/connection');
const { getStanding, getWarningExtras, getWarningsForUser, isWarningActive } = require('../moderation');
const { escapeHTML, renderAvatarHTML } = require('../render/html');
const { renderMessagePage } = require('../render/pages');
const { renderWarningsSummaryHTML } = require('../render/warnings');
const { loadThemes } = require('../themes');

app.get('/edit', (req, res) => {
    if (!req.session.userId) return res.redirect('/');

    db.get(`SELECT bio, avatar_path, Nickname, email, theme FROM User_Data WHERE id = ?`, [req.session.userId], (err, user) => {
        const bio = (user && user.bio) ? user.bio : '';
        const avatarPath = (user && user.avatar_path) ? user.avatar_path : null;
        const nickname = (user && user.Nickname) ? user.Nickname : '';
        const email = (user && user.email) ? user.email : '';
        const currentTheme = (user && user.theme) ? user.theme : 'default';
        const themeOptionsHTML = loadThemes().map(t =>
            `<option value="${escapeHTML(t.name)}"${t.name === currentTheme ? ' selected' : ''}>${escapeHTML(t.displayName)}</option>`
        ).join('');
        res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dashboard</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
</head>
<body class="page-edit">
    <div class="box dashboard-box">
        <h1>Dashboard</h1>
        <p style="opacity:0.6;">@${req.session.userUsername}</p>
        <div class="dash-field" style="text-align:center;">
        </div>
        <div class="dash-field" style="text-align:center;">
            <label>Profile Picture</label>
            <div style="display:flex;justify-content:center;margin-bottom:10px;">
                ${renderAvatarHTML(avatarPath, req.session.userUsername, 84)}
            </div>
            <form action="/edit/avatar" method="POST" enctype="multipart/form-data" style="display:flex;flex-direction:column;align-items:center;gap:8px;">
                <input type="file" id="avatar-input" name="avatar" accept="image/*" style="display:none;">
                <label for="avatar-input" class="button" style="width:160px;">Choose Image</label>
                <span id="avatar-file-name" style="font-size:0.78em;opacity:0.65;">No file chosen</span>
                <button class="button" type="submit" style="width:160px;">Upload</button>
            </form>
        </div>
        <form action="/edit/nickname" method="POST">
            <div class="dash-field">
                <label>Nickname <span style="opacity:0.4;">(shown instead of your username - spaces allowed. Your @username stays the same and is the only way people can ping you)</span></label>
                <input class="dash-textarea" style="min-height:unset;" type="text" name="nickname" id="nickname-input" placeholder="e.g. Cool Guy" maxlength="32" value="${escapeHTML(nickname)}">
            </div>
            <button class="button" type="submit" style="width: auto;margin-top:8px;">Save Nickname</button>
        </form>
        <form action="/edit/bio" method="POST">
            <div class="dash-field">
                <label>Bio</label>
                <textarea class="dash-textarea" name="bio" id="bio-textarea" placeholder="Tell people about yourself..." maxlength="1000">${bio}</textarea>
            </div>
            <button class="button" type="submit" style="width:120px;margin-top:8px;">Save Bio</button>
        </form>
        <div class="dash-field">
            <label>Email</label>
            <p id="current-email-display" style="margin:0 0 10px;opacity:0.8;">${email ? 'Current: ' + escapeHTML(email) : '<span style="opacity:0.5;">No email on file.</span>'}</p>
            ${email ? `
            <div id="email-change-step1">
                <input class="dash-textarea" style="min-height:unset;" type="text" id="new-email-input" placeholder="New email address" autocomplete="off">
                <button class="button" type="button" onclick="requestEmailCode()" style="width:auto;margin-top:8px;">Send code to current email</button>
            </div>
            <div id="email-change-step2" style="display:none;margin-top:14px;">
                <p style="opacity:0.7;margin:0 0 8px;">We sent a code to <span id="email-code-sent-to"></span>. Enter it below to confirm the change to <span id="email-code-new-addr"></span>.</p>
                <input class="dash-textarea" style="min-height:unset;" type="text" id="email-code-input" placeholder="6-digit code" maxlength="6" autocomplete="off">
                <div style="display:flex;gap:8px;margin-top:8px;">
                    <button class="button" type="button" onclick="confirmEmailChange()" style="width:auto;">Confirm change</button>
                    <button class="button" type="button" onclick="cancelEmailChange()" style="width:auto;">Cancel</button>
                </div>
            </div>
            <div id="email-change-result" style="margin-top:8px;font-size:0.85em;"></div>
            ` : `<button class="button" type="button" onclick="window.location.href='/account/add-email';" style="width:auto;">Add Email</button>`}
        </div>
        <form action="/edit/theme" method="POST">
            <div class="dash-field">
                <label>Theme <span style="opacity:0.4;">(changes how Biodeck looks for you)</span></label>
                <select class="dash-textarea" style="min-height:unset;" name="theme" id="theme-select">
                    ${themeOptionsHTML}
                </select>
            </div>
            <button class="button" type="submit" style="width:auto;margin-top:8px;margin-bottom:8px;">Save Theme</button>
        </form>
        <div class="dash-field" id="data-export-section">
            <label>Your Data <span style="opacity:0.4;">(a copy of what Biodeck has stored about you, sent to you by email)</span></label>
            <div style="margin-top:6px;">${dxCategoryCheckboxesHTML()}</div>
            <p style="opacity:0.6;font-size:0.82em;margin:8px 0 0;">${email ? "It will be emailed to " + escapeHTML(email) + " as a .tar.gz archive." : "Add an email address above first - that's where your data is sent."}</p>
            <button class="button" type="button" id="data-export-btn" onclick="requestDataExport()" style="width:auto;margin-top:8px;"${email ? '' : ' disabled'}>Request My Data</button>
            <div id="data-export-result" style="margin-top:8px;font-size:0.85em;"></div>
            <div id="data-export-history" style="margin-top:8px;font-size:0.8em;opacity:0.75;"></div>
        </div>
        <div class="dash-field" id="client-code-section">
            <label>Terminal / client login <span style="opacity:0.4;">(log into a Biodeck client without a captcha)</span></label>
            <p style="opacity:0.6;font-size:0.82em;margin:6px 0 0;">Generate a one-time code and type it into the client. It works <strong>once</strong>, only for <strong>this account</strong>, and expires in 10 minutes. Making a new code cancels the old one. <strong>Anyone who has the code can log in as you - never share it.</strong></p>
            <button class="button" type="button" id="client-code-btn" onclick="generateClientCode()" style="width:auto;margin-top:8px;">Generate Code</button>
            <div id="client-code-box" style="display:none;margin-top:10px;">
                <div id="client-code-value" style="font-family:monospace;font-size:1.5em;letter-spacing:2px;user-select:all;word-break:break-all;"></div>
                <div id="client-code-timer" style="font-size:0.85em;opacity:0.75;margin-top:4px;"></div>
            </div>
            <div id="client-code-result" style="margin-top:8px;font-size:0.85em;"></div>
        </div>
        <div class="dash-links">
                <button class="button" style="width:120px;" onclick="window.location.href='/standing';">Standing</button>
                <button class="button" style="width:120px;" onclick="window.location.href='/feed';">Feed</button>
                <button class="button" style="width:120px;" onclick="window.location.href='/messages';">Messages</button>
                <button class="button notif-nav-link" style="padding:10px;width: auto;" onclick="window.location.href='/notifications';">Notifications</button>
                <button class="button" style="width:120px;" onclick="window.location.href='/followers';">Followers</button>
                <button class="button" style="width:120px;" onclick="window.location.href='/user/${req.session.userUsername}';">My Profile</button>
                <button class="button" style="width:120px;" onclick="window.location.href='/support';">Support</button>
        </div>
        <hr style="border-color:rgba(255,80,80,0.3);margin:26px 0 14px;">
        <div class="dash-field" style="text-align:center;">
            <h3 style="color:var(--danger-strong-color);margin-bottom:4px;">Danger Zone</h3>
            <p style="opacity:0.6;font-size:0.82em;">Deleting your account is <strong>permanent</strong>. It removes your posts, DMs, group chat messages and memberships, follows, friends, friend requests, and notifications from the live site. There is no way to undo this. A private copy of your data is saved when you delete, so you can still have it emailed to you afterward - or use "Your Data" above to get it first.</p>
            <button class="button" type="button" onclick="openDeleteAccountBox()" style="width:auto;">Delete My Account</button>
            <div id="delete-account-box" style="display:none;margin-top:14px;text-align:left;">
                <label>Enter your password to confirm</label>
                <input class="dash-textarea" style="min-height:unset;" type="password" id="delete-account-password" placeholder="Current password" autocomplete="current-password">
                <div style="display:flex;gap:8px;margin-top:8px;justify-content:center;">
                    <button class="button" type="button" onclick="confirmDeleteAccount()" style="width:auto;">Permanently Delete Everything</button>
                    <button class="button" type="button" onclick="closeDeleteAccountBox()" style="width:auto;">Cancel</button>
                </div>
                <div id="delete-account-result" style="margin-top:8px;font-size:0.85em;text-align:center;"></div>
            </div>
        </div>
    </div>
    <script>
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => { btn.classList.add('clicked'); setTimeout(() => btn.classList.remove('clicked'), 150); });
        });

        document.getElementById('avatar-input').addEventListener('change', function () {
            document.getElementById('avatar-file-name').textContent = this.files.length ? this.files[0].name : 'No file chosen';
        });

        const bioEl = document.getElementById('bio-textarea');
        const bioCounter = document.createElement('div');
        bioCounter.style.cssText = 'font-size:0.75em;opacity:0.5;text-align:right;margin-top:4px;';
        bioCounter.textContent = bioEl.value.length + ' / 1000';
        bioEl.parentNode.insertBefore(bioCounter, bioEl.nextSibling);
        bioEl.addEventListener('input', function () {
            const len = this.value.length;
            bioCounter.textContent = len + ' / 1000';
            bioCounter.style.color = len > 900 ? (len >= 1000 ? 'var(--danger-color)' : 'var(--warning-color)') : '';
            bioCounter.style.opacity = len > 900 ? '1' : '0.5';
        });

        if (new URLSearchParams(window.location.search).get('nicknameerror')) {
            const t = document.createElement('div');
            t.textContent = 'Nickname too long - 32 character limit.';
            t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:var(--text-color);padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 4000);
            window.history.replaceState(null, '', '/edit');
        }

        if (new URLSearchParams(window.location.search).get('bioerror')) {
            const t = document.createElement('div');
            t.textContent = 'Bio too long - 1,000 character limit.';
            t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:var(--text-color);padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 4000);
            window.history.replaceState(null, '', '/edit');
        }

        if (new URLSearchParams(window.location.search).get('themeerror')) {
            const t = document.createElement('div');
            t.textContent = 'That theme is not available.';
            t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:var(--text-color);padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 4000);
            window.history.replaceState(null, '', '/edit');
        }

        let pendingNewEmail = '';

        async function requestEmailCode() {
            const newEmailInput = document.getElementById('new-email-input');
            const resultEl = document.getElementById('email-change-result');
            const newEmail = newEmailInput.value.trim();
            if (!newEmail) { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = 'Enter a new email address.'; return; }
            resultEl.style.color = ''; resultEl.textContent = 'Sending code...';
            try {
                const r = await fetch('/account/email/request-code', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ new_email: newEmail })
                });
                const d = await r.json();
                if (!r.ok) { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = d.error || 'Could not send code.'; return; }
                pendingNewEmail = newEmail;
                document.getElementById('email-code-sent-to').textContent = d.sent_to;
                document.getElementById('email-code-new-addr').textContent = newEmail;
                document.getElementById('email-change-step1').style.display = 'none';
                document.getElementById('email-change-step2').style.display = 'block';
                resultEl.style.color = ''; resultEl.textContent = '';
            } catch (e) { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = 'Network error.'; }
        }

        async function confirmEmailChange() {
            const codeInput = document.getElementById('email-code-input');
            const resultEl = document.getElementById('email-change-result');
            const code = codeInput.value.trim();
            if (!code) { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = 'Enter the code from your email.'; return; }
            resultEl.style.color = ''; resultEl.textContent = 'Confirming...';
            try {
                const r = await fetch('/account/email/confirm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code })
                });
                const d = await r.json();
                if (!r.ok) { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = d.error || 'Could not confirm code.'; return; }
                resultEl.style.color = 'var(--accent-color)'; resultEl.textContent = 'Email updated!';
                document.getElementById('current-email-display').textContent = 'Current: ' + pendingNewEmail;
                document.getElementById('new-email-input').value = '';
                codeInput.value = '';
                document.getElementById('email-change-step2').style.display = 'none';
                document.getElementById('email-change-step1').style.display = 'block';
                setTimeout(() => { resultEl.textContent = ''; }, 3000);
            } catch (e) { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = 'Network error.'; }
        }

        function cancelEmailChange() {
            pendingNewEmail = '';
            document.getElementById('email-code-input').value = '';
            document.getElementById('email-change-step2').style.display = 'none';
            document.getElementById('email-change-step1').style.display = 'block';
            document.getElementById('email-change-result').textContent = '';
        }

        var clientCodeTimer = null;
        async function generateClientCode() {
            var btn = document.getElementById('client-code-btn');
            var box = document.getElementById('client-code-box');
            var val = document.getElementById('client-code-value');
            var timer = document.getElementById('client-code-timer');
            var res = document.getElementById('client-code-result');
            btn.disabled = true; res.style.color = ''; res.textContent = '';
            try {
                var r = await fetch('/account/client-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                var d = await r.json();
                if (!r.ok) { res.style.color = 'var(--danger-light-color)'; res.textContent = d.error || 'Could not create a code.'; btn.disabled = false; return; }
                val.textContent = d.code; box.style.display = 'block';
                btn.textContent = 'Generate New Code';
                var expiresAt = Date.now() + d.expiresInMs;
                clearInterval(clientCodeTimer);
                var tick = function () {
                    var left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
                    if (left <= 0) {
                        clearInterval(clientCodeTimer); box.style.display = 'none'; val.textContent = '';
                        res.textContent = 'That code expired. Generate a new one if you still need it.';
                        return;
                    }
                    timer.textContent = 'Expires in ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
                };
                tick(); clientCodeTimer = setInterval(tick, 1000);
            } catch (e) {
                res.style.color = 'var(--danger-light-color)'; res.textContent = 'Network error.';
            }
            btn.disabled = false;
        }

        var dxHasEmail = ${email ? 'true' : 'false'};
        var dxPollTimer = null;

        function dxSelectedCategories() {
            var c = [];
            document.querySelectorAll('#data-export-section .dx-cat').forEach(function (x) { if (x.checked) c.push(x.value); });
            return c;
        }

        async function requestDataExport() {
            var resultEl = document.getElementById('data-export-result');
            var btn = document.getElementById('data-export-btn');
            var cats = dxSelectedCategories();
            if (!cats.length) { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = 'Choose at least one thing to include.'; return; }
            btn.disabled = true; resultEl.style.color = ''; resultEl.textContent = 'Sending request...';
            try {
                var r = await fetch('/account/data-export', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ categories: cats })
                });
                var d = await r.json();
                if (!r.ok) { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = d.error || 'Could not send the request.'; btn.disabled = !dxHasEmail || r.status === 429; return; }
                resultEl.style.color = 'var(--accent-color)';
                resultEl.textContent = 'Request received - your data will be emailed to ' + d.sentTo + ' shortly.';
                loadDataExportHistory();
            } catch (e) {
                resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = 'Network error.'; btn.disabled = !dxHasEmail;
            }
        }

        async function loadDataExportHistory() {
            var el = document.getElementById('data-export-history');
            var btn = document.getElementById('data-export-btn');
            try {
                var r = await fetch('/account/data-export/requests');
                var d = await r.json();
                if (!r.ok) return;
                el.textContent = '';
                var active = false;
                d.requests.forEach(function (q) {
                    var status = q.status === 'sent' ? (q.delivery === 'link' ? 'emailed (download link)' : 'emailed')
                        : q.status === 'failed' ? ('failed - ' + (q.error || 'unknown error'))
                        : 'being prepared...';
                    var line = document.createElement('div');
                    line.textContent = new Date(q.createdAt).toLocaleString() + ' - ' + q.categories.join(', ') + ' - ' + status;
                    el.appendChild(line);
                    if (q.status === 'pending' || q.status === 'processing') active = true;
                });
                clearTimeout(dxPollTimer);
                var waiting = d.nextRequestAt && new Date(d.nextRequestAt).getTime() > Date.now();
                if (waiting) {
                    var note = document.createElement('div');
                    note.style.marginTop = '6px';
                    note.textContent = 'You can request your data once every ' + d.cooldownDays + ' days. Next request available ' + new Date(d.nextRequestAt).toLocaleString() + '.';
                    el.appendChild(note);
                }
                if (active) { btn.disabled = true; dxPollTimer = setTimeout(loadDataExportHistory, 3000); }
                else btn.disabled = !dxHasEmail || !!waiting;
            } catch (e) {}
        }
        loadDataExportHistory();

        function openDeleteAccountBox() {
            document.getElementById('delete-account-box').style.display = 'block';
        }

        function closeDeleteAccountBox() {
            document.getElementById('delete-account-box').style.display = 'none';
            document.getElementById('delete-account-password').value = '';
            document.getElementById('delete-account-result').textContent = '';
        }

        async function confirmDeleteAccount() {
            const password = document.getElementById('delete-account-password').value;
            const resultEl = document.getElementById('delete-account-result');
            if (!password) { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = 'Enter your password to confirm.'; return; }
            if (!confirm('This will PERMANENTLY delete your account and all of your data. This cannot be undone. Continue?')) return;

            resultEl.style.color = ''; resultEl.textContent = 'Deleting...';
            try {
                let r = await fetch('/account/delete-self', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });
                let d = await r.json();
                if (!r.ok && d && d.code === 'archive_failed') {
                    // No copy of the data could be saved. Offer to delete anyway, but only after two separate confirmations.
                    resultEl.textContent = '';
                    const cancelled = () => { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = 'Your account was NOT deleted.'; };
                    if (!confirm('We could not save a copy of your data, so your account was NOT deleted.\\n\\nDo you want to delete it WITHOUT a saved copy? Your data will be gone for good and you will not be able to have it emailed to you afterwards.\\n\\n(Confirmation 1 of 2)')) return cancelled();
                    if (!confirm('Final confirmation (2 of 2): permanently delete your account with NO saved copy? This cannot be undone.')) return cancelled();
                    resultEl.style.color = ''; resultEl.textContent = 'Deleting...';
                    r = await fetch('/account/delete-self', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ password, skipArchive: true, confirmations: 2 })
                    });
                    d = await r.json();
                }
                if (!r.ok) { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = d.error || 'Could not delete account.'; return; }
                resultEl.style.color = 'var(--accent-color)'; resultEl.textContent = 'Account deleted. Redirecting...';
                setTimeout(() => window.location.href = d.redirect || '/', 1200);
            } catch (e) { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = 'Network error.'; }
        }

        if (new URLSearchParams(window.location.search).get('avatarerror')) {
            const t = document.createElement('div');
            t.textContent = 'Could not upload profile picture - please use an image file under 8MB.';
            t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:var(--text-color);padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 4000);
            window.history.replaceState(null, '', '/edit');
        }
    </script>
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${SOUND_SCRIPT}${EMOJI_SCRIPT}${REPORT_SCRIPT}${REACTION_SCRIPT}

</body>
</html>`);
    });
});

app.get('/standing', (req, res) => {
    if (!req.session.userId) return res.redirect('/');

    db.get(`SELECT avatar_path FROM User_Data WHERE id = ?`, [req.session.userId], (err, user) => {
        const avatarPath = (user && user.avatar_path) ? user.avatar_path : null;
        getWarningsForUser(req.session.userUsername, (errW, warnings) => {
            warnings = warnings || [];
            const activeCount = warnings.filter(isWarningActive).length;
            const standing = getStanding(activeCount);
            const warningsHTML = renderWarningsSummaryHTML(warnings);
            res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Account Standing</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
</head>
<body class="page-edit">
    <div class="box dashboard-box">
        <div style="display:flex;justify-content:center;margin-bottom:10px;">
            ${renderAvatarHTML(avatarPath, req.session.userUsername, 84)}
        </div>
        <h2 style="margin:0 0 14px;">@${escapeHTML(req.session.userUsername)}</h2>
        <div style="margin-bottom:18px;">
            <div style="opacity:0.6;font-size:0.85em;margin-bottom:4px;">Account Standing</div>
            <div style="font-size:1.3em;color:${standing.color};font-weight:700;">${escapeHTML(standing.label)}</div>
            <div style="opacity:0.6;font-size:0.85em;margin-top:2px;">${standing.count} active warning${standing.count === 1 ? '' : 's'}</div>
        </div>
        ${warningsHTML}
        <div class="dash-links">
            <button class="button" style="width:auto;" onclick="window.location.href='/edit';">Back to dashboard</button>
        </div>
    </div>
</body>
</html>`);
        });
    });
});

// Detail page for a single warning, linked from the /standing overview table.
app.get('/standing/:id', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const id = parseInt(req.params.id, 10);
    const notFound = () => res.status(404).send(renderMessagePage('Not Found', 'Warning not found', `<h3>That warning doesn't exist.</h3><br><br><button type="button" class="button" style="width: 180px" onclick="window.location.href='/standing';">Back to standing</button>`));
    if (!Number.isInteger(id)) return notFound();

    db.get(`SELECT id, username, reason, issued_by, created_at, expires_at, mute_chat, removed_content, removed_attachments_json, report_id, account_action FROM Warnings WHERE id = ?`, [id], (err, warning) => {
        if (err) return res.status(500).send('DB error');
        if (!warning || warning.username !== req.session.userUsername) return notFound();

        const active = isWarningActive(warning);
        const statusHtml = active ? '<span style="color:var(--danger-color);font-weight:700;">Active</span>' : '<span style="opacity:0.5;">Expired</span>';
        const affectsParts = getWarningExtras(warning, 'html');
        const affectsHtml = affectsParts.length ? affectsParts.join('') : '<p style="opacity:0.6;">None</p>';

        res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Warning #${warning.id}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
</head>
<body class="page-edit">
    <div class="box dashboard-box" style="text-align:left;">
        <p><a href="/standing" style="color:var(--text-color);opacity:0.6;text-decoration:none;">&lt; Back to standing</a></p>
        <h2 style="margin:10px 0 4px;">Warning #${warning.id}</h2>
        <p style="opacity:0.5;font-size:0.85em;margin-top:-2px;">Issued ${escapeHTML(new Date(warning.created_at.replace(' ','T')+'Z').toLocaleString())}</p>
        <hr style="border-color:rgba(255,255,255,0.15);margin:14px 0;">
        <p style="font-size:0.9em;"><strong>Reason:</strong></p>
        <p style="white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;">${escapeHTML(warning.reason) || '<span style="opacity:0.4;">(no reason given)</span>'}</p>
        <p style="font-size:0.9em;"><strong>Expires:</strong> ${warning.expires_at ? escapeHTML(new Date(warning.expires_at).toLocaleString()) : 'Never'}</p>
        <p style="font-size:0.9em;"><strong>Status:</strong> ${statusHtml}</p>
        <hr style="border-color:rgba(255,255,255,0.15);margin:14px 0;">
        <p style="font-size:0.9em;margin-bottom:6px;"><strong>What this affects:</strong></p>
        ${affectsHtml}
        <div class="dash-links" style="margin-top:16px;">
            <button class="button" style="width:auto;" onclick="window.location.href='/standing';">Back to standing</button>
        </div>
    </div>
</body>
</html>`);
    });
});
