require('dotenv').config({ path: 'vars.env' });
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const bcrypt = require('bcrypt');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
let nodemailer;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }
const app = express();
const PORT = 3000;

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!req.session || !req.session.userId) return cb(new Error('Unauthorized'));
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const MAX_FILE_SIZE = 90 * 1024 * 1024;
const MAX_MSG_LENGTH = 4000;
const MAX_POST_LENGTH = 1000;
const MAX_BIO_LENGTH = 1000;

const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

// Multi-file upload limits: 5 attachments per post (feed/replies/following-feed),
// 10 per DM, 10 per group chat message. multer's limits.files enforces this
// server-side regardless of what the client sends.
const MAX_FILES_FEED = 5;
const MAX_FILES_DM = 10;
const MAX_FILES_GC = 10;
const uploadFeed = multer({ storage, limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES_FEED } });
const uploadDM = multer({ storage, limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES_DM } });
const uploadGC = multer({ storage, limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES_GC } });

const MSG_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];

const MAX_AVATAR_SIZE = 8 * 1024 * 1024;
const avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, `avatar-${req.session.userId}-${Date.now()}${path.extname(file.originalname).toLowerCase()}`)
});
const avatarUpload = multer({
    storage: avatarStorage,
    limits: { fileSize: MAX_AVATAR_SIZE },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (MSG_IMAGE_EXTS.includes(ext)) cb(null, true);
        else cb(new Error('Only image files are allowed for profile pictures'));
    }
});
// Same constraints as avatarUpload, but the filename is keyed off the target
// username in the route param (since these uploads come from an admin acting
// on someone else's profile, not the uploader's own session).
const adminAvatarStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, `avatar-${req.params.username}-${Date.now()}${path.extname(file.originalname).toLowerCase()}`)
});
const adminAvatarUpload = multer({
    storage: adminAvatarStorage,
    limits: { fileSize: MAX_AVATAR_SIZE },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (MSG_IMAGE_EXTS.includes(ext)) cb(null, true);
        else cb(new Error('Only image files are allowed for profile pictures'));
    }
});
const MSG_VIDEO_MIME_TYPES = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.ogv': 'video/ogg',
    '.ogg': 'video/ogg',
    '.mov': 'video/quicktime'
};

const MSG_AUDIO_MIME_TYPES = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.m4a': 'audio/mp4',
    '.opus': 'audio/opus',
    '.oga': 'audio/ogg'
};

// ----- Live messaging (Server-Sent Events) -----
// Real-time push for DMs and group chats. No polling, no extra deps -
// just a couple of in-process EventEmitters that fan out to open SSE streams.
const { EventEmitter } = require('events');
const dmBus = new EventEmitter();
dmBus.setMaxListeners(0);
const gcBus = new EventEmitter();
gcBus.setMaxListeners(0);
// Per-user event bus for real-time server-push notifications (e.g. ban events).
// Keyed by userId so the server can push to a specific user without any client polling.
const userBus = new EventEmitter();
userBus.setMaxListeners(0);
// Tracks currently-open /api/user-events/stream connections along with the
// IP they connected from, so an IP ban can be pushed only to sessions
// actually on that IP - not broadcast to every connected user.
const userEventConnections = new Set();

