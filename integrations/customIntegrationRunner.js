/**
 * Custom Integration Runner — hardened generic executor for org-scoped
 * custom integrations (AI Integration Builder).
 *
 * Executes 'rest' definitions (specVersion 1) declaratively: every request is
 * pinned to the activated definition's api.baseUrl origin, SSRF-checked via
 * ssrfGuard (DNS-validated + pinned dispatcher), and credentials are injected
 * exclusively through auth.valueTemplate at the last moment. 'mcp_remote'
 * integrations are delegated to customMcpClient.
 *
 * Tool names: cint_<slug>_<toolName> where slug matches ^[a-z0-9]{4,16}$
 * (no underscores — parsing is unambiguous at the first '_' after 'cint_').
 *
 * Fail-closed everywhere: any check that cannot be positively confirmed
 * refuses with a friendly, sanitized error object ({ error }) in the same
 * convention afasTools uses. Secret values (literal, base64 and URL-encoded
 * forms) are scrubbed from every returned string.
 *
 * Stores are required lazily inside the execute path so requiring this module
 * never touches the DB (pure helpers stay unit-testable).
 */

const ssrfGuard = require('../core/customIntegrations/ssrfGuard');

const SLUG_RE = /^[a-z0-9]{4,16}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;
const EXACT_PLACEHOLDER_RE = /^\{([A-Za-z0-9_]+)\}$/;
const PATH_PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;
const CREDENTIAL_REF_RE = /\{\{credential\.([A-Za-z0-9_]+)\}\}/g;

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_RAW_BYTES = 262144;           // hard cap on raw response bytes
const MAX_STRING_ARG_CHARS = 2000;      // runtime caps from the spec
const MAX_ARRAY_ARG_ITEMS = 100;
const DEFAULT_TIMEOUT_MS = 20000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RESPONSE_CHARS = 30000;
const MIN_RESPONSE_CHARS = 1000;
const MAX_ERROR_MESSAGE_CHARS = 300;
const REDACTED = '[redacted:credential]';

// Mirrors validateCustomIntegration's denylist (kept in sync by hand — the
// validator is not imported so requiring the runner stays dependency-light).
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const DENIED_HEADERS = new Set([
    'host', 'authorization', 'cookie', 'set-cookie', 'content-length',
    'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer',
]);
const DENIED_HEADER_PREFIXES = ['proxy-', 'x-forwarded-'];

// ssrfGuard's thrown messages are generic by contract and safe to surface.
const SAFE_GUARD_ERRORS = new Set([
    'Invalid URL.',
    'Only https:// URLs are allowed.',
    'Only http(s) URLs are allowed.',
    'URLs with embedded credentials are not allowed.',
    'Target address is not allowed.',
    'Target host could not be resolved.',
]);

// ─── Name parsing ──────────────────────────────────────────────

function isCustomIntegrationTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('cint_');
}

/**
 * 'cint_<slug>_<toolName>' → { slug, toolName } or null. The slug is the
 * segment between 'cint_' and the NEXT '_' — slugs never contain underscores,
 * so the split is unambiguous.
 */
function parsePrefixedName(toolName) {
    if (!isCustomIntegrationTool(toolName)) return null;
    const rest = toolName.slice('cint_'.length);
    const sep = rest.indexOf('_');
    if (sep === -1) return null;
    const slug = rest.slice(0, sep);
    const name = rest.slice(sep + 1);
    if (!SLUG_RE.test(slug) || !TOOL_NAME_RE.test(name)) return null;
    return { slug, toolName: name };
}

// ─── Pure helpers (exported for tests) ─────────────────────────

function clampInt(v, lo, hi, fallback) {
    const n = Number.isInteger(v) ? v : fallback;
    return Math.min(hi, Math.max(lo, n));
}

/**
 * Hard-truncate a string to `max` chars. Returns { text, truncated }.
 */
function truncateBudget(text, max) {
    const s = typeof text === 'string' ? text : String(text ?? '');
    const cap = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_RESPONSE_CHARS;
    if (s.length <= cap) return { text: s, truncated: false };
    return { text: s.slice(0, cap), truncated: true };
}

