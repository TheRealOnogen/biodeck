// One-time client login codes.
const crypto = require('crypto');
const rateLimitForAuth = require('express-rate-limit');

// One-time client login codes (terminal clients, no captcha)
// The password login above needs a Turnstile token, which only a browser can produce.
const CLIENT_CODE_TTL_MS = 10 * 60 * 1000;
const CLIENT_CODE_LENGTH = 12;
const CLIENT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L lookalikes
const clientLoginCodes = new Map(); // sha256(code) -> { userId, username, expiresAt }
const clientCodeByUser = new Map(); // userId -> sha256(code) of their one active code

function sha256Hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function newClientCode() {
    let c = '';
    for (let i = 0; i < CLIENT_CODE_LENGTH; i++) c += CLIENT_CODE_ALPHABET[crypto.randomInt(CLIENT_CODE_ALPHABET.length)];
    return c;
}
function formatClientCode(c) { return c.replace(/(.{4})(?=.)/g, '$1-'); }
function normalizeClientCode(input) { return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32); }
function dropClientCode(hash) {
    const e = clientLoginCodes.get(hash);
    if (e && clientCodeByUser.get(e.userId) === hash) clientCodeByUser.delete(e.userId);
    clientLoginCodes.delete(hash);
}
function purgeClientCodes() {
    const now = Date.now();
    for (const [hash, e] of clientLoginCodes) if (now > e.expiresAt) dropClientCode(hash);
}
setInterval(purgeClientCodes, 60 * 1000).unref();

// Dashboard button -> JSON { code, expiresInMs }.
const clientCodeCreateLimiter = rateLimitForAuth({
    windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => 'u' + (req.session && req.session.userId),
    message: { error: 'You generated too many codes. Please wait a few minutes.', code: 'rate_limited' }
});

module.exports = {
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
};
