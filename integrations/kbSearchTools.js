/**
 * Knowledge Base Search Tool
 *
 * Gives agents the ability to explicitly search their configured knowledge base
 * with any query. Useful when the automatic KB search (which uses the user's
 * message as the query) isn't sufficient — e.g., after reading an email,
 * the agent can search the KB with the email's topic to find relevant context.
 */

const configStore = require('../stores/configStore');
const { getServiceHeaders } = require('../core/serviceAuth');

const KB_SEARCH_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'kb_search',
            description: `Search the internal knowledge base for relevant context, procedures, policies, or previous similar interactions.

WHEN TO USE:
- Before drafting a reply to a question about a real topic, policy, or procedure.
- When the user asks for specific factual details you don't already have in context.

WHEN TO SKIP:
- Greetings / small-talk ("hi", "thanks", "how are you").
- Trivial confirmations ("ok", "got it").
- Anything already answered by text in the current message or earlier in this conversation.

SEARCH STRATEGY — ONE FOCUSED QUERY BY DEFAULT:
1. Make a single well-formed keyword query that captures the core topic. If the result is relevant, USE IT and move on — do not run additional searches.
2. Only run a second search if the first returned zero results. Use broader synonyms or an adjacent category term.
3. Do NOT run more than 2 searches per user turn. Additional searches waste tokens and delay the user.

QUERY FORMAT:
- 2–5 keywords. Not full sentences. Not email fragments.
- Strip names, dates, and specific identifiers — search the underlying topic.
- BAD: "Hilverzorg AI update werkt niet meer" → GOOD: "update werkt niet applicatie"
- BAD: "Hoi, kun je me helpen met inloggen" → GOOD: "inloggen probleem account"
- KB docs are often titled by category (e.g. "Facturatie", "Account", "E-mail", "Netwerk", "Hardware", "Applicatie", "Toegang"). Putting a likely category word IN the single query helps — you don't need a separate category-only search.

EMAIL ARCHIVE KBs:
- If the KB is an email archive (docs titled "{Sender} — {Subject}"), you can query by sender name/email, subject keywords, or date fragments — the From/To/Date/Subject metadata header is indexed alongside the body.
- Example queries: "Ewoud fix bevestigd", "invoice mistral maart", "openwebui bug".`,
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Core topic keywords (1-4 words) OR a single category label. Not a full sentence. Examples: "factuur ontbreekt", "Facturatie", "outlook crash", "Account".'
                    },
                    top_k: {
                        type: 'integer',
                        description: 'Number of results (1-10, default 5)'
                    }
                },
                required: ['query']
            }
        }
    },
];

// kb_fetch is only exposed to the LLM when KB_PREVIEW_MODE is on. In that
// mode, kb_search returns only short previews; the agent uses kb_fetch on the
// 1–3 chunks it wants to quote. Saves ~70 % of tokens on the typical turn.
const KB_FETCH_TOOL = {
    type: 'function',
    function: {
        name: 'kb_fetch',
        description: `Fetch the FULL text of up to 3 KB chunks you previewed via kb_search.

WHEN TO USE:
- After a kb_search, pick at most 3 chunks whose title/section/preview look most relevant to the user's question, and call kb_fetch with their chunk_ids.
- DO NOT call kb_fetch on every previewed chunk — only the ones you intend to quote / reason over. Each fetched chunk costs ~750 tokens.
- If the preview already tells you the answer, DO NOT fetch — answer directly.`,
        parameters: {
            type: 'object',
            properties: {
                chunk_ids: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'chunk_id values from a recent kb_search result. Max 3 per call.',
                    maxItems: 3
                }
            },
            required: ['chunk_ids']
        }
    }
};

if (process.env.KB_PREVIEW_MODE === 'true') {
    KB_SEARCH_TOOLS.push(KB_FETCH_TOOL);
}

// ─── Tool Execution ────────────────────────────────────────────

