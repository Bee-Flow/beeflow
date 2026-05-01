/**
 * AI Agent for Component Design
 * Multi-provider AI API - configurable via webapp
 * Supports: Mistral AI, OpenAI, and any OpenAI-compatible provider
 */

const fs = require('fs');
const path = require('path');
const agentStore = require('../stores/agentStore');
const configStore = require('../stores/configStore');

// Config is now managed via configStore
// Backward compatibility placeholders are kept for the API

// ─── Model Cache (60s TTL) ──────────────────────────────────────
const MODEL_CACHE_TTL = 60; // seconds
const _modelCache = new Map(); // in-memory fallback: providerId → { models: [], timestamp }
const { getRedis } = require('../db');

const PROVIDER_PRESETS = {
    mistral: { name: 'Mistral AI', url: 'https://api.mistral.ai/v1', needsApiKey: true },
    openai: { name: 'OpenAI', url: 'https://api.openai.com/v1', needsApiKey: true },
    claude: { name: 'Claude', url: 'https://api.anthropic.com/v1', needsApiKey: true },
    google: { name: 'Google AI', url: 'https://generativelanguage.googleapis.com', needsApiKey: true },
    'google-vertex': { name: 'Google Vertex AI', url: 'vertex-ai', needsApiKey: false },
    azure: { name: 'Azure AI', url: 'https://your-resource.openai.azure.com', needsApiKey: true },
    minimax: { name: 'MiniMax', url: 'https://api.minimax.io/v1', needsApiKey: true },
};

// Reverse lookup: display name → model ID (for agents saved with human-readable names)
const DISPLAY_NAME_TO_ID = {
    // Mistral models
    'Mistral Large 3': 'mistral-large-latest',
    'Mistral Large 2.1': 'mistral-large-2411',
    'Mistral Medium 3.1': 'mistral-medium-latest',
    'Mistral Small 3.1': 'mistral-small-latest',
    'Mistral Small 3.2': 'mistral-small-latest',
    'Codestral': 'codestral-latest',
    'Devstral': 'devstral-latest',
    'Devstral Small': 'devstral-small-latest',
    'Ministral 3 3B': 'ministral-3b-latest',
    'Ministral 3 8B': 'ministral-8b-latest',
    'Ministral 14B': 'ministral-14b-latest',
    'Mistral Embed': 'mistral-embed',
    'Mistral OCR': 'mistral-ocr-latest',
    'Pixtral Large': 'pixtral-large-latest',
    'Magistral Small 1.2': 'magistral-small-latest',
    // OpenAI models
    'GPT-5.2': 'gpt-5.2',
    'GPT-5.2 Pro': 'gpt-5.2-pro',
    'GPT-5 Mini': 'gpt-5-mini',
    'GPT-4o': 'gpt-4o',
    'GPT-4o Mini': 'gpt-4o-mini',
    'GPT-4.1': 'gpt-4.1',
    'GPT-4.1 Mini': 'gpt-4.1-mini',
    'GPT-4.1 Nano': 'gpt-4.1-nano',
    'o3': 'o3',
    'o3 Mini': 'o3-mini',
    'o4 Mini': 'o4-mini',
    // Claude models
    'Claude Opus 4.7': 'claude-opus-4-7',
    'Claude Opus 4.6': 'claude-opus-4-6',
    'Claude Sonnet 4.6': 'claude-sonnet-4-6',
    'Claude Haiku 4.5': 'claude-haiku-4-5',
    // Google models
    'Gemini 3.1 Pro': 'gemini-3.1-pro-preview',
    'Gemini 3 Flash': 'gemini-3-flash-preview',
    'Gemini 3.1 Flash Image': 'gemini-3.1-flash-image-preview',
    'Gemini 3 Pro Image': 'gemini-3-pro-image-preview',
};

/**
 * Resolve a model identifier to a valid API model ID.
 * Handles display names, aliases, and already-valid IDs.
 */
function resolveModelId(modelNameOrId) {
    if (!modelNameOrId) return null;
    // If it's already a valid-looking model ID (alphanumeric with dashes/dots/underscores), return as-is
    if (/^[a-zA-Z0-9._-]+$/.test(modelNameOrId)) return modelNameOrId;
    // Try reverse lookup
    return DISPLAY_NAME_TO_ID[modelNameOrId] || modelNameOrId;
}

// Default configuration (backward compatible)
const DEFAULT_CONFIG = {
    url: 'https://api.mistral.ai/v1',
    model: 'ministral-8b-latest',
    apikey: '',
    lakeraApiKey: '',
    regexGuardrails: null,
    llamaGuardConfig: null,
    moderationProvider: 'llamaguard',
    azureContentSafetySeverityThreshold: 2,
    azureContentSafetyCategories: null,
    piiDetectionEnabled: false,
    piiDetectionCategories: null,
    piiDetectionConfidenceThreshold: 0.7,
    providers: [],
    defaultProviderId: null
};

// Get full config from configStore
async function getFullConfig() {
    return await configStore.getConfig('ai') || {};
}

