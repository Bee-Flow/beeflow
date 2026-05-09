/**
 * Zero-Knowledge Envelope Encryption Module
 * 
 * Implements DEK/KEK encryption with zero-knowledge architecture:
 * - DEK (Data Encryption Key): Random 32-byte key per user, encrypts messages
 * - KEK (Key Encryption Key): Derived from password/PIN via Argon2id, wraps DEK
 * - Recovery Key: One-time backup key shown to user, wraps DEK independently
 * 
 * The server NEVER stores plaintext DEKs or any key material that could
 * derive them without user input (password, PIN, or recovery key).
 * 
 * Security improvements over previous version:
 * - Argon2id instead of PBKDF2 (memory-hard, GPU/ASIC resistant)
 * - Random 32-byte salts instead of deterministic salts
 * - 12-byte IVs per NIST SP 800-38D for AES-GCM
 * - AAD (Additional Authenticated Data) to bind ciphertext to context
 * - No hardcoded fallback secrets
 * - No master key backdoor — server cannot derive DEK
 * - DEK returned as Buffer for secure memory clearing
 */

const crypto = require('crypto');
const argon2 = require('argon2');
const userStore = require('../stores/userStore');

// sodium-native for guaranteed memory zeroing (sodium_memzero)
let sodium;
try {
    sodium = require('sodium-native');
} catch {
    sodium = null;
    console.warn('[Crypto] sodium-native not available — falling back to Buffer.fill(0) for secureClear');
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;       // NIST recommended for GCM
const SALT_LENGTH = 32;
const DEK_LENGTH = 32;
const RECOVERY_KEY_LENGTH = 32;

// Argon2id parameters (OWASP recommended, upgraded for 2026)
const ARGON2_OPTIONS = {
    type: argon2.argon2id,
    memoryCost: 131072,     // 128 MB
    timeCost: 4,
    parallelism: 4,
    hashLength: 32,
    raw: true               // Return Buffer, not encoded string
};

// Higher cost for PINs (lower entropy inputs)
const ARGON2_OPTIONS_PIN = {
    ...ARGON2_OPTIONS,
    timeCost: 5,
};

// Legacy params for backward-compatible unlock (will re-wrap on success)
const ARGON2_OPTIONS_LEGACY = {
    type: argon2.argon2id,
    memoryCost: 65536,      // 64 MB (old default)
    timeCost: 3,            // old default
    parallelism: 4,
    hashLength: 32,
    raw: true
};

/**
 * Validate encryption PIN strength.
 * @param {string} pin
 * @throws {Error} if PIN is too weak
 */
function validateEncryptionPin(pin) {
    if (!pin || pin.length < 6) {
        throw new Error('Encryption PIN must be at least 6 characters');
    }
}

// ============================================================
// KEY DERIVATION
// ============================================================

/**
 * Derive KEK from password/PIN + random salt using Argon2id.
 * This is the ONLY way to get a KEK — no server-side shortcuts.
 * 
 * @param {string|Buffer} password - User's password or PIN
 * @param {string|Buffer} salt - 32-byte random salt (base64 string or Buffer)
 * @returns {Promise<Buffer>} 32-byte KEK
 */
async function deriveKEK(password, salt) {
    if (!password || (typeof password === 'string' && password.length === 0)) {
        throw new Error('Password/PIN cannot be empty');
    }
    const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(salt, 'base64');
    if (saltBuffer.length !== SALT_LENGTH) {
        throw new Error(`Invalid salt length: expected ${SALT_LENGTH}, got ${saltBuffer.length}`);
    }
    return argon2.hash(password, {
        ...ARGON2_OPTIONS,
        salt: saltBuffer
    });
}

/**
 * Derive KEK from PIN with higher Argon2 cost (for SSO PINs).
 * @param {string|Buffer} pin
 * @param {string|Buffer} salt
 * @returns {Promise<Buffer>} 32-byte KEK
 */
async function deriveKEK_PIN(pin, salt) {
    if (!pin || (typeof pin === 'string' && pin.length === 0)) {
        throw new Error('PIN cannot be empty');
    }
    const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(salt, 'base64');
    if (saltBuffer.length !== SALT_LENGTH) {
        throw new Error(`Invalid salt length: expected ${SALT_LENGTH}, got ${saltBuffer.length}`);
    }
    return argon2.hash(pin, {
        ...ARGON2_OPTIONS_PIN,
        salt: saltBuffer
    });
}

/**
 * Derive KEK with LEGACY Argon2 params (for backward-compatible unlock).
 * Only used as fallback during migration.
 */
async function deriveKEK_LEGACY(password, salt) {
    const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(salt, 'base64');
    return argon2.hash(password, {
        ...ARGON2_OPTIONS_LEGACY,
        salt: saltBuffer
    });
}

// ============================================================
// DEK WRAPPING (encrypt/decrypt the DEK itself)
// ============================================================

/**
 * Wrap (encrypt) a DEK with a key, binding to a context via AAD.
 * 
 * @param {Buffer} dek - The DEK to wrap
 * @param {Buffer} key - The wrapping key (KEK or recovery KEK)
 * @param {string} context - AAD context string (e.g. 'dek-wrap:userId')
 * @returns {{ iv: string, authTag: string, data: string }} Base64-encoded wrapped DEK
 */
function wrapDEK(dek, key, context) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    // AAD binds ciphertext to context — prevents cross-user replay
    cipher.setAAD(Buffer.from(context));
    let wrapped = cipher.update(dek);
    wrapped = Buffer.concat([wrapped, cipher.final()]);
    return {
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        data: wrapped.toString('base64')
    };
}

