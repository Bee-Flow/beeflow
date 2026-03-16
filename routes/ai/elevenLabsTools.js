/**
 * ElevenLabs Tools — Music (with vocals), TTS, and Sound Effects
 *
 * Follows the same pattern as musicGenTool.js.
 * Three tools: elevenlabs_music, elevenlabs_tts, elevenlabs_sfx
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const configStore = require('../../stores/configStore');
const elevenlabsProvider = require('../../core/providers/elevenlabs');

// ─── Tool Definitions ──────────────────────────────────────────
const ELEVENLABS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'elevenlabs_music',
            description: 'Generate AI music or songs using ElevenLabs. Use this when the user asks you to create, generate, compose, or make music, a beat, a track, a melody, background music, or a song (with or without vocals). Also generate an album cover image using generate_image in parallel. The generated audio plays inline in the chat.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: 'Detailed description of the song. Include genre, mood, style, lyrical theme. Example: "A 90s eurodance track about AI assistants with catchy chorus"'
                    },
                    duration_seconds: {
                        type: 'number',
                        description: 'Duration in seconds. Default: 30. Range: 3-600.'
                    },
                    instrumental: {
                        type: 'boolean',
                        description: 'If true, generate instrumental only (no vocals). Default: false.'
                    }
                },
                required: ['prompt']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'elevenlabs_tts',
            description: 'Convert text to spoken audio using ElevenLabs AI voices. Use this when the user wants text read aloud, spoken, narrated, or converted to speech. The audio plays inline.',
            parameters: {
                type: 'object',
                properties: {
                    text: {
                        type: 'string',
                        description: 'The text to convert to speech.'
                    },
                    voice_id: {
                        type: 'string',
                        description: 'Optional ElevenLabs voice ID. Defaults to "George" if not specified.'
                    },
                    model: {
                        type: 'string',
                        description: 'Model ID. Options: "eleven_flash_v2_5" (fast, low latency), "eleven_v3" (highest quality), "eleven_multilingual_v2" (29 languages). Default: eleven_flash_v2_5.'
                    }
                },
                required: ['text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'elevenlabs_sfx',
            description: 'Generate a custom AI sound effect from a text description using ElevenLabs. Use for ambient sounds, foley, UI sounds, cinematic effects, etc. The audio plays inline.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: 'Description of the sound effect. Example: "Thunder rumbling with light rain on a tin roof"'
                    },
                    duration_seconds: {
                        type: 'number',
                        description: 'Duration in seconds. Default: 5. Range: 0.5-30.'
                    }
                },
                required: ['prompt']
            }
        }
    }
];

// ─── Helpers ────────────────────────────────────────────────────

function isElevenLabsTool(name) {
    return name === 'elevenlabs_music' || name === 'elevenlabs_tts' || name === 'elevenlabs_sfx';
}

function _saveAudioLocal(buffer, ext, prefix) {
    const genDir = path.join(__dirname, '..', '..', 'data', 'uploads', 'generated');
    if (!fs.existsSync(genDir)) fs.mkdirSync(genDir, { recursive: true });
    const filename = `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const filePath = path.join(genDir, filename);
    fs.writeFileSync(filePath, buffer);
    return { filePath, filename };
}

async function _saveAudioToStorage(buffer, ext, prefix, mimeType, userId) {
    const storageStore = require('../../stores/storageStore');
    const filename = `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;

    if (storageStore.isAvailable()) {
        const key = storageStore.buildKey(userId || 'anonymous', 'audio', filename);
        await storageStore.uploadFile(key, buffer, mimeType);
        const url = storageStore.buildProxyUrl(key);
        console.log(`[ElevenLabs Tool] Saved to RustFS: ${key}`);
        return url;
    } else {
        const { filename: savedFilename } = _saveAudioLocal(buffer, ext, prefix);
        const url = `/uploads/generated/${savedFilename}`;
        console.log(`[ElevenLabs Tool] Saved to disk: ${url}`);
        return url;
    }
}

function _logUsage(source, model, promptLen) {
    try {
        const usageStore = require('../../stores/usageStore');
        usageStore.logUsage({
            agent_id: null,
            agent_name: 'direct-chat',
            model,
            prompt_tokens: promptLen,
            completion_tokens: 0,
            total_tokens: promptLen,
            source,
        });
    } catch (e) { /* ignore */ }
}

