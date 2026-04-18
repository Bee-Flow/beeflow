/**
 * Model Resolver — Single source of truth for tier-based model resolution.
 *
 * Replaces the duplicated tier:fast / tier:smart → actual-model-id logic
 * that was scattered across chatTitle.js, extractor.js, system.js routes,
 * and aiAgent.js.
 *
 * Usage:
 *   const { resolveModelForTier } = require('./modelResolver');
 *   const model = await resolveModelForTier(agent.model, { userOrgId, fallbackTier: 'fast' });
 */

const configStore = require('../stores/configStore');

// ─── Tier Defaults ────────────────────────────────────────────────────────────
// Centralised token / temperature / reasoning standards per tier.
// User-configured values (from the admin UI) override these; these are the
// fallback defaults when a tier setting is not explicitly configured.
//
// Rationale:
//   - fast:          Short, snappy answers. Low token ceiling = faster completion.
//   - thinking:      Analysis / reasoning. Medium budget + medium reasoning effort.
//   - writer:        Long-form content (reports, articles). High token ceiling.
//   - deep_thinking: Complex multi-step tasks. Maximum quality.
//   - smart:         Legacy alias for thinking tier — same defaults.
//   - pro:           Legacy alias for writer tier — same defaults.
const TIER_DEFAULTS = {
    fast: {
        maxTokens: 2048,
        temperature: 0.2,
        reasoningEffort: undefined, // no reasoning for speed
        reasoningSummary: false,
    },
    thinking: {
        maxTokens: 16384,
        temperature: 0.7,
        reasoningEffort: 'medium',
        reasoningSummary: true,
    },
    writer: {
        maxTokens: 16384,
        temperature: 0.7,
        reasoningEffort: 'low',
        reasoningSummary: false,
    },
    deep_thinking: {
        maxTokens: 40960,
        temperature: 0.7,
        reasoningEffort: 'high',
        reasoningSummary: true,
    },
    // Legacy aliases
    smart: {
        maxTokens: 16384,
        temperature: 0.7,
        reasoningEffort: 'medium',
        reasoningSummary: true,
    },
    pro: {
        maxTokens: 16384,
        temperature: 0.7,
        reasoningEffort: 'low',
        reasoningSummary: false,
    },
};

/**
 * Check if EU mode is active — either org-level shield OR personal user preference.
 * Org-level takes priority. If org has shield enabled + euModeEnabled, that wins.
 * If no org OR org has no EU enforcement, check personal user setting.
 *
 * @param {Object}      opts
 * @param {string|null}  opts.userOrgId  - Org ID to check org-level shield
 * @param {string|null}  opts.userId     - User ID to check personal EU preference
 * @returns {Promise<{isEU: boolean, source: 'org'|'user'|'none'}>}
 */
async function isEUModeActive({ userOrgId = null, userId = null } = {}) {
    // 1. Check org-level privacy shield first (takes priority)
    if (userOrgId) {
        const shield = await configStore.getConfig(`org_privacy_shield_${userOrgId}`);
        if (shield?.enabled && shield?.euModeEnabled) {
            return { isEU: true, source: 'org' };
        }
    }

    // 2. Check personal user EU preference
    if (userId) {
        const userEU = await configStore.getConfig(`user_eu_mode_${userId}`);
        if (userEU === true) {
            return { isEU: true, source: 'user' };
        }
    }

    return { isEU: false, source: 'none' };
}

/**
 * Apply EU tier overrides to a tiers object if EU mode is active.
 * Shared logic used by resolveModelForTier, getTierConfig, and getEUAwareTiers.
 */
async function applyEUOverrides(tiers, { userOrgId = null, userId = null } = {}) {
    const { isEU } = await isEUModeActive({ userOrgId, userId });
    if (!isEU) return tiers;

    const euTiers = await configStore.getConfig('chat_model_tiers_eu') || {};
    const merged = { ...tiers };
    for (const [tierName, euTier] of Object.entries(euTiers)) {
        if (euTier?.modelId) {
            merged[tierName] = { ...merged[tierName], ...euTier };
        }
    }
    return merged;
}

/**
 * Resolve a raw model string to an actual model ID.
 *
 * Handles:
 *   - 'tier:fast'    → looks up chat_model_tiers config
 *   - 'tier:smart'   → looks up chat_model_tiers config
 *   - 'tier:thinking' → looks up chat_model_tiers config
 *   - null/undefined  → falls back to fallbackTier, then global default
 *   - 'gpt-4o'       → returned as-is (already a concrete model ID)
 *
 * @param {string|null} rawModel     - The raw model string from the agent config
 * @param {Object}      [opts]
 * @param {string|null}  opts.userOrgId    - Org ID for EU-mode tier overrides
 * @param {string|null}  opts.userId       - User ID for personal EU-mode preference
 * @param {string}       opts.fallbackTier - Tier to use when rawModel is null (default: 'fast')
 * @returns {Promise<string|null>} Resolved model ID, or null if nothing could be resolved
 */
