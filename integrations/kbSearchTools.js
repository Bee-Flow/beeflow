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
            description: `Search the internal knowledge base for relevant context, procedures, policies, or examples of previous similar interactions. The KB is organised by CATEGORY (e.g. "Facturatie", "Autorisatie", "Account", "E-mail", "Netwerk", "Hardware", "Applicatie", "Werkplek", "Toegang") — search both the specific topic AND the likely category.

WHEN TO USE:
- ALWAYS before drafting a reply to an email or message about a real topic — even if it seems obvious, there may be a standard procedure or previous response pattern.
- When the user asks about specific topics, policies, procedures, or factual details.
- When you need internal context, examples, or precedent for a reply.

WHEN TO SKIP:
- Pure greetings/small-talk ("hi", "thanks", "how are you") — answer directly.
- Trivial confirmations ("ok", "got it") that need no factual lookup.

SEARCH STRATEGY (multi-query approach — DO multiple searches):
1. **First search**: 2-4 keyword core topic of the user's question (e.g. "factuur niet ontvangen", "outlook werkt niet").
2. **Second search**: the likely CATEGORY label in 1 word (e.g. "Facturatie", "E-mail", "Toegang"). KB documents are titled by category.
3. **Third search (if first two return 0 results)**: broader synonyms or related terms (e.g. if "outlook" failed, try "mail client" or "Microsoft 365").

Do at least 2 searches before concluding nothing relevant exists. The search engine does fuzzy matching but does NOT cross domains — searching "factuur" won't find a doc titled "Facturatie" reliably.

QUERY FORMAT:
- 1-4 keywords. NOT full sentences. NOT email fragments.
- Strip names, dates, and specific identifiers — search the underlying topic.
- BAD: "Hilverzorg AI update werkt niet meer" → GOOD: "update werkt niet" + "Applicatie"
- BAD: "Hoi, kun je me helpen met inloggen" → GOOD: "inloggen probleem" + "Account"

EMAIL ARCHIVE KBs:
- If the KB is an email archive (docs titled "{Sender} — {Subject}"), you can also search by sender name/email, subject keywords, or date fragments — the From/To/Date/Subject metadata header is indexed alongside the body.
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
    }
];

// ─── Tool Execution ────────────────────────────────────────────

async function executeKbSearchTool(toolName, args, context = {}) {
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

    console.log(`[KBSearch] Searching ${kbIds.length} KBs: "${query}" (top_k=${topK}, agent=${agentId})`);

    try {
        const useAzure = !!(await configStore.getConfig('use_azure_doc_processing'));
        let chunks = [];

        if (useAzure) {
            // ── Local search path (Azure) ─────────────────────────
            const { searchLocally } = require('../core/localKBIngest');
            const localResults = await searchLocally(userId, kbIds, query, { topK });
            chunks = localResults;
        } else {
            // ── Search-service path ────────────────────────────────
            const searchUrl = process.env.SEARCH_SERVICE_URL || 'https://services.beeflow.ai';
            const searchRes = await fetch(`${searchUrl}/tools/kb-search`, {
                method: 'POST',
                headers: getServiceHeaders(),
                body: JSON.stringify({
                    tenant_id: userId,
                    kb_ids: kbIds,
                    query,
                    top_k: topK,
                    rerank: true
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
        // When a reranker is active (Azure Cohere or local GPU) it already picked the best
        // topK results — applying a score threshold on top would drop ranked results 2-5.
        // We only filter out zero-score results (completely irrelevant) when using raw RRF
        // with no reranker, to avoid returning noise.
        const azureRerankerConfigured = !!(await configStore.getConfig('azure_reranker_endpoint') || process.env.AZURE_RERANKER_ENDPOINT);
        const hasReranker = azureRerankerConfigured || (!useAzure && process.env.RERANKER_URL);
        // No threshold when reranker is active — trust the reranker's ranking + topK.
        // Minimal floor (0.01) when RRF-only to avoid completely irrelevant results.
        const scoreThreshold = hasReranker ? 0 : 0.01;

        const results = chunks
            .filter(c => (c.score || c.rerank_score || 0) >= scoreThreshold)
            .map((c, i) => ({
                result_number: i + 1,
                title: c.title || c.source_uri || 'Knowledge Base',
                source_url: c.source_uri || null,
                content: c.content,
                score: Math.round((c.score || c.rerank_score || 0) * 1000) / 1000
            }));

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
        console.log(`[KBSearch] Found ${dedupResults.length} results (from ${chunks.length} chunks, deduped from ${results.length}, reranker=${hasReranker}, topScore=${topScore.toFixed(4)})`);
        return {
            _action: 'kb_sources',
            _sources: dedupResults.map((r, i) => {
                // Extract deepest heading + content preview for distinctive label
                const headings = (r.content || '').match(/^#{1,6}\s+(.+)$/gm) || [];
                const deepest = headings.length > 0 ? headings[headings.length - 1].replace(/^#{1,6}\s+/, '').trim() : null;
                const body = (r.content || '').replace(/^#{1,6}\s+.+$/gm, '').replace(/^\|.*$/gm, '').trim();
                const snippet = body.split(/[.!?\n]/).filter(s => s.trim().length > 10)[0]?.trim() || '';
                const sectionLabel = deepest
                    ? (snippet ? `${deepest} — ${snippet.slice(0, 60)}` : deepest)
                    : (snippet ? snippet.slice(0, 80) : `Chunk ${i + 1}`);
                return {
                    title: r.source_url || r.title,
                    section: sectionLabel,
                    content: r.content,
                    score: r.score,
                    type: 'kb_chunk'
                };
            }),
            query,
            resultCount: dedupResults.length,
            results: dedupResults,
            instruction: dedupResults.length > 0
                ? 'Use this knowledge base information to provide accurate and detailed answers. Cite sources when possible.'
                : 'No relevant results found. You may try a different search query or answer based on general knowledge.'
        };

    } catch (err) {
        console.error(`[KBSearch] Error:`, err.message);
        return { error: `Knowledge base search unavailable: ${err.message}` };
    }
}

function isKbSearchTool(toolName) {
    return toolName === 'kb_search';
}

module.exports = {
    KB_SEARCH_TOOLS,
    executeKbSearchTool,
    isKbSearchTool,
};
