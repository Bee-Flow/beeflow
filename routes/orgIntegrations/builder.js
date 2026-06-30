/**
 * AI Integration Builder — org-admin REST API + lifecycle.
 *
 * Mounted at /api/organizations/:orgId/custom-integrations (mergeParams).
 * The 'ai_integration_builder' beta capability gate AND the dark-ship kill
 * switch (customIntegrationsFeatureGate) are applied AT MOUNT in index.js —
 * not duplicated here. The kill switch IS re-checked inside the test-call
 * handler (cheap defense for the one endpoint that fires real credentialed
 * HTTP requests).
 *
 * Router-level middleware order:
 *   1. session auth (repo convention — see routes/integrations/connections.js)
 *   2. org admin for :orgId (adminRoutes.requireOrgAdmin factory)
 *   3. ':id' IDOR loader — 404 on missing OR cross-org rows (404, never 403:
 *      no existence oracle), attaches req.customIntegration.
 *
 * Every mutation writes an access-audit row via userStore.logAccessAudit with
 * field NAMES / versions / statuses only — never secret values, tool args or
 * response bodies.
 *
 * Stores and heavy modules are required lazily inside handlers (runner
 * convention) so requiring this module never touches the DB and the exported
 * pure helpers stay unit-testable.
 */

const express = require('express');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { validateCustomIntegration, deriveOpenAiTools } = require('../../core/customIntegrations/validateCustomIntegration');
const { isCustomIntegrationsEnabled } = require('../../core/customIntegrations/featureFlag');
const { executeCustomIntegrationTool } = require('../../integrations/customIntegrationRunner');

const router = express.Router({ mergeParams: true });

const KINDS = new Set(['rest', 'mcp_remote']);
const MAX_NAME_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_CREDENTIAL_VALUE_CHARS = 4096;
// Mirrors the runner/validator tool-name shape (combined max stays well under
// the validator's 64-char cint_<slug>_<name> cap for any legal slug).
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;
const MAX_TOOL_NAME_CHARS = 41;

// ── Lazy store accessors (never required at module load) ────────────
function store() { return require('../../stores/orgCustomIntegrationStore'); }
function connStore() { return require('../../stores/integrationConnectionStore'); }
function userStore() { return require('../../stores/userStore'); }

// ── Pure helpers (exported for unit tests) ──────────────────────────

/**
 * Determine the declared credential fields, the origin the secret gets bound
 * to, and the integration_connections `kind` for a DRAFT definition.
 *
 *   rest       → fields from def.auth.credentials, origin of def.api.baseUrl,
 *                kind 'basic' when auth.type==='basic', else 'api_key'
 *   mcp_remote → fields from def.mcp.credentials, origin of def.mcp.url,
 *                kind 'mcp'
 *
 * Returns { fields: string[], boundOrigin, connectionKind, error: null } or
 * { error: string } when the draft is not far enough along.
 */
function credentialSpecFor(kind, definition) {
    const def = (definition && typeof definition === 'object' && !Array.isArray(definition)) ? definition : {};
    const keyList = (creds) => (Array.isArray(creds) ? creds : [])
        .map(c => (c && typeof c === 'object') ? c.key : null)
        .filter(k => typeof k === 'string' && k);

    if (kind === 'mcp_remote') {
        const mcp = (def.mcp && typeof def.mcp === 'object' && !Array.isArray(def.mcp)) ? def.mcp : null;
        let boundOrigin = null;
        try { boundOrigin = new URL(mcp.url).origin; } catch (_) { boundOrigin = null; }
        if (!mcp || !boundOrigin) {
            return { error: 'The draft definition needs a valid mcp.url before credentials can be stored.' };
        }
        return { fields: keyList(mcp.credentials), boundOrigin, connectionKind: 'mcp', error: null };
    }

    // kind === 'rest'
    const api = (def.api && typeof def.api === 'object' && !Array.isArray(def.api)) ? def.api : null;
    let boundOrigin = null;
    try { boundOrigin = new URL(api.baseUrl).origin; } catch (_) { boundOrigin = null; }
    if (!api || !boundOrigin) {
        return { error: 'The draft definition needs a valid api.baseUrl before credentials can be stored.' };
    }
    const auth = (def.auth && typeof def.auth === 'object' && !Array.isArray(def.auth)) ? def.auth : {};
    return {
        fields: keyList(auth.credentials),
        boundOrigin,
        connectionKind: auth.type === 'basic' ? 'basic' : 'api_key',
        error: null,
    };
}

