/**
 * Progressive Tool Disclosure
 * ───────────────────────────
 * Direct chat used to send EVERY tool the user has (Gmail, Drive, the full
 * Nextcloud suite, n8n, MCP, …) as full JSON schemas on every single message —
 * dozens of schemas, ~15-40K input tokens, even for "what is my email address".
 * That prefix is also written to a 1h cache at 2× on the first message of every
 * new chat, so trivial questions cost ~13¢.
 *
 * Instead we send a small set of EAGER tools (web search, KB, notebook, the
 * built-ins) in full, plus a compact CATALOG of the heavy integration groups
 * and a single `load_tools` meta-tool. The model calls `load_tools({groups})`
 * when it actually needs an integration; the route then injects that group's
 * real schemas into the live tool list for the rest of the conversation. This
 * mirrors the existing dynamic-skill pattern (`activate_skill`).
 *
 * Pure helpers only — the stateful bits (mutating the live tool array,
 * persisting activated groups) live in the direct-chat route because they need
 * its request-scoped closure.
 */

const LOAD_TOOLS_TOOL_NAME = 'load_tools';

// Hard ceiling on how many tools we'll ever disclose into one request. Anthropic
// tolerates large tool lists but cost/latency grow, so a runaway "load every
// group" defeats the purpose. expandGroups() stops here.
const MAX_DISCLOSED_TOOLS = 128;

// Below this many lazy-eligible tools the whole feature is a no-op (light users
// see zero change). Checked by the caller.
const MIN_TOOLS_FOR_DISCLOSURE = 25;

/**
 * Ordered list of lazy tool groups. The FIRST matcher that accepts a tool name
 * wins, so the specific Nextcloud sub-apps must precede the generic
 * `nextcloud_` (Files) catch-all. Anything not matched by any matcher stays
 * EAGER (components, built-ins, media-gen, notebook, webpages, load_tools…).
 *
 * `desc` is a one-liner for the catalog — deliberately short; the full schemas
 * carry the real detail once loaded.
 */
