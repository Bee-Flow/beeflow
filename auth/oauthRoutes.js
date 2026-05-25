/**
 * OAuth Routes — Multi-Provider OAuth 2.0
 * 
 * Handles: /login (legacy NC), /callback (legacy NC),
 * /login/:provider, /callback/:provider,
 * /oauth-config, /providers, /providers/:provider, /providers/:provider/test
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const { loadConfig, saveConfig, requireAdmin, OAUTH_PROVIDERS } = require('./permissions');
const { getOrCreateSSOUserDEKCompat, setupSSOUserDEK, unlockSSOUserDEK } = require('./encryption');
const userStore = require('../stores/userStore');
const { syncUserGroupsOnLogin } = require('../integrations/azureGroupSync');
const routineCredentialStore = require('../stores/routineCredentialStore');
const {
    deriveLocalUserId,
    resolveExistingSSOUser,
    resolveOrgByEmailDomain,
} = require('./ssoUserResolver');

/**
 * Persist long-lived OAuth tokens into the routine credential vault. Called
 * after every successful OAuth callback so unattended routines have an
 * encrypted, refresh-capable copy of the user's credentials even after their
 * web session expires. Failures are logged and swallowed — the user's login
 * must not break because the vault write hiccupped.
 */
async function _vaultUpsertSafe({ userId, orgId, provider, tokenData }) {
    if (!userId || !orgId || !provider || !tokenData) return;
    try {
        const expiresAt = tokenData.expires_in
            ? Date.now() + Number(tokenData.expires_in) * 1000
            : null;
        await routineCredentialStore.upsertCredential({
            userId,
            orgId,
            provider,
            accessToken: tokenData.access_token || null,
            refreshToken: tokenData.refresh_token || null,
            expiresAt,
            scope: tokenData.scope || null,
        });
        // Re-activate any routines this user previously had paused for
        // needs_reauth. The runner picks them up on the next 60s tick.
        try {
            const aiTaskStore = require('../stores/aiTaskStore');
            const resumed = await aiTaskStore.resumeNeedsReauthForUser(userId);
            if (resumed > 0) {
                console.log(`[OAuth/${provider}] resumed ${resumed} routine(s) for user ${userId} after reconnect`);
            }
        } catch (resumeErr) {
            console.warn(`[OAuth/${provider}] resume-routines failed for ${userId}: ${resumeErr.message}`);
        }
    } catch (err) {
        console.warn(`[OAuth/${provider}] routine vault upsert failed for user ${userId}: ${err.message}`);
    }
}

/**
 * Check if encryption is enabled for a user based on their org's subscription plan.
 * Admin users always have encryption enabled.
 * Encryption is a paid feature — disabled by default unless plan explicitly includes it.
 */
/**
 * Save the session and respond with either the popup-close HTML (when the
 * OAuth flow was launched in a popup/iframe) or a normal redirect. Shared by
 * the org-signup path and the consumer-signup early-return path so the two
 * cannot drift.
 */
function _respondOAuthLogin(req, res, provider, returnTo, userId) {
    console.log(`[OAuth/${provider}] Saving session and redirecting to: ${returnTo}`);
    req.session.save(async (err) => {
        if (err) console.error(`[OAuth/${provider}] SESSION SAVE ERROR:`, err);
        else console.log(`[OAuth/${provider}] === LOGIN COMPLETE === Redirecting user ${userId}`);

        if (req.session.oauthPopup) {
            const pickupId = req.session.oauthPickupId;
            delete req.session.oauthPopup;
            delete req.session.oauthPickupId;
            req.session.save();

            if (pickupId) {
                try {
                    const { setSessionToken, setPickup, generateToken } = require('../utils/sessionToken');
                    const appPasswordData = await userStore.getAppPassword(userId);
                    const sessionToken = generateToken();
                    await setSessionToken(sessionToken, {
                        user: req.session.user,
                        accessToken: req.session.accessToken,
                        refreshToken: req.session.refreshToken,
                        oauthProvider: req.session.oauthProvider,
                        nextcloudUid: req.session.nextcloudUid,
                        appPassword: appPasswordData,
                        isAuthenticated: true,
                        isAdmin: req.session.isAdmin || false,
                    });
                    await setPickup(pickupId, { sessionToken });
                    console.log(`[OAuth/${provider}] Pickup ${pickupId} deposited (token len=${sessionToken.length})`);
                } catch (pickupErr) {
                    console.error(`[OAuth/${provider}] Pickup deposit failed:`, pickupErr.message);
                }
            }

            const html = `<!DOCTYPE html><html><head><title>Login Complete</title></head><body>
<script>
  try {
    if (window.opener) {
      window.opener.postMessage({ type: 'beeflow-oauth-complete' }, '*');
    }
  } catch(e) {}
  window.close();
</script>
<p style="font-family:sans-serif;text-align:center;margin-top:40px">Login complete. You can close this window.</p>
</body></html>`;
            return res.send(html);
        }

        res.redirect(returnTo);
    });
}

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
        console.error('[OAuth] Failed to check encryption feature:', e.message);
        return false;
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

