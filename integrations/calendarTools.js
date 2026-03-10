/**
 * Google Calendar Tools — Built-in tools for AI to manage calendar events
 * 
 * Injected into the LLM tool set when the user is logged in with Google,
 * allowing the AI to list, search, create, update, and delete calendar events.
 * Create/update/delete actions require user approval before executing.
 */

const { google } = require('googleapis');
const { loadConfig } = require('../auth/permissions');

/**
 * Tool definitions in OpenAI function-calling format.
 */
const CALENDAR_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'calendar_list_events',
            description: 'List upcoming events from the user\'s Google Calendar. By default returns events for the next 7 days. Use this when the user asks about their schedule, upcoming meetings, or what\'s on their calendar.',
            parameters: {
                type: 'object',
                properties: {
                    daysAhead: {
                        type: 'integer',
                        description: 'Number of days ahead to look (1-30, default 7)'
                    },
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum number of events to return (1-50, default 20)'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'calendar_search_events',
            description: 'Search for calendar events by keyword. Searches event titles and descriptions. Use this when the user asks about a specific meeting or event by name.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search keyword to find in event titles and descriptions'
                    },
                    daysAhead: {
                        type: 'integer',
                        description: 'Number of days ahead to search (1-90, default 30)'
                    },
                    daysBefore: {
                        type: 'integer',
                        description: 'Number of days in the past to search (0-90, default 7)'
                    },
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum number of results (1-50, default 20)'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'calendar_create_event',
            description: 'Create a new event on the user\'s Google Calendar. The user will see a preview and must approve before the event is created. Requires a title and start time. Use ISO 8601 format for dates/times (e.g. "2026-03-01T14:00:00"). If no timezone is provided, the user\'s calendar timezone is used.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Event title/summary' },
                    startTime: { type: 'string', description: 'Start date/time in ISO 8601 format, e.g. "2026-03-01T14:00:00"' },
                    endTime: { type: 'string', description: 'End date/time in ISO 8601 format. If omitted, defaults to 1 hour after start' },
                    description: { type: 'string', description: 'Event description or notes' },
                    location: { type: 'string', description: 'Event location (physical address or virtual meeting link)' },
                    attendees: { type: 'string', description: 'Comma-separated list of attendee email addresses' },
                    allDay: { type: 'boolean', description: 'If true, creates an all-day event. startTime should be just a date (e.g. "2026-03-01")' },
                    addGoogleMeet: { type: 'boolean', description: 'If true, automatically creates a Google Meet video conference link for this event. Default false. Set to true when the user asks for an online meeting, video call, or virtual meeting.' }
                },
                required: ['title', 'startTime']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'calendar_update_event',
            description: 'Update an existing calendar event. The user will see a preview and must approve before the event is updated. Use calendar_list_events or calendar_search_events first to get the event ID. Only provide the fields you want to change.',
            parameters: {
                type: 'object',
                properties: {
                    eventId: { type: 'string', description: 'The event ID from calendar_list_events or calendar_search_events results' },
                    title: { type: 'string', description: 'New event title' },
                    startTime: { type: 'string', description: 'New start date/time in ISO 8601 format' },
                    endTime: { type: 'string', description: 'New end date/time in ISO 8601 format' },
                    description: { type: 'string', description: 'New event description' },
                    location: { type: 'string', description: 'New event location' }
                },
                required: ['eventId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'calendar_delete_event',
            description: 'Delete/cancel a calendar event. The user will see a confirmation and must approve before the event is deleted. Use calendar_list_events or calendar_search_events first to get the event ID.',
            parameters: {
                type: 'object',
                properties: {
                    eventId: { type: 'string', description: 'The event ID from calendar_list_events or calendar_search_events results' },
                    eventTitle: { type: 'string', description: 'The title of the event being deleted (for user confirmation)' }
                },
                required: ['eventId']
            }
        }
    }
];

// ─── Calendar Client ───────────────────────────────────────────

async function createCalendarClient(session) {
    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};

    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Google OAuth not configured');
    }

    const accessToken = session?.accessToken;
    if (!accessToken) {
        throw new Error('Not connected to Google — user must log in with Google');
    }

    const oauth2Client = new google.auth.OAuth2(
        providerConfig.clientId,
        providerConfig.clientSecret
    );

    oauth2Client.setCredentials({
        access_token: accessToken,
        refresh_token: session?.refreshToken
    });

    oauth2Client.on('tokens', (tokens) => {
        if (tokens.access_token) session.accessToken = tokens.access_token;
        if (tokens.refresh_token) session.refreshToken = tokens.refresh_token;
        session.save?.();
    });

    return google.calendar({ version: 'v3', auth: oauth2Client });
}

