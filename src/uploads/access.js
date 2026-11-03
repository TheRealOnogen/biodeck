// Access control for private (DM / group chat) uploads.
const path = require('path');
const { uploadsDir } = require('../config');
const { db } = require('../db/connection');
const { sessionMiddleware } = require('../session');
const { getAttachments } = require('./files');

// Private attachment access control (DMs + group chats)
// Every file lives in one flat folder, so by default anyone who has (or guesses) a /uploads/<file>
// URL could fetch it.

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

// Serves /uploads/:filename (inline-capable embed) and /uploads/download/:filename (forced download
// with the original name).
function serveUpload(req, res, asDownload) {
    const filename = req.params.filename;
    // Only plain files directly inside uploadsDir, never anything path-like.
    if (!filename || filename !== path.basename(filename) || filename.startsWith('.')) return res.status(404).end();

    const send = (restricted) => {
        // Private files must not be stored by a shared cache.
        const opts = { dotfiles: 'deny', cacheControl: !restricted };
        if (restricted) res.setHeader('Cache-Control', 'private, no-cache');
        const done = (err) => { if (err && !res.headersSent) res.status(err.status === 400 ? 400 : 404).end(); };
        if (asDownload) {
            const rawName = req.query.name ? String(req.query.name) : filename;
            const displayName = path.basename(rawName).slice(0, 255) || filename;
            return res.download(path.join(uploadsDir, filename), displayName, opts, done);
        }
        // Direct navigation to a raw /uploads/<file> URL always downloads instead of rendering
        // inline.
        res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
        res.sendFile(filename, Object.assign({ root: uploadsDir }, opts), done);
    };

    db.get(`SELECT scope, user_a, user_b, group_id FROM Private_Uploads WHERE filename = ?`, [filename], (err, row) => {
        if (err) { console.error('Private upload lookup error:', err.message); return res.status(500).end(); }
        if (!row) return send(false);
        // Only now do we need to know who's asking.
        sessionMiddleware(req, res, (sessErr) => {
            if (sessErr) return res.status(500).end();
            userMayViewPrivateUpload(req, row, filename, (ok) => ok ? send(true) : res.status(404).end());
        });
    });
}

module.exports = { backfillPrivateUploads, recordPrivateUploads, serveUpload };
