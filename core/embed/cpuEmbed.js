/**
 * In-process embeddings via Transformers.js.
 *
 * Runs Xenova/multilingual-e5-small (MIT, 470 MB, 384-dim, 100+ langs)
 * entirely in Node — no GPU, no Python, no managed-API call. Used as
 * the CPU embedding tier when no provider is configured.
 *
 * 384-dim output is intentional: small footprint, fast pgvector queries,
 * works alongside any vector store column already provisioned for
 * 384-dim providers (e.g. text-embedding-3-small downcast).
 *
 * Resource guards mirror cpuCrossEncoder.js / localPiiDetection.js.
 */

const os = require('os');
const path = require('path');

// Pinned permissive-licensed embedding model (MIT). Multilingual-e5
// requires the "query: " / "passage: " prefix for best quality —
// callers don't have to know that; we add it in `embedTexts`.
const CPU_EMBED_MODEL_ID = 'Xenova/multilingual-e5-small';
const CPU_EMBED_DIM = 384;

const CPU_EMBED_TIMEOUT_MS       = Number(process.env.CPU_EMBED_TIMEOUT_MS)      || 8000;
// Cold-start budget for model download + ONNX init. See cpuCrossEncoder.js
// for the same pattern — both pipelines share the same cache directory
// so the first call after a fresh boot pays one download per model.
const CPU_EMBED_LOAD_TIMEOUT_MS  = Number(process.env.CPU_EMBED_LOAD_TIMEOUT_MS) || 60000;
const CPU_EMBED_BATCH_SIZE       = Number(process.env.CPU_EMBED_BATCH_SIZE)      || 16;
const CPU_EMBED_TEXT_CHARS       = Number(process.env.CPU_EMBED_TEXT_CHARS)      || 2000;
const CPU_EMBED_WASM_THREADS = Math.max(
    1,
    Number(process.env.CPU_EMBED_WASM_THREADS) ||
        Math.max(1, Math.floor((os.cpus()?.length || 2) / 2))
);

const CPU_EMBED_CACHE_DIR = process.env.HF_HOME
    || process.env.TRANSFORMERS_CACHE
    || path.join(__dirname, '..', '..', 'data', 'transformers-cache');

let _pipelinePromise = null;
let _loadFailed = false;

async function getPipeline() {
    if (_loadFailed) return null;
    if (_pipelinePromise) return _pipelinePromise;

    _pipelinePromise = (async () => {
        try {
            const { pipeline, env } = await import('@huggingface/transformers');
            env.cacheDir = CPU_EMBED_CACHE_DIR;
            env.allowRemoteModels = true;
            env.allowLocalModels = true;
            try {
                if (env.backends?.onnx?.wasm) {
                    env.backends.onnx.wasm.numThreads = CPU_EMBED_WASM_THREADS;
                }
            } catch (_) { /* older versions: ignore */ }

            const extractor = await withTimeout(
                pipeline('feature-extraction', CPU_EMBED_MODEL_ID, { dtype: 'q8' }),
                CPU_EMBED_LOAD_TIMEOUT_MS,
                'cpu-embed-load',
            );
            console.log(`[CpuEmbed] Model ${CPU_EMBED_MODEL_ID} ready (cache=${CPU_EMBED_CACHE_DIR}, dim=${CPU_EMBED_DIM}, threads=${CPU_EMBED_WASM_THREADS})`);
            return extractor;
        } catch (err) {
            console.warn(`[CpuEmbed] Failed to load ${CPU_EMBED_MODEL_ID}: ${err.message}`);
            _loadFailed = true;
            return null;
        }
    })();
    return _pipelinePromise;
}

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

/**
 * Embed an array of texts. Returns an array of 384-dim float vectors,
 * one per input, in the same order. Empty array on failure so callers
 * can fall back gracefully.
 *
 * @param {string[]} texts
 * @param {{ kind?: 'query'|'passage' }} [options] — controls the
 *   multilingual-e5 prefix. Default 'passage' (storage); use 'query'
 *   for the search-time embedding.
 * @returns {Promise<number[][]>}
 */
async function cpuEmbed(texts, options = {}) {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    const extractor = await getPipeline();
    if (!extractor) return [];

    const prefix = options.kind === 'query' ? 'query: ' : 'passage: ';
    const prepared = texts.map(t => prefix + String(t || '').slice(0, CPU_EMBED_TEXT_CHARS));

    const out = [];
    for (let i = 0; i < prepared.length; i += CPU_EMBED_BATCH_SIZE) {
        const batch = prepared.slice(i, i + CPU_EMBED_BATCH_SIZE);
        try {
            const startedAt = Date.now();
            const tensors = await runSerialized(() =>
                withTimeout(
                    extractor(batch, { pooling: 'mean', normalize: true }),
                    CPU_EMBED_TIMEOUT_MS,
                    'cpu-embed'
                )
            );
            // tensors is a Tensor whose `.tolist()` yields [batch][dim]
            const list = typeof tensors.tolist === 'function' ? tensors.tolist() : tensors;
            for (const vec of list) out.push(Array.from(vec));
            console.log(`[CpuEmbed] embedded ${batch.length} texts in ${Date.now() - startedAt}ms`);
        } catch (err) {
            console.warn(`[CpuEmbed] inference failed (${err.message})`);
            return [];
        }
    }
    return out;
}

async function warmup() {
    try {
        const out = await cpuEmbed(['warmup']);
        if (out.length > 0) {
            console.log('[CpuEmbed] Warmup complete — first user query will be fast.');
        }
    } catch (_) { /* fail-open */ }
}

module.exports = {
    cpuEmbed,
    warmup,
    CPU_EMBED_MODEL_ID,
    CPU_EMBED_DIM,
};
