// Feed page and feed API (posts, reports, reactions, polling).
const { app } = require('../app');
const { deletePostDescendants } = require('../cascade');
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
const {
    MAX_ATTACHMENT_MB,
    MAX_DISTINCT_REACTIONS_PER_POST,
    MAX_POST_LENGTH,
    MAX_REACTION_EMOJI_LENGTH,
} = require('../config');
const { db } = require('../db/connection');
const { requireVerifiedForUpload } = require('../middleware/email-verified');
const { isUserMuted, logAudit } = require('../moderation');
const {
    buildFeedHTML,
    buildPostListHTML,
    getPostReactions,
    renderFeedPost,
    renderPinnedItem,
    renderReactionsHTML,
} = require('../render/posts');
const {
    checkPostFlood,
    checkPostSpam,
    postFloodGuard,
    recordAcceptedPost,
    sendPostRejection,
} = require('../security/post-spam');
const { postRateLimiter } = require('../security/rate-limit');
const { createNotification, processMentions } = require('../social');
const { processAttachments } = require('../uploads/convert');
const { cleanupAttachmentFiles, getAttachments } = require('../uploads/files');
const { MAX_FILES_FEED, uploadFeed } = require('../uploads/multer');
const { attachmentGate } = require('../uploads/quota');

app.get('/feed', (req, res) => {
    if (!req.session.userId) return res.redirect('/');

    db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified, (WITH RECURSIVE descendants(id) AS (SELECT id FROM Posts AS r WHERE r.reply_to = Posts.id UNION ALL SELECT p.id FROM Posts p JOIN descendants d ON p.reply_to = d.id) SELECT COUNT(*) FROM descendants) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.pinned = 1 ORDER BY Posts.created_at DESC`, [], (pinErr, pinnedPosts) => {
        const pinnedHTML = (pinnedPosts || []).map(renderPinnedItem).join('');

    db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified, (WITH RECURSIVE descendants(id) AS (SELECT id FROM Posts AS r WHERE r.reply_to = Posts.id UNION ALL SELECT p.id FROM Posts p JOIN descendants d ON p.reply_to = d.id) SELECT COUNT(*) FROM descendants) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username ORDER BY Posts.created_at DESC LIMIT 10`, [], (err, posts) => {
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
<link rel="stylesheet" href="/theme.css">
${ATTACH_STYLE_BLOCK}
<script>${ATTACH_JS_BLOCK}</script>
</head>
<body class="page-feed">
    <div id="dnd-overlay"><div>Drop files to attach</div></div>
    <div id="feed-wrapper" class="box" style="color: var(--text-color); animation: none !important;">
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

        <div id="posts" style="color: var(--text-color);">
            ${postsHTML.length ? postsHTML : '<p id="no-posts-msg">No posts yet.</p>'}
            <div id="load-more-sentinel" style="height:1px;"></div>
            <div id="load-more-spinner" style="display:none;text-align:center;padding:16px;opacity:0.5;font-size:0.9em;">Loading older posts…</div>
        </div>

        <div id="post-form-container">
            <form action="/feed/post" method="POST" enctype="multipart/form-data" id="post-form">
                <div id="post-attach-preview" class="attach-preview"></div>
                <div id="post-form-row">
                    <textarea class="box" name="content" id="post-content" placeholder="What's on your mind?" style="font-family:inherit;font-size:inherit;padding:8px;" maxlength="1000"></textarea>
                    <input type="file" id="attachment" name="attachments" multiple style="display:none;">
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

        const postAttachMgr = biodeckAttachManager('attachment', 'post-attach-preview', 5);
        biodeckWireDrop('post-form-container', postAttachMgr);

        const postContent = document.getElementById('post-content');
        const postCounter = document.getElementById('post-char-counter');
        postContent.addEventListener('input', function () {
            const len = this.value.length;
            postCounter.textContent = len + ' / 1000';
            postCounter.style.color = len > 900 ? (len >= 1000 ? 'var(--danger-color)' : 'var(--warning-color)') : '';
            postCounter.style.opacity = len > 3800 ? '1' : '0.5';
        });

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
                // Always clear attachments after a submit attempt, success or
                // not - otherwise a rejected/failed post left the previously
                // chosen files silently sitting in the picker, so the *next*
                // submit would resend them even though the preview strip (or
                // nothing) is what the person actually sees on screen.
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
                    pollFeed();
                }
            } catch (err) {
                showPostError('Network error - post not sent.');
            } finally {
                postSubmitBtn.disabled = false;
            }
        }

        if (new URLSearchParams(window.location.search).get('posterror')) {
            const perr = new URLSearchParams(window.location.search).get('posterror');
            const muted = perr === 'muted';
            const t = document.createElement('div');
            t.textContent = muted ? "You're not able to post until your warning expires."
                : perr === 'filetype' ? "That file type isn't allowed as an attachment."
                : 'Post too long or too many files selected - 1,000 character limit, max 5 files.';
            t.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:var(--text-color);padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
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
            fetch('/admin/pin/' + id, { method: 'POST' }).then(r => { if (r.ok) onPinChanged(id, true); });
        }
        function unpinPost(id) {
            fetch('/admin/unpin/' + id, { method: 'POST' }).then(r => { if (r.ok) onPinChanged(id, false); });
        }
        function onPinChanged(id, pinned) {
            const wrapper = document.getElementById('post-' + id);
            if (wrapper) {
                const btn = Array.from(wrapper.querySelectorAll('.post-action-btn')).find(b => b.textContent === 'Pin' || b.textContent === 'Unpin');
                if (btn) {
                    btn.textContent = pinned ? 'Unpin' : 'Pin';
                    btn.setAttribute('onclick', (pinned ? 'unpinPost(' : 'pinPost(') + id + ')');
                }
            }
            fetch('/feed/pinned-bar').then(r => r.ok ? r.text() : null).then(html => {
                if (html === null) return;
                let bar = document.getElementById('pinned-bar');
                if (!html.trim()) {
                    if (bar) bar.remove();
                } else if (bar) {
                    bar.innerHTML = html;
                } else {
                    bar = document.createElement('div');
                    bar.id = 'pinned-bar';
                    bar.innerHTML = html;
                    document.getElementById('feed-wrapper').insertBefore(bar, document.getElementById('posts'));
                }
                layoutPinnedBar();
            }).catch(() => {});
        }
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
        let lastPostId = (() => {
            const posts = document.querySelectorAll('.post[id^="post-"]');
            let max = ${newestPostId};
            posts.forEach(el => { const n = parseInt(el.id.replace('post-', '')); if (n > max) max = n; });
            return max;
        })();

        let pollFeedInFlight = false;
        function pollFeed() {
            // Guard against overlapping calls: submitPostForm() calls this right
            // after a successful post, and setInterval/visibilitychange can also
            // fire it around the same moment. Without this guard, two requests
            // could both be sent with the same after=lastPostId value before either
            // resolves, so both responses would contain the same new post(s) and
            // both would get inserted - showing the post twice on screen.
            if (pollFeedInFlight) return;
            pollFeedInFlight = true;
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

        setInterval(pollFeed, 4000);
        setInterval(pollDeletions, 5000);
        setInterval(pollReplyCounts, 5000);
        setInterval(pollEdits, 5000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollFeed(); pollDeletions(); pollReplyCounts(); pollEdits(); } });

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
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${SOUND_SCRIPT}${EMOJI_SCRIPT}${REPORT_SCRIPT}${REACTION_SCRIPT}

