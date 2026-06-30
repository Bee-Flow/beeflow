/**
 * Trigger field/output-sample catalog for the builder (§WS5, extracted verbatim
 * from builderTools.js). Pure data + lookups, keyed by `<provider>.<event>`.
 */

const TRIGGER_FIELDS_BY_EVENT = {
    'gmail.mail.new':                 ['messageId', 'threadId', 'from', 'to', 'cc', 'subject', 'snippet', 'labelIds', 'date', 'sizeEstimate', 'historyId'],
    'gmail.label.added':              ['messageId', 'threadId', 'addedLabelIds', 'from', 'to', 'subject', 'snippet', 'labelIds', 'date'],
    'google-calendar.event.changed':  ['eventId', 'summary', 'description', 'start', 'end', 'status', 'calendarId', 'organizer', 'attendees', 'htmlLink'],
    'google-calendar.event.upcoming': ['eventId', 'summary', 'description', 'start', 'end', 'status', 'calendarId', 'organizer', 'attendees', 'htmlLink', 'minutesUntilStart'],
    'google-drive.file.new':          ['fileId', 'name', 'mimeType', 'parents', 'createdTime', 'owners', 'webViewLink'],
    'nextcloud.file.new':             ['activityId', 'path', 'name', 'extension', 'kind', 'actor', 'datetime', 'link'],
    'nextcloud.file.changed':         ['activityId', 'path', 'name', 'extension', 'kind', 'actor', 'datetime', 'link'],
    'nextcloud.file.deleted':         ['activityId', 'path', 'name', 'extension', 'kind', 'actor', 'datetime', 'link'],
    'nextcloud.file.renamed':         ['activityId', 'path', 'oldPath', 'name', 'extension', 'kind', 'actor', 'datetime', 'link'],
    'nextcloud.share.received':       ['activityId', 'path', 'name', 'kind', 'actor', 'datetime', 'link'],
    'nextcloud.share.created':        ['shareId', 'shareType', 'path', 'name', 'kind', 'actor', 'datetime', 'link'],
    'nextcloud.activity.new':         ['activityId', 'type', 'subject', 'message', 'actor', 'objectName', 'link', 'datetime'],
    'nextcloud.notification.new':     ['notificationId', 'app', 'subject', 'message', 'link', 'datetime'],
    // Calendar (calendar.event.upcoming is poller-backed; shapes mirror the
    // triggerBus poller emit, not Google's). Other calendar.event.* are push-only.
    'nextcloud.calendar.event.upcoming': ['uid', 'calendarId', 'summary', 'startsAt', 'endsAt', 'location', 'attendees', 'minutesUntilStart', 'actor', 'datetime'],
    'nextcloud.calendar.event.created':  ['uid', 'calendarId', 'summary', 'startsAt', 'endsAt', 'location', 'actor', 'datetime'],
    'nextcloud.calendar.event.changed':  ['uid', 'calendarId', 'summary', 'startsAt', 'endsAt', 'location', 'actor', 'datetime'],
    // Deck — push-only (connector); fields mirror the connector normalisePayload
    // so the variable picker shows real binding paths before validation lands.
    'nextcloud.deck.card.created':    ['cardId', 'boardId', 'stackId', 'title', 'description', 'actor', 'datetime'],
    'nextcloud.deck.card.changed':    ['cardId', 'boardId', 'stackId', 'title', 'archived', 'actor', 'datetime'],
    'nextcloud.deck.card.moved':      ['cardId', 'boardId', 'stackId', 'fromStackId', 'toStackId', 'title', 'actor', 'datetime'],
    'nextcloud.deck.card.completed':  ['cardId', 'boardId', 'stackId', 'title', 'archived', 'actor', 'datetime'],
    // Talk — push-only (connector).
    'nextcloud.talk.message.received':['messageId', 'roomToken', 'roomName', 'actor', 'message', 'datetime'],
    'ticket-assistant.ticket.new':    ['ticketId', 'connectionId', 'provider', 'subject', 'body', 'status', 'status_bucket', 'priority', 'category', 'sourceUri', 'attachments', 'ingestedAt'],
    'ticket-assistant.sync.completed':['connectionId', 'provider', 'outcome', 'stats'],
};

