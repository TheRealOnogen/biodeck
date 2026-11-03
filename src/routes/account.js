// Account settings: data export, deletion, profile edits, email change.
const path = require('path');
const bcrypt = require('bcrypt');
const fs = require('fs');
const rateLimitForAuth = require('express-rate-limit');
const { allowNoArchive, hardDeleteAccountEx } = require('../accounts/delete');
const { app } = require('../app');
const { MAX_BIO_LENGTH } = require('../config');
const {
    DATA_DIR,
    DATA_EXPORT_CATEGORIES,
    DATA_EXPORT_COOKIE,
    DATA_EXPORT_COOLDOWN_DAYS,
    DATA_EXPORT_COOLDOWN_MS,
    DATA_EXPORT_MAX_PER_DAY,
    DATA_EXPORT_MAX_TOTAL_BYTES,
    DATA_EXPORT_TOKEN_TTL_MS,
    DATA_EXPORT_UNLIMITED,
    dxAll,
    dxExportsDirBytes,
    dxGet,
    dxIso,
    dxLastCountedRequest,
    dxMaskEmail,
    dxNextAllowedAt,
    dxRun,
    dxWindowParam,
    parseExportCategories,
} = require('../data-export/core');
const { renderDataRequestBlockHTML } = require('../data-export/html');
const { dxReadCookie, dxResolveSubject, dxSubjectToken, dxVerifyToken } = require('../data-export/token');
const { dxKickQueue } = require('../data-export/worker');
const { db, getStmt } = require('../db/connection');
const {
    EMAIL_CHANGE_CODE_TTL_MS,
    EMAIL_REGEX,
    generateEmailChangeCode,
    hashEmailChangeCode,
    mailTransporter,
    sendEmailChangeCodeEmail,
} = require('../mail');
const { requireVerifiedForUpload } = require('../middleware/email-verified');
const { logAudit } = require('../moderation');
const { MAX_NICKNAME_LENGTH } = require('../render/html');
const { renderMessagePage } = require('../render/pages');
const { validateEmailForUse } = require('../security/email-validation');
const { getClientIP } = require('../security/ip');
const { loadThemes } = require('../themes');
const { avatarUpload, compressAvatar, deleteOldAvatarFile } = require('../uploads/avatars');

