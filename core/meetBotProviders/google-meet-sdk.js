/**
 * Google Meet Media API provider — joins Meet calls without a browser.
 *
 * Officially supported server-side path for receiving media from a Google
 * Meet conference. Uses:
 *   - OAuth 2.0 user credentials (authorization-code flow with a stored
 *     refresh token). The Meet Media scope is NOT DWD-compatible — only a
 *     real Google user identity that has been invited to the meeting can
 *     connect. The admin authorises a dedicated bot account (e.g.
 *     meetingnotes@yourdomain.com) once via consent; the refresh token is
 *     stored and used to mint access tokens on each join.
 *   - The Meet REST API v2 to resolve a meeting code to a space resource.
 *   - The Meet Media API v2beta `:connectActiveConference` endpoint for the
 *     single HTTP step that exchanges an SDP offer for an answer.
 *   - @roamhq/wrtc to run a native Node.js WebRTC peer connection that
 *     receives the resulting audio streams.
 *   - RTCAudioSink → ffmpeg stdin to encode the raw PCM into a .webm file
 *     compatible with the rest of the transcription pipeline.
 *
 * Requirements checked at runtime (provider reports unavailable if any are
 * missing so the dispatcher falls back to the Playwright `google` provider):
 *   1. Secrets `google_meet_oauth_client_id` + `google_meet_oauth_client_secret`
 *      — OAuth client (Desktop or Web) with the Meet scopes enabled.
 *   2. Secret `google_meet_oauth_refresh_token` — minted via the consent
 *      flow at /api/meet-bot/google-oauth/start.
 *   3. `@roamhq/wrtc` native module installed and loadable.
 *   4. Workspace admin has enabled the Media API in Meet safety settings
 *      (not checkable from code — surfaced in docs/admin UI text).
 *
 * Known limits (documented, not fixed here):
 *   - Speaker attribution from the `media-entries` data channel isn't
 *     decoded yet; recorded audio is a mix, not per-speaker streams.
 *   - Requires an ACTIVE conference to connect — the bot can't join an
 *     empty space before anyone dials in.
 *   - Video is not captured; audio-only recording mirrors the other
 *     providers in this project.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

const configStore = require('../../stores/configStore');
const shared = require('./shared');

const MEET_OAUTH_SCOPES = [
    'https://www.googleapis.com/auth/meetings.conference.media.readonly',
    'https://www.googleapis.com/auth/meetings.space.readonly',
    'openid',
    'email',
];

// Meet REST API v2 — used to resolve a meeting code (abc-defg-hij) to a
// canonical space resource (spaces/{id}).
const MEET_REST_BASE = 'https://meet.googleapis.com/v2';
// Meet Media API v2beta — the single connect endpoint we need.
const MEET_MEDIA_BASE = 'https://meet.googleapis.com/v2beta';

function detect(url) {
    return /meet\.google\.com/i.test(url);
}

function validateUrl(url) {
    return /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(url);
}

/**
 * Parse a meeting URL like https://meet.google.com/abc-defg-hij and return
 * just the 10-char meeting code. Throws if the URL doesn't match the shape
 * of a public-facing Meet link.
 */
function extractMeetingCode(url) {
    const m = String(url || '').match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
    if (!m) throw new Error('Could not extract Google Meet code from URL');
    return m[1].toLowerCase();
}

async function loadOAuthConfig() {
    const [clientId, clientSecret, refreshToken] = await Promise.all([
        configStore.getSecret('google_meet_oauth_client_id'),
        configStore.getSecret('google_meet_oauth_client_secret'),
        configStore.getSecret('google_meet_oauth_refresh_token'),
    ]);
    return {
        clientId: clientId || null,
        clientSecret: clientSecret || null,
        refreshToken: refreshToken || null,
    };
}

