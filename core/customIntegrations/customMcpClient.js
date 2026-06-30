/**
 * Custom MCP client — runtime for org-scoped kind='mcp_remote' custom
 * integrations (vendor-hosted HTTP MCP servers, specVersion 1).
 *
 * Mirrors server/core/mcpManager.js (SDK dynamic-import recipe, 5-minute
 * idle connection pool, text-content extraction) but is HTTP-ONLY: this
 * module must NEVER load StdioClientTransport or spawn processes — org
 * admins supply remote URLs, never commands.
 *
 * Security spine:
 *   - ssrfGuard.assertPublicHttpsTarget(mcp.url) before every connect, and
 *     a custom `fetch` (ssrfGuard.safeFetch: per-request resolving check +
 *     pinned dispatcher + redirect:'error') handed to the transport. The
 *     custom fetch matters because the SDK spreads requestInit into its
 *     POST/DELETE fetches but NOT into the GET/SSE stream — only opts.fetch
 *     covers every request path (verified against @modelcontextprotocol/sdk
 *     1.29.0, dist/cjs/client/streamableHttp.js).
 *   - '{{credential.*}}' renders exclusively into the one auth header
 *     derived from mcp.valueTemplate (validator bans it everywhere else).
 *   - Credentials resolve through integrationConnectionStore under provider
 *     'custom:<integrationId>', org-pinned and origin-bound.
 *   - Tool results and thrown errors are scrubbed of credential values
 *     (literal + base64/base64url + urlencoded forms) via the canonical
 *     scrubber in customIntegrationRunner.
 */

const ssrfGuard = require('./ssrfGuard');
// Cycle-safe: the runner's top-level requires only ssrfGuard; it requires
// this module lazily inside its execute path.
const { scrubSecrets: scrubSecretValues } = require('../../integrations/customIntegrationRunner');

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes, same as mcpManager
const MAX_TOOLS = 100;
const MAX_TOOL_SCHEMA_CHARS = 32768;
const MAX_RESULT_CHARS = 30000;

const CREDENTIAL_REF_RE = /\{\{credential\.([A-Za-z0-9_]+)\}\}/g;

/** Lazy-loaded SDK modules (ESM-only — dynamic import, mcpManager recipe). */
let _Client = null;
let _StreamableHTTPClientTransport = null;

async function loadSDK() {
    if (_Client && _StreamableHTTPClientTransport) return;
    const clientMod = await import('@modelcontextprotocol/sdk/client');
    const httpMod = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    _Client = clientMod.Client;
    _StreamableHTTPClientTransport = httpMod.StreamableHTTPClientTransport;
}

// ── Pure helpers (exported for unit tests) ──────────────────────────

/** Pool key shape: `<integrationId>:<userId>`. */
function poolKeyFor(integrationId, userId) {
    return `${integrationId}:${userId}`;
}

/**
 * Render mcp.valueTemplate, substituting {{credential.<key>}} from the
 * decrypted secret object. Throws (key name only — never the value) when a
 * referenced credential is absent.
 */
function renderValueTemplate(template, secretObject) {
    const secrets = (secretObject && typeof secretObject === 'object') ? secretObject : {};
    return String(template || '').replace(CREDENTIAL_REF_RE, (_, key) => {
        const v = secrets[key];
        if (v === undefined || v === null || v === '') {
            throw new Error(`Connection is missing credential "${key}". Reconnect the integration.`);
        }
        return String(v);
    });
}

/**
 * Auth header map for the transport requestInit.
 *   - authStyle 'bearer' → Authorization; 'header' → mcp.header.
 *   - authStyle 'none', or a null secretObject (unauthenticated discovery
 *     probe — some servers list tools without creds), yields no headers.
 */
function buildAuthHeaders(mcp, secretObject) {
    if (!mcp || mcp.authStyle === 'none' || !mcp.valueTemplate) return {};
    if (!secretObject) return {};
    const name = (mcp.authStyle === 'header' && mcp.header) ? mcp.header : 'Authorization';
    return { [name]: renderValueTemplate(mcp.valueTemplate, secretObject) };
}

/**
 * Normalize listTools() output to [{ name, description, inputSchema }],
 * intersect with the definition's toolAllowList (when present), and enforce
 * caps: <= MAX_TOOLS tools, each schema JSON <= MAX_TOOL_SCHEMA_CHARS
 * (oversize tools are dropped, not trimmed). Returns { tools, warnings }.
 */
