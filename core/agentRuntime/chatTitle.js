/**
 * Chat title generation — uses a fast model to create conversation titles
 */
const agentStore = require('../../stores/agentStore');
const { resolveModelWithGlobalFallback } = require('../modelResolver');

async function generateChatTitle(userMessage, modelOverride = null, userOrgId = null, userId = null) {
    const titleAgent = await agentStore.getSystemAgent('system-title-generator');

    // Resolve model — modelOverride takes precedence, then agent config, then tier:fast
    const rawModel = modelOverride || titleAgent?.model;
    const model = await resolveModelWithGlobalFallback(rawModel, { userOrgId, userId, fallbackTier: 'fast' });

    if (!model) {
        console.error('[generateChatTitle] No model resolved for title generation');
        return 'New Chat';
    }

    const systemPrompt = titleAgent?.system_prompt ||
        'Generate a very short title (max 5 words, max 40 characters) for this chat based on the user message. Only output the title, nothing else. No quotes.';

    try {
        console.log('[generateChatTitle] Calling LLM with model:', model);
        const llmClient = require('../llmClient');
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
