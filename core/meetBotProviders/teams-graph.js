/**
 * Microsoft Teams provider — Graph post-meeting native transcripts & recordings.
 *
 * Instead of joining the meeting as a bot, this provider waits until Teams
 * itself finishes producing the server-side transcript (WebVTT) and/or
 * recording (mp4), then fetches them via the Microsoft Graph API using the
 * organiser's delegated token.
 *
 * Preconditions (enforced at runtime, surfaced to the user):
 *   1. The meeting organiser is signed into Beeflow via Microsoft OAuth.
 *   2. The organiser's tenant admin has consented to the Beeflow app for
 *      OnlineMeetings.Read + OnlineMeetingTranscript.Read.All +
 *      OnlineMeetingArtifact.Read.All.
 *   3. The meeting is calendar-backed (scheduled, not ad-hoc "Meet now").
 *   4. The host enabled recording and/or transcription in Teams.
 *
 * Result shape is dual-mode:
 *   - With a native transcript:  { vttPath, durationSeconds, nativeTranscript: true }
 *   - Recording only (no VTT):   { audioPath, durationSeconds } — caller falls
 *                                back to the Voxtral/Whisper pipeline.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const { graphFetch, isMicrosoftConnected } = require('../../integrations/msGraphClient');

const POLL_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_WAIT_MS = 4 * 60 * 60 * 1000; // 4 hours — transcripts can lag ~30min after meeting end

function detect(url) {
    return /teams\.(microsoft|live)\.com/i.test(url);
}

function validateUrl(url) {
    return /teams\.(microsoft|live)\.com\/.*(meetup-join|meet)/i.test(url);
}

async function resolveOnlineMeeting(session, meetLink) {
    // Graph expects the JoinWebUrl quoted with single quotes. Any single quote
    // inside the URL (exceedingly rare) must be doubled per OData.
    const filterValue = meetLink.replace(/'/g, "''");
    const response = await graphFetch(
        `/me/onlineMeetings?$filter=JoinWebUrl eq '${filterValue}'`,
        session,
    );
    const meeting = response?.value?.[0];
    if (!meeting) {
        const err = new Error("MEETING_NOT_FOUND_FOR_USER: We couldn't find this meeting in your Teams calendar. Only the organiser can use native Graph ingestion.");
        err.code = 'MEETING_NOT_FOUND_FOR_USER';
        throw err;
    }
    return meeting;
}

async function listArtifact(session, meetingId, kind) {
    // kind: 'transcripts' or 'recordings'
    try {
        const r = await graphFetch(
            `/me/onlineMeetings/${encodeURIComponent(meetingId)}/${kind}`,
            session,
        );
        return r?.value || [];
    } catch (err) {
        // Scope / consent issues surface here as 403.
        if (/403|Forbidden|insufficient/i.test(err.message)) {
            const e = new Error('INSUFFICIENT_SCOPE: Reconnect your Microsoft account to grant Meeting Transcripts & Recordings permissions.');
            e.code = 'INSUFFICIENT_SCOPE';
            throw e;
        }
        throw err;
    }
}

async function downloadContent(session, url, destPath) {
    // graphFetch handles auth + refresh; request raw body via Accept header.
    // We must treat the response as a stream, so reach for fetch directly
    // after graphFetch updated the access token on this session.
    const { GRAPH_BASE, refreshAccessToken } = require('../../integrations/msGraphClient');

    const fullUrl = url.startsWith('http') ? url : `${GRAPH_BASE}${url}`;
    let token = session.accessToken;

    const doFetch = async (t) => fetch(fullUrl, {
        headers: { Authorization: `Bearer ${t}`, Accept: '*/*' },
    });

    let resp = await doFetch(token);
    if (resp.status === 401) {
        token = await refreshAccessToken(session);
        resp = await doFetch(token);
    }
    if (!resp.ok) {
        throw new Error(`Graph content download failed: ${resp.status} ${await resp.text().catch(() => '')}`);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
    return buffer.length;
}

