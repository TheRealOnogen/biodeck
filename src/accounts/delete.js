// Soft and hard account deletion.
const { CASCADE_DELETE_REPLIES_ON_ACCOUNT_DELETE, deletePostDescendants } = require('../cascade');
const { dxArchiveAccount } = require('../data-export/collect');
const { db } = require('../db/connection');
const { userBus } = require('../live/events');
const { sendAccountPermanentlyDeletedEmail } = require('../mail');
const { logAudit } = require('../moderation');
const { cleanupAttachmentFiles, getAttachments } = require('../uploads/files');

// Permanently removes a user and every row tied to their username/id across the schema.
function hardDeleteAccount(username, reason, callback) {
    hardDeleteAccountEx(username, reason, {}, callback);
}

// "Delete without an archive" is only for when the archive CAN'T be written (full disk, ...).
function hardDeleteAccountEx(username, reason, opts, callback) {
    const allowWithoutArchive = !!(opts && opts.allowWithoutArchive);
    db.get(`SELECT id FROM User_Data WHERE username = ?`, [username], (err, row) => {
        if (err) return callback(err);
        if (!row) return callback(new Error('user not found'));
        let archived = false;
        dxArchiveAccount(row.id, reason, 'permanent_delete').then((archive) => {
            archived = true;
            hardDeleteAccountRows(username, reason, (err2) => callback(err2, archive));
        }).catch((archiveErr) => {
            if (archived) { console.error('Hard delete error after archiving:', archiveErr && archiveErr.stack || archiveErr); return; }
            console.error('Could not archive account data:', archiveErr && archiveErr.stack || archiveErr);
            if (!allowWithoutArchive) return callback(new Error('archive failed'));
            logAudit('account_delete_archive_skipped', 'System', username, 'archive could not be written; deleted without a copy after two confirmations');
            hardDeleteAccountRows(username, reason, (err2) => callback(err2, null));
        });
    });
}

// True when the request explicitly asks to delete even if no archive can be saved.
function allowNoArchive(req) {
    return !!(req.body && req.body.skipArchive === true && Number(req.body.confirmations) >= 2);
}

// Soft-delete version: resolves to the archive row, or null when it could not be written and
// skipping was explicitly allowed.
async function dxArchiveAccountOrSkip(userId, username, reason, trigger, allowSkip, actor) {
    try {
        return await dxArchiveAccount(userId, reason, trigger);
    } catch (e) {
        if (!allowSkip) throw e;
        console.error('Could not archive account data, continuing WITHOUT an archive (confirmed twice):', e && e.stack || e);
        logAudit('account_delete_archive_skipped', actor || 'System', username, 'archive could not be written; deleted without a copy after two confirmations');
        return null;
    }
}

function hardDeleteAccountRows(username, reason, callback) {
    db.get(`SELECT id, email FROM User_Data WHERE username = ?`, [username], (err, row) => {
        if (err) return callback(err);
        if (!row) return callback(new Error('user not found'));
        const userId = row.id;
        const email = row.email;
        // Gather every attachment this user owns (DMs, posts, group chat messages) BEFORE any row
        // is deleted.
        db.all(`SELECT file_path, file_name, files_json FROM Messages WHERE from_user = ? OR to_user = ?`, [username, username], (errM, msgRows) => {
        db.all(`SELECT id, file_path, file_name, files_json FROM Posts WHERE username = ?`, [username], (errP, postRows) => {
        db.all(`SELECT file_path, file_name, files_json FROM Group_Chat_Messages WHERE from_user = ?`, [username], (errG, gcRows) => {
            const attachments = []
                .concat((msgRows || []).reduce((acc, r) => acc.concat(getAttachments(r)), []))
                .concat((postRows || []).reduce((acc, r) => acc.concat(getAttachments(r)), []))
                .concat((gcRows || []).reduce((acc, r) => acc.concat(getAttachments(r)), []));
        db.serialize(() => {
            // Same ordering concern as the Reactions/Posts pair below.
            db.run(`DELETE FROM Message_Reactions WHERE message_id IN (SELECT id FROM Messages WHERE from_user = ? OR to_user = ?)`, [username, username]);
            db.run(`DELETE FROM Message_Reactions WHERE username = ?`, [username]);
            db.run(`DELETE FROM Messages WHERE from_user = ? OR to_user = ?`, [username, username]);
            db.run(`DELETE FROM Password_Resets WHERE user_id = ?`, [userId]);
            db.run(`DELETE FROM Email_Changes WHERE user_id = ?`, [userId]);
            db.run(`DELETE FROM Email_Verifications WHERE user_id = ?`, [userId]);
            // Reactions on this user's own posts must be cleared before Posts itself.
            db.run(`DELETE FROM Reactions WHERE post_id IN (SELECT id FROM Posts WHERE username = ?)`, [username]);
            db.run(`DELETE FROM Posts WHERE username = ?`, [username]);
            if (CASCADE_DELETE_REPLIES_ON_ACCOUNT_DELETE) deletePostDescendants((postRows || []).map(r => r.id));
            db.run(`DELETE FROM Follows WHERE follower_username = ? OR following_username = ?`, [username, username]);
            db.run(`DELETE FROM Friend_Requests WHERE from_user = ? OR to_user = ?`, [username, username]);
            db.run(`DELETE FROM Friends WHERE user_a = ? OR user_b = ?`, [username, username]);
            db.run(`DELETE FROM Notifications WHERE username = ? OR actor_username = ?`, [username, username]);
            db.run(`DELETE FROM Group_Chat_Members WHERE username = ?`, [username]);
            // Same ordering note as Message_Reactions above - clear this user's GC messages'
            // reactions.
            db.run(`DELETE FROM Group_Chat_Message_Reactions WHERE message_id IN (SELECT id FROM Group_Chat_Messages WHERE from_user = ?)`, [username]);
            db.run(`DELETE FROM Group_Chat_Message_Reactions WHERE username = ?`, [username]);
            db.run(`DELETE FROM Group_Chat_Messages WHERE from_user = ?`, [username]);
            // Reactions the deleted user made on other people's posts (order doesn't matter for
            // this one - it's keyed by username, not post_id).
            db.run(`DELETE FROM Reactions WHERE username = ?`, [username]);
            // Warnings are keyed by username (not user_id), and hard-delete frees the username for
            // reuse - without this.
            db.run(`DELETE FROM Warnings WHERE username = ?`, [username]);
            db.run(`DELETE FROM User_Data WHERE username = ?`, [username], function (err2) {
                if (err2) return callback(err2);
                if (this.changes === 0) return callback(new Error('user not found'));
                cleanupAttachmentFiles(attachments);
                // Push a 'deleted' event to any open tabs for this user, same as the soft delete
                // above.
                const cleanReason = reason || 'Account deleted';
                userBus.emit(`user:${userId}`, { event: 'deleted', type: 'deleted', reason: cleanReason });
                // Email captured before the row was deleted, since the address is gone from the DB
                // by the time we get here.
                if (email) sendAccountPermanentlyDeletedEmail(email, username, cleanReason);
                callback(null);
            });
        });
        });
        });
        });
    });
}

module.exports = { allowNoArchive, dxArchiveAccountOrSkip, hardDeleteAccountEx };