async function getCustomTierById(id) {
    if (!id || !id.startsWith('custom:')) return null;
    const arr = await configStore.getConfig('custom_chat_model_tiers') || [];
    if (!Array.isArray(arr)) return null;
    return arr.find(t => t && t.id === id) || null;
}

async function resolveModelForTier(rawModel, { userOrgId = null, userId = null, fallbackTier = 'fast' } = {}) {
    let tiers = await configStore.getConfig('chat_model_tiers') || {};
    tiers = await applyEUOverrides(tiers, { userOrgId, userId });

    // Case 1: Explicit tier reference (e.g. 'tier:fast' or 'tier:custom:slug')
    if (rawModel && rawModel.startsWith('tier:')) {
        const tierName = rawModel.substring(5);
        if (tierName.startsWith('custom:')) {
            const custom = await getCustomTierById(tierName);
            return custom?.modelId || tiers[fallbackTier]?.modelId || null;
        }
        return tiers[tierName]?.modelId || tiers[fallbackTier]?.modelId || null;
    }

    // Case 2: No model specified — use fallback tier
    if (!rawModel) {
        return tiers[fallbackTier]?.modelId || null;
    }

    // Case 3: Already a concrete model ID — resolve display-name aliases
    try {
        const { resolveModelId } = require('./aiAgent');
        return resolveModelId(rawModel) || rawModel;
    } catch (_) {
        return rawModel;
    }
}

/**
 * Resolve a model and fall back to the global default if tier resolution fails.
 * A convenience wrapper that guarantees a non-null return (if global config has a model).
 */
async function resolveModelWithGlobalFallback(rawModel, opts = {}) {
    const resolved = await resolveModelForTier(rawModel, opts);
    if (resolved) return resolved;

    // Final fallback: global AI config model
    const { getAIConfig } = require('./aiAgent');
    const globalConfig = await getAIConfig();
    return globalConfig?.model || null;
}

/**
 * Get the full tier config object (for endpoints that need maxTokens, temperature, etc.)
 *
 * Merges: TIER_DEFAULTS (baseline) ← user config (admin UI overrides).
 * User-set values always win; TIER_DEFAULTS fill in anything the user hasn't configured.
 */
async function getTierConfig(tierName, { userOrgId = null, userId = null } = {}) {
    // Custom tiers carry their own full config — no TIER_DEFAULTS fallback needed.
    if (tierName && tierName.startsWith('custom:')) {
        const custom = await getCustomTierById(tierName);
        if (custom) {
            return {
                maxTokens: custom.maxTokens,
                temperature: custom.temperature,
                reasoningEffort: custom.reasoningEffort,
                reasoningSummary: custom.reasoningSummary,
                modelId: custom.modelId,
            };
        }
        // Fall through to fast defaults if the id is unknown
    }
    let tiers = await configStore.getConfig('chat_model_tiers') || {};
    tiers = await applyEUOverrides(tiers, { userOrgId, userId });
    const userConfig = tiers[tierName] || tiers['fast'] || {};
    const defaults = TIER_DEFAULTS[tierName] || TIER_DEFAULTS['fast'];
    // Merge: defaults provide baselines, user config overrides
    return { ...defaults, ...userConfig };
}

/**
 * Convenience: resolve a plain tier name (e.g. 'fast', 'smart') to a model ID.
 * Shorthand for resolveModelForTier('tier:' + tierName, opts).
 *
 * @param {string} tierName      - Plain tier name (e.g. 'fast', 'smart', 'thinking')
 * @param {Object} [opts]
 * @param {string|null} opts.userOrgId - Org ID for EU-mode overrides
 * @param {string|null} opts.userId    - User ID for personal EU-mode preference
 * @param {string}      opts.fallback  - Fallback model ID if resolution fails
 * @returns {Promise<string>} Resolved model ID
 */
async function resolveModelForTierName(tierName, { userOrgId = null, userId = null, fallback = 'gemini-2.0-flash-lite' } = {}) {
    const resolved = await resolveModelForTier(`tier:${tierName}`, { userOrgId, userId, fallbackTier: 'fast' });
    return resolved || fallback;
}

/**
 * Get the full EU-aware tiers map (merged with EU overrides if applicable).
 * Useful for consumers that need to iterate available tiers (e.g. promptClassifier).
 *
 * @param {Object} [opts]
 * @param {string|null} opts.userOrgId - Org ID for EU-mode overrides
 * @param {string|null} opts.userId    - User ID for personal EU-mode preference
 * @returns {Promise<Object>} Merged tiers config
 */
async function getEUAwareTiers({ userOrgId = null, userId = null } = {}) {
    let tiers = await configStore.getConfig('chat_model_tiers') || {};
    return applyEUOverrides(tiers, { userOrgId, userId });
}

module.exports = {
    TIER_DEFAULTS,
    resolveModelForTier,
    resolveModelWithGlobalFallback,
    getTierConfig,
    resolveModelForTierName,
    getEUAwareTiers,
    isEUModeActive,
    getCustomTierById,
};