const LAZY_GROUPS = [
    // ── Google Workspace ──
    { key: 'gmail',            label: 'Gmail',              desc: 'search, read, compose, send & reply to email (sends need approval)', prefix: 'gmail_' },
    { key: 'google_calendar',  label: 'Google Calendar',    desc: 'list, search, create, update, delete events',                       prefix: 'calendar_' },
    { key: 'google_drive',     label: 'Google Drive',       desc: 'search, list, manage files and folders',                            prefix: 'drive_' },
    { key: 'google_docs',      label: 'Google Docs',        desc: 'create, read, append, replace text in documents',                   prefix: 'docs_' },
    { key: 'google_sheets',    label: 'Google Sheets',      desc: 'read and write spreadsheet data',                                   prefix: 'sheets_' },
    { key: 'google_slides',    label: 'Google Slides',      desc: 'create and edit presentations',                                     prefix: 'slides_' },
    { key: 'google_contacts',  label: 'Google Contacts',    desc: 'search, list, create, update contacts',                             prefix: 'contacts_' },
    { key: 'google_keep',      label: 'Google Keep',        desc: 'list, get, create, delete notes',                                   prefix: 'keep_' },
    { key: 'google_groups',    label: 'Google Groups',      desc: 'read and reply to group conversation threads',                      prefix: 'groups_' },

    // ── Microsoft 365 ──
    { key: 'outlook',          label: 'Outlook Mail',       desc: 'search, read, compose, send & reply to email',                      prefix: 'outlook_' },
    { key: 'ms_calendar',      label: 'Microsoft Calendar', desc: 'list, search, create, update, delete events',                       prefix: 'ms_calendar_' },
    { key: 'onedrive',         label: 'OneDrive',           desc: 'search, list, manage files and folders',                            prefix: 'onedrive_' },
    { key: 'ms_contacts',      label: 'Microsoft Contacts', desc: 'search, list, create, update contacts',                             prefix: 'ms_contacts_' },

    // ── Nextcloud (specific sub-apps BEFORE the generic Files catch-all) ──
    { key: 'nextcloud_calendar',      label: 'Nextcloud Calendar',      desc: 'CalDAV calendars & events',                  prefix: 'nextcloud_calendar_' },
    { key: 'nextcloud_contacts',      label: 'Nextcloud Contacts',      desc: 'CardDAV address books & contacts',           prefix: 'nextcloud_contacts_' },
    { key: 'nextcloud_deck',          label: 'Nextcloud Deck',          desc: 'boards, stacks, cards, labels',              prefix: 'nextcloud_deck_' },
    { key: 'nextcloud_notifications', label: 'Nextcloud Notifications', desc: 'list and dismiss notifications',             prefix: 'nextcloud_notifications_' },
    { key: 'nextcloud_talk',          label: 'Nextcloud Talk',          desc: 'conversations, messages, reactions',         prefix: 'nextcloud_talk_' },
    { key: 'nextcloud_tasks',         label: 'Nextcloud Tasks',         desc: 'VTODO task lists and items',                 prefix: 'nextcloud_tasks_' },
    { key: 'nextcloud_notes',         label: 'Nextcloud Notes',         desc: 'notes and categories',                       prefix: 'nextcloud_notes_' },
    { key: 'nextcloud_mail',          label: 'Nextcloud Mail',          desc: 'read and manage Nextcloud Mail',             prefix: 'nextcloud_mail_' },
    { key: 'nextcloud_activity',      label: 'Nextcloud Activity',      desc: 'recent file/share/comment activity feed',    prefix: 'nextcloud_activity_' },
    { key: 'nextcloud_status',        label: 'Nextcloud Status',        desc: 'get/set user availability status',           prefix: 'nextcloud_status_' },
    { key: 'nextcloud_files',         label: 'Nextcloud Files',         desc: 'list, read, upload, share, version files',   prefix: 'nextcloud_' },

    // ── n8n ──
    { key: 'n8n_workflow', label: 'n8n Workflow Management', desc: 'list, inspect, create, patch, run & debug workflows', match: (n) => n.startsWith('n8n_workflow_') || n.startsWith('n8n_execution_') },
    { key: 'n8n_run',      label: 'n8n Saved Workflows',     desc: 'run the org\'s saved n8n webhook workflows',          prefix: 'n8n_run_' },

    // ── Dutch legal sources ──
    { key: 'rechtspraak',    label: 'Rechtspraak.nl',          desc: 'Nederlandse jurisprudentie (uitspraken via ECLI)',       prefix: 'rechtspraak_' },
    { key: 'eurlex',         label: 'EUR-Lex',                 desc: 'EU-recht en HvJEU-arresten (CELEX)',                     prefix: 'eurlex_' },
    { key: 'kamerstukken',   label: 'Kamerstukken',            desc: 'Tweede Kamer wetsgeschiedenis & kamervragen',            match: (n) => n.startsWith('kamerstukken_') || n === 'kamerstuk_get' },
    { key: 'bekendmakingen', label: 'Officiële Bekendmakingen', desc: 'Staatsblad/Staatscourant/Tractatenblad',                match: (n) => n.startsWith('bekendmakingen_') || n === 'bekendmaking_get' },
    { key: 'tuchtrecht',     label: 'Tuchtrecht',              desc: 'Nederlandse tuchtuitspraken per beroepsgroep',           prefix: 'tuchtrecht_' },

    // ── Other integrations ──
    { key: 'youtrack',     label: 'YouTrack',     desc: 'search, create, update issues',                  prefix: 'youtrack_' },
    { key: 'gamma',        label: 'Gamma',        desc: 'create presentations/docs/webpages',             prefix: 'gamma_' },
    { key: 'signrequest',  label: 'SignRequest',  desc: 'send documents for e-signature, track status',   prefix: 'signrequest_' },
    { key: 'fireflies',    label: 'Fireflies',    desc: 'meeting transcripts',                            prefix: 'fireflies_' },
    { key: 'linkedin',     label: 'LinkedIn',     desc: 'create posts (approval before publishing)',      prefix: 'linkedin_' },
    { key: 'github',       label: 'GitHub',       desc: 'list repos, view code, manage branches',         prefix: 'github_' },
    { key: 'maps',         label: 'Google Maps',  desc: 'directions and place search with map embeds',    prefix: 'maps_' },
    { key: 'transcription', label: 'Meeting Transcription', desc: 'transcribe uploaded audio with diarization', match: (n) => n === 'transcribe_audio' },
];

