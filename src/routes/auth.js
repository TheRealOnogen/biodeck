// Register, login, logout, email verification and password reset.
const path = require('path');
const bcrypt = require('bcrypt');
const fs = require('fs');
const { createAccount } = require('../accounts/create');
const { clearExpiredBan } = require('../admin/helpers');
const { app } = require('../app');
const { APP_BASE_URL } = require('../config');
const { dxRequestBlockForUserSync } = require('../data-export/html');
const { db } = require('../db/connection');
const {
    EMAIL_REGEX,
    EMAIL_VERIFY_RESEND_COOLDOWN_MS,
    RESET_TOKEN_TTL_MS,
    generateResetToken,
    hashEmailVerifyToken,
    hashResetToken,
    issueEmailVerification,
    sendPasswordResetEmail,
} = require('../mail');
const { checkIPBan } = require('../middleware/ban');
const { getWarningsForUser, logAudit } = require('../moderation');
const { ROOT_DIR } = require('../paths');
const { escapeHTML, renderAvatarBlockHTML } = require('../render/html');
const { renderMessagePage } = require('../render/pages');
const { renderStandingBlockHTML, renderWarningsTableHTML } = require('../render/warnings');
const { SPAM_REG_BAN_REASON } = require('../security/account-spam');
const { CAPTCHA_ENABLED, TURNSTILE_SITE_KEY, requireCaptcha } = require('../security/captcha');
const {
    recordUnverifiedEmailChange,
    tooManyUnverifiedEmailChanges,
    validateEmailForUse,
} = require('../security/email-validation');
const { getClientIP, recordLoginIP } = require('../security/ip');
const { authLimiter } = require('../security/rate-limit');
const { issueFormToken, registrationBotGuard, sendRegistrationBotRefusal } = require('../security/signup');
const { isStaffUser, registrationLockdownGuard, renderFullLockdownPage } = require('../site-state');
const siteState = require('../site-state');

app.get('/register', registrationLockdownGuard, (req, res) => {
    if (req.session.userId) return res.redirect('/feed');
    fs.readFile(path.join(ROOT_DIR, 'register.html'), 'utf8', (err, html) => {
        if (err) return res.status(500).end();
        // Fresh signed token on every page load (see "Signup form tokens").
        const field = `<input type="hidden" name="_ft" value="${issueFormToken(req)}">`;
        res.set('Cache-Control', 'no-store');
        res.type('html').send(html.replace('</form>', field + '\n</form>'));
    });
})

app.get('/', (req, res) => {
    if (req.session.userId) return res.redirect('/feed');
    if (!siteState.fullLockdownEnabled) return res.sendFile(path.join(ROOT_DIR, 'login.html'));
    // Full lockdown: keep the form (staff still need it) but say what's going on.
    fs.readFile(path.join(ROOT_DIR, 'login.html'), 'utf8', (err, html) => {
        if (err) return res.sendFile(path.join(ROOT_DIR, 'login.html'));
        const banner = '<div style="position:fixed;top:0;left:0;right:0;z-index:9999;background:rgb(200,60,60);color:#fff;text-align:center;padding:10px 14px;font-size:0.9em;">Logins and registrations are temporarily paused. If you are already signed in you are not affected.</div>';
        res.send(html.replace('<body>', '<body>\n' + banner));
    });
});

