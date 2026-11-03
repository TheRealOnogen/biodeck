// Support form.
const { app } = require('../app');
const { db } = require('../db/connection');
const { EMAIL_REGEX, sendSupportTicketConfirmationEmail } = require('../mail');
const { logAudit } = require('../moderation');
const { escapeHTML } = require('../render/html');
const { renderMessagePage } = require('../render/pages');
const { getClientIP } = require('../security/ip');
const { authLimiter } = require('../security/rate-limit');

// Support form
// Reachable without logging in.
const MAX_SUPPORT_SUBJECT_LENGTH = 150;
const MAX_SUPPORT_MSG_LENGTH = 2000;

function renderSupportForm(opts) {
    opts = opts || {};
    const errorHTML = opts.error
        ? `<h3 style="color: var(--danger-light-color);">${escapeHTML(opts.error)}</h3><br>`
        : '';
    const v = opts.values || {};
    return renderMessagePage('Support', 'Contact support',
        `<h3>Need help with your account? Fill this out and we'll get back to you at the email you provide.</h3><br>
        ${errorHTML}
        <form method="POST" action="/support" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
            <input type="text" name="username" placeholder="Account username" required maxlength="32" value="${escapeHTML(v.username || '')}" style="width: 260px;">
            <input type="text" name="email" placeholder="Contact email" required style="width: 260px;" value="${escapeHTML(v.email || '')}">
            <input type="text" name="subject" placeholder="Subject" required maxlength="${MAX_SUPPORT_SUBJECT_LENGTH}" value="${escapeHTML(v.subject || '')}" style="width: 260px;">
            <textarea class="box" name="message" placeholder="How can we help?" required maxlength="${MAX_SUPPORT_MSG_LENGTH}" rows="6" style="width: 260px; resize: vertical; font-family: inherit; padding: 8px; box-sizing: border-box;">${escapeHTML(v.message || '')}</textarea>
            <button type="submit" class="button" style="width: 180px;">Send</button>
        </form><br>
        <button type="button" class="button" style="width: 150px" onclick="history.back()">Back</button>`);
}

app.get('/support', (req, res) => {
    const prefillUsername = req.session.userUsername || '';
    res.send(renderSupportForm({ values: { username: prefillUsername } }));
});

// This form is reachable without logging in, so without a rate limit it was an open spam/flood
// vector.
app.post('/support', authLimiter, (req, res) => {
    const username = (req.body.username || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const subject = (req.body.subject || '').trim();
    const message = (req.body.message || '').trim();
    const values = { username, email, subject, message };

    if (!username) return res.status(400).send(renderSupportForm({ error: 'Account username is required.', values }));
    if (!email || !EMAIL_REGEX.test(email)) return res.status(400).send(renderSupportForm({ error: 'A valid contact email is required.', values }));
    if (!subject) return res.status(400).send(renderSupportForm({ error: 'Subject is required.', values }));
    if (subject.length > MAX_SUPPORT_SUBJECT_LENGTH) return res.status(400).send(renderSupportForm({ error: `Subject is too long - ${MAX_SUPPORT_SUBJECT_LENGTH} character limit.`, values }));
    if (!message) return res.status(400).send(renderSupportForm({ error: 'Please describe the issue.', values }));
    if (message.length > MAX_SUPPORT_MSG_LENGTH) return res.status(400).send(renderSupportForm({ error: `Message too long - ${MAX_SUPPORT_MSG_LENGTH} character limit.`, values }));

    const ip = getClientIP(req);
    db.run(`INSERT INTO Support_Tickets (username, email, subject, message, ip) VALUES (?, ?, ?, ?, ?)`,
        [username, email, subject, message, ip], function (err) {
            if (err) {
                console.error('Support ticket insert error:', err.message);
                return res.status(500).send(renderSupportForm({ error: 'Something went wrong. Please try again.', values }));
            }
            const ticket = { id: this.lastID, username, email, subject, message };
            sendSupportTicketConfirmationEmail(ticket);
            logAudit('support_ticket_submitted', username, username, `#${ticket.id}: ${subject}`);
            return res.send(renderMessagePage('Support', 'Message sent',
                `<h3>Thanks - we've received your message and will get back to you at ${escapeHTML(email)}.</h3><br><br>
                <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Back to login</button>`));
        });
});

module.exports = { MAX_SUPPORT_MSG_LENGTH };
