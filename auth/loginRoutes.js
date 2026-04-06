/**
 * Login, Session & Setup Routes
 * 
 * Handles: /my-permissions, /setup-status, /setup, /admin-login,
 * /demo-login, /settings, /user, /logout
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();

const userStore = require('../stores/userStore');
const { loadConfig, saveConfig, requireAuth, requireAdmin, getUserPermissions } = require('./permissions');
const { getOrCreateUserDEKCompat, getFallbackEncryptionKey, setupSSOUserDEK, unlockSSOUserDEK, unlockWithRecoveryKey, secureClear } = require('./encryption');

/**
 * Check if encryption is enabled for a user based on their org's subscription plan.
 * Encryption is a paid feature — disabled by default unless plan explicitly includes it.
 */
async function isEncryptionEnabledForUser(userId) {
    try {
        const user = await userStore.getUser(userId);
        if (!user) return false; // new user, no plan yet
        if (user.role === 'admin') return true; // admins always get encryption
        const orgId = user.organizationId;
        if (!orgId) return false; // no org = no encryption
        const limits = await userStore.getEffectiveLimits(orgId);
        if (!limits) return false; // no subscription = no encryption
        const features = limits.allowed_features;
        if (!features || features.length === 0) return true; // empty = all features
        return features.includes('encryption');
    } catch (e) {
        return false; // fail-safe: paid feature, default off
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

    // Resolve beta features for this user
    let betaFeatures = [];
    try {
        const { getUserBetaFeatures } = require('../core/betaFeatures');
        betaFeatures = await getUserBetaFeatures(userId, req.session);
    } catch (_) { }

    res.json({ permissions: perms, groups: userGroups, organizations: userOrgIds, allowedAgentTypes, betaFeatures, orgRole: user?.orgRole || '' });
});

// Check if setup is complete (admin password set)
router.get('/setup-status', async (req, res) => {
    const config = await loadConfig();
    const isSetupComplete = !!config.admin.passwordHash;
    const isOAuthConfigured = !!(config.oauth.clientId && config.oauth.clientSecret);
    const isGoogleConfigured = !!(config.providers?.google?.clientId && config.providers?.google?.clientSecret);
    const isMicrosoftConfigured = !!(config.providers?.microsoft?.clientId && config.providers?.microsoft?.clientSecret);
    console.log('[Auth] setup-status — google providers config:', JSON.stringify(config.providers?.google ? { clientId: !!config.providers.google.clientId, clientSecret: !!config.providers.google.clientSecret } : 'none'));
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
    res.json({
        isSetupComplete,
        isOAuthConfigured,
        isGoogleConfigured,
        isMicrosoftConfigured,
        serverUrl,
        deploymentMode: process.env.DEPLOYMENT_MODE || 'cloud',
        allowSignups: process.env.ALLOW_SIGNUPS !== 'false',
        allowPasswordLogin: process.env.ALLOW_PASSWORD_LOGIN !== 'false',
        availableLocales,
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
        let storedUser = await userStore.getUser(username);
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

    // Set session
    req.session.isAuthenticated = true;
    req.session.isAdmin = isAdmin;
    req.session.user = {
        ...user,
        isAdmin
    };
    // Derive and store encryption key — only when encryption is enabled for user's plan
    const encryptionEnabled = await isEncryptionEnabledForUser(user.id);
    try {
        if (!encryptionEnabled) {
            // Encryption disabled for this user's plan — skip DEK
            req.session.save((err) => {
                if (err) console.error('Session save error:', err);
                res.json({ success: true, user: req.session.user });
            });
            return;
        }

        // Ensure admin user exists in users table (for DEK storage)
        if (user.id === 'admin') {
            const adminRow = await userStore.getUser('admin');
            if (!adminRow) {
                const config = await loadConfig();
                await userStore.createUser({
                    id: 'admin',
                    username: 'admin',
                    displayName: 'Administrator',
                    passwordHash: config.admin.passwordHash,
                    role: 'admin',
                    groups: []
                });
            }
        }

        const result = await getOrCreateUserDEKCompat(user.id, password);
        if (!result) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        req.session.encryptionKey = result.encryptionKey;
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ error: 'Failed to save session' });
            }
            // Include recovery key in response if DEK was just created or migrated
            const response = { success: true, user: req.session.user };
            if (result.recoveryKey) {
                response.recoveryKey = result.recoveryKey;
            }
            res.json(response);
        });
    } catch (err) {
        console.error('[Auth] DEK operation failed:', err.message);
        return res.status(500).json({ error: 'Encryption initialization failed' });
    }
});

