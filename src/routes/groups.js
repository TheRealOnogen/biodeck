// Group list, discovery and membership.
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
const { postSystemGCMessage } = require('../live/events');
const { escapeHTML } = require('../render/html');
const { cleanupAttachmentFiles, getAttachments } = require('../uploads/files');

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
                    <a href="/groups/${g.id}" style="color:var(--text-color);text-decoration:none;font-weight:bold;font-size:1.05em;">${escapeHTML(g.name)}</a>
                    ${g.is_public ? '<span style="font-size:0.7em;opacity:0.6;border:1px solid rgba(255,255,255,0.25);border-radius:10px;padding:1px 7px;margin-left:6px;">Public</span>' : ''}
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
<link rel="stylesheet" href="/theme.css">
</head>
<body class="page-groups">
    <div id="gc-topbar">
        <div>Group Chats</div>
        <div id="gc-topbar-right">
            <a href="/discover">Discover</a>
            <a href="/messages">DMs</a>
            <a href="/feed">Feed</a>
            <a href="/notifications" class="notif-nav-link">Notifications</a>
            <a href="/logout">Logout</a>
            <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
            <nav id="nav-dropdown">
                <a href="/discover">Discover</a>
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
                <button class="button" onclick="confirmFriendsPicker()" style="padding:6px 16px;width:auto;height:auto;">Done</button>
            </div>
        </div>
    </div>

    <div id="gc-body">
        <div id="create-gc-form">
            <h3 style="margin:0 0 8px;">New Group Chat</h3>
            <input style="height: 25px;" type="text" id="gc-name" placeholder="Group name" maxlength="80">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <button class="button" type="button" onclick="openFriendsPicker()" style="padding:7px 14px;width:auto;height:auto;font-size:0.9em;">+ Add Friends</button>
                <span style="font-size:0.82em;opacity:0.5;" id="gc-selected-count">No friends selected</span>
            </div>
            <div id="gc-selected-tags"></div>
            <div id="gc-create-result" style="font-size:0.85em;min-height:1em;"></div>
            <button class="button" onclick="createGC()" style="width:140px;">Create Group</button>
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
                result.style.color = 'var(--danger-color)';
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
            if (!name) { result.style.color = 'var(--danger-color)'; result.textContent = 'Group name is required.'; return; }
            if (!members.length) { result.style.color = 'var(--danger-color)'; result.textContent = 'Add at least one friend.'; return; }
            result.style.color = 'var(--text-color)'; result.textContent = 'Creating...';
            try {
                const r = await fetch('/groups/create', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, members }) });
                const d = await r.json();
                if (!r.ok) { result.style.color = 'var(--danger-color)'; result.textContent = d.error || 'Error creating group.'; }
                else { window.location.href = '/groups/' + d.id; }
            } catch(e) { result.style.color = 'var(--danger-color)'; result.textContent = 'Network error.'; }
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
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${SOUND_SCRIPT}${EMOJI_SCRIPT}${REPORT_SCRIPT}${REACTION_SCRIPT}

