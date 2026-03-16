/**
 * Transcription Tools — Voxtral-powered meeting transcription with diarization
 * 
 * Uses Mistral's Voxtral model (voxtral-mini-latest) to transcribe uploaded audio
 * files with speaker diarization and context biasing. Follows the same pattern
 * as firefliesTools.js for tool injection and dispatch.
 */

const configStore = require('../stores/configStore');
const path = require('path');
const fs = require('fs');

/**
 * Tool definitions in OpenAI function-calling format.
 */
const TRANSCRIPTION_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'transcribe_audio',
            description: 'Transcribe an uploaded audio file using Voxtral AI. Returns a formatted transcript with speaker diarization (who said what), timestamps, and segment-level detail. Supports up to 3 hours of audio. Best for: meeting recordings, interviews, calls, voice notes. The audio file must be uploaded as an attachment to the message.',
            parameters: {
                type: 'object',
                properties: {
                    language: {
                        type: 'string',
                        description: 'Language code for transcription (e.g. "nl" for Dutch, "en" for English, "de" for German, "fr" for French). Default: "nl"'
                    },
                    context_terms: {
                        type: 'string',
                        description: 'Comma-separated list of domain-specific terms to help the model recognise (e.g. "AFAS, Bflow, N8N, Ondernemers Kompas"). Improves accuracy for company names, products, jargon.'
                    },
                    timestamp_granularity: {
                        type: 'string',
                        enum: ['segment', 'word'],
                        description: 'Level of timestamp detail. "segment" (default) gives per-sentence timestamps, "word" gives per-word timestamps.'
                    }
                },
                required: []
            }
        }
    }
];

// ─── Helpers ───────────────────────────────────────────────────