// Get AI config (returns the default/active provider config for backward compatibility)
async function getAIConfig() {
    try {
        const ai = await configStore.getConfig('ai') || {};

        // If we have providers, return the default one
        if (ai.providers && ai.providers.length > 0 && ai.defaultProviderId) {
            const defaultProvider = ai.providers.find(p => p.id === ai.defaultProviderId);
            if (defaultProvider) {
                return {
                    url: defaultProvider.url || DEFAULT_CONFIG.url,
                    model: defaultProvider.model || DEFAULT_CONFIG.model,
                    apiKey: await configStore.getSecret('mistral_api_key') || defaultProvider.apiKey || DEFAULT_CONFIG.apiKey,
                    lakeraApiKey: ai.lakeraApiKey || DEFAULT_CONFIG.lakeraApiKey,
                    mistralOcrApiKey: ai.mistralOcrApiKey || null,
                    regexGuardrails: ai.regexGuardrails || null,
                    llamaGuardConfig: ai.llamaGuardConfig || null,
                    moderationProvider: ai.moderationProvider || 'llamaguard',
                    azureContentSafetySeverityThreshold: ai.azureContentSafetySeverityThreshold ?? 2,
                    azureContentSafetyCategories: ai.azureContentSafetyCategories || null,
                    piiDetectionEnabled: ai.piiDetectionEnabled || false,
                    piiDetectionCategories: ai.piiDetectionCategories || null,
                    piiDetectionConfidenceThreshold: ai.piiDetectionConfidenceThreshold ?? 0.7,
                    piiDetectionAction: ai.piiDetectionAction || 'block',
                    piiDetectionScope: ai.piiDetectionScope || { userInput: true, agentOutput: false },
                    embeddingModel: ai.embeddingModel || null,
                    embeddingProviderId: ai.embeddingProviderId || null
                };
            }
        }

        // Fallback to legacy single-provider config
        return {
            url: ai.url || DEFAULT_CONFIG.url,
            model: ai.model || DEFAULT_CONFIG.model,
            apiKey: await configStore.getSecret('mistral_api_key') || ai.apiKey || DEFAULT_CONFIG.apiKey,
            lakeraApiKey: ai.lakeraApiKey || DEFAULT_CONFIG.lakeraApiKey,
            mistralOcrApiKey: ai.mistralOcrApiKey || null,
            regexGuardrails: ai.regexGuardrails || null,
            llamaGuardConfig: ai.llamaGuardConfig || null,
            moderationProvider: ai.moderationProvider || 'llamaguard',
            azureContentSafetySeverityThreshold: ai.azureContentSafetySeverityThreshold ?? 2,
            azureContentSafetyCategories: ai.azureContentSafetyCategories || null,
            piiDetectionEnabled: ai.piiDetectionEnabled || false,
            piiDetectionCategories: ai.piiDetectionCategories || null,
            piiDetectionConfidenceThreshold: ai.piiDetectionConfidenceThreshold ?? 0.7,
            piiDetectionAction: ai.piiDetectionAction || 'block',
            piiDetectionScope: ai.piiDetectionScope || { userInput: true, agentOutput: false },
            embeddingModel: ai.embeddingModel || null,
            embeddingProviderId: ai.embeddingProviderId || null
        };
    } catch (e) {
        return DEFAULT_CONFIG;
    }
}

// Save AI config to configStore (backward compatible)
async function saveAIConfig(aiConfig) {
    try {
        // Save Mistral API key to database (legacy field)
        if (aiConfig.apiKey !== undefined) {
            await configStore.setSecret('mistral_api_key', aiConfig.apiKey || '');
        }
        // Save Mistral API key via named field (new card format)
        if (aiConfig.mistralApiKey !== undefined) {
            await configStore.setSecret('mistral_api_key', aiConfig.mistralApiKey || '');
        }

        // Save OpenAI API key to database
        if (aiConfig.openaiApiKey !== undefined) {
            await configStore.setSecret('openai_api_key', aiConfig.openaiApiKey || '');
        }

        // Save Claude API key to database
        if (aiConfig.claudeApiKey !== undefined) {
            await configStore.setSecret('claude_api_key', aiConfig.claudeApiKey || '');
        }

        // Save Google API key to database
        if (aiConfig.googleApiKey !== undefined) {
            await configStore.setSecret('google_api_key', aiConfig.googleApiKey || '');
        }

        // Save ElevenLabs API key to database
        if (aiConfig.elevenlabsApiKey !== undefined) {
            await configStore.setSecret('elevenlabs_api_key', aiConfig.elevenlabsApiKey || '');
        }

        // Save Google Vertex AI config to database
        if (aiConfig.googleVertexProject !== undefined) {
            await configStore.setConfig('google_vertex_project', aiConfig.googleVertexProject || '');
        }
        if (aiConfig.googleVertexLocation !== undefined) {
            await configStore.setConfig('google_vertex_location', aiConfig.googleVertexLocation || '');
        }
        if (aiConfig.googleVertexServiceAccountKey !== undefined) {
            await configStore.setSecret('google_vertex_service_account_key', aiConfig.googleVertexServiceAccountKey || '');
        }

        // Save MiniMax API key to database
        if (aiConfig.minimaxApiKey !== undefined) {
            await configStore.setSecret('minimax_api_key', aiConfig.minimaxApiKey || '');
        }

        // Save Azure AI config to database
        if (aiConfig.azureEndpoint !== undefined) {
            await configStore.setConfig('azure_endpoint', aiConfig.azureEndpoint || '');
        }
        if (aiConfig.azureApiKey !== undefined) {
            await configStore.setSecret('azure_api_key', aiConfig.azureApiKey || '');
        }
        if (aiConfig.azureApiVersion !== undefined) {
            await configStore.setConfig('azure_api_version', aiConfig.azureApiVersion || '');
        }

        const ai = await configStore.getConfig('ai') || {};

        const updatedAi = {
            ...ai,
            url: aiConfig.url || DEFAULT_CONFIG.url,
            model: aiConfig.model || DEFAULT_CONFIG.model,
            lakeraApiKey: aiConfig.lakeraApiKey || '',
            regexGuardrails: aiConfig.regexGuardrails || null,
            llamaGuardConfig: aiConfig.llamaGuardConfig || null,
            moderationProvider: aiConfig.moderationProvider || ai.moderationProvider || 'llamaguard',
            azureContentSafetySeverityThreshold: aiConfig.azureContentSafetySeverityThreshold ?? ai.azureContentSafetySeverityThreshold ?? 2,
            azureContentSafetyCategories: aiConfig.azureContentSafetyCategories !== undefined ? aiConfig.azureContentSafetyCategories : ai.azureContentSafetyCategories || null,
            piiDetectionEnabled: aiConfig.piiDetectionEnabled !== undefined ? aiConfig.piiDetectionEnabled : ai.piiDetectionEnabled || false,
            piiDetectionCategories: aiConfig.piiDetectionCategories !== undefined ? aiConfig.piiDetectionCategories : ai.piiDetectionCategories || null,
            piiDetectionConfidenceThreshold: aiConfig.piiDetectionConfidenceThreshold ?? ai.piiDetectionConfidenceThreshold ?? 0.7,
            piiDetectionAction: aiConfig.piiDetectionAction !== undefined ? aiConfig.piiDetectionAction : ai.piiDetectionAction || 'block',
            piiDetectionScope: aiConfig.piiDetectionScope !== undefined ? aiConfig.piiDetectionScope : ai.piiDetectionScope || { userInput: true, agentOutput: false },
            embeddingModel: aiConfig.embeddingModel || null,
            embeddingProviderId: aiConfig.embeddingProviderId || null
        };

        await configStore.setConfig('ai', updatedAi);

        // Ensure default providers exist after saving
        await ensureDefaultProvider();
        await ensureMistralProvider();
        await ensureOpenAIProvider();
        await ensureClaudeProvider();
        await ensureGoogleProvider();
        await ensureGoogleVertexProvider();
        await ensureAzureProvider();
        await ensureMinimaxProvider();

        return true;
    } catch (e) {
        console.error('Failed to save AI config:', e);
        return false;
    }
}