// Pickup claim — used by embedded iframes that can't see the popup's session
// cookie (Chrome storage partitioning). The popup deposits a session token
// under a random pickup id (see callback below); the iframe polls this
// endpoint until the token is available, then sends it as X-Session-Token on
// every subsequent request. One-time read.
router.get('/login-pickup', async (req, res) => {
    const id = String(req.query.id || '');
    if (!id || id.length > 128) return res.status(400).json({ error: 'invalid id' });
    try {
        const { claimPickup } = require('../utils/sessionToken');
        const data = await claimPickup(id);
        if (!data) return res.status(404).json({ pending: true });
        return res.json({ sessionToken: data.sessionToken });
    } catch (e) {
        console.error('[OAuth/login-pickup] error:', e.message);
        return res.status(500).json({ error: e.message });
    }
});

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

    // Mirror the new /login/:provider route's iframe support so that BeeFlow
    // installs whose Nextcloud OAuth client still points at the legacy
    // /auth/callback URI keep working in embedded mode.
    if (req.query.popup === '1') req.session.oauthPopup = true;
    if (req.query.pickup) req.session.oauthPickupId = String(req.query.pickup).slice(0, 128);

    const host = req.get('host');
    const REDIRECT_URI = `${req.protocol}://${host}/auth/callback`;

    if (!nextcloudUrl || !clientId) {
        return res.redirect(`${returnTo}?error=oauth_not_configured`);
    }

    // CSRF defense — the state must be high-entropy and validated on callback.
    // `Math.random()` was both predictable and unread on the callback side.
    const state = crypto.randomBytes(16).toString('hex');
    req.session.legacyOAuthState = state;

    const authUrl = `${nextcloudUrl}/apps/oauth2/authorize?` + new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        state,
    }).toString();

    req.session.save(() => {
        if (req.session.oauthPopup) return popupRedirect(res, authUrl);
        res.redirect(authUrl);
    });
});