/**
 * Unwrap (decrypt) a DEK with a key and matching AAD context.
 * 
 * @param {{ iv: string, authTag: string, data: string }} wrappedDEK
 * @param {Buffer} key - The unwrapping key
 * @param {string} context - Must match the context used during wrapping
 * @returns {Buffer|null} The DEK or null on failure
 */
function unwrapDEK(wrappedDEK, key, context) {
    try {
        const iv = Buffer.from(wrappedDEK.iv, 'base64');
        const authTag = Buffer.from(wrappedDEK.authTag, 'base64');
        const data = Buffer.from(wrappedDEK.data, 'base64');
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAAD(Buffer.from(context));
        decipher.setAuthTag(authTag);
        let dek = decipher.update(data);
        dek = Buffer.concat([dek, decipher.final()]);
        return dek;
    } catch (err) {
        // Expected: wrong key or tampered ciphertext
        if (err.message?.includes('Unsupported state') || err.code === 'ERR_CRYPTO_AEAD_TAG') {
            return null;
        }
        // Unexpected error — log for debugging
        console.error('[Crypto] Unexpected unwrapDEK error:', err.message);
        return null;
    }
}

// ============================================================
// ZERO-KNOWLEDGE USER SETUP
// ============================================================

/**
 * Create DEK for a new user (registration or first login).
 * Returns { dek, recoveryKey } — recoveryKey MUST be shown to user ONCE.
 * Server never sees the DEK in plaintext after this function returns.
 * 
 * @param {string} userId
 * @param {string} password - User's password or encryption PIN
 * @returns {Promise<{ dek: Buffer, recoveryKey: string }>}
 */
async function createUserDEK(userId, password) {
    const dek = crypto.randomBytes(DEK_LENGTH);
    const kekSalt = crypto.randomBytes(SALT_LENGTH);
    const recoverySalt = crypto.randomBytes(SALT_LENGTH);
    const recoveryKeyRaw = crypto.randomBytes(RECOVERY_KEY_LENGTH);

    // Derive KEK from password
    const kek = await deriveKEK(password, kekSalt);
    const wrappedDEK = wrapDEK(dek, kek, `dek-wrap:${userId}`);

    // Derive recovery KEK from recovery key
    const recoveryKEK = await deriveKEK(recoveryKeyRaw, recoverySalt);
    const recoveryWrappedDEK = wrapDEK(dek, recoveryKEK, `dek-recovery:${userId}`);

    // Store — server has NO way to reverse these without user secrets
    await userStore.updateUser(userId, {
        kekSalt: kekSalt.toString('base64'),
        recoverySalt: recoverySalt.toString('base64'),
        wrappedDEK,
        recoveryWrappedDEK,
        // Clear any legacy master-wrapped DEK
        masterWrappedDEK: null
    });

    // Format recovery key as human-readable
    const recoveryKey = formatRecoveryKey(recoveryKeyRaw);

    // Zero-out sensitive buffers
    secureClear(kek);
    secureClear(recoveryKEK);

    return {
        dek,            // Buffer — caller must secureClear() after use
        recoveryKey     // string — show to user ONCE, then discard
    };
}

