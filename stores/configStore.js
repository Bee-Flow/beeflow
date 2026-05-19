/**
 * Config Store - PostgreSQL-backed key-value configuration
 * Stores sensitive config like API keys in beeflow_core
 *
 * Sensitive values (API keys, secrets) are encrypted at rest
 * using AES-256-GCM with a key derived from MASTER_ENCRYPTION_KEY.
 *
 * ──── MASTER_ENCRYPTION_KEY rotation ──────────────────────────────────
 * Use scripts/rotate-master-key.js. Operational steps:
 *   1. Generate a new key:  openssl rand -hex 32
 *   2. Set MASTER_ENCRYPTION_KEY_NEW in secrets; redeploy (servers boot
 *      with BOTH the old and new env vars). The cluster keeps reading
 *      with the old key during this window.
 *   3. Run `node scripts/rotate-master-key.js` on one node — it decrypts
 *      every config row with OLD and re-encrypts with NEW. Idempotent.
 *   4. Promote NEW → MASTER_ENCRYPTION_KEY in secrets; drop the _NEW
 *      alias on next deploy.
 * Documented inline rather than only in a runbook so anyone touching this
 * file sees the procedure.
 */

const { run, getOne, getAll, exec } = require('../db');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ── Encryption helpers for secrets at rest ──────────────────────
// Derives a 256-bit key from MASTER_ENCRYPTION_KEY using HKDF-SHA256.
//
// Two derivation contexts are supported:
//   • 'beeflow:config-secrets:v1'         — default; used by all rows that
//      don't belong to a single org (provider client secrets, FX rates, …)
//      and by every legacy row written before per-org HKDF landed.
//   • 'beeflow:config-secrets:v1:<orgId>' — used for `org_<orgId>_*` keys.
//      A master-key rotation re-encrypts all rows under the new master, but
//      per-org rows additionally bind to the org id so a leak of one org's
//      derived key doesn't reveal another org's.
//
// The envelope records the context as `keyContext: '<orgId>' | undefined`
// so decrypt can pick the right derivation without scanning the key name.

const ORG_KEY_PREFIX_RE = /^org_([^_]+)_/;

function _inferOrgIdFromKey(key) {
    if (!key || typeof key !== 'string') return null;
    const m = key.match(ORG_KEY_PREFIX_RE);
    return m ? m[1] : null;
}

function _deriveKey(orgId = null) {
    const master = process.env.MASTER_ENCRYPTION_KEY;
    if (!master) throw new Error('MASTER_ENCRYPTION_KEY env var is required for config encryption');
    const info = orgId
        ? `beeflow:config-secrets:v1:${orgId}`
        : 'beeflow:config-secrets:v1';
    return crypto.createHmac('sha256', master).update(info).digest();
}

function _getServerEncryptionKey() {
    return _deriveKey(null);
}

// ── Rate-limited decrypt failure logging ────────────────────────
// Batches decrypt errors into a single summary per interval
let _decryptFailCount = 0;
let _decryptFailTimer = null;
const DECRYPT_FAIL_LOG_INTERVAL_MS = 60_000; // 1 minute

