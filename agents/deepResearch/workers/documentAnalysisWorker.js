/**
 * Deep Research — Document Analysis Worker
 *
 * Receives URLs from the web search worker, fetches full content,
 * and uses LLM to extract and cross-reference key facts.
 */

const { callLLM, extractJSON } = require('../../../pipeline/llmHelpers');

const WORKER_SYSTEM_PROMPT = `You are a Deep Research Document Analyst. You receive raw document content and extract structured insights.

## Instructions
1. Extract key facts, statistics, and arguments
2. Note any claims that are well-supported vs. speculative
3. Compare claims across multiple source excerpts for consistency
4. Flag contradictions between sources

## Response Format
Respond with ONLY a JSON object:
{
  "keyFacts": [
    { "fact": "Specific fact or statistic", "source": "source title", "confidence": "high|medium|low" }
  ],
  "contradictions": [
    { "claim1": "Source A says X", "claim2": "Source B says Y", "analysis": "Why they differ" }
  ],
  "insights": ["Higher-level insight 1", "Insight 2"],
  "summary": "Brief overall synthesis"
}`;

/**
 * Analyze sources found by web search, extracting and cross-referencing facts.
 * @param {object} node - DAG node
 * @param {object[]} webFindings - Results from web search worker
 * @param {object} opts - { model, onEvent }
 */
async function analyzeDocuments(node, webFindings = [], opts = {}) {
    const onEvent = opts.onEvent || (() => {});

    onEvent('worker_start', { id: node.id, worker: 'doc_analysis', question: node.question });

    if (!webFindings.length) {
        onEvent('worker_done', { id: node.id, worker: 'doc_analysis', skipped: true });
        return { id: node.id, keyFacts: [], contradictions: [], insights: [], summary: 'No sources to analyze', success: true, skipped: true };
    }

    try {
        // Compile source excerpts
        const sourceSummaries = webFindings.map((f, i) => {
            const sources = (f.sources || []).map(s =>
                `### ${s.title || 'Untitled'}\nURL: ${s.url || 'N/A'}\nExcerpt: ${(s.excerpt || s.content || '').slice(0, 800)}`
            ).join('\n\n');
            return `## Sub-question: ${f.question}\n${sources}\n\n**Worker Summary:** ${f.summary || 'N/A'}`;
        }).join('\n\n---\n\n');

        const data = await callLLM({
            systemPrompt: WORKER_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: `Analyze these research findings for: "${node.question}"\n\n${sourceSummaries}` }],
            model: opts.model || null,
            temperature: 0.2,
            maxTokens: 3000
        });

        const content = data.choices[0].message.content || '';
        const result = extractJSON(content) || {
            keyFacts: [],
            contradictions: [],
            insights: [content.slice(0, 500)],
            summary: content.slice(0, 300)
        };

        onEvent('worker_done', {
            id: node.id, worker: 'doc_analysis',
            factsCount: result.keyFacts?.length || 0,
            contradictionsCount: result.contradictions?.length || 0
        });

        return { id: node.id, ...result, success: true };

    } catch (error) {
        console.error(`[DeepResearch:DocAnalysis] Node ${node.id} failed:`, error.message);
        onEvent('worker_error', { id: node.id, worker: 'doc_analysis', error: error.message });
        return { id: node.id, keyFacts: [], contradictions: [], insights: [], summary: `Analysis failed: ${error.message}`, success: false };
    }
}

module.exports = { analyzeDocuments };
