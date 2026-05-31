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
 * must remain usable with no license key present. Community ships the free
 * self-hosted core: chat with agents, knowledge bases (local, vector, hybrid,
 * reranked), the Nextcloud connector (including logging into Bee Flow from the
 * Nextcloud App Store app via `nextcloud_oauth`), multi-user with groups, the
 * skills marketplace and ALL built-in integrations (`integrations` — Google,
 * Microsoft, AI generation, third-party connectors, the Nextcloud module
 * family). Enterprise does NOT add the integrations themselves — it adds the
 * orchestration layer on top (no-code automation builder, scheduled agent
 * routines), the MCP server marketplace (`mcp_marketplace`, an enterprise beta),
 * SSO beyond Nextcloud (`sso_saml` — Google/Microsoft/SAML; Nextcloud OAuth
 * login stays Community via `nextcloud_oauth`) and the rest of the
 * Studio-class capabilities (voice chat,
 * webpages, automations, agent routines, meeting notes, ticket assistant,
 * notebooks, component designer, projects) on top, plus the advanced
 * Privacy Shield modes (tokenize PII, web-search guard), the non-overview
 * Usage & Monitoring tabs, and compliance / SSO / audit / themes / swarm
 * / analytics — and beta features in general are an enterprise+ benefit
 * (enforced in core/betaFeatures.js).
 *
 * The previous `pro` tier mapped to a roughly Studio-equivalent feature set.
 * Its features now live in `enterprise`; old `tier: 'pro'` JWTs and admin
 * blobs are accepted and silently resolved to `enterprise` via
 * LEGACY_TIER_ALIAS below — paying Pro customers gain (rather than lose)
 * capability vs. their original purchase.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  Subscription plans vs license keys — keep these two worlds separate
 * ──────────────────────────────────────────────────────────────────────────
 *
 *   LICENSE-KEY tiers (self-hosted installs):
 *     community   — free fallback; every self-hosted install starts here.
 *     enterprise  — paid self-hosted tier; SSO, compliance hub, swarm, etc.
 *     full        — internal/operator tier; white-label branding; only
 *                   issuable by FULL_TIER_ISSUER.
 *
 *   SUBSCRIPTION-PLAN tiers (Bee Flow Cloud only):
 *     tier ∈ {'pro', 'enterprise'} OR NULL (Free).
 *     'community' and 'full' are REJECTED at create/update time by
 *     userStore.createPlan / updatePlan. Cloud Free plans use tier=NULL and
 *     the resolver's community floor handles feature access transparently.
 *
 *   Why: 'community' is a self-hosted-install concept (the floor every
 *   unactivated install runs on); using it as a cloud subscription tier
 *   conflates two billing paths that should never overlap.
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
        'kb_unlimited',
        'nextcloud_basic',
        'nextcloud_oauth',
        'single_user_login',
        'multi_user',
        'skills',
        // Built-in integrations are part of the free Community core. This is a
        // declarative capability MARKER (it surfaces in
        // getLicenseStatus().features so the UI/docs can reference a real flag)
        // — it is NOT a route gate: integration tool usage in chat is ungated
        // by design (server/core/integrationTools.js gates only on
        // OAuth/credentials + org/user toggles, never on tier). Kept here so a
        // future edit can't silently move integrations behind Enterprise
        // without tripping the community feature tests.
        //
        // NOTE: the MCP server marketplace (`mcp_marketplace`) is NOT here — it
        // is an Enterprise beta (see below + core/betaFeatures.js). Nextcloud
        // OAuth login stays Community via `nextcloud_oauth`; Google/Microsoft/
        // SAML SSO are Enterprise via `sso_saml`.
        'integrations',
        // n8n-style free builder: the Automation builder + Agent Routines run
        // for free in Community, exactly how n8n Community Edition ships the
        // workflow builder gratis. Building is free; *collaborating* is paid —
        // org-wide automation sharing (`automation_sharing`) and team workspaces
        // (`projects`) stay Enterprise (see the enterprise array below).
        // Automations/routines are owner-private on every tier today (no
        // is_published/shared_groups on the automations/ai_tasks tables), so
        // shipping these to Community exposes no cross-user surface.
        // These are also GA beta features (core/betaFeatures.js) that are
        // Community-exempt from BETA_TIER_FLOOR; the two gates move together.
        'automations',
        'agent_routines',
    ],
    enterprise: [
        // Studio-class features promoted from community in the tier
        // tightening — see docs/docs/licensing/tiers.md. Beta features
        // (entire BETA_FEATURES registry) also gate behind enterprise via
        // core/betaFeatures.js _scopeAllowsBeta.
        //
        // NOTE: `automations` + `agent_routines` are NOT here — they moved to
        // the Community core above (n8n-style free builder). What stays
        // Enterprise is the *collaboration* layer on top: `automation_sharing`
        // (org-wide sharing of automations/routines — a reserve boundary; no
        // route consumes it yet) and `projects` (team workspaces — Bee Flow's
        // n8n-"Projects" equivalent).
        'automation_sharing',
        'voice_chat',
        'webpages',
        'meeting_notes',
        'ticket_assistant',
        'component_designer',
        'notebooks',
        'projects',
        'playwright_tests',
        // MCP server marketplace — Enterprise beta. Gated server-side on the
        // /ai/.../mcp-servers* routes and at runtime in directChatToolStack.js
        // (no MCP tools reach a Community agent), with a beta opt-in registered
        // in core/betaFeatures.js.
        'mcp_marketplace',
        // Privacy Shield clamps + Usage tabs — second wave. The licence
        // flag is the source of truth for the routes; orgPrivacyShield.js
        // and the four /api/usage sub-routes enforce these gates.
        'pii_tokenize',
        'web_search_guard',
        'advanced_usage_monitoring',
        // Compliance / admin block (unchanged).
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
