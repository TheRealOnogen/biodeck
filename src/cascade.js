// Reply cascade deletion.
const { db } = require('./db/connection');
const { cleanupAttachmentFiles, getAttachments } = require('./uploads/files');

// Cascade deletion of replies
// Replies are rows in Posts whose reply_to points at their parent.
const CASCADE_DELETE_REPLIES_ON_ACCOUNT_DELETE = true;

function runInIdChunks(sqlWithIdsToken, ids, done) {
    const parts = [];
    for (let i = 0; i < ids.length; i += 400) parts.push(ids.slice(i, i + 400));
    let changes = 0;
    const step = () => {
        const part = parts.shift();
        if (!part) return done(null, changes);
        db.run(sqlWithIdsToken.replace('%IDS%', part.map(() => '?').join(',')), part, function (err) {
            if (err) return done(err, changes);
            changes += this.changes || 0;
            step();
        });
    };
    step();
}

function deletePostDescendants(rootIds, callback) {
    const ids = (Array.isArray(rootIds) ? rootIds : [rootIds]).map(n => parseInt(n, 10)).filter(Number.isInteger);
    let total = 0;
    const finish = (err) => { if (callback) callback(err || null, total); };
    if (!ids.length) return finish(null);
    const chunks = [];
    for (let i = 0; i < ids.length; i += 400) chunks.push(ids.slice(i, i + 400));

    const nextChunk = () => {
        const chunk = chunks.shift();
        if (!chunk) return finish(null);
        const ph = chunk.map(() => '?').join(',');
        db.all(
            `WITH RECURSIVE tree(id) AS (
                SELECT id FROM Posts WHERE reply_to IN (${ph})
                UNION
                SELECT p.id FROM Posts p JOIN tree t ON p.reply_to = t.id
             )
             SELECT id, file_path, file_name, files_json FROM Posts WHERE id IN (SELECT id FROM tree)`,
            chunk,
            (err, rows) => {
                if (err) { console.error('Reply tree lookup error:', err.message); return finish(err); }
                if (!rows || !rows.length) return nextChunk();
                const replyIds = rows.map(r => r.id);
                const attachments = rows.reduce((acc, r) => acc.concat(getAttachments(r)), []);
                runInIdChunks(`DELETE FROM Reactions WHERE post_id IN (%IDS%)`, replyIds, (e1) => {
                    if (e1) console.error('Reply reactions delete error:', e1.message);
                    runInIdChunks(`DELETE FROM Notifications WHERE post_id IN (%IDS%)`, replyIds, (e2) => {
                        if (e2) console.error('Reply notifications delete error:', e2.message);
                        runInIdChunks(`DELETE FROM Posts WHERE id IN (%IDS%)`, replyIds, (e3, n) => {
                            if (e3) { console.error('Reply delete error:', e3.message); return finish(e3); }
                            total += n;
                            cleanupAttachmentFiles(attachments);
                            nextChunk();
                        });
                    });
                });
            }
        );
    };
    nextChunk();
}

module.exports = { CASCADE_DELETE_REPLIES_ON_ACCOUNT_DELETE, deletePostDescendants, runInIdChunks };
