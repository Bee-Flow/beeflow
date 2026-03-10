/**
 * LinkedIn Tools — AI tool for posting to LinkedIn
 * 
 * Allows the AI to draft LinkedIn posts for user approval.
 * Posts require user approval via the frontend before being published.
 */

const configStore = require('../stores/configStore');

const LINKEDIN_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'linkedin_create_post',
            description: 'Create a LinkedIn post on behalf of the user. The post text will be shown to the user for approval before being published. Write engaging, professional content suitable for LinkedIn.',
            parameters: {
                type: 'object',
                properties: {
                    text: {
                        type: 'string',
                        description: 'The text content of the LinkedIn post. Supports mentions, hashtags, and emoji. Maximum 3000 characters.'
                    }
                },
                required: ['text']
            }
        }
    }
];

/**
 * Execute a LinkedIn tool call.
 */
async function executeLinkedInTool(toolName, args, session) {
    if (toolName !== 'linkedin_create_post') {
        throw new Error(`Unknown LinkedIn tool: ${toolName}`);
    }

    const { text } = args;
    if (!text?.trim()) {
        return { error: 'Post text is required' };
    }

    if (text.length > 3000) {
        return { error: 'Post text exceeds LinkedIn\'s 3000 character limit' };
    }

    // Return draft for user approval (same pattern as calendar)
    return {
        _action: 'linkedin_draft',
        draft: {
            action: 'post',
            text: text.trim()
        },
        message: `LinkedIn post prepared (${text.trim().length} characters). Waiting for user approval.`
    };
}

/**
 * Execute a LinkedIn action after user approval.
 */
async function executeLinkedInAction(action, session) {
    const userId = session?.user?.id;
    if (!userId) throw new Error('Not authenticated');

    const accessToken = await configStore.getSecret(`linkedin_access_token_user_${userId}`);
    const personId = await configStore.getConfig(`linkedin_person_id_user_${userId}`);

    if (!accessToken || !personId) {
        throw new Error('Not connected to LinkedIn. Connect via Settings → Integrations.');
    }

    if (action.action === 'post') {
        const postRes = await fetch('https://api.linkedin.com/rest/posts', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'X-Restli-Protocol-Version': '2.0.0',
                'LinkedIn-Version': '202501'
            },
            body: JSON.stringify({
                author: `urn:li:person:${personId}`,
                commentary: action.text,
                visibility: 'PUBLIC',
                distribution: {
                    feedDistribution: 'MAIN_FEED',
                    targetEntities: [],
                    thirdPartyDistributionChannels: []
                },
                lifecycleState: 'PUBLISHED',
                isReshareDisabledByAuthor: false
            })
        });

        if (!postRes.ok) {
            const errText = await postRes.text();
            throw new Error(`LinkedIn post failed: ${postRes.status} ${errText}`);
        }

        return { success: true, message: 'Post published on LinkedIn!' };
    }

    throw new Error(`Unknown LinkedIn action: ${action.action}`);
}

function isLinkedInTool(toolName) {
    return toolName === 'linkedin_create_post';
}

module.exports = {
    LINKEDIN_TOOLS,
    executeLinkedInTool,
    executeLinkedInAction,
    isLinkedInTool
};
