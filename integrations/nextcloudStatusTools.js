/**
 * Nextcloud User Status Tools — get / set / clear the current user's status.
 *
 * Endpoint: /ocs/v2.php/apps/user_status/api/v1/user_status
 *
 * The status combines:
 *   • availability — online | away | dnd | invisible | offline | busy
 *   • predefinedStatus — short label like "meeting", "vacationing"
 *   • custom emoji + message + clearAt timeout
 *
 * Useful for "I'm in a meeting until 15:00" auto-status from a calendar event.
 */

const ncClient = require('./nextcloudClient');

const NEXTCLOUD_STATUS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_status_get',
            description: 'Get the current user\'s Nextcloud status (availability, custom message, emoji, clear-at).',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_status_set',
            description: 'Set the user\'s Nextcloud status. The user has approved this. Provide one or more of: availability, message, emoji, clearAt.',
            parameters: {
                type: 'object',
                properties: {
                    availability: { type: 'string', enum: ['online', 'away', 'dnd', 'invisible', 'offline', 'busy'], description: 'Presence state.' },
                    message: { type: 'string', description: 'Free-text status message.' },
                    emoji: { type: 'string', description: 'Single emoji to display next to the status.' },
                    clearAt: { type: 'string', description: 'ISO 8601 datetime when the status should auto-clear (e.g. "2026-04-30T15:00:00Z"). Omit to keep until manually cleared.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_status_clear',
            description: 'Clear the user\'s custom status message and emoji (availability is preserved).',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_status_set_predefined',
            description: 'Set a predefined status (meeting, commuting, sick, vacationing, remote-work). The Nextcloud server defines the allowed list.',
            parameters: {
                type: 'object',
                properties: {
                    messageId: { type: 'string', description: 'Predefined status id (e.g. "meeting", "commuting", "sick-leave", "vacationing", "remote-work").' },
                    clearAt: { type: 'string', description: 'Optional ISO 8601 auto-clear time.' }
                },
                required: ['messageId']
            }
        }
    }
];

function statusApi(baseUrl) {
    return `${baseUrl}/ocs/v2.php/apps/user_status/api/v1/user_status`;
}

async function readJsonSafe(res) {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text); } catch { return text; }
}

function commonHeaders() {
    return { 'Accept': 'application/json', 'OCS-APIRequest': 'true' };
}

function mapStatus(s) {
    return {
        userId: s.userId,
        status: s.status,
        message: s.message,
        messageId: s.messageId,
        icon: s.icon,
        clearAt: s.clearAt,
        statusIsUserDefined: s.statusIsUserDefined,
        messageIsPredefined: s.messageIsPredefined,
    };
}

async function executeNextcloudStatusTool(toolName, args, userId, session) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    const api = statusApi(baseUrl);
    const jsonHeaders = { ...commonHeaders(), 'Content-Type': 'application/json' };

    switch (toolName) {
        case 'nextcloud_status_get': {
            const res = await ncFetch(`${api}?format=json`, { headers: commonHeaders() });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: 'User status app is not installed/enabled on this Nextcloud server.' };
            if (!res.ok) return { error: `Status fetch failed (${res.status})` };
            const data = await readJsonSafe(res);
            return data?.ocs?.data ? mapStatus(data.ocs.data) : data;
        }

        case 'nextcloud_status_set': {
            const calls = [];
            if (args.availability) {
                calls.push(['/status', 'PUT', { statusType: args.availability }]);
            }
            const clearAtSec = args.clearAt ? Math.floor(new Date(args.clearAt).getTime() / 1000) : null;
            if (args.message !== undefined || args.emoji !== undefined) {
                calls.push(['/message/custom', 'PUT', {
                    statusIcon: args.emoji || '',
                    message: args.message || '',
                    clearAt: clearAtSec,
                }]);
            }
            if (calls.length === 0) return { error: 'no fields provided (availability, message, emoji, or clearAt required)' };
            for (const [path, method, body] of calls) {
                const res = await ncFetch(`${api}${path}?format=json`, {
                    method,
                    headers: jsonHeaders,
                    body: JSON.stringify(body),
                });
                if (res.status === 401) return { error: authError };
                if (!res.ok) {
                    const err = await readJsonSafe(res);
                    return { error: `Status set failed (${res.status})`, detail: err };
                }
            }
            // Return the merged result.
            const finalRes = await ncFetch(`${api}?format=json`, { headers: commonHeaders() });
            const data = await readJsonSafe(finalRes);
            return { success: true, status: data?.ocs?.data ? mapStatus(data.ocs.data) : null };
        }

        case 'nextcloud_status_clear': {
            const res = await ncFetch(`${api}/message?format=json`, {
                method: 'DELETE',
                headers: commonHeaders(),
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Status clear failed (${res.status})` };
            return { success: true };
        }

        case 'nextcloud_status_set_predefined': {
            if (!args.messageId) return { error: 'messageId is required' };
            const clearAtSec = args.clearAt ? Math.floor(new Date(args.clearAt).getTime() / 1000) : null;
            const res = await ncFetch(`${api}/message/predefined?format=json`, {
                method: 'PUT',
                headers: jsonHeaders,
                body: JSON.stringify({ messageId: args.messageId, clearAt: clearAtSec }),
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 400) return { error: `Unknown predefined status: ${args.messageId}` };
            if (!res.ok) {
                const err = await readJsonSafe(res);
                return { error: `Predefined status set failed (${res.status})`, detail: err };
            }
            const data = await readJsonSafe(res);
            return { success: true, status: data?.ocs?.data ? mapStatus(data.ocs.data) : null };
        }

        default:
            return { error: `Unknown Nextcloud status tool: ${toolName}` };
    }
}

function isNextcloudStatusTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_status_');
}

module.exports = {
    NEXTCLOUD_STATUS_TOOLS,
    executeNextcloudStatusTool,
    isNextcloudStatusTool,
};
