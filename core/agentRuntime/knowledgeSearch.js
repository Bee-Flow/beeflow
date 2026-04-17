const configStore = require('../../stores/configStore');
const { getServiceHeaders } = require('../serviceAuth');
const { estimateTokens, fitIntoTokenBudget } = require('../tokenBudget');

// Rough budget for knowledge injection. Exposed as env vars so we can tune
// per model-family without a code change.
const PER_CHUNK_TOKEN_CAP = parseInt(process.env.EMAIL_KB_PER_CHUNK_TOKENS || '800', 10);
const GLOBAL_INJECT_TOKEN_CAP = parseInt(process.env.EMAIL_KB_INJECT_TOKENS || '4000', 10);

// Greetings / small-talk patterns that should NEVER trigger a KB lookup.
// Kept intentionally broad — false negatives are cheap (just an extra search),
// false positives would hide real queries.
const GREETING_RE = /^(h(i|ey|ello|oi|allo|oi+)|yo|sup|goedemorgen|goedemiddag|goedenavond|goedendag|dag|bedankt|dankjewel|thanks|thank you|ok(ay)?|yes|no|ja|nee|sure|cool|nice|great|good morning|good afternoon|good evening|how are you|hoe gaat het|alles goed|what'?s up|how'?s it going)[\s!.,?]*$/i;

