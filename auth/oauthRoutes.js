/**
 * OAuth Routes — Multi-Provider OAuth 2.0
 * 
 * Handles: /login (legacy NC), /callback (legacy NC),
 * /login/:provider, /callback/:provider,
 * /oauth-config, /providers, /providers/:provider, /providers/:provider/test
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { loadConfig, saveConfig, requireAdmin, OAUTH_PROVIDERS } = require('./permissions');
const { getOrCreateSSOUserDEKCompat, setupSSOUserDEK, unlockSSOUserDEK } = require('./encryption');
const userStore = require('../stores/userStore');

/**
 * Check if encryption is enabled for a user based on their org's subscription plan.
 * Admin users always have encryption enabled.
 * Encryption is a paid feature — disabled by default unless plan explicitly includes it.
 */
async function isEncryptionEnabledForUser(userId) {
    try {
        const user = await userStore.getUser(userId);
        if (!user) return false; // new user, no plan yet
        if (user.role === 'admin') return true; // admins always get encryption

        const orgId = user.organizationId;
        if (!orgId) return false; // no org = no plan = no encryption

        const limits = await userStore.getEffectiveLimits(orgId);
        if (!limits) return false; // no subscription = no encryption

        const features = limits.allowed_features;
        // Empty array = all features enabled (including encryption)
        if (!features || features.length === 0) return true;
        return features.includes('encryption');
    } catch (e) {
        console.error('[OAuth] Failed to check encryption feature:', e.message);
        return false; // fail-safe: encryption is paid, default off
    }
}

// Helper to get return URL from referer or environment
function getReturnUrl(req) {
    const referer = req.get('Referer');

    if (process.env.CLIENT_PUBLIC_HOST) {
        const clientProtocol = process.env.CLIENT_PROTOCOL || process.env.SERVER_PROTOCOL || 'https';
        return `${clientProtocol}://${process.env.CLIENT_PUBLIC_HOST}`;
    }

    if (referer) {
        try {
            const url = new URL(referer);
            return `${url.protocol}//${url.host}`;
        } catch (e) {
            console.warn('Invalid Referer header:', referer);
        }
    }

    return 'http://localhost:5173';
}

// Legacy Nextcloud login redirect
router.get('/login', async (req, res) => {
    const config = await loadConfig();
    const { nextcloudUrl, clientId } = config.oauth || {};

    const referer = req.get('Referer');
    let returnTo = 'http://localhost:5173';

    if (referer) {
        try {
            const url = new URL(referer);
            returnTo = `${url.protocol}//${url.host}`;
        } catch (e) {
            console.warn('Invalid Referer header:', referer);
        }
    }

    req.session.returnTo = returnTo;

    const host = req.get('host');
    const REDIRECT_URI = `${req.protocol}://${host}/auth/callback`;

    if (!nextcloudUrl || !clientId) {
        return res.redirect(`${returnTo}?error=oauth_not_configured`);
    }

    const authUrl = `${nextcloudUrl}/apps/oauth2/authorize?` + new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        state: Math.random().toString(36).substring(7)
    }).toString();

    res.redirect(authUrl);
});

