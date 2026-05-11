/**
 * Gmail Tools — Built-in tools for AI to search and read Gmail
 * 
 * These tools are injected into the LLM tool set when the user
 * is logged in with Google, allowing the AI to proactively search
 * and read emails during conversations.
 */

const { google } = require('googleapis');
const { loadConfig } = require('../auth/permissions');

/**
 * Tool definitions in OpenAI function-calling format.
 */
const GMAIL_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'gmail_search',
            description: 'Search the user\'s Gmail inbox for emails matching a query. Returns a list of email summaries (sender, subject, date, snippet). Use Gmail search syntax like "from:someone@example.com", "subject:invoice", "after:2025/01/01", "has:attachment", "is:unread", or just plain keywords.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Gmail search query (supports Gmail search operators like from:, subject:, after:, before:, has:attachment, is:unread, label:, etc.)'
                    },
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum number of results to return (1-20, default 10)'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'gmail_read',
            description: 'Read the full content of a specific email by its message ID. Use this after gmail_search to get the complete body of an email.',
            parameters: {
                type: 'object',
                properties: {
                    messageId: {
                        type: 'string',
                        description: 'The Gmail message ID to read (from gmail_search results)'
                    }
                },
                required: ['messageId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'gmail_read_attachment',
            description: 'Download and read a PDF attachment from a Gmail email. Uses OCR to extract text from the PDF. Use gmail_read first to get the list of attachments with their IDs.',
            parameters: {
                type: 'object',
                properties: {
                    messageId: {
                        type: 'string',
                        description: 'The Gmail message ID that contains the attachment'
                    },
                    attachmentId: {
                        type: 'string',
                        description: 'The attachment ID (from gmail_read results)'
                    },
                    filename: {
                        type: 'string',
                        description: 'The filename of the attachment (for logging)'
                    }
                },
                required: ['messageId', 'attachmentId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'gmail_compose',
            description: 'Compose and send a new email or reply to an existing email thread. The user will see a preview with Send, Save as Draft, and Discard buttons before anything is sent — no email is sent automatically. Use this whenever the user asks you to write, draft, send, reply to, or forward an email.\n\nIMPORTANT: When replying, set replyToMessageId to the message ID of the email being replied to (from gmail_search / gmail_read results, or the attached Gmail thread context). The tool will then auto-fill the recipient and subject from the original message — you only need to pass `body` and `replyToMessageId`. If you *do* pass `to` / `subject` on a reply, your values override the auto-derived ones. For forwards, prefix the subject with "Fwd: " and include the original email body.',
            parameters: {
                type: 'object',
                properties: {
                    to: {
                        type: 'string',
                        description: 'Recipient email address(es), comma-separated for multiple. Optional when replyToMessageId is set — the tool derives the recipient from the original message (Reply-To or From header).'
                    },
                    cc: {
                        type: 'string',
                        description: 'Optional: CC recipient email address(es), comma-separated'
                    },
                    bcc: {
                        type: 'string',
                        description: 'Optional: BCC recipient email address(es), comma-separated'
                    },
                    subject: {
                        type: 'string',
                        description: 'Email subject line. Optional when replyToMessageId is set — the tool derives it from the original message and prefixes "Re: " automatically. For forwards, pass explicitly with "Fwd: " prefix.'
                    },
                    body: {
                        type: 'string',
                        description: 'Email body text (plain text). For forwards, include the original email content.'
                    },
                    replyToMessageId: {
                        type: 'string',
                        description: 'REQUIRED for replies: Gmail message ID of the email being replied to (from gmail_search or gmail_read results, or trigger.output.messageId for a Gmail-triggered automation). This makes Gmail render the reply inline in the original conversation. Omit only for new emails and forwards.'
                    },
                    threadId: {
                        type: 'string',
                        description: 'Optional: Gmail thread ID. Pass this when you have only the threadId (e.g. trigger.output.threadId) and not a specific messageId — the tool will look up the latest message in the thread to derive the reply headers. Prefer replyToMessageId when both are available.'
                    }
                },
                required: ['body']
            }
        }
    }
];

/**
 * Decode base64url-encoded email body parts.
 */
function decodeBase64Url(data) {
    if (!data) return '';
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * Extract the text body from a Gmail message payload.
 */
function extractTextBody(payload) {
    if (!payload) return '';
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
        return decodeBase64Url(payload.body.data);
    }
    if (payload.parts) {
        for (const part of payload.parts) {
            if (part.mimeType === 'text/plain' && part.body?.data) {
                return decodeBase64Url(part.body.data);
            }
        }
        for (const part of payload.parts) {
            if (part.mimeType === 'text/html' && part.body?.data) {
                const html = decodeBase64Url(part.body.data);
                return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            }
        }
        for (const part of payload.parts) {
            if (part.parts) {
                const text = extractTextBody(part);
                if (text) return text;
            }
        }
    }
    return '';
}

function getHeader(headers, name) {
    const h = headers?.find(h => h.name.toLowerCase() === name.toLowerCase());
    return h?.value || '';
}

/**
 * Extract attachment info from a Gmail message payload.
 * Lists ALL attachments so the AI can see what's available.
 * The gmail_read_attachment tool handles PDF-only filtering.
 */
function extractAttachments(payload) {
    const attachments = [];
    function scan(part) {
        if (!part) return;
        // A part is an attachment if it has a filename (even empty body means inline)
        if (part.filename && part.filename.length > 0 && part.body) {
            attachments.push({
                filename: part.filename,
                mimeType: part.mimeType || 'application/octet-stream',
                size: part.body.size || 0,
                attachmentId: part.body.attachmentId || null,
                canOCR: part.mimeType === 'application/pdf',
            });
        }
        // Recurse into nested parts
        if (part.parts) {
            for (const child of part.parts) {
                scan(child);
            }
        }
    }
    // Scan the top-level payload and all its parts
    if (payload?.parts) {
        for (const part of payload.parts) {
            scan(part);
        }
    }
    // Also check the payload itself (single-part messages)
    if (payload?.filename && payload.filename.length > 0 && payload.body) {
        attachments.push({
            filename: payload.filename,
            mimeType: payload.mimeType || 'application/octet-stream',
            size: payload.body.size || 0,
            attachmentId: payload.body.attachmentId || null,
            canOCR: payload.mimeType === 'application/pdf',
        });
    }
    return attachments;
}

/**
 * Create an authenticated Gmail client from session tokens.
 */
async function createGmailClient(session) {
    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};

    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Google OAuth not configured');
    }

    const accessToken = session?.accessToken;
    if (!accessToken) {
        throw new Error('Not connected to Gmail — user must log in with Google');
    }

    const oauth2Client = new google.auth.OAuth2(
        providerConfig.clientId,
        providerConfig.clientSecret
    );

    oauth2Client.setCredentials({
        access_token: accessToken,
        refresh_token: session?.refreshToken
    });

    oauth2Client.on('tokens', (tokens) => {
        if (tokens.access_token) session.accessToken = tokens.access_token;
        if (tokens.refresh_token) session.refreshToken = tokens.refresh_token;
        session.save?.();
    });

    return google.gmail({ version: 'v1', auth: oauth2Client });
}

