/**
 * ElevenLabs Provider — Music, TTS, and Sound Effects
 *
 * Uses the official @elevenlabs/elevenlabs-js SDK.
 * Docs: https://elevenlabs.io/docs/api-reference
 */

class ElevenLabsProvider {

    /**
     * Create an ElevenLabs client.
     * @param {string} apiKey
     * @returns {import('@elevenlabs/elevenlabs-js').ElevenLabsClient}
     */
    createClient(apiKey) {
        const { ElevenLabsClient } = require('@elevenlabs/elevenlabs-js');
        return new ElevenLabsClient({ apiKey });
    }

    /**
     * Collect a readable stream into a Buffer.
     * @param {ReadableStream|AsyncIterable} stream
     * @returns {Promise<Buffer>}
     */
    async _streamToBuffer(stream) {
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        return Buffer.concat(chunks);
    }

    /**
     * Generate a song (with or without vocals).
     *
     * @param {string} apiKey
     * @param {string} prompt - Song description
     * @param {object} options - { duration_seconds, instrumental }
     * @returns {Promise<{ audioBase64: string|null, mimeType: string }>}
     */
    async generateSong(apiKey, prompt, options = {}) {
        const client = this.createClient(apiKey);

        const durationMs = (options.duration_seconds || 30) * 1000;
        const instrumental = options.instrumental || false;

        console.log(`[ElevenLabs] Music: "${prompt.substring(0, 80)}" (${durationMs / 1000}s, instrumental: ${instrumental})`);

        // SDK v2.x uses camelCase: musicLengthMs / forceInstrumental / outputFormat.
        // The old snake_case keys were silently dropped, so duration + instrumental
        // never took effect. (verified against @elevenlabs/elevenlabs-js@2.46 types)
        const composeReq = {
            prompt,
            musicLengthMs: Math.max(3000, Math.min(600000, durationMs)),
            forceInstrumental: instrumental,
            outputFormat: 'mp3_44100_128',
        };
        if (options.model) composeReq.modelId = options.model; // music_v1 (default) | music_v2

        const audioStream = await client.music.compose(composeReq);

        const audioBuffer = await this._streamToBuffer(audioStream);

        if (!audioBuffer || audioBuffer.length === 0) {
            console.error('[ElevenLabs] Music generation returned empty audio');
            return { audioBase64: null, mimeType: 'audio/mpeg' };
        }

        console.log(`[ElevenLabs] Music generated: ${(audioBuffer.length / 1024).toFixed(0)} KB`);

        return {
            audioBase64: audioBuffer.toString('base64'),
            mimeType: 'audio/mpeg',
        };
    }

    /**
     * Text-to-Speech.
     *
     * @param {string} apiKey
     * @param {string} text - Text to speak
     * @param {object} options - { voice_id, model }
     * @returns {Promise<{ audioBase64: string|null, mimeType: string }>}
     */
    async textToSpeech(apiKey, text, options = {}) {
        const client = this.createClient(apiKey);

        const voiceId = options.voice_id || 'JBFqnCBsd6RMkjVDRZzb'; // Default: George
        const model = options.model || 'eleven_flash_v2_5';

        console.log(`[ElevenLabs] TTS: "${text.substring(0, 80)}" (voice: ${voiceId}, model: ${model})`);

        const convertReq = {
            text,
            modelId: model,            // camelCase for SDK v2.x (snake_case is dropped)
            outputFormat: 'mp3_44100_128',
        };
        // Optional voice settings — speed (0.7–1.2), stability, similarityBoost,
        // style, useSpeakerBoost. Makes the speed/stability controls real.
        if (options.voiceSettings && typeof options.voiceSettings === 'object' && Object.keys(options.voiceSettings).length) {
            convertReq.voiceSettings = options.voiceSettings;
        }

        const audioStream = await client.textToSpeech.convert(voiceId, convertReq);

        const audioBuffer = await this._streamToBuffer(audioStream);

        if (!audioBuffer || audioBuffer.length === 0) {
            console.error('[ElevenLabs] TTS returned empty audio');
            return { audioBase64: null, mimeType: 'audio/mpeg' };
        }

        console.log(`[ElevenLabs] TTS generated: ${(audioBuffer.length / 1024).toFixed(0)} KB`);

        return {
            audioBase64: audioBuffer.toString('base64'),
            mimeType: 'audio/mpeg',
        };
    }

    /**
     * Generate a sound effect.
     *
     * @param {string} apiKey
     * @param {string} prompt - SFX description
     * @param {object} options - { duration_seconds, prompt_influence }
     * @returns {Promise<{ audioBase64: string|null, mimeType: string }>}
     */
    async generateSoundEffect(apiKey, prompt, options = {}) {
        const client = this.createClient(apiKey);

        const durationSec = options.duration_seconds || 5;
        const promptInfluence = options.prompt_influence || 0.5;

        console.log(`[ElevenLabs] SFX: "${prompt.substring(0, 80)}" (${durationSec}s)`);

        const audioStream = await client.textToSoundEffects.convert({
            text: prompt,
            durationSeconds: Math.max(0.5, Math.min(30, durationSec)),  // camelCase for SDK v2.x
            promptInfluence: Math.max(0, Math.min(1, promptInfluence)),
        });

        const audioBuffer = await this._streamToBuffer(audioStream);

        if (!audioBuffer || audioBuffer.length === 0) {
            console.error('[ElevenLabs] SFX returned empty audio');
            return { audioBase64: null, mimeType: 'audio/mpeg' };
        }

        console.log(`[ElevenLabs] SFX generated: ${(audioBuffer.length / 1024).toFixed(0)} KB`);

        return {
            audioBase64: audioBuffer.toString('base64'),
            mimeType: 'audio/mpeg',
        };
    }
}

module.exports = new ElevenLabsProvider();
