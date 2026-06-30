/**
 * Transcriptions API — REST endpoints for meeting transcription history.
 *
 * GET    /api/transcriptions          — List user's transcriptions
 * GET    /api/transcriptions/:id      — Get full transcription with segments
 * POST   /api/transcriptions          — Upload & transcribe an audio file
 * PATCH  /api/transcriptions/:id      — Rename a transcription
 * DELETE /api/transcriptions/:id      — Delete a transcription
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const transcriptionStore = require('../stores/transcriptionStore');
const configStore = require('../stores/configStore');

function formatDuration(seconds) {
    if (!seconds) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// Multer for audio file upload
const uploadsDir = path.resolve(__dirname, '../data/uploads/audio');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
    dest: uploadsDir,
    limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const allowed = ['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.flac', '.mp4', '.mpeg', '.aac'];
        if (allowed.includes(ext) || file.mimetype?.startsWith('audio/')) {
            cb(null, true);
        } else {
            cb(new Error('Unsupported audio format. Supported: MP3, WAV, M4A, OGG, WEBM, FLAC, MP4, AAC'));
        }
    },
});

/**
 * Get an Anthropic client using the provider key for Claude.
 */
const llmClient = require('../core/llmClient');

/**
 * Resolve the user's group IDs from userStore — used to filter published
 * transcriptions by `shared_groups`. Mirrors `resolveUserGroups` in
 * `server/routes/knowledgeBases.js`.
 */
async function resolveUserGroupIds(req) {
    const userId = req.session?.user?.id;
    if (!userId) return [];
    try {
        const userStore = require('../stores/userStore');
        const user = await userStore.getUser(userId);
        if (!user) return [];
        if (Array.isArray(user.groups)) return user.groups;
        if (typeof user.groups === 'string') {
            try { return JSON.parse(user.groups || '[]'); } catch { return []; }
        }
    } catch (_) { /* ignore */ }
    return [];
}

/**
 * Resolve the user's full read-access context for transcription queries:
 * org IDs they belong to (for org-scoped published rows) and group IDs
 * (for `shared_groups` filtering).
 */
async function resolveAccessContext(req) {
    const { resolveUserOrgIds } = require('../auth');
    const orgIdsSet = await resolveUserOrgIds(req);
    // Super admin → orgIdsSet is null. Pass through a sentinel that allows all
    // by combining the user's actual orgs (best effort) with an org-agnostic
    // path inside the store. For simplicity, super admins still see their own
    // + their primary org's published items; cross-org snooping isn't a
    // supported flow in the UI.
    const orgIds = orgIdsSet === null
        ? []
        : Array.from(orgIdsSet || []);
    const userGroupIds = await resolveUserGroupIds(req);
    return { orgIds, userGroupIds, isSuperAdmin: orgIdsSet === null };
}

/**
 * Resolve the user's organization ID from a request for EU-mode tier overrides.
 */
async function resolveUserOrgFromReq(req) {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return null;
        const { resolveUserOrgIds } = require('../auth');
        const orgIds = await resolveUserOrgIds(req);
        if (orgIds && orgIds.size > 0) return Array.from(orgIds)[0];
        const userStore = require('../stores/userStore');
        const dbUser = await userStore.getUser(userId);
        if (dbUser?.organizationId) return dbUser.organizationId;
        const groups = Array.isArray(dbUser?.groups) ? dbUser.groups : (() => { try { return JSON.parse(dbUser?.groups || '[]'); } catch (_) { return []; } })();
        if (groups.length > 0) {
            const allGroups = await userStore.getAllGroups();
            for (const gid of groups) {
                const g = allGroups.find(gr => gr.id === gid);
                if (g?.organizationId) return g.organizationId;
            }
        }
    } catch (_) {}
    return null;
}

// Meeting-notes pipeline helpers (model tiers, diarization naming, summary /
// title / action-item generation) live in a shared module so the background
// Nextcloud Talk auto-ingest can reuse the exact same logic.
const {
    resolveSmartModel,
    identifySpeakerNames,
    generateMeetingSummary,
    generateMeetingTitle,
    extractActionItems,
} = require('../core/meetingNotes/summaryHelpers');

/** Summary template prompts */
const SUMMARY_TEMPLATES = {
    general: `Create a concise, well-structured summary of the meeting transcript.

Format with these sections (use markdown):
## 📋 Summary
A brief 2-3 sentence overview of what the meeting was about.

## 🔑 Key Topics
- Bullet points of main topics discussed

## ✅ Decisions Made
- Any decisions that were agreed upon (skip if none)

## 📌 Action Items
- Specific tasks assigned to people (skip if none)

## 💡 Key Insights
- Notable ideas, suggestions, or observations

Keep it concise and actionable. Skip empty sections.`,

    standup: `Create a standup/daily sync summary of the meeting transcript.

Format with these sections (use markdown):
## 📋 Daily Sync Summary
Brief overview of the standup meeting.

## ✅ What Was Done
- Per person: what they completed since last standup

## 🚧 In Progress
- Per person: what they're currently working on

## 🚫 Blockers
- Any blockers or impediments mentioned

## 📌 Next Steps
- Specific follow-up actions

Keep it concise. Skip empty sections.`,

    sales: `Create a sales call summary of the meeting transcript.

Format with these sections (use markdown):
## 📋 Call Summary
Brief overview: who was on the call, company/prospect name if mentioned.

## 🎯 Customer Needs
- Pain points, requirements, or goals expressed by the prospect

## 💬 Key Discussion Points
- Main topics covered during the call

## ⚠️ Objections & Concerns
- Any pushback, hesitations, or concerns raised

## 📌 Next Steps
- Agreed follow-up actions with owners and timelines

## 📊 Deal Assessment
- Brief assessment of the opportunity

Keep it concise and actionable. Skip empty sections.`,

    interview: `Create an interview summary of the meeting transcript.

Format with these sections (use markdown):
## 📋 Interview Summary
Candidate name (if mentioned), role, and overall impression.

## 💪 Strengths
- Key strengths and positive signals from the candidate

## ⚠️ Concerns
- Areas of concern or gaps

## 🔑 Key Responses
- Notable answers to important questions

## 📊 Fit Assessment
- Overall assessment and recommendation

## 📌 Follow-up Actions
- Next steps in the hiring process

Keep it concise and objective. Skip empty sections.`,

    retrospective: `Create a retrospective meeting summary.

Format with these sections (use markdown):
## 📋 Retrospective Summary
Brief overview of what was discussed.

## 🌟 What Went Well
- Positive outcomes and successes

## 🔧 What Could Be Improved
- Areas for improvement

## 💡 Ideas & Suggestions
- Proposed changes or experiments

## 📌 Action Items
- Specific improvement actions with owners

Keep it concise and actionable. Skip empty sections.`,
};


/**
 * Transcribe audio via the self-hosted WhisperX FastAPI service.
 * Returns a response object with the same shape as Voxtral output.
 */
const { transcribeWithWhisperX } = require('../core/meetingNotes/summaryHelpers');

// Auth middleware
function requireAuth(req, res, next) {
    if (!req.session?.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    next();
}

// ── List transcriptions ──────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        const offset = parseInt(req.query.offset) || 0;
        const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
        const transcriptions = await transcriptionStore.getTranscriptions(userId, { limit, offset, orgIds, userGroupIds, isSuperAdmin });
        res.json({ transcriptions });
    } catch (err) {
        console.error('[Transcriptions] List error:', err.message);
        res.status(500).json({ error: 'Failed to list transcriptions' });
    }
});

