// Auth API for custom clients and client login codes.
const bcrypt = require('bcrypt');
const { createAccount } = require('../accounts/create');
const { clearExpiredBan } = require('../admin/helpers');
const {
    API_AUTH_AVAILABLE,
    apiChallengeLimiter,
    apiLoginThrottle,
    apiRegisterLimiter,
    apiRequireCaptcha,
    loginFailures,
    loginKey,
    recordLoginFailure,
    requireJSONBody,
} = require('../api/auth-helpers');
const {
    CLIENT_CODE_LENGTH,
    CLIENT_CODE_TTL_MS,
    clientCodeByUser,
    clientCodeCreateLimiter,
    clientLoginCodes,
    dropClientCode,
    formatClientCode,
    newClientCode,
    normalizeClientCode,
    purgeClientCodes,
    sha256Hex,
} = require('../api/client-codes');
const { app } = require('../app');
const { APP_BASE_URL } = require('../config');
const { getStmt } = require('../db/connection');
const { EMAIL_REGEX } = require('../mail');
const { logAudit } = require('../moderation');
const { DUMMY_BCRYPT_HASH } = require('./auth');
const { SPAM_REG_BAN_REASON } = require('../security/account-spam');
const { CAPTCHA_ENABLED, TURNSTILE_SITE_KEY } = require('../security/captcha');
const { REG_MIN_FILL_MS } = require('../security/email-validation');
const { getClientIP, recordLoginIP } = require('../security/ip');
const { authLimiter } = require('../security/rate-limit');
const { FORM_TOKEN_MAX_AGE_MS, issueFormToken, parseFormToken } = require('../security/signup');
const { getRegistrationBlockPage, isStaffUser } = require('../site-state');
const siteState = require('../site-state');

// What a client needs to know before showing a login/register screen.
app.get('/api/v1/auth/config', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
        authApiAvailable: API_AUTH_AVAILABLE,
        captchaRequired: CAPTCHA_ENABLED,
        codeLogin: true, // captcha-free login for terminals
        turnstileSiteKey: CAPTCHA_ENABLED ? TURNSTILE_SITE_KEY : null,
        captchaWidgetUrl: CAPTCHA_ENABLED ? `${APP_BASE_URL}/captcha-widget` : null,
        registrationOpen: !getRegistrationBlockPage(),
        registerMinWaitMs: REG_MIN_FILL_MS,
        registerChallengeValidMs: FORM_TOKEN_MAX_AGE_MS
    });
});

// Hands out a signed, IP-bound, single-use signup challenge.
app.get('/api/v1/auth/register-challenge', apiChallengeLimiter, (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!API_AUTH_AVAILABLE) return res.status(503).json({ error: 'The auth API is disabled until the server\'s captcha is configured.', code: 'captcha_not_configured' });
    if (getRegistrationBlockPage()) return res.status(503).json({ error: 'Registration is temporarily closed.', code: 'registration_closed' });
    res.json({ challenge: issueFormToken(req), minWaitMs: REG_MIN_FILL_MS, validForMs: FORM_TOKEN_MAX_AGE_MS });
});

