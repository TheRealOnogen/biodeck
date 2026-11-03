// Client IP detection and login IP logging.
const { db } = require('../db/connection');
const { logAudit } = require('../moderation');

// SECURITY: the client IP must never come from a header the client can write.
const CLIENT_IP_HEADER = (process.env.CLIENT_IP_HEADER || '').trim().toLowerCase();
function normalizeIP(ip) {
    ip = String(ip || '').trim();
    if (ip.toLowerCase().startsWith('::ffff:') && ip.includes('.')) ip = ip.slice(7); // IPv4-mapped IPv6
    return ip || 'unknown';
}
function getClientIP(req) {
    if (CLIENT_IP_HEADER && req.headers[CLIENT_IP_HEADER]) {
        return normalizeIP(String(req.headers[CLIENT_IP_HEADER]).split(',')[0]);
    }
    return normalizeIP(req.ip || (req.socket && req.socket.remoteAddress));
}

// Records a login/register event in IP_Login_History and keeps User_Data.last_ip in sync.
function recordLoginIP(userId, username, ip, event) {
    if (!ip) return;
    db.get(`SELECT ip FROM IP_Login_History WHERE user_id = ? ORDER BY id DESC LIMIT 1`, [userId], (err, lastRow) => {
        const previousIP = !err && lastRow ? lastRow.ip : null;
        const changed = previousIP !== null && previousIP !== ip;
        db.run(`INSERT INTO IP_Login_History (user_id, username, ip, event, changed_from_previous) VALUES (?, ?, ?, ?, ?)`,
            [userId, username, ip, event || 'login', changed ? 1 : 0],
            (err2) => { if (err2) console.error('IP history insert error:', err2.message); });
        if (changed) {
            logAudit('ip_changed', username, username, `${previousIP} -> ${ip} (${event || 'login'})`);
        }
        db.run(`UPDATE User_Data SET last_ip = ? WHERE id = ?`, [ip, userId], () => {});
    });
}

module.exports = { getClientIP, recordLoginIP };
