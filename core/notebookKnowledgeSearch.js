/**
 * Notebook Knowledge Search — shared utility for all notebook KB retrieval.
 *
 * Provides two main functions:
 *   • searchNotebookKB()       — single semantic search for chat context
 *   • gatherNotebookContent()  — comprehensive content retrieval for generation
 *
 * Features (matching agent runtime quality):
 *   • Reranking enabled by default
 *   • Score filtering (configurable threshold)
 *   • Azure embedding support
 *   • Query preprocessing (strips filler words)
 *   • Source-aware deduplication
 *   • Content budget management
 */

const configStore = require('../stores/configStore');
const { getServiceHeaders } = require('./serviceAuth');

const SEARCH_SERVICE_URL = process.env.SEARCH_SERVICE_URL || 'https://services.beeflow.ai';

// ── Query Preprocessing ────────────────────────────────────────────

/**
 * Clean a user query for better semantic search results.
 * Strips greetings, filler words, and question marks.
 */
function preprocessQuery(query) {
    let cleaned = query
        .replace(/^(hey|hi|hello|hoi|hallo|beste)\s*[,!.]?\s*/i, '')
        .replace(/^(can you|could you|would you|please|kun je|kunt u|wil je|zou je)\s*/i, '')
        .replace(/^(tell me about|explain|describe|what is|what are|how do|how does|wat is|wat zijn|hoe werkt|hoe kan)\s*/i, '')
        .replace(/^(i want to know about|i need info on|ik wil weten over|ik zoek informatie over)\s*/i, '')
        .replace(/\?+$/g, '')
        .replace(/^(voor ons event|voor mij|voor ons|for us|for me|for our)\s*/i, '')
        .trim();
    if (cleaned.length < 5) cleaned = query;
    return cleaned;
}

// ── Azure Embedding Resolution ─────────────────────────────────────

async function getAzureSearchParams() {
    // The legacy `use_azure_doc_processing` flag is treated as a synonym
    // for "use the local KB path" (which embeds via Azure OR any other
    // configured provider). The new `kb_provider` toggle takes precedence.
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

// ── Core Search Function ───────────────────────────────────────────

/**
 * Perform a single KB search with reranking, score filtering, and Azure support.
 *
 * @param {object}   params
 * @param {string}   params.userId     — tenant ID
 * @param {string[]} params.kbIds      — knowledge base IDs
 * @param {string}   params.query      — search query
 * @param {object}   [params.options]
 * @param {number}   [params.options.topK=10]          — max chunks to retrieve
 * @param {boolean}  [params.options.rerank=true]       — enable reranking
 * @param {number}   [params.options.minScore=0.2]      — minimum score threshold
 * @param {number}   [params.options.maxChunkChars=1500] — truncate chunks
 * @param {boolean}  [params.options.preprocessQuery=true] — clean query
 * @param {number}   [params.options.timeoutMs=12000]   — request timeout
 * @returns {Promise<{chunks: Array, contextPrompt: string, citations: Array}>}
 */
async function searchNotebookKB({ userId, kbIds, query, options = {} }) {
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
            // ── Local search path (Azure) ─────────────────────────
            const { searchLocally } = require('./localKBIngest');
            const localResults = await searchLocally(userId, kbIds, searchQuery, { topK });
            // When local search includes reranker, trust its ranking — don't apply score threshold
            chunks = localResults.map(c => ({ ...c, rerank_score: c.score }));
        } else {
            // ── Search-service path ────────────────────────────────
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
                console.warn(`[NotebookKBSearch] Search-service error: ${searchRes.status}`);
            }
        }
    } catch (err) {
        console.warn('[NotebookKBSearch] Search failed:', err.message);
        return { chunks: [], contextPrompt: '', citations: [] };
    }

    if (chunks.length === 0) {
        return { chunks: [], contextPrompt: '', citations: [] };
    }

    // Truncate chunk content
    const truncatedChunks = chunks.slice(0, topK).map(c => ({
        ...c,
        content: c.content && c.content.length > maxChunkChars
            ? c.content.slice(0, maxChunkChars) + '…'
            : c.content || '',
    }));

    // Build citations for frontend
    const citations = truncatedChunks.map((c, i) => ({
        index: i + 1,
        title: c.source_uri || c.title || `Source ${i + 1}`,
        rawTitle: c.source_uri || c.title || `Source ${i + 1}`,
        content: (c.content || '').slice(0, 500),
        score: c.rerank_score || c.score || 0,
    }));

    // Build context prompt for system message
    const kbText = truncatedChunks.map((c, i) => {
        const src = c.source_uri || c.title || `Source ${i + 1}`;
        return `[Source ${i + 1}: ${src}]\n${c.content}`;
    }).join('\n\n');

    const contextPrompt = `\n\n[NOTEBOOK KNOWLEDGE BASE — USE THESE SOURCES]\nThe following passages were retrieved from the notebook's sources. Ground your response in this content and cite sources using [Source N] notation.\n\n${kbText}`;

    console.log(`[NotebookKBSearch] Found ${truncatedChunks.length} chunks (query: "${searchQuery.slice(0, 60)}", rerank: ${rerank}, azure: ${!!azureParams.use_azure})`);

    return { chunks: truncatedChunks, contextPrompt, citations };
}