app.post('/account/data-export', async (req, res) => {
    try {
        const subject = dxResolveSubject(req);
        if (!subject) return res.status(401).json({ error: 'This request has expired. Please reload the page (or log in again) and try once more.' });
        const categories = parseExportCategories(req.body && req.body.categories);
        if (!categories.length) return res.status(400).json({ error: 'Choose at least one thing to include.' });
        if (!mailTransporter) return res.status(503).json({ error: 'Email isn\'t set up on this server right now, so data requests can\'t be sent. Please contact support.' });

        let username, email, verified;
        if (subject.type === 'user') {
            const u = await dxGet(`SELECT username, email, email_verified FROM User_Data WHERE id = ?`, [subject.id]);
            if (!u) return res.status(404).json({ error: 'This account no longer exists.' });
            ({ username, email, email_verified: verified } = u);
        } else {
            const a = await dxGet(`SELECT username, email, email_verified, filename FROM Data_Archives WHERE id = ?`, [subject.id]);
            if (!a || !fs.existsSync(path.join(DATA_DIR, a.filename))) return res.status(404).json({ error: 'The saved copy of this account is no longer available.' });
            ({ username, email, email_verified: verified } = a);
        }
        if (!email) return res.status(400).json({ error: 'There is no email address on file for this account.' });
        if (!verified) return res.status(400).json({ error: 'The email address on this account isn\'t verified, so we can\'t send your data there.' });

        const busy = await dxGet(`SELECT COUNT(*) AS c FROM Data_Export_Requests WHERE subject_type = ? AND subject_id = ? AND status IN ('pending', 'processing')`, [subject.type, subject.id]);
        if (busy.c > 0) return res.status(429).json({ error: 'A previous request is still being prepared. Please wait for it to arrive first.' });
        const refuseCooldown = (lastCreatedAt) => {
            const next = dxNextAllowedAt(lastCreatedAt) || new Date(Date.now() + DATA_EXPORT_COOLDOWN_MS);
            res.set('Retry-After', String(Math.max(1, Math.ceil((next.getTime() - Date.now()) / 1000))));
            return res.status(429).json({
                error: `You can request your data once every ${DATA_EXPORT_COOLDOWN_DAYS} days. You can request it again on ${next.toUTCString()}.`,
                code: 'export_cooldown', nextRequestAt: next.toISOString()
            });
        };
        const last = await dxLastCountedRequest(subject, email);
        if (last) return refuseCooldown(last);

        const recent = await dxGet(`SELECT COUNT(*) AS c FROM Data_Export_Requests WHERE subject_type = ? AND subject_id = ? AND created_at > datetime('now', '-1 day')`, [subject.type, subject.id]);
        if (recent.c >= DATA_EXPORT_MAX_PER_DAY) return res.status(429).json({ error: `You can try to request your data up to ${DATA_EXPORT_MAX_PER_DAY} times per day. Please try again later.` });

        if (!DATA_EXPORT_UNLIMITED && dxExportsDirBytes() >= DATA_EXPORT_MAX_TOTAL_BYTES) {
            console.warn('Data export refused: exports folder is at its size cap (DATA_EXPORT_MAX_TOTAL_MB).');
            return res.status(503).json({ error: 'Data exports are temporarily unavailable. Please try again later.', code: 'export_storage_full' });
        }

        // Check-and-insert in ONE statement.
        const ins = await dxRun(`INSERT INTO Data_Export_Requests (subject_type, subject_id, username, email, categories)
            SELECT ?, ?, ?, ?, ?
            WHERE NOT EXISTS (
                SELECT 1 FROM Data_Export_Requests
                WHERE status != 'failed' AND created_at > datetime('now', ?)
                AND ((subject_type = ? AND subject_id = ?) OR lower(email) = lower(?))
            )`,
            [subject.type, subject.id, username, email, categories.join(','), dxWindowParam(), subject.type, subject.id, email]);
        if (!ins.changes) return refuseCooldown(await dxLastCountedRequest(subject, email));
        logAudit('data_export_requested', username, username, categories.join(','));
        dxKickQueue();
        res.json({ ok: true, id: ins.lastID, sentTo: dxMaskEmail(email) });
    } catch (e) {
        console.error('Data export request error:', e.message);
        res.status(500).json({ error: 'Something went wrong. Please try again later.' });
    }
});

// Recent requests for the dashboard (logged-in users only).
app.get('/account/data-export/requests', async (req, res) => {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: 'not logged in' });
    try {
        const rows = await dxAll(`SELECT id, categories, status, delivery, error, created_at, completed_at FROM Data_Export_Requests
            WHERE subject_type = 'user' AND subject_id = ? ORDER BY id DESC LIMIT 5`, [req.session.userId]);
        const me = await dxGet(`SELECT email FROM User_Data WHERE id = ?`, [req.session.userId]);
        const last = await dxLastCountedRequest({ type: 'user', id: req.session.userId }, me && me.email);
        const next = dxNextAllowedAt(last);
        res.json({
            cooldownDays: DATA_EXPORT_COOLDOWN_DAYS,
            nextRequestAt: next ? next.toISOString() : null,
            requests: rows.map(r => ({
                id: r.id,
                categories: r.categories.split(',').map(k => (DATA_EXPORT_CATEGORIES.find(c => c.key === k) || { label: k }).label),
                status: r.status, delivery: r.delivery, error: r.error,
                createdAt: dxIso(r.created_at), completedAt: dxIso(r.completed_at)
            }))
        });
    } catch (e) {
        res.status(500).json({ error: 'db error' });
    }
});

// Landing page after deleting your own account.
app.get('/account/deleted', (req, res) => {
    const p = dxVerifyToken(dxReadCookie(req, DATA_EXPORT_COOKIE));
    const archive = p && p.t === 'archive' ? getStmt(`SELECT id, email, email_verified FROM Data_Archives WHERE id = ?`).get(p.id) : null;
    if (!archive) return res.redirect('/');
    const block = archive.email && archive.email_verified
        ? renderDataRequestBlockHTML(dxSubjectToken('archive', archive.id), archive.email)
        : '';
    res.send(renderMessagePage('Account Deleted', 'Your account has been deleted',
        `<h3>Your posts, DMs and the rest of your account data have been removed from Biodeck.</h3>
        <p style="opacity:0.7;font-size:0.9em;">A copy was saved when you deleted your account. You can have it emailed to you below.</p>
        ${block}<br>
        <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>`));
});

