// WebSocket push: tells open pages when to refresh, so they don't have to poll.
const http = require('http');
const { WebSocketServer } = require('ws');
const { sessionMiddleware } = require('../session');
const { getClientIP } = require('../security/ip');

const socketsByUser = new Map(); // username -> Set of sockets
const allSockets = new Set();
const pending = new Map(); // debounce timers

function sendTo(sockets, type) {
    const msg = JSON.stringify({ t: type });
    for (const ws of sockets) if (ws.readyState === 1) ws.send(msg);
}

// Changes arriving in a burst become one refresh per page.
function debounced(key, fn) {
    if (pending.has(key)) return;
    pending.set(key, setTimeout(() => { pending.delete(key); fn(); }, 300));
}

// Tell every connected page that something of this type changed.
function broadcast(type) {
    debounced('*\0' + type, () => sendTo(allSockets, type));
}

// Tell one user's open pages (all tabs) that something changed.
function sendToUser(username, type) {
    if (!username || !socketsByUser.has(username)) return;
    debounced(username + '\0' + type, () => {
        const set = socketsByUser.get(username);
        if (set) sendTo(set, type);
    });
}

function reject(socket, status, text) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
}

function attachWebSocket(server) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

    server.on('upgrade', (req, socket, head) => {
        if ((req.url || '').split('?')[0] !== '/ws') return socket.destroy();

        // Browsers don't apply the same-origin policy to WebSockets, so check it here.
        const origin = req.headers.origin;
        if (origin) {
            let ok = false;
            try { ok = new URL(origin).host === req.headers.host; } catch (_) { /* bad origin */ }
            if (!ok) return reject(socket, 403, 'Forbidden');
        }

        // Reuse the normal session cookie to find out who is connecting.
        const res = new http.ServerResponse(req);
        sessionMiddleware(req, res, (err) => {
            const username = !err && req.session && req.session.userUsername;
            if (!username) return reject(socket, 401, 'Unauthorized');
            wss.handleUpgrade(req, socket, head, (ws) => {
                ws.isAlive = true;
                ws.on('pong', () => { ws.isAlive = true; });
                ws.on('error', () => {});
                allSockets.add(ws);
                if (!socketsByUser.has(username)) socketsByUser.set(username, new Set());
                socketsByUser.get(username).add(ws);
                ws.on('close', () => {
                    allSockets.delete(ws);
                    const set = socketsByUser.get(username);
                    if (set) { set.delete(ws); if (!set.size) socketsByUser.delete(username); }
                });
                console.log(`[${new Date().toISOString()}] ${getClientIP(req)} WS /ws 101 user=${username}`);
            });
        });
    });

    // Drop connections that stopped answering pings.
    setInterval(() => {
        for (const ws of allSockets) {
            if (!ws.isAlive) { ws.terminate(); continue; }
            ws.isAlive = false;
            ws.ping();
        }
    }, 30000).unref();
}

module.exports = { attachWebSocket, broadcast, sendToUser };
