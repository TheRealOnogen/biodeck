// Reactions and feed post rendering.
const { getStmt } = require('../db/connection');
const { renderReactionEmojiHTML } = require('../emoji');
const { renderAttachmentsHTML } = require('./attachments');
const {
    displayName,
    escapeHTML,
    renderAvatarHTML,
    renderEmbeds,
    renderNameWithHandle,
    renderVerifiedBadge,
} = require('./html');
const { renderMarkdown } = require('./markdown');
const { getAttachments } = require('../uploads/files');

// Aggregated per-emoji reaction counts for a post.
function getPostReactions(postId, sessionUsername) {
    try {
        return getStmt(
            `SELECT emoji, COUNT(*) AS cnt, MAX(username = ?) AS reacted_by_me
             FROM Reactions WHERE post_id = ? GROUP BY emoji ORDER BY MIN(id) ASC`
        ).all(sessionUsername || '', postId);
    } catch (e) {
        console.error('getPostReactions error:', e.message);
        return [];
    }
}

// Renders the reaction-chip row for a post: one small circular chip per distinct emoji (with its
// count).
function renderReactionsHTML(postId, reactions, sessionUsername) {
    const loggedIn = !!sessionUsername;
    const chips = (reactions || []).map(r => {
        const mine = !!r.reacted_by_me;
        const tag = loggedIn ? 'button' : 'span';
        const typeAttr = loggedIn ? ' type="button"' : '';
        const clickAttr = loggedIn ? ` onclick="toggleReaction(${postId}, this)"` : '';
        return `<${tag}${typeAttr} class="reaction-chip" data-emoji="${escapeHTML(r.emoji)}"${clickAttr} title="${r.cnt} reaction${r.cnt === 1 ? '' : 's'}"
            style="display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 10px;border-radius:14px;border:1px solid ${mine ? 'var(--accent-color)' : 'var(--post-border-color)'};background:${mine ? 'var(--msg-mine-bg)' : 'transparent'};color:var(--text-color);${loggedIn ? 'cursor:pointer;' : ''}font-size:0.85em;line-height:1;box-sizing:border-box;">
            <span style="font-size:1.05em;">${renderReactionEmojiHTML(r.emoji)}</span><span style="opacity:0.7;">${r.cnt}</span>
        </${tag}>`;
    }).join('');
    const addBtn = loggedIn ? `<button type="button" class="reaction-add-btn" onclick="openReactionPicker(${postId}, this)" title="Add reaction"
        style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;border:1px dashed var(--post-border-color);background:transparent;color:var(--text-color);opacity:0.6;cursor:pointer;font-size:0.9em;line-height:1;">+</button>` : '';
    if (!chips && !addBtn) return `<div class="post-reactions" id="post-reactions-${postId}" style="position:relative;"></div>`;
    return `<div class="post-reactions" id="post-reactions-${postId}" style="position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px;">${chips}${addBtn}</div>`;
}

// Message_Reactions equivalent of getPostReactions - aggregated per-emoji counts for one DM
// message, plus whether sessionUsername.
function getMessageReactions(messageId, sessionUsername) {
    try {
        return getStmt(
            `SELECT emoji, COUNT(*) AS cnt, MAX(username = ?) AS reacted_by_me
             FROM Message_Reactions WHERE message_id = ? GROUP BY emoji ORDER BY MIN(id) ASC`
        ).all(sessionUsername || '', messageId);
    } catch (e) {
        console.error('getMessageReactions error:', e.message);
        return [];
    }
}

// Message_Reactions equivalent of renderReactionsHTML.
function renderMsgReactionsHTML(messageId, reactions, sessionUsername) {
    const chips = (reactions || []).map(r => {
        const mine = !!r.reacted_by_me;
        return `<button type="button" class="reaction-chip" data-emoji="${escapeHTML(r.emoji)}" onclick="toggleMsgReaction(${messageId}, this)" title="${r.cnt} reaction${r.cnt === 1 ? '' : 's'}"
            style="display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:12px;border:1px solid ${mine ? 'var(--accent-color)' : 'var(--post-border-color)'};background:${mine ? 'var(--msg-mine-bg)' : 'transparent'};color:var(--text-color);cursor:pointer;font-size:0.78em;line-height:1;box-sizing:border-box;">
            <span style="font-size:1.05em;">${renderReactionEmojiHTML(r.emoji)}</span><span style="opacity:0.7;">${r.cnt}</span>
        </button>`;
    }).join('');
    if (!chips) return `<div class="msg-reactions" id="msg-reactions-${messageId}" style="position:relative;"></div>`;
    return `<div class="msg-reactions" id="msg-reactions-${messageId}" style="position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:6px;">${chips}</div>`;
}

// Group_Chat_Message_Reactions equivalent of getMessageReactions.
function getGCMessageReactions(messageId, sessionUsername) {
    try {
        return getStmt(
            `SELECT emoji, COUNT(*) AS cnt, MAX(username = ?) AS reacted_by_me
             FROM Group_Chat_Message_Reactions WHERE message_id = ? GROUP BY emoji ORDER BY MIN(id) ASC`
        ).all(sessionUsername || '', messageId);
    } catch (e) {
        console.error('getGCMessageReactions error:', e.message);
        return [];
    }
}