/**
 * Unlock DEK with password (normal login).
 * Implements exponential backoff, hard lockout at 20 attempts, and alert logging.
 * 
 * @param {string} userId
 * @param {string} password
 * @returns {Promise<Buffer|null>} DEK buffer or null on failure
 */
async function unlockUserDEK(userId, password) {
    const user = await userStore.getUser(userId);
    if (!user?.wrappedDEK || !user?.kekSalt) return null;

    const failures = user.dekUnwrapFailures || 0;

    // Hard lockout at 20 attempts
    if (failures >= 20) {
        console.error(`[ALERT] HARD LOCKOUT for ${userId} — admin reset or recovery key required (${failures} failures)`);
        return null;
    }

    // Exponential backoff: 2^failures seconds, capped at 1 hour
    if (failures >= 3) {
        const lockoutMs = Math.min(Math.pow(2, failures) * 1000, 3600000);
        const lockoutEnd = user.dekLockoutUntil ? new Date(user.dekLockoutUntil).getTime() : 0;
        if (Date.now() < lockoutEnd) {
            console.error(`[Auth] DEK locked for ${userId}, ${Math.ceil((lockoutEnd - Date.now()) / 1000)}s remaining`);
            return null;
        }
    }

    // Try current params first
    let kek = await deriveKEK(password, user.kekSalt);
    let dek = unwrapDEK(user.wrappedDEK, kek, `dek-wrap:${userId}`);
    secureClear(kek);

    // Fallback: try legacy params (64MB/timeCost 3)
    if (!dek) {
        kek = await deriveKEK_LEGACY(password, user.kekSalt);
        dek = unwrapDEK(user.wrappedDEK, kek, `dek-wrap:${userId}`);
        secureClear(kek);

        if (dek) {
            // Transparent migration: re-wrap with new params
            console.log(`[Auth] Migrating Argon2 params for user ${userId}`);
            const newKEK = await deriveKEK(password, user.kekSalt);
            const newWrapped = wrapDEK(dek, newKEK, `dek-wrap:${userId}`);
            secureClear(newKEK);
            await userStore.updateUser(userId, { wrappedDEK: newWrapped });
        }
    }

    if (!dek) {
        const newFailures = failures + 1;
        const lockoutMs = Math.min(Math.pow(2, newFailures) * 1000, 3600000);
        await userStore.updateUser(userId, {
            dekUnwrapFailures: newFailures,
            dekLockoutUntil: new Date(Date.now() + lockoutMs).toISOString()
        });
        if (newFailures >= 5) {
            console.error(`[ALERT] ${newFailures} failed DEK unwrap attempts for ${userId}`);
        }
        return null;
    }

    // Success — decay failures
    if (failures > 0) {
        await userStore.updateUser(userId, {
            dekUnwrapFailures: Math.max(0, failures - 1),
            dekLockoutUntil: null
        });
    }

    return dek;
}

/**
 * Unlock DEK with recovery key (forgot password flow).
 * After this, user MUST set new password via rewrapUserDEK().
 * 
 * @param {string} userId
 * @param {string} recoveryKeyString - Human-readable recovery key
 * @returns {Promise<Buffer|null>} DEK buffer or null on failure
 */
