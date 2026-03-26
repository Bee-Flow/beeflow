/**
 * Pricing Service — fetches model pricing from a community-maintained
 * open-source pricing database (2000+ models from all providers).
 * Cached in memory with a 24-hour TTL.
 */

const PRICING_URL =
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

let _cachedPricing = null;
let _cacheTimestamp = null;
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

/**
 * Fetch the full pricing JSON (2000+ models).
 * Uses a 24h in-memory cache.
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<Object>} Map of model keys → pricing objects
 */
async function fetchAllPricing(forceRefresh = false) {
    const now = Date.now();

    if (!forceRefresh && _cachedPricing && (now - _cacheTimestamp) < CACHE_TTL) {
        return _cachedPricing;
    }

    try {
        console.log('[PricingService] Fetching pricing data...');
        const res = await fetch(PRICING_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        // Remove the meta spec entry
        delete data['sample_spec'];

        _cachedPricing = data;
        _cacheTimestamp = now;

        console.log(`[PricingService] Cached pricing for ${Object.keys(data).length} models`);
        return data;
    } catch (e) {
        console.error('[PricingService] Failed to fetch pricing:', e.message);
        // Return cached data if available (even if expired)
        if (_cachedPricing) return _cachedPricing;
        return {};
    }
}

// ─── Provider prefix mapping ────────────────────────────────────────────────
// The pricing database uses prefixed keys like "openai/gpt-4o", "mistral/mistral-large-latest", etc.
// Our system uses bare model IDs. This maps provider types to pricing-DB prefixes.

const PROVIDER_PREFIXES = {
    openai: ['', 'openai/'],
    mistral: ['mistral/', ''],
    claude: ['', 'anthropic/', 'claude-'],
    google: ['gemini/', ''],
    'google-vertex': ['vertex_ai/gemini-', 'vertex_ai/', 'gemini/', ''],
    minimax: ['minimax/', ''],
};

// ─── Fallback pricing for models not yet in the community database ──────────
// Prices are per 1M tokens (USD). Sourced from official provider pages.
const FALLBACK_PRICING = {
    'MiniMax-M2.7':            { input: 0.30, output: 1.20 },
    'MiniMax-M2.7-highspeed':  { input: 0.60, output: 2.40 },
};

/**
 * Look up the cost for a model ID, trying various key patterns.
 * Returns { input, output } in USD per 1M tokens, or null if not found.
 *
 * @param {string} modelId - The bare model ID (e.g. "gpt-4o", "mistral-large-latest")
 * @param {string} [providerType] - Optional provider type for prefix hints
 * @returns {{ input: number, output: number } | null}
 */
function getModelPricing(modelId, providerType) {
    if (!modelId) return null;

    // 0. Check fallback pricing first (for models not yet in community DB)
    const fallback = FALLBACK_PRICING[modelId];
    if (fallback) return fallback;
    // Case-insensitive fallback check
    const lowerModelId = modelId.toLowerCase();
    for (const [key, val] of Object.entries(FALLBACK_PRICING)) {
        if (key.toLowerCase() === lowerModelId) return val;
    }

    if (!_cachedPricing) return null;

    const _extract = (entry) => ({
        input: (entry.input_cost_per_token || 0) * 1_000_000,
        output: (entry.output_cost_per_token || 0) * 1_000_000,
    });
    const _valid = (entry) => entry && (entry.input_cost_per_token != null || entry.output_cost_per_token != null);

    // Build candidate keys to try
    const prefixes = providerType && PROVIDER_PREFIXES[providerType]
        ? PROVIDER_PREFIXES[providerType]
        : ['', 'openai/', 'mistral/', 'gemini/', 'vertex_ai/', 'anthropic/', 'minimax/'];

    // Build candidate model IDs (original + without -latest)
    const candidates = [modelId];
    if (modelId.endsWith('-latest')) {
        candidates.push(modelId.replace(/-latest$/, ''));
    }

    // Try each prefix + candidate combo
    for (const id of candidates) {
        for (const prefix of prefixes) {
            const entry = _cachedPricing[prefix + id];
            if (_valid(entry)) return _extract(entry);
        }
    }

    // Fuzzy: find a key that ends with /modelId or contains the base name
    const baseName = modelId.replace(/-latest$/, '').replace(/-\d{4}$/, '');
    for (const [key, entry] of Object.entries(_cachedPricing)) {
        if (!_valid(entry)) continue;
        if (key.endsWith('/' + modelId) || key.endsWith('/' + baseName)) {
            return _extract(entry);
        }
    }

    return null;
}

/**
 * Get all pricing data converted to our format (per 1M tokens).
 * Used by the config UI to show full pricing list.
 * @returns {Object} Map of modelId → { input, output, provider }
 */
function getAllModelPricing() {
    if (!_cachedPricing) return {};

    const result = {};
    for (const [key, entry] of Object.entries(_cachedPricing)) {
        if (entry.input_cost_per_token == null && entry.output_cost_per_token == null) continue;

        // Extract bare model ID (remove provider prefix)
        const slashIdx = key.indexOf('/');
        const modelId = slashIdx >= 0 ? key.substring(slashIdx + 1) : key;

        // Skip if we already have this model (prefer the first/unprefixed match)
        if (result[modelId]) continue;

        result[modelId] = {
            input: (entry.input_cost_per_token || 0) * 1_000_000,
            output: (entry.output_cost_per_token || 0) * 1_000_000,
            provider: entry.litellm_provider || null,
        };
    }

    return result;
}

/**
 * Initialize pricing on startup (non-blocking).
 */
function initPricing() {
    fetchAllPricing().catch(e => console.error('[PricingService] Init failed:', e.message));
}

module.exports = {
    fetchAllPricing,
    getModelPricing,
    getAllModelPricing,
    // Legacy aliases (backwards compat)
    getLiteLLMCost: getModelPricing,
    getAllLiteLLMCosts: getAllModelPricing,
    initPricing,
};
