// Inline browser scripts and styles injected into pages.
const { MAX_REACTION_EMOJI_LENGTH } = require('./config');

const EMOJI_SCRIPT = `<script src="/emoji-shortcodes.js" defer><\/script>`;

// Sounds
// Both files live in public/ (served statically).
const SOUND_SCRIPT = `<script>
(function() {
    if (window.biodeckPlaySound) return;
    var files = { notif: '/notif.mp3', message: '/message.mp3' };
    var audio = {}, lastPlayed = {};
    // Quiet window: sounds are dropped until this time. It is set on page load and
    // every time the page wakes up (tab shown again, restored from bfcache, laptop
    // wakes, network returns) so a backlog of queued events / poll results that
    // lands all at once on resume can't ping.
    var QUIET_MS = 2500;
    var quietUntil = Date.now() + QUIET_MS;
    var priming = false;
    function quiet() { quietUntil = Math.max(quietUntil, Date.now() + QUIET_MS); }
    function get(kind) {
        if (!files[kind]) return null;
        if (!audio[kind]) { audio[kind] = new Audio(files[kind]); audio[kind].preload = 'auto'; }
        return audio[kind];
    }
    window.biodeckPlaySound = function(kind) {
        try {
            if (priming || Date.now() < quietUntil) return;
            var a = get(kind);
            if (!a) return;
            var now = Date.now();
            if (lastPlayed[kind] && now - lastPlayed[kind] < 400) return; // don't stack rapid-fire sounds
            lastPlayed[kind] = now;
            a.currentTime = 0;
            var p = a.play();
            if (p && p.catch) p.catch(function() {});
        } catch (e) {}
    };
    function unlock() {
        document.removeEventListener('pointerdown', unlock, true);
        document.removeEventListener('keydown', unlock, true);
        // Prime each element once so later play() calls are allowed. Priming is
        // fully silent (muted + volume 0) and real sounds are blocked meanwhile.
        var kinds = Object.keys(files), pending = kinds.length;
        priming = true;
        function finish() { if (--pending <= 0) priming = false; }
        setTimeout(function() { priming = false; }, 3000); // safety net
        kinds.forEach(function(kind) {
            var a;
            try { a = get(kind); a.muted = true; a.volume = 0; } catch (e) { finish(); return; }
            var restore = function() {
                try { a.pause(); a.currentTime = 0; a.muted = false; a.volume = 1; } catch (e) {}
                finish();
            };
            try {
                var p = a.play();
                if (p && p.then) p.then(restore, restore); else restore();
            } catch (e) { restore(); }
        });
    }
    function wake() {
        quiet();
        try { window.dispatchEvent(new Event('biodeck:wake')); } catch (e) {}
    }
    document.addEventListener('visibilitychange', function() { if (!document.hidden) wake(); });
    window.addEventListener('pageshow', wake);
    window.addEventListener('online', wake);
    document.addEventListener('resume', wake);
    // Timer gap = the machine slept / the tab was frozen. Hidden tabs are throttled
    // to ~1 tick/min by browsers, so use a much larger threshold while hidden.
    var lastTick = Date.now();
    setInterval(function() {
        var n = Date.now();
        if (n - lastTick > (document.hidden ? 120000 : 5000)) wake();
        lastTick = n;
    }, 1000);
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
})();
<\/script>`;

// Page side of the WebSocket: livePoll(type, fn, ms) runs fn when the server says "type" changed,
// and falls back to plain polling every ms while the socket is down.
const LIVE_SCRIPT = `<script>
(function() {
    var handlers = {};
    var open = false;
    var everOpen = false;
    var delay = 1000;
    function run(type) {
        (handlers[type] || []).forEach(function(fn) { try { fn(); } catch (e) {} });
    }
    function runAll() { Object.keys(handlers).forEach(run); }
    function connect() {
        var ws;
        try {
            ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
        } catch (e) { return; }
        ws.onopen = function() {
            open = true;
            delay = 1000;
            if (everOpen) runAll(); // catch up on anything missed while disconnected
            everOpen = true;
        };
        ws.onmessage = function(e) {
            var m;
            try { m = JSON.parse(e.data); } catch (_) { return; }
            if (m && m.t) run(m.t);
        };
        ws.onclose = function() {
            open = false;
            setTimeout(connect, delay);
            delay = Math.min(delay * 2, 30000);
        };
        ws.onerror = function() { try { ws.close(); } catch (_) {} };
    }
    window.livePoll = function(type, fn, ms) {
        (handlers[type] = handlers[type] || []).push(fn);
        setInterval(function() { if (!open) fn(); }, ms);
    };
    // Slow safety refresh for changes the server cannot announce (background cleanups).
    setInterval(function() { if (open && !document.hidden) runAll(); }, 60000);
    connect();
})();
<\/script>`;

