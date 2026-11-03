// Collects a user's data into archives.
const path = require('path');
const fs = require('fs');
const { uploadsDir } = require('../config');
const {
    DATA_DIR,
    DATA_EXPORT_CATEGORIES,
    DATA_EXPORT_MAX_SIZE_BYTES,
    DATA_EXPORT_UNLIMITED,
    DxUserError,
    dxAll,
    dxGet,
    dxIso,
    dxRun,
    dxTooLargeError,
} = require('./core');
const { DxTarGzWriter, dxUntarGz } = require('./tar');
const { logAudit } = require('../moderation');
const { getAttachments } = require('../uploads/files');

// gathering a user's data

// Collects the attachment files that go into an archive. ref() hands back the { name, file } object
// that is embedded in the JSON.
class DxAttachments {
    constructor() { this.entries = new Map(); this.counter = 0; }

    ref(dir, f) {
        const base = path.basename(String((f && f.path) || '').replace(/\\/g, '/'));
        const out = { name: String((f && f.name) || base || 'file'), file: null };
        if (!base || base.startsWith('.')) return out;
        const abs = path.join(uploadsDir, base);
        const key = dir + '|' + abs;
        let entry = this.entries.get(key);
        if (!entry) {
            try { if (!fs.statSync(abs).isFile()) return out; } catch (e) { return out; }
            const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(-80);
            entry = { abs, archiveName: `${dir}${++this.counter}_${safe}`, refs: [] };
            this.entries.set(key, entry);
        }
        out.file = entry.archiveName;
        entry.refs.push(out);
        return out;
    }

    async commit(writer) {
        if (!DATA_EXPORT_UNLIMITED) {
            // Refuse BEFORE building a huge archive (media is already compressed, so the files' own
            // sizes are a good estimate of the result).
            let total = 0;
            for (const entry of this.entries.values()) { try { total += fs.statSync(entry.abs).size; } catch (e) {} }
            if (total > DATA_EXPORT_MAX_SIZE_BYTES) throw dxTooLargeError(total);
        }
        for (const entry of this.entries.values()) {
            try {
                await writer.addFile(entry.archiveName, entry.abs);
            } catch (e) {
                console.error('Data export: could not add attachment', path.basename(entry.abs), '-', e.message);
                entry.refs.forEach(r => { r.file = null; });
            }
        }
    }
}

function dxGroupReactions(rows, idKey) {
    const byId = new Map();
    for (const r of rows) {
        let perEmoji = byId.get(r[idKey]);
        if (!perEmoji) { perEmoji = new Map(); byId.set(r[idKey], perEmoji); }
        if (!perEmoji.has(r.emoji)) perEmoji.set(r.emoji, []);
        perEmoji.get(r.emoji).push(r.username);
    }
    const lookup = (id) => {
        const perEmoji = byId.get(id);
        return perEmoji ? Array.from(perEmoji, ([emoji, users]) => ({ emoji, users })) : [];
    };
    return lookup;
}

