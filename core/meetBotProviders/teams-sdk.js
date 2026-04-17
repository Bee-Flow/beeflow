/**
 * Microsoft Teams Bot SDK provider — joins Teams meetings without a browser.
 *
 * This is the officially supported server-side path for joining and recording
 * Teams meetings in Node.js. It uses Azure Communication Services (ACS) Call
 * Automation, which handles the WebRTC/SRTP media stack server-side so this
 * code does not need to implement Microsoft's proprietary media protocol.
 *
 * Requirements (checked at runtime; provider reports unavailable if missing):
 *   1. An Azure Communication Services resource with a connection string.
 *      Stored as secret:   acs_connection_string
 *   2. Teams/ACS interoperability enabled on the tenant (on by default for
 *      most M365 tenants; admin can verify in Teams admin center).
 *   3. A publicly reachable HTTPS callback URL for ACS event delivery.
 *      Stored as config:   teams_bot_callback_base_url
 *      Falls back to env:  SERVER_BASE_URL
 *
 * The Azure AD app (config.providers.microsoft) does NOT need to carry the
 * Calls.JoinGroupCall.All / Calls.AccessMedia.All permissions when ACS is
 * used — ACS itself authenticates the call on the tenant's behalf. Those
 * permissions ARE required when talking to Microsoft Graph's Communications
 * API directly (a separate, harder-to-implement path we don't take here).
 *
 * Flow:
 *   1. joinAndRecord() opens a CallAutomation connection into the Teams
 *      meeting and starts a server-side recording.
 *   2. ACS sends webhook callbacks to /api/teams-sdk-callback for state
 *      changes. The route calls handleAcsEvent() below to update the
 *      session map.
 *   3. When RecordingFileStatusUpdated arrives, we download the WAV from
 *      ACS's temporary storage onto local disk (and optionally mirror to
 *      RustFS via storageStore in the outer transcription pipeline).
 *   4. When CallDisconnected arrives, the pending promise resolves and the
 *      outer transcription pipeline kicks in just like any other provider.
 */

const fs = require('fs');
const path = require('path');
const configStore = require('../../stores/configStore');
const shared = require('./shared');

// Module-level map from serverCallId → session info.
// The webhook route looks up sessions here when ACS events arrive.
const sdkSessions = new Map();

function detect(url) {
    return /teams\.(microsoft|live)\.com/i.test(url);
}

function validateUrl(url) {
    return /teams\.(microsoft|live)\.com\/.*(meetup-join|meet)/i.test(url);
}

/**
 * Returns true when the ACS path is fully configured and usable. The
 * dispatcher checks this before picking this provider over the browser-based
 * fallback in teams.js.
 */
async function isConfigured() {
    try {
        const connStr = await configStore.getSecret('acs_connection_string');
        if (!connStr) return false;
        const callbackBase = await resolveCallbackBase();
        return !!callbackBase;
    } catch (_) {
        return false;
    }
}

async function resolveCallbackBase() {
    const fromConfig = await configStore.getConfig('teams_bot_callback_base_url');
    if (fromConfig) return fromConfig.replace(/\/+$/, '');
    if (process.env.SERVER_BASE_URL) return process.env.SERVER_BASE_URL.replace(/\/+$/, '');
    return null;
}

/**
 * Lazy-load the ACS SDK so the module keeps working in deployments where
 * the dependency isn't installed yet. We surface a clear error only when
 * the SDK provider is actually invoked.
 */
function loadAcsSdk() {
    try {
        return require('@azure/communication-call-automation');
    } catch (err) {
        throw new Error(
            '@azure/communication-call-automation is not installed. ' +
            'Run `npm install @azure/communication-call-automation` in server/.'
        );
    }
}

