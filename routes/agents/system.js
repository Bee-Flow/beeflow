const express = require('express');
const path = require('path');
const fs = require('fs');
const agentStore = require('../../stores/agentStore');
const swarmStore = require('../../stores/swarmStore');
const browserAgentStore = require('../../stores/browserAgentStore');
const agentRuntime = require('../../core/agentRuntime');
const browserAgentRuntime = require('../../browser/orchestrator');
const groupChatStore = require('../../stores/groupChatStore');
const groupChatRuntime = require('../../agents/groupChat/runtime');
const terminalAgentStore = require('../../stores/terminalAgentStore');
const terminalAgentRuntime = require('../../terminal/orchestrator');
const containerManager = require('../../terminal/containerManager');
const securityAgentStore = require('../../stores/securityAgentStore');
const securityAgentRuntime = require('../../security/orchestrator');
const securityContainerManager = require('../../security/containerManager');
const { getAIConfig, getProviderForModel } = require('../../core/aiAgent');
const configStore = require('../../stores/configStore');
const { requirePermission } = require('../../auth');
const MemoryStore = require('../../stores/memoryStore');
const { resolveUserOrgIds } = require('../../auth');
const { getEffectiveUserId, getUserAuth } = require('../../utils/routeHelpers');
const llmClient = require('../../core/llmClient');

/**
 * Resolve a model string — handles tier: prefixes (e.g. 'tier:fast') and falls back to config default.
 */
async function resolveModelTier(rawModel, userOrgId = null) {
    if (rawModel && rawModel.startsWith('tier:')) {
        const tierName = rawModel.substring(5);
        let tiers = await configStore.getConfig('chat_model_tiers') || {};
        if (userOrgId) {
            const shield = await configStore.getConfig(`org_privacy_shield_${userOrgId}`);
            if (shield?.enabled && shield?.euModeEnabled) {
                const euTiers = await configStore.getConfig('chat_model_tiers_eu') || {};
                for (const [tn, euTier] of Object.entries(euTiers)) {
                    if (euTier?.modelId) tiers[tn] = { ...tiers[tn], ...euTier };
                }
            }
        }
        return tiers[tierName]?.modelId || tiers.fast?.modelId || rawModel;
    }
    if (!rawModel) {
        const globalConfig = await getAIConfig();
        return globalConfig.model;
    }
    return rawModel;
}
const userStore = require('../../stores/userStore');
const usageStore = require('../../stores/usageStore');
const { checkSubscriptionLimits: checkSubLimits, checkResourceLimits } = require('../../core/limits');
const { setupSSE, sendSSEError, persistAndTitle, getOrCreateAgentConversation } = require('../../core/sseHelpers');

const router = express.Router();

// Get System Agents (for Admin Dashboard)
router.get('/system', async (req, res) => {
    try {
        let agents = await agentStore.getSystemAgents();

        const orgIds = await resolveUserOrgIds(req);
        if (orgIds !== null) {
            agents = agents.filter(a => orgIds.has(a.organization_id));
        }

        res.json(agents);
    } catch (error) {
        console.error('Failed to get system agents:', error);
        res.status(500).json({ error: error.message });
    }
});

