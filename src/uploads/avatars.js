// Avatar upload and compression.
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const { uploadsDir } = require('../config');
const { getStmt } = require('../db/connection');
const { ROOT_DIR } = require('../paths');

const MAX_AVATAR_SIZE = 8 * 1024 * 1024;           // raw upload ceiling
const AVATAR_OUTPUT_SIZE = 512;                    // px, square
const AVATAR_WEBP_QUALITY = 80;
const AVATAR_MAX_INPUT_PIXELS = 40 * 1000 * 1000;  // refuses "decompression bombs": tiny file
const AVATAR_MAX_CONCURRENT_JOBS = 3;              // caps CPU/RAM spent resizing at any moment
const AVATAR_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const AVATAR_FORMATS = ['jpeg', 'png', 'gif', 'webp'];
const avatarTmpDir = path.join(ROOT_DIR, 'tmp-uploads');
if (!fs.existsSync(avatarTmpDir)) fs.mkdirSync(avatarTmpDir, { recursive: true });

// Raw files left behind by a crash mid-request are swept on boot.
fs.readdir(avatarTmpDir, (err, names) => { (names || []).forEach(n => fs.unlink(path.join(avatarTmpDir, n), () => {})); });

let avatarJobsRunning = 0;

// keyFn: own session id for a normal avatar change, target username for an admin one.
function makeAvatarUpload() {
    const storage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, avatarTmpDir),
        filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase())
    });
    return multer({
        storage,
        limits: { fileSize: MAX_AVATAR_SIZE, files: 1 },
        fileFilter: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            if (AVATAR_EXTS.includes(ext)) cb(null, true);
            else cb(new Error('Profile pictures must be a JPG, PNG, GIF or WebP image'));
        }
    });
}
const avatarUpload = makeAvatarUpload();
const adminAvatarUpload = makeAvatarUpload();

// Validates + re-encodes the raw upload at `srcPath` into public/uploads and resolves to the new
// full path.
async function compressAvatar(srcPath, key) {
    if (avatarJobsRunning >= AVATAR_MAX_CONCURRENT_JOBS) {
        fs.unlink(srcPath, () => {});
        throw new Error('busy');
    }
    avatarJobsRunning++;
    const safeKey = String(key).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40);
    const outPath = path.join(uploadsDir, `avatar-${safeKey}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.webp`);
    try {
        const opts = { limitInputPixels: AVATAR_MAX_INPUT_PIXELS, failOn: 'error' };
        const meta = await sharp(srcPath, opts).metadata();
        if (!AVATAR_FORMATS.includes(meta.format)) throw new Error('not a supported image');
        await sharp(srcPath, opts)
            .rotate() // apply EXIF orientation before metadata is dropped
            .resize(AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE, { fit: 'cover' })
            .webp({ quality: AVATAR_WEBP_QUALITY })
            .toFile(outPath);
        return outPath;
    } catch (e) {
        fs.unlink(outPath, () => {});
        throw e;
    } finally {
        avatarJobsRunning--;
        fs.unlink(srcPath, () => {});
    }
}

// Deletes a replaced avatar file.
function deleteOldAvatarFile(oldPath) {
    if (!oldPath) return;
    const name = path.basename(String(oldPath).replace(/\\/g, '/'));
    if (!/^avatar-/.test(name)) return;
    try {
        const stillUsed = getStmt(`SELECT 1 FROM User_Data WHERE avatar_path LIKE ? LIMIT 1`).get('%' + name);
        if (stillUsed) return;
    } catch (e) { return; }
    fs.unlink(path.join(uploadsDir, name), () => {});
}

module.exports = { adminAvatarUpload, avatarUpload, compressAvatar, deleteOldAvatarFile };
