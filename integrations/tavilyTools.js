/**
 * Tavily Search Tools — Built-in web search integration
 *
 * Provides web search capabilities using the Tavily API.
 * API key is configured globally by admin in the Integrations panel.
 */

const configStore = require('../stores/configStore');

const TAVILY_API_URL = 'https://api.tavily.com/search';

/**
 * Tool definitions in OpenAI function-calling format.
 */
const TAVILY_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the web for current information. Use this when you need to find up-to-date information, verify facts, research topics, or answer questions about recent events. Returns relevant web pages with titles, URLs, and content snippets.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'The search query — be specific and descriptive for best results'
                    },
                    search_depth: {
                        type: 'string',
                        enum: ['fast', 'basic', 'advanced'],
                        description: 'Search depth: "fast" for quick lookups, "basic" for standard, "advanced" for thorough research'
                    },
                    max_results: {
                        type: 'integer',
                        description: 'Maximum number of results to return (1-10, default 5)'
                    },
                    topic: {
                        type: 'string',
                        enum: ['general', 'news', 'finance'],
                        description: 'Topic category to bias results (default: general)'
                    },
                    include_raw_content: {
                        type: 'boolean',
                        description: 'Include full page content in results (default: false, use for deep analysis)'
                    }
                },
                required: ['query']
            }
        }
    }
];

// ─── API Client ────────────────────────────────────────────────

async function tavilyRequest(apiKey, payload) {
    const response = await fetch(TAVILY_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Tavily API error (${response.status}): ${text}`);
    }

    return response.json();
}

// ─── Tool Execution ────────────────────────────────────────────

async function executeTavilyTool(toolName, args) {
    const apiKey = await configStore.getSecret('tavily_api_key');
    if (!apiKey) {
        return { error: 'Tavily API key not configured. An admin can set it in Admin → Integrations.' };
    }

    if (toolName !== 'web_search') {
        return { error: `Unknown Tavily tool: ${toolName}` };
    }

    // Load admin-configured defaults
    const defaults = (await configStore.getConfig('tavily_defaults')) || {};

    const { query, search_depth, max_results, topic, include_raw_content } = args;
    if (!query) return { error: 'query is required' };

    const maxResults = Math.min(Math.max(parseInt(max_results) || parseInt(defaults.max_results) || 5, 1), 20);
    const validDepths = ['fast', 'basic', 'advanced'];
    const searchDepth = validDepths.includes(search_depth) ? search_depth : (validDepths.includes(defaults.search_depth) ? defaults.search_depth : 'basic');
    const validTopics = ['general', 'news', 'finance'];
    const topicValue = validTopics.includes(topic) ? topic : (validTopics.includes(defaults.topic) ? defaults.topic : 'general');
    const scoreThreshold = parseFloat(args.scoreThreshold) || parseFloat(defaults.scoreThreshold) || 0.5;
    const rawContent = include_raw_content !== undefined ? !!include_raw_content : (defaults.include_raw_content !== undefined ? !!defaults.include_raw_content : false);

    console.log(`[Tavily] Searching: "${query}" (depth=${searchDepth}, max=${maxResults}, topic=${topicValue})`);

    const data = await tavilyRequest(apiKey, {
        query,
        search_depth: searchDepth,
        max_results: maxResults,
        topic: topicValue,
        include_answer: true,
        include_raw_content: rawContent,
        include_favicon: true,
    });

    // Post-filter by relevance score
    const results = Array.isArray(data.results) ? data.results : [];
    const filteredResults = results
        .filter(r => (typeof r?.score === 'number' ? r.score : 0) >= scoreThreshold)
        .slice(0, maxResults)
        .map(r => ({
            title: r.title,
            url: r.url,
            content: r.content,
            score: r.score,
            ...(r.raw_content ? { raw_content: r.raw_content.substring(0, 3000) } : {}),
        }));

    console.log(`[Tavily] Found ${filteredResults.length} results (of ${results.length} total)`);

    return {
        query: data.query || query,
        answer: data.answer || null,
        results: filteredResults,
        images: data.images || [],
        resultCount: filteredResults.length,
    };
}

function isTavilyTool(toolName) {
    return toolName === 'web_search';
}

module.exports = {
    TAVILY_TOOLS,
    executeTavilyTool,
    isTavilyTool,
};
