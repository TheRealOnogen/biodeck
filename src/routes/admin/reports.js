// Admin reports.
const { requireAdmin } = require('../../admin/helpers');
const { app } = require('../../app');
const { deletePostDescendants, runInIdChunks } = require('../../cascade');
const { db } = require('../../db/connection');
const { broadcastDMDelete, broadcastGCDelete } = require('../../live/events');
const { logAudit } = require('../../moderation');
const { renderAttachmentsHTML } = require('../../render/attachments');
const { escapeHTML } = require('../../render/html');
const { renderMessagePage } = require('../../render/pages');
const { SUPPORT_NAV_SCRIPT, renderSupportTopbar } = require('./support');
const { MAX_SUPPORT_MSG_LENGTH } = require('../support');
const { cleanupAttachmentFiles, getAttachments } = require('../../uploads/files');

// Reports (admin)
// Standalone page, linked from the admin dashboard, listing every report filed via the "Report"
// button on a feed post, DM.
const REPORT_SOURCE_LABELS = { post: 'Post', dm: 'DM', gc: 'Group Chat' };
function reportSourceLink(r) {
    if (r.source_type === 'post') return `<a href="/post/${r.source_id}" style="color:var(--text-color);">#${r.source_id}</a>`;
    if (r.source_type === 'gc') return `<span style="opacity:0.6;">msg #${r.source_id}</span>`;
    return `<span style="opacity:0.6;">msg #${r.source_id}</span>`;
}

