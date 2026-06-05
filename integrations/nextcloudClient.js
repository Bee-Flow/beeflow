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

// Resolve the Nextcloud base URL. A per-user URL (saved alongside the app
// password in Settings → Connections) takes precedence; otherwise fall back to
// the org-wide oauth.nextcloudUrl. Pass `overrideUrl` from the user's creds.
async function getBaseUrl(overrideUrl) {
    let url = (overrideUrl || '').trim().replace(/\/+$/, '');
    if (!url) {
        const oauth = (await configStore.getConfig('oauth')) || {};
        url = (oauth.nextcloudUrl || '').replace(/\/+$/, '');
    }
    if (!url) throw new Error('Nextcloud URL not configured. Add your Nextcloud URL in Settings → Connections, or ask an admin to set the organisation default.');
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
// Connector-proxied auth: the user logged in via the Nextcloud ExApp
// connector, so we don't have OAuth tokens or an app password — but we do
// have an instance binding (session.connectorOrgId, session.connectorNcUid).
// Route every NC call through the connector's /nc/* reverse proxy. The
// connector signs with AppAPI shared-secret + impersonates the user — no
// credentials ever touch this process.
async function resolveConnectorAuth(session) {
    const orgId = session?.connectorOrgId || session?.user?.organizationId;
    const ncUid = session?.connectorNcUid || session?.user?.ncUid;
    if (!orgId || !ncUid) return null;

    const userStore = require('../stores/userStore');
    const org = await userStore.getOrganization(orgId);
    const callbackUrl = org?.connector_callback_url;
    if (!callbackUrl) return null;

    const tenantKey = await configStore.getSecret(`connector_tenant_key_${orgId}`);
    if (!tenantKey) return null;

    const crypto = require('crypto');
    const baseUrl = `${callbackUrl.replace(/\/+$/, '')}/nc`;
    const connectorFetch = async (url, options = {}) => {
        // url may be absolute (full <baseUrl>/...) or a path. Normalise to
        // the path-and-query the connector will see, since that's what we
        // sign over.
        let pathOnly;
        if (url.startsWith(baseUrl)) {
            pathOnly = '/nc' + url.slice(baseUrl.length);
        } else if (url.startsWith('/nc')) {
            pathOnly = url;
        } else {
            pathOnly = url; // best-effort: caller already passed correct path
        }
        const ts = Math.floor(Date.now() / 1000);
        const method = (options.method || 'GET').toUpperCase();
        // Nextcloud's AppAPI proxy (which fronts the connector's /nc/* route for
        // SaaS→NC callbacks) only reliably forwards GET and POST raw. Every other
        // verb — the WebDAV methods (PROPFIND/REPORT/MKCOL/MOVE/COPY/…) AND the
        // write verbs (PUT/DELETE/PATCH) — is rejected (PROPFIND/REPORT surface as
        // 405; PUT/DELETE/PATCH as 401), so reads work but writes fail. Tunnel
        // everything except GET/POST over POST + X-HTTP-Method-Override; the
        // connector restores the real method before it reaches Nextcloud (where
        // DAV/writes work fine). The HMAC is signed over the REAL method so the
        // connector can verify it after un-tunnelling.
        const RAW_METHODS = new Set(['GET', 'POST']);
        const needsTunnel = !RAW_METHODS.has(method);
        const wireMethod = needsTunnel ? 'POST' : method;
        const message = `${ts}\n${method}\n${pathOnly}\n${ncUid}`;
        const sig = crypto.createHmac('sha256', tenantKey).update(message).digest('hex');
        const headers = {
            ...(options.headers || {}),
            'X-Beeflow-Sig': `${ts}.${sig}`,
            'X-Beeflow-NC-Uid': ncUid,
            ...(needsTunnel ? { 'X-HTTP-Method-Override': method } : {}),
        };
        const doOnce = () => fetch(url, {
            ...options,
            method: wireMethod,
            headers,
            signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const first = await doOnce();
        return retryOnThrottle(first, doOnce);
    };
    return {
        mode: 'connector',
        baseUrl,
        uid: ncUid,
        session,
        fetch: connectorFetch,
        authError: 'Bee Flow connector could not reach Nextcloud — please ensure the ExApp is enabled.',
    };
}

async function resolveAuth(session, userId) {
    // Connector path takes priority: if the user came in via the Nextcloud
    // ExApp connector, we have an instance binding and zero credentials —
    // routing through /nc/* is the only way to reach NC.
    if (session?.user?.provider === 'nextcloud_connector' || session?.connectorOrgId) {
        const connector = await resolveConnectorAuth(session);
        if (connector) return connector;
        // fall through to legacy paths if connector binding incomplete
    }

    if (isNextcloudOAuthSession(session)) {
        // OAuth always targets the org-configured instance the user logged into.
        const baseUrl = await getBaseUrl();
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
        throw new Error('Nextcloud not connected. Log in via Nextcloud OAuth, or add your username and app password in Settings → Connections.');
    }
    // Prefer the URL the user saved with their app password; org default otherwise.
    const baseUrl = await getBaseUrl(creds.url);
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
    const baseUrl = await getBaseUrl(creds.url);
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

/**
 * Stream a binary file from Nextcloud Files (WebDAV) to disk.
 *
 * Used for audio/video imports where loading the whole file into memory
 * would be wasteful — meeting recordings can easily exceed 100 MB.
 *
 * @param {object} session  Express session (used to resolve auth).
 * @param {string} userId   For app-password fallback.
 * @param {string} ncPath   Path within the user's Files root, e.g. "/Recordings/2026-05-08.mp3".
 * @param {string} destPath Local filesystem path to write to.
 * @returns {Promise<{ size, contentType }>}
 */
async function downloadBinary(session, userId, ncPath, destPath) {
    const ctx = await resolveAuth(session, userId);
    const root = webdavRoot(ctx.baseUrl, ctx.uid);
    // Build the WebDAV URL — encode each segment so spaces and unicode
    // characters survive the round-trip.
    const segments = String(ncPath || '').split('/').filter(Boolean).map(encodeURIComponent);
    const url = `${root}/${segments.join('/')}`;

    const res = await ctx.fetch(url, {
        method: 'GET',
        // Allow larger downloads; the connection itself stays bounded by ncFetch's timeout.
        signal: AbortSignal.timeout(15 * 60 * 1000),
    });

    if (res.status === 404) throw new Error(`File not found: ${ncPath}`);
    if (res.status === 401) throw new Error(ctx.authError || 'Nextcloud auth failed');
    if (!res.ok) throw new Error(`Nextcloud download failed (${res.status})`);

    const fs = require('fs');
    const { Readable } = require('stream');
    const { pipeline } = require('stream/promises');

    // Node's fetch returns a Web ReadableStream — convert to a Node stream
    // so .pipe() works and we don't keep the entire body in memory.
    const nodeStream = res.body && typeof Readable.fromWeb === 'function'
        ? Readable.fromWeb(res.body)
        : res.body;
    const out = fs.createWriteStream(destPath);
    await pipeline(nodeStream, out);

    const stat = fs.statSync(destPath);
    return {
        size: stat.size,
        contentType: res.headers.get('content-type') || 'application/octet-stream',
    };
}

module.exports = {
    isNextcloudOAuthSession,
    getBaseUrl,
    webdavRoot,
    refreshAccessToken,
    resolveUid,
    resolveAuth,
    resolveBasicAuthOrNull,
    ncFetch,
    downloadBinary,
    REQUEST_TIMEOUT_MS,
    CORS_AUTH_ERROR,
};