// ============ Provider Management ============

/**
 * Auto-create a default Mistral provider if API key exists but no providers are configured.
 * This bridges the gap between the legacy single-key config and the provider-based model listing.
 */
async function ensureDefaultProvider() {
    const ai = await configStore.getConfig('ai') || {};
    const mistralApiKey = await configStore.getSecret('mistral_api_key');

    if ((!ai.providers || ai.providers.length === 0) && mistralApiKey) {
        ai.providers = [{
            id: 'mistral-default',
            name: 'Mistral AI',
            type: 'mistral',
            url: 'https://api.mistral.ai/v1',
            model: ai.model || 'ministral-8b-latest',
            apiKey: mistralApiKey
        }];
        ai.defaultProviderId = 'mistral-default';
        await configStore.setConfig('ai', ai);
        console.log('[AIAgent] Auto-created default Mistral provider');
    }
}

/**
 * Auto-create or update a Mistral provider when a Mistral API key is configured.
 * This follows the same pattern as ensureOpenAIProvider/ensureClaudeProvider.
 */
async function ensureMistralProvider() {
    const ai = await configStore.getConfig('ai') || {};
    const mistralApiKey = await configStore.getSecret('mistral_api_key');

    if (!mistralApiKey) return;

    if (!ai.providers) ai.providers = [];

    const existing = ai.providers.find(p => p.id === 'mistral-default');
    if (existing) {
        // Update key if changed
        existing.apiKey = mistralApiKey;
    } else {
        // Create new Mistral provider
        ai.providers.push({
            id: 'mistral-default',
            name: 'Mistral AI',
            type: 'mistral',
            url: 'https://api.mistral.ai/v1',
            model: '',
            apiKey: mistralApiKey
        });
        console.log('[AIAgent] Auto-created default Mistral provider');
    }
    await configStore.setConfig('ai', ai);
}

/**
 * Auto-create or update an OpenAI provider when an OpenAI API key is configured.
 */
async function ensureOpenAIProvider() {
    const ai = await configStore.getConfig('ai') || {};
    const openaiApiKey = await configStore.getSecret('openai_api_key');

    if (!openaiApiKey) return;

    if (!ai.providers) ai.providers = [];

    const existing = ai.providers.find(p => p.id === 'openai-default');
    if (existing) {
        // Update key if changed
        existing.apiKey = openaiApiKey;
    } else {
        // Create new OpenAI provider
        ai.providers.push({
            id: 'openai-default',
            name: 'OpenAI',
            type: 'openai',
            url: 'https://api.openai.com/v1',
            model: '',
            apiKey: openaiApiKey
        });
        console.log('[AIAgent] Auto-created default OpenAI provider');
    }
    await configStore.setConfig('ai', ai);
}

/**
 * Auto-create or update a Claude provider when a Claude API key is configured.
 */
async function ensureClaudeProvider() {
    const ai = await configStore.getConfig('ai') || {};
    const claudeApiKey = await configStore.getSecret('claude_api_key');

    if (!claudeApiKey) return;

    if (!ai.providers) ai.providers = [];

    const existing = ai.providers.find(p => p.id === 'claude-default');
    if (existing) {
        existing.apiKey = claudeApiKey;
        existing.url = 'https://api.anthropic.com/v1';  // ensure correct URL
    } else {
        ai.providers.push({
            id: 'claude-default',
            name: 'Claude',
            type: 'claude',
            url: 'https://api.anthropic.com/v1',
            model: '',
            apiKey: claudeApiKey
        });
        console.log('[AIAgent] Auto-created default Claude provider');
    }
    await configStore.setConfig('ai', ai);
}

/**
 * Auto-create or update a Google provider when a Google API key is configured.
 */
async function ensureGoogleProvider() {
    const ai = await configStore.getConfig('ai') || {};
    const googleApiKey = await configStore.getSecret('google_api_key');

    if (!googleApiKey) return;

    if (!ai.providers) ai.providers = [];

    const existing = ai.providers.find(p => p.id === 'google-default');
    if (existing) {
        existing.apiKey = googleApiKey;
        existing.url = 'https://generativelanguage.googleapis.com';
    } else {
        ai.providers.push({
            id: 'google-default',
            name: 'Google AI',
            type: 'google',
            url: 'https://generativelanguage.googleapis.com',
            model: '',
            apiKey: googleApiKey
        });
        console.log('[AIAgent] Auto-created default Google provider');
    }
    await configStore.setConfig('ai', ai);
}

/**
 * Auto-create or update a Google Vertex AI provider when project config is set.
 */