function sseSend(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Each viewer subscribes to their own "me::other" channel so we can render
// the message bubble from their point of view (alignment, delete link, etc)
// without leaking another user's perspective.
function broadcastDMMessage(fromUser, toUser, row, replyMsg) {
    dmBus.emit(`${fromUser}::${toUser}`, { event: 'message', html: renderMessageBubble(row, fromUser, replyMsg), id: row.id });
    dmBus.emit(`${toUser}::${fromUser}`, { event: 'message', html: renderMessageBubble(row, toUser, replyMsg), id: row.id });
}
function broadcastDMDelete(fromUser, toUser, msgId) {
    dmBus.emit(`${fromUser}::${toUser}`, { event: 'delete', id: msgId });
    dmBus.emit(`${toUser}::${fromUser}`, { event: 'delete', id: msgId });
}

function broadcastGCMessage(groupId, fromUser, row, replyMsg, memberUsernames) {
    const htmlForSender = renderGCMessageBubble(row, fromUser, replyMsg);
    const htmlForOthers = renderGCMessageBubble(row, `\u0000${fromUser}`, replyMsg); // sentinel "me" that never matches a real username
    gcBus.emit(`${groupId}::${fromUser}`, { event: 'message', html: htmlForSender, id: row.id });
    memberUsernames.filter(u => u !== fromUser).forEach(u => {
        gcBus.emit(`${groupId}::${u}`, { event: 'message', html: htmlForOthers, id: row.id });
    });
}
function broadcastGCDelete(groupId, msgId, memberUsernames) {
    memberUsernames.forEach(u => {
        gcBus.emit(`${groupId}::${u}`, { event: 'delete', id: msgId });
    });
}


const NOTIF_BADGE_SCRIPT = `<script>
(function() {
    function updateNotifBadges() {
        fetch('/notifications/count', { cache: 'no-store' })
            .then(function(r) { return r.json(); })
            .then(function(d) {
                var count = (d && d.count) || 0;
                var label = count + (count === 1 ? ' Notification' : ' Notifications');
                document.querySelectorAll('.notif-nav-link').forEach(function(el) {
                    el.textContent = label;
                    el.style.fontWeight = count > 0 ? '700' : '';
                    el.style.color = count > 0 ? 'rgb(0,191,255)' : '';
                });
                document.querySelectorAll('#nav-hamburger, #profile-nav-hamburger').forEach(function(btn) {
                    var dot = btn.querySelector('.notif-dot');
                    if (!dot) {
                        dot = document.createElement('span');
                        dot.className = 'notif-dot';
                        dot.style.cssText = 'position:absolute;top:-3px;right:-3px;width:9px;height:9px;border-radius:50%;background:rgb(0,191,255);pointer-events:none;';
                        if (getComputedStyle(btn).position === 'static') btn.style.position = 'relative';
                        btn.appendChild(dot);
                    }
                    dot.style.display = count > 0 ? 'block' : 'none';
                });
            })
            .catch(function() {});
    }
    updateNotifBadges();
    setInterval(updateNotifBadges, 8000);
})();
<\/script>`;

// Server-push ban enforcement. The server emits a 'banned' event down this SSE
// stream when an admin bans the user - no polling, nothing the client can fake.
const USER_EVENTS_SCRIPT = `<script>
(function() {
    var es = new EventSource('/api/user-events/stream');
    function handleEnforcement(e) {
        es.close();
        var d = {};
        try { d = JSON.parse(e.data); } catch(_) {}
        var reason = (d.reason || 'No reason provided').replace(/[<>&"']/g, function(c) {
            return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#x27;' }[c];
        });
        var inner;
        if (d.type === 'ip') {
            inner = '<h1>Your IP has been banned</h1><br>'
                + '<h3>Ban Reason: ' + reason + '</h3><br><br>'
                + '<p style=\\"opacity:0.6;font-size:0.9em;\\">If you believe this is a mistake, contact an administrator.</p>';
        } else if (d.type === 'deleted') {
            inner = '<h1>Your account has been deleted</h1><br>'
                + '<h3>Reason: ' + reason + '</h3><br><br>'
                + '<button type=\\"button\\" class=\\"button\\" style=\\"width:150px\\" onclick=\\"window.location.href=\\'/\\'\\">Go to homepage</button>';
        } else {
            inner = '<h1>The ban hammer has struck you</h1><br>'
                + '<h3>Ban Reason: ' + reason + '</h3><br><br>'
                + '<button type=\\"button\\" class=\\"button\\" style=\\"width:150px\\" onclick=\\"window.location.href=\\'/\\'\\">Go to homepage</button>';
        }
        document.body.innerHTML = '';
        document.body.style = '';
        var box = document.createElement('div');
        box.className = 'box';
        box.style.cssText = 'color:white;height:auto;width:500px;max-width:90vw;word-break:break-word;overflow-wrap:break-word;box-sizing:border-box;';
        box.innerHTML = inner;
        document.body.appendChild(box);
        // Re-attach button click animation since we wiped the DOM
        document.querySelectorAll('.button').forEach(function(btn) {
            btn.addEventListener('mousedown', function() {
                btn.classList.add('clicked');
                setTimeout(function() { btn.classList.remove('clicked'); }, 150);
            });
        });
    }
    es.addEventListener('banned', handleEnforcement);
    es.addEventListener('deleted', handleEnforcement);
    // If the stream closes unexpectedly and the server rejects reconnect (e.g. user
    // is now banned/deleted), navigating away will hit the server-side middleware anyway.
})();
<\/script>`;

function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

// Nicknames are display-only - pings, profile URLs, and logins always use
// the username. This just picks what to show: the nickname if set, else the
// username.
const MAX_NICKNAME_LENGTH = 32;
function displayName(username, nickname) {
    return (nickname && nickname.trim()) ? nickname.trim() : username;
}

// Renders "Nickname" with a smaller "@username" next to it when a nickname is
// set, or just "@username" when it isn't. `username` is used verbatim as the
// link target/handle (already expected to be a safe identifier); `nickname`
// is escaped since it's free-form user text.
function renderNameWithHandle(username, nickname, opts = {}) {
    const safeUsername = escapeHTML(username);
    const hasNickname = nickname && nickname.trim();
    if (!hasNickname) {
        return `<span style="${opts.nameStyle || ''}">@${safeUsername}</span>`;
    }
    const safeNickname = escapeHTML(nickname.trim());
    return `<span style="${opts.nameStyle || ''}">${safeNickname}</span><span style="opacity:0.5;font-size:0.85em;margin-left:5px;${opts.handleStyle || ''}">@${safeUsername}</span>`;
}

function renderEmbeds(text) {
    if (!text) return { embedHTML: '', cleanText: text };
    const urlRegex = /https?:\/\/[^\s<>"]+/g;
    const urls = text.match(urlRegex) || [];
    const embeds = [];
    const usedUrls = new Set();

    for (const url of urls) {
        if (usedUrls.has(url)) continue;

        const ytMatch = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
        if (ytMatch) {
            usedUrls.add(url);
            embeds.push(`<div style="margin-top:8px;"><iframe width="320" height="180" src="https://www.youtube.com/embed/${ytMatch[1]}" frameborder="0" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen style="border-radius:8px;max-width:100%;"></iframe></div>`);
            continue;
        }

        const spMatch = url.match(/open\.spotify\.com\/(track|album|playlist|episode|show)\/([A-Za-z0-9]+)/);
        if (spMatch) {
            usedUrls.add(url);
            embeds.push(`<div style="margin-top:8px;"><iframe src="https://open.spotify.com/embed/${spMatch[1]}/${spMatch[2]}" width="320" height="80" frameborder="0" allow="autoplay;clipboard-write;encrypted-media;fullscreen;picture-in-picture" loading="lazy" style="border-radius:12px;max-width:100%;"></iframe></div>`);
            continue;
        }

        if (/soundcloud\.com\/[^/]+\/[^/\s]+/.test(url)) {
            usedUrls.add(url);
            const encoded = encodeURIComponent(url);
            embeds.push(`<div style="margin-top:8px;"><iframe width="320" height="80" scrolling="no" frameborder="no" src="https://w.soundcloud.com/player/?url=${encoded}&color=%2300bfff&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false" style="border-radius:8px;max-width:100%;"></iframe></div>`);
            continue;
        }

        const imgurMatch = url.match(/imgur\.com\/(?:a\/|gallery\/)?([A-Za-z0-9]+)(?:\.[a-z]+)?$/i);
        if (imgurMatch) {
            usedUrls.add(url);
            if (/\.(jpg|jpeg|png|gif|webp|mp4|gifv)$/i.test(url)) {
                const imgUrl = url.replace(/\.gifv$/i, '.mp4');
                if (/\.mp4$/i.test(imgUrl)) {
                    embeds.push(`<div style="margin-top:8px;"><video autoplay loop muted playsinline style="max-width:320px;max-height:320px;border-radius:8px;display:block;"><source src="${imgUrl}" type="video/mp4"></video></div>`);
                } else {
                    embeds.push(`<div style="margin-top:8px;"><img src="${imgUrl}" style="max-width:320px;max-height:320px;border-radius:8px;display:block;" loading="lazy"></div>`);
                }
            } else {
                embeds.push(`<div style="margin-top:8px;"><blockquote class="imgur-embed-pub" lang="en" data-id="${imgurMatch[1]}" data-context="false"><a href="${escapeHTML(url)}">View on Imgur</a></blockquote><script async src="//s.imgur.com/min/embed.js" charset="utf-8"><\/script></div>`);
            }
            continue;
        }

        if (/\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i.test(url)) {
            usedUrls.add(url);
            embeds.push(`<div style="margin-top:8px;"><img src="${escapeHTML(url)}" style="max-width:320px;max-height:320px;border-radius:8px;display:block;" loading="lazy" onerror="this.parentElement.remove()"></div>`);
            continue;
        }

        if (/\.(mp4|webm|ogg|ogv|mov)(\?.*)?$/i.test(url)) {
            usedUrls.add(url);
            embeds.push(`<div style="margin-top:8px;"><video controls preload="metadata" style="max-width:320px;max-height:240px;border-radius:8px;display:block;background:black;"><source src="${escapeHTML(url)}">Your browser can't play this video. <a href="${escapeHTML(url)}" target="_blank" style="color:rgb(0,191,255);">Download</a></video></div>`);
            continue;
        }

        if (/\.(mp3|wav|flac|aac|m4a|opus|oga)(\?.*)?$/i.test(url)) {
            usedUrls.add(url);
            embeds.push(`<div style="margin-top:8px;"><audio controls preload="metadata" style="width:280px;max-width:100%;border-radius:8px;display:block;"><source src="${escapeHTML(url)}">Your browser can't play this audio. <a href="${escapeHTML(url)}" target="_blank" style="color:rgb(0,191,255);">Download</a></audio></div>`);
            continue;
        }
    }

    let cleanText = text;
    for (const u of usedUrls) {
        cleanText = cleanText.split(u).join('');
    }
    cleanText = cleanText.trim();

    return { embedHTML: embeds.join(''), cleanText };
}

function avatarPathToURL(avatarPath) {
    // Avatars uploaded by users live under public/uploads, but some avatars
    // (e.g. the default placeholder) live directly under public/ and are
    // served at the root, so they need different URL handling.
    const normalized = avatarPath.replace(/\\/g, '/');
    if (normalized.startsWith('public/')) {
        return `/${normalized.slice('public/'.length)}`;
    }
    return `/uploads/${path.basename(avatarPath)}`;
}

function renderAvatarHTML(avatarPath, username, size) {
    const initial = escapeHTML((username || '?').charAt(0).toUpperCase());
    if (avatarPath) {
        const url = avatarPathToURL(avatarPath);
        return `<img src="${url}" alt="${escapeHTML(username)}" style="width:${size}px;height:${size}px;min-width:${size}px;border-radius:50%;object-fit:cover;display:block;border:1px solid rgba(255,255,255,0.2);">`;
    }
    return `<div style="width:${size}px;height:${size}px;min-width:${size}px;border-radius:50%;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.2);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:${Math.round(size * 0.45)}px;">${initial}</div>`;
}

function renderMessageBubble(m, me, replyMsg) {
    const mine = m.from_user === me;
    const fileHTML = renderAttachmentsHTML(getAttachments(m), 260, '260px');
    const { embedHTML, cleanText } = renderEmbeds(m.content || '');
    const avatarHTML = renderAvatarHTML(m.avatar_path, m.from_user, 28);
    const senderHeader = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                <a href="/user/${escapeHTML(m.from_user)}" style="flex-shrink:0;">${avatarHTML}</a>
                <a href="/user/${escapeHTML(m.from_user)}" style="color:white;text-decoration:none;font-weight:bold;font-size:0.8em;">${renderNameWithHandle(m.from_user, m.Nickname)}</a>
            </div>`;
    const replyBanner = replyMsg
        ? `<div style="font-size:0.78em;opacity:0.6;border-left:3px solid white;padding-left:8px;margin-bottom:4px;">> replying to <strong>${escapeHTML(replyMsg.from_user)}</strong>: ${escapeHTML((replyMsg.content || '').substring(0,60))}${(replyMsg.content || '').length > 60 ? '...' : ''}</div>`
        : '';
    const deleteLink = mine ? `<a href="#" onclick="deleteMessage(${m.id});return false;" style="color:rgb(255,90,90);text-decoration:none;">Delete</a>` : '';
    return `<div class="chat-msg-row" data-id="${m.id}" style="display:flex;justify-content:${mine ? 'flex-end' : 'flex-start'};margin-bottom:10px;">
        <div style="max-width:70%;background:${mine ? 'rgba(0,191,255,0.15)' : 'rgba(255,255,255,0.08)'};border:1px solid ${mine ? 'rgba(0,191,255,0.4)' : 'rgba(255,255,255,0.2)'};border-radius:12px;padding:8px 12px;">
            ${senderHeader}
            ${replyBanner}
            <div style="word-break:break-word;overflow-wrap:break-word;white-space:pre-wrap;">${linkifyMentions(escapeHTML(cleanText))}</div>
            ${embedHTML}
            ${fileHTML}
            <div style="font-size:0.7em;opacity:0.5;margin-top:4px;display:flex;justify-content:flex-end;align-items:center;gap:10px;">
                <a href="#" onclick="setReply(${m.id}, '${escapeHTML(m.from_user)}');return false;" style="color:rgb(0,191,255);text-decoration:none;">Reply</a>
                ${deleteLink}
                <span data-ts="${m.created_at.replace(' ','T')+'Z'}"></span>
            </div>
        </div>
    </div>`;
}

// Pulls a normalized [{path,name}, ...] attachment list off a Post/Message/GC-Message
// row. Prefers the new multi-file files_json column; falls back to the legacy single
// file_path/file_name columns so old rows created before this feature still render.
function getAttachments(row) {
    if (row && row.files_json) {
        try {
            const arr = JSON.parse(row.files_json);
            if (Array.isArray(arr) && arr.length) return arr;
        } catch (e) {}
    }
    if (row && row.file_path) return [{ path: row.file_path, name: row.file_name }];
    return [];
}

// Renders one or more attachments. A single image renders full-size like before.
// Multiple images render as a grid capped at 3 columns wide (so 1-3 images is one
// row, 4+ wraps to additional rows of up to 3). Non-image files (video/audio/other)
// always render full-width below the image grid, one per row.
function renderAttachmentsHTML(files, maxHeight, maxWidth) {
    if (!files || !files.length) return '';
    maxWidth = maxWidth || 'min(100%,80vw)';
    const images = [];
    const others = [];
    files.forEach(f => {
        const ext = path.extname(f.name || '').toLowerCase();
        if (MSG_IMAGE_EXTS.includes(ext)) images.push(f); else others.push(f);
    });

    let html = '';
    if (images.length === 1) {
        const f = images[0];
        const url = `/uploads/${path.basename(f.path)}`;
        html += `<div class="post-file"><img src="${url}" alt="${escapeHTML(f.name || '')}" style="max-height:${maxHeight}px;max-width:${maxWidth};width:auto;height:auto;border-radius:10px;margin-top:8px;display:block;margin-left:auto;margin-right:auto;"></div>`;
    } else if (images.length > 1) {
        const cols = Math.min(3, images.length);
        const cells = images.map(f => {
            const url = `/uploads/${path.basename(f.path)}`;
            return `<a href="${url}" target="_blank" style="display:block;width:100%;aspect-ratio:1/1;overflow:hidden;border-radius:8px;"><img src="${url}" alt="${escapeHTML(f.name || '')}" style="width:100%;height:100%;object-fit:cover;display:block;"></a>`;
        }).join('');
        html += `<div class="post-file" style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px;margin-top:8px;max-width:${maxWidth};margin-left:auto;margin-right:auto;">${cells}</div>`;
    }

    others.forEach(f => {
        const ext = path.extname(f.name || '').toLowerCase();
        const url = `/uploads/${path.basename(f.path)}`;
        if (MSG_VIDEO_MIME_TYPES[ext]) {
            html += `<div class="post-file"><video controls preload="metadata" style="max-height:${maxHeight}px;max-width:${maxWidth};border-radius:10px;margin-top:8px;display:block;margin-left:auto;margin-right:auto;background:black;"><source src="${url}" type="${MSG_VIDEO_MIME_TYPES[ext]}">Your browser can't play this video. <a href="${url}" target="_blank" style="color:rgb(0,191,255);">Download it instead</a>.</video></div>`;
        } else if (MSG_AUDIO_MIME_TYPES[ext]) {
            html += `<div class="post-file"><audio controls preload="metadata" style="width:100%;max-width:${maxWidth === 'min(100%,80vw)' ? '400px' : maxWidth};border-radius:10px;margin-top:8px;display:block;margin-left:auto;margin-right:auto;"><source src="${url}" type="${MSG_AUDIO_MIME_TYPES[ext]}">Your browser can't play this audio. <a href="${url}" target="_blank" style="color:rgb(0,191,255);">Download it instead</a>.</audio></div>`;
        } else {
            html += `<div class="post-file"><a href="${url}" target="_blank">${escapeHTML(f.name)}</a></div>`;
        }
    });

    return html;
}

function createNotification({ username, type, actor_username, post_id = null, message_id = null, content_preview = null }) {
    if (!username || !actor_username || username === actor_username) return;
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

// Sends a DM "from" the system (from_user = 'System', which doesn't need to
// exist in User_Data - Messages has no FK on from_user/to_user). Used for
// automated notices like the activation ping.
function sendSystemDM(toUsername, content) {
    if (!toUsername || !content) return;
    db.run(`INSERT INTO Messages (from_user, to_user, content) VALUES ('System', ?, ?)`,
        [toUsername, content], function (err) {
            if (err) { console.error('System DM insert error:', err.message); return; }
            const newId = this.lastID;
            createNotification({ username: toUsername, type: 'dm', actor_username: 'System', message_id: newId, content_preview: content.slice(0, 140) });
            db.get(`SELECT Messages.*, User_Data.avatar_path, User_Data.Nickname FROM Messages LEFT JOIN User_Data ON Messages.from_user = User_Data.username WHERE Messages.id = ?`, [newId], (err2, row) => {
                if (err2 || !row) return;
                broadcastDMMessage('System', toUsername, row, null);
            });
        });
}

// Registration gate, toggleable from the admin dashboard.
// ON (default, matches legacy behavior): new accounts are created with
// IsBanned = 1 and admins get pinged (Activations group chat post + DMs) so
// someone can manually activate the account.
// OFF: registration is fully open - accounts are created active (IsBanned =
// 0) immediately, with no pings sent at all.
// Cached in memory (defaulting to true, i.e. current behavior) and backed by
// the Settings table so the choice survives restarts.
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

// Writes one row to the audit trail. actor is who performed the action
// ('System' for self-service events like registration); target is the
// affected username, if any. Fire-and-forget - a logging failure shouldn't
// break the action it's logging.
function logAudit(action, actor, target, details) {
    db.run(`INSERT INTO Audit_Log (action, actor, target, details) VALUES (?, ?, ?, ?)`,
        [action, actor || 'System', target || null, details || null],
        (err) => { if (err) console.error('Audit log insert error:', err.message); });
}

// Extra usernames to DM on every new registration, on top of the user with
// id 1. Local text file, single line, comma-separated, e.g.: Onogen,rtx
// Missing file just means "no extra targets" - not an error.
const ACTIVATION_PING_FILE = path.join(__dirname, 'activation-pings.txt');
function getActivationPingUsernames() {
    try {
        const raw = fs.readFileSync(ACTIVATION_PING_FILE, 'utf8');
        return raw.split(',').map(u => u.trim()).filter(Boolean);
    } catch (e) {
        return [];
    }
}

// Scans message/post content for @username pings and notifies each mentioned
// user that exists in User_Data (skips the author and anyone in skipUsernames,
// e.g. someone who already got a more specific notification like 'dm' or 'reply').
const MENTION_REGEX = /@([a-zA-Z0-9_]{1,32})/g;
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

// Wraps @username mentions in message/post text with a styled, clickable link.
// Operates on already-escaped HTML text (so it's safe against injection).
function linkifyMentions(escapedText) {
    if (!escapedText) return escapedText;
    return escapedText.replace(/(^|[\s>])@([a-zA-Z0-9_]{1,32})/g, (full, pre, uname) => {
        return `${pre}<a href="/user/${uname}" style="color:rgb(0,191,255);text-decoration:none;font-weight:600;">@${uname}</a>`;
    });
}

const NOTIF_ICONS = { reply: '>', dm: '>', friend_request: '+', friend_accept: '✓', friend_decline: '×', mention_post: '@', mention_dm: '@', mention_gc: '@' };

function notifText(n) {
    const actor = `<a href="/user/${escapeHTML(n.actor_username)}" style="color:white;font-weight:bold;text-decoration:none;">${escapeHTML(displayName(n.actor_username, n.actor_nickname))}</a>`;
    switch (n.type) {
        case 'reply': return `${actor} replied to your post`;
        case 'dm': return `${actor} sent you a message`;
        case 'friend_request': return `${actor} sent you a friend request`;
        case 'friend_accept': return `${actor} accepted your friend request`;
        case 'friend_decline': return `${actor} declined your friend request`;
        case 'mention_post': return `${actor} mentioned you in a post`;
        case 'mention_dm': return `${actor} mentioned you in a message`;
        case 'mention_gc': return `${actor} mentioned you in a group chat`;
        default: return `${actor} did something`;
    }
}

function notifLink(n) {
    if (n.type === 'reply' || n.type === 'mention_post') return `/post/${n.post_id}`;
    if (n.type === 'dm') return `/messages/${encodeURIComponent(n.actor_username)}`;
    if (n.type === 'mention_dm') return `/user/${encodeURIComponent(n.actor_username)}`;
    if (n.type === 'mention_gc') return `/groups/${n.post_id}`;
    if (n.type === 'friend_request' || n.type === 'friend_accept' || n.type === 'friend_decline') return `/friends`;
    return '#';
}

function renderNotificationItem(n) {
    const icon = NOTIF_ICONS[n.type] || '*';
    const preview = n.content_preview ? `<div style="opacity:0.6;font-size:0.85em;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(n.content_preview)}</div>` : '';
    const unreadDot = !n.read ? `<span style="width:8px;height:8px;border-radius:50%;background:rgb(0,191,255);flex-shrink:0;"></span>` : `<span style="width:8px;height:8px;flex-shrink:0;"></span>`;
    return `<div class="notif-item" data-id="${n.id}" data-href="${notifLink(n)}" style="display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:white;cursor:pointer;margin-bottom:10px;background:${n.read ? 'transparent' : 'rgba(0,191,255,0.06)'};">
        ${unreadDot}
        <span style="font-size:1.1em;flex-shrink:0;">${icon}</span>
        <div style="flex:1;min-width:0;">
            <div>${notifText(n)}</div>
            ${preview}
            <span style="font-size:0.75em;opacity:0.5;" data-ts="${n.created_at.replace(' ','T')+'Z'}"></span>
        </div>
    </div>`;
}

function renderFeedPost(post, sessionUsername, fileMaxHeight, isAdmin) {
    const fileHTML = renderAttachmentsHTML(getAttachments(post), fileMaxHeight);
    const isOwner = post.username === sessionUsername;
    const canDelete = isOwner || isAdmin;
    const deleteBtn = canDelete ? `<button class="button post-action-btn" onclick="deletePost(${post.id})">Delete${(!isOwner && isAdmin) ? ' (Admin)' : ''}</button>` : '';
    const pinBtn = isAdmin ? `<button class="button post-action-btn" onclick="${post.pinned ? `unpinPost(${post.id})` : `pinPost(${post.id})`}">${post.pinned ? 'Unpin' : 'Pin'}</button>` : '';
    const safeUsername = escapeHTML(post.username);
    const { embedHTML, cleanText } = renderEmbeds(post.content || '');
    const safeContent = escapeHTML(cleanText);
    const avatarHTML = renderAvatarHTML(post.avatar_path, post.username, 32);
    return `<div class="post-header" style="display:flex;align-items:flex-start;gap:8px;">
            <a href="/user/${safeUsername}" style="flex-shrink:0;">${avatarHTML}</a>
            <div style="display:flex;flex-direction:column;min-width:0;">
                <a href="/user/${safeUsername}" style="color:white;text-decoration:none;font-weight:bold;">${renderNameWithHandle(post.username, post.Nickname)}</a>
                <span class="post-time" data-ts="${post.created_at.replace(' ', 'T') + 'Z'}" style="font-size:0.8em;opacity:0.6;"></span>
            </div>
        </div>
        <div class="post-content" style="word-break:break-word;overflow-wrap:break-word;white-space:pre-wrap;">${linkifyMentions(safeContent)}</div>
        ${embedHTML}
        ${fileHTML}
        <div class="post-actions">
            <a href="/post/${post.id}" class="button post-action-btn reply-count-btn" data-post-id="${post.id}" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center;">${(post.reply_count || 0)} Replies</a>
            ${pinBtn}
            ${deleteBtn}
        </div>`;
}

function renderPinnedItem(post) {
    const safeUsername = escapeHTML(post.username);
    const safeContent = escapeHTML((post.content || '').trim());
    const preview = safeContent.length > 140 ? safeContent.slice(0, 140) + '…' : safeContent;
    const previewHTML = preview || '<span style="opacity:0.5;">(attachment)</span>';
    return `<div class="pinned-item" data-pin-id="${post.id}" style="display:flex;align-items:center;gap:10px;padding:8px 16px;background:rgba(255,180,40,0.08);border-bottom:1px solid rgba(255,180,40,0.25);">
        <span style="font-size:0.7em;letter-spacing:0.08em;color:rgb(255,180,40);font-weight:700;text-transform:uppercase;flex-shrink:0;">Pinned</span>
        <a href="/user/${safeUsername}" style="color:white;text-decoration:none;font-weight:bold;flex-shrink:0;">${escapeHTML(displayName(post.username, post.Nickname))}</a>
        <span style="opacity:0.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;">${previewHTML}</span>
        <a href="#" onclick="dismissPin(${post.id});return false;" title="Hide this pin" style="color:rgba(255,255,255,0.6);text-decoration:none;font-weight:700;flex-shrink:0;padding:0 4px;">✕</a>
    </div>`;
}

function buildPostListHTML(posts, sessionUsername, fileMaxHeight, isAdmin) {
    return posts.map(post => `
        <div class="post" id="post-${post.id}">
            ${renderFeedPost(post, sessionUsername, fileMaxHeight, isAdmin)}
        </div><br>`).join('');
}

function buildFeedHTML(posts, sessionUsername, fileMaxHeight, isAdmin) {
    const roots = posts.filter(p => !p.reply_to);
    return buildPostListHTML(roots, sessionUsername, fileMaxHeight, isAdmin);
}



const db = new sqlite3.Database('./data.db', (err) => {
    if (err) console.error('Database connection error :', err.message);
    else {
        console.log('Connected to database');
        db.run(`PRAGMA journal_mode=WAL`, (err) => {
            if (err) console.error('WAL error:', err.message);
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS User_Data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE,
                password TEXT,
                IsBanned INTEGER DEFAULT 0,
                BanReason TEXT DEFAULT NULL,
                bio TEXT DEFAULT NULL
            )`);
            db.run(`ALTER TABLE User_Data ADD COLUMN bio TEXT DEFAULT NULL`, () => {});
            db.run(`CREATE TABLE IF NOT EXISTS Messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_user TEXT,
                to_user TEXT,
                content TEXT,
                file_path TEXT DEFAULT NULL,
                file_name TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                read INTEGER DEFAULT 0
            )`);
            db.run(`ALTER TABLE Messages ADD COLUMN file_path TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE Messages ADD COLUMN file_name TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE Messages ADD COLUMN files_json TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE Messages ADD COLUMN reply_to INTEGER DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN IsOwner INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN IsDeveloper INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN IsSupporter INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN IsAdmin INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN IsHeadAdmin INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN avatar_path TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN Nickname TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN IsDeleted INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN DeleteReason TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN email TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN email_verified INTEGER DEFAULT 0`, () => {});
            // Multiple accounts are now allowed to share the same email address,
            // so this is a plain (non-unique) index, kept only for lookup speed.
            // If an older database still has the unique index from before, drop
            // it first so shared emails aren't rejected.
            db.run(`DROP INDEX IF EXISTS idx_user_data_email`, () => {
                db.run(`CREATE INDEX IF NOT EXISTS idx_user_data_email ON User_Data(email)`);
            });
            // Password reset tokens. Only the sha256 hash of the token is stored,
            // so a database leak alone can't be used to reset anyone's password.
            db.run(`CREATE TABLE IF NOT EXISTS Password_Resets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT UNIQUE NOT NULL,
                expires_at DATETIME NOT NULL,
                used INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_password_resets_user ON Password_Resets(user_id)`);
            // Self-service email change requests. A code is emailed to the
            // ACCOUNT'S CURRENT email (proving the requester still controls
            // it) and must be entered along with the new address to
            // complete the change. Only the sha256 hash of the code is
            // stored, same pattern as Password_Resets.
            db.run(`CREATE TABLE IF NOT EXISTS Email_Changes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                code_hash TEXT NOT NULL,
                new_email TEXT NOT NULL,
                expires_at DATETIME NOT NULL,
                used INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_email_changes_user ON Email_Changes(user_id)`);
            // Email verification links. token_hash is a sha256 of the raw token
            // that goes out in the emailed link, same pattern as Password_Resets.
            // `email` freezes which address the token is good for, so if the
            // account's email changes after a link is sent, the old link can't
            // silently verify the new address.
            db.run(`CREATE TABLE IF NOT EXISTS Email_Verifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT UNIQUE NOT NULL,
                email TEXT NOT NULL,
                expires_at DATETIME NOT NULL,
                used INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON Email_Verifications(user_id)`);
            db.run(`CREATE TABLE IF NOT EXISTS Posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                username TEXT,
                content TEXT,
                file_path TEXT DEFAULT NULL,
                file_name TEXT DEFAULT NULL,
                reply_to INTEGER DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`ALTER TABLE Posts ADD COLUMN reply_to INTEGER DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE Posts ADD COLUMN pinned INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE Posts ADD COLUMN files_json TEXT DEFAULT NULL`, () => {});
            db.run(`CREATE TABLE IF NOT EXISTS Follows (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                follower_username TEXT NOT NULL,
                following_username TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(follower_username, following_username)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS IP_Bans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ip TEXT UNIQUE NOT NULL,
                reason TEXT DEFAULT NULL,
                banned_by TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`ALTER TABLE User_Data ADD COLUMN last_ip TEXT DEFAULT NULL`, () => {});
            db.run(`CREATE TABLE IF NOT EXISTS Friend_Requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_user TEXT NOT NULL,
                to_user TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(from_user, to_user)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS Friends (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_a TEXT NOT NULL,
                user_b TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_a, user_b)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS Notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                type TEXT NOT NULL,
                actor_username TEXT NOT NULL,
                post_id INTEGER DEFAULT NULL,
                message_id INTEGER DEFAULT NULL,
                content_preview TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                read INTEGER DEFAULT 0
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_username ON Notifications(username)`);
            db.run(`CREATE TABLE IF NOT EXISTS Group_Chats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_by TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS Group_Chat_Members (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(group_id, username)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS Group_Chat_Messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                from_user TEXT NOT NULL,
                content TEXT,
                file_path TEXT DEFAULT NULL,
                file_name TEXT DEFAULT NULL,
                reply_to INTEGER DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`ALTER TABLE Group_Chat_Messages ADD COLUMN files_json TEXT DEFAULT NULL`, () => {});
            // Generic key/value store for small admin-configurable settings
            // (e.g. the registration gate toggle below).
            db.run(`CREATE TABLE IF NOT EXISTS Settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )`, () => { loadRegistrationGateSetting(); });
            // Audit trail for admin-facing/account-lifecycle events (account
            // created/banned/unbanned/deleted, registration gate toggled, etc).
            // actor is who performed the action ('System' for self-service
            // events like registration), target is the affected username (if
            // any).
            db.run(`CREATE TABLE IF NOT EXISTS Audit_Log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL,
                actor TEXT NOT NULL,
                target TEXT DEFAULT NULL,
                details TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            // Group id 1 is reserved as the system "activations" log - new account
            // notices get posted there. INSERT OR IGNORE so this is a no-op after
            // the first boot (and safe if it already exists from an older db).
            db.run(`INSERT OR IGNORE INTO Group_Chats (id, name, created_by) VALUES (1, 'Activations', 'System')`, (err) => {
                if (err) console.error('Failed to reserve group id 1:', err.message);
            });
        });
        });
    }
});

app.use(express.urlencoded({extended:true}))
app.use(express.json())

app.use(express.static(path.join(__dirname, 'public')));

const SESSION_SECRET_PATH = path.join(__dirname, '.session-secret');
function loadOrCreateSessionSecret() {
    if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
    try {
        return fs.readFileSync(SESSION_SECRET_PATH, 'utf8').trim();
    } catch (e) {
        const secret = require('crypto').randomBytes(64).toString('hex');
        try { fs.writeFileSync(SESSION_SECRET_PATH, secret, { mode: 0o600 }); } catch (e2) {
            console.error('Could not persist session secret, sessions will reset on restart:', e2.message);
        }
        return secret;
    }
}
const SESSION_SECRET = loadOrCreateSessionSecret();

const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

app.use(session({
    store: new FileStore({ path: sessionsDir, ttl: 7 * 24 * 60 * 60, retries: 1, logFn: function () {} }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}))

function getClientIP(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress || req.ip || 'unknown';
}

function checkIPBan(req, res, next) {
    const ip = getClientIP(req);
    db.get(`SELECT reason FROM IP_Bans WHERE ip = ?`, [ip], (err, row) => {
        if (err || !row) return next();
        const reason = escapeHTML(row.reason || 'No reason provided');
        return res.status(403).send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Banned</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
    <div class="box" style="color: white; height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box;">
        <h1>Your IP has been banned</h1><br>
        <h3>Ban Reason: ${reason}</h3><br><br>
        <p style="opacity:0.6;font-size:0.9em;">If you believe this is a mistake, contact an administrator.</p>
    </div>
</body>
</html>`);
    });
}

function checkBan(req, res, next) {
    if (!req.session.userId) return next();

    db.get(`SELECT IsBanned, BanReason, IsDeleted, DeleteReason, IsAdmin, IsOwner, IsHeadAdmin FROM User_Data WHERE id = ?`, [req.session.userId], (err, user) => {
        if (err) return next();
        // No row at all means the account was permanently deleted (hard
        // delete removes the row entirely, unlike the soft delete which
        // keeps it with IsDeleted = 1). Treat it the same way as a soft
        // delete for any session that's still logged in elsewhere.
        if (!user) {
            req.session.destroy(() => {
                res.clearCookie('connect.sid');
                return res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Account Deleted</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
    <div class="box" style="color: white; height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box;">
        <h1>Your account has been deleted</h1><br>
        <button type="submit" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>
    </div>
</body>
</html>`);
            });
            return;
        }
        req.isAdmin = !!(user.IsAdmin || user.IsOwner || user.IsHeadAdmin);
        req.isHeadAdmin = !!(user.IsHeadAdmin || user.IsOwner);
        if (user.IsDeleted == 1) {
            const reason = escapeHTML(user.DeleteReason || 'No reason provided');
            req.session.destroy(() => {
                res.clearCookie('connect.sid');
                return res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Account Deleted</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
    <div class="box" style="color: white; height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box;">
        <h1>Your account has been deleted</h1><br>
        <h3>Reason: ${reason}</h3><br><br>
        <button type="submit" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>
    </div>
</body>
</html>`);
            });
        } else if (user.IsBanned == 1) {
            const reason = escapeHTML(user.BanReason || 'No reason provided');
            req.session.destroy(() => {
                res.clearCookie('connect.sid');
                return res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Banned</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
    <div class="box" style="color: white; height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box;">
        <h1>The ban hammer has struck you</h1><br>
        <h3>Ban Reason: ${reason}</h3><br><br>
        <button type="submit" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>
    </div>
</body>
</html>`);
            });
        } else {
            next();
        }
    });
}

// ----- Password reset email -----
// Configure via environment variables:
//   SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE ('true'/'false'), SMTP_USER, SMTP_PASS, SMTP_FROM
//   APP_BASE_URL - the public URL of this app, e.g. https://biodeck.example.com
// If SMTP isn't configured, reset links are logged to the console instead of
// emailed, so this still works out of the box in dev.
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let mailTransporter = null;
if (nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    mailTransporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
} else if (!nodemailer) {
    console.warn('nodemailer is not installed (run `npm install nodemailer`) - password reset emails will be logged to the console instead of sent.');
} else {
    console.warn('SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS) - password reset emails will be logged to the console instead of sent.');
}

function sendPasswordResetEmail(toEmail, username, resetLink) {
    const subject = 'Reset your Biodeck password';
    const text = `Hi ${username},\n\nA password reset was requested for your Biodeck account. If this was you, click the link below to choose a new password. This link expires in 1 hour and can only be used once.\n\n${resetLink}\n\nIf you didn't request this, you can safely ignore this email - your password will not change.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>A password reset was requested for your Biodeck account. If this was you, click the link below to choose a new password. This link expires in 1 hour and can only be used once.</p><p><a href="${resetLink}">${resetLink}</a></p><p>If you didn't request this, you can safely ignore this email - your password will not change.</p>`;

    if (!mailTransporter) {
        console.log(`[password reset] SMTP not configured - link for ${toEmail}: ${resetLink}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send password reset email:', err.message));
}

// Returns { raw, hash }. Only `hash` (sha256 of raw) is stored in the DB;
// `raw` is the value that goes in the emailed link and is never persisted.
function generateResetToken() {
    const raw = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    return { raw, hash };
}
function hashResetToken(raw) {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

// ----- Email change verification codes -----
const EMAIL_CHANGE_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Returns { code, hash }. 6-digit numeric code, easy to type/read; only the
// sha256 hash is persisted, same pattern as password reset tokens.
function generateEmailChangeCode() {
    const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
    const hash = crypto.createHash('sha256').update(code).digest('hex');
    return { code, hash };
}
function hashEmailChangeCode(code) {
    return crypto.createHash('sha256').update(code).digest('hex');
}

function sendEmailChangeCodeEmail(toEmail, username, code, newEmail) {
    const subject = 'Confirm your Biodeck email change';
    const text = `Hi ${username},\n\nA request was made to change the email on your Biodeck account from this address to ${newEmail}. Enter this code on the dashboard to confirm the change. This code expires in 15 minutes and can only be used once.\n\nCode: ${code}\n\nIf you didn't request this, you can safely ignore this email - your email will not change.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>A request was made to change the email on your Biodeck account from this address to ${escapeHTML(newEmail)}. Enter this code on the dashboard to confirm the change. This code expires in 15 minutes and can only be used once.</p><p style="font-size:1.4em;font-weight:700;letter-spacing:2px;">${escapeHTML(code)}</p><p>If you didn't request this, you can safely ignore this email - your email will not change.</p>`;

    if (!mailTransporter) {
        console.log(`[email change] SMTP not configured - code for ${toEmail} (-> ${newEmail}): ${code}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send email change code:', err.message));
}

// ----- Email verification links -----
const EMAIL_VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const EMAIL_VERIFY_RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute, tracked in-memory below

// Returns { raw, hash }, same pattern as generateResetToken().
function generateEmailVerifyToken() {
    const raw = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    return { raw, hash };
}
function hashEmailVerifyToken(raw) {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

function sendVerifyEmail(toEmail, username, verifyLink) {
    const subject = 'Verify your Biodeck email address';
    const text = `Hi ${username},\n\nPlease confirm this is your email address by clicking the link below. This link expires in 24 hours and can only be used once.\n\n${verifyLink}\n\nIf you didn't create a Biodeck account, you can safely ignore this email.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>Please confirm this is your email address by clicking the link below. This link expires in 24 hours and can only be used once.</p><p><a href="${verifyLink}">${verifyLink}</a></p><p>If you didn't create a Biodeck account, you can safely ignore this email.</p>`;

    if (!mailTransporter) {
        console.log(`[email verify] SMTP not configured - link for ${toEmail}: ${verifyLink}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send verification email:', err.message));
}

// ----- Account moderation emails (ban / unban / delete / permanent delete) -----
function sendAccountBannedEmail(toEmail, username, reason) {
    const subject = 'Your Biodeck account has been banned';
    const cleanReason = reason || 'No reason provided';
    const text = `Hi ${username},\n\nYour Biodeck account has been banned.\n\nReason: ${cleanReason}\n\nIf you believe this is a mistake, contact an administrator.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>Your Biodeck account has been banned.</p><p><strong>Reason:</strong> ${escapeHTML(cleanReason)}</p><p>If you believe this is a mistake, contact an administrator.</p>`;

    if (!mailTransporter) {
        console.log(`[account banned] SMTP not configured - would have emailed ${toEmail}: ${cleanReason}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send account banned email:', err.message));
}

function sendAccountUnbannedEmail(toEmail, username) {
    const subject = 'Your Biodeck account has been unbanned';
    const text = `Hi ${username},\n\nYour Biodeck account has been unbanned. You can log back in whenever you're ready.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>Your Biodeck account has been unbanned. You can log back in whenever you're ready.</p>`;

    if (!mailTransporter) {
        console.log(`[account unbanned] SMTP not configured - would have emailed ${toEmail}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send account unbanned email:', err.message));
}

// Sent for the soft delete (admin resets the profile and marks IsDeleted, but
// the row and username are kept).
function sendAccountDeletedEmail(toEmail, username, reason) {
    const subject = 'Your Biodeck account has been deleted';
    const cleanReason = reason || 'No reason provided';
    const text = `Hi ${username},\n\nYour Biodeck account has been deleted by an administrator. Your posts have been removed and your profile has been reset.\n\nReason: ${cleanReason}\n\nIf you believe this is a mistake, contact an administrator.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>Your Biodeck account has been deleted by an administrator. Your posts have been removed and your profile has been reset.</p><p><strong>Reason:</strong> ${escapeHTML(cleanReason)}</p><p>If you believe this is a mistake, contact an administrator.</p>`;

    if (!mailTransporter) {
        console.log(`[account deleted] SMTP not configured - would have emailed ${toEmail}: ${cleanReason}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send account deleted email:', err.message));
}

// Sent for the hard delete - covers both the admin "Delete From Database"
// action and a user deleting their own account, since the outcome (account
// and all its data permanently gone) is the same either way.
function sendAccountPermanentlyDeletedEmail(toEmail, username, reason) {
    const subject = 'Your Biodeck account has been permanently deleted';
    const cleanReason = reason || 'No reason provided';
    const text = `Hi ${username},\n\nYour Biodeck account and all of its data (posts, messages, group chats, follows, friends, and notifications) have been permanently deleted. This cannot be undone.\n\nReason: ${cleanReason}\n\nIf you believe this is a mistake, contact an administrator.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>Your Biodeck account and all of its data (posts, messages, group chats, follows, friends, and notifications) have been permanently deleted. This cannot be undone.</p><p><strong>Reason:</strong> ${escapeHTML(cleanReason)}</p><p>If you believe this is a mistake, contact an administrator.</p>`;

    if (!mailTransporter) {
        console.log(`[account permanently deleted] SMTP not configured - would have emailed ${toEmail}: ${cleanReason}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send account permanently deleted email:', err.message));
}

// Invalidates any outstanding verification links for the user, creates a new
// one for `email`, and sends it. Callers should have already set
// email_verified = 0 on the account before calling this.
function issueEmailVerification(userId, username, email, callback) {
    db.run(`UPDATE Email_Verifications SET used = 1 WHERE user_id = ? AND used = 0`, [userId], () => {
        const { raw, hash } = generateEmailVerifyToken();
        const expiresAt = new Date(Date.now() + EMAIL_VERIFY_TOKEN_TTL_MS).toISOString();
        db.run(`INSERT INTO Email_Verifications (user_id, token_hash, email, expires_at) VALUES (?, ?, ?, ?)`,
            [userId, hash, email, expiresAt], (err) => {
                if (err) { console.error('Email verification insert error:', err.message); if (callback) callback(err); return; }
                const verifyLink = `${APP_BASE_URL}/account/verify-email?token=${raw}`;
                sendVerifyEmail(email, username, verifyLink);
                if (callback) callback(null);
            });
    });
}

// Renders the same box/button chrome used elsewhere (ban/deleted screens, etc.)
function renderMessagePage(title, heading, bodyHTML) {
    return `<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHTML(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
    <div class="box" style="color: white; height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box; padding: 30px;">
        <h1>${escapeHTML(heading)}</h1><br>
        ${bodyHTML}
    </div>
    <script>
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => {
                btn.classList.add('clicked');
                setTimeout(() => btn.classList.remove('clicked'), 150);
            });
        });
    </script>
</body>
</html>`;
}

// Blocks any fully-logged-in session whose email hasn't been verified yet,
// bouncing it to the verify-email hold page. Mirrors checkBan's approach of
// gating every request rather than just the login route, so an account can't
// dodge verification by jumping straight to a bookmarked page.
function checkEmailVerified(req, res, next) {
    if (!req.session.userId) return next();
    // Let the verification flow itself, and logging out, stay reachable.
    if (req.path === '/account/verify-email' || req.path.startsWith('/account/verify-email-required') || req.path === '/logout') {
        return next();
    }
    db.get(`SELECT email, email_verified FROM User_Data WHERE id = ?`, [req.session.userId], (err, user) => {
        if (err || !user) return next();
        if (user.email && !user.email_verified) {
            const userId = req.session.userId;
            const username = req.session.userUsername;
            req.session.pendingVerifyUserId = userId;
            req.session.pendingVerifyUsername = username;
            delete req.session.userId;
            delete req.session.userUsername;
            return res.redirect('/account/verify-email-required');
        }
        next();
    });
}

app.use(checkIPBan);
app.use(checkBan);
app.use(checkEmailVerified);

// SSE stream for per-user server-push events (ban notifications, etc.)
// Only reachable by non-banned users because checkIPBan/checkBan run first.
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
// This means banned users are blocked before they can reach this endpoint -
// preventing the bypass where a client fakes the response to avoid the ban screen.
app.get('/api/check-ban-status', (req, res) => {
    const ip = getClientIP(req);
    db.get(`SELECT reason FROM IP_Bans WHERE ip = ?`, [ip], (err, ipRow) => {
        if (!err && ipRow) {
            return res.json({ banned: true, type: 'ip', reason: ipRow.reason || 'No reason provided' });
        }
        if (!req.session || !req.session.userId) {
            return res.json({ banned: false });
        }
        db.get(`SELECT IsBanned, BanReason, IsDeleted, DeleteReason FROM User_Data WHERE id = ?`, [req.session.userId], (err2, user) => {
            if (!err2 && user && user.IsDeleted == 1) {
                return res.json({ banned: true, type: 'deleted', reason: user.DeleteReason || 'No reason provided' });
            }
            if (!err2 && user && user.IsBanned == 1) {
                return res.json({ banned: true, type: 'account', reason: user.BanReason || 'No reason provided' });
            }
            res.json({ banned: false });
        });
    });
});

app.get('/register', (req, res) => {
    if (req.session.userId) return res.redirect('/feed');
    res.sendFile(path.join(__dirname, 'register.html'));
})

app.get('/', (req, res) => {
    if (req.session.userId) return res.redirect('/feed');
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    const email = (req.body.email || '').trim().toLowerCase();

    if (!username || !password) {
        return res.sendFile(path.join(__dirname, 'register_error_missing_fields.html'));
    }
    if (username.length < 3 || username.length > 32) {
        return res.sendFile(path.join(__dirname, 'register_error_invalid_length.html'));
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
        return res.sendFile(path.join(__dirname, 'register_error_invalid_chars.html'));
    }
    if (!email) {
        return res.status(400).send(renderMessagePage('Missing Email', 'An email address is required',
            `<h3>Every account needs an email so you can reset your password later.</h3><br><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/register';">Go back</button>`));
    }
    if (!EMAIL_REGEX.test(email)) {
        return res.status(400).send(renderMessagePage('Invalid Email', 'That doesn\'t look like a valid email',
            `<h3>Please double check the email address and try again.</h3><br><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/register';">Go back</button>`));
    }
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const gateEnabled = registrationGateEnabled;
        const initialIsBanned = gateEnabled ? 1 : 0;
        const initialBanReason = gateEnabled
            ? "Account creation is currently disabled, please contact therealonogen or rtx3080ti0415 on discord to activate your account, a message was also sent to admins"
            : null;

        db.run(`INSERT INTO User_Data (username, password, email, email_verified, IsBanned, BanReason, avatar_path) VALUES (?, ?, ?, 0, ?, ?, ?)`, [username, hashedPassword, email, initialIsBanned, initialBanReason, 'public/Default.svg'], function(err) {
            if (err) {
                console.error("Database Insert Error:", err.message);
                return res.sendFile(path.join(__dirname, 'register_error_username_taken.html'));
            }
            const newUserId = this.lastID;
            logAudit('account_created', username, username, gateEnabled ? 'registration gate ON - created pending activation' : 'registration gate OFF - created active');

            // Activation gating pings only fire while the registration gate is
            // enabled. While it's off, registration is open and nobody gets
            // pinged.
            if (gateEnabled) {
                // Post a notice in the reserved "Activations" group chat (id 1) so
                // admins/mods watching it see new signups awaiting activation, and
                // ping the user with id 1 (typically the owner/head admin).
                db.get(`SELECT username FROM User_Data WHERE id = 1`, (errPing, pingUser) => {
                    const pingSuffix = pingUser ? ` @${pingUser.username}` : '';
                    const gcContent = `${username} is waiting for activation${pingSuffix}`;
                    db.run(`INSERT INTO Group_Chat_Messages (group_id, from_user, content) VALUES (1, 'System', ?)`,
                        [gcContent], function (errGC) {
                            if (errGC) { console.error('Activation notice insert error:', errGC.message); return; }
                            const gcMsgId = this.lastID;
                            db.get(`SELECT Group_Chat_Messages.*, User_Data.avatar_path, User_Data.Nickname FROM Group_Chat_Messages LEFT JOIN User_Data ON Group_Chat_Messages.from_user = User_Data.username WHERE Group_Chat_Messages.id = ?`, [gcMsgId], (errRow, row) => {
                                if (errRow || !row) return;
                                db.all(`SELECT username FROM Group_Chat_Members WHERE group_id = 1`, (errMem, memberRows) => {
                                    const members = (memberRows || []).map(r => r.username);
                                    broadcastGCMessage(1, 'System', row, null, members);
                                });
                            });
                            if (pingUser) {
                                processMentions(gcContent, 'System', { type: 'mention_gc', post_id: 1, message_id: gcMsgId });
                            }
                        });

                    // DM the same notice to user id 1 plus anyone listed in the
                    // local activation-pings.txt file, once each, skipping
                    // whoever doesn't actually have an account.
                    const dmContent = `${username} is waiting for activation`;
                    const candidateUsernames = new Set(getActivationPingUsernames());
                    if (pingUser) candidateUsernames.add(pingUser.username);
                    if (candidateUsernames.size) {
                        const usernameList = [...candidateUsernames];
                        const placeholders = usernameList.map(() => '?').join(',');
                        db.all(`SELECT username FROM User_Data WHERE username IN (${placeholders})`, usernameList, (errDM, rows) => {
                            if (errDM || !rows) return;
                            rows.forEach(r => sendSystemDM(r.username, dmContent));
                        });
                    }
                });
            }

            db.get(`SELECT IsBanned, BanReason FROM User_Data WHERE id = ?`, [newUserId], (err2, newUser) => {
                if (err2 || !newUser) return res.redirect('/');
                if (newUser.IsBanned) {
                    const reason = newUser.BanReason || 'No reason provided';
                    return res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Banned</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
    <div class="box" style="color: white; height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box;">
        <h1>The ban hammer has struck you</h1><br>
        <h3>Ban Reason: ${escapeHTML(reason)}</h3><br><br>
        <button type="submit" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>
    </div>
    <script>
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => {
                btn.classList.add('clicked');
                setTimeout(() => btn.classList.remove('clicked'), 150);
            });
        });
    </script>

</body>
</html>`);
                }
                const registerIP = getClientIP(req);
                db.run(`UPDATE User_Data SET last_ip = ? WHERE id = ?`, [registerIP, newUserId], () => {});
                // New accounts start with email_verified = 0, so hold them in
                // the same "pending" session state used elsewhere until they
                // confirm the address, instead of granting a full session.
                req.session.pendingVerifyUserId = newUserId;
                req.session.pendingVerifyUsername = username;
                issueEmailVerification(newUserId, username, email, () => {});
                return res.redirect('/account/verify-email-required');
            });
        });
    } catch (err) {
        console.error("Register error:", err);
        return res.status(500).sendFile(path.join(__dirname, 'register_error_internal.html'));
    }
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;

    db.get(`SELECT * FROM User_Data WHERE username = ?`, [username], async (err, user) => {
        if (err) {
            console.error("Database Login Error:", err.message);
            return res.status(500).sendFile(path.join(__dirname, 'login_error_internal.html'));
        }

        if (!user) {
            return res.status(401).sendFile(path.join(__dirname, 'login_error_invalid_credentials.html'));
        }

        try {
            const match = await bcrypt.compare(password, user.password);
            if (match) {
                if (user.IsDeleted) {
                    const reason = user.DeleteReason || 'No reason provided';
                    return res.status(401).send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Account Deleted</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
    <div class="box" style="color: white; height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box;">
        <h1>Your account has been deleted</h1><br>
        <h3>Reason: ${escapeHTML(reason)}</h3><br><br>
        <button type="submit" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>
    </div>
    <script>
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => {
                btn.classList.add('clicked');
                setTimeout(() => btn.classList.remove('clicked'), 150);
            });
        });
    </script>

</body>
</html>`);
                }
                if (user.IsBanned) {
                    const reason = user.BanReason || 'No reason provided';
                    return res.status(401).send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Banned</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
    <div class="box" style="color: white; height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box;">
        <h1>The ban hammer has struck you</h1><br>
        <h3>Ban Reason: ${escapeHTML(reason)}</h3><br><br>
        <button type="submit" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>
    </div>
    <script>
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => {
                btn.classList.add('clicked');
                setTimeout(() => btn.classList.remove('clicked'), 150);
            });
        });
    </script>

</body>
</html>`);
                }
                if (!user.email) {
                    // Older accounts predate the email requirement. Hold them in a
                    // "pending" session state (no userId yet) until they add one,
                    // so nothing else in the app is reachable in the meantime.
                    req.session.pendingEmailUserId = user.id;
                    req.session.pendingEmailUsername = user.username;
                    return res.redirect('/account/add-email');
                }
                if (!user.email_verified) {
                    // Email present but not confirmed yet. Hold them in the same
                    // kind of "pending" session state until they verify it (or
                    // switch to a different address and verify that instead).
                    req.session.pendingVerifyUserId = user.id;
                    req.session.pendingVerifyUsername = user.username;
                    return res.redirect('/account/verify-email-required');
                }
                req.session.userId = user.id;
                req.session.userUsername = user.username;
                const loginIP = getClientIP(req);
                db.run(`UPDATE User_Data SET last_ip = ? WHERE id = ?`, [loginIP, user.id], () => {});
                return res.redirect('/feed');
            } else {
                return res.status(401).sendFile(path.join(__dirname, 'login_error_invalid_credentials.html'));
            }
        } catch (error) {
            console.error(error);
            return res.status(500).sendFile(path.join(__dirname, 'login_error_auth_exception.html'));
        }
    });
});

// ----- Add email (forced, one-time, for pre-existing accounts) -----
app.get('/account/add-email', (req, res) => {
    if (req.session.userId) return res.redirect('/feed');
    if (!req.session.pendingEmailUserId) return res.redirect('/');
    const username = escapeHTML(req.session.pendingEmailUsername || '');
    res.send(renderMessagePage('Add Email', 'One more thing',
        `<h3>We now require an email on every account so you can reset your password if you forget it. Add one to finish logging in as <strong>${username}</strong>.</h3><br>
        <form method="POST" action="/account/add-email" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
            <input type="text" name="email" placeholder="Email address" required style="width: 260px;">
            <button type="submit" class="button" style="width: 150px;">Continue</button>
        </form>`));
});

app.post('/account/add-email', (req, res) => {
    if (!req.session.pendingEmailUserId) return res.redirect('/');
    const userId = req.session.pendingEmailUserId;
    const email = (req.body.email || '').trim().toLowerCase();

    if (!email || !EMAIL_REGEX.test(email)) {
        return res.status(400).send(renderMessagePage('Invalid Email', 'That doesn\'t look like a valid email',
            `<h3>Please double check the email address and try again.</h3><br><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/account/add-email';">Go back</button>`));
    }

    db.run(`UPDATE User_Data SET email = ?, email_verified = 0 WHERE id = ?`, [email, userId], function(err) {
        if (err) {
            console.error('Add email error:', err.message);
            return res.status(500).send(renderMessagePage('Error', 'Something went wrong',
                `<h3>Please try again.</h3><br><br>
                <button type="button" class="button" style="width: 150px" onclick="window.location.href='/account/add-email';">Go back</button>`));
        }
        const username = req.session.pendingEmailUsername;
        delete req.session.pendingEmailUserId;
        delete req.session.pendingEmailUsername;
        const loginIP = getClientIP(req);
        db.run(`UPDATE User_Data SET last_ip = ? WHERE id = ?`, [loginIP, userId], () => {});
        logAudit('email_added', username, username, 'added email on login (pre-existing account)');
        // The address hasn't been confirmed yet, so route into the same
        // verification hold used everywhere else instead of logging in.
        req.session.pendingVerifyUserId = userId;
        req.session.pendingVerifyUsername = username;
        issueEmailVerification(userId, username, email, () => {});
        return res.redirect('/account/verify-email-required');
    });
});

// ----- Verify email (forced, blocks the app until confirmed) -----
// Small in-memory cooldown so the resend button can't be used to spam an
// address. Keyed by user id; fine to lose on restart.
const lastVerifyResendAt = new Map();

app.get('/account/verify-email-required', (req, res) => {
    if (!req.session.pendingVerifyUserId) return res.redirect('/');
    const userId = req.session.pendingVerifyUserId;
    const username = escapeHTML(req.session.pendingVerifyUsername || '');

    db.get(`SELECT email FROM User_Data WHERE id = ?`, [userId], (err, user) => {
        const email = (user && user.email) ? user.email : '';
        res.send(renderMessagePage('Verify Email', 'Confirm your email',
            `<h3>We sent a verification link to <strong>${escapeHTML(email)}</strong>. Click it to finish logging in as <strong>${username}</strong>.</h3><br>
            <form method="POST" action="/account/verify-email-required/resend" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
                <button type="submit" class="button" style="width: 220px;">Resend verification email</button>
            </form><br>
            <p style="opacity:0.7;">Used the wrong address, or don't have access to it anymore?</p>
            <form method="POST" action="/account/verify-email-required/change" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
                <input type="text" name="email" placeholder="New email address" required style="width: 260px;">
                <button type="submit" class="button" style="width: 220px;">Use a different email</button>
            </form><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/logout';">Log out</button>`));
    });
});

app.post('/account/verify-email-required/resend', (req, res) => {
    if (!req.session.pendingVerifyUserId) return res.redirect('/');
    const userId = req.session.pendingVerifyUserId;
    const username = req.session.pendingVerifyUsername;

    const lastSent = lastVerifyResendAt.get(userId) || 0;
    if (Date.now() - lastSent < EMAIL_VERIFY_RESEND_COOLDOWN_MS) {
        return res.status(429).send(renderMessagePage('Slow Down', 'Please wait a moment',
            `<h3>A verification email was just sent. Give it a minute before requesting another.</h3><br><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/account/verify-email-required';">Go back</button>`));
    }

    db.get(`SELECT email FROM User_Data WHERE id = ?`, [userId], (err, user) => {
        if (err || !user || !user.email) return res.redirect('/account/verify-email-required');
        lastVerifyResendAt.set(userId, Date.now());
        issueEmailVerification(userId, username, user.email, () => {});
        logAudit('email_verification_resent', username, username, null);
        return res.redirect('/account/verify-email-required');
    });
});

app.post('/account/verify-email-required/change', (req, res) => {
    if (!req.session.pendingVerifyUserId) return res.redirect('/');
    const userId = req.session.pendingVerifyUserId;
    const username = req.session.pendingVerifyUsername;
    const email = (req.body.email || '').trim().toLowerCase();

    if (!email || !EMAIL_REGEX.test(email)) {
        return res.status(400).send(renderMessagePage('Invalid Email', 'That doesn\'t look like a valid email',
            `<h3>Please double check the email address and try again.</h3><br><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/account/verify-email-required';">Go back</button>`));
    }

    // Accounts are allowed to share an email address, so there's no
    // uniqueness check here - just swap it in and send a fresh link.
    db.run(`UPDATE User_Data SET email = ?, email_verified = 0 WHERE id = ?`, [email, userId], (err) => {
        if (err) {
            console.error('Change pending email error:', err.message);
            return res.status(500).send(renderMessagePage('Error', 'Something went wrong',
                `<h3>Please try again.</h3><br><br>
                <button type="button" class="button" style="width: 150px" onclick="window.location.href='/account/verify-email-required';">Go back</button>`));
        }
        lastVerifyResendAt.set(userId, Date.now());
        issueEmailVerification(userId, username, email, () => {});
        logAudit('email_changed', username, username, `to ${email} (while unverified)`);
        return res.redirect('/account/verify-email-required');
    });
});

app.get('/account/verify-email', (req, res) => {
    const token = req.query.token || '';
    if (!token) return res.redirect('/');
    const tokenHash = hashEmailVerifyToken(token);

    db.get(`SELECT * FROM Email_Verifications WHERE token_hash = ?`, [tokenHash], (err, verifyRow) => {
        if (err || !verifyRow || verifyRow.used || new Date(verifyRow.expires_at) < new Date()) {
            return res.status(400).send(renderMessagePage('Link Expired', 'This verification link is no longer valid',
                `<h3>It may have expired or already been used. Log in to request a new one.</h3><br><br>
                <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Go to login</button>`));
        }
        db.get(`SELECT * FROM User_Data WHERE id = ?`, [verifyRow.user_id], (err2, user) => {
            if (err2 || !user) return res.redirect('/');
            // If the account's email changed after this link was sent, the
            // link is stale even though it hasn't technically expired yet.
            if (!user.email || user.email.toLowerCase() !== verifyRow.email.toLowerCase()) {
                return res.status(400).send(renderMessagePage('Link Expired', 'This verification link is no longer valid',
                    `<h3>The email on this account has changed since this link was sent. Log in to request a new one.</h3><br><br>
                    <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Go to login</button>`));
            }
            db.run(`UPDATE User_Data SET email_verified = 1 WHERE id = ?`, [user.id], (err3) => {
                if (err3) {
                    console.error('Email verify update error:', err3.message);
                    return res.status(500).send(renderMessagePage('Error', 'Something went wrong', `<h3>Please try again.</h3>`));
                }
                db.run(`UPDATE Email_Verifications SET used = 1 WHERE id = ?`, [verifyRow.id], () => {});
                logAudit('email_verified', user.username, user.username, null);

                // Clear any pending hold and log the user in fully, whether they
                // arrived here from registration/login or just clicked the link
                // while the account already had a full session.
                if (req.session.pendingVerifyUserId === user.id) {
                    delete req.session.pendingVerifyUserId;
                    delete req.session.pendingVerifyUsername;
                }
                req.session.userId = user.id;
                req.session.userUsername = user.username;
                return res.send(renderMessagePage('Email Verified', 'You\'re all set',
                    `<h3>Your email has been verified.</h3><br><br>
                    <button type="button" class="button" style="width: 150px" onclick="window.location.href='/feed';">Continue</button>`));
            });
        });
    });
});

// ----- Forgot / reset password -----
app.get('/forgot-password', (req, res) => {
    if (req.session.userId) return res.redirect('/feed');
    // Only username is accepted here, not email - since the same email can
    // now be linked to more than one account, an email lookup could return
    // several matches and there'd be no safe way to know which one to reset.
    res.send(renderMessagePage('Forgot Password', 'Reset your password',
        `<h3>Enter your username and we'll send a reset link to the email linked to that account.</h3><br>
        <form method="POST" action="/forgot-password" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
            <input type="text" name="username" placeholder="Username" required style="width: 260px;">
            <button type="submit" class="button" style="width: 180px;">Send reset link</button>
        </form><br>
        <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Back to login</button>`));
});

app.post('/forgot-password', (req, res) => {
    const username = (req.body.username || '').trim();
    // Always show the same response either way, so this endpoint can't be used
    // to probe which usernames have accounts.
    const done = () => res.send(renderMessagePage('Forgot Password', 'Check your email',
        `<h3>If that username has an account, we've sent a password reset link to its email address. The link expires in 1 hour.</h3><br><br>
        <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Back to login</button>`));

    if (!username) return done();

    db.get(`SELECT * FROM User_Data WHERE username = ? COLLATE NOCASE`, [username], (err, user) => {
        if (err || !user || !user.email || user.IsDeleted) return done();

        const { raw, hash } = generateResetToken();
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
        db.run(`INSERT INTO Password_Resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
            [user.id, hash, expiresAt], (err2) => {
                if (err2) { console.error('Password reset insert error:', err2.message); return done(); }
                const resetLink = `${APP_BASE_URL}/reset-password?token=${raw}`;
                sendPasswordResetEmail(user.email, user.username, resetLink);
                logAudit('password_reset_requested', user.username, user.username, 'via username');
                return done();
            });
    });
});

app.get('/reset-password', (req, res) => {
    const token = req.query.token || '';
    if (!token) return res.redirect('/forgot-password');
    const tokenHash = hashResetToken(token);

    db.get(`SELECT * FROM Password_Resets WHERE token_hash = ?`, [tokenHash], (err, resetRow) => {
        if (err || !resetRow || resetRow.used || new Date(resetRow.expires_at) < new Date()) {
            return res.status(400).send(renderMessagePage('Link Expired', 'This reset link is no longer valid',
                `<h3>It may have expired or already been used. Request a new one below.</h3><br><br>
                <button type="button" class="button" style="width: 180px" onclick="window.location.href='/forgot-password';">Request new link</button>`));
        }
        res.send(renderMessagePage('Reset Password', 'Choose a new password',
            `<form method="POST" action="/reset-password" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
                <input type="hidden" name="token" value="${escapeHTML(token)}">
                <input type="password" name="password" placeholder="New password" required style="width: 260px;">
                <input type="password" name="confirm_password" placeholder="Confirm new password" required style="width: 260px;">
                <button type="submit" class="button" style="width: 150px;">Reset password</button>
            </form>`));
    });
});

app.post('/reset-password', async (req, res) => {
    const token = req.body.token || '';
    const { password, confirm_password } = req.body;
    if (!token) return res.redirect('/forgot-password');
    const tokenHash = hashResetToken(token);

    const showForm = (message) => res.status(400).send(renderMessagePage('Reset Password', 'Choose a new password',
        `<h3 style="color: rgb(255,120,120);">${escapeHTML(message)}</h3><br>
        <form method="POST" action="/reset-password" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
            <input type="hidden" name="token" value="${escapeHTML(token)}">
            <input type="password" name="password" placeholder="New password" required style="width: 260px;">
            <input type="password" name="confirm_password" placeholder="Confirm new password" required style="width: 260px;">
            <button type="submit" class="button" style="width: 150px;">Reset password</button>
        </form>`));

    if (!password || password.length < 6) return showForm('Password must be at least 6 characters.');
    if (password !== confirm_password) return showForm('Passwords do not match.');

    db.get(`SELECT * FROM Password_Resets WHERE token_hash = ?`, [tokenHash], async (err, resetRow) => {
        if (err || !resetRow || resetRow.used || new Date(resetRow.expires_at) < new Date()) {
            return res.status(400).send(renderMessagePage('Link Expired', 'This reset link is no longer valid',
                `<h3>It may have expired or already been used. Request a new one below.</h3><br><br>
                <button type="button" class="button" style="width: 180px" onclick="window.location.href='/forgot-password';">Request new link</button>`));
        }
        try {
            const hashedPassword = await bcrypt.hash(password, 10);
            db.run(`UPDATE User_Data SET password = ? WHERE id = ?`, [hashedPassword, resetRow.user_id], (err2) => {
                if (err2) {
                    console.error('Password reset update error:', err2.message);
                    return showForm('Something went wrong. Please try again.');
                }
                // Mark this token used and invalidate any other outstanding tokens
                // for this account, so an old email link can't be replayed later.
                db.run(`UPDATE Password_Resets SET used = 1 WHERE user_id = ?`, [resetRow.user_id], () => {});
                db.get(`SELECT username FROM User_Data WHERE id = ?`, [resetRow.user_id], (err3, u) => {
                    logAudit('password_reset_completed', u ? u.username : 'unknown', u ? u.username : null, null);
                });
                return res.send(renderMessagePage('Password Reset', 'Your password has been reset',
                    `<h3>You can now log in with your new password.</h3><br><br>
                    <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Go to login</button>`));
            });
        } catch (e) {
            console.error('Password reset hash error:', e);
            return showForm('Something went wrong. Please try again.');
        }
    });
});

app.get('/edit', (req, res) => {
    if (!req.session.userId) return res.redirect('/');

    db.get(`SELECT bio, avatar_path, Nickname, email FROM User_Data WHERE id = ?`, [req.session.userId], (err, user) => {
        const bio = (user && user.bio) ? user.bio : '';
        const avatarPath = (user && user.avatar_path) ? user.avatar_path : null;
        const nickname = (user && user.Nickname) ? user.Nickname : '';
        const email = (user && user.email) ? user.email : '';
        res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dashboard</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
<style>
    body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .dashboard-box { color: white; width: 500px; padding: 30px; text-align: center; }
    .dash-field { margin: 12px 0; text-align: left; }
    .dash-field label { display: block; margin-bottom: 4px; font-size: 0.9em; opacity: 0.7; }
    .dash-textarea { width: 100%; box-sizing: border-box; background: black; color: white; border: 2px solid white; border-radius: 10px; padding: 8px; font-family: inherit; font-size: inherit; resize: vertical; min-height: 80px; }
    .dash-links { margin-top: 20px; display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
</style>
</head>
<body>
    <div class="box dashboard-box">
        <h1>Dashboard</h1>
        <p style="opacity:0.6;">@${req.session.userUsername}</p>
        <div class="dash-field" style="text-align:center;">
            <label>Profile Picture</label>
            <div style="display:flex;justify-content:center;margin-bottom:10px;">
                ${renderAvatarHTML(avatarPath, req.session.userUsername, 84)}
            </div>
            <form action="/edit/avatar" method="POST" enctype="multipart/form-data" style="display:flex;flex-direction:column;align-items:center;gap:8px;">
                <input type="file" id="avatar-input" name="avatar" accept="image/*" style="display:none;">
                <label for="avatar-input" class="button" style="padding:10px;width:160px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;">Choose Image</label>
                <span id="avatar-file-name" style="font-size:0.78em;opacity:0.65;">No file chosen</span>
                <button class="button" type="submit" style="padding:10px;width:160px;">Upload</button>
            </form>
        </div>
        <form action="/edit/nickname" method="POST">
            <div class="dash-field">
                <label>Nickname <span style="opacity:0.4;">(shown instead of your username - spaces allowed. Your @username stays the same and is the only way people can ping you)</span></label>
                <input class="dash-textarea" style="min-height:unset;" type="text" name="nickname" id="nickname-input" placeholder="e.g. Cool Guy" maxlength="32" value="${escapeHTML(nickname)}">
            </div>
            <button class="button" type="submit" style="padding:10px;width: auto;margin-top:8px;">Save Nickname</button>
        </form>
        <form action="/edit/bio" method="POST">
            <div class="dash-field">
                <label>Bio</label>
                <textarea class="dash-textarea" name="bio" id="bio-textarea" placeholder="Tell people about yourself..." maxlength="1000">${bio}</textarea>
            </div>
            <button class="button" type="submit" style="padding:10px;width:120px;margin-top:8px;">Save Bio</button>
        </form>
        <div class="dash-field">
            <label>Email</label>
            <p style="margin:0 0 10px;opacity:0.8;">${email ? 'Current: ' + escapeHTML(email) : '<span style="opacity:0.5;">No email on file.</span>'}</p>
            ${email ? `
            <div id="email-change-step1">
                <input class="dash-textarea" style="min-height:unset;" type="text" id="new-email-input" placeholder="New email address" autocomplete="off">
                <button class="button" type="button" onclick="requestEmailCode()" style="padding:10px;width:auto;margin-top:8px;">Send code to current email</button>
            </div>
            <div id="email-change-step2" style="display:none;margin-top:14px;">
                <p style="opacity:0.7;margin:0 0 8px;">We sent a code to <span id="email-code-sent-to"></span>. Enter it below to confirm the change to <span id="email-code-new-addr"></span>.</p>
                <input class="dash-textarea" style="min-height:unset;" type="text" id="email-code-input" placeholder="6-digit code" maxlength="6" autocomplete="off">
                <div style="display:flex;gap:8px;margin-top:8px;">
                    <button class="button" type="button" onclick="confirmEmailChange()" style="padding:10px;width:auto;">Confirm change</button>
                    <button class="button" type="button" onclick="cancelEmailChange()" style="padding:10px;width:auto;">Cancel</button>
                </div>
            </div>
            <div id="email-change-result" style="margin-top:8px;font-size:0.85em;"></div>
            ` : `<button class="button" type="button" onclick="window.location.href='/account/add-email';" style="padding:10px;width:auto;">Add Email</button>`}
        </div>
        <div class="dash-links">
            <button class="button" style="padding:10px;width:120px;" onclick="window.location.href='/feed';">Feed</button>
            <button class="button" style="padding:10px;width:120px;" onclick="window.location.href='/messages';">Messages</button>
            <button class="button notif-nav-link" style="padding:10px;width: auto;" onclick="window.location.href='/notifications';">Notifications</button>
            <button class="button" style="padding:10px;width:120px;" onclick="window.location.href='/followers';">Followers</button>
            <button class="button" style="padding:10px;width:120px;" onclick="window.location.href='/user/${req.session.userUsername}';">My Profile</button>
        </div>
        <hr style="border-color:rgba(255,80,80,0.3);margin:26px 0 14px;">
        <div class="dash-field" style="text-align:center;">
            <h3 style="color:rgb(255, 0, 0);margin-bottom:4px;">Danger Zone</h3>
            <p style="opacity:0.6;font-size:0.82em;">Deleting your account is <strong>permanent</strong>. It removes your posts, DMs, group chat messages and memberships, follows, friends, friend requests, and notifications from the database. There is no way to undo this or recover your data afterward.</p>
            <button class="button" type="button" onclick="openDeleteAccountBox()" style="padding:10px;width:auto;">Delete My Account</button>
            <div id="delete-account-box" style="display:none;margin-top:14px;text-align:left;">
                <label>Enter your password to confirm</label>
                <input class="dash-textarea" style="min-height:unset;" type="password" id="delete-account-password" placeholder="Current password" autocomplete="current-password">
                <div style="display:flex;gap:8px;margin-top:8px;justify-content:center;">
                    <button class="button" type="button" onclick="confirmDeleteAccount()" style="padding:10px;width:auto;">Permanently Delete Everything</button>
                    <button class="button" type="button" onclick="closeDeleteAccountBox()" style="padding:10px;width:auto;">Cancel</button>
                </div>
                <div id="delete-account-result" style="margin-top:8px;font-size:0.85em;text-align:center;"></div>
            </div>
        </div>
    </div>
    <script>
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => { btn.classList.add('clicked'); setTimeout(() => btn.classList.remove('clicked'), 150); });
        });

        document.getElementById('avatar-input').addEventListener('change', function () {
            document.getElementById('avatar-file-name').textContent = this.files.length ? this.files[0].name : 'No file chosen';
        });

        const bioEl = document.getElementById('bio-textarea');
        const bioCounter = document.createElement('div');
        bioCounter.style.cssText = 'font-size:0.75em;opacity:0.5;text-align:right;margin-top:4px;';
        bioCounter.textContent = bioEl.value.length + ' / 1000';
        bioEl.parentNode.insertBefore(bioCounter, bioEl.nextSibling);
        bioEl.addEventListener('input', function () {
            const len = this.value.length;
            bioCounter.textContent = len + ' / 1000';
            bioCounter.style.color = len > 900 ? (len >= 1000 ? 'rgb(255,80,80)' : 'orange') : '';
            bioCounter.style.opacity = len > 900 ? '1' : '0.5';
        });

        if (new URLSearchParams(window.location.search).get('nicknameerror')) {
            const t = document.createElement('div');
            t.textContent = 'Nickname too long - 32 character limit.';
            t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:white;padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 4000);
            window.history.replaceState(null, '', '/edit');
        }

        if (new URLSearchParams(window.location.search).get('bioerror')) {
            const t = document.createElement('div');
            t.textContent = 'Bio too long - 1,000 character limit.';
            t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:white;padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 4000);
            window.history.replaceState(null, '', '/edit');
        }

        let pendingNewEmail = '';

        async function requestEmailCode() {
            const newEmailInput = document.getElementById('new-email-input');
            const resultEl = document.getElementById('email-change-result');
            const newEmail = newEmailInput.value.trim();
            if (!newEmail) { resultEl.style.color = 'rgb(255,120,120)'; resultEl.textContent = 'Enter a new email address.'; return; }
            resultEl.style.color = ''; resultEl.textContent = 'Sending code...';
            try {
                const r = await fetch('/account/email/request-code', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ new_email: newEmail })
                });
                const d = await r.json();
                if (!r.ok) { resultEl.style.color = 'rgb(255,120,120)'; resultEl.textContent = d.error || 'Could not send code.'; return; }
                pendingNewEmail = newEmail;
                document.getElementById('email-code-sent-to').textContent = d.sent_to;
                document.getElementById('email-code-new-addr').textContent = newEmail;
                document.getElementById('email-change-step1').style.display = 'none';
                document.getElementById('email-change-step2').style.display = 'block';
                resultEl.style.color = ''; resultEl.textContent = '';
            } catch (e) { resultEl.style.color = 'rgb(255,120,120)'; resultEl.textContent = 'Network error.'; }
        }

        async function confirmEmailChange() {
            const codeInput = document.getElementById('email-code-input');
            const resultEl = document.getElementById('email-change-result');
            const code = codeInput.value.trim();
            if (!code) { resultEl.style.color = 'rgb(255,120,120)'; resultEl.textContent = 'Enter the code from your email.'; return; }
            resultEl.style.color = ''; resultEl.textContent = 'Confirming...';
            try {
                const r = await fetch('/account/email/confirm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code })
                });
                const d = await r.json();
                if (!r.ok) { resultEl.style.color = 'rgb(255,120,120)'; resultEl.textContent = d.error || 'Could not confirm code.'; return; }
                resultEl.style.color = 'rgb(0,191,255)'; resultEl.textContent = 'Email updated!';
                setTimeout(() => window.location.reload(), 900);
            } catch (e) { resultEl.style.color = 'rgb(255,120,120)'; resultEl.textContent = 'Network error.'; }
        }

        function cancelEmailChange() {
            pendingNewEmail = '';
            document.getElementById('email-code-input').value = '';
            document.getElementById('email-change-step2').style.display = 'none';
            document.getElementById('email-change-step1').style.display = 'block';
            document.getElementById('email-change-result').textContent = '';
        }

        function openDeleteAccountBox() {
            document.getElementById('delete-account-box').style.display = 'block';
        }

        function closeDeleteAccountBox() {
            document.getElementById('delete-account-box').style.display = 'none';
            document.getElementById('delete-account-password').value = '';
            document.getElementById('delete-account-result').textContent = '';
        }

        async function confirmDeleteAccount() {
            const password = document.getElementById('delete-account-password').value;
            const resultEl = document.getElementById('delete-account-result');
            if (!password) { resultEl.style.color = 'rgb(255,120,120)'; resultEl.textContent = 'Enter your password to confirm.'; return; }
            if (!confirm('This will PERMANENTLY delete your account and all of your data. This cannot be undone. Continue?')) return;

            resultEl.style.color = ''; resultEl.textContent = 'Deleting...';
            try {
                const r = await fetch('/account/delete-self', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });
                const d = await r.json();
                if (!r.ok) { resultEl.style.color = 'rgb(255,120,120)'; resultEl.textContent = d.error || 'Could not delete account.'; return; }
                resultEl.style.color = 'rgb(0,191,255)'; resultEl.textContent = 'Account deleted. Redirecting...';
                setTimeout(() => window.location.href = '/', 1200);
            } catch (e) { resultEl.style.color = 'rgb(255,120,120)'; resultEl.textContent = 'Network error.'; }
        }

        if (new URLSearchParams(window.location.search).get('avatarerror')) {
            const t = document.createElement('div');
            t.textContent = 'Could not upload profile picture - please use an image file under 8MB.';
            t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:white;padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 4000);
            window.history.replaceState(null, '', '/edit');
        }
    </script>
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}

</body>
</html>`);
    });
});

// Self-service, permanent account deletion. Requires the user's current
// password as confirmation, then wipes the account and everything tied to
// it via the same hardDeleteAccount() helper the admin hard-delete route
// uses (defined further down, alongside the admin routes).
app.post('/account/delete-self', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'not logged in' });
    const password = (req.body && req.body.password) || '';
    if (!password) return res.status(400).json({ error: 'password is required' });
    const userId = req.session.userId;
    const username = req.session.userUsername;
    db.get(`SELECT password FROM User_Data WHERE id = ?`, [userId], async (err, user) => {
        if (err || !user) return res.status(500).json({ error: 'db error' });
        let match = false;
        try {
            match = await bcrypt.compare(password, user.password);
        } catch (e) {
            return res.status(500).json({ error: 'auth error' });
        }
        if (!match) return res.status(401).json({ error: 'incorrect password' });
        hardDeleteAccount(username, 'You deleted your own account', (err2) => {
            if (err2) {
                console.error('Self-delete error:', err2.message);
                return res.status(500).json({ error: 'db error' });
            }
            logAudit('account_self_deleted', username, username, 'user deleted their own account');
            req.session.destroy(() => {
                res.json({ ok: true, deleted: true });
            });
        });
    });
});

app.post('/edit/nickname', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    let { nickname } = req.body;
    nickname = (nickname || '').trim();
    if (nickname.length > MAX_NICKNAME_LENGTH) return res.redirect('/edit?nicknameerror=1');
    db.run(`UPDATE User_Data SET Nickname = ? WHERE id = ?`, [nickname || null, req.session.userId], () => res.redirect('/edit'));
});

app.post('/edit/bio', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const { bio } = req.body;
    if (bio && bio.length > MAX_BIO_LENGTH) return res.redirect('/edit?bioerror=1');
    db.run(`UPDATE User_Data SET bio = ? WHERE id = ?`, [bio || '', req.session.userId], () => res.redirect('/edit'));
});

app.post('/edit/avatar', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    avatarUpload.single('avatar')(req, res, (err) => {
        if (err || !req.file) return res.redirect('/edit?avatarerror=1');
        db.run(`UPDATE User_Data SET avatar_path = ? WHERE id = ?`, [req.file.path, req.session.userId], () => res.redirect('/edit'));
    });
});

// ----- Self-service email change (from the dashboard) -----
// Step 1: user submits the new address they want. We email a 6-digit code
// to the CURRENT address on file (not the new one) - this proves whoever
// is requesting the change still controls the existing account, the same
// way password resets prove control via the existing email.
app.post('/account/email/request-code', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const userId = req.session.userId;
    const newEmail = (req.body.new_email || '').trim().toLowerCase();

    if (!newEmail || !EMAIL_REGEX.test(newEmail)) {
        return res.status(400).json({ error: 'That doesn\'t look like a valid email.' });
    }

    db.get(`SELECT username, email FROM User_Data WHERE id = ?`, [userId], (err, user) => {
        if (err) return res.status(500).json({ error: 'Something went wrong.' });
        if (!user) return res.status(404).json({ error: 'Account not found.' });
        if (!user.email) {
            return res.status(400).json({ error: 'Your account has no email on file yet - add one first.' });
        }
        if (newEmail === user.email.toLowerCase()) {
            return res.status(400).json({ error: 'That\'s already your current email.' });
        }
        db.get(`SELECT id FROM User_Data WHERE email = ? COLLATE NOCASE AND id != ?`, [newEmail, userId], (err2, taken) => {
            if (err2) return res.status(500).json({ error: 'Something went wrong.' });
            if (taken) return res.status(400).json({ error: 'That email is already linked to another account.' });

            const { code, hash } = generateEmailChangeCode();
            const expiresAt = new Date(Date.now() + EMAIL_CHANGE_CODE_TTL_MS).toISOString();
            db.run(`INSERT INTO Email_Changes (user_id, code_hash, new_email, expires_at) VALUES (?, ?, ?, ?)`,
                [userId, hash, newEmail, expiresAt], (err3) => {
                    if (err3) { console.error('Email change insert error:', err3.message); return res.status(500).json({ error: 'Something went wrong.' }); }
                    sendEmailChangeCodeEmail(user.email, user.username, code, newEmail);
                    logAudit('email_change_requested', user.username, user.username, `to ${newEmail}`);
                    res.json({ ok: true, sent_to: user.email });
                });
        });
    });
});

// Step 2: user enters the code that was emailed to their current address.
// On success the account's email is updated to the address captured in
// step 1 (re-checked for uniqueness in case it was taken in the meantime).
app.post('/account/email/confirm', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const userId = req.session.userId;
    const code = (req.body.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Enter the code from your email.' });
    const codeHash = hashEmailChangeCode(code);

    db.get(`SELECT * FROM Email_Changes WHERE user_id = ? AND code_hash = ? ORDER BY id DESC LIMIT 1`, [userId, codeHash], (err, changeRow) => {
        if (err) return res.status(500).json({ error: 'Something went wrong.' });
        if (!changeRow || changeRow.used || new Date(changeRow.expires_at) < new Date()) {
            return res.status(400).json({ error: 'That code is invalid or has expired - request a new one.' });
        }
        db.get(`SELECT id FROM User_Data WHERE email = ? COLLATE NOCASE AND id != ?`, [changeRow.new_email, userId], (err2, taken) => {
            if (err2) return res.status(500).json({ error: 'Something went wrong.' });
            if (taken) return res.status(400).json({ error: 'That email is already linked to another account - request the change again with a different address.' });

            db.run(`UPDATE User_Data SET email = ? WHERE id = ?`, [changeRow.new_email, userId], (err3) => {
                if (err3) {
                    if (err3.message && err3.message.includes('.email')) {
                        return res.status(400).json({ error: 'That email is already linked to another account.' });
                    }
                    console.error('Email change update error:', err3.message);
                    return res.status(500).json({ error: 'Something went wrong.' });
                }
                // Mark this code used and invalidate any other outstanding
                // requests for this account, same pattern as password resets.
                db.run(`UPDATE Email_Changes SET used = 1 WHERE user_id = ?`, [userId], () => {});
                db.get(`SELECT username FROM User_Data WHERE id = ?`, [userId], (err4, u) => {
                    logAudit('email_changed', u ? u.username : 'unknown', u ? u.username : null, `to ${changeRow.new_email}`);
                });
                res.json({ ok: true, email: changeRow.new_email });
            });
        });
    });
});

app.get('/feed', (req, res) => {
    if (!req.session.userId) return res.redirect('/');

    db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, (SELECT COUNT(*) FROM Posts AS Replies WHERE Replies.reply_to = Posts.id) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.pinned = 1 ORDER BY Posts.created_at DESC`, [], (pinErr, pinnedPosts) => {
        const pinnedHTML = (pinnedPosts || []).map(renderPinnedItem).join('');

    db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, (SELECT COUNT(*) FROM Posts AS Replies WHERE Replies.reply_to = Posts.id) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username ORDER BY Posts.created_at DESC LIMIT 10`, [], (err, posts) => {
        if (err) { console.error(err); return res.status(500).send('Error loading feed'); }

        const sessionUsername = req.session.userUsername;

        const oldestPostId = posts.length ? Math.min(...posts.map(p => p.id)) : 0;
        const hasMoreInitial = posts.length === 10;
        const newestPostId = posts.length ? Math.max(...posts.map(p => p.id)) : 0;

        const postsHTML = buildFeedHTML(posts, sessionUsername, 350, req.isAdmin);

        res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Feed</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
<style>
    body { margin: 0; overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
    #feed-wrapper { display: flex; flex-direction: column; height: 100vh; width: 100vw; box-sizing: border-box; border-radius: 0; border: none; }
    #feed-topbar { position: fixed; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: black; border-bottom: 2px solid white; z-index: 100; }
    #feed-topbar-left { font-size: 0.95em; white-space: nowrap; }
    #feed-topbar-right a { color: rgb(0,191,255); margin-left: 15px; text-decoration: none; white-space: nowrap; }
    #feed-topbar-right a:hover { text-decoration: underline; }
    #feed-search-bar { position: absolute; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 6px; }
    #feed-search-input { text-align: left; align-items: center; width: 300px; max-width: 300px; box-sizing: border-box; }
    @media (max-width: 900px) { #feed-search-input { width: 200px; max-width: 200px; } }
    @media (max-width: 600px) { #feed-search-input { width: 130px; max-width: 130px; } }
    @media (max-width: 420px) { #feed-search-input { width: 100px; max-width: 100px; } }
    #feed-search-input:focus { border-color: rgb(0,191,255); }
    #feed-search-input::placeholder { opacity: 0.5; }
    #feed-topbar-right a.active { color: white; font-weight: bold; pointer-events: none; }
    #nav-hamburger { display: none; background: none; border: 2px solid white; border-radius: 6px; color: white; font-size: 1.1em; cursor: pointer; padding: 4px 8px; line-height: 1; }
    #nav-dropdown { display: none; flex-direction: column; position: absolute; top: 100%; right: 0; background: black; border: 2px solid white; border-radius: 10px; padding: 8px 0; min-width: 160px; z-index: 200; }
    #nav-dropdown a { display: block; color: rgb(0,191,255); text-decoration: none; padding: 8px 18px; white-space: nowrap; margin: 0; }
    #nav-dropdown a:hover { background: rgba(255,255,255,0.08); text-decoration: underline; }
    #nav-dropdown a.active { color: white; font-weight: bold; pointer-events: none; }
    #nav-dropdown.open { display: flex; }
    @media (max-width: 2100px) {
        #feed-topbar-right > a { display: none; }
        #nav-hamburger { display: inline-block; }
        #feed-search-bar { position: static; transform: none; flex: 1; justify-content: center; }
    }
    #feed-search-clear { background: none; border: none; color: rgba(255,255,255,0.5); font-size: 1em; cursor: pointer; padding: 2px 6px; line-height: 1; }
    #feed-search-clear:hover { color: white; }
    #feed-search-results { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: black; z-index: 98; overflow-y: auto; padding: 80px 20px 20px; color: white; }
    #feed-search-results .post { max-width: 600px; margin: 0 auto; text-align: left; }
    #feed-search-no-results { text-align: center; opacity: 0.5; margin-top: 40px; }
    #pinned-bar { position: fixed; left: 0; right: 0; z-index: 99; display: flex; flex-direction: column; background: black; max-height: 35vh; overflow-y: auto; border-bottom: 2px solid rgba(255,180,40,0.4); }
    .pinned-item a:hover { text-decoration: underline; }
    #posts { flex: 1; overflow-y: auto; padding: 70px 20px 130px 20px; text-align: center; }
    #post-form-container { position: fixed; bottom: 0; left: 0; right: 0; background: black; border-top: 2px solid white; padding: 10px 20px; z-index: 100; }
    #reply-indicator { font-size: 0.85em; opacity: 0.7; display: none; margin-bottom: 6px; text-align: center; }
    #post-form-row { display: flex; align-items: center; gap: 10px; width: 100%; }
    #post-form-row textarea { text-align: left; flex: 1; height: 44px; resize: none; min-width: 0; background: black; color: white; border: 2px solid white; border-radius: 10px; padding: 8px; font-family: inherit; font-size: inherit; box-sizing: border-box; }
    #file-name-display { font-size: 0.78em; opacity: 0.65; text-align: center; margin-top: 4px; }
    .post { max-width: 600px; margin: 0 auto; text-align: left; }
    .post-actions { margin-top: 6px; display: flex; align-items: center; gap: 8px; }
    .post-action-btn { padding: 0 !important; height: 44px !important; width: 70px !important; font-size: 0.85em !important; line-height: 1 !important; box-sizing: border-box !important; border: 5px solid white; margin: 0; text-align: center; border-radius: 15px; color: white; background-color: black;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: 0.2s;
    }
    .post-action-btn:hover {
    background-color: white;
    color: black;
    }
    .post-action-btn.clicked {
        background-color: black !important;
        color: white !important;
    }
</style>
</head>
<body>
    <div id="feed-wrapper" class="box" style="color: white; animation: none !important;">
        <div id="feed-topbar">
            <div id="feed-topbar-left">Logged in as <strong>${req.session.userUsername}</strong></div>
            <div id="feed-search-bar">
                <input type="text" class="box" style="height: 25px; border-radius: 20px; text-align: left;" id="feed-search-input" placeholder="Search posts…" autocomplete="off">
                <button id="feed-search-clear" title="Clear search" style="display:none;">✕</button>
            </div>
            <div id="feed-topbar-right" style="position:relative;display:flex;align-items:center;">
                <a href="/v86">v86</a>
                <a href="/editor">HTML Editor</a>
                <a href="/edit">Dashboard</a>
                <a href="/notifications" class="notif-nav-link">Notifications</a>
                <a href="/friends">Friends</a>
                <a href="/feed" class="active">All Posts</a>
                <a href="/following-feed">Following Feed</a>
                ${req.isAdmin ? `<a href="/admin/dashboard">Admin Dashboard</a>` : ''}
                <a href="/logout">Logout</a>
                <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
                <nav id="nav-dropdown">
                    <a href="/v86">v86</a>
                    <a href="/editor">HTML Editor</a>
                    <a href="/edit">Dashboard</a>
                    <a href="/notifications" class="notif-nav-link">Notifications</a>
                    <a href="/friends">Friends</a>
                    <a href="/feed" class="active">All Posts</a>
                    <a href="/following-feed">Following Feed</a>
                    ${req.isAdmin ? `<a href="/admin/dashboard">Admin Dashboard</a>` : ''}
                    <a href="/logout">Logout</a>
                </nav>
            </div>
        </div>
        <div id="feed-search-results" style="display:none;"></div>

        ${pinnedHTML ? `<div id="pinned-bar">${pinnedHTML}</div>` : ''}

        <div id="posts" style="color: white;">
            ${postsHTML.length ? postsHTML : '<p id="no-posts-msg">No posts yet.</p>'}
            <div id="load-more-sentinel" style="height:1px;"></div>
            <div id="load-more-spinner" style="display:none;text-align:center;padding:16px;opacity:0.5;font-size:0.9em;">Loading older posts…</div>
        </div>

        <div id="post-form-container">
            <form action="/feed/post" method="POST" enctype="multipart/form-data" id="post-form">
                <div id="post-form-row">
                    <textarea class="box" name="content" id="post-content" placeholder="What's on your mind?" style="background-color:black;color:white;font-family:inherit;font-size:inherit;padding:8px;" maxlength="1000"></textarea>
                    <input type="file" id="attachment" name="attachments" multiple style="display:none;">
                    <label for="attachment" class="button post-action-btn" id="file-label" style="width:70px !important; height: 25px; padding: 10px;">Browse</label>
                    <button class="button post-action-btn" type="submit" style="width:60px !important; height: 25px;">Post</button>
                </div>
                <div id="file-name-display">No file chosen</div>
                <div id="post-char-counter" style="font-size:0.75em;opacity:0.5;text-align:right;margin-top:2px;">0 / 1000</div>
            </form>
        </div>
    </div>

    <script>
        document.querySelectorAll('.post-time').forEach(el => {
            const ts = el.getAttribute('data-ts');
            if (ts) el.textContent = new Date(ts).toLocaleString('en-GB');
        });

        function layoutPinnedBar() {
            const topbar = document.getElementById('feed-topbar');
            const pinnedBar = document.getElementById('pinned-bar');
            const posts = document.getElementById('posts');
            const topbarH = topbar.offsetHeight;
            if (pinnedBar) {
                pinnedBar.style.top = topbarH + 'px';
                const hasPins = pinnedBar.querySelectorAll('.pinned-item').length > 0;
                pinnedBar.style.display = hasPins ? 'flex' : 'none';
                posts.style.paddingTop = (topbarH + (hasPins ? pinnedBar.offsetHeight : 0) + 20) + 'px';
            } else {
                posts.style.paddingTop = (topbarH + 20) + 'px';
            }
        }

        function dismissPin(id) {
            const el = document.querySelector('.pinned-item[data-pin-id="' + id + '"]');
            if (el) el.remove();
            try {
                const dismissed = JSON.parse(sessionStorage.getItem('biodeck_dismissed_pins') || '[]');
                if (!dismissed.includes(id)) dismissed.push(id);
                sessionStorage.setItem('biodeck_dismissed_pins', JSON.stringify(dismissed));
            } catch (e) {}
            layoutPinnedBar();
        }

        (function () {
            try {
                const dismissed = JSON.parse(sessionStorage.getItem('biodeck_dismissed_pins') || '[]');
                dismissed.forEach(id => {
                    const el = document.querySelector('.pinned-item[data-pin-id="' + id + '"]');
                    if (el) el.remove();
                });
            } catch (e) {}
            layoutPinnedBar();
        })();
        window.addEventListener('resize', layoutPinnedBar);

        document.getElementById('attachment').addEventListener('change', function () {
            const n = this.files.length;
            document.getElementById('file-name-display').textContent = n === 0 ? 'No file chosen' : n === 1 ? this.files[0].name : n + ' files selected (max 5)';
        });

        const postContent = document.getElementById('post-content');
        const postCounter = document.getElementById('post-char-counter');
        postContent.addEventListener('input', function () {
            const len = this.value.length;
            postCounter.textContent = len + ' / 1000';
            postCounter.style.color = len > 900 ? (len >= 1000 ? 'rgb(255,80,80)' : 'orange') : '';
            postCounter.style.opacity = len > 3800 ? '1' : '0.5';
        });

        if (new URLSearchParams(window.location.search).get('posterror')) {
            const t = document.createElement('div');
            t.textContent = 'Post too long or too many files selected - 1,000 character limit, max 5 files.';
            t.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:white;padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 4000);
            window.history.replaceState(null, '', '/feed');
        }
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => {
                btn.classList.add('clicked');
                setTimeout(() => btn.classList.remove('clicked'), 150);
            });
        });
        function deletePost(id) {
            fetch('/feed/delete/' + id, { method: 'POST' }).then(r => {
                if (r.ok) {
                    const el = document.getElementById('post-' + id);
                    if (el) {
                        const br = el.nextElementSibling;
                        if (br && br.tagName === 'BR') br.remove();
                        el.remove();
                    }
                }
            });
        }
        function pinPost(id) {
            fetch('/admin/pin/' + id, { method: 'POST' }).then(r => { if (r.ok) location.reload(); });
        }
        function unpinPost(id) {
            fetch('/admin/unpin/' + id, { method: 'POST' }).then(r => { if (r.ok) location.reload(); });
        }
        let lastPostId = (() => {
            const posts = document.querySelectorAll('.post[id^="post-"]');
            let max = ${newestPostId};
            posts.forEach(el => { const n = parseInt(el.id.replace('post-', '')); if (n > max) max = n; });
            return max;
        })();

        function pollFeed() {
            fetch('/feed/poll?after=' + lastPostId)
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                    if (!data || !data.html) return;
                    lastPostId = data.lastId;
                    const postsEl = document.getElementById('posts');
                    const noPostsMsg = postsEl.querySelector('#no-posts-msg');
                    if (noPostsMsg) noPostsMsg.remove();
                    const temp = document.createElement('div');
                    temp.innerHTML = data.html;
                    const sentinel = document.getElementById('load-more-sentinel');
                    while (temp.firstChild) {
                        postsEl.insertBefore(temp.firstChild, postsEl.firstChild);
                    }
                    postsEl.querySelectorAll('.post-time[data-ts]').forEach(el => {
                        if (!el.textContent.trim()) el.textContent = new Date(el.getAttribute('data-ts')).toLocaleString('en-GB');
                    });
                })
                .catch(() => {});
        }

        function pollDeletions() {
            const visibleIds = [];
            document.querySelectorAll('.post[id^="post-"]').forEach(el => {
                visibleIds.push(parseInt(el.id.replace('post-', '')));
            });
            if (!visibleIds.length) return;
            fetch('/feed/exists?' + visibleIds.map(id => 'id=' + id).join('&'))
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                    if (!data) return;
                    visibleIds.forEach(id => {
                        if (!data.existing.includes(id)) {
                            const el = document.getElementById('post-' + id);
                            if (el) {
                                const br = el.nextElementSibling;
                                if (br && br.tagName === 'BR') br.remove();
                                el.remove();
                            }
                        }
                    });
                    fillViewport();
                })
                .catch(() => {});
        }

        function pollReplyCounts() {
            const btns = document.querySelectorAll('.reply-count-btn[data-post-id]');
            if (!btns.length) return;
            const ids = Array.from(btns).map(b => b.getAttribute('data-post-id'));
            fetch('/feed/reply-counts?' + ids.map(id => 'id=' + id).join('&'))
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                    if (!data || !data.counts) return;
                    btns.forEach(btn => {
                        const id = btn.getAttribute('data-post-id');
                        if (id in data.counts) btn.textContent = data.counts[id] + ' Replies';
                    });
                })
                .catch(() => {});
        }

        setInterval(pollFeed, 4000);
        setInterval(pollDeletions, 5000);
        setInterval(pollReplyCounts, 5000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollFeed(); pollDeletions(); pollReplyCounts(); } });

        const searchInput = document.getElementById('feed-search-input');
        const searchClear = document.getElementById('feed-search-clear');
        const searchResults = document.getElementById('feed-search-results');
        const mainPosts = document.getElementById('posts');
        const postFormContainer = document.getElementById('post-form-container');
        let searchTimer = null;

        function showSearchResults(html) {
            searchResults.innerHTML = html;
            searchResults.querySelectorAll('.post-time[data-ts]').forEach(el => {
                el.textContent = new Date(el.getAttribute('data-ts')).toLocaleString('en-GB');
            });
            searchResults.querySelectorAll('.button').forEach(btn => {
                btn.addEventListener('mousedown', () => { btn.classList.add('clicked'); setTimeout(() => btn.classList.remove('clicked'), 150); });
            });
            searchResults.style.display = 'block';
            mainPosts.style.display = 'none';
            postFormContainer.style.display = 'none';
        }

        function clearSearch() {
            searchInput.value = '';
            searchClear.style.display = 'none';
            searchResults.style.display = 'none';
            searchResults.innerHTML = '';
            mainPosts.style.display = '';
            postFormContainer.style.display = '';
        }

        searchInput.addEventListener('input', function () {
            const q = this.value.trim();
            searchClear.style.display = q ? 'block' : 'none';
            clearTimeout(searchTimer);
            if (!q) { clearSearch(); return; }
            searchTimer = setTimeout(() => {
                fetch('/feed/search?q=' + encodeURIComponent(q))
                    .then(r => r.ok ? r.json() : null)
                    .then(data => {
                        if (!data) return;
                        if (!data.html) {
                            showSearchResults('<p id="feed-search-no-results">No results found.</p>');
                        } else {
                            showSearchResults(data.html);
                        }
                    })
                    .catch(() => {});
            }, 300);
        });

        searchClear.addEventListener('click', clearSearch);

        searchInput.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') clearSearch();
        });

        let oldestPostId = ${oldestPostId};
        let hasMore = ${hasMoreInitial ? 'true' : 'false'};
        let loadingOlder = false;

        function fetchOlderPosts() {
            if (!hasMore || loadingOlder || oldestPostId === 0) return Promise.resolve(false);
            loadingOlder = true;
            return fetch('/feed/older?before=' + oldestPostId)
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                    if (!data) { loadingOlder = false; return false; }
                    hasMore = data.hasMore;
                    if (data.html) {
                        const postsEl = document.getElementById('posts');
                        const sentinel = document.getElementById('load-more-sentinel');
                        const temp = document.createElement('div');
                        temp.innerHTML = data.html;
                        while (temp.firstChild) {
                            postsEl.insertBefore(temp.firstChild, sentinel);
                        }
                        postsEl.querySelectorAll('.post-time[data-ts]').forEach(el => {
                            if (!el.textContent.trim()) el.textContent = new Date(el.getAttribute('data-ts')).toLocaleString('en-GB');
                        });
                        oldestPostId = data.oldestId;
                    }
                    loadingOlder = false;
                    return hasMore;
                })
                .catch(() => { loadingOlder = false; return false; });
        }

        function loadOlderPosts() {
            if (!hasMore || loadingOlder || oldestPostId === 0) return;
            document.getElementById('load-more-spinner').style.display = 'block';
            fetchOlderPosts().then(() => {
                document.getElementById('load-more-spinner').style.display = 'none';
            });
        }

        function fillViewport() {
            if (!hasMore || loadingOlder || oldestPostId === 0) return;
            if (scrollContainer.scrollHeight > scrollContainer.clientHeight + 150) return;
            fetchOlderPosts().then(() => { fillViewport(); });
        }

        const scrollContainer = document.getElementById('posts');
        scrollContainer.addEventListener('scroll', () => {
            const nearBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < 150;
            if (nearBottom) loadOlderPosts();
        });
        fillViewport();

        function toggleNav() {
            const nav = document.getElementById('nav-dropdown');
            const btn = document.getElementById('nav-hamburger');
            nav.classList.toggle('open');
            btn.textContent = nav.classList.contains('open') ? '✕' : '☰';
        }
        document.addEventListener('click', function(e) {
            const btn = document.getElementById('nav-hamburger');
            const nav = document.getElementById('nav-dropdown');
            if (nav && !nav.contains(e.target) && e.target !== btn) {
                nav.classList.remove('open');
                btn.textContent = '☰';
            }
        });
    </script>
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}

