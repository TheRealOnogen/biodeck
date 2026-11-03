// Global guards: bans, email verification, read-only mode.
const { app } = require('../app');
const { checkBan, checkIPBan } = require('./ban');
const { checkEmailVerified } = require('./email-verified');
const { readOnlyPageInjector, readOnlyWriteGuard } = require('./read-only');

app.use(checkIPBan);
app.use(checkBan);
app.use(checkEmailVerified);

// Read-only mode (see "Read-only mode" above). Both are no-ops while it is off.
app.use(readOnlyPageInjector);
app.use(readOnlyWriteGuard);
