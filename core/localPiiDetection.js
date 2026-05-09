/**
 * In-process PII detection via Transformers.js — runs the OpenAI Privacy
 * Filter token-classification model (Apache 2.0) entirely in Node, no
 * Python or external service required.
 *
 * Used as a CPU fallback when Azure AI Text Analytics is not configured
 * AND the org admin has enabled the local detector via the Privacy Shield
 * panel (`localPiiEnabled`). The model is loaded lazily on the first call
 * so server boot stays fast; subsequent calls reuse the cached pipeline.
 *
 * Resource guards (so a single huge prompt cannot freeze the host):
 *   - Inputs over LOCAL_PII_MAX_INPUT_CHARS are processed in slices, not
 *     fed into the model whole. Quadratic-ish attention cost is bounded.
 *   - WASM thread count is capped at LOCAL_PII_WASM_THREADS so inference
 *     doesn't saturate every core on the box. Default = half the CPUs.
 *   - A single-flight queue serialises calls so concurrent requests don't
 *     each spawn their own thread pool and OOM the laptop.
 *   - LOCAL_PII_TIMEOUT_MS aborts a single inference run if it exceeds
 *     the budget; the caller fails open.
 *
 * Output shape matches `detectPiiViaCpuModel()` so callers in
 * `azurePiiDetection.js` can swap detectors transparently.
 */

const os = require('os');

const LOCAL_PII_MODEL_ID = 'openai/privacy-filter';

// ── Resource caps (override via env) ──────────────────────────────────
const LOCAL_PII_MAX_INPUT_CHARS = Number(process.env.LOCAL_PII_MAX_INPUT_CHARS) || 8000;
const LOCAL_PII_CHUNK_CHARS     = Number(process.env.LOCAL_PII_CHUNK_CHARS)     || 4000;
const LOCAL_PII_CHUNK_OVERLAP   = Number(process.env.LOCAL_PII_CHUNK_OVERLAP)   || 200;
const LOCAL_PII_TIMEOUT_MS      = Number(process.env.LOCAL_PII_TIMEOUT_MS)      || 8000;
const LOCAL_PII_WASM_THREADS    = Math.max(
    1,
    Number(process.env.LOCAL_PII_WASM_THREADS) ||
        Math.max(1, Math.floor((os.cpus()?.length || 2) / 2))
);

// OpenAI Privacy Filter labels → canonical PII category keys used by
// `azurePiiDetection.js` and the admin UI.
const LABEL_TO_CATEGORY = {
    'private_person':  'Person',
    'private_email':   'Email',
    'private_phone':   'PhoneNumber',
    'private_address': 'Address',
    'private_url':     'URL',
    'private_date':    'DateOfBirth',
    'account_number':  'BankAccountNumber',
    'secret':          'AzureStorageAccountKey',
};

let _pipelinePromise = null;
let _loadFailed = false;

/**
 * Lazy-load the token-classification pipeline. Returns null if the
 * pipeline cannot be loaded (no network, missing dep, etc.) so callers
 * can fail-open without crashing the request.
 */
async function getPipeline() {
    if (_loadFailed) return null;
    if (_pipelinePromise) return _pipelinePromise;

    _pipelinePromise = (async () => {
        try {
            const { pipeline, env } = await import('@huggingface/transformers');
            env.allowRemoteModels = true;
            // Cap CPU usage. Without this the WASM backend grabs every
            // logical core and pegs the machine on a single inference.
            try {
                if (env.backends?.onnx?.wasm) {
                    env.backends.onnx.wasm.numThreads = LOCAL_PII_WASM_THREADS;
                }
            } catch (_) { /* older versions: ignore */ }

            const cls = await pipeline('token-classification', LOCAL_PII_MODEL_ID, {
                dtype: 'q8',
            });
            console.log(`[LocalPii] Model ${LOCAL_PII_MODEL_ID} ready (threads=${LOCAL_PII_WASM_THREADS}, maxInput=${LOCAL_PII_MAX_INPUT_CHARS})`);
            return cls;
        } catch (err) {
            console.warn(`[LocalPii] Failed to load ${LOCAL_PII_MODEL_ID}: ${err.message}`);
            _loadFailed = true;
            return null;
        }
    })();
    return _pipelinePromise;
}