</body>
</html>`);
    });
    });
});

	const rateLimit = require('express-rate-limit');
const postRateLimiter = rateLimit({
    windowMs: 5 * 1000,
    max: 10,
    message: 'please stop spamming',
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
        const replyTo = req.body && req.body.reply_to ? parseInt(req.body.reply_to) : null;
        const backTo = replyTo ? `/post/${replyTo}` : '/feed';
        //res.redirect(429, `${backTo}?posterror=ratelimit`);
        res.status(429).send("please stop spamming");
    }
});
app.post('/feed/post', postRateLimiter, (req, res, next) => {
    uploadFeed.array('attachments', MAX_FILES_FEED)(req, res, (err) => {
        if (err) {
            const backTo = req.body && req.body.reply_to ? `/post/${parseInt(req.body.reply_to)}` : '/feed';
            if (err.code === 'LIMIT_FILE_COUNT') return res.redirect(`${backTo}?posterror=files`);
            return res.redirect(`${backTo}?posterror=1`);
        }
        next();
    });
}, (req, res) => {
    if (!req.session.userId) return res.redirect('/');

    const { content, reply_to } = req.body;
    const files = req.files || [];
    const filesMeta = files.map(f => ({ path: f.path, name: f.originalname }));
    const filesJSON = filesMeta.length ? JSON.stringify(filesMeta) : null;
    // Keep the legacy single-file columns populated with the first attachment so
    // any old code path that still reads file_path/file_name keeps working.
    const filePath = files[0] ? files[0].path : null;
    const fileName = files[0] ? files[0].originalname : null;
    const replyTo = reply_to ? parseInt(reply_to) : null;
    const backTo = replyTo ? `/post/${replyTo}` : '/feed';

    if ((!content || !content.trim()) && !files.length) return res.redirect(backTo);
    if (content && content.length > MAX_POST_LENGTH) return res.redirect(`${backTo}?posterror=1`);

    db.run(
        `INSERT INTO Posts (user_id, username, content, file_path, file_name, files_json, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [req.session.userId, req.session.userUsername, (content || '').trim(), filePath, fileName, filesJSON, replyTo],
        function (err) {
            if (err) console.error('Post insert error:', err.message);
            else {
                const newId = this.lastID;
                const skipUsernames = [];
                const notifyMentions = () => processMentions(content, req.session.userUsername, { type: 'mention_post', post_id: newId, skipUsernames });
                if (replyTo) {
                    db.get(`SELECT username FROM Posts WHERE id = ?`, [replyTo], (err2, parent) => {
                        if (!err2 && parent) {
                            const preview = (content || '').trim().slice(0, 140);
                            createNotification({ username: parent.username, type: 'reply', actor_username: req.session.userUsername, post_id: replyTo, content_preview: preview });
                            skipUsernames.push(parent.username);
                        }
                        notifyMentions();
                    });
                } else {
                    notifyMentions();
                }
            }
            return res.redirect(backTo);
        }
    );
});

