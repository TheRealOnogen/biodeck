// Auth API limiters and login throttling.
const rateLimitForAuth = require('express-rate-limit');
const { CAPTCHA_ENABLED, verifyCaptchaToken } = require('../security/captcha');

// Auth API for custom clients: /api/v1/auth/*
// Same rules as the website, enforced by the same code.
const API_ALLOW_NO_CAPTCHA = ['1', 'true'].includes(String(process.env.API_ALLOW_NO_CAPTCHA || '').toLowerCase());
const API_AUTH_AVAILABLE = CAPTCHA_ENABLED || API_ALLOW_NO_CAPTCHA;

function requireJSONBody(req, res, next) {
    if (!req.is('application/json')) {
        return res.status(415).json({ error: 'Send a JSON body with Content-Type: application/json.', code: 'unsupported_media_type' });
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({ error: 'Request body must be a JSON object.', code: 'invalid_request' });
    }
    next();
}

function apiLimiterMessage(error) { return { error, code: 'rate_limited' }; }
const apiChallengeLimiter = rateLimitForAuth({
    windowMs: 10 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
    message: apiLimiterMessage('Too many requests. Please wait a few minutes and try again.')
});
const apiRegisterLimiter = rateLimitForAuth({
    windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
    message: apiLimiterMessage('Too many registration attempts from this network. Please try again later.')
});

// Fails closed when no captcha is configured (unless explicitly allowed for dev).
async function apiRequireCaptcha(req, res, next) {
    if (!CAPTCHA_ENABLED) {
        if (API_ALLOW_NO_CAPTCHA) return next();
        return res.status(503).json({ error: 'The auth API is disabled until the server\'s captcha is configured.', code: 'captcha_not_configured' });
    }
    if (await verifyCaptchaToken(req, req.body && req.body.captchaToken)) return next();
    return res.status(400).json({ error: 'Captcha verification failed. Get a fresh token from the captcha page and try again.', code: 'captcha_failed' });
}

// Per-username failed-login throttle (the IP limiter alone doesn't stop one account being guessed
// from many IPs).
const LOGIN_FAIL_MAX = 10;
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map(); // lowercase username -> { count, first }
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of loginFailures) if (now - v.first > LOGIN_FAIL_WINDOW_MS) loginFailures.delete(k);
}, 5 * 60 * 1000).unref();
function loginKey(username) { return String(username || '').toLowerCase().slice(0, 64); }
function recordLoginFailure(username) {
    const k = loginKey(username), now = Date.now();
    const cur = loginFailures.get(k);
    if (!cur || now - cur.first > LOGIN_FAIL_WINDOW_MS) loginFailures.set(k, { count: 1, first: now });
    else cur.count++;
}
function apiLoginThrottle(req, res, next) {
    const cur = loginFailures.get(loginKey(req.body && req.body.username));
    if (cur && Date.now() - cur.first <= LOGIN_FAIL_WINDOW_MS && cur.count >= LOGIN_FAIL_MAX) {
        return res.status(429).json({ error: 'Too many failed logins for this account. Please wait a few minutes.', code: 'too_many_failures' });
    }
    next();
}

module.exports = {
    API_AUTH_AVAILABLE,
    apiChallengeLimiter,
    apiLoginThrottle,
    apiRegisterLimiter,
    apiRequireCaptcha,
    loginFailures,
    loginKey,
    recordLoginFailure,
    requireJSONBody,
};
