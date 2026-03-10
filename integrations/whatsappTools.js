/**
 * WhatsApp Tools — Built-in tools for AI to interact with WhatsApp
 * 
 * These tools are injected into the LLM tool set when the user
 * has an active WhatsApp session, allowing the AI to list chats,
 * read messages, and compose messages with user approval.
 */

const whatsappSession = require('./whatsappSession');

/**
 * Tool definitions in OpenAI function-calling format.
 */
const WHATSAPP_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'whatsapp_list_chats',
            description: `List the user's WhatsApp chats (both individual contacts and groups). Returns chat names, phone numbers (JIDs), and whether they are group chats. Call this FIRST to discover available chats before trying to read messages. You can optionally filter by a search query to find a specific contact or group.`,
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Optional search query to filter chats by name (e.g. "John" or "Work group"). Case-insensitive partial match.'
                    },
                    limit: {
                        type: 'integer',
                        description: 'Maximum number of chats to return. Default: 30, max: 100.'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'whatsapp_read_messages',
            description: `Read recent messages from a WhatsApp chat. You can identify the chat by contact name, phone number, or JID. If using a name, the tool will search across all chats and return messages from the best match. Messages are captured in real-time from the moment the user connected their WhatsApp — older history before connection is not available. Use whatsapp_list_chats first if you need to find the right chat.`,
            parameters: {
                type: 'object',
                properties: {
                    contact: {
                        type: 'string',
                        description: 'Contact name, group name, or phone number to search for (e.g. "Mom", "Work Group", "+31612345678"). The tool performs a fuzzy name search across all known chats.'
                    },
                    jid: {
                        type: 'string',
                        description: 'WhatsApp JID if already known from a previous whatsapp_list_chats call (e.g. "31612345678@s.whatsapp.net" or "123456789@g.us"). Preferred over contact name for accuracy.'
                    },
                    limit: {
                        type: 'integer',
                        description: 'Maximum number of messages to return (default: 25, max: 50)'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'whatsapp_compose',
            description: `Compose a WhatsApp message that requires user approval before sending. The message will be shown to the user as a draft card with Send/Discard options. ALWAYS use this tool to send messages — never bypass the approval step. The user must explicitly click "Send" before the message is delivered. If the user asks to reply to a specific chat, use whatsapp_list_chats first to get the correct JID.`,
            parameters: {
                type: 'object',
                properties: {
                    to: {
                        type: 'string',
                        description: 'Phone number with country code (e.g. "+31612345678") or WhatsApp JID (e.g. "31612345678@s.whatsapp.net" or "123456@g.us" for groups). Use JID from whatsapp_list_chats when available.'
                    },
                    toName: {
                        type: 'string',
                        description: 'Display name of the recipient shown on the approval card (e.g. "Mom", "Work Group"). Always provide this for a good user experience.'
                    },
                    message: {
                        type: 'string',
                        description: 'The message text to send. Supports standard WhatsApp formatting: *bold*, _italic_, ~strikethrough~, ```code```.'
                    }
                },
                required: ['to', 'message']
            }
        }
    }
];

/**
 * Execute a WhatsApp tool.
 */
async function executeWhatsAppTool(toolName, toolArgs, { userId, session }) {
    switch (toolName) {
        case 'whatsapp_list_chats': {
            try {
                let chats = await whatsappSession.getChats(userId);
                
                // Apply search filter if provided
                const query = toolArgs.query?.trim().toLowerCase();
                if (query) {
                    chats = chats.filter(c => 
                        c.name?.toLowerCase().includes(query) ||
                        c.jid?.toLowerCase().includes(query)
                    );
                }

                // Apply limit
                const limit = Math.min(toolArgs.limit || 30, 100);
                
                // Sort: chats with recent activity first (if lastTimestamp exists)
                chats.sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
                
                const sliced = chats.slice(0, limit);

                if (sliced.length === 0) {
                    return { 
                        message: query 
                            ? `No chats found matching "${query}". Try a different search or list all chats without a query.`
                            : 'No chats found. New chats will appear as messages are received. Try again after sending or receiving a message.'
                    };
                }
                return {
                    chats: sliced.map(c => ({
                        name: c.name,
                        jid: c.jid,
                        isGroup: c.isGroup || false,
                        unreadCount: c.unreadCount || 0,
                    })),
                    count: sliced.length,
                    totalAvailable: chats.length,
                    note: chats.length > limit ? `Showing ${limit} of ${chats.length} chats. Use the query parameter to search for specific contacts.` : undefined,
                };
            } catch (err) {
                return { error: `Failed to list chats: ${err.message}` };
            }
        }

        case 'whatsapp_read_messages': {
            const { contact, jid, limit } = toolArgs;
            try {
                let targetJid = jid;

                // If no JID provided, search by contact name
                if (!targetJid && contact) {
                    const searchQuery = contact.trim().toLowerCase();
                    
                    // First try to match in chats
                    const chats = await whatsappSession.getChats(userId);
                    
                    // Try exact match first, then partial
                    let matched = chats.find(c => c.name?.toLowerCase() === searchQuery);
                    if (!matched) {
                        matched = chats.find(c => c.name?.toLowerCase().includes(searchQuery));
                    }
                    if (!matched) {
                        // Try matching by phone number
                        const digits = contact.replace(/[^0-9]/g, '');
                        if (digits.length >= 6) {
                            matched = chats.find(c => c.jid?.includes(digits));
                        }
                    }
                    
                    if (matched) {
                        targetJid = matched.jid;
                    } else {
                        // If no match found in chats, try constructing JID from phone number
                        const digits = contact.replace(/[^0-9]/g, '');
                        if (digits.length >= 8) {
                            targetJid = `${digits}@s.whatsapp.net`;
                        } else {
                            return {
                                error: `No chat found for "${contact}". Use whatsapp_list_chats to see available chats and find the correct name or JID.`,
                                suggestion: 'Try whatsapp_list_chats with a query to search for this contact.'
                            };
                        }
                    }
                }

                if (!targetJid) {
                    return { error: 'Please provide either a contact name or a JID to read messages from.' };
                }

                const result = await whatsappSession.getMessages(userId, targetJid, Math.min(limit || 25, 50));
                return result;
            } catch (err) {
                return { error: `Failed to read messages: ${err.message}` };
            }
        }

        case 'whatsapp_compose': {
            const { to, toName, message } = toolArgs;
            
            // Format the phone number as JID
            const cleanNumber = to.replace(/[^0-9]/g, '');
            const jid = to.includes('@') ? to : `${cleanNumber}@s.whatsapp.net`;
            
            return {
                _action: 'whatsapp_draft',
                draft: {
                    to: jid,
                    toName: toName || to,
                    toNumber: to,
                    message,
                },
                message: `WhatsApp message draft prepared for ${toName || to}. Waiting for user approval to send.`,
            };
        }

        default:
            throw new Error(`Unknown WhatsApp tool: ${toolName}`);
    }
}

/**
 * Check if a tool name is a WhatsApp tool.
 */
function isWhatsAppTool(toolName) {
    return ['whatsapp_list_chats', 'whatsapp_read_messages', 'whatsapp_compose'].includes(toolName);
}

module.exports = {
    WHATSAPP_TOOLS,
    executeWhatsAppTool,
    isWhatsAppTool,
};
