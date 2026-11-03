// Express rate limiters.
const rateLimitForAuth = require('express-rate-limit');
const rateLimit = require('express-rate-limit');
const { sendPostRejection } = require('./post-spam');

const authLimiter = rateLimitForAuth({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait a few minutes and try again.' }
});
const postRateLimiter = rateLimit({
    windowMs: 5 * 1000,
    max: 10,
    message: 'please stop spamming',
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
        const replyTo = req.body && req.body.reply_to ? parseInt(req.body.reply_to) : null;
        const backTo = replyTo ? `/post/${replyTo}` : '/feed';
        // res.redirect(429, `${backTo}?posterror=ratelimit`);
        sendPostRejection(req, res, 429, "You're posting too fast. Please slow down.");
    }
});

module.exports = { authLimiter, postRateLimiter };
