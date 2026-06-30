/**
 * Login, Session & Setup Routes
 *
 * Handles: /my-permissions, /setup-status, /setup, /admin-login,
 * /settings, /user, /logout
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const router = express.Router();

const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');
const mfa = require('./mfa');
const { loadConfig, saveConfig, requireAuth, requireAdmin, getUserPermissions } = require('./permissions');
const { getOrCreateUserDEKCompat, setupSSOUserDEK, unlockSSOUserDEK, unlockWithRecoveryKey, secureClear } = require('./encryption');
const { checkWebSignupAllowed, getSignupAccessConfig, resolveSignupLocale } = require('./signupGuards');
const consentGuards = require('./consentGuards');

/**
 * Check if encryption is enabled for a user based on their org's subscription plan.
 * Encryption is a paid feature — disabled by default unless plan explicitly includes it.
 */
async function isEncryptionEnabledForUser(userId) {
    // Encryption (per-user PIN-wrapped DEK) is still in beta. Strict opt-in:
    // only on for orgs whose `allowed_features` explicitly lists "encryption".
    // No admin bypass, no implicit "empty list means all on" — that triggered
    // a forced PIN-setup screen for every SSO admin on production.
    try {
        const user = await userStore.getUser(userId);
        if (!user) return false;
        const orgId = user.organizationId;
        if (!orgId) return false;
        const limits = await userStore.getEffectiveLimits(orgId);
        const features = limits?.allowed_features;
        return Array.isArray(features) && features.includes('encryption');
    } catch (e) {
        return false;
    }
}

// Get current user's permissions (dynamic)
router.get('/my-permissions', requireAuth, async (req, res) => {
    const userId = req.session.user?.id;
    const perms = await getUserPermissions(userId, req.session);

    // Also resolve user's groups and organizations for frontend scoping
    let userGroups = [];
    let userOrgIds = [];
    let allowedAgentTypes = [];
    let user = null;
    try {
        user = await userStore.getUser(userId);
        if (user) {
            userGroups = Array.isArray(user.groups) ? user.groups : (() => { try { return JSON.parse(user.groups || '[]'); } catch (_) { return []; } })();
            const allGroups = await userStore.getAllGroups();
            const orgSet = new Set();
            const agentTypeSet = new Set();
            for (const gid of userGroups) {
                const group = allGroups.find(g => g.id === gid);
                if (group?.organizationId) orgSet.add(group.organizationId);
                // Merge allowed agent types from all groups
                const types = group?.allowedAgentTypes || [];
                for (const t of types) agentTypeSet.add(t);
            }
            // Include direct org assignment
            if (user.organizationId) orgSet.add(user.organizationId);
            userOrgIds = [...orgSet];
            allowedAgentTypes = [...agentTypeSet];
        }
    } catch (_) { }

    // Derive the beta-feature list AND the canUseFeature map from the ONE unified
    // resolver (the same resolveEntitlements that requireCapability enforces), so
    // the SPA's UI gates agree with every API gate. Previously these were computed
    // from a parallel resolver (getUserBetaFeatures + tier/grant math); that
    // second path could drift, which is what made a page render while its API 403'd.
    let betaFeatures = [];
    const canUseFeature = {};
    try {
        const entitlements = require('../core/entitlements');
        const { listCompoundGatedFeatures } = require('../core/betaFeatures');
        const snap = await entitlements.resolveEntitlements({
            userId,
            orgId: req.session.user?.organizationId || req.session.user?.orgId || null,
            session: req.session,
            req,
        });
        if (snap && !snap.degraded) {
            // The granted beta capabilities (effective.beta) — exactly what the
            // API allows. Drives `user.betaFeatures.includes('X')` UI checks.
            betaFeatures = Array.isArray(snap.effective?.beta) ? snap.effective.beta.slice() : [];
            // canUseFeature[id] = the capability is effective (the compound
            // licence-AND-beta decision is already folded in by the resolver).
            for (const g of listCompoundGatedFeatures()) {
                canUseFeature[g.id] = entitlements.snapshotHas(snap, g.id);
            }
        } else {
            // Transient resolver outage — fall back to the legacy beta list so the
            // UI isn't hard-locked (the API still enforces authoritatively).
            try { betaFeatures = await require('../core/betaFeatures').getUserBetaFeatures(userId, req.session); } catch (_) { /* leave empty */ }
        }
    } catch (err) {
        console.warn('[Auth] my-permissions — entitlement resolution failed:', err?.message);
        try { betaFeatures = await require('../core/betaFeatures').getUserBetaFeatures(userId, req.session); } catch (_) { /* leave empty */ }
    }

    res.json({ permissions: perms, groups: userGroups, organizations: userOrgIds, allowedAgentTypes, betaFeatures, canUseFeature, orgRole: user?.orgRole || '' });
});

// Check if setup is complete (admin password set)
router.get('/setup-status', async (req, res) => {
    const config = await loadConfig();
    const isSetupComplete = !!config.admin.passwordHash;
    const isOAuthConfigured = !!(config.oauth.clientId && config.oauth.clientSecret);
    const isGoogleConfigured = !!(config.providers?.google?.clientId && config.providers?.google?.clientSecret);
    const isMicrosoftConfigured = !!(config.providers?.microsoft?.clientId && config.providers?.microsoft?.clientSecret);
    // Expose server URL so frontend can redirect OAuth directly to the backend
    // (bypassing the frontend nginx proxy which strips Set-Cookie from 302s)
    const serverUrl = process.env.SERVER_PUBLIC_HOST
        ? `${process.env.SERVER_PROTOCOL || 'https'}://${process.env.SERVER_PUBLIC_HOST}`
        : '';
    // Include available locales for pre-auth language picker
    let availableLocales = [];
    try {
        const languageStore = require('../stores/languageStore');
        const locales = await languageStore.getAvailableLocales();
        availableLocales = locales.map(l => ({ code: l.code, name: l.name }));
    } catch (err) {
        console.error('[Auth] setup-status — failed to load locales:', err.message);
    }
    // ── Granular signup toggles (database-backed, fallback to env) ──
    const envAllowSignups = process.env.ALLOW_SIGNUPS !== 'false';
    const allowOrgSignups = envAllowSignups ? ((await configStore.getConfig('signup_org_enabled')) ?? true) : false;
    const allowConsumerSignups = envAllowSignups ? ((await configStore.getConfig('signup_consumer_enabled')) ?? false) : false;
    const waitlistEnabled = (await configStore.getConfig('signup_waitlist_enabled')) ?? false;
    const consumerLoginMethods = (await configStore.getConfig('consumer_login_methods')) ?? ['password', 'google', 'microsoft'];
    // Connector-only mode blocks all web signups (org, consumer, OAuth) — hide
    // the "Create Account" button by reporting allowSignups=false below.
    const connectorOnly = (await configStore.getConfig('signup_connector_only')) ?? false;

    // Self-hosted deploys have a single tenant — surface its branding pre-auth
    // so the login page and initial loading screen can render the customer's
    // logo instead of Bee Flow's. Skipped on cloud where there's no single org.
    const deploymentMode = process.env.DEPLOYMENT_MODE || 'cloud';
    let branding = null;
    if (deploymentMode === 'self-hosted') {
        try {
            const orgs = await userStore.getAllOrganizations();
            const org = Array.isArray(orgs) ? orgs.find(o => o.logo || o.name) || orgs[0] : null;
            if (org) branding = { logo: org.logo || null, name: org.name || null };
        } catch (err) {
            console.warn('[Auth] setup-status — branding lookup failed:', err.message);
        }
    }

    res.json({
        isSetupComplete,
        isOAuthConfigured,
        isGoogleConfigured,
        isMicrosoftConfigured,
        serverUrl,
        deploymentMode,
        branding,
        allowSignups: (allowOrgSignups || allowConsumerSignups) && !connectorOnly,
        allowOrgSignups,
        allowConsumerSignups,
        connectorOnly,
        waitlistEnabled,
        consumerLoginMethods,
        allowPasswordLogin: process.env.ALLOW_PASSWORD_LOGIN !== 'false',
        availableLocales,
        // Self-hosted / white-label deploys can override the upgrade URL via
        // LICENSE_UPGRADE_URL. Frontend reads this once at boot.
        licenseUpgradeUrl: process.env.LICENSE_UPGRADE_URL || 'https://beeflow.nl/pricing',
    });
});

// Initial admin setup (set password for first time)
router.post('/setup', async (req, res) => {
    const config = await loadConfig();

    // Only allow if password not set yet
    if (config.admin.passwordHash) {
        return res.status(400).json({ error: 'Setup already complete' });
    }

    const { password } = req.body;
    if (!password || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    // Enforce complexity: at least one uppercase, one lowercase, one digit
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
        return res.status(400).json({ error: 'Password must contain uppercase, lowercase, and a number' });
    }

    config.admin.passwordHash = await bcrypt.hash(password, 12);
    if (!saveConfig(config)) {
        return res.status(500).json({ error: 'Failed to save config' });
    }

    // Create admin user in the users table so DEK can be stored
    try {
        const existing = await userStore.getUser('admin');
        if (!existing) {
            await userStore.createUser({
                id: 'admin',
                username: 'admin',
                displayName: 'Administrator',
                passwordHash: config.admin.passwordHash,
                role: 'admin',
                groups: []
            });
        } else {
            // Update the password hash if admin row already exists
            await userStore.updateUser('admin', { passwordHash: config.admin.passwordHash });
        }

        // Generate per-user DEK (same as regular users) with recovery key
        const { createUserDEK, secureClear } = require('./encryption');
        const { dek, recoveryKey } = await createUserDEK('admin', password);
        secureClear(dek);

        console.log('[Auth] Admin DEK created with per-user Argon2id encryption');
        res.json({ success: true, recoveryKey });
    } catch (err) {
        console.error('[Auth] Admin DEK setup failed:', err.message);
        // Config was saved, so setup is complete, but DEK failed —
        // getOrCreateUserDEKCompat will create it on first login
        res.json({ success: true });
    }
});

