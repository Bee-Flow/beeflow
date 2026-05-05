/**
 * Nextcloud Talk Tools — chat rooms, messages, reactions.
 *
 * APIs:
 *   v4: /ocs/v2.php/apps/spreed/api/v4/   — rooms (conversations)
 *   v1: /ocs/v2.php/apps/spreed/api/v1/   — chat, reactions, read state
 *
 * Auth handled by ./nextcloudClient (Bearer for OAuth users, app-password
 * Basic otherwise — same dual-mode pattern as the file/calendar/contacts
 * tools).
 */

const ncClient = require('./nextcloudClient');

const NEXTCLOUD_TALK_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_list_rooms',
            description: 'List the user\'s Nextcloud Talk conversations (rooms). Returns token, type, name, last message preview, unread count.',
            parameters: {
                type: 'object',
                properties: {
                    includeStatus: { type: 'boolean', description: 'Include presence info (default false).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_get_room',
            description: 'Fetch detailed information about a single Talk room.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string', description: 'Room token (from list_rooms).' }
                },
                required: ['token']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_create_room',
            description: 'Create a new Talk room. The user has approved this. roomType: 1 = one-to-one, 2 = group, 3 = public, 4 = changelog.',
            parameters: {
                type: 'object',
                properties: {
                    roomType: { type: 'integer', description: '1=one-to-one, 2=group, 3=public, 4=changelog (default 2).' },
                    invite: { type: 'string', description: 'For roomType=1: target uid. For roomType=2: group id (optional).' },
                    roomName: { type: 'string', description: 'Display name (required for group/public rooms).' },
                    objectType: { type: 'string', description: 'Optional: link the room to an object type (e.g. "file", "deck-board").' },
                    objectId: { type: 'string', description: 'Optional: id of the linked object.' }
                },
                required: ['roomType']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_list_messages',
            description: 'Fetch the most recent messages from a Talk room. Returns id, actor, message text, mentions, reactions, parent (for replies), timestamp.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string', description: 'Room token.' },
                    limit: { type: 'integer', description: 'Number of messages (default 50, max 200).' },
                    lookIntoFuture: { type: 'integer', description: '0 = past messages (default), 1 = wait for new ones (long-poll, not recommended for tools).' }
                },
                required: ['token']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_search_messages',
            description: 'Search Talk messages across all rooms by case-insensitive substring.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    limit: { type: 'integer', description: 'Max results (default 25, max 100).' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_send_message',
            description: 'Post a message to a Talk room. The user has approved sending this message — go ahead. Use replyTo to reply to a specific message; use silent=true to suppress notifications.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string', description: 'Room token.' },
                    message: { type: 'string', description: 'Message text. Mentions use @"username" syntax.' },
                    replyTo: { type: 'integer', description: 'Optional message id to reply to.' },
                    silent: { type: 'boolean', description: 'Suppress notifications for this message (default false).' }
                },
                required: ['token', 'message']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_delete_message',
            description: 'Delete (soft-delete) a Talk message you sent. Always confirm with the user before calling.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string' },
                    messageId: { type: 'integer' }
                },
                required: ['token', 'messageId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_add_reaction',
            description: 'Add an emoji reaction to a message.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string' },
                    messageId: { type: 'integer' },
                    reaction: { type: 'string', description: 'Single emoji (e.g. "👍", "❤️", "🎉").' }
                },
                required: ['token', 'messageId', 'reaction']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_remove_reaction',
            description: 'Remove your own emoji reaction from a message.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string' },
                    messageId: { type: 'integer' },
                    reaction: { type: 'string' }
                },
                required: ['token', 'messageId', 'reaction']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_mark_read',
            description: 'Mark a Talk room as read up to the given message id.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string' },
                    lastReadMessage: { type: 'integer', description: 'Message id; the room will be marked read up to and including this.' }
                },
                required: ['token']
            }
        }
    }
];

async function readJsonSafe(res) {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text); } catch { return text; }
}

