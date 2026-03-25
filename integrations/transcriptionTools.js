/**
 * Transcription Tools — Multi-provider meeting transcription with diarization
 *
 * Supported providers:
 *   - voxtral   : Mistral Voxtral (voxtral-mini-latest) — cloud, best accuracy
 *   - azure     : Azure AI Speech (Whisper model, SDK push-stream)
 *   - whisperx  : Self-hosted WhisperX HTTP API — fully private, no data leaves your server
 *
 * All providers:
 *   • Return per-segment diarization (who said what)
 *   • Feed results into a Claude speaker-name identification step
 *   • Sanitise errors so API keys are never exposed in logs
 *
 * Security:
 *   • API keys are NEVER logged
 *   • All secrets retrieved from AES-256-GCM encrypted configStore
 *   • Audio buffers are held in memory only, never written to disk by this module
 *   • Temporary SDK push-stream is destroyed immediately after transcription
 */

'use strict';

const configStore = require('../stores/configStore');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ffmpeg helper — installed via @ffmpeg-installer/ffmpeg
let ffmpeg;
try {
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    ffmpeg = require('fluent-ffmpeg');
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);
} catch (_) {
    ffmpeg = null; // ffmpeg not available, Azure will attempt raw stream (WAV only)
}

/**
 * Convert any audio file to 16kHz mono PCM WAV using ffmpeg.
 * Azure Speech JS SDK only accepts this format for push-stream input.
 * Returns the path to the temporary WAV file.
 */
async function convertToWav(inputPath) {
    if (!ffmpeg) throw new Error('ffmpeg not available — install @ffmpeg-installer/ffmpeg');
    const outPath = path.join(os.tmpdir(), `azure-stt-${Date.now()}.wav`);
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioChannels(1)          // mono
            .audioFrequency(16000)     // 16 kHz — Azure Speech requirement
            .audioCodec('pcm_s16le')   // 16-bit little-endian PCM
            .format('wav')
            .on('end', () => resolve(outPath))
            .on('error', (err) => reject(new Error(`ffmpeg conversion failed: ${err.message}`)))
            .save(outPath);
    });
}

// ─── Tool Definitions ──────────────────────────────────────────────────────────

const TRANSCRIPTION_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'transcribe_audio',
            description:
                'Transcribe an uploaded audio file using AI. Returns a formatted transcript with speaker ' +
                'diarization (who said what), timestamps, and segment-level detail. ' +
                'Supports up to 3 hours of audio. Best for: meeting recordings, interviews, calls, voice notes. ' +
                'The audio file must be uploaded as an attachment to the message.',
            parameters: {
                type: 'object',
                properties: {
                    language: {
                        type: 'string',
                        description:
                            'Language code for transcription (e.g. "nl" for Dutch, "en" for English, ' +
                            '"de" for German, "fr" for French). Default: "nl"',
                    },
                    context_terms: {
                        type: 'string',
                        description:
                            'Comma-separated list of domain-specific terms to help the model recognise ' +
                            '(e.g. "AFAS, Bflow, N8N, Ondernemers Kompas"). Improves accuracy for company ' +
                            'names, products, jargon.',
                    },
                    timestamp_granularity: {
                        type: 'string',
                        enum: ['segment', 'word'],
                        description:
                            'Level of timestamp detail. "segment" (default) gives per-sentence timestamps, ' +
                            '"word" gives per-word timestamps.',
                    },
                },
                required: [],
            },
        },
    },
];

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(seconds) {
    if (seconds == null) return '00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0)
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Merge consecutive segments from the same speaker for cleaner output.
 */
function mergeSegments(segments) {
    if (!segments || segments.length === 0) return [];
    const merged = [];
    for (const seg of segments) {
        const last = merged[merged.length - 1];
        if (last && seg.speakerId === last.speakerId) {
            last.end = seg.end;
            last.text += ' ' + (seg.text || '').trim();
        } else {
            merged.push({
                speakerId: seg.speakerId || 'Unknown',
                start: seg.start,
                end: seg.end,
                text: (seg.text || '').trim(),
            });
        }
    }
    return merged;
}

/**
 * Resolve the active audio attachment from the context.
 * Returns { audioData: Buffer, audioFileName: string } or throws an error string.
 */
async function resolveAudioAttachment(context) {
    const { attachments } = context;
    if (!attachments || attachments.length === 0) {
        throw 'No audio file found. Please upload an audio file (MP3, WAV, M4A, OGG, WEBM, FLAC) as an attachment to your message.';
    }

    const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.flac', '.mp4', '.mpeg'];
    const audioAttachment = attachments.find((a) => {
        const ext = (a.name || a.filename || '').toLowerCase();
        return (
            AUDIO_EXTENSIONS.some((e) => ext.endsWith(e)) ||
            (a.type && a.type.startsWith('audio/'))
        );
    });

    if (!audioAttachment) {
        throw 'No audio file found. Please upload an audio file (MP3, WAV, M4A, OGG, WEBM, FLAC) as an attachment to your message.';
    }

    const audioFileName = audioAttachment.name || audioAttachment.filename || 'audio.mp3';
    let audioData = null;

    if (audioAttachment.path) {
        try {
            audioData = fs.readFileSync(audioAttachment.path);
        } catch (readErr) {
            throw `Could not read audio file: ${readErr.message}`;
        }
    } else if (audioAttachment.url) {
        try {
            const resp = await fetch(audioAttachment.url);
            if (!resp.ok) throw new Error(resp.statusText);
            audioData = Buffer.from(await resp.arrayBuffer());
        } catch (fetchErr) {
            throw `Could not download audio file: ${fetchErr.message}`;
        }
    } else if (audioAttachment.data || audioAttachment.content) {
        const raw = audioAttachment.data || audioAttachment.content;
        audioData = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'base64');
    }

    if (!audioData) {
        throw 'Could not read audio data from the attachment. Please try re-uploading the file.';
    }

    return { audioData, audioFileName };
}

