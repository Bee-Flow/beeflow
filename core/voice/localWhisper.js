/**
 * In-process CPU transcription via Transformers.js (Whisper-base).
 *
 * Patroon gespiegeld op `server/core/localPiiDetection.js`:
 *  - Lazy load van de pipeline op de eerste call (snelle server-boot).
 *  - Single-flight queue zodat twee gelijktijdige uploads niet samen het
 *    geheugen verdubbelen.
 *  - Hard wallclock-timeout én een max audio-duur cap zodat een grote
 *    upload de host niet kan vastzetten.
 *  - Fail-open: als het model niet kan laden of de inference faalt,
 *    retourneren we null en de caller geeft de gebruiker een nette
 *    foutmelding (i.p.v. een crash).
 *
 * Output match `transcribeWithWhisperX()` in `server/routes/transcriptions.js`:
 *   { text, segments: [{ text, start, end, speakerId }] }
 *
 * Speaker-diarization is **out of scope** voor lokaal — alle segments
 * krijgen `speaker_0`. Voor multi-speaker meetings blijft de cloud-route
 * (Voxtral / WhisperX / Azure) de juiste keuze.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCAL_WHISPER_MODEL_ID = process.env.LOCAL_WHISPER_MODEL || 'Xenova/whisper-base';
const LOCAL_WHISPER_DTYPE    = process.env.LOCAL_WHISPER_DTYPE   || 'q4';

const LOCAL_WHISPER_MAX_DURATION_SEC = Number(process.env.LOCAL_WHISPER_MAX_DURATION_SEC) || 600; // 10 min
const LOCAL_WHISPER_TIMEOUT_MS       = Number(process.env.LOCAL_WHISPER_TIMEOUT_MS)       || 600_000;
const LOCAL_WHISPER_WASM_THREADS     = Math.max(
    1,
    Number(process.env.LOCAL_WHISPER_WASM_THREADS) ||
        Math.max(1, Math.floor((os.cpus()?.length || 2) / 2))
);

// Whisper-language hint mapping (BCP-47 → whisper langtag).
const LANGUAGE_HINTS = {
    nl: 'dutch', en: 'english', de: 'german', fr: 'french',
    es: 'spanish', it: 'italian', pt: 'portuguese', pl: 'polish',
    tr: 'turkish', ja: 'japanese', zh: 'chinese', ko: 'korean',
    ar: 'arabic', ru: 'russian',
};

let _pipelinePromise = null;
let _loadFailed = false;

async function getPipeline() {
    if (_loadFailed) return null;
    if (_pipelinePromise) return _pipelinePromise;

    _pipelinePromise = (async () => {
        try {
            const { pipeline, env } = await import('@huggingface/transformers');
            env.allowRemoteModels = true;
            try {
                if (env.backends?.onnx?.wasm) {
                    env.backends.onnx.wasm.numThreads = LOCAL_WHISPER_WASM_THREADS;
                }
            } catch (_) { /* older versions: ignore */ }

            const transcriber = await pipeline(
                'automatic-speech-recognition',
                LOCAL_WHISPER_MODEL_ID,
                { dtype: LOCAL_WHISPER_DTYPE },
            );
            console.log(`[LocalWhisper] Model ${LOCAL_WHISPER_MODEL_ID} ready (threads=${LOCAL_WHISPER_WASM_THREADS}, maxDuration=${LOCAL_WHISPER_MAX_DURATION_SEC}s)`);
            return transcriber;
        } catch (err) {
            console.warn(`[LocalWhisper] Failed to load ${LOCAL_WHISPER_MODEL_ID}: ${err.message}`);
            _loadFailed = true;
            return null;
        }
    })();
    return _pipelinePromise;
}

// ── Single-flight queue ──────────────────────────────────────────────
let _inferenceChain = Promise.resolve();
function runSerialized(fn) {
    const next = _inferenceChain.then(() => fn(), () => fn());
    _inferenceChain = next.catch(() => {});
    return next;
}

function withTimeout(promise, ms, label) {
    if (!ms || ms <= 0) return promise;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        promise.then(
            v => { clearTimeout(timer); resolve(v); },
            e => { clearTimeout(timer); reject(e); },
        );
    });
}