// ── Get single transcription ─────────────────────────────

// Static GET routes below (e.g. /nextcloud-talk-recordings, /talk-meetings) are
// registered after this param route, so let their literal names fall through
// instead of being captured as an :id and 404'ing.
const RESERVED_GET_PATHS = new Set(['nextcloud-audio-files', 'nextcloud-talk-recordings', 'talk-meetings']);

router.get('/:id', requireAuth, async (req, res, next) => {
    if (RESERVED_GET_PATHS.has(req.params.id)) return next();
    try {
        const userId = req.session.user.id;
        const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
        const transcription = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
        if (!transcription) return res.status(404).json({ error: 'Transcription not found' });
        res.json(transcription);
    } catch (err) {
        console.error('[Transcriptions] Get error:', err.message);
        res.status(500).json({ error: 'Failed to get transcription' });
    }
});

// ── Upload & transcribe ──────────────────────────────────

router.post('/', requireAuth, upload.single('audio'), async (req, res) => {
    const userId = req.session.user.id;
    const userOrgId = await resolveUserOrgFromReq(req);

    if (!req.file) {
        return res.status(400).json({ error: 'No audio file uploaded' });
    }

    const language = req.body.language || 'nl';
    const contextTerms = req.body.context_terms || '';
    let title = req.body.title || req.file.originalname || 'Untitled';

    try {
        // Set route timeout to 10 minutes for large files (WhisperX can be slower on CPU)
        req.setTimeout(600000);
        res.setTimeout(600000);

        const fileContent = fs.readFileSync(req.file.path);
        const fileName = req.file.originalname || 'audio.mp3';

        // Fetch the logged-in user's display name for speaker ID anchoring
        let userName = null;
        try {
            const { getUser } = require('../stores/userStore');
            const userRecord = await getUser(userId);
            userName = userRecord?.firstName || userRecord?.displayName || null;
        } catch (_) {}

        // Provider precedence:
        //   1. Per-upload `provider` form field (only honoured for 'local',
        //      and only when local transcription is admin-enabled). Picks
        //      from the upload modal in the UI.
        //   2. Server-side default `transcription_provider` config.
        const requestedProvider = String(req.body.provider || '').trim().toLowerCase();
        const localEnabled = (await configStore.getConfig('local_whisper_enabled')) !== false;
        let provider = await configStore.getConfig('transcription_provider') || 'voxtral';
        if (requestedProvider === 'local' && localEnabled) {
            provider = 'local';
        } else if (['voxtral', 'whisperx', 'azure', 'whisper_azure'].includes(requestedProvider)) {
            // Allow the UI to also pick a specific cloud provider explicitly.
            provider = requestedProvider;
        }

        console.log(`[Transcriptions] Transcribing "${fileName}" (${(fileContent.length / (1024 * 1024)).toFixed(1)} MB) via ${provider} for user ${userId} (${userName || 'unknown'})`);

        let response;
        // Tracks an automatic engine switch (e.g. local → voxtral when an upload
        // exceeds the on-device CPU model's duration cap). Surfaced in the
        // success payload so the UI can show a soft "transcribed via cloud
        // instead" note rather than failing the upload.
        let providerFallback = null;

        if (provider === 'local') {
            // ── In-process Whisper-base on CPU (privacy / no-cloud path) ──
            const { transcribeLocally } = require('../core/voice/localWhisper');
            try {
                const local = await transcribeLocally(req.file.path, { language });
                if (!local) {
                    try { fs.unlinkSync(req.file.path); } catch (_) {}
                    return res.status(503).json({
                        error: 'Local transcription model is not available. Try again, or pick a cloud provider.',
                        code: 'local_whisper_unavailable',
                    });
                }
                response = { text: local.text, segments: local.segments };
            } catch (err) {
                if (err.code === 'local_whisper_too_long') {
                    // Try to fall back to a configured cloud provider so the
                    // upload doesn't dead-end. Voxtral is preferred (no extra
                    // setup once a Mistral key is present); WhisperX is the
                    // self-hosted alternative if it's configured.
                    const mistralKey = await configStore.getSecret('mistral_api_key');
                    const whisperxUrl = await configStore.getConfig('whisperx_url');
                    const azureKey = await configStore.getSecret('azure_speech_key');
                    const azureRegion = await configStore.getConfig('azure_speech_region');
                    let cloud = null;
                    if (mistralKey) cloud = 'voxtral';
                    else if (whisperxUrl) cloud = 'whisperx';
                    else if (azureKey && azureRegion) cloud = 'azure';

                    if (cloud) {
                        console.log(`[Transcriptions] Local cap exceeded — falling back to ${cloud}`);
                        providerFallback = { from: 'local', to: cloud, reason: 'too_long', message: err.message };
                        provider = cloud;
                        // Fall through to the cloud branch below.
                    } else {
                        try { fs.unlinkSync(req.file.path); } catch (_) {}
                        return res.status(413).json({
                            error: err.message + '. No cloud provider is configured — ask an admin to enable Voxtral, WhisperX or Azure, or split the recording.',
                            code: 'local_whisper_too_long_no_fallback',
                        });
                    }
                } else {
                    throw err;
                }
            }
        }

        if (!response && provider === 'whisperx') {
            // ── WhisperX (self-hosted) ───────────────────────
            response = await transcribeWithWhisperX(req.file.path, fileName, language, contextTerms);

        } else if (!response && provider === 'azure') {
            // ── Azure AI Speech (SDK ConversationTranscriber) ────────
            const azureKey = await configStore.getSecret('azure_speech_key');
            const azureRegion = await configStore.getConfig('azure_speech_region');
            if (!azureKey || !azureRegion) {
                try { fs.unlinkSync(req.file.path); } catch (_) {}
                return res.status(400).json({ error: 'Azure Speech credentials not configured. Go to Admin → Integrations → Transcription.' });
            }

            const os = require('os');
            const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
            const ffmpegLib = require('fluent-ffmpeg');
            ffmpegLib.setFfmpegPath(ffmpegInstaller.path);

            // Azure Speech SDK requires 16kHz mono PCM WAV.
            // Audio preprocessing notes:
            //   - highpass=f=80    — cut DC offset / low-frequency rumble below 80Hz
            //   - loudnorm          — EBU R128 loudness normalization (recommended over dynaudnorm
            //                         for speech; preserves dynamics without distorting quiet speakers)
            //   - NO lowpass filter — keeping frequencies up to 8kHz is intentional; Dutch (and most
            //                         languages) have important fricatives (s, f, sh) at 4-8kHz that
            //                         a lowpass filter would cut, reducing recognition accuracy.
            const tempWavPath = path.join(os.tmpdir(), `azure-stt-${Date.now()}.wav`);
            console.log('[Transcriptions] Converting & preprocessing audio for Azure...');
            await new Promise((resolve, reject) => {
                ffmpegLib(req.file.path)
                    .audioChannels(1)
                    .audioFrequency(16000)
                    .audioCodec('pcm_s16le')
                    .format('wav')
                    .audioFilters([
                        'highpass=f=80',   // remove DC offset / very low-freq rumble only
                        'loudnorm',        // EBU R128 normalization — balanced volume
                    ])
                    .on('end', resolve)
                    .on('error', reject)
                    .save(tempWavPath);
            });

            const LOCALE_MAP = {
                nl: 'nl-NL', en: 'en-US', de: 'de-DE', fr: 'fr-FR',
                es: 'es-ES', it: 'it-IT', pt: 'pt-PT',
            };
            const locale = LOCALE_MAP[language] || `${language}-${language.toUpperCase()}`;

            const sdk = require('microsoft-cognitiveservices-speech-sdk');
            const speechConfig = sdk.SpeechConfig.fromSubscription(azureKey, azureRegion);
            speechConfig.speechRecognitionLanguage = locale;
            speechConfig.requestWordLevelTimestamps();
            // Detailed output provides higher accuracy & word-level confidence
            speechConfig.outputFormat = sdk.OutputFormat.Detailed;
            // Don't censor/filter words — we want raw transcription
            speechConfig.setProfanity && speechConfig.setProfanity(sdk.ProfanityOption.Raw);
            // Allow longer pauses within a sentence before it's considered complete.
            // Default is 500ms — increase to 3000ms so short pauses don't fragment sentences.
            speechConfig.setProperty('Speech_SegmentationSilenceTimeoutMs', '3000');
            // Allow up to 10s of initial silence (recordings often start with a pause/intro)
            speechConfig.setProperty('SpeechServiceConnection_InitialSilenceTimeoutMs', '10000');

            // If context terms were provided, add them as a phrase list for better recognition
            const audioConfig = sdk.AudioConfig.fromWavFileInput(fs.readFileSync(tempWavPath));
            const transcriber = new sdk.ConversationTranscriber(speechConfig, audioConfig);
            const rawSegments = [];
            if (contextTerms) {
                try {
                    const phraseList = sdk.PhraseListGrammar.fromRecognizer(transcriber);
                    contextTerms.split(/[,;\n]/).map(t => t.trim()).filter(Boolean).forEach(term => {
                        phraseList.addPhrase(term);
                    });
                    console.log('[Transcriptions] Azure phrase hints added from context terms');
                } catch (_) { /* PhraseListGrammar may not work with ConversationTranscriber */ }
            }


            console.log(`[Transcriptions] Azure ConversationTranscriber started (locale: ${locale})...`);
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => { transcriber.stopTranscribingAsync(); reject(new Error('Azure timed out')); }, 10 * 60 * 1000);
                transcriber.transcribed = (_s, e) => {
                    if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
                        rawSegments.push({
                            speakerId: e.result.speakerId || 'Unknown',
                            start: e.result.offset / 10_000_000,
                            end: (e.result.offset + e.result.duration) / 10_000_000,
                            text: e.result.text.trim(),
                        });
                    }
                };
                transcriber.canceled = (_s, e) => {
                    clearTimeout(timeout);
                    if (e.reason === sdk.CancellationReason.Error) {
                        const safe = (e.errorDetails || '').replace(/[A-Za-z0-9_\-]{32,}/g, '[REDACTED]');
                        reject(new Error(`Azure Speech error: ${safe}`));
                    } else { resolve(); }
                };
                transcriber.sessionStopped = () => { clearTimeout(timeout); resolve(); };
                transcriber.startTranscribingAsync(() => {}, (err) => {
                    clearTimeout(timeout);
                    reject(new Error(`Azure start failed: ${(err?.message || String(err)).replace(/[A-Za-z0-9_\-]{32,}/g, '[REDACTED]')}`));
                });
            });
            speechConfig.close && speechConfig.close();
            try { fs.unlinkSync(tempWavPath); } catch (_) {}

            console.log(`[Transcriptions] Azure returned ${rawSegments.length} segments`);
            if (rawSegments.length === 0) {
                try { fs.unlinkSync(req.file.path); } catch (_) {}
                return res.status(422).json({ error: 'Azure Speech returned no speech. Check language setting and audio quality.' });
            }

            // Normalize to Voxtral-compatible shape
            response = {
                text: rawSegments.map(s => s.text).join(' '),
                segments: rawSegments.map(s => ({
                    speakerId: s.speakerId,
                    start: s.start,
                    end: s.end,
                    text: s.text,
                })),
            };

        } else if (!response && provider === 'whisper_azure') {
            // ── Azure Whisper Batch (REST API v3.2) ─────────────────
            const { executeTranscriptionTool } = require('../integrations/transcriptionTools');
            const whisperResult = await executeTranscriptionTool('transcribe_audio', {
                filePath: req.file.path,
                fileName,
                language,
                contextTerms,
                userName,
            }, { userId });
            if (whisperResult.error) {
                try { fs.unlinkSync(req.file.path); } catch (_) {}
                return res.status(422).json({ error: whisperResult.error });
            }
            // whisperResult is already fully processed (transcript, segments, speakers, etc.)
            // Save recording and persist to DB directly
            const audioDirW = path.resolve(__dirname, '../data/uploads/saved-recordings');
            if (!fs.existsSync(audioDirW)) fs.mkdirSync(audioDirW, { recursive: true });
            const extW = path.extname(req.file.originalname || '.webm') || '.webm';
            const audioNameW = `${Date.now()}-${userId}${extW}`;
            const audioPathW = path.join(audioDirW, audioNameW);
            try { fs.copyFileSync(req.file.path, audioPathW); fs.unlinkSync(req.file.path); } catch (_) { try { fs.unlinkSync(req.file.path); } catch (_) {} }

            const summaryW = await generateMeetingSummary(whisperResult.transcript, language, userOrgId);
            let titleW = title;
            if (summaryW) { const aiT = await generateMeetingTitle(summaryW, language, userOrgId); if (aiT) titleW = aiT; }
            const actionItemsW = await extractActionItems(whisperResult.transcript, language, userOrgId);

            const savedW = await transcriptionStore.createTranscription({
                userId, organizationId: userOrgId, title: titleW, fileName, language,
                durationSeconds: whisperResult.durationSeconds || 0,
                speakerCount: (whisperResult.speakers || []).length,
                segmentCount: (whisperResult.segments || []).length,
                fullText: '', transcript: whisperResult.transcript,
                segments: whisperResult.segments || [],
                speakers: whisperResult.speakers || [],
                summary: summaryW, audioPath: fs.existsSync(audioPathW) ? audioPathW : '',
                provider, actionItems: actionItemsW,
            });

            return res.json({
                id: savedW.id, title: titleW, fileName, language,
                duration: whisperResult.duration || '0:00',
                durationSeconds: whisperResult.durationSeconds || 0,
                speakerCount: (whisperResult.speakers || []).length,
                segmentCount: (whisperResult.segments || []).length,
                speakers: whisperResult.speakers || [],
                fullText: '', transcript: whisperResult.transcript,
                segments: whisperResult.segments || [],
                summary: summaryW, actionItems: actionItemsW,
            });

        } else if (!response) {
            // ── Voxtral (cloud, default) ─────────────────────
            const apiKey = await configStore.getSecret('mistral_api_key');
            if (!apiKey) {
                try { fs.unlinkSync(req.file.path); } catch (_) {}
                return res.status(400).json({ error: 'Mistral API key not configured. Go to Admin → AI Config → API Keys.' });
            }

            const { Mistral } = require('@mistralai/mistralai');
            const client = new Mistral({ apiKey, timeout: 300000 });

            const transcriptionOptions = {
                model: 'voxtral-mini-2602',
                file: { fileName, content: fileContent },
                diarize: true,
                language,
                timestampGranularities: ['segment'],
            };
            if (contextTerms) transcriptionOptions.prompt = contextTerms;

            response = await client.audio.transcriptions.complete(transcriptionOptions);
        }

        // Merge segments
        const segments = response.segments || [];
        const merged = [];
        for (const seg of segments) {
            const last = merged[merged.length - 1];
            if (last && seg.speakerId === last.speakerId) {
                last.end = seg.end;
                last.text += ' ' + (seg.text || '').trim();
            } else {
                merged.push({
                    speaker: seg.speakerId || 'Unknown',
                    start: seg.start,
                    end: seg.end,
                    text: (seg.text || '').trim(),
                });
            }
        }

        // Speaker stats
        const speakerMap = {};
        for (const seg of merged) {
            if (!speakerMap[seg.speaker]) speakerMap[seg.speaker] = { duration: 0, segments: 0 };
            speakerMap[seg.speaker].duration += (seg.end || 0) - (seg.start || 0);
            speakerMap[seg.speaker].segments += 1;
        }

        const totalDuration = segments.length > 0 ? Math.max(...segments.map(s => s.end || 0)) : 0;

        const formatTime = (secs) => {
            if (secs == null) return '00:00';
            const h = Math.floor(secs / 3600);
            const m = Math.floor((secs % 3600) / 60);
            const s = Math.floor(secs % 60);
            if (h > 0) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
            return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
        };

        let transcript = merged.map(s => `[${s.speaker}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`).join('\n');
        let speakers = Object.entries(speakerMap).map(([id, data]) => ({
            id,
            speakingTime: formatTime(data.duration),
            speakingSeconds: Math.round(data.duration),
            segments: data.segments,
        }));

        // Identify speaker names using fast-tier model
        const speakerIds = Object.keys(speakerMap);
        const nameMapping = await identifySpeakerNames(transcript, speakerIds, language, userName, userOrgId);

        if (nameMapping) {
            // Apply name mapping to segments
            for (const seg of merged) {
                if (nameMapping[seg.speaker]) seg.speaker = nameMapping[seg.speaker];
            }
            // Re-generate transcript with real names
            transcript = merged.map(s => `[${s.speaker}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`).join('\n');
            // Update speakers list with mapped names
            speakers = speakers.map(s => ({
                ...s,
                id: nameMapping[s.id] || s.id,
            }));
        }

        // Merge speakers with the same name (e.g. multiple "Gerard" entries)
        const mergedSpeakers = {};
        for (const s of speakers) {
            if (mergedSpeakers[s.id]) {
                mergedSpeakers[s.id].speakingSeconds += s.speakingSeconds;
                mergedSpeakers[s.id].segments += s.segments;
            } else {
                mergedSpeakers[s.id] = { ...s };
            }
        }
        speakers = Object.values(mergedSpeakers).map(s => ({
            ...s,
            speakingTime: formatTime(s.speakingSeconds),
        }));

        // Generate meeting summary with Claude
        const summary = await generateMeetingSummary(transcript, language, userOrgId);

        // Always generate AI title from summary
        if (summary) {
            const aiTitle = await generateMeetingTitle(summary, language, userOrgId);
            if (aiTitle) title = aiTitle;
        }

        // Extract structured action items
        const actionItems = await extractActionItems(transcript, language, userOrgId);


        // Save audio permanently for playback
        const audioDir = path.resolve(__dirname, '../data/uploads/saved-recordings');
        if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
        const ext = path.extname(req.file.originalname || '.webm') || '.webm';
        const audioName = `${Date.now()}-${userId}${ext}`;
        const audioPath = path.join(audioDir, audioName);
        try {
            fs.copyFileSync(req.file.path, audioPath);
            fs.unlinkSync(req.file.path);
        } catch (_) {
            // If copy fails, just clean up temp
            try { fs.unlinkSync(req.file.path); } catch (_) {}
        }

        // Save to DB
        const saved = await transcriptionStore.createTranscription({
            userId,
            organizationId: userOrgId,
            title,
            fileName,
            language,
            durationSeconds: Math.round(totalDuration),
            speakerCount: speakers.length,
            segmentCount: merged.length,
            fullText: response.text || '',
            transcript,
            segments: merged,
            speakers,
            summary,
            audioPath: fs.existsSync(audioPath) ? audioPath : '',
            provider,
            actionItems,
        });

        res.json({
            id: saved.id,
            title,
            fileName,
            language,
            duration: formatTime(totalDuration),
            durationSeconds: Math.round(totalDuration),
            speakerCount: speakers.length,
            segmentCount: merged.length,
            speakers,
            fullText: response.text || '',
            transcript,
            segments: merged,
            summary,
            actionItems,
            providerFallback,
        });

    } catch (err) {
        // Save recording for manual reprocessing instead of deleting
        let savedPath = '';
        try {
            if (req.file?.path && fs.existsSync(req.file.path)) {
                const savedDir = path.resolve(__dirname, '../data/uploads/saved-recordings');
                if (!fs.existsSync(savedDir)) fs.mkdirSync(savedDir, { recursive: true });
                const ext = path.extname(req.file.originalname || '.webm') || '.webm';
                const savedName = `${Date.now()}-${userId}${ext}`;
                savedPath = path.join(savedDir, savedName);
                fs.copyFileSync(req.file.path, savedPath);
                fs.unlinkSync(req.file.path);
                console.log(`[Transcriptions] Saved failed recording to ${savedPath}`);
            }
        } catch (saveErr) {
            console.error('[Transcriptions] Failed to save recording:', saveErr.message);
        }

        // Create a "failed" record so it shows in the list
        try {
            const saved = await transcriptionStore.createTranscription({
                userId,
                organizationId: userOrgId,
                title: req.body.title || req.file?.originalname || 'Failed Transcription',
                fileName: req.file?.originalname || 'unknown',
                language: req.body.language || 'nl',
                status: 'failed',
                audioPath: savedPath,
            });
            console.error('[Transcriptions] Transcribe error:', err.message);
            res.status(500).json({ error: `Transcription failed: ${err.message}`, id: saved.id, status: 'failed' });
        } catch (dbErr) {
            console.error('[Transcriptions] Transcribe error:', err.message);
            res.status(500).json({ error: `Transcription failed: ${err.message}` });
        }
    }
});

