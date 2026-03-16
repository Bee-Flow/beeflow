/**
 * Microsoft Calendar Tools — Built-in tools for AI to manage Outlook Calendar
 * 
 * Mirror of calendarTools.js for Microsoft 365 users.
 * Uses Microsoft Graph API v1.0 with OAuth2 tokens from session.
 */

const { graphFetch, isMicrosoftConnected } = require('./msGraphClient');

/**
 * Tool definitions in OpenAI function-calling format.
 */
const MS_CALENDAR_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'ms_calendar_list_events',
            description: 'List upcoming events from the user\'s Outlook calendar. Returns events from now until the specified number of days ahead.',
            parameters: {
                type: 'object',
                properties: {
                    daysAhead: {
                        type: 'integer',
                        description: 'Number of days ahead to look (default 7, max 90)'
                    },
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum number of events to return (default 20, max 50)'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'ms_calendar_search_events',
            description: 'Search for events in the user\'s Outlook calendar by subject or content. Returns matching events within the specified timeframe.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query to match against event subjects and body content'
                    },
                    daysAhead: {
                        type: 'integer',
                        description: 'Number of days ahead to search (default 30, max 90)'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'ms_calendar_create_event',
            description: 'Create a new event on the user\'s Outlook calendar. The user will see a preview before it is created. Always use ISO 8601 format for dates/times (e.g. "2025-03-15T10:00:00").',
            parameters: {
                type: 'object',
                properties: {
                    subject: {
                        type: 'string',
                        description: 'Event title/subject'
                    },
                    startTime: {
                        type: 'string',
                        description: 'Start date/time in ISO 8601 format (e.g. "2025-03-15T10:00:00")'
                    },
                    endTime: {
                        type: 'string',
                        description: 'End date/time in ISO 8601 format (e.g. "2025-03-15T11:00:00")'
                    },
                    location: {
                        type: 'string',
                        description: 'Optional: Event location'
                    },
                    body: {
                        type: 'string',
                        description: 'Optional: Event description/notes'
                    },
                    attendees: {
                        type: 'string',
                        description: 'Optional: Comma-separated email addresses of attendees'
                    },
                    isOnlineMeeting: {
                        type: 'boolean',
                        description: 'Optional: Whether to add a Teams meeting link (default false)'
                    },
                    timeZone: {
                        type: 'string',
                        description: 'Optional: Time zone (default "UTC", e.g. "Europe/Amsterdam", "America/New_York")'
                    }
                },
                required: ['subject', 'startTime', 'endTime']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'ms_calendar_update_event',
            description: 'Update an existing event on the user\'s Outlook calendar. The user will see a preview of the changes before they are applied. Only include the fields you want to change.',
            parameters: {
                type: 'object',
                properties: {
                    eventId: {
                        type: 'string',
                        description: 'The event ID to update (from ms_calendar_list_events or ms_calendar_search_events)'
                    },
                    subject: {
                        type: 'string',
                        description: 'New event title'
                    },
                    startTime: {
                        type: 'string',
                        description: 'New start date/time in ISO 8601 format'
                    },
                    endTime: {
                        type: 'string',
                        description: 'New end date/time in ISO 8601 format'
                    },
                    location: {
                        type: 'string',
                        description: 'New event location'
                    },
                    body: {
                        type: 'string',
                        description: 'New event description'
                    }
                },
                required: ['eventId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'ms_calendar_delete_event',
            description: 'Delete an event from the user\'s Outlook calendar. The user will be asked to confirm before the event is deleted.',
            parameters: {
                type: 'object',
                properties: {
                    eventId: {
                        type: 'string',
                        description: 'The event ID to delete (from ms_calendar_list_events or ms_calendar_search_events)'
                    },
                    subject: {
                        type: 'string',
                        description: 'The event subject (for user confirmation display)'
                    }
                },
                required: ['eventId']
            }
        }
    }
];

/**
 * Format a Graph API event into a consistent shape.
 */
function formatEvent(event) {
    return {
        id: event.id,
        subject: event.subject || '(no title)',
        start: event.start?.dateTime || '',
        startTimeZone: event.start?.timeZone || 'UTC',
        end: event.end?.dateTime || '',
        endTimeZone: event.end?.timeZone || 'UTC',
        location: event.location?.displayName || '',
        organizer: event.organizer?.emailAddress?.address || '',
        attendees: (event.attendees || []).map(a => ({
            email: a.emailAddress?.address,
            name: a.emailAddress?.name,
            status: a.status?.response || 'none',
        })),
        isOnlineMeeting: event.isOnlineMeeting || false,
        onlineMeetingUrl: event.onlineMeeting?.joinUrl || '',
        body: event.body?.content ? event.body.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 500) : '',
    };
}

/**
 * Execute a Microsoft Calendar tool call.
 */
async function executeMsCalendarTool(toolName, args, session) {
    if (!isMicrosoftConnected(session)) {
        throw new Error('Not connected to Microsoft Calendar — user must log in with Microsoft');
    }

    if (toolName === 'ms_calendar_list_events') {
        const daysAhead = Math.min(Math.max(parseInt(args.daysAhead) || 7, 1), 90);
        const maxResults = Math.min(Math.max(parseInt(args.maxResults) || 20, 1), 50);

        const now = new Date();
        const end = new Date(now);
        end.setDate(end.getDate() + daysAhead);

        const data = await graphFetch(
            `/me/calendarView?startDateTime=${now.toISOString()}&endDateTime=${end.toISOString()}&$top=${maxResults}&$orderby=start/dateTime&$select=id,subject,start,end,location,organizer,attendees,isOnlineMeeting,onlineMeeting,body`,
            session
        );

        return {
            events: (data.value || []).map(formatEvent),
            timeRange: { from: now.toISOString(), to: end.toISOString() },
        };

    } else if (toolName === 'ms_calendar_search_events') {
        const { query } = args;
        if (!query) throw new Error('query is required');

        const daysAhead = Math.min(Math.max(parseInt(args.daysAhead) || 30, 1), 90);
        const now = new Date();
        const end = new Date(now);
        end.setDate(end.getDate() + daysAhead);

        // Use calendarView with $filter for subject search
        const data = await graphFetch(
            `/me/calendarView?startDateTime=${now.toISOString()}&endDateTime=${end.toISOString()}&$filter=contains(subject,'${query.replace(/'/g, "''")}')&$top=20&$select=id,subject,start,end,location,organizer,attendees,isOnlineMeeting,onlineMeeting,body`,
            session
        );

        return {
            events: (data.value || []).map(formatEvent),
            query,
        };

    } else if (toolName === 'ms_calendar_create_event') {
        const { subject, startTime, endTime, location, body, attendees, isOnlineMeeting, timeZone } = args;
        if (!subject || !startTime || !endTime) throw new Error('subject, startTime, and endTime are required');

        const tz = timeZone || 'UTC';

        const draft = {
            action: 'create',
            _provider: 'microsoft',
            title: subject,
            startTime,
            endTime,
            timeZone: tz,
            location: location || null,
            description: body || null,
            attendees: attendees || null,
            isOnlineMeeting: isOnlineMeeting || false,
        };

        return {
            _action: 'calendar_draft',
            _provider: 'microsoft',
            _calendarAction: 'create',
            draft,
            message: `Calendar event "${subject}" prepared. Waiting for user approval to create.`,
        };

    } else if (toolName === 'ms_calendar_update_event') {
        const { eventId, subject, startTime, endTime, location, body } = args;
        if (!eventId) throw new Error('eventId is required');

        const changes = {};
        if (subject) changes.title = subject;
        if (startTime) changes.startTime = startTime;
        if (endTime) changes.endTime = endTime;
        if (location !== undefined) changes.location = location;
        if (body !== undefined) changes.description = body;

        return {
            _action: 'calendar_draft',
            _provider: 'microsoft',
            _calendarAction: 'update',
            draft: { action: 'update', _provider: 'microsoft', eventId, ...changes },
            message: `Calendar event update prepared. Waiting for user approval.`,
        };

    } else if (toolName === 'ms_calendar_delete_event') {
        const { eventId, subject } = args;
        if (!eventId) throw new Error('eventId is required');

        return {
            _action: 'calendar_draft',
            _provider: 'microsoft',
            _calendarAction: 'delete',
            draft: { action: 'delete', _provider: 'microsoft', eventId, title: subject || 'event' },
            message: `Will delete event "${subject || eventId}". Waiting for user confirmation.`,
        };

    } else {
        throw new Error(`Unknown MS Calendar tool: ${toolName}`);
    }
}

/**
 * Execute an approved MS Calendar action via Graph API.
 * Called after user confirms the draft.
 */
async function executeMsCalendarAction(action, draft, session) {
    if (!isMicrosoftConnected(session)) {
        throw new Error('Not connected to Microsoft Calendar');
    }

    if (action === 'create') {
        const event = {
            subject: draft.title,
            start: {
                dateTime: draft.startTime,
                timeZone: draft.timeZone || 'UTC',
            },
            end: {
                dateTime: draft.endTime,
                timeZone: draft.timeZone || 'UTC',
            },
        };

        if (draft.location) {
            event.location = { displayName: draft.location };
        }
        if (draft.body) {
            event.body = { contentType: 'Text', content: draft.body };
        }
        if (draft.attendees) {
            event.attendees = draft.attendees.split(',').map(e => ({
                emailAddress: { address: e.trim() },
                type: 'required',
            }));
        }
        if (draft.isOnlineMeeting) {
            event.isOnlineMeeting = true;
            event.onlineMeetingProvider = 'teamsForBusiness';
        }

        const result = await graphFetch('/me/events', session, {
            method: 'POST',
            body: JSON.stringify(event),
        });

        return {
            success: true,
            eventId: result.id,
            subject: result.subject,
            start: result.start?.dateTime,
            message: `Event "${result.subject}" created successfully.`,
        };

    } else if (action === 'update') {
        const { eventId, ...changes } = draft;
        const patch = {};

        if (changes.title) patch.subject = changes.title;
        if (changes.startTime) {
            patch.start = { dateTime: changes.startTime, timeZone: changes.timeZone || 'UTC' };
        }
        if (changes.endTime) {
            patch.end = { dateTime: changes.endTime, timeZone: changes.timeZone || 'UTC' };
        }
        if (changes.location !== undefined) {
            patch.location = { displayName: changes.location };
        }
        if (changes.body !== undefined) {
            patch.body = { contentType: 'Text', content: changes.body };
        }

        const result = await graphFetch(`/me/events/${eventId}`, session, {
            method: 'PATCH',
            body: JSON.stringify(patch),
        });

        return {
            success: true,
            eventId: result.id,
            message: `Event "${result.subject}" updated successfully.`,
        };

    } else if (action === 'delete') {
        await graphFetch(`/me/events/${draft.eventId}`, session, {
            method: 'DELETE',
        });

        return {
            success: true,
            message: `Event "${draft.title || draft.eventId}" deleted successfully.`,
        };

    } else {
        throw new Error(`Unknown MS Calendar action: ${action}`);
    }
}

/**
 * Check if a tool name is an MS Calendar tool.
 */
function isMsCalendarTool(toolName) {
    return ['ms_calendar_list_events', 'ms_calendar_search_events', 'ms_calendar_create_event', 'ms_calendar_update_event', 'ms_calendar_delete_event'].includes(toolName);
}

module.exports = {
    MS_CALENDAR_TOOLS,
    executeMsCalendarTool,
    executeMsCalendarAction,
    isMsCalendarTool,
};