async function ensureGoogleVertexProvider() {
    const ai = await configStore.getConfig('ai') || {};
    const project = await configStore.getConfig('google_vertex_project');

    if (!project) return;

    if (!ai.providers) ai.providers = [];

    const location = await configStore.getConfig('google_vertex_location') || 'europe-west4';

    const existing = ai.providers.find(p => p.id === 'google-vertex-default');
    if (existing) {
        existing.project = project;
        existing.location = location;
        existing.serviceAccountKey = await configStore.getSecret('google_vertex_service_account_key') || '';
    } else {
        ai.providers.push({
            id: 'google-vertex-default',
            name: 'Google Vertex AI',
            type: 'google-vertex',
            url: 'vertex-ai',
            model: '',
            apiKey: '',
            project,
            location,
            serviceAccountKey: await configStore.getSecret('google_vertex_service_account_key') || ''
        });
        console.log('[AIAgent] Auto-created default Google Vertex AI provider');
    }
    await configStore.setConfig('ai', ai);
}

/**
 * Auto-create or update an Azure AI provider when endpoint + key are set.
 */
/**
 * Auto-create or update a MiniMax provider when a MiniMax API key is configured.
 */
async function ensureMinimaxProvider() {
    const ai = await configStore.getConfig('ai') || {};
    const minimaxApiKey = await configStore.getSecret('minimax_api_key');

    if (!minimaxApiKey) return;

    if (!ai.providers) ai.providers = [];

    const existing = ai.providers.find(p => p.id === 'minimax-default');
    if (existing) {
        existing.apiKey = minimaxApiKey;
        existing.url = 'https://api.minimax.io/v1';
    } else {
        ai.providers.push({
            id: 'minimax-default',
            name: 'MiniMax',
            type: 'minimax',
            url: 'https://api.minimax.io/v1',
            model: '',
            apiKey: minimaxApiKey
        });
        console.log('[AIAgent] Auto-created default MiniMax provider');
    }
    await configStore.setConfig('ai', ai);
}

async function ensureAzureProvider() {
    const ai = await configStore.getConfig('ai') || {};
    const endpoint = await configStore.getConfig('azure_endpoint');
    const apiKey = await configStore.getSecret('azure_api_key');

    if (!endpoint || !apiKey) return;

    if (!ai.providers) ai.providers = [];

    const apiVersion = await configStore.getConfig('azure_api_version') || '2025-04-01-preview';

    const existing = ai.providers.find(p => p.id === 'azure-default');
    if (existing) {
        existing.url = endpoint;
        existing.apiKey = apiKey;
        existing.apiVersion = apiVersion;
    } else {
        ai.providers.push({
            id: 'azure-default',
            name: 'Azure AI',
            type: 'azure',
            url: endpoint,
            model: '',
            apiKey,
            apiVersion,
        });
        console.log('[AIAgent] Auto-created default Azure AI provider');
    }
    await configStore.setConfig('ai', ai);
}

async function getProviders() {
    await ensureDefaultProvider();
    const config = await getFullConfig();
    return {
        providers: config.providers || [],
        defaultProviderId: config.defaultProviderId || null,
        presets: PROVIDER_PRESETS
    };
}

async function addProvider(provider) {
    try {
        const ai = await configStore.getConfig('ai') || {};
        if (!ai.providers) ai.providers = [];

        const id = provider.id || `provider-${Date.now()}`;
        const newProvider = {
            id,
            name: provider.name,
            type: provider.type || 'openai-compatible',
            url: provider.url,
            model: provider.model || '',
            apiKey: provider.apiKey || '',
        };
        // Vertex AI specific fields
        if (provider.project) newProvider.project = provider.project;
        if (provider.location) newProvider.location = provider.location;
        if (provider.serviceAccountKey) newProvider.serviceAccountKey = provider.serviceAccountKey;
        // Azure specific fields
        if (provider.apiVersion) newProvider.apiVersion = provider.apiVersion;

        ai.providers.push(newProvider);

        // Set as default if it's the first provider
        if (ai.providers.length === 1) {
            ai.defaultProviderId = id;
        }

        await configStore.setConfig('ai', ai);
        return newProvider;
    } catch (e) {
        console.error('Failed to add provider:', e);
        return null;
    }
}

async function updateProvider(providerId, updates) {
    try {
        const ai = await configStore.getConfig('ai') || {};
        if (!ai.providers) return false;

        const index = ai.providers.findIndex(p => p.id === providerId);
        if (index === -1) return false;

        // Update provider fields (don't overwrite apiKey if empty)
        const existing = ai.providers[index];
        ai.providers[index] = {
            ...existing,
            name: updates.name !== undefined ? updates.name : existing.name,
            type: updates.type !== undefined ? updates.type : existing.type,
            url: updates.url !== undefined ? updates.url : existing.url,
            model: updates.model !== undefined ? updates.model : existing.model,
            apiKey: updates.apiKey || existing.apiKey,
            project: updates.project !== undefined ? updates.project : existing.project,
            location: updates.location !== undefined ? updates.location : existing.location,
            serviceAccountKey: updates.serviceAccountKey !== undefined ? updates.serviceAccountKey : existing.serviceAccountKey,
            apiVersion: updates.apiVersion !== undefined ? updates.apiVersion : existing.apiVersion,
        };

        await configStore.setConfig('ai', ai);
        return true;
    } catch (e) {
        console.error('Failed to update provider:', e);
        return false;
    }
}

async function deleteProvider(providerId) {
    try {
        const ai = await configStore.getConfig('ai') || {};
        if (!ai.providers) return false;

        ai.providers = ai.providers.filter(p => p.id !== providerId);

        // If we deleted the default, set a new default
        if (ai.defaultProviderId === providerId) {
            ai.defaultProviderId = ai.providers[0]?.id || null;
        }

        await configStore.setConfig('ai', ai);
        return true;
    } catch (e) {
        console.error('Failed to delete provider:', e);
        return false;
    }
}

async function setDefaultProvider(providerId) {
    try {
        const ai = await configStore.getConfig('ai') || {};

        // Verify provider exists
        if (ai.providers && !ai.providers.find(p => p.id === providerId)) {
            return false;
        }

        ai.defaultProviderId = providerId;
        await configStore.setConfig('ai', ai);
        return true;
    } catch (e) {
        console.error('Failed to set default provider:', e);
        return false;
    }
}

