/**
 * OPAQUE Authentication Routes
 * 
 * Implements the OPAQUE PAKE protocol (RFC 9807) for password-authenticated
 * key exchange. The server never sees the user's password.
 * 
 * Flow:
 *   Registration: startRegistration → createRegistrationResponse → finishRegistration
 *   Login:        startLogin → serverStartLogin → finishLogin → serverFinishLogin
 * 
 * The client obtains an `exportKey` from the OPAQUE protocol which is used
 * to derive a KEK for wrapping/unwrapping the user's DEK entirely client-side.
 */

const express = require('express');
const router = express.Router();
const opaque = require('@serenity-kit/opaque');
const userStore = require('../stores/userStore');
const { requireAuth } = require('./permissions');
const { getRedis } = require('../db');

// Ensure WASM is loaded before handling requests
let opaqueReady = false;
opaque.ready.then(() => {
    opaqueReady = true;
    console.log('[OPAQUE] WASM loaded — OPAQUE protocol ready');
});

/**
 * Get or create the OPAQUE server setup.
 * Stored in OPAQUE_SERVER_SETUP env var.
 * If not set, generates one and logs a warning.
 */
function getServerSetup() {
    if (process.env.OPAQUE_SERVER_SETUP) {
        return process.env.OPAQUE_SERVER_SETUP;
    }
    // Auto-generate for development — MUST be persisted in production
    if (!global._opaqueServerSetup) {
        global._opaqueServerSetup = opaque.server.createSetup();
        console.warn('[OPAQUE] ⚠️  No OPAQUE_SERVER_SETUP env var found — generated ephemeral setup.');
        console.warn('[OPAQUE] ⚠️  Set OPAQUE_SERVER_SETUP in .env for production. Changing it invalidates all registrations.');
        console.warn('[OPAQUE] Generated setup:', global._opaqueServerSetup);
    }
    return global._opaqueServerSetup;
}

// Middleware: ensure OPAQUE WASM is ready
function ensureReady(req, res, next) {
    if (!opaqueReady) {
        return res.status(503).json({ error: 'OPAQUE not ready — WASM loading' });
    }
    next();
}

// Pending login state — Redis-backed with in-memory fallback
const _pendingFallback = new Map();
const PENDING_TTL = 120; // seconds

async function getPendingLogin(loginId) {
    const r = getRedis();
    if (r) {
        const val = await r.get(`bf:opaque:${loginId}`);
        return val ? JSON.parse(val) : null;
    }
    const entry = _pendingFallback.get(loginId);
    if (entry && Date.now() - entry.created > PENDING_TTL * 1000) {
        _pendingFallback.delete(loginId);
        return null;
    }
    return entry || null;
}

async function setPendingLogin(loginId, data) {
    const r = getRedis();
    if (r) {
        await r.set(`bf:opaque:${loginId}`, JSON.stringify(data), 'EX', PENDING_TTL);
    } else {
        _pendingFallback.set(loginId, { ...data, created: Date.now() });
    }
}

async function deletePendingLogin(loginId) {
    const r = getRedis();
    if (r) {
        await r.del(`bf:opaque:${loginId}`);
    } else {
        _pendingFallback.delete(loginId);
    }
}

// Cleanup stale in-memory entries (only relevant when Redis is unavailable)
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of _pendingFallback) {
        if (now - entry.created > PENDING_TTL * 1000) {
            _pendingFallback.delete(key);
        }
    }
}, 60000);

// ============================================================
// REGISTRATION (new user or migration)
// ============================================================

/**
 * Step 1: Client starts registration, sends registrationRequest
 */
router.post('/register/start', ensureReady, async (req, res) => {
    const { username, registrationRequest } = req.body;
    if (!username || !registrationRequest) {
        return res.status(400).json({ error: 'username and registrationRequest required' });
    }

    try {
        const serverSetup = getServerSetup();
        const { registrationResponse } = opaque.server.createRegistrationResponse({
            serverSetup,
            userIdentifier: username,
            registrationRequest
        });

        res.json({ registrationResponse });
    } catch (err) {
        console.error('[OPAQUE] Registration start failed:', err.message);
        res.status(500).json({ error: 'OPAQUE registration failed' });
    }
});

