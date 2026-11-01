# Biodeck API Reference

This documents every route in `server.js` for anyone building a custom client.

## New: `/api/v1/*` - a real JSON API

Everything under `/api/v1/` was added specifically for custom clients. Unlike the legacy routes documented further down, these always return proper structured JSON - no HTML fragments, no scraping required. They sit alongside the old routes rather than replacing them, so Biodeck's own frontend is unaffected; they read from the same tables via shared internal helpers, so the data is guaranteed consistent with what the web UI shows.

Auth is still the session cookie described below - there's no separate token scheme for `/api/v1`. Log in once with `POST /api/v1/auth/login` (see [Authentication endpoints](#authentication-endpoints-apiv1auth)) - or `POST /login` - then send that cookie on every `/api/v1` request same as everything else. All `/api/v1` routes require a logged-in session and return `401 { "error": "Not logged in" }` otherwise. Hitting a path under `/api/v1/` (or any `/api/*` path) that doesn't exist returns `404 { "error": "Not found" }` rather than an HTML page - safe to treat any `/api/*` response as JSON, even a 404.

Pagination on `/api/v1` uses a `before`/`after` post-or-message-id + `limit` query param pattern (never both `before` and `after` at once), and every paginated response includes `hasMore` so you know whether to fetch another page. `limit` is clamped server-side (defaults and caps noted per-route below).

| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/api/v1/me` | — | Your own account: `{ username, nickname, displayName, bio, email, emailVerified, avatarUrl, verified, admin, owner, developer, supporter, theme }` |
| GET | `/api/v1/users/:username` | — | Public profile: `{ username, nickname, displayName, bio, avatarUrl, verified, admin, banned, deleted, isSelf, followerCount, viewerIsFollowing, viewerIsFriend }` |
| GET | `/api/v1/feed` | `before`, `after`, `limit` (default 20, max 50) | `{ posts: [Post...], hasMore }` - top-level posts only, newest first |
| GET | `/api/v1/following-feed` | `before`, `limit` (default 20, max 50) | Same shape as `/api/v1/feed`, scoped to accounts you follow (+ yourself) |
| GET | `/api/v1/post/:id` | — | `{ post: Post }` - a single post by id |
| GET | `/api/v1/post/:id/replies` | `before`, `limit` (default 20, max 50) | `{ replies: [Post...], hasMore }` |
| GET | `/api/v1/messages` | — | `{ conversations: [{ username, lastMessageAt }, ...] }` - your DM inbox |
| GET | `/api/v1/messages/:username` | `before`, `limit` (default 50, max 100) | `{ messages: [Message...], hasMore }` - oldest first. Each message includes its `reactions` (see shapes below) |
| POST | `/api/v1/messages/:username/mark-read` | — | `{ ok: true }` |
| GET | `/api/v1/groups` | — | `{ groups: [{ id, name, createdBy, createdAt, isPublic, members: [username,...] }, ...] }` |
| GET | `/api/v1/groups/public` | — | `{ groups: [{ id, name, createdBy, createdAt, memberCount, viewerIsMember }, ...] }` — every group chat that's currently public, for building a Discover view. Not scoped to your own groups; `viewerIsMember` tells you whether you're already in it |
| GET | `/api/v1/groups/:id/messages` | `before`, `limit` (default 50, max 100) | `{ messages: [GroupMessage...], hasMore }`. Each message includes its `reactions`. `403` if you're not a member |
| POST | `/api/v1/post/:id/react` | body `{ emoji }` | **Toggle** your reaction on a post. `{ ok: true, added, reactions: [Reaction...] }` - `added` is `true` if the reaction was added, `false` if it was removed; `reactions` is the post's full, updated reaction list. `403` if you're muted, `404` if the post doesn't exist |
| POST | `/api/v1/messages/:username/react/:id` | body `{ emoji }` | Same, for a DM message. `403` if you're not part of that conversation. Also pushes the SSE `reaction` event to both participants |
| POST | `/api/v1/groups/:id/react/:msgId` | body `{ emoji }` | Same, for a group message. `403` if you're not a member, `404` if the message isn't in that group. Also pushes the SSE `reaction` event to every member |
| GET | `/api/v1/notifications` | `before`, `limit` (default 50, max 100) | `{ notifications: [Notification...], hasMore }`. **Does not** mark anything as read (unlike the HTML `/notifications` page) - call `POST /notifications/mark-read` when you actually want that |

**Shapes referenced above:**

```jsonc
// Post
{
  "id": 123,
  "author": { "username": "onogen", "nickname": null, "displayName": "onogen", "avatarUrl": "/uploads/avatar-1-....png", "verified": false },
  "content": "post text",
  "createdAt": "2026-09-12T10:00:00Z",
  "edited": false,
  "pinned": false,
  "replyTo": null,           // id of parent post, or null for a root post
  "replyCount": 3,
  "attachments": [ { "url": "/uploads/xyz.png", "downloadUrl": "/uploads/download/xyz.png?name=...", "name": "xyz.png" } ],
  "viewerCanEdit": true,     // true only if this is your own post
  "viewerCanDelete": true,   // true if it's yours, or you're an admin
  "reactions": [ ... ]       // see Reaction below; always present, [] when there are none
}