// System prompt for the Component Designer is now loaded from the DB (seeded from prompts/component-designer.md).
// This fallback is only used if the system agent doesn't exist in the DB.
const SYSTEM_PROMPT_FALLBACK = 'You are a BeeFlow component designer. You create and maintain Node.js workflow components.';

const _UNUSED_LEGACY_PROMPT_REMOVED = `Legacy prompt removed — see server/stores/agent/prompts/component-designer.md

## Core Rules
1. **Generate immediately** -- never ask clarifying questions unless truly ambiguous. Make sensible defaults.
2. **Never ask permission** -- NEVER say "Would you like to proceed?" or "Shall I test this?". Just do it.
3. **Keep explanations brief** -- the chat is compact. Use short bullet points, not paragraphs.
4. **Minimize tool call rounds** -- generate the full component JSON in your first response. If you need to research credentials, search first, then generate the component in the same cycle.
5. **Use flat inputs only** -- every input must be \\'string\\', \\'number\\', or \\'boolean\\'. NEVER use \\'object\\' or \\'array\\' for inputs. Users fill these via a simple form with text fields. If a service needs multiple credentials (e.g., client_id + client_secret + refresh_token), create a SEPARATE string input for each one.
6. **Use parallel tool calls** -- when multiple tool calls are independent (e.g., creating a component and searching for docs), call them in the same response. The system supports parallel execution.

## Component JSON Format
Respond with a JSON code block. The system auto-parses it.
\`\`\`json
{
  "id": "kebab-case-id",
  "name": "Human Name",
  "description": "One-line summary of what it does",
  "category": "Category/Subcategory",
  "inputs": {
    "url": { "type": "string", "label": "API URL", "description": "Endpoint to call", "required": true },
    "timeout": { "type": "number", "label": "Timeout (ms)", "default": 5000 },
    "method": { "type": "string", "label": "HTTP Method", "default": "GET", "options": ["GET", "POST", "PUT", "DELETE"] },
    "apiKey": { "type": "string", "label": "API Key", "secure": true }
  },
  "outputs": {
    "result": { "type": "object", "label": "Result", "description": "Parsed response body" },
    "statusCode": { "type": "number", "label": "Status Code" },
    "success": { "type": "boolean", "label": "Success" }
  },
  "dependencies": { "axios": "^1.7.0" },
  "code": "... (see Code Pattern below)"
}
\`\`\`

## Code Pattern
Components are standalone Node.js scripts. They receive JSON via stdin and must output JSON via stdout.

\`\`\`javascript
const fs = require('fs');
// const axios = require('axios'); // if needed

async function main() {
  const inputs = JSON.parse(fs.readFileSync(0, 'utf-8'));

  // --- Validate required inputs ---
  if (!inputs.url) throw new Error("'url' is required");

  // --- Component logic ---
  const result = { success: true };

  // --- Output ---
  console.log(JSON.stringify(result));
}

main().catch(e => {
  process.stderr.write(e.message);
  process.exit(1);
});
\`\`\`

Key rules:
- Use \`fs.readFileSync(0, 'utf-8')\` to read stdin (preferred) or the event listener pattern
- Output a single \`JSON.stringify()\` to stdout via \`console.log()\`
- Errors: write to stderr + \`process.exit(1)\`
- Use \`require()\` for dependencies listed in the JSON
- Never use ES module syntax (\`import\`/\`export\`)

## Input Field Properties
| Property | Type | Purpose |
|----------|------|---------|
| type | string | \`string\`, \`number\`, \`boolean\` only — never use object/array |
| label | string | Human-readable name for the UI |
| description | string | Help text shown in the UI |
| required | boolean | Whether the input must be provided |
| default | any | Default value if not provided |
| options | array | Dropdown choices (e.g., \`["GET","POST"]\`) |
| secure | boolean | Masks the value in UI (for API keys, passwords) |

## Workflow: Create -> Test -> Define Outputs (AUTOMATIC — do all steps, never ask)
1. Generate the component JSON — the system creates it automatically
2. Immediately call \`execute_component\` with realistic sample inputs
3. Call \`configure_outputs_interaction\` with the result so the user can pick output fields

## System Tools
- \`execute_component(componentId, inputs)\` -- Run any component with test inputs
- \`configure_outputs_interaction(componentId, sampleOutput)\` -- Show UI for user to pick output fields
- \`read_component_files(componentId)\` -- Read source files before modifying
- \`update_component(componentId, files)\` -- Write updated files (e.g., \`{ "index.js": "..." }\`)
- \`update_component_outputs(componentId, outputs, sampleOutput)\` -- Update output schema directly

## Modifying Existing Components
When asked to modify a component:
1. First call \`read_component_files\` to see the current code
2. Make changes and call \`update_component\`
3. Test with \`execute_component\`

## Credentials & Security — CRITICAL

### Step 1: Research if unsure
If you don't know how to obtain credentials for a service, **use your search tools first** (e.g., tavily) to look up "how to get [service name] API key" BEFORE generating the component.

### Step 2: Generate the component
Generate the full component JSON. Each credential gets its OWN input with \`"type": "string"\` and \`"secure": true\`. The \`"description"\` MUST explain step-by-step where to find or generate the value, including the exact URL.

### Component credential input rules:
- Each credential gets its OWN input with \`"type": "string"\` and \`"secure": true\`
- NEVER use \`object\` or \`array\` type for credential inputs
- The \`"description"\` MUST explain where to get the value
- Put credentials at the TOP of the inputs object
- **Never hardcode** credentials in the component code — always read from inputs
- **Prefer API keys** over OAuth when the service supports it

## Nextcloud Components
Components with category \`Nextcloud/*\` receive injected credentials automatically: \`_accessToken\`, \`_nextcloudUrl\`, \`_appPasswordUsername\`, \`_appPassword\`. These are provided by the platform at runtime — do NOT add them as user-facing inputs.

## Categories
Use hierarchical categories: \`API\`, \`AI/Tools\`, \`Data/Transform\`, \`Nextcloud/Files\`, \`Utils/Date & Time\`, \`Notifications\`, etc.`;

