/**
 * Builder tools — function-calling schemas the conversational builder agent
 * uses to mutate a draft automation. Each tool has:
 *   - schema (OpenAI/Anthropic function-call format) injected into the LLM
 *   - apply() implementation that mutates a Draft instance and returns
 *     a small JSON snippet describing the change.
 *
 * Drafts are kept per (userId, builderSessionId) and persisted to
 * automations(is_draft=TRUE) after every successful mutation, so a
 * page refresh recovers the work.
 */

const crypto = require('crypto');
const automationStore = require('../stores/automationStore');
const { summariseDefinition } = require('./summarise');
const { validateDefinition } = require('./validate');
const { isSideEffect } = require('./sideEffectMap');

function newId(prefix = 's') { return `${prefix}_${crypto.randomBytes(3).toString('hex')}`; }

function emptyDefinition() {
    return {
        schemaVersion: 1,
        trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
        steps: [],
        edges: [],
        vars: {},
    };
}

/**
 * Coerce a step's inputs into canonical binding form.
 *
 * Tolerates the AI's common mistakes:
 *   - raw strings/numbers/booleans/arrays passed where a binding wrapper
 *     was expected → wrapped as { kind: 'literal', value: ... }
 *   - strings that look like template paths "{{...}}" → upgraded to template
 *   - already-canonical bindings → passed through unchanged
 *
 * Lossless: anything already valid keeps its shape. Anything ambiguous
 * defaults to literal so the runtime won't crash on bad refs.
 */
function canonicalizeInputs(inputs) {
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return {};
    const out = {};
    for (const [k, v] of Object.entries(inputs)) {
        out[k] = canonicalizeBinding(v);
    }
    return out;
}

function canonicalizeBinding(v) {
    // Already a binding wrapper — pass through.
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.kind === 'string'
        && ['literal', 'ref', 'template', 'expr'].includes(v.kind)) {
        return v;
    }
    // String containing {{...}} → template.
    if (typeof v === 'string' && /\{\{[^}]+\}\}/.test(v)) {
        return { kind: 'template', value: v };
    }
    // Anything else → literal. This is the safe, runtime-friendly choice.
    return { kind: 'literal', value: v };
}

const VALID_REF_ROOTS = new Set(['trigger', 'steps', 'vars', 'secrets', 'loop']);

// Trigger output fields the LLM commonly mis-roots — when a ref path is bare
// ("from", "subject", …) we can confidently prepend `trigger.output.` instead
// of bouncing the call back to the model. Keyed by `<provider>.<event>`.
const TRIGGER_FIELDS_BY_EVENT = {
    'gmail.mail.new':                 ['messageId', 'threadId', 'from', 'to', 'cc', 'subject', 'snippet', 'labelIds', 'date', 'sizeEstimate', 'historyId'],
    'gmail.label.added':              ['messageId', 'threadId', 'addedLabelIds', 'from', 'to', 'subject', 'snippet', 'labelIds', 'date'],
    'google-calendar.event.changed':  ['eventId', 'summary', 'description', 'start', 'end', 'status', 'calendarId', 'organizer', 'attendees', 'htmlLink'],
    'google-calendar.event.upcoming': ['eventId', 'summary', 'description', 'start', 'end', 'status', 'calendarId', 'organizer', 'attendees', 'htmlLink', 'minutesUntilStart'],
    'google-drive.file.new':          ['fileId', 'name', 'mimeType', 'parents', 'createdTime', 'owners', 'webViewLink'],
    'nextcloud.file.new':             ['activityId', 'path', 'name', 'extension', 'kind', 'actor', 'datetime', 'link'],
    'nextcloud.file.changed':         ['activityId', 'path', 'name', 'extension', 'kind', 'actor', 'datetime', 'link'],
    'nextcloud.share.received':       ['activityId', 'path', 'name', 'kind', 'actor', 'datetime', 'link'],
    'nextcloud.activity.new':         ['activityId', 'type', 'subject', 'message', 'actor', 'objectName', 'link', 'datetime'],
    'nextcloud.notification.new':     ['notificationId', 'app', 'subject', 'message', 'link', 'datetime'],
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
function validateAndFixBindings(rawInputs, draft) {
    const fixed = canonicalizeInputs(rawInputs || {});
    const triggerFields = new Set(triggerFieldsFor(draft));
    const errors = [];

    for (const [k, v] of Object.entries(fixed)) {
        if (!v || typeof v !== 'object') continue;

        if (v.kind === 'ref' && typeof v.path === 'string') {
            const cleaned = v.path.replace(/^\.+/, '').trim();
            const root = cleaned.split('.')[0];
            if (VALID_REF_ROOTS.has(root)) {
                if (cleaned !== v.path) v.path = cleaned;
                continue;
            }
            if (triggerFields.has(cleaned)) {
                v.path = `trigger.output.${cleaned}`;
                continue;
            }
            errors.push(
                `inputs.${k}: ref path "${v.path}" has unknown root "${root}". `
                + `Valid roots: trigger, steps, vars, secrets, loop. `
                + (triggerFields.size
                    ? `For this Gmail trigger use trigger.output.<field>, e.g. trigger.output.${triggerFields.has(cleaned) ? cleaned : 'subject'}.`
                    : 'Use e.g. trigger.output.<field> or steps.<id>.output.<field>.')
            );
        }

        if (v.kind === 'template' && typeof v.value === 'string') {
            // Re-write {{ from }} → {{ trigger.output.from }} when the bare
            // identifier matches a known trigger field. Reject anything else
            // that has an unknown root.
            const bad = [];
            v.value = v.value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, expr) => {
                const cleaned = expr.replace(/^\.+/, '').trim();
                const root = cleaned.split('.')[0];
                if (VALID_REF_ROOTS.has(root)) return `{{${cleaned}}}`;
                if (triggerFields.has(cleaned)) return `{{trigger.output.${cleaned}}}`;
                bad.push(expr);
                return full;
            });
            if (bad.length) {
                errors.push(
                    `inputs.${k}: template references ${bad.map(s => `"${s}"`).join(', ')} which has unknown root. `
                    + `Use {{trigger.output.<field>}} or {{steps.<id>.output.<field>}}.`
                );
            }
        }
    }

    return { inputs: fixed, error: errors.length ? errors.join(' ') : null };
}

