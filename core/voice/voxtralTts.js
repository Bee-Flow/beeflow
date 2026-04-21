/**
 * Voxtral TTS — Text-to-Speech with Mistral Voxtral-TTS, falling back to ElevenLabs.
 *
 * Strategy:
 *   1. Try Mistral Voxtral-TTS (`/v1/audio/speech`) — EU-hosted, ~9 languages,
 *      rivals ElevenLabs v3 in naturalness at lower cost.
 *   2. If the Mistral key is missing *or* the TTS call fails (e.g. the account
 *      doesn't have Voxtral-TTS enabled yet), fall back to ElevenLabs if that
 *      key is configured.
 *   3. If neither provider is available, return { audioBase64: null }.
 *
 * Returns MP3-encoded base64 audio — the frontend decodes via HTMLAudioElement.
 */

const configStore = require('../../stores/configStore');
const elevenlabsProvider = require('../providers/elevenlabs');

const MISTRAL_API_BASE = 'https://api.mistral.ai';
const DEFAULT_TTS_MODEL = 'voxtral-tts-2603';
const DEFAULT_VOXTRAL_VOICE = 'amber'; // reference voice — overridable via voice settings

/**
 * Synthesize speech with Voxtral, fall back to ElevenLabs on error.
 *
 * @param {string} text                Text to speak
 * @param {object} [opts]
 * @param {string} [opts.provider]     'voxtral' | 'elevenlabs' | 'auto' (default: auto)
 * @param {string} [opts.voice]        Voice id (provider-specific)
 * @param {string} [opts.model]        Model id (provider-specific)
 * @param {string} [opts.language]     BCP-47 code (Voxtral only)
 * @returns {Promise<{ audioBase64: string|null, mimeType: string, provider: string }>}
 */
async function synthesize(text, opts = {}) {
    if (!text || !text.trim()) {
        return { audioBase64: null, mimeType: 'audio/mpeg', provider: 'none' };
    }

    const preferred = opts.provider || 'auto';
    const mistralKey = await configStore.getSecret('mistral_api_key');
    const elevenKey = await configStore.getSecret('elevenlabs_api_key');

    const tryVoxtral = preferred === 'voxtral' || (preferred === 'auto' && mistralKey);
    const tryEleven = preferred === 'elevenlabs' || (preferred === 'auto' && elevenKey);

    if (tryVoxtral && mistralKey) {
        try {
            return await voxtralSynthesize(mistralKey, text, opts);
        } catch (err) {
            console.warn('[Voxtral TTS] failed, falling back:', err.message);
            // Fall through to ElevenLabs
        }
    }

    if (tryEleven && elevenKey) {
        const out = await elevenlabsProvider.textToSpeech(elevenKey, text, {
            voice_id: opts.voice,
            model: opts.model || 'eleven_flash_v2_5',
        });
        return { ...out, provider: 'elevenlabs' };
    }

    console.warn('[Voxtral TTS] No TTS provider available');
    return { audioBase64: null, mimeType: 'audio/mpeg', provider: 'none' };
}

/**
 * Call Mistral's Voxtral-TTS endpoint directly.
 * Format is OpenAI-compatible: POST /v1/audio/speech with JSON body.
 */
async function voxtralSynthesize(apiKey, text, opts = {}) {
    const started = Date.now();
    const model = opts.model || DEFAULT_TTS_MODEL;
    const voice = opts.voice || DEFAULT_VOXTRAL_VOICE;

    const body = { model, input: text, voice, response_format: 'mp3' };
    if (opts.language) body.language = opts.language;

    const resp = await fetch(`${MISTRAL_API_BASE}/v1/audio/speech`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
        },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`Voxtral TTS ${resp.status}: ${errText.slice(0, 300)}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);
    console.log(`[Voxtral TTS] ${model} synthesized ${(audioBuffer.length / 1024).toFixed(0)}KB in ${Date.now() - started}ms`);

    return {
        audioBase64: audioBuffer.toString('base64'),
        mimeType: 'audio/mpeg',
        provider: 'voxtral',
    };
}

module.exports = { synthesize, DEFAULT_TTS_MODEL };
