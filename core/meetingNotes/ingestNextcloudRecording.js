/**
 * ingestNextcloudRecording — download a recording from Nextcloud Files and
 * run it through Bee Flow's own transcription pipeline (the tenant's
 * configured provider), producing a Meeting Note with transcript, diarized
 * speakers, summary, AI title and action items.
 *
 * This is the single shared entry point used by BOTH:
 *   - the HTTP route `POST /api/transcriptions/from-nextcloud` (manual import)
 *   - the background Nextcloud Talk auto-ingest (`talkAutoIngest.js`)
 *
 * Auth is delegated to `nextcloudClient.resolveAuth(session, userId)`, so it
 * works transparently for OAuth, app-password and ExApp-connector sessions —
 * including the connector pseudo-session built by `triggerBus.loadSession`
 * in a background context (no live request).
 */

const fs = require('fs');
const path = require('path');

const transcriptionStore = require('../../stores/transcriptionStore');
const configStore = require('../../stores/configStore');
const {
    transcribeWithWhisperX,
    identifySpeakerNames,
    generateMeetingSummary,
    generateMeetingTitle,
    extractActionItems,
    buildTranscriptArtifacts,
    formatTime,
} = require('./summaryHelpers');

// Audio + (Talk) video container extensions we can hand to a provider. Talk
// records audio as .ogg and video as .mp4/.webm/.ogv/.mkv.
const ACCEPTED_RECORDING_EXTS = ['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.flac', '.mp4', '.mpeg', '.aac', '.ogv', '.mkv'];

// Hard ceiling — matches the manual-upload multer limit. Larger recordings are
// rejected with a classified error rather than silently timing out.
const MAX_RECORDING_BYTES = 500 * 1024 * 1024;

const uploadsDir = path.resolve(__dirname, '../../data/uploads/audio');
const savedDir = path.resolve(__dirname, '../../data/uploads/saved-recordings');

class IngestError extends Error {
    constructor(message, { code = 'ingest_failed', status = 500 } = {}) {
        super(message);
        this.name = 'IngestError';
        this.code = code;
        this.status = status;
    }
}

/**
 * @param {object} opts
 * @param {string} opts.userId          Bee Flow user who owns the note
 * @param {object} opts.session         req.session OR triggerBus pseudo-session
 * @param {string} [opts.orgId]         org id (model-tier + EU resolution)
 * @param {string} opts.ncPath          Nextcloud Files path to the recording
 * @param {string} [opts.language]      BCP-47-ish lang code (default 'nl')
 * @param {string} [opts.provider]      explicit provider override
 * @param {string} [opts.contextTerms]  bias terms for the transcriber
 * @param {string} [opts.titleHint]     fallback title
 * @param {string} [opts.userName]      recorder's first name (speaker hint)
 * @param {string} [opts.source]        'nextcloud' | 'talk' | 'talk-auto'
 * @param {string} [opts.sourceUri]     canonical dedup key (derived if absent)
 * @param {string} [opts.talkRoomToken] originating Talk room (for write-back)
 * @param {boolean}[opts.postSummaryBack] post summary back into the Talk room
 * @returns {Promise<object>} the saved-note payload (+ `dedup`, `writeBack`)
 */