// Legacy Nextcloud callback
router.get('/callback', async (req, res) => {
    const { code, error } = req.query;
    const config = await loadConfig();
    const { nextcloudUrl, clientId, clientSecret } = config.oauth || {};

    const returnTo = req.session.returnTo || 'http://localhost:5173';
    delete req.session.returnTo;

    const host = req.get('host');
    const REDIRECT_URI = `${req.protocol}://${host}/auth/callback`;

    if (error) {
        console.error('OAuth error:', error);
        return res.redirect(`${returnTo}?error=` + encodeURIComponent(error));
    }

    if (!code) {
        return res.redirect(`${returnTo}?error=no_code`);
    }

    try {
        const tokenResponse = await fetch(`${nextcloudUrl}/apps/oauth2/api/v1/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
                client_id: clientId,
                client_secret: clientSecret
            }).toString()
        });

        if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            console.error('Token exchange failed:', errorText);
            return res.redirect(`${returnTo}?error=token_exchange_failed`);
        }

        const tokenData = await tokenResponse.json();

        const userResponse = await fetch(`${nextcloudUrl}/ocs/v2.php/cloud/user?format=json`, {
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'OCS-APIRequest': 'true'
            }
        });

        let user = null;
        if (userResponse.ok) {
            const userData = await userResponse.json();
            user = userData.ocs?.data || null;
        }

        req.session.accessToken = tokenData.access_token;
        req.session.refreshToken = tokenData.refresh_token;
        req.session.user = user;
        req.session.isAuthenticated = true;
        req.session.isAdmin = false;
        // Handle SSO encryption with backward compatibility
        const encryptionEnabled = await isEncryptionEnabledForUser(user?.id || 'oauth-user');
        const ssoResult = await getOrCreateSSOUserDEKCompat(user?.id || 'oauth-user', encryptionEnabled);
        if (ssoResult.encryptionKey) {
            req.session.encryptionKey = ssoResult.encryptionKey;
        }
        if (ssoResult.needsEncryptionSetup) {
            req.session.needsEncryptionSetup = true;
        }
        if (ssoResult.needsEncryptionPin) {
            req.session.needsEncryptionPin = true;
        }

        req.session.save((err) => {
            if (err) console.error('Session save error:', err);
            res.redirect(returnTo);
        });

    } catch (err) {
        console.error('OAuth callback error:', err);
        res.redirect(`${returnTo}?error=` + encodeURIComponent(err.message));
    }
});

// === Multi-Provider OAuth Routes ===

// Provider-specific login - redirects to OAuth provider
router.get('/login/:provider', async (req, res) => {
    const { provider } = req.params;
    const config = await loadConfig();

    const returnTo = getReturnUrl(req);
    req.session.returnTo = returnTo;
    req.session.oauthProvider = provider;

    console.log(`[OAuth] Login SessionID: ${req.sessionID}`);

    let host = process.env.SERVER_PUBLIC_HOST;
    let protocol = process.env.SERVER_PROTOCOL || 'https';

    if (!host) {
        const forwardedHost = req.get('X-Forwarded-Host');
        const referer = req.get('Referer');

        if (forwardedHost) {
            host = forwardedHost;
            console.log(`[OAuth] Using X-Forwarded-Host: ${host}`);
        } else if (referer) {
            try {
                const refererUrl = new URL(referer);
                host = refererUrl.host;
                protocol = refererUrl.protocol.replace(':', '');
                console.log(`[OAuth] Using Referer origin: ${protocol}://${host}`);
            } catch (e) {
                console.warn('[OAuth] Invalid Referer, using host header');
                host = req.get('host');
                protocol = req.protocol;
            }
        } else {
            host = req.get('host');
            protocol = req.protocol;
        }
    } else {
        console.log(`[OAuth] Using SERVER_PUBLIC_HOST: ${protocol}://${host}`);
    }

    const REDIRECT_URI = `${protocol}://${host}/auth/callback/${provider}`;

    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;

    if (provider === 'google') {
        const providerConfig = config.providers?.google || {};
        if (!providerConfig.clientId) {
            return res.redirect(`${returnTo}?error=google_not_configured`);
        }

        const authUrl = OAUTH_PROVIDERS.google.authUrl + '?' + new URLSearchParams({
            response_type: 'code',
            client_id: providerConfig.clientId,
            redirect_uri: REDIRECT_URI,
            scope: OAUTH_PROVIDERS.google.scopes.join(' '),
            state: state,
            access_type: 'offline',
            prompt: 'consent'
        }).toString();

        req.session.save(() => res.redirect(authUrl));

    } else if (provider === 'microsoft') {
        const providerConfig = config.providers?.microsoft || {};
        console.log(`[OAuth/Microsoft] === LOGIN START ===`);
        console.log(`[OAuth/Microsoft] clientId present: ${!!providerConfig.clientId}, clientSecret present: ${!!providerConfig.clientSecret}`);
        console.log(`[OAuth/Microsoft] tenantId: ${providerConfig.tenantId || 'common (default)'}`);
        console.log(`[OAuth/Microsoft] REDIRECT_URI: ${REDIRECT_URI}`);
        console.log(`[OAuth/Microsoft] returnTo: ${returnTo}`);
        console.log(`[OAuth/Microsoft] SessionID: ${req.sessionID}`);
        if (!providerConfig.clientId) {
            console.error(`[OAuth/Microsoft] ABORT: No clientId configured`);
            return res.redirect(`${returnTo}?error=microsoft_not_configured`);
        }

        const tenantId = providerConfig.tenantId || 'common';
        const scopes = OAUTH_PROVIDERS.microsoft.scopes.join(' ');
        console.log(`[OAuth/Microsoft] Scopes: ${scopes}`);
        const authUrl = OAUTH_PROVIDERS.microsoft.authUrl(tenantId) + '?' + new URLSearchParams({
            response_type: 'code',
            client_id: providerConfig.clientId,
            redirect_uri: REDIRECT_URI,
            scope: scopes,
            state: state,
            response_mode: 'query'
        }).toString();

        console.log(`[OAuth/Microsoft] Auth URL: ${authUrl}`);
        console.log(`[OAuth/Microsoft] State saved: ${state}`);
        req.session.save((err) => {
            if (err) console.error(`[OAuth/Microsoft] Session save error on login redirect:`, err);
            else console.log(`[OAuth/Microsoft] Session saved, redirecting to Microsoft...`);
            res.redirect(authUrl);
        });

    } else if (provider === 'nextcloud') {
        const { nextcloudUrl, clientId } = config.oauth || {};
        if (!nextcloudUrl || !clientId) {
            return res.redirect(`${returnTo}?error=nextcloud_not_configured`);
        }

        const authUrl = `${nextcloudUrl}/apps/oauth2/authorize?` + new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: REDIRECT_URI,
            state: state
        }).toString();

        console.log(`[OAuth] Nextcloud State Saved: ${state}`);
        req.session.save(() => res.redirect(authUrl));
    } else {
        res.redirect(`${returnTo}?error=unknown_provider`);
    }
});