// ─── Format Event ──────────────────────────────────────────────

function formatEvent(event) {
    const start = event.start?.dateTime || event.start?.date || null;
    const end = event.end?.dateTime || event.end?.date || null;
    const isAllDay = !event.start?.dateTime;

    return {
        id: event.id,
        title: event.summary || '(no title)',
        start,
        end,
        allDay: isAllDay,
        location: event.location || null,
        description: event.description || null,
        status: event.status || null,
        organizer: event.organizer?.email || null,
        attendees: (event.attendees || []).map(a => ({
            email: a.email,
            name: a.displayName || null,
            status: a.responseStatus || null,
        })),
        meetLink: event.hangoutLink || event.conferenceData?.entryPoints?.[0]?.uri || null,
    };
}

// ─── Tool Execution ────────────────────────────────────────────

async function executeCalendarTool(toolName, args, session) {
    const calendar = await createCalendarClient(session);

    if (toolName === 'calendar_list_events') {
        const daysAhead = Math.min(Math.max(parseInt(args.daysAhead) || 7, 1), 30);
        const maxResults = Math.min(Math.max(parseInt(args.maxResults) || 20, 1), 50);

        const now = new Date();
        const future = new Date(now);
        future.setDate(future.getDate() + daysAhead);

        console.log(`[Calendar] Listing events for next ${daysAhead} day(s)`);

        const response = await calendar.events.list({
            calendarId: 'primary',
            timeMin: now.toISOString(),
            timeMax: future.toISOString(),
            maxResults,
            singleEvents: true,
            orderBy: 'startTime',
        });

        const events = (response.data.items || []).map(formatEvent);

        return {
            results: events,
            count: events.length,
            period: `${now.toISOString().split('T')[0]} to ${future.toISOString().split('T')[0]}`,
            message: events.length > 0
                ? `Found ${events.length} event(s) in the next ${daysAhead} day(s).`
                : `No events found in the next ${daysAhead} day(s).`,
        };

    } else if (toolName === 'calendar_search_events') {
        const { query } = args;
        if (!query) return { error: 'query is required' };

        const daysAhead = Math.min(Math.max(parseInt(args.daysAhead) || 30, 1), 90);
        const daysBefore = Math.min(Math.max(parseInt(args.daysBefore) || 7, 0), 90);
        const maxResults = Math.min(Math.max(parseInt(args.maxResults) || 20, 1), 50);

        const now = new Date();
        const past = new Date(now);
        past.setDate(past.getDate() - daysBefore);
        const future = new Date(now);
        future.setDate(future.getDate() + daysAhead);

        console.log(`[Calendar] Searching events: "${query}"`);

        const response = await calendar.events.list({
            calendarId: 'primary',
            timeMin: past.toISOString(),
            timeMax: future.toISOString(),
            maxResults,
            singleEvents: true,
            orderBy: 'startTime',
            q: query,
        });

        const events = (response.data.items || []).map(formatEvent);

        return {
            results: events,
            count: events.length,
            query,
            message: events.length > 0
                ? `Found ${events.length} event(s) matching "${query}".`
                : `No events found matching "${query}".`,
        };

    } else if (toolName === 'calendar_create_event') {
        const { title, startTime, endTime, description, location, attendees, allDay, addGoogleMeet } = args;
        if (!title) return { error: 'title is required' };
        if (!startTime) return { error: 'startTime is required' };

        return {
            _action: 'calendar_draft',
            draft: {
                action: 'create',
                title, startTime,
                endTime: endTime || null,
                description: description || null,
                location: location || null,
                attendees: attendees || null,
                allDay: allDay || false,
                addGoogleMeet: addGoogleMeet || false,
            },
            message: `Calendar event prepared: "${title}"${addGoogleMeet ? ' (with Google Meet)' : ''}. Waiting for user approval.`,
        };

    } else if (toolName === 'calendar_update_event') {
        const { eventId, title, startTime, endTime, description, location } = args;
        if (!eventId) return { error: 'eventId is required' };

        return {
            _action: 'calendar_draft',
            draft: {
                action: 'update',
                eventId,
                title: title || null,
                startTime: startTime || null,
                endTime: endTime || null,
                description: description !== undefined ? description : null,
                location: location !== undefined ? location : null,
            },
            message: `Event update prepared. Waiting for user approval.`,
        };

    } else if (toolName === 'calendar_delete_event') {
        const { eventId, eventTitle } = args;
        if (!eventId) return { error: 'eventId is required' };

        return {
            _action: 'calendar_draft',
            draft: {
                action: 'delete',
                eventId,
                title: eventTitle || eventId,
            },
            message: `Event deletion prepared: "${eventTitle || eventId}". Waiting for user approval.`,
        };

    } else {
        throw new Error(`Unknown Calendar tool: ${toolName}`);
    }
}

