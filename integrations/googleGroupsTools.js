/**
 * Google Groups Tools — Built-in tools for AI to list, read, and reply
 * to Google Groups conversations.
 * 
 * Under the hood, Google Groups conversations are email threads.
 * We use the Gmail API to search for and read messages sent to a group
 * address, and to reply to conversations by sending to the group.
 * 
 * Reuses the existing Google OAuth session (gmail.readonly, gmail.send,
 * gmail.compose scopes are already configured).
 */

const { createGmailClient } = require('./gmailTools');

/**
 * Tool definitions in OpenAI function-calling format.
 */
const GOOGLE_GROUPS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'groups_list_conversations',
            description: 'List recent conversations in a Google Group. Searches the user\'s Gmail for messages in the specified group. You can optionally filter by keywords. Returns conversation threads with subject, participants, date, and snippet.',
            parameters: {
                type: 'object',
                properties: {
                    groupEmail: {
                        type: 'string',
                        description: 'The Google Group email address (e.g. "support@beeflow.nl" or "team@company.com")'
                    },
                    query: {
                        type: 'string',
                        description: 'Optional: additional search keywords to filter conversations (e.g. "invoice", "urgent")'
                    },
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum number of conversations to return (1-20, default 10)'
                    }
                },
                required: ['groupEmail']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'groups_read_conversation',
            description: 'Read all messages in a Google Groups conversation thread. Use this after groups_list_conversations to see the full discussion. Returns all messages in chronological order with sender, date, and body text.',
            parameters: {
                type: 'object',
                properties: {
                    threadId: {
                        type: 'string',
                        description: 'The Gmail thread ID of the group conversation (from groups_list_conversations results)'
                    }
                },
                required: ['threadId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'groups_reply',
            description: 'Reply to a Google Groups conversation. The reply is sent to the group email address so all members can see it. The user will see a preview with Send, Save as Draft, and Discard buttons before anything is sent — no message is sent automatically. IMPORTANT: You MUST provide the replyToMessageId (from groups_read_conversation) to ensure the reply appears in the correct conversation thread.',
            parameters: {
                type: 'object',
                properties: {
                    groupEmail: {
                        type: 'string',
                        description: 'The Google Group email address to reply to (e.g. "support@beeflow.nl")'
                    },
                    replyToMessageId: {
                        type: 'string',
                        description: 'REQUIRED: The Gmail message ID of the message being replied to (from groups_read_conversation results). This ensures the reply appears in the correct conversation thread.'
                    },
                    subject: {
                        type: 'string',
                        description: 'Email subject line. Should be "Re: <original subject>" to maintain threading.'
                    },
                    body: {
                        type: 'string',
                        description: 'The reply message body (plain text).'
                    }
                },
                required: ['groupEmail', 'replyToMessageId', 'subject', 'body']
            }
        }
    }
];

/**
 * Helper: extract header value from Gmail message headers.
 */
function getHeader(headers, name) {
    const h = headers?.find(h => h.name.toLowerCase() === name.toLowerCase());
    return h?.value || '';
}

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

/**
 * Execute a Google Groups tool call.
 * @param {string} toolName - Tool name
 * @param {object} args - Tool arguments
 * @param {object} session - Express session with OAuth tokens
 * @returns {object} Tool result
 */
