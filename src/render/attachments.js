// Attachment HTML.
const path = require('path');
const fs = require('fs');
const { escapeHTML } = require('./html');
const {
    MSG_AUDIO_MIME_TYPES,
    MSG_VIDEO_MIME_TYPES,
    downloadUrlFor,
    fileIconFor,
    formatFileSize,
} = require('../uploads/files');
const { MSG_IMAGE_EXTS } = require('../uploads/multer');

// Renders one or more attachments.
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
            // f.size is set for anything uploaded after this was added; older attachments won't
            // have it.
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

module.exports = { renderAttachmentsHTML };