// ── Single-flight queue ───────────────────────────────────────────────
// Two concurrent inferences each spin up their own WASM thread pool and
// double the peak RAM. Serialising them keeps memory predictable.
let _inferenceChain = Promise.resolve();
function runSerialized(fn) {
    const next = _inferenceChain.then(() => fn(), () => fn());
    // Don't propagate rejections through the chain — every caller handles
    // its own failure path.
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

/**
 * Slice an oversized input into overlapping chunks so a single huge
 * prompt cannot dominate the model context. The overlap prevents an
 * entity from being cut in half across chunk boundaries.
 */
function sliceForInference(text) {
    if (text.length <= LOCAL_PII_CHUNK_CHARS) {
        return [{ offset: 0, text }];
    }
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        let end = Math.min(start + LOCAL_PII_CHUNK_CHARS, text.length);
        if (end < text.length) {
            // Prefer breaking on a sentence-ish boundary inside the last
            // 20% of the slice to avoid splitting a multi-word name.
            const window = text.slice(start + Math.floor(LOCAL_PII_CHUNK_CHARS * 0.8), end);
            const breakIdx = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'), window.lastIndexOf(' '));
            if (breakIdx > 0) {
                end = start + Math.floor(LOCAL_PII_CHUNK_CHARS * 0.8) + breakIdx + 1;
            }
        }
        chunks.push({ offset: start, text: text.slice(start, end) });
        if (end >= text.length) break;
        start = Math.max(end - LOCAL_PII_CHUNK_OVERLAP, start + 1);
    }
    return chunks;
}

/**
 * Run the local PII detector on `text`.
 *
 * @param {string} text
 * @param {string[]|null} enabledCategories — restrict output to these category keys
 * @param {number} confidenceThreshold — minimum entity score
 * @returns {Promise<{ hasPii: boolean, entities: object[], redactedText: string } | null>}
 *          Returns null if the model is unavailable so caller can fail-open.
 */
async function detectPiiLocal(text, enabledCategories = null, confidenceThreshold = 0.7) {
    if (!text || text.length < 3) {
        return { hasPii: false, entities: [], redactedText: text };
    }

    // Hard cap. Anything larger gets truncated rather than refused so
    // detection still happens on the head of the document.
    let workingText = text;
    if (workingText.length > LOCAL_PII_MAX_INPUT_CHARS) {
        console.warn(`[LocalPii] Input ${workingText.length} chars exceeds cap ${LOCAL_PII_MAX_INPUT_CHARS}, truncating`);
        workingText = workingText.slice(0, LOCAL_PII_MAX_INPUT_CHARS);
    }

    const cls = await getPipeline();
    if (!cls) return null;

    const slices = sliceForInference(workingText);
    const seen = new Set();
    const entities = [];

    for (const slice of slices) {
        let raw;
        try {
            raw = await runSerialized(() =>
                withTimeout(
                    cls(slice.text, { aggregation_strategy: 'simple' }),
                    LOCAL_PII_TIMEOUT_MS,
                    'LocalPii inference',
                )
            );
        } catch (err) {
            console.warn('[LocalPii] inference failed:', err.message);
            // Stop processing remaining slices — if one slice OOMs/timeouts
            // the next one likely will too. Fail open with what we have.
            return entities.length > 0
                ? { hasPii: true, entities, redactedText: workingText }
                : null;
        }

        let cursor = 0;
        for (const ent of raw || []) {
            const score = Number(ent.score ?? 0);
            if (score < confidenceThreshold) continue;

            const rawLabel = String(ent.entity_group ?? ent.entity ?? '').toLowerCase();
            const category = LABEL_TO_CATEGORY[rawLabel];
            if (!category) continue;
            if (enabledCategories && !enabledCategories.includes(category)) continue;

            const word = String(ent.word ?? '').replace(/^\s+|\s+$/g, '');
            if (!word) continue;

            // Locate the word inside the slice, then translate to the
            // global offset in `workingText`.
            let localStart = slice.text.indexOf(word, cursor);
            if (localStart === -1) localStart = slice.text.indexOf(word);
            if (localStart === -1) continue;
            const localEnd = localStart + word.length;
            cursor = localEnd;

            const start = slice.offset + localStart;
            const end = slice.offset + localEnd;
            const key = `${start}:${end}:${category}`;
            if (seen.has(key)) continue; // overlap region produced this entity in a previous slice
            seen.add(key);

            entities.push({
                text:        word,
                category,
                subCategory: null,
                confidence:  Math.round(score * 10000) / 10000,
                offset:      start,
                length:      end - start,
                label:       category,
            });
        }
    }

    entities.sort((a, b) => a.offset - b.offset);

    return {
        hasPii:       entities.length > 0,
        entities,
        redactedText: workingText,
    };
}

/**
 * Pre-warm the model in the background. Call once at server startup so
 * the first user request doesn't pay the model-download latency.
 */
function warmLocalPii() {
    getPipeline().catch(() => { /* already logged */ });
}

module.exports = {
    detectPiiLocal,
    warmLocalPii,
    LOCAL_PII_MODEL_ID,
    // Exported for tests / admin diagnostics
    _limits: {
        maxInputChars: LOCAL_PII_MAX_INPUT_CHARS,
        chunkChars:    LOCAL_PII_CHUNK_CHARS,
        timeoutMs:     LOCAL_PII_TIMEOUT_MS,
        wasmThreads:   LOCAL_PII_WASM_THREADS,
    },
};
