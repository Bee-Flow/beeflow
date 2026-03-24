/**
 * Deep Research — Knowledge Base Search Worker
 *
 * Searches the user's uploaded knowledge bases for relevant information.
 * Cross-references internal docs with web findings.
 */

const { callLLM, extractJSON } = require('../../../pipeline/llmHelpers');
const kbSearchTools = require('../../../integrations/kbSearchTools');

const WORKER_SYSTEM_PROMPT = `You are a Deep Research Knowledge Base Specialist. You search internal knowledge bases and documents to find relevant information.

## Instructions
1. Use the kb_search tool to query internal documents
2. Extract relevant facts, policies, and data from internal sources
3. Note the document source for citation

## Response Format
Respond with ONLY a JSON object:
{
  "question": "the original question",
  "findings": ["Key finding 1", "Key finding 2"],
  "sources": [
    { "title": "Document name", "type": "internal_kb", "excerpt": "Relevant excerpt", "relevanceScore": 0.9 }
  ],
  "summary": "Brief synthesis of internal findings",
  "confidence": "high|medium|low"
}`;

/**
 * @param {object} node - Research DAG node
 * @param {object} opts - { model, userId, onEvent }
 */
async function searchKnowledgeBase(node, opts = {}) {
    const onEvent = opts.onEvent || (() => {});
    const workerId = `kb_${node.id}`;

    onEvent('worker_start', { id: node.id, worker: 'kb_search', question: node.question });

    try {
        // Check if KB search is available
        const kbTools = kbSearchTools.getKBSearchTools ? kbSearchTools.getKBSearchTools() : [];
        if (!kbTools.length && !kbSearchTools.executeKBSearch) {
            return {
                id: node.id, question: node.question,
                findings: [], sources: [],
                summary: 'No knowledge base available',
                confidence: 'low', success: false, skipped: true
            };
        }

        // Direct KB search if available
        let kbResults = [];
        if (kbSearchTools.executeKBSearch) {
            try {
                kbResults = await kbSearchTools.executeKBSearch(node.question, { userId: opts.userId, limit: 5 });
            } catch (e) {
                console.warn(`[DeepResearch:KBWorker] KB search failed:`, e.message);
            }
        }

        if (!kbResults || kbResults.length === 0) {
            onEvent('worker_done', { id: node.id, worker: 'kb_search', sourcesCount: 0, skipped: true });
            return {
                id: node.id, question: node.question,
                findings: [], sources: [],
                summary: 'No relevant internal documents found',
                confidence: 'low', success: true, skipped: true
            };
        }

        // Use LLM to synthesize KB results
        const kbContext = kbResults.map((r, i) =>
            `[Doc ${i + 1}] ${r.title || r.name || 'Untitled'}\n${r.content || r.text || r.excerpt || ''}`
        ).join('\n\n---\n\n');

        const data = await callLLM({
            systemPrompt: WORKER_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: `Question: "${node.question}"\n\nInternal documents found:\n${kbContext}` }],
            model: opts.model || null,
            temperature: 0.2,
            maxTokens: 2000
        });

        const content = data.choices[0].message.content || '';
        const result = extractJSON(content) || {
            question: node.question,
            findings: [content.slice(0, 500)],
            sources: kbResults.map(r => ({ title: r.title || 'Internal doc', type: 'internal_kb', excerpt: (r.content || '').slice(0, 200) })),
            summary: content.slice(0, 200),
            confidence: 'medium'
        };

        onEvent('worker_done', { id: node.id, worker: 'kb_search', sourcesCount: result.sources?.length || 0 });
        return { id: node.id, ...result, success: true };

    } catch (error) {
        console.error(`[DeepResearch:KBWorker] Node ${node.id} failed:`, error.message);
        onEvent('worker_error', { id: node.id, worker: 'kb_search', error: error.message });
        return { id: node.id, question: node.question, findings: [], sources: [], summary: `KB search failed: ${error.message}`, confidence: 'low', success: false };
    }
}

module.exports = { searchKnowledgeBase };