app.post('/feed/delete/:id', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const postId = parseInt(req.params.id);
    db.get(`SELECT username FROM Posts WHERE id = ?`, [postId], (err, post) => {
        if (err || !post) return res.status(404).end();
        if (post.username !== req.session.userUsername && !req.isAdmin) return res.status(403).end();
        db.run(`DELETE FROM Posts WHERE id = ?`, [postId], (err) => {
            if (err) console.error('Delete error:', err.message);
            res.status(200).end();
        });
    });
});

app.get('/feed/exists', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    let ids = req.query.id;
    if (!ids) return res.json({ existing: [] });
    if (!Array.isArray(ids)) ids = [ids];
    const intIds = ids.map(Number).filter(Boolean);
    if (!intIds.length) return res.json({ existing: [] });
    db.all(`SELECT id FROM Posts WHERE id IN (${intIds.map(() => '?').join(',')})`, intIds, (err, rows) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({ existing: (rows || []).map(r => r.id) });
    });
});

app.get('/feed/reply-counts', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    let ids = req.query.id;
    if (!ids) return res.json({ counts: {} });
    if (!Array.isArray(ids)) ids = [ids];
    const intIds = ids.map(Number).filter(Boolean);
    if (!intIds.length) return res.json({ counts: {} });
    db.all(
        `SELECT reply_to AS post_id, COUNT(*) AS cnt FROM Posts WHERE reply_to IN (${intIds.map(() => '?').join(',')}) GROUP BY reply_to`,
        intIds,
        (err, rows) => {
            if (err) return res.status(500).json({ error: 'db error' });
            const counts = {};
            intIds.forEach(id => counts[id] = 0);
            (rows || []).forEach(r => counts[r.post_id] = r.cnt);
            res.json({ counts });
        }
    );
});

app.get('/feed/search', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ html: '' });
    const like = '%' + q + '%';
    db.all(
        `SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, (SELECT COUNT(*) FROM Posts AS Replies WHERE Replies.reply_to = Posts.id) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE (Posts.content LIKE ? OR Posts.username LIKE ?) AND Posts.reply_to IS NULL ORDER BY Posts.created_at DESC LIMIT 30`,
        [like, like],
        (err, posts) => {
            if (err) return res.status(500).json({ error: 'db error' });
            if (!posts || !posts.length) return res.json({ html: '' });
            const html = buildPostListHTML(posts, req.session.userUsername, 350, req.isAdmin);
            res.json({ html });
        }
    );
});

app.get('/feed/older', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const sessionUsername = req.session.userUsername;
    const beforeId = parseInt(req.query.before) || 0;
    if (!beforeId) return res.json({ html: '', hasMore: false, oldestId: 0 });

    db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, (SELECT COUNT(*) FROM Posts AS Replies WHERE Replies.reply_to = Posts.id) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.id < ? ORDER BY Posts.created_at DESC LIMIT 10`, [beforeId], (err, posts) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!posts || !posts.length) return res.json({ html: '', hasMore: false, oldestId: 0 });

        const hasMore = posts.length === 10;
        const oldestId = Math.min(...posts.map(p => p.id));

        const html = buildFeedHTML(posts, sessionUsername, 350, req.isAdmin);
        res.json({ html, hasMore, oldestId });
    });
});

app.get('/feed/poll', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const sessionUsername = req.session.userUsername;
    const afterId = parseInt(req.query.after) || 0;

    db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, (SELECT COUNT(*) FROM Posts AS Replies WHERE Replies.reply_to = Posts.id) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.id > ? ORDER BY Posts.created_at DESC`, [afterId], (err, newPosts) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!newPosts || !newPosts.length) return res.json({ html: '', lastId: afterId });

        const lastId = Math.max(...newPosts.map(p => p.id));

        const html = buildFeedHTML(newPosts, sessionUsername, 350, req.isAdmin);
        res.json({ html, lastId });
    });
});

function getFollowingList(username, cb) {
    db.all(`SELECT following_username FROM Follows WHERE follower_username = ?`, [username], (err, rows) => {
        if (err || !rows) return cb([username]);
        const list = rows.map(r => r.following_username);
        list.push(username);
        cb(list);
    });
}

app.get('/following-feed', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const sessionUsername = req.session.userUsername;

    getFollowingList(sessionUsername, (followingList) => {
        const placeholders = followingList.map(() => '?').join(',');

        db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, (SELECT COUNT(*) FROM Posts AS Replies WHERE Replies.reply_to = Posts.id) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.username IN (${placeholders}) ORDER BY Posts.created_at DESC LIMIT 10`,
            followingList, (err, posts) => {
            if (err) { console.error(err); return res.status(500).send('Error loading feed'); }

            const oldestPostId = posts.length ? Math.min(...posts.map(p => p.id)) : 0;
            const hasMoreInitial = posts.length === 10;
            const newestPostId = posts.length ? Math.max(...posts.map(p => p.id)) : 0;

            const postsHTML = buildFeedHTML(posts, sessionUsername, 350, req.isAdmin);

            res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Following Feed</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
<style>
    body { margin: 0; overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
    #feed-wrapper { display: flex; flex-direction: column; height: 100vh; width: 100vw; box-sizing: border-box; border-radius: 0; border: none; }
    #feed-topbar { position: fixed; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: black; border-bottom: 2px solid white; z-index: 100; gap: 12px; }
    #feed-topbar-left { font-size: 0.95em; white-space: nowrap; }
    #feed-topbar-right a { color: rgb(0,191,255); margin-left: 15px; text-decoration: none; white-space: nowrap; }
    #feed-topbar-right a:hover { text-decoration: underline; }
    #feed-topbar-right a.active { color: white; font-weight: bold; pointer-events: none; }
    #nav-hamburger { display: none; background: none; border: 2px solid white; border-radius: 6px; color: white; font-size: 1.1em; cursor: pointer; padding: 4px 8px; line-height: 1; }
    #nav-dropdown { display: none; flex-direction: column; position: absolute; top: 100%; right: 0; background: black; border: 2px solid white; border-radius: 10px; padding: 8px 0; min-width: 160px; z-index: 200; }
    #nav-dropdown a { display: block; color: rgb(0,191,255); text-decoration: none; padding: 8px 18px; white-space: nowrap; margin: 0; }
    #nav-dropdown a:hover { background: rgba(255,255,255,0.08); text-decoration: underline; }
    #nav-dropdown a.active { color: white; font-weight: bold; pointer-events: none; }
    #nav-dropdown.open { display: flex; }
    @media (max-width: 1200px) {
        #feed-topbar-right > a { display: none; }
        #nav-hamburger { display: inline-block; }
    }
    #posts { flex: 1; overflow-y: auto; padding: 70px 20px 130px 20px; text-align: center; }
    #post-form-container { position: fixed; bottom: 0; left: 0; right: 0; background: black; border-top: 2px solid white; padding: 10px 20px; z-index: 100; }
    #reply-indicator { font-size: 0.85em; opacity: 0.7; display: none; margin-bottom: 6px; text-align: center; }
    #post-form-row { display: flex; align-items: center; gap: 10px; width: 100%; }
    #post-form-row textarea { text-align: left; flex: 1; height: 44px; resize: none; min-width: 0; background: black; color: white; border: 2px solid white; border-radius: 10px; padding: 8px; font-family: inherit; font-size: inherit; box-sizing: border-box; }
    #file-name-display { font-size: 0.78em; opacity: 0.65; text-align: center; margin-top: 4px; }
    .post { max-width: 600px; margin: 0 auto; text-align: left; }
    .post-actions { margin-top: 6px; display: flex; align-items: center; gap: 8px; }
    .post-action-btn { padding: 0 !important; height: 44px !important; width: 70px !important; font-size: 0.85em !important; line-height: 1 !important; box-sizing: border-box !important; border: 5px solid white; margin: 0; text-align: center; border-radius: 15px; color: white; background-color: black; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; transition: 0.2s; }
    .post-action-btn:hover { background-color: white; color: black; }
    .post-action-btn.clicked { background-color: black !important; color: white !important; }
</style>
</head>
<body>
    <div id="feed-wrapper" class="box" style="color: white; animation: none !important;">
        <div id="feed-topbar">
            <div id="feed-topbar-left">Logged in as <strong>${sessionUsername}</strong></div>
            <div id="feed-topbar-right" style="position:relative;display:flex;align-items:center;">
                <a href="/v86">v86</a>
                <a href="/editor">HTML Editor</a>
                <a href="/edit">Dashboard</a>
                <a href="/notifications" class="notif-nav-link">Notifications</a>
                <a href="/friends">Friends</a>
                <a href="/feed">All Posts</a>
                <a href="/following-feed" class="active">Following Feed</a>
                ${req.isAdmin ? `<a href="/admin/dashboard">Admin Dashboard</a>` : ''}
                <a href="/logout">Logout</a>
                <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
                <nav id="nav-dropdown">
                    <a href="/v86">v86</a>
                    <a href="/editor">HTML Editor</a>
                    <a href="/edit">Dashboard</a>
                    <a href="/notifications" class="notif-nav-link">Notifications</a>
                    <a href="/friends">Friends</a>
                    <a href="/feed">All Posts</a>
                    <a href="/following-feed" class="active">Following Feed</a>
                    ${req.isAdmin ? `<a href="/admin/dashboard">Admin Dashboard</a>` : ''}
                    <a href="/logout">Logout</a>
                </nav>
            </div>
        </div>

        <div id="posts" style="color: white;">
            ${postsHTML || `<p id="no-posts-msg" style="opacity:0.5;margin-top:40px;">No posts yet from people you follow.</p>`}
            <div id="load-more-sentinel" style="height:1px;"></div>
            <div id="load-more-spinner" style="display:none;text-align:center;opacity:0.5;padding:16px 0;">Loading…</div>
        </div>

        <div id="post-form-container">
            <div id="reply-indicator">> Replying to <span id="reply-to-name"></span> - <a href="#" onclick="clearReply();return false;" style="color:rgb(0,191,255);">Cancel</a></div>
            <form action="/feed/post" method="POST" enctype="multipart/form-data">
                <input type="hidden" name="reply_to" id="reply-to-input" value="">
                <div id="post-form-row">
                    <textarea name="content" id="post-content" placeholder="What's on your mind?" maxlength="1000"></textarea>
                    <input type="file" name="attachments" id="attachment" multiple style="display:none;">
                    <label for="attachment" class="button post-action-btn" id="file-label" style="width:70px !important; height: 25px; padding: 10px;">Browse</label>
                    <button class="button post-action-btn" type="submit" style="width:60px !important; height: 25px;">Post</button>
                </div>
                <div id="file-name-display">No file chosen</div>
                <div id="post-char-counter" style="font-size:0.75em;opacity:0.5;text-align:right;margin-top:2px;">0 / 1000</div>
            </form>
        </div>
    </div>

    <script>
        document.querySelectorAll('.post-time').forEach(el => {
            const ts = el.getAttribute('data-ts');
            if (ts) el.textContent = new Date(ts).toLocaleString('en-GB');
        });

        document.getElementById('attachment').addEventListener('change', function () {
            const n = this.files.length;
            document.getElementById('file-name-display').textContent = n === 0 ? 'No file chosen' : n === 1 ? this.files[0].name : n + ' files selected (max 5)';
        });

        const postContent = document.getElementById('post-content');
        const postCounter = document.getElementById('post-char-counter');
        postContent.addEventListener('input', function () {
            const len = this.value.length;
            postCounter.textContent = len + ' / 1000';
            postCounter.style.color = len > 900 ? (len >= 1000 ? 'rgb(255,80,80)' : 'orange') : '';
            postCounter.style.opacity = len > 900 ? '1' : '0.5';
        });

        if (new URLSearchParams(window.location.search).get('posterror')) {
            const t = document.createElement('div');
            t.textContent = 'Post too long or too many files selected - 1,000 character limit, max 5 files.';
            t.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:white;padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 4000);
            window.history.replaceState(null, '', '/following-feed');
        }

        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => { btn.classList.add('clicked'); setTimeout(() => btn.classList.remove('clicked'), 150); });
        });

        function deletePost(id) {
            fetch('/feed/delete/' + id, { method: 'POST' }).then(r => {
                if (r.ok) {
                    const el = document.getElementById('post-' + id);
                    if (el) {
                        const br = el.nextElementSibling;
                        if (br && br.tagName === 'BR') br.remove();
                        el.remove();
                    }
                }
            });
        }
        function pinPost(id) {
            fetch('/admin/pin/' + id, { method: 'POST' }).then(r => { if (r.ok) location.reload(); });
        }
        function unpinPost(id) {
            fetch('/admin/unpin/' + id, { method: 'POST' }).then(r => { if (r.ok) location.reload(); });
        }

        let lastPostId = (() => {
            const posts = document.querySelectorAll('.post[id^="post-"]');
            let max = ${newestPostId};
            posts.forEach(el => { const n = parseInt(el.id.replace('post-', '')); if (n > max) max = n; });
            return max;
        })();

        function pollFeed() {
            fetch('/following-feed/poll?after=' + lastPostId)
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                    if (!data || !data.html) return;
                    lastPostId = data.lastId;
                    const postsEl = document.getElementById('posts');
                    const noPostsMsg = postsEl.querySelector('#no-posts-msg');
                    if (noPostsMsg) noPostsMsg.remove();
                    const temp = document.createElement('div');
                    temp.innerHTML = data.html;
                    while (temp.firstChild) postsEl.insertBefore(temp.firstChild, postsEl.firstChild);
                    postsEl.querySelectorAll('.post-time[data-ts]').forEach(el => {
                        if (!el.textContent.trim()) el.textContent = new Date(el.getAttribute('data-ts')).toLocaleString('en-GB');
                    });
                })
                .catch(() => {});
        }

        function pollDeletions() {
            const visibleIds = [];
            document.querySelectorAll('.post[id^="post-"]').forEach(el => {
                visibleIds.push(parseInt(el.id.replace('post-', '')));
            });
            if (!visibleIds.length) return;
            fetch('/feed/exists?' + visibleIds.map(id => 'id=' + id).join('&'))
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                    if (!data) return;
                    visibleIds.forEach(id => {
                        if (!data.existing.includes(id)) {
                            const el = document.getElementById('post-' + id);
                            if (el) {
                                const br = el.nextElementSibling;
                                if (br && br.tagName === 'BR') br.remove();
                                el.remove();
                            }
                        }
                    });
                    fillViewport();
                })
                .catch(() => {});
        }

        function pollReplyCounts() {
            const btns = document.querySelectorAll('.reply-count-btn[data-post-id]');
            if (!btns.length) return;
            const ids = Array.from(btns).map(b => b.getAttribute('data-post-id'));
            fetch('/feed/reply-counts?' + ids.map(id => 'id=' + id).join('&'))
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                    if (!data || !data.counts) return;
                    btns.forEach(btn => {
                        const id = btn.getAttribute('data-post-id');
                        if (id in data.counts) btn.textContent = data.counts[id] + ' Replies';
                    });
                })
                .catch(() => {});
        }

        setInterval(pollFeed, 4000);
        setInterval(pollDeletions, 5000);
        setInterval(pollReplyCounts, 5000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollFeed(); pollDeletions(); pollReplyCounts(); } });

        let oldestPostId = ${oldestPostId};
        let hasMore = ${hasMoreInitial ? 'true' : 'false'};
        let loadingOlder = false;

        function fetchOlderPosts() {
            if (!hasMore || loadingOlder || oldestPostId === 0) return Promise.resolve(false);
            loadingOlder = true;
            return fetch('/following-feed/older?before=' + oldestPostId)
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                    if (!data) { loadingOlder = false; return false; }
                    hasMore = data.hasMore;
                    if (data.html) {
                        const postsEl = document.getElementById('posts');
                        const sentinel = document.getElementById('load-more-sentinel');
                        const temp = document.createElement('div');
                        temp.innerHTML = data.html;
                        while (temp.firstChild) postsEl.insertBefore(temp.firstChild, sentinel);
                        postsEl.querySelectorAll('.post-time[data-ts]').forEach(el => {
                            if (!el.textContent.trim()) el.textContent = new Date(el.getAttribute('data-ts')).toLocaleString('en-GB');
                        });
                        oldestPostId = data.oldestId;
                    }
                    loadingOlder = false;
                    return hasMore;
                })
                .catch(() => { loadingOlder = false; return false; });
        }

        function loadOlderPosts() {
            if (!hasMore || loadingOlder || oldestPostId === 0) return;
            document.getElementById('load-more-spinner').style.display = 'block';
            fetchOlderPosts().then(() => {
                document.getElementById('load-more-spinner').style.display = 'none';
            });
        }

        function fillViewport() {
            if (!hasMore || loadingOlder || oldestPostId === 0) return;
            if (scrollContainer.scrollHeight > scrollContainer.clientHeight + 150) return;
            fetchOlderPosts().then(() => { fillViewport(); });
        }

        const scrollContainer = document.getElementById('posts');
        scrollContainer.addEventListener('scroll', () => {
            const nearBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < 150;
            if (nearBottom) loadOlderPosts();
        });
        fillViewport();

        function clearReply() {
            document.getElementById('reply-to-input').value = '';
            document.getElementById('reply-indicator').style.display = 'none';
        }

        function toggleNav() {
            const nav = document.getElementById('nav-dropdown');
            const btn = document.getElementById('nav-hamburger');
            nav.classList.toggle('open');
            btn.textContent = nav.classList.contains('open') ? '✕' : '☰';
        }
        document.addEventListener('click', function(e) {
            const btn = document.getElementById('nav-hamburger');
            const nav = document.getElementById('nav-dropdown');
            if (nav && !nav.contains(e.target) && e.target !== btn) {
                nav.classList.remove('open');
                btn.textContent = '☰';
            }
        });
    </script>
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}

</body>
</html>`);
        });
    });
});

app.get('/following-feed/poll', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const sessionUsername = req.session.userUsername;
    const afterId = parseInt(req.query.after) || 0;

    getFollowingList(sessionUsername, (followingList) => {
        const placeholders = followingList.map(() => '?').join(',');
        db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, (SELECT COUNT(*) FROM Posts AS Replies WHERE Replies.reply_to = Posts.id) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.username IN (${placeholders}) AND Posts.id > ? ORDER BY Posts.created_at DESC`,
            [...followingList, afterId], (err, newPosts) => {
            if (err) return res.status(500).json({ error: 'db error' });
            if (!newPosts || !newPosts.length) return res.json({ html: '', lastId: afterId });
            const lastId = Math.max(...newPosts.map(p => p.id));
            const html = buildFeedHTML(newPosts, sessionUsername, 350, req.isAdmin);
            res.json({ html, lastId });
        });
    });
});

app.get('/following-feed/older', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const sessionUsername = req.session.userUsername;
    const beforeId = parseInt(req.query.before) || 0;
    if (!beforeId) return res.json({ html: '', hasMore: false, oldestId: 0 });

    getFollowingList(sessionUsername, (followingList) => {
        const placeholders = followingList.map(() => '?').join(',');
        db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, (SELECT COUNT(*) FROM Posts AS Replies WHERE Replies.reply_to = Posts.id) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.username IN (${placeholders}) AND Posts.id < ? ORDER BY Posts.created_at DESC LIMIT 10`,
            [...followingList, beforeId], (err, posts) => {
            if (err) return res.status(500).json({ error: 'db error' });
            if (!posts || !posts.length) return res.json({ html: '', hasMore: false, oldestId: 0 });
            const hasMore = posts.length === 10;
            const oldestId = Math.min(...posts.map(p => p.id));
            const html = buildFeedHTML(posts, sessionUsername, 350, req.isAdmin);
            res.json({ html, hasMore, oldestId });
        });
    });
});

app.get('/post/:id', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const postId = parseInt(req.params.id);
    if (!postId) return res.status(404).send('Post not found');
    const sessionUsername = req.session.userUsername;

    db.get(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, (SELECT COUNT(*) FROM Posts AS Replies WHERE Replies.reply_to = Posts.id) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.id = ?`, [postId], (err, rootPost) => {
        if (err) { console.error(err); return res.status(500).send('Error loading post'); }
        if (!rootPost) return res.status(404).send('Post not found');

        const renderPage = (parentPost) => {
            const parentContextHTML = !rootPost.reply_to ? '' : (parentPost
                ? `<div class="reply-context"><a href="/post/${parentPost.id}" style="color:rgb(0,191,255);text-decoration:none;">> Replying to @${escapeHTML(parentPost.username)}</a></div>`
                : `<div class="reply-context" style="opacity:0.4;">> Replying to a deleted post</div>`);

            db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, (SELECT COUNT(*) FROM Posts AS Replies WHERE Replies.reply_to = Posts.id) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.reply_to = ? ORDER BY Posts.created_at DESC LIMIT 10`, [postId], (err2, replies) => {
                if (err2) { console.error(err2); return res.status(500).send('Error loading replies'); }

                const oldestReplyId = replies.length ? Math.min(...replies.map(p => p.id)) : 0;
                const hasMoreInitial = replies.length === 10;
                const newestReplyId = replies.length ? Math.max(...replies.map(p => p.id)) : 0;
                const repliesHTML = buildPostListHTML(replies, sessionUsername, 350, req.isAdmin);

                res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Post</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
<style>
    body { margin: 0; overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
    #feed-wrapper { display: flex; flex-direction: column; height: 100vh; width: 100vw; box-sizing: border-box; border-radius: 0; border: none; }
    #feed-topbar { position: fixed; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: black; border-bottom: 2px solid white; z-index: 100; }
    #feed-topbar-left { font-size: 0.95em; }
    #feed-topbar-right { position: relative; display: flex; align-items: center; }
    #feed-topbar-right a { color: rgb(0,191,255); margin-left: 15px; text-decoration: none; }
    #feed-topbar-right a:hover { text-decoration: underline; }
    #nav-hamburger { display: none; background: none; border: 2px solid white; border-radius: 6px; color: white; font-size: 1.1em; cursor: pointer; padding: 4px 8px; line-height: 1; margin-left: 10px; }
    #nav-dropdown { display: none; flex-direction: column; position: absolute; top: 100%; right: 0; background: black; border: 2px solid white; border-radius: 10px; padding: 8px 0; min-width: 160px; z-index: 200; }
    #nav-dropdown a { display: block; color: rgb(0,191,255); text-decoration: none; padding: 8px 18px; white-space: nowrap; margin: 0; }
    #nav-dropdown a:hover { background: rgba(255,255,255,0.08); text-decoration: underline; }
    #nav-dropdown.open { display: flex; }
    @media (max-width: 600px) {
        #feed-topbar-right > a { display: none; }
        #nav-hamburger { display: inline-block; }
    }
    #posts { flex: 1; overflow-y: auto; padding: 70px 20px 130px 20px; text-align: center; }
    #post-form-container { position: fixed; bottom: 0; left: 0; right: 0; background: black; border-top: 2px solid white; padding: 10px 20px; z-index: 100; }
    #post-form-row { display: flex; align-items: center; gap: 10px; width: 100%; }
    #post-form-row textarea { text-align: left;  flex: 1; height: 44px; resize: none; min-width: 0; background: black; color: white; border: 2px solid white; border-radius: 10px; padding: 8px; font-family: inherit; font-size: inherit; box-sizing: border-box; }
    #file-name-display { font-size: 0.78em; opacity: 0.65; text-align: center; margin-top: 4px; }
    .post { max-width: 600px; margin: 0 auto; text-align: left; }
    .post-actions { margin-top: 6px; display: flex; align-items: center; gap: 8px; }
    .post-action-btn { padding: 0 !important; height: 44px !important; width: 70px !important; font-size: 0.85em !important; line-height: 1 !important; box-sizing: border-box !important; border: 5px solid white; margin: 0; text-align: center; border-radius: 15px; color: white; background-color: black;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: 0.2s;
    }
    .post-action-btn:hover {
    background-color: white;
    color: black;
    }
    .post-action-btn.clicked {
        background-color: black !important;
        color: white !important;
    }
    #thread-root { max-width: 600px; margin: 0 auto; text-align: left; }
    .reply-context { font-size: 0.8em; opacity: 0.6; margin-bottom: 6px; }
    #thread-divider { max-width: 600px; margin: 16px auto 18px; display: flex; align-items: center; gap: 10px; }
    #thread-divider .line { flex: 1; height: 1px; background: rgba(255,255,255,0.2); }
    #thread-divider span { font-size: 0.75em; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.5; flex-shrink: 0; }
</style>
</head>
<body>
    <div id="feed-wrapper" class="box" style="color: white; animation: none !important;">
        <div id="feed-topbar">
            <div id="feed-topbar-left">Logged in as <strong>${req.session.userUsername}</strong></div>
            <div id="feed-topbar-right" style="position:relative;display:flex;align-items:center;">
                <a href="/feed">Feed</a>
                <a href="/edit">Dashboard</a>
                <a href="/notifications" class="notif-nav-link">Notifications</a>
                <a href="/logout">Logout</a>
                <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
                <nav id="nav-dropdown">
                    <a href="/feed">Feed</a>
                    <a href="/edit">Dashboard</a>
                    <a href="/notifications" class="notif-nav-link">Notifications</a>
                    <a href="/logout">Logout</a>
                </nav>
            </div>
        </div>

        <div id="posts" style="color: white;">
            <div id="thread-root">
                ${parentContextHTML}
                <div class="post" id="root-post-${rootPost.id}">
                    ${renderFeedPost(rootPost, sessionUsername, 350, req.isAdmin)}
                </div>
            </div>

            <div id="thread-divider">
                <div class="line"></div>
                <span><span id="reply-count-num">${rootPost.reply_count || 0}</span> Replies</span>
                <div class="line"></div>
            </div>

            <div id="replies-top-anchor" style="height:1px;"></div>
            ${repliesHTML.length ? repliesHTML : '<p id="no-replies-msg" style="opacity:0.4;">No replies yet.</p>'}
            <div id="load-more-sentinel" style="height:1px;"></div>
            <div id="load-more-spinner" style="display:none;text-align:center;padding:16px;opacity:0.5;font-size:0.9em;">Loading older replies…</div>
        </div>

        <div id="post-form-container">
            <form action="/feed/post" method="POST" enctype="multipart/form-data" id="post-form">
                <input type="hidden" name="reply_to" value="${rootPost.id}">
                <div id="post-form-row">
                    <textarea class="box" name="content" id="post-content" placeholder="Write a reply…" style="background-color:black;color:white;font-family:inherit;font-size:inherit;padding:8px;" maxlength="1000"></textarea>
                    <input type="file" id="attachment" name="attachments" multiple style="display:none;">
                    <label for="attachment" class="button post-action-btn" id="file-label" style="width:70px !important; height: 25px; padding: 10px;">Browse</label>
                    <button class="button post-action-btn" type="submit" style="width:60px !important; height: 25px;">Reply</button>
                </div>
                <div id="file-name-display">No file chosen</div>
                <div id="post-char-counter" style="font-size:0.75em;opacity:0.5;text-align:right;margin-top:2px;">0 / 1000</div>
            </form>
        </div>
    </div>

    <script>
        document.querySelectorAll('.post-time').forEach(el => {
            const ts = el.getAttribute('data-ts');
            if (ts) el.textContent = new Date(ts).toLocaleString('en-GB');
        });

        document.getElementById('attachment').addEventListener('change', function () {
            const n = this.files.length;
            document.getElementById('file-name-display').textContent = n === 0 ? 'No file chosen' : n === 1 ? this.files[0].name : n + ' files selected (max 5)';
        });

        const postContent = document.getElementById('post-content');
        const postCounter = document.getElementById('post-char-counter');
        postContent.addEventListener('input', function () {
            const len = this.value.length;
            postCounter.textContent = len + ' / 1000';
            postCounter.style.color = len > 900 ? (len >= 1000 ? 'rgb(255,80,80)' : 'orange') : '';
            postCounter.style.opacity = len > 900 ? '1' : '0.5';
        });

        if (new URLSearchParams(window.location.search).get('posterror')) {
            const t = document.createElement('div');
            t.textContent = 'Reply too long or too many files selected - 1,000 character limit, max 5 files.';
            t.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:white;padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 4000);
            window.history.replaceState(null, '', '/post/${rootPost.id}');
        }
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => {
                btn.classList.add('clicked');
                setTimeout(() => btn.classList.remove('clicked'), 150);
            });
        });

        function toggleNav() {
            const dropdown = document.getElementById('nav-dropdown');
            const btn = document.getElementById('nav-hamburger');
            dropdown.classList.toggle('open');
            btn.textContent = dropdown.classList.contains('open') ? '✕' : '☰';
        }
        document.addEventListener('click', function(e) {
            const dropdown = document.getElementById('nav-dropdown');
            const btn = document.getElementById('nav-hamburger');
            if (dropdown && btn && !dropdown.contains(e.target) && e.target !== btn) {
                dropdown.classList.remove('open');
                btn.textContent = '☰';
            }
        });

        const ROOT_ID = ${rootPost.id};

        function deletePost(id) {
            fetch('/feed/delete/' + id, { method: 'POST' }).then(r => {
                if (!r.ok) return;
                if (id === ROOT_ID) {
                    window.location.href = '/feed';
                    return;
                }
                const el = document.getElementById('post-' + id);
                if (el) {
                    const br = el.nextElementSibling;
                    if (br && br.tagName === 'BR') br.remove();
                    el.remove();
                    const counterEl = document.getElementById('reply-count-num');
                    if (counterEl) counterEl.textContent = Math.max(0, (parseInt(counterEl.textContent) || 0) - 1);
                }
            });
        }
        function pinPost(id) {
            fetch('/admin/pin/' + id, { method: 'POST' }).then(r => { if (r.ok) location.reload(); });
        }
        function unpinPost(id) {
            fetch('/admin/unpin/' + id, { method: 'POST' }).then(r => { if (r.ok) location.reload(); });
        }

        let lastReplyId = (() => {
            const items = document.querySelectorAll('.post[id^="post-"]');
            let max = ${newestReplyId};
            items.forEach(el => { const n = parseInt(el.id.replace('post-', '')); if (n > max) max = n; });
            return max;
        })();

        function pollReplies() {
            fetch('/post/' + ROOT_ID + '/poll?after=' + lastReplyId)
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                    if (!data || !data.html) return;
                    lastReplyId = data.lastId;
                    const postsEl = document.getElementById('posts');
                    const noRepliesMsg = postsEl.querySelector('#no-replies-msg');
                    if (noRepliesMsg) noRepliesMsg.remove();
                    const anchor = document.getElementById('replies-top-anchor');
                    const reference = anchor.nextSibling;
                    const temp = document.createElement('div');
                    temp.innerHTML = data.html;
                    const addedCount = temp.querySelectorAll('.post[id^="post-"]').length;
                    while (temp.firstChild) {
                        postsEl.insertBefore(temp.firstChild, reference);
                    }
                    postsEl.querySelectorAll('.post-time[data-ts]').forEach(el => {
                        if (!el.textContent.trim()) el.textContent = new Date(el.getAttribute('data-ts')).toLocaleString('en-GB');
                    });
                    if (addedCount > 0) {
                        const counterEl = document.getElementById('reply-count-num');
                        if (counterEl) counterEl.textContent = (parseInt(counterEl.textContent) || 0) + addedCount;
                    }
                })
                .catch(() => {});
        }

        function pollDeletions() {
            const visibleIds = [ROOT_ID];
            document.querySelectorAll('.post[id^="post-"]').forEach(el => {
                visibleIds.push(parseInt(el.id.replace('post-', '')));
            });
            fetch('/feed/exists?' + visibleIds.map(id => 'id=' + id).join('&'))
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                    if (!data) return;
                    if (!data.existing.includes(ROOT_ID)) {
                        window.location.href = '/feed';
                        return;
                    }
                    visibleIds.forEach(id => {
                        if (id === ROOT_ID) return;
                        if (!data.existing.includes(id)) {
                            const el = document.getElementById('post-' + id);
                            if (el) {
                                const br = el.nextElementSibling;
                                if (br && br.tagName === 'BR') br.remove();
                                el.remove();
                                const counterEl = document.getElementById('reply-count-num');
                                if (counterEl) counterEl.textContent = Math.max(0, (parseInt(counterEl.textContent) || 0) - 1);
                            }
                        }
                    });
                })
                .catch(() => {});
        }

        setInterval(pollReplies, 4000);
        setInterval(pollDeletions, 5000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollReplies(); pollDeletions(); } });

        let oldestReplyId = ${oldestReplyId};
        let hasMore = ${hasMoreInitial ? 'true' : 'false'};
        let loadingOlder = false;

        function loadOlderReplies() {
            if (!hasMore || loadingOlder || oldestReplyId === 0) return;
            loadingOlder = true;
            document.getElementById('load-more-spinner').style.display = 'block';
            fetch('/post/' + ROOT_ID + '/older?before=' + oldestReplyId)
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                    document.getElementById('load-more-spinner').style.display = 'none';
                    if (!data) { loadingOlder = false; return; }
                    hasMore = data.hasMore;
                    if (data.html) {
                        const postsEl = document.getElementById('posts');
                        const sentinel = document.getElementById('load-more-sentinel');
                        const temp = document.createElement('div');
                        temp.innerHTML = data.html;
                        while (temp.firstChild) {
                            postsEl.insertBefore(temp.firstChild, sentinel);
                        }
                        postsEl.querySelectorAll('.post-time[data-ts]').forEach(el => {
                            if (!el.textContent.trim()) el.textContent = new Date(el.getAttribute('data-ts')).toLocaleString('en-GB');
                        });
                        oldestReplyId = data.oldestId;
                    }
                    loadingOlder = false;
                })
                .catch(() => { loadingOlder = false; document.getElementById('load-more-spinner').style.display = 'none'; });
        }

        const scrollContainer = document.getElementById('posts');
        scrollContainer.addEventListener('scroll', () => {
            const nearBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < 150;
            if (nearBottom) loadOlderReplies();
        });
    </script>
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}

</body>
</html>`);
            });
        };

        if (rootPost.reply_to) {
            db.get(`SELECT id, username FROM Posts WHERE id = ?`, [rootPost.reply_to], (perr, parentPost) => {
                renderPage(perr ? null : parentPost);
            });
        } else {
            renderPage(null);
        }
    });
});

app.get('/post/:id/poll', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const sessionUsername = req.session.userUsername;
    const postId = parseInt(req.params.id);
    const afterId = parseInt(req.query.after) || 0;

    db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, (SELECT COUNT(*) FROM Posts AS Replies WHERE Replies.reply_to = Posts.id) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.reply_to = ? AND Posts.id > ? ORDER BY Posts.created_at DESC`, [postId, afterId], (err, newReplies) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!newReplies || !newReplies.length) return res.json({ html: '', lastId: afterId });

        const lastId = Math.max(...newReplies.map(p => p.id));
        const html = buildPostListHTML(newReplies, sessionUsername, 350, req.isAdmin);
        res.json({ html, lastId });
    });
});

