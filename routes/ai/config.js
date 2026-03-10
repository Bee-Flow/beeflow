/**
 * AI Config Routes
 * 
 * Handles: config CRUD, model tiers, system prompt, tool enablement, model costs
 */

const express = require('express');
const router = express.Router();
const {
    getAIConfig,
    saveAIConfig,
} = require('../../core/aiAgent');
const configStore = require('../../stores/configStore');

// Authentication middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ─── General AI Config ───────────────────────────────────────────

router.get('/config', async (req, res) => {
    const config = await getAIConfig();
    res.json({
        url: config.url,
        model: config.model,
        apiKey: !!config.apiKey,
        hasApiKey: !!config.apiKey,
        hasMistralKey: !!(await configStore.getSecret('mistral_api_key')),
        hasOpenaiKey: !!(await configStore.getSecret('openai_api_key')),
        hasClaudeKey: !!(await configStore.getSecret('claude_api_key')),
        hasGoogleKey: !!(await configStore.getSecret('google_api_key')),
        hasElevenLabsKey: !!(await configStore.getSecret('elevenlabs_api_key')),
        hasGoogleVertexProject: !!(await configStore.getConfig('google_vertex_project')),
        googleVertexLocation: await configStore.getConfig('google_vertex_location') || 'europe-west4',
        hasGoogleVertexServiceAccountKey: !!(await configStore.getSecret('google_vertex_service_account_key')),
        hasAzureEndpoint: !!(await configStore.getConfig('azure_endpoint')),
        hasAzureApiKey: !!(await configStore.getSecret('azure_api_key')),
        azureApiVersion: await configStore.getConfig('azure_api_version') || '2025-04-01-preview',
        hasFirefliesKey: !!(req.session?.user?.id && (await configStore.getSecret(`fireflies_api_key_user_${req.session.user.id}`))),
        hasAgentSearchUrl: !!(await configStore.getConfig('agent_search_url')),
        agentSearchUrl: await configStore.getConfig('agent_search_url') || '',
        hasSerperKey: !!(await configStore.getSecret('serper_api_key')),
        hasGoogleMapsKey: !!(await configStore.getSecret('google_maps_api_key')),
        hasLinkedInConfig: !!(await configStore.getSecret('linkedin_client_id')) && !!(await configStore.getSecret('linkedin_client_secret')),
        regexGuardrails: config.regexGuardrails || null,
        llamaGuardConfig: config.llamaGuardConfig || null,
        embeddingModel: config.embeddingModel || null,
        embeddingProviderId: config.embeddingProviderId || null,
        allowedModelsByAgentType: await configStore.getConfig('allowedModelsByAgentType') || {},
        directChatRegexGuardrails: await configStore.getConfig('direct_chat_regex_guardrails') || null
    });
});

