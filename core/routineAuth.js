/**
 * Routine Auth — single entry-point for unattended OAuth credential resolution.
 *
 * Routines run server-side via `aiTaskRunner` and need to call user-scoped
 * Google/Microsoft/Nextcloud APIs even when the user is offline. Today the
 * runner borrows the most recent web session row, which expires fast and
 * stops working as soon as the user closes the browser for long enough.
 *
 * This module replaces that with the long-lived `routine_credentials` vault:
 *
 *   1. Read the encrypted vault entry for (userId, provider).
 *   2. If the access token is missing or about to expire, refresh it using
 *      the provider's refresh-token endpoint and write the fresh tokens back
 *      to the vault.
 *   3. On refresh failure (revoked grant / expired refresh token / scope
 *      change) mark the credential `needs_reauth`, pause every routine on
 *      this user that depends on the provider, and emit a `routine_reauth`
 *      notification with a deep-link the frontend uses to start a fresh
 *      OAuth flow.
 *
 * The function returns a session-like shim so downstream code (notably
 * `getIntegrationTools`) can continue reading `session.accessToken` /
 * `session.refreshToken` exactly as it does today.
 */

const routineCredentialStore = require('../stores/routineCredentialStore');
const { loadConfig, OAUTH_PROVIDERS } = require('../auth/permissions');

const REFRESH_THRESHOLD_MS = 5 * 60_000; // refresh if <5 min left

// ── Provider derivation from agent's enabled integrations ───────────────
// Maps an integration id (as stored on agent.config.enabledIntegrations) to
// the OAuth provider whose tokens are required to call it. Anything not
// mapped here is assumed to use a per-user config-store API key (Fireflies,
// YouTrack, Gamma, etc) which doesn't need session auth at all.
const INTEGRATION_PROVIDER = {
    gmail:              'google',
    'google-calendar':  'google',
    'google-drive':     'google',
    'google-docs':      'google',
    'google-sheets':    'google',
    'google-slides':    'google',
    'google-contacts':  'google',
    'google-keep':      'google',
    'google-groups':    'google',
    outlook:            'microsoft',
    'outlook-readonly': 'microsoft',
    'ms-calendar':      'microsoft',
    'ms-contacts':      'microsoft',
    onedrive:           'microsoft',
    nextcloud:          'nextcloud',
    'nextcloud-calendar':      'nextcloud',
    'nextcloud-contacts':      'nextcloud',
    'nextcloud-deck':          'nextcloud',
    'nextcloud-notifications': 'nextcloud',
    'nextcloud-talk':          'nextcloud',
    'nextcloud-tasks':         'nextcloud',
    'nextcloud-notes':         'nextcloud',
    'nextcloud-activity':      'nextcloud',
    'nextcloud-status':        'nextcloud',
};

function providersForIntegrations(enabledIntegrations) {
    if (!Array.isArray(enabledIntegrations)) return [];
    const set = new Set();
    for (const id of enabledIntegrations) {
        const p = INTEGRATION_PROVIDER[id];
        if (p) set.add(p);
    }
    return Array.from(set);
}

// ── Refresh paths ───────────────────────────────────────────────────────

async function refreshGoogle(cred) {
    if (!cred?.refreshToken) throw new Error('No Google refresh token');
    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};
    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Google OAuth not configured');
    }
    const res = await fetch(OAUTH_PROVIDERS.google.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: cred.refreshToken,
            client_id: providerConfig.clientId,
            client_secret: providerConfig.clientSecret,
        }).toString(),
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Google refresh failed (${res.status}): ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
    return {
        accessToken: data.access_token,
        // Google rarely rotates refresh tokens; reuse the existing one if missing.
        refreshToken: data.refresh_token || cred.refreshToken,
        expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null,
        scope: data.scope || cred.scope,
    };
}

