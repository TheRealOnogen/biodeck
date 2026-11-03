// Data export request form HTML.
const path = require('path');
const fs = require('fs');
const { DATA_DIR, DATA_EXPORT_CATEGORIES, dxMaskEmail } = require('./core');
const { dxSubjectToken } = require('./token');
const { getStmt } = require('../db/connection');
const { escapeHTML } = require('../render/html');

// HTML: request form

function dxCategoryCheckboxesHTML() {
    return DATA_EXPORT_CATEGORIES.map(c =>
        `<label style="display:flex;align-items:center;gap:8px;margin:5px 0;font-size:0.9em;cursor:pointer;">` +
        `<input type="checkbox" class="dx-cat" value="${c.key}" checked style="width:auto;margin:0;"> ${escapeHTML(c.label)}</label>`
    ).join('');
}

// The "Your Data" block on the ban / deleted screens.
function renderDataRequestBlockHTML(token, email) {
    return `<div class="dx-block" data-token="${escapeHTML(token)}" style="margin:18px 0;text-align:left;">
        <div style="opacity:0.6;font-size:0.85em;margin-bottom:8px;text-align:center;">Your Data</div>
        <p style="font-size:0.85em;opacity:0.75;margin:0 0 8px;text-align:center;">You can request a copy of your data. We'll email it to <strong>${escapeHTML(dxMaskEmail(email))}</strong>.</p>
        <div style="display:inline-block;text-align:left;">${dxCategoryCheckboxesHTML()}</div>
        <div style="text-align:center;margin-top:10px;"><button type="button" class="button dx-send" style="width:auto;padding-left:18px;padding-right:18px;">Email me my data</button></div>
        <div class="dx-result" style="margin-top:8px;font-size:0.85em;text-align:center;min-height:1.2em;"></div>
    </div>
    <script>
    (function () {
        var block = document.querySelector('.dx-block');
        if (!block) return;
        var btn = block.querySelector('.dx-send');
        var out = block.querySelector('.dx-result');
        btn.addEventListener('click', function () {
            var cats = [];
            block.querySelectorAll('.dx-cat').forEach(function (c) { if (c.checked) cats.push(c.value); });
            if (!cats.length) { out.style.color = 'var(--danger-light-color)'; out.textContent = 'Choose at least one thing to include.'; return; }
            btn.disabled = true; out.style.color = ''; out.textContent = 'Sending request...';
            fetch('/account/data-export', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: block.getAttribute('data-token'), categories: cats })
            }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
              .then(function (res) {
                if (!res.ok) { out.style.color = 'var(--danger-light-color)'; out.textContent = res.d.error || 'Could not send the request.'; btn.disabled = false; return; }
                out.style.color = 'var(--accent-color)';
                out.textContent = 'Request received. Your data will be emailed to ' + res.d.sentTo + ' shortly.';
              }).catch(function () { out.style.color = 'var(--danger-light-color)'; out.textContent = 'Network error.'; btn.disabled = false; });
        });
    })();
    <\/script>`;
}

// Synchronous on purpose (better-sqlite3 is): the ban / deleted screens build their HTML right
// after destroying the session.
function dxRequestBlockForUserSync(userId, state) {
    try {
        const archive = getStmt(`SELECT id, email, email_verified, filename FROM Data_Archives WHERE user_id = ? ORDER BY id DESC LIMIT 1`).get(userId);
        const archiveOk = !!(archive && fs.existsSync(path.join(DATA_DIR, archive.filename)));
        let subject;
        if (state === 'gone' || (state === 'deleted' && archiveOk)) {
            if (!archiveOk) return '';
            subject = { type: 'archive', id: archive.id, email: archive.email, verified: archive.email_verified };
        } else {
            const u = getStmt(`SELECT id, email, email_verified FROM User_Data WHERE id = ?`).get(userId);
            if (!u) return '';
            subject = { type: 'user', id: u.id, email: u.email, verified: u.email_verified };
        }
        const note = (msg) => `<div style="margin:18px 0;"><div style="opacity:0.6;font-size:0.85em;margin-bottom:4px;">Your Data</div><p style="font-size:0.85em;opacity:0.7;margin:0;">${msg}</p></div>`;
        if (!subject.email) return note('There is no email address on file for this account, so a data request can\'t be sent. Contact support if you need a copy.');
        if (!subject.verified) return note('The email address on this account was never verified, so we can\'t send your data there. Contact support if you need a copy.');
        return renderDataRequestBlockHTML(dxSubjectToken(subject.type, subject.id), subject.email);
    } catch (e) {
        console.error('Data request block error:', e.message);
        return '';
    }
}

module.exports = { dxCategoryCheckboxesHTML, dxRequestBlockForUserSync, renderDataRequestBlockHTML };