class AIAgent {
    constructor() {
        this.conversationHistory = [];
        this.enabledTools = []; // Component IDs that can be used as tools
        this.toolCalls = []; // Track tool executions for UI display
    }

    // Set which tools/components the agent can use
    setEnabledTools(componentIds) {
        this.enabledTools = componentIds || [];
    }

    // Get tools in OpenAI format for enabled components
    async getToolsForRequest() {
        // ALWAYS include System Tools for the AI Agent
        const { componentToTool, SYSTEM_TOOLS } = require('./agentRuntime');
        const componentManager = require('./componentManager');

        let tools = [];

        // Load tools from the Component Designer system agent configuration
        try {
            const designerAgentId = 'system-component-designer';
            const agentToolIds = await agentStore.getAgentTools(designerAgentId);

            if (agentToolIds && agentToolIds.length > 0) {
                console.log('[AIAgent] Loading tools from designer agent config:', agentToolIds);
                const allComponents = componentManager.getComponents();
                const designerComponents = allComponents.filter(c =>
                    agentToolIds.includes(c.id) && c.definition?.agentEnabled !== false
                );
                tools.push(...designerComponents.map(componentToTool));
            }
        } catch (e) {
            console.warn('[AIAgent] Failed to load designer agent tools:', e.message);
        }

        // Add enabled components (from frontend selection, if any)
        if (this.enabledTools.length > 0) {
            const allComponents = componentManager.getComponents();
            const enabledComponents = allComponents.filter(c =>
                this.enabledTools.includes(c.id) && c.definition?.agentEnabled !== false
            );
            tools.push(...enabledComponents.map(componentToTool));
        }

        // Add System Tools (execute_component, update_component etc)
        if (SYSTEM_TOOLS) {
            tools.push(...SYSTEM_TOOLS);
        }

        console.log('[AIAgent] Total tools for request:', tools.length);

        return tools;
    }

    async chat(userMessage, tools = null, context = {}, onProgress = null) {
        // Get current config
        const config = await getAIConfig();

        // Update enabled tools if provided
        if (tools !== null) {
            this.setEnabledTools(tools);
        }

        // Update context
        this.currentContext = context || {};

        // Add user message to history
        this.conversationHistory.push({
            role: 'user',
            content: userMessage
        });

        // Reset tool calls for this request
        this.toolCalls = [];

        try {
            return await this._chatLoop(config, onProgress);
        } catch (error) {
            console.error('AI Agent error:', error);
            throw error;
        }
    }

    async _chatLoop(config, onProgress = null) {
        const maxIterations = 20;
        let iterations = 0;
        const tools = await this.getToolsForRequest();
        const emit = (type, detail) => { if (onProgress) onProgress({ type, detail }); };

        while (iterations < maxIterations) {
            iterations++;

            // Emit thinking status
            emit('thinking', { iteration: iterations });

            const headers = {
                'Content-Type': 'application/json'
            };

            if (config.apiKey) {
                headers['Authorization'] = `Bearer ${config.apiKey}`;
            }

            // Dynamic System Prompt — loaded from DB system agent, with context override
            let currentSystemPrompt = SYSTEM_PROMPT_FALLBACK;

            if (this.currentContext?.systemPrompt) {
                // Allow manual override via context
                currentSystemPrompt = this.currentContext.systemPrompt;
            } else {
                // Load from system agent DB entry
                try {
                    const designerAgent = await agentStore.getSystemAgent('system-component-designer');
                    if (designerAgent) {
                        if (designerAgent.system_prompt) currentSystemPrompt = designerAgent.system_prompt;
                        if (designerAgent.model) config.model = designerAgent.model;
                    }
                } catch (e) {
                    console.warn('[AIAgent] Failed to load designer agent config:', e.message);
                }
            }

            if (this.currentContext?.componentId) {
                currentSystemPrompt += `\n\n## CURRENT CONTEXT\nYou are currently editing component with ID: "${this.currentContext.componentId}".\nUse the 'read_component_files' tool to examine its current code before making changes.\nUse 'update_component' to apply verified changes.`;
            }

            const requestBody = {
                model: config.model,
                messages: [
                    { role: 'system', content: currentSystemPrompt },
                    ...this.conversationHistory
                ],
                temperature: 0.7,
                max_tokens: 8000
            };

            // Add tools if any are enabled
            if (tools.length > 0) {
                requestBody.tools = tools;
                requestBody.tool_choice = 'auto';
            }

            // Build API URL - handle providers with trailing slashes or /v1 in URL
            let apiUrl = config.url.replace(/\/+$/, ''); // Remove trailing slashes
            if (!apiUrl.endsWith('/v1')) {
                apiUrl = `${apiUrl}/v1`;
            }

            const response = await fetch(`${apiUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Mistral API error: ${response.status} - ${error}`);
            }

            const data = await response.json();
            const assistantMessage = data.choices[0].message;

            // Debug logging
            console.log('[AIAgent] Response received:', {
                hasContent: !!assistantMessage.content,
                contentLength: assistantMessage.content?.length || 0,
                hasToolCalls: !!(assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0),
                toolCallCount: assistantMessage.tool_calls?.length || 0
            });

            // Check if there are tool calls to execute
            if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                // Add assistant message with tool calls to history
                this.conversationHistory.push(assistantMessage);

                // Execute all tool calls in parallel
                const { executeComponentTool } = require('./agentRuntime');
                console.log(`[AIAgent] Executing ${assistantMessage.tool_calls.length} tools in parallel...`);

                const toolExecutionPromises = assistantMessage.tool_calls.map(async (toolCall) => {
                    const toolName = toolCall.function.name;
                    let toolArgs = {};

                    try {
                        toolArgs = JSON.parse(toolCall.function.arguments || '{}');
                    } catch (e) {
                        toolArgs = {};
                    }

                    console.log(`[AIAgent] Executing tool: ${toolName}`, toolArgs);
                    emit('tool', { name: toolName, args: toolArgs });

                    const toolResult = await executeComponentTool(toolName, toolArgs, {}, null);
                    return { toolCall, toolName, toolArgs, toolResult };
                });

                const toolResults = await Promise.all(toolExecutionPromises);

                // Process results in order
                for (const { toolCall, toolName, toolArgs, toolResult } of toolResults) {
                    this.toolCalls.push({
                        name: toolName,
                        args: toolArgs,
                        result: toolResult
                    });

                    this.conversationHistory.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
                    });
                }

                // Continue the loop to get next response
                continue;
            }

            // No tool calls - we have the final response
            let content = assistantMessage.content;

            // Handle empty content (sometimes AI returns null/empty)
            if (!content || content.trim() === '') {
                console.warn('[AIAgent] Received empty content from AI, providing fallback');
                content = "I'm ready to help you create a component. Please describe what you need.";
            }

            this.conversationHistory.push({
                role: 'assistant',
                content: content
            });

            // Try to extract component JSON if present
            emit('finalizing', {});
            const componentData = this.extractComponentData(content);

            return {
                message: content,
                component: componentData,
                toolCalls: this.toolCalls,
                conversationLength: this.conversationHistory.length
            };
        }

        throw new Error('AI Agent exceeded maximum tool call iterations');
    }

    extractComponentData(message) {
        // Handle null/undefined message
        if (!message) return null;

        // Try multiple patterns for JSON code blocks
        const patterns = [
            /```json\s*\n([\s\S]*?)\n```/,           // Standard: ```json\n...\n```
            /```json\s*([\s\S]*?)```/,               // No newline after json
            /```\s*\n?\s*(\{[\s\S]*?"code"[\s\S]*?\})\s*```/,  // Generic code block with component
        ];

        for (const pattern of patterns) {
            const match = message.match(pattern);
            if (match) {
                try {
                    const jsonStr = match[1].trim();
                    const data = JSON.parse(jsonStr);
                    // Validate it looks like a component
                    if (data.id && data.name && data.code) {
                        console.log('[AIAgent] Extracted component:', data.id);
                        return data;
                    }
                } catch (e) {
                    console.log('[AIAgent] JSON parse failed for pattern, trying next...', e.message);
                }
            }
        }

        console.log('[AIAgent] No component JSON found in message');
        return null;
    }

    clearHistory() {
        this.conversationHistory = [];
        this.toolCalls = [];
    }

    getHistory() {
        return this.conversationHistory;
    }

    getToolCalls() {
        return this.toolCalls;
    }
}