// Legacy Nextcloud callback
router.get('/callback', async (req, res) => {
    const { code, error, state } = req.query;
    const config = await loadConfig();
    const { nextcloudUrl, clientId, clientSecret } = config.oauth || {};

    const returnTo = req.session.returnTo || 'http://localhost:5173';
    delete req.session.returnTo;

    console.log(`[OAuth/legacy] CALLBACK session: oauthPopup=${!!req.session.oauthPopup} oauthPickupId=${req.session.oauthPickupId || '(none)'}`);

    const host = req.get('host');
    const REDIRECT_URI = `${req.protocol}://${host}/auth/callback`;

    // Validate the CSRF state we issued at /login above. Compare in
    // constant time and clear the session value either way so a leaked
    // state can't be replayed.
    const expectedState = req.session.legacyOAuthState;
    delete req.session.legacyOAuthState;
    if (!expectedState || typeof state !== 'string') {
        return res.redirect(`${returnTo}?error=invalid_state`);
    }
    const a = Buffer.from(expectedState, 'utf8');
    const b = Buffer.from(state, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.redirect(`${returnTo}?error=invalid_state`);
    }

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
            // Persist the raw Nextcloud uid for WebDAV path construction.
            if (user?.id) req.session.nextcloudUid = user.id;
        }

        req.session.accessToken = tokenData.access_token;
        req.session.refreshToken = tokenData.refresh_token;
        req.session.oauthProvider = 'nextcloud';
        if (tokenData.expires_in) {
            req.session.nextcloudTokenExpiresAt = Date.now() + Number(tokenData.expires_in) * 1000;
        }
        req.session.user = user;
        req.session.isAuthenticated = true;
        // Check stored user role — SSO users can also be admins
        const freshUserLegacy = await userStore.getUser(user?.id || 'oauth-user');
        req.session.isAdmin = freshUserLegacy?.role === 'admin';

        // Long-lived encrypted vault copy for unattended routines.
        if (freshUserLegacy?.organizationId && user?.id) {
            await _vaultUpsertSafe({
                userId: user.id,
                orgId: freshUserLegacy.organizationId,
                provider: 'nextcloud',
                tokenData,
            });
        }
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

        req.session.save(async (err) => {
            if (err) console.error('Session save error:', err);

            // Embedded-iframe popup handoff (mirrors /callback/:provider).
            if (req.session.oauthPopup) {
                const pickupId = req.session.oauthPickupId;
                delete req.session.oauthPopup;
                delete req.session.oauthPickupId;
                req.session.save();

                if (pickupId) {
                    try {
                        const { setSessionToken, setPickup, generateToken } = require('../utils/sessionToken');
                        const userIdLegacy = user?.id || 'oauth-user';
                        const appPasswordData = await userStore.getAppPassword(userIdLegacy);
                        const sessionToken = generateToken();
                        await setSessionToken(sessionToken, {
                            user: req.session.user,
                            accessToken: req.session.accessToken,
                            refreshToken: req.session.refreshToken,
                            oauthProvider: req.session.oauthProvider,
                            nextcloudUid: req.session.nextcloudUid,
                            appPassword: appPasswordData,
                            isAuthenticated: true,
                            isAdmin: req.session.isAdmin || false,
                        });
                        await setPickup(pickupId, { sessionToken });
                        console.log(`[OAuth/legacy] Pickup ${pickupId} deposited (token len=${sessionToken.length})`);
                    } catch (pickupErr) {
                        console.error(`[OAuth/legacy] Pickup deposit failed:`, pickupErr.message);
                    }
                }

                return res.send(`<!DOCTYPE html><html><head><title>Login Complete</title></head><body>
<script>try{if(window.opener)window.opener.postMessage({type:'beeflow-oauth-complete'},'*');}catch(e){}window.close();</script>
<p style="font-family:sans-serif;text-align:center;margin-top:40px">Login complete. You can close this window.</p>
</body></html>`);
            }

            res.redirect(returnTo);
        });

    } catch (err) {
        console.error('OAuth callback error:', err);
        res.redirect(`${returnTo}?error=` + encodeURIComponent(err.message));
    }
});

// === Multi-Provider OAuth Routes ===

// When popup=1 (embedded iframe mode), we serve an intermediate HTML page
// instead of a 302 redirect. This cleans the Referer header and severs the
// iframe->popup->provider relationship so Google/Microsoft don't block it.
function popupRedirect(res, url) {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.send(`<!DOCTYPE html><html><head>
<meta http-equiv="refresh" content="0;url=${url}">
<meta name="referrer" content="no-referrer">
</head><body>
<script>window.location.replace(${JSON.stringify(url)});</script>
<p style="font-family:sans-serif;text-align:center;margin-top:40px">Redirecting...</p>
</body></html>`);
}

