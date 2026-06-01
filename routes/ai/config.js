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
const { hasPermission } = require('../../auth/permissions');

// Authentication middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

async function isAdminUser(req) {
    if (req.session.isAdmin || req.session.user?.role === 'admin') return true;
    const userId = req.session.user?.id;
    if (!userId) return false;
    return await hasPermission(userId, 'admin_ai_config', req.session);
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
        // Voice Chat (Beta) — capability hint for the UI. The actual gate is
        // the `voice_chat` beta feature; this flag tells the frontend whether
        // the underlying Mistral dependency is set up so it can render a
        // helpful "configure Mistral to enable voice" state in admin.
        voiceChatReady: !!(await configStore.getSecret('mistral_api_key')),
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
        piiDetectionEnabled: config.piiDetectionEnabled || false,
        piiDetectionCategories: config.piiDetectionCategories || null,
        piiDetectionConfidenceThreshold: config.piiDetectionConfidenceThreshold ?? 0.7,
        piiDetectionScope: config.piiDetectionScope || { userInput: true, agentOutput: false },
        piiDetectionAction: config.piiDetectionAction || 'block',
        embeddingModel: config.embeddingModel || null,
        embeddingProviderId: config.embeddingProviderId || null,
        allowedModelsByAgentType: await configStore.getConfig('allowedModelsByAgentType') || {},
        directChatRegexGuardrails: await configStore.getConfig('direct_chat_regex_guardrails') || null,
        // Tool-call rounds limit for chat surfaces (direct/notebook/webpage/native loop). null -> per-surface defaults.
        maxToolRoundsChat: await configStore.getConfig('max_tool_rounds_chat') || null,
        // KB provider — 'local' (in-process pgvector) or 'remote' (search-service). null -> auto.
        kbProvider: await configStore.getConfig('kb_provider') || null,
        // CPU cross-encoder reranker toggle (default on for fresh installs).
        cpuRerankerEnabled: (await configStore.getConfig('cpu_reranker_enabled')) !== false,
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
        localWhisperEnabled: (await configStore.getConfig('local_whisper_enabled')) !== false,
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
        // Stripe Payment Integration
        hasStripeSecretKey: !!(await configStore.getSecret('stripe_secret_key')),
        hasStripeWebhookSecret: !!(await configStore.getSecret('stripe_webhook_secret')),
        stripePublishableKey: await configStore.getConfig('stripe_publishable_key') || '',
        stripeEnabled: !!(await configStore.getConfig('stripe_enabled')),
        stripeTaxEnabled: !!(await configStore.getConfig('stripe_tax_enabled')),
        stripeTaxCountry: await configStore.getConfig('stripe_tax_country') || 'NL',
    });
});

