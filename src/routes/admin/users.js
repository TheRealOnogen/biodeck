// Admin user tools: profiles, deletion, IP bans, badges, pins.
const fs = require('fs');
const { allowNoArchive, dxArchiveAccountOrSkip, hardDeleteAccountEx } = require('../../accounts/delete');
const { requireAdmin, requireHeadAdmin } = require('../../admin/helpers');
const { app } = require('../../app');
const { CASCADE_DELETE_REPLIES_ON_ACCOUNT_DELETE, deletePostDescendants } = require('../../cascade');
const { MAX_BIO_LENGTH } = require('../../config');
const { db } = require('../../db/connection');
const { sseSend, userBus, userEventConnections } = require('../../live/events');
const { EMAIL_REGEX, sendAccountDeletedEmail } = require('../../mail');
const { logAudit } = require('../../moderation');
const { MAX_NICKNAME_LENGTH, avatarPathToURL } = require('../../render/html');
const { adminAvatarUpload, compressAvatar, deleteOldAvatarFile } = require('../../uploads/avatars');
const { cleanupAttachmentFiles, getAttachments } = require('../../uploads/files');

// Lets an admin/owner inspect and fix up anyone's public profile (avatar, nickname, bio).
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
        adminAvatarUpload.single('avatar')(req, res, async (uploadErr) => {
            if (uploadErr || !req.file) {
                if (req.file) fs.unlink(req.file.path, () => {});
                return res.status(400).json({ error: uploadErr ? uploadErr.message : 'No file uploaded.' });
            }
            let newPath;
            try {
                newPath = await compressAvatar(req.file.path, target);
            } catch (e) {
                return res.status(400).json({ error: e.message === 'busy' ? 'Server is busy, try again in a moment.' : 'That file is not a valid JPG, PNG, GIF or WebP image.' });
            }
            db.get(`SELECT avatar_path FROM User_Data WHERE username = ?`, [target], (e1, row) => {
                const oldPath = row ? row.avatar_path : null;
                db.run(`UPDATE User_Data SET avatar_path = ? WHERE username = ?`, [newPath, target], (err2) => {
                    if (err2) { fs.unlink(newPath, () => {}); return res.status(500).json({ error: 'db error' }); }
                    deleteOldAvatarFile(oldPath);
                    res.json({ ok: true, username: target, avatar_url: avatarPathToURL(newPath) });
                });
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

// Soft-deletes an account: keeps the row (and username) in the DB, but wipes the public-facing
// identity.
app.post('/admin/delete-account/:username', requireAdmin, (req, res) => {
    const target = req.params.username;
    if (target === req.session.userUsername) return res.status(400).json({ error: 'cannot delete your own account' });
    const reason = ((req.body && req.body.reason) || '').trim().substring(0, 500);
    if (!reason) return res.status(400).json({ error: 'a reason is required to delete an account' });
    // Archive first: the posts (and the profile text) are wiped below.
    db.get(`SELECT id FROM User_Data WHERE username = ?`, [target], (errU, targetRow) => {
    if (errU) return res.status(500).json({ error: 'db error' });
    if (!targetRow) return res.status(404).json({ error: 'user not found' });
    dxArchiveAccountOrSkip(targetRow.id, target, reason, 'admin_delete', allowNoArchive(req), req.session.userUsername).then(() => {
    db.run(
        `UPDATE User_Data SET avatar_path = ?, Nickname = ?, bio = ?, IsDeleted = 1, DeleteReason = ? WHERE username = ?`,
        ['public/Default.png', 'Account Deleted', '', reason, target],
        function(err) {
            if (err) return res.status(500).json({ error: 'db error' });
            if (this.changes === 0) return res.status(404).json({ error: 'user not found' });
            db.all(`SELECT id, file_path, file_name, files_json FROM Posts WHERE username = ?`, [target], (errPre, postRows) => {
            const attachments = (postRows || []).reduce((acc, r) => acc.concat(getAttachments(r)), []);
            db.run(`DELETE FROM Reactions WHERE post_id IN (SELECT id FROM Posts WHERE username = ?)`, [target]);
            db.run(`DELETE FROM Posts WHERE username = ?`, [target], (err2) => {
                if (err2) return res.status(500).json({ error: 'db error deleting posts' });
                cleanupAttachmentFiles(attachments);
                if (CASCADE_DELETE_REPLIES_ON_ACCOUNT_DELETE) deletePostDescendants((postRows || []).map(r => r.id));
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
    }).catch((archiveErr) => {
        console.error('Could not archive account data, account was NOT deleted:', archiveErr && archiveErr.stack || archiveErr);
        res.status(500).json({ code: 'archive_failed', error: 'could not archive the account data first, so the account was NOT deleted (check the server log and free disk space in data/)' });
    });
    });
});

// Permanently deletes an account and all associated data from the database.
app.post('/admin/delete-account-permanent/:username', requireAdmin, requireHeadAdmin, (req, res) => {
    const target = req.params.username;
    if (target === req.session.userUsername) return res.status(400).json({ error: 'cannot delete your own account here - use the dashboard' });
    const reason = ((req.body && req.body.reason) || '').trim().substring(0, 500);
    if (!reason) return res.status(400).json({ error: 'a reason is required to delete an account' });
    hardDeleteAccountEx(target, reason, { allowWithoutArchive: allowNoArchive(req) }, (err) => {
        if (err) {
            if (err.message === 'user not found') return res.status(404).json({ error: 'user not found' });
            if (err.message === 'archive failed') return res.status(500).json({ code: 'archive_failed', error: 'could not archive the account data first, so the account was NOT deleted (check the server log and free disk space in data/)' });
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

    // Only an existing Owner can grant or revoke the Admin and Owner badges - otherwise any admin
    // could hand out admin.
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