/**
 * Validate a credentials `values` payload against the declared fields:
 * object map only, no unknown keys, string values, each <= 4096 chars,
 * at least one field. Returns { ok, errors: string[] }.
 */
function checkCredentialValues(values, declaredFields) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
        return { ok: false, errors: ['values must be an object map of credential fields.'] };
    }
    const errors = [];
    const keys = Object.keys(values);
    if (keys.length === 0) errors.push('values must contain at least one credential field.');
    const declared = new Set(Array.isArray(declaredFields) ? declaredFields : []);
    for (const k of keys) {
        if (!declared.has(k)) {
            errors.push(`Unknown credential field "${k}".`);
        } else if (typeof values[k] !== 'string') {
            errors.push(`Credential field "${k}" must be a string.`);
        } else if (values[k].length > MAX_CREDENTIAL_VALUE_CHARS) {
            errors.push(`Credential field "${k}" exceeds ${MAX_CREDENTIAL_VALUE_CHARS} characters.`);
        }
    }
    return { ok: errors.length === 0, errors };
}

/**
 * Coerce an arbitrary remote MCP tool name into the runner's tool-name shape
 * (^[a-z][a-z0-9_]{2,40}$): lowercase, non [a-z0-9_] runs collapse to '_',
 * leading digit/underscore gets a 't_' prefix, short names are padded, long
 * names truncated to 41 chars.
 */
function safeToolName(rawName) {
    let s = String(rawName == null ? '' : rawName)
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!/^[a-z]/.test(s)) s = s ? `t_${s}` : 'tool';
    if (s.length < 3) s = s.padEnd(3, '0');
    return s.slice(0, MAX_TOOL_NAME_CHARS);
}

/**
 * Numeric-suffix dedupe within MAX_TOOL_NAME_CHARS: 'name', 'name_2',
 * 'name_3', … Mutates `taken` (a Set) so successive calls stay unique.
 */
function dedupeToolName(name, taken) {
    let candidate = name;
    let n = 2;
    while (taken.has(candidate)) {
        const suffix = `_${n++}`;
        candidate = name.slice(0, MAX_TOOL_NAME_CHARS - suffix.length) + suffix;
    }
    taken.add(candidate);
    return candidate;
}

/**
 * Build the activation tools_cache for an mcp_remote integration from
 * discoverTools() output. Entries follow the OpenAI tool shape with the
 * prefixed safe name; `_cint.rawName` preserves the exact remote tool name
 * for dispatch. Tools without a usable name are dropped.
 */
function buildMcpToolsCache(tools, slug) {
    const taken = new Set();
    return (Array.isArray(tools) ? tools : [])
        .filter(t => t && typeof t === 'object' && typeof t.name === 'string' && t.name)
        .map(t => {
            const name = dedupeToolName(safeToolName(t.name), taken);
            return {
                type: 'function',
                function: {
                    name: `cint_${slug}_${name}`,
                    description: typeof t.description === 'string' ? t.description : '',
                    parameters: (t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema))
                        ? t.inputSchema
                        : { type: 'object', properties: {}, additionalProperties: false },
                },
                _cint: { rawName: t.name },
            };
        });
}

// ── Router-level middleware ─────────────────────────────────────────

// 1. Session auth (same shape as routes/integrations/connections.js).
function requireAuth(req, res, next) {
    if (req.session && req.session.user && req.session.user.id) return next();
    res.status(401).json({ error: 'Unauthorized' });
}
router.use(requireAuth);

// 2. Org admin for :orgId — the shared adminRoutes factory (lazy-required so
//    loading this module never drags in the whole admin router).
router.use((req, res, next) => {
    const { requireOrgAdmin } = require('../../auth/adminRoutes');
    return requireOrgAdmin('orgId')(req, res, next);
});

