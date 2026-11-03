// Followers and user profile pages.
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
const { renderAttachmentsHTML } = require('../render/attachments');
const { escapeHTML, renderAvatarHTML, renderVerifiedBadge } = require('../render/html');
const { renderMarkdown } = require('../render/markdown');
const { blockExists } = require('../social');
const { getAttachments } = require('../uploads/files');

app.get('/followers', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const me = req.session.userUsername;
    db.all(`SELECT f.follower_username, u.avatar_path FROM Follows f LEFT JOIN User_Data u ON f.follower_username = u.username WHERE f.following_username = ? ORDER BY f.created_at DESC`, [me], (err, followers) => {
        const followersHTML = (followers || []).map(f => {
            const avatarHTML = renderAvatarHTML(f.avatar_path, f.follower_username, 36);
            return `<a href="/user/${escapeHTML(f.follower_username)}" style="display:flex;align-items:center;gap:12px;padding:12px 16px;border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:var(--text-color);text-decoration:none;margin-bottom:10px;transition:background 0.15s;">
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
<link rel="stylesheet" href="/theme.css">
</head>
<body class="page-followers">
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
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${SOUND_SCRIPT}${EMOJI_SCRIPT}${REPORT_SCRIPT}${REACTION_SCRIPT}

</body>
</html>`);
    });
});

