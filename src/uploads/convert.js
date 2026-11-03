// Attachment image conversion to WebP.
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const {
    ATTACHMENT_CONVERT_IMAGES,
    ATTACHMENT_IMAGE_MAX_DIM,
    ATTACHMENT_WEBP_QUALITY,
    MAX_ATTACHMENT_MB,
    MAX_MESSAGE_ATTACHMENTS_BYTES,
    UPLOAD_DAILY_BYTES,
    UPLOAD_QUOTA_BYTES,
} = require('../config');
const {
    fmtMB,
    getUserAttachmentBytes,
    noteUploadBytes,
    recentUploadBytes,
    rejectUpload,
    removeUploadedFiles,
} = require('./quota');

// Re-encodes a JPG/PNG/GIF/TIFF as WebP.
const CONVERTIBLE_ATTACHMENT_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.tif', '.tiff'];
const CONVERTIBLE_ATTACHMENT_FORMATS = ['jpeg', 'png', 'gif', 'tiff'];
const ATTACHMENT_MAX_INPUT_PIXELS = 100 * 1000 * 1000; // decompression-bomb guard
const ATTACHMENT_MAX_CONCURRENT_JOBS = 3;
let attachmentConvertJobs = 0;
async function convertAttachmentToWebp(f) {
    if (!ATTACHMENT_CONVERT_IMAGES) return;
    const origName = f.originalname || '';
    const ext = path.extname(origName).toLowerCase();
    if (!CONVERTIBLE_ATTACHMENT_EXTS.includes(ext)) return;
    if (attachmentConvertJobs >= ATTACHMENT_MAX_CONCURRENT_JOBS) return; // busy: keep the original
    attachmentConvertJobs++;
    const outPath = f.path.replace(/\.[^.\\/]+$/, '') + '.webp';
    try {
        const meta = await sharp(f.path, { limitInputPixels: ATTACHMENT_MAX_INPUT_PIXELS, animated: true }).metadata();
        if (!CONVERTIBLE_ATTACHMENT_FORMATS.includes(meta.format)) return; // judged by contents, not the filename
        const animated = (meta.pages || 1) > 1;
        let img = sharp(f.path, { limitInputPixels: ATTACHMENT_MAX_INPUT_PIXELS, animated });
        if (!animated) {
            img = img.rotate().resize({ width: ATTACHMENT_IMAGE_MAX_DIM, height: ATTACHMENT_IMAGE_MAX_DIM, fit: 'inside', withoutEnlargement: true });
        }
        await img.webp({ quality: ATTACHMENT_WEBP_QUALITY, effort: 3 }).toFile(outPath);
        const outSize = (await fs.promises.stat(outPath)).size;
        if (outSize >= f.size) { // not worth it (e.g. a tiny palette PNG) - keep the original
            await fs.promises.unlink(outPath).catch(() => {});
            return;
        }
        await fs.promises.unlink(f.path).catch(() => {});
        f.path = outPath;
        f.filename = path.basename(outPath);
        f.size = outSize;
        f.mimetype = 'image/webp';
        f.originalname = path.basename(origName, path.extname(origName)) + '.webp';
    } catch (e) {
        await fs.promises.unlink(outPath).catch(() => {}); // half-written output, if any
    } finally {
        attachmentConvertJobs--;
    }
}

function processAttachments(kind) {
    return async (req, res, next) => {
        const files = req.files || [];
        if (!files.length) return next();
        const userId = req.session && req.session.userId;
        const username = req.session && req.session.userUsername;
        const refuse = (status, message) => { removeUploadedFiles(files); req.files = []; return rejectUpload(kind, req, res, status, message); };
        try {
            const total = files.reduce((a, f) => a + (f.size || 0), 0);
            if (total > MAX_MESSAGE_ATTACHMENTS_BYTES) {
                return refuse(413, `Too much in one ${kind === 'feed' ? 'post' : 'message'} - ${fmtMB(MAX_MESSAGE_ATTACHMENTS_BYTES)} total (${MAX_ATTACHMENT_MB} MB per file).`);
            }
            if (UPLOAD_QUOTA_BYTES > 0 && username && getUserAttachmentBytes(username) + total > UPLOAD_QUOTA_BYTES) {
                return refuse(413, `You've reached your attachment storage limit (${fmtMB(UPLOAD_QUOTA_BYTES)}). Delete some old posts or messages with attachments to free up space.`);
            }
            if (UPLOAD_DAILY_BYTES > 0 && userId && recentUploadBytes(userId) + total > UPLOAD_DAILY_BYTES) {
                return refuse(429, `You've uploaded a lot in the last 24 hours (limit ${fmtMB(UPLOAD_DAILY_BYTES)}). Please try again later.`);
            }
            if (userId) noteUploadBytes(userId, total);
            await Promise.all(files.map(f => convertAttachmentToWebp(f)));
        } catch (e) {
            console.error('processAttachments error:', e.message);
        }
        next();
    };
}

module.exports = { processAttachments };
