/**
 * Search service — Node.js implementation of the hosted Python
 * search-service HTTP surface. Mounted at `/api/search` and meant
 * to be reached via SEARCH_SERVICE_URL=https://server.<host>/api/search
 * so the existing clients (`server/integrations/agentSearchTools.js`,
 * `server/core/kbIngestionHelpers.js`) work unchanged.
 *
 * Endpoints:
 *   GET  /health
 *   POST /embed
 *   POST /rerank
 *   POST /tools/kb-search
 *   POST /tools/search        (web modes via Serper.dev; kb modes via searchLocally)
 *   POST /kb/ingest/json
 *
 * Wire format mirrors `search-service/app/routers/*` so a customer can
 * swap their SEARCH_SERVICE_URL from the hosted Python service to this
 * URL with no other change.
 */

const express = require('express');
const router = express.Router();

const { cpuEmbed, CPU_EMBED_MODEL_ID, CPU_EMBED_DIM } = require('../core/embed/cpuEmbed');
const { rerankCpu, CPU_RERANK_MODEL_ID } = require('../core/rerank/cpuCrossEncoder');
const { ingestLocally, searchLocally } = require('../core/localKBIngest');
const configStore = require('../stores/configStore');

// ─── Auth middleware ────────────────────────────────────────────
// Mirrors the guard-service contract: if SERVICES_API_KEY is set,
// callers must present it via X-API-Key. /health is always public.
function apiKeyAuth(req, res, next) {
    if (req.path === '/health') return next();
    const expected = process.env.SERVICES_API_KEY;
    if (!expected) return next(); // unset → open (dev / single-node)
    if (req.get('X-API-Key') === expected) return next();
    return res.status(401).json({ error: 'invalid or missing X-API-Key' });
}

router.use(express.json({ limit: '20mb' }));
router.use(apiKeyAuth);

// ─── Health ─────────────────────────────────────────────────────
router.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        embed: { model: CPU_EMBED_MODEL_ID, dim: CPU_EMBED_DIM },
        rerank: { model: CPU_RERANK_MODEL_ID },
    });
});

