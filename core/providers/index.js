/**
 * Provider Factory
 * 
 * Returns the correct provider adapter based on provider type or URL.
 * 
 * To add a new provider:
 * 1. Create a new adapter file (e.g., anthropic.js)
 * 2. Instantiate it below
 * 3. Add to PROVIDER_MAP and optionally URL_PATTERNS
 */

const OpenAIProvider = require('./openai');
const MistralProvider = require('./mistral');
const ClaudeProvider = require('./claude');
const GoogleProvider = require('./google');
const GoogleVertexProvider = require('./googleVertex');
const AzureProvider = require('./azure');
const MiniMaxProvider = require('./minimax');
const BaseProvider = require('./base');

// Singleton instances
const openaiAdapter = new OpenAIProvider();
const mistralAdapter = new MistralProvider();
const claudeAdapter = new ClaudeProvider();
const googleAdapter = new GoogleProvider();
const googleVertexAdapter = new GoogleVertexProvider();
const azureAdapter = new AzureProvider();
const minimaxAdapter = new MiniMaxProvider();
const baseAdapter = new BaseProvider('generic');

// Map provider type strings to adapter instances
const PROVIDER_MAP = {
    'openai': openaiAdapter,
    'mistral': mistralAdapter,
    'claude': claudeAdapter,
    'google': googleAdapter,
    'google-vertex': googleVertexAdapter,
    'azure': azureAdapter,
    'minimax': minimaxAdapter,
};

// URL patterns to auto-detect provider when type is unknown
const URL_PATTERNS = [
    { pattern: /openai\.com/i, adapter: openaiAdapter },
    { pattern: /mistral\.ai/i, adapter: mistralAdapter },
    { pattern: /anthropic\.com/i, adapter: claudeAdapter },
    { pattern: /generativelanguage\.googleapis\.com/i, adapter: googleAdapter },
    { pattern: /aiplatform\.googleapis\.com/i, adapter: googleVertexAdapter },
    { pattern: /\.openai\.azure\.com/i, adapter: azureAdapter },
    { pattern: /cognitiveservices\.azure\.com/i, adapter: azureAdapter },
    { pattern: /minimax\.io/i, adapter: minimaxAdapter },
];

/**
 * Get the correct provider adapter.
 * 
 * @param {string} [providerType] - Provider type ('openai', 'mistral', 'claude', etc.)
 * @param {string} [url] - Provider URL (used for auto-detection if type is unknown)
 * @returns {BaseProvider} Provider adapter instance
 */
function getAdapter(providerType, url) {
    // Try by explicit type first
    if (providerType && PROVIDER_MAP[providerType]) {
        return PROVIDER_MAP[providerType];
    }

    // Auto-detect from URL
    if (url) {
        for (const { pattern, adapter } of URL_PATTERNS) {
            if (pattern.test(url)) {
                return adapter;
            }
        }
    }

    // Fallback to base adapter (generic OpenAI-compatible)
    return baseAdapter;
}

module.exports = {
    getAdapter,
    openaiAdapter,
    mistralAdapter,
    claudeAdapter,
    googleAdapter,
    googleVertexAdapter,
    azureAdapter,
    minimaxAdapter,
    baseAdapter,
    // Re-export for convenience
    OpenAIProvider,
    MistralProvider,
    ClaudeProvider,
    GoogleProvider,
    GoogleVertexProvider,
    AzureProvider,
    MiniMaxProvider,
    BaseProvider,
};
