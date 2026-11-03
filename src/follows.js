// Follow list helper.
const { db } = require('./db/connection');

function getFollowingList(username, cb) {
    db.all(`SELECT following_username FROM Follows WHERE follower_username = ?`, [username], (err, rows) => {
        if (err || !rows) return cb([username]);
        const list = rows.map(r => r.following_username);
        list.push(username);
        cb(list);
    });
}

module.exports = { getFollowingList };
