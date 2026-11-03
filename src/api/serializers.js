// JSON serializers for /api/v1.
const path = require('path');
const { db, sqliteDb } = require('../db/connection');
const { loadCustomEmojis } = require('../emoji');
const { avatarPathToURL, displayName } = require('../render/html');
const { notifLink } = require('../render/notifications');
const { downloadUrlFor, getAttachments } = require('../uploads/files');

// /api/v1/* - structured JSON API for third-party/custom clients Everything above this point is
// Biodeck's own frontend.

function requireApiAuth(req, res, next) {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not logged in' });
    next();
}

function clampLimit(raw, def, max) {
    const n = parseInt(raw);
    if (!n || n < 1) return def;
    return Math.min(n, max);
}

// SQLite timestamp ("YYYY-MM-DD HH:MM:SS", UTC) -> ISO 8601 for the API layer.
function toISO(sqliteTimestamp) {
    return sqliteTimestamp ? sqliteTimestamp.replace(' ', 'T') + 'Z' : null;
}

function serializeAttachmentJSON(f) {
    return {
        url: `/uploads/${path.basename(f.path)}`,
        downloadUrl: downloadUrlFor(f),
        name: f.name || null
    };
}

function serializeAuthorJSON(username, nickname, avatarPath, isVerified) {
    return {
        username,
        nickname: nickname || null,
        displayName: displayName(username, nickname),
        avatarUrl: avatarPath ? avatarPathToURL(avatarPath) : null,
        verified: !!isVerified
    };
}

function serializePostJSON(post, sessionUsername, isAdmin, reactions) {
    return {
        id: post.id,
        author: serializeAuthorJSON(post.username, post.Nickname, post.avatar_path, post.IsVerified),
        content: post.content || '',
        createdAt: toISO(post.created_at),
        edited: !!post.edited,
        pinned: !!post.pinned,
        replyTo: post.reply_to || null,
        replyCount: post.reply_count || 0,
        attachments: getAttachments(post).map(serializeAttachmentJSON),
        viewerCanEdit: !!sessionUsername && post.username === sessionUsername,
        viewerCanDelete: !!sessionUsername && (post.username === sessionUsername || !!isAdmin),
        reactions: reactions || []
    };
}

// Reactions for a whole page of posts, DM messages or group chat messages in ONE query (not one per
// message).
const REACTION_TABLES = {
    post: { table: 'Reactions', idCol: 'post_id' },
    dm: { table: 'Message_Reactions', idCol: 'message_id' },
    gc: { table: 'Group_Chat_Message_Reactions', idCol: 'message_id' }
};
function fetchReactionsJSON(kind, messageIds, meUsername) {
    const byMessage = new Map();
    const spec = REACTION_TABLES[kind];
    if (!spec || !messageIds || !messageIds.length) return byMessage;
    const { table, idCol } = spec;
    let rows;
    try {
        const placeholders = messageIds.map(() => '?').join(',');
        rows = sqliteDb.prepare(
            `SELECT ${idCol} AS item_id, emoji, username FROM ${table} WHERE ${idCol} IN (${placeholders}) ORDER BY id ASC`
        ).all(...messageIds);
    } catch (e) {
        console.error('fetchReactionsJSON error:', e.message);
        return byMessage;
    }
    const customEmojis = loadCustomEmojis();
    rows.forEach(r => {
        let list = byMessage.get(r.item_id);
        if (!list) { list = []; byMessage.set(r.item_id, list); }
        let entry = list.find(x => x.emoji === r.emoji);
        if (!entry) {
            const m = /^:([A-Za-z0-9_-]{1,32}):$/.exec(r.emoji);
            const custom = m && customEmojis.get(m[1].toLowerCase());
            entry = { emoji: r.emoji, count: 0, mine: false, users: [], customEmojiUrl: custom ? custom.url : null };
            list.push(entry);
        }
        entry.count++;
        entry.users.push(r.username);
        if (r.username === meUsername) entry.mine = true;
    });
    return byMessage;
}

function serializeMessageJSON(m, meUsername, reactions) {
    return {
        id: m.id,
        author: serializeAuthorJSON(m.from_user, m.Nickname, m.avatar_path, m.IsVerified),
        toUser: m.to_user,
        content: m.content || '',
        createdAt: toISO(m.created_at),
        edited: !!m.edited,
        replyTo: m.reply_to || null,
        read: !!m.read,
        mine: m.from_user === meUsername,
        attachments: getAttachments(m).map(serializeAttachmentJSON),
        reactions: reactions || []
    };
}

function serializeGroupMessageJSON(m, meUsername, reactions) {
    return {
        id: m.id,
        groupId: m.group_id,
        author: serializeAuthorJSON(m.from_user, m.Nickname, m.avatar_path, m.IsVerified),
        content: m.content || '',
        createdAt: toISO(m.created_at),
        edited: !!m.edited,
        replyTo: m.reply_to || null,
        mine: m.from_user === meUsername,
        attachments: getAttachments(m).map(serializeAttachmentJSON),
        reactions: reactions || []
    };
}

function serializeNotificationJSON(n) {
    return {
        id: n.id,
        type: n.type,
        actor: {
            username: n.actor_username,
            nickname: n.actor_nickname || null,
            displayName: displayName(n.actor_username, n.actor_nickname),
            verified: !!n.actor_verified
        },
        postId: n.post_id || null,
        messageId: n.message_id || null,
        preview: n.content_preview || null,
        read: !!n.read,
        createdAt: toISO(n.created_at),
        link: notifLink(n)
    };
}

// Shared post query - same shape as the LEFT JOIN used throughout the HTML routes above (Posts +
// author info + reply_count).
function fetchPostsJSON(whereSQL, whereParams, limit, cb) {
    const sql = `SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified,
        (WITH RECURSIVE descendants(id) AS (SELECT id FROM Posts AS r WHERE r.reply_to = Posts.id UNION ALL SELECT p.id FROM Posts p JOIN descendants d ON p.reply_to = d.id) SELECT COUNT(*) FROM descendants) AS reply_count
        FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username
        ${whereSQL} ORDER BY Posts.created_at DESC LIMIT ?`;
    db.all(sql, [...whereParams, limit], cb);
}

module.exports = {
    REACTION_TABLES,
    clampLimit,
    fetchPostsJSON,
    fetchReactionsJSON,
    requireApiAuth,
    serializeGroupMessageJSON,
    serializeMessageJSON,
    serializeNotificationJSON,
    serializePostJSON,
    toISO,
};
