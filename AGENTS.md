# AGENTS.md

Guidance for AI coding agents (and humans) working in the **Biodeck** repository.

## What this is

Biodeck is a social-media web app - think a small
Twitter like stack with a feed, DMs, group chats, friends/follows, notifications,
an admin panel, and email-based support tickets. It's a single Node.js/Express server
that renders server-side HTML fragments for its own frontend, plus a newer clean JSON
API under `/api/v1/*` for custom clients.

License: Unlicense (public domain)

## Tech stack

- **Runtime**: Node.js, CommonJS (`"type": "commonjs"` in package.json)
- **Server**: Express 5
- **DB**: better-sqlite3 (synchronous SQLite, no separate DB server to run)
- **Auth/session**: express-session + session-file-store, bcrypt for password hashing
- **Uploads**: multer
- **Email**: nodemailer (SMTP, outgoing) + imap/mailparser (IMAP, incoming support replies)
- **Rate limiting**: express-rate-limit
- **Frontend**: plain HTML/CSS/vanilla JS (no framework, no build step) - files served
  directly (`login.html`, `register.html`, `editor.html`, themed error pages, etc.)

There is no bundler, no TypeScript, and no test suite (`npm test` is just a stub that
exits with an error - do not assume tests exist or add a fake pass).

## Repo layout

```
server.js              Main (and only) server entry point - nearly all routes live here
package.json            deps + "start" script (node server.js)
vars.env.public          Template for vars.env (SMTP/IMAP/session config) - copy to vars.env
themes.json              Registered UI themes (name, displayName, css file)
activation-pings.txt     Usernames pinged when a new user registers (only used when the
                         registration gate is enabled)
*.html                   Top-level pages: login, register, editor, 404/503, and themed
                         error pages (admin_access_denied, group_access_denied,
                         login_error_*, register_error_*)
Documentation/
  setup.md               Install/run instructions + how to add a theme
  APIs.md                Full route reference - read this before touching any endpoint
public/
  uploads/               User-uploaded files (attachments, avatars) - gitignored, runtime data
  v86/                   Static assets for an embedded v86 (x86 emulator) feature
```

`vars.env` (git-ignored, not `vars.env.public`) holds real secrets: `SMTP_HOST`,
`SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `APP_BASE_URL`,
`IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASS`, `IMAP_TLS`, `SUPPORT_INBOX_POLL_MS`.
Never commit real values for these - only `vars.env.public` (with placeholder values)
belongs in the repo.

There's no separate build or lint step and no test command to run before committing.
Sanity-check changes by starting the server and hitting the relevant route(s) manually.

## Working with the API / routes

`server.js` contains essentially every route (auth, feed, DMs, groups, notifications,
friends/follows, admin, support). Before adding or changing any endpoint, read
`Documentation/APIs.md` - it documents the exact method, body/query params, and response
shape for every existing route, and explains two things that matter a lot here:

1. **Auth is session-cookie based** (`express-session`), not token-based. There is no
   `Authorization: Bearer` scheme anywhere.
2. **Most legacy routes return pre-rendered HTML fragments** (`{ html: "..." }`), not
   clean JSON - the existing frontend works by splatting that HTML into the DOM. Only
   `/api/v1/*` and a handful of legacy endpoints (`/feed/exists`, `/feed/reply-counts`,
   `/api/friend-status/:username`, `/api/my-friends`, `/api/my-reports`,
   `/notifications/count`) return real structured data.

When adding a new endpoint intended for programmatic/custom-client use, prefer adding it
under `/api/v1/*` (real JSON, no HTML fragments) rather than the legacy pattern, and
update `Documentation/APIs.md`'s table for it in the same change. `/api/v1` routes should
reuse the same internal data-access helpers as the legacy routes rather than duplicating
query logic, so the two stay consistent.

Real-time features use Server-Sent Events (SSE), not WebSockets - follow that existing
pattern for any new live-update feature rather than introducing a new transport.

## Conventions to follow

- Keep `/api/v1/*` responses real JSON only - never an HTML fragment under that prefix.
- Any `/api/*` path that doesn't match a route should keep returning
  `404 { "error": "Not found" }`, not the themed `404.html` page.
- Non-`/api/*` unmatched routes should keep falling through to the themed `404.html`
  (status 404, URL unchanged - not a redirect).
- File uploads (`attachments[]`, `avatar`) are `multipart/form-data`, not JSON - keep new
  upload-accepting routes consistent with that.
- Admin-only routes go through the existing `requireAdmin` (or `requireHeadAdmin` for more
  sensitive ones) middleware - don't hand-roll a new permission check.
- Update `Documentation/APIs.md` whenever you add, remove, or change the shape of a route.
  This file is the source of truth for what the server actually does; keep it accurate
  rather than letting it drift.
- Adding a theme means creating the CSS file and registering it in `themes.json`
  (`name`, `displayName`, `file`) per `Documentation/setup.md` - no other code change
  should be needed for a pure theme addition.

## Things to be careful with

- `vars.env.public` in the repo contains placeholder-looking credentials - treat it as a
  template, not real config, and never replace its placeholders with real secrets in a
  commit.
- `public/uploads` holds user content and is runtime/gitignored data - don't commit
  anything from it.
- Post/message length limits are enforced server-side (posts: 1000 chars, DMs/group
  messages: 4000 chars) - preserve these limits (or update them deliberately and
  consistently on both the server check and any client-side hint) rather than dropping
  them.
- There's no automated test suite, so be extra careful with auth, session, and admin
  permission logic - verify manually against `Documentation/APIs.md`'s expected
  status codes (401 for logged-out, 403 for wrong-permission, 404 for missing).
