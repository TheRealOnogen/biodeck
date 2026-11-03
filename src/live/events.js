// Server-Sent Events buses and broadcast helpers.
const { EventEmitter } = require('events');
const { db } = require('../db/connection');
const { renderGCMessageBubble, renderMessageBubble } = require('../render/messages');
const {
    getGCMessageReactions,
    getMessageReactions,
    renderGCMsgReactionsHTML,
    renderMsgReactionsHTML,
} = require('../render/posts');

const dmBus = new EventEmitter();
dmBus.setMaxListeners(0);
const gcBus = new EventEmitter();
gcBus.setMaxListeners(0);

// Per-user event bus for real-time server-push notifications (e.g. ban events).
const userBus = new EventEmitter();
userBus.setMaxListeners(0);

// Tracks currently-open /api/user-events/stream connections along with the IP they connected from.
const userEventConnections = new Set();

function sseSend(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Who is currently LOOKING at a DM chat page.
const dmViewers = new Map(); // "viewer::other" -> Map(cid -> { visible })
function registerDMViewer(viewer, other, cid, visible) {
    const key = `${viewer}::${other}`;
    let conns = dmViewers.get(key);
    if (!conns) { conns = new Map(); dmViewers.set(key, conns); }
    const entry = { visible: !!visible };
    conns.set(cid, entry);
    return () => { // unregister (ignore if a newer connection reused this cid)
        const cur = dmViewers.get(key);
        if (!cur) return;
        if (cur.get(cid) === entry) cur.delete(cid);
        if (!cur.size) dmViewers.delete(key);
    };
}
function setDMViewerVisible(viewer, other, cid, visible) {
    const conns = dmViewers.get(`${viewer}::${other}`);
    const entry = conns && conns.get(cid);
    if (entry) entry.visible = !!visible;
}
function isViewingDMChat(viewer, other) {
    const conns = dmViewers.get(`${viewer}::${other}`);
    if (!conns) return false;
    for (const e of conns.values()) if (e.visible) return true;
    return false;
}

// Each viewer subscribes to their own "me::other" channel so we can render the message bubble from
// their point of view.
function broadcastDMMessage(fromUser, toUser, row, replyMsg) {
    dmBus.emit(`${fromUser}::${toUser}`, { event: 'message', html: renderMessageBubble(row, fromUser, replyMsg), id: row.id, from: fromUser });
    dmBus.emit(`${toUser}::${fromUser}`, { event: 'message', html: renderMessageBubble(row, toUser, replyMsg), id: row.id, from: fromUser });
}
function broadcastDMDelete(fromUser, toUser, msgId) {
    dmBus.emit(`${fromUser}::${toUser}`, { event: 'delete', id: msgId });
    dmBus.emit(`${toUser}::${fromUser}`, { event: 'delete', id: msgId });
}
function broadcastDMEdit(fromUser, toUser, row, replyMsg) {
    dmBus.emit(`${fromUser}::${toUser}`, { event: 'edit', html: renderMessageBubble(row, fromUser, replyMsg), id: row.id });
    dmBus.emit(`${toUser}::${fromUser}`, { event: 'edit', html: renderMessageBubble(row, toUser, replyMsg), id: row.id });
}

// Pushes an updated reaction-chip row for one message to both participants' open chat streams.
function broadcastDMReaction(fromUser, toUser, msgId) {
    dmBus.emit(`${fromUser}::${toUser}`, { event: 'reaction', id: msgId, html: renderMsgReactionsHTML(msgId, getMessageReactions(msgId, fromUser), fromUser) });
    dmBus.emit(`${toUser}::${fromUser}`, { event: 'reaction', id: msgId, html: renderMsgReactionsHTML(msgId, getMessageReactions(msgId, toUser), toUser) });
}

function broadcastGCMessage(groupId, fromUser, row, replyMsg, memberUsernames) {
    const htmlForSender = renderGCMessageBubble(row, fromUser, replyMsg);
    const htmlForOthers = renderGCMessageBubble(row, `\u0000${fromUser}`, replyMsg); // sentinel "me" that never matches a real username
    gcBus.emit(`${groupId}::${fromUser}`, { event: 'message', html: htmlForSender, id: row.id, from: fromUser });
    memberUsernames.filter(u => u !== fromUser).forEach(u => {
        gcBus.emit(`${groupId}::${u}`, { event: 'message', html: htmlForOthers, id: row.id, from: fromUser });
    });
}
function broadcastGCDelete(groupId, msgId, memberUsernames) {
    memberUsernames.forEach(u => {
        gcBus.emit(`${groupId}::${u}`, { event: 'delete', id: msgId });
    });
}
function broadcastGCEdit(groupId, fromUser, row, replyMsg, memberUsernames) {
    const htmlForSender = renderGCMessageBubble(row, fromUser, replyMsg);
    const htmlForOthers = renderGCMessageBubble(row, `\u0000${fromUser}`, replyMsg); // sentinel "me" that never matches a real username
    gcBus.emit(`${groupId}::${fromUser}`, { event: 'edit', html: htmlForSender, id: row.id });
    memberUsernames.filter(u => u !== fromUser).forEach(u => {
        gcBus.emit(`${groupId}::${u}`, { event: 'edit', html: htmlForOthers, id: row.id });
    });
}

// Unlike message/edit above, this can't use the sentinel-"me" shortcut - reaction highlighting is
// genuinely per-viewer.
function broadcastGCReaction(groupId, msgId, memberUsernames) {
    memberUsernames.forEach(u => {
        gcBus.emit(`${groupId}::${u}`, { event: 'reaction', id: msgId, html: renderGCMsgReactionsHTML(msgId, getGCMessageReactions(msgId, u), u) });
    });
}

// Posts a "so-and-so joined/left" notice as a message from the reserved 'System' sender.
function postSystemGCMessage(groupId, content) {
    db.run(`INSERT INTO Group_Chat_Messages (group_id, from_user, content) VALUES (?, 'System', ?)`,
        [groupId, content], function (err) {
            if (err) { console.error('System GC message insert error:', err.message); return; }
            const msgId = this.lastID;
            db.get(`SELECT Group_Chat_Messages.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified FROM Group_Chat_Messages LEFT JOIN User_Data ON Group_Chat_Messages.from_user = User_Data.username WHERE Group_Chat_Messages.id = ?`, [msgId], (errRow, row) => {
                if (errRow || !row) return;
                db.all(`SELECT username FROM Group_Chat_Members WHERE group_id = ?`, [groupId], (errMem, memberRows) => {
                    const members = (memberRows || []).map(r => r.username);
                    broadcastGCMessage(groupId, 'System', row, null, members);
                });
            });
        });
}

module.exports = {
    broadcastDMDelete,
    broadcastDMEdit,
    broadcastDMMessage,
    broadcastDMReaction,
    broadcastGCDelete,
    broadcastGCEdit,
    broadcastGCMessage,
    broadcastGCReaction,
    dmBus,
    gcBus,
    isViewingDMChat,
    postSystemGCMessage,
    registerDMViewer,
    setDMViewerVisible,
    sseSend,
    userBus,
    userEventConnections,
};