// ── Reprocess failed transcription ───────────────────────

router.post('/:id/reprocess', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const userOrgId = await resolveUserOrgFromReq(req);
        const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
        const transcription = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
        if (!transcription) return res.status(404).json({ error: 'Not found' });
        if (!transcription.isOwner) return res.status(403).json({ error: 'Only the owner can reprocess' });
        if (!transcription.audioPath || !fs.existsSync(transcription.audioPath)) {
            return res.status(400).json({ error: 'Saved audio not found. Cannot reprocess — please upload again.' });
        }

        // Set route timeout to 10 minutes
        req.setTimeout(600000);
        res.setTimeout(600000);

        // Use the stored provider, falling back to current admin config
        const provider = transcription.provider || await configStore.getConfig('transcription_provider') || 'voxtral';
        const fileName = transcription.fileName || 'audio.webm';
        const language = transcription.language || 'nl';

        console.log(`[Transcriptions] Reprocessing "${fileName}" via ${provider}`);

        let response;

        if (provider === 'whisperx') {
            response = await transcribeWithWhisperX(transcription.audioPath, fileName, language, '');
        } else if (provider === 'azure' || provider === 'whisper_azure') {
            const { executeTranscriptionTool } = require('../integrations/transcriptionTools');
            response = await executeTranscriptionTool('transcribe_audio', {
                filePath: transcription.audioPath,
                fileName,
                language,
                contextTerms: '',
                provider,
            });
        } else {
            const apiKey = await configStore.getSecret('mistral_api_key');
            if (!apiKey) return res.status(400).json({ error: 'Mistral API key not configured' });

            const { Mistral } = require('@mistralai/mistralai');
            const client = new Mistral({ apiKey, timeout: 300000 });

            const fileContent = fs.readFileSync(transcription.audioPath);

            response = await client.audio.transcriptions.complete({
                model: 'voxtral-mini-2602',
                file: { fileName, content: fileContent },
                diarize: true,
                language,
                timestampGranularities: ['segment'],
            });
        }

        // Merge segments
        const segments = response.segments || [];
        const merged = [];
        for (const seg of segments) {
            const last = merged[merged.length - 1];
            if (last && seg.speakerId === last.speakerId) {
                last.end = seg.end;
                last.text += ' ' + (seg.text || '').trim();
            } else {
                merged.push({ speaker: seg.speakerId || seg.speaker || 'Unknown', start: seg.start, end: seg.end, text: (seg.text || '').trim() });
            }
        }

        const speakerMap = {};
        for (const seg of merged) {
            if (!speakerMap[seg.speaker]) speakerMap[seg.speaker] = { duration: 0, segments: 0 };
            speakerMap[seg.speaker].duration += (seg.end || 0) - (seg.start || 0);
            speakerMap[seg.speaker].segments += 1;
        }

        const totalDuration = segments.length > 0 ? Math.max(...segments.map(s => s.end || 0)) : 0;

        const formatTime = (secs) => {
            if (secs == null) return '00:00';
            const h = Math.floor(secs / 3600);
            const m = Math.floor((secs % 3600) / 60);
            const s = Math.floor(secs % 60);
            if (h > 0) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
            return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
        };

        let transcript = merged.map(s => `[${s.speaker}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`).join('\n');
        let speakers = Object.entries(speakerMap).map(([id, data]) => ({ id, speakingTime: formatTime(data.duration), speakingSeconds: Math.round(data.duration), segments: data.segments }));

        // Speaker identification
        const speakerIds = Object.keys(speakerMap);
        // Look up user name for reprocess route too
        let reprocessUserName = null;
        try { const { getUser } = require('../stores/userStore'); const u = await getUser(req.session.user.id); reprocessUserName = u?.firstName || u?.displayName || null; } catch (_) {}
        const nameMapping = await identifySpeakerNames(transcript, speakerIds, language, reprocessUserName, userOrgId);
        if (nameMapping) {
            for (const seg of merged) { if (nameMapping[seg.speaker]) seg.speaker = nameMapping[seg.speaker]; }
            transcript = merged.map(s => `[${s.speaker}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`).join('\n');
            speakers = speakers.map(s => ({ ...s, id: nameMapping[s.id] || s.id }));
        }

        // Merge speakers with the same name
        const mergedSpeakers = {};
        for (const s of speakers) {
            if (mergedSpeakers[s.id]) {
                mergedSpeakers[s.id].speakingSeconds += s.speakingSeconds;
                mergedSpeakers[s.id].segments += s.segments;
            } else {
                mergedSpeakers[s.id] = { ...s };
            }
        }
        speakers = Object.values(mergedSpeakers).map(s => ({
            ...s,
            speakingTime: formatTime(s.speakingSeconds),
        }));

        // Summary
        const summary = await generateMeetingSummary(transcript, language, userOrgId);

        // Update the existing record
        const { run } = require('../stores/db');
        await run(
            `UPDATE transcriptions SET status = $1, duration_seconds = $2, speaker_count = $3, segment_count = $4, full_text = $5, transcript = $6, segments = $7, speakers = $8, summary = $9, updated_at = NOW() WHERE id = $10 AND user_id = $11`,
            ['completed', Math.round(totalDuration), Object.keys(speakerMap).length, merged.length, response.text || '', transcript, JSON.stringify(merged), JSON.stringify(speakers), summary, req.params.id, userId]
        );

        res.json({ success: true, id: req.params.id, status: 'completed' });
    } catch (err) {
        console.error('[Transcriptions] Reprocess error:', err.message);
        res.status(500).json({ error: `Reprocessing failed: ${err.message}` });
    }
});