// Store active conversations by session
const conversations = new Map();

function getOrCreateAgent(sessionId) {
    if (!conversations.has(sessionId)) {
        conversations.set(sessionId, new AIAgent());
    }
    return conversations.get(sessionId);
}

function clearConversation(sessionId) {
    if (conversations.has(sessionId)) {
        conversations.get(sessionId).clearHistory();
    }
}

// Get the provider config for a specific model
// This queries all providers to find which one owns the model
async function getProviderForModel(modelId) {
    // Resolve display names to model IDs
    modelId = resolveModelId(modelId) || modelId;
    const providerData = await getProviders();

    if (!providerData.providers || providerData.providers.length === 0) {
        return getAIConfig(); // Fallback to default config
    }

    // Try to find the model in each provider's model list
    for (const provider of providerData.providers) {
        try {
            const models = await getModelsForProvider(provider.id);
            const modelIds = models.map(m => m.id);

            // Check if this provider has the model
            if (modelIds.includes(modelId)) {
                console.log(`[AIAgent] Model ${modelId} found in provider: ${provider.name}`);
                return {
                    url: (provider.url || '').replace(/\/$/, ''),
                    model: modelId,
                    apiKey: provider.apiKey || '',
                    providerId: provider.id,
                    providerName: provider.name,
                    providerType: provider.type,
                    project: provider.project || null,
                    location: provider.location || null,
                    serviceAccountKey: provider.serviceAccountKey || null,
                    apiVersion: provider.apiVersion || null,
                };
            }
        } catch (e) {
            console.error(`[AIAgent] Failed to check models for ${provider.name}:`, e.message);
        }
    }

    // Model not found in any provider — fail instead of silently falling back
    console.error(`[AIAgent] Model ${modelId} not found in any configured provider`);
    throw new Error(`Model "${modelId}" not found in any configured provider. Check your model tier configuration.`);
}

module.exports = {
    AIAgent,
    SYSTEM_PROMPT: SYSTEM_PROMPT_FALLBACK,
    getOrCreateAgent,
    clearConversation,
    getAIConfig,
    saveAIConfig,
    getProviders,
    addProvider,
    updateProvider,
    deleteProvider,
    setDefaultProvider,
    getProviderForModel,
    getModelsForProvider,
    invalidateModelCache,
    getAllCachedModelIds,
    generateEmbedding,
    resolveModelId
};

/**
 * Get models for a provider, using cache with 60s TTL.
 * @param {string} providerId - The provider ID to fetch models for
 * @param {boolean} [forceRefresh=false] - Force a cache refresh
 * @returns {Promise<Array<{id, name}>>} List of models
 */
