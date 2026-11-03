// DM and group chat message bubbles.
const { renderAttachmentsHTML } = require('./attachments');
const { escapeHTML, renderAvatarHTML, renderEmbeds, renderNameWithHandle } = require('./html');
const { renderMarkdown } = require('./markdown');
const {
    getGCMessageReactions,
    getMessageReactions,
    renderGCMsgReactionsHTML,
    renderMsgReactionsHTML,
} = require('./posts');
const { getAttachments } = require('../uploads/files');

function renderMessageBubble(m, me, replyMsg) {
    const mine = m.from_user === me;
    const fileHTML = renderAttachmentsHTML(getAttachments(m), 260, '260px');
    const { embedHTML, cleanText } = renderEmbeds(m.content || '');
    const avatarHTML = renderAvatarHTML(m.avatar_path, m.from_user, 28);
    const senderHeader = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                <a href="/user/${escapeHTML(m.from_user)}" style="flex-shrink:0;">${avatarHTML}</a>
                <a href="/user/${escapeHTML(m.from_user)}" class="msg-sender-name" style="text-decoration:none;font-weight:bold;font-size:0.8em;">${renderNameWithHandle(m.from_user, m.Nickname, { isVerified: m.IsVerified })}</a>
            </div>`;
    const replyBanner = replyMsg
        ? `<div class="msg-reply-banner" style="font-size:0.78em;opacity:0.6;padding-left:8px;margin-bottom:4px;">> replying to <strong>${escapeHTML(replyMsg.from_user)}</strong>: ${escapeHTML((replyMsg.content || '').substring(0,60))}${(replyMsg.content || '').length > 60 ? '...' : ''}</div>`
        : '';
    const editLink = mine ? `<a href="#" onclick="editMessage(${m.id});return false;" class="msg-edit-link" style="text-decoration:none;">Edit</a>` : '';
    const deleteLink = mine ? `<a href="#" onclick="deleteMessage(${m.id});return false;" class="msg-delete-link" style="text-decoration:none;">Delete</a>` : '';
    const reportLink = !mine ? `<a href="#" onclick="reportContent('dm', ${m.id}, this);return false;" class="msg-delete-link report-action" data-report-type="dm" data-report-id="${m.id}" style="text-decoration:none;">Report</a>` : '';
    const reactLink = `<a href="#" onclick="openMsgReactionPicker(${m.id}, this);return false;" class="msg-react-link" style="text-decoration:none;color: var(--accent-color)">React</a>`;
    const editedMarker = m.edited ? `<span style="opacity:0.7;">(edited)</span>` : '';
    return `<div class="chat-msg-row" data-id="${m.id}" style="display:flex;justify-content:${mine ? 'flex-end' : 'flex-start'};margin-bottom:10px;">
        <div class="${mine ? 'msg-bubble-mine' : 'msg-bubble-other'}" style="max-width:70%;border-radius:12px;padding:8px 12px;">
            ${senderHeader}
            ${replyBanner}
            <div class="post-content" id="msg-content-${m.id}" data-raw="${escapeHTML(m.content || '')}">${renderMarkdown(cleanText)}</div>
            ${embedHTML}
            ${fileHTML}
            ${renderMsgReactionsHTML(m.id, getMessageReactions(m.id, me), me)}
            <div style="font-size:0.7em;opacity:0.5;margin-top:4px;display:flex;justify-content:flex-end;align-items:center;gap:10px;">
                <a href="#" onclick="setReply(${m.id}, '${escapeHTML(m.from_user)}');return false;" class="msg-reply-link" style="text-decoration:none;">Reply</a>
                ${reactLink}
                ${editLink}
                ${deleteLink}
                ${reportLink}
                ${editedMarker}
                <span data-ts="${m.created_at.replace(' ','T')+'Z'}"></span>
            </div>
        </div>
    </div>`;
}

function renderGCMessageBubble(m, me, replyMsg) {
    const mine = m.from_user === me;
    const fileHTML = renderAttachmentsHTML(getAttachments(m), 260, '260px');
    const { embedHTML, cleanText } = renderEmbeds(m.content || '');
    const replyBanner = replyMsg
        ? `<div class="msg-reply-banner" style="font-size:0.78em;opacity:0.6;padding-left:8px;margin-bottom:4px;">> replying to <strong>${escapeHTML(replyMsg.from_user)}</strong>: ${escapeHTML((replyMsg.content || '').substring(0,60))}${(replyMsg.content || '').length > 60 ? '...' : ''}</div>`
        : '';
    const avatarHTML = renderAvatarHTML(m.avatar_path, m.from_user, 28);
    const senderLabel = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <a href="/user/${escapeHTML(m.from_user)}" style="flex-shrink:0;">${avatarHTML}</a>
        <a href="/user/${escapeHTML(m.from_user)}" class="${mine ? 'msg-sender-mine' : 'msg-sender-other'}" style="text-decoration:none;font-weight:700;font-size:0.75em;">${renderNameWithHandle(m.from_user, m.Nickname, { isVerified: m.IsVerified })}</a>
    </div>`;
    const editLink = mine ? `<a href="#" onclick="editGCMessage(${m.id});return false;" class="msg-edit-link" style="text-decoration:none;">Edit</a>` : '';
    const deleteLink = mine ? `<a href="#" onclick="deleteGCMessage(${m.id});return false;" class="msg-delete-link" style="text-decoration:none;">Delete</a>` : '';
    const reportLink = !mine ? `<a href="#" onclick="reportContent('gc', ${m.id}, this);return false;" class="msg-delete-link report-action" data-report-type="gc" data-report-id="${m.id}" style="text-decoration:none;">Report</a>` : '';
    const reactLink = `<a href="#" onclick="openMsgReactionPicker(${m.id}, this);return false;" class="msg-react-link" style="text-decoration:none;color: var(--accent-color)">React</a>`;
    const editedMarker = m.edited ? `<span style="opacity:0.7;">(edited)</span>` : '';
    // Reaction highlighting is rendered against whatever "me" this bubble was built for.
    return `<div class="chat-msg-row" data-id="${m.id}" style="display:flex;justify-content:${mine ? 'flex-end' : 'flex-start'};margin-bottom:10px;">
        <div class="${mine ? 'msg-bubble-mine' : 'msg-bubble-other'}" style="max-width:70%;border-radius:12px;padding:8px 12px;">
            ${senderLabel}
            ${replyBanner}
            <div class="post-content" id="gc-msg-content-${m.id}" data-raw="${escapeHTML(m.content || '')}">${renderMarkdown(cleanText)}</div>
            ${embedHTML}
            ${fileHTML}
            ${renderGCMsgReactionsHTML(m.id, getGCMessageReactions(m.id, me), me)}
            <div style="font-size:0.7em;opacity:0.5;margin-top:4px;display:flex;justify-content:flex-end;align-items:center;gap:10px;">
                <a href="#" onclick="setGCReply(${m.id}, '${escapeHTML(m.from_user)}');return false;" class="msg-reply-link" style="text-decoration:none;">Reply</a>
                ${reactLink}
                ${editLink}
                ${deleteLink}
                ${reportLink}
                ${editedMarker}
                <span data-ts="${m.created_at.replace(' ','T')+'Z'}"></span>
            </div>
        </div>
    </div>`;
}

module.exports = { renderGCMessageBubble, renderMessageBubble };