// ── Serve audio file for playback ────────────────────────

router.get('/:id/audio', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
        const transcription = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
        if (!transcription) return res.status(404).json({ error: 'Not found' });
        if (!transcription.audioPath || !fs.existsSync(transcription.audioPath)) {
            return res.status(404).json({ error: 'Audio file not available' });
        }
        const audioPath = transcription.audioPath;
        const ext = path.extname(audioPath).toLowerCase();
        const mimeMap = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.webm': 'audio/webm', '.flac': 'audio/flac', '.aac': 'audio/aac', '.mp4': 'audio/mp4' };
        const contentType = mimeMap[ext] || 'audio/mpeg';
        const stat = fs.statSync(audioPath);
        const fileSize = stat.size;
        const fileName = transcription.fileName || `audio${ext}`;

        // HTML5 <audio> elements seek/scrub via byte-range requests. Some
        // formats (notably webm/mp4/m4a) refuse to play without
        // `206 Partial Content` + `Accept-Ranges: bytes`. Honour Range
        // headers properly so seeking + playback work in every browser.
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
        res.setHeader('Cache-Control', 'private, max-age=3600');

        const range = req.headers.range;
        if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (!match) {
                res.setHeader('Content-Range', `bytes */${fileSize}`);
                return res.status(416).end();
            }
            const start = match[1] ? parseInt(match[1], 10) : 0;
            const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
            if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= fileSize) {
                res.setHeader('Content-Range', `bytes */${fileSize}`);
                return res.status(416).end();
            }
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
            res.setHeader('Content-Length', String(end - start + 1));
            fs.createReadStream(audioPath, { start, end }).pipe(res);
            return;
        }

        // No range header — full file.
        res.setHeader('Content-Length', String(fileSize));
        fs.createReadStream(audioPath).pipe(res);
    } catch (err) {
        console.error('[Transcriptions] Audio serve error:', err.message);
        res.status(500).json({ error: 'Failed to serve audio' });
    }
});

