/**
 * Nextcloud Mail Tools — list / read / search / send mail via the Mail app's
 * REST API (/index.php/apps/mail/api/...). Mirrors the Gmail tool surface
 * so prompts that work for "search my inbox" / "summarise this email" /
 * "save this PDF attachment to /Documents" port across the two providers.
 *
 * Auth via ./nextcloudClient (OAuth Bearer when present, app-password Basic
 * otherwise). Mail's controllers don't carry the `#[CORS]` attribute that
 * forces Notes/Deck onto Basic auth — so Bearer works for routine fires too.
 *
 * Endpoint surface (verified against nextcloud/mail main branch):
 *   GET  /api/accounts                                  — list mail accounts
 *   GET  /api/accounts/{id}/test                        — test connectivity
 *   POST /api/mailboxes/{id}/sync                       — list/search messages
 *                                                          (body: {query, ids:[], lastMessageTimestamp, init, sortOrder})
 *   GET  /api/messages/{id}/body                        — message body + headers
 *   GET  /api/messages/{id}/attachment/{attId}          — download attachment bytes
 *   POST /api/messages/{id}/attachment/{attId}          — save attachment to Files
 *                                                          (body: {targetPath})
 *   PUT  /api/messages/{id}/flags                       — set flags (seen, flagged, ...)
 *   POST /api/messages/{id}/move                        — move to mailbox
 *   POST /api/accounts/{id}/draft                       — create draft (returns id)
 *   POST /api/outbox/from-draft/{id}                    — promote draft to outbox
 *   POST /api/outbox/{id}                                — send outbox message
 */

const ncClient = require('./nextcloudClient');

const MAIL_API_BASE = '/index.php/apps/mail/api';
const MAX_BODY_BYTES = 200 * 1024;