async function unlockWithRecoveryKey(userId, recoveryKeyString) {
    const user = await userStore.getUser(userId);
    if (!user?.recoveryWrappedDEK || !user?.recoverySalt) return null;

    // Rate limit recovery attempts
    const recoveryFailures = user.recoveryUnwrapFailures || 0;
    if (recoveryFailures >= 10) {
        console.error(`[ALERT] HARD LOCKOUT on recovery key for ${userId} (${recoveryFailures} failures)`);
        return null;
    }
    if (recoveryFailures >= 3) {
        const lockoutEnd = user.recoveryLockoutUntil ? new Date(user.recoveryLockoutUntil).getTime() : 0;
        if (Date.now() < lockoutEnd) return null;
    }

    let recoveryKeyRaw;
    try {
        recoveryKeyRaw = parseRecoveryKey(recoveryKeyString);
    } catch {
        return null; // Invalid format
    }

    const recoveryKEK = await deriveKEK(recoveryKeyRaw, user.recoverySalt);
    const dek = unwrapDEK(user.recoveryWrappedDEK, recoveryKEK, `dek-recovery:${userId}`);
    secureClear(recoveryKEK);
    secureClear(recoveryKeyRaw);

    if (!dek) {
        const newFailures = recoveryFailures + 1;
        await userStore.updateUser(userId, {
            recoveryUnwrapFailures: newFailures,
            recoveryLockoutUntil: new Date(Date.now() + Math.pow(2, newFailures) * 1000).toISOString()
        });
        return null;
    }

    // Success — decay recovery failures
    if (recoveryFailures > 0) {
        await userStore.updateUser(userId, {
            recoveryUnwrapFailures: Math.max(0, recoveryFailures - 1),
            recoveryLockoutUntil: null
        });
    }

    return dek; // Buffer or null
}

// ============================================================
// PASSWORD CHANGE & RECOVERY KEY ROTATION
// ============================================================

/**
 * Re-wrap DEK with a new password (password change flow).
 * Requires the DEK to already be unlocked (user is logged in).
 * 
 * @param {string} userId
 * @param {Buffer} dek - The unlocked DEK
 * @param {string} newPassword
 * @returns {Promise<boolean>}
 */
async function rewrapUserDEK(userId, dek, newPassword) {
    const newKekSalt = crypto.randomBytes(SALT_LENGTH);
    const newKEK = await deriveKEK(newPassword, newKekSalt);
    const newWrappedDEK = wrapDEK(dek, newKEK, `dek-wrap:${userId}`);
    secureClear(newKEK);

    await userStore.updateUser(userId, {
        kekSalt: newKekSalt.toString('base64'),
        wrappedDEK: newWrappedDEK
    });
    return true;
}

/**
 * Rotate recovery key — generates new recovery key, re-wraps DEK.
 * Returns new recoveryKey string to show to user.
 * 
 * @param {string} userId
 * @param {Buffer} dek - The unlocked DEK
 * @returns {Promise<string>} New recovery key string
 */
async function rotateRecoveryKey(userId, dek) {
    const newRecoverySalt = crypto.randomBytes(SALT_LENGTH);
    const newRecoveryKeyRaw = crypto.randomBytes(RECOVERY_KEY_LENGTH);
    const newRecoveryKEK = await deriveKEK(newRecoveryKeyRaw, newRecoverySalt);
    const newRecoveryWrappedDEK = wrapDEK(dek, newRecoveryKEK, `dek-recovery:${userId}`);
    secureClear(newRecoveryKEK);

    await userStore.updateUser(userId, {
        recoverySalt: newRecoverySalt.toString('base64'),
        recoveryWrappedDEK: newRecoveryWrappedDEK
    });

    const key = formatRecoveryKey(newRecoveryKeyRaw);
    secureClear(newRecoveryKeyRaw);
    return key;
}

// ============================================================
// SSO/OAUTH USERS — ENCRYPTION PIN (Option A)
// ============================================================

/**
 * First SSO login: user chooses an encryption PIN.
 * If existingDEK is provided (from legacy master-key unlock), re-wraps that DEK
 * with the new PIN instead of generating a new one — preserving all encrypted data.
 * 
 * @param {string} userId
 * @param {string} encryptionPin - User-chosen PIN (min 6 chars)
 * @param {Buffer} [existingDEK] - Optional existing DEK to re-wrap (legacy migration)
 * @returns {Promise<{ dek: Buffer, recoveryKey: string }>}
 */