// Provider-specific login - redirects to OAuth provider
router.get('/login/:provider', async (req, res) => {
    const { provider } = req.params;
    const config = await loadConfig();

    const returnTo = getReturnUrl(req);
    req.session.returnTo = returnTo;
    req.session.oauthProvider = provider;

    // When ?popup=1 is set (embedded iframe mode), remember so the callback
    // can render a postMessage page instead of a redirect.
    if (req.query.popup === '1') {
        req.session.oauthPopup = true;
    }
    // When ?pickup=<id> is set (storage-partitioned iframe), the iframe is
    // polling /auth/login-pickup?id=<id> for a session token to bridge the
    // cookie gap. Stash the id so the callback can deposit a token.
    if (req.query.pickup) {
        req.session.oauthPickupId = String(req.query.pickup).slice(0, 128);
    }

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

    // PKCE (RFC 7636) — generate a 32-byte verifier and its SHA-256 challenge
    // so the token exchange is bound to this browser even if an attacker
    // intercepts the auth code. Stash the verifier in the session (cleared
    // on callback) and send the challenge with the authorize request. We
    // emit PKCE for every provider that supports it (Google + Microsoft).
    // Nextcloud's OAuth2 app supports PKCE since v22 — sending it is safe;
    // servers that don't recognise the params ignore them.
    const codeVerifier = crypto.randomBytes(32).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    req.session.oauthCodeVerifier = codeVerifier;

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
            prompt: 'consent',
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
        }).toString();

        req.session.save(() => {
            if (req.session.oauthPopup) return popupRedirect(res, authUrl);
            res.redirect(authUrl);
        });

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
            response_mode: 'query',
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
        }).toString();

        console.log(`[OAuth/Microsoft] Auth URL: ${authUrl}`);
        console.log(`[OAuth/Microsoft] State saved: ${state}`);
        req.session.save((err) => {
            if (err) console.error(`[OAuth/Microsoft] Session save error on login redirect:`, err);
            else console.log(`[OAuth/Microsoft] Session saved, redirecting to Microsoft...`);
            if (req.session.oauthPopup) return popupRedirect(res, authUrl);
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
        req.session.save(() => {
            if (req.session.oauthPopup) return popupRedirect(res, authUrl);
            res.redirect(authUrl);
        });
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
    console.log(`[OAuth/${provider}] CALLBACK session: oauthPopup=${!!req.session.oauthPopup} oauthPickupId=${req.session.oauthPickupId || '(none)'} oauthState=${req.session.oauthState ? '(present)' : '(missing)'}`);
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

    // PKCE verifier paired with the auth code by /login/:provider. One-shot:
    // clear from the session whether the exchange succeeds or fails so a
    // leaked auth code can't be replayed in another browser.
    const codeVerifier = req.session.oauthCodeVerifier;
    delete req.session.oauthCodeVerifier;

    try {
        let tokenData, user;

        if (provider === 'google') {
            const providerConfig = config.providers?.google || {};

            const googleBody = {
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
                client_id: providerConfig.clientId,
                client_secret: providerConfig.clientSecret,
            };
            if (codeVerifier) googleBody.code_verifier = codeVerifier;
            const tokenResponse = await fetch(OAUTH_PROVIDERS.google.tokenUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(googleBody).toString()
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

            const msBody = {
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
                client_id: providerConfig.clientId,
                client_secret: providerConfig.clientSecret,
            };
            if (codeVerifier) msBody.code_verifier = codeVerifier;
            const tokenResponse = await fetch(tokenUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(msBody).toString()
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
                // Keep the Azure object id separate from the local id. The
                // local id is resolved/minted in the provisioning block below
                // so we do not collide with users already synced from Azure AD.
                user = {
                    azureUserId: userData.id || null,
                    displayName: userData.displayName || userData.userPrincipalName,
                    email: userData.mail || userData.userPrincipalName,
                    provider: 'microsoft'
                };
                console.log(`[OAuth/Microsoft] Mapped user — azureUserId: ${user.azureUserId}, displayName: ${user.displayName}, email: ${user.email}`);

                // Attempt to fetch profile picture
                console.log(`[OAuth/Microsoft] Attempting to fetch user photo...`);
                try {
                    const photoResponse = await fetch('https://graph.microsoft.com/v1.0/me/photo/$value', {
                        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
                    });
                    if (photoResponse.ok) {
                        const arrayBuffer = await photoResponse.arrayBuffer();
                        const buffer = Buffer.from(arrayBuffer);
                        const uploadDir = path.join(__dirname, '..', 'data', 'uploads');
                        if (!fs.existsSync(uploadDir)) {
                            fs.mkdirSync(uploadDir, { recursive: true });
                        }
                        const safeId = String(user.azureUserId || user.email || 'ms').replace(/[^a-zA-Z0-9]/g, '');
                        const filename = `user-avatar-azure-${safeId}-${Date.now()}.jpg`;
                        const filepath = path.join(uploadDir, filename);
                        fs.writeFileSync(filepath, buffer);
                        user.picture = `/uploads/${filename}`;
                        console.log(`[OAuth/Microsoft] Saved user photo to ${filepath}`);
                    } else {
                        console.log(`[OAuth/Microsoft] User has no photo or access denied: ${photoResponse.status}`);
                    }
                } catch (photoErr) {
                    console.log(`[OAuth/Microsoft] Error fetching photo: ${photoErr.message}`);
                }
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
                // Persist the raw uid for WebDAV path construction. Must be
                // captured BEFORE we mint the prefixed local id below.
                if (ocs.id) req.session.nextcloudUid = ocs.id;
                if (tokenData.expires_in) {
                    req.session.nextcloudTokenExpiresAt = Date.now() + Number(tokenData.expires_in) * 1000;
                }
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

        // Non-Microsoft providers (Nextcloud, legacy) historically used the
        // provider-issued id as the local id. Preserve that as the provisional
        // localId so the resolver's legacy-id fallback can still find them.
        // For Microsoft, the Azure OID lives on user.azureUserId — the local
        // id is derived/resolved below.
        const provisionalLocalId = user.id || deriveLocalUserId(user.email, user.azureUserId);

        const { user: existingUser, branch } = await resolveExistingSSOUser(
            { azureUserId: user.azureUserId || null, email: user.email, localId: provisionalLocalId },
            userStore,
        );

        if (existingUser) {
            // Canonical id comes from the stored record. Do NOT overwrite
            // role, orgRole, organizationId, groups, or status here — those
            // are managed by the directory sync and admin flows.
            user.id = existingUser.id;
            await userStore.updateUser(existingUser.id, {
                displayName: user.displayName,
                firstName: user.firstName || existingUser.firstName,
                lastName: user.lastName || existingUser.lastName,
                email: user.email || existingUser.email,
                avatar: user.picture || existingUser.avatar,
                avatarType: user.picture ? 'url' : existingUser.avatarType,
            });
            console.log(`[OAuth/${provider}] Matched existing user via branch=${branch} → ${existingUser.id} (azureUserId=${existingUser.azureUserId || 'none'}, org=${existingUser.organizationId || 'none'})`);
        } else {
            // Truly new user — derive a stable local id and pre-resolve the
            // organization by email domain so the record isn't orphaned.
            const localId = deriveLocalUserId(user.email, user.azureUserId);
            user.id = localId;

            let preResolvedOrg = null;
            if (user.email && user.email.includes('@')) {
                const allOrgs = await userStore.getAllOrganizations();
                preResolvedOrg = resolveOrgByEmailDomain(user.email, allOrgs);
            }

            try {
                const r = await userStore.createUserWithSeatCheck({
                    id: localId,
                    username: user.email || localId,
                    displayName: user.displayName,
                    firstName: user.firstName || '',
                    lastName: user.lastName || '',
                    email: user.email || '',
                    avatar: user.picture || null,
                    avatarType: user.picture ? 'url' : null,
                    role: 'user',
                    groups: [],
                    azureUserId: user.azureUserId || null,
                    organizationId: preResolvedOrg?.id || '',
                }, { strict: true });
                if (!r.created && r.reason !== 'duplicate_id') {
                    console.warn('[OAuth] auto-provision failed:', r.reason, r.error || '');
                }
            } catch (e) {
                if (e instanceof userStore.SeatCapExceededError) {
                    return res.status(403).json({ error: 'seat_cap_exceeded', current: e.current, max: e.max });
                }
                throw e;
            }
            console.log(`[OAuth/${provider}] Created new user via branch=create → ${localId} (azureUserId=${user.azureUserId || 'none'}, preResolvedOrg=${preResolvedOrg?.id || 'none'})`);
        }

        // Handle pending signup — create organization or consumer account
        if (req.session.pendingSignup) {
            const pendingData = req.session.pendingSignup;
            delete req.session.pendingSignup;

            if (pendingData.signupType === 'consumer') {
                // Consumer OAuth signup — mark user as consumer, no org.
                // We finalize the session here and return early so the
                // org-resolution code below (domain matching, noOrganization
                // gate) can't accidentally bind a personal account to an
                // existing org or trip the "No Organisation Found" screen.
                const configStore = require('../stores/configStore');
                const waitlistEnabled = (await configStore.getConfig('signup_waitlist_enabled')) ?? false;
                const userStatus = waitlistEnabled ? 'waitlist' : 'active';
                await userStore.updateUser(user.id, {
                    isConsumer: true,
                    status: userStatus,
                });
                console.log(`[OAuth] Consumer account created for ${user.id} (status: ${userStatus})`);

                req.session.accessToken = tokenData.access_token;
                req.session.refreshToken = tokenData.refresh_token;
                req.session.user = user;
                req.session.isAuthenticated = true;
                req.session.isAdmin = false;
                req.session.oauthProvider = provider;

                console.log(`[OAuth/${provider}] Checking encryption for user ${user.id}...`);
                const encryptionEnabled = await isEncryptionEnabledForUser(user.id);
                console.log(`[OAuth/${provider}] Encryption enabled: ${encryptionEnabled}`);
                const ssoResult = await getOrCreateSSOUserDEKCompat(user.id, encryptionEnabled);
                console.log(`[OAuth/${provider}] SSO DEK result — hasKey: ${!!ssoResult.encryptionKey}, needsSetup: ${!!ssoResult.needsEncryptionSetup}, needsPin: ${!!ssoResult.needsEncryptionPin}`);
                if (ssoResult.encryptionKey) req.session.encryptionKey = ssoResult.encryptionKey;
                if (ssoResult.needsEncryptionSetup) req.session.needsEncryptionSetup = true;
                if (ssoResult.needsEncryptionPin) req.session.needsEncryptionPin = true;

                return _respondOAuthLogin(req, res, provider, returnTo, user.id);
            } else {
                // Org OAuth signup
                const { newOrgName, orgDetails: od } = pendingData;

            const orgId = newOrgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
            const orgEmail = od.email || user.email || '';

            // Check domain collision (against both org email and allowedDomains)
            let domainTaken = false;
            if (orgEmail && orgEmail.includes('@')) {
                const domain = orgEmail.split('@')[1].toLowerCase();
                const existingOrgs = await userStore.getAllOrganizations();
                domainTaken = existingOrgs.find(o => {
                    // Check allowedDomains array
                    if (Array.isArray(o.allowedDomains) && o.allowedDomains.includes(domain)) return true;
                    // Check org email domain
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
            } // end org OAuth signup else
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
        // Also check if user has an organizationId set directly (e.g. added manually by admin)
        if (freshUser?.organizationId) userHasOrg = true;

        // If user has no org, try domain-matching
        let pendingApproval = false;
        if (!userHasOrg && !req.session.pendingSignup && user.email && user.email.includes('@')) {
            const allOrgs = await userStore.getAllOrganizations();
            const matchingOrg = resolveOrgByEmailDomain(user.email, allOrgs);

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

        // ── Azure group sync on login ──────────────────────────────
        // Fire-and-forget: update Azure group memberships for Microsoft SSO users.
        // Never awaited so it cannot block or fail login.
        if (provider === 'microsoft' && freshUser?.azureUserId && freshUser?.organizationId) {
            syncUserGroupsOnLogin(freshUser.id, freshUser.azureUserId, freshUser.organizationId)
                .catch(() => {}); // errors already logged inside the function
        }

        console.log(`[OAuth/${provider}] === SESSION SETUP ===`);
        console.log(`[OAuth/${provider}] User: ${user.id} (${user.displayName}), pendingApproval: ${pendingApproval}, userHasOrg: ${userHasOrg}`);
        req.session.accessToken = tokenData.access_token;
        req.session.refreshToken = tokenData.refresh_token;
        req.session.user = user;
        req.session.isAuthenticated = true;
        req.session.isAdmin = freshUser?.role === 'admin';
        req.session.oauthProvider = provider;

        // Long-lived encrypted vault copy for unattended routines. Only
        // populates if we have an org context (org-scoped key derivation).
        const vaultOrgId = freshUser?.organizationId || user?.organizationId || null;
        if (vaultOrgId) {
            await _vaultUpsertSafe({ userId: user.id, orgId: vaultOrgId, provider, tokenData });
        }
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

        _respondOAuthLogin(req, res, provider, returnTo, user.id);

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

// === Self-service OAuth credential management ===
//
// Lets a signed-in user inspect and revoke the long-lived OAuth credentials
// the routine vault holds on their behalf. Revoking deletes the local row
// AND calls the provider's revocation endpoint when one is known — so
// background runners stop using the credential immediately, and Google /
// Microsoft can clean up their issued tokens. Failures on the provider
// side are logged but the local delete proceeds regardless (we'd rather
// orphan a token in the provider than keep an unrevocable secret around).

function _requireAuthedUser(req, res) {
    if (!req.session?.user?.id) {
        res.status(401).json({ error: 'Not authenticated' });
        return null;
    }
    return req.session.user.id;
}

router.get('/integrations/credentials', async (req, res) => {
    const userId = _requireAuthedUser(req, res);
    if (!userId) return;
    try {
        const list = await routineCredentialStore.listProvidersForUser(userId);
        res.json({ credentials: list });
    } catch (e) {
        console.error('[OAuth] list credentials failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Best-effort provider-side revocation. Each provider expects a slightly
// different shape; failures are non-fatal so the local delete always
// proceeds. Tokens are decrypted from the vault only inside this call.
async function _revokeAtProvider(provider, accessToken) {
    if (!accessToken) return { ok: false, reason: 'no_token' };
    try {
        if (provider === 'google') {
            const r = await fetch('https://oauth2.googleapis.com/revoke', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ token: accessToken }).toString(),
            });
            return { ok: r.ok, status: r.status };
        }
        if (provider === 'microsoft') {
            // Microsoft Graph doesn't expose a token-revoke endpoint for
            // confidential clients. The closest official action is calling
            // /me/revokeSignInSessions, but that requires the right scope.
            // Document and skip — local delete still cuts off our access.
            return { ok: false, reason: 'no_revoke_endpoint' };
        }
        if (provider === 'nextcloud') {
            // Per-instance; we don't know the instance URL from inside this
            // helper, and the Nextcloud OAuth2 app doesn't standardise a
            // revocation endpoint. Skip.
            return { ok: false, reason: 'no_revoke_endpoint' };
        }
        return { ok: false, reason: 'unknown_provider' };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

router.delete('/integrations/credentials/:provider', async (req, res) => {
    const userId = _requireAuthedUser(req, res);
    if (!userId) return;
    const provider = String(req.params.provider || '').toLowerCase();
    try {
        const cred = await routineCredentialStore.getCredential(userId, provider);
        if (!cred) return res.status(404).json({ error: 'Credential not found' });

        // 1. Provider-side revoke (best-effort).
        const providerResult = await _revokeAtProvider(provider, cred.accessToken);
        if (!providerResult.ok) {
            console.warn(`[OAuth] provider revoke userId=${userId} provider=${provider} skipped: ${providerResult.reason || providerResult.status}`);
        }

        // 2. Mark revoked first (so a partial failure leaves the row in a
        // refusable state), then delete.
        await routineCredentialStore.markRevoked(userId, provider).catch(() => {});
        const deleted = await routineCredentialStore.deleteCredential(userId, provider);

        // 3. Audit. Uses the access_audit_log added in C7 — same shape as
        // credential.delete from configStore.
        try {
            const userStore = require('../stores/userStore');
            await userStore.logAccessAudit(
                'credential.revoke',
                'oauth_credential',
                `${userId}:${provider}`,
                userId,
                null,
                { provider, provider_revoke_ok: providerResult.ok },
                cred.orgId || null,
            );
        } catch (_) { /* non-fatal */ }

        res.json({ success: deleted, providerRevokeAttempted: !!cred.accessToken, providerRevokeOk: providerResult.ok });
    } catch (e) {
        console.error('[OAuth] revoke credential failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
