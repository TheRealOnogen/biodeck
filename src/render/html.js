// Escaping, names, badges, embeds and avatar HTML.
const path = require('path');

function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

// Nicknames are display-only - pings, profile URLs, and logins always use the username.
const MAX_NICKNAME_LENGTH = 32;
function displayName(username, nickname) {
    return (nickname && nickname.trim()) ? nickname.trim() : username;
}

// Small blue checkmark badge shown right next to a username, wherever a username is displayed.
function renderVerifiedBadge(isVerified) {
    if (!isVerified) return '';
    return `<svg viewBox="0 0 22 22" width="15" height="15" style="display:inline-block;vertical-align:middle;flex-shrink:0;margin-left:3px;" aria-label="Verified account" role="img"><title>Verified account</title><circle cx="11" cy="11" r="11" fill="var(--accent-color, #1d9bf0)"></circle><path d="M6.3 11.3l3.1 3.1 6.3-6.7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
}

// Renders "Nickname" with a smaller "@username" next to it when a nickname is set, or just
// "@username" when it isn't.
function renderNameWithHandle(username, nickname, opts = {}) {
    const safeUsername = escapeHTML(username);
    const badge = renderVerifiedBadge(opts.isVerified);
    const hasNickname = nickname && nickname.trim();
    if (!hasNickname) {
        return `<span style="${opts.nameStyle || ''}">@${safeUsername}${badge}</span>`;
    }
    const safeNickname = escapeHTML(nickname.trim());
    return `<span style="${opts.nameStyle || ''}">${safeNickname}${badge}</span><span style="opacity:0.5;font-size:0.85em;margin-left:5px;${opts.handleStyle || ''}">@${safeUsername}</span>`;
}

function renderEmbeds(text) {
    if (!text) return { embedHTML: '', cleanText: text };
    const urlRegex = /https?:\/\/[^\s<>"]+/g;
    const urls = text.match(urlRegex) || [];
    const embeds = [];
    const usedUrls = new Set();

    for (const url of urls) {
        if (usedUrls.has(url)) continue;

        const ytMatch = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
        if (ytMatch) {
            usedUrls.add(url);
            embeds.push(`<div style="margin-top:8px;"><iframe width="320" height="180" src="https://www.youtube.com/embed/${ytMatch[1]}" frameborder="0" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen style="border-radius:8px;max-width:100%;"></iframe></div>`);
            continue;
        }

        const spMatch = url.match(/open\.spotify\.com\/(track|album|playlist|episode|show)\/([A-Za-z0-9]+)/);
        if (spMatch) {
            usedUrls.add(url);
            embeds.push(`<div style="margin-top:8px;"><iframe src="https://open.spotify.com/embed/${spMatch[1]}/${spMatch[2]}" width="320" height="80" frameborder="0" allow="autoplay;clipboard-write;encrypted-media;fullscreen;picture-in-picture" loading="lazy" style="border-radius:12px;max-width:100%;"></iframe></div>`);
            continue;
        }

        if (/soundcloud\.com\/[^/]+\/[^/\s]+/.test(url)) {
            usedUrls.add(url);
            const encoded = encodeURIComponent(url);
            embeds.push(`<div style="margin-top:8px;"><iframe width="320" height="80" scrolling="no" frameborder="no" src="https://w.soundcloud.com/player/?url=${encoded}&color=%2300bfff&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false" style="border-radius:8px;max-width:100%;"></iframe></div>`);
            continue;
        }

        const imgurMatch = url.match(/imgur\.com\/(?:a\/|gallery\/)?([A-Za-z0-9]+)(?:\.[a-z]+)?$/i);
        if (imgurMatch) {
            usedUrls.add(url);
            if (/\.(jpg|jpeg|png|gif|webp|mp4|gifv)$/i.test(url)) {
                const imgUrl = url.replace(/\.gifv$/i, '.mp4');
                if (/\.mp4$/i.test(imgUrl)) {
                    embeds.push(`<div style="margin-top:8px;"><video autoplay loop muted playsinline style="max-width:320px;max-height:320px;border-radius:8px;display:block;"><source src="${imgUrl}" type="video/mp4"></video></div>`);
                } else {
                    embeds.push(`<div style="margin-top:8px;"><img src="${imgUrl}" style="max-width:320px;max-height:320px;border-radius:8px;display:block;" loading="lazy"></div>`);
                }
            } else {
                embeds.push(`<div style="margin-top:8px;"><blockquote class="imgur-embed-pub" lang="en" data-id="${imgurMatch[1]}" data-context="false"><a href="${escapeHTML(url)}">View on Imgur</a></blockquote><script async src="//s.imgur.com/min/embed.js" charset="utf-8"><\/script></div>`);
            }
            continue;
        }

        if (/\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i.test(url)) {
            usedUrls.add(url);
            embeds.push(`<div style="margin-top:8px;"><img src="${escapeHTML(url)}" style="max-width:320px;max-height:320px;border-radius:8px;display:block;" loading="lazy" onerror="this.parentElement.remove()"></div>`);
            continue;
        }

        if (/\.(mp4|webm|ogg|ogv|mov)(\?.*)?$/i.test(url)) {
            usedUrls.add(url);
            embeds.push(`<div style="margin-top:8px;"><video controls preload="metadata" style="max-width:320px;max-height:240px;border-radius:8px;display:block;background:black;"><source src="${escapeHTML(url)}">Your browser can't play this video. <a href="${escapeHTML(url)}" target="_blank" style="color:var(--accent-color);">Download</a></video></div>`);
            continue;
        }

        if (/\.(mp3|wav|flac|aac|m4a|opus|oga)(\?.*)?$/i.test(url)) {
            usedUrls.add(url);
            embeds.push(`<div style="margin-top:8px;"><audio controls preload="metadata" style="width:280px;max-width:100%;border-radius:8px;display:block;"><source src="${escapeHTML(url)}">Your browser can't play this audio. <a href="${escapeHTML(url)}" target="_blank" style="color:var(--accent-color);">Download</a></audio></div>`);
            continue;
        }
    }

    let cleanText = text;
    for (const u of usedUrls) {
        cleanText = cleanText.split(u).join('');
    }
    cleanText = cleanText.trim();

    return { embedHTML: embeds.join(''), cleanText };
}

