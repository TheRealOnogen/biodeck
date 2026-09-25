// for all who enter here
// this code holds up with hopes and dreams
// even AI doesn't fully understand it
// if you decide to edit this and spend time suffering
// please leave your name below

// Onogen

require('dotenv').config({ path: 'vars.env' });
const express = require('express');
const Database = require('better-sqlite3');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const bcrypt = require('bcrypt');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
let nodemailer;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }
let ImapClient;
try { ImapClient = require('imap'); } catch (e) { ImapClient = null; }
let simpleParser;
try { ({ simpleParser } = require('mailparser')); } catch (e) { simpleParser = null; }
const app = express();
const PORT = 3000;

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ----- CSS theme switcher -----
// Themes are declared in themes.json (project root) as an array of
// { name, displayName, file } objects. `name` is the stable id stored on the
// user's account, `displayName` is what's shown in the dashboard picker, and
// `file` is a path to the stylesheet relative to public/. themes.json is
// re-read whenever it changes on disk (checked via mtime) so an admin can
// add/edit themes without restarting the server.
const THEMES_FILE = path.join(__dirname, 'themes.json');
const FALLBACK_THEME = { name: 'default', displayName: 'Default', file: 'styles.css' };
let themesCache = null;
let themesCacheMtimeMs = 0;

function loadThemes() {
    try {
        const stat = fs.statSync(THEMES_FILE);
        if (themesCache && stat.mtimeMs === themesCacheMtimeMs) return themesCache;
        const parsed = JSON.parse(fs.readFileSync(THEMES_FILE, 'utf8'));
        if (!Array.isArray(parsed)) throw new Error('themes.json must contain a JSON array');
        const clean = parsed.filter(t => t && typeof t.name === 'string' && t.name.trim()
            && typeof t.displayName === 'string' && t.displayName.trim()
            && typeof t.file === 'string' && t.file.trim());
        if (!clean.some(t => t.name === 'default')) clean.unshift(FALLBACK_THEME);
        themesCache = clean;
        themesCacheMtimeMs = stat.mtimeMs;
        return clean;
    } catch (e) {
        console.error('Failed to load themes.json, falling back to the default theme only:', e.message);
        return [FALLBACK_THEME];
    }
}

function getThemeByName(name) {
    const themes = loadThemes();
    return themes.find(t => t.name === name)
        || themes.find(t => t.name === 'default')
        || themes[0]
        || FALLBACK_THEME;
}

// Resolves a theme's `file` to an absolute path inside public/, refusing to
// serve anything outside that directory (themes.json is admin-edited, but
// this keeps a typo or bad entry from turning into a path traversal bug).
function resolveThemeCSSPath(theme) {
    const publicDir = path.join(__dirname, 'public');
    const resolved = path.resolve(publicDir, theme.file);
    if (resolved !== publicDir && !resolved.startsWith(publicDir + path.sep)) {
        return path.join(publicDir, FALLBACK_THEME.file);
    }
    return resolved;
}

// file.originalname is fully attacker-controlled (it's just whatever the
// client's multipart request claims). Using it directly in a filename let a
// crafted name like "../../../public/pwned.html" or "../../server.js"
// escape uploadsDir via path.join and write/overwrite arbitrary files on
// disk - a critical path-traversal -> arbitrary file write bug. This keeps
// only a sanitized basename/extension and adds random bytes so names can't
// be predicted or used to overwrite another user's upload.
function safeUploadFilename(originalname) {
    const base = path.basename(String(originalname || 'file'));
    let ext = path.extname(base).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12);
    const stem = base.slice(0, base.length - path.extname(base).length)
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 60) || 'file';
    return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${stem}${ext}`;
}

// No extension filter on attachments by design - any file type is allowed,
// same as Discord etc. (Discord mitigates the same-origin script risk by
// serving attachments from a separate CDN domain with no session cookie;
// this app serves uploads from its own origin, so a directly-opened
// uploaded HTML/SVG file can still run script in that visitor's session -
// worth knowing if this ever needs hardening later, e.g. by moving
// /uploads to a separate subdomain.)

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!req.session || !req.session.userId) return cb(new Error('Unauthorized'));
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => cb(null, safeUploadFilename(file.originalname))
});
const MAX_FILE_SIZE = 90 * 1024 * 1024;
const MAX_MSG_LENGTH = 4000;
const MAX_POST_LENGTH = 1000;
const MAX_BIO_LENGTH = 1000;

const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

// Multi-file upload limits: 5 attachments per post (feed/replies/following-feed),
// 10 per DM, 10 per group chat message. multer's limits.files enforces this
// server-side regardless of what the client sends.
const MAX_FILES_FEED = 5;
const MAX_FILES_DM = 10;
const MAX_FILES_GC = 10;
const makeMultiUpload = maxFiles => multer({ storage, limits: { fileSize: MAX_FILE_SIZE, files: maxFiles } });
const uploadFeed = makeMultiUpload(MAX_FILES_FEED);
const uploadDM = makeMultiUpload(MAX_FILES_DM);
const uploadGC = makeMultiUpload(MAX_FILES_GC);

const MSG_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];

const MAX_AVATAR_SIZE = 8 * 1024 * 1024;

// keyFn: own session id for a normal avatar change, target username for an admin one.
function makeAvatarUpload(keyFn) {
    const storage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadsDir),
        filename: (req, file, cb) => cb(null, `avatar-${keyFn(req)}-${Date.now()}${path.extname(file.originalname).toLowerCase()}`)
    });
    return multer({
        storage,
        limits: { fileSize: MAX_AVATAR_SIZE },
        fileFilter: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            if (MSG_IMAGE_EXTS.includes(ext)) cb(null, true);
            else cb(new Error('Only image files are allowed for profile pictures'));
        }
    });
}
const avatarUpload = makeAvatarUpload(req => req.session.userId);
const adminAvatarUpload = makeAvatarUpload(req => req.params.username);
const MSG_VIDEO_MIME_TYPES = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.ogv': 'video/ogg',
    '.ogg': 'video/ogg',
    '.mov': 'video/quicktime'
};

const MSG_AUDIO_MIME_TYPES = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.m4a': 'audio/mp4',
    '.opus': 'audio/opus',
    '.oga': 'audio/ogg'
};

// ----- Live messaging (Server-Sent Events) -----
// Real-time push for DMs and group chats. No polling, no extra deps -
// just a couple of in-process EventEmitters that fan out to open SSE streams.
const { EventEmitter } = require('events');
const dmBus = new EventEmitter();
dmBus.setMaxListeners(0);
const gcBus = new EventEmitter();
gcBus.setMaxListeners(0);
// Per-user event bus for real-time server-push notifications (e.g. ban events).
// Keyed by userId so the server can push to a specific user without any client polling.
const userBus = new EventEmitter();
userBus.setMaxListeners(0);
// Tracks currently-open /api/user-events/stream connections along with the
// IP they connected from, so an IP ban can be pushed only to sessions
// actually on that IP - not broadcast to every connected user.
const userEventConnections = new Set();

function sseSend(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Each viewer subscribes to their own "me::other" channel so we can render
// the message bubble from their point of view (alignment, delete link, etc)
// without leaking another user's perspective.
function broadcastDMMessage(fromUser, toUser, row, replyMsg) {
    dmBus.emit(`${fromUser}::${toUser}`, { event: 'message', html: renderMessageBubble(row, fromUser, replyMsg), id: row.id });
    dmBus.emit(`${toUser}::${fromUser}`, { event: 'message', html: renderMessageBubble(row, toUser, replyMsg), id: row.id });
}
function broadcastDMDelete(fromUser, toUser, msgId) {
    dmBus.emit(`${fromUser}::${toUser}`, { event: 'delete', id: msgId });
    dmBus.emit(`${toUser}::${fromUser}`, { event: 'delete', id: msgId });
}
function broadcastDMEdit(fromUser, toUser, row, replyMsg) {
    dmBus.emit(`${fromUser}::${toUser}`, { event: 'edit', html: renderMessageBubble(row, fromUser, replyMsg), id: row.id });
    dmBus.emit(`${toUser}::${fromUser}`, { event: 'edit', html: renderMessageBubble(row, toUser, replyMsg), id: row.id });
}

function broadcastGCMessage(groupId, fromUser, row, replyMsg, memberUsernames) {
    const htmlForSender = renderGCMessageBubble(row, fromUser, replyMsg);
    const htmlForOthers = renderGCMessageBubble(row, `\u0000${fromUser}`, replyMsg); // sentinel "me" that never matches a real username
    gcBus.emit(`${groupId}::${fromUser}`, { event: 'message', html: htmlForSender, id: row.id });
    memberUsernames.filter(u => u !== fromUser).forEach(u => {
        gcBus.emit(`${groupId}::${u}`, { event: 'message', html: htmlForOthers, id: row.id });
    });
}
function broadcastGCDelete(groupId, msgId, memberUsernames) {
    memberUsernames.forEach(u => {
        gcBus.emit(`${groupId}::${u}`, { event: 'delete', id: msgId });
    });
}
function broadcastGCEdit(groupId, fromUser, row, replyMsg, memberUsernames) {
    const htmlForSender = renderGCMessageBubble(row, fromUser, replyMsg);
    const htmlForOthers = renderGCMessageBubble(row, `\u0000${fromUser}`, replyMsg); // sentinel "me" that never matches a real username
    gcBus.emit(`${groupId}::${fromUser}`, { event: 'edit', html: htmlForSender, id: row.id });
    memberUsernames.filter(u => u !== fromUser).forEach(u => {
        gcBus.emit(`${groupId}::${u}`, { event: 'edit', html: htmlForOthers, id: row.id });
    });
}

// Posts a "so-and-so joined/left" notice as a message from the reserved
// 'System' sender (same convention as the Activations gate notices) and
// pushes it live to every current member of the group over SSE.
function postSystemGCMessage(groupId, content) {
    db.run(`INSERT INTO Group_Chat_Messages (group_id, from_user, content) VALUES (?, 'System', ?)`,
        [groupId, content], function (err) {
            if (err) { console.error('System GC message insert error:', err.message); return; }
            const msgId = this.lastID;
            db.get(`SELECT Group_Chat_Messages.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified FROM Group_Chat_Messages LEFT JOIN User_Data ON Group_Chat_Messages.from_user = User_Data.username WHERE Group_Chat_Messages.id = ?`, [msgId], (errRow, row) => {
                if (errRow || !row) return;
                db.all(`SELECT username FROM Group_Chat_Members WHERE group_id = ?`, [groupId], (errMem, memberRows) => {
                    const members = (memberRows || []).map(r => r.username);
                    broadcastGCMessage(groupId, 'System', row, null, members);
                });
            });
        });
}


const NOTIF_BADGE_SCRIPT = `<script>
(function() {
    function updateNotifBadges() {
        fetch('/notifications/count', { cache: 'no-store' })
            .then(function(r) { return r.json(); })
            .then(function(d) {
                var count = (d && d.count) || 0;
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
    setInterval(updateNotifBadges, 8000);
})();
<\/script>`;

// Shared "Report" button handler for feed posts, DMs, and group chat messages
// (see reportContent onclick handlers in renderFeedPost/renderMessageBubble/
// renderGCMessageBubble). Included on every logged-in page alongside
// NOTIF_BADGE_SCRIPT/USER_EVENTS_SCRIPT.
//
// Reported state is locked in two ways so the button can't be spammed:
//  1. Client-side: dataset.reported is set the instant the button is
//     clicked (not after the response comes back), so rapid double-clicks
//     while the request is in flight can't fire a second request.
//  2. Server-side (authoritative, survives reloads/new sessions/devices):
//     /report itself rejects a second report of the same content with 409
//     alreadyReported, and applyReportedState() below calls /api/my-reports
//     on load (and whenever new content is added to the page) to pre-mark
//     any "Report" button/link for content this user already reported.
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
function applyReportedState() {
    fetch('/api/my-reports').then(function(r) { return r.ok ? r.json() : null; }).then(function(data) {
        if (!data || !data.reports) return;
        data.reports.forEach(function(r) {
            document.querySelectorAll('.report-action[data-report-type="' + r.type + '"][data-report-id="' + r.id + '"]').forEach(function(btn) {
                if (btn.dataset.reported === '1') return; // already applied - skip so we don't churn the DOM forever
                btn.dataset.reported = '1';
                btn.disabled = true;
                btn.style.opacity = '0.5';
                btn.textContent = 'Reported';
            });
        });
    }).catch(function() {});
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
        reportStateDebounce = setTimeout(applyReportedState, 150);
    }).observe(document.documentElement, { childList: true, subtree: true });
})();
<\/script>`;

// ----- Attachment previews + drag & drop (feed/replies, DMs, group chats) -----
// Shared CSS + JS so the "pick files, see chips above the compose box, drag
// files in from anywhere on the page" behaviour (Discord-style) only has to
// be written once and is included via ${ATTACH_STYLE_BLOCK} / ${ATTACH_JS_BLOCK}
// in each compose page below.
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

// inputId: the hidden <input type=file>. previewId: the chip strip above the
// compose box. maxFiles: server-side cap for that surface (5 feed / 10 DM /
// 10 group chat), just used client-side to stop adding past the limit early.
// Keeps input.files in sync via DataTransfer so the existing FormData(form)
// submit code elsewhere on each page needs no changes.
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

// Server-push ban enforcement. The server emits a 'banned' event down this SSE
// stream when an admin bans the user - no polling, nothing the client can fake.
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

function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

// Nicknames are display-only - pings, profile URLs, and logins always use
// the username. This just picks what to show: the nickname if set, else the
// username.
const MAX_NICKNAME_LENGTH = 32;
function displayName(username, nickname) {
    return (nickname && nickname.trim()) ? nickname.trim() : username;
}

// Small blue checkmark badge shown right next to a username, wherever a
// username is displayed (profile, feed, messages, notifications, admin
// panel, etc). Purely presentational - just pass a truthy/falsy
// IsVerified value in, no escaping needed since it emits fixed markup.
function renderVerifiedBadge(isVerified) {
    if (!isVerified) return '';
    return `<svg viewBox="0 0 22 22" width="15" height="15" style="display:inline-block;vertical-align:middle;flex-shrink:0;margin-left:3px;" aria-label="Verified account" role="img"><title>Verified account</title><circle cx="11" cy="11" r="11" fill="var(--accent-color, #1d9bf0)"></circle><path d="M6.3 11.3l3.1 3.1 6.3-6.7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
}

// Renders "Nickname" with a smaller "@username" next to it when a nickname is
// set, or just "@username" when it isn't. `username` is used verbatim as the
// link target/handle (already expected to be a safe identifier); `nickname`
// is escaped since it's free-form user text. Pass `opts.isVerified` to show
// the checkmark badge right after the displayed name.
function renderNameWithHandle(username, nickname, opts = {}) {
    const safeUsername = escapeHTML(username);
    const badge = renderVerifiedBadge(opts.isVerified);
    const hasNickname = nickname && nickname.trim();
    if (!hasNickname) {
        return `<span style="${opts.nameStyle || ''}">@${safeUsername}${badge}</span>`;
    }
    const safeNickname = escapeHTML(nickname.trim());
    return `<span style="${opts.nameStyle || ''}">${safeNickname}${badge}</span><span style="opacity:0.5;font-size:0.85em;margin-left:5px;${opts.handleStyle || ''}">@${safeUsername}</span>`;
}

function renderEmbeds(text) {
    if (!text) return { embedHTML: '', cleanText: text };
    const urlRegex = /https?:\/\/[^\s<>"]+/g;
    const urls = text.match(urlRegex) || [];
    const embeds = [];
    const usedUrls = new Set();

    for (const url of urls) {
        if (usedUrls.has(url)) continue;

        const ytMatch = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
        if (ytMatch) {
            usedUrls.add(url);
            embeds.push(`<div style="margin-top:8px;"><iframe width="320" height="180" src="https://www.youtube.com/embed/${ytMatch[1]}" frameborder="0" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen style="border-radius:8px;max-width:100%;"></iframe></div>`);
            continue;
        }

        const spMatch = url.match(/open\.spotify\.com\/(track|album|playlist|episode|show)\/([A-Za-z0-9]+)/);
        if (spMatch) {
            usedUrls.add(url);
            embeds.push(`<div style="margin-top:8px;"><iframe src="https://open.spotify.com/embed/${spMatch[1]}/${spMatch[2]}" width="320" height="80" frameborder="0" allow="autoplay;clipboard-write;encrypted-media;fullscreen;picture-in-picture" loading="lazy" style="border-radius:12px;max-width:100%;"></iframe></div>`);
            continue;
        }

        if (/soundcloud\.com\/[^/]+\/[^/\s]+/.test(url)) {
            usedUrls.add(url);
            const encoded = encodeURIComponent(url);
            embeds.push(`<div style="margin-top:8px;"><iframe width="320" height="80" scrolling="no" frameborder="no" src="https://w.soundcloud.com/player/?url=${encoded}&color=%2300bfff&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false" style="border-radius:8px;max-width:100%;"></iframe></div>`);
            continue;
        }

        const imgurMatch = url.match(/imgur\.com\/(?:a\/|gallery\/)?([A-Za-z0-9]+)(?:\.[a-z]+)?$/i);
        if (imgurMatch) {
            usedUrls.add(url);
            if (/\.(jpg|jpeg|png|gif|webp|mp4|gifv)$/i.test(url)) {
                const imgUrl = url.replace(/\.gifv$/i, '.mp4');
                if (/\.mp4$/i.test(imgUrl)) {
                    embeds.push(`<div style="margin-top:8px;"><video autoplay loop muted playsinline style="max-width:320px;max-height:320px;border-radius:8px;display:block;"><source src="${imgUrl}" type="video/mp4"></video></div>`);
                } else {
                    embeds.push(`<div style="margin-top:8px;"><img src="${imgUrl}" style="max-width:320px;max-height:320px;border-radius:8px;display:block;" loading="lazy"></div>`);
                }
            } else {
                embeds.push(`<div style="margin-top:8px;"><blockquote class="imgur-embed-pub" lang="en" data-id="${imgurMatch[1]}" data-context="false"><a href="${escapeHTML(url)}">View on Imgur</a></blockquote><script async src="//s.imgur.com/min/embed.js" charset="utf-8"><\/script></div>`);
            }
            continue;
        }

        if (/\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i.test(url)) {
            usedUrls.add(url);
            embeds.push(`<div style="margin-top:8px;"><img src="${escapeHTML(url)}" style="max-width:320px;max-height:320px;border-radius:8px;display:block;" loading="lazy" onerror="this.parentElement.remove()"></div>`);
            continue;
        }

        if (/\.(mp4|webm|ogg|ogv|mov)(\?.*)?$/i.test(url)) {
            usedUrls.add(url);
            embeds.push(`<div style="margin-top:8px;"><video controls preload="metadata" style="max-width:320px;max-height:240px;border-radius:8px;display:block;background:black;"><source src="${escapeHTML(url)}">Your browser can't play this video. <a href="${escapeHTML(url)}" target="_blank" style="color:var(--accent-color);">Download</a></video></div>`);
            continue;
        }

        if (/\.(mp3|wav|flac|aac|m4a|opus|oga)(\?.*)?$/i.test(url)) {
            usedUrls.add(url);
            embeds.push(`<div style="margin-top:8px;"><audio controls preload="metadata" style="width:280px;max-width:100%;border-radius:8px;display:block;"><source src="${escapeHTML(url)}">Your browser can't play this audio. <a href="${escapeHTML(url)}" target="_blank" style="color:var(--accent-color);">Download</a></audio></div>`);
            continue;
        }
    }

    let cleanText = text;
    for (const u of usedUrls) {
        cleanText = cleanText.split(u).join('');
    }
    cleanText = cleanText.trim();

    return { embedHTML: embeds.join(''), cleanText };
}

function avatarPathToURL(avatarPath) {
    // Avatars uploaded by users live under public/uploads, but some avatars
    // (e.g. the default placeholder) live directly under public/ and are
    // served at the root, so they need different URL handling.
    const normalized = avatarPath.replace(/\\/g, '/');
    if (normalized.startsWith('public/')) {
        return `/${normalized.slice('public/'.length)}`;
    }
    return `/uploads/${path.basename(avatarPath)}`;
}

function renderAvatarHTML(avatarPath, username, size) {
    const initial = escapeHTML((username || '?').charAt(0).toUpperCase());
    if (avatarPath) {
        const url = avatarPathToURL(avatarPath);
        return `<img src="${url}" alt="${escapeHTML(username)}" style="width:${size}px;height:${size}px;min-width:${size}px;border-radius:50%;object-fit:cover;display:block;border:1px solid rgba(255,255,255,0.2);">`;
    }
    return `<div style="width:${size}px;height:${size}px;min-width:${size}px;border-radius:50%;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.2);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:${Math.round(size * 0.45)}px;">${initial}</div>`;
}

// Renders just the avatar (+ username heading) shown above the ban/delete
// notice message on those screens.
function renderAvatarBlockHTML(avatarPath, username) {
    return `<div style="display:flex;justify-content:center;margin-bottom:10px;">
            ${renderAvatarHTML(avatarPath, username || '?', 84)}
        </div>
        ${username ? `<h2 style="margin:0 0 14px;">@${escapeHTML(username)}</h2>` : ''}`;
}

// Renders the "Account Standing" block shown below the ban/delete message
// and reason, mirroring the /standing page but with the standing forced to
// "Banned"/"Deleted" instead of a warning-count-based level, since a banned
// or deleted account's standing isn't meaningfully "All good"/"At risk"/etc.
// anymore.
function renderStandingBlockHTML(status) {
    const color = status === 'Deleted' ? 'var(--gray-color)' : 'var(--danger-color)';
    return `<div style="margin:18px 0;">
        <div style="opacity:0.6;font-size:0.85em;margin-bottom:4px;">Account Standing</div>
        <div style="font-size:1.3em;color:${color};font-weight:700;">${status}</div>
    </div>`;
}

// Renders the same warnings table used on the /standing page, so the
// ban/delete notice screens can show a user's warning history too.
function renderWarningsTableHTML(warnings) {
    warnings = warnings || [];
    const rows = warnings.map(w => {
        const active = isWarningActive(w);
        const statusHtml = active ? '<span style="color:var(--danger-color);font-weight:700;">Active</span>' : '<span style="opacity:0.5;">Expired</span>';
        const extrasHtml = getWarningExtras(w, 'html').join('');
        return `<tr>
            <td style="font-size:0.85em; word-break: break-word; overflow-wrap: break-word">${escapeHTML(w.reason || '')}${extrasHtml ? `<div style="font-size:0.85em;margin-top:6px;">${extrasHtml}</div>` : ''}</td>
            <td style="font-size:0.78em;opacity:0.6;white-space:nowrap;">${escapeHTML(new Date(w.created_at.replace(' ','T')+'Z').toLocaleString())}</td>
            <td style="font-size:0.78em;opacity:0.6;white-space:nowrap;">${w.expires_at ? escapeHTML(new Date(w.expires_at).toLocaleString()) : 'Never'}</td>
            <td>${statusHtml}</td>
        </tr>`;
    }).join('');
    return `<div style="text-align:left;">
        <div style="opacity:0.6;font-size:0.85em;margin-bottom:8px;text-align:center;">Warnings</div>
        ${warnings.length ? `
        <style>
            .table-scroll-wrap { display:block !important; width:100% !important; max-width:100% !important; overflow-x:auto !important; -webkit-overflow-scrolling:touch; }
            .table-scroll-wrap > table { width:max-content !important; min-width:100% !important; }
        </style>
        <div class="table-scroll-wrap">
        <table>
            <thead><tr><th>Reason</th><th>Issued</th><th>Expires</th><th>Status</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
        </div>` : `<p style="opacity:0.4;font-size:0.8em;margin:0;text-align:center;">No warnings on record.</p>`}
    </div>`;
}

// Lighter-weight version of renderWarningsTableHTML for the /standing page -
// each reason links out to its own /standing/:id detail page (styled like
// the admin support ticket / report pages) instead of showing the mute /
// removed-content extras inline, so the overview table stays scannable and
// the detail lives one click away.
function renderWarningsSummaryHTML(warnings) {
    warnings = warnings || [];
    const rows = warnings.map(w => {
        const active = isWarningActive(w);
        const statusHtml = active ? '<span style="color:var(--danger-color);font-weight:700;">Active</span>' : '<span style="opacity:0.5;">Expired</span>';
        return `<tr>
            <td style="font-size:0.85em; word-break: break-word; overflow-wrap: break-word"><a href="/standing/${w.id}" style="color:var(--text-color);text-decoration:underline;">${escapeHTML(w.reason || '(no reason given)')}</a></td>
            <td style="font-size:0.78em;opacity:0.6;white-space:nowrap;">${escapeHTML(new Date(w.created_at.replace(' ','T')+'Z').toLocaleString())}</td>
            <td style="font-size:0.78em;opacity:0.6;white-space:nowrap;">${w.expires_at ? escapeHTML(new Date(w.expires_at).toLocaleString()) : 'Never'}</td>
            <td>${statusHtml}</td>
        </tr>`;
    }).join('');
    return `<div style="text-align:left;">
        <div style="opacity:0.6;font-size:0.85em;margin-bottom:8px;text-align:center;">Warnings <span style="opacity:0.7;">(click a reason for details)</span></div>
        ${warnings.length ? `
        <style>
            .table-scroll-wrap { display:block !important; width:100% !important; max-width:100% !important; overflow-x:auto !important; -webkit-overflow-scrolling:touch; }
            .table-scroll-wrap > table { width:max-content !important; min-width:100% !important; }
        </style>
        <div class="table-scroll-wrap">
        <table>
            <thead><tr><th>Reason</th><th>Issued</th><th>Expires</th><th>Status</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
        </div>` : `<p style="opacity:0.4;font-size:0.8em;margin:0;text-align:center;">No warnings on record.</p>`}
    </div>`;
}

function renderMessageBubble(m, me, replyMsg) {
    const mine = m.from_user === me;
    const fileHTML = renderAttachmentsHTML(getAttachments(m), 260, '260px');
    const { embedHTML, cleanText } = renderEmbeds(m.content || '');
    const avatarHTML = renderAvatarHTML(m.avatar_path, m.from_user, 28);
    const senderHeader = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                <a href="/user/${escapeHTML(m.from_user)}" style="flex-shrink:0;">${avatarHTML}</a>
                <a href="/user/${escapeHTML(m.from_user)}" class="msg-sender-name" style="text-decoration:none;font-weight:bold;font-size:0.8em;">${renderNameWithHandle(m.from_user, m.Nickname, { isVerified: m.IsVerified })}</a>
            </div>`;
    const replyBanner = replyMsg
        ? `<div class="msg-reply-banner" style="font-size:0.78em;opacity:0.6;padding-left:8px;margin-bottom:4px;">> replying to <strong>${escapeHTML(replyMsg.from_user)}</strong>: ${escapeHTML((replyMsg.content || '').substring(0,60))}${(replyMsg.content || '').length > 60 ? '...' : ''}</div>`
        : '';
    const editLink = mine ? `<a href="#" onclick="editMessage(${m.id});return false;" class="msg-edit-link" style="text-decoration:none;">Edit</a>` : '';
    const deleteLink = mine ? `<a href="#" onclick="deleteMessage(${m.id});return false;" class="msg-delete-link" style="text-decoration:none;">Delete</a>` : '';
    const reportLink = !mine ? `<a href="#" onclick="reportContent('dm', ${m.id}, this);return false;" class="msg-delete-link report-action" data-report-type="dm" data-report-id="${m.id}" style="text-decoration:none;">Report</a>` : '';
    const editedMarker = m.edited ? `<span style="opacity:0.7;">(edited)</span>` : '';
    return `<div class="chat-msg-row" data-id="${m.id}" style="display:flex;justify-content:${mine ? 'flex-end' : 'flex-start'};margin-bottom:10px;">
        <div class="${mine ? 'msg-bubble-mine' : 'msg-bubble-other'}" style="max-width:70%;border-radius:12px;padding:8px 12px;">
            ${senderHeader}
            ${replyBanner}
            <div class="post-content" id="msg-content-${m.id}" data-raw="${escapeHTML(m.content || '')}">${renderMarkdown(cleanText)}</div>
            ${embedHTML}
            ${fileHTML}
            <div style="font-size:0.7em;opacity:0.5;margin-top:4px;display:flex;justify-content:flex-end;align-items:center;gap:10px;">
                <a href="#" onclick="setReply(${m.id}, '${escapeHTML(m.from_user)}');return false;" class="msg-reply-link" style="text-decoration:none;">Reply</a>
                ${editLink}
                ${deleteLink}
                ${reportLink}
                ${editedMarker}
                <span data-ts="${m.created_at.replace(' ','T')+'Z'}"></span>
            </div>
        </div>
    </div>`;
}

// Uploaded files live on disk under a randomized, sanitized name (see
// safeUploadFilename) so two uploads never collide and a crafted name can't
// escape uploadsDir - but that means the raw /uploads/<file> URL is also
// what a browser offers as the filename if someone saves it, and clicking
// it just opens/plays the file inline instead of downloading. This route
// forces a download and restores the original filename the uploader saw,
// using the name recorded alongside the attachment in the DB (passed
// through as ?name=).
app.get('/uploads/download/:filename', (req, res) => serveUpload(req, res, true));

// ----- Private attachment access control (DMs + group chats) -----
//
// Every file lives in one flat folder, so by default anyone who has (or
// guesses) a /uploads/<file> URL could fetch it - including attachments from
// DMs and group chats they were never part of. Private_Uploads records, at
// send time, which conversation each DM/GC attachment belongs to (it's a
// separate table rather than a lookup on Messages/Group_Chat_Messages so the
// restriction survives the message being deleted - files are never removed
// from disk). serveUpload() below checks it on every request:
//   - filename not in Private_Uploads -> feed attachment / avatar, served
//     exactly as before (no session needed, so avatars stay cheap)
//   - filename in Private_Uploads     -> must be logged in AND be one of the
//     two DM participants / a current member of that group chat
// The one exception is moderation: the user a warning was issued to can
// still see the content removed from them, and admins can see attachments
// that appear in a report or warning (otherwise the admin report view would
// break for anything reported out of a DM/GC). Admins can NOT browse
// arbitrary private attachments.
// Denied requests get a plain 404, same as a missing file.

// Called from the DM/GC send routes once the message has passed validation.
function recordPrivateUploads(files, info) {
    (files || []).forEach(f => {
        const filename = f.filename || path.basename(String(f.path || '').replace(/\\/g, '/'));
        if (!filename) return;
        db.run(`INSERT OR IGNORE INTO Private_Uploads (filename, scope, user_a, user_b, group_id) VALUES (?, ?, ?, ?, ?)`,
            [filename, info.scope, info.userA || null, info.userB || null, info.groupId || null],
            (err) => { if (err) console.error('Private upload record error:', err.message); });
    });
}

// Fills Private_Uploads for attachments sent before this table existed.
// Idempotent (INSERT OR IGNORE), runs on every boot right after the table is
// created. Attachments from messages that were already deleted before this
// was added can't be recovered and stay unrestricted (they're unlinked from
// any conversation and have unguessable names).
function backfillPrivateUploads() {
    const add = (row, scope, a, b, gid) => {
        getAttachments(row).forEach(f => {
            const filename = path.basename(String(f.path || '').replace(/\\/g, '/'));
            if (!filename) return;
            db.run(`INSERT OR IGNORE INTO Private_Uploads (filename, scope, user_a, user_b, group_id) VALUES (?, ?, ?, ?, ?)`,
                [filename, scope, a, b, gid], () => {});
        });
    };
    db.all(`SELECT from_user, to_user, file_path, files_json FROM Messages WHERE file_path IS NOT NULL OR files_json IS NOT NULL`, [], (err, rows) => {
        if (err) return console.error('Private upload backfill (DMs) error:', err.message);
        (rows || []).forEach(r => add(r, 'dm', r.from_user, r.to_user, null));
    });
    db.all(`SELECT group_id, file_path, files_json FROM Group_Chat_Messages WHERE file_path IS NOT NULL OR files_json IS NOT NULL`, [], (err, rows) => {
        if (err) return console.error('Private upload backfill (GCs) error:', err.message);
        (rows || []).forEach(r => add(r, 'gc', null, null, r.group_id));
    });
}

// Moderation exception, see the comment block above.
function moderationMayViewUpload(req, filename, cb) {
    const like = '%' + filename.replace(/[\\%_]/g, '\\$&') + '%';
    db.get(`SELECT id FROM Warnings WHERE username = ? AND removed_attachments_json LIKE ? ESCAPE '\\' LIMIT 1`,
        [req.session.userUsername, like], (e1, ownWarning) => {
        if (!e1 && ownWarning) return cb(true);
        db.get(`SELECT IsAdmin, IsOwner, IsHeadAdmin FROM User_Data WHERE id = ?`, [req.session.userId], (e2, u) => {
            if (e2 || !u || !(u.IsAdmin || u.IsOwner || u.IsHeadAdmin)) return cb(false);
            db.get(`SELECT id FROM Reports WHERE attachments_json LIKE ? ESCAPE '\\' LIMIT 1`, [like], (e3, report) => {
                if (!e3 && report) return cb(true);
                db.get(`SELECT id FROM Warnings WHERE removed_attachments_json LIKE ? ESCAPE '\\' LIMIT 1`, [like], (e4, warning) => cb(!e4 && !!warning));
            });
        });
    });
}

function userMayViewPrivateUpload(req, row, filename, cb) {
    const me = req.session && req.session.userUsername;
    if (!req.session || !req.session.userId || !me) return cb(false);
    const orModerator = (ok) => ok ? cb(true) : moderationMayViewUpload(req, filename, cb);
    if (row.scope === 'dm') return orModerator(me === row.user_a || me === row.user_b);
    if (row.scope === 'gc') {
        return db.get(`SELECT id FROM Group_Chat_Members WHERE group_id = ? AND username = ?`, [row.group_id, me],
            (err, member) => orModerator(!err && !!member));
    }
    cb(false);
}

// Serves /uploads/:filename (inline-capable embed) and
// /uploads/download/:filename (forced download with the original name).
// Both go through here so neither can be used to bypass the check.
function serveUpload(req, res, asDownload) {
    const filename = req.params.filename;
    // Only plain files directly inside uploadsDir, never anything path-like.
    if (!filename || filename !== path.basename(filename) || filename.startsWith('.')) return res.status(404).end();

    const send = (restricted) => {
        // Private files must not be stored by a shared cache (e.g. the reverse
        // proxy) or the next person to request the URL would skip this check.
        const opts = { dotfiles: 'deny', cacheControl: !restricted };
        if (restricted) res.setHeader('Cache-Control', 'private, no-cache');
        const done = (err) => { if (err && !res.headersSent) res.status(err.status === 400 ? 400 : 404).end(); };
        if (asDownload) {
            const rawName = req.query.name ? String(req.query.name) : filename;
            const displayName = path.basename(rawName).slice(0, 255) || filename;
            return res.download(path.join(uploadsDir, filename), displayName, opts, done);
        }
        // Direct navigation to a raw /uploads/<file> URL always downloads instead
        // of rendering inline (so an uploaded HTML/SVG can't run script on this
        // origin). <img>/<video>/<audio> embeds are unaffected by this header.
        res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
        res.sendFile(filename, Object.assign({ root: uploadsDir }, opts), done);
    };

    db.get(`SELECT scope, user_a, user_b, group_id FROM Private_Uploads WHERE filename = ?`, [filename], (err, row) => {
        if (err) { console.error('Private upload lookup error:', err.message); return res.status(500).end(); }
        if (!row) return send(false);
        // Only now do we need to know who's asking. (sessionMiddleware is
        // defined further down with the rest of the session setup; it's only
        // touched at request time, so that's fine.)
        sessionMiddleware(req, res, (sessErr) => {
            if (sessErr) return res.status(500).end();
            userMayViewPrivateUpload(req, row, filename, (ok) => ok ? send(true) : res.status(404).end());
        });
    });
}

function downloadUrlFor(f) {
    return `/uploads/download/${path.basename(f.path)}?name=${encodeURIComponent(f.name || path.basename(f.path))}`;
}

// Icon + human-readable size for the generic "other file" attachment card.
// Add /file.png, /code.png, /text.png, /archive.png to the public/ folder
// (same place Biodeck.png and Default.png live) - falls back to /file.png
// for anything not in the code/text/archive lists below.
const CODE_FILE_EXTS = new Set([
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.c', '.cpp', '.cc', '.cxx',
    '.h', '.hpp', '.html', '.htm', '.css', '.scss', '.sass', '.less',
    '.java', '.py', '.rb', '.go', '.rs', '.php', '.sh', '.bash', '.json',
    '.xml', '.yml', '.yaml', '.sql', '.swift', '.kt', '.cs', '.lua', '.pl'
]);
const TEXT_FILE_EXTS = new Set(['.txt', '.md', '.markdown', '.log', '.csv', '.rtf', '.ini', '.conf', '.cfg']);
const ARCHIVE_FILE_EXTS = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.tgz', '.tbz2']);

function fileIconFor(ext) {
    if (CODE_FILE_EXTS.has(ext)) return '/code.png';
    if (TEXT_FILE_EXTS.has(ext)) return '/text.png';
    if (ARCHIVE_FILE_EXTS.has(ext)) return '/archive.png';
    return '/file.png';
}

function formatFileSize(bytes) {
    if (bytes == null || isNaN(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let val = bytes, i = -1;
    do { val /= 1024; i++; } while (val >= 1024 && i < units.length - 1);
    return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`;
}

// Pulls a normalized [{path,name}, ...] attachment list off a Post/Message/GC-Message
// row. Prefers the new multi-file files_json column; falls back to the legacy single
// file_path/file_name columns so old rows created before this feature still render.
function getAttachments(row) {
    if (row && row.files_json) {
        try {
            const arr = JSON.parse(row.files_json);
            if (Array.isArray(arr) && arr.length) return arr;
        } catch (e) {}
    }
    if (row && row.file_path) return [{ path: row.file_path, name: row.file_name }];
    return [];
}

// Actually removes attachment files from disk once nothing references them
// anymore. Call this AFTER the DB row that owned the attachment has been
// deleted, passing the attachment list read from that row via
// getAttachments() *beforehand* (there's nothing left to read it from once
// the row is gone).
//
// A file is kept on disk if it's still referenced by:
//   - another Post/Message/Group_Chat_Message row (shouldn't normally
//     happen given the random per-upload filenames, but it's cheap to check
//     and safer than assuming)
//   - a Reports.attachments_json or Warnings.removed_attachments_json
//     snapshot - these are kept forever as moderation history (see the
//     comment above issuePreActionWarning) and still need to render that
//     file for admins and, via /standing, the affected user
// Only once none of those reference the filename is it safe to unlink it
// and drop its Private_Uploads row (see the comment above
// recordPrivateUploads - that row exists only to gate access while the
// file is alive, so it should go with the file).
function cleanupAttachmentFiles(files) {
    (files || []).forEach(f => {
        const filename = path.basename(String((f && f.path) || '').replace(/\\/g, '/'));
        if (!filename || filename !== path.basename(filename)) return;
        const like = '%' + filename.replace(/[\\%_]/g, '\\$&') + '%';
        db.get(
            `SELECT
                (SELECT COUNT(*) FROM Posts WHERE file_path = ? OR files_json LIKE ? ESCAPE '\\') AS a,
                (SELECT COUNT(*) FROM Messages WHERE file_path = ? OR files_json LIKE ? ESCAPE '\\') AS b,
                (SELECT COUNT(*) FROM Group_Chat_Messages WHERE file_path = ? OR files_json LIKE ? ESCAPE '\\') AS c,
                (SELECT COUNT(*) FROM Reports WHERE attachments_json LIKE ? ESCAPE '\\') AS d,
                (SELECT COUNT(*) FROM Warnings WHERE removed_attachments_json LIKE ? ESCAPE '\\') AS e`,
            [filename, like, filename, like, filename, like, like, like],
            (err, row) => {
                if (err) { console.error('Attachment reference check error:', err.message); return; }
                if (row && (row.a || row.b || row.c || row.d || row.e)) return; // still referenced - keep the file
                fs.unlink(path.join(uploadsDir, filename), (unlinkErr) => {
                    if (unlinkErr && unlinkErr.code !== 'ENOENT') console.error('Attachment delete error:', unlinkErr.message);
                });
                db.run(`DELETE FROM Private_Uploads WHERE filename = ?`, [filename], () => {});
            }
        );
    });
}

// Renders one or more attachments. A single image renders full-size like before.
// Multiple images render as a grid capped at 3 columns wide (so 1-3 images is one
// row, 4+ wraps to additional rows of up to 3). Non-image files (video/audio/other)
// always render full-width below the image grid, one per row.
function renderAttachmentsHTML(files, maxHeight, maxWidth) {
    if (!files || !files.length) return '';
    maxWidth = maxWidth || 'min(100%,80vw)';
    const images = [];
    const others = [];
    files.forEach(f => {
        const ext = path.extname(f.name || '').toLowerCase();
        if (MSG_IMAGE_EXTS.includes(ext)) images.push(f); else others.push(f);
    });

    let html = '';
    if (images.length === 1) {
        const f = images[0];
        const url = `/uploads/${path.basename(f.path)}`;
        html += `<div class="post-file"><img class="post-media-boxed" src="${url}" alt="${escapeHTML(f.name || '')}" style="max-height:${maxHeight}px;max-width:${maxWidth};width:auto;height:auto;margin-top:8px;display:block;margin-left:auto;margin-right:auto;"></div>`;
    } else if (images.length > 1) {
        const cols = Math.min(3, images.length);
        const cells = images.map(f => {
            const url = `/uploads/${path.basename(f.path)}`;
            return `<a class="post-media-grid-item" href="${downloadUrlFor(f)}"><img src="${url}" alt="${escapeHTML(f.name || '')}" style="width:100%;height:100%;object-fit:cover;display:block;"></a>`;
        }).join('');
        html += `<div class="post-file" style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px;margin-top:8px;max-width:${maxWidth};margin-left:auto;margin-right:auto;">${cells}</div>`;
    }

    others.forEach(f => {
        const ext = path.extname(f.name || '').toLowerCase();
        const url = `/uploads/${path.basename(f.path)}`;
        if (MSG_VIDEO_MIME_TYPES[ext]) {
            html += `<div class="post-file"><video controls preload="metadata" style="max-height:${maxHeight}px;max-width:${maxWidth};border-radius:10px;margin-top:8px;display:block;margin-left:auto;margin-right:auto;background:black;"><source src="${url}" type="${MSG_VIDEO_MIME_TYPES[ext]}">Your browser can't play this video. <a href="${downloadUrlFor(f)}" style="color:var(--accent-color);">Download it instead</a>.</video></div>`;
        } else if (MSG_AUDIO_MIME_TYPES[ext]) {
            html += `<div class="post-file"><audio controls preload="metadata" style="width:100%;max-width:${maxWidth === 'min(100%,80vw)' ? '400px' : maxWidth};border-radius:10px;margin-top:8px;display:block;margin-left:auto;margin-right:auto;"><source src="${url}" type="${MSG_AUDIO_MIME_TYPES[ext]}">Your browser can't play this audio. <a href="${downloadUrlFor(f)}" style="color:var(--accent-color);">Download it instead</a>.</audio></div>`;
        } else {
            // f.size is set for anything uploaded after this was added; older
            // attachments won't have it, so fall back to a stat() just for those
            // rather than doing a blocking syscall on every single render.
            let size = typeof f.size === 'number' ? f.size : null;
            if (size == null) {
                try { size = fs.statSync(f.path).size; } catch (e) { /* file missing on disk - just omit size */ }
            }
            const sizeLine = size != null ? `<div style="font-size:0.8em;opacity:0.6;">${formatFileSize(size)}</div>` : '';
            html += `<a class="post-file-link" href="${downloadUrlFor(f)}" style="max-width:${maxWidth};"><img src="${fileIconFor(ext)}" alt="" style="width:auto;height:48px;flex-shrink:0;border-radius:0;"><div style="min-width:0;overflow:hidden;"><div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(f.name)}</div>${sizeLine}</div></a>`;
        }
    });

    return html;
}

function createNotification({ username, type, actor_username, post_id = null, message_id = null, content_preview = null }) {
    if (!username || !actor_username || username === actor_username) return;
    db.run(
        `INSERT INTO Notifications (username, type, actor_username, post_id, message_id, content_preview) VALUES (?, ?, ?, ?, ?, ?)`,
        [username, type, actor_username, post_id, message_id, content_preview],
        (err) => { if (err) console.error('Notification insert error:', err.message); }
    );
}

function getUnreadNotificationCount(username, cb) {
    if (!username) return cb(0);
    db.get(`SELECT COUNT(*) AS c FROM Notifications WHERE username = ? AND read = 0`, [username], (err, row) => {
        if (err || !row) return cb(0);
        cb(row.c || 0);
    });
}

// Sends a DM "from" the system (from_user = 'System', which doesn't need to
// exist in User_Data - Messages has no FK on from_user/to_user). Used for
// automated notices like the activation ping.
function sendSystemDM(toUsername, content) {
    if (!toUsername || !content) return;
    db.run(`INSERT INTO Messages (from_user, to_user, content) VALUES ('System', ?, ?)`,
        [toUsername, content], function (err) {
            if (err) { console.error('System DM insert error:', err.message); return; }
            const newId = this.lastID;
            createNotification({ username: toUsername, type: 'dm', actor_username: 'System', message_id: newId, content_preview: content.slice(0, 140) });
            db.get(`SELECT Messages.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified FROM Messages LEFT JOIN User_Data ON Messages.from_user = User_Data.username WHERE Messages.id = ?`, [newId], (err2, row) => {
                if (err2 || !row) return;
                broadcastDMMessage('System', toUsername, row, null);
            });
        });
}

// Registration gate, toggleable from the admin dashboard.
// ON (default, matches legacy behavior): new accounts are created with
// IsBanned = 1 and admins get pinged (Activations group chat post + DMs) so
// someone can manually activate the account.
// OFF: registration is fully open - accounts are created active (IsBanned =
// 0) immediately, with no pings sent at all.
// Cached in memory (defaulting to true, i.e. current behavior) and backed by
// the Settings table so the choice survives restarts.
let registrationGateEnabled = true;
function loadRegistrationGateSetting() {
    db.get(`SELECT value FROM Settings WHERE key = 'registration_gate_enabled'`, (err, row) => {
        if (!err && row) registrationGateEnabled = row.value === '1';
    });
}
function setRegistrationGateEnabled(enabled, cb) {
    const value = enabled ? '1' : '0';
    db.run(`INSERT INTO Settings (key, value) VALUES ('registration_gate_enabled', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [value], (err) => {
        if (!err) registrationGateEnabled = enabled;
        cb(err);
    });
}

// Writes one row to the audit trail. actor is who performed the action
// ('System' for self-service events like registration); target is the
// affected username, if any. Fire-and-forget - a logging failure shouldn't
// break the action it's logging.
function logAudit(action, actor, target, details) {
    db.run(`INSERT INTO Audit_Log (action, actor, target, details) VALUES (?, ?, ?, ?)`,
        [action, actor || 'System', target || null, details || null],
        (err) => { if (err) console.error('Audit log insert error:', err.message); });
}

// Account-standing thresholds, based on the number of currently-active
// (non-expired) warnings. Expired warnings never count here even though
// they stay visible in the warnings list.
const STANDING_LEVELS = [
    { min: 20, label: 'Severely at risk', color: 'var(--danger-strong-color)' },
    { min: 10, label: 'At risk', color: 'var(--danger-color)' },
    { min: 1, label: 'Be careful', color: 'var(--warning-color, #d9a441)' },
    { min: 0, label: 'All good', color: 'var(--success-color)' }
];
function getStanding(activeWarningCount) {
    const level = STANDING_LEVELS.find(l => activeWarningCount >= l.min);
    return { count: activeWarningCount, label: level.label, color: level.color };
}

// A warning counts toward standing until its expires_at passes. NULL
// expires_at means the warning never expires - same "compare as JS Date"
// approach used for BanExpiresAt elsewhere in this file otherwise, so it
// stays consistent regardless of exact ISO string format.
function isWarningActive(w) {
    if (!w.expires_at) return true;
    return new Date(w.expires_at).getTime() > Date.now();
}

// Fetches every warning for a user (active and expired alike - callers that
// only need the active count/standing should filter with isWarningActive).
function getWarningsForUser(username, cb) {
    db.all(`SELECT id, username, reason, issued_by, created_at, expires_at, mute_chat, removed_content, removed_attachments_json, report_id, account_action FROM Warnings WHERE username = ? ORDER BY created_at DESC`, [username], (err, rows) => {
        if (err) return cb(err);
        cb(null, rows || []);
    });
}

// True while a warning that has mute_chat set is still active for this
// user - blocks DM/group-chat sending (see the mute checks in
// /messages/:username/send and /groups/:id/send) until that specific
// warning naturally expires or is revoked early. A user can have several
// muting warnings at once (e.g. one from a fresh report while an older one
// hasn't expired yet); the mute lasts until the LATEST of them expires,
// unless any of them never expires, in which case the mute never expires.
function isUserMuted(username, cb) {
    db.all(`SELECT expires_at FROM Warnings WHERE username = ? AND mute_chat = 1`, [username], (err, rows) => {
        if (err) return cb(err);
        const active = (rows || []).filter(isWarningActive);
        if (!active.length) return cb(null, null);
        const neverExpires = active.some(w => !w.expires_at);
        const expiresAt = neverExpires ? null : active.reduce((latest, w) =>
            (!latest || new Date(w.expires_at) > new Date(latest)) ? w.expires_at : latest, null);
        cb(null, { expiresAt });
    });
}

// Shared "extras" line(s) for a single warning - shown after the reason on
// the warning email and anywhere warnings are listed (/standing, the
// admin warnings lookup, and the ban/delete notice pages). Covers the two
// optional pieces of context a warning can carry: a chat mute, and (when
// the warning was issued from the /admin/reports/:id page) a snapshot of
// the content that got removed.
function getWarningExtras(w, format, opts) {
    // format: 'html' or 'text'. opts.activeOnly (default true) hides the
    // "you can't chat" line once the warning itself has expired/been
    // revoked, but the removed-content snapshot always shows - it's a
    // historical record, not tied to whether the warning is still active.
    const activeOnly = !opts || opts.activeOnly !== false;
    const stillActive = isWarningActive(w);
    const attachments = (() => {
        if (!w.removed_attachments_json) return [];
        try { return JSON.parse(w.removed_attachments_json) || []; } catch (e) { return []; }
    })();
    const parts = [];
    if (w.account_action) {
        const label = w.account_action === 'temp_ban' ? 'Your account has been temporarily banned.'
            : w.account_action === 'perm_ban' ? 'Your account has been permanently banned.'
            : w.account_action === 'delete' ? 'Your account has been deleted.'
            : null;
        if (label) {
            parts.push(format === 'html'
                ? `<p style="margin:6px 0;"><strong>${label}</strong></p>`
                : label);
        }
    }
    if (w.mute_chat && (!activeOnly || stillActive)) {
        parts.push(format === 'html'
            ? `<p style="margin:6px 0;"><strong>You're not able to chat or post to the feed until this warning expires${w.expires_at ? ' (' + escapeHTML(new Date(w.expires_at).toLocaleString()) + ')' : ''}.</strong></p>`
            : `You're not able to chat or post to the feed until this warning expires${w.expires_at ? ' (' + new Date(w.expires_at).toLocaleString() + ')' : ''}.`);
    }
    if (w.removed_content !== null && w.removed_content !== undefined) {
        if (format === 'html') {
            let html = `<p style="margin:6px 0 2px;">A piece of content has been removed:</p><p style="white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;opacity:0.85;">${escapeHTML(w.removed_content) || '<span style="opacity:0.5;">(no text)</span>'}</p>`;
            if (attachments.length) html += renderAttachmentsHTML(attachments, 300, '400px');
            parts.push(html);
        } else {
            let text = `A piece of content has been removed:\n${w.removed_content || '(no text)'}`;
            if (attachments.length) {
                text += `\n` + attachments.map(a => `- ${a.name}: ${APP_BASE_URL}/uploads/${path.basename(a.path)}`).join('\n');
            }
            parts.push(text);
        }
    }
    return parts;
}