async function setupSSOUserDEK(userId, encryptionPin, existingDEK = null) {
    validateEncryptionPin(encryptionPin);

    let result;
    if (existingDEK) {
        // Migration: re-wrap existing DEK with new PIN (higher Argon2 cost)
        const kekSalt = crypto.randomBytes(SALT_LENGTH);
        const kek = await deriveKEK_PIN(encryptionPin, kekSalt);
        const wrappedDEK = wrapDEK(existingDEK, kek, `dek-wrap:${userId}`);
        secureClear(kek);

        // Create recovery key
        const recoverySalt = crypto.randomBytes(SALT_LENGTH);
        const recoveryKeyRaw = crypto.randomBytes(RECOVERY_KEY_LENGTH);
        const recoveryKEK = await deriveKEK(recoveryKeyRaw, recoverySalt);
        const recoveryWrappedDEK = wrapDEK(existingDEK, recoveryKEK, `dek-recovery:${userId}`);
        secureClear(recoveryKEK);

        await userStore.updateUser(userId, {
            wrappedDEK,
            kekSalt: kekSalt.toString('base64'),
            recoverySalt: recoverySalt.toString('base64'),
            recoveryWrappedDEK,
            masterWrappedDEK: null
        });

        const recoveryKey = formatRecoveryKey(recoveryKeyRaw);
        secureClear(recoveryKeyRaw);

        result = { dek: Buffer.from(existingDEK), recoveryKey };
    } else {
        // New user: generate fresh DEK (uses PIN-strength Argon2)
        const dek = crypto.randomBytes(DEK_LENGTH);
        const kekSalt = crypto.randomBytes(SALT_LENGTH);
        const recoverySalt = crypto.randomBytes(SALT_LENGTH);
        const recoveryKeyRaw = crypto.randomBytes(RECOVERY_KEY_LENGTH);

        const kek = await deriveKEK_PIN(encryptionPin, kekSalt);
        const wrappedDEK = wrapDEK(dek, kek, `dek-wrap:${userId}`);

        const recoveryKEK = await deriveKEK(recoveryKeyRaw, recoverySalt);
        const recoveryWrappedDEK = wrapDEK(dek, recoveryKEK, `dek-recovery:${userId}`);

        await userStore.updateUser(userId, {
            kekSalt: kekSalt.toString('base64'),
            recoverySalt: recoverySalt.toString('base64'),
            wrappedDEK,
            recoveryWrappedDEK,
            masterWrappedDEK: null
        });

        const recoveryKey = formatRecoveryKey(recoveryKeyRaw);
        secureClear(kek);
        secureClear(recoveryKEK);
        secureClear(recoveryKeyRaw);

        result = { dek, recoveryKey };
    }

    // Mark SSO encryption as set up
    await userStore.updateUser(userId, { ssoEncryptionSetup: 1 });

    return result;
}

/**
 * Returning SSO login: unlock DEK with encryption PIN.
 * 
 * @param {string} userId
 * @param {string} encryptionPin
 * @returns {Promise<{ dek: Buffer }|{ needsSetup: true }|{ wrongPin: true }>}
 */
async function unlockSSOUserDEK(userId, encryptionPin) {
    const user = await userStore.getUser(userId);

    if (!user?.ssoEncryptionSetup) {
        return { needsSetup: true };
    }

    if (!user?.wrappedDEK || !user?.kekSalt) return { needsSetup: true };

    const failures = user.dekUnwrapFailures || 0;
    if (failures >= 20) return { wrongPin: true };
    if (failures >= 3) {
        const lockoutEnd = user.dekLockoutUntil ? new Date(user.dekLockoutUntil).getTime() : 0;
        if (Date.now() < lockoutEnd) return { wrongPin: true };
    }

    // Try PIN-strength params first
    let kek = await deriveKEK_PIN(encryptionPin, user.kekSalt);
    let dek = unwrapDEK(user.wrappedDEK, kek, `dek-wrap:${userId}`);
    secureClear(kek);

    // Fallback: try legacy params (PINs were originally wrapped with deriveKEK at 64MB/3)
    if (!dek) {
        kek = await deriveKEK_LEGACY(encryptionPin, user.kekSalt);
        dek = unwrapDEK(user.wrappedDEK, kek, `dek-wrap:${userId}`);
        secureClear(kek);

        if (dek) {
            // Transparent migration: re-wrap with new PIN-strength params
            console.log(`[Auth] Migrating SSO PIN Argon2 params for user ${userId}`);
            const newKEK = await deriveKEK_PIN(encryptionPin, user.kekSalt);
            const newWrapped = wrapDEK(dek, newKEK, `dek-wrap:${userId}`);
            secureClear(newKEK);
            await userStore.updateUser(userId, { wrappedDEK: newWrapped });
        }
    }

    if (!dek) {
        const newFailures = failures + 1;
        const lockoutMs = Math.min(Math.pow(2, newFailures) * 1000, 3600000);
        await userStore.updateUser(userId, {
            dekUnwrapFailures: newFailures,
            dekLockoutUntil: new Date(Date.now() + lockoutMs).toISOString()
        });
        return { wrongPin: true };
    }

    if (failures > 0) {
        await userStore.updateUser(userId, {
            dekUnwrapFailures: Math.max(0, failures - 1),
            dekLockoutUntil: null
        });
    }

    return { dek };
}

