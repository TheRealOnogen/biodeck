// Custom emoji list and shortcode script.
const { app } = require('../app');
const { EMOJI_SHORTCODE_JS, loadCustomEmojis } = require('../emoji');

// The list the browser uses for autocomplete and the reaction picker.
app.get('/custom-emojis.json', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.json(Array.from(loadCustomEmojis().values()).map(e => ({ name: e.name, url: e.url })));
});
app.get('/emoji-shortcodes.js', (req, res) => {
    res.type('application/javascript; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(EMOJI_SHORTCODE_JS);
});