/** Return the group definition for a tool, or null if it should stay eager. */
function groupForTool(tool) {
    const name = tool?.function?.name || tool?.name || '';
    if (!name) return null;

    // MCP tools are dynamic — one group per connected server.
    if (name.startsWith('mcp_')) {
        const serverId = tool?._mcp?.serverId || name.split('_')[1] || 'unknown';
        const label = serverId.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        return { key: `mcp:${serverId}`, label: `${label} (MCP)`, desc: 'tools from a connected MCP server' };
    }

    // Custom org integrations (AI Integration Builder) are dynamic too — one
    // group per integration, keyed by the slug parsed out of cint_<slug>_<tool>.
    if (name.startsWith('cint_')) {
        let slug = null;
        try {
            const { parsePrefixedName } = require('../integrations/customIntegrationRunner');
            slug = parsePrefixedName(name)?.slug || null;
        } catch (_) { /* fail soft — fall back to a raw split below */ }
        if (!slug) slug = name.split('_')[1] || 'unknown';
        const label = slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        return { key: `custom:${slug}`, label: `${label} (Custom)`, desc: 'tools from a custom org integration' };
    }

    for (const g of LAZY_GROUPS) {
        const ok = g.match ? g.match(name) : name.startsWith(g.prefix);
        if (ok) return { key: g.key, label: g.label, desc: g.desc };
    }
    return null;
}

/**
 * Pure helper for the unknown-tool path: which lazy group would own this name?
 * Returns a group key string or null. Used to give the model a recoverable
 * "call load_tools first" hint instead of a dead-end error.
 */
function toolNameToGroupKey(name) {
    return groupForTool({ function: { name } })?.key || null;
}

/**
 * Split a fully-assembled tool list into the eager set (kept in full) and the
 * lazy groups (replaced by a catalog line until loaded on demand).
 *
 * @param {Array} allTools - the complete directChatTools array
 * @returns {{ eager: Array, lazyByGroup: Map<string, {label, desc, tools: Array}> }}
 */
function partitionTools(allTools) {
    const eager = [];
    const lazyByGroup = new Map();

    for (const tool of allTools || []) {
        const group = groupForTool(tool);
        if (!group) {
            eager.push(tool);
            continue;
        }
        let entry = lazyByGroup.get(group.key);
        if (!entry) {
            entry = { label: group.label, desc: group.desc, tools: [] };
            lazyByGroup.set(group.key, entry);
        }
        entry.tools.push(tool);
    }

    return { eager, lazyByGroup };
}

/** Count of tools that are eligible for lazy disclosure (for the threshold gate). */
function countLazyTools(allTools) {
    let n = 0;
    for (const tool of allTools || []) {
        if (groupForTool(tool)) n++;
    }
    return n;
}

/**
 * Build the catalog text appended to the system prompt. One deterministic,
 * alphabetically-sorted line per NOT-yet-loaded lazy group (already-loaded
 * groups carry their full schemas, so they're omitted here). Stable ordering
 * keeps the cached prefix byte-identical across turns.
 *
 * @param {Map} lazyByGroup
 * @param {Set<string>} loadedGroups - group keys already expanded this conversation
 * @returns {string}
 */
function buildToolCatalog(lazyByGroup, loadedGroups = new Set()) {
    const lines = [];
    for (const [key, entry] of lazyByGroup) {
        if (loadedGroups.has(key)) continue;
        const names = entry.tools.map(t => t.function?.name || t.name).filter(Boolean);
        const shown = names.slice(0, 8).join(', ');
        const more = names.length > 8 ? `, +${names.length - 8} more` : '';
        lines.push(`- ${key} · ${entry.label} — ${entry.desc}. tools: ${shown}${more} (${names.length})`);
    }
    if (lines.length === 0) return '';
    lines.sort();
    return '\n\n[AVAILABLE TOOL GROUPS — ON DEMAND]\n'
        + 'These integrations are available but their tools are NOT loaded yet. When a request needs one, '
        + `call ${LOAD_TOOLS_TOOL_NAME} with the group key(s) BEFORE attempting any tool in that group. `
        + 'Once loaded, the tools stay available for the rest of the conversation — do not call '
        + `${LOAD_TOOLS_TOOL_NAME} again for the same group. Do not load groups speculatively.\n`
        + lines.join('\n');
}

/** The meta-tool definition (OpenAI function shape). */
const loadToolsDefinition = {
    type: 'function',
    function: {
        name: LOAD_TOOLS_TOOL_NAME,
        description: 'Load the full tool definitions for one or more integration groups listed under '
            + '[AVAILABLE TOOL GROUPS — ON DEMAND] in the system prompt. Call this BEFORE using any tool '
            + 'from a group that is not yet loaded. After it returns, that group\'s tools are available for '
            + 'the rest of the conversation — do not call load_tools again for the same group.',
        parameters: {
            type: 'object',
            properties: {
                groups: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Group keys from the catalog, e.g. ["google_calendar","gmail"].',
                },
            },
            required: ['groups'],
        },
    },
};

