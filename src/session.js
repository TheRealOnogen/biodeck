// Session secret and session middleware.
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { ROOT_DIR } = require('./paths');

const FileStore = require('session-file-store')(session);

const SESSION_SECRET_PATH = path.join(ROOT_DIR, '.session-secret');
function loadOrCreateSessionSecret() {
    if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
    try {
        return fs.readFileSync(SESSION_SECRET_PATH, 'utf8').trim();
    } catch (e) {
        const secret = require('crypto').randomBytes(64).toString('hex');
        try { fs.writeFileSync(SESSION_SECRET_PATH, secret, { mode: 0o600 }); } catch (e2) {
            console.error('Could not persist session secret, sessions will reset on restart:', e2.message);
        }
        return secret;
    }
}
const SESSION_SECRET = loadOrCreateSessionSecret();

const sessionsDir = path.join(ROOT_DIR, 'sessions');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

// Named so serveUpload() can load the session on demand for private files. express-session is a
// no-op when req.session is already.
const sessionMiddleware = session({
    store: new FileStore({ path: sessionsDir, ttl: 7 * 24 * 60 * 60, retries: 1, logFn: function () {} }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        // 'auto' sends Secure (HTTPS-only) whenever the request is HTTPS, and falls back to
        // unsecured cookies over plain HTTP for local dev.
        secure: 'auto',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
});

module.exports = { SESSION_SECRET, sessionMiddleware };
