/**
 * Email provider clients — session-LESS Gmail / Microsoft Graph access bound to
 * a stored, encrypted token blob (not a live req.session). Used by the tenant
 * Support inbox: connect a shared mailbox once, then a background worker syncs
 * and sends using the stored tokens with automatic refresh + write-back.
 *
 * Patterns mirror server/services/ticketAssistantSyncEngine.js (Gmail OAuth2
 * `tokens` event; Graph 401→refresh) but are decoupled from any store: callers
 * pass a `tokens` object + an `onRefresh(updatedTokens)` callback so the same
 * helpers work for support_inboxes today and anything else later.
 *
 * Token blob shape: { accessToken, refreshToken, scope?, expiryDate? }.
 */

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Mailbox-scoped consent — least privilege for a service connection.
const GOOGLE_SCOPES = [
    'openid', 'email',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
];
const MS_SCOPES = ['openid', 'email', 'profile', 'offline_access', 'Mail.Read', 'Mail.Send'];

async function googleProviderConfig() {
    const { loadConfig } = require('../../auth/permissions');
    const cfg = await loadConfig();
    const pc = cfg.providers?.google || {};
    if (!pc.clientId || !pc.clientSecret) throw new Error('Google OAuth is not configured on this server.');
    return pc;
}

async function microsoftProviderConfig() {
    const { loadConfig } = require('../../auth/permissions');
    const cfg = await loadConfig();
    const pc = cfg.providers?.microsoft || {};
    if (!pc.clientId || !pc.clientSecret) throw new Error('Microsoft OAuth is not configured on this server.');
    return pc;
}

// ── Consent URL builders (dedicated, distinct redirect_uri from login) ───────

async function buildAuthUrl(provider, { redirectUri, state }) {
    if (provider === 'gmail') {
        const pc = await googleProviderConfig();
        const params = new URLSearchParams({
            client_id: pc.clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            // offline + consent forces a refresh_token even on re-consent — without
            // it Google omits the refresh_token and the connection dies at expiry.
            access_type: 'offline',
            prompt: 'consent',
            include_granted_scopes: 'true',
            scope: GOOGLE_SCOPES.join(' '),
            state,
        });
        return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }
    if (provider === 'outlook') {
        const pc = await microsoftProviderConfig();
        const tenantId = pc.tenantId || 'common';
        const params = new URLSearchParams({
            client_id: pc.clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            response_mode: 'query',
            scope: MS_SCOPES.join(' '),
            state,
            prompt: 'consent',
        });
        return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
    }
    throw new Error(`Unknown provider: ${provider}`);
}

// ── Authorization-code exchange + mailbox identity ───────────────────────────

async function exchangeCode(provider, { code, redirectUri }) {
    if (provider === 'gmail') {
        const { google } = require('googleapis');
        const pc = await googleProviderConfig();
        const oauth2 = new google.auth.OAuth2(pc.clientId, pc.clientSecret, redirectUri);
        const { tokens } = await oauth2.getToken(code);
        if (!tokens.refresh_token) {
            throw new Error('Google did not return a refresh token. Disconnect any prior grant for this mailbox and reconnect (consent screen must be shown).');
        }
        const blob = {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            scope: tokens.scope || GOOGLE_SCOPES.join(' '),
            expiryDate: tokens.expiry_date || null,
        };
        oauth2.setCredentials({ access_token: blob.accessToken, refresh_token: blob.refreshToken });
        const gmail = google.gmail({ version: 'v1', auth: oauth2 });
        const profile = await gmail.users.getProfile({ userId: 'me' });
        return { tokens: blob, emailAddress: (profile.data.emailAddress || '').toLowerCase() };
    }
    if (provider === 'outlook') {
        const pc = await microsoftProviderConfig();
        const tenantId = pc.tenantId || 'common';
        const resp = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri,
                client_id: pc.clientId,
                client_secret: pc.clientSecret,
                scope: MS_SCOPES.join(' '),
            }).toString(),
        });
        if (!resp.ok) {
            const t = await resp.text().catch(() => '');
            throw new Error(`Microsoft token exchange failed: ${resp.status} ${t.slice(0, 200)}`);
        }
        const td = await resp.json();
        if (!td.refresh_token) throw new Error('Microsoft did not return a refresh token (offline_access scope required).');
        const blob = {
            accessToken: td.access_token,
            refreshToken: td.refresh_token,
            scope: td.scope || MS_SCOPES.join(' '),
            expiryDate: td.expires_in ? Date.now() + td.expires_in * 1000 : null,
        };
        const me = await graphFetchFromTokens(blob, null, '/me?$select=mail,userPrincipalName');
        const email = (me.mail || me.userPrincipalName || '').toLowerCase();
        return { tokens: blob, emailAddress: email };
    }
    throw new Error(`Unknown provider: ${provider}`);
}

