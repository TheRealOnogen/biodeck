// Notification list rendering.
const { displayName, escapeHTML, renderVerifiedBadge } = require('./html');

const NOTIF_ICONS = { reply: '>', dm: '>', friend_request: '+', friend_accept: '✓', friend_decline: '×', mention_post: '@', mention_dm: '@', mention_gc: '@' };

function notifText(n) {
    const actor = `<a href="/user/${escapeHTML(n.actor_username)}" style="color:var(--text-color);font-weight:bold;text-decoration:none;">${escapeHTML(displayName(n.actor_username, n.actor_nickname))}${renderVerifiedBadge(n.actor_verified)}</a>`;
    switch (n.type) {
        case 'reply': return `${actor} replied to your post`;
        case 'dm': return `${actor} sent you a message`;
        case 'friend_request': return `${actor} sent you a friend request`;
        case 'friend_accept': return `${actor} accepted your friend request`;
        case 'friend_decline': return `${actor} declined your friend request`;
        case 'mention_post': return `${actor} mentioned you in a post`;
        case 'mention_dm': return `${actor} mentioned you in a message`;
        case 'mention_gc': return `${actor} mentioned you in a group chat`;
        default: return `${actor} did something`;
    }
}

function notifLink(n) {
    if (n.type === 'reply' || n.type === 'mention_post') return `/post/${n.post_id}`;
    if (n.type === 'dm') return `/messages/${encodeURIComponent(n.actor_username)}`;
    if (n.type === 'mention_dm') return `/user/${encodeURIComponent(n.actor_username)}`;
    if (n.type === 'mention_gc') return `/groups/${n.post_id}`;
    if (n.type === 'friend_request' || n.type === 'friend_accept' || n.type === 'friend_decline') return `/friends`;
    return '#';
}

function renderNotificationItem(n) {
    const icon = NOTIF_ICONS[n.type] || '*';
    const preview = n.content_preview ? `<div style="opacity:0.6;font-size:0.85em;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(n.content_preview)}</div>` : '';
    const unreadDot = !n.read ? `<span style="width:8px;height:8px;border-radius:50%;background:rgb(0,191,255);flex-shrink:0;"></span>` : `<span style="width:8px;height:8px;flex-shrink:0;"></span>`;
    return `<div class="notif-item" data-id="${n.id}" data-href="${notifLink(n)}" style="display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:var(--text-color);cursor:pointer;margin-bottom:10px;background:${n.read ? 'transparent' : 'rgba(0,191,255,0.06)'};">
        ${unreadDot}
        <span style="font-size:1.1em;flex-shrink:0;">${icon}</span>
        <div style="flex:1;min-width:0;">
            <div>${notifText(n)}</div>
            ${preview}
            <span style="font-size:0.75em;opacity:0.5;" data-ts="${n.created_at.replace(' ','T')+'Z'}"></span>
        </div>
    </div>`;
}

module.exports = { notifLink, renderNotificationItem };