/**
 * Replace every literal secret value (length >= 6), its base64/base64url
 * encodings and its encodeURIComponent form with a redaction marker. Longest
 * forms first so partial overlaps cannot leave fragments behind. Canonical
 * implementation — customMcpClient delegates here.
 */
function scrubSecrets(text, values) {
    if (typeof text !== 'string' || !text) return text;
    const forms = new Set();
    for (const v of Array.isArray(values) ? values : []) {
        if (typeof v !== 'string' || v.length < 6) continue;
        forms.add(v);
        forms.add(Buffer.from(v, 'utf8').toString('base64'));
        forms.add(Buffer.from(v, 'utf8').toString('base64url'));
        forms.add(encodeURIComponent(v));
    }
    let out = text;
    for (const f of [...forms].sort((a, b) => b.length - a.length)) {
        if (f.length >= 6 && out.includes(f)) out = out.split(f).join(REDACTED);
    }
    return out;
}

/**
 * Validate args against a tool's restricted JSON schema. REJECT, never
 * coerce: unknown props, missing required, wrong types, strings > 2000,
 * arrays > 100, enum mismatches. Returns { ok, errors: string[] }.
 * A missing/invalid schema means "no arguments accepted".
 */
function validateArgsAgainstSchema(schema, args) {
    const errors = [];
    const a = args == null ? {} : args;
    if (typeof a !== 'object' || Array.isArray(a)) {
        return { ok: false, errors: ['Arguments must be a JSON object.'] };
    }
    const s = (schema && typeof schema === 'object' && !Array.isArray(schema)) ? schema : {};
    const props = (s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties)) ? s.properties : {};
    const required = Array.isArray(s.required) ? s.required : [];

    for (const r of required) {
        if (typeof r === 'string' && a[r] === undefined) errors.push(`Missing required argument "${r}".`);
    }

    const checkScalar = (label, value, type, enumList) => {
        if (type === 'string') {
            if (typeof value !== 'string') { errors.push(`Argument ${label} must be a string.`); return; }
            if (value.length > MAX_STRING_ARG_CHARS) errors.push(`Argument ${label} exceeds ${MAX_STRING_ARG_CHARS} characters.`);
            if (Array.isArray(enumList) && !enumList.includes(value)) errors.push(`Argument ${label} must be one of: ${enumList.join(', ')}.`);
        } else if (type === 'integer') {
            if (!Number.isInteger(value)) errors.push(`Argument ${label} must be an integer.`);
        } else if (type === 'number') {
            if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`Argument ${label} must be a number.`);
        } else if (type === 'boolean') {
            if (typeof value !== 'boolean') errors.push(`Argument ${label} must be a boolean.`);
        } else {
            errors.push(`Argument ${label} has an unsupported declared type.`);
        }
    };

    for (const [key, value] of Object.entries(a)) {
        if (value === undefined) continue;
        const prop = props[key];
        if (!prop || typeof prop !== 'object' || Array.isArray(prop)) {
            errors.push(`Unknown argument "${key}".`);
            continue;
        }
        if (prop.type === 'array') {
            if (!Array.isArray(value)) { errors.push(`Argument "${key}" must be an array.`); continue; }
            if (value.length > MAX_ARRAY_ARG_ITEMS) { errors.push(`Argument "${key}" exceeds ${MAX_ARRAY_ARG_ITEMS} items.`); continue; }
            const items = (prop.items && typeof prop.items === 'object') ? prop.items : {};
            value.forEach((item, i) => checkScalar(`"${key}[${i}]"`, item, items.type, items.enum));
        } else {
            checkScalar(`"${key}"`, value, prop.type, prop.enum);
        }
    }
    return { ok: errors.length === 0, errors };
}

/**
 * Build the final request URL for a tool call. Origin-pinned: path params
 * are encodeURIComponent'd, the substituted path is re-checked, the base
 * URL's path prefix is preserved (baseUrl https://h/v2 + '/x' → /v2/x), and
 * the resulting URL MUST share the baseUrl origin. Throws generic-message
 * errors (no secrets ever flow through here).
 */