// ── Rename / update transcription ────────────────────────

router.patch('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { title, actionItems, tags } = req.body;
        if (!title && actionItems === undefined && tags === undefined) {
            return res.status(400).json({ error: 'Nothing to update' });
        }
        const updates = {};
        if (title) updates.title = title;
        if (actionItems !== undefined) updates.actionItems = actionItems;
        if (tags !== undefined) updates.tags = tags;
        const updated = await transcriptionStore.updateTranscription(req.params.id, userId, updates);
        if (!updated) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Transcriptions] Update error:', err.message);
        res.status(500).json({ error: 'Failed to update' });
    }
});

// ── Regenerate summary with template ─────────────────────

router.post('/:id/regenerate-summary', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const userOrgId = await resolveUserOrgFromReq(req);
        const { template = 'general' } = req.body;
        const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
        const transcription = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
        if (!transcription) return res.status(404).json({ error: 'Not found' });
        if (!transcription.isOwner) return res.status(403).json({ error: 'Only the owner can regenerate the summary' });
        if (!transcription.transcript) return res.status(400).json({ error: 'No transcript available' });

        const templatePrompt = SUMMARY_TEMPLATES[template] || SUMMARY_TEMPLATES.general;
        const langName = { nl: 'Dutch', en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese' }[transcription.language] || transcription.language;

        const modelId = await resolveSmartModel(userOrgId);
        const result = await llmClient.chat(modelId, [
            { role: 'system', content: `You are a meeting assistant. Write the summary in ${langName}.

${templatePrompt}` },
            { role: 'user', content: transcription.transcript },
        ], { maxTokens: 4096, temperature: 0.3 });

        const summary = (result.content || '').trim();
        // Also re-extract action items
        const actionItems = await extractActionItems(transcription.transcript, transcription.language, userOrgId);

        await transcriptionStore.updateTranscription(req.params.id, userId, { summary, actionItems });
        res.json({ success: true, summary, actionItems });
    } catch (err) {
        console.error('[Transcriptions] Regenerate summary error:', err.message);
        res.status(500).json({ error: `Failed to regenerate: ${err.message}` });
    }
});

