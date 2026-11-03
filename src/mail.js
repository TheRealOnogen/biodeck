// SMTP transport, email tokens and outgoing emails.
const crypto = require('crypto');
const { APP_BASE_URL } = require('./config');
const { db } = require('./db/connection');
const { getWarningExtras } = require('./moderation');
const { escapeHTML } = require('./render/html');

let nodemailer;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Strict on purpose: the old pattern accepted commas, quotes and angle brackets.
const EMAIL_REGEX = /^(?=.{3,254}$)[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

let mailTransporter = null;
if (nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    mailTransporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
} else if (!nodemailer) {
    console.warn('nodemailer is not installed (run `npm install nodemailer`) - password reset emails will be logged to the console instead of sent.');
} else {
    console.warn('SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS) - password reset emails will be logged to the console instead of sent.');
}

function sendPasswordResetEmail(toEmail, username, resetLink) {
    const subject = 'Reset your Biodeck password';
    const text = `Hi ${username},\n\nA password reset was requested for your Biodeck account. If this was you, click the link below to choose a new password. This link expires in 1 hour and can only be used once.\n\n${resetLink}\n\nIf you didn't request this, you can safely ignore this email - your password will not change.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>A password reset was requested for your Biodeck account. If this was you, click the link below to choose a new password. This link expires in 1 hour and can only be used once.</p><p><a href="${resetLink}">${resetLink}</a></p><p>If you didn't request this, you can safely ignore this email - your password will not change.</p>`;

    if (!mailTransporter) {
        console.log(`[password reset] SMTP not configured - link for ${toEmail}: ${resetLink}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send password reset email:', err.message));
}

// Returns { raw, hash }.
function generateResetToken() {
    const raw = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    return { raw, hash };
}
function hashResetToken(raw) {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

// Email change verification codes
const EMAIL_CHANGE_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Returns { code, hash }. 6-digit numeric code, easy to type/read; only the sha256 hash is
// persisted.
function generateEmailChangeCode() {
    const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
    const hash = crypto.createHash('sha256').update(code).digest('hex');
    return { code, hash };
}
function hashEmailChangeCode(code) {
    return crypto.createHash('sha256').update(code).digest('hex');
}

function sendEmailChangeCodeEmail(toEmail, username, code, newEmail) {
    const subject = 'Confirm your Biodeck email change';
    const text = `Hi ${username},\n\nA request was made to change the email on your Biodeck account from this address to ${newEmail}. Enter this code on the dashboard to confirm the change. This code expires in 15 minutes and can only be used once.\n\nCode: ${code}\n\nIf you didn't request this, you can safely ignore this email - your email will not change.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>A request was made to change the email on your Biodeck account from this address to ${escapeHTML(newEmail)}. Enter this code on the dashboard to confirm the change. This code expires in 15 minutes and can only be used once.</p><p style="font-size:1.4em;font-weight:700;letter-spacing:2px;">${escapeHTML(code)}</p><p>If you didn't request this, you can safely ignore this email - your email will not change.</p>`;

    if (!mailTransporter) {
        console.log(`[email change] SMTP not configured - code for ${toEmail} (-> ${newEmail}): ${code}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send email change code:', err.message));
}

// Email verification links
const EMAIL_VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const EMAIL_VERIFY_RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute, tracked in-memory below

// Returns { raw, hash }, same pattern as generateResetToken().
function generateEmailVerifyToken() {
    const raw = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    return { raw, hash };
}
function hashEmailVerifyToken(raw) {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

function sendVerifyEmail(toEmail, username, verifyLink) {
    const subject = 'Verify your Biodeck email address';
    const text = `Hi ${username},\n\nPlease confirm this is your email address by clicking the link below. This link expires in 24 hours and can only be used once.\n\n${verifyLink}\n\nIf you didn't create a Biodeck account, you can safely ignore this email.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>Please confirm this is your email address by clicking the link below. This link expires in 24 hours and can only be used once.</p><p><a href="${verifyLink}">${verifyLink}</a></p><p>If you didn't create a Biodeck account, you can safely ignore this email.</p>`;

    if (!mailTransporter) {
        console.log(`[email verify] SMTP not configured - link for ${toEmail}: ${verifyLink}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send verification email:', err.message));
}

// Account moderation emails (ban / unban / delete / permanent delete)
function sendAccountBannedEmail(toEmail, username, reason, expiresAt) {
    const subject = 'Your Biodeck account has been banned';
    const cleanReason = reason || 'No reason provided';
    const expiryText = expiresAt ? `\n\nThis ban expires: ${new Date(expiresAt).toLocaleString()}` : '';
    const expiryHtml = expiresAt ? `<p><strong>Expires:</strong> ${escapeHTML(new Date(expiresAt).toLocaleString())}</p>` : '';
    const text = `Hi ${username},\n\nYour Biodeck account has been banned.\n\nReason: ${cleanReason}${expiryText}\n\nIf you believe this is a mistake, contact an administrator.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>Your Biodeck account has been banned.</p><p><strong>Reason:</strong> ${escapeHTML(cleanReason)}</p>${expiryHtml}<p>If you believe this is a mistake, contact an administrator.</p>`;

    if (!mailTransporter) {
        console.log(`[account banned] SMTP not configured - would have emailed ${toEmail}: ${cleanReason}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send account banned email:', err.message));
}

function sendAccountUnbannedEmail(toEmail, username) {
    const subject = 'Your Biodeck account has been unbanned';
    const text = `Hi ${username},\n\nYour Biodeck account has been unbanned. You can log back in whenever you're ready.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>Your Biodeck account has been unbanned. You can log back in whenever you're ready.</p>`;

    if (!mailTransporter) {
        console.log(`[account unbanned] SMTP not configured - would have emailed ${toEmail}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send account unbanned email:', err.message));
}

// Sent when a timed ban expires on its own (as opposed to an admin manually unbanning via
// sendAccountUnbannedEmail above).
function sendBanExpiredEmail(toEmail, username) {
    const subject = 'Your Biodeck ban has expired';
    const text = `Hi ${username},\n\nThe temporary ban on your Biodeck account has expired and your access has been restored. You can log back in whenever you're ready.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>The temporary ban on your Biodeck account has expired and your access has been restored. You can log back in whenever you're ready.</p>`;

    if (!mailTransporter) {
        console.log(`[ban expired] SMTP not configured - would have emailed ${toEmail}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send ban expired email:', err.message));
}

// Sent for the soft delete (admin resets the profile and marks IsDeleted, but the row and username
// are kept).
function sendAccountDeletedEmail(toEmail, username, reason) {
    const subject = 'Your Biodeck account has been deleted';
    const cleanReason = reason || 'No reason provided';
    const text = `Hi ${username},\n\nYour Biodeck account has been deleted by an administrator. Your posts have been removed and your profile has been reset.\n\nReason: ${cleanReason}\n\nIf you believe this is a mistake, contact an administrator.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>Your Biodeck account has been deleted by an administrator. Your posts have been removed and your profile has been reset.</p><p><strong>Reason:</strong> ${escapeHTML(cleanReason)}</p><p>If you believe this is a mistake, contact an administrator.</p>`;

    if (!mailTransporter) {
        console.log(`[account deleted] SMTP not configured - would have emailed ${toEmail}: ${cleanReason}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send account deleted email:', err.message));
}

// Sent for the hard delete - covers both the admin "Delete From Database" action and a user
// deleting their own account.
function sendAccountPermanentlyDeletedEmail(toEmail, username, reason) {
    const subject = 'Your Biodeck account has been permanently deleted';
    const cleanReason = reason || 'No reason provided';
    const text = `Hi ${username},\n\nYour Biodeck account and all of its data (posts, messages, group chats, follows, friends, and notifications) have been permanently deleted. This cannot be undone.\n\nReason: ${cleanReason}\n\nIf you believe this is a mistake, contact an administrator.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>Your Biodeck account and all of its data (posts, messages, group chats, follows, friends, and notifications) have been permanently deleted. This cannot be undone.</p><p><strong>Reason:</strong> ${escapeHTML(cleanReason)}</p><p>If you believe this is a mistake, contact an administrator.</p>`;

    if (!mailTransporter) {
        console.log(`[account permanently deleted] SMTP not configured - would have emailed ${toEmail}: ${cleanReason}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send account permanently deleted email:', err.message));
}

// Sent when an admin issues a warning against an account's standing.
function sendWarningEmail(toEmail, username, reason, expiresAt, extras) {
    const subject = 'You have received a warning on Biodeck';
    const cleanReason = reason || 'No reason provided';
    const expiryText = expiresAt ? `\n\nThis warning expires: ${new Date(expiresAt).toLocaleString()}` : '\n\nThis warning does not expire.';
    const expiryHtml = expiresAt ? `<p><strong>Expires:</strong> ${escapeHTML(new Date(expiresAt).toLocaleString())}</p>` : `<p><strong>Expires:</strong> Never</p>`;
    const extrasRow = extras ? { ...extras, expires_at: expiresAt } : null;
    const extrasText = extrasRow ? getWarningExtras(extrasRow, 'text', { activeOnly: false }) : [];
    const extrasHtml = extrasRow ? getWarningExtras(extrasRow, 'html', { activeOnly: false }) : [];
    const extrasTextBlock = extrasText.length ? `\n\n${extrasText.join('\n\n')}` : '';
    const extrasHtmlBlock = extrasHtml.length ? extrasHtml.join('') : '';
    const text = `Hi ${username},\n\nYour Biodeck account has received a warning.\n\nReason: ${cleanReason}${expiryText}${extrasTextBlock}\n\nEnough active warnings can affect your account standing. You can review your standing and warning history from your dashboard.\n\nIf you believe this is a mistake, contact an administrator.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>Your Biodeck account has received a warning.</p><p><strong>Reason:</strong> ${escapeHTML(cleanReason)}</p>${expiryHtml}${extrasHtmlBlock}<p>Enough active warnings can affect your account standing. You can review your standing and warning history from your dashboard.</p><p>If you believe this is a mistake, contact an administrator.</p>`;

    if (!mailTransporter) {
        console.log(`[warning issued] SMTP not configured - would have emailed ${toEmail}: ${cleanReason}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send warning email:', err.message));
}

// Sent when a warning is manually revoked early by an admin.
function sendWarningRevokedEmail(toEmail, username, reason) {
    const subject = 'A warning on your Biodeck account has been removed';
    const cleanReason = reason || 'No reason provided';
    const text = `Hi ${username},\n\nA warning on your Biodeck account has been removed by an administrator and no longer counts toward your account standing.\n\nOriginal reason: ${cleanReason}\n\nIf you have questions, contact an administrator.`;
    const html = `<p>Hi ${escapeHTML(username)},</p><p>A warning on your Biodeck account has been removed by an administrator and no longer counts toward your account standing.</p><p><strong>Original reason:</strong> ${escapeHTML(cleanReason)}</p><p>If you have questions, contact an administrator.</p>`;

    if (!mailTransporter) {
        console.log(`[warning revoked] SMTP not configured - would have emailed ${toEmail}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject, text, html
    }).catch(err => console.error('Failed to send warning revoked email:', err.message));
}

// Sent to the submitter's own contact email right after they file a ticket, just to confirm it was
// received.
function sendSupportTicketConfirmationEmail(ticket) {
    const subject = `[Ticket #${ticket.id}] We've received your support ticket`;
    const text = `Hello ${ticket.username},\n\nWe've received your support ticket and will review it.\n\nThis is an automated message.`;
    const html = `<p>Hello ${escapeHTML(ticket.username)},</p><p>We've received your support ticket and will review it.</p><p style="opacity:0.6;font-size:0.9em;">This is an automated message.</p>`;

    if (!mailTransporter) {
        console.log(`[support ticket confirmation] SMTP not configured - would have emailed ${ticket.email} for ticket #${ticket.id}`);
        return Promise.resolve();
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: ticket.email,
        subject, text, html
    }).catch(err => console.error('Failed to send support ticket confirmation email:', err.message));
}

// Sent to the ticket's contact email when an admin replies from the /admin/support/:id page.
function sendSupportReplyEmail(ticket, replyMessage, adminUsername) {
    const subject = `Re: [Ticket #${ticket.id}] ${ticket.subject}`;
    const text = `Hi ${ticket.username},\n\nYou recently contacted Biodeck support about "${ticket.subject}" (ticket #${ticket.id}). Here's a reply from our team:\n\n${replyMessage}\n\n---\nYour original message:\n${ticket.message}`;
    const html = `<p>Hi ${escapeHTML(ticket.username)},</p>
        <p>You recently contacted Biodeck support about "${escapeHTML(ticket.subject)}" (ticket #${ticket.id}). Here's a reply from our team:</p>
        <p>${escapeHTML(replyMessage).replace(/\n/g, '<br>')}</p>
        <hr>
        <p style="opacity:0.7;font-size:0.9em;"><strong>Your original message:</strong><br>${escapeHTML(ticket.message).replace(/\n/g, '<br>')}</p>`;

    if (!mailTransporter) {
        console.log(`[support reply] SMTP not configured - reply to ${ticket.email} for ticket #${ticket.id} was NOT sent: ${replyMessage}`);
        return Promise.resolve(false);
    }
    return mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: ticket.email,
        subject, text, html
    }).then(() => true).catch(err => {
        console.error('Failed to send support reply email:', err.message);
        return false;
    });
}

// Invalidates any outstanding verification links for the user, creates a new one for `email`, and
// sends it.
function issueEmailVerification(userId, username, email, callback) {
    db.run(`UPDATE Email_Verifications SET used = 1 WHERE user_id = ? AND used = 0`, [userId], () => {
        const { raw, hash } = generateEmailVerifyToken();
        const expiresAt = new Date(Date.now() + EMAIL_VERIFY_TOKEN_TTL_MS).toISOString();
        db.run(`INSERT INTO Email_Verifications (user_id, token_hash, email, expires_at) VALUES (?, ?, ?, ?)`,
            [userId, hash, email, expiresAt], (err) => {
                if (err) { console.error('Email verification insert error:', err.message); if (callback) callback(err); return; }
                const verifyLink = `${APP_BASE_URL}/account/verify-email?token=${raw}`;
                sendVerifyEmail(email, username, verifyLink);
                if (callback) callback(null);
            });
    });
}

module.exports = {
    EMAIL_CHANGE_CODE_TTL_MS,
    EMAIL_REGEX,
    EMAIL_VERIFY_RESEND_COOLDOWN_MS,
    RESET_TOKEN_TTL_MS,
    generateEmailChangeCode,
    generateResetToken,
    hashEmailChangeCode,
    hashEmailVerifyToken,
    hashResetToken,
    issueEmailVerification,
    mailTransporter,
    sendAccountBannedEmail,
    sendAccountDeletedEmail,
    sendAccountPermanentlyDeletedEmail,
    sendAccountUnbannedEmail,
    sendBanExpiredEmail,
    sendEmailChangeCodeEmail,
    sendPasswordResetEmail,
    sendSupportReplyEmail,
    sendSupportTicketConfirmationEmail,
    sendWarningEmail,
    sendWarningRevokedEmail,
};