function lastStepId(def) {
    if (def.steps.length === 0) return def.trigger.id;
    return def.steps[def.steps.length - 1].id;
}

// ── Tool schemas (injected to the LLM) ─────────────────

// ─── Binding format reminder for the AI ──────────────────────────
// Every input value MUST be one of these shapes (or a plain JSON literal,
// which is treated as { kind: 'literal', value: ... }):
//   { "kind": "literal",  "value": <any> }
//   { "kind": "ref",      "path":  "steps.s1.output.items[0].subject" }
//   { "kind": "template", "value": "Found {{steps.s1.output.count}} items" }
//   { "kind": "expr",     "value": "steps.s1.output.amount > 1000" }
const BINDING_HINT = 'Each input value must be a binding: {"kind":"literal","value":...} OR {"kind":"ref","path":"steps.<id>.output.<field>"} OR {"kind":"template","value":"... {{steps.x.output.y}} ..."} OR {"kind":"expr","value":"<restricted-js>"}.';

const TOOL_SCHEMAS = [
    {
        type: 'function',
        function: {
            name: 'builder_propose_trigger',
            description: `Set or replace the automation trigger. ALWAYS call this first when starting a new draft.

KIND OPTIONS:
  - schedule     — fires on a cron timer (5-field cron, minute hour dom month dow).
  - manual       — fires only when the user clicks "Run".
  - webhook      — fires on inbound HTTPS POST to a signed URL.
  - app_event    — fires when a connected service (Gmail / Calendar / Drive / Nextcloud) emits an event.

SCHEDULE EXAMPLES:
  - weekly Monday 9am Europe/Amsterdam → {kind:"schedule",cron:"0 9 * * 1",tz:"Europe/Amsterdam"}
  - first Monday of the month at 9am  → {kind:"schedule",cron:"0 9 1-7 * 1",tz:"Europe/Amsterdam"}

APP_EVENT TRIGGERS (pick the most specific; use filters to narrow):

  ── Gmail ──
  • mail.new — fires on every new email. Most-asked Gmail trigger.
    Filters: from, to, cc, subjectContains, subjectRegex, labelIds[],
             excludeLabelIds[], hasAttachment, excludeFromSelf, maxAgeMinutes.
    Payload: {messageId, threadId, from, to, cc, subject, date, snippet,
             labelIds, sizeEstimate, historyId}.
    EXAMPLE — only emails from your boss:
      {kind:"app_event",appProvider:"gmail",appEvent:"mail.new",
       filter:{from:"boss@example.com",excludeFromSelf:true}}
    **Replying**: when adding a gmail_compose step to reply, ALWAYS bind
    replyToMessageId: trigger.output.messageId. Without it Gmail renders
    the reply as a fresh standalone email instead of inline in the
    original conversation — even if you also pass threadId.
    NOTE — "in the last 24 hours" is NOT a filter for mail.new because it
    fires on every newly-arrived message in real time. For "every morning
    summarise yesterday's email", use a schedule trigger + a gmail_search
    step with q:"newer_than:1d" instead.

  • label.added — fires when a label is applied (manually or by a Gmail
    filter rule). Useful for "when I label something 'urgent', do X".
    Filters: labelId (REQUIRED), from, subjectContains, excludeLabelIds[].
    Payload: {messageId, threadId, addedLabelIds, from, to, subject,
             snippet, labelIds, date}.
    EXAMPLE: {kind:"app_event",appProvider:"gmail",appEvent:"label.added",
             filter:{labelId:"Label_3"}}

  ── Google Calendar ──
  • event.changed — fires when any event in the user's primary calendar
    is created, updated, or cancelled.
    Filters: calendarId, statusEquals ("confirmed"/"cancelled"),
             attendeeEmailContains.
    Payload: {eventId, summary, description, start, end, status,
             calendarId, organizer, attendees, htmlLink}.

  • event.upcoming — fires N minutes BEFORE an event starts. Best for
    "remind me 15 min before any meeting" workflows.
    Filters: leadMinutes (default 15), calendarId, includeAllDay (default
             false), attendeeEmailContains.
    Payload: same as event.changed plus {minutesUntilStart}.
    EXAMPLE: {kind:"app_event",appProvider:"google-calendar",
             appEvent:"event.upcoming",filter:{leadMinutes:15}}

  ── Google Drive ──
  • file.new — fires when a file is created (not modified) in the user's
    Drive.
    Filters: folderId, mimeType, nameContains, excludeOwnUploads.
    Payload: {fileId, name, mimeType, parents, createdTime, owners,
             webViewLink}.
    EXAMPLE — PDFs landing in /Invoices folder:
      {kind:"app_event",appProvider:"google-drive",appEvent:"file.new",
       filter:{folderId:"<drive-folder-id>",mimeType:"application/pdf"}}

  ── Nextcloud ──
  Connector-bound users get sub-second push delivery via the Bee Flow
  Nextcloud ExApp; everyone else falls back to 60s polling for the
  events that have a poller (file.new, file.changed, share.received,
  activity.new, notification.new). The other triggers below require the
  connector — activate fails with an explanatory error otherwise.

  ── Files ──
  • file.new / file.changed / file.deleted / file.renamed
    Filters: inFolder (path prefix), extension, nameContains,
             excludeOwnUploads, any[]/none[]/expr/age (rich filter DSL).
    Payload: {id, path, name, extension, kind, actor, datetime, link}.

  • file.commented — fires when a comment is added to a file.
    Filters: pathPrefix, actorEquals, messageContains.
    Payload: {fileId, path, name, comment, actor, datetime}.

  • file.tagged — fires when a system tag is added or removed from a file.
    Filters: tagName, tagAction ("added"/"removed"), pathPrefix.
    Payload: {fileId, path, tagName, tagAction, actor, datetime}.

  ── Sharing ──
  • share.created / share.received / share.accepted / share.deleted
    Filters: actorEquals, nameContains, kindEquals ("file"/"folder"),
             shareType ("link"/"user"/"group"/"federated").
    Payload: {shareId, path, name, kind, shareType, actor, datetime, link}.

  ── Calendar ──
  • calendar.event.created / calendar.event.changed / calendar.event.deleted
    Filters: calendarId, summaryContains, attendeeContains.
    Payload: {uid, calendarId, summary, startsAt, endsAt, actor, datetime}.

  • calendar.event.upcoming — schedule-driven (poll-only); fires N minutes
    before an event starts.
    Filters: leadMinutes (default 15), calendarId, summaryContains.

  ── Deck (kanban) ──
  • deck.card.created / deck.card.changed / deck.card.deleted
    Filters: boardId, stackId, titleContains, archived (true/false).
    Payload: {cardId, boardId, stackId, title, archived, actor, datetime}.

  • deck.card.moved — fires when a card moves between stacks (a special
    case of deck.card.changed).
    Filters: boardId, fromStackId, toStackId.

  • deck.card.completed — fires when "Done"/"Closed" stack receives a card
    (heuristic: stack title matches /done|closed|complete/i).

  ── Talk (chat) ──
  • talk.message.received — fires for new chat messages.
    Filters: roomToken, roomNameContains, actorEquals, messageContains,
             excludeOwnMessages.
    Payload: {messageId, roomToken, roomName, actor, message, datetime}.

  • talk.mention.received — fires only when the message @-mentions the user.
    Filters: roomToken, actorEquals.

  ── Tasks ──
  • task.created / task.completed / task.due
    Filters: listId, titleContains, priorityEquals.
    Payload: {taskId, listId, title, completed, priority, due, actor, datetime}.

  ── Generic ──
  • activity.new — power-user catch-all over the activity feed.
    Filters: type, objectNameContains, actorEquals.

  • notification.new — fires on Nextcloud system notifications.
    Filters: app, subjectContains.
    Payload: {notificationId, app, subject, message, link, datetime}.

  • user.status.changed — fires on user status updates (online/away/dnd).
    Filters: status ("online"/"away"/"dnd"/"invisible"), userIdEquals.

  ── Ticket Assistant (ITIL ticket sync — gmail/outlook/jira/servicenow/
                       zendesk/freshservice/topdesk) ──
  • ticket.new — fires when the Ticket Assistant ingests a new email or
    ticket. Org-scoped: every user in the org sees events for any of the
    org's connections. Pair with the ticket_assistant_* tools to rebuild
    or extend the standalone TA pipeline (clean → redact → summarise →
    classify) inside a routine.
    Filters: connectionId, provider ("gmail"/"outlook"/"jira"/"zendesk"/…),
             subjectContains, bodyContains, categoryEquals (post-AI),
             priorityEquals, statusEquals.
    Payload: {ticketId, connectionId, provider, subject, body, status,
             status_bucket, priority, category, sourceUri, attachments,
             ingestedAt}.
    EXAMPLE — high-priority Jira tickets only:
      {kind:"app_event",appProvider:"ticket-assistant",
       appEvent:"ticket.new",filter:{provider:"jira",priorityEquals:"high"}}

  • sync.completed — fires when a TA connection's sync run finishes.
    Filters: connectionId, provider, outcomeEquals ("success"/"error"/
             "partial").
    Payload: {connectionId, provider, outcome, stats}.

GENERAL: bind the trigger payload via trigger.output.<field>. DO NOT add a
leading search step just to look up data that's already in the payload.`,
            parameters: {
                type: 'object',
                properties: {
                    kind: { type: 'string', enum: ['schedule', 'manual', 'webhook', 'app_event'] },
                    cron: { type: 'string', description: 'Standard 5-field cron, REQUIRED when kind=schedule. Use exact format: minute hour day-of-month month day-of-week. Example: "0 9 * * 1" = every Monday at 9:00.' },
                    tz: { type: 'string', description: 'IANA timezone, e.g. Europe/Amsterdam (when kind=schedule).' },
                    appProvider: { type: 'string', description: 'Provider id (when kind=app_event): gmail | google-calendar | google-drive | nextcloud | ticket-assistant' },
                    appEvent: { type: 'string', description: 'Event name (when kind=app_event). Allowed: gmail.{mail.new, label.added}; google-calendar.{event.changed, event.upcoming}; google-drive.file.new; nextcloud.{file.new, file.changed, file.deleted, file.renamed, file.commented, file.tagged, share.created, share.received, share.accepted, share.deleted, calendar.event.created, calendar.event.changed, calendar.event.deleted, calendar.event.upcoming, deck.card.created, deck.card.changed, deck.card.deleted, deck.card.moved, deck.card.completed, talk.message.received, talk.mention.received, task.created, task.completed, task.due, activity.new, notification.new, user.status.changed}; ticket-assistant.{ticket.new, sync.completed}.' },
                    filter: { type: 'object', description: 'Optional filter object that must shallowly match the event payload.' },
                },
                required: ['kind'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_action',
            description: `Append an integration action that calls a real connected tool. The tool name MUST match the catalog exactly. ${BINDING_HINT} EXAMPLE — search Gmail for unread invoices: {tool:"gmail_search",inputs:{query:{kind:"literal",value:"label:Invoices is:unread"},maxResults:{kind:"literal",value:20}},label:"Find invoices"}. EXAMPLE — read a specific email: {tool:"gmail_read",inputs:{messageId:{kind:"ref",path:"loop.email.id"}}}. NEVER pass plain strings as input values; ALWAYS wrap in {kind,...}.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string', description: 'Insert after this step id. Default: last step.' },
                    tool: { type: 'string', description: 'Exact tool name from the catalog (e.g. gmail_search, gmail_compose, calendar_create_event).' },
                    inputs: { type: 'object', description: `Map of input-name to a binding object. ${BINDING_HINT}` },
                    label: { type: 'string', description: 'Short human-readable label for the diagram.' },
                },
                required: ['tool'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_ai_step',
            description: `Append an AI reasoning step that transforms or summarises upstream data. By default no tool calls — set allowTools:true (and optionally a tools allowlist) when this step needs to fetch data on its own (web search, Gmail lookup, etc.). The user's per-org integration permissions are still enforced at runtime. Use this for: extracting structured fields from text, summarising, classifying, drafting reply text, OR (with allowTools) free-form research that doesn't fit a static integration_action. ${BINDING_HINT} EXAMPLE — extract invoice fields: {prompt:"Extract amount, currency, vendor, dueDate from this invoice email.",inputs:{emailBody:{kind:"ref",path:"loop.email.body"}},outputSchema:{type:"object",properties:{amount:{type:"number"},currency:{type:"string"},vendor:{type:"string"},dueDate:{type:"string"}}},modelTier:"fast"}.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    prompt: { type: 'string', description: 'The instruction for the AI. Reference the inputs by name.' },
                    inputs: { type: 'object', description: `Map of binding-name to a binding object. ${BINDING_HINT}` },
                    outputSchema: { type: 'object', description: 'JSON schema describing the desired structured output. Strongly recommended so downstream steps can reference fields.' },
                    modelTier: { type: 'string', enum: ['auto', 'fast', 'standard', 'thinking'], description: 'Default: auto (mirrors direct chat — classifier picks fast/standard/thinking based on prompt complexity).' },
                    allowTools: { type: 'boolean', description: 'Default false. When true the AI step can call the user\'s integration tools (web search, gmail_search, etc.). Use sparingly — most steps should bind upstream integration_action output instead.' },
                    tools: { type: 'array', items: { type: 'string' }, description: 'Optional allowlist of tool names the AI step may call. Empty / omitted = whatever allowTools dictates.' },
                    label: { type: 'string' },
                },
                required: ['prompt'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_condition',
            description: 'Append an if/else branch. The expr is a restricted JS expression — supports member access, comparisons, &&, ||, ?:, math. NO function calls. EXAMPLES: "steps.parse.output.amount > 1000", "steps.s1.output.count == 0", "loop.email.subject == \\"Urgent\\"". After adding, call builder_add_action / builder_add_ai_step / builder_add_notification with afterStepId pointing to this condition\'s id to grow the "then" branch; the "else" branch is built by passing thenStepId/elseStepId on this same call.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    expr: { type: 'string', description: 'Restricted JS expression (no function calls).' },
                    thenStepId: { type: 'string', description: 'Optional id of an existing step to wire as the "then" branch.' },
                    elseStepId: { type: 'string', description: 'Optional id of an existing step to wire as the "else" branch.' },
                    label: { type: 'string' },
                },
                required: ['expr'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_loop',
            description: `Append a for-each loop over an upstream array. The body is a SUB-DAG of steps that runs once per item. Inside the body, refer to the current item as loop.<itemVar>. ${BINDING_HINT} EXAMPLE — for each invoice email, extract fields and create YouTrack issue: {overRef:"steps.search.output.items",itemVar:"email",maxIterations:50,body:[{type:"ai_step",prompt:"Extract amount and vendor.",inputs:{body:{kind:"ref",path:"loop.email.body"}}},{type:"integration_action",tool:"youtrack_create_issue",inputs:{summary:{kind:"template",value:"Invoice {{loop.email.subject}}"}}}]}. IMPORTANT: every body step MUST have a "type" field; the system will assign ids if missing.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    overRef: { type: 'string', description: 'Path to the array, e.g. steps.search.output.items.' },
                    itemVar: { type: 'string', description: 'Loop variable name; available inside body as loop.<itemVar>.' },
                    body: { type: 'array', description: 'Sub-DAG step objects (linear). Each must include "type". "id" is auto-assigned if missing.' },
                    maxIterations: { type: 'integer', description: 'Cap, default 100, max 1000.' },
                    label: { type: 'string' },
                },
                required: ['overRef', 'itemVar'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_code_step',
            description: 'Append a sandboxed JavaScript step. Use ONLY when no integration fits. Code receives `inputs` and `ctx` (with ctx.log, ctx.http, ctx.integrations.<tool>, ctx.secrets). Define `function main(inputs, ctx)` and return the result. Code is gated by org policy; only propose this when the catalog clearly lacks a fitting tool.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    code: { type: 'string', description: 'JavaScript source. Define `async function main(inputs, ctx) { ... return result; }`.' },
                    inputs: { type: 'object' },
                    outputSchema: { type: 'object' },
                    allowedTools: { type: 'array', items: { type: 'string' }, description: 'Tool names this step may call via ctx.integrations.<tool>(args).' },
                    label: { type: 'string' },
                },
                required: ['code'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_notification',
            description: `Append a notification step that delivers a result to the user. The title and body are TEMPLATES — interpolate upstream data with double curly braces. EXAMPLE: {title:"Monthly invoice report",body:"Found {{steps.search.output.count}} invoices totalling €{{steps.sum.output.total}}",channels:["notification"]}. For Gmail-delivered notifications, instead use builder_add_action with tool gmail_compose.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    title: { type: 'string', description: 'Template string. Supports {{steps.<id>.output.<path>}}.' },
                    body: { type: 'string', description: 'Template string. Supports {{steps.<id>.output.<path>}}.' },
                    channels: { type: 'array', items: { type: 'string' }, description: 'Default: ["notification"].' },
                    label: { type: 'string' },
                },
                required: ['title'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_set',
            description: `Append a "set" step that produces an explicit object. Each field's value uses the standard binding shape — literal/ref/template/expr. Use this to renaming/restructuring fields before a downstream integration_action. ${BINDING_HINT} EXAMPLE: {fields:{name:{kind:"literal",value:"Alice"},email:{kind:"ref",path:"trigger.output.from"}}}.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    fields: { type: 'object', description: `Map of fieldName → binding. ${BINDING_HINT}` },
                    label: { type: 'string' },
                },
                required: ['fields'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_datetime',
            description: 'Append a date/time operation. ops: now (current time), parse (string→ISO), format (ISO→formatted string), addDays/addHours/addMinutes (offset by amount), diff (two refs → numeric diff in unit), extract (year/month/day/hour/minute/dayOfWeek). EXAMPLES: {op:"now"} | {op:"addDays",input:"trigger.output.timestamp",amount:7} | {op:"format",input:"steps.x.output.iso",format:"yyyy-MM-dd"} | {op:"diff",input:"trigger.output.start",input2:"trigger.output.end",unit:"hours"}.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    op: { type: 'string', enum: ['now', 'parse', 'format', 'addDays', 'addHours', 'addMinutes', 'diff', 'extract'] },
                    input: { type: 'string', description: 'Path to a date value (ISO string or epoch ms). Omit for op:now.' },
                    input2: { type: 'string', description: 'Second date path. Required for op:diff.' },
                    amount: { type: 'number', description: 'Offset amount (positive or negative). Required for addDays/addHours/addMinutes.' },
                    format: { type: 'string', description: 'Format string with tokens yyyy/MM/dd/HH/mm/ss. Required for op:format.' },
                    part: { type: 'string', enum: ['year', 'month', 'day', 'hour', 'minute', 'second', 'dayOfWeek'], description: 'Required for op:extract.' },
                    unit: { type: 'string', enum: ['days', 'hours', 'minutes', 'seconds'], description: 'Required for op:diff.' },
                    label: { type: 'string' },
                },
                required: ['op'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_wait',
            description: 'Append a step that pauses the run for N seconds (1..86400). Use for simple rate limiting or to give an external service time to settle. Dry-run skips the wait.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    seconds: { type: 'integer', description: 'Number of seconds to wait. Capped at 86400 (24h).' },
                    label: { type: 'string' },
                },
                required: ['seconds'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_stop_error',
            description: 'Append a step that halts the run with a custom error message. The message is a TEMPLATE — interpolate upstream fields with double curly braces. Use as a guardrail downstream of a condition that detects "we should not continue". EXAMPLE: {message:"Budget exceeded: {{steps.calc.output.delta}}"}.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    message: { type: 'string', description: 'Template string surfaced as the run error.' },
                    label: { type: 'string' },
                },
                required: ['message'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_switch',
            description: 'Append a multi-way branch. Evaluates expr and routes to the first matching case. Each case is { name, value }. Wire each case to its next step by passing nextStepIds: { "<caseName>": "<stepId>", "default": "<stepId>" }. EXAMPLE: {expr:"trigger.output.priority",cases:[{name:"urgent",value:"high"},{name:"normal",value:"medium"}],defaultBranch:"fallback"}.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    expr: { type: 'string', description: 'Restricted JS expression whose value gets matched.' },
                    cases: { type: 'array', description: 'Array of { name, value } — match in order, first hit wins.', items: { type: 'object', properties: { name: { type: 'string' }, value: {} }, required: ['name'] } },
                    defaultBranch: { type: 'string', description: 'Case name to route to when no case matches (otherwise dead-ends).' },
                    nextStepIds: { type: 'object', description: 'Map of case name → existing step id to wire as the branch target. Use this in one shot instead of calling builder_add_* with afterStepId per branch.' },
                    label: { type: 'string' },
                },
                required: ['expr', 'cases'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_filter',
            description: 'Append a collection filter — keeps array items matching expr. arrayRef points to an upstream array; expr is evaluated per element with the current element bound as `item`. Output is { items, count }. EXAMPLE: {arrayRef:"steps.search.output.results",expr:"item.amount > 1000"}.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    arrayRef: { type: 'string' },
                    expr: { type: 'string', description: 'Restricted JS expression referencing item.<field>.' },
                    label: { type: 'string' },
                },
                required: ['arrayRef', 'expr'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_limit',
            description: 'Append a step that returns the first or last N items of an array. Output is { items, count }.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    arrayRef: { type: 'string' },
                    count: { type: 'integer', description: 'How many items to keep.' },
                    mode: { type: 'string', enum: ['first', 'last'], description: 'Default: first.' },
                    label: { type: 'string' },
                },
                required: ['arrayRef', 'count'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_dedupe',
            description: 'Append a step that removes duplicate items. With keyField, dedup by that field; without, dedup by deep equality. Output is { items, removed }.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    arrayRef: { type: 'string' },
                    keyField: { type: 'string', description: 'Optional. If set, items with the same value at this field are treated as duplicates.' },
                    label: { type: 'string' },
                },
                required: ['arrayRef'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_aggregate',
            description: 'Append a step that pulls one field across every item of an array into a flat list. Output is { values, count }. EXAMPLE: {arrayRef:"steps.search.output.results",field:"email"} → values is an array of emails.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    arrayRef: { type: 'string' },
                    field: { type: 'string', description: 'Field name to read from each item.' },
                    label: { type: 'string' },
                },
                required: ['arrayRef', 'field'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_summarize',
            description: 'Append a statistics step over a numeric field of an array. ops: sum, count (length of arrayRef regardless of field), avg, min, max. Output is { result, op, count }.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    arrayRef: { type: 'string' },
                    field: { type: 'string' },
                    op: { type: 'string', enum: ['sum', 'count', 'avg', 'min', 'max'] },
                    label: { type: 'string' },
                },
                required: ['arrayRef', 'field', 'op'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_remove_step',
            description: 'Remove a step from the draft by id, including its incident edges.',
            parameters: { type: 'object', properties: { stepId: { type: 'string' } }, required: ['stepId'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_set_metadata',
            description: 'Set the user-visible title and/or description for this automation.',
            parameters: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' } } },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_inspect_tool',
            description: 'Look up the EXACT output shape of an integration tool. Use this BEFORE adding actions whose output you need to chain — so you know whether the field is "results" or "items" or "events" without guessing. Returns a one-line shape descriptor (e.g. "results: array of { id, from, subject, ... }; total: integer") sourced from runtime samples when available, otherwise from the curated schema.',
            parameters: {
                type: 'object',
                properties: { tool: { type: 'string', description: 'Exact tool name from the catalog.' } },
                required: ['tool'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_summarise',
            description: 'Return a deterministic plain-English summary of the current draft. Call after every batch of mutations so the user sees what changed.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_request_dry_run',
            description: 'Execute the draft in dry-run mode. Side-effect actions are simulated (no real emails sent, no real issues created); read-only and AI steps run for real. Returns the run row + per-step output. ALWAYS dry-run after building a complete draft, then read the per-step output. If any step errored, fix it (remove_step + add_*) and dry-run again. Only after a clean dry-run should you call builder_finalize.',
            parameters: { type: 'object', properties: { triggerPayload: { type: 'object', description: 'Optional fake trigger payload (used to feed app_event triggers a sample).' } } },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_finalize',
            description: 'Mark the draft as finalised (is_draft=false). The automation remains INACTIVE until the user clicks Activate in the UI. Only call this after a successful dry-run.',
            parameters: { type: 'object', properties: {} },
        },
    },
];

// ── Apply mutations ─────────────────────────────────────

function applyTrigger(draft, args) {
    draft.trigger = { id: 'trg', type: 'trigger', kind: args.kind, output: {} };
    if (args.kind === 'schedule') draft.trigger.schedule = { cron: args.cron, tz: args.tz || 'Europe/Amsterdam' };
    if (args.kind === 'webhook') draft.trigger.webhook = {};
    if (args.kind === 'app_event') draft.trigger.appEvent = { provider: args.appProvider, event: args.appEvent, filter: args.filter || null };
    return { trigger: draft.trigger };
}

function appendAfter(draft, afterStepId, step) {
    const lastId = afterStepId || lastStepId(draft);
    draft.steps.push(step);
    draft.edges.push({ from: lastId, to: step.id });
    return step;
}

function applyAddAction(draft, args) {
    const { inputs, error } = validateAndFixBindings(args.inputs || {}, draft);
    if (error) return { error };
    const step = {
        id: newId('a'),
        type: 'integration_action',
        tool: args.tool,
        inputs,
        label: args.label || args.tool,
        sideEffect: isSideEffect(args.tool),
    };
    appendAfter(draft, args.afterStepId, step);
    return { added: step };
}

function applyAddAi(draft, args) {
    const { inputs, error } = validateAndFixBindings(args.inputs || {}, draft);
    if (error) return { error };
    const step = {
        id: newId('ai'),
        type: 'ai_step',
        prompt: args.prompt,
        // Optional override of the runner's default system prompt. When
        // omitted we use the safe baseline ("You are a step inside a
        // no-code automation..."). The user can edit this from the
        // inspector's Settings tab to set a tone or role.
        systemPrompt: typeof args.systemPrompt === 'string' && args.systemPrompt.trim() ? args.systemPrompt.trim() : null,
        inputs,
        outputSchema: args.outputSchema || null,
        // Default to 'auto' so the AI step honours the org's tier classifier
        // — same default as direct chat. Builder can override per step.
        modelTier: args.modelTier || 'auto',
        label: args.label || 'AI step',
        allowTools: !!args.allowTools,
        tools: Array.isArray(args.tools) ? args.tools.filter(t => typeof t === 'string') : null,
    };
    appendAfter(draft, args.afterStepId, step);
    return { added: step };
}

function applyAddCondition(draft, args) {
    const step = { id: newId('cond'), type: 'condition', expr: args.expr, label: args.label || 'Condition' };
    const lastId = args.afterStepId || lastStepId(draft);
    draft.steps.push(step);
    draft.edges.push({ from: lastId, to: step.id });
    if (args.thenStepId) draft.edges.push({ from: step.id, to: args.thenStepId, label: 'then' });
    if (args.elseStepId) draft.edges.push({ from: step.id, to: args.elseStepId, label: 'else' });
    return { added: step };
}

function applyAddLoop(draft, args) {
    // Sanitize child body steps: every child must have an id, type, and any
    // type-specific required fields. Missing ids would crash the runner with
    // a null step_id DB constraint.
    const rawBody = Array.isArray(args.body) ? args.body : [];
    const childErrors = [];
    const body = rawBody.map((child, idx) => {
        if (!child || typeof child !== 'object') return null;
        const fixed = { ...child };
        if (!fixed.id || typeof fixed.id !== 'string') fixed.id = newId('lb');
        if (!fixed.type || typeof fixed.type !== 'string') fixed.type = 'ai_step';
        if (fixed.inputs) {
            const v = validateAndFixBindings(fixed.inputs, draft);
            if (v.error) childErrors.push(`body[${idx}] (${fixed.id}): ${v.error}`);
            fixed.inputs = v.inputs;
        }
        return fixed;
    }).filter(Boolean);
    if (childErrors.length) return { error: childErrors.join(' ') };

    const step = {
        id: newId('loop'),
        type: 'loop',
        overRef: args.overRef,
        itemVar: args.itemVar,
        body,
        maxIterations: args.maxIterations || 100,
        label: args.label || `Loop over ${args.overRef}`,
    };
    appendAfter(draft, args.afterStepId, step);
    return { added: step };
}

function applyAddCode(draft, args) {
    const { inputs, error } = validateAndFixBindings(args.inputs || {}, draft);
    if (error) return { error };
    const step = {
        id: newId('code'),
        type: 'code',
        language: 'javascript',
        code: args.code,
        codeHash: crypto.createHash('sha256').update(args.code || '').digest('hex'),
        inputs,
        outputSchema: args.outputSchema || null,
        allowedTools: Array.isArray(args.allowedTools) ? args.allowedTools : [],
        limits: { cpuMs: 1000, memoryMb: 64, wallMs: 5000 },
        label: args.label || 'Custom code',
    };
    appendAfter(draft, args.afterStepId, step);
    return { added: step };
}

function applyAddNotification(draft, args) {
    const step = {
        id: newId('notif'),
        type: 'notification',
        title: args.title,
        body: args.body || '',
        channels: Array.isArray(args.channels) ? args.channels : ['notification'],
        label: args.label || 'Notify',
    };
    appendAfter(draft, args.afterStepId, step);
    return { added: step };
}

// ── n8n-style utility step appliers ─────────────────────

function applyAddSet(draft, args) {
    const { inputs: fields, error } = validateAndFixBindings(args.fields || {}, draft);
    if (error) return { error };
    const step = { id: newId('set'), type: 'set', fields, label: args.label || 'Edit fields' };
    appendAfter(draft, args.afterStepId, step);
    return { added: step };
}

function applyAddDateTime(draft, args) {
    const step = {
        id: newId('dt'),
        type: 'datetime',
        op: args.op,
        input: typeof args.input === 'string' ? args.input : undefined,
        input2: typeof args.input2 === 'string' ? args.input2 : undefined,
        amount: typeof args.amount === 'number' ? args.amount : undefined,
        format: typeof args.format === 'string' ? args.format : undefined,
        part: typeof args.part === 'string' ? args.part : undefined,
        unit: typeof args.unit === 'string' ? args.unit : undefined,
        label: args.label || 'Date & Time',
    };
    appendAfter(draft, args.afterStepId, step);
    return { added: step };
}

function applyAddWait(draft, args) {
    const step = { id: newId('wait'), type: 'wait', seconds: Math.max(1, Math.min(86400, Number(args.seconds) || 1)), label: args.label || 'Wait' };
    appendAfter(draft, args.afterStepId, step);
    return { added: step };
}

function applyAddStopError(draft, args) {
    const step = { id: newId('stop'), type: 'stop_error', message: args.message, label: args.label || 'Stop and error' };
    appendAfter(draft, args.afterStepId, step);
    return { added: step };
}

function applyAddSwitch(draft, args) {
    const step = {
        id: newId('sw'),
        type: 'switch',
        expr: args.expr,
        cases: Array.isArray(args.cases) ? args.cases.map(c => ({ name: c.name, value: c.value })) : [],
        defaultBranch: typeof args.defaultBranch === 'string' ? args.defaultBranch : null,
        label: args.label || 'Switch',
    };
    const lastId = args.afterStepId || lastStepId(draft);
    draft.steps.push(step);
    draft.edges.push({ from: lastId, to: step.id });
    // Wire any provided case targets in one shot.
    const next = args.nextStepIds || {};
    for (const caseName of Object.keys(next)) {
        const target = next[caseName];
        if (typeof target !== 'string') continue;
        const label = caseName === 'default' ? 'case:default' : `case:${caseName}`;
        draft.edges.push({ from: step.id, to: target, label, caseName });
    }
    return { added: step };
}

function applyAddFilter(draft, args) {
    const step = { id: newId('filt'), type: 'filter', arrayRef: args.arrayRef, expr: args.expr, label: args.label || 'Filter' };
    appendAfter(draft, args.afterStepId, step);
    return { added: step };
}

function applyAddLimit(draft, args) {
    const step = {
        id: newId('lim'),
        type: 'limit',
        arrayRef: args.arrayRef,
        count: Math.max(0, Math.floor(Number(args.count) || 0)),
        mode: args.mode === 'last' ? 'last' : 'first',
        label: args.label || 'Limit',
    };
    appendAfter(draft, args.afterStepId, step);
    return { added: step };
}

function applyAddDedupe(draft, args) {
    const step = { id: newId('ded'), type: 'dedupe', arrayRef: args.arrayRef, keyField: typeof args.keyField === 'string' ? args.keyField : undefined, label: args.label || 'Remove duplicates' };
    appendAfter(draft, args.afterStepId, step);
    return { added: step };
}

function applyAddAggregate(draft, args) {
    const step = { id: newId('agg'), type: 'aggregate', arrayRef: args.arrayRef, field: args.field, label: args.label || 'Aggregate' };
    appendAfter(draft, args.afterStepId, step);
    return { added: step };
}

function applyAddSummarize(draft, args) {
    const step = { id: newId('sum'), type: 'summarize', arrayRef: args.arrayRef, field: args.field, op: args.op, label: args.label || 'Summarize' };
    appendAfter(draft, args.afterStepId, step);
    return { added: step };
}

function applyRemoveStep(draft, args) {
    const id = args.stepId;
    draft.steps = draft.steps.filter(s => s.id !== id);
    draft.edges = draft.edges.filter(e => e.from !== id && e.to !== id);
    return { removed: id };
}

function applySetMetadata(draft, args) {
    if (typeof args.title === 'string') draft.title = args.title;
    if (typeof args.description === 'string') draft.description = args.description;
    return { title: draft.title, description: draft.description };
}

function applySummarise(draft) {
    const { summary, hasSideEffects } = summariseDefinition(draft);
    return { summary, hasSideEffects };
}

async function applyInspectTool(args, draftWrap) {
    const tool = args && typeof args.tool === 'string' ? args.tool : null;
    if (!tool) return { error: 'tool name required' };
    const shapeCache = require('./shapeCache');
    const { describeShape, getOutputSchema } = require('./outputSchemas');

    // Prefer runtime-cached shape (the source of truth from real runs).
    let shapeHint = null;
    let source = 'curated';
    try {
        const cached = await shapeCache.getShape({ userId: draftWrap.userId, toolName: tool });
        if (cached) {
            shapeHint = shapeCache.renderShapeHint(cached);
            source = 'runtime';
        }
    } catch (_) {}
    if (!shapeHint) {
        shapeHint = describeShape(tool);
    }
    if (!shapeHint) {
        return { tool, shape: null, source: 'unknown', note: 'No declared schema and no runtime sample. Run the tool once via dry-run / live to learn its shape, or just bind defensively.' };
    }
    const schema = getOutputSchema(tool);
    return { tool, shape: shapeHint, source, sample: schema?.sample ?? null };
}

// ── Public API ──────────────────────────────────────────

/**
 * Apply a tool call, mutating the in-memory draft. Returns a small JSON
 * report describing what changed (becomes the `tool` message back to the
 * LLM and feeds the SSE update to the frontend).
 */
/**
 * Build a tiny summary of the current draft's step IDs so every mutation
 * result reminds the LLM of the exact ids it must use for downstream
 * `afterStepId` / refs / template paths. Without this the model
 * fabricated short ids like "step_1" that didn't exist in the draft —
 * the dry-run then ran with broken bindings and the AI had to spend
 * extra iterations un-tangling its own mistake.
 */
function summariseDraftSteps(draft) {
    const list = [];
    if (draft?.trigger?.id) list.push({ id: draft.trigger.id, type: 'trigger', kind: draft.trigger.kind });
    for (const s of (draft?.steps || [])) {
        list.push({
            id: s.id,
            type: s.type,
            tool: s.tool || undefined,
            label: s.label || undefined,
        });
    }
    return list;
}

const MUTATING_TOOLS = new Set([
    'builder_propose_trigger', 'builder_add_action', 'builder_add_ai_step',
    'builder_add_condition', 'builder_add_loop', 'builder_add_code_step',
    'builder_add_notification', 'builder_remove_step', 'builder_set_metadata',
    // n8n-style utility nodes
    'builder_add_set', 'builder_add_datetime', 'builder_add_wait',
    'builder_add_stop_error', 'builder_add_switch',
    'builder_add_filter', 'builder_add_limit', 'builder_add_dedupe',
    'builder_add_aggregate', 'builder_add_summarize',
]);

async function applyToolCall(name, args, draftWrap) {
    const result = await _applyToolCallRaw(name, args, draftWrap);
    // For every mutation, append a `_draftSteps` reminder so the LLM has
    // the live id list in front of it on the next turn. Tools that read
    // (summarise/inspect/dry_run/finalize) don't need this — their own
    // result is already the relevant shape.
    if (MUTATING_TOOLS.has(name) && result && typeof result === 'object' && !result.error) {
        result._draftSteps = summariseDraftSteps(draftWrap.def);
    }
    // When a mutator rejected the call due to bad bindings, prefix the
    // error with a structured marker so the system prompt's "common
    // pitfalls" section catches the model's attention. Without this the
    // model sometimes ignores the error entirely and re-tries the same
    // call.
    if (result && typeof result === 'object' && result.error && !result._fixHint) {
        result._fixHint = 'Reject reason: invalid input binding. Fix the path/value and call the tool again. Refs MUST start with: trigger, steps, vars, secrets, loop.';
    }
    return result;
}

async function _applyToolCallRaw(name, args, draftWrap) {
    const draft = draftWrap.def;
    switch (name) {
        case 'builder_propose_trigger':    return applyTrigger(draft, args);
        case 'builder_add_action':         return applyAddAction(draft, args);
        case 'builder_add_ai_step':        return applyAddAi(draft, args);
        case 'builder_add_condition':      return applyAddCondition(draft, args);
        case 'builder_add_loop':           return applyAddLoop(draft, args);
        case 'builder_add_code_step':      return applyAddCode(draft, args);
        case 'builder_add_notification':   return applyAddNotification(draft, args);
        case 'builder_add_set':            return applyAddSet(draft, args);
        case 'builder_add_datetime':       return applyAddDateTime(draft, args);
        case 'builder_add_wait':           return applyAddWait(draft, args);
        case 'builder_add_stop_error':     return applyAddStopError(draft, args);
        case 'builder_add_switch':         return applyAddSwitch(draft, args);
        case 'builder_add_filter':         return applyAddFilter(draft, args);
        case 'builder_add_limit':          return applyAddLimit(draft, args);
        case 'builder_add_dedupe':         return applyAddDedupe(draft, args);
        case 'builder_add_aggregate':      return applyAddAggregate(draft, args);
        case 'builder_add_summarize':      return applyAddSummarize(draft, args);
        case 'builder_remove_step':        return applyRemoveStep(draft, args);
        case 'builder_set_metadata':       return applySetMetadata(draftWrap, args);
        case 'builder_summarise':          return applySummarise(draft);
        case 'builder_inspect_tool':       return applyInspectTool(args, draftWrap);
        case 'builder_request_dry_run': {
            const automation = await persistDraft(draftWrap);
            const runner = require('../core/automationRunner');
            const run = await runner.executeAutomation(automation, { triggerKind: 'dry_run', triggerPayload: args.triggerPayload || null, mode: 'dry_run' });
            const steps = await automationStore.getRunSteps(run.id);
            // Annotate each step with a top-level field hint so the AI
            // immediately sees what keys are available for binding.
            const shapeCache = require('./shapeCache');
            const annotated = steps.map(s => {
                const out = s.output;
                const topKeys = (out && typeof out === 'object' && !Array.isArray(out)) ? Object.keys(out) : null;
                const shapeHint = topKeys ? shapeCache.renderShapeHint(shapeCache.describeValue(out)) : null;
                return {
                    ...s,
                    _hint: {
                        outputType: Array.isArray(out) ? 'array' : (out === null ? 'null' : typeof out),
                        topKeys,
                        shape: shapeHint,
                    },
                };
            });
            return { run, steps: annotated };
        }
        case 'builder_finalize': {
            const automation = await persistDraft(draftWrap, { finalize: true });
            return { automation };
        }
        default:
            return { error: `Unknown builder tool: ${name}` };
    }
}

/**
 * Persist the draft to the automations table. Creates a row on the first
 * call and updates thereafter. Setting `finalize:true` flips is_draft to
 * false (still inactive — user must Activate explicitly).
 */
async function persistDraft(draftWrap, { finalize = false } = {}) {
    const def = draftWrap.def;
    const validation = validateDefinition(def);
    const triggerType = def.trigger?.kind || 'manual';
    const scheduleCron = def.trigger?.schedule?.cron || null;
    const scheduleTz = def.trigger?.schedule?.tz || 'Europe/Amsterdam';

    if (!draftWrap.automationId) {
        // Create a draft row.
        const a = await automationStore.createAutomation({
            userId: draftWrap.userId,
            organizationId: draftWrap.orgId || null,
            title: draftWrap.title || 'Untitled automation',
            description: draftWrap.description || '',
            definition: def,
            triggerType,
            scheduleCron,
            scheduleTz,
            createdFromChatId: draftWrap.builderSessionId,
        });
        draftWrap.automationId = a.id;
        if (finalize) {
            return automationStore.updateAutomation(a.id, { isDraft: false }, draftWrap.userId);
        }
        return a;
    }
    // Update existing draft row.
    const updates = {
        title: draftWrap.title || undefined,
        description: draftWrap.description || undefined,
        definition: def,
        triggerType,
        scheduleCron,
        scheduleTz,
    };
    if (finalize) updates.isDraft = false;
    const u = await automationStore.updateAutomation(draftWrap.automationId, updates, draftWrap.userId);
    if (!validation.ok) {
        // Persist anyway (it's a draft) but expose the errors to the caller.
        u.validationErrors = validation.errors;
    }
    return u;
}

module.exports = {
    TOOL_SCHEMAS, applyToolCall, persistDraft, emptyDefinition,
    TRIGGER_FIELDS_BY_EVENT, TRIGGER_OUTPUT_SAMPLES, buildTriggerOutputsCatalog,
    _test_validateAndFixBindings: validateAndFixBindings,
};
