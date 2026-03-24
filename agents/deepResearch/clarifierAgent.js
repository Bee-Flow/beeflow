/**
 * Deep Research — Clarifier Agent
 *
 * Pre-research agent that analyzes the user's query and determines whether
 * clarification is needed before spending tokens on research.
 *
 * Returns: { needsClarification, questions[], refinedQuery, researchScope }
 */

const { callLLM, extractJSON } = require('../../pipeline/llmHelpers');

const CLARIFIER_SYSTEM_PROMPT = `You are a Deep Research Clarification Agent. Your job is to analyze the user's research query and determine if it needs clarification before launching an expensive multi-agent research pipeline.

## When to ask for clarification
ONLY ask when the answer would fundamentally change the research direction:
- The query is ambiguous and has multiple very different interpretations
- Critical scope is undefined (e.g. "research AI" — which aspect? applications? theory? specific industry?)
- Geographic or temporal scope is unclear and matters (e.g. "market analysis" — which market? when?)

## When NOT to ask
- The query is clear enough to produce useful research
- Minor ambiguities that can be handled by covering multiple angles
- Questions that would annoy the user (e.g. "did you mean X?")

## Response Format
Respond with ONLY a JSON object:
{
  "needsClarification": true/false,
  "questions": ["question 1", "question 2"],
  "refinedQuery": "the refined/cleaned query for research (always provide, even if no clarification needed)",
  "researchScope": {
    "mainTopic": "core topic",
    "subtopics": ["subtopic 1", "subtopic 2"],
    "perspective": "technical|business|general|academic",
    "timeframe": "current|historical|future|all"
  }
}

Keep questions to 1-3 maximum. Be concise.`;

/**
 * Analyze query and optionally request clarification.
 * @param {string} query
 * @param {object} opts - { model }
 * @returns {{ needsClarification: boolean, questions: string[], refinedQuery: string, researchScope: object }}
 */
async function clarifyQuery(query, opts = {}) {
    const data = await callLLM({
        systemPrompt: CLARIFIER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: query }],
        model: opts.model || null,
        temperature: 0.2,
        maxTokens: 1000
    });

    const content = data.choices[0].message.content || '';
    const parsed = extractJSON(content);

    if (!parsed) {
        // Fallback — no clarification, use query as-is
        return {
            needsClarification: false,
            questions: [],
            refinedQuery: query,
            researchScope: { mainTopic: query, subtopics: [], perspective: 'general', timeframe: 'current' }
        };
    }

    return {
        needsClarification: !!parsed.needsClarification,
        questions: parsed.questions || [],
        refinedQuery: parsed.refinedQuery || query,
        researchScope: parsed.researchScope || { mainTopic: query, subtopics: [], perspective: 'general', timeframe: 'current' }
    };
}

module.exports = { clarifyQuery };