async function joinAndRecord(sessionId, meetLink, options = {}) {
    const {
        onStatusChange = () => {},
        isStopped = () => false,
        session,
        maxWaitMs = DEFAULT_MAX_WAIT_MS,
    } = options;

    if (!session || !isMicrosoftConnected(session)) {
        const e = new Error('NOT_CONNECTED: Connect your Microsoft account in settings to use Teams native ingestion.');
        e.code = 'NOT_CONNECTED';
        throw e;
    }

    onStatusChange('joining', { meetLink });
    console.log(`[MeetBot/TeamsGraph] Resolving onlineMeeting for ${meetLink}`);
    const meeting = await resolveOnlineMeeting(session, meetLink);
    const meetingId = meeting.id;
    console.log(`[MeetBot/TeamsGraph] Found meeting ${meetingId} (subject: "${meeting.subject || 'untitled'}")`);

    onStatusChange('waiting-for-teams-artifacts', { meetingId });

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        if (isStopped()) {
            const e = new Error('STOPPED_BY_USER');
            e.code = 'STOPPED_BY_USER';
            throw e;
        }

        // Fetch both in parallel each poll — cheap, and prevents a racy
        // "recording arrives first, transcript arrives on the next poll"
        // where we'd commit to the recording path prematurely.
        const [transcripts, recordings] = await Promise.all([
            listArtifact(session, meetingId, 'transcripts').catch(err => {
                if (err.code === 'INSUFFICIENT_SCOPE') throw err;
                console.warn(`[MeetBot/TeamsGraph] transcripts list failed: ${err.message}`);
                return [];
            }),
            listArtifact(session, meetingId, 'recordings').catch(err => {
                if (err.code === 'INSUFFICIENT_SCOPE') throw err;
                console.warn(`[MeetBot/TeamsGraph] recordings list failed: ${err.message}`);
                return [];
            }),
        ]);

        const transcript = transcripts.find(t => t.endDateTime);
        const recording = recordings.find(r => r.endDateTime);

        // Prefer native transcript. If present, take it and return.
        if (transcript) {
            const vttPath = path.join(shared.recordingsDir, `teams-graph-${sessionId}.vtt`);
            console.log(`[MeetBot/TeamsGraph] Downloading transcript ${transcript.id}`);
            const bytes = await downloadContent(
                session,
                `/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcript.id)}/content?$format=text/vtt`,
                vttPath,
            );
            console.log(`[MeetBot/TeamsGraph] Transcript saved (${bytes} bytes) to ${vttPath}`);

            // If a recording also exists, fetch it alongside so the user can
            // still replay the audio. It's optional — failures are non-fatal.
            let audioPath = null;
            if (recording) {
                try {
                    const mp4Path = path.join(shared.recordingsDir, `teams-graph-${sessionId}.mp4`);
                    await downloadContent(
                        session,
                        `/me/onlineMeetings/${encodeURIComponent(meetingId)}/recordings/${encodeURIComponent(recording.id)}/content`,
                        mp4Path,
                    );
                    audioPath = mp4Path;
                    console.log(`[MeetBot/TeamsGraph] Recording also saved to ${mp4Path}`);
                } catch (err) {
                    console.warn(`[MeetBot/TeamsGraph] Recording download failed (non-fatal): ${err.message}`);
                }
            }

            const durationSeconds = computeDuration(transcript, recording, meeting);
            return { vttPath, audioPath, durationSeconds, nativeTranscript: true };
        }

        // Fall back to recording-only path when only the mp4 is available.
        if (recording) {
            const mp4Path = path.join(shared.recordingsDir, `teams-graph-${sessionId}.mp4`);
            console.log(`[MeetBot/TeamsGraph] No transcript — downloading recording ${recording.id}`);
            const bytes = await downloadContent(
                session,
                `/me/onlineMeetings/${encodeURIComponent(meetingId)}/recordings/${encodeURIComponent(recording.id)}/content`,
                mp4Path,
            );
            console.log(`[MeetBot/TeamsGraph] Recording saved (${bytes} bytes) to ${mp4Path}`);

            const durationSeconds = computeDuration(null, recording, meeting);
            return { audioPath: mp4Path, durationSeconds };
        }

        // Neither ready yet — wait and poll again.
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }

    const e = new Error('TRANSCRIPT_NOT_AVAILABLE: Teams produced no recording or transcript within the wait window. Make sure the host clicked Start recording (and optionally Start transcription) during the meeting.');
    e.code = 'TRANSCRIPT_NOT_AVAILABLE';
    throw e;
}

function computeDuration(transcript, recording, meeting) {
    // Prefer the artifact's own window; fall back to the meeting envelope.
    const artifact = transcript || recording;
    if (artifact?.createdDateTime && artifact?.endDateTime) {
        const s = new Date(artifact.createdDateTime).getTime();
        const e = new Date(artifact.endDateTime).getTime();
        if (!isNaN(s) && !isNaN(e) && e > s) return Math.round((e - s) / 1000);
    }
    if (meeting?.startDateTime && meeting?.endDateTime) {
        const s = new Date(meeting.startDateTime).getTime();
        const e = new Date(meeting.endDateTime).getTime();
        if (!isNaN(s) && !isNaN(e) && e > s) return Math.round((e - s) / 1000);
    }
    return 0;
}

module.exports = {
    platform: 'teams-graph',
    label: 'Microsoft Teams',
    detect,
    validateUrl,
    joinAndRecord,
    requiresCredentials: false,
};
