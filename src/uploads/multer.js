// Multer storage and upload middleware.
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const { MAX_FILE_SIZE, uploadsDir } = require('../config');

// file.originalname is fully attacker-controlled (it's just whatever the client's multipart request
// claims).
function safeUploadFilename(originalname) {
    const base = path.basename(String(originalname || 'file'));
    let ext = path.extname(base).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12);
    const stem = base.slice(0, base.length - path.extname(base).length)
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 60) || 'file';
    return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${stem}${ext}`;
}

// No extension filter on attachments by design - any file type is allowed, same as Discord etc.

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!req.session || !req.session.userId) return cb(new Error('Unauthorized'));
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => cb(null, safeUploadFilename(file.originalname))
});

const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

// Multi-file upload limits: 5 attachments per post (feed/replies/following-feed), 10 per DM.
const MAX_FILES_FEED = 5;
const MAX_FILES_DM = 10;
const MAX_FILES_GC = 10;
const makeMultiUpload = maxFiles => multer({ storage, limits: { fileSize: MAX_FILE_SIZE, files: maxFiles } });
const uploadFeed = makeMultiUpload(MAX_FILES_FEED);
const uploadDM = makeMultiUpload(MAX_FILES_DM);
const uploadGC = makeMultiUpload(MAX_FILES_GC);

const MSG_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];

module.exports = {
    MAX_FILES_DM,
    MAX_FILES_FEED,
    MAX_FILES_GC,
    MSG_IMAGE_EXTS,
    uploadDM,
    uploadFeed,
    uploadGC,
};
