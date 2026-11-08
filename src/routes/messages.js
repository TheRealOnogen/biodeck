// Direct messages.
const { app } = require('../app');
const {
    ATTACH_JS_BLOCK,
    ATTACH_STYLE_BLOCK,
    EMOJI_SCRIPT,
    MSG_REACTION_SCRIPT,
    NOTIF_BADGE_SCRIPT,
    REACTION_SCRIPT,
    REPORT_SCRIPT,
    SOUND_SCRIPT,
    USER_EVENTS_SCRIPT,
} = require('../client-scripts');
const {
    MAX_ATTACHMENT_MB,
    MAX_DISTINCT_REACTIONS_PER_MESSAGE,
    MAX_MSG_LENGTH,
    MAX_REACTION_EMOJI_LENGTH,
} = require('../config');
const { db } = require('../db/connection');
const {
    broadcastDMDelete,
    broadcastDMEdit,
    broadcastDMMessage,
    broadcastDMReaction,
    dmBus,
    isViewingDMChat,
    registerDMViewer,
    setDMViewerVisible,
    sseSend,
} = require('../live/events');
const { requireVerifiedForUpload } = require('../middleware/email-verified');
const { isUserMuted } = require('../moderation');
const { renderMessageBubble } = require('../render/messages');
const { getMessageReactions, renderMsgReactionsHTML } = require('../render/posts');
const { chatSendGuard } = require('../security/chat-limits');
const { createNotification, eitherBlocked, processMentions } = require('../social');
const { recordPrivateUploads } = require('../uploads/access');
const { processAttachments } = require('../uploads/convert');
const { cleanupAttachmentFiles, getAttachments } = require('../uploads/files');
const { MAX_FILES_DM, uploadDM } = require('../uploads/multer');
const { attachmentGate } = require('../uploads/quota');

app.get('/messages', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const me = req.session.userUsername;
    db.all(`SELECT DISTINCT CASE WHEN from_user = ? THEN to_user ELSE from_user END as other_user,
            MAX(created_at) as last_at
            FROM Messages WHERE from_user = ? OR to_user = ?
            GROUP BY other_user ORDER BY last_at DESC`,
        [me, me, me], (err, convos) => {
        const convosHTML = (convos || []).map(c => `
            <a href="/messages/${c.other_user}" class="msg-sender-name msg-convo-link">
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
<link rel="stylesheet" href="/theme.css">
</head>
<body class="page-messages">
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
        <h2>Inbox <a href="/groups" style="font-size:0.6em;color:var(--accent-color);text-decoration:none;margin-left:12px;font-weight:400;">+ Group Chats</a></h2>
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
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${SOUND_SCRIPT}${EMOJI_SCRIPT}${REPORT_SCRIPT}${REACTION_SCRIPT}

</body>
</html>`);
    });
});

