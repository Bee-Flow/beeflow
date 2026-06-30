/**
 * Integration Connection Store — first-class NAMED connections + sharing.
 *
 * A user may hold multiple named credentials per integration ("Slack – Work",
 * "Slack – Personal"), each individually shareable. Sharing is modelled as a
 * `connection_grants` row that LENDS a connection (full delegation). The
 * absence of a grant means "bring your own" — the safe default.
 *
 * Secrets are encrypted with the per-org routine-vault key (orgVault.js), the
 * same scheme routine_credentials uses, so a borrowed connection decrypts under
 * the OWNER's org key regardless of who runs it.
 *
 * Phase 1 (this file): schema, CRUD, the central `resolveConnectionForRun`
 * resolver, the legacy dual-read shim, and a non-destructive backfill. Runtime
 * wiring and UI land in later phases.
 */

const { run, getOne, getAll, exec, getClient } = require('../db');
const orgVault = require('./orgVault');

// Users with no organization (self-hosted single-tenant) still need a stable,
// non-empty org id to derive an encryption key. Backfill, the shim, and
// createConnection MUST all funnel empty orgs through this same sentinel or the
// derived keys won't line up and decryption fails.
const DEFAULT_ORG_SENTINEL = '__default_org__';
function resolveOrgId(rawOrgId) {
    return (rawOrgId && String(rawOrgId).trim()) || DEFAULT_ORG_SENTINEL;
}

// ── Legacy `config` key ⇄ named-connection mapping ──────────────────
// Each per-user secret key looks like `<prefix>_user_<userId>`. The prefix
// encodes a (provider, field). Multi-field providers (youtrack url+token,
// signrequest subdomain+token) map several prefixes onto ONE connection blob.
const LEGACY_KEY_MAP = {
    'fireflies_api_key':     { provider: 'fireflies',   field: 'api_key',      kind: 'api_key' },
    'gamma_api_key':         { provider: 'gamma',       field: 'api_key',      kind: 'api_key' },
    'github_token':          { provider: 'github',      field: 'token',        kind: 'api_key' },
    'youtrack_url':          { provider: 'youtrack',    field: 'url',          kind: 'basic'   },
    'youtrack_token':        { provider: 'youtrack',    field: 'token',        kind: 'basic'   },
    'signrequest_subdomain': { provider: 'signrequest', field: 'subdomain',    kind: 'basic'   },
    'signrequest_token':     { provider: 'signrequest', field: 'token',        kind: 'basic'   },
    'linkedin_access_token': { provider: 'linkedin',    field: 'access_token', kind: 'oauth'   },
    'afas_token':            { provider: 'afas-profit', field: 'token',        kind: 'basic'   },
    'afas_member_number':    { provider: 'afas-profit', field: 'member_number', kind: 'basic'  },
    'afas_env_type':         { provider: 'afas-profit', field: 'env_type',     kind: 'basic'   },
    'nmbrs_api_mode':        { provider: 'nmbrs',       field: 'api_mode',     kind: 'basic'   },
    'nmbrs_subdomain':       { provider: 'nmbrs',       field: 'subdomain',    kind: 'basic'   },
    'nmbrs_email':           { provider: 'nmbrs',       field: 'email',        kind: 'basic'   },
    'nmbrs_token':           { provider: 'nmbrs',       field: 'token',        kind: 'basic'   },
    'nmbrs_env':             { provider: 'nmbrs',       field: 'env',          kind: 'basic'   },
};
// Reverse index: provider → [{ prefix, field, kind }] for mirror-writes + backfill grouping.
const PROVIDER_LEGACY_FIELDS = {};
for (const [prefix, m] of Object.entries(LEGACY_KEY_MAP)) {
    (PROVIDER_LEGACY_FIELDS[m.provider] ||= []).push({ prefix, field: m.field, kind: m.kind });
}
// OAuth providers whose live tokens stay in routine_credentials in Phase 1.
const OAUTH_ROUTINE_PROVIDERS = new Set(['google', 'microsoft', 'nextcloud']);

