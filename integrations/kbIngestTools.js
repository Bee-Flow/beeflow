/**
 * Knowledge Base Ingest — a ROUTINE-ONLY automation action (never exposed to
 * chat agents; it writes). Used by the "Resolved tickets → knowledge base"
 * template: an ai_step distils a solved ticket into an article, then this tool
 * ingests it into the chosen KB with a source-link back to the ticket.
 *
 * Dedup matches the ITIL Ticket Assistant exactly: it delegates to the shared
 * kbIngestionHelpers.ingestDocument() path, which dedupes by exact content_hash
 * AND simhash64 near-duplicate (Hamming distance ≤3). Behaviour:
 *   - Same ticket re-resolved (same sourceUri) → refresh the article in place
 *     (delete old chunks, re-ingest) so it never duplicates.
 *   - A near-duplicate of a DIFFERENT ticket → handled by `nearDuplicateStrategy`
 *     (the template sets 'merge'): the prior + new article are merged/enriched
 *     into one richer entry via the same LLM merge prompt ITIL uses, keeping a
 *     single canonical document. 'skip' keeps the first; 'replace' keeps latest.
 *   - Byte-identical content → skipped (the canonical doc already covers it).
 *
 * Tenant isolation: the target KB MUST belong to the running org (ctx.orgId).
 * System KBs and other orgs' KBs are refused.
 */

const knowledgeBases = require('../stores/knowledgeBases');
const { ingestDocument, findDocumentBySourceUri, deleteDocumentChunks } = require('../core/kbIngestionHelpers');

const SOURCE_TYPE = 'support_ticket';

const KB_INGEST_TOOLS = [{
    type: 'function',
    function: {
        name: 'knowledge_base_ingest',
        description: 'Ingest a distilled article into an organisation knowledge base. Chunks, embeds and stores the content. Dedupes like the ITIL Ticket Assistant: exact content_hash AND simhash near-duplicate detection. Re-ingesting the same sourceUri refreshes the article in place; a near-duplicate of a different ticket is merged/skipped/replaced per nearDuplicateStrategy. Writes only to a KB owned by the running organisation.',
        parameters: {
            type: 'object',
            properties: {
                knowledgeBaseId: { type: 'string', description: 'Target knowledge base UUID (must belong to this organisation).' },
                title: { type: 'string', description: 'Short article title.' },
                content: { type: 'string', description: 'Markdown article body to ingest.' },
                sourceUri: { type: 'string', description: "Provenance link, e.g. 'support://ticket/<id>'. Re-ingesting the same sourceUri refreshes the prior article in place." },
                lang: { type: 'string', description: "Language hint or 'auto' (default)." },
                dedupe: { type: 'boolean', description: 'Run content_hash + simhash dedup against other articles (default true). Set false to force a new document.' },
                nearDuplicateStrategy: { type: 'string', enum: ['merge', 'skip', 'replace'], description: "What to do when a near-duplicate of a DIFFERENT ticket already exists: 'merge' (combine into one richer article — default for support), 'skip' (keep the existing one), 'replace' (overwrite with the new one)." },
            },
            required: ['knowledgeBaseId', 'content'],
        },
    },
}];

function isKbIngestTool(name) {
    return name === 'knowledge_base_ingest';
}

/** documents.metadata may arrive as a JSON string or an object — normalise. */
function _readMetadata(doc) {
    const m = doc && doc.metadata;
    if (!m) return {};
    if (typeof m === 'string') { try { return JSON.parse(m) || {}; } catch { return {}; } }
    return m;
}

/**
 * Merge a prior article with a freshly-distilled one into a single, richer,
 * deduplicated article, reusing the exact LLM machinery the ITIL Ticket
 * Assistant uses (DEFAULT_MERGE_PROMPT on a 'fast'-tier model).
 */
async function _mergeArticles(priorArticle, incomingArticle, orgId) {
    const { createChatCompletion } = require('../agents/providerAdapters');
    const { DEFAULT_MERGE_PROMPT } = require('../core/ticketAssistantProcessor');
    const { resolveModelForTierName } = require('../core/modelResolver');
    const model = await resolveModelForTierName('fast', { userOrgId: orgId || null, fallback: 'gpt-4.1-mini' });
    const res = await createChatCompletion({
        model,
        messages: [
            { role: 'system', content: DEFAULT_MERGE_PROMPT },
            { role: 'user', content: `${priorArticle}\n\n---\n\n${incomingArticle}` },
        ],
        temperature: 0.2,
        max_tokens: 4000,
    });
    const merged = res?.choices?.[0]?.message?.content?.trim();
    return merged && merged.length >= 20 ? merged : null;
}

/**
 * Replace an existing document's content in place: delete its chunks + record,
 * then re-ingest under the SAME canonical sourceUri (skipDedup so it is never
 * rejected as its own duplicate). Carries `article` + `mergedSources` metadata
 * so future merges have the prior text and full provenance.
 */
async function _refreshInPlace(tenantId, kbId, existingDoc, article, title, lang, extraMeta = {}) {
    const canonicalUri = existingDoc.source_uri || null;
    const prevMeta = _readMetadata(existingDoc);
    await deleteDocumentChunks(kbId, existingDoc.id, tenantId).catch(() => {});
    const metadata = {
        ingestedBy: 'routine', source_type: SOURCE_TYPE, provider: 'support',
        sourceUri: canonicalUri, ...prevMeta, ...extraMeta, article,
    };
    const res = await ingestDocument(tenantId, kbId, article, title, SOURCE_TYPE, canonicalUri, {
        skipDedup: true, lang: lang || 'auto', metadata,
    });
    return res;
}

