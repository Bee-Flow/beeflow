const configStore = require('../../stores/configStore');
const { getServiceHeaders } = require('../serviceAuth');

async function performKnowledgeSearch({ agent, userId, userMessage, isStrictKnowledge, onEvent }) {
    let systemPromptExtension = '';
    const kbIds = agent.config?.knowledge_base_ids || [];
    let allKnowledgeResults = [];

    if (kbIds.length > 0) {
        try {
            // Determine whether to use Azure embeddings for query (must match ingestion model)
            const useAzure = !!(await configStore.getConfig('use_azure_doc_processing'));

            // Query preprocessing: extract search intent
            let searchQuery = userMessage;
            searchQuery = searchQuery
                .replace(/^(hey|hi|hello|hoi|hallo|beste)\s*[,!.]?\s*/i, '')
                .replace(/^(can you|could you|would you|please|kun je|kunt u|wil je|zou je)\s*/i, '')
                .replace(/^(tell me about|explain|describe|what is|what are|how do|how does|wat is|wat zijn|hoe werkt|hoe kan)\s*/i, '')
                .replace(/^(i want to know about|i need info on|ik wil weten over|ik zoek informatie over)\s*/i, '')
                .replace(/^(wat kan je|wat kun je|wat kunt u|what can you)\s+(vinden|vertellen|zeggen|weten|me vertellen)\s+(over|about|van|op)?\s*/i, '')
                .replace(/^(wat|welke|hoeveel)\s+(kan|kun|kunt|zijn|is|staat|staan)\s+(er|je|jij|u|ik|we|wij)\s+/i, '')
                .replace(/\?+$/g, '')
                .replace(/^(voor ons event|voor mij|voor ons|for us|for me|for our)\s*/i, '')
                .trim();
            if (searchQuery.length < 5) searchQuery = userMessage;

            if (useAzure) {
                // ── Local search path (Azure) ──────────────────────────
                // Search locally-ingested chunks directly from PostgreSQL
                const { searchLocally } = require('../localKBIngest');
                const chunks = await searchLocally(userId, kbIds, searchQuery, { topK: 15 });
                allKnowledgeResults.push(...chunks.map(c => ({
                    content: c.content,
                    metadata: { source: c.source_uri || c.title || 'KB', type: 'kb_chunk' },
                    score: c.score || 0
                })));
            } else {
                // ── Search-service path ─────────────────────────────────
                const searchUrl = process.env.SEARCH_SERVICE_URL || 'https://services.beeflow.ai';

                const searchRes = await fetch(`${searchUrl}/tools/kb-search`, {
                    method: 'POST',
                    headers: getServiceHeaders(),
                    body: JSON.stringify({
                        tenant_id: userId,
                        kb_ids: kbIds,
                        query: searchQuery,
                        top_k: 15,
                        rerank: true,
                        use_azure: false,
                    }),
                    signal: AbortSignal.timeout(15000)
                });

                if (searchRes.ok) {
                    const searchData = await searchRes.json();
                    const chunks = searchData.chunks || searchData.results || [];
                    allKnowledgeResults.push(...chunks.map(c => ({
                        content: c.content,
                        metadata: { source: c.source_uri || c.title || 'KB', type: 'kb_chunk' },
                        score: c.score || c.rerank_score || 0
                    })));
                }
            }
        } catch (searchErr) {
            console.warn('[KnowledgeSearch] KB search failed:', searchErr.message);
        }
    }

    if (allKnowledgeResults.length > 0) {
        // Score threshold: use config-based detection (same logic as kbSearchTools.js)
        // When Azure reranker is configured, no threshold — trust the reranker.
        // When RRF-only, apply a minimal floor.
        const azureRerankerEndpoint = await configStore.getConfig('azure_reranker_endpoint') || process.env.AZURE_RERANKER_ENDPOINT;
        const hasReranker = !!(azureRerankerEndpoint || process.env.RERANKER_URL);
        const MIN_SCORE = hasReranker ? 0 : 0.01;
        allKnowledgeResults = allKnowledgeResults.filter(r => (r.score || 0) >= MIN_SCORE);

        // Keep individual chunks as separate results (do NOT merge by source —
        // merging then truncating was hiding most of the content from the model).
        // Sort by score, take top results for the system prompt.
        allKnowledgeResults.sort((a, b) => (b.score || 0) - (a.score || 0));

        // ── Near-duplicate deduplication ─────────────────────────────
        // Chunks with overlapping content (from sliding-window overlap or
        // similar table structures) can flood the top-K. Remove chunks
        // whose content is >85% similar (Jaccard on word tokens) to a
        // higher-scoring chunk already in the list.
        function getContentTokens(text) {
            if (!text) return new Set();
            // Strip heading breadcrumb lines for comparison
            const body = text.replace(/^#{1,6}\s+.+$/gm, '').trim();
            return new Set(body.toLowerCase().split(/\s+/).filter(t => t.length > 2));
        }
        function jaccardSimilarity(setA, setB) {
            if (setA.size === 0 && setB.size === 0) return 1;
            let intersection = 0;
            for (const t of setA) { if (setB.has(t)) intersection++; }
            return intersection / (setA.size + setB.size - intersection);
        }

        const deduped = [];
        const dedupedTokenSets = [];
        const SIMILARITY_THRESHOLD = 0.85;
        const TOP_K_DEFAULT = 3;       // Show at least top 3
        const TOP_K_MAX = 10;          // Never exceed 10
        const HIGH_SCORE_THRESHOLD = 0.80; // Include all chunks scoring ≥ 80%
        for (const result of allKnowledgeResults) {
            const tokens = getContentTokens(result.content);
            let isDuplicate = false;
            for (const existing of dedupedTokenSets) {
                if (jaccardSimilarity(tokens, existing) >= SIMILARITY_THRESHOLD) {
                    isDuplicate = true;
                    break;
                }
            }
            if (!isDuplicate) {
                const score = result.score || 0;
                // Stop collecting once we've hit the default AND this chunk is below threshold
                if (deduped.length >= TOP_K_DEFAULT && score < HIGH_SCORE_THRESHOLD) break;
                deduped.push(result);
                dedupedTokenSets.push(tokens);
            }
            if (deduped.length >= TOP_K_MAX) break;
        }
        const topResults = deduped;

        // Per-chunk content cap: keep context manageable for the model.
        const MAX_CHUNK_CHARS = 4000;
        for (const result of topResults) {
            if (result.content && result.content.length > MAX_CHUNK_CHARS) {
                result.content = result.content.slice(0, MAX_CHUNK_CHARS) + '…';
            }
        }


        if (topResults.length > 0) {
            const includeRefs = agent.config?.includeSourceReferences === true;
            const knowledgeText = topResults.map((k, i) => {
                const meta = k.metadata || {};
                let source = meta.source || meta.source_uri || 'Unknown Source';
                if (meta.type === 'url_import' && meta.source) source = meta.source;
                return `### Source ${i + 1}: ${source}\n${k.content}\n`;
            }).join('\n');

            const citationInstruction = includeRefs
                ? 'When relevant, include the source URL at the end of your response so the user can verify the information.'
                : 'Do NOT include citations (e.g. [Source 1]) or source URLs in your final response.';

            if (isStrictKnowledge) {
                systemPromptExtension += `\n\n## KNOWLEDGE BASE RESULTS
The following information was retrieved from your knowledge base. Answer ONLY from this data.
If the user's question cannot be answered from the information below, you MUST say you don't have that information.
${citationInstruction}

${knowledgeText}
`;
            } else {
                systemPromptExtension += `\n\n## RELEVANT KNOWLEDGE BASE
The following information from your knowledge base was retrieved based on the user's request. 
Use this information to answer the question.
${citationInstruction}

${knowledgeText}
`;
            }

            if (includeRefs && onEvent) {
                onEvent('kb_sources', {
                    sources: topResults.map((k, i) => {
                        const docTitle = k.metadata?.source || k.metadata?.source_uri || 'Unknown Source';
                        // Extract the deepest (most specific) heading for display
                        const headings = (k.content || '').match(/^#{1,6}\s+(.+)$/gm) || [];
                        const deepestHeading = headings.length > 0
                            ? headings[headings.length - 1].replace(/^#{1,6}\s+/, '').trim()
                            : null;
                        // Build section label: heading + content preview for disambiguation
                        const bodyText = (k.content || '').replace(/^#{1,6}\s+.+$/gm, '').replace(/^\|.*$/gm, '').trim();
                        const previewSnippet = bodyText.split(/[.!?\n]/).filter(s => s.trim().length > 10)[0]?.trim() || '';
                        const sectionLabel = deepestHeading
                            ? (previewSnippet ? `${deepestHeading} — ${previewSnippet.slice(0, 60)}` : deepestHeading)
                            : (previewSnippet ? previewSnippet.slice(0, 80) : `Chunk ${i + 1}`);
                        return {
                            title: docTitle,
                            section: sectionLabel,
                            content: k.content,
                            score: k.score || 0,
                            type: k.metadata?.type || 'unknown'
                        };
                    })
                });
            }
        } else {
            if (isStrictKnowledge) {
                systemPromptExtension += `\n\n## KNOWLEDGE BASE RESULTS
No relevant information was found in your knowledge base for this query.
You MUST tell the user you don't have information about this topic. Do NOT answer from general knowledge.
Suggest the user rephrase their question or ask about topics covered in your knowledge base.
`;
            }
        }
    } else if (isStrictKnowledge) {
        if (kbIds.length === 0) {
            systemPromptExtension += `\n\n## KNOWLEDGE BASE RESULTS
Your knowledge base is empty. No information has been added yet.
You MUST tell the user that your knowledge base has not been set up yet and you cannot answer questions until knowledge is added.
Do NOT answer any questions from general knowledge.
`;
        } else {
            systemPromptExtension += `\n\n## KNOWLEDGE BASE RESULTS
No relevant information was found in your knowledge base for this query.
You MUST tell the user you don't have information about this topic. Do NOT answer from general knowledge.
Suggest the user rephrase their question or ask about topics covered in your knowledge base.
`;
        }
    }

    return systemPromptExtension;
}

module.exports = { performKnowledgeSearch };
