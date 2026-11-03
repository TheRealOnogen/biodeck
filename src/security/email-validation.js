// Disposable / blocked email checks and MX validation.
const path = require('path');
const fs = require('fs');
const { ROOT_DIR } = require('../paths');

// 2. Signup hardening
const REG_MIN_FILL_MS = 2500;            // a human can't fill the form faster than this
const MAX_ACCOUNTS_PER_IP_PER_DAY = 5;   // soft cap (refused, not banned)
const MAX_ACCOUNTS_PER_EMAIL = 3;        // counted on a normalised address (see below)

const DISPOSABLE_EMAIL_DOMAINS = new Set([
    'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com',
    'sharklasers.com', 'grr.la', '10minutemail.com', '10minutemail.net', 'tempmail.com', 'temp-mail.org',
    'temp-mail.io', 'tempmail.net', 'throwawaymail.com', 'yopmail.com', 'yopmail.net', 'getnada.com',
    'nada.email', 'trashmail.com', 'trashmail.net', 'maildrop.cc', 'dispostable.com', 'fakeinbox.com',
    'mailnesia.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com', 'spamgourmet.com', 'moakt.com',
    'tmpmail.org', 'tmpmail.net', 'burnermail.io', 'inboxkitten.com', 'mailcatch.com', 'mytemp.email',
    'tempinbox.com', 'discard.email', 'harakirimail.com', 'emailfake.com', 'fakemail.net', 'getairmail.com',
    'mail.tm', 'tempr.email'
]);

// Optional extra domains, one per line (# comments allowed).
const BLOCKED_EMAIL_DOMAINS_FILE = path.join(ROOT_DIR, 'blocked-email-domains.txt');
(function loadExtraBlockedEmailDomains() {
    try {
        fs.readFileSync(BLOCKED_EMAIL_DOMAINS_FILE, 'utf8').split(/\r?\n/).forEach(line => {
            const d = line.replace(/#.*$/, '').trim().toLowerCase();
            if (d) DISPOSABLE_EMAIL_DOMAINS.add(d);
        });
    } catch (e) { /* no file = just the built-in list */ }
})();

function isDisposableEmail(email) {
    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
    const parts = domain.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
        if (DISPOSABLE_EMAIL_DOMAINS.has(parts.slice(i).join('.'))) return true;
    }
    return false;
}

// Stronger email validation (works against services that rotate domains)
// Domain blocklists can't stop services that generate a fresh domain every time, so on top of the
// list we.
const dnsPromises = require('dns').promises;

const TRUSTED_EMAIL_DOMAINS = new Set([
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
    'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'pm.me',
    'gmx.com', 'gmx.net', 'mail.ru', 'yandex.com', 'yandex.ru', 'ukr.net', 'i.ua', 'meta.ua',
    'aol.com', 'zoho.com', 'fastmail.com'
]);

const BLOCKED_MX_HOSTS = new Set();
const BLOCKED_MX_HOSTS_FILE = path.join(ROOT_DIR, 'blocked-mx-hosts.txt');
(function loadBlockedMxHosts() {
    try {
        fs.readFileSync(BLOCKED_MX_HOSTS_FILE, 'utf8').split(/\r?\n/).forEach(line => {
            const h = line.replace(/#.*$/, '').trim().toLowerCase().replace(/\.$/, '');
            if (h) BLOCKED_MX_HOSTS.add(h);
        });
    } catch (e) { /* no file = no MX blocking, only the other checks */ }
})();

// Disposable services rotate domains AND mail-server hostnames.
const BLOCKED_MX_IPS = new Set();
const BLOCKED_MX_CIDRS = []; // { base, mask }
const BLOCKED_MX_IPS_FILE = path.join(ROOT_DIR, 'blocked-mx-ips.txt');
function ipv4ToInt(ip) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (!m) return null;
    const o = m.slice(1).map(Number);
    if (o.some(n => n > 255)) return null;
    return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}