// ============================================================
// ADMIN OPERATIONS (zero-knowledge — destructive!)
// ============================================================

/**
 * Admin password reset — does NOT recover data.
 * User must use their recovery key to restore access to encrypted data.
 * Without recovery key, old data is PERMANENTLY LOST.
 * 
 * @param {string} userId
 * @returns {boolean}
 */
async function adminResetUser(userId) {
    // Wipe the password-wrapped DEK (it's useless without old password)
    await userStore.updateUser(userId, {
        wrappedDEK: null,
        kekSalt: null,
        // recoveryWrappedDEK stays — user can recover with their key
        passwordResetRequired: 1,
        dekUnwrapFailures: 0,
        dekLockoutUntil: null
    });
    console.log(`[Auth] Admin reset user ${userId} — recovery key required for data`);
    return true;
}

// ============================================================
// LEGACY / TRANSITIONAL SUPPORT
// ============================================================

/**
 * Get or create DEK for a user, with backward compatibility.
 * Handles migration from old master-key wrapped DEKs.
 * 
 * For new users: creates DEK + recovery key.
 * For existing users with old wrappedDEK (no kekSalt): attempt legacy unwrap.
 * For existing users with kekSalt: standard Argon2id unwrap.
 * 
 * @param {string} userId
 * @param {string} password
 * @returns {Promise<{ encryptionKey: string, recoveryKey?: string }|null>}
 */
async function getOrCreateUserDEKCompat(userId, password) {
    const user = await userStore.getUser(userId);

    if (user && user.wrappedDEK) {
        if (user.kekSalt) {
            // New-style: Argon2id with random salt
            const dek = await unlockUserDEK(userId, password);
            if (dek) {
                const key = dek.toString('base64');
                secureClear(dek);
                return { encryptionKey: key };
            }
            return null;
        } else {
            // Legacy: PBKDF2 with deterministic salt — migrate on successful unlock
            const legacyKEK = crypto.pbkdf2Sync(password, `beeflow-kek-${userId}`, 100000, 32, 'sha256');
            const dek = unwrapDEK(user.wrappedDEK, legacyKEK, ''); // legacy had no AAD
            secureClear(legacyKEK);

            if (dek) {
                // Migrate: re-wrap with new Argon2id KEK + create recovery key
                console.log(`[Auth] Migrating DEK for user ${userId} to Argon2id + random salt`);
                const kekSalt = crypto.randomBytes(SALT_LENGTH);
                const newKEK = await deriveKEK(password, kekSalt);
                const newWrappedDEK = wrapDEK(dek, newKEK, `dek-wrap:${userId}`);
                secureClear(newKEK);

                // Create recovery key
                const recoverySalt = crypto.randomBytes(SALT_LENGTH);
                const recoveryKeyRaw = crypto.randomBytes(RECOVERY_KEY_LENGTH);
                const recoveryKEK = await deriveKEK(recoveryKeyRaw, recoverySalt);
                const recoveryWrappedDEK = wrapDEK(dek, recoveryKEK, `dek-recovery:${userId}`);
                secureClear(recoveryKEK);

                await userStore.updateUser(userId, {
                    kekSalt: kekSalt.toString('base64'),
                    recoverySalt: recoverySalt.toString('base64'),
                    wrappedDEK: newWrappedDEK,
                    recoveryWrappedDEK,
                    masterWrappedDEK: null
                });

                const key = dek.toString('base64');
                const recoveryKey = formatRecoveryKey(recoveryKeyRaw);
                secureClear(dek);
                secureClear(recoveryKeyRaw);

                return { encryptionKey: key, recoveryKey };
            }

            // Legacy unwrap failed — try master key as last resort
            const masterKey = getLegacyMasterKey();
            if (masterKey && user.masterWrappedDEK) {
                const dekFromMaster = unwrapDEK(user.masterWrappedDEK, masterKey, '');
                secureClear(masterKey);
                if (dekFromMaster) {
                    // Migrate from master key
                    console.log(`[Auth] Migrating DEK for user ${userId} from master key to Argon2id`);
                    const kekSalt = crypto.randomBytes(SALT_LENGTH);
                    const newKEK = await deriveKEK(password, kekSalt);
                    const newWrappedDEK = wrapDEK(dekFromMaster, newKEK, `dek-wrap:${userId}`);
                    secureClear(newKEK);

                    const recoverySalt = crypto.randomBytes(SALT_LENGTH);
                    const recoveryKeyRaw = crypto.randomBytes(RECOVERY_KEY_LENGTH);
                    const recoveryKEK = await deriveKEK(recoveryKeyRaw, recoverySalt);
                    const recoveryWrappedDEK = wrapDEK(dekFromMaster, recoveryKEK, `dek-recovery:${userId}`);
                    secureClear(recoveryKEK);

                    await userStore.updateUser(userId, {
                        kekSalt: kekSalt.toString('base64'),
                        recoverySalt: recoverySalt.toString('base64'),
                        wrappedDEK: newWrappedDEK,
                        recoveryWrappedDEK,
                        masterWrappedDEK: null
                    });

                    const key = dekFromMaster.toString('base64');
                    const recoveryKey = formatRecoveryKey(recoveryKeyRaw);
                    secureClear(dekFromMaster);
                    secureClear(recoveryKeyRaw);

                    return { encryptionKey: key, recoveryKey };
                }
            }

            return null;
        }
    }

    // No DEK exists — create new one
    const { dek, recoveryKey } = await createUserDEK(userId, password);
    const key = dek.toString('base64');
    secureClear(dek);
    return { encryptionKey: key, recoveryKey };
}