// ─── /embed ─────────────────────────────────────────────────────
// Body: { texts: string[], kind?: 'query' | 'passage' }
// Returns: { vectors, dim, model }
router.post('/embed', async (req, res) => {
    const { texts, kind } = req.body || {};
    if (!Array.isArray(texts) || texts.length === 0) {
        return res.status(400).json({ error: 'texts must be a non-empty array of strings' });
    }
    try {
        const vectors = await cpuEmbed(texts, { kind: kind === 'query' ? 'query' : 'passage' });
        if (vectors.length === 0) {
            return res.status(503).json({ error: 'embedding model not available' });
        }
        res.json({ vectors, dim: vectors[0].length, model: CPU_EMBED_MODEL_ID });
    } catch (err) {
        console.error('[Search/embed] error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── /rerank ────────────────────────────────────────────────────
// Body: { query: string, documents: string[], top_n?: int }
// Returns: { reranked: [{ index, relevance_score }], model }
router.post('/rerank', async (req, res) => {
    const { query, documents, top_n } = req.body || {};
    if (!query || !Array.isArray(documents) || documents.length === 0) {
        return res.status(400).json({ error: 'query and non-empty documents[] required' });
    }
    try {
        const reranked = await rerankCpu(query, documents, top_n || null);
        if (reranked.length === 0) {
            return res.status(503).json({ error: 'reranker not available' });
        }
        res.json({ reranked, model: CPU_RERANK_MODEL_ID });
    } catch (err) {
        console.error('[Search/rerank] error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── /tools/kb-search ───────────────────────────────────────────
// Body: { tenant_id, kb_ids: string[], query, top_k?, rerank? }
// Returns: { query, chunks: [{ content, title?, source_uri?, score }], total }
router.post('/tools/kb-search', async (req, res) => {
    const { tenant_id, kb_ids, query, top_k } = req.body || {};
    if (!tenant_id || !Array.isArray(kb_ids) || kb_ids.length === 0 || !query) {
        return res.status(400).json({ error: 'tenant_id, non-empty kb_ids[], and query required' });
    }
    try {
        const out = await searchLocally(tenant_id, kb_ids, query, { topK: Math.min(parseInt(top_k) || 10, 50) });
        const chunks = Array.isArray(out?.chunks) ? out.chunks : Array.isArray(out) ? out : [];
        const mapped = chunks.map(c => ({
            content: c.content || c.text || '',
            title: c.title || c.heading || null,
            source_uri: c.source_uri || c.sourceUri || null,
            score: typeof c.score === 'number' ? c.score : (c.relevance_score ?? 0),
        }));
        res.json({ query, chunks: mapped, total: mapped.length });
    } catch (err) {
        console.error('[Search/kb-search] error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Web search via Serper.dev ──────────────────────────────────
async function resolveSerperKey(req) {
    if (req.get('X-Serper-Key')) return req.get('X-Serper-Key');
    try {
        const k = await configStore.getSecret('serper_api_key');
        if (k) return k;
    } catch (_) { /* fall through */ }
    return process.env.SERPER_API_KEY || null;
}

async function serperSearch(query, maxResults, serperKey) {
    const resp = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: maxResults }),
        signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Serper HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = await resp.json();
    const organic = Array.isArray(data.organic) ? data.organic : [];
    // Map to the shape `agentSearchTools.js` expects (title, url, score, markdown).
    return organic.slice(0, maxResults).map((r, i) => ({
        source_type: 'web',
        title: r.title || 'Untitled',
        url: r.link || '',
        score: 1 - (i / Math.max(1, maxResults)),
        markdown: r.snippet || '',
        snippet: r.snippet || '',
        citations: r.link ? [{ url: r.link, title: r.title || '' }] : [],
        metadata: { cache_hit: false, fetched_at: new Date().toISOString() },
    }));
}

// ─── /tools/search ──────────────────────────────────────────────
// Body matches the hosted Python service so existing clients work unchanged.
// modes: web | web_fast | kb | auto
router.post('/tools/search', async (req, res) => {
    const body = req.body || {};
    const query = body.query;
    const mode = ['web', 'web_fast', 'kb', 'auto'].includes(body.mode) ? body.mode : 'web';
    if (!query) return res.status(400).json({ error: 'query is required' });

    const webOpts = body.web || {};
    const maxResults = Math.min(Math.max(parseInt(webOpts.max_results) || 5, 1), 20);

    try {
        // KB mode → searchLocally
        if (mode === 'kb' || mode === 'auto') {
            const tenantId = body.tenant_id || body.kb?.tenant_id;
            const kbIds = body.kb_ids || body.kb?.kb_ids || [];
            if (tenantId && Array.isArray(kbIds) && kbIds.length > 0) {
                const out = await searchLocally(tenantId, kbIds, query, {
                    topK: Math.min(parseInt(body.kb?.top_k_final) || 10, 50),
                });
                const chunks = Array.isArray(out?.chunks) ? out.chunks : Array.isArray(out) ? out : [];
                if (chunks.length > 0 || mode === 'kb') {
                    return res.json({
                        query,
                        mode_used: 'kb',
                        results: chunks.map(c => ({
                            source_type: 'kb',
                            title: c.title || c.heading || 'KB chunk',
                            url: c.source_uri || c.sourceUri || '',
                            score: typeof c.score === 'number' ? c.score : (c.relevance_score ?? 0),
                            markdown: c.content || c.text || '',
                            citations: [],
                            metadata: { cache_hit: false },
                        })),
                    });
                }
                // auto fell through with 0 KB hits → continue to web
            } else if (mode === 'kb') {
                return res.status(400).json({ error: 'kb mode requires tenant_id and kb_ids' });
            }
        }

        // Web modes: Serper.dev snippets
        const serperKey = await resolveSerperKey(req);
        if (!serperKey) {
            return res.status(503).json({ error: 'serper_api_key not configured (set via Admin → AI Config or SERPER_API_KEY env)' });
        }
        const results = await serperSearch(query, maxResults, serperKey);
        // NOTE: this is the "web_fast" wire shape — snippets only, no full-page
        // fetch + readability extraction. Acceptable for the initial drop;
        // the hosted Python service also degrades to this when fetching fails.
        return res.json({ query, mode_used: mode === 'auto' ? 'web' : mode, results });
    } catch (err) {
        console.error('[Search/tools-search] error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── /kb/ingest/json ────────────────────────────────────────────
// Body: { tenant_id, knowledge_base_id, document_id, content, title?, source_uri?, lang? }
// Returns: { document_id, chunks_created, status: 'ok' }
router.post('/kb/ingest/json', async (req, res) => {
    const { tenant_id, knowledge_base_id, document_id, content, title, source_uri, lang } = req.body || {};
    if (!tenant_id || !knowledge_base_id || !document_id || !content) {
        return res.status(400).json({ error: 'tenant_id, knowledge_base_id, document_id, content required' });
    }
    try {
        const result = await ingestLocally(tenant_id, knowledge_base_id, document_id, content, {
            title: title || '',
            sourceUri: source_uri || '',
            lang: lang || 'auto',
        });
        const chunksCreated = result?.chunks_created ?? result?.chunksCreated ?? result?.chunkCount ?? 0;
        res.json({ document_id, chunks_created: chunksCreated, status: 'ok' });
    } catch (err) {
        console.error('[Search/kb-ingest] error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