// Admin/User login with username/password
router.post('/admin-login', async (req, res) => {
    // Block password login if disabled (admin username is always allowed through)
    if (process.env.ALLOW_PASSWORD_LOGIN === 'false') {
        const config = await loadConfig();
        const { username } = req.body;
        if (username !== config.admin.username) {
            return res.status(403).json({ error: 'Password login is disabled on this server.' });
        }
    }
    const config = await loadConfig();
    const { username, password } = req.body;

    let user = null;
    let isAdmin = false;
    let storedUser = null;

    // 1. Check Config Admin
    if (config.admin.passwordHash && username === config.admin.username) {
        const isValid = await bcrypt.compare(password, config.admin.passwordHash);
        if (isValid) {
            user = { id: 'admin', displayName: 'Administrator', role: 'admin' };
            isAdmin = true;
        }
    }

    // 2. Check UserStore Users (if not already logged in as admin)
    if (!user) {
        storedUser = await userStore.getUser(username);
        // Fallback: if not found by ID and input looks like an email, try email lookup
        if (!storedUser && username.includes('@')) {
            storedUser = await userStore.getUserByEmail(username);
        }
        if (storedUser && storedUser.passwordHash) {
            // If user has migrated to OPAQUE, reject legacy login
            if (storedUser.kdfMode === 'opaque_v1') {
                return res.status(400).json({
                    error: 'This account uses OPAQUE authentication',
                    useOpaque: true,
                    kdfMode: 'opaque_v1'
                });
            }
            const isValid = await bcrypt.compare(password, storedUser.passwordHash);
            if (isValid) {
                user = {
                    id: storedUser.id,
                    displayName: storedUser.displayName,
                    role: storedUser.role || 'user',
                    avatar: storedUser.avatar || null,
                    avatarType: storedUser.avatarType || null
                };
                isAdmin = storedUser.role === 'admin';
            }
        }
    }

    if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    // ── MFA gate ──
    // If the account has TOTP enabled, hold off on establishing the
    // authenticated session: stash a pending blob (incl. the password so the
    // DEK can be derived after the second factor) and ask the client for a
    // code. NOTE: OPAQUE logins don't pass through here yet — MFA enforcement
    // for the OPAQUE path is a follow-up.
    const mfaRow = storedUser || (user.id === 'admin' ? await userStore.getUser('admin') : null);
    if (mfaRow && mfaRow.mfa_enabled) {
        req.session.mfaPending = { userId: user.id, isAdmin, user, password };
        return req.session.save((err) => {
            if (err) console.error('Session save error:', err);
            res.json({ mfaRequired: true });
        });
    }

    return finalizeLogin(req, res, { user, isAdmin, storedUser, password });
});

/**
 * Establish the authenticated session after credentials (and MFA, when
 * enabled) have been verified. Extracted from /admin-login so the MFA
 * verify-login path reuses the exact same session-completion logic
 * (waitlist gate, DEK derivation, recovery-key surfacing).
 */
async function finalizeLogin(req, res, { user, isAdmin, storedUser, password }) {
    req.session.isAuthenticated = true;
    req.session.isAdmin = isAdmin;
    req.session.user = { ...user, isAdmin };

    // ── Block waitlisted / pending users ──
    // Org founders/owners (orgRole 'org_admin') and system admins are never
    // gated: the founder of an organisation IS its admin/owner, so there's no
    // one above them to approve — same rationale as the signup-side waitlist
    // bypass. Without this, a founder whose row is ever left at pending/waitlist
    // gets re-flagged on every login (the flag persists in the PG session), so
    // they hit "Awaiting Approval" after each deploy with no way out.
    const isOwnerOrAdmin = isAdmin || storedUser?.role === 'admin' || storedUser?.orgRole === 'org_admin';
    // ── Block unverified accounts ──
    // A fresh signup whose email isn't confirmed yet cannot log in. Distinct
    // from waitlist/pending so the SPA shows a "verify your email / resend"
    // state, not "awaiting approval". No DEK is derived here — that happens on
    // the first real login after verification flips the row to 'active'.
    // Owners/admins bypass, same rationale as the waitlist gate below.
    if (storedUser && storedUser.status === 'unverified' && !isOwnerOrAdmin) {
        req.session.isAuthenticated = false;
        req.session.isAdmin = false;
        req.session.user = null;
        return req.session.save((err) => {
            if (err) console.error('Session save error:', err);
            res.json({ success: false, emailVerificationRequired: true });
        });
    }
    if (storedUser && (storedUser.status === 'waitlist' || storedUser.status === 'pending') && !isOwnerOrAdmin) {
        req.session.pendingApproval = true;
        return req.session.save((err) => {
            if (err) console.error('Session save error:', err);
            res.json({ success: true, pendingApproval: true, user: req.session.user });
        });
    }
    // Derive and store encryption key — only when encryption is enabled for user's plan
    const encryptionEnabled = await isEncryptionEnabledForUser(user.id);
    try {
        if (!encryptionEnabled) {
            // Encryption disabled for this user's plan — skip DEK
            return req.session.save((err) => {
                if (err) console.error('Session save error:', err);
                res.json({ success: true, user: req.session.user });
            });
        }

        // Ensure admin user exists in users table (for DEK storage)
        if (user.id === 'admin') {
            const adminRow = await userStore.getUser('admin');
            if (!adminRow) {
                const config = await loadConfig();
                await userStore.createUser({
                    id: 'admin', username: 'admin', displayName: 'Administrator',
                    passwordHash: config.admin.passwordHash, role: 'admin', groups: [],
                });
            }
        }

        const result = await getOrCreateUserDEKCompat(user.id, password);
        if (!result) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        req.session.encryptionKey = result.encryptionKey;
        return req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ error: 'Failed to save session' });
            }
            // Include recovery key in response if DEK was just created or migrated
            const response = { success: true, user: req.session.user };
            if (result.recoveryKey) response.recoveryKey = result.recoveryKey;
            res.json(response);
        });
    } catch (err) {
        console.error('[Auth] DEK operation failed:', err.message);
        return res.status(500).json({ error: 'Encryption initialization failed' });
    }
}

// MFA — verify the second factor for a pending password login, then complete
// the session via the shared finalizeLogin path. Gated by session.mfaPending
// (set by /admin-login) rather than requireAuth (the session isn't
// authenticated yet).
router.post('/mfa/verify-login', async (req, res) => {
    const pending = req.session.mfaPending;
    if (!pending) return res.status(401).json({ error: 'No pending MFA login' });
    try {
        const userRow = await userStore.getUser(pending.userId);
        if (!userRow || !userRow.mfa_enabled) {
            delete req.session.mfaPending;
            return res.status(400).json({ error: 'MFA is not enabled for this account' });
        }
        const { code } = req.body || {};
        const secret = mfa.decryptSecret(userRow.mfa_secret);
        let ok = mfa.verifyTotp(secret, code);
        if (!ok) {
            // Fall back to a one-time recovery code (consumes it).
            const updated = await mfa.consumeRecoveryCode(userRow.mfa_recovery_codes, code);
            if (updated) {
                await userStore.updateUser(pending.userId, { mfaRecoveryCodes: JSON.stringify(updated) });
                ok = true;
            }
        }
        if (!ok) return res.status(401).json({ error: 'Invalid code' });

        const { user, isAdmin, password } = pending;
        delete req.session.mfaPending;
        return finalizeLogin(req, res, { user, isAdmin, storedUser: userRow, password });
    } catch (err) {
        console.error('[Auth] MFA verify-login error:', err.message);
        return res.status(500).json({ error: 'MFA verification failed' });
    }
});

// ── Self-service password reset ──────────────────────────────────────────
// Request a reset link. Always responds 200 (never reveals whether an email
// exists). The raw token only ever appears in the emailed link; the DB stores
// SHA-256(token) with a 1-hour expiry.
router.post('/forgot-password', async (req, res) => {
    const respond = () => res.json({ success: true });
    try {
        const { email } = req.body || {};
        if (!email || typeof email !== 'string') return respond();
        const user = await userStore.getUserByEmail(email.trim());
        // Only password accounts can reset (skip OAuth-only / SSO accounts and
        // accounts without an email on file).
        if (!user || !user.email || !user.passwordHash) return respond();

        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        await userStore.updateUser(user.id, {
            passwordResetTokenHash: tokenHash,
            passwordResetExpiresAt: expires,
        });

        const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
        // Point at the SPA login route, which reads `?reset=<token>` and shows the
        // "set new password" form (LoginPage.jsx). `/?reset=` lands on the marketing
        // homepage, which ignores the param, so recovery silently dead-ends (BFSF-239).
        const resetUrl = `${clientHost}/login?reset=${token}`;
        const { sendPasswordResetEmail } = require('../utils/emailService');
        sendPasswordResetEmail({ email: user.email, displayName: user.displayName, resetUrl })
            .catch(e => console.warn('[Auth] reset email failed:', e.message));
        return respond();
    } catch (err) {
        console.error('[Auth] forgot-password error:', err.message);
        return respond();
    }
});