</body>
</html>`);
    });
    });
});
app.post('/feed/post', postRateLimiter, requireVerifiedForUpload, postFloodGuard, attachmentGate('feed'), (req, res, next) => {
    uploadFeed.array('attachments', MAX_FILES_FEED)(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') return sendPostRejection(req, res, 422, `A file is too large - the limit is ${MAX_ATTACHMENT_MB} MB per file.`);
            const backTo = req.body && req.body.reply_to ? `/post/${parseInt(req.body.reply_to)}` : '/feed';
            if (err.code === 'LIMIT_FILE_COUNT') return res.redirect(`${backTo}?posterror=files`);
            if (err.code === 'FILE_TYPE_BLOCKED') return res.redirect(`${backTo}?posterror=filetype`);
            return res.redirect(`${backTo}?posterror=1`);
        }
        next();
    });
}, processAttachments('feed'), (req, res) => {
    if (!req.session.userId) return res.redirect('/');

    const { content, reply_to } = req.body;
    const files = req.files || [];
    const filesMeta = files.map(f => ({ path: f.path, name: f.originalname, size: f.size }));
    const filesJSON = filesMeta.length ? JSON.stringify(filesMeta) : null;
    // Keep the legacy single-file columns populated with the first attachment so any old code path
    // that still reads file_path/file_name.
    const filePath = files[0] ? files[0].path : null;
    const fileName = files[0] ? files[0].originalname : null;
    const replyTo = reply_to ? parseInt(reply_to) : null;
    const backTo = replyTo ? `/post/${replyTo}` : '/feed';

    isUserMuted(req.session.userUsername, (errMute, mute) => {
        if (!errMute && mute) return res.redirect(`${backTo}?posterror=muted`);

    if ((!content || !content.trim()) && !files.length) return res.redirect(backTo);
    if (content && content.length > MAX_POST_LENGTH) return res.redirect(`${backTo}?posterror=1`);

    // Content checks first, then the flood counter.
    const spamVerdict = checkPostSpam(req, content) || checkPostFlood(req);
    if (spamVerdict) {
        cleanupAttachmentFiles(filesMeta);
        return sendPostRejection(req, res, spamVerdict.status, spamVerdict.message);
    }
    recordAcceptedPost(req, content);

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
});

// Returns just the pinned-items strip HTML so the client can refresh it after a pin/unpin action
// without reloading the whole feed.
app.get('/feed/pinned-bar', (req, res) => {
    if (!req.session.userId) return res.status(401).end();
    db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.pinned = 1 ORDER BY Posts.created_at DESC`, [], (err, pinnedPosts) => {
        if (err) return res.status(500).end();
        res.send((pinnedPosts || []).map(renderPinnedItem).join(''));
    });
});

