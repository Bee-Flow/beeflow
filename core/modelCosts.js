/**
 * Model Cost Registry — AI model pricing
 * 
 * Pricing sources (in priority order):
 * 1. Custom admin overrides (persisted via configStore)
 * 2. Community pricing database (2600+ models, fetched from GitHub, 24h cache)
 * 
 * Prices are in USD per 1 million tokens.
 */

const configStore = require('../stores/configStore');
const { getModelPricing, initPricing } = require('./pricingService');

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
 * Remove custom cost override for a model (revert to default pricing).
 */
function resetModelCost(modelId) {
    const overrides = getCustomOverrides();
    delete overrides[modelId];
    setCustomOverrides(overrides);
}

// ─── Lookups ─────────────────────────────────────────────────────────────────

/**
 * Get cost rates for a model (handles various ID formats).
 * Priority: custom override → community pricing data → null
 * @returns {{ input: number, output: number } | null}  prices per 1M tokens
 */
function getModelCost(modelName) {
    if (!modelName) return null;

    // 1. Custom override (exact match)
    const custom = getCustomOverrides();
    if (custom[modelName]) return custom[modelName];

    // 2. Community pricing lookup (handles provider prefixes + fuzzy matching)
    const pricing = getModelPricing(modelName);
    if (pricing) return pricing;

    // 3. Case-insensitive custom override match
    const lower = modelName.toLowerCase();
    for (const [key, val] of Object.entries(custom)) {
        if (key.toLowerCase() === lower) return val;
    }

    return null;
}

/**
 * Get the cache READ discount multiplier for a model's provider.
 * Cached input tokens are billed at this fraction of the normal input rate.
 */
function getCacheDiscount(model) {
    if (!model) return 1;
    const m = model.toLowerCase();
    // Anthropic/Claude: cache reads cost 10% of normal input
    if (/claude/.test(m)) return 0.1;
    // Google/Gemini: cached content costs 25% of normal input
    if (/gemini/.test(m)) return 0.25;
    // OpenAI: cached prompts cost 50% of normal input
    if (/gpt|o\d/.test(m)) return 0.5;
    // Default: no discount (treat cached same as uncached)
    return 1;
}

/**
 * Get the cache WRITE multiplier for a model's provider.
 * Anthropic charges a premium on cache writes; the premium depends on the TTL
 * the request asked for (5-min default vs 1-hour extended). OpenAI and Gemini
 * don't separately bill cache writes, so cache_creation_tokens is effectively
 * 0 for those providers and this multiplier is irrelevant.
 *
 * @param {string} model
 * @param {string|null} ttl  — '5m' (or null/falsy default) → 1.25×; '1h' → 2×
 */
function getCacheWriteMultiplier(model, ttl) {
    if (!model) return 1;
    const m = model.toLowerCase();
    if (/claude/.test(m)) {
        return ttl === '1h' ? 2.0 : 1.25;  // 5-min is the default
    }
    return 1;
}

/**
 * Compute estimated cost for a single API call.
 * Supports cache-aware pricing — cached input tokens are billed at a read
 * discount, cache-creation tokens at a TTL-specific write premium.
 * @param {string} model
 * @param {number} promptTokens - Total input tokens (including cached + cache-write)
 * @param {number} completionTokens - Output tokens (includes reasoning, billed at output rate)
 * @param {number} cachedTokens - Input tokens served from cache (subset of promptTokens)
 * @param {number} cacheCreationTokens - Anthropic cache write tokens (already counted in promptTokens by Anthropic)
 * @param {string|null} cacheTtl - '5m' or '1h' — only meaningful for Anthropic cache writes
 * @returns {number} cost in USD
 */
function computeCost(model, promptTokens = 0, completionTokens = 0, cachedTokens = 0, cacheCreationTokens = 0, cacheTtl = null) {
    const rates = getModelCost(model);
    if (!rates) return 0;
    // Anthropic returns input_tokens NOT including cached_read or cache_creation.
    // Other providers include cached_tokens IN prompt_tokens. We treat
    // promptTokens as the canonical "uncached + cached + cache-write" sum and
    // subtract the cache pieces to get the uncached portion.
    const uncachedInput = Math.max(0, promptTokens - cachedTokens - cacheCreationTokens);
    const cacheReadRate = rates.input * getCacheDiscount(model);
    const cacheWriteRate = rates.input * getCacheWriteMultiplier(model, cacheTtl);
    return ((uncachedInput / 1_000_000) * rates.input)
         + ((cachedTokens / 1_000_000) * cacheReadRate)
         + ((cacheCreationTokens / 1_000_000) * cacheWriteRate)
         + ((completionTokens / 1_000_000) * rates.output);
}

/**
 * Compute estimated cost split into input and output.
 * @returns {{ input_cost: number, output_cost: number }}
 */
function computeCostSplit(model, promptTokens = 0, completionTokens = 0, cachedTokens = 0, cacheCreationTokens = 0, cacheTtl = null) {
    const rates = getModelCost(model);
    if (!rates) return { input_cost: 0, output_cost: 0 };
    const uncachedInput = Math.max(0, promptTokens - cachedTokens - cacheCreationTokens);
    const cacheReadRate = rates.input * getCacheDiscount(model);
    const cacheWriteRate = rates.input * getCacheWriteMultiplier(model, cacheTtl);
    return {
        input_cost: ((uncachedInput / 1_000_000) * rates.input)
                  + ((cachedTokens / 1_000_000) * cacheReadRate)
                  + ((cacheCreationTokens / 1_000_000) * cacheWriteRate),
        output_cost: (completionTokens / 1_000_000) * rates.output,
    };
}

/**
 * Get the full pricing map for the frontend.
 * Custom overrides are merged on top of community pricing data.
 */
function getAllModelCosts() {
    const { getAllModelPricing } = require('./pricingService');
    const pricingData = getAllModelPricing();
    const custom = getCustomOverrides();

    // Start with community pricing data (just input/output, drop provider)
    const merged = {};
    for (const [key, val] of Object.entries(pricingData)) {
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
    const { getModelPricing } = require('./pricingService');
    const custom = getCustomOverrides();
    const result = [];
    const seen = new Set();

    // 1. Models with custom overrides (always shown)
    for (const [model, rates] of Object.entries(custom)) {
        const defaults = getModelPricing(model);
        result.push({
            model,
            input: rates.input,
            output: rates.output,
            isCustom: true,
            defaultInput: defaults?.input ?? null,
            defaultOutput: defaults?.output ?? null,
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

        const defaults = getModelPricing(modelId, providerType);
        result.push({
            model: modelId,
            input: defaults?.input ?? 0,
            output: defaults?.output ?? 0,
            isCustom: false,
            defaultInput: defaults?.input ?? null,
            defaultOutput: defaults?.output ?? null,
            provider: providerName,
        });
    }

    return result;
}

module.exports = {
    getModelCost,
    getCacheDiscount,
    getCacheWriteMultiplier,
    computeCost,
    computeCostSplit,
    getAllModelCosts,
    getModelCostsForConfig,
    setModelCost,
    resetModelCost,
};
