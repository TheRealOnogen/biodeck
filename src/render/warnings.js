// Warning and standing HTML blocks.
const { getWarningExtras, isWarningActive } = require('../moderation');
const { escapeHTML } = require('./html');

// Renders the "Account Standing" block shown below the ban/delete message and reason.
function renderStandingBlockHTML(status) {
    const color = status === 'Deleted' ? 'var(--gray-color)' : 'var(--danger-color)';
    return `<div style="margin:18px 0;">
        <div style="opacity:0.6;font-size:0.85em;margin-bottom:4px;">Account Standing</div>
        <div style="font-size:1.3em;color:${color};font-weight:700;">${status}</div>
    </div>`;
}

// Renders the same warnings table used on the /standing page.
function renderWarningsTableHTML(warnings) {
    warnings = warnings || [];
    const rows = warnings.map(w => {
        const active = isWarningActive(w);
        const statusHtml = active ? '<span style="color:var(--danger-color);font-weight:700;">Active</span>' : '<span style="opacity:0.5;">Expired</span>';
        const extrasHtml = getWarningExtras(w, 'html').join('');
        return `<tr>
            <td style="font-size:0.85em; word-break: break-word; overflow-wrap: break-word">${escapeHTML(w.reason || '')}${extrasHtml ? `<div style="font-size:0.85em;margin-top:6px;">${extrasHtml}</div>` : ''}</td>
            <td style="font-size:0.78em;opacity:0.6;white-space:nowrap;">${escapeHTML(new Date(w.created_at.replace(' ','T')+'Z').toLocaleString())}</td>
            <td style="font-size:0.78em;opacity:0.6;white-space:nowrap;">${w.expires_at ? escapeHTML(new Date(w.expires_at).toLocaleString()) : 'Never'}</td>
            <td>${statusHtml}</td>
        </tr>`;
    }).join('');
    return `<div style="text-align:left;">
        <div style="opacity:0.6;font-size:0.85em;margin-bottom:8px;text-align:center;">Warnings</div>
        ${warnings.length ? `
        <style>
            .table-scroll-wrap { display:block !important; width:100% !important; max-width:100% !important; overflow-x:auto !important; -webkit-overflow-scrolling:touch; }
            .table-scroll-wrap > table { width:max-content !important; min-width:100% !important; }
        </style>
        <div class="table-scroll-wrap">
        <table>
            <thead><tr><th>Reason</th><th>Issued</th><th>Expires</th><th>Status</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
        </div>` : `<p style="opacity:0.4;font-size:0.8em;margin:0;text-align:center;">No warnings on record.</p>`}
    </div>`;
}

// Lighter-weight version of renderWarningsTableHTML for the /standing page.
function renderWarningsSummaryHTML(warnings) {
    warnings = warnings || [];
    const rows = warnings.map(w => {
        const active = isWarningActive(w);
        const statusHtml = active ? '<span style="color:var(--danger-color);font-weight:700;">Active</span>' : '<span style="opacity:0.5;">Expired</span>';
        return `<tr>
            <td style="font-size:0.85em; word-break: break-word; overflow-wrap: break-word"><a href="/standing/${w.id}" style="color:var(--text-color);text-decoration:underline;">${escapeHTML(w.reason || '(no reason given)')}</a></td>
            <td style="font-size:0.78em;opacity:0.6;white-space:nowrap;">${escapeHTML(new Date(w.created_at.replace(' ','T')+'Z').toLocaleString())}</td>
            <td style="font-size:0.78em;opacity:0.6;white-space:nowrap;">${w.expires_at ? escapeHTML(new Date(w.expires_at).toLocaleString()) : 'Never'}</td>
            <td>${statusHtml}</td>
        </tr>`;
    }).join('');
    return `<div style="text-align:left;">
        <div style="opacity:0.6;font-size:0.85em;margin-bottom:8px;text-align:center;">Warnings <span style="opacity:0.7;">(click a reason for details)</span></div>
        ${warnings.length ? `
        <style>
            .table-scroll-wrap { display:block !important; width:100% !important; max-width:100% !important; overflow-x:auto !important; -webkit-overflow-scrolling:touch; }
            .table-scroll-wrap > table { width:max-content !important; min-width:100% !important; }
        </style>
        <div class="table-scroll-wrap">
        <table>
            <thead><tr><th>Reason</th><th>Issued</th><th>Expires</th><th>Status</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
        </div>` : `<p style="opacity:0.4;font-size:0.8em;margin:0;text-align:center;">No warnings on record.</p>`}
    </div>`;
}

module.exports = { renderStandingBlockHTML, renderWarningsSummaryHTML, renderWarningsTableHTML };