app.get('/post/:id/older', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const sessionUsername = req.session.userUsername;
    const postId = parseInt(req.params.id);
    const beforeId = parseInt(req.query.before) || 0;
    if (!beforeId) return res.json({ html: '', hasMore: false, oldestId: 0 });

    db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, (SELECT COUNT(*) FROM Posts AS Replies WHERE Replies.reply_to = Posts.id) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.reply_to = ? AND Posts.id < ? ORDER BY Posts.created_at DESC LIMIT 10`, [postId, beforeId], (err, replies) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!replies || !replies.length) return res.json({ html: '', hasMore: false, oldestId: 0 });

        const hasMore = replies.length === 10;
        const oldestId = Math.min(...replies.map(p => p.id));
        const html = buildPostListHTML(replies, sessionUsername, 350, req.isAdmin);
        res.json({ html, hasMore, oldestId });
    });
});


app.post('/friend-request/send/:username', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const from = req.session.userUsername;
    const to = req.params.username;
    if (from === to) return res.status(400).json({ error: 'cannot friend yourself' });
    db.get(`SELECT id FROM Friends WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)`, [from, to, to, from], (err, row) => {
        if (row) return res.status(400).json({ error: 'already friends' });
        db.run(`INSERT OR IGNORE INTO Friend_Requests (from_user, to_user, status) VALUES (?, ?, 'pending')`, [from, to], function (err2) {
            if (err2) return res.status(500).json({ error: 'db error' });
            if (this.changes > 0) createNotification({ username: to, type: 'friend_request', actor_username: from });
            res.json({ ok: true });
        });
    });
});

app.post('/friend-request/cancel/:username', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const from = req.session.userUsername;
    const to = req.params.username;
    db.run(`DELETE FROM Friend_Requests WHERE from_user = ? AND to_user = ? AND status = 'pending'`, [from, to], (err) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({ ok: true });
    });
});

app.post('/friend-request/accept/:username', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const me = req.session.userUsername;
    const requester = req.params.username;
    db.get(`SELECT id FROM Friend_Requests WHERE from_user = ? AND to_user = ? AND status = 'pending'`, [requester, me], (err, row) => {
        if (!row) return res.status(404).json({ error: 'no such request' });
        db.run(`UPDATE Friend_Requests SET status = 'accepted' WHERE id = ?`, [row.id], (err2) => {
            if (err2) return res.status(500).json({ error: 'db error' });
            const a = [me, requester].sort()[0];
            const b = [me, requester].sort()[1];
            db.run(`INSERT OR IGNORE INTO Friends (user_a, user_b) VALUES (?, ?)`, [a, b], (err3) => {
                if (err3) return res.status(500).json({ error: 'db error' });
                createNotification({ username: requester, type: 'friend_accept', actor_username: me });
                res.json({ ok: true });
            });
        });
    });
});

app.post('/friend-request/decline/:username', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const me = req.session.userUsername;
    const requester = req.params.username;
    db.run(`UPDATE Friend_Requests SET status = 'declined' WHERE from_user = ? AND to_user = ? AND status = 'pending'`, [requester, me], function (err) {
        if (err) return res.status(500).json({ error: 'db error' });
        if (this.changes > 0) createNotification({ username: requester, type: 'friend_decline', actor_username: me });
        res.json({ ok: true });
    });
});

app.post('/unfriend/:username', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const me = req.session.userUsername;
    const other = req.params.username;
    const a = [me, other].sort()[0];
    const b = [me, other].sort()[1];
    db.run(`DELETE FROM Friends WHERE user_a = ? AND user_b = ?`, [a, b], (err) => {
        if (err) return res.status(500).json({ error: 'db error' });
        db.run(`DELETE FROM Friend_Requests WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)`, [me, other, other, me], () => {});
        res.json({ ok: true });
    });
});

app.get('/api/friend-status/:username', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const me = req.session.userUsername;
    const other = req.params.username;
    const a = [me, other].sort()[0];
    const b = [me, other].sort()[1];
    db.get(`SELECT id FROM Friends WHERE user_a = ? AND user_b = ?`, [a, b], (err, friendRow) => {
        if (friendRow) return res.json({ status: 'friends' });
        db.get(`SELECT from_user, status FROM Friend_Requests WHERE ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)) AND status = 'pending'`, [me, other, other, me], (err2, reqRow) => {
            if (!reqRow) return res.json({ status: 'none' });
            if (reqRow.from_user === me) return res.json({ status: 'sent' });
            return res.json({ status: 'received' });
        });
    });
});

app.get('/api/my-friends', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const me = req.session.userUsername;
    db.all(`SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END as username
            FROM Friends WHERE user_a = ? OR user_b = ? ORDER BY created_at DESC`,
        [me, me, me], (err, rows) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({ friends: (rows || []).map(r => r.username) });
    });
});

app.get('/friends', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const me = req.session.userUsername;

    db.all(`SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END as friend_username, User_Data.avatar_path
            FROM Friends LEFT JOIN User_Data ON User_Data.username = CASE WHEN user_a = ? THEN user_b ELSE user_a END
            WHERE user_a = ? OR user_b = ? ORDER BY Friends.created_at DESC`, [me, me, me, me], (err, friends) => {

        db.all(`SELECT Friend_Requests.*, User_Data.avatar_path FROM Friend_Requests LEFT JOIN User_Data ON User_Data.username = Friend_Requests.from_user
                WHERE to_user = ? AND status = 'pending' ORDER BY created_at DESC`, [me], (err2, incoming) => {

            db.all(`SELECT Friend_Requests.*, User_Data.avatar_path FROM Friend_Requests LEFT JOIN User_Data ON User_Data.username = Friend_Requests.to_user
                    WHERE from_user = ? AND status = 'pending' ORDER BY created_at DESC`, [me], (err3, outgoing) => {

                function renderUserRow(username, avatarPath, actionHTML) {
                    return `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.1);">
                        <a href="/user/${escapeHTML(username)}" style="flex-shrink:0;">${renderAvatarHTML(avatarPath, username, 40)}</a>
                        <a href="/user/${escapeHTML(username)}" style="color:white;text-decoration:none;font-weight:bold;flex:1;">${escapeHTML(username)}</a>
                        ${actionHTML}
                    </div>`;
                }

                const friendsHTML = (friends || []).map(f =>
                    renderUserRow(f.friend_username, f.avatar_path,
                        `<a href="/messages/${escapeHTML(f.friend_username)}" class="button" style="padding:6px 12px;text-decoration:none;font-size:0.85em;">Message</a>
                         <button class="button" onclick="unfriend('${escapeHTML(f.friend_username)}')" style="padding:6px 12px;font-size:0.85em;background:rgba(255,60,60,0.15);border-color:rgba(255,60,60,0.6);color:rgb(255,120,120);">Unfriend</button>`)
                ).join('');

                const incomingHTML = (incoming || []).map(r =>
                    renderUserRow(r.from_user, r.avatar_path,
                        `<button class="button" onclick="acceptRequest('${escapeHTML(r.from_user)}')" style="padding:6px 12px;font-size:0.85em;background:rgba(0,191,255,0.15);border-color:rgba(0,191,255,0.6);color:rgb(0,191,255);width: auto;height: 25px;">Accept</button>
                         <button class="button" onclick="declineRequest('${escapeHTML(r.from_user)}')" style="padding:6px 12px;font-size:0.85em;background:rgba(255,60,60,0.08);border-color:rgba(255,60,60,0.4);color:rgb(255,120,120);width: auto;height: 25px;">Decline</button>`)
                ).join('');

                const outgoingHTML = (outgoing || []).map(r =>
                    renderUserRow(r.to_user, r.avatar_path,
                        `<span style="opacity:0.5;font-size:0.85em;">Pending…</span>
                         <button class="button" onclick="cancelRequest('${escapeHTML(r.to_user)}')" style="padding:6px 12px;font-size:0.85em;">Cancel</button>`)
                ).join('');

                res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Friends</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
<style>
    body { margin: 0; background: black; color: white; font-family: 'Quicksand', sans-serif; }
    #friends-topbar { position: fixed; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: black; border-bottom: 2px solid white; z-index: 100; }
    #friends-topbar-left { font-size: 0.95em; }
    #friends-topbar-right a { color: rgb(0,191,255); text-decoration: none; margin-left: 15px; }
    #friends-topbar-right a:hover { text-decoration: underline; }
    #friends-content { max-width: 600px; margin: 80px auto 40px; padding: 0 20px; }
    #nav-hamburger { display: none; background: none; border: 2px solid white; border-radius: 6px; color: white; font-size: 1.1em; cursor: pointer; padding: 4px 8px; line-height: 1; margin-left: 10px; }
    #nav-dropdown { display: none; flex-direction: column; position: absolute; top: 100%; right: 0; background: black; border: 2px solid white; border-radius: 10px; padding: 8px 0; min-width: 160px; z-index: 200; }
    #nav-dropdown a { display: block; color: rgb(0,191,255); text-decoration: none; padding: 8px 18px; white-space: nowrap; margin: 0; }
    #nav-dropdown a:hover { background: rgba(255,255,255,0.08); text-decoration: underline; }
    #nav-dropdown.open { display: flex; }
    @media (max-width: 600px) {
        #friends-topbar-right > a { display: none; }
        #nav-hamburger { display: inline-block; }
    }
    .section-title { font-size: 1.1em; font-weight: 700; margin: 28px 0 8px; opacity: 0.9; }
    .badge { display: inline-block; background: rgb(0,191,255); color: black; border-radius: 10px; font-size: 0.7em; font-weight: 700; padding: 1px 7px; margin-left: 6px; vertical-align: middle; }
</style>
</head>
<body>
    <div id="friends-topbar">
            <div id="friends-topbar-left">Logged in as <strong>${req.session.userUsername}</strong></div>
            <div id="friends-topbar-right" style="position:relative;display:flex;align-items:center;">
                <a href="/feed">Feed</a>
                <a href="/edit">Dashboard</a>
                <a href="/notifications" class="notif-nav-link">Notifications</a>
                <a href="/logout">Logout</a>
                <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
                <nav id="nav-dropdown">
                    <a href="/feed">Feed</a>
                    <a href="/edit">Dashboard</a>
                    <a href="/notifications" class="notif-nav-link">Notifications</a>
                    <a href="/logout">Logout</a>
                </nav>
            </div>
        </div>
    <div id="friends-content">
        <h2 style="margin-bottom:0;">Friends</h2>

        ${(incoming || []).length > 0 ? `
        <div class="section-title">Incoming Requests <span class="badge">${(incoming || []).length}</span></div>
        <div id="incoming-list">${incomingHTML}</div>` : ''}

        ${(outgoing || []).length > 0 ? `
        <div class="section-title">Sent Requests</div>
        <div id="outgoing-list">${outgoingHTML}</div>` : ''}

        <div class="section-title">Your Friends <span style="opacity:0.4;font-size:0.8em;font-weight:400;">(${(friends || []).length})</span></div>
        <div id="friends-list">${friendsHTML || '<p style="opacity:0.4;">No friends yet. Send friend requests from someone\'s profile page.</p>'}</div>
    </div>

    <script>
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => { btn.classList.add('clicked'); setTimeout(() => btn.classList.remove('clicked'), 150); });
        });

        function removeRow(container, username) {
            const rows = document.querySelectorAll('#' + container + ' > div');
            rows.forEach(row => {
                if (row.textContent.includes(username)) row.remove();
            });
        }

        function acceptRequest(username) {
            fetch('/friend-request/accept/' + username, { method: 'POST' })
                .then(r => r.json()).then(d => { if (d.ok) location.reload(); });
        }

        function declineRequest(username) {
            fetch('/friend-request/decline/' + username, { method: 'POST' })
                .then(r => r.json()).then(d => { if (d.ok) location.reload(); });
        }

        function cancelRequest(username) {
            fetch('/friend-request/cancel/' + username, { method: 'POST' })
                .then(r => r.json()).then(d => { if (d.ok) location.reload(); });
        }

        function unfriend(username) {
            if (!confirm('Remove ' + username + ' from friends?')) return;
            fetch('/unfriend/' + username, { method: 'POST' })
                .then(r => r.json()).then(d => { if (d.ok) location.reload(); });
        }
        function toggleNav() {
            const dropdown = document.getElementById('nav-dropdown');
            const btn = document.getElementById('nav-hamburger');
            dropdown.classList.toggle('open');
            btn.textContent = dropdown.classList.contains('open') ? '✕' : '☰';
        }
        document.addEventListener('click', function(e) {
            const dropdown = document.getElementById('nav-dropdown');
            const btn = document.getElementById('nav-hamburger');
            if (dropdown && btn && !dropdown.contains(e.target) && e.target !== btn) {
                dropdown.classList.remove('open');
                btn.textContent = '☰';
            }
        });
    </script>
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}

</body>
</html>`);
            });
        });
    });
});

app.post('/follow/:username', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const follower = req.session.userUsername;
    const following = req.params.username;
    if (follower === following) return res.status(400).json({ error: 'cannot follow yourself' });
    db.run(`INSERT OR IGNORE INTO Follows (follower_username, following_username) VALUES (?, ?)`, [follower, following], (err) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({ ok: true, following: true });
    });
});

app.post('/unfollow/:username', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const follower = req.session.userUsername;
    const following = req.params.username;
    db.run(`DELETE FROM Follows WHERE follower_username = ? AND following_username = ?`, [follower, following], (err) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({ ok: true, following: false });
    });
});

app.get('/followers', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const me = req.session.userUsername;
    db.all(`SELECT f.follower_username, u.avatar_path FROM Follows f LEFT JOIN User_Data u ON f.follower_username = u.username WHERE f.following_username = ? ORDER BY f.created_at DESC`, [me], (err, followers) => {
        const followersHTML = (followers || []).map(f => {
            const avatarHTML = renderAvatarHTML(f.avatar_path, f.follower_username, 36);
            return `<a href="/user/${escapeHTML(f.follower_username)}" style="display:flex;align-items:center;gap:12px;padding:12px 16px;border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:white;text-decoration:none;margin-bottom:10px;transition:background 0.15s;">
                ${avatarHTML}
                <strong>@${escapeHTML(f.follower_username)}</strong>
            </a>`;
        }).join('');
        res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Followers</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
<style>
    body { margin: 0; background: black; color: white; font-family: 'Quicksand', sans-serif; display: flex; flex-direction: column; min-height: 100vh; }
    #followers-topbar { position: fixed; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: black; border-bottom: 2px solid white; z-index: 100; }
    #followers-topbar-left { font-size: 0.95em; }
    #followers-topbar-right { position: relative; display: flex; align-items: center; }
    #followers-topbar-right a { color: rgb(0,191,255); text-decoration: none; margin-left: 15px; }
    #followers-topbar-right a:hover { text-decoration: underline; }
    #nav-hamburger { display: none; background: none; border: 2px solid white; border-radius: 6px; color: white; font-size: 1.1em; cursor: pointer; padding: 4px 8px; line-height: 1; margin-left: 10px; }
    #nav-dropdown { display: none; flex-direction: column; position: absolute; top: 100%; right: 0; background: black; border: 2px solid white; border-radius: 10px; padding: 8px 0; min-width: 160px; z-index: 200; }
    #nav-dropdown a { display: block; color: rgb(0,191,255); text-decoration: none; padding: 8px 18px; white-space: nowrap; margin: 0; }
    #nav-dropdown a:hover { background: rgba(255,255,255,0.08); text-decoration: underline; }
    #nav-dropdown.open { display: flex; }
    @media (max-width: 600px) {
        #followers-topbar-right > a { display: none; }
        #nav-hamburger { display: inline-block; }
    }
    #followers-list { max-width: 600px; width: 100%; margin: 80px auto 40px; padding: 0 20px; box-sizing: border-box; }
</style>
</head>
<body>
    <div id="followers-topbar">
        <div id="followers-topbar-left">Logged in as <strong>${me}</strong></div>
        <div id="followers-topbar-right">
            <a href="/feed">Feed</a>
            <a href="/edit">Dashboard</a>
            <a href="/notifications" class="notif-nav-link">Notifications</a>
            <a href="/logout">Logout</a>
            <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
            <nav id="nav-dropdown">
                <a href="/feed">Feed</a>
                <a href="/edit">Dashboard</a>
                <a href="/notifications" class="notif-nav-link">Notifications</a>
                <a href="/logout">Logout</a>
            </nav>
        </div>
    </div>
    <div id="followers-list">
        <h2>Your Followers <span style="opacity:0.5;font-size:0.7em;">(${(followers || []).length})</span></h2>
        ${followersHTML || '<p style="opacity:0.4;">No followers yet.</p>'}
    </div>
    <script>
        function toggleNav() {
            const dropdown = document.getElementById('nav-dropdown');
            const btn = document.getElementById('nav-hamburger');
            dropdown.classList.toggle('open');
            btn.textContent = dropdown.classList.contains('open') ? '✕' : '☰';
        }
        document.addEventListener('click', function(e) {
            const dropdown = document.getElementById('nav-dropdown');
            const btn = document.getElementById('nav-hamburger');
            if (dropdown && btn && !dropdown.contains(e.target) && e.target !== btn) {
                dropdown.classList.remove('open');
                btn.textContent = '☰';
            }
        });
    </script>
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}

</body>
</html>`);
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

app.get('/user/:username', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const profileUsername = req.params.username;
    const sessionUsername = req.session.userUsername;
    db.get(`SELECT username, Nickname, bio, IsOwner, IsDeveloper, IsSupporter, IsAdmin, IsHeadAdmin, IsBanned, IsDeleted, avatar_path FROM User_Data WHERE username = ?`, [profileUsername], (err, user) => {
        if (err || !user) return res.status(404).send('User not found');
        const isOwnProfile = profileUsername === sessionUsername;
        db.get(`SELECT id FROM Follows WHERE follower_username = ? AND following_username = ?`, [sessionUsername, profileUsername], (ferr, followRow) => {
            const isFollowing = !!followRow;
            db.get(`SELECT COUNT(*) as cnt FROM Follows WHERE following_username = ?`, [profileUsername], (fcerr, followerCount) => {
                const numFollowers = (followerCount && followerCount.cnt) || 0;

                const a = [sessionUsername, profileUsername].sort()[0];
                const b = [sessionUsername, profileUsername].sort()[1];
                db.get(`SELECT id FROM Friends WHERE user_a = ? AND user_b = ?`, [a, b], (ferr2, friendRow) => {
                let friendStatus = 'none';
                const continueRender = (friendStatus) => {
                db.all(`SELECT *, (SELECT COUNT(*) FROM Posts AS Replies WHERE Replies.reply_to = Posts.id) AS reply_count FROM Posts WHERE username = ? ORDER BY created_at DESC`, [profileUsername], (err2, posts) => {
                    const postsHTML = (posts || []).map(post => {
                        const fileHTML = renderAttachmentsHTML(getAttachments(post), 300);
                        return `<div class="post" style="border:1px solid rgba(255,255,255,0.2);border-radius:10px;padding:10px;margin-bottom:14px;text-align:left;">
                            <span class="post-time" data-ts="${post.created_at ? post.created_at.replace(' ', 'T') + 'Z' : ''}" style="font-size:0.8em;opacity:0.6;"></span>
                            <div style="margin-top:4px;word-break:break-word;overflow-wrap:break-word;white-space:pre-wrap;">${escapeHTML(post.content)}</div>
                            ${fileHTML}
                        </div>`;
                    }).join('');

                    const dmBtn = isOwnProfile ? '' : `<a href="/messages/${escapeHTML(profileUsername)}" class="button" style="padding:10px;width:120px;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;">Message</a>`;
                    const followBtn = isOwnProfile ? '' : `<a id="follow-btn" class="button" onclick="toggleFollow()" style="padding:10px;width:120px;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;">${isFollowing ? 'Unfollow' : 'Follow'}</a>`;
                    const friendBtnHTML = isOwnProfile ? '' : `<a id="friend-btn" class="button" onclick="toggleFriend()" style="padding:10px;width:140px;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;">${
                        friendStatus === 'friends' ? 'Unfriend' :
                        friendStatus === 'sent' ? 'Cancel Request' :
                        friendStatus === 'received' ? 'Accept Request' :
                        'Add Friend'
                    }</a>`;
                    const followersLink = isOwnProfile
                        ? `<a href="/followers" style="color:rgba(255,255,255,0.5);text-decoration:none;font-size:0.85em;">${numFollowers} follower${numFollowers !== 1 ? 's' : ''}</a>`
                        : `<span style="color:rgba(255,255,255,0.5);font-size:0.85em;">${numFollowers} follower${numFollowers !== 1 ? 's' : ''}</span>`;

                    res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHTML(user.username)}'s Profile</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
<style>
    body { margin: 0; background: black; color: white; font-family: 'Quicksand', sans-serif; display: flex; flex-direction: column; min-height: 100vh; justify-content: flex-start; align-items: stretch; }
    #profile-topbar { position: fixed; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: black; border-bottom: 2px solid white; z-index: 100; gap: 12px; }
    #profile-topbar-left { font-size: 0.95em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    #profile-topbar-right { position: relative; display: flex; align-items: center; flex-shrink: 0; }
    #profile-topbar-right a { color: rgb(0,191,255); text-decoration: none; margin-left: 15px; white-space: nowrap; }
    #profile-topbar-right a:hover { text-decoration: underline; }
    #profile-nav-hamburger { display: none; background: none; border: 2px solid white; border-radius: 6px; color: white; font-size: 1.1em; cursor: pointer; padding: 4px 8px; line-height: 1; margin-left: 10px; }
    #profile-nav-dropdown { display: none; flex-direction: column; position: absolute; top: 100%; right: 0; background: black; border: 2px solid white; border-radius: 10px; padding: 8px 0; min-width: 160px; z-index: 200; }
    #profile-nav-dropdown a { display: block; color: rgb(0,191,255); text-decoration: none; padding: 8px 18px; white-space: nowrap; margin: 0; }
    #profile-nav-dropdown a:hover { background: rgba(255,255,255,0.08); text-decoration: underline; }
    #profile-nav-dropdown.open { display: flex; }
    @media (max-width: 600px) {
        #profile-topbar-right > a { display: none; }
        #profile-nav-hamburger { display: inline-block; }
    }
    #profile-header { width: min(550px, 80vw); margin: 80px auto 0; padding: 0 20px; text-align: center; box-sizing: border-box; }
    #profile-bio { opacity: 0.75; margin: 8px 0 20px; white-space: pre-wrap; }
    #profile-posts { width: min(550px, 80vw); margin: 20px auto; padding: 0 20px 40px; overflow-x: hidden; box-sizing: border-box; }
    #profile-posts img { max-width: 100%; max-height: 550px; }
    .post { width: 100%; box-sizing: border-box; overflow-x: hidden; word-break: break-word; overflow-wrap: anywhere; }
    .post-time { font-size: 0.8em; opacity: 0.6; }
</style>
</head>
<body>
    <div id="profile-topbar">
        <div id="profile-topbar-left">Logged in as <strong>${sessionUsername}</strong></div>
        <div id="profile-topbar-right">
            <a href="/feed">Feed</a>
            <a href="/edit">Dashboard</a>
            <a href="/notifications" class="notif-nav-link">Notifications</a>
            <a href="/logout">Logout</a>
            <button id="profile-nav-hamburger" onclick="toggleProfileNav()" aria-label="Menu">☰</button>
            <nav id="profile-nav-dropdown">
                <a href="/feed">Feed</a>
                <a href="/edit">Dashboard</a>
                <a href="/notifications" class="notif-nav-link">Notifications</a>
                <a href="/logout">Logout</a>
            </nav>
        </div>
    </div>
    <div id="profile-header">
        <div style="display:flex;justify-content:center;margin-bottom:12px;">
            ${renderAvatarHTML(user.avatar_path, user.username, 100)}
        </div>
        ${(user.IsOwner || user.IsDeveloper || user.IsSupporter || user.IsAdmin || user.IsHeadAdmin || user.IsBanned || user.IsDeleted) ? `<div style="display:flex;gap:8px;justify-content:center;margin-bottom:6px;flex-wrap:wrap;">${user.IsOwner ? '<span style="font-size:0.75em;letter-spacing:0.08em;color:rgb(255,200,50);font-weight:700;text-transform:uppercase;">Owner</span>' : ''}${user.IsHeadAdmin ? '<span style="font-size:0.75em;letter-spacing:0.08em;color:rgb(255, 0, 0);font-weight:700;text-transform:uppercase;">Head Admin</span>' : ''}${user.IsAdmin ? '<span style="font-size:0.75em;letter-spacing:0.08em;color:rgb(255,100,100);font-weight:700;text-transform:uppercase;">Admin</span>' : ''}${user.IsDeveloper ? '<span style="font-size:0.75em;letter-spacing:0.08em;color:rgb(0,191,255);font-weight:700;text-transform:uppercase;">Developer</span>' : ''}${user.IsSupporter ? '<span style="font-size:0.75em;letter-spacing:0.08em;color:rgb(180,100,255);font-weight:700;text-transform:uppercase;">Supporter</span>' : ''}${user.IsDeleted ? '<span style="font-size:0.75em;letter-spacing:0.08em;color:rgb(150,150,150);font-weight:700;text-transform:uppercase;border:1px solid rgb(150,150,150);border-radius:4px;padding:1px 6px;">Deleted</span>' : (user.IsBanned ? '<span style="font-size:0.75em;letter-spacing:0.08em;color:rgb(255,80,80);font-weight:700;text-transform:uppercase;border:1px solid rgb(255,80,80);border-radius:4px;padding:1px 6px;">Banned</span>' : '')}</div>` : ''}
        <h1>${user.Nickname && user.Nickname.trim() ? escapeHTML(user.Nickname.trim()) : '@' + escapeHTML(user.username)}</h1>
        ${user.Nickname && user.Nickname.trim() ? `<div style="opacity:0.5;font-size:0.9em;margin-top:-10px;margin-bottom:6px;">@${escapeHTML(user.username)}</div>` : ''}
        <div style="margin-bottom:8px;">${followersLink}</div>
        <div id="profile-bio">${user.bio ? escapeHTML(user.bio) : '<span style="opacity:0.4;">No bio yet.</span>'}</div>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-bottom:20px;">
            ${dmBtn}
            ${followBtn}
            ${friendBtnHTML}
        </div>
        <hr style="border-color:rgba(255,255,255,0.2);">
    </div>
    <div id="profile-posts">
        <h3 style="text-align:center;opacity:0.6;">Posts</h3>
        ${postsHTML || '<p style="text-align:center;opacity:0.4;">No posts yet.</p>'}
    </div>
    <script>
        document.querySelectorAll('.post-time').forEach(el => {
            const ts = el.getAttribute('data-ts');
            if (ts) el.textContent = new Date(ts).toLocaleString('en-GB');
        });
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => { btn.classList.add('clicked'); setTimeout(() => btn.classList.remove('clicked'), 150); });
        });

        let following = ${isFollowing ? 'true' : 'false'};
        function toggleFollow() {
            const btn = document.getElementById('follow-btn');
            const endpoint = following ? '/unfollow/${escapeHTML(profileUsername)}' : '/follow/${escapeHTML(profileUsername)}';
            btn.disabled = true;
            fetch(endpoint, { method: 'POST' })
                .then(r => r.json())
                .then(data => {
                    following = data.following;
                    btn.textContent = following ? 'Unfollow' : 'Follow';
                    btn.disabled = false;
                })
                .catch(() => { btn.disabled = false; });
        }

        let friendStatus = '${friendStatus}';
        function toggleFriend() {
            const btn = document.getElementById('friend-btn');
            btn.disabled = true;
            let endpoint, method = 'POST';
            if (friendStatus === 'friends') {
                if (!confirm('Remove ${escapeHTML(profileUsername)} from friends?')) { btn.disabled = false; return; }
                endpoint = '/unfriend/${escapeHTML(profileUsername)}';
            } else if (friendStatus === 'sent') {
                endpoint = '/friend-request/cancel/${escapeHTML(profileUsername)}';
            } else if (friendStatus === 'received') {
                endpoint = '/friend-request/accept/${escapeHTML(profileUsername)}';
            } else {
                endpoint = '/friend-request/send/${escapeHTML(profileUsername)}';
            }
            fetch(endpoint, { method })
                .then(r => r.json())
                .then(data => {
                    if (data.ok) {
                        if (friendStatus === 'none') { friendStatus = 'sent'; btn.textContent = 'Cancel Request'; }
                        else if (friendStatus === 'sent') { friendStatus = 'none'; btn.textContent = 'Add Friend'; }
                        else if (friendStatus === 'received') { friendStatus = 'friends'; btn.textContent = 'Unfriend'; }
                        else if (friendStatus === 'friends') { friendStatus = 'none'; btn.textContent = 'Add Friend'; }
                    }
                    btn.disabled = false;
                })
                .catch(() => { btn.disabled = false; });
        }

        function toggleProfileNav() {
            const dropdown = document.getElementById('profile-nav-dropdown');
            const btn = document.getElementById('profile-nav-hamburger');
            dropdown.classList.toggle('open');
            btn.textContent = dropdown.classList.contains('open') ? '✕' : '☰';
        }
        document.addEventListener('click', function(e) {
            const dropdown = document.getElementById('profile-nav-dropdown');
            const btn = document.getElementById('profile-nav-hamburger');
            if (dropdown && btn && !dropdown.contains(e.target) && e.target !== btn) {
                dropdown.classList.remove('open');
                btn.textContent = '☰';
            }
        });
    </script>
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}

</body>
</html>`);
                });
                };
                if (friendRow) {
                    continueRender('friends');
                } else {
                    db.get(`SELECT from_user, status FROM Friend_Requests WHERE ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)) AND status = 'pending'`, [sessionUsername, profileUsername, profileUsername, sessionUsername], (err3, reqRow) => {
                        if (!reqRow) continueRender('none');
                        else if (reqRow.from_user === sessionUsername) continueRender('sent');
                        else continueRender('received');
                    });
                }
                });
            });
        });
    });
});

app.get('/messages', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const me = req.session.userUsername;
    db.all(`SELECT DISTINCT CASE WHEN from_user = ? THEN to_user ELSE from_user END as other_user,
            MAX(created_at) as last_at
            FROM Messages WHERE from_user = ? OR to_user = ?
            GROUP BY other_user ORDER BY last_at DESC`,
        [me, me, me], (err, convos) => {
        const convosHTML = (convos || []).map(c => `
            <a href="/messages/${c.other_user}" style="display:block;padding:14px 16px;border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:white;text-decoration:none;margin-bottom:10px;transition:background 0.15s;">
                <strong>@${c.other_user}</strong>
                <span style="float:right;font-size:0.8em;opacity:0.5;" data-ts="${c.last_at.replace(' ','T')+'Z'}"></span>
            </a>`).join('');
        res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Messages</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
<style>
    body { margin: 0; background: black; color: white; font-family: 'Quicksand', sans-serif; display: flex; flex-direction: column; min-height: 100vh; justify-content: flex-start; align-items: stretch; }
    #msg-topbar { position: fixed; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: black; border-bottom: 2px solid white; z-index: 100; }
    #msg-topbar-left { font-size: 0.95em; }
    #msg-topbar-right a { color: rgb(0,191,255); text-decoration: none; margin-left: 15px; }
    #msg-topbar-right a:hover { text-decoration: underline; }
    #nav-hamburger { display: none; background: none; border: 2px solid white; border-radius: 6px; color: white; font-size: 1.1em; cursor: pointer; padding: 4px 8px; line-height: 1; margin-left: 10px; }
    #nav-dropdown { display: none; flex-direction: column; position: absolute; top: 100%; right: 0; background: black; border: 2px solid white; border-radius: 10px; padding: 8px 0; min-width: 160px; z-index: 200; }
    #nav-dropdown a { display: block; color: rgb(0,191,255); text-decoration: none; padding: 8px 18px; white-space: nowrap; margin: 0; }
    #nav-dropdown a:hover { background: rgba(255,255,255,0.08); text-decoration: underline; }
    #nav-dropdown.open { display: flex; }
    @media (max-width: 600px) {
        #msg-topbar-right > a { display: none; }
        #nav-hamburger { display: inline-block; }
    }
    #inbox { max-width: 600px; width: 100%; margin: 80px auto 40px; padding: 0 20px; box-sizing: border-box; }
    #inbox h2 { margin-bottom: 20px; }
</style>
</head>
<body>
    <div id="msg-topbar">
        <div id="msg-topbar-left">Logged in as <strong>${me}</strong></div>
        <div id="msg-topbar-right" style="position:relative;display:flex;align-items:center;">
            <a href="/groups">Group Chats</a>
            <a href="/feed">Feed</a>
            <a href="/edit">Dashboard</a>
            <a href="/notifications" class="notif-nav-link">Notifications</a>
            <a href="/logout">Logout</a>
            <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
            <nav id="nav-dropdown">
                <a href="/groups">Group Chats</a>
                <a href="/feed">Feed</a>
                <a href="/edit">Dashboard</a>
                <a href="/notifications" class="notif-nav-link">Notifications</a>
                <a href="/logout">Logout</a>
            </nav>
        </div>
    </div>
    <div id="inbox">
        <h2>Inbox <a href="/groups" style="font-size:0.6em;color:rgb(0,191,255);text-decoration:none;margin-left:12px;font-weight:400;">+ Group Chats</a></h2>
        ${convosHTML || '<p style="opacity:0.4;">No conversations yet.</p>'}
    </div>
    <script>
        document.querySelectorAll('[data-ts]').forEach(el => {
            const ts = el.getAttribute('data-ts');
            if (ts) el.textContent = new Date(ts).toLocaleString('en-GB');
        });
        function toggleNav() {
            const dropdown = document.getElementById('nav-dropdown');
            const btn = document.getElementById('nav-hamburger');
            dropdown.classList.toggle('open');
            btn.textContent = dropdown.classList.contains('open') ? '✕' : '☰';
        }
        document.addEventListener('click', function(e) {
            const dropdown = document.getElementById('nav-dropdown');
            const btn = document.getElementById('nav-hamburger');
            if (dropdown && btn && !dropdown.contains(e.target) && e.target !== btn) {
                dropdown.classList.remove('open');
                btn.textContent = '☰';
            }
        });
    </script>
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}

</body>
</html>`);
    });
});

app.get('/messages/:username', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const me = req.session.userUsername;
    const other = req.params.username;
    db.run(`UPDATE Messages SET read = 1 WHERE to_user = ? AND from_user = ?`, [me, other]);
    db.all(`SELECT Messages.*, User_Data.avatar_path, User_Data.Nickname FROM Messages LEFT JOIN User_Data ON Messages.from_user = User_Data.username WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY created_at ASC`,
        [me, other, other, me], (err, msgs) => {
        const msgMap = {};
        (msgs || []).forEach(m => msgMap[m.id] = m);
        const msgsHTML = (msgs || []).map(m => renderMessageBubble(m, me, m.reply_to ? msgMap[m.reply_to] : null)).join('');
        res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Chat with ${other}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
<style>
    body { margin: 0; background: black; color: white; font-family: 'Quicksand', sans-serif; display: flex; flex-direction: column; height: 100vh; overflow: hidden; justify-content: flex-start; align-items: stretch; }
    #chat-topbar { position: fixed; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: black; border-bottom: 2px solid white; z-index: 100; flex-shrink: 0; }
    #chat-topbar-left { font-size: 0.95em; }
    #chat-topbar-right a { color: rgb(0,191,255); text-decoration: none; margin-left: 15px; }
    #chat-topbar-right a:hover { text-decoration: underline; }
    #nav-hamburger { display: none; background: none; border: 2px solid white; border-radius: 6px; color: white; font-size: 1.1em; cursor: pointer; padding: 4px 8px; line-height: 1; margin-left: 10px; }
    #nav-dropdown { display: none; flex-direction: column; position: absolute; top: 100%; right: 0; background: black; border: 2px solid white; border-radius: 10px; padding: 8px 0; min-width: 160px; z-index: 200; }
    #nav-dropdown a { display: block; color: rgb(0,191,255); text-decoration: none; padding: 8px 18px; white-space: nowrap; margin: 0; }
    #nav-dropdown a:hover { background: rgba(255,255,255,0.08); text-decoration: underline; }
    #nav-dropdown.open { display: flex; }
    @media (max-width: 600px) {
        #chat-topbar-right > a { display: none; }
        #nav-hamburger { display: inline-block; }
    }
    #chat-messages { flex: 1; overflow-y: auto; padding: 70px 20px 130px 20px; max-width: 700px; width: 100%; margin: 0 auto; box-sizing: border-box; }
    #chat-input-bar { position: fixed; bottom: 0; left: 0; right: 0; background: black; border-top: 2px solid white; padding: 10px 20px; z-index: 100; }
    #chat-reply-indicator { font-size: 0.85em; opacity: 0.7; display: none; margin-bottom: 6px; text-align: center; }
    #chat-form-row { display: flex; align-items: center; gap: 10px; width: 100%; }
    #chat-form-row textarea { text-align: left; flex: 1; height: 44px; resize: none; min-width: 0; background: black; color: white; border: 2px solid white; border-radius: 10px; padding: 8px; font-family: inherit; font-size: inherit; box-sizing: border-box; }
    #chat-file-name { font-size: 0.78em; opacity: 0.65; text-align: center; margin-top: 4px; }
    .chat-action-btn { padding: 0 !important; height: 44px !important; width: 70px !important; font-size: 0.85em !important; line-height: 1 !important; box-sizing: border-box !important; border: 5px solid white; margin: 0; text-align: center; border-radius: 15px; color: white; background-color: black;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    animation: slideInFromUp 1s ease-out forwards;  
    transition: 0.2s;}
    .chat-action-btn:hover {
    background-color: white;
    color: black;
    }
    .chat-action-btn.clicked {
        background-color: black !important;
        color: white !important;
    }
</style>
</head>
<body>
    <div id="chat-topbar">
        <div id="chat-topbar-left">Chat with <strong><a href="/user/${other}" style="color:white;text-decoration:none;">@${other}</a></strong></div>
        <div id="chat-topbar-right" style="position:relative;display:flex;align-items:center;">
            <a href="/messages">Inbox</a>
            <a href="/feed">Feed</a>
            <a href="/notifications" class="notif-nav-link">Notifications</a>
            <a href="/logout">Logout</a>
            <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
            <nav id="nav-dropdown">
                <a href="/messages">Inbox</a>
                <a href="/feed">Feed</a>
                <a href="/notifications" class="notif-nav-link">Notifications</a>
                <a href="/logout">Logout</a>
            </nav>
        </div>
    </div>
    <div id="chat-messages">
        ${msgsHTML || '<p id="chat-empty-placeholder" style="text-align:center;opacity:0.4;">No messages yet. Say hi!</p>'}
    </div>
    <div id="chat-input-bar">
        <div id="chat-reply-indicator">Replying to <span id="chat-reply-to-name"></span> &nbsp;<a href="#" onclick="clearReply();return false;" style="color:rgb(0,191,255);">cancel</a></div>
        <form action="/messages/${other}/send" method="POST" enctype="multipart/form-data" id="chat-form">
            <input type="hidden" name="reply_to" id="chat-reply-to-input" value="">
            <div id="chat-form-row">
                <textarea class="box" name="content" id="chat-content" placeholder="Message @${other}..." style="background-color:black;color:white;font-family:inherit;font-size:inherit;padding:8px;" maxlength="4000"></textarea>
                <input type="file" id="chat-attachment" name="attachments" multiple style="display:none;">
                <label for="chat-attachment" class="button chat-action-btn" style="display:inline-flex;align-items:center;justify-content:center;cursor:pointer;">Browse</label>
                <button class="button chat-action-btn" type="submit">Send</button>
            </div>
            <div id="chat-file-name">No file chosen</div>
            <div id="chat-char-counter" style="font-size:0.75em;opacity:0.5;text-align:right;margin-top:2px;">0 / 4000</div>
        </form>
    </div>
    <div id="chat-conn-indicator" style="position:fixed;top:54px;left:50%;transform:translateX(-50%);background:rgba(255,170,0,0.9);color:black;padding:4px 14px;border-radius:0 0 8px 8px;font-size:0.78em;font-weight:600;z-index:99;display:none;">Reconnecting…</div>
    <script>
        document.querySelectorAll('[data-ts]').forEach(el => {
            const ts = el.getAttribute('data-ts');
            if (ts) el.textContent = new Date(ts).toLocaleString('en-GB');
        });
        const msgs = document.getElementById('chat-messages');
        msgs.scrollTop = msgs.scrollHeight;
        const seenMsgIds = new Set(Array.from(msgs.querySelectorAll('.chat-msg-row[data-id]')).map(el => parseInt(el.getAttribute('data-id'))));

        function appendNewMessage(id, html) {
            if (!html || seenMsgIds.has(id)) return;
            seenMsgIds.add(id);
            const placeholder = document.getElementById('chat-empty-placeholder');
            if (placeholder) placeholder.remove();
            const container = document.getElementById('chat-messages');
            const wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
            container.insertAdjacentHTML('beforeend', html);
            container.querySelectorAll('[data-ts]').forEach(el => {
                const ts = el.getAttribute('data-ts');
                if (ts) el.textContent = new Date(ts).toLocaleString('en-GB');
            });
            if (wasNearBottom) container.scrollTop = container.scrollHeight;
        }
        function removeMessage(id) {
            seenMsgIds.delete(id);
            const el = document.querySelector('.chat-msg-row[data-id="' + id + '"]');
            if (el) el.remove();
        }

        // --- Live updates over Server-Sent Events (push, not polling) ---
        let chatStream = null;
        let chatReconnectDelay = 1000;
        const connIndicator = document.getElementById('chat-conn-indicator');
        function connectChatStream() {
            chatStream = new EventSource('/messages/${other}/stream');
            chatStream.addEventListener('open', () => {
                chatReconnectDelay = 1000;
                connIndicator.style.display = 'none';
            });
            chatStream.addEventListener('message', (e) => {
                try {
                    const data = JSON.parse(e.data);
                    appendNewMessage(data.id, data.html);
                    if (!document.hidden) fetch('/messages/${other}/mark-read', { method: 'POST' }).catch(() => {});
                } catch (err) {}
            });
            chatStream.addEventListener('delete', (e) => {
                try {
                    const data = JSON.parse(e.data);
                    removeMessage(data.id);
                } catch (err) {}
            });
            chatStream.onerror = () => {
                connIndicator.style.display = 'block';
                chatStream.close();
                setTimeout(connectChatStream, chatReconnectDelay);
                chatReconnectDelay = Math.min(chatReconnectDelay * 1.6, 15000);
            };
        }
        connectChatStream();
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && (!chatStream || chatStream.readyState === 2)) connectChatStream();
        });

        document.getElementById('chat-attachment').addEventListener('change', function () {
            const n = this.files.length;
            document.getElementById('chat-file-name').textContent = n === 0 ? 'No file chosen' : n === 1 ? this.files[0].name : n + ' files selected (max 10)';
        });

        const chatContent = document.getElementById('chat-content');
        const chatCounter = document.getElementById('chat-char-counter');
        chatContent.addEventListener('input', function () {
            const len = this.value.length;
            chatCounter.textContent = len + ' / 4000';
            chatCounter.style.color = len > 3800 ? (len >= 4000 ? 'rgb(255,80,80)' : 'orange') : '';
            chatCounter.style.opacity = len > 3800 ? '1' : '0.5';
        });
        chatContent.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
        });

        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => { btn.classList.add('clicked'); setTimeout(() => btn.classList.remove('clicked'), 150); });
        });
        function setReply(id, username) {
            document.getElementById('chat-reply-to-input').value = id;
            document.getElementById('chat-reply-to-name').textContent = username;
            document.getElementById('chat-reply-indicator').style.display = 'block';
            chatContent.focus();
        }
        function clearReply() {
            document.getElementById('chat-reply-to-input').value = '';
            document.getElementById('chat-reply-indicator').style.display = 'none';
        }
        function deleteMessage(id) {
            fetch('/messages/${other}/delete/' + id, { method: 'POST' }).then(r => {
                if (r.ok) removeMessage(id);
            });
        }
        function showChatError(message) {
            const t = document.createElement('div');
            t.textContent = message;
            t.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:white;padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 4000);
        }

        const chatForm = document.getElementById('chat-form');
        const chatSendBtn = chatForm.querySelector('button[type="submit"]');
        chatForm.addEventListener('submit', function (e) {
            e.preventDefault();
            sendChatMessage();
        });
        async function sendChatMessage() {
            const fileInput = document.getElementById('chat-attachment');
            if (!chatContent.value.trim() && !fileInput.files.length) return;
            chatSendBtn.disabled = true;
            const fd = new FormData(chatForm);
            try {
                const r = await fetch('/messages/${other}/send', { method: 'POST', body: fd });
                const d = await r.json().catch(() => ({}));
                if (!r.ok) {
                    showChatError(d.error || 'Failed to send message.');
                } else {
                    chatContent.value = '';
                    chatCounter.textContent = '0 / 4000';
                    chatCounter.style.opacity = '0.5';
                    chatCounter.style.color = '';
                    fileInput.value = '';
                    document.getElementById('chat-file-name').textContent = 'No file chosen';
                    clearReply();
                }
            } catch (err) {
                showChatError('Network error - message not sent.');
            } finally {
                chatSendBtn.disabled = false;
                chatContent.focus();
            }
        }
        function toggleNav() {
            const dropdown = document.getElementById('nav-dropdown');
            const btn = document.getElementById('nav-hamburger');
            dropdown.classList.toggle('open');
            btn.textContent = dropdown.classList.contains('open') ? '✕' : '☰';
        }
        document.addEventListener('click', function(e) {
            const dropdown = document.getElementById('nav-dropdown');
            const btn = document.getElementById('nav-hamburger');
            if (dropdown && btn && !dropdown.contains(e.target) && e.target !== btn) {
                dropdown.classList.remove('open');
                btn.textContent = '☰';
            }
        });
    </script>

</body>
</html>`);
    });
});

