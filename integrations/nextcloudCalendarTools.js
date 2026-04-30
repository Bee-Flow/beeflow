/**
 * Nextcloud Calendar Tools — CalDAV CRUD over /remote.php/dav/calendars/<uid>/.
 *
 * Auth + base-URL handled by ./nextcloudClient (Bearer when the user logged in
 * via Nextcloud OAuth, app-password Basic otherwise — exact same dual-mode
 * pattern as nextcloudTools.js).
 *
 * iCal serialisation is hand-written: events are simple enough that pulling
 * in a full RFC-5545 lib (ical.js, ical-generator) isn't justified. The
 * minimal VCALENDAR/VEVENT shape we emit round-trips through Nextcloud,
 * Outlook, Google Calendar, and Apple Calendar.
 */

const crypto = require('crypto');
const ncClient = require('./nextcloudClient');

const PROPFIND_CALENDARS = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <c:supported-calendar-component-set/>
    <cs:getctag/>
    <oc:owner-principal/>
    <d:current-user-privilege-set/>
  </d:prop>
</d:propfind>`;

function calendarQueryReport(rangeStart, rangeEnd) {
    const range = (rangeStart && rangeEnd)
        ? `<c:time-range start="${rangeStart}" end="${rangeEnd}"/>`
        : '';
    return `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">${range}</c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

const NEXTCLOUD_CALENDAR_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_calendar_list',
            description: 'List the user\'s Nextcloud calendars (name, URL slug, color, read/write status).',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_calendar_list_events',
            description: 'List events from a Nextcloud calendar within a date range. Returns title, start/end (ISO 8601), location, description, attendees, organiser, uid.',
            parameters: {
                type: 'object',
                properties: {
                    calendar: { type: 'string', description: 'Calendar slug (from nextcloud_calendar_list, e.g. "personal"). Defaults to "personal" if omitted.' },
                    start: { type: 'string', description: 'Range start as ISO 8601 (e.g. "2026-04-01T00:00:00Z"). Defaults to now.' },
                    end: { type: 'string', description: 'Range end as ISO 8601 (e.g. "2026-05-01T00:00:00Z"). Defaults to start + 30 days.' },
                    limit: { type: 'integer', description: 'Maximum number of events (default 100, max 500).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_calendar_search_events',
            description: 'Search events in a calendar by case-insensitive substring match against summary, description, location, attendee list. Optional date-range narrowing.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Substring to match (case-insensitive).' },
                    calendar: { type: 'string', description: 'Calendar slug. Searches all calendars if omitted.' },
                    start: { type: 'string', description: 'Optional ISO 8601 range start.' },
                    end: { type: 'string', description: 'Optional ISO 8601 range end.' },
                    limit: { type: 'integer', description: 'Max events to return (default 50, max 200).' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_calendar_get_event',
            description: 'Fetch a single event by its uid from a calendar.',
            parameters: {
                type: 'object',
                properties: {
                    calendar: { type: 'string', description: 'Calendar slug.' },
                    uid: { type: 'string', description: 'Event UID (returned from list/search).' }
                },
                required: ['calendar', 'uid']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_calendar_create_event',
            description: 'Create a new calendar event. The user has approved this — go ahead and create it. Times are ISO 8601; if no timezone is given, UTC is assumed.',
            parameters: {
                type: 'object',
                properties: {
                    calendar: { type: 'string', description: 'Calendar slug to create the event in (e.g. "personal").' },
                    summary: { type: 'string', description: 'Event title.' },
                    start: { type: 'string', description: 'Start time as ISO 8601 (e.g. "2026-05-01T14:00:00Z").' },
                    end: { type: 'string', description: 'End time as ISO 8601. If omitted, defaults to start + 1 hour.' },
                    description: { type: 'string', description: 'Optional event body.' },
                    location: { type: 'string', description: 'Optional location string.' },
                    attendees: { type: 'array', items: { type: 'string' }, description: 'Optional list of attendee emails.' },
                    allDay: { type: 'boolean', description: 'Set true for an all-day event (start/end are date-only).' }
                },
                required: ['calendar', 'summary', 'start']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_calendar_update_event',
            description: 'Update fields on an existing event. Only provided fields are changed; omitted fields are preserved. The user has approved this update.',
            parameters: {
                type: 'object',
                properties: {
                    calendar: { type: 'string', description: 'Calendar slug.' },
                    uid: { type: 'string', description: 'Event UID.' },
                    summary: { type: 'string' },
                    start: { type: 'string', description: 'ISO 8601.' },
                    end: { type: 'string', description: 'ISO 8601.' },
                    description: { type: 'string' },
                    location: { type: 'string' },
                    attendees: { type: 'array', items: { type: 'string' } }
                },
                required: ['calendar', 'uid']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_calendar_delete_event',
            description: 'Delete a calendar event. Always confirm with the user before calling this — deletion cannot be undone via the API.',
            parameters: {
                type: 'object',
                properties: {
                    calendar: { type: 'string', description: 'Calendar slug.' },
                    uid: { type: 'string', description: 'Event UID.' }
                },
                required: ['calendar', 'uid']
            }
        }
    }
];

// ─── iCal helpers ──────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }

function toICalDateTime(iso, allDay) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) throw new Error(`Invalid date: ${iso}`);
    if (allDay) {
        return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
    }
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function fromICalDateTime(value) {
    if (!value) return null;
    // Date-only (all-day): 20260501
    const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
    // UTC: 20260501T140000Z
    const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
    if (utc) return `${utc[1]}-${utc[2]}-${utc[3]}T${utc[4]}:${utc[5]}:${utc[6]}Z`;
    // Floating local: 20260501T140000
    const local = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value);
    if (local) return `${local[1]}-${local[2]}-${local[3]}T${local[4]}:${local[5]}:${local[6]}`;
    return value;
}

function escapeICal(text) {
    return String(text || '')
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/,/g, '\\,')
        .replace(/;/g, '\\;');
}