// Served as a script so the pages stay static HTML: it drops the widget into <div
// id="captcha-slot"> inside the form.
app.get('/captcha.js', (req, res) => {
    res.type('application/javascript; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(`(function () {
    var siteKey = ${JSON.stringify(CAPTCHA_ENABLED ? TURNSTILE_SITE_KEY : '')};
    if (!siteKey) return;
    var slot = document.getElementById('captcha-slot');
    if (!slot) return;
    var form = slot.closest('form');
    if (form) form.addEventListener('submit', function (e) {
        var field = form.querySelector('[name="cf-turnstile-response"]');
        if (!field || !field.value) { e.preventDefault(); alert('Please complete the captcha first.'); }
    });
    window.__biodeckCaptchaLoaded = function () {
        window.turnstile.render(slot, { sitekey: siteKey, theme: 'auto' });
    };
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__biodeckCaptchaLoaded';
    s.async = true; s.defer = true;
    document.head.appendChild(s);
})();
`);
});

app.post('/register', authLimiter, registrationLockdownGuard, registrationBotGuard, requireCaptcha, async (req, res) => {
    const { username, password } = req.body;
    const email = (req.body.email || '').trim().toLowerCase();

    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        return res.sendFile(path.join(ROOT_DIR, 'register_error_missing_fields.html'));
    }
    if (username.length < 3 || username.length > 32) {
        return res.sendFile(path.join(ROOT_DIR, 'register_error_invalid_length.html'));
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
        return res.sendFile(path.join(ROOT_DIR, 'register_error_invalid_chars.html'));
    }
    if (!email) {
        return res.status(400).send(renderMessagePage('Missing Email', 'An email address is required',
            `<h3>Every account needs an email so you can reset your password later.</h3><br><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/register';">Go back</button>`));
    }
    if (!EMAIL_REGEX.test(email)) {
        return res.status(400).send(renderMessagePage('Invalid Email', 'That doesn\'t look like a valid email',
            `<h3>Please double check the email address and try again.</h3><br><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/register';">Go back</button>`));
    }
    try {
        const result = await createAccount(req, { username, password, email, formNonce: req._formNonce });
        if (!result.ok) {
            if (result.code === 'signup_refused') {
                const r = result.refusal;
                return res.status(r.status).send(renderMessagePage(r.title, r.heading,
                    `<h3>${escapeHTML(r.message)}</h3><br><br>
                    <button type="button" class="button" style="width: 150px" onclick="window.location.href='/register';">Go back</button>`));
            }
            if (result.code === 'bad_form_token') return sendRegistrationBotRefusal(res);
            if (result.code === 'lockdown') return res.status(503).send(result.page);
            if (result.code === 'spam_banned') {
                if (result.banErr) {
                    return res.status(403).send(renderMessagePage('Registration blocked', 'Too many accounts',
                        `<h3>${escapeHTML(SPAM_REG_BAN_REASON)}</h3>`));
                }
                // Reuse the normal IP-ban page now that the ban is in place.
                return checkIPBan(req, res, () => res.status(403).end());
            }
            return res.sendFile(path.join(ROOT_DIR, 'register_error_username_taken.html'));
        }
        if (result.banned) {
            const reason = result.banReason || 'No reason provided';
            return res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Banned</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
</head>
<body>
    <div class="box" style="color: var(--text-color); height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box;">
        <h1>The ban hammer has struck you</h1><br>
        <h3>Ban Reason: ${escapeHTML(reason)}</h3><br><br>
        <button type="submit" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>
    </div>
    <script>
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => {
                btn.classList.add('clicked');
                setTimeout(() => btn.classList.remove('clicked'), 150);
            });
        });
    </script>