app.get('/messages/:username', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const me = req.session.userUsername;
    const other = req.params.username;
    db.run(`UPDATE Messages SET read = 1 WHERE to_user = ? AND from_user = ?`, [me, other]);
    db.all(`SELECT Messages.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified FROM Messages LEFT JOIN User_Data ON Messages.from_user = User_Data.username WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY created_at ASC`,
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
<link rel="stylesheet" href="/theme.css">
${ATTACH_STYLE_BLOCK}
<script>${ATTACH_JS_BLOCK}</script>
</head>
<body class="page-chat">
    <div id="dnd-overlay"><div>Drop files to attach</div></div>
    <div id="chat-topbar">
        <div id="chat-topbar-left">Chat with <strong><a href="/user/${other}" class="msg-sender-name" style="text-decoration:none;">@${other}</a></strong></div>
        <div id="chat-topbar-right" style="position:relative;display:flex;align-items:center;">
            <a href="/messages">Inbox</a>
            <a href="/feed">Feed</a>
            <a href="/notifications" class="notif-nav-link">Notifications</a>
            <a href="#" onclick="reportChat('dm', '${other}', this); return false;">Report chat</a>
            <a href="/logout">Logout</a>
            <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
            <nav id="nav-dropdown">
                <a href="/messages">Inbox</a>
                <a href="/feed">Feed</a>
                <a href="/notifications" class="notif-nav-link">Notifications</a>
                <a href="#" onclick="reportChat('dm', '${other}', this); return false;">Report chat</a>
            <a href="/logout">Logout</a>
            </nav>
        </div>
    </div>
    <div id="chat-messages">
        ${msgsHTML || '<p id="chat-empty-placeholder" style="text-align:center;opacity:0.4;">No messages yet. Say hi!</p>'}
    </div>
    <div id="chat-input-bar">
        <div id="chat-reply-indicator">Replying to <span id="chat-reply-to-name"></span> &nbsp;<a href="#" onclick="clearReply();return false;" style="color:var(--accent-color);">cancel</a></div>
        <form action="/messages/${other}/send" method="POST" enctype="multipart/form-data" id="chat-form">
            <input type="hidden" name="reply_to" id="chat-reply-to-input" value="">
            <div id="chat-attach-preview" class="attach-preview"></div>
            <div id="chat-form-row">
                <textarea class="box" name="content" id="chat-content" placeholder="Message @${other}..." style="font-family:inherit;font-size:inherit;padding:8px;" maxlength="4000"></textarea>
                <input type="file" id="chat-attachment" name="attachments" multiple style="display:none;">
                <label for="chat-attachment" class="button chat-action-btn" style="display:inline-flex;align-items:center;justify-content:center;cursor:pointer;">Browse</label>
                <button class="button chat-action-btn" type="submit">Send</button>
            </div>
            <div id="chat-char-counter" style="font-size:0.75em;opacity:0.5;text-align:right;margin-top:2px;">0 / 4000</div>
        </form>
    </div>
    <div id="chat-conn-indicator" style="position:fixed;top:54px;left:50%;transform:translateX(-50%);background:rgba(255,170,0,0.9);color:var(--on-warning-color);padding:4px 14px;border-radius:0 0 8px 8px;font-size:0.78em;font-weight:600;z-index:99;display:none;">Reconnecting…</div>
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
        function replaceMessage(id, html) {
            if (!html) return;
            const el = document.querySelector('.chat-msg-row[data-id="' + id + '"]');
            if (!el) { appendNewMessage(id, html); return; }
            el.outerHTML = html;
            const newEl = document.querySelector('.chat-msg-row[data-id="' + id + '"]');
            if (newEl) newEl.querySelectorAll('[data-ts]').forEach(e => {
                const ts = e.getAttribute('data-ts');
                if (ts) e.textContent = new Date(ts).toLocaleString('en-GB');
            });
        }

        // --- Live updates over Server-Sent Events (push, not polling) ---
        let chatStream = null;
        let chatReconnectDelay = 1000;
        // Presence: tells the server this chat is open and whether the tab is visible,
        // so it doesn't raise a "sent you a message" notification while you're reading.
        const chatCid = Math.random().toString(36).slice(2) + Date.now().toString(36);
        function chatVisibleFlag() { return document.hidden ? '0' : '1'; }
        function reportChatPresence() {
            fetch('/messages/${other}/presence?cid=' + chatCid + '&v=' + chatVisibleFlag(), { method: 'POST', keepalive: true }).catch(() => {});
        }
        document.addEventListener('visibilitychange', reportChatPresence);
        const connIndicator = document.getElementById('chat-conn-indicator');
        function connectChatStream() {
            chatStream = new EventSource('/messages/${other}/stream?cid=' + chatCid + '&v=' + chatVisibleFlag());
            chatStream.addEventListener('open', () => {
                chatReconnectDelay = 1000;
                connIndicator.style.display = 'none';
            });
            chatStream.addEventListener('message', (e) => {
                try {
                    const data = JSON.parse(e.data);
                    const isNewMsg = !seenMsgIds.has(data.id);
                    appendNewMessage(data.id, data.html);
                    // Sound only for messages from the other person, never for your own sends.
                    if (isNewMsg && data.from && data.from !== ${JSON.stringify(me).replace(/</g, '\\u003c')} && window.biodeckPlaySound) window.biodeckPlaySound('message');
                    if (!document.hidden) fetch('/messages/${other}/mark-read', { method: 'POST' }).catch(() => {});
                } catch (err) {}
            });
            chatStream.addEventListener('delete', (e) => {
                try {
                    const data = JSON.parse(e.data);
                    removeMessage(data.id);
                } catch (err) {}
            });
            chatStream.addEventListener('edit', (e) => {
                try {
                    const data = JSON.parse(e.data);
                    replaceMessage(data.id, data.html);
                } catch (err) {}
            });
            chatStream.addEventListener('reaction', (e) => {
                try {
                    const data = JSON.parse(e.data);
                    const container = document.getElementById('msg-reactions-' + data.id);
                    if (container && data.html) container.outerHTML = data.html;
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

        const chatAttachMgr = biodeckAttachManager('chat-attachment', 'chat-attach-preview', 10);
        biodeckWireDrop('chat-input-bar', chatAttachMgr);

        const chatContent = document.getElementById('chat-content');
        const chatCounter = document.getElementById('chat-char-counter');
        chatContent.addEventListener('input', function () {
            const len = this.value.length;
            chatCounter.textContent = len + ' / 4000';
            chatCounter.style.color = len > 3800 ? (len >= 4000 ? 'var(--danger-color)' : 'var(--warning-color)') : '';
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
        const msgEditOriginal = {};
        function editMessage(id) {
            const el = document.getElementById('msg-content-' + id);
            if (!el || el.dataset.editing) return;
            msgEditOriginal[id] = el.innerHTML;
            el.dataset.editing = '1';
            const raw = el.getAttribute('data-raw') || '';
            el.innerHTML = '';
            const ta = document.createElement('textarea');
            ta.className = 'box';
            ta.maxLength = 4000;
            ta.style.cssText = 'width:100%;box-sizing:border-box;font-family:inherit;font-size:inherit;padding:6px;resize:vertical;';
            ta.value = raw;
            el.appendChild(ta);
            const actions = document.createElement('div');
            actions.style.cssText = 'margin-top:4px;display:flex;gap:10px;font-size:0.85em;';
            const saveLink = document.createElement('a');
            saveLink.href = '#'; saveLink.className = 'button'; saveLink.textContent = 'Save'; saveLink.style.cssText = 'width:auto;height:auto;padding:4px 14px;font-size:0.85em;text-decoration:none;';
            saveLink.onclick = (e) => { e.preventDefault(); saveEditMessage(id, ta.value); };
            const cancelLink = document.createElement('a');
            cancelLink.href = '#'; cancelLink.className = 'button'; cancelLink.textContent = 'Cancel'; cancelLink.style.cssText = 'width:auto;height:auto;padding:4px 14px;font-size:0.85em;text-decoration:none;';
            cancelLink.onclick = (e) => { e.preventDefault(); cancelEditMessage(id); };
            actions.appendChild(saveLink);
            actions.appendChild(cancelLink);
            el.appendChild(actions);
            ta.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEditMessage(id, ta.value); }
                else if (e.key === 'Escape') cancelEditMessage(id);
            });
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
        }
        function cancelEditMessage(id) {
            const el = document.getElementById('msg-content-' + id);
            if (el && msgEditOriginal[id] !== undefined) {
                el.innerHTML = msgEditOriginal[id];
                delete el.dataset.editing;
                delete msgEditOriginal[id];
            }
        }
        function saveEditMessage(id, content) {
            if (!content || !content.trim()) return;
            fetch('/messages/${other}/edit/' + id, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content })
            }).then(r => r.json().then(d => ({ ok: r.ok, d }))).then(({ ok, d }) => {
                if (!ok) { showChatError((d && d.error) || 'Failed to edit message.'); return; }
                delete msgEditOriginal[id];
                // The bubble itself is refreshed via the 'edit' SSE event.
            }).catch(() => showChatError('Network error - edit not saved.'));
        }
        function showChatError(message) {
            const t = document.createElement('div');
            t.textContent = message;
            t.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:var(--text-color);padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
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
                    chatAttachMgr.clear();
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
${SOUND_SCRIPT}${EMOJI_SCRIPT}${REPORT_SCRIPT}${REACTION_SCRIPT}<script>window.MSG_REACT_BASE = '/messages/${other}/react/';</script>${MSG_REACTION_SCRIPT}
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

    // Presence: lets the send route know this chat is open (and visible) so it can skip the "sent
    // you a message" notification.
    const cid = String(req.query.cid || '').slice(0, 64);
    const unregisterViewer = cid ? registerDMViewer(me, other, cid, req.query.v === '1') : null;

    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);

    req.on('close', () => {
        clearInterval(keepAlive);
        dmBus.removeListener(channel, onEvent);
        if (unregisterViewer) unregisterViewer();
    });
});

