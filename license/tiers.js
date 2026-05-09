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
 *   community  →  pro  →  enterprise  →  full
 *
 * Default state for a fresh, unactivated install is `community` — the system
 * must remain usable with no license key present.
 */

const TIER_HIERARCHY = ['community', 'pro', 'enterprise', 'full'];

const TIER_FEATURES = {
    community: [
        'chat_basic',
        'kb_local_small',
        'nextcloud_basic',
        'single_user_login',
    ],
    pro: [
        'multi_user',
        'unlimited_agents',
        'automations',
        'meeting_notes',
        'ticket_assistant',
        'nextcloud_oauth',
        'kb_unlimited',
        'webpages',
        'agent_routines',
        'voice_chat',
    ],
    enterprise: [
        'guardrails_dlp',
        'compliance_hub_gdpr',
        'compliance_hub_aia',
        'sso_saml',
        'audit_log_export',
        'custom_themes',
        'skills',
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
        max_users: 1,
        max_agents: 2,
        max_messages_per_month: 1000,
        max_kb_sources: 5,
    },
    pro: {
        max_users: 25,
        max_agents: 20,
        max_messages_per_month: 50000,
        max_kb_sources: 100,
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

function isValidTier(tier) {
    return TIER_HIERARCHY.includes(tier);
}

function tierRank(tier) {
    const idx = TIER_HIERARCHY.indexOf(tier);
    return idx === -1 ? -1 : idx;
}

/**
 * Returns true if `actual` is at or above `required`.
 * e.g. tierAtLeast('pro', 'community') === true
 *      tierAtLeast('community', 'pro') === false
 */
function tierAtLeast(actual, required) {
    return tierRank(actual) >= tierRank(required) && tierRank(required) !== -1;
}

/**
 * Returns the union of features for the given tier, including all lower tiers.
 */
function getFeaturesForTier(tier) {
    if (!isValidTier(tier)) return [...TIER_FEATURES.community];
    const idx = TIER_HIERARCHY.indexOf(tier);
    const merged = new Set();
    for (let i = 0; i <= idx; i++) {
        for (const f of TIER_FEATURES[TIER_HIERARCHY[i]]) merged.add(f);
    }
    return [...merged];
}

function getLimitsForTier(tier) {
    if (!isValidTier(tier)) return { ...TIER_LIMITS.community };
    return { ...TIER_LIMITS[tier] };
}

function tierHasFeature(tier, feature) {
    return getFeaturesForTier(tier).includes(feature);
}

module.exports = {
    TIER_HIERARCHY,
    TIER_FEATURES,
    TIER_LIMITS,
    isValidTier,
    tierRank,
    tierAtLeast,
    getFeaturesForTier,
    getLimitsForTier,
    tierHasFeature,
};