async function ingestNextcloudRecording(opts) {
    const {
        userId, session, orgId = null, ncPath,
        language = 'nl', provider: requestedProvider, contextTerms = '',
        titleHint = null, userName: userNameArg,
        source = 'nextcloud', talkRoomToken = null, postSummaryBack = false,
    } = opts || {};

    if (!userId) throw new IngestError('userId is required', { code: 'missing_user', status: 400 });
    if (!ncPath || typeof ncPath !== 'string') throw new IngestError('ncPath is required', { code: 'missing_path', status: 400 });

    const ext = path.extname(ncPath).toLowerCase();
    if (!ACCEPTED_RECORDING_EXTS.includes(ext)) {
        throw new IngestError(`Unsupported recording extension: ${ext}`, { code: 'unsupported_extension', status: 400 });
    }

    const fileName = path.basename(ncPath);
    const sourceUri = opts.sourceUri
        || (talkRoomToken ? `talk://${talkRoomToken}/${fileName}` : `nextcloud://${userId}${ncPath}`);

    // Cheap pre-check so the same recording isn't downloaded + transcribed twice.
    const existing = await transcriptionStore.getTranscriptionBySourceUri(sourceUri);
    if (existing) {
        return { id: existing.id, title: existing.title, dedup: true, sourceUri, writeBack: null };
    }

    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    const tmpPath = path.join(uploadsDir, `${Date.now()}-${userId}${ext}`);

    // ── Download from Nextcloud ──────────────────────────────
    try {
        const ncClient = require('../../integrations/nextcloudClient');
        await ncClient.downloadBinary(session, userId, ncPath, tmpPath);
    } catch (err) {
        safeUnlink(tmpPath);
        if (err.message === 'NOT_CONNECTED') {
            throw new IngestError('Nextcloud is not connected for this account', { code: 'not_connected', status: 400 });
        }
        throw new IngestError(`Could not fetch from Nextcloud: ${err.message}`, { code: 'download_failed', status: 502 });
    }

    // Reject oversized recordings up front (classified, not a timeout).
    try {
        const { size } = fs.statSync(tmpPath);
        if (size > MAX_RECORDING_BYTES) {
            safeUnlink(tmpPath);
            throw new IngestError('Recording exceeds the 500 MB limit. Record audio-only or trim the file.', { code: 'recording_too_large', status: 413 });
        }
    } catch (err) {
        if (err instanceof IngestError) throw err;
    }

    try {
        const userName = userNameArg !== undefined ? userNameArg : await resolveUserFirstName(userId);

        // ── Provider selection (request → admin config → voxtral) ──
        const localEnabled = (await configStore.getConfig('local_whisper_enabled')) !== false;
        let provider = await configStore.getConfig('transcription_provider') || 'voxtral';
        const reqP = String(requestedProvider || '').trim().toLowerCase();
        if (reqP === 'local' && localEnabled) provider = 'local';
        else if (['voxtral', 'whisperx', 'azure', 'whisper_azure'].includes(reqP)) provider = reqP;

        // ── Transcribe ───────────────────────────────────────
        let response;
        if (provider === 'local') {
            const { transcribeLocally } = require('../voice/localWhisper');
            const local = await transcribeLocally(tmpPath, { language });
            if (!local) {
                safeUnlink(tmpPath);
                throw new IngestError('Local transcription unavailable. Pick a cloud provider.', { code: 'local_whisper_unavailable', status: 503 });
            }
            response = { text: local.text, segments: local.segments };
        } else if (provider === 'whisperx') {
            response = await transcribeWithWhisperX(tmpPath, fileName, language, contextTerms || '');
        } else {
            // Voxtral default (other cloud providers reachable via manual upload).
            const apiKey = await configStore.getSecret('mistral_api_key');
            if (!apiKey) {
                safeUnlink(tmpPath);
                throw new IngestError('Mistral API key not configured.', { code: 'missing_mistral_key', status: 400 });
            }
            const { Mistral } = require('@mistralai/mistralai');
            const client = new Mistral({ apiKey, timeout: 300000 });
            const fileContent = fs.readFileSync(tmpPath);
            response = await client.audio.transcriptions.complete({
                model: 'voxtral-mini-2602',
                file: { fileName, content: fileContent },
                diarize: true, language,
                timestampGranularities: ['segment'],
                ...(contextTerms ? { prompt: contextTerms } : {}),
            });
        }

        // ── Build transcript + diarized speakers ─────────────
        let { merged, transcript, speakers, totalDuration } = buildTranscriptArtifacts(response.segments || []);

        // Map diarization speaker IDs → real names (parity with upload route).
        // For Talk recordings we also pass the real attendee roster so the model
        // maps speaker_0/1/2 to the actual participants instead of guessing.
        const participantNames = talkRoomToken ? await resolveTalkParticipantNames(session, userId, talkRoomToken) : [];
        const speakerIds = speakers.map(s => s.id);
        const nameMapping = speakerIds.length ? await identifySpeakerNames(transcript, speakerIds, language, userName, orgId, participantNames) : null;
        if (nameMapping) {
            for (const seg of merged) {
                if (nameMapping[seg.speaker]) seg.speaker = nameMapping[seg.speaker];
            }
            transcript = merged.map(s => `[${s.speaker}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`).join('\n');
            speakers = speakers.map(s => ({ ...s, id: nameMapping[s.id] || s.id }));
            // Merge speakers that collapsed to the same name.
            const byName = {};
            for (const s of speakers) {
                if (byName[s.id]) { byName[s.id].speakingSeconds += s.speakingSeconds; byName[s.id].segments += s.segments; }
                else byName[s.id] = { ...s };
            }
            speakers = Object.values(byName).map(s => ({ ...s, speakingTime: formatTime(s.speakingSeconds) }));
        }

        // ── Summary, title, action items ─────────────────────
        const summary = await generateMeetingSummary(transcript, language, orgId);
        let title = titleHint || fileName.replace(/\.[^/.]+$/, '');
        if (summary) {
            const aiTitle = await generateMeetingTitle(summary, language, orgId);
            if (aiTitle) title = aiTitle;
        }
        const actionItems = await extractActionItems(transcript, language, orgId);

        // ── Persist audio for playback ───────────────────────
        if (!fs.existsSync(savedDir)) fs.mkdirSync(savedDir, { recursive: true });
        const audioPath = path.join(savedDir, `${Date.now()}-${userId}${ext}`);
        try { fs.copyFileSync(tmpPath, audioPath); safeUnlink(tmpPath); }
        catch (_) { safeUnlink(tmpPath); }

        // ── Save the note ────────────────────────────────────
        const saved = await transcriptionStore.createTranscription({
            userId, organizationId: orgId, title, fileName, language,
            durationSeconds: Math.round(totalDuration),
            speakerCount: speakers.length, segmentCount: merged.length,
            fullText: response.text || '', transcript, segments: merged, speakers,
            summary, audioPath: fs.existsSync(audioPath) ? audioPath : '',
            provider, actionItems,
            source, sourceUri, talkRoomToken,
        });

        // Concurrent ingest won the race — surface the existing note.
        if (saved.dedup) {
            return { id: saved.id, title, dedup: true, sourceUri, writeBack: null };
        }

        // ── Optional write-back into the Talk conversation ────
        let writeBack = null;
        if (postSummaryBack && talkRoomToken) {
            writeBack = await postSummaryToTalk({ session, userId, talkRoomToken, title, summary, actionItems });
        }

        return {
            id: saved.id, title, fileName, language,
            duration: formatTime(totalDuration), durationSeconds: Math.round(totalDuration),
            speakerCount: speakers.length, segmentCount: merged.length,
            speakers, fullText: response.text || '',
            transcript, segments: merged, summary, actionItems,
            source, sourceUri, talkRoomToken, dedup: false, writeBack,
        };
    } catch (err) {
        safeUnlink(tmpPath);
        if (err instanceof IngestError) throw err;
        throw new IngestError(err.message, { code: 'transcription_failed', status: 500 });
    }
}