// Returns { 'archive/path.json': object, ... } for the requested categories.
async function dxCollect(userId, username, categories, att) {
    const want = new Set(categories);
    const docs = {};

    if (want.has('account')) {
        const u = await dxGet(`SELECT * FROM User_Data WHERE id = ?`, [userId]);
        if (!u) throw new DxUserError('This account no longer exists.');
        const friends = await dxAll(`SELECT user_a, user_b, created_at FROM Friends WHERE user_a = ? OR user_b = ? ORDER BY id`, [username, username]);
        const friendRequests = await dxAll(`SELECT from_user, to_user, status, created_at FROM Friend_Requests WHERE from_user = ? OR to_user = ? ORDER BY id`, [username, username]);
        const following = await dxAll(`SELECT following_username, created_at FROM Follows WHERE follower_username = ? ORDER BY id`, [username]);
        const followers = await dxAll(`SELECT follower_username, created_at FROM Follows WHERE following_username = ? ORDER BY id`, [username]);
        const groups = await dxAll(`SELECT g.id, g.name, g.created_by, g.is_public, m.joined_at
            FROM Group_Chat_Members m JOIN Group_Chats g ON g.id = m.group_id WHERE m.username = ? ORDER BY g.id`, [username]);
        const warnings = await dxAll(`SELECT reason, created_at, expires_at, mute_chat, account_action, removed_content FROM Warnings WHERE username = ? ORDER BY id`, [username]);
        const logins = await dxAll(`SELECT ip, event, created_at FROM IP_Login_History WHERE user_id = ? ORDER BY id`, [userId]);

        // Uploaded avatars are stored as public/uploads/<file>; the default placeholder.
        let avatar = null;
        if (u.avatar_path) {
            const ref = att.ref('account/avatar/', { path: u.avatar_path, name: path.basename(String(u.avatar_path)) });
            if (ref.file) avatar = ref;
        }
        docs['account/account.json'] = {
            username: u.username,
            nickname: u.Nickname || null,
            bio: u.bio || '',
            email: u.email || null,
            email_verified: !!u.email_verified,
            theme: u.theme || 'default',
            avatar,
            badges: {
                verified: !!u.IsVerified, supporter: !!u.IsSupporter, developer: !!u.IsDeveloper,
                admin: !!u.IsAdmin, head_admin: !!u.IsHeadAdmin, owner: !!u.IsOwner
            },
            status: {
                banned: !!u.IsBanned, ban_reason: u.BanReason || null, ban_expires_at: u.BanExpiresAt || null,
                deleted: !!u.IsDeleted, delete_reason: u.DeleteReason || null
            },
            friends: friends.map(r => ({ username: r.user_a === username ? r.user_b : r.user_a, since: dxIso(r.created_at) })),
            friend_requests: friendRequests.map(r => ({
                direction: r.from_user === username ? 'sent' : 'received',
                other_user: r.from_user === username ? r.to_user : r.from_user,
                status: r.status, created_at: dxIso(r.created_at)
            })),
            following: following.map(r => ({ username: r.following_username, since: dxIso(r.created_at) })),
            followers: followers.map(r => ({ username: r.follower_username, since: dxIso(r.created_at) })),
            group_chats: groups.map(g => ({
                id: g.id, name: g.name, created_by: g.created_by, public: !!g.is_public, joined_at: dxIso(g.joined_at)
            })),
            warnings: warnings.map(w => ({
                reason: w.reason, issued_at: dxIso(w.created_at), expires_at: w.expires_at || null,
                muted_chat: !!w.mute_chat, account_action: w.account_action || null, removed_content: w.removed_content || null
            })),
            login_history: logins.map(l => ({ ip: l.ip, event: l.event, at: dxIso(l.created_at) }))
        };
    }

    if (want.has('posts')) {
        const rows = await dxAll(`SELECT id, content, file_path, file_name, files_json, reply_to, pinned, edited, created_at
            FROM Posts WHERE username = ? ORDER BY id`, [username]);
        const reactions = dxGroupReactions(await dxAll(`SELECT post_id, emoji, username FROM Reactions
            WHERE post_id IN (SELECT id FROM Posts WHERE username = ?) ORDER BY id`, [username]), 'post_id');
        docs['posts/posts.json'] = {
            username, count: rows.length,
            posts: rows.map(r => ({
                id: r.id, content: r.content, created_at: dxIso(r.created_at),
                reply_to_post: r.reply_to || null, pinned: !!r.pinned, edited: !!r.edited,
                attachments: getAttachments(r).map(f => att.ref('posts/attachments/', f)),
                reactions: reactions(r.id)
            }))
        };
    }

    if (want.has('dms')) {
        const dms = await dxAll(`SELECT id, from_user, to_user, content, file_path, file_name, files_json, reply_to, edited, read, created_at
            FROM Messages WHERE from_user = ? OR to_user = ? ORDER BY id`, [username, username]);
        const dmReactions = dxGroupReactions(await dxAll(`SELECT message_id, emoji, username FROM Message_Reactions
            WHERE message_id IN (SELECT id FROM Messages WHERE from_user = ? OR to_user = ?) ORDER BY id`, [username, username]), 'message_id');
        docs['dms/direct_messages.json'] = {
            username, count: dms.length,
            note: 'Every direct message you sent or received.',
            messages: dms.map(r => ({
                id: r.id, from: r.from_user, to: r.to_user, content: r.content, sent_at: dxIso(r.created_at),
                read: !!r.read, edited: !!r.edited, reply_to_message: r.reply_to || null,
                attachments: getAttachments(r).map(f => att.ref('dms/attachments/', f)),
                reactions: dmReactions(r.id)
            }))
        };
        const gcs = await dxAll(`SELECT m.id, m.group_id, g.name AS group_name, m.content, m.file_path, m.file_name, m.files_json, m.reply_to, m.edited, m.created_at
            FROM Group_Chat_Messages m LEFT JOIN Group_Chats g ON g.id = m.group_id WHERE m.from_user = ? ORDER BY m.id`, [username]);
        const gcReactions = dxGroupReactions(await dxAll(`SELECT message_id, emoji, username FROM Group_Chat_Message_Reactions
            WHERE message_id IN (SELECT id FROM Group_Chat_Messages WHERE from_user = ?) ORDER BY id`, [username]), 'message_id');
        docs['dms/group_chat_messages.json'] = {
            username, count: gcs.length,
            note: 'Group chat messages you sent (other members\' messages are not included).',
            messages: gcs.map(r => ({
                id: r.id, group_id: r.group_id, group_name: r.group_name || null, content: r.content, sent_at: dxIso(r.created_at),
                edited: !!r.edited, reply_to_message: r.reply_to || null,
                attachments: getAttachments(r).map(f => att.ref('dms/attachments/', f)),
                reactions: gcReactions(r.id)
            }))
        };
    }

    if (want.has('support')) {
        const tickets = await dxAll(`SELECT id, subject, message, status, created_at FROM Support_Tickets WHERE username = ? ORDER BY id`, [username]);
        const replies = await dxAll(`SELECT ticket_id, message, is_customer, created_at FROM Support_Ticket_Replies
            WHERE ticket_id IN (SELECT id FROM Support_Tickets WHERE username = ?) ORDER BY id`, [username]);
        docs['support/tickets.json'] = {
            username, count: tickets.length,
            tickets: tickets.map(t => ({
                id: t.id, subject: t.subject, message: t.message, status: t.status, created_at: dxIso(t.created_at),
                replies: replies.filter(r => r.ticket_id === t.id).map(r => ({
                    from: r.is_customer ? 'you' : 'support team', message: r.message, at: dxIso(r.created_at)
                }))
            }))
        };
    }
    return docs;
}