// 3. IDOR loader for every ':id' route. Missing row and cross-org row are
//    indistinguishable (404) so the endpoint never confirms existence of
//    another org's integration. A malformed uuid throws in pg → also 404.
router.param('id', async (req, res, next, id) => {
    try {
        const s = store();
        const row = await s.getById(id).catch(() => null);
        if (!row || row.orgId !== s.resolveOrgId(req.params.orgId)) {
            return res.status(404).json({ error: 'Not found' });
        }
        req.customIntegration = row;
        next();
    } catch (err) {
        console.error('[CustomIntegrationsAPI] loader error:', err.message);
        res.status(404).json({ error: 'Not found' });
    }
});

// ── Shared handler plumbing ─────────────────────────────────────────

// Access-audit (best-effort by contract — logAccessAudit never throws).
// NEVER pass secrets, tool args or response bodies: names/versions/statuses.
function audit(req, verb, integrationId, oldValues, newValues) {
    return userStore().logAccessAudit(
        `custom_integration.${verb}`, 'custom_integration', integrationId,
        req.session.user.id, oldValues || null, newValues || null, req.params.orgId
    );
}

// Bust the entitlement snapshot + the capability registry's custom-integration
// projection after grant-affecting mutations. The registry hook lands with the
// entitlements phase — guard on typeof so this stays fail-soft until then.
async function invalidateCaches(orgId) {
    try { await require('../../core/entitlements').invalidateForOrg(orgId); } catch (_) { /* best effort */ }
    try {
        const registry = require('../../core/capabilityRegistry');
        if (typeof registry.invalidateCustomIntegrationCache === 'function') {
            await registry.invalidateCustomIntegrationCache(orgId);
        }
    } catch (_) { /* best effort */ }
}

// The admin's own connection for this integration's provider (default first —
// listConnectionsForUser orders is_default DESC).
async function getAdminConnection(req, integrationId) {
    const list = await connStore().listConnectionsForUser(req.session.user.id, `custom:${integrationId}`);
    return list.length > 0 ? list[0] : null;
}

// Decrypted secret object for MCP discovery, or null for authStyle 'none' /
// no stored connection (discoverTools then probes unauthenticated).
async function resolveAdminSecretObject(req, row) {
    const mcp = row.definition && row.definition.mcp;
    if (!mcp || mcp.authStyle === 'none' || !mcp.valueTemplate) return null;
    const conn = await getAdminConnection(req, row.id);
    if (!conn) return null;
    const full = await connStore().getConnectionWithSecret(conn.id);
    return (full && full.secret && typeof full.secret === 'object') ? full.secret : null;
}

// Remove (or keep) 'custom:<id>' in the org-admin enablement list.
async function setOrgCapability(orgId, integrationId, enabled) {
    const us = userStore();
    const capId = `custom:${integrationId}`;
    const current = await us.getOrgEnabledIntegrations(orgId);
    const has = current.includes(capId);
    if (enabled && !has) await us.setOrgEnabledIntegrations(orgId, [...current, capId]);
    else if (!enabled && has) await us.setOrgEnabledIntegrations(orgId, current.filter(x => x !== capId));
}

// ── Routes ──────────────────────────────────────────────────────────

