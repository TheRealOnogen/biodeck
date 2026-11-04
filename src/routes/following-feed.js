// Following feed.
const { app } = require('../app');
const {
    ATTACH_JS_BLOCK,
    ATTACH_STYLE_BLOCK,
    EMOJI_SCRIPT,
    NOTIF_BADGE_SCRIPT,
    REACTION_SCRIPT,
    REPORT_SCRIPT,
    SOUND_SCRIPT,
    USER_EVENTS_SCRIPT,
} = require('../client-scripts');
const { db } = require('../db/connection');
const { getFollowingList } = require('../follows');
const { buildFeedHTML } = require('../render/posts');

app.get('/following-feed', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const sessionUsername = req.session.userUsername;

    getFollowingList(sessionUsername, (followingList) => {
        const placeholders = followingList.map(() => '?').join(',');

        db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified, (WITH RECURSIVE descendants(id) AS (SELECT id FROM Posts AS r WHERE r.reply_to = Posts.id UNION ALL SELECT p.id FROM Posts p JOIN descendants d ON p.reply_to = d.id) SELECT COUNT(*) FROM descendants) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.username IN (${placeholders}) ORDER BY Posts.created_at DESC LIMIT 10`,
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
<link rel="stylesheet" href="/theme.css">
${ATTACH_STYLE_BLOCK}
<script>${ATTACH_JS_BLOCK}</script>
</head>
<body class="page-following-feed">
    <div id="dnd-overlay"><div>Drop files to attach</div></div>
    <div id="feed-wrapper" class="box" style="color: var(--text-color); animation: none !important;">
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

        <div id="posts" style="color: var(--text-color);">
            ${postsHTML || `<p id="no-posts-msg" style="opacity:0.5;margin-top:40px;">No posts yet from people you follow.</p>`}
            <div id="load-more-sentinel" style="height:1px;"></div>
            <div id="load-more-spinner" style="display:none;text-align:center;opacity:0.5;padding:16px 0;">Loading…</div>
        </div>

        <div id="post-form-container">
            <div id="reply-indicator">> Replying to <span id="reply-to-name"></span> - <a href="#" onclick="clearReply();return false;" style="color:var(--accent-color);">Cancel</a></div>
            <form action="/feed/post" method="POST" enctype="multipart/form-data" id="post-form">
                <input type="hidden" name="reply_to" id="reply-to-input" value="">
                <div id="post-attach-preview" class="attach-preview"></div>
                <div id="post-form-row">
                    <textarea name="content" id="post-content" placeholder="What's on your mind?" maxlength="1000"></textarea>
                    <input type="file" name="attachments" id="attachment" multiple style="display:none;">
                    <label for="attachment" class="button post-action-btn" id="file-label" style="width:70px !important; height: 44px !important; padding: 10px;">Browse</label>
                    <button class="button post-action-btn" type="submit" style="width:60px !important; height: 44px !important;">Post</button>
                </div>
                <div id="post-char-counter" style="font-size:0.75em;opacity:0.5;text-align:right;margin-top:2px;">0 / 1000</div>
            </form>
        </div>
    </div>

    <script>
        document.querySelectorAll('.post-time').forEach(el => {
            const ts = el.getAttribute('data-ts');
            if (ts) el.textContent = new Date(ts).toLocaleString('en-GB');
        });

        const postAttachMgr = biodeckAttachManager('attachment', 'post-attach-preview', 5);
        biodeckWireDrop('post-form-container', postAttachMgr);

        const postContent = document.getElementById('post-content');
        const postCounter = document.getElementById('post-char-counter');
        postContent.addEventListener('input', function () {
            const len = this.value.length;
            postCounter.textContent = len + ' / 1000';
            postCounter.style.color = len > 900 ? (len >= 1000 ? 'var(--danger-color)' : 'var(--warning-color)') : '';
            postCounter.style.opacity = len > 900 ? '1' : '0.5';
        });

        function showPostError(message) {
            const t = document.createElement('div');
            t.textContent = message;
            t.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:var(--text-color);padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 4000);
        }

        if (new URLSearchParams(window.location.search).get('posterror')) {
            const perr = new URLSearchParams(window.location.search).get('posterror');
            showPostError(perr === 'muted' ? "You're not able to post until your warning expires."
                : perr === 'filetype' ? "That file type isn't allowed as an attachment."
                : 'Post too long or too many files selected - 1,000 character limit, max 5 files.');
            window.history.replaceState(null, '', '/following-feed');
        }

        const postForm = document.getElementById('post-form');
        const postSubmitBtn = postForm.querySelector('button[type="submit"]');
        postForm.addEventListener('submit', function (e) {
            e.preventDefault();
            submitPostForm();
        });
        async function submitPostForm() {
            const attachmentInput = document.getElementById('attachment');
            if (!postContent.value.trim() && !attachmentInput.files.length) return;
            postSubmitBtn.disabled = true;
            const fd = new FormData(postForm);
            try {
                const r = await fetch(postForm.action, { method: 'POST', body: fd });
                postAttachMgr.clear();
                if (r.status === 429 || r.status === 422) {
                    let rejection = null;
                    try { rejection = await r.json(); } catch (e) {}
                    showPostError((rejection && rejection.error) || "You're posting too fast. Please slow down.");
                } else if (r.url && r.url.includes('posterror=muted')) {
                    showPostError("You're not able to post until your warning expires.");
                } else if (r.url && r.url.includes('posterror=filetype')) {
                    showPostError("That file type isn't allowed as an attachment.");
                } else if (r.url && r.url.includes('posterror')) {
                    showPostError('Post too long or too many files selected - 1,000 character limit, max 5 files.');
                } else {
                    postContent.value = '';
                    postCounter.textContent = '0 / 1000';
                    postCounter.style.color = '';
                    postCounter.style.opacity = '0.5';
                    clearReply();
                    pollFeed();
                }
            } catch (err) {
                showPostError('Network error - post not sent.');
            } finally {
                postSubmitBtn.disabled = false;
            }
        }

        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => { btn.classList.add('clicked'); setTimeout(() => btn.classList.remove('clicked'), 150); });
        });

        const postEditOriginal = {};
        function editPost(id) {
            const el = document.getElementById('post-content-' + id);
            if (!el || el.dataset.editing) return;
            postEditOriginal[id] = el.innerHTML;
            el.dataset.editing = '1';
            const raw = el.getAttribute('data-raw') || '';
            el.innerHTML = '';
            const ta = document.createElement('textarea');
            ta.className = 'box';
            ta.maxLength = 1000;
            ta.style.cssText = 'width:100%;box-sizing:border-box;font-family:inherit;font-size:inherit;padding:6px;resize:vertical;';
            ta.value = raw;
            el.appendChild(ta);
            const actions = document.createElement('div');
            actions.style.cssText = 'margin-top:4px;display:flex;gap:10px;font-size:0.85em;';
            const saveLink = document.createElement('a');
            saveLink.href = '#'; saveLink.className = 'button'; saveLink.textContent = 'Save'; saveLink.style.cssText = 'width:auto;height:auto;padding:4px 14px;font-size:0.85em;text-decoration:none;';
            saveLink.onclick = (e) => { e.preventDefault(); saveEditPost(id, ta.value); };
            const cancelLink = document.createElement('a');
            cancelLink.href = '#'; cancelLink.className = 'button'; cancelLink.textContent = 'Cancel'; cancelLink.style.cssText = 'width:auto;height:auto;padding:4px 14px;font-size:0.85em;text-decoration:none;';
            cancelLink.onclick = (e) => { e.preventDefault(); cancelEditPost(id); };
            actions.appendChild(saveLink);
            actions.appendChild(cancelLink);
            el.appendChild(actions);
            ta.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEditPost(id, ta.value); }
                else if (e.key === 'Escape') cancelEditPost(id);
            });
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
        }
        function cancelEditPost(id) {
            const el = document.getElementById('post-content-' + id);
            if (el && postEditOriginal[id] !== undefined) {
                el.innerHTML = postEditOriginal[id];
                delete el.dataset.editing;
                delete postEditOriginal[id];
            }
        }
        function saveEditPost(id, content) {
            if (!content || !content.trim()) return;
            fetch('/feed/edit/' + id, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content })
            }).then(r => r.json().then(d => ({ ok: r.ok, d }))).then(({ ok, d }) => {
                if (!ok) { showPostError((d && d.error) || 'Failed to edit post.'); return; }
                delete postEditOriginal[id];
                const wrapper = document.getElementById('post-' + id);
                if (wrapper && d && d.html) {
                    wrapper.innerHTML = d.html;
                    wrapper.querySelectorAll('.post-time[data-ts]').forEach(el => {
                        el.textContent = new Date(el.getAttribute('data-ts')).toLocaleString('en-GB');
                    });
                }
            }).catch(() => showPostError('Network error - edit not saved.'));
        }
        function showPostError(message) {
            const t = document.createElement('div');
            t.textContent = message;
            t.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:var(--text-color);padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 4000);
        }
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
            fetch('/admin/pin/' + id, { method: 'POST' }).then(r => { if (r.ok) togglePinButton(id, true); });
        }
        function unpinPost(id) {
            fetch('/admin/unpin/' + id, { method: 'POST' }).then(r => { if (r.ok) togglePinButton(id, false); });
        }
        function togglePinButton(id, pinned) {
            const wrapper = document.getElementById('post-' + id);
            if (!wrapper) return;
            const btn = Array.from(wrapper.querySelectorAll('.post-action-btn')).find(b => b.textContent === 'Pin' || b.textContent === 'Unpin');
            if (btn) {
                btn.textContent = pinned ? 'Unpin' : 'Pin';
                btn.setAttribute('onclick', (pinned ? 'unpinPost(' : 'pinPost(') + id + ')');
            }
        }

        let lastPostId = (() => {
            const posts = document.querySelectorAll('.post[id^="post-"]');
            let max = ${newestPostId};
            posts.forEach(el => { const n = parseInt(el.id.replace('post-', '')); if (n > max) max = n; });
            return max;
        })();

        let pollFeedInFlight = false;
        function pollFeed() {
            // Same overlapping-request race as /feed's pollFeed - guard it the
            // same way so a just-submitted post can't get inserted twice.
            if (pollFeedInFlight) return;
            pollFeedInFlight = true;
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
                    const frag = document.createDocumentFragment();
                    while (temp.firstChild) frag.appendChild(temp.firstChild);
                    postsEl.insertBefore(frag, postsEl.firstChild);
                    postsEl.querySelectorAll('.post-time[data-ts]').forEach(el => {
                        if (!el.textContent.trim()) el.textContent = new Date(el.getAttribute('data-ts')).toLocaleString('en-GB');
                    });
                })
                .catch(() => {})
                .finally(() => { pollFeedInFlight = false; });
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

        function pollEdits() {
            const ids = [];
            document.querySelectorAll('.post[id^="post-"]').forEach(el => {
                ids.push(parseInt(el.id.replace('post-', '')));
            });
            if (!ids.length) return;
            fetch('/feed/edits?' + ids.map(id => 'id=' + id).join('&'))
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                    if (!data || !data.posts) return;
                    Object.keys(data.posts).forEach(id => {
                        const contentEl = document.getElementById('post-content-' + id);
                        if (contentEl && contentEl.dataset.editing) return;
                        if (contentEl && contentEl.getAttribute('data-raw') === data.posts[id].raw) return;
                        const wrapper = document.getElementById('post-' + id);
                        if (wrapper) {
                            wrapper.innerHTML = data.posts[id].html;
                            wrapper.querySelectorAll('.post-time[data-ts]').forEach(el => {
                                el.textContent = new Date(el.getAttribute('data-ts')).toLocaleString('en-GB');
                            });
                        }
                    });
                })
                .catch(() => {});
        }

        // Refresh when the server announces a change (WebSocket), or on a timer if it is down.
        document.addEventListener('DOMContentLoaded', () => {
            livePoll('feed', pollFeed, 4000);
            livePoll('feed', pollDeletions, 5000);
            livePoll('feed', pollReplyCounts, 5000);
            livePoll('feed', pollEdits, 5000);
        });
        document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollFeed(); pollDeletions(); pollReplyCounts(); pollEdits(); } });

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
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${SOUND_SCRIPT}${EMOJI_SCRIPT}${REPORT_SCRIPT}${REACTION_SCRIPT}

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
        db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified, (WITH RECURSIVE descendants(id) AS (SELECT id FROM Posts AS r WHERE r.reply_to = Posts.id UNION ALL SELECT p.id FROM Posts p JOIN descendants d ON p.reply_to = d.id) SELECT COUNT(*) FROM descendants) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.username IN (${placeholders}) AND Posts.id > ? ORDER BY Posts.created_at DESC`,
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
        db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified, (WITH RECURSIVE descendants(id) AS (SELECT id FROM Posts AS r WHERE r.reply_to = Posts.id UNION ALL SELECT p.id FROM Posts p JOIN descendants d ON p.reply_to = d.id) SELECT COUNT(*) FROM descendants) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.username IN (${placeholders}) AND Posts.id < ? ORDER BY Posts.created_at DESC LIMIT 10`,
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