// Self-service, permanent account deletion.
app.post('/account/delete-self', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'not logged in' });
    const password = (req.body && req.body.password) || '';
    if (!password) return res.status(400).json({ error: 'password is required' });
    const userId = req.session.userId;
    const username = req.session.userUsername;
    db.get(`SELECT password FROM User_Data WHERE id = ?`, [userId], async (err, user) => {
        if (err || !user) return res.status(500).json({ error: 'db error' });
        let match = false;
        try {
            match = await bcrypt.compare(password, user.password);
        } catch (e) {
            return res.status(500).json({ error: 'auth error' });
        }
        if (!match) return res.status(401).json({ error: 'incorrect password' });
        hardDeleteAccountEx(username, 'You deleted your own account', { allowWithoutArchive: allowNoArchive(req) }, (err2, archive) => {
            if (err2) {
                console.error('Self-delete error:', err2.message);
                if (err2.message === 'archive failed') {
                    return res.status(500).json({ code: 'archive_failed', error: 'could not save a copy of your data, so your account was NOT deleted. You can try again later, or choose to delete it without a saved copy.' });
                }
                return res.status(500).json({ error: 'db error' });
            }
            logAudit('account_self_deleted', username, username, 'user deleted their own account');
            const secure = !!req.secure;
            req.session.destroy(() => {
                // The session is gone, so hand the browser a short-lived signed token (cookie) that
                // lets /account/deleted offer "email me my data".
                let redirect = '/';
                if (archive && archive.id) {
                    res.cookie(DATA_EXPORT_COOKIE, dxSubjectToken('archive', archive.id), {
                        httpOnly: true, sameSite: 'lax', secure, maxAge: DATA_EXPORT_TOKEN_TTL_MS, path: '/'
                    });
                    redirect = '/account/deleted';
                }
                res.json({ ok: true, deleted: true, redirect });
            });
        });
    });
});

app.post('/edit/nickname', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    let { nickname } = req.body;
    nickname = (nickname || '').trim();
    if (nickname.length > MAX_NICKNAME_LENGTH) return res.redirect('/edit?nicknameerror=1');
    db.run(`UPDATE User_Data SET Nickname = ? WHERE id = ?`, [nickname || null, req.session.userId], () => res.redirect('/edit'));
});

app.post('/edit/bio', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const { bio } = req.body;
    if (bio && bio.length > MAX_BIO_LENGTH) return res.redirect('/edit?bioerror=1');
    db.run(`UPDATE User_Data SET bio = ? WHERE id = ?`, [bio || '', req.session.userId], () => res.redirect('/edit'));
});

// 5 avatar changes per 10 minutes per account - each one costs a decode + resize.
const avatarChangeLimiter = rateLimitForAuth({
    windowMs: 10 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.session && req.session.userId) ? 'u' + req.session.userId : 'ip' + getClientIP(req),
    handler: (req, res) => res.redirect('/edit?avatarerror=1')
});

app.post('/edit/avatar', requireVerifiedForUpload, avatarChangeLimiter, (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    avatarUpload.single('avatar')(req, res, async (err) => {
        if (err || !req.file) {
            if (req.file) fs.unlink(req.file.path, () => {});
            return res.redirect('/edit?avatarerror=1');
        }
        const userId = req.session.userId;
        let newPath;
        try {
            newPath = await compressAvatar(req.file.path, userId);
        } catch (e) {
            if (e.message !== 'busy') console.warn('Avatar rejected for user', userId + ':', e.message);
            return res.redirect('/edit?avatarerror=1');
        }
        db.get(`SELECT avatar_path FROM User_Data WHERE id = ?`, [userId], (e1, row) => {
            const oldPath = row ? row.avatar_path : null;
            db.run(`UPDATE User_Data SET avatar_path = ? WHERE id = ?`, [newPath, userId], (e2) => {
                if (e2) { fs.unlink(newPath, () => {}); return res.redirect('/edit?avatarerror=1'); }
                deleteOldAvatarFile(oldPath);
                res.redirect('/edit');
            });
        });
    });
});