const NEXTCLOUD_MAIL_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_mail_list_accounts',
            description: 'List the mail accounts the user has configured in Nextcloud Mail. Always call this first — every other Mail tool needs an accountId or a mailboxId, both of which come from here. Returns id, email, displayName.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_mail_list_mailboxes',
            description: 'List mailboxes (folders) on a Nextcloud Mail account: Inbox, Sent, Drafts, Archive, custom labels. Returns each mailbox\'s id, name (e.g. "INBOX"), displayName, unreadMessages, totalMessages, special-use role.',
            parameters: {
                type: 'object',
                properties: {
                    accountId: { type: 'integer', description: 'Account id from nextcloud_mail_list_accounts.' }
                },
                required: ['accountId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_mail_search',
            description: 'Search messages in a mailbox by free-text query (subject, sender, body, attachment names). Returns id, from, subject, dateInt (unix seconds), preview, hasAttachments, flags. Use the inbox mailboxId from list_mailboxes for the most common case.',
            parameters: {
                type: 'object',
                properties: {
                    mailboxId: { type: 'integer', description: 'Mailbox id from nextcloud_mail_list_mailboxes.' },
                    query: { type: 'string', description: 'Free-text query. Empty / omitted returns the most recent messages. Supports common operators like "from:foo@bar", "subject:invoice", "has:attachment".' },
                    limit: { type: 'integer', description: 'Max messages (default 25, max 100).' }
                },
                required: ['mailboxId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_mail_read',
            description: 'Read a single email by message id. Returns full headers (from, to, cc, subject, date), the plain-text body, and a list of attachments with their attachmentId so you can call nextcloud_mail_read_attachment or nextcloud_mail_save_attachment.',
            parameters: {
                type: 'object',
                properties: {
                    messageId: { type: 'integer', description: 'Message id (from search results).' }
                },
                required: ['messageId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_mail_read_attachment',
            description: 'Download an attachment and extract its text content (PDF → OCR, DOCX/XLSX → structured text). Use this when you want the AI to read the contents of an attachment but NOT save it to the user\'s files. Use nextcloud_mail_save_attachment instead if the user wants the file persisted in Nextcloud Files.',
            parameters: {
                type: 'object',
                properties: {
                    messageId: { type: 'integer', description: 'Message id.' },
                    attachmentId: { type: 'string', description: 'Attachment id (from nextcloud_mail_read).' },
                    filename: { type: 'string', description: 'Filename for logging / extraction hints.' }
                },
                required: ['messageId', 'attachmentId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_mail_save_attachment',
            description: 'Save an email attachment directly to a folder in Nextcloud Files (no download/re-upload — handled server-side by the Mail app). Use this when the user asks "save the PDF from this email to /Documents" or similar. The user has approved this — go ahead.',
            parameters: {
                type: 'object',
                properties: {
                    messageId: { type: 'integer', description: 'Message id.' },
                    attachmentId: { type: 'string', description: 'Attachment id (from nextcloud_mail_read). Pass "0" to save all attachments.' },
                    targetPath: { type: 'string', description: 'Destination folder path in Nextcloud Files (e.g. "/Documents/Invoices/2026"). Folder must exist — use nextcloud_create_folder first if needed.' }
                },
                required: ['messageId', 'attachmentId', 'targetPath']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_mail_send',
            description: 'Compose and send an email through Nextcloud Mail. The user has approved this — go ahead. For replies, set replyTo to the original messageId so the new message threads correctly. The mail goes through the outbox: drafted, then sent in one round-trip.',
            parameters: {
                type: 'object',
                properties: {
                    accountId: { type: 'integer', description: 'Sending account id (from list_accounts).' },
                    to: { type: 'string', description: 'Recipient(s), comma-separated.' },
                    cc: { type: 'string', description: 'Optional CC recipients.' },
                    bcc: { type: 'string', description: 'Optional BCC recipients.' },
                    subject: { type: 'string', description: 'Subject line.' },
                    body: { type: 'string', description: 'Plain-text body.' },
                    isHtml: { type: 'boolean', description: 'If true, body is interpreted as HTML.' },
                    replyTo: { type: 'integer', description: 'Optional: messageId being replied to — sets In-Reply-To / References headers and threads the conversation.' }
                },
                required: ['accountId', 'to', 'subject', 'body']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_mail_set_flags',
            description: 'Mark a message read/unread, flagged/unflagged, or junk. Always confirm with the user before flagging as junk.',
            parameters: {
                type: 'object',
                properties: {
                    messageId: { type: 'integer', description: 'Message id.' },
                    seen: { type: 'boolean', description: 'true = mark read, false = unread.' },
                    flagged: { type: 'boolean', description: 'true = star the message.' },
                    junk: { type: 'boolean', description: 'true = mark as junk/spam.' }
                },
                required: ['messageId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_mail_move',
            description: 'Move a message to another mailbox (e.g. archive, custom label). The user has approved this.',
            parameters: {
                type: 'object',
                properties: {
                    messageId: { type: 'integer', description: 'Message id.' },
                    destMailboxId: { type: 'integer', description: 'Target mailbox id (from list_mailboxes).' }
                },
                required: ['messageId', 'destMailboxId']
            }
        }
    }
];

// ─── Helpers ──────────────────────────────────────────────────────

async function readJsonSafe(res) {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text); } catch { return text; }
}

function api(baseUrl, path) {
    return `${baseUrl}${MAIL_API_BASE}${path}`;
}

const baseHeaders = {
    'Accept': 'application/json',
    'OCS-APIRequest': 'true', // harmless on non-OCS routes; required by some NC reverse proxies
};

function summariseMessage(m) {
    return {
        id: m.id ?? m.messageId,
        threadRootId: m.threadRootId ?? null,
        from: Array.isArray(m.from) ? m.from.map(addr => addr.email || addr.label).join(', ') : (m.from?.email || m.from || null),
        to: Array.isArray(m.to) ? m.to.map(addr => addr.email || addr.label).join(', ') : null,
        subject: m.subject || '',
        dateInt: m.dateInt ?? m.date ?? null,
        preview: m.preview || m.previewText || null,
        hasAttachments: !!m.hasAttachments,
        flags: m.flags || {},
        mailboxId: m.mailboxId ?? null,
    };
}

function summariseAttachment(a) {
    return {
        id: a.id ?? a.attachmentId,
        filename: a.fileName || a.filename || a.name || '(unnamed)',
        mimeType: a.mime || a.mimeType || 'application/octet-stream',
        size: a.size || 0,
        isInline: !!a.isInline,
    };
}

function trimBody(text) {
    if (!text) return text;
    if (text.length <= MAX_BODY_BYTES) return text;
    return text.slice(0, MAX_BODY_BYTES) + '\n\n... [truncated — body too large]';
}

// ─── Tool execution ──────────────────────────────────────────────

async function executeNextcloudMailTool(toolName, args, userId, session) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const { baseUrl, fetch: ncFetch, authError } = ctx;

    switch (toolName) {
        case 'nextcloud_mail_list_accounts': {
            const res = await ncFetch(api(baseUrl, '/accounts'), { headers: baseHeaders });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: 'Nextcloud Mail app is not installed/enabled on this server.' };
            if (!res.ok) return { error: `Mail accounts list failed (${res.status})` };
            const data = await readJsonSafe(res);
            const accounts = Array.isArray(data) ? data : [];
            return {
                count: accounts.length,
                accounts: accounts.map(a => ({
                    id: a.accountId ?? a.id,
                    email: a.emailAddress || a.email || null,
                    displayName: a.name || a.displayName || a.emailAddress || null,
                    provisioned: !!a.provisioned,
                })),
            };
        }

        case 'nextcloud_mail_list_mailboxes': {
            if (args.accountId == null) return { error: 'accountId is required' };
            const url = api(baseUrl, `/mailboxes?accountId=${encodeURIComponent(args.accountId)}`);
            const res = await ncFetch(url, { headers: baseHeaders });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Mail account not found: ${args.accountId}` };
            if (!res.ok) return { error: `Mailbox list failed (${res.status})` };
            const data = await readJsonSafe(res);
            const mailboxes = Array.isArray(data) ? data : (data?.mailboxes || []);
            return {
                count: mailboxes.length,
                mailboxes: mailboxes.map(m => ({
                    id: m.databaseId ?? m.id,
                    name: m.name || null,
                    displayName: m.displayName || m.name,
                    unreadMessages: m.unread ?? m.unreadMessages ?? 0,
                    totalMessages: m.messages ?? m.total ?? null,
                    specialRole: m.specialRole || m.specialUse || null,
                })),
            };
        }

        case 'nextcloud_mail_search': {
            if (args.mailboxId == null) return { error: 'mailboxId is required' };
            const limit = Math.min(Math.max(parseInt(args.limit) || 25, 1), 100);
            // The /sync endpoint with init:true returns the most recent N messages
            // and accepts a `query` param that the Mail app delegates to its own
            // search backend (subject, from, body, attachments).
            const body = {
                ids: [],
                lastMessageTimestamp: null,
                init: true,
                sortOrder: 'newest',
            };
            if (args.query) body.query = String(args.query);

            const res = await ncFetch(api(baseUrl, `/mailboxes/${encodeURIComponent(args.mailboxId)}/sync`), {
                method: 'POST',
                headers: { ...baseHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Mailbox not found: ${args.mailboxId}` };
            if (!res.ok) return { error: `Mail search failed (${res.status})` };
            const data = await readJsonSafe(res);
            const newMessages = data?.newMessages || data?.messages || (Array.isArray(data) ? data : []);
            const messages = newMessages.slice(0, limit).map(summariseMessage);
            return { mailboxId: args.mailboxId, count: messages.length, messages };
        }

        case 'nextcloud_mail_read': {
            if (args.messageId == null) return { error: 'messageId is required' };
            const res = await ncFetch(api(baseUrl, `/messages/${encodeURIComponent(args.messageId)}/body`), {
                headers: baseHeaders,
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Message not found: ${args.messageId}` };
            if (!res.ok) return { error: `Mail read failed (${res.status})` };
            const m = await readJsonSafe(res);
            if (!m || typeof m !== 'object') return { error: 'Unexpected Mail response' };
            const attachments = Array.isArray(m.attachments) ? m.attachments.map(summariseAttachment) : [];
            const bodyText = m.body || m.bodyPlain || '';
            const truncated = (bodyText || '').length > MAX_BODY_BYTES;
            return {
                id: m.id ?? args.messageId,
                from: m.from || null,
                to: m.to || null,
                cc: m.cc || null,
                subject: m.subject || '',
                dateInt: m.dateInt ?? null,
                hasHtmlBody: !!m.hasHtmlBody,
                truncated,
                body: trimBody(bodyText),
                attachments,
            };
        }

        case 'nextcloud_mail_read_attachment': {
            if (args.messageId == null || !args.attachmentId) return { error: 'messageId and attachmentId are required' };
            const url = api(baseUrl, `/messages/${encodeURIComponent(args.messageId)}/attachment/${encodeURIComponent(args.attachmentId)}`);
            const res = await ncFetch(url, { headers: { ...baseHeaders, 'Accept': '*/*' } });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: 'Attachment not found.' };
            if (!res.ok) return { error: `Attachment download failed (${res.status})` };
            const contentType = res.headers.get('content-type') || 'application/octet-stream';
            const buf = Buffer.from(await res.arrayBuffer());
            const filename = args.filename || `attachment-${args.attachmentId}`;

            // Same extraction pipeline used by chat-uploads + nextcloud_read_file.
            const { extractAttachment, isPdf, isDocx, isSpreadsheet } = require('../core/attachmentExtractor');
            const att = { name: filename, type: contentType, content: buf.toString('base64') };
            if (isPdf(att) || isDocx(att) || isSpreadsheet(att)) {
                const result = await extractAttachment(att);
                if (result.kind === 'text') {
                    const truncated = result.text.length > MAX_BODY_BYTES;
                    return {
                        messageId: args.messageId,
                        attachmentId: args.attachmentId,
                        filename,
                        mimeType: contentType,
                        size: buf.length,
                        extractedVia: result.source,
                        truncated,
                        content: truncated ? result.text.slice(0, MAX_BODY_BYTES) + '\n\n... [truncated]' : result.text,
                        meta: result.meta,
                    };
                }
            }
            // Plain text or unrecognised — try utf-8 if it looks textual.
            if (contentType.startsWith('text/')) {
                const text = buf.toString('utf-8');
                return {
                    messageId: args.messageId,
                    attachmentId: args.attachmentId,
                    filename,
                    mimeType: contentType,
                    size: buf.length,
                    truncated: text.length > MAX_BODY_BYTES,
                    content: trimBody(text),
                };
            }
            return {
                messageId: args.messageId,
                attachmentId: args.attachmentId,
                filename,
                mimeType: contentType,
                size: buf.length,
                error: 'Attachment is not a text/PDF/DOCX/XLSX file — use nextcloud_mail_save_attachment to persist it to Files instead.',
            };
        }

        case 'nextcloud_mail_save_attachment': {
            if (args.messageId == null || !args.attachmentId || !args.targetPath) {
                return { error: 'messageId, attachmentId, and targetPath are required' };
            }
            const url = api(baseUrl, `/messages/${encodeURIComponent(args.messageId)}/attachment/${encodeURIComponent(args.attachmentId)}`);
            const res = await ncFetch(url, {
                method: 'POST',
                headers: { ...baseHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetPath: args.targetPath }),
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: 'Message or attachment not found.' };
            if (res.status === 409) return { error: `Target folder doesn't exist: ${args.targetPath}. Create it first with nextcloud_create_folder.` };
            if (!res.ok) {
                const detail = await readJsonSafe(res);
                return { error: `Save attachment failed (${res.status})`, detail };
            }
            return {
                success: true,
                messageId: args.messageId,
                attachmentId: args.attachmentId,
                savedTo: args.targetPath,
            };
        }

        case 'nextcloud_mail_send': {
            if (args.accountId == null || !args.to || !args.subject || !args.body) {
                return { error: 'accountId, to, subject, and body are required' };
            }
            const draftBody = {
                accountId: args.accountId,
                subject: args.subject,
                body: args.body,
                isHtml: !!args.isHtml,
                to: String(args.to).split(',').map(e => ({ email: e.trim(), label: e.trim() })).filter(x => x.email),
                cc: args.cc ? String(args.cc).split(',').map(e => ({ email: e.trim(), label: e.trim() })).filter(x => x.email) : [],
                bcc: args.bcc ? String(args.bcc).split(',').map(e => ({ email: e.trim(), label: e.trim() })).filter(x => x.email) : [],
                attachments: [],
            };
            if (args.replyTo) draftBody.inReplyToMessageId = args.replyTo;

            // Step 1: create a draft. The Mail app's outbox endpoint takes a
            // draft id, so we always go via this two-step path.
            const draftRes = await ncFetch(api(baseUrl, '/outbox'), {
                method: 'POST',
                headers: { ...baseHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify(draftBody),
            });
            if (draftRes.status === 401) return { error: authError };
            if (!draftRes.ok && draftRes.status !== 200 && draftRes.status !== 201) {
                const detail = await readJsonSafe(draftRes);
                return { error: `Mail draft failed (${draftRes.status})`, detail };
            }
            const draft = await readJsonSafe(draftRes);
            const outboxId = draft?.id ?? draft?.data?.id;
            if (!outboxId) return { error: 'Mail draft created but no outbox id returned', detail: draft };

            // Step 2: dispatch the outbox message immediately. The send route
            // is `POST /api/outbox/{id}` (named outbox#send) — no /send suffix.
            const sendRes = await ncFetch(api(baseUrl, `/outbox/${encodeURIComponent(outboxId)}`), {
                method: 'POST',
                headers: baseHeaders,
            });
            if (!sendRes.ok && sendRes.status !== 200 && sendRes.status !== 202) {
                const detail = await readJsonSafe(sendRes);
                return { error: `Mail send failed (${sendRes.status})`, detail, outboxId };
            }
            return { success: true, outboxId, to: args.to, subject: args.subject };
        }

        case 'nextcloud_mail_set_flags': {
            if (args.messageId == null) return { error: 'messageId is required' };
            const flags = {};
            if (args.seen !== undefined) flags.seen = !!args.seen;
            if (args.flagged !== undefined) flags.flagged = !!args.flagged;
            if (args.junk !== undefined) flags.junk = !!args.junk;
            if (Object.keys(flags).length === 0) return { error: 'at least one flag (seen/flagged/junk) must be provided' };

            const res = await ncFetch(api(baseUrl, `/messages/${encodeURIComponent(args.messageId)}/flags`), {
                method: 'PUT',
                headers: { ...baseHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ flags }),
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Message not found: ${args.messageId}` };
            if (!res.ok) return { error: `Set flags failed (${res.status})` };
            return { success: true, messageId: args.messageId, flags };
        }

        case 'nextcloud_mail_move': {
            if (args.messageId == null || args.destMailboxId == null) {
                return { error: 'messageId and destMailboxId are required' };
            }
            const res = await ncFetch(api(baseUrl, `/messages/${encodeURIComponent(args.messageId)}/move`), {
                method: 'POST',
                headers: { ...baseHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ destMailboxId: args.destMailboxId }),
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: 'Message or destination mailbox not found.' };
            if (!res.ok) {
                const detail = await readJsonSafe(res);
                return { error: `Mail move failed (${res.status})`, detail };
            }
            return { success: true, messageId: args.messageId, destMailboxId: args.destMailboxId };
        }

        default:
            return { error: `Unknown Nextcloud Mail tool: ${toolName}` };
    }
}

function isNextcloudMailTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_mail_');
}

module.exports = {
    NEXTCLOUD_MAIL_TOOLS,
    executeNextcloudMailTool,
    isNextcloudMailTool,
};