// Extra usernames to DM on every new registration, on top of the user with
// id 1. Local text file, single line, comma-separated, e.g.: Onogen,rtx
// Missing file just means "no extra targets" - not an error.
const ACTIVATION_PING_FILE = path.join(__dirname, 'activation-pings.txt');
function getActivationPingUsernames() {
    try {
        const raw = fs.readFileSync(ACTIVATION_PING_FILE, 'utf8');
        return raw.split(',').map(u => u.trim()).filter(Boolean);
    } catch (e) {
        return [];
    }
}

// Scans message/post content for @username pings and notifies each mentioned
// user that exists in User_Data (skips the author and anyone in skipUsernames,
// e.g. someone who already got a more specific notification like 'dm' or 'reply').
const MENTION_REGEX = /@([a-zA-Z0-9_]{1,32})/g;
function processMentions(content, actorUsername, { type, post_id = null, message_id = null, skipUsernames = [] }) {
    if (!content) return;
    const skip = new Set([actorUsername.toLowerCase(), ...skipUsernames.map(u => u.toLowerCase())]);
    const found = new Set();
    let m;
    MENTION_REGEX.lastIndex = 0;
    while ((m = MENTION_REGEX.exec(content)) !== null) {
        const uname = m[1];
        if (skip.has(uname.toLowerCase())) continue;
        found.add(uname);
    }
    if (!found.size) return;
    const preview = content.trim().slice(0, 140);
    found.forEach(uname => {
        db.get(`SELECT username FROM User_Data WHERE username = ? COLLATE NOCASE`, [uname], (err, row) => {
            if (err || !row) return;
            createNotification({ username: row.username, type, actor_username: actorUsername, post_id, message_id, content_preview: preview });
        });
    });
}

// Wraps @username mentions in message/post text with a styled, clickable link.
// Operates on already-escaped HTML text (so it's safe against injection).
function linkifyMentions(escapedText) {
    if (!escapedText) return escapedText;
    return escapedText.replace(/(^|[\s>])@([a-zA-Z0-9_]{1,32})/g, (full, pre, uname) => {
        return `${pre}<a href="/user/${uname}" style="color:var(--accent-color);text-decoration:none;font-weight:600;">@${uname}</a>`;
    });
}

// Renders post/message/ticket text for safe display: HTML-escapes it, then
// layers a small self-contained Markdown renderer on top (headers, bold,
// italic, strikethrough, inline code, fenced code blocks, links, lists,
// blockquotes), and finally the existing bare-URL autolinking and
// @mention linking. Runs on the *raw* (unescaped) text passed in.
//
// Escaping happens FIRST, on the whole string, before any Markdown syntax
// is interpreted. That ordering is what keeps this safe: by the time any
// "<a>", "<strong>", etc. tag gets built, every "<", ">", "&", etc. that
// came from the user has already been turned into an inert entity, so
// there's no way for user input to smuggle real HTML/script through -
// worst case someone's literal "<script>" shows up as escaped text inside
// a paragraph, never as a live tag. Matching a bare URL or a [text](url)
// link *after* escaping is still correct HTML: an "&" inside the URL is by
// then "&amp;", which browsers decode back to "&" when they parse the
// resulting href="..." attribute, same as if a human had hand-escaped it.
//
// Anything that becomes real HTML along the way (code spans, links, bold,
// etc.) is swapped out for a one-time placeholder token and stashed in
// `slots`, so later passes (e.g. the italic regex) never see - and can't
// re-mangle - HTML an earlier pass already produced. Tokens are resolved
// back to their HTML at the very end, looping until none remain since they
// can nest (e.g. a link stashed inside bold text).
//
// This is the counterpart to renderEmbeds(), which already pulls known
// embeddable URLs (YouTube, images, etc.) out of the text - anything left
// over after that is what gets Markdown-rendered here.
const BARE_URL_REGEX = /https?:\/\/[^\s<>"']+/g;
const MD_LINK_REGEX = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g;
const MD_HEADER_SIZES = { 1: '1.35em', 2: '1.22em', 3: '1.12em', 4: '1.05em', 5: '1em', 6: '0.95em' };

function renderMarkdown(text) {
    if (!text) return '';

    const slots = [];
    const stash = html => {
        const token = `\u0000MD${slots.length}\u0000`;
        slots.push(html);
        return token;
    };

    let escaped = escapeHTML(text);

    // Fenced code blocks - highest precedence, protects their contents
    // (including anything that looks like more Markdown) from every rule
    // below, same as real Markdown.
    escaped = escaped.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (m, code) =>
        stash(`<pre style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:10px;overflow-x:auto;margin:6px 0;"><code>${code.replace(/\n$/, '')}</code></pre>`));

    // Inline code spans.
    escaped = escaped.replace(/`([^`\n]+)`/g, (m, code) =>
        stash(`<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:4px;font-family:monospace;">${code}</code>`));

    // Applies the remaining inline rules (links/bold/italic/strikethrough/
    // bare URLs/@mentions) to a single line of text that's already been
    // through the code-block/code-span pass above.
    function inlineFormat(line) {
        line = line.replace(MD_LINK_REGEX, (m, label, url) =>
            stash(`<a href="${url}" target="_blank" rel="noopener noreferrer nofollow" style="color:var(--accent-color);word-break:break-all;">${label}</a>`));
        line = line.replace(/\*\*([^\n]+?)\*\*/g, (m, t) => stash(`<strong>${t}</strong>`));
        line = line.replace(/__([^\n]+?)__/g, (m, t) => stash(`<strong>${t}</strong>`));
        line = line.replace(/~~([^\n]+?)~~/g, (m, t) => stash(`<del>${t}</del>`));
        line = line.replace(/\*([^\s*][^\n]*?)\*/g, (m, t) => stash(`<em>${t}</em>`));
        line = line.replace(/(^|[^\w])_([^\s_][^\n]*?)_(?!\w)/g, (m, pre, t) => `${pre}${stash(`<em>${t}</em>`)}`);
        // Trailing punctuation is usually sentence punctuation, not part of
        // the URL (e.g. "check https://example.com." or "(see https://x.com)").
        line = line.replace(BARE_URL_REGEX, url => {
            const trailingMatch = url.match(/[.,!?;:'")\]]+$/);
            let trailing = '';
            if (trailingMatch) {
                trailing = trailingMatch[0];
                url = url.slice(0, -trailing.length);
            }
            if (!url) return trailing;
            return stash(`<a href="${url}" target="_blank" rel="noopener noreferrer nofollow" style="color:var(--accent-color);word-break:break-all;">${url}</a>`) + trailing;
        });
        return linkifyMentions(line);
    }

    const lines = escaped.split('\n');
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        if (/^#{1,6}\s+/.test(line)) {
            const level = line.match(/^(#{1,6})/)[1].length;
            blocks.push(`<div style="font-weight:700;font-size:${MD_HEADER_SIZES[level]};margin:6px 0 4px;">${inlineFormat(line.replace(/^#{1,6}\s+/, ''))}</div>`);
            i++;
            continue;
        }

        if (/^&gt;\s?/.test(line)) {
            const quote = [];
            while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
                quote.push(inlineFormat(lines[i].replace(/^&gt;\s?/, '')));
                i++;
            }
            blocks.push(`<blockquote style="border-left:3px solid rgba(255,255,255,0.25);margin:6px 0;padding:2px 0 2px 10px;opacity:0.85;">${quote.join('<br>')}</blockquote>`);
            continue;
        }

        if (/^[-*]\s+/.test(line)) {
            const items = [];
            while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
                items.push(`<li>${inlineFormat(lines[i].replace(/^[-*]\s+/, ''))}</li>`);
                i++;
            }
            blocks.push(`<ul style="margin:4px 0;padding-left:22px;">${items.join('')}</ul>`);
            continue;
        }

        if (/^\d+\.\s+/.test(line)) {
            const items = [];
            while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
                items.push(`<li>${inlineFormat(lines[i].replace(/^\d+\.\s+/, ''))}</li>`);
                i++;
            }
            blocks.push(`<ol style="margin:4px 0;padding-left:22px;">${items.join('')}</ol>`);
            continue;
        }

        if (line.trim() === '') { i++; continue; }

        const para = [];
        while (i < lines.length && lines[i].trim() !== ''
            && !/^#{1,6}\s+/.test(lines[i]) && !/^&gt;\s?/.test(lines[i])
            && !/^[-*]\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i])) {
            para.push(inlineFormat(lines[i]));
            i++;
        }
        blocks.push(`<div>${para.join('<br>')}</div>`);
    }

    let out = blocks.join('');
    for (let guard = 0; guard < 10 && /\u0000MD\d+\u0000/.test(out); guard++) {
        out = out.replace(/\u0000MD(\d+)\u0000/g, (m, n) => slots[+n]);
    }
    return out;
}

const NOTIF_ICONS = { reply: '>', dm: '>', friend_request: '+', friend_accept: '✓', friend_decline: '×', mention_post: '@', mention_dm: '@', mention_gc: '@' };

function notifText(n) {
    const actor = `<a href="/user/${escapeHTML(n.actor_username)}" style="color:var(--text-color);font-weight:bold;text-decoration:none;">${escapeHTML(displayName(n.actor_username, n.actor_nickname))}${renderVerifiedBadge(n.actor_verified)}</a>`;
    switch (n.type) {
        case 'reply': return `${actor} replied to your post`;
        case 'dm': return `${actor} sent you a message`;
        case 'friend_request': return `${actor} sent you a friend request`;
        case 'friend_accept': return `${actor} accepted your friend request`;
        case 'friend_decline': return `${actor} declined your friend request`;
        case 'mention_post': return `${actor} mentioned you in a post`;
        case 'mention_dm': return `${actor} mentioned you in a message`;
        case 'mention_gc': return `${actor} mentioned you in a group chat`;
        default: return `${actor} did something`;
    }
}

function notifLink(n) {
    if (n.type === 'reply' || n.type === 'mention_post') return `/post/${n.post_id}`;
    if (n.type === 'dm') return `/messages/${encodeURIComponent(n.actor_username)}`;
    if (n.type === 'mention_dm') return `/user/${encodeURIComponent(n.actor_username)}`;
    if (n.type === 'mention_gc') return `/groups/${n.post_id}`;
    if (n.type === 'friend_request' || n.type === 'friend_accept' || n.type === 'friend_decline') return `/friends`;
    return '#';
}

function renderNotificationItem(n) {
    const icon = NOTIF_ICONS[n.type] || '*';
    const preview = n.content_preview ? `<div style="opacity:0.6;font-size:0.85em;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(n.content_preview)}</div>` : '';
    const unreadDot = !n.read ? `<span style="width:8px;height:8px;border-radius:50%;background:rgb(0,191,255);flex-shrink:0;"></span>` : `<span style="width:8px;height:8px;flex-shrink:0;"></span>`;
    return `<div class="notif-item" data-id="${n.id}" data-href="${notifLink(n)}" style="display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:var(--text-color);cursor:pointer;margin-bottom:10px;background:${n.read ? 'transparent' : 'rgba(0,191,255,0.06)'};">
        ${unreadDot}
        <span style="font-size:1.1em;flex-shrink:0;">${icon}</span>
        <div style="flex:1;min-width:0;">
            <div>${notifText(n)}</div>
            ${preview}
            <span style="font-size:0.75em;opacity:0.5;" data-ts="${n.created_at.replace(' ','T')+'Z'}"></span>
        </div>
    </div>`;
}

function renderFeedPost(post, sessionUsername, fileMaxHeight, isAdmin) {
    const fileHTML = renderAttachmentsHTML(getAttachments(post), fileMaxHeight);
    const isOwner = post.username === sessionUsername;
    const canDelete = isOwner || isAdmin;
    const deleteBtn = canDelete ? `<button class="button post-action-btn" onclick="deletePost(${post.id})">Delete${(!isOwner && isAdmin) ? '' : ''}</button>` : '';
    const editBtn = isOwner ? `<button class="button post-action-btn" onclick="editPost(${post.id})">Edit</button>` : '';
    const pinBtn = isAdmin ? `<button class="button post-action-btn" onclick="${post.pinned ? `unpinPost(${post.id})` : `pinPost(${post.id})`}">${post.pinned ? 'Unpin' : 'Pin'}</button>` : '';
    const reportBtn = (!isOwner && sessionUsername) ? `<button class="button post-action-btn report-action" data-report-type="post" data-report-id="${post.id}" onclick="reportContent('post', ${post.id}, this)">Report</button>` : '';
    const safeUsername = escapeHTML(post.username);
    const { embedHTML, cleanText } = renderEmbeds(post.content || '');
    const avatarHTML = renderAvatarHTML(post.avatar_path, post.username, 32);
    const editedMarker = post.edited ? `<span style="opacity:0.6;font-size:0.8em;margin-left:6px;">(edited)</span>` : '';
    return `<div class="post-header" style="display:flex;align-items:flex-start;gap:8px;">
            <a href="/user/${safeUsername}" style="flex-shrink:0;">${avatarHTML}</a>
            <div style="display:flex;flex-direction:column;min-width:0;">
                <a href="/user/${safeUsername}" style="color:var(--text-color);text-decoration:none;font-weight:bold;">${renderNameWithHandle(post.username, post.Nickname, { isVerified: post.IsVerified })}</a>
                <span><span class="post-time" data-ts="${post.created_at.replace(' ', 'T') + 'Z'}" style="font-size:0.8em;opacity:0.6;"></span>${editedMarker}</span>
            </div>
        </div>
        <div class="post-content" id="post-content-${post.id}" data-raw="${escapeHTML(post.content || '')}">${renderMarkdown(cleanText)}</div>
        ${embedHTML}
        ${fileHTML}
        <div class="post-actions">
            <a href="/post/${post.id}" class="button post-action-btn reply-count-btn" data-post-id="${post.id}" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center;">${(post.reply_count || 0)} Replies</a>
            ${pinBtn}
            ${editBtn}
            ${deleteBtn}
            ${reportBtn}
        </div>`;
}

function renderPinnedItem(post) {
    const safeUsername = escapeHTML(post.username);
    const safeContent = escapeHTML((post.content || '').trim());
    const preview = safeContent.length > 140 ? safeContent.slice(0, 140) + '…' : safeContent;
    const previewHTML = preview || '<span style="opacity:0.5;">(attachment)</span>';
    return `<div class="pinned-item" data-pin-id="${post.id}" style="display:flex;align-items:center;gap:10px;padding:8px 24px;background:rgba(255,180,40,0.08);border-bottom:1px solid rgba(255,180,40,0.25);">
        <span style="font-size:0.7em;letter-spacing:0.08em;color:var(--pinned-color);font-weight:700;text-transform:uppercase;flex-shrink:0;">Pinned</span>
        <a href="/user/${safeUsername}" style="color:var(--text-color);text-decoration:none;font-weight:bold;flex-shrink:0;">${escapeHTML(displayName(post.username, post.Nickname))}${renderVerifiedBadge(post.IsVerified)}</a>
        <span style="opacity:0.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;">${previewHTML}</span>
        <a href="#" onclick="dismissPin(${post.id});return false;" title="Hide this pin" style="color:var(--text-dimmer-color);text-decoration:none;font-weight:700;flex-shrink:0;padding:0 4px;">✕</a>
    </div>`;
}

function buildPostListHTML(posts, sessionUsername, fileMaxHeight, isAdmin) {
    return posts.map(post => `
        <div class="post" id="post-${post.id}">
            ${renderFeedPost(post, sessionUsername, fileMaxHeight, isAdmin)}
        </div><br>`).join('');
}

function buildFeedHTML(posts, sessionUsername, fileMaxHeight, isAdmin) {
    const roots = posts.filter(p => !p.reply_to);
    return buildPostListHTML(roots, sessionUsername, fileMaxHeight, isAdmin);
}



// ----- better-sqlite3 setup -----
// better-sqlite3 is synchronous (no callbacks, no query queue), which is
// faster and simpler than node-sqlite3, but this file was written throughout
// against node-sqlite3's callback API (db.run/get/all/serialize with
// (err, row) callbacks and `this.lastID`/`this.changes`). Rather than rewrite
// every one of the ~200 call sites (and risk subtly breaking any of them),
// `db` below is a thin compatibility shim: it runs each query synchronously
// via better-sqlite3 under the hood, then invokes the callback on
// process.nextTick with the same (err, row/rows) / this-bound
// {lastID, changes} shape node-sqlite3 callers expect. Every call site below
// this point is unchanged from the node-sqlite3 version.
let sqliteDb;
try {
    sqliteDb = new Database('./data.db');
} catch (err) {
    console.error('Database connection error :', err.message);
    process.exit(1);
}

// Caches prepared statements by SQL text so repeated queries (the vast
// majority of calls here use a fixed SQL string) aren't re-prepared every time.
const stmtCache = new Map();
function getStmt(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
        stmt = sqliteDb.prepare(sql);
        stmtCache.set(sql, stmt);
    }
    return stmt;
}

function normalizeArgs(params, callback) {
    if (typeof params === 'function') return { params: [], callback: params };
    if (params === undefined) return { params: [], callback };
    return { params: Array.isArray(params) ? params : [params], callback };
}

const db = {
    run(sql, params, callback) {
        const norm = normalizeArgs(params, callback);
        let result = null, error = null;
        try {
            if (/^\s*PRAGMA/i.test(sql)) {
                sqliteDb.pragma(sql.replace(/^\s*PRAGMA\s+/i, ''));
                result = { changes: 0, lastInsertRowid: undefined };
            } else {
                result = getStmt(sql).run(...norm.params);
            }
        } catch (err) {
            error = err;
        }
        if (typeof norm.callback === 'function') {
            const ctx = { lastID: result ? result.lastInsertRowid : undefined, changes: result ? result.changes : 0 };
            process.nextTick(() => norm.callback.call(ctx, error));
        } else if (error) {
            console.error('DB run error (no callback):', error.message, '\nSQL:', sql);
        }
        return db;
    },

    get(sql, params, callback) {
        const norm = normalizeArgs(params, callback);
        let row, error = null;
        try {
            row = getStmt(sql).get(...norm.params);
        } catch (err) {
            error = err;
        }
        if (typeof norm.callback === 'function') {
            process.nextTick(() => norm.callback(error, row));
        } else if (error) {
            console.error('DB get error (no callback):', error.message, '\nSQL:', sql);
        }
        return db;
    },

    all(sql, params, callback) {
        const norm = normalizeArgs(params, callback);
        let rows, error = null;
        try {
            rows = getStmt(sql).all(...norm.params);
        } catch (err) {
            error = err;
        }
        if (typeof norm.callback === 'function') {
            process.nextTick(() => norm.callback(error, rows || []));
        } else if (error) {
            console.error('DB all error (no callback):', error.message, '\nSQL:', sql);
        }
        return db;
    },

    // better-sqlite3 runs everything synchronously on a single connection,
    // so there's no queue to serialize against like there is with
    // node-sqlite3 - calling fn() runs its db.run/get/all calls in program
    // order already. This just preserves the call shape used below.
    serialize(fn) {
        if (typeof fn === 'function') fn();
        return db;
    }
};

