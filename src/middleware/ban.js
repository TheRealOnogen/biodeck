// IP ban and account ban checks.
const { clearExpiredBan } = require('../admin/helpers');
const { dxRequestBlockForUserSync } = require('../data-export/html');
const { db } = require('../db/connection');
const { getWarningsForUser } = require('../moderation');
const { escapeHTML, renderAvatarBlockHTML } = require('../render/html');
const { renderStandingBlockHTML, renderWarningsTableHTML } = require('../render/warnings');
const { getClientIP } = require('../security/ip');

function checkIPBan(req, res, next) {
    const ip = getClientIP(req);
    db.get(`SELECT reason FROM IP_Bans WHERE ip = ?`, [ip], (err, row) => {
        if (err || !row) return next();
        if (req.path.startsWith('/api/')) {
            return res.status(403).json({ error: 'Your IP has been banned.', code: 'ip_banned', reason: row.reason || 'No reason provided' });
        }
        const reason = escapeHTML(row.reason || 'No reason provided');
        return res.status(403).send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Banned</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
</head>
<body>
    <div class="box" style="color: var(--text-color); height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box;">
        <h1>Your IP has been banned</h1><br>
        <h3>Ban Reason: ${reason}</h3><br><br>
        <p style="opacity:0.6;font-size:0.9em;">If you believe this is a mistake, contact an administrator.</p>
    </div>
</body>
</html>`);
    });
}

function checkBan(req, res, next) {
    if (!req.session.userId) return next();

    db.get(`SELECT IsBanned, BanReason, BanExpiresAt, IsDeleted, DeleteReason, IsAdmin, IsOwner, IsHeadAdmin, avatar_path FROM User_Data WHERE id = ?`, [req.session.userId], (err, user) => {
        if (err) return next();
        // No row at all means the account was permanently deleted.
        if (!user) {
            const goneUsername = req.session.userUsername;
            const dataBlockHTML = dxRequestBlockForUserSync(req.session.userId, 'gone');
            getWarningsForUser(goneUsername, (errW, warnings) => {
                const warningsHTML = renderWarningsTableHTML(warnings);
                req.session.destroy(() => {
                    res.clearCookie('connect.sid');
                    return res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Account Deleted</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
<style>
    html, body {
        height: auto !important;
        min-height: 100% !important;
        overflow-y: auto !important;
    }
    body {
        margin: 0 !important;
        display: flex !important;
        align-items: flex-start !important;
        justify-content: center !important;
    }
</style>
</head>
<body>
    <div class="box" style="color: var(--text-color); height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box; margin: 40px auto; overflow-y: visible;">
        ${renderAvatarBlockHTML(null, goneUsername)}
        <h1>Your account has been deleted</h1><br>
        ${renderStandingBlockHTML('Deleted')}
        ${warningsHTML}${dataBlockHTML}<br>
        <button type="submit" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>
    </div>
</body>
</html>`);
                });
            });
            return;
        }
        req.isAdmin = !!(user.IsAdmin || user.IsOwner || user.IsHeadAdmin);
        req.isHeadAdmin = !!(user.IsHeadAdmin || user.IsOwner);
        if (user.IsDeleted == 1) {
            const reason = escapeHTML(user.DeleteReason || 'No reason provided');
            const deletedUsername = req.session.userUsername;
            const deletedAvatarPath = user.avatar_path;
            const dataBlockHTML = dxRequestBlockForUserSync(req.session.userId, 'deleted');
            getWarningsForUser(deletedUsername, (errW, warnings) => {
                const warningsHTML = renderWarningsTableHTML(warnings);
                req.session.destroy(() => {
                    res.clearCookie('connect.sid');
                    return res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Account Deleted</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
<style>
    html, body {
        height: auto !important;
        min-height: 100% !important;
        overflow-y: auto !important;
    }
    body {
        margin: 0 !important;
        display: flex !important;
        align-items: flex-start !important;
        justify-content: center !important;
    }
</style>
</head>
<body>
    <div class="box" style="color: var(--text-color); height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box; margin: 40px auto; overflow-y: visible;">
        ${renderAvatarBlockHTML(deletedAvatarPath, deletedUsername)}
        <h1>Your account has been deleted</h1><br>
        <h3>Reason: ${reason}</h3><br><br>
        ${renderStandingBlockHTML('Deleted')}
        ${warningsHTML}${dataBlockHTML}<br>
        <button type="submit" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>
    </div>
</body>
</html>`);
                });
            });
        } else if (user.IsBanned == 1 && user.BanExpiresAt && new Date(user.BanExpiresAt).getTime() <= Date.now()) {
            // Timed ban has expired - clear it (and email the user) instead of
            // showing a stale ban screen.
            clearExpiredBan(req.session.userId);
            next();
        } else if (user.IsBanned == 1) {
            const reason = escapeHTML(user.BanReason || 'No reason provided');
            const expiryLine = user.BanExpiresAt
                ? `<h3>Ban Expires: ${escapeHTML(new Date(user.BanExpiresAt).toLocaleString())}</h3><br><br>`
                : '';
            const bannedUsername = req.session.userUsername;
            const bannedAvatarPath = user.avatar_path;
            const dataBlockHTML = dxRequestBlockForUserSync(req.session.userId, 'banned');
            getWarningsForUser(bannedUsername, (errW, warnings) => {
                const warningsHTML = renderWarningsTableHTML(warnings);
                req.session.destroy(() => {
                    res.clearCookie('connect.sid');
                    return res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Banned</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
<style>
    html, body {
        height: auto !important;
        min-height: 100% !important;
        overflow-y: auto !important;
    }
    body {
        margin: 0 !important;
        display: flex !important;
        align-items: flex-start !important;
        justify-content: center !important;
    }
</style>
</head>
<body>
    <div class="box" style="color: var(--text-color); height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box; margin: 40px auto; overflow-y: visible;">
        ${renderAvatarBlockHTML(bannedAvatarPath, bannedUsername)}
        <h1>The ban hammer has struck you</h1><br>
        <h3>Ban Reason: ${reason}</h3><br><br>
        ${expiryLine}
        ${renderStandingBlockHTML('Banned')}
        ${warningsHTML}${dataBlockHTML}<br>
        <button type="submit" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>
    </div>
</body>
</html>`);
                });
            });
        } else {
            next();
        }
    });
}

module.exports = { checkBan, checkIPBan };