function normalizeAndFilterTools(rawTools, toolAllowList = null) {
    const warnings = [];
    const list = Array.isArray(rawTools) ? rawTools : [];
    const allow = Array.isArray(toolAllowList) ? new Set(toolAllowList.filter(t => typeof t === 'string')) : null;
    const advertised = new Set();
    const seen = new Set();
    const tools = [];

    for (const t of list) {
        if (!t || typeof t.name !== 'string' || !t.name) continue;
        advertised.add(t.name);
        if (allow && !allow.has(t.name)) continue;
        if (seen.has(t.name)) {
            warnings.push(`Duplicate tool "${t.name}" ignored (first definition kept).`);
            continue;
        }
        const inputSchema = (t.inputSchema && typeof t.inputSchema === 'object')
            ? t.inputSchema
            : { type: 'object', properties: {} };
        let schemaChars;
        try {
            schemaChars = JSON.stringify(inputSchema).length;
        } catch {
            schemaChars = Infinity; // circular/unserializable — treat as oversize
        }
        if (schemaChars > MAX_TOOL_SCHEMA_CHARS) {
            warnings.push(`Tool "${t.name}" dropped: input schema is ${Number.isFinite(schemaChars) ? schemaChars : 'unserializable'} chars (cap ${MAX_TOOL_SCHEMA_CHARS}).`);
            continue;
        }
        seen.add(t.name);
        tools.push({
            name: t.name,
            description: typeof t.description === 'string' ? t.description : '',
            inputSchema,
        });
    }

    if (allow) {
        for (const wanted of allow) {
            // Oversize-dropped tools already carry their own warning above.
            if (!advertised.has(wanted)) warnings.push(`Allow-listed tool "${wanted}" was not advertised by the server.`);
        }
    }
    if (tools.length > MAX_TOOLS) {
        warnings.push(`Server advertised ${tools.length} usable tools; truncated to the first ${MAX_TOOLS}.`);
        tools.length = MAX_TOOLS;
    }
    return { tools, warnings };
}

/**
 * Derive a cint_-safe tool-name segment from a raw vendor MCP tool name
 * (vendor names may carry dashes, dots, uppercase — all illegal in
 * cint_<slug>_<toolName>): lowercase, every char outside [a-z0-9_] becomes
 * '_', runs of '_' collapse to one, a 't_' prefix is added when the result
 * does not start with a letter, capped at 40 chars, trailing '_' trimmed.
 * Pure — the activation route maps rawName → safeToolName and dedupes
 * collisions with numeric suffixes (the original survives in _cint.rawName).
 */
function safeToolName(name) {
    let s = String(name == null ? '' : name).toLowerCase();
    s = s.replace(/[^a-z0-9_]/g, '_');
    if (!/^[a-z]/.test(s)) s = 't_' + s;
    s = s.replace(/_{2,}/g, '_'); // collapse AFTER prefixing so 't_' + '_x' → 't_x'
    s = s.slice(0, 40);
    s = s.replace(/_+$/, '');     // the cap can expose a trailing '_' — trim last
    return s;
}

/**
 * Map a prefixed agent-facing name (cint_<slug>_<tool>) back to the remote
 * tool name; pass already-bare names through. Slugs contain no underscores,
 * so the prefix is unambiguous.
 */
function resolveRemoteToolName(integration, rawToolName) {
    const name = String(rawToolName || '');
    const slug = integration && integration.slug;
    if (slug && name.startsWith(`cint_${slug}_`)) return name.slice(`cint_${slug}_`.length);
    return name;
}

/**
 * Replace every credential value (literal, base64, base64url, urlencoded
 * form) with '[redacted:credential]'. Thin object→values adapter over the
 * canonical scrubber in customIntegrationRunner.
 */
function scrubSecrets(text, secretObject) {
    const out = String(text == null ? '' : text);
    const values = (secretObject && typeof secretObject === 'object')
        ? Object.values(secretObject)
        : [];
    return scrubSecretValues(out, values);
}

/** Truncate to MAX_RESULT_CHARS, marker included in the budget. */
function capResultChars(text, max = MAX_RESULT_CHARS) {
    const s = String(text == null ? '' : text);
    if (s.length <= max) return s;
    const marker = `\n…[truncated ${s.length - max} of ${s.length} chars]`;
    return s.slice(0, Math.max(0, max - marker.length)) + marker;
}

