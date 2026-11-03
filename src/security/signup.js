// Signup form tokens and bot guards.
const crypto = require('crypto');
const { getStmt } = require('../db/connection');
const { renderMessagePage } = require('../render/pages');
const {
    MAX_ACCOUNTS_PER_EMAIL,
    MAX_ACCOUNTS_PER_IP_PER_DAY,
    REG_MIN_FILL_MS,
    isDisposableEmail,
} = require('./email-validation');
const { getClientIP } = require('./ip');
const { SESSION_SECRET } = require('../session');

// Signup form tokens (server-issued, replaces the client-reported "_t")
// The old "form open time" check trusted a number the CLIENT sent (_t).
const FORM_TOKEN_KEY = crypto.createHmac('sha256', SESSION_SECRET).update('biodeck-form-token-v1').digest();
const FORM_TOKEN_MAX_AGE_MS = 60 * 60 * 1000;
const usedFormNonces = new Map(); // nonce -> expiry timestamp
setInterval(() => {
    const now = Date.now();
    for (const [n, exp] of usedFormNonces) if (exp < now) usedFormNonces.delete(n);
}, 5 * 60 * 1000).unref();

function formTokenMac(payload, ip) {
    return crypto.createHmac('sha256', FORM_TOKEN_KEY).update(payload + '|' + ip).digest('hex');
}
function issueFormToken(req) {
    const payload = Date.now() + '.' + crypto.randomBytes(12).toString('hex');
    return payload + '.' + formTokenMac(payload, getClientIP(req));
}

// Checks everything EXCEPT "already used".
function parseFormToken(req, token) {
    if (typeof token !== 'string' || token.length > 200) return { ok: false, reason: 'missing' };
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [ts, nonce, mac] = parts;
    const expected = formTokenMac(ts + '.' + nonce, getClientIP(req));
    const a = Buffer.from(mac), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
    const age = Date.now() - parseInt(ts, 10);
    if (!Number.isFinite(age) || age < REG_MIN_FILL_MS) return { ok: false, reason: 'too_early' };
    if (age > FORM_TOKEN_MAX_AGE_MS) return { ok: false, reason: 'expired' };
    if (usedFormNonces.has(nonce)) return { ok: false, reason: 'replayed' };
    return { ok: true, nonce };
}

// Synchronous check-and-set, so concurrent requests can't both pass with one token.
function consumeFormNonce(nonce) {
    if (!nonce || usedFormNonces.has(nonce)) return false;
    usedFormNonces.set(nonce, Date.now() + FORM_TOKEN_MAX_AGE_MS);
    return true;
}
function releaseFormNonce(nonce) { if (nonce) usedFormNonces.delete(nonce); }

function sendRegistrationBotRefusal(res) {
    return res.status(400).send(renderMessagePage('Registration failed', 'Something went wrong',
        `<h3>We couldn't process that registration. Please reload the page and try again.</h3><br><br>
        <button type="button" class="button" style="width: 150px" onclick="window.location.href='/register';">Go back</button>`));
}

// Hidden honeypot field ("website") must be empty AND the form must carry a valid server-issued
// token (see above).
function registrationBotGuard(req, res, next) {
    const b = req.body || {};
    const honeypot = typeof b.website === 'string' ? b.website.trim() : '';
    const tok = parseFormToken(req, b._ft);
    if (honeypot || !tok.ok) return sendRegistrationBotRefusal(res);
    req._formNonce = tok.nonce;
    next();
}

// Cheap checks that run BEFORE the bcrypt hash so refused signups cost almost nothing.
function checkSignupLimits(ip, email, emailNorm) {
    try {
        if (isDisposableEmail(email)) {
            return { status: 400, title: 'Email not allowed', heading: 'That email provider isn\'t allowed',
                message: 'Please use a permanent email address (temporary/disposable inboxes can\'t be used).' };
        }
        const byEmail = getStmt(`SELECT COUNT(*) AS c FROM User_Data WHERE reg_email_norm = ?`).get(emailNorm);
        if (byEmail && byEmail.c >= MAX_ACCOUNTS_PER_EMAIL) {
            return { status: 429, title: 'Email limit reached', heading: 'That email can\'t be used again',
                message: 'This email address has been used for too many accounts. Please use a different one.' };
        }
        const byIP = getStmt(`SELECT COUNT(*) AS c FROM Registration_IPs WHERE ip = ? AND created_ts > ?`)
            .get(ip, Date.now() - 24 * 60 * 60 * 1000);
        if (byIP && byIP.c >= MAX_ACCOUNTS_PER_IP_PER_DAY) {
            return { status: 429, title: 'Too many accounts', heading: 'Too many accounts from your network',
                message: 'Too many accounts have been created from your network today. Please try again tomorrow.' };
        }
    } catch (e) {
        console.error('Signup limit check error:', e.message);
    }
    return null;
}

module.exports = {
    FORM_TOKEN_MAX_AGE_MS,
    checkSignupLimits,
    consumeFormNonce,
    issueFormToken,
    parseFormToken,
    registrationBotGuard,
    releaseFormNonce,
    sendRegistrationBotRefusal,
};