function buildToolUrl(def, tool, args = {}) {
    const base = new URL(def.api.baseUrl);
    const template = String(tool.pathTemplate || '');
    const path = template.replace(PATH_PLACEHOLDER_RE, (_, name) => {
        const v = args[name];
        if (v === undefined || v === null) throw new Error(`Missing required path parameter "${name}".`);
        return encodeURIComponent(String(v));
    });
    // Re-checked AFTER substitution: encodeURIComponent leaves '.' bare, so a
    // '../admin' argument still reads as '..' here and is rejected.
    if (!/^\/(?!\/)/.test(path)) throw new Error('Resolved request path is invalid.');
    if (path.includes('..')) throw new Error('Resolved request path contains a traversal sequence.');
    // '\' becomes '/' under WHATWG URL parsing ('/\evil.com' → '//evil.com').
    if (/[?#\s\\]/.test(path)) throw new Error('Resolved request path is invalid.');

    const basePath = base.pathname.replace(/\/+$/, '');
    const url = new URL(basePath + path, base.origin);

    const qs = new URLSearchParams();
    const queryMap = (tool.query && typeof tool.query === 'object' && !Array.isArray(tool.query)) ? tool.query : {};
    for (const [key, raw] of Object.entries(queryMap)) {
        if (typeof raw === 'string') {
            const m = raw.match(EXACT_PLACEHOLDER_RE);
            if (m) {
                const v = args[m[1]];
                if (v === undefined || v === null) continue; // param-valued entries omitted when arg absent
                qs.append(key, Array.isArray(v) ? v.map(String).join(',') : String(v));
                continue;
            }
        }
        qs.append(key, String(raw)); // literals always sent
    }
    const q = qs.toString();
    if (q) url.search = q;

    if (url.origin !== base.origin) throw new Error('Resolved URL escaped the API origin.');
    return url;
}

/**
 * Render the auth value: 'basic' derives the Basic header from
 * credential.username/password; the templated types replace
 * {{credential.<key>}} with secret values. Thrown messages never include
 * secret material.
 */
function renderAuthValue(authCfg, secretObj) {
    const secrets = (secretObj && typeof secretObj === 'object') ? secretObj : {};
    if (authCfg.type === 'basic') {
        const u = secrets.username;
        const p = secrets.password;
        if (typeof u !== 'string' || typeof p !== 'string') {
            throw new Error('Stored credentials are incomplete — re-enter the username and password for this integration.');
        }
        return 'Basic ' + Buffer.from(`${u}:${p}`, 'utf8').toString('base64');
    }
    const template = authCfg.valueTemplate;
    if (typeof template !== 'string' || !template) {
        throw new Error('The integration auth template is missing.');
    }
    return template.replace(CREDENTIAL_REF_RE, (_, key) => {
        const v = secrets[key];
        if (typeof v !== 'string' || v === '') {
            throw new Error(`Stored credentials are missing "${key}" — re-enter credentials for this integration.`);
        }
        return v;
    });
}

/**
 * Substitute exact "{param}" string leaves of a JSON body template with the
 * TYPED argument value (a "{amount}" leaf with a numeric arg becomes a
 * number). Strings merely containing braces are literals. Object keys whose
 * (optional) argument is absent are dropped; absent array slots become null.
 */
function buildJsonBody(node, args) {
    if (typeof node === 'string') {
        const m = node.match(EXACT_PLACEHOLDER_RE);
        return m ? args[m[1]] : node;
    }
    if (Array.isArray(node)) {
        return node.map((v) => {
            const r = buildJsonBody(v, args);
            return r === undefined ? null : r;
        });
    }
    if (node && typeof node === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(node)) {
            const r = buildJsonBody(v, args);
            if (r !== undefined) out[k] = r;
        }
        return out;
    }
    return node;
}

function getByDotPath(obj, path) {
    let cur = obj;
    for (const seg of String(path).split('.')) {
        if (cur === null || typeof cur !== 'object') return undefined;
        cur = cur[seg];
        if (cur === undefined) return undefined;
    }
    return cur;
}

/**
 * Short, sanitized message out of a vendor error body (JSON or XML-ish) —
 * never the raw body, never the URL/headers (afasTools convention).
 */
function extractErrorMessage(bodyText) {
    if (!bodyText || typeof bodyText !== 'string') return null;
    const t = bodyText.trim();
    let message = null;
    if (t.startsWith('{') || t.startsWith('[')) {
        try {
            const data = JSON.parse(t);
            const obj = Array.isArray(data) ? data[0] : data;
            if (obj && typeof obj === 'object') {
                message = obj.message || obj.error_description || obj.detail || obj.title
                    || (typeof obj.error === 'string' ? obj.error : (obj.error && obj.error.message))
                    || null;
            }
        } catch { /* not JSON after all */ }
    } else {
        const xmlMatch = t.match(/<(?:message|error|title)>([\s\S]*?)<\//i);
        if (xmlMatch) message = xmlMatch[1];
    }
    if (!message || typeof message !== 'string') return null;
    return message.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_MESSAGE_CHARS) || null;
}

// ─── Response reading ──────────────────────────────────────────

/** Stream the body, aborting beyond capBytes. Returns a Buffer. */
async function readBodyCapped(response, capBytes) {
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > capBytes) {
            await reader.cancel().catch(() => {});
            const err = new Error('Response exceeded the size limit.');
            err.tooLarge = true;
            throw err;
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
}

// ─── Execution ─────────────────────────────────────────────────

/**
 * Execute a cint_<slug>_<tool> call. Returns afasTools-style result objects:
 * { error } on refusal/failure, or { status, result, truncated?, message? }
 * (result is the truncated serialized response). Every returned string is
 * scrubbed of credential material.
 *
 * @param {string} prefixedName  full tool name, e.g. cint_ab12cd34ef5_list_invoices
 * @param {object} args          model-provided arguments
 * @param {object} opts
 * @param {string} opts.userId               running user (org + credential resolution)
 * @param {object} [opts.draftIntegration]   shaped row for the builder's test
 *                                           route — skips status + capability
 *                                           checks (the route pre-authorizes)
 *                                           and runs the WORKING definition
 * @param {string} [opts.connectionOverrideId] explicit connection (test route)
 * @param {boolean} [opts.unattended]        automated run (refused for now)
 */
async function executeCustomIntegrationTool(prefixedName, args, {
    userId = null, draftIntegration = null, connectionOverrideId = null, unattended = false,
} = {}) {
    let secretValues = [];
    const fail = (msg) => ({ error: scrubSecrets(String(msg), secretValues) });
    try {
        // 0. Kill switch — the same dark-ship flag that gates injection and
        //    the builder routes. Checked here too so a stale tool list (or any
        //    future injection path) can never execute when the flag is off.
        const { isCustomIntegrationsEnabled } = require('../core/customIntegrations/featureFlag');
        if (!(await isCustomIntegrationsEnabled())) {
            return fail('Custom integrations are disabled.');
        }

        // 1. Parse + load + slug re-assert (a draftIntegration for another
        //    slug must not be reachable through this name).
        const parsed = parsePrefixedName(prefixedName);
        if (!parsed) return fail('Unknown custom integration tool.');
        const store = require('../stores/orgCustomIntegrationStore');
        const connStore = require('../stores/integrationConnectionStore');
        const integration = draftIntegration || await store.getBySlug(parsed.slug);
        if (!integration) return fail('This custom integration no longer exists.');
        if (typeof integration.slug !== 'string' || !prefixedName.startsWith(`cint_${integration.slug}_`)) {
            return fail('Unknown custom integration tool.');
        }

        // 2. Org isolation: the runner only ever acts inside the calling
        //    user's own org (store rows are shaped camelCase: orgId).
        if (!userId) return fail('User context required for custom integrations.');
        let user = null;
        try { user = await require('../stores/userStore').getUser(userId); } catch (_) { user = null; }
        if (!user) return fail('User context required for custom integrations.');
        const userOrg = connStore.resolveOrgId(user.organizationId);
        const integrationOrg = connStore.resolveOrgId(integration.orgId);
        if (integrationOrg !== userOrg) return fail('This custom integration belongs to a different organization.');
        if (!draftIntegration && integration.status !== 'active') {
            return fail('This custom integration is not active.');
        }

        // 3. No unattended runs yet (routines/AI tasks need per-run consent design).
        if (unattended === true) return fail('Custom integrations are not available in automated runs yet.');

        // 5. Capability backstop (fail-closed; deliberately BEFORE the
        //    mcp_remote delegation so no kind bypasses entitlements). Skipped
        //    in draft mode — the builder test route pre-authorizes admins.
        //    NOTE: until the entitlements phase registers 'custom:<uuid>'
        //    capability ids, hasCapability returns false (unknown cap) and
        //    every non-draft call refuses here.
        if (!draftIntegration) {
            let allowed = false;
            try {
                allowed = await require('../core/entitlements')
                    .hasCapability(`custom:${integration.id}`, { userId, orgId: userOrg });
            } catch (_) {
                allowed = false;
            }
            if (!allowed) return fail('This custom integration is not enabled for your account. An org admin can enable it.');
        }

        // 4. mcp_remote → delegate, then apply the same scrub/truncate.
        if (integration.kind === 'mcp_remote') {
            let client;
            try {
                client = require('../core/customIntegrations/customMcpClient');
            } catch (_) {
                return fail('Remote MCP integrations are not available yet.');
            }
            // Vendor MCP tool names may contain characters illegal in cint_
            // names (dashes, uppercase). Activation stores the original under
            // _cint.rawName on each tools_cache entry, so map the prefixed
            // name back through the cache before delegating. No cache entry ⇒
            // the tool is not part of this integration's frozen tool set.
            const cacheEntry = (Array.isArray(integration.toolsCache) ? integration.toolsCache : [])
                .find(e => e?.function?.name === prefixedName);
            if (!cacheEntry) {
                return fail(`Tool "${parsed.toolName}" is not part of this integration. Re-activate the integration to refresh its tools.`);
            }
            const remoteName = cacheEntry._cint?.rawName || parsed.toolName;
            const res = await client.callTool(integration, remoteName, args || {}, userId);
            if (res && typeof res === 'object' && typeof res.error === 'string') {
                return fail(truncateBudget(res.error, DEFAULT_MAX_RESPONSE_CHARS).text);
            }
            const serialized = typeof res === 'string' ? res : JSON.stringify(res ?? null);
            const { text, truncated } = truncateBudget(serialized, DEFAULT_MAX_RESPONSE_CHARS);
            const out = { result: scrubSecrets(text, secretValues) };
            if (truncated) out.truncated = true;
            return out;
        }

        // 6. Definition: active runs the FROZEN activated_definition only;
        //    draft mode runs the working copy.
        const def = draftIntegration ? integration.definition : integration.activatedDefinition;
        if (!def || typeof def !== 'object' || !def.api || typeof def.api !== 'object' || !Array.isArray(def.tools)) {
            return fail('This custom integration has no runnable definition.');
        }
        let baseOrigin;
        try { baseOrigin = new URL(def.api.baseUrl).origin; } catch { return fail('The integration base URL is invalid.'); }
        const tool = def.tools.find(t => t && typeof t === 'object' && t.name === parsed.toolName);
        if (!tool) return fail(`Tool "${parsed.toolName}" is not part of this integration.`);

        // 7. Method gate: non-GET requires the allow_writes activation flag —
        //    strict for drafts too.
        const method = typeof tool.method === 'string' ? tool.method.toUpperCase() : '';
        if (!METHODS.has(method)) return fail('This tool has an invalid HTTP method.');
        if (method !== 'GET' && integration.allowWrites !== true) {
            return fail('This integration is read-only — write operations were not enabled at activation.');
        }

        // 8. Arguments: reject, never coerce.
        const check = validateArgsAgainstSchema(tool.parameters, args);
        if (!check.ok) return fail(`Invalid arguments: ${check.errors.join(' ')}`);
        const toolArgs = (args && typeof args === 'object') ? args : {};

        // 9. Credential resolution (provider 'custom:<integrationId>').
        const auth = (def.auth && typeof def.auth === 'object') ? def.auth : { type: 'none' };
        let connection = null;
        let secret = null;
        if (auth.type !== 'none') {
            const provider = `custom:${integration.id}`;
            if (connectionOverrideId) {
                connection = await connStore.getConnectionWithSecret(connectionOverrideId);
                if (!connection || connection.provider !== provider) {
                    return fail('The selected connection does not belong to this integration.');
                }
            } else {
                const resolution = await connStore.resolveConnectionForRun({
                    runningUserId: userId,
                    runningUserOrgId: userOrg,
                    runningUserGroups: [],
                    ownerUserId: userId,
                    provider,
                });
                if (!resolution.available || !resolution.connectionId) {
                    return fail('No credentials connected for this integration. Add them under Settings → Integrations.');
                }
                connection = await connStore.getConnectionWithSecret(resolution.connectionId);
            }
            if (!connection || connection.status !== 'active') {
                return fail('The stored credentials are unavailable — re-enter credentials for this integration.');
            }
            // Hard asserts: same org, and the credential is pinned to this
            // exact API origin (set when the credential was entered).
            if (connStore.resolveOrgId(connection.orgId) !== integrationOrg) {
                return fail('The stored credentials belong to a different organization.');
            }
            if (!connection.secretMeta || connection.secretMeta.boundOrigin !== baseOrigin) {
                return fail('The stored credential is bound to a different API host — re-enter credentials for this integration.');
            }
            secret = connection.secret;
            if (!secret || typeof secret !== 'object') {
                return fail('The stored credentials could not be read — re-enter credentials for this integration.');
            }
            secretValues = Object.values(secret).filter(v => typeof v === 'string');
        }

        // 10. URL build (origin pin asserted inside) + resolving SSRF check.
        let url;
        try {
            url = buildToolUrl(def, tool, toolArgs);
        } catch (e) {
            return fail(e.message); // buildToolUrl messages are generic
        }
        try {
            await ssrfGuard.assertPublicHttpsTarget(url.href);
        } catch (e) {
            return fail(SAFE_GUARD_ERRORS.has(e?.message) ? e.message : 'Target address is not allowed.');
        }

        // 11/12. Headers (definition literals), JSON body, then auth LAST.
        // Defense in depth: re-apply the validator's header denylist here —
        // the runner owns transport/auth/proxy headers even if a definition
        // somehow reached storage without passing validation.
        const headers = {};
        const applyHeaders = (map) => {
            if (!map || typeof map !== 'object' || Array.isArray(map)) return;
            for (const [k, v] of Object.entries(map)) {
                if (typeof v !== 'string' || !HEADER_NAME_RE.test(k)) continue;
                const n = k.toLowerCase();
                if (DENIED_HEADERS.has(n) || DENIED_HEADER_PREFIXES.some(p => n.startsWith(p))) continue;
                headers[k] = v;
            }
        };
        applyHeaders(def.api.defaultHeaders);
        applyHeaders(tool.headers);
        let body;
        // fetch() rejects GET bodies outright, so a (validator-warned) GET
        // body template is dropped rather than failing the whole call.
        if (tool.body && tool.body.mode === 'json' && method !== 'GET') {
            body = JSON.stringify(buildJsonBody(tool.body.template, toolArgs) ?? {});
            if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) {
                headers['Content-Type'] = 'application/json';
            }
        }
        if (auth.type !== 'none') {
            let authValue;
            try {
                authValue = renderAuthValue(auth, secret);
            } catch (e) {
                return fail(e.message);
            }
            secretValues.push(authValue); // scrub composed forms (e.g. Basic b64) too
            if (auth.type === 'bearer' || auth.type === 'basic') headers['Authorization'] = authValue;
            else if (auth.type === 'header') headers[String(auth.header)] = authValue;
            else if (auth.type === 'query') url.searchParams.append(String(auth.queryParam), authValue);
        }

        console.log(`[CustomIntegration] ${integration.slug}.${parsed.toolName} (${method})`);

        const timeoutMs = clampInt(def.api.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        let response;
        try {
            response = await ssrfGuard.safeFetch(url.href, { method, headers, body, signal: controller.signal });
        } catch (err) {
            if ((err && err.name === 'AbortError') || controller.signal.aborted) {
                return fail(`The request timed out after ${Math.round(timeoutMs / 1000)}s.`);
            }
            // Never echo fetch internals — they can carry the URL (and with
            // query auth, the credential).
            return fail(SAFE_GUARD_ERRORS.has(err?.message) ? err.message : 'Could not reach the API host.');
        } finally {
            clearTimeout(timer);
        }

        // 13/14. Response: capped read, sanitized errors, budgeted result.
        let raw;
        try {
            raw = await readBodyCapped(response, MAX_RAW_BYTES);
        } catch (e) {
            return fail(e && e.tooLarge
                ? `The response exceeded the ${Math.round(MAX_RAW_BYTES / 1024)} KB limit. Narrow the request (filters, pagination).`
                : 'Failed to read the API response.');
        }
        if (!response.ok) {
            const detail = extractErrorMessage(raw.toString('utf8'));
            return fail(detail ? `The API returned HTTP ${response.status}: ${detail}` : `The API returned HTTP ${response.status}.`);
        }

        // 16. Best-effort usage stamp.
        if (connection) {
            try { await connStore.touchLastUsed(connection.id); } catch (_) { /* best effort */ }
        }

        const maxChars = clampInt(def.api.maxResponseChars, MIN_RESPONSE_CHARS, DEFAULT_MAX_RESPONSE_CHARS, DEFAULT_MAX_RESPONSE_CHARS);
        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('json')) { // application/json + */*+json variants
            let parsedBody;
            try {
                parsedBody = JSON.parse(raw.toString('utf8'));
            } catch {
                return fail('The API returned invalid JSON.');
            }
            let extracted = parsedBody;
            if (typeof tool.resultPath === 'string' && tool.resultPath) {
                const v = getByDotPath(parsedBody, tool.resultPath);
                if (v !== undefined) extracted = v; // missing path → whole body (budget still caps it)
            }
            const { text, truncated } = truncateBudget(JSON.stringify(extracted) ?? 'null', maxChars);
            const out = { status: response.status, result: scrubSecrets(text, secretValues) };
            if (truncated) {
                out.truncated = true;
                out.message = `Response truncated to ${maxChars} characters. Narrow the request (filters, pagination) for complete data.`;
            }
            return out;
        }
        if (contentType.startsWith('text/')) {
            const { text, truncated } = truncateBudget(raw.toString('utf8'), maxChars);
            const out = { status: response.status, result: scrubSecrets(text, secretValues) };
            if (truncated) out.truncated = true;
            return out;
        }
        // Binary/unknown: metadata only — never raw bytes into the context.
        return { status: response.status, contentType: contentType || 'unknown', bytes: raw.length };
    } catch (err) {
        // Unexpected failure: log a scrubbed message, return a fixed string
        // (never err.message — it could carry a URL with query auth).
        console.warn(`[CustomIntegration] ${String(prefixedName).slice(0, 80)} failed: ${scrubSecrets(String(err && err.message), secretValues)}`);
        return { error: 'Custom integration request failed.' };
    }
}

module.exports = {
    isCustomIntegrationTool,
    parsePrefixedName,
    executeCustomIntegrationTool,
    // Pure helpers exported for unit tests.
    buildToolUrl,
    renderAuthValue,
    validateArgsAgainstSchema,
    scrubSecrets,
    truncateBudget,
    // Tests / debugging only
    _internals: { buildJsonBody, extractErrorMessage, getByDotPath, clampInt, readBodyCapped },
};