// ── ffmpeg → 16 kHz mono Float32Array ────────────────────────────────
//
// Transformers.js Whisper verwacht een Float32Array met audio-samples.
// We laten ffmpeg het input-formaat decoderen en uitschrijven als raw
// 32-bit float little-endian @ 16 kHz mono. Daarna lezen we het buffer
// en mappen 'm 1-op-1 op een Float32Array.
async function decodeAudioToFloat32(audioPath) {
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    const ffmpegLib = require('fluent-ffmpeg');
    ffmpegLib.setFfmpegPath(ffmpegInstaller.path);

    const tmpRaw = path.join(os.tmpdir(), `whisper-${Date.now()}-${process.pid}.f32`);

    await new Promise((resolve, reject) => {
        ffmpegLib(audioPath)
            .audioChannels(1)
            .audioFrequency(16000)
            .audioCodec('pcm_f32le')
            .format('f32le')
            .on('end', resolve)
            .on('error', reject)
            .save(tmpRaw);
    });

    let audioBuf;
    try {
        audioBuf = fs.readFileSync(tmpRaw);
    } finally {
        try { fs.unlinkSync(tmpRaw); } catch (_) {}
    }

    // Buffer → Float32Array via underlying ArrayBuffer (no copy).
    const samples = new Float32Array(
        audioBuf.buffer,
        audioBuf.byteOffset,
        audioBuf.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );
    return samples;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Transcribe an audio file on local CPU.
 *
 * @param {string} audioPath  Absolute path to a temp file. Any format ffmpeg can read.
 * @param {object} [options]
 * @param {string} [options.language='nl']  BCP-47 hint (nl|en|...).
 * @param {boolean} [options.returnTimestamps=true]  Emit segment timing.
 * @returns {Promise<{ text, segments, language, durationSec, provider } | null>}
 *          null when the model is unavailable / disabled — caller fails open
 *          with a clear message and a "retry on cloud" affordance.
 */
async function transcribeLocally(audioPath, options = {}) {
    const language = options.language || 'nl';
    const langHint = LANGUAGE_HINTS[language] || language;

    if (!audioPath || !fs.existsSync(audioPath)) {
        throw new Error('Audio file not found');
    }

    const transcriber = await getPipeline();
    if (!transcriber) return null;

    let samples;
    try {
        samples = await decodeAudioToFloat32(audioPath);
    } catch (err) {
        console.warn('[LocalWhisper] ffmpeg decode failed:', err.message);
        return null;
    }

    const durationSec = samples.length / 16000;
    if (durationSec > LOCAL_WHISPER_MAX_DURATION_SEC) {
        const e = new Error(`Audio too long for local model (${Math.round(durationSec)}s > ${LOCAL_WHISPER_MAX_DURATION_SEC}s cap)`);
        e.code = 'local_whisper_too_long';
        throw e;
    }

    let raw;
    try {
        raw = await runSerialized(() =>
            withTimeout(
                transcriber(samples, {
                    language: langHint,
                    task: 'transcribe',
                    return_timestamps: options.returnTimestamps !== false,
                    chunk_length_s: 30,        // Whisper's native window
                    stride_length_s: 5,        // overlap to merge boundaries cleanly
                }),
                LOCAL_WHISPER_TIMEOUT_MS,
                'LocalWhisper inference',
            )
        );
    } catch (err) {
        console.warn('[LocalWhisper] inference failed:', err.message);
        return null;
    }

    const text = (raw?.text || '').trim();
    const chunks = Array.isArray(raw?.chunks) ? raw.chunks : [];

    // Map Whisper chunks → de algemene segment-shape die de pipeline gebruikt.
    const segments = chunks
        .filter(c => c?.text && c.timestamp)
        .map(c => ({
            text: String(c.text).trim(),
            start: Number(c.timestamp?.[0] ?? 0),
            end: Number(c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0),
            speakerId: 'speaker_0',
        }));

    // Als er geen chunks zijn (bv. heel korte clip) maken we toch één segment
    // van de hele tekst zodat downstream code niet stuk gaat.
    if (segments.length === 0 && text) {
        segments.push({ text, start: 0, end: durationSec, speakerId: 'speaker_0' });
    }

    return {
        text,
        segments,
        language,
        durationSec: Math.round(durationSec),
        provider: 'local-whisper',
    };
}

/**
 * Background pre-warm; runs once at server boot so the first user-upload
 * doesn't pay the model-download latency. Safe to call unconditionally.
 */
function warmLocalWhisper() {
    getPipeline().catch(() => { /* already logged */ });
}

module.exports = {
    transcribeLocally,
    warmLocalWhisper,
    LOCAL_WHISPER_MODEL_ID,
    _limits: {
        maxDurationSec: LOCAL_WHISPER_MAX_DURATION_SEC,
        timeoutMs:      LOCAL_WHISPER_TIMEOUT_MS,
        wasmThreads:    LOCAL_WHISPER_WASM_THREADS,
    },
};
