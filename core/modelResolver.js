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
 * @param {string}       opts.fallbackTier - Tier to use when rawModel is null (default: 'fast')
 * @returns {Promise<string|null>} Resolved model ID, or null if nothing could be resolved
 */
async function resolveModelForTier(rawModel, { userOrgId = null, fallbackTier = 'fast' } = {}) {
    let tiers = await configStore.getConfig('chat_model_tiers') || {};

    // EU-mode overlay: merge EU tier overrides into the base tiers
    if (userOrgId) {
        const shield = await configStore.getConfig(`org_privacy_shield_${userOrgId}`);
        if (shield?.enabled && shield?.euModeEnabled) {
            const euTiers = await configStore.getConfig('chat_model_tiers_eu') || {};
            for (const [tierName, euTier] of Object.entries(euTiers)) {
                if (euTier?.modelId) {
                    tiers[tierName] = { ...tiers[tierName], ...euTier };
                }
            }
        }
    }

    // Case 1: Explicit tier reference (e.g. 'tier:fast')
    if (rawModel && rawModel.startsWith('tier:')) {
        const tierName = rawModel.substring(5);
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
 */
async function getTierConfig(tierName, { userOrgId = null } = {}) {
    let tiers = await configStore.getConfig('chat_model_tiers') || {};

    if (userOrgId) {
        const shield = await configStore.getConfig(`org_privacy_shield_${userOrgId}`);
        if (shield?.enabled && shield?.euModeEnabled) {
            const euTiers = await configStore.getConfig('chat_model_tiers_eu') || {};
            for (const [tn, euTier] of Object.entries(euTiers)) {
                if (euTier?.modelId) tiers[tn] = { ...tiers[tn], ...euTier };
            }
        }
    }

    return tiers[tierName] || tiers['fast'] || {};
}

module.exports = {
    resolveModelForTier,
    resolveModelWithGlobalFallback,
    getTierConfig,
};
