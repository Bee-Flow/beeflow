/**
 * Voxtral STT — Speech-to-Text via Mistral's audio transcription endpoint.
 *
 * Uses the Mistral REST API `/v1/audio/transcriptions` (model:
 * voxtral-mini-2602 — Voxtral Transcribe 2 batch, released Feb 2026).
 * The endpoint accepts multipart/form-data with the audio file and
 * returns a JSON transcript.
 *
 * Per-turn usage (v1 Beta):
 *   transcribe(apiKey, audioBuffer, { mime, language }) → { text, language, duration }
 *
 * The streaming WebSocket variant (Voxtral Realtime `/v1/realtime`) will be
 * added in v2 — for now the POST-per-turn approach matches the existing SSE
 * turn model used by /ai/chat/direct/stream.
 */

const FormData = require('form-data');

const MISTRAL_API_BASE = 'https://api.mistral.ai';
const DEFAULT_STT_MODEL = 'voxtral-mini-2602';

/**
 * Transcribe an audio buffer via Voxtral.
 *
 * @param {string} apiKey              Mistral API key
 * @param {Buffer} audioBuffer         Raw audio bytes (webm/opus, wav, mp3, …)
 * @param {object} [opts]
 * @param {string} [opts.mime]         MIME type (default: audio/webm)
 * @param {string} [opts.filename]     Filename hint for the multipart part
 * @param {string} [opts.language]     BCP-47 code ('en', 'nl', 'fr', …) — auto-detect if omitted
 * @param {string} [opts.model]        Override the Voxtral model
 * @returns {Promise<{ text: string, language: string|null, duration: number|null }>}
 */
async function transcribe(apiKey, audioBuffer, opts = {}) {
    if (!apiKey) throw new Error('Mistral API key is required for Voxtral STT');
    if (!audioBuffer || !audioBuffer.length) throw new Error('Empty audio buffer');

    const mime = opts.mime || 'audio/webm';
    const filename = opts.filename || `turn.${mime.split('/')[1]?.split(';')[0] || 'webm'}`;
    const model = opts.model || DEFAULT_STT_MODEL;

    const form = new FormData();
    form.append('file', audioBuffer, { filename, contentType: mime });
    form.append('model', model);
    if (opts.language) form.append('language', opts.language);

    const url = `${MISTRAL_API_BASE}/v1/audio/transcriptions`;
    const started = Date.now();

    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            ...form.getHeaders(),
        },
        body: form.getBuffer(),
    });

    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Voxtral STT failed (${resp.status}): ${body.slice(0, 400)}`);
    }

    const json = await resp.json();
    console.log(`[Voxtral STT] ${model} transcribed ${audioBuffer.length}B in ${Date.now() - started}ms`);

    return {
        text: (json.text || '').trim(),
        language: json.language || opts.language || null,
        duration: typeof json.duration === 'number' ? json.duration : null,
    };
}

module.exports = { transcribe, DEFAULT_STT_MODEL };
