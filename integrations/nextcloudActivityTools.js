/**
 * Nextcloud Activity Tools — read-only stream of "what happened".
 *
 * The OCS Activity API returns a feed of events (file edits, shares received,
 * comments, mentions, calendar invites, Talk messages, etc.) with type, actor,
 * subject, link, and timestamp. Useful for "what's new since yesterday" or
 * "what happened to this file recently" questions.
 */

const ncClient = require('./nextcloudClient');

const NEXTCLOUD_ACTIVITY_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_activity_list',
            description: 'Read recent Nextcloud activity events (file changes, shares, comments, mentions, calendar invites). Returns subject, actor, type, object, link, timestamp.',
            parameters: {
                type: 'object',
                properties: {
                    filter: { type: 'string', description: 'Filter type: "all" (default), "self" (only your actions), "by" (others\' actions on your data).' },
                    since: { type: 'integer', description: 'Optional unix timestamp — only return activity newer than this.' },
                    limit: { type: 'integer', description: 'Max events (default 50, max 200).' },
                    type: { type: 'string', description: 'Optional activity type filter (e.g. "files", "shares", "comments").' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_activity_list_for_file',
            description: 'List activity events scoped to a specific file or folder (changes, comments, shares).',
            parameters: {
                type: 'object',
                properties: {
                    fileId: { type: 'integer', description: 'Numeric file id (from list_files / search_files).' },
                    limit: { type: 'integer', description: 'Max events (default 50, max 200).' }
                },
                required: ['fileId']
            }
        }
    }
];

function activityApi(baseUrl) {
    return `${baseUrl}/ocs/v2.php/cloud/activity`;
}

async function readJsonSafe(res) {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text); } catch { return text; }
}

function mapActivity(a) {
    return {
        id: a.activity_id,
        type: a.type,
        subject: a.subject_prepared || a.subject,
        message: a.message_prepared || a.message,
        actor: a.user,
        objectType: a.object_type,
        objectId: a.object_id,
        objectName: a.object_name,
        link: a.link,
        icon: a.icon,
        datetime: a.datetime,
        affectedUser: a.affecteduser,
    };
}

async function executeNextcloudActivityTool(toolName, args, userId, session) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    const headers = { 'Accept': 'application/json', 'OCS-APIRequest': 'true' };

    switch (toolName) {
        case 'nextcloud_activity_list': {
            const filter = args.filter || 'all';
            const limit = Math.min(Math.max(args.limit || 50, 1), 200);
            const params = new URLSearchParams();
            params.set('format', 'json');
            params.set('limit', String(limit));
            if (args.since) params.set('since', String(args.since));
            if (args.type) params.set('type', args.type);
            const url = `${activityApi(baseUrl)}/${encodeURIComponent(filter)}?${params.toString()}`;
            const res = await ncFetch(url, { headers });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: 'Activity app is not installed/enabled on this Nextcloud server.' };
            if (!res.ok) return { error: `Activity fetch failed (${res.status})` };
            const data = await readJsonSafe(res);
            const items = Array.isArray(data?.ocs?.data) ? data.ocs.data : [];
            return { count: items.length, activities: items.map(mapActivity) };
        }

        case 'nextcloud_activity_list_for_file': {
            if (!args.fileId) return { error: 'fileId is required' };
            const limit = Math.min(Math.max(args.limit || 50, 1), 200);
            const url = `${activityApi(baseUrl)}/filter?format=json&limit=${limit}&object_type=files&object_id=${encodeURIComponent(args.fileId)}`;
            const res = await ncFetch(url, { headers });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: 'Activity app is not installed/enabled on this Nextcloud server.' };
            if (!res.ok) return { error: `Activity fetch failed (${res.status})` };
            const data = await readJsonSafe(res);
            const items = Array.isArray(data?.ocs?.data) ? data.ocs.data : [];
            return { fileId: args.fileId, count: items.length, activities: items.map(mapActivity) };
        }

        default:
            return { error: `Unknown Nextcloud activity tool: ${toolName}` };
    }
}

function isNextcloudActivityTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_activity_');
}

module.exports = {
    NEXTCLOUD_ACTIVITY_TOOLS,
    executeNextcloudActivityTool,
    isNextcloudActivityTool,
};
