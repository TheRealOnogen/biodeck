// Support inbox: reads incoming mail over IMAP and turns it into tickets.
const { db } = require('./db/connection');
const { logAudit } = require('./moderation');

let ImapClient;
try { ImapClient = require('imap'); } catch (e) { ImapClient = null; }
let simpleParser;
try { ({ simpleParser } = require('mailparser')); } catch (e) { simpleParser = null; }

// Inbound support email
// Keeps a persistent IMAP IDLE connection open so replies.
const SUPPORT_INBOX_POLL_MS = parseInt(process.env.SUPPORT_INBOX_POLL_MS || '60000', 10);

// Mail clients paste the entire prior message back into a reply.
function stripEmailQuote(text) {
    if (!text) return text;
    const lines = text.split(/\r?\n/);
    let cutoff = lines.length;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (/^on .{3,150}\bwrote:$/i.test(line) || /^-{2,}\s*original message\s*-{2,}$/i.test(line) || /^from:\s*.+$/i.test(line) || line.startsWith('>')) {
            cutoff = i;
            break;
        }
    }
    return lines.slice(0, cutoff).join('\n').trim();
}

// True for bounces (NDRs), out-of-office replies and other machine-generated mail.
function isAutomatedMail(mail, fromAddr, fromName) {
    const hv = (k) => {
        try {
            const v = mail.headers && mail.headers.get ? mail.headers.get(k) : undefined;
            if (v === undefined || v === null) return '';
            if (typeof v === 'string') return v.toLowerCase();
            if (Array.isArray(v)) return v.map(x => String(x && x.value || x)).join(' ').toLowerCase();
            return String(v.value || v.text || '').toLowerCase();
        } catch (e) { return ''; }
    };
    const local = String(fromAddr || '').split('@')[0].toLowerCase();
    if (/^(mailer-daemon|postmaster|mail-daemon|daemon|bounces?|no-?reply|do-?not-?reply)$/.test(local)) return true;
    if (/mail delivery (sub)?system|mailer-daemon|postmaster/i.test(fromName || '')) return true;
    const autoSubmitted = hv('auto-submitted');
    if (autoSubmitted && autoSubmitted !== 'no') return true;
    if (hv('x-failed-recipients')) return true;
    if (hv('content-type').startsWith('multipart/report')) return true;
    if (/^(bulk|junk|auto_reply|list)$/.test(hv('precedence'))) return true;
    if (hv('x-autoreply') || hv('x-autorespond')) return true;
    const subj = String(mail.subject || '').trim();
    if (/^(delivery status notification|undeliverable|undelivered mail|mail delivery (failed|failure|subsystem)|returned mail|failure notice|auto(matic)?[- ]?reply|out of office)/i.test(subj)) return true;
    return false;
}