/**
 * Step 2: Client finishes registration, sends registrationRecord + wrapped keys
 * The client has already:
 *   1. Derived KEK from exportKey via HKDF
 *   2. Generated DEK (random 32 bytes)
 *   3. Wrapped DEK with KEK (AES-256-GCM)
 *   4. Generated recovery key, wrapped DEK with it
 */
router.post('/register/finish', async (req, res) => {
    const { username, registrationRecord, wrappedDEK, recoveryWrappedDEK, kekSalt } = req.body;
    if (!username || !registrationRecord || !wrappedDEK) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        // Check if user exists (for migration) or is new (for signup)
        let user = await userStore.getUser(username);
        const isNewUser = !user;

        if (isNewUser) {
            // For signup — the user should already be created by /auth/signup, 
            // so this is used to finalize OPAQUE registration after initial signup
            return res.status(404).json({ error: 'User not found — create account first via /auth/signup' });
        }

        // Store OPAQUE record and wrapped keys
        await userStore.updateUser(username, {
            opaqueRecord: registrationRecord,
            kdfMode: 'opaque_v1',
            wrappedDEK: JSON.stringify(wrappedDEK),
            recoveryWrappedDEK: recoveryWrappedDEK ? JSON.stringify(recoveryWrappedDEK) : user.recoveryWrappedDEK,
            kekSalt: kekSalt || user.kekSalt
        });

        console.log(`[OPAQUE] Registration complete for user ${username} (mode: opaque_v1)`);

        // Set session
        req.session.isAuthenticated = true;
        req.session.user = {
            id: user.id,
            displayName: user.displayName,
            role: user.role || 'user',
            avatar: user.avatar || null,
            avatarType: user.avatarType || null
        };
        req.session.isAdmin = user.role === 'admin';
        // Note: NO encryptionKey in session — client holds it
        req.session.opaqueMode = true;

        req.session.save((err) => {
            if (err) console.error('Session save error:', err);
            res.json({
                success: true,
                user: req.session.user
            });
        });
    } catch (err) {
        console.error('[OPAQUE] Registration finish failed:', err.message);
        res.status(500).json({ error: 'OPAQUE registration finalization failed' });
    }
});

// ============================================================
// LOGIN
// ============================================================

/**
 * Step 1: Client starts login, sends startLoginRequest
 * Server responds with loginResponse + user's wrappedDEK (for client-side unwrap)
 */
