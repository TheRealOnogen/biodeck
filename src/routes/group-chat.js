// Group chat pages and messages.
const path = require('path');
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
    broadcastGCDelete,
    broadcastGCEdit,
    broadcastGCMessage,
    broadcastGCReaction,
    gcBus,
    sseSend,
} = require('../live/events');
const { requireVerifiedForUpload } = require('../middleware/email-verified');
const { isUserMuted } = require('../moderation');
const { ROOT_DIR } = require('../paths');
const { escapeHTML } = require('../render/html');
const { MENTION_REGEX } = require('../render/markdown');
const { renderGCMessageBubble } = require('../render/messages');
const { getGCMessageReactions, renderGCMsgReactionsHTML } = require('../render/posts');
const { chatSendGuard } = require('../security/chat-limits');
const { processMentions } = require('../social');
const { recordPrivateUploads } = require('../uploads/access');
const { processAttachments } = require('../uploads/convert');
const { cleanupAttachmentFiles, getAttachments } = require('../uploads/files');
const { MAX_FILES_GC, uploadGC } = require('../uploads/multer');
const { attachmentGate } = require('../uploads/quota');

app.get('/groups/:id', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const me = req.session.userUsername;
    const groupId = parseInt(req.params.id);

    db.get(`SELECT * FROM Group_Chats WHERE id = ?`, [groupId], (err, group) => {
        if (err || !group) return res.status(404).send('Group not found');
        db.get(`SELECT id FROM Group_Chat_Members WHERE group_id = ? AND username = ?`, [groupId, me], (err2, memberRow) => {
            if (!memberRow) return res.status(403).sendFile(path.join(ROOT_DIR, 'group_access_denied.html'));
            db.all(`SELECT username FROM Group_Chat_Members WHERE group_id = ? ORDER BY joined_at ASC`, [groupId], (err3, members) => {
                db.all(`SELECT Group_Chat_Messages.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified FROM Group_Chat_Messages LEFT JOIN User_Data ON Group_Chat_Messages.from_user = User_Data.username WHERE group_id = ? ORDER BY created_at ASC`, [groupId], (err4, msgs) => {
                    const msgMap = {};
                    (msgs || []).forEach(m => msgMap[m.id] = m);
                    const msgsHTML = (msgs || []).map(m => renderGCMessageBubble(m, me, m.reply_to ? msgMap[m.reply_to] : null)).join('');
                    const isCreator = group.created_by === me;
                    const membersListHTML = (members || []).map(mbr =>
                        `<span data-username="${escapeHTML(mbr.username)}" style="display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,0.08);border-radius:20px;padding:3px 10px;font-size:0.82em;">
                            <a href="/user/${escapeHTML(mbr.username)}" style="color:var(--text-color);text-decoration:none;">${escapeHTML(mbr.username)}</a>
                            ${isCreator && mbr.username !== me ? `<button onclick="kickMember('${escapeHTML(mbr.username)}')" title="Kick ${escapeHTML(mbr.username)}" style="background:none;border:none;color:var(--danger-color);cursor:pointer;font-size:0.9em;padding:0 2px;line-height:1;" aria-label="Kick ${escapeHTML(mbr.username)}">✕</button>` : ''}
                        </span>`).join('');

                    res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHTML(group.name)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
${ATTACH_STYLE_BLOCK}
<script>${ATTACH_JS_BLOCK}</script>
</head>
<body class="page-group-chat">
    <div id="dnd-overlay"><div>Drop files to attach</div></div>
    <div id="gc-chat-topbar">
        <div style="font-weight:bold;">${escapeHTML(group.name)} ${group.is_public ? '<span id="gc-public-badge" style="font-size:0.65em;font-weight:400;opacity:0.6;border:1px solid rgba(255,255,255,0.3);border-radius:10px;padding:1px 7px;vertical-align:middle;">Public</span>' : '<span id="gc-public-badge" style="display:none;font-size:0.65em;font-weight:400;opacity:0.6;border:1px solid rgba(255,255,255,0.3);border-radius:10px;padding:1px 7px;vertical-align:middle;">Public</span>'}</div>
        <div id="gc-chat-topbar-right">
            <a href="/discover">Discover</a>
            <a href="/groups">Groups</a>
            <a href="/messages">DMs</a>
            <a href="/feed">Feed</a>
            <a href="/notifications" class="notif-nav-link">Notifications</a>
            <a href="#" onclick="reportChat('gc', ${group.id}, this); return false;">Report chat</a>
            <a href="/logout">Logout</a>
            <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
            <nav id="nav-dropdown">
                <a href="/discover">Discover</a>
                <a href="/groups">Groups</a>
                <a href="/messages">DMs</a>
                <a href="/feed">Feed</a>
                <a href="/notifications" class="notif-nav-link">Notifications</a>
                <a href="#" onclick="reportChat('gc', ${group.id}, this); return false;">Report chat</a>
            <a href="/logout">Logout</a>
            </nav>
        </div>
    </div>
    <div id="gc-members-bar">
        <span style="opacity:0.5;flex-shrink:0;">Members:</span>
        <span id="gc-members-list" style="display:contents;">${membersListHTML}</span>
        <div id="add-member-row">
            <button class="button" onclick="openGCAddPicker()" style="width:auto;height:28px;padding:0 12px;font-size:0.8em;padding: 0 !important;height: 44px !important;width: 70px !important;font-size: 0.85em !important;line-height: 1 !important;box-sizing: border-box !important;">+ Add Friends</button>
            ${isCreator ? `<button class="button" onclick="togglePublic()" style="width:auto;height:28px;padding:0 12px;font-size:0.8em;padding: 0 !important;height: 44px !important;width: 70px !important;font-size: 0.85em !important;line-height: 1 !important;box-sizing: border-box !important;" id="toggle-public-btn">${group.is_public ? 'Make Private' : 'Make Public'}</button>` : ''}
            <button class="button gc-action-btn" onclick="leaveGroup()" style="width:auto;height:28px;padding:0 12px;font-size:0.8em;border-color:rgb(255,80,80);color:var(--danger-color);" id="leave-gc-btn">Leave</button>
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
        <div id="gc-reply-indicator">Replying to <span id="gc-reply-to-name"></span> &nbsp;<a href="#" onclick="clearGCReply();return false;" style="color:var(--accent-color);">cancel</a></div>
        <form action="/groups/${groupId}/send" method="POST" enctype="multipart/form-data" id="gc-form">
            <input type="hidden" name="reply_to" id="gc-reply-to-input" value="">
            <div id="gc-attach-preview" class="attach-preview"></div>
            <div id="gc-form-row">
                <textarea class="box" name="content" id="gc-content" placeholder="Message ${escapeHTML(group.name)}…" style="font-family:inherit;font-size:inherit;padding:8px;" maxlength="4000"></textarea>
                <input type="file" id="gc-attachment" name="attachments" multiple style="display:none;">
                <label for="gc-attachment" class="button" style="padding: 0 !important;height: 35px !important;width: 70px !important;font-size: 0.85em !important;line-height: 1 !important;">Browse</label>
                <button class="button" style="padding: 0 !important;height: 44px !important;width: 70px !important;font-size: 0.85em !important;line-height: 1 !important;" type="submit">Send</button>
            </div>
            <div id="gc-char-counter" style="font-size:0.75em;opacity:0.5;text-align:right;margin-top:2px;">0 / 4000</div>
        </form>
    </div>
    <div id="gc-conn-indicator" style="position:fixed;top:54px;left:50%;transform:translateX(-50%);background:rgba(255,170,0,0.9);color:var(--on-warning-color);padding:4px 14px;border-radius:0 0 8px 8px;font-size:0.78em;font-weight:600;z-index:99;display:none;">Reconnecting…</div>
    <script>
        const isCreator = ${isCreator};
        const gcMembersList = document.getElementById('gc-members-list');
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
        function replaceGCMessage(id, html) {
            const el = gcMsgs.querySelector('.chat-msg-row[data-id="' + id + '"]');
            if (!el) { appendGCMessage(id, html); return; }
            el.outerHTML = html;
            const newEl = gcMsgs.querySelector('.chat-msg-row[data-id="' + id + '"]');
            if (newEl) newEl.querySelectorAll('[data-ts]').forEach(e => {
                const ts = e.getAttribute('data-ts');
                if (ts) e.textContent = new Date(ts).toLocaleString('en-GB');
            });
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
                    const isNewGCMsg = !seenGCMsgIds.has(data.id);
                    appendGCMessage(data.id, data.html);
                    // Sound for messages from other members (not your own sends).
                    if (isNewGCMsg && data.from && data.from !== ${JSON.stringify(me).replace(/</g, '\\u003c')} && window.biodeckPlaySound) window.biodeckPlaySound('message');
                } catch (err) {}
            });
            gcStream.addEventListener('delete', (e) => {
                try {
                    const data = JSON.parse(e.data);
                    removeGCMessage(data.id);
                } catch (err) {}
            });
            gcStream.addEventListener('edit', (e) => {
                try {
                    const data = JSON.parse(e.data);
                    replaceGCMessage(data.id, data.html);
                } catch (err) {}
            });
            gcStream.addEventListener('reaction', (e) => {
                try {
                    const data = JSON.parse(e.data);
                    const container = document.getElementById('msg-reactions-' + data.id);
                    if (container && data.html) container.outerHTML = data.html;
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

        const gcAttachMgr = biodeckAttachManager('gc-attachment', 'gc-attach-preview', 10);
        biodeckWireDrop('gc-chat-input-bar', gcAttachMgr);
        const gcContent = document.getElementById('gc-content');
        const gcCounter = document.getElementById('gc-char-counter');
        gcContent.addEventListener('input', function () {
            const len = this.value.length;
            gcCounter.textContent = len + ' / 4000';
            gcCounter.style.color = len > 3800 ? (len >= 4000 ? 'var(--danger-color)' : 'var(--warning-color)') : '';
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
        const msgGCEditOriginal = {};
        function editGCMessage(id) {
            const el = document.getElementById('gc-msg-content-' + id);
            if (!el || el.dataset.editing) return;
            msgGCEditOriginal[id] = el.innerHTML;
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
            saveLink.onclick = (e) => { e.preventDefault(); saveEditGCMessage(id, ta.value); };
            const cancelLink = document.createElement('a');
            cancelLink.href = '#'; cancelLink.className = 'button'; cancelLink.textContent = 'Cancel'; cancelLink.style.cssText = 'width:auto;height:auto;padding:4px 14px;font-size:0.85em;text-decoration:none;';
            cancelLink.onclick = (e) => { e.preventDefault(); cancelEditGCMessage(id); };
            actions.appendChild(saveLink);
            actions.appendChild(cancelLink);
            el.appendChild(actions);
            ta.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEditGCMessage(id, ta.value); }
                else if (e.key === 'Escape') cancelEditGCMessage(id);
            });
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
        }
        function cancelEditGCMessage(id) {
            const el = document.getElementById('gc-msg-content-' + id);
            if (el && msgGCEditOriginal[id] !== undefined) {
                el.innerHTML = msgGCEditOriginal[id];
                delete el.dataset.editing;
                delete msgGCEditOriginal[id];
            }
        }
        function saveEditGCMessage(id, content) {
            if (!content || !content.trim()) return;
            fetch('/groups/${groupId}/edit/' + id, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content })
            }).then(r => r.json().then(d => ({ ok: r.ok, d }))).then(({ ok, d }) => {
                if (!ok) { showGCError((d && d.error) || 'Failed to edit message.'); return; }
                delete msgGCEditOriginal[id];
                // The bubble itself is refreshed via the 'edit' SSE event.
            }).catch(() => showGCError('Network error - edit not saved.'));
        }
        function showGCError(message) {
            const t = document.createElement('div');
            t.textContent = message;
            t.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:var(--text-color);padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
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
                    gcAttachMgr.clear();
                    clearGCReply();
                }
            } catch (err) {
                showGCError('Network error - message not sent.');
            } finally {
                gcSendBtn.disabled = false;
                gcContent.focus();
            }
        }
        function addMemberRow(username) {
            if (!gcMembersList || gcMembersList.querySelector('span[data-username="' + username + '"]')) return;
            const span = document.createElement('span');
            span.setAttribute('data-username', username);
            span.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,0.08);border-radius:20px;padding:3px 10px;font-size:0.82em;';
            const link = document.createElement('a');
            link.href = '/user/' + username;
            link.style.cssText = 'color:var(--text-color);text-decoration:none;';
            link.textContent = username;
            span.appendChild(link);
            if (isCreator) {
                const kickBtn = document.createElement('button');
                kickBtn.title = 'Kick ' + username;
                kickBtn.setAttribute('aria-label', 'Kick ' + username);
                kickBtn.style.cssText = 'background:none;border:none;color:var(--danger-color);cursor:pointer;font-size:0.9em;padding:0 2px;line-height:1;';
                kickBtn.textContent = '✕';
                kickBtn.addEventListener('click', () => kickMember(username));
                span.appendChild(kickBtn);
            }
            gcMembersList.appendChild(span);
        }

        function removeMemberRow(username) {
            if (!gcMembersList) return;
            const span = gcMembersList.querySelector('span[data-username="' + username + '"]');
            if (span) span.remove();
        }

        async function addMember(username) {
            const result = document.getElementById('add-member-result');
            if (!username) return;
            result.style.color = 'var(--text-color)'; result.textContent = 'Adding...';
            try {
                const r = await fetch('/groups/${groupId}/add-member', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ username }) });
                const d = await r.json();
                if (!r.ok) { result.style.color = 'var(--danger-color)'; result.textContent = d.error || 'Error.'; }
                else {
                    result.style.color = 'var(--accent-color)'; result.textContent = username + ' added!';
                    addMemberRow(username);
                    setTimeout(() => { result.textContent = ''; }, 1500);
                }
            } catch(e) { result.style.color = 'var(--danger-color)'; result.textContent = 'Network error.'; }
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
                result.style.color = 'var(--danger-color)'; result.textContent = 'You have no friends to add.';
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
            result.style.color = 'var(--text-color)'; result.textContent = 'Leaving...';
            try {
                const r = await fetch('/groups/${groupId}/leave', { method: 'POST' });
                const d = await r.json();
                if (!r.ok) { result.style.color = 'var(--danger-color)'; result.textContent = d.error || 'Error leaving group.'; }
                else { window.location.href = '/groups'; }
            } catch(e) { result.style.color = 'var(--danger-color)'; result.textContent = 'Network error.'; }
        }

        async function togglePublic() {
            // Re-check current state from the button label each time, since
            // this can be toggled back and forth without a page reload.
            const btn = document.getElementById('toggle-public-btn');
            const nowPublic = btn.textContent.trim() === 'Make Private';
            const result = document.getElementById('add-member-result');
            const question = nowPublic
                ? 'Make this group private again? It will be removed from Discover and only current members will be able to see it.'
                : 'Make this group public? Anyone will be able to find it on Discover and join.';
            if (!confirm(question)) return;
            if (!confirm('Are you sure? Press OK to ' + (nowPublic ? 'make it private' : 'make it public') + '.')) return;
            result.style.color = 'var(--text-color)'; result.textContent = 'Updating...';
            try {
                const r = await fetch('/groups/${groupId}/toggle-public', { method: 'POST' });
                const d = await r.json();
                if (!r.ok) { result.style.color = 'var(--danger-color)'; result.textContent = d.error || 'Error.'; return; }
                btn.textContent = d.isPublic ? 'Make Private' : 'Make Public';
                const badge = document.getElementById('gc-public-badge');
                if (badge) badge.style.display = d.isPublic ? 'inline' : 'none';
                result.style.color = 'var(--accent-color)'; result.textContent = d.isPublic ? 'Group is now public.' : 'Group is now private.';
                setTimeout(() => { result.textContent = ''; }, 2000);
            } catch(e) { result.style.color = 'var(--danger-color)'; result.textContent = 'Network error.'; }
        }

        async function kickMember(username) {
            if (!confirm('Kick ' + username + ' from this group?')) return;
            const result = document.getElementById('add-member-result');
            result.style.color = 'var(--text-color)'; result.textContent = 'Kicking ' + username + '...';
            try {
                const r = await fetch('/groups/${groupId}/kick/' + encodeURIComponent(username), { method: 'POST' });
                const d = await r.json();
                if (!r.ok) { result.style.color = 'var(--danger-color)'; result.textContent = d.error || 'Error.'; }
                else { result.style.color = 'var(--accent-color)'; result.textContent = username + ' kicked!'; setTimeout(() => { result.textContent = ''; location.reload(); }, 900); }
            } catch(e) { result.style.color = 'var(--danger-color)'; result.textContent = 'Network error.'; }
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
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${SOUND_SCRIPT}${EMOJI_SCRIPT}${REPORT_SCRIPT}${REACTION_SCRIPT}<script>window.MSG_REACT_BASE = '/groups/${groupId}/react/';</script>${MSG_REACTION_SCRIPT}

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

app.post('/groups/:id/send', requireVerifiedForUpload, chatSendGuard('pre'), attachmentGate('json'), (req, res, next) => {
    uploadGC.array('attachments', MAX_FILES_GC)(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `A file is too large - the limit is ${MAX_ATTACHMENT_MB} MB per file.`, code: 'upload_limit' });
            if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: `Too many files - max ${MAX_FILES_GC} per message.` });
            if (err.code === 'FILE_TYPE_BLOCKED') return res.status(400).json({ error: err.message });
            return res.status(400).json({ error: 'Upload failed.' });
        }
        next();
    });
}, processAttachments('json'), chatSendGuard('post'), (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const me = req.session.userUsername;
    const groupId = parseInt(req.params.id);
    db.get(`SELECT id FROM Group_Chat_Members WHERE group_id = ? AND username = ?`, [groupId, me], (err, memberRow) => {
        if (!memberRow) return res.status(403).json({ error: 'Not a member of this group.' });
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

        recordPrivateUploads(files, { scope: 'gc', groupId });
        db.run(`INSERT INTO Group_Chat_Messages (group_id, from_user, content, file_path, file_name, files_json, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [groupId, me, (content || '').trim(), filePath, fileName, filesJSON, replyTo], function (err2) {
                if (err2) return res.status(500).json({ error: 'Failed to send message.' });
                const newId = this.lastID;

                db.get(`SELECT Group_Chat_Messages.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified FROM Group_Chat_Messages LEFT JOIN User_Data ON Group_Chat_Messages.from_user = User_Data.username WHERE Group_Chat_Messages.id = ?`, [newId], (err3, row) => {
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
});

app.post('/groups/:id/delete/:msgId', (req, res) => {
    if (!req.session.userId) return res.status(401).end();
    const me = req.session.userUsername;
    const groupId = parseInt(req.params.id);
    const msgId = parseInt(req.params.msgId);
    db.get(`SELECT from_user, file_path, file_name, files_json FROM Group_Chat_Messages WHERE id = ? AND group_id = ?`, [msgId, groupId], (err, msg) => {
        if (err || !msg) return res.status(404).end();
        if (msg.from_user !== me) return res.status(403).end();
        const attachments = getAttachments(msg);
        db.run(`DELETE FROM Group_Chat_Message_Reactions WHERE message_id = ?`, [msgId]);
        db.run(`DELETE FROM Group_Chat_Messages WHERE id = ?`, [msgId], (err2) => {
            if (err2) return res.status(500).end();
            cleanupAttachmentFiles(attachments);
            db.all(`SELECT username FROM Group_Chat_Members WHERE group_id = ?`, [groupId], (err3, memberRows) => {
                broadcastGCDelete(groupId, msgId, (memberRows || []).map(r => r.username));
                res.status(200).end();
            });
        });
    });
});

app.post('/groups/:id/edit/:msgId', chatSendGuard('post', { dedupe: false }), (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const me = req.session.userUsername;
    const groupId = parseInt(req.params.id);
    const msgId = parseInt(req.params.msgId);
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
    if (content.length > MAX_MSG_LENGTH) return res.status(400).json({ error: `Message too long - ${MAX_MSG_LENGTH} character limit.` });
    db.get(`SELECT from_user, reply_to FROM Group_Chat_Messages WHERE id = ? AND group_id = ?`, [msgId, groupId], (err, msg) => {
        if (err || !msg) return res.status(404).json({ error: 'Message not found.' });
        if (msg.from_user !== me) return res.status(403).json({ error: 'You can only edit your own messages.' });
        db.run(`UPDATE Group_Chat_Messages SET content = ?, edited = 1 WHERE id = ?`, [content.trim(), msgId], (err2) => {
            if (err2) { console.error('GC message edit error:', err2.message); return res.status(500).json({ error: 'Failed to edit message.' }); }
            db.get(`SELECT Group_Chat_Messages.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified FROM Group_Chat_Messages LEFT JOIN User_Data ON Group_Chat_Messages.from_user = User_Data.username WHERE Group_Chat_Messages.id = ?`, [msgId], (err3, row) => {
                if (err3 || !row) return res.json({ ok: true });
                db.all(`SELECT username FROM Group_Chat_Members WHERE group_id = ?`, [groupId], (err4, memberRows) => {
                    const members = (memberRows || []).map(r => r.username);
                    const finish = (replyMsg) => {
                        broadcastGCEdit(groupId, me, row, replyMsg, members);
                        res.json({ ok: true });
                    };
                    if (row.reply_to) {
                        db.get(`SELECT * FROM Group_Chat_Messages WHERE id = ?`, [row.reply_to], (err5, replyRow) => finish(replyRow || null));
                    } else {
                        finish(null);
                    }
                });
            });
        });
    });
});

// Group chat equivalent of /messages/:username/react/:id - same add-if-missing/remove-if-present
// toggle.
app.post('/groups/:id/react/:msgId', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const me = req.session.userUsername;
    const groupId = parseInt(req.params.id);
    const msgId = parseInt(req.params.msgId, 10);
    if (!Number.isInteger(msgId)) return res.status(404).json({ error: 'Message not found.' });
    const emoji = ((req.body && req.body.emoji) || '').trim();
    if (!emoji) return res.status(400).json({ error: 'Pick an emoji first.' });
    if (/[\r\n\t]/.test(emoji)) return res.status(400).json({ error: 'Reactions must be a single emoji, not text.' });
    if (emoji.length > MAX_REACTION_EMOJI_LENGTH) return res.status(400).json({ error: `Reaction too long - ${MAX_REACTION_EMOJI_LENGTH} character limit.` });

    db.get(`SELECT id FROM Group_Chat_Members WHERE group_id = ? AND username = ?`, [groupId, me], (errMem, memberRow) => {
        if (errMem) return res.status(500).json({ error: 'db error' });
        if (!memberRow) return res.status(403).json({ error: 'Not a member of this group.' });

        db.get(`SELECT id FROM Group_Chat_Messages WHERE id = ? AND group_id = ?`, [msgId, groupId], (err, msg) => {
            if (err) return res.status(500).json({ error: 'db error' });
            if (!msg) return res.status(404).json({ error: 'Message not found.' });

            db.get(`SELECT id FROM Group_Chat_Message_Reactions WHERE message_id = ? AND username = ? AND emoji = ?`, [msgId, me, emoji], (err2, existing) => {
                if (err2) return res.status(500).json({ error: 'db error' });

                const respond = () => {
                    db.all(`SELECT username FROM Group_Chat_Members WHERE group_id = ?`, [groupId], (errMembers, memberRows) => {
                        broadcastGCReaction(groupId, msgId, (memberRows || []).map(r => r.username));
                        res.json({ ok: true, html: renderGCMsgReactionsHTML(msgId, getGCMessageReactions(msgId, me), me) });
                    });
                };

                if (existing) {
                    db.run(`DELETE FROM Group_Chat_Message_Reactions WHERE id = ?`, [existing.id], (err3) => {
                        if (err3) return res.status(500).json({ error: 'db error' });
                        respond();
                    });
                } else {
                    db.get(`SELECT COUNT(DISTINCT emoji) AS n FROM Group_Chat_Message_Reactions WHERE message_id = ?`, [msgId], (err3, cntRow) => {
                        if (err3) return res.status(500).json({ error: 'db error' });
                        if (cntRow && cntRow.n >= MAX_DISTINCT_REACTIONS_PER_MESSAGE) {
                            return res.status(400).json({ error: 'This message already has the maximum number of different reactions.' });
                        }
                        db.run(`INSERT INTO Group_Chat_Message_Reactions (message_id, username, emoji) VALUES (?, ?, ?)`, [msgId, me, emoji], (err4) => {
                            if (err4) return res.status(500).json({ error: 'db error' });
                            respond();
                        });
                    });
                }
            });
        });
    });
});
