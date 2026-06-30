/**
 * Integration Tool Map — Maps tool names to their integration metadata.
 *
 * This centralized mapping identifies which tools are "external integrations"
 * and records the server/endpoint they connect to, the data direction,
 * and what categories of data they typically handle.
 *
 * Used by the tool dispatcher in chatStream.js / directChat.js to decide
 * whether a tool call should be logged in the integration_activity_log.
 *
 * ── Auto-Detection ──────────────────────────────────────────────────
 * Any tool whose name prefix matches an INTEGRATION_PREFIX entry is
 * automatically treated as an integration tool — no manual registration
 * needed. The static INTEGRATION_TOOL_MAP provides optional overrides
 * for server endpoints, data categories, and direction.
 * New integrations and MCP servers are detected automatically.
 */

// ── Prefix → Integration metadata (auto-detection) ──────────────────
// When a tool's prefix matches one of these, it's automatically logged
// as an integration tool. New integrations just need a prefix entry here.
const INTEGRATION_PREFIXES = {
    // Google Workspace
    gmail_:         { integration: 'gmail',           label: 'Gmail',               server: 'gmail.googleapis.com' },
    calendar_:      { integration: 'google_calendar', label: 'Google Calendar',     server: 'www.googleapis.com/calendar' },
    drive_:         { integration: 'google_drive',    label: 'Google Drive',        server: 'www.googleapis.com/drive' },
    docs_:          { integration: 'google_docs',     label: 'Google Docs',         server: 'docs.googleapis.com' },
    contacts_:      { integration: 'google_contacts', label: 'Google Contacts',     server: 'people.googleapis.com' },
    keep_:          { integration: 'google_keep',     label: 'Google Keep',         server: 'keep.googleapis.com' },
    groups_:        { integration: 'google_groups',   label: 'Google Groups',       server: 'www.googleapis.com/groups' },

    // Microsoft 365
    outlook_:       { integration: 'outlook',         label: 'Outlook',             server: 'graph.microsoft.com' },
    ms_calendar_:   { integration: 'ms_calendar',     label: 'Microsoft Calendar',  server: 'graph.microsoft.com' },
    ms_contacts_:   { integration: 'ms_contacts',     label: 'Microsoft Contacts',  server: 'graph.microsoft.com' },
    onedrive_:      { integration: 'onedrive',        label: 'OneDrive',            server: 'graph.microsoft.com' },

    // n8n Workflow Management — server is dynamic (configured per-org)
    n8n_workflow_:  { integration: 'n8n',             label: 'n8n Workflow Management', serverFn: (_args, ctx) => ctx?.n8nUrl || null },

    // Dutch legal open data — anonymous public APIs
    rechtspraak_:    { integration: 'rechtspraak',     label: 'Rechtspraak.nl',           server: 'data.rechtspraak.nl' },
    eurlex_:         { integration: 'eurlex',          label: 'EUR-Lex',                  server: 'eur-lex.europa.eu' },
    kamerstukken_:   { integration: 'kamerstukken',    label: 'Tweede Kamer Open Data',   server: 'gegevensmagazijn.tweedekamer.nl' },
    kamerstuk_:      { integration: 'kamerstukken',    label: 'Tweede Kamer Open Data',   server: 'gegevensmagazijn.tweedekamer.nl' },
    bekendmakingen_: { integration: 'bekendmakingen',  label: 'Officiële Bekendmakingen', server: 'repository.overheid.nl' },
    bekendmaking_:   { integration: 'bekendmakingen',  label: 'Officiële Bekendmakingen', server: 'repository.overheid.nl' },
    tuchtrecht_:     { integration: 'tuchtrecht',      label: 'Tuchtrecht',               server: 'repository.overheid.nl' },

    // Third-party SaaS
    fireflies_:     { integration: 'fireflies',       label: 'Fireflies',           server: 'api.fireflies.ai' },
    // YouTrack URL is per-org (Connections settings). Static fallback used to
    // be 'youtrack.cloud' which lied to the dashboard for self-hosted
    // instances; null lets the probe-captured tls_servername be the truth.
    youtrack_:      { integration: 'youtrack',        label: 'YouTrack',            serverFn: (_a, ctx) => ctx?.youtrackUrl || null },
    signrequest_:   { integration: 'signrequest',     label: 'SignRequest',         server: 'api.signrequest.com' },
    gamma_:         { integration: 'gamma',           label: 'Gamma',               server: 'gamma.app' },
    // AFAS host is per-customer ({nr}.rest.afas.online); null lets the
    // probe-captured tls_servername be the truth (same rationale as YouTrack).
    afas_:          { integration: 'afas_profit',     label: 'AFAS Profit',         serverFn: () => null },
    // NMBRS host depends on the API mode (api.nmbrs.nl SOAP / api.nmbrsapp.com
    // REST); null lets the probe-captured tls_servername be the truth.
    nmbrs_:         { integration: 'nmbrs',           label: 'NMBRS',               serverFn: () => null },
    linkedin_:      { integration: 'linkedin',        label: 'LinkedIn',            server: 'api.linkedin.com' },
    github_:        { integration: 'github',          label: 'GitHub',              server: 'api.github.com' },

    // Media generation — per-tool entries in INTEGRATION_TOOL_MAP carry the real
    // endpoint (api.openai.com/images, api.elevenlabs.io, etc.). The catch-all
    // here only fires for tools missing from the static map; null server keeps
    // the dashboard honest instead of showing a fake hostname.
    generate_:      { integration: 'media_gen',       label: 'Media Generation',    server: null },

    // Search & Maps
    maps_:          { integration: 'maps',            label: 'Google Maps',         server: 'maps.googleapis.com' },
    keyword_planner_: { integration: 'keyword_planner', label: 'Keyword Planner',   server: 'googleads.googleapis.com' },

    // Transcription — Whisper is local unless an explicit URL is configured
    transcribe_:    { integration: 'transcription',   label: 'Transcription',       serverFn: () => process.env.WHISPER_URL || null, isLocal: !process.env.WHISPER_URL },

    // Nextcloud — destination is the user's configured Nextcloud host. Resolved
    // at call time via ctx.nextcloudUrl. is_local left false so the probe can
    // capture the real peer IP (could be on-prem or hosted).
    nextcloud_calendar_:      { integration: 'nextcloud_calendar',      label: 'Nextcloud Calendar',      serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_contacts_:      { integration: 'nextcloud_contacts',      label: 'Nextcloud Contacts',      serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_deck_:          { integration: 'nextcloud_deck',          label: 'Nextcloud Deck',          serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_notifications_: { integration: 'nextcloud_notifications', label: 'Nextcloud Notifications', serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_talk_:          { integration: 'nextcloud_talk',          label: 'Nextcloud Talk',          serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_tasks_:         { integration: 'nextcloud_tasks',         label: 'Nextcloud Tasks',         serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_notes_:         { integration: 'nextcloud_notes',         label: 'Nextcloud Notes',         serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_mail_:          { integration: 'nextcloud_mail',          label: 'Nextcloud Mail',          serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_activity_:      { integration: 'nextcloud_activity',      label: 'Nextcloud Activity',      serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_status_:        { integration: 'nextcloud_status',        label: 'Nextcloud User Status',   serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_:               { integration: 'nextcloud',               label: 'Nextcloud Files',         serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
};

// ── Static overrides for specific tools ──────────────────────────────
// These provide precise metadata for tools that need custom server endpoints,
// direction, or data categories. Entries here override the prefix-based defaults.
const INTEGRATION_TOOL_MAP = {
    // ── Exact-match tools (no prefix pattern) ────────────────
    agent_search: {
        integration: 'web_search',
        label: 'Web Search',
        serverFn: () => 'api.serper.dev (Google Search)',
        direction: 'sent',
        dataCategories: 'search_query',
    },
    kb_search: {
        integration: 'kb_search',
        label: 'Knowledge Base',
        serverFn: () => null,
        isLocal: true,
        direction: 'received',
        dataCategories: 'search_query, document_content',
    },
    web_search: {
        integration: 'web_search',
        label: 'Web Search (Tavily)',
        serverFn: () => 'api.tavily.com',
        direction: 'sent',
        dataCategories: 'search_query',
    },
    format_citation: {
        integration: 'rechtspraak',
        label: 'Citaat formatteren',
        serverFn: () => 'data.rechtspraak.nl',
        direction: 'both',
        dataCategories: 'citation, ecli',
    },

    // ── AFAS Profit (read-only GetConnectors) ────────────────
    // ERP environments hold HR/payroll/finance records — tag the categories
    // explicitly so the egress dashboard and PII scan reflect the sensitivity.
    afas_list_connectors: {
        integration: 'afas_profit',
        label: 'AFAS Profit',
        serverFn: () => null,
        direction: 'received',
        dataCategories: 'erp_business_data',
    },
    afas_describe_connector: {
        integration: 'afas_profit',
        label: 'AFAS Profit',
        serverFn: () => null,
        direction: 'received',
        dataCategories: 'erp_business_data',
    },
    afas_query: {
        integration: 'afas_profit',
        label: 'AFAS Profit',
        serverFn: () => null,
        direction: 'received',
        dataCategories: 'erp_business_data, hr, finance',
    },

    // ── NMBRS (read-only payroll/HR) ─────────────────────────
    // Payroll/HR records are highly sensitive (names, salaries, contracts) —
    // tag the categories so the egress dashboard and PII scan reflect that.
    nmbrs_list_debtors: {
        integration: 'nmbrs', label: 'NMBRS', serverFn: () => null,
        direction: 'received', dataCategories: 'hr',
    },
    nmbrs_list_companies: {
        integration: 'nmbrs', label: 'NMBRS', serverFn: () => null,
        direction: 'received', dataCategories: 'hr',
    },
    nmbrs_list_employees: {
        integration: 'nmbrs', label: 'NMBRS', serverFn: () => null,
        direction: 'received', dataCategories: 'hr, pii',
    },
    nmbrs_get_employee: {
        integration: 'nmbrs', label: 'NMBRS', serverFn: () => null,
        direction: 'received', dataCategories: 'hr, pii',
    },
    nmbrs_list_employee_contracts: {
        integration: 'nmbrs', label: 'NMBRS', serverFn: () => null,
        direction: 'received', dataCategories: 'hr, pii',
    },
    nmbrs_list_employee_salaries: {
        integration: 'nmbrs', label: 'NMBRS', serverFn: () => null,
        direction: 'received', dataCategories: 'hr, payroll, pii',
    },
    nmbrs_list_employee_wage_components: {
        integration: 'nmbrs', label: 'NMBRS', serverFn: () => null,
        direction: 'received', dataCategories: 'hr, payroll, pii',
    },
    nmbrs_list_payslips: {
        integration: 'nmbrs', label: 'NMBRS', serverFn: () => null,
        direction: 'received', dataCategories: 'hr, payroll, pii',
    },

    // ── Legacy email tools (generic provider) ────────────────
    send_email: {
        integration: 'email',
        label: 'Email',
        serverFn: (args) => args?.provider === 'microsoft' ? 'graph.microsoft.com' : 'gmail.googleapis.com',
        direction: 'sent',
        dataCategories: 'email_content, recipients, subject',
    },
    read_emails: {
        integration: 'email',
        label: 'Email',
        serverFn: (args) => args?.provider === 'microsoft' ? 'graph.microsoft.com' : 'gmail.googleapis.com',
        direction: 'received',
        dataCategories: 'email_content, senders, subject',
    },
    search_emails: {
        integration: 'email',
        label: 'Email',
        serverFn: (args) => args?.provider === 'microsoft' ? 'graph.microsoft.com' : 'gmail.googleapis.com',
        direction: 'both',
        dataCategories: 'email_content, search_query',
    },

    // ── Legacy calendar/map tools ────────────────────────────
    read_calendar: {
        integration: 'calendar',
        label: 'Calendar',
        serverFn: () => 'graph.microsoft.com',
        direction: 'received',
        dataCategories: 'calendar_events, attendees',
    },
    create_calendar_event: {
        integration: 'calendar',
        label: 'Calendar',
        serverFn: () => 'graph.microsoft.com',
        direction: 'sent',
        dataCategories: 'calendar_events, attendees, location',
    },
    search_maps: {
        integration: 'maps',
        label: 'Google Maps',
        serverFn: () => 'maps.googleapis.com',
        direction: 'both',
        dataCategories: 'location_query, coordinates',
    },
    get_directions: {
        integration: 'maps',
        label: 'Google Maps',
        serverFn: () => 'maps.googleapis.com',
        direction: 'both',
        dataCategories: 'addresses, coordinates',
    },

    // ── Media gen (precise endpoints) ────────────────────────
    generate_image: {
        integration: 'image_gen',
        label: 'Image Generation',
        serverFn: () => 'api.openai.com/images',
        direction: 'both',
        dataCategories: 'prompt, generated_image',
    },
    generate_video: {
        integration: 'video_gen',
        label: 'Video Generation',
        serverFn: () => 'api.bananadev.com',
        direction: 'both',
        dataCategories: 'prompt, generated_video',
    },
    generate_music: {
        integration: 'elevenlabs',
        label: 'ElevenLabs',
        serverFn: () => 'api.elevenlabs.io',
        direction: 'both',
        dataCategories: 'prompt, generated_audio',
    },
    generate_song: {
        integration: 'elevenlabs',
        label: 'ElevenLabs',
        serverFn: () => 'api.elevenlabs.io',
        direction: 'both',
        dataCategories: 'prompt, lyrics, generated_audio',
    },
    generate_tts: {
        integration: 'elevenlabs',
        label: 'ElevenLabs',
        serverFn: () => 'api.elevenlabs.io',
        direction: 'both',
        dataCategories: 'text_content, generated_audio',
    },
    generate_sfx: {
        integration: 'elevenlabs',
        label: 'ElevenLabs',
        serverFn: () => 'api.elevenlabs.io',
        direction: 'both',
        dataCategories: 'prompt, generated_audio',
    },

    // ── n8n (dynamic URL) ────────────────────────────────────
    n8n_execute: {
        integration: 'n8n',
        label: 'n8n Workflow',
        serverFn: (args, ctx) => ctx?.n8nUrl || 'n8n-server (configured)',
        direction: 'both',
        dataCategories: 'workflow_payload',
    },
};

// Excluded tools — internal tools that should NOT be logged as integrations
// even if they match a prefix pattern (e.g. regex_* is internal)
const INTERNAL_TOOL_PREFIXES = new Set([
    'regex_',       // Regex generator (internal utility)
    'notebook_',    // Notebook tools (internal workspace)
    'workspace_',   // Workspace tools (internal)
    'set_',         // set_reminder, set_ai_task (internal)
]);

// PII category descriptions for data sovereignty reports
const PII_CATEGORIES = [
    'Person Name', 'Email Address', 'Phone Number', 'Physical Address',
    'Credit Card', 'Bank Account', 'IBAN', 'SSN', 'Passport Number',
    'IP Address', 'URL', "Driver's License", 'EU National ID / BSN',
];

/**
 * Infer data direction from tool name action part.
 * e.g. "gmail_compose" → "sent", "drive_list_files" → "received"
 */
function inferDirection(toolName) {
    const action = toolName.split('_').slice(-1)[0]; // last segment
    const fullAction = toolName.split('_').slice(1).join('_'); // everything after prefix

    // Sending / writing
    if (['compose', 'send', 'create', 'update', 'delete', 'cancel', 'reply', 'append', 'move', 'replace'].some(a => fullAction.includes(a))) {
        return 'sent';
    }
    // Reading / receiving
    if (['read', 'get', 'list', 'search', 'check', 'view'].some(a => fullAction.includes(a))) {
        return 'received';
    }
    return 'both';
}

/**
 * Resolve tool metadata for integration activity logging.
 *
 * Resolution order:
 *   1. Static INTEGRATION_TOOL_MAP (exact tool name match — highest priority)
 *   2. INTEGRATION_PREFIXES (prefix match — auto-detects new tools)
 *   3. MCP tool pattern (mcp__<server>__<tool> or mcp_<server>)
 *   4. n8n dynamic tools (n8n_* prefix)
 *   5. null (not an integration tool — internal tools like set_reminder, notebook_*)
 *
 * @param {string} toolName - The tool_name from the function call
 * @param {object} toolArgs - The arguments passed to the tool
 * @param {object} ctx - Runtime context (n8n URL, MCP config, etc.)
 * @returns {object|null} { integration, label, server, direction, dataCategories } or null
 */
function resolveIntegration(toolName, toolArgs = {}, ctx = {}) {
    if (!toolName) return null;

    // Skip internal tools
    for (const prefix of INTERNAL_TOOL_PREFIXES) {
        if (toolName.startsWith(prefix)) return null;
    }

    // 1. Exact match in static map (highest priority — custom metadata)
    const mapped = INTEGRATION_TOOL_MAP[toolName];
    if (mapped) {
        return {
            integration: mapped.integration,
            label: mapped.label,
            server: typeof mapped.serverFn === 'function' ? mapped.serverFn(toolArgs, ctx) : mapped.serverFn,
            direction: mapped.direction || inferDirection(toolName),
            dataCategories: mapped.dataCategories || 'unknown',
            isLocal: !!mapped.isLocal,
        };
    }

    // 2. Prefix match (auto-detection for known integration families)
    //    Sort by longest prefix first to match ms_calendar_ before ms_
    const sortedPrefixes = Object.keys(INTEGRATION_PREFIXES).sort((a, b) => b.length - a.length);
    for (const prefix of sortedPrefixes) {
        if (toolName.startsWith(prefix)) {
            const meta = INTEGRATION_PREFIXES[prefix];
            return {
                integration: meta.integration,
                label: meta.label,
                server: typeof meta.serverFn === 'function' ? meta.serverFn(toolArgs, ctx) : (meta.server || null),
                direction: inferDirection(toolName),
                dataCategories: 'auto_detected',
                isLocal: !!meta.isLocal,
            };
        }
    }

    // 3. MCP tool pattern: mcp__<server>__<tool> or mcp_<anything>
    if (toolName.startsWith('mcp__') || toolName.startsWith('mcp_')) {
        const parts = toolName.split('__');
        const mcpServer = parts[1] || toolName.replace(/^mcp_/, '').split('_')[0] || 'unknown';
        return {
            integration: 'mcp',
            label: `MCP: ${mcpServer}`,
            server: ctx?.mcpEndpoint || `mcp-server://${mcpServer}`,
            direction: 'both',
            dataCategories: 'mcp_payload',
        };
    }

    // 4. n8n dynamic tools (catch-all for any n8n_ prefix not in static map)
    if (toolName.startsWith('n8n_')) {
        return {
            integration: 'n8n',
            label: 'n8n Workflow',
            server: ctx?.n8nUrl || 'n8n-server',
            direction: 'both',
            dataCategories: 'workflow_payload',
        };
    }

    // 5. Not an integration tool
    return null;
}

/**
 * Lightweight regex-based PII scanner for tool output.
 * Runs entirely in-process — no external API calls.
 * Returns a comma-separated string of detected PII categories, or empty string.
 */
const PII_PATTERNS = [
    { category: 'Email Address', pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
    { category: 'Phone Number', pattern: /(?:\+?\d{1,4}[\s\-]?)?(?:\(?\d{2,4}\)?[\s\-]?)?\d{3,4}[\s\-]?\d{4}/g },
    { category: 'IBAN', pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{8,30}\b/g },
    { category: 'Credit Card', pattern: /\b(?:\d{4}[\s\-]?){3}\d{1,4}\b/g },
    { category: 'IP Address', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
    { category: 'EU National ID / BSN', pattern: /\b\d{9}\b/g },
];

function scanOutputForPii(text) {
    if (!text || typeof text !== 'string' || text.length < 5) return '';
    const found = new Set();
    for (const { category, pattern } of PII_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(text)) found.add(category);
    }
    return [...found].join(', ');
}

module.exports = {
    INTEGRATION_TOOL_MAP,
    INTEGRATION_PREFIXES,
    PII_CATEGORIES,
    resolveIntegration,
    scanOutputForPii,
};
