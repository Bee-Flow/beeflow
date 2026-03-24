/**
 * Deep Research — Web Search Worker
 *
 * Enhanced web search worker with iterative search refinement:
 *   1. Search with initial query
 *   2. Evaluate results quality
 *   3. Refine query and re-search if needed (up to maxIterations)
 *   4. Return structured findings with full citation metadata
 */

const { callLLM, extractJSON } = require('../../../pipeline/llmHelpers');
const { getSearchTools, executeToolCalls } = require('../../../pipeline/toolHelpers');

const WORKER_SYSTEM_PROMPT = `You are a Deep Research Web Search Specialist. Given a research question, use your web search tool to find comprehensive, accurate information.

## Research Process
1. Start with a focused search query
2. Evaluate the results — are they relevant and high-quality?
3. If gaps remain, search again with a refined query
4. Extract key facts, statistics, and insights from results

## IMPORTANT
- Use the web_search tool with "advanced" search_depth for thorough results
- Search multiple angles (not just one query)
- Prefer authoritative sources (.gov, .edu, established publications)
- Track ALL sources for citation

## Response Format
After gathering sufficient information, respond with ONLY a JSON object:
{
  "question": "the original question",
  "findings": [
    "Key finding 1 with specific data",
    "Key finding 2 with specific data"
  ],
  "sources": [
    { "title": "Source Title", "url": "https://...", "excerpt": "Relevant excerpt", "relevanceScore": 0.9, "accessDate": "2026-03-20" }
  ],
  "summary": "Brief synthesis of all findings",
  "confidence": "high|medium|low",
  "gaps": ["any information gaps that remain"]
}`;

/**
 * @param {object} node - Research DAG node { id, question, focus, searchStrategy }
 * @param {object} opts - { model, maxIterations, searchDepth, onEvent }
 * @returns {object} - { id, question, findings[], sources[], summary, confidence, gaps[], success }
 */
async function searchWeb(node, opts = {}) {
    const maxIter = opts.maxIterations || 5;
    const onEvent = opts.onEvent || (() => {});
    const workerId = `web_${node.id}`;

    onEvent('worker_start', { id: node.id, worker: 'web_search', question: node.question, focus: node.focus });

    const tools = getSearchTools();
    if (!tools.length) {
        onEvent('worker_error', { id: node.id, worker: 'web_search', error: 'No search tools available (tavily_search component required)' });
        return { id: node.id, question: node.question, findings: [], sources: [], summary: 'No search tools available', confidence: 'low', gaps: [node.question], success: false };
    }

    const messages = [{
        role: 'user',
        content: `Research this question thoroughly: "${node.question}"\nFocus area: ${node.focus}\nSearch depth: use "advanced" depth for thorough results.`
    }];

    let result = null;
    let iterations = 0;

    try {
        while (iterations < maxIter) {
            iterations++;

            const data = await callLLM({
                systemPrompt: WORKER_SYSTEM_PROMPT,
                messages,
                tools,
                model: opts.model || null,
                temperature: 0.3,
                maxTokens: 3000
            });

            const assistantMsg = data.choices[0].message;

            if (assistantMsg.tool_calls?.length > 0) {
                messages.push({ ...assistantMsg, content: assistantMsg.content ?? '' });
                const toolResults = await executeToolCalls(assistantMsg.tool_calls, onEvent, workerId, 'research');
                for (const { tc, result: toolRes } of toolResults) {
                    messages.push({ role: 'tool', tool_call_id: tc.id, content: toolRes });
                }
                continue;
            }

            // Parse final response
            result = extractJSON(assistantMsg.content || '');
            if (!result) {
                result = {
                    question: node.question,
                    findings: [(assistantMsg.content || '').slice(0, 1000)],
                    sources: [],
                    summary: (assistantMsg.content || '').slice(0, 300),
                    confidence: 'low',
                    gaps: []
                };
            }
            break;
        }

        const sourcesCount = result?.sources?.length || 0;
        onEvent('worker_done', { id: node.id, worker: 'web_search', sourcesCount, findingsCount: result?.findings?.length || 0, confidence: result?.confidence || 'unknown' });

        return { id: node.id, ...result, success: true };

    } catch (error) {
        console.error(`[DeepResearch:WebWorker] Node ${node.id} failed:`, error.message);
        onEvent('worker_error', { id: node.id, worker: 'web_search', error: error.message });
        return { id: node.id, question: node.question, findings: [], sources: [], summary: `Search failed: ${error.message}`, confidence: 'low', gaps: [node.question], success: false };
    }
}

module.exports = { searchWeb };
