// Shared account creation used by the website and the API.
const bcrypt = require('bcrypt');
const { db } = require('../db/connection');
const { broadcastGCMessage } = require('../live/events');
const { issueEmailVerification } = require('../mail');
const { getActivationPingUsernames, logAudit } = require('../moderation');
const { banIPForSpam, isRegistrationSpam } = require('../security/account-spam');
const { normalizeEmailForLimit, validateEmailForUse } = require('../security/email-validation');
const { getClientIP, recordLoginIP } = require('../security/ip');
const { checkSignupLimits, consumeFormNonce, releaseFormNonce } = require('../security/signup');
const { checkRegistrationLockdownTrigger, getRegistrationBlockPage } = require('../site-state');
const { processMentions, sendSystemDM } = require('../social');
const siteState = require('../site-state');

// Shared account creation
// EVERY way of creating an account (the HTML form and POST /api/v1/auth/register) runs through this
// one function.
async function createAccount(req, { username, password, email, formNonce }) {
    const ip = getClientIP(req);
    const emailNorm = normalizeEmailForLimit(email);

    // Cheap refusals (disposable email, per-email and per-IP caps) happen before the bcrypt hash so
    // spammers can't burn CPU with them.
    const refusal = checkSignupLimits(ip, email, emailNorm);
    if (refusal) return { ok: false, code: 'signup_refused', refusal };
    const emailProblem = await validateEmailForUse(email);
    if (emailProblem) {
        return { ok: false, code: 'signup_refused', refusal: { status: 400, title: 'Email not allowed',
            heading: 'That email can\'t be used', message: emailProblem } };
    }

    // One account per token. Synchronous, so parallel requests can't share one.
    if (!consumeFormNonce(formNonce)) return { ok: false, code: 'bad_form_token' };

    let hashedPassword;
    try {
        hashedPassword = await bcrypt.hash(password, 10);
    } catch (e) {
        releaseFormNonce(formNonce);
        throw e;
    }

    // Re-check the lockdown now that the (async) hash is done.
    const lockdownPage = getRegistrationBlockPage();
    if (lockdownPage) {
        releaseFormNonce(formNonce);
        return { ok: false, code: 'lockdown', page: lockdownPage };
    }

    // Account-spam guard.
    if (isRegistrationSpam(ip)) {
        const banErr = await new Promise(resolve => banIPForSpam(ip, e => resolve(e || null)));
        return { ok: false, code: 'spam_banned', banErr };
    }

    const gateEnabled = siteState.registrationGateEnabled;
    const initialIsBanned = gateEnabled ? 1 : 0;
    const initialBanReason = gateEnabled
        ? "Account creation is currently disabled, please contact biodecksupport@gmail.com to activate your account, a message was also sent to admins"
        : null;

    const inserted = await new Promise(resolve => {
        db.run(`INSERT INTO User_Data (username, password, email, email_verified, IsBanned, BanReason, avatar_path, reg_email_norm) VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
            [username, hashedPassword, email, initialIsBanned, initialBanReason, 'public/Default.png', emailNorm],
            function (err) {
                if (err) return resolve({ err });
                const id = this.lastID;
                // Log the IP of every account the moment it exists (this is what the spam ban
                // counts), independent of the gate / email flow below.
                db.run(`INSERT INTO Registration_IPs (user_id, username, ip, created_ts) VALUES (?, ?, ?, ?)`,
                    [id, username, ip, Date.now()],
                    (ipErr) => { if (ipErr) console.error('Registration IP log error:', ipErr.message); });
                resolve({ id });
            });
    });
    if (inserted.err) {
        console.error("Database Insert Error:", inserted.err.message);
        releaseFormNonce(formNonce);
        return { ok: false, code: 'username_taken' };
    }
    const newUserId = inserted.id;
    checkRegistrationLockdownTrigger();
    logAudit('account_created', username, username, gateEnabled ? 'registration gate ON - created pending activation' : 'registration gate OFF - created active');

    // Activation gating pings only fire while the registration gate is enabled.
    if (gateEnabled) {
        // Post a notice in the reserved "Activations" group chat (id 1) so admins/mods watching it
        // see new signups awaiting activation.
        db.get(`SELECT username FROM User_Data WHERE id = 1`, (errPing, pingUser) => {
            const pingSuffix = pingUser ? ` @${pingUser.username}` : '';
            const gcContent = `${username} is waiting for activation${pingSuffix}`;
            db.run(`INSERT INTO Group_Chat_Messages (group_id, from_user, content) VALUES (1, 'System', ?)`,
                [gcContent], function (errGC) {
                    if (errGC) { console.error('Activation notice insert error:', errGC.message); return; }
                    const gcMsgId = this.lastID;
                    db.get(`SELECT Group_Chat_Messages.*, User_Data.avatar_path, User_Data.Nickname, User_Data.IsVerified FROM Group_Chat_Messages LEFT JOIN User_Data ON Group_Chat_Messages.from_user = User_Data.username WHERE Group_Chat_Messages.id = ?`, [gcMsgId], (errRow, row) => {
                        if (errRow || !row) return;
                        db.all(`SELECT username FROM Group_Chat_Members WHERE group_id = 1`, (errMem, memberRows) => {
                            const members = (memberRows || []).map(r => r.username);
                            broadcastGCMessage(1, 'System', row, null, members);
                        });
                    });
                    if (pingUser) {
                        processMentions(gcContent, 'System', { type: 'mention_gc', post_id: 1, message_id: gcMsgId });
                    }
                });

            // DM the same notice to user id 1 plus anyone listed in the local activation-pings.txt
            // file, once each.
            const dmContent = `${username} is waiting for activation`;
            const candidateUsernames = new Set(getActivationPingUsernames());
            if (pingUser) candidateUsernames.add(pingUser.username);
            if (candidateUsernames.size) {
                const usernameList = [...candidateUsernames];
                const placeholders = usernameList.map(() => '?').join(',');
                db.all(`SELECT username FROM User_Data WHERE username IN (${placeholders})`, usernameList, (errDM, rows) => {
                    if (errDM || !rows) return;
                    rows.forEach(r => sendSystemDM(r.username, dmContent));
                });
            }
        });
    }

    if (initialIsBanned) return { ok: true, userId: newUserId, username, banned: true, banReason: initialBanReason };

    recordLoginIP(newUserId, username, ip, 'register');
    issueEmailVerification(newUserId, username, email, () => {});
    return { ok: true, userId: newUserId, username, banned: false };
}

module.exports = { createAccount };
