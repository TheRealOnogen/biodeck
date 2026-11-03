// Admin support tickets.
const { requireAdmin } = require('../../admin/helpers');
const { app } = require('../../app');
const { db } = require('../../db/connection');
const { sendSupportReplyEmail } = require('../../mail');
const { logAudit } = require('../../moderation');
const { escapeHTML } = require('../../render/html');
const { renderMarkdown } = require('../../render/markdown');
const { renderMessagePage } = require('../../render/pages');
const { MAX_SUPPORT_MSG_LENGTH } = require('../support');

// Support tickets (admin)
// Standalone page, linked from the admin dashboard, listing every ticket submitted via the public
// /support form.
function renderSupportTopbar(title) {
    return `<div id="topbar">
    <strong>${escapeHTML(title)}</strong>
    <div id="topbar-right" style="position:relative;display:flex;align-items:center;">
        <a href="/admin/dashboard">Admin Dashboard</a>
        <a href="/admin/reports">Reports</a>
        <a href="/admin/support">Support Tickets</a>
        <a href="/feed">Feed</a>
        <a href="/logout">Logout</a>
        <button id="nav-hamburger" onclick="toggleNav()" aria-label="Menu">☰</button>
        <nav id="nav-dropdown">
            <a href="/admin/dashboard">Admin Dashboard</a>
            <a href="/admin/reports">Reports</a>
            <a href="/admin/support">Support Tickets</a>
            <a href="/feed">Feed</a>
            <a href="/logout">Logout</a>
        </nav>
    </div>
</div>`;
}

const SUPPORT_NAV_SCRIPT = `
<script>
    document.querySelectorAll('.button').forEach(btn => {
        btn.addEventListener('mousedown', () => { btn.classList.add('clicked'); setTimeout(() => btn.classList.remove('clicked'), 150); });
    });
    function toggleNav() {
        const dropdown = document.getElementById('nav-dropdown');
        const btn = document.getElementById('nav-hamburger');
        dropdown.classList.toggle('open');
        btn.textContent = dropdown.classList.contains('open') ? '✕' : '☰';
    }
    document.addEventListener('click', function(e) {
        const dropdown = document.getElementById('nav-dropdown');
        const btn = document.getElementById('nav-hamburger');
        if (dropdown && btn && !dropdown.contains(e.target) && e.target !== btn) {
            dropdown.classList.remove('open');
            btn.textContent = '☰';
        }
    });
</script>`;

app.get('/admin/support', requireAdmin, (req, res) => {
    db.all(`SELECT id, username, subject, status, created_at FROM Support_Tickets ORDER BY (status = 'open') DESC, id DESC`, [], (err, tickets) => {
        if (err) return res.status(500).send('DB error');
        const rows = (tickets || []).map(t => `<tr class="ticket-row" onclick="window.location.href='/admin/support/${t.id}'">
            <td style="opacity:0.5;">#${t.id}</td>
            <td style="word-break:break-word;overflow-wrap:break-word;">${escapeHTML(t.subject)}</td>
            <td><a href="/user/${escapeHTML(t.username)}" onclick="event.stopPropagation();" style="color:var(--text-color);text-decoration:none;">@${escapeHTML(t.username)}</a></td>
            <td>${t.status === 'open' ? '<span style="color:var(--warning-color, #d9a441);font-weight:700;">Open</span>' : '<span style="color:var(--success-color);font-weight:700;">Resolved</span>'}</td>
            <td style="font-size:0.78em;opacity:0.5;white-space:nowrap;">${escapeHTML(t.created_at || '')}</td>
        </tr>`).join('');

        res.send(`<!DOCTYPE html>
<html lang="en" class="page-admin">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Support Tickets</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
<style>
    .table-scroll-wrap { display:block !important; width:100% !important; max-width:100% !important; overflow-x:auto !important; -webkit-overflow-scrolling:touch; }
    .ticket-row { cursor:pointer; }
    .ticket-row:hover { background:rgba(255,255,255,0.05); }
</style>
</head>
<body class="page-admin">
${renderSupportTopbar('Support Tickets')}
<div id="content">
    <h1>Support Tickets</h1>
    <p style="opacity:0.5;margin-top:4px;">Click a ticket to see the full message and reply.</p>

    <div class="panel">
        <div class="table-scroll-wrap">
            <table>
                <thead><tr><th>#</th><th>Subject</th><th>Account</th><th>Status</th><th>Submitted</th></tr></thead>
                <tbody>
                    ${rows || '<tr><td colspan="5" style="opacity:0.4;">No support tickets.</td></tr>'}
                </tbody>
            </table>
        </div>
    </div>
</div>
${SUPPORT_NAV_SCRIPT}
</body>
</html>`);
    });
});

