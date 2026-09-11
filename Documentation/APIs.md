# Biodeck API Reference

This documents every route in `server.js` for anyone building a custom client.

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
| POST | `/register` | body: `username, password, email` | Redirect to `/feed` or `/account/verify-email-required` on success; re-renders `register.html` with an error on failure |
| POST | `/login` | body: `username, password` | Redirect to `/feed` on success. Rate-limited (`authLimiter`). On failure, returns a full HTML error page (banned/deleted/invalid credentials/pending email) with an appropriate status code |
| GET | `/logout` | — | Destroys session, redirects to `/` |
| POST | `/account/add-email` | body: `email` | For accounts created before email was required |
| POST | `/account/verify-email-required/resend` | — | Resends verification email |
| POST | `/account/verify-email-required/change` | body: `email` | Changes pending verification email |
| GET | `/account/verify-email?token=...` | query: `token` | Verifies email via emailed link |
| POST | `/forgot-password` | body: `username` | Sends reset email |
| POST | `/reset-password` | body: `token, password, confirm_password` | Resets password |
| POST | `/account/delete-self` | body: `password` | **JSON.** Soft-deletes own account after password confirmation |
| POST | `/account/email/request-code` | body: `new_email` | **JSON.** Sends a confirmation code to a new email |
| POST | `/account/email/confirm` | body: `code` | **JSON.** Confirms the email change |
| POST | `/edit/nickname` | multipart form | Redirect. Updates display nickname |
| POST | `/edit/bio` | body: `bio` | Redirect. Updates bio |
| POST | `/edit/avatar` | multipart (`avatar` file) | Redirect. Updates avatar image |
| POST | `/edit/theme` | body: `theme` | Redirect. Updates saved theme preference |
| GET | `/api/check-ban-status` | — | **JSON.** `{ banned, type: 'ip'|'account'|'deleted', reason, expiresAt? }`. Polled by the client to detect a ban/deletion mid-session |
| GET | `/api/user-events/stream` | — | **SSE.** Per-user push channel, currently used to notify the client it's just been banned so it can bounce to the ban screen |

## Feed (public posts)

Posts support optional file attachments (up to 5 per post, `multipart/form-data`, field name `attachments`). Max post length is **1000 characters**.

| Method | Path | Body / Query | Response |
|---|---|---|---|
| POST | `/feed/post` | multipart: `content, reply_to?, attachments[]` | Redirect to `/feed` or `/post/:reply_to`. `reply_to` (post id) makes it a reply |
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

## Direct messages

Max message length **4000 characters**, up to **10 attachments** per message.

| Method | Path | Body / Query | Response |
|---|---|---|---|
| POST | `/messages/:username/send` | multipart: `content, reply_to?, attachments[]` | **JSON.** `{ ok: true, id }`. Also pushes an SSE `message` event (HTML bubble) to both participants |
| POST | `/messages/:username/mark-read` | — | Plain 200, no body |
| POST | `/messages/:username/delete/:id` | — | Plain 200/403/404. Sender-only. Pushes SSE `delete` event |
| POST | `/messages/:username/edit/:id` | body: `content` | **JSON.** `{ ok: true }`. Pushes SSE `edit` event |
| GET | `/messages/:username/stream` | — | **SSE.** Events: `message`, `edit`, `delete` — each carries `{ event, html, id }` (delete only has `id`) |

## Notifications

| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/notifications/poll?after=<id>` | `after` | **JSON (HTML fragment).** `{ html, lastId }` |
| GET | `/notifications/count` | — | **JSON, real data.** `{ count }` — unread count, used for the nav badge |
| POST | `/notifications/mark-read` | — | **JSON.** `{ ok: true }` — marks all as read |
| POST | `/notifications/clear` | — | **JSON.** `{ ok: true }` — deletes all notifications |

Notification types generated internally: `friend_request`, `friend_accept`, `friend_decline`, `dm`, `reply`, `mention_post`, `mention_dm`.

## Group chats

Members must be friends with the inviter to be added. Group creator has kick privileges. Max message length/attachments same as DMs.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/groups/create` | `{ name, members: [username,...] }` (JSON body, up to 49 members) | **JSON.** `{ ok: true, id }` |
| POST | `/groups/:id/add-member` | `{ username }` | **JSON.** `{ ok: true }` |
| POST | `/groups/:id/leave` | — | **JSON.** `{ ok: true }`. Deletes the group if it empties out |
| POST | `/groups/:id/kick/:username` | — | **JSON.** `{ ok: true }`. Creator-only |
| POST | `/groups/:id/send` | multipart: `content, reply_to?, attachments[]` | **JSON.** Pushes SSE `message` event to all members |
| POST | `/groups/:id/delete/:msgId` | — | Plain 200/403/404 |
| POST | `/groups/:id/edit/:msgId` | body: `content` | **JSON.** `{ ok: true }` |
| GET | `/groups/:id/stream` | — | **SSE.** Events: `message`, `edit`, `delete`, same shape as DM stream |

## Admin-only APIs (`requireAdmin`, some `requireHeadAdmin`)

These aren't relevant to a normal client but are listed for completeness — all return JSON:

`/admin/tables-partial`, `/admin/dashboard`, `/admin/ban/:username`, `/admin/unban/:username`, `/admin/warn/:username`, `/admin/warnings/:username`, `/admin/warnings/:id/revoke`, `/admin/registration-gate` (GET/POST, POST is head-admin-only), `/admin/profile/:username` (+ `/text`, `/email`, `/avatar`, `/reset-avatar`), `/admin/delete-account/:username`, `/admin/delete-account-permanent/:username` (head-admin-only), `/admin/ipban`, `/admin/unipban`, `/admin/ipbans`, `/admin/badges/:username` (GET/POST), `/admin/pin/:id`, `/admin/unpin/:id`, `/admin/users`, `/admin/reports/:id`, `/admin/reports/:id/delete-content`.

A few admin routes (`/admin/support`, `/admin/support/:id`, `/admin/reports`, and the `/status`/`/reply` POSTs on both) render/redirect HTML instead of JSON.

## Misc

| Method | Path | Notes |
|---|---|---|
| GET | `/uploads/download/:filename?name=...` | Serves an uploaded attachment for download |
| GET | `/theme.css` | Dynamic CSS based on saved theme preference |
| GET | `/support`, POST `/support` | Support ticket form |

---

## Practical notes for a custom client

- **Session cookie**: after a successful `/login`, store the `Set-Cookie` header and send it on every subsequent request.
- **CSRF/forms**: none of the JSON POST endpoints appear to require a CSRF token beyond the session cookie itself — but note several endpoints (`/feed/post`, `/edit/*`, `/feed/delete/:id`) respond with redirects/empty bodies rather than JSON, since they're designed for a `<form>` POST or `fetch` where the frontend just reloads the relevant DOM section.
- **File uploads**: any endpoint accepting `attachments[]`/`avatar` needs `multipart/form-data`, not JSON.
- **Polling model**: there's no single "get full feed as JSON" endpoint — the initial page load (`GET /feed`, `GET /messages/:username`, etc.) renders the first batch server-side as part of the HTML page itself, then `.../poll` and `.../older` (or SSE) handle the rest. If you want the initial batch as data, you'd need to scrape it out of the HTML of the page route rather than an API call.
- **IDs, not cursors**: pagination/polling everywhere uses numeric post/message IDs (`after`, `before`) rather than timestamps or opaque cursors.
