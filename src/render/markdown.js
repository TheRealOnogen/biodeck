// Markdown, bare URL and @mention rendering.
const {
    CUSTOM_EMOJI_SIZE_JUMBO,
    JUMBO_UNICODE_FONT_SIZE,
    UNICODE_EMOJI_REGEX,
    isEmojiOnlyText,
    replaceCustomEmojis,
} = require('../emoji');
const { escapeHTML } = require('./html');

// Scans message/post content for @username pings and notifies each mentioned user that exists in
// User_Data.
const MENTION_REGEX = /@([a-zA-Z0-9_]{1,32})/g;

// Wraps @username mentions in message/post text with a styled, clickable link.
function linkifyMentions(escapedText) {
    if (!escapedText) return escapedText;
    return escapedText.replace(/(^|[\s>])@([a-zA-Z0-9_]{1,32})/g, (full, pre, uname) => {
        return `${pre}<a href="/user/${uname}" style="color:var(--accent-color);text-decoration:none;font-weight:600;">@${uname}</a>`;
    });
}

// Renders post/message/ticket text for safe display: HTML-escapes it, then layers a small
// self-contained Markdown renderer on top.
const BARE_URL_REGEX = /https?:\/\/[^\s<>"'\u0000]+/g;
const MD_LINK_REGEX = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g;
const MD_HEADER_SIZES = { 1: '1.35em', 2: '1.22em', 3: '1.12em', 4: '1.05em', 5: '1em', 6: '0.95em' };

function renderMarkdown(text) {
    if (!text) return '';

    const slots = [];
    const stash = html => {
        const token = `\u0000MD${slots.length}\u0000`;
        slots.push(html);
        return token;
    };

    let escaped = escapeHTML(text);
    // Emoji-only text is drawn larger (see isEmojiOnlyText).
    const jumbo = isEmojiOnlyText(text);

    // Fenced code blocks - highest precedence, protects their contents.
    escaped = escaped.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (m, code) =>
        stash(`<pre style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:10px;overflow-x:auto;margin:6px 0;"><code>${code.replace(/\n$/, '')}</code></pre>`));

    // Inline code spans.
    escaped = escaped.replace(/`([^`\n]+)`/g, (m, code) =>
        stash(`<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:4px;font-family:monospace;">${code}</code>`));

    // Applies the remaining inline rules.
    function inlineFormat(line) {
        line = line.replace(MD_LINK_REGEX, (m, label, url) =>
            stash(`<a href="${url}" target="_blank" rel="noopener noreferrer nofollow" style="color:var(--accent-color);word-break:break-all;">${replaceCustomEmojis(label)}</a>`));
        // :custom_emoji: -> <img>.
        line = replaceCustomEmojis(line, stash, jumbo ? CUSTOM_EMOJI_SIZE_JUMBO : undefined);
        if (jumbo) {
            line = line.replace(UNICODE_EMOJI_REGEX, m =>
                stash(`<span class="jumbo-emoji" style="font-size:${JUMBO_UNICODE_FONT_SIZE};line-height:1.2;vertical-align:middle;">${m}</span>`));
        }
        line = line.replace(/\*\*([^\n]+?)\*\*/g, (m, t) => stash(`<strong>${t}</strong>`));
        line = line.replace(/__([^\n]+?)__/g, (m, t) => stash(`<strong>${t}</strong>`));
        line = line.replace(/~~([^\n]+?)~~/g, (m, t) => stash(`<del>${t}</del>`));
        line = line.replace(/\*([^\s*][^\n]*?)\*/g, (m, t) => stash(`<em>${t}</em>`));
        line = line.replace(/(^|[^\w])_([^\s_][^\n]*?)_(?!\w)/g, (m, pre, t) => `${pre}${stash(`<em>${t}</em>`)}`);
        // Trailing punctuation is usually sentence punctuation, not part of the URL (e.g.
        line = line.replace(BARE_URL_REGEX, url => {
            const trailingMatch = url.match(/[.,!?;:'")\]]+$/);
            let trailing = '';
            if (trailingMatch) {
                trailing = trailingMatch[0];
                url = url.slice(0, -trailing.length);
            }
            if (!url) return trailing;
            return stash(`<a href="${url}" target="_blank" rel="noopener noreferrer nofollow" style="color:var(--accent-color);word-break:break-all;">${url}</a>`) + trailing;
        });
        return linkifyMentions(line);
    }

    const lines = escaped.split('\n');
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        if (/^#{1,6}\s+/.test(line)) {
            const level = line.match(/^(#{1,6})/)[1].length;
            blocks.push(`<div style="font-weight:700;font-size:${MD_HEADER_SIZES[level]};margin:6px 0 4px;">${inlineFormat(line.replace(/^#{1,6}\s+/, ''))}</div>`);
            i++;
            continue;
        }

        if (/^&gt;\s?/.test(line)) {
            const quote = [];
            while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
                quote.push(inlineFormat(lines[i].replace(/^&gt;\s?/, '')));
                i++;
            }
            blocks.push(`<blockquote style="border-left:3px solid rgba(255,255,255,0.25);margin:6px 0;padding:2px 0 2px 10px;opacity:0.85;">${quote.join('<br>')}</blockquote>`);
            continue;
        }

        if (/^[-*]\s+/.test(line)) {
            const items = [];
            while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
                items.push(`<li>${inlineFormat(lines[i].replace(/^[-*]\s+/, ''))}</li>`);
                i++;
            }
            blocks.push(`<ul style="margin:4px 0;padding-left:22px;">${items.join('')}</ul>`);
            continue;
        }

        if (/^\d+\.\s+/.test(line)) {
            const items = [];
            while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
                items.push(`<li>${inlineFormat(lines[i].replace(/^\d+\.\s+/, ''))}</li>`);
                i++;
            }
            blocks.push(`<ol style="margin:4px 0;padding-left:22px;">${items.join('')}</ol>`);
            continue;
        }

        if (line.trim() === '') { i++; continue; }

        const para = [];
        while (i < lines.length && lines[i].trim() !== ''
            && !/^#{1,6}\s+/.test(lines[i]) && !/^&gt;\s?/.test(lines[i])
            && !/^[-*]\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i])) {
            para.push(inlineFormat(lines[i]));
            i++;
        }
        blocks.push(`<div>${para.join('<br>')}</div>`);
    }

    let out = blocks.join('');
    for (let guard = 0; guard < 10 && /\u0000MD\d+\u0000/.test(out); guard++) {
        out = out.replace(/\u0000MD(\d+)\u0000/g, (m, n) => slots[+n]);
    }
    return out;
}

module.exports = { MENTION_REGEX, renderMarkdown };
