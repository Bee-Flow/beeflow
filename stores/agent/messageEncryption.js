/**
 * Message Encryption - Per-conversation envelope encryption using HKDF + AES-256-GCM
 * Pure crypto module, no database dependency.
 */

const crypto = require('crypto');
const { trackDecrypt } = require('../../auth/decryptAudit');

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_IV_LENGTH = 12; // NIST recommended for GCM
const HKDF_SALT = Buffer.from('beeflow:msg:hkdf-salt:v1');

/**
 * Derive a per-conversation encryption key from the root DEK using HKDF.
 */
function deriveConversationKey(dekBase64, conversationId) {
    const dek = Buffer.from(dekBase64, 'base64');
    const info = `beeflow:msg:v2:conv:${conversationId}`;
    return crypto.hkdfSync('sha256', dek, HKDF_SALT, info, 32);
}

/**
 * Build AAD string for v2 encryption.
 */
function buildAAD(conversationId, userId) {
    return Buffer.from(`v2:user:${userId}:conv:${conversationId}`);
}

/**
 * Encrypt messages JSON using per-conversation derived key + AAD.
 */
function encryptMessages(messagesJson, encryptionKeyBase64, conversationId = null, userId = null) {
    if (!encryptionKeyBase64) return messagesJson;

    try {
        let key, version, aad = null;

        if (conversationId && userId) {
            key = Buffer.from(deriveConversationKey(encryptionKeyBase64, conversationId));
            aad = buildAAD(conversationId, userId);
            version = 'v2';
        } else {
            if (conversationId && !userId) {
                console.warn('[MessageEncryption] v2 encrypt skipped: conversationId provided but userId missing');
            }
            key = Buffer.from(encryptionKeyBase64, 'base64');
            version = true;
        }

        const iv = crypto.randomBytes(ENCRYPTION_IV_LENGTH);
        const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
        if (aad) cipher.setAAD(aad);

        let encrypted = cipher.update(messagesJson, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag();

        return JSON.stringify({
            _encrypted: version,
            iv: iv.toString('hex'),
            authTag: authTag.toString('hex'),
            data: encrypted
        });
    } catch (err) {
        console.error('[MessageEncryption] Encryption failed:', err.message);
        return messagesJson;
    }
}

/**
 * Decrypt messages JSON. Handles both v1 (raw DEK) and v2 (HKDF + AAD) formats.
 */
function decryptMessages(storedData, encryptionKeyBase64, conversationId = null, userId = null) {
    try {
        const parsed = JSON.parse(storedData);

        if (!parsed._encrypted) return storedData;

        // Track decrypt operation for anomaly detection
        trackDecrypt(userId, conversationId);

        if (!encryptionKeyBase64) {
            console.warn('[MessageEncryption] Encrypted data but no key provided');
            return '[]';
        }

        let key, aad = null;

        if (parsed._encrypted === 'v2') {
            if (!conversationId || !userId) {
                console.error('[MessageEncryption] v2 decrypt failed: missing conversationId or userId for AAD');
                return '[]';
            }
            key = Buffer.from(deriveConversationKey(encryptionKeyBase64, conversationId));
            aad = buildAAD(conversationId, userId);
        } else {
            key = Buffer.from(encryptionKeyBase64, 'base64');
        }

        const iv = Buffer.from(parsed.iv, 'hex');
        const authTag = Buffer.from(parsed.authTag, 'hex');
        const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
        if (aad) decipher.setAAD(aad);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(parsed.data, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (err) {
        if (err instanceof SyntaxError) return storedData;
        console.error('[MessageEncryption] Decryption failed:', err.message);
        return '[]';
    }
}

module.exports = {
    deriveConversationKey,
    buildAAD,
    encryptMessages,
    decryptMessages
};
