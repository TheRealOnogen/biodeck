// JSON API under /api/v1.
const { parseReactionEmojiJSON, toggleReactionJSON } = require('../api/reactions');
const {
    clampLimit,
    fetchPostsJSON,
    fetchReactionsJSON,
    requireApiAuth,
    serializeGroupMessageJSON,
    serializeMessageJSON,
    serializeNotificationJSON,
    serializePostJSON,
    toISO,
} = require('../api/serializers');
const { app } = require('../app');
const { MAX_DISTINCT_REACTIONS_PER_MESSAGE, MAX_DISTINCT_REACTIONS_PER_POST } = require('../config');
const { db } = require('../db/connection');
const { getFollowingList } = require('../follows');
const { broadcastDMReaction, broadcastGCReaction } = require('../live/events');
const { isUserMuted } = require('../moderation');
const { avatarPathToURL, displayName } = require('../render/html');

// Current user / profiles

app.get('/api/v1/me', requireApiAuth, (req, res) => {
    db.get(`SELECT username, Nickname, bio, email, email_verified, IsOwner, IsDeveloper, IsSupporter,
            IsAdmin, IsHeadAdmin, IsVerified, avatar_path, theme FROM User_Data WHERE id = ?`,
        [req.session.userId], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'User not found' });
        res.json({
            username: user.username,
            nickname: user.Nickname || null,
            displayName: displayName(user.username, user.Nickname),
            bio: user.bio || null,
            email: user.email || null,
            emailVerified: !!user.email_verified,
            avatarUrl: user.avatar_path ? avatarPathToURL(user.avatar_path) : null,
            verified: !!user.IsVerified,
            admin: !!(user.IsAdmin || user.IsOwner || user.IsHeadAdmin),
            owner: !!user.IsOwner,
            developer: !!user.IsDeveloper,
            supporter: !!user.IsSupporter,
            theme: user.theme || 'default'
        });
    });
});

app.get('/api/v1/users/:username', requireApiAuth, (req, res) => {
    const profileUsername = req.params.username;
    const sessionUsername = req.session.userUsername;
    db.get(`SELECT username, Nickname, bio, IsVerified, IsAdmin, IsOwner, IsHeadAdmin, IsBanned, IsDeleted, avatar_path
            FROM User_Data WHERE username = ?`, [profileUsername], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'User not found' });
        db.get(`SELECT COUNT(*) as cnt FROM Follows WHERE following_username = ?`, [profileUsername], (e1, followerCount) => {
            db.get(`SELECT id FROM Follows WHERE follower_username = ? AND following_username = ?`,
                [sessionUsername, profileUsername], (e2, followRow) => {
                const a = [sessionUsername, profileUsername].sort()[0];
                const b = [sessionUsername, profileUsername].sort()[1];
                db.get(`SELECT id FROM Friends WHERE user_a = ? AND user_b = ?`, [a, b], (e3, friendRow) => {
                    res.json({
                        username: user.username,
                        nickname: user.Nickname || null,
                        displayName: displayName(user.username, user.Nickname),
                        bio: user.bio || null,
                        avatarUrl: user.avatar_path ? avatarPathToURL(user.avatar_path) : null,
                        verified: !!user.IsVerified,
                        admin: !!(user.IsAdmin || user.IsOwner || user.IsHeadAdmin),
                        banned: !!user.IsBanned,
                        deleted: !!user.IsDeleted,
                        isSelf: profileUsername === sessionUsername,
                        followerCount: (followerCount && followerCount.cnt) || 0,
                        viewerIsFollowing: !!followRow,
                        viewerIsFriend: !!friendRow
                    });
                });
            });
        });
    });
});

// Feed

app.get('/api/v1/feed', requireApiAuth, (req, res) => {
    const limit = clampLimit(req.query.limit, 20, 50);
    const before = parseInt(req.query.before) || 0;
    const after = parseInt(req.query.after) || 0;
    const where = before ? 'WHERE Posts.id < ?' : (after ? 'WHERE Posts.id > ?' : '');
    const params = before ? [before] : (after ? [after] : []);
    fetchPostsJSON(where, params, limit, (err, posts) => {
        if (err) return res.status(500).json({ error: 'db error' });
        const roots = posts.filter(p => !p.reply_to);
        const reactionMap = fetchReactionsJSON('post', roots.map(p => p.id), req.session.userUsername);
        res.json({
            posts: roots.map(p => serializePostJSON(p, req.session.userUsername, req.isAdmin, reactionMap.get(p.id))),
            hasMore: posts.length === limit
        });
    });
});