// Unified report endpoint for the "Report" button on feed posts, DMs, and group chat messages.
app.post('/report', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const { type, id } = req.body || {};
    const sourceId = parseInt(id, 10);
    if (!['post', 'dm', 'gc'].includes(type) || !Number.isInteger(sourceId)) {
        return res.status(400).json({ error: 'Invalid report.' });
    }
    const reporter = req.session.userUsername;

    function fileReport(reportedUsername, content, row) {
        if (reportedUsername === reporter) return res.status(400).json({ error: "You can't report your own content." });
        // Authoritative duplicate check - this is what actually makes the Report button spam-proof.
        db.get(`SELECT id FROM Reports WHERE reporter_username = ? AND source_type = ? AND source_id = ?`, [reporter, type, sourceId], (dupErr, existing) => {
            if (dupErr) { console.error('Report dup-check error:', dupErr.message); return res.status(500).json({ error: 'Failed to submit report.' }); }
            if (existing) return res.status(409).json({ error: 'You already reported this.', alreadyReported: true });
            const attachments = getAttachments(row);
            const attachmentsJson = attachments.length ? JSON.stringify(attachments) : null;
            db.run(`INSERT INTO Reports (reporter_username, reported_username, source_type, source_id, content, attachments_json) VALUES (?, ?, ?, ?, ?, ?)`,
                [reporter, reportedUsername, type, sourceId, content || '', attachmentsJson], (err) => {
                    if (err) { console.error('Report insert error:', err.message); return res.status(500).json({ error: 'Failed to submit report.' }); }
                    logAudit('content_reported', reporter, reportedUsername, `${type} #${sourceId}`);
                    res.json({ ok: true });
                });
        });
    }

    if (type === 'post') {
        db.get(`SELECT username, content, file_path, file_name, files_json FROM Posts WHERE id = ?`, [sourceId], (err, post) => {
            if (err || !post) return res.status(404).json({ error: 'Post not found.' });
            fileReport(post.username, post.content, post);
        });
    } else if (type === 'dm') {
        db.get(`SELECT from_user, to_user, content, file_path, file_name, files_json FROM Messages WHERE id = ?`, [sourceId], (err, msg) => {
            if (err || !msg) return res.status(404).json({ error: 'Message not found.' });
            if (msg.from_user !== reporter && msg.to_user !== reporter) return res.status(403).json({ error: 'Not your conversation.' });
            fileReport(msg.from_user, msg.content, msg);
        });
    } else if (type === 'gc') {
        db.get(`SELECT from_user, group_id, content, file_path, file_name, files_json FROM Group_Chat_Messages WHERE id = ?`, [sourceId], (err, msg) => {
            if (err || !msg) return res.status(404).json({ error: 'Message not found.' });
            db.get(`SELECT id FROM Group_Chat_Members WHERE group_id = ? AND username = ?`, [msg.group_id, reporter], (err2, memberRow) => {
                if (err2 || !memberRow) return res.status(403).json({ error: 'Not a member of that group chat.' });
                fileReport(msg.from_user, msg.content, msg);
            });
        });
    }
});