// Message (DM)
{
  "id": 456,
  "author": { "username": "...", "nickname": null, "displayName": "...", "avatarUrl": null, "verified": false },
  "toUser": "otheruser",
  "content": "hey",
  "createdAt": "...",
  "edited": false,
  "replyTo": null,
  "read": true,
  "mine": true,              // true if you sent it
  "attachments": [ ... ],
  "reactions": [ ... ]       // see Reaction below; always present, [] when there are none
}

// GroupMessage - same as Message but with "groupId" instead of "toUser"/"read"
// (it has the same "reactions" array)

// Reaction - one entry per distinct emoji on a post or message, in the order each emoji was first used
{
  "emoji": "👍",             // the reaction exactly as stored: a Unicode emoji, or ":name:" for a custom emoji
  "count": 2,
  "mine": true,              // true if YOU are one of the people who reacted with this emoji
  "users": ["alice", "bob"], // usernames of everyone who reacted with it
  "customEmojiUrl": null     // e.g. "/emojis/party_cat.gif" when emoji is ":party_cat:" and that custom emoji still
                             // exists; null for Unicode emoji, or for a custom emoji that has since been removed
                             // (in which case just show the ":name:" text)
}

// Notification
{
  "id": 789,
  "type": "reply",           // friend_request | friend_accept | friend_decline | dm | reply | mention_post | mention_dm | mention_gc
  "actor": { "username": "...", "nickname": null, "displayName": "...", "verified": false },
  "postId": 123,
  "messageId": null,
  "preview": "...",
  "read": false,
  "createdAt": "...",
  "link": "/post/123"        // path to navigate to for this notification
}
```

**Reactions in `/api/v1`:** posts, DMs and group messages all carry a structured `reactions` array on read, and each has a JSON react endpoint (the three `POST .../react` rows above) that returns the updated array instead of an HTML chip row. Rules are identical to the legacy routes - see [Reactions](#reactions).

**What's still missing from `/api/v1`:** posting/replying, editing, deleting, friend/follow actions, and group management (create/add/kick/leave/join/toggle-public) all still go through the legacy routes documented below - those already accept plain form fields or JSON bodies and mostly return real JSON already (see the tables further down), so a custom client can mix and match: read via `/api/v1`, write via the legacy write endpoints. If write endpoints under `/api/v1` end up being useful too, they can be added the same way - shout if a specific one would help.

---

## Authentication endpoints (`/api/v1/auth/*`)

JSON in, JSON out. These enforce the same rules as the website (they share the website's rate-limit counter and run the same account-creation code), so they are deliberately a bit more involved than a plain username/password POST. Send `Content-Type: application/json`; form-encoded bodies get `415`. No CORS headers are sent, so browsers on other origins can't call them - native, desktop and server clients can. Keep the session cookie from the response (`Set-Cookie: connect.sid=...`) in a cookie jar and send it back.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/v1/auth/config` | - | `{ authApiAvailable, captchaRequired, turnstileSiteKey, captchaWidgetUrl, registrationOpen, registerMinWaitMs, registerChallengeValidMs }`. Call this first. If `authApiAvailable` is `false` the server has no captcha configured and the auth API is switched off |
| GET | `/api/v1/auth/register-challenge` | - | `{ challenge, minWaitMs, validForMs }`. A signed, single-use token tied to your IP. The server records when it was issued |
| POST | `/api/v1/auth/register` | `{ username, password, email, challenge, captchaToken }` | `201 { ok, status: "verification_required", username }` or `202 { ok, status: "pending_activation", message }` while new accounts need manual activation |
| POST | `/api/v1/auth/login` | `{ username, password, captchaToken }` | `200 { ok: true, user: { username, nickname } }` + session cookie |
| POST | `/api/v1/auth/code-login` | `{ code }` | `200 { ok: true, user: { username, nickname } }` + session cookie. Redeems a **one-time client code** (see below); needs no captcha and no password. `401 invalid_code` for a wrong, used or expired code |
| POST | `/api/v1/auth/logout` | - | `{ ok: true }` |

**Captcha tokens.** When `captchaRequired` is `true`, every register and login call needs a fresh Cloudflare Turnstile token in `captchaToken`. Tokens are single-use. Turnstile site keys are locked to Biodeck's domain, so a client can't render the widget itself: open `captchaWidgetUrl` in a webview, let the user complete it, and read `window.biodeckCaptchaToken` (or the `biodeck-captcha` message posted to `ReactNativeWebView`).

**One-time client codes (for terminals and other clients that can't run a captcha).** `GET /api/v1/auth/config` includes `codeLogin: true` when the server supports it. The user opens Biodeck in any browser or phone where they are already logged in, goes to **Dashboard > Terminal / client login**, presses **Generate Code**, and types the code (`XXXX-XXXX-XXXX`; case, dashes and spaces are ignored) into the client, which sends it to `POST /api/v1/auth/code-login` and keeps the returned `connect.sid` cookie like any other login. A code works **once** (it is consumed even if the account turns out to be banned or locked), only for **the account that created it**, and expires after 10 minutes. Making a new code cancels the previous one. Codes are stored only as SHA-256 hashes in server memory, so a restart invalidates outstanding ones. The captcha isn't bypassed, it already happened when the user logged in on the website: a code can only be created from an authenticated, email-verified session, so a bot can't use this to enter an account it doesn't control. The usual account checks (banned, deleted, lockdown, unverified email) run again at redemption. Redemption shares the login rate limiter (`authLimiter`, 20 attempts per IP per 15 minutes) and creating codes is limited to 10 per account per 15 minutes. Creation and use are written to the audit log as `client_code_created` / `client_code_login`. The dashboard button calls `POST /account/client-code` (JSON body `{}`, session required) which returns `{ code, expiresInMs }`; that route is for the website, not for clients.

**Registering.** (1) `GET register-challenge`. (2) Wait at least `registerMinWaitMs` (2.5 s) - submitting earlier is refused. (3) Get a captcha token. (4) `POST register` within `validForMs` (1 h). A challenge works for one account only, and only from the IP that requested it. Password must be 8-72 bytes; username 3-32 of `a-z A-Z 0-9 _ . -`. New accounts must verify their email (click the emailed link) before `login` succeeds. The usual limits apply: max accounts per email and per IP per day, disposable-email block, registration lockdowns, and an automatic IP ban for creating accounts too fast.

**Error codes** (`{ error, code }`): `invalid_request`, `invalid_json`, `unsupported_media_type` (415), `rate_limited` (429), `captcha_failed` (400), `captcha_not_configured` (503), `bad_challenge` / `challenge_too_early` / `challenge_expired` (400), `invalid_username` / `invalid_password` / `invalid_email` (400), `username_taken` (409), `signup_refused` (limits, disposable email), `registration_closed` (503), `ip_banned` (403, also returned by every `/api/*` route for banned IPs), `invalid_credentials` (401), `invalid_code` (401, code login), `too_many_failures` (429, 10 wrong passwords for one account in 15 min), `email_verification_required` / `email_required` (403), `account_banned` (403, with `reason`, `expiresAt`), `account_deleted` (403), `lockdown` (503).

---

## Read this first: Biodeck is not a clean JSON API

Before diving into endpoints, two things matter a lot for a custom client:

1. **Auth is cookie-based, not token-based.** `/login` and `/register` don't return a token — they set a session cookie (`express-session`) and respond with an HTTP redirect (302), or on failure, a full HTML error page. A custom client needs a cookie jar and needs to treat "redirect to `/feed`" as success and "302/401 to an HTML file" as failure. There's no `Authorization: Bearer` header anywhere.
2. **Most "data" endpoints return pre-rendered HTML, not structured data.** Biodeck's own frontend works by fetching JSON envelopes like `{ html: "<div>...</div>" }` and splatting that HTML into the DOM (this is how it does polling/live updates without a full page reload). So a lot of endpoints below give you a server-rendered fragment, not a clean object you can map over. I've flagged each one. If you want raw structured data for posts/messages, your realistic options are: parse the returned HTML, or use the handful of endpoints that do return real fields (`/feed/exists`, `/feed/reply-counts`, `/api/friend-status/...`, `/api/my-friends`, `/api/my-reports`, `/notifications/count`).

Real-time updates use **Server-Sent Events (SSE)**, not WebSockets. Same pattern applies: SSE payloads mostly carry `html` fragments too.

All endpoints below require a logged-in session unless noted otherwise. Endpoints under `/admin/*` additionally require an admin/head-admin/owner account (`requireAdmin` middleware) — I've grouped those separately since they're not relevant to a normal third-party client.

---

## Auth & Account

| Method | Path | Body / Query | Response |
|---|---|---|---|
| POST | `/register` | body: `username, password, email`, plus `cf-turnstile-response` when captcha is enabled, plus the anti-bot fields `website` (hidden honeypot field, must be empty) and `_t` (milliseconds the signup form was open, must be >= 2500) | Redirect to `/feed` or `/account/verify-email-required` on success; re-renders `register.html` with an error on failure. Missing/invalid captcha token: `400` HTML page. **Account-spam ban:** the 3rd registration attempt from one IP within 20 seconds is refused, and that IP is permanently added to `IP_Bans` (`403` ban page, reason `Stop spamming accounts, ...`). Every successful registration's IP is logged in `Registration_IPs`. **Other refusals:** `400` generic "Registration failed" page if the honeypot `website` field is non-empty or `_t` is missing/under 2500 (a custom client must send `website=""` and a realistic `_t`); `400` for disposable-email domains; `429` if the same mailbox (Gmail dots and `+tags` ignored) already has 3 accounts, or the IP has already created 5 accounts in the last 24h (soft refusal, no ban); `503` + `Retry-After` while a **registration lockdown** is active (see below) |
| POST | `/login` | body: `username, password`, plus `cf-turnstile-response` when captcha is enabled (`503` for non-staff while a [full lockdown](#full-lockdown) is on) | Redirect to `/feed` on success. Rate-limited (`authLimiter`). Missing/invalid captcha token: `400` HTML page (so a custom client can't log in with `username/password` alone once `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY` are set). On failure, returns a full HTML error page (banned/deleted/invalid credentials/pending email) with an appropriate status code |
| GET | `/logout` | — | Destroys session, redirects to `/` |
| POST | `/account/add-email` | body: `email` | For accounts created before email was required |
| POST | `/account/verify-email-required/resend` | — | Resends verification email |
| POST | `/account/verify-email-required/change` | body: `email` | Changes pending verification email |
| GET | `/account/verify-email?token=...` | query: `token` | Verifies email via emailed link |
| POST | `/forgot-password` | body: `username` | Sends reset email |
| POST | `/reset-password` | body: `token, password, confirm_password` | Resets password |
| POST | `/account/delete-self` | body: `password` | **JSON.** `{ ok, deleted, redirect }`. Permanently deletes the account after password confirmation. Everything is first saved to `data/<YYYY-MM-DD>_<username>.tar.gz`; if that fails the account is **not** deleted (`500`) |
| POST | `/account/email/request-code` | body: `new_email` | **JSON.** Sends a confirmation code to a new email |
| POST | `/account/email/confirm` | body: `code` | **JSON.** Confirms the email change |
| POST | `/edit/nickname` | multipart form | Redirect. Updates display nickname |
| POST | `/edit/bio` | body: `bio` | Redirect. Updates bio |
| POST | `/edit/avatar` | multipart (`avatar` file) | Redirect. Updates avatar image |
| POST | `/edit/theme` | body: `theme` | Redirect. Updates saved theme preference |
| POST | `/account/data-export` | JSON body: `categories` (array of `posts`, `dms`, `account`, `support`), `token?` | **JSON.** `{ ok, id, sentTo }` (`sentTo` is the masked address). Queues an archive that is **emailed to the address on the account** (never one from the request). Needs a session, or - for banned/deleted users, who have none - the signed `token` embedded in the ban/deleted screens (valid 2h). `400` no valid category / no verified email, `401` no session or bad token, `429` a request is still being prepared, or you already requested within the last `DATA_EXPORT_COOLDOWN_DAYS` (default 7) - **one successful request per account (and per email address) per week**; that reply is `{ error, code: "export_cooldown", nextRequestAt }` with a `Retry-After` header. Failed exports don't use up the week. `503` SMTP not configured, or the exports folder is full (`code: "export_storage_full"`) |
| GET | `/account/data-export/requests` | — | **JSON.** `{ cooldownDays, nextRequestAt, requests: [{ id, categories, status: 'pending'\|'processing'\|'sent'\|'failed', delivery: 'attachment'\|'link'\|null, error, createdAt, completedAt }] }` - your last 5 requests |
| GET | `/data-export/download/:id/:token` | — | Link-mode download (archive too big to attach, `DATA_EXPORT_MAX_EMAIL_MB`, default 15). Export size: an archive larger than `DATA_EXPORT_MAX_SIZE_MB` (default 1024) is refused with a message asking for fewer categories; set `DATA_EXPORT_UNLIMITED=1` on the server to remove that limit (and the exports-folder cap). No login needed - the emailed token is the credential. Valid `DATA_EXPORT_LINK_TTL_HOURS` (default 168); `404` once expired |
| GET | `/account/deleted` | — | HTML. Landing page after self-deleting an account; offers the data request using a short-lived `dx_token` cookie |
| GET | `/api/check-ban-status` | — | **JSON.** `{ banned, type: 'ip'|'account'|'deleted', reason, expiresAt? }`. Polled by the client to detect a ban/deletion mid-session |
| GET | `/api/user-events/stream` | — | **SSE.** Per-user push channel, currently used to notify the client it's just been banned so it can bounce to the ban screen |

### Registration lockdown

If **10 accounts are created within 60 seconds** (from any IPs combined), registration switches off completely for **3 hours**: `GET /register` and `POST /register` return `503` (with `Retry-After`) and a "registration is temporarily disabled" page, regardless of the registration-gate setting. Logging in is unaffected. The owner and anyone in `activation-pings.txt` get a system DM listing the accounts created in the burst, and the event is written to the audit log (`registration_lockdown_started`). The lockdown is stored in the `Settings` table, so it survives restarts. Head admins can start or end one early from the dashboard or via `/admin/registration-lockdown`.

### Full lockdown

A manual switch (Owners / Head Admins, in the admin dashboard or via `/admin/full-lockdown`) that turns off **both registration and login**. While it's on:

- `GET`/`POST /register` return `503` and a "logins and signups are paused" page.
- `POST /login` returns `503` with the same page for any non-staff account **whose password was correct** (a wrong password or unknown username still gets the normal `401`, so the lockdown can't be probed). Admin, Head Admin and Owner accounts can still log in, so the switch can always be turned back off.
- The emailed verification link (`/account/verify-email`) still marks the email verified but no longer signs the user in.
- The login page (`GET /`) shows a banner; the form stays so staff can log in.
- **Existing sessions are not affected** - logged-in users keep using the site normally.

There's no timer: it stays on until ended, and is stored in `Settings` (`full_lockdown`) so a restart doesn't lift it. It's separate from the automatic timed *registration* lockdown above, which only affects signups.

## Feed (public posts)

Posts support optional file attachments (up to 5 per post, `multipart/form-data`, field name `attachments`). Max post length is **1000 characters**.

| Method | Path | Body / Query | Response |
|---|---|---|---|
| POST | `/feed/post` | multipart: `content, reply_to?, attachments[]` | Redirect to `/feed` or `/post/:reply_to`. `reply_to` (post id) makes it a reply. **Spam protection** (admins exempt) - refusals return JSON `{ error }` (or a small HTML page when the request's `Accept` includes `text/html`): `429` posting timeout - the 3rd accepted post/reply within 10 seconds is refused and the account can't post or reply for **2 hours** (stored in `Post_Timeouts`, survives restarts; requests during the timeout are rejected before any upload is read); `429` for new accounts (under 24h old) posting more than once per 15 seconds; `422` for an identical post within 5 minutes, the same text (20+ chars) from a 4th different account within 10 minutes, more than 5 distinct `@mentions`, or - new accounts only - more than 2 links. Only posts that would otherwise have been accepted count towards the timeout |
| POST | `/feed/delete/:id` | — | Plain 200/403/404 (no body). Only the author or an admin can delete |
| POST | `/feed/edit/:id` | body: `content` | **JSON.** `{ ok: true, html }` — `html` is the freshly rendered post card |
| GET | `/feed/poll?after=<id>` | query: `after` | **JSON (HTML fragment).** `{ html, lastId }` — new posts with id > `after`, for live-updating the feed |
| GET | `/feed/older?before=<id>` | query: `before` | **JSON (HTML fragment).** `{ html, hasMore, oldestId }` — pagination, 10 posts per page |
| GET | `/feed/search?q=...` | query: `q` | **JSON (HTML fragment).** `{ html }` — up to 30 matching top-level posts |
| GET | `/feed/exists?id=1&id=2...` | query: `id` (repeatable) | **JSON, real data.** `{ existing: [ids...] }` — which of the given post IDs still exist |
| GET | `/feed/reply-counts?id=1&id=2...` | query: `id` (repeatable) | **JSON, real data.** `{ counts: { "<id>": n, ... } }` |
| GET | `/feed/edits?id=1&id=2...` | query: `id` (repeatable) | **JSON.** `{ posts: { "<id>": { raw, html } } }` — only for posts currently flagged `edited`. `raw` is the actual current post text (one of the few places you get unrendered content back) |
| GET | `/feed/pinned-bar` | — | Raw HTML string (not JSON) of pinned posts |
| GET | `/feed/reply-counts`, `/feed/poll`, etc. all require login | | 401 JSON `{ error }` otherwise |
| POST | `/report` | body: `type: 'post'|'dm'|'gc', id` | **JSON.** `{ ok: true }` / `409 { error, alreadyReported: true }` on duplicate. Validates you actually had access to the content |
| GET | `/api/my-reports` | — | **JSON, real data.** `{ reports: [{ type, id }, ...] }` — content you've already reported, for graying out report buttons |
| POST | `/post/:id/react` | JSON body: `{ emoji }` | **Toggle** your reaction on a post: adds it if you haven't used that emoji on this post, removes it if you have. Returns **JSON (HTML fragment).** `{ ok: true, html }` — the freshly rendered reaction-chip row. See [Reactions](#reactions) for the rules |

## Following feed

Same shape as the main feed but scoped to accounts you follow (+ yourself).

| Method | Path | Response |
|---|---|---|
| GET | `/following-feed/poll?after=<id>` | **JSON (HTML fragment).** `{ html, lastId }` |
| GET | `/following-feed/older?before=<id>` | **JSON (HTML fragment).** `{ html, hasMore, oldestId }` |

## Single post / thread view

| Method | Path | Response |
|---|---|---|
| GET | `/post/:id/poll?after=<id>` | **JSON (HTML fragment).** New replies to that thread |
| GET | `/post/:id/older?before=<id>` | **JSON (HTML fragment).** Older replies, paginated |

## Friends

| Method | Path | Response |
|---|---|---|
| POST | `/friend-request/send/:username` | **JSON.** `{ ok: true }` |
| POST | `/friend-request/cancel/:username` | **JSON.** `{ ok: true }` |
| POST | `/friend-request/accept/:username` | **JSON.** `{ ok: true }` |
| POST | `/friend-request/decline/:username` | **JSON.** `{ ok: true }` |
| POST | `/unfriend/:username` | **JSON.** `{ ok: true }` |
| GET | `/api/friend-status/:username` | **JSON, real data.** `{ status: 'friends'|'sent'|'received'|'none' }` |
| GET | `/api/my-friends` | **JSON, real data.** `{ friends: [username, ...] }` |

## Follow (one-directional, separate from friends)

| Method | Path | Response |
|---|---|---|
| POST | `/follow/:username` | **JSON.** `{ ok: true, following: true }` |
| POST | `/unfollow/:username` | **JSON.** `{ ok: true, following: false }` |

## Blocking

Blocking works in both directions for contact: neither account can DM, friend-request or follow the other, blocking removes any existing friendship, follow and pending friend requests between the two, and the blocker stops receiving notifications (replies, mentions, DMs, friend requests) from the blocked account. Blocked users can still see and reply to each other's public posts - this is about contact, not visibility. Max 500 blocks per account.

| Method | Path | Response |
|---|---|---|
| POST | `/block/:username` | **JSON.** `{ ok: true, blocked: true }`. `400` blocking yourself or over the 500 limit, `404` unknown user |
| POST | `/unblock/:username` | **JSON.** `{ ok: true, blocked: false }` |
| GET | `/api/my-blocks` | **JSON, real data.** `{ blocks: [username, ...] }` |

While a block exists, `POST /messages/:username/send`, `POST /friend-request/send/:username` and `POST /follow/:username` return `403 { error }` (the DM one also includes `blocked: true`).

## Direct messages

Max message length **4000 characters**, up to **10 attachments** per message.

| Method | Path | Body / Query | Response |
|---|---|---|---|
| POST | `/messages/:username/send` | multipart: `content, reply_to?, attachments[]` | **JSON.** `{ ok: true, id }`. Also pushes an SSE `message` event (HTML bubble) to both participants |
| POST | `/messages/:username/mark-read` | — | Plain 200, no body |
| POST | `/messages/:username/delete/:id` | — | Plain 200/403/404. Sender-only. Pushes SSE `delete` event |
| POST | `/messages/:username/edit/:id` | body: `content` | **JSON.** `{ ok: true }`. Pushes SSE `edit` event |
| POST | `/messages/:username/react/:id` | JSON body: `{ emoji }` | **Toggle** your reaction on a DM message (either participant can react). **JSON (HTML fragment).** `{ ok: true, html }`. Pushes an SSE `reaction` event to both participants. `403` if you're not part of that conversation. See [Reactions](#reactions) |
| GET | `/messages/:username/stream` | — | **SSE.** Events: `message`, `edit`, `delete`, `reaction` — each carries `{ event, html, id }` (delete only has `id`). For `reaction`, `html` is the message's updated reaction-chip row (rendered from your point of view) — it's a fragment, not data; re-fetch `/api/v1/messages/:username` if you need the structured `reactions` |

## Reactions

Posts, DM messages and group chat messages can all be reacted to. There's one write endpoint per kind (documented in the Feed, Direct messages and Group chats tables): `POST /post/:id/react`, `POST /messages/:username/react/:id` and `POST /groups/:id/react/:msgId`. Each also has a structured-JSON twin under `/api/v1` (`POST /api/v1/post/:id/react`, `POST /api/v1/messages/:username/react/:id`, `POST /api/v1/groups/:id/react/:msgId`) that custom clients should prefer. They all work the same way:

- Body is JSON `{ "emoji": "<emoji>" }`. It's a **toggle**: sending an emoji you haven't used on that item adds your reaction; sending it again removes it. A person can stack several *different* emoji on one item, but not the same one twice.
- `emoji` is trimmed and must be non-empty, contain no tabs/newlines, and be at most **100 characters**. (Anything else is accepted as-is — a Unicode emoji, or `:name:` for a custom emoji, see below.) Violations return `400 { error }`.
- Each item can hold at most **24 different emoji** (the limit counts distinct emoji, not total reactions); adding a 25th returns `400 { error }`. Removing is always allowed.
- Muted users can't react to posts (`403`). Not logged in returns `401 { error }`.
- The legacy routes respond `{ ok: true, html }` where `html` is the updated reaction-chip row (a server-rendered fragment). The `/api/v1` routes respond `{ ok: true, added, reactions }` instead: `added` is `true` when the call added your reaction and `false` when it removed it, and `reactions` is the item's full updated [Reaction](#shapes-referenced-above) array, so no re-fetch is needed. Error bodies are the same `{ error }` shape (the `/api/v1` messages have no trailing period).

Posts, DM messages and group messages all **read** reactions through `/api/v1` (the `reactions` array on every `Post`, `Message` and `GroupMessage` — see the Reaction shape above). DM and group chats also get live updates through the SSE `reaction` event on the chat's stream; feed posts have no live reaction push, so poll or re-fetch.

### Custom emoji

Admins can add custom emoji images (see `emojis.json` / `public/emojis/` on the server). Anyone can use them by typing `:name:` in a post, DM, group message or ticket, and they can also be used as reactions — a custom reaction is stored and returned as the literal text `:name:`.

| Method | Path | Response |
|---|---|---|
| GET | `/custom-emojis.json` | **JSON, real data, no login needed.** `[{ name, url }, ...]`, e.g. `[{ "name": "party_cat", "url": "/emojis/party_cat.gif" }]`. Sent with `Cache-Control: no-cache`; the list updates without a server restart |
| GET | `/emojis/:filename` | The image file itself (the `url` from the list above, already URL-encoded) |

Rendering `:name:` in message text: names are letters, numbers, `_` and `-` (max 32 chars) and are **case-insensitive**. The server only converts a token when it's a known emoji and isn't directly preceded by a letter, digit or `/` (so `12:30:45` and `https://host/:thing:` are untouched), and never inside `` `code` `` spans. Message `content` in `/api/v1` is the **raw** text, so a custom client has to do this substitution itself using `/custom-emojis.json`. A message made of nothing but emoji (custom or Unicode, up to 27) is shown larger in the web UI.

## Notifications

| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/notifications/poll?after=<id>` | `after` | **JSON (HTML fragment).** `{ html, lastId }` |
| GET | `/notifications/count` | — | **JSON, real data.** `{ count }` — unread count, used for the nav badge |
| POST | `/notifications/mark-read` | — | **JSON.** `{ ok: true }` — marks all as read |
| POST | `/notifications/clear` | — | **JSON.** `{ ok: true }` — deletes all notifications |

Notification types generated internally: `friend_request`, `friend_accept`, `friend_decline`, `dm`, `reply`, `mention_post`, `mention_dm`.

## Group chats

Members must be friends with the inviter to be added, *unless* the group is public - see below. Group creator has kick privileges. Max message length/attachments same as DMs.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/groups/create` | `{ name, members: [username,...] }` (JSON body, up to 49 members) | **JSON.** `{ ok: true, id }` |
| POST | `/groups/:id/add-member` | `{ username }` | **JSON.** `{ ok: true }` |
| POST | `/groups/:id/leave` | — | **JSON.** `{ ok: true }`. Deletes the group if it empties out |
| POST | `/groups/:id/kick/:username` | — | **JSON.** `{ ok: true }`. Creator-only |
| POST | `/groups/:id/send` | multipart: `content, reply_to?, attachments[]` | **JSON.** Pushes SSE `message` event to all members |
| POST | `/groups/:id/delete/:msgId` | — | Plain 200/403/404 |
| POST | `/groups/:id/edit/:msgId` | body: `content` | **JSON.** `{ ok: true }` |
| POST | `/groups/:id/react/:msgId` | JSON body: `{ emoji }` | **Toggle** your reaction on a group message (members only). **JSON (HTML fragment).** `{ ok: true, html }`. Pushes an SSE `reaction` event to every member. `403` if you're not a member, `404` if the message isn't in that group. See [Reactions](#reactions) |
| GET | `/groups/:id/stream` | — | **SSE.** Events: `message`, `edit`, `delete`, `reaction`, same shape as DM stream |
| POST | `/groups/:id/toggle-public` | — | **JSON.** `{ ok: true, isPublic }`. Creator-only, flips the group's public/private flag. `403` if you're not the creator |
| POST | `/groups/:id/join` | — | **JSON.** `{ ok: true, id }`. Joins a **public** group without needing a friendship or invite. `403 { error: "This group is not public." }` if it isn't public |

### Discover (public group chats)

Any group creator can flip their group to public via `POST /groups/:id/toggle-public`. Public groups are listed on the `/discover` page and can be joined by anyone via `POST /groups/:id/join` - no friendship with a member required (this is the one exception to the "must be friends with the inviter" rule above). Making a group private again just removes it from Discover; existing members are unaffected. For a custom client, the real-data equivalent of the `/discover` page is `GET /api/v1/groups/public` (documented above).

## Admin-only APIs (`requireAdmin`, some `requireHeadAdmin`)

These aren't relevant to a normal client but are listed for completeness — all return JSON:

`/admin/tables-partial`, `/admin/dashboard`, `/admin/ban/:username`, `/admin/unban/:username`, `/admin/warn/:username`, `/admin/warnings/:username`, `/admin/warnings/:id/revoke`, `/admin/registration-gate` (GET/POST, POST is head-admin-only), `/admin/registration-lockdown` (GET: `{ active, until, leftMs }`; POST `{ active: true|false }` starts a 3h lockdown or ends it, head-admin-only), `/admin/full-lockdown` (GET: `{ enabled }`; POST `{ enabled: true|false }`, head-admin-only), `/admin/post-timeouts` (GET: currently timed-out accounts), `/admin/post-timeout/clear/:username` (POST: lift a posting timeout early), `/admin/profile/:username` (+ `/text`, `/email`, `/avatar`, `/reset-avatar`), `/admin/delete-account/:username`, `/admin/delete-account-permanent/:username` (head-admin-only), `/admin/ipban`, `/admin/unipban`, `/admin/ipbans`, `/admin/badges/:username` (GET/POST), `/admin/pin/:id`, `/admin/unpin/:id`, `/admin/users`, `/admin/reports/:id`, `/admin/reports/:id/delete-content`.

A few admin routes (`/admin/support`, `/admin/support/:id`, `/admin/reports`, and the `/status`/`/reply` POSTs on both) render/redirect HTML instead of JSON.

## Misc

| Method | Path | Notes |
|---|---|---|
| GET | `/uploads/download/:filename?name=...` | Serves an uploaded attachment for download |
| GET | `/custom-emojis.json`, `/emojis/:filename` | Custom emoji list and images — see [Custom emoji](#custom-emoji) |
| GET | `/theme.css` | Dynamic CSS based on saved theme preference |
| GET | `/support`, POST `/support` | Support ticket form |
| GET | `/404.html` | Themed "not found" page (matches `/theme.css`). Any unmatched non-`/api/*` route serves this with a `404` status, URL unchanged - not a redirect |

---

## Practical notes for a custom client

- **Session cookie**: after a successful `/login`, store the `Set-Cookie` header and send it on every subsequent request.
- **CSRF/forms**: none of the JSON POST endpoints appear to require a CSRF token beyond the session cookie itself — but note several endpoints (`/feed/post`, `/edit/*`, `/feed/delete/:id`) respond with redirects/empty bodies rather than JSON, since they're designed for a `<form>` POST or `fetch` where the frontend just reloads the relevant DOM section.
- **File uploads**: any endpoint accepting `attachments[]`/`avatar` needs `multipart/form-data`, not JSON.
- **Attachment limits** (feed posts, DMs, group chats; all configurable server-side):
  - **25 MB per file** (`MAX_ATTACHMENT_MB`) and **50 MB per post/message** in total (`MAX_MESSAGE_ATTACHMENTS_MB`).
  - A per-user **storage quota** across everything you've posted (`UPLOAD_QUOTA_MB_PER_USER`, default 512 MB; deleting a post/message frees its share) and a **24-hour upload budget** (`UPLOAD_MB_PER_DAY`, default 200 MB).
  - Uploads are paused if the server disk is nearly full (`UPLOAD_MIN_FREE_DISK_MB`).
  - Rejections: DMs/groups answer `413` (too big / quota), `429` (24h budget) or `503` (disk) with `{ error, code: "upload_limit" }`. `POST /feed/post` answers `422` (or `429` for the 24h budget) with `{ error }` to a `fetch` request.
  - **Images are converted to WebP.** JPG, PNG, GIF (animated GIFs stay animated) and TIFF uploads are re-encoded as `.webp` - the returned attachment `name` ends in `.webp` and metadata such as GPS location is dropped. Still images are shrunk to at most 4096 px on the longest side. The original is kept only if it isn't a real image, can't be decoded, or WebP wouldn't be smaller. Videos, audio, SVG, BMP and other files are stored as uploaded.
- **Polling model**: there's no single "get full feed as JSON" endpoint — the initial page load (`GET /feed`, `GET /messages/:username`, etc.) renders the first batch server-side as part of the HTML page itself, then `.../poll` and `.../older` (or SSE) handle the rest. If you want the initial batch as data, you'd need to scrape it out of the HTML of the page route rather than an API call.
- **Emoji and UTF-8**: the server sends emoji as raw UTF-8, but JSON also allows them as escaped surrogate pairs (like `\ud83d\udd25` for 🔥), so use a decoder that handles both. A hand-rolled decoder that only copes with ASCII `\uXXXX` escapes will turn emoji into `?`.
- **IDs, not cursors**: pagination/polling everywhere uses numeric post/message IDs (`after`, `before`) rather than timestamps or opaque cursors.

---

## Read-only mode, chat rate limits and delete-without-archive

**Read-only mode** (Head Admin / Owner toggle on the admin dashboard, `GET/POST /admin/read-only-mode`, body `{ enabled: true|false }`). While on:

- Every `POST`/`PUT`/`PATCH`/`DELETE` from a regular account is refused with `403 { "error": "...", "code": "read_only" }`, except `login`, `logout`, `/api/v1/auth/login`, `/api/v1/auth/code-login`, `/api/v1/auth/logout`, `/account/client-code`, and read receipts (`/messages/:username/mark-read`, `/notifications/mark-read`, `/api/v1/messages/:username/mark-read`). Browser form posts (`Accept: text/html`) get an HTML page instead of JSON.
- Registration is closed for everyone (`503 registration_closed` on the `/api/v1/auth/register*` routes; `/api/v1/auth/config` reports `registrationOpen: false`).
- Data exports can't be requested (`POST /account/data-export` returns `403 read_only`), queued exports are paused until read-only mode ends, and emailed download links return 403.
- Admin / Head Admin / Owner accounts can still chat and use the admin tools (otherwise nobody could switch it off). Registration and data exports stay blocked for them too.
- Every full HTML page carries a red banner, and regular accounts also get all text fields removed from the page (login and register excepted).

**DM / group chat limits** (admins exempt). Counted per account across all DMs, group chats and edits: max 10 messages per 10 s, 16,000 characters per minute, 120,000 per hour (accounts under 24 h old get half of the two character limits), and an identical message of 50+ characters can't be sent twice within 60 s. A refused send/edit returns `429` (or `422` for the duplicate) with `{ "error": "...", "code": "chat_rate_limited", "retryAfterMs": 12000 }` and a `Retry-After` header. Tunable with env vars `CHAT_BURST_MAX`, `CHAT_BURST_WINDOW_SECONDS`, `CHAT_MINUTE_CHARS`, `CHAT_HOUR_CHARS`, `CHAT_NEW_ACCOUNT_FACTOR`, `CHAT_DUPLICATE_WINDOW_SECONDS`.

**Deleting without an archive.** `POST /account/delete-self`, `/admin/delete-account/:username` and `/admin/delete-account-permanent/:username` still try to write the archive first. If that fails they return `500 { "code": "archive_failed", ... }` and delete nothing. Resending the same request with `"skipArchive": true, "confirmations": 2` (the web UI only does this after two separate confirmation prompts) deletes the account anyway; the archive is still attempted first and only skipped if it fails. The skip is written to the audit log as `account_delete_archive_skipped`.
