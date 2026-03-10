/**
 * Music Generation Tool — Lyria RealTime via Google GenAI
 * 
 * Follows the same pattern as imageGenTool.js.
 * Generates instrumental music via WebSocket streaming, saves as WAV.
 */

const fs = require('fs');
const path = require('path');
const configStore = require('../../stores/configStore');
const { googleAdapter } = require('../../core/providers');

const MUSIC_GEN_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'generate_music',
            description: 'Generate instrumental AI music based on a text prompt. Use this when the user asks you to create, generate, compose, or make music, a beat, a track, a melody, or background music. The generated audio is played inline in the chat.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: 'A detailed description of the music to generate. Include genre, instruments, tempo, mood, and style. Example: "lofi hiphop with soft piano and vinyl crackle, relaxed chill vibes"'
                    },
                    bpm: {
                        type: 'number',
                        description: 'Beats per minute (tempo). Default: 90. Range: 60-180.'
                    },
                    duration_seconds: {
                        type: 'number',
                        description: 'Duration of the music in seconds. Default: 10. Range: 5-30.'
                    }
                },
                required: ['prompt']
            }
        }
    }
];

function isMusicGenTool(name) {
    return name === 'generate_music';
}

async function executeMusicGenTool(args, send, req, nanoBananaSettings) {
    const googleApiKey = await configStore.getSecret('google_api_key');
    if (!googleApiKey) {
        return { error: 'Google API key not configured. Add it in Admin → AI Config → API Keys.' };
    }

    // Merge: LLM tool args override Nano Banana defaults
    const lyria = nanoBananaSettings?.lyria || {};
    const prompt = args.prompt;
    const bpm = Math.min(200, Math.max(60, args.bpm || lyria.bpm || 90));
    const durationSeconds = Math.min(30, Math.max(5, args.duration_seconds || lyria.durationSeconds || 10));

    console.log(`[MusicGen Tool] Generating: "${prompt.substring(0, 80)}" (${bpm} BPM, ${durationSeconds}s)`);

    const result = await googleAdapter.generateMusic(googleApiKey, prompt, {
        bpm,
        durationSeconds,
        density: lyria.density,
        brightness: lyria.brightness,
        guidance: lyria.guidance,
        musicGenerationMode: lyria.mode,
        muteBass: lyria.muteBass,
        muteDrums: lyria.muteDrums,
    });

    if (!result.audioBase64) {
        return { error: 'No music was generated. Try a different prompt.' };
    }

    // Send audio via SSE so it shows inline
    send('audio', { data: result.audioBase64, mimeType: result.mimeType });

    // Save audio to RustFS (or local disk as fallback)
    let audioUrl = null;
    try {
        const crypto = require('crypto');
        const storageStore = require('../../stores/storageStore');
        const filename = `music_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.wav`;

        if (storageStore.isAvailable()) {
            const userId = req?.session?.user?.id || 'anonymous';
            const key = storageStore.buildKey(userId, 'audio', filename);
            await storageStore.uploadFile(key, Buffer.from(result.audioBase64, 'base64'), result.mimeType || 'audio/wav');
            audioUrl = await storageStore.getPresignedUrl(key);
            console.log(`[MusicGen Tool] Saved to RustFS: ${key}`);
        } else {
            // Fallback: local disk
            const genDir = path.join(__dirname, '..', '..', 'data', 'uploads', 'generated');
            if (!fs.existsSync(genDir)) fs.mkdirSync(genDir, { recursive: true });
            fs.writeFileSync(path.join(genDir, filename), Buffer.from(result.audioBase64, 'base64'));
            const protocol = req?.protocol || 'http';
            const host = req?.get?.('host') || `localhost:${process.env.SERVER_PORT || 3001}`;
            audioUrl = `${protocol}://${host}/uploads/generated/${filename}`;
            console.log(`[MusicGen Tool] Saved to disk: ${audioUrl}`);
        }
    } catch (e) {
        console.warn('[MusicGen Tool] Failed to save audio to disk:', e.message);
    }

    // Log usage
    try {
        const usageStore = require('../../stores/usageStore');
        await usageStore.logUsage({
            agent_id: null,
            agent_name: 'direct-chat',
            model: 'lyria-realtime-exp',
            prompt_tokens: prompt.length,
            completion_tokens: 0,
            total_tokens: prompt.length,
            source: 'music_generation',
        });
    } catch (e) {
        console.warn('[MusicGen Tool] Failed to log usage:', e.message);
    }

    return {
        success: true,
        message: `Music generated and already playing inline for the user. Do NOT try to embed audio or provide a download link. Just describe what was created or ask if they want changes.`,
        prompt,
        bpm,
        durationSeconds,
        audioUrl: audioUrl || null,
    };
}

module.exports = { MUSIC_GEN_TOOLS, isMusicGenTool, executeMusicGenTool };
