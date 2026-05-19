/**
 * Google API Client — Shared helper for Google integrations
 *
 * Provides an authenticated fetch wrapper for Google REST APIs (Drive,
 * Calendar, Gmail, …). Pattern mirrors `msGraphClient.js`:
 *   - Reads access token from session
 *   - Auto-refreshes once via refresh_token on 401 / token_expired
 *   - Re-issues the request transparently
 *
 * Without this, long-running automations that touch Google APIs silently
 * stop working ~1 hour after each user re-auth.
 */

const { loadConfig } = require('../auth/permissions');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/**
 * Exchange the session's refresh_token for a fresh access_token. Updates the
 * session in place and persists via session.save() so the new token survives
 * across requests. Throws on missing refresh token or non-2xx from Google.
 */
async function refreshAccessToken(session) {
    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};

    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Google OAuth not configured');
    }

    const refreshToken = session?.refreshToken;
    if (!refreshToken) {
        throw new Error('No refresh token available — user must re-authenticate with Google');
    }

    const response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: providerConfig.clientId,
            client_secret: providerConfig.clientSecret,
        }).toString(),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error('[Google] Token refresh failed:', errorText);
        throw new Error('Google token refresh failed — user must re-authenticate');
    }

    const tokenData = await response.json();

    if (tokenData.access_token) {
        session.accessToken = tokenData.access_token;
    }
    // Google only rotates refresh tokens on demand (?prompt=consent); keep the
    // existing one when the response omits it.
    if (tokenData.refresh_token) {
        session.refreshToken = tokenData.refresh_token;
    }
    session.save?.();

    return tokenData.access_token;
}

/**
 * Authenticated fetch against a Google REST endpoint. Retries once with a
 * refreshed token on 401. Mirrors `msGraphClient.graphFetch`.
 */
async function googleFetch(url, session, options = {}) {
    if (!session?.accessToken) {
        throw new Error('NOT_CONNECTED');
    }

    const doFetch = async (token) => {
        const headers = {
            'Authorization': `Bearer ${token}`,
            ...(options.headers || {}),
        };
        if (options.body && !headers['Content-Type'] && typeof options.body === 'string') {
            headers['Content-Type'] = 'application/json';
        }
        return fetch(url, { ...options, headers });
    };

    let response = await doFetch(session.accessToken);

    if (response.status === 401) {
        try {
            const newToken = await refreshAccessToken(session);
            response = await doFetch(newToken);
        } catch (refreshErr) {
            console.error('[Google] Token refresh failed:', refreshErr.message);
            throw new Error('NOT_CONNECTED');
        }
    }

    if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        let errorMsg = `Google API error: ${response.status}`;
        try {
            const parsed = JSON.parse(errorBody);
            errorMsg = parsed.error?.message || parsed.error_description || errorMsg;
        } catch (_) { /* non-JSON */ }
        throw new Error(errorMsg);
    }

    if (response.status === 202 || response.status === 204) {
        return { success: true };
    }

    const ct = response.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
        return await response.json();
    }
    return await response.text();
}

/**
 * Revoke a Google access/refresh token at Google's revoke endpoint.
 * Best-effort: a non-2xx response is logged but not thrown, since the
 * caller usually wants to delete local state regardless.
 */
async function revokeToken(token) {
    if (!token) return false;
    try {
        const r = await fetch(GOOGLE_REVOKE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token }).toString(),
        });
        return r.ok;
    } catch (e) {
        console.warn('[Google] revoke failed:', e.message);
        return false;
    }
}

function isGoogleConnected(session) {
    return !!(session?.accessToken && session?.oauthProvider === 'google');
}

module.exports = {
    googleFetch,
    refreshAccessToken,
    revokeToken,
    isGoogleConnected,
    GOOGLE_TOKEN_URL,
    GOOGLE_REVOKE_URL,
};
