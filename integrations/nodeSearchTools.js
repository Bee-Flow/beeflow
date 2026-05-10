/**
 * Node-Search Tools — Cloud-only agent web search
 *
 * Parallel implementation to agentSearchTools.js: runs the entire
 * Serper -> fetch -> embed -> rerank -> cleanup pipeline inside this
 * Node.js process using configured chat/embedding providers. No GPU
 * service required.
 *
 * Selected when admin sets `search_provider = 'node-search'`.
 * Result shape mirrors agentSearchTools so agents see no difference.
 */

const configStore = require('../stores/configStore');
const { resolveInferenceTargetsWithSecrets } = require('../core/webSearchInferenceResolver');
const { getAdapter } = require('../core/providers');

const SERPER_URL = 'https://google.serper.dev/search';
const PAGE_FETCH_TIMEOUT_MS = 12000;
const PAGE_BYTE_CAP = 1_500_000;
const SERPER_TIMEOUT_MS = 12000;

// ─── Provider HTTP helpers ───────────────────────────────────────

function normalizeBaseUrl(url) {
    return (url || '').replace(/\/+$/, '');
}

/**
 * Call an OpenAI-compatible /v1/embeddings endpoint.
 * Works for OpenAI, Mistral (api.mistral.ai/v1), and generic providers.
 */
async function embedOpenAICompatible({ apiKey, baseUrl, model, inputs }) {
    const root = normalizeBaseUrl(baseUrl);
    const url = root.endsWith('/v1') ? `${root}/embeddings` : `${root}/v1/embeddings`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: inputs }),
        signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Embedding API ${res.status}: ${txt.slice(0, 300)}`);
    }
    const data = await res.json();
    return (data.data || []).sort((a, b) => a.index - b.index).map(e => e.embedding);
}

/**
 * Azure OpenAI embeddings — different URL shape per deployment.
 * Falls back to admin-configured endpoint/key when the provider entry
 * lacks a usable URL.
 */
async function embedAzure({ apiKey, baseUrl, model, inputs }) {
    let endpoint = baseUrl;
    let key = apiKey;
    if (!endpoint) endpoint = await configStore.getConfig('azure_openai_embedding_endpoint');
    if (!key) key = await configStore.getSecret('azure_openai_embedding_key');
    const root = normalizeBaseUrl(endpoint);
    const url = `${root}/openai/deployments/${encodeURIComponent(model)}/embeddings?api-version=2024-06-01`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': key },
        body: JSON.stringify({ input: inputs }),
        signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Azure embedding ${res.status}: ${txt.slice(0, 300)}`);
    }
    const data = await res.json();
    return (data.data || []).sort((a, b) => a.index - b.index).map(e => e.embedding);
}

async function embedTexts(target, inputs) {
    if (!target?.providerId || !target?.modelId) {
        throw new Error('Embedding model not configured (set one in AI Configuratie → Web Search Inference, or globally in Embeddings)');
    }
    if (!Array.isArray(inputs) || inputs.length === 0) return [];
    const type = target.providerType;
    if (type === 'azure') return embedAzure({ apiKey: target.apiKey, baseUrl: target.endpoint, model: target.modelId, inputs });
    return embedOpenAICompatible({ apiKey: target.apiKey, baseUrl: target.endpoint, model: target.modelId, inputs });
}

// ─── Math ─────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ─── HTML cleaning (no external deps) ────────────────────────────

const HTML_TAG_RE = /<\/?(?:script|style|noscript|iframe|svg|nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|iframe|svg|nav|header|footer|aside|form)>/gi;
const ANY_TAG_RE = /<[^>]+>/g;
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