</body>
</html>`);
        }
        // New accounts start with email_verified = 0.
        req.session.pendingVerifyUserId = result.userId;
        req.session.pendingVerifyUsername = result.username;
        return res.redirect('/account/verify-email-required');
    } catch (err) {
        console.error("Register error:", err);
        return res.status(500).sendFile(path.join(ROOT_DIR, 'register_error_internal.html'));
    }
});

// A password hash that's never assigned to a real account.
const DUMMY_BCRYPT_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8p/K.hM7X1Gj1AqNU9CIsCzZbwjIYq';

app.post('/login', authLimiter, requireCaptcha, (req, res) => {
    const { username, password } = req.body;

    db.get(`SELECT * FROM User_Data WHERE username = ?`, [username], async (err, user) => {
        if (err) {
            console.error("Database Login Error:", err.message);
            return res.status(500).sendFile(path.join(ROOT_DIR, 'login_error_internal.html'));
        }

        if (!user) {
            await bcrypt.compare(password || '', DUMMY_BCRYPT_HASH);
            return res.status(401).sendFile(path.join(ROOT_DIR, 'login_error_invalid_credentials.html'));
        }

        try {
            const match = await bcrypt.compare(password, user.password);
            if (match) {
                if (user.IsDeleted) {
                    const reason = user.DeleteReason || 'No reason provided';
                    const deletedWarnings = await new Promise((resolve) => getWarningsForUser(user.username, (e, w) => resolve(w || [])));
                    const deletedWarningsHTML = renderWarningsTableHTML(deletedWarnings);
                    return res.status(401).send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Account Deleted</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
<style>
    html, body {
        height: auto !important;
        min-height: 100% !important;
        overflow-y: auto !important;
    }
    body {
        margin: 0 !important;
        display: flex !important;
        align-items: flex-start !important;
        justify-content: center !important;
    }
</style>
</head>
<body>
    <div class="box" style="color: var(--text-color); height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box; margin: 40px auto; overflow-y: visible;">
        ${renderAvatarBlockHTML(user.avatar_path, user.username)}
        <h1>Your account has been deleted</h1><br>
        <h3>Reason: ${escapeHTML(reason)}</h3><br><br>
        ${renderStandingBlockHTML('Deleted')}
        ${deletedWarningsHTML}${dxRequestBlockForUserSync(user.id, 'deleted')}<br>
        <button type="submit" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>
    </div>
    <script>
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => {
                btn.classList.add('clicked');
                setTimeout(() => btn.classList.remove('clicked'), 150);
            });
        });
    </script>

</body>
</html>`);
                }
                if (user.IsBanned && user.BanExpiresAt && new Date(user.BanExpiresAt).getTime() <= Date.now()) {
                    // Timed ban has expired - clear it (and email the user) and let the login proceed.
                    clearExpiredBan(user.id);
                    user.IsBanned = 0;
                }
                if (user.IsBanned) {
                    const reason = user.BanReason || 'No reason provided';
                    const expiryLine = user.BanExpiresAt
                        ? `<h3>Ban Expires: ${escapeHTML(new Date(user.BanExpiresAt).toLocaleString())}</h3><br><br>`
                        : '';
                    const bannedWarnings = await new Promise((resolve) => getWarningsForUser(user.username, (e, w) => resolve(w || [])));
                    const bannedWarningsHTML = renderWarningsTableHTML(bannedWarnings);
                    return res.status(401).send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Banned</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
<style>
    html, body {
        height: auto !important;
        min-height: 100% !important;
        overflow-y: auto !important;
    }
    body {
        margin: 0 !important;
        display: flex !important;
        align-items: flex-start !important;
        justify-content: center !important;
    }
</style>
</head>
<body>
    <div class="box" style="color: var(--text-color); height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box; margin: 40px auto; overflow-y: visible;">
        ${renderAvatarBlockHTML(user.avatar_path, user.username)}
        <h1>The ban hammer has struck you</h1><br>
        <h3>Ban Reason: ${escapeHTML(reason)}</h3><br><br>
        ${expiryLine}
        ${renderStandingBlockHTML('Banned')}
        ${bannedWarningsHTML}${dxRequestBlockForUserSync(user.id, 'banned')}<br>
        <button type="submit" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>
    </div>
    <script>
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => {
                btn.classList.add('clicked');
                setTimeout(() => btn.classList.remove('clicked'), 150);
            });
        });
    </script>

