/**
 * Agent Search Tools — Self-hosted AI-powered search integration
 *
 * Provides web search with reranking + KB hybrid search via the
 * Agent Search Engine service (Serper.dev + GPU inference).
 * URL is configured globally by admin in Admin → AI Config.
 */

const configStore = require('../stores/configStore');

/**
 * Tool definitions in OpenAI function-calling format.
 */
const AGENT_SEARCH_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'agent_search',
            description: `Search the web for current information via Google. Use this for up-to-date facts, news, weather, prices, technical docs, or to verify claims.

MODE SELECTION — pick the right mode for the task:
• "web" (DEFAULT) — fetches full pages + reranking, ~2s. Best answer quality. Use for most queries.
• "web_fast" — snippet-only, ~1s. Use ONLY for trivial one-fact lookups: a single date, price, or yes/no answer.
• "kb" — searches the internal knowledge base only. Use when user asks about uploaded documents.
• "auto" — tries KB first, falls back to web if KB confidence is low.

DETAIL LEVEL (web & web_fast modes) — controls how much content is returned:
• "basic" — compact 3-5 bullet summary (~300 tokens). Use for simple questions: "what year was X founded", weather, quick facts.
• "detailed" (DEFAULT) — key points + structured sections. Use for most queries: product comparisons, how-to, explanations.
• "highly_detailed" — maximum content preserved (~2000+ tokens). Use for deep research: technical docs, full articles, academic topics.
Note: In web_fast mode, all snippets are synthesized into one AI-written summary at the requested detail level.

QUERY TIPS:
• Write SHORT queries (2-6 words), like you would type into Google
• Good: "weer Amsterdam vandaag", "GPT-5 release date", "React useEffect cleanup"
• Bad: "what is the current weather forecast temperature in Amsterdam Netherlands today March 2026"
• Search in the user's language for local topics (Dutch for Dutch weather, etc.)
• If results are poor, retry with different keywords — don't repeat the same query

CITATION RULES:
• ALWAYS cite sources from the search results — NEVER invent URLs
• Use inline citations naturally: "It's 15°C in Amsterdam ([Weeronline](https://weeronline.nl/...))."
• Use the "cite_as" field from each result as the citation link
• End with a "**Sources**" section listing all used sources as numbered markdown links`,
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Short Google-style search query, 2-6 words. Use the language most likely to yield good results.'
                    },
                    mode: {
                        type: 'string',
                        enum: ['web', 'web_fast', 'kb', 'auto'],
                        description: 'web = full page content (default, best quality), web_fast = snippets only (only for trivial single-fact lookups), kb = knowledge base, auto = KB then web fallback'
                    },
                    max_results: {
                        type: 'integer',
                        description: 'Number of results to return (1-10). Default 5. Use 3 for quick lookups, 8-10 for thorough research.'
                    },
                    fetch_top_n: {
                        type: 'integer',
                        description: 'Pages to fetch full content for (1-5, default 2). Only used in "web" mode. Higher = richer content, slower response.'
                    },
                    detail_level: {
                        type: 'string',
                        enum: ['basic', 'detailed', 'highly_detailed'],
                        description: 'Content detail level (web & web_fast). "basic": compact 3-5 bullet summary for quick facts. "detailed" (default): key points + sections for standard queries. "highly_detailed": preserves maximum content for deep research, articles, or technical documentation.'
                    }
                },
                required: ['query']
            }
        }
    }
];

// ─── Tool Execution ────────────────────────────────────────────