console.log('Connected to database');
db.run(`PRAGMA journal_mode=WAL`, (err) => {
    if (err) console.error('WAL error:', err.message);
db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS User_Data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE,
                password TEXT,
                IsBanned INTEGER DEFAULT 0,
                BanReason TEXT DEFAULT NULL,
                bio TEXT DEFAULT NULL
            )`);
            db.run(`ALTER TABLE User_Data ADD COLUMN bio TEXT DEFAULT NULL`, () => {});
            db.run(`CREATE TABLE IF NOT EXISTS Messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_user TEXT,
                to_user TEXT,
                content TEXT,
                file_path TEXT DEFAULT NULL,
                file_name TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                read INTEGER DEFAULT 0
            )`);
            db.run(`ALTER TABLE Messages ADD COLUMN file_path TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE Messages ADD COLUMN file_name TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE Messages ADD COLUMN files_json TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE Messages ADD COLUMN reply_to INTEGER DEFAULT NULL`, () => {});
            // Set to 1 the first time a message's content is changed via
            // /messages/:username/edit/:id, so bubbles can show "(edited)".
            db.run(`ALTER TABLE Messages ADD COLUMN edited INTEGER DEFAULT 0`, () => {});
            // DM lookups filter by from_user/to_user on nearly every request
            // (conversation list, thread fetch) - these were full table scans
            // before this index existed.
            db.run(`CREATE INDEX IF NOT EXISTS idx_messages_from ON Messages(from_user)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_messages_to ON Messages(to_user)`);
            db.run(`ALTER TABLE User_Data ADD COLUMN IsOwner INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN IsDeveloper INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN IsSupporter INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN IsAdmin INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN IsHeadAdmin INTEGER DEFAULT 0`, () => {});
            // Verified badge (blue checkmark) - toggled by admins from the
            // admin dashboard's Manage Badges panel, shown next to the
            // username everywhere a username is rendered.
            db.run(`ALTER TABLE User_Data ADD COLUMN IsVerified INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN avatar_path TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN Nickname TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN IsDeleted INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN DeleteReason TEXT DEFAULT NULL`, () => {});
            // Optional expiry timestamp (ISO string) for timed bans. NULL means the
            // ban is permanent - checkBan/checkBanStatus treat a past timestamp as
            // an expired ban and auto-clear IsBanned/BanReason/BanExpiresAt.
            db.run(`ALTER TABLE User_Data ADD COLUMN BanExpiresAt TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN email TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN email_verified INTEGER DEFAULT 0`, () => {});
            // Selected CSS theme (see themes.json / loadThemes()). Stores the
            // theme's stable `name`, not its display name, so renaming a
            // theme's displayName in themes.json doesn't orphan anyone's pick.
            db.run(`ALTER TABLE User_Data ADD COLUMN theme TEXT DEFAULT 'default'`, () => {});
            // Multiple accounts are now allowed to share the same email address,
            // so this is a plain (non-unique) index, kept only for lookup speed.
            // If an older database still has the unique index from before, drop
            // it first so shared emails aren't rejected.
            db.run(`DROP INDEX IF EXISTS idx_user_data_email`, () => {
                db.run(`CREATE INDEX IF NOT EXISTS idx_user_data_email ON User_Data(email)`);
            });
            // Password reset tokens. Only the sha256 hash of the token is stored,
            // so a database leak alone can't be used to reset anyone's password.
            db.run(`CREATE TABLE IF NOT EXISTS Password_Resets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT UNIQUE NOT NULL,
                expires_at DATETIME NOT NULL,
                used INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_password_resets_user ON Password_Resets(user_id)`);
            // Self-service email change requests. A code is emailed to the
            // ACCOUNT'S CURRENT email (proving the requester still controls
            // it) and must be entered along with the new address to
            // complete the change. Only the sha256 hash of the code is
            // stored, same pattern as Password_Resets.
            db.run(`CREATE TABLE IF NOT EXISTS Email_Changes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                code_hash TEXT NOT NULL,
                new_email TEXT NOT NULL,
                expires_at DATETIME NOT NULL,
                used INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_email_changes_user ON Email_Changes(user_id)`);
            // Email verification links. token_hash is a sha256 of the raw token
            // that goes out in the emailed link, same pattern as Password_Resets.
            // `email` freezes which address the token is good for, so if the
            // account's email changes after a link is sent, the old link can't
            // silently verify the new address.
            db.run(`CREATE TABLE IF NOT EXISTS Email_Verifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT UNIQUE NOT NULL,
                email TEXT NOT NULL,
                expires_at DATETIME NOT NULL,
                used INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON Email_Verifications(user_id)`);
            db.run(`CREATE TABLE IF NOT EXISTS Posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                username TEXT,
                content TEXT,
                file_path TEXT DEFAULT NULL,
                file_name TEXT DEFAULT NULL,
                reply_to INTEGER DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`ALTER TABLE Posts ADD COLUMN reply_to INTEGER DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE Posts ADD COLUMN pinned INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE Posts ADD COLUMN files_json TEXT DEFAULT NULL`, () => {});
            // Set to 1 the first time a post/reply's content is changed via
            // /feed/edit/:id, so it can show an "(edited)" marker.
            db.run(`ALTER TABLE Posts ADD COLUMN edited INTEGER DEFAULT 0`, () => {});
            // username backs profile pages and the feed; reply_to backs every
            // reply-thread fetch and the profile page's per-post reply count
            // (a recursive CTE, so this matters even more there).
            db.run(`CREATE INDEX IF NOT EXISTS idx_posts_username ON Posts(username)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_posts_reply_to ON Posts(reply_to)`);
            db.run(`CREATE TABLE IF NOT EXISTS Follows (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                follower_username TEXT NOT NULL,
                following_username TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(follower_username, following_username)
            )`);
            // The UNIQUE(follower_username, following_username) constraint above
            // already indexes follower_username as its leading column, but a
            // lookup by following_username alone (follower list, follower
            // count) can't use that composite - hence this separate index.
            db.run(`CREATE INDEX IF NOT EXISTS idx_follows_following ON Follows(following_username)`);
            db.run(`CREATE TABLE IF NOT EXISTS IP_Bans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ip TEXT UNIQUE NOT NULL,
                reason TEXT DEFAULT NULL,
                banned_by TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`ALTER TABLE User_Data ADD COLUMN last_ip TEXT DEFAULT NULL`, () => {});
            // Full history of the IPs each account has logged in/registered
            // from, so support can look at a compromised account and see
            // whether the IP suddenly changed (and when). changed_from_previous
            // is precomputed at insert time so the admin view doesn't have to
            // do a self-join to highlight the jumps.
            db.run(`CREATE TABLE IF NOT EXISTS IP_Login_History (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                ip TEXT NOT NULL,
                event TEXT NOT NULL DEFAULT 'login',
                changed_from_previous INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_ip_login_history_user ON IP_Login_History(user_id, created_at)`);
            db.run(`CREATE TABLE IF NOT EXISTS Friend_Requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_user TEXT NOT NULL,
                to_user TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(from_user, to_user)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS Friends (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_a TEXT NOT NULL,
                user_b TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_a, user_b)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS Notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                type TEXT NOT NULL,
                actor_username TEXT NOT NULL,
                post_id INTEGER DEFAULT NULL,
                message_id INTEGER DEFAULT NULL,
                content_preview TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                read INTEGER DEFAULT 0
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_username ON Notifications(username)`);
            db.run(`CREATE TABLE IF NOT EXISTS Group_Chats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_by TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS Group_Chat_Members (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(group_id, username)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS Group_Chat_Messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                from_user TEXT NOT NULL,
                content TEXT,
                file_path TEXT DEFAULT NULL,
                file_name TEXT DEFAULT NULL,
                reply_to INTEGER DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`ALTER TABLE Group_Chat_Messages ADD COLUMN files_json TEXT DEFAULT NULL`, () => {});
            // Which conversation each DM / group chat attachment belongs to, so
            // /uploads/<file> can be restricted to the people in it. See
            // serveUpload(). scope is 'dm' (user_a/user_b) or 'gc' (group_id).
            db.run(`CREATE TABLE IF NOT EXISTS Private_Uploads (
                filename TEXT PRIMARY KEY,
                scope TEXT NOT NULL,
                user_a TEXT DEFAULT NULL,
                user_b TEXT DEFAULT NULL,
                group_id INTEGER DEFAULT NULL
            )`);
            backfillPrivateUploads();
            // Set to 1 the first time a group message's content is changed via
            // /groups/:id/edit/:msgId, so it can show an "(edited)" marker.
            db.run(`ALTER TABLE Group_Chat_Messages ADD COLUMN edited INTEGER DEFAULT 0`, () => {});
            db.run(`CREATE INDEX IF NOT EXISTS idx_gcm_group ON Group_Chat_Messages(group_id)`);
            // Set to 1 when the group's creator marks it as public via
            // /groups/:id/toggle-public. Public groups show up on /discover
            // and can be joined by anyone, not just friends of a member.
            db.run(`ALTER TABLE Group_Chats ADD COLUMN is_public INTEGER DEFAULT 0`, () => {});
            // Generic key/value store for small admin-configurable settings
            // (e.g. the registration gate toggle below).
            db.run(`CREATE TABLE IF NOT EXISTS Settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )`, () => { loadRegistrationGateSetting(); });
            // Audit trail for admin-facing/account-lifecycle events (account
            // created/banned/unbanned/deleted, registration gate toggled, etc).
            // actor is who performed the action ('System' for self-service
            // events like registration), target is the affected username (if
            // any).
            db.run(`CREATE TABLE IF NOT EXISTS Audit_Log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL,
                actor TEXT NOT NULL,
                target TEXT DEFAULT NULL,
                details TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            // Account-standing warnings. expires_at is optional - NULL means
            // the warning never expires and counts toward standing forever.
            // When a warning DOES expire, it stops counting toward standing
            // but the row is kept forever so the full history still shows
            // up in the warnings list. Admins can also revoke a warning
            // early (see /admin/warnings/:id/revoke), which just sets
            // expires_at to now rather than deleting the row, for the same
            // "keep history" reason.
            db.run(`CREATE TABLE IF NOT EXISTS Warnings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                reason TEXT DEFAULT NULL,
                issued_by TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                expires_at TEXT DEFAULT NULL
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_warnings_username ON Warnings(username)`);
            // Migration: CREATE TABLE IF NOT EXISTS above is a no-op on a
            // Warnings table that already existed from before never-expiring
            // warnings were added (when expires_at was NOT NULL) - it does
            // NOT relax that constraint on an existing table. Detect the
            // stale constraint and rebuild the table (preserving all rows)
            // so inserting a NULL expires_at stops failing with a db error.
            try {
                const warningsCols = sqliteDb.prepare(`PRAGMA table_info(Warnings)`).all();
                const expiresCol = warningsCols.find(c => c.name === 'expires_at');
                if (expiresCol && expiresCol.notnull) {
                    console.log('Migrating Warnings.expires_at to allow NULL (never-expiring warnings)...');
                    sqliteDb.exec(`
                        ALTER TABLE Warnings RENAME TO Warnings_migrate_tmp;
                        CREATE TABLE Warnings (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            username TEXT NOT NULL,
                            reason TEXT DEFAULT NULL,
                            issued_by TEXT NOT NULL,
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            expires_at TEXT DEFAULT NULL
                        );
                        INSERT INTO Warnings (id, username, reason, issued_by, created_at, expires_at)
                            SELECT id, username, reason, issued_by, created_at, expires_at FROM Warnings_migrate_tmp;
                        DROP TABLE Warnings_migrate_tmp;
                        CREATE INDEX IF NOT EXISTS idx_warnings_username ON Warnings(username);
                    `);
                    stmtCache.clear(); // old cached statements point at the dropped table object
                    console.log('Warnings migration complete.');
                }
            } catch (migrateErr) {
                console.error('Warnings NOT NULL migration check failed:', migrateErr.message);
            }
            // mute_chat: when set, the warned user can't send DMs or group
            // chat messages until this specific warning expires (see
            // isUserMuted / the mute checks in /messages/:username/send and
            // /groups/:id/send). removed_content/removed_attachments_json
            // are an optional snapshot of the offending message/post, filled
            // in when a warning is issued from the /admin/reports/:id page
            // (report_id links back to that report) so the warned user can
            // still see exactly what got them warned/banned/deleted, in the
            // warning email and on the /standing page.
            db.run(`ALTER TABLE Warnings ADD COLUMN mute_chat INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE Warnings ADD COLUMN removed_content TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE Warnings ADD COLUMN removed_attachments_json TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE Warnings ADD COLUMN report_id INTEGER DEFAULT NULL`, () => {});
            // account_action: set when this warning was issued as the
            // explanatory warning attached to a ban/delete from
            // /admin/reports/:id (see issuePreActionWarning / the
            // /admin/warn route). One of 'temp_ban', 'perm_ban', 'delete', or
            // NULL for an ordinary warning. Stored separately from `reason`
            // (the admin's own text) so the "what happened" line in the
            // "What this affects" section stays accurate even if the account
            // later gets unbanned or undeleted - the ban/delete state itself
            // is looked up live elsewhere, this column is just a historical
            // record of what this warning was issued for.
            db.run(`ALTER TABLE Warnings ADD COLUMN account_action TEXT DEFAULT NULL`, () => {});
            // Support tickets submitted via the public /support form. Reachable
            // without logging in, but the submitter must still supply the
            // username and email on the account the ticket is about, so
            // support staff have something to look the account up by.
            db.run(`CREATE TABLE IF NOT EXISTS Support_Tickets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                email TEXT NOT NULL,
                subject TEXT NOT NULL,
                message TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON Support_Tickets(status)`);
            // IP the ticket was submitted from, so support can compare it
            // against the account's login IP history (see IP_Login_History)
            // when triaging a possible account-takeover report. NULL for
            // tickets that came in by email instead of the web form - there's
            // no meaningful client IP for those.
            db.run(`ALTER TABLE Support_Tickets ADD COLUMN ip TEXT DEFAULT NULL`, () => {});
            // Admin replies sent from the /admin/support/:id ticket page. Kept as
            // history alongside the ticket even though the actual reply goes out
            // by email, not through any in-app messaging.
            db.run(`CREATE TABLE IF NOT EXISTS Support_Ticket_Replies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticket_id INTEGER NOT NULL,
                admin_username TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_support_ticket_replies_ticket ON Support_Ticket_Replies(ticket_id)`);
            // is_customer distinguishes a reply the customer emailed in (picked up
            // by the inbound mail poller) from one an admin typed on the ticket
            // page. admin_username is still populated for customer replies (with
            // their display name) so older code paths that assume it's set keep
            // working - is_customer is what the UI actually branches on.
            db.run(`ALTER TABLE Support_Ticket_Replies ADD COLUMN is_customer INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE Support_Ticket_Replies ADD COLUMN customer_email TEXT DEFAULT NULL`, () => {});
            // User-submitted reports of a post, DM, or group chat message, filed
            // via the "Report" button next to that content. content is a
            // snapshot of the reported text taken at report time, so the report
            // still makes sense even if the original is later edited or deleted.
            // source_id points at the original Posts/Messages/Group_Chat_Messages
            // row (best-effort - it may no longer exist by the time an admin
            // reviews it).
            db.run(`CREATE TABLE IF NOT EXISTS Reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                reporter_username TEXT NOT NULL,
                reported_username TEXT NOT NULL,
                source_type TEXT NOT NULL,
                source_id INTEGER,
                content TEXT,
                status TEXT NOT NULL DEFAULT 'open',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            // Snapshot of the reported message/post's attachments (same
            // [{path,name}, ...] shape getAttachments() normalizes elsewhere),
            // so an admin reviewing the report can see any reported image/file
            // even if the original post/message is edited or deleted later.
            db.run(`ALTER TABLE Reports ADD COLUMN attachments_json TEXT DEFAULT NULL`, () => {});
            db.run(`CREATE INDEX IF NOT EXISTS idx_reports_status ON Reports(status)`);
            // Group id 1 is reserved as the system "activations" log - new account
            // notices get posted there. INSERT OR IGNORE so this is a no-op after
            // the first boot (and safe if it already exists from an older db).
            db.run(`INSERT OR IGNORE INTO Group_Chats (id, name, created_by) VALUES (1, 'Activations', 'System')`, (err) => {
                if (err) console.error('Failed to reserve group id 1:', err.message);
            });
        });
        });

app.use(express.urlencoded({extended:true}))
app.use(express.json())

// public/ is served statically EXCEPT anything under /uploads, which goes
// through serveUpload() (above) so DM / group chat attachments can be access
// checked. The path is decoded and normalized before testing because
// express.static does the same before touching the disk - testing the raw
// URL would let something like /%75ploads/<file> or /a/../uploads/<file> slip
// past this and be served unchecked.
const publicStatic = express.static(path.join(__dirname, 'public'));
// 404.html lives beside server.js (not in public/), same as editor.html.
app.get('/404.html', (req, res) => {
    res.status(404).sendFile(path.join(__dirname, '404.html'));
});
function isUploadsPath(rawPath) {
    let p;
    try { p = decodeURIComponent(rawPath); } catch (e) { return true; }
    p = path.posix.normalize('/' + p).toLowerCase();
    return p === '/uploads' || p.startsWith('/uploads/');
}
app.use((req, res, next) => {
    if (isUploadsPath(req.path)) return next();
    publicStatic(req, res, next);
});
app.get('/uploads/:filename', (req, res) => serveUpload(req, res, false));

const SESSION_SECRET_PATH = path.join(__dirname, '.session-secret');
function loadOrCreateSessionSecret() {
    if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
    try {
        return fs.readFileSync(SESSION_SECRET_PATH, 'utf8').trim();
    } catch (e) {
        const secret = require('crypto').randomBytes(64).toString('hex');
        try { fs.writeFileSync(SESSION_SECRET_PATH, secret, { mode: 0o600 }); } catch (e2) {
            console.error('Could not persist session secret, sessions will reset on restart:', e2.message);
        }
        return secret;
    }
}
const SESSION_SECRET = loadOrCreateSessionSecret();

const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

// This app runs behind a reverse proxy (confirmed by X-Forwarded-For showing
// up on incoming requests), so Express needs to trust it - both so
// express-session sees HTTPS correctly via X-Forwarded-Proto (cookie.secure:
// 'auto' needs this) and so express-rate-limit derives req.ip from the real
// client IP instead of the proxy's. '1' trusts exactly one hop (the
// immediate proxy in front of this app) - bump it if there's more than one
// proxy between the internet and this process.
app.set('trust proxy', 1);

// Named so serveUpload() can load the session on demand for private files.
// express-session is a no-op when req.session is already set, so registering
// it globally below as well is safe.
const sessionMiddleware = session({
    store: new FileStore({ path: sessionsDir, ttl: 7 * 24 * 60 * 60, retries: 1, logFn: function () {} }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        // 'auto' sends Secure (HTTPS-only) whenever the request is HTTPS,
        // and falls back to unsecured cookies over plain HTTP for local
        // dev. Previously this had no secure flag at all, so the session
        // cookie would be sent over unencrypted HTTP in production too -
        // trivially sniffable on shared networks.
        secure: 'auto',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
});
app.use(sessionMiddleware);

// Basic hardening headers. X-Content-Type-Options stops browsers from
// MIME-sniffing uploaded/served files into something more dangerous than
// their declared type; X-Frame-Options blocks this app from being framed
// on another site for clickjacking.
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
});

// Serves whichever stylesheet is currently active for the visitor. Every
// page links to /theme.css instead of a fixed /styles.css so switching
// themes takes effect everywhere without editing each page's <link> tag.
// Logged-out visitors (and anyone whose saved theme no longer exists) get
// the default theme.
app.get('/theme.css', (req, res) => {
    // Deliberately NOT using res.sendFile here. sendFile auto-generates a
    // weak ETag from the file's size+mtime, and theme CSS files are usually
    // all deployed at once (same mtime) and can be close enough in byte size
    // to collide on that ETag. When that happens, switching to a theme whose
    // file collides with whatever was last cached under this same /theme.css
    // URL gets wrongly answered with a 304, so the browser keeps rendering
    // the OLD theme's cached body - which is exactly the "theme doesn't
    // change until I clear cache" symptom. Reading the file and sending it
    // directly with no-store sidesteps conditional GET entirely, so there's
    // never a stale cached body to (mis)validate against.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    const sendTheme = (theme) => {
        const themePath = resolveThemeCSSPath(theme);
        fs.readFile(themePath, 'utf8', (err, css) => {
            if (err) {
                return fs.readFile(path.join(__dirname, 'public', FALLBACK_THEME.file), 'utf8', (err2, fallbackCss) => {
                    if (err2) return res.status(500).end();
                    res.type('text/css').send(fallbackCss);
                });
            }
            res.type('text/css').send(css);
        });
    };
    if (!req.session.userId) return sendTheme(getThemeByName('default'));
    db.get(`SELECT theme FROM User_Data WHERE id = ?`, [req.session.userId], (err, row) => {
        sendTheme(getThemeByName(err || !row ? 'default' : row.theme));
    });
});

function getClientIP(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress || req.ip || 'unknown';
}

// Records a login/register event in IP_Login_History and keeps
// User_Data.last_ip in sync. Figures out whether this IP is different from
// the account's last known one and, if so, writes an audit log entry
// (surfaces on the existing admin Audit Log tab) so a sudden IP change is
// visible without support having to dig through raw history rows.
// Fire-and-forget, same pattern as logAudit - never blocks the
// login/register response.
function recordLoginIP(userId, username, ip, event) {
    if (!ip) return;
    db.get(`SELECT ip FROM IP_Login_History WHERE user_id = ? ORDER BY id DESC LIMIT 1`, [userId], (err, lastRow) => {
        const previousIP = !err && lastRow ? lastRow.ip : null;
        const changed = previousIP !== null && previousIP !== ip;
        db.run(`INSERT INTO IP_Login_History (user_id, username, ip, event, changed_from_previous) VALUES (?, ?, ?, ?, ?)`,
            [userId, username, ip, event || 'login', changed ? 1 : 0],
            (err2) => { if (err2) console.error('IP history insert error:', err2.message); });
        if (changed) {
            logAudit('ip_changed', username, username, `${previousIP} -> ${ip} (${event || 'login'})`);
        }
        db.run(`UPDATE User_Data SET last_ip = ? WHERE id = ?`, [ip, userId], () => {});
    });
}

function checkIPBan(req, res, next) {
    const ip = getClientIP(req);
    db.get(`SELECT reason FROM IP_Bans WHERE ip = ?`, [ip], (err, row) => {
        if (err || !row) return next();
        const reason = escapeHTML(row.reason || 'No reason provided');
        return res.status(403).send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Banned</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
</head>
<body>
    <div class="box" style="color: var(--text-color); height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box;">
        <h1>Your IP has been banned</h1><br>
        <h3>Ban Reason: ${reason}</h3><br><br>
        <p style="opacity:0.6;font-size:0.9em;">If you believe this is a mistake, contact an administrator.</p>
    </div>
</body>
</html>`);
    });
}

function checkBan(req, res, next) {
    if (!req.session.userId) return next();

    db.get(`SELECT IsBanned, BanReason, BanExpiresAt, IsDeleted, DeleteReason, IsAdmin, IsOwner, IsHeadAdmin, avatar_path FROM User_Data WHERE id = ?`, [req.session.userId], (err, user) => {
        if (err) return next();
        // No row at all means the account was permanently deleted (hard
        // delete removes the row entirely, unlike the soft delete which
        // keeps it with IsDeleted = 1). Treat it the same way as a soft
        // delete for any session that's still logged in elsewhere.
        if (!user) {
            const goneUsername = req.session.userUsername;
            getWarningsForUser(goneUsername, (errW, warnings) => {
                const warningsHTML = renderWarningsTableHTML(warnings);
                req.session.destroy(() => {
                    res.clearCookie('connect.sid');
                    return res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Account Deleted</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
<style>
    html, body {
        height: auto !important;
        min-height: 100% !important;
        overflow-y: auto !important;
    }
    body {
        margin: 0 !important;
        display: flex !important;
        align-items: flex-start !important;
        justify-content: center !important;
    }
</style>
</head>
<body>
    <div class="box" style="color: var(--text-color); height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box; margin: 40px auto; overflow-y: visible;">
        ${renderAvatarBlockHTML(null, goneUsername)}
        <h1>Your account has been deleted</h1><br>
        ${renderStandingBlockHTML('Deleted')}
        ${warningsHTML}<br>
        <button type="submit" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>
    </div>
</body>
</html>`);
                });
            });
            return;
        }
        req.isAdmin = !!(user.IsAdmin || user.IsOwner || user.IsHeadAdmin);
        req.isHeadAdmin = !!(user.IsHeadAdmin || user.IsOwner);
        if (user.IsDeleted == 1) {
            const reason = escapeHTML(user.DeleteReason || 'No reason provided');
            const deletedUsername = req.session.userUsername;
            const deletedAvatarPath = user.avatar_path;
            getWarningsForUser(deletedUsername, (errW, warnings) => {
                const warningsHTML = renderWarningsTableHTML(warnings);
                req.session.destroy(() => {
                    res.clearCookie('connect.sid');
                    return res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Account Deleted</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
<style>
    html, body {
        height: auto !important;
        min-height: 100% !important;
        overflow-y: auto !important;
    }
    body {
        margin: 0 !important;
        display: flex !important;
        align-items: flex-start !important;
        justify-content: center !important;
    }
</style>
</head>
<body>
    <div class="box" style="color: var(--text-color); height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box; margin: 40px auto; overflow-y: visible;">
        ${renderAvatarBlockHTML(deletedAvatarPath, deletedUsername)}
        <h1>Your account has been deleted</h1><br>
        <h3>Reason: ${reason}</h3><br><br>
        ${renderStandingBlockHTML('Deleted')}
        ${warningsHTML}<br>
        <button type="submit" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>
    </div>
</body>
</html>`);
                });
            });
        } else if (user.IsBanned == 1 && user.BanExpiresAt && new Date(user.BanExpiresAt).getTime() <= Date.now()) {
            // Timed ban has expired - clear it (and email the user) instead of
            // showing a stale ban screen.
            clearExpiredBan(req.session.userId);
            next();
        } else if (user.IsBanned == 1) {
            const reason = escapeHTML(user.BanReason || 'No reason provided');
            const expiryLine = user.BanExpiresAt
                ? `<h3>Ban Expires: ${escapeHTML(new Date(user.BanExpiresAt).toLocaleString())}</h3><br><br>`
                : '';
            const bannedUsername = req.session.userUsername;
            const bannedAvatarPath = user.avatar_path;
            getWarningsForUser(bannedUsername, (errW, warnings) => {
                const warningsHTML = renderWarningsTableHTML(warnings);
                req.session.destroy(() => {
                    res.clearCookie('connect.sid');
                    return res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Banned</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
<style>
    html, body {
        height: auto !important;
        min-height: 100% !important;
        overflow-y: auto !important;
    }
    body {
        margin: 0 !important;
        display: flex !important;
        align-items: flex-start !important;
        justify-content: center !important;
    }
</style>
</head>
<body>
    <div class="box" style="color: var(--text-color); height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box; margin: 40px auto; overflow-y: visible;">
        ${renderAvatarBlockHTML(bannedAvatarPath, bannedUsername)}
        <h1>The ban hammer has struck you</h1><br>
        <h3>Ban Reason: ${reason}</h3><br><br>
        ${expiryLine}
        ${renderStandingBlockHTML('Banned')}
        ${warningsHTML}<br>
        <button type="submit" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>
    </div>
</body>
</html>`);
                });
            });
        } else {
            next();
        }
    });
}

// ----- Password reset email -----
// Configure via environment variables:
//   SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE ('true'/'false'), SMTP_USER, SMTP_PASS, SMTP_FROM
//   APP_BASE_URL - the public URL of this app, e.g. https://biodeck.example.com
// If SMTP isn't configured, reset links are logged to the console instead of
// emailed, so this still works out of the box in dev.
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let mailTransporter = null;
if (nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    mailTransporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
} else if (!nodemailer) {
    console.warn('nodemailer is not installed (run `npm install nodemailer`) - password reset emails will be logged to the console instead of sent.');
} else {
    console.warn('SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS) - password reset emails will be logged to the console instead of sent.');
}

// ----- Inbound support email -----
// Keeps a persistent IMAP IDLE connection open so replies (and brand new
// emails) sent to the support address turn into ticket activity in near
// real time, instead of only being reachable through the /support web form.
//   IMAP_HOST, IMAP_PORT (default 993), IMAP_USER, IMAP_PASS - mailbox creds
//   IMAP_TLS - 'false' to disable TLS (default on)
//   IMAP_CONN_TIMEOUT_MS / IMAP_AUTH_TIMEOUT_MS - handshake timeouts (default 10000)
//   SUPPORT_INBOX_POLL_MS - safety-net re-check interval on the already-open
//     connection, in case an IDLE notification is ever missed (default 60000)
// Needs `npm install imap mailparser`; without them (or without the env vars)
// this feature just stays off and everything else keeps working as before.
const SUPPORT_INBOX_POLL_MS = parseInt(process.env.SUPPORT_INBOX_POLL_MS || '60000', 10);

// Mail clients paste the entire prior message back into a reply (Gmail's
// "On <date> <person> wrote:" block, Outlook's "-----Original Message-----",
// or plain "> quoted" lines). We only want what the customer actually typed,
// so cut the body off at the first line that looks like the start of a quote.
function stripEmailQuote(text) {
    if (!text) return text;
    const lines = text.split(/\r?\n/);
    let cutoff = lines.length;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (/^on .{3,150}\bwrote:$/i.test(line) || /^-{2,}\s*original message\s*-{2,}$/i.test(line) || /^from:\s*.+$/i.test(line) || line.startsWith('>')) {
            cutoff = i;
            break;
        }
    }
    return lines.slice(0, cutoff).join('\n').trim();
}

