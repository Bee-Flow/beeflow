/**
 * Meet Bot Engine — dispatches to a platform-specific provider based on the
 * meeting URL.
 *
 * Providers live in ./meetBotProviders/ and expose:
 *   { platform, label, detect, validateUrl, joinAndRecord,
 *     requiresCredentials, isConfigured? }
 *
 * Priority rules when multiple providers claim the same URL:
 *   - google-meet-sdk takes precedence over google when OAuth is configured
 *     (uses the official Meet Media API, no browser).
 *   - Teams uses a single Graph-native provider (fetches server-side
 *     transcripts/recordings the organiser's token has access to).
 */

const googleProvider = require('./meetBotProviders/google');
const googleMeetSdkProvider = require('./meetBotProviders/google-meet-sdk');
const teamsGraphProvider = require('./meetBotProviders/teams-graph');
const zoomProvider = require('./meetBotProviders/zoom');
const nextcloudTalkProvider = require('./meetBotProviders/nextcloud-talk');

// Order matters: earlier providers are considered first. SDK/Graph providers
// go before browser-based counterparts so we prefer the official media/API
// path when configured. Teams is Graph-only (own-meetings flow) — no
// Playwright fallback.
const providers = [
    googleMeetSdkProvider,
    googleProvider,
    teamsGraphProvider,
    zoomProvider,
    nextcloudTalkProvider,
];

const activeSessions = new Map(); // sessionId → { context, audioCapture, stopped }

/**
 * Detect which provider handles a given URL. Honours async `isConfigured()`
 * so providers that need extra setup (ACS) can opt out when not ready.
 */
async function detectProvider(url) {
    if (!url) return null;
    for (const p of providers) {
        if (!p.detect(url)) continue;
        if (typeof p.isConfigured === 'function') {
            try {
                if (!(await p.isConfigured())) continue;
            } catch (_) { continue; }
        }
        return p;
    }
    return null;
}

/**
 * Validate a meeting URL. Returns { valid, platform, label, error }.
 */
async function validateMeetingUrl(url) {
    const provider = await detectProvider(url);
    if (!provider) {
        return {
            valid: false,
            error: 'URL is not a Google Meet, Microsoft Teams, Zoom, or Nextcloud Talk meeting link.',
        };
    }
    if (!provider.validateUrl(url)) {
        return {
            valid: false,
            platform: provider.platform,
            label: provider.label,
            error: `URL looks like a ${provider.label} link but doesn't match the expected meeting-URL format.`,
        };
    }
    return { valid: true, platform: provider.platform, label: provider.label };
}

/**
 * Join a meeting and record. Dispatches to the right provider. Returns
 * { audioPath, durationSeconds, platform }.
 */
async function joinAndRecord(sessionId, meetLink, options = {}) {
    const provider = await detectProvider(meetLink);
    if (!provider) {
        throw new Error('No provider matches this meeting URL (expected Google Meet, Teams, Zoom, or Nextcloud Talk).');
    }

    console.log(`[MeetBot] Session ${sessionId} → provider: ${provider.label}`);
    activeSessions.set(sessionId, { context: null, audioCapture: null, stopped: false });

    const registerSession = (fields) => {
        const current = activeSessions.get(sessionId) || {};
        activeSessions.set(sessionId, { ...current, ...fields });
    };
    const isStopped = () => {
        const s = activeSessions.get(sessionId);
        return !s || s.stopped;
    };

    try {
        const result = await provider.joinAndRecord(sessionId, meetLink, {
            ...options,
            registerSession,
            isStopped,
        });
        return { ...result, platform: provider.platform };
    } finally {
        activeSessions.delete(sessionId);
    }
}

function stopSession(sessionId) {
    const session = activeSessions.get(sessionId);
    if (session) {
        session.stopped = true;
        console.log(`[MeetBot] Marked session ${sessionId} for stop`);
        return true;
    }
    return false;
}

function isSessionActive(sessionId) {
    return activeSessions.has(sessionId);
}

/**
 * List supported platforms with their configuration status. The frontend
 * uses this to show what's available without hardcoding the matrix.
 */
async function listPlatforms() {
    const out = [];
    for (const p of providers) {
        const configured = typeof p.isConfigured === 'function' ? await p.isConfigured() : true;
        out.push({
            platform: p.platform,
            label: p.label,
            requiresCredentials: !!p.requiresCredentials,
            configured,
        });
    }
    return out;
}

module.exports = {
    joinAndRecord,
    stopSession,
    isSessionActive,
    detectProvider,
    validateMeetingUrl,
    listPlatforms,
};
