/**
 * Azure Service Cost Estimation — pricing for non-LLM Azure services
 *
 * Covers:
 *   • Azure Document Intelligence (Layout model)
 *   • Azure AI Content Safety (text analysis)
 *   • Azure PII Detection (Language API)
 *   • Azure OpenAI Embeddings
 *
 * Prices are estimates based on Azure published pricing (pay-as-you-go, S0 tier).
 * Admins can override rates via configStore key 'azure_service_cost_overrides'.
 *
 * All costs are in USD.
 */

const configStore = require('../stores/configStore');

// ── Default Pricing (Azure published rates, S0 tier) ─────────────────
// Source: https://azure.microsoft.com/pricing/ (retrieved April 2026)

const DEFAULTS = {
    // Document Intelligence — Prebuilt Layout model
    // $10.00 / 1,000 pages → $0.01 per page
    doc_intelligence_per_page: 0.01,

    // Content Safety — Text Analyze
    // $0.75 / 1,000 text records (1 record = 1,000 chars)
    content_safety_per_1k_chars: 0.00075,

    // PII Detection (Azure AI Language)
    // $0.56 / 1,000 text records (1 record = 1,000 chars)
    pii_detection_per_1k_chars: 0.00056,

    // Azure OpenAI Embeddings (text-embedding-3-small)
    // $0.02 / 1M tokens → $0.00000002 per token
    embedding_per_token: 0.00000002,
};

// ── Admin Overrides ──────────────────────────────────────────────────

const CONFIG_KEY = 'azure_service_cost_overrides';
let _overridesCache = {};
let _overridesCacheTTL = 0;
const CACHE_DURATION = 60_000; // refresh every 60s

function getOverrides() {
    // Return cached if still fresh; kick off async refresh in background
    if (Date.now() < _overridesCacheTTL) return _overridesCache;
    _overridesCacheTTL = Date.now() + CACHE_DURATION;
    configStore.getConfig(CONFIG_KEY).then(raw => {
        try {
            _overridesCache = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
        } catch { _overridesCache = {}; }
    }).catch(() => {});
    return _overridesCache;
}

function getRate(key) {
    const overrides = getOverrides();
    return overrides[key] ?? DEFAULTS[key] ?? 0;
}

// ── Cost Calculators ─────────────────────────────────────────────────

/**
 * Estimate cost for Azure Document Intelligence (Layout model).
 * @param {number} pageCount — number of pages processed
 * @returns {number} estimated cost in USD
 */
function computeDocIntelligenceCost(pageCount = 0) {
    return pageCount * getRate('doc_intelligence_per_page');
}

/**
 * Estimate cost for Azure Content Safety text analysis.
 * Azure bills per 1,000-character "text record" (rounded up).
 * @param {number} charCount — total characters analyzed
 * @returns {number} estimated cost in USD
 */
function computeContentSafetyCost(charCount = 0) {
    const textRecords = Math.ceil(charCount / 1000);
    return textRecords * getRate('content_safety_per_1k_chars');
}

/**
 * Estimate cost for Azure PII Detection (Language API).
 * Azure bills per 1,000-character "text record" (rounded up).
 * @param {number} charCount — total characters analyzed
 * @returns {number} estimated cost in USD
 */
function computePiiDetectionCost(charCount = 0) {
    const textRecords = Math.ceil(charCount / 1000);
    return textRecords * getRate('pii_detection_per_1k_chars');
}

/**
 * Estimate cost for Azure OpenAI Embeddings.
 * @param {number} tokenCount — total tokens embedded
 * @returns {number} estimated cost in USD
 */
function computeEmbeddingCost(tokenCount = 0) {
    return tokenCount * getRate('embedding_per_token');
}

/**
 * Get all current rates (defaults merged with overrides).
 * @returns {object} rate map
 */
function getAllRates() {
    const overrides = getOverrides();
    return { ...DEFAULTS, ...overrides };
}

module.exports = {
    computeDocIntelligenceCost,
    computeContentSafetyCost,
    computePiiDetectionCost,
    computeEmbeddingCost,
    getAllRates,
    DEFAULTS,
};
