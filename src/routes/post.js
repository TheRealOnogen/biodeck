// Single post / thread page.
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
const { escapeHTML } = require('../render/html');
const { buildPostListHTML, renderFeedPost } = require('../render/posts');

app.get('/post/:id', (req, res) => {
    // Posts are viewable by anyone with the link, logged in or not - only the ability to reply.
    const isLoggedIn = !!req.session.userId;
    const postId = parseInt(req.params.id);
    if (!postId) return res.status(404).send('Post not found');
    const sessionUsername = req.session.userUsername;

    db.get(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified, (WITH RECURSIVE descendants(id) AS (SELECT id FROM Posts AS r WHERE r.reply_to = Posts.id UNION ALL SELECT p.id FROM Posts p JOIN descendants d ON p.reply_to = d.id) SELECT COUNT(*) FROM descendants) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.id = ?`, [postId], (err, rootPost) => {
        if (err) { console.error(err); return res.status(500).send('Error loading post'); }
        if (!rootPost) return res.status(404).send('Post not found');

        const renderPage = (parentPost) => {
            const parentContextHTML = !rootPost.reply_to ? '' : (parentPost
                ? `<div class="reply-context"><a href="/post/${parentPost.id}" style="color:var(--accent-color);text-decoration:none;">> Replying to @${escapeHTML(parentPost.username)}</a></div>`
                : `<div class="reply-context" style="opacity:0.4;">> Replying to a deleted post</div>`);

            db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified, (WITH RECURSIVE descendants(id) AS (SELECT id FROM Posts AS r WHERE r.reply_to = Posts.id UNION ALL SELECT p.id FROM Posts p JOIN descendants d ON p.reply_to = d.id) SELECT COUNT(*) FROM descendants) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.reply_to = ? ORDER BY Posts.created_at DESC LIMIT 10`, [postId], (err2, replies) => {
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
<link rel="stylesheet" href="/theme.css">
${ATTACH_STYLE_BLOCK}
<script>${ATTACH_JS_BLOCK}</script>
</head>
<body class="page-post">
    <div id="dnd-overlay"><div>Drop files to attach</div></div>
    <div id="feed-wrapper" class="box" style="color: var(--text-color); animation: none !important;">
        <div id="feed-topbar">
            <div id="feed-topbar-left">${isLoggedIn ? `Logged in as <strong>${req.session.userUsername}</strong>` : 'Viewing as guest'}</div>
            <div id="feed-topbar-right" style="position:relative;display:flex;align-items:center;">
                ${isLoggedIn ? `
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
                </nav>` : `
                <a href="/">Log in</a>
                <a href="/register">Register</a>`}
            </div>
        </div>

        <div id="posts" style="color: var(--text-color);">
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
            ${isLoggedIn ? `
            <form action="/feed/post" method="POST" enctype="multipart/form-data" id="post-form">
                <input type="hidden" name="reply_to" value="${rootPost.id}">
                <div id="post-attach-preview" class="attach-preview"></div>
                <div id="post-form-row">
                    <textarea class="box" name="content" id="post-content" placeholder="Write a reply…" style="font-family:inherit;font-size:inherit;padding:8px;" maxlength="1000"></textarea>
                    <input type="file" id="attachment" name="attachments" multiple style="display:none;">
                    <label for="attachment" class="button post-action-btn" id="file-label" style="width:70px !important; height: 44px !important; padding: 10px;">Browse</label>
                    <button class="button post-action-btn" type="submit" style="width:60px !important; height: 44px !important;">Reply</button>
                </div>
                <div id="post-char-counter" style="font-size:0.75em;opacity:0.5;text-align:right;margin-top:2px;">0 / 1000</div>
            </form>` : `
            <div style="text-align:center;padding:10px;opacity:0.7;">
                <a href="/" style="color:var(--accent-color);">Log in</a> or <a href="/register" style="color:var(--accent-color);">register</a> to reply.
            </div>`}
        </div>
    </div>

    <script>
        document.querySelectorAll('.post-time').forEach(el => {
            const ts = el.getAttribute('data-ts');
            if (ts) el.textContent = new Date(ts).toLocaleString('en-GB');
        });

        ${isLoggedIn ? `
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

        if (new URLSearchParams(window.location.search).get('posterror')) {
            const perr = new URLSearchParams(window.location.search).get('posterror');
            const muted = perr === 'muted';
            const t = document.createElement('div');
            t.textContent = muted ? "You're not able to reply until your warning expires."
                : perr === 'filetype' ? "That file type isn't allowed as an attachment."
                : 'Reply too long or too many files selected - 1,000 character limit, max 5 files.';
            t.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:var(--text-color);padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 4000);
            window.history.replaceState(null, '', '/post/${rootPost.id}');
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
                    showPostError("You're not able to reply until your warning expires.");
                } else if (r.url && r.url.includes('posterror=filetype')) {
                    showPostError("That file type isn't allowed as an attachment.");
                } else if (r.url && r.url.includes('posterror')) {
                    showPostError('Reply too long or too many files selected - 1,000 character limit, max 5 files.');
                } else {
                    postContent.value = '';
                    postCounter.textContent = '0 / 1000';
                    postCounter.style.color = '';
                    postCounter.style.opacity = '0.5';
                    pollReplies();
                }
            } catch (err) {
                showPostError('Network error - reply not sent.');
            } finally {
                postSubmitBtn.disabled = false;
            }
        }` : ''}

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
                // Root post uses a different wrapper id than replies.
                const wrapper = document.getElementById('post-' + id) || document.getElementById('root-post-' + id);
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

        let lastReplyId = (() => {
            const items = document.querySelectorAll('.post[id^="post-"]');
            let max = ${newestReplyId};
            items.forEach(el => { const n = parseInt(el.id.replace('post-', '')); if (n > max) max = n; });
            return max;
        })();

        let pollRepliesInFlight = false;
        function pollReplies() {
            // Same overlapping-request race as the feed's pollFeed: submitPostForm()
            // calls this right after a reply posts, and setInterval/visibilitychange
            // can also fire it around the same moment. Without this guard, two
            // requests can both go out with the same after=lastReplyId before either
            // resolves, so both responses contain the same new reply and it gets
            // inserted twice.
            if (pollRepliesInFlight) return;
            pollRepliesInFlight = true;
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
                .catch(() => {})
                .finally(() => { pollRepliesInFlight = false; });
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

        function pollEdits() {
            const ids = [ROOT_ID];
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
                        // Root post uses a different wrapper id than replies.
                        const wrapper = document.getElementById('post-' + id) || document.getElementById('root-post-' + id);
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

        setInterval(pollReplies, 4000);
        setInterval(pollDeletions, 5000);
        setInterval(pollEdits, 5000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollReplies(); pollDeletions(); pollEdits(); } });

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
${isLoggedIn ? `${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${SOUND_SCRIPT}${EMOJI_SCRIPT}${REPORT_SCRIPT}${REACTION_SCRIPT}` : ''}

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
    // Read-only - allowed for guests too, since the post page itself is now
    // viewable without an account.
    const sessionUsername = req.session.userUsername;
    const postId = parseInt(req.params.id);
    const afterId = parseInt(req.query.after) || 0;

    db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified, (WITH RECURSIVE descendants(id) AS (SELECT id FROM Posts AS r WHERE r.reply_to = Posts.id UNION ALL SELECT p.id FROM Posts p JOIN descendants d ON p.reply_to = d.id) SELECT COUNT(*) FROM descendants) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.reply_to = ? AND Posts.id > ? ORDER BY Posts.created_at DESC`, [postId, afterId], (err, newReplies) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!newReplies || !newReplies.length) return res.json({ html: '', lastId: afterId });

        const lastId = Math.max(...newReplies.map(p => p.id));
        const html = buildPostListHTML(newReplies, sessionUsername, 350, req.isAdmin);
        res.json({ html, lastId });
    });
});

app.get('/post/:id/older', (req, res) => {
    // Read-only - allowed for guests too, since the post page itself is now
    // viewable without an account.
    const sessionUsername = req.session.userUsername;
    const postId = parseInt(req.params.id);
    const beforeId = parseInt(req.query.before) || 0;
    if (!beforeId) return res.json({ html: '', hasMore: false, oldestId: 0 });

    db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified, (WITH RECURSIVE descendants(id) AS (SELECT id FROM Posts AS r WHERE r.reply_to = Posts.id UNION ALL SELECT p.id FROM Posts p JOIN descendants d ON p.reply_to = d.id) SELECT COUNT(*) FROM descendants) AS reply_count FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.reply_to = ? AND Posts.id < ? ORDER BY Posts.created_at DESC LIMIT 10`, [postId, beforeId], (err, replies) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!replies || !replies.length) return res.json({ html: '', hasMore: false, oldestId: 0 });

        const hasMore = replies.length === 10;
        const oldestId = Math.min(...replies.map(p => p.id));
        const html = buildPostListHTML(replies, sessionUsername, 350, req.isAdmin);
        res.json({ html, hasMore, oldestId });
    });
});