function avatarPathToURL(avatarPath) {
    // Avatars uploaded by users live under public/uploads, but some avatars.
    const normalized = avatarPath.replace(/\\/g, '/');
    if (normalized.startsWith('public/')) {
        return `/${normalized.slice('public/'.length)}`;
    }
    return `/uploads/${path.basename(avatarPath)}`;
}

function renderAvatarHTML(avatarPath, username, size) {
    const initial = escapeHTML((username || '?').charAt(0).toUpperCase());
    if (avatarPath) {
        const url = avatarPathToURL(avatarPath);
        return `<img src="${url}" alt="${escapeHTML(username)}" style="width:${size}px;height:${size}px;min-width:${size}px;border-radius:50%;object-fit:cover;display:block;border:1px solid rgba(255,255,255,0.2);">`;
    }
    return `<div style="width:${size}px;height:${size}px;min-width:${size}px;border-radius:50%;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.2);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:${Math.round(size * 0.45)}px;">${initial}</div>`;
}

// Renders just the avatar (+ username heading) shown above the ban/delete notice message on those
// screens.
function renderAvatarBlockHTML(avatarPath, username) {
    return `<div style="display:flex;justify-content:center;margin-bottom:10px;">
            ${renderAvatarHTML(avatarPath, username || '?', 84)}
        </div>
        ${username ? `<h2 style="margin:0 0 14px;">@${escapeHTML(username)}</h2>` : ''}`;
}

module.exports = {
    MAX_NICKNAME_LENGTH,
    avatarPathToURL,
    displayName,
    escapeHTML,
    renderAvatarBlockHTML,
    renderAvatarHTML,
    renderEmbeds,
    renderNameWithHandle,
    renderVerifiedBadge,
};