function processInboundSupportEmail(mail) {
    const fromEntry = mail.from && mail.from.value && mail.from.value[0];
    const fromAddr = fromEntry ? fromEntry.address : null;
    if (!fromAddr) return;
    const fromName = (fromEntry.name || fromAddr).trim();

    if (isAutomatedMail(mail, fromAddr, fromName)) {
        // Log it (so failed verification mails are still visible in the server log) but don't
        // create a ticket or reply.
        console.log(`[support inbox] ignored automated mail from ${fromAddr}: ${String(mail.subject || '').slice(0, 80)}` +
            (mail.headers && mail.headers.get && mail.headers.get('x-failed-recipients') ? ` (failed: ${mail.headers.get('x-failed-recipients')})` : ''));
        return;
    }

    // Never let our own outgoing address turn into a ticket/reply.
    const ourAddr = (process.env.SMTP_FROM || process.env.SMTP_USER || '').toLowerCase();
    if (ourAddr && fromAddr.toLowerCase() === ourAddr) return;

    const subject = (mail.subject || '(no subject)').trim();
    const body = stripEmailQuote((mail.text || '').trim()) || '(empty message)';
    const match = subject.match(/\[Ticket #(\d+)\]/i);

    if (match) {
        const ticketId = parseInt(match[1], 10);
        db.get(`SELECT id, username, status FROM Support_Tickets WHERE id = ?`, [ticketId], (err, ticket) => {
            if (err || !ticket) return; // unrecognized ticket tag - drop it silently
            db.run(`INSERT INTO Support_Ticket_Replies (ticket_id, admin_username, message, is_customer, customer_email) VALUES (?, ?, ?, 1, ?)`,
                [ticketId, fromName, body, fromAddr], (err2) => {
                    if (err2) return console.error('Failed to store inbound reply:', err2.message);
                    logAudit('support_ticket_customer_reply', fromName, ticket.username, `ticket #${ticketId} (via email)`);
                    if (ticket.status !== 'open') {
                        db.run(`UPDATE Support_Tickets SET status = 'open' WHERE id = ?`, [ticketId], () => {});
                    }
                });
        });
        return;
    }

    // No recognizable ticket tag - treat it as a brand new ticket.
    db.run(`INSERT INTO Support_Tickets (username, email, subject, message) VALUES (?, ?, ?, ?)`,
        [fromName, fromAddr, subject, body], function (err) {
            if (err) return console.error('Failed to create ticket from inbound email:', err.message);
            logAudit('support_ticket_submitted_by_email', fromName, fromName, `#${this.lastID}: ${subject}`);
        });
}

// Instead of reconnecting/authenticating on a timer.
let supportImap = null;
let supportInboxReconnectTimer = null;
let supportInboxReconnectDelayMs = 5000;
const SUPPORT_INBOX_MAX_RECONNECT_MS = 5 * 60 * 1000; // cap backoff at 5 minutes
let supportInboxCheckInFlight = false;

function checkSupportInboxForUnseenMail(imap) {
    if (supportInboxCheckInFlight) return;
    supportInboxCheckInFlight = true;
    imap.search(['UNSEEN'], (err, uids) => {
        if (err) { console.error('Support inbox search error:', err.message); supportInboxCheckInFlight = false; return; }
        if (!uids || uids.length === 0) { supportInboxCheckInFlight = false; return; }

        const pending = [];
        const fetcher = imap.fetch(uids, { bodies: '', markSeen: true });
        fetcher.on('message', msg => {
            let buffer = '';
            msg.on('body', stream => { stream.on('data', chunk => { buffer += chunk.toString('utf8'); }); });
            msg.once('end', () => {
                pending.push(simpleParser(buffer).then(processInboundSupportEmail).catch(err => console.error('Support inbox parse error:', err.message)));
            });
        });
        fetcher.once('error', err => { console.error('Support inbox fetch error:', err.message); supportInboxCheckInFlight = false; });
        fetcher.once('end', () => { Promise.allSettled(pending).finally(() => { supportInboxCheckInFlight = false; }); });
    });
}

function scheduleSupportInboxReconnect() {
    if (supportInboxReconnectTimer) return; // already scheduled
    console.warn(`Support inbox reconnecting in ${Math.round(supportInboxReconnectDelayMs / 1000)}s`);
    supportInboxReconnectTimer = setTimeout(() => {
        supportInboxReconnectTimer = null;
        connectSupportInbox();
    }, supportInboxReconnectDelayMs);
    supportInboxReconnectDelayMs = Math.min(supportInboxReconnectDelayMs * 2, SUPPORT_INBOX_MAX_RECONNECT_MS);
}

function connectSupportInbox() {
    const imap = new ImapClient({
        user: process.env.IMAP_USER,
        password: process.env.IMAP_PASS,
        host: process.env.IMAP_HOST,
        port: parseInt(process.env.IMAP_PORT || '993', 10),
        tls: process.env.IMAP_TLS !== 'false',
        tlsOptions: { rejectUnauthorized: false },
        // Without explicit timeouts a stalled handshake.
        connTimeout: parseInt(process.env.IMAP_CONN_TIMEOUT_MS || '10000', 10),
        authTimeout: parseInt(process.env.IMAP_AUTH_TIMEOUT_MS || '10000', 10),
        keepalive: true
    });
    supportImap = imap;

    imap.once('error', err => {
        console.error('Support inbox IMAP error:', err.message);
    });

    imap.once('end', () => {
        supportImap = null;
        scheduleSupportInboxReconnect();
    });

    imap.once('ready', () => {
        imap.openBox('INBOX', false, (err) => {
            if (err) { console.error('Support inbox open error:', err.message); imap.end(); return; }
            // Connected and logged in successfully - reset backoff.
            supportInboxReconnectDelayMs = 5000;

            // Catch up on anything that arrived while disconnected, then let IDLE notify us of
            // anything after that.
            checkSupportInboxForUnseenMail(imap);
            imap.on('mail', () => checkSupportInboxForUnseenMail(imap));

            // Belt-and-suspenders re-check in case an IDLE notification is ever missed (e.g. a
            // notification lost around a keepalive renewal).
            const safetyNetTimer = setInterval(() => {
                if (supportImap === imap) checkSupportInboxForUnseenMail(imap);
                else clearInterval(safetyNetTimer);
            }, SUPPORT_INBOX_POLL_MS);
        });
    });

    imap.connect();
}

if (ImapClient && simpleParser && process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS) {
    connectSupportInbox();
} else if (!ImapClient || !simpleParser) {
    console.warn('imap/mailparser not installed (run `npm install imap mailparser`) - inbound emails will not be turned into support tickets.');
} else {
    console.warn('IMAP not configured (set IMAP_HOST, IMAP_USER, IMAP_PASS) - inbound emails will not be turned into support tickets.');
}