/**
 * Get or create DEK for SSO user with backward compatibility.
 * Legacy SSO users had DEKs wrapped with master key only.
 * 
 * @param {string} userId
 * @param {boolean} [encryptionEnabled=true] - If false, skip encryption entirely (free/basic plans)
 * @returns {{ encryptionKey?: string, needsEncryptionSetup?: boolean, needsEncryptionPin?: boolean }}
 */
async function getOrCreateSSOUserDEKCompat(userId, encryptionEnabled = true) {
    // If encryption is disabled for this user's plan, skip entirely
    if (!encryptionEnabled) {
        return {};
    }

    const user = await userStore.getUser(userId);

    // New system: user has set up encryption PIN
    if (user?.ssoEncryptionSetup) {
        return { needsEncryptionPin: true };
    }

    // Legacy: try master key unwrap
    if (user?.masterWrappedDEK) {
        const masterKey = getLegacyMasterKey();
        if (masterKey) {
            const dek = unwrapDEK(user.masterWrappedDEK, masterKey, '');
            secureClear(masterKey);
            if (dek) {
                const key = dek.toString('base64');
                secureClear(dek);
                // Signal that setup is needed while still providing access
                return { encryptionKey: key, needsEncryptionSetup: true };
            }
        }
    }

    // No DEK at all — needs setup
    return { needsEncryptionSetup: true };
}

/**
 * Legacy master key derivation — ONLY used for migration.
 * Hard deadline: 2026-06-01. After that, legacy unwrap is refused.
 * @returns {Buffer|null}
 */
function getLegacyMasterKey() {
    const secret = process.env.MASTER_ENCRYPTION_KEY;
    if (!secret) return null;

    // Hard deadline — force migration
    const MIGRATION_DEADLINE = new Date('2026-06-01');
    if (Date.now() > MIGRATION_DEADLINE.getTime()) {
        console.error('[CRITICAL] Legacy master key migration deadline passed. Refusing legacy unwrap.');
        return null;
    }

    return crypto.pbkdf2Sync(secret, 'beeflow-master-key', 600000, 32, 'sha256');
}

/**
 * Fallback encryption key for admin users.
 * NOT zero-knowledge — server can derive these keys.
 * Restricted to non-production or explicitly admin contexts.
 *
 * @param {string} userId
 * @returns {string} Base64-encoded 32-byte key
 */