// System Prompt Designer SSE Streaming Endpoint (uses thinking tier)
router.post('/system/prompt-designer/stream', async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const { getSystemPromptDesignerAgent } = agentStore;
        const agent = await getSystemPromptDesignerAgent();

        if (!agent) {
            return res.status(404).json({ error: 'System Prompt Designer agent not found' });
        }

        // Resolve thinking tier model from chat_model_tiers config
        const tiers = await configStore.getConfig('chat_model_tiers') || {};
        const thinkingTier = tiers['thinking'] || tiers['smart'] || tiers['fast'] || {};
        const modelId = thinkingTier.modelId;

        if (!modelId) {
            return res.status(500).json({ error: 'No thinking/smart/fast tier model configured. Check your model tier configuration.' });
        }

        console.log(`[PromptDesigner] Using thinking tier model: ${modelId}`);

        // Set up SSE (matches setupSSE pattern — flushHeaders is required for Nginx Proxy Manager)
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const send = (event, data) => {
            if (!res.writableEnded) {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            }
        };

        const messages = [
            { role: 'system', content: agent.system_prompt },
            { role: 'user', content: message }
        ];

        // Stream via llmClient
        let fullContent = '';
        let thinkingContent = '';

        await llmClient.stream(modelId, messages, {
            maxTokens: thinkingTier.maxTokens || 16384,
            temperature: thinkingTier.temperature !== undefined ? thinkingTier.temperature : 0.7,
            reasoningEffort: thinkingTier.reasoningEffort || undefined,
            budgetTokens: thinkingTier.budgetTokens || undefined,
        }, (type, data) => {
            if (type === 'text') {
                fullContent += data.text;
                send('content', { text: data.text });
            } else if (type === 'thinking') {
                thinkingContent += data.text;
                send('thinking', { text: data.text });
            } else if (type === 'error') {
                send('error', data);
            } else if (type === 'done') {
                // done handled below
            }
        });

        send('done', { fullContent });
        res.end();

    } catch (error) {
        console.error('[PromptDesigner] Error:', error);
        if (res.headersSent) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// Conversation Starter Generator Endpoint
router.post('/system/conversation-starters/generate', async (req, res) => {
    try {
        const { agentName, agentDescription, systemPrompt } = req.body;

        const { getConversationStarterAgent } = agentStore;
        const agent = await getConversationStarterAgent();

        if (!agent) {
            return res.status(404).json({ error: 'Conversation Starter Generator agent not found' });
        }

        // Ignore hardcoded model and use the smart tier (with fallback to default)
        let modelToUse = await resolveModelTier('tier:smart');
        try {
            await getProviderForModel(modelToUse);
        } catch (_) {
            const globalConfig = await getAIConfig();
            modelToUse = globalConfig.model;
            console.warn(`[ConversationStarters] Smart tier model not found, falling back to: ${modelToUse}`);
        }
        console.log(`[ConversationStarters] Using model: ${modelToUse}`);

        const contextMessage = `Generate 4 conversation starters for an agent with:
- Name: ${agentName || '(not set)'}
- Description: ${agentDescription || '(not set)'}
- System Prompt: ${systemPrompt || '(empty)'}`;

        const messages = [
            { role: 'system', content: agent.system_prompt },
            { role: 'user', content: contextMessage }
        ];

        const result = await llmClient.chat(modelToUse, messages, { maxTokens: 500 });
        const content = result.content;

        // Parse the JSON array from the response
        try {
            const jsonMatch = content.match(/\[[\s\S]*\]/);
            const starters = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
            res.json({ starters: starters.slice(0, 4) });
        } catch (parseError) {
            console.error('[ConversationStarters] Parse error:', parseError);
            res.json({ starters: [] });
        }

    } catch (error) {
        console.error('[ConversationStarters] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Description Improver Endpoint
router.post('/system/description-improver/generate', async (req, res) => {
    try {
        const { agentName, currentDescription, systemPrompt } = req.body;

        const { getDescriptionImproverAgent } = agentStore;
        const agent = await getDescriptionImproverAgent();

        if (!agent) {
            return res.status(404).json({ error: 'Description Improver agent not found' });
        }

        // Ignore hardcoded model and use the smart tier (with fallback to default)
        let modelToUse = await resolveModelTier('tier:smart');
        try {
            await getProviderForModel(modelToUse);
        } catch (_) {
            const globalConfig = await getAIConfig();
            modelToUse = globalConfig.model;
            console.warn(`[DescriptionImprover] Smart tier model not found, falling back to: ${modelToUse}`);
        }
        console.log(`[DescriptionImprover] Using model: ${modelToUse}`);

        const promptContext = systemPrompt ? systemPrompt.substring(0, 1000) : '';

        const contextMessage = promptContext
            ? `Based on this system prompt, generate a concise role description:\n\n---\n${promptContext}\n---\n\nAgent name: ${agentName || 'Unknown'}\nCurrent description: ${currentDescription || '(none)'}`
            : `Generate a description for an agent named "${agentName || 'AI Assistant'}"${currentDescription ? `\nCurrent description to improve: "${currentDescription}"` : ''}`;

        const messages = [
            { role: 'system', content: agent.system_prompt },
            { role: 'user', content: contextMessage }
        ];

        const result = await llmClient.chat(modelToUse, messages, { maxTokens: 200 });
        const description = result.content;

        const cleanDescription = description.replace(/^["']|["']$/g, '').trim();
        res.json({ description: cleanDescription });

    } catch (error) {
        console.error('[DescriptionImprover] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Identity Improver Endpoint (generates both name and description)
router.post('/system/identity-improver/generate', async (req, res) => {
    try {
        const { currentName, currentDescription, systemPrompt } = req.body;

        if (!systemPrompt) {
            return res.status(400).json({ error: 'System prompt is required to generate identity' });
        }

        const { getIdentityImproverAgent } = agentStore;
        const agent = await getIdentityImproverAgent();

        if (!agent) {
            return res.status(404).json({ error: 'Identity Improver agent not found' });
        }

        // Ignore hardcoded model and use the smart tier (with fallback to default)
        let modelToUse = await resolveModelTier('tier:smart');
        try {
            await getProviderForModel(modelToUse);
        } catch (_) {
            // Smart tier model not available — fall back to global default
            const globalConfig = await getAIConfig();
            modelToUse = globalConfig.model;
            console.warn(`[IdentityImprover] Smart tier model not found, falling back to: ${modelToUse}`);
        }
        console.log(`[IdentityImprover] Using model: ${modelToUse}`);

        const contextMessage = `Based on this system prompt, generate a name and description:\n\n---\n${systemPrompt.substring(0, 1500)}\n---\n\nCurrent name: ${currentName || '(none)'}\nCurrent description: ${currentDescription || '(none)'}`;

        const messages = [
            { role: 'system', content: agent.system_prompt },
            { role: 'user', content: contextMessage }
        ];

        const result = await llmClient.chat(modelToUse, messages, { maxTokens: 200 });
        const content = result.content;

        try {
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const identity = JSON.parse(jsonMatch[0]);
                res.json({
                    avatar: identity.avatar || '',
                    name: identity.name || currentName || '',
                    description: identity.description || currentDescription || ''
                });
            } else {
                res.status(500).json({ error: 'Invalid response format' });
            }
        } catch (parseError) {
            console.error('[IdentityImprover] Parse Error:', parseError, content);
            res.status(500).json({ error: 'Failed to parse response' });
        }

    } catch (error) {
        console.error('[IdentityImprover] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
