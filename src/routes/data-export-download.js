// Data export download link (registered before the ban guards on purpose).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app } = require('../app');
const { DATA_EXPORTS_DIR } = require('../data-export/core');
const { getStmt } = require('../db/connection');
const { renderMessagePage } = require('../render/pages');
const siteState = require('../site-state');

// Link-mode downloads.
app.get('/data-export/download/:id/:token', (req, res) => {
    if (siteState.readOnlyModeEnabled) return res.status(403).send(renderMessagePage('Read-only mode', 'Downloads are paused',
        `<h3>Biodeck is in read-only mode, so data exports can't be downloaded right now. Please try again later.</h3><br><br>
        <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>`));
    const gone = () => res.status(404).send(renderMessagePage('Link expired', 'This download link is no longer valid',
        `<h3>Links expire after a while. You can request your data again.</h3><br><br>
        <button type="button" class="button" style="width: 150px" onclick="window.location.href='/';">Go to homepage</button>`));
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) return gone();
        const row = getStmt(`SELECT id, username, status, delivery, file_path, token_hash, expires_at FROM Data_Export_Requests WHERE id = ?`).get(id);
        if (!row || row.status !== 'sent' || row.delivery !== 'link' || !row.file_path || !row.token_hash) return gone();
        if (!(new Date(row.expires_at).getTime() > Date.now())) return gone();
        const given = crypto.createHash('sha256').update(String(req.params.token)).digest();
        const want = Buffer.from(row.token_hash, 'hex');
        if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return gone();
        const file = path.join(DATA_EXPORTS_DIR, path.basename(row.file_path));
        if (!fs.existsSync(file)) return gone();
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Robots-Tag', 'noindex');
        res.download(file, `biodeck-data-${row.username}.tar.gz`, (err) => { if (err && !res.headersSent) gone(); });
    } catch (e) {
        console.error('Data export download error:', e.message);
        if (!res.headersSent) res.status(500).end();
    }
});