app.get('/api/v1/following-feed', requireApiAuth, (req, res) => {
    const me = req.session.userUsername;
    const limit = clampLimit(req.query.limit, 20, 50);
    const before = parseInt(req.query.before) || 0;
    getFollowingList(me, (followingList) => {
        const placeholders = followingList.map(() => '?').join(',');
        const where = `WHERE Posts.username IN (${placeholders})` + (before ? ' AND Posts.id < ?' : '');
        const params = before ? [...followingList, before] : followingList;
        fetchPostsJSON(where, params, limit, (err, posts) => {
            if (err) return res.status(500).json({ error: 'db error' });
            const roots = posts.filter(p => !p.reply_to);
            const reactionMap = fetchReactionsJSON('post', roots.map(p => p.id), me);
            res.json({
                posts: roots.map(p => serializePostJSON(p, me, req.isAdmin, reactionMap.get(p.id))),
                hasMore: posts.length === limit
            });
        });
    });
});

// Single post / thread

app.get('/api/v1/post/:id', requireApiAuth, (req, res) => {
    const postId = parseInt(req.params.id);
    if (!postId) return res.status(404).json({ error: 'Post not found' });
    db.get(`SELECT Posts.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified,
            (WITH RECURSIVE descendants(id) AS (SELECT id FROM Posts AS r WHERE r.reply_to = Posts.id UNION ALL SELECT p.id FROM Posts p JOIN descendants d ON p.reply_to = d.id) SELECT COUNT(*) FROM descendants) AS reply_count
            FROM Posts LEFT JOIN User_Data ON Posts.username = User_Data.username WHERE Posts.id = ?`,
        [postId], (err, post) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!post) return res.status(404).json({ error: 'Post not found' });
        const reactionMap = fetchReactionsJSON('post', [post.id], req.session.userUsername);
        res.json({ post: serializePostJSON(post, req.session.userUsername, req.isAdmin, reactionMap.get(post.id)) });
    });
});

app.get('/api/v1/post/:id/replies', requireApiAuth, (req, res) => {
    const postId = parseInt(req.params.id);
    if (!postId) return res.status(404).json({ error: 'Post not found' });
    const limit = clampLimit(req.query.limit, 20, 50);
    const before = parseInt(req.query.before) || 0;
    const where = 'WHERE Posts.reply_to = ?' + (before ? ' AND Posts.id < ?' : '');
    const params = before ? [postId, before] : [postId];
    fetchPostsJSON(where, params, limit, (err, replies) => {
        if (err) return res.status(500).json({ error: 'db error' });
        const reactionMap = fetchReactionsJSON('post', replies.map(p => p.id), req.session.userUsername);
        res.json({
            replies: replies.map(p => serializePostJSON(p, req.session.userUsername, req.isAdmin, reactionMap.get(p.id))),
            hasMore: replies.length === limit
        });
    });
});

// Direct messages

app.get('/api/v1/messages', requireApiAuth, (req, res) => {
    const me = req.session.userUsername;
    db.all(`SELECT DISTINCT CASE WHEN from_user = ? THEN to_user ELSE from_user END as other_user,
            MAX(created_at) as last_at
            FROM Messages WHERE from_user = ? OR to_user = ?
            GROUP BY other_user ORDER BY last_at DESC`, [me, me, me], (err, convos) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({
            conversations: (convos || []).map(c => ({
                username: c.other_user,
                lastMessageAt: toISO(c.last_at)
            }))
        });
    });
});

app.get('/api/v1/messages/:username', requireApiAuth, (req, res) => {
    const me = req.session.userUsername;
    const other = req.params.username;
    const limit = clampLimit(req.query.limit, 50, 100);
    const before = parseInt(req.query.before) || 0;
    const where = before ? 'AND Messages.id < ?' : '';
    const params = before ? [me, other, other, me, before] : [me, other, other, me];
    db.all(`SELECT Messages.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified
            FROM Messages LEFT JOIN User_Data ON Messages.from_user = User_Data.username
            WHERE ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)) ${where}
            ORDER BY Messages.id DESC LIMIT ?`, [...params, limit], (err, msgs) => {
        if (err) return res.status(500).json({ error: 'db error' });
        const ordered = (msgs || []).slice().reverse();
        const reactionMap = fetchReactionsJSON('dm', ordered.map(m => m.id), me);
        res.json({
            messages: ordered.map(m => serializeMessageJSON(m, me, reactionMap.get(m.id))),
            hasMore: msgs.length === limit
        });
    });
});