function dxReadmeText(manifest) {
    const names = DATA_EXPORT_CATEGORIES.filter(c => manifest.categories.includes(c.key)).map(c => c.label).join(', ');
    return [
        `Biodeck data export for @${manifest.username}`,
        `Generated: ${manifest.generated_at}`,
        `Included: ${names}`,
        manifest.source === 'archive of deleted account' ? `Source: the copy saved when the account was deleted (${manifest.account_archived_at || 'unknown date'}).` : '',
        '',
        'Everything is plain JSON (UTF-8) except uploaded files, which are stored as-is.',
        'Timestamps are UTC. Files referenced in the JSON (the "file" field) live next to it',
        'under an "attachments" folder; "file": null means the upload no longer exists.',
        '',
        '  account/account.json          profile, email, badges, friends, follows, warnings, login history',
        '  posts/posts.json              your posts and replies',
        '  dms/direct_messages.json      DMs you sent or received',
        '  dms/group_chat_messages.json  group chat messages you sent',
        '  support/tickets.json          your support tickets and the replies on them',
        ''
    ].filter(l => l !== null).join('\n');
}

function dxManifest(username, categories, source, extra) {
    return Object.assign({
        format: 'biodeck-data-export', version: 1, username, categories,
        generated_at: new Date().toISOString(), source
    }, extra || {});
}

