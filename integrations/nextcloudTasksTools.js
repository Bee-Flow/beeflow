/**
 * Nextcloud Tasks Tools — VTODO over CalDAV.
 *
 * Tasks live in the same CalDAV namespace as events, just under task lists
 * that advertise VTODO in supported-calendar-component-set. Reuses 80% of
 * the calendar plumbing (auth, REPORT, ETag concurrency).
 */

const crypto = require('crypto');
const ncClient = require('./nextcloudClient');

const PROPFIND_LISTS = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <c:supported-calendar-component-set/>
    <cs:getctag/>
  </d:prop>
</d:propfind>`;

function todoQueryReport(filterStatus) {
    let statusFilter = '';
    if (filterStatus === 'open') {
        statusFilter = `<c:prop-filter name="STATUS"><c:text-match negate-condition="yes">COMPLETED</c:text-match></c:prop-filter>`;
    } else if (filterStatus === 'completed') {
        statusFilter = `<c:prop-filter name="STATUS"><c:text-match>COMPLETED</c:text-match></c:prop-filter>`;
    }
    return `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VTODO">${statusFilter}</c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

const NEXTCLOUD_TASKS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_tasks_list_lists',
            description: 'List the user\'s Nextcloud task lists (CalDAV calendars that support VTODO).',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tasks_list',
            description: 'List tasks in a list. Filter by status: "open" (not completed), "completed", or omit for all.',
            parameters: {
                type: 'object',
                properties: {
                    list: { type: 'string', description: 'Task list slug. Defaults to "personal".' },
                    status: { type: 'string', enum: ['open', 'completed', 'all'], description: 'Filter (default "open").' },
                    limit: { type: 'integer', description: 'Max tasks (default 200, max 1000).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tasks_search',
            description: 'Search tasks by case-insensitive substring match against summary, description, location.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    list: { type: 'string', description: 'Optional list slug to limit search.' },
                    status: { type: 'string', enum: ['open', 'completed', 'all'] },
                    limit: { type: 'integer', description: 'Max results (default 50, max 200).' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tasks_get',
            description: 'Fetch a single task by uid.',
            parameters: {
                type: 'object',
                properties: {
                    list: { type: 'string' },
                    uid: { type: 'string' }
                },
                required: ['list', 'uid']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tasks_create',
            description: 'Create a new task. The user has approved this — go ahead. priority: 1 (highest) – 9 (lowest), 0 = none.',
            parameters: {
                type: 'object',
                properties: {
                    list: { type: 'string', description: 'Task list slug (e.g. "personal").' },
                    summary: { type: 'string', description: 'Task title.' },
                    description: { type: 'string' },
                    due: { type: 'string', description: 'ISO 8601 due date (optional).' },
                    priority: { type: 'integer', description: '1 (highest) - 9 (lowest), 0 = none.' },
                    categories: { type: 'array', items: { type: 'string' } }
                },
                required: ['list', 'summary']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tasks_update',
            description: 'Update fields on an existing task. Only provided fields change. The user has approved this update.',
            parameters: {
                type: 'object',
                properties: {
                    list: { type: 'string' },
                    uid: { type: 'string' },
                    summary: { type: 'string' },
                    description: { type: 'string' },
                    due: { type: 'string', description: 'ISO 8601, or empty string to clear.' },
                    priority: { type: 'integer' },
                    categories: { type: 'array', items: { type: 'string' } }
                },
                required: ['list', 'uid']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tasks_complete',
            description: 'Mark a task as completed (or reopen it).',
            parameters: {
                type: 'object',
                properties: {
                    list: { type: 'string' },
                    uid: { type: 'string' },
                    completed: { type: 'boolean', description: 'true = mark complete (default), false = reopen.' }
                },
                required: ['list', 'uid']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tasks_delete',
            description: 'Delete a task. Always confirm with the user before calling.',
            parameters: {
                type: 'object',
                properties: {
                    list: { type: 'string' },
                    uid: { type: 'string' }
                },
                required: ['list', 'uid']
            }
        }
    }
];

// ─── iCal helpers (mirrors calendar tools' subset) ────────────────

function pad(n) { return String(n).padStart(2, '0'); }

function toICalDateTime(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) throw new Error(`Invalid date: ${iso}`);
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function fromICalDateTime(value) {
    if (!value) return null;
    const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
    if (utc) return `${utc[1]}-${utc[2]}-${utc[3]}T${utc[4]}:${utc[5]}:${utc[6]}Z`;
    const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
    return value;
}

function escapeICal(t) {
    return String(t || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function unescapeICal(t) {
    return String(t || '').replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function unfoldICal(text) { return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, ''); }

function parseVTodo(block) {
    const lines = block.split(/\r?\n/);
    const t = { uid: null, summary: null, description: null, due: null, priority: 0, status: 'NEEDS-ACTION', percentComplete: 0, completed: null, categories: [], raw: block };
    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const left = line.slice(0, colon);
        const value = line.slice(colon + 1);
        const [name] = left.split(';');
        switch (name.toUpperCase()) {
            case 'UID': t.uid = value; break;
            case 'SUMMARY': t.summary = unescapeICal(value); break;
            case 'DESCRIPTION': t.description = unescapeICal(value); break;
            case 'DUE': t.due = fromICalDateTime(value); break;
            case 'PRIORITY': t.priority = parseInt(value, 10) || 0; break;
            case 'STATUS': t.status = value; break;
            case 'PERCENT-COMPLETE': t.percentComplete = parseInt(value, 10) || 0; break;
            case 'COMPLETED': t.completed = fromICalDateTime(value); break;
            case 'CATEGORIES': t.categories = unescapeICal(value).split(',').map(s => s.trim()).filter(Boolean); break;
        }
    }
    return t;
}

function parseICalTodos(text) {
    const unfolded = unfoldICal(text);
    const todos = [];
    const re = /BEGIN:VTODO[\s\S]*?END:VTODO/g;
    let m;
    while ((m = re.exec(unfolded)) !== null) todos.push(parseVTodo(m[0]));
    return todos;
}

function buildVTodo({ uid, summary, description, due, priority, status, percentComplete, completed, categories }) {
    const lines = [
        'BEGIN:VTODO',
        `UID:${uid}`,
        `DTSTAMP:${toICalDateTime(new Date().toISOString())}`,
        `CREATED:${toICalDateTime(new Date().toISOString())}`,
    ];
    if (summary) lines.push(`SUMMARY:${escapeICal(summary)}`);
    if (description) lines.push(`DESCRIPTION:${escapeICal(description)}`);
    if (due) lines.push(`DUE:${toICalDateTime(due)}`);
    if (priority !== undefined && priority !== null) lines.push(`PRIORITY:${priority}`);
    if (status) lines.push(`STATUS:${status}`);
    if (percentComplete !== undefined && percentComplete !== null) lines.push(`PERCENT-COMPLETE:${percentComplete}`);
    if (completed) lines.push(`COMPLETED:${toICalDateTime(completed)}`);
    if (Array.isArray(categories) && categories.length) lines.push(`CATEGORIES:${categories.map(escapeICal).join(',')}`);
    lines.push('END:VTODO');
    return lines.join('\r\n');
}

function wrapVCalendar(vtodo) {
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bee Flow//Nextcloud Tasks Tool//EN', 'CALSCALE:GREGORIAN', vtodo, 'END:VCALENDAR'].join('\r\n');
}

// ─── DAV helpers ──────────────────────────────────────────────────

function calendarsRoot(baseUrl, uid) {
    return `${baseUrl}/remote.php/dav/calendars/${encodeURIComponent(uid)}`;
}

function todoHref(baseUrl, uid, list, todoUid) {
    return `${calendarsRoot(baseUrl, uid)}/${encodeURIComponent(list)}/${encodeURIComponent(todoUid)}.ics`;
}

function parsePropfindLists(xml, uid) {
    const lists = [];
    const respRegex = /<d:response[\s>][\s\S]*?<\/d:response>/g;
    const matches = xml.match(respRegex) || [];
    const root = `/remote.php/dav/calendars/${decodeURIComponent(uid)}`;
    for (const block of matches) {
        // Lists support VTODO (not VEVENT-only calendars).
        if (!/<c:supported-calendar-component-set>[\s\S]*?<c:comp\s+name="VTODO"/.test(block)) continue;
        const href = (block.match(/<d:href>([^<]+)<\/d:href>/) || [])[1];
        if (!href) continue;
        const decoded = decodeURIComponent(href);
        if (decoded.replace(/\/+$/, '') === root) continue;
        const slug = decoded.replace(/\/+$/, '').split('/').pop();
        const displayname = (block.match(/<d:displayname>([^<]*)<\/d:displayname>/) || [])[1] || slug;
        lists.push({ slug, displayName: unescapeICal(displayname), href });
    }
    return lists;
}

function parseTodoMultiStatus(xml) {
    const out = [];
    const respRegex = /<d:response[\s>][\s\S]*?<\/d:response>/g;
    const matches = xml.match(respRegex) || [];
    for (const block of matches) {
        const href = (block.match(/<d:href>([^<]+)<\/d:href>/) || [])[1];
        const etag = (block.match(/<d:getetag>([^<]+)<\/d:getetag>/) || [])[1];
        const cal = (block.match(/<c:calendar-data[^>]*>([\s\S]*?)<\/c:calendar-data>/) || [])[1];
        if (href && cal) {
            out.push({
                href: decodeURIComponent(href),
                etag,
                calendarData: cal.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
            });
        }
    }
    return out;
}

// ─── Tool execution ──────────────────────────────────────────────

async function executeNextcloudTasksTool(toolName, args, userId, session) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const { baseUrl, fetch: ncFetch, authError, uid } = ctx;
    const root = calendarsRoot(baseUrl, uid);

    switch (toolName) {
        case 'nextcloud_tasks_list_lists': {
            const res = await ncFetch(`${root}/`, {
                method: 'PROPFIND',
                headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
                body: PROPFIND_LISTS,
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Task list enumeration failed (${res.status})` };
            const xml = await res.text();
            const lists = parsePropfindLists(xml, uid);
            return { count: lists.length, lists };
        }

        case 'nextcloud_tasks_list': {
            const list = args.list || 'personal';
            const status = args.status || 'open';
            const limit = Math.min(Math.max(args.limit || 200, 1), 1000);
            const res = await ncFetch(`${root}/${encodeURIComponent(list)}/`, {
                method: 'REPORT',
                headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
                body: todoQueryReport(status === 'all' ? null : status),
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Task list not found: ${list}` };
            if (!res.ok) return { error: `Task fetch failed (${res.status})` };
            const xml = await res.text();
            const items = parseTodoMultiStatus(xml);
            const tasks = [];
            for (const item of items) {
                for (const t of parseICalTodos(item.calendarData)) {
                    tasks.push({ ...t, etag: item.etag, href: item.href, list });
                    if (tasks.length >= limit) break;
                }
                if (tasks.length >= limit) break;
            }
            return { list, count: tasks.length, tasks };
        }

        case 'nextcloud_tasks_search': {
            const q = String(args.query || '').toLowerCase().trim();
            if (!q) return { error: 'query is required' };
            const status = args.status || 'all';
            const limit = Math.min(Math.max(args.limit || 50, 1), 200);

            let lists = args.list ? [args.list] : null;
            if (!lists) {
                const listRes = await ncFetch(`${root}/`, {
                    method: 'PROPFIND',
                    headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
                    body: PROPFIND_LISTS,
                });
                if (listRes.status === 401) return { error: authError };
                if (!listRes.ok) return { error: `Could not enumerate task lists (${listRes.status})` };
                lists = parsePropfindLists(await listRes.text(), uid).map(l => l.slug);
            }

            const matches = [];
            for (const list of lists) {
                const res = await ncFetch(`${root}/${encodeURIComponent(list)}/`, {
                    method: 'REPORT',
                    headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
                    body: todoQueryReport(status === 'all' ? null : status),
                });
                if (!res.ok) continue;
                const items = parseTodoMultiStatus(await res.text());
                for (const item of items) {
                    for (const t of parseICalTodos(item.calendarData)) {
                        const haystack = `${t.summary || ''} ${t.description || ''} ${(t.categories || []).join(' ')}`.toLowerCase();
                        if (haystack.includes(q)) {
                            matches.push({ ...t, etag: item.etag, href: item.href, list });
                            if (matches.length >= limit) break;
                        }
                    }
                    if (matches.length >= limit) break;
                }
                if (matches.length >= limit) break;
            }
            return { query: args.query, count: matches.length, tasks: matches };
        }

        case 'nextcloud_tasks_get': {
            if (!args.list || !args.uid) return { error: 'list and uid are required' };
            const res = await ncFetch(todoHref(baseUrl, uid, args.list, args.uid), {});
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Task not found: ${args.uid}` };
            if (!res.ok) return { error: `Task fetch failed (${res.status})` };
            const text = await res.text();
            const todos = parseICalTodos(text);
            return todos[0] ? { ...todos[0], etag: res.headers.get('etag'), list: args.list } : { error: 'No VTODO in response' };
        }

        case 'nextcloud_tasks_create': {
            if (!args.list || !args.summary) return { error: 'list and summary are required' };
            const todoUid = `${crypto.randomBytes(8).toString('hex')}-${Date.now()}@beeflow`;
            const ical = wrapVCalendar(buildVTodo({
                uid: todoUid,
                summary: args.summary,
                description: args.description,
                due: args.due,
                priority: args.priority,
                status: 'NEEDS-ACTION',
                percentComplete: 0,
                categories: args.categories,
            }));
            const res = await ncFetch(todoHref(baseUrl, uid, args.list, todoUid), {
                method: 'PUT',
                headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' },
                body: ical,
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Task list not found: ${args.list}` };
            if (!res.ok && res.status !== 201 && res.status !== 204) {
                const body = await res.text().catch(() => '');
                return { error: `Task create failed (${res.status}): ${body.slice(0, 200)}` };
            }
            return { success: true, list: args.list, uid: todoUid, etag: res.headers.get('etag') };
        }

        case 'nextcloud_tasks_update':
        case 'nextcloud_tasks_complete': {
            if (!args.list || !args.uid) return { error: 'list and uid are required' };
            const getRes = await ncFetch(todoHref(baseUrl, uid, args.list, args.uid), {});
            if (getRes.status === 401) return { error: authError };
            if (getRes.status === 404) return { error: `Task not found: ${args.uid}` };
            if (!getRes.ok) return { error: `Could not load task for update (${getRes.status})` };
            const currentEtag = getRes.headers.get('etag');
            const current = parseICalTodos(await getRes.text())[0] || {};

            let merged;
            if (toolName === 'nextcloud_tasks_complete') {
                const completed = args.completed === false ? false : true;
                merged = {
                    uid: args.uid,
                    summary: current.summary,
                    description: current.description,
                    due: current.due,
                    priority: current.priority,
                    status: completed ? 'COMPLETED' : 'NEEDS-ACTION',
                    percentComplete: completed ? 100 : 0,
                    completed: completed ? new Date().toISOString() : null,
                    categories: current.categories,
                };
            } else {
                merged = {
                    uid: args.uid,
                    summary: args.summary !== undefined ? args.summary : current.summary,
                    description: args.description !== undefined ? args.description : current.description,
                    due: args.due !== undefined ? (args.due === '' ? null : args.due) : current.due,
                    priority: args.priority !== undefined ? args.priority : current.priority,
                    status: current.status || 'NEEDS-ACTION',
                    percentComplete: current.percentComplete || 0,
                    completed: current.completed,
                    categories: args.categories !== undefined ? args.categories : current.categories,
                };
            }

            const ical = wrapVCalendar(buildVTodo(merged));
            const putRes = await ncFetch(todoHref(baseUrl, uid, args.list, args.uid), {
                method: 'PUT',
                headers: {
                    'Content-Type': 'text/calendar; charset=utf-8',
                    ...(currentEtag ? { 'If-Match': currentEtag } : {}),
                },
                body: ical,
            });
            if (putRes.status === 401) return { error: authError };
            if (putRes.status === 412) return { error: 'Task was modified by another client; refetch and retry.' };
            if (!putRes.ok && putRes.status !== 204) {
                const body = await putRes.text().catch(() => '');
                return { error: `Task update failed (${putRes.status}): ${body.slice(0, 200)}` };
            }
            return { success: true, list: args.list, uid: args.uid, etag: putRes.headers.get('etag'), status: merged.status };
        }

        case 'nextcloud_tasks_delete': {
            if (!args.list || !args.uid) return { error: 'list and uid are required' };
            const res = await ncFetch(todoHref(baseUrl, uid, args.list, args.uid), { method: 'DELETE' });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Task not found: ${args.uid}` };
            if (!res.ok && res.status !== 204) return { error: `Task delete failed (${res.status})` };
            return { success: true, list: args.list, uid: args.uid };
        }

        default:
            return { error: `Unknown Nextcloud tasks tool: ${toolName}` };
    }
}

function isNextcloudTasksTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_tasks_');
}

module.exports = {
    NEXTCLOUD_TASKS_TOOLS,
    executeNextcloudTasksTool,
    isNextcloudTasksTool,
};
