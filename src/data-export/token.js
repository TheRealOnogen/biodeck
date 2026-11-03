// Signed tokens for people without a session.
const crypto = require('crypto');
const { DATA_EXPORT_TOKEN_TTL_MS } = require('./core');
const { SESSION_SECRET } = require('../session');

// signed tokens for people without a session

const DX_TOKEN_KEY = crypto.createHmac('sha256', SESSION_SECRET).update('biodeck-data-export-token-v1').digest();

function dxSignToken(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', DX_TOKEN_KEY).update(body).digest('base64url');
    return `${body}.${sig}`;
}

function dxVerifyToken(token) {
    if (typeof token !== 'string' || token.length > 600) return null;
    const dot = token.indexOf('.');
    if (dot < 1) return null;
    const body = token.slice(0, dot);
    const sig = Buffer.from(token.slice(dot + 1), 'base64url');
    const expected = crypto.createHmac('sha256', DX_TOKEN_KEY).update(body).digest();
    if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
    try {
        const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!p || (p.t !== 'user' && p.t !== 'archive') || !Number.isInteger(p.id) || !(p.exp > Date.now())) return null;
        return p;
    } catch (e) { return null; }
}

function dxSubjectToken(type, id) {
    return dxSignToken({ t: type, id, exp: Date.now() + DATA_EXPORT_TOKEN_TTL_MS });
}

function dxReadCookie(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i < 0 || part.slice(0, i).trim() !== name) continue;
        try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return null; }
    }
    return null;
}

// Data export: request routes (see the "Data export & account archives" block above)

function dxResolveSubject(req) {
    if (req.session && req.session.userId) return { type: 'user', id: req.session.userId };
    const p = dxVerifyToken(req.body && req.body.token);
    return p ? { type: p.t, id: p.id } : null;
}

module.exports = { dxReadCookie, dxResolveSubject, dxSubjectToken, dxVerifyToken };
