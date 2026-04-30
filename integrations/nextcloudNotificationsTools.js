/**
 * Nextcloud Notifications Tools — list / dismiss notifications via the OCS
 * Notifications API (/ocs/v2.php/apps/notifications/api/v2/notifications).
 *
 * Auth handled by ./nextcloudClient (Bearer for OAuth users, app-password
 * Basic otherwise).
 */

const ncClient = require('./nextcloudClient');

const NEXTCLOUD_NOTIFICATIONS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_notifications_list',
            description: 'List the user\'s pending Nextcloud notifications (subject, message, app, datetime, action links).',
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'integer', description: 'Max notifications (default 50, max 200).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_notifications_dismiss',
            description: 'Dismiss a single notification by id. The user has approved this dismissal.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'integer', description: 'Notification id (from list).' }
                },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_notifications_dismiss_all',
            description: 'Dismiss every pending notification for the current user. Always confirm with the user before calling — this clears the entire inbox.',
            parameters: { type: 'object', properties: {} }
        }
    }
];

async function readJsonSafe(res) {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text); } catch { return text; }
}

function notificationsApi(baseUrl) {
    return `${baseUrl}/ocs/v2.php/apps/notifications/api/v2/notifications`;
}

async function executeNextcloudNotificationsTool(toolName, args, userId, session) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    const api = notificationsApi(baseUrl);

    switch (toolName) {
        case 'nextcloud_notifications_list': {
            const limit = Math.min(Math.max(args.limit || 50, 1), 200);
            const res = await ncFetch(`${api}?format=json`, {
                headers: { 'Accept': 'application/json', 'OCS-APIRequest': 'true' },
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: 'Notifications app is not installed/enabled on this Nextcloud server.' };
            if (!res.ok) return { error: `Notifications list failed (${res.status})` };
            const data = await readJsonSafe(res);
            const items = Array.isArray(data?.ocs?.data) ? data.ocs.data : [];
            const mapped = items.slice(0, limit).map(n => ({
                id: n.notification_id,
                app: n.app,
                user: n.user,
                datetime: n.datetime,
                objectType: n.object_type,
                objectId: n.object_id,
                subject: n.subject,
                message: n.message,
                link: n.link,
                icon: n.icon,
                actions: (n.actions || []).map(a => ({ label: a.label, link: a.link, type: a.type, primary: a.primary })),
            }));
            return { count: mapped.length, notifications: mapped };
        }

        case 'nextcloud_notifications_dismiss': {
            if (!args.id) return { error: 'id is required' };
            const res = await ncFetch(`${api}/${encodeURIComponent(args.id)}?format=json`, {
                method: 'DELETE',
                headers: { 'Accept': 'application/json', 'OCS-APIRequest': 'true' },
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Notification not found or already dismissed: ${args.id}` };
            if (!res.ok) return { error: `Dismiss failed (${res.status})` };
            return { success: true, id: args.id };
        }

        case 'nextcloud_notifications_dismiss_all': {
            const res = await ncFetch(`${api}?format=json`, {
                method: 'DELETE',
                headers: { 'Accept': 'application/json', 'OCS-APIRequest': 'true' },
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Dismiss-all failed (${res.status})` };
            return { success: true };
        }

        default:
            return { error: `Unknown Nextcloud notifications tool: ${toolName}` };
    }
}

function isNextcloudNotificationsTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_notifications_');
}

module.exports = {
    NEXTCLOUD_NOTIFICATIONS_TOOLS,
    executeNextcloudNotificationsTool,
    isNextcloudNotificationsTool,
};
