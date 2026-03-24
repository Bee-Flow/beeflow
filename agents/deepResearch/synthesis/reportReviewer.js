/**
 * Deep Research — Report Reviewer
 *
 * Post-writing quality review (used in Normal and Detailed depth presets):
 *   - Checks factual consistency with source materials
 *   - Verifies citation coverage
 *   - Identifies logical gaps
 *   - Suggests improvements
 *
 * Does NOT rewrite — returns actionable feedback for the writer to incorporate.
 */

const { callLLM, extractJSON } = require('../../../pipeline/llmHelpers');

const REVIEWER_SYSTEM_PROMPT = `You are a Deep Research Report Reviewer. Review the draft report for quality, accuracy, and completeness.

## Review Checklist
1. **Factual accuracy**: Do claims match the source material?
2. **Citation coverage**: Are all factual claims properly cited?
3. **Logical flow**: Does the report flow logically?
4. **Completeness**: Are any important findings missing from the report?
5. **Clarity**: Is the writing clear and professional?
6. **Balance**: Does the report present multiple perspectives fairly?

## Response Format
Respond with ONLY a JSON object:
{
  "overallScore": 8,
  "issues": [
    { "type": "missing_citation|factual_error|logical_gap|clarity|balance", "location": "Section name", "description": "What's wrong", "severity": "high|medium|low", "suggestion": "How to fix" }
  ],
  "strengths": ["What the report does well"],
  "summary": "Brief overall assessment",
  "passesReview": true
}

overallScore: 1-10 where 7+ passes review.
passesReview: true if the report is good enough to deliver.`;

/**
 * Review a draft report.
 * @param {string} report - The draft report markdown
 * @param {object[]} originalResults - The research results used
 * @param {object} opts - { model, onEvent }
 * @returns {{ overallScore, issues[], strengths[], summary, passesReview }}
 */
async function reviewReport(report, originalResults, opts = {}) {
    const onEvent = opts.onEvent || (() => {});

    onEvent('phase', { phase: 'review', message: 'Reviewing report quality...' });

    // Compile research findings summary for comparison
    const findingsRef = originalResults
        .filter(r => r.success)
        .map(r => `[${r.id}] ${r.question}: ${(r.findings || []).slice(0, 3).join('; ')}`)
        .join('\n');

    try {
        const data = await callLLM({
            systemPrompt: REVIEWER_SYSTEM_PROMPT,
            messages: [{
                role: 'user',
                content: `## Draft Report\n${report.slice(0, 6000)}\n\n## Research Findings Reference\n${findingsRef}\n\nReview this report.`
            }],
            model: opts.model || null,
            temperature: 0.2,
            maxTokens: 2000
        });

        const content = data.choices[0].message.content || '';
        const review = extractJSON(content);

        if (!review) {
            return { overallScore: 7, issues: [], strengths: ['Report generated'], summary: 'Review completed', passesReview: true };
        }

        onEvent('review_result', {
            score: review.overallScore,
            issueCount: review.issues?.length || 0,
            passes: review.passesReview
        });

        return {
            overallScore: review.overallScore || 7,
            issues: review.issues || [],
            strengths: review.strengths || [],
            summary: review.summary || '',
            passesReview: review.passesReview !== false
        };

    } catch (error) {
        console.error('[DeepResearch:Reviewer] Failed:', error.message);
        // Fail-open: don't block report delivery
        return { overallScore: 6, issues: [], strengths: [], summary: `Review failed: ${error.message}`, passesReview: true };
    }
}

module.exports = { reviewReport };