function stripHtml(html) {
    return html
        .replace(HTML_TAG_RE, ' ')
        .replace(ANY_TAG_RE, ' ')
        .replace(/&[a-z#0-9]+;/gi, m => ENTITIES[m] || ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function chunkText(text, size = 1200) {
    const chunks = [];
    let i = 0;
    while (i < text.length && chunks.length < 8) {
        chunks.push(text.slice(i, i + size));
        i += size;
    }
    return chunks;
}

// ─── Page fetch ───────────────────────────────────────────────────

async function fetchPage(url) {
    try {
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; BeeFlowSearchBot/1.0; +https://beeflow.ai)',
                Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return null;
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (!ct.includes('html') && !ct.includes('text/plain')) return null;
        const reader = res.body?.getReader();
        if (!reader) return null;
        const decoder = new TextDecoder();
        let html = '';
        let bytes = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            html += decoder.decode(value, { stream: true });
            if (bytes >= PAGE_BYTE_CAP) {
                try { await reader.cancel(); } catch (_) {}
                break;
            }
        }
        html += decoder.decode();
        return stripHtml(html);
    } catch (err) {
        console.warn(`[NodeSearch] fetch failed for ${url}: ${err.message}`);
        return null;
    }
}

// ─── Serper SERP call ─────────────────────────────────────────────

async function serperSearch({ query, num }) {
    const key = await configStore.getSecret('serper_api_key');
    if (!key) throw new Error('Serper API key not configured');
    const res = await fetch(SERPER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
        body: JSON.stringify({ q: query, num }),
        signal: AbortSignal.timeout(SERPER_TIMEOUT_MS),
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Serper ${res.status}: ${txt.slice(0, 300)}`);
    }
    const data = await res.json();
    const organic = Array.isArray(data.organic) ? data.organic : [];
    return organic.map(r => ({
        title: r.title || 'Untitled',
        url: r.link || '',
        snippet: r.snippet || '',
    }));
}

// ─── Rerank ───────────────────────────────────────────────────────

async function rerankCosine({ rerank: _rerank, embed }, query, results) {
    const texts = results.map(r => `${r.title}\n${r.snippet}\n${(r.content || '').slice(0, 1500)}`);
    const [queryVec, ...docVecs] = await embedTexts(embed, [query, ...texts]);
    if (!queryVec) return results;
    return results
        .map((r, i) => ({ ...r, score: cosineSimilarity(queryVec, docVecs[i]) }))
        .sort((a, b) => (b.score || 0) - (a.score || 0));
}

async function rerankProviderLLM(rerankTarget, query, results) {
    if (!rerankTarget.providerType || !rerankTarget.endpoint) return results;
    const adapter = getAdapter(rerankTarget.providerType, rerankTarget.endpoint);
    const baseUrl = normalizeBaseUrl(rerankTarget.endpoint);
    const numbered = results.map((r, i) => `[${i}] ${r.title}\n${(r.snippet || '').slice(0, 400)}`).join('\n\n');
    const messages = [
        { role: 'system', content: 'You score search results for relevance. Return ONLY a JSON array of objects: [{"i": <index>, "score": <0-1>}]. No prose.' },
        { role: 'user', content: `Query: ${query}\n\nResults:\n${numbered}\n\nReturn JSON only.` },
    ];
    try {
        const out = await adapter.chat(rerankTarget.apiKey, baseUrl, rerankTarget.modelId, messages, { temperature: 0, maxTokens: 800 });
        const text = (out.content || '').trim();
        const match = text.match(/\[[\s\S]*\]/);
        if (!match) return results;
        const scores = JSON.parse(match[0]);
        const map = new Map();
        for (const s of scores) {
            if (typeof s?.i === 'number' && typeof s?.score === 'number') map.set(s.i, s.score);
        }
        return results
            .map((r, i) => ({ ...r, score: map.has(i) ? map.get(i) : 0 }))
            .sort((a, b) => (b.score || 0) - (a.score || 0));
    } catch (err) {
        console.warn(`[NodeSearch] provider rerank failed (${err.message}); returning original order`);
        return results;
    }
}

async function rerankCpuLocal(query, results) {
    try {
        const { rerankCpu } = require('../core/rerank/cpuCrossEncoder');
        const docs = results.map(r => `${r.title}\n${r.snippet}\n${(r.content || '').slice(0, 1500)}`);
        const scored = await rerankCpu(query, docs);
        if (scored.length === 0) return results;
        return scored.map(s => ({ ...results[s.index], score: s.relevance_score }));
    } catch (err) {
        console.warn(`[NodeSearch] CPU rerank failed (${err.message}); returning original order`);
        return results;
    }
}

async function applyRerank(targets, query, results) {
    const method = targets.rerank?.method || 'cosine';
    if (method === 'disabled' || results.length <= 1) return results;
    if (method === 'cpu') {
        return rerankCpuLocal(query, results);
    }
    if (method === 'local') {
        console.warn('[NodeSearch] rerank.method=local is not supported by node-search; falling back to cosine');
        return rerankCosine(targets, query, results);
    }
    if (method === 'provider' && targets.rerank?.providerId && targets.rerank?.modelId) {
        return rerankProviderLLM(targets.rerank, query, results);
    }
    return rerankCosine(targets, query, results);
}

// ─── Cleanup (HTML -> compact markdown via configured chat model) ─

async function cleanupPage(cleanupTarget, query, page) {
    if (!cleanupTarget?.providerId || !cleanupTarget?.modelId || !cleanupTarget.endpoint) return null;
    const adapter = getAdapter(cleanupTarget.providerType, cleanupTarget.endpoint);
    const baseUrl = normalizeBaseUrl(cleanupTarget.endpoint);
    const truncated = (page.content || '').slice(0, 12000);
    const messages = [
        { role: 'system', content: 'Convert raw scraped webpage text into a compact, agent-readable markdown summary that preserves facts relevant to the query. Drop nav, ads, and boilerplate. Keep numbers, names, dates, and direct quotes verbatim. No preamble.' },
        { role: 'user', content: `Query: ${query}\n\nURL: ${page.url}\n\nRaw content:\n${truncated}` },
    ];
    try {
        const out = await adapter.chat(cleanupTarget.apiKey, baseUrl, cleanupTarget.modelId, messages, { temperature: 0.1, maxTokens: 700 });
        return (out.content || '').trim() || null;
    } catch (err) {
        console.warn(`[NodeSearch] cleanup failed for ${page.url}: ${err.message}`);
        return null;
    }
}

// ─── Public entry point ──────────────────────────────────────────

async function executeNodeSearchTool(toolName, args) {
    if (toolName !== 'agent_search') {
        return { error: `Unknown search tool: ${toolName}` };
    }

    const { query, mode, max_results, fetch_top_n, detail_level } = args || {};
    if (!query) return { error: 'query is required' };

    let defaults = {};
    try { defaults = (await configStore.getConfig('agent_search_defaults')) || {}; } catch (_) {}

    const searchMode = ['web', 'web_fast', 'kb', 'auto'].includes(mode) ? mode : (defaults.mode || 'web');
    if (searchMode === 'kb' || searchMode === 'auto') {
        // KB-only / KB-first paths require the GPU service. Fall back to plain web.
        console.warn(`[NodeSearch] mode=${searchMode} not supported by node-search; using 'web' instead`);
    }
    const isWebFast = searchMode === 'web_fast';
    const modeDefaults = isWebFast ? (defaults.web_fast || {}) : (defaults.web || {});
    const maxResults = Math.min(Math.max(parseInt(max_results) || parseInt(modeDefaults.max_results) || (isWebFast ? 10 : 5), 1), isWebFast ? 20 : 10);
    const fetchTopN = isWebFast ? 0 : Math.min(Math.max(parseInt(fetch_top_n) || parseInt(modeDefaults.fetch_top_n) || 3, 1), 5);
    const detailLevel = ['basic', 'detailed', 'highly_detailed'].includes(detail_level) ? detail_level : (modeDefaults.detail_level || 'detailed');
    const maxTokens = parseInt(modeDefaults.max_tokens_markdown) || (isWebFast ? 1500 : 2000);

    console.log(`[NodeSearch] "${query}" mode=${searchMode} max=${maxResults} fetch=${fetchTopN} detail=${detailLevel}`);

    let targets;
    try {
        targets = await resolveInferenceTargetsWithSecrets();
    } catch (err) {
        return { error: `Failed to resolve inference targets: ${err.message}` };
    }
    if (targets.embed?.unresolved) {
        return { error: 'No embedding model resolved. Configure one in AI Configuratie → Web Search Inference (or set a global Embeddings model).' };
    }

    let results;
    try {
        results = await serperSearch({ query, num: maxResults });
    } catch (err) {
        return `Search failed: ${err.message}`;
    }
    if (results.length === 0) {
        return {
            error: `Search returned 0 results for "${query}". Try a shorter or differently-worded query, or report that current information could not be retrieved. Do NOT fabricate sources.`,
            results_count: 0,
            query,
            mode_used: searchMode,
        };
    }

    // Fetch top-N pages in parallel
    if (fetchTopN > 0) {
        const toFetch = results.slice(0, fetchTopN);
        const pages = await Promise.all(toFetch.map(r => fetchPage(r.url)));
        toFetch.forEach((r, i) => { if (pages[i]) r.content = pages[i]; });
    }

    // Rerank
    try {
        results = await applyRerank(targets, query, results);
    } catch (err) {
        console.warn(`[NodeSearch] rerank pipeline failed (${err.message}); continuing with original order`);
    }

    // Cleanup top fetched pages (only those with content)
    const cleanupTarget = targets.cleanup;
    const cleanupEnabled = !!(cleanupTarget?.providerId && cleanupTarget?.modelId && cleanupTarget?.endpoint);
    if (cleanupEnabled) {
        const cleanupTargets = results.filter(r => r.content).slice(0, fetchTopN);
        await Promise.all(cleanupTargets.map(async r => {
            const cleaned = await cleanupPage(cleanupTarget, query, r);
            if (cleaned) r.markdown = cleaned;
        }));
    }

    // Truncate / format output (mirrors agentSearchTools shape)
    const sections = results.map((r, i) => {
        const score = typeof r.score === 'number' ? Math.round(r.score * 100) : '';
        const body = (r.markdown || r.content || r.snippet || '').slice(0, maxTokens);
        const header = r.url ? `### [${i + 1}. ${r.title}](${r.url})` : `### ${i + 1}. ${r.title}`;
        return `${header}${score !== '' ? ` (relevance: ${score}%)` : ''}\n\n${body}`;
    });

    const sourcesList = results.map((r, i) => (
        r.url ? `[${i + 1}] [${r.title}](${r.url})` : `[${i + 1}] ${r.title}`
    )).join('\n');

    const markdown = `# Search Results for: "${query}"
**Mode:** ${searchMode} (cloud) | **Results:** ${results.length}

---

${sections.join('\n\n---\n\n')}

---

## Sources
${sourcesList}

> **IMPORTANT:** Only cite URLs listed above. Never invent URLs. Use inline citations like [Source Title](url).`;

    return markdown;
}

module.exports = {
    executeNodeSearchTool,
};
