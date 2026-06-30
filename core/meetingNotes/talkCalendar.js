/**
 * Talk calendar helper — find the user's upcoming Nextcloud Talk MEETINGS
 * (calendar events linked to a Talk conversation) so auto-record can scope to
 * scheduled meetings and the Meeting Notes "Upcoming" view can list them.
 *
 * Reuses the existing CalDAV tooling in `nextcloudCalendarTools.js` (which now
 * surfaces a `talkToken` per event parsed from DESCRIPTION /
 * X-MAILCLIENT-ONLINE-MEETING). No connector changes.
 */

const { executeNextcloudCalendarTool } = require('../../integrations/nextcloudCalendarTools');

const TALK_CALL_URL_RE = /\/call\/([A-Za-z0-9]+)/;

/**
 * Pull a Talk room token out of an event-like object (prefers the precomputed
 * `talkToken`, else parses description/location).
 */
function extractTalkToken(event) {
    if (!event) return null;
    if (event.talkToken) return event.talkToken;
    for (const t of [event.description, event.location]) {
        if (!t) continue;
        const m = String(t).match(TALK_CALL_URL_RE);
        if (m) return m[1];
    }
    return null;
}

/**
 * List the user's upcoming Talk meetings within `windowHours`.
 * Returns [{ uid, title, start, end, organizer, attendees, talkToken, calendar }].
 * Best-effort: returns [] on any auth/calendar error.
 */
async function listUpcomingTalkMeetings({ session, userId, windowHours = 24 } = {}) {
    try {
        const startISO = new Date().toISOString();
        const endISO = new Date(Date.now() + windowHours * 3600_000).toISOString();

        const calRes = await executeNextcloudCalendarTool('nextcloud_calendar_list', {}, userId, session);
        const calendars = Array.isArray(calRes?.calendars) ? calRes.calendars : [];
        if (!calendars.length) return [];

        const seen = new Set();
        const meetings = [];
        for (const cal of calendars) {
            const slug = cal.slug;
            if (!slug) continue;
            const evRes = await executeNextcloudCalendarTool(
                'nextcloud_calendar_list_events',
                { calendar: slug, start: startISO, end: endISO },
                userId, session,
            ).catch(() => null);
            const events = Array.isArray(evRes?.events) ? evRes.events : [];
            for (const ev of events) {
                const talkToken = extractTalkToken(ev);
                if (!talkToken) continue;
                const key = `${ev.uid || ''}::${talkToken}`;
                if (seen.has(key)) continue;
                seen.add(key);
                meetings.push({
                    uid: ev.uid || null,
                    title: ev.summary || 'Meeting',
                    start: ev.dtstart || null,
                    end: ev.dtend || null,
                    organizer: ev.organizer || null,
                    attendees: ev.attendees || [],
                    talkToken,
                    calendar: slug,
                });
            }
        }
        meetings.sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
        return meetings;
    } catch (_) {
        return [];
    }
}

module.exports = { listUpcomingTalkMeetings, extractTalkToken };
