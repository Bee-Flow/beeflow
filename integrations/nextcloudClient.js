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

/**
 * Locate the Nextcloud token "slot" inside a session, regardless of whether
 * Nextcloud is the primary OAuth provider or a secondary one.
 *
 * Two cases:
 *   1. Browser session / Nextcloud-only routine: tokens live at session.accessToken
 *      / session.refreshToken / session.nextcloudUid (legacy shape).
 *   2. Multi-integration routine: routineAuth.buildUserAuth() may have picked
 *      a different primary (Google/Microsoft), with Nextcloud's tokens placed
 *      under session.routineProviders.nextcloud.
 *
 * Returns the same object both readers and the refresh path can mutate, so a
 * mid-routine token refresh propagates to subsequent calls in the same fire.
 * Returns null when no Nextcloud creds are present in either slot.
 */
function getNextcloudCredsRef(session) {
    if (!session) return null;
    if (session.oauthProvider === 'nextcloud' && session.accessToken) {
        // Legacy/primary slot — refresh writes back here.
        return {
            get accessToken() { return session.accessToken; },
            set accessToken(v) { session.accessToken = v; },
            get refreshToken() { return session.refreshToken; },
            set refreshToken(v) { session.refreshToken = v; },
            get expiresAt() { return session.nextcloudTokenExpiresAt; },
            set expiresAt(v) { session.nextcloudTokenExpiresAt = v; },
            get uid() { return session.nextcloudUid; },
            set uid(v) { session.nextcloudUid = v; },
            persist: () => session.save?.(),
        };
    }
    const sub = session.routineProviders?.nextcloud;
    if (sub && sub.accessToken) {
        return {
            get accessToken() { return sub.accessToken; },
            set accessToken(v) { sub.accessToken = v; },
            get refreshToken() { return sub.refreshToken; },
            set refreshToken(v) { sub.refreshToken = v; },
            get expiresAt() { return sub.expiresAt; },
            set expiresAt(v) { sub.expiresAt = v; },
            get uid() { return sub.nextcloudUid; },
            set uid(v) { sub.nextcloudUid = v; },
            // routineProviders is in-memory only — no persist hook, but
            // routineAuth refreshes from the encrypted vault next fire anyway.
            persist: () => {},
        };
    }
    return null;
}