app.get('/admin/reports', requireAdmin, (req, res) => {
    db.all(`SELECT id, reporter_username, reported_username, source_type, source_id, content, attachments_json, status, created_at FROM Reports ORDER BY (status = 'open') DESC, id DESC`, [], (err, reports) => {
        if (err) return res.status(500).send('DB error');
        const rows = (reports || []).map(r => {
            const snippet = escapeHTML((r.content || '').trim().slice(0, 80)) + ((r.content || '').length > 80 ? '…' : '');
            const attachmentMarker = r.attachments_json ? ' <span title="Has attachment(s)">📎</span>' : '';
            return `<tr class="ticket-row" onclick="window.location.href='/admin/reports/${r.id}'">
            <td style="opacity:0.5;">#${r.id}</td>
            <td>${REPORT_SOURCE_LABELS[r.source_type] || r.source_type}</td>
            <td><a href="/user/${escapeHTML(r.reported_username)}" onclick="event.stopPropagation();" style="color:var(--text-color);text-decoration:none;">@${escapeHTML(r.reported_username)}</a></td>
            <td><a href="/user/${escapeHTML(r.reporter_username)}" onclick="event.stopPropagation();" style="color:var(--text-color);text-decoration:none;">@${escapeHTML(r.reporter_username)}</a></td>
            <td style="opacity:0.7;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${snippet || '<span style="opacity:0.4;">(no text)</span>'}${attachmentMarker}</td>
            <td>${r.status === 'open' ? '<span style="color:var(--warning-color, #d9a441);font-weight:700;">Open</span>' : '<span style="color:var(--success-color);font-weight:700;">Resolved</span>'}</td>
            <td style="font-size:0.78em;opacity:0.5;white-space:nowrap;">${escapeHTML(r.created_at || '')}</td>
        </tr>`;
        }).join('');

        res.send(`<!DOCTYPE html>
<html lang="en" class="page-admin">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reports</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
<style>
    .table-scroll-wrap { display:block !important; width:100% !important; max-width:100% !important; overflow-x:auto !important; -webkit-overflow-scrolling:touch; }
    .ticket-row { cursor:pointer; }
    .ticket-row:hover { background:rgba(255,255,255,0.05); }
</style>
</head>
<body class="page-admin">
${renderSupportTopbar('Reports')}
<div id="content">
    <h1>Reports</h1>
    <p style="opacity:0.5;margin-top:4px;">Content reported by users from the feed, DMs, and group chats. Click a report to see the full snapshot.</p>

    <div class="panel">
        <div class="table-scroll-wrap">
            <table>
                <thead><tr><th>#</th><th>Source</th><th>Reported</th><th>Reporter</th><th>Content</th><th>Status</th><th>Filed</th></tr></thead>
                <tbody>
                    ${rows || '<tr><td colspan="7" style="opacity:0.4;">No reports.</td></tr>'}
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

app.get('/admin/reports/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).send(renderMessagePage('Not Found', 'Report not found', `<h3>That report doesn't exist.</h3><br><br><button type="button" class="button" style="width: 180px" onclick="window.location.href='/admin/reports';">Back to reports</button>`));

    db.get(`SELECT id, reporter_username, reported_username, source_type, source_id, content, attachments_json, status, created_at, resolution_note FROM Reports WHERE id = ?`, [id], (err, report) => {
        if (err) return res.status(500).send('DB error');
        if (!report) return res.status(404).send(renderMessagePage('Not Found', 'Report not found', `<h3>That report doesn't exist.</h3><br><br><button type="button" class="button" style="width: 180px" onclick="window.location.href='/admin/reports';">Back to reports</button>`));

        let attachments = [];
        if (report.attachments_json) {
            try { attachments = JSON.parse(report.attachments_json) || []; } catch (e) {}
        }
        const attachmentsHTML = renderAttachmentsHTML(attachments, 400, '500px');

        let bannerHTML = '';
        if (req.query.error) bannerHTML = `<p style="color:var(--danger-color);font-weight:700;">${escapeHTML(req.query.error)}</p>`;

        const statusLabel = report.status === 'open'
            ? '<span style="color:var(--warning-color, #d9a441);font-weight:700;">Open</span>'
            : '<span style="color:var(--success-color);font-weight:700;">Resolved</span>';

        res.send(`<!DOCTYPE html>
<html lang="en" class="page-admin">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Report #${report.id}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
<style>
    .report-action-form { margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.1); }
    .report-action-form label { display:block;font-size:0.85em;opacity:0.7;margin-bottom:4px; }
    .report-action-form input, .report-action-form textarea { width:100%;box-sizing:border-box;font-family:inherit;padding:6px;margin-bottom:8px; }
    .report-action-result { font-size:0.85em;margin-top:6px;min-height:1.2em; }
    .report-action-result.ok { color:var(--success-color); }
    .report-action-result.err { color:var(--danger-color); }
</style>
</head>
<body class="page-admin">
${renderSupportTopbar('Report #' + report.id)}
<div id="content">
    <p><a href="/admin/reports" style="color:var(--text-color);opacity:0.6;text-decoration:none;">< Back to reports</a></p>
    ${bannerHTML}
    <input type="hidden" id="report-target-username" value="${escapeHTML(report.reported_username)}">

    <div class="panel">
        <h2>${REPORT_SOURCE_LABELS[report.source_type] || report.source_type} reported</h2>
        <p style="opacity:0.5;font-size:0.85em;margin-top:-6px;">Report #${report.id} · ${escapeHTML(report.created_at || '')}</p>
        <p style="font-size:0.9em;"><strong>Reported account:</strong> <a href="/user/${escapeHTML(report.reported_username)}" style="color:var(--text-color);">@${escapeHTML(report.reported_username)}</a></p>
        <p style="font-size:0.9em;"><strong>Reported by:</strong> <a href="/user/${escapeHTML(report.reporter_username)}" style="color:var(--text-color);">@${escapeHTML(report.reporter_username)}</a></p>
        <p style="font-size:0.9em;"><strong>Source:</strong> ${REPORT_SOURCE_LABELS[report.source_type] || report.source_type} ${reportSourceLink(report)}</p>
        <p style="font-size:0.9em;"><strong>Status:</strong> <span id="report-status-label">${statusLabel}</span></p>
        ${report.status === 'resolved' && report.resolution_note ? `<p style="font-size:0.9em;"><strong>Resolution note:</strong> <span style="white-space:pre-wrap;word-break:break-word;">${escapeHTML(report.resolution_note)}</span></p>` : ''}
        <hr style="border-color:rgba(255,255,255,0.15);margin:14px 0;">
        <p style="opacity:0.5;font-size:0.8em;margin-bottom:4px;">Content at time of report:</p>
        <p style="white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;">${escapeHTML(report.content) || '<span style="opacity:0.4;">(no text)</span>'}</p>
        ${attachmentsHTML}
        <form method="POST" action="/admin/reports/${report.id}/status" class="action-row" style="display:block;">
            ${report.status === 'open' ? `
            <label>Resolution note <span style="opacity:0.4;">(optional)</span></label>
            <textarea name="reason" rows="2" maxlength="${MAX_SUPPORT_MSG_LENGTH}" placeholder="What was done to resolve this..." style="width:100%;box-sizing:border-box;font-family:inherit;padding:6px;margin-bottom:8px;resize:vertical;"></textarea>
            ` : ''}
            <input type="hidden" name="status" value="${report.status === 'open' ? 'resolved' : 'open'}">
            <button type="submit" class="button" style="width:auto;padding:8px 16px;">${report.status === 'open' ? 'Mark Resolved' : 'Reopen'}</button>
        </form>
    </div>

    <div class="panel">
        <h2>Quick Actions <span style="opacity:0.5;font-weight:400;font-size:0.7em;">on @${escapeHTML(report.reported_username)}</span></h2>
        <p style="opacity:0.5;font-size:0.8em;margin-top:-6px;">Take action against the reported account without leaving this page. Each action also deletes the reported content. Ban/Delete also issue a permanent warning first (with the reason you give below and a copy of the reported content attached), so the user has something to see explaining what happened.</p>

        <div class="report-action-form">
            <h3 style="margin-bottom:8px;">Warn</h3>
            <label>Reason (required)</label>
            <textarea id="warn-reason" rows="2" placeholder="Reason for the warning..."></textarea>
            <label>Expires in <span style="opacity:0.5;">(e.g. 30m, 6h, 3d, 2w - blank never expires)</span></label>
            <input type="text" id="warn-duration" placeholder="Leave blank for permanent">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                <input type="checkbox" id="warn-mute" style="width:auto;height:auto;margin:0;">
                Mute user (blocks DMs, group chat, and feed posts/replies) until this warning expires
            </label>
            <button type="button" class="button" style="width:auto;padding:8px 16px;" onclick="reportWarn()">Warn User</button>
            <div id="warn-result" class="report-action-result"></div>
        </div>

        <div class="report-action-form">
            <h3 style="margin-bottom:8px;">Ban</h3>
            <label>Reason</label>
            <textarea id="ban-reason" rows="2" placeholder="Reason for the ban..."></textarea>
            <label>Duration <span style="opacity:0.5;">(e.g. 30m, 6h, 3d, 2w - blank is permanent)</span></label>
            <input type="text" id="ban-duration" placeholder="Leave blank for permanent">
            <button type="button" class="button" style="width:auto;padding:8px 16px;" onclick="reportBan()">Ban Account</button>
            <div id="ban-result" class="report-action-result"></div>
        </div>

        <div class="report-action-form">
            <h3 style="margin-bottom:8px;">Delete Account</h3>
            <label>Reason (required)</label>
            <textarea id="delete-reason" rows="2" placeholder="Reason for deletion..."></textarea>
            <button type="button" class="button" style="width:auto;padding:8px 16px;" onclick="reportDeleteAccount()">Delete Account</button>
            <div id="delete-result" class="report-action-result"></div>
        </div>
    </div>
</div>
${SUPPORT_NAV_SCRIPT}
<script>
    var reportTargetUsername = document.getElementById('report-target-username').value;
    var reportId = ${report.id};

    async function deleteReportedContent(resultEl) {
        try {
            const res = await fetch('/admin/reports/' + reportId + '/delete-content', { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.deleted) {
                resultEl.textContent += ' Reported content deleted.';
            } else if (res.ok) {
                resultEl.textContent += ' (Reported content was already gone.)';
            } else {
                resultEl.textContent += ' (Could not delete the reported content: ' + (data.error || res.status) + ')';
            }
        } catch (e) {
            resultEl.textContent += ' (Network error deleting reported content.)';
        }
    }

    async function reportWarn() {
        const reason = document.getElementById('warn-reason').value.trim();
        const duration = document.getElementById('warn-duration').value.trim();
        const mute = document.getElementById('warn-mute').checked;
        const resultEl = document.getElementById('warn-result');
        if (!reason) { resultEl.className = 'report-action-result err'; resultEl.textContent = 'A reason is required.'; return; }
        resultEl.className = 'report-action-result'; resultEl.textContent = 'Working…';
        try {
            const res = await fetch('/admin/warn/' + encodeURIComponent(reportTargetUsername), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason, duration, mute, reportId })
            });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'report-action-result err'; resultEl.textContent = 'Error: ' + (data.error || res.status); return; }
            resultEl.className = 'report-action-result ok';
            resultEl.textContent = '@' + reportTargetUsername + ' has been warned (' + (data.expiresAt ? 'expires ' + new Date(data.expiresAt).toLocaleString() : 'never expires') + (data.mute ? ', chat muted' : '') + ').';
            await deleteReportedContent(resultEl);
        } catch (e) { resultEl.className = 'report-action-result err'; resultEl.textContent = 'Network error.'; }
    }

    // Issues a warning carrying "reason" and this report's content/
    // attachments before a ban or account deletion goes through - that way
    // the user still has something (the warning email, and their /standing
    // page if the account isn't gone for good) that shows exactly what got
    // them banned/deleted, since the ban/delete emails themselves don't
    // include the reported content. accountAction ('temp_ban', 'perm_ban',
    // or 'delete') is stored on the warning itself and shown in its "What
    // this affects" section - so even after an unban/undelete, the warning
    // still records what happened, separate from the admin's own reason
    // text. When called from reportBan(), duration is passed through so the
    // warning expires alongside the ban instead of outliving it;
    // reportDeleteAccount() leaves it unset (permanent), since a delete has
    // no expiry to match. Errors here are surfaced but don't block the
    // actual ban/delete from proceeding.
    async function issuePreActionWarning(reason, duration, accountAction) {
        try {
            const res = await fetch('/admin/warn/' + encodeURIComponent(reportTargetUsername), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason, duration: duration || '', mute: false, reportId, accountAction })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) return ' (Could not issue the explanatory warning: ' + (data.error || res.status) + ')';
        } catch (e) {
            return ' (Network error issuing the explanatory warning.)';
        }
        return '';
    }

    async function reportBan() {
        const reason = document.getElementById('ban-reason').value.trim() || 'Banned by admin';
        const duration = document.getElementById('ban-duration').value.trim();
        const resultEl = document.getElementById('ban-result');
        resultEl.className = 'report-action-result'; resultEl.textContent = 'Working…';
        const warnNote = await issuePreActionWarning(reason, duration, duration ? 'temp_ban' : 'perm_ban');
        try {
            const res = await fetch('/admin/ban/' + encodeURIComponent(reportTargetUsername), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason, duration })
            });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'report-action-result err'; resultEl.textContent = 'Error: ' + (data.error || res.status) + warnNote; return; }
            resultEl.className = 'report-action-result ok';
            resultEl.textContent = '@' + reportTargetUsername + ' has been banned' + (data.expiresAt ? ' until ' + new Date(data.expiresAt).toLocaleString() : ' permanently') + '.' + warnNote;
            await deleteReportedContent(resultEl);
        } catch (e) { resultEl.className = 'report-action-result err'; resultEl.textContent = 'Network error.' + warnNote; }
    }

    async function reportDeleteAccount() {
        const reason = document.getElementById('delete-reason').value.trim();
        const resultEl = document.getElementById('delete-result');
        if (!reason) { resultEl.className = 'report-action-result err'; resultEl.textContent = 'A reason is required.'; return; }
        if (!confirm('This will reset @' + reportTargetUsername + '\\'s avatar, name, and bio, mark the account as deleted, and delete all of its posts. The account stays in the database and the username is kept. Continue?')) return;
        resultEl.className = 'report-action-result'; resultEl.textContent = 'Working…';
        const warnNote = await issuePreActionWarning(reason, null, 'delete');
        try {
            const res = await fetch('/admin/delete-account/' + encodeURIComponent(reportTargetUsername), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason })
            });
            const data = await res.json();
            if (!res.ok) { resultEl.className = 'report-action-result err'; resultEl.textContent = 'Error: ' + (data.error || res.status) + warnNote; return; }
            resultEl.className = 'report-action-result ok';
            resultEl.textContent = '@' + reportTargetUsername + ' has been deleted.' + warnNote;
            await deleteReportedContent(resultEl);
        } catch (e) { resultEl.className = 'report-action-result err'; resultEl.textContent = 'Network error.' + warnNote; }
    }
<\/script>
</body>
</html>`);
    });
});

app.post('/admin/reports/:id/status', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).send('Report not found.');
    const status = req.body.status;
    if (status !== 'open' && status !== 'resolved') return res.redirect(`/admin/reports/${id}?error=` + encodeURIComponent("Status must be 'open' or 'resolved'."));
    const reason = (req.body.reason || '').trim().slice(0, MAX_SUPPORT_MSG_LENGTH);
    const resolutionNote = status === 'resolved' ? (reason || null) : null;
    db.get(`SELECT reported_username FROM Reports WHERE id = ?`, [id], (err0, report) => {
        db.run(`UPDATE Reports SET status = ?, resolution_note = ? WHERE id = ?`, [status, resolutionNote, id], function (err) {
            if (err || this.changes === 0) return res.redirect(`/admin/reports/${id}?error=` + encodeURIComponent('Failed to update report.'));
            logAudit(status === 'resolved' ? 'report_resolved' : 'report_reopened', req.session.userUsername, report && report.reported_username, `report #${id}` + (resolutionNote ? ` - ${resolutionNote}` : ''));
            res.redirect(`/admin/reports/${id}`);
        });
    });
});

// Deletes the original post/DM/group-chat message a report points at.
app.post('/admin/purge-orphan-replies', requireAdmin, (req, res) => {
    db.all(`SELECT id, file_path, file_name, files_json FROM Posts WHERE reply_to IS NOT NULL AND reply_to NOT IN (SELECT id FROM Posts)`, [], (err, orphans) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!orphans || !orphans.length) return res.json({ ok: true, deleted: 0 });
        const ids = orphans.map(o => o.id);
        const attachments = orphans.reduce((acc, r) => acc.concat(getAttachments(r)), []);
        deletePostDescendants(ids, (e1, descCount) => {
            if (e1) return res.status(500).json({ error: 'db error' });
            runInIdChunks(`DELETE FROM Reactions WHERE post_id IN (%IDS%)`, ids, () => {
                runInIdChunks(`DELETE FROM Notifications WHERE post_id IN (%IDS%)`, ids, () => {
                    runInIdChunks(`DELETE FROM Posts WHERE id IN (%IDS%)`, ids, (e2, n) => {
                        if (e2) return res.status(500).json({ error: 'db error' });
                        cleanupAttachmentFiles(attachments);
                        const total = (n || 0) + (descCount || 0);
                        logAudit('orphan_replies_purged', req.session.userUsername, req.session.userUsername, `${total} post(s)`);
                        res.json({ ok: true, deleted: total });
                    });
                });
            });
        });
    });
});

