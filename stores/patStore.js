/**
 * Personal Access Token Store
 *
 * Long-lived API tokens for external clients (Chrome extension, CLI, etc.)
 * Tokens are stored as SHA-256 hashes; the raw token is shown only at creation.
 */

const { run, getOne, getAll, exec } = require('../db');
const crypto = require('crypto');

let initialized = false;

async function initDB() {
    if (initialized) return;

    await exec(`
        CREATE TABLE IF NOT EXISTS personal_access_tokens (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            token_prefix TEXT NOT NULL,
            last_used_at TIMESTAMPTZ,
            expires_at TIMESTAMPTZ,
            revoked_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT now()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_pat_user ON personal_access_tokens(user_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_pat_hash ON personal_access_tokens(token_hash)`);

    initialized = true;
    console.log('[PATStore] Tables initialized');
}

initDB().catch(err => console.error('[PATStore] Init error:', err.message));

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken() {
    // bf_ + 48 random hex chars = 51 chars total
    return 'bf_' + crypto.randomBytes(24).toString('hex');
}

const PATStore = {
    /**
     * Create a new PAT. Returns the raw token ONCE — store it client-side immediately.
     */
    async createToken(userId, name, expiresAt = null) {
        await initDB();
        const token = generateToken();
        const tokenHash = hashToken(token);
        const tokenPrefix = token.substring(0, 11); // "bf_xxxxxxxx"

        const row = await getOne(
            `INSERT INTO personal_access_tokens (user_id, name, token_hash, token_prefix, expires_at)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, name, token_prefix, expires_at, created_at`,
            [userId, name, tokenHash, tokenPrefix, expiresAt]
        );

        return { ...row, token };
    },

    async listTokens(userId) {
        await initDB();
        return getAll(
            `SELECT id, name, token_prefix, last_used_at, expires_at, revoked_at, created_at
             FROM personal_access_tokens
             WHERE user_id = $1
             ORDER BY created_at DESC`,
            [userId]
        );
    },

    async revokeToken(id, userId) {
        await initDB();
        await run(
            `UPDATE personal_access_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2`,
            [id, userId]
        );
        return true;
    },

    /**
     * Look up a token by raw value. Returns { id, user_id } if valid, null otherwise.
     */
    async findByToken(rawToken) {
        await initDB();
        if (!rawToken || !rawToken.startsWith('bf_')) return null;
        const tokenHash = hashToken(rawToken);
        const row = await getOne(
            `SELECT id, user_id, expires_at, revoked_at
             FROM personal_access_tokens
             WHERE token_hash = $1`,
            [tokenHash]
        );
        if (!row) return null;
        if (row.revoked_at) return null;
        if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
        return { id: row.id, userId: row.user_id };
    },

    async touchLastUsed(id) {
        await initDB();
        await run(
            `UPDATE personal_access_tokens SET last_used_at = now() WHERE id = $1`,
            [id]
        );
    },
};

module.exports = PATStore;
