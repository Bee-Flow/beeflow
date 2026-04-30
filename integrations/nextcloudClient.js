/**
 * Nextcloud Client — Shared HTTP helper for OAuth Bearer access to WebDAV + OCS.
 *
 * Mirrors msGraphClient.js: a single fetch wrapper that injects the Bearer
 * token from the session and transparently refreshes on 401 using the stored
 * refresh token. Used by nextcloudTools.js when the session is in OAuth mode;
 * the Basic-auth (app-password) path bypasses this module entirely.
 */

const { loadConfig } = require('../auth/permissions');
const configStore = require('../stores/configStore');

const REQUEST_TIMEOUT_MS = 20000;

function isNextcloudOAuthSession(session) {
    return !!(session?.oauthProvider === 'nextcloud' && session?.accessToken);
}

async function getBaseUrl() {
    const oauth = (await configStore.getConfig('oauth')) || {};
    const url = (oauth.nextcloudUrl || '').replace(/\/+$/, '');
    if (!url) throw new Error('Nextcloud URL not configured. Ask an admin to set it under Admin → Authentication.');
    return url;
}

function webdavRoot(baseUrl, uid) {
    return `${baseUrl}/remote.php/dav/files/${encodeURIComponent(uid)}`;
}

/**
 * Refresh the Nextcloud OAuth access token using the refresh token.
 * Mutates the session in place and persists it.
 */
async function refreshAccessToken(session) {
    const config = await loadConfig();
    const { nextcloudUrl, clientId, clientSecret } = config.oauth || {};

    if (!nextcloudUrl || !clientId || !clientSecret) {
        throw new Error('Nextcloud OAuth not configured');
    }

    const refreshToken = session?.refreshToken;
    if (!refreshToken) {
        throw new Error('No refresh token available — user must re-authenticate with Nextcloud');
    }

    const response = await fetch(`${nextcloudUrl.replace(/\/+$/, '')}/apps/oauth2/api/v1/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
        }).toString(),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error('[Nextcloud] Token refresh failed:', errorText);
        throw new Error('Nextcloud token refresh failed — user must re-authenticate');
    }

    const tokenData = await response.json();

    if (tokenData.access_token) {
        session.accessToken = tokenData.access_token;
    }
    // Nextcloud rotates refresh tokens; always overwrite when present.
    if (tokenData.refresh_token) {
        session.refreshToken = tokenData.refresh_token;
    }
    if (tokenData.expires_in) {
        session.nextcloudTokenExpiresAt = Date.now() + Number(tokenData.expires_in) * 1000;
    }
    session.save?.();

    return tokenData.access_token;
}

/**
 * Resolve the WebDAV uid for the current OAuth session. Uses session.nextcloudUid
 * if present (set by the OAuth callback); falls back to a one-shot OCS lookup
 * for sessions established before the callback persisted the uid.
 */
async function resolveUid(session, baseUrl) {
    if (session?.nextcloudUid) return session.nextcloudUid;

    const res = await fetch(`${baseUrl}/ocs/v2.php/cloud/user?format=json`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${session.accessToken}`,
            'OCS-APIRequest': 'true',
            'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(`Failed to resolve Nextcloud uid (${res.status})`);
    }
    const body = await res.json();
    const uid = body?.ocs?.data?.id;
    if (!uid) throw new Error('Nextcloud uid not present in OCS response');
    session.nextcloudUid = uid;
    session.save?.();
    return uid;
}

/**
 * Fetch wrapper: injects Bearer auth, retries once on 401 after refreshing.
 * Returns the raw Response so callers can branch on status / read body shape.
 */
async function ncFetch(url, session, options = {}) {
    if (!isNextcloudOAuthSession(session)) {
        throw new Error('NOT_CONNECTED');
    }

    const doFetch = async (token) => {
        const headers = {
            'Authorization': `Bearer ${token}`,
            ...(options.headers || {}),
        };
        return fetch(url, {
            ...options,
            headers,
            signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    };

    let response = await doFetch(session.accessToken);

    if (response.status === 401) {
        try {
            const newToken = await refreshAccessToken(session);
            response = await doFetch(newToken);
        } catch (refreshErr) {
            console.error('[Nextcloud] Token refresh failed:', refreshErr.message);
            // Surface the original 401 so callers can render their own error.
        }
    }

    return response;
}

/**
 * Resolve the auth context shared by every Nextcloud tool module (files,
 * calendar, contacts, Deck, notifications). Returns a pre-bound `fetch` so
 * callers don't have to know about Bearer-vs-Basic — they just call it.
 *
 *   { mode: 'bearer', baseUrl, uid, fetch, authError }
 *   { mode: 'basic',  baseUrl, uid, username, password, fetch, authError }
 *
 * In both modes `uid` is the Nextcloud user identifier needed to construct
 * /remote.php/dav/{calendars,addressbooks,files}/<uid>/... paths.
 */
async function resolveAuth(session, userId) {
    const baseUrl = await getBaseUrl();

    if (isNextcloudOAuthSession(session)) {
        const uid = await resolveUid(session, baseUrl);
        return {
            mode: 'bearer',
            baseUrl,
            uid,
            session,
            fetch: (url, options) => ncFetch(url, session, options),
            authError: 'Nextcloud session expired — please log in again.',
        };
    }

    // App-password fallback. Lazy-required so we don't pull userStore into
    // every importer of this module.
    const userStore = require('../stores/userStore');
    const creds = await userStore.getAppPassword(userId);
    if (!creds || !creds.username || !creds.password) {
        throw new Error('Nextcloud not connected. Log in via Nextcloud OAuth, or add your username and app password in Settings → Integrations.');
    }
    const auth = 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
    return {
        mode: 'basic',
        baseUrl,
        uid: creds.username,
        username: creds.username,
        password: creds.password,
        fetch: (url, options = {}) => fetch(url, {
            ...options,
            headers: { 'Authorization': auth, ...(options.headers || {}) },
            signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
        authError: 'Nextcloud rejected credentials. Re-save your app password in Settings → Integrations.',
    };
}

module.exports = {
    isNextcloudOAuthSession,
    getBaseUrl,
    webdavRoot,
    refreshAccessToken,
    resolveUid,
    resolveAuth,
    ncFetch,
    REQUEST_TIMEOUT_MS,
};