const NOTIF_BADGE_SCRIPT = LIVE_SCRIPT + `<script>
(function() {
    var lastNotifCount = null;
    var resync = false; // next poll only re-baselines the count, no sound
    function updateNotifBadges() {
        fetch('/notifications/count', { cache: 'no-store' })
            .then(function(r) { return r.json(); })
            .then(function(d) {
                var count = (d && d.count) || 0;
                // Ping only when the unread count goes UP after the first load,
                // so opening a page that already has unread items stays silent.
                if (lastNotifCount !== null && !resync && count > lastNotifCount && window.biodeckPlaySound) window.biodeckPlaySound('notif');
                resync = false;
                lastNotifCount = count;
                var label = count + (count === 1 ? ' Notification' : ' Notifications');
                document.querySelectorAll('.notif-nav-link').forEach(function(el) {
                    el.textContent = label;
                    el.style.fontWeight = count > 0 ? '700' : '';
                    el.style.color = count > 0 ? 'var(--accent-color)' : '';
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
    livePoll('notifications', updateNotifBadges, 8000);
    // After the page wakes up, re-read the count silently instead of treating the
    // jump since the last poll as a brand-new notification.
    window.addEventListener('biodeck:wake', function() { resync = true; updateNotifBadges(); });
})();
<\/script>`;

// Shared "Report" button handler for feed posts, DMs, and group chat messages.
const REPORT_SCRIPT = `<script>
function reportContent(type, id, btn) {
    if (btn && btn.dataset.reported) return;
    if (btn) {
        btn.dataset.reported = '1';
        btn.disabled = true;
        btn.style.opacity = '0.5';
        btn.textContent = 'Reporting…';
    }
    fetch('/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: type, id: id })
    }).then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })
      .then(function(res) {
        if (!res.ok) {
            if (res.data && res.data.alreadyReported) {
                if (btn) btn.textContent = 'Reported';
                return;
            }
            alert('Error: ' + (res.data && res.data.error || 'failed to submit report'));
            if (btn) {
                delete btn.dataset.reported;
                btn.disabled = false;
                btn.style.opacity = '';
                btn.textContent = 'Report';
            }
            return;
        }
        if (reportedKeys) reportedKeys[type + ':' + id] = 1;
        if (btn) btn.textContent = 'Reported';
    }).catch(function() {
        alert('Network error.');
        if (btn) {
            delete btn.dataset.reported;
            btn.disabled = false;
            btn.style.opacity = '';
            btn.textContent = 'Report';
        }
    });
}
// The already-reported list comes from the server inside the page (see middleware/core.js);
// only if that is missing is it fetched, once. Later DOM changes just re-apply it.
var reportedKeys = null;
var reportedLoading = false;
function markReportButtons() {
    if (!reportedKeys) return;
    document.querySelectorAll('.report-action').forEach(function(btn) {
        if (btn.dataset.reported === '1') return;
        if (!reportedKeys[btn.dataset.reportType + ':' + btn.dataset.reportId]) return;
        btn.dataset.reported = '1';
        btn.disabled = true;
        btn.style.opacity = '0.5';
        btn.textContent = 'Reported';
    });
}
function applyReportedState() {
    if (reportedKeys) return markReportButtons();
    if (window.__reported) { // filled in by the server, so no request is needed
        reportedKeys = {};
        window.__reported.forEach(function(r) { reportedKeys[r[0] + ':' + r[1]] = 1; });
        return markReportButtons();
    }
    if (reportedLoading) return;
    reportedLoading = true;
    fetch('/api/my-reports').then(function(r) { return r.ok ? r.json() : null; }).then(function(data) {
        reportedLoading = false;
        if (!data || !data.reports) return;
        reportedKeys = {};
        data.reports.forEach(function(r) { reportedKeys[r.type + ':' + r.id] = 1; });
        markReportButtons();
    }).catch(function() { reportedLoading = false; });
}
(function() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyReportedState);
    } else {
        applyReportedState();
    }
    // Re-check whenever new content (older posts/messages loaded, new page,
    // infinite scroll, etc.) is added, so newly-rendered Report buttons for
    // already-reported content start out disabled too. Debounced since a
    // batch of new messages arrives as many DOM mutations at once.
    var reportStateDebounce;
    new MutationObserver(function() {
        clearTimeout(reportStateDebounce);
        reportStateDebounce = setTimeout(applyReportedState, 150); // no network once the list is loaded
    }).observe(document.documentElement, { childList: true, subtree: true });
})();
<\/script>`;

