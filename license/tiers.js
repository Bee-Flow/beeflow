/**
 * License Tier Definitions
 *
 * Single source of truth for which features and limits each tier unlocks.
 * Used by:
 *   - license/index.js  (resolving the active tier into features/limits)
 *   - license/middleware.js (requireTier / requireFeature)
 *   - license/verify.js (sanity-checking signed tokens)
 *
 * Tiers are ordered hierarchically: a higher tier inherits everything below.
 *   community  →  enterprise  →  full
 *
 * Default state for a fresh, unactivated install is `community` — the system
 * must remain usable with no license key present. Community now ships the
 * entire product (no feature gates, no caps); paid tiers add compliance and
 * resale capabilities on top.
 *
 * The previous `pro` tier has been folded into `community` (its features) and
 * `enterprise` (its license keys, see LEGACY_TIER_ALIAS below). Old JWTs and
 * admin-issued blobs with `tier: 'pro'` are still accepted — they resolve to
 * `enterprise` so existing paying customers don't lose anything they were
 * promised at sale time.
 */

// MUST stay in sync with agent-hub/src/components/LicenseContext.jsx → TIER_HIERARCHY.
// A repo-root shared module would be cleaner, but server/ and agent-hub/
// each Docker-build from their own sub-tree and can't reach back up. The
// CI smoke test in Phase 12 asserts the two stay in lock-step.
const TIER_HIERARCHY = ['community', 'enterprise', 'full'];

// Legacy tier names that we still accept on input (verify, activate,
// subscription rows) and silently normalise to a current tier. Removing 'pro'
// from the hierarchy without this map would 403 every existing paying
// customer the moment they reload the app.
const LEGACY_TIER_ALIAS = {
    pro: 'enterprise',
};

const TIER_FEATURES = {
    community: [
        'chat_basic',
        'kb_local_small',
        'nextcloud_basic',
        'single_user_login',
        'multi_user',
        'automations',
        'meeting_notes',
        'ticket_assistant',
        'nextcloud_oauth',
        'kb_unlimited',
        'webpages',
        'agent_routines',
        'voice_chat',
        'skills',
    ],
    enterprise: [
        'guardrails_dlp',
        'compliance_hub_gdpr',
        'compliance_hub_aia',
        'sso_saml',
        'audit_log_export',
        'custom_themes',
        'swarm',
        'advanced_analytics',
    ],
    full: [
        'white_label',
        'beeflow_internal_features',
        'license_issuance',
        'experimental_features',
    ],
};

const TIER_LIMITS = {
    community: {
        max_users: -1,
        max_agents: -1,
        max_messages_per_month: -1,
        max_kb_sources: -1,
    },
    enterprise: {
        max_users: -1,
        max_agents: -1,
        max_messages_per_month: -1,
        max_kb_sources: -1,
    },
    full: {
        max_users: -1,
        max_agents: -1,
        max_messages_per_month: -1,
        max_kb_sources: -1,
    },
};

function normalizeTier(tier) {
    if (typeof tier !== 'string') return tier;
    return LEGACY_TIER_ALIAS[tier] || tier;
}

function isValidTier(tier) {
    return TIER_HIERARCHY.includes(normalizeTier(tier));
}

function tierRank(tier) {
    const idx = TIER_HIERARCHY.indexOf(normalizeTier(tier));
    return idx === -1 ? -1 : idx;
}

/**
 * Returns true if `actual` is at or above `required`.
 * e.g. tierAtLeast('enterprise', 'community') === true
 *      tierAtLeast('community', 'enterprise') === false
 */
function tierAtLeast(actual, required) {
    return tierRank(actual) >= tierRank(required) && tierRank(required) !== -1;
}

/**
 * Returns the union of features for the given tier, including all lower tiers.
 */
function getFeaturesForTier(tier) {
    const n = normalizeTier(tier);
    if (!TIER_HIERARCHY.includes(n)) return [...TIER_FEATURES.community];
    const idx = TIER_HIERARCHY.indexOf(n);
    const merged = new Set();
    for (let i = 0; i <= idx; i++) {
        for (const f of TIER_FEATURES[TIER_HIERARCHY[i]]) merged.add(f);
    }
    return [...merged];
}

function getLimitsForTier(tier) {
    const n = normalizeTier(tier);
    if (!TIER_HIERARCHY.includes(n)) return { ...TIER_LIMITS.community };
    return { ...TIER_LIMITS[n] };
}

function tierHasFeature(tier, feature) {
    return getFeaturesForTier(tier).includes(feature);
}

module.exports = {
    TIER_HIERARCHY,
    TIER_FEATURES,
    TIER_LIMITS,
    LEGACY_TIER_ALIAS,
    normalizeTier,
    isValidTier,
    tierRank,
    tierAtLeast,
    getFeaturesForTier,
    getLimitsForTier,
    tierHasFeature,
};
