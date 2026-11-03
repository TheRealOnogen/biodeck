// Per-user event stream and ban status.
const { clearExpiredBan } = require('../admin/helpers');
const { app } = require('../app');
const { db } = require('../db/connection');
const { sseSend, userBus, userEventConnections } = require('../live/events');
const { getClientIP } = require('../security/ip');

// SSE stream for per-user server-push events.
app.get('/api/user-events/stream', (req, res) => {
    if (!req.session || !req.session.userId) return res.status(401).end();
    const userId = req.session.userId;
    const ip = getClientIP(req);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');

    const onEvent = (payload) => sseSend(res, payload.event, payload);
    userBus.on(`user:${userId}`, onEvent);

    const conn = { userId, ip, res };
    userEventConnections.add(conn);

    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);

    req.on('close', () => {
        clearInterval(keepAlive);
        userBus.removeListener(`user:${userId}`, onEvent);
        userEventConnections.delete(conn);
    });
});

// /api/check-ban-status is intentionally placed AFTER the ban middleware above.
app.get('/api/check-ban-status', (req, res) => {
    const ip = getClientIP(req);
    db.get(`SELECT reason FROM IP_Bans WHERE ip = ?`, [ip], (err, ipRow) => {
        if (!err && ipRow) {
            return res.json({ banned: true, type: 'ip', reason: ipRow.reason || 'No reason provided' });
        }
        if (!req.session || !req.session.userId) {
            return res.json({ banned: false });
        }
        db.get(`SELECT IsBanned, BanReason, BanExpiresAt, IsDeleted, DeleteReason FROM User_Data WHERE id = ?`, [req.session.userId], (err2, user) => {
            if (!err2 && user && user.IsDeleted == 1) {
                return res.json({ banned: true, type: 'deleted', reason: user.DeleteReason || 'No reason provided' });
            }
            if (!err2 && user && user.IsBanned == 1) {
                if (user.BanExpiresAt && new Date(user.BanExpiresAt).getTime() <= Date.now()) {
                    clearExpiredBan(req.session.userId);
                    return res.json({ banned: false });
                }
                return res.json({ banned: true, type: 'account', reason: user.BanReason || 'No reason provided', expiresAt: user.BanExpiresAt || null });
            }
            res.json({ banned: false });
        });
    });
});