function triggerFieldsFor(draft) {
    const t = draft?.trigger;
    if (!t || t.kind !== 'app_event') return [];
    const key = `${t.appEvent?.provider}.${t.appEvent?.event}`;
    return TRIGGER_FIELDS_BY_EVENT[key] || [];
}

/**
 * Realistic sample values for each trigger output field — used by the
 * client-side VariableTree to show "what does this field actually look
 * like" without needing a dry-run. Keyed by `<provider>.<event>` and
 * mirrors TRIGGER_FIELDS_BY_EVENT.
 *
 * For non-app_event triggers (manual, schedule, webhook) the trigger's
 * own runtime payload is mostly empty (manual/schedule) or user-supplied
 * (webhook body) — we expose a tiny `now` field instead so binding to a
 * schedule trigger has at least one meaningful path.
 */
const TRIGGER_OUTPUT_SAMPLES = {
    'gmail.mail.new': {
        messageId: 'msg-abc123',
        threadId: 'th-abc123',
        from: 'alice@example.com',
        to: 'me@example.com',
        cc: '',
        subject: 'Project update — Q2',
        snippet: 'Hi, attached is the latest deck for the kickoff…',
        labelIds: ['INBOX', 'UNREAD'],
        date: 'Wed, 13 May 2026 09:15:00 +0200',
        sizeEstimate: 12345,
        historyId: '987654',
    },
    'gmail.label.added': {
        messageId: 'msg-abc123',
        threadId: 'th-abc123',
        addedLabelIds: ['Label_3'],
        from: 'alice@example.com',
        to: 'me@example.com',
        subject: 'Project update — Q2',
        snippet: 'Hi, attached is the latest deck…',
        labelIds: ['INBOX', 'Label_3'],
        date: 'Wed, 13 May 2026 09:15:00 +0200',
    },
    'google-calendar.event.changed': {
        eventId: 'evt-abc',
        summary: 'Team standup',
        description: 'Daily sync',
        start: '2026-05-13T09:00:00+02:00',
        end: '2026-05-13T09:30:00+02:00',
        status: 'confirmed',
        calendarId: 'primary',
        organizer: { email: 'me@example.com', displayName: 'Me' },
        attendees: [{ email: 'alice@example.com', responseStatus: 'accepted' }],
        htmlLink: 'https://calendar.google.com/event?eid=…',
    },
    'google-calendar.event.upcoming': {
        eventId: 'evt-abc',
        summary: 'Team standup',
        description: 'Daily sync',
        start: '2026-05-13T09:00:00+02:00',
        end: '2026-05-13T09:30:00+02:00',
        status: 'confirmed',
        calendarId: 'primary',
        organizer: { email: 'me@example.com', displayName: 'Me' },
        attendees: [{ email: 'alice@example.com', responseStatus: 'accepted' }],
        htmlLink: 'https://calendar.google.com/event?eid=…',
        minutesUntilStart: 15,
    },
    'google-drive.file.new': {
        fileId: 'file-xyz',
        name: 'Invoice-2026-001.pdf',
        mimeType: 'application/pdf',
        parents: ['folder-abc'],
        createdTime: '2026-05-13T09:15:00Z',
        owners: [{ emailAddress: 'me@example.com', displayName: 'Me' }],
        webViewLink: 'https://drive.google.com/file/d/file-xyz',
    },
    'nextcloud.file.new': {
        activityId: 12345,
        path: '/Documents/Invoices/Invoice-2026-001.pdf',
        name: 'Invoice-2026-001.pdf',
        extension: 'pdf',
        kind: 'file',
        actor: 'alice',
        datetime: '2026-05-13T09:15:00Z',
        link: 'https://cloud.example.com/f/12345',
    },
    'nextcloud.file.changed': {
        activityId: 12346,
        path: '/Documents/Invoices/Invoice-2026-001.pdf',
        name: 'Invoice-2026-001.pdf',
        extension: 'pdf',
        kind: 'file',
        actor: 'alice',
        datetime: '2026-05-13T10:20:00Z',
        link: 'https://cloud.example.com/f/12345',
    },
    'nextcloud.share.received': {
        activityId: 12347,
        path: '/Shared/Project.docx',
        name: 'Project.docx',
        kind: 'file',
        actor: 'bob',
        datetime: '2026-05-13T11:00:00Z',
        link: 'https://cloud.example.com/f/22345',
    },
    'nextcloud.file.deleted': {
        activityId: 12348,
        path: '/Documents/Old/Draft.docx',
        name: 'Draft.docx',
        extension: 'docx',
        kind: 'file',
        actor: 'alice',
        datetime: '2026-05-13T11:30:00Z',
        link: 'https://cloud.example.com/f/12348',
    },
    'nextcloud.file.renamed': {
        activityId: 12349,
        path: '/Documents/Invoices/Invoice-2026-001.pdf',
        oldPath: '/Documents/Invoices/draft.pdf',
        name: 'Invoice-2026-001.pdf',
        extension: 'pdf',
        kind: 'file',
        actor: 'alice',
        datetime: '2026-05-13T11:45:00Z',
        link: 'https://cloud.example.com/f/12345',
    },
    'nextcloud.share.created': {
        shareId: 778,
        shareType: 'link',
        path: '/Shared/Report.pdf',
        name: 'Report.pdf',
        kind: 'file',
        actor: 'alice',
        datetime: '2026-05-13T13:00:00Z',
        link: 'https://cloud.example.com/s/AbCdEf',
    },
    'nextcloud.calendar.event.upcoming': {
        uid: 'evt-9f2a',
        calendarId: 'personal',
        summary: 'Kickoff with Nextcloud',
        startsAt: '2026-05-13T15:00:00+02:00',
        endsAt: '2026-05-13T15:30:00+02:00',
        location: 'Online',
        attendees: ['alice@example.com', 'bob@example.com'],
        minutesUntilStart: 15,
        actor: 'me',
        datetime: '2026-05-13T14:45:00Z',
    },
    'nextcloud.calendar.event.created': {
        uid: 'evt-9f2b',
        calendarId: 'personal',
        summary: 'Design review',
        startsAt: '2026-05-14T10:00:00+02:00',
        endsAt: '2026-05-14T11:00:00+02:00',
        location: '',
        actor: 'alice',
        datetime: '2026-05-13T09:00:00Z',
    },
    'nextcloud.calendar.event.changed': {
        uid: 'evt-9f2b',
        calendarId: 'personal',
        summary: 'Design review (moved)',
        startsAt: '2026-05-14T11:00:00+02:00',
        endsAt: '2026-05-14T12:00:00+02:00',
        location: 'Room 2',
        actor: 'alice',
        datetime: '2026-05-13T09:30:00Z',
    },
    'nextcloud.deck.card.created': {
        cardId: 4521,
        boardId: 12,
        stackId: 34,
        title: 'Follow up with Nextcloud',
        description: 'Prep the integration demo',
        actor: 'alice',
        datetime: '2026-05-13T09:20:00Z',
    },
    'nextcloud.deck.card.changed': {
        cardId: 4521,
        boardId: 12,
        stackId: 34,
        title: 'Follow up with Nextcloud',
        archived: false,
        actor: 'alice',
        datetime: '2026-05-13T10:00:00Z',
    },
    'nextcloud.deck.card.moved': {
        cardId: 4521,
        boardId: 12,
        stackId: 36,
        fromStackId: 34,
        toStackId: 36,
        title: 'Follow up with Nextcloud',
        actor: 'alice',
        datetime: '2026-05-13T10:30:00Z',
    },
    'nextcloud.deck.card.completed': {
        cardId: 4521,
        boardId: 12,
        stackId: 36,
        title: 'Follow up with Nextcloud',
        archived: true,
        actor: 'alice',
        datetime: '2026-05-13T11:00:00Z',
    },
    'nextcloud.talk.message.received': {
        messageId: 88123,
        roomToken: 'a1b2c3d4',
        roomName: 'Demo team',
        actor: 'alice',
        message: 'Can someone post the latest invoice summary?',
        datetime: '2026-05-13T12:30:00Z',
    },
    'nextcloud.activity.new': {
        activityId: 12350,
        type: 'file_created',
        subject: 'alice created Invoice-2026-001.pdf',
        message: '',
        actor: 'alice',
        objectName: 'Invoice-2026-001.pdf',
        link: 'https://cloud.example.com/f/12345',
        datetime: '2026-05-13T09:15:00Z',
    },
    'nextcloud.notification.new': {
        notificationId: 9876,
        app: 'comments',
        subject: 'alice mentioned you',
        message: '@me please take a look',
        link: 'https://cloud.example.com/comment/9876',
        datetime: '2026-05-13T12:00:00Z',
    },
    'ticket-assistant.ticket.new': {
        ticketId: 'TKT-1024',
        connectionId: 'conn-1',
        provider: 'youtrack',
        subject: 'Login fails after password reset',
        body: 'Steps: 1. Reset password. 2. Try to log in. Result: 401.',
        status: 'open',
        status_bucket: 'open',
        priority: 'high',
        category: 'authentication',
        sourceUri: 'https://youtrack.example.com/issue/TKT-1024',
        attachments: [],
        ingestedAt: '2026-05-13T08:00:00Z',
    },
    'ticket-assistant.sync.completed': {
        connectionId: 'conn-1',
        provider: 'youtrack',
        outcome: 'success',
        stats: { ingested: 12, updated: 3, skipped: 0 },
    },
};

