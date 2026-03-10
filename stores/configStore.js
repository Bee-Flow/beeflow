/**
 * Config Store - PostgreSQL-backed key-value configuration
 * Stores sensitive config like API keys in beeflow_core
 * 
 * Sensitive values (API keys, secrets) are encrypted at rest
 * using AES-256-GCM with a key derived from MASTER_ENCRYPTION_KEY.
 */

const { run, getOne, getAll, exec } = require('../db');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ── Encryption helpers for secrets at rest ──────────────────────
// Derives a 256-bit key from MASTER_ENCRYPTION_KEY using HKDF-SHA256

function _getServerEncryptionKey() {
    const master = process.env.MASTER_ENCRYPTION_KEY;
    if (!master) throw new Error('MASTER_ENCRYPTION_KEY env var is required for config encryption');
    // HKDF-expand: derive a purpose-specific 32-byte key
    return crypto.createHmac('sha256', master).update('beeflow:config-secrets:v1').digest();
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a JSON-encoded envelope: { _encrypted: "config-v1", iv, authTag, data }
 */
function encryptValue(plaintext) {
    if (!plaintext) return plaintext;
    const key = _getServerEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return JSON.stringify({
        _encrypted: 'config-v1',
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
        data: encrypted.toString('hex')
    });
}

/**
 * Decrypt an AES-256-GCM encrypted envelope.
 * If the value is NOT encrypted (legacy plaintext), returns it as-is.
 */
function decryptValue(stored) {
    if (!stored) return stored;

    // Parse if string
    let envelope = stored;
    if (typeof stored === 'string') {
        try { envelope = JSON.parse(stored); } catch (_) { return stored; /* plaintext */ }
    }

    // Not an encrypted envelope — return as-is (legacy migration)
    if (!envelope || typeof envelope !== 'object' || envelope._encrypted !== 'config-v1') {
        // If it was parsed from JSON but isn't an encrypted envelope, return original string
        return typeof stored === 'string' ? stored : JSON.stringify(stored);
    }

    try {
        const key = _getServerEncryptionKey();
        const iv = Buffer.from(envelope.iv, 'hex');
        const authTag = Buffer.from(envelope.authTag, 'hex');
        const data = Buffer.from(envelope.data, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        return decipher.update(data) + decipher.final('utf8');
    } catch (err) {
        console.error('[ConfigStore] Failed to decrypt value:', err.message);
        return null;
    }
}

// Schema init
let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    initialized = true;
}

initDB().catch(err => console.error('[ConfigStore] Init error:', err.message));

async function getConfig(key) {
    await initDB();
    const row = await getOne('SELECT value FROM config WHERE key = $1', [key]);
    if (!row) return null;
    try {
        return JSON.parse(row.value);
    } catch (e) {
        return row.value;
    }
}

async function setConfig(key, value) {
    await initDB();
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    await run(`
        INSERT INTO config (key, value, updated_at) VALUES ($1, $2, NOW())
        ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [key, stringValue]);
    return true;
}

/**
 * Store a sensitive value (API key, secret) encrypted at rest.
 * Uses AES-256-GCM with a key derived from MASTER_ENCRYPTION_KEY.
 */
async function setSecret(key, value) {
    await initDB();
    // Don't encrypt empty values
    if (!value || value === '') {
        return setConfig(key, '');
    }
    const encrypted = encryptValue(String(value));
    await run(`
        INSERT INTO config (key, value, updated_at) VALUES ($1, $2, NOW())
        ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [key, encrypted]);
    return true;
}

/**
 * Retrieve a sensitive value, decrypting if it was encrypted.
 * Transparently handles legacy plaintext values (returns as-is).
 */
async function getSecret(key) {
    await initDB();
    const row = await getOne('SELECT value FROM config WHERE key = $1', [key]);
    if (!row || !row.value) return null;

    const rawValue = row.value;

    // Try to parse as encrypted envelope
    try {
        const parsed = JSON.parse(rawValue);
        if (parsed && typeof parsed === 'object' && parsed._encrypted === 'config-v1') {
            return decryptValue(parsed);
        }
        // JSON but not encrypted — could be a legacy stored string
        // For secret keys, we expect strings not objects, so return the raw value
        if (typeof parsed === 'string') return parsed;
        return rawValue;
    } catch (_) {
        // Not JSON — plaintext legacy value
        return rawValue;
    }
}

async function deleteConfig(key) {
    await initDB();
    const { rowCount } = await run('DELETE FROM config WHERE key = $1', [key]);
    return rowCount > 0;
}

async function getAllConfig() {
    await initDB();
    const rows = await getAll('SELECT key, value FROM config');
    const result = {};
    for (const row of rows) {
        try {
            result[row.key] = JSON.parse(row.value);
        } catch (e) {
            result[row.key] = row.value;
        }
    }
    return result;
}

// Automatic migration from config.json to database
async function migrateConfigJson() {
    const ROOT_CONFIG_PATH = path.join(__dirname, 'config.json');
    const DATA_CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');

    let configToMigrate = null;
    let configPathToRename = null;

    if (fs.existsSync(DATA_CONFIG_PATH)) {
        try {
            configToMigrate = JSON.parse(fs.readFileSync(DATA_CONFIG_PATH, 'utf8'));
            configPathToRename = DATA_CONFIG_PATH;
        } catch (e) {
            console.error(`[ConfigStore] Error reading ${DATA_CONFIG_PATH}: ${e.message}`);
        }
    } else if (fs.existsSync(ROOT_CONFIG_PATH)) {
        try {
            configToMigrate = JSON.parse(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8'));
            configPathToRename = ROOT_CONFIG_PATH;
        } catch (e) {
            console.error(`[ConfigStore] Error reading ${ROOT_CONFIG_PATH}: ${e.message}`);
        }
    }

    if (configToMigrate) {
        console.log(`[ConfigStore] Migrating settings from config.json to database...`);
        for (const [key, value] of Object.entries(configToMigrate)) {
            await setConfig(key, value);
        }
        try {
            fs.renameSync(configPathToRename, `${configPathToRename}.bak`);
            console.log(`[ConfigStore] Migration complete. Renamed to config.json.bak`);
        } catch (e) {
            console.error(`[ConfigStore] Failed to rename config.json: ${e.message}`);
        }
    }
}

migrateConfigJson().catch(err => console.error('[ConfigStore] Migration error:', err.message));

console.log('[ConfigStore] Initialized (PostgreSQL)');

module.exports = {
    getConfig,
    setConfig,
    deleteConfig,
    getAllConfig,
    setSecret,
    getSecret,
    encryptValue,
    decryptValue
};