function v4(baseUrl) { return `${baseUrl}/ocs/v2.php/apps/spreed/api/v4`; }
function v1(baseUrl) { return `${baseUrl}/ocs/v2.php/apps/spreed/api/v1`; }

const COMMON_HEADERS = {
    'OCS-APIRequest': 'true',
    'Accept': 'application/json',
};

function mapRoom(r) {
    return {
        token: r.token,
        type: r.type,
        name: r.displayName || r.name,
        description: r.description,
        unreadMessages: r.unreadMessages,
        unreadMention: r.unreadMention,
        lastActivity: r.lastActivity,
        lastMessage: r.lastMessage ? { id: r.lastMessage.id, actor: r.lastMessage.actorDisplayName, message: r.lastMessage.message, timestamp: r.lastMessage.timestamp } : null,
        participantType: r.participantType,
        canStartCall: r.canStartCall,
        readOnly: r.readOnly,
    };
}

function mapMessage(m) {
    return {
        id: m.id,
        actor: m.actorDisplayName || m.actorId,
        actorId: m.actorId,
        actorType: m.actorType,
        timestamp: m.timestamp,
        message: m.message,
        messageParameters: m.messageParameters,
        systemMessage: m.systemMessage || null,
        parent: m.parent ? mapMessage(m.parent) : null,
        reactions: m.reactions || {},
    };
}

