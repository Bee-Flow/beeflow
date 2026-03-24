/**
 * Deep Research — Outline Generator
 *
 * Generates a structured report outline from research findings.
 * Maps which sources support which sections for focused writing.
 *
 * Used in: Detailed depth (3-pass pipeline: outline → draft → review)
 */

const { callLLM, extractJSON } = require('../../../pipeline/llmHelpers');

const OUTLINE_SYSTEM_PROMPT = `You are a Research Report Outline Generator. Given research findings, create a logical, comprehensive outline for the final report.

## Instructions
1. Study all findings and identify the main themes
2. Create a hierarchical section structure (2-3 levels)
3. Map source citations to each section
4. Ensure logical flow: introduction → body sections → conclusion
5. Include an executive summary section at the top

## Response Format
Respond with ONLY a JSON object:
{
  "title": "Report Title",
  "sections": [
    {
      "id": "s1",
      "title": "Section Title",
      "description": "What this section covers",
      "keyPoints": ["point 1", "point 2"],
      "relevantNodeIds": ["q1", "q2"],
      "subsections": [
        { "id": "s1.1", "title": "Subsection", "description": "..." }
      ]
    }
  ]
}`;

/**
 * Generate report outline from research results.
 * @param {string} topic
 * @param {object[]} results - Research results from orchestrator
 * @param {object} opts - { model }
 */
async function generateOutline(topic, results, opts = {}) {
    const findingsSummary = results
        .filter(r => r.success)
        .map(r => `### ${r.question || r.id}\nFindings: ${(r.findings || []).slice(0, 5).join('; ')}\nSources: ${(r.sources || []).length}`)
        .join('\n\n');

    const data = await callLLM({
        systemPrompt: OUTLINE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `## Research Topic: ${topic}\n\n## Findings\n${findingsSummary}\n\nCreate a comprehensive report outline.` }],
        model: opts.model || null,
        temperature: 0.3,
        maxTokens: 2000
    });

    const content = data.choices[0].message.content || '';
    const outline = extractJSON(content);

    if (!outline || !outline.sections?.length) {
        // Fallback outline
        return {
            title: topic,
            sections: [
                { id: 's1', title: 'Executive Summary', description: 'Overview of findings', keyPoints: [], relevantNodeIds: [], subsections: [] },
                { id: 's2', title: 'Key Findings', description: 'Main research findings', keyPoints: [], relevantNodeIds: results.map(r => r.id), subsections: [] },
                { id: 's3', title: 'Analysis', description: 'Detailed analysis', keyPoints: [], relevantNodeIds: [], subsections: [] },
                { id: 's4', title: 'Conclusions', description: 'Summary and recommendations', keyPoints: [], relevantNodeIds: [], subsections: [] },
            ]
        };
    }

    return outline;
}

module.exports = { generateOutline };