/**
 * Build a `<provider>.<event>` → { fields:[{key, sample}] } map for the
 * client catalog. Fields come from TRIGGER_FIELDS_BY_EVENT (the
 * authoritative list); samples come from TRIGGER_OUTPUT_SAMPLES so the
 * VariableTree can show a realistic placeholder next to each path.
 */
function buildTriggerOutputsCatalog() {
    const out = {};
    for (const [key, fields] of Object.entries(TRIGGER_FIELDS_BY_EVENT)) {
        const sample = TRIGGER_OUTPUT_SAMPLES[key] || {};
        out[key] = {
            fields: fields.map(f => ({ key: f, sample: sample[f] })),
            sample,
        };
    }
    // Non-app_event triggers expose minimal output. Manual/schedule fire
    // with no user-supplied payload; `now` is always available via the
    // runtime so it's worth surfacing as a bindable path.
    out['__manual'] = { fields: [{ key: 'now', sample: new Date().toISOString() }], sample: { now: new Date().toISOString() } };
    out['__schedule'] = { fields: [{ key: 'now', sample: new Date().toISOString() }], sample: { now: new Date().toISOString() } };
    out['__webhook'] = { fields: [{ key: 'body', sample: { /* user-defined */ } }, { key: 'headers', sample: {} }], sample: { body: {}, headers: {} } };
    return out;
}

/**
 * Inspect every binding inside a freshly-supplied `inputs` map (and any
 * `template` strings within them). Returns `{ inputs, error }`:
 *   - `inputs`: the canonicalised map, with safe auto-fixes applied
 *     (bare path "from" → "trigger.output.from" when the trigger exposes it,
 *     leading dots stripped).
 *   - `error`: a human-readable message for the LLM if any binding is still
 *     invalid after auto-fixes — caller should surface this as the tool
 *     result so the model corrects on its NEXT turn instead of running
 *     through a dry-run failure cycle.
 */

module.exports = { TRIGGER_FIELDS_BY_EVENT, triggerFieldsFor, TRIGGER_OUTPUT_SAMPLES, buildTriggerOutputsCatalog };