function processInboundSupportEmail(mail) {
    const fromEntry = mail.from && mail.from.value && mail.from.value[0];
    const fromAddr = fromEntry ? fromEntry.address : null;
    if (!fromAddr) return;
    const fromName = (fromEntry.name || fromAddr).trim();

    // Never let our own outgoing address turn into a ticket/reply - stops a
    // feedback loop if this mailbox is used for both sending and receiving.
    const ourAddr = (process.env.SMTP_FROM || process.env.SMTP_USER || '').toLowerCase();
    if (ourAddr && fromAddr.toLowerCase() === ourAddr) return;

    const subject = (mail.subject || '(no subject)').trim();
    const body = stripEmailQuote((mail.text || '').trim()) || '(empty message)';
    const match = subject.match(/\[Ticket #(\d+)\]/i);

    if (match) {
        const ticketId = parseInt(match[1], 10);
        db.get(`SELECT id, username, status FROM Support_Tickets WHERE id = ?`, [ticketId], (err, ticket) => {
            if (err || !ticket) return; // unrecognized ticket tag - drop it silently
            db.run(`INSERT INTO Support_Ticket_Replies (ticket_id, admin_username, message, is_customer, customer_email) VALUES (?, ?, ?, 1, ?)`,
                [ticketId, fromName, body, fromAddr], (err2) => {
                    if (err2) return console.error('Failed to store inbound reply:', err2.message);
                    logAudit('support_ticket_customer_reply', fromName, ticket.username, `ticket #${ticketId} (via email)`);
                    if (ticket.status !== 'open') {
                        db.run(`UPDATE Support_Tickets SET status = 'open' WHERE id = ?`, [ticketId], () => {});
                    }
                });
        });
        return;
    }

    // No recognizable ticket tag - treat it as a brand new ticket.
    db.run(`INSERT INTO Support_Tickets (username, email, subject, message) VALUES (?, ?, ?, ?)`,
        [fromName, fromAddr, subject, body], function (err) {
            if (err) return console.error('Failed to create ticket from inbound email:', err.message);
            logAudit('support_ticket_submitted_by_email', fromName, fromName, `#${this.lastID}: ${subject}`);
        });
}

// Instead of reconnecting/authenticating on a timer (which is both slow to
// notice new mail and, against Gmail specifically, one of the things that
// seems to trigger the intermittent "Timed out while authenticating"
// errors), keep a single IMAP connection open and use IDLE so Gmail pushes
// new-mail notifications to us in real time. node-imap manages the actual
// IDLE/NOOP renewal internally once a mailbox is open; we just need to
// reconnect (with backoff) if the connection drops, and do an occasional
// safety-net search in case a 'mail' notification is ever missed - that
// safety-net check reuses the already-open connection, so it costs a search
// command, not a fresh login.
let supportImap = null;
let supportInboxReconnectTimer = null;
let supportInboxReconnectDelayMs = 5000;
const SUPPORT_INBOX_MAX_RECONNECT_MS = 5 * 60 * 1000; // cap backoff at 5 minutes
let supportInboxCheckInFlight = false;

function checkSupportInboxForUnseenMail(imap) {
    if (supportInboxCheckInFlight) return;
    supportInboxCheckInFlight = true;
    imap.search(['UNSEEN'], (err, uids) => {
        if (err) { console.error('Support inbox search error:', err.message); supportInboxCheckInFlight = false; return; }
        if (!uids || uids.length === 0) { supportInboxCheckInFlight = false; return; }

        const pending = [];
        const fetcher = imap.fetch(uids, { bodies: '', markSeen: true });
        fetcher.on('message', msg => {
            let buffer = '';
            msg.on('body', stream => { stream.on('data', chunk => { buffer += chunk.toString('utf8'); }); });
            msg.once('end', () => {
                pending.push(simpleParser(buffer).then(processInboundSupportEmail).catch(err => console.error('Support inbox parse error:', err.message)));
            });
        });
        fetcher.once('error', err => { console.error('Support inbox fetch error:', err.message); supportInboxCheckInFlight = false; });
        fetcher.once('end', () => { Promise.allSettled(pending).finally(() => { supportInboxCheckInFlight = false; }); });
    });
}

function scheduleSupportInboxReconnect() {
    if (supportInboxReconnectTimer) return; // already scheduled
    console.warn(`Support inbox reconnecting in ${Math.round(supportInboxReconnectDelayMs / 1000)}s`);
    supportInboxReconnectTimer = setTimeout(() => {
        supportInboxReconnectTimer = null;
        connectSupportInbox();
    }, supportInboxReconnectDelayMs);
    supportInboxReconnectDelayMs = Math.min(supportInboxReconnectDelayMs * 2, SUPPORT_INBOX_MAX_RECONNECT_MS);
}

function connectSupportInbox() {
    const imap = new ImapClient({
        user: process.env.IMAP_USER,
        password: process.env.IMAP_PASS,
        host: process.env.IMAP_HOST,
        port: parseInt(process.env.IMAP_PORT || '993', 10),
        tls: process.env.IMAP_TLS !== 'false',
        tlsOptions: { rejectUnauthorized: false },
        // Without explicit timeouts a stalled handshake (bad TLS/STARTTLS
        // mismatch, dropped packets, provider throttling) can hang far
        // longer than is useful before the library gives up on its own.
        connTimeout: parseInt(process.env.IMAP_CONN_TIMEOUT_MS || '10000', 10),
        authTimeout: parseInt(process.env.IMAP_AUTH_TIMEOUT_MS || '10000', 10),
        keepalive: true
    });
    supportImap = imap;

    imap.once('error', err => {
        console.error('Support inbox IMAP error:', err.message);
    });

    imap.once('end', () => {
        supportImap = null;
        scheduleSupportInboxReconnect();
    });

    imap.once('ready', () => {
        imap.openBox('INBOX', false, (err) => {
            if (err) { console.error('Support inbox open error:', err.message); imap.end(); return; }
            // Connected and logged in successfully - reset backoff.
            supportInboxReconnectDelayMs = 5000;

            // Catch up on anything that arrived while disconnected, then
            // let IDLE notify us of anything after that.
            checkSupportInboxForUnseenMail(imap);
            imap.on('mail', () => checkSupportInboxForUnseenMail(imap));

            // Belt-and-suspenders re-check in case an IDLE notification is
            // ever missed (e.g. a notification lost around a keepalive
            // renewal). Cheap - it's a search on the existing connection,
            // not a new login.
            const safetyNetTimer = setInterval(() => {
                if (supportImap === imap) checkSupportInboxForUnseenMail(imap);
                else clearInterval(safetyNetTimer);
            }, SUPPORT_INBOX_POLL_MS);
        });
    });

    imap.connect();
}

if (ImapClient && simpleParser && process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS) {
    connectSupportInbox();
} else if (!ImapClient || !simpleParser) {
    console.warn('imap/mailparser not installed (run `npm install imap mailparser`) - inbound emails will not be turned into support tickets.');
} else {
    console.warn('IMAP not configured (set IMAP_HOST, IMAP_USER, IMAP_PASS) - inbound emails will not be turned into support tickets.');
}

function sendPasswordResetEmail(toEmail, username, resetLink) {
    const subject = 'Reset your Biodeck password';
    const text = `Hi ${username},\n\nA password reset was requested for your Biodeck account. If this was you, click the link below to choose a new password. This link expires in 1 hour and can only be used once.\n\n${resetLink}\n\nIf you didn't request this, you can safely ignore this email - your password will not change.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>A password reset was requested for your Biodeck account. If this was you, click the link below to choose a new password. This link expires in 1 hour and can only be used once.</p><p><a href="${resetLink}">${resetLink}</a></p><p>If you didn't request this, you can safely ignore this email - your password will not change.</p>`;

    if (!mailTransporter) {
        console.log(`[password reset] SMTP not configured - link for ${toEmail}: ${resetLink}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send password reset email:', err.message));
}

// Returns { raw, hash }. Only `hash` (sha256 of raw) is stored in the DB;
// `raw` is the value that goes in the emailed link and is never persisted.
function generateResetToken() {
    const raw = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    return { raw, hash };
}
function hashResetToken(raw) {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

// ----- Email change verification codes -----
const EMAIL_CHANGE_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Returns { code, hash }. 6-digit numeric code, easy to type/read; only the
// sha256 hash is persisted, same pattern as password reset tokens.
function generateEmailChangeCode() {
    const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
    const hash = crypto.createHash('sha256').update(code).digest('hex');
    return { code, hash };
}
function hashEmailChangeCode(code) {
    return crypto.createHash('sha256').update(code).digest('hex');
}

function sendEmailChangeCodeEmail(toEmail, username, code, newEmail) {
    const subject = 'Confirm your Biodeck email change';
    const text = `Hi ${username},\n\nA request was made to change the email on your Biodeck account from this address to ${newEmail}. Enter this code on the dashboard to confirm the change. This code expires in 15 minutes and can only be used once.\n\nCode: ${code}\n\nIf you didn't request this, you can safely ignore this email - your email will not change.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>A request was made to change the email on your Biodeck account from this address to ${escapeHTML(newEmail)}. Enter this code on the dashboard to confirm the change. This code expires in 15 minutes and can only be used once.</p><p style="font-size:1.4em;font-weight:700;letter-spacing:2px;">${escapeHTML(code)}</p><p>If you didn't request this, you can safely ignore this email - your email will not change.</p>`;

    if (!mailTransporter) {
        console.log(`[email change] SMTP not configured - code for ${toEmail} (-> ${newEmail}): ${code}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send email change code:', err.message));
}

// ----- Email verification links -----
const EMAIL_VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const EMAIL_VERIFY_RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute, tracked in-memory below

// Returns { raw, hash }, same pattern as generateResetToken().
function generateEmailVerifyToken() {
    const raw = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    return { raw, hash };
}
function hashEmailVerifyToken(raw) {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

function sendVerifyEmail(toEmail, username, verifyLink) {
    const subject = 'Verify your Biodeck email address';
    const text = `Hi ${username},\n\nPlease confirm this is your email address by clicking the link below. This link expires in 24 hours and can only be used once.\n\n${verifyLink}\n\nIf you didn't create a Biodeck account, you can safely ignore this email.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>Please confirm this is your email address by clicking the link below. This link expires in 24 hours and can only be used once.</p><p><a href="${verifyLink}">${verifyLink}</a></p><p>If you didn't create a Biodeck account, you can safely ignore this email.</p>`;

    if (!mailTransporter) {
        console.log(`[email verify] SMTP not configured - link for ${toEmail}: ${verifyLink}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send verification email:', err.message));
}

// ----- Account moderation emails (ban / unban / delete / permanent delete) -----
function sendAccountBannedEmail(toEmail, username, reason, expiresAt) {
    const subject = 'Your Biodeck account has been banned';
    const cleanReason = reason || 'No reason provided';
    const expiryText = expiresAt ? `\n\nThis ban expires: ${new Date(expiresAt).toLocaleString()}` : '';
    const expiryHtml = expiresAt ? `<p><strong>Expires:</strong> ${escapeHTML(new Date(expiresAt).toLocaleString())}</p>` : '';
    const text = `Hi ${username},\n\nYour Biodeck account has been banned.\n\nReason: ${cleanReason}${expiryText}\n\nIf you believe this is a mistake, contact an administrator.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>Your Biodeck account has been banned.</p><p><strong>Reason:</strong> ${escapeHTML(cleanReason)}</p>${expiryHtml}<p>If you believe this is a mistake, contact an administrator.</p>`;

    if (!mailTransporter) {
        console.log(`[account banned] SMTP not configured - would have emailed ${toEmail}: ${cleanReason}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send account banned email:', err.message));
}

function sendAccountUnbannedEmail(toEmail, username) {
    const subject = 'Your Biodeck account has been unbanned';
    const text = `Hi ${username},\n\nYour Biodeck account has been unbanned. You can log back in whenever you're ready.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>Your Biodeck account has been unbanned. You can log back in whenever you're ready.</p>`;

    if (!mailTransporter) {
        console.log(`[account unbanned] SMTP not configured - would have emailed ${toEmail}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send account unbanned email:', err.message));
}

// Sent when a timed ban expires on its own (as opposed to an admin manually
// unbanning via sendAccountUnbannedEmail above) - worded to make clear this
// wasn't a manual admin action.
function sendBanExpiredEmail(toEmail, username) {
    const subject = 'Your Biodeck ban has expired';
    const text = `Hi ${username},\n\nThe temporary ban on your Biodeck account has expired and your access has been restored. You can log back in whenever you're ready.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>The temporary ban on your Biodeck account has expired and your access has been restored. You can log back in whenever you're ready.</p>`;

    if (!mailTransporter) {
        console.log(`[ban expired] SMTP not configured - would have emailed ${toEmail}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send ban expired email:', err.message));
}

// Sent for the soft delete (admin resets the profile and marks IsDeleted, but
// the row and username are kept).
function sendAccountDeletedEmail(toEmail, username, reason) {
    const subject = 'Your Biodeck account has been deleted';
    const cleanReason = reason || 'No reason provided';
    const text = `Hi ${username},\n\nYour Biodeck account has been deleted by an administrator. Your posts have been removed and your profile has been reset.\n\nReason: ${cleanReason}\n\nIf you believe this is a mistake, contact an administrator.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>Your Biodeck account has been deleted by an administrator. Your posts have been removed and your profile has been reset.</p><p><strong>Reason:</strong> ${escapeHTML(cleanReason)}</p><p>If you believe this is a mistake, contact an administrator.</p>`;

    if (!mailTransporter) {
        console.log(`[account deleted] SMTP not configured - would have emailed ${toEmail}: ${cleanReason}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send account deleted email:', err.message));
}

// Sent for the hard delete - covers both the admin "Delete From Database"
// action and a user deleting their own account, since the outcome (account
// and all its data permanently gone) is the same either way.
function sendAccountPermanentlyDeletedEmail(toEmail, username, reason) {
    const subject = 'Your Biodeck account has been permanently deleted';
    const cleanReason = reason || 'No reason provided';
    const text = `Hi ${username},\n\nYour Biodeck account and all of its data (posts, messages, group chats, follows, friends, and notifications) have been permanently deleted. This cannot be undone.\n\nReason: ${cleanReason}\n\nIf you believe this is a mistake, contact an administrator.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>Your Biodeck account and all of its data (posts, messages, group chats, follows, friends, and notifications) have been permanently deleted. This cannot be undone.</p><p><strong>Reason:</strong> ${escapeHTML(cleanReason)}</p><p>If you believe this is a mistake, contact an administrator.</p>`;

    if (!mailTransporter) {
        console.log(`[account permanently deleted] SMTP not configured - would have emailed ${toEmail}: ${cleanReason}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send account permanently deleted email:', err.message));
}

// Sent when an admin issues a warning against an account's standing.
// `extras` is optional: { mute_chat, expires_at, removed_content,
// removed_attachments_json } - same shape as a Warnings row, passed through
// to getWarningExtras() to render the "you can't chat" / "content removed"
// sections (activeOnly: false since the warning was just created, so it's
// active by definition regardless of expires_at).
function sendWarningEmail(toEmail, username, reason, expiresAt, extras) {
    const subject = 'You have received a warning on Biodeck';
    const cleanReason = reason || 'No reason provided';
    const expiryText = expiresAt ? `\n\nThis warning expires: ${new Date(expiresAt).toLocaleString()}` : '\n\nThis warning does not expire.';
    const expiryHtml = expiresAt ? `<p><strong>Expires:</strong> ${escapeHTML(new Date(expiresAt).toLocaleString())}</p>` : `<p><strong>Expires:</strong> Never</p>`;
    const extrasRow = extras ? { ...extras, expires_at: expiresAt } : null;
    const extrasText = extrasRow ? getWarningExtras(extrasRow, 'text', { activeOnly: false }) : [];
    const extrasHtml = extrasRow ? getWarningExtras(extrasRow, 'html', { activeOnly: false }) : [];
    const extrasTextBlock = extrasText.length ? `\n\n${extrasText.join('\n\n')}` : '';
    const extrasHtmlBlock = extrasHtml.length ? extrasHtml.join('') : '';
    const text = `Hi ${username},\n\nYour Biodeck account has received a warning.\n\nReason: ${cleanReason}${expiryText}${extrasTextBlock}\n\nEnough active warnings can affect your account standing. You can review your standing and warning history from your dashboard.\n\nIf you believe this is a mistake, contact an administrator.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>Your Biodeck account has received a warning.</p><p><strong>Reason:</strong> ${escapeHTML(cleanReason)}</p>${expiryHtml}${extrasHtmlBlock}<p>Enough active warnings can affect your account standing. You can review your standing and warning history from your dashboard.</p><p>If you believe this is a mistake, contact an administrator.</p>`;

    if (!mailTransporter) {
        console.log(`[warning issued] SMTP not configured - would have emailed ${toEmail}: ${cleanReason}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send warning email:', err.message));
}

// Sent when a warning is manually revoked early by an admin. Naturally
// expired warnings do NOT trigger this - only an explicit revoke action.
function sendWarningRevokedEmail(toEmail, username, reason) {
    const subject = 'A warning on your Biodeck account has been removed';
    const cleanReason = reason || 'No reason provided';
    const text = `Hi ${username},\n\nA warning on your Biodeck account has been removed by an administrator and no longer counts toward your account standing.\n\nOriginal reason: ${cleanReason}\n\nIf you have questions, contact an administrator.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>A warning on your Biodeck account has been removed by an administrator and no longer counts toward your account standing.</p><p><strong>Original reason:</strong> ${escapeHTML(cleanReason)}</p><p>If you have questions, contact an administrator.</p>`;

    if (!mailTransporter) {
        console.log(`[warning revoked] SMTP not configured - would have emailed ${toEmail}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send warning revoked email:', err.message));
}

// Sent to the submitter's own contact email right after they file a ticket,
// just to confirm it was received - not a substitute for an actual reply
// (see sendSupportReplyEmail), which comes later from the admin ticket page.
// The "[Ticket #N]" tag in the subject is load-bearing: if the customer hits
// reply, most mail clients keep it in the "Re:" subject, which is how
// pollSupportInbox() matches an inbound reply back to this ticket.
function sendSupportTicketConfirmationEmail(ticket) {
    const subject = `[Ticket #${ticket.id}] We've received your support ticket`;
    const text = `Hello ${ticket.username},\n\nWe've received your support ticket and will review it.\n\nThis is an automated message.`;
    const html = `<p>Hello ${escapeHTML(ticket.username)},</p><p>We've received your support ticket and will review it.</p><p style="opacity:0.6;font-size:0.9em;">This is an automated message.</p>`;

    if (!mailTransporter) {
        console.log(`[support ticket confirmation] SMTP not configured - would have emailed ${ticket.email} for ticket #${ticket.id}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: ticket.email,
        subject, text, html
    }).catch(err => console.error('Failed to send support ticket confirmation email:', err.message));
}

// Sent to the ticket's contact email when an admin replies from the
// /admin/support/:id page. Unlike the other transactional emails here, there's
// no in-app equivalent to fall back to - the reply's whole point is to reach
// the person by email - so if SMTP isn't configured this just logs loudly
// rather than silently pretending it sent.
function sendSupportReplyEmail(ticket, replyMessage, adminUsername) {
    const subject = `Re: [Ticket #${ticket.id}] ${ticket.subject}`;
    const text = `Hi ${ticket.username},\n\nYou recently contacted Biodeck support about "${ticket.subject}" (ticket #${ticket.id}). Here's a reply from our team:\n\n${replyMessage}\n\n---\nYour original message:\n${ticket.message}`;
    const html = `<p>Hi ${escapeHTML(ticket.username)},</p>
        <p>You recently contacted Biodeck support about "${escapeHTML(ticket.subject)}" (ticket #${ticket.id}). Here's a reply from our team:</p>
        <p>${escapeHTML(replyMessage).replace(/\n/g, '<br>')}</p>
        <hr>
        <p style="opacity:0.7;font-size:0.9em;"><strong>Your original message:</strong><br>${escapeHTML(ticket.message).replace(/\n/g, '<br>')}</p>`;

    if (!mailTransporter) {
        console.log(`[support reply] SMTP not configured - reply to ${ticket.email} for ticket #${ticket.id} was NOT sent: ${replyMessage}`);
        return Promise.resolve(false);
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: ticket.email,
        subject, text, html
    }).then(() => true).catch(err => {
        console.error('Failed to send support reply email:', err.message);
        return false;
    });
}

// Invalidates any outstanding verification links for the user, creates a new
// one for `email`, and sends it. Callers should have already set
// email_verified = 0 on the account before calling this.
function issueEmailVerification(userId, username, email, callback) {
    db.run(`UPDATE Email_Verifications SET used = 1 WHERE user_id = ? AND used = 0`, [userId], () => {
        const { raw, hash } = generateEmailVerifyToken();
        const expiresAt = new Date(Date.now() + EMAIL_VERIFY_TOKEN_TTL_MS).toISOString();
        db.run(`INSERT INTO Email_Verifications (user_id, token_hash, email, expires_at) VALUES (?, ?, ?, ?)`,
            [userId, hash, email, expiresAt], (err) => {
                if (err) { console.error('Email verification insert error:', err.message); if (callback) callback(err); return; }
                const verifyLink = `${APP_BASE_URL}/account/verify-email?token=${raw}`;
                sendVerifyEmail(email, username, verifyLink);
                if (callback) callback(null);
            });
    });
}

// Renders the same box/button chrome used elsewhere (ban/deleted screens, etc.)
function renderMessagePage(title, heading, bodyHTML) {
    return `<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHTML(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
</head>
<body>
    <div class="box" style="color: var(--text-color); height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box; padding: 30px;">
        <h1>${escapeHTML(heading)}</h1><br>
        ${bodyHTML}
    </div>
    <script>
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => {
                btn.classList.add('clicked');
                setTimeout(() => btn.classList.remove('clicked'), 150);
            });
        });
    </script>
</body>
</html>`;
}

// Blocks any fully-logged-in session whose email hasn't been verified yet,
// bouncing it to the verify-email hold page. Mirrors checkBan's approach of
// gating every request rather than just the login route, so an account can't
// dodge verification by jumping straight to a bookmarked page.
function checkEmailVerified(req, res, next) {
    if (!req.session.userId) return next();
    // Let the verification flow itself, and logging out, stay reachable.
    if (req.path === '/account/verify-email' || req.path.startsWith('/account/verify-email-required') || req.path === '/logout') {
        return next();
    }
    db.get(`SELECT email, email_verified FROM User_Data WHERE id = ?`, [req.session.userId], (err, user) => {
        if (err || !user) return next();
        if (user.email && !user.email_verified) {
            const userId = req.session.userId;
            const username = req.session.userUsername;
            req.session.pendingVerifyUserId = userId;
            req.session.pendingVerifyUsername = username;
            delete req.session.userId;
            delete req.session.userUsername;
            return res.redirect('/account/verify-email-required');
        }
        next();
    });
}

app.use(checkIPBan);
app.use(checkBan);
app.use(checkEmailVerified);

// SSE stream for per-user server-push events (ban notifications, etc.)
// Only reachable by non-banned users because checkIPBan/checkBan run first.
app.get('/api/user-events/stream', (req, res) => {
    if (!req.session || !req.session.userId) return res.status(401).end();
    const userId = req.session.userId;
    const ip = getClientIP(req);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');

    const onEvent = (payload) => sseSend(res, payload.event, payload);
    userBus.on(`user:${userId}`, onEvent);

    const conn = { userId, ip, res };
    userEventConnections.add(conn);

    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);

    req.on('close', () => {
        clearInterval(keepAlive);
        userBus.removeListener(`user:${userId}`, onEvent);
        userEventConnections.delete(conn);
    });
});

// /api/check-ban-status is intentionally placed AFTER the ban middleware above.
// This means banned users are blocked before they can reach this endpoint -
// preventing the bypass where a client fakes the response to avoid the ban screen.
app.get('/api/check-ban-status', (req, res) => {
    const ip = getClientIP(req);
    db.get(`SELECT reason FROM IP_Bans WHERE ip = ?`, [ip], (err, ipRow) => {
        if (!err && ipRow) {
            return res.json({ banned: true, type: 'ip', reason: ipRow.reason || 'No reason provided' });
        }
        if (!req.session || !req.session.userId) {
            return res.json({ banned: false });
        }
        db.get(`SELECT IsBanned, BanReason, BanExpiresAt, IsDeleted, DeleteReason FROM User_Data WHERE id = ?`, [req.session.userId], (err2, user) => {
            if (!err2 && user && user.IsDeleted == 1) {
                return res.json({ banned: true, type: 'deleted', reason: user.DeleteReason || 'No reason provided' });
            }
            if (!err2 && user && user.IsBanned == 1) {
                if (user.BanExpiresAt && new Date(user.BanExpiresAt).getTime() <= Date.now()) {
                    clearExpiredBan(req.session.userId);
                    return res.json({ banned: false });
                }
                return res.json({ banned: true, type: 'account', reason: user.BanReason || 'No reason provided', expiresAt: user.BanExpiresAt || null });
            }
            res.json({ banned: false });
        });
    });
});

app.get('/register', (req, res) => {
    if (req.session.userId) return res.redirect('/feed');
    res.sendFile(path.join(__dirname, 'register.html'));
})

app.get('/', (req, res) => {
    if (req.session.userId) return res.redirect('/feed');
    res.sendFile(path.join(__dirname, 'login.html'));
});

// Login/register had no rate limiting at all, so a script could try
// thousands of passwords per minute against one account (credential
// stuffing / brute force) or mass-create accounts. This caps attempts per
// IP; it's intentionally separate from postRateLimiter further down so
// tuning one doesn't affect the other.
const rateLimitForAuth = require('express-rate-limit');
const authLimiter = rateLimitForAuth({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait a few minutes and try again.' }
});

app.post('/register', authLimiter, async (req, res) => {
    const { username, password } = req.body;
    const email = (req.body.email || '').trim().toLowerCase();

    if (!username || !password) {
        return res.sendFile(path.join(__dirname, 'register_error_missing_fields.html'));
    }
    if (username.length < 3 || username.length > 32) {
        return res.sendFile(path.join(__dirname, 'register_error_invalid_length.html'));
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
        return res.sendFile(path.join(__dirname, 'register_error_invalid_chars.html'));
    }
    if (!email) {
        return res.status(400).send(renderMessagePage('Missing Email', 'An email address is required',
            `<h3>Every account needs an email so you can reset your password later.</h3><br><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/register';">Go back</button>`));
    }
    if (!EMAIL_REGEX.test(email)) {
        return res.status(400).send(renderMessagePage('Invalid Email', 'That doesn\'t look like a valid email',
            `<h3>Please double check the email address and try again.</h3><br><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/register';">Go back</button>`));
    }
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const gateEnabled = registrationGateEnabled;
        const initialIsBanned = gateEnabled ? 1 : 0;
        const initialBanReason = gateEnabled
            ? "Account creation is currently disabled, please contact biodecksupport@gmail.com to activate your account, a message was also sent to admins"
            : null;

        db.run(`INSERT INTO User_Data (username, password, email, email_verified, IsBanned, BanReason, avatar_path) VALUES (?, ?, ?, 0, ?, ?, ?)`, [username, hashedPassword, email, initialIsBanned, initialBanReason, 'public/Default.png'], function(err) {
            if (err) {
                console.error("Database Insert Error:", err.message);
                return res.sendFile(path.join(__dirname, 'register_error_username_taken.html'));
            }
            const newUserId = this.lastID;
            logAudit('account_created', username, username, gateEnabled ? 'registration gate ON - created pending activation' : 'registration gate OFF - created active');

            // Activation gating pings only fire while the registration gate is
            // enabled. While it's off, registration is open and nobody gets
            // pinged.
            if (gateEnabled) {
                // Post a notice in the reserved "Activations" group chat (id 1) so
                // admins/mods watching it see new signups awaiting activation, and
                // ping the user with id 1 (typically the owner/head admin).
                db.get(`SELECT username FROM User_Data WHERE id = 1`, (errPing, pingUser) => {
                    const pingSuffix = pingUser ? ` @${pingUser.username}` : '';
                    const gcContent = `${username} is waiting for activation${pingSuffix}`;
                    db.run(`INSERT INTO Group_Chat_Messages (group_id, from_user, content) VALUES (1, 'System', ?)`,
                        [gcContent], function (errGC) {
                            if (errGC) { console.error('Activation notice insert error:', errGC.message); return; }
                            const gcMsgId = this.lastID;
                            db.get(`SELECT Group_Chat_Messages.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified FROM Group_Chat_Messages LEFT JOIN User_Data ON Group_Chat_Messages.from_user = User_Data.username WHERE Group_Chat_Messages.id = ?`, [gcMsgId], (errRow, row) => {
                                if (errRow || !row) return;
                                db.all(`SELECT username FROM Group_Chat_Members WHERE group_id = 1`, (errMem, memberRows) => {
                                    const members = (memberRows || []).map(r => r.username);
                                    broadcastGCMessage(1, 'System', row, null, members);
                                });
                            });
                            if (pingUser) {
                                processMentions(gcContent, 'System', { type: 'mention_gc', post_id: 1, message_id: gcMsgId });
                            }
                        });

                    // DM the same notice to user id 1 plus anyone listed in the
                    // local activation-pings.txt file, once each, skipping
                    // whoever doesn't actually have an account.
                    const dmContent = `${username} is waiting for activation`;
                    const candidateUsernames = new Set(getActivationPingUsernames());
                    if (pingUser) candidateUsernames.add(pingUser.username);
                    if (candidateUsernames.size) {
                        const usernameList = [...candidateUsernames];
                        const placeholders = usernameList.map(() => '?').join(',');
                        db.all(`SELECT username FROM User_Data WHERE username IN (${placeholders})`, usernameList, (errDM, rows) => {
                            if (errDM || !rows) return;
                            rows.forEach(r => sendSystemDM(r.username, dmContent));
                        });
                    }
                });
            }

            db.get(`SELECT IsBanned, BanReason FROM User_Data WHERE id = ?`, [newUserId], (err2, newUser) => {
                if (err2 || !newUser) return res.redirect('/');
                if (newUser.IsBanned) {
                    const reason = newUser.BanReason || 'No reason provided';
                    return res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Banned</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
</head>
<body>
    <div class="box" style="color: var(--text-color); height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box;">
        <h1>The ban hammer has struck you</h1><br>
        <h3>Ban Reason: ${escapeHTML(reason)}</h3><br><br>
        <button type="submit" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>
    </div>
    <script>
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => {
                btn.classList.add('clicked');
                setTimeout(() => btn.classList.remove('clicked'), 150);
            });
        });
    </script>

</body>
</html>`);
                }
                const registerIP = getClientIP(req);
                recordLoginIP(newUserId, username, registerIP, 'register');
                // New accounts start with email_verified = 0, so hold them in
                // the same "pending" session state used elsewhere until they
                // confirm the address, instead of granting a full session.
                req.session.pendingVerifyUserId = newUserId;
                req.session.pendingVerifyUsername = username;
                issueEmailVerification(newUserId, username, email, () => {});
                return res.redirect('/account/verify-email-required');
            });
        });
    } catch (err) {
        console.error("Register error:", err);
        return res.status(500).sendFile(path.join(__dirname, 'register_error_internal.html'));
    }
});

// A password hash that's never assigned to a real account. Used below so a
// login attempt for a nonexistent username still runs a bcrypt.compare of
// roughly the same cost as a real one - otherwise the "no such user" path
// returns near-instantly while a real username takes ~100ms for the hash
// check, and that timing gap lets an attacker enumerate valid usernames
// without ever seeing an error message that says so.
const DUMMY_BCRYPT_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8p/K.hM7X1Gj1AqNU9CIsCzZbwjIYq';

app.post('/login', authLimiter, (req, res) => {
    const { username, password } = req.body;

    db.get(`SELECT * FROM User_Data WHERE username = ?`, [username], async (err, user) => {
        if (err) {
            console.error("Database Login Error:", err.message);
            return res.status(500).sendFile(path.join(__dirname, 'login_error_internal.html'));
        }

        if (!user) {
            await bcrypt.compare(password || '', DUMMY_BCRYPT_HASH);
            return res.status(401).sendFile(path.join(__dirname, 'login_error_invalid_credentials.html'));
        }

        try {
            const match = await bcrypt.compare(password, user.password);
            if (match) {
                if (user.IsDeleted) {
                    const reason = user.DeleteReason || 'No reason provided';
                    const deletedWarnings = await new Promise((resolve) => getWarningsForUser(user.username, (e, w) => resolve(w || [])));
                    const deletedWarningsHTML = renderWarningsTableHTML(deletedWarnings);
                    return res.status(401).send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Account Deleted</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
<style>
    html, body {
        height: auto !important;
        min-height: 100% !important;
        overflow-y: auto !important;
    }
    body {
        margin: 0 !important;
        display: flex !important;
        align-items: flex-start !important;
        justify-content: center !important;
    }
</style>
</head>
<body>
    <div class="box" style="color: var(--text-color); height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box; margin: 40px auto; overflow-y: visible;">
        ${renderAvatarBlockHTML(user.avatar_path, user.username)}
        <h1>Your account has been deleted</h1><br>
        <h3>Reason: ${escapeHTML(reason)}</h3><br><br>
        ${renderStandingBlockHTML('Deleted')}
        ${deletedWarningsHTML}<br>
        <button type="submit" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>
    </div>
    <script>
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => {
                btn.classList.add('clicked');
                setTimeout(() => btn.classList.remove('clicked'), 150);
            });
        });
    </script>

</body>
</html>`);
                }
                if (user.IsBanned && user.BanExpiresAt && new Date(user.BanExpiresAt).getTime() <= Date.now()) {
                    // Timed ban has expired - clear it (and email the user) and let the login proceed.
                    clearExpiredBan(user.id);
                    user.IsBanned = 0;
                }
                if (user.IsBanned) {
                    const reason = user.BanReason || 'No reason provided';
                    const expiryLine = user.BanExpiresAt
                        ? `<h3>Ban Expires: ${escapeHTML(new Date(user.BanExpiresAt).toLocaleString())}</h3><br><br>`
                        : '';
                    const bannedWarnings = await new Promise((resolve) => getWarningsForUser(user.username, (e, w) => resolve(w || [])));
                    const bannedWarningsHTML = renderWarningsTableHTML(bannedWarnings);
                    return res.status(401).send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Banned</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
<style>
    html, body {
        height: auto !important;
        min-height: 100% !important;
        overflow-y: auto !important;
    }
    body {
        margin: 0 !important;
        display: flex !important;
        align-items: flex-start !important;
        justify-content: center !important;
    }
</style>
</head>
<body>
    <div class="box" style="color: var(--text-color); height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box; margin: 40px auto; overflow-y: visible;">
        ${renderAvatarBlockHTML(user.avatar_path, user.username)}
        <h1>The ban hammer has struck you</h1><br>
        <h3>Ban Reason: ${escapeHTML(reason)}</h3><br><br>
        ${expiryLine}
        ${renderStandingBlockHTML('Banned')}
        ${bannedWarningsHTML}<br>
        <button type="submit" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>
    </div>
    <script>
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => {
                btn.classList.add('clicked');
                setTimeout(() => btn.classList.remove('clicked'), 150);
            });
        });
    </script>

</body>
</html>`);
                }
                if (!user.email) {
                    // Older accounts predate the email requirement. Hold them in a
                    // "pending" session state (no userId yet) until they add one,
                    // so nothing else in the app is reachable in the meantime.
                    req.session.pendingEmailUserId = user.id;
                    req.session.pendingEmailUsername = user.username;
                    return res.redirect('/account/add-email');
                }
                if (!user.email_verified) {
                    // Email present but not confirmed yet. Hold them in the same
                    // kind of "pending" session state until they verify it (or
                    // switch to a different address and verify that instead).
                    req.session.pendingVerifyUserId = user.id;
                    req.session.pendingVerifyUsername = user.username;
                    return res.redirect('/account/verify-email-required');
                }
                // Regenerate the session here so a pre-existing (and possibly
                // attacker-planted) session ID can't ride along into an
                // authenticated session - this swaps in a fresh session ID
                // before granting the login, closing a session-fixation gap.
                req.session.regenerate((regenErr) => {
                    if (regenErr) {
                        console.error('Session regenerate error:', regenErr.message);
                        return res.status(500).sendFile(path.join(__dirname, 'login_error_auth_exception.html'));
                    }
                    req.session.userId = user.id;
                    req.session.userUsername = user.username;
                    const loginIP = getClientIP(req);
                    recordLoginIP(user.id, user.username, loginIP, 'login');
                    return res.redirect('/feed');
                });
            } else {
                return res.status(401).sendFile(path.join(__dirname, 'login_error_invalid_credentials.html'));
            }
        } catch (error) {
            console.error(error);
            return res.status(500).sendFile(path.join(__dirname, 'login_error_auth_exception.html'));
        }
    });
});

// ----- Add email (forced, one-time, for pre-existing accounts) -----
app.get('/account/add-email', (req, res) => {
    if (req.session.userId) return res.redirect('/feed');
    if (!req.session.pendingEmailUserId) return res.redirect('/');
    const username = escapeHTML(req.session.pendingEmailUsername || '');
    res.send(renderMessagePage('Add Email', 'One more thing',
        `<h3>We now require an email on every account so you can reset your password if you forget it. Add one to finish logging in as <strong>${username}</strong>.</h3><br>
        <form method="POST" action="/account/add-email" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
            <input type="text" name="email" placeholder="Email address" required style="width: 260px;">
            <button type="submit" class="button" style="width: 150px;">Continue</button>
        </form>`));
});

app.post('/account/add-email', (req, res) => {
    if (!req.session.pendingEmailUserId) return res.redirect('/');
    const userId = req.session.pendingEmailUserId;
    const email = (req.body.email || '').trim().toLowerCase();

    if (!email || !EMAIL_REGEX.test(email)) {
        return res.status(400).send(renderMessagePage('Invalid Email', 'That doesn\'t look like a valid email',
            `<h3>Please double check the email address and try again.</h3><br><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/account/add-email';">Go back</button>`));
    }

    db.run(`UPDATE User_Data SET email = ?, email_verified = 0 WHERE id = ?`, [email, userId], function(err) {
        if (err) {
            console.error('Add email error:', err.message);
            return res.status(500).send(renderMessagePage('Error', 'Something went wrong',
                `<h3>Please try again.</h3><br><br>
                <button type="button" class="button" style="width: 150px" onclick="window.location.href='/account/add-email';">Go back</button>`));
        }
        const username = req.session.pendingEmailUsername;
        delete req.session.pendingEmailUserId;
        delete req.session.pendingEmailUsername;
        const loginIP = getClientIP(req);
        recordLoginIP(userId, username, loginIP, 'add-email');
        logAudit('email_added', username, username, 'added email on login (pre-existing account)');
        // The address hasn't been confirmed yet, so route into the same
        // verification hold used everywhere else instead of logging in.
        req.session.pendingVerifyUserId = userId;
        req.session.pendingVerifyUsername = username;
        issueEmailVerification(userId, username, email, () => {});
        return res.redirect('/account/verify-email-required');
    });
});

// ----- Verify email (forced, blocks the app until confirmed) -----
// Small in-memory cooldown so the resend button can't be used to spam an
// address. Keyed by user id; fine to lose on restart.
const lastVerifyResendAt = new Map();

app.get('/account/verify-email-required', (req, res) => {
    if (!req.session.pendingVerifyUserId) return res.redirect('/');
    const userId = req.session.pendingVerifyUserId;
    const username = escapeHTML(req.session.pendingVerifyUsername || '');

    db.get(`SELECT email FROM User_Data WHERE id = ?`, [userId], (err, user) => {
        const email = (user && user.email) ? user.email : '';
        res.send(renderMessagePage('Verify Email', 'Confirm your email',
            `<h3>We sent a verification link to <strong>${escapeHTML(email)}</strong>. Click it to finish logging in as <strong>${username}</strong>.</h3><br>
            <form method="POST" action="/account/verify-email-required/resend" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
                <button type="submit" class="button" style="width: 220px;">Resend verification email</button>
            </form><br>
            <p style="opacity:0.7;">Used the wrong address, or don't have access to it anymore?</p>
            <form method="POST" action="/account/verify-email-required/change" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
                <input type="text" name="email" placeholder="New email address" required style="width: 260px;">
                <button type="submit" class="button" style="width: 220px;">Use a different email</button>
            </form><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/logout';">Log out</button>`));
    });
});

app.post('/account/verify-email-required/resend', (req, res) => {
    if (!req.session.pendingVerifyUserId) return res.redirect('/');
    const userId = req.session.pendingVerifyUserId;
    const username = req.session.pendingVerifyUsername;

    const lastSent = lastVerifyResendAt.get(userId) || 0;
    if (Date.now() - lastSent < EMAIL_VERIFY_RESEND_COOLDOWN_MS) {
        return res.status(429).send(renderMessagePage('Slow Down', 'Please wait a moment',
            `<h3>A verification email was just sent. Give it a minute before requesting another.</h3><br><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/account/verify-email-required';">Go back</button>`));
    }

    db.get(`SELECT email FROM User_Data WHERE id = ?`, [userId], (err, user) => {
        if (err || !user || !user.email) return res.redirect('/account/verify-email-required');
        lastVerifyResendAt.set(userId, Date.now());
        issueEmailVerification(userId, username, user.email, () => {});
        logAudit('email_verification_resent', username, username, null);
        return res.redirect('/account/verify-email-required');
    });
});

app.post('/account/verify-email-required/change', (req, res) => {
    if (!req.session.pendingVerifyUserId) return res.redirect('/');
    const userId = req.session.pendingVerifyUserId;
    const username = req.session.pendingVerifyUsername;
    const email = (req.body.email || '').trim().toLowerCase();

    if (!email || !EMAIL_REGEX.test(email)) {
        return res.status(400).send(renderMessagePage('Invalid Email', 'That doesn\'t look like a valid email',
            `<h3>Please double check the email address and try again.</h3><br><br>
            <button type="button" class="button" style="width: 150px" onclick="window.location.href='/account/verify-email-required';">Go back</button>`));
    }

    // Accounts are allowed to share an email address, so there's no
    // uniqueness check here - just swap it in and send a fresh link.
    db.run(`UPDATE User_Data SET email = ?, email_verified = 0 WHERE id = ?`, [email, userId], (err) => {
        if (err) {
            console.error('Change pending email error:', err.message);
            return res.status(500).send(renderMessagePage('Error', 'Something went wrong',
                `<h3>Please try again.</h3><br><br>
                <button type="button" class="button" style="width: 150px" onclick="window.location.href='/account/verify-email-required';">Go back</button>`));
        }
        lastVerifyResendAt.set(userId, Date.now());
        issueEmailVerification(userId, username, email, () => {});
        logAudit('email_changed', username, username, `to ${email} (while unverified)`);
        return res.redirect('/account/verify-email-required');
    });
});

app.get('/account/verify-email', (req, res) => {
    const token = req.query.token || '';
    if (!token) return res.redirect('/');
    const tokenHash = hashEmailVerifyToken(token);

    db.get(`SELECT * FROM Email_Verifications WHERE token_hash = ?`, [tokenHash], (err, verifyRow) => {
        if (err || !verifyRow || verifyRow.used || new Date(verifyRow.expires_at) < new Date()) {
            return res.status(400).send(renderMessagePage('Link Expired', 'This verification link is no longer valid',
                `<h3>It may have expired or already been used. Log in to request a new one.</h3><br><br>
                <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Go to login</button>`));
        }
        db.get(`SELECT * FROM User_Data WHERE id = ?`, [verifyRow.user_id], (err2, user) => {
            if (err2 || !user) return res.redirect('/');
            // If the account's email changed after this link was sent, the
            // link is stale even though it hasn't technically expired yet.
            if (!user.email || user.email.toLowerCase() !== verifyRow.email.toLowerCase()) {
                return res.status(400).send(renderMessagePage('Link Expired', 'This verification link is no longer valid',
                    `<h3>The email on this account has changed since this link was sent. Log in to request a new one.</h3><br><br>
                    <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Go to login</button>`));
            }
            db.run(`UPDATE User_Data SET email_verified = 1 WHERE id = ?`, [user.id], (err3) => {
                if (err3) {
                    console.error('Email verify update error:', err3.message);
                    return res.status(500).send(renderMessagePage('Error', 'Something went wrong', `<h3>Please try again.</h3>`));
                }
                db.run(`UPDATE Email_Verifications SET used = 1 WHERE id = ?`, [verifyRow.id], () => {});
                logAudit('email_verified', user.username, user.username, null);

                // Same session-fixation guard as /login: swap in a fresh
                // session ID before this request's session gains
                // authenticated (or re-authenticated) status. This also
                // naturally clears any pendingVerify* hold from the old
                // session, since regenerate() starts from an empty one.
                req.session.regenerate((regenErr) => {
                    if (regenErr) {
                        console.error('Session regenerate error:', regenErr.message);
                        return res.status(500).send(renderMessagePage('Error', 'Something went wrong', `<h3>Please try again.</h3>`));
                    }
                    req.session.userId = user.id;
                    req.session.userUsername = user.username;
                    return res.send(renderMessagePage('Email Verified', 'You\'re all set',
                        `<h3>Your email has been verified.</h3><br><br>
                        <button type="button" class="button" style="width: 150px" onclick="window.location.href='/feed';">Continue</button>`));
                });
            });
        });
    });
});

// ----- Forgot / reset password -----
app.get('/forgot-password', (req, res) => {
    if (req.session.userId) return res.redirect('/feed');
    // Only username is accepted here, not email - since the same email can
    // now be linked to more than one account, an email lookup could return
    // several matches and there'd be no safe way to know which one to reset.
    res.send(renderMessagePage('Forgot Password', 'Reset your password',
        `<h3>Enter your username and we'll send a reset link to the email linked to that account.</h3><br>
        <form method="POST" action="/forgot-password" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
            <input type="text" name="username" placeholder="Username" required style="width: 260px;">
            <button type="submit" class="button" style="width: 180px;">Send reset link</button>
        </form><br>
        <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Back to login</button>`));
});

// Unauthenticated and previously had no rate limit at all - anyone could
// repeatedly POST a valid username and cause an unlimited stream of
// password-reset emails to that account's inbox (email bombing), plus
// unbounded rows in Password_Resets. Reuses the same per-IP budget as
// login/register/support.
app.post('/forgot-password', authLimiter, (req, res) => {
    const username = (req.body.username || '').trim();
    // Always show the same response either way, so this endpoint can't be used
    // to probe which usernames have accounts.
    const done = () => res.send(renderMessagePage('Forgot Password', 'Check your email',
        `<h3>If that username has an account, we've sent a password reset link to its email address. The link expires in 1 hour.</h3><br><br>
        <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Back to login</button>`));

    if (!username) return done();

    db.get(`SELECT * FROM User_Data WHERE username = ? COLLATE NOCASE`, [username], (err, user) => {
        if (err || !user || !user.email || user.IsDeleted) return done();

        const { raw, hash } = generateResetToken();
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
        db.run(`INSERT INTO Password_Resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
            [user.id, hash, expiresAt], (err2) => {
                if (err2) { console.error('Password reset insert error:', err2.message); return done(); }
                const resetLink = `${APP_BASE_URL}/reset-password?token=${raw}`;
                sendPasswordResetEmail(user.email, user.username, resetLink);
                logAudit('password_reset_requested', user.username, user.username, 'via username');
                return done();
            });
    });
});

app.get('/reset-password', (req, res) => {
    const token = req.query.token || '';
    if (!token) return res.redirect('/forgot-password');
    const tokenHash = hashResetToken(token);

    db.get(`SELECT * FROM Password_Resets WHERE token_hash = ?`, [tokenHash], (err, resetRow) => {
        if (err || !resetRow || resetRow.used || new Date(resetRow.expires_at) < new Date()) {
            return res.status(400).send(renderMessagePage('Link Expired', 'This reset link is no longer valid',
                `<h3>It may have expired or already been used. Request a new one below.</h3><br><br>
                <button type="button" class="button" style="width: 180px" onclick="window.location.href='/forgot-password';">Request new link</button>`));
        }
        res.send(renderMessagePage('Reset Password', 'Choose a new password',
            `<form method="POST" action="/reset-password" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
                <input type="hidden" name="token" value="${escapeHTML(token)}">
                <input type="password" name="password" placeholder="New password" required style="width: 260px;">
                <input type="password" name="confirm_password" placeholder="Confirm new password" required style="width: 260px;">
                <button type="submit" class="button" style="width: 150px;">Reset password</button>
            </form>`));
    });
});

app.post('/reset-password', async (req, res) => {
    const token = req.body.token || '';
    const { password, confirm_password } = req.body;
    if (!token) return res.redirect('/forgot-password');
    const tokenHash = hashResetToken(token);

    const showForm = (message) => res.status(400).send(renderMessagePage('Reset Password', 'Choose a new password',
        `<h3 style="color: var(--danger-light-color);">${escapeHTML(message)}</h3><br>
        <form method="POST" action="/reset-password" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
            <input type="hidden" name="token" value="${escapeHTML(token)}">
            <input type="password" name="password" placeholder="New password" required style="width: 260px;">
            <input type="password" name="confirm_password" placeholder="Confirm new password" required style="width: 260px;">
            <button type="submit" class="button" style="width: 150px;">Reset password</button>
        </form>`));

    if (!password || password.length < 6) return showForm('Password must be at least 6 characters.');
    if (password !== confirm_password) return showForm('Passwords do not match.');

    db.get(`SELECT * FROM Password_Resets WHERE token_hash = ?`, [tokenHash], async (err, resetRow) => {
        if (err || !resetRow || resetRow.used || new Date(resetRow.expires_at) < new Date()) {
            return res.status(400).send(renderMessagePage('Link Expired', 'This reset link is no longer valid',
                `<h3>It may have expired or already been used. Request a new one below.</h3><br><br>
                <button type="button" class="button" style="width: 180px" onclick="window.location.href='/forgot-password';">Request new link</button>`));
        }
        try {
            const hashedPassword = await bcrypt.hash(password, 10);
            db.run(`UPDATE User_Data SET password = ? WHERE id = ?`, [hashedPassword, resetRow.user_id], (err2) => {
                if (err2) {
                    console.error('Password reset update error:', err2.message);
                    return showForm('Something went wrong. Please try again.');
                }
                // Mark this token used and invalidate any other outstanding tokens
                // for this account, so an old email link can't be replayed later.
                db.run(`UPDATE Password_Resets SET used = 1 WHERE user_id = ?`, [resetRow.user_id], () => {});
                db.get(`SELECT username FROM User_Data WHERE id = ?`, [resetRow.user_id], (err3, u) => {
                    logAudit('password_reset_completed', u ? u.username : 'unknown', u ? u.username : null, null);
                });
                return res.send(renderMessagePage('Password Reset', 'Your password has been reset',
                    `<h3>You can now log in with your new password.</h3><br><br>
                    <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Go to login</button>`));
            });
        } catch (e) {
            console.error('Password reset hash error:', e);
            return showForm('Something went wrong. Please try again.');
        }
    });
});

// ----- Support form -----
// Reachable without logging in. The submitter must specify the account
// username and email so support staff have something to look the account up
// by, even though nothing here is verified against actual account records
// (that lookup, if needed, happens on the support side).
const MAX_SUPPORT_SUBJECT_LENGTH = 150;
const MAX_SUPPORT_MSG_LENGTH = 2000;

function renderSupportForm(opts) {
    opts = opts || {};
    const errorHTML = opts.error
        ? `<h3 style="color: var(--danger-light-color);">${escapeHTML(opts.error)}</h3><br>`
        : '';
    const v = opts.values || {};
    return renderMessagePage('Support', 'Contact support',
        `<h3>Need help with your account? Fill this out and we'll get back to you at the email you provide.</h3><br>
        ${errorHTML}
        <form method="POST" action="/support" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
            <input type="text" name="username" placeholder="Account username" required maxlength="32" value="${escapeHTML(v.username || '')}" style="width: 260px;">
            <input type="text" name="email" placeholder="Contact email" required style="width: 260px;" value="${escapeHTML(v.email || '')}">
            <input type="text" name="subject" placeholder="Subject" required maxlength="${MAX_SUPPORT_SUBJECT_LENGTH}" value="${escapeHTML(v.subject || '')}" style="width: 260px;">
            <textarea class="box" name="message" placeholder="How can we help?" required maxlength="${MAX_SUPPORT_MSG_LENGTH}" rows="6" style="width: 260px; resize: vertical; font-family: inherit; padding: 8px; box-sizing: border-box;">${escapeHTML(v.message || '')}</textarea>
            <button type="submit" class="button" style="width: 180px;">Send</button>
        </form><br>
        <button type="button" class="button" style="width: 150px" onclick="history.back()">Back</button>`);
}

app.get('/support', (req, res) => {
    const prefillUsername = req.session.userUsername || '';
    res.send(renderSupportForm({ values: { username: prefillUsername } }));
});

// This form is reachable without logging in, so without a rate limit it was
// an open spam/flood vector: unlimited DB rows plus an outbound confirmation
// email per submission, with no cost to the requester. Reuses authLimiter's
// same per-IP budget as login/register.
app.post('/support', authLimiter, (req, res) => {
    const username = (req.body.username || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const subject = (req.body.subject || '').trim();
    const message = (req.body.message || '').trim();
    const values = { username, email, subject, message };

    if (!username) return res.status(400).send(renderSupportForm({ error: 'Account username is required.', values }));
    if (!email || !EMAIL_REGEX.test(email)) return res.status(400).send(renderSupportForm({ error: 'A valid contact email is required.', values }));
    if (!subject) return res.status(400).send(renderSupportForm({ error: 'Subject is required.', values }));
    if (subject.length > MAX_SUPPORT_SUBJECT_LENGTH) return res.status(400).send(renderSupportForm({ error: `Subject is too long - ${MAX_SUPPORT_SUBJECT_LENGTH} character limit.`, values }));
    if (!message) return res.status(400).send(renderSupportForm({ error: 'Please describe the issue.', values }));
    if (message.length > MAX_SUPPORT_MSG_LENGTH) return res.status(400).send(renderSupportForm({ error: `Message too long - ${MAX_SUPPORT_MSG_LENGTH} character limit.`, values }));

    const ip = getClientIP(req);
    db.run(`INSERT INTO Support_Tickets (username, email, subject, message, ip) VALUES (?, ?, ?, ?, ?)`,
        [username, email, subject, message, ip], function (err) {
            if (err) {
                console.error('Support ticket insert error:', err.message);
                return res.status(500).send(renderSupportForm({ error: 'Something went wrong. Please try again.', values }));
            }
            const ticket = { id: this.lastID, username, email, subject, message };
            sendSupportTicketConfirmationEmail(ticket);
            logAudit('support_ticket_submitted', username, username, `#${ticket.id}: ${subject}`);
            return res.send(renderMessagePage('Support', 'Message sent',
                `<h3>Thanks - we've received your message and will get back to you at ${escapeHTML(email)}.</h3><br><br>
                <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Back to login</button>`));
        });
});

app.get('/edit', (req, res) => {
    if (!req.session.userId) return res.redirect('/');

    db.get(`SELECT bio, avatar_path, Nickname, email, theme FROM User_Data WHERE id = ?`, [req.session.userId], (err, user) => {
        const bio = (user && user.bio) ? user.bio : '';
        const avatarPath = (user && user.avatar_path) ? user.avatar_path : null;
        const nickname = (user && user.Nickname) ? user.Nickname : '';
        const email = (user && user.email) ? user.email : '';
        const currentTheme = (user && user.theme) ? user.theme : 'default';
        const themeOptionsHTML = loadThemes().map(t =>
            `<option value="${escapeHTML(t.name)}"${t.name === currentTheme ? ' selected' : ''}>${escapeHTML(t.displayName)}</option>`
        ).join('');
        res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dashboard</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
</head>
<body class="page-edit">
    <div class="box dashboard-box">
        <h1>Dashboard</h1>
        <p style="opacity:0.6;">@${req.session.userUsername}</p>
        <div class="dash-field" style="text-align:center;">
        </div>
        <div class="dash-field" style="text-align:center;">
            <label>Profile Picture</label>
            <div style="display:flex;justify-content:center;margin-bottom:10px;">
                ${renderAvatarHTML(avatarPath, req.session.userUsername, 84)}
            </div>
            <form action="/edit/avatar" method="POST" enctype="multipart/form-data" style="display:flex;flex-direction:column;align-items:center;gap:8px;">
                <input type="file" id="avatar-input" name="avatar" accept="image/*" style="display:none;">
                <label for="avatar-input" class="button" style="width:160px;">Choose Image</label>
                <span id="avatar-file-name" style="font-size:0.78em;opacity:0.65;">No file chosen</span>
                <button class="button" type="submit" style="width:160px;">Upload</button>
            </form>
        </div>
        <form action="/edit/nickname" method="POST">
            <div class="dash-field">
                <label>Nickname <span style="opacity:0.4;">(shown instead of your username - spaces allowed. Your @username stays the same and is the only way people can ping you)</span></label>
                <input class="dash-textarea" style="min-height:unset;" type="text" name="nickname" id="nickname-input" placeholder="e.g. Cool Guy" maxlength="32" value="${escapeHTML(nickname)}">
            </div>
            <button class="button" type="submit" style="width: auto;margin-top:8px;">Save Nickname</button>
        </form>
        <form action="/edit/bio" method="POST">
            <div class="dash-field">
                <label>Bio</label>
                <textarea class="dash-textarea" name="bio" id="bio-textarea" placeholder="Tell people about yourself..." maxlength="1000">${bio}</textarea>
            </div>
            <button class="button" type="submit" style="width:120px;margin-top:8px;">Save Bio</button>
        </form>
        <div class="dash-field">
            <label>Email</label>
            <p id="current-email-display" style="margin:0 0 10px;opacity:0.8;">${email ? 'Current: ' + escapeHTML(email) : '<span style="opacity:0.5;">No email on file.</span>'}</p>
            ${email ? `
            <div id="email-change-step1">
                <input class="dash-textarea" style="min-height:unset;" type="text" id="new-email-input" placeholder="New email address" autocomplete="off">
                <button class="button" type="button" onclick="requestEmailCode()" style="width:auto;margin-top:8px;">Send code to current email</button>
            </div>
            <div id="email-change-step2" style="display:none;margin-top:14px;">
                <p style="opacity:0.7;margin:0 0 8px;">We sent a code to <span id="email-code-sent-to"></span>. Enter it below to confirm the change to <span id="email-code-new-addr"></span>.</p>
                <input class="dash-textarea" style="min-height:unset;" type="text" id="email-code-input" placeholder="6-digit code" maxlength="6" autocomplete="off">
                <div style="display:flex;gap:8px;margin-top:8px;">
                    <button class="button" type="button" onclick="confirmEmailChange()" style="width:auto;">Confirm change</button>
                    <button class="button" type="button" onclick="cancelEmailChange()" style="width:auto;">Cancel</button>
                </div>
            </div>
            <div id="email-change-result" style="margin-top:8px;font-size:0.85em;"></div>
            ` : `<button class="button" type="button" onclick="window.location.href='/account/add-email';" style="width:auto;">Add Email</button>`}
        </div>
        <form action="/edit/theme" method="POST">
            <div class="dash-field">
                <label>Theme <span style="opacity:0.4;">(changes how Biodeck looks for you)</span></label>
                <select class="dash-textarea" style="min-height:unset;" name="theme" id="theme-select">
                    ${themeOptionsHTML}
                </select>
            </div>
            <button class="button" type="submit" style="width:auto;margin-top:8px;margin-bottom:8px;">Save Theme</button>
        </form>
        <div class="dash-links">
                <button class="button" style="width:120px;" onclick="window.location.href='/standing';">Standing</button>
                <button class="button" style="width:120px;" onclick="window.location.href='/feed';">Feed</button>
                <button class="button" style="width:120px;" onclick="window.location.href='/messages';">Messages</button>
                <button class="button notif-nav-link" style="padding:10px;width: auto;" onclick="window.location.href='/notifications';">Notifications</button>
                <button class="button" style="width:120px;" onclick="window.location.href='/followers';">Followers</button>
                <button class="button" style="width:120px;" onclick="window.location.href='/user/${req.session.userUsername}';">My Profile</button>
                <button class="button" style="width:120px;" onclick="window.location.href='/support';">Support</button>
        </div>
        <hr style="border-color:rgba(255,80,80,0.3);margin:26px 0 14px;">
        <div class="dash-field" style="text-align:center;">
            <h3 style="color:var(--danger-strong-color);margin-bottom:4px;">Danger Zone</h3>
            <p style="opacity:0.6;font-size:0.82em;">Deleting your account is <strong>permanent</strong>. It removes your posts, DMs, group chat messages and memberships, follows, friends, friend requests, and notifications from the database. There is no way to undo this or recover your data afterward.</p>
            <button class="button" type="button" onclick="openDeleteAccountBox()" style="width:auto;">Delete My Account</button>
            <div id="delete-account-box" style="display:none;margin-top:14px;text-align:left;">
                <label>Enter your password to confirm</label>
                <input class="dash-textarea" style="min-height:unset;" type="password" id="delete-account-password" placeholder="Current password" autocomplete="current-password">
                <div style="display:flex;gap:8px;margin-top:8px;justify-content:center;">
                    <button class="button" type="button" onclick="confirmDeleteAccount()" style="width:auto;">Permanently Delete Everything</button>
                    <button class="button" type="button" onclick="closeDeleteAccountBox()" style="width:auto;">Cancel</button>
                </div>
                <div id="delete-account-result" style="margin-top:8px;font-size:0.85em;text-align:center;"></div>
            </div>
        </div>
    </div>
    <script>
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => { btn.classList.add('clicked'); setTimeout(() => btn.classList.remove('clicked'), 150); });
        });

        document.getElementById('avatar-input').addEventListener('change', function () {
            document.getElementById('avatar-file-name').textContent = this.files.length ? this.files[0].name : 'No file chosen';
        });

        const bioEl = document.getElementById('bio-textarea');
        const bioCounter = document.createElement('div');
        bioCounter.style.cssText = 'font-size:0.75em;opacity:0.5;text-align:right;margin-top:4px;';
        bioCounter.textContent = bioEl.value.length + ' / 1000';
        bioEl.parentNode.insertBefore(bioCounter, bioEl.nextSibling);
        bioEl.addEventListener('input', function () {
            const len = this.value.length;
            bioCounter.textContent = len + ' / 1000';
            bioCounter.style.color = len > 900 ? (len >= 1000 ? 'var(--danger-color)' : 'var(--warning-color)') : '';
            bioCounter.style.opacity = len > 900 ? '1' : '0.5';
        });

        if (new URLSearchParams(window.location.search).get('nicknameerror')) {
            const t = document.createElement('div');
            t.textContent = 'Nickname too long - 32 character limit.';
            t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:var(--text-color);padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 4000);
            window.history.replaceState(null, '', '/edit');
        }

        if (new URLSearchParams(window.location.search).get('bioerror')) {
            const t = document.createElement('div');
            t.textContent = 'Bio too long - 1,000 character limit.';
            t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:var(--text-color);padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 4000);
            window.history.replaceState(null, '', '/edit');
        }

        if (new URLSearchParams(window.location.search).get('themeerror')) {
            const t = document.createElement('div');
            t.textContent = 'That theme is not available.';
            t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:var(--text-color);padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 4000);
            window.history.replaceState(null, '', '/edit');
        }

        let pendingNewEmail = '';

        async function requestEmailCode() {
            const newEmailInput = document.getElementById('new-email-input');
            const resultEl = document.getElementById('email-change-result');
            const newEmail = newEmailInput.value.trim();
            if (!newEmail) { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = 'Enter a new email address.'; return; }
            resultEl.style.color = ''; resultEl.textContent = 'Sending code...';
            try {
                const r = await fetch('/account/email/request-code', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ new_email: newEmail })
                });
                const d = await r.json();
                if (!r.ok) { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = d.error || 'Could not send code.'; return; }
                pendingNewEmail = newEmail;
                document.getElementById('email-code-sent-to').textContent = d.sent_to;
                document.getElementById('email-code-new-addr').textContent = newEmail;
                document.getElementById('email-change-step1').style.display = 'none';
                document.getElementById('email-change-step2').style.display = 'block';
                resultEl.style.color = ''; resultEl.textContent = '';
            } catch (e) { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = 'Network error.'; }
        }

        async function confirmEmailChange() {
            const codeInput = document.getElementById('email-code-input');
            const resultEl = document.getElementById('email-change-result');
            const code = codeInput.value.trim();
            if (!code) { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = 'Enter the code from your email.'; return; }
            resultEl.style.color = ''; resultEl.textContent = 'Confirming...';
            try {
                const r = await fetch('/account/email/confirm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code })
                });
                const d = await r.json();
                if (!r.ok) { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = d.error || 'Could not confirm code.'; return; }
                resultEl.style.color = 'var(--accent-color)'; resultEl.textContent = 'Email updated!';
                document.getElementById('current-email-display').textContent = 'Current: ' + pendingNewEmail;
                document.getElementById('new-email-input').value = '';
                codeInput.value = '';
                document.getElementById('email-change-step2').style.display = 'none';
                document.getElementById('email-change-step1').style.display = 'block';
                setTimeout(() => { resultEl.textContent = ''; }, 3000);
            } catch (e) { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = 'Network error.'; }
        }

        function cancelEmailChange() {
            pendingNewEmail = '';
            document.getElementById('email-code-input').value = '';
            document.getElementById('email-change-step2').style.display = 'none';
            document.getElementById('email-change-step1').style.display = 'block';
            document.getElementById('email-change-result').textContent = '';
        }

        function openDeleteAccountBox() {
            document.getElementById('delete-account-box').style.display = 'block';
        }

        function closeDeleteAccountBox() {
            document.getElementById('delete-account-box').style.display = 'none';
            document.getElementById('delete-account-password').value = '';
            document.getElementById('delete-account-result').textContent = '';
        }

        async function confirmDeleteAccount() {
            const password = document.getElementById('delete-account-password').value;
            const resultEl = document.getElementById('delete-account-result');
            if (!password) { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = 'Enter your password to confirm.'; return; }
            if (!confirm('This will PERMANENTLY delete your account and all of your data. This cannot be undone. Continue?')) return;

            resultEl.style.color = ''; resultEl.textContent = 'Deleting...';
            try {
                const r = await fetch('/account/delete-self', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });
                const d = await r.json();
                if (!r.ok) { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = d.error || 'Could not delete account.'; return; }
                resultEl.style.color = 'var(--accent-color)'; resultEl.textContent = 'Account deleted. Redirecting...';
                setTimeout(() => window.location.href = '/', 1200);
            } catch (e) { resultEl.style.color = 'var(--danger-light-color)'; resultEl.textContent = 'Network error.'; }
        }

        if (new URLSearchParams(window.location.search).get('avatarerror')) {
            const t = document.createElement('div');
            t.textContent = 'Could not upload profile picture - please use an image file under 8MB.';
            t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgb(255,60,60);color:var(--text-color);padding:10px 20px;border-radius:8px;z-index:999;font-size:0.9em;';
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 4000);
            window.history.replaceState(null, '', '/edit');
        }
    </script>
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${REPORT_SCRIPT}

</body>
</html>`);
    });
});

app.get('/standing', (req, res) => {
    if (!req.session.userId) return res.redirect('/');

    db.get(`SELECT avatar_path FROM User_Data WHERE id = ?`, [req.session.userId], (err, user) => {
        const avatarPath = (user && user.avatar_path) ? user.avatar_path : null;
        getWarningsForUser(req.session.userUsername, (errW, warnings) => {
            warnings = warnings || [];
            const activeCount = warnings.filter(isWarningActive).length;
            const standing = getStanding(activeCount);
            const warningsHTML = renderWarningsSummaryHTML(warnings);
            res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Account Standing</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
</head>
<body class="page-edit">
    <div class="box dashboard-box">
        <div style="display:flex;justify-content:center;margin-bottom:10px;">
            ${renderAvatarHTML(avatarPath, req.session.userUsername, 84)}
        </div>
        <h2 style="margin:0 0 14px;">@${escapeHTML(req.session.userUsername)}</h2>
        <div style="margin-bottom:18px;">
            <div style="opacity:0.6;font-size:0.85em;margin-bottom:4px;">Account Standing</div>
            <div style="font-size:1.3em;color:${standing.color};font-weight:700;">${escapeHTML(standing.label)}</div>
            <div style="opacity:0.6;font-size:0.85em;margin-top:2px;">${standing.count} active warning${standing.count === 1 ? '' : 's'}</div>
        </div>
        ${warningsHTML}
        <div class="dash-links">
            <button class="button" style="width:auto;" onclick="window.location.href='/edit';">Back to dashboard</button>
        </div>
    </div>
</body>
</html>`);
        });
    });
});