// Provider-specific callback
router.get('/callback/:provider', async (req, res) => {
    const { provider } = req.params;
    const { code, error, error_description, state } = req.query;
    const config = await loadConfig();

    console.log(`[OAuth/${provider}] === CALLBACK START ===`);
    console.log(`[OAuth/${provider}] SessionID: ${req.sessionID}`);
    console.log(`[OAuth/${provider}] Query params — code present: ${!!code}, error: ${error || 'none'}, state present: ${!!state}`);
    if (error_description) console.log(`[OAuth/${provider}] Error description: ${error_description}`);
    console.log(`[OAuth/${provider}] Session returnTo: ${req.session.returnTo || '(not set)'}`);
    console.log(`[OAuth/${provider}] Session oauthState: ${req.session.oauthState || '(not set)'}`);
    console.log(`[OAuth/${provider}] Session oauthProvider: ${req.session.oauthProvider || '(not set)'}`);

    const returnTo = req.session.returnTo || 'http://localhost:5173';
    delete req.session.returnTo;

    if (error) {
        console.error(`[OAuth/${provider}] ERROR from provider: ${error} — ${error_description || 'no description'}`);
        return res.redirect(`${returnTo}?error=` + encodeURIComponent(error));
    }

    if (!code) {
        console.error(`[OAuth/${provider}] No authorization code received`);
        return res.redirect(`${returnTo}?error=no_code`);
    }

    console.log(`[OAuth/${provider}] Stored State: ${req.session.oauthState}, Received State: ${state}`);

    if (state !== req.session.oauthState) {
        console.error(`[OAuth/${provider}] STATE MISMATCH — stored: ${req.session.oauthState}, received: ${state}`);
        return res.redirect(`${returnTo}?error=invalid_state`);
    }
    delete req.session.oauthState;

    // Construct REDIRECT_URI the same way as the login handler
    let host = process.env.SERVER_PUBLIC_HOST;
    let protocol = process.env.SERVER_PROTOCOL || 'https';
    if (!host) {
        const forwardedHost = req.get('X-Forwarded-Host');
        if (forwardedHost) {
            host = forwardedHost;
        } else {
            host = req.get('host');
            protocol = req.protocol;
        }
    }
    const REDIRECT_URI = `${protocol}://${host}/auth/callback/${provider}`;

    try {
        let tokenData, user;

        if (provider === 'google') {
            const providerConfig = config.providers?.google || {};

            const tokenResponse = await fetch(OAUTH_PROVIDERS.google.tokenUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: REDIRECT_URI,
                    client_id: providerConfig.clientId,
                    client_secret: providerConfig.clientSecret
                }).toString()
            });

            if (!tokenResponse.ok) {
                const errorText = await tokenResponse.text();
                console.error('Google token exchange failed:', errorText);
                return res.redirect(`${returnTo}?error=token_exchange_failed`);
            }

            tokenData = await tokenResponse.json();

            const userResponse = await fetch(OAUTH_PROVIDERS.google.userInfoUrl, {
                headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
            });

            if (userResponse.ok) {
                const userData = await userResponse.json();
                user = {
                    id: userData.sub || userData.email,
                    displayName: userData.name || userData.email,
                    firstName: userData.given_name || '',
                    lastName: userData.family_name || '',
                    email: userData.email,
                    picture: userData.picture,
                    provider: 'google'
                };
            }

        } else if (provider === 'microsoft') {
            const providerConfig = config.providers?.microsoft || {};
            const tenantId = providerConfig.tenantId || 'common';
            const tokenUrl = OAUTH_PROVIDERS.microsoft.tokenUrl(tenantId);

            console.log(`[OAuth/Microsoft] === TOKEN EXCHANGE ===`);
            console.log(`[OAuth/Microsoft] Token URL: ${tokenUrl}`);
            console.log(`[OAuth/Microsoft] REDIRECT_URI: ${REDIRECT_URI}`);
            console.log(`[OAuth/Microsoft] clientId: ${providerConfig.clientId}`);
            console.log(`[OAuth/Microsoft] clientSecret present: ${!!providerConfig.clientSecret} (length: ${(providerConfig.clientSecret || '').length})`);
            console.log(`[OAuth/Microsoft] tenantId: ${tenantId}`);
            console.log(`[OAuth/Microsoft] code length: ${(code || '').length}`);

            const tokenResponse = await fetch(tokenUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: REDIRECT_URI,
                    client_id: providerConfig.clientId,
                    client_secret: providerConfig.clientSecret
                }).toString()
            });

            console.log(`[OAuth/Microsoft] Token response status: ${tokenResponse.status} ${tokenResponse.statusText}`);

            if (!tokenResponse.ok) {
                const errorText = await tokenResponse.text();
                console.error(`[OAuth/Microsoft] TOKEN EXCHANGE FAILED (${tokenResponse.status}):`, errorText);
                return res.redirect(`${returnTo}?error=token_exchange_failed`);
            }

            tokenData = await tokenResponse.json();
            console.log(`[OAuth/Microsoft] Token exchange successful — access_token present: ${!!tokenData.access_token}, refresh_token present: ${!!tokenData.refresh_token}`);
            if (tokenData.scope) console.log(`[OAuth/Microsoft] Granted scopes: ${tokenData.scope}`);
            if (tokenData.error) console.error(`[OAuth/Microsoft] Token response error: ${tokenData.error} — ${tokenData.error_description || ''}`);

            console.log(`[OAuth/Microsoft] === USER INFO FETCH ===`);
            console.log(`[OAuth/Microsoft] User info URL: ${OAUTH_PROVIDERS.microsoft.userInfoUrl}`);
            const userResponse = await fetch(OAUTH_PROVIDERS.microsoft.userInfoUrl, {
                headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
            });

            console.log(`[OAuth/Microsoft] User info response status: ${userResponse.status} ${userResponse.statusText}`);

            if (userResponse.ok) {
                const userData = await userResponse.json();
                console.log(`[OAuth/Microsoft] User info received — id: ${userData.id}, displayName: ${userData.displayName}, mail: ${userData.mail}, upn: ${userData.userPrincipalName}`);
                user = {
                    id: userData.id || userData.userPrincipalName,
                    displayName: userData.displayName || userData.userPrincipalName,
                    email: userData.mail || userData.userPrincipalName,
                    provider: 'microsoft'
                };
                console.log(`[OAuth/Microsoft] Mapped user — id: ${user.id}, displayName: ${user.displayName}, email: ${user.email}`);
            } else {
                const userErrorText = await userResponse.text();
                console.error(`[OAuth/Microsoft] USER INFO FETCH FAILED (${userResponse.status}):`, userErrorText);
            }
        } else if (provider === 'nextcloud') {
            const { nextcloudUrl, clientId, clientSecret } = config.oauth || {};

            const tokenResponse = await fetch(`${nextcloudUrl}/apps/oauth2/api/v1/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: REDIRECT_URI,
                    client_id: clientId,
                    client_secret: clientSecret
                }).toString()
            });

            if (!tokenResponse.ok) {
                const errorText = await tokenResponse.text();
                console.error('Nextcloud token exchange failed:', errorText);
                return res.redirect(`${returnTo}?error=token_exchange_failed`);
            }

            tokenData = await tokenResponse.json();

            const userResponse = await fetch(`${nextcloudUrl}/ocs/v2.php/cloud/user?format=json`, {
                headers: {
                    'Authorization': `Bearer ${tokenData.access_token}`,
                    'OCS-APIRequest': 'true'
                }
            });

            if (userResponse.ok) {
                const userData = await userResponse.json();
                const ocs = userData.ocs?.data || {};
                user = {
                    id: `nextcloud-${ocs.id || ocs['display-name']}`,
                    displayName: ocs['display-name'] || ocs.id,
                    email: ocs.email || '',
                    provider: 'nextcloud'
                };
            }
        } else {
            return res.redirect(`${returnTo}?error=unknown_provider`);
        }

        if (!user) {
            console.error(`[OAuth/${provider}] FAILED: Could not obtain user info from provider`);
            return res.redirect(`${returnTo}?error=failed_to_get_user_info`);
        }
        console.log(`[OAuth/${provider}] === USER PROVISIONING ===`);

        // Create or update user in the store with full profile data
        const existingUser = await userStore.getUser(user.id);
        if (!existingUser) {
            await userStore.createUser({
                id: user.id,
                username: user.email || user.id,
                displayName: user.displayName,
                firstName: user.firstName || '',
                lastName: user.lastName || '',
                email: user.email || '',
                avatar: user.picture || null,
                avatarType: user.picture ? 'url' : null,
                role: 'user',
                groups: [],
            });
            console.log(`[OAuth] Created new user in store: ${user.id} (${user.displayName})`);
        } else {
            // Update profile data on each login (name/email/picture may change)
            await userStore.updateUser(user.id, {
                displayName: user.displayName,
                firstName: user.firstName || existingUser.firstName,
                lastName: user.lastName || existingUser.lastName,
                email: user.email || existingUser.email,
                avatar: user.picture || existingUser.avatar,
                avatarType: user.picture ? 'url' : existingUser.avatarType,
            });
            console.log(`[OAuth] Updated user in store: ${user.id} (${user.displayName})`);
        }

        // Handle pending signup — create organization if stored in session
        if (req.session.pendingSignup) {
            const { newOrgName, orgDetails: od } = req.session.pendingSignup;
            delete req.session.pendingSignup;

            const orgId = newOrgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
            const orgEmail = od.email || user.email || '';

            // Check domain collision
            let domainTaken = false;
            if (orgEmail && orgEmail.includes('@')) {
                const domain = orgEmail.split('@')[1].toLowerCase();
                const existingOrgs = await userStore.getAllOrganizations();
                domainTaken = existingOrgs.find(o => {
                    if (!o.email || !o.email.includes('@')) return false;
                    return o.email.split('@')[1].toLowerCase() === domain;
                });
            }

            if (!domainTaken) {
                const newOrg = {
                    id: orgId, name: newOrgName,
                    description: od.description || '', tagline: od.tagline || '',
                    address: od.address || '', email: orgEmail,
                    phone: od.phone || '', website: od.website || '',
                    kvk: od.kvk || '', vat: od.vat || '',
                    logo: '', footerText: '',
                    defaultGroups: [], allowSignup: !!od.allowSignup,
                    authMethod: od.authMethod || provider
                };

                const createResult = await userStore.createOrganization(newOrg);
                if (createResult) {
                    console.log(`[OAuth] Created org "${newOrgName}" (${orgId}) via OAuth signup`);

                    // Assign default subscription plan if one exists
                    const allPlans = await userStore.getAllPlans();
                    const defaultPlan = allPlans.find(p => p.is_default);
                    if (defaultPlan) {
                        await userStore.setOrgSubscription(orgId, { plan_id: defaultPlan.id, status: 'active' });
                        console.log(`[OAuth] Assigned default plan '${defaultPlan.name}' to org ${orgId}`);
                    }

                    // Privacy shield
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

                        await configStore.setConfig(`org_privacy_shield_${orgId}`, {
                            enabled: true, collectionIds: autoCollectionIds,
                            scope: { userInput: true, agentOutput: true },
                            action: 'delete', moderationEnabled: true,
                            moderationCategories: selectedCategories,
                            euModeEnabled: !!od.euModeEnabled,
                            updatedAt: new Date().toISOString(), updatedBy: 'system-signup',
                        });
                        console.log(`[OAuth] Privacy shield set to '${privacyLevel}' for org ${orgId}`);
                    }

                    // Assign user as org_admin — no default group is created
                    await userStore.updateUser(user.id, { orgRole: 'org_admin', organizationId: orgId });
                    console.log(`[OAuth] Assigned ${user.id} as org_admin of ${orgId}`);
                } else {
                    console.warn(`[OAuth] Org "${newOrgName}" already exists, skipping creation`);
                }
            } else {
                console.warn(`[OAuth] Domain already taken, skipping org creation`);
            }
        }

        // Check if user belongs to any organisation
        const freshUser = await userStore.getUser(user.id);
        const userGroups = freshUser?.groups ? (typeof freshUser.groups === 'string' ? JSON.parse(freshUser.groups) : freshUser.groups) : [];
        let userHasOrg = false;
        if (userGroups.length > 0) {
            // Check if any group belongs to an org
            const allGroups = await userStore.getAllGroups();
            userHasOrg = userGroups.some(gId => {
                const g = allGroups.find(gr => gr.id === gId);
                return g && g.organization_id;
            });
        }
        // Also check if user has orgRole set directly
        if (freshUser?.orgRole) userHasOrg = true;

        // If user has no org, try domain-matching
        let pendingApproval = false;
        if (!userHasOrg && !req.session.pendingSignup && user.email && user.email.includes('@')) {
            const userDomain = user.email.split('@')[1].toLowerCase();
            const allOrgs = await userStore.getAllOrganizations();

            // Find org whose email domain matches the user's email domain
            const matchingOrg = allOrgs.find(org => {
                if (!org.email || !org.email.includes('@')) return false;
                return org.email.split('@')[1].toLowerCase() === userDomain;
            });

            if (matchingOrg) {
                if (matchingOrg.autoApproveSSO) {
                    // Auto-approve: add user to org with default groups
                    const defaultGroups = matchingOrg.defaultGroups || [];
                    const existingGroups = userGroups || [];
                    const mergedGroups = [...new Set([...existingGroups, ...defaultGroups])];

                    await userStore.updateUser(user.id, {
                        groups: mergedGroups,
                        organizationId: matchingOrg.id,
                        orgRole: 'user',
                        status: 'active'
                    });
                    userHasOrg = true;
                    console.log(`[OAuth] Auto-approved SSO user ${user.id} into org "${matchingOrg.name}" with ${defaultGroups.length} default groups`);
                } else {
                    // Add to org but mark as pending approval
                    await userStore.updateUser(user.id, {
                        organizationId: matchingOrg.id,
                        orgRole: '',
                        status: 'pending'
                    });
                    pendingApproval = true;
                    userHasOrg = true; // They belong to an org, but are pending
                    console.log(`[OAuth] SSO user ${user.id} added to org "${matchingOrg.name}" as PENDING (awaiting admin approval)`);
                }
            }
        }

        // Check if existing user is pending
        if (freshUser?.status === 'pending') {
            pendingApproval = true;
        }

        console.log(`[OAuth/${provider}] === SESSION SETUP ===`);
        console.log(`[OAuth/${provider}] User: ${user.id} (${user.displayName}), pendingApproval: ${pendingApproval}, userHasOrg: ${userHasOrg}`);
        req.session.accessToken = tokenData.access_token;
        req.session.refreshToken = tokenData.refresh_token;
        req.session.user = user;
        req.session.isAuthenticated = true;
        req.session.isAdmin = false;
        req.session.oauthProvider = provider;
        if (pendingApproval) {
            req.session.pendingApproval = true;
        }
        if (!userHasOrg && !req.session.pendingSignup) {
            req.session.noOrganization = true;
            console.log(`[OAuth/${provider}] User has no organization`);
        }
        // Handle SSO encryption with backward compatibility
        console.log(`[OAuth/${provider}] Checking encryption for user ${user.id}...`);
        const encryptionEnabled = await isEncryptionEnabledForUser(user.id);
        console.log(`[OAuth/${provider}] Encryption enabled: ${encryptionEnabled}`);
        const ssoResult = await getOrCreateSSOUserDEKCompat(user.id, encryptionEnabled);
        console.log(`[OAuth/${provider}] SSO DEK result — hasKey: ${!!ssoResult.encryptionKey}, needsSetup: ${!!ssoResult.needsEncryptionSetup}, needsPin: ${!!ssoResult.needsEncryptionPin}`);
        if (ssoResult.encryptionKey) {
            req.session.encryptionKey = ssoResult.encryptionKey;
        }
        if (ssoResult.needsEncryptionSetup) {
            req.session.needsEncryptionSetup = true;
        }
        if (ssoResult.needsEncryptionPin) {
            req.session.needsEncryptionPin = true;
        }

        console.log(`[OAuth/${provider}] Saving session and redirecting to: ${returnTo}`);
        req.session.save((err) => {
            if (err) console.error(`[OAuth/${provider}] SESSION SAVE ERROR:`, err);
            else console.log(`[OAuth/${provider}] === LOGIN COMPLETE === Redirecting user ${user.id}`);
            res.redirect(returnTo);
        });

    } catch (err) {
        console.error(`[OAuth/${provider}] CALLBACK EXCEPTION:`, err.message);
        console.error(`[OAuth/${provider}] Stack:`, err.stack);
        res.redirect(`${returnTo}?error=` + encodeURIComponent(err.message));
    }
});

// === OAuth/SSO Configuration API (Admin Only) ===

router.get('/oauth-config', requireAdmin, async (req, res) => {
    const config = await loadConfig();
    const oauth = config.oauth || {};

    res.json({
        enabled: !!oauth.nextcloudUrl,
        nextcloudUrl: oauth.nextcloudUrl || '',
        clientId: oauth.clientId || '',
        clientSecretSet: !!oauth.clientSecret
    });
});

router.put('/oauth-config', requireAdmin, async (req, res) => {
    const { nextcloudUrl, clientId, clientSecret } = req.body;

    const config = await loadConfig();
    config.oauth = config.oauth || {};

    if (nextcloudUrl !== undefined) config.oauth.nextcloudUrl = nextcloudUrl;
    if (clientId !== undefined) config.oauth.clientId = clientId;
    if (clientSecret && clientSecret.trim()) config.oauth.clientSecret = clientSecret;

    if (saveConfig(config)) {
        res.json({
            success: true,
            message: 'OAuth configuration saved',
            enabled: !!config.oauth.nextcloudUrl
        });
    } else {
        res.status(500).json({ error: 'Failed to save configuration' });
    }
});

router.post('/oauth-config/test', requireAdmin, async (req, res) => {
    const config = await loadConfig();
    const oauth = config.oauth || {};

    if (!oauth.nextcloudUrl) {
        return res.status(400).json({ error: 'Nextcloud URL not configured' });
    }

    try {
        const response = await fetch(`${oauth.nextcloudUrl}/status.php`);
        if (response.ok) {
            const data = await response.json();
            res.json({
                success: true,
                message: `Connected to ${data.productname || 'Nextcloud'} v${data.versionstring || 'unknown'}`
            });
        } else {
            res.status(400).json({ error: `Failed to connect: ${response.status}` });
        }
    } catch (err) {
        res.status(400).json({ error: `Connection failed: ${err.message}` });
    }
});

// === Provider-Specific Configuration API ===

router.get('/providers', requireAdmin, async (req, res) => {
    const config = await loadConfig();
    const providers = config.providers || {};
    const oauth = config.oauth || {};

    res.json({
        nextcloud: {
            enabled: !!(oauth.nextcloudUrl && oauth.clientId && oauth.clientSecret),
            url: oauth.nextcloudUrl || '',
            clientId: oauth.clientId || '',
            clientSecretSet: !!oauth.clientSecret
        },
        google: {
            enabled: !!(providers.google?.clientId && providers.google?.clientSecret),
            clientId: providers.google?.clientId || '',
            clientSecretSet: !!providers.google?.clientSecret
        },
        microsoft: {
            enabled: !!(providers.microsoft?.clientId && providers.microsoft?.clientSecret),
            clientId: providers.microsoft?.clientId || '',
            clientSecretSet: !!providers.microsoft?.clientSecret,
            tenantId: providers.microsoft?.tenantId || 'common'
        }
    });
});

router.get('/providers/:provider', requireAdmin, async (req, res) => {
    const { provider } = req.params;
    const config = await loadConfig();

    if (provider === 'nextcloud') {
        const oauth = config.oauth || {};
        res.json({
            enabled: !!(oauth.nextcloudUrl && oauth.clientId && oauth.clientSecret),
            url: oauth.nextcloudUrl || '',
            clientId: oauth.clientId || '',
            clientSecretSet: !!oauth.clientSecret
        });
    } else if (provider === 'google') {
        const providerConfig = config.providers?.google || {};
        res.json({
            enabled: !!(providerConfig.clientId && providerConfig.clientSecret),
            clientId: providerConfig.clientId || '',
            clientSecretSet: !!providerConfig.clientSecret
        });
    } else if (provider === 'microsoft') {
        const providerConfig = config.providers?.microsoft || {};
        res.json({
            enabled: !!(providerConfig.clientId && providerConfig.clientSecret),
            clientId: providerConfig.clientId || '',
            clientSecretSet: !!providerConfig.clientSecret,
            tenantId: providerConfig.tenantId || 'common'
        });
    } else {
        res.status(404).json({ error: 'Unknown provider' });
    }
});

router.put('/providers/:provider', requireAdmin, async (req, res) => {
    const { provider } = req.params;
    const config = await loadConfig();

    if (provider === 'nextcloud') {
        const { url, clientId, clientSecret } = req.body;
        config.oauth = config.oauth || {};
        if (url !== undefined) config.oauth.nextcloudUrl = url;
        if (clientId !== undefined) config.oauth.clientId = clientId;
        if (clientSecret && clientSecret.trim()) config.oauth.clientSecret = clientSecret;

    } else if (provider === 'google') {
        const { clientId, clientSecret } = req.body;
        config.providers = config.providers || {};
        config.providers.google = config.providers.google || {};
        if (clientId !== undefined) config.providers.google.clientId = clientId;
        if (clientSecret && clientSecret.trim()) config.providers.google.clientSecret = clientSecret;

    } else if (provider === 'microsoft') {
        const { clientId, clientSecret, tenantId } = req.body;
        config.providers = config.providers || {};
        config.providers.microsoft = config.providers.microsoft || {};
        if (clientId !== undefined) config.providers.microsoft.clientId = clientId;
        if (clientSecret && clientSecret.trim()) config.providers.microsoft.clientSecret = clientSecret;
        if (tenantId !== undefined) {
            const tid = (tenantId || '').trim();
            const knownAliases = ['common', 'organizations', 'consumers', ''];
            const isGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tid);
            if (!knownAliases.includes(tid.toLowerCase()) && !isGuid) {
                return res.status(400).json({ error: `Invalid Tenant ID "${tid}". Must be a GUID (e.g. xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) or one of: common, organizations, consumers` });
            }
            config.providers.microsoft.tenantId = tid || 'common';
        }

    } else {
        return res.status(404).json({ error: 'Unknown provider' });
    }

    if (saveConfig(config)) {
        res.json({ success: true, message: `${provider} configuration saved` });
    } else {
        res.status(500).json({ error: 'Failed to save configuration' });
    }
});

router.post('/providers/:provider/test', requireAdmin, async (req, res) => {
    const { provider } = req.params;
    const config = await loadConfig();

    if (provider === 'nextcloud') {
        const oauth = config.oauth || {};
        if (!oauth.nextcloudUrl) {
            return res.status(400).json({ error: 'Nextcloud URL not configured' });
        }
        try {
            const response = await fetch(`${oauth.nextcloudUrl}/status.php`);
            if (response.ok) {
                const data = await response.json();
                res.json({
                    success: true,
                    message: `Connected to ${data.productname || 'Nextcloud'} v${data.versionstring || 'unknown'}`
                });
            } else {
                res.status(400).json({ error: `Failed to connect: ${response.status}` });
            }
        } catch (err) {
            res.status(400).json({ error: `Connection failed: ${err.message}` });
        }

    } else if (provider === 'google') {
        const providerConfig = config.providers?.google || {};
        if (!providerConfig.clientId) {
            return res.status(400).json({ error: 'Google Client ID not configured' });
        }
        if (providerConfig.clientId.includes('.apps.googleusercontent.com')) {
            res.json({ success: true, message: 'Google OAuth credentials configured (format valid)' });
        } else {
            res.status(400).json({ error: 'Invalid Google Client ID format' });
        }

    } else if (provider === 'microsoft') {
        const providerConfig = config.providers?.microsoft || {};
        if (!providerConfig.clientId) {
            return res.status(400).json({ error: 'Microsoft Client ID not configured' });
        }
        const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (guidRegex.test(providerConfig.clientId)) {
            res.json({ success: true, message: 'Microsoft OAuth credentials configured (format valid)' });
        } else {
            res.status(400).json({ error: 'Invalid Microsoft Client ID format (should be a GUID)' });
        }

    } else {
        res.status(404).json({ error: 'Unknown provider' });
    }
});

module.exports = router;