/** mcpManager pattern: join text content items; fall back to JSON. */
function extractTextContent(result) {
    if (result && Array.isArray(result.content)) {
        return result.content
            .filter(c => c && c.type === 'text')
            .map(c => c.text)
            .join('\n');
    }
    try {
        return JSON.stringify(result);
    } catch {
        return String(result);
    }
}

// ── Definition / connection plumbing ────────────────────────────────

function getMcpBlock(integration, { preferActivated = false } = {}) {
    const working = integration && integration.definition;
    const activated = integration && (integration.activatedDefinition || integration.activated_definition);
    const def = preferActivated ? (activated || working) : (working || activated);
    const mcp = def && def.mcp;
    if (!mcp || typeof mcp !== 'object' || typeof mcp.url !== 'string') {
        throw new Error('Integration has no usable mcp definition.');
    }
    return mcp;
}

function getIntegrationOrgId(integration) {
    return integration.orgId !== undefined ? integration.orgId : integration.org_id;
}

/**
 * Resolve + decrypt the credential for this integration, like the REST
 * runner does: provider 'custom:<integrationId>' through
 * resolveConnectionForRun, then getConnectionWithSecret, with org and
 * bound-origin assertions. Returns { secretObject, connectionId }
 * ({ secretObject: null, connectionId: null } when the definition needs no
 * credential).
 */
async function resolveCredential(integration, mcp, userId) {
    if (mcp.authStyle === 'none' || !mcp.valueTemplate) {
        return { secretObject: null, connectionId: null };
    }
    const integrationConnectionStore = require('../../stores/integrationConnectionStore');
    const provider = `custom:${integration.id}`;
    const orgId = getIntegrationOrgId(integration);

    const resolution = await integrationConnectionStore.resolveConnectionForRun({
        runningUserId: userId,
        runningUserOrgId: orgId,
        provider,
    });
    if (!resolution.available || !resolution.connectionId) {
        throw new Error(`No connection configured for integration "${integration.name || integration.slug}". Connect it under Integrations first.`);
    }
    const conn = await integrationConnectionStore.getConnectionWithSecret(resolution.connectionId);
    if (!conn) throw new Error('Connection not found.');

    const connOrgId = conn.orgId !== undefined ? conn.orgId : conn.org_id;
    if (connOrgId !== orgId) {
        throw new Error('Connection is not available for this integration.');
    }
    const meta = conn.secretMeta || conn.secret_meta || {};
    if (meta.boundOrigin !== new URL(mcp.url).origin) {
        throw new Error('Connection is bound to a different endpoint. Reconnect the integration.');
    }
    if (!conn.secret || typeof conn.secret !== 'object') {
        throw new Error('Connection has no stored credential. Reconnect the integration.');
    }
    return { secretObject: conn.secret, connectionId: conn.id };
}

/**
 * Build the StreamableHTTP transport. requestInit carries the rendered auth
 * header plus redirect:'error'; the custom fetch (safeFetch) re-asserts the
 * SSRF guard, pins the dispatcher and forces redirect:'error' on EVERY
 * request — including the GET/SSE stream the SDK builds without requestInit.
 */
function buildTransport(mcp, secretObject) {
    const headers = buildAuthHeaders(mcp, secretObject);
    return new _StreamableHTTPClientTransport(new URL(mcp.url), {
        requestInit: { headers, redirect: 'error' },
        fetch: (url, init) => ssrfGuard.safeFetch(url, init),
    });
}

// ── Connection pool (mcpManager pattern) ────────────────────────────

/** Map<`${integrationId}:${userId}`, { client, transport, url, connectionId, lastUsed, timer }> */
const connectionPool = new Map();

async function closeConnection(poolKey) {
    const entry = connectionPool.get(poolKey);
    if (!entry) return;
    clearTimeout(entry.timer);
    connectionPool.delete(poolKey);
    try {
        await entry.client.close();
    } catch (err) {
        console.warn(`[CustomMCP] Error closing connection ${poolKey}:`, err.message);
    }
}

function armIdleTimer(poolKey, entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => closeConnection(poolKey), IDLE_TIMEOUT_MS);
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
    entry.lastUsed = Date.now();
}

/**
 * Get or create the pooled connection for integration+user. A pooled entry
 * is invalidated when the target url or the resolved connection changed
 * (re-activation / credential swap must not reuse a stale auth header).
 */
