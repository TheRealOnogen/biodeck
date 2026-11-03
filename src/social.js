// Blocks, notifications, system DMs and @mentions.
const { db, getStmt } = require('./db/connection');
const { broadcastDMMessage, isViewingDMChat } = require('./live/events');
const { MENTION_REGEX } = require('./render/markdown');

// Blocking
// User_Blocks(blocker, blocked).
function blockExists(blocker, blocked) {
    try {
        return !!getStmt(`SELECT 1 FROM User_Blocks WHERE blocker = ? AND blocked = ?`).get(blocker, blocked);
    } catch (e) {
        return false;
    }
}
function eitherBlocked(a, b) {
    return blockExists(a, b) || blockExists(b, a);
}

function createNotification({ username, type, actor_username, post_id = null, message_id = null, content_preview = null }) {
    if (!username || !actor_username || username === actor_username) return;
    if (blockExists(username, actor_username)) return; // recipient blocked the actor
    db.run(
        `INSERT INTO Notifications (username, type, actor_username, post_id, message_id, content_preview) VALUES (?, ?, ?, ?, ?, ?)`,
        [username, type, actor_username, post_id, message_id, content_preview],
        (err) => { if (err) console.error('Notification insert error:', err.message); }
    );
}

function getUnreadNotificationCount(username, cb) {
    if (!username) return cb(0);
    db.get(`SELECT COUNT(*) AS c FROM Notifications WHERE username = ? AND read = 0`, [username], (err, row) => {
        if (err || !row) return cb(0);
        cb(row.c || 0);
    });
}

// Sends a DM "from" the system.
function sendSystemDM(toUsername, content) {
    if (!toUsername || !content) return;
    db.run(`INSERT INTO Messages (from_user, to_user, content) VALUES ('System', ?, ?)`,
        [toUsername, content], function (err) {
            if (err) { console.error('System DM insert error:', err.message); return; }
            const newId = this.lastID;
            if (!isViewingDMChat(toUsername, 'System')) {
                createNotification({ username: toUsername, type: 'dm', actor_username: 'System', message_id: newId, content_preview: content.slice(0, 140) });
            }
            db.get(`SELECT Messages.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified FROM Messages LEFT JOIN User_Data ON Messages.from_user = User_Data.username WHERE Messages.id = ?`, [newId], (err2, row) => {
                if (err2 || !row) return;
                broadcastDMMessage('System', toUsername, row, null);
            });
        });
}
function processMentions(content, actorUsername, { type, post_id = null, message_id = null, skipUsernames = [] }) {
    if (!content) return;
    const skip = new Set([actorUsername.toLowerCase(), ...skipUsernames.map(u => u.toLowerCase())]);
    const found = new Set();
    let m;
    MENTION_REGEX.lastIndex = 0;
    while ((m = MENTION_REGEX.exec(content)) !== null) {
        const uname = m[1];
        if (skip.has(uname.toLowerCase())) continue;
        found.add(uname);
    }
    if (!found.size) return;
    const preview = content.trim().slice(0, 140);
    found.forEach(uname => {
        db.get(`SELECT username FROM User_Data WHERE username = ? COLLATE NOCASE`, [uname], (err, row) => {
            if (err || !row) return;
            createNotification({ username: row.username, type, actor_username: actorUsername, post_id, message_id, content_preview: preview });
        });
    });
}

module.exports = {
    blockExists,
    createNotification,
    eitherBlocked,
    getUnreadNotificationCount,
    processMentions,
    sendSystemDM,
};
