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
//   - standard:      Direct-chat baseline with session-skill bootstrap.
//   - thinking:      Analysis / reasoning. Medium budget + medium reasoning effort.
//   - writer:        Long-form content (reports, articles). High token ceiling.
//   - deep_thinking: Complex multi-step tasks. Maximum quality.
//   - smart:         Legacy alias for thinking tier — same defaults.
//   - pro:           Legacy alias for writer tier — same defaults.
// Output ceilings stay below Sonnet 4.6's 64K max so the same numbers are
// safe on every Claude 4.x model (Opus 4.7 allows 128K; we don't need that
// much in normal direct-chat scenarios and a high cap mostly hurts latency).
// `verbosity` is a GPT-5-only output-length knob (low/medium/high). It is
// ignored by non-GPT-5 models (the adapter only forwards it for GPT-5), so it
// is safe to carry on every tier.
const TIER_DEFAULTS = {
    fast: {
        maxTokens: 4096,
        temperature: 0.2,
        reasoningEffort: undefined, // resolved per-model (GPT-5 → 'minimal'), see applyReasoningDefaults
        reasoningSummary: false,
        verbosity: 'low',
    },
    standard: {
        maxTokens: 16384,
        temperature: 0.5,
        reasoningEffort: 'low',
        reasoningSummary: false,
        verbosity: 'medium',
    },
    swarm: {
        // Swarm tier delegates per-message to a multi-agent runtime; the
        // tier's model is used as the synthesiser default and as the
        // fallback for any worker that doesn't declare its own tier.
        maxTokens: 16384,
        temperature: 0.5,
        reasoningEffort: 'low',
        reasoningSummary: false,
        verbosity: 'medium',
    },
    thinking: {
        maxTokens: 32768,
        temperature: 0.7,
        reasoningEffort: 'medium',
        reasoningSummary: true,
        verbosity: 'medium',
    },
    writer: {
        maxTokens: 32768,
        temperature: 0.7,
        reasoningEffort: 'low',
        reasoningSummary: false,
        verbosity: 'high',
    },
    deep_thinking: {
        maxTokens: 64000,
        temperature: 0.7,
        reasoningEffort: 'high',
        reasoningSummary: true,
        verbosity: 'high',
    },
    // Legacy aliases
    smart: {
        maxTokens: 32768,
        temperature: 0.7,
        reasoningEffort: 'medium',
        reasoningSummary: true,
        verbosity: 'medium',
    },
    pro: {
        maxTokens: 32768,
        temperature: 0.7,
        reasoningEffort: 'low',
        reasoningSummary: false,
        verbosity: 'high',
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

    // 2. Check the user-level Privacy Shield — the canonical store for
    //    per-user EU residency. The consumer Privacy Shield settings panel
    //    writes this key; the EU master toggle requires the shield to be
    //    enabled as well as euModeEnabled, mirroring the org check above.
    if (userId) {
        const userShield = await configStore.getConfig(`user_privacy_shield_${userId}`);
        if (userShield?.enabled && userShield?.euModeEnabled) {
            return { isEU: true, source: 'user_shield' };
        }

        // 3. Fallback for legacy users who set the old `user_eu_mode_${userId}`
        //    flag (the now-removed Startup Agent EU toggle) before the
        //    Privacy Shield panel existed. Keeps EU routing on until they
        //    re-save through the new panel, at which point the new key wins.
        const legacy = await configStore.getConfig(`user_eu_mode_${userId}`);
        if (legacy === true) return { isEU: true, source: 'user_legacy' };
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
async function getCustomTierById(id, { userOrgId = null, userId = null } = {}) {
    if (!id || !id.startsWith('custom:')) return null;
    // Merge global + org-scoped custom tiers. Org-scoped tiers override globals
    // when IDs collide (org admin has the final word within their org).
    const globalArr = (await configStore.getConfig('custom_chat_model_tiers')) || [];
    const orgArr = userOrgId
        ? ((await configStore.getConfig(`custom_chat_model_tiers_org_${userOrgId}`)) || [])
        : [];
    const byId = new Map();
    for (const t of (Array.isArray(globalArr) ? globalArr : [])) {
        if (t && t.id) byId.set(t.id, t);
    }
    for (const t of (Array.isArray(orgArr) ? orgArr : [])) {
        if (t && t.id) byId.set(t.id, t);
    }
    const tier = byId.get(id) || null;
    if (!tier) return null;

    // Apply EU override if EU mode is active for this user/org
    const { isEU } = await isEUModeActive({ userOrgId, userId });
    if (isEU && tier.euModelId) {
        return { ...tier, modelId: tier.euModelId };
    }
    return tier;
}

async function resolveModelForTier(rawModel, { userOrgId = null, userId = null, fallbackTier = 'fast' } = {}) {
    let tiers = await configStore.getConfig('chat_model_tiers') || {};
    tiers = await applyEUOverrides(tiers, { userOrgId, userId });

    // Case 1: Explicit tier reference (e.g. 'tier:fast' or 'tier:custom:slug')
    if (rawModel && rawModel.startsWith('tier:')) {
        const tierName = rawModel.substring(5);
        if (tierName.startsWith('custom:')) {
            const custom = await getCustomTierById(tierName, { userOrgId, userId });
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
 * Returns true when the model id is a known reasoning model that emits
 * thinking / reasoning summary deltas. Used to auto-enable reasoning UX so
 * users see the model's thought process appear before the final answer.
 */
function isReasoningModel(modelId) {
    if (!modelId || typeof modelId !== 'string') return false;
    return /^o\d|^gpt-5|magistral|claude-(opus-4|sonnet-4)|gemini-(2\.5|3)/i.test(modelId);
}

/**
 * Apply reasoning-model defaults: when the resolved model supports thinking
 * summaries, turn them on unless the user explicitly disabled them. We only
 * upgrade `undefined` → enabled — explicit `false` from the admin or custom
 * tier config is respected.
 */
function applyReasoningDefaults(merged, userConfig, tierName) {
    if (!merged?.modelId || !isReasoningModel(merged.modelId)) return merged;
    const userSetSummary  = Object.prototype.hasOwnProperty.call(userConfig || {}, 'reasoningSummary');
    const userSetEffort   = Object.prototype.hasOwnProperty.call(userConfig || {}, 'reasoningEffort');
    if (!userSetSummary && (merged.reasoningSummary === undefined || merged.reasoningSummary === false)) {
        merged.reasoningSummary = true;
    }
    if (!userSetEffort && (merged.reasoningEffort === undefined || merged.reasoningEffort === null)) {
        // The fast/swarm tiers are tuned for speed. GPT-5 models expose a
        // dedicated 'minimal' reasoning tier — use it there instead of the
        // generic 'medium' default so "fast" stays fast (and cheap). Other
        // providers (Claude/Gemini) keep the 'medium' default unchanged.
        const isFastTier = tierName === 'fast' || tierName === 'swarm';
        const isGpt5 = /^gpt-5/i.test(merged.modelId);
        merged.reasoningEffort = (isFastTier && isGpt5) ? 'minimal' : 'medium';
    }
    return merged;
}

/**
 * Get the full tier config object (for endpoints that need maxTokens, temperature, etc.)
 *
 * Merges: TIER_DEFAULTS (baseline) ← user config (admin UI overrides).
 * User-set values always win; TIER_DEFAULTS fill in anything the user hasn't configured.
 *
 * Reasoning-capable models auto-enable `reasoningSummary` + a `medium`
 * reasoningEffort so users see the model's thought process stream before
 * the final answer (parallel to the typing-dots/phase indicator).
 */
async function getTierConfig(tierName, { userOrgId = null, userId = null } = {}) {
    // Custom tiers carry their own full config — no TIER_DEFAULTS fallback needed.
    if (tierName && tierName.startsWith('custom:')) {
        const custom = await getCustomTierById(tierName, { userOrgId, userId });
        if (custom) {
            const merged = {
                maxTokens: custom.maxTokens,
                temperature: custom.temperature,
                reasoningEffort: custom.reasoningEffort,
                reasoningSummary: custom.reasoningSummary,
                verbosity: custom.verbosity,
                modelId: custom.modelId,
            };
            return applyReasoningDefaults(merged, custom, tierName);
        }
        // Fall through to fast defaults if the id is unknown
    }
    let tiers = await configStore.getConfig('chat_model_tiers') || {};
    tiers = await applyEUOverrides(tiers, { userOrgId, userId });
    const userConfig = tiers[tierName] || tiers['fast'] || {};
    const defaults = TIER_DEFAULTS[tierName] || TIER_DEFAULTS['fast'];
    // Merge: defaults provide baselines, user config overrides
    const merged = { ...defaults, ...userConfig };
    return applyReasoningDefaults(merged, userConfig, tierName);
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
    isReasoningModel,
};