app.post('/edit/theme', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const { theme } = req.body;
    const valid = loadThemes().some(t => t.name === theme);
    if (!valid) return res.redirect('/edit?themeerror=1');
    db.run(`UPDATE User_Data SET theme = ? WHERE id = ?`, [theme, req.session.userId], () => res.redirect('/edit'));
});

// Self-service email change (from the dashboard)
// Step 1: user submits the new address they want.
app.post('/account/email/request-code', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const userId = req.session.userId;
    const newEmail = (req.body.new_email || '').trim().toLowerCase();

    if (!newEmail || !EMAIL_REGEX.test(newEmail)) {
        return res.status(400).json({ error: 'That doesn\'t look like a valid email.' });
    }
    const requestProblem = await validateEmailForUse(newEmail);
    if (requestProblem) return res.status(400).json({ error: requestProblem });

    db.get(`SELECT username, email FROM User_Data WHERE id = ?`, [userId], (err, user) => {
        if (err) return res.status(500).json({ error: 'Something went wrong.' });
        if (!user) return res.status(404).json({ error: 'Account not found.' });
        if (!user.email) {
            return res.status(400).json({ error: 'Your account has no email on file yet - add one first.' });
        }
        if (newEmail === user.email.toLowerCase()) {
            return res.status(400).json({ error: 'That\'s already your current email.' });
        }
        db.get(`SELECT id FROM User_Data WHERE email = ? COLLATE NOCASE AND id != ?`, [newEmail, userId], (err2, taken) => {
            if (err2) return res.status(500).json({ error: 'Something went wrong.' });
            if (taken) return res.status(400).json({ error: 'That email is already linked to another account.' });

            const { code, hash } = generateEmailChangeCode();
            const expiresAt = new Date(Date.now() + EMAIL_CHANGE_CODE_TTL_MS).toISOString();
            db.run(`INSERT INTO Email_Changes (user_id, code_hash, new_email, expires_at) VALUES (?, ?, ?, ?)`,
                [userId, hash, newEmail, expiresAt], (err3) => {
                    if (err3) { console.error('Email change insert error:', err3.message); return res.status(500).json({ error: 'Something went wrong.' }); }
                    sendEmailChangeCodeEmail(user.email, user.username, code, newEmail);
                    logAudit('email_change_requested', user.username, user.username, `to ${newEmail}`);
                    res.json({ ok: true, sent_to: user.email });
                });
        });
    });
});

// Step 2: user enters the code that was emailed to their current address.
app.post('/account/email/confirm', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const userId = req.session.userId;
    const code = (req.body.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Enter the code from your email.' });
    const codeHash = hashEmailChangeCode(code);

    db.get(`SELECT * FROM Email_Changes WHERE user_id = ? AND code_hash = ? ORDER BY id DESC LIMIT 1`, [userId, codeHash], (err, changeRow) => {
        if (err) return res.status(500).json({ error: 'Something went wrong.' });
        if (!changeRow || changeRow.used || new Date(changeRow.expires_at) < new Date()) {
            return res.status(400).json({ error: 'That code is invalid or has expired - request a new one.' });
        }
        db.get(`SELECT id FROM User_Data WHERE email = ? COLLATE NOCASE AND id != ?`, [changeRow.new_email, userId], (err2, taken) => {
            if (err2) return res.status(500).json({ error: 'Something went wrong.' });
            if (taken) return res.status(400).json({ error: 'That email is already linked to another account - request the change again with a different address.' });

            db.run(`UPDATE User_Data SET email = ? WHERE id = ?`, [changeRow.new_email, userId], (err3) => {
                if (err3) {
                    if (err3.message && err3.message.includes('.email')) {
                        return res.status(400).json({ error: 'That email is already linked to another account.' });
                    }
                    console.error('Email change update error:', err3.message);
                    return res.status(500).json({ error: 'Something went wrong.' });
                }
                // Mark this code used and invalidate any other outstanding requests for this
                // account, same pattern as password resets.
                db.run(`UPDATE Email_Changes SET used = 1 WHERE user_id = ?`, [userId], () => {});
                db.get(`SELECT username FROM User_Data WHERE id = ?`, [userId], (err4, u) => {
                    logAudit('email_changed', u ? u.username : 'unknown', u ? u.username : null, `to ${changeRow.new_email}`);
                });
                res.json({ ok: true, email: changeRow.new_email });
            });
        });
    });
});