// Reaction chips under each post (see renderReactionsHTML/getPostReactions).
const REACTION_SCRIPT = `<script>
var REACTION_QUICK_PICKS = ['👍','❤️','😂','😮','✅','❌','🎉','🔥','👀'];

function closeReactionPicker() {
    var existing = document.getElementById('reaction-picker-popover');
    if (existing) existing.remove();
    document.removeEventListener('click', reactionPickerOutsideClick, true);
}

function reactionPickerOutsideClick(e) {
    var popover = document.getElementById('reaction-picker-popover');
    if (popover && !popover.contains(e.target) && !e.target.closest('.reaction-add-btn')) {
        closeReactionPicker();
    }
}

function openReactionPicker(postId, btn) {
    var reopening = document.getElementById('reaction-picker-popover');
    var wasForSamePost = reopening && reopening.dataset.postId == String(postId);
    closeReactionPicker();
    if (wasForSamePost) return; // clicking the same "+" again just closes it

    var popover = document.createElement('div');
    popover.id = 'reaction-picker-popover';
    // Uses the dedicated --popover-bg/--popover-border theme variables
    // (defined per theme alongside --file-box-bg etc.) rather than the
    // page's .box class: .box has no background of its own, so a floating
    // overlay built from it let post content underneath show through
    // instead of being covered. --popover-bg is always a solid, opaque
    // color per theme, so it keeps the "floating card" look while still
    // matching each theme.
    popover.style.cssText = 'position:absolute;top:100%;left:0;margin-top:6px;z-index:500;padding:10px;width:220px;max-width:80vw;box-sizing:border-box;background:var(--popover-bg);border:1px solid var(--popover-border);border-radius: var(--popover-border-radius);color:var(--text-color);';
    popover.dataset.postId = postId;
    popover.innerHTML =
        '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">' +
        REACTION_QUICK_PICKS.map(function(e) {
            return '<button type="button" class="reaction-picker-emoji" data-emoji="' + e + '" style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0 !important;margin:0;box-sizing:border-box;border-radius:50%;border:1px solid var(--post-border-color);background:transparent;color:var(--text-color);cursor:pointer;font-size:1.1em;line-height:1;text-align:center;">' + e + '</button>';
        }).join('') +
        '</div>' +
        (typeof window.customEmojiPickerHTML === 'function' ? window.customEmojiPickerHTML('reaction-picker-emoji') : '') +
        '<div style="display:flex;gap:6px;">' +
        // No color/background/border here - the global input[type="text"]
        // rule (styles.css) already carries each theme's own input colors,
        // same as every other text input in this app.
        '<input type="text" maxlength="' + ${MAX_REACTION_EMOJI_LENGTH} + '" placeholder="or type it here" style="flex:1;min-width:0;height:30px !important;box-sizing:border-box !important;padding:0 6px !important;line-height:1;">' +
        // "button" reuses the site-wide themed button (bg/border/hover-invert
        // per theme). The base .button class never sets box-sizing, so it
        // defaults to content-box - its own height:20px + padding + border
        // renders at ~50px regardless of this override unless box-sizing is
        // forced to border-box here too (same trick .post-action-btn uses
        // elsewhere in this file).
        '<button type="button" class="button reaction-picker-add" style="width:auto;height:30px !important;box-sizing:border-box !important;padding:0 12px !important;line-height:1;">Add</button>' +
        '</div>';

    popover.querySelectorAll('.reaction-picker-emoji').forEach(function(el) {
        el.addEventListener('click', function() {
            toggleReactionValue(postId, el.getAttribute('data-emoji'));
            closeReactionPicker();
        });
    });
    var input = popover.querySelector('input');
    var submitCustom = function() {
        var val = input.value.trim();
        if (!val) return;
        toggleReactionValue(postId, val);
        closeReactionPicker();
    };
    popover.querySelector('.reaction-picker-add').addEventListener('click', submitCustom);
    input.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); submitCustom(); } });
    input.addEventListener('click', function(e) { e.stopPropagation(); });

    var container = document.getElementById('post-reactions-' + postId);
    (container || btn.parentElement).appendChild(popover);
    setTimeout(function() { document.addEventListener('click', reactionPickerOutsideClick, true); }, 0);
    input.focus();
}

function toggleReaction(postId, chipEl) {
    toggleReactionValue(postId, chipEl.getAttribute('data-emoji'));
}

function toggleReactionValue(postId, emoji) {
    if (!emoji) return;
    fetch('/post/' + postId + '/react', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji: emoji })
    }).then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })
      .then(function(res) {
        if (!res.ok) { alert('Error: ' + (res.data && res.data.error || 'failed to react')); return; }
        var container = document.getElementById('post-reactions-' + postId);
        if (container && res.data && res.data.html) container.outerHTML = res.data.html;
    }).catch(function() { alert('Network error.'); });
}
<\/script>`;