app.post('/admin/reports/:id/delete-content', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Report not found.' });
    const admin = req.session.userUsername;

    db.get(`SELECT reported_username, source_type, source_id FROM Reports WHERE id = ?`, [id], (err, report) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!report) return res.status(404).json({ error: 'Report not found.' });
        const { reported_username, source_type, source_id } = report;

        if (source_type === 'post') {
            db.get(`SELECT file_path, file_name, files_json FROM Posts WHERE id = ?`, [source_id], (errPre, postRow) => {
                const attachments = getAttachments(postRow);
                db.run(`DELETE FROM Reactions WHERE post_id = ?`, [source_id]);
                db.run(`DELETE FROM Notifications WHERE post_id = ?`, [source_id]);
                db.run(`DELETE FROM Posts WHERE id = ?`, [source_id], function (err2) {
                    if (err2) return res.status(500).json({ error: 'db error' });
                    const deleted = this.changes > 0;
                    if (!deleted) return res.json({ ok: true, deleted });
                    cleanupAttachmentFiles(attachments);
                    deletePostDescendants([source_id], (e, n) => {
                        logAudit('report_content_deleted', admin, reported_username, `post #${source_id}` + (n ? ` (+${n} repl${n === 1 ? 'y' : 'ies'})` : ''));
                        res.json({ ok: true, deleted });
                    });
                });
            });
        } else if (source_type === 'dm') {
            db.get(`SELECT from_user, to_user, file_path, file_name, files_json FROM Messages WHERE id = ?`, [source_id], (err2, msg) => {
                if (err2) return res.status(500).json({ error: 'db error' });
                if (!msg) return res.json({ ok: true, deleted: false });
                const attachments = getAttachments(msg);
                db.run(`DELETE FROM Message_Reactions WHERE message_id = ?`, [source_id]);
                db.run(`DELETE FROM Messages WHERE id = ?`, [source_id], (err3) => {
                    if (err3) return res.status(500).json({ error: 'db error' });
                    cleanupAttachmentFiles(attachments);
                    broadcastDMDelete(msg.from_user, msg.to_user, source_id);
                    logAudit('report_content_deleted', admin, reported_username, `dm #${source_id}`);
                    res.json({ ok: true, deleted: true });
                });
            });
        } else if (source_type === 'gc') {
            db.get(`SELECT group_id, file_path, file_name, files_json FROM Group_Chat_Messages WHERE id = ?`, [source_id], (err2, msg) => {
                if (err2) return res.status(500).json({ error: 'db error' });
                if (!msg) return res.json({ ok: true, deleted: false });
                const attachments = getAttachments(msg);
                db.run(`DELETE FROM Group_Chat_Message_Reactions WHERE message_id = ?`, [source_id]);
                db.run(`DELETE FROM Group_Chat_Messages WHERE id = ?`, [source_id], (err3) => {
                    if (err3) return res.status(500).json({ error: 'db error' });
                    cleanupAttachmentFiles(attachments);
                    db.all(`SELECT username FROM Group_Chat_Members WHERE group_id = ?`, [msg.group_id], (err4, memberRows) => {
                        broadcastGCDelete(msg.group_id, source_id, (memberRows || []).map(r => r.username));
                        logAudit('report_content_deleted', admin, reported_username, `gc #${source_id}`);
                        res.json({ ok: true, deleted: true });
                    });
                });
            });
        } else {
            res.status(400).json({ error: 'Unknown report source type.' });
        }
    });
});
