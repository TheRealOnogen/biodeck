// Notifications.
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
const { renderNotificationItem } = require('../render/notifications');
const { getUnreadNotificationCount } = require('../social');

app.get('/notifications', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const me = req.session.userUsername;

    db.all(`SELECT Notifications.*, User_Data.Nickname AS actor_nickname, User_Data.IsVerified AS actor_verified FROM Notifications LEFT JOIN User_Data ON Notifications.actor_username = User_Data.username WHERE Notifications.username = ? ORDER BY Notifications.id DESC LIMIT 50`, [me], (err, notifs) => {
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
<link rel="stylesheet" href="/theme.css">
</head>
<body class="page-notifications">
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
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${SOUND_SCRIPT}${EMOJI_SCRIPT}${REPORT_SCRIPT}${REACTION_SCRIPT}

</body>
</html>`);
    });
});

app.get('/notifications/poll', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const me = req.session.userUsername;
    const afterId = parseInt(req.query.after) || 0;

    db.all(`SELECT Notifications.*, User_Data.Nickname AS actor_nickname, User_Data.IsVerified AS actor_verified FROM Notifications LEFT JOIN User_Data ON Notifications.actor_username = User_Data.username WHERE Notifications.username = ? AND Notifications.id > ? ORDER BY Notifications.id DESC`, [me, afterId], (err, notifs) => {
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