async function executeKbFetchTool(args, context = {}) {
    const kbQueryCache = require('../core/agentRuntime/kbQueryCache');
    const { conversationId } = context;
    let ids = Array.isArray(args?.chunk_ids) ? args.chunk_ids : [];
    ids = ids.slice(0, 3); // Hard server-side cap; description also says max 3.

    if (ids.length === 0) return { error: 'kb_fetch requires chunk_ids' };

    const hits = [];
    const misses = [];
    for (const id of ids) {
        const cached = kbQueryCache.getChunk(conversationId, id);
        if (cached) {
            hits.push({ chunk_id: id, title: cached.title, section: cached.section, content: cached.content });
        } else {
            misses.push(id);
        }
    }

    // Fallback: hit the DB directly for IDs not in the cache (e.g. server restart
    // dropped the cache between kb_search and kb_fetch, or chunk_ids came from
    // a previous conversation).
    if (misses.length > 0) {
        try {
            const { getAll } = require('../db');
            const rows = await getAll(
                'SELECT id::text AS chunk_id, title, content FROM kb_chunks WHERE id::text = ANY($1::text[])',
                [misses]
            );
            for (const r of rows) {
                hits.push({ chunk_id: r.chunk_id, title: r.title || '', section: '', content: r.content || '' });
            }
        } catch (err) {
            console.warn('[KBFetch] DB fallback failed:', err.message);
        }
    }

    if (hits.length === 0) {
        return { error: 'None of the requested chunk_ids were found. They may belong to a previous conversation — run kb_search again.' };
    }

    return { chunks: hits };
}