async function getModelsForProvider(providerId, forceRefresh = false) {
    const now = Date.now();

    // Try Redis first, then in-memory fallback
    if (!forceRefresh) {
        const r = getRedis();
        if (r) {
            try {
                const val = await r.get(`bf:mcache:${providerId}`);
                if (val) {
                    const models = JSON.parse(val);
                    _modelCache.set(providerId, { models, timestamp: now }); // keep in-memory in sync
                    return models;
                }
            } catch (_) { /* fall through */ }
        } else {
            const cached = _modelCache.get(providerId);
            if (cached && (now - cached.timestamp) < MODEL_CACHE_TTL * 1000) {
                return cached.models;
            }
        }
    }

    // Fetch fresh data
    const providerData = await getProviders();
    const provider = (providerData.providers || []).find(p => p.id === providerId);
    if (!provider) {
        console.warn(`[ModelCache] Provider ${providerId} not found`);
        return [];
    }

    const { getAdapter } = require('./providers');
    const adapter = getAdapter(provider.type, provider.url);
    const baseUrl = (provider.url || '').replace(/\/+$/, '');

    console.log(`[ModelCache] Fetching models for ${provider.name} (cache ${forceRefresh ? 'forced' : 'miss'})`);
    const models = await adapter.listModels(provider.apiKey, baseUrl, {
        project: provider.project,
        location: provider.location,
        serviceAccountKey: provider.serviceAccountKey,
        apiVersion: provider.apiVersion,
    });

    if (models.length > 0) {
        _modelCache.set(providerId, { models, timestamp: now });
        const r = getRedis();
        if (r) {
            try { await r.set(`bf:mcache:${providerId}`, JSON.stringify(models), 'EX', MODEL_CACHE_TTL); } catch (_) { }
        }
        console.log(`[ModelCache] Cached ${models.length} models for ${provider.name}`);
    } else {
        console.log(`[ModelCache] Skipping cache for ${provider.name} (0 models)`);
    }
    return models;
}

/**
 * Invalidate model cache for a specific provider or all providers.
 * Call this when provider config changes (add/update/delete).
 */
function invalidateModelCache(providerId) {
    const r = getRedis();
    if (providerId) {
        _modelCache.delete(providerId);
        if (r) { r.del(`bf:mcache:${providerId}`).catch(() => { }); }
    } else {
        // Clear all model cache keys
        if (r) {
            r.keys('bf:mcache:*').then(keys => {
                if (keys.length) r.del(...keys).catch(() => { });
            }).catch(() => { });
        }
        _modelCache.clear();
    }
}

/**
 * Get all model IDs from the model cache (across all providers).
 * Returns objects with provider info to differentiate same-named models.
 */
async function getAllCachedModelIds() {
    const CONFIG_KEY = 'ai_providers';
    const providersRaw = await configStore.getConfig(CONFIG_KEY);
    const providers = providersRaw ? JSON.parse(providersRaw) : [];
    const providerMap = {};
    for (const p of providers) {
        providerMap[p.id] = { name: p.name, type: p.type };
    }

    const result = [];
    const seen = new Set();
    for (const [providerId, entry] of _modelCache) {
        const prov = providerMap[providerId] || { name: 'Unknown', type: 'unknown' };
        for (const m of entry.models) {
            const key = `${prov.name}::${m.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            result.push({
                id: m.id,
                providerName: prov.name,
                providerType: prov.type,
            });
        }
    }
    return result;
}

// Generate Embedding for text
// agentContext: optional { agentId, agentName, source } for cost tracking
async function generateEmbedding(text, agentContext = null) {
    console.log("[AIAgent] generateEmbedding called for text length:", text?.length);
    const config = await getFullConfig();
    console.log("[AIAgent] Config loaded. Embedding Provider ID:", config.embeddingProviderId);

    const providers = config.providers || [];
    const defaultId = config.defaultProviderId;

    // Find active provider
    let provider = null;

    // 1. Explicit embedding provider
    if (config.embeddingProviderId) {
        provider = providers.find(p => p.id === config.embeddingProviderId);
    }

    // 2. Default provider
    if (!provider && defaultId) {
        provider = providers.find(p => p.id === defaultId);
    }

    // 3. Fallback to first provider
    if (!provider && providers.length > 0) {
        provider = providers[0];
    }
    // Fallback to legacy config
    if (!provider) {
        provider = {
            url: config.url || DEFAULT_CONFIG.url,
            apiKey: config.apiKey || DEFAULT_CONFIG.apiKey,
            model: 'mistral-embed' // Default for embeddings if not specified
        };
    }

    // Default embedding model
    let model = config.embeddingModel || 'mistral-embed';

    // If provider specifies a model, use it (unless overridden by global config)
    if (!config.embeddingModel && provider.model && provider.model.includes('embedding')) {
        model = provider.model;
    }


    try {
        const headers = {
            'Content-Type': 'application/json'
        };

        const apiKey = provider.apiKey;
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const baseUrl = provider.url.replace(/\/$/, '');
        // Handle providers with /v1
        const apiUrl = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;

        //
        console.log(`[AIAgent] Sending embedding request to: ${apiUrl}/embeddings`);
        console.log(`[AIAgent] Using Model: ${model}`);
        console.log(`[AIAgent] Auth Header Present: ${!!headers['Authorization']}`);

        const response = await fetch(`${apiUrl}/embeddings`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: model,
                input: text
            })
        });

        if (!response.ok) {
            const err = await response.text();
            console.error(`[AIAgent] Embedding API Error: ${response.status} - ${err}`);
            throw new Error(`Embedding API Error: ${response.status} - ${err}`);
        }

        const data = await response.json();
        console.log(`[AIAgent] Embedding Response Keys:`, Object.keys(data));
        if (data.data && data.data.length > 0) {
            console.log(`[AIAgent] Embedding 0 length:`, data.data[0].embedding?.length);
        } else {
            console.warn(`[AIAgent] Embedding data is empty!`, JSON.stringify(data));
        }

        if (!data.data || !data.data[0] || !data.data[0].embedding) {
            throw new Error("No embedding found in response: " + JSON.stringify(data));
        }

        // Log embedding usage for cost tracking
        if (data.usage) {
            try {
                const usageStore = require('../stores/usageStore');
                await usageStore.logUsage({
                    agent_id: agentContext?.agentId || null,
                    agent_name: agentContext?.agentName || 'system',
                    model: model,
                    prompt_tokens: data.usage.prompt_tokens || 0,
                    completion_tokens: 0,
                    total_tokens: data.usage.total_tokens || data.usage.prompt_tokens || 0,
                    source: agentContext?.source || 'knowledge_embedding',
                });
            } catch (logErr) {
                console.warn('[AIAgent] Failed to log embedding usage:', logErr.message);
            }
        }

        return data.data[0].embedding;
    } catch (e) {
        console.error('Failed to generate embedding:', e);
        throw e;
    }
}