/**
 * Parse a legacy per-user config key into { provider, field, kind, userId }.
 * Returns null when the key isn't one we manage (caller falls through).
 *
 * Matches against the fixed known prefixes rather than splitting on `_user_`,
 * so a userId that itself contains `_user_` parses correctly.
 */
function parseLegacyKey(key) {
    if (typeof key !== 'string') return null;
    for (const prefix of Object.keys(LEGACY_KEY_MAP)) {
        const head = `${prefix}_user_`;
        if (key.startsWith(head)) {
            const userId = key.slice(head.length);
            if (!userId) return null;
            const m = LEGACY_KEY_MAP[prefix];
            return { provider: m.provider, field: m.field, kind: m.kind, userId };
        }
    }
    return null;
}

// ── Schema ──────────────────────────────────────────────────────────
let initialized = false;
async function initDB() {
    if (initialized) return;
    try {
        await require('../migrations/integration-connections-2026-06').up();
    } catch (err) {
        console.error('[IntegrationConnectionStore] migration error:', err.message);
    }
    initialized = true;
}
initDB().catch(err => console.error('[IntegrationConnectionStore] init error:', err.message));

// Best-effort one-time backfill of existing per-user secrets into default named
// connections. Idempotent (skips any (user, provider) already present) and
// deferred so configStore / userStore / routine tables settle first. Won't fire
// in the short-lived `migrateDb.js` runner (it process.exit()s before this).
// Set INTEGRATION_CONNECTIONS_BACKFILL=0 to disable (e.g. tests).
if (process.env.INTEGRATION_CONNECTIONS_BACKFILL !== '0') {
    const t = setTimeout(() => { backfillFromLegacy().catch(() => {}); }, 8000);
    if (typeof t.unref === 'function') t.unref();
}