(function loadBlockedMxIps() {
    try {
        fs.readFileSync(BLOCKED_MX_IPS_FILE, 'utf8').split(/\r?\n/).forEach(line => {
            const v = line.replace(/#.*$/, '').trim().toLowerCase();
            if (!v) return;
            const slash = v.indexOf('/');
            if (slash === -1) { BLOCKED_MX_IPS.add(v); return; }
            const base = ipv4ToInt(v.slice(0, slash));
            const bits = parseInt(v.slice(slash + 1), 10);
            if (base === null || !(bits >= 8 && bits <= 32)) return; // ignore junk / absurdly wide ranges
            const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
            BLOCKED_MX_CIDRS.push({ base: (base & mask) >>> 0, mask });
        });
    } catch (e) { /* no file = no IP blocking */ }
})();
function isBlockedMxIp(ip) {
    ip = String(ip).toLowerCase();
    if (BLOCKED_MX_IPS.has(ip)) return true;
    const n = ipv4ToInt(ip);
    if (n === null) return false;
    return BLOCKED_MX_CIDRS.some(c => ((n & c.mask) >>> 0) === c.base);
}
async function mxHostResolvesToBlockedIp(host) {
    if (!BLOCKED_MX_IPS.size && !BLOCKED_MX_CIDRS.length) return false;
    const ips = [];
    try { ips.push(...await withTimeout(dnsPromises.resolve4(host), 3000)); } catch (e) {}
    try { ips.push(...await withTimeout(dnsPromises.resolve6(host), 3000)); } catch (e) {}
    return ips.some(isBlockedMxIp);
}

// Small cache so repeated attempts (and the same domain used by many signups) don't hammer DNS.
const mxCheckCache = new Map();
const MX_CACHE_TTL_MS = 10 * 60 * 1000;

function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('dns timeout')), ms))]);
}

// Returns null when the address is fine, otherwise a short user-facing reason.
async function validateEmailForUse(email) {
    const addr = String(email || '').trim().toLowerCase();
    const at = addr.lastIndexOf('@');
    if (at < 1) return 'That doesn\'t look like a valid email.';
    const domain = addr.slice(at + 1);

    if (isDisposableEmail(addr)) return 'Temporary/disposable email addresses can\'t be used.';
    if (TRUSTED_EMAIL_DOMAINS.has(domain)) return null;

    const cached = mxCheckCache.get(domain);
    if (cached && cached.until > Date.now()) return cached.reason;

    let reason = null;
    try {
        const mx = await withTimeout(dnsPromises.resolveMx(domain), 4000);
        if (!mx || !mx.length) {
            reason = 'That email domain can\'t receive mail. Please use a different address.';
        } else if (mx.some(r => {
            const h = String(r.exchange || '').toLowerCase().replace(/\.$/, '');
            for (const b of BLOCKED_MX_HOSTS) { if (h === b || h.endsWith('.' + b)) return true; }
            return false;
        })) {
            reason = 'Temporary/disposable email addresses can\'t be used.';
        } else {
            // Hostname looked fine; check what the mail servers actually resolve to.
            const hosts = mx.map(r => String(r.exchange || '').toLowerCase().replace(/\.$/, '')).filter(Boolean);
            const hits = await Promise.all(hosts.map(mxHostResolvesToBlockedIp));
            if (hits.some(Boolean)) reason = 'Temporary/disposable email addresses can\'t be used.';
        }
    } catch (e) {
        if (e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA')) {
            reason = 'That email domain can\'t receive mail. Please use a different address.';
        } else {
            // DNS hiccup/timeout: fail open so a resolver problem never blocks everyone.
            console.warn('MX lookup failed for', domain, '-', e && e.message);
            return null;
        }
    }
    mxCheckCache.set(domain, { reason, until: Date.now() + MX_CACHE_TTL_MS });
    return reason;
}

// Caps how many times an account can swap its email while still unverified.
const unverifiedEmailChanges = new Map(); // userId -> [timestamps]
const MAX_UNVERIFIED_EMAIL_CHANGES = 3;
const UNVERIFIED_EMAIL_CHANGE_WINDOW_MS = 24 * 60 * 60 * 1000;
function tooManyUnverifiedEmailChanges(userId) {
    const now = Date.now();
    const recent = (unverifiedEmailChanges.get(userId) || []).filter(t => now - t < UNVERIFIED_EMAIL_CHANGE_WINDOW_MS);
    unverifiedEmailChanges.set(userId, recent);
    return recent.length >= MAX_UNVERIFIED_EMAIL_CHANGES;
}
function recordUnverifiedEmailChange(userId) {
    const arr = unverifiedEmailChanges.get(userId) || [];
    arr.push(Date.now());
    unverifiedEmailChanges.set(userId, arr);
}

// Collapses the usual "same inbox, different spelling" tricks so one mailbox can't be turned into
// unlimited addresses.
function normalizeEmailForLimit(email) {
    const at = email.lastIndexOf('@');
    if (at < 1) return email;
    let local = email.slice(0, at).toLowerCase();
    let domain = email.slice(at + 1).toLowerCase();
    local = local.split('+')[0];
    if (domain === 'gmail.com' || domain === 'googlemail.com') {
        local = local.replace(/\./g, '');
        domain = 'gmail.com';
    }
    return `${local}@${domain}`;
}

module.exports = {
    MAX_ACCOUNTS_PER_EMAIL,
    MAX_ACCOUNTS_PER_IP_PER_DAY,
    REG_MIN_FILL_MS,
    isDisposableEmail,
    normalizeEmailForLimit,
    recordUnverifiedEmailChange,
    tooManyUnverifiedEmailChanges,
    validateEmailForUse,
};
