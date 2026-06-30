/**
 * Org Vault — per-org symmetric encryption for secrets at rest.
 *
 * Extracted from routineCredentialStore so multiple stores can share ONE
 * encryption scheme. AES-256-GCM with a per-org key derived from
 * `MASTER_ENCRYPTION_KEY` via HMAC-SHA256. A leaked org key only affects that
 * org's vault; rotating one org doesn't touch the others.
 *
 * Envelope tag is `routine-vault-v1` (kept verbatim from the original routine
 * credential vault) so ciphertext is interchangeable between every store that
 * uses these helpers — routine_credentials rows and integration_connections
 * rows decrypt with the same key + envelope.
 *
 * Do NOT derive vault keys from SESSION_SECRET (the ticketAssistantStore
 * pattern): that is a session-signing secret with a different rotation
 * lifecycle and a single global key (no per-org isolation).
 */

const crypto = require('crypto');

const ENVELOPE_TAG = 'routine-vault-v1';

// ── Per-org key derivation ──────────────────────────────────────────
function orgVaultKey(orgId) {
    if (!orgId) throw new Error('orgVault: orgId required for key derivation');
    const master = process.env.MASTER_ENCRYPTION_KEY;
    if (!master) throw new Error('MASTER_ENCRYPTION_KEY env var is required for the org vault');
    return crypto.createHmac('sha256', master)
        .update(`beeflow:routine-vault:v1:org:${orgId}`)
        .digest();
}

/**
 * Encrypt a plaintext string under the org's derived key.
 * Returns a JSON-string envelope, or null for empty input.
 */
function encrypt(plaintext, orgId) {
    if (plaintext === null || plaintext === undefined || plaintext === '') return null;
    const key = orgVaultKey(orgId);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return JSON.stringify({
        _encrypted: ENVELOPE_TAG,
        iv: iv.toString('hex'),
        authTag: cipher.getAuthTag().toString('hex'),
        data: data.toString('hex'),
    });
}

/**
 * Decrypt an envelope produced by `encrypt`. Returns the plaintext string, or
 * null when the input is empty / not our envelope / fails auth.
 */
function decrypt(stored, orgId) {
    if (!stored) return null;
    let envelope;
    try { envelope = JSON.parse(stored); } catch (_) { return null; }
    if (!envelope || envelope._encrypted !== ENVELOPE_TAG) return null;
    try {
        const key = orgVaultKey(orgId);
        const iv = Buffer.from(envelope.iv, 'hex');
        const authTag = Buffer.from(envelope.authTag, 'hex');
        const data = Buffer.from(envelope.data, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        return decipher.update(data) + decipher.final('utf8');
    } catch (err) {
        console.warn(`[OrgVault] decrypt failed for org ${orgId}: ${err.message}`);
        return null;
    }
}

/**
 * Encrypt a JSON-serializable object (the typical "secret blob" shape).
 */
function encryptJSON(obj, orgId) {
    if (obj === null || obj === undefined) return null;
    return encrypt(JSON.stringify(obj), orgId);
}

/**
 * Decrypt + JSON.parse. Returns null on any failure.
 */
function decryptJSON(stored, orgId) {
    const plain = decrypt(stored, orgId);
    if (plain === null) return null;
    try { return JSON.parse(plain); } catch (_) { return null; }
}

module.exports = {
    ENVELOPE_TAG,
    orgVaultKey,
    encrypt,
    decrypt,
    encryptJSON,
    decryptJSON,
};