async function performKnowledgeSearch({ agent, userId, userMessage, isStrictKnowledge, onEvent }) {
    let systemPromptExtension = '';
    const kbIds = agent.config?.knowledge_base_ids || [];
    let allKnowledgeResults = [];

    // ── Skip KB search for greetings / small-talk ───────────────────
    // These never carry search intent and always return low-quality matches.
    const trimmedInput = (userMessage || '').trim();
    if (GREETING_RE.test(trimmedInput)) {
        console.log(`[KnowledgeSearch] Skipping KB search — greeting/small-talk detected: "${trimmedInput}"`);
        // In strict-knowledge mode, still let the agent respond naturally to greetings
        // (the "no results" prompt would be confusing for a simple "hi")
        return systemPromptExtension;
    }

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
                const chunks = await searchLocally(userId, kbIds, searchQuery, { topK: 5 });
                allKnowledgeResults.push(...chunks.map(c => {
                    // Prefer title over opaque internal URIs (n8n://, etc.)
                    const srcUri = c.source_uri || '';
                    const isInternalUri = srcUri.startsWith('n8n://') || srcUri.startsWith('internal://');
                    const displaySource = (isInternalUri && c.title) ? c.title : (srcUri || c.title || 'KB');
                    return {
                        content: c.content,
                        metadata: { source: displaySource, type: 'kb_chunk', source_uri: srcUri, document_id: c.document_id },
                        score: c.score || 0
                    };
                }));
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
                        top_k: 8,
                        rerank: true,
                        use_azure: false,
                    }),
                    signal: AbortSignal.timeout(15000)
                });

                if (searchRes.ok) {
                    const searchData = await searchRes.json();
                    const chunks = searchData.chunks || searchData.results || [];
                    allKnowledgeResults.push(...chunks.map(c => {
                        const srcUri = c.source_uri || '';
                        const isInternalUri = srcUri.startsWith('n8n://') || srcUri.startsWith('internal://');
                        const displaySource = (isInternalUri && c.title) ? c.title : (srcUri || c.title || 'KB');
                        return {
                            content: c.content,
                            metadata: { source: displaySource, type: 'kb_chunk', source_uri: srcUri, document_id: c.document_id },
                            score: c.score || c.rerank_score || 0
                        };
                    }));
                }
            }
        } catch (searchErr) {
            console.warn('[KnowledgeSearch] KB search failed:', searchErr.message);
        }
    }

    if (allKnowledgeResults.length > 0) {
        // Enrich with document-level metadata (sender/threadId/attachments) so
        // we can apply metadata-aware scoring boosts and thread-aware retrieval.
        await enrichResultsWithDocMetadata(allKnowledgeResults, kbIds);
        applyMetadataBoost(allKnowledgeResults, userMessage);

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

        // ── Minimum relevance floor ──────────────────────────────────
        // When a reranker is active, scores are calibrated 0-1 → apply 60% floor.
        // Without reranker, scores are RRF fusion values (typically 0.01-0.03) →
        // skip this filter (the MIN_SCORE check above already handles the floor).
        if (hasReranker) {
            const MIN_SCORE_THRESHOLD = 0.72;
            const beforeCount = allKnowledgeResults.length;
            allKnowledgeResults = allKnowledgeResults.filter(r => (r.score || 0) >= MIN_SCORE_THRESHOLD);
            if (beforeCount !== allKnowledgeResults.length) {
                console.log(`[KnowledgeSearch] Relevance filter: ${beforeCount} → ${allKnowledgeResults.length} chunks (threshold: ${MIN_SCORE_THRESHOLD})`);
            }
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

        console.log(`[KnowledgeSearch] Results: ${allKnowledgeResults.length} after filters → ${topResults.length} after dedup (hasReranker=${hasReranker}, includeRefs=${agent.config?.includeSourceReferences})`);

        // Per-chunk content cap (token-aware) + strip repeated heading breadcrumbs.
        const seenDocHeadings = new Map();
        let anyChunkTruncated = false;
        for (const result of topResults) {
            // Strip heading lines already seen from the same source document
            const docKey = result.metadata?.source || 'unknown';
            const seen = seenDocHeadings.get(docKey);
            if (seen && result.content) {
                result.content = result.content.split('\n').filter(line => {
                    if (/^#{1,6}\s+/.test(line) && seen.has(line.trim())) return false;
                    return true;
                }).join('\n').replace(/^\n+/, '');
            }
            const headings = (result.content || '').match(/^#{1,6}\s+.+$/gm) || [];
            if (!seen) {
                seenDocHeadings.set(docKey, new Set(headings.map(h => h.trim())));
            } else {
                headings.forEach(h => seen.add(h.trim()));
            }
            if (result.content) {
                const fit = fitIntoTokenBudget(result.content, PER_CHUNK_TOKEN_CAP);
                result.content = fit.text;
                if (fit.truncated) anyChunkTruncated = true;
            }
        }


        if (topResults.length > 0) {
            const includeRefs = agent.config?.includeSourceReferences === true;
            let knowledgeText = topResults.map((k, i) => {
                const meta = k.metadata || {};
                let source = meta.source || meta.source_uri || 'Unknown Source';
                if (meta.type === 'url_import' && meta.source) source = meta.source;
                return `### Source ${i + 1}: ${source}\n${k.content}\n`;
            }).join('\n');

            // Global cap: protect against the combined knowledge block blowing
            // the context window even when individual chunks already fit.
            const fitGlobal = fitIntoTokenBudget(knowledgeText, GLOBAL_INJECT_TOKEN_CAP);
            knowledgeText = fitGlobal.text;
            const truncationNote = (fitGlobal.truncated || anyChunkTruncated)
                ? '\nSome retrieved sources were truncated to fit the context window.'
                : '';
            console.log(`[KnowledgeSearch] Inject tokens: ~${estimateTokens(knowledgeText)} (cap ${GLOBAL_INJECT_TOKEN_CAP}, chunkCap ${PER_CHUNK_TOKEN_CAP}, truncated=${fitGlobal.truncated || anyChunkTruncated})`);

            const citationInstruction = includeRefs
                ? 'Do NOT include inline citations or source references (e.g. [Source 1] or "(Bron: ...)") in your response text. Source references are shown separately below your answer.'
                : 'Do NOT include citations (e.g. [Source 1]) or source references in your final response.';

            if (isStrictKnowledge) {
                systemPromptExtension += `\n\n## KNOWLEDGE BASE RESULTS
The following information was retrieved from your knowledge base. Answer ONLY from this data.
If the user's question cannot be answered from the information below, you MUST say you don't have that information.
${citationInstruction}${truncationNote}

${knowledgeText}
`;
            } else {
                systemPromptExtension += `\n\n## RELEVANT KNOWLEDGE BASE
The following information from your knowledge base was retrieved based on the user's request.
Use this information to answer the question.
${citationInstruction}${truncationNote}

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

/**
 * Quick KB search for non-agent contexts (direct chat, template chat).
 * Uses the same quality gates as agent KB search: greeting guard,
 * score threshold, Jaccard dedup, and content cap.
 *
 * @param {string} userId
 * @param {string[]} kbIds
 * @param {string} query — the user message
 * @param {object} [options]
 * @param {number} [options.topK=6] — max results to return
 * @param {number} [options.contentCap=3000] — max chars per chunk
 * @returns {Promise<Array<{title: string, content: string, score: number}>>}
 */
async function quickKBSearch(userId, kbIds, query, options = {}) {
    const { topK = 6, contentCap = 3000 } = options;

    if (!kbIds || kbIds.length === 0 || !query) return [];

    // Greeting guard — don't waste API calls on "hi"
    const trimmed = (query || '').trim();
    if (GREETING_RE.test(trimmed)) return [];

    const useAzure = !!(await configStore.getConfig('use_azure_doc_processing'));
    let chunks = [];

    try {
        if (useAzure) {
            const { searchLocally } = require('../localKBIngest');
            chunks = await searchLocally(userId, kbIds, query, { topK: topK + 2 });
        } else {
            const searchUrl = process.env.SEARCH_SERVICE_URL || 'https://services.beeflow.ai';
            const searchRes = await fetch(`${searchUrl}/tools/kb-search`, {
                method: 'POST',
                headers: getServiceHeaders(),
                body: JSON.stringify({ tenant_id: userId, kb_ids: kbIds, query, top_k: topK + 2, rerank: true }),
                signal: AbortSignal.timeout(10000),
            });
            if (searchRes.ok) {
                const searchData = await searchRes.json();
                chunks = searchData.chunks || searchData.results || [];
            }
        }
    } catch (err) {
        console.warn('[quickKBSearch] KB search failed:', err.message);
        return [];
    }

    // Score threshold — same as agent path (0.72 with reranker)
    const MIN_RELEVANCE = 0.72;
    chunks = chunks.filter(c => (c.score || c.rerank_score || 0) >= MIN_RELEVANCE);

    // Jaccard dedup (same as kbSearchTools)
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
    const deduped = [];
    const dedupSets = [];
    for (const c of chunks) {
        const ts = getTokenSet(c.content);
        if (!dedupSets.some(ex => jaccard(ts, ex) >= 0.85)) {
            deduped.push(c);
            dedupSets.push(ts);
        }
    }

    // Cap and format
    return deduped.slice(0, topK).map(c => ({
        title: c.title || c.source_uri || 'KB',
        content: (c.content || '').slice(0, contentCap),
        score: c.score || c.rerank_score || 0,
        source_uri: c.source_uri || '',
    }));
}

/**
 * Batch-load document-level metadata for every chunk that has a source_uri.
 * Mutates the result objects in-place, adding `docMeta`, `threadId`, `from`,
 * `subject`, `date`, `hasAttachments` for email-KB chunks.
 */
async function enrichResultsWithDocMetadata(results, kbIds) {
    if (!Array.isArray(kbIds) || kbIds.length === 0) return;
    const uris = Array.from(new Set(results
        .map(r => r.metadata?.source_uri)
        .filter(Boolean)));
    if (uris.length === 0) return;
    try {
        const { getAll } = require('../../db');
        const rows = await getAll(
            `SELECT source_uri, metadata, source_type FROM documents
             WHERE knowledge_base_id = ANY($1::uuid[]) AND source_uri = ANY($2::text[])`,
            [kbIds, uris]
        );
        const byUri = new Map();
        for (const row of rows) byUri.set(row.source_uri, row);
        for (const r of results) {
            const uri = r.metadata?.source_uri;
            const row = uri && byUri.get(uri);
            if (!row) continue;
            r.docMeta = row.metadata || {};
            r.sourceType = row.source_type;
            if (row.metadata?.threadId) r.metadata.threadId = row.metadata.threadId;
            if (row.metadata?.from) r.metadata.from = row.metadata.from;
            if (row.metadata?.subject) r.metadata.subject = row.metadata.subject;
            if (row.metadata?.date) r.metadata.date = row.metadata.date;
            if (row.metadata?.hasAttachments) r.metadata.hasAttachments = true;
        }
    } catch (err) {
        console.warn('[KnowledgeSearch] Metadata enrichment failed:', err.message);
    }
}

function tokenize(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s@._-]+/gu, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2);
}

/**
 * Apply metadata-aware score boosts. Caps extra at +0.10 to avoid overriding
 * semantic similarity entirely.
 *
 *   +0.03 per subject keyword hit (cap 0.06)
 *   +0.05 when sender mentioned in the query
 *   +0.05 for attachment results when the query mentions attachment/file/bijlage
 */
function applyMetadataBoost(results, userMessage) {
    if (!results || !results.length) return;
    const qTokens = new Set(tokenize(userMessage));
    if (qTokens.size === 0) return;
    const wantsAttachment = /\b(attachment|attach|file|bijlage|bijlagen|anhang|pdf|xlsx|spreadsheet|document)\b/i.test(userMessage || '');

    for (const r of results) {
        const md = r.docMeta;
        if (!md) continue;
        let bump = 0;

        if (md.subject) {
            const subjTokens = new Set(tokenize(md.subject));
            let hits = 0;
            for (const t of qTokens) if (subjTokens.has(t)) hits++;
            if (hits > 0) bump += Math.min(0.06, 0.03 * hits);
        }

        if (md.from) {
            const fromTokens = new Set(tokenize(md.from));
            for (const t of qTokens) { if (fromTokens.has(t)) { bump += 0.05; break; } }
        }

        if (wantsAttachment && md.hasAttachments) bump += 0.05;

        if (bump > 0) {
            r.score = (r.score || 0) + Math.min(0.10, bump);
            r.metadataBoost = Math.min(0.10, bump);
        }
    }
}

module.exports = { performKnowledgeSearch, quickKBSearch };
