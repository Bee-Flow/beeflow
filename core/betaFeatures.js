/**
 * Beta Features — Central registry + gating helpers
 *
 * Manages which beta features exist and which organizations have access.
 * Beta features are stored per-organization in the `beta_features` column
 * on the `organizations` table (JSON array of feature IDs).
 *
 * Usage:
 *   const { requireBetaFeature, userHasBetaFeature } = require('./betaFeatures');
 *
 *   // In a route:
 *   router.get('/cool-thing', requireBetaFeature('advanced_analytics'), (req, res) => { ... });
 *
 *   // In business logic:
 *   if (await userHasBetaFeature(userId, 'ai_code_execution', req.session)) { ... }
 */

const { exec, getOne, run } = require('../db');

// ──────────────────────────────────────────────
// Beta Feature Registry
// Add new features here. This is the single source of truth.
// ──────────────────────────────────────────────
// `licenseFeature` (optional): if set, this beta is COMPOUND-gated — both
// the licence feature AND the beta flag must be true for the UI to show
// the feature. /auth/my-permissions derives `canUseFeature` from this so
// the frontend never has to reimplement the AND.
//
// `lifecycle` (optional, default 'beta'): drives admin UI labelling and
// auto-enable behaviour. Values:
//   - 'experimental' — internal-only / not advertised; super-admin only
//   - 'beta'         — opt-in per org; default state
//   - 'ga'           — generally available; auto-enabled for every org
//                      on a plan that allows it (org admin can still
//                      disable, but doesn't have to opt in)
//   - 'deprecated'   — slated for removal; UI shows sunset banner
const BetaLifecycle = Object.freeze({
    EXPERIMENTAL: 'experimental',
    BETA: 'beta',
    GA: 'ga',
    DEPRECATED: 'deprecated',
});

// ──────────────────────────────────────────────
// Tier short-circuit — beta features are an enterprise+ benefit.
//
// On a community-tier install (no licence key, or one resolving to the
// community floor) every beta opt-in is silently denied so the matrix
// in docs/docs/licensing/tiers.md actually means something. Super-admins
// bypass via the existing `session.isAdmin` shortcut in
// getUserBetaFeatures.
//
// `_licenseModule()` is lazy-required to break the betaFeatures ↔ license
// import cycle: license/middleware.js is loaded during server boot and
// indirectly pulls in /auth/my-permissions, which requires this file.
// Resolving licence at module-load time would deadlock.
// ──────────────────────────────────────────────
const BETA_TIER_FLOOR = 'enterprise';
let _license = null;
function _licenseModule() {
    if (!_license) _license = require('../license');
    return _license;
}

/**
 * True iff the resolved tier for the given scope is at or above the beta
 * floor. Caller passes the scope it already has — `tierHint` short-circuits
 * the resolve when the licence middleware already cached a result for the
 * current request.
 *
 * Throws `FeatureServiceUnavailableError` on resolve failure (fail closed)
 * so request-path callers can surface a 503 retry rather than silently
 * granting access. Background callers (cron) wrap this with a try/catch
 * and fail-quiet — matching the existing fail-quiet stance in
 * `orgHasBetaFeature`.
 */
async function _scopeAllowsBeta({ userId = null, organizationId = null, tierHint = null } = {}) {
    if (tierHint) {
        return _licenseModule().tiers.tierAtLeast(tierHint, BETA_TIER_FLOOR);
    }
    try {
        const lic = _licenseModule();
        const tier = await lic.resolveTier({ organizationId, userId });
        return lic.tiers.tierAtLeast(tier, BETA_TIER_FLOOR);
    } catch (e) {
        throw new FeatureServiceUnavailableError(e);
    }
}

