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
        hasMinimaxKey: !!(await configStore.getSecret('minimax_api_key')),
        googleVertexLocation: await configStore.getConfig('google_vertex_location') || 'europe-west4',
        hasGoogleVertexServiceAccountKey: !!(await configStore.getSecret('google_vertex_service_account_key')),
        hasAzureEndpoint: !!(await configStore.getConfig('azure_endpoint')),
        hasAzureApiKey: !!(await configStore.getSecret('azure_api_key')),
        azureApiVersion: await configStore.getConfig('azure_api_version') || '2025-04-01-preview',
        azureModels: await configStore.getConfig('azure_models') || '',
        hasFirefliesKey: !!(req.session?.user?.id && (await configStore.getSecret(`fireflies_api_key_user_${req.session.user.id}`))),
        hasAgentSearchUrl: !!process.env.SEARCH_SERVICE_URL || !!(await configStore.getConfig('agent_search_url')),
        agentSearchUrl: process.env.SEARCH_SERVICE_URL || await configStore.getConfig('agent_search_url') || '',
        hasSerperKey: !!(await configStore.getSecret('serper_api_key')),
        searchProvider: await configStore.getConfig('search_provider') || 'agent-search',
        hasBingSearchKey: !!(await configStore.getSecret('bing_search_key')),
        bingSearchMarket: await configStore.getConfig('bing_search_market') || '',
        hasGoogleMapsKey: !!(await configStore.getSecret('google_maps_api_key')),
        hasLinkedInConfig: !!(await configStore.getSecret('linkedin_client_id')) && !!(await configStore.getSecret('linkedin_client_secret')),
        regexGuardrails: config.regexGuardrails || null,
        llamaGuardConfig: config.llamaGuardConfig || null,
        moderationProvider: config.moderationProvider || 'llamaguard',
        hasAzureContentSafetyEndpoint: !!(await configStore.getConfig('azure_content_safety_endpoint')),
        hasAzureContentSafetyKey: !!(await configStore.getSecret('azure_content_safety_key')),
        azureContentSafetySeverityThreshold: config.azureContentSafetySeverityThreshold ?? 2,
        azureContentSafetyCategories: config.azureContentSafetyCategories || null,
        piiDetectionEnabled: config.piiDetectionEnabled || false,
        piiDetectionCategories: config.piiDetectionCategories || null,
        piiDetectionConfidenceThreshold: config.piiDetectionConfidenceThreshold ?? 0.7,
        piiDetectionScope: config.piiDetectionScope || { userInput: true, agentOutput: false },
        piiDetectionAction: config.piiDetectionAction || 'block',
        embeddingModel: config.embeddingModel || null,
        embeddingProviderId: config.embeddingProviderId || null,
        allowedModelsByAgentType: await configStore.getConfig('allowedModelsByAgentType') || {},
        directChatRegexGuardrails: await configStore.getConfig('direct_chat_regex_guardrails') || null,
        // Azure Document Intelligence
        hasAzureDocIntelligenceEndpoint: !!(await configStore.getConfig('azure_doc_intelligence_endpoint')),
        hasAzureDocIntelligenceKey: !!(await configStore.getSecret('azure_doc_intelligence_key')),
        // Azure OpenAI Embeddings (for Azure-native KB pipeline)
        hasAzureOpenaiEmbeddingEndpoint: !!(await configStore.getConfig('azure_openai_embedding_endpoint')),
        hasAzureOpenaiEmbeddingKey: !!(await configStore.getSecret('azure_openai_embedding_key')),
        azureOpenaiEmbeddingModel: await configStore.getConfig('azure_openai_embedding_model') || 'text-embedding-3-small',
        useAzureDocProcessing: !!(await configStore.getConfig('use_azure_doc_processing')),
        // Azure AI Speech (Meeting Transcription)
        hasAzureSpeechKey: !!(await configStore.getSecret('azure_speech_key')),
        azureSpeechRegion: await configStore.getConfig('azure_speech_region') || '',
        transcriptionProvider: await configStore.getConfig('transcription_provider') || 'voxtral',
        // WhisperX self-hosted
        hasWhisperxUrl: !!(await configStore.getSecret('whisperx_url')),
        hasWhisperxToken: !!(await configStore.getSecret('whisperx_token')),
        // Azure Cohere Reranker
        hasAzureRerankerEndpoint: !!(await configStore.getConfig('azure_reranker_endpoint')),
        hasAzureRerankerKey: !!(await configStore.getSecret('azure_reranker_key')),
        azureRerankerModel: await configStore.getConfig('azure_reranker_model') || 'Cohere-rerank-v4.0-fast',
        // Service Email (Gmail SMTP)
        hasServiceEmail: !!(await configStore.getConfig('service_email_address')) && !!(await configStore.getSecret('service_email_password')),
        serviceEmailAddress: await configStore.getConfig('service_email_address') || '',
        serviceEmailDisplayName: await configStore.getConfig('service_email_display_name') || '',
        // Feature flags (runtime-togglable)
        notebooksEnabled: await (async () => {
            const val = await configStore.getConfig('feature_notebooks_enabled');
            return val !== false && val !== 'false';
        })(),
        projectsEnabled: await (async () => {
            const val = await configStore.getConfig('feature_projects_enabled');
            return val !== false && val !== 'false';
        })(),
        askAiEnabled: await (async () => {
            const val = await configStore.getConfig('feature_ask_ai_enabled');
            return val !== false && val !== 'false';
        })(),
        exportEnabled: await (async () => {
            const val = await configStore.getConfig('feature_export_enabled');
            return val !== false && val !== 'false';
        })(),
        openInNotebookEnabled: await (async () => {
            const val = await configStore.getConfig('feature_open_in_notebook_enabled');
            return val !== false && val !== 'false';
        })(),
        notebooksMenuEnabled: await (async () => {
            const val = await configStore.getConfig('feature_notebooks_menu_enabled');
            return val !== false && val !== 'false';
        })(),
    });
});