function unescapeICal(text) {
    return String(text || '')
        .replace(/\\n/g, '\n')
        .replace(/\\,/g, ',')
        .replace(/\\;/g, ';')
        .replace(/\\\\/g, '\\');
}

/**
 * Unfold RFC-5545 line continuations (any line beginning with a single space
 * or tab is appended to the previous line).
 */
function unfoldICal(text) {
    return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

function parseVEvent(block) {
    const lines = block.split(/\r?\n/);
    const event = { uid: null, summary: null, description: null, location: null, attendees: [], dtstart: null, dtend: null, organizer: null, allDay: false, raw: block };
    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const left = line.slice(0, colon);
        const value = line.slice(colon + 1);
        const [name, ...params] = left.split(';');
        switch (name) {
            case 'UID': event.uid = value; break;
            case 'SUMMARY': event.summary = unescapeICal(value); break;
            case 'DESCRIPTION': event.description = unescapeICal(value); break;
            case 'LOCATION': event.location = unescapeICal(value); break;
            case 'DTSTART':
                event.dtstart = fromICalDateTime(value);
                if (params.some(p => p.startsWith('VALUE=DATE'))) event.allDay = true;
                break;
            case 'DTEND':
                event.dtend = fromICalDateTime(value);
                break;
            case 'ORGANIZER': {
                const cn = (params.find(p => p.startsWith('CN=')) || '').slice(3) || null;
                event.organizer = { cn, email: value.replace(/^mailto:/i, '') };
                break;
            }
            case 'ATTENDEE': {
                const cn = (params.find(p => p.startsWith('CN=')) || '').slice(3) || null;
                event.attendees.push({ cn, email: value.replace(/^mailto:/i, '') });
                break;
            }
        }
    }
    return event;
}

function parseICal(text) {
    const unfolded = unfoldICal(text);
    const events = [];
    const re = /BEGIN:VEVENT[\s\S]*?END:VEVENT/g;
    let m;
    while ((m = re.exec(unfolded)) !== null) events.push(parseVEvent(m[0]));
    return events;
}