</body>
</html>`);
                }
                // Full lockdown: only staff may log in.
                if (siteState.fullLockdownEnabled && !isStaffUser(user)) {
                    return res.status(503).send(renderFullLockdownPage());
                }
                if (!user.email) {
                    // Older accounts predate the email requirement.
                    req.session.pendingEmailUserId = user.id;
                    req.session.pendingEmailUsername = user.username;
                    return res.redirect('/account/add-email');
                }
                if (!user.email_verified) {
                    // Email present but not confirmed yet.
                    req.session.pendingVerifyUserId = user.id;
                    req.session.pendingVerifyUsername = user.username;
                    return res.redirect('/account/verify-email-required');
                }
                // Regenerate the session here so a pre-existing.
                req.session.regenerate((regenErr) => {
                    if (regenErr) {
                        console.error('Session regenerate error:', regenErr.message);
                        return res.status(500).sendFile(path.join(ROOT_DIR, 'login_error_auth_exception.html'));
                    }
                    req.session.userId = user.id;
                    req.session.userUsername = user.username;
                    const loginIP = getClientIP(req);
                    recordLoginIP(user.id, user.username, loginIP, 'login');
                    return res.redirect('/feed');
                });
            } else {
                return res.status(401).sendFile(path.join(ROOT_DIR, 'login_error_invalid_credentials.html'));
            }
        } catch (error) {
            console.error(error);
            return res.status(500).sendFile(path.join(ROOT_DIR, 'login_error_auth_exception.html'));
        }
    });
});

// Add email (forced, one-time, for pre-existing accounts)
app.get('/account/add-email', (req, res) => {
    if (req.session.userId) return res.redirect('/feed');
    if (!req.session.pendingEmailUserId) return res.redirect('/');
    const username = escapeHTML(req.session.pendingEmailUsername || '');
    res.send(renderMessagePage('Add Email', 'One more thing',
        `<h3>We now require an email on every account so you can reset your password if you forget it. Add one to finish logging in as <strong>${username}</strong>.</h3><br>
        <form method="POST" action="/account/add-email" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
            <input type="text" name="email" placeholder="Email address" required style="width: 260px;">
            <button type="submit" class="button" style="width: 150px;">Continue</button>
        </form>`));
});

app.post('/account/add-email', async (req, res) => {
    if (!req.session.pendingEmailUserId) return res.redirect('/');
    const userId = req.session.pendingEmailUserId;
    const email = (req.body.email || '').trim().toLowerCase();

    if (!email || !EMAIL_REGEX.test(email)) {
        return res.status(400).send(renderMessagePage('Invalid Email', 'That doesn\'t look like a valid email',
            `<h3>Please double check the email address and try again.</h3><br><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/account/add-email';">Go back</button>`));
    }

    const addProblem = await validateEmailForUse(email);
    if (addProblem) {
        return res.status(400).send(renderMessagePage('Email Not Allowed', 'That email can\'t be used',
            `<h3>${escapeHTML(addProblem)}</h3><br><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/account/add-email';">Go back</button>`));
    }

    db.run(`UPDATE User_Data SET email = ?, email_verified = 0 WHERE id = ?`, [email, userId], function(err) {
        if (err) {
            console.error('Add email error:', err.message);
            return res.status(500).send(renderMessagePage('Error', 'Something went wrong',
                `<h3>Please try again.</h3><br><br>
                <button type="button" class="button" style="width: 150px" onclick="window.location.href='/account/add-email';">Go back</button>`));
        }
        const username = req.session.pendingEmailUsername;
        delete req.session.pendingEmailUserId;
        delete req.session.pendingEmailUsername;
        const loginIP = getClientIP(req);
        recordLoginIP(userId, username, loginIP, 'add-email');
        logAudit('email_added', username, username, 'added email on login (pre-existing account)');
        // The address hasn't been confirmed yet, so route into the same verification hold used
        // everywhere else instead of logging in.
        req.session.pendingVerifyUserId = userId;
        req.session.pendingVerifyUsername = username;
        issueEmailVerification(userId, username, email, () => {});
        return res.redirect('/account/verify-email-required');
    });
});

// Verify email (forced, blocks the app until confirmed)
// Small in-memory cooldown so the resend button can't be used to spam an address.
const lastVerifyResendAt = new Map();

