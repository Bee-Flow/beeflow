/**
 * Webpage Knowledge Search — same shape as notebookKnowledgeSearch.js, scoped
 * to the webpages feature. Reuses the search-service / local-Azure paths and
 * the same query-preprocessing heuristics.
 */

const configStore = require('../stores/configStore');
const { getServiceHeaders } = require('./serviceAuth');

const SEARCH_SERVICE_URL = process.env.SEARCH_SERVICE_URL || 'https://services.beeflow.nl';

function preprocessQuery(query) {
    let cleaned = query
        .replace(/^(hey|hi|hello|hoi|hallo|beste)\s*[,!.]?\s*/i, '')
        .replace(/^(can you|could you|would you|please|kun je|kunt u|wil je|zou je)\s*/i, '')
        .replace(/^(tell me about|explain|describe|what is|what are|how do|how does|wat is|wat zijn|hoe werkt|hoe kan)\s*/i, '')
        .replace(/^(i want to know about|i need info on|ik wil weten over|ik zoek informatie over)\s*/i, '')
        .replace(/\?+$/g, '')
        .trim();
    if (cleaned.length < 5) cleaned = query;
    return cleaned;
}

async function getAzureSearchParams() {
    const { resolveKbProvider } = require('./kb/resolveProvider');
    const kbProvider = await resolveKbProvider();
    if (kbProvider !== 'local') return {};
    return {
        use_azure: true,
        azure_endpoint: await configStore.getConfig('azure_openai_embedding_endpoint') || '',
        azure_key: await configStore.getSecret('azure_openai_embedding_key') || '',
        azure_model: await configStore.getConfig('azure_openai_embedding_model') || 'text-embedding-3-small',
    };
}

async function searchWebpageKB({ userId, kbIds, query, options = {} }) {
    const {
        topK = 10,
        rerank = true,
        minScore = 0.2,
        maxChunkChars = 1500,
        preprocessQuery: doPreprocess = true,
        timeoutMs = 12000,
    } = options;

    if (!kbIds || kbIds.length === 0) {
        return { chunks: [], contextPrompt: '', citations: [] };
    }

    const searchQuery = doPreprocess ? preprocessQuery(query) : query;
    const azureParams = await getAzureSearchParams();

    let chunks = [];
    try {
        if (azureParams.use_azure) {
            const { searchLocally } = require('./localKBIngest');
            const localResults = await searchLocally(userId, kbIds, searchQuery, { topK });
            chunks = localResults.map(c => ({ ...c, rerank_score: c.score }));
        } else {
            const searchRes = await fetch(`${SEARCH_SERVICE_URL}/tools/kb-search`, {
                method: 'POST',
                headers: getServiceHeaders(),
                body: JSON.stringify({
                    tenant_id: userId,
                    kb_ids: kbIds,
                    query: searchQuery,
                    top_k: topK,
                    rerank,
                }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (searchRes.ok) {
                const data = await searchRes.json();
                chunks = (data.chunks || data.results || [])
                    .filter(c => (c.score || c.rerank_score || 0) >= minScore);
            } else {
                console.warn(`[WebpageKBSearch] Search-service error: ${searchRes.status}`);
            }
        }
    } catch (err) {
        console.warn('[WebpageKBSearch] Search failed:', err.message);
        return { chunks: [], contextPrompt: '', citations: [] };
    }

    if (chunks.length === 0) {
        return { chunks: [], contextPrompt: '', citations: [] };
    }

    const truncatedChunks = chunks.slice(0, topK).map(c => ({
        ...c,
        content: c.content && c.content.length > maxChunkChars
            ? c.content.slice(0, maxChunkChars) + '…'
            : c.content || '',
    }));

    const citations = truncatedChunks.map((c, i) => ({
        index: i + 1,
        title: c.source_uri || c.title || `Source ${i + 1}`,
        rawTitle: c.source_uri || c.title || `Source ${i + 1}`,
        content: (c.content || '').slice(0, 500),
        score: c.rerank_score || c.score || 0,
    }));

    const kbText = truncatedChunks.map((c, i) => {
        const src = c.source_uri || c.title || `Source ${i + 1}`;
        return `[Source ${i + 1}: ${src}]\n${c.content}`;
    }).join('\n\n');

    const contextPrompt = `\n\n[WEBPAGE KNOWLEDGE BASE — USE THESE SOURCES]\nThe following passages were retrieved from the webpage's sources. Ground your design decisions, copy, and structure in this content.\n\n${kbText}`;

    console.log(`[WebpageKBSearch] Found ${truncatedChunks.length} chunks (query: "${searchQuery.slice(0, 60)}", rerank: ${rerank})`);
    return { chunks: truncatedChunks, contextPrompt, citations };
}

async function executeWebpageKBSearchTool(args, userId, kbIds) {
    const { query, top_k } = args;
    if (!query) return { error: 'query is required' };

    if (!kbIds || kbIds.length === 0) {
        return { results: [], message: 'No sources have been added to this webpage yet.' };
    }

    const topK = Math.min(Math.max(parseInt(top_k) || 5, 1), 10);
    const result = await searchWebpageKB({
        userId, kbIds, query,
        options: { topK, rerank: true, minScore: 0.25, maxChunkChars: 1200, preprocessQuery: false },
    });

    const formatted = result.chunks.map((c, i) => ({
        result_number: i + 1,
        title: c.source_uri || c.title || 'Webpage Source',
        content: c.content,
        score: Math.round((c.rerank_score || c.score || 0) * 1000) / 1000,
    }));

    return {
        query,
        resultCount: formatted.length,
        results: formatted,
        instruction: formatted.length > 0
            ? 'Use this information from the webpage sources to inform the design and copy. Cite sources when possible.'
            : 'No relevant results found in webpage sources. You may try a different search query.',
    };
}

const WEBPAGE_KB_SEARCH_TOOL = {
    type: 'function',
    function: {
        name: 'webpage_kb_search',
        description: `Search the webpage's sources for specific information. Use this PROACTIVELY whenever you need details from the attached sources — brand guidelines, copy drafts, technical references, etc.

WHEN TO USE:
- The user asks about a topic that should be in the webpage's sources
- You need specific details (colors, fonts, taglines, product info) from the sources
- The initial search didn't return relevant results

QUERY TIPS:
- Use short, focused queries (2-6 words) for best results
- Search for the TOPIC, not the instruction`,
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Search query — use the topic or subject. Keep it short and focused.',
                },
                top_k: {
                    type: 'integer',
                    description: 'Number of results to return (1-10, default 5)',
                },
            },
            required: ['query'],
        },
    },
};

module.exports = {
    searchWebpageKB,
    executeWebpageKBSearchTool,
    WEBPAGE_KB_SEARCH_TOOL,
    preprocessQuery,
};