async function executeKbSearchTool(toolName, args, context = {}) {
    if (toolName === 'kb_fetch') {
        return await executeKbFetchTool(args, context);
    }
    if (toolName !== 'kb_search') {
        return { error: `Unknown KB search tool: ${toolName}` };
    }

    const { query, top_k } = args;
    if (!query) return { error: 'query is required' };

    // ── Greeting / small-talk guard ─────────────────────────────────
    // Skip search for trivial inputs — the LLM sometimes calls this tool
    // with greetings like "servicedesk assistent welkom hi", which wastes
    // embedding + reranker API calls.
    const GREETING_WORDS = /\b(h(i|oi|ey|ello|allo|ee)|dag|goeie(morgen|middag|avond)?|yo|sup|thanks?|thankyou|thank\s*you|dank(je|jewel|u)?|bedankt|doei|bye|tot\s*ziens|how\s*are\s*you|hoe\s*gaat\s*het|welkom|welcome)\b/i;
    // Strip filler words (agent names, "assistent", etc.) and check if what remains is just a greeting
    const queryCore = query.trim()
        .replace(/\b(assistent|assistant|servicedesk|service\s*desk|helpdesk|agent|bot)\b/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    if (GREETING_WORDS.test(queryCore) && queryCore.split(/\s+/).filter(w => w.length >= 2).length <= 3) {
        console.log(`[KBSearch] Skipped — greeting/small-talk: "${query}" (core: "${queryCore}")`);
        return {
            _action: 'kb_sources',
            _sources: [],
            query,
            resultCount: 0,
            results: [],
            instruction: 'No search needed for greetings. Respond naturally.'
        };
    }

    const { userId, agentId } = context;

    // Load agent to get KB IDs
    const agentStore = require('../stores/agentStore');
    let kbIds = [];
    try {
        const agent = await agentStore.getAgent(agentId);
        kbIds = agent?.config?.knowledge_base_ids || [];
    } catch (e) {
        console.warn('[KBSearch] Could not load agent config:', e.message);
    }

    if (kbIds.length === 0) {
        return {
            results: [],
            message: 'No knowledge base configured for this agent. An admin can add knowledge bases in the agent settings.'
        };
    }

    const topK = Math.min(Math.max(parseInt(top_k) || 5, 1), 10);

    // Per-conversation cache: if the agent re-asks the same question later in
    // this conversation, skip the whole retrieval stack. Cache key is
    // (conversationId, normalized query, sorted kb_ids).
    const kbQueryCache = require('../core/agentRuntime/kbQueryCache');
    const { conversationId } = context;
    const cached = kbQueryCache.get(conversationId, `${query}|top_k=${topK}`, kbIds);
    if (cached) {
        console.log(`[KBSearch] Cache HIT: conv=${conversationId} "${query}" → ${cached._sources?.length || 0} chunks`);
        return cached;
    }

    console.log(`[KBSearch] Searching ${kbIds.length} KBs: "${query}" (top_k=${topK}, agent=${agentId})`);

    try {
        const { resolveKbProvider } = require('../core/kb/resolveProvider');
        const kbProvider = await resolveKbProvider();
        let chunks = [];

        if (kbProvider === 'local') {
            // ── Local search path (in-process pgvector + RRF + reranker) ──
            const { searchLocally } = require('../core/localKBIngest');
            const localResults = await searchLocally(userId, kbIds, query, { topK });
            chunks = localResults;
        } else {
            // ── Search-service path ────────────────────────────────
            const searchUrl = process.env.SEARCH_SERVICE_URL || 'https://services.beeflow.ai';
            // Resolve the admin's Web-Search Inference Routing config so the
            // search-service knows which backend to use per task. Falls back
            // to the service's own env defaults when unresolved.
            let inferenceRouting = null;
            try {
                const { resolveInferenceTargetsWithSecrets } = require('../core/webSearchInferenceResolver');
                inferenceRouting = await resolveInferenceTargetsWithSecrets();
            } catch (_) { /* non-fatal */ }
            const searchRes = await fetch(`${searchUrl}/tools/kb-search`, {
                method: 'POST',
                headers: getServiceHeaders(),
                body: JSON.stringify({
                    tenant_id: userId,
                    kb_ids: kbIds,
                    query,
                    top_k: topK,
                    rerank: true,
                    inference_routing: inferenceRouting,
                }),
                signal: AbortSignal.timeout(15000)
            });

            if (!searchRes.ok) {
                console.warn(`[KBSearch] Search-service error: ${searchRes.status}`);
                return { error: `Knowledge base search failed (${searchRes.status})` };
            }

            const searchData = await searchRes.json();
            chunks = searchData.chunks || searchData.results || [];
        }

        // ── Filter Orphaned Chunks ────────────────────────────────────
        // searchLocally() already filters orphans (returns ._orphanFiltered = true).
        // Only run this for the search-service path which doesn't do its own filtering.
        if (chunks.length > 0 && !chunks._orphanFiltered && chunks.some(c => c.document_id)) {
            try {
                const { getAll } = require('../db');
                const dbDocs = await getAll('SELECT id FROM documents WHERE knowledge_base_id = ANY($1::uuid[])', [kbIds]);
                const validDocIds = new Set(dbDocs.map(d => String(d.id).toLowerCase()));
                const before = chunks.length;
                chunks = chunks.filter(c => !c.document_id || validDocIds.has(String(c.document_id).toLowerCase()));
                if (chunks.length < before) {
                    console.log(`[KBSearch] Orphan filter: removed ${before - chunks.length} orphaned chunks`);
                }
            } catch (filterErr) {
                console.warn('[KBSearch] Orphan filter failed, skipping:', filterErr.message);
            }
        }

        // Format results for the agent.
        // Apply a minimum relevance threshold. Reranker scores below ~0.35 are
        // usually noise — they clutter the UI, waste tokens in the LLM payload,
        // and distract the agent. Override via KB_MIN_SCORE env var if needed.
        const parsedMin = parseFloat(process.env.KB_MIN_SCORE);
        const scoreThreshold = Number.isFinite(parsedMin) ? parsedMin : 0.35;

        const preFilterCount = chunks.length;
        const results = chunks
            .filter(c => (c.score || c.rerank_score || 0) >= scoreThreshold)
            .map((c, i) => ({
                result_number: i + 1,
                title: c.title || c.source_uri || 'Knowledge Base',
                source_url: c.source_uri || null,
                content: c.content,
                score: Math.round((c.score || c.rerank_score || 0) * 1000) / 1000
            }));
        if (preFilterCount > results.length) {
            console.log(`[KBSearch] Score filter (>= ${scoreThreshold}): kept ${results.length}/${preFilterCount}`);
        }

        // ── Near-duplicate deduplication (Jaccard on word tokens) ────
        function getTokenSet(text) {
            if (!text) return new Set();
            const body = text.replace(/^#{1,6}\s+.+$/gm, '').trim();
            return new Set(body.toLowerCase().split(/\s+/).filter(t => t.length > 2));
        }
        function jaccard(a, b) {
            if (a.size === 0 && b.size === 0) return 1;
            let inter = 0;
            for (const t of a) { if (b.has(t)) inter++; }
            return inter / (a.size + b.size - inter);
        }
        const dedupResults = [];
        const dedupSets = [];
        for (const r of results) {
            const ts = getTokenSet(r.content);
            if (!dedupSets.some(ex => jaccard(ts, ex) >= 0.85)) {
                dedupResults.push(r);
                dedupSets.push(ts);
            }
        }

        // ── Strip repeated heading breadcrumbs ───────────────────────
        // When multiple chunks come from the same document, parent heading
        // lines are duplicated. Strip them for subsequent chunks.
        const MAX_CHUNK_CHARS = 3000;
        const seenDocHeadings = new Map(); // title → Set of heading lines already sent
        for (const r of dedupResults) {
            const docKey = r.title || 'unknown';
            const seen = seenDocHeadings.get(docKey);
            if (seen && r.content) {
                // Strip heading lines that were already in a previous chunk from this doc
                r.content = r.content.split('\n').filter(line => {
                    if (/^#{1,6}\s+/.test(line) && seen.has(line.trim())) return false;
                    return true;
                }).join('\n').replace(/^\n+/, '');
            }
            // Record headings from this chunk
            const headings = (r.content || '').match(/^#{1,6}\s+.+$/gm) || [];
            if (!seen) {
                seenDocHeadings.set(docKey, new Set(headings.map(h => h.trim())));
            } else {
                headings.forEach(h => seen.add(h.trim()));
            }
            // Cap content length
            if (r.content && r.content.length > MAX_CHUNK_CHARS) {
                r.content = r.content.slice(0, MAX_CHUNK_CHARS) + '…';
            }
        }

        const topScore = chunks.length > 0 ? Math.max(...chunks.map(c => c.score || c.rerank_score || 0)) : 0;
        console.log(`[KBSearch] Found ${dedupResults.length} results (from ${chunks.length} chunks, deduped from ${results.length}, threshold=${scoreThreshold}, topScore=${topScore.toFixed(4)})`);

        // Build per-chunk section label (deepest heading + short snippet) once and reuse.
        const annotated = dedupResults.map((r, i) => {
            const headings = (r.content || '').match(/^#{1,6}\s+(.+)$/gm) || [];
            const deepest = headings.length > 0 ? headings[headings.length - 1].replace(/^#{1,6}\s+/, '').trim() : null;
            const body = (r.content || '').replace(/^#{1,6}\s+.+$/gm, '').replace(/^\|.*$/gm, '').trim();
            const snippet = body.split(/[.!?\n]/).filter(s => s.trim().length > 10)[0]?.trim() || '';
            const sectionLabel = deepest
                ? (snippet ? `${deepest} — ${snippet.slice(0, 60)}` : deepest)
                : (snippet ? snippet.slice(0, 80) : `Chunk ${i + 1}`);
            return { r, sectionLabel };
        });

        const previewMode = process.env.KB_PREVIEW_MODE === 'true';

        // Stash every chunk in the per-conversation cache so kb_fetch can
        // resolve full content by chunk_id on a later tool call.
        kbQueryCache.setChunks(conversationId, annotated.map(({ r, sectionLabel }) => ({
            chunk_id: r.chunk_id,
            title: r.source_url || r.title,
            section: sectionLabel,
            content: r.content,
            source_uri: r.source_uri || r.source_url || '',
        })));

        const payload = {
            // UI-only: full-content cards with score/type the side panel renders.
            _action: 'kb_sources',
            _sources: annotated.map(({ r, sectionLabel }) => ({
                title: r.source_url || r.title,
                section: sectionLabel,
                content: r.content,
                score: r.score,
                type: 'kb_chunk'
            })),
            query,
            // LLM-facing: trimmed.
            //   - default: full content, minus score/type (Phase 1)
            //   - KB_PREVIEW_MODE=true: first ~220 chars only; agent calls kb_fetch
            //     for the chunks it actually wants to use (Phase 2)
            results: annotated.map(({ r, sectionLabel }) => {
                const base = {
                    chunk_id: r.chunk_id,
                    title: r.source_url || r.title,
                    section: sectionLabel,
                };
                if (previewMode) {
                    const preview = (r.content || '').slice(0, 220);
                    return {
                        ...base,
                        preview,
                        length: (r.content || '').length,
                    };
                }
                return { ...base, content: r.content };
            }),
        };
        kbQueryCache.set(conversationId, `${query}|top_k=${topK}|preview=${previewMode}`, kbIds, payload);
        return payload;

    } catch (err) {
        console.error(`[KBSearch] Error:`, err.message);
        return { error: `Knowledge base search unavailable: ${err.message}` };
    }
}

function isKbSearchTool(toolName) {
    return toolName === 'kb_search' || toolName === 'kb_fetch';
}

module.exports = {
    KB_SEARCH_TOOLS,
    executeKbSearchTool,
    isKbSearchTool,
};