// ── Export transcription ─────────────────────────────────

router.get('/:id/export', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const format = req.query.format || 'md';
        const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
        const transcription = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
        if (!transcription) return res.status(404).json({ error: 'Not found' });

        const title = transcription.title || 'Meeting Notes';
        const date = transcription.createdAt ? new Date(transcription.createdAt).toLocaleDateString('en-US', { dateStyle: 'long' }) : '';
        const duration = formatDuration(transcription.durationSeconds);
        const speakers = (transcription.speakers || []).map(s => s.id).join(', ');

        // Build action items section
        const actionItemsText = (transcription.actionItems || []).length > 0
            ? '## 📌 Action Items\n' + transcription.actionItems.map(ai => `- [${ai.done ? 'x' : ' '}] ${ai.text} (${ai.assignee})${ai.timestamp ? ` — ${ai.timestamp}` : ''}`).join('\n')
            : '';

        if (format === 'md') {
            const md = `# ${title}\n\n**Date:** ${date}  \n**Duration:** ${duration}  \n**Speakers:** ${speakers}\n\n---\n\n${transcription.summary || ''}\n\n${actionItemsText}\n\n---\n\n## Transcript\n\n${transcription.transcript || transcription.fullText || ''}`;
            res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${title.replace(/[^a-zA-Z0-9 ]/g, '')}.md"`);
            res.send(md);
        } else if (format === 'txt') {
            const txt = `${title}\nDate: ${date}\nDuration: ${duration}\nSpeakers: ${speakers}\n\n${'='.repeat(50)}\n\n${(transcription.summary || '').replace(/[#*]/g, '')}\n\n${'='.repeat(50)}\n\n${(transcription.actionItems || []).length > 0 ? 'ACTION ITEMS:\n' + transcription.actionItems.map(ai => `[${ai.done ? 'X' : ' '}] ${ai.text} (${ai.assignee})`).join('\n') + '\n\n' + '='.repeat(50) + '\n\n' : ''}TRANSCRIPT:\n\n${transcription.transcript || transcription.fullText || ''}`;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${title.replace(/[^a-zA-Z0-9 ]/g, '')}.txt"`);
            res.send(txt);
        } else {
            res.status(400).json({ error: 'Unsupported format. Use: md, txt' });
        }
    } catch (err) {
        console.error('[Transcriptions] Export error:', err.message);
        res.status(500).json({ error: 'Failed to export' });
    }
});

// ── Delete transcription ─────────────────────────────────

router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const deleted = await transcriptionStore.deleteTranscription(req.params.id, userId);
        if (!deleted) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Transcriptions] Delete error:', err.message);
        res.status(500).json({ error: 'Failed to delete' });
    }
});

// ── Publish to org / groups ──────────────────────────────
//
// Mirrors the publish model used by Knowledge Bases:
//   - `isPublished: false`            → Personal (only the owner)
//   - `isPublished: true, []`         → Entire organisation
//   - `isPublished: true, [gid…]`     → Specific org groups
//
// Owner-only. Validates that supplied group IDs belong to the owner's org.

router.patch('/:id/publish', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { isPublished, sharedGroups } = req.body;
        if (typeof isPublished !== 'boolean') {
            return res.status(400).json({ error: 'isPublished must be a boolean' });
        }
        if (sharedGroups !== undefined && !Array.isArray(sharedGroups)) {
            return res.status(400).json({ error: 'sharedGroups must be an array' });
        }

        const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
        const transcription = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
        if (!transcription) return res.status(404).json({ error: 'Not found' });
        if (!transcription.isOwner) return res.status(403).json({ error: 'Only the owner can change publish status' });

        // Validate the supplied group IDs against the transcription's org so
        // a user can't accidentally publish to another org's groups.
        const orgIdForValidation = transcription.organizationId || await resolveUserOrgFromReq(req);
        let cleanedGroups = [];
        if (isPublished && Array.isArray(sharedGroups) && sharedGroups.length > 0) {
            if (!orgIdForValidation) {
                return res.status(400).json({ error: 'Cannot publish: no organization context for this transcription.' });
            }
            const { validateSharedGroupsForOrg } = require('../auth');
            try {
                cleanedGroups = await validateSharedGroupsForOrg(orgIdForValidation, sharedGroups);
            } catch (err) {
                return res.status(400).json({ error: err.message || 'Invalid shared groups' });
            }
        }

        await transcriptionStore.setPublished(req.params.id, userId, isPublished, cleanedGroups);
        res.json({ success: true, isPublished, sharedGroups: cleanedGroups });
    } catch (err) {
        console.error('[Transcriptions] Publish error:', err.message);
        res.status(500).json({ error: 'Failed to update publish status' });
    }
});

// ── Edit speakers (rename + merge) ───────────────────────
//
// Atomic edit operation. Payload:
//   { renames: { "Charles": "Tjalle" },
//     merges:  [{ from: ["Tjalle", "Charles"], into: "Tjalle" }] }
//
// Merges run first (collapse multiple speaker IDs into one), then renames
// (straight rename across all remaining speaker IDs). The transcript
// string is rebuilt from segments so it stays in sync with the labels.
// Owner-only.

router.patch('/:id/speakers', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { renames = {}, merges = [] } = req.body || {};
        if (renames && typeof renames !== 'object') {
            return res.status(400).json({ error: 'renames must be an object' });
        }
        if (merges && !Array.isArray(merges)) {
            return res.status(400).json({ error: 'merges must be an array' });
        }

        const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
        const transcription = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
        if (!transcription) return res.status(404).json({ error: 'Not found' });
        if (!transcription.isOwner) return res.status(403).json({ error: 'Only the owner can edit speakers' });

        // Build a single name-mapping pass. For each merge, every `from`
        // name maps to `into`. Then apply renames on top. Order matters:
        // merge first so a subsequent rename of the merged identity also
        // moves any leftover references that were already pointing at it.
        const mapping = new Map();
        for (const merge of merges) {
            const into = String(merge?.into || '').trim();
            const from = Array.isArray(merge?.from) ? merge.from : [];
            if (!into || from.length === 0) continue;
            for (const name of from) {
                if (typeof name === 'string' && name.trim()) {
                    mapping.set(name, into);
                }
            }
        }
        for (const [oldName, newName] of Object.entries(renames)) {
            if (typeof newName !== 'string' || !newName.trim()) continue;
            const trimmed = newName.trim();
            // If the oldName was itself the target of a merge, follow the chain.
            mapping.set(oldName, trimmed);
            // Also update any existing mapping VALUES that pointed to oldName.
            for (const [k, v] of mapping.entries()) {
                if (v === oldName) mapping.set(k, trimmed);
            }
        }

        const remap = (name) => mapping.get(name) || name;

        // Rewrite segments.
        const segments = (transcription.segments || []).map(seg => ({
            ...seg,
            speaker: remap(seg.speaker || seg.speakerId),
        }));

        // Rebuild speakers list — collapse duplicates that now share a name.
        const collected = {};
        for (const s of (transcription.speakers || [])) {
            const newId = remap(s.id);
            if (!collected[newId]) {
                collected[newId] = { id: newId, speakingSeconds: 0, segments: 0 };
            }
            collected[newId].speakingSeconds += Number(s.speakingSeconds || 0);
            collected[newId].segments += Number(s.segments || 0);
        }
        const fmtTime = (secs) => {
            if (secs == null) return '00:00';
            const h = Math.floor(secs / 3600);
            const m = Math.floor((secs % 3600) / 60);
            const s = Math.floor(secs % 60);
            if (h > 0) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
            return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
        };
        const speakers = Object.values(collected).map(s => ({
            ...s,
            speakingTime: fmtTime(s.speakingSeconds),
        }));

        // Rebuild the transcript string from segments so it stays in sync
        // with the new labels. Matches the format used at create time.
        const transcript = segments
            .map(s => `[${s.speaker}] ${fmtTime(s.start)} - ${fmtTime(s.end)}: ${s.text || ''}`)
            .join('\n');

        await transcriptionStore.updateTranscription(req.params.id, userId, {
            segments,
            speakers,
            transcript,
        });

        const updated = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
        res.json(updated);
    } catch (err) {
        console.error('[Transcriptions] Speaker edit error:', err.message);
        res.status(500).json({ error: 'Failed to update speakers' });
    }
});

