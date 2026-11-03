// File type helpers and attachment cleanup.
const path = require('path');
const fs = require('fs');
const { uploadsDir } = require('../config');
const { db } = require('../db/connection');

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

function downloadUrlFor(f) {
    return `/uploads/download/${path.basename(f.path)}?name=${encodeURIComponent(f.name || path.basename(f.path))}`;
}

// Icon + human-readable size for the generic "other file" attachment card.
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

// Pulls a normalized [{path,name}, ...] attachment list off a Post/Message/GC-Message row.
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

// Actually removes attachment files from disk once nothing references them anymore.
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

module.exports = {
    MSG_AUDIO_MIME_TYPES,
    MSG_VIDEO_MIME_TYPES,
    cleanupAttachmentFiles,
    downloadUrlFor,
    fileIconFor,
    formatFileSize,
    getAttachments,
};