async function executeNextcloudTalkTool(toolName, args, userId, session) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const { baseUrl, fetch: ncFetch, authError } = ctx;

    switch (toolName) {
        case 'nextcloud_talk_list_rooms': {
            const params = new URLSearchParams({ format: 'json' });
            if (args.includeStatus) params.set('includeStatus', 'true');
            const url = `${v4(baseUrl)}/room?${params.toString()}`;
            const res = await ncFetch(url, { headers: COMMON_HEADERS });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: 'Talk app is not installed/enabled on this Nextcloud server.' };
            if (!res.ok) return { error: `Talk room list failed (${res.status})` };
            const data = await readJsonSafe(res);
            const rooms = Array.isArray(data?.ocs?.data) ? data.ocs.data.map(mapRoom) : [];
            return { count: rooms.length, rooms };
        }

        case 'nextcloud_talk_get_room': {
            if (!args.token) return { error: 'token is required' };
            const res = await ncFetch(`${v4(baseUrl)}/room/${encodeURIComponent(args.token)}?format=json`, { headers: COMMON_HEADERS });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Room not found: ${args.token}` };
            if (!res.ok) return { error: `Talk room fetch failed (${res.status})` };
            const data = await readJsonSafe(res);
            return data?.ocs?.data ? mapRoom(data.ocs.data) : data;
        }

        case 'nextcloud_talk_create_room': {
            if (!args.roomType) return { error: 'roomType is required (1=one-to-one, 2=group, 3=public, 4=changelog)' };
            const body = {
                roomType: args.roomType,
                invite: args.invite || '',
                roomName: args.roomName || '',
                source: '',
                objectType: args.objectType || '',
                objectId: args.objectId || '',
            };
            const res = await ncFetch(`${v4(baseUrl)}/room?format=json`, {
                method: 'POST',
                headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) {
                const err = await readJsonSafe(res);
                return { error: `Room create failed (${res.status})`, detail: err };
            }
            const data = await readJsonSafe(res);
            return data?.ocs?.data ? { success: true, room: mapRoom(data.ocs.data) } : { success: true, raw: data };
        }

        case 'nextcloud_talk_list_messages': {
            if (!args.token) return { error: 'token is required' };
            const limit = Math.min(Math.max(args.limit || 50, 1), 200);
            const url = `${v1(baseUrl)}/chat/${encodeURIComponent(args.token)}?lookIntoFuture=${args.lookIntoFuture || 0}&limit=${limit}&format=json`;
            const res = await ncFetch(url, { headers: COMMON_HEADERS });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Room not found: ${args.token}` };
            if (res.status === 304) return { token: args.token, count: 0, messages: [] };
            if (!res.ok) return { error: `Talk message fetch failed (${res.status})` };
            const data = await readJsonSafe(res);
            const messages = Array.isArray(data?.ocs?.data) ? data.ocs.data.map(mapMessage) : [];
            return { token: args.token, count: messages.length, messages };
        }

        case 'nextcloud_talk_search_messages': {
            const q = String(args.query || '').trim();
            if (!q) return { error: 'query is required' };
            const limit = Math.min(Math.max(args.limit || 25, 1), 100);
            const url = `${baseUrl}/ocs/v2.php/search/providers/talk-message/search?term=${encodeURIComponent(q)}&limit=${limit}&format=json`;
            const res = await ncFetch(url, { headers: COMMON_HEADERS });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Talk search failed (${res.status})` };
            const data = await readJsonSafe(res);
            const entries = data?.ocs?.data?.entries || [];
            return {
                query: q,
                count: entries.length,
                messages: entries.slice(0, limit).map(e => ({
                    title: e.title,
                    subline: e.subline,
                    resourceUrl: e.resourceUrl,
                    icon: e.icon,
                    attributes: e.attributes,
                })),
            };
        }

        case 'nextcloud_talk_send_message': {
            if (!args.token || !args.message) return { error: 'token and message are required' };
            const body = {
                message: args.message,
                replyTo: args.replyTo || 0,
                silent: !!args.silent,
            };
            const res = await ncFetch(`${v1(baseUrl)}/chat/${encodeURIComponent(args.token)}?format=json`, {
                method: 'POST',
                headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Room not found: ${args.token}` };
            if (res.status === 413) return { error: 'Message too long.' };
            if (!res.ok && res.status !== 201) {
                const err = await readJsonSafe(res);
                return { error: `Talk send failed (${res.status})`, detail: err };
            }
            const data = await readJsonSafe(res);
            return data?.ocs?.data ? { success: true, message: mapMessage(data.ocs.data) } : { success: true };
        }

        case 'nextcloud_talk_delete_message': {
            if (!args.token || !args.messageId) return { error: 'token and messageId are required' };
            const res = await ncFetch(`${v1(baseUrl)}/chat/${encodeURIComponent(args.token)}/${encodeURIComponent(args.messageId)}?format=json`, {
                method: 'DELETE',
                headers: COMMON_HEADERS,
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Message not found: ${args.messageId}` };
            if (res.status === 405) return { error: 'Message cannot be deleted (too old or not your own).' };
            if (!res.ok && res.status !== 200 && res.status !== 202) return { error: `Talk delete failed (${res.status})` };
            return { success: true, messageId: args.messageId };
        }

        case 'nextcloud_talk_add_reaction':
        case 'nextcloud_talk_remove_reaction': {
            if (!args.token || !args.messageId || !args.reaction) return { error: 'token, messageId, reaction required' };
            const method = toolName === 'nextcloud_talk_add_reaction' ? 'POST' : 'DELETE';
            const res = await ncFetch(`${v1(baseUrl)}/reaction/${encodeURIComponent(args.token)}/${encodeURIComponent(args.messageId)}?format=json`, {
                method,
                headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
                body: JSON.stringify({ reaction: args.reaction }),
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok && res.status !== 200 && res.status !== 201) {
                const err = await readJsonSafe(res);
                return { error: `Reaction ${method} failed (${res.status})`, detail: err };
            }
            return { success: true };
        }

        case 'nextcloud_talk_mark_read': {
            if (!args.token) return { error: 'token is required' };
            const body = args.lastReadMessage ? { lastReadMessage: args.lastReadMessage } : {};
            const res = await ncFetch(`${v1(baseUrl)}/chat/${encodeURIComponent(args.token)}/read?format=json`, {
                method: 'POST',
                headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Mark read failed (${res.status})` };
            return { success: true };
        }

        default:
            return { error: `Unknown Nextcloud Talk tool: ${toolName}` };
    }
}

function isNextcloudTalkTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_talk_');
}

module.exports = {
    NEXTCLOUD_TALK_TOOLS,
    executeNextcloudTalkTool,
    isNextcloudTalkTool,
};