app.get('/user/:username', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const profileUsername = req.params.username;
    const sessionUsername = req.session.userUsername;
    db.get(`SELECT username, Nickname, bio, IsOwner, IsDeveloper, IsSupporter, IsAdmin, IsHeadAdmin, IsBanned, IsDeleted, IsVerified, avatar_path FROM User_Data WHERE username = ?`, [profileUsername], (err, user) => {
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
                db.all(`SELECT *, (WITH RECURSIVE descendants(id) AS (SELECT id FROM Posts AS r WHERE r.reply_to = Posts.id UNION ALL SELECT p.id FROM Posts p JOIN descendants d ON p.reply_to = d.id) SELECT COUNT(*) FROM descendants) AS reply_count FROM Posts WHERE username = ? ORDER BY created_at DESC`, [profileUsername], (err2, posts) => {
                    const postsHTML = (posts || []).map(post => {
                        const fileHTML = renderAttachmentsHTML(getAttachments(post), 300);
                        return `<div class="post" style="border:1px solid var(--post-border-color);border-radius:10px;padding:10px;margin-bottom:14px;text-align:left;">
                            <span class="post-time" data-ts="${post.created_at ? post.created_at.replace(' ', 'T') + 'Z' : ''}" style="font-size:0.8em;opacity:0.6;"></span>
                            <div class="post-content" style="margin-top:4px;">${renderMarkdown(post.content)}</div>
                            ${fileHTML}
                        </div>`;
                    }).join('');

                    const isBlockedByMe = !isOwnProfile && blockExists(sessionUsername, profileUsername);
                    const blockBtn = isOwnProfile ? '' : `<a id="block-btn" class="button" onclick="toggleBlock()" style="width:120px;text-decoration:none;">${isBlockedByMe ? 'Unblock' : 'Block'}</a>`;
                    const dmBtn = isOwnProfile ? '' : `<a href="/messages/${escapeHTML(profileUsername)}" class="button" style="width:120px;text-decoration:none;">Message</a>`;
                    const followBtn = isOwnProfile ? '' : `<a id="follow-btn" class="button" onclick="toggleFollow()" style="width:120px;text-decoration:none;">${isFollowing ? 'Unfollow' : 'Follow'}</a>`;
                    const friendBtnHTML = isOwnProfile ? '' : `<a id="friend-btn" class="button" onclick="toggleFriend()" style="width:120px;text-decoration:none;">${
                        friendStatus === 'friends' ? 'Unfriend' :
                        friendStatus === 'sent' ? 'Cancel Request' :
                        friendStatus === 'received' ? 'Accept Request' :
                        'Add Friend'
                    }</a>`;
                    const followersLink = isOwnProfile
                        ? `<a href="/followers" style="color:var(--text-muted-color);text-decoration:none;font-size:0.85em;">${numFollowers} follower${numFollowers !== 1 ? 's' : ''}</a>`
                        : `<span style="color:var(--text-muted-color);font-size:0.85em;">${numFollowers} follower${numFollowers !== 1 ? 's' : ''}</span>`;

                    res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHTML(user.username)}'s Profile</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
</head>
<body class="page-profile">
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
        ${(user.IsOwner || user.IsDeveloper || user.IsSupporter || user.IsAdmin || user.IsHeadAdmin || user.IsBanned || user.IsDeleted) ? `<div style="display:flex;gap:8px;justify-content:center;margin-bottom:6px;flex-wrap:wrap;">${user.IsOwner ? '<span style="font-size:0.75em;letter-spacing:0.08em;color:var(--gold-color);font-weight:700;text-transform:uppercase;">Owner</span>' : ''}${user.IsHeadAdmin ? '<span style="font-size:0.75em;letter-spacing:0.08em;color:var(--danger-strong-color);font-weight:700;text-transform:uppercase;">Head Admin</span>' : ''}${user.IsAdmin ? '<span style="font-size:0.75em;letter-spacing:0.08em;color:var(--admin-color);font-weight:700;text-transform:uppercase;">Admin</span>' : ''}${user.IsDeveloper ? '<span style="font-size:0.75em;letter-spacing:0.08em;color:var(--accent-color);font-weight:700;text-transform:uppercase;">Developer</span>' : ''}${user.IsSupporter ? '<span style="font-size:0.75em;letter-spacing:0.08em;color:var(--purple-color);font-weight:700;text-transform:uppercase;">Supporter</span>' : ''}${user.IsDeleted ? '<span style="font-size:0.75em;letter-spacing:0.08em;color:var(--gray-color);font-weight:700;text-transform:uppercase;border:1px solid rgb(150,150,150);border-radius:4px;padding:1px 6px;">Deleted</span>' : (user.IsBanned ? '<span style="font-size:0.75em;letter-spacing:0.08em;color:var(--danger-color);font-weight:700;text-transform:uppercase;border:1px solid rgb(255,80,80);border-radius:4px;padding:1px 6px;">Banned</span>' : '')}</div>` : ''}
        <h1>${user.Nickname && user.Nickname.trim() ? escapeHTML(user.Nickname.trim()) : '@' + escapeHTML(user.username)}${renderVerifiedBadge(user.IsVerified)}</h1>
        ${user.Nickname && user.Nickname.trim() ? `<div style="opacity:0.5;font-size:0.9em;margin-top:-10px;margin-bottom:6px;">@${escapeHTML(user.username)}</div>` : ''}
        <div style="margin-bottom:8px;">${followersLink}</div>
        <div id="profile-bio">${user.bio ? renderMarkdown(user.bio) : '<span style="opacity:0.4;">No bio yet.</span>'}</div>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-bottom:20px;">
            ${dmBtn}
            ${followBtn}
            ${friendBtnHTML}
            ${blockBtn}
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

        let blocked = ${isBlockedByMe ? 'true' : 'false'};
        function toggleBlock() {
            const btn = document.getElementById('block-btn');
            if (!blocked && !confirm('Block ${escapeHTML(profileUsername)}? They will no longer be able to message, follow or friend you, and any existing friendship/follow is removed.')) return;
            const endpoint = blocked ? '/unblock/${escapeHTML(profileUsername)}' : '/block/${escapeHTML(profileUsername)}';
            btn.disabled = true;
            fetch(endpoint, { method: 'POST' })
                .then(r => r.json())
                .then(data => {
                    if (data.ok) {
                        blocked = !!data.blocked;
                        btn.textContent = blocked ? 'Unblock' : 'Block';
                        if (blocked) {
                            following = false;
                            const fb = document.getElementById('follow-btn');
                            if (fb) fb.textContent = 'Follow';
                            friendStatus = 'none';
                            const frb = document.getElementById('friend-btn');
                            if (frb) frb.textContent = 'Add Friend';
                        }
                    }
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
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${SOUND_SCRIPT}${EMOJI_SCRIPT}${REPORT_SCRIPT}${REACTION_SCRIPT}

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