// ── Authenticated clients (auto-refresh + write-back) ────────────────────────

/**
 * Build a googleapis Gmail client from a stored token blob. Refreshed tokens
 * are written back through onRefresh(updatedBlob).
 */
async function gmailClientFromTokens(tokens, onRefresh) {
    const { google } = require('googleapis');
    const pc = await googleProviderConfig();
    if (!tokens || !tokens.accessToken) throw new Error('No valid Google tokens — reconnect the mailbox.');
    const oauth2 = new google.auth.OAuth2(pc.clientId, pc.clientSecret);
    oauth2.setCredentials({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken });
    oauth2.on('tokens', async (nt) => {
        const updated = { ...tokens };
        if (nt.access_token) updated.accessToken = nt.access_token;
        if (nt.refresh_token) updated.refreshToken = nt.refresh_token;
        if (nt.expiry_date) updated.expiryDate = nt.expiry_date;
        try { await onRefresh?.(updated); } catch (e) { console.warn('[email] gmail token write-back failed:', e.message); }
    });
    return google.gmail({ version: 'v1', auth: oauth2 });
}

/**
 * Session-less Microsoft Graph fetch from a stored token blob, retrying once on
 * 401 with a refresh + write-back. `tokens` is mutated in place on refresh so a
 * sequence of calls in one tick reuses the fresh access token.
 */
async function graphFetchFromTokens(tokens, onRefresh, path, opts = {}) {
    const pc = await microsoftProviderConfig();
    if (!tokens || !tokens.accessToken) throw new Error('No valid Microsoft tokens — reconnect the mailbox.');
    const doFetch = (token) => fetch(path.startsWith('http') ? path : `${GRAPH_BASE}${path}`, {
        ...opts,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(opts.headers || {}),
        },
    });
    let resp = await doFetch(tokens.accessToken);
    if (resp.status === 401 && tokens.refreshToken) {
        const tenantId = pc.tenantId || 'common';
        const tokenResp = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: tokens.refreshToken,
                client_id: pc.clientId,
                client_secret: pc.clientSecret,
                scope: MS_SCOPES.join(' '),
            }).toString(),
        });
        if (!tokenResp.ok) {
            const t = await tokenResp.text().catch(() => '');
            throw new Error(`Microsoft token refresh failed: ${tokenResp.status} ${t.slice(0, 200)} — reconnect the mailbox.`);
        }
        const td = await tokenResp.json();
        tokens.accessToken = td.access_token;
        if (td.refresh_token) tokens.refreshToken = td.refresh_token;
        if (td.expires_in) tokens.expiryDate = Date.now() + td.expires_in * 1000;
        try { await onRefresh?.({ ...tokens }); } catch (e) { console.warn('[email] graph token write-back failed:', e.message); }
        resp = await doFetch(tokens.accessToken);
    }
    if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        throw new Error(`Graph API ${resp.status}: ${t.slice(0, 200)}`);
    }
    // 202 Accepted (sendMail/send) and 204 No Content carry no JSON body.
    if (resp.status === 202 || resp.status === 204) return {};
    const text = await resp.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { return {}; }
}

module.exports = {
    GOOGLE_SCOPES,
    MS_SCOPES,
    GRAPH_BASE,
    buildAuthUrl,
    exchangeCode,
    gmailClientFromTokens,
    graphFetchFromTokens,
};