const BETA_FEATURES = [
    { id: 'meeting_notes', name: 'Meeting Notes', description: 'Audio transcription, meeting summaries, and action item extraction', licenseFeature: 'meeting_notes', lifecycle: BetaLifecycle.BETA },
    { id: 'advanced_analytics', name: 'Advanced Analytics', description: 'Extended analytics dashboards and reporting', licenseFeature: 'advanced_analytics', lifecycle: BetaLifecycle.BETA },
    { id: 'ai_code_execution', name: 'AI Code Execution', description: 'Allow the AI agent to execute code in a sandboxed environment', lifecycle: BetaLifecycle.EXPERIMENTAL },
    { id: 'custom_themes', name: 'Custom Themes', description: 'Organization-level custom branding and theme support', licenseFeature: 'custom_themes', lifecycle: BetaLifecycle.BETA },
    { id: 'skills', name: 'Skills', description: 'Reusable instruction packs for consistent AI task execution', licenseFeature: 'skills', lifecycle: BetaLifecycle.BETA },
    { id: 'flow', name: 'Flow Model Tier', description: 'Multi-stage orchestration chat tier ("Flow") that bootstraps chat-local session skills. Requires the Skills beta feature to function — both must be enabled.', lifecycle: BetaLifecycle.BETA },
    { id: 'itil_ticket_assistant', name: 'ITIL Ticket Assistant', description: 'Connect ITSM platforms (Jira, ServiceNow, Zendesk, Freshservice, TopDesk) and email mailboxes as knowledge base sources. Tickets + emails are turned into structured solution articles (Root Cause / Resolution) for agent self-service.', licenseFeature: 'ticket_assistant', lifecycle: BetaLifecycle.BETA },
    // Legacy alias — retained for one release. The initDB() migration in
    // ticketAssistantStore.js rewrites stored org beta_features from
    // 'email_knowledge_base' to 'itil_ticket_assistant' on boot; this entry
    // keeps membership lookups working during the transition window.
    { id: 'email_knowledge_base', name: 'Email Knowledge Base (deprecated)', description: 'Renamed to "ITIL Ticket Assistant". Existing enablements are auto-migrated.', aliasOf: 'itil_ticket_assistant', deprecated: true, lifecycle: BetaLifecycle.DEPRECATED, sunsetDate: '2026-06-30' },
    { id: 'voice_chat', name: 'Voice Chat (Beta)', description: 'Realtime voice conversation with direct chat or agents, powered by Mistral Voxtral (STT + TTS). Requires a configured Mistral API key.', licenseFeature: 'voice_chat', lifecycle: BetaLifecycle.BETA },
    { id: 'swarm', name: 'Swarm Agents', description: 'Multi-agent swarms (Deep Research, etc.) that run specialised AI workers in parallel phases and synthesise a single answer. Workers share findings via a Hive Mind notebook.', licenseFeature: 'swarm', lifecycle: BetaLifecycle.BETA },
    { id: 'knowledge_bases_beta', name: 'Knowledge Bases (Beta badge)', description: 'Show a "beta" badge on the Knowledge Bases sidebar item. Cosmetic — does not gate access.', lifecycle: BetaLifecycle.BETA },
    { id: 'webpages', name: 'Webpages', description: 'AI-built static webpages. Three-file projects (index.html / style.css / script.js) hosted in RustFS, with sandboxed live preview, auto-versioning, KB-grounded AI chat, and a one-click ZIP download.', licenseFeature: 'webpages', lifecycle: BetaLifecycle.BETA },
    { id: 'automations', name: 'Automations', description: 'Conversational no-code automation builder. Users describe an automation in chat; the AI assembles a typed DAG that mixes scheduled triggers, integration actions, AI reasoning steps, conditions, loops, and notifications. Includes dry-run preview, run history, and webhook + app-event triggers.', licenseFeature: 'automations', lifecycle: BetaLifecycle.BETA },
    { id: 'agent_routines', name: 'Agent routines', description: 'Schedule recurring tasks that run through a specific agent. The routine fires the agent on a cron-like schedule with the full agent runtime (system prompt, attached skills, knowledge bases, integrations) and saves the result to a persistent chat thread.', licenseFeature: 'agent_routines', lifecycle: BetaLifecycle.BETA },
    { id: 'dutch_legal_sources', name: 'Dutch Legal Sources', description: 'Nederlandse juridische bronnen — geconsolideerde wetgeving (BW, Awb, Rv, Wvk, AVG-uitvoeringswet) als systeem-KB, plus tools voor jurisprudentie (rechtspraak.nl) en EU-recht (EUR-Lex / HvJEU) in het Nederlands. Bedoeld voor juridische agents die juristen helpen bij opstellen van adviezen, contracten en pleitnota’s. Alle bronnen zijn vrij te gebruiken (overheid open data).', freeForAllOrgs: true, lifecycle: BetaLifecycle.BETA },
    { id: 'playwright_tests', name: 'Playwright Tests (Beta)', description: 'Generate and run Playwright tests against external sites from conversations, GitHub commits, YouTrack issues or free text. Includes an explore mode that drives a Chromium browser without pre-generated tests and reports findings.', licenseFeature: 'playwright_tests', lifecycle: BetaLifecycle.BETA },
];