// Detail page for a single warning, linked from the /standing overview
// table. Shows the reason plus a plain "What this affects" section (mute
// and/or removed content, or "None" if the warning doesn't carry either) -
// kept off the overview table itself so that stays a quick scannable list.
// Scoped to the logged-in user's own warnings only; an id belonging to
// someone else (or that doesn't exist) 404s the same way a bad report id
// does on the admin side.
app.get('/standing/:id', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const id = parseInt(req.params.id, 10);
    const notFound = () => res.status(404).send(renderMessagePage('Not Found', 'Warning not found', `<h3>That warning doesn't exist.</h3><br><br><button type="button" class="button" style="width: 180px" onclick="window.location.href='/standing';">Back to standing</button>`));
    if (!Number.isInteger(id)) return notFound();

    db.get(`SELECT id, username, reason, issued_by, created_at, expires_at, mute_chat, removed_content, removed_attachments_json, report_id, account_action FROM Warnings WHERE id = ?`, [id], (err, warning) => {
        if (err) return res.status(500).send('DB error');
        if (!warning || warning.username !== req.session.userUsername) return notFound();

        const active = isWarningActive(warning);
        const statusHtml = active ? '<span style="color:var(--danger-color);font-weight:700;">Active</span>' : '<span style="opacity:0.5;">Expired</span>';
        const affectsParts = getWarningExtras(warning, 'html');
        const affectsHtml = affectsParts.length ? affectsParts.join('') : '<p style="opacity:0.6;">None</p>';

        res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Warning #${warning.id}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
</head>
<body class="page-edit">
    <div class="box dashboard-box" style="text-align:left;">
        <p><a href="/standing" style="color:var(--text-color);opacity:0.6;text-decoration:none;">&lt; Back to standing</a></p>
        <h2 style="margin:10px 0 4px;">Warning #${warning.id}</h2>
        <p style="opacity:0.5;font-size:0.85em;margin-top:-2px;">Issued ${escapeHTML(new Date(warning.created_at.replace(' ','T')+'Z').toLocaleString())}</p>
        <hr style="border-color:rgba(255,255,255,0.15);margin:14px 0;">
        <p style="font-size:0.9em;"><strong>Reason:</strong></p>
        <p style="white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;">${escapeHTML(warning.reason) || '<span style="opacity:0.4;">(no reason given)</span>'}</p>
        <p style="font-size:0.9em;"><strong>Expires:</strong> ${warning.expires_at ? escapeHTML(new Date(warning.expires_at).toLocaleString()) : 'Never'}</p>
        <p style="font-size:0.9em;"><strong>Status:</strong> ${statusHtml}</p>
        <hr style="border-color:rgba(255,255,255,0.15);margin:14px 0;">
        <p style="font-size:0.9em;margin-bottom:6px;"><strong>What this affects:</strong></p>
        ${affectsHtml}
        <div class="dash-links" style="margin-top:16px;">
            <button class="button" style="width:auto;" onclick="window.location.href='/standing';">Back to standing</button>
        </div>
    </div>
</body>
</html>`);
    });
});

// Self-service, permanent account deletion. Requires the user's current
// password as confirmation, then wipes the account and everything tied to
// it via the same hardDeleteAccount() helper the admin hard-delete route
// uses (defined further down, alongside the admin routes).
app.post('/account/delete-self', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'not logged in' });
    const password = (req.body && req.body.password) || '';
    if (!password) return res.status(400).json({ error: 'password is required' });
    const userId = req.session.userId;
    const username = req.session.userUsername;
    db.get(`SELECT password FROM User_Data WHERE id = ?`, [userId], async (err, user) => {
        if (err || !user) return res.status(500).json({ error: 'db error' });
        let match = false;
        try {
            match = await bcrypt.compare(password, user.password);
        } catch (e) {
            return res.status(500).json({ error: 'auth error' });
        }
        if (!match) return res.status(401).json({ error: 'incorrect password' });
        hardDeleteAccount(username, 'You deleted your own account', (err2) => {
            if (err2) {
                console.error('Self-delete error:', err2.message);
                return res.status(500).json({ error: 'db error' });
            }
            logAudit('account_self_deleted', username, username, 'user deleted their own account');
            req.session.destroy(() => {
                res.json({ ok: true, deleted: true });
            });
        });
    });
});

app.post('/edit/nickname', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    let { nickname } = req.body;
    nickname = (nickname || '').trim();
    if (nickname.length > MAX_NICKNAME_LENGTH) return res.redirect('/edit?nicknameerror=1');
    db.run(`UPDATE User_Data SET Nickname = ? WHERE id = ?`, [nickname || null, req.session.userId], () => res.redirect('/edit'));
});

app.post('/edit/bio', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const { bio } = req.body;
    if (bio && bio.length > MAX_BIO_LENGTH) return res.redirect('/edit?bioerror=1');
    db.run(`UPDATE User_Data SET bio = ? WHERE id = ?`, [bio || '', req.session.userId], () => res.redirect('/edit'));
});

app.post('/edit/avatar', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    avatarUpload.single('avatar')(req, res, (err) => {
        if (err || !req.file) return res.redirect('/edit?avatarerror=1');
        db.run(`UPDATE User_Data SET avatar_path = ? WHERE id = ?`, [req.file.path, req.session.userId], () => res.redirect('/edit'));
    });
});

app.post('/edit/theme', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const { theme } = req.body;
    const valid = loadThemes().some(t => t.name === theme);
    if (!valid) return res.redirect('/edit?themeerror=1');
    db.run(`UPDATE User_Data SET theme = ? WHERE id = ?`, [theme, req.session.userId], () => res.redirect('/edit'));
});

// ----- Self-service email change (from the dashboard) -----
// Step 1: user submits the new address they want. We email a 6-digit code
// to the CURRENT address on file (not the new one) - this proves whoever
// is requesting the change still controls the existing account, the same
// way password resets prove control via the existing email.
app.post('/account/email/request-code', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const userId = req.session.userId;
    const newEmail = (req.body.new_email || '').trim().toLowerCase();

    if (!newEmail || !EMAIL_REGEX.test(newEmail)) {
        return res.status(400).json({ error: 'That doesn\'t look like a valid email.' });
    }

    db.get(`SELECT username, email FROM User_Data WHERE id = ?`, [userId], (err, user) => {
        if (err) return res.status(500).json({ error: 'Something went wrong.' });
        if (!user) return res.status(404).json({ error: 'Account not found.' });
        if (!user.email) {
            return res.status(400).json({ error: 'Your account has no email on file yet - add one first.' });
        }
        if (newEmail === user.email.toLowerCase()) {
            return res.status(400).json({ error: 'That\'s already your current email.' });
        }
        db.get(`SELECT id FROM User_Data WHERE email = ? COLLATE NOCASE AND id != ?`, [newEmail, userId], (err2, taken) => {
            if (err2) return res.status(500).json({ error: 'Something went wrong.' });
            if (taken) return res.status(400).json({ error: 'That email is already linked to another account.' });

            const { code, hash } = generateEmailChangeCode();
            const expiresAt = new Date(Date.now() + EMAIL_CHANGE_CODE_TTL_MS).toISOString();
            db.run(`INSERT INTO Email_Changes (user_id, code_hash, new_email, expires_at) VALUES (?, ?, ?, ?)`,
                [userId, hash, newEmail, expiresAt], (err3) => {
                    if (err3) { console.error('Email change insert error:', err3.message); return res.status(500).json({ error: 'Something went wrong.' }); }
                    sendEmailChangeCodeEmail(user.email, user.username, code, newEmail);
                    logAudit('email_change_requested', user.username, user.username, `to ${newEmail}`);
                    res.json({ ok: true, sent_to: user.email });
                });
        });
    });
});

// Step 2: user enters the code that was emailed to their current address.
// On success the account's email is updated to the address captured in
// step 1 (re-checked for uniqueness in case it was taken in the meantime).
app.post('/account/email/confirm', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const userId = req.session.userId;
    const code = (req.body.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Enter the code from your email.' });
    const codeHash = hashEmailChangeCode(code);

    db.get(`SELECT * FROM Email_Changes WHERE user_id = ? AND code_hash = ? ORDER BY id DESC LIMIT 1`, [userId, codeHash], (err, changeRow) => {
        if (err) return res.status(500).json({ error: 'Something went wrong.' });
        if (!changeRow || changeRow.used || new Date(changeRow.expires_at) < new Date()) {
            return res.status(400).json({ error: 'That code is invalid or has expired - request a new one.' });
        }
        db.get(`SELECT id FROM User_Data WHERE email = ? COLLATE NOCASE AND id != ?`, [changeRow.new_email, userId], (err2, taken) => {
            if (err2) return res.status(500).json({ error: 'Something went wrong.' });
            if (taken) return res.status(400).json({ error: 'That email is already linked to another account - request the change again with a different address.' });

            db.run(`UPDATE User_Data SET email = ? WHERE id = ?`, [changeRow.new_email, userId], (err3) => {
                if (err3) {
                    if (err3.message && err3.message.includes('.email')) {
                        return res.status(400).json({ error: 'That email is already linked to another account.' });
                    }
                    console.error('Email change update error:', err3.message);
                    return res.status(500).json({ error: 'Something went wrong.' });
                }
                // Mark this code used and invalidate any other outstanding
                // requests for this account, same pattern as password resets.
                db.run(`UPDATE Email_Changes SET used = 1 WHERE user_id = ?`, [userId], () => {});
                db.get(`SELECT username FROM User_Data WHERE id = ?`, [userId], (err4, u) => {
                    logAudit('email_changed', u ? u.username : 'unknown', u ? u.username : null, `to ${changeRow.new_email}`);
                });
                res.json({ ok: true, email: changeRow.new_email });
            });
        });
    });
});

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
                if (r.url && r.url.includes('posterror=muted')) {
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
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${REPORT_SCRIPT}

</body>
</html>`);
    });
    });
});

	const rateLimit = require('express-rate-limit');