async function refreshMicrosoft(cred) {
    if (!cred?.refreshToken) throw new Error('No Microsoft refresh token');
    const config = await loadConfig();
    const providerConfig = config.providers?.microsoft || {};
    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Microsoft OAuth not configured');
    }
    const tenantId = providerConfig.tenantId || 'common';
    const tokenUrl = OAUTH_PROVIDERS.microsoft.tokenUrl(tenantId);
    const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: cred.refreshToken,
            client_id: providerConfig.clientId,
            client_secret: providerConfig.clientSecret,
            // Re-request the same offline + Graph scopes the initial flow used.
            scope: 'openid email profile User.Read Mail.Read Mail.Send Calendars.ReadWrite Files.ReadWrite Contacts.ReadWrite OnlineMeetings.Read OnlineMeetingTranscript.Read.All OnlineMeetingArtifact.Read.All offline_access',
        }).toString(),
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Microsoft refresh failed (${res.status}): ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
    return {
        accessToken: data.access_token,
        // Microsoft rotates refresh tokens on every refresh.
        refreshToken: data.refresh_token || cred.refreshToken,
        expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null,
        scope: data.scope || cred.scope,
    };
}

async function refreshNextcloud(cred) {
    if (!cred?.refreshToken) throw new Error('No Nextcloud refresh token');
    const config = await loadConfig();
    const { nextcloudUrl, clientId, clientSecret } = config.oauth || {};
    if (!nextcloudUrl || !clientId || !clientSecret) {
        throw new Error('Nextcloud OAuth not configured');
    }
    const res = await fetch(`${nextcloudUrl}/apps/oauth2/api/v1/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: cred.refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
        }).toString(),
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Nextcloud refresh failed (${res.status}): ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || cred.refreshToken,
        expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null,
        scope: cred.scope,
    };
}

const REFRESHERS = {
    google:    refreshGoogle,
    microsoft: refreshMicrosoft,
    nextcloud: refreshNextcloud,
};

// ── Pause + notify on refresh failure ───────────────────────────────────

async function _pauseRoutinesAndNotify(userId, provider, errorMessage) {
    try {
        await routineCredentialStore.markNeedsReauth(userId, provider, errorMessage);
    } catch (err) {
        console.warn(`[routineAuth] markNeedsReauth failed: ${err.message}`);
    }

    // Pause every routine of this user that depends on the broken provider.
    let pausedCount = 0;
    try {
        const aiTaskStore = require('../stores/aiTaskStore');
        const agentStore = require('../stores/agentStore');
        const tasks = await aiTaskStore.getTasks(userId).catch(() => []);
        for (const task of tasks) {
            if (!task.isActive) continue;
            // Legacy user-scoped tasks have no agent → pause anything (the
            // legacy runner will hit the same auth gap).
            let needsThisProvider = !task.agentId;
            if (task.agentId) {
                try {
                    const agent = await agentStore.getAgent(task.agentId);
                    const enabled = Array.isArray(agent?.config?.enabledIntegrations)
                        ? agent.config.enabledIntegrations
                        : [];
                    needsThisProvider = providersForIntegrations(enabled).includes(provider);
                } catch (_) { /* if we can't tell, leave it alone */ }
            }
            if (needsThisProvider) {
                try {
                    await aiTaskStore.updateTask(task.id, { isActive: false });
                    pausedCount += 1;
                } catch (err) {
                    console.warn(`[routineAuth] pause task ${task.id} failed: ${err.message}`);
                }
            }
        }
    } catch (err) {
        console.warn(`[routineAuth] failed to enumerate routines for pause: ${err.message}`);
    }

    // Single user-facing notification with a deep-link the frontend reads to
    // start the OAuth flow for this provider.
    try {
        const notificationStore = require('../stores/notificationStore');
        const providerLabel = provider === 'google' ? 'Google'
            : provider === 'microsoft' ? 'Microsoft'
            : provider === 'nextcloud' ? 'Nextcloud'
            : provider;
        const tail = pausedCount > 0
            ? ` ${pausedCount} routine${pausedCount === 1 ? '' : 's'} paused — reconnect to resume.`
            : ' Reconnect to resume your routines.';
        await notificationStore.createNotification({
            userId,
            category: 'urgent',
            title: `Reconnect ${providerLabel}`,
            // Keep the deep-link in the message body — NotificationCenter reads
            // the `routine_reauth:<provider>` token to render a one-click button.
            message: `routine_reauth:${provider}\n\nYour ${providerLabel} access has expired or been revoked.${tail}`,
        });
    } catch (err) {
        console.warn(`[routineAuth] reauth notification failed: ${err.message}`);
    }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Fetch a fresh-enough credential for (userId, provider). Returns null if the
 * user has never granted that provider, or the credential is in
 * `needs_reauth`/`revoked`, or refresh failed. In every null case the user
 * has already been pause-and-notified (when applicable) so the caller can
 * just bail.
 */
async function getProviderAuth(userId, provider) {
    const cred = await routineCredentialStore.getCredential(userId, provider);
    if (!cred) return null;
    if (cred.status !== 'active') return null;

    const needsRefresh = !cred.accessToken
        || !cred.expiresAt
        || cred.expiresAt < Date.now() + REFRESH_THRESHOLD_MS;

    if (!needsRefresh) return cred;

    const refresher = REFRESHERS[provider];
    if (!refresher) return cred; // unknown provider, hand back what we have

    try {
        const refreshed = await refresher(cred);
        await routineCredentialStore.upsertCredential({
            userId: cred.userId,
            orgId: cred.orgId,
            provider,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAt,
            scope: refreshed.scope,
        });
        return {
            ...cred,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAt,
            scope: refreshed.scope,
        };
    } catch (err) {
        console.warn(`[routineAuth] ${provider} refresh failed for user ${userId}: ${err.message}`);
        await _pauseRoutinesAndNotify(userId, provider, err.message);
        return null;
    }
}

/**
 * Build a session-shaped object for the runner. Picks the dominant provider
 * (the agent's primary OAuth need) and exposes its tokens as
 * `session.accessToken` / `session.refreshToken` so existing tool clients
 * keep working unchanged. If the agent needs multiple providers the
 * additional credentials live under `session.routineProviders[provider]`.
 *
 * Returns null if NONE of the required providers can produce a working
 * credential. Returns an object even if the agent only needs API-key
 * integrations (Fireflies/YouTrack/etc) — those load via configStore and
 * don't depend on session tokens.
 */
async function buildUserAuth(userId, { enabledIntegrations = [], providerHint = null } = {}) {
    const required = providersForIntegrations(enabledIntegrations);
    // No OAuth-backed integrations — return a bare shim. `getIntegrationTools`
    // can still load configStore-backed tools (Fireflies/YouTrack/Gamma/etc).
    if (required.length === 0) {
        return { userId, accessToken: null, refreshToken: null, oauthProvider: null, routineProviders: {} };
    }

    const providers = {};
    for (const provider of required) {
        providers[provider] = await getProviderAuth(userId, provider);
    }
    const okEntries = Object.entries(providers).filter(([, v]) => v && v.accessToken);
    if (okEntries.length === 0) return null;

    // Pick a primary so the legacy `session.accessToken` field is meaningful.
    // Prefer the explicitly-hinted provider, otherwise the first that worked.
    const primary = providerHint && providers[providerHint]?.accessToken
        ? providerHint
        : okEntries[0][0];

    const p = providers[primary];
    return {
        userId,
        oauthProvider: primary,
        accessToken: p.accessToken,
        refreshToken: p.refreshToken,
        expiresAt: p.expiresAt,
        routineProviders: providers,
    };
}

module.exports = {
    buildUserAuth,
    getProviderAuth,
    providersForIntegrations,
    refreshGoogle,
    refreshMicrosoft,
    refreshNextcloud,
};