// ─── Execute Calendar Action (called from API route after user approval) ──

async function executeCalendarAction(action, session) {
    const calendar = await createCalendarClient(session);

    if (action.action === 'create') {
        const event = { summary: action.title };

        if (action.allDay) {
            const startDate = action.startTime.split('T')[0];
            const endDate = action.endTime ? action.endTime.split('T')[0] : (() => {
                const d = new Date(startDate);
                d.setDate(d.getDate() + 1);
                return d.toISOString().split('T')[0];
            })();
            event.start = { date: startDate };
            event.end = { date: endDate };
        } else {
            event.start = { dateTime: action.startTime };
            if (action.endTime) {
                event.end = { dateTime: action.endTime };
            } else {
                const end = new Date(action.startTime);
                end.setHours(end.getHours() + 1);
                event.end = { dateTime: end.toISOString() };
            }
        }

        if (action.description) event.description = action.description;
        if (action.location) event.location = action.location;
        if (action.attendees) {
            event.attendees = action.attendees.split(',').map(e => ({ email: e.trim() }));
        }

        // Add Google Meet conferencing if requested
        if (action.addGoogleMeet) {
            event.conferenceData = {
                createRequest: {
                    requestId: `meet-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    conferenceSolutionKey: { type: 'hangoutsMeet' }
                }
            };
        }

        console.log(`[Calendar] Creating event: "${action.title}" at ${action.startTime}${action.addGoogleMeet ? ' (with Meet)' : ''}`);
        const response = await calendar.events.insert({
            calendarId: 'primary',
            requestBody: event,
            sendUpdates: action.attendees ? 'all' : 'none',
            conferenceDataVersion: action.addGoogleMeet ? 1 : 0,
        });

        return {
            id: response.data.id,
            title: response.data.summary,
            start: response.data.start?.dateTime || response.data.start?.date,
            end: response.data.end?.dateTime || response.data.end?.date,
            link: response.data.htmlLink,
            meetLink: response.data.hangoutLink || response.data.conferenceData?.entryPoints?.[0]?.uri || null,
        };

    } else if (action.action === 'update') {
        console.log(`[Calendar] Updating event: ${action.eventId}`);
        const current = await calendar.events.get({ calendarId: 'primary', eventId: action.eventId });
        const updated = { ...current.data };

        if (action.title) updated.summary = action.title;
        if (action.startTime) updated.start = { dateTime: action.startTime };
        if (action.endTime) updated.end = { dateTime: action.endTime };
        if (action.description !== null && action.description !== undefined) updated.description = action.description;
        if (action.location !== null && action.location !== undefined) updated.location = action.location;

        const response = await calendar.events.update({
            calendarId: 'primary',
            eventId: action.eventId,
            requestBody: updated,
        });

        return {
            id: response.data.id,
            title: response.data.summary,
            start: response.data.start?.dateTime || response.data.start?.date,
            end: response.data.end?.dateTime || response.data.end?.date,
        };

    } else if (action.action === 'delete') {
        console.log(`[Calendar] Deleting event: ${action.eventId}`);
        await calendar.events.delete({ calendarId: 'primary', eventId: action.eventId });
        return { deleted: true };

    } else {
        throw new Error(`Unknown calendar action: ${action.action}`);
    }
}

function isCalendarTool(toolName) {
    return [
        'calendar_list_events',
        'calendar_search_events',
        'calendar_create_event',
        'calendar_update_event',
        'calendar_delete_event',
    ].includes(toolName);
}

module.exports = {
    CALENDAR_TOOLS,
    executeCalendarTool,
    executeCalendarAction,
    isCalendarTool,
    createCalendarClient,
};