const postRateLimiter = rateLimit({
    windowMs: 5 * 1000,
    max: 10,
    message: 'please stop spamming',
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
        const replyTo = req.body && req.body.reply_to ? parseInt(req.body.reply_to) : null;
        const backTo = replyTo ? `/post/${replyTo}` : '/feed';
        //res.redirect(429, `${backTo}?posterror=ratelimit`);
        res.status(429).send("please stop spamming");
    }
});
app.post('/feed/post', postRateLimiter, (req, res, next) => {
    uploadFeed.array('attachments', MAX_FILES_FEED)(req, res, (err) => {
        if (err) {
            const backTo = req.body && req.body.reply_to ? `/post/${parseInt(req.body.reply_to)}` : '/feed';
            if (err.code === 'LIMIT_FILE_COUNT') return res.redirect(`${backTo}?posterror=files`);
            if (err.code === 'FILE_TYPE_BLOCKED') return res.redirect(`${backTo}?posterror=filetype`);
            return res.redirect(`${backTo}?posterror=1`);
        }
        next();
    });
}, (req, res) => {
    if (!req.session.userId) return res.redirect('/');

    const { content, reply_to } = req.body;
    const files = req.files || [];
    const filesMeta = files.map(f => ({ path: f.path, name: f.originalname, size: f.size }));
    const filesJSON = filesMeta.length ? JSON.stringify(filesMeta) : null;
    // Keep the legacy single-file columns populated with the first attachment so
    // any old code path that still reads file_path/file_name keeps working.
    const filePath = files[0] ? files[0].path : null;
    const fileName = files[0] ? files[0].originalname : null;
    const replyTo = reply_to ? parseInt(reply_to) : null;
    const backTo = replyTo ? `/post/${replyTo}` : '/feed';

    isUserMuted(req.session.userUsername, (errMute, mute) => {
        if (!errMute && mute) return res.redirect(`${backTo}?posterror=muted`);

    if ((!content || !content.trim()) && !files.length) return res.redirect(backTo);
    if (content && content.length > MAX_POST_LENGTH) return res.redirect(`${backTo}?posterror=1`);

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

// Returns just the pinned-items strip HTML so the client can refresh it after
// a pin/unpin action without reloading the whole feed page.
app.get('/feed/pinned-bar', (req, res) => {
    if (!req.session.userId) return res.status(401).end();
    db.all(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.pinned = 1 ORDER BY Posts.created_at DESC`, [], (err, pinnedPosts) => {
        if (err) return res.status(500).end();
        res.send((pinnedPosts || []).map(renderPinnedItem).join(''));
    });
});

// Unified report endpoint for the "Report" button on feed posts, DMs, and
// group chat messages. Snapshots the reported content into the Reports
// table for admin review at /admin/reports. Verifies the reporter actually
// had access to the content (part of the DM, or a member of the group
// chat) before filing the report.
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
        // Authoritative duplicate check - this is what actually makes the
        // Report button spam-proof (the client just mirrors this so the
        // button looks disabled without a round trip every time).
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

// Returns the logged-in user's own list of already-filed reports (as
// {type, id} pairs) so the client can permanently grey out "Report"
// buttons/links for content this user already reported - including on a
// fresh page load, a different device, or content loaded after the initial
// page render (pagination, infinite scroll). See applyReportedState() in
// REPORT_SCRIPT.
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
        db.run(`DELETE FROM Posts WHERE id = ?`, [postId], (err) => {
            if (err) console.error('Delete error:', err.message);
            else cleanupAttachmentFiles(attachments);
            res.status(200).end();
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

app.get('/feed/exists', (req, res) => {
    // Read-only - allowed for guests too, so the post page's deletion polling
    // still works when viewing without an account.
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

// Lets clients poll for posts that have been edited since they were first rendered,
// so people other than the editor see the new content without a full page refresh.
// Returns the raw content (for a cheap client-side "did this change?" check) plus a
// freshly rendered card, but only for posts that are currently marked edited.
app.get('/feed/edits', (req, res) => {
    // Read-only - allowed for guests too, so the post page's edit polling
    // still works when viewing without an account.
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

function getFollowingList(username, cb) {
    db.all(`SELECT following_username FROM Follows WHERE follower_username = ?`, [username], (err, rows) => {
        if (err || !rows) return cb([username]);
        const list = rows.map(r => r.following_username);
        list.push(username);
        cb(list);
    });
}

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
                if (r.url && r.url.includes('posterror=muted')) {
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

        setInterval(pollFeed, 4000);
        setInterval(pollDeletions, 5000);
        setInterval(pollReplyCounts, 5000);
        setInterval(pollEdits, 5000);
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
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${REPORT_SCRIPT}

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

app.get('/post/:id', (req, res) => {
    // Posts are viewable by anyone with the link, logged in or not - only
    // the ability to reply (and other write actions like edit/delete/report)
    // requires an account. Those write endpoints already check
    // req.session.userId themselves, so guests simply don't get the UI for them.
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
                if (r.url && r.url.includes('posterror=muted')) {
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
${isLoggedIn ? `${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${REPORT_SCRIPT}` : ''}

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


app.post('/friend-request/send/:username', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const from = req.session.userUsername;
    const to = req.params.username;
    if (from === to) return res.status(400).json({ error: 'cannot friend yourself' });
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
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${REPORT_SCRIPT}

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
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${REPORT_SCRIPT}

</body>
</html>`);
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
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
                            <div class="post-content" style="margin-top:4px;">${escapeHTML(post.content)}</div>
                            ${fileHTML}
                        </div>`;
                    }).join('');

                    const dmBtn = isOwnProfile ? '' : `<a href="/messages/${escapeHTML(profileUsername)}" class="button" style="width:120px;text-decoration:none;">Message</a>`;
                    const followBtn = isOwnProfile ? '' : `<a id="follow-btn" class="button" onclick="toggleFollow()" style="width:120px;text-decoration:none;">${isFollowing ? 'Unfollow' : 'Follow'}</a>`;
                    const friendBtnHTML = isOwnProfile ? '' : `<a id="friend-btn" class="button" onclick="toggleFriend()" style="width:140px;text-decoration:none;">${
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
        <div id="profile-bio">${user.bio ? escapeHTML(user.bio) : '<span style="opacity:0.4;">No bio yet.</span>'}</div>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-bottom:20px;">
            ${dmBtn}
            ${followBtn}
            ${friendBtnHTML}
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
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${REPORT_SCRIPT}

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
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${REPORT_SCRIPT}

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
            <a href="/logout">Logout</a>
            <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
            <nav id="nav-dropdown">
                <a href="/messages">Inbox</a>
                <a href="/feed">Feed</a>
                <a href="/notifications" class="notif-nav-link">Notifications</a>
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
        const connIndicator = document.getElementById('chat-conn-indicator');
        function connectChatStream() {
            chatStream = new EventSource('/messages/${other}/stream');
            chatStream.addEventListener('open', () => {
                chatReconnectDelay = 1000;
                connIndicator.style.display = 'none';
            });
            chatStream.addEventListener('message', (e) => {
                try {
                    const data = JSON.parse(e.data);
                    appendNewMessage(data.id, data.html);
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
${REPORT_SCRIPT}
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

    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);

    req.on('close', () => {
        clearInterval(keepAlive);
        dmBus.removeListener(channel, onEvent);
    });
});

app.post('/messages/:username/send', (req, res, next) => {
    uploadDM.array('attachments', MAX_FILES_DM)(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: `Too many files - max ${MAX_FILES_DM} per message.` });
            if (err.code === 'FILE_TYPE_BLOCKED') return res.status(400).json({ error: err.message });
            return res.status(400).json({ error: 'Upload failed.' });
        }
        next();
    });
}, (req, res) => {
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

    recordPrivateUploads(files, { scope: 'dm', userA: me, userB: other });
    db.run(`INSERT INTO Messages (from_user, to_user, content, file_path, file_name, files_json, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [me, other, (content || '').trim(), filePath, fileName, filesJSON, replyTo], function (err) {
            if (err) return res.status(500).json({ error: 'Failed to send message.' });
            const newId = this.lastID;
            const preview = (content || '').trim().slice(0, 140) || (filesMeta.length ? `Sent ${filesMeta.length > 1 ? filesMeta.length + ' files' : 'a file: ' + filesMeta[0].name}` : '');
            createNotification({ username: other, type: 'dm', actor_username: me, message_id: newId, content_preview: preview });
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
        db.run(`DELETE FROM Messages WHERE id = ?`, [msgId], (err2) => {
            if (err2) { console.error('Message delete error:', err2.message); return res.status(500).end(); }
            cleanupAttachmentFiles(attachments);
            broadcastDMDelete(msg.from_user, msg.to_user, msgId);
            res.status(200).end();
        });
    });
});

app.post('/messages/:username/edit/:id', (req, res) => {
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
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${REPORT_SCRIPT}

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

function requireAdmin(req, res, next) {
    if (!req.session.userId) return res.redirect('/');
    db.get(`SELECT IsOwner, IsAdmin, IsHeadAdmin FROM User_Data WHERE id = ?`, [req.session.userId], (err, user) => {
        if (err || !user || (!user.IsOwner && !user.IsAdmin && !user.IsHeadAdmin)) {
            return res.status(403).sendFile(path.join(__dirname, 'admin_access_denied.html'));
        }
        req.isOwner = !!user.IsOwner;
        req.isHeadAdmin = !!(user.IsHeadAdmin || user.IsOwner);
        next();
    });
}

// Stricter gate for routes that only Owners/Head Admins should be able to
// hit (e.g. toggling registration). Must run after requireAdmin, which is
// what actually populates req.isHeadAdmin.
function requireHeadAdmin(req, res, next) {
    if (!req.isHeadAdmin) return res.status(403).json({ error: 'Head Admin or Owner only.' });
    next();
}

// ----- Admin dashboard table rendering (shared between the full page render
// and the /admin/tables-partial endpoint used to refresh tables without a
// full page reload after an admin action). -----
function buildAdminUserRows(users, activeWarningCounts) {
    return (users || []).map(u => {
        const badges = [
            u.IsOwner ? '<span style="color:var(--gold-color);font-weight:700;">Owner</span>' : '',
            u.IsHeadAdmin ? '<span style="color:var(--danger-strong-color);font-weight:700;">Head Admin</span>' : '',
            u.IsAdmin ? '<span style="color:var(--admin-color);font-weight:700;">Admin</span>' : '',
            u.IsDeveloper ? '<span style="color:var(--accent-color);font-weight:700;">Dev</span>' : '',
            u.IsSupporter ? '<span style="color:var(--purple-color);font-weight:700;">Supporter</span>' : '',
            u.IsVerified ? '<span style="color:var(--accent-color, #1d9bf0);font-weight:700;">Verified</span>' : '',
            u.IsDeleted ? '<span style="color:var(--gray-color);font-weight:700;">Deleted</span>' : (u.IsBanned ? '<span style="color:var(--danger-color);font-weight:700;">Banned</span>' : ''),
        ].filter(Boolean).join(' ');
        const ipBtn = u.last_ip
            ? `<button class="button" style="font-size:0.75em;padding:2px 8px;margin-left:6px;" onclick="prefillIPBan('${escapeHTML(u.last_ip)}')">IP Ban</button>`
            : '';
        const nicknameSuffix = (u.Nickname && u.Nickname.trim()) ? ` <span style="opacity:0.5;font-weight:400;">(${escapeHTML(u.Nickname.trim())})</span>` : '';
        const banExpirySuffix = (u.IsBanned && u.BanExpiresAt) ? ` (until ${escapeHTML(new Date(u.BanExpiresAt).toLocaleString())})` : '';
        const statusReason = u.IsDeleted ? escapeHTML(u.DeleteReason || '') : (u.IsBanned ? escapeHTML(u.BanReason || '') + banExpirySuffix : '');
        const standing = getStanding(activeWarningCounts[u.username] || 0);
        const standingBtn = `<button class="button" style="font-size:0.72em;padding:2px 8px;margin-left:6px;" onclick="prefillWarnUsername('${escapeHTML(u.username)}')">Warn</button>`;
        return `<tr>
            <td><a href="/user/${escapeHTML(u.username)}" style="color:var(--text-color);text-decoration:none;">@${escapeHTML(u.username)}</a>${nicknameSuffix}</td>
            <td style="font-size:0.85em; word-break: break-word; overflow-wrap: break-word">${badges || '<span style="opacity:0.4;">-</span>'}</td>
            <td style="font-size:0.8em;opacity:0.6;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; word-break: break-word; overflow-wrap: break-word">${statusReason}</td>
            <td style="font-size:0.85em;white-space:nowrap; word-break: break-word; overflow-wrap: break-word"><span style="color:${standing.color};font-weight:700;">${escapeHTML(standing.label)}</span> <span style="opacity:0.5;">(${standing.count})</span>${standingBtn}</td>
            <td style="font-size:0.78em;opacity:0.5; word-break: break-word; overflow-wrap: break-word">${u.last_ip ? escapeHTML(u.last_ip) : '<span style="opacity:0.3;">-</span>'}${ipBtn}</td>
        </tr>`;
    }).join('');
}

function buildAdminIPBanRows(ipbans) {
    return (ipbans || []).map(b => `<tr>
        <td style="font-family:monospace; word-break: break-word; overflow-wrap: break-word">${escapeHTML(b.ip)}</td>
        <td style="font-size:0.8em;opacity:0.7; word-break: break-word; overflow-wrap: break-word">${escapeHTML(b.reason || '')}</td>
        <td style="font-size:0.78em;opacity:0.5; word-break: break-word; overflow-wrap: break-word">${escapeHTML(b.banned_by || '')}</td>
        <td><button class="button" style="font-size:0.75em;padding:2px 8px;" onclick="unIPBan('${escapeHTML(b.ip)}')">Unban</button></td>
    </tr>`).join('');
}

const ADMIN_AUDIT_ACTION_LABELS = {
    account_created: 'Account Created',
    account_banned: 'Account Banned',
    account_unbanned: 'Account Unbanned',
    account_deleted: 'Account Deleted',
    registration_gate_enabled: 'Registration Gate ON',
    registration_gate_disabled: 'Registration Gate OFF',
    ip_banned: 'IP Banned',
    ip_unbanned: 'IP Unbanned',
    warning_issued: 'Warning Issued',
    warning_revoked: 'Warning Revoked',
    content_reported: 'Content Reported',
    report_resolved: 'Report Resolved',
    report_reopened: 'Report Reopened',
    report_content_deleted: 'Reported Content Deleted'
};
const ADMIN_AUDIT_IP_ACTIONS = new Set(['ip_banned', 'ip_unbanned']);
function buildAdminAuditRows(auditEntries) {
    return (auditEntries || []).map(a => {
        let targetDisplay = '<span style="opacity:0.3;">-</span>';
        if (a.target) {
            targetDisplay = ADMIN_AUDIT_IP_ACTIONS.has(a.action)
                ? `<span style="font-family:monospace;">${escapeHTML(a.target)}</span>`
                : '@' + escapeHTML(a.target);
        }
        return `<tr>
        <td style="font-size:0.78em;opacity:0.5;white-space:nowrap; word-break: break-word; overflow-wrap: break-word">${escapeHTML(a.created_at || '')}</td>
        <td style="font-size:0.85em; word-break: break-word; overflow-wrap: break-word">${escapeHTML(ADMIN_AUDIT_ACTION_LABELS[a.action] || a.action)}</td>
        <td style="font-size:0.85em; word-break: break-word; overflow-wrap: break-word">${escapeHTML(a.actor || '')}</td>
        <td style="font-size:0.85em; word-break: break-word; overflow-wrap: break-word">${targetDisplay}</td>
        <td style="font-size:0.8em;opacity:0.7;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; word-break: break-word; overflow-wrap: break-word">${escapeHTML(a.details || '')}</td>
    </tr>`;
    }).join('');
}

function getActiveWarningCounts(allWarnings) {
    const activeWarningCounts = {};
    (allWarnings || []).forEach(w => {
        if (isWarningActive(w)) activeWarningCounts[w.username] = (activeWarningCounts[w.username] || 0) + 1;
    });
    return activeWarningCounts;
}

// Returns just the refreshed table bodies (Users, Banned IPs, Audit Log) as
// HTML fragments so the admin dashboard can update them in place after an
// action (ban, unban, warn, delete, IP ban, badge change, ...) instead of
// doing a full page reload - much lighter on slow connections.
app.get('/admin/tables-partial', requireAdmin, (req, res) => {
    db.all(`SELECT username, Nickname, IsBanned, BanReason, BanExpiresAt, IsDeleted, DeleteReason, IsOwner, IsAdmin, IsHeadAdmin, IsDeveloper, IsSupporter, IsVerified, last_ip FROM User_Data ORDER BY username ASC`, [], (err, users) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        db.all(`SELECT username, expires_at FROM Warnings`, [], (errW, allWarnings) => {
            const userRows = buildAdminUserRows(users, getActiveWarningCounts(allWarnings));
            db.all(`SELECT ip, reason, banned_by, created_at FROM IP_Bans ORDER BY created_at DESC`, [], (err2, ipbans) => {
                const ipBanRows = buildAdminIPBanRows(ipbans);
                db.all(`SELECT action, actor, target, details, created_at FROM Audit_Log ORDER BY id DESC LIMIT 150`, [], (err3, auditEntries) => {
                    const auditRows = buildAdminAuditRows(auditEntries);
                    res.json({ userRows, ipBanRows, auditRows });
                });
            });
        });
    });
});

app.get('/admin/dashboard', requireAdmin, (req, res) => {
    db.all(`SELECT username, Nickname, IsBanned, BanReason, BanExpiresAt, IsDeleted, DeleteReason, IsOwner, IsAdmin, IsHeadAdmin, IsDeveloper, IsSupporter, IsVerified, last_ip FROM User_Data ORDER BY username ASC`, [], (err, users) => {
        if (err) return res.status(500).send('DB error');
        db.all(`SELECT username, expires_at FROM Warnings`, [], (errW, allWarnings) => {
        const activeWarningCounts = getActiveWarningCounts(allWarnings);
        const userRows = buildAdminUserRows(users, activeWarningCounts);

        db.all(`SELECT ip, reason, banned_by, created_at FROM IP_Bans ORDER BY created_at DESC`, [], (err2, ipbans) => {
            const ipBanRows = buildAdminIPBanRows(ipbans);

        db.all(`SELECT action, actor, target, details, created_at FROM Audit_Log ORDER BY id DESC LIMIT 150`, [], (err3, auditEntries) => {
            const auditRows = buildAdminAuditRows(auditEntries);

        res.send(`<!DOCTYPE html>
<html lang="en" class="page-admin">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Admin Dashboard</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
<style>
    /* Force wide tables (like All Users) to scroll horizontally inside their
       own panel instead of overflowing past it, regardless of anything
       theme.css sets on .panel/table. */
    .table-scroll-wrap {
        display: block !important;
        width: 100% !important;
        max-width: 100% !important;
        overflow-x: auto !important;
        -webkit-overflow-scrolling: touch;
    }
    .table-scroll-wrap > table {
        width: max-content !important;
        min-width: 100% !important;
    }
</style>
</head>
<body class="page-admin">
<div id="topbar">
    <strong>Admin Dashboard</strong>
    <div id="topbar-right" style="position:relative;display:flex;align-items:center;">
        <a href="/feed">Feed</a>
        <a href="/admin/reports">Reports</a>
        <a href="/admin/support">Support Tickets</a>
        <a href="/edit">Dashboard</a>
        <a href="/logout">Logout</a>
        <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
        <nav id="nav-dropdown">
            <a href="/feed">Feed</a>
            <a href="/admin/reports">Reports</a>
            <a href="/admin/support">Support Tickets</a>
            <a href="/edit">Dashboard</a>
            <a href="/logout">Logout</a>
        </nav>
    </div>
</div>
<div id="content">
    <h1>Admin Dashboard</h1>
    <p style="opacity:0.5;margin-top:4px;">Logged in as <strong>${escapeHTML(req.session.userUsername)}</strong></p>

    <div class="panel" style="border-color:rgba(255,255,255,0.2);">
        <h2>Registration Gate</h2>
        <p style="opacity:0.5;font-size:0.8em;margin-top:-6px;">When <strong>ON</strong>, new signups are created banned pending activation and admins get pinged (Activations group chat + DM) to manually activate them. When <strong>OFF</strong>, registration is fully open - new accounts are created active immediately, with no pings.</p>
        <p style="margin-top:10px;">Status: <span id="reg-gate-status">${registrationGateEnabled ? '<span style="color:var(--success-color);font-weight:700;">ON</span>' : '<span style="color:var(--danger-color);font-weight:700;">OFF</span>'}</span></p>
        ${req.isHeadAdmin ? `
        <div class="action-row">
            <button class="button" onclick="toggleRegistrationGate(true)" style="width:100px;">Turn ON</button>
            <button class="button" onclick="toggleRegistrationGate(false)" style="width:100px;">Turn OFF</button>
        </div>
        <div id="reg-gate-result"></div>` : `<p style="opacity:0.4;font-size:0.78em;margin-top:10px;">Only Owners and Head Admins can change this setting.</p>`}
    </div>

    <div class="panel">
        <h2>Ban / Unban User</h2>
        <label>Username</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="target-username" placeholder="e.g. testuser" autocomplete="off">
        <label>Reason <span style="opacity:0.4;">(required for ban, ignored for unban)</span></label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="ban-reason" placeholder="e.g. Spamming" maxlength="500">
        <label>Duration <span style="opacity:0.4;">(optional, ignored for unban - blank = permanent)</span></label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="ban-duration" placeholder="e.g. 45s, 30m, 6h, 3d, 2w, 1y" maxlength="20">
        <label>Action</label>
        <select id="action">
            <option value="ban">Ban</option>
            <option value="unban">Unban</option>
        </select>
        <div class="action-row">
            <button class="button" id="submit-btn" onclick="submitAction()" style="width:140px;">Apply</button>
        </div>
        <div id="result"></div>
    </div>

    <div class="panel" style="border-color:rgba(255,255,255,0.2);">
        <h2 style="color:var(--text-dim-color);">IP Ban / Unban</h2>
        <label>IP Address</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="target-ip" placeholder="e.g. 192.168.1.1" autocomplete="off">
        <label>Reason <span style="opacity:0.4;">(required for ban, ignored for unban)</span></label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="ip-ban-reason" placeholder="e.g. Ban evasion" maxlength="500">
        <label>Action</label>
        <select id="ip-action">
            <option value="ipban">IP Ban</option>
            <option value="unipban">IP Unban</option>
        </select>
        <div class="action-row">
            <button class="button" onclick="submitIPAction()" style="width:140px;">Apply</button>
        </div>
        <div id="ip-result"></div>
    </div>

    <div class="panel" style="rgba(255,255,255,0.2);">
        <h2 style="color:var(--text-dim-color);">Banned IPs</h2>
        <table>
            <thead><tr><th>IP Address</th><th>Reason</th><th>Banned By</th><th></th></tr></thead>
            <tbody id="ip-ban-table">
                ${ipBanRows || '<tr><td colspan="4" style="opacity:0.4; word-break: break-word; overflow-wrap: break-word">No IP bans.</td></tr>'}
            </tbody>
        </table>
    </div>

    <div class="panel" style="border-color:rgba(255,255,255,0.2;">
        <h2 style="color:var(--text-dim-color);">Delete Account</h2>
        <p style="opacity:0.5;font-size:0.8em;margin-top:-6px;">Does not remove the account from the database. Resets the avatar to the default, sets the display name to "Account Deleted", clears the bio, marks the account as deleted, and deletes all of its posts. The username is kept.</p>
        <label>Username</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="delete-username" placeholder="e.g. testuser" autocomplete="off">
        <label>Reason <span style="opacity:0.4;">(required)</span></label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="delete-reason" placeholder="e.g. ToS violation" maxlength="500">
        <div class="action-row">
            <button class="button" onclick="submitDeleteAccount()" style="width:160px;">Delete Account</button>
        </div>
        <div id="delete-result"></div>
        ${req.isHeadAdmin ? `
        <hr style="border-color:rgba(255,80,80,0.3);margin:18px 0;">
        <h3 style="color:var(--danger-strong-color);margin-bottom:4px;">Delete From Database</h3>
        <p style="opacity:0.6;font-size:0.8em;margin-top:-2px;">Permanently erases the account and everything tied to it - posts, DMs, group chat messages/memberships, follows, friends, friend requests, and notifications. This cannot be undone and the username becomes available again. Head Admin / Owner only.</p>
        <label>Username</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="hard-delete-username" placeholder="e.g. testuser" autocomplete="off">
        <label>Reason <span style="opacity:0.4;">(required)</span></label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="hard-delete-reason" placeholder="e.g. GDPR erasure request" maxlength="500">
        <div class="action-row">
            <button class="button" onclick="submitHardDeleteAccount()" style="width:200px;">Delete From Database</button>
        </div>
        <div id="hard-delete-result"></div>
        ` : ''}
    </div>

    <div class="panel">
        <h2>Edit User Profile</h2>
        <p style="opacity:0.5;font-size:0.8em;margin-top:-6px;">View and fix up anyone's avatar, nickname, or bio - useful for removing an inappropriate pfp or bio without deleting the account.</p>
        <label>Username</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="profile-username" placeholder="e.g. testuser" autocomplete="off">
        <div class="action-row">
            <button class="button" onclick="loadProfile()" style="width:140px;">Load</button>
        </div>
        <div id="profile-avatar-preview" style="margin:10px 0;display:flex;align-items:center;gap:12px;"></div>
        <label>Nickname</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="profile-nickname" placeholder="(none)" maxlength="32">
        <label>Bio</label>
        <textarea id="profile-bio" maxlength="1000" style="width:100%;min-height:80px;border-radius:12px;padding:8px;box-sizing:border-box;"></textarea>
        <div class="action-row">
            <button class="button" onclick="saveProfileText()" style="width:140px;">Save Text</button>
        </div>
        <label style="margin-top:14px;">Email</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="profile-email" placeholder="(none)" autocomplete="off">
        <div class="action-row">
            <button class="button" onclick="saveProfileEmail()" style="width:140px;">Save Email</button>
        </div>
        <label style="margin-top:14px;">Replace Avatar</label>
        <input type="file" id="profile-avatar-file" accept="image/*">
        <div class="action-row">
            <button class="button" onclick="uploadProfileAvatar()" style="width:160px;">Upload Avatar</button>
            <button class="button" onclick="resetProfileAvatar()" style="width:160px;">Reset to Default</button>
        </div>
        <div id="profile-result"></div>
    </div>

    <div class="panel">
        <h2>Manage Badges</h2>
        <label>Username</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="badge-username" placeholder="e.g. testuser" autocomplete="off">
        <label style="margin-top:14px;">Badges</label>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:6px;">
            ${req.isOwner ? `<label style="display:flex;align-items:center;gap:6px;margin:0;text-transform:none;font-size:0.95em;opacity:1;"><input type="checkbox" id="badge-headadmin" style="width:auto;"> Head Admin</label>` : ''}
            ${req.isHeadAdmin ? `<label style="display:flex;align-items:center;gap:6px;margin:0;text-transform:none;font-size:0.95em;opacity:1;"><input type="checkbox" id="badge-admin" style="width:auto;"> Admin</label>` : ''}
            <label style="display:flex;align-items:center;gap:6px;margin:0;text-transform:none;font-size:0.95em;opacity:1;"><input type="checkbox" id="badge-supporter" style="width:auto;"> Supporter</label>
            <label style="display:flex;align-items:center;gap:6px;margin:0;text-transform:none;font-size:0.95em;opacity:1;"><input type="checkbox" id="badge-developer" style="width:auto;"> Developer</label>
            <label style="display:flex;align-items:center;gap:6px;margin:0;text-transform:none;font-size:0.95em;opacity:1;"><input type="checkbox" id="badge-verified" style="width:auto;"> Verified</label>
            ${req.isOwner ? `<label style="display:flex;align-items:center;gap:6px;margin:0;text-transform:none;font-size:0.95em;opacity:1;"><input type="checkbox" id="badge-owner" style="width:auto;"> Owner</label>` : ''}
        </div>
        ${!req.isOwner ? `<p style="opacity:0.4;font-size:0.78em;margin-top:6px;">Only Owners and Head Admins can grant or revoke the Admin badge.</p>` : ''}
        <p style="opacity:0.4;font-size:0.8em;margin-top:8px;">Load a user's current badges first, tick/untick what you want, then save.</p>
        <div class="action-row">
            <button class="button" onclick="loadBadges()" style="width:140px;">Load</button>
            <button class="button" onclick="saveBadges()" style="width:140px;">Save</button>
        </div>
        <div id="badge-result"></div>
    </div>

    <div class="panel">
        <h2>Issue Warning</h2>
        <p style="opacity:0.5;font-size:0.8em;margin-top:-6px;">Warnings affect account standing: <strong>0</strong> = All good, <strong>1-9</strong> = Be careful, <strong>10-19</strong> = At risk, <strong>20+</strong> = Severely at risk. Once a warning expires it stops counting toward standing but stays in the user's warnings list. Leave the expiration blank to have it never expire.</p>
        <label>Username</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="warn-username" placeholder="e.g. testuser" autocomplete="off">
        <label>Reason <span style="opacity:0.4;">(required)</span></label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="warn-reason" placeholder="e.g. Harassment in DMs" maxlength="500">
        <label>Expires In <span style="opacity:0.4;">(optional, e.g. 45s, 30m, 6h, 3d, 2w, 1y - blank = never expires)</span></label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="warn-duration" placeholder="e.g. 2w" maxlength="20">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:0.85em;opacity:0.85;margin-top:8px;">
            <input type="checkbox" id="warn-mute" style="width:auto;height:auto;">
            Mute user (blocks DMs, group chat, and feed posts/replies) until this warning expires
        </label>
        <div class="action-row">
            <button class="button" id="warn-submit-btn" onclick="submitWarn()" style="width:140px;">Issue Warning</button>
        </div>
        <div id="warn-result"></div>
    </div>

    <div class="panel">
        <h2>View / Manage Warnings</h2>
        <label>Username</label>
        <input style="border-radius: 20px; height: 30px;" type="text" id="warnings-lookup-username" placeholder="e.g. testuser" autocomplete="off">
        <div class="action-row">
            <button class="button" onclick="loadWarnings()" style="width:140px;">Load</button>
        </div>
        <div id="warnings-standing" style="margin:10px 0;"></div>
        <div class="table-scroll-wrap">
        <table>
            <thead><tr><th>Reason</th><th>Issued By</th><th>Issued</th><th>Expires</th><th>Status</th><th></th></tr></thead>
            <tbody id="warnings-table">
                <tr><td colspan="6" style="opacity:0.4;">Load a user to see their warnings.</td></tr>
            </tbody>
        </table>
        </div>
    </div>

    <div class="panel">
        <h2>All Users</h2>
        <div class="table-scroll-wrap">
        <table>
            <thead><tr><th>Username</th><th>Badges</th><th>Ban Reason</th><th>Standing</th><th>Last IP</th></tr></thead>
            <tbody id="user-table">
                ${userRows || '<tr><td colspan="5" style="opacity:0.4; word-break: break-word; overflow-wrap: break-word">No users found.</td></tr>'}
            </tbody>
        </table>
        </div>
    </div>

    <div class="panel">
        <h2>Audit Log</h2>
        <p style="opacity:0.5;font-size:0.8em;margin-top:-6px;">Most recent 150 events - account creations, bans/unbans, deletions, and registration gate changes.</p>
        <div class="table-scroll-wrap">
        <table>
            <thead><tr><th>Time</th><th>Action</th><th>Actor</th><th>Target</th><th>Details</th></tr></thead>
            <tbody id="audit-table">
                ${auditRows || '<tr><td colspan="5" style="opacity:0.4; word-break: break-word; overflow-wrap: break-word">No audit events yet.</td></tr>'}
            </tbody>
        </table>
        </div>
    </div>
</div>

<script>
    // Event delegation so buttons injected later (e.g. after refreshAdminTables()
    // repopulates a table) still get the click animation without re-binding.
    document.addEventListener('mousedown', (e) => {
        const btn = e.target.closest('.button');
        if (btn) { btn.classList.add('clicked'); setTimeout(() => btn.classList.remove('clicked'), 150); }
    });

    // Refreshes the Users, Banned IPs, and Audit Log tables in place by
    // fetching just their rows - avoids a full page reload (and re-running
    // every query on the page) after a ban/unban/warn/delete/etc.
    async function refreshAdminTables() {
        try {
            const r = await fetch('/admin/tables-partial');
            if (!r.ok) return;
            const d = await r.json();
            const userTable = document.getElementById('user-table');
            const ipBanTable = document.getElementById('ip-ban-table');
            const auditTable = document.getElementById('audit-table');
            if (userTable) userTable.innerHTML = d.userRows || '<tr><td colspan="5" style="opacity:0.4;">No users found.</td></tr>';
            if (ipBanTable) ipBanTable.innerHTML = d.ipBanRows || '<tr><td colspan="4" style="opacity:0.4;">No IP bans.</td></tr>';
            if (auditTable) auditTable.innerHTML = d.auditRows || '<tr><td colspan="5" style="opacity:0.4;">No audit events yet.</td></tr>';
        } catch (e) { /* leave existing tables as-is on network error */ }
    }

    async function toggleRegistrationGate(enable) {
        const result = document.getElementById('reg-gate-result');
        result.className = ''; result.textContent = 'Updating...';
        try {
            const r = await fetch('/admin/registration-gate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: enable })
            });
            const d = await r.json();
            if (!r.ok) { result.className = 'err'; result.textContent = d.error || 'Error.'; return; }
            document.getElementById('reg-gate-status').innerHTML = d.enabled
                ? '<span style="color:var(--success-color);font-weight:700;">ON</span>'
                : '<span style="color:var(--danger-color);font-weight:700;">OFF</span>';
            result.className = 'ok'; result.textContent = 'Saved.';
            setTimeout(() => { result.textContent = ''; }, 1500);
        } catch (e) { result.className = 'err'; result.textContent = 'Network error.'; }
    }

    function renderProfileAvatarPreview(avatarUrl, username) {
        const el = document.getElementById('profile-avatar-preview');
        if (avatarUrl) {
            el.innerHTML = '<img src="' + avatarUrl + '" alt="avatar" style="width:56px;height:56px;border-radius:50%;object-fit:cover;border:1px solid rgba(255,255,255,0.2);">' +
                '<span style="opacity:0.5;font-size:0.8em;">Current avatar for @' + username + '</span>';
        } else {
            el.innerHTML = '<span style="opacity:0.4;font-size:0.8em;">No avatar set.</span>';
        }
    }

    async function loadProfile() {
        const username = document.getElementById('profile-username').value.trim();
        const resultEl = document.getElementById('profile-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        resultEl.className = ''; resultEl.textContent = 'Loading...';
        try {
            const res = await fetch('/admin/profile/' + encodeURIComponent(username));
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            document.getElementById('profile-nickname').value = data.Nickname || '';
            document.getElementById('profile-bio').value = data.bio || '';
            document.getElementById('profile-email').value = data.email || '';
            renderProfileAvatarPreview(data.avatar_url, data.username);
            resultEl.className = 'ok'; resultEl.textContent = 'Loaded profile for @' + username + '.';
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }

    async function saveProfileText() {
        const username = document.getElementById('profile-username').value.trim();
        const resultEl = document.getElementById('profile-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        const nickname = document.getElementById('profile-nickname').value.trim();
        const bio = document.getElementById('profile-bio').value;
        resultEl.className = ''; resultEl.textContent = 'Saving...';
        try {
            const res = await fetch('/admin/profile/' + encodeURIComponent(username) + '/text', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nickname, bio })
            });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            resultEl.className = 'ok'; resultEl.textContent = 'Profile text updated for @' + username + '.';
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }

    async function saveProfileEmail() {
        const username = document.getElementById('profile-username').value.trim();
        const resultEl = document.getElementById('profile-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        const email = document.getElementById('profile-email').value.trim();
        resultEl.className = ''; resultEl.textContent = 'Saving...';
        try {
            const res = await fetch('/admin/profile/' + encodeURIComponent(username) + '/email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            resultEl.className = 'ok'; resultEl.textContent = 'Email updated for @' + username + '.';
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }

    async function uploadProfileAvatar() {
        const username = document.getElementById('profile-username').value.trim();
        const resultEl = document.getElementById('profile-result');
        const fileInput = document.getElementById('profile-avatar-file');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        if (!fileInput.files[0]) { resultEl.className = 'err'; resultEl.textContent = 'Choose an image file first.'; return; }
        const formData = new FormData();
        formData.append('avatar', fileInput.files[0]);
        resultEl.className = ''; resultEl.textContent = 'Uploading...';
        try {
            const res = await fetch('/admin/profile/' + encodeURIComponent(username) + '/avatar', { method: 'POST', body: formData });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            renderProfileAvatarPreview(data.avatar_url, username);
            fileInput.value = '';
            resultEl.className = 'ok'; resultEl.textContent = 'Avatar updated for @' + username + '.';
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }

    async function resetProfileAvatar() {
        const username = document.getElementById('profile-username').value.trim();
        const resultEl = document.getElementById('profile-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        if (!confirm('Reset @' + username + '\\'s avatar to the default image?')) return;
        resultEl.className = ''; resultEl.textContent = 'Resetting...';
        try {
            const res = await fetch('/admin/profile/' + encodeURIComponent(username) + '/reset-avatar', { method: 'POST' });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            renderProfileAvatarPreview(data.avatar_url, username);
            resultEl.className = 'ok'; resultEl.textContent = 'Avatar reset for @' + username + '.';
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }

    async function loadBadges() {
        const username = document.getElementById('badge-username').value.trim();
        const resultEl = document.getElementById('badge-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        resultEl.className = ''; resultEl.textContent = 'Loading...';
        try {
            const res = await fetch('/admin/badges/' + encodeURIComponent(username));
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            document.getElementById('badge-admin') && (document.getElementById('badge-admin').checked = !!data.IsAdmin);
            document.getElementById('badge-headadmin') && (document.getElementById('badge-headadmin').checked = !!data.IsHeadAdmin);
            document.getElementById('badge-supporter').checked = !!data.IsSupporter;
            document.getElementById('badge-developer').checked = !!data.IsDeveloper;
            document.getElementById('badge-verified').checked = !!data.IsVerified;
            const ownerBox = document.getElementById('badge-owner');
            if (ownerBox) ownerBox.checked = !!data.IsOwner;
            resultEl.className = 'ok'; resultEl.textContent = 'Loaded badges for @' + username + '.';
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }

    async function saveBadges() {
        const username = document.getElementById('badge-username').value.trim();
        const resultEl = document.getElementById('badge-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Enter a username.'; return; }
        const ownerBox = document.getElementById('badge-owner');
        const adminBox = document.getElementById('badge-admin');
        const headadminBox = document.getElementById('badge-headadmin');
        const body = {
            IsSupporter: document.getElementById('badge-supporter').checked,
            IsDeveloper: document.getElementById('badge-developer').checked,
            IsVerified: document.getElementById('badge-verified').checked
        };
        if (adminBox) body.IsAdmin = adminBox.checked;
        if (ownerBox) body.IsHeadAdmin = headadminBox.checked;
        if (ownerBox) body.IsOwner = ownerBox.checked;
        resultEl.className = ''; resultEl.textContent = 'Saving...';
        try {
            const res = await fetch('/admin/badges/' + encodeURIComponent(username), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            resultEl.className = 'ok'; resultEl.textContent = 'Badges updated for @' + username + '.';
            setTimeout(() => refreshAdminTables(), 1000);
        } catch (e) {
            resultEl.className = 'err'; resultEl.textContent = 'Network error.';
        }
    }


    async function submitAction() {
        const username = document.getElementById('target-username').value.trim();
        const reason = document.getElementById('ban-reason').value.trim();
        const duration = document.getElementById('ban-duration').value.trim();
        const action = document.getElementById('action').value;
        const resultEl = document.getElementById('result');

        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Username is required.'; return; }
        if (action === 'ban' && !reason) { resultEl.className = 'err'; resultEl.textContent = 'A reason is required to ban.'; return; }

        resultEl.className = ''; resultEl.textContent = 'Working…';

        try {
            const res = await fetch('/admin/' + action + '/' + encodeURIComponent(username), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: action === 'ban' ? JSON.stringify({ reason, duration }) : '{}'
            });
            const data = await res.json();
            if (!res.ok) {
                resultEl.className = 'err';
                resultEl.textContent = 'Error: ' + (data.error || res.status);
            } else {
                resultEl.className = 'ok';
                resultEl.textContent = action === 'ban'
                    ? '@' + username + ' has been banned' + (data.expiresAt ? ' until ' + new Date(data.expiresAt).toLocaleString() : ' permanently') + '.'
                    : '@' + username + ' has been unbanned.';
                document.getElementById('target-username').value = '';
                document.getElementById('ban-reason').value = '';
                document.getElementById('ban-duration').value = '';
                setTimeout(() => refreshAdminTables(), 1200);
            }
        } catch (e) {
            resultEl.className = 'err';
            resultEl.textContent = 'Network error.';
        }
    }

    async function submitDeleteAccount() {
        const username = document.getElementById('delete-username').value.trim();
        const reason = document.getElementById('delete-reason').value.trim();
        const resultEl = document.getElementById('delete-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Username is required.'; return; }
        if (!reason) { resultEl.className = 'err'; resultEl.textContent = 'A reason is required to delete an account.'; return; }
        if (!confirm('This will reset @' + username + '\\'s avatar, name, and bio, mark the account as deleted, and delete all of its posts. The account stays in the database and the username is kept. Continue?')) return;

        resultEl.className = ''; resultEl.textContent = 'Working…';
        try {
            const res = await fetch('/admin/delete-account/' + encodeURIComponent(username), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason })
            });
            const data = await res.json();
            if (!res.ok) {
                resultEl.className = 'err';
                resultEl.textContent = 'Error: ' + (data.error || res.status);
            } else {
                resultEl.className = 'ok';
                resultEl.textContent = '@' + username + ' has been deleted.';
                document.getElementById('delete-username').value = '';
                document.getElementById('delete-reason').value = '';
                setTimeout(() => refreshAdminTables(), 1200);
            }
        } catch (e) {
            resultEl.className = 'err';
            resultEl.textContent = 'Network error.';
        }
    }

    async function submitHardDeleteAccount() {
        const username = document.getElementById('hard-delete-username').value.trim();
        const reason = document.getElementById('hard-delete-reason').value.trim();
        const resultEl = document.getElementById('hard-delete-result');
        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Username is required.'; return; }
        if (!reason) { resultEl.className = 'err'; resultEl.textContent = 'A reason is required to delete an account.'; return; }
        if (!confirm('This PERMANENTLY deletes @' + username + ' and everything tied to it (posts, DMs, group chat messages/memberships, follows, friends, friend requests, notifications) from the database. This CANNOT be undone. Continue?')) return;
        if (!confirm('Are you absolutely sure? Press OK to permanently erase @' + username + '.')) return;

        resultEl.className = ''; resultEl.textContent = 'Working…';
        try {
            const res = await fetch('/admin/delete-account-permanent/' + encodeURIComponent(username), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason })
            });
            const data = await res.json();
            if (!res.ok) {
                resultEl.className = 'err';
                resultEl.textContent = 'Error: ' + (data.error || res.status);
            } else {
                resultEl.className = 'ok';
                resultEl.textContent = '@' + username + ' has been permanently deleted from the database.';
                document.getElementById('hard-delete-username').value = '';
                document.getElementById('hard-delete-reason').value = '';
                setTimeout(() => refreshAdminTables(), 1200);
            }
        } catch (e) {
            resultEl.className = 'err';
            resultEl.textContent = 'Network error.';
        }
    }

    async function submitIPAction() {
        const ip = document.getElementById('target-ip').value.trim();
        const reason = document.getElementById('ip-ban-reason').value.trim();
        const action = document.getElementById('ip-action').value;
        const resultEl = document.getElementById('ip-result');

        if (!ip) { resultEl.className = 'err'; resultEl.textContent = 'IP address is required.'; return; }
        if (action === 'ipban' && !reason) { resultEl.className = 'err'; resultEl.textContent = 'A reason is required to IP ban.'; return; }

        resultEl.className = ''; resultEl.textContent = 'Working…';

        try {
            const endpoint = action === 'ipban' ? '/admin/ipban' : '/admin/unipban';
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ip, reason })
            });
            const data = await res.json();
            if (!res.ok) {
                resultEl.className = 'err';
                resultEl.textContent = 'Error: ' + (data.error || res.status);
            } else {
                resultEl.className = 'ok';
                resultEl.textContent = action === 'ipban'
                    ? ip + ' has been IP banned.'
                    : ip + ' has been IP unbanned.';
                document.getElementById('target-ip').value = '';
                document.getElementById('ip-ban-reason').value = '';
                setTimeout(() => refreshAdminTables(), 1200);
            }
        } catch (e) {
            resultEl.className = 'err';
            resultEl.textContent = 'Network error.';
        }
    }

    function escClient(str) {
        const d = document.createElement('div');
        d.textContent = str == null ? '' : String(str);
        return d.innerHTML;
    }

    async function submitWarn() {
        const username = document.getElementById('warn-username').value.trim();
        const reason = document.getElementById('warn-reason').value.trim();
        const duration = document.getElementById('warn-duration').value.trim();
        const mute = document.getElementById('warn-mute').checked;
        const resultEl = document.getElementById('warn-result');

        if (!username) { resultEl.className = 'err'; resultEl.textContent = 'Username is required.'; return; }
        if (!reason) { resultEl.className = 'err'; resultEl.textContent = 'A reason is required.'; return; }

        resultEl.className = ''; resultEl.textContent = 'Working…';
        try {
            const res = await fetch('/admin/warn/' + encodeURIComponent(username), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason, duration, mute })
            });
            const data = await res.json();
            if (!res.ok) {
                resultEl.className = 'err';
                resultEl.textContent = 'Error: ' + (data.error || res.status);
            } else {
                resultEl.className = 'ok';
                resultEl.textContent = '@' + username + ' has been warned (' + (data.expiresAt ? 'expires ' + new Date(data.expiresAt).toLocaleString() : 'never expires') + (data.mute ? ', chat muted' : '') + ').';
                document.getElementById('warn-username').value = '';
                document.getElementById('warn-reason').value = '';
                document.getElementById('warn-duration').value = '';
                document.getElementById('warn-mute').checked = false;
                setTimeout(() => refreshAdminTables(), 1200);
            }
        } catch (e) {
            resultEl.className = 'err';
            resultEl.textContent = 'Network error.';
        }
    }

    function prefillWarnUsername(username) {
        document.getElementById('warn-username').value = username;
        document.getElementById('warn-username').focus();
        document.getElementById('warn-username').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function renderStandingLine(standing) {
        return '<strong>' + standing.label + '</strong> <span style="opacity:0.6;">(' + standing.count + ' active warning' + (standing.count === 1 ? '' : 's') + ')</span>';
    }

    async function loadWarnings() {
        const username = document.getElementById('warnings-lookup-username').value.trim();
        const standingEl = document.getElementById('warnings-standing');
        const tableEl = document.getElementById('warnings-table');
        if (!username) { standingEl.className = 'err'; standingEl.textContent = 'Enter a username.'; return; }
        standingEl.className = ''; standingEl.textContent = 'Loading...';
        tableEl.innerHTML = '<tr><td colspan="6" style="opacity:0.4;">Loading...</td></tr>';
        try {
            const res = await fetch('/admin/warnings/' + encodeURIComponent(username));
            const data = await res.json();
            if (!res.ok) { standingEl.className = 'err'; standingEl.textContent = 'Error: ' + (data.error || res.status); tableEl.innerHTML = '<tr><td colspan="6" style="opacity:0.4;">-</td></tr>'; return; }
            standingEl.className = '';
            standingEl.innerHTML = '@' + escClient(username) + ' standing: ' + renderStandingLine(data.standing);
            if (!data.warnings.length) {
                tableEl.innerHTML = '<tr><td colspan="6" style="opacity:0.4;">No warnings on record.</td></tr>';
                return;
            }
            tableEl.innerHTML = data.warnings.map(w => {
                const statusHtml = w.active ? '<span style="color:var(--danger-color);font-weight:700;">Active</span>' : '<span style="opacity:0.5;">Expired</span>';
                const revokeBtn = w.active ? '<button class="button" style="font-size:0.72em;padding:2px 8px;" onclick="revokeWarning(' + w.id + ')">Revoke</button>' : '';
                let extras = '';
                if (w.account_action) {
                    const actionLabel = w.account_action === 'temp_ban' ? 'Your account has been temporarily banned.'
                        : w.account_action === 'perm_ban' ? 'Your account has been permanently banned.'
                        : w.account_action === 'delete' ? 'Your account has been deleted.'
                        : null;
                    if (actionLabel) extras += '<div style="opacity:0.7;margin-top:4px;"><strong>' + actionLabel + '</strong></div>';
                }
                if (w.mute_chat && w.active) extras += '<div style="opacity:0.7;margin-top:4px;">🔇 Muted (chat + feed) until this warning expires</div>';
                if (w.removed_content !== null && w.removed_content !== undefined) {
                    extras += '<div style="opacity:0.7;margin-top:4px;">Removed content' + (w.report_id ? ' (report #' + w.report_id + ')' : '') + ': <span style="white-space:pre-wrap;word-break:break-word;">' + (escClient(w.removed_content) || '<span style="opacity:0.5;">(no text)</span>') + '</span></div>';
                }
                return '<tr>' +
                    '<td style="font-size:0.85em; word-break: break-word; overflow-wrap: break-word">' + escClient(w.reason) + extras + '</td>' +
                    '<td style="font-size:0.85em;">' + escClient(w.issued_by) + '</td>' +
                    '<td style="font-size:0.78em;opacity:0.6;white-space:nowrap;">' + new Date(w.created_at.replace(' ','T')+'Z').toLocaleString() + '</td>' +
                    '<td style="font-size:0.78em;opacity:0.6;white-space:nowrap;">' + (w.expires_at ? new Date(w.expires_at).toLocaleString() : 'Never') + '</td>' +
                    '<td>' + statusHtml + '</td>' +
                    '<td>' + revokeBtn + '</td>' +
                '</tr>';
            }).join('');
        } catch (e) {
            standingEl.className = 'err'; standingEl.textContent = 'Network error.';
        }
    }

    async function revokeWarning(id) {
        if (!confirm('Revoke this warning early? It will stop counting toward standing but stay listed.')) return;
        try {
            const res = await fetch('/admin/warnings/' + id + '/revoke', { method: 'POST' });
            const data = await res.json();
            if (!res.ok) { alert('Error: ' + (data.error || res.status)); return; }
            loadWarnings();
        } catch (e) {
            alert('Network error.');
        }
    }

    function prefillIPBan(ip) {
        document.getElementById('target-ip').value = ip;
        document.getElementById('ip-action').value = 'ipban';
        document.getElementById('target-ip').focus();
        document.getElementById('target-ip').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    async function unIPBan(ip) {
        const resultEl = document.getElementById('ip-result');
        resultEl.className = ''; resultEl.textContent = 'Working…';
        try {
            const res = await fetch('/admin/unipban', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ip })
            });
            const data = await res.json();
            if (!res.ok) {
                resultEl.className = 'err';
                resultEl.textContent = 'Error: ' + (data.error || res.status);
            } else {
                resultEl.className = 'ok';
                resultEl.textContent = ip + ' has been IP unbanned.';
                setTimeout(() => refreshAdminTables(), 1200);
            }
        } catch (e) {
            resultEl.className = 'err';
            resultEl.textContent = 'Network error.';
        }
    }

    document.getElementById('target-username').addEventListener('keydown', e => { if (e.key === 'Enter') submitAction(); });
    document.getElementById('ban-reason').addEventListener('keydown', e => { if (e.key === 'Enter') submitAction(); });
    document.getElementById('target-ip').addEventListener('keydown', e => { if (e.key === 'Enter') submitIPAction(); });
    document.getElementById('ip-ban-reason').addEventListener('keydown', e => { if (e.key === 'Enter') submitIPAction(); });

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

</body>
</html>`);
        });
        });
    });
    });
});

// Parses a ban duration like "30m", "6h", "3d", "2w", or a bare number
// (treated as minutes). Returns milliseconds, or null if the string doesn't
// parse / isn't positive - callers should treat null as a bad request.
function parseBanDuration(str) {
    const s = String(str).trim().toLowerCase();
    if (!s) return null;
    const match = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w|y)?$/);
    if (!match) return null;
    const amount = parseFloat(match[1]);
    if (!isFinite(amount) || amount <= 0) return null;
    const unitMs = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        w: 7 * 24 * 60 * 60 * 1000,
        y: 365 * 24 * 60 * 60 * 1000
    };
    const unit = match[2] || 'm';
    return Math.round(amount * unitMs[unit]);
}

// Clears an expired timed ban and emails the user that access has been
// restored. Called from every place that notices BanExpiresAt is in the past
// (the checkBan middleware, /api/check-ban-status, and /login) so the
// notification goes out no matter which path first catches the expiry.
function clearExpiredBan(userId) {
    db.run(`UPDATE User_Data SET IsBanned = 0, BanReason = NULL, BanExpiresAt = NULL WHERE id = ?`, [userId], (err) => {
        if (err) return;
        db.get(`SELECT username, email FROM User_Data WHERE id = ?`, [userId], (err2, row) => {
            if (!err2 && row && row.email) sendBanExpiredEmail(row.email, row.username);
        });
    });
}

app.post('/admin/ban/:username', requireAdmin, (req, res) => {
    const target = req.params.username;
    const reason = (req.body.reason || 'Banned by admin').substring(0, 500);
    if (target === req.session.userUsername) return res.status(400).json({ error: 'cannot ban yourself' });

    // Optional duration field (e.g. "30m", "6h", "3d", "2w"). Left blank/omitted
    // means a permanent ban, matching the existing behavior.
    let expiresAt = null;
    if (req.body.duration && String(req.body.duration).trim()) {
        const ms = parseBanDuration(req.body.duration);
        if (ms === null) return res.status(400).json({ error: 'invalid duration - use e.g. 45s, 30m, 6h, 3d, 2w, 1y' });
        expiresAt = new Date(Date.now() + ms).toISOString();
    }

    db.run(`UPDATE User_Data SET IsBanned = 1, BanReason = ?, BanExpiresAt = ? WHERE username = ?`, [reason, expiresAt, target], function(err) {
        if (err) return res.status(500).json({ error: 'db error' });
        if (this.changes === 0) return res.status(404).json({ error: 'user not found' });
        logAudit('account_banned', req.session.userUsername, target, expiresAt ? `${reason} (until ${expiresAt})` : reason);
        // Push ban event to any open SSE streams for this user, and email them
        db.get(`SELECT id, email FROM User_Data WHERE username = ?`, [target], (err2, row) => {
            if (!err2 && row) {
                userBus.emit(`user:${row.id}`, { event: 'banned', type: 'account', reason, expiresAt });
                if (row.email) sendAccountBannedEmail(row.email, target, reason, expiresAt);
            }
        });
        res.json({ ok: true, banned: true, username: target, expiresAt });
    });
});

app.post('/admin/unban/:username', requireAdmin, (req, res) => {
    const target = req.params.username;
    db.run(`UPDATE User_Data SET IsBanned = 0, BanReason = NULL, BanExpiresAt = NULL WHERE username = ?`, [target], function(err) {
        if (err) return res.status(500).json({ error: 'db error' });
        if (this.changes === 0) return res.status(404).json({ error: 'user not found' });
        logAudit('account_unbanned', req.session.userUsername, target, null);
        db.get(`SELECT email FROM User_Data WHERE username = ?`, [target], (err2, row) => {
            if (!err2 && row && row.email) sendAccountUnbannedEmail(row.email, target);
        });
        res.json({ ok: true, banned: false, username: target });
    });
});

// Issues a warning against an account's standing. Unlike bans, an
// expiration is REQUIRED - warnings are meant to fade, not stick around
// forever - so `duration` must parse to a positive amount (e.g. 30m, 6h,
// 3d, 2w, 1y).
// Optional expiration: blank/omitted duration means the warning never
// expires (expiresAt stays null and it counts toward standing forever). A
// non-blank duration must still parse to a valid positive amount.
// Optional `mute` (truthy) blocks the user from sending DMs/group chat
// messages until this warning expires - see isUserMuted(). Optional
// `reportId` (used by the /admin/reports/:id quick actions) snapshots that
// report's content/attachments onto the warning, so the warned user can
// still see exactly what got them warned in their email and on /standing -
// this is also how the ban/delete quick actions attach the offending
// content, by issuing a warning first (see reportBan/reportDeleteAccount).
app.post('/admin/warn/:username', requireAdmin, (req, res) => {
    const target = req.params.username;
    const reason = (req.body.reason || '').trim().substring(0, 500);
    if (!reason) return res.status(400).json({ error: 'a reason is required' });
    const muteChat = req.body.mute ? 1 : 0;
    let expiresAt = null;
    if (req.body.duration && String(req.body.duration).trim()) {
        const ms = parseBanDuration(req.body.duration);
        if (ms === null) return res.status(400).json({ error: 'invalid expiration - use e.g. 45s, 30m, 6h, 3d, 2w, 1y, or leave blank to never expire' });
        expiresAt = new Date(Date.now() + ms).toISOString();
    }
    const reportId = parseInt(req.body.reportId, 10);
    // accountAction records what this warning was issued alongside (a ban or
    // an account deletion), if anything - see the account_action column
    // comment. Only the known values are accepted; anything else (including
    // omitted, for an ordinary warning) is stored as NULL.
    const ACCOUNT_ACTIONS = ['temp_ban', 'perm_ban', 'delete'];
    const accountAction = ACCOUNT_ACTIONS.includes(req.body.accountAction) ? req.body.accountAction : null;

    db.get(`SELECT id, email FROM User_Data WHERE username = ?`, [target], (err, user) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!user) return res.status(404).json({ error: 'user not found' });

        function insertWarning(removedContent, removedAttachmentsJson, linkedReportId) {
            db.run(`INSERT INTO Warnings (username, reason, issued_by, expires_at, mute_chat, removed_content, removed_attachments_json, report_id, account_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [target, reason, req.session.userUsername, expiresAt, muteChat, removedContent, removedAttachmentsJson, linkedReportId || null, accountAction], function(err2) {
                    if (err2) return res.status(500).json({ error: 'db error' });
                    logAudit('warning_issued', req.session.userUsername, target, expiresAt ? `${reason} (expires ${expiresAt})` : `${reason} (never expires)`);
                    if (user.email) {
                        sendWarningEmail(user.email, target, reason, expiresAt, {
                            mute_chat: muteChat,
                            removed_content: removedContent,
                            removed_attachments_json: removedAttachmentsJson
                        });
                    }
                    getWarningsForUser(target, (err3, warnings) => {
                        const activeCount = err3 ? null : warnings.filter(isWarningActive).length;
                        res.json({ ok: true, id: this.lastID, username: target, expiresAt, mute: !!muteChat, standing: activeCount === null ? null : getStanding(activeCount) });
                    });
                });
        }

        if (Number.isInteger(reportId)) {
            db.get(`SELECT reported_username, content, attachments_json FROM Reports WHERE id = ?`, [reportId], (errR, report) => {
                // Only attach the snapshot if the report actually matches
                // this target - an invalid/mismatched reportId just falls
                // back to a plain warning instead of failing outright.
                if (!errR && report && report.reported_username === target) {
                    insertWarning(report.content, report.attachments_json, reportId);
                } else {
                    insertWarning(null, null, null);
                }
            });
        } else {
            insertWarning(null, null, null);
        }
    });
});

