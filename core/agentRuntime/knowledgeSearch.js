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
        // Score threshold differs between backends:
        //   - Search-service rerank scores are in 0..1 range → 0.25 is a reasonable cutoff
        //   - Local RRF (Reciprocal Rank Fusion) scores are ~0.003-0.03 → skip threshold
        const maxKBScore = Math.max(...allKnowledgeResults.map(r => r.score || 0), 0);
        const isRRFScoring = maxKBScore > 0 && maxKBScore < 0.1;
        const MIN_SCORE = isRRFScoring ? 0 : 0.25;
        allKnowledgeResults = allKnowledgeResults.filter(r => (r.score || 0) >= MIN_SCORE);

        const sourceMap = new Map();
        for (const result of allKnowledgeResults) {
            const source = result.metadata?.source || 'Unknown Source';
            if (sourceMap.has(source)) {
                const existing = sourceMap.get(source);
                existing.content += '\n\n' + result.content;
                existing.score = Math.max(existing.score || 0, result.score || 0);
            } else {
                sourceMap.set(source, { ...result });
            }
        }
        
        const mergedResults = Array.from(sourceMap.values());
        mergedResults.sort((a, b) => (b.score || 0) - (a.score || 0));
        const topResults = mergedResults.slice(0, 10);

        const MAX_CONTENT_CHARS = 2000;
        for (const result of topResults) {
            if (result.content && result.content.length > MAX_CONTENT_CHARS) {
                result.content = result.content.slice(0, MAX_CONTENT_CHARS) + '…';
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
                    sources: topResults.map(k => ({
                        title: k.metadata?.source || k.metadata?.source_uri || 'Unknown Source',
                        content: k.content,
                        score: k.score || 0,
                        type: k.metadata?.type || 'unknown'
                    }))
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