/**
 * Execute a Gmail tool call.
 * @param {string} toolName - 'gmail_search' / 'gmail_read' / 'gmail_compose' / etc.
 * @param {object} args - Tool arguments
 * @param {object} session - Express session with OAuth tokens
 * @param {object} [opts]
 * @param {boolean} [opts.autoSend=false] - For gmail_compose: when true the tool
 *   actually sends the email (no UI handshake). Set by the automation runner
 *   because there is no user present to confirm a draft. Direct-chat / agent
 *   chat leave this false so the existing email_draft → user-approves → send
 *   flow stays in place as a safety net.
 * @returns {object} Tool result
 */
async function executeGmailTool(toolName, args, session, opts = {}) {
    const gmail = await createGmailClient(session);

    if (toolName === 'gmail_search') {
        const { query, maxResults = 10 } = args;
        const response = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: Math.min(Math.max(parseInt(maxResults) || 10, 1), 20),
        });

        const messageIds = response.data.messages || [];
        if (messageIds.length === 0) {
            return { results: [], message: `No emails found for query: "${query}"` };
        }

        const messages = await Promise.all(
            messageIds.map(async (msg) => {
                try {
                    const detail = await gmail.users.messages.get({
                        userId: 'me',
                        id: msg.id,
                        format: 'metadata',
                        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
                    });
                    const headers = detail.data.payload?.headers || [];
                    return {
                        id: detail.data.id,
                        from: getHeader(headers, 'From'),
                        to: getHeader(headers, 'To'),
                        subject: getHeader(headers, 'Subject') || '(no subject)',
                        date: getHeader(headers, 'Date'),
                        snippet: detail.data.snippet || '',
                    };
                } catch {
                    return null;
                }
            })
        );

        return {
            results: messages.filter(Boolean),
            total: response.data.resultSizeEstimate || messageIds.length,
            query,
        };

    } else if (toolName === 'gmail_read') {
        const { messageId } = args;
        if (!messageId) throw new Error('messageId is required');

        const detail = await gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'full',
        });

        const headers = detail.data.payload?.headers || [];
        const body = extractTextBody(detail.data.payload);
        const MAX_CHARS = 50000;

        return {
            id: detail.data.id,
            from: getHeader(headers, 'From'),
            to: getHeader(headers, 'To'),
            subject: getHeader(headers, 'Subject') || '(no subject)',
            date: getHeader(headers, 'Date'),
            body: body.length > MAX_CHARS
                ? body.substring(0, MAX_CHARS) + '\n\n[... truncated, email too large ...]'
                : body,
            attachments: extractAttachments(detail.data.payload),
        };

    } else if (toolName === 'gmail_read_attachment') {
        const { messageId, attachmentId, filename: fname } = args;
        if (!messageId || !attachmentId) throw new Error('messageId and attachmentId are required');

        // Download the attachment
        const attachment = await gmail.users.messages.attachments.get({
            userId: 'me',
            messageId,
            id: attachmentId,
        });

        const base64Data = attachment.data.data;
        if (!base64Data) throw new Error('Attachment data is empty');

        // Convert from URL-safe base64 to standard base64
        const standardBase64 = base64Data.replace(/-/g, '+').replace(/_/g, '/');

        // Unified attachment pipeline: pdfjs → Azure DI → Mistral OCR, plus
        // the garbage-text fallback for CID-font invoices. Same code path
        // chat uploads and Nextcloud reads use, so PDF quirks fix in one place.
        const { extractAttachment } = require('../core/attachmentExtractor');
        const result = await extractAttachment({
            name: fname || 'attachment.pdf',
            type: 'application/pdf',
            content: standardBase64,
        });

        if (result.kind === 'images') {
            return {
                error: `${fname || 'attachment.pdf'} appears to be an image-only PDF (${result.meta?.numPages || '?'} pages) with no extractable text. Configure Azure Document Intelligence or Mistral OCR to read scanned PDFs from Gmail.`,
                filename: fname || 'attachment.pdf',
            };
        }
        if (result.kind !== 'text' || !result.text) {
            return {
                error: `Could not extract text from the PDF: ${result.reason || 'unknown reason'}.`,
                filename: fname || 'attachment.pdf',
            };
        }

        const extractedText = result.text;
        // Truncate if very large
        const MAX_CHARS = 80000;
        return {
            filename: fname || 'attachment.pdf',
            content: extractedText.length > MAX_CHARS
                ? extractedText.substring(0, MAX_CHARS) + '\n\n[... truncated, document too large ...]'
                : extractedText,
            charCount: extractedText.length,
            truncated: extractedText.length > MAX_CHARS,
            extractedVia: result.source,
        };

    } else if (toolName === 'gmail_compose') {
        let { to, cc, bcc, subject, body, replyToMessageId, threadId: argThreadId } = args;
        if (!body) throw new Error('body is required');

        // Threading requires THREE things together: the threadId on the API
        // request, the In-Reply-To header pointing at the original Message-ID,
        // and a References header. Gmail will silently drop a reply into a
        // *new* visible conversation if the In-Reply-To header is missing,
        // even when threadId is set — that's what users see when their
        // automation reply shows up as a fresh email instead of inline in
        // the original thread.
        //
        // Three call shapes are supported (most → least specific):
        //   1) replyToMessageId given     — fetch headers from THAT message.
        //   2) only threadId given        — fetch the latest message in the
        //                                   thread and use its Message-ID.
        //   3) neither                    — send as a fresh email.
        let inReplyTo = null;
        let references = null;
        let threadId = argThreadId || null;
        let originalHeaderSource = null; // for to/subject fallback below

        if (replyToMessageId) {
            try {
                const original = await gmail.users.messages.get({
                    userId: 'me',
                    id: replyToMessageId,
                    format: 'metadata',
                    metadataHeaders: ['Message-ID', 'References', 'From', 'Reply-To', 'Subject'],
                });
                threadId = original.data.threadId;
                originalHeaderSource = original.data.payload?.headers || [];
                inReplyTo = getHeader(originalHeaderSource, 'Message-ID');
                references = getHeader(originalHeaderSource, 'References');
            } catch (err) {
                console.log('[Gmail] Could not fetch reply headers:', err.message);
            }
        } else if (argThreadId) {
            // Automation case: trigger payload gave us the threadId but the
            // builder didn't bind replyToMessageId. Walk the thread, pick
            // the latest message, and pull its Message-ID for In-Reply-To.
            try {
                const thread = await gmail.users.threads.get({
                    userId: 'me',
                    id: argThreadId,
                    format: 'metadata',
                    metadataHeaders: ['Message-ID', 'References', 'From', 'Reply-To', 'Subject'],
                });
                const msgs = thread.data.messages || [];
                const latest = msgs[msgs.length - 1];
                if (latest) {
                    originalHeaderSource = latest.payload?.headers || [];
                    inReplyTo = getHeader(originalHeaderSource, 'Message-ID');
                    references = getHeader(originalHeaderSource, 'References');
                }
            } catch (err) {
                console.log('[Gmail] Could not fetch thread headers:', err.message);
            }
        }

        // Fill in to/subject from the original headers when the caller
        // didn't pass them — same convenience the side-panel extension
        // gets, now also benefits automations that bind only body+threadId.
        if (originalHeaderSource) {
            if (!to) to = getHeader(originalHeaderSource, 'Reply-To') || getHeader(originalHeaderSource, 'From') || null;
            if (!subject) {
                const origSubject = getHeader(originalHeaderSource, 'Subject') || '';
                subject = /^re:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`.trim();
            }
        }

        if (!to) throw new Error('to is required (include replyToMessageId for replies, or pass to explicitly)');
        if (!subject) throw new Error('subject is required (include replyToMessageId for replies, or pass subject explicitly)');

        // Automation / non-interactive callers: send immediately. There is
        // no UI here to render an email_draft preview, so returning one
        // would leave the email permanently stuck (which is the bug users
        // hit when an automation called gmail_compose and never sent).
        if (opts.autoSend) {
            const userEmail = session?.user?.email || '';
            const sendResult = await sendGmailMessage(gmail, {
                to, cc, bcc, subject, body,
                userEmail,
                threadId,
                inReplyTo,
                references,
            });
            return {
                sent: true,
                messageId: sendResult.id,
                threadId: sendResult.threadId,
                to,
                subject,
                message: `Email sent to ${to}.`,
            };
        }

        return {
            _action: 'email_draft',
            draft: {
                to,
                cc: cc || null,
                bcc: bcc || null,
                subject,
                body,
                replyToMessageId: replyToMessageId || null,
                threadId: threadId || null,
                inReplyTo: inReplyTo || null,
                references: references || null,
            },
            message: `Email draft prepared for ${to}. Waiting for user approval to send.`,
        };

    } else {
        throw new Error(`Unknown Gmail tool: ${toolName}`);
    }
}

/**
 * Send a Gmail message directly through the Gmail API. Mirrors the route
 * handler in routes/integrations/gmail.js so the chat path (which uses the
 * route after user approval) and the automation path (which calls this
 * helper) produce identical wire output.
 */
async function sendGmailMessage(gmail, { to, cc, bcc, subject, body, userEmail = '', threadId = null, inReplyTo = null, references = null }) {
    const hasNonAscii = /[^\x00-\x7F]/.test(subject || '');
    const encodedSubject = hasNonAscii
        ? `=?UTF-8?B?${Buffer.from(subject || '', 'utf-8').toString('base64')}?=`
        : (subject || '');

    const headers = [
        `To: ${to}`,
        `From: ${userEmail}`,
        `Subject: ${encodedSubject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
    ];
    if (cc) headers.push(`Cc: ${cc}`);
    if (bcc) headers.push(`Bcc: ${bcc}`);
    if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
    if (references) headers.push(`References: ${references} ${inReplyTo || ''}`);

    const encodedBody = Buffer.from(body || '', 'utf-8').toString('base64');
    const rawMessage = headers.join('\r\n') + '\r\n\r\n' + encodedBody;

    const encodedMessage = Buffer.from(rawMessage)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    const sendParams = { userId: 'me', requestBody: { raw: encodedMessage } };
    if (threadId) sendParams.requestBody.threadId = threadId;

    const result = await gmail.users.messages.send(sendParams);
    console.log(`[Gmail] (autoSend) Email sent: ${result.data.id} to ${to}`);
    return { id: result.data.id, threadId: result.data.threadId };
}

/**
 * Check if a tool name is a Gmail tool.
 */
function isGmailTool(toolName) {
    return ['gmail_search', 'gmail_read', 'gmail_read_attachment', 'gmail_compose'].includes(toolName);
}

module.exports = {
    GMAIL_TOOLS,
    executeGmailTool,
    isGmailTool,
    createGmailClient,
};
