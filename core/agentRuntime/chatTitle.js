/**
 * Chat title generation — uses a fast model to create conversation titles
 */
const { resolveModelId } = require('../aiAgent');
const agentStore = require('../../stores/agentStore');
const configStore = require('../../stores/configStore');

async function generateChatTitle(userMessage, modelOverride = null, userOrgId = null) {
    const titleAgent = await agentStore.getTitleGeneratorAgent();

    // Resolve model — handle tier: prefix (e.g. 'tier:fast' → actual model ID from config)
    let rawModel = modelOverride || titleAgent?.model;
    let model;
    if (rawModel && rawModel.startsWith('tier:')) {
        const tierName = rawModel.substring(5);
        let tiers = await configStore.getConfig('chat_model_tiers') || {};
        // EU mode override
        if (userOrgId) {
            const shield = await configStore.getConfig(`org_privacy_shield_${userOrgId}`);
            if (shield?.enabled && shield?.euModeEnabled) {
                const euTiers = await configStore.getConfig('chat_model_tiers_eu') || {};
                const mergedTiers = { ...tiers };
                for (const [tn, euTier] of Object.entries(euTiers)) {
                    if (euTier?.modelId) {
                        mergedTiers[tn] = { ...mergedTiers[tn], ...euTier };
                    }
                }
                tiers = mergedTiers;
            }
        }
        model = tiers[tierName]?.modelId || tiers.fast?.modelId || resolveModelId(globalConfig?.model);
    } else {
        // Not tier-based — resolve via tier:fast for title generation
        const fallbackTiers = await configStore.getConfig('chat_model_tiers') || {};
        model = fallbackTiers.fast?.modelId || resolveModelId(rawModel) || resolveModelId(globalConfig?.model);
    }
    const systemPrompt = titleAgent?.system_prompt || 'Generate a very short title (max 5 words, max 40 characters) for this chat based on the user message. Only output the title, nothing else. No quotes.';

    try {
        console.log('[generateChatTitle] Calling LLM with model:', model);
        const llmClient = require('./llmClient');
        const title = await llmClient.generateTitle(
            model,
            typeof userMessage === 'string' ? userMessage.slice(0, 500) : userMessage,
            systemPrompt
        );
        console.log('[generateChatTitle] Generated title:', title);
        return title.slice(0, 40);
    } catch (error) {
        console.error('[generateChatTitle] Error:', error.message);
    }

    return 'New Chat';
}

module.exports = { generateChatTitle };
