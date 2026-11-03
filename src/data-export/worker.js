// Export job queue and cleanup.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { APP_BASE_URL } = require('../config');
const { dxFilterArchive, dxWriteUserArchive } = require('./collect');
const {
    DATA_DIR,
    DATA_EXPORTS_DIR,
    DATA_EXPORT_CATEGORIES,
    DATA_EXPORT_LINK_TTL_MS,
    DATA_EXPORT_MAX_EMAIL_BYTES,
    DATA_EXPORT_MAX_SIZE_BYTES,
    DATA_EXPORT_UNLIMITED,
    DxUserError,
    dxGet,
    dxRun,
    dxTooLargeError,
} = require('./core');
const { db, getStmt } = require('../db/connection');
const { mailTransporter } = require('../mail');
const { escapeHTML } = require('../render/html');
const siteState = require('../site-state');

// worker

let dxWorkerRunning = false;
function dxKickQueue() {
    if (dxWorkerRunning) return;
    dxWorkerRunning = true;
    (async () => {
        try {
            for (;;) {
                if (siteState.readOnlyModeEnabled) break; // paused; setReadOnlyMode(false) kicks the queue again
                const job = await dxGet(`SELECT * FROM Data_Export_Requests WHERE status = 'pending' ORDER BY id LIMIT 1`);
                if (!job) break;
                await dxRun(`UPDATE Data_Export_Requests SET status = 'processing' WHERE id = ?`, [job.id]);
                await dxProcessJob(job);
            }
        } catch (e) {
            console.error('Data export worker error:', e.message);
        } finally {
            dxWorkerRunning = false;
        }
    })();
}

function dxEmailParts(job, mode, linkUrl, expiresAt) {
    const names = job.categories.split(',').map(k => (DATA_EXPORT_CATEGORIES.find(c => c.key === k) || { label: k }).label);
    const fromArchive = job.subject_type === 'archive';
    const subject = 'Your Biodeck data export';
    const intro = fromArchive
        ? `You asked for a copy of the data from your deleted Biodeck account @${job.username}.`
        : `You asked for a copy of your Biodeck data (account @${job.username}).`;
    const what = `Included: ${names.join(', ')}.`;
    const how = mode === 'link'
        ? `The archive is too large to attach, so you can download it here until ${new Date(expiresAt).toUTCString()}:\n${linkUrl}`
        : 'The archive (a .tar.gz file) is attached. Open it with any archive tool - everything inside is plain JSON plus your uploaded files, and a README.txt explains the layout.';
    const outro = 'If you didn\'t ask for this, you can ignore this email - nothing was shared with anyone else.';
    const text = `${intro}\n\n${what}\n\n${how}\n\n${outro}\n`;
    const html = `<p>${escapeHTML(intro)}</p><p>${escapeHTML(what)}</p>` + (mode === 'link'
        ? `<p>The archive is too large to attach, so you can download it until ${escapeHTML(new Date(expiresAt).toUTCString())}:<br><a href="${escapeHTML(linkUrl)}">${escapeHTML(linkUrl)}</a></p>`
        : `<p>${escapeHTML(how)}</p>`) + `<p style="opacity:0.7;font-size:0.9em;">${escapeHTML(outro)}</p>`;
    return { subject, text, html };
}

