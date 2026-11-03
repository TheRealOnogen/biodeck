// Cloudflare Turnstile captcha.
const { renderMessagePage } = require('../render/pages');
const { getClientIP } = require('./ip');

// CAPTCHA (Cloudflare Turnstile) on /login and /register
// Free keys: Cloudflare dashboard -> Turnstile -> add a widget for your domain, then put these in
// vars.env.
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
const CAPTCHA_ENABLED = !!(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY);

// Set REQUIRE_CAPTCHA=1 in vars.env to FAIL CLOSED: if the keys are missing.
const REQUIRE_CAPTCHA = ['1', 'true'].includes(String(process.env.REQUIRE_CAPTCHA || '').toLowerCase());
if (REQUIRE_CAPTCHA && !CAPTCHA_ENABLED) console.error('REQUIRE_CAPTCHA is set but TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY are missing - login and registration will be refused until they are set.');
if (!CAPTCHA_ENABLED) console.warn('Captcha is OFF - set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY in vars.env to enable it on /login and /register.');

async function verifyCaptchaToken(req, tokenOverride) {
    const token = tokenOverride !== undefined ? tokenOverride : (req.body && req.body['cf-turnstile-response']);
    if (typeof token !== 'string' || !token || token.length > 2048) return false;
    try {
        const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            body: new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: token, remoteip: getClientIP(req) }),
            signal: AbortSignal.timeout(5000)
        });
        const data = await r.json();
        return !!(data && data.success);
    } catch (e) {
        // Fails closed: if Cloudflare can't be reached nobody gets through.
        console.error('Captcha verification error:', e.message);
        return false;
    }
}

// Runs after authLimiter and BEFORE any other work in the route.
async function requireCaptcha(req, res, next) {
    if (!CAPTCHA_ENABLED) {
        if (!REQUIRE_CAPTCHA) return next();
        return res.status(503).send(renderMessagePage('Unavailable', 'Temporarily unavailable',
            `<h3>This form is disabled until the site's captcha is configured. Please try again later.</h3>`));
    }
    if (await verifyCaptchaToken(req)) return next();
    const back = req.path === '/register' ? '/register' : '/';
    return res.status(400).send(renderMessagePage('Captcha failed', 'Captcha check failed',
        `<h3>We couldn't verify that you're not a bot. Please go back and try again.</h3><br><br>
        <button type="button" class="button" style="width: 150px" onclick="window.location.href='${back}';">Go back</button>`));
}

module.exports = { CAPTCHA_ENABLED, TURNSTILE_SITE_KEY, requireCaptcha, verifyCaptchaToken };