// A page for webview-based clients: shows the Cloudflare Turnstile widget on THIS site's domain.
app.get('/captcha-widget', (req, res) => {
    if (!CAPTCHA_ENABLED) return res.status(404).send('Captcha is not enabled.');
    res.set('Cache-Control', 'no-store');
    res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Verification</title>
<style>body{font-family:system-ui,sans-serif;text-align:center;padding:24px}textarea{width:90%;max-width:420px;height:70px;margin-top:12px}</style></head>
<body>
<h3>Confirm you're human</h3>
<div id="w" style="display:flex;justify-content:center"></div>
<div id="done" style="display:none"><p>Done. Your client can now use this token:</p>
<textarea id="tok" readonly></textarea><br><button id="copy" type="button">Copy token</button></div>
<script>
window.__cb = function () {
    turnstile.render('#w', { sitekey: ${JSON.stringify(TURNSTILE_SITE_KEY)}, callback: function (t) {
        window.biodeckCaptchaToken = t;
        document.getElementById('tok').value = t;
        document.getElementById('done').style.display = 'block';
        try { window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'biodeck-captcha', token: t })); } catch (e) {}
    }, 'expired-callback': function () { window.biodeckCaptchaToken = null; } });
};
document.getElementById('copy').onclick = function () { var t = document.getElementById('tok'); t.select(); document.execCommand('copy'); };
</script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__cb" async defer></script>
</body></html>`);
});

app.post('/api/v1/auth/register', requireJSONBody, authLimiter, apiRegisterLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!API_AUTH_AVAILABLE) return res.status(503).json({ error: 'The auth API is disabled until the server\'s captcha is configured.', code: 'captcha_not_configured' });
    if (getRegistrationBlockPage()) return res.status(503).json({ error: 'Registration is temporarily closed.', code: 'registration_closed' });

    // Cheapest checks first: the challenge is verified locally, before the captcha makes a network
    // call to Cloudflare.
    const tok = parseFormToken(req, req.body.challenge);
    if (!tok.ok) {
        const map = { too_early: 'challenge_too_early', expired: 'challenge_expired' };
        return res.status(400).json({ error: 'Invalid or unusable registration challenge. Request a new one, wait registerMinWaitMs, then submit.', code: map[tok.reason] || 'bad_challenge' });
    }
    // Run the captcha middleware inline so the order above is kept.
    let captchaPassed = false;
    await apiRequireCaptcha(req, res, () => { captchaPassed = true; });
    if (!captchaPassed) return; // apiRequireCaptcha already responded

    const username = req.body.username, password = req.body.password;
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        return res.status(400).json({ error: 'username, password and email are required.', code: 'invalid_request' });
    }
    if (username.length < 3 || username.length > 32) return res.status(400).json({ error: 'Username must be 3-32 characters.', code: 'invalid_username' });
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return res.status(400).json({ error: 'Username may only contain letters, numbers, _ . and -', code: 'invalid_username' });
    // bcrypt silently ignores everything after 72 bytes, so refuse longer passwords.
    if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) return res.status(400).json({ error: 'Password must be 8-72 bytes long.', code: 'invalid_password' });
    if (!email || email.length > 254 || !EMAIL_REGEX.test(email)) return res.status(400).json({ error: 'A valid email address is required.', code: 'invalid_email' });

    try {
        const result = await createAccount(req, { username, password, email, formNonce: tok.nonce });
        if (!result.ok) {
            switch (result.code) {
                case 'signup_refused': return res.status(result.refusal.status).json({ error: result.refusal.message, code: 'signup_refused' });
                case 'bad_form_token': return res.status(400).json({ error: 'That registration challenge was already used. Request a new one.', code: 'bad_challenge' });
                case 'lockdown': return res.status(503).json({ error: 'Registration is temporarily closed.', code: 'registration_closed' });
                case 'spam_banned': return res.status(403).json({ error: SPAM_REG_BAN_REASON, code: 'ip_banned' });
                default: return res.status(409).json({ error: 'That username is not available.', code: 'username_taken' });
            }
        }
        if (result.banned) {
            return res.status(202).json({ ok: true, status: 'pending_activation', username: result.username, message: result.banReason });
        }
        // Same pending state the website uses, so the emailed link and the verify-email pages work
        // with this session.
        req.session.pendingVerifyUserId = result.userId;
        req.session.pendingVerifyUsername = result.username;
        return res.status(201).json({ ok: true, status: 'verification_required', username: result.username, message: 'Account created. Click the link we emailed you, then log in.' });
    } catch (e) {
        console.error('API register error:', e);
        return res.status(500).json({ error: 'Something went wrong.', code: 'internal' });
    }
});

app.post('/api/v1/auth/login', requireJSONBody, authLimiter, apiLoginThrottle, apiRequireCaptcha, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const username = typeof req.body.username === 'string' ? req.body.username : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!username || !password || username.length > 64 || password.length > 1024) {
        return res.status(400).json({ error: 'username and password are required.', code: 'invalid_request' });
    }
    try {
        const user = getStmt(`SELECT * FROM User_Data WHERE username = ?`).get(username);
        // Always run one bcrypt compare so "no such user" takes as long as "wrong password" (no
        // username enumeration by timing).
        const match = await bcrypt.compare(password, user ? user.password : DUMMY_BCRYPT_HASH);
        if (!user || !match) {
            recordLoginFailure(username);
            return res.status(401).json({ error: 'Invalid username or password.', code: 'invalid_credentials' });
        }
        loginFailures.delete(loginKey(username));

        // Account state is only revealed after the password was right.
        if (user.IsDeleted) {
            return res.status(403).json({ error: 'This account has been deleted.', code: 'account_deleted', reason: user.DeleteReason || 'No reason provided' });
        }
        if (user.IsBanned && user.BanExpiresAt && new Date(user.BanExpiresAt).getTime() <= Date.now()) {
            clearExpiredBan(user.id);
            user.IsBanned = 0;
        }
        if (user.IsBanned) {
            return res.status(403).json({ error: 'This account is banned.', code: 'account_banned', reason: user.BanReason || 'No reason provided', expiresAt: user.BanExpiresAt || null });
        }
        if (siteState.fullLockdownEnabled && !isStaffUser(user)) {
            return res.status(503).json({ error: 'Logins are temporarily paused.', code: 'lockdown' });
        }
        if (!user.email) {
            req.session.pendingEmailUserId = user.id;
            req.session.pendingEmailUsername = user.username;
            return res.status(403).json({ error: 'This account needs an email address before it can be used. Finish at /account/add-email in a browser.', code: 'email_required' });
        }
        if (!user.email_verified) {
            req.session.pendingVerifyUserId = user.id;
            req.session.pendingVerifyUsername = user.username;
            return res.status(403).json({ error: 'Verify your email address first (check your inbox), then log in again.', code: 'email_verification_required' });
        }
        // Fresh session id on login (session-fixation protection), same as the website.
        req.session.regenerate((regenErr) => {
            if (regenErr) {
                console.error('Session regenerate error:', regenErr.message);
                return res.status(500).json({ error: 'Something went wrong.', code: 'internal' });
            }
            req.session.userId = user.id;
            req.session.userUsername = user.username;
            recordLoginIP(user.id, user.username, getClientIP(req), 'login');
            return res.json({ ok: true, user: { username: user.username, nickname: user.Nickname || null } });
        });
    } catch (e) {
        console.error('API login error:', e);
        return res.status(500).json({ error: 'Something went wrong.', code: 'internal' });
    }
});

app.post('/api/v1/auth/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.json({ ok: true });
    });
});
app.post('/account/client-code', requireJSONBody, clientCodeCreateLimiter, (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
    purgeClientCodes();
    const old = clientCodeByUser.get(req.session.userId);
    if (old) dropClientCode(old); // a new code replaces the previous one
    const code = newClientCode();
    const hash = sha256Hex(code);
    clientLoginCodes.set(hash, { userId: req.session.userId, username: req.session.userUsername, expiresAt: Date.now() + CLIENT_CODE_TTL_MS });
    clientCodeByUser.set(req.session.userId, hash);
    logAudit('client_code_created', req.session.userUsername, req.session.userUsername, `from ${getClientIP(req)}`);
    res.json({ code: formatClientCode(code), expiresInMs: CLIENT_CODE_TTL_MS });
});

// Terminal client -> session cookie. Same account checks and cookie as POST /api/v1/auth/login.
app.post('/api/v1/auth/code-login', requireJSONBody, authLimiter, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const invalid = () => res.status(401).json({ error: 'That code is invalid or has expired. Generate a new one on the website.', code: 'invalid_code' });
    const raw = normalizeClientCode(req.body.code);
    if (raw.length !== CLIENT_CODE_LENGTH) return invalid();
    const hash = sha256Hex(raw);
    const entry = clientLoginCodes.get(hash);
    if (!entry) return invalid();
    const expired = Date.now() > entry.expiresAt;
    dropClientCode(hash); // single use: consumed even if the account checks below
    if (expired) return invalid();
    try {
        const user = getStmt(`SELECT * FROM User_Data WHERE id = ?`).get(entry.userId);
        if (!user || user.IsDeleted) {
            return res.status(403).json({ error: 'This account has been deleted.', code: 'account_deleted', reason: (user && user.DeleteReason) || 'No reason provided' });
        }
        if (user.IsBanned && user.BanExpiresAt && new Date(user.BanExpiresAt).getTime() <= Date.now()) {
            clearExpiredBan(user.id);
            user.IsBanned = 0;
        }
        if (user.IsBanned) {
            return res.status(403).json({ error: 'This account is banned.', code: 'account_banned', reason: user.BanReason || 'No reason provided', expiresAt: user.BanExpiresAt || null });
        }
        if (siteState.fullLockdownEnabled && !isStaffUser(user)) {
            return res.status(503).json({ error: 'Logins are temporarily paused.', code: 'lockdown' });
        }
        if (!user.email || !user.email_verified) {
            return res.status(403).json({ error: 'Verify your email address first, then try again.', code: 'email_verification_required' });
        }
        req.session.regenerate((regenErr) => {
            if (regenErr) {
                console.error('Session regenerate error:', regenErr.message);
                return res.status(500).json({ error: 'Something went wrong.', code: 'internal' });
            }
            req.session.userId = user.id;
            req.session.userUsername = user.username;
            recordLoginIP(user.id, user.username, getClientIP(req), 'login');
            logAudit('client_code_login', user.username, user.username, `from ${getClientIP(req)}`);
            return res.json({ ok: true, user: { username: user.username, nickname: user.Nickname || null } });
        });
    } catch (e) {
        console.error('Client code login error:', e);
        return res.status(500).json({ error: 'Something went wrong.', code: 'internal' });
    }
});