app.post('/api/v1/messages/:username/mark-read', requireApiAuth, (req, res) => {
    const me = req.session.userUsername;
    const other = req.params.username;
    db.run(`UPDATE Messages SET read = 1 WHERE to_user = ? AND from_user = ?`, [me, other], (err) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({ ok: true });
    });
});

// Group chats

app.get('/api/v1/groups', requireApiAuth, (req, res) => {
    const me = req.session.userUsername;
    db.all(`SELECT Group_Chats.* FROM Group_Chats
            WHERE Group_Chats.id IN (SELECT group_id FROM Group_Chat_Members WHERE username = ?)
            ORDER BY Group_Chats.created_at DESC`, [me], (err, groups) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!groups || !groups.length) return res.json({ groups: [] });
        // One query for every member of every one of these groups, instead of a separate members
        // query per group (was N+1 for N groups).
        const ids = groups.map(g => g.id);
        const placeholders = ids.map(() => '?').join(',');
        db.all(`SELECT group_id, username FROM Group_Chat_Members WHERE group_id IN (${placeholders}) ORDER BY joined_at ASC`,
            ids, (e2, allMembers) => {
            if (e2) return res.status(500).json({ error: 'db error' });
            const membersByGroup = new Map();
            (allMembers || []).forEach(m => {
                if (!membersByGroup.has(m.group_id)) membersByGroup.set(m.group_id, []);
                membersByGroup.get(m.group_id).push(m.username);
            });
            res.json({
                groups: groups.map(g => ({
                    id: g.id,
                    name: g.name,
                    createdBy: g.created_by,
                    createdAt: toISO(g.created_at),
                    isPublic: !!g.is_public,
                    members: membersByGroup.get(g.id) || []
                }))
            });
        });
    });
});

app.get('/api/v1/groups/public', requireApiAuth, (req, res) => {
    const me = req.session.userUsername;
    db.all(`SELECT Group_Chats.*, COUNT(Group_Chat_Members.id) AS member_count,
                   SUM(CASE WHEN Group_Chat_Members.username = ? THEN 1 ELSE 0 END) AS is_member
            FROM Group_Chats
            LEFT JOIN Group_Chat_Members ON Group_Chats.id = Group_Chat_Members.group_id
            WHERE Group_Chats.is_public = 1
            GROUP BY Group_Chats.id
            ORDER BY Group_Chats.created_at DESC`, [me], (err, groups) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({
            groups: (groups || []).map(g => ({
                id: g.id,
                name: g.name,
                createdBy: g.created_by,
                createdAt: toISO(g.created_at),
                memberCount: g.member_count,
                viewerIsMember: !!g.is_member
            }))
        });
    });
});

app.get('/api/v1/groups/:id/messages', requireApiAuth, (req, res) => {
    const me = req.session.userUsername;
    const groupId = parseInt(req.params.id);
    if (!groupId) return res.status(404).json({ error: 'Group not found' });
    db.get(`SELECT id FROM Group_Chat_Members WHERE group_id = ? AND username = ?`, [groupId, me], (mErr, memberRow) => {
        if (!memberRow) return res.status(403).json({ error: 'Not a member of this group' });
        const limit = clampLimit(req.query.limit, 50, 100);
        const before = parseInt(req.query.before) || 0;
        const where = before ? 'AND Group_Chat_Messages.id < ?' : '';
        const params = before ? [groupId, before] : [groupId];
        db.all(`SELECT Group_Chat_Messages.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified
                FROM Group_Chat_Messages LEFT JOIN User_Data ON Group_Chat_Messages.from_user = User_Data.username
                WHERE Group_Chat_Messages.group_id = ? ${where}
                ORDER BY Group_Chat_Messages.id DESC LIMIT ?`, [...params, limit], (err, msgs) => {
            if (err) return res.status(500).json({ error: 'db error' });
            const ordered = (msgs || []).slice().reverse();
            const reactionMap = fetchReactionsJSON('gc', ordered.map(m => m.id), me);
            res.json({
                messages: ordered.map(m => serializeGroupMessageJSON(m, me, reactionMap.get(m.id))),
                hasMore: msgs.length === limit
            });
        });
    });
});

