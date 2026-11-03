// Download route for uploads.
const { app } = require('../app');
const { serveUpload } = require('../uploads/access');

// Uploaded files live on disk under a randomized, sanitized name.
app.get('/uploads/download/:filename', (req, res) => serveUpload(req, res, true));
