/**
 * Nextcloud Calendar Tools — CalDAV CRUD over /remote.php/dav/calendars/<uid>/.
 *
 * Auth + base-URL handled by ./nextcloudClient (Bearer when the user logged in
 * via Nextcloud OAuth, app-password Basic otherwise — exact same dual-mode
 * pattern as nextcloudTools.js).
 *
 * iCal handling delegates to ical.js (RFC 5545 line folding, escaping,
 * timezone resolution); WebDAV multistatus parsing uses fast-xml-parser.
 */

const crypto = require('crypto');
const ICAL = require('ical.js');
const { XMLParser } = require('fast-xml-parser');
const ncClient = require('./nextcloudClient');

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
});

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

// ─── iCal helpers (ical.js-backed) ─────────────────────────────────

function toICalUtcStamp(iso) {
    const d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) throw new Error(`Invalid date: ${iso}`);
    return ICAL.Time.fromJSDate(d, true).toICALString();
}

function icsTimeToISO(time) {
    if (!time) return null;
    if (time.isDate) {
        // All-day: emit YYYY-MM-DD with no time component.
        const pad = (n) => String(n).padStart(2, '0');
        return `${time.year}-${pad(time.month)}-${pad(time.day)}`;
    }
    return time.toJSDate().toISOString();
}

// A Nextcloud Talk meeting link is `…/call/<token>`. When a calendar event has
// a Talk conversation, the URL lives in DESCRIPTION and/or the custom
// X-MAILCLIENT-ONLINE-MEETING property (not LOCATION) — check all of them.
const TALK_CALL_URL_RE = /\/call\/([A-Za-z0-9]+)/;
function talkTokenFromTexts(...texts) {
    for (const t of texts) {
        if (!t) continue;
        const m = String(t).match(TALK_CALL_URL_RE);
        if (m) return m[1];
    }
    return null;
}

function eventFromIcal(vevent) {
    const ev = new ICAL.Event(vevent);
    const attendees = (ev.attendees || []).map((p) => {
        const val = p.getFirstValue() || '';
        return { cn: p.getParameter('cn') || null, email: String(val).replace(/^mailto:/i, '') };
    });
    let organizer = null;
    if (ev.organizer) {
        const orgProp = vevent.getFirstProperty('organizer');
        const val = ev.organizer || '';
        organizer = {
            cn: orgProp ? (orgProp.getParameter('cn') || null) : null,
            email: String(val).replace(/^mailto:/i, ''),
        };
    }
    let xMeeting = null;
    try { xMeeting = vevent.getFirstPropertyValue('x-mailclient-online-meeting'); } catch (_) { /* no x-prop */ }
    return {
        uid: ev.uid || null,
        summary: ev.summary || null,
        description: ev.description || null,
        location: ev.location || null,
        attendees,
        dtstart: icsTimeToISO(ev.startDate),
        dtend: icsTimeToISO(ev.endDate),
        organizer,
        allDay: !!(ev.startDate && ev.startDate.isDate),
        // Talk room token if this event is linked to a Talk conversation.
        talkToken: talkTokenFromTexts(ev.description, ev.location, xMeeting),
    };
}

function parseICal(text) {
    if (!text) return [];
    let jcal;
    try { jcal = ICAL.parse(text); } catch (_) { return []; }
    const root = new ICAL.Component(jcal);
    const vevents = root.getAllSubcomponents('vevent');
    return vevents.map(eventFromIcal);
}

function buildVCalendarEvent({ uid, summary, start, end, description, location, attendees, allDay }) {
    const cal = new ICAL.Component(['vcalendar', [], []]);
    cal.updatePropertyWithValue('prodid', '-//Bee Flow//Nextcloud Calendar Tool//EN');
    cal.updatePropertyWithValue('version', '2.0');
    cal.updatePropertyWithValue('calscale', 'GREGORIAN');

    const vevent = new ICAL.Component('vevent');
    const event = new ICAL.Event(vevent);
    event.uid = uid;
    if (summary) event.summary = summary;
    if (description) event.description = description;
    if (location) event.location = location;

    const startDate = new Date(start);
    if (isNaN(startDate.getTime())) throw new Error(`Invalid start: ${start}`);
    if (allDay) {
        const sIso = startDate.toISOString().slice(0, 10).replace(/-/g, '');
        const startTime = ICAL.Time.fromDateString(`${sIso.slice(0, 4)}-${sIso.slice(4, 6)}-${sIso.slice(6, 8)}`);
        event.startDate = startTime;
        if (end) {
            const eDate = new Date(end);
            const eIso = eDate.toISOString().slice(0, 10);
            event.endDate = ICAL.Time.fromDateString(eIso);
        }
    } else {
        event.startDate = ICAL.Time.fromJSDate(startDate, true);
        if (end) {
            const eDate = new Date(end);
            if (isNaN(eDate.getTime())) throw new Error(`Invalid end: ${end}`);
            event.endDate = ICAL.Time.fromJSDate(eDate, true);
        }
    }

    vevent.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));

    if (Array.isArray(attendees)) {
        for (const a of attendees) {
            if (!a) continue;
            const prop = new ICAL.Property('attendee', vevent);
            prop.setParameter('cn', String(a));
            prop.setParameter('role', 'REQ-PARTICIPANT');
            prop.setParameter('partstat', 'NEEDS-ACTION');
            prop.setValue(`mailto:${a}`);
            vevent.addProperty(prop);
        }
    }

    cal.addSubcomponent(vevent);
    return cal.toString();
}