app.post('/api/v1/post/:id/react', requireApiAuth, (req, res) => {
    const me = req.session.userUsername;
    const postId = parseInt(req.params.id, 10);
    if (!Number.isInteger(postId)) return res.status(404).json({ error: 'Post not found' });
    const parsed = parseReactionEmojiJSON(req.body);
    if (parsed.error) return res.status(parsed.status).json({ error: parsed.error });
    isUserMuted(me, (errMute, mute) => {
        if (!errMute && mute) return res.status(403).json({ error: 'Muted users cannot react to posts' });
        db.get(`SELECT id FROM Posts WHERE id = ?`, [postId], (err, post) => {
            if (err) return res.status(500).json({ error: 'db error' });
            if (!post) return res.status(404).json({ error: 'Post not found' });
            const result = toggleReactionJSON('post', postId, me, parsed.emoji, MAX_DISTINCT_REACTIONS_PER_POST);
            if (result.error) return res.status(result.status).json({ error: result.error });
            res.json({ ok: true, added: result.added, reactions: result.reactions });
        });
    });
});

app.post('/api/v1/messages/:username/react/:id', requireApiAuth, (req, res) => {
    const me = req.session.userUsername;
    const other = req.params.username;
    const msgId = parseInt(req.params.id, 10);
    if (!Number.isInteger(msgId)) return res.status(404).json({ error: 'Message not found' });
    const parsed = parseReactionEmojiJSON(req.body);
    if (parsed.error) return res.status(parsed.status).json({ error: parsed.error });
    db.get(`SELECT id, from_user, to_user FROM Messages WHERE id = ?`, [msgId], (err, msg) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!msg) return res.status(404).json({ error: 'Message not found' });
        const participants = [msg.from_user, msg.to_user];
        if (me === other || !participants.includes(me) || !participants.includes(other)) {
            return res.status(403).json({ error: 'Not part of this conversation' });
        }
        const result = toggleReactionJSON('dm', msgId, me, parsed.emoji, MAX_DISTINCT_REACTIONS_PER_MESSAGE);
        if (result.error) return res.status(result.status).json({ error: result.error });
        broadcastDMReaction(msg.from_user, msg.to_user, msgId);
        res.json({ ok: true, added: result.added, reactions: result.reactions });
    });
});

app.post('/api/v1/groups/:id/react/:msgId', requireApiAuth, (req, res) => {
    const me = req.session.userUsername;
    const groupId = parseInt(req.params.id, 10);
    const msgId = parseInt(req.params.msgId, 10);
    if (!Number.isInteger(groupId)) return res.status(404).json({ error: 'Group not found' });
    if (!Number.isInteger(msgId)) return res.status(404).json({ error: 'Message not found' });
    const parsed = parseReactionEmojiJSON(req.body);
    if (parsed.error) return res.status(parsed.status).json({ error: parsed.error });
    db.get(`SELECT id FROM Group_Chat_Members WHERE group_id = ? AND username = ?`, [groupId, me], (errMem, memberRow) => {
        if (errMem) return res.status(500).json({ error: 'db error' });
        if (!memberRow) return res.status(403).json({ error: 'Not a member of this group' });
        db.get(`SELECT id FROM Group_Chat_Messages WHERE id = ? AND group_id = ?`, [msgId, groupId], (err, msg) => {
            if (err) return res.status(500).json({ error: 'db error' });
            if (!msg) return res.status(404).json({ error: 'Message not found' });
            const result = toggleReactionJSON('gc', msgId, me, parsed.emoji, MAX_DISTINCT_REACTIONS_PER_MESSAGE);
            if (result.error) return res.status(result.status).json({ error: result.error });
            db.all(`SELECT username FROM Group_Chat_Members WHERE group_id = ?`, [groupId], (errMembers, memberRows) => {
                broadcastGCReaction(groupId, msgId, (memberRows || []).map(r => r.username));
                res.json({ ok: true, added: result.added, reactions: result.reactions });
            });
        });
    });
});

// Notifications

app.get('/api/v1/notifications', requireApiAuth, (req, res) => {
    const me = req.session.userUsername;
    const limit = clampLimit(req.query.limit, 50, 100);
    const before = parseInt(req.query.before) || 0;
    const where = before ? 'AND Notifications.id < ?' : '';
    const params = before ? [me, before] : [me];
    db.all(`SELECT Notifications.*, User_Data.Nickname AS actor_nickname, User_Data.IsVerified AS actor_verified
            FROM Notifications LEFT JOIN User_Data ON Notifications.actor_username = User_Data.username
            WHERE Notifications.username = ? ${where}
            ORDER BY Notifications.id DESC LIMIT ?`, [...params, limit], (err, notifs) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({
            notifications: (notifs || []).map(serializeNotificationJSON),
            hasMore: (notifs || []).length === limit
        });
        // Note: unlike GET /notifications (the HTML page), this does NOT mark notifications as read
        // as a side effect.
    });
});
