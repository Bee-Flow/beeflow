/**
 * Meet Bot Engine — Playwright-based meeting recording bot.
 *
 * Dispatches to a platform-specific provider (Google Meet, Microsoft Teams,
 * Zoom) based on the meeting URL. Each provider is a module in
 * ./meetBotProviders/ exposing { platform, label, detect, validateUrl,
 * joinAndRecord, requiresCredentials }.
 *
 * All providers share the same audio-capture plumbing (PulseAudio null-sink
 * + FFmpeg) in ./meetBotProviders/shared.js.
 *
 * Requirements on server:
 *   - playwright + @playwright/browser-chromium
 *   - pulseaudio, pulseaudio-utils (pactl)
 *   - ffmpeg, xvfb
 */

const providers = [
    require('./meetBotProviders/google'),
    require('./meetBotProviders/teams'),
    require('./meetBotProviders/zoom'),
];

const activeSessions = new Map(); // sessionId → { context, ffmpegProcess, stopped }

/**
 * Detect which provider handles a given meeting URL. Returns null if no
 * provider claims it.
 */
function detectProvider(url) {
    if (!url) return null;
    for (const p of providers) {
        if (p.detect(url)) return p;
    }
    return null;
}

/**
 * Validate a meeting URL. Returns { valid, platform, label, error }.
 */
function validateMeetingUrl(url) {
    const provider = detectProvider(url);
    if (!provider) {
        return {
            valid: false,
            error: 'URL is not a Google Meet, Microsoft Teams, or Zoom meeting link.',
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
 * Join a meeting and record audio. Dispatches to the right provider based
 * on the URL. Returns { audioPath, durationSeconds, platform }.
 */
async function joinAndRecord(sessionId, meetLink, options = {}) {
    const provider = detectProvider(meetLink);
    if (!provider) {
        throw new Error('No provider matches this meeting URL (expected Google Meet, Teams, or Zoom).');
    }

    console.log(`[MeetBot] Session ${sessionId} → provider: ${provider.label}`);
    activeSessions.set(sessionId, { context: null, ffmpegProcess: null, stopped: false });

    const registerSession = ({ context, ffmpegProcess }) => {
        const current = activeSessions.get(sessionId) || {};
        activeSessions.set(sessionId, { ...current, context, ffmpegProcess });
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
 * List available platforms — used by the frontend to show what's supported
 * without hardcoding the list client-side.
 */
function listPlatforms() {
    return providers.map(p => ({
        platform: p.platform,
        label: p.label,
        requiresCredentials: !!p.requiresCredentials,
    }));
}

module.exports = {
    joinAndRecord,
    stopSession,
    isSessionActive,
    detectProvider,
    validateMeetingUrl,
    listPlatforms,
};