// Returns the logged-in user's own list of already-filed reports.
app.get('/api/my-reports', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    db.all(`SELECT source_type, source_id FROM Reports WHERE reporter_username = ?`, [req.session.userUsername], (err, rows) => {
        if (err) { console.error('my-reports error:', err.message); return res.status(500).json({ error: 'Failed to load reports.' }); }
        res.json({ reports: (rows || []).map(r => ({ type: r.source_type, id: r.source_id })) });
    });
});

app.post('/feed/delete/:id', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const postId = parseInt(req.params.id);
    db.get(`SELECT username, file_path, file_name, files_json FROM Posts WHERE id = ?`, [postId], (err, post) => {
        if (err || !post) return res.status(404).end();
        if (post.username !== req.session.userUsername && !req.isAdmin) return res.status(403).end();
        const attachments = getAttachments(post);
        db.run(`DELETE FROM Reactions WHERE post_id = ?`, [postId]);
        db.run(`DELETE FROM Notifications WHERE post_id = ?`, [postId]);
        db.run(`DELETE FROM Posts WHERE id = ?`, [postId], (err) => {
            if (err) { console.error('Delete error:', err.message); return res.status(200).end(); }
            cleanupAttachmentFiles(attachments);
            // Take the replies (and their files/reactions) down with the post.
            deletePostDescendants([postId], () => res.status(200).end());
        });
    });
});