function _logDecryptFailure() {
    _decryptFailCount++;
    if (!_decryptFailTimer) {
        _decryptFailTimer = setTimeout(() => {
            if (_decryptFailCount > 0) {
                console.warn(`[ConfigStore] Failed to decrypt ${_decryptFailCount} value(s) in the last 60s — check MASTER_ENCRYPTION_KEY or re-enter API keys via Admin UI`);
                _decryptFailCount = 0;
            }
            _decryptFailTimer = null;
        }, DECRYPT_FAIL_LOG_INTERVAL_MS);
        // Don't hold the process open for this timer
        if (_decryptFailTimer.unref) _decryptFailTimer.unref();
    }
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a JSON-encoded envelope: { _encrypted: "config-v1", iv, authTag, data }.
 *
 * When `orgId` is supplied, derives a per-org key via HKDF info string
 * `beeflow:config-secrets:v1:<orgId>` and records the org context in the
 * envelope so decrypt can rebuild the right key.
 */
function encryptValue(plaintext, orgId = null) {
    if (!plaintext) return plaintext;
    const key = _deriveKey(orgId);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const env = {
        _encrypted: 'config-v1',
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
        data: encrypted.toString('hex'),
    };
    if (orgId) env.keyContext = orgId;
    return JSON.stringify(env);
}

/**
 * Decrypt an AES-256-GCM encrypted envelope.
 *
 *   • Envelopes with `keyContext: '<orgId>'` derive the per-org key.
 *   • Envelopes without keyContext use the legacy single-tenant key.
 *   • Plaintext values pass through unchanged.
 *
 * On failure, returns null (caller surfaces via the rate-limited logger).
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
        const orgCtx = (typeof envelope.keyContext === 'string' && envelope.keyContext) ? envelope.keyContext : null;
        const key = _deriveKey(orgCtx);
        const iv = Buffer.from(envelope.iv, 'hex');
        const authTag = Buffer.from(envelope.authTag, 'hex');
        const data = Buffer.from(envelope.data, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        return decipher.update(data) + decipher.final('utf8');
    } catch (err) {
        _logDecryptFailure();
        return null;
    }
}

// ── In-memory cache (avoids DB round-trips for hot-path reads) ──────
// Config values change very rarely (monthly). Caching them for 60s
// eliminates ~6 DB queries per KB search call.
const CACHE_TTL_MS = 60_000; // 60 seconds
const _cache = new Map(); // key → { value, ts }

function _cacheGet(key) {
    const entry = _cache.get(key);
    if (!entry) return undefined; // undefined = cache miss
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
        _cache.delete(key);
        return undefined;
    }
    return entry.value; // may be null (config key exists but has no value)
}

function _cacheSet(key, value) {
    _cache.set(key, { value, ts: Date.now() });
}

function _cacheInvalidate(key) {
    _cache.delete(key);
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
    // Check in-memory cache first
    const cached = _cacheGet(key);
    if (cached !== undefined) return cached;

    await initDB();
    const row = await getOne('SELECT value FROM config WHERE key = $1', [key]);
    if (!row) {
        _cacheSet(key, null);
        return null;
    }
    let result;
    try {
        result = JSON.parse(row.value);
    } catch (e) {
        result = row.value;
    }
    _cacheSet(key, result);
    return result;
}

async function setConfig(key, value) {
    await initDB();
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    await run(`
        INSERT INTO config (key, value, updated_at) VALUES ($1, $2, NOW())
        ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [key, stringValue]);
    _cacheInvalidate(key); // bust cache on write
    return true;
}

/**
 * Heuristic: extract `{orgId, integration}` from a secret key when it follows
 * one of our known naming conventions. The key set evolves; this is best-
 * effort so the audit entry carries useful context without forcing every
 * call site to thread an explicit context object.
 *
 * Examples handled:
 *   org_webhook_signing_key_<orgId>              → org_webhook_signing_key
 *   connector_tenant_key_<orgId>                 → connector_tenant_key
 *   azure_<orgId>_client_secret                  → azure (org-scoped)
 *   <provider>_api_key                           → <provider> (global)
 *   stripe_webhook_secret                        → stripe (global)
 */
function _inferAuditFromKey(key) {
    if (typeof key !== 'string' || !key) return { integration: 'unknown', orgId: null };
    let integration = null;
    let orgId = null;
    // org-scoped prefixes (longest first)
    const orgPrefixes = [
        ['org_webhook_signing_key_', 'webhook_signer'],
        ['connector_tenant_key_', 'nextcloud_connector'],
        ['org_privacy_shield_', 'privacy_shield'],
    ];
    for (const [prefix, name] of orgPrefixes) {
        if (key.startsWith(prefix)) {
            return { integration: name, orgId: key.slice(prefix.length) || null };
        }
    }
    // Heuristic for `${provider}_*` (api_key, secret, token, etc).
    const m = key.match(/^([a-z0-9]+(?:[_-][a-z0-9]+)*?)(?:_(?:api_?key|secret|token|password|webhook_secret|client_secret))$/i);
    if (m) integration = m[1];
    return { integration: integration || 'unknown', orgId };
}

/**
 * Best-effort emit an access-audit entry for a credential change. Lazy-
 * required to avoid the circular configStore↔userStore load. Failures are
 * swallowed — auditing must never block a credential write.
 */
async function _auditCredentialChange(key, action, ctx) {
    try {
        const { logAccessAudit } = require('./userStore');
        const inferred = _inferAuditFromKey(key);
        const orgId = ctx?.orgId || inferred.orgId || null;
        const integration = ctx?.integration || inferred.integration || 'unknown';
        await logAccessAudit(
            `credential.${action}`,
            'credential',
            key,
            ctx?.userId || null,
            null,
            { integration, action },
            orgId,
        );
    } catch (_) { /* non-fatal */ }
}

/**
 * Store a sensitive value (API key, secret) encrypted at rest.
 * Uses AES-256-GCM with a key derived from MASTER_ENCRYPTION_KEY.
 *
 * Optional 3rd arg `auditCtx` carries audit-log context:
 *   { orgId?, userId?, integration? }
 * The key itself is recorded but never the value.
 */
async function setSecret(key, value, auditCtx = null) {
    await initDB();
    // Don't encrypt empty values
    if (!value || value === '') {
        const ok = await setConfig(key, '');
        _auditCredentialChange(key, 'clear', auditCtx).catch(() => {});
        return ok;
    }
    // Per-org HKDF context: `org_<orgId>_*` keys bind their derived key to
    // the org id so a compromise of one org's derived key doesn't leak
    // another org's secrets. Global keys (provider client secrets, FX rates,
    // …) continue to use the single-tenant info string.
    const orgCtx = _inferOrgIdFromKey(key);
    const encrypted = encryptValue(String(value), orgCtx);
    await run(`
        INSERT INTO config (key, value, updated_at) VALUES ($1, $2, NOW())
        ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [key, encrypted]);
    _cacheInvalidate(key);
    _cacheInvalidate(`__secret__${key}`); // bust secret cache on write
    _auditCredentialChange(key, 'set', auditCtx).catch(() => {});
    return true;
}

/**
 * Retrieve a sensitive value, decrypting if it was encrypted.
 * Transparently handles legacy plaintext values (returns as-is).
 */
async function getSecret(key) {
    // Check in-memory cache first (decrypted values are cached)
    const cached = _cacheGet(`__secret__${key}`);
    if (cached !== undefined) return cached;

    await initDB();
    const row = await getOne('SELECT value FROM config WHERE key = $1', [key]);
    if (!row || !row.value) {
        _cacheSet(`__secret__${key}`, null);
        return null;
    }

    const rawValue = row.value;
    let result;

    // Try to parse as encrypted envelope
    try {
        const parsed = JSON.parse(rawValue);
        if (parsed && typeof parsed === 'object' && parsed._encrypted === 'config-v1') {
            result = decryptValue(parsed);
        } else if (typeof parsed === 'string') {
            result = parsed;
        } else {
            result = rawValue;
        }
    } catch (_) {
        // Not JSON — plaintext legacy value
        result = rawValue;
    }

    _cacheSet(`__secret__${key}`, result);
    return result;
}

async function deleteConfig(key, auditCtx = null) {
    await initDB();
    const { rowCount } = await run('DELETE FROM config WHERE key = $1', [key]);
    _cacheInvalidate(key);
    _cacheInvalidate(`__secret__${key}`);
    // Audit deletions of secret-like keys so the trail captures revocations
    // (e.g. an admin clearing an org's Slack token). Plain config deletes
    // are noisy and not interesting from a security standpoint, so we gate
    // on the same heuristic the re-encryption migration uses.
    if (rowCount > 0 && _looksLikeSecretKey(key)) {
        _auditCredentialChange(key, 'delete', auditCtx).catch(() => {});
    }
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

// ── One-shot legacy plaintext re-encryption ─────────────────────────────────
// Older deployments stored some secret-like keys in plaintext. New writes go
// through encryptValue, but rows created before the encryption rollout sit in
// the DB as readable strings — anyone with read-only DB access can lift API
// keys, webhook secrets, tokens. This migration sweeps the table once,
// identifies plaintext rows whose keys match secret-like patterns, and
// rewrites them through encryptValue. Idempotent: rows already in the
// `config-v1` envelope are skipped.
const SECRET_KEY_PATTERNS = [
    /api[_-]?key$/i,
    /^.*api[_-]?key_/i,
    /secret$/i,
    /_secret_/i,
    /password$/i,
    /_password_/i,
    /token$/i,
    /^.*token_/i,
    /^webhook_signing_/i,
    /^stripe_webhook_secret/i,
    /^connector_tenant_key_/i,
    /^org_webhook_signing_key_/i,
    /^opaque_/i,
    /credentials?$/i,
    /^smtp_pass/i,
];

function _looksLikeSecretKey(key) {
    if (!key || typeof key !== 'string') return false;
    return SECRET_KEY_PATTERNS.some(re => re.test(key));
}

function _isAlreadyEncrypted(raw) {
    if (!raw || typeof raw !== 'string') return false;
    try {
        const parsed = JSON.parse(raw);
        return !!(parsed && typeof parsed === 'object' && parsed._encrypted === 'config-v1');
    } catch (_) { return false; }
}

async function reencryptLegacyPlaintextSecrets() {
    try {
        if (!process.env.MASTER_ENCRYPTION_KEY) {
            // Can't encrypt without a key — leave plaintext rows alone rather
            // than crash. Operators are expected to set this before the
            // first cloud deploy.
            return { scanned: 0, encrypted: 0, skipped: 0, note: 'no MASTER_ENCRYPTION_KEY' };
        }
        await initDB();
        const rows = await getAll('SELECT key, value FROM config');
        let scanned = 0;
        let encrypted = 0;
        let skipped = 0;
        for (const row of rows) {
            scanned++;
            if (!row.value) { skipped++; continue; }
            if (_isAlreadyEncrypted(row.value)) { skipped++; continue; }
            if (!_looksLikeSecretKey(row.key)) { skipped++; continue; }
            try {
                const orgCtx = _inferOrgIdFromKey(row.key);
                const sealed = encryptValue(String(row.value), orgCtx);
                await run(
                    `UPDATE config SET value = $1, updated_at = NOW() WHERE key = $2`,
                    [sealed, row.key]
                );
                _cacheInvalidate(row.key);
                _cacheInvalidate(`__secret__${row.key}`);
                encrypted++;
            } catch (e) {
                console.warn(`[ConfigStore] re-encrypt failed for key="${row.key}": ${e.message}`);
            }
        }
        if (encrypted > 0) {
            console.log(`[ConfigStore] Legacy plaintext re-encryption: ${encrypted}/${scanned} rows sealed (skipped ${skipped}).`);
        }
        return { scanned, encrypted, skipped };
    } catch (err) {
        console.error('[ConfigStore] reencryptLegacyPlaintextSecrets error:', err.message);
        return { scanned: 0, encrypted: 0, skipped: 0, error: err.message };
    }
}

// Run at module load — best-effort, never blocks startup.
reencryptLegacyPlaintextSecrets().catch(() => {});

console.log('[ConfigStore] Initialized (PostgreSQL)');

module.exports = {
    getConfig,
    setConfig,
    deleteConfig,
    getAllConfig,
    setSecret,
    getSecret,
    encryptValue,
    decryptValue,
    reencryptLegacyPlaintextSecrets,
};