// ─── DAV helpers ──────────────────────────────────────────────────

function calendarsRoot(baseUrl, uid) {
    return `${baseUrl}/remote.php/dav/calendars/${encodeURIComponent(uid)}`;
}

function eventHref(baseUrl, uid, calendar, eventUid) {
    return `${calendarsRoot(baseUrl, uid)}/${encodeURIComponent(calendar)}/${encodeURIComponent(eventUid)}.ics`;
}

// Normalize a multistatus XML response into [{ href, props }] — only 2xx
// propstat entries are merged. Reused for both PROPFIND and REPORT replies.
function parseMultistatusResponses(xml) {
    const parsed = xmlParser.parse(xml);
    const ms = parsed?.multistatus;
    if (!ms) return [];
    const list = Array.isArray(ms.response) ? ms.response : (ms.response ? [ms.response] : []);
    return list.map((r) => {
        const propstats = Array.isArray(r.propstat) ? r.propstat : (r.propstat ? [r.propstat] : []);
        const props = {};
        for (const ps of propstats) {
            const status = ps.status || '';
            if (status && !/\b2\d\d\b/.test(status)) continue;
            Object.assign(props, ps.prop || {});
        }
        return { href: r.href || '', props };
    });
}

function supportsVEvent(props) {
    const set = props['supported-calendar-component-set'];
    if (!set || !set.comp) return false;
    const comps = Array.isArray(set.comp) ? set.comp : [set.comp];
    return comps.some((c) => c && (c['@_name'] === 'VEVENT' || c.name === 'VEVENT'));
}

function hasWritePrivilege(props) {
    const ps = props['current-user-privilege-set'];
    if (!ps) return false;
    const privs = Array.isArray(ps.privilege) ? ps.privilege : (ps.privilege ? [ps.privilege] : []);
    return privs.some((p) => p && (p.write !== undefined || p['write-content'] !== undefined));
}

function parsePropfindCalendars(xml, baseUrl, uid) {
    const root = `/remote.php/dav/calendars/${decodeURIComponent(uid)}`;
    const calendars = [];
    for (const { href, props } of parseMultistatusResponses(xml)) {
        if (!href || !supportsVEvent(props)) continue;
        const decoded = decodeURIComponent(href);
        if (decoded.replace(/\/+$/, '') === root) continue;
        const slug = decoded.replace(/\/+$/, '').split('/').pop();
        const displayname = props.displayname || slug;
        calendars.push({
            slug,
            displayName: displayname,
            href,
            writable: hasWritePrivilege(props),
        });
    }
    return calendars;
}

function parseMultiStatus(xml) {
    // Returns [{ href, etag, calendarData }] — used by REPORT calendar-query.
    return parseMultistatusResponses(xml)
        .filter(({ href, props }) => href && props['calendar-data'] !== undefined)
        .map(({ href, props }) => ({
            href: decodeURIComponent(href),
            etag: props.getetag || null,
            // fast-xml-parser already decoded entities; calendar-data is the inner ICS text.
            calendarData: props['calendar-data'] || '',
        }));
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
            const start = args.start ? toICalUtcStamp(args.start) : toICalUtcStamp(new Date().toISOString());
            const end = args.end
                ? toICalUtcStamp(args.end)
                : toICalUtcStamp(new Date(Date.now() + 30 * 86400_000).toISOString());

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

            const start = args.start ? toICalUtcStamp(args.start) : null;
            const end = args.end ? toICalUtcStamp(args.end) : null;
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
            const eventUid = `${crypto.randomUUID()}@${new URL(baseUrl).hostname}`;
            const end = args.end || new Date(new Date(args.start).getTime() + 60 * 60_000).toISOString();
            const ical = buildVCalendarEvent({
                uid: eventUid,
                summary: args.summary,
                start: args.start,
                end,
                description: args.description,
                location: args.location,
                attendees: args.attendees,
                allDay: !!args.allDay,
            });
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
            const ical = buildVCalendarEvent(merged);
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
