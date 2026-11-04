// Body parsing, static files, sessions, headers and /theme.css.
const express = require('express');
const path = require('path');
const fs = require('fs');
const { app } = require('../app');
const { db } = require('../db/connection');
const { ROOT_DIR } = require('../paths');
const { getStmt } = require('../db/connection');
const { sendToUser, broadcast } = require('../live/websocket');
const { getClientIP } = require('../security/ip');
const { sessionMiddleware } = require('../session');
const { FALLBACK_THEME, getThemeByName, resolveThemeCSSPath } = require('../themes');
const { serveUpload } = require('../uploads/access');

// Logs every request once the response is sent: time, IP, method, URL, status, duration, user.
// Query strings are cut off so tokens and codes in URLs never end up in the log.
app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        const user = (req.session && req.session.userUsername) || '-';
        const url = req.originalUrl.split('?')[0];
        console.log(`[${new Date().toISOString()}] ${getClientIP(req)} ${req.method} ${url} ${res.statusCode} ${ms.toFixed(1)}ms user=${user}`);
    });
    next();
});

// After a successful change, tell open pages over the WebSocket so they refresh.
const FEED_CHANGE_PATH = /^\/(feed|post|admin|api\/v1\/post|account\/delete-self)(\/|$)/;
app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    res.on('finish', () => {
        if (res.statusCode >= 400) return;
        const url = req.originalUrl.split('?')[0];
        if (FEED_CHANGE_PATH.test(url)) broadcast('feed');
        if (url.startsWith('/notifications/') && req.session) sendToUser(req.session.userUsername, 'notifications');
    });
    next();
});

app.use(express.urlencoded({extended:true}))
app.use(express.json())

// public/ is served statically EXCEPT anything under /uploads, which goes through serveUpload().
const publicStatic = express.static(path.join(ROOT_DIR, 'public'));

// 404.html lives beside server.js (not in public/), same as editor.html.
app.get('/404.html', (req, res) => {
    res.status(404).sendFile(path.join(ROOT_DIR, '404.html'));
});
function isUploadsPath(rawPath) {
    let p;
    try { p = decodeURIComponent(rawPath); } catch (e) { return true; }
    p = path.posix.normalize('/' + p).toLowerCase();
    return p === '/uploads' || p.startsWith('/uploads/');
}
app.use((req, res, next) => {
    if (isUploadsPath(req.path)) return next();
    publicStatic(req, res, next);
});
app.get('/uploads/:filename', (req, res) => serveUpload(req, res, false));

// This app runs behind a reverse proxy (confirmed by X-Forwarded-For showing up on incoming
// requests), so Express needs to trust it.
const TRUST_PROXY_HOPS = Math.max(0, parseInt(process.env.TRUST_PROXY_HOPS || '1', 10) || 0);
app.set('trust proxy', TRUST_PROXY_HOPS);
app.use(sessionMiddleware);

// Pages with Report buttons get the user's existing reports inline, so the browser never has to
// ask /api/my-reports for them.
app.use((req, res, next) => {
    if (req.method !== 'GET' || !req.session || !req.session.userUsername) return next();
    const send = res.send;
    res.send = function (body) {
        const marker = '<script>\nfunction reportContent(';
        if (typeof body === 'string' && body.includes(marker)) {
            try {
                const rows = getStmt(`SELECT source_type, source_id FROM Reports WHERE reporter_username = ?`)
                    .all(req.session.userUsername);
                const json = JSON.stringify(rows.map(r => [r.source_type, r.source_id])).replace(/</g, '\\u003c');
                body = body.replace(marker, () => `<script>window.__reported = ${json};</script>\n${marker}`);
            } catch (e) {
                console.error('Reported-state inject error:', e.message);
            }
        }
        return send.call(this, body);
    };
    next();
});

// Basic hardening headers.
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
});

// Serves whichever stylesheet is currently active for the visitor.
app.get('/theme.css', (req, res) => {
    // Deliberately NOT using res.sendFile here. sendFile auto-generates a weak ETag from the file's
    // size+mtime.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    const sendTheme = (theme) => {
        const themePath = resolveThemeCSSPath(theme);
        fs.readFile(themePath, 'utf8', (err, css) => {
            if (err) {
                return fs.readFile(path.join(ROOT_DIR, 'public', FALLBACK_THEME.file), 'utf8', (err2, fallbackCss) => {
                    if (err2) return res.status(500).end();
                    res.type('text/css').send(fallbackCss);
                });
            }
            res.type('text/css').send(css);
        });
    };
    if (!req.session.userId) return sendTheme(getThemeByName('default'));
    db.get(`SELECT theme FROM User_Data WHERE id = ?`, [req.session.userId], (err, row) => {
        sendTheme(getThemeByName(err || !row ? 'default' : row.theme));
    });
});
