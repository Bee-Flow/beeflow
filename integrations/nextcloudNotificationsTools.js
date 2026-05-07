/**
 * Nextcloud Notifications Tools — list / dismiss / send notifications via
 * the OCS Notifications API.
 *
 * Read & dismiss: /ocs/v2.php/apps/notifications/api/v2/notifications
 * Send (admin):    /ocs/v2.php/apps/notifications/api/v2/admin_notifications/{userId}
 *
 * The send endpoint is admin-only on Nextcloud's side — non-admin sessions
 * receive 403/404. Auth handled by ./nextcloudClient.
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
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_notifications_send',
            description: 'Send a notification to a Nextcloud user (admin only — Nextcloud rejects this from non-admin sessions). If userId is omitted, the notification is sent to the currently connected Nextcloud user (i.e. the owner of the app password / OAuth session). The user has approved this — go ahead and send it.',
            parameters: {
                type: 'object',
                properties: {
                    userId: { type: 'string', description: 'Optional Nextcloud user id (uid) to notify, e.g. "alice". Defaults to the connected user (yourself) when omitted — use that for "send me a test notification".' },
                    shortMessage: { type: 'string', description: 'Headline shown on the bell icon. Max 255 characters.' },
                    longMessage: { type: 'string', description: 'Optional body text. Max 4000 characters.' }
                },
                required: ['shortMessage']
            }
        }
    }
];

const SHORT_MESSAGE_MAX = 255;
const LONG_MESSAGE_MAX = 4000;

async function readJsonSafe(res) {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text); } catch { return text; }
}

function notificationsApi(baseUrl) {
    return `${baseUrl}/ocs/v2.php/apps/notifications/api/v2/notifications`;
}

async function executeNextcloudNotificationsTool(toolName, args, userId, session) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const { baseUrl, fetch: ncFetch, authError, uid: connectedUid } = ctx;
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

        case 'nextcloud_notifications_send': {
            // Default to the connected Nextcloud user — same uid the rest of
            // the integration uses for /remote.php/dav paths. This makes
            // "send me a test notification" work without the LLM having to
            // guess at the user's exact uid (which can differ from email
            // prefix or display name).
            const targetUid = String(args.userId || connectedUid || '').trim();
            const sendingToSelf = !args.userId || String(args.userId).trim() === connectedUid;
            const shortMessage = String(args.shortMessage || '').trim();
            const longMessage = args.longMessage != null ? String(args.longMessage) : '';
            if (!targetUid) return { error: 'Could not determine target user — pass userId explicitly.' };
            if (!shortMessage) return { error: 'shortMessage is required' };
            if (shortMessage.length > SHORT_MESSAGE_MAX) {
                return { error: `shortMessage exceeds ${SHORT_MESSAGE_MAX} characters (got ${shortMessage.length}).` };
            }
            if (longMessage.length > LONG_MESSAGE_MAX) {
                return { error: `longMessage exceeds ${LONG_MESSAGE_MAX} characters (got ${longMessage.length}).` };
            }
            const url = `${baseUrl}/ocs/v2.php/apps/notifications/api/v2/admin_notifications/${encodeURIComponent(targetUid)}?format=json`;
            const body = new URLSearchParams({ shortMessage });
            if (longMessage) body.set('longMessage', longMessage);
            const res = await ncFetch(url, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'OCS-APIRequest': 'true',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: body.toString(),
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 403) {
                return { error: `Sending Nextcloud notifications requires admin privileges. Your connected account "${connectedUid}" doesn't have them on this Nextcloud server, so this endpoint is unavailable to you.` };
            }
            if (res.status === 404) {
                return {
                    error: sendingToSelf
                        ? `Nextcloud rejected the send (404). Most likely cause: your account "${connectedUid}" is not an admin, so the admin_notifications endpoint is hidden. Ask a Nextcloud admin to grant you admin rights, or use this tool from an admin account.`
                        : `User "${targetUid}" not found, or your account "${connectedUid}" lacks admin rights to notify them.`,
                };
            }
            if (!res.ok) {
                const detail = await readJsonSafe(res);
                return { error: `Send failed (${res.status})`, detail };
            }
            return {
                success: true,
                userId: targetUid,
                sentToSelf: sendingToSelf,
                shortMessage,
                longMessage: longMessage || null,
            };
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
