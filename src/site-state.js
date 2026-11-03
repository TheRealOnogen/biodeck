// Runtime switches: registration gate, lockdowns, read-only mode.
const { db, getStmt } = require('./db/connection');
const { getActivationPingUsernames, logAudit } = require('./moderation');
const { escapeHTML } = require('./render/html');
const { renderMessagePage } = require('./render/pages');
const { sendSystemDM } = require('./social');
const { formatDuration } = require('./util');

// Registration gate, toggleable from the admin dashboard.
let registrationGateEnabled = true;
function loadRegistrationGateSetting() {
    db.get(`SELECT value FROM Settings WHERE key = 'registration_gate_enabled'`, (err, row) => {
        if (!err && row) registrationGateEnabled = row.value === '1';
    });
}
function setRegistrationGateEnabled(enabled, cb) {
    const value = enabled ? '1' : '0';
    db.run(`INSERT INTO Settings (key, value) VALUES ('registration_gate_enabled', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [value], (err) => {
        if (!err) registrationGateEnabled = enabled;
        cb(err);
    });
}

// 1. Registration lockdown
const LOCKDOWN_REG_MAX = 10;
const LOCKDOWN_REG_WINDOW_MS = 60 * 1000;
const LOCKDOWN_DURATION_MS = 3 * 60 * 60 * 1000; // used by the automatic spike lockdown
// Manual lockdowns have no end time unless one is given: "until" is set to the max Date value.
const LOCKDOWN_INDEFINITE = 8.64e15;

// Epoch ms the lockdown ends at (0 / in the past = not locked down).
let registrationLockdownUntil = 0;

function loadRegistrationLockdown() {
    db.get(`SELECT value FROM Settings WHERE key = 'registration_lockdown_until'`, (err, row) => {
        if (!err && row) registrationLockdownUntil = parseInt(row.value, 10) || 0;
    });
}

function isRegistrationLockdownIndefinite() {
    return registrationLockdownUntil >= LOCKDOWN_INDEFINITE;
}

function getRegistrationLockdownLeftMs() {
    return Math.max(0, registrationLockdownUntil - Date.now());
}

function setRegistrationLockdown(untilTs) {
    registrationLockdownUntil = untilTs; // in-memory first so it applies to the very next request
    db.run(`INSERT INTO Settings (key, value) VALUES ('registration_lockdown_until', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(untilTs)],
        (err) => { if (err) console.error('Registration lockdown save error:', err.message); });
}

function renderLockdownPage(leftMs) {
    const when = isRegistrationLockdownIndefinite() ? 'later' : `in about ${escapeHTML(formatDuration(leftMs))}`;
    return renderMessagePage('Registration paused', 'Registration is temporarily disabled',
        `<h3>We noticed an unusual spike in signups, so new registrations are paused for now. Please try again ${when}.</h3><br><br>
        <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Back to login</button>`);
}

// Cheap early exit used on GET /register and POST /register (before the captcha round-trip and
// before any hashing work).
function registrationLockdownGuard(req, res, next) {
    if (req.session && req.session.userId) return next();
    const page = getRegistrationBlockPage();
    if (!page) return next();
    const left = getRegistrationLockdownLeftMs();
    if (!fullLockdownEnabled && left && !isRegistrationLockdownIndefinite()) res.set('Retry-After', String(Math.ceil(left / 1000)));
    return res.status(503).send(page);
}

// Full lockdown (manual, admin-controlled)
// Switched on/off from the admin dashboard (Owners / Head Admins).
let fullLockdownEnabled = false;

function loadFullLockdown() {
    db.get(`SELECT value FROM Settings WHERE key = 'full_lockdown'`, (err, row) => {
        if (!err && row) fullLockdownEnabled = row.value === '1';
    });
}