router.post('/config', requireAuth, async (req, res) => {
    if (!req.session.isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    const { url, model, apiKey, mistralApiKey, openaiApiKey, claudeApiKey, googleApiKey, elevenlabsApiKey, minimaxApiKey, googleVertexProject, googleVertexLocation, googleVertexServiceAccountKey, azureEndpoint, azureApiKey, azureApiVersion, azureModels, agentSearchUrl, lakeraApiKey, regexGuardrails, llamaGuardConfig, moderationProvider, azureContentSafetyEndpoint, azureContentSafetyKey, azureContentSafetySeverityThreshold, azureContentSafetyCategories, piiDetectionEnabled, piiDetectionCategories, piiDetectionConfidenceThreshold, piiDetectionScope, piiDetectionAction, embeddingModel, embeddingProviderId, allowedModelsByAgentType, directChatRegexGuardrails, googleMapsApiKey, serperApiKey, azureDocIntelligenceEndpoint, azureDocIntelligenceKey, azureOpenaiEmbeddingEndpoint, azureOpenaiEmbeddingKey, azureOpenaiEmbeddingModel, useAzureDocProcessing, serviceEmailAddress, serviceEmailPassword, serviceEmailDisplayName, azureSpeechKey, azureSpeechRegion, transcriptionProvider, notebooksEnabled, projectsEnabled, askAiEnabled, exportEnabled, openInNotebookEnabled, notebooksMenuEnabled, azureRerankerEndpoint, azureRerankerKey, azureRerankerModel } = req.body;
    const existing = await getAIConfig();

    if (allowedModelsByAgentType !== undefined) {
        await configStore.setConfig('allowedModelsByAgentType', allowedModelsByAgentType);
    }
    if (directChatRegexGuardrails !== undefined) {
        await configStore.setConfig('direct_chat_regex_guardrails', directChatRegexGuardrails);
    }
    if (azureModels !== undefined) {
        await configStore.setConfig('azure_models', azureModels || '');
    }
    if (azureContentSafetyEndpoint !== undefined) {
        await configStore.setConfig('azure_content_safety_endpoint', azureContentSafetyEndpoint || '');
    }
    if (azureContentSafetyKey !== undefined) {
        await configStore.setSecret('azure_content_safety_key', azureContentSafetyKey || '');
    }
    if (agentSearchUrl !== undefined) {
        await configStore.setConfig('agent_search_url', agentSearchUrl || '');
    }
    if (serperApiKey !== undefined) {
        await configStore.setSecret('serper_api_key', serperApiKey || '');
    }
    if (req.body.searchProvider !== undefined) {
        await configStore.setConfig('search_provider', req.body.searchProvider || 'agent-search');
    }
    if (req.body.bingSearchKey !== undefined) {
        await configStore.setSecret('bing_search_key', req.body.bingSearchKey || '');
    }
    if (req.body.bingSearchMarket !== undefined) {
        await configStore.setConfig('bing_search_market', req.body.bingSearchMarket || '');
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
    // Azure Document Intelligence
    if (azureDocIntelligenceEndpoint !== undefined) {
        await configStore.setConfig('azure_doc_intelligence_endpoint', azureDocIntelligenceEndpoint || '');
    }
    if (azureDocIntelligenceKey !== undefined) {
        await configStore.setSecret('azure_doc_intelligence_key', azureDocIntelligenceKey || '');
    }
    // Azure OpenAI Embeddings
    if (azureOpenaiEmbeddingEndpoint !== undefined) {
        await configStore.setConfig('azure_openai_embedding_endpoint', azureOpenaiEmbeddingEndpoint || '');
    }
    if (azureOpenaiEmbeddingKey !== undefined) {
        await configStore.setSecret('azure_openai_embedding_key', azureOpenaiEmbeddingKey || '');
    }
    if (azureOpenaiEmbeddingModel !== undefined) {
        await configStore.setConfig('azure_openai_embedding_model', azureOpenaiEmbeddingModel || 'text-embedding-3-small');
    }
    if (useAzureDocProcessing !== undefined) {
        await configStore.setConfig('use_azure_doc_processing', useAzureDocProcessing ? 'true' : '');
    }
    // Azure AI Speech (Meeting Transcription)
    if (azureSpeechKey !== undefined) {
        await configStore.setSecret('azure_speech_key', azureSpeechKey || '');
    }
    if (azureSpeechRegion !== undefined) {
        const region = (azureSpeechRegion || '').trim().toLowerCase();
        if (region && !/^[a-z0-9-]{2,32}$/.test(region)) {
            return res.status(400).json({ error: 'Invalid Azure Speech region format. Use a region like "westeurope" or "eastus".' });
        }
        await configStore.setConfig('azure_speech_region', region);
    }
    // WhisperX self-hosted
    if (req.body.whisperxUrl !== undefined) {
        const rawUrl = (req.body.whisperxUrl || '').trim();
        if (rawUrl) {
            try {
                const p = new URL(rawUrl);
                if (!['http:', 'https:'].includes(p.protocol)) throw new Error('bad protocol');
            } catch (_) {
                return res.status(400).json({ error: 'WhisperX URL must be a valid http:// or https:// address.' });
            }
        }
        await configStore.setSecret('whisperx_url', rawUrl);
    }
    if (req.body.whisperxToken !== undefined) {
        await configStore.setSecret('whisperx_token', req.body.whisperxToken || '');
    }
    if (transcriptionProvider !== undefined) {
        const allowed = ['voxtral', 'azure', 'whisperx', 'whisper_azure'];
        if (transcriptionProvider && !allowed.includes(transcriptionProvider)) {
            return res.status(400).json({ error: `Invalid transcription provider. Allowed: ${allowed.join(', ')}` });
        }
        await configStore.setConfig('transcription_provider', transcriptionProvider || 'voxtral');
    }
    // Service Email (Gmail SMTP)
    if (serviceEmailAddress !== undefined) {
        await configStore.setConfig('service_email_address', serviceEmailAddress || '');
    }
    if (serviceEmailPassword !== undefined) {
        await configStore.setSecret('service_email_password', serviceEmailPassword || '');
    }
    if (serviceEmailDisplayName !== undefined) {
        await configStore.setConfig('service_email_display_name', serviceEmailDisplayName || '');
    }
    // Feature flags (runtime-togglable)
    if (notebooksEnabled !== undefined) {
        await configStore.setConfig('feature_notebooks_enabled', notebooksEnabled ? true : false);
    }
    if (projectsEnabled !== undefined) {
        await configStore.setConfig('feature_projects_enabled', projectsEnabled ? true : false);
    }
    if (askAiEnabled !== undefined) {
        await configStore.setConfig('feature_ask_ai_enabled', askAiEnabled ? true : false);
    }
    if (exportEnabled !== undefined) {
        await configStore.setConfig('feature_export_enabled', exportEnabled ? true : false);
    }
    if (openInNotebookEnabled !== undefined) {
        await configStore.setConfig('feature_open_in_notebook_enabled', openInNotebookEnabled ? true : false);
    }
    if (notebooksMenuEnabled !== undefined) {
        await configStore.setConfig('feature_notebooks_menu_enabled', notebooksMenuEnabled ? true : false);
    }
    // Azure Cohere Reranker
    if (azureRerankerEndpoint !== undefined) {
        await configStore.setConfig('azure_reranker_endpoint', azureRerankerEndpoint || '');
    }
    if (azureRerankerKey !== undefined) {
        await configStore.setSecret('azure_reranker_key', azureRerankerKey || '');
    }
    if (azureRerankerModel !== undefined) {
        await configStore.setConfig('azure_reranker_model', azureRerankerModel || 'Cohere-rerank-v4.0-fast');
    }

    const success = await saveAIConfig({
        url: url !== undefined ? url : existing.url,
        model: model !== undefined ? model : existing.model,
        apiKey: apiKey !== undefined ? apiKey : undefined,
        mistralApiKey: mistralApiKey !== undefined ? mistralApiKey : undefined,
        openaiApiKey: openaiApiKey !== undefined ? openaiApiKey : undefined,
        claudeApiKey: claudeApiKey !== undefined ? claudeApiKey : undefined,
        googleApiKey: googleApiKey !== undefined ? googleApiKey : undefined,
        minimaxApiKey: minimaxApiKey !== undefined ? minimaxApiKey : undefined,
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
        moderationProvider: moderationProvider !== undefined ? moderationProvider : existing.moderationProvider,
        azureContentSafetySeverityThreshold: azureContentSafetySeverityThreshold !== undefined ? azureContentSafetySeverityThreshold : existing.azureContentSafetySeverityThreshold,
        azureContentSafetyCategories: azureContentSafetyCategories !== undefined ? azureContentSafetyCategories : existing.azureContentSafetyCategories,
        piiDetectionEnabled: piiDetectionEnabled !== undefined ? piiDetectionEnabled : existing.piiDetectionEnabled,
        piiDetectionCategories: piiDetectionCategories !== undefined ? piiDetectionCategories : existing.piiDetectionCategories,
        piiDetectionConfidenceThreshold: piiDetectionConfidenceThreshold !== undefined ? piiDetectionConfidenceThreshold : existing.piiDetectionConfidenceThreshold,
        piiDetectionScope: piiDetectionScope !== undefined ? piiDetectionScope : existing.piiDetectionScope,
        piiDetectionAction: piiDetectionAction !== undefined ? piiDetectionAction : existing.piiDetectionAction,
        embeddingModel: embeddingModel !== undefined ? embeddingModel : existing.embeddingModel,
        embeddingProviderId: embeddingProviderId !== undefined ? embeddingProviderId : existing.embeddingProviderId,
    });

    if (success) {
        res.json({ success: true });
    } else {
        res.status(500).json({ error: 'Failed to save configuration' });
    }
});

// ─── Delete API Key ──────────────────────────────────────────────

// Whitelist of keys that can be deleted via this endpoint
const DELETABLE_KEYS = [
    'openai_api_key', 'claude_api_key', 'google_api_key', 'mistral_api_key',
    'elevenlabs_api_key', 'minimax_api_key', 'serper_api_key', 'google_maps_api_key',
    'google_vertex_service_account_key', 'azure_api_key', 'azure_content_safety_key',
    'azure_doc_intelligence_key', 'azure_openai_embedding_key', 'azure_speech_key',
    'bing_search_key', 'linkedin_client_id', 'linkedin_client_secret',
    'service_email_password', 'whisperx_url', 'whisperx_token',
    'azure_reranker_key',
];

router.delete('/config/key/:keyName', requireAuth, async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { keyName } = req.params;
        if (!DELETABLE_KEYS.includes(keyName)) {
            return res.status(400).json({ error: `Key "${keyName}" cannot be deleted via this endpoint` });
        }

        await configStore.deleteConfig(keyName);
        console.log(`[Config] Admin deleted key: ${keyName}`);
        res.json({ success: true, deleted: keyName });
    } catch (err) {
        console.error('[Config] Delete key error:', err);
        res.status(500).json({ error: 'Failed to delete key' });
    }
});