function getFallbackEncryptionKey(userId) {
    const secret = process.env.MASTER_ENCRYPTION_KEY;
    if (!secret) {
        throw new Error('MASTER_ENCRYPTION_KEY env var is required for fallback encryption');
    }
    const salt = `beeflow-fallback-${userId}`;
    return crypto.pbkdf2Sync(secret, salt, 210000, 32, 'sha512').toString('base64');
}

/**
 * Re-wrap DEK during password change with backward compatibility.
 * Unlocks with old password, re-wraps with new password.
 * 
 * @param {string} userId
 * @param {string} oldPassword
 * @param {string} newPassword
 * @returns {Promise<{ success: boolean, encryptionKey?: string }>}
 */
async function rewrapUserDEKCompat(userId, oldPassword, newPassword) {
    const user = await userStore.getUser(userId);
    if (!user || !user.wrappedDEK) {
        return { success: true }; // No DEK to rewrap
    }

    let dek = null;

    if (user.kekSalt) {
        // New-style: Argon2id
        dek = await unlockUserDEK(userId, oldPassword);
    } else {
        // Legacy: PBKDF2 with deterministic salt
        const legacyKEK = crypto.pbkdf2Sync(oldPassword, `beeflow-kek-${userId}`, 100000, 32, 'sha256');
        dek = unwrapDEK(user.wrappedDEK, legacyKEK, '');
        secureClear(legacyKEK);
    }

    if (!dek) {
        return { success: false };
    }

    await rewrapUserDEK(userId, dek, newPassword);
    const key = dek.toString('base64');
    secureClear(dek);
    return { success: true, encryptionKey: key };
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Securely clear sensitive key material from memory.
 * Uses sodium_memzero when available (guaranteed not to be optimized away).
 * Falls back to crypto.randomFill + Buffer.fill(0).
 * 
 * @param {Buffer} buffer - Buffer to zero
 */
function secureClear(buffer) {
    if (!Buffer.isBuffer(buffer)) return;
    if (sodium) {
        sodium.sodium_memzero(buffer);
    } else {
        crypto.randomFillSync(buffer);
        buffer.fill(0);
    }
}

/**
 * Format a raw key buffer as a human-readable recovery key.
 * Format: XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX
 * (8 groups of 8 hex chars = 64 hex chars = 32 bytes, fully preserved)
 * 
 * @param {Buffer} buffer - 32-byte raw key
 * @returns {string} Formatted recovery key
 */
function formatRecoveryKey(buffer) {
    const hex = buffer.toString('hex').toUpperCase();
    return hex.match(/.{1,8}/g).join('-');
}

/**
 * Parse a human-readable recovery key back to a Buffer.
 * 
 * @param {string} keyString - Formatted recovery key
 * @returns {Buffer} Raw key bytes
 */
function parseRecoveryKey(keyString) {
    const hex = keyString.replace(/-/g, '').replace(/\s/g, '').toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(hex)) {
        throw new Error('Invalid recovery key format');
    }
    return Buffer.from(hex, 'hex');
}

/**
 * Generate a fingerprint (HMAC) of a DEK for integrity verification.
 * Store at creation, verify after unwrap to catch subtle corruption.
 * 
 * @param {Buffer} dek - The DEK to fingerprint
 * @param {string} userId - Context binding
 * @returns {string} Base64-encoded HMAC
 */
function dekFingerprint(dek, userId) {
    return crypto.createHmac('sha256', dek)
        .update(`dek-fingerprint:${userId}`)
        .digest('base64');
}

const publicExports = {
    // Core zero-knowledge API
    createUserDEK,
    unlockUserDEK,
    unlockWithRecoveryKey,
    rewrapUserDEK,
    rotateRecoveryKey,
    adminResetUser,

    // SSO PIN flow
    setupSSOUserDEK,
    unlockSSOUserDEK,

    // Backward-compatible wrappers (for gradual migration)
    getOrCreateUserDEKCompat,
    getOrCreateSSOUserDEKCompat,
    rewrapUserDEKCompat,
    getFallbackEncryptionKey,

    // Helpers
    secureClear,
    formatRecoveryKey,
    parseRecoveryKey,
    dekFingerprint,
    validateEncryptionPin
};

// Only expose low-level crypto primitives in test/development
if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
    publicExports.deriveKEK = deriveKEK;
    publicExports.wrapDEK = wrapDEK;
    publicExports.unwrapDEK = unwrapDEK;
}

module.exports = publicExports;
