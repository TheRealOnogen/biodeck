// Table creation and migrations.
const { db, sqliteDb, stmtCache } = require('./connection');
const {
    loadFullLockdown,
    loadReadOnlyMode,
    loadRegistrationGateSetting,
    loadRegistrationLockdown,
} = require('../site-state');
const { backfillPrivateUploads } = require('../uploads/access');

console.log('Connected to database');
db.run(`PRAGMA journal_mode=WAL`, (err) => {
    if (err) console.error('WAL error:', err.message);
db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS User_Data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE,
                password TEXT,
                IsBanned INTEGER DEFAULT 0,
                BanReason TEXT DEFAULT NULL,
                bio TEXT DEFAULT NULL
            )`);
            db.run(`ALTER TABLE User_Data ADD COLUMN bio TEXT DEFAULT NULL`, () => {});
            db.run(`CREATE TABLE IF NOT EXISTS Messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_user TEXT,
                to_user TEXT,
                content TEXT,
                file_path TEXT DEFAULT NULL,
                file_name TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                read INTEGER DEFAULT 0
            )`);
            db.run(`ALTER TABLE Messages ADD COLUMN file_path TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE Messages ADD COLUMN file_name TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE Messages ADD COLUMN files_json TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE Messages ADD COLUMN reply_to INTEGER DEFAULT NULL`, () => {});
            // Set to 1 the first time a message's content is changed via
            // /messages/:username/edit/:id, so bubbles can show "(edited)".
            db.run(`ALTER TABLE Messages ADD COLUMN edited INTEGER DEFAULT 0`, () => {});
            // DM lookups filter by from_user/to_user on nearly every request (conversation list,
            // thread fetch).
            db.run(`CREATE INDEX IF NOT EXISTS idx_messages_from ON Messages(from_user)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_messages_to ON Messages(to_user)`);
            db.run(`ALTER TABLE User_Data ADD COLUMN IsOwner INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN IsDeveloper INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN IsSupporter INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN IsAdmin INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN IsHeadAdmin INTEGER DEFAULT 0`, () => {});
            // Verified badge (blue checkmark) - toggled by admins from the admin dashboard's Manage
            // Badges panel.
            db.run(`ALTER TABLE User_Data ADD COLUMN IsVerified INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN avatar_path TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN Nickname TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN IsDeleted INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN DeleteReason TEXT DEFAULT NULL`, () => {});
            // Optional expiry timestamp (ISO string) for timed bans.
            db.run(`ALTER TABLE User_Data ADD COLUMN BanExpiresAt TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN email TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE User_Data ADD COLUMN email_verified INTEGER DEFAULT 0`, () => {});
            // Selected CSS theme (see themes.json / loadThemes()).
            db.run(`ALTER TABLE User_Data ADD COLUMN theme TEXT DEFAULT 'default'`, () => {});
            // Multiple accounts are now allowed to share the same email address, so this is a plain
            // (non-unique) index.
            db.run(`DROP INDEX IF EXISTS idx_user_data_email`, () => {
                db.run(`CREATE INDEX IF NOT EXISTS idx_user_data_email ON User_Data(email)`);
            });
            // Password reset tokens.
            db.run(`CREATE TABLE IF NOT EXISTS Password_Resets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT UNIQUE NOT NULL,
                expires_at DATETIME NOT NULL,
                used INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_password_resets_user ON Password_Resets(user_id)`);
            // Self-service email change requests.
            db.run(`CREATE TABLE IF NOT EXISTS Email_Changes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                code_hash TEXT NOT NULL,
                new_email TEXT NOT NULL,
                expires_at DATETIME NOT NULL,
                used INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_email_changes_user ON Email_Changes(user_id)`);
            // Email verification links. token_hash is a sha256 of the raw token that goes out in
            // the emailed link.
            db.run(`CREATE TABLE IF NOT EXISTS Email_Verifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT UNIQUE NOT NULL,
                email TEXT NOT NULL,
                expires_at DATETIME NOT NULL,
                used INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON Email_Verifications(user_id)`);
            db.run(`CREATE TABLE IF NOT EXISTS Posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                username TEXT,
                content TEXT,
                file_path TEXT DEFAULT NULL,
                file_name TEXT DEFAULT NULL,
                reply_to INTEGER DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`ALTER TABLE Posts ADD COLUMN reply_to INTEGER DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE Posts ADD COLUMN pinned INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE Posts ADD COLUMN files_json TEXT DEFAULT NULL`, () => {});
            // Set to 1 the first time a post/reply's content is changed via /feed/edit/:id, so it
            // can show an "(edited)" marker.
            db.run(`ALTER TABLE Posts ADD COLUMN edited INTEGER DEFAULT 0`, () => {});
            // username backs profile pages and the feed; reply_to backs every reply-thread fetch
            // and the profile page's per-post reply count.
            db.run(`CREATE INDEX IF NOT EXISTS idx_posts_username ON Posts(username)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_posts_reply_to ON Posts(reply_to)`);
            db.run(`CREATE TABLE IF NOT EXISTS Follows (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                follower_username TEXT NOT NULL,
                following_username TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(follower_username, following_username)
            )`);
            // The UNIQUE(follower_username, following_username) constraint above already indexes
            // follower_username as its leading column.
            db.run(`CREATE INDEX IF NOT EXISTS idx_follows_following ON Follows(following_username)`);
            db.run(`CREATE TABLE IF NOT EXISTS IP_Bans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ip TEXT UNIQUE NOT NULL,
                reason TEXT DEFAULT NULL,
                banned_by TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`ALTER TABLE User_Data ADD COLUMN last_ip TEXT DEFAULT NULL`, () => {});
            // Full history of the IPs each account has logged in/registered from.
            db.run(`CREATE TABLE IF NOT EXISTS IP_Login_History (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                ip TEXT NOT NULL,
                event TEXT NOT NULL DEFAULT 'login',
                changed_from_previous INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_ip_login_history_user ON IP_Login_History(user_id, created_at)`);
            // One row per account created, with the IP it was created from.
            db.run(`CREATE TABLE IF NOT EXISTS Registration_IPs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                ip TEXT NOT NULL,
                created_ts INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_registration_ips_ip ON Registration_IPs(ip, created_ts)`);
            // Global "accounts created in the last minute" count (lockdown trigger) and per-user
            // account-age lookups (new-account post limits).
            db.run(`CREATE INDEX IF NOT EXISTS idx_registration_ips_ts ON Registration_IPs(created_ts)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_registration_ips_user ON Registration_IPs(user_id)`);
            // Normalised email the account REGISTERED with (see normalizeEmailForLimit).
            db.run(`ALTER TABLE User_Data ADD COLUMN reg_email_norm TEXT DEFAULT NULL`, () => {});
            db.run(`CREATE INDEX IF NOT EXISTS idx_user_data_reg_email_norm ON User_Data(reg_email_norm)`);
            // Posting timeouts from the post-flood guard (survive restarts).
            db.run(`CREATE TABLE IF NOT EXISTS Post_Timeouts (
                user_id INTEGER PRIMARY KEY,
                username TEXT NOT NULL,
                expires_ts INTEGER NOT NULL,
                reason TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            // Who has blocked whom (see "Blocking" near the Follow routes).
            db.run(`CREATE TABLE IF NOT EXISTS User_Blocks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                blocker TEXT NOT NULL,
                blocked TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(blocker, blocked)
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON User_Blocks(blocked)`);
            db.run(`CREATE TABLE IF NOT EXISTS Friend_Requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_user TEXT NOT NULL,
                to_user TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(from_user, to_user)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS Friends (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_a TEXT NOT NULL,
                user_b TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_a, user_b)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS Notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                type TEXT NOT NULL,
                actor_username TEXT NOT NULL,
                post_id INTEGER DEFAULT NULL,
                message_id INTEGER DEFAULT NULL,
                content_preview TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                read INTEGER DEFAULT 0
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_username ON Notifications(username)`);
            db.run(`CREATE TABLE IF NOT EXISTS Group_Chats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_by TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS Group_Chat_Members (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(group_id, username)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS Group_Chat_Messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                from_user TEXT NOT NULL,
                content TEXT,
                file_path TEXT DEFAULT NULL,
                file_name TEXT DEFAULT NULL,
                reply_to INTEGER DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`ALTER TABLE Group_Chat_Messages ADD COLUMN files_json TEXT DEFAULT NULL`, () => {});
            // Which conversation each DM / group chat attachment belongs to, so /uploads/<file> can
            // be restricted to the people in it.
            db.run(`CREATE TABLE IF NOT EXISTS Private_Uploads (
                filename TEXT PRIMARY KEY,
                scope TEXT NOT NULL,
                user_a TEXT DEFAULT NULL,
                user_b TEXT DEFAULT NULL,
                group_id INTEGER DEFAULT NULL
            )`);
            backfillPrivateUploads();
            // Set to 1 the first time a group message's content is changed via
            // /groups/:id/edit/:msgId, so it can show an "(edited)" marker.
            db.run(`ALTER TABLE Group_Chat_Messages ADD COLUMN edited INTEGER DEFAULT 0`, () => {});
            db.run(`CREATE INDEX IF NOT EXISTS idx_gcm_group ON Group_Chat_Messages(group_id)`);
            // Set to 1 when the group's creator marks it as public via /groups/:id/toggle-public.
            db.run(`ALTER TABLE Group_Chats ADD COLUMN is_public INTEGER DEFAULT 0`, () => {});
            // Generic key/value store for small admin-configurable settings (e.g. the registration
            // gate toggle below).
            db.run(`CREATE TABLE IF NOT EXISTS Settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )`, () => { loadRegistrationGateSetting(); loadRegistrationLockdown(); loadFullLockdown(); loadReadOnlyMode(); });
            // Audit trail for admin-facing/account-lifecycle events.
            db.run(`CREATE TABLE IF NOT EXISTS Audit_Log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL,
                actor TEXT NOT NULL,
                target TEXT DEFAULT NULL,
                details TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            // Account-standing warnings. expires_at is optional - NULL means the warning never
            // expires and counts toward standing forever.
            db.run(`CREATE TABLE IF NOT EXISTS Warnings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                reason TEXT DEFAULT NULL,
                issued_by TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                expires_at TEXT DEFAULT NULL
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_warnings_username ON Warnings(username)`);
            // Migration: CREATE TABLE IF NOT EXISTS above is a no-op on a Warnings table that
            // already existed from before never-expiring.
            try {
                const warningsCols = sqliteDb.prepare(`PRAGMA table_info(Warnings)`).all();
                const expiresCol = warningsCols.find(c => c.name === 'expires_at');
                if (expiresCol && expiresCol.notnull) {
                    console.log('Migrating Warnings.expires_at to allow NULL (never-expiring warnings)...');
                    sqliteDb.exec(`
                        ALTER TABLE Warnings RENAME TO Warnings_migrate_tmp;
                        CREATE TABLE Warnings (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            username TEXT NOT NULL,
                            reason TEXT DEFAULT NULL,
                            issued_by TEXT NOT NULL,
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            expires_at TEXT DEFAULT NULL
                        );
                        INSERT INTO Warnings (id, username, reason, issued_by, created_at, expires_at)
                            SELECT id, username, reason, issued_by, created_at, expires_at FROM Warnings_migrate_tmp;
                        DROP TABLE Warnings_migrate_tmp;
                        CREATE INDEX IF NOT EXISTS idx_warnings_username ON Warnings(username);
                    `);
                    stmtCache.clear(); // old cached statements point at the dropped table object
                    console.log('Warnings migration complete.');
                }
            } catch (migrateErr) {
                console.error('Warnings NOT NULL migration check failed:', migrateErr.message);
            }
            // mute_chat: when set, the warned user can't send DMs or group chat messages until this
            // specific warning expires.
            db.run(`ALTER TABLE Warnings ADD COLUMN mute_chat INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE Warnings ADD COLUMN removed_content TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE Warnings ADD COLUMN removed_attachments_json TEXT DEFAULT NULL`, () => {});
            db.run(`ALTER TABLE Warnings ADD COLUMN report_id INTEGER DEFAULT NULL`, () => {});
            // account_action: set when this warning was issued as the explanatory warning attached
            // to a ban/delete from /admin/reports/:id.
            db.run(`ALTER TABLE Warnings ADD COLUMN account_action TEXT DEFAULT NULL`, () => {});
            // Support tickets submitted via the public /support form.
            db.run(`CREATE TABLE IF NOT EXISTS Support_Tickets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                email TEXT NOT NULL,
                subject TEXT NOT NULL,
                message TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON Support_Tickets(status)`);
            // IP the ticket was submitted from, so support can compare it against the account's
            // login IP history.
            db.run(`ALTER TABLE Support_Tickets ADD COLUMN ip TEXT DEFAULT NULL`, () => {});
            // Optional note an admin can leave when marking a ticket resolved, explaining what was
            // done/why - shown on the ticket detail page.
            db.run(`ALTER TABLE Support_Tickets ADD COLUMN resolution_note TEXT DEFAULT NULL`, () => {});
            // Admin replies sent from the /admin/support/:id ticket page.
            db.run(`CREATE TABLE IF NOT EXISTS Support_Ticket_Replies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticket_id INTEGER NOT NULL,
                admin_username TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_support_ticket_replies_ticket ON Support_Ticket_Replies(ticket_id)`);
            // is_customer distinguishes a reply the customer emailed in.
            db.run(`ALTER TABLE Support_Ticket_Replies ADD COLUMN is_customer INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE Support_Ticket_Replies ADD COLUMN customer_email TEXT DEFAULT NULL`, () => {});
            // User-submitted reports of a post, DM, or group chat message.
            db.run(`CREATE TABLE IF NOT EXISTS Reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                reporter_username TEXT NOT NULL,
                reported_username TEXT NOT NULL,
                source_type TEXT NOT NULL,
                source_id INTEGER,
                content TEXT,
                status TEXT NOT NULL DEFAULT 'open',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            // Snapshot of the reported message/post's attachments (same [{path,name}, ...] shape
            // getAttachments() normalizes elsewhere).
            db.run(`ALTER TABLE Reports ADD COLUMN attachments_json TEXT DEFAULT NULL`, () => {});
            // Same resolution-note pattern as Support_Tickets.resolution_note - optional admin note
            // shown on the report detail page.
            db.run(`ALTER TABLE Reports ADD COLUMN resolution_note TEXT DEFAULT NULL`, () => {});
            db.run(`CREATE INDEX IF NOT EXISTS idx_reports_status ON Reports(status)`);
            // Emoji reactions on a post - one row per (post, user, emoji), so a user can react to
            // the same post with several different emoji.
            db.run(`CREATE TABLE IF NOT EXISTS Reactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                post_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                emoji TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(post_id, username, emoji)
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_reactions_post ON Reactions(post_id)`);
            // Emoji reactions on a DM message - same shape/semantics as Reactions above.
            db.run(`CREATE TABLE IF NOT EXISTS Message_Reactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                emoji TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(message_id, username, emoji)
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON Message_Reactions(message_id)`);
            // Same again for group chat messages - kept as its own table.
            db.run(`CREATE TABLE IF NOT EXISTS Group_Chat_Message_Reactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                emoji TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(message_id, username, emoji)
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_gc_message_reactions_message ON Group_Chat_Message_Reactions(message_id)`);
            // Index of the data/<date>_<username>.tar.gz archives written when an account is
            // deleted (see "Data export & account archives").
            db.run(`CREATE TABLE IF NOT EXISTS Data_Archives (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                email TEXT DEFAULT NULL,
                email_verified INTEGER DEFAULT 0,
                filename TEXT NOT NULL,
                reason TEXT DEFAULT NULL,
                trigger_type TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_data_archives_user ON Data_Archives(user_id)`);
            // One row per "email me my data" request. subject_type is 'user' (a live account, built
            // from the database) or 'archive'.
            db.run(`CREATE TABLE IF NOT EXISTS Data_Export_Requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                subject_type TEXT NOT NULL,
                subject_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                email TEXT NOT NULL,
                categories TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                delivery TEXT DEFAULT NULL,
                error TEXT DEFAULT NULL,
                size_bytes INTEGER DEFAULT NULL,
                file_path TEXT DEFAULT NULL,
                token_hash TEXT DEFAULT NULL,
                expires_at TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                completed_at DATETIME DEFAULT NULL
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_data_export_subject ON Data_Export_Requests(subject_type, subject_id)`);
            // Group id 1 is reserved as the system "activations" log - new account notices get
            // posted there.
            db.run(`INSERT OR IGNORE INTO Group_Chats (id, name, created_by) VALUES (1, 'Activations', 'System')`, (err) => {
                if (err) console.error('Failed to reserve group id 1:', err.message);
            });
        });
        });
