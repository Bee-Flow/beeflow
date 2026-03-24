/**
 * Deep Research — Reflection Agent
 *
 * Evaluates research coverage after each round:
 *   - Detects gaps in information
 *   - Identifies contradictions between sources
 *   - Scores source quality
 *   - Decides whether more research is needed
 *   - Generates targeted follow-up queries
 */

const { callLLM, extractJSON } = require('../../pipeline/llmHelpers');

const REFLECTION_SYSTEM_PROMPT = `You are a Deep Research Reflection Agent. After a research round, you evaluate the quality and completeness of the gathered findings.

## Your Job
1. Assess overall coverage — did the research answer the core question?
2. Identify gaps — what important aspects are missing?
3. Spot contradictions — do any sources disagree?
4. Score confidence — how reliable are the findings?
5. Decide — is more research needed, or is the coverage sufficient?

## Response Format
Respond with ONLY a JSON object:
{
  "coveragePercent": 75,
  "needsMoreResearch": true,
  "gaps": [
    { "topic": "Missing topic", "importance": "high|medium|low", "reason": "Why this matters" }
  ],
  "contradictions": [
    { "claim1": "Source A says X", "claim2": "Source B says Y", "severity": "high|medium|low" }
  ],
  "additionalQueries": [
    { "question": "Specific follow-up query", "focus": "What gap this fills" }
  ],
  "qualityAssessment": {
    "sourceReliability": "high|medium|low",
    "dataRecency": "current|dated|mixed",
    "overallConfidence": "high|medium|low"
  },
  "reasoning": "Brief explanation of your assessment"
}

Be rigorous but practical. Don't ask for more research unless the gaps are genuinely important.
coveragePercent: 0-100 where 80+ means sufficient for a useful report.`;

/**
 * Reflect on gathered findings and decide if more research is needed.
 * @param {string} topic - Main research topic
 * @param {object[]} findings - All results gathered so far
 * @param {object} opts - { model, onEvent }
 * @returns {{ coveragePercent, needsMoreResearch, gaps[], contradictions[], additionalQueries[], qualityAssessment }}
 */
async function reflectOnFindings(topic, findings, opts = {}) {
    const onEvent = opts.onEvent || (() => {});

    // Compile findings summary for reflection
    const findingsSummary = findings
        .filter(f => f.success && !f.id?.startsWith('__')) // skip meta-results
        .map(f => {
            const sources = (f.sources || []).map(s => `  - ${s.title || s.url || 'unknown'}`).join('\n');
            return `### ${f.question || f.id}\n**Findings:** ${(f.findings || []).slice(0, 5).join('; ')}\n**Sources:**\n${sources || '  (none)'}\n**Confidence:** ${f.confidence || 'unknown'}`;
        })
        .join('\n\n---\n\n');

    const totalSources = findings.flatMap(f => f.sources || []).length;
    const totalFindings = findings.flatMap(f => f.findings || []).length;

    try {
        const data = await callLLM({
            systemPrompt: REFLECTION_SYSTEM_PROMPT,
            messages: [{
                role: 'user',
                content: `## Research Topic: ${topic}\n\n## Gathered Research (${totalFindings} findings from ${totalSources} sources)\n${findingsSummary}\n\nEvaluate the completeness and quality of this research.`
            }],
            model: opts.model || null,
            temperature: 0.2,
            maxTokens: 2000
        });

        const content = data.choices[0].message.content || '';
        const result = extractJSON(content);

        if (!result) {
            return {
                coveragePercent: 70,
                needsMoreResearch: false,
                gaps: [],
                contradictions: [],
                additionalQueries: [],
                qualityAssessment: { sourceReliability: 'medium', dataRecency: 'mixed', overallConfidence: 'medium' },
                reasoning: 'Could not parse reflection — proceeding with available findings'
            };
        }

        return {
            coveragePercent: result.coveragePercent || 70,
            needsMoreResearch: !!result.needsMoreResearch,
            gaps: result.gaps || [],
            contradictions: result.contradictions || [],
            additionalQueries: result.additionalQueries || [],
            qualityAssessment: result.qualityAssessment || {},
            reasoning: result.reasoning || ''
        };

    } catch (error) {
        console.error('[DeepResearch:Reflection] Failed:', error.message);
        // Fail-open: don't block the pipeline
        return {
            coveragePercent: 60,
            needsMoreResearch: false,
            gaps: [],
            contradictions: [],
            additionalQueries: [],
            qualityAssessment: {},
            reasoning: `Reflection failed: ${error.message} — proceeding with available findings`
        };
    }
}

module.exports = { reflectOnFindings };