/**
 * Format and post the meeting summary + action items into the originating
 * Talk conversation. Never throws — failures are returned as { ok:false }.
 */
async function postSummaryToTalk({ session, userId, talkRoomToken, title, summary, actionItems }) {
    try {
        const { executeNextcloudTalkTool } = require('../../integrations/nextcloudTalkTools');
        const lines = [`📝 **${title || 'Meeting summary'}**`, ''];
        if (summary) lines.push(summary.trim());
        if (Array.isArray(actionItems) && actionItems.length) {
            lines.push('', '**Action items**');
            for (const it of actionItems) {
                const who = it.assignee && it.assignee !== 'Unassigned' ? ` — ${it.assignee}` : '';
                lines.push(`- ${it.text}${who}`);
            }
        }
        lines.push('', '_Transcribed automatically by Bee Flow._');
        // Talk caps messages at 32k chars; keep a safe margin.
        let message = lines.join('\n');
        if (message.length > 30000) message = message.slice(0, 29900) + '\n…';

        const result = await executeNextcloudTalkTool('nextcloud_talk_send_message', { token: talkRoomToken, message, silent: true }, userId, session);
        if (result?.error) {
            console.warn(`[IngestNextcloudRecording] Talk write-back failed for ${talkRoomToken}: ${result.error}`);
            return { ok: false, error: result.error };
        }
        return { ok: true };
    } catch (err) {
        console.warn(`[IngestNextcloudRecording] Talk write-back threw for ${talkRoomToken}: ${err.message}`);
        return { ok: false, error: err.message };
    }
}

/**
 * Fetch the real display-name roster for a Talk room (best-effort). Used to
 * anchor diarization → real-name mapping. Never throws.
 */
async function resolveTalkParticipantNames(session, userId, talkRoomToken) {
    try {
        const { executeNextcloudTalkTool } = require('../../integrations/nextcloudTalkTools');
        const res = await executeNextcloudTalkTool('nextcloud_talk_list_participants', { token: talkRoomToken }, userId, session);
        if (!res || res.error || !Array.isArray(res.participants)) return [];
        const names = res.participants
            .map(p => (p.displayName || '').trim())
            // Drop empty + obvious bot/system actors.
            .filter(n => n && !/^(bot|system|changelog)$/i.test(n));
        return Array.from(new Set(names));
    } catch (_) {
        return [];
    }
}

async function resolveUserFirstName(userId) {
    try {
        const { getUser } = require('../../stores/userStore');
        const u = await getUser(userId);
        return u?.firstName || u?.displayName || null;
    } catch (_) { return null; }
}

function safeUnlink(p) { try { fs.unlinkSync(p); } catch (_) {} }

/**
 * If `ncPath` sits under the Talk recordings folder as
 * `<recordingFolder>/<token>/<file>`, return the room token; else null.
 * Talk stores each call's recording in a per-room-token subfolder.
 */
function parseTalkRoomToken(ncPath, recordingFolder = '/Talk') {
    if (!ncPath) return null;
    const norm = (p) => '/' + String(p).split('/').filter(Boolean).join('/');
    const folder = norm(recordingFolder);
    const full = norm(ncPath);
    if (!full.toLowerCase().startsWith(folder.toLowerCase() + '/')) return null;
    const rest = full.slice(folder.length + 1).split('/').filter(Boolean);
    if (rest.length < 2) return null; // need <token>/<file>
    const token = rest[0];
    return /^[A-Za-z0-9]+$/.test(token) ? token : null;
}

module.exports = {
    ingestNextcloudRecording,
    parseTalkRoomToken,
    ACCEPTED_RECORDING_EXTS,
    IngestError,
};