// Renders the same "msg-reactions-<id>" fragment as renderMsgReactionsHTML.
function renderGCMsgReactionsHTML(messageId, reactions, sessionUsername) {
    const chips = (reactions || []).map(r => {
        const mine = !!r.reacted_by_me;
        return `<button type="button" class="reaction-chip" data-emoji="${escapeHTML(r.emoji)}" onclick="toggleMsgReaction(${messageId}, this)" title="${r.cnt} reaction${r.cnt === 1 ? '' : 's'}"
            style="display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:12px;border:1px solid ${mine ? 'var(--accent-color)' : 'var(--post-border-color)'};background:${mine ? 'var(--msg-mine-bg)' : 'transparent'};color:var(--text-color);cursor:pointer;font-size:0.78em;line-height:1;box-sizing:border-box;">
            <span style="font-size:1.05em;">${renderReactionEmojiHTML(r.emoji)}</span><span style="opacity:0.7;">${r.cnt}</span>
        </button>`;
    }).join('');
    if (!chips) return `<div class="msg-reactions" id="msg-reactions-${messageId}" style="position:relative;"></div>`;
    return `<div class="msg-reactions" id="msg-reactions-${messageId}" style="position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:6px;">${chips}</div>`;
}

function renderFeedPost(post, sessionUsername, fileMaxHeight, isAdmin) {
    const fileHTML = renderAttachmentsHTML(getAttachments(post), fileMaxHeight);
    const isOwner = post.username === sessionUsername;
    const canDelete = isOwner || isAdmin;
    const deleteBtn = canDelete ? `<button class="button post-action-btn" onclick="deletePost(${post.id})">Delete${(!isOwner && isAdmin) ? '' : ''}</button>` : '';
    const editBtn = isOwner ? `<button class="button post-action-btn" onclick="editPost(${post.id})">Edit</button>` : '';
    const pinBtn = isAdmin ? `<button class="button post-action-btn" onclick="${post.pinned ? `unpinPost(${post.id})` : `pinPost(${post.id})`}">${post.pinned ? 'Unpin' : 'Pin'}</button>` : '';
    const reportBtn = (!isOwner && sessionUsername) ? `<button class="button post-action-btn report-action" data-report-type="post" data-report-id="${post.id}" onclick="reportContent('post', ${post.id}, this)">Report</button>` : '';
    const safeUsername = escapeHTML(post.username);
    const { embedHTML, cleanText } = renderEmbeds(post.content || '');
    const avatarHTML = renderAvatarHTML(post.avatar_path, post.username, 32);
    const editedMarker = post.edited ? `<span style="opacity:0.6;font-size:0.8em;margin-left:6px;">(edited)</span>` : '';
    return `<div class="post-header" style="display:flex;align-items:flex-start;gap:8px;">
            <a href="/user/${safeUsername}" style="flex-shrink:0;">${avatarHTML}</a>
            <div style="display:flex;flex-direction:column;min-width:0;">
                <a href="/user/${safeUsername}" style="color:var(--text-color);text-decoration:none;font-weight:bold;">${renderNameWithHandle(post.username, post.Nickname, { isVerified: post.IsVerified })}</a>
                <span><span class="post-time" data-ts="${post.created_at.replace(' ', 'T') + 'Z'}" style="font-size:0.8em;opacity:0.6;"></span>${editedMarker}</span>
            </div>
        </div>
        <div class="post-content" id="post-content-${post.id}" data-raw="${escapeHTML(post.content || '')}">${renderMarkdown(cleanText)}</div>
        ${embedHTML}
        ${fileHTML}
        ${renderReactionsHTML(post.id, getPostReactions(post.id, sessionUsername), sessionUsername)}
        <div class="post-actions">
            <a href="/post/${post.id}" class="button post-action-btn reply-count-btn" data-post-id="${post.id}" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center;width:auto !important;white-space:nowrap;padding-left:5px !important;padding-right:5px !important;box-sizing:border-box;">${(post.reply_count || 0)} Replies</a>
            ${pinBtn}
            ${editBtn}
            ${deleteBtn}
            ${reportBtn}
        </div>`;
}

function renderPinnedItem(post) {
    const safeUsername = escapeHTML(post.username);
    const safeContent = escapeHTML((post.content || '').trim());
    const preview = safeContent.length > 140 ? safeContent.slice(0, 140) + '…' : safeContent;
    const previewHTML = preview || '<span style="opacity:0.5;">(attachment)</span>';
    return `<div class="pinned-item" data-pin-id="${post.id}" style="display:flex;align-items:center;gap:10px;padding:8px 24px;background:rgba(255,180,40,0.08);border-bottom:1px solid rgba(255,180,40,0.25);">
        <span style="font-size:0.7em;letter-spacing:0.08em;color:var(--pinned-color);font-weight:700;text-transform:uppercase;flex-shrink:0;">Pinned</span>
        <a href="/user/${safeUsername}" style="color:var(--text-color);text-decoration:none;font-weight:bold;flex-shrink:0;">${escapeHTML(displayName(post.username, post.Nickname))}${renderVerifiedBadge(post.IsVerified)}</a>
        <span style="opacity:0.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;">${previewHTML}</span>
        <a href="#" onclick="dismissPin(${post.id});return false;" title="Hide this pin" style="color:var(--text-dimmer-color);text-decoration:none;font-weight:700;flex-shrink:0;padding:0 4px;">✕</a>
    </div>`;
}

function buildPostListHTML(posts, sessionUsername, fileMaxHeight, isAdmin) {
    return posts.map(post => `
        <div class="post" id="post-${post.id}">
            ${renderFeedPost(post, sessionUsername, fileMaxHeight, isAdmin)}
        </div><br>`).join('');
}

function buildFeedHTML(posts, sessionUsername, fileMaxHeight, isAdmin) {
    const roots = posts.filter(p => !p.reply_to);
    return buildPostListHTML(roots, sessionUsername, fileMaxHeight, isAdmin);
}

module.exports = {
    buildFeedHTML,
    buildPostListHTML,
    getGCMessageReactions,
    getMessageReactions,
    getPostReactions,
    renderFeedPost,
    renderGCMsgReactionsHTML,
    renderMsgReactionsHTML,
    renderPinnedItem,
    renderReactionsHTML,
};
