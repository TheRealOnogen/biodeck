// Constants and limits (most overridable in vars.env).
const path = require('path');
const fs = require('fs');
const { ROOT_DIR } = require('./paths');

const PORT = 3000;

const uploadsDir = path.join(ROOT_DIR, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Attachment limits (all overridable in vars.env)
// MAX_ATTACHMENT_MB largest single attachment.
const envNum = (name, def) => { const v = parseFloat(process.env[name]); return Number.isFinite(v) && v >= 0 ? v : def; };
const MB = 1024 * 1024;
const MAX_ATTACHMENT_MB = Math.max(1, envNum('MAX_ATTACHMENT_MB', 25));
const MAX_FILE_SIZE = MAX_ATTACHMENT_MB * MB;
const MAX_MESSAGE_ATTACHMENTS_BYTES = Math.max(MAX_FILE_SIZE, envNum('MAX_MESSAGE_ATTACHMENTS_MB', 50) * MB);
const UPLOAD_QUOTA_BYTES = envNum('UPLOAD_QUOTA_MB_PER_USER', 512) * MB;
const UPLOAD_DAILY_BYTES = envNum('UPLOAD_MB_PER_DAY', 200) * MB;
const UPLOAD_MIN_FREE_BYTES = envNum('UPLOAD_MIN_FREE_DISK_MB', 1024) * MB;
const ATTACHMENT_CONVERT_IMAGES = !['0', 'false', 'no', 'off'].includes(String(process.env.ATTACHMENT_CONVERT_IMAGES || '1').toLowerCase());
const ATTACHMENT_IMAGE_MAX_DIM = Math.max(256, Math.round(envNum('ATTACHMENT_IMAGE_MAX_DIM', 4096)));
const ATTACHMENT_WEBP_QUALITY = Math.min(100, Math.max(1, Math.round(envNum('ATTACHMENT_WEBP_QUALITY', 82))));
const MAX_MSG_LENGTH = 4000;
const MAX_POST_LENGTH = 1000;
const MAX_BIO_LENGTH = 1000;

// A reaction is meant to be a single emoji, but some emoji.
const MAX_REACTION_EMOJI_LENGTH = 100;

// Caps distinct emoji per post (not total reactions) so one post can't accumulate an unbounded
// number of different reaction chips.
const MAX_DISTINCT_REACTIONS_PER_POST = 24;

// Same cap, applied to DM messages (see Message_Reactions).
const MAX_DISTINCT_REACTIONS_PER_MESSAGE = 24;

// Password reset email
// Configure via environment variables: SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE
// ('true'/'false'), SMTP_USER, SMTP_PASS.
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

module.exports = {
    APP_BASE_URL,
    ATTACHMENT_CONVERT_IMAGES,
    ATTACHMENT_IMAGE_MAX_DIM,
    ATTACHMENT_WEBP_QUALITY,
    MAX_ATTACHMENT_MB,
    MAX_BIO_LENGTH,
    MAX_DISTINCT_REACTIONS_PER_MESSAGE,
    MAX_DISTINCT_REACTIONS_PER_POST,
    MAX_FILE_SIZE,
    MAX_MESSAGE_ATTACHMENTS_BYTES,
    MAX_MSG_LENGTH,
    MAX_POST_LENGTH,
    MAX_REACTION_EMOJI_LENGTH,
    MB,
    PORT,
    UPLOAD_DAILY_BYTES,
    UPLOAD_MIN_FREE_BYTES,
    UPLOAD_QUOTA_BYTES,
    envNum,
    uploadsDir,
};
