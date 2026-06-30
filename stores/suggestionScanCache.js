/**
 * Suggestion Scan Cache — caches the result of a Routines "Find repeating work"
 * scan so the (expensive, LLM-driven) analysis isn't re-run on every panel open.
 *
 * A scan is keyed by a per-user (or per-org) scope plus a content hash
 * (`cache_key`) derived from the scan inputs (focus + integration set). The
 * same inputs hit the cache; changing the focus/integrations produces a fresh
 * key and a fresh scan. Rows expire (`expires_at`) so stale activity never
 * lingers — `pruneExpired()` reaps them.
 *
 * READ-ONLY analysis artefact: nothing here is trusted model state — the caller
 * clamps the model output before it's persisted.
 */

const { run, getOne, getAll, exec } = require('../db');

let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS suggestion_scan_cache (
            id TEXT PRIMARY KEY,
            scope_key TEXT NOT NULL,
            user_id TEXT,
            organization_id TEXT,
            cache_key TEXT NOT NULL,
            focus TEXT,
            integration_ids TEXT,
            suggestions_json JSONB NOT NULL,
            summary_json JSONB,
            reason TEXT,
            model TEXT,
            eu BOOLEAN,
            scanned_at TIMESTAMPTZ DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL,
            UNIQUE (scope_key, cache_key)
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_sug_scan_scope_scanned ON suggestion_scan_cache(scope_key, scanned_at DESC)`);
    initialized = true;
}

initDB().catch(err => console.error('[SuggestionScanCache] Init error:', err.message));
console.log('[SuggestionScanCache] Initialized (PostgreSQL)');

// ============ Helpers ============

/**
 * Derive the scope key from the actor. Scans are scoped per-user by default;
 * an org id (when present) is the broader bucket. Matches how activity/automation
 * stores attribute rows: organization_id first, user_id fallback.
 */
function deriveScopeKey({ organizationId, userId } = {}) {
    if (organizationId) return `org:${organizationId}`;
    if (userId) return `user:${userId}`;
    return 'anon';
}

function safeJson(v, fallback) {
    if (v == null) return fallback;
    if (typeof v === 'object') return v; // pg already parsed JSONB
    try { return JSON.parse(v); } catch { return fallback; }
}

function mapRow(r) {
    if (!r) return null;
    return {
        id: r.id,
        scopeKey: r.scope_key,
        userId: r.user_id || null,
        organizationId: r.organization_id || null,
        cacheKey: r.cache_key,
        focus: r.focus || null,
        integrationIds: r.integration_ids || null,
        suggestions: safeJson(r.suggestions_json, []),
        summary: safeJson(r.summary_json, null),
        reason: r.reason || null,
        model: r.model || null,
        eu: r.eu == null ? null : !!r.eu,
        scannedAt: r.scanned_at ? new Date(r.scanned_at).toISOString() : null,
        expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    };
}

// ============ Queries ============

/**
 * Fetch a fresh cached scan for an exact (scope, inputs) match, or null.
 * "Fresh" = not yet expired.
 */
async function getCachedScan({ scopeKey, cacheKey }) {
    await initDB();
    if (!scopeKey || !cacheKey) return null;
    const r = await getOne(`
        SELECT * FROM suggestion_scan_cache
        WHERE scope_key = $1 AND cache_key = $2 AND expires_at > NOW()
        LIMIT 1
    `, [scopeKey, cacheKey]);
    return mapRow(r);
}

/**
 * Most-recent scan for a scope, regardless of inputs. Lets the UI show "your
 * last scan" even after the inputs change slightly.
 *
 * NOTE: deliberately NOT filtered by `expires_at`. `expires_at` is only the
 * *compute-freshness* window used by getCachedScan ("should a force=false scan
 * re-run the model?"). The user's last results must persist for display across
 * server/browser restarts well beyond that window — they live until the user
 * re-scans the same inputs (overwrite) or the retention prune reaps them.
 */
async function getLatestScan({ scopeKey }) {
    await initDB();
    if (!scopeKey) return null;
    const r = await getOne(`
        SELECT * FROM suggestion_scan_cache
        WHERE scope_key = $1
        ORDER BY scanned_at DESC
        LIMIT 1
    `, [scopeKey]);
    return mapRow(r);
}

/**
 * Remove every suggestion matching `predicate` from all of a scope's scan rows,
 * in place. `predicate(suggestion)` returns true for suggestions to DROP. Pure
 * predicate (no I/O). Returns the number of rows actually modified.
 *
 * Powers the "delete a suggestion" action: stripping it from the persisted rows
 * means it never resurfaces from getLatestScan after a reload/restart, on any
 * browser — not just hidden by a client-side ledger.
 */
async function removeSuggestionsFromScope({ scopeKey, predicate }) {
    await initDB();
    if (!scopeKey || typeof predicate !== 'function') return 0;
    const rows = await getAll(
        `SELECT id, suggestions_json FROM suggestion_scan_cache WHERE scope_key = $1`,
        [scopeKey],
    );
    let updated = 0;
    for (const row of rows) {
        const list = safeJson(row.suggestions_json, []);
        if (!Array.isArray(list) || list.length === 0) continue;
        const kept = list.filter(s => !predicate(s));
        if (kept.length !== list.length) {
            await run(
                `UPDATE suggestion_scan_cache SET suggestions_json = $2::jsonb WHERE id = $1`,
                [row.id, JSON.stringify(kept)],
            );
            updated++;
        }
    }
    return updated;
}

/**
 * Insert (or refresh) the cached scan for a (scope, inputs) pair. The row id is
 * deterministic (`scope:cacheKey`) so re-scanning the same inputs overwrites in
 * place. Always bumps scanned_at/expires_at.
 */
async function upsertScan({
    scopeKey,
    cacheKey,
    userId,
    organizationId,
    focus,
    integrationIds,
    suggestions,
    summary,
    reason,
    model,
    eu,
    expiresAt,
}) {
    await initDB();
    if (!scopeKey || !cacheKey) throw new Error('upsertScan requires scopeKey and cacheKey');
    const id = `${scopeKey}:${cacheKey}`;
    const integrationIdsStr = Array.isArray(integrationIds)
        ? integrationIds.join(',')
        : (integrationIds || null);
    const r = await getOne(`
        INSERT INTO suggestion_scan_cache
            (id, scope_key, user_id, organization_id, cache_key, focus, integration_ids,
             suggestions_json, summary_json, reason, model, eu, scanned_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, NOW(), $13)
        ON CONFLICT (scope_key, cache_key) DO UPDATE SET
            id = EXCLUDED.id,
            user_id = EXCLUDED.user_id,
            organization_id = EXCLUDED.organization_id,
            focus = EXCLUDED.focus,
            integration_ids = EXCLUDED.integration_ids,
            suggestions_json = EXCLUDED.suggestions_json,
            summary_json = EXCLUDED.summary_json,
            reason = EXCLUDED.reason,
            model = EXCLUDED.model,
            eu = EXCLUDED.eu,
            scanned_at = NOW(),
            expires_at = EXCLUDED.expires_at
        RETURNING *
    `, [
        id,
        scopeKey,
        userId || null,
        organizationId || null,
        cacheKey,
        focus || null,
        integrationIdsStr,
        JSON.stringify(suggestions ?? []),
        summary == null ? null : JSON.stringify(summary),
        reason || null,
        model || null,
        eu == null ? null : !!eu,
        expiresAt,
    ]);
    return mapRow(r);
}

/**
 * Drop every cached scan for a scope (e.g. when the user explicitly re-scans or
 * their integration set changes materially). Returns the number of rows removed.
 */
async function invalidateForScope({ scopeKey }) {
    await initDB();
    if (!scopeKey) return 0;
    const res = await run(`DELETE FROM suggestion_scan_cache WHERE scope_key = $1`, [scopeKey]);
    return res.rowCount || 0;
}

// How long a scan's results are retained for display after they were produced.
// Independent of `expires_at` (the 4h compute-freshness window) — results stay
// visible across restarts until they age past this or the user re-scans.
const RETENTION_DAYS = 30;

/**
 * Reap scans older than the retention window (by scanned_at). Safe to call
 * periodically; idempotent. NOT keyed on `expires_at` — that is only the
 * re-compute window and must not delete still-displayable results.
 */
async function pruneExpired() {
    await initDB();
    const res = await run(
        `DELETE FROM suggestion_scan_cache WHERE scanned_at < NOW() - ($1 || ' days')::interval`,
        [String(RETENTION_DAYS)],
    );
    return res.rowCount || 0;
}

module.exports = {
    initDB,
    deriveScopeKey,
    getCachedScan,
    getLatestScan,
    removeSuggestionsFromScope,
    upsertScan,
    invalidateForScope,
    pruneExpired,
};
