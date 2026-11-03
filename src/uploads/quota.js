// Upload limits, per-user quota and disk checks.
const fs = require('fs');
const {
    MAX_ATTACHMENT_MB,
    MAX_MESSAGE_ATTACHMENTS_BYTES,
    MB,
    UPLOAD_MIN_FREE_BYTES,
    UPLOAD_QUOTA_BYTES,
    uploadsDir,
} = require('../config');
const { getStmt } = require('../db/connection');
const { sendPostRejection } = require('../security/post-spam');

// Attachment spam protection + compression
// Every route that takes attachments (/feed/post, DM send, group send) runs: attachmentGate(kind)
// BEFORE multer.
const fmtMB = (bytes) => (bytes / MB >= 10 ? Math.round(bytes / MB) : Math.round(bytes / MB * 10) / 10) + ' MB';

// Feed posts are sent with fetch() and the page only shows an error for 422/429 (anything else
// counts as "posted").
function rejectUpload(kind, req, res, status, message) {
    if (kind === 'feed') return sendPostRejection(req, res, status === 429 ? 429 : 422, message);
    return res.status(status).json({ error: message, code: 'upload_limit' });
}
function removeUploadedFiles(files) {
    (files || []).forEach(f => { if (f && f.path) fs.unlink(f.path, () => {}); });
}

// Attachment bytes this user currently has stored (posts + DMs + group chats).
function getUserAttachmentBytes(username) {
    try {
        let total = 0;
        for (const sql of [
            `SELECT COALESCE(SUM(CAST(json_extract(j.value, '$.size') AS INTEGER)), 0) AS b FROM Posts t, json_each(t.files_json) j WHERE t.username = ? AND t.files_json IS NOT NULL`,
            `SELECT COALESCE(SUM(CAST(json_extract(j.value, '$.size') AS INTEGER)), 0) AS b FROM Messages t, json_each(t.files_json) j WHERE t.from_user = ? AND t.files_json IS NOT NULL`,
            `SELECT COALESCE(SUM(CAST(json_extract(j.value, '$.size') AS INTEGER)), 0) AS b FROM Group_Chat_Messages t, json_each(t.files_json) j WHERE t.from_user = ? AND t.files_json IS NOT NULL`
        ]) {
            const row = getStmt(sql).get(username);
            total += (row && row.b) || 0;
        }
        return total;
    } catch (e) {
        console.error('Attachment quota lookup failed (allowing the upload):', e.message);
        return 0;
    }
}

// Rolling 24h upload volume per user (in memory).
const recentUploads = new Map(); // userId -> [{ t, bytes }]
function recentUploadBytes(userId) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const list = (recentUploads.get(userId) || []).filter(e => e.t > cutoff);
    if (list.length) recentUploads.set(userId, list); else recentUploads.delete(userId);
    return list.reduce((a, e) => a + e.bytes, 0);
}
function noteUploadBytes(userId, bytes) {
    const list = recentUploads.get(userId) || [];
    list.push({ t: Date.now(), bytes });
    recentUploads.set(userId, list);
}
setInterval(() => { for (const id of [...recentUploads.keys()]) recentUploadBytes(id); }, 60 * 60 * 1000).unref();

async function freeDiskBytes() {
    try {
        const st = await fs.promises.statfs(uploadsDir);
        return Number(st.bavail) * Number(st.bsize);
    } catch (e) { return null; } // statfs unavailable (old Node) - skip the check
}

function attachmentGate(kind) {
    return async (req, res, next) => {
        try {
            const len = parseInt(req.headers['content-length'] || '0', 10) || 0;
            // Text-only messages are tiny; only check bigger requests, so a full
            // disk never blocks plain chatting.
            if (len > 64 * 1024 || !len) {
                if (UPLOAD_MIN_FREE_BYTES > 0) {
                    const free = await freeDiskBytes();
                    if (free !== null && free < UPLOAD_MIN_FREE_BYTES) {
                        console.warn(`Attachment refused: only ${fmtMB(free)} free disk (UPLOAD_MIN_FREE_DISK_MB).`);
                        return rejectUpload(kind, req, res, 503, 'Uploads are temporarily unavailable. Please try again later.');
                    }
                }
            }
            if (len > MAX_MESSAGE_ATTACHMENTS_BYTES + 256 * 1024) {
                return rejectUpload(kind, req, res, 413, `That is too much to upload at once - the limit is ${fmtMB(MAX_MESSAGE_ATTACHMENTS_BYTES)} per ${kind === 'feed' ? 'post' : 'message'} (${MAX_ATTACHMENT_MB} MB per file).`);
            }
            if (len > 64 * 1024 && UPLOAD_QUOTA_BYTES > 0 && req.session && req.session.userUsername) {
                if (getUserAttachmentBytes(req.session.userUsername) + len > UPLOAD_QUOTA_BYTES) {
                    return rejectUpload(kind, req, res, 413, `You've reached your attachment storage limit (${fmtMB(UPLOAD_QUOTA_BYTES)}). Delete some old posts or messages with attachments to free up space.`);
                }
            }
        } catch (e) {
            console.error('attachmentGate error:', e.message);
        }
        next();
    };
}

module.exports = {
    attachmentGate,
    fmtMB,
    getUserAttachmentBytes,
    noteUploadBytes,
    recentUploadBytes,
    rejectUpload,
    removeUploadedFiles,
};