async function getPooledClient(integration, mcp, secretObject, userId, connectionId) {
    const poolKey = poolKeyFor(integration.id, userId);
    const existing = connectionPool.get(poolKey);
    if (existing) {
        if (existing.url === mcp.url && existing.connectionId === connectionId) {
            armIdleTimer(poolKey, existing);
            return existing.client;
        }
        await closeConnection(poolKey);
    }

    // SSRF guard on every connect (DNS may have changed since activation).
    await ssrfGuard.assertPublicHttpsTarget(mcp.url);
    await loadSDK();

    const transport = buildTransport(mcp, secretObject);
    const client = new _Client({ name: 'beeflow-custom-integration', version: '1.0.0' });
    await client.connect(transport);

    const entry = { client, transport, url: mcp.url, connectionId, lastUsed: Date.now(), timer: null };
    connectionPool.set(poolKey, entry);
    armIdleTimer(poolKey, entry);
    return client;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Connect to definition.mcp.url, list tools, normalize + allow-list +
 * cap-enforce them, disconnect. Used by the builder's review/test step
 * (works on the WORKING definition copy).
 *
 * @param {object} integration   shaped org_custom_integrations row (kind='mcp_remote')
 * @param {object} [opts]
 * @param {object|null} [opts.secretObject]  decrypted credential for the auth header;
 *                                           null probes unauthenticated
 * @returns {Promise<{ tools: Array<{name,description,inputSchema}>, warnings: string[] }>}
 */
async function discoverTools(integration, { secretObject = null } = {}) {
    const mcp = getMcpBlock(integration);
    await ssrfGuard.assertPublicHttpsTarget(mcp.url);
    await loadSDK();

    let client = null;
    try {
        const transport = buildTransport(mcp, secretObject);
        client = new _Client({ name: 'beeflow-custom-integration', version: '1.0.0' });
        await client.connect(transport);
        const listed = await client.listTools();
        return normalizeAndFilterTools(listed && listed.tools, Array.isArray(mcp.toolAllowList) ? mcp.toolAllowList : null);
    } catch (err) {
        throw new Error(scrubSecrets(err && err.message ? err.message : String(err), secretObject));
    } finally {
        if (client) {
            try { await client.close(); } catch (_) { /* best effort */ }
        }
    }
}

/**
 * Call one tool on the remote MCP server on behalf of `userId`, resolving
 * the org connection's credential, reusing a pooled connection, and
 * returning scrubbed text capped at MAX_RESULT_CHARS.
 *
 * @param {object} integration  shaped row; the ACTIVATED definition is preferred
 * @param {string} rawToolName  remote tool name, or the prefixed cint_<slug>_<name>
 * @param {object} args         tool arguments (already schema-checked upstream)
 * @param {string} userId       running user (pool identity + BYO resolution)
 */
async function callTool(integration, rawToolName, args, userId) {
    if (!userId) throw new Error('User ID required for custom MCP tool calls');
    const mcp = getMcpBlock(integration, { preferActivated: true });
    const toolName = resolveRemoteToolName(integration, rawToolName);

    if (Array.isArray(mcp.toolAllowList) && mcp.toolAllowList.length > 0 && !mcp.toolAllowList.includes(toolName)) {
        throw new Error(`Tool "${toolName}" is not allowed for this integration.`);
    }

    const { secretObject, connectionId } = await resolveCredential(integration, mcp, userId);
    const client = await getPooledClient(integration, mcp, secretObject, userId, connectionId);

    try {
        const result = await client.callTool({ name: toolName, arguments: args || {} });
        return scrubSecrets(capResultChars(extractTextContent(result)), secretObject);
    } catch (err) {
        // Failed call → drop the pooled connection so the next call reconnects.
        await closeConnection(poolKeyFor(integration.id, userId));
        const msg = scrubSecrets(err && err.message ? err.message : String(err), secretObject);
        console.error(`[CustomMCP] Tool call failed: ${integration.slug || integration.id}/${toolName}:`, msg);
        throw new Error(msg);
    }
}

/** Close every pooled connection (shutdown / tests). */
async function closeAll() {
    for (const key of [...connectionPool.keys()]) {
        await closeConnection(key);
    }
}

module.exports = {
    discoverTools,
    callTool,
    closeAll,
    // Pure helpers, exported for unit tests:
    normalizeAndFilterTools,
    renderValueTemplate,
    buildAuthHeaders,
    poolKeyFor,
    safeToolName,
    resolveRemoteToolName,
    scrubSecrets,
    capResultChars,
    extractTextContent,
    MAX_TOOLS,
    MAX_TOOL_SCHEMA_CHARS,
    MAX_RESULT_CHARS,
};