async function dxProcessJob(job) {
    const categories = job.categories.split(',').filter(Boolean);
    const tmpName = `export-${job.id}-${crypto.randomBytes(6).toString('hex')}.tar.gz`;
    const dest = path.join(DATA_EXPORTS_DIR, tmpName);
    let keepFile = false;
    try {
        if (job.subject_type === 'user') {
            const u = await dxGet(`SELECT id, username FROM User_Data WHERE id = ?`, [job.subject_id]);
            if (!u) throw new DxUserError('This account no longer exists.');
            await dxWriteUserArchive({ userId: u.id, username: u.username, categories, destPath: dest, source: 'live account' });
        } else {
            const a = await dxGet(`SELECT * FROM Data_Archives WHERE id = ?`, [job.subject_id]);
            const src = a ? path.join(DATA_DIR, a.filename) : null;
            if (!src || !fs.existsSync(src)) throw new DxUserError('The saved copy of this account is no longer available.');
            await dxFilterArchive(src, categories, dest, a);
        }
        const size = fs.statSync(dest).size;
        if (!DATA_EXPORT_UNLIMITED && size > DATA_EXPORT_MAX_SIZE_BYTES) throw dxTooLargeError(size);
        if (!mailTransporter) throw new DxUserError('Email isn\'t set up on this server right now.');
        const from = process.env.SMTP_FROM || process.env.SMTP_USER;
        const downloadName = `biodeck-data-${job.username}-${new Date().toISOString().slice(0, 10)}.tar.gz`;
        let delivery;
        if (size <= DATA_EXPORT_MAX_EMAIL_BYTES) {
            const m = dxEmailParts(job, 'attachment');
            await mailTransporter.sendMail({
                from, to: job.email, subject: m.subject, text: m.text, html: m.html,
                attachments: [{ filename: downloadName, path: dest, contentType: 'application/gzip' }]
            });
            delivery = 'attachment';
        } else {
            const raw = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + DATA_EXPORT_LINK_TTL_MS).toISOString();
            await dxRun(`UPDATE Data_Export_Requests SET file_path = ?, token_hash = ?, expires_at = ? WHERE id = ?`,
                [tmpName, crypto.createHash('sha256').update(raw).digest('hex'), expiresAt, job.id]);
            keepFile = true;
            const link = `${APP_BASE_URL}/data-export/download/${job.id}/${raw}`;
            const m = dxEmailParts(job, 'link', link, expiresAt);
            await mailTransporter.sendMail({ from, to: job.email, subject: m.subject, text: m.text, html: m.html });
            delivery = 'link';
        }
        await dxRun(`UPDATE Data_Export_Requests SET status = 'sent', delivery = ?, size_bytes = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [delivery, size, job.id]);
    } catch (e) {
        console.error(`Data export #${job.id} failed:`, e && e.stack ? e.stack : e);
        keepFile = false;
        const msg = e instanceof DxUserError ? e.message : 'Something went wrong while preparing or sending your data. Please try again later.';
        await dxRun(`UPDATE Data_Export_Requests SET status = 'failed', error = ?, file_path = NULL, token_hash = NULL, expires_at = NULL, completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [msg, job.id]).catch(() => {});
    } finally {
        if (!keepFile) await fs.promises.unlink(dest).catch(() => {});
    }
}

// Deletes expired link-mode files and anything left behind by a crash.
function dxCleanupExports() {
    try {
        const nowIso = new Date().toISOString();
        const expired = getStmt(`SELECT id, file_path FROM Data_Export_Requests WHERE file_path IS NOT NULL AND expires_at IS NOT NULL AND expires_at < ?`).all(nowIso);
        for (const r of expired) {
            fs.promises.unlink(path.join(DATA_EXPORTS_DIR, path.basename(r.file_path))).catch(() => {});
            db.run(`UPDATE Data_Export_Requests SET file_path = NULL, token_hash = NULL WHERE id = ?`, [r.id]);
        }
        const live = new Set(getStmt(`SELECT file_path FROM Data_Export_Requests WHERE file_path IS NOT NULL`).all().map(r => path.basename(r.file_path)));
        for (const name of fs.readdirSync(DATA_EXPORTS_DIR)) {
            if (live.has(name)) continue;
            const full = path.join(DATA_EXPORTS_DIR, name);
            try { if (Date.now() - fs.statSync(full).mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(full); } catch (e) {}
        }
    } catch (e) {
        console.error('Data export cleanup error:', e.message);
    }
}

// Boot: anything that was mid-flight when the process stopped is retried.
setTimeout(() => {
    try { db.run(`UPDATE Data_Export_Requests SET status = 'pending' WHERE status = 'processing'`); } catch (e) {}
    dxKickQueue();
    dxCleanupExports();
}, 3000).unref();
setInterval(dxCleanupExports, 60 * 60 * 1000).unref();

module.exports = { dxKickQueue };