// ── Row shaping ─────────────────────────────────────────────────────
function shapeConnection(row, { withSecretMeta = true } = {}) {
    if (!row) return null;
    return {
        id: row.id,
        ownerUserId: row.owner_user_id,
        orgId: row.org_id,
        provider: row.provider,
        label: row.label,
        kind: row.kind,
        status: row.status,
        isDefault: row.is_default,
        secretMeta: withSecretMeta ? (row.secret_meta || {}) : undefined,
        lastUsedAt: row.last_used_at,
        lastError: row.last_error || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

// ── CRUD ────────────────────────────────────────────────────────────

/**
 * Create a named connection. `secretObject` is JSON-serialized then encrypted
 * under the owner's org key. `secretMeta` must hold ONLY non-secret descriptors
 * (account email, url, scope, expiry hint) — never credentials.
 */
async function createConnection({
    ownerUserId, orgId, provider, label, kind = 'api_key',
    secretObject = null, secretMeta = {}, makeDefault = false, mirror = true,
}) {
    if (!ownerUserId || !provider) throw new Error('createConnection requires ownerUserId, provider');
    await initDB();
    const resolvedOrg = resolveOrgId(orgId);
    const secret = secretObject ? orgVault.encryptJSON(secretObject, resolvedOrg) : null;

    const existing = await getAll(
        'SELECT id FROM integration_connections WHERE owner_user_id = $1 AND provider = $2',
        [ownerUserId, provider]
    );
    const shouldDefault = makeDefault || existing.length === 0;

    const client = await getClient();
    let created;
    try {
        await client.query('BEGIN');
        if (shouldDefault) {
            await client.query(
                'UPDATE integration_connections SET is_default = FALSE, updated_at = NOW() WHERE owner_user_id = $1 AND provider = $2',
                [ownerUserId, provider]
            );
        }
        const { rows } = await client.query(`
            INSERT INTO integration_connections
                (owner_user_id, org_id, provider, label, kind, secret, secret_meta, status, is_default)
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'active',$8)
            RETURNING *
        `, [ownerUserId, resolvedOrg, provider, label || 'Default', kind, secret,
            JSON.stringify(secretMeta || {}), shouldDefault]);
        created = rows[0];
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }

    if (mirror && created.is_default && secretObject) {
        await _mirrorWriteLegacy(created, secretObject).catch(() => {});
    }
    return shapeConnection(created);
}

async function listConnectionsForUser(userId, provider = null) {
    await initDB();
    const params = [userId];
    let sql = 'SELECT * FROM integration_connections WHERE owner_user_id = $1';
    if (provider) { sql += ' AND provider = $2'; params.push(provider); }
    sql += ' ORDER BY provider, is_default DESC, created_at ASC';
    const rows = await getAll(sql, params);
    return rows.map(r => shapeConnection(r));
}

async function getConnection(connectionId) {
    await initDB();
    return shapeConnection(await getOne('SELECT * FROM integration_connections WHERE id = $1', [connectionId]));
}

/**
 * Runtime-only: returns the connection with its DECRYPTED secret object.
 * For OAuth providers backed by routine_credentials, reads live tokens through
 * routineCredentialStore (the new table holds metadata only in Phase 1).
 */
async function getConnectionWithSecret(connectionId) {
    await initDB();
    const row = await getOne('SELECT * FROM integration_connections WHERE id = $1', [connectionId]);
    if (!row) return null;
    const shaped = shapeConnection(row);
    if (row.kind === 'oauth' && OAUTH_ROUTINE_PROVIDERS.has(row.provider)) {
        try {
            const routineCredentialStore = require('./routineCredentialStore');
            const cred = await routineCredentialStore.getCredential(row.owner_user_id, row.provider);
            shaped.secret = cred
                ? { access_token: cred.accessToken, refresh_token: cred.refreshToken, expires_at: cred.expiresAt, scope: cred.scope }
                : null;
        } catch (_) { shaped.secret = null; }
        return shaped;
    }
    shaped.secret = row.secret ? orgVault.decryptJSON(row.secret, row.org_id) : null;
    return shaped;
}

async function getDefaultConnection(userId, provider) {
    await initDB();
    return shapeConnection(await getOne(
        'SELECT * FROM integration_connections WHERE owner_user_id = $1 AND provider = $2 AND is_default = TRUE',
        [userId, provider]
    ));
}

async function setDefault(connectionId) {
    await initDB();
    const conn = await getOne('SELECT id, owner_user_id, provider FROM integration_connections WHERE id = $1', [connectionId]);
    if (!conn) return false;
    const client = await getClient();
    try {
        await client.query('BEGIN');
        await client.query(
            'UPDATE integration_connections SET is_default = FALSE, updated_at = NOW() WHERE owner_user_id = $1 AND provider = $2',
            [conn.owner_user_id, conn.provider]
        );
        await client.query('UPDATE integration_connections SET is_default = TRUE, updated_at = NOW() WHERE id = $1', [connectionId]);
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
    // Re-mirror the new default's value to the legacy key.
    const full = await getConnectionWithSecret(connectionId);
    if (full?.secret) await _mirrorWriteLegacy({ owner_user_id: conn.owner_user_id, provider: conn.provider, is_default: true }, full.secret).catch(() => {});
    return true;
}

async function updateConnectionSecret(connectionId, secretObject, secretMeta = null) {
    await initDB();
    const row = await getOne('SELECT * FROM integration_connections WHERE id = $1', [connectionId]);
    if (!row) return false;
    const secret = secretObject ? orgVault.encryptJSON(secretObject, row.org_id) : null;
    if (secretMeta !== null) {
        await run(
            'UPDATE integration_connections SET secret = $2, secret_meta = $3::jsonb, status = \'active\', last_error = NULL, updated_at = NOW() WHERE id = $1',
            [connectionId, secret, JSON.stringify(secretMeta || {})]
        );
    } else {
        await run(
            'UPDATE integration_connections SET secret = $2, status = \'active\', last_error = NULL, updated_at = NOW() WHERE id = $1',
            [connectionId, secret]
        );
    }
    if (row.is_default && secretObject) {
        await _mirrorWriteLegacy(row, secretObject).catch(() => {});
    }
    return true;
}

async function renameConnection(connectionId, label) {
    await initDB();
    await run('UPDATE integration_connections SET label = $2, updated_at = NOW() WHERE id = $1', [connectionId, label]);
    return true;
}

async function markNeedsReauth(connectionId, reason) {
    await initDB();
    await run(
        'UPDATE integration_connections SET status = \'needs_reauth\', last_error = $2, updated_at = NOW() WHERE id = $1',
        [connectionId, String(reason || '').slice(0, 500)]
    );
}

async function markRevoked(connectionId) {
    await initDB();
    await run('UPDATE integration_connections SET status = \'revoked\', updated_at = NOW() WHERE id = $1', [connectionId]);
}

async function deleteConnection(connectionId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM integration_connections WHERE id = $1', [connectionId]);
    return rowCount > 0;
}

async function touchLastUsed(connectionId) {
    await initDB();
    await run('UPDATE integration_connections SET last_used_at = NOW() WHERE id = $1', [connectionId]).catch(() => {});
}

// ── Sharing ─────────────────────────────────────────────────────────

/**
 * Lend a connection to a user / group / org, optionally bound to a resource.
 * org_id is denormalized from the connection as the hard isolation guard.
 */
async function shareConnection({
    connectionId, grantorUserId, granteeType, granteeId = null,
    resourceType = null, resourceId = null, expiresAt = null, fixedArgs = null,
}) {
    if (!connectionId || !grantorUserId || !granteeType) {
        throw new Error('shareConnection requires connectionId, grantorUserId, granteeType');
    }
    await initDB();
    const conn = await getOne('SELECT id, org_id FROM integration_connections WHERE id = $1', [connectionId]);
    if (!conn) throw new Error('shareConnection: connection not found');
    const { rows } = await run(`
        INSERT INTO connection_grants
            (connection_id, org_id, grantor_user_id, grantee_type, grantee_id, resource_type, resource_id, policy, fixed_args, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'lend',$8::jsonb,$9)
        RETURNING *
    `, [connectionId, conn.org_id, grantorUserId, granteeType, granteeId, resourceType, resourceId,
        fixedArgs ? JSON.stringify(fixedArgs) : null, expiresAt]);
    return rows[0];
}

async function listGrants({ connectionId = null, granteeId = null, grantorUserId = null, resourceType = null, resourceId = null, includeRevoked = false } = {}) {
    await initDB();
    const conds = [];
    const params = [];
    let i = 1;
    if (connectionId) { conds.push(`cg.connection_id = $${i++}`); params.push(connectionId); }
    if (granteeId) { conds.push(`cg.grantee_id = $${i++}`); params.push(granteeId); }
    if (grantorUserId) { conds.push(`cg.grantor_user_id = $${i++}`); params.push(grantorUserId); }
    if (resourceType) { conds.push(`cg.resource_type = $${i++}`); params.push(resourceType); }
    if (resourceId) { conds.push(`cg.resource_id = $${i++}`); params.push(resourceId); }
    if (!includeRevoked) conds.push('cg.revoked_at IS NULL');
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    return getAll(`
        SELECT cg.*, ic.provider, ic.label AS connection_label, ic.owner_user_id
        FROM connection_grants cg
        JOIN integration_connections ic ON ic.id = cg.connection_id
        ${where}
        ORDER BY cg.created_at DESC
    `, params);
}

async function revokeGrant(grantId) {
    await initDB();
    const { rowCount } = await run(
        'UPDATE connection_grants SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL',
        [grantId]
    );
    return rowCount > 0;
}

// ── Central resolver ────────────────────────────────────────────────

/**
 * Decide which identity + named connection a run should use for `provider`.
 *
 *   1. Own connection first (bring-your-own — the default).
 *   2. Else an applicable LEND grant → the owner's connection (full delegation).
 *   3. Else byo_required (recipient must connect their own).
 *
 * Org isolation is structural: every grant is filtered by `cg.org_id =
 * runningUserOrgId`, so a grant can never resolve across orgs.
 */
async function resolveConnectionForRun({
    runningUserId, runningUserOrgId, runningUserGroups = [], ownerUserId = null,
    provider, resourceType = null, resourceId = null,
}) {
    await initDB();
    const orgId = resolveOrgId(runningUserOrgId);

    // 1. Own (BYO default)
    const own = await getDefaultConnection(runningUserId, provider);
    if (own && own.status === 'active') {
        return {
            mode: 'own', available: true, reason: 'byo_ok',
            effectiveUserId: runningUserId, effectiveOrgId: orgId,
            connectionId: own.id, connectionLabel: own.label, grantId: null,
        };
    }

    // 2. Applicable lend grant
    const groups = Array.isArray(runningUserGroups) ? runningUserGroups : [];
    const row = await getOne(`
        SELECT ic.id AS connection_id, ic.label AS connection_label, ic.owner_user_id, ic.org_id,
               cg.id AS grant_id
        FROM connection_grants cg
        JOIN integration_connections ic ON ic.id = cg.connection_id
        WHERE cg.revoked_at IS NULL
          AND (cg.expires_at IS NULL OR cg.expires_at > NOW())
          AND ic.provider = $1
          AND ic.status = 'active'
          AND cg.org_id = $2
          AND (
                (cg.grantee_type = 'user'  AND cg.grantee_id = $3)
             OR (cg.grantee_type = 'group' AND cg.grantee_id = ANY($4::text[]))
             OR (cg.grantee_type = 'org')
          )
          AND (
                (cg.resource_type = $5 AND cg.resource_id = $6)
             OR (cg.resource_type IS NULL AND cg.resource_id IS NULL)
          )
          AND ($7::text IS NULL OR ic.owner_user_id = $7)
        ORDER BY
          (cg.resource_id IS NOT NULL) DESC,
          CASE cg.grantee_type WHEN 'user' THEN 0 WHEN 'group' THEN 1 ELSE 2 END,
          cg.created_at DESC
        LIMIT 1
    `, [provider, orgId, runningUserId, groups, resourceType, resourceId, ownerUserId]);

    if (row) {
        return {
            mode: 'delegated', available: true, reason: 'delegated',
            effectiveUserId: row.owner_user_id, effectiveOrgId: row.org_id,
            connectionId: row.connection_id, connectionLabel: row.connection_label,
            grantId: row.grant_id,
        };
    }

    // 3. Nothing applies
    return {
        mode: 'byo_required', available: false, reason: 'byo_missing',
        effectiveUserId: runningUserId, effectiveOrgId: orgId,
        connectionId: null, connectionLabel: null, grantId: null,
    };
}

// ── Legacy dual-read shim ───────────────────────────────────────────

/**
 * Resolve a legacy per-user config key to the user's default named connection
 * value. Returns undefined when the key isn't ours or no connection exists —
 * the caller (configStore.getSecret) then keeps its existing behavior.
 *
 * Safe to call before the table exists (returns undefined on any error).
 */
async function getLegacySecretValue(key) {
    try {
        const parsed = parseLegacyKey(key);
        if (!parsed) return undefined;
        const conn = await getDefaultConnection(parsed.userId, parsed.provider);
        if (!conn) return undefined;
        const full = await getConnectionWithSecret(conn.id);
        const blob = full?.secret;
        if (!blob || typeof blob !== 'object') return undefined;
        const val = blob[parsed.field];
        return (val === undefined || val === null) ? undefined : val;
    } catch (_) {
        return undefined;
    }
}

/**
 * Best-effort mirror-write: keep the legacy `<prefix>_user_<id>` config key(s)
 * in sync with a default connection's value so untouched integration code keeps
 * resolving. Skipped for OAuth-routine providers (their tokens live in
 * routine_credentials, read via session/routineAuth — not config keys).
 */
async function _mirrorWriteLegacy(row, secretObject) {
    const provider = row.provider;
    const userId = row.owner_user_id;
    if (!provider || !userId || !secretObject) return;
    if (OAUTH_ROUTINE_PROVIDERS.has(provider)) return;
    const fields = PROVIDER_LEGACY_FIELDS[provider];
    if (!fields) return;
    const configStore = require('./configStore');
    for (const { prefix, field } of fields) {
        const val = secretObject[field];
        if (val === undefined || val === null || val === '') continue;
        try { await configStore.setSecret(`${prefix}_user_${userId}`, String(val)); } catch (_) { /* best effort */ }
    }
}

// ── Backfill (non-destructive, idempotent) ──────────────────────────

/**
 * One-time best-effort backfill: turn existing per-user secrets into DEFAULT
 * named connections. Idempotent — skips any (user, provider) that already has a
 * connection. Never deletes legacy rows; dual-read keeps both readable.
 */
async function backfillFromLegacy() {
    await initDB();
    let created = 0;
    try {
        const configStore = require('./configStore');
        const userStore = require('./userStore');

        // ── config-based per-user secrets ──
        const keyRows = await getAll("SELECT key FROM config WHERE key LIKE '%user%'");
        // Group fields by (userId, provider).
        const groups = new Map(); // `${userId}::${provider}` -> { userId, provider, kind, fields: {} }
        for (const { key } of keyRows) {
            const parsed = parseLegacyKey(key);
            if (!parsed) continue;
            const gk = `${parsed.userId}::${parsed.provider}`;
            if (!groups.has(gk)) groups.set(gk, { userId: parsed.userId, provider: parsed.provider, kind: parsed.kind, fields: {} });
            const value = await configStore.getSecret(key).catch(() => null);
            if (value !== null && value !== undefined && value !== '') groups.get(gk).fields[parsed.field] = value;
        }
        for (const g of groups.values()) {
            if (Object.keys(g.fields).length === 0) continue;
            const existing = await getOne(
                'SELECT id FROM integration_connections WHERE owner_user_id = $1 AND provider = $2 LIMIT 1',
                [g.userId, g.provider]
            );
            if (existing) continue;
            let orgId = null;
            try { orgId = (await userStore.getUser(g.userId))?.organizationId || null; } catch (_) { /* sentinel */ }
            await createConnection({
                ownerUserId: g.userId, orgId, provider: g.provider, label: 'Default',
                kind: g.kind, secretObject: g.fields, makeDefault: true, mirror: false,
            });
            created++;
        }

        // ── routine_credentials OAuth rows → metadata-only oauth connections ──
        const oauthRows = await getAll(
            "SELECT user_id, org_id, provider, scope, expires_at, status FROM routine_credentials WHERE provider = ANY($1::text[])",
            [Array.from(OAUTH_ROUTINE_PROVIDERS)]
        ).catch(() => []);
        for (const r of oauthRows) {
            const existing = await getOne(
                'SELECT id FROM integration_connections WHERE owner_user_id = $1 AND provider = $2 LIMIT 1',
                [r.user_id, r.provider]
            );
            if (existing) continue;
            await createConnection({
                ownerUserId: r.user_id, orgId: r.org_id, provider: r.provider, label: 'Default',
                kind: 'oauth', secretObject: null, makeDefault: true, mirror: false,
                secretMeta: { source: 'routine_credentials', scope: r.scope || null, expires_at: r.expires_at || null },
            });
            created++;
        }
    } catch (err) {
        console.error('[IntegrationConnectionStore] backfill error:', err.message);
    }
    if (created > 0) console.log(`[IntegrationConnectionStore] backfill created ${created} default connection(s)`);
    return created;
}

module.exports = {
    DEFAULT_ORG_SENTINEL,
    resolveOrgId,
    // CRUD
    createConnection,
    listConnectionsForUser,
    getConnection,
    getConnectionWithSecret,
    getDefaultConnection,
    setDefault,
    updateConnectionSecret,
    renameConnection,
    markNeedsReauth,
    markRevoked,
    deleteConnection,
    touchLastUsed,
    // Sharing
    shareConnection,
    listGrants,
    revokeGrant,
    // Resolver
    resolveConnectionForRun,
    // Shim + backfill
    parseLegacyKey,
    getLegacySecretValue,
    backfillFromLegacy,
    // Tests / debugging only
    _internals: { LEGACY_KEY_MAP, PROVIDER_LEGACY_FIELDS, OAUTH_ROUTINE_PROVIDERS },
};