app.get('/messages/:username/stream', (req, res) => {
    if (!req.session.userId) return res.status(401).end();
    const me = req.session.userUsername;
    const other = req.params.username;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');

    const channel = `${me}::${other}`;
    const onEvent = (payload) => sseSend(res, payload.event, payload);
    dmBus.on(channel, onEvent);

    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);

    req.on('close', () => {
        clearInterval(keepAlive);
        dmBus.removeListener(channel, onEvent);
    });
});

app.post('/messages/:username/send', (req, res, next) => {
    uploadDM.array('attachments', MAX_FILES_DM)(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: `Too many files - max ${MAX_FILES_DM} per message.` });
            return res.status(400).json({ error: 'Upload failed.' });
        }
        next();
    });
}, (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const me = req.session.userUsername;
    const other = req.params.username;
    const { content, reply_to } = req.body;
    const files = req.files || [];
    const filesMeta = files.map(f => ({ path: f.path, name: f.originalname }));
    const filesJSON = filesMeta.length ? JSON.stringify(filesMeta) : null;
    const filePath = files[0] ? files[0].path : null;
    const fileName = files[0] ? files[0].originalname : null;
    const replyTo = reply_to ? parseInt(reply_to) : null;
    if ((!content || !content.trim()) && !files.length) return res.status(400).json({ error: 'Message is empty.' });
    if (content && content.length > MAX_MSG_LENGTH) return res.status(400).json({ error: 'Message too long or too many files selected - 4,000 character limit, max 10 files.' });

    db.run(`INSERT INTO Messages (from_user, to_user, content, file_path, file_name, files_json, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [me, other, (content || '').trim(), filePath, fileName, filesJSON, replyTo], function (err) {
            if (err) return res.status(500).json({ error: 'Failed to send message.' });
            const newId = this.lastID;
            const preview = (content || '').trim().slice(0, 140) || (filesMeta.length ? `Sent ${filesMeta.length > 1 ? filesMeta.length + ' files' : 'a file: ' + filesMeta[0].name}` : '');
            createNotification({ username: other, type: 'dm', actor_username: me, message_id: newId, content_preview: preview });
            processMentions(content, me, { type: 'mention_dm', message_id: newId, skipUsernames: [other] });

            db.get(`SELECT Messages.*, User_Data.avatar_path, User_Data.Nickname FROM Messages LEFT JOIN User_Data ON Messages.from_user = User_Data.username WHERE Messages.id = ?`, [newId], (err2, row) => {
                if (err2 || !row) return res.json({ ok: true, id: newId });
                const finish = (replyMsg) => {
                    broadcastDMMessage(me, other, row, replyMsg);
                    res.json({ ok: true, id: newId });
                };
                if (replyTo) {
                    db.get(`SELECT * FROM Messages WHERE id = ?`, [replyTo], (err3, replyRow) => finish(replyRow || null));
                } else {
                    finish(null);
                }
            });
        });
});

app.post('/messages/:username/mark-read', (req, res) => {
    if (!req.session.userId) return res.status(401).end();
    const me = req.session.userUsername;
    const other = req.params.username;
    db.run(`UPDATE Messages SET read = 1 WHERE to_user = ? AND from_user = ?`, [me, other], () => res.status(200).end());
});

app.post('/messages/:username/delete/:id', (req, res) => {
    if (!req.session.userId) return res.status(401).end();
    const me = req.session.userUsername;
    const other = req.params.username;
    const msgId = parseInt(req.params.id);
    db.get(`SELECT from_user, to_user FROM Messages WHERE id = ?`, [msgId], (err, msg) => {
        if (err || !msg) return res.status(404).end();
        if (msg.from_user !== me) return res.status(403).end();
        db.run(`DELETE FROM Messages WHERE id = ?`, [msgId], (err2) => {
            if (err2) { console.error('Message delete error:', err2.message); return res.status(500).end(); }
            broadcastDMDelete(msg.from_user, msg.to_user, msgId);
            res.status(200).end();
        });
    });
});

app.get('/notifications', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const me = req.session.userUsername;

    db.all(`SELECT Notifications.*, User_Data.Nickname AS actor_nickname FROM Notifications LEFT JOIN User_Data ON Notifications.actor_username = User_Data.username WHERE Notifications.username = ? ORDER BY Notifications.id DESC LIMIT 50`, [me], (err, notifs) => {
        if (err) { console.error(err); return res.status(500).send('Error loading notifications'); }

        db.run(`UPDATE Notifications SET read = 1 WHERE username = ?`, [me]);

        const newestId = (notifs && notifs.length) ? notifs[0].id : 0;
        const notifsHTML = (notifs || []).map(renderNotificationItem).join('');

        res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Notifications</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
<style>
    body { margin: 0; background: black; color: white; font-family: 'Quicksand', sans-serif; display: flex; flex-direction: column; min-height: 100vh; justify-content: flex-start; align-items: stretch; }
    #notif-topbar { position: fixed; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: black; border-bottom: 2px solid white; z-index: 100; }
    #notif-topbar-left { font-size: 0.95em; }
    #notif-topbar-right a { color: rgb(0,191,255); text-decoration: none; margin-left: 15px; }
    #notif-topbar-right a:hover { text-decoration: underline; }
    #notif-topbar-right a.active { color: white; font-weight: bold; pointer-events: none; }
    #nav-hamburger { display: none; background: none; border: 2px solid white; border-radius: 6px; color: white; font-size: 1.1em; cursor: pointer; padding: 4px 8px; line-height: 1; margin-left: 10px; }
    #nav-dropdown { display: none; flex-direction: column; position: absolute; top: 100%; right: 0; background: black; border: 2px solid white; border-radius: 10px; padding: 8px 0; min-width: 160px; z-index: 200; }
    #nav-dropdown a { display: block; color: rgb(0,191,255); text-decoration: none; padding: 8px 18px; white-space: nowrap; margin: 0; }
    #nav-dropdown a:hover { background: rgba(255,255,255,0.08); text-decoration: underline; }
    #nav-dropdown a.active { color: white; font-weight: bold; pointer-events: none; }
    #nav-dropdown.open { display: flex; }
    @media (max-width: 600px) {
        #notif-topbar-right > a { display: none; }
        #nav-hamburger { display: inline-block; }
    }
    #notif-list { max-width: 600px; width: 100%; margin: 80px auto 40px; padding: 0 20px; box-sizing: border-box; }
    #notif-list h2 { margin-bottom: 20px; }
    .notif-item:hover { background: rgba(255,255,255,0.06) !important; }
    .active-filter { background: white !important; color: black !important; }
</style>
</head>
<body>
    <div id="notif-topbar">
        <div id="notif-topbar-left">Logged in as <strong>${me}</strong></div>
        <div id="notif-topbar-right" style="position:relative;display:flex;align-items:center;">
            <a href="/feed">Feed</a>
            <a href="/messages">Messages</a>
            <a href="/edit">Dashboard</a>
            <a href="/notifications" class="active">Notifications</a>
            <a href="/logout">Logout</a>
            <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
            <nav id="nav-dropdown">
                <a href="/feed">Feed</a>
                <a href="/messages">Messages</a>
                <a href="/edit">Dashboard</a>
                <a href="/notifications" class="active">Notifications</a>
                <a href="/logout">Logout</a>
            </nav>
        </div>
    </div>
    <div id="notif-list">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
            <h2 style="margin:0;">Notifications</h2>
            <div id="notif-action-row" style="display:${(notifs && notifs.length) ? 'flex' : 'none'};gap:8px;">
                <button class="button" onclick="markAllRead()" style="padding:6px 14px;font-size:0.85em;height: 25px;width: auto;">Mark all read</button>
                <button class="button" onclick="clearAllNotifs()" style="padding:6px 14px;font-size:0.85em;height: 25px;width: auto;">Clear all</button>
            </div>
        </div>
        <div id="notif-filter-row" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px;">
            <button class="button notif-filter-btn active-filter" data-filter="all" onclick="filterNotifs('all')" style="padding:4px 12px;font-size:0.8em;height: 25px;">All</button>
            <button class="button notif-filter-btn" data-filter="reply" onclick="filterNotifs('reply')" style="padding:4px 12px;font-size:0.8em;height: 25px;">Replies</button>
            <button class="button notif-filter-btn" data-filter="dm" onclick="filterNotifs('dm')" style="padding:4px 12px;font-size:0.8em;height: 25px;">DMs</button>
            <button class="button notif-filter-btn" data-filter="friend" onclick="filterNotifs('friend')" style="padding:4px 12px;font-size:0.8em;width: auto; height: 25px;">Friend Requests</button>
        </div>
        <div id="notif-items">${notifsHTML || '<p style="opacity:0.4;">No notifications yet.</p>'}</div>
    </div>
    <script>
        document.querySelectorAll('[data-ts]').forEach(el => {
            const ts = el.getAttribute('data-ts');
            if (ts) el.textContent = new Date(ts).toLocaleString('en-GB');
        });
        let lastId = ${newestId};
        setInterval(() => {
            fetch('/notifications/poll?after=' + lastId)
                .then(r => r.json())
                .then(d => {
                    if (d && d.html) {
                        document.getElementById('notif-items').insertAdjacentHTML('afterbegin', d.html);
                        document.querySelectorAll('#notif-items [data-ts]').forEach(el => {
                            if (!el.textContent.trim()) el.textContent = new Date(el.getAttribute('data-ts')).toLocaleString('en-GB');
                        });
                        lastId = d.lastId;
                        fetch('/notifications/mark-read', { method: 'POST' });
                    }
                })
                .catch(() => {});
        }, 4000);

        document.getElementById('notif-items').addEventListener('click', e => {
            if (e.target.closest('a')) return;
            const item = e.target.closest('.notif-item');
            if (item && item.dataset.href) window.location.href = item.dataset.href;
        });

        function filterNotifs(type) {
            document.querySelectorAll('.notif-filter-btn').forEach(btn => {
                btn.classList.toggle('active-filter', btn.getAttribute('data-filter') === type);
            });
            document.querySelectorAll('#notif-items .notif-item').forEach(el => {
                if (type === 'all') {
                    el.style.display = '';
                } else if (type === 'friend') {
                    const href = el.getAttribute('data-href') || '';
                    el.style.display = href.includes('/friends') ? '' : 'none';
                } else if (type === 'reply') {
                    const href = el.getAttribute('data-href') || '';
                    el.style.display = href.includes('/post/') ? '' : 'none';
                } else if (type === 'dm') {
                    const href = el.getAttribute('data-href') || '';
                    el.style.display = href.includes('/messages/') ? '' : 'none';
                }
            });
        }

        function clearAllNotifs() {
            if (!confirm('Clear all notifications?')) return;
            fetch('/notifications/clear', { method: 'POST' })
                .then(r => r.json())
                .then(d => {
                    if (d && d.ok) {
                        document.getElementById('notif-items').innerHTML = '<p style="opacity:0.4;">No notifications yet.</p>';
                        document.getElementById('notif-action-row').style.display = 'none';
                    }
                })
                .catch(() => {});
        }

        function markAllRead() {
            fetch('/notifications/mark-read', { method: 'POST' })
                .then(r => r.json())
                .then(d => {
                    if (d && d.ok) {
                        document.querySelectorAll('.notif-item').forEach(el => {
                            el.style.background = 'transparent';
                            const dot = el.querySelector('span[style*="rgb(0,191,255)"]');
                            if (dot) dot.style.background = 'transparent';
                        });
                    }
                })
                .catch(() => {});
        }

        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => { btn.classList.add('clicked'); setTimeout(() => btn.classList.remove('clicked'), 150); });
        });
        function toggleNav() {
            const dropdown = document.getElementById('nav-dropdown');
            const btn = document.getElementById('nav-hamburger');
            dropdown.classList.toggle('open');
            btn.textContent = dropdown.classList.contains('open') ? '✕' : '☰';
        }
        document.addEventListener('click', function(e) {
            const dropdown = document.getElementById('nav-dropdown');
            const btn = document.getElementById('nav-hamburger');
            if (dropdown && btn && !dropdown.contains(e.target) && e.target !== btn) {
                dropdown.classList.remove('open');
                btn.textContent = '☰';
            }
        });
    </script>
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}

</body>
</html>`);
    });
});

app.get('/notifications/poll', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const me = req.session.userUsername;
    const afterId = parseInt(req.query.after) || 0;

    db.all(`SELECT Notifications.*, User_Data.Nickname AS actor_nickname FROM Notifications LEFT JOIN User_Data ON Notifications.actor_username = User_Data.username WHERE Notifications.username = ? AND Notifications.id > ? ORDER BY Notifications.id DESC`, [me, afterId], (err, notifs) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!notifs || !notifs.length) return res.json({ html: '', lastId: afterId });
        const lastId = Math.max(...notifs.map(n => n.id));
        const html = notifs.map(renderNotificationItem).join('');
        res.json({ html, lastId });
    });
});

app.get('/notifications/count', (req, res) => {
    if (!req.session.userId) return res.json({ count: 0 });
    getUnreadNotificationCount(req.session.userUsername, (count) => res.json({ count }));
});

app.post('/notifications/mark-read', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    db.run(`UPDATE Notifications SET read = 1 WHERE username = ?`, [req.session.userUsername], (err) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({ ok: true });
    });
});

app.post('/notifications/clear', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    db.run(`DELETE FROM Notifications WHERE username = ?`, [req.session.userUsername], (err) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({ ok: true });
    });
});

function requireAdmin(req, res, next) {
    if (!req.session.userId) return res.redirect('/');
    db.get(`SELECT IsOwner, IsAdmin, IsHeadAdmin FROM User_Data WHERE id = ?`, [req.session.userId], (err, user) => {
        if (err || !user || (!user.IsOwner && !user.IsAdmin && !user.IsHeadAdmin)) {
            return res.status(403).sendFile(path.join(__dirname, 'admin_access_denied.html'));
        }
        req.isOwner = !!user.IsOwner;
        req.isHeadAdmin = !!(user.IsHeadAdmin || user.IsOwner);
        next();
    });
}

// Stricter gate for routes that only Owners/Head Admins should be able to
// hit (e.g. toggling registration). Must run after requireAdmin, which is
// what actually populates req.isHeadAdmin.
function requireHeadAdmin(req, res, next) {
    if (!req.isHeadAdmin) return res.status(403).json({ error: 'Head Admin or Owner only.' });
    next();
}

