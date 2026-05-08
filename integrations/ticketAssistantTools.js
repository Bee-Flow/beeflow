/**
 * Ticket Assistant Tools — exposes the standalone Ticket Assistant's
 * capabilities as automation/agent tool calls.
 *
 * Three groups:
 *   1. AI primitives (5)        — clean_email / redact_pii / classify /
 *                                 summarise / process_ticket. Wrap the
 *                                 existing ticketAssistantProcessor stages
 *                                 so routines can apply them to ANY upstream
 *                                 text (not just sync-engine items).
 *   2. Provider read (3)        — fetch_recent / search_ingested / get_ticket.
 *                                 Pull from a connection without a full sync.
 *   3. Sync + connection CRUD   — list / get / update / create / delete /
 *                                 trigger_sync. Full parity with the
 *                                 hard-coded TA UI.
 *
 * All tools are org-scoped: every operation that touches a connection runs
 * `_assertOrgAccess(userId, connectionId)` first. Tools that mutate (create
 * / delete) require the user to be a super-admin. The check is mirrored
 * from `routes/ticketAssistant.js isSuperAdmin` so route + tool surface
 * stay aligned.
 */

const ticketAssistantStore = require('../stores/ticketAssistantStore');
const userStore = require('../stores/userStore');
const ticketProviders = require('../core/ticketProviders');
const processor = require('../core/ticketAssistantProcessor');

// ── Tool schemas (advertised to the LLM) ──────────────────────────────

