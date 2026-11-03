// Editor and v86 pages.
const path = require('path');
const { app } = require('../app');
const { ROOT_DIR } = require('../paths');

app.get('/editor', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    res.sendFile(path.join(ROOT_DIR, 'editor.html'));
});

app.get('/v86', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    res.sendFile(path.join(ROOT_DIR, 'public', 'index.html'));
});