// Lists every warning (active + expired) for a user, plus their current
// standing. Expired warnings are included so history isn't lost, each
// flagged with `active: false`.
app.get('/admin/warnings/:username', requireAdmin, (req, res) => {
    const target = req.params.username;
    getWarningsForUser(target, (err, warnings) => {
        if (err) return res.status(500).json({ error: 'db error' });
        const decorated = warnings.map(w => ({ ...w, active: isWarningActive(w) }));
        const activeCount = decorated.filter(w => w.active).length;
        res.json({ username: target, standing: getStanding(activeCount), warnings: decorated });
    });
});

// Manually expires a warning early (pulls expires_at back to now) instead
// of deleting it, so it stops affecting standing but still shows up in the
// warnings list, same as a naturally-expired one.
app.post('/admin/warnings/:id/revoke', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid warning id' });
    db.get(`SELECT id, username, reason, expires_at FROM Warnings WHERE id = ?`, [id], (err, warning) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!warning) return res.status(404).json({ error: 'warning not found' });
        if (!isWarningActive(warning)) return res.status(400).json({ error: 'warning is already expired' });
        const now = new Date().toISOString();
        db.run(`UPDATE Warnings SET expires_at = ? WHERE id = ?`, [now, id], (err2) => {
            if (err2) return res.status(500).json({ error: 'db error' });
            logAudit('warning_revoked', req.session.userUsername, warning.username, `warning #${id}`);
            db.get(`SELECT email FROM User_Data WHERE username = ?`, [warning.username], (err3, row) => {
                if (!err3 && row && row.email) sendWarningRevokedEmail(row.email, warning.username, warning.reason);
            });
            res.json({ ok: true, id });
        });
    });
});

// Registration gate: ON = new signups are created banned pending manual
// activation and admins get pinged. OFF = registration is open, accounts
// are created active immediately, no pings sent.
app.get('/admin/registration-gate', requireAdmin, (req, res) => {
    res.json({ enabled: registrationGateEnabled });
});

app.post('/admin/registration-gate', requireAdmin, requireHeadAdmin, (req, res) => {
    const enabled = !!req.body.enabled;
    setRegistrationGateEnabled(enabled, (err) => {
        if (err) return res.status(500).json({ error: 'db error' });
        logAudit(enabled ? 'registration_gate_enabled' : 'registration_gate_disabled', req.session.userUsername, null, null);
        res.json({ ok: true, enabled: registrationGateEnabled });
    });
});

// Lets an admin/owner inspect and fix up anyone's public profile (avatar,
// nickname, bio) - e.g. removing an inappropriate pfp or bio without doing
// a full account deletion.
app.get('/admin/profile/:username', requireAdmin, (req, res) => {
    const target = req.params.username;
    db.get(`SELECT username, Nickname, bio, avatar_path, email FROM User_Data WHERE username = ?`, [target], (err, user) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!user) return res.status(404).json({ error: 'user not found' });
        res.json({
            username: user.username,
            Nickname: user.Nickname || '',
            bio: user.bio || '',
            email: user.email || '',
            avatar_url: user.avatar_path ? avatarPathToURL(user.avatar_path) : null
        });
    });
});

app.post('/admin/profile/:username/text', requireAdmin, (req, res) => {
    const target = req.params.username;
    let { nickname, bio } = req.body;
    nickname = (nickname || '').trim();
    bio = bio || '';
    if (nickname.length > MAX_NICKNAME_LENGTH) return res.status(400).json({ error: `Nickname too long - ${MAX_NICKNAME_LENGTH} character limit.` });
    if (bio.length > MAX_BIO_LENGTH) return res.status(400).json({ error: `Bio too long - ${MAX_BIO_LENGTH} character limit.` });
    db.run(`UPDATE User_Data SET Nickname = ?, bio = ? WHERE username = ?`, [nickname || null, bio, target], function(err) {
        if (err) return res.status(500).json({ error: 'db error' });
        if (this.changes === 0) return res.status(404).json({ error: 'user not found' });
        res.json({ ok: true, username: target });
    });
});

app.post('/admin/profile/:username/email', requireAdmin, (req, res) => {
    const target = req.params.username;
    const email = (req.body.email || '').trim().toLowerCase();
    if (email && !EMAIL_REGEX.test(email)) {
        return res.status(400).json({ error: 'That doesn\'t look like a valid email.' });
    }
    db.get(`SELECT id FROM User_Data WHERE username = ?`, [target], (err, user) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!user) return res.status(404).json({ error: 'user not found' });
        db.run(`UPDATE User_Data SET email = ? WHERE username = ?`, [email || null, target], function(err2) {
            if (err2) {
                if (err2.message && err2.message.includes('.email')) {
                    return res.status(400).json({ error: 'That email is already linked to another account.' });
                }
                return res.status(500).json({ error: 'db error' });
            }
            if (this.changes === 0) return res.status(404).json({ error: 'user not found' });
            logAudit('admin_email_changed', req.session.userUsername, target, email ? `set to ${email}` : 'cleared');
            res.json({ ok: true, username: target, email });
        });
    });
});

app.post('/admin/profile/:username/avatar', requireAdmin, (req, res) => {
    const target = req.params.username;
    db.get(`SELECT id FROM User_Data WHERE username = ?`, [target], (err, user) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!user) return res.status(404).json({ error: 'user not found' });
        adminAvatarUpload.single('avatar')(req, res, (uploadErr) => {
            if (uploadErr || !req.file) return res.status(400).json({ error: uploadErr ? uploadErr.message : 'No file uploaded.' });
            db.run(`UPDATE User_Data SET avatar_path = ? WHERE username = ?`, [req.file.path, target], (err2) => {
                if (err2) return res.status(500).json({ error: 'db error' });
                res.json({ ok: true, username: target, avatar_url: avatarPathToURL(req.file.path) });
            });
        });
    });
});

app.post('/admin/profile/:username/reset-avatar', requireAdmin, (req, res) => {
    const target = req.params.username;
    db.run(`UPDATE User_Data SET avatar_path = ? WHERE username = ?`, ['public/Default.png', target], function(err) {
        if (err) return res.status(500).json({ error: 'db error' });
        if (this.changes === 0) return res.status(404).json({ error: 'user not found' });
        res.json({ ok: true, username: target, avatar_url: avatarPathToURL('public/Default.png') });
    });
});

// Soft-deletes an account: keeps the row (and username) in the DB, but wipes
// the public-facing identity - avatar reverts to the default, nickname/bio
// are cleared and replaced with a placeholder so the account reads as gone.
// Uses the separate IsDeleted/DeleteReason columns (rather than IsBanned) so
// deleted accounts are enforced and displayed distinctly from banned ones,
// and removes all of its posts. A reason is required.
app.post('/admin/delete-account/:username', requireAdmin, (req, res) => {
    const target = req.params.username;
    if (target === req.session.userUsername) return res.status(400).json({ error: 'cannot delete your own account' });
    const reason = ((req.body && req.body.reason) || '').trim().substring(0, 500);
    if (!reason) return res.status(400).json({ error: 'a reason is required to delete an account' });
    db.run(
        `UPDATE User_Data SET avatar_path = ?, Nickname = ?, bio = ?, IsDeleted = 1, DeleteReason = ? WHERE username = ?`,
        ['public/Default.png', 'Account Deleted', '', reason, target],
        function(err) {
            if (err) return res.status(500).json({ error: 'db error' });
            if (this.changes === 0) return res.status(404).json({ error: 'user not found' });
            db.all(`SELECT file_path, file_name, files_json FROM Posts WHERE username = ?`, [target], (errPre, postRows) => {
            const attachments = (postRows || []).reduce((acc, r) => acc.concat(getAttachments(r)), []);
            db.run(`DELETE FROM Posts WHERE username = ?`, [target], (err2) => {
                if (err2) return res.status(500).json({ error: 'db error deleting posts' });
                cleanupAttachmentFiles(attachments);
                // Push a deleted event to any open SSE streams for this user, and email them
                db.get(`SELECT id, email FROM User_Data WHERE username = ?`, [target], (err3, row) => {
                    if (!err3 && row) {
                        userBus.emit(`user:${row.id}`, { event: 'deleted', type: 'deleted', reason });
                        if (row.email) sendAccountDeletedEmail(row.email, target, reason);
                    }
                });
                logAudit('account_deleted', req.session.userUsername, target, reason);
                res.json({ ok: true, deleted: true, username: target });
            });
            });
        }
    );
});

// Permanently removes a user and every row tied to their username/id across
// the schema. Unlike the soft-delete above, there's no row left behind and
// the username becomes available again. Used by both the admin hard-delete
// route and self-service account deletion from the dashboard.
function hardDeleteAccount(username, reason, callback) {
    db.get(`SELECT id, email FROM User_Data WHERE username = ?`, [username], (err, row) => {
        if (err) return callback(err);
        if (!row) return callback(new Error('user not found'));
        const userId = row.id;
        const email = row.email;
        // Gather every attachment this user owns (DMs, posts, group chat
        // messages) BEFORE any row is deleted, so the files can be cleaned
        // up from disk once the rows referencing them are gone.
        db.all(`SELECT file_path, file_name, files_json FROM Messages WHERE from_user = ? OR to_user = ?`, [username, username], (errM, msgRows) => {
        db.all(`SELECT file_path, file_name, files_json FROM Posts WHERE username = ?`, [username], (errP, postRows) => {
        db.all(`SELECT file_path, file_name, files_json FROM Group_Chat_Messages WHERE from_user = ?`, [username], (errG, gcRows) => {
            const attachments = []
                .concat((msgRows || []).reduce((acc, r) => acc.concat(getAttachments(r)), []))
                .concat((postRows || []).reduce((acc, r) => acc.concat(getAttachments(r)), []))
                .concat((gcRows || []).reduce((acc, r) => acc.concat(getAttachments(r)), []));
        db.serialize(() => {
            db.run(`DELETE FROM Messages WHERE from_user = ? OR to_user = ?`, [username, username]);
            db.run(`DELETE FROM Password_Resets WHERE user_id = ?`, [userId]);
            db.run(`DELETE FROM Email_Changes WHERE user_id = ?`, [userId]);
            db.run(`DELETE FROM Email_Verifications WHERE user_id = ?`, [userId]);
            db.run(`DELETE FROM Posts WHERE username = ?`, [username]);
            db.run(`DELETE FROM Follows WHERE follower_username = ? OR following_username = ?`, [username, username]);
            db.run(`DELETE FROM Friend_Requests WHERE from_user = ? OR to_user = ?`, [username, username]);
            db.run(`DELETE FROM Friends WHERE user_a = ? OR user_b = ?`, [username, username]);
            db.run(`DELETE FROM Notifications WHERE username = ? OR actor_username = ?`, [username, username]);
            db.run(`DELETE FROM Group_Chat_Members WHERE username = ?`, [username]);
            db.run(`DELETE FROM Group_Chat_Messages WHERE from_user = ?`, [username]);
            // Warnings are keyed by username (not user_id), and hard-delete frees
            // the username for reuse - without this, a brand new account created
            // with the same username would inherit the deleted user's entire
            // warning history and standing.
            db.run(`DELETE FROM Warnings WHERE username = ?`, [username]);
            db.run(`DELETE FROM User_Data WHERE username = ?`, [username], function (err2) {
                if (err2) return callback(err2);
                if (this.changes === 0) return callback(new Error('user not found'));
                cleanupAttachmentFiles(attachments);
                // Push a 'deleted' event to any open tabs for this user, same as
                // the soft delete above, so an active session sees the "Account
                // Deleted" screen immediately instead of waiting for its next
                // navigation (which the checkBan middleware would also catch).
                const cleanReason = reason || 'Account deleted';
                userBus.emit(`user:${userId}`, { event: 'deleted', type: 'deleted', reason: cleanReason });
                // Email captured before the row was deleted, since the address
                // is gone from the DB by the time we get here.
                if (email) sendAccountPermanentlyDeletedEmail(email, username, cleanReason);
                callback(null);
            });
        });
        });
        });
        });
    });
}

// Permanently deletes an account and all associated data from the database.
// This CANNOT be undone (unlike /admin/delete-account above, which keeps a
// hollowed-out row so the username stays reserved). Restricted to Head
// Admins/Owner given the blast radius.
app.post('/admin/delete-account-permanent/:username', requireAdmin, requireHeadAdmin, (req, res) => {
    const target = req.params.username;
    if (target === req.session.userUsername) return res.status(400).json({ error: 'cannot delete your own account here - use the dashboard' });
    const reason = ((req.body && req.body.reason) || '').trim().substring(0, 500);
    if (!reason) return res.status(400).json({ error: 'a reason is required to delete an account' });
    hardDeleteAccount(target, reason, (err) => {
        if (err) {
            if (err.message === 'user not found') return res.status(404).json({ error: 'user not found' });
            console.error('Hard delete error:', err.message);
            return res.status(500).json({ error: 'db error' });
        }
        logAudit('account_permanently_deleted', req.session.userUsername, target, reason);
        res.json({ ok: true, deleted: true, permanent: true, username: target });
    });
});

app.post('/admin/ipban', requireAdmin, (req, res) => {
    const { ip, reason } = req.body;
    if (!ip) return res.status(400).json({ error: 'ip is required' });
    const cleanReason = (reason || 'Banned by admin').substring(0, 500);
    const bannedBy = req.session.userUsername;
    db.run(
        `INSERT INTO IP_Bans (ip, reason, banned_by) VALUES (?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by, created_at = CURRENT_TIMESTAMP`,
        [ip, cleanReason, bannedBy],
        function(err) {
            if (err) return res.status(500).json({ error: 'db error' });
            logAudit('ip_banned', bannedBy, ip, cleanReason);
            // Notify only users currently connected from this exact IP - not
            // everyone with an open stream.
            userEventConnections.forEach(conn => {
                if (conn.ip === ip) {
                    sseSend(conn.res, 'banned', { event: 'banned', type: 'ip', reason: cleanReason });
                }
            });
            res.json({ ok: true, ip, reason: cleanReason });
        }
    );
});

app.post('/admin/unipban', requireAdmin, (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'ip is required' });
    db.run(`DELETE FROM IP_Bans WHERE ip = ?`, [ip], function(err) {
        if (err) return res.status(500).json({ error: 'db error' });
        if (this.changes === 0) return res.status(404).json({ error: 'ip not found in ban list' });
        logAudit('ip_unbanned', req.session.userUsername, ip, null);
        res.json({ ok: true, ip });
    });
});

app.get('/admin/ipbans', requireAdmin, (req, res) => {
    db.all(`SELECT ip, reason, banned_by, created_at FROM IP_Bans ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({ ipbans: rows || [] });
    });
});

app.get('/admin/badges/:username', requireAdmin, (req, res) => {
    const target = req.params.username;
    db.get(`SELECT IsOwner, IsHeadAdmin, IsAdmin, IsDeveloper, IsSupporter, IsVerified FROM User_Data WHERE username = ?`, [target], (err, user) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!user) return res.status(404).json({ error: 'user not found' });
        res.json(user);
    });
});

app.post('/admin/badges/:username', requireAdmin, (req, res) => {
    const target = req.params.username;
    const { IsAdmin, IsHeadAdmin, IsSupporter, IsDeveloper, IsOwner, IsVerified } = req.body;

    const fields = [];
    const values = [];
    fields.push('IsSupporter = ?'); values.push(IsSupporter ? 1 : 0);
    fields.push('IsDeveloper = ?'); values.push(IsDeveloper ? 1 : 0);
    fields.push('IsVerified = ?'); values.push(IsVerified ? 1 : 0);

    // Only an existing Owner can grant or revoke the Admin and Owner badges -
    // otherwise any admin could hand out admin (or owner) access to anyone.
    if (req.isHeadAdmin) {
        if (typeof IsAdmin !== 'undefined') { fields.push('IsAdmin = ?'); values.push(IsAdmin ? 1 : 0); }
    }
    if (req.isOwner) {
        if (typeof IsHeadAdmin !== 'undefined') { fields.push('IsHeadAdmin = ?'); values.push(IsHeadAdmin ? 1 : 0); }
        if (typeof IsOwner !== 'undefined') { fields.push('IsOwner = ?'); values.push(IsOwner ? 1 : 0); }
    }

    values.push(target);
    db.run(`UPDATE User_Data SET ${fields.join(', ')} WHERE username = ?`, values, function(err) {
        if (err) return res.status(500).json({ error: 'db error' });
        if (this.changes === 0) return res.status(404).json({ error: 'user not found' });
        res.json({ ok: true, username: target });
    });
});

app.post('/admin/pin/:id', requireAdmin, (req, res) => {
    const postId = parseInt(req.params.id);
    if (!postId) return res.status(400).json({ error: 'invalid id' });
    db.run(`UPDATE Posts SET pinned = 1 WHERE id = ?`, [postId], function(err) {
        if (err) return res.status(500).json({ error: 'db error' });
        if (this.changes === 0) return res.status(404).json({ error: 'post not found' });
        res.json({ ok: true });
    });
});

app.post('/admin/unpin/:id', requireAdmin, (req, res) => {
    const postId = parseInt(req.params.id);
    if (!postId) return res.status(400).json({ error: 'invalid id' });
    db.run(`UPDATE Posts SET pinned = 0 WHERE id = ?`, [postId], function(err) {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({ ok: true });
    });
});

app.get('/admin/users', requireAdmin, (req, res) => {
    db.all(`SELECT id, username, IsBanned, BanReason, IsOwner, IsHeadAdmin, IsAdmin, IsDeveloper, IsSupporter FROM User_Data ORDER BY id ASC`, [], (err, users) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({ users: users || [] });
    });
});

// ----- Support tickets (admin) -----
// Standalone page, linked from the admin dashboard, listing every ticket
// submitted via the public /support form. Clicking a row opens the ticket's
// own page (/admin/support/:id) rather than a modal, so it can hold a full
// reply form without feeling cramped.
function renderSupportTopbar(title) {
    return `<div id="topbar">
    <strong>${escapeHTML(title)}</strong>
    <div id="topbar-right" style="position:relative;display:flex;align-items:center;">
        <a href="/admin/dashboard">Admin Dashboard</a>
        <a href="/admin/reports">Reports</a>
        <a href="/admin/support">Support Tickets</a>
        <a href="/feed">Feed</a>
        <a href="/logout">Logout</a>
        <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
        <nav id="nav-dropdown">
            <a href="/admin/dashboard">Admin Dashboard</a>
            <a href="/admin/reports">Reports</a>
            <a href="/admin/support">Support Tickets</a>
            <a href="/feed">Feed</a>
            <a href="/logout">Logout</a>
        </nav>
    </div>
</div>`;
}

const SUPPORT_NAV_SCRIPT = `
<script>
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
</script>`;

app.get('/admin/support', requireAdmin, (req, res) => {
    db.all(`SELECT id, username, subject, status, created_at FROM Support_Tickets ORDER BY (status = 'open') DESC, id DESC`, [], (err, tickets) => {
        if (err) return res.status(500).send('DB error');
        const rows = (tickets || []).map(t => `<tr class="ticket-row" onclick="window.location.href='/admin/support/${t.id}'">
            <td style="opacity:0.5;">#${t.id}</td>
            <td style="word-break:break-word;overflow-wrap:break-word;">${escapeHTML(t.subject)}</td>
            <td><a href="/user/${escapeHTML(t.username)}" onclick="event.stopPropagation();" style="color:var(--text-color);text-decoration:none;">@${escapeHTML(t.username)}</a></td>
            <td>${t.status === 'open' ? '<span style="color:var(--warning-color, #d9a441);font-weight:700;">Open</span>' : '<span style="color:var(--success-color);font-weight:700;">Resolved</span>'}</td>
            <td style="font-size:0.78em;opacity:0.5;white-space:nowrap;">${escapeHTML(t.created_at || '')}</td>
        </tr>`).join('');

        res.send(`<!DOCTYPE html>
<html lang="en" class="page-admin">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Support Tickets</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
<style>
    .table-scroll-wrap { display:block !important; width:100% !important; max-width:100% !important; overflow-x:auto !important; -webkit-overflow-scrolling:touch; }
    .ticket-row { cursor:pointer; }
    .ticket-row:hover { background:rgba(255,255,255,0.05); }
</style>
</head>
<body class="page-admin">
${renderSupportTopbar('Support Tickets')}
<div id="content">
    <h1>Support Tickets</h1>
    <p style="opacity:0.5;margin-top:4px;">Click a ticket to see the full message and reply.</p>

    <div class="panel">
        <div class="table-scroll-wrap">
            <table>
                <thead><tr><th>#</th><th>Subject</th><th>Account</th><th>Status</th><th>Submitted</th></tr></thead>
                <tbody>
                    ${rows || '<tr><td colspan="5" style="opacity:0.4;">No support tickets.</td></tr>'}
                </tbody>
            </table>
        </div>
    </div>
</div>
${SUPPORT_NAV_SCRIPT}
</body>
</html>`);
    });
});

app.get('/admin/support/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).send(renderMessagePage('Not Found', 'Ticket not found', `<h3>That ticket doesn't exist.</h3><br><br><button type="button" class="button" style="width: 180px" onclick="window.location.href='/admin/support';">Back to tickets</button>`));

    db.get(`SELECT id, username, email, subject, message, status, created_at, ip FROM Support_Tickets WHERE id = ?`, [id], (err, ticket) => {
        if (err) return res.status(500).send('DB error');
        if (!ticket) return res.status(404).send(renderMessagePage('Not Found', 'Ticket not found', `<h3>That ticket doesn't exist.</h3><br><br><button type="button" class="button" style="width: 180px" onclick="window.location.href='/admin/support';">Back to tickets</button>`));

        db.all(`SELECT ip, event, changed_from_previous, created_at FROM IP_Login_History WHERE username = ? ORDER BY id DESC LIMIT 15`, [ticket.username], (errIP, ipHistory) => {
        const ticketIPKnown = !!(ipHistory && ipHistory.length && ticket.ip);
        const ticketIPMatchesLatest = ticketIPKnown && ipHistory[0].ip === ticket.ip;
        const ipSectionHTML = `
        <p style="font-size:0.9em;"><strong>Submitted from IP:</strong> ${ticket.ip ? escapeHTML(ticket.ip) : '<span style="opacity:0.4;">unknown (submitted by email)</span>'}${
            ticketIPKnown ? (ticketIPMatchesLatest
                ? ' <span style="color:var(--success-color);">(matches account\'s most recent login IP)</span>'
                : ' <span style="color:var(--danger-color);font-weight:700;">(does NOT match account\'s most recent login IP - worth a closer look)</span>')
                : ''
        }</p>
        <details style="margin-top:6px;">
            <summary style="cursor:pointer;font-size:0.85em;opacity:0.7;">Recent login IP history for @${escapeHTML(ticket.username)} (${(ipHistory || []).length})</summary>
            ${(ipHistory && ipHistory.length) ? `<table style="width:100%;font-size:0.8em;margin-top:8px;border-collapse:collapse;">
                <tr style="opacity:0.6;text-align:left;"><th style="padding:2px 8px 2px 0;">IP</th><th style="padding:2px 8px;">Event</th><th style="padding:2px 8px;">When</th></tr>
                ${ipHistory.map(h => `<tr${h.changed_from_previous ? ' style="color:var(--danger-color);font-weight:700;"' : ''}>
                    <td style="padding:2px 8px 2px 0;">${escapeHTML(h.ip)}${h.changed_from_previous ? ' ⚠️ changed' : ''}</td>
                    <td style="padding:2px 8px;">${escapeHTML(h.event)}</td>
                    <td style="padding:2px 8px;">${escapeHTML(h.created_at || '')}</td>
                </tr>`).join('')}
            </table>` : `<p style="opacity:0.4;font-size:0.85em;margin-top:6px;">No login history recorded yet.</p>`}
        </details>`;

        db.all(`SELECT admin_username, message, created_at, is_customer, customer_email FROM Support_Ticket_Replies WHERE ticket_id = ? ORDER BY id ASC`, [id], (err2, replies) => {
            const repliesHTML = (replies || []).map(r => {
                const isCustomer = !!r.is_customer;
                const who = isCustomer
                    ? `${escapeHTML(r.admin_username)} <span style="opacity:0.6;">(customer${r.customer_email ? ' · ' + escapeHTML(r.customer_email) : ''})</span>`
                    : `${escapeHTML(r.admin_username)} <span style="opacity:0.6;">(admin)</span>`;
                return `<div style="border-top:1px solid rgba(255,255,255,0.1);${isCustomer ? 'border-left:3px solid var(--warning-color, #d9a441);padding-left:10px;' : ''}padding-top:12px;padding-bottom:12px;">
                <div style="font-size:0.78em;opacity:0.5;margin-bottom:4px;">${who} · ${escapeHTML(r.created_at || '')}</div>
                <div style="word-break:break-word;overflow-wrap:break-word;">${renderMarkdown(r.message)}</div>
            </div>`;
            }).join('');

            let bannerHTML = '';
            if (req.query.sent === '1') bannerHTML = `<p style="color:var(--success-color);font-weight:700;">Reply sent.</p>`;
            else if (req.query.sent === '0') bannerHTML = `<p style="color:var(--danger-color);font-weight:700;">Reply saved, but the email could not be sent - check the SMTP configuration.</p>`;
            else if (req.query.error) bannerHTML = `<p style="color:var(--danger-color);font-weight:700;">${escapeHTML(req.query.error)}</p>`;

            const statusLabel = ticket.status === 'open'
                ? '<span style="color:var(--warning-color, #d9a441);font-weight:700;">Open</span>'
                : '<span style="color:var(--success-color);font-weight:700;">Resolved</span>';

            res.send(`<!DOCTYPE html>
<html lang="en" class="page-admin">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ticket #${ticket.id} - Support</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
</head>
<body class="page-admin">
${renderSupportTopbar('Support Ticket #' + ticket.id)}
<div id="content">
    <p><a href="/admin/support" style="color:var(--text-color);opacity:0.6;text-decoration:none;">< Back to tickets</a></p>
    ${bannerHTML}

    <div class="panel">
        <h2 style="word-break:break-word;overflow-wrap:break-word;">${escapeHTML(ticket.subject)}</h2>
        <p style="opacity:0.5;font-size:0.85em;margin-top:-6px;">Ticket #${ticket.id} · ${escapeHTML(ticket.created_at || '')}</p>
        <p style="font-size:0.9em;"><strong>Account:</strong> <a href="/user/${escapeHTML(ticket.username)}" style="color:var(--text-color);">@${escapeHTML(ticket.username)}</a></p>
        <p style="font-size:0.9em;"><strong>Contact email:</strong> ${escapeHTML(ticket.email)}</p>
        <p style="font-size:0.9em;"><strong>Status:</strong> ${statusLabel}</p>
        ${ipSectionHTML}
        <hr style="border-color:rgba(255,255,255,0.15);margin:14px 0;">
        <div style="word-break:break-word;overflow-wrap:break-word;">${renderMarkdown(ticket.message)}</div>
        <form method="POST" action="/admin/support/${ticket.id}/status" class="action-row">
            <input type="hidden" name="status" value="${ticket.status === 'open' ? 'resolved' : 'open'}">
            <button type="submit" class="button" style="width:auto;padding:8px 16px;">${ticket.status === 'open' ? 'Mark Resolved' : 'Reopen'}</button>
        </form>
    </div>

    <div class="panel">
        <h2>Replies</h2>
        ${repliesHTML || '<p style="opacity:0.4;font-size:0.85em;">No replies yet.</p>'}
        <hr style="border-color:rgba(255,255,255,0.15);margin:14px 0;">
        <form method="POST" action="/admin/support/${ticket.id}/reply">
            <label>Reply <span style="opacity:0.4;">(emailed to ${escapeHTML(ticket.email)})</span></label>
            <textarea class="box" name="reply" placeholder="Type your reply..." required maxlength="${MAX_SUPPORT_MSG_LENGTH}" rows="6" style="width:100%;resize:vertical;font-family:inherit;padding:8px;box-sizing:border-box;"></textarea>
            <div class="action-row">
                <button type="submit" class="button" style="width:auto;padding:8px 16px;">Send Reply</button>
            </div>
        </form>
    </div>
</div>
${SUPPORT_NAV_SCRIPT}
</body>
</html>`);
        });
        });
    });
});

app.post('/admin/support/:id/status', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).send('Ticket not found.');
    const status = req.body.status;
    if (status !== 'open' && status !== 'resolved') return res.redirect(`/admin/support/${id}?error=` + encodeURIComponent("Status must be 'open' or 'resolved'."));
    db.run(`UPDATE Support_Tickets SET status = ? WHERE id = ?`, [status, id], function (err) {
        if (err || this.changes === 0) return res.redirect(`/admin/support/${id}?error=` + encodeURIComponent('Failed to update ticket.'));
        logAudit(status === 'resolved' ? 'support_ticket_resolved' : 'support_ticket_reopened', req.session.userUsername, null, `ticket #${id}`);
        res.redirect(`/admin/support/${id}`);
    });
});

app.post('/admin/support/:id/reply', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).send('Ticket not found.');
    const reply = (req.body.reply || '').trim();
    if (!reply) return res.redirect(`/admin/support/${id}?error=` + encodeURIComponent('Reply cannot be empty.'));
    if (reply.length > MAX_SUPPORT_MSG_LENGTH) return res.redirect(`/admin/support/${id}?error=` + encodeURIComponent(`Reply too long - ${MAX_SUPPORT_MSG_LENGTH} character limit.`));

    db.get(`SELECT id, username, email, subject, message FROM Support_Tickets WHERE id = ?`, [id], (err, ticket) => {
        if (err) return res.redirect(`/admin/support/${id}?error=` + encodeURIComponent('Failed to load ticket.'));
        if (!ticket) return res.status(404).send('Ticket not found.');

        const admin = req.session.userUsername;
        db.run(`INSERT INTO Support_Ticket_Replies (ticket_id, admin_username, message) VALUES (?, ?, ?)`,
            [id, admin, reply], async function (err2) {
                if (err2) return res.redirect(`/admin/support/${id}?error=` + encodeURIComponent('Failed to save reply.'));
                logAudit('support_ticket_replied', admin, ticket.username, `ticket #${id}`);
                const sent = await sendSupportReplyEmail(ticket, reply, admin);
                res.redirect(`/admin/support/${id}?sent=${sent ? '1' : '0'}`);
            });
    });
});

// ----- Reports (admin) -----
// Standalone page, linked from the admin dashboard, listing every report
// filed via the "Report" button on a feed post, DM, or group chat message.
// Mirrors the Support Tickets page's list/detail/status shape.
const REPORT_SOURCE_LABELS = { post: 'Post', dm: 'DM', gc: 'Group Chat' };
function reportSourceLink(r) {
    if (r.source_type === 'post') return `<a href="/post/${r.source_id}" style="color:var(--text-color);">#${r.source_id}</a>`;
    if (r.source_type === 'gc') return `<span style="opacity:0.6;">msg #${r.source_id}</span>`;
    return `<span style="opacity:0.6;">msg #${r.source_id}</span>`;
}

