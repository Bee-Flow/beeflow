/**
 * Builder-agent tool schemas (§WS5, extracted verbatim from builderTools.js).
 * NOTE: applyToolCall mutates this array in place (scope/forEach/error-branch
 * injection) via the imported reference — same object, so the mutation is shared.
 */

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
                    kind: { type: 'string', enum: ['schedule', 'manual', 'webhook', 'app_event', 'agent_call'] },
                    cron: { type: 'string', description: 'Standard 5-field cron, REQUIRED when kind=schedule. Use exact format: minute hour day-of-month month day-of-week. Example: "0 9 * * 1" = every Monday at 9:00.' },
                    tz: { type: 'string', description: 'IANA timezone, e.g. Europe/Amsterdam (when kind=schedule).' },
                    appProvider: { type: 'string', description: 'Provider id (when kind=app_event): gmail | google-calendar | google-drive | nextcloud | ticket-assistant' },
                    appEvent: { type: 'string', description: 'Event name (when kind=app_event). Allowed: gmail.{mail.new, label.added}; google-calendar.{event.changed, event.upcoming}; google-drive.file.new; nextcloud.{file.new, file.changed, file.deleted, file.renamed, file.commented, file.tagged, share.created, share.received, share.accepted, share.deleted, calendar.event.created, calendar.event.changed, calendar.event.deleted, calendar.event.upcoming, deck.card.created, deck.card.changed, deck.card.deleted, deck.card.moved, deck.card.completed, talk.message.received, talk.mention.received, task.created, task.completed, task.due, activity.new, notification.new, user.status.changed}; ticket-assistant.{ticket.new, sync.completed}.' },
                    filter: { type: 'object', description: 'Optional filter object that must shallowly match the event payload.' },
                    // §28 agent-callable trigger: routine is exposed as a tool the agent / direct chat can invoke.
                    toolName: { type: 'string', description: 'When kind=agent_call: the tool name agents will see (sanitised to [a-z0-9_]). Defaults to automation_<id>.' },
                    parametersSchema: { type: 'object', description: 'When kind=agent_call: JSON-schema-shaped input declaration for the tool. The runtime exposes this verbatim to the model.' },
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
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
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
            description: `Append an AI reasoning step that transforms or summarises upstream data. By default no tool calls — set allowTools:true (and optionally a tools allowlist) when this step needs to fetch data on its own (web search, Gmail lookup, etc.). The user's per-org integration permissions are still enforced at runtime. Use this for: extracting structured fields from text, summarising, classifying, drafting reply text, OR (with allowTools) free-form research that doesn't fit a static integration_action. Split your instructions: put the role/persona/tone/output-style in \`systemPrompt\` and the concrete per-run task + data references in \`prompt\`. ${BINDING_HINT} EXAMPLE — extract invoice fields: {systemPrompt:"You are a meticulous bookkeeping assistant. Respond only with valid JSON.",prompt:"Extract amount, currency, vendor, dueDate from this invoice email.",inputs:{emailBody:{kind:"ref",path:"loop.email.body"}},outputSchema:{type:"object",properties:{amount:{type:"number"},currency:{type:"string"},vendor:{type:"string"},dueDate:{type:"string"}}},modelTier:"fast"}.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    systemPrompt: { type: 'string', description: 'Optional. The role/persona/output-style instruction for the AI (the system prompt) — e.g. "You are a meticulous financial analyst. Always answer in Dutch." Put WHO the model is and HOW it should behave here; put WHAT to do this run (the task + data references) in `prompt`. Omit for trivial one-off transforms to use the default automation-step system prompt.' },
                    prompt: { type: 'string', description: 'The task instruction for this run. Reference the inputs by name. Put persona/tone/output-style in `systemPrompt`, not here.' },
                    inputs: { type: 'object', description: `Map of binding-name to a binding object. ${BINDING_HINT}` },
                    outputSchema: { type: 'object', description: 'JSON schema describing the desired structured output. Strongly recommended so downstream steps can reference fields.' },
                    modelTier: { type: 'string', enum: ['auto', 'fast', 'standard', 'thinking'], description: 'Default: auto (mirrors direct chat — classifier picks fast/standard/thinking based on prompt complexity).' },
                    allowTools: { type: 'boolean', description: 'Default false. When true the AI step can call the user\'s integration tools (web search, gmail_search, etc.). Use sparingly — most steps should bind upstream integration_action output instead.' },
                    tools: { type: 'array', items: { type: 'string' }, description: 'Optional allowlist of tool names the AI step may call. Empty / omitted = whatever allowTools dictates.' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
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
            description: 'Append an if/else branch. The expr is a restricted JS expression — supports member access, comparisons, &&, ||, ?:, math. NO function calls. EXAMPLES: "steps.parse.output.amount > 1000", "steps.s1.output.count == 0", "loop.email.subject == \\"Urgent\\"". To grow a branch, call builder_add_action / builder_add_ai_step / builder_add_notification with afterStepId set to this condition\'s id — the edge is AUTO-labelled "then" on the first append and "else" on the second. Pass branch:"then"|"else" on that call to be explicit. Use thenStepId/elseStepId here only to wire EXISTING steps as branches.',
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
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
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
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
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
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
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
            name: 'builder_create_layer',
            description: 'Create an inline Flowlet — a named, reusable sub-flow stored INSIDE this automation (definition.layers). The skeleton is a layer_input trigger (declaring the input params) wired to a layer_output "Return" step. Workflow: 1) builder_create_layer → returns {layerKey}; 2) populate it by calling the normal builder_add_* tools with scope:"<layerKey>"; 3) bind its outputs in the layer_output step (builder_set_layer_contract outputFields); 4) run it from the main flow via builder_add_call_layer. Inside a flowlet, bind inputs as trigger.output.<param>.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Human-readable flowlet name (the key is derived from it).' },
                    params: {
                        type: 'array',
                        description: 'Input contract. Each param is available inside the flowlet as trigger.output.<name>.',
                        items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string', description: 'string | number | boolean | object | array (informational).' }, required: { type: 'boolean' } }, required: ['name'] },
                    },
                },
                required: ['title'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_set_layer_contract',
            description: 'Update a flowlet\'s contract. `params` replaces the layer_input trigger params (inputs the caller must bind). Set the flowlet\'s RETURN value with `outputs`: a map of fieldName → binding that writes the layer_output ("Return") step directly — this is THE way a flowlet returns data; never add a separate `set`/return step to hold it. (`outputFields` is a legacy alternative that only declares the key set, leaving bindings empty.) The flowlet already contains exactly one layer_output step — these args edit it in place.',
            parameters: {
                type: 'object',
                properties: {
                    layerKey: { type: 'string', description: 'Key in definition.layers.' },
                    params: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, required: { type: 'boolean' } }, required: ['name'] } },
                    outputs: { type: 'object', description: 'Map of return-field name → binding, e.g. { "invoices": { "kind":"ref", "path":"steps.agg1.output.values" } }. Declares AND binds each field on the layer_output step in one call.' },
                    outputFields: { type: 'array', items: { type: 'string' }, description: 'Legacy: declare return field NAMES only (bindings start empty). Prefer `outputs` so the flowlet actually returns data.' },
                },
                required: ['layerKey'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_generate_layer',
            description: 'DELEGATE building a whole flowlet to a focused sub-agent (thinking model). Give it a clear `instruction` describing what the flowlet should do, plus its `params` (inputs) and `outputFields` (what it returns). The sub-agent creates the flowlet and builds every step inside it, then returns {layerKey, outputFields, summary}. Prefer this over hand-building a non-trivial flowlet step-by-step. After it returns, wire the flowlet into the main flow with builder_add_call_layer({layerKey, inputs:{...}}) and bind its results as steps.<callId>.output.<field>.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Human-readable flowlet name.' },
                    instruction: { type: 'string', description: 'Precise description of what this flowlet must do (the sub-agent builds it end to end).' },
                    params: { type: 'array', description: 'Inputs the flowlet accepts (bound by the caller; seen inside as trigger.output.<name>).', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, required: { type: 'boolean' } }, required: ['name'] } },
                    outputFields: { type: 'array', items: { type: 'string' }, description: 'Field names the flowlet should return.' },
                },
                required: ['title', 'instruction'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_generate_layers',
            description: 'DELEGATE building SEVERAL independent flowlets AT ONCE — up to 3 sub-agents (thinking model) run in parallel, one per flowlet. Use this when a complex automation decomposes into multiple reusable sub-flows that do NOT depend on each other. Each entry needs a `title` + `instruction` (+ optional params/outputFields). Returns the built flowlets with their keys + outputFields; wire each into the main flow with builder_add_call_layer afterwards. The flowlets must be independent — a flowlet here may reference only PRE-EXISTING flowlets, not its siblings in this same call.',
            parameters: {
                type: 'object',
                properties: {
                    layers: {
                        type: 'array',
                        description: 'The flowlets to build in parallel (max 3 run concurrently; more queue).',
                        items: {
                            type: 'object',
                            properties: {
                                title: { type: 'string' },
                                instruction: { type: 'string', description: 'What this flowlet must do.' },
                                params: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, required: { type: 'boolean' } }, required: ['name'] } },
                                outputFields: { type: 'array', items: { type: 'string' } },
                            },
                            required: ['title', 'instruction'],
                        },
                    },
                },
                required: ['layers'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_set_plan',
            description: 'Record (and update) your own to-do list for building this automation, shown to the user as a live checklist. Call this FIRST for any multi-step build, then call it again with the SAME list and updated `done` flags as you complete each item. Always re-send the WHOLE list (it replaces the previous one). This does not change the automation — it just tracks your plan.',
            parameters: {
                type: 'object',
                properties: {
                    todos: {
                        type: 'array',
                        description: 'The full ordered checklist. Re-send it entirely each time, flipping `done` as you go.',
                        items: { type: 'object', properties: { text: { type: 'string', description: 'Short task description.' }, done: { type: 'boolean', description: 'true once completed.' } }, required: ['text'] },
                    },
                },
                required: ['todos'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_call_layer',
            description: `Append a "call_layer" step that runs one of this automation's inline flowlets (definition.layers) and returns its layer_output fields, bindable downstream as steps.<id>.output.<field>. Provide the layerKey plus an inputs map binding each declared flowlet param (the flowlet sees them as trigger.output.<param>). ${BINDING_HINT} Recursion is rejected — a flowlet cannot (transitively) call itself. Use scope to place the call INSIDE another flowlet (sibling calls are allowed).`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    layerKey: { type: 'string', description: 'Key of the flowlet in definition.layers (create one via builder_create_layer).' },
                    inputs: { type: 'object', description: `Map of flowlet-param → binding. ${BINDING_HINT}` },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['layerKey'],
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
            description: 'Append a multi-way branch. Evaluates expr and routes to the first matching case. Each case is { name, value }. Wire each case to its next step by passing nextStepIds: { "<caseName>": "<stepId>", "default": "<stepId>" }. EXAMPLE: {expr:"trigger.output.priority",cases:[{name:"urgent",value:"high"},{name:"normal",value:"medium"}],defaultBranch:"fallback"}. To grow a case branch by appending a NEW step, call an add tool with afterStepId set to this switch\'s id AND caseName set to the case it belongs to — otherwise the edge is unlabelled and that case dead-ends.',
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
            name: 'builder_add_array_op',
            description: `Append an array operation step. Single entry point for filter / limit / dedupe / aggregate / summarize — pick \`op\` and supply the matching fields. Preferred over the five individual builder_add_{filter,limit,dedupe,aggregate,summarize} tools (which still work but are legacy).

OPS:
  - filter:    keep items matching expr.    Required: arrayRef, expr.        Output: { items, count }.
  - limit:     first/last N items.          Required: arrayRef, count.       Optional: mode ("first"|"last"). Output: { items, count }.
  - dedupe:    drop duplicates.             Required: arrayRef.               Optional: keyField (dedup by that field; else deep equality). Output: { items, removed }.
  - aggregate: pull one field across items. Required: arrayRef, field.       Output: { values, count }.
  - summarize: numeric stats over a field.  Required: arrayRef, field, fn.   fn ∈ sum|count|avg|min|max. Output: { result, op, count }.

arrayRef is a path string (e.g. "steps.search.output.results"), NOT a binding object. EXAMPLE: {op:"filter",arrayRef:"steps.search.output.results",expr:"item.amount > 1000"}.`,
            parameters: {
                type: 'object',
                properties: {
                    op: { type: 'string', enum: ['filter', 'limit', 'dedupe', 'aggregate', 'summarize'] },
                    afterStepId: { type: 'string' },
                    arrayRef: { type: 'string', description: 'Dotted path to an upstream array, e.g. "steps.search.output.results".' },
                    expr: { type: 'string', description: 'filter only: restricted JS expression referencing item.<field>.' },
                    count: { type: 'integer', description: 'limit only: how many items to keep.' },
                    mode: { type: 'string', enum: ['first', 'last'], description: 'limit only: default "first".' },
                    keyField: { type: 'string', description: 'dedupe only: field to dedup by; omit for deep-equality dedup.' },
                    field: { type: 'string', description: 'aggregate and summarize: field name on each item.' },
                    fn: { type: 'string', enum: ['sum', 'count', 'avg', 'min', 'max'], description: 'summarize only: which statistic to compute.' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['op', 'arrayRef'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_wire_error_branch',
            description: 'Wire an on-error branch between two EXISTING steps: adds an edge {from, to, label:"on_error"} so that when fromStepId fails (after exhausting its per-step retries), the run continues at toStepId instead of failing. Inside the branch, bind the failure via steps.<fromStepId>.error.message / .errorClass. A run whose failures are all handled this way still reports success ("N step error(s) handled"). Only failure-capable steps may have an error branch: integration_action, ai_step, code, call_layer, loop, parallel, notification, wait — NOT trigger/condition/switch/approval/stop_error. To create a NEW step directly on the error branch, instead call builder_add_action / builder_add_ai_step / etc. with afterStepId=<failing step> and branch:"error".',
            parameters: {
                type: 'object',
                properties: {
                    fromStepId: { type: 'string', description: 'The step whose failure should be handled (must already exist).' },
                    toStepId: { type: 'string', description: 'The existing step the run continues at when fromStepId fails.' },
                },
                required: ['fromStepId', 'toStepId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_remove_step',
            description: 'Remove a step from the draft by id. By default (reconnect:true) the step\'s predecessors are bridged to its successors so the flow stays connected (deleting a step mid-chain keeps the chain wired, preserving branch labels). Pass reconnect:false to just sever the step and drop its incident edges. To CHANGE a step rather than delete it, use builder_update_step / builder_replace_step instead — recreating mints a new id and breaks downstream references.',
            parameters: { type: 'object', properties: { stepId: { type: 'string' }, reconnect: { type: 'boolean', description: 'Default true: bridge predecessors→successors after removal so the flow stays connected. false: just drop the step and its edges.' } }, required: ['stepId'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_update_step',
            description: `Update an EXISTING step in place by id WITHOUT removing and re-adding it — keeps the step id and ALL wiring (incoming/outgoing edges, branch labels, forEach), so downstream steps.<id>.output.* references keep working. ALWAYS prefer this over remove+add when editing a step. Patch is partial: only the fields you pass change. Cannot change a step's type (use builder_replace_step). inputs/fields MERGE key-by-key by default (pass a key value of null to delete just that key; pass inputsMode:"replace" to overwrite the whole map). ${BINDING_HINT} EXAMPLE — retarget an AI step's model and tweak its prompt: {stepId:"ai_1a2b3c",patch:{modelTier:"thinking",prompt:"Summarise concisely in Dutch."}}.`,
            parameters: {
                type: 'object',
                properties: {
                    stepId: { type: 'string', description: 'Id of the step to update (root flow, a flowlet via scope, or a loop-body step).' },
                    patch: { type: 'object', description: 'Fields to change. Allowed keys depend on the step type (ai_step: prompt, systemPrompt, inputs, outputSchema, modelTier, allowTools, tools, label, forEach; integration_action: tool, inputs, label, forEach; condition: expr, label; switch: expr, cases, defaultBranch, label; code: code, inputs, outputSchema, allowedTools, label, forEach; set: fields, label, forEach; notification: title, body, channels, label, forEach; loop: overRef, itemVar, maxIterations, label; call_layer: inputs, label; datetime/wait/stop_error/filter/limit/dedupe/aggregate/summarize: their own fields + label). Do NOT pass `type` or `id`.' },
                    inputsMode: { type: 'string', enum: ['merge', 'replace'], description: 'How to apply patch.inputs / patch.fields. Default "merge" (per-key; value null deletes that key). "replace" overwrites the whole map.' },
                },
                required: ['stepId', 'patch'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_update_steps',
            description: 'Apply several step patches in one call (each entry is like builder_update_step: {stepId, patch, inputsMode?}). All-or-nothing: if any patch fails validation, NONE are applied.',
            parameters: {
                type: 'object',
                properties: {
                    updates: {
                        type: 'array',
                        description: 'List of patches to apply, each {stepId, patch, inputsMode?}.',
                        items: { type: 'object', properties: { stepId: { type: 'string' }, patch: { type: 'object' }, inputsMode: { type: 'string', enum: ['merge', 'replace'] } }, required: ['stepId', 'patch'] },
                    },
                },
                required: ['updates'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_replace_step',
            description: 'Replace an existing step\'s TYPE in place, keeping its id and surrounding wiring so downstream steps.<id>.output.* references survive. Provide the full new spec exactly as you would to builder_add_<newType> (omit afterStepId/branch/caseName — position is inherited). Replacing a branching step (condition/switch) with a non-branching one, or vice-versa, rewrites the outgoing branch edges; the result includes a `rewired` note telling you what to finish wiring. For a same-type field change use builder_update_step instead.',
            parameters: {
                type: 'object',
                properties: {
                    stepId: { type: 'string' },
                    newType: { type: 'string', enum: ['integration_action', 'ai_step', 'condition', 'switch', 'code', 'notification', 'set', 'datetime', 'wait', 'stop_error', 'filter', 'limit', 'dedupe', 'aggregate', 'summarize', 'call_layer', 'loop'] },
                    spec: { type: 'object', description: 'Full field set for the new type (same shape as the matching builder_add_<type> args, excluding afterStepId/branch/caseName/scope).' },
                },
                required: ['stepId', 'newType', 'spec'],
            },
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
            description: 'Look up an integration tool\'s EXACT input params AND output shape. The catalog only lists names + an input count, so call this BEFORE adding any action with required inputs (to bind the right param names) or whose output you need to chain (to know whether the field is "results"/"items"/"events"). Returns `inputs` ({name:{type,required,description?,enum?}}), `requiredInputs`, and a one-line output `shape` (sourced from runtime samples when available, else the curated schema).',
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


module.exports = { TOOL_SCHEMAS };