router.post('/config', requireAuth, async (req, res) => {
    try {
    if (!(await isAdminUser(req))) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    const { url, model, apiKey, mistralApiKey, openaiApiKey, claudeApiKey, googleApiKey, elevenlabsApiKey, googleVertexProject, googleVertexLocation, googleVertexServiceAccountKey, azureEndpoint, azureApiKey, azureApiVersion, azureModels, agentSearchUrl, lakeraApiKey, regexGuardrails, piiDetectionEnabled, piiDetectionCategories, piiDetectionConfidenceThreshold, piiDetectionScope, piiDetectionAction, embeddingModel, embeddingProviderId, allowedModelsByAgentType, directChatRegexGuardrails, googleMapsApiKey, serperApiKey, azureDocIntelligenceEndpoint, azureDocIntelligenceKey, azureOpenaiEmbeddingEndpoint, azureOpenaiEmbeddingKey, azureOpenaiEmbeddingModel, useAzureDocProcessing, serviceEmailAddress, serviceEmailPassword, serviceEmailDisplayName, azureSpeechKey, azureSpeechRegion, transcriptionProvider, notebooksEnabled, projectsEnabled, askAiEnabled, exportEnabled, openInNotebookEnabled, notebooksMenuEnabled, azureRerankerEndpoint, azureRerankerKey, azureRerankerModel, stripeSecretKey, stripeWebhookSecret, stripePublishableKey, stripeEnabled, stripeTaxEnabled, stripeTaxCountry } = req.body;
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
    if (agentSearchUrl !== undefined) {
        await configStore.setConfig('agent_search_url', agentSearchUrl || '');
    }
    if (serperApiKey !== undefined) {
        await configStore.setSecret('serper_api_key', serperApiKey || '');
    }
    if (req.body.searchProvider !== undefined) {
        const allowed = new Set(['agent-search', 'node-search', 'bing', 'disabled']);
        const value = allowed.has(req.body.searchProvider) ? req.body.searchProvider : 'agent-search';
        await configStore.setConfig('search_provider', value);
    }
    if (req.body.maxToolRoundsChat !== undefined) {
        const raw = req.body.maxToolRoundsChat;
        if (raw === null || raw === '' || raw === false) {
            await configStore.setConfig('max_tool_rounds_chat', null);
        } else {
            const n = parseInt(raw, 10);
            if (Number.isFinite(n)) {
                const clamped = Math.min(Math.max(n, 1), 50);
                await configStore.setConfig('max_tool_rounds_chat', clamped);
            }
        }
    }
    if (req.body.kbProvider !== undefined) {
        const allowed = new Set(['local', 'remote']);
        const value = allowed.has(req.body.kbProvider) ? req.body.kbProvider : null;
        await configStore.setConfig('kb_provider', value);
    }
    if (req.body.cpuRerankerEnabled !== undefined) {
        await configStore.setConfig('cpu_reranker_enabled', !!req.body.cpuRerankerEnabled);
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
        const allowed = ['voxtral', 'azure', 'whisperx', 'whisper_azure', 'local'];
        if (transcriptionProvider && !allowed.includes(transcriptionProvider)) {
            return res.status(400).json({ error: `Invalid transcription provider. Allowed: ${allowed.join(', ')}` });
        }
        await configStore.setConfig('transcription_provider', transcriptionProvider || 'voxtral');
    }
    // In-process Whisper-base CPU transcription — admin opt-out toggle.
    // When false, the per-upload "Local CPU" picker disappears and any
    // request with provider='local' falls back to the configured cloud one.
    if (req.body.localWhisperEnabled !== undefined) {
        await configStore.setConfig('local_whisper_enabled', !!req.body.localWhisperEnabled);
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
    // Stripe Payment Integration
    if (stripeSecretKey !== undefined) {
        await configStore.setSecret('stripe_secret_key', stripeSecretKey || '');
    }
    if (stripeWebhookSecret !== undefined) {
        await configStore.setSecret('stripe_webhook_secret', stripeWebhookSecret || '');
    }
    if (stripePublishableKey !== undefined) {
        await configStore.setConfig('stripe_publishable_key', stripePublishableKey || '');
    }
    if (stripeEnabled !== undefined) {
        await configStore.setConfig('stripe_enabled', stripeEnabled ? 'true' : '');
    }
    if (stripeTaxEnabled !== undefined) {
        await configStore.setConfig('stripe_tax_enabled', stripeTaxEnabled ? 'true' : '');
    }
    if (stripeTaxCountry !== undefined) {
        await configStore.setConfig('stripe_tax_country', stripeTaxCountry || 'NL');
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
    } catch (err) {
        console.error('[Config] POST /config error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

// ─── Delete API Key ──────────────────────────────────────────────

// Whitelist of keys that can be deleted via this endpoint
const DELETABLE_KEYS = [
    'openai_api_key', 'claude_api_key', 'google_api_key', 'mistral_api_key',
    'elevenlabs_api_key', 'serper_api_key', 'google_maps_api_key',
    'google_vertex_service_account_key', 'azure_api_key', 'azure_content_safety_key',
    'azure_doc_intelligence_key', 'azure_openai_embedding_key', 'azure_speech_key',
    'bing_search_key', 'linkedin_client_id', 'linkedin_client_secret',
    'service_email_password', 'whisperx_url', 'whisperx_token',
    'azure_reranker_key', 'stripe_secret_key', 'stripe_webhook_secret',
];

router.delete('/config/key/:keyName', requireAuth, async (req, res) => {
    try {
        if (!(await isAdminUser(req))) {
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
    'stripe_publishable_key', 'stripe_tax_country',
];

router.delete('/config/setting/:keyName', requireAuth, async (req, res) => {
    try {
        if (!(await isAdminUser(req))) {
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
        if (!(await isAdminUser(req))) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const endpoint = (await configStore.getConfig('azure_reranker_endpoint') || process.env.AZURE_RERANKER_ENDPOINT || '').replace(/\/+$/, '');
        const key = await configStore.getSecret('azure_reranker_key') || process.env.AZURE_RERANKER_KEY;
        const model = await configStore.getConfig('azure_reranker_model') || process.env.AZURE_RERANKER_MODEL || 'Cohere-rerank-v4.0-fast';

        if (!endpoint || !key) {
            return res.status(400).json({ error: 'Azure reranker endpoint and key are required' });
        }

        const start = Date.now();
        const requestBody = JSON.stringify({
            model,
            query: 'What is BeeFlow?',
            documents: [
                'BeeFlow is an AI-powered productivity platform.',
                'The weather today is sunny.',
                'BeeFlow helps teams collaborate with intelligent agents.',
            ],
            top_n: 2,
        });
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`,
        };

        // Try paths in order
        const PATHS = ['/providers/cohere/v2/rerank', '/v1/rerank', '/v2/rerank'];
        let lastError = '';
        for (const path of PATHS) {
            const url = `${endpoint}${path}`;
            const rerankerRes = await fetch(url, {
                method: 'POST',
                headers,
                body: requestBody,
                signal: AbortSignal.timeout(15000),
            });

            const latencyMs = Date.now() - start;

            if (rerankerRes.ok) {
                const data = await rerankerRes.json();
                return res.json({ success: true, latencyMs, results: data.results?.length || 0, path });
            }
            lastError = await rerankerRes.text().catch(() => '');
            if (rerankerRes.status === 401 || rerankerRes.status === 403) {
                return res.status(502).json({ error: `Auth failed (${rerankerRes.status}): ${lastError.slice(0, 300)}` });
            }
        }
        res.status(502).json({ error: `All paths failed. Last: ${lastError.slice(0, 300)}` });
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
            standard: { modelId: '', label: 'Flow (Direct)' },
            swarm: { modelId: '', label: 'Swarm (Direct)' },
            thinking: { modelId: '', label: 'Thinking' },
            writer: { modelId: '', label: 'Writer' },
            pro: { modelId: '', label: 'Pro' }
        };
        if (!tiers.writer) tiers.writer = { modelId: '', label: 'Writer' };
        if (!tiers.standard) tiers.standard = { modelId: '', label: 'Flow (Direct)' };
        if (!tiers.swarm) tiers.swarm = { modelId: '', label: 'Swarm (Direct)' };
        res.json(tiers);
    } catch (e) {
        console.error('Failed to get chat model tiers:', e);
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

router.post('/config/chat-models', requireAuth, async (req, res) => {
    try {
        const { fast, standard, swarm, thinking, writer, pro } = req.body;
        const tiers = {
            fast: fast || { modelId: '', label: 'Fast' },
            standard: standard || { modelId: '', label: 'Flow (Direct)' },
            swarm: swarm || { modelId: '', label: 'Swarm (Direct)' },
            thinking: thinking || { modelId: '', label: 'Thinking' },
            writer: writer || { modelId: '', label: 'Writer' },
            pro: pro || { modelId: '', label: 'Pro' }
        };
        await configStore.setConfig('chat_model_tiers', tiers);
        try { require('../../core/promptClassifier').clearClassifierCache(); } catch (_) { /* non-fatal */ }
        res.json({ success: true });
    } catch (e) {
        console.error('Failed to save chat model tiers:', e);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// ─── Auto-tier Classifier Model ──────────────────────────────────
// The classifier picks a tier for Auto-mode prompts. It runs an LLM
// call only on ambiguous prompts (the heuristic shortcut handles the
// easy 60–70%). Admins can pin the cheapest/fastest model here so the
// classification call is as snappy as possible. When unset, falls back
// to the Fast tier model.

router.get('/config/auto-classifier', requireAuth, async (req, res) => {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    try {
        const modelId = await configStore.getConfig('auto_classifier_model');
        res.json({ modelId: typeof modelId === 'string' ? modelId : null });
    } catch (e) {
        console.error('Failed to get auto-classifier model:', e);
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

router.post('/config/auto-classifier', requireAuth, async (req, res) => {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    try {
        const raw = req.body?.modelId;
        const modelId = typeof raw === 'string' && raw.trim() ? raw.trim() : null;

        if (modelId) {
            const { getProviderForModel } = require('../../core/aiAgent');
            try {
                await getProviderForModel(modelId);
            } catch (_) {
                return res.status(400).json({ error: `Model "${modelId}" not found in any configured provider` });
            }
        }

        await configStore.setConfig('auto_classifier_model', modelId);
        try { require('../../core/promptClassifier').clearClassifierCache(); } catch (_) { /* non-fatal */ }
        res.json({ success: true, modelId });
    } catch (e) {
        console.error('Failed to save auto-classifier model:', e);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// ─── Title-generation Model ──────────────────────────────────────
// Conversation titles are a tiny, tool-free LLM call. By default the
// title generator inherits the Fast tier model, but admins often want
// the very cheapest model here (a heavy Fast tier shouldn't make titling
// expensive). When unset, falls back to the title system-agent config and
// then the Fast tier.

router.get('/config/title-model', requireAuth, async (req, res) => {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    try {
        const modelId = await configStore.getConfig('title_generation_model');
        res.json({ modelId: typeof modelId === 'string' ? modelId : null });
    } catch (e) {
        console.error('Failed to get title-generation model:', e);
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

router.post('/config/title-model', requireAuth, async (req, res) => {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    try {
        const raw = req.body?.modelId;
        const modelId = typeof raw === 'string' && raw.trim() ? raw.trim() : null;

        if (modelId) {
            const { getProviderForModel } = require('../../core/aiAgent');
            try {
                await getProviderForModel(modelId);
            } catch (_) {
                return res.status(400).json({ error: `Model "${modelId}" not found in any configured provider` });
            }
        }

        await configStore.setConfig('title_generation_model', modelId);
        res.json({ success: true, modelId });
    } catch (e) {
        console.error('Failed to save title-generation model:', e);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// ─── Claude-specific settings ────────────────────────────────────
// Global knobs that only apply to Anthropic Claude models. Per-tier
// settings (model, max_tokens, effort, budget_tokens) live in the
// regular chat_model_tiers config; this endpoint exists for the
// cross-tier robustness toggles.
//
// auto_retry_on_empty — when a Claude turn returns stop_reason=max_tokens
// (or any path where thinking ate the budget and the final text is empty),
// kick off ONE follow-up non-streaming call with reasoningEffort='none' so
// the model writes a real answer based on what it already thought. Default
// true; flip off if you'd rather see the raw "no response" symptom.

router.get('/config/claude-settings', requireAuth, async (req, res) => {
    try {
        const settings = (await configStore.getConfig('claude_settings')) || {};
        res.json({
            autoRetryOnEmpty: settings.autoRetryOnEmpty !== false, // default true
        });
    } catch (e) {
        console.error('Failed to get Claude settings:', e);
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

router.post('/config/claude-settings', requireAuth, async (req, res) => {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    try {
        const { autoRetryOnEmpty } = req.body || {};
        const settings = {
            autoRetryOnEmpty: autoRetryOnEmpty !== false,
        };
        await configStore.setConfig('claude_settings', settings);
        res.json({ success: true, ...settings });
    } catch (e) {
        console.error('Failed to save Claude settings:', e);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// ─── Hidden Models (global blocklist) ────────────────────────────
// Admins can hide specific model IDs from every tier picker (Fast, Flow,
// Thinking, etc.). Stored as a flat array of model IDs under
// `hidden_model_ids`. The list is purely cosmetic — it does NOT remove the
// model from the provider catalog, just from the picker UI.

router.get('/config/hidden-models', requireAuth, async (req, res) => {
    try {
        const raw = await configStore.getConfig('hidden_model_ids');
        const ids = Array.isArray(raw) ? raw.filter(id => typeof id === 'string') : [];
        res.json({ modelIds: ids });
    } catch (e) {
        console.error('Failed to get hidden models:', e);
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

router.post('/config/hidden-models', requireAuth, async (req, res) => {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    try {
        const raw = req.body?.modelIds;
        if (!Array.isArray(raw)) return res.status(400).json({ error: 'modelIds must be an array' });
        const ids = [...new Set(raw.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))];
        await configStore.setConfig('hidden_model_ids', ids);
        res.json({ success: true, modelIds: ids });
    } catch (e) {
        console.error('Failed to save hidden models:', e);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// ─── EU Model Tier Config ────────────────────────────────────────

router.get('/config/chat-models-eu', requireAuth, async (req, res) => {
    try {
        const tiers = await configStore.getConfig('chat_model_tiers_eu') || {
            fast: { modelId: '', label: 'Fast' },
            standard: { modelId: '', label: 'Flow (Direct)' },
            swarm: { modelId: '', label: 'Swarm (Direct)' },
            thinking: { modelId: '', label: 'Thinking' },
            writer: { modelId: '', label: 'Writer' },
            pro: { modelId: '', label: 'Pro' }
        };
        if (!tiers.standard) tiers.standard = { modelId: '', label: 'Flow (Direct)' };
        if (!tiers.swarm) tiers.swarm = { modelId: '', label: 'Swarm (Direct)' };
        res.json(tiers);
    } catch (e) {
        console.error('Failed to get EU chat model tiers:', e);
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

router.post('/config/chat-models-eu', requireAuth, async (req, res) => {
    try {
        const { fast, standard, swarm, thinking, writer, pro } = req.body;
        const tiers = {
            fast: fast || { modelId: '', label: 'Fast' },
            standard: standard || { modelId: '', label: 'Flow (Direct)' },
            swarm: swarm || { modelId: '', label: 'Swarm (Direct)' },
            thinking: thinking || { modelId: '', label: 'Thinking' },
            writer: writer || { modelId: '', label: 'Writer' },
            pro: pro || { modelId: '', label: 'Pro' }
        };

        // Validate that specified model IDs exist in configured providers
        const warnings = [];
        const { getProviderForModel } = require('../../core/aiAgent');
        for (const [tierName, tierConfig] of Object.entries(tiers)) {
            if (tierConfig.modelId) {
                try {
                    await getProviderForModel(tierConfig.modelId);
                } catch (_) {
                    warnings.push(`EU tier "${tierName}": model "${tierConfig.modelId}" not found in any configured provider`);
                }
            }
        }

        await configStore.setConfig('chat_model_tiers_eu', tiers);
        try { require('../../core/promptClassifier').clearClassifierCache(); } catch (_) { /* non-fatal */ }
        if (warnings.length > 0) {
            console.warn('[Config] EU tier validation warnings:', warnings);
        }
        res.json({ success: true, warnings });
    } catch (e) {
        console.error('Failed to save EU chat model tiers:', e);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// ─── Custom Chat Model Tiers ─────────────────────────────────────

// 'email_kb' task type is preserved as the canonical name for the ticket-assistant
// custom-tier slot so existing org overrides continue to resolve correctly.
// The feature itself has been rebranded to "ITIL Ticket Assistant".
const VALID_TASK_TYPES = ['direct_chat', 'agent_chat', 'email_kb'];
const STANDARD_TIER_KEYS = ['fast', 'standard', 'swarm', 'thinking', 'writer', 'pro'];

// ── Custom tier helpers ──────────────────────────────────────────
async function isOrgAdmin(req) {
    if (await isAdminUser(req)) return true;
    const userId = req.session.user?.id;
    if (!userId) return false;
    const perms = await require('../../auth/permissions').getUserPermissions(userId, req.session);
    return perms.includes('all') || perms.includes('org_admin') || perms.includes('manage_users');
}

async function resolveSessionOrgId(req) {
    if (req.session.user?.organizationId) return req.session.user.organizationId;
    try {
        const userStore = require('../../stores/userStore');
        const u = await userStore.getUser(req.session.user?.id);
        if (u?.organizationId) return u.organizationId;
        // Fallback: first group's org
        const groups = Array.isArray(u?.groups) ? u.groups : [];
        if (groups.length > 0) {
            const allGroups = await userStore.getAllGroups();
            for (const gid of groups) {
                const g = allGroups.find(gr => gr.id === gid);
                if (g?.organizationId) return g.organizationId;
            }
        }
    } catch (_) { /* ignore */ }
    return null;
}

async function loadGlobalCustomTiers() {
    const arr = await configStore.getConfig('custom_chat_model_tiers') || [];
    return Array.isArray(arr) ? arr : [];
}

async function loadOrgCustomTiers(orgId) {
    if (!orgId) return [];
    const arr = await configStore.getConfig(`custom_chat_model_tiers_org_${orgId}`) || [];
    return Array.isArray(arr) ? arr : [];
}

// Merge global + org tiers into a single array with stable ordering.
// When IDs collide, the org tier wins (org admin has final word in their org).
// Each tier gets a `_scope` field ('global' | 'org') so the UI can show badges.
async function loadMergedCustomTiers(orgId) {
    const globalTiers = await loadGlobalCustomTiers();
    const orgTiers = orgId ? await loadOrgCustomTiers(orgId) : [];
    const byId = new Map();
    for (const t of globalTiers) if (t && t.id) byId.set(t.id, { ...t, _scope: 'global' });
    for (const t of orgTiers) if (t && t.id) byId.set(t.id, { ...t, _scope: 'org' });
    return Array.from(byId.values());
}

function normalizeCustomTier(t) {
    if (!t || typeof t !== 'object') return null;
    const id = typeof t.id === 'string' && t.id.startsWith('custom:') ? t.id : null;
    if (!id) return null;
    const allowedTaskTypes = Array.isArray(t.allowedTaskTypes)
        ? t.allowedTaskTypes.filter(tt => VALID_TASK_TYPES.includes(tt))
        : [];
    return {
        id,
        label: String(t.label || id.replace(/^custom:/, '')),
        icon: typeof t.icon === 'string' ? t.icon : '✨',
        description: typeof t.description === 'string' ? t.description : '',
        modelId: typeof t.modelId === 'string' ? t.modelId : '',
        // Optional EU-hosted override used when the org's Privacy Shield forces EU mode.
        // Empty string → no override; falls back to the global modelId.
        euModelId: typeof t.euModelId === 'string' ? t.euModelId : '',
        maxTokens: Number.isFinite(t.maxTokens) ? t.maxTokens : 16384,
        temperature: Number.isFinite(t.temperature) ? t.temperature : 0.7,
        reasoningEffort: typeof t.reasoningEffort === 'string' ? t.reasoningEffort : undefined,
        reasoningSummary: !!t.reasoningSummary,
        allowedTaskTypes,
    };
}

router.get('/config/custom-chat-models', requireAuth, async (req, res) => {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    try {
        const tiers = await configStore.getConfig('custom_chat_model_tiers') || [];
        res.json({ tiers: Array.isArray(tiers) ? tiers : [] });
    } catch (e) {
        console.error('Failed to get custom chat model tiers:', e);
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

router.post('/config/custom-chat-models', requireAuth, async (req, res) => {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    try {
        const { tiers } = req.body;
        if (!Array.isArray(tiers)) {
            return res.status(400).json({ error: '`tiers` must be an array' });
        }
        const normalized = tiers.map(normalizeCustomTier).filter(Boolean);
        // Dedupe by id — last occurrence wins
        const seen = new Map();
        for (const t of normalized) seen.set(t.id, t);
        const finalTiers = Array.from(seen.values());

        const warnings = [];
        const { getProviderForModel } = require('../../core/aiAgent');
        for (const t of finalTiers) {
            if (t.modelId) {
                try { await getProviderForModel(t.modelId); }
                catch (_) { warnings.push(`Custom tier "${t.id}": model "${t.modelId}" not found in any configured provider`); }
            }
        }
        await configStore.setConfig('custom_chat_model_tiers', finalTiers);
        if (warnings.length > 0) console.warn('[Config] Custom tier validation warnings:', warnings);
        res.json({ success: true, warnings, tiers: finalTiers });
    } catch (e) {
        console.error('Failed to save custom chat model tiers:', e);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// Lightweight tier list for org-admin group editor — metadata only (id, label, icon, scope)
// Returns global + the caller's org tiers merged.
router.get('/config/custom-tiers-list', requireAuth, async (req, res) => {
    try {
        const orgId = await resolveSessionOrgId(req);
        const tiers = await loadMergedCustomTiers(orgId);
        const list = tiers.map(t => ({
            id: t.id, label: t.label, icon: t.icon, description: t.description,
            allowedTaskTypes: t.allowedTaskTypes || [],
            scope: t._scope || 'global',
        }));
        res.json({ tiers: list });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch tiers list' });
    }
});

// ─── Org-scoped Custom Tiers (org admin) ─────────────────────────
// Operates on custom_chat_model_tiers_org_{orgId}. Org admins may create/edit
// tiers that are scoped to their organization. Super admins may use this on
// any org by passing ?orgId=xxx; org admins implicitly target their own org.
router.get('/config/org-custom-chat-models', requireAuth, async (req, res) => {
    if (!(await isOrgAdmin(req))) return res.status(403).json({ error: 'Org admin access required' });
    try {
        let orgId = await isAdminUser(req) && typeof req.query.orgId === 'string' && req.query.orgId
            ? req.query.orgId
            : await resolveSessionOrgId(req);
        if (!orgId) return res.status(400).json({ error: 'No organisation resolved for this user' });
        const globalTiers = await loadGlobalCustomTiers();
        const orgTiers = await loadOrgCustomTiers(orgId);
        res.json({
            orgId,
            orgTiers,
            // Returned for reference (read-only in this editor) so the org admin
            // can see which tiers are already provided globally.
            globalTiers: globalTiers.map(t => ({
                id: t.id, label: t.label, icon: t.icon, description: t.description,
                allowedTaskTypes: t.allowedTaskTypes || [],
            })),
        });
    } catch (e) {
        console.error('Failed to get org custom chat model tiers:', e);
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

router.post('/config/org-custom-chat-models', requireAuth, async (req, res) => {
    if (!(await isOrgAdmin(req))) return res.status(403).json({ error: 'Org admin access required' });
    try {
        let orgId = await isAdminUser(req) && typeof req.body.orgId === 'string' && req.body.orgId
            ? req.body.orgId
            : await resolveSessionOrgId(req);
        if (!orgId) return res.status(400).json({ error: 'No organisation resolved for this user' });

        const { tiers } = req.body;
        if (!Array.isArray(tiers)) {
            return res.status(400).json({ error: '`tiers` must be an array' });
        }
        const normalized = tiers.map(normalizeCustomTier).filter(Boolean);
        const seen = new Map();
        for (const t of normalized) seen.set(t.id, t);
        const finalTiers = Array.from(seen.values());

        const warnings = [];
        const { getProviderForModel } = require('../../core/aiAgent');
        for (const t of finalTiers) {
            if (t.modelId) {
                try { await getProviderForModel(t.modelId); }
                catch (_) { warnings.push(`Custom tier "${t.id}": model "${t.modelId}" not found in any configured provider`); }
            }
            if (t.euModelId) {
                try { await getProviderForModel(t.euModelId); }
                catch (_) { warnings.push(`Custom tier "${t.id}": EU model "${t.euModelId}" not found in any configured provider`); }
            }
        }
        await configStore.setConfig(`custom_chat_model_tiers_org_${orgId}`, finalTiers);
        if (warnings.length > 0) console.warn(`[Config] Org ${orgId} custom tier warnings:`, warnings);
        res.json({ success: true, orgId, warnings, tiers: finalTiers });
    } catch (e) {
        console.error('Failed to save org custom chat model tiers:', e);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// Returns tiers a given user may use, optionally filtered by taskType.
// Shape matches the existing /config/chat-models consumer: { fast: {...}, thinking: {...}, ..., 'custom:xyz': {...} }
router.get('/config/tiers-for-user', requireAuth, async (req, res) => {
    try {
        const taskType = typeof req.query.taskType === 'string' ? req.query.taskType : null;
        const userId = req.session.user?.id;
        const userOrgId = req.session.user?.organizationId;

        const userStore = require('../../stores/userStore');
        const { getEUAwareTiers } = require('../../core/modelResolver');

        // Standard tiers (already EU-aware) — always included, unrestricted by the plan's permission model
        const standardTiers = await getEUAwareTiers({ userOrgId, userId });

        // Custom tiers (global + org-scoped, with org taking precedence on id collision)
        const customTiers = await loadMergedCustomTiers(userOrgId);
        // EU override: when EU mode is active, swap modelId for euModelId (if set).
        const { isEUModeActive } = require('../../core/modelResolver');
        const { isEU } = await isEUModeActive({ userOrgId, userId });
        if (isEU) {
            for (const t of customTiers) {
                if (t.euModelId) t.modelId = t.euModelId;
            }
        }

        // Resolve user's group ids
        const user = userId ? await userStore.getUser(userId) : null;
        const userGroupIds = Array.isArray(user?.groups) ? user.groups : [];
        const allGroups = await userStore.getAllGroups();
        const userGroups = allGroups.filter(g => userGroupIds.includes(g.id));

        // A tier is permitted if ANY of the user's groups:
        //   (a) has allowedTiers empty/unset (no restriction), OR
        //   (b) lists the tier id in allowedTiers.
        // If the user has NO groups, treat as unrestricted (matches getUser default behaviour).
        function tierPermittedByGroups(tierId) {
            if (userGroups.length === 0) return true;
            return userGroups.some(g => {
                const list = Array.isArray(g.allowedTiers) ? g.allowedTiers : [];
                return list.length === 0 || list.includes(tierId);
            });
        }

        // The Flow tier (key 'standard') requires BOTH the `flow` beta (the
        // tier opt-in) and the `skills` beta (its runtime dependency: Flow
        // bootstraps chat-local session skills). The Swarm tier depends on
        // the `swarm` beta. Hide either tier when the caller's org/user
        // doesn't have the required feature(s).
        const { userHasBetaFeature } = require('../../core/betaFeatures');
        const hasSkillsFeature = userId
            ? await userHasBetaFeature(userId, 'skills', req.session).catch(() => false)
            : false;
        const hasFlowFeature = userId
            ? await userHasBetaFeature(userId, 'flow', req.session).catch(() => false)
            : false;
        const hasSwarmFeature = userId
            ? await userHasBetaFeature(userId, 'swarm', req.session).catch(() => false)
            : false;
        const hasFlowTier = hasFlowFeature && hasSkillsFeature;

        const result = {};
        // Auto is a meta/routing tier (no concrete modelId) — always include it
        // when permitted by groups so the client's persisted 'auto' selection
        // survives the post-fetch reconciliation in AgentHub.
        if (tierPermittedByGroups('auto')) {
            result.auto = { auto: true };
        }
        // Standard
        for (const key of STANDARD_TIER_KEYS) {
            // Direct-chat-only tiers: never expose for non-direct tasks.
            if ((key === 'standard' || key === 'swarm') && taskType !== 'direct_chat') continue;
            // Beta gates: Flow uses `skills`, Swarm uses `swarm`.
            if (key === 'standard' && !hasFlowTier) continue;
            if (key === 'swarm' && !hasSwarmFeature) continue;
            if (!tierPermittedByGroups(key)) continue;
            if (standardTiers && standardTiers[key]) result[key] = standardTiers[key];
        }
        // Custom
        for (const t of (Array.isArray(customTiers) ? customTiers : [])) {
            if (taskType && !(t.allowedTaskTypes || []).includes(taskType)) continue;
            if (!tierPermittedByGroups(t.id)) continue;
            result[t.id] = {
                modelId: t.modelId,
                label: t.label,
                icon: t.icon,
                description: t.description,
                maxTokens: t.maxTokens,
                temperature: t.temperature,
                reasoningEffort: t.reasoningEffort,
                reasoningSummary: t.reasoningSummary,
                custom: true,
            };
        }
        res.json(result);
    } catch (e) {
        console.error('Failed to compute tiers-for-user:', e);
        res.status(500).json({ error: 'Failed to compute tiers' });
    }
});

// ─── Ticket Assistant Tier Config ─────────────────────────────────
// Formerly "Email KB Tier Config". Config key migrated from
// 'email_kb_tier_config' → 'ticket_assistant_tier_config' on first read.
// Old /config/email-kb-tiers route kept as an alias for one release.

const TA_STAGE_KEYS = ['article', 'category', 'merge'];

async function readTicketAssistantTierConfig() {
    let cfg = await configStore.getConfig('ticket_assistant_tier_config');
    if (!cfg) {
        const legacy = await configStore.getConfig('email_kb_tier_config');
        if (legacy) {
            await configStore.setConfig('ticket_assistant_tier_config', legacy);
            try { await configStore.deleteConfig?.('email_kb_tier_config'); } catch (_) { /* ignore */ }
            cfg = legacy;
        }
    }
    return cfg || {};
}

async function handleGetTiers(req, res) {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    try {
        const cfg = await readTicketAssistantTierConfig();
        const out = {};
        for (const k of TA_STAGE_KEYS) out[k] = typeof cfg[k] === 'string' && cfg[k] ? cfg[k] : 'fast';
        res.json(out);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch Ticket Assistant tier config' });
    }
}

async function handlePostTiers(req, res) {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    try {
        const body = req.body || {};
        const cfg = {};
        for (const k of TA_STAGE_KEYS) {
            if (typeof body[k] === 'string' && body[k]) cfg[k] = body[k];
        }
        await configStore.setConfig('ticket_assistant_tier_config', cfg);
        res.json({ success: true, config: cfg });
    } catch (e) {
        console.error('Failed to save Ticket Assistant tier config:', e);
        res.status(500).json({ error: 'Failed to save config' });
    }
}

router.get('/config/ticket-assistant-tiers', requireAuth, handleGetTiers);
router.post('/config/ticket-assistant-tiers', requireAuth, handlePostTiers);
// Legacy aliases — remove after one release.
router.get('/config/email-kb-tiers', requireAuth, handleGetTiers);
router.post('/config/email-kb-tiers', requireAuth, handlePostTiers);

// ─── Web-Search Inference Routing ────────────────────────────────
// Controls how the search-service handles its 3 inference tasks:
//   - embed   → inherits the global Embeddings settings
//   - rerank  → cosine / local / disabled (provider-agnostic)
//   - cleanup → admin picks any chat model from a configured provider
const {
    readWebSearchInferenceConfig,
    writeWebSearchInferenceConfig,
    readEmbedSummary,
    resolveInferenceTargets,
    DEFAULTS: WEB_SEARCH_INFERENCE_DEFAULTS,
} = require('../../core/webSearchInferenceResolver');

router.get('/config/web-search-inference', requireAuth, async (req, res) => {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    try {
        const [config, embedSummary] = await Promise.all([
            readWebSearchInferenceConfig(),
            readEmbedSummary(),
        ]);
        res.json({ config, defaults: WEB_SEARCH_INFERENCE_DEFAULTS, embedSummary });
    } catch (e) {
        console.error('Failed to load web-search inference config:', e);
        res.status(500).json({ error: 'Failed to load config' });
    }
});

router.post('/config/web-search-inference', requireAuth, async (req, res) => {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    try {
        const saved = await writeWebSearchInferenceConfig(req.body || {});
        res.json({ success: true, config: saved });
    } catch (e) {
        console.error('Failed to save web-search inference config:', e);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// Read-only debugging view — what backend each task will actually hit.
// Flags `unresolved` when something the admin selected can't be resolved
// (e.g. provider deleted after cleanup selection was saved).
router.get('/config/web-search-inference/effective', requireAuth, async (req, res) => {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    try {
        const resolved = await resolveInferenceTargets();
        res.json({ resolved });
    } catch (e) {
        console.error('Failed to resolve web-search inference targets:', e);
        res.status(500).json({ error: 'Failed to resolve targets' });
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

    // Check n8n config for org (uses group-based fallback for super-admins)
    let hasN8nConfig = false;
    try {
        const n8nOrgId = await resolveUserOrgId(userId);
        if (n8nOrgId) {
            const n8nUrl = await configStore.getConfig(`n8n_url_org_${n8nOrgId}`);
            const n8nKey = await configStore.getSecret(`n8n_api_key_org_${n8nOrgId}`);
            hasN8nConfig = !!(n8nUrl && n8nKey);
        }
    } catch (e) { /* ignore */ }

    // Check org privacy shield for disableSearchOnUpload + EU mode
    let disableSearchOnUpload = false;
    let orgEuModeForced = false;
    let userOrgId = null;
    try {
        const userStore2 = require('../../stores/userStore');
        const currentUser2 = await userStore2.getUser(userId);
        if (currentUser2?.organizationId) {
            userOrgId = currentUser2.organizationId;
            const shield = await configStore.getConfig(`org_privacy_shield_${userOrgId}`);
            if (shield?.enabled && shield.disableSearchOnUpload) {
                disableSearchOnUpload = true;
            }
            if (shield?.enabled && shield.euModeEnabled) {
                orgEuModeForced = true;
            }
        }
    } catch (e) { /* ignore */ }

    // Personal EU mode preference — the Privacy Shield panel
    // (user_privacy_shield_${userId}) is the canonical store. We still
    // honour the legacy `user_eu_mode_${userId}` key as a fallback for
    // users who toggled the old (now-removed) Startup Agent EU switch
    // before this panel existed; isEUModeActive does the same.
    const userShield = await configStore.getConfig(`user_privacy_shield_${userId}`);
    const userEuModeEnabled = !!(userShield?.enabled && userShield?.euModeEnabled)
        || !!(await configStore.getConfig(`user_eu_mode_${userId}`));

    // Personal Simple Mode preference — strips the UI down to chat + agents
    const simpleMode = !!(await configStore.getConfig(`simple_mode_user_${userId}`));

    // Check if EU models are configured at all (admin must set these up)
    let hasEuModelsConfigured = false;
    try {
        const euTiers = await configStore.getConfig('chat_model_tiers_eu') || {};
        hasEuModelsConfigured = Object.values(euTiers).some(t => t?.modelId?.trim());
    } catch (_) {}

    res.json({
        hasFirefliesKey: !!(await configStore.getSecret(`fireflies_api_key_user_${userId}`)),
        hasYouTrackConfig: !!(await configStore.getSecret(`youtrack_url_user_${userId}`)) && !!(await configStore.getSecret(`youtrack_token_user_${userId}`)),
        hasSignRequestConfig: !!(await configStore.getSecret(`signrequest_subdomain_user_${userId}`)) && !!(await configStore.getSecret(`signrequest_token_user_${userId}`)),
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
        // EU model preference
        userEuModeEnabled,
        orgEuModeForced,
        hasEuModelsConfigured,
        // Simple Mode (personal UI preference)
        simpleMode,
    });
});

router.post('/user-settings', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const { firefliesApiKey, youtrackUrl, youtrackToken, gammaApiKey, signrequestSubdomain, signrequestToken, enabledApps, simpleMode } = req.body;

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

    if (signrequestSubdomain !== undefined) {
        await configStore.setSecret(`signrequest_subdomain_user_${userId}`, signrequestSubdomain || '');
    }
    if (signrequestToken !== undefined) {
        await configStore.setSecret(`signrequest_token_user_${userId}`, signrequestToken || '');
    }

    if (enabledApps !== undefined) {
        await configStore.setConfig(`enabled_apps_user_${userId}`, enabledApps);
    }

    // EU mode is now managed exclusively through the Privacy Shield panel
    // (`user_privacy_shield_${userId}.euModeEnabled`). The legacy
    // `userEuModeEnabled` write here used to power the Startup-Agent toggle;
    // that toggle was removed because it bypassed the master Privacy Shield
    // switch and split the source of truth. Accepting writes here would let
    // a stale client silently change EU routing — so we drop them.

    if (simpleMode !== undefined) {
        await configStore.setConfig(`simple_mode_user_${userId}`, !!simpleMode);
    }

    res.json({ success: true });
});

// ─── AI Regex Generator ──────────────────────────────────────────
router.post('/generate-regex', requireAuth, async (req, res) => {
    // Only admins can generate regex rules
    if (!(await isAdminUser(req))) {
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

const { listActiveWebhookWorkflows, fetchWorkflowById } = require('../../integrations/n8nTools');

// Helper: resolve org ID from user record or group membership
async function resolveUserOrgId(userId) {
    if (!userId) return null;
    const userStore = require('../../stores/userStore');
    const user = await userStore.getUser(userId);
    if (user?.organizationId) return user.organizationId;
    // Fallback: check group membership for org association
    try {
        const groups = Array.isArray(user?.groups) ? user.groups : (() => { try { return JSON.parse(user?.groups || '[]'); } catch (_) { return []; } })();
        if (groups.length > 0) {
            const allGroups = await userStore.getAllGroups();
            for (const gid of groups) {
                const g = allGroups.find(gr => gr.id === gid);
                if (g?.organizationId) return g.organizationId;
            }
        }
    } catch (_) {}
    return null;
}

// Helper: get org ID from session; super admins without an org fall back to '__system__'
async function getOrgId(req) {
    const userId = req.session.user?.id;
    const orgId = await resolveUserOrgId(userId);
    if (!orgId && (req.session.isAdmin || req.session.user?.role === 'admin')) return '__system__';
    return orgId;
}

// Helper: check if user is org admin
async function requireOrgAdminForN8n(req, res, next) {
    const userId = req.session.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const userStore = require('../../stores/userStore');
    const user = await userStore.getUser(userId);
    // Super admins (global) can always manage n8n config; fall back to '__system__' scope if not in any org
    if (req.session.isAdmin || req.session.user?.role === 'admin') {
        req.orgId = (await resolveUserOrgId(userId)) || '__system__';
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

// GET /ai/n8n/workflow/:workflowId — fetch a single workflow's full definition from n8n
router.get('/n8n/workflow/:workflowId', requireOrgAdminForN8n, async (req, res) => {
    try {
        const orgId = req.orgId;
        const n8nUrl = await configStore.getConfig(`n8n_url_org_${orgId}`);
        const apiKey = await configStore.getSecret(`n8n_api_key_org_${orgId}`);

        if (!n8nUrl || !apiKey) {
            return res.status(400).json({ error: 'n8n URL and API key must be configured first' });
        }

        const workflow = await fetchWorkflowById(n8nUrl, apiKey, req.params.workflowId);
        res.json({ workflow });
    } catch (err) {
        console.error('[n8n] Error fetching workflow:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /ai/n8n/test — verify that the stored creds can reach n8n and count workflows.
// Accepts optional { n8nUrl, apiKey } to test unsaved values from the config form.
router.post('/n8n/test', requireOrgAdminForN8n, async (req, res) => {
    const fetch = require('node-fetch');
    const https = require('https');
    const http = require('http');
    try {
        const orgId = req.orgId;
        const n8nUrl = (req.body?.n8nUrl) || (await configStore.getConfig(`n8n_url_org_${orgId}`));
        const apiKey = (req.body?.apiKey) || (await configStore.getSecret(`n8n_api_key_org_${orgId}`));

        if (!n8nUrl || !apiKey) {
            return res.status(400).json({ ok: false, error: 'URL and API key required' });
        }
        const base = n8nUrl.replace(/\/+$/, '');
        const apiBase = base.includes('/api/v1') ? base : `${base}/api/v1`;
        const agent = n8nUrl.startsWith('http://') ? new http.Agent() : new https.Agent({ rejectUnauthorized: false });

        const r = await fetch(`${apiBase}/workflows?limit=1`, {
            headers: { 'X-N8N-API-KEY': apiKey, 'Content-Type': 'application/json' },
            agent,
            signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) {
            const text = await r.text().catch(() => '');
            return res.json({ ok: false, status: r.status, error: text.slice(0, 200) || `HTTP ${r.status}` });
        }
        // Optional workflow count (active webhooks) — cheap, same endpoint with active=true
        let activeWebhookCount = null;
        try {
            const r2 = await fetch(`${apiBase}/workflows?active=true&limit=250`, {
                headers: { 'X-N8N-API-KEY': apiKey, 'Content-Type': 'application/json' },
                agent,
                signal: AbortSignal.timeout(10000),
            });
            if (r2.ok) {
                const data = await r2.json();
                const arr = data.data || data;
                activeWebhookCount = Array.isArray(arr) ? arr.length : null;
            }
        } catch (_) { /* non-fatal */ }

        res.json({ ok: true, activeWebhookCount });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

const N8N_PERMISSION_IDS = ['use_n8n_tools', 'modify_n8n_workflows'];

// GET /ai/n8n/diagnostics — self-service access check for the current user.
// Returns the full trace of how n8n tool injection would go: which of the three
// gates (user-level, org-level, permission) pass or fail, plus the concrete
// list of tools the LLM will see. Any authenticated user can call this for
// themselves — it only exposes their own state.
router.get('/n8n/diagnostics', requireAuth, async (req, res) => {
    try {
        const userStore = require('../../stores/userStore');
        const { getIntegrationTools } = require('../../core/integrationTools');
        const userId = req.session.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const user = await userStore.getUser(userId);
        const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
        const rawOrgId = user?.organizationId || null;
        const organizationId = rawOrgId || (isSuperAdmin ? '__system__' : null);

        // 1. n8n configured for the user's org?
        let n8nConfigured = false;
        if (organizationId) {
            const url = await configStore.getConfig(`n8n_url_org_${organizationId}`);
            const key = await configStore.getSecret(`n8n_api_key_org_${organizationId}`);
            n8nConfigured = !!(url && key);
        }

        // 2. Org-level integration gating.
        let orgEnabledIntegrations = null;
        let orgGateSource = 'all_enabled';
        if (rawOrgId) {
            const org = await userStore.getOrganization(rawOrgId);
            if (org?.enabledIntegrations) {
                orgEnabledIntegrations = typeof org.enabledIntegrations === 'string'
                    ? JSON.parse(org.enabledIntegrations) : org.enabledIntegrations;
                orgGateSource = 'org_override';
            } else {
                const globalDefaults = await configStore.getConfig('default_org_integrations');
                if (globalDefaults) {
                    orgEnabledIntegrations = typeof globalDefaults === 'string'
                        ? JSON.parse(globalDefaults) : globalDefaults;
                    orgGateSource = 'global_default';
                }
            }
        }
        const orgGatePasses = !orgEnabledIntegrations || orgEnabledIntegrations.includes('n8n');

        // 3. User-level integration gating.
        const userEnabledApps = await configStore.getConfig(`enabled_apps_user_${userId}`);
        let userGateReason, userGatePasses;
        if (!userEnabledApps) {
            userGateReason = 'no_saved_list'; userGatePasses = true;
        } else if (userEnabledApps.includes('n8n')) {
            userGateReason = 'in_saved_list'; userGatePasses = true;
        } else {
            // 'n8n' is in AUTO_ENABLED_APPS so this is true for legacy users with
            // stale lists. Explicitly signal that in the reason.
            userGateReason = 'auto_enabled'; userGatePasses = true;
        }

        // 4. Permission state.
        const { hasPermission } = require('../../auth/permissions');
        const canModify = await hasPermission(userId, 'modify_n8n_workflows', req.session);
        const canUseExplicit = await hasPermission(userId, 'use_n8n_tools', req.session);

        // 5. The real list — ask the registration pipeline what it would hand the LLM.
        let toolsThatWillBeInjected = [];
        try {
            const { tools } = await getIntegrationTools({
                userId, session: req.session, isAdmin: !!req.session.isAdmin, agentConfig: null,
            });
            toolsThatWillBeInjected = (tools || [])
                .map(t => t.function?.name)
                .filter(n => n && (n.startsWith('n8n_workflow_') || n.startsWith('n8n_execution_') || n.startsWith('n8n_run_')));
        } catch (_) { /* non-fatal — if integrationTools throws we still return the gate trace */ }

        const blockingReason =
            !organizationId ? 'no_organization' :
            !n8nConfigured ? 'n8n_not_configured' :
            !orgGatePasses ? 'org_disabled' :
            !userGatePasses ? 'user_disabled' :
            toolsThatWillBeInjected.length === 0 ? 'unknown' :
            null;

        res.json({
            ok: !blockingReason,
            blockingReason,
            user: {
                id: user?.id,
                orgRole: user?.orgRole || null,
                organizationId,
            },
            org: {
                id: organizationId,
                n8nConfigured,
                enabledIntegrationsIncludesN8n: orgGatePasses,
                source: orgGateSource,
            },
            userLevel: {
                passes: userGatePasses,
                reason: userGateReason,
                savedList: userEnabledApps || null,
            },
            permissions: {
                modify_n8n_workflows: canModify,
                use_n8n_tools: canUseExplicit, // informational — now implicit
            },
            toolsThatWillBeInjected,
        });
    } catch (err) {
        console.error('[n8n] Diagnostics failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /ai/n8n/enable-for-org — one-click convenience: ensure 'n8n' is in the
// organisation's enabledIntegrations list. Idempotent — safe to call repeatedly.
// Nothing else is needed: use_n8n_tools is now implicit for all members.
router.post('/n8n/enable-for-org', requireOrgAdminForN8n, async (req, res) => {
    try {
        const userStore = require('../../stores/userStore');
        const orgId = req.orgId;
        if (!orgId) return res.status(400).json({ error: 'No organisation' });

        const org = await userStore.getOrganization(orgId);
        let current = org?.enabledIntegrations;
        if (typeof current === 'string') {
            try { current = JSON.parse(current); } catch (_) { current = null; }
        }
        // If the org has never customised its enabledIntegrations, null means
        // "all enabled" — n8n is already implicit. Leave it alone to preserve
        // that semantics.
        if (!current) {
            return res.json({ success: true, changed: false, enabledIntegrations: null, note: 'Organisation uses the default integration set; n8n is already enabled.' });
        }
        if (current.includes('n8n')) {
            return res.json({ success: true, changed: false, enabledIntegrations: current });
        }
        const next = [...current, 'n8n'];
        await userStore.updateOrganization(orgId, { enabledIntegrations: next });
        res.json({ success: true, changed: true, enabledIntegrations: next });
    } catch (err) {
        console.error('[n8n] enable-for-org failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Count how many users are actually members of each group right now. `groups.userCount`
// is a stale denormalised column (never updated when users move between groups), so we
// recompute it live for anything the admin UI displays.
async function computeGroupUserCounts(groupIds, orgId) {
    const userStore = require('../../stores/userStore');
    const allUsers = await userStore.getAllUsers();
    // Users: filter to the caller's org so super-admins don't see cross-org counts.
    // If orgId is null (super-admin without an org), fall back to counting everyone.
    const scoped = orgId
        ? allUsers.filter(u => !u.organizationId || u.organizationId === orgId)
        : allUsers;
    const counts = Object.fromEntries(groupIds.map(id => [id, 0]));
    for (const u of scoped) {
        let ug = u.groups;
        if (typeof ug === 'string') { try { ug = JSON.parse(ug); } catch (_) { ug = []; } }
        if (!Array.isArray(ug)) continue;
        for (const gid of ug) if (gid in counts) counts[gid]++;
    }
    return counts;
}

// GET /ai/n8n/permissions — return which groups hold each n8n permission, plus the list
// of all groups the admin can grant TO (org-scoped only; global groups are deliberately
// excluded from the picker to avoid cross-org leaks).
router.get('/n8n/permissions', requireOrgAdminForN8n, async (req, res) => {
    try {
        const orgId = req.orgId;
        const userStore = require('../../stores/userStore');
        const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
        const allGroups = await userStore.getAllGroups();

        // Org-scope rule:
        //   - Org admins see + manage groups where organizationId === their own org.
        //   - Super admins additionally see global groups (null organizationId) since
        //     they're the only ones allowed to touch those.
        const visibleGroups = (allGroups || []).filter(g =>
            g.organizationId === orgId || (isSuperAdmin && !g.organizationId)
        );

        const counts = await computeGroupUserCounts(visibleGroups.map(g => g.id), orgId);
        const holdingGroups = (permId) => visibleGroups
            .filter(g => Array.isArray(g.permissions) && g.permissions.includes(permId))
            .map(g => ({ id: g.id, name: g.name, userCount: counts[g.id] ?? 0 }));

        res.json({
            use_n8n_tools: holdingGroups('use_n8n_tools'),
            modify_n8n_workflows: holdingGroups('modify_n8n_workflows'),
            availableGroups: visibleGroups.map(g => ({
                id: g.id,
                name: g.name,
                userCount: counts[g.id] ?? 0,
                isGlobal: !g.organizationId,
            })),
            // Org admins always have both permissions regardless of group membership.
            // Enforced in permissions.js via orgRoles.json → org_admin perms, with
            // legacy orgRole='admin' normalised to 'org_admin' at resolution time.
            orgAdminAlways: true,
            editUrl: '/settings/organisation/users',
        });
    } catch (err) {
        console.error('[n8n] Permissions summary failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// PUT /ai/n8n/permissions — grant or revoke an n8n permission for a specific group.
// Body: { permission: 'use_n8n_tools' | 'modify_n8n_workflows', groupId, action: 'add' | 'remove' }
router.put('/n8n/permissions', requireOrgAdminForN8n, async (req, res) => {
    try {
        const { permission, groupId, action } = req.body || {};
        if (!N8N_PERMISSION_IDS.includes(permission)) {
            return res.status(400).json({ error: `permission must be one of: ${N8N_PERMISSION_IDS.join(', ')}` });
        }
        if (!groupId) return res.status(400).json({ error: 'groupId is required' });
        if (!['add', 'remove'].includes(action)) {
            return res.status(400).json({ error: "action must be 'add' or 'remove'" });
        }

        const userStore = require('../../stores/userStore');
        const { invalidateAllPermissionCaches } = require('../../auth/permissions');
        const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
        const allGroups = await userStore.getAllGroups();
        const group = (allGroups || []).find(g => g.id === groupId);
        if (!group) return res.status(404).json({ error: 'Group not found' });

        // Org-scope guard. A group with no organizationId is GLOBAL — granting a
        // permission to it would grant that permission to users in OTHER orgs too,
        // which an org admin must never be able to do. Only super-admins may edit
        // global groups.
        const orgId = req.orgId;
        if (!group.organizationId) {
            if (!isSuperAdmin) {
                return res.status(403).json({
                    error: 'This is a global group shared across organisations. Only a system administrator can change its permissions.',
                });
            }
        } else if (group.organizationId !== orgId) {
            return res.status(403).json({ error: 'Cannot modify groups in another organisation' });
        }

        const current = Array.isArray(group.permissions) ? [...group.permissions] : [];
        let next;
        if (action === 'add') {
            next = current.includes(permission) ? current : [...current, permission];
        } else {
            next = current.filter(p => p !== permission);
        }

        await userStore.updateGroup(groupId, { permissions: next });
        // Cached permission sets must be invalidated so the new grant takes effect immediately.
        // Without Redis, this clears the in-process Map; WITH Redis it also wipes keys for
        // every logged-in user in the fleet.
        await invalidateAllPermissionCaches();

        res.json({ success: true, groupId, permission, action, permissions: next });
    } catch (err) {
        console.error('[n8n] Permission mutation failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── MCP Server Management ──────────────────────────────────────

const mcpManager = require('../../core/mcpManager');
const crypto = require('crypto');

// MCP Server Marketplace is an Enterprise feature (it was moved out of the
// Community licence — see server/license/tiers.js). Gate every /mcp-servers*
// route below with the licence middleware. Community sessions get a 403
// `feature_locked`; super-admins bypass via the resolver's super-admin path.
//
// Defined ONCE here, immediately above the routes that reference it — do NOT
// redeclare `requireMcp` elsewhere. The crash this fixes was the routes using
// `requireMcp` while its definition/import were never added (a half-applied
// edit), which aborts module load with `ReferenceError: requireMcp is not
// defined` and crash-loops the whole server.
const { requireFeature } = require('../../license/middleware');
const requireMcp = requireFeature('mcp_marketplace');

// GET /ai/mcp-servers — list all configured MCP servers (admin)
router.get('/mcp-servers', requireAuth, requireMcp, async (req, res) => {
    try {
        const servers = await mcpManager.getServersSummary();
        res.json({ servers });
    } catch (err) {
        console.error('[MCP] List servers error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /ai/mcp-servers — add a new MCP server definition (admin)
router.post('/mcp-servers', requireAuth, requireMcp, async (req, res) => {
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
router.post('/mcp-servers/test', requireAuth, requireMcp, async (req, res) => {
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
router.put('/mcp-servers/:id', requireAuth, requireMcp, async (req, res) => {
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
router.delete('/mcp-servers/:id', requireAuth, requireMcp, async (req, res) => {
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
router.post('/mcp-servers/:id/refresh', requireAuth, requireMcp, async (req, res) => {
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
router.get('/mcp-servers/user-credentials', requireAuth, requireMcp, async (req, res) => {
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
router.post('/mcp-servers/user-credentials', requireAuth, requireMcp, async (req, res) => {
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
