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
            description: `Search the internal knowledge base for specific information. Only use this when the user asks a concrete question or you need factual details to compose a response.

DO NOT USE for:
- Greetings or small-talk ("hi", "hello", "thanks", "how are you")
- Vague or conversational messages with no clear information need
- When you already have enough context to answer

WHEN TO USE:
- The user asks a specific question about products, services, policies, or procedures
- After reading an email/document and you need internal context to compose a reply
- You need factual details (pricing, procedures, contact info, opening hours, etc.)

QUERY TIPS:
- Use short, focused queries (2-5 words) — extract only the core topic
- Search for the TOPIC, not the instruction (e.g., "openingstijden" instead of "wat zijn de openingstijden van het kantoor")
- You can call this multiple times with different queries if needed`,
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'The specific topic to look up. Use 2-5 keywords, not full sentences.'
                    },
                    top_k: {
                        type: 'integer',
                        description: 'Number of results to return (1-10, default 5)'
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
            .filter(c => (c.score || c.rerank_score || 0) >= 0.72) // Minimum 72% relevance floor
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