async function executeAgentSearchTool(toolName, args) {
    const searchUrl = await configStore.getConfig('agent_search_url');
    if (!searchUrl) {
        return { error: 'Agent Search URL not configured. An admin can set it in Admin → AI Config.' };
    }

    if (toolName !== 'agent_search') {
        return { error: `Unknown Agent Search tool: ${toolName}` };
    }

    const { query, mode, max_results, fetch_top_n, detail_level } = args;
    if (!query) return { error: 'query is required' };

    // Load admin-configured defaults
    const defaults = (await configStore.getConfig('agent_search_defaults')) || {};

    // Determine effective mode
    const searchMode = ['web', 'web_fast', 'kb', 'auto'].includes(mode) ? mode : (defaults.mode || 'web');
    const isWebFast = searchMode === 'web_fast';

    // Use per-mode settings from new nested config, with fallbacks for old flat config
    const modeDefaults = isWebFast ? (defaults.web_fast || {}) : (defaults.web || {});
    const maxResults = Math.min(Math.max(parseInt(max_results) || parseInt(modeDefaults.max_results) || (isWebFast ? 10 : 5), 1), isWebFast ? 20 : 10);
    const fetchTopN = isWebFast ? 1 : Math.min(Math.max(parseInt(fetch_top_n) || parseInt(modeDefaults.fetch_top_n) || 3, 1), 5);
    const maxTokens = parseInt(modeDefaults.max_tokens_markdown) || (isWebFast ? 1500 : 2000);
    const includeCitations = defaults.include_citations !== false;

    // Resolve detail_level (only meaningful for web mode)
    const detailLevel = ['basic', 'detailed', 'highly_detailed'].includes(detail_level) ? detail_level : (modeDefaults.detail_level || 'detailed');

    console.log(`[AgentSearch] Searching: "${query}" (mode=${searchMode}, max=${maxResults}, fetch=${fetchTopN}, detail=${detailLevel})`);

    const apiUrl = searchUrl.replace(/\/$/, '');
    const payload = {
        query,
        mode: searchMode,
        web: { max_results: maxResults, fetch_top_n: fetchTopN },
        response: { include_citations: includeCitations, max_tokens_markdown: maxTokens, detail_level: detailLevel },
    };

    try {
        // Forward Serper API key if configured in admin dashboard
        const serperKey = await configStore.getSecret('serper_api_key');
        const headers = { 'Content-Type': 'application/json' };
        if (serperKey) headers['X-Serper-Key'] = serperKey;

        const response = await fetch(`${apiUrl}/tools/search`, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Agent Search API error (${response.status}): ${text}`);
        }

        const data = await response.json();
        const results = Array.isArray(data.results) ? data.results : [];

        console.log(`[AgentSearch] Found ${results.length} results (mode=${data.mode_used})`);

        // Format results as markdown for the LLM — much easier to read than JSON
        const sections = results.map((r, i) => {
            const title = r.title || 'Untitled';
            const url = r.url || '';
            const score = typeof r.score === 'number' ? Math.round(r.score * 100) : '';
            const content = r.markdown ? r.markdown.substring(0, maxTokens) : '';
            const header = url ? `### [${i + 1}. ${title}](${url})` : `### ${i + 1}. ${title}`;
            return `${header}${score ? ` (relevance: ${score}%)` : ''}\n\n${content}`;
        });

        // Build sources list for citation
        const sourcesList = results.map((r, i) => {
            const title = r.title || 'Untitled';
            const url = r.url || '';
            return url ? `[${i + 1}] [${title}](${url})` : `[${i + 1}] ${title}`;
        }).join('\n');

        const markdown = `# Search Results for: "${query}"
**Mode:** ${data.mode_used || searchMode} | **Results:** ${results.length}

---

${sections.join('\n\n---\n\n')}

---

## Sources
${sourcesList}

> **IMPORTANT:** Only cite URLs listed above. Never invent URLs. Use inline citations like [Source Title](url).`;

        return markdown;

    } catch (err) {
        console.error(`[AgentSearch] Error:`, err.message);
        return `Search failed: ${err.message}`;
    }
}

function isAgentSearchTool(toolName) {
    return toolName === 'agent_search';
}

module.exports = {
    AGENT_SEARCH_TOOLS,
    executeAgentSearchTool,
    isAgentSearchTool,
};