function buildVEvent({ uid, summary, start, end, description, location, attendees, allDay, dtstamp }) {
    const lines = [
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${dtstamp || toICalDateTime(new Date().toISOString())}`,
    ];
    if (allDay) {
        lines.push(`DTSTART;VALUE=DATE:${toICalDateTime(start, true)}`);
        if (end) lines.push(`DTEND;VALUE=DATE:${toICalDateTime(end, true)}`);
    } else {
        lines.push(`DTSTART:${toICalDateTime(start)}`);
        if (end) lines.push(`DTEND:${toICalDateTime(end)}`);
    }
    if (summary) lines.push(`SUMMARY:${escapeICal(summary)}`);
    if (description) lines.push(`DESCRIPTION:${escapeICal(description)}`);
    if (location) lines.push(`LOCATION:${escapeICal(location)}`);
    if (Array.isArray(attendees)) {
        for (const a of attendees) {
            if (a) lines.push(`ATTENDEE;CN=${escapeICal(a)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:${a}`);
        }
    }
    lines.push('END:VEVENT');
    return lines.join('\r\n');
}

function wrapVCalendar(vevent) {
    return [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Bee Flow//Nextcloud Calendar Tool//EN',
        'CALSCALE:GREGORIAN',
        vevent,
        'END:VCALENDAR',
    ].join('\r\n');
}

// ─── DAV helpers ──────────────────────────────────────────────────

function calendarsRoot(baseUrl, uid) {
    return `${baseUrl}/remote.php/dav/calendars/${encodeURIComponent(uid)}`;
}

function eventHref(baseUrl, uid, calendar, eventUid) {
    return `${calendarsRoot(baseUrl, uid)}/${encodeURIComponent(calendar)}/${encodeURIComponent(eventUid)}.ics`;
}

function parsePropfindCalendars(xml, baseUrl, uid) {
    const calendars = [];
    const respRegex = /<d:response[\s>][\s\S]*?<\/d:response>/g;
    const matches = xml.match(respRegex) || [];
    const root = `/remote.php/dav/calendars/${decodeURIComponent(uid)}`;
    for (const block of matches) {
        // Only entries that explicitly support VEVENT — drops trash + addressbook noise.
        if (!/<c:supported-calendar-component-set>[\s\S]*?<c:comp\s+name="VEVENT"/.test(block)) continue;
        const href = (block.match(/<d:href>([^<]+)<\/d:href>/) || [])[1];
        if (!href) continue;
        const decoded = decodeURIComponent(href);
        // Skip the user root itself — it's not a calendar, just the container.
        if (decoded.replace(/\/+$/, '') === root) continue;
        const slug = decoded.replace(/\/+$/, '').split('/').pop();
        const displayname = (block.match(/<d:displayname>([^<]*)<\/d:displayname>/) || [])[1] || slug;
        const writable = /<d:privilege>\s*<d:write/i.test(block) || /<d:current-user-privilege-set>[\s\S]*<d:write/i.test(block);
        calendars.push({ slug, displayName: unescapeICal(displayname), href, writable });
    }
    return calendars;
}

function parseMultiStatus(xml) {
    // Returns [{ href, etag, calendarData }] — used by REPORT calendar-query.
    const responses = [];
    const respRegex = /<d:response[\s>][\s\S]*?<\/d:response>/g;
    const matches = xml.match(respRegex) || [];
    for (const block of matches) {
        const href = (block.match(/<d:href>([^<]+)<\/d:href>/) || [])[1];
        const etag = (block.match(/<d:getetag>([^<]+)<\/d:getetag>/) || [])[1];
        const cal = (block.match(/<c:calendar-data[^>]*>([\s\S]*?)<\/c:calendar-data>/) || [])[1];
        if (href && cal) {
            responses.push({
                href: decodeURIComponent(href),
                etag,
                calendarData: cal.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
            });
        }
    }
    return responses;
}

// ─── Tool execution ──────────────────────────────────────────────

async function executeNextcloudCalendarTool(toolName, args, userId, session) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const { baseUrl, fetch: ncFetch, authError, uid } = ctx;
    const calRoot = calendarsRoot(baseUrl, uid);

    switch (toolName) {
        case 'nextcloud_calendar_list': {
            const res = await ncFetch(`${calRoot}/`, {
                method: 'PROPFIND',
                headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
                body: PROPFIND_CALENDARS,
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Nextcloud calendar list failed (${res.status})` };
            const xml = await res.text();
            const calendars = parsePropfindCalendars(xml, baseUrl, uid);
            return { count: calendars.length, calendars };
        }

        case 'nextcloud_calendar_list_events': {
            const calendar = args.calendar || 'personal';
            const limit = Math.min(Math.max(args.limit || 100, 1), 500);
            const start = args.start ? toICalDateTime(args.start) : toICalDateTime(new Date().toISOString());
            const end = args.end
                ? toICalDateTime(args.end)
                : toICalDateTime(new Date(Date.now() + 30 * 86400_000).toISOString());

            const res = await ncFetch(`${calRoot}/${encodeURIComponent(calendar)}/`, {
                method: 'REPORT',
                headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
                body: calendarQueryReport(start, end),
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Calendar not found: ${calendar}` };
            if (!res.ok) return { error: `Nextcloud calendar query failed (${res.status})` };
            const xml = await res.text();
            const items = parseMultiStatus(xml);
            const events = [];
            for (const item of items) {
                const parsed = parseICal(item.calendarData);
                for (const ev of parsed) events.push({ ...ev, etag: item.etag, href: item.href, calendar });
                if (events.length >= limit) break;
            }
            return { calendar, count: events.length, events: events.slice(0, limit) };
        }

        case 'nextcloud_calendar_search_events': {
            const q = String(args.query || '').toLowerCase().trim();
            if (!q) return { error: 'query is required' };
            const limit = Math.min(Math.max(args.limit || 50, 1), 200);

            // Determine which calendars to search.
            let targetSlugs = [args.calendar].filter(Boolean);
            if (!targetSlugs.length) {
                const listRes = await ncFetch(`${calRoot}/`, {
                    method: 'PROPFIND',
                    headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
                    body: PROPFIND_CALENDARS,
                });
                if (listRes.status === 401) return { error: authError };
                if (!listRes.ok) return { error: `Failed to enumerate calendars (${listRes.status})` };
                const listXml = await listRes.text();
                targetSlugs = parsePropfindCalendars(listXml, baseUrl, uid).map(c => c.slug);
            }

            const start = args.start ? toICalDateTime(args.start) : null;
            const end = args.end ? toICalDateTime(args.end) : null;
            const matches = [];

            for (const slug of targetSlugs) {
                const res = await ncFetch(`${calRoot}/${encodeURIComponent(slug)}/`, {
                    method: 'REPORT',
                    headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
                    body: calendarQueryReport(start, end),
                });
                if (!res.ok) continue;
                const xml = await res.text();
                const items = parseMultiStatus(xml);
                for (const item of items) {
                    for (const ev of parseICal(item.calendarData)) {
                        const haystack = [ev.summary, ev.description, ev.location, ...ev.attendees.map(a => `${a.cn || ''} ${a.email || ''}`)].join(' ').toLowerCase();
                        if (haystack.includes(q)) {
                            matches.push({ ...ev, etag: item.etag, href: item.href, calendar: slug });
                            if (matches.length >= limit) break;
                        }
                    }
                    if (matches.length >= limit) break;
                }
                if (matches.length >= limit) break;
            }
            return { query: args.query, count: matches.length, events: matches };
        }

        case 'nextcloud_calendar_get_event': {
            if (!args.calendar || !args.uid) return { error: 'calendar and uid are required' };
            const res = await ncFetch(eventHref(baseUrl, uid, args.calendar, args.uid), {});
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Event not found: ${args.uid}` };
            if (!res.ok) return { error: `Nextcloud event fetch failed (${res.status})` };
            const text = await res.text();
            const events = parseICal(text);
            return events[0]
                ? { ...events[0], etag: res.headers.get('etag'), calendar: args.calendar }
                : { error: 'No VEVENT found in response' };
        }

        case 'nextcloud_calendar_create_event': {
            if (!args.calendar || !args.summary || !args.start) {
                return { error: 'calendar, summary, and start are required' };
            }
            const eventUid = `${crypto.randomBytes(8).toString('hex')}-${Date.now()}@beeflow`;
            const end = args.end || new Date(new Date(args.start).getTime() + 60 * 60_000).toISOString();
            const ical = wrapVCalendar(buildVEvent({
                uid: eventUid,
                summary: args.summary,
                start: args.start,
                end,
                description: args.description,
                location: args.location,
                attendees: args.attendees,
                allDay: !!args.allDay,
            }));
            const res = await ncFetch(eventHref(baseUrl, uid, args.calendar, eventUid), {
                method: 'PUT',
                headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' },
                body: ical,
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Calendar not found: ${args.calendar}` };
            if (!res.ok && res.status !== 201 && res.status !== 204) {
                const body = await res.text().catch(() => '');
                return { error: `Event create failed (${res.status}): ${body.slice(0, 200)}` };
            }
            return { success: true, calendar: args.calendar, uid: eventUid, etag: res.headers.get('etag') };
        }

        case 'nextcloud_calendar_update_event': {
            if (!args.calendar || !args.uid) return { error: 'calendar and uid are required' };
            // Fetch current to merge fields.
            const getRes = await ncFetch(eventHref(baseUrl, uid, args.calendar, args.uid), {});
            if (getRes.status === 401) return { error: authError };
            if (getRes.status === 404) return { error: `Event not found: ${args.uid}` };
            if (!getRes.ok) return { error: `Could not load event for update (${getRes.status})` };
            const currentText = await getRes.text();
            const currentEtag = getRes.headers.get('etag');
            const current = parseICal(currentText)[0] || {};

            const merged = {
                uid: args.uid,
                summary: args.summary !== undefined ? args.summary : current.summary,
                start: args.start !== undefined ? args.start : current.dtstart,
                end: args.end !== undefined ? args.end : current.dtend,
                description: args.description !== undefined ? args.description : current.description,
                location: args.location !== undefined ? args.location : current.location,
                attendees: args.attendees !== undefined ? args.attendees : (current.attendees || []).map(a => a.email),
                allDay: current.allDay,
            };
            const ical = wrapVCalendar(buildVEvent(merged));
            const putRes = await ncFetch(eventHref(baseUrl, uid, args.calendar, args.uid), {
                method: 'PUT',
                headers: {
                    'Content-Type': 'text/calendar; charset=utf-8',
                    ...(currentEtag ? { 'If-Match': currentEtag } : {}),
                },
                body: ical,
            });
            if (putRes.status === 401) return { error: authError };
            if (putRes.status === 412) return { error: 'Event was modified by another client; refetch and retry.' };
            if (!putRes.ok && putRes.status !== 204) {
                const body = await putRes.text().catch(() => '');
                return { error: `Event update failed (${putRes.status}): ${body.slice(0, 200)}` };
            }
            return { success: true, calendar: args.calendar, uid: args.uid, etag: putRes.headers.get('etag') };
        }

        case 'nextcloud_calendar_delete_event': {
            if (!args.calendar || !args.uid) return { error: 'calendar and uid are required' };
            const res = await ncFetch(eventHref(baseUrl, uid, args.calendar, args.uid), { method: 'DELETE' });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Event not found: ${args.uid}` };
            if (!res.ok && res.status !== 204) return { error: `Event delete failed (${res.status})` };
            return { success: true, calendar: args.calendar, uid: args.uid };
        }

        default:
            return { error: `Unknown Nextcloud calendar tool: ${toolName}` };
    }
}

function isNextcloudCalendarTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_calendar_');
}

module.exports = {
    NEXTCLOUD_CALENDAR_TOOLS,
    executeNextcloudCalendarTool,
    isNextcloudCalendarTool,
};