async function isConfigured() {
    try {
        const { clientId, clientSecret, refreshToken } = await loadOAuthConfig();
        if (!clientId || !clientSecret || !refreshToken) return false;
        try { require('@roamhq/wrtc'); } catch { return false; }
        return true;
    } catch (_) { return false; }
}

/**
 * Build a google-auth-library OAuth2 client seeded with the stored refresh
 * token. Callers can `client.getAccessToken()` to mint a fresh bearer, and
 * the library handles refresh automatically.
 */
async function getOAuth2Client() {
    const { OAuth2Client } = require('google-auth-library');
    const { clientId, clientSecret, refreshToken } = await loadOAuthConfig();
    if (!clientId || !clientSecret) throw new Error('Google Meet OAuth client not configured');
    if (!refreshToken) throw new Error('Google Meet OAuth refresh token not configured — admin must complete consent flow');

    const client = new OAuth2Client({ clientId, clientSecret });
    client.setCredentials({ refresh_token: refreshToken });
    return client;
}

async function getAccessToken() {
    const client = await getOAuth2Client();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('Failed to mint Google access token (refresh_token may be expired or revoked — re-authorise)');
    return { accessToken: token, scopes: MEET_OAUTH_SCOPES };
}

/**
 * Resolve a meeting code to a space resource name (spaces/{id}).
 * The v2 API accepts the meeting code as the `name` path segment.
 */
