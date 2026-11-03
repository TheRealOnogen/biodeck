// Account-spam auto-ban.
const { db, getStmt } = require('../db/connection');
const { sseSend, userEventConnections } = require('../live/events');
const { logAudit } = require('../moderation');

// Account-spam auto-ban
// If one IP tries to create SPAM_REG_MAX accounts inside SPAM_REG_WINDOW_MS, that IP is permanently
// added to IP_Bans.
const SPAM_REG_MAX = 3;
const SPAM_REG_WINDOW_MS = 20 * 1000;
const SPAM_REG_BAN_REASON = 'Stop spamming accounts, if you think this was an error contact an administrator';

// True if one more registration from `ip` right now would be the SPAM_REG_MAX-th inside the window.
function isRegistrationSpam(ip) {
    try {
        const since = Date.now() - SPAM_REG_WINDOW_MS;
        const row = getStmt(`SELECT COUNT(*) AS c FROM Registration_IPs WHERE ip = ? AND created_ts > ?`).get(ip, since);
        return ((row && row.c) || 0) + 1 >= SPAM_REG_MAX;
    } catch (e) {
        console.error('Registration spam check error:', e.message);
        return false; // a broken check must never lock people out of registering
    }
}

function banIPForSpam(ip, cb) {
    db.run(
        `INSERT INTO IP_Bans (ip, reason, banned_by) VALUES (?, ?, 'System')
         ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by, created_at = CURRENT_TIMESTAMP`,
        [ip, SPAM_REG_BAN_REASON],
        function (err) {
            if (err) { console.error('Auto IP ban error:', err.message); return cb(err); }
            logAudit('ip_banned', 'System', ip, `${SPAM_REG_BAN_REASON} (auto: ${SPAM_REG_MAX} accounts within ${SPAM_REG_WINDOW_MS / 1000}s)`);
            // Same live notice the admin ban sends: only sessions on this IP.
            userEventConnections.forEach(conn => {
                if (conn.ip === ip) sseSend(conn.res, 'banned', { event: 'banned', type: 'ip', reason: SPAM_REG_BAN_REASON });
            });
            cb(null);
        }
    );
}

module.exports = { SPAM_REG_BAN_REASON, banIPForSpam, isRegistrationSpam };