router.post('/config', async (req, res) => {
    const { url, model, apiKey, mistralApiKey, openaiApiKey, claudeApiKey, googleApiKey, elevenlabsApiKey, googleVertexProject, googleVertexLocation, googleVertexServiceAccountKey, azureEndpoint, azureApiKey, azureApiVersion, agentSearchUrl, lakeraApiKey, regexGuardrails, llamaGuardConfig, embeddingModel, embeddingProviderId, allowedModelsByAgentType, directChatRegexGuardrails, googleMapsApiKey, serperApiKey } = req.body;
    const existing = await getAIConfig();

    if (allowedModelsByAgentType !== undefined) {
        await configStore.setConfig('allowedModelsByAgentType', allowedModelsByAgentType);
    }
    if (directChatRegexGuardrails !== undefined) {
        await configStore.setConfig('direct_chat_regex_guardrails', directChatRegexGuardrails);
    }
    if (agentSearchUrl !== undefined) {
        await configStore.setConfig('agent_search_url', agentSearchUrl || '');
    }
    if (serperApiKey !== undefined) {
        await configStore.setSecret('serper_api_key', serperApiKey || '');
    }
    if (googleMapsApiKey !== undefined) {
        await configStore.setSecret('google_maps_api_key', googleMapsApiKey || '');
    }
    if (req.body.linkedinClientId !== undefined) {
        await configStore.setSecret('linkedin_client_id', req.body.linkedinClientId || '');
    }
    if (req.body.linkedinClientSecret !== undefined) {
        await configStore.setSecret('linkedin_client_secret', req.body.linkedinClientSecret || '');
    }

    const success = await saveAIConfig({
        url: url !== undefined ? url : existing.url,
        model: model !== undefined ? model : existing.model,
        apiKey: apiKey !== undefined ? apiKey : undefined,
        mistralApiKey: mistralApiKey !== undefined ? mistralApiKey : undefined,
        openaiApiKey: openaiApiKey !== undefined ? openaiApiKey : undefined,
        claudeApiKey: claudeApiKey !== undefined ? claudeApiKey : undefined,
        googleApiKey: googleApiKey !== undefined ? googleApiKey : undefined,
        elevenlabsApiKey: elevenlabsApiKey !== undefined ? elevenlabsApiKey : undefined,
        googleVertexProject: googleVertexProject !== undefined ? googleVertexProject : undefined,
        googleVertexLocation: googleVertexLocation !== undefined ? googleVertexLocation : undefined,
        googleVertexServiceAccountKey: googleVertexServiceAccountKey !== undefined ? googleVertexServiceAccountKey : undefined,
        azureEndpoint: azureEndpoint !== undefined ? azureEndpoint : undefined,
        azureApiKey: azureApiKey !== undefined ? azureApiKey : undefined,
        azureApiVersion: azureApiVersion !== undefined ? azureApiVersion : undefined,
        lakeraApiKey: lakeraApiKey !== undefined ? lakeraApiKey : undefined,
        regexGuardrails: regexGuardrails !== undefined ? regexGuardrails : existing.regexGuardrails,
        llamaGuardConfig: llamaGuardConfig !== undefined ? llamaGuardConfig : existing.llamaGuardConfig,
        embeddingModel: embeddingModel !== undefined ? embeddingModel : existing.embeddingModel,
        embeddingProviderId: embeddingProviderId !== undefined ? embeddingProviderId : existing.embeddingProviderId,
    });

    if (success) {
        res.json({ success: true });
    } else {
        res.status(500).json({ error: 'Failed to save configuration' });
    }
});

// ─── Model Tier Config ───────────────────────────────────────────

