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
const { chatCompletion } = require('../../core/llmClient');
const userStore = require('../../stores/userStore');
const usageStore = require('../../stores/usageStore');
const { checkSubscriptionLimits: checkSubLimits, checkResourceLimits } = require('../../core/limits');
const { setupSSE, sendSSEError, persistAndTitle, getOrCreateAgentConversation } = require('../../core/sseHelpers');

const router = express.Router();

// ============ Meta endpoints (must be before /:id routes) ============

// Get available components for tool selection
router.get('/meta/components', async (req, res) => {
    const components = await agentRuntime.getAvailableComponents();
    res.json(components);
});

// Get available models from ALL configured providers
router.get('/meta/models', async (req, res) => {
    try {
        const { getProviders } = require('../../core/aiAgent');
        const config = await getAIConfig();
        const providerData = await getProviders();

        let allModels = [];

        // Fetch models from all providers in parallel
        const results = await Promise.all(
            providerData.providers.map(async (provider) => {
                try {
                    const headers = { 'Content-Type': 'application/json' };
                    const apiKey = provider.apiKey;
                    if (apiKey) {
                        headers['Authorization'] = `Bearer ${apiKey}`;
                    }

                    let baseUrl = provider.url.replace(/\/$/, '');
                    let models = [];

                    // Standard OpenAI-compatible API
                    let modelsUrl = baseUrl.endsWith('/v1')
                        ? `${baseUrl}/models`
                        : `${baseUrl}/v1/models`;

                    const response = await fetch(modelsUrl, { headers });
                    if (response.ok) {
                        const data = await response.json();
                        models = (data.data || []).map(m => ({
                            id: m.id,
                            name: m.id,
                            providerId: provider.id,
                            providerName: provider.name
                        }));
                    }
                    return models;
                } catch (e) {
                    console.error(`Failed to fetch models from ${provider.name}:`, e.message);
                    return [];
                }
            })
        );

        allModels = results.flat();

        res.json({
            models: allModels,
            currentModel: config.model,
            defaultProviderId: providerData.defaultProviderId
        });
    } catch (error) {
        console.error('Failed to fetch models:', error);
        res.status(500).json({ error: error.message, models: [] });
    }
});


module.exports = router;