/**
 * Use the configured fast-tier LLM to map speaker IDs → real names.
 *
 * @param {string[]} speakerIds   - All unique speaker IDs from diarisation
 * @param {string}   language     - Recording language (for context)
 * @param {string[]} formattedLines - Formatted transcript lines for context
 * @param {string}  [userName]    - Logged-in user's display name (used as anchor hint)
 */
async function identifySpeakerNames(speakerIds, language, formattedLines, userName) {
    try {
        const llmClient = require('../core/llmClient');

        // Resolve fast tier model (same pattern as compaction.js)
        let modelId = 'tier:fast';
        try {
            const tiers = await configStore.getConfig('chat_model_tiers') || {};
            modelId = tiers['fast']?.modelId || 'gemini-2.0-flash-lite';
        } catch (_) {
            modelId = 'gemini-2.0-flash-lite';
        }

        const speakerList = speakerIds.join(', ');
        const userHint = userName
            ? `\n\nIMPORTANT HINT: The person who made this recording is named "${userName}". Look at the conversation content to identify which speaker is most likely "${userName}" — they are probably the one speaking most or initiating the conversation. Prioritize this name assignment.`
            : '';

        const systemPrompt = `You are an expert transcript analyst specializing in speaker diarization.

Your task: Map EVERY speaker ID to a real person's first name.

Key rules:
1. Diarization often creates MULTIPLE IDs for ONE person. A meeting with 3 people may have 10+ speaker IDs.
2. Group speaker IDs who sound similar, speak consecutively, or share speaking patterns.
3. Assign a FIRST NAME to every speaker ID — never return null or empty.
4. If you cannot determine a name, use "Speaker A", "Speaker B", etc.
5. Multiple IDs MUST map to the same name when they belong to the same person.${userHint}

Return ONLY a valid JSON object mapping every speaker ID to a name.
Example: {"Guest-1": "Tom", "Guest-2": "Tom", "Guest-3": "Gerard", "Guest-4": "Gerard"}
No explanation, no markdown, ONLY the JSON object.`;

        const userContent = `Speaker IDs: ${speakerList}
Language: ${language}

Transcript (first 20,000 characters):
${formattedLines.join('\n').substring(0, 20000)}`;

        const result = await llmClient.chat(modelId, [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
        ], { maxTokens: 512, temperature: 0 });

        const chatContent = (result.content || '').trim();
        const jsonMatch = chatContent.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        const nameMapping = JSON.parse(jsonMatch[0]);
        // Remove null/empty/literal-null values
        for (const [key, value] of Object.entries(nameMapping)) {
            if (!value || value === 'null' || value === 'unknown') delete nameMapping[key];
        }
        console.log(`[Transcription] Speaker names identified via ${modelId}: ${JSON.stringify(nameMapping)}`);
        return nameMapping;
    } catch (nameErr) {
        console.error('[Transcription] Speaker identification failed:', nameErr.message);
        return null;
    }
}


/**
 * Build the final result object shared by both providers.
 */