app.get('/admin/dashboard', requireAdmin, (req, res) => {
    db.all(`SELECT username, Nickname, IsBanned, BanReason, IsDeleted, DeleteReason, IsOwner, IsAdmin, IsHeadAdmin, IsDeveloper, IsSupporter, last_ip FROM User_Data ORDER BY username ASC`, [], (err, users) => {
        if (err) return res.status(500).send('DB error');
        const userRows = (users || []).map(u => {
            const badges = [
                u.IsOwner ? '<span style="color:rgb(255,200,50);font-weight:700;">Owner</span>' : '',
                u.IsHeadAdmin ? '<span style="color:rgb(255, 0, 0);font-weight:700;">Head Admin</span>' : '',
                u.IsAdmin ? '<span style="color:rgb(255,100,100);font-weight:700;">Admin</span>' : '',
                u.IsDeveloper ? '<span style="color:rgb(0,191,255);font-weight:700;">Dev</span>' : '',
                u.IsSupporter ? '<span style="color:rgb(180,100,255);font-weight:700;">Supporter</span>' : '',
                u.IsDeleted ? '<span style="color:rgb(150,150,150);font-weight:700;">Deleted</span>' : (u.IsBanned ? '<span style="color:rgb(255,80,80);font-weight:700;">Banned</span>' : ''),
            ].filter(Boolean).join(' ');
            const ipBtn = u.last_ip
                ? `<button class="button" style="font-size:0.75em;padding:2px 8px;margin-left:6px;" onclick="prefillIPBan('${escapeHTML(u.last_ip)}')">IP Ban</button>`
                : '';
            const nicknameSuffix = (u.Nickname && u.Nickname.trim()) ? ` <span style="opacity:0.5;font-weight:400;">(${escapeHTML(u.Nickname.trim())})</span>` : '';
            const statusReason = u.IsDeleted ? escapeHTML(u.DeleteReason || '') : (u.IsBanned ? escapeHTML(u.BanReason || '') : '');
            return `<tr>
                <td><a href="/user/${escapeHTML(u.username)}" style="color:white;text-decoration:none;">@${escapeHTML(u.username)}</a>${nicknameSuffix}</td>
                <td style="font-size:0.85em; word-break: break-word; overflow-wrap: break-word">${badges || '<span style="opacity:0.4;">-</span>'}</td>
                <td style="font-size:0.8em;opacity:0.6;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; word-break: break-word; overflow-wrap: break-word">${statusReason}</td>
                <td style="font-size:0.78em;opacity:0.5; word-break: break-word; overflow-wrap: break-word">${u.last_ip ? escapeHTML(u.last_ip) : '<span style="opacity:0.3;">-</span>'}${ipBtn}</td>
            </tr>`;
        }).join('');

        db.all(`SELECT ip, reason, banned_by, created_at FROM IP_Bans ORDER BY created_at DESC`, [], (err2, ipbans) => {
            const ipBanRows = (ipbans || []).map(b => `<tr>
                <td style="font-family:monospace; word-break: break-word; overflow-wrap: break-word">${escapeHTML(b.ip)}</td>
                <td style="font-size:0.8em;opacity:0.7; word-break: break-word; overflow-wrap: break-word">${escapeHTML(b.reason || '')}</td>
                <td style="font-size:0.78em;opacity:0.5; word-break: break-word; overflow-wrap: break-word">${escapeHTML(b.banned_by || '')}</td>
                <td><button class="button" style="font-size:0.75em;padding:2px 8px;" onclick="unIPBan('${escapeHTML(b.ip)}')">Unban</button></td>
            </tr>`).join('');

        db.all(`SELECT action, actor, target, details, created_at FROM Audit_Log ORDER BY id DESC LIMIT 150`, [], (err3, auditEntries) => {
            const ACTION_LABELS = {
                account_created: 'Account Created',
                account_banned: 'Account Banned',
                account_unbanned: 'Account Unbanned',
                account_deleted: 'Account Deleted',
                registration_gate_enabled: 'Registration Gate ON',
                registration_gate_disabled: 'Registration Gate OFF',
                ip_banned: 'IP Banned',
                ip_unbanned: 'IP Unbanned'
            };
            const IP_ACTIONS = new Set(['ip_banned', 'ip_unbanned']);
            const auditRows = (auditEntries || []).map(a => {
                let targetDisplay = '<span style="opacity:0.3;">-</span>';
                if (a.target) {
                    targetDisplay = IP_ACTIONS.has(a.action)
                        ? `<span style="font-family:monospace;">${escapeHTML(a.target)}</span>`
                        : '@' + escapeHTML(a.target);
                }
                return `<tr>
                <td style="font-size:0.78em;opacity:0.5;white-space:nowrap; word-break: break-word; overflow-wrap: break-word">${escapeHTML(a.created_at || '')}</td>
                <td style="font-size:0.85em; word-break: break-word; overflow-wrap: break-word">${escapeHTML(ACTION_LABELS[a.action] || a.action)}</td>
                <td style="font-size:0.85em; word-break: break-word; overflow-wrap: break-word">${escapeHTML(a.actor || '')}</td>
                <td style="font-size:0.85em; word-break: break-word; overflow-wrap: break-word">${targetDisplay}</td>
                <td style="font-size:0.8em;opacity:0.7;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; word-break: break-word; overflow-wrap: break-word">${escapeHTML(a.details || '')}</td>
            </tr>`;
            }).join('');

        res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Admin Dashboard</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
<style>
    html, body { display: block !important; height: auto !important; min-height: 100vh; margin: 0; background: black; color: white; font-family: 'Quicksand', sans-serif; }
    #topbar { position: fixed; top: 0; left: 0; right: 0; display: flex !important; justify-content: space-between; align-items: center; padding: 10px 20px; background: black; border-bottom: 2px solid white; z-index: 100; }
    #topbar a { color: rgb(0,191,255); text-decoration: none; margin-left: 15px; }
    #topbar a:hover { text-decoration: underline; }
    #nav-hamburger { display: none; background: none; border: 2px solid white; border-radius: 6px; color: white; font-size: 1.1em; cursor: pointer; padding: 4px 8px; line-height: 1; margin-left: 10px; }
    #nav-dropdown { display: none; flex-direction: column; position: absolute; top: 100%; right: 0; background: black; border: 2px solid white; border-radius: 10px; padding: 8px 0; min-width: 160px; z-index: 200; }
    #nav-dropdown a { display: block; color: rgb(0,191,255); text-decoration: none; padding: 8px 18px; white-space: nowrap; margin: 0; }
    #nav-dropdown a:hover { background: rgba(255,255,255,0.08); text-decoration: underline; }
    #nav-dropdown.open { display: flex; }
    @media (max-width: 600px) {
        #topbar-right > a { display: none; }
        #nav-hamburger { display: inline-block; }
    }
    #content { max-width: 700px; width: 100%; margin: 0 auto; padding: 70px 20px 60px; box-sizing: border-box; }
    h1 { margin-bottom: 4px; }
    .panel { border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; padding: 20px; margin-bottom: 24px; }
    .panel h2 { margin: 0 0 16px; font-size: 1em; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.6; style="color:rgba(255, 255, 255, 0.8);"; }
    label { display: block; font-size: 0.85em; opacity: 0.7; margin-bottom: 4px; margin-top: 12px; }
    input[type=text], textarea, select {
        width: 100%; box-sizing: border-box; background: black; color: white;
        border: 2px solid white; border-radius: 8px; padding: 8px 10px;
        font-family: inherit; font-size: inherit;
    }
    input[type=text]:focus, textarea:focus, select:focus { border-color: rgb(0,191,255); outline: none; }
    .action-row { display: flex; gap: 10px; margin-top: 16px; }
    #result { margin-top: 12px; font-size: 0.9em; min-height: 1.2em; }
    #result.ok { color: rgb(80,255,160); }
    #result.err { color: rgb(255,80,80); }
    #ip-result { margin-top: 12px; font-size: 0.9em; min-height: 1.2em; }
    #ip-result.ok { color: rgb(80,255,160); }
    #ip-result.err { color: rgb(255,80,80); }
    table { width: 100%; border-collapse: collapse; font-size: 0.88em; }
    th { text-align: left; opacity: 0.5; font-weight: 600; padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.15); }
    td { padding: 7px 8px; border-bottom: 1px solid rgba(255,255,255,0.07); vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
</style>
</head>
<body>
<div id="topbar">
    <strong>Admin Dashboard</strong>
    <div id="topbar-right" style="position:relative;display:flex;align-items:center;">
        <a href="/feed">Feed</a>
        <a href="/edit">Dashboard</a>
        <a href="/logout">Logout</a>
        <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
        <nav id="nav-dropdown">
            <a href="/feed">Feed</a>
            <a href="/edit">Dashboard</a>
            <a href="/logout">Logout</a>
        </nav>
    </div>
</div>
<div id="content">
    <h1>Admin Dashboard</h1>
    <p style="opacity:0.5;margin-top:4px;">Logged in as <strong>${escapeHTML(req.session.userUsername)}</strong></p>

    <div class="panel" style="border-color:rgba(255,255,255,0.2);">
        <h2>Registration Gate</h2>
        <p style="opacity:0.5;font-size:0.8em;margin-top:-6px;">When <strong>ON</strong>, new signups are created banned pending activation and admins get pinged (Activations group chat + DM) to manually activate them. When <strong>OFF</strong>, registration is fully open - new accounts are created active immediately, with no pings.</p>
        <p style="margin-top:10px;">Status: <span id="reg-gate-status">${registrationGateEnabled ? '<span style="color:rgb(80,255,160);font-weight:700;">ON</span>' : '<span style="color:rgb(255,80,80);font-weight:700;">OFF</span>'}</span></p>
        ${req.isHeadAdmin ? `
        <div class="action-row">
            <button class="button" onclick="toggleRegistrationGate(true)" style="width:100px;">Turn ON</button>
            <button class="button" onclick="toggleRegistrationGate(false)" style="width:100px;">Turn OFF</button>
        </div>
        <div id="reg-gate-result"></div>` : `<p style="opacity:0.4;font-size:0.78em;margin-top:10px;">Only Owners and Head Admins can change this setting.</p>`}
    </div>

    <div class="panel">
        <h2>Ban / Unban User</h2>
        <label>Username</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="target-username" placeholder="e.g. testuser" autocomplete="off">
        <label>Reason <span style="opacity:0.4;">(required for ban, ignored for unban)</span></label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="ban-reason" placeholder="e.g. Spamming" maxlength="500">
        <label>Action</label>
        <select id="action">
            <option value="ban">Ban</option>
            <option value="unban">Unban</option>
        </select>
        <div class="action-row">
            <button class="button" id="submit-btn" onclick="submitAction()" style="width:140px;">Apply</button>
        </div>
        <div id="result"></div>
    </div>

    <div class="panel" style="border-color:rgba(255,255,255,0.2);">
        <h2 style="color:rgba(255, 255, 255, 0.8);">IP Ban / Unban</h2>
        <label>IP Address</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="target-ip" placeholder="e.g. 192.168.1.1" autocomplete="off">
        <label>Reason <span style="opacity:0.4;">(required for ban, ignored for unban)</span></label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="ip-ban-reason" placeholder="e.g. Ban evasion" maxlength="500">
        <label>Action</label>
        <select id="ip-action">
            <option value="ipban">IP Ban</option>
            <option value="unipban">IP Unban</option>
        </select>
        <div class="action-row">
            <button class="button" onclick="submitIPAction()" style="width:140px;">Apply</button>
        </div>
        <div id="ip-result"></div>
    </div>

    <div class="panel" style="rgba(255,255,255,0.2);">
        <h2 style="color:rgba(255, 255, 255, 0.8);">Banned IPs</h2>
        <table>
            <thead><tr><th>IP Address</th><th>Reason</th><th>Banned By</th><th></th></tr></thead>
            <tbody id="ip-ban-table">
                ${ipBanRows || '<tr><td colspan="4" style="opacity:0.4; word-break: break-word; overflow-wrap: break-word">No IP bans.</td></tr>'}
            </tbody>
        </table>
    </div>

    <div class="panel" style="border-color:rgba(255,255,255,0.2;">
        <h2 style="color:rgb(255, 255, 255, 0.8);">Delete Account</h2>
        <p style="opacity:0.5;font-size:0.8em;margin-top:-6px;">Does not remove the account from the database. Resets the avatar to the default, sets the display name to "Account Deleted", clears the bio, marks the account as deleted, and deletes all of its posts. The username is kept.</p>
        <label>Username</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="delete-username" placeholder="e.g. testuser" autocomplete="off">
        <label>Reason <span style="opacity:0.4;">(required)</span></label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="delete-reason" placeholder="e.g. ToS violation" maxlength="500">
        <div class="action-row">
            <button class="button" onclick="submitDeleteAccount()" style="width:160px;">Delete Account</button>
        </div>
        <div id="delete-result"></div>
        ${req.isHeadAdmin ? `
        <hr style="border-color:rgba(255,80,80,0.3);margin:18px 0;">
        <h3 style="color:rgb(255, 0, 0);margin-bottom:4px;">Delete From Database</h3>
        <p style="opacity:0.6;font-size:0.8em;margin-top:-2px;">Permanently erases the account and everything tied to it - posts, DMs, group chat messages/memberships, follows, friends, friend requests, and notifications. This cannot be undone and the username becomes available again. Head Admin / Owner only.</p>
        <label>Username</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="hard-delete-username" placeholder="e.g. testuser" autocomplete="off">
        <label>Reason <span style="opacity:0.4;">(required)</span></label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="hard-delete-reason" placeholder="e.g. GDPR erasure request" maxlength="500">
        <div class="action-row">
            <button class="button" onclick="submitHardDeleteAccount()" style="width:200px;">Delete From Database</button>
        </div>
        <div id="hard-delete-result"></div>
        ` : ''}
    </div>

    <div class="panel">
        <h2>Edit User Profile</h2>
        <p style="opacity:0.5;font-size:0.8em;margin-top:-6px;">View and fix up anyone's avatar, nickname, or bio - useful for removing an inappropriate pfp or bio without deleting the account.</p>
        <label>Username</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="profile-username" placeholder="e.g. testuser" autocomplete="off">
        <div class="action-row">
            <button class="button" onclick="loadProfile()" style="width:140px;">Load</button>
        </div>
        <div id="profile-avatar-preview" style="margin:10px 0;display:flex;align-items:center;gap:12px;"></div>
        <label>Nickname</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="profile-nickname" placeholder="(none)" maxlength="32">
        <label>Bio</label>
        <textarea id="profile-bio" maxlength="1000" style="width:100%;min-height:80px;border-radius:12px;padding:8px;box-sizing:border-box;"></textarea>
        <div class="action-row">
            <button class="button" onclick="saveProfileText()" style="width:140px;">Save Text</button>
        </div>
        <label style="margin-top:14px;">Email</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="profile-email" placeholder="(none)" autocomplete="off">
        <div class="action-row">
            <button class="button" onclick="saveProfileEmail()" style="width:140px;">Save Email</button>
        </div>
        <label style="margin-top:14px;">Replace Avatar</label>
        <input type="file" id="profile-avatar-file" accept="image/*">
        <div class="action-row">
            <button class="button" onclick="uploadProfileAvatar()" style="width:160px;">Upload Avatar</button>
            <button class="button" onclick="resetProfileAvatar()" style="width:160px;">Reset to Default</button>
        </div>
        <div id="profile-result"></div>
    </div>

    <div class="panel">
        <h2>Manage Badges</h2>
        <label>Username</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="badge-username" placeholder="e.g. testuser" autocomplete="off">
        <label style="margin-top:14px;">Badges</label>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:6px;">
            ${req.isOwner ? `<label style="display:flex;align-items:center;gap:6px;margin:0;text-transform:none;font-size:0.95em;opacity:1;"><input type="checkbox" id="badge-headadmin" style="width:auto;"> Head Admin</label>` : ''}
            ${req.isHeadAdmin ? `<label style="display:flex;align-items:center;gap:6px;margin:0;text-transform:none;font-size:0.95em;opacity:1;"><input type="checkbox" id="badge-admin" style="width:auto;"> Admin</label>` : ''}
            <label style="display:flex;align-items:center;gap:6px;margin:0;text-transform:none;font-size:0.95em;opacity:1;"><input type="checkbox" id="badge-supporter" style="width:auto;"> Supporter</label>
            <label style="display:flex;align-items:center;gap:6px;margin:0;text-transform:none;font-size:0.95em;opacity:1;"><input type="checkbox" id="badge-developer" style="width:auto;"> Developer</label>
            ${req.isOwner ? `<label style="display:flex;align-items:center;gap:6px;margin:0;text-transform:none;font-size:0.95em;opacity:1;"><input type="checkbox" id="badge-owner" style="width:auto;"> Owner</label>` : ''}
        </div>
        ${!req.isOwner ? `<p style="opacity:0.4;font-size:0.78em;margin-top:6px;">Only Owners and Head Admins can grant or revoke the Admin badge.</p>` : ''}
        <p style="opacity:0.4;font-size:0.8em;margin-top:8px;">Load a user's current badges first, tick/untick what you want, then save.</p>
        <div class="action-row">
            <button class="button" onclick="loadBadges()" style="width:140px;">Load</button>
            <button class="button" onclick="saveBadges()" style="width:140px;">Save</button>
        </div>
        <div id="badge-result"></div>
    </div>

    <div class="panel">
        <h2>All Users</h2>
        <table>
            <thead><tr><th>Username</th><th>Badges</th><th>Ban Reason</th><th>Last IP</th></tr></thead>
            <tbody id="user-table">
                ${userRows || '<tr><td colspan="4" style="opacity:0.4; word-break: break-word; overflow-wrap: break-word">No users found.</td></tr>'}
            </tbody>
        </table>
    </div>

    <div class="panel">
        <h2>Audit Log</h2>
        <p style="opacity:0.5;font-size:0.8em;margin-top:-6px;">Most recent 150 events - account creations, bans/unbans, deletions, and registration gate changes.</p>
        <table>
            <thead><tr><th>Time</th><th>Action</th><th>Actor</th><th>Target</th><th>Details</th></tr></thead>
            <tbody id="audit-table">
                ${auditRows || '<tr><td colspan="5" style="opacity:0.4; word-break: break-word; overflow-wrap: break-word">No audit events yet.</td></tr>'}
            </tbody>
        </table>
    </div>
</div>

<script>
    document.querySelectorAll('.button').forEach(btn => {
        btn.addEventListener('mousedown', () => { btn.classList.add('clicked'); setTimeout(() => btn.classList.remove('clicked'), 150); });
    });

    async function toggleRegistrationGate(enable) {
        const result = document.getElementById('reg-gate-result');
        result.className = ''; result.textContent = 'Updating...';
        try {
            const r = await fetch('/admin/registration-gate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: enable })
            });
            const d = await r.json();
            if (!r.ok) { result.className = 'err'; result.textContent = d.error || 'Error.'; return; }
            document.getElementById('reg-gate-status').innerHTML = d.enabled
                ? '<span style="color:rgb(80,255,160);font-weight:700;">ON</span>'
                : '<span style="color:rgb(255,80,80);font-weight:700;">OFF</span>';
            result.className = 'ok'; result.textContent = 'Saved.';
            setTimeout(() => { result.textContent = ''; }, 1500);
        } catch (e) { result.className = 'err'; result.textContent = 'Network error.'; }
    }

    function renderProfileAvatarPreview(avatarUrl, username) {
        const el = document.getElementById('profile-avatar-preview');
        if (avatarUrl) {
            el.innerHTML = '<img src="' + avatarUrl + '" alt="avatar" style="width:56px;height:56px;border-radius:50%;object-fit:cover;border:1px solid rgba(255,255,255,0.2);">' +
                '<span style="opacity:0.5;font-size:0.8em;">Current avatar for @' + username + '</span>';
        } else {
            el.innerHTML = '<span style="opacity:0.4;font-size:0.8em;">No avatar set.</span>';
        }
    }

    async function loadProfile() {
        const username = document.getElementById('profile-username').value.trim();
        const resultEl = document.getElementById('profile-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        resultEl.className = ''; resultEl.textContent = 'Loading...';
        try {
            const res = await fetch('/admin/profile/' + encodeURIComponent(username));
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            document.getElementById('profile-nickname').value = data.Nickname || '';
            document.getElementById('profile-bio').value = data.bio || '';
            document.getElementById('profile-email').value = data.email || '';
            renderProfileAvatarPreview(data.avatar_url, data.username);
            resultEl.className = 'ok'; resultEl.textContent = 'Loaded profile for @' + username + '.';
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }

    async function saveProfileText() {
        const username = document.getElementById('profile-username').value.trim();
        const resultEl = document.getElementById('profile-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        const nickname = document.getElementById('profile-nickname').value.trim();
        const bio = document.getElementById('profile-bio').value;
        resultEl.className = ''; resultEl.textContent = 'Saving...';
        try {
            const res = await fetch('/admin/profile/' + encodeURIComponent(username) + '/text', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nickname, bio })
            });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            resultEl.className = 'ok'; resultEl.textContent = 'Profile text updated for @' + username + '.';
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }

    async function saveProfileEmail() {
        const username = document.getElementById('profile-username').value.trim();
        const resultEl = document.getElementById('profile-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        const email = document.getElementById('profile-email').value.trim();
        resultEl.className = ''; resultEl.textContent = 'Saving...';
        try {
            const res = await fetch('/admin/profile/' + encodeURIComponent(username) + '/email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            resultEl.className = 'ok'; resultEl.textContent = 'Email updated for @' + username + '.';
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }

    async function uploadProfileAvatar() {
        const username = document.getElementById('profile-username').value.trim();
        const resultEl = document.getElementById('profile-result');
        const fileInput = document.getElementById('profile-avatar-file');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        if (!fileInput.files[0]) { resultEl.className = 'err'; resultEl.textContent = 'Choose an image file first.'; return; }
        const formData = new FormData();
        formData.append('avatar', fileInput.files[0]);
        resultEl.className = ''; resultEl.textContent = 'Uploading...';
        try {
            const res = await fetch('/admin/profile/' + encodeURIComponent(username) + '/avatar', { method: 'POST', body: formData });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            renderProfileAvatarPreview(data.avatar_url, username);
            fileInput.value = '';
            resultEl.className = 'ok'; resultEl.textContent = 'Avatar updated for @' + username + '.';
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }

    async function resetProfileAvatar() {
        const username = document.getElementById('profile-username').value.trim();
        const resultEl = document.getElementById('profile-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        if (!confirm('Reset @' + username + '\\'s avatar to the default image?')) return;
        resultEl.className = ''; resultEl.textContent = 'Resetting...';
        try {
            const res = await fetch('/admin/profile/' + encodeURIComponent(username) + '/reset-avatar', { method: 'POST' });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            renderProfileAvatarPreview(data.avatar_url, username);
            resultEl.className = 'ok'; resultEl.textContent = 'Avatar reset for @' + username + '.';
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }

    async function loadBadges() {
        const username = document.getElementById('badge-username').value.trim();
        const resultEl = document.getElementById('badge-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        resultEl.className = ''; resultEl.textContent = 'Loading...';
        try {
            const res = await fetch('/admin/badges/' + encodeURIComponent(username));
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            document.getElementById('badge-admin') && (document.getElementById('badge-admin').checked = !!data.IsAdmin);
            document.getElementById('badge-headadmin') && (document.getElementById('badge-headadmin').checked = !!data.IsHeadAdmin);
            document.getElementById('badge-supporter').checked = !!data.IsSupporter;
            document.getElementById('badge-developer').checked = !!data.IsDeveloper;
            const ownerBox = document.getElementById('badge-owner');
            if (ownerBox) ownerBox.checked = !!data.IsOwner;
            resultEl.className = 'ok'; resultEl.textContent = 'Loaded badges for @' + username + '.';
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }

    async function saveBadges() {
        const username = document.getElementById('badge-username').value.trim();
        const resultEl = document.getElementById('badge-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        const ownerBox = document.getElementById('badge-owner');
        const adminBox = document.getElementById('badge-admin');
        const headadminBox = document.getElementById('badge-headadmin');
        const body = {
            IsSupporter: document.getElementById('badge-supporter').checked,
            IsDeveloper: document.getElementById('badge-developer').checked
        };
        if (adminBox) body.IsAdmin = adminBox.checked;
        if (ownerBox) body.IsHeadAdmin = headadminBox.checked;
        if (ownerBox) body.IsOwner = ownerBox.checked;
        resultEl.className = ''; resultEl.textContent = 'Saving...';
        try {
            const res = await fetch('/admin/badges/' + encodeURIComponent(username), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            resultEl.className = 'ok'; resultEl.textContent = 'Badges updated for @' + username + '.';
            setTimeout(() => location.reload(), 1000);
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }


    async function submitAction() {
        const username = document.getElementById('target-username').value.trim();
        const reason = document.getElementById('ban-reason').value.trim();
        const action = document.getElementById('action').value;
        const resultEl = document.getElementById('result');

        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Username is required.'; return; }
        if (action === 'ban' && !reason) { resultEl.className = 'err'; resultEl.textContent = 'A reason is required to ban.'; return; }

        resultEl.className = ''; resultEl.textContent = 'Working…';

        try {
            const res = await fetch('/admin/' + action + '/' + encodeURIComponent(username), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: action === 'ban' ? JSON.stringify({ reason }) : '{}'
            });
            const data = await res.json();
            if (!res.ok) {
                resultEl.className = 'err';
                resultEl.textContent = 'Error: ' + (data.error || res.status);
            } else {
                resultEl.className = 'ok';
                resultEl.textContent = action === 'ban'
                    ? '@' + username + ' has been banned.'
                    : '@' + username + ' has been unbanned.';
                document.getElementById('target-username').value = '';
                document.getElementById('ban-reason').value = '';
                setTimeout(() => location.reload(), 1200);
            }
        } catch (e) {
            resultEl.className = 'err';
            resultEl.textContent = 'Network error.';
        }
    }

    async function submitDeleteAccount() {
        const username = document.getElementById('delete-username').value.trim();
        const reason = document.getElementById('delete-reason').value.trim();
        const resultEl = document.getElementById('delete-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Username is required.'; return; }
        if (!reason) { resultEl.className = 'err'; resultEl.textContent = 'A reason is required to delete an account.'; return; }
        if (!confirm('This will reset @' + username + '\\'s avatar, name, and bio, mark the account as deleted, and delete all of its posts. The account stays in the database and the username is kept. Continue?')) return;

        resultEl.className = ''; resultEl.textContent = 'Working…';
        try {
            const res = await fetch('/admin/delete-account/' + encodeURIComponent(username), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason })
            });
            const data = await res.json();
            if (!res.ok) {
                resultEl.className = 'err';
                resultEl.textContent = 'Error: ' + (data.error || res.status);
            } else {
                resultEl.className = 'ok';
                resultEl.textContent = '@' + username + ' has been deleted.';
                document.getElementById('delete-username').value = '';
                document.getElementById('delete-reason').value = '';
                setTimeout(() => location.reload(), 1200);
            }
        } catch (e) {
            resultEl.className = 'err';
            resultEl.textContent = 'Network error.';
        }
    }

    async function submitHardDeleteAccount() {
        const username = document.getElementById('hard-delete-username').value.trim();
        const reason = document.getElementById('hard-delete-reason').value.trim();
        const resultEl = document.getElementById('hard-delete-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Username is required.'; return; }
        if (!reason) { resultEl.className = 'err'; resultEl.textContent = 'A reason is required to delete an account.'; return; }
        if (!confirm('This PERMANENTLY deletes @' + username + ' and everything tied to it (posts, DMs, group chat messages/memberships, follows, friends, friend requests, notifications) from the database. This CANNOT be undone. Continue?')) return;
        if (!confirm('Are you absolutely sure? Press OK to permanently erase @' + username + '.')) return;

        resultEl.className = ''; resultEl.textContent = 'Working…';
        try {
            const res = await fetch('/admin/delete-account-permanent/' + encodeURIComponent(username), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason })
            });
            const data = await res.json();
            if (!res.ok) {
                resultEl.className = 'err';
                resultEl.textContent = 'Error: ' + (data.error || res.status);
            } else {
                resultEl.className = 'ok';
                resultEl.textContent = '@' + username + ' has been permanently deleted from the database.';
                document.getElementById('hard-delete-username').value = '';
                document.getElementById('hard-delete-reason').value = '';
                setTimeout(() => location.reload(), 1200);
            }
        } catch (e) {
            resultEl.className = 'err';
            resultEl.textContent = 'Network error.';
        }
    }

    async function submitIPAction() {
        const ip = document.getElementById('target-ip').value.trim();
        const reason = document.getElementById('ip-ban-reason').value.trim();
        const action = document.getElementById('ip-action').value;
        const resultEl = document.getElementById('ip-result');

        if (!ip) { resultEl.className = 'err'; resultEl.textContent = 'IP address is required.'; return; }
        if (action === 'ipban' && !reason) { resultEl.className = 'err'; resultEl.textContent = 'A reason is required to IP ban.'; return; }

        resultEl.className = ''; resultEl.textContent = 'Working…';

        try {
            const endpoint = action === 'ipban' ? '/admin/ipban' : '/admin/unipban';
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ip, reason })
            });
            const data = await res.json();
            if (!res.ok) {
                resultEl.className = 'err';
                resultEl.textContent = 'Error: ' + (data.error || res.status);
            } else {
                resultEl.className = 'ok';
                resultEl.textContent = action === 'ipban'
                    ? ip + ' has been IP banned.'
                    : ip + ' has been IP unbanned.';
                document.getElementById('target-ip').value = '';
                document.getElementById('ip-ban-reason').value = '';
                setTimeout(() => location.reload(), 1200);
            }
        } catch (e) {
            resultEl.className = 'err';
            resultEl.textContent = 'Network error.';
        }
    }

    function prefillIPBan(ip) {
        document.getElementById('target-ip').value = ip;
        document.getElementById('ip-action').value = 'ipban';
        document.getElementById('target-ip').focus();
        document.getElementById('target-ip').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    async function unIPBan(ip) {
        const resultEl = document.getElementById('ip-result');
        resultEl.className = ''; resultEl.textContent = 'Working…';
        try {
            const res = await fetch('/admin/unipban', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ip })
            });
            const data = await res.json();
            if (!res.ok) {
                resultEl.className = 'err';
                resultEl.textContent = 'Error: ' + (data.error || res.status);
            } else {
                resultEl.className = 'ok';
                resultEl.textContent = ip + ' has been IP unbanned.';
                setTimeout(() => location.reload(), 1200);
            }
        } catch (e) {
            resultEl.className = 'err';
            resultEl.textContent = 'Network error.';
        }
    }

    document.getElementById('target-username').addEventListener('keydown', e => { if (e.key === 'Enter') submitAction(); });
    document.getElementById('ban-reason').addEventListener('keydown', e => { if (e.key === 'Enter') submitAction(); });
    document.getElementById('target-ip').addEventListener('keydown', e => { if (e.key === 'Enter') submitIPAction(); });
    document.getElementById('ip-ban-reason').addEventListener('keydown', e => { if (e.key === 'Enter') submitIPAction(); });

    function toggleNav() {
        const dropdown = document.getElementById('nav-dropdown');
        const btn = document.getElementById('nav-hamburger');
        dropdown.classList.toggle('open');
        btn.textContent = dropdown.classList.contains('open') ? '✕' : '☰';
    }
    document.addEventListener('click', function(e) {
        const dropdown = document.getElementById('nav-dropdown');
        const btn = document.getElementById('nav-hamburger');
        if (dropdown && btn && !dropdown.contains(e.target) && e.target !== btn) {
            dropdown.classList.remove('open');
            btn.textContent = '☰';
        }
    }); 
</script>

</body>
</html>`);
        });
        });
    });
});

app.post('/admin/ban/:username', requireAdmin, (req, res) => {
    const target = req.params.username;
    const reason = (req.body.reason || 'Banned by admin').substring(0, 500);
    if (target === req.session.userUsername) return res.status(400).json({ error: 'cannot ban yourself' });
    db.run(`UPDATE User_Data SET IsBanned = 1, BanReason = ? WHERE username = ?`, [reason, target], function(err) {
        if (err) return res.status(500).json({ error: 'db error' });
        if (this.changes === 0) return res.status(404).json({ error: 'user not found' });
        logAudit('account_banned', req.session.userUsername, target, reason);
        // Push ban event to any open SSE streams for this user, and email them
        db.get(`SELECT id, email FROM User_Data WHERE username = ?`, [target], (err2, row) => {
            if (!err2 && row) {
                userBus.emit(`user:${row.id}`, { event: 'banned', type: 'account', reason });
                if (row.email) sendAccountBannedEmail(row.email, target, reason);
            }
        });
        res.json({ ok: true, banned: true, username: target });
    });
});

app.post('/admin/unban/:username', requireAdmin, (req, res) => {
    const target = req.params.username;
    db.run(`UPDATE User_Data SET IsBanned = 0, BanReason = NULL WHERE username = ?`, [target], function(err) {
        if (err) return res.status(500).json({ error: 'db error' });
        if (this.changes === 0) return res.status(404).json({ error: 'user not found' });
        logAudit('account_unbanned', req.session.userUsername, target, null);
        db.get(`SELECT email FROM User_Data WHERE username = ?`, [target], (err2, row) => {
            if (!err2 && row && row.email) sendAccountUnbannedEmail(row.email, target);
        });
        res.json({ ok: true, banned: false, username: target });
    });
});

// Registration gate: ON = new signups are created banned pending manual
// activation and admins get pinged. OFF = registration is open, accounts
// are created active immediately, no pings sent.
app.get('/admin/registration-gate', requireAdmin, (req, res) => {
    res.json({ enabled: registrationGateEnabled });
});

app.post('/admin/registration-gate', requireAdmin, requireHeadAdmin, (req, res) => {
    const enabled = !!req.body.enabled;
    setRegistrationGateEnabled(enabled, (err) => {
        if (err) return res.status(500).json({ error: 'db error' });
        logAudit(enabled ? 'registration_gate_enabled' : 'registration_gate_disabled', req.session.userUsername, null, null);
        res.json({ ok: true, enabled: registrationGateEnabled });
    });
});

// Lets an admin/owner inspect and fix up anyone's public profile (avatar,
// nickname, bio) - e.g. removing an inappropriate pfp or bio without doing
// a full account deletion.
app.get('/admin/profile/:username', requireAdmin, (req, res) => {
    const target = req.params.username;
    db.get(`SELECT username, Nickname, bio, avatar_path, email FROM User_Data WHERE username = ?`, [target], (err, user) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!user) return res.status(404).json({ error: 'user not found' });
        res.json({
            username: user.username,
            Nickname: user.Nickname || '',
            bio: user.bio || '',
            email: user.email || '',
            avatar_url: user.avatar_path ? avatarPathToURL(user.avatar_path) : null
        });
    });
});

app.post('/admin/profile/:username/text', requireAdmin, (req, res) => {
    const target = req.params.username;
    let { nickname, bio } = req.body;
    nickname = (nickname || '').trim();
    bio = bio || '';
    if (nickname.length > MAX_NICKNAME_LENGTH) return res.status(400).json({ error: `Nickname too long - ${MAX_NICKNAME_LENGTH} character limit.` });
    if (bio.length > MAX_BIO_LENGTH) return res.status(400).json({ error: `Bio too long - ${MAX_BIO_LENGTH} character limit.` });
    db.run(`UPDATE User_Data SET Nickname = ?, bio = ? WHERE username = ?`, [nickname || null, bio, target], function(err) {
        if (err) return res.status(500).json({ error: 'db error' });
        if (this.changes === 0) return res.status(404).json({ error: 'user not found' });
        res.json({ ok: true, username: target });
    });
});

app.post('/admin/profile/:username/email', requireAdmin, (req, res) => {
    const target = req.params.username;
    const email = (req.body.email || '').trim().toLowerCase();
    if (email && !EMAIL_REGEX.test(email)) {
        return res.status(400).json({ error: 'That doesn\'t look like a valid email.' });
    }
    db.get(`SELECT id FROM User_Data WHERE username = ?`, [target], (err, user) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!user) return res.status(404).json({ error: 'user not found' });
        db.run(`UPDATE User_Data SET email = ? WHERE username = ?`, [email || null, target], function(err2) {
            if (err2) {
                if (err2.message && err2.message.includes('.email')) {
                    return res.status(400).json({ error: 'That email is already linked to another account.' });
                }
                return res.status(500).json({ error: 'db error' });
            }
            if (this.changes === 0) return res.status(404).json({ error: 'user not found' });
            logAudit('admin_email_changed', req.session.userUsername, target, email ? `set to ${email}` : 'cleared');
            res.json({ ok: true, username: target, email });
        });
    });
});

app.post('/admin/profile/:username/avatar', requireAdmin, (req, res) => {
    const target = req.params.username;
    db.get(`SELECT id FROM User_Data WHERE username = ?`, [target], (err, user) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!user) return res.status(404).json({ error: 'user not found' });
        adminAvatarUpload.single('avatar')(req, res, (uploadErr) => {
            if (uploadErr || !req.file) return res.status(400).json({ error: uploadErr ? uploadErr.message : 'No file uploaded.' });
            db.run(`UPDATE User_Data SET avatar_path = ? WHERE username = ?`, [req.file.path, target], (err2) => {
                if (err2) return res.status(500).json({ error: 'db error' });
                res.json({ ok: true, username: target, avatar_url: avatarPathToURL(req.file.path) });
            });
        });
    });
});

app.post('/admin/profile/:username/reset-avatar', requireAdmin, (req, res) => {
    const target = req.params.username;
    db.run(`UPDATE User_Data SET avatar_path = ? WHERE username = ?`, ['public/Default.svg', target], function(err) {
        if (err) return res.status(500).json({ error: 'db error' });
        if (this.changes === 0) return res.status(404).json({ error: 'user not found' });
        res.json({ ok: true, username: target, avatar_url: avatarPathToURL('public/Default.svg') });
    });
});

// Soft-deletes an account: keeps the row (and username) in the DB, but wipes
// the public-facing identity - avatar reverts to the default, nickname/bio
// are cleared and replaced with a placeholder so the account reads as gone.
// Uses the separate IsDeleted/DeleteReason columns (rather than IsBanned) so
// deleted accounts are enforced and displayed distinctly from banned ones,
// and removes all of its posts. A reason is required.
app.post('/admin/delete-account/:username', requireAdmin, (req, res) => {
    const target = req.params.username;
    if (target === req.session.userUsername) return res.status(400).json({ error: 'cannot delete your own account' });
    const reason = ((req.body && req.body.reason) || '').trim().substring(0, 500);
    if (!reason) return res.status(400).json({ error: 'a reason is required to delete an account' });
    db.run(
        `UPDATE User_Data SET avatar_path = ?, Nickname = ?, bio = ?, IsDeleted = 1, DeleteReason = ? WHERE username = ?`,
        ['public/Default.svg', 'Account Deleted', '', reason, target],
        function(err) {
            if (err) return res.status(500).json({ error: 'db error' });
            if (this.changes === 0) return res.status(404).json({ error: 'user not found' });
            db.run(`DELETE FROM Posts WHERE username = ?`, [target], (err2) => {
                if (err2) return res.status(500).json({ error: 'db error deleting posts' });
                // Push a deleted event to any open SSE streams for this user, and email them
                db.get(`SELECT id, email FROM User_Data WHERE username = ?`, [target], (err3, row) => {
                    if (!err3 && row) {
                        userBus.emit(`user:${row.id}`, { event: 'deleted', type: 'deleted', reason });
                        if (row.email) sendAccountDeletedEmail(row.email, target, reason);
                    }
                });
                logAudit('account_deleted', req.session.userUsername, target, reason);
                res.json({ ok: true, deleted: true, username: target });
            });
        }
    );
});

// Permanently removes a user and every row tied to their username/id across
// the schema. Unlike the soft-delete above, there's no row left behind and
// the username becomes available again. Used by both the admin hard-delete
// route and self-service account deletion from the dashboard.
function hardDeleteAccount(username, reason, callback) {
    db.get(`SELECT id, email FROM User_Data WHERE username = ?`, [username], (err, row) => {
        if (err) return callback(err);
        if (!row) return callback(new Error('user not found'));
        const userId = row.id;
        const email = row.email;
        db.serialize(() => {
            db.run(`DELETE FROM Messages WHERE from_user = ? OR to_user = ?`, [username, username]);
            db.run(`DELETE FROM Password_Resets WHERE user_id = ?`, [userId]);
            db.run(`DELETE FROM Email_Changes WHERE user_id = ?`, [userId]);
            db.run(`DELETE FROM Email_Verifications WHERE user_id = ?`, [userId]);
            db.run(`DELETE FROM Posts WHERE username = ?`, [username]);
            db.run(`DELETE FROM Follows WHERE follower_username = ? OR following_username = ?`, [username, username]);
            db.run(`DELETE FROM Friend_Requests WHERE from_user = ? OR to_user = ?`, [username, username]);
            db.run(`DELETE FROM Friends WHERE user_a = ? OR user_b = ?`, [username, username]);
            db.run(`DELETE FROM Notifications WHERE username = ? OR actor_username = ?`, [username, username]);
            db.run(`DELETE FROM Group_Chat_Members WHERE username = ?`, [username]);
            db.run(`DELETE FROM Group_Chat_Messages WHERE from_user = ?`, [username]);
            db.run(`DELETE FROM User_Data WHERE username = ?`, [username], function (err2) {
                if (err2) return callback(err2);
                if (this.changes === 0) return callback(new Error('user not found'));
                // Push a 'deleted' event to any open tabs for this user, same as
                // the soft delete above, so an active session sees the "Account
                // Deleted" screen immediately instead of waiting for its next
                // navigation (which the checkBan middleware would also catch).
                const cleanReason = reason || 'Account deleted';
                userBus.emit(`user:${userId}`, { event: 'deleted', type: 'deleted', reason: cleanReason });
                // Email captured before the row was deleted, since the address
                // is gone from the DB by the time we get here.
                if (email) sendAccountPermanentlyDeletedEmail(email, username, cleanReason);
                callback(null);
            });
        });
    });
}

// Permanently deletes an account and all associated data from the database.
// This CANNOT be undone (unlike /admin/delete-account above, which keeps a
// hollowed-out row so the username stays reserved). Restricted to Head
// Admins/Owner given the blast radius.
app.post('/admin/delete-account-permanent/:username', requireAdmin, requireHeadAdmin, (req, res) => {
    const target = req.params.username;
    if (target === req.session.userUsername) return res.status(400).json({ error: 'cannot delete your own account here - use the dashboard' });
    const reason = ((req.body && req.body.reason) || '').trim().substring(0, 500);
    if (!reason) return res.status(400).json({ error: 'a reason is required to delete an account' });
    hardDeleteAccount(target, reason, (err) => {
        if (err) {
            if (err.message === 'user not found') return res.status(404).json({ error: 'user not found' });
            console.error('Hard delete error:', err.message);
            return res.status(500).json({ error: 'db error' });
        }
        logAudit('account_permanently_deleted', req.session.userUsername, target, reason);
        res.json({ ok: true, deleted: true, permanent: true, username: target });
    });
});

app.post('/admin/ipban', requireAdmin, (req, res) => {
    const { ip, reason } = req.body;
    if (!ip) return res.status(400).json({ error: 'ip is required' });
    const cleanReason = (reason || 'Banned by admin').substring(0, 500);
    const bannedBy = req.session.userUsername;
    db.run(
        `INSERT INTO IP_Bans (ip, reason, banned_by) VALUES (?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by, created_at = CURRENT_TIMESTAMP`,
        [ip, cleanReason, bannedBy],
        function(err) {
            if (err) return res.status(500).json({ error: 'db error' });
            logAudit('ip_banned', bannedBy, ip, cleanReason);
            // Notify only users currently connected from this exact IP - not
            // everyone with an open stream.
            userEventConnections.forEach(conn => {
                if (conn.ip === ip) {
                    sseSend(conn.res, 'banned', { event: 'banned', type: 'ip', reason: cleanReason });
                }
            });
            res.json({ ok: true, ip, reason: cleanReason });
        }
    );
});

app.post('/admin/unipban', requireAdmin, (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'ip is required' });
    db.run(`DELETE FROM IP_Bans WHERE ip = ?`, [ip], function(err) {
        if (err) return res.status(500).json({ error: 'db error' });
        if (this.changes === 0) return res.status(404).json({ error: 'ip not found in ban list' });
        logAudit('ip_unbanned', req.session.userUsername, ip, null);
        res.json({ ok: true, ip });
    });
});

app.get('/admin/ipbans', requireAdmin, (req, res) => {
    db.all(`SELECT ip, reason, banned_by, created_at FROM IP_Bans ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({ ipbans: rows || [] });
    });
});

app.get('/admin/badges/:username', requireAdmin, (req, res) => {
    const target = req.params.username;
    db.get(`SELECT IsOwner, IsHeadAdmin, IsAdmin, IsDeveloper, IsSupporter FROM User_Data WHERE username = ?`, [target], (err, user) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!user) return res.status(404).json({ error: 'user not found' });
        res.json(user);
    });
});

app.post('/admin/badges/:username', requireAdmin, (req, res) => {
    const target = req.params.username;
    const { IsAdmin, IsHeadAdmin, IsSupporter, IsDeveloper, IsOwner } = req.body;

    const fields = [];
    const values = [];
    fields.push('IsSupporter = ?'); values.push(IsSupporter ? 1 : 0);
    fields.push('IsDeveloper = ?'); values.push(IsDeveloper ? 1 : 0);

    // Only an existing Owner can grant or revoke the Admin and Owner badges -
    // otherwise any admin could hand out admin (or owner) access to anyone.
    if (req.isHeadAdmin) {
        if (typeof IsAdmin !== 'undefined') { fields.push('IsAdmin = ?'); values.push(IsAdmin ? 1 : 0); }  
    }
    if (req.isOwner) {
        if (typeof IsHeadAdmin !== 'undefined') { fields.push('IsHeadAdmin = ?'); values.push(IsHeadAdmin ? 1 : 0); }
        if (typeof IsOwner !== 'undefined') { fields.push('IsOwner = ?'); values.push(IsOwner ? 1 : 0); }
    }

    values.push(target);
    db.run(`UPDATE User_Data SET ${fields.join(', ')} WHERE username = ?`, values, function(err) {
        if (err) return res.status(500).json({ error: 'db error' });
        if (this.changes === 0) return res.status(404).json({ error: 'user not found' });
        res.json({ ok: true, username: target });
    });
});

app.post('/admin/pin/:id', requireAdmin, (req, res) => {
    const postId = parseInt(req.params.id);
    if (!postId) return res.status(400).json({ error: 'invalid id' });
    db.run(`UPDATE Posts SET pinned = 1 WHERE id = ?`, [postId], function(err) {
        if (err) return res.status(500).json({ error: 'db error' });
        if (this.changes === 0) return res.status(404).json({ error: 'post not found' });
        res.json({ ok: true });
    });
});

app.post('/admin/unpin/:id', requireAdmin, (req, res) => {
    const postId = parseInt(req.params.id);
    if (!postId) return res.status(400).json({ error: 'invalid id' });
    db.run(`UPDATE Posts SET pinned = 0 WHERE id = ?`, [postId], function(err) {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({ ok: true });
    });
});

app.get('/admin/users', requireAdmin, (req, res) => {
    db.all(`SELECT id, username, IsBanned, BanReason, IsOwner, IsHeadAdmin, IsAdmin, IsDeveloper, IsSupporter FROM User_Data ORDER BY id ASC`, [], (err, users) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({ users: users || [] });
    });
});

function renderGCMessageBubble(m, me, replyMsg) {
    const mine = m.from_user === me;
    const fileHTML = renderAttachmentsHTML(getAttachments(m), 260, '260px');
    const { embedHTML, cleanText } = renderEmbeds(m.content || '');
    const replyBanner = replyMsg
        ? `<div style="font-size:0.78em;opacity:0.6;border-left:3px solid white;padding-left:8px;margin-bottom:4px;">> replying to <strong>${escapeHTML(replyMsg.from_user)}</strong>: ${escapeHTML((replyMsg.content || '').substring(0,60))}${(replyMsg.content || '').length > 60 ? '...' : ''}</div>`
        : '';
    const avatarHTML = renderAvatarHTML(m.avatar_path, m.from_user, 28);
    const senderLabel = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <a href="/user/${escapeHTML(m.from_user)}" style="flex-shrink:0;">${avatarHTML}</a>
        <a href="/user/${escapeHTML(m.from_user)}" style="color:${mine ? 'white' : 'rgb(0,191,255)'};text-decoration:none;font-weight:700;font-size:0.75em;">${renderNameWithHandle(m.from_user, m.Nickname)}</a>
    </div>`;
    const deleteLink = mine ? `<a href="#" onclick="deleteGCMessage(${m.id});return false;" style="color:rgb(255,90,90);text-decoration:none;">Delete</a>` : '';
    return `<div class="chat-msg-row" data-id="${m.id}" style="display:flex;justify-content:${mine ? 'flex-end' : 'flex-start'};margin-bottom:10px;">
        <div style="max-width:70%;background:${mine ? 'rgba(0,191,255,0.15)' : 'rgba(255,255,255,0.08)'};border:1px solid ${mine ? 'rgba(0,191,255,0.4)' : 'rgba(255,255,255,0.2)'};border-radius:12px;padding:8px 12px;">
            ${senderLabel}
            ${replyBanner}
            <div style="word-break:break-word;overflow-wrap:break-word;white-space:pre-wrap;">${linkifyMentions(escapeHTML(cleanText))}</div>
            ${embedHTML}
            ${fileHTML}
            <div style="font-size:0.7em;opacity:0.5;margin-top:4px;display:flex;justify-content:flex-end;align-items:center;gap:10px;">
                <a href="#" onclick="setGCReply(${m.id}, '${escapeHTML(m.from_user)}');return false;" style="color:rgb(0,191,255);text-decoration:none;">Reply</a>
                ${deleteLink}
                <span data-ts="${m.created_at.replace(' ','T')+'Z'}"></span>
            </div>
        </div>
    </div>`;
}

app.get('/groups', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const me = req.session.userUsername;
    db.all(`SELECT Group_Chats.*, GROUP_CONCAT(Group_Chat_Members.username, ', ') AS members_list
            FROM Group_Chats
            JOIN Group_Chat_Members ON Group_Chats.id = Group_Chat_Members.group_id
            WHERE Group_Chats.id IN (SELECT group_id FROM Group_Chat_Members WHERE username = ?)
            GROUP BY Group_Chats.id
            ORDER BY Group_Chats.created_at DESC`, [me], (err, groups) => {
        if (err) { console.error(err); return res.status(500).send('Error loading groups'); }
        const groupsHTML = (groups || []).map(g => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.1);">
                <div>
                    <a href="/groups/${g.id}" style="color:white;text-decoration:none;font-weight:bold;font-size:1.05em;">${escapeHTML(g.name)}</a>
                    <div style="font-size:0.8em;opacity:0.5;margin-top:3px;">${escapeHTML(g.members_list || '')}</div>
                </div>
                <a href="/groups/${g.id}" class="button" style="padding:8px 16px;text-decoration:none;white-space:nowrap;">Open</a>
            </div>`).join('');

        res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Group Chats</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
<style>
    body { margin: 0; background: black; color: white; font-family: 'Quicksand', sans-serif; display: flex; flex-direction: column; min-height: 100vh; }
    #gc-topbar { position: fixed; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: black; border-bottom: 2px solid white; z-index: 100; }
    #gc-topbar-right { position: relative; display: flex; align-items: center; }
    #gc-topbar-right a { color: rgb(0,191,255); text-decoration: none; margin-left: 15px; }
    #gc-topbar-right a:hover { text-decoration: underline; }
    #nav-hamburger { display: none; background: none; border: 2px solid white; border-radius: 6px; color: white; font-size: 1.1em; cursor: pointer; padding: 4px 8px; line-height: 1; margin-left: 10px; }
    #nav-dropdown { display: none; flex-direction: column; position: absolute; top: 100%; right: 0; background: black; border: 2px solid white; border-radius: 10px; padding: 8px 0; min-width: 160px; z-index: 200; }
    #nav-dropdown a { display: block; color: rgb(0,191,255); text-decoration: none; padding: 8px 18px; white-space: nowrap; margin: 0; }
    #nav-dropdown a:hover { background: rgba(255,255,255,0.08); text-decoration: underline; }
    #nav-dropdown.open { display: flex; }
    @media (max-width: 600px) {
        #gc-topbar-right > a { display: none; }
        #nav-hamburger { display: inline-block; }
    }
    #gc-body { max-width: 600px; margin: 70px auto 0; padding: 24px 20px; }
    #create-gc-form { display: flex; flex-direction: column; gap: 10px; margin-bottom: 32px; padding: 16px; border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; }
    #create-gc-form input { background: black; color: white; border: 2px solid white; border-radius: 8px; padding: 8px 12px; font-family: inherit; font-size: 0.95em; }
    #friends-picker-modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.75); z-index:9999; align-items:center; justify-content:center; }
    #friends-picker-modal.open { display:flex; }
    #friends-picker-box { background: black; border:2px solid white; border-radius:14px; padding:24px; width:340px; max-width:90vw; max-height:80vh; display:flex; flex-direction:column; gap:12px; }
    #friends-picker-list { overflow-y:auto; flex:1; display:flex; flex-direction:column; gap:8px; }
    .friend-pick-row { display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid rgba(255,255,255,0.15); border-radius:8px; cursor:pointer; transition:background 0.15s; }
    .friend-pick-row:hover { background:rgba(255,255,255,0.07); }
    .friend-pick-row input[type=checkbox] { width:16px; height:16px; accent-color:rgb(0,191,255); flex-shrink:0; cursor:pointer; }
    #friends-picker-search { background:black; color:white; border:2px solid white; border-radius:8px; padding:6px 10px; font-family:inherit; font-size:0.9em; width:100%; box-sizing:border-box; }
    #gc-selected-tags { display:flex; flex-wrap:wrap; gap:6px; min-height:28px; }
    .gc-tag { background:rgba(0,191,255,0.18); border:1px solid rgba(0,191,255,0.5); border-radius:20px; padding:3px 10px; font-size:0.82em; display:flex; align-items:center; gap:6px; }
    .gc-tag button { background:none; border:none; color:rgb(0,191,255); cursor:pointer; font-size:1em; padding:0; line-height:1; }
    #gc-add-picker-modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.75); z-index:9999; align-items:center; justify-content:center; }
    #gc-add-picker-modal.open { display:flex; }
    #gc-add-picker-box { background: black; border:2px solid white; border-radius:14px; padding:24px; width:340px; max-width:90vw; max-height:80vh; display:flex; flex-direction:column; gap:12px; }
    #gc-add-picker-list { overflow-y:auto; flex:1; display:flex; flex-direction:column; gap:8px; }
    #gc-add-picker-search { background:black; color:white; border:2px solid white; border-radius:8px; padding:6px 10px; font-family:inherit; font-size:0.9em; width:100%; box-sizing:border-box; }