async function joinAndRecord(sessionId, meetLink, options = {}) {
    const {
        maxDurationMs = 3 * 60 * 60 * 1000,
        onStatusChange = () => {},
        registerSession,
        isStopped,
    } = options;

    const connStr = await configStore.getSecret('acs_connection_string');
    if (!connStr) throw new Error('ACS connection string not configured (set secret "acs_connection_string")');

    const callbackBase = await resolveCallbackBase();
    if (!callbackBase) throw new Error('teams_bot_callback_base_url not configured and SERVER_BASE_URL env is empty');

    const { CallAutomationClient, TeamsMeetingLinkLocator } = loadAcsSdk();

    const callbackUri = `${callbackBase}/api/teams-sdk-callback?sid=${encodeURIComponent(sessionId)}`;
    const audioPath = path.join(shared.recordingsDir, `teams-sdk-${sessionId}-${Date.now()}.wav`);

    onStatusChange('joining', { meetLink });
    console.log(`[MeetBot/TeamsSDK] Joining via ACS (callback=${callbackUri})`);

    const client = new CallAutomationClient(connStr);
    const joinResult = await client.joinCall(
        new TeamsMeetingLinkLocator(meetLink),
        callbackUri,
    );

    const callConnectionId = joinResult?.callConnectionProperties?.callConnectionId
        || joinResult?.callConnectionId;
    const serverCallId = joinResult?.callConnectionProperties?.serverCallId
        || joinResult?.serverCallId;

    if (!callConnectionId || !serverCallId) {
        throw new Error('ACS joinCall did not return callConnectionId/serverCallId');
    }

    // Track the session so the webhook handler can update it.
    const session = {
        sessionId,
        callConnectionId,
        serverCallId,
        client,
        audioPath,
        recordingStartTime: null,
        recordingId: null,
        recordingDownloaded: false,
        onStatusChange,
        resolve: null,
        reject: null,
    };
    sdkSessions.set(serverCallId, session);
    sdkSessions.set(callConnectionId, session); // some events carry only one id
    registerSession?.({ acsSession: session });

    // Stop-polling loop — checks isStopped and hangs up if the user stops the session.
    const stopPoller = setInterval(async () => {
        if (!isStopped?.()) return;
        console.log(`[MeetBot/TeamsSDK] Session ${sessionId} manually stopped — hanging up`);
        clearInterval(stopPoller);
        try {
            await client.getCallConnection(callConnectionId).hangUp(true);
        } catch (_) {}
    }, 2000);

    // Promise that resolves when the call disconnects OR max duration elapses.
    const durationSecondsRef = { value: 0 };
    try {
        await new Promise((resolve, reject) => {
            session.resolve = resolve;
            session.reject = reject;

            // Max duration safety net — ACS call ends automatically, but hang up defensively.
            const maxTimer = setTimeout(async () => {
                console.log(`[MeetBot/TeamsSDK] Session ${sessionId} hit max duration`);
                try { await client.getCallConnection(callConnectionId).hangUp(true); } catch (_) {}
                resolve();
            }, maxDurationMs);

            session._cleanup = () => {
                clearTimeout(maxTimer);
                clearInterval(stopPoller);
            };
        });
    } finally {
        clearInterval(stopPoller);
        sdkSessions.delete(serverCallId);
        sdkSessions.delete(callConnectionId);

        if (session.recordingStartTime) {
            durationSecondsRef.value = Math.round((Date.now() - session.recordingStartTime) / 1000);
        }
    }

    // If the recording file never landed, fail loudly so the pipeline creates a failed record.
    try {
        const stats = fs.statSync(audioPath);
        console.log(`[MeetBot/TeamsSDK] Recording saved: ${audioPath} (${(stats.size / 1024).toFixed(1)} KB)`);
    } catch {
        throw new Error('ACS recording did not arrive before call ended — check webhook delivery and ACS Call Recording permissions');
    }

    return { audioPath, durationSeconds: durationSecondsRef.value };
}

/**
 * Called by the webhook route for every ACS event. Dispatches on event type
 * and updates the matching session.
 *
 * Event shape (ACS EventGrid/Call Automation):
 *   { type: 'Microsoft.Communication.CallConnected', data: { callConnectionId, serverCallId, ... } }
 */
async function handleAcsEvent(event) {
    const data = event?.data || {};
    const key = data.serverCallId || data.callConnectionId;
    if (!key) return;

    const session = sdkSessions.get(key);
    if (!session) {
        console.log(`[MeetBot/TeamsSDK] Received event for unknown call (${key}): ${event.type}`);
        return;
    }

    const type = event.type || '';

    switch (type) {
        case 'Microsoft.Communication.CallConnected': {
            console.log(`[MeetBot/TeamsSDK] Session ${session.sessionId} connected`);
            session.onStatusChange?.('recording');
            session.recordingStartTime = Date.now();
            // Start recording now that we're connected.
            try {
                const callRecording = session.client.getCallRecording();
                const result = await callRecording.start({
                    callLocator: { id: session.serverCallId, kind: 'serverCallId' },
                    recordingContent: 'audio',
                    recordingChannel: 'mixed',
                    recordingFormat: 'wav',
                });
                session.recordingId = result?.recordingId;
                console.log(`[MeetBot/TeamsSDK] Recording started (recordingId=${session.recordingId})`);
            } catch (err) {
                console.error('[MeetBot/TeamsSDK] Failed to start recording:', err.message);
                session.reject?.(err);
            }
            break;
        }

        case 'Microsoft.Communication.RecordingStateChanged': {
            console.log(`[MeetBot/TeamsSDK] Recording state: ${data.state}`);
            break;
        }

        case 'Microsoft.Communication.RecordingFileStatusUpdated': {
            // The recording file(s) are ready to download.
            try {
                const chunks = data.recordingStorageInfo?.recordingChunks || [];
                if (chunks.length === 0) {
                    console.warn('[MeetBot/TeamsSDK] RecordingFileStatusUpdated with no chunks');
                    break;
                }
                const contentLocation = chunks[0].contentLocation;
                const deleteLocation = chunks[0].deleteLocation;
                const callRecording = session.client.getCallRecording();
                await callRecording.downloadToPath(contentLocation, session.audioPath);
                session.recordingDownloaded = true;
                console.log(`[MeetBot/TeamsSDK] Downloaded ${session.audioPath}`);
                // Clean up the file on ACS side so we don't leak storage.
                try { await callRecording.delete(deleteLocation); } catch (_) {}
            } catch (err) {
                console.error('[MeetBot/TeamsSDK] Recording download failed:', err.message);
            }
            break;
        }

        case 'Microsoft.Communication.CallDisconnected': {
            console.log(`[MeetBot/TeamsSDK] Session ${session.sessionId} disconnected`);
            session._cleanup?.();
            // Give ACS a moment to deliver the final RecordingFileStatusUpdated if it
            // hasn't already — in practice it usually arrives before CallDisconnected.
            setTimeout(() => session.resolve?.(), session.recordingDownloaded ? 0 : 10000);
            break;
        }

        default:
            // Quiet on unrelated event types.
            break;
    }
}

module.exports = {
    platform: 'teams-sdk',
    label: 'Teams (SDK)',
    detect,
    validateUrl,
    isConfigured,
    joinAndRecord,
    handleAcsEvent,
    requiresCredentials: false,
};