// Reaction chips on DM messages - same UX and swap-the-fragment pattern as REACTION_SCRIPT above.
const MSG_REACTION_SCRIPT = `<script>
function closeMsgReactionPicker() {
    var existing = document.getElementById('msg-reaction-picker-popover');
    if (existing) existing.remove();
    document.removeEventListener('click', msgReactionPickerOutsideClick, true);
}
function msgReactionPickerOutsideClick(e) {
    var popover = document.getElementById('msg-reaction-picker-popover');
    if (popover && !popover.contains(e.target) && !e.target.closest('.msg-react-link')) {
        closeMsgReactionPicker();
    }
}
function openMsgReactionPicker(msgId, btn) {
    var reopening = document.getElementById('msg-reaction-picker-popover');
    var wasForSame = reopening && reopening.dataset.msgId == String(msgId);
    closeMsgReactionPicker();
    if (wasForSame) return; // clicking React again on the same message just closes it

    var popover = document.createElement('div');
    popover.id = 'msg-reaction-picker-popover';
    popover.style.cssText = 'position:absolute;bottom:100%;right:0;margin-bottom:6px;z-index:500;padding:10px;width:220px;max-width:80vw;box-sizing:border-box;background:var(--popover-bg);border:1px solid var(--popover-border);border-radius:var(--popover-border-radius);color:var(--text-color);';
    popover.dataset.msgId = msgId;
    popover.innerHTML =
        '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">' +
        REACTION_QUICK_PICKS.map(function(e) {
            return '<button type="button" class="msg-reaction-picker-emoji" data-emoji="' + e + '" style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0 !important;margin:0;box-sizing:border-box;border-radius:50%;border:1px solid var(--post-border-color);background:transparent;color:var(--text-color);cursor:pointer;font-size:1.1em;line-height:1;text-align:center;">' + e + '</button>';
        }).join('') +
        '</div>' +
        (typeof window.customEmojiPickerHTML === 'function' ? window.customEmojiPickerHTML('msg-reaction-picker-emoji') : '') +
        '<div style="display:flex;gap:6px;">' +
        '<input type="text" maxlength="' + ${MAX_REACTION_EMOJI_LENGTH} + '" placeholder="or type it here" style="flex:1;min-width:0;height:30px !important;box-sizing:border-box !important;padding:0 6px !important;line-height:1;">' +
        '<button type="button" class="button msg-reaction-picker-add" style="width:auto;height:30px !important;box-sizing:border-box !important;padding:0 12px !important;line-height:1;">Add</button>' +
        '</div>';

    popover.querySelectorAll('.msg-reaction-picker-emoji').forEach(function(el) {
        el.addEventListener('click', function() {
            toggleMsgReactionValue(msgId, el.getAttribute('data-emoji'));
            closeMsgReactionPicker();
        });
    });
    var input = popover.querySelector('input');
    var submitCustom = function() {
        var val = input.value.trim();
        if (!val) return;
        toggleMsgReactionValue(msgId, val);
        closeMsgReactionPicker();
    };
    popover.querySelector('.msg-reaction-picker-add').addEventListener('click', submitCustom);
    input.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); submitCustom(); } });
    input.addEventListener('click', function(e) { e.stopPropagation(); });

    var container = document.getElementById('msg-reactions-' + msgId);
    (container || btn.parentElement).appendChild(popover);
    setTimeout(function() { document.addEventListener('click', msgReactionPickerOutsideClick, true); }, 0);
    input.focus();
}

function toggleMsgReaction(msgId, chipEl) {
    toggleMsgReactionValue(msgId, chipEl.getAttribute('data-emoji'));
}

function toggleMsgReactionValue(msgId, emoji) {
    if (!emoji) return;
    fetch(window.MSG_REACT_BASE + msgId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji: emoji })
    }).then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })
      .then(function(res) {
        if (!res.ok) { alert('Error: ' + (res.data && res.data.error || 'failed to react')); return; }
        var container = document.getElementById('msg-reactions-' + msgId);
        if (container && res.data && res.data.html) container.outerHTML = res.data.html;
    }).catch(function() { alert('Network error.'); });
}
<\/script>`;