// The chat page calls this whenever its tab is shown/hidden so presence stays accurate.
app.post('/messages/:username/presence', (req, res) => {
    if (!req.session.userId) return res.status(401).end();
    const cid = String(req.query.cid || '').slice(0, 64);
    if (cid) setDMViewerVisible(req.session.userUsername, req.params.username, cid, req.query.v === '1');
    res.status(204).end();
});

app.post('/messages/:username/send', requireVerifiedForUpload, chatSendGuard('pre'), attachmentGate('json'), (req, res, next) => {
    uploadDM.array('attachments', MAX_FILES_DM)(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `A file is too large - the limit is ${MAX_ATTACHMENT_MB} MB per file.`, code: 'upload_limit' });
            if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: `Too many files - max ${MAX_FILES_DM} per message.` });
            if (err.code === 'FILE_TYPE_BLOCKED') return res.status(400).json({ error: err.message });
            return res.status(400).json({ error: 'Upload failed.' });
        }
        next();
    });
}, processAttachments('json'), chatSendGuard('post'), (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const me = req.session.userUsername;
    const other = req.params.username;
    isUserMuted(me, (errMute, mute) => {
        if (!errMute && mute) {
            return res.status(403).json({ error: `You're not able to chat until this warning expires${mute.expiresAt ? ' (' + new Date(mute.expiresAt).toLocaleString() + ')' : ''}.`, muted: true, expiresAt: mute.expiresAt });
        }
    const { content, reply_to } = req.body;
    const files = req.files || [];
    const filesMeta = files.map(f => ({ path: f.path, name: f.originalname, size: f.size }));
    const filesJSON = filesMeta.length ? JSON.stringify(filesMeta) : null;
    const filePath = files[0] ? files[0].path : null;
    const fileName = files[0] ? files[0].originalname : null;
    const replyTo = reply_to ? parseInt(reply_to) : null;
    if ((!content || !content.trim()) && !files.length) return res.status(400).json({ error: 'Message is empty.' });
    if (content && content.length > MAX_MSG_LENGTH) return res.status(400).json({ error: 'Message too long or too many files selected - 4,000 character limit, max 10 files.' });

    if (eitherBlocked(me, other)) {
        cleanupAttachmentFiles(filesMeta);
        return res.status(403).json({ error: "You can't message this user.", blocked: true });
    }
    recordPrivateUploads(files, { scope: 'dm', userA: me, userB: other });
    db.run(`INSERT INTO Messages (from_user, to_user, content, file_path, file_name, files_json, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [me, other, (content || '').trim(), filePath, fileName, filesJSON, replyTo], function (err) {
            if (err) return res.status(500).json({ error: 'Failed to send message.' });
            const newId = this.lastID;
            const preview = (content || '').trim().slice(0, 140) || (filesMeta.length ? `Sent ${filesMeta.length > 1 ? filesMeta.length + ' files' : 'a file: ' + filesMeta[0].name}` : '');
            // No "sent you a message" notification if they're looking at this chat right now.
            if (!isViewingDMChat(other, me)) {
                createNotification({ username: other, type: 'dm', actor_username: me, message_id: newId, content_preview: preview });
            }
            processMentions(content, me, { type: 'mention_dm', message_id: newId, skipUsernames: [other] });

            db.get(`SELECT Messages.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified FROM Messages LEFT JOIN User_Data ON Messages.from_user = User_Data.username WHERE Messages.id = ?`, [newId], (err2, row) => {
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
    db.get(`SELECT from_user, to_user, file_path, file_name, files_json FROM Messages WHERE id = ?`, [msgId], (err, msg) => {
        if (err || !msg) return res.status(404).end();
        if (msg.from_user !== me) return res.status(403).end();
        const attachments = getAttachments(msg);
        db.run(`DELETE FROM Message_Reactions WHERE message_id = ?`, [msgId]);
        db.run(`DELETE FROM Messages WHERE id = ?`, [msgId], (err2) => {
            if (err2) { console.error('Message delete error:', err2.message); return res.status(500).end(); }
            cleanupAttachmentFiles(attachments);
            broadcastDMDelete(msg.from_user, msg.to_user, msgId);
            res.status(200).end();
        });
    });
});

app.post('/messages/:username/edit/:id', chatSendGuard('post', { dedupe: false }), (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const me = req.session.userUsername;
    const msgId = parseInt(req.params.id);
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
    if (content.length > MAX_MSG_LENGTH) return res.status(400).json({ error: `Message too long - ${MAX_MSG_LENGTH} character limit.` });
    db.get(`SELECT from_user, to_user, reply_to FROM Messages WHERE id = ?`, [msgId], (err, msg) => {
        if (err || !msg) return res.status(404).json({ error: 'Message not found.' });
        if (msg.from_user !== me) return res.status(403).json({ error: 'You can only edit your own messages.' });
        db.run(`UPDATE Messages SET content = ?, edited = 1 WHERE id = ?`, [content.trim(), msgId], (err2) => {
            if (err2) { console.error('Message edit error:', err2.message); return res.status(500).json({ error: 'Failed to edit message.' }); }
            db.get(`SELECT Messages.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified FROM Messages LEFT JOIN User_Data ON Messages.from_user = User_Data.username WHERE Messages.id = ?`, [msgId], (err3, row) => {
                if (err3 || !row) return res.json({ ok: true });
                const finish = (replyMsg) => {
                    broadcastDMEdit(msg.from_user, msg.to_user, row, replyMsg);
                    res.json({ ok: true });
                };
                if (row.reply_to) {
                    db.get(`SELECT * FROM Messages WHERE id = ?`, [row.reply_to], (err4, replyRow) => finish(replyRow || null));
                } else {
                    finish(null);
                }
            });
        });
    });
});

// Toggles the session user's reaction with a given emoji on a DM message.
app.post('/messages/:username/react/:id', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const me = req.session.userUsername;
    const other = req.params.username;
    const msgId = parseInt(req.params.id, 10);
    if (!Number.isInteger(msgId)) return res.status(404).json({ error: 'Message not found.' });
    const emoji = ((req.body && req.body.emoji) || '').trim();
    if (!emoji) return res.status(400).json({ error: 'Pick an emoji first.' });
    if (/[\r\n\t]/.test(emoji)) return res.status(400).json({ error: 'Reactions must be a single emoji, not text.' });
    if (emoji.length > MAX_REACTION_EMOJI_LENGTH) return res.status(400).json({ error: `Reaction too long - ${MAX_REACTION_EMOJI_LENGTH} character limit.` });

    db.get(`SELECT id, from_user, to_user FROM Messages WHERE id = ?`, [msgId], (err, msg) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!msg) return res.status(404).json({ error: 'Message not found.' });
        const participants = [msg.from_user, msg.to_user];
        if (me === other || !participants.includes(me) || !participants.includes(other)) {
            return res.status(403).json({ error: 'Not part of this conversation.' });
        }

        db.get(`SELECT id FROM Message_Reactions WHERE message_id = ? AND username = ? AND emoji = ?`, [msgId, me, emoji], (err2, existing) => {
            if (err2) return res.status(500).json({ error: 'db error' });

            const respond = () => {
                broadcastDMReaction(msg.from_user, msg.to_user, msgId);
                res.json({ ok: true, html: renderMsgReactionsHTML(msgId, getMessageReactions(msgId, me), me) });
            };

            if (existing) {
                db.run(`DELETE FROM Message_Reactions WHERE id = ?`, [existing.id], (err3) => {
                    if (err3) return res.status(500).json({ error: 'db error' });
                    respond();
                });
            } else {
                db.get(`SELECT COUNT(DISTINCT emoji) AS n FROM Message_Reactions WHERE message_id = ?`, [msgId], (err3, cntRow) => {
                    if (err3) return res.status(500).json({ error: 'db error' });
                    if (cntRow && cntRow.n >= MAX_DISTINCT_REACTIONS_PER_MESSAGE) {
                        return res.status(400).json({ error: 'This message already has the maximum number of different reactions.' });
                    }
                    db.run(`INSERT INTO Message_Reactions (message_id, username, emoji) VALUES (?, ?, ?)`, [msgId, me, emoji], (err4) => {
                        if (err4) return res.status(500).json({ error: 'db error' });
                        respond();
                    });
                });
            }
        });
    });
});