app.get('/admin/support/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).send(renderMessagePage('Not Found', 'Ticket not found', `<h3>That ticket doesn't exist.</h3><br><br><button type="button" class="button" style="width: 180px" onclick="window.location.href='/admin/support';">Back to tickets</button>`));

    db.get(`SELECT id, username, email, subject, message, status, created_at, ip, resolution_note FROM Support_Tickets WHERE id = ?`, [id], (err, ticket) => {
        if (err) return res.status(500).send('DB error');
        if (!ticket) return res.status(404).send(renderMessagePage('Not Found', 'Ticket not found', `<h3>That ticket doesn't exist.</h3><br><br><button type="button" class="button" style="width: 180px" onclick="window.location.href='/admin/support';">Back to tickets</button>`));

        db.all(`SELECT ip, event, changed_from_previous, created_at FROM IP_Login_History WHERE username = ? ORDER BY id DESC LIMIT 15`, [ticket.username], (errIP, ipHistory) => {
        const ticketIPKnown = !!(ipHistory && ipHistory.length && ticket.ip);
        const ticketIPMatchesLatest = ticketIPKnown && ipHistory[0].ip === ticket.ip;
        const ipSectionHTML = `
        <p style="font-size:0.9em;"><strong>Submitted from IP:</strong> ${ticket.ip ? escapeHTML(ticket.ip) : '<span style="opacity:0.4;">unknown (submitted by email)</span>'}${
            ticketIPKnown ? (ticketIPMatchesLatest
                ? ' <span style="color:var(--success-color);">(matches account\'s most recent login IP)</span>'
                : ' <span style="color:var(--danger-color);font-weight:700;">(does NOT match account\'s most recent login IP - worth a closer look)</span>')
                : ''
        }</p>
        <details style="margin-top:6px;">
            <summary style="cursor:pointer;font-size:0.85em;opacity:0.7;">Recent login IP history for @${escapeHTML(ticket.username)} (${(ipHistory || []).length})</summary>
            ${(ipHistory && ipHistory.length) ? `<table style="width:100%;font-size:0.8em;margin-top:8px;border-collapse:collapse;">
                <tr style="opacity:0.6;text-align:left;"><th style="padding:2px 8px 2px 0;">IP</th><th style="padding:2px 8px;">Event</th><th style="padding:2px 8px;">When</th></tr>
                ${ipHistory.map(h => `<tr${h.changed_from_previous ? ' style="color:var(--danger-color);font-weight:700;"' : ''}>
                    <td style="padding:2px 8px 2px 0;">${escapeHTML(h.ip)}${h.changed_from_previous ? ' ⚠️ changed' : ''}</td>
                    <td style="padding:2px 8px;">${escapeHTML(h.event)}</td>
                    <td style="padding:2px 8px;">${escapeHTML(h.created_at || '')}</td>
                </tr>`).join('')}
            </table>` : `<p style="opacity:0.4;font-size:0.85em;margin-top:6px;">No login history recorded yet.</p>`}
        </details>`;

        db.all(`SELECT admin_username, message, created_at, is_customer, customer_email FROM Support_Ticket_Replies WHERE ticket_id = ? ORDER BY id ASC`, [id], (err2, replies) => {
            const repliesHTML = (replies || []).map(r => {
                const isCustomer = !!r.is_customer;
                const who = isCustomer
                    ? `${escapeHTML(r.admin_username)} <span style="opacity:0.6;">(customer${r.customer_email ? ' · ' + escapeHTML(r.customer_email) : ''})</span>`
                    : `${escapeHTML(r.admin_username)} <span style="opacity:0.6;">(admin)</span>`;
                return `<div style="border-top:1px solid rgba(255,255,255,0.1);${isCustomer ? 'border-left:3px solid var(--warning-color, #d9a441);padding-left:10px;' : ''}padding-top:12px;padding-bottom:12px;">
                <div style="font-size:0.78em;opacity:0.5;margin-bottom:4px;">${who} · ${escapeHTML(r.created_at || '')}</div>
                <div style="word-break:break-word;overflow-wrap:break-word;">${renderMarkdown(r.message)}</div>
            </div>`;
            }).join('');

            let bannerHTML = '';
            if (req.query.sent === '1') bannerHTML = `<p style="color:var(--success-color);font-weight:700;">Reply sent.</p>`;
            else if (req.query.sent === '0') bannerHTML = `<p style="color:var(--danger-color);font-weight:700;">Reply saved, but the email could not be sent - check the SMTP configuration.</p>`;
            else if (req.query.error) bannerHTML = `<p style="color:var(--danger-color);font-weight:700;">${escapeHTML(req.query.error)}</p>`;

            const statusLabel = ticket.status === 'open'
                ? '<span style="color:var(--warning-color, #d9a441);font-weight:700;">Open</span>'
                : '<span style="color:var(--success-color);font-weight:700;">Resolved</span>';

            res.send(`<!DOCTYPE html>
<html lang="en" class="page-admin">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ticket #${ticket.id} - Support</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
</head>
<body class="page-admin">
${renderSupportTopbar('Support Ticket #' + ticket.id)}
<div id="content">
    <p><a href="/admin/support" style="color:var(--text-color);opacity:0.6;text-decoration:none;">< Back to tickets</a></p>
    ${bannerHTML}

    <div class="panel">
        <h2 style="word-break:break-word;overflow-wrap:break-word;">${escapeHTML(ticket.subject)}</h2>
        <p style="opacity:0.5;font-size:0.85em;margin-top:-6px;">Ticket #${ticket.id} · ${escapeHTML(ticket.created_at || '')}</p>
        <p style="font-size:0.9em;"><strong>Account:</strong> <a href="/user/${escapeHTML(ticket.username)}" style="color:var(--text-color);">@${escapeHTML(ticket.username)}</a></p>
        <p style="font-size:0.9em;"><strong>Contact email:</strong> ${escapeHTML(ticket.email)}</p>
        <p style="font-size:0.9em;"><strong>Status:</strong> ${statusLabel}</p>
        ${ticket.status === 'resolved' && ticket.resolution_note ? `<p style="font-size:0.9em;"><strong>Resolution note:</strong> <span style="white-space:pre-wrap;word-break:break-word;">${escapeHTML(ticket.resolution_note)}</span></p>` : ''}
        ${ipSectionHTML}
        <hr style="border-color:rgba(255,255,255,0.15);margin:14px 0;">
        <div style="word-break:break-word;overflow-wrap:break-word;">${renderMarkdown(ticket.message)}</div>
        <form method="POST" action="/admin/support/${ticket.id}/status" class="action-row" style="display:block;">
            ${ticket.status === 'open' ? `
            <label>Resolution note <span style="opacity:0.4;">(optional)</span></label>
            <textarea name="reason" rows="2" maxlength="${MAX_SUPPORT_MSG_LENGTH}" placeholder="What was done to resolve this..." style="width:100%;box-sizing:border-box;font-family:inherit;padding:6px;margin-bottom:8px;resize:vertical;"></textarea>
            ` : ''}
            <input type="hidden" name="status" value="${ticket.status === 'open' ? 'resolved' : 'open'}">
            <button type="submit" class="button" style="width:auto;padding:8px 16px;">${ticket.status === 'open' ? 'Mark Resolved' : 'Reopen'}</button>
        </form>
    </div>

    <div class="panel">
        <h2>Replies</h2>
        ${repliesHTML || '<p style="opacity:0.4;font-size:0.85em;">No replies yet.</p>'}
        <hr style="border-color:rgba(255,255,255,0.15);margin:14px 0;">
        <form method="POST" action="/admin/support/${ticket.id}/reply">
            <label>Reply <span style="opacity:0.4;">(emailed to ${escapeHTML(ticket.email)})</span></label>
            <textarea class="box" name="reply" placeholder="Type your reply..." required maxlength="${MAX_SUPPORT_MSG_LENGTH}" rows="6" style="width:100%;resize:vertical;font-family:inherit;padding:8px;box-sizing:border-box;"></textarea>
            <div class="action-row">
                <button type="submit" class="button" style="width:auto;padding:8px 16px;">Send Reply</button>
            </div>
        </form>
    </div>
</div>
${SUPPORT_NAV_SCRIPT}
</body>
</html>`);
        });
        });
    });
});

