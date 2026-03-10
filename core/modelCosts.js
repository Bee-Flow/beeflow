/**
 * Model Cost Registry — AI model pricing
 * 
 * Pricing sources (in priority order):
 * 1. Custom admin overrides (persisted via configStore)
 * 2. LiteLLM pricing data (2600+ models, fetched from GitHub, 24h cache)
 * 
 * Prices are in USD per 1 million tokens.
 */

const configStore = require('../stores/configStore');
const { getLiteLLMCost, initPricing } = require('./pricingService');

// Initialize pricing data on startup (non-blocking)
initPricing();

// ─── Custom Overrides (admin-edited via AI Config) ───────────────────────────

const CONFIG_KEY = 'model_cost_overrides';

function getCustomOverrides() {
    try {
        const raw = configStore.getConfig(CONFIG_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function setCustomOverrides(overrides) {
    configStore.setConfig(CONFIG_KEY, JSON.stringify(overrides));
}

/**
 * Set a custom cost for a model (admin override).
 */
function setModelCost(modelId, input, output) {
    const overrides = getCustomOverrides();
    overrides[modelId] = { input: Number(input), output: Number(output) };
    setCustomOverrides(overrides);
}

/**
 * Remove custom cost override for a model (revert to LiteLLM default).
 */
function resetModelCost(modelId) {
    const overrides = getCustomOverrides();
    delete overrides[modelId];
    setCustomOverrides(overrides);
}

// ─── Lookups ─────────────────────────────────────────────────────────────────

/**
 * Get cost rates for a model (handles various ID formats).
 * Priority: custom override → LiteLLM data → null
 * @returns {{ input: number, output: number } | null}  prices per 1M tokens
 */
function getModelCost(modelName) {
    if (!modelName) return null;

    // 1. Custom override (exact match)
    const custom = getCustomOverrides();
    if (custom[modelName]) return custom[modelName];

    // 2. LiteLLM lookup (handles provider prefixes + fuzzy matching)
    const litellm = getLiteLLMCost(modelName);
    if (litellm) return litellm;

    // 3. Case-insensitive custom override match
    const lower = modelName.toLowerCase();
    for (const [key, val] of Object.entries(custom)) {
        if (key.toLowerCase() === lower) return val;
    }

    return null;
}

/**
 * Compute estimated cost for a single API call.
 * @returns {number} cost in USD
 */
function computeCost(model, promptTokens = 0, completionTokens = 0) {
    const rates = getModelCost(model);
    if (!rates) return 0;
    return ((promptTokens / 1_000_000) * rates.input) + ((completionTokens / 1_000_000) * rates.output);
}

/**
 * Get the full pricing map for the frontend.
 * Custom overrides are merged on top of LiteLLM data.
 */
function getAllModelCosts() {
    const { getAllLiteLLMCosts } = require('./pricingService');
    const litellmCosts = getAllLiteLLMCosts();
    const custom = getCustomOverrides();

    // Start with LiteLLM data (just input/output, drop provider)
    const merged = {};
    for (const [key, val] of Object.entries(litellmCosts)) {
        merged[key] = { input: val.input, output: val.output };
    }

    // Apply custom overrides on top
    for (const [key, val] of Object.entries(custom)) {
        merged[key] = val;
    }

    return merged;
}

/**
 * Get structured cost data for the config UI.
 * Only returns models that have been used or have custom overrides.
 * @param {Array<{id: string, providerName?: string, providerType?: string}>|string[]} modelEntries
 * @returns {Array<{ model, input, output, isCustom, defaultInput, defaultOutput, provider }>}
 */
function getModelCostsForConfig(modelEntries = []) {
    const { getLiteLLMCost } = require('./pricingService');
    const custom = getCustomOverrides();
    const result = [];
    const seen = new Set();

    // 1. Models with custom overrides (always shown)
    for (const [model, rates] of Object.entries(custom)) {
        const litellm = getLiteLLMCost(model);
        result.push({
            model,
            input: rates.input,
            output: rates.output,
            isCustom: true,
            defaultInput: litellm?.input ?? null,
            defaultOutput: litellm?.output ?? null,
            provider: null,
        });
        seen.add(model);
    }

    // 2. Models from providers and usage history
    for (const entry of modelEntries) {
        const modelId = typeof entry === 'string' ? entry : entry.id;
        const providerName = typeof entry === 'string' ? null : (entry.providerName || null);
        const providerType = typeof entry === 'string' ? null : (entry.providerType || null);
        const uniqueKey = providerName ? `${providerName}::${modelId}` : modelId;

        if (seen.has(uniqueKey)) continue;
        seen.add(uniqueKey);

        // Skip custom overrides already added (only skip if no provider differentiation)
        if (!providerName && custom[modelId]) continue;

        const litellm = getLiteLLMCost(modelId, providerType);
        result.push({
            model: modelId,
            input: litellm?.input ?? 0,
            output: litellm?.output ?? 0,
            isCustom: false,
            defaultInput: litellm?.input ?? null,
            defaultOutput: litellm?.output ?? null,
            provider: providerName,
        });
    }

    return result;
}

module.exports = {
    getModelCost,
    computeCost,
    getAllModelCosts,
    getModelCostsForConfig,
    setModelCost,
    resetModelCost,
};