function isNextcloudOAuthSession(session) {
    return !!getNextcloudCredsRef(session);
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
 * Refresh the Nextcloud OAuth access token using the refresh token. Writes
 * back to whichever slot held the original credentials (primary OR
 * routineProviders.nextcloud) so subsequent calls in the same fire pick up
 * the new token.
 */
async function refreshAccessToken(session) {
    const config = await loadConfig();
    const { nextcloudUrl, clientId, clientSecret } = config.oauth || {};

    if (!nextcloudUrl || !clientId || !clientSecret) {
        throw new Error('Nextcloud OAuth not configured');
    }

    const creds = getNextcloudCredsRef(session);
    const refreshToken = creds?.refreshToken;
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

    if (tokenData.access_token) creds.accessToken = tokenData.access_token;
    // Nextcloud rotates refresh tokens; always overwrite when present.
    if (tokenData.refresh_token) creds.refreshToken = tokenData.refresh_token;
    if (tokenData.expires_in) creds.expiresAt = Date.now() + Number(tokenData.expires_in) * 1000;
    creds.persist();

    return tokenData.access_token;
}

/**
 * Resolve the WebDAV uid for the current OAuth session. Uses the cached uid
 * on the credential slot if present (set by the OAuth callback); falls back
 * to a one-shot OCS lookup for sessions established before that callback.
 */
async function resolveUid(session, baseUrl) {
    const creds = getNextcloudCredsRef(session);
    if (creds?.uid) return creds.uid;
    if (!creds?.accessToken) throw new Error('No Nextcloud access token available');

    const res = await fetch(`${baseUrl}/ocs/v2.php/cloud/user?format=json`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${creds.accessToken}`,
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
    creds.uid = uid;
    creds.persist();
    return uid;
}

// Parse Retry-After per RFC 7231: integer seconds, or HTTP-date. Returns ms.
function parseRetryAfter(headerValue) {
    if (!headerValue) return null;
    const seconds = Number(headerValue);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(headerValue);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
    return null;
}

const RETRY_STATUS = new Set([429, 503]);
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 500;

// Wrap a request thunk with retry-on-429/503 + exponential backoff (honours
// Retry-After). The thunk should perform a single HTTP request and return
// the Response; it's invoked again on each retry.
async function retryOnThrottle(initialResponse, doFetch) {
    let response = initialResponse;
    let attempt = 0;
    while (RETRY_STATUS.has(response.status) && attempt < MAX_RETRIES) {
        const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
        const backoffMs = retryAfterMs ?? (BASE_BACKOFF_MS * Math.pow(2, attempt));
        await new Promise((r) => setTimeout(r, backoffMs));
        attempt += 1;
        response = await doFetch();
    }
    return response;
}

/**
 * Fetch wrapper: injects Bearer auth, retries once on 401 after refreshing,
 * and retries up to MAX_RETRIES times on 429/503 with exponential backoff
 * (honouring Retry-After when present). Returns the raw Response so callers
 * can branch on status / read body shape.
 */
async function ncFetch(url, session, options = {}) {
    const creds = getNextcloudCredsRef(session);
    if (!creds) {
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

    let response = await doFetch(creds.accessToken);

    if (response.status === 401) {
        try {
            const newToken = await refreshAccessToken(session);
            response = await doFetch(newToken);
        } catch (refreshErr) {
            console.error('[Nextcloud] Token refresh failed:', refreshErr.message);
            // Surface the original 401 so callers can render their own error.
            return response;
        }
    }

    // Re-read creds.accessToken on each retry — refresh may have rotated it.
    return retryOnThrottle(response, () => doFetch(creds.accessToken));
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
    const basicFetch = async (url, options = {}) => {
        const doOnce = () => fetch(url, {
            ...options,
            headers: { 'Authorization': auth, ...(options.headers || {}) },
            signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const first = await doOnce();
        return retryOnThrottle(first, doOnce);
    };
    return {
        mode: 'basic',
        baseUrl,
        uid: creds.username,
        username: creds.username,
        password: creds.password,
        fetch: basicFetch,
        authError: 'Nextcloud rejected credentials. Re-save your app password in Settings → Integrations.',
    };
}

/**
 * Build a Basic-Auth context, regardless of OAuth session state. Required for
 * Nextcloud apps whose API routes carry the `#[CORS]` attribute (Notes, Deck,
 * possibly others) — Nextcloud's CORS middleware logs the Bearer session out
 * and demands HTTP Basic credentials, so OAuth alone returns 401.
 *
 * Returns null when the user has no saved app password — caller should surface
 * a CORS-specific error message rather than the generic session-expired one.
 */
async function resolveBasicAuthOrNull(userId) {
    const userStore = require('../stores/userStore');
    const creds = await userStore.getAppPassword(userId);
    if (!creds || !creds.username || !creds.password) return null;
    const baseUrl = await getBaseUrl();
    const auth = 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
    const basicFetch = async (url, options = {}) => {
        const doOnce = () => fetch(url, {
            ...options,
            headers: { 'Authorization': auth, ...(options.headers || {}) },
            signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const first = await doOnce();
        return retryOnThrottle(first, doOnce);
    };
    return {
        mode: 'basic',
        baseUrl,
        uid: creds.username,
        username: creds.username,
        password: creds.password,
        fetch: basicFetch,
        authError: 'Nextcloud rejected credentials. Re-save your app password in Settings → Integrations.',
    };
}

const CORS_AUTH_ERROR = 'Nextcloud\'s Notes/Deck APIs use CORS protection that requires HTTP Basic auth — your OAuth login alone won\'t work for these. Please add a Nextcloud app password in Settings → Integrations.';

module.exports = {
    isNextcloudOAuthSession,
    getBaseUrl,
    webdavRoot,
    refreshAccessToken,
    resolveUid,
    resolveAuth,
    resolveBasicAuthOrNull,
    ncFetch,
    REQUEST_TIMEOUT_MS,
    CORS_AUTH_ERROR,
};