// List the org's custom integrations (builderSession is never shaped in).
router.get('/', async (req, res) => {
    try {
        const integrations = await store().listForOrg(req.params.orgId);
        res.json({ integrations });
    } catch (err) {
        console.error('[CustomIntegrationsAPI] list error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Create a draft integration.
router.post('/', async (req, res) => {
    try {
        const { name, kind = 'rest', description = null } = req.body || {};
        if (typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'name is required' });
        }
        if (!KINDS.has(kind)) {
            return res.status(400).json({ error: "kind must be 'rest' or 'mcp_remote'" });
        }
        if (description !== null && description !== undefined && typeof description !== 'string') {
            return res.status(400).json({ error: 'description must be a string' });
        }
        const row = await store().createIntegration({
            orgId: req.params.orgId,
            name: name.trim().slice(0, MAX_NAME_CHARS),
            kind,
            createdBy: req.session.user.id,
            description: description ? description.slice(0, MAX_DESCRIPTION_CHARS) : null,
        });
        await audit(req, 'create', row.id, null, { name: row.name, kind: row.kind, slug: row.slug, status: row.status });
        res.status(201).json({ integration: row });
    } catch (err) {
        console.error('[CustomIntegrationsAPI] create error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Read one integration (loader already enforced org scope).
router.get('/:id', (req, res) => {
    res.json({ integration: req.customIntegration });
});

// Save a new working (draft) definition. Allowed regardless of status —
// active rows keep running the frozen activatedDefinition until re-activation.
router.put('/:id/definition', async (req, res) => {
    try {
        const row = req.customIntegration;
        const definition = req.body ? req.body.definition : undefined;
        if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
            return res.status(400).json({ error: 'definition must be a JSON object' });
        }
        const validation = validateCustomIntegration(definition, { kind: row.kind, slug: row.slug });
        const updated = await store().saveDefinition(row.id, definition, req.session.user.id, { lastValidation: validation });
        if (!updated) return res.status(404).json({ error: 'Not found' });
        await audit(req, 'update', row.id,
            { definitionVersion: row.definitionVersion },
            { definitionVersion: updated.definitionVersion });
        res.json({ integration: updated, validation });
    } catch (err) {
        console.error('[CustomIntegrationsAPI] definition error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Validate the posted definition (or the stored draft). Read-only — no audit.
router.post('/:id/validate', (req, res) => {
    try {
        const row = req.customIntegration;
        const posted = req.body ? req.body.definition : undefined;
        const def = (posted && typeof posted === 'object' && !Array.isArray(posted)) ? posted : row.definition;
        const validation = validateCustomIntegration(def, {
            kind: row.kind,
            strict: !!(req.body && req.body.strict),
            slug: row.slug,
        });
        res.json({ validation });
    } catch (err) {
        console.error('[CustomIntegrationsAPI] validate error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Store credentials for the admin's own connection (SECURE FORM TARGET).
// Declared fields + bound origin come from the DRAFT definition; the secret
// is upserted into integration_connections under provider 'custom:<id>'.
// The response and the audit row carry field NAMES only — never values.
router.put('/:id/credentials', async (req, res) => {
    try {
        const row = req.customIntegration;
        const spec = credentialSpecFor(row.kind, row.definition);
        if (spec.error) return res.status(400).json({ error: spec.error });

        const values = req.body ? req.body.values : undefined;
        const check = checkCredentialValues(values, spec.fields);
        if (!check.ok) return res.status(400).json({ error: check.errors.join(' ') });

        const cs = connStore();
        const provider = `custom:${row.id}`;
        const secretMeta = { boundOrigin: spec.boundOrigin, fields: Object.keys(values) };
        const existing = await getAdminConnection(req, row.id);
        if (existing) {
            await cs.updateConnectionSecret(existing.id, values, secretMeta);
        } else {
            await cs.createConnection({
                ownerUserId: req.session.user.id,
                orgId: row.orgId,
                provider,
                label: row.name,
                kind: spec.connectionKind,
                secretObject: values,
                secretMeta,
                makeDefault: true,
            });
        }
        await audit(req, 'credential_set', row.id, null, { fields: Object.keys(values) });
        res.json({ configured: Object.keys(values) });
    } catch (err) {
        console.error('[CustomIntegrationsAPI] credentials error:', err.message);
        res.status(500).json({ error: 'Failed to store credentials' });
    }
});

// Test-call a draft tool. Rate-limited, kill-switch re-checked, strict-valid
// definition required. The runner enforces the full security spine (org
// match, origin pin, SSRF, method gate, schema rejection, secret scrub).
const testCallLimiter = perUserRateLimit({ windowMs: 60_000, max: 10 });
router.post('/:id/test-call', testCallLimiter, async (req, res) => {
    try {
        // Kill-switch re-check: mount-level gate already 404s, but this is the
        // one endpoint that fires real credentialed HTTP calls — re-assert.
        if (!(await isCustomIntegrationsEnabled())) {
            return res.status(404).json({ error: 'not_found' });
        }
        const row = req.customIntegration;
        const toolName = req.body ? req.body.toolName : undefined;
        if (typeof toolName !== 'string' || !TOOL_NAME_RE.test(toolName)) {
            return res.status(400).json({ error: 'toolName must match ^[a-z][a-z0-9_]{2,40}$' });
        }
        const validation = validateCustomIntegration(row.definition, { kind: row.kind, strict: true, slug: row.slug });
        if (!validation.ok) {
            return res.status(422).json({ error: 'validation_failed', validation });
        }
        const started = Date.now();
        const result = await executeCustomIntegrationTool(`cint_${row.slug}_${toolName}`, (req.body && req.body.args) || {}, {
            userId: req.session.user.id,
            draftIntegration: row,
        });
        const durationMs = Date.now() - started;
        const ok = !result.error;
        // Audit outcome metadata only — never args or the response body.
        await audit(req, 'test_call', row.id, null, {
            toolName, status: result.status ?? null, ok, durationMs,
        });
        res.json({ ok, durationMs, ...result });
    } catch (err) {
        console.error('[CustomIntegrationsAPI] test-call error:', err.message);
        res.status(500).json({ error: 'Test call failed' });
    }
});

// Activate: freeze the strict-validated draft, build the tools cache, grant
// org-wide, optionally lend the admin's connection to the org.
router.post('/:id/activate', async (req, res) => {
    try {
        const row = req.customIntegration;
        const def = row.definition;
        const validation = validateCustomIntegration(def, { kind: row.kind, strict: true, slug: row.slug });
        if (!validation.ok) {
            return res.status(422).json({ error: 'validation_failed', validation });
        }
        const allowWrites = !!(req.body && req.body.allowWrites);
        const lendMode = (req.body && req.body.lendMode === 'org') ? 'org' : 'byo';

        const warnings = [];
        let toolsCache;
        if (row.kind === 'rest') {
            toolsCache = deriveOpenAiTools(def, row.slug);
        } else {
            const client = require('../../core/customIntegrations/customMcpClient');
            const secretObject = await resolveAdminSecretObject(req, row);
            let discovered;
            try {
                discovered = await client.discoverTools(row, { secretObject });
            } catch (e) {
                return res.status(502).json({ error: `Tool discovery failed: ${e.message}` });
            }
            warnings.push(...(discovered.warnings || []));
            toolsCache = buildMcpToolsCache(discovered.tools, row.slug);
            if (toolsCache.length === 0) {
                return res.status(422).json({ error: 'The MCP server advertised no usable tools.', warnings });
            }
        }

        const updated = await store().activate(row.id, {
            definition: def, toolsCache, allowWrites, lendMode, userId: req.session.user.id,
        });
        if (!updated) return res.status(404).json({ error: 'Not found' });

        // Org-wide capability grant: org-admin enablement list (dedup inside).
        await setOrgCapability(req.params.orgId, row.id, true);

        // Lend the admin's connection org-wide. shareConnection's org-grant
        // form takes granteeId null (org isolation is the denormalized
        // cg.org_id — same convention as routes/integrations/connections.js).
        if (lendMode === 'org') {
            const conn = await getAdminConnection(req, row.id);
            if (conn) {
                const cs = connStore();
                const grants = await cs.listGrants({ connectionId: conn.id });
                if (!grants.some(g => g.grantee_type === 'org')) {
                    await cs.shareConnection({
                        connectionId: conn.id,
                        grantorUserId: req.session.user.id,
                        granteeType: 'org',
                        granteeId: null,
                    });
                }
            } else {
                warnings.push('lendMode "org" requested but you have no stored connection to lend — members fall back to bring-your-own credentials.');
            }
        }

        await invalidateCaches(req.params.orgId);
        await audit(req, 'activate', row.id,
            { status: row.status, activatedVersion: row.activatedVersion },
            { status: updated.status, allowWrites, lendMode, activatedVersion: updated.activatedVersion });
        res.json({ integration: updated, warnings });
    } catch (err) {
        console.error('[CustomIntegrationsAPI] activate error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Deactivate: disable, drop the org capability, best-effort revoke org grants.
router.post('/:id/deactivate', async (req, res) => {
    try {
        const row = req.customIntegration;
        await store().deactivate(row.id);
        await setOrgCapability(req.params.orgId, row.id, false);

        // Best-effort: revoke org-wide lends of connections for this provider
        // (listGrants joins the connection, exposing provider per grant).
        try {
            const cs = connStore();
            const provider = `custom:${row.id}`;
            const grants = await cs.listGrants({});
            for (const g of grants) {
                if (g.provider === provider && g.grantee_type === 'org') {
                    await cs.revokeGrant(g.id).catch(() => {});
                }
            }
        } catch (_) { /* best effort */ }

        await invalidateCaches(req.params.orgId);
        await audit(req, 'deactivate', row.id, { status: row.status }, { status: 'disabled' });
        res.json({ integration: await store().getById(row.id) });
    } catch (err) {
        console.error('[CustomIntegrationsAPI] deactivate error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Re-discover remote MCP tools into the DRAFT definition (bumps the version —
// re-activation required by design; the live activated cache never mutates).
router.post('/:id/refresh-tools', async (req, res) => {
    try {
        const row = req.customIntegration;
        if (row.kind !== 'mcp_remote') {
            return res.status(409).json({ error: 'Tool refresh only applies to mcp_remote integrations.' });
        }
        const client = require('../../core/customIntegrations/customMcpClient');
        const secretObject = await resolveAdminSecretObject(req, row);
        let discovered;
        try {
            discovered = await client.discoverTools(row, { secretObject });
        } catch (e) {
            return res.status(502).json({ error: `Tool discovery failed: ${e.message}` });
        }
        const def = { ...row.definition, mcp: { ...row.definition.mcp, discoveredTools: discovered.tools } };
        const updated = await store().saveDefinition(row.id, def, req.session.user.id);
        if (!updated) return res.status(404).json({ error: 'Not found' });
        await audit(req, 'refresh_tools', row.id,
            { definitionVersion: row.definitionVersion },
            { definitionVersion: updated.definitionVersion, toolCount: discovered.tools.length });
        res.json({ tools: discovered.tools, warnings: discovered.warnings || [], integration: updated });
    } catch (err) {
        console.error('[CustomIntegrationsAPI] refresh-tools error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Delete a non-active integration + best-effort credential/grant cleanup.
router.delete('/:id', async (req, res) => {
    try {
        const row = req.customIntegration;
        const deleted = await store().deleteIntegration(row.id);
        if (!deleted) {
            // Loader proved the row exists, so false = still active.
            return res.status(409).json({ error: 'Deactivate this integration before deleting it.' });
        }

        // Best-effort cleanup: the admin's own connections plus any connection
        // reachable through a grant (deleteConnection cascades its grants).
        // Other members' never-shared BYO connections for this provider are
        // not enumerable through the store API; they become inert (the
        // provider no longer resolves to anything).
        const provider = `custom:${row.id}`;
        try {
            const cs = connStore();
            const seen = new Set();
            for (const conn of await cs.listConnectionsForUser(req.session.user.id, provider)) {
                seen.add(conn.id);
                await cs.deleteConnection(conn.id).catch(() => {});
            }
            const grants = await cs.listGrants({ includeRevoked: true }).catch(() => []);
            for (const g of grants) {
                if (g.provider === provider && !seen.has(g.connection_id)) {
                    seen.add(g.connection_id);
                    await cs.deleteConnection(g.connection_id).catch(() => {});
                }
            }
        } catch (_) { /* best effort */ }

        // Drop a stale capability entry if one remained (e.g. disabled row
        // that was previously active).
        try { await setOrgCapability(req.params.orgId, row.id, false); } catch (_) { /* best effort */ }

        await invalidateCaches(req.params.orgId);
        await audit(req, 'delete', row.id,
            { name: row.name, kind: row.kind, slug: row.slug, status: row.status, definitionVersion: row.definitionVersion },
            null);
        res.json({ deleted: true });
    } catch (err) {
        console.error('[CustomIntegrationsAPI] delete error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Builder-agent scratchpad (the SSE builder phase writes it).
router.get('/:id/session', async (req, res) => {
    try {
        const session = await store().getBuilderSession(req.params.id);
        res.json({ session: session ?? null });
    } catch (err) {
        console.error('[CustomIntegrationsAPI] session error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
// Pure helpers (unit-tested in builder.test.js).
module.exports.credentialSpecFor = credentialSpecFor;
module.exports.checkCredentialValues = checkCredentialValues;
module.exports.safeToolName = safeToolName;
module.exports.dedupeToolName = dedupeToolName;
module.exports.buildMcpToolsCache = buildMcpToolsCache;
module.exports._internals = { KINDS, TOOL_NAME_RE, MAX_TOOL_NAME_CHARS, MAX_CREDENTIAL_VALUE_CHARS };