async function executeGoogleGroupsTool(toolName, args, session) {
    const gmail = await createGmailClient(session);

    if (toolName === 'groups_list_conversations') {
        const { groupEmail, query, maxResults = 10 } = args;
        if (!groupEmail) throw new Error('groupEmail is required');

        // Search Gmail for messages in this group
        // Use "list:" to find messages from a mailing list, fall back to to:/from:
        const baseQuery = `list:${groupEmail}`;
        const fullQuery = query ? `${baseQuery} ${query}` : baseQuery;

        const response = await gmail.users.threads.list({
            userId: 'me',
            q: fullQuery,
            maxResults: Math.min(Math.max(parseInt(maxResults) || 10, 1), 20),
        });

        const threads = response.data.threads || [];
        if (threads.length === 0) {
            return { results: [], message: `No conversations found in ${groupEmail}${query ? ` matching "${query}"` : ''}` };
        }

        // Fetch metadata for each thread
        const conversations = await Promise.all(
            threads.map(async (thread) => {
                try {
                    const detail = await gmail.users.threads.get({
                        userId: 'me',
                        id: thread.id,
                        format: 'metadata',
                        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
                    });

                    const messages = detail.data.messages || [];
                    const firstMsg = messages[0];
                    const lastMsg = messages[messages.length - 1];
                    const firstHeaders = firstMsg?.payload?.headers || [];
                    const lastHeaders = lastMsg?.payload?.headers || [];

                    return {
                        threadId: thread.id,
                        subject: getHeader(firstHeaders, 'Subject') || '(no subject)',
                        startedBy: getHeader(firstHeaders, 'From'),
                        lastReplyBy: messages.length > 1 ? getHeader(lastHeaders, 'From') : null,
                        lastReplyDate: getHeader(lastHeaders, 'Date'),
                        messageCount: messages.length,
                        snippet: lastMsg?.snippet || firstMsg?.snippet || '',
                        lastMessageId: lastMsg?.id || firstMsg?.id,
                    };
                } catch {
                    return null;
                }
            })
        );

        return {
            groupEmail,
            results: conversations.filter(Boolean),
            total: response.data.resultSizeEstimate || threads.length,
        };

    } else if (toolName === 'groups_read_conversation') {
        const { threadId } = args;
        if (!threadId) throw new Error('threadId is required');

        const detail = await gmail.users.threads.get({
            userId: 'me',
            id: threadId,
            format: 'full',
        });

        const messages = detail.data.messages || [];
        const firstHeaders = messages[0]?.payload?.headers || [];
        const MAX_CHARS = 50000;

        const formattedMessages = messages.map(msg => {
            const headers = msg.payload?.headers || [];
            const body = extractTextBody(msg.payload);
            return {
                id: msg.id,
                from: getHeader(headers, 'From'),
                to: getHeader(headers, 'To'),
                date: getHeader(headers, 'Date'),
                body: body.length > MAX_CHARS
                    ? body.substring(0, MAX_CHARS) + '\n\n[... truncated ...]'
                    : body,
            };
        });

        return {
            threadId,
            subject: getHeader(firstHeaders, 'Subject') || '(no subject)',
            messageCount: messages.length,
            messages: formattedMessages,
        };

    } else if (toolName === 'groups_reply') {
        const { groupEmail, replyToMessageId, subject, body } = args;
        if (!groupEmail || !replyToMessageId || !subject || !body) {
            throw new Error('groupEmail, replyToMessageId, subject, and body are required');
        }

        // Fetch original message headers for threading
        let inReplyTo = null;
        let references = null;
        let threadId = null;
        try {
            const original = await gmail.users.messages.get({
                userId: 'me',
                id: replyToMessageId,
                format: 'metadata',
                metadataHeaders: ['Message-ID', 'References'],
            });
            threadId = original.data.threadId;
            const headers = original.data.payload?.headers || [];
            inReplyTo = getHeader(headers, 'Message-ID');
            references = getHeader(headers, 'References');
        } catch (err) {
            console.log('[GoogleGroups] Could not fetch reply headers:', err.message);
        }

        // Return email draft for user approval (reuses existing email_draft flow)
        return {
            _action: 'email_draft',
            draft: {
                to: groupEmail,
                cc: null,
                bcc: null,
                subject,
                body,
                replyToMessageId,
                threadId: threadId || null,
                inReplyTo: inReplyTo || null,
                references: references || null,
            },
            message: `Reply draft prepared for group ${groupEmail}. Waiting for user approval to send.`,
        };

    } else {
        throw new Error(`Unknown Google Groups tool: ${toolName}`);
    }
}

/**
 * Check if a tool name is a Google Groups tool.
 */
function isGoogleGroupsTool(toolName) {
    return ['groups_list_conversations', 'groups_read_conversation', 'groups_reply'].includes(toolName);
}

module.exports = {
    GOOGLE_GROUPS_TOOLS,
    executeGoogleGroupsTool,
    isGoogleGroupsTool,
};