async function executeKbIngestTool(toolName, args = {}, context = {}) {
    try {
        if (!isKbIngestTool(toolName)) return { error: `Unknown tool: ${toolName}` };
        const orgId = context.orgId || null;
        const {
            knowledgeBaseId, title, content, sourceUri, lang,
            dedupe = true, nearDuplicateStrategy = 'skip',
        } = args || {};
        if (!knowledgeBaseId) return { error: 'knowledgeBaseId is required.' };
        const body = String(content || '').trim();
        if (!body) return { error: 'content is required.' };

        const kb = await knowledgeBases.getKB(knowledgeBaseId);
        if (!kb) return { error: 'Knowledge base not found.' };
        if (kb.tenant_id === 'system') return { error: 'Cannot ingest into a system knowledge base.' };
        // Tenant isolation: never write into another org's KB.
        if (kb.organization_id && orgId && kb.organization_id !== orgId) {
            return { error: 'Knowledge base does not belong to this organisation.' };
        }
        if (kb.organization_id && !orgId) {
            return { error: 'No organisation context for ingestion.' };
        }

        const tenantId = kb.tenant_id || orgId || 'system';
        const docTitle = title || 'Support article';
        const threadId = sourceUri ? String(sourceUri).split('/').pop() : null;
        const baseMeta = {
            ingestedBy: 'routine', source_type: SOURCE_TYPE, provider: 'support',
            sourceUri: sourceUri || null, threadId, inboxId: context.inboxId || null,
            article: body,
        };

        // ── 1. Same ticket re-resolved → refresh its own article in place ──
        if (sourceUri) {
            const existing = await findDocumentBySourceUri(knowledgeBaseId, sourceUri);
            if (existing) {
                const res = await _refreshInPlace(tenantId, knowledgeBaseId, existing, body, docTitle, lang, { threadId, inboxId: context.inboxId || null });
                return { ok: true, refreshed: true, deduped: false, documentId: res.document.id, chunks_created: res.chunks, sourceUri };
            }
        }

        // ── 2. New article with ITIL-grade dedup (content_hash + simhash) ──
        try {
            const res = await ingestDocument(tenantId, knowledgeBaseId, body, docTitle, SOURCE_TYPE, sourceUri || null, {
                skipDedup: !dedupe, lang: lang || 'auto', metadata: baseMeta,
            });
            return { ok: true, deduped: false, documentId: res.document.id, chunks_created: res.chunks, sourceUri: sourceUri || null };
        } catch (e) {
            // Exact duplicate → nothing new to add; the canonical doc covers it.
            if (e.code === 'DUPLICATE') {
                return { ok: true, deduped: true, reason: 'content_hash_dup', documentId: e.documentId, chunks_created: 0, sourceUri: sourceUri || null };
            }
            // Near-duplicate of a DIFFERENT ticket → resolve per strategy.
            if (e.code === 'NEAR_DUPLICATE') {
                const existing = e.documentId ? await knowledgeBases.getDocument(e.documentId).catch(() => null) : null;

                if (nearDuplicateStrategy === 'skip' || !existing) {
                    return { ok: true, deduped: true, reason: 'simhash_near_dup', nearDuplicateOf: e.documentId, documentId: e.documentId, chunks_created: 0, sourceUri: sourceUri || null };
                }

                if (nearDuplicateStrategy === 'replace') {
                    const res = await _refreshInPlace(tenantId, knowledgeBaseId, existing, body, docTitle, lang, { threadId, inboxId: context.inboxId || null, replacedBy: sourceUri || null });
                    return { ok: true, replaced: true, deduped: false, documentId: res.document.id, nearDuplicateOf: e.documentId, chunks_created: res.chunks, sourceUri: sourceUri || null };
                }

                // 'merge' — combine prior + new into one richer article.
                const prevMeta = _readMetadata(existing);
                const priorArticle = (prevMeta.article && String(prevMeta.article).trim()) || null;
                if (!priorArticle) {
                    // Pre-change doc without stored article text → replace with latest.
                    const res = await _refreshInPlace(tenantId, knowledgeBaseId, existing, body, docTitle, lang, { threadId, inboxId: context.inboxId || null, replacedBy: sourceUri || null });
                    return { ok: true, replaced: true, deduped: false, documentId: res.document.id, nearDuplicateOf: e.documentId, chunks_created: res.chunks, sourceUri: sourceUri || null };
                }
                const merged = await _mergeArticles(priorArticle, body, orgId);
                if (!merged) {
                    // Merge LLM failed → keep the existing article unchanged.
                    return { ok: true, deduped: true, reason: 'merge_failed_kept_existing', nearDuplicateOf: e.documentId, documentId: e.documentId, chunks_created: 0, sourceUri: sourceUri || null };
                }
                const mergedSources = Array.from(new Set([
                    ...(Array.isArray(prevMeta.mergedSources) ? prevMeta.mergedSources : (existing.source_uri ? [existing.source_uri] : [])),
                    sourceUri || null,
                ].filter(Boolean)));
                const res = await _refreshInPlace(tenantId, knowledgeBaseId, existing, merged, docTitle, lang, { mergedSources });
                return { ok: true, merged: true, deduped: false, documentId: res.document.id, nearDuplicateOf: e.documentId, mergedSources, chunks_created: res.chunks, sourceUri: sourceUri || null };
            }
            throw e;
        }
    } catch (e) {
        console.error('[kbIngestTools] ingest failed:', e.message);
        return { error: e.message };
    }
}

module.exports = { KB_INGEST_TOOLS, isKbIngestTool, executeKbIngestTool };