// ─── Executor ───────────────────────────────────────────────────

async function executeElevenLabsTool(toolName, toolArgs, send, req, nanoBananaSettings) {
    const apiKey = await configStore.getSecret('elevenlabs_api_key');
    if (!apiKey) {
        return { error: 'ElevenLabs API key not configured. Add it in Admin → AI Config → API Keys.' };
    }

    // Extract settings — LLM tool args override Nano Banana defaults
    const elSettings = nanoBananaSettings?.elevenlabs || {};
    const sfxSettings = nanoBananaSettings?.sfx || {};

    let result;
    let source;
    let model;
    let promptText;

    try {
        if (toolName === 'elevenlabs_music') {
            promptText = toolArgs.prompt;
            source = 'elevenlabs_music';
            model = 'eleven_music_v1';

            console.log(`[ElevenLabs Tool] Music: "${promptText.substring(0, 80)}"`);
            result = await elevenlabsProvider.generateSong(apiKey, promptText, {
                duration_seconds: toolArgs.duration_seconds || elSettings.musicDuration || 30,
                instrumental: toolArgs.instrumental !== undefined ? toolArgs.instrumental : (elSettings.instrumental || false),
            });

        } else if (toolName === 'elevenlabs_tts') {
            promptText = toolArgs.text;
            source = 'elevenlabs_tts';
            model = toolArgs.model || elSettings.ttsModel || 'eleven_flash_v2_5';

            console.log(`[ElevenLabs Tool] TTS: "${promptText.substring(0, 80)}"`);
            result = await elevenlabsProvider.textToSpeech(apiKey, promptText, {
                voice_id: toolArgs.voice_id || elSettings.ttsVoice,
                model,
            });

        } else if (toolName === 'elevenlabs_sfx') {
            promptText = toolArgs.prompt;
            source = 'elevenlabs_sfx';
            model = 'sound_effects_v2';

            console.log(`[ElevenLabs Tool] SFX: "${promptText.substring(0, 80)}"`);
            result = await elevenlabsProvider.generateSoundEffect(apiKey, promptText, {
                duration_seconds: toolArgs.duration_seconds || sfxSettings.duration || 5,
                prompt_influence: sfxSettings.promptInfluence,
            });

        } else {
            return { error: `Unknown ElevenLabs tool: ${toolName}` };
        }
    } catch (err) {
        console.error(`[ElevenLabs Tool] ${toolName} failed:`, err.message);
        return { error: `ElevenLabs ${toolName} failed: ${err.message}` };
    }

    if (!result?.audioBase64) {
        return { error: 'No audio was generated. Try a different prompt.' };
    }

    // Save audio to RustFS (or local disk as fallback) and get URL
    let audioUrl = null;
    try {
        const buf = Buffer.from(result.audioBase64, 'base64');
        const prefix = toolName.replace('elevenlabs_', '');
        const userId = req?.session?.user?.id;
        audioUrl = await _saveAudioToStorage(buf, 'mp3', prefix, result.mimeType || 'audio/mpeg', userId);
    } catch (e) {
        console.warn('[ElevenLabs Tool] Failed to save audio:', e.message);
    }

    // Send audio URL via SSE (not base64 — URL persists on refresh)
    if (send && audioUrl) {
        send('audio', { url: audioUrl, mimeType: result.mimeType || 'audio/mpeg', source: toolName });
    }

    // Log usage
    _logUsage(source, model, (promptText || '').length);

    const typeLabel = toolName === 'elevenlabs_music' ? 'Song' : toolName === 'elevenlabs_tts' ? 'Speech' : 'Sound effect';
    return {
        success: true,
        message: `${typeLabel} generated and already playing inline for the user. Do NOT embed audio or provide a download link. Just describe what was created or ask if they want changes.`,
        audioUrl: audioUrl || null,
    };
}

module.exports = { ELEVENLABS_TOOLS, isElevenLabsTool, executeElevenLabsTool };