function setFullLockdown(enabled) {
    fullLockdownEnabled = !!enabled; // in-memory first so it applies to the very next request
    db.run(`INSERT INTO Settings (key, value) VALUES ('full_lockdown', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [enabled ? '1' : '0'],
        (err) => { if (err) console.error('Full lockdown save error:', err.message); });
}

function isStaffUser(user) {
    return !!(user && (user.IsAdmin || user.IsOwner || user.IsHeadAdmin));
}

// Read-only mode (manual, Owner / Head Admin controlled)
// While ON.
let readOnlyModeEnabled = false;

function loadReadOnlyMode() {
    db.get(`SELECT value FROM Settings WHERE key = 'read_only_mode'`, (err, row) => {
        if (!err && row) readOnlyModeEnabled = row.value === '1';
    });
}

function setReadOnlyMode(enabled) {
    readOnlyModeEnabled = !!enabled; // in-memory first so it applies to the very next request
    db.run(`INSERT INTO Settings (key, value) VALUES ('read_only_mode', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [enabled ? '1' : '0'],
        (err) => { if (err) console.error('Read-only mode save error:', err.message); });
    if (!enabled) require('./data-export/worker').dxKickQueue(); // data exports that were queued while it was on can go out now
}

const READ_ONLY_MESSAGE = 'Biodeck is in read-only mode - no changes can be made right now.';

function renderReadOnlyPage() {
    return renderMessagePage('Read-only mode', 'Biodeck is in read-only mode',
        `<h3>New accounts can't be created while Biodeck is in read-only mode. Please try again later.</h3><br><br>
        <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Back to home</button>`);
}

function renderFullLockdownPage() {
    return renderMessagePage('Temporarily unavailable', 'Logins and signups are paused',
        `<h3>Biodeck has temporarily paused new logins and registrations. If you're already signed in you can keep using the site as normal. Please try again later.</h3><br><br>
        <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Back to home</button>`);
}

// The page to show instead of the registration form/handler, or null when registration is open.
function getRegistrationBlockPage() {
    if (readOnlyModeEnabled) return renderReadOnlyPage();
    if (fullLockdownEnabled) return renderFullLockdownPage();
    const left = getRegistrationLockdownLeftMs();
    return left > 0 ? renderLockdownPage(left) : null;
}

// DMs the admins who already get activation pings (user id 1 + anyone in activation-pings.txt) so a
// lockdown never goes unnoticed.
function notifyAdminsOfLockdown(message) {
    const targets = new Set(getActivationPingUsernames());
    db.get(`SELECT username FROM User_Data WHERE id = 1`, (err, owner) => {
        if (owner) targets.add(owner.username);
        const list = [...targets];
        if (!list.length) return;
        const placeholders = list.map(() => '?').join(',');
        db.all(`SELECT username FROM User_Data WHERE username IN (${placeholders})`, list, (err2, rows) => {
            if (err2 || !rows) return;
            rows.forEach(r => sendSystemDM(r.username, message));
        });
    });
}

// Called right after a successful registration has been logged to Registration_IPs.
function checkRegistrationLockdownTrigger() {
    if (getRegistrationLockdownLeftMs() > 0) return;
    try {
        const since = Date.now() - LOCKDOWN_REG_WINDOW_MS;
        const rows = getStmt(`SELECT username, ip FROM Registration_IPs WHERE created_ts > ?`).all(since);
        if (rows.length < LOCKDOWN_REG_MAX) return;
        const until = Date.now() + LOCKDOWN_DURATION_MS;
        setRegistrationLockdown(until);
        const names = rows.map(r => r.username).join(', ');
        const ipCount = new Set(rows.map(r => r.ip)).size;
        const summary = `${rows.length} accounts created within ${LOCKDOWN_REG_WINDOW_MS / 1000}s from ${ipCount} IP${ipCount === 1 ? '' : 's'}`;
        logAudit('registration_lockdown_started', 'System', null,
            `${summary}; registration disabled for ${LOCKDOWN_DURATION_MS / 3600000}h. Accounts: ${names}`.slice(0, 1000));
        notifyAdminsOfLockdown(`Registration lockdown started: ${summary}. Signups are disabled for ${LOCKDOWN_DURATION_MS / 3600000} hours (until ${new Date(until).toUTCString()}). Accounts created in the burst: ${names}. You can end the lockdown early from the admin dashboard.`);
    } catch (e) {
        console.error('Registration lockdown trigger error:', e.message);
    }
}

module.exports = {
    LOCKDOWN_DURATION_MS,
    LOCKDOWN_INDEFINITE,
    isRegistrationLockdownIndefinite,
    LOCKDOWN_REG_MAX,
    LOCKDOWN_REG_WINDOW_MS,
    READ_ONLY_MESSAGE,
    checkRegistrationLockdownTrigger,
    getRegistrationBlockPage,
    getRegistrationLockdownLeftMs,
    isStaffUser,
    loadFullLockdown,
    loadReadOnlyMode,
    loadRegistrationGateSetting,
    loadRegistrationLockdown,
    registrationLockdownGuard,
    renderFullLockdownPage,
    setFullLockdown,
    setReadOnlyMode,
    setRegistrationGateEnabled,
    setRegistrationLockdown,
};

// Read through these getters so callers always see the current value.
Object.defineProperty(module.exports, 'readOnlyModeEnabled', { get: () => readOnlyModeEnabled, enumerable: true });
Object.defineProperty(module.exports, 'fullLockdownEnabled', { get: () => fullLockdownEnabled, enumerable: true });
Object.defineProperty(module.exports, 'registrationGateEnabled', { get: () => registrationGateEnabled, enumerable: true });
Object.defineProperty(module.exports, 'registrationLockdownUntil', { get: () => registrationLockdownUntil, enumerable: true });