// ── Content Gathering for Generation ───────────────────────────────

/**
 * Gather comprehensive content from notebook sources for generation.
 *
 * Unlike searchNotebookKB (optimized for single-query chat), this retrieves
 * broad content across all sources using 1-2 smart queries with deduplication.
 *
 * @param {object}   params
 * @param {string}   params.userId      — tenant ID
 * @param {string[]} params.kbIds       — knowledge base IDs
 * @param {Array}    params.sources     — ready source records (with name, id)
 * @param {string}   [params.documentContent] — notebook editor content
 * @param {object}   [params.options]
 * @param {number}   [params.options.maxChars=50000]  — total content budget
 * @param {number}   [params.options.topK=25]         — max chunks per query
 * @param {number}   [params.options.minScore=0.15]   — lower threshold for generation
 * @returns {Promise<{content: string, sourceCount: number}>}
 */
async function gatherNotebookContent({ userId, kbIds, sources, documentContent, options = {} }) {
    const {
        maxChars = 50000,
        topK = 25,
        minScore = 0.15,
    } = options;

    let allContent = '';

    // 1. Include notebook document editor content (what the user sees)
    if (documentContent && documentContent.trim()) {
        const docText = documentContent
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim();
        if (docText.length > 20) {
            allContent += `\n\n[Notebook Document]\n${docText}`;
        }
    }

    // 2. Retrieve content from KB with smart querying
    if (kbIds.length === 0 || sources.length === 0) {
        return { content: allContent, sourceCount: 0 };
    }

    const azureParams = await getAzureSearchParams();
    const seenChunks = new Set();
    let chunkCount = 0;

    // Build a single comprehensive query from source names
    // This replaces the naive N+1 loop with 1-2 targeted searches
    const sourceNames = sources.map(s => s.name).filter(Boolean);
    const comprehensiveQuery = sourceNames.length > 0
        ? `${sourceNames.join(', ')} — main content overview summary key points`
        : 'main content summary overview';

    // Helper: process search results into allContent
    function processChunks(chunks) {
        for (const chunk of chunks) {
            if (allContent.length >= maxChars) break;
            const key = (chunk.content || '').slice(0, 100);
            if (seenChunks.has(key)) continue;
            seenChunks.add(key);

            const sourceName = sources.find(s =>
                s.id === chunk.source_uri || s.name === chunk.source_uri ||
                chunk.title?.includes(s.name) || s.name?.includes(chunk.title)
            )?.name || chunk.source_uri || 'Source';

            allContent += `\n\n[${sourceName}]\n${chunk.content || ''}`;
            chunkCount++;
        }
    }

    try {
        if (azureParams.use_azure) {
            // ── Local search path (Azure) ─────────────────────────
            const { searchLocally } = require('./localKBIngest');
            const localResults = await searchLocally(userId, kbIds, comprehensiveQuery, { topK });
            processChunks(localResults.filter(c => (c.score || 0) >= minScore));
        } else {
            // ── Search-service path ────────────────────────────────
            const searchRes = await fetch(`${SEARCH_SERVICE_URL}/tools/kb-search`, {
                method: 'POST',
                headers: getServiceHeaders(),
                body: JSON.stringify({
                    tenant_id: userId,
                    kb_ids: kbIds,
                    query: comprehensiveQuery,
                    top_k: topK,
                    rerank: true,
                }),
                signal: AbortSignal.timeout(15000),
            });

            if (searchRes.ok) {
                const data = await searchRes.json();
                processChunks((data.chunks || data.results || [])
                    .filter(c => (c.score || c.rerank_score || 0) >= minScore));
            }
        }
    } catch (e) {
        console.warn('[NotebookKBSearch] Comprehensive search failed:', e.message);
    }

    // 3. If we got very few results, do a second broader query
    if (chunkCount < 5 && allContent.length < maxChars / 2) {
        try {
            const fallbackQuery = 'key information details analysis findings data';
            if (azureParams.use_azure) {
                const { searchLocally } = require('./localKBIngest');
                const localResults = await searchLocally(userId, kbIds, fallbackQuery, { topK });
                processChunks(localResults.filter(c => (c.score || 0) >= minScore));
            } else {
                const fallbackRes = await fetch(`${SEARCH_SERVICE_URL}/tools/kb-search`, {
                    method: 'POST',
                    headers: getServiceHeaders(),
                    body: JSON.stringify({
                        tenant_id: userId,
                        kb_ids: kbIds,
                        query: fallbackQuery,
                        top_k: topK,
                        rerank: true,
                    }),
                    signal: AbortSignal.timeout(15000),
                });

                if (fallbackRes.ok) {
                    const data = await fallbackRes.json();
                    processChunks((data.chunks || data.results || [])
                        .filter(c => (c.score || c.rerank_score || 0) >= minScore));
                }
            }
        } catch (e) {
            console.warn('[NotebookKBSearch] Fallback search failed:', e.message);
        }
    }

    console.log(`[NotebookKBSearch] Gathered ${chunkCount} chunks, ${allContent.length} chars for generation (${sources.length} sources, azure: ${!!azureParams.use_azure})`);

    return { content: allContent, sourceCount: chunkCount };
}