// Attachment previews + drag & drop (feed/replies, DMs, group chats)
// Shared CSS + JS so the "pick files, see chips above the compose box, drag files in from anywhere
// on the page" behaviour.
const ATTACH_STYLE_BLOCK = `<style>
.attach-preview{display:none;flex-wrap:wrap;gap:8px;margin-bottom:6px;}
.attach-chip{position:relative;display:flex;align-items:center;gap:6px;background:rgba(127,127,127,0.15);border-radius:8px;padding:4px 10px 4px 4px;max-width:200px;}
.attach-chip.attach-chip-image{background:transparent;border:none;padding:0;max-width:128px;}
.attach-chip-thumb{width:128px;height:128px;max-width:128px;max-height:128px;object-fit:cover;border-radius:8px;flex-shrink:0;display:block;}
.attach-chip-icon{width:48px !important;height:48px !important;max-width:48px !important;max-height:48px !important;object-fit:contain !important;padding:6px;box-sizing:border-box;flex-shrink:0;background:rgba(127,127,127,0.25);border-radius:6px !important;}
.attach-chip-meta{min-width:0;}
.attach-chip-name{font-size:0.78em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px;}
.attach-chip-size{font-size:0.7em;opacity:0.6;}
.attach-chip-remove{position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;border:none;background:var(--danger-color,#e33);color:#fff;font-size:0.65em;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;}
.drag-over{outline:2px dashed var(--accent-color,#7c8fff);outline-offset:-2px;border-radius:8px;}
#dnd-overlay{display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.55);align-items:center;justify-content:center;pointer-events:none;}
#dnd-overlay div{border:3px dashed var(--accent-color,#7c8fff);border-radius:16px;padding:40px 60px;color:#fff;font-size:1.3em;font-weight:600;background:rgba(0,0,0,0.35);}
</style>`;