router.get('/config/chat-models', requireAuth, async (req, res) => {
    try {
        const tiers = await configStore.getConfig('chat_model_tiers') || {
            fast: { modelId: '', label: 'Fast' },
            thinking: { modelId: '', label: 'Thinking' },
            writer: { modelId: '', label: 'Writer' },
            pro: { modelId: '', label: 'Pro' }
        };
        if (!tiers.writer) tiers.writer = { modelId: '', label: 'Writer' };
        res.json(tiers);
    } catch (e) {
        console.error('Failed to get chat model tiers:', e);
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

router.post('/config/chat-models', requireAuth, async (req, res) => {
    try {
        const { fast, thinking, writer, pro } = req.body;
        const tiers = {
            fast: fast || { modelId: '', label: 'Fast' },
            thinking: thinking || { modelId: '', label: 'Thinking' },
            writer: writer || { modelId: '', label: 'Writer' },
            pro: pro || { modelId: '', label: 'Pro' }
        };
        await configStore.setConfig('chat_model_tiers', tiers);
        res.json({ success: true });
    } catch (e) {
        console.error('Failed to save chat model tiers:', e);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// ─── EU Model Tier Config ────────────────────────────────────────

router.get('/config/chat-models-eu', requireAuth, async (req, res) => {
    try {
        const tiers = await configStore.getConfig('chat_model_tiers_eu') || {
            fast: { modelId: '', label: 'Fast' },
            thinking: { modelId: '', label: 'Thinking' },
            writer: { modelId: '', label: 'Writer' },
            pro: { modelId: '', label: 'Pro' }
        };
        res.json(tiers);
    } catch (e) {
        console.error('Failed to get EU chat model tiers:', e);
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

router.post('/config/chat-models-eu', requireAuth, async (req, res) => {
    try {
        const { fast, thinking, writer, pro } = req.body;
        const tiers = {
            fast: fast || { modelId: '', label: 'Fast' },
            thinking: thinking || { modelId: '', label: 'Thinking' },
            writer: writer || { modelId: '', label: 'Writer' },
            pro: pro || { modelId: '', label: 'Pro' }
        };
        await configStore.setConfig('chat_model_tiers_eu', tiers);
        res.json({ success: true });
    } catch (e) {
        console.error('Failed to save EU chat model tiers:', e);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// ─── Direct Chat System Prompt ───────────────────────────────────

router.get('/config/direct-chat', requireAuth, async (req, res) => {
    try {
        const prompt = await configStore.getConfig('direct_chat_system_prompt') || '';
        res.json({ systemPrompt: prompt });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

router.post('/config/direct-chat', requireAuth, async (req, res) => {
    try {
        const { systemPrompt } = req.body;
        await configStore.setConfig('direct_chat_system_prompt', systemPrompt || '');
        res.json({ success: true });
    } catch (e) {
        console.error('Failed to save direct chat config:', e);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// ─── Per-Tier Tool Enablement ────────────────────────────────────

router.get('/config/direct-chat-tools', requireAuth, async (req, res) => {
    try {
        const tierTools = await configStore.getConfig('direct_chat_tier_tools') || {};
        res.json(tierTools);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

router.post('/config/direct-chat-tools', requireAuth, async (req, res) => {
    try {
        await configStore.setConfig('direct_chat_tier_tools', req.body || {});
        res.json({ success: true });
    } catch (e) {
        console.error('Failed to save direct chat tools config:', e);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// ─── Per-Tier Tool Parameter Overrides ───────────────────────────

router.get('/config/direct-chat-tool-params', requireAuth, async (req, res) => {
    try {
        const params = await configStore.getConfig('direct_chat_tier_tool_params') || {};
        res.json(params);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

router.post('/config/direct-chat-tool-params', requireAuth, async (req, res) => {
    try {
        await configStore.setConfig('direct_chat_tier_tool_params', req.body || {});
        res.json({ success: true });
    } catch (e) {
        console.error('Failed to save direct chat tool params config:', e);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// ─── Model Costs ─────────────────────────────────────────────────

router.get('/model-costs', async (req, res) => {
    try {
        const { getAllModelCosts } = require('../../core/modelCosts');
        res.json(getAllModelCosts());
    } catch (e) {
        console.error('[AI] model-costs error:', e);
        res.json({});
    }
});

router.get('/model-costs-config', requireAuth, async (req, res) => {
    try {
        const { getModelCostsForConfig } = require('../../core/modelCosts');
        const { getAllCachedModelIds } = require('../../core/aiAgent');
        const usageStore = require('../../stores/usageStore');

        // Provider models come as { id, providerName, providerType } objects
        const providerModels = getAllCachedModelIds();
        // Used models come as plain strings (model IDs from usage log)
        const usedModels = await usageStore.getUsageModels().map(id => ({ id, providerName: null }));

        // Combine: provider models first (with provider info), then used models
        const allEntries = [...providerModels, ...usedModels];

        res.json({ costs: getModelCostsForConfig(allEntries) });
    } catch (e) {
        console.error('[AI] model-costs-config error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/model-costs', requireAuth, async (req, res) => {
    try {
        const { setModelCost, resetModelCost } = require('../../core/modelCosts');
        const { costs } = req.body;

        if (!Array.isArray(costs)) {
            return res.status(400).json({ error: 'costs must be an array of { model, input, output }' });
        }

        let updated = 0;
        let reset = 0;
        for (const c of costs) {
            if (!c.model) continue;
            if (c.reset) {
                resetModelCost(c.model);
                reset++;
            } else if (c.input != null && c.output != null) {
                setModelCost(c.model, c.input, c.output);
                updated++;
            }
        }

        console.log(`[AI] Model costs updated: ${updated} set, ${reset} reset`);
        res.json({ success: true, updated, reset });
    } catch (e) {
        console.error('[AI] model-costs save error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ─── Rendering Config ────────────────────────────────────────────

router.get('/rendering-config', requireAuth, async (req, res) => {
    try {
        const userStore = require('../../stores/userStore');
        const orgs = await userStore.getAllOrganizations ? userStore.getAllOrganizations() : [];
        const org = orgs[0] || {};

        const rendering = {
            companyName: org.name || '',
            companyLogo: org.logo || '',
            companyDetails: org.tagline || '',
            companyAddress: org.address || '',
            companyEmail: org.email || '',
            companyPhone: org.phone || '',
            companyChamber: org.kvk || '',
            companyVat: org.vat || '',
            companyWebsite: org.website || '',
            defaultFooterText: org.footerText || ''
        };
        res.json(rendering);
    } catch (error) {
        console.error('Failed to load rendering config:', error);
        res.status(500).json({ error: error.message });
    }
});

// ─── Per-User Settings (Fireflies key etc.) ──────────────────────

router.get('/user-settings', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const isGoogleUser = req.session.oauthProvider === 'google';
    const enabledApps = await configStore.getConfig(`enabled_apps_user_${userId}`);

    // Load org-level enabled integrations
    let orgEnabledIntegrations = null;
    try {
        const userStore = require('../../stores/userStore');
        const currentUser = await userStore.getUser(userId);
        if (currentUser?.organizationId) {
            const org = await userStore.getOrganization(currentUser.organizationId);
            if (org?.enabledIntegrations) {
                orgEnabledIntegrations = typeof org.enabledIntegrations === 'string'
                    ? JSON.parse(org.enabledIntegrations)
                    : org.enabledIntegrations;
            } else {
                // Org uses defaults — load global default integrations
                const globalDefaults = await configStore.getConfig('default_org_integrations');
                if (globalDefaults) {
                    orgEnabledIntegrations = typeof globalDefaults === 'string'
                        ? JSON.parse(globalDefaults)
                        : globalDefaults;
                }
            }
        }
    } catch (e) { /* ignore */ }

    // Check n8n config for org
    let hasN8nConfig = false;
    try {
        const userStore = require('../../stores/userStore');
        const currentUser = await userStore.getUser(userId);
        if (currentUser?.organizationId) {
            const n8nUrl = await configStore.getConfig(`n8n_url_org_${currentUser.organizationId}`);
            const n8nKey = await configStore.getSecret(`n8n_api_key_org_${currentUser.organizationId}`);
            hasN8nConfig = !!(n8nUrl && n8nKey);
        }
    } catch (e) { /* ignore */ }

    res.json({
        hasFirefliesKey: !!(await configStore.getSecret(`fireflies_api_key_user_${userId}`)),
        hasYouTrackConfig: !!(await configStore.getSecret(`youtrack_url_user_${userId}`)) && !!(await configStore.getSecret(`youtrack_token_user_${userId}`)),
        hasGammaKey: !!(await configStore.getSecret(`gamma_api_key_user_${userId}`)),
        hasLinkedInConfig: !!(await configStore.getSecret('linkedin_client_id')) && !!(await configStore.getSecret('linkedin_client_secret')),
        isGoogleUser,
        enabledApps: enabledApps || null,
        orgEnabledIntegrations,
        hasN8nConfig,
        hasGoogleMapsKey: !!(await configStore.getSecret('google_maps_api_key')),
    });
});

router.post('/user-settings', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const { firefliesApiKey, youtrackUrl, youtrackToken, gammaApiKey, enabledApps } = req.body;

    if (firefliesApiKey !== undefined) {
        await configStore.setSecret(`fireflies_api_key_user_${userId}`, firefliesApiKey || '');
    }

    if (gammaApiKey !== undefined) {
        await configStore.setSecret(`gamma_api_key_user_${userId}`, gammaApiKey || '');
    }



    if (youtrackUrl !== undefined) {
        await configStore.setSecret(`youtrack_url_user_${userId}`, youtrackUrl || '');
    }
    if (youtrackToken !== undefined) {
        await configStore.setSecret(`youtrack_token_user_${userId}`, youtrackToken || '');
    }

    if (enabledApps !== undefined) {
        await configStore.setConfig(`enabled_apps_user_${userId}`, enabledApps);
    }



    res.json({ success: true });
});

// ─── AI Regex Generator ──────────────────────────────────────────
router.post('/generate-regex', requireAuth, async (req, res) => {
    // Only admins can generate regex rules
    if (!req.session.isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
    }

    const { prompt, modelTier } = req.body;
    if (!prompt || !prompt.trim()) {
        return res.status(400).json({ error: 'Prompt is required' });
    }

    try {
        const { REGEX_GENERATOR_AGENT_ID } = require('../../stores/agentStore');
        const agentStore = require('../../stores/agentStore');
        const { getProviderForModel } = require('../../core/aiAgent');
        const { getAdapter } = require('../../core/providers');
        const { sanitizeMessages } = require('../../utils/messageUtils');
        const { REGEX_GENERATOR_TOOLS, executeRegexGeneratorTool, deduplicateCollections } = require('../../integrations/regexGeneratorTools');

        const agent = await agentStore.getAgent(REGEX_GENERATOR_AGENT_ID);
        if (!agent) throw new Error('Regex Generator agent not found');

        // Resolve model from tier config (same system as direct chat)
        const tiers = await configStore.getConfig('chat_model_tiers') || {};
        const resolvedTier = modelTier || 'fast';
        const tier = tiers[resolvedTier] || {};
        const modelToUse = tier.modelId || (await getAIConfig()).model || 'mistral-small-latest';
        const config = await getProviderForModel(modelToUse);

        const messages = [
            { role: 'system', content: agent.system_prompt },
            { role: 'user', content: prompt.trim() }
        ];

        // Tool execution loop
        let iterations = 0;
        const maxIterations = 10;

        while (iterations < maxIterations) {
            iterations++;

            const adapter = getAdapter(null, config.url);
            let apiUrl = config.url.replace(/\/$/, '');
            if (!apiUrl.endsWith('/v1')) apiUrl = `${apiUrl}/v1`;

            const requestBody = adapter.buildRequestBody(modelToUse, sanitizeMessages(messages), {
                maxTokens: 4000,
                temperature: 0.7,
                tools: REGEX_GENERATOR_TOOLS,
                toolChoice: 'auto',
            });

            const headers = { 'Content-Type': 'application/json' };
            if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

            const response = await fetch(`${apiUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`AI API error: ${response.status} - ${error}`);
            }

            const data = await response.json();
            const choice = data.choices?.[0];
            if (!choice) throw new Error('No response from AI');

            const assistantMsg = choice.message;
            messages.push(assistantMsg);

            // If no tool calls, we're done
            if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
                await deduplicateCollections();
                const aiConfig = await getAIConfig();
                const regexGuardrails = aiConfig.regexGuardrails || { rules: [], collections: [] };
                return res.json({
                    success: true,
                    message: assistantMsg.content || 'Rules generated',
                    regexGuardrails
                });
            }

            // Execute tool calls
            for (const toolCall of assistantMsg.tool_calls) {
                const toolName = toolCall.function.name;
                const toolArgs = JSON.parse(toolCall.function.arguments || '{}');
                console.log(`[RegexGenerator] Executing tool: ${toolName}`, toolArgs);

                const result = await executeRegexGeneratorTool(toolName, toolArgs);
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(result)
                });
            }
        }

        // Max iterations reached
        await deduplicateCollections();
        const aiConfig = await getAIConfig();
        const regexGuardrails = aiConfig.regexGuardrails || { rules: [], collections: [] };
        res.json({
            success: true,
            message: 'Rules generated (max iterations reached)',
            regexGuardrails
        });
    } catch (err) {
        console.error('[RegexGenerator] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── n8n Integration Config (Org-Level) ───────────────────────

const { listActiveWebhookWorkflows } = require('../../integrations/n8nTools');

// Helper: get org ID from session
async function getOrgId(req) {
    const userId = req.session.user?.id;
    if (!userId) return null;
    const userStore = require('../../stores/userStore');
    const user = await userStore.getUser(userId);
    return user?.organizationId || null;
}

// Helper: check if user is org admin
async function requireOrgAdminForN8n(req, res, next) {
    const userId = req.session.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const userStore = require('../../stores/userStore');
    const user = await userStore.getUser(userId);
    // Super admins (global) can always manage n8n config
    if (req.session.isAdmin) {
        req.orgId = user?.organizationId || null;
        return next();
    }
    if (!user?.organizationId) return res.status(403).json({ error: 'No organization' });
    if (user.orgRole !== 'admin' && user.orgRole !== 'org_admin') return res.status(403).json({ error: 'Org admin required' });
    req.orgId = user.organizationId;
    next();
}

// GET /ai/n8n/config — get org's n8n connection config
router.get('/n8n/config', requireAuth, async (req, res) => {
    try {
        const orgId = await getOrgId(req);
        if (!orgId) return res.json({ configured: false });

        const n8nUrl = await configStore.getConfig(`n8n_url_org_${orgId}`);
        const hasApiKey = !!(await configStore.getSecret(`n8n_api_key_org_${orgId}`));
        const workflowsConfig = await configStore.getConfig(`n8n_workflows_org_${orgId}`);

        const workflows = workflowsConfig
            ? (typeof workflowsConfig === 'string' ? JSON.parse(workflowsConfig) : workflowsConfig)
            : [];

        res.json({
            configured: !!(n8nUrl && hasApiKey),
            n8nUrl: n8nUrl || '',
            hasApiKey,
            workflows,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Agent Search Defaults ─────────────────────────────────────

router.get('/agent-search/defaults', requireAuth, async (req, res) => {
    try {
        const stored = await configStore.getConfig('agent_search_defaults');
        // Support new per-mode format OR migrate old flat format
        const defaults = stored && stored.web ? stored : {
            mode: stored?.mode || 'web',
            include_citations: stored?.include_citations !== false,
            web: {
                max_results: stored?.max_results || 5,
                fetch_top_n: stored?.fetch_top_n || 3,
                max_tokens_markdown: stored?.max_tokens_markdown || 2000,
                detail_level: 'detailed',
            },
            web_fast: {
                max_results: 10,
                max_tokens_markdown: 1500,
                detail_level: 'detailed',
            },
        };
        res.json(defaults);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch Agent Search defaults' });
    }
});

router.put('/agent-search/defaults', requireAuth, async (req, res) => {
    try {
        const { mode, include_citations, web, web_fast } = req.body;
        await configStore.setConfig('agent_search_defaults', {
            mode: ['web', 'web_fast', 'kb', 'auto'].includes(mode) ? mode : 'web',
            include_citations: include_citations !== false,
            web: {
                max_results: Math.min(Math.max(parseInt(web?.max_results) || 5, 1), 10),
                fetch_top_n: Math.min(Math.max(parseInt(web?.fetch_top_n) || 3, 1), 5),
                max_tokens_markdown: Math.min(Math.max(parseInt(web?.max_tokens_markdown) || 2000, 500), 5000),
                detail_level: ['basic', 'detailed', 'highly_detailed'].includes(web?.detail_level) ? web.detail_level : 'detailed',
            },
            web_fast: {
                max_results: Math.min(Math.max(parseInt(web_fast?.max_results) || 10, 1), 20),
                max_tokens_markdown: Math.min(Math.max(parseInt(web_fast?.max_tokens_markdown) || 1500, 500), 5000),
                detail_level: ['basic', 'detailed', 'highly_detailed'].includes(web_fast?.detail_level) ? web_fast.detail_level : 'detailed',
            },
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to save Agent Search defaults' });
    }
});

// PUT /ai/n8n/config — save org's n8n URL + API key (org admin only)
router.put('/n8n/config', requireOrgAdminForN8n, async (req, res) => {
    try {
        const { n8nUrl, apiKey } = req.body;
        const orgId = req.orgId;

        if (n8nUrl !== undefined) {
            await configStore.setConfig(`n8n_url_org_${orgId}`, n8nUrl || null);
        }
        if (apiKey) {
            await configStore.setSecret(`n8n_api_key_org_${orgId}`, apiKey);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /ai/n8n/workflows — live-fetch active webhook workflows from n8n
router.get('/n8n/workflows', requireOrgAdminForN8n, async (req, res) => {
    try {
        const orgId = req.orgId;
        const n8nUrl = await configStore.getConfig(`n8n_url_org_${orgId}`);
        const apiKey = await configStore.getSecret(`n8n_api_key_org_${orgId}`);

        if (!n8nUrl || !apiKey) {
            return res.status(400).json({ error: 'n8n URL and API key must be configured first' });
        }

        const workflows = await listActiveWebhookWorkflows(n8nUrl, apiKey);
        res.json({ workflows });
    } catch (err) {
        console.error('[n8n] Error fetching workflows:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// PUT /ai/n8n/workflows — save selected workflows + input/output config (org admin only)
router.put('/n8n/workflows', requireOrgAdminForN8n, async (req, res) => {
    try {
        const { workflows } = req.body;
        const orgId = req.orgId;

        await configStore.setConfig(`n8n_workflows_org_${orgId}`, workflows || []);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;


