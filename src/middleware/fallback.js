// JSON error handler and 404 catch-all. Must be registered last.
const path = require('path');
const { app } = require('../app');
const { ROOT_DIR } = require('../paths');

// Malformed JSON anywhere under /api gets a JSON error, not Express's HTML page.
app.use('/api', (err, req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
        return res.status(err.status || 400).json({ error: 'Invalid or too large JSON body.', code: 'invalid_json' });
    }
    next(err);
});

// Catch-all: must stay last so every route/middleware above gets a chance to match first.
app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.status(404).sendFile(path.join(ROOT_DIR, '404.html'));
});