router.post('/login/start', ensureReady, async (req, res) => {
    const { username, startLoginRequest } = req.body;
    if (!username || !startLoginRequest) {
        return res.status(400).json({ error: 'username and startLoginRequest required' });
    }

    try {
        const user = await userStore.getUser(username);
        if (!user || !user.opaqueRecord) {
            // Don't reveal whether user exists — use dummy response
            // OPAQUE supports this via fake credentials
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (user.kdfMode !== 'opaque_v1') {
            return res.status(400).json({ error: 'User is not registered with OPAQUE', useLegacy: true });
        }

        const serverSetup = getServerSetup();
        const { serverLoginState, loginResponse } = opaque.server.startLogin({
            serverSetup,
            userIdentifier: username,
            registrationRecord: user.opaqueRecord,
            startLoginRequest
        });

        // Store server state for finish step
        const loginId = require('crypto').randomUUID();
        await setPendingLogin(loginId, {
            serverLoginState,
            username,
        });

        // Parse stored wrapped DEK
        let wrappedDEK = null;
        let recoveryWrappedDEK = null;
        try { wrappedDEK = JSON.parse(user.wrappedDEK); } catch (_) { }
        try { recoveryWrappedDEK = JSON.parse(user.recoveryWrappedDEK); } catch (_) { }

        res.json({
            loginResponse,
            loginId,
            wrappedDEK,
            recoveryWrappedDEK
        });
    } catch (err) {
        console.error('[OPAQUE] Login start failed:', err.message);
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

/**
 * Step 2: Client finishes login, sends finishLoginRequest
 * Server verifies, establishes session
 * 
 * Client has already:
 *   1. Obtained exportKey from finishLogin
 *   2. Derived KEK from exportKey
 *   3. Unwrapped DEK with KEK
 *   4. Optionally sends encrypted DEK for server-side session use
 */
router.post('/login/finish', async (req, res) => {
    const { loginId, finishLoginRequest, encryptedDEK } = req.body;
    if (!loginId || !finishLoginRequest) {
        return res.status(400).json({ error: 'loginId and finishLoginRequest required' });
    }

    const pending = await getPendingLogin(loginId);
    if (!pending) {
        return res.status(400).json({ error: 'Login session expired or invalid' });
    }

    await deletePendingLogin(loginId);

    try {
        const { sessionKey } = opaque.server.finishLogin({
            finishLoginRequest,
            serverLoginState: pending.serverLoginState
        });

        if (!sessionKey) {
            return res.status(401).json({ error: 'OPAQUE login verification failed' });
        }

        const user = await userStore.getUser(pending.username);
        if (!user) {
            return res.status(401).json({ error: 'User not found' });
        }

        // Set session
        req.session.isAuthenticated = true;
        req.session.user = {
            id: user.id,
            displayName: user.displayName,
            role: user.role || 'user',
            avatar: user.avatar || null,
            avatarType: user.avatarType || null
        };
        req.session.isAdmin = user.role === 'admin';
        req.session.opaqueMode = true;

        // If client sent encrypted DEK for server-side use (Option B from plan):
        // The DEK is encrypted with the OPAQUE sessionKey — decrypt it for session storage
        if (encryptedDEK) {
            try {
                const crypto = require('crypto');
                const sessionKeyBuf = Buffer.from(sessionKey, 'base64');
                // Use first 32 bytes of session key as AES key
                const aesKey = sessionKeyBuf.subarray(0, 32);
                const iv = Buffer.from(encryptedDEK.iv, 'hex');
                const tag = Buffer.from(encryptedDEK.authTag, 'hex');
                const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
                decipher.setAuthTag(tag);
                let decrypted = decipher.update(encryptedDEK.data, 'hex', 'utf8');
                decrypted += decipher.final('utf8');
                req.session.encryptionKey = decrypted;
            } catch (dekErr) {
                console.error('[OPAQUE] Failed to decrypt DEK from client:', dekErr.message);
                // Don't fail login — client still holds DEK
            }
        }

        req.session.save((err) => {
            if (err) console.error('Session save error:', err);
            res.json({
                success: true,
                user: req.session.user,
                sessionKey // Client needs this for encrypting DEK to send back
            });
        });
    } catch (err) {
        console.error('[OPAQUE] Login finish failed:', err.message);
        res.status(401).json({ error: 'OPAQUE login verification failed' });
    }
});

// ============================================================
// SSO PIN — OPAQUE for encryption PIN (same protocol, different context)
// ============================================================

/**
 * SSO PIN registration start — user sets their encryption PIN via OPAQUE
 */
router.post('/pin/register/start', ensureReady, requireAuth, async (req, res) => {
    const { registrationRequest } = req.body;
    if (!registrationRequest) {
        return res.status(400).json({ error: 'registrationRequest required' });
    }

    try {
        const userId = req.session.user.id;
        const serverSetup = getServerSetup();
        const { registrationResponse } = opaque.server.createRegistrationResponse({
            serverSetup,
            userIdentifier: `${userId}:pin`,
            registrationRequest
        });

        res.json({ registrationResponse });
    } catch (err) {
        console.error('[OPAQUE] PIN registration start failed:', err.message);
        res.status(500).json({ error: 'PIN registration failed' });
    }
});

/**
 * SSO PIN registration finish
 */
router.post('/pin/register/finish', requireAuth, async (req, res) => {
    const { registrationRecord, wrappedDEK, recoveryWrappedDEK } = req.body;
    if (!registrationRecord || !wrappedDEK) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const userId = req.session.user.id;

        await userStore.updateUser(userId, {
            opaqueRecord: registrationRecord,
            kdfMode: 'opaque_v1',
            wrappedDEK: JSON.stringify(wrappedDEK),
            recoveryWrappedDEK: recoveryWrappedDEK ? JSON.stringify(recoveryWrappedDEK) : undefined,
            ssoEncryptionSetup: 1
        });

        req.session.needsEncryptionSetup = false;
        req.session.needsEncryptionPin = false;
        req.session.opaqueMode = true;

        console.log(`[OPAQUE] PIN registration complete for SSO user ${userId}`);

        req.session.save((err) => {
            if (err) console.error('Session save error:', err);
            res.json({ success: true });
        });
    } catch (err) {
        console.error('[OPAQUE] PIN registration finish failed:', err.message);
        res.status(500).json({ error: 'PIN registration finalization failed' });
    }
});

/**
 * SSO PIN login start
 */
router.post('/pin/login/start', ensureReady, requireAuth, async (req, res) => {
    const { startLoginRequest } = req.body;
    if (!startLoginRequest) {
        return res.status(400).json({ error: 'startLoginRequest required' });
    }

    try {
        const userId = req.session.user.id;
        const user = await userStore.getUser(userId);

        if (!user || !user.opaqueRecord) {
            return res.json({ needsSetup: true });
        }

        const serverSetup = getServerSetup();
        const { serverLoginState, loginResponse } = opaque.server.startLogin({
            serverSetup,
            userIdentifier: `${userId}:pin`,
            registrationRecord: user.opaqueRecord,
            startLoginRequest
        });

        const loginId = require('crypto').randomUUID();
        await setPendingLogin(loginId, {
            serverLoginState,
            username: userId,
            isPinLogin: true,
        });

        let wrappedDEK = null;
        try { wrappedDEK = JSON.parse(user.wrappedDEK); } catch (_) { }

        res.json({ loginResponse, loginId, wrappedDEK });
    } catch (err) {
        console.error('[OPAQUE] PIN login start failed:', err.message);
        res.status(500).json({ error: 'PIN login failed' });
    }
});

/**
 * SSO PIN login finish
 */
router.post('/pin/login/finish', requireAuth, async (req, res) => {
    const { loginId, finishLoginRequest, encryptedDEK } = req.body;
    if (!loginId || !finishLoginRequest) {
        return res.status(400).json({ error: 'loginId and finishLoginRequest required' });
    }

    const pending = await getPendingLogin(loginId);
    if (!pending || !pending.isPinLogin) {
        return res.status(400).json({ error: 'Login session expired or invalid' });
    }

    await deletePendingLogin(loginId);

    try {
        const { sessionKey } = opaque.server.finishLogin({
            finishLoginRequest,
            serverLoginState: pending.serverLoginState
        });

        if (!sessionKey) {
            return res.status(401).json({ error: 'Incorrect PIN' });
        }

        req.session.needsEncryptionPin = false;
        req.session.needsEncryptionSetup = false;
        req.session.opaqueMode = true;

        // Decrypt client-sent DEK for server session (Option B)
        if (encryptedDEK) {
            try {
                const crypto = require('crypto');
                const sessionKeyBuf = Buffer.from(sessionKey, 'base64');
                const aesKey = sessionKeyBuf.subarray(0, 32);
                const iv = Buffer.from(encryptedDEK.iv, 'hex');
                const tag = Buffer.from(encryptedDEK.authTag, 'hex');
                const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
                decipher.setAuthTag(tag);
                let decrypted = decipher.update(encryptedDEK.data, 'hex', 'utf8');
                decrypted += decipher.final('utf8');
                req.session.encryptionKey = decrypted;
            } catch (dekErr) {
                console.error('[OPAQUE] Failed to decrypt PIN DEK from client:', dekErr.message);
            }
        }

        console.log(`[OPAQUE] PIN login complete for SSO user ${pending.username}`);

        req.session.save((err) => {
            if (err) console.error('Session save error:', err);
            res.json({ success: true, sessionKey });
        });
    } catch (err) {
        console.error('[OPAQUE] PIN login finish failed:', err.message);
        res.status(401).json({ error: 'Incorrect PIN' });
    }
});

/**
 * Check if user has OPAQUE registration (for frontend routing)
 */
router.get('/status', requireAuth, async (req, res) => {
    const user = await userStore.getUser(req.session.user?.id);
    res.json({
        kdfMode: user?.kdfMode || 'legacy_argon2',
        hasOpaqueRecord: !!user?.opaqueRecord,
        opaqueMode: req.session.opaqueMode || false
    });
});

module.exports = router;