// ── Nextcloud audio ingest ───────────────────────────────
//
// Two endpoints that let the user pull a recording from their Nextcloud
// Files into the meeting-notes pipeline without first downloading it
// manually. Notes themselves stay in Bee Flow — there is no writeback
// to NC. Auth uses the existing `nextcloudClient.resolveAuth` so OAuth,
// app-password and ExApp-connector sessions all work transparently.

const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.flac', '.mp4', '.mpeg', '.aac'];
// Recording ingest helpers (single source of truth for accepted extensions +
// Talk room-token path parsing) live with the ingest pipeline.
const { ACCEPTED_RECORDING_EXTS, parseTalkRoomToken } = require('../core/meetingNotes/ingestNextcloudRecording');

/** Resolve the configured Talk recordings folder (org+user scoped, default /Talk). */
async function resolveRecordingFolder(orgId, userId) {
    try {
        const { resolveTalkNotesSettings } = require('../core/meetingNotes/talkNotesSettings');
        const s = await resolveTalkNotesSettings({ orgId, userId });
        return s.recordingFolder || '/Talk';
    } catch (_) { return '/Talk'; }
}

router.get('/nextcloud-audio-files', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const folder = (req.query.folder || '/Recordings').toString();
    try {
        const ncClient = require('../integrations/nextcloudClient');
        const ctx = await ncClient.resolveAuth(req.session, userId);
        const root = ncClient.webdavRoot(ctx.baseUrl, ctx.uid);
        // Encode each path segment so spaces / unicode survive WebDAV.
        const segs = folder.split('/').filter(Boolean).map(encodeURIComponent);
        const url = `${root}/${segs.join('/')}${segs.length ? '/' : ''}`;
        const propfind = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop><d:displayname/><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/><d:resourcetype/><oc:fileid/></d:prop>
</d:propfind>`;
        const r = await ctx.fetch(url, {
            method: 'PROPFIND',
            headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
            body: propfind,
        });
        if (r.status === 404) return res.status(404).json({ error: `Folder not found: ${folder}` });
        if (r.status === 401) return res.status(401).json({ error: ctx.authError || 'Nextcloud auth failed' });
        if (!r.ok) return res.status(502).json({ error: `Nextcloud PROPFIND failed (${r.status})` });

        const xml = await r.text();
        // Naive but sufficient parse — pull <d:response> blocks and extract href + props.
        const items = [];
        const blocks = xml.split(/<d:response[^>]*>/i).slice(1);
        for (const block of blocks) {
            const hrefMatch = block.match(/<d:href>([^<]+)<\/d:href>/i);
            if (!hrefMatch) continue;
            const href = decodeURIComponent(hrefMatch[1]);
            // Skip the folder itself (its href ends with the folder path)
            const folderHrefSuffix = (`/${segs.join('/')}/`).replace(/\/+$/, '/');
            if (href.endsWith(folderHrefSuffix)) continue;
            // Drop folders
            if (/<d:resourcetype>\s*<d:collection\s*\/>\s*<\/d:resourcetype>/i.test(block)) continue;

            const name = decodeURIComponent(href.split('/').filter(Boolean).pop() || '');
            const ext = path.extname(name).toLowerCase();
            if (!AUDIO_EXTS.includes(ext)) continue;

            const sizeMatch = block.match(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/i);
            const ctMatch   = block.match(/<d:getcontenttype>([^<]+)<\/d:getcontenttype>/i);
            const lmMatch   = block.match(/<d:getlastmodified>([^<]+)<\/d:getlastmodified>/i);

            // Reconstruct the path within the user's Files root from the href.
            // href example: /remote.php/dav/files/<uid>/Recordings/foo.mp3
            const filesRoot = `/remote.php/dav/files/${ctx.uid}/`;
            const idx = href.indexOf(filesRoot);
            const filePath = idx !== -1 ? '/' + href.slice(idx + filesRoot.length) : href;

            items.push({
                name,
                path: filePath,
                size: sizeMatch ? Number(sizeMatch[1]) : null,
                contentType: ctMatch ? ctMatch[1] : null,
                lastModified: lmMatch ? lmMatch[1] : null,
            });
        }
        items.sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || ''));
        res.json({ folder, count: items.length, items });
    } catch (err) {
        console.error('[Transcriptions] NC list error:', err.message);
        if (err.message === 'NOT_CONNECTED') {
            return res.status(400).json({ error: 'Nextcloud not connected for this account' });
        }
        res.status(500).json({ error: err.message });
    }
});

const VIDEO_EXTS = ['.mp4', '.webm', '.ogv', '.mkv', '.mpeg'];

// List Nextcloud Talk call recordings, grouped by conversation (room token).
// Talk stores each call's recording at <recordingFolder>/<roomToken>/<file>,
// so a recursive PROPFIND of the recordings folder + room-token parsing yields
// the per-room recordings the user can import into Meeting Notes.
router.get('/nextcloud-talk-recordings', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    try {
        const userOrgId = await resolveUserOrgFromReq(req);
        const folder = (req.query.folder || await resolveRecordingFolder(userOrgId, userId)).toString();

        const ncClient = require('../integrations/nextcloudClient');
        const ctx = await ncClient.resolveAuth(req.session, userId);
        const root = ncClient.webdavRoot(ctx.baseUrl, ctx.uid);
        const segs = folder.split('/').filter(Boolean).map(encodeURIComponent);
        const url = `${root}/${segs.join('/')}${segs.length ? '/' : ''}`;
        const propfind = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop><d:displayname/><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/><d:resourcetype/></d:prop>
</d:propfind>`;
        // Depth: infinity walks the per-room subfolders in one round-trip.
        const r = await ctx.fetch(url, {
            method: 'PROPFIND',
            headers: { 'Depth': 'infinity', 'Content-Type': 'application/xml; charset=utf-8' },
            body: propfind,
        });
        if (r.status === 404) return res.json({ folder, count: 0, rooms: [] }); // no recordings yet
        if (r.status === 401) return res.status(401).json({ error: ctx.authError || 'Nextcloud auth failed' });
        if (!r.ok) return res.status(502).json({ error: `Nextcloud PROPFIND failed (${r.status})` });

        const xml = await r.text();
        const filesRoot = `/remote.php/dav/files/${ctx.uid}/`;
        const roomsMap = new Map();
        const blocks = xml.split(/<d:response[^>]*>/i).slice(1);
        for (const block of blocks) {
            const hrefMatch = block.match(/<d:href>([^<]+)<\/d:href>/i);
            if (!hrefMatch) continue;
            const href = decodeURIComponent(hrefMatch[1]);
            if (/<d:resourcetype>\s*<d:collection\s*\/>\s*<\/d:resourcetype>/i.test(block)) continue; // folders

            const name = decodeURIComponent(href.split('/').filter(Boolean).pop() || '');
            const ext = path.extname(name).toLowerCase();
            if (!ACCEPTED_RECORDING_EXTS.includes(ext)) continue;

            const idx = href.indexOf(filesRoot);
            const filePath = idx !== -1 ? '/' + href.slice(idx + filesRoot.length) : href;
            const token = parseTalkRoomToken(filePath, folder);
            if (!token) continue;

            const sizeMatch = block.match(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/i);
            const lmMatch   = block.match(/<d:getlastmodified>([^<]+)<\/d:getlastmodified>/i);

            if (!roomsMap.has(token)) roomsMap.set(token, []);
            roomsMap.get(token).push({
                name,
                path: filePath,
                size: sizeMatch ? Number(sizeMatch[1]) : null,
                lastModified: lmMatch ? lmMatch[1] : null,
                kind: VIDEO_EXTS.includes(ext) ? 'video' : 'audio',
            });
        }

        const rooms = Array.from(roomsMap.entries()).map(([token, recordings]) => {
            recordings.sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || ''));
            return { token, recordings, lastModified: recordings[0]?.lastModified || null };
        });
        rooms.sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || ''));

        res.json({ folder, count: rooms.reduce((n, rm) => n + rm.recordings.length, 0), rooms });
    } catch (err) {
        console.error('[Transcriptions] Talk recordings list error:', err.message);
        if (err.message === 'NOT_CONNECTED') {
            return res.status(400).json({ error: 'Nextcloud not connected for this account' });
        }
        res.status(500).json({ error: err.message });
    }
});

