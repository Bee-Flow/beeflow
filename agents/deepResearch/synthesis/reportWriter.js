/**
 * Deep Research — Report Writer
 *
 * Writes the final research report with inline citations.
 * Supports streaming via SSE events.
 *
 * Modes:
 *   - Single-pass (Fast preset): one LLM call, full report
 *   - Multi-pass (Normal/Detailed): section-by-section with focused context
 */

const { getAIConfig, getProviderForModel } = require('../../../core/aiAgent');

const WRITER_SYSTEM_PROMPT = `You are a Deep Research Report Writer. Write a comprehensive, well-structured research report based on the provided findings.

## Writing Guidelines
1. Use clear, professional language
2. Structure with markdown headers (##, ###)
3. Include inline citations as [N] referencing the source list
4. Start with an executive summary
5. Present findings with supporting evidence
6. Highlight key insights and trends
7. Note any limitations or contradictions in the research
8. End with conclusions and key takeaways

## Formatting
- Use markdown formatting (headers, bold, lists, tables where appropriate)
- Use inline citations: "According to research [1], ..."
- Include statistics and specific data points where available
- Keep paragraphs focused and readable

Write a thorough, publication-quality report. Do NOT include a separate sources/references section — that will be appended automatically.`;

/**
 * Write the full report (streaming via SSE events).
 *
 * @param {string} topic - Research topic
 * @param {object[]} results - Flattened research results
 * @param {object} citationManager - CitationManager instance
 * @param {object} opts - { model, outline, onEvent }
 * @returns {Promise<string>} Full markdown report
 */
async function writeReport(topic, results, citationManager, opts = {}) {
    const onEvent = opts.onEvent || (() => {});

    onEvent('phase', { phase: 'writing', message: 'Writing research report...' });

    // Build the findings context for the writer
    const findingsText = results
        .filter(r => r.success)
        .map(r => {
            const sourceCitations = (r.sources || []).map(s => {
                const citId = citationManager.getCitation(s.url || s.title);
                return `${s.title} ${citId}`;
            }).join(', ');

            return `### ${r.question || r.id}\n**Findings:**\n${(r.findings || []).map(f => `- ${f}`).join('\n')}\n**Sources:** ${sourceCitations || 'none'}\n**Summary:** ${r.summary || 'N/A'}`;
        })
        .join('\n\n---\n\n');

    // Include outline if available (detailed mode)
    let outlineContext = '';
    if (opts.outline) {
        outlineContext = `\n\n## Report Structure (follow this outline):\n${opts.outline.sections.map(s =>
            `- **${s.title}**: ${s.description}${s.subsections?.length ? '\n' + s.subsections.map(ss => `  - ${ss.title}: ${ss.description}`).join('\n') : ''}`
        ).join('\n')}`;
    }

    // Reference list for the writer to use
    const sourceList = citationManager.getAllSources().map(s =>
        `[${s.id}] ${s.title}${s.url ? ` — ${s.url}` : ''}`
    ).join('\n');

    const userPrompt = `## Research Topic: ${topic}\n\n## Available Sources\n${sourceList}\n\n## Collected Research\n${findingsText}${outlineContext}\n\nWrite a comprehensive research report using the findings above. Use [N] inline citations referencing the source numbers.`;

    // Stream the report
    const baseConfig = await getAIConfig();
    const useModel = opts.model || baseConfig.model;
    const providerConfig = await getProviderForModel(useModel);

    let apiUrl = providerConfig.url.replace(/\/+$/, '');
    if (!apiUrl.endsWith('/v1')) apiUrl = `${apiUrl}/v1`;

    const headers = { 'Content-Type': 'application/json' };
    if (providerConfig.apiKey) headers['Authorization'] = `Bearer ${providerConfig.apiKey}`;

    const response = await fetch(`${apiUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: useModel,
            messages: [
                { role: 'system', content: WRITER_SYSTEM_PROMPT },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.4,
            max_tokens: 8000,
            stream: true
        })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Report Writer API error: ${response.status} - ${error}`);
    }

    // Stream chunks
    let fullReport = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

        for (const line of lines) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                    fullReport += delta;
                    onEvent('chunk', { content: delta });
                }
            } catch { /* skip malformed */ }
        }
    }

    return fullReport;
}

module.exports = { writeReport };