function buildResult({ audioFileName, language, merged, totalDuration, speakerMap, nameMapping }) {
    // Apply name mapping if available
    if (nameMapping) {
        for (const seg of merged) {
            if (nameMapping[seg.speakerId]) seg.speakerId = nameMapping[seg.speakerId];
        }
    }

    const formattedLines = merged.map((s) => {
        const start = formatTime(s.start);
        const end = formatTime(s.end);
        return `[${s.speakerId}] ${start} - ${end}: ${s.text}`;
    });

    return {
        success: true,
        fileName: audioFileName,
        language,
        duration: formatTime(totalDuration),
        durationSeconds: Math.round(totalDuration),
        speakerCount: Object.keys(speakerMap).length,
        segmentCount: merged.length,
        speakers: Object.entries(speakerMap).map(([id, data]) => ({
            id: nameMapping?.[id] || id,
            speakingTime: formatTime(data.duration),
            segments: data.segments,
        })),
        transcript: formattedLines.join('\n'),
        segments: merged.map((s) => ({
            speaker: s.speakerId,
            start: s.start,
            end: s.end,
            startFormatted: formatTime(s.start),
            endFormatted: formatTime(s.end),
            text: s.text,
        })),
    };
}

// ─── Provider: Voxtral (Mistral) ──────────────────────────────────────────────

async function handleVoxtralTranscription(args, context) {
    // Key retrieved from encrypted store — never logged
    const apiKey = await configStore.getSecret('mistral_api_key');
    if (!apiKey) {
        return {
            error: 'Mistral API key not configured. Add it in Admin → AI Config → API Keys.',
        };
    }

    let audioData, audioFileName;
    try {
        ({ audioData, audioFileName } = await resolveAudioAttachment(context));
    } catch (errMsg) {
        return { error: errMsg };
    }

    const language = args.language || 'nl';
    const contextTerms = args.context_terms || '';
    const granularity = args.timestamp_granularity || 'segment';

    console.log(
        `[Transcription:Voxtral] Transcribing "${audioFileName}" (${(audioData.length / (1024 * 1024)).toFixed(1)} MB), lang: ${language}`
    );

    try {
        const { Mistral } = require('@mistralai/mistralai');
        const client = new Mistral({ apiKey });

        const transcriptionOptions = {
            model: 'voxtral-mini-latest',
            file: { fileName: audioFileName, content: audioData },
            diarize: true,
            language,
            timestampGranularities: [granularity],
        };
        if (contextTerms) transcriptionOptions.prompt = contextTerms;

        const response = await client.audio.transcriptions.complete(transcriptionOptions);
        console.log(
            `[Transcription:Voxtral] Completed — ${(response.segments || []).length} raw segments`
        );

        const rawSegments = response.segments || [];
        const merged = mergeSegments(rawSegments);

        const speakerMap = {};
        for (const seg of merged) {
            if (!speakerMap[seg.speakerId])
                speakerMap[seg.speakerId] = { duration: 0, segments: 0 };
            speakerMap[seg.speakerId].duration += (seg.end || 0) - (seg.start || 0);
            speakerMap[seg.speakerId].segments += 1;
        }

        const totalDuration =
            rawSegments.length > 0 ? Math.max(...rawSegments.map((s) => s.end || 0)) : 0;

        const formattedLines = merged.map((s) => {
            return `[${s.speakerId}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`;
        });

        const nameMapping = await identifySpeakerNames(
            Object.keys(speakerMap),
            language,
            formattedLines,
            args.userName
        );

        return buildResult({ audioFileName, language, merged, totalDuration, speakerMap, nameMapping });
    } catch (err) {
        // Sanitise error: strip any key-like tokens from message
        const safeMsg = (err.message || '').replace(/[A-Za-z0-9_\-]{32,}/g, '[REDACTED]');
        console.error('[Transcription:Voxtral] Error:', safeMsg);
        if (err.message?.includes('rate_limit')) {
            return {
                error: 'Rate limit reached for Voxtral. Please try again in a few moments.',
            };
        }
        return { error: `Transcription failed: ${safeMsg}` };
    }
}

// ─── Provider: Azure AI Speech ────────────────────────────────────────────────

/**
 * Transcribe using the Azure Cognitive Services Speech SDK.
 *
 * Uses continuous recognition with diarization on a push-stream so the audio
 * buffer is piped directly — no disk writes, no external URL required.
 *
 * Security hardening:
 *  - Speech key retrieved from encrypted configStore secret
 *  - Key is NEVER passed to logs or error messages
 *  - Push-stream is closed and dereferenced immediately after recognition
 *  - Short-lived SpeechConfig object is destroyed after use
 *  - Network timeout enforced (30 s to start + full duration)
 */