async function resolveSpaceName(meetingCode, token) {
    const url = `${MEET_REST_BASE}/spaces/${encodeURIComponent(meetingCode)}`;
    const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Meet spaces.get failed (${resp.status}): ${body.slice(0, 500)}`);
    }
    const space = await resp.json();
    if (!space?.name) throw new Error('Meet spaces.get returned no name');
    return space.name; // e.g. "spaces/abc123xyz"
}

/**
 * Build a Meet Media recvonly RTCPeerConnection and return it along with
 * the data channels the service requires. Channels MUST be created before
 * the first createOffer so they appear in the SDP in the right order.
 */
function buildPeerConnection(wrtc) {
    const { RTCPeerConnection } = wrtc;
    const pc = new RTCPeerConnection({
        bundlePolicy: 'max-bundle',
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    // Add 3 recvonly audio transceivers (Meet mixes all audio into 3 SSRCs).
    for (let i = 0; i < 3; i++) {
        pc.addTransceiver('audio', { direction: 'recvonly' });
    }

    // Required data channels — Meet enforces ordering audio → data → video
    // in SDP, but within the "data" block the channel order also matters for
    // DTLS SCTP stream IDs. session-control + media-stats are always required.
    const channels = {
        sessionControl: pc.createDataChannel('session-control', { ordered: true }),
        mediaStats: pc.createDataChannel('media-stats', { ordered: true }),
        mediaEntries: pc.createDataChannel('media-entries', { ordered: true }),
        participants: pc.createDataChannel('participants', { ordered: true }),
    };

    return { pc, channels };
}

/**
 * Start an ffmpeg process that reads raw s16le PCM from stdin and writes
 * a webm/opus file. Matches the format produced by the other providers so
 * the transcription pipeline doesn't need special-casing.
 */
function startFfmpegPcmRecorder(outputPath, sampleRate, channels) {
    const ff = spawn(ffmpegInstaller.path, [
        '-hide_banner', '-loglevel', 'warning',
        '-f', 's16le',
        '-ar', String(sampleRate),
        '-ac', String(channels),
        '-i', 'pipe:0',
        '-c:a', 'libopus',
        '-b:a', '96k',
        '-application', 'voip',
        '-vn',
        outputPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    ff.stderr.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg && !msg.startsWith('size=')) console.log(`[MeetBot/GoogleSDK/FFmpeg] ${msg.substring(0, 200)}`);
    });
    ff.on('error', (e) => console.error(`[MeetBot/GoogleSDK/FFmpeg] ${e.message}`));
    return ff;
}

async function joinAndRecord(sessionId, meetLink, options = {}) {
    const {
        maxDurationMs = 3 * 60 * 60 * 1000,
        onStatusChange = () => {},
        registerSession,
        isStopped,
    } = options;

    const wrtc = require('@roamhq/wrtc');

    const meetingCode = extractMeetingCode(meetLink);
    const audioPath = path.join(shared.recordingsDir, `google-sdk-${sessionId}-${Date.now()}.webm`);

    onStatusChange('joining', { meetLink });
    console.log(`[MeetBot/GoogleSDK] Joining meeting code ${meetingCode} via Media API`);

    // 1. OAuth token
    const { accessToken, scopes } = await getAccessToken();
    console.log(`[MeetBot/GoogleSDK] OAuth token minted (scopes: ${scopes.join(', ')})`);

    // 2. Resolve meeting code → space resource
    const spaceName = await resolveSpaceName(meetingCode, accessToken);
    console.log(`[MeetBot/GoogleSDK] Resolved space: ${spaceName}`);

    // 3. Build PC + data channels
    const { pc, channels } = buildPeerConnection(wrtc);

    // Per Meet Media API spec: two-pass SDP. First pass locks audio+data
    // ordering, then video transceivers are added (we skip video but still
    // create the offer once — the spec allows audio-only clients to do one
    // pass if no video transceivers will be added).
    await pc.setLocalDescription(await pc.createOffer());

    // Wait a tick for ICE gathering to start so the SDP we send has
    // candidates. Meet accepts trickle-less or trickle ICE; we do the
    // simpler trickle-less path by waiting for gathering to complete.
    await new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve();
        const timer = setTimeout(resolve, 4000);
        pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
        };
    });

    // 4. POST offer to :connectActiveConference, get answer
    const connectUrl = `${MEET_MEDIA_BASE}/${spaceName}:connectActiveConference`;
    const connectResp = await fetch(connectUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ offer: pc.localDescription.sdp }),
    });
    if (!connectResp.ok) {
        const body = await connectResp.text().catch(() => '');
        try { pc.close(); } catch (_) {}
        throw new Error(`connectActiveConference failed (${connectResp.status}): ${body.slice(0, 500)}`);
    }
    const { answer } = await connectResp.json();
    if (!answer) {
        try { pc.close(); } catch (_) {}
        throw new Error('connectActiveConference returned no answer SDP');
    }

    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    console.log('[MeetBot/GoogleSDK] WebRTC offer/answer complete — awaiting ICE');

    // 5. Wire up incoming audio → ffmpeg
    const { nonstandard } = wrtc;
    if (!nonstandard?.RTCAudioSink) {
        try { pc.close(); } catch (_) {}
        throw new Error('@roamhq/wrtc build is missing RTCAudioSink (nonstandard API) — cannot record audio');
    }

    // Meet sends 48kHz stereo audio samples on each of the 3 mixed tracks.
    // We open one ffmpeg process per track, but write to the SAME output
    // file via an amix filter would require a more complex pipeline.
    // Simpler: use a single ffmpeg and pipe the sum of all sinks into it.
    // Since RTCAudioSink returns frames per-track, we pick the first
    // connected track as primary and ignore the others for now — Meet
    // already mixes all speakers into each of the three SSRCs, so picking
    // one gives us the full conversation.
    const SAMPLE_RATE = 48000;
    const CHANNELS = 2;
    let ff = null;
    const sinks = [];

    pc.ontrack = (event) => {
        const track = event.track;
        if (track.kind !== 'audio') return;
        if (sinks.length > 0) {
            // Meet provides 3 mixed tracks; we only need one for the
            // combined audio. Keep a no-op sink so the track stays alive.
            try { new nonstandard.RTCAudioSink(track); } catch (_) {}
            return;
        }
        console.log(`[MeetBot/GoogleSDK] Primary audio track received (${track.id})`);
        if (!ff) ff = startFfmpegPcmRecorder(audioPath, SAMPLE_RATE, CHANNELS);
        const sink = new nonstandard.RTCAudioSink(track);
        sink.ondata = (frame) => {
            // frame.samples is an Int16Array of interleaved PCM
            try {
                if (ff?.stdin?.writable) ff.stdin.write(Buffer.from(frame.samples.buffer, frame.samples.byteOffset, frame.samples.byteLength));
            } catch (_) {}
        };
        sinks.push(sink);
    };

    // 6. Send JOINED signal on session-control when it opens
    await new Promise((resolve) => {
        if (channels.sessionControl.readyState === 'open') return resolve();
        channels.sessionControl.onopen = () => resolve();
        setTimeout(resolve, 8000); // don't block forever
    });
    try {
        channels.sessionControl.send(JSON.stringify({ status: 'JOINED' }));
    } catch (e) {
        console.warn('[MeetBot/GoogleSDK] session-control send failed:', e.message);
    }
    onStatusChange('recording', { meetLink });
    console.log('[MeetBot/GoogleSDK] Session-control JOINED sent');

    const recordingStartTime = Date.now();
    registerSession?.({ googleSdk: { pc, ff, sinks } });

    // 7. Wait for meeting end (session-control "LEFT" / conn close / timeout / manual stop)
    let durationSeconds = 0;
    try {
        await new Promise((resolve) => {
            let done = false;
            const finish = () => { if (done) return; done = true; resolve(); };

            const maxTimer = setTimeout(() => { console.log('[MeetBot/GoogleSDK] Max duration reached'); finish(); }, maxDurationMs);

            pc.oniceconnectionstatechange = () => {
                const s = pc.iceConnectionState;
                if (s === 'disconnected' || s === 'failed' || s === 'closed') {
                    console.log(`[MeetBot/GoogleSDK] ICE state → ${s}, ending recording`);
                    clearTimeout(maxTimer);
                    finish();
                }
            };

            channels.sessionControl.onmessage = (evt) => {
                try {
                    const data = typeof evt.data === 'string' ? JSON.parse(evt.data) : null;
                    if (data?.status === 'LEFT' || data?.status === 'ENDED' || data?.status === 'KICKED') {
                        console.log(`[MeetBot/GoogleSDK] session-control → ${data.status}`);
                        clearTimeout(maxTimer);
                        finish();
                    }
                } catch (_) {}
            };

            const stopPoll = setInterval(() => {
                if (isStopped?.()) {
                    console.log('[MeetBot/GoogleSDK] Session manually stopped');
                    clearInterval(stopPoll);
                    clearTimeout(maxTimer);
                    finish();
                }
            }, 2000);
        });
    } finally {
        durationSeconds = Math.round((Date.now() - recordingStartTime) / 1000);
        // Close sinks, peer, ffmpeg.
        for (const s of sinks) { try { s.stop(); } catch (_) {} }
        try { pc.close(); } catch (_) {}
        if (ff?.stdin) {
            try { ff.stdin.end(); } catch (_) {}
        }
        await new Promise((r) => {
            if (!ff) return r();
            ff.on('close', r);
            setTimeout(r, 5000);
        });
    }

    try {
        const stats = fs.statSync(audioPath);
        console.log(`[MeetBot/GoogleSDK] Recording saved: ${audioPath} (${(stats.size / 1024).toFixed(1)} KB)`);
    } catch (e) {
        throw new Error(`Recording file missing after session: ${e.message}`);
    }

    return { audioPath, durationSeconds };
}

module.exports = {
    platform: 'google-meet-sdk',
    label: 'Google Meet (SDK)',
    detect,
    validateUrl,
    isConfigured,
    joinAndRecord,
    requiresCredentials: false,
    // Exposed for the OAuth consent-flow routes in server/routes/meetBot.js
    OAUTH_SCOPES: MEET_OAUTH_SCOPES,
    loadOAuthConfig,
};
