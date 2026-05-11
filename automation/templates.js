/**
 * Curated automation templates surfaced in the Routines studio gallery.
 *
 * Each template has:
 *   - id            stable slug used for analytics + bookmarking
 *   - title         short name shown on the card
 *   - description   one-line "what does it do" the user reads to decide
 *   - category      groups templates in the gallery sidebar
 *   - icon          lucide icon name (frontend resolves at render time)
 *   - tags          quick-pick filter chips
 *   - definition    the full automation definition the builder loads when
 *                   the user picks the template — same shape as anything
 *                   the AI builder produces, validated server-side via
 *                   validateDefinition before activation
 *
 * Templates are static config; new ones land here via PR. Once the
 * library grows past ~50 entries we'll move to a DB table with admin UI
 * (Phase 5+ in the roadmap).
 */

function step(id, type, extras) { return { id, type, ...extras }; }

const TEMPLATES = [
    // ── Files / docs ──────────────────────────────────────────────────
    {
        id: 'nc-invoice-inbox',
        title: 'Invoice inbox',
        description: 'Email arrives with PDF attachment → extract metadata → upload to Nextcloud /Invoices folder.',
        category: 'Files',
        icon: 'FileText',
        tags: ['gmail', 'nextcloud', 'ai'],
        definition: {
            trigger: { id: 'trg', type: 'trigger', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new', filter: { hasAttachment: true, subjectContains: 'invoice' } } },
            steps: [
                step('extract', 'ai_step', { prompt: 'Extract amount, currency, vendor and dueDate from this email. Return JSON.', inputs: { body: { kind: 'ref', path: 'trigger.output.snippet' } }, outputSchema: { type: 'object', properties: { amount: { type: 'number' }, currency: { type: 'string' }, vendor: { type: 'string' }, dueDate: { type: 'string' } } } }),
                step('upload', 'integration_action', { tool: 'nextcloud_upload_file', label: 'Upload to /Invoices', inputs: { path: { kind: 'literal', value: '/Invoices/{{trigger.output.subject}}.pdf' }, content: { kind: 'ref', path: 'trigger.output.attachments.0.data' } } }),
            ],
            edges: [{ from: 'trg', to: 'extract' }, { from: 'extract', to: 'upload' }],
        },
    },
    {
        id: 'nc-pdf-summarise',
        title: 'PDF summary',
        description: 'When a PDF lands anywhere under /Documents, summarise it and post a Talk message.',
        category: 'Files',
        icon: 'FileSearch',
        tags: ['nextcloud', 'ai', 'talk'],
        definition: {
            trigger: { id: 'trg', type: 'trigger', kind: 'app_event', appEvent: { provider: 'nextcloud', event: 'file.new', filter: { inFolder: '/Documents/', extension: 'pdf' } } },
            steps: [
                step('read', 'integration_action', { tool: 'nextcloud_read_file', label: 'Read PDF', inputs: { path: { kind: 'ref', path: 'trigger.output.path' } } }),
                step('summarise', 'ai_step', { prompt: 'Summarise this document in 3 sentences.', inputs: { content: { kind: 'ref', path: 'steps.read.output.content' } } }),
                step('notify', 'integration_action', { tool: 'nextcloud_talk_send_message', label: 'Post to Talk', inputs: { roomToken: { kind: 'literal', value: '' }, message: { kind: 'ref', path: 'steps.summarise.output' } } }),
            ],
            edges: [{ from: 'trg', to: 'read' }, { from: 'read', to: 'summarise' }, { from: 'summarise', to: 'notify' }],
        },
    },

    // ── Calendar / scheduling ─────────────────────────────────────────
    {
        id: 'nc-meeting-prep',
        title: 'Meeting prep',
        description: '15 minutes before each calendar event → AI writes a short briefing referencing recent emails with attendees.',
        category: 'Calendar',
        icon: 'CalendarClock',
        tags: ['nextcloud', 'calendar', 'ai'],
        definition: {
            trigger: { id: 'trg', type: 'trigger', kind: 'app_event', appEvent: { provider: 'nextcloud', event: 'calendar.event.upcoming', filter: { leadMinutes: 15 } } },
            steps: [
                step('brief', 'ai_step', { prompt: 'Write a 5-line meeting briefing for "{{trigger.output.summary}}" at {{trigger.output.startsAt}}. Skip pleasantries.', allowTools: true }),
                step('notify', 'notification', { title: 'Meeting in 15 min', body: { kind: 'ref', path: 'steps.brief.output' } }),
            ],
            edges: [{ from: 'trg', to: 'brief' }, { from: 'brief', to: 'notify' }],
        },
    },

    // ── Approvals / governance ────────────────────────────────────────
    {
        id: 'nc-share-approval',
        title: 'External share approval',
        description: 'Someone shares a folder externally → AI judges sensitivity → ask owner to approve before the share goes live.',
        category: 'Governance',
        icon: 'ShieldCheck',
        tags: ['nextcloud', 'approval', 'ai'],
        definition: {
            trigger: { id: 'trg', type: 'trigger', kind: 'app_event', appEvent: { provider: 'nextcloud', event: 'share.created', filter: { shareType: 'link' } } },
            steps: [
                step('judge', 'ai_step', { prompt: 'Given a file path, classify sensitivity as low/medium/high. Path: {{trigger.output.path}}. Return JSON {sensitivity, reason}.', outputSchema: { type: 'object', properties: { sensitivity: { type: 'string' }, reason: { type: 'string' } } } }),
                step('approve', 'approval', { prompt: 'A new public share was created for "{{trigger.output.path}}". AI judged it: {{steps.judge.output.sensitivity}} ({{steps.judge.output.reason}}). Approve to keep, reject to delete.', title: 'External share approval' }),
                step('revoke', 'integration_action', { tool: 'nextcloud_share_delete', label: 'Revoke if rejected', inputs: { shareId: { kind: 'ref', path: 'trigger.output.shareId' } } }),
            ],
            edges: [{ from: 'trg', to: 'judge' }, { from: 'judge', to: 'approve' }, { from: 'approve', to: 'revoke' }],
        },
    },

    // ── Talk / chat ───────────────────────────────────────────────────
    {
        id: 'nc-mention-tracker',
        title: 'Mention digest',
        description: 'When @-mentioned in any Talk room, capture context and email a daily digest.',
        category: 'Talk',
        icon: 'MessageSquare',
        tags: ['nextcloud', 'talk', 'ai'],
        definition: {
            trigger: { id: 'trg', type: 'trigger', kind: 'app_event', appEvent: { provider: 'nextcloud', event: 'talk.mention.received' } },
            steps: [
                step('store', 'integration_action', { tool: 'nextcloud_notes_create', label: 'Append to Mentions note', inputs: { title: { kind: 'literal', value: 'Mentions log' }, content: { kind: 'literal', value: '{{trigger.output.datetime}} — {{trigger.output.actor}}: {{trigger.output.message}}' } } }),
            ],
            edges: [{ from: 'trg', to: 'store' }],
        },
    },

    // ── Deck (kanban) ─────────────────────────────────────────────────
    {
        id: 'nc-deck-done-celebrate',
        title: 'Card moved to Done',
        description: 'When a Deck card moves into a Done stack → post a celebration in the linked Talk room.',
        category: 'Deck',
        icon: 'Trophy',
        tags: ['nextcloud', 'deck', 'talk'],
        definition: {
            trigger: { id: 'trg', type: 'trigger', kind: 'app_event', appEvent: { provider: 'nextcloud', event: 'deck.card.completed' } },
            steps: [
                step('post', 'integration_action', { tool: 'nextcloud_talk_send_message', label: 'Celebrate in Talk', inputs: { roomToken: { kind: 'literal', value: '' }, message: { kind: 'literal', value: '🎉 "{{trigger.output.title}}" is done!' } } }),
            ],
            edges: [{ from: 'trg', to: 'post' }],
        },
    },

    // ── Cross-app + parallel ──────────────────────────────────────────
    {
        id: 'nc-onboarding',
        title: 'New employee onboarding',
        description: 'When a user is added to a group → in parallel: create welcome folder, send Talk welcome, schedule intro meeting.',
        category: 'Cross-app',
        icon: 'UserPlus',
        tags: ['nextcloud', 'parallel'],
        definition: {
            trigger: { id: 'trg', type: 'trigger', kind: 'app_event', appEvent: { provider: 'nextcloud', event: 'activity.new', filter: { type: 'group_added' } } },
            steps: [
                step('parallel', 'parallel', {
                    branches: [
                        [step('mkdir', 'integration_action', { tool: 'nextcloud_create_folder', inputs: { path: { kind: 'literal', value: '/Welcome/{{trigger.output.actor}}' } } })],
                        [step('greet', 'integration_action', { tool: 'nextcloud_talk_send_message', inputs: { roomToken: { kind: 'literal', value: '' }, message: { kind: 'literal', value: 'Welcome to the team @{{trigger.output.actor}}!' } } })],
                        [step('meet', 'integration_action', { tool: 'nextcloud_calendar_create_event', inputs: { summary: { kind: 'literal', value: 'Intro chat' }, startsAt: { kind: 'literal', value: '+1d' } } })],
                    ],
                }),
            ],
            edges: [{ from: 'trg', to: 'parallel' }],
        },
    },

    // ── Webpages ──────────────────────────────────────────────────────
    {
        id: 'webpage-invoice-sync',
        title: 'Sync invoices to a webapp',
        description: 'New invoice email arrives → extract fields → append a row to your invoice webapp\'s data.db. Pick the webpage in Quick mode before activating.',
        category: 'Webpages',
        icon: 'Database',
        tags: ['gmail', 'webpages', 'ai'],
        definition: {
            trigger: { id: 'trg', type: 'trigger', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new', filter: { hasAttachment: true, subjectContains: 'invoice' } } },
            steps: [
                step('read', 'integration_action', { tool: 'gmail_read_attachment', label: 'Read invoice PDF', inputs: { messageId: { kind: 'ref', path: 'trigger.output.messageId' } } }),
                step('extract', 'ai_step', {
                    prompt: 'Extract the invoice fields from this attachment text. Return JSON with keys: factuurnummer, datum (YYYY-MM-DD), type, product, liters (number or null), excl_btw (number), btw (number), incl_btw (number), status. If a field is missing leave it null.',
                    inputs: { text: { kind: 'ref', path: 'steps.read.output.text' } },
                    outputSchema: { type: 'object', properties: {
                        factuurnummer: { type: 'string' }, datum: { type: 'string' }, type: { type: 'string' },
                        product: { type: 'string' }, liters: { type: 'number' },
                        excl_btw: { type: 'number' }, btw: { type: 'number' }, incl_btw: { type: 'number' },
                        status: { type: 'string' },
                    } },
                }),
                step('insert', 'integration_action', {
                    tool: 'webpage_db_exec',
                    label: 'Append invoice row',
                    inputs: {
                        webpageId: { kind: 'literal', value: '' },
                        sql: { kind: 'literal', value: 'INSERT INTO facturen (id, datum, type, product, liters, excl_btw, btw, incl_btw, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING' },
                        params: { kind: 'expr', value: '[steps.extract.output.factuurnummer, steps.extract.output.datum, steps.extract.output.type, steps.extract.output.product, steps.extract.output.liters, steps.extract.output.excl_btw, steps.extract.output.btw, steps.extract.output.incl_btw, steps.extract.output.status]' },
                    },
                }),
            ],
            edges: [{ from: 'trg', to: 'read' }, { from: 'read', to: 'extract' }, { from: 'extract', to: 'insert' }],
        },
    },

    // ── Schedule-based ────────────────────────────────────────────────
    {
        id: 'nc-weekly-digest',
        title: 'Weekly Nextcloud digest',
        description: 'Every Monday 9am → AI summarises last week\'s file activity and posts to your default Talk room.',
        category: 'Cross-app',
        icon: 'Sparkles',
        tags: ['nextcloud', 'schedule', 'ai'],
        definition: {
            trigger: { id: 'trg', type: 'trigger', kind: 'schedule', schedule: { cron: '0 9 * * 1', tz: 'Europe/Amsterdam' } },
            steps: [
                step('fetch', 'integration_action', { tool: 'nextcloud_activity_list', inputs: { limit: { kind: 'literal', value: 100 } } }),
                step('summarise', 'ai_step', { prompt: 'Summarise this week of activity for the team in 5 bullets. Highlight risks and notable shares.', inputs: { activity: { kind: 'ref', path: 'steps.fetch.output' } } }),
                step('post', 'integration_action', { tool: 'nextcloud_talk_send_message', inputs: { roomToken: { kind: 'literal', value: '' }, message: { kind: 'ref', path: 'steps.summarise.output' } } }),
            ],
            edges: [{ from: 'trg', to: 'fetch' }, { from: 'fetch', to: 'summarise' }, { from: 'summarise', to: 'post' }],
        },
    },
];

const CATEGORIES = Array.from(new Set(TEMPLATES.map(t => t.category)));

function listTemplates() {
    return TEMPLATES.map(t => ({
        id: t.id,
        title: t.title,
        description: t.description,
        category: t.category,
        icon: t.icon,
        tags: t.tags,
    }));
}

function getTemplate(id) {
    return TEMPLATES.find(t => t.id === id) || null;
}

module.exports = { listTemplates, getTemplate, CATEGORIES };