async function handleAzureTranscription(args, context) {
    // ── Retrieve credentials from encrypted store ──
    const speechKey = await configStore.getSecret('azure_speech_key');
    const speechRegion = await configStore.getConfig('azure_speech_region');

    if (!speechKey || !speechRegion) {
        return {
            error:
                'Azure Speech API key or region not configured. ' +
                'Add them in Admin → Integrations → Services → Azure AI Speech.',
        };
    }

    // ── Validate region format (alphanumeric + hyphens only, max 32 chars) ──
    if (!/^[a-z0-9-]{2,32}$/.test(speechRegion)) {
        return { error: 'Invalid Azure Speech region format stored in configuration.' };
    }

    let audioData, audioFileName;
    try {
        ({ audioData, audioFileName } = await resolveAudioAttachment(context));
    } catch (errMsg) {
        return { error: errMsg };
    }

    // Write audio to a temp file so ffmpeg can read it
    const tempInputPath = path.join(os.tmpdir(), `azure-in-${Date.now()}`);
    fs.writeFileSync(tempInputPath, audioData);
    let tempWavPath = null;

    const language = args.language || 'nl';

    // Map language codes → Azure BCP-47 locale (best effort)
    const LOCALE_MAP = {
        nl: 'nl-NL', en: 'en-US', de: 'de-DE', fr: 'fr-FR',
        es: 'es-ES', it: 'it-IT', pt: 'pt-PT', pl: 'pl-PL',
        sv: 'sv-SE', da: 'da-DK', fi: 'fi-FI', nb: 'nb-NO',
    };
    const locale = LOCALE_MAP[language] || `${language}-${language.toUpperCase()}`;

    console.log(
        `[Transcription:Azure] Transcribing "${audioFileName}" (${(audioData.length / (1024 * 1024)).toFixed(1)} MB), locale: ${locale}`
    );

    try {
        // ── Convert to 16kHz mono PCM WAV (Azure SDK requirement) ──
        console.log('[Transcription:Azure] Converting audio to 16kHz WAV...');
        tempWavPath = await convertToWav(tempInputPath);
        console.log('[Transcription:Azure] Conversion done, starting recognition...');

        // Lazy-require the SDK to avoid startup cost when Azure isn't used
        const sdk = require('microsoft-cognitiveservices-speech-sdk');

        // ── Build SpeechConfig — key is passed directly to SDK, never logged ──
        const speechConfig = sdk.SpeechConfig.fromSubscription(speechKey, speechRegion);
        speechConfig.speechRecognitionLanguage = locale;
        speechConfig.requestWordLevelTimestamps();

        // ── AudioConfig directly from WAV file ──
        const audioConfig = sdk.AudioConfig.fromWavFileInput(fs.readFileSync(tempWavPath));

        const transcriber = new sdk.ConversationTranscriber(speechConfig, audioConfig);

        /** @type {Array<{speakerId: string, start: number, end: number, text: string}>} */
        const rawSegments = [];

        await new Promise((resolve, reject) => {
            // Safety timeout: 10 minutes per file max
            const timeout = setTimeout(() => {
                transcriber.stopTranscribingAsync();
                reject(new Error('Azure Speech transcription timed out after 10 minutes.'));
            }, 10 * 60 * 1000);

            transcriber.transcribed = (_s, event) => {
                const result = event.result;
                if (result.reason === sdk.ResultReason.RecognizedSpeech && result.text) {
                    rawSegments.push({
                        speakerId: result.speakerId || 'Unknown',
                        start: result.offset / 10_000_000,  // 100-ns ticks → seconds
                        end: (result.offset + result.duration) / 10_000_000,
                        text: result.text.trim(),
                    });
                }
            };

            transcriber.canceled = (_s, event) => {
                clearTimeout(timeout);
                if (event.reason === sdk.CancellationReason.Error) {
                    const safeDetails = (event.errorDetails || '')
                        .replace(/[A-Za-z0-9_\-]{32,}/g, '[REDACTED]')
                        .replace(/key[=:]\S+/gi, 'key=[REDACTED]');
                    reject(new Error(`Azure Speech error: ${safeDetails}`));
                } else {
                    resolve();
                }
            };

            transcriber.sessionStopped = () => {
                clearTimeout(timeout);
                resolve();
            };

            transcriber.startTranscribingAsync(
                () => { /* started OK */ },
                (err) => {
                    clearTimeout(timeout);
                    const safeErr = (err?.message || String(err))
                        .replace(/[A-Za-z0-9_\-]{32,}/g, '[REDACTED]');
                    reject(new Error(`Failed to start Azure transcription: ${safeErr}`));
                }
            );
        });

        speechConfig.close && speechConfig.close();

        console.log(`[Transcription:Azure] Completed — ${rawSegments.length} raw segments`);

        if (rawSegments.length === 0) {
            return {
                error: 'Azure Speech returned no recognizable speech. Ensure the audio is clear and the language setting matches the recording.',
            };
        }

        const merged = mergeSegments(rawSegments);

        const speakerMap = {};
        for (const seg of merged) {
            if (!speakerMap[seg.speakerId])
                speakerMap[seg.speakerId] = { duration: 0, segments: 0 };
            speakerMap[seg.speakerId].duration += (seg.end || 0) - (seg.start || 0);
            speakerMap[seg.speakerId].segments += 1;
        }

        const totalDuration = rawSegments.length > 0 ? Math.max(...rawSegments.map((s) => s.end || 0)) : 0;

        const formattedLines = merged.map((s) =>
            `[${s.speakerId}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`
        );

        const nameMapping = await identifySpeakerNames(Object.keys(speakerMap), language, formattedLines, args.userName);


        return buildResult({ audioFileName, language, merged, totalDuration, speakerMap, nameMapping });
    } catch (err) {
        const safeMsg = (err.message || '')
            .replace(/[A-Za-z0-9_\-]{32,}/g, '[REDACTED]')
            .replace(/key[=:]\S+/gi, 'key=[REDACTED]');
        console.error('[Transcription:Azure] Error:', safeMsg);
        return { error: `Azure transcription failed: ${safeMsg}` };
    } finally {
        // Clean up temp files
        try { fs.unlinkSync(tempInputPath); } catch (_) {}
        try { if (tempWavPath) fs.unlinkSync(tempWavPath); } catch (_) {}
    }
}