app.get('/admin/reports', requireAdmin, (req, res) => {
    db.all(`SELECT id, reporter_username, reported_username, source_type, source_id, content, attachments_json, status, created_at FROM Reports ORDER BY (status = 'open') DESC, id DESC`, [], (err, reports) => {
        if (err) return res.status(500).send('DB error');
        const rows = (reports || []).map(r => {
            const snippet = escapeHTML((r.content || '').trim().slice(0, 80)) + ((r.content || '').length > 80 ? '…' : '');
            const attachmentMarker = r.attachments_json ? ' <span title="Has attachment(s)">📎</span>' : '';
            return `<tr class="ticket-row" onclick="window.location.href='/admin/reports/${r.id}'">
            <td style="opacity:0.5;">#${r.id}</td>
            <td>${REPORT_SOURCE_LABELS[r.source_type] || r.source_type}</td>
            <td><a href="/user/${escapeHTML(r.reported_username)}" onclick="event.stopPropagation();" style="color:var(--text-color);text-decoration:none;">@${escapeHTML(r.reported_username)}</a></td>
            <td><a href="/user/${escapeHTML(r.reporter_username)}" onclick="event.stopPropagation();" style="color:var(--text-color);text-decoration:none;">@${escapeHTML(r.reporter_username)}</a></td>
            <td style="opacity:0.7;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${snippet || '<span style="opacity:0.4;">(no text)</span>'}${attachmentMarker}</td>
            <td>${r.status === 'open' ? '<span style="color:var(--warning-color, #d9a441);font-weight:700;">Open</span>' : '<span style="color:var(--success-color);font-weight:700;">Resolved</span>'}</td>
            <td style="font-size:0.78em;opacity:0.5;white-space:nowrap;">${escapeHTML(r.created_at || '')}</td>
        </tr>`;
        }).join('');

        res.send(`<!DOCTYPE html>
<html lang="en" class="page-admin">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reports</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
<style>
    .table-scroll-wrap { display:block !important; width:100% !important; max-width:100% !important; overflow-x:auto !important; -webkit-overflow-scrolling:touch; }
    .ticket-row { cursor:pointer; }
    .ticket-row:hover { background:rgba(255,255,255,0.05); }
</style>
</head>
<body class="page-admin">
${renderSupportTopbar('Reports')}
<div id="content">
    <h1>Reports</h1>
    <p style="opacity:0.5;margin-top:4px;">Content reported by users from the feed, DMs, and group chats. Click a report to see the full snapshot.</p>

    <div class="panel">
        <div class="table-scroll-wrap">
            <table>
                <thead><tr><th>#</th><th>Source</th><th>Reported</th><th>Reporter</th><th>Content</th><th>Status</th><th>Filed</th></tr></thead>
                <tbody>
                    ${rows || '<tr><td colspan="7" style="opacity:0.4;">No reports.</td></tr>'}
                </tbody>
            </table>
        </div>
    </div>
</div>
${SUPPORT_NAV_SCRIPT}
</body>
</html>`);
    });
});

app.get('/admin/reports/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).send(renderMessagePage('Not Found', 'Report not found', `<h3>That report doesn't exist.</h3><br><br><button type="button" class="button" style="width: 180px" onclick="window.location.href='/admin/reports';">Back to reports</button>`));

    db.get(`SELECT id, reporter_username, reported_username, source_type, source_id, content, attachments_json, status, created_at FROM Reports WHERE id = ?`, [id], (err, report) => {
        if (err) return res.status(500).send('DB error');
        if (!report) return res.status(404).send(renderMessagePage('Not Found', 'Report not found', `<h3>That report doesn't exist.</h3><br><br><button type="button" class="button" style="width: 180px" onclick="window.location.href='/admin/reports';">Back to reports</button>`));

        let attachments = [];
        if (report.attachments_json) {
            try { attachments = JSON.parse(report.attachments_json) || []; } catch (e) {}
        }
        const attachmentsHTML = renderAttachmentsHTML(attachments, 400, '500px');

        let bannerHTML = '';
        if (req.query.error) bannerHTML = `<p style="color:var(--danger-color);font-weight:700;">${escapeHTML(req.query.error)}</p>`;

        const statusLabel = report.status === 'open'
            ? '<span style="color:var(--warning-color, #d9a441);font-weight:700;">Open</span>'
            : '<span style="color:var(--success-color);font-weight:700;">Resolved</span>';

        res.send(`<!DOCTYPE html>
<html lang="en" class="page-admin">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Report #${report.id}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
<style>
    .report-action-form { margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.1); }
    .report-action-form label { display:block;font-size:0.85em;opacity:0.7;margin-bottom:4px; }
    .report-action-form input, .report-action-form textarea { width:100%;box-sizing:border-box;font-family:inherit;padding:6px;margin-bottom:8px; }
    .report-action-result { font-size:0.85em;margin-top:6px;min-height:1.2em; }
    .report-action-result.ok { color:var(--success-color); }
    .report-action-result.err { color:var(--danger-color); }
</style>
</head>
<body class="page-admin">
${renderSupportTopbar('Report #' + report.id)}
<div id="content">
    <p><a href="/admin/reports" style="color:var(--text-color);opacity:0.6;text-decoration:none;">< Back to reports</a></p>
    ${bannerHTML}
    <input type="hidden" id="report-target-username" value="${escapeHTML(report.reported_username)}">

    <div class="panel">
        <h2>${REPORT_SOURCE_LABELS[report.source_type] || report.source_type} reported</h2>
        <p style="opacity:0.5;font-size:0.85em;margin-top:-6px;">Report #${report.id} · ${escapeHTML(report.created_at || '')}</p>
        <p style="font-size:0.9em;"><strong>Reported account:</strong> <a href="/user/${escapeHTML(report.reported_username)}" style="color:var(--text-color);">@${escapeHTML(report.reported_username)}</a></p>
        <p style="font-size:0.9em;"><strong>Reported by:</strong> <a href="/user/${escapeHTML(report.reporter_username)}" style="color:var(--text-color);">@${escapeHTML(report.reporter_username)}</a></p>
        <p style="font-size:0.9em;"><strong>Source:</strong> ${REPORT_SOURCE_LABELS[report.source_type] || report.source_type} ${reportSourceLink(report)}</p>
        <p style="font-size:0.9em;"><strong>Status:</strong> <span id="report-status-label">${statusLabel}</span></p>
        <hr style="border-color:rgba(255,255,255,0.15);margin:14px 0;">
        <p style="opacity:0.5;font-size:0.8em;margin-bottom:4px;">Content at time of report:</p>
        <p style="white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;">${escapeHTML(report.content) || '<span style="opacity:0.4;">(no text)</span>'}</p>
        ${attachmentsHTML}
        <form method="POST" action="/admin/reports/${report.id}/status" class="action-row">
            <input type="hidden" name="status" value="${report.status === 'open' ? 'resolved' : 'open'}">
            <button type="submit" class="button" style="width:auto;padding:8px 16px;">${report.status === 'open' ? 'Mark Resolved' : 'Reopen'}</button>
        </form>
    </div>

    <div class="panel">
        <h2>Quick Actions <span style="opacity:0.5;font-weight:400;font-size:0.7em;">on @${escapeHTML(report.reported_username)}</span></h2>
        <p style="opacity:0.5;font-size:0.8em;margin-top:-6px;">Take action against the reported account without leaving this page. Each action also deletes the reported content. Ban/Delete also issue a permanent warning first (with the reason you give below and a copy of the reported content attached), so the user has something to see explaining what happened.</p>

        <div class="report-action-form">
            <h3 style="margin-bottom:8px;">Warn</h3>
            <label>Reason (required)</label>
            <textarea id="warn-reason" rows="2" placeholder="Reason for the warning..."></textarea>
            <label>Expires in <span style="opacity:0.5;">(e.g. 30m, 6h, 3d, 2w - blank never expires)</span></label>
            <input type="text" id="warn-duration" placeholder="Leave blank for permanent">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                <input type="checkbox" id="warn-mute" style="width:auto;height:auto;margin:0;">
                Mute user (blocks DMs, group chat, and feed posts/replies) until this warning expires
            </label>
            <button type="button" class="button" style="width:auto;padding:8px 16px;" onclick="reportWarn()">Warn User</button>
            <div id="warn-result" class="report-action-result"></div>
        </div>

        <div class="report-action-form">
            <h3 style="margin-bottom:8px;">Ban</h3>
            <label>Reason</label>
            <textarea id="ban-reason" rows="2" placeholder="Reason for the ban..."></textarea>
            <label>Duration <span style="opacity:0.5;">(e.g. 30m, 6h, 3d, 2w - blank is permanent)</span></label>
            <input type="text" id="ban-duration" placeholder="Leave blank for permanent">
            <button type="button" class="button" style="width:auto;padding:8px 16px;" onclick="reportBan()">Ban Account</button>
            <div id="ban-result" class="report-action-result"></div>
        </div>

        <div class="report-action-form">
            <h3 style="margin-bottom:8px;">Delete Account</h3>
            <label>Reason (required)</label>
            <textarea id="delete-reason" rows="2" placeholder="Reason for deletion..."></textarea>
            <button type="button" class="button" style="width:auto;padding:8px 16px;" onclick="reportDeleteAccount()">Delete Account</button>
            <div id="delete-result" class="report-action-result"></div>
        </div>
    </div>
</div>
${SUPPORT_NAV_SCRIPT}
<script>
    var reportTargetUsername = document.getElementById('report-target-username').value;
    var reportId = ${report.id};

    async function deleteReportedContent(resultEl) {
        try {
            const res = await fetch('/admin/reports/' + reportId + '/delete-content', { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.deleted) {
                resultEl.textContent += ' Reported content deleted.';
            } else if (res.ok) {
                resultEl.textContent += ' (Reported content was already gone.)';
            } else {
                resultEl.textContent += ' (Could not delete the reported content: ' + (data.error || res.status) + ')';
            }
        } catch (e) {
            resultEl.textContent += ' (Network error deleting reported content.)';
        }
    }

    async function reportWarn() {
        const reason = document.getElementById('warn-reason').value.trim();
        const duration = document.getElementById('warn-duration').value.trim();
        const mute = document.getElementById('warn-mute').checked;
        const resultEl = document.getElementById('warn-result');
        if (!reason) { resultEl.className = 'report-action-result err'; resultEl.textContent = 'A reason is required.'; return; }
        resultEl.className = 'report-action-result'; resultEl.textContent = 'Working…';
        try {
            const res = await fetch('/admin/warn/' + encodeURIComponent(reportTargetUsername), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason, duration, mute, reportId })
            });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'report-action-result err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            resultEl.className = 'report-action-result ok';
            resultEl.textContent = '@' + reportTargetUsername + ' has been warned (' + (data.expiresAt ? 'expires ' + new Date(data.expiresAt).toLocaleString() : 'never expires') + (data.mute ? ', chat muted' : '') + ').';
            await deleteReportedContent(resultEl);
        } catch (e) { resultEl.className = 'report-action-result err'; resultEl.textContent = 'Network error.'; }
    }

    // Issues a warning carrying "reason" and this report's content/
    // attachments before a ban or account deletion goes through - that way
    // the user still has something (the warning email, and their /standing
    // page if the account isn't gone for good) that shows exactly what got
    // them banned/deleted, since the ban/delete emails themselves don't
    // include the reported content. accountAction ('temp_ban', 'perm_ban',
    // or 'delete') is stored on the warning itself and shown in its "What
    // this affects" section - so even after an unban/undelete, the warning
    // still records what happened, separate from the admin's own reason
    // text. When called from reportBan(), duration is passed through so the
    // warning expires alongside the ban instead of outliving it;
    // reportDeleteAccount() leaves it unset (permanent), since a delete has
    // no expiry to match. Errors here are surfaced but don't block the
    // actual ban/delete from proceeding.
    async function issuePreActionWarning(reason, duration, accountAction) {
        try {
            const res = await fetch('/admin/warn/' + encodeURIComponent(reportTargetUsername), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason, duration: duration || '', mute: false, reportId, accountAction })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) return ' (Could not issue the explanatory warning: ' + (data.error || res.status) + ')';
        } catch (e) {
            return ' (Network error issuing the explanatory warning.)';
        }
        return '';
    }

    async function reportBan() {
        const reason = document.getElementById('ban-reason').value.trim() || 'Banned by admin';
        const duration = document.getElementById('ban-duration').value.trim();
        const resultEl = document.getElementById('ban-result');
        resultEl.className = 'report-action-result'; resultEl.textContent = 'Working…';
        const warnNote = await issuePreActionWarning(reason, duration, duration ? 'temp_ban' : 'perm_ban');
        try {
            const res = await fetch('/admin/ban/' + encodeURIComponent(reportTargetUsername), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason, duration })
            });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'report-action-result err'; resultEl.textContent = 'Error: ' + (data.error || res.status) + warnNote; return; }
            resultEl.className = 'report-action-result ok';
            resultEl.textContent = '@' + reportTargetUsername + ' has been banned' + (data.expiresAt ? ' until ' + new Date(data.expiresAt).toLocaleString() : ' permanently') + '.' + warnNote;
            await deleteReportedContent(resultEl);
        } catch (e) { resultEl.className = 'report-action-result err'; resultEl.textContent = 'Network error.' + warnNote; }
    }

    async function reportDeleteAccount() {
        const reason = document.getElementById('delete-reason').value.trim();
        const resultEl = document.getElementById('delete-result');
        if (!reason) { resultEl.className = 'report-action-result err'; resultEl.textContent = 'A reason is required.'; return; }
        if (!confirm('This will reset @' + reportTargetUsername + '\\'s avatar, name, and bio, mark the account as deleted, and delete all of its posts. The account stays in the database and the username is kept. Continue?')) return;
        resultEl.className = 'report-action-result'; resultEl.textContent = 'Working…';
        const warnNote = await issuePreActionWarning(reason, null, 'delete');
        try {
            const res = await fetch('/admin/delete-account/' + encodeURIComponent(reportTargetUsername), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason })
            });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'report-action-result err'; resultEl.textContent = 'Error: ' + (data.error || res.status) + warnNote; return; }
            resultEl.className = 'report-action-result ok';
            resultEl.textContent = '@' + reportTargetUsername + ' has been deleted.' + warnNote;
            await deleteReportedContent(resultEl);
        } catch (e) { resultEl.className = 'report-action-result err'; resultEl.textContent = 'Network error.' + warnNote; }
    }
<\/script>
</body>
</html>`);
    });
});

app.post('/admin/reports/:id/status', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).send('Report not found.');
    const status = req.body.status;
    if (status !== 'open' && status !== 'resolved') return res.redirect(`/admin/reports/${id}?error=` + encodeURIComponent("Status must be 'open' or 'resolved'."));
    db.get(`SELECT reported_username FROM Reports WHERE id = ?`, [id], (err0, report) => {
        db.run(`UPDATE Reports SET status = ? WHERE id = ?`, [status, id], function (err) {
            if (err || this.changes === 0) return res.redirect(`/admin/reports/${id}?error=` + encodeURIComponent('Failed to update report.'));
            logAudit(status === 'resolved' ? 'report_resolved' : 'report_reopened', req.session.userUsername, report && report.reported_username, `report #${id}`);
            res.redirect(`/admin/reports/${id}`);
        });
    });
});

// Deletes the original post/DM/group-chat message a report points at,
// bypassing the normal "only the sender can delete" check on those routes
// since this is an admin acting on a report - called automatically by the
// Quick Actions panel on /admin/reports/:id after a warn/ban/delete-account
// action, but is its own endpoint so it can be retried/called independently.
// Treats an already-gone message (e.g. the user deleted it themselves) as
// success rather than an error.
app.post('/admin/reports/:id/delete-content', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Report not found.' });
    const admin = req.session.userUsername;

    db.get(`SELECT reported_username, source_type, source_id FROM Reports WHERE id = ?`, [id], (err, report) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!report) return res.status(404).json({ error: 'Report not found.' });
        const { reported_username, source_type, source_id } = report;

        if (source_type === 'post') {
            db.get(`SELECT file_path, file_name, files_json FROM Posts WHERE id = ?`, [source_id], (errPre, postRow) => {
                const attachments = getAttachments(postRow);
                db.run(`DELETE FROM Posts WHERE id = ?`, [source_id], function (err2) {
                    if (err2) return res.status(500).json({ error: 'db error' });
                    const deleted = this.changes > 0;
                    if (deleted) {
                        cleanupAttachmentFiles(attachments);
                        logAudit('report_content_deleted', admin, reported_username, `post #${source_id}`);
                    }
                    res.json({ ok: true, deleted });
                });
            });
        } else if (source_type === 'dm') {
            db.get(`SELECT from_user, to_user, file_path, file_name, files_json FROM Messages WHERE id = ?`, [source_id], (err2, msg) => {
                if (err2) return res.status(500).json({ error: 'db error' });
                if (!msg) return res.json({ ok: true, deleted: false });
                const attachments = getAttachments(msg);
                db.run(`DELETE FROM Messages WHERE id = ?`, [source_id], (err3) => {
                    if (err3) return res.status(500).json({ error: 'db error' });
                    cleanupAttachmentFiles(attachments);
                    broadcastDMDelete(msg.from_user, msg.to_user, source_id);
                    logAudit('report_content_deleted', admin, reported_username, `dm #${source_id}`);
                    res.json({ ok: true, deleted: true });
                });
            });
        } else if (source_type === 'gc') {
            db.get(`SELECT group_id, file_path, file_name, files_json FROM Group_Chat_Messages WHERE id = ?`, [source_id], (err2, msg) => {
                if (err2) return res.status(500).json({ error: 'db error' });
                if (!msg) return res.json({ ok: true, deleted: false });
                const attachments = getAttachments(msg);
                db.run(`DELETE FROM Group_Chat_Messages WHERE id = ?`, [source_id], (err3) => {
                    if (err3) return res.status(500).json({ error: 'db error' });
                    cleanupAttachmentFiles(attachments);
                    db.all(`SELECT username FROM Group_Chat_Members WHERE group_id = ?`, [msg.group_id], (err4, memberRows) => {
                        broadcastGCDelete(msg.group_id, source_id, (memberRows || []).map(r => r.username));
                        logAudit('report_content_deleted', admin, reported_username, `gc #${source_id}`);
                        res.json({ ok: true, deleted: true });
                    });
                });
            });
        } else {
            res.status(400).json({ error: 'Unknown report source type.' });
        }
    });
});

function renderGCMessageBubble(m, me, replyMsg) {
    const mine = m.from_user === me;
    const fileHTML = renderAttachmentsHTML(getAttachments(m), 260, '260px');
    const { embedHTML, cleanText } = renderEmbeds(m.content || '');
    const replyBanner = replyMsg
        ? `<div class="msg-reply-banner" style="font-size:0.78em;opacity:0.6;padding-left:8px;margin-bottom:4px;">> replying to <strong>${escapeHTML(replyMsg.from_user)}</strong>: ${escapeHTML((replyMsg.content || '').substring(0,60))}${(replyMsg.content || '').length > 60 ? '...' : ''}</div>`
        : '';
    const avatarHTML = renderAvatarHTML(m.avatar_path, m.from_user, 28);
    const senderLabel = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <a href="/user/${escapeHTML(m.from_user)}" style="flex-shrink:0;">${avatarHTML}</a>
        <a href="/user/${escapeHTML(m.from_user)}" class="${mine ? 'msg-sender-mine' : 'msg-sender-other'}" style="text-decoration:none;font-weight:700;font-size:0.75em;">${renderNameWithHandle(m.from_user, m.Nickname, { isVerified: m.IsVerified })}</a>
    </div>`;
    const editLink = mine ? `<a href="#" onclick="editGCMessage(${m.id});return false;" class="msg-edit-link" style="text-decoration:none;">Edit</a>` : '';
    const deleteLink = mine ? `<a href="#" onclick="deleteGCMessage(${m.id});return false;" class="msg-delete-link" style="text-decoration:none;">Delete</a>` : '';
    const reportLink = !mine ? `<a href="#" onclick="reportContent('gc', ${m.id}, this);return false;" class="msg-delete-link report-action" data-report-type="gc" data-report-id="${m.id}" style="text-decoration:none;">Report</a>` : '';
    const editedMarker = m.edited ? `<span style="opacity:0.7;">(edited)</span>` : '';
    return `<div class="chat-msg-row" data-id="${m.id}" style="display:flex;justify-content:${mine ? 'flex-end' : 'flex-start'};margin-bottom:10px;">
        <div class="${mine ? 'msg-bubble-mine' : 'msg-bubble-other'}" style="max-width:70%;border-radius:12px;padding:8px 12px;">
            ${senderLabel}
            ${replyBanner}
            <div class="post-content" id="gc-msg-content-${m.id}" data-raw="${escapeHTML(m.content || '')}">${renderMarkdown(cleanText)}</div>
            ${embedHTML}
            ${fileHTML}
            <div style="font-size:0.7em;opacity:0.5;margin-top:4px;display:flex;justify-content:flex-end;align-items:center;gap:10px;">
                <a href="#" onclick="setGCReply(${m.id}, '${escapeHTML(m.from_user)}');return false;" class="msg-reply-link" style="text-decoration:none;">Reply</a>
                ${editLink}
                ${deleteLink}
                ${reportLink}
                ${editedMarker}
                <span data-ts="${m.created_at.replace(' ','T')+'Z'}"></span>
            </div>
        </div>
    </div>`;
}

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
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${REPORT_SCRIPT}

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
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${REPORT_SCRIPT}

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

app.get('/groups/:id', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const me = req.session.userUsername;
    const groupId = parseInt(req.params.id);

    db.get(`SELECT * FROM Group_Chats WHERE id = ?`, [groupId], (err, group) => {
        if (err || !group) return res.status(404).send('Group not found');
        db.get(`SELECT id FROM Group_Chat_Members WHERE group_id = ? AND username = ?`, [groupId, me], (err2, memberRow) => {
            if (!memberRow) return res.status(403).sendFile(path.join(__dirname, 'group_access_denied.html'));
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
            <a href="/logout">Logout</a>
            <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
            <nav id="nav-dropdown">
                <a href="/discover">Discover</a>
                <a href="/groups">Groups</a>
                <a href="/messages">DMs</a>
                <a href="/feed">Feed</a>
                <a href="/notifications" class="notif-nav-link">Notifications</a>
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
                    appendGCMessage(data.id, data.html);
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
${NOTIF_BADGE_SCRIPT}${USER_EVENTS_SCRIPT}${REPORT_SCRIPT}

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

app.post('/groups/:id/send', (req, res, next) => {
    uploadGC.array('attachments', MAX_FILES_GC)(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: `Too many files - max ${MAX_FILES_GC} per message.` });
            if (err.code === 'FILE_TYPE_BLOCKED') return res.status(400).json({ error: err.message });
            return res.status(400).json({ error: 'Upload failed.' });
        }
        next();
    });
}, (req, res) => {
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

app.post('/groups/:id/edit/:msgId', (req, res) => {
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

// =====================================================================
// /api/v1/* - structured JSON API for third-party/custom clients
// =====================================================================
// Everything above this point is Biodeck's own frontend, which mostly
// talks to itself via HTML fragments (see APIs.md). The routes below are
// additive: they don't replace or change any existing route, they just
// expose the same underlying data as real JSON so a custom client
// doesn't have to scrape HTML. They intentionally share query/serializer
// helpers with each other (not with the legacy HTML routes above) to
// keep this section self-consistent without risking changes to the
// battle-tested rendering code elsewhere in this file.

function requireApiAuth(req, res, next) {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not logged in' });
    next();
}

function clampLimit(raw, def, max) {
    const n = parseInt(raw);
    if (!n || n < 1) return def;
    return Math.min(n, max);
}

// SQLite timestamp ("YYYY-MM-DD HH:MM:SS", UTC) -> ISO 8601 for the API layer.
function toISO(sqliteTimestamp) {
    return sqliteTimestamp ? sqliteTimestamp.replace(' ', 'T') + 'Z' : null;
}

function serializeAttachmentJSON(f) {
    return {
        url: `/uploads/${path.basename(f.path)}`,
        downloadUrl: downloadUrlFor(f),
        name: f.name || null
    };
}

function serializeAuthorJSON(username, nickname, avatarPath, isVerified) {
    return {
        username,
        nickname: nickname || null,
        displayName: displayName(username, nickname),
        avatarUrl: avatarPath ? avatarPathToURL(avatarPath) : null,
        verified: !!isVerified
    };
}

function serializePostJSON(post, sessionUsername, isAdmin) {
    return {
        id: post.id,
        author: serializeAuthorJSON(post.username, post.Nickname, post.avatar_path, post.IsVerified),
        content: post.content || '',
        createdAt: toISO(post.created_at),
        edited: !!post.edited,
        pinned: !!post.pinned,
        replyTo: post.reply_to || null,
        replyCount: post.reply_count || 0,
        attachments: getAttachments(post).map(serializeAttachmentJSON),
        viewerCanEdit: !!sessionUsername && post.username === sessionUsername,
        viewerCanDelete: !!sessionUsername && (post.username === sessionUsername || !!isAdmin)
    };
}

function serializeMessageJSON(m, meUsername) {
    return {
        id: m.id,
        author: serializeAuthorJSON(m.from_user, m.Nickname, m.avatar_path, m.IsVerified),
        toUser: m.to_user,
        content: m.content || '',
        createdAt: toISO(m.created_at),
        edited: !!m.edited,
        replyTo: m.reply_to || null,
        read: !!m.read,
        mine: m.from_user === meUsername,
        attachments: getAttachments(m).map(serializeAttachmentJSON)
    };
}

function serializeGroupMessageJSON(m, meUsername) {
    return {
        id: m.id,
        groupId: m.group_id,
        author: serializeAuthorJSON(m.from_user, m.Nickname, m.avatar_path, m.IsVerified),
        content: m.content || '',
        createdAt: toISO(m.created_at),
        edited: !!m.edited,
        replyTo: m.reply_to || null,
        mine: m.from_user === meUsername,
        attachments: getAttachments(m).map(serializeAttachmentJSON)
    };
}

function serializeNotificationJSON(n) {
    return {
        id: n.id,
        type: n.type,
        actor: {
            username: n.actor_username,
            nickname: n.actor_nickname || null,
            displayName: displayName(n.actor_username, n.actor_nickname),
            verified: !!n.actor_verified
        },
        postId: n.post_id || null,
        messageId: n.message_id || null,
        preview: n.content_preview || null,
        read: !!n.read,
        createdAt: toISO(n.created_at),
        link: notifLink(n)
    };
}

// Shared post query - same shape as the LEFT JOIN used throughout the HTML
// routes above (Posts + author info + reply_count), parameterized by an
// arbitrary WHERE clause so /api/v1/feed, /api/v1/following-feed and
// /api/v1/post/:id/replies don't each hand-roll their own SQL.
function fetchPostsJSON(whereSQL, whereParams, limit, cb) {
    const sql = `SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified,
        (WITH RECURSIVE descendants(id) AS (SELECT id FROM Posts AS r WHERE r.reply_to = Posts.id UNION ALL SELECT p.id FROM Posts p JOIN descendants d ON p.reply_to = d.id) SELECT COUNT(*) FROM descendants) AS reply_count
        FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username
        ${whereSQL} ORDER BY Posts.created_at DESC LIMIT ?`;
    db.all(sql, [...whereParams, limit], cb);
}

// ----- Current user / profiles -----

app.get('/api/v1/me', requireApiAuth, (req, res) => {
    db.get(`SELECT username, Nickname, bio, email, email_verified, IsOwner, IsDeveloper, IsSupporter,
            IsAdmin, IsHeadAdmin, IsVerified, avatar_path, theme FROM User_Data WHERE id = ?`,
        [req.session.userId], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'User not found' });
        res.json({
            username: user.username,
            nickname: user.Nickname || null,
            displayName: displayName(user.username, user.Nickname),
            bio: user.bio || null,
            email: user.email || null,
            emailVerified: !!user.email_verified,
            avatarUrl: user.avatar_path ? avatarPathToURL(user.avatar_path) : null,
            verified: !!user.IsVerified,
            admin: !!(user.IsAdmin || user.IsOwner || user.IsHeadAdmin),
            owner: !!user.IsOwner,
            developer: !!user.IsDeveloper,
            supporter: !!user.IsSupporter,
            theme: user.theme || 'default'
        });
    });
});

app.get('/api/v1/users/:username', requireApiAuth, (req, res) => {
    const profileUsername = req.params.username;
    const sessionUsername = req.session.userUsername;
    db.get(`SELECT username, Nickname, bio, IsVerified, IsAdmin, IsOwner, IsHeadAdmin, IsBanned, IsDeleted, avatar_path
            FROM User_Data WHERE username = ?`, [profileUsername], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'User not found' });
        db.get(`SELECT COUNT(*) as cnt FROM Follows WHERE following_username = ?`, [profileUsername], (e1, followerCount) => {
            db.get(`SELECT id FROM Follows WHERE follower_username = ? AND following_username = ?`,
                [sessionUsername, profileUsername], (e2, followRow) => {
                const a = [sessionUsername, profileUsername].sort()[0];
                const b = [sessionUsername, profileUsername].sort()[1];
                db.get(`SELECT id FROM Friends WHERE user_a = ? AND user_b = ?`, [a, b], (e3, friendRow) => {
                    res.json({
                        username: user.username,
                        nickname: user.Nickname || null,
                        displayName: displayName(user.username, user.Nickname),
                        bio: user.bio || null,
                        avatarUrl: user.avatar_path ? avatarPathToURL(user.avatar_path) : null,
                        verified: !!user.IsVerified,
                        admin: !!(user.IsAdmin || user.IsOwner || user.IsHeadAdmin),
                        banned: !!user.IsBanned,
                        deleted: !!user.IsDeleted,
                        isSelf: profileUsername === sessionUsername,
                        followerCount: (followerCount && followerCount.cnt) || 0,
                        viewerIsFollowing: !!followRow,
                        viewerIsFriend: !!friendRow
                    });
                });
            });
        });
    });
});

// ----- Feed -----

app.get('/api/v1/feed', requireApiAuth, (req, res) => {
    const limit = clampLimit(req.query.limit, 20, 50);
    const before = parseInt(req.query.before) || 0;
    const after = parseInt(req.query.after) || 0;
    const where = before ? 'WHERE Posts.id < ?' : (after ? 'WHERE Posts.id > ?' : '');
    const params = before ? [before] : (after ? [after] : []);
    fetchPostsJSON(where, params, limit, (err, posts) => {
        if (err) return res.status(500).json({ error: 'db error' });
        const roots = posts.filter(p => !p.reply_to);
        res.json({
            posts: roots.map(p => serializePostJSON(p, req.session.userUsername, req.isAdmin)),
            hasMore: posts.length === limit
        });
    });
});

app.get('/api/v1/following-feed', requireApiAuth, (req, res) => {
    const me = req.session.userUsername;
    const limit = clampLimit(req.query.limit, 20, 50);
    const before = parseInt(req.query.before) || 0;
    getFollowingList(me, (followingList) => {
        const placeholders = followingList.map(() => '?').join(',');
        const where = `WHERE Posts.username IN (${placeholders})` + (before ? ' AND Posts.id < ?' : '');
        const params = before ? [...followingList, before] : followingList;
        fetchPostsJSON(where, params, limit, (err, posts) => {
            if (err) return res.status(500).json({ error: 'db error' });
            const roots = posts.filter(p => !p.reply_to);
            res.json({
                posts: roots.map(p => serializePostJSON(p, me, req.isAdmin)),
                hasMore: posts.length === limit
            });
        });
    });
});

// ----- Single post / thread -----

app.get('/api/v1/post/:id', requireApiAuth, (req, res) => {
    const postId = parseInt(req.params.id);
    if (!postId) return res.status(404).json({ error: 'Post not found' });
    db.get(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified,
            (WITH RECURSIVE descendants(id) AS (SELECT id FROM Posts AS r WHERE r.reply_to = Posts.id UNION ALL SELECT p.id FROM Posts p JOIN descendants d ON p.reply_to = d.id) SELECT COUNT(*) FROM descendants) AS reply_count
            FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.id = ?`,
        [postId], (err, post) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!post) return res.status(404).json({ error: 'Post not found' });
        res.json({ post: serializePostJSON(post, req.session.userUsername, req.isAdmin) });
    });
});

app.get('/api/v1/post/:id/replies', requireApiAuth, (req, res) => {
    const postId = parseInt(req.params.id);
    if (!postId) return res.status(404).json({ error: 'Post not found' });
    const limit = clampLimit(req.query.limit, 20, 50);
    const before = parseInt(req.query.before) || 0;
    const where = 'WHERE Posts.reply_to = ?' + (before ? ' AND Posts.id < ?' : '');
    const params = before ? [postId, before] : [postId];
    fetchPostsJSON(where, params, limit, (err, replies) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({
            replies: replies.map(p => serializePostJSON(p, req.session.userUsername, req.isAdmin)),
            hasMore: replies.length === limit
        });
    });
});

// ----- Direct messages -----

app.get('/api/v1/messages', requireApiAuth, (req, res) => {
    const me = req.session.userUsername;
    db.all(`SELECT DISTINCT CASE WHEN from_user = ? THEN to_user ELSE from_user END as other_user,
            MAX(created_at) as last_at
            FROM Messages WHERE from_user = ? OR to_user = ?
            GROUP BY other_user ORDER BY last_at DESC`, [me, me, me], (err, convos) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({
            conversations: (convos || []).map(c => ({
                username: c.other_user,
                lastMessageAt: toISO(c.last_at)
            }))
        });
    });
});

app.get('/api/v1/messages/:username', requireApiAuth, (req, res) => {
    const me = req.session.userUsername;
    const other = req.params.username;
    const limit = clampLimit(req.query.limit, 50, 100);
    const before = parseInt(req.query.before) || 0;
    const where = before ? 'AND Messages.id < ?' : '';
    const params = before ? [me, other, other, me, before] : [me, other, other, me];
    db.all(`SELECT Messages.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified
            FROM Messages LEFT JOIN User_Data ON Messages.from_user = User_Data.username
            WHERE ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)) ${where}
            ORDER BY Messages.id DESC LIMIT ?`, [...params, limit], (err, msgs) => {
        if (err) return res.status(500).json({ error: 'db error' });
        const ordered = (msgs || []).slice().reverse();
        res.json({
            messages: ordered.map(m => serializeMessageJSON(m, me)),
            hasMore: msgs.length === limit
        });
    });
});

app.post('/api/v1/messages/:username/mark-read', requireApiAuth, (req, res) => {
    const me = req.session.userUsername;
    const other = req.params.username;
    db.run(`UPDATE Messages SET read = 1 WHERE to_user = ? AND from_user = ?`, [me, other], (err) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({ ok: true });
    });
});

// ----- Group chats -----

app.get('/api/v1/groups', requireApiAuth, (req, res) => {
    const me = req.session.userUsername;
    db.all(`SELECT Group_Chats.* FROM Group_Chats
            WHERE Group_Chats.id IN (SELECT group_id FROM Group_Chat_Members WHERE username = ?)
            ORDER BY Group_Chats.created_at DESC`, [me], (err, groups) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!groups || !groups.length) return res.json({ groups: [] });
        // One query for every member of every one of these groups, instead of
        // a separate members query per group (was N+1 for N groups).
        const ids = groups.map(g => g.id);
        const placeholders = ids.map(() => '?').join(',');
        db.all(`SELECT group_id, username FROM Group_Chat_Members WHERE group_id IN (${placeholders}) ORDER BY joined_at ASC`,
            ids, (e2, allMembers) => {
            if (e2) return res.status(500).json({ error: 'db error' });
            const membersByGroup = new Map();
            (allMembers || []).forEach(m => {
                if (!membersByGroup.has(m.group_id)) membersByGroup.set(m.group_id, []);
                membersByGroup.get(m.group_id).push(m.username);
            });
            res.json({
                groups: groups.map(g => ({
                    id: g.id,
                    name: g.name,
                    createdBy: g.created_by,
                    createdAt: toISO(g.created_at),
                    isPublic: !!g.is_public,
                    members: membersByGroup.get(g.id) || []
                }))
            });
        });
    });
});

app.get('/api/v1/groups/public', requireApiAuth, (req, res) => {
    const me = req.session.userUsername;
    db.all(`SELECT Group_Chats.*, COUNT(Group_Chat_Members.id) AS member_count,
                   SUM(CASE WHEN Group_Chat_Members.username = ? THEN 1 ELSE 0 END) AS is_member
            FROM Group_Chats
            LEFT JOIN Group_Chat_Members ON Group_Chats.id = Group_Chat_Members.group_id
            WHERE Group_Chats.is_public = 1
            GROUP BY Group_Chats.id
            ORDER BY Group_Chats.created_at DESC`, [me], (err, groups) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({
            groups: (groups || []).map(g => ({
                id: g.id,
                name: g.name,
                createdBy: g.created_by,
                createdAt: toISO(g.created_at),
                memberCount: g.member_count,
                viewerIsMember: !!g.is_member
            }))
        });
    });
});

app.get('/api/v1/groups/:id/messages', requireApiAuth, (req, res) => {
    const me = req.session.userUsername;
    const groupId = parseInt(req.params.id);
    if (!groupId) return res.status(404).json({ error: 'Group not found' });
    db.get(`SELECT id FROM Group_Chat_Members WHERE group_id = ? AND username = ?`, [groupId, me], (mErr, memberRow) => {
        if (!memberRow) return res.status(403).json({ error: 'Not a member of this group' });
        const limit = clampLimit(req.query.limit, 50, 100);
        const before = parseInt(req.query.before) || 0;
        const where = before ? 'AND Group_Chat_Messages.id < ?' : '';
        const params = before ? [groupId, before] : [groupId];
        db.all(`SELECT Group_Chat_Messages.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified
                FROM Group_Chat_Messages LEFT JOIN User_Data ON Group_Chat_Messages.from_user = User_Data.username
                WHERE Group_Chat_Messages.group_id = ? ${where}
                ORDER BY Group_Chat_Messages.id DESC LIMIT ?`, [...params, limit], (err, msgs) => {
            if (err) return res.status(500).json({ error: 'db error' });
            const ordered = (msgs || []).slice().reverse();
            res.json({
                messages: ordered.map(m => serializeGroupMessageJSON(m, me)),
                hasMore: msgs.length === limit
            });
        });
    });
});

// ----- Notifications -----

app.get('/api/v1/notifications', requireApiAuth, (req, res) => {
    const me = req.session.userUsername;
    const limit = clampLimit(req.query.limit, 50, 100);
    const before = parseInt(req.query.before) || 0;
    const where = before ? 'AND Notifications.id < ?' : '';
    const params = before ? [me, before] : [me];
    db.all(`SELECT Notifications.*, User_Data.Nickname AS actor_nickname, User_Data.IsVerified AS actor_verified
            FROM Notifications LEFT JOIN User_Data ON Notifications.actor_username = User_Data.username
            WHERE Notifications.username = ? ${where}
            ORDER BY Notifications.id DESC LIMIT ?`, [...params, limit], (err, notifs) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({
            notifications: (notifs || []).map(serializeNotificationJSON),
            hasMore: (notifs || []).length === limit
        });
        // Note: unlike GET /notifications (the HTML page), this does NOT
        // mark notifications as read as a side effect - a client polling
        // this endpoint in the background shouldn't silently clear
        // someone's unread badge. Call POST /notifications/mark-read
        // explicitly when the client actually wants that.
    });
});

app.listen(PORT, () => {
    console.log(`Biodeck running on port ${PORT}`);
});

app.get('/editor', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'editor.html'));
});

app.get('/v86', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Catch-all: must stay last so every route/middleware above gets a chance to
// match first. API callers still get a JSON error; everything else gets the
// site's themed "not found" page instead of Express's default plaintext
// "Cannot GET /whatever".
app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.status(404).sendFile(path.join(__dirname, '404.html'));
});
