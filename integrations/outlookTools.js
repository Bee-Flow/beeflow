/**
 * Outlook Tools — Built-in tools for AI to search, read, and compose Outlook emails
 * 
 * Mirror of gmailTools.js for Microsoft 365 users.
 * Uses Microsoft Graph API v1.0 with OAuth2 tokens from session.
 */

const { graphFetch, isMicrosoftConnected } = require('./msGraphClient');

/**
 * Tool definitions in OpenAI function-calling format.
 */
const OUTLOOK_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'outlook_search',
            description: 'Search the user\'s Outlook inbox for emails matching a query. Returns a list of email summaries (sender, subject, date, preview). Supports KQL (Keyword Query Language) search syntax and plain keywords.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query (supports keywords, from:, subject:, hasAttachments:true, received>=2025-01-01, etc.)'
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
            name: 'outlook_read',
            description: 'Read the full content of a specific Outlook email by its message ID. Use this after outlook_search to get the complete body of an email.',
            parameters: {
                type: 'object',
                properties: {
                    messageId: {
                        type: 'string',
                        description: 'The Outlook message ID to read (from outlook_search results)'
                    }
                },
                required: ['messageId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'outlook_list_recent',
            description: 'List the most recent emails from the user\'s Outlook mailbox, sorted by date (newest first). Use this when the user asks about their latest/newest/most recent emails, or when outlook_search doesn\'t return the very latest messages. Supports filtering by folder.',
            parameters: {
                type: 'object',
                properties: {
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum number of results to return (1-20, default 10)'
                    },
                    folder: {
                        type: 'string',
                        description: 'Mail folder to list from (default: "inbox"). Common values: inbox, sentitems, drafts, junkemail, deleteditems'
                    },
                    unreadOnly: {
                        type: 'boolean',
                        description: 'If true, only return unread emails (default: false)'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'outlook_compose',
            description: 'Compose and send a new email or reply to an existing email. The user will see a preview with Send, Save as Draft, and Discard buttons before anything is sent — no email is sent automatically. IMPORTANT: When replying, set replyToMessageId to the original message ID. For replies, prefix subject with "Re: ". For forwarding, prefix with "Fwd: " and include the original email body.',
            parameters: {
                type: 'object',
                properties: {
                    to: {
                        type: 'string',
                        description: 'Recipient email address(es), comma-separated for multiple'
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
                        description: 'Email subject line. For replies use "Re: <original subject>", for forwards use "Fwd: <original subject>"'
                    },
                    body: {
                        type: 'string',
                        description: 'Email body text (plain text). For forwards, include the original email content.'
                    },
                    replyToMessageId: {
                        type: 'string',
                        description: 'For replies: Outlook message ID of the email being replied to (from outlook_search or outlook_read results). Omit for new emails.'
                    }
                },
                required: ['to', 'subject', 'body']
            }
        }
    }
];

/**
 * Strip HTML tags from email body and normalize whitespace.
 */
function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Execute an Outlook tool call.
 */
async function executeOutlookTool(toolName, args, session) {
    if (!isMicrosoftConnected(session)) {
        throw new Error('Not connected to Outlook — user must log in with Microsoft');
    }

    if (toolName === 'outlook_search') {
        const { query, maxResults = 10 } = args;
        const top = Math.min(Math.max(parseInt(maxResults) || 10, 1), 20);

        const data = await graphFetch(
            `/me/messages?$search="${encodeURIComponent(query)}"&$top=${top}&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,hasAttachments,isRead`,
            session
        );

        const messages = (data.value || []).map(msg => ({
            id: msg.id,
            from: msg.from?.emailAddress ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address}>` : '',
            to: (msg.toRecipients || []).map(r => r.emailAddress?.address).filter(Boolean).join(', '),
            subject: msg.subject || '(no subject)',
            date: msg.receivedDateTime || '',
            snippet: msg.bodyPreview || '',
            isRead: msg.isRead ?? true,
            hasAttachments: msg.hasAttachments || false,
        }));

        return {
            results: messages,
            total: messages.length,
            query,
            note: 'Results are sorted by relevance, not date. If you need the latest emails, use outlook_list_recent instead.',
        };

    } else if (toolName === 'outlook_list_recent') {
        const { maxResults = 10, folder = 'inbox', unreadOnly = false } = args;
        const top = Math.min(Math.max(parseInt(maxResults) || 10, 1), 20);

        let path = `/me/mailFolders/${folder}/messages?$top=${top}&$orderby=receivedDateTime desc&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,hasAttachments,isRead`;
        if (unreadOnly) {
            path += `&$filter=isRead eq false`;
        }

        const data = await graphFetch(path, session);

        const messages = (data.value || []).map(msg => ({
            id: msg.id,
            from: msg.from?.emailAddress ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address}>` : '',
            to: (msg.toRecipients || []).map(r => r.emailAddress?.address).filter(Boolean).join(', '),
            subject: msg.subject || '(no subject)',
            date: msg.receivedDateTime || '',
            snippet: msg.bodyPreview || '',
            isRead: msg.isRead ?? true,
            hasAttachments: msg.hasAttachments || false,
        }));

        return {
            results: messages,
            total: messages.length,
            folder,
        };

    } else if (toolName === 'outlook_read') {
        const { messageId } = args;
        if (!messageId) throw new Error('messageId is required');

        const msg = await graphFetch(
            `/me/messages/${messageId}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,conversationId`,
            session
        );

        let body = '';
        if (msg.body?.contentType === 'text') {
            body = msg.body.content || '';
        } else {
            // HTML body — strip tags
            body = stripHtml(msg.body?.content || '');
        }

        const MAX_CHARS = 50000;

        const result = {
            id: msg.id,
            from: msg.from?.emailAddress ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address}>` : '',
            to: (msg.toRecipients || []).map(r => `${r.emailAddress?.name || ''} <${r.emailAddress?.address}>`).join(', '),
            cc: (msg.ccRecipients || []).map(r => r.emailAddress?.address).filter(Boolean).join(', '),
            subject: msg.subject || '(no subject)',
            date: msg.receivedDateTime || '',
            body: body.length > MAX_CHARS
                ? body.substring(0, MAX_CHARS) + '\n\n[... truncated, email too large ...]'
                : body,
            conversationId: msg.conversationId || null,
            hasAttachments: msg.hasAttachments || false,
        };

        // Fetch attachments if present
        if (msg.hasAttachments) {
            try {
                const attachData = await graphFetch(`/me/messages/${messageId}/attachments?$select=id,name,contentType,size`, session);
                result.attachments = (attachData.value || []).map(a => ({
                    id: a.id,
                    filename: a.name,
                    mimeType: a.contentType,
                    size: a.size || 0,
                    canOCR: a.contentType === 'application/pdf',
                }));
            } catch (e) {
                console.log('[Outlook] Could not fetch attachments:', e.message);
                result.attachments = [];
            }
        }

        return result;

    } else if (toolName === 'outlook_compose') {
        const { to, cc, bcc, subject, body, replyToMessageId } = args;
        if (!to || !subject || !body) throw new Error('to, subject, and body are required');

        // For replies, fetch conversation context
        let conversationId = null;
        if (replyToMessageId) {
            try {
                const original = await graphFetch(
                    `/me/messages/${replyToMessageId}?$select=conversationId`,
                    session
                );
                conversationId = original.conversationId || null;
            } catch (err) {
                console.log('[Outlook] Could not fetch reply context:', err.message);
            }
        }

        return {
            _action: 'email_draft',
            _provider: 'microsoft',
            draft: {
                _provider: 'microsoft',
                to,
                cc: cc || null,
                bcc: bcc || null,
                subject,
                body,
                replyToMessageId: replyToMessageId || null,
                conversationId: conversationId || null,
            },
            message: `Email draft prepared for ${to}. Waiting for user approval to send.`,
        };

    } else {
        throw new Error(`Unknown Outlook tool: ${toolName}`);
    }
}

/**
 * Execute an approved Outlook email send via Microsoft Graph API.
 * Called after user clicks "Send" on the email draft.
 */
async function executeOutlookSend(draft, session) {
    if (!isMicrosoftConnected(session)) {
        throw new Error('Not connected to Outlook');
    }

    const toRecipients = draft.to.split(',').map(e => ({
        emailAddress: { address: e.trim() }
    }));

    const message = {
        subject: draft.subject,
        body: {
            contentType: 'Text',
            content: draft.body,
        },
        toRecipients,
    };

    if (draft.cc) {
        message.ccRecipients = draft.cc.split(',').map(e => ({
            emailAddress: { address: e.trim() }
        }));
    }

    if (draft.bcc) {
        message.bccRecipients = draft.bcc.split(',').map(e => ({
            emailAddress: { address: e.trim() }
        }));
    }

    // If replying, use the reply endpoint
    if (draft.replyToMessageId) {
        await graphFetch(`/me/messages/${draft.replyToMessageId}/reply`, session, {
            method: 'POST',
            body: JSON.stringify({
                message: {
                    toRecipients,
                    ccRecipients: message.ccRecipients || [],
                },
                comment: draft.body,
            }),
        });
    } else {
        // New email
        await graphFetch('/me/sendMail', session, {
            method: 'POST',
            body: JSON.stringify({
                message,
                saveToSentItems: true,
            }),
        });
    }

    return { success: true, message: 'Email sent via Outlook' };
}

/**
 * Save an Outlook email as a draft.
 */
async function executeOutlookSaveDraft(draft, session) {
    if (!isMicrosoftConnected(session)) {
        throw new Error('Not connected to Outlook');
    }

    const toRecipients = draft.to.split(',').map(e => ({
        emailAddress: { address: e.trim() }
    }));

    const message = {
        subject: draft.subject,
        body: {
            contentType: 'Text',
            content: draft.body,
        },
        toRecipients,
    };

    if (draft.cc) {
        message.ccRecipients = draft.cc.split(',').map(e => ({
            emailAddress: { address: e.trim() }
        }));
    }

    const result = await graphFetch('/me/messages', session, {
        method: 'POST',
        body: JSON.stringify(message),
    });

    return { success: true, draftId: result.id, message: 'Email saved as draft in Outlook' };
}

/**
 * Check if a tool name is an Outlook tool.
 */
function isOutlookTool(toolName) {
    return ['outlook_search', 'outlook_list_recent', 'outlook_read', 'outlook_compose'].includes(toolName);
}

/**
 * Read-only subset of Outlook tools (search, list_recent, read only — no compose/send).
 */
const OUTLOOK_READONLY_TOOLS = OUTLOOK_TOOLS.filter(t =>
    ['outlook_search', 'outlook_list_recent', 'outlook_read'].includes(t.function.name)
);

module.exports = {
    OUTLOOK_TOOLS,
    OUTLOOK_READONLY_TOOLS,
    executeOutlookTool,
    executeOutlookSend,
    executeOutlookSaveDraft,
    isOutlookTool,
};