// Complete a reset with a valid token + a new password.
router.post('/reset-password', async (req, res) => {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password are required' });
    if (String(newPassword).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    try {
        const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
        const user = await userStore.getUserByPasswordResetToken(tokenHash);
        if (!user || !user.password_reset_expires_at || new Date(user.password_reset_expires_at).getTime() < Date.now()) {
            return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
        }
        const passwordHash = await bcrypt.hash(String(newPassword), 10);
        await userStore.updateUser(user.id, {
            passwordHash,
            passwordResetTokenHash: null,
            passwordResetExpiresAt: null,
            passwordResetRequired: 0,
        });
        console.log(`[Auth] Password reset completed for user ${user.id}`);
        return res.json({ success: true });
    } catch (err) {
        console.error('[Auth] reset-password error:', err.message);
        return res.status(500).json({ error: 'Failed to reset password' });
    }
});

// ── Email verification ───────────────────────────────────────────────────
// Confirm an account's email via the emailed link. Path-style token + a
// 302-redirect that drops the token from the URL (same rationale as
// /redeem-invite): the raw token never lands in the SPA address bar, the
// Referer header, or proxy access logs. On success the account flips to
// 'active' and the welcome email is sent (once) in the user's locale.
router.get('/verify-email/:token', async (req, res) => {
    const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
    try {
        const raw = String(req.params.token || '');
        const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
        const user = await userStore.getUserByEmailVerificationToken(tokenHash);
        if (!user) {
            // No matching token. Could be already-consumed (one-shot) — but we
            // can't tell which user, so treat as invalid/expired.
            return res.redirect(`${clientHost}/login?error=verify_expired`);
        }
        // Already verified (double-click / token not yet cleared): idempotent success.
        if (user.status !== 'unverified') {
            return res.redirect(`${clientHost}/login?verified=1`);
        }
        if (!user.email_verification_expires_at || new Date(user.email_verification_expires_at).getTime() < Date.now()) {
            return res.redirect(`${clientHost}/login?error=verify_expired`);
        }

        await userStore.updateUser(user.id, {
            status: 'active',
            emailVerifiedAt: new Date().toISOString(),
            emailVerificationTokenHash: null,
            emailVerificationExpiresAt: null,
        });
        console.log(`[Auth] Email verified for user ${user.id}`);
        try {
            await userStore.logAccessAudit('user.email_verified', 'user', user.id, user.id, null, { email: user.email }, user.organizationId || null);
        } catch (_) { /* best-effort */ }

        // Welcome email (once) — now that the account is active.
        if (user.email) {
            Promise.resolve().then(async () => {
                try {
                    const claimed = await userStore.claimNotification('user', user.id, 'welcome_email', user.email);
                    if (!claimed) return;
                    const orgName = user.organizationId ? (await userStore.getOrganization(user.organizationId))?.name : '';
                    const { sendWelcomeEmail } = require('../utils/emailService');
                    await sendWelcomeEmail({ email: user.email, displayName: user.displayName, loginUrl: clientHost, orgName, locale: user.preferred_locale });
                } catch (e) { console.warn('[Auth] welcome email after verify failed:', e.message); }
            });
        }

        return res.redirect(`${clientHost}/login?verified=1`);
    } catch (err) {
        console.error('[Auth] verify-email error:', err.message);
        return res.redirect(`${clientHost}/login?error=verify_error`);
    }
});

// Resend a verification link. Always responds 200 (never reveals whether an
// account exists or its status). Throttled: refuses to regenerate if a token
// was issued in the last 60 seconds.
router.post('/resend-verification', async (req, res) => {
    const respond = () => res.json({ success: true });
    try {
        const { email } = req.body || {};
        if (!email || typeof email !== 'string') return respond();
        const user = await userStore.getUserByEmail(email.trim());
        if (!user || user.status !== 'unverified' || !user.email || !user.passwordHash) return respond();

        // Throttle: if the current token is younger than 60s (24h TTL), skip.
        if (user.email_verification_expires_at) {
            const issuedAt = new Date(user.email_verification_expires_at).getTime() - 24 * 60 * 60 * 1000;
            if (Date.now() - issuedAt < 60 * 1000) return respond();
        }

        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await userStore.updateUser(user.id, {
            emailVerificationTokenHash: tokenHash,
            emailVerificationExpiresAt: expires,
        });

        const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
        const verifyUrl = `${clientHost}/auth/verify-email/${token}`;
        const orgName = user.organizationId ? (await userStore.getOrganization(user.organizationId))?.name : '';
        const { sendVerificationEmail } = require('../utils/emailService');
        sendVerificationEmail({ email: user.email, displayName: user.displayName, verifyUrl, orgName, locale: user.preferred_locale })
            .catch(e => console.warn('[Auth] resend verification email failed:', e.message));
        try {
            await userStore.logAccessAudit('user.verification_resent', 'user', user.id, user.id, null, { email: user.email }, user.organizationId || null);
        } catch (_) { /* best-effort */ }
        return respond();
    } catch (err) {
        console.error('[Auth] resend-verification error:', err.message);
        return respond();
    }
});

// Get settings (admin only)
router.get('/settings', requireAdmin, async (req, res) => {
    const config = await loadConfig();
    res.json({
        oauth: {
            nextcloudUrl: config.oauth.nextcloudUrl || '',
            clientId: config.oauth.clientId || '',
            clientSecretSet: !!config.oauth.clientSecret
        }
    });
});

// Save settings (admin only)
router.post('/settings', requireAdmin, async (req, res) => {
    const config = await loadConfig();
    const { nextcloudUrl, clientId, clientSecret } = req.body;

    config.oauth.nextcloudUrl = nextcloudUrl || '';
    config.oauth.clientId = clientId || '';
    if (clientSecret) {
        config.oauth.clientSecret = clientSecret;
    }

    if (saveConfig(config)) {
        res.json({ success: true });
    } else {
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// Get current user info
router.get('/user', async (req, res) => {
    if (req.session.isAuthenticated && req.session.user) {
        const config = await loadConfig();
        // Fetch fresh avatar data from store
        const freshUser = await userStore.getUser(req.session.user.id);

        // If user no longer exists in DB, invalidate session
        if (!freshUser) {
            req.session.destroy((err) => {
                if (err) console.error('Session destroy error:', err);
            });
            const config = await loadConfig();
            return res.json({
                authenticated: false,
                isOAuthConfigured: !!(config.oauth.clientId && config.oauth.clientSecret),
                oauthProviders: config.oauth.providers || [],
            });
        }

        res.json({
            authenticated: true,
            user: {
                id: req.session.user.id,
                displayName: freshUser?.displayName || req.session.user.displayName || req.session.user['display-name'] || req.session.user.displayname || req.session.user.id,
                firstName: freshUser?.firstName || req.session.user.firstName || '',
                lastName: freshUser?.lastName || req.session.user.lastName || '',
                email: freshUser?.email || req.session.user.email,
                isAdmin: req.session.isAdmin || freshUser?.role === 'admin' || false,
                role: freshUser?.role || req.session.user.role || 'user',
                avatar: freshUser?.avatar || req.session.user.avatar || req.session.user.picture || null,
                avatarType: freshUser?.avatarType || req.session.user.avatarType || (req.session.user.picture ? 'url' : null),
                provider: req.session.user.provider || req.session.oauthProvider || 'local',
                organizationId: freshUser?.organizationId || '',
                orgRole: freshUser?.orgRole || '',
                // Personal UI preference — strips the sidebar/settings down to
                // chat + agents. Read here so the SPA has the flag on first
                // paint and doesn't flash the full UI before /api/ai/user-settings resolves.
                simpleMode: await (async () => {
                    try {
                        const configStore = require('../stores/configStore');
                        return !!(await configStore.getConfig(`simple_mode_user_${req.session.user.id}`));
                    } catch (_) { return false; }
                })()
            },
            isOAuthConfigured: !!(config.oauth.clientId && config.oauth.clientSecret),
            // Encryption status for SSO users. Suppress the setup/pin prompts
            // when encryption is disabled for this user — a stale session flag
            // from before the feature was gated off would otherwise still pop
            // the PIN-setup screen.
            ...(await (async () => {
                const enabled = await isEncryptionEnabledForUser(req.session.user.id);
                return {
                    encryptionEnabled: enabled,
                    needsEncryptionSetup: enabled && !!req.session.needsEncryptionSetup,
                    needsEncryptionPin: enabled && !!req.session.needsEncryptionPin,
                };
            })()),
            // Organisation membership for SSO users
            noOrganization: req.session.noOrganization || false,
            isConsumerAccount: !freshUser?.organizationId && !req.session.noOrganization && (process.env.DEPLOYMENT_MODE || 'cloud') === 'cloud',
            pendingApproval: req.session.pendingApproval || false,
            // Forced MFA enrollment for username/password accounts. Derived LIVE
            // from the fresh DB row (not a sticky session flag — that's the bug
            // class we just fixed for pendingApproval), so it self-clears the
            // moment the user enrols. SSO accounts are exempt (their IdP owns
            // MFA). The built-in admin is included even before it has a users
            // row. Gated by an admin toggle, default ON.
            mfaSetupRequired: await (async () => {
                try {
                    const configStore = require('../stores/configStore');
                    const required = (await configStore.getConfig('require_mfa_for_password_accounts')) ?? true;
                    if (!required) return false;
                    if (freshUser?.mfa_enabled) return false;            // already enrolled
                    const isSso = !!req.session.oauthProvider ||
                                  (freshUser?.provider && freshUser.provider !== 'local');
                    if (isSso) return false;                             // Google/Microsoft own MFA
                    if (req.session.isAdmin || freshUser?.role === 'admin') return true; // admin included (row may not exist yet)
                    return !!freshUser?.passwordHash;                    // local password account
                } catch (_) { return false; }
            })(),
            // Re-consent gate. When a consent-bound legal document's version is
            // bumped, surface the stale docs so the SPA renders <ReconsentGate/>.
            // Derived LIVE from the user's accepted-versions summary vs the
            // registry, so it self-clears the instant they accept. Exempt: the
            // platform admin, NC connector-provisioned users (covered by their
            // org's acceptance), and pending/waitlist users (not yet provisioned).
            ...(await (async () => {
                try {
                    if (req.session.isAdmin || freshUser?.role === 'admin') return { needsReconsent: false };
                    const ap = freshUser?.auto_provisioned;
                    const isConnector = freshUser?.provider === 'nextcloud' || ap === true || ap === 't' || ap === 1;
                    const status = freshUser?.status || 'active';
                    if (isConnector || status === 'pending' || status === 'waitlist' || req.session.pendingApproval) {
                        return { needsReconsent: false };
                    }
                    const accountType = (freshUser?.orgRole === 'org_admin')
                        ? 'org_admin'
                        : (freshUser?.organizationId ? 'org_member' : 'consumer');
                    const r = await consentGuards.needsReconsent(freshUser.id, accountType);
                    return { needsReconsent: r.needsReconsent, reconsentDocs: r.docs };
                } catch (_) { return { needsReconsent: false }; }
            })()),
            // NC App Store onboarding wizard gate. When the connector has
            // bootstrapped a fresh org but the admin hasn't completed the
            // 4-step setup wizard yet, we surface that to the SPA so it
            // renders <NcOnboardingWizard/> for the admin and a "Setup in
            // progress" screen for everyone else in that org.
            ...(await (async () => {
                if (!freshUser?.organizationId) return {};
                const isOrgAdmin = (freshUser?.orgRole === 'org_admin') || (freshUser?.role === 'admin') || !!req.session.isAdmin;
                // Pending NC binding — shown to org-admins so they can
                // approve a connector that's waiting to bind to this org.
                // Surfaced even when nc_instance_id is null because that's
                // exactly the state where adoption is pending.
                let pendingNcBinding = null;
                if (isOrgAdmin) {
                    try {
                        const row = await userStore.getPendingNcBindingForOrg(freshUser.organizationId);
                        if (row) {
                            pendingNcBinding = {
                                id: row.id,
                                ncBaseUrl: row.ncBaseUrl,
                                ncInstanceId: row.ncInstanceId,
                                ncAdminUid: row.ncAdminUid,
                                ncAdminEmail: row.ncAdminEmail,
                                themingName: row.themingName,
                                ncVersion: row.ncVersion,
                                expiresAt: row.expiresAt,
                            };
                        }
                    } catch (e) { console.warn('[auth/user] pendingNcBinding lookup failed:', e.message); }
                }
                const org = await userStore.getOrganization(freshUser.organizationId);
                if (!org?.nc_instance_id) {
                    return pendingNcBinding ? { pendingNcBinding } : {};
                }
                const onboardingDone = !!org.nc_onboarding_completed_at;
                // ncOrg is the org-level binding info — present iff the org
                // was provisioned through Nextcloud. SPA uses this to gate
                // settings sections that don't apply when identity is
                // delegated to NC (sign-in method, allowed domains, etc.).
                return {
                    ncOnboardingNeeded: !onboardingDone && isOrgAdmin,
                    ncOnboardingPending: !onboardingDone && !isOrgAdmin,
                    isOrgAdmin,
                    organizationName: org.name || null,
                    pendingNcBinding,
                    ncOrg: {
                        instanceId: org.nc_instance_id,
                        baseUrl: org.nc_base_url || null,
                        adminUid: org.nc_admin_uid || null,
                        syncMode: org.nc_sync_mode || 'mirror_all',
                        lastSyncAt: org.nc_last_sync_at || null,
                        provisionedAt: org.nc_provisioned_at || null,
                        onboardingCompletedAt: org.nc_onboarding_completed_at || null,
                    },
                };
            })()),
            // Feature flags from env + configStore
            featureFlags: await (async () => {
                const configStore = require('../stores/configStore');
                const notebooksEnabled = await configStore.getConfig('feature_notebooks_enabled');
                const projectsEnabled = await configStore.getConfig('feature_projects_enabled');
                const askAiEnabled = await configStore.getConfig('feature_ask_ai_enabled');
                const exportEnabled = await configStore.getConfig('feature_export_enabled');
                const openInNotebookEnabled = await configStore.getConfig('feature_open_in_notebook_enabled');
                const notebooksMenuEnabled = await configStore.getConfig('feature_notebooks_menu_enabled');
                return {
                    tasks: process.env.ENABLE_TASKS !== 'false',
                    monitoring: process.env.ENABLE_MONITORING !== 'false',
                    meeting_notes: process.env.ENABLE_MEETING_NOTES !== 'false',
                    templates: process.env.ENABLE_TEMPLATES !== 'false',
                    notebooks: notebooksEnabled !== false && notebooksEnabled !== 'false',
                    projects: projectsEnabled !== false && projectsEnabled !== 'false',
                    askAi: askAiEnabled !== false && askAiEnabled !== 'false',
                    export: exportEnabled !== false && exportEnabled !== 'false',
                    openInNotebook: openInNotebookEnabled !== false && openInNotebookEnabled !== 'false',
                    notebooksMenu: notebooksMenuEnabled !== false && notebooksMenuEnabled !== 'false',
                    deploymentMode: process.env.DEPLOYMENT_MODE || 'cloud',
                };
            })(),
            // Org branding (logo + name) for self-hosted white-label rendering
            // in the sidebar / loading screens. Cloud users see the same data
            // but the frontend only swaps the logo when deploymentMode is
            // 'self-hosted', so leaving it populated everywhere is harmless.
            organization: await (async () => {
                try {
                    const orgId = freshUser?.organizationId;
                    if (!orgId) return null;
                    const org = await userStore.getOrganization(orgId);
                    if (!org) return null;
                    return { id: org.id, name: org.name || null, logo: org.logo || null };
                } catch (e) { return null; }
            })(),
            // Org-level enabled integrations
            enabledIntegrations: await (async () => {
                try {
                    const orgId = freshUser?.organizationId;
                    if (!orgId) return null;
                    const org = await userStore.getOrganization(orgId);
                    if (org?.enabledIntegrations) {
                        return typeof org.enabledIntegrations === 'string' ? JSON.parse(org.enabledIntegrations) : org.enabledIntegrations;
                    }
                    // Org uses defaults — load global default integrations
                    const configStore = require('../stores/configStore');
                    const globalDefaults = await configStore.getConfig('default_org_integrations');
                    if (globalDefaults) {
                        return typeof globalDefaults === 'string' ? JSON.parse(globalDefaults) : globalDefaults;
                    }
                    return null; // no defaults configured = all enabled
                } catch (e) { return null; }
            })(),
        });
    } else {
        const config = await loadConfig();
        res.json({
            authenticated: false,
            user: null,
            isOAuthConfigured: !!(config.oauth.clientId && config.oauth.clientSecret)
        });
    }
});

// POST /auth/accept-terms — record re-acceptance of updated legal documents.
// Posted by the <ReconsentGate/> modal. Validates against the CURRENT registry
// for the user's account type, writes ledger rows (method 'reconsent') and
// refreshes the user's accepted-versions summary.
router.post('/accept-terms', async (req, res) => {
    if (!req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    try {
        const freshUser = await userStore.getUser(req.session.user.id);
        if (!freshUser) return res.status(401).json({ error: 'Not authenticated' });

        const accountType = (freshUser.orgRole === 'org_admin')
            ? 'org_admin'
            : (freshUser.organizationId ? 'org_member' : 'consumer');

        // The gate already presented the (subset of) stale documents; we only
        // require the affirmative tick here. recordConsent then re-affirms the
        // full required set at the current versions, clearing needsReconsent.
        const accepted = req.body?.consent?.accepted === true || req.body?.accepted === true;
        const v = consentGuards.validateConsent({ accepted }, accountType);
        if (!v.ok) return res.status(v.status).json({ error: v.error, code: v.code, missing: v.missing });

        await consentGuards.recordConsent({
            userId: freshUser.id,
            email: freshUser.email,
            accountType,
            req,
            method: 'reconsent',
            organizationId: freshUser.organizationId || null,
        });

        res.json({ success: true });
    } catch (e) {
        console.error('[accept-terms] error:', e.message);
        res.status(500).json({ error: 'Failed to record acceptance' });
    }
});

// GET /auth/consents — full consent status for the settings consent center.
// Returns the required documents (with the user's accepted version + date), the
// optional (marketing) consents with current state, and the needsReconsent flag.
router.get('/consents', async (req, res) => {
    if (!req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    try {
        const documentRegistry = require('../legal/documentRegistry');
        const legalDocs = require('../i18n/defaults/legalDocs');
        const freshUser = await userStore.getUser(req.session.user.id);
        if (!freshUser) return res.status(401).json({ error: 'Not authenticated' });

        const accountType = (freshUser.orgRole === 'org_admin')
            ? 'org_admin'
            : (freshUser.organizationId ? 'org_member' : 'consumer');

        const required = documentRegistry.requiredDocsFor(accountType);
        const summary = await userStore.getConsentSummary(freshUser.id);

        // Latest acceptance timestamp per docId (rows come back created_at DESC).
        const ledger = await userStore.getConsentAcceptances(freshUser.id, 500);
        const latestAt = {};
        for (const row of ledger) {
            if (row.doc_id && !(row.doc_id in latestAt)) latestAt[row.doc_id] = row.created_at;
        }

        const documents = required.map(d => {
            const def = legalDocs.getLegalDefault(d.docId) || {};
            const acceptedVersion = summary[d.docId] != null ? Number(summary[d.docId]) : null;
            return {
                docId: d.docId,
                title: def.title || d.docId,
                version: d.version,
                route: def.route || d.urlPath,
                acceptedVersion,
                accepted: acceptedVersion === Number(d.version),
                acceptedAt: latestAt[d.docId] || null,
                upToDate: acceptedVersion === Number(d.version),
            };
        });

        const optState = await userStore.getOptionalConsents(freshUser.id);
        const optional = documentRegistry.optionalConsents()
            .filter(c => c.enabled !== false)
            .map(c => ({
                id: c.id,
                category: c.category,
                version: c.version,
                labelKey: c.labelKey || null,
                granted: !!(optState[c.id] && optState[c.id].granted),
                updatedAt: (optState[c.id] && optState[c.id].updatedAt) || null,
            }));

        const rec = await consentGuards.needsReconsent(freshUser.id, accountType);
        res.json({ accountType, documents, optional, needsReconsent: rec.needsReconsent });
    } catch (e) {
        console.error('[consents] error:', e.message);
        res.status(500).json({ error: 'Failed to load consents' });
    }
});

// POST /auth/consents/optional — grant/withdraw an optional (marketing) consent.
// body: { id, granted }. Records a grant/withdraw ledger row and updates state.
router.post('/consents/optional', async (req, res) => {
    if (!req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    try {
        const documentRegistry = require('../legal/documentRegistry');
        const { id, granted } = req.body || {};
        const consent = documentRegistry.getOptionalConsent(id);
        if (!consent || consent.enabled === false) {
            return res.status(400).json({ error: 'Unknown consent' });
        }
        const freshUser = await userStore.getUser(req.session.user.id);
        if (!freshUser) return res.status(401).json({ error: 'Not authenticated' });

        const grantedBool = granted === true;
        await userStore.recordConsentAcceptance({
            userId: freshUser.id,
            email: freshUser.email,
            accountType: freshUser.organizationId ? 'org' : 'consumer',
            docId: consent.id,
            docVersion: consent.version,
            docSha256: null,
            method: grantedBool ? 'consent_grant' : 'consent_withdraw',
            route: req.originalUrl,
            ip: consentGuards.auditClientIp(req),
            userAgent: req.headers['user-agent'] || null,
            organizationId: freshUser.organizationId || null,
        });

        const state = await userStore.getOptionalConsents(freshUser.id);
        state[consent.id] = { granted: grantedBool, version: consent.version, updatedAt: new Date().toISOString() };
        await userStore.setOptionalConsents(freshUser.id, state);

        res.json({ success: true, id: consent.id, granted: grantedBool });
    } catch (e) {
        console.error('[consents/optional] error:', e.message);
        res.status(500).json({ error: 'Failed to update consent' });
    }
});

// SSO Encryption PIN Setup — first-time SSO user sets their encryption PIN
router.post('/sso-encryption-setup', async (req, res) => {
    if (!req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const { pin } = req.body;
    if (!pin || pin.length < 6) {
        return res.status(400).json({ error: 'Encryption PIN must be at least 6 characters' });
    }
    try {
        const userId = req.session.user.id;

        // Check if session already has a legacy DEK (from master-key unlock)
        let existingDEK = null;
        if (req.session.encryptionKey) {
            existingDEK = Buffer.from(req.session.encryptionKey, 'base64');
            console.log(`[Auth] SSO migration: re-wrapping existing DEK for user ${userId} with new PIN`);
        } else {
            console.log(`[Auth] SSO setup: creating new DEK for user ${userId}`);
        }

        const { dek, recoveryKey } = await setupSSOUserDEK(userId, pin, existingDEK);
        req.session.encryptionKey = dek.toString('base64');
        req.session.needsEncryptionSetup = false;
        req.session.needsEncryptionPin = false;
        secureClear(dek);
        if (existingDEK) secureClear(existingDEK);

        console.log(`[Auth] SSO encryption setup complete for user ${userId} (migration: ${!!existingDEK})`);

        req.session.save((err) => {
            if (err) console.error('Session save error:', err);
            res.json({ success: true, recoveryKey });
        });
    } catch (err) {
        console.error('[Auth] SSO encryption setup failed:', err.message);
        res.status(500).json({ error: 'Encryption setup failed' });
    }
});

// SSO Encryption PIN Unlock — returning SSO user enters their PIN
router.post('/sso-encryption-unlock', async (req, res) => {
    if (!req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const { pin } = req.body;
    if (!pin) {
        return res.status(400).json({ error: 'PIN is required' });
    }
    try {
        const result = await unlockSSOUserDEK(req.session.user.id, pin);
        if (result.needsSetup) {
            return res.json({ needsSetup: true });
        }
        if (result.wrongPin) {
            return res.status(401).json({ error: 'Incorrect PIN' });
        }
        req.session.encryptionKey = result.dek.toString('base64');
        req.session.needsEncryptionPin = false;
        req.session.needsEncryptionSetup = false;
        secureClear(result.dek);
        console.log(`[Auth] SSO encryption unlocked for user ${req.session.user.id}`);
        req.session.save((err) => {
            if (err) console.error('Session save error:', err);
            res.json({ success: true });
        });
    } catch (err) {
        console.error('[Auth] SSO encryption unlock failed:', err.message);
        res.status(500).json({ error: 'Encryption unlock failed' });
    }
});

// SSO Encryption PIN Change — re-wrap DEK with new PIN
router.post('/sso-change-pin', async (req, res) => {
    if (!req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const { oldPin, newPin } = req.body;
    if (!oldPin || !newPin) {
        return res.status(400).json({ error: 'Both old and new PIN are required' });
    }
    if (newPin.length < 6) {
        return res.status(400).json({ error: 'New PIN must be at least 6 characters' });
    }
    try {
        const userId = req.session.user.id;

        // Unlock DEK with old PIN
        const unlockResult = await unlockSSOUserDEK(userId, oldPin);
        if (unlockResult.wrongPin) {
            return res.status(401).json({ error: 'Current PIN is incorrect' });
        }
        if (unlockResult.needsSetup) {
            return res.status(400).json({ error: 'Encryption not set up yet' });
        }

        // Re-wrap DEK with new PIN
        console.log(`[Auth] SSO PIN change: re-wrapping DEK for user ${userId}`);
        const { dek, recoveryKey } = await setupSSOUserDEK(userId, newPin, unlockResult.dek);
        secureClear(unlockResult.dek);

        // Update session with new key
        req.session.encryptionKey = dek.toString('base64');
        secureClear(dek);

        console.log(`[Auth] SSO PIN change complete for user ${userId}`);
        req.session.save((err) => {
            if (err) console.error('Session save error:', err);
            res.json({ success: true, recoveryKey });
        });
    } catch (err) {
        console.error('[Auth] SSO PIN change failed:', err.message);
        res.status(500).json({ error: 'PIN change failed' });
    }
});

// SSO Recovery — unlock with recovery key and set new PIN
router.post('/sso-recovery', async (req, res) => {
    if (!req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const { recoveryKey, newPin } = req.body;
    if (!recoveryKey || !newPin) {
        return res.status(400).json({ error: 'Recovery key and new PIN are required' });
    }
    if (newPin.length < 6) {
        return res.status(400).json({ error: 'New PIN must be at least 6 characters' });
    }
    try {
        const userId = req.session.user.id;

        // Unlock DEK with recovery key
        const dek = await unlockWithRecoveryKey(userId, recoveryKey);
        if (!dek) {
            return res.status(401).json({ error: 'Invalid recovery key' });
        }

        // Re-wrap DEK with new PIN
        console.log(`[Auth] SSO recovery: re-wrapping DEK for user ${userId}`);
        const result = await setupSSOUserDEK(userId, newPin, dek);
        secureClear(dek);

        // Update session with new key
        req.session.encryptionKey = result.dek.toString('base64');
        req.session.needsEncryptionSetup = false;
        req.session.needsEncryptionPin = false;
        secureClear(result.dek);

        console.log(`[Auth] SSO recovery complete for user ${userId}`);
        req.session.save((err) => {
            if (err) console.error('Session save error:', err);
            res.json({ success: true, recoveryKey: result.recoveryKey });
        });
    } catch (err) {
        console.error('[Auth] SSO recovery failed:', err.message);
        res.status(500).json({ error: 'Recovery failed' });
    }
});

// Update current user's profile (avatar, displayName)
router.post('/update-profile', requireAuth, async (req, res) => {
    const userId = req.session.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { avatar, avatarType, displayName } = req.body;
    const updates = {};
    if (avatar !== undefined) updates.avatar = avatar;
    if (avatarType !== undefined) updates.avatarType = avatarType;
    if (displayName !== undefined && displayName.trim()) updates.displayName = displayName.trim();

    try {
        const ok = await userStore.updateUser(userId, updates);
        if (!ok) return res.status(500).json({ error: 'Failed to update profile' });

        // Reflect changes in session
        if (updates.avatar !== undefined) req.session.user.avatar = updates.avatar;
        if (updates.avatarType !== undefined) req.session.user.avatarType = updates.avatarType;
        if (updates.displayName !== undefined) req.session.user.displayName = updates.displayName;

        req.session.save((err) => {
            if (err) console.error('Session save error:', err);
            res.json({ success: true });
        });
    } catch (err) {
        console.error('[Auth] update-profile failed:', err.message);
        res.status(500).json({ error: 'Update failed' });
    }
});

// Logout
router.post('/logout', async (req, res) => {

    req.session.destroy((err) => {
        if (err) console.error('Logout error:', err);
        res.json({ success: true });
    });
});

// Get organizations with signup enabled (public, no auth required)
router.get('/organizations/public', async (req, res) => {
    try {
        const allOrgs = await userStore.getAllOrganizations();
        const orgs = allOrgs.filter(o => o.allowSignup);
        res.json(orgs.map(o => ({ id: o.id, name: o.name, logo: o.logo || null, description: o.description || '' })));
    } catch (err) {
        res.json([]);
    }
});


// Store pending signup data in session (for OAuth flows)
router.post('/pending-signup', async (req, res) => {
    if (process.env.ALLOW_SIGNUPS === 'false') {
        return res.status(403).json({ error: 'Account creation is disabled on this server.' });
    }
    // Connector-only + geo gating (OAuth signup entry point)
    const gate = await checkWebSignupAllowed(req);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.error, code: gate.code });
    const { signupType, authMethod, newOrgName, orgDetails } = req.body;

    // ── Legal consent gate (OAuth entry) ─────────────────────────
    // Validate the acceptance now and carry it through the session into the JIT
    // OAuth callback, where the actual user row is created and the ledger written.
    const consentAccountType = signupType === 'consumer' ? 'consumer' : 'org_admin';
    {
        const v = consentGuards.validateConsent(req.body.consent, consentAccountType);
        if (!v.ok) return res.status(v.status).json({ error: v.error, code: v.code, missing: v.missing });
    }

    // Consumer OAuth signup
    if (signupType === 'consumer') {
        const consumerSignupsEnabled = (await configStore.getConfig('signup_consumer_enabled')) ?? false;
        if (!consumerSignupsEnabled) {
            return res.status(403).json({ error: 'Consumer registration is currently disabled.' });
        }
        req.session.pendingSignup = { signupType: 'consumer', authMethod: authMethod || 'google', consent: { accepted: true, accountType: 'consumer' } };
        return req.session.save((err) => {
            if (err) {
                console.error('[PendingSignup] Session save error:', err);
                return res.status(500).json({ error: 'Failed to save pending signup' });
            }
            console.log(`[PendingSignup] Stored consumer signup in session ${req.sessionID}`);
            res.json({ ok: true });
        });
    }

    // Org OAuth signup
    const orgSignupsEnabled = (await configStore.getConfig('signup_org_enabled')) ?? true;
    if (!orgSignupsEnabled) {
        return res.status(403).json({ error: 'Organization registration is currently disabled.' });
    }
    if (!newOrgName) {
        return res.status(400).json({ error: 'Organization name is required' });
    }
    req.session.pendingSignup = { newOrgName, orgDetails: orgDetails || {}, consent: { accepted: true, accountType: 'org_admin' } };
    req.session.save((err) => {
        if (err) {
            console.error('[PendingSignup] Session save error:', err);
            return res.status(500).json({ error: 'Failed to save pending signup' });
        }
        console.log(`[PendingSignup] Stored org "${newOrgName}" in session ${req.sessionID}`);
        res.json({ ok: true });
    });
});

// ═══════════════════════════════════════════════════════════
// ── Admin: Signup Settings ────────────────────────────────
// ═══════════════════════════════════════════════════════════
router.get('/admin/signup-settings', requireAdmin, async (req, res) => {
    try {
        const orgEnabled = (await configStore.getConfig('signup_org_enabled')) ?? true;
        const consumerEnabled = (await configStore.getConfig('signup_consumer_enabled')) ?? false;
        const waitlistEnabled = (await configStore.getConfig('signup_waitlist_enabled')) ?? false;
        const emailVerificationEnabled = (await configStore.getConfig('signup_email_verification_enabled')) ?? false;
        // Whether the platform can actually send the verification email — the UI
        // uses this to warn that the toggle is a no-op without service email.
        let serviceEmailConfigured = false;
        try { serviceEmailConfigured = (await require('../utils/emailService').getServiceEmailConfig()).configured; } catch (_) { /* ignore */ }
        const requireMfaForPasswordAccounts = (await configStore.getConfig('require_mfa_for_password_accounts')) ?? true;
        const consumerLoginMethods = (await configStore.getConfig('consumer_login_methods')) ?? ['password', 'google', 'microsoft'];
        const access = await getSignupAccessConfig();
        // The ALLOW_SIGNUPS env var is a global kill-switch the public
        // /setup-status applies but these DB toggles don't reflect — surface it
        // so the admin can see *why* the Create Account button is hidden.
        const allowSignupsEnv = process.env.ALLOW_SIGNUPS !== 'false';
        res.json({
            allowOrgSignups: orgEnabled,
            allowConsumerSignups: consumerEnabled,
            waitlistEnabled,
            emailVerificationEnabled,
            serviceEmailConfigured,
            requireMfaForPasswordAccounts,
            consumerLoginMethods,
            connectorOnly: access.connectorOnly,
            geoMode: access.geoMode,
            geoCountries: access.geoCountries,
            geoBlockUnknown: access.geoBlockUnknown,
            geoApplyConnector: access.geoApplyConnector,
            // Effective signup state after all overrides (env + connector-only).
            allowSignupsEnv,
            effectiveAllowSignups: (orgEnabled || consumerEnabled) && !access.connectorOnly && allowSignupsEnv,
        });
    } catch (err) {
        console.error('[Auth] Failed to get signup settings:', err.message);
        res.status(500).json({ error: 'Failed to load signup settings' });
    }
});

router.put('/admin/signup-settings', requireAdmin, async (req, res) => {
    try {
        const { allowOrgSignups, allowConsumerSignups, waitlistEnabled, emailVerificationEnabled, requireMfaForPasswordAccounts, consumerLoginMethods,
                connectorOnly, geoMode, geoCountries, geoBlockUnknown, geoApplyConnector } = req.body;

        // Snapshot current values for the audit trail before mutating.
        const snapshot = async () => ({
            signup_org_enabled: (await configStore.getConfig('signup_org_enabled')) ?? true,
            signup_consumer_enabled: (await configStore.getConfig('signup_consumer_enabled')) ?? false,
            signup_waitlist_enabled: (await configStore.getConfig('signup_waitlist_enabled')) ?? false,
            signup_email_verification_enabled: (await configStore.getConfig('signup_email_verification_enabled')) ?? false,
            require_mfa_for_password_accounts: (await configStore.getConfig('require_mfa_for_password_accounts')) ?? true,
            consumer_login_methods: (await configStore.getConfig('consumer_login_methods')) ?? ['password', 'google', 'microsoft'],
            ...(await getSignupAccessConfig()),
        });
        const oldValues = await snapshot();

        if (typeof allowOrgSignups === 'boolean') {
            await configStore.setConfig('signup_org_enabled', allowOrgSignups);
        }
        if (typeof allowConsumerSignups === 'boolean') {
            await configStore.setConfig('signup_consumer_enabled', allowConsumerSignups);
        }
        if (typeof waitlistEnabled === 'boolean') {
            await configStore.setConfig('signup_waitlist_enabled', waitlistEnabled);
        }
        if (typeof emailVerificationEnabled === 'boolean') {
            await configStore.setConfig('signup_email_verification_enabled', emailVerificationEnabled);
        }
        if (typeof requireMfaForPasswordAccounts === 'boolean') {
            await configStore.setConfig('require_mfa_for_password_accounts', requireMfaForPasswordAccounts);
        }
        if (Array.isArray(consumerLoginMethods)) {
            const valid = consumerLoginMethods.filter(m => ['password', 'google', 'microsoft'].includes(m));
            await configStore.setConfig('consumer_login_methods', valid);
        }
        // ── Connector-only + geo-blocking ──
        if (typeof connectorOnly === 'boolean') {
            await configStore.setConfig('signup_connector_only', connectorOnly);
        }
        if (typeof geoMode === 'string' && ['off', 'allowlist', 'blocklist'].includes(geoMode)) {
            await configStore.setConfig('signup_geo_mode', geoMode);
        }
        if (Array.isArray(geoCountries)) {
            const valid = [...new Set(geoCountries
                .filter(c => typeof c === 'string')
                .map(c => c.trim().toUpperCase())
                .filter(c => /^[A-Z]{2}$/.test(c)))];
            await configStore.setConfig('signup_geo_countries', valid);
        }
        if (typeof geoBlockUnknown === 'boolean') {
            await configStore.setConfig('signup_geo_block_unknown', geoBlockUnknown);
        }
        if (typeof geoApplyConnector === 'boolean') {
            await configStore.setConfig('signup_geo_apply_connector', geoApplyConnector);
        }

        // Audit the change (best-effort; logAccessAudit never throws).
        const newValues = await snapshot();
        await userStore.logAccessAudit('signup.access_settings_updated', 'signup_settings', 'global', req.session?.user?.id, oldValues, newValues, null);

        console.log(`[Auth] Signup settings updated — org: ${allowOrgSignups}, consumer: ${allowConsumerSignups}, waitlist: ${waitlistEnabled}, connectorOnly: ${connectorOnly}, geoMode: ${geoMode}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[Auth] Failed to save signup settings:', err.message);
        res.status(500).json({ error: 'Failed to save signup settings' });
    }
});

// ── Waitlist Management ──────────────────────────────────────
router.get('/admin/waitlist', requireAdmin, async (req, res) => {
    try {
        const allUsers = await userStore.getAllUsers();
        const waitlisted = allUsers
            .filter(u => u.status === 'waitlist')
            .map(u => ({
                id: u.id,
                username: u.username,
                displayName: u.displayName,
                email: u.email,
                organizationId: u.organizationId,
                createdAt: u.createdAt,
            }));
        res.json(waitlisted);
    } catch (err) {
        console.error('[Auth] Failed to fetch waitlist:', err.message);
        res.status(500).json({ error: 'Failed to load waitlist' });
    }
});

router.post('/admin/waitlist/:userId/approve', requireAdmin, async (req, res) => {
    try {
        const user = await userStore.getUser(req.params.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.status !== 'waitlist') return res.status(400).json({ error: 'User is not on the waitlist' });

        await userStore.updateUser(user.id, { status: 'active' });
        console.log(`[Auth] Waitlist approved: ${user.id} (${user.email || 'no email'})`);

        // Send approval email if user has an email
        if (user.email) {
            try {
                const { sendWaitlistApprovedEmail } = require('../utils/emailService');
                await sendWaitlistApprovedEmail({ email: user.email, displayName: user.displayName || user.username });
            } catch (emailErr) {
                console.error('[Auth] Failed to send approval email:', emailErr.message);
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[Auth] Waitlist approve error:', err.message);
        res.status(500).json({ error: 'Failed to approve user' });
    }
});

router.post('/admin/waitlist/:userId/reject', requireAdmin, async (req, res) => {
    try {
        const user = await userStore.getUser(req.params.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.status !== 'waitlist') return res.status(400).json({ error: 'User is not on the waitlist' });

        await userStore.deleteUser(user.id);
        console.log(`[Auth] Waitlist rejected & deleted: ${user.id}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[Auth] Waitlist reject error:', err.message);
        res.status(500).json({ error: 'Failed to reject user' });
    }
});

// Public signup — create user + optionally a new organization
router.post('/signup', async (req, res) => {
    if (process.env.ALLOW_SIGNUPS === 'false') {
        return res.status(403).json({ error: 'Account creation is disabled on this server.' });
    }
    const { username, password, displayName, firstName, lastName, email, organizationId, newOrgName, orgDetails, inviteToken } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }
    if (password.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }
    if (username === 'admin') {
        return res.status(400).json({ error: 'This username is not available' });
    }

    // ── Handle invite token ──────────────────────────────────────
    let inviteData = null;
    if (inviteToken) {
        const invitationStore = require('../stores/invitationStore');
        inviteData = await invitationStore.getInvitationByToken(inviteToken);
        if (!inviteData) {
            return res.status(400).json({ error: 'Invalid or expired invitation. Please request a new one.' });
        }
    }

    // ── Connector-only + geo gating ──────────────────────────────
    // Invited users bypass (an invite is an explicit, trusted admin action —
    // consistent with how invites already skip the org/consumer/waitlist gates).
    if (!inviteData) {
        const gate = await checkWebSignupAllowed(req);
        if (!gate.ok) return res.status(gate.status).json({ error: gate.error, code: gate.code });
    }

    // ── Legal consent gate (clickwrap) ───────────────────────────
    // Re-derive the account type server-side and validate against the document
    // registry — never trust the client's claimed required-doc list. Invited
    // users still accept (an invite is org-scoped). Only the NC connector JIT
    // path is exempt, and it does not go through this route.
    const consentAccountType = newOrgName ? 'org_admin'
        : (organizationId || inviteData) ? 'org_member'
            : 'consumer';
    {
        const v = consentGuards.validateConsent(req.body.consent, consentAccountType);
        if (!v.ok) return res.status(v.status).json({ error: v.error, code: v.code, missing: v.missing });
    }

    let groups = [];
    let orgId = inviteData ? inviteData.organization_id : organizationId;

    if (newOrgName) {
        // ── Granular check: org signups ──
        const orgSignupsEnabled = (await configStore.getConfig('signup_org_enabled')) ?? true;
        if (!orgSignupsEnabled && !inviteData) {
            return res.status(403).json({ error: 'Organization registration is currently disabled.' });
        }

        // --- Create a new organization with full details ---
        orgId = newOrgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const od = orgDetails || {};
        const orgEmail = od.email || email || '';

        // Check if an organization with the same email domain already exists
        // Skip for common public email providers (gmail, outlook, etc.)
        const PUBLIC_DOMAINS = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'live.com', 'icloud.com', 'protonmail.com', 'proton.me'];
        if (orgEmail && orgEmail.includes('@')) {
            const domain = orgEmail.split('@')[1].toLowerCase();
            if (!PUBLIC_DOMAINS.includes(domain)) {
                const existingOrgs = await userStore.getAllOrganizations();
                const domainTaken = existingOrgs.find(o => {
                    // Check allowedDomains array
                    if (Array.isArray(o.allowedDomains) && o.allowedDomains.includes(domain)) return true;
                    // Check org email domain
                    if (!o.email || !o.email.includes('@')) return false;
                    return o.email.split('@')[1].toLowerCase() === domain;
                });
                if (domainTaken) {
                    return res.status(400).json({ error: `An organization with the domain "${domain}" already exists. Please join the existing organization instead.` });
                }
            }
        }

        const newOrg = {
            id: orgId, name: newOrgName,
            description: od.description || '', tagline: od.tagline || '',
            address: od.address || '', email: orgEmail,
            phone: od.phone || '', website: od.website || '',
            kvk: od.kvk || '', vat: od.vat || '',
            logo: '', footerText: '',
            defaultGroups: [], allowSignup: !!od.allowSignup,
            authMethod: od.authMethod || ''
        };
        const createOrgResult = await userStore.createOrganization(newOrg);
        if (!createOrgResult) {
            return res.status(400).json({ error: 'An organization with this name already exists' });
        }

        // Assign default subscription plan if one exists
        const allPlans = await userStore.getAllPlans();
        const defaultPlan = allPlans.find(p => p.is_default);
        if (defaultPlan) {
            await userStore.setOrgSubscription(orgId, { plan_id: defaultPlan.id, status: 'active' });
            console.log(`[Signup] Assigned default plan '${defaultPlan.name}' to org ${orgId}`);
        }

        // Configure the org Privacy Shield from the wizard's PII-detection
        // choices. Writes the real piiDetection* fields the runtime consumes
        // (identical to Settings → Privacy Shield); null = shield off.
        const { buildSignupShieldConfig } = require('../core/signupShield');
        const shieldConfig = buildSignupShieldConfig(od);
        if (shieldConfig) {
            await configStore.setConfig(`org_privacy_shield_${orgId}`, shieldConfig);
            console.log(`[Signup] Privacy shield for org ${orgId}: ${shieldConfig.piiDetectionCategories.length} PII categories, action=${shieldConfig.piiDetectionAction}`);
        }

        // User gets org_admin role — no default group is created
    } else if (orgId) {
        // --- Join existing organization (direct or via invitation) ---
        const orgs = await userStore.getAllOrganizations();
        const org = orgs.find(o => o.id === orgId);
        if (!org) {
            return res.status(400).json({ error: 'Organization not found' });
        }
        if (org.allowSignup || inviteData) {
            groups = org.defaultGroups || [];
        }
        // Invited users are auto-approved; self-signup depends on org allowSignup
        var userStatus = (inviteData || org.allowSignup) ? 'active' : 'pending';
    } else if ((process.env.DEPLOYMENT_MODE || 'cloud') === 'cloud') {
        // ── Granular check: consumer signups ──
        const consumerSignupsEnabled = (await configStore.getConfig('signup_consumer_enabled')) ?? false;
        if (!consumerSignupsEnabled) {
            return res.status(403).json({ error: 'Consumer account registration is currently disabled.' });
        }
        // Consumer account — no organization required in cloud mode
        orgId = null;
        groups = [];
        var userStatus = 'active';
        console.log(`[Signup] Consumer account (no org) for user '${username}'`);
    } else {
        return res.status(400).json({ error: 'Organization is required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    let resolvedStatus = typeof userStatus !== 'undefined' ? userStatus : 'active';

    // ── Waitlist override ──
    // Invited users and new-org founders bypass the waitlist: an invite is its
    // own approval, and the founder of a new organisation IS its admin/owner,
    // so there's no one else to approve them. The waitlist still gates consumer
    // signups and people self-joining an existing org.
    if (resolvedStatus === 'active' && !inviteData && !newOrgName) {
        const waitlistOn = (await configStore.getConfig('signup_waitlist_enabled')) ?? false;
        if (waitlistOn) {
            resolvedStatus = 'waitlist';
            console.log(`[Signup] Waitlist mode — user '${username}' placed on waitlist`);
        }
    }

    // ── Email verification gate ──
    // When enabled (and service email is configured), a fresh local password
    // signup with an email is created 'unverified' and must confirm via a link
    // before it can log in. Fail-open: if the toggle is off, there's no email,
    // it's an invited user (already trusted), or service email isn't set up,
    // skip verification so no one is ever locked out. Only layered on accounts
    // that would otherwise go straight to 'active' (waitlist/pending already gate).
    let needsVerification = false;
    if (resolvedStatus === 'active' && email && !inviteData) {
        const verifyOn = (await configStore.getConfig('signup_email_verification_enabled')) ?? false;
        if (verifyOn) {
            try {
                const { getServiceEmailConfig } = require('../utils/emailService');
                const svc = await getServiceEmailConfig();
                if (svc.configured) {
                    needsVerification = true;
                    resolvedStatus = 'unverified';
                } else {
                    console.warn('[Signup] email verification enabled but service email not configured — skipping (fail-open)');
                }
            } catch (e) {
                console.warn('[Signup] verification gate check failed — skipping (fail-open):', e.message);
            }
        }
    }

    const newUser = {
        id: username, username,
        displayName: displayName || username,
        firstName: firstName || null,
        lastName: lastName || null,
        email: email || null,
        phone: null, avatar: null, avatarType: null,
        passwordHash, role: 'user', groups,
        organizationId: orgId || null,
        orgRole: newOrgName ? 'org_admin' : (inviteData?.role || ''),
        status: resolvedStatus
    };

    let createUserResult;
    try {
        const r = await userStore.createUserWithSeatCheck(newUser, { strict: true });
        createUserResult = r.created;
        if (!createUserResult) {
            if (r.reason === 'duplicate_id') return res.status(400).json({ error: 'Username already taken' });
            return res.status(400).json({ error: r.error || 'Failed to create user' });
        }
    } catch (e) {
        if (e instanceof userStore.SeatCapExceededError) {
            return res.status(403).json({ error: 'seat_cap_exceeded', current: e.current, max: e.max });
        }
        throw e;
    }

    // ── Record legal consent (append-only ledger) ────────────────
    // The gate above already enforced acceptance; record one ledger row per
    // required document now that the user row exists. Done before the auto-login
    // session save so the evidence persists even if the session save later fails.
    try {
        await consentGuards.recordConsent({
            userId: newUser.id,
            email: newUser.email,
            accountType: consentAccountType,
            req,
            method: inviteToken ? 'invite' : 'clickwrap',
            organizationId: orgId || null,
        });
    } catch (e) { console.error('[Signup] consent record failed:', e.message); }

    // ── Persist preferred locale + (optionally) issue verification token ──
    // preferred_locale drives the language of this user's transactional emails
    // (verification, welcome, and later password reset).
    const preferredLocale = await resolveSignupLocale(req);
    try { await userStore.updateUser(newUser.id, { preferredLocale }); }
    catch (e) { console.warn('[Signup] failed to persist preferred locale:', e.message); }

    if (needsVerification) {
        try {
            const token = crypto.randomBytes(32).toString('hex');
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
            await userStore.updateUser(newUser.id, {
                emailVerificationTokenHash: tokenHash,
                emailVerificationExpiresAt: expires,
            });
            const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
            const verifyUrl = `${clientHost}/auth/verify-email/${token}`;
            const orgName = orgId ? (await userStore.getOrganization(orgId))?.name : '';
            const { sendVerificationEmail } = require('../utils/emailService');
            sendVerificationEmail({ email, displayName: newUser.displayName, verifyUrl, orgName, locale: preferredLocale })
                .catch(e => console.warn('[Signup] verification email failed:', e.message));
            try {
                await userStore.logAccessAudit('user.email_verification_sent', 'user', newUser.id, newUser.id, null, { email }, orgId || null);
            } catch (_) { /* best-effort */ }
        } catch (e) {
            console.error('[Signup] failed to issue verification token:', e.message);
        }
    }

    // ── Auto-grant consumer trial (fire-and-forget) ─────────────
    // Only fires for genuine consumer signups (no org). Org admins picked
    // their own trial via the org-trial config; that's triggered inside
    // userStore.createOrganization. trialService swallows errors so signup
    // is never blocked by Stripe issues.
    if (!orgId && !newOrgName) {
        setImmediate(() => {
            require('../services/trialService').maybeAutoGrantConsumerTrial(newUser.id);
        });
    }

    // ── Mark invitation as accepted ──────────────────────────
    if (inviteData) {
        try {
            const invitationStore = require('../stores/invitationStore');
            await invitationStore.markAccepted(inviteToken);
            console.log(`[Signup] Invitation accepted for ${email} → org ${orgId}`);
            // Audit the redemption: the new user, the issuer, the granted
            // role/groups. Failures here mustn't block signup.
            try {
                await userStore.logAccessAudit(
                    'invitation.redeem',
                    'user',
                    newUser.id,
                    newUser.id,
                    null,
                    {
                        invitation_id: inviteData.id,
                        email: inviteData.email,
                        invited_by: inviteData.invited_by,
                        orgRole: inviteData.org_role || inviteData.orgRole,
                        groups: inviteData.groups,
                    },
                    inviteData.organization_id || orgId || null,
                );
            } catch (auditErr) {
                console.warn('[Signup] invitation.redeem audit failed:', auditErr.message);
            }
        } catch (e) {
            console.error('[Signup] Failed to mark invitation as accepted:', e.message);
        }
    }

    // ── Email verification required — do NOT log in, do NOT create a DEK ──
    // The account exists as 'unverified'. The DEK is derived on the first real
    // login after the user confirms via the emailed link. The SPA shows a
    // "check your inbox" state and offers POST /auth/resend-verification.
    if (needsVerification) {
        return res.json({ success: true, emailVerificationRequired: true });
    }

    // If user is pending approval or waitlisted, notify but don't fully log in
    if (resolvedStatus === 'pending' || resolvedStatus === 'waitlist') {
        req.session.isAuthenticated = true;
        req.session.isAdmin = false;
        req.session.pendingApproval = true;
        req.session.user = {
            id: newUser.id, displayName: newUser.displayName,
            role: 'user', isAdmin: false, avatar: null, avatarType: null,
            organizationId: orgId || '', orgRole: ''
        };
        req.session.save((err) => {
            if (err) console.error('Session save error:', err);
            res.json({ success: true, pendingApproval: true, user: req.session.user });
        });
        return;
    }

    // ── Welcome email (once) for accounts that are active on creation ──
    // (Verified signups get their welcome at verify time instead.) Guarded by
    // claimNotification so refreshes/retries never double-send.
    if (email) {
        const welcomeLocale = preferredLocale;
        Promise.resolve().then(async () => {
            try {
                const claimed = await userStore.claimNotification('user', newUser.id, 'welcome_email', email);
                if (!claimed) return;
                const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
                const orgName = orgId ? (await userStore.getOrganization(orgId))?.name : '';
                const { sendWelcomeEmail } = require('../utils/emailService');
                await sendWelcomeEmail({ email, displayName: newUser.displayName, loginUrl: clientHost, orgName, locale: welcomeLocale });
            } catch (e) { console.warn('[Signup] welcome email failed:', e.message); }
        });
    }

    // Auto-login after signup
    req.session.isAuthenticated = true;
    req.session.isAdmin = false;
    req.session.user = {
        id: newUser.id, displayName: newUser.displayName,
        role: 'user', isAdmin: false, avatar: null, avatarType: null,
        organizationId: orgId || '', orgRole: newOrgName ? 'org_admin' : ''
    };

    try {
        const result = await getOrCreateUserDEKCompat(newUser.id, password);
        req.session.encryptionKey = result?.encryptionKey || null;

        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ error: 'Failed to save session' });
            }
            const response = { success: true, user: req.session.user };
            if (result?.recoveryKey) {
                response.recoveryKey = result.recoveryKey;
            }
            res.json(response);
        });
    } catch (err) {
        console.error('[Auth] Signup DEK creation failed:', err.message);
        return res.status(500).json({ error: 'Encryption initialization failed' });
    }
});

// ═══════════════════════════════════════════════════════════
// ── Invitation Token Validation (public route) ────────────
// ═══════════════════════════════════════════════════════════
router.get('/invite/:token', async (req, res) => {
    try {
        const invitationStore = require('../stores/invitationStore');
        const invitation = await invitationStore.getInvitationByToken(req.params.token);
        if (!invitation) {
            return res.status(410).json({ valid: false, error: 'Invitation expired or invalid' });
        }
        const org = await userStore.getOrganization(invitation.organization_id);
        res.json({
            valid: true,
            email: invitation.email,
            organizationId: invitation.organization_id,
            orgName: org?.name || '',
            orgLogo: org?.logo || null,
            role: invitation.role,
        });
    } catch (err) {
        console.error('[Invite] Token validation error:', err);
        res.status(500).json({ valid: false, error: 'Server error' });
    }
});

// Invitation landing handler. The email link is `/auth/redeem-invite/<token>`
// (path-style — the token is on the URL path, not in a query string). This
// endpoint validates the token, stashes it in the session, and 302-redirects
// to the SPA login route WITHOUT the token in the URL. That keeps the token
// out of the browser address bar, the Referer header, and reverse-proxy
// access logs after the redirect fires.
router.get('/redeem-invite/:token', async (req, res) => {
    const token = req.params.token;
    const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
    try {
        const invitationStore = require('../stores/invitationStore');
        const invitation = await invitationStore.getInvitationByToken(token);
        if (!invitation) {
            return res.redirect(`${clientHost}/login?error=invite_expired`);
        }
        // Persist on the session — the SPA picks it up via GET /auth/pending-invite.
        req.session.pendingInviteToken = token;
        req.session.save(() => res.redirect(`${clientHost}/login?signup=1`));
    } catch (err) {
        console.error('[Invite] Redeem error:', err);
        res.redirect(`${clientHost}/login?error=invite_error`);
    }
});

// Read the invite token previously stashed by /redeem-invite. Returns the
// resolved invitation payload (same shape as /invite/:token) plus the
// underlying token so the signup flow can submit it. Token is one-shot:
// reading clears the session entry so a refresh after signup doesn't
// re-apply it.
router.get('/pending-invite', async (req, res) => {
    try {
        const token = req.session?.pendingInviteToken;
        if (!token) return res.json({ valid: false });
        const invitationStore = require('../stores/invitationStore');
        const invitation = await invitationStore.getInvitationByToken(token);
        if (!invitation) {
            delete req.session.pendingInviteToken;
            return res.json({ valid: false, error: 'Invitation expired or invalid' });
        }
        const org = await userStore.getOrganization(invitation.organization_id);
        res.json({
            valid: true,
            token,
            email: invitation.email,
            organizationId: invitation.organization_id,
            orgName: org?.name || '',
            orgLogo: org?.logo || null,
            role: invitation.role,
        });
    } catch (err) {
        console.error('[Invite] pending-invite error:', err);
        res.status(500).json({ valid: false, error: 'Server error' });
    }
});

router.post('/pending-invite/clear', async (req, res) => {
    if (req.session?.pendingInviteToken) delete req.session.pendingInviteToken;
    req.session.save(() => res.json({ ok: true }));
});

module.exports = router;