// inputId: the hidden <input type=file>. previewId: the chip strip above the compose box. maxFiles:
// server-side cap for that surface.
const ATTACH_JS_BLOCK = `
function biodeckAttachManager(inputId, previewId, maxFiles) {
    const input = document.getElementById(inputId);
    const preview = document.getElementById(previewId);
    let files = [];
    function fmtSize(b) {
        if (!b) return '0 B';
        const u = ['B','KB','MB','GB']; let i = 0; let n = b;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
    }
    // Mirrors the server-side fileIconFor() so the compose-time chip uses the
    // same pre-made /code.png, /text.png, /archive.png, /file.png icons that
    // already-posted "other file" attachments use, instead of emoji.
    const ICON_CODE_EXTS = ['.js','.mjs','.cjs','.ts','.tsx','.jsx','.c','.cpp','.cc','.cxx','.h','.hpp','.html','.htm','.css','.scss','.sass','.less','.java','.py','.rb','.go','.rs','.php','.sh','.bash','.json','.xml','.yml','.yaml','.sql','.swift','.kt','.cs','.lua','.pl'];
    const ICON_TEXT_EXTS = ['.txt','.md','.markdown','.log','.csv','.rtf','.ini','.conf','.cfg'];
    const ICON_ARCHIVE_EXTS = ['.zip','.rar','.7z','.tar','.gz','.bz2','.xz','.tgz','.tbz2'];
    function fileIconForClient(name) {
        const m = /\.[^.]+$/.exec(String(name || '').toLowerCase());
        const ext = m ? m[0] : '';
        if (ICON_CODE_EXTS.indexOf(ext) !== -1) return '/code.png';
        if (ICON_TEXT_EXTS.indexOf(ext) !== -1) return '/text.png';
        if (ICON_ARCHIVE_EXTS.indexOf(ext) !== -1) return '/archive.png';
        return '/file.png';
    }
    function sync() {
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));
        input.files = dt.files;
    }
    function render() {
        preview.innerHTML = '';
        preview.style.display = files.length ? 'flex' : 'none';
        files.forEach((file, idx) => {
            const chip = document.createElement('div');
            const isImage = file.type.startsWith('image/');
            chip.className = isImage ? 'attach-chip attach-chip-image' : 'attach-chip';
            if (isImage) {
                // Images: just the thumbnail, no filename/size clutter.
                const img = document.createElement('img');
                img.className = 'attach-chip-thumb';
                img.src = URL.createObjectURL(file);
                img.alt = file.name;
                chip.appendChild(img);
            } else {
                const icon = document.createElement('img');
                icon.className = 'attach-chip-icon';
                icon.src = fileIconForClient(file.name);
                icon.alt = '';
                icon.width = 24;
                icon.height = 24;
                chip.appendChild(icon);
                const meta = document.createElement('div');
                meta.className = 'attach-chip-meta';
                const nameEl = document.createElement('div');
                nameEl.className = 'attach-chip-name';
                nameEl.title = file.name;
                nameEl.textContent = file.name;
                const sizeEl = document.createElement('div');
                sizeEl.className = 'attach-chip-size';
                sizeEl.textContent = fmtSize(file.size);
                meta.appendChild(nameEl);
                meta.appendChild(sizeEl);
                chip.appendChild(meta);
            }
            const rm = document.createElement('button');
            rm.type = 'button';
            rm.className = 'attach-chip-remove';
            rm.textContent = '✕';
            rm.title = 'Remove';
            rm.onclick = function () { files.splice(idx, 1); sync(); render(); };
            chip.appendChild(rm);
            preview.appendChild(chip);
        });
    }
    function addFiles(list) {
        Array.from(list).forEach(f => {
            if (files.length >= maxFiles) return;
            if (!files.some(e => e.name === f.name && e.size === f.size && e.lastModified === f.lastModified)) files.push(f);
        });
        sync();
        render();
    }
    function clear() { files = []; sync(); render(); }
    input.addEventListener('change', function () { addFiles(input.files); });
    return { addFiles: addFiles, clear: clear, getFiles: function () { return files; } };
}
function biodeckWireDrop(dropZoneId, attachMgr) {
    const zone = document.getElementById(dropZoneId);
    const overlay = document.getElementById('dnd-overlay');
    let counter = 0;
    function hasFiles(e) { return e.dataTransfer && e.dataTransfer.types && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') !== -1; }
    window.addEventListener('dragenter', function (e) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        counter++;
        if (overlay) overlay.style.display = 'flex';
    });
    window.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', function (e) {
        if (!hasFiles(e)) return;
        counter = Math.max(0, counter - 1);
        if (counter === 0 && overlay) overlay.style.display = 'none';
    });
    window.addEventListener('drop', function (e) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        counter = 0;
        if (overlay) overlay.style.display = 'none';
        if (e.dataTransfer.files && e.dataTransfer.files.length) attachMgr.addFiles(e.dataTransfer.files);
    });
    if (zone) {
        zone.addEventListener('dragover', function (e) { if (hasFiles(e)) zone.classList.add('drag-over'); });
        zone.addEventListener('dragleave', function () { zone.classList.remove('drag-over'); });
        zone.addEventListener('drop', function () { zone.classList.remove('drag-over'); });
    }
}
`;

// Server-push ban enforcement.
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
            var expiryLine = d.expiresAt
                ? ('<h3>Ban Expires: ' + new Date(d.expiresAt).toLocaleString() + '</h3><br><br>')
                : '';
            inner = '<h1>The ban hammer has struck you</h1><br>'
                + '<h3>Ban Reason: ' + reason + '</h3><br><br>'
                + expiryLine
                + '<button type=\\"button\\" class=\\"button\\" style=\\"width:150px\\" onclick=\\"window.location.href=\\'/\\'\\">Go to homepage</button>';
        }
        document.body.innerHTML = '';
        document.body.style = '';
        var box = document.createElement('div');
        box.className = 'box';
        box.style.cssText = 'color:var(--text-color);height:auto;width:500px;max-width:90vw;word-break:break-word;overflow-wrap:break-word;box-sizing:border-box;';
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

module.exports = {
    ATTACH_JS_BLOCK,
    ATTACH_STYLE_BLOCK,
    EMOJI_SCRIPT,
    MSG_REACTION_SCRIPT,
    NOTIF_BADGE_SCRIPT,
    REACTION_SCRIPT,
    REPORT_SCRIPT,
    SOUND_SCRIPT,
    USER_EVENTS_SCRIPT,
};
