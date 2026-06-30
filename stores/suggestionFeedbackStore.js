/**
 * Suggestion Feedback Store — records what the user did with a Routines
 * "Find repeating work" suggestion (dismissed / built / asked) so the scan can
 * suppress titles the user has already acted on or rejected.
 *
 * Feedback is keyed by a per-user (or per-org) scope plus a stable fingerprint
 * of the suggestion title. `dismissed` rows expire after a TTL (so a dismissed
 * suggestion can resurface later if the work keeps recurring); `built`/`asked`
 * rows are permanent (expires_at NULL) — once you've built it, don't nag.
 *
 * READ-ONLY-adjacent: model output is untrusted; the caller clamps/validates
 * before anything here is persisted. `action` is validated below.
 */

const { run, getOne, getAll, exec } = require('../db');

const VALID_ACTIONS = ['dismissed', 'built', 'asked'];
const DEFAULT_TTL_DAYS = 30;

let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_suggestion_feedback (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            organization_id TEXT,
            title_fingerprint TEXT NOT NULL,
            title TEXT,
            action TEXT,
            reason TEXT,
            suggestion_json JSONB,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            expires_at TIMESTAMPTZ NULL
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_sug_fb_org_user_created ON automation_suggestion_feedback(organization_id, user_id, created_at)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_sug_fb_fingerprint ON automation_suggestion_feedback(title_fingerprint)`);
    initialized = true;
}

initDB().catch(err => console.error('[SuggestionFeedbackStore] Init error:', err.message));
console.log('[SuggestionFeedbackStore] Initialized (PostgreSQL)');

// ============ Helpers ============

/**
 * Derive the scope prefix from the actor — per-org first, per-user fallback.
 * Matches how activity/automation stores attribute rows. The feedback row id is
 * `scope:fingerprint` so a given suggestion has exactly one feedback row per
 * scope.
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
        userId: r.user_id || null,
        organizationId: r.organization_id || null,
        titleFingerprint: r.title_fingerprint,
        title: r.title || null,
        action: r.action || null,
        reason: r.reason || null,
        suggestion: safeJson(r.suggestion_json, null),
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    };
}

// ============ Mutations ============

/**
 * Record (or update) feedback for a suggestion.
 *
 *   - `dismissed` → expires after ttlDays (default 30): the suggestion is hidden
 *     for now but may resurface if the underlying work keeps recurring.
 *   - `built` / `asked` → permanent (expires_at NULL): don't nag about work the
 *     user already turned into a routine / asked the assistant about.
 *
 * The row id is deterministic (`scope:fingerprint`), so repeated feedback on the
 * same suggestion updates the action/expiry in place.
 */
async function saveSuggestionFeedback({
    userId,
    organizationId,
    action,
    reason,
    suggestion,
    titleFingerprint,
    ttlDays,
}) {
    await initDB();
    if (!titleFingerprint) throw new Error('saveSuggestionFeedback requires titleFingerprint');
    if (!VALID_ACTIONS.includes(action)) {
        throw new Error(`Invalid suggestion feedback action: ${action}. Expected one of ${VALID_ACTIONS.join(', ')}`);
    }

    const scopeKey = deriveScopeKey({ organizationId, userId });
    const id = `${scopeKey}:${titleFingerprint}`;

    const title = suggestion && typeof suggestion === 'object'
        ? (suggestion.title || null)
        : null;

    const params = [
        id,
        userId || null,
        organizationId || null,
        titleFingerprint,
        title,
        action,
        reason || null,
        suggestion == null ? null : JSON.stringify(suggestion),
    ];

    // dismissed → time-boxed suppression; built/asked → permanent (NULL).
    let expiresExpr;
    if (action === 'dismissed') {
        const ttl = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : DEFAULT_TTL_DAYS;
        params.push(String(ttl));
        expiresExpr = `NOW() + ($${params.length} || ' days')::interval`;
    } else {
        expiresExpr = `NULL`;
    }

    const r = await getOne(`
        INSERT INTO automation_suggestion_feedback
            (id, user_id, organization_id, title_fingerprint, title, action, reason,
             suggestion_json, created_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW(), ${expiresExpr})
        ON CONFLICT (id) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            organization_id = EXCLUDED.organization_id,
            title = COALESCE(EXCLUDED.title, automation_suggestion_feedback.title),
            action = EXCLUDED.action,
            reason = EXCLUDED.reason,
            suggestion_json = COALESCE(EXCLUDED.suggestion_json, automation_suggestion_feedback.suggestion_json),
            expires_at = EXCLUDED.expires_at
        RETURNING *
    `, params);
    return mapRow(r);
}

// ============ Queries ============

/**
 * Titles the scan should suppress for this actor — every non-expired feedback
 * row (dismissed-and-still-in-TTL, or permanent built/asked). Returns a flat
 * string[] of titles (empty strings filtered out).
 */
async function getRecentSuppressedTitles({ organizationId, userId }) {
    await initDB();
    const scopeKey = deriveScopeKey({ organizationId, userId });
    const rows = await getAll(`
        SELECT title FROM automation_suggestion_feedback
        WHERE id LIKE $1
          AND title IS NOT NULL
          AND title != ''
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC
    `, [`${scopeKey}:%`]);
    return rows.map(r => r.title).filter(Boolean);
}

/**
 * Reap expired (dismissed-and-lapsed) feedback rows so dismissed suggestions can
 * resurface. Permanent rows (expires_at NULL) are never reaped.
 */
async function pruneExpired() {
    await initDB();
    const res = await run(`DELETE FROM automation_suggestion_feedback WHERE expires_at IS NOT NULL AND expires_at <= NOW()`);
    return res.rowCount || 0;
}

module.exports = {
    initDB,
    deriveScopeKey,
    VALID_ACTIONS,
    saveSuggestionFeedback,
    getRecentSuppressedTitles,
    pruneExpired,
};