/**
 * Resolve a model-supplied group name to a real group key (tolerant of labels,
 * spaces, casing).
 */
function resolveGroupKey(requested, lazyByGroup) {
    if (!requested || typeof requested !== 'string') return null;
    const norm = requested.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (lazyByGroup.has(requested)) return requested;
    if (lazyByGroup.has(norm)) return norm;
    // Match by label as a fallback ("Google Calendar" → google_calendar).
    for (const [key, entry] of lazyByGroup) {
        if (key.toLowerCase() === norm) return key;
        if (entry.label.toLowerCase().replace(/[\s-]+/g, '_') === norm) return key;
    }
    return null;
}

/**
 * Given the groups the model asked to load, return the new tool defs to inject.
 *
 * @param {string[]} groupNames
 * @param {Object} ctx
 * @param {Map} ctx.lazyByGroup
 * @param {Set<string>} ctx.loadedNames  - tool names already present in the live list
 * @param {number} ctx.currentToolCount  - current size of the live tool list
 * @param {number} [ctx.maxTools]
 * @returns {{ addedDefs: Array, added: string[], alreadyLoaded: string[], unknown: string[], capped: string[] }}
 */
function expandGroups(groupNames, { lazyByGroup, loadedNames, currentToolCount, maxTools = MAX_DISCLOSED_TOOLS }) {
    const addedDefs = [];
    const added = [];
    const alreadyLoaded = [];
    const unknown = [];
    const capped = [];
    let budget = Math.max(0, maxTools - (currentToolCount || 0));

    for (const raw of Array.isArray(groupNames) ? groupNames : []) {
        const key = resolveGroupKey(raw, lazyByGroup);
        if (!key) { unknown.push(raw); continue; }
        const entry = lazyByGroup.get(key);
        const fresh = entry.tools.filter(t => !loadedNames.has(t.function?.name || t.name));
        if (fresh.length === 0) { alreadyLoaded.push(key); continue; }
        if (fresh.length > budget) { capped.push(key); continue; }
        for (const def of fresh) {
            addedDefs.push(def);
            loadedNames.add(def.function?.name || def.name);
        }
        budget -= fresh.length;
        added.push(key);
    }

    return { addedDefs, added, alreadyLoaded, unknown, capped };
}

// Behavioural nudges that the prose tool-hint used to carry but a one-line
// catalog can't. Surfaced in the load_tools result exactly when the group is
// first pulled in, so they're present the moment the model can use the tools
// (the system prompt is built once per turn, before any load happens).
const GROUP_LOAD_REMINDERS = {
    maps: 'After getting Maps results, ALWAYS output the map as a ```map-embed code block containing JSON with embedUrl, title and mapsLink fields so it renders interactively.',
    n8n_workflow: 'n8n rules: call n8n_workflow_list first to discover IDs (never guess); use n8n_workflow_patch with node_operations for targeted edits (not wholesale update); confirm with the user before delete/activate; debug failures via n8n_execution_list → n8n_execution_get_detail.',
};

/** Build the tool_result string returned to the model after a load_tools call. */
function buildLoadResult({ addedDefs, added, alreadyLoaded, unknown, capped }) {
    if (added.length === 0 && alreadyLoaded.length === 0 && unknown.length === 0 && capped.length === 0) {
        return 'No groups specified.';
    }
    const parts = [];
    if (added.length) {
        const names = addedDefs.map(d => d.function?.name || d.name);
        parts.push(`Loaded ${added.length} group(s): ${added.join(', ')}. Tools now available: ${names.join(', ')}.`);
        for (const key of added) {
            if (GROUP_LOAD_REMINDERS[key]) parts.push(GROUP_LOAD_REMINDERS[key]);
        }
    }
    if (alreadyLoaded.length) parts.push(`Already loaded: ${alreadyLoaded.join(', ')}.`);
    if (unknown.length) parts.push(`Unknown/unavailable groups ignored: ${unknown.join(', ')}.`);
    if (capped.length) parts.push(`Tool budget reached — could not load: ${capped.join(', ')}. Finish with the tools you have or ask the user to narrow scope.`);
    return parts.join(' ');
}

module.exports = {
    LOAD_TOOLS_TOOL_NAME,
    MAX_DISCLOSED_TOOLS,
    MIN_TOOLS_FOR_DISCLOSURE,
    loadToolsDefinition,
    groupForTool,
    toolNameToGroupKey,
    partitionTools,
    countLazyTools,
    buildToolCatalog,
    expandGroups,
    buildLoadResult,
};
