/**
 * In-process cross-encoder reranking via Transformers.js.
 *
 * Runs Xenova/bge-reranker-base (MIT) entirely in Node — no GPU sidecar,
 * no Python, no managed-API call. Used as the CPU rerank tier alongside
 * Azure Cohere (provider tier) and the optional vLLM `RERANKER_URL`
 * sidecar (local-LLM tier) referenced from localKBIngest.
 *
 * Resource guards mirror localPiiDetection.js:
 *   - Lazy singleton pipeline (loaded on first call, cached for life of
 *     the process). First call downloads ~280 MB on cold cache.
 *   - WASM thread count capped so inference doesn't peg every core.
 *   - Single-flight queue serialises calls — concurrent rerank requests
 *     would otherwise each spawn their own thread pool.
 *   - Per-call timeout aborts runaway inferences; caller falls back.
 *
 * Output shape: [{ index, relevance_score }, ...] sorted descending,
 * which matches the Cohere rerank response shape consumed by
 * localKBIngest.js so callers can dispatch transparently.
 */

const os = require('os');

// Pinned permissive-licensed cross-encoder model (MIT). Do NOT swap to
// a Llama-Community-licensed reranker without a licence audit.
const CPU_RERANK_MODEL_ID = 'Xenova/bge-reranker-base';

// ── Resource caps (override via env) ──────────────────────────────────
const CPU_RERANK_TIMEOUT_MS  = Number(process.env.CPU_RERANK_TIMEOUT_MS)  || 8000;
const CPU_RERANK_MAX_DOCS    = Number(process.env.CPU_RERANK_MAX_DOCS)    || 50;
const CPU_RERANK_DOC_CHARS   = Number(process.env.CPU_RERANK_DOC_CHARS)   || 2000;
const CPU_RERANK_QUERY_CHARS = Number(process.env.CPU_RERANK_QUERY_CHARS) || 500;
const CPU_RERANK_WASM_THREADS = Math.max(
    1,
    Number(process.env.CPU_RERANK_WASM_THREADS) ||
        Math.max(1, Math.floor((os.cpus()?.length || 2) / 2))
);

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
                    env.backends.onnx.wasm.numThreads = CPU_RERANK_WASM_THREADS;
                }
            } catch (_) { /* older versions: ignore */ }

            const ranker = await pipeline('text-classification', CPU_RERANK_MODEL_ID, {
                dtype: 'q8',
            });
            console.log(`[CpuRerank] Model ${CPU_RERANK_MODEL_ID} ready (threads=${CPU_RERANK_WASM_THREADS}, maxDocs=${CPU_RERANK_MAX_DOCS})`);
            return ranker;
        } catch (err) {
            console.warn(`[CpuRerank] Failed to load ${CPU_RERANK_MODEL_ID}: ${err.message}`);
            _loadFailed = true;
            return null;
        }
    })();
    return _pipelinePromise;
}

// ── Single-flight queue ───────────────────────────────────────────────
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

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

/**
 * Rerank `documents` against `query` using the in-process cross-encoder.
 *
 * @param {string} query - User search query.
 * @param {string[]} documents - Candidate documents (raw text).
 * @param {number} [topN] - Optional cap on returned items. Defaults to all.
 * @returns {Promise<Array<{index: number, relevance_score: number}>>}
 *   Sorted descending by relevance_score (0..1). Empty array on any
 *   failure so callers can fall back to RRF / passthrough.
 */
async function rerankCpu(query, documents, topN = null) {
    if (!query || !Array.isArray(documents) || documents.length === 0) return [];

    const ranker = await getPipeline();
    if (!ranker) return [];

    const truncatedQuery = String(query).slice(0, CPU_RERANK_QUERY_CHARS);
    const limited = documents.slice(0, CPU_RERANK_MAX_DOCS);
    const pairs = limited.map(d => ({
        text: truncatedQuery,
        text_pair: String(d || '').slice(0, CPU_RERANK_DOC_CHARS),
    }));

    try {
        const startedAt = Date.now();
        const out = await runSerialized(() =>
            withTimeout(ranker(pairs), CPU_RERANK_TIMEOUT_MS, 'cpu-rerank')
        );
        // Cross-encoder pipeline returns [{ label, score }, ...] aligned
        // with the input order. BGE rerankers emit a single logit-ish
        // score; normalise via sigmoid so callers can compare against
        // Azure Cohere's already 0..1 relevance scores.
        const scored = (Array.isArray(out) ? out : [out]).map((r, i) => ({
            index: i,
            relevance_score: typeof r?.score === 'number' ? sigmoid(r.score) : 0,
        }));
        scored.sort((a, b) => b.relevance_score - a.relevance_score);
        const result = topN ? scored.slice(0, topN) : scored;
        const tookMs = Date.now() - startedAt;
        console.log(`[CpuRerank] reranked ${pairs.length} docs in ${tookMs}ms (top=${result[0]?.relevance_score?.toFixed(3)})`);
        return result;
    } catch (err) {
        console.warn(`[CpuRerank] inference failed (${err.message}); caller should fall back`);
        return [];
    }
}

/**
 * Best-effort warmup. Triggers model load + first inference so the
 * first user-facing rerank doesn't pay the ~5-10s cold-start cost.
 * Safe to call from boot — never throws.
 */
async function warmup() {
    try {
        await rerankCpu('warmup', ['warmup document'], 1);
    } catch (_) { /* fail-open */ }
}

module.exports = {
    rerankCpu,
    warmup,
    CPU_RERANK_MODEL_ID,
};