app.post('/feed/edit/:id', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const postId = parseInt(req.params.id);
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Post cannot be empty.' });
    if (content.length > MAX_POST_LENGTH) return res.status(400).json({ error: `Post too long - ${MAX_POST_LENGTH} character limit.` });
    db.get(`SELECT username FROM Posts WHERE id = ?`, [postId], (err, post) => {
        if (err || !post) return res.status(404).json({ error: 'Post not found.' });
        if (post.username !== req.session.userUsername) return res.status(403).json({ error: 'You can only edit your own posts.' });
        db.run(`UPDATE Posts SET content = ?, edited = 1 WHERE id = ?`, [content.trim(), postId], (err2) => {
            if (err2) { console.error('Post edit error:', err2.message); return res.status(500).json({ error: 'Failed to edit post.' }); }
            db.get(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified, (WITH RECURSIVE descendants(id) AS (SELECT id FROM Posts AS r WHERE r.reply_to = Posts.id UNION ALL SELECT p.id FROM Posts p JOIN descendants d ON p.reply_to = d.id) SELECT COUNT(*) FROM descendants) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.id = ?`, [postId], (err3, row) => {
                if (err3 || !row) return res.json({ ok: true });
                res.json({ ok: true, html: renderFeedPost(row, req.session.userUsername, 350, req.isAdmin) });
            });
        });
    });
});

// Toggles the session user's reaction with a given emoji on a post: adds it if they haven't reacted
// with that emoji yet.
app.post('/post/:id/react', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const postId = parseInt(req.params.id, 10);
    if (!Number.isInteger(postId)) return res.status(404).json({ error: 'Post not found.' });
    const emoji = ((req.body && req.body.emoji) || '').trim();
    if (!emoji) return res.status(400).json({ error: 'Pick an emoji first.' });
    if (/[\r\n\t]/.test(emoji)) return res.status(400).json({ error: 'Reactions must be a single emoji, not text.' });
    if (emoji.length > MAX_REACTION_EMOJI_LENGTH) return res.status(400).json({ error: `Reaction too long - ${MAX_REACTION_EMOJI_LENGTH} character limit.` });
    const username = req.session.userUsername;

    isUserMuted(username, (errMute, mute) => {
        if (!errMute && mute) return res.status(403).json({ error: 'Muted users cannot react to posts.' });

        db.get(`SELECT id FROM Posts WHERE id = ?`, [postId], (err, post) => {
            if (err) return res.status(500).json({ error: 'db error' });
            if (!post) return res.status(404).json({ error: 'Post not found.' });

            db.get(`SELECT id FROM Reactions WHERE post_id = ? AND username = ? AND emoji = ?`, [postId, username, emoji], (err2, existing) => {
                if (err2) return res.status(500).json({ error: 'db error' });

                const respond = () => {
                    const reactions = getPostReactions(postId, username);
                    res.json({ ok: true, html: renderReactionsHTML(postId, reactions, username) });
                };

                if (existing) {
                    db.run(`DELETE FROM Reactions WHERE id = ?`, [existing.id], (err3) => {
                        if (err3) return res.status(500).json({ error: 'db error' });
                        respond();
                    });
                } else {
                    db.get(`SELECT COUNT(DISTINCT emoji) AS n FROM Reactions WHERE post_id = ?`, [postId], (err3, cntRow) => {
                        if (err3) return res.status(500).json({ error: 'db error' });
                        if (cntRow && cntRow.n >= MAX_DISTINCT_REACTIONS_PER_POST) {
                            return res.status(400).json({ error: 'This post already has the maximum number of different reactions.' });
                        }
                        db.run(`INSERT INTO Reactions (post_id, username, emoji) VALUES (?, ?, ?)`, [postId, username, emoji], (err4) => {
                            if (err4) return res.status(500).json({ error: 'db error' });
                            respond();
                        });
                    });
                }
            });
        });
    });
});

app.get('/feed/exists', (req, res) => {
    // Read-only - allowed for guests too, so the post page's deletion polling still works when
    // viewing without an account.
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
        `SELECT Posts.id AS post_id,
                (WITH RECURSIVE descendants(id) AS (
                    SELECT id FROM Posts AS r WHERE r.reply_to = Posts.id
                    UNION ALL
                    SELECT p.id FROM Posts p JOIN descendants d ON p.reply_to = d.id
                ) SELECT COUNT(*) FROM descendants) AS cnt
         FROM Posts WHERE Posts.id IN (${intIds.map(() => '?').join(',')})`,
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

// Lets clients poll for posts that have been edited since they were first rendered.
app.get('/feed/edits', (req, res) => {
    // Read-only - allowed for guests too, so the post page's edit polling still works when viewing
    // without an account.
    let ids = req.query.id;
    if (!ids) return res.json({ posts: {} });
    if (!Array.isArray(ids)) ids = [ids];
    const intIds = ids.map(Number).filter(Boolean);
    if (!intIds.length) return res.json({ posts: {} });
    db.all(
        `SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified, (WITH RECURSIVE descendants(id) AS (SELECT id FROM Posts AS r WHERE r.reply_to = Posts.id UNION ALL SELECT p.id FROM Posts p JOIN descendants d ON p.reply_to = d.id) SELECT COUNT(*) FROM descendants) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.id IN (${intIds.map(() => '?').join(',')}) AND edited = 1`,
        intIds,
        (err, rows) => {
            if (err) return res.status(500).json({ error: 'db error' });
            const posts = {};
            (rows || []).forEach(row => {
                posts[row.id] = { raw: row.content || '', html: renderFeedPost(row, req.session.userUsername, 350, req.isAdmin) };
            });
            res.json({ posts });
        }
    );
});

app.get('/feed/search', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ html: '' });
    const like = '%' + q + '%';
    db.all(
        `SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified, (WITH RECURSIVE descendants(id) AS (SELECT id FROM Posts AS r WHERE r.reply_to = Posts.id UNION ALL SELECT p.id FROM Posts p JOIN descendants d ON p.reply_to = d.id) SELECT COUNT(*) FROM descendants) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE (Posts.content LIKE ? OR Posts.username LIKE ?) AND Posts.reply_to IS NULL ORDER BY Posts.created_at DESC LIMIT 30`,
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

    db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified, (WITH RECURSIVE descendants(id) AS (SELECT id FROM Posts AS r WHERE r.reply_to = Posts.id UNION ALL SELECT p.id FROM Posts p JOIN descendants d ON p.reply_to = d.id) SELECT COUNT(*) FROM descendants) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.id < ? ORDER BY Posts.created_at DESC LIMIT 10`, [beforeId], (err, posts) => {
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

    db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified, (WITH RECURSIVE descendants(id) AS (SELECT id FROM Posts AS r WHERE r.reply_to = Posts.id UNION ALL SELECT p.id FROM Posts p JOIN descendants d ON p.reply_to = d.id) SELECT COUNT(*) FROM descendants) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.id > ? ORDER BY Posts.created_at DESC`, [afterId], (err, newPosts) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!newPosts || !newPosts.length) return res.json({ html: '', lastId: afterId });

        const lastId = Math.max(...newPosts.map(p => p.id));

        const html = buildFeedHTML(newPosts, sessionUsername, 350, req.isAdmin);
        res.json({ html, lastId });
    });
});
