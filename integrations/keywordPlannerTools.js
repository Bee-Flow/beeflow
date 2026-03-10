/**
 * Keyword Planner Tools — Google Ads KeywordPlanIdeaService integration
 * 
 * Uses the existing Google OAuth access token plus per-user Google Ads
 * credentials (developer token, manager account ID, customer ID).
 */

const configStore = require('../stores/configStore');

const GOOGLE_ADS_API_VERSION = 'v16';

/**
 * Tool definitions in OpenAI function-calling format.
 */
const KEYWORD_PLANNER_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'keyword_planner_generate_ideas',
            description: 'Generate keyword ideas using Google Ads Keyword Planner. Returns search volume, competition level, and CPC estimates for related keywords. Use this when the user wants to research keywords, find search volume data, discover new keyword opportunities, or plan SEO/advertising strategies.',
            parameters: {
                type: 'object',
                properties: {
                    keywords: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Seed keywords to generate ideas from, e.g. ["ai agent", "chatbot development"]'
                    },
                    url: {
                        type: 'string',
                        description: 'Optional URL to discover keywords from page content (alternative to keyword seeds)'
                    },
                    language: {
                        type: 'string',
                        description: 'Language constant code, e.g. "1000" for English, "1013" for Dutch, "1001" for French, "1003" for German. Default: "1000"'
                    },
                    geoTarget: {
                        type: 'string',
                        description: 'Geographic target constant code, e.g. "2840" for United States, "2528" for Netherlands, "2826" for United Kingdom. Default: "2840"'
                    },
                    includeAverageCpc: {
                        type: 'boolean',
                        description: 'Whether to include average CPC bid estimates. Default: true'
                    }
                },
                required: []
            }
        }
    }
];

// ─── API Client ────────────────────────────────────────────────

async function getAccessToken(session) {
    // Use the existing Google OAuth access token from the session
    const accessToken = session?.accessToken;
    if (!accessToken) {
        throw new Error('Not connected to Google — user must log in with Google SSO');
    }
    return accessToken;
}

async function getAdsCredentials(userId) {
    const developerToken = await configStore.getSecret(`gads_developer_token_user_${userId}`);
    const managerId = await configStore.getSecret(`gads_manager_id_user_${userId}`);
    const customerId = await configStore.getSecret(`gads_customer_id_user_${userId}`);

    if (!developerToken || !managerId || !customerId) {
        return null;
    }

    return {
        developerToken,
        managerId: managerId.replace(/-/g, ''),
        customerId: customerId.replace(/-/g, ''),
    };
}

async function generateKeywordIdeas(accessToken, credentials, args) {
    const {
        keywords = [],
        url,
        language = '1000',
        geoTarget = '2840',
        includeAverageCpc = true,
    } = args;

    const apiUrl = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${credentials.customerId}:generateKeywordIdeas`;

    const requestBody = {
        language: `languageConstants/${language}`,
        geoTargetConstants: [`geoTargetConstants/${geoTarget}`],
    };

    // Set the seed type
    if (keywords.length > 0 && url) {
        requestBody.keywordAndUrlSeed = { keywords, url };
    } else if (url) {
        requestBody.urlSeed = { url };
    } else if (keywords.length > 0) {
        requestBody.keywordSeed = { keywords };
    } else {
        throw new Error('Either keywords or url must be provided');
    }

    if (includeAverageCpc) {
        requestBody.historicalMetricsOptions = { includeAverageCpc: true };
    }

    console.log(`[KeywordPlanner] Generating ideas for: ${keywords.join(', ') || url}`);

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
            'developer-token': credentials.developerToken,
            'login-customer-id': credentials.managerId,
        },
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        const errorText = await response.text();
        let errorMsg;
        try {
            const errorJson = JSON.parse(errorText);
            errorMsg = errorJson.error?.message || errorJson.error?.status || errorText;
        } catch {
            errorMsg = errorText;
        }
        throw new Error(`Google Ads API error ${response.status}: ${errorMsg}`);
    }

    return response.json();
}

// ─── Tool Execution ────────────────────────────────────────────

async function executeKeywordPlannerTool(toolName, args, session, userId) {
    if (toolName !== 'keyword_planner_generate_ideas') {
        return { error: `Unknown Keyword Planner tool: ${toolName}` };
    }

    const credentials = await getAdsCredentials(userId);
    if (!credentials) {
        return { error: 'Google Ads credentials not configured. Add Developer Token, Manager ID, and Customer ID in Settings → Keyword Planner.' };
    }

    let accessToken;
    try {
        accessToken = await getAccessToken(session);
    } catch (err) {
        return { error: err.message };
    }

    try {
        const data = await generateKeywordIdeas(accessToken, credentials, args);

        const results = (data.results || []).map(idea => {
            const metrics = idea.keywordIdeaMetrics || {};
            return {
                keyword: idea.text,
                avgMonthlySearches: parseInt(metrics.avgMonthlySearches || '0', 10),
                competition: (metrics.competition || 'UNSPECIFIED').replace('COMPETITION_LEVEL_', ''),
                competitionIndex: parseInt(metrics.competitionIndex || '0', 10),
                lowCpc: metrics.lowTopOfPageBidMicros
                    ? parseInt(metrics.lowTopOfPageBidMicros, 10) / 1000000
                    : null,
                highCpc: metrics.highTopOfPageBidMicros
                    ? parseInt(metrics.highTopOfPageBidMicros, 10) / 1000000
                    : null,
            };
        });

        console.log(`[KeywordPlanner] Got ${results.length} keyword ideas`);

        return {
            results,
            totalCount: results.length,
            language: args.language || '1000',
            geoTarget: args.geoTarget || '2840',
        };
    } catch (err) {
        console.error('[KeywordPlanner] Error:', err.message);
        return { error: err.message };
    }
}

function isKeywordPlannerTool(toolName) {
    return toolName === 'keyword_planner_generate_ideas';
}

module.exports = {
    KEYWORD_PLANNER_TOOLS,
    executeKeywordPlannerTool,
    isKeywordPlannerTool,
};