const TICKET_ASSISTANT_TOOLS = [
    // ── AI primitives ─────────────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'ticket_assistant_clean_email',
            description: 'Strip HTML, signatures, quoted reply blocks and other email noise from raw text. Pure, deterministic; useful as a pre-processing step before classification or summarisation. Returns the cleaned text.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'Raw email body (HTML or plain text).' },
                },
                required: ['text'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'ticket_assistant_redact_pii',
            description: 'Run the Ticket Assistant\'s regex-based PII redactor over arbitrary text. Replaces emails / phones / IPs / BSNs / MAC addresses with placeholders. Returns {redactedText, counts}.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'Text to redact.' },
                    disable: {
                        type: 'array',
                        items: { type: 'string', enum: ['email', 'phone', 'ip', 'bsn', 'mac'] },
                        description: 'Optional list of PII classes to skip.',
                    },
                },
                required: ['text'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'ticket_assistant_classify',
            description: 'Classify a ticket-like text into a single category label using the Ticket Assistant\'s AI categoriser. Honours the org\'s tier catalog. Defaults to a sensible category prompt; pass systemPromptOverride for a custom taxonomy.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'The text to classify (typically the email/ticket body).' },
                    systemPromptOverride: { type: 'string', description: 'Optional. Replaces the default category prompt — use to enforce a specific taxonomy or domain framing.' },
                    modelTier: { type: 'string', enum: ['fast', 'thinking', 'writer', 'deep_thinking'], description: 'Default fast.' },
                    language: { type: 'string', description: 'Optional language hint for the model.' },
                },
                required: ['text'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'ticket_assistant_summarise',
            description: 'Run the Ticket Assistant\'s article-summarisation stage on a ticket-like text. Produces a clean markdown summary plus a category label in one call (uses the fused summarise-and-categorise pipeline).',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'Cleaned text (typically post-redact_pii output).' },
                    articleSystemPromptOverride: { type: 'string' },
                    categorySystemPromptOverride: { type: 'string' },
                    modelTier: { type: 'string', enum: ['fast', 'thinking', 'writer', 'deep_thinking'], description: 'Default fast.' },
                    language: { type: 'string' },
                },
                required: ['text'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'ticket_assistant_process_ticket',
            description: 'Combined pipeline: clean → redact PII → summarise → classify. Each stage can be skipped via flag. Returns one envelope with all stage outputs so a downstream step can bind any field. Mirrors the standalone Ticket Assistant\'s default pipeline; use the individual stage tools for finer control.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string' },
                    runClean: { type: 'boolean', description: 'Default true.' },
                    runRedact: { type: 'boolean', description: 'Default true.' },
                    runSummarise: { type: 'boolean', description: 'Default true.' },
                    runClassify: { type: 'boolean', description: 'Default true. When summarise is on, classification is fused into the same call.' },
                    modelTier: { type: 'string', enum: ['fast', 'thinking', 'writer', 'deep_thinking'] },
                    language: { type: 'string' },
                    articleSystemPromptOverride: { type: 'string' },
                    categorySystemPromptOverride: { type: 'string' },
                },
                required: ['text'],
            },
        },
    },

    // ── Provider read ─────────────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'ticket_assistant_fetch_recent',
            description: 'Fetch the most recent normalised tickets from a connected ticket source (Jira / ServiceNow / Zendesk / Freshservice / TopDesk). Useful for "give me yesterday\'s open Jira tickets" without going through the sync engine. Email-based connections (gmail/outlook) are not supported here — use gmail_search / outlook_list_messages instead.',
            parameters: {
                type: 'object',
                properties: {
                    connectionId: { type: 'string' },
                    limit: { type: 'integer', description: 'Default 50. Max 200.' },
                    since: { type: 'string', description: 'ISO-8601 timestamp. Only tickets updated after this are returned.' },
                    statusBucketEquals: { type: 'string', enum: ['open', 'pending', 'resolved', 'closed'] },
                },
                required: ['connectionId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'ticket_assistant_search_ingested',
            description: 'Search the Knowledge Base documents created by the Ticket Assistant\'s sync engine. Returns matching tickets/articles with their source URI back to the original ticket. Handy for "find all tickets about VPN issues last month".',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    connectionId: { type: 'string', description: 'Optional. Restrict results to one connection\'s ingested docs.' },
                    limit: { type: 'integer', description: 'Default 20. Max 100.' },
                    categoryEquals: { type: 'string' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'ticket_assistant_get_ticket',
            description: 'Fetch a single normalised ticket by id from a ticket-source connection. Returns subject, body_markdown, comments, attachments, status, priority, etc.',
            parameters: {
                type: 'object',
                properties: {
                    connectionId: { type: 'string' },
                    ticketId: { type: 'string' },
                },
                required: ['connectionId', 'ticketId'],
            },
        },
    },

    // ── Sync + connection CRUD ────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'ticket_assistant_list_connections',
            description: 'List the org\'s configured Ticket Assistant connections (gmail / outlook / jira / servicenow / zendesk / freshservice / topdesk). Returns metadata only — no secrets.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'ticket_assistant_get_connection',
            description: 'Read a single connection\'s configuration (no secrets).',
            parameters: {
                type: 'object',
                properties: { connectionId: { type: 'string' } },
                required: ['connectionId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'ticket_assistant_update_connection',
            description: 'Update a connection\'s sync settings, prompts, blacklist, target KB, or paused state. Token rotation is intentionally NOT supported here for security — re-connect via the UI for that.',
            parameters: {
                type: 'object',
                properties: {
                    connectionId: { type: 'string' },
                    name: { type: 'string', description: 'Display name.' },
                    syncIntervalMinutes: { type: 'integer' },
                    aiSystemPrompt: { type: 'string' },
                    senderBlacklist: { type: 'array', items: { type: 'string' } },
                    targetKnowledgeBaseId: { type: 'string' },
                    isPaused: { type: 'boolean', description: 'Pause the connection without deleting it.' },
                },
                required: ['connectionId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'ticket_assistant_create_connection',
            description: 'Create a new Ticket Assistant connection. Admin-only. Returns the created connection (no secrets). Provider-specific tokens must be provided in the same shape the OAuth callback / API-token form would use.',
            parameters: {
                type: 'object',
                properties: {
                    provider: { type: 'string', enum: ['gmail', 'outlook', 'jira', 'servicenow', 'zendesk', 'freshservice', 'topdesk'] },
                    knowledgeBaseId: { type: 'string' },
                    emailAddress: { type: 'string', description: 'Account identifier (email for email providers, login/subdomain/instance for ticket providers).' },
                    displayName: { type: 'string' },
                    tokens: { type: 'object', description: 'Provider-specific credential blob. Encrypted at rest.' },
                    providerConfig: { type: 'object' },
                    authMethod: { type: 'string', enum: ['oauth', 'api_token', 'basic'] },
                },
                required: ['provider', 'knowledgeBaseId', 'emailAddress', 'tokens'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'ticket_assistant_delete_connection',
            description: 'Delete a Ticket Assistant connection. Admin-only. Stops the sync engine for that connection and removes its row.',
            parameters: {
                type: 'object',
                properties: { connectionId: { type: 'string' } },
                required: ['connectionId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'ticket_assistant_trigger_sync',
            description: 'Trigger a manual sync run for a Ticket Assistant connection. Returns the run\'s outcome JSON synchronously.',
            parameters: {
                type: 'object',
                properties: { connectionId: { type: 'string' } },
                required: ['connectionId'],
            },
        },
    },
];

// ── Auth helpers ───────────────────────────────────────────────────────

async function _getUserOrgId(userId) {
    const u = await userStore.getUser(userId);
    return u?.organizationId || null;
}

async function _isSuperAdminUserId(userId) {
    const u = await userStore.getUser(userId);
    return !!(u && (u.role === 'admin'));
}

/**
 * Confirms the calling user can touch this connection. Either the user is a
 * super-admin, OR the user's organizationId matches the connection's
 * organization_id. Throws on access denial — the executor catches and
 * surfaces `{error: 'Forbidden'}` to the LLM so the runner records the
 * failure cleanly instead of looping.
 */
async function _assertOrgAccess(userId, connectionId) {
    const conn = await ticketAssistantStore.getConnection(connectionId);
    if (!conn) {
        const err = new Error(`Connection ${connectionId} not found.`);
        err._tagForbiddenIsh = true;
        throw err;
    }
    const isAdmin = await _isSuperAdminUserId(userId);
    if (isAdmin) return conn;
    const orgId = await _getUserOrgId(userId);
    if (!orgId || orgId !== conn.organization_id) {
        const err = new Error('Forbidden — connection belongs to a different organization.');
        err._tagForbidden = true;
        throw err;
    }
    return conn;
}

// ── AI primitive executors ────────────────────────────────────────────

async function _runClassify(text, opts = {}) {
    return processor.categorizeArticle(text, {
        customPrompt: opts.systemPromptOverride,
        modelTier: opts.modelTier || 'fast',
        language: opts.language,
        orgId: opts.orgId,
    });
}

async function _runSummarise(text, opts = {}) {
    return processor.summarizeAndCategorize(text, {
        articlePrompt: opts.articleSystemPromptOverride,
        categoryPrompt: opts.categorySystemPromptOverride,
        modelTier: opts.modelTier || 'fast',
        language: opts.language,
        orgId: opts.orgId,
    });
}

// ── Dispatcher ─────────────────────────────────────────────────────────

function isTicketAssistantTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('ticket_assistant_');
}

async function executeTicketAssistantTool(toolName, args, userId, session) {
    try {
        switch (toolName) {

            // ── AI primitives ─────────────────────────────────────────
            case 'ticket_assistant_clean_email': {
                const cleaned = processor.cleanEmail(args.text || '');
                return { cleanedText: cleaned, originalLength: (args.text || '').length, cleanedLength: cleaned.length };
            }
            case 'ticket_assistant_redact_pii': {
                const result = processor.redactPIIWithCounts(args.text || '', { disable: Array.isArray(args.disable) ? args.disable : [] });
                return { redactedText: result.text, counts: result.counts };
            }
            case 'ticket_assistant_classify': {
                if (!args.text) return { error: 'text is required' };
                const orgId = await _getUserOrgId(userId);
                const category = await _runClassify(args.text, { ...args, orgId });
                return { category };
            }
            case 'ticket_assistant_summarise': {
                if (!args.text) return { error: 'text is required' };
                const orgId = await _getUserOrgId(userId);
                const r = await _runSummarise(args.text, { ...args, orgId });
                return { article: r.article, category: r.category, reason: r.reason || null };
            }
            case 'ticket_assistant_process_ticket': {
                if (!args.text) return { error: 'text is required' };
                const orgId = await _getUserOrgId(userId);
                const out = { input: { length: args.text.length } };
                let working = args.text;
                if (args.runClean !== false) {
                    working = processor.cleanEmail(working);
                    out.cleaned = working;
                }
                if (args.runRedact !== false) {
                    const r = processor.redactPIIWithCounts(working);
                    working = r.text;
                    out.redacted = working;
                    out.piiCounts = r.counts;
                }
                if (args.runSummarise !== false) {
                    const r = await _runSummarise(working, {
                        articleSystemPromptOverride: args.articleSystemPromptOverride,
                        categorySystemPromptOverride: args.categorySystemPromptOverride,
                        modelTier: args.modelTier,
                        language: args.language,
                        orgId,
                    });
                    out.article = r.article;
                    out.category = r.category; // fused with summarise
                } else if (args.runClassify !== false) {
                    out.category = await _runClassify(working, {
                        systemPromptOverride: args.categorySystemPromptOverride,
                        modelTier: args.modelTier,
                        language: args.language,
                        orgId,
                    });
                }
                return out;
            }

            // ── Provider read ─────────────────────────────────────────
            case 'ticket_assistant_fetch_recent': {
                if (!args.connectionId) return { error: 'connectionId is required' };
                const conn = await _assertOrgAccess(userId, args.connectionId);
                const provider = ticketProviders.getProvider(conn.provider);
                if (!provider) {
                    return { error: `Provider "${conn.provider}" does not support fetch_recent (email providers use gmail_search / outlook_list_messages instead).` };
                }
                const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
                // Fetch with tokens (sync engine reads encrypted blob).
                const fullConn = await ticketAssistantStore.getConnectionWithTokens(args.connectionId);
                const items = [];
                try {
                    const iter = provider.listTickets(fullConn, { since: args.since || null, cursor: null, max: limit });
                    for await (const raw of iter) {
                        if (items.length >= limit) break;
                        const comments = await provider.fetchComments(fullConn, raw.id || raw.key || raw.number).catch(() => []);
                        const attachments = await provider.fetchAttachments?.(fullConn, raw.id || raw.key || raw.number).catch(() => []) || [];
                        const norm = provider.normalize(raw, comments, attachments);
                        if (args.statusBucketEquals && norm.status_bucket !== args.statusBucketEquals) continue;
                        // Strip non-serialisable bits before returning to the LLM.
                        items.push({
                            ...norm,
                            attachments: (norm.attachments || []).map(a => ({ filename: a.filename, mime: a.mime, size: a.size })),
                        });
                    }
                } catch (e) {
                    return { error: `fetch_recent failed: ${e.message}`, items };
                }
                return { count: items.length, tickets: items };
            }
            case 'ticket_assistant_search_ingested': {
                if (!args.query) return { error: 'query is required' };
                const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
                const orgId = await _getUserOrgId(userId);
                if (!orgId) return { error: 'No organization context for the calling user.' };
                // Reuse the KB search route — Knowledge Base store has a per-org
                // text search that already understands category metadata.
                const kbStore = require('../stores/knowledgeBases');
                if (typeof kbStore.searchDocuments !== 'function') {
                    return { error: 'KB search is not available in this build.' };
                }
                let docs = await kbStore.searchDocuments({
                    orgId,
                    query: args.query,
                    limit: limit * 2, // over-fetch so connection/category filtering still hits target
                });
                docs = (docs || []).filter(d => {
                    const m = d.metadata || {};
                    if (args.connectionId && m.connectionId !== args.connectionId) return false;
                    if (args.categoryEquals && m.category !== args.categoryEquals) return false;
                    return true;
                }).slice(0, limit);
                return {
                    count: docs.length,
                    results: docs.map(d => ({
                        documentId: d.id,
                        title: d.title,
                        snippet: (d.content || '').slice(0, 400),
                        sourceUri: d.sourceUri || d.source_uri || null,
                        category: d.metadata?.category || null,
                        connectionId: d.metadata?.connectionId || null,
                    })),
                };
            }
            case 'ticket_assistant_get_ticket': {
                if (!args.connectionId || !args.ticketId) return { error: 'connectionId and ticketId are required' };
                const conn = await _assertOrgAccess(userId, args.connectionId);
                const provider = ticketProviders.getProvider(conn.provider);
                if (!provider) return { error: `Provider "${conn.provider}" does not support direct ticket fetch.` };
                const fullConn = await ticketAssistantStore.getConnectionWithTokens(args.connectionId);
                // Walk the iterable until we find the matching id — providers
                // don't all expose a direct getById, so we accept the cost.
                try {
                    for await (const raw of provider.listTickets(fullConn, { since: null, cursor: null, max: 200 })) {
                        const id = raw.id || raw.key || raw.number;
                        if (String(id) !== String(args.ticketId)) continue;
                        const comments = await provider.fetchComments(fullConn, id).catch(() => []);
                        const attachments = await provider.fetchAttachments?.(fullConn, id).catch(() => []) || [];
                        const norm = provider.normalize(raw, comments, attachments);
                        return { ticket: { ...norm, attachments: (norm.attachments || []).map(a => ({ filename: a.filename, mime: a.mime, size: a.size })) } };
                    }
                    return { error: `Ticket ${args.ticketId} not found in the recent window.` };
                } catch (e) {
                    return { error: `get_ticket failed: ${e.message}` };
                }
            }

            // ── Sync + connection CRUD ────────────────────────────────
            case 'ticket_assistant_list_connections': {
                const orgId = await _getUserOrgId(userId);
                if (!orgId) return { error: 'No organization context for the calling user.' };
                const conns = await ticketAssistantStore.listConnections(orgId);
                return { count: conns.length, connections: conns };
            }
            case 'ticket_assistant_get_connection': {
                if (!args.connectionId) return { error: 'connectionId is required' };
                const conn = await _assertOrgAccess(userId, args.connectionId);
                return { connection: conn };
            }
            case 'ticket_assistant_update_connection': {
                if (!args.connectionId) return { error: 'connectionId is required' };
                await _assertOrgAccess(userId, args.connectionId);
                const allowed = ['name', 'displayName', 'syncIntervalMinutes', 'aiSystemPrompt', 'senderBlacklist', 'targetKnowledgeBaseId', 'isPaused'];
                const updates = {};
                for (const k of allowed) if (k in args) updates[k] = args[k];
                if ('isPaused' in args) updates.enabled = !args.isPaused;
                if ('targetKnowledgeBaseId' in args) updates.knowledgeBaseId = args.targetKnowledgeBaseId;
                if ('name' in args) updates.displayName = args.name;
                const updated = await ticketAssistantStore.updateConnection(args.connectionId, updates);
                return { connection: updated };
            }
            case 'ticket_assistant_create_connection': {
                if (!await _isSuperAdminUserId(userId)) {
                    return { error: 'Forbidden — only org admins can create connections.' };
                }
                const orgId = await _getUserOrgId(userId);
                if (!orgId) return { error: 'No organization context for the calling user.' };
                if (!args.provider || !args.knowledgeBaseId || !args.emailAddress || !args.tokens) {
                    return { error: 'provider, knowledgeBaseId, emailAddress and tokens are all required.' };
                }
                const created = await ticketAssistantStore.createConnection({
                    organizationId: orgId,
                    knowledgeBaseId: args.knowledgeBaseId,
                    createdBy: userId,
                    provider: args.provider,
                    emailAddress: args.emailAddress,
                    displayName: args.displayName,
                    tokens: args.tokens,
                    providerConfig: args.providerConfig,
                    authMethod: args.authMethod,
                });
                return { connection: created };
            }
            case 'ticket_assistant_delete_connection': {
                if (!args.connectionId) return { error: 'connectionId is required' };
                if (!await _isSuperAdminUserId(userId)) {
                    return { error: 'Forbidden — only org admins can delete connections.' };
                }
                await _assertOrgAccess(userId, args.connectionId);
                await ticketAssistantStore.deleteConnection(args.connectionId);
                return { deleted: true, connectionId: args.connectionId };
            }
            case 'ticket_assistant_trigger_sync': {
                if (!args.connectionId) return { error: 'connectionId is required' };
                await _assertOrgAccess(userId, args.connectionId);
                const { triggerManualSync } = require('../services/ticketAssistantSyncEngine');
                const outcome = await triggerManualSync(args.connectionId);
                return { outcome };
            }

            default:
                return { error: `Unknown Ticket Assistant tool: ${toolName}` };
        }
    } catch (e) {
        if (e?._tagForbidden || e?._tagForbiddenIsh) return { error: e.message };
        console.error(`[TicketAssistantTools] ${toolName} failed:`, e.message);
        return { error: e.message };
    }
}

module.exports = {
    TICKET_ASSISTANT_TOOLS,
    executeTicketAssistantTool,
    isTicketAssistantTool,
    // Test helpers — pure-function paths exposed for unit tests so we don't
    // have to spin up the full executor.
    _testRunClassify: _runClassify,
    _testRunSummarise: _runSummarise,
};
