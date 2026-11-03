// Forces email verification before the app is usable.
const { db } = require('../db/connection');

// Blocks any fully-logged-in session whose email hasn't been verified yet, bouncing it to the
// verify-email hold page.
function checkEmailVerified(req, res, next) {
    if (!req.session.userId) return next();
    // Let the verification flow itself, and logging out, stay reachable.
    if (req.path === '/account/verify-email' || req.path.startsWith('/account/verify-email-required') || req.path === '/logout') {
        return next();
    }
    db.get(`SELECT email, email_verified FROM User_Data WHERE id = ?`, [req.session.userId], (err, user) => {
        // Fail CLOSED on a DB error: letting the request through here would let an unverified
        // session act for as long as the DB is erroring.
        if (err) {
            console.error('checkEmailVerified DB error:', err.message);
            return res.status(503).send('Temporarily unavailable. Please try again in a moment.');
        }
        if (!user) return next();
        if (!user.email) {
            // Legacy account with no email: same hold as at login, instead of letting an old
            // session slip past verification entirely.
            const userId = req.session.userId;
            const username = req.session.userUsername;
            req.session.pendingEmailUserId = userId;
            req.session.pendingEmailUsername = username;
            delete req.session.userId;
            delete req.session.userUsername;
            return res.redirect('/account/add-email');
        }
        if (!user.email_verified) {
            const userId = req.session.userId;
            const username = req.session.userUsername;
            req.session.pendingVerifyUserId = userId;
            req.session.pendingVerifyUsername = username;
            delete req.session.userId;
            delete req.session.userUsername;
            return res.redirect('/account/verify-email-required');
        }
        next();
    });
}

// Gate for every route that accepts multipart uploads.
function requireVerifiedForUpload(req, res, next) {
    const wantsHTML = String(req.headers.accept || '').includes('text/html');
    const refuse = (status, message, redirectTo) =>
        wantsHTML ? res.redirect(redirectTo) : res.status(status).json({ error: message });
    if (!req.session || !req.session.userId) return refuse(401, 'Not logged in.', '/');
    db.get(`SELECT email, email_verified FROM User_Data WHERE id = ?`, [req.session.userId], (err, user) => {
        if (err) return res.status(500).json({ error: 'Something went wrong.' });
        if (!user || !user.email || !user.email_verified) {
            return refuse(403, 'Verify your email address before uploading files.', '/account/verify-email-required');
        }
        next();
    });
}

module.exports = { checkEmailVerified, requireVerifiedForUpload };
