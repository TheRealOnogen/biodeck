// Blocking.
const { app } = require('../app');
const { db, getStmt } = require('../db/connection');
const { blockExists } = require('../social');

// Blocking routes
const MAX_BLOCKS_PER_USER = 500;

app.post('/block/:username', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const me = req.session.userUsername;
    const target = req.params.username;
    if (me === target) return res.status(400).json({ error: "You can't block yourself." });
    db.get(`SELECT username FROM User_Data WHERE username = ?`, [target], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'User not found.' });
        const other = user.username;
        if (!blockExists(me, other)) {
            const row = getStmt(`SELECT COUNT(*) AS c FROM User_Blocks WHERE blocker = ?`).get(me);
            if (row && row.c >= MAX_BLOCKS_PER_USER) return res.status(400).json({ error: `You can block at most ${MAX_BLOCKS_PER_USER} people.` });
        }
        db.run(`INSERT OR IGNORE INTO User_Blocks (blocker, blocked) VALUES (?, ?)`, [me, other], (err2) => {
            if (err2) return res.status(500).json({ error: 'db error' });
            // Blocking also severs existing ties in both directions.
            const a = [me, other].sort()[0], b = [me, other].sort()[1];
            db.run(`DELETE FROM Follows WHERE (follower_username = ? AND following_username = ?) OR (follower_username = ? AND following_username = ?)`, [me, other, other, me]);
            db.run(`DELETE FROM Friends WHERE user_a = ? AND user_b = ?`, [a, b]);
            db.run(`DELETE FROM Friend_Requests WHERE status = 'pending' AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))`, [me, other, other, me]);
            res.json({ ok: true, blocked: true });
        });
    });
});

app.post('/unblock/:username', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    db.run(`DELETE FROM User_Blocks WHERE blocker = ? AND blocked = ?`, [req.session.userUsername, req.params.username], (err) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({ ok: true, blocked: false });
    });
});

app.get('/api/my-blocks', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    db.all(`SELECT blocked FROM User_Blocks WHERE blocker = ? ORDER BY created_at DESC`, [req.session.userUsername], (err, rows) => {
        if (err) return res.status(500).json({ error: 'db error' });
        res.json({ blocks: (rows || []).map(r => r.blocked) });
    });
});