</style>
</head>
<body>
    <div id="gc-topbar">
        <div>Group Chats</div>
        <div id="gc-topbar-right">
            <a href="/messages">DMs</a>
            <a href="/feed">Feed</a>
            <a href="/notifications" class="notif-nav-link">Notifications</a>
            <a href="/logout">Logout</a>
            <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
            <nav id="nav-dropdown">
                <a href="/messages">DMs</a>
                <a href="/feed">Feed</a>
                <a href="/notifications" class="notif-nav-link">Notifications</a>
                <a href="/logout">Logout</a>
            </nav>
        </div>
    </div>
    <div id="friends-picker-modal" role="dialog" aria-modal="true">
        <div id="friends-picker-box">
            <div style="font-weight:700;font-size:1.05em;">Select Friends to Add</div>
            <input id="friends-picker-search" type="text" placeholder="Search friends…" oninput="filterFriendsPicker()">
            <div id="friends-picker-list"><p style="opacity:0.4;text-align:center;">Loading…</p></div>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button class="button" onclick="closeFriendsPicker()" style="padding:6px 16px;width:auto;height:auto;">Cancel</button>
                <button class="button" onclick="confirmFriendsPicker()" style="padding:6px 16px;width:auto;height:auto;background:rgba(0, 0, 0, 0.15);border-color:rgb(255, 255, 255);color:rgb(255, 255, 255);">Done</button>
            </div>
        </div>
    </div>

    <div id="gc-body">
        <div id="create-gc-form">
            <h3 style="margin:0 0 8px;">New Group Chat</h3>
            <input style="height: 25px;" type="text" id="gc-name" placeholder="Group name" maxlength="80">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;height: 25px;">
                <button class="button" type="button" onclick="openFriendsPicker()" style="padding:7px 14px;width:auto;height:auto;font-size:0.9em;">+ Add Friends</button>
                <span style="font-size:0.82em;opacity:0.5;" id="gc-selected-count">No friends selected</span>
            </div>
            <div id="gc-selected-tags"></div>
            <div id="gc-create-result" style="font-size:0.85em;min-height:1em;"></div>
            <button class="button" onclick="createGC()" style="width:140px;padding:10px;">Create Group</button>
        </div>
        <h3 style="opacity:0.6;margin:0 0 12px;">Your Groups</h3>
        ${groupsHTML || '<p style="opacity:0.4;">No group chats yet.</p>'}
    </div>
    <script>
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => { btn.classList.add('clicked'); setTimeout(() => btn.classList.remove('clicked'), 150); });
        });

        let allFriends = [];
        let selectedFriends = new Set();

        async function loadFriends() {
            try {
                const r = await fetch('/api/my-friends');
                const d = await r.json();
                allFriends = d.friends || [];
            } catch(e) { allFriends = []; }
        }
        loadFriends();

        function openFriendsPicker() {
            if (!allFriends.length) {
                const result = document.getElementById('gc-create-result');
                result.style.color = 'rgb(255,80,80)';
                result.textContent = 'You have no friends to add yet.';
                return;
            }
            document.getElementById('friends-picker-search').value = '';
            renderFriendsPickerList(allFriends);
            document.getElementById('friends-picker-modal').classList.add('open');
        }

        function closeFriendsPicker() {
            document.getElementById('friends-picker-modal').classList.remove('open');
        }

        function renderFriendsPickerList(list) {
            const container = document.getElementById('friends-picker-list');
            if (!list.length) { container.innerHTML = '<p style="opacity:0.4;text-align:center;">No friends found.</p>'; return; }
            container.innerHTML = list.map(u => \`
                <label class="friend-pick-row">
                    <input type="checkbox" value="\${u}" \${selectedFriends.has(u) ? 'checked' : ''} onchange="togglePickedFriend(this)">
                    <span>@\${u}</span>
                </label>\`).join('');
        }

        function filterFriendsPicker() {
            const q = document.getElementById('friends-picker-search').value.toLowerCase();
            renderFriendsPickerList(allFriends.filter(u => u.toLowerCase().includes(q)));
        }

        function togglePickedFriend(cb) {
            if (cb.checked) selectedFriends.add(cb.value);
            else selectedFriends.delete(cb.value);
        }

        function confirmFriendsPicker() {
            closeFriendsPicker();
            updateSelectedTags();
        }

        function updateSelectedTags() {
            const tagsEl = document.getElementById('gc-selected-tags');
            const countEl = document.getElementById('gc-selected-count');
            const arr = [...selectedFriends];
            tagsEl.innerHTML = arr.map(u => \`<span class="gc-tag">@\${u}<button type="button" onclick="removeFriendTag('\${u}')" title="Remove">×</button></span>\`).join('');
            countEl.textContent = arr.length ? arr.length + ' friend' + (arr.length !== 1 ? 's' : '') + ' selected' : 'No friends selected';
        }

        function removeFriendTag(u) {
            selectedFriends.delete(u);
            updateSelectedTags();
        }

        async function createGC() {
            const name = document.getElementById('gc-name').value.trim();
            const members = [...selectedFriends];
            const result = document.getElementById('gc-create-result');
            if (!name) { result.style.color = 'rgb(255,80,80)'; result.textContent = 'Group name is required.'; return; }
            if (!members.length) { result.style.color = 'rgb(255,80,80)'; result.textContent = 'Add at least one friend.'; return; }
            result.style.color = 'white'; result.textContent = 'Creating...';
            try {
                const r = await fetch('/groups/create', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, members }) });
                const d = await r.json();
                if (!r.ok) { result.style.color = 'rgb(255,80,80)'; result.textContent = d.error || 'Error creating group.'; }
                else { window.location.href = '/groups/' + d.id; }
            } catch(e) { result.style.color = 'rgb(255,80,80)'; result.textContent = 'Network error.'; }
        }

        document.getElementById('friends-picker-modal').addEventListener('click', function(e) {
            if (e.target === this) closeFriendsPicker();
        });
        function toggleNav() {
            const dropdown = document.getElementById('nav-dropdown');
            const btn = document.getElementById('nav-hamburger');
            dropdown.classList.toggle('open');
            btn.textContent = dropdown.classList.contains('open') ? '✕' : '☰';
        }
        document.addEventListener('click', function(e) {
            const dropdown = document.getElementById('nav-dropdown');
            const btn = document.getElementById('nav-hamburger');
            if (dropdown && btn && !dropdown.contains(e.target) && e.target !== btn) {
                dropdown.classList.remove('open');
                btn.textContent = '☰';
            }
        });
    </script>
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}

</body>
</html>`);
    });
});

app.post('/groups/create', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const me = req.session.userUsername;
    let { name, members } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Group name is required.' });
    name = name.trim().substring(0, 80);
    if (!Array.isArray(members) || !members.length) return res.status(400).json({ error: 'Add at least one friend.' });
    members = [...new Set(members.map(m => m.trim()).filter(Boolean))].filter(m => m !== me).slice(0, 49);

    const checkFriends = (list, cb) => {
        if (!list.length) return cb(null);
        const u = list[0];
        const a = [me, u].sort()[0], b = [me, u].sort()[1];
        db.get(`SELECT id FROM Friends WHERE user_a = ? AND user_b = ?`, [a, b], (err, row) => {
            if (err || !row) return cb(`${u} is not your friend.`);
            checkFriends(list.slice(1), cb);
        });
    };

    checkFriends(members, (friendErr) => {
        if (friendErr) return res.status(400).json({ error: friendErr });
        db.run(`INSERT INTO Group_Chats (name, created_by) VALUES (?, ?)`, [name, me], function(err) {
            if (err) return res.status(500).json({ error: 'db error' });
            const groupId = this.lastID;
            const allMembers = [me, ...members];
            const placeholders = allMembers.map(() => `(?, ?)`).join(',');
            const vals = allMembers.flatMap(u => [groupId, u]);
            db.run(`INSERT OR IGNORE INTO Group_Chat_Members (group_id, username) VALUES ${placeholders}`, vals, (err2) => {
                if (err2) return res.status(500).json({ error: 'db error' });
                res.json({ ok: true, id: groupId });
            });
        });
    });
});

app.post('/groups/:id/add-member', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const me = req.session.userUsername;
    const groupId = parseInt(req.params.id);
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    const newMember = username.trim();
    if (!newMember) return res.status(400).json({ error: 'username required' });

    db.get(`SELECT id FROM Group_Chat_Members WHERE group_id = ? AND username = ?`, [groupId, me], (err, myRow) => {
        if (!myRow) return res.status(403).json({ error: 'You are not in this group.' });

        const a = [me, newMember].sort()[0], b = [me, newMember].sort()[1];
        db.get(`SELECT id FROM Friends WHERE user_a = ? AND user_b = ?`, [a, b], (err2, friendRow) => {
            if (!friendRow) return res.status(400).json({ error: `${newMember} is not your friend.` });
            db.run(`INSERT OR IGNORE INTO Group_Chat_Members (group_id, username) VALUES (?, ?)`, [groupId, newMember], function(err3) {
                if (err3) return res.status(500).json({ error: 'db error' });
                if (this.changes === 0) return res.status(400).json({ error: `${newMember} is already in the group.` });
                res.json({ ok: true });
            });
        });
    });
});

app.post('/groups/:id/leave', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const me = req.session.userUsername;
    const groupId = parseInt(req.params.id);
    db.get(`SELECT id FROM Group_Chat_Members WHERE group_id = ? AND username = ?`, [groupId, me], (err, myRow) => {
        if (!myRow) return res.status(400).json({ error: 'You are not in this group.' });
        db.run(`DELETE FROM Group_Chat_Members WHERE group_id = ? AND username = ?`, [groupId, me], (err2) => {
            if (err2) return res.status(500).json({ error: 'db error' });
            // If no members remain, clean up the group and its messages
            db.get(`SELECT COUNT(*) AS cnt FROM Group_Chat_Members WHERE group_id = ?`, [groupId], (err3, row) => {
                if (!err3 && row && row.cnt === 0) {
                    db.run(`DELETE FROM Group_Chat_Messages WHERE group_id = ?`, [groupId]);
                    db.run(`DELETE FROM Group_Chats WHERE id = ?`, [groupId]);
                }
                res.json({ ok: true });
            });
        });
    });
});

app.post('/groups/:id/kick/:username', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const me = req.session.userUsername;
    const groupId = parseInt(req.params.id);
    const target = req.params.username;
    if (target === me) return res.status(400).json({ error: 'You cannot kick yourself. Use leave instead.' });
    // Only the group creator can kick
    db.get(`SELECT created_by FROM Group_Chats WHERE id = ?`, [groupId], (err, group) => {
        if (err || !group) return res.status(404).json({ error: 'Group not found.' });
        if (group.created_by !== me) return res.status(403).json({ error: 'Only the group creator can kick members.' });
        db.run(`DELETE FROM Group_Chat_Members WHERE group_id = ? AND username = ?`, [groupId, target], function(err2) {
            if (err2) return res.status(500).json({ error: 'db error' });
            if (this.changes === 0) return res.status(404).json({ error: `${target} is not in this group.` });
            res.json({ ok: true });
        });
    });
});

app.get('/groups/:id', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const me = req.session.userUsername;
    const groupId = parseInt(req.params.id);

    db.get(`SELECT * FROM Group_Chats WHERE id = ?`, [groupId], (err, group) => {
        if (err || !group) return res.status(404).send('Group not found');
        db.get(`SELECT id FROM Group_Chat_Members WHERE group_id = ? AND username = ?`, [groupId, me], (err2, memberRow) => {
            if (!memberRow) return res.status(403).sendFile(path.join(__dirname, 'group_access_denied.html'));
            db.all(`SELECT username FROM Group_Chat_Members WHERE group_id = ? ORDER BY joined_at ASC`, [groupId], (err3, members) => {
                db.all(`SELECT Group_Chat_Messages.*, User_Data.avatar_path, User_Data.Nickname FROM Group_Chat_Messages LEFT JOIN User_Data ON Group_Chat_Messages.from_user = User_Data.username WHERE group_id = ? ORDER BY created_at ASC`, [groupId], (err4, msgs) => {
                    const msgMap = {};
                    (msgs || []).forEach(m => msgMap[m.id] = m);
                    const msgsHTML = (msgs || []).map(m => renderGCMessageBubble(m, me, m.reply_to ? msgMap[m.reply_to] : null)).join('');
                    const isCreator = group.created_by === me;
                    const membersListHTML = (members || []).map(mbr =>
                        `<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,0.08);border-radius:20px;padding:3px 10px;font-size:0.82em;">
                            <a href="/user/${escapeHTML(mbr.username)}" style="color:white;text-decoration:none;">${escapeHTML(mbr.username)}</a>
                            ${isCreator && mbr.username !== me ? `<button onclick="kickMember('${escapeHTML(mbr.username)}')" title="Kick ${escapeHTML(mbr.username)}" style="background:none;border:none;color:rgb(255,80,80);cursor:pointer;font-size:0.9em;padding:0 2px;line-height:1;" aria-label="Kick ${escapeHTML(mbr.username)}">✕</button>` : ''}
                        </span>`).join('');

                    res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHTML(group.name)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/styles.css">
<style>
    body { margin: 0; background: black; color: white; font-family: 'Quicksand', sans-serif; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    #gc-chat-topbar { position: fixed; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: black; border-bottom: 2px solid white; z-index: 100; gap: 12px; }
    #gc-chat-topbar-right { position: relative; display: flex; align-items: center; }
    #gc-chat-topbar-right a { color: rgb(0,191,255); text-decoration: none; margin-left: 15px; }
    #gc-chat-topbar-right a:hover { text-decoration: underline; }
    #nav-hamburger { display: none; background: none; border: 2px solid white; border-radius: 6px; color: white; font-size: 1.1em; cursor: pointer; padding: 4px 8px; line-height: 1; margin-left: 10px; }
    #nav-dropdown { display: none; flex-direction: column; position: absolute; top: 100%; right: 0; background: black; border: 2px solid white; border-radius: 10px; padding: 8px 0; min-width: 160px; z-index: 200; }
    #nav-dropdown a { display: block; color: rgb(0,191,255); text-decoration: none; padding: 8px 18px; white-space: nowrap; margin: 0; }
    #nav-dropdown a:hover { background: rgba(255,255,255,0.08); text-decoration: underline; }
    #nav-dropdown.open { display: flex; }
    @media (max-width: 600px) {
        #gc-chat-topbar-right > a { display: none; }
        #nav-hamburger { display: inline-block; }
    }
    #gc-members-bar { position: fixed; top: 40px; left: 0; right: 0; background: black; border-bottom: 1px solid rgba(0, 0, 0, 0.15); padding: 6px 20px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; z-index: 99; font-size: 0.82em; }
    #gc-chat-messages { flex: 1; overflow-y: auto; padding: 110px 20px 130px 20px; max-width: 700px; width: 100%; margin: 0 auto; box-sizing: border-box; }
    #gc-chat-input-bar { position: fixed; bottom: 0; left: 0; right: 0; background: black; border-top: 2px solid white; padding: 10px 20px; z-index: 100; }
    #gc-reply-indicator { font-size: 0.85em; opacity: 0.7; display: none; margin-bottom: 6px; text-align: center; }
    #gc-form-row { display: flex; align-items: center; gap: 10px; width: 100%; }
    #gc-form-row textarea { text-align: left; flex: 1; height: 44px; resize: none; min-width: 0; background: black; color: white; border: 2px solid white; border-radius: 10px; padding: 8px; font-family: inherit; font-size: inherit; box-sizing: border-box; }
    #gc-file-name { font-size: 0.78em; opacity: 0.65; text-align: center; margin-top: 4px; }
    .gc-action-btn { padding: 0 !important; height: 44px !important; width: 70px !important; font-size: 0.85em !important; line-height: 1 !important; box-sizing: border-box !important; border: 5px solid white; margin: 0; text-align: center; border-radius: 15px; color: white; background-color: black; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; transition: 0.2s; }
    .gc-action-btn:hover { background-color: rgba(255, 0, 0, 0.48); color: white; }
    .gc-action-btn.clicked { background-color: black !important; color: white !important; }
    #add-member-row { display: flex; gap: 8px; align-items: center; padding: 4px 0; }
    #gc-add-picker-modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.75); z-index:9999; align-items:center; justify-content:center; }
    #gc-add-picker-modal.open { display:flex; }
    #gc-add-picker-box { background: black; border:2px solid white; border-radius:14px; padding:24px; width:320px; max-width:90vw; max-height:75vh; display:flex; flex-direction:column; gap:12px; }
    #gc-add-picker-list { overflow-y:auto; flex:1; display:flex; flex-direction:column; gap:8px; }
    #gc-add-picker-search { background:black; color:white; border:2px solid white; border-radius:8px; padding:6px 10px; font-family:inherit; font-size:0.9em; width:100%; box-sizing:border-box; }
    .gc-add-friend-row { display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid rgba(255,255,255,0.15); border-radius:8px; cursor:pointer; transition:background 0.15s; justify-content:space-between; }
    .gc-add-friend-row:hover { background:rgba(255,255,255,0.07); }
    .gt-action-bttn:hover {
</style>
</head>
<body>
    <div id="gc-chat-topbar">
        <div style="font-weight:bold;">${escapeHTML(group.name)}</div>
        <div id="gc-chat-topbar-right">
            <a href="/groups">Groups</a>
            <a href="/messages">DMs</a>
            <a href="/feed">Feed</a>
            <a href="/notifications" class="notif-nav-link">Notifications</a>
            <a href="/logout">Logout</a>
            <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
            <nav id="nav-dropdown">
                <a href="/groups">Groups</a>
                <a href="/messages">DMs</a>
                <a href="/feed">Feed</a>
                <a href="/notifications" class="notif-nav-link">Notifications</a>
                <a href="/logout">Logout</a>
            </nav>
        </div>
    </div>
    <div id="gc-members-bar">
        <span style="opacity:0.5;flex-shrink:0;">Members:</span>
        ${membersListHTML}
        <div id="add-member-row">
            <button class="button" onclick="openGCAddPicker()" style="width:auto;height:28px;padding:0 12px;font-size:0.8em;padding: 0 !important; height: 44px !important; width: 70px !important; font-size: 0.85em !important; line-height: 1 !important; box-sizing: border-box !important; border: 5px solid white; margin: 0; text-align: center; border-radius: 15px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; transition: 0.2s;">+ Add Friends</button>
            <button class="button gc-action-btn" onclick="leaveGroup()" style="width:auto;height:28px;padding:0 12px;font-size:0.8em;border-color:rgb(255,80,80);color:rgb(255,80,80);" id="leave-gc-btn">Leave</button>
            <span id="add-member-result" style="font-size:0.8em;"></span>
        </div>
    </div>

    <div id="gc-add-picker-modal" role="dialog" aria-modal="true">
        <div id="gc-add-picker-box">
            <div style="font-weight:700;font-size:1.05em;">Add a Friend to Group</div>
            <input id="gc-add-picker-search" type="text" placeholder="Search friends…" oninput="filterGCAddPicker()">
            <div id="gc-add-picker-list"><p style="opacity:0.4;text-align:center;">Loading…</p></div>
            <button class="button" onclick="closeGCAddPicker()" style="padding:6px 16px;width:auto;height:auto;">Close</button>
        </div>
    </div>
    <div id="gc-chat-messages">
        ${msgsHTML || '<p id="gc-empty-placeholder" style="text-align:center;opacity:0.4;">No messages yet. Say hi!</p>'}
    </div>
    <div id="gc-chat-input-bar">
        <div id="gc-reply-indicator">Replying to <span id="gc-reply-to-name"></span> &nbsp;<a href="#" onclick="clearGCReply();return false;" style="color:rgb(0,191,255);">cancel</a></div>
        <form action="/groups/${groupId}/send" method="POST" enctype="multipart/form-data" id="gc-form">
            <input type="hidden" name="reply_to" id="gc-reply-to-input" value="">
            <div id="gc-form-row">
                <textarea class="box" name="content" id="gc-content" placeholder="Message ${escapeHTML(group.name)}…" style="background-color:black;color:white;font-family:inherit;font-size:inherit;padding:8px;" maxlength="4000"></textarea>
                <input type="file" id="gc-attachment" name="attachments" multiple style="display:none;">
                <label for="gc-attachment" class="button" style="cursor:pointer;padding: 0 !important; height: 35px !important; width: 70px !important; font-size: 0.85em !important; line-height: 1 !important;">Browse</label>
                <button class="button" style="padding: 0 !important; height: 44px !important; width: 70px !important; font-size: 0.85em !important; line-height: 1 !important;" type="submit">Send</button>
            </div>
            <div id="gc-file-name">No file chosen</div>
            <div id="gc-char-counter" style="font-size:0.75em;opacity:0.5;text-align:right;margin-top:2px;">0 / 4000</div>
        </form>
    </div>
    <div id="gc-conn-indicator" style="position:fixed;top:54px;left:50%;transform:translateX(-50%);background:rgba(255,170,0,0.9);color:black;padding:4px 14px;border-radius:0 0 8px 8px;font-size:0.78em;font-weight:600;z-index:99;display:none;">Reconnecting…</div>
    <script>
        document.querySelectorAll('[data-ts]').forEach(el => {
            const ts = el.getAttribute('data-ts');
            if (ts) el.textContent = new Date(ts).toLocaleString('en-GB');
        });
        const gcMsgs = document.getElementById('gc-chat-messages');
        gcMsgs.scrollTop = gcMsgs.scrollHeight;
        const seenGCMsgIds = new Set(Array.from(gcMsgs.querySelectorAll('.chat-msg-row[data-id]')).map(el => parseInt(el.getAttribute('data-id'))));

        function appendGCMessage(id, html) {
            if (!html || seenGCMsgIds.has(id)) return;
            seenGCMsgIds.add(id);
            const placeholder = document.getElementById('gc-empty-placeholder');
            if (placeholder) placeholder.remove();
            const wasNearBottom = gcMsgs.scrollHeight - gcMsgs.scrollTop - gcMsgs.clientHeight < 60;
            gcMsgs.insertAdjacentHTML('beforeend', html);
            gcMsgs.querySelectorAll('[data-ts]').forEach(el => {
                const ts = el.getAttribute('data-ts');
                if (ts) el.textContent = new Date(ts).toLocaleString('en-GB');
            });
            if (wasNearBottom) gcMsgs.scrollTop = gcMsgs.scrollHeight;
        }
        function removeGCMessage(id) {
            seenGCMsgIds.delete(id);
            const el = gcMsgs.querySelector('.chat-msg-row[data-id="' + id + '"]');
            if (el) el.remove();
        }

        // --- Live updates over Server-Sent Events (push, not polling) ---
        let gcStream = null;
        let gcReconnectDelay = 1000;
        const gcConnIndicator = document.getElementById('gc-conn-indicator');
        function connectGCStream() {
            gcStream = new EventSource('/groups/${groupId}/stream');
            gcStream.addEventListener('open', () => {
                gcReconnectDelay = 1000;
                gcConnIndicator.style.display = 'none';
            });
            gcStream.addEventListener('message', (e) => {
                try {
                    const data = JSON.parse(e.data);
                    appendGCMessage(data.id, data.html);
                } catch (err) {}
            });
            gcStream.addEventListener('delete', (e) => {
                try {
                    const data = JSON.parse(e.data);
                    removeGCMessage(data.id);
                } catch (err) {}
            });
            gcStream.onerror = () => {
                gcConnIndicator.style.display = 'block';
                gcStream.close();
                setTimeout(connectGCStream, gcReconnectDelay);
                gcReconnectDelay = Math.min(gcReconnectDelay * 1.6, 15000);
            };
        }
        connectGCStream();
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && (!gcStream || gcStream.readyState === 2)) connectGCStream();
        });

        document.getElementById('gc-attachment').addEventListener('change', function () {
            const n = this.files.length;
            document.getElementById('gc-file-name').textContent = n === 0 ? 'No file chosen' : n === 1 ? this.files[0].name : n + ' files selected (max 10)';
        });
        const gcContent = document.getElementById('gc-content');
        const gcCounter = document.getElementById('gc-char-counter');
        gcContent.addEventListener('input', function () {
            const len = this.value.length;
            gcCounter.textContent = len + ' / 4000';
            gcCounter.style.color = len > 3800 ? (len >= 4000 ? 'rgb(255,80,80)' : 'orange') : '';
            gcCounter.style.opacity = len > 3800 ? '1' : '0.5';
        });
        gcContent.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendGCMessage(); }
        });

        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => { btn.classList.add('clicked'); setTimeout(() => btn.classList.remove('clicked'), 150); });
        });

        function setGCReply(id, username) {
            document.getElementById('gc-reply-to-input').value = id;
            document.getElementById('gc-reply-to-name').textContent = username;
            document.getElementById('gc-reply-indicator').style.display = 'block';
            gcContent.focus();
        }
        function clearGCReply() {
            document.getElementById('gc-reply-to-input').value = '';
            document.getElementById('gc-reply-indicator').style.display = 'none';
        }
        function deleteGCMessage(id) {
            fetch('/groups/${groupId}/delete/' + id, { method: 'POST' }).then(r => {
                if (r.ok) removeGCMessage(id);
            });
        }
        function showGCError(message) {
            const t = document.createElement('div');
            t.textContent = message;
            t.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:white;padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 4000);
        }

        const gcForm = document.getElementById('gc-form');
        const gcSendBtn = gcForm.querySelector('button[type="submit"]');
        gcForm.addEventListener('submit', function (e) {
            e.preventDefault();
            sendGCMessage();
        });
        async function sendGCMessage() {
            const fileInput = document.getElementById('gc-attachment');
            if (!gcContent.value.trim() && !fileInput.files.length) return;
            gcSendBtn.disabled = true;
            const fd = new FormData(gcForm);
            try {
                const r = await fetch('/groups/${groupId}/send', { method: 'POST', body: fd });
                const d = await r.json().catch(() => ({}));
                if (!r.ok) {
                    showGCError(d.error || 'Failed to send message.');
                } else {
                    gcContent.value = '';
                    gcCounter.textContent = '0 / 4000';
                    gcCounter.style.opacity = '0.5';
                    gcCounter.style.color = '';
                    fileInput.value = '';
                    document.getElementById('gc-file-name').textContent = 'No file chosen';
                    clearGCReply();
                }
            } catch (err) {
                showGCError('Network error - message not sent.');
            } finally {
                gcSendBtn.disabled = false;
                gcContent.focus();
            }
        }
        async function addMember(username) {
            const result = document.getElementById('add-member-result');
            if (!username) return;
            result.style.color = 'white'; result.textContent = 'Adding...';
            try {
                const r = await fetch('/groups/${groupId}/add-member', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ username }) });
                const d = await r.json();
                if (!r.ok) { result.style.color = 'rgb(255,80,80)'; result.textContent = d.error || 'Error.'; }
                else { result.style.color = 'rgb(0,191,255)'; result.textContent = username + ' added!'; setTimeout(() => { result.textContent = ''; location.reload(); }, 900); }
            } catch(e) { result.style.color = 'rgb(255,80,80)'; result.textContent = 'Network error.'; }
        }

        let gcAddAllFriends = [];
        async function loadGCAddFriends() {
            try {
                const r = await fetch('/api/my-friends');
                const d = await r.json();
                gcAddAllFriends = d.friends || [];
            } catch(e) { gcAddAllFriends = []; }
        }
        loadGCAddFriends();

        function openGCAddPicker() {
            if (!gcAddAllFriends.length) {
                const result = document.getElementById('add-member-result');
                result.style.color = 'rgb(255,80,80)'; result.textContent = 'You have no friends to add.';
                return;
            }
            document.getElementById('gc-add-picker-search').value = '';
            renderGCAddPickerList(gcAddAllFriends);
            document.getElementById('gc-add-picker-modal').classList.add('open');
        }

        function closeGCAddPicker() {
            document.getElementById('gc-add-picker-modal').classList.remove('open');
        }

        function renderGCAddPickerList(list) {
            const container = document.getElementById('gc-add-picker-list');
            if (!list.length) { container.innerHTML = '<p style="opacity:0.4;text-align:center;">No friends found.</p>'; return; }
            container.innerHTML = list.map(u => \`
                <div class="gc-add-friend-row">
                    <span>@\${u}</span>
                    <button class="button" onclick="addMember('\${u}');closeGCAddPicker();" style="padding:4px 12px;width:auto;height:auto;font-size:0.8em;">Add</button>
                </div>\`).join('');
            container.querySelectorAll('.button').forEach(btn => {
                btn.addEventListener('mousedown', () => { btn.classList.add('clicked'); setTimeout(() => btn.classList.remove('clicked'), 150); });
            });
        }

        function filterGCAddPicker() {
            const q = document.getElementById('gc-add-picker-search').value.toLowerCase();
            renderGCAddPickerList(gcAddAllFriends.filter(u => u.toLowerCase().includes(q)));
        }

        async function leaveGroup() {
            if (!confirm('Are you sure you want to leave this group?')) return;
            const result = document.getElementById('add-member-result');
            result.style.color = 'white'; result.textContent = 'Leaving...';
            try {
                const r = await fetch('/groups/${groupId}/leave', { method: 'POST' });
                const d = await r.json();
                if (!r.ok) { result.style.color = 'rgb(255,80,80)'; result.textContent = d.error || 'Error leaving group.'; }
                else { window.location.href = '/groups'; }
            } catch(e) { result.style.color = 'rgb(255,80,80)'; result.textContent = 'Network error.'; }
        }

        async function kickMember(username) {
            if (!confirm('Kick ' + username + ' from this group?')) return;
            const result = document.getElementById('add-member-result');
            result.style.color = 'white'; result.textContent = 'Kicking ' + username + '...';
            try {
                const r = await fetch('/groups/${groupId}/kick/' + encodeURIComponent(username), { method: 'POST' });
                const d = await r.json();
                if (!r.ok) { result.style.color = 'rgb(255,80,80)'; result.textContent = d.error || 'Error.'; }
                else { result.style.color = 'rgb(0,191,255)'; result.textContent = username + ' kicked!'; setTimeout(() => { result.textContent = ''; location.reload(); }, 900); }
            } catch(e) { result.style.color = 'rgb(255,80,80)'; result.textContent = 'Network error.'; }
        }

        document.getElementById('gc-add-picker-modal').addEventListener('click', function(e) {
            if (e.target === this) closeGCAddPicker();
        });
        function toggleNav() {
            const dropdown = document.getElementById('nav-dropdown');
            const btn = document.getElementById('nav-hamburger');
            dropdown.classList.toggle('open');
            btn.textContent = dropdown.classList.contains('open') ? '✕' : '☰';
        }
        document.addEventListener('click', function(e) {
            const dropdown = document.getElementById('nav-dropdown');
            const btn = document.getElementById('nav-hamburger');
            if (dropdown && btn && !dropdown.contains(e.target) && e.target !== btn) {
                dropdown.classList.remove('open');
                btn.textContent = '☰';
            }
        });
    </script>
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}

</body>
</html>`);
                });
            });
        });
    });
});

app.get('/groups/:id/stream', (req, res) => {
    if (!req.session.userId) return res.status(401).end();
    const me = req.session.userUsername;
    const groupId = parseInt(req.params.id);
    db.get(`SELECT id FROM Group_Chat_Members WHERE group_id = ? AND username = ?`, [groupId, me], (err, memberRow) => {
        if (!memberRow) return res.status(403).end();

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.write('retry: 2000\n\n');

        const channel = `${groupId}::${me}`;
        const onEvent = (payload) => sseSend(res, payload.event, payload);
        gcBus.on(channel, onEvent);

        const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);

        req.on('close', () => {
            clearInterval(keepAlive);
            gcBus.removeListener(channel, onEvent);
        });
    });
});

app.post('/groups/:id/send', (req, res, next) => {
    uploadGC.array('attachments', MAX_FILES_GC)(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: `Too many files - max ${MAX_FILES_GC} per message.` });
            return res.status(400).json({ error: 'Upload failed.' });
        }
        next();
    });
}, (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const me = req.session.userUsername;
    const groupId = parseInt(req.params.id);
    db.get(`SELECT id FROM Group_Chat_Members WHERE group_id = ? AND username = ?`, [groupId, me], (err, memberRow) => {
        if (!memberRow) return res.status(403).json({ error: 'Not a member of this group.' });
        const { content, reply_to } = req.body;
        const files = req.files || [];
        const filesMeta = files.map(f => ({ path: f.path, name: f.originalname }));
        const filesJSON = filesMeta.length ? JSON.stringify(filesMeta) : null;
        const filePath = files[0] ? files[0].path : null;
        const fileName = files[0] ? files[0].originalname : null;
        const replyTo = reply_to ? parseInt(reply_to) : null;
        if ((!content || !content.trim()) && !files.length) return res.status(400).json({ error: 'Message is empty.' });
        if (content && content.length > MAX_MSG_LENGTH) return res.status(400).json({ error: 'Message too long or too many files selected - 4,000 character limit, max 10 files.' });

        db.run(`INSERT INTO Group_Chat_Messages (group_id, from_user, content, file_path, file_name, files_json, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [groupId, me, (content || '').trim(), filePath, fileName, filesJSON, replyTo], function (err2) {
                if (err2) return res.status(500).json({ error: 'Failed to send message.' });
                const newId = this.lastID;

                db.get(`SELECT Group_Chat_Messages.*, User_Data.avatar_path, User_Data.Nickname FROM Group_Chat_Messages LEFT JOIN User_Data ON Group_Chat_Messages.from_user = User_Data.username WHERE Group_Chat_Messages.id = ?`, [newId], (err3, row) => {
                    if (err3 || !row) return res.json({ ok: true, id: newId });
                    db.all(`SELECT username FROM Group_Chat_Members WHERE group_id = ?`, [groupId], (err4, memberRows) => {
                        const members = (memberRows || []).map(r => r.username);
                        // Only ping users who are actually in this group chat.
                        const nonMembers = (content || '').match(MENTION_REGEX) || [];
                        const memberSet = new Set(members.map(u => u.toLowerCase()));
                        const skipUsernames = nonMembers
                            .map(t => t.slice(1))
                            .filter(u => !memberSet.has(u.toLowerCase()));
                        processMentions(content, me, { type: 'mention_gc', post_id: groupId, message_id: newId, skipUsernames });
                        const finish = (replyMsg) => {
                            broadcastGCMessage(groupId, me, row, replyMsg, members);
                            res.json({ ok: true, id: newId });
                        };
                        if (replyTo) {
                            db.get(`SELECT * FROM Group_Chat_Messages WHERE id = ?`, [replyTo], (err5, replyRow) => finish(replyRow || null));
                        } else {
                            finish(null);
                        }
                    });
                });
            });
    });
});

app.post('/groups/:id/delete/:msgId', (req, res) => {
    if (!req.session.userId) return res.status(401).end();
    const me = req.session.userUsername;
    const groupId = parseInt(req.params.id);
    const msgId = parseInt(req.params.msgId);
    db.get(`SELECT from_user FROM Group_Chat_Messages WHERE id = ? AND group_id = ?`, [msgId, groupId], (err, msg) => {
        if (err || !msg) return res.status(404).end();
        if (msg.from_user !== me) return res.status(403).end();
        db.run(`DELETE FROM Group_Chat_Messages WHERE id = ?`, [msgId], (err2) => {
            if (err2) return res.status(500).end();
            db.all(`SELECT username FROM Group_Chat_Members WHERE group_id = ?`, [groupId], (err3, memberRows) => {
                broadcastGCDelete(groupId, msgId, (memberRows || []).map(r => r.username));
                res.status(200).end();
            });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Biodeck running on port ${PORT}`);
});

app.get('/editor', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'editor.html'));
});

app.get('/v86', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});