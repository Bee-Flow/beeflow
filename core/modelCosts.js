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
    resetUpperBoundCache();
}

/**
 * Remove custom cost override for a model (revert to default pricing).
 */
function resetModelCost(modelId) {
    const overrides = getCustomOverrides();
    delete overrides[modelId];
    setCustomOverrides(overrides);
    resetUpperBoundCache();
}

// ─── Lookups ─────────────────────────────────────────────────────────────────

// Memoised upper-bound rates (most-expensive across all known models). Used
// as a safe fallback for unknown models so customers calling a brand-new
// model name aren't billed €0 until LiteLLM data lands. Re-computed lazily
// once per process; cleared via `resetUpperBoundCache` (admin custom-override
// edits invalidate it so a newly-added high-cost override is picked up).
let _upperBoundCache = null;
let _upperBoundComputedAt = 0;
const _unknownModelWarned = new Set();

function _computeUpperBound() {
    try {
        const all = getAllModelCosts(); // { name: { input, output } } including custom overrides
        let maxInput = 0;
        let maxOutput = 0;
        for (const rates of Object.values(all)) {
            if (Number.isFinite(rates?.input) && rates.input > maxInput) maxInput = rates.input;
            if (Number.isFinite(rates?.output) && rates.output > maxOutput) maxOutput = rates.output;
        }
        if (maxInput <= 0 && maxOutput <= 0) return null;
        return { input: maxInput, output: maxOutput };
    } catch (_) { return null; }
}

function _getUpperBound() {
    // 10-min TTL keeps the cache hot during normal traffic but lets a new
    // pricing fetch (24h cycle) eventually flow in.
    if (_upperBoundCache && (Date.now() - _upperBoundComputedAt) < 10 * 60_000) return _upperBoundCache;
    _upperBoundCache = _computeUpperBound();
    _upperBoundComputedAt = Date.now();
    return _upperBoundCache;
}

function resetUpperBoundCache() {
    _upperBoundCache = null;
    _upperBoundComputedAt = 0;
}

function _warnUnknownModel(modelName) {
    if (!modelName || _unknownModelWarned.has(modelName)) return;
    _unknownModelWarned.add(modelName);
    console.warn(`[ModelCosts] Unknown model '${modelName}' — using upper-bound rates; add it to pricing data or as a custom override.`);
}

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
    // Google/Gemini: 2.5/3.x cached reads cost 10% of input (90% off);
    // legacy 2.0 was 25% (75% off). Only used when the pricing data has no
    // explicit cache_read rate — see computeCost's rates.cacheRead preference.
    if (/gemini/.test(m)) return /gemini-(2\.5|3)/.test(m) ? 0.1 : 0.25;
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
    let rates = getModelCost(model);
    if (!rates) {
        // Unknown model — fall back to the upper bound so we never silently
        // charge €0 for a real API call. The customer is over-billed
        // slightly until the model lands in the pricing data or an admin
        // adds a custom override.
        rates = _getUpperBound();
        if (!rates) {
            console.error(`[ModelCosts] No pricing data available (pricing fetch failed?); cost for '${model}' defaulting to 0.`);
            return 0;
        }
        _warnUnknownModel(model);
    }
    // Anthropic returns input_tokens NOT including cached_read or cache_creation.
    // Other providers include cached_tokens IN prompt_tokens. We treat
    // promptTokens as the canonical "uncached + cached + cache-write" sum and
    // subtract the cache pieces to get the uncached portion.
    const uncachedInput = Math.max(0, promptTokens - cachedTokens - cacheCreationTokens);
    const cacheReadRate = _cacheReadRate(model, rates);
    const cacheWriteRate = rates.input * getCacheWriteMultiplier(model, cacheTtl);
    return ((uncachedInput / 1_000_000) * rates.input)
         + ((cachedTokens / 1_000_000) * cacheReadRate)
         + ((cacheCreationTokens / 1_000_000) * cacheWriteRate)
         + ((completionTokens / 1_000_000) * rates.output);
}

/**
 * Resolve the per-token cached-read rate. Prefer the model's explicit
 * cache_read rate from the pricing data (accurate per model, auto-updating);
 * fall back to the provider discount heuristic when it's absent.
 */
function _cacheReadRate(model, rates) {
    if (rates && Number.isFinite(rates.cacheRead) && rates.cacheRead > 0) {
        return rates.cacheRead;
    }
    return rates.input * getCacheDiscount(model);
}

/**
 * Compute estimated cost split into input and output.
 * @returns {{ input_cost: number, output_cost: number }}
 */
function computeCostSplit(model, promptTokens = 0, completionTokens = 0, cachedTokens = 0, cacheCreationTokens = 0, cacheTtl = null) {
    let rates = getModelCost(model);
    if (!rates) {
        rates = _getUpperBound();
        if (!rates) {
            console.error(`[ModelCosts] No pricing data available; split cost for '${model}' defaulting to 0.`);
            return { input_cost: 0, output_cost: 0 };
        }
        _warnUnknownModel(model);
    }
    const uncachedInput = Math.max(0, promptTokens - cachedTokens - cacheCreationTokens);
    const cacheReadRate = _cacheReadRate(model, rates);
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

    // Start with community pricing data (input/output + cached-read rate, drop provider)
    const merged = {};
    for (const [key, val] of Object.entries(pricingData)) {
        merged[key] = { input: val.input, output: val.output, cacheRead: val.cacheRead };
    }

    // Apply custom overrides on top (may omit cacheRead → frontend falls back to input)
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