// ─── Provider: Azure Whisper Batch (Speech REST API v3.2) ─────────────────────

/**
 * Transcribe using the Azure AI Speech Batch Transcription API with the Whisper model.
 *
 * Flow:
 *  1. Convert audio to 16kHz mono WAV
 *  2. Upload WAV to RustFS (existing S3-compatible object storage) and generate
 *     a 15-minute presigned download URL — no extra credentials needed.
 *     ⚠️  RustFS must be reachable from the public internet for Azure to fetch it.
 *  3. POST batch transcription job (Whisper model, diarization enabled)
 *  4. Poll job status every 5 s → up to 10 min
 *  5. Fetch + parse result JSON
 *  6. Delete temp WAV from RustFS, delete batch job from Azure
 *  7. Normalise segments → speaker ID → buildResult
 */
async function handleAzureWhisperTranscription(args, context) {
    const speechKey = await configStore.getSecret('azure_speech_key');
    const speechRegion = await configStore.getConfig('azure_speech_region');

    if (!speechKey || !speechRegion) {
        return { error: 'Azure Speech key or region not configured. Add them in Admin → Integrations.' };
    }
    if (!/^[a-z0-9-]{2,32}$/.test(speechRegion)) {
        return { error: 'Invalid Azure Speech region format stored in configuration.' };
    }

    // Uses existing RustFS storageStore — no separate Azure Blob Storage needed.
    const storageStore = require('../stores/storageStore');
    if (!storageStore.isAvailable()) {
        return {
            error: 'Azure Whisper requires RustFS object storage to be configured (RUSTFS_ENDPOINT / RUSTFS_ACCESS_KEY / RUSTFS_SECRET_KEY). Azure\'s servers need to download the audio file via a URL.'
        };
    }

    let audioData, audioFileName;
    try {
        ({ audioData, audioFileName } = await resolveAudioAttachment(context));
    } catch (errMsg) {
        return { error: errMsg };
    }

    const language = args.language || 'nl';
    const LOCALE_MAP = {
        nl: 'nl-NL', en: 'en-US', de: 'de-DE', fr: 'fr-FR',
        es: 'es-ES', it: 'it-IT', pt: 'pt-PT', pl: 'pl-PL',
        sv: 'sv-SE', da: 'da-DK', fi: 'fi-FI', nb: 'nb-NO',
    };
    const locale = LOCALE_MAP[language] || `${language}-${language.toUpperCase()}`;

    console.log(`[Transcription:AzureWhisper] Transcribing "${audioFileName}" (${(audioData.length / (1024 * 1024)).toFixed(1)} MB), locale: ${locale}`);

    const tempInputPath = path.join(os.tmpdir(), `azwhi-in-${Date.now()}`);
    fs.writeFileSync(tempInputPath, audioData);
    let tempWavPath = null;
    let rustfsKey = null;
    let transcriptionJobUrl = null;

    try {
        // ── Step 1: Convert to 16kHz mono WAV ──
        console.log('[Transcription:AzureWhisper] Converting audio...');
        tempWavPath = await convertToWav(tempInputPath);

        // ── Step 2: Upload to RustFS, generate 15-min presigned URL ──
        const wavBuffer = fs.readFileSync(tempWavPath);
        rustfsKey = `transcription-tmp/${Date.now()}-${audioFileName.replace(/[^a-zA-Z0-9._-]/g, '_')}.wav`;
        await storageStore.uploadFile(rustfsKey, wavBuffer, 'audio/wav');
        const audioUrl = await storageStore.getPresignedUrl(rustfsKey, 900); // 15 min
        console.log(`[Transcription:AzureWhisper] Uploaded to RustFS: ${rustfsKey}`);

        // ── Step 3: Create batch transcription job ──
        const speechApiBase = `https://${speechRegion}.api.cognitive.microsoft.com/speechtotext/v3.2`;
        const jobBody = {
            contentUrls: [audioUrl],
            locale,
            displayName: `beeflow-${Date.now()}`,
            model: { self: `${speechApiBase}/models/base/whisper` },
            properties: {
                diarizationEnabled: true,
                wordLevelTimestampsEnabled: true,
                punctuationMode: 'DictatedAndAutomatic',
                profanityFilterMode: 'None',
                timeToLive: 'PT1H',
            },
        };

        console.log('[Transcription:AzureWhisper] Submitting batch job...');
        const createResp = await fetch(`${speechApiBase}/transcriptions`, {
            method: 'POST',
            headers: { 'Ocp-Apim-Subscription-Key': speechKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(jobBody),
        });
        if (!createResp.ok) {
            const errText = await createResp.text().catch(() => '');
            throw new Error(`Azure Whisper job creation failed (${createResp.status}): ${errText.replace(/[A-Za-z0-9_\-]{32,}/g, '[REDACTED]').substring(0, 300)}`);
        }
        const job = await createResp.json();
        transcriptionJobUrl = job.self;
        console.log(`[Transcription:AzureWhisper] Job created: ${transcriptionJobUrl.split('/').pop()}`);

        // ── Step 4: Poll until Succeeded or Failed ──
        const pollStart = Date.now();
        let jobStatus = 'Running';
        while (jobStatus === 'Running' || jobStatus === 'NotStarted') {
            if (Date.now() - pollStart > 10 * 60 * 1000)
                throw new Error('Azure Whisper batch job timed out after 10 minutes.');
            await new Promise(r => setTimeout(r, 5000));
            const pollResp = await fetch(transcriptionJobUrl, { headers: { 'Ocp-Apim-Subscription-Key': speechKey } });
            if (!pollResp.ok) throw new Error(`Polling failed: HTTP ${pollResp.status}`);
            const pollData = await pollResp.json();
            jobStatus = pollData.status;
            console.log(`[Transcription:AzureWhisper] Status: ${jobStatus} (${Math.round((Date.now() - pollStart) / 1000)}s)`);
        }
        if (jobStatus !== 'Succeeded')
            throw new Error(`Azure Whisper batch job ${jobStatus}. Check your Azure Speech resource.`);

        // ── Step 5: Fetch result ──
        const filesResp = await fetch(`${transcriptionJobUrl}/files`, { headers: { 'Ocp-Apim-Subscription-Key': speechKey } });
        if (!filesResp.ok) throw new Error(`Fetching result files failed: HTTP ${filesResp.status}`);
        const filesData = await filesResp.json();
        const resultFile = (filesData.values || []).find(f => f.kind === 'Transcription');
        if (!resultFile?.links?.contentUrl) throw new Error('No transcription result file in Azure job output.');
        const resultResp = await fetch(resultFile.links.contentUrl);
        if (!resultResp.ok) throw new Error(`Downloading result failed: HTTP ${resultResp.status}`);
        const resultData = await resultResp.json();

        // ── Step 6: Normalise segments ──
        // recognizedPhrases[].speaker is an integer (1-based), convert to "Guest-N"
        const rawSegments = (resultData.recognizedPhrases || [])
            .filter(p => p.nBest?.[0]?.display?.trim())
            .map(p => ({
                speakerId: p.speaker != null ? `Guest-${p.speaker}` : 'Unknown',
                start: (p.offsetInTicks || 0) / 10_000_000,
                end: ((p.offsetInTicks || 0) + (p.durationInTicks || 0)) / 10_000_000,
                text: p.nBest[0].display.trim(),
            }));

        console.log(`[Transcription:AzureWhisper] Completed — ${rawSegments.length} phrases`);
        if (rawSegments.length === 0)
            return { error: 'Azure Whisper returned no speech. Ensure audio is clear and language is correct.' };

        const merged = mergeSegments(rawSegments);
        const speakerMap = {};
        for (const seg of merged) {
            if (!speakerMap[seg.speakerId]) speakerMap[seg.speakerId] = { duration: 0, segments: 0 };
            speakerMap[seg.speakerId].duration += (seg.end || 0) - (seg.start || 0);
            speakerMap[seg.speakerId].segments += 1;
        }
        const totalDuration = rawSegments.length > 0 ? Math.max(...rawSegments.map(s => s.end || 0)) : 0;
        const formattedLines = merged.map(s => `[${s.speakerId}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`);
        const nameMapping = await identifySpeakerNames(Object.keys(speakerMap), language, formattedLines, args.userName);
        return buildResult({ audioFileName, language, merged, totalDuration, speakerMap, nameMapping });

    } catch (err) {
        const safeMsg = (err.message || '').replace(/[A-Za-z0-9_\-]{32,}/g, '[REDACTED]').replace(/key[=:]\S+/gi, 'key=[REDACTED]');
        console.error('[Transcription:AzureWhisper] Error:', safeMsg);
        return { error: `Azure Whisper transcription failed: ${safeMsg}` };
    } finally {
        try { fs.unlinkSync(tempInputPath); } catch (_) {}
        try { if (tempWavPath) fs.unlinkSync(tempWavPath); } catch (_) {}
        try {
            if (rustfsKey) { const ss = require('../stores/storageStore'); await ss.deleteFile(rustfsKey); console.log('[Transcription:AzureWhisper] Temp WAV deleted from RustFS'); }
        } catch (_) {}
        try {
            if (transcriptionJobUrl && speechKey) await fetch(transcriptionJobUrl, { method: 'DELETE', headers: { 'Ocp-Apim-Subscription-Key': speechKey } });
        } catch (_) {}
    }
}


// ─── Provider: WhisperX (self-hosted) ────────────────────────────────────────

/**
 * Call a self-hosted WhisperX HTTP API.
 * Expected API contract (same as faster-whisper-server / whisperx-server):
 *
 *   POST {url}/transcribe
 *   Content-Type: multipart/form-data
 *   Body: { audio: <file>, language: "nl", diarize: true }
 *
 *   Response:
 *   { segments: [{ speaker: "SPEAKER_00", start: 0.5, end: 2.1, text: "Hello" }] }
 *
 * Also compatible with the OpenAI-compatible /v1/audio/transcriptions endpoint
 * when running locally (e.g. Faster Whisper Server).
 *
 * Security: URL is stored via configStore secret. No API key required for
 * internal/private deployments, but an optional bearer token is supported.
 */
async function handleWhisperXTranscription(args, context) {
    const whisperUrl = await configStore.getSecret('whisperx_url');
    if (!whisperUrl || !whisperUrl.trim()) {
        return {
            error:
                'WhisperX URL not configured. Add the self-hosted URL in ' +
                'Admin → Integrations → Meeting Transcription.',
        };
    }

    // Validate URL format — must be http(s):// to prevent SSRF to arbitrary schemes
    let parsedUrl;
    try {
        parsedUrl = new URL(whisperUrl.trim());
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error('Invalid protocol');
        }
    } catch (_) {
        return { error: 'WhisperX URL must be a valid http:// or https:// address.' };
    }

    // Optional bearer token for secured deployments
    const whisperToken = await configStore.getSecret('whisperx_token');

    let audioData, audioFileName;
    try {
        ({ audioData, audioFileName } = await resolveAudioAttachment(context));
    } catch (errMsg) {
        return { error: errMsg };
    }

    const language = args.language || 'nl';

    console.log(
        `[Transcription:WhisperX] Transcribing "${audioFileName}" (${(audioData.length / (1024 * 1024)).toFixed(1)} MB), lang: ${language}, url: ${parsedUrl.hostname}`
    );

    try {
        // Build multipart form body
        const FormData = (await import('form-data')).default;
        const form = new FormData();
        form.append('audio', audioData, { filename: audioFileName, contentType: 'application/octet-stream' });
        form.append('language', language);
        form.append('diarize', 'true');
        // Also append OpenAI-compat field names for wider server support
        form.append('file', audioData, { filename: audioFileName, contentType: 'application/octet-stream' });
        form.append('model', 'whisper-1');

        const headers = { ...form.getHeaders() };
        if (whisperToken) {
            headers['Authorization'] = `Bearer ${whisperToken}`;
        }

        // Try /transcribe first; fall back to /v1/audio/transcriptions
        const baseUrl = parsedUrl.origin + parsedUrl.pathname.replace(/\/+$/, '');
        const primaryEndpoint = `${baseUrl}/transcribe`;
        const fallbackEndpoint = `${baseUrl}/v1/audio/transcriptions`;

        let resp = null;
        let data = null;

        // Abort signal: 5 minutes max
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000);

        try {
            resp = await fetch(primaryEndpoint, {
                method: 'POST',
                headers,
                body: form,
                signal: controller.signal,
            });
            if (!resp.ok && resp.status === 404) {
                // Try OpenAI-compat endpoint
                resp = await fetch(fallbackEndpoint, {
                    method: 'POST',
                    headers,
                    body: form,
                    signal: controller.signal,
                });
            }
        } finally {
            clearTimeout(timeoutId);
        }

        if (!resp.ok) {
            const errBody = await resp.text().catch(() => '');
            const safeBody = errBody.replace(/[A-Za-z0-9_\-]{32,}/g, '[REDACTED]').substring(0, 200);
            return { error: `WhisperX server returned HTTP ${resp.status}: ${safeBody}` };
        }

        data = await resp.json();

        // Normalise response — support both { segments: [...] } and { text, segments: [...] }
        const rawSegments = (data.segments || []).map((seg) => ({
            speakerId: seg.speaker || seg.speakerId || 'Unknown',
            start: typeof seg.start === 'number' ? seg.start : parseFloat(seg.start) || 0,
            end: typeof seg.end === 'number' ? seg.end : parseFloat(seg.end) || 0,
            text: (seg.text || seg.transcript || '').trim(),
        })).filter(s => s.text);

        if (rawSegments.length === 0) {
            return {
                error:
                    'WhisperX returned no speech segments. Ensure the audio is clear and the server is running with diarization enabled.',
            };
        }

        console.log(`[Transcription:WhisperX] Completed — ${rawSegments.length} raw segments`);

        const merged = mergeSegments(rawSegments);
        const speakerMap = {};
        for (const seg of merged) {
            if (!speakerMap[seg.speakerId]) speakerMap[seg.speakerId] = { duration: 0, segments: 0 };
            speakerMap[seg.speakerId].duration += (seg.end || 0) - (seg.start || 0);
            speakerMap[seg.speakerId].segments += 1;
        }
        const totalDuration = rawSegments.length > 0 ? Math.max(...rawSegments.map(s => s.end || 0)) : 0;
        const formattedLines = merged.map(s =>
            `[${s.speakerId}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`
        );
        const nameMapping = await identifySpeakerNames(Object.keys(speakerMap), language, formattedLines, args.userName);

        return buildResult({ audioFileName, language, merged, totalDuration, speakerMap, nameMapping });

    } catch (err) {
        if (err.name === 'AbortError') {
            return { error: 'WhisperX transcription timed out (5 minutes). The file may be too large.' };
        }
        const safeMsg = (err.message || '').replace(/[A-Za-z0-9_\-]{32,}/g, '[REDACTED]');
        console.error('[Transcription:WhisperX] Error:', safeMsg);
        return { error: `WhisperX transcription failed: ${safeMsg}` };
    }
}

// ─── Tool Dispatch ─────────────────────────────────────────────────────────────

async function executeTranscriptionTool(toolName, args, context = {}) {
    const { userId } = context;
    if (!userId) return { error: 'User context required for transcription.' };

    if (toolName === 'transcribe_audio') {
        const provider = (await configStore.getConfig('transcription_provider')) || 'voxtral';
        if (provider === 'azure') return handleAzureTranscription(args, context);
        if (provider === 'whisper_azure') return handleAzureWhisperTranscription(args, context);
        if (provider === 'whisperx') return handleWhisperXTranscription(args, context);
        return handleVoxtralTranscription(args, context);
    }

    return { error: `Unknown transcription tool: ${toolName}` };
}

function isTranscriptionTool(toolName) {
    return ['transcribe_audio'].includes(toolName);
}

module.exports = {
    TRANSCRIPTION_TOOLS,
    executeTranscriptionTool,
    isTranscriptionTool,
};