// Demo login - instant access without credentials for demo purposes
router.post('/demo-login', async (req, res) => {
    const demoEnabled = process.env.DEMO_MODE_ENABLED !== 'false';

    if (!demoEnabled) {
        return res.status(403).json({
            error: 'Demo mode is disabled',
            demoDisabled: true
        });
    }

    req.session.isAuthenticated = true;
    req.session.isAdmin = true;
    req.session.isDemo = true;
    req.session.user = {
        id: 'demo-user',
        displayName: 'Demo User',
        isAdmin: true,
        isDemo: true
    };
    req.session.encryptionKey = getFallbackEncryptionKey('demo-user');

    req.session.save((err) => {
        if (err) {
            console.error('Session save error:', err);
            return res.status(500).json({ error: 'Failed to save session' });
        }
        res.json({ success: true, user: req.session.user });
    });
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
                isDemo: req.session.isDemo || false,
                role: freshUser?.role || req.session.user.role || 'user',
                avatar: freshUser?.avatar || req.session.user.avatar || req.session.user.picture || null,
                avatarType: freshUser?.avatarType || req.session.user.avatarType || (req.session.user.picture ? 'url' : null),
                provider: req.session.user.provider || req.session.oauthProvider || 'local',
                organizationId: freshUser?.organizationId || '',
                orgRole: freshUser?.orgRole || ''
            },
            isOAuthConfigured: !!(config.oauth.clientId && config.oauth.clientSecret),
            // Encryption status for SSO users
            needsEncryptionSetup: req.session.needsEncryptionSetup || false,
            needsEncryptionPin: req.session.needsEncryptionPin || false,
            encryptionEnabled: await isEncryptionEnabledForUser(req.session.user.id),
            // Organisation membership for SSO users
            noOrganization: req.session.noOrganization || false,
            isConsumerAccount: !freshUser?.organizationId && !req.session.noOrganization && process.env.DEPLOYMENT_MODE === 'cloud',
            pendingApproval: req.session.pendingApproval || false,
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
    const { newOrgName, orgDetails } = req.body;
    if (!newOrgName) {
        return res.status(400).json({ error: 'Organization name is required' });
    }
    req.session.pendingSignup = { newOrgName, orgDetails: orgDetails || {} };
    req.session.save((err) => {
        if (err) {
            console.error('[PendingSignup] Session save error:', err);
            return res.status(500).json({ error: 'Failed to save pending signup' });
        }
        console.log(`[PendingSignup] Stored org "${newOrgName}" in session ${req.sessionID}`);
        res.json({ ok: true });
    });
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

    let groups = [];
    let orgId = inviteData ? inviteData.organization_id : organizationId;

    if (newOrgName) {
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

        // Configure privacy shield based on selected level
        const privacyLevel = od.privacyLevel || 'off';
        if (privacyLevel !== 'off') {
            const configStore = require('../stores/configStore');
            const BASIC_CATEGORIES = ['violence_and_threats', 'hate_and_discrimination', 'dangerous_and_criminal_content', 'selfharm', 'sexual', 'health', 'financial', 'law'];
            const STRICT_CATEGORIES = [...BASIC_CATEGORIES, 'pii'];
            const selectedCategories = privacyLevel === 'strict' ? STRICT_CATEGORIES : BASIC_CATEGORIES;

            // For strict mode, auto-include PII-related regex collections
            let autoCollectionIds = [];
            if (privacyLevel === 'strict') {
                try {
                    const { getAIConfig } = require('../core/aiAgent');
                    const aiCfg = await getAIConfig();
                    const collections = aiCfg.regexGuardrails?.collections || [];
                    autoCollectionIds = collections
                        .filter(c => c.name && c.name.toLowerCase().includes('pii'))
                        .map(c => c.id);
                } catch (e) { /* ignore */ }
            }

            const shieldConfig = {
                enabled: true,
                collectionIds: autoCollectionIds,
                scope: { userInput: true, agentOutput: true },
                action: 'delete',
                moderationEnabled: true,
                moderationCategories: selectedCategories,
                euModeEnabled: !!od.euModeEnabled,
                updatedAt: new Date().toISOString(),
                updatedBy: 'system-signup',
            };
            await configStore.setConfig(`org_privacy_shield_${orgId}`, shieldConfig);
            console.log(`[Signup] Privacy shield set to '${privacyLevel}' for org ${orgId}`);
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
    } else if (process.env.DEPLOYMENT_MODE === 'cloud') {
        // Consumer account — no organization required in cloud mode
        orgId = null;
        groups = [];
        var userStatus = 'active';
        console.log(`[Signup] Consumer account (no org) for user '${username}'`);
    } else {
        return res.status(400).json({ error: 'Organization is required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const resolvedStatus = typeof userStatus !== 'undefined' ? userStatus : 'active';
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

    const createUserResult = await userStore.createUser(newUser);
    if (!createUserResult) {
        return res.status(400).json({ error: 'Username already taken' });
    }

    // ── Mark invitation as accepted ──────────────────────────
    if (inviteData) {
        try {
            const invitationStore = require('../stores/invitationStore');
            await invitationStore.markAccepted(inviteToken);
            console.log(`[Signup] Invitation accepted for ${email} → org ${orgId}`);
        } catch (e) {
            console.error('[Signup] Failed to mark invitation as accepted:', e.message);
        }
    }

    // If user is pending approval, notify but don't fully log in
    if (resolvedStatus === 'pending') {
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

module.exports = router;
