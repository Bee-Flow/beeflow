/**
 * MFA (TOTP) management endpoints — mounted at /auth/mfa.
 *
 * Enrollment is two-step: /setup mints a pending secret (kept in the session,
 * NOT persisted) and returns a QR + otpauth URL; /enable verifies a code
 * against that pending secret before it's persisted (encrypted) and recovery
 * codes are issued once. Login-time verification lives in loginRoutes.js
 * (/auth/mfa/verify-login) so it can reuse the session-completion path.
 */
const express = require('express');
const userStore = require('../stores/userStore');
const { requireAuth, loadConfig } = require('./permissions');
const mfa = require('./mfa');

const router = express.Router();

// Ensure a users-table row exists for the caller (the config admin may not
// have one yet if encryption was never initialised). Returns the row or null.
async function ensureUserRow(userId) {
    let row = await userStore.getUser(userId);
    if (!row && userId === 'admin') {
        try {
            const cfg = await loadConfig();
            await userStore.createUser({
                id: 'admin', username: 'admin', displayName: 'Administrator',
                passwordHash: cfg.admin.passwordHash, role: 'admin', groups: [],
            });
            row = await userStore.getUser('admin');
        } catch (_) { /* fall through */ }
    }
    return row;
}

// Current MFA state for the security settings UI.
router.get('/status', requireAuth, async (req, res) => {
    try {
        const row = await userStore.getUser(req.session.user.id);
        res.json({
            enabled: !!row?.mfa_enabled,
            recoveryCodesRemaining: mfa.remainingRecoveryCodes(row?.mfa_recovery_codes),
            // Whether the account has a password (false for OAuth/SSO-only
            // accounts) — gates the "Change password" card in settings.
            hasPassword: !!row?.passwordHash,
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to load MFA status' });
    }
});

// Begin enrollment — mint a pending secret + QR. Not enabled until /enable.
router.post('/setup', requireAuth, async (req, res) => {
    try {
        const secret = mfa.generateSecret();
        req.session.mfaSetupSecret = secret;
        const label = req.session.user.displayName || req.session.user.id;
        const otpauthUrl = mfa.otpauthUrl(secret, label);
        const qr = await mfa.qrDataUrl(otpauthUrl);
        req.session.save((err) => {
            if (err) return res.status(500).json({ error: 'Failed to start setup' });
            res.json({ otpauthUrl, qr, secret });
        });
    } catch (e) {
        console.error('[MFA] setup error:', e.message);
        res.status(500).json({ error: 'Failed to start MFA setup' });
    }
});

// Confirm enrollment — verify a code against the pending secret, then persist.
router.post('/enable', requireAuth, async (req, res) => {
    try {
        const pending = req.session.mfaSetupSecret;
        if (!pending) return res.status(400).json({ error: 'Start MFA setup first' });
        if (!mfa.verifyTotp(pending, req.body?.code)) {
            return res.status(400).json({ error: 'Invalid code. Check your authenticator app and try again.' });
        }
        const userId = req.session.user.id;
        const row = await ensureUserRow(userId);
        if (!row) return res.status(400).json({ error: 'User not found' });

        const { plain, stored } = await mfa.generateRecoveryCodes();
        const now = new Date().toISOString();
        await userStore.updateUser(userId, {
            mfaEnabled: true,
            mfaSecret: mfa.encryptSecret(pending),
            mfaEnrolledAt: now,
            mfaRecoveryCodes: JSON.stringify(stored),
            mfaRecoveryCodesGeneratedAt: now,
        });
        delete req.session.mfaSetupSecret;
        req.session.save((err) => {
            if (err) console.error('[MFA] session save:', err.message);
            res.json({ success: true, recoveryCodes: plain });
        });
    } catch (e) {
        console.error('[MFA] enable error:', e.message);
        res.status(500).json({ error: 'Failed to enable MFA' });
    }
});

// Turn off MFA — requires a current TOTP code or an unused recovery code.
router.post('/disable', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const row = await userStore.getUser(userId);
        if (!row?.mfa_enabled) return res.json({ success: true });

        const secret = mfa.decryptSecret(row.mfa_secret);
        let ok = mfa.verifyTotp(secret, req.body?.code);
        if (!ok) ok = !!(await mfa.consumeRecoveryCode(row.mfa_recovery_codes, req.body?.code));
        if (!ok) return res.status(400).json({ error: 'Invalid code' });

        await userStore.updateUser(userId, {
            mfaEnabled: false, mfaSecret: null, mfaEnrolledAt: null,
            mfaRecoveryCodes: null, mfaRecoveryCodesGeneratedAt: null,
        });
        res.json({ success: true });
    } catch (e) {
        console.error('[MFA] disable error:', e.message);
        res.status(500).json({ error: 'Failed to disable MFA' });
    }
});

// Re-issue recovery codes (invalidates the old set). Requires a TOTP code.
router.post('/recovery-codes/regenerate', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const row = await userStore.getUser(userId);
        if (!row?.mfa_enabled) return res.status(400).json({ error: 'MFA not enabled' });
        const secret = mfa.decryptSecret(row.mfa_secret);
        if (!mfa.verifyTotp(secret, req.body?.code)) return res.status(400).json({ error: 'Invalid code' });

        const { plain, stored } = await mfa.generateRecoveryCodes();
        await userStore.updateUser(userId, {
            mfaRecoveryCodes: JSON.stringify(stored),
            mfaRecoveryCodesGeneratedAt: new Date().toISOString(),
        });
        res.json({ success: true, recoveryCodes: plain });
    } catch (e) {
        console.error('[MFA] regenerate error:', e.message);
        res.status(500).json({ error: 'Failed to regenerate recovery codes' });
    }
});

module.exports = router;