function getFeatureLifecycle(featureOrId) {
    const f = typeof featureOrId === 'string'
        ? BETA_FEATURES.find(x => x.id === featureOrId)
        : featureOrId;
    return f?.lifecycle || BetaLifecycle.BETA;
}

// Log a startup warning for every feature with a sunsetDate in the past
// (or close to it). Operators see this once per boot — meant as a nudge,
// not a runtime gate. The matching `lifecycle: 'deprecated'` entries can
// be deleted from the registry after the sunsetDate has elapsed across
// all environments.
(function _logSunsetWarnings() {
    try {
        const now = Date.now();
        const WARN_AHEAD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
        for (const f of BETA_FEATURES) {
            if (!f.sunsetDate) continue;
            const sunset = Date.parse(f.sunsetDate);
            if (!Number.isFinite(sunset)) continue;
            if (sunset <= now) {
                console.warn(`[BetaFeatures] '${f.id}' is past its sunset date (${f.sunsetDate}). Safe to remove from registry.`);
            } else if (sunset - now < WARN_AHEAD_MS) {
                const days = Math.ceil((sunset - now) / (24 * 60 * 60 * 1000));
                console.warn(`[BetaFeatures] '${f.id}' sunsets in ${days} day(s) (${f.sunsetDate}). Schedule removal.`);
            }
        }
    } catch (_) { /* never block boot for a banner */ }
})();

function listBetaFeatures() {
    return BETA_FEATURES.slice();
}

function listCompoundGatedFeatures() {
    return BETA_FEATURES.filter(f => !!f.licenseFeature && !f.deprecated);
}