// ── Notebook KB Search Tool (for chat tool-calling) ────────────────

/**
 * Execute a notebook_kb_search tool call from AI chat.
 *
 * @param {object} args        — { query, top_k }
 * @param {string} userId
 * @param {string[]} kbIds
 * @returns {Promise<object>}  — tool result for the AI
 */
async function executeNotebookKBSearchTool(args, userId, kbIds) {
    const { query, top_k } = args;
    if (!query) return { error: 'query is required' };

    if (!kbIds || kbIds.length === 0) {
        return {
            results: [],
            message: 'No sources have been added to this notebook yet.',
        };
    }

    const topK = Math.min(Math.max(parseInt(top_k) || 5, 1), 10);
    console.log(`[NotebookKBSearch] Tool search: "${query}" (top_k=${topK})`);

    const result = await searchNotebookKB({
        userId, kbIds, query,
        options: { topK, rerank: true, minScore: 0.25, maxChunkChars: 1200, preprocessQuery: false },
    });

    const formatted = result.chunks.map((c, i) => ({
        result_number: i + 1,
        title: c.source_uri || c.title || 'Notebook Source',
        content: c.content,
        score: Math.round((c.rerank_score || c.score || 0) * 1000) / 1000,
    }));

    return {
        query,
        resultCount: formatted.length,
        results: formatted,
        instruction: formatted.length > 0
            ? 'Use this information from the notebook sources to answer accurately. Cite sources when possible.'
            : 'No relevant results found in notebook sources. You may try a different search query.',
    };
}

// ── Tool Definition ────────────────────────────────────────────────

const NOTEBOOK_KB_SEARCH_TOOL = {
    type: 'function',
    function: {
        name: 'notebook_kb_search',
        description: `Search the notebook's sources for specific information. Use this PROACTIVELY whenever you need to look up details from the notebook's added sources — especially when the initial context doesn't contain enough information.

WHEN TO USE:
- When the user asks about a topic that should be in the notebook sources
- When you need specific details (numbers, dates, names, quotes) from the sources
- When the initial search didn't return relevant results for the current question
- After reading an attachment, to cross-reference with notebook sources

QUERY TIPS:
- Use short, focused queries (2-6 words) for best results
- Search for the TOPIC, not the instruction`,
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Search query — use the topic or subject to look up. Keep it short and focused.',
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
    searchNotebookKB,
    gatherNotebookContent,
    executeNotebookKBSearchTool,
    NOTEBOOK_KB_SEARCH_TOOL,
    preprocessQuery,
};
