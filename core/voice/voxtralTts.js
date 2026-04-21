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
// Voxtral TTS model name — passing `model` is optional per Mistral's docs,
// so we leave it undefined by default and let the server pick. Set this via
// opts.model if a specific checkpoint is needed.
const DEFAULT_TTS_MODEL = null;

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
 *   POST /v1/audio/speech
 *   body: { input, model?, voice_id?, ref_audio?, response_format? }
 *
 * Handles both possible response shapes the API returns:
 *   - binary audio bytes with an audio/* Content-Type
 *   - JSON with a base64-encoded audio field (e.g. { audio, format })
 */
async function voxtralSynthesize(apiKey, text, opts = {}) {
    const started = Date.now();

    const body = {
        input: text,
        response_format: 'mp3',
    };
    if (opts.model || DEFAULT_TTS_MODEL) body.model = opts.model || DEFAULT_TTS_MODEL;
    if (opts.voice) body.voice_id = opts.voice;

    const resp = await fetch(`${MISTRAL_API_BASE}/v1/audio/speech`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg, application/json',
        },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`Voxtral TTS ${resp.status}: ${errText.slice(0, 300)}`);
    }

    const contentType = resp.headers.get('content-type') || '';
    let audioBase64 = null;
    let mimeType = 'audio/mpeg';

    if (contentType.includes('application/json')) {
        const json = await resp.json();
        // Try the common field names used by speech APIs.
        audioBase64 = json.audio || json.audio_base64 || json.data || null;
        if (json.format) mimeType = `audio/${json.format}`;
        else if (json.mime_type) mimeType = json.mime_type;
    } else {
        const arrayBuffer = await resp.arrayBuffer();
        audioBase64 = Buffer.from(arrayBuffer).toString('base64');
        if (contentType.startsWith('audio/')) mimeType = contentType.split(';')[0];
    }

    if (!audioBase64) {
        throw new Error('Voxtral TTS returned no audio payload');
    }

    const bytesLen = Math.round((audioBase64.length * 3) / 4);
    console.log(`[Voxtral TTS] synthesized ~${(bytesLen / 1024).toFixed(0)}KB in ${Date.now() - started}ms`);

    return { audioBase64, mimeType, provider: 'voxtral' };
}

module.exports = { synthesize, DEFAULT_TTS_MODEL };
