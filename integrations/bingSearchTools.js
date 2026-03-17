/**
 * Bing Web Search Tools — Azure Bing Search API v7 integration
 *
 * Alternative search provider to the self-hosted Agent Search.
 * Uses GET https://api.bing.microsoft.com/v7.0/search
 * Requires a Bing Search API subscription key from Azure.
 */

const configStore = require('../stores/configStore');

// ─── Tool Execution ────────────────────────────────────────────

/**
 * Execute search using Bing Web Search API v7.
 * This is called instead of executeAgentSearchTool when the admin
 * has configured 'bing' as the search provider.
 */
async function executeBingSearchTool(toolName, args) {
    const bingKey = await configStore.getSecret('bing_search_key');
    if (!bingKey) {
        return { error: 'Bing Search API key not configured. An admin can set it in Admin → AI Config → Agent Search.' };
    }

    if (toolName !== 'agent_search') {
        return { error: `Unknown search tool: ${toolName}` };
    }

    const { query, max_results, detail_level } = args;
    if (!query) return { error: 'query is required' };

    const market = (await configStore.getConfig('bing_search_market')) || '';
    const maxResults = Math.min(Math.max(parseInt(max_results) || 5, 1), 10);

    console.log(`[BingSearch] Searching: "${query}" (count=${maxResults}, mkt=${market || 'auto'})`);

    try {
        const params = new URLSearchParams({
            q: query,
            count: String(maxResults),
            textDecorations: 'false',
            textFormat: 'Raw',
        });
        if (market) params.set('mkt', market);

        const response = await fetch(`https://api.bing.microsoft.com/v7.0/search?${params}`, {
            method: 'GET',
            headers: {
                'Ocp-Apim-Subscription-Key': bingKey,
            },
            signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Bing Search API error (${response.status}): ${text}`);
        }

        const data = await response.json();
        const webPages = data.webPages?.value || [];

        console.log(`[BingSearch] Found ${webPages.length} results`);

        if (webPages.length === 0) {
            return `# Search Results for: "${query}"\n**No results found.** Try different keywords.`;
        }

        // Format results as markdown for the LLM
        const sections = webPages.map((page, i) => {
            const title = page.name || 'Untitled';
            const url = page.url || '';
            const snippet = page.snippet || '';
            // If deepLinks available, include them
            const deepLinks = page.deepLinks
                ? '\n\n**Related pages:**\n' + page.deepLinks.slice(0, 3).map(dl => `- [${dl.name}](${dl.url})`).join('\n')
                : '';
            const header = url ? `### [${i + 1}. ${title}](${url})` : `### ${i + 1}. ${title}`;
            return `${header}\n\n${snippet}${deepLinks}`;
        });

        // Build sources list for citation
        const sourcesList = webPages.map((page, i) => {
            const title = page.name || 'Untitled';
            const url = page.url || '';
            return url ? `[${i + 1}] [${title}](${url})` : `[${i + 1}] ${title}`;
        }).join('\n');

        const markdown = `# Search Results for: "${query}"
**Provider:** Bing Web Search | **Results:** ${webPages.length}

---

${sections.join('\n\n---\n\n')}

---

## Sources
${sourcesList}

> **IMPORTANT:** Only cite URLs listed above. Never invent URLs. Use inline citations like [Source Title](url).`;

        return markdown;

    } catch (err) {
        console.error(`[BingSearch] Error:`, err.message);
        return `Search failed: ${err.message}`;
    }
}

module.exports = {
    executeBingSearchTool,
};