// -──────────────────────────────────────────────
// Lazy migration — ensure the column exists (deferred until first use)
// ──────────────────────────────────────────────
let migrated = false;
async function ensureColumn() {
    if (migrated) return;
    try {
        await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS beta_features TEXT DEFAULT '[]'`);
        console.log('[BetaFeatures] Added beta_features column to organizations table');
    } catch (_) {
        // Column already exists or table doesn't exist yet — expected during cold start
    }
    migrated = true;
}

// ──────────────────────────────────────────────
// Data helpers
// ──────────────────────────────────────────────

/**
 * Get the beta feature IDs enabled for an organization.
 * @param {string} orgId
 * @returns {Promise<string[]>}
 */
async function getOrgBetaFeatures(orgId) {
    try {
        await ensureColumn();
        const row = await getOne('SELECT beta_features FROM organizations WHERE id = $1', [orgId]);
        if (!row || !row.beta_features) return [];
        return JSON.parse(row.beta_features);
    } catch (_) {
        return [];
    }
}

/**
 * Set the beta feature IDs for an organization.
 * @param {string} orgId
 * @param {string[]} features — array of feature IDs from the registry
 * @returns {Promise<boolean>}
 */
async function setOrgBetaFeatures(orgId, features) {
    try {
        await ensureColumn();
        const validIds = new Set(BETA_FEATURES.map(f => f.id));
        const filtered = features.filter(id => validIds.has(id));
        await run('UPDATE organizations SET beta_features = $1 WHERE id = $2', [JSON.stringify(filtered), orgId]);
        return true;
    } catch (err) {
        console.error('[BetaFeatures] setOrgBetaFeatures error:', err);
        return false;
    }
}

/**
 * Resolve the full set of beta features available to a user.
 * Super admins get ALL features.
 *
 * @param {string} userId
 * @param {object|null} session — express session (for isAdmin flag)
 * @returns {Promise<string[]>} array of feature IDs
 */
/**
 * Sentinel error thrown when the feature lookup itself failed (DB down,
 * Redis unreachable, etc.) — distinguishes "no features" from "couldn't
 * tell". Callers (middleware) translate this to a 503 so customers see a
 * retryable error instead of silently losing access to features they pay
 * for.
 */
class FeatureServiceUnavailableError extends Error {
    constructor(cause) {
        super('feature_service_degraded');
        this.name = 'FeatureServiceUnavailableError';
        this.cause = cause;
    }
}

async function getUserBetaFeatures(userId, session = null, { tierHint = null } = {}) {
    if (session?.isAdmin) {
        return BETA_FEATURES.map(f => f.id);
    }

    let user;
    try {
        const userStore = require('../stores/userStore');
        user = await userStore.getUser(userId);
    } catch (err) {
        console.error('[BetaFeatures] user lookup failed:', err.message);
        throw new FeatureServiceUnavailableError(err);
    }
    if (!user) return [];

    if (user.role === 'admin') return BETA_FEATURES.map(f => f.id);

    // Tier short-circuit: beta features require enterprise+. Reuses the
    // licence-middleware cache on req.session._lic:<userId>:v<ver> when caller
    // passes tierHint; otherwise resolves on demand. Throws
    // FeatureServiceUnavailableError on lookup failure so the caller
    // surfaces a 503 rather than silently granting access.
    //
    // The :v<ver> suffix mirrors license/middleware.js — the cache key is
    // versioned by the install-wide server-licence counter so a
    // server-wide activation bust applies install-wide.
    const serverVer = _licenseModule().getServerLicenseVersion ? _licenseModule().getServerLicenseVersion() : 0;
    const cacheKey = `_lic:${userId}:v${serverVer}`;
    const cached = session && session[cacheKey];
    const cachedTier = cached?.value?.tier && cached.expiresAt > Date.now() ? cached.value.tier : null;
    const effectiveHint = tierHint || cachedTier;
    const orgIdForResolve = user.organizationId || (Array.isArray(user.groups) ? null : null);
    if (!(await _scopeAllowsBeta({ userId, organizationId: orgIdForResolve, tierHint: effectiveHint }))) {
        return [];
    }

    let groupIds = [];
    if (Array.isArray(user.groups)) {
        groupIds = user.groups;
    } else {
        try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { }
    }

    let allGroups;
    try {
        const userStore = require('../stores/userStore');
        allGroups = await userStore.getAllGroups();
    } catch (err) {
        console.error('[BetaFeatures] groups lookup failed:', err.message);
        throw new FeatureServiceUnavailableError(err);
    }

    const orgIds = new Set();
    if (user.organizationId) orgIds.add(user.organizationId);
    for (const gid of groupIds) {
        const group = allGroups.find(g => g.id === gid);
        if (group?.organizationId) orgIds.add(group.organizationId);
    }

    // Intersection of the super-admin allow-list with the org-admin
    // "active" subset — both must include a feature for it to be
    // available to users in the org. Exception: features marked
    // `freeForAllOrgs: true` skip the allow-list step — the org-admin
    // active toggle is authoritative on its own. Used for fully free
    // features (open-data sources etc.) where a separate super-admin
    // grant per org is friction without security value.
    const freeForAll = new Set(
        BETA_FEATURES.filter(f => f.freeForAllOrgs).map(f => f.id)
    );
    // GA-lifecycle features auto-enable when they're in the allowed set —
    // org admins can still flip them off explicitly, but they don't need to
    // toggle them on. This is the off-switch / GA-promotion mechanism.
    const gaSet = new Set(
        BETA_FEATURES.filter(f => f.lifecycle === BetaLifecycle.GA).map(f => f.id)
    );
    const featureSet = new Set();
    try {
        const userStore = require('../stores/userStore');
        for (const orgId of orgIds) {
            const allowed = await getOrgBetaFeatures(orgId);
            const active = await userStore.getOrgEnabledBetaFeatures(orgId);
            const activeSet = new Set(active);
            const allowedSet = new Set([...allowed, ...freeForAll]);
            for (const fid of allowedSet) {
                if (activeSet.has(fid)) { featureSet.add(fid); continue; }
                // GA: auto-active unless org-admin has explicitly turned it
                // off. The org-admin "off" representation is presence in
                // `active` for everything else — for GA we need an explicit
                // opt-out marker. We treat absence-from-active as "default
                // on" for GA features.
                if (gaSet.has(fid)) featureSet.add(fid);
            }
        }
    } catch (err) {
        console.error('[BetaFeatures] org allow-list lookup failed:', err.message);
        throw new FeatureServiceUnavailableError(err);
    }

    return [...featureSet];
}

/**
 * Given a feature ID, return the set of IDs that count as "the same feature"
 * for access-check purposes — the canonical target plus any deprecated
 * aliases pointing to it (and the reverse direction).
 */
function resolveFeatureAliases(featureId) {
    const ids = new Set([featureId]);
    for (const entry of BETA_FEATURES) {
        if (entry.id === featureId && entry.aliasOf) ids.add(entry.aliasOf);
        if (entry.aliasOf === featureId) ids.add(entry.id);
    }
    return ids;
}

/**
 * Check if a specific user has access to a beta feature.
 * Aliased feature IDs (e.g. legacy 'email_knowledge_base' →
 * 'itil_ticket_assistant') are treated as equivalent.
 */
async function userHasBetaFeature(userId, featureId, session = null) {
    const aliases = resolveFeatureAliases(featureId);
    const userFeatures = await getUserBetaFeatures(userId, session);
    return userFeatures.some(id => aliases.has(id));
}

/**
 * Check whether an organization has a beta feature available. Used by
 * background runners (automations, schedulers) where there's no user session
 * to pass through `userHasBetaFeature`. Applies the same intersection rule:
 * the super-admin allow-list must contain the feature AND the org-admin
 * must have it in the active subset. `freeForAllOrgs` features skip the
 * super-admin step.
 */
async function orgHasBetaFeature(orgId, featureId, { tierHint = null } = {}) {
    if (!orgId) return false;
    // Tier short-circuit — background callers fail-quiet (matches the
    // existing catch-all return-false at the bottom of this function).
    try {
        if (!(await _scopeAllowsBeta({ organizationId: orgId, tierHint }))) return false;
    } catch (_) {
        return false;
    }
    try {
        const aliases = resolveFeatureAliases(featureId);
        const gaSet = new Set(
            BETA_FEATURES.filter(f => f.lifecycle === BetaLifecycle.GA).map(f => f.id)
        );
        const freeForAll = new Set(
            BETA_FEATURES.filter(f => f.freeForAllOrgs).map(f => f.id)
        );
        const allowed = new Set([...(await getOrgBetaFeatures(orgId)), ...freeForAll]);
        const userStore = require('../stores/userStore');
        let active = [];
        try { active = await userStore.getOrgEnabledBetaFeatures(orgId); }
        catch (_) { active = []; }
        const activeSet = new Set(active);
        for (const id of aliases) {
            if (!allowed.has(id)) continue;
            if (activeSet.has(id)) return true;
            // GA: allowed + (not explicitly inactive) → enabled.
            if (gaSet.has(id)) return true;
        }
        return false;
    } catch (err) {
        console.error('[BetaFeatures] orgHasBetaFeature error:', err);
        return false;
    }
}

/**
 * Express middleware factory — gates a route behind a beta feature flag.
 *
 * Three response paths:
 *   - feature allowed       → next()
 *   - feature not allowed   → 403 (definitive answer)
 *   - lookup itself failed  → 503 with Retry-After=10 (caller retries)
 *
 * The 503 path is critical: previously, any DB error returned an empty
 * feature list, silently kicking customers out of features they pay for.
 * Now those failures surface as transient errors customers can retry.
 */
function requireBetaFeature(featureId) {
    return async (req, res, next) => {
        if (!req.session?.user) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        const userId = req.session.user?.id;
        try {
            if (await userHasBetaFeature(userId, featureId, req.session)) {
                return next();
            }
            // Distinguish "your tier doesn't allow beta features at all" from
            // "your org admin hasn't enabled this one" so the frontend can
            // route to the right CTA (upgrade vs. ask-your-admin). Reuses the
            // resolution the previous call already produced via the session
            // cache so this is just a tier comparison, not a second resolve.
            const serverVerForCache = _licenseModule().getServerLicenseVersion ? _licenseModule().getServerLicenseVersion() : 0;
            const cached = req.session?.[`_lic:${userId}:v${serverVerForCache}`];
            const cachedTier = cached?.expiresAt > Date.now() ? cached.value?.tier : null;
            const allowed = await _scopeAllowsBeta({
                organizationId: req.session.user.organizationId,
                userId,
                tierHint: cachedTier,
            }).catch(() => false);
            if (!allowed) {
                return res.status(403).json({
                    error: 'feature_locked',
                    feature: featureId,
                    reason: 'beta_requires_enterprise',
                    required: BETA_TIER_FLOOR,
                    upgrade_url: process.env.LICENSE_UPGRADE_URL || 'https://beeflow.ai/pricing',
                });
            }
            return res.status(403).json({ error: `Beta feature '${featureId}' is not enabled for your organization` });
        } catch (err) {
            if (err instanceof FeatureServiceUnavailableError) {
                res.set('Retry-After', '10');
                return res.status(503).json({
                    error: 'feature_service_degraded',
                    message: 'Feature service is temporarily unavailable. Please retry shortly.',
                });
            }
            console.error('[BetaFeatures] middleware error:', err);
            return res.status(500).json({ error: 'feature_check_failed' });
        }
    };
}

module.exports = {
    BETA_FEATURES,
    BetaLifecycle,
    listBetaFeatures,
    listCompoundGatedFeatures,
    getFeatureLifecycle,
    getOrgBetaFeatures,
    setOrgBetaFeatures,
    getUserBetaFeatures,
    userHasBetaFeature,
    orgHasBetaFeature,
    requireBetaFeature,
    FeatureServiceUnavailableError,
};