</body>
</html>`);
    });
});

app.get('/discover', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const me = req.session.userUsername;
    db.all(`SELECT Group_Chats.*, COUNT(Group_Chat_Members.id) AS member_count,
                   SUM(CASE WHEN Group_Chat_Members.username = ? THEN 1 ELSE 0 END) AS is_member
            FROM Group_Chats
            LEFT JOIN Group_Chat_Members ON Group_Chats.id = Group_Chat_Members.group_id
            WHERE Group_Chats.is_public = 1
            GROUP BY Group_Chats.id
            ORDER BY Group_Chats.created_at DESC`, [me], (err, groups) => {
        if (err) { console.error(err); return res.status(500).send('Error loading discover'); }
        const groupsHTML = (groups || []).map(g => `
            <div class="discover-gc-row" data-id="${g.id}" style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.1);">
                <div>
                    <a href="/groups/${g.id}" style="color:var(--text-color);text-decoration:none;font-weight:bold;font-size:1.05em;">${escapeHTML(g.name)}</a>
                    <div style="font-size:0.8em;opacity:0.5;margin-top:3px;">${g.member_count} member${g.member_count === 1 ? '' : 's'} &middot; created by @${escapeHTML(g.created_by)}</div>
                </div>
                ${g.is_member
                    ? `<button class="button" onclick="window.location.href='/groups/${g.id}'" style="padding:8px 16px;white-space:nowrap;">Open</button>`
                    : `<button class="button" onclick="joinGC(${g.id}, this)" style="padding:8px 16px;white-space:nowrap;">Join</button>`}
            </div>`).join('');

        res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Discover Group Chats</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
</head>
<body class="page-groups">
    <div id="gc-topbar">
        <div>Discover</div>
        <div id="gc-topbar-right">
            <a href="/groups">Group Chats</a>
            <a href="/messages">DMs</a>
            <a href="/feed">Feed</a>
            <a href="/notifications" class="notif-nav-link">Notifications</a>
            <a href="/logout">Logout</a>
            <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
            <nav id="nav-dropdown">
                <a href="/groups">Group Chats</a>
                <a href="/messages">DMs</a>
                <a href="/feed">Feed</a>
                <a href="/notifications" class="notif-nav-link">Notifications</a>
                <a href="/logout">Logout</a>
            </nav>
        </div>
    </div>

    <div id="gc-body">
        <h3 style="opacity:0.6;margin:0 0 12px;">Public Group Chats</h3>
        <div id="discover-result" style="font-size:0.85em;min-height:1em;"></div>
        ${groupsHTML || '<p style="opacity:0.4;">No public group chats yet. Any group creator can make their group public from inside the group.</p>'}
    </div>
    <script>
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => { btn.classList.add('clicked'); setTimeout(() => btn.classList.remove('clicked'), 150); });
        });

        async function joinGC(id, btn) {
            const result = document.getElementById('discover-result');
            btn.disabled = true;
            try {
                const r = await fetch('/groups/' + id + '/join', { method: 'POST' });
                const d = await r.json();
                if (!r.ok) {
                    result.style.color = 'var(--danger-color)'; result.textContent = d.error || 'Error joining group.';
                    btn.disabled = false;
                } else {
                    window.location.href = '/groups/' + id;
                }
            } catch(e) {
                result.style.color = 'var(--danger-color)'; result.textContent = 'Network error.';
                btn.disabled = false;
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
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${SOUND_SCRIPT}${EMOJI_SCRIPT}${REPORT_SCRIPT}${REACTION_SCRIPT}

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
                postSystemGCMessage(groupId, `${me} added ${newMember} to the group`);
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
                    db.all(`SELECT file_path, file_name, files_json FROM Group_Chat_Messages WHERE group_id = ?`, [groupId], (errPre, gcRows) => {
                        const attachments = (gcRows || []).reduce((acc, r) => acc.concat(getAttachments(r)), []);
                        db.run(`DELETE FROM Group_Chat_Message_Reactions WHERE message_id IN (SELECT id FROM Group_Chat_Messages WHERE group_id = ?)`, [groupId]);
                        db.run(`DELETE FROM Group_Chat_Messages WHERE group_id = ?`, [groupId], () => cleanupAttachmentFiles(attachments));
                    });
                    db.run(`DELETE FROM Group_Chats WHERE id = ?`, [groupId]);
                } else {
                    postSystemGCMessage(groupId, `${me} left the group`);
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

app.post('/groups/:id/toggle-public', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const me = req.session.userUsername;
    const groupId = parseInt(req.params.id);
    db.get(`SELECT created_by, is_public FROM Group_Chats WHERE id = ?`, [groupId], (err, group) => {
        if (err || !group) return res.status(404).json({ error: 'Group not found.' });
        if (group.created_by !== me) return res.status(403).json({ error: 'Only the group creator can change this.' });
        const newValue = group.is_public ? 0 : 1;
        db.run(`UPDATE Group_Chats SET is_public = ? WHERE id = ?`, [newValue, groupId], (err2) => {
            if (err2) return res.status(500).json({ error: 'db error' });
            res.json({ ok: true, isPublic: !!newValue });
        });
    });
});

app.post('/groups/:id/join', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const me = req.session.userUsername;
    const groupId = parseInt(req.params.id);
    db.get(`SELECT id, is_public FROM Group_Chats WHERE id = ?`, [groupId], (err, group) => {
        if (err || !group) return res.status(404).json({ error: 'Group not found.' });
        if (!group.is_public) return res.status(403).json({ error: 'This group is not public.' });
        db.run(`INSERT OR IGNORE INTO Group_Chat_Members (group_id, username) VALUES (?, ?)`, [groupId, me], function(err2) {
            if (err2) return res.status(500).json({ error: 'db error' });
            if (this.changes > 0) postSystemGCMessage(groupId, `${me} joined the group`);
            res.json({ ok: true, id: groupId });
        });
    });
});