// Also support deleting non-secret config keys (like vertex project/location)
const DELETABLE_CONFIG_KEYS = [
    'google_vertex_project', 'google_vertex_location',
    'azure_endpoint', 'azure_api_version', 'azure_models',
    'azure_content_safety_endpoint', 'azure_doc_intelligence_endpoint',
    'azure_openai_embedding_endpoint', 'azure_openai_embedding_model',
    'azure_speech_region', 'agent_search_url', 'service_email_address',
    'service_email_display_name', 'azure_reranker_endpoint', 'azure_reranker_model',
];

router.delete('/config/setting/:keyName', requireAuth, async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { keyName } = req.params;
        if (!DELETABLE_CONFIG_KEYS.includes(keyName)) {
            return res.status(400).json({ error: `Setting "${keyName}" cannot be deleted via this endpoint` });
        }

        await configStore.deleteConfig(keyName);
        console.log(`[Config] Admin deleted setting: ${keyName}`);
        res.json({ success: true, deleted: keyName });
    } catch (err) {
        console.error('[Config] Delete setting error:', err);
        res.status(500).json({ error: 'Failed to delete setting' });
    }
});

// ─── Test Service Email ──────────────────────────────────────────

router.post('/config/test-service-email', requireAuth, async (req, res) => {
    try {
        const { testRecipient } = req.body;
        if (!testRecipient || !testRecipient.trim()) {
            return res.status(400).json({ error: 'Test recipient email is required' });
        }

        const { sendServiceEmail } = require('../../utils/emailService');
        const result = await sendServiceEmail({
            to: testRecipient.trim(),
            subject: 'BeeFlow — Test Service Email',
            html: [
                '<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">',
                '  <h2 style="color: #1a1a1a; margin-bottom: 8px;">✅ Service Email Configured</h2>',
                '  <p style="color: #555; font-size: 14px; line-height: 1.6;">',
                '    This is a test email from your BeeFlow platform. If you received this, your service email is configured correctly.',
                '  </p>',
                '  <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;" />',
                '  <p style="color: #999; font-size: 12px;">Sent by BeeFlow Service Email</p>',
                '</div>',
            ].join('\n'),
        });

        if (result.success) {
            res.json({ success: true, messageId: result.messageId });
        } else {
            res.status(500).json({ error: result.error || 'Failed to send test email' });
        }
    } catch (err) {
        console.error('[Config] Test service email error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Test Azure Cohere Reranker ──────────────────────────────────

router.post('/config/test-reranker', requireAuth, async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const endpoint = (await configStore.getConfig('azure_reranker_endpoint') || process.env.AZURE_RERANKER_ENDPOINT || '').replace(/\/+$/, '');
        const key = await configStore.getSecret('azure_reranker_key') || process.env.AZURE_RERANKER_KEY;
        const model = await configStore.getConfig('azure_reranker_model') || process.env.AZURE_RERANKER_MODEL || 'Cohere-rerank-v4.0-fast';

        if (!endpoint || !key) {
            return res.status(400).json({ error: 'Azure reranker endpoint and key are required' });
        }

        const start = Date.now();
        const isServicesHub = endpoint.includes('.services.ai.azure.com');
        const rerankerUrl = isServicesHub
            ? `${endpoint}/models/rerank`
            : `${endpoint}/v1/rerank`;
        const rerankerRes = await fetch(rerankerUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`,
            },
            body: JSON.stringify({
                model,
                query: 'What is BeeFlow?',
                documents: [
                    'BeeFlow is an AI-powered productivity platform.',
                    'The weather today is sunny.',
                    'BeeFlow helps teams collaborate with intelligent agents.',
                ],
                top_n: 2,
            }),
            signal: AbortSignal.timeout(15000),
        });

        const latencyMs = Date.now() - start;

        if (rerankerRes.ok) {
            const data = await rerankerRes.json();
            res.json({ success: true, latencyMs, results: data.results?.length || 0 });
        } else {
            const errBody = await rerankerRes.text().catch(() => '');
            res.status(502).json({ error: `Reranker responded ${rerankerRes.status}: ${errBody.slice(0, 300)}` });
        }
    } catch (err) {
        console.error('[Config] Test reranker error:', err);
        res.status(500).json({ error: err.message });
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
    const isMicrosoftUser = req.session.oauthProvider === 'microsoft';
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

    // Check org privacy shield for disableSearchOnUpload
    let disableSearchOnUpload = false;
    try {
        const userStore2 = require('../../stores/userStore');
        const currentUser2 = await userStore2.getUser(userId);
        if (currentUser2?.organizationId) {
            const shield = await configStore.getConfig(`org_privacy_shield_${currentUser2.organizationId}`);
            if (shield?.enabled && shield.disableSearchOnUpload) {
                disableSearchOnUpload = true;
            }
        }
    } catch (e) { /* ignore */ }

    res.json({
        hasFirefliesKey: !!(await configStore.getSecret(`fireflies_api_key_user_${userId}`)),
        hasYouTrackConfig: !!(await configStore.getSecret(`youtrack_url_user_${userId}`)) && !!(await configStore.getSecret(`youtrack_token_user_${userId}`)),
        hasGammaKey: !!(await configStore.getSecret(`gamma_api_key_user_${userId}`)),
        hasLinkedInConfig: !!(await configStore.getSecret('linkedin_client_id')) && !!(await configStore.getSecret('linkedin_client_secret')),
        hasGoogleKey: !!(await configStore.getSecret('google_api_key')),
        hasElevenLabsKey: !!(await configStore.getSecret('elevenlabs_api_key')),
        isGoogleUser,
        isMicrosoftUser,
        enabledApps: enabledApps || null,
        orgEnabledIntegrations,
        hasN8nConfig,
        hasGoogleMapsKey: !!(await configStore.getSecret('google_maps_api_key')),
        disableSearchOnUpload,
        searchProvider: await configStore.getConfig('search_provider') || 'agent-search',
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

// ─── MCP Server Management ──────────────────────────────────────

const mcpManager = require('../../core/mcpManager');
const crypto = require('crypto');

// GET /ai/mcp-servers — list all configured MCP servers (admin)
router.get('/mcp-servers', requireAuth, async (req, res) => {
    try {
        const servers = await mcpManager.getServersSummary();
        res.json({ servers });
    } catch (err) {
        console.error('[MCP] List servers error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /ai/mcp-servers — add a new MCP server definition (admin)
router.post('/mcp-servers', requireAuth, async (req, res) => {
    try {
        const { name, command, args = [], required_credentials = [], transport = 'stdio', url, category, description, icon, source = 'manual' } = req.body;
        if (!name) {
            return res.status(400).json({ error: 'name is required' });
        }
        if (transport === 'stdio' && !command) {
            return res.status(400).json({ error: 'command is required for stdio servers' });
        }
        if (transport === 'http' && !url) {
            return res.status(400).json({ error: 'url is required for HTTP servers' });
        }
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || crypto.randomUUID().slice(0, 8);
        const server = await mcpManager.addServer({ id, name, command, args, required_credentials, transport, url, category, description, icon, source });
        res.json({ success: true, server });
    } catch (err) {
        console.error('[MCP] Add server error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /ai/mcp-servers/test — test an MCP server command
router.post('/mcp-servers/test', requireAuth, async (req, res) => {
    try {
        const { command, args = [], transport = 'stdio', url } = req.body;
        if (transport === 'stdio' && !command) return res.status(400).json({ error: 'command is required for stdio' });
        if (transport === 'http' && !url) return res.status(400).json({ error: 'url is required for HTTP' });
        const result = await mcpManager.testCommand(command, args, {}, transport, url);
        res.json(result);
    } catch (err) {
        console.error('[MCP] Test command error:', err);
        res.status(500).json({ error: err.message });
    }
});

// PUT /ai/mcp-servers/:id — update an MCP server config (admin)
router.put('/mcp-servers/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, command, args, required_credentials, enabled, transport, url, category, description, icon } = req.body;
        const mcpStore = require('../../stores/mcpStore');
        const updates = {};
        if (name !== undefined) updates.name = name;
        if (command !== undefined) updates.command = command;
        if (args !== undefined) updates.args = args;
        if (required_credentials !== undefined) updates.required_credentials = required_credentials;
        if (enabled !== undefined) updates.enabled = enabled;
        if (transport !== undefined) updates.transport = transport;
        if (url !== undefined) updates.url = url;
        if (category !== undefined) updates.category = category;
        if (description !== undefined) updates.description = description;
        if (icon !== undefined) updates.icon = icon;
        await mcpStore.updateServer(id, updates);
        res.json({ success: true });
    } catch (err) {
        console.error('[MCP] Update server error:', err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /ai/mcp-servers/:id — remove an MCP server (admin)
router.delete('/mcp-servers/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        await mcpManager.removeServer(id);
        res.json({ success: true });
    } catch (err) {
        console.error('[MCP] Delete server error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /ai/mcp-servers/:id/refresh — re-discover tools from a server
router.post('/mcp-servers/:id/refresh', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const tools = await mcpManager.refreshServerTools(id);
        res.json({ success: true, tools });
    } catch (err) {
        console.error('[MCP] Refresh server error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /ai/mcp-servers/user-credentials — get MCP servers needing user credentials
router.get('/mcp-servers/user-credentials', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const servers = await mcpManager.getServersForUser(userId);
        res.json({ servers });
    } catch (err) {
        console.error('[MCP] User credentials error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /ai/mcp-servers/user-credentials — save a user's credential for an MCP server
router.post('/mcp-servers/user-credentials', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { serverId, credKey, value } = req.body;
        if (!serverId || !credKey) {
            return res.status(400).json({ error: 'serverId and credKey are required' });
        }
        await mcpManager.saveUserCredential(userId, serverId, credKey, value);
        res.json({ success: true });
    } catch (err) {
        console.error('[MCP] Save credential error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