// Builds a data archive for a live account straight from the database.
async function dxWriteUserArchive({ userId, username, categories, destPath, source, extra }) {
    const att = new DxAttachments();
    const docs = await dxCollect(userId, username, categories, att);
    const w = new DxTarGzWriter(destPath);
    try {
        await att.commit(w);
        for (const [name, obj] of Object.entries(docs)) {
            await w.addBuffer(name, Buffer.from(JSON.stringify(obj, null, 2), 'utf8'));
        }
        const manifest = dxManifest(username, categories, source || 'live account', extra);
        await w.addBuffer('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
        await w.addBuffer('README.txt', Buffer.from(dxReadmeText(manifest), 'utf8'));
        await w.finish();
    } catch (e) {
        await w.abort();
        throw e;
    }
}

// Re-packs a deletion archive, keeping only the requested categories.
async function dxFilterArchive(srcFile, categories, destPath, archiveRow) {
    const prefixes = categories.map(k => DATA_EXPORT_CATEGORIES.find(c => c.key === k).dir);
    const w = new DxTarGzWriter(destPath);
    try {
        let found = 0;
        await dxUntarGz(srcFile, async (hdr) => {
            if (hdr.type !== '0' && hdr.type !== '\0') return null;
            const name = hdr.name.replace(/^\.\//, '');
            if (!name || name.startsWith('/') || name.split('/').includes('..')) return null;
            if (!prefixes.some(p => name.startsWith(p))) return null;
            found++;
            await w.begin(name, hdr.size, hdr.mtime);
            return { write: (b) => w.data(b), end: () => w.end() };
        });
        const manifest = dxManifest(archiveRow.username, categories, 'archive of deleted account', {
            account_archived_at: dxIso(archiveRow.created_at), account_deletion_reason: archiveRow.reason || null
        });
        await w.addBuffer('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
        await w.addBuffer('README.txt', Buffer.from(dxReadmeText(manifest), 'utf8'));
        await w.finish();
    } catch (e) {
        await w.abort();
        throw e;
    }
}

// deletion archives

// Writes data/<YYYY-MM-DD>_<username>.tar.gz for the account and records it in Data_Archives.
async function dxArchiveAccount(userId, reason, trigger) {
    const user = await dxGet(`SELECT id, username, email, email_verified, IsDeleted FROM User_Data WHERE id = ?`, [userId]);
    if (!user) throw new Error('user not found');

    // A soft-deleted account was already archived (with its posts) at that point.
    if (user.IsDeleted) {
        const existing = await dxGet(`SELECT * FROM Data_Archives WHERE user_id = ? ORDER BY id DESC LIMIT 1`, [userId]);
        if (existing && fs.existsSync(path.join(DATA_DIR, existing.filename))) return existing;
    }

    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const date = new Date().toISOString().slice(0, 10);
    // Claim a free filename atomically ('wx'); same user + same day can happen if a username is
    // re-registered after a permanent delete.
    let filename = null;
    for (let n = 1; n < 1000 && !filename; n++) {
        const candidate = n === 1 ? `${date}_${user.username}.tar.gz` : `${date}_${user.username}-${n}.tar.gz`;
        try { fs.closeSync(fs.openSync(path.join(DATA_DIR, candidate), 'wx', 0o600)); filename = candidate; }
        catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    if (!filename) throw new Error('could not allocate an archive filename');

    const finalPath = path.join(DATA_DIR, filename);
    const partPath = finalPath + '.part';
    try {
        await dxWriteUserArchive({
            userId: user.id, username: user.username, categories: DATA_EXPORT_CATEGORIES.map(c => c.key),
            destPath: partPath, source: 'deletion archive', extra: { deletion_reason: reason || null, deletion_trigger: trigger || null }
        });
        await fs.promises.rename(partPath, finalPath);
        const ins = await dxRun(`INSERT INTO Data_Archives (user_id, username, email, email_verified, filename, reason, trigger_type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [user.id, user.username, user.email || null, user.email_verified ? 1 : 0, filename, reason || null, trigger || null]);
        logAudit('account_archived', 'System', user.username, filename);
        return await dxGet(`SELECT * FROM Data_Archives WHERE id = ?`, [ins.lastID]);
    } catch (e) {
        await fs.promises.unlink(partPath).catch(() => {});
        await fs.promises.unlink(finalPath).catch(() => {});
        throw e;
    }
}

module.exports = { dxArchiveAccount, dxFilterArchive, dxWriteUserArchive };
