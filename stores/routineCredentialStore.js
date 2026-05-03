/**
 * Routine Credential Store — long-lived OAuth tokens for unattended routines.
 *
 * Sits alongside the short-lived `user_sessions` row that backs the interactive
 * web session. The session row stores tokens plaintext and only exists while
 * the user is "recently logged in"; this store keeps an encrypted, refresh-
 * capable copy that the routine runner can decrypt at any time, even when the
 * user is offline.
 *
 * Encryption: AES-256-GCM with a per-org key derived from
 * `MASTER_ENCRYPTION_KEY` via HKDF-SHA256. A leaked org key only affects that
 * org's vault; rotating one org doesn't touch the others.
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');

// ── Per-org key derivation ──────────────────────────────────────────
function _orgVaultKey(orgId) {
    if (!orgId) throw new Error('routineCredentialStore: orgId required');
    const master = process.env.MASTER_ENCRYPTION_KEY;
    if (!master) throw new Error('MASTER_ENCRYPTION_KEY env var is required for routine vault');
    return crypto.createHmac('sha256', master)
        .update(`beeflow:routine-vault:v1:org:${orgId}`)
        .digest();
}

function _encrypt(plaintext, orgId) {
    if (!plaintext) return null;
    const key = _orgVaultKey(orgId);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return JSON.stringify({
        _encrypted: 'routine-vault-v1',
        iv: iv.toString('hex'),
        authTag: cipher.getAuthTag().toString('hex'),
        data: data.toString('hex'),
    });
}

function _decrypt(stored, orgId) {
    if (!stored) return null;
    let envelope;
    try { envelope = JSON.parse(stored); } catch (_) { return null; }
    if (!envelope || envelope._encrypted !== 'routine-vault-v1') return null;
    try {
        const key = _orgVaultKey(orgId);
        const iv = Buffer.from(envelope.iv, 'hex');
        const authTag = Buffer.from(envelope.authTag, 'hex');
        const data = Buffer.from(envelope.data, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        return decipher.update(data) + decipher.final('utf8');
    } catch (err) {
        console.warn(`[RoutineCredentialStore] decrypt failed for org ${orgId}: ${err.message}`);
        return null;
    }
}

// ── Schema ──────────────────────────────────────────────────────────
let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS routine_credentials (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id TEXT NOT NULL,
            org_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            access_token TEXT,
            refresh_token TEXT,
            expires_at TIMESTAMPTZ,
            scope TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            last_refresh_at TIMESTAMPTZ,
            last_error TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (user_id, provider)
        );
        CREATE INDEX IF NOT EXISTS idx_routine_credentials_user ON routine_credentials(user_id);
        CREATE INDEX IF NOT EXISTS idx_routine_credentials_status ON routine_credentials(status);
    `);
    initialized = true;
}
initDB().catch(err => console.error('[RoutineCredentialStore] init error:', err.message));

// ── CRUD ────────────────────────────────────────────────────────────

/**
 * Insert or update the credentials for (userId, provider). orgId is required
 * because it scopes the encryption key — moving a user between orgs requires
 * a re-OAuth.
 */
async function upsertCredential({ userId, orgId, provider, accessToken, refreshToken, expiresAt, scope }) {
    if (!userId || !orgId || !provider) {
        throw new Error('upsertCredential requires userId, orgId, provider');
    }
    await initDB();
    const encAccess = accessToken ? _encrypt(accessToken, orgId) : null;
    const encRefresh = refreshToken ? _encrypt(refreshToken, orgId) : null;
    const expiresAtIso = expiresAt
        ? (expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt).toISOString())
        : null;

    // Preserve existing refresh_token if the caller didn't pass a new one
    // (Google rotates refresh tokens rarely; Microsoft does on each refresh).
    await run(`
        INSERT INTO routine_credentials
            (user_id, org_id, provider, access_token, refresh_token, expires_at, scope, status, last_refresh_at, last_error, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW(), NULL, NOW())
        ON CONFLICT (user_id, provider) DO UPDATE SET
            org_id = EXCLUDED.org_id,
            access_token = EXCLUDED.access_token,
            refresh_token = COALESCE(EXCLUDED.refresh_token, routine_credentials.refresh_token),
            expires_at = EXCLUDED.expires_at,
            scope = COALESCE(EXCLUDED.scope, routine_credentials.scope),
            status = 'active',
            last_refresh_at = NOW(),
            last_error = NULL,
            updated_at = NOW()
    `, [userId, orgId, provider, encAccess, encRefresh, expiresAtIso, scope || null]);
}

async function getCredential(userId, provider) {
    await initDB();
    const row = await getOne(
        `SELECT user_id, org_id, provider, access_token, refresh_token, expires_at, scope, status, last_error
         FROM routine_credentials WHERE user_id = $1 AND provider = $2`,
        [userId, provider]
    );
    if (!row) return null;
    return {
        userId: row.user_id,
        orgId: row.org_id,
        provider: row.provider,
        accessToken: row.access_token ? _decrypt(row.access_token, row.org_id) : null,
        refreshToken: row.refresh_token ? _decrypt(row.refresh_token, row.org_id) : null,
        expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
        scope: row.scope || null,
        status: row.status,
        lastError: row.last_error || null,
    };
}

async function markNeedsReauth(userId, provider, reason) {
    await initDB();
    await run(
        `UPDATE routine_credentials
         SET status = 'needs_reauth', last_error = $3, updated_at = NOW()
         WHERE user_id = $1 AND provider = $2`,
        [userId, provider, String(reason || '').slice(0, 500)]
    );
}

async function markRevoked(userId, provider) {
    await initDB();
    await run(
        `UPDATE routine_credentials SET status = 'revoked', updated_at = NOW()
         WHERE user_id = $1 AND provider = $2`,
        [userId, provider]
    );
}

async function deleteCredential(userId, provider) {
    await initDB();
    const { rowCount } = await run(
        `DELETE FROM routine_credentials WHERE user_id = $1 AND provider = $2`,
        [userId, provider]
    );
    return rowCount > 0;
}

async function listProvidersForUser(userId) {
    await initDB();
    const rows = await getAll(
        `SELECT provider, status FROM routine_credentials WHERE user_id = $1`,
        [userId]
    );
    return rows.map(r => ({ provider: r.provider, status: r.status }));
}

module.exports = {
    upsertCredential,
    getCredential,
    markNeedsReauth,
    markRevoked,
    deleteCredential,
    listProvidersForUser,
    // Exported for tests / debugging. Do not call from app code.
    _internals: { _encrypt, _decrypt, _orgVaultKey },
};