app.get('/account/verify-email-required', (req, res) => {
    if (!req.session.pendingVerifyUserId) return res.redirect('/');
    const userId = req.session.pendingVerifyUserId;
    const username = escapeHTML(req.session.pendingVerifyUsername || '');

    db.get(`SELECT email FROM User_Data WHERE id = ?`, [userId], (err, user) => {
        const email = (user && user.email) ? user.email : '';
        res.send(renderMessagePage('Verify Email', 'Confirm your email',
            `<h3>We sent a verification link to <strong>${escapeHTML(email)}</strong>. Click it to finish logging in as <strong>${username}</strong>.</h3><br>
            <form method="POST" action="/account/verify-email-required/resend" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
                <button type="submit" class="button" style="width: 220px;">Resend verification email</button>
            </form><br>
            <p style="opacity:0.7;">Used the wrong address, or don't have access to it anymore?</p>
            <form method="POST" action="/account/verify-email-required/change" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
                <input type="text" name="email" placeholder="New email address" required style="width: 260px;">
                <button type="submit" class="button" style="width: 220px;">Use a different email</button>
            </form><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/logout';">Log out</button>`));
    });
});

app.post('/account/verify-email-required/resend', (req, res) => {
    if (!req.session.pendingVerifyUserId) return res.redirect('/');
    const userId = req.session.pendingVerifyUserId;
    const username = req.session.pendingVerifyUsername;

    const lastSent = lastVerifyResendAt.get(userId) || 0;
    if (Date.now() - lastSent < EMAIL_VERIFY_RESEND_COOLDOWN_MS) {
        return res.status(429).send(renderMessagePage('Slow Down', 'Please wait a moment',
            `<h3>A verification email was just sent. Give it a minute before requesting another.</h3><br><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/account/verify-email-required';">Go back</button>`));
    }

    db.get(`SELECT email FROM User_Data WHERE id = ?`, [userId], (err, user) => {
        if (err || !user || !user.email) return res.redirect('/account/verify-email-required');
        lastVerifyResendAt.set(userId, Date.now());
        issueEmailVerification(userId, username, user.email, () => {});
        logAudit('email_verification_resent', username, username, null);
        return res.redirect('/account/verify-email-required');
    });
});

app.post('/account/verify-email-required/change', async (req, res) => {
    if (!req.session.pendingVerifyUserId) return res.redirect('/');
    const userId = req.session.pendingVerifyUserId;
    const username = req.session.pendingVerifyUsername;
    const email = (req.body.email || '').trim().toLowerCase();

    if (!email || !EMAIL_REGEX.test(email)) {
        return res.status(400).send(renderMessagePage('Invalid Email', 'That doesn\'t look like a valid email',
            `<h3>Please double check the email address and try again.</h3><br><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/account/verify-email-required';">Go back</button>`));
    }

    if (tooManyUnverifiedEmailChanges(userId)) {
        return res.status(429).send(renderMessagePage('Too Many Changes', 'Please try again later',
            `<h3>This account has changed its email too many times while unverified. Try again in 24 hours, or contact support.</h3><br><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/account/verify-email-required';">Go back</button>`));
    }
    const changeProblem = await validateEmailForUse(email);
    if (changeProblem) {
        return res.status(400).send(renderMessagePage('Email Not Allowed', 'That email can\'t be used',
            `<h3>${escapeHTML(changeProblem)}</h3><br><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/account/verify-email-required';">Go back</button>`));
    }
    recordUnverifiedEmailChange(userId);

    // Accounts are allowed to share an email address, so there's no uniqueness check here - just
    // swap it in and send a fresh link.
    db.run(`UPDATE User_Data SET email = ?, email_verified = 0 WHERE id = ?`, [email, userId], (err) => {
        if (err) {
            console.error('Change pending email error:', err.message);
            return res.status(500).send(renderMessagePage('Error', 'Something went wrong',
                `<h3>Please try again.</h3><br><br>
                <button type="button" class="button" style="width: 150px" onclick="window.location.href='/account/verify-email-required';">Go back</button>`));
        }
        lastVerifyResendAt.set(userId, Date.now());
        issueEmailVerification(userId, username, email, () => {});
        logAudit('email_changed', username, username, `to ${email} (while unverified)`);
        return res.redirect('/account/verify-email-required');
    });
});

