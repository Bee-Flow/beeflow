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
            description: `Search the agent's knowledge base for relevant information. Use this PROACTIVELY whenever you need to look up internal knowledge — especially after reading emails, documents, or when the user asks about topics that might be in the knowledge base.

WHEN TO USE:
- After reading an email: search for the email's topic/subject to find relevant information for composing a reply
- When the user asks about products, services, policies, or any topic that could be in internal documentation
- When you need specific details (pricing, procedures, contact info) that the knowledge base might contain
- Before composing any customer-facing response that should reference internal information

QUERY TIPS:
- Use short, focused queries (2-6 words) for best results
- Search for the TOPIC, not the instruction (e.g., "hybride events techniek" instead of "read email and reply")
- You can call this tool multiple times with different queries to gather more context`,
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query — use the topic or subject you want to look up, not the user instruction. Keep it short and focused.'
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

        // Format results for the agent
        const results = chunks
            .filter(c => (c.score || c.rerank_score || 0) >= 0.3)
            .map((c, i) => ({
                result_number: i + 1,
                title: c.title || c.source_uri || 'Knowledge Base',
                source_url: c.source_uri || null,
                content: c.content,
                score: Math.round((c.score || c.rerank_score || 0) * 1000) / 1000
            }));

        console.log(`[KBSearch] Found ${results.length} results (from ${chunks.length} chunks)`);

        return {
            _action: 'kb_sources',
            _sources: results.map(r => ({
                title: r.source_url || r.title,
                content: r.content,
                score: r.score,
                type: 'kb_chunk'
            })),
            query,
            resultCount: results.length,
            results,
            instruction: results.length > 0
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
