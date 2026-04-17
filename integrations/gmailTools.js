/**
 * Gmail Tools — Built-in tools for AI to search and read Gmail
 * 
 * These tools are injected into the LLM tool set when the user
 * is logged in with Google, allowing the AI to proactively search
 * and read emails during conversations.
 */

const { google } = require('googleapis');
const { loadConfig } = require('../auth/permissions');
const { mistralOCR } = require('../core/ocr');

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
                        description: 'REQUIRED for replies: Gmail message ID of the email being replied to (from gmail_search or gmail_read results). This ensures the reply appears in the same thread. Omit only for new emails and forwards.'
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
 * @param {string} toolName - 'gmail_search' or 'gmail_read'
 * @param {object} args - Tool arguments
 * @param {object} session - Express session with OAuth tokens
 * @returns {object} Tool result
 */
async function executeGmailTool(toolName, args, session) {
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
        const pdfBuffer = Buffer.from(standardBase64, 'base64');

        // Try Mistral OCR first, then fall back to local PDF text extraction
        let extractedText = '';
        try {
            extractedText = await mistralOCR(standardBase64, 'application/pdf', fname || 'attachment.pdf');
        } catch (ocrErr) {
            console.log(`[Gmail] Mistral OCR failed for ${fname}: ${ocrErr.message}, trying local PDF parser...`);
        }

        if (!extractedText) {
            // Fallback: use local pdfjs-based text extraction
            try {
                const { extractTextFromPDF } = require('../core/pdfExtractor');
                extractedText = await extractTextFromPDF(pdfBuffer, fname || 'attachment.pdf');
            } catch (pdfErr) {
                console.log(`[Gmail] Local PDF extraction also failed for ${fname}: ${pdfErr.message}`);
            }
        }

        if (!extractedText) {
            return {
                error: 'Could not extract text from the PDF. Both OCR and text extraction failed.',
                filename: fname || 'attachment.pdf',
            };
        }

        // Truncate if very large
        const MAX_CHARS = 80000;
        return {
            filename: fname || 'attachment.pdf',
            content: extractedText.length > MAX_CHARS
                ? extractedText.substring(0, MAX_CHARS) + '\n\n[... truncated, document too large ...]'
                : extractedText,
            charCount: extractedText.length,
            truncated: extractedText.length > MAX_CHARS,
        };

    } else if (toolName === 'gmail_compose') {
        let { to, cc, bcc, subject, body, replyToMessageId } = args;
        if (!body) throw new Error('body is required');

        // When replying, fetch the original email's headers — both for threading
        // (In-Reply-To / References) and to fill in to/subject if the model
        // didn't provide them. This is the common case for the Gmail side-panel
        // extension, where the thread is already attached as context.
        let inReplyTo = null;
        let references = null;
        let threadId = null;
        if (replyToMessageId) {
            try {
                const original = await gmail.users.messages.get({
                    userId: 'me',
                    id: replyToMessageId,
                    format: 'metadata',
                    metadataHeaders: ['Message-ID', 'References', 'From', 'Reply-To', 'Subject'],
                });
                threadId = original.data.threadId;
                const headers = original.data.payload?.headers || [];
                inReplyTo = getHeader(headers, 'Message-ID');
                references = getHeader(headers, 'References');

                if (!to) to = getHeader(headers, 'Reply-To') || getHeader(headers, 'From') || null;
                if (!subject) {
                    const origSubject = getHeader(headers, 'Subject') || '';
                    subject = /^re:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`.trim();
                }
            } catch (err) {
                console.log('[Gmail] Could not fetch reply headers:', err.message);
            }
        }

        if (!to) throw new Error('to is required (include replyToMessageId for replies, or pass to explicitly)');
        if (!subject) throw new Error('subject is required (include replyToMessageId for replies, or pass subject explicitly)');

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