app.get('/account/verify-email', (req, res) => {
    const token = req.query.token || '';
    if (!token) return res.redirect('/');
    const tokenHash = hashEmailVerifyToken(token);

    db.get(`SELECT * FROM Email_Verifications WHERE token_hash = ?`, [tokenHash], (err, verifyRow) => {
        if (err || !verifyRow || verifyRow.used || new Date(verifyRow.expires_at) < new Date()) {
            return res.status(400).send(renderMessagePage('Link Expired', 'This verification link is no longer valid',
                `<h3>It may have expired or already been used. Log in to request a new one.</h3><br><br>
                <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Go to login</button>`));
        }
        db.get(`SELECT * FROM User_Data WHERE id = ?`, [verifyRow.user_id], (err2, user) => {
            if (err2 || !user) return res.redirect('/');
            // If the account's email changed after this link was sent, the link is stale even
            // though it hasn't technically expired yet.
            if (!user.email || user.email.toLowerCase() !== verifyRow.email.toLowerCase()) {
                return res.status(400).send(renderMessagePage('Link Expired', 'This verification link is no longer valid',
                    `<h3>The email on this account has changed since this link was sent. Log in to request a new one.</h3><br><br>
                    <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Go to login</button>`));
            }
            db.run(`UPDATE User_Data SET email_verified = 1 WHERE id = ?`, [user.id], (err3) => {
                if (err3) {
                    console.error('Email verify update error:', err3.message);
                    return res.status(500).send(renderMessagePage('Error', 'Something went wrong', `<h3>Please try again.</h3>`));
                }
                db.run(`UPDATE Email_Verifications SET used = 1 WHERE id = ?`, [verifyRow.id], () => {});
                logAudit('email_verified', user.username, user.username, null);

                // Same session-fixation guard as /login: swap in a fresh session ID before this
                // request's session gains authenticated.
                if (siteState.fullLockdownEnabled && !isStaffUser(user)) {
                    return res.send(renderMessagePage('Email Verified', 'Your email has been verified',
                        `<h3>Logins are temporarily paused, so you'll need to log in again later.</h3><br><br>
                        <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Go to login</button>`));
                }
                req.session.regenerate((regenErr) => {
                    if (regenErr) {
                        console.error('Session regenerate error:', regenErr.message);
                        return res.status(500).send(renderMessagePage('Error', 'Something went wrong', `<h3>Please try again.</h3>`));
                    }
                    req.session.userId = user.id;
                    req.session.userUsername = user.username;
                    return res.send(renderMessagePage('Email Verified', 'You\'re all set',
                        `<h3>Your email has been verified.</h3><br><br>
                        <button type="button" class="button" style="width: 150px" onclick="window.location.href='/feed';">Continue</button>`));
                });
            });
        });
    });
});

// Forgot / reset password
app.get('/forgot-password', (req, res) => {
    if (req.session.userId) return res.redirect('/feed');
    // Only username is accepted here, not email - since the same email can now be linked to more
    // than one account.
    res.send(renderMessagePage('Forgot Password', 'Reset your password',
        `<h3>Enter your username and we'll send a reset link to the email linked to that account.</h3><br>
        <form method="POST" action="/forgot-password" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
            <input type="text" name="username" placeholder="Username" required style="width: 260px;">
            <button type="submit" class="button" style="width: 180px;">Send reset link</button>
        </form><br>
        <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Back to login</button>`));
});

