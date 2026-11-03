// Reaction helpers for /api/v1.
const { REACTION_TABLES, fetchReactionsJSON } = require('./serializers');
const { MAX_REACTION_EMOJI_LENGTH } = require('../config');
const { sqliteDb } = require('../db/connection');

// Reactions (write)
// JSON twins of POST /post/:id/react, /messages/:username/react/:id and /groups/:id/react/:msgId.

// Returns { emoji } on success or { status, error } on a validation failure.
function parseReactionEmojiJSON(body) {
    const emoji = ((body && body.emoji) || '').toString().trim();
    if (!emoji) return { status: 400, error: 'Pick an emoji first' };
    if (/[\r\n\t]/.test(emoji)) return { status: 400, error: 'Reactions must be a single emoji, not text' };
    if (emoji.length > MAX_REACTION_EMOJI_LENGTH) return { status: 400, error: `Reaction too long - ${MAX_REACTION_EMOJI_LENGTH} character limit` };
    return { emoji };
}

// Toggles (me, emoji) on one item.
function toggleReactionJSON(kind, itemId, me, emoji, maxDistinct) {
    const { table, idCol } = REACTION_TABLES[kind];
    try {
        const existing = sqliteDb.prepare(`SELECT id FROM ${table} WHERE ${idCol} = ? AND username = ? AND emoji = ?`).get(itemId, me, emoji);
        let added;
        if (existing) {
            sqliteDb.prepare(`DELETE FROM ${table} WHERE id = ?`).run(existing.id);
            added = false;
        } else {
            const cnt = sqliteDb.prepare(`SELECT COUNT(DISTINCT emoji) AS n FROM ${table} WHERE ${idCol} = ?`).get(itemId);
            if (cnt && cnt.n >= maxDistinct) return { status: 400, error: 'This item already has the maximum number of different reactions' };
            sqliteDb.prepare(`INSERT INTO ${table} (${idCol}, username, emoji) VALUES (?, ?, ?)`).run(itemId, me, emoji);
            added = true;
        }
        return { added, reactions: fetchReactionsJSON(kind, [itemId], me).get(itemId) || [] };
    } catch (e) {
        console.error('toggleReactionJSON error:', e.message);
        return { status: 500, error: 'db error' };
    }
}

module.exports = { parseReactionEmojiJSON, toggleReactionJSON };