router.post('/from-nextcloud', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const userOrgId = await resolveUserOrgFromReq(req);
    const { nextcloud_path, language = 'nl', provider: requestedProvider, title: titleHint, context_terms } = req.body || {};

    if (!nextcloud_path || typeof nextcloud_path !== 'string') {
        return res.status(400).json({ error: 'nextcloud_path is required' });
    }

    req.setTimeout(600000); res.setTimeout(600000);

    try {
        // A recording living under the Talk recordings folder carries its room
        // token as the first path segment; resolve write-back settings for it.
        const talkRoomToken = parseTalkRoomToken(nextcloud_path, await resolveRecordingFolder(userOrgId, userId));
        let postSummaryBack = false;
        if (talkRoomToken) {
            const { resolveTalkNotesSettings } = require('../core/meetingNotes/talkNotesSettings');
            const settings = await resolveTalkNotesSettings({ orgId: userOrgId, userId });
            postSummaryBack = !!settings.postSummaryBack;
        }

        const { ingestNextcloudRecording } = require('../core/meetingNotes/ingestNextcloudRecording');
        const out = await ingestNextcloudRecording({
            userId, session: req.session, orgId: userOrgId,
            ncPath: nextcloud_path, language,
            provider: requestedProvider, contextTerms: context_terms || '',
            titleHint,
            source: talkRoomToken ? 'talk' : 'nextcloud',
            talkRoomToken, postSummaryBack,
        });
        res.json(out);
    } catch (err) {
        console.error('[Transcriptions] from-nextcloud failed:', err.message);
        res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
});

// ── Upcoming Talk meetings (calendar-linked) ─────────────
//
// Powers the Meeting Notes "Upcoming" view: the user's calendar Talk meetings,
// each enriched with whether they moderate it, live call/recording state, the
// per-meeting record toggle (exclusion), and a status chip.

router.get('/talk-meetings', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    try {
        const userOrgId = await resolveUserOrgFromReq(req);
        const talk = require('../integrations/nextcloudTalkTools');
        const { listUpcomingTalkMeetings } = require('../core/meetingNotes/talkCalendar');
        const { resolveTalkNotesSettings } = require('../core/meetingNotes/talkNotesSettings');

        const cap = await talk.getTalkRecordingCapability(req.session, userId);
        const settings = await resolveTalkNotesSettings({ orgId: userOrgId, userId });
        const meetings = await listUpcomingTalkMeetings({ session: req.session, userId, windowHours: 48 });

        // One room list to enrich moderator + call/recording state by token.
        const roomsByToken = {};
        try {
            const roomsRes = await talk.executeNextcloudTalkTool('nextcloud_talk_list_rooms', {}, userId, req.session);
            if (roomsRes && Array.isArray(roomsRes.rooms)) for (const r of roomsRes.rooms) roomsByToken[r.token] = r;
        } catch (_) { /* best-effort enrichment */ }

        const excludedTokens = new Set(settings.excludedRoomTokens || []);
        const excludedUids = new Set(settings.excludedEventUids || []);

        const out = [];
        for (const m of meetings) {
            const room = roomsByToken[m.talkToken] || null;
            const isModerator = room ? [1, 2].includes(room.participantType) : null;
            const recordingNow = !!(room && room.callRecording && room.callRecording !== 0);
            const excluded = excludedTokens.has(m.talkToken) || (m.uid && excludedUids.has(m.uid));
            let recordedNoteId = null;
            try {
                const t = await transcriptionStore.getTranscriptionByTalkRoomToken(m.talkToken, userId);
                if (t) recordedNoteId = t.id;
            } catch (_) { /* ignore */ }

            let status;
            if (recordingNow) status = 'recording_now';
            else if (recordedNoteId) status = 'recorded';
            else if (isModerator === false) status = 'not_moderator';
            else if (settings.autoRecord && cap.recordingEnabled && !excluded && isModerator) status = 'will_record';
            else status = 'upcoming';

            out.push({ ...m, isModerator, recordingNow, excluded, recordedNoteId, status });
        }

        res.json({
            recordingEnabled: cap.recordingEnabled,
            autoRecord: settings.autoRecord,
            autoRecordScope: settings.autoRecordScope,
            recordingMode: settings.recordingMode,
            count: out.length,
            meetings: out,
        });
    } catch (err) {
        console.error('[Transcriptions] talk-meetings error:', err.message);
        if (err.message === 'NOT_CONNECTED') return res.status(400).json({ error: 'Nextcloud not connected for this account' });
        res.status(500).json({ error: err.message });
    }
});

// Toggle a single meeting's auto-record on/off (writes the user's exclusions).
router.patch('/talk-meetings/:token', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const token = req.params.token;
    const { record, eventUid } = req.body || {};
    try {
        const { setMeetingRecord } = require('../core/meetingNotes/talkNotesSettings');
        await setMeetingRecord(userId, { roomToken: token, eventUid: eventUid || null, record: !!record });
        res.json({ ok: true, token, record: !!record });
    } catch (err) {
        console.error('[Transcriptions] talk-meetings PATCH error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Multer error handling ────────────────────────────────

router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large. Maximum size is 500 MB.' });
        }
        return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
});

module.exports = router;