app.post('/admin/support/:id/status', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).send('Ticket not found.');
    const status = req.body.status;
    if (status !== 'open' && status !== 'resolved') return res.redirect(`/admin/support/${id}?error=` + encodeURIComponent("Status must be 'open' or 'resolved'."));
    const reason = (req.body.reason || '').trim().slice(0, MAX_SUPPORT_MSG_LENGTH);
    // Reopening clears any note from a previous resolution rather than leaving a stale one attached
    // to a now-open ticket.
    const resolutionNote = status === 'resolved' ? (reason || null) : null;
    db.run(`UPDATE Support_Tickets SET status = ?, resolution_note = ? WHERE id = ?`, [status, resolutionNote, id], function (err) {
        if (err || this.changes === 0) return res.redirect(`/admin/support/${id}?error=` + encodeURIComponent('Failed to update ticket.'));
        logAudit(status === 'resolved' ? 'support_ticket_resolved' : 'support_ticket_reopened', req.session.userUsername, null, `ticket #${id}` + (resolutionNote ? ` - ${resolutionNote}` : ''));
        res.redirect(`/admin/support/${id}`);
    });
});

app.post('/admin/support/:id/reply', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).send('Ticket not found.');
    const reply = (req.body.reply || '').trim();
    if (!reply) return res.redirect(`/admin/support/${id}?error=` + encodeURIComponent('Reply cannot be empty.'));
    if (reply.length > MAX_SUPPORT_MSG_LENGTH) return res.redirect(`/admin/support/${id}?error=` + encodeURIComponent(`Reply too long - ${MAX_SUPPORT_MSG_LENGTH} character limit.`));

    db.get(`SELECT id, username, email, subject, message FROM Support_Tickets WHERE id = ?`, [id], (err, ticket) => {
        if (err) return res.redirect(`/admin/support/${id}?error=` + encodeURIComponent('Failed to load ticket.'));
        if (!ticket) return res.status(404).send('Ticket not found.');

        const admin = req.session.userUsername;
        db.run(`INSERT INTO Support_Ticket_Replies (ticket_id, admin_username, message) VALUES (?, ?, ?)`,
            [id, admin, reply], async function (err2) {
                if (err2) return res.redirect(`/admin/support/${id}?error=` + encodeURIComponent('Failed to save reply.'));
                logAudit('support_ticket_replied', admin, ticket.username, `ticket #${id}`);
                const sent = await sendSupportReplyEmail(ticket, reply, admin);
                res.redirect(`/admin/support/${id}?sent=${sent ? '1' : '0'}`);
            });
    });
});

module.exports = { SUPPORT_NAV_SCRIPT, renderSupportTopbar };