function formatTime(seconds) {
    if (seconds == null) return '00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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

// ─── Tool Execution ────────────────────────────────────────────

async function executeTranscriptionTool(toolName, args, context = {}) {
    const { userId, attachments, req } = context;
    if (!userId) return { error: 'User context required for transcription.' };

    const apiKey = await configStore.getSecret('mistral_api_key');
    if (!apiKey) {
        return { error: 'Mistral API key not configured. Add it in Admin → AI Config → API Keys.' };
    }

    if (toolName === 'transcribe_audio') {
        return await handleTranscribeAudio(apiKey, args, context);
    }

    return { error: `Unknown transcription tool: ${toolName}` };
}

async function handleTranscribeAudio(apiKey, args, context) {
    const { attachments, req } = context;
    const language = args.language || 'nl';
    const contextTerms = args.context_terms || '';
    const granularity = args.timestamp_granularity || 'segment';

    // Find audio attachment
    let audioData = null;
    let audioFileName = 'audio.mp3';

    if (attachments && attachments.length > 0) {
        // Look for audio attachment
        const audioAttachment = attachments.find(a => {
            const ext = (a.name || a.filename || '').toLowerCase();
            return ext.endsWith('.mp3') || ext.endsWith('.wav') || ext.endsWith('.m4a') ||
                ext.endsWith('.ogg') || ext.endsWith('.webm') || ext.endsWith('.flac') ||
                ext.endsWith('.mp4') || ext.endsWith('.mpeg') ||
                (a.type && a.type.startsWith('audio/'));
        });

        if (audioAttachment) {
            audioFileName = audioAttachment.name || audioAttachment.filename || 'audio.mp3';

            // Load file content — could be a path or URL
            if (audioAttachment.path) {
                try {
                    audioData = fs.readFileSync(audioAttachment.path);
                } catch (readErr) {
                    return { error: `Could not read audio file: ${readErr.message}` };
                }
            } else if (audioAttachment.url) {
                try {
                    const resp = await fetch(audioAttachment.url);
                    if (!resp.ok) return { error: `Failed to download audio file: ${resp.statusText}` };
                    audioData = Buffer.from(await resp.arrayBuffer());
                } catch (fetchErr) {
                    return { error: `Could not download audio file: ${fetchErr.message}` };
                }
            } else if (audioAttachment.data || audioAttachment.content) {
                // Base64 or raw buffer
                const raw = audioAttachment.data || audioAttachment.content;
                audioData = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'base64');
            }
        }
    }

    if (!audioData) {
        return { error: 'No audio file found. Please upload an audio file (MP3, WAV, M4A, OGG, WEBM, FLAC) as an attachment to your message.' };
    }

    console.log(`[Transcription] Starting transcription of "${audioFileName}" (${(audioData.length / (1024 * 1024)).toFixed(1)} MB), language: ${language}`);

    try {
        const { Mistral } = require('@mistralai/mistralai');
        const client = new Mistral({ apiKey });

        const transcriptionOptions = {
            model: 'voxtral-mini-latest',
            file: {
                fileName: audioFileName,
                content: audioData,
            },
            diarize: true,
            language: language,
            timestampGranularities: [granularity],
        };

        // Add context biasing if provided
        if (contextTerms) {
            transcriptionOptions.prompt = contextTerms;
        }

        const response = await client.audio.transcriptions.complete(transcriptionOptions);

        console.log(`[Transcription] Completed. ${(response.segments || []).length} raw segments.`);

        // Merge consecutive segments from same speaker
        const segments = response.segments || [];
        const merged = mergeSegments(segments);

        // Build speaker summary
        const speakerMap = {};
        for (const seg of merged) {
            if (!speakerMap[seg.speakerId]) {
                speakerMap[seg.speakerId] = { duration: 0, segments: 0 };
            }
            speakerMap[seg.speakerId].duration += (seg.end || 0) - (seg.start || 0);
            speakerMap[seg.speakerId].segments += 1;
        }

        const totalDuration = segments.length > 0
            ? Math.max(...segments.map(s => s.end || 0))
            : 0;

        // Format transcript for display
        let formattedLines = merged.map(s => {
            const start = formatTime(s.start);
            const end = formatTime(s.end);
            return `[${s.speakerId}] ${start} - ${end}: ${s.text}`;
        });

        // Identify speaker names using Claude
        const speakerIds = Object.keys(speakerMap);
        let nameMapping = null;
        try {
            const { getProviderForModel } = require('../core/aiAgent');
            const claudeConfig = await getProviderForModel('claude-sonnet-4-6');
            const Anthropic = require('@anthropic-ai/sdk');
            const claude = new Anthropic({ apiKey: claudeConfig.apiKey });

            const speakerList = speakerIds.join(', ');
            const nameResp = await claude.messages.create({
                model: 'claude-sonnet-4-6',
                max_tokens: 1024,
                temperature: 0,
                system: `You are a transcript analyzer. Identify real names of speakers from the conversation.

IMPORTANT: Speech diarization often splits one person into multiple speaker IDs. A conversation with 3 real people may show 15+ speaker_IDs. You MUST group them.

Instructions:
1. Map EVERY speaker_ID to a real name. Multiple IDs will map to the SAME person.
2. If a speaker_ID has very few segments, assign them to the most likely existing speaker.
3. NEVER return null. Every speaker_ID must get a name string.

Return ONLY a JSON object. Example: {"speaker_1": "Tom", "speaker_2": "Gerard", "speaker_3": "Tom"}
Return ONLY valid JSON, no other text.`,
                messages: [
                    { role: 'user', content: `Speakers: ${speakerList}\nLanguage: ${language}\n\n${formattedLines.join('\n').substring(0, 15000)}` }
                ],
            });
            const chatContent = (nameResp.content?.[0]?.text || '').trim();
            const jsonMatch = chatContent.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                nameMapping = JSON.parse(jsonMatch[0]);
                for (const [key, value] of Object.entries(nameMapping)) {
                    if (!value || value === 'null') delete nameMapping[key];
                }
                console.log('[Transcription] Speaker names identified:', nameMapping);
            }
        } catch (nameErr) {
            console.error('[Transcription] Speaker identification failed:', nameErr.message);
        }

        // Apply name mapping
        if (nameMapping) {
            for (const seg of merged) {
                if (nameMapping[seg.speakerId]) seg.speakerId = nameMapping[seg.speakerId];
            }
            formattedLines = merged.map(s => {
                const start = formatTime(s.start);
                const end = formatTime(s.end);
                return `[${s.speakerId}] ${start} - ${end}: ${s.text}`;
            });
        }

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
            fullText: response.text || '',
            transcript: formattedLines.join('\n'),
            segments: merged.map(s => ({
                speaker: s.speakerId,
                start: s.start,
                end: s.end,
                startFormatted: formatTime(s.start),
                endFormatted: formatTime(s.end),
                text: s.text,
            })),
        };

    } catch (err) {
        console.error('[Transcription] Voxtral error:', err.message);
        if (err.message?.includes('rate_limit')) {
            return { error: 'Rate limit reached for Voxtral. Please try again in a few moments.' };
        }
        return { error: `Transcription failed: ${err.message}` };
    }
}

function isTranscriptionTool(toolName) {
    return ['transcribe_audio'].includes(toolName);
}

module.exports = {
    TRANSCRIPTION_TOOLS,
    executeTranscriptionTool,
    isTranscriptionTool,
};