// Unauthenticated and previously had no rate limit at all.
app.post('/forgot-password', authLimiter, (req, res) => {
    const username = (req.body.username || '').trim();
    // Always show the same response either way, so this endpoint can't be used to probe which
    // usernames have accounts.
    const done = () => res.send(renderMessagePage('Forgot Password', 'Check your email',
        `<h3>If that username has an account, we've sent a password reset link to its email address. The link expires in 1 hour.</h3><br><br>
        <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Back to login</button>`));

    if (!username) return done();

    db.get(`SELECT * FROM User_Data WHERE username = ? COLLATE NOCASE`, [username], (err, user) => {
        if (err || !user || !user.email || user.IsDeleted) return done();

        const { raw, hash } = generateResetToken();
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
        db.run(`INSERT INTO Password_Resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
            [user.id, hash, expiresAt], (err2) => {
                if (err2) { console.error('Password reset insert error:', err2.message); return done(); }
                const resetLink = `${APP_BASE_URL}/reset-password?token=${raw}`;
                sendPasswordResetEmail(user.email, user.username, resetLink);
                logAudit('password_reset_requested', user.username, user.username, 'via username');
                return done();
            });
    });
});

app.get('/reset-password', (req, res) => {
    const token = req.query.token || '';
    if (!token) return res.redirect('/forgot-password');
    const tokenHash = hashResetToken(token);

    db.get(`SELECT * FROM Password_Resets WHERE token_hash = ?`, [tokenHash], (err, resetRow) => {
        if (err || !resetRow || resetRow.used || new Date(resetRow.expires_at) < new Date()) {
            return res.status(400).send(renderMessagePage('Link Expired', 'This reset link is no longer valid',
                `<h3>It may have expired or already been used. Request a new one below.</h3><br><br>
                <button type="button" class="button" style="width: 180px" onclick="window.location.href='/forgot-password';">Request new link</button>`));
        }
        res.send(renderMessagePage('Reset Password', 'Choose a new password',
            `<form method="POST" action="/reset-password" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
                <input type="hidden" name="token" value="${escapeHTML(token)}">
                <input type="password" name="password" placeholder="New password" required style="width: 260px;">
                <input type="password" name="confirm_password" placeholder="Confirm new password" required style="width: 260px;">
                <button type="submit" class="button" style="width: 150px;">Reset password</button>
            </form>`));
    });
});

app.post('/reset-password', async (req, res) => {
    const token = req.body.token || '';
    const { password, confirm_password } = req.body;
    if (!token) return res.redirect('/forgot-password');
    const tokenHash = hashResetToken(token);

    const showForm = (message) => res.status(400).send(renderMessagePage('Reset Password', 'Choose a new password',
        `<h3 style="color: var(--danger-light-color);">${escapeHTML(message)}</h3><br>
        <form method="POST" action="/reset-password" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
            <input type="hidden" name="token" value="${escapeHTML(token)}">
            <input type="password" name="password" placeholder="New password" required style="width: 260px;">
            <input type="password" name="confirm_password" placeholder="Confirm new password" required style="width: 260px;">
            <button type="submit" class="button" style="width: 150px;">Reset password</button>
        </form>`));

    if (!password || password.length < 6) return showForm('Password must be at least 6 characters.');
    if (password !== confirm_password) return showForm('Passwords do not match.');

    db.get(`SELECT * FROM Password_Resets WHERE token_hash = ?`, [tokenHash], async (err, resetRow) => {
        if (err || !resetRow || resetRow.used || new Date(resetRow.expires_at) < new Date()) {
            return res.status(400).send(renderMessagePage('Link Expired', 'This reset link is no longer valid',
                `<h3>It may have expired or already been used. Request a new one below.</h3><br><br>
                <button type="button" class="button" style="width: 180px" onclick="window.location.href='/forgot-password';">Request new link</button>`));
        }
        try {
            const hashedPassword = await bcrypt.hash(password, 10);
            db.run(`UPDATE User_Data SET password = ? WHERE id = ?`, [hashedPassword, resetRow.user_id], (err2) => {
                if (err2) {
                    console.error('Password reset update error:', err2.message);
                    return showForm('Something went wrong. Please try again.');
                }
                // Mark this token used and invalidate any other outstanding tokens for this
                // account, so an old email link can't be replayed later.
                db.run(`UPDATE Password_Resets SET used = 1 WHERE user_id = ?`, [resetRow.user_id], () => {});
                db.get(`SELECT username FROM User_Data WHERE id = ?`, [resetRow.user_id], (err3, u) => {
                    logAudit('password_reset_completed', u ? u.username : 'unknown', u ? u.username : null, null);
                });
                return res.send(renderMessagePage('Password Reset', 'Your password has been reset',
                    `<h3>You can now log in with your new password.</h3><br><br>
                    <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Go to login</button>`));
            });
        } catch (e) {
            console.error('Password reset hash error:', e);
            return showForm('Something went wrong. Please try again.');
        }
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

module.exports = { DUMMY_BCRYPT_HASH };
