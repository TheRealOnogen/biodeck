// Friend requests, friends list, follow / unfollow.
const { app } = require('../app');
const {
    EMOJI_SCRIPT,
    NOTIF_BADGE_SCRIPT,
    REACTION_SCRIPT,
    REPORT_SCRIPT,
    SOUND_SCRIPT,
    USER_EVENTS_SCRIPT,
} = require('../client-scripts');
const { db } = require('../db/connection');
const { escapeHTML, renderAvatarHTML, renderVerifiedBadge } = require('../render/html');
const { createNotification, eitherBlocked } = require('../social');

app.post('/friend-request/send/:username', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const from = req.session.userUsername;
    const to = req.params.username;
    if (from === to) return res.status(400).json({ error: 'cannot friend yourself' });
    if (eitherBlocked(from, to)) return res.status(403).json({ error: "You can't send a friend request to this user." });
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

    db.all(`SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END as friend_username, User_Data.avatar_path, User_Data.IsVerified
            FROM Friends LEFT JOIN User_Data ON User_Data.username = CASE WHEN user_a = ? THEN user_b ELSE user_a END
            WHERE user_a = ? OR user_b = ? ORDER BY Friends.created_at DESC`, [me, me, me, me], (err, friends) => {

        db.all(`SELECT Friend_Requests.*, User_Data.avatar_path, User_Data.IsVerified FROM Friend_Requests LEFT JOIN User_Data ON User_Data.username = Friend_Requests.from_user
                WHERE to_user = ? AND status = 'pending' ORDER BY created_at DESC`, [me], (err2, incoming) => {

            db.all(`SELECT Friend_Requests.*, User_Data.avatar_path, User_Data.IsVerified FROM Friend_Requests LEFT JOIN User_Data ON User_Data.username = Friend_Requests.to_user
                    WHERE from_user = ? AND status = 'pending' ORDER BY created_at DESC`, [me], (err3, outgoing) => {

                function renderUserRow(username, avatarPath, actionHTML, isVerified) {
                    return `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.1);">
                        <a href="/user/${escapeHTML(username)}" style="flex-shrink:0;">${renderAvatarHTML(avatarPath, username, 40)}</a>
                        <a href="/user/${escapeHTML(username)}" style="color:var(--text-color);text-decoration:none;font-weight:bold;flex:1;">${escapeHTML(username)}${renderVerifiedBadge(isVerified)}</a>
                        ${actionHTML}
                    </div>`;
                }

                const friendsHTML = (friends || []).map(f =>
                    renderUserRow(f.friend_username, f.avatar_path,
                        `<a href="/messages/${escapeHTML(f.friend_username)}" class="button" style="padding:6px 12px;text-decoration:none;font-size:0.85em;">Message</a>
                         <button class="button" onclick="unfriend('${escapeHTML(f.friend_username)}')" style="padding:6px 12px;font-size:0.85em;height:44px;background:rgba(255,60,60,0.15);border-color:rgba(255,60,60,0.6);color:var(--danger-light-color);">Unfriend</button>`, f.IsVerified)
                ).join('');

                const incomingHTML = (incoming || []).map(r =>
                    renderUserRow(r.from_user, r.avatar_path,
                        `<button class="button" onclick="acceptRequest('${escapeHTML(r.from_user)}')" style="padding:6px 12px;font-size:0.85em;background:rgba(0,191,255,0.15);border-color:rgba(0,191,255,0.6);color:var(--accent-color);width: auto;height: 25px;">Accept</button>
                         <button class="button" onclick="declineRequest('${escapeHTML(r.from_user)}')" style="padding:6px 12px;font-size:0.85em;background:rgba(255,60,60,0.08);border-color:rgba(255,60,60,0.4);color:var(--danger-light-color);width: auto;height: 25px;">Decline</button>`, r.IsVerified)
                ).join('');

                const outgoingHTML = (outgoing || []).map(r =>
                    renderUserRow(r.to_user, r.avatar_path,
                        `<span style="opacity:0.5;font-size:0.85em;">Pending…</span>
                         <button class="button" onclick="cancelRequest('${escapeHTML(r.to_user)}')" style="padding:6px 12px;font-size:0.85em;">Cancel</button>`, r.IsVerified)
                ).join('');

                res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Friends</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
</head>
<body class="page-friends">
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
        <div class="section-title" id="incoming-section-title">Incoming Requests <span class="badge" id="incoming-badge">${(incoming || []).length}</span></div>` : `<div class="section-title" id="incoming-section-title" style="display:none;">Incoming Requests <span class="badge" id="incoming-badge">0</span></div>`}
        <div id="incoming-list">${incomingHTML}</div>

        ${(outgoing || []).length > 0 ? `
        <div class="section-title" id="outgoing-section-title">Sent Requests</div>` : `<div class="section-title" id="outgoing-section-title" style="display:none;">Sent Requests</div>`}
        <div id="outgoing-list">${outgoingHTML}</div>

        <div class="section-title">Your Friends <span style="opacity:0.4;font-size:0.8em;font-weight:400;" id="friends-count">(${(friends || []).length})</span></div>
        <div id="friends-list">${friendsHTML || '<p id="no-friends-msg" style="opacity:0.4;">No friends yet. Send friend requests from someone\'s profile page.</p>'}</div>
    </div>

    <script>
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => { btn.classList.add('clicked'); setTimeout(() => btn.classList.remove('clicked'), 150); });
        });

        function findRow(containerId, username) {
            const container = document.getElementById(containerId);
            if (!container) return null;
            return Array.from(container.children).find(row => {
                const link = row.querySelector('a[href^="/user/"]');
                return link && link.getAttribute('href') === '/user/' + username;
            });
        }

        function removeRow(containerId, username) {
            const row = findRow(containerId, username);
            if (row) row.remove();
            updateSectionVisibility();
        }

        function updateSectionVisibility() {
            const incomingList = document.getElementById('incoming-list');
            const incomingTitle = document.getElementById('incoming-section-title');
            if (incomingList && incomingTitle) {
                const count = incomingList.children.length;
                incomingTitle.style.display = count ? '' : 'none';
                const badge = document.getElementById('incoming-badge');
                if (badge) badge.textContent = count;
            }
            const outgoingList = document.getElementById('outgoing-list');
            const outgoingTitle = document.getElementById('outgoing-section-title');
            if (outgoingList && outgoingTitle) {
                outgoingTitle.style.display = outgoingList.children.length ? '' : 'none';
            }
            const friendsList = document.getElementById('friends-list');
            const friendsCount = document.getElementById('friends-count');
            if (friendsList && friendsCount) {
                friendsCount.textContent = '(' + friendsList.children.length + ')';
                if (!friendsList.children.length && !document.getElementById('no-friends-msg')) {
                    const p = document.createElement('p');
                    p.id = 'no-friends-msg';
                    p.style.opacity = '0.4';
                    p.textContent = "No friends yet. Send friend requests from someone's profile page.";
                    friendsList.appendChild(p);
                } else if (friendsList.children.length > 1) {
                    const msg = document.getElementById('no-friends-msg');
                    if (msg) msg.remove();
                }
            }
        }

        function acceptRequest(username) {
            fetch('/friend-request/accept/' + username, { method: 'POST' })
                .then(r => r.json()).then(d => {
                    if (!d.ok) return;
                    const row = findRow('incoming-list', username);
                    if (!row) return;
                    row.querySelectorAll('button, a.button').forEach(el => el.remove());
                    const msgLink = document.createElement('a');
                    msgLink.href = '/messages/' + username;
                    msgLink.className = 'button';
                    msgLink.style.cssText = 'padding:6px 12px;text-decoration:none;font-size:0.85em;';
                    msgLink.textContent = 'Message';
                    const unfriendBtn = document.createElement('button');
                    unfriendBtn.className = 'button';
                    unfriendBtn.style.cssText = 'padding:6px 12px;font-size:0.85em;height:44px;background:rgba(255,60,60,0.15);border-color:rgba(255,60,60,0.6);color:var(--danger-light-color);';
                    unfriendBtn.textContent = 'Unfriend';
                    unfriendBtn.addEventListener('click', () => unfriend(username));
                    row.appendChild(msgLink);
                    row.appendChild(unfriendBtn);
                    const msg = document.getElementById('no-friends-msg');
                    if (msg) msg.remove();
                    document.getElementById('friends-list').prepend(row);
                    updateSectionVisibility();
                });
        }

        function declineRequest(username) {
            fetch('/friend-request/decline/' + username, { method: 'POST' })
                .then(r => r.json()).then(d => { if (d.ok) removeRow('incoming-list', username); });
        }

        function cancelRequest(username) {
            fetch('/friend-request/cancel/' + username, { method: 'POST' })
                .then(r => r.json()).then(d => { if (d.ok) removeRow('outgoing-list', username); });
        }

        function unfriend(username) {
            if (!confirm('Remove ' + username + ' from friends?')) return;
            fetch('/unfriend/' + username, { method: 'POST' })
                .then(r => r.json()).then(d => { if (d.ok) removeRow('friends-list', username); });
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
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${SOUND_SCRIPT}${EMOJI_SCRIPT}${REPORT_SCRIPT}${REACTION_SCRIPT}

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
    if (eitherBlocked(follower, following)) return res.status(403).json({ error: "You can't follow this user." });
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
