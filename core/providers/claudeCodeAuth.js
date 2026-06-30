/**
 * Claude Code subscription (OAuth) auth — LOCAL DEV ONLY.
 *
 * Lets the local Bee Flow server authenticate the Claude provider with the OAuth
 * token that Claude Code mints for your Pro/Max subscription, instead of a
 * pay-per-token API key. It reads the same file Claude Code uses
 * (~/.claude/.credentials.json), refreshes the access token via the OAuth token
 * endpoint when it expires, and writes the rotated token back so Claude Code and
 * Bee Flow stay in sync.
 *
 * Enable with BEEFLOW_CLAUDE_CODE_OAUTH=1. OFF by default — and it MUST stay off
 * on any deployed / multi-tenant instance: serving other users from a personal
 * subscription token violates Anthropic's terms. This is a developer convenience
 * for your own machine only.
 *
 * macOS keychain storage is not supported here — point CLAUDE_CODE_CREDENTIALS_PATH
 * at a JSON file if your creds aren't on disk.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Public Claude Code OAuth client id + token endpoint. Overridable via env so a
// future change to either can be fixed without a code edit.
const CLIENT_ID = process.env.CLAUDE_CODE_OAUTH_CLIENT_ID
    || '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_URL = process.env.CLAUDE_CODE_OAUTH_TOKEN_URL
    || 'https://console.anthropic.com/v1/oauth/token';
// Refresh a little before the real expiry to avoid races with an in-flight request.
const REFRESH_SKEW_MS = 60_000;

function isEnabled() {
    return process.env.BEEFLOW_CLAUDE_CODE_OAUTH === '1';
}

function credentialsPath() {
    return process.env.CLAUDE_CODE_CREDENTIALS_PATH
        || path.join(os.homedir(), '.claude', '.credentials.json');
}

function readCreds() {
    const file = credentialsPath();
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        throw new Error(`[ClaudeCodeAuth] cannot read ${file} (${e.code}) — run \`claude\` and /login first`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`[ClaudeCodeAuth] ${file} is not valid JSON`);
    }
    const oauth = parsed.claudeAiOauth;
    if (!oauth || !oauth.accessToken) {
        throw new Error(`[ClaudeCodeAuth] no claudeAiOauth.accessToken in ${file} — re-run Claude Code /login`);
    }
    return { file, parsed, oauth };
}

/** True when the access token is expired or within the refresh skew window. */
function isExpired(oauth, now = Date.now()) {
    if (!oauth || typeof oauth.expiresAt !== 'number') return false; // unknown → assume usable
    return now >= oauth.expiresAt - REFRESH_SKEW_MS;
}

/** isExpired, but only when we actually have a refresh token to act on. */
function needsRefresh(oauth, now = Date.now()) {
    if (!oauth || !oauth.refreshToken) return false; // nothing to refresh with — use what we have
    return isExpired(oauth, now);
}

async function refresh(oauth) {
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: oauth.refreshToken,
            client_id: CLIENT_ID,
        }),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`[ClaudeCodeAuth] token refresh failed (${res.status}) — re-run Claude Code /login. ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    if (!data.access_token) {
        throw new Error('[ClaudeCodeAuth] refresh response had no access_token');
    }
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || oauth.refreshToken, // refresh tokens may rotate
        expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    };
}

function writeBack(file, parsed, next) {
    const merged = { ...parsed, claudeAiOauth: { ...parsed.claudeAiOauth, ...next } };
    fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
}

// Dedupe concurrent refreshes within this process so N in-flight requests trigger
// at most one token endpoint round-trip.
let inflight = null;

async function getAccessToken() {
    // 1) Dedicated long-lived token from `claude setup-token` — fully decoupled
    //    from the interactive Claude Code session (no file, no refresh, no rotation
    //    race). This is the preferred, most robust path.
    const dedicated = (process.env.CLAUDE_CODE_OAUTH_TOKEN || '').trim();
    if (dedicated) return dedicated;

    // 2) Shared Claude Code credentials file, read fresh every call. The creds
    //    DIRECTORY must be bind-mounted (not the single file) — Claude Code rewrites
    //    .credentials.json by atomic rename, and a single-file mount pins to the old
    //    inode and goes stale. By default we do NOT refresh here: a refresh rotates
    //    the refresh token and would break a concurrently-running `claude` session.
    //    Claude Code keeps the token fresh; we just read whatever it last wrote.
    const { file, parsed, oauth } = readCreds();
    if (!isExpired(oauth)) return oauth.accessToken;

    // Token is expired. Only refresh if explicitly opted in (i.e. you are NOT running
    // Claude Code at the same time) — otherwise tell the caller how to recover.
    if (process.env.CLAUDE_CODE_OAUTH_ALLOW_REFRESH === '1' && oauth.refreshToken) {
        if (!inflight) {
            inflight = (async () => {
                const next = await refresh(oauth);
                try { writeBack(file, parsed, next); }
                catch (e) { console.warn('[ClaudeCodeAuth] refreshed but could not persist (ro mount?):', e.message); }
                return next.accessToken;
            })().finally(() => { inflight = null; });
        }
        return inflight;
    }
    throw new Error(
        `[ClaudeCodeAuth] the Claude Code access token in ${file} is expired. ` +
        `Open/use Claude Code so it refreshes the token, OR set CLAUDE_CODE_OAUTH_TOKEN ` +
        `to a dedicated \`claude setup-token\` token, OR set CLAUDE_CODE_OAUTH_ALLOW_REFRESH=1 ` +
        `(only when you do not run Claude Code at the same time).`
    );
}

module.exports = {
    isEnabled,
    getAccessToken,
    isExpired,
    needsRefresh,
    credentialsPath,
    _internals: { readCreds, refresh, writeBack, CLIENT_ID, TOKEN_URL },
};
