// for all who enter here
// this code holds up with hopes and dreams
// even AI doesn't fully understand it
// if you decide to edit this and spend time suffering
// please leave your name below

// Onogen

// Load order matters: middleware and routes register in the order they are required.
require('./src/env');
require('./src/session');
require('./src/mail');
require('./src/mail-inbound');
require('./src/config');
require('./src/uploads/quota');
require('./src/uploads/avatars');
require('./src/live/events');
require('./src/emoji');
require('./src/routes/emoji');
require('./src/routes/uploads');
require('./src/db/connection');
require('./src/db/schema');
require('./src/middleware/core');
require('./src/data-export/core');
require('./src/data-export/worker');
require('./src/routes/data-export-download');
require('./src/middleware/guards');
require('./src/routes/status');
require('./src/routes/auth');
require('./src/security/email-validation');
require('./src/security/signup');
require('./src/security/captcha');
require('./src/routes/support');
require('./src/routes/dashboard');
require('./src/routes/account');
require('./src/routes/feed');
require('./src/security/post-spam');
require('./src/security/chat-limits');
require('./src/routes/following-feed');
require('./src/routes/post');
require('./src/routes/friends');
require('./src/routes/blocks');
require('./src/routes/profile');
require('./src/routes/messages');
require('./src/routes/notifications');
require('./src/routes/admin/dashboard');
require('./src/routes/admin/moderation');
require('./src/routes/admin/site-settings');
require('./src/routes/admin/users');
require('./src/routes/admin/support');
require('./src/routes/admin/reports');
require('./src/routes/groups');
require('./src/routes/group-chat');
require('./src/routes/api-v1');
require('./src/routes/misc');
require('./src/api/auth-helpers');
require('./src/routes/api-auth');
require('./src/api/client-codes');
require('./src/middleware/fallback');

const { app } = require('./src/app');
const { PORT } = require('./src/config');
const { attachWebSocket } = require('./src/live/websocket');

const server = app.listen(PORT, () => {
    console.log(`Biodeck running on port ${PORT}`);
});
attachWebSocket(server);
