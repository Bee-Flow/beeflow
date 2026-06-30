/**
 * Entitlements — the single resolver + gate.
 *
 * Replaces the scattered tier/feature/beta/integration/MCP decision points with
 * ONE answer to "what can this user use, in the context of this org?". The shape
 * is identical in both deployment modes; only the SOURCE of the ceiling differs:
 *
 *   ceiling   = cloud → subscription plan ;  self-hosted → license tier
 *   narrowed by an org + group GRANT layer (grant-only — no per-group "disable")
 *   effective = (orgGrant ∪ groupGrant) ∩ ceiling
 *
 * Precedence (per kind, per mode) — see docs + the unified-entitlement plan:
 *
 *   tier      = max(userTier, every user-org tier, server-license if self-hosted)
 *   CEILING.core        = tierHasFeature(tier,f) OR plan-additive grant (orgGrantsFeature)
 *   CEILING.beta(cloud) = plan.allowed_beta_features (null⇒all; no plan⇒admin grant)  + compound AND
 *   CEILING.beta(self)  = tier≥enterprise ? all registry : GA-betas-∈-community         + compound AND
 *   CEILING.integration = cloud ? catalog∩plan.allowed_integrations (null⇒all catalog)
 *                                  + mcp:<id> (null⇒all installed; else only when EXPLICIT in allow-list)
 *                               : all catalog + all installed mcp:<id>
 *                         (MCP = integrations; restricted plans opt-in per allow-list, unrestricted/null = all)
 *   GLOBAL kill-switch  : ceiling.core −= notebooks/projects when feature_*_enabled === false
 *   orgGrant            : integration ← org_enabled_integrations (NC + exempt bypass; mcp:<id> too);
 *                         beta ← cloud:ceiling | self:org_enabled_beta_features + GA-auto-on;
 *                         core ← org_granted_capabilities + non-togglable core implicitly
 *   groupGrant(user)    : ⋃ granted_capabilities of the user's groups IN THIS ORG (scoped per org)
 *   EFFECTIVE           = (orgGrant ∪ groupGrant) ∩ ceiling ; super-admin ⇒ ceiling (skip grants)
 *   consumer (orgId=ø)  : ceiling from consumer subscription + default_consumer_beta_features; no org/group layer
 *
 * The per-user `enabled_apps` selection and the legacy NC per-group opt-out
 * (groups.disabled_integrations, "enable wins") are NOT applied here — they stay
 * the final tool-selection step in core/integrationTools.js so the NC connector
 * path and existing per-user prefs are untouched.
 *
 * Fail-closed: a tier/lookup failure sets `degraded:true`. Request-path callers
 * (requireCapability) translate that to 503; background callers must treat it as
 * "skip + alert", never "run with zero tools".
 */

const license = require('../license');
const tiers = license.tiers;
const registry = require('./capabilityRegistry');
const { CapabilityKind: KIND } = registry;
const _metrics = require('./httpMetrics');

const UPGRADE_URL = process.env.LICENSE_UPGRADE_URL || 'https://beeflow.nl/pricing';
const RESOLUTION_CACHE_TTL_MS = parseInt(process.env.ENTITLEMENT_CACHE_TTL_MS || '30000', 10);
const COMMUNITY = tiers.TIER_HIERARCHY[0];

// Per-deployment operator kill switches (feature_notebooks_enabled /
// feature_projects_enabled) are intentionally NOT folded into the resolver — they
// stay as the dedicated projectFeatureGate / notebookFeatureGate middleware in
// server/index.js so their distinct "feature is disabled" operator message is
// preserved and the kill switch remains a deployment concern, not an entitlement.

// Integrations that bypass the org-level grant intersection — mirror of
// integrationTools.ORG_EXEMPT_APPS. They are infra tools, never org-gated.
const ORG_EXEMPT_APPS = new Set(['workspace', 'regex-gen', 'kb-ingest']);

// ── lazy requires (avoid boot-time import cycles) ────────────────────────
let _userStore, _beta, _planEnt, _configStore, _middleware, _sessionCache;
function userStore() { return _userStore || (_userStore = require('../stores/userStore')); }
function beta() { return _beta || (_beta = require('./betaFeatures')); }
function planEnt() { return _planEnt || (_planEnt = require('../services/planEntitlements')); }
function configStore() { return _configStore || (_configStore = require('../stores/configStore')); }
function middleware() { return _middleware || (_middleware = require('../license/middleware')); }
function sessionCache() { return _sessionCache || (_sessionCache = require('../auth/sessionCache')); }

// Single-tenant detection (cached, TTL-only). A no-org global admin in a
// self-hosted single-org install must still be bound by that one org's access
// ceiling — see governingOrgId in resolveEntitlements. org-create does not bust
// sessions/version, so a short window after a 2nd org is created is acceptable.
const SINGLE_ORG_TTL_MS = 60000;
let _singleOrgCache = { value: null, expiresAt: 0 };
async function singleOrgId() {
    if (_singleOrgCache.expiresAt > Date.now()) return _singleOrgCache.value;
    let id = null;
    try { id = await userStore().getSingleOrgId(); } catch (_) { id = null; }
    _singleOrgCache = { value: id, expiresAt: Date.now() + SINGLE_ORG_TTL_MS };
    return id;
}

function emptyKindSets() {
    return { core: new Set(), beta: new Set(), integration: new Set() };
}
function cloneKindSets(s) {
    return { core: new Set(s.core), beta: new Set(s.beta), integration: new Set(s.integration) };
}
function kindSetsToArrays(s) {
    return { core: [...s.core], beta: [...s.beta], integration: [...s.integration] };
}

function isSuperAdmin(session, user) {
    return !!(session?.isAdmin || session?.user?.role === 'admin' || user?.role === 'admin');
}

function parseGroupIds(user) {
    if (!user) return [];
    if (Array.isArray(user.groups)) return user.groups;
    try { return JSON.parse(user.groups || '[]'); } catch (_) { return []; }
}

// ── tier context ─────────────────────────────────────────────────────────
// Reuses the license layer; this module owns ZERO tier math. Returns
// { tier, orgTier, orgIds, superAdmin, degraded }.
async function resolveTierContext({ userId, orgId, session, req, tierHint }) {
    const superAdmin = isSuperAdmin(session, null);

    if (tierHint) {
        return { tier: tierHint, orgTier: tierHint, orgIds: orgId ? [orgId] : [], superAdmin };
    }

    // Request path: reuse the license middleware (group-org resolution, super-
    // admin bypass, per-request cache, fail-closed tier_unavailable).
    if (req) {
        try {
            const r = await middleware().resolveBestTierForRequest(req);
            if (r.error === 'tier_unavailable') return { degraded: true };
            const orgIds = new Set(r.orgIds || []);
            if (orgId) orgIds.add(orgId);
            const orgTier = orgId ? await safeOrgTier([orgId]) : r.tier;
            return { tier: r.tier, orgTier, orgIds: [...orgIds], superAdmin: !!r.superAdmin || superAdmin };
        } catch (_) {
            return { degraded: true };
        }
    }

    // Background / no-req path (automation runner, cron). First-class, not an
    // afterthought — these callers have no Express session.
    if (superAdmin) {
        const orgTier = orgId ? await safeOrgTier([orgId]) : 'full';
        return { tier: 'full', orgTier, orgIds: orgId ? [orgId] : [], superAdmin: true };
    }
    try {
        const orgT = orgId ? await license.getBestTierForOrgs([orgId]) : COMMUNITY;
        const userT = userId ? await license.getTierForUser(userId) : COMMUNITY;
        const tier = tiers.tierRank(orgT) >= tiers.tierRank(userT) ? orgT : userT;
        return { tier, orgTier: orgId ? orgT : tier, orgIds: orgId ? [orgId] : [], superAdmin: false };
    } catch (_) {
        return { degraded: true };
    }
}

async function safeOrgTier(orgIds) {
    try { return await license.getBestTierForOrgs(orgIds); } catch (_) { return COMMUNITY; }
}

// ── ceiling ──────────────────────────────────────────────────────────────
async function buildCeiling({ mode, tier, orgTier, orgId, orgIds, userId, superAdmin = false }) {
    const ceil = emptyKindSets();
    // Project installed MCP servers as integration capabilities before we read
    // the registry, so the integration ceiling below sees them.
    await registry.refreshMcpIntegrationDescriptors();
    const caps = registry.listCapabilities();

    // Super-admin (global/platform admin) bypasses per-org licensing for all
    // FEATURE capabilities — every core feature and every beta — mirroring the
    // licence middleware's tier:'full' bypass and getUserBetaFeatures' "admins
    // get all betas". Without this a cloud admin whose org plan omits a beta
    // (e.g. webpages) hits feature_locked even though the frontend shows it.
    // INTEGRATIONS are deliberately NOT force-granted: MCP servers stay opt-in
    // per plan even for admins (anti-leak — a newly installed server must be
    // added to a plan before anyone, admin included, can use it), so the
    // integration ceiling below still governs them.

    // CORE — admin: all; else tier feature OR plan-additive grant (plan.allowed_features).
    for (const c of caps) {
        if (c.kind !== KIND.CORE) continue;
        if (superAdmin) { ceil.core.add(c.id); continue; }
        if (tiers.tierHasFeature(tier, c.licenseFeature)) { ceil.core.add(c.id); continue; }
        if (orgIds.length && await license.orgGrantsFeature(orgIds, c.licenseFeature)) ceil.core.add(c.id);
    }

    // BETA — admin: every beta; else allow-list per mode, then compound AND.
    let betaAllow;
    if (superAdmin) {
        betaAllow = new Set(caps.filter(c => c.kind === KIND.BETA).map(c => c.id));
    } else if (mode === 'cloud') {
        // Use the user's FULL resolved org set (direct org + group-based orgs),
        // not just the single session `organizationId`. A user who belongs to an
        // org ONLY via a GROUP has no direct organizationId, so gating the beta
        // allow-list on it alone fell through to the empty consumer list and 403'd
        // betas the org's subscription clearly grants — the org-scoped admin view
        // showed them enabled while the user got feature_locked. Union the plan
        // allow-lists across their orgs (mirrors the old getUserBetaFeatures sweep;
        // org-scoped resolves pass orgIds=[orgId] so the admin view is unchanged).
        const cloudOrgIds = (orgIds && orgIds.length) ? orgIds : (orgId ? [orgId] : []);
        if (cloudOrgIds.length) {
            const allow = new Set();
            for (const oid of cloudOrgIds) {
                for (const id of await beta().getEffectiveOrgBetaAllowList(oid)) allow.add(id);
            }
            betaAllow = allow;
        } else {
            betaAllow = new Set(await consumerBetaAllow(userId));
        }
    } else {
        const all = beta().listBetaFeatures();
        if (tiers.tierAtLeast(tier, 'enterprise')) {
            betaAllow = new Set(all.map(f => f.id));
        } else {
            // Community self-hosted: only GA betas whose license feature ∈ community.
            betaAllow = new Set(all
                .filter(f => f.lifecycle === 'ga' && f.licenseFeature && tiers.tierHasFeature('community', f.licenseFeature))
                .map(f => f.id));
        }
    }
    for (const c of caps) {
        if (c.kind !== KIND.BETA) continue;
        if (!betaAllow.has(c.id)) continue;
        // CLOUD: the subscription's "Included beta features" (betaAllow, above) is
        // the SOLE authority — a plan-included beta is granted outright, with NO
        // extra licence-feature/tier gate. The admin already chose to include it in
        // the plan (and that choice also unlocks its paid capability), so a Free/
        // community-tier plan that includes e.g. webpages simply gets webpages.
        // SELF-HOSTED: the server-licence tier governs, so keep the compound check
        // (betaAllow there is already tier-derived; this just enforces the licence
        // feature lives in the tier).
        if (mode !== 'cloud' && !superAdmin && c.licenseFeature) {
            if (!tiers.tierHasFeature(tier, c.licenseFeature)) continue;
        }
        ceil.beta.add(c.id);
    }

    // INTEGRATION — MCP servers are integrations now (id `mcp:<id>`). On a
    // RESTRICTED (explicit allow-list) plan they remain OPT-IN: a server only
    // enters the ceiling when its id is EXPLICITLY listed — so paid tiers gate
    // MCP precisely. An UNRESTRICTED (null) cap means "everything" (Enterprise),
    // so it covers the full catalog AND all installed MCP servers — otherwise an
    // unlimited plan could never grant MCP at all (you'd have to convert it to a
    // giant explicit list). The org-level toggle (org_enabled_integrations, MCP
    // defaultState 'off') still governs whether each server is actually granted.
    // Self-hosted / consumer (no plan cap) likewise get all catalog + all MCP.
    const catalogIds = caps.filter(c => c.kind === KIND.INTEGRATION && !c._mcpServer).map(c => c.id);
    const mcpIds = caps.filter(c => c.kind === KIND.INTEGRATION && c._mcpServer).map(c => c.id);
    if (mode === 'cloud' && orgId) {
        let cap = undefined;
        try { cap = (await planEnt().getOrgCaps(orgId)).integrations; } catch (_) { cap = null; }
        if (cap == null) {
            for (const id of catalogIds) ceil.integration.add(id);
            for (const id of mcpIds) ceil.integration.add(id); // unrestricted ⇒ all catalog + all installed MCP
        } else {
            const allow = new Set(cap);
            for (const id of catalogIds) if (allow.has(id)) ceil.integration.add(id);
            for (const id of mcpIds) if (allow.has(id)) ceil.integration.add(id); // MCP only when explicit
        }
    } else {
        for (const id of catalogIds) ceil.integration.add(id);
        for (const id of mcpIds) ceil.integration.add(id);
    }

    // CUSTOM (AI-built, org-scoped) integrations — 'custom:<uuid>'. Deliberate
    // DIVERGENCE from the mcp:<id> plan-listing above: plans gate the BUILDER
    // capability (the 'ai_integration_builder' beta), never the per-org uuids —
    // a plan editor cannot enumerate org-local integration ids, so an explicit
    // allow-list is impossible by design. Instead every ACTIVE custom
    // integration of THIS org enters the ceiling iff the org's plan/tier
    // ceiling includes the builder beta. ceil.beta is FINAL by this point (the
    // beta section is computed above in this same function). The accessor is
    // org-scoped, so another org's customs can never leak in; consumer/no-org
    // resolves get none (the if(orgId) wrapper covers cloud and self-hosted
    // alike). computeReasons needs NO change: customs never appear in
    // listCapabilities(), so they produce no reason rows.
    if (orgId) {
        const customs = await registry.listCustomIntegrationCapabilities(orgId);
        if (customs.length && ceil.beta.has('ai_integration_builder')) {
            for (const c of customs) ceil.integration.add(c.id);
        }
    }

    return ceil;
}

async function consumerBetaAllow(userId) {
    // Consumer (no-org) beta allow-list = the operator-set default list. The
    // consumer subscription tier already governs the compound-AND license term.
    try {
        const cfg = await configStore().getConfig('default_consumer_beta_features');
        if (Array.isArray(cfg)) return cfg;
        if (typeof cfg === 'string') { try { return JSON.parse(cfg); } catch (_) { return []; } }
    } catch (_) { /* none */ }
    return [];
}

// ── per-org availability (the super-admin "Organisation access" menu) ─────────
// Narrows the ceiling to the capabilities the org may use. Only matrix-visible,
// group-togglable caps are gated; infra / NC family / exempt apps / the MCP
// umbrella always pass through so the connector + always-on tools are never
// affected. `storedList === null` ⇒ no restriction (return the full ceiling),
// preserving prior behaviour for orgs that never set an access menu.
function buildOrgAvailable({ ceiling, storedList }) {
    const avail = cloneKindSets(ceiling);
    if (storedList == null) return avail;
    const allow = new Set(storedList);
    for (const kind of Object.keys(avail)) {
        for (const id of [...avail[kind]]) {
            if (registry.isNcCapability(id) || ORG_EXEMPT_APPS.has(id)) continue;
            const cap = registry.getCapability(id);
            // Org-built custom integrations ('custom:<uuid>') bypass the
            // super-admin access menu like NC/exempt: the menu cannot
            // enumerate org-local uuids, so without this bypass any org with
            // a storedList would silently lose its customs.
            if (cap && cap._custom) continue;
            const gated = cap && cap.userFacing && cap.groupTogglable;    // only matrix toggles are gated
            if (gated && !allow.has(id)) avail[kind].delete(id);
        }
    }
    return avail;
}

// ── grant layer ───────────────────────────────────────────────────────────
async function buildOrgGrant({ mode, orgId, ceiling }) {
    if (!orgId) {
        // consumer: everyone-grant = ceiling, but MCP servers are never auto-on
        // for consumers (they have no subscription to add them to).
        const cg = cloneKindSets(ceiling);
        cg.integration = new Set([...cg.integration].filter(id => !String(id).startsWith('mcp:')));
        return cg;
    }

    const g = emptyKindSets();

    // integration — org_enabled_integrations; NC family + exempt apps bypass the
    // org subset exactly as integrationTools does today. MCP servers (mcp:<id>)
    // flow through this same path now.
    let orgInt = new Set();
    try { orgInt = new Set(await userStore().getOrgEnabledIntegrations(orgId)); } catch (_) {}
    // Transition read-compat: surviving legacy MCP grants written before the
    // unification — mcp:<id> in the old org_granted_capabilities column, and
    // mcp:<id> historically stored in org.enabledIntegrations. Bounded by the
    // ceiling loop below, so anything no longer in the plan cap is NOT granted.
    // Remove once the one-time migration has run in production.
    try {
        const legacyGranted = await userStore().getOrgGrantedCapabilities(orgId);
        for (const id of legacyGranted) if (typeof id === 'string' && id.startsWith('mcp:')) orgInt.add(id);
    } catch (_) {}
    try {
        const org = await userStore().getOrganization(orgId);
        let raw = org?.enabledIntegrations;
        if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (_) { raw = null; } }
        if (Array.isArray(raw)) for (const id of raw) if (typeof id === 'string' && id.startsWith('mcp:')) orgInt.add(id);
    } catch (_) {}
    for (const id of ceiling.integration) {
        if (orgInt.has(id) || registry.isNcCapability(id) || ORG_EXEMPT_APPS.has(id)) g.integration.add(id);
    }

    // beta — the org-access menu (= `ceiling` here, already narrowed to orgAvailable)
    // is the org-wide switch in BOTH modes: every beta the org may use is granted to
    // all members. Cloud: the subscription's included betas lead. Self-hosted: Tom's
    // single-switch model — a menu-enabled beta (GA or not) is on for everyone, and
    // OFF in the menu ⇒ off for everyone. This replaces the old self-hosted
    // org_enabled_beta_features + GA-only gate (that column is now vestigial here).
    for (const id of ceiling.beta) g.beta.add(id);

    // core — cloud: org_granted_capabilities (the matrix "All members" column).
    // self-hosted: the org-access menu is the org-wide switch, so every togglable
    // core feature the org may use (= ceiling/orgAvailable here) is granted to all
    // members (single-switch model). Non-togglable core (infra: sso/compliance/
    // audit/…) is granted to everyone implicitly in BOTH modes — no per-group
    // surface, never org-narrowed.
    let orgGranted = new Set();
    try { orgGranted = new Set(await userStore().getOrgGrantedCapabilities(orgId)); } catch (_) {}
    for (const id of ceiling.core) {
        const cap = registry.getCapability(id);
        if (mode !== 'cloud' || orgGranted.has(id) || (cap && !cap.groupTogglable)) g.core.add(id);
    }

    return g;
}

function buildGroupGrant({ orgId, user, ceiling, allGroups }) {
    const g = emptyKindSets();
    const groupIds = parseGroupIds(user);
    if (!orgId || groupIds.length === 0) return g;
    const byId = new Map((allGroups || []).map(gr => [gr.id, gr]));
    for (const gid of groupIds) {
        const grp = byId.get(gid);
        if (!grp) continue;
        // Scope per resolving org (E6): a grant in a group belonging to another
        // org must not bleed into this org's resolution.
        if (grp.organizationId && grp.organizationId !== orgId) continue;
        const granted = Array.isArray(grp.granted_capabilities) ? grp.granted_capabilities : [];
        for (const capId of granted) {
            const cap = registry.getCapability(capId);
            if (!cap) continue;
            const set = ceiling[cap.kind];
            if (set && set.has(capId)) g[cap.kind].add(capId);
        }
    }
    return g;
}

function intersectIntoEffective({ orgGrant, groupGrant, ceiling }) {
    const eff = emptyKindSets();
    for (const kind of Object.keys(eff)) {
        for (const id of orgGrant[kind]) if (ceiling[kind].has(id)) eff[kind].add(id);
        for (const id of groupGrant[kind]) if (ceiling[kind].has(id)) eff[kind].add(id);
    }
    return eff;
}

function computeReasons({ ceiling, effective }) {
    const reasons = {};
    for (const cap of registry.listCapabilities()) {
        if (!cap.userFacing) continue;
        const inCeil = ceiling[cap.kind]?.has(cap.id);
        const inEff = effective[cap.kind]?.has(cap.id);
        if (inEff) continue;
        reasons[cap.id] = inCeil ? 'not_granted' : 'ceiling';
    }
    return reasons;
}

// ── public: resolveEntitlements ────────────────────────────────────────────
async function resolveEntitlements({ userId = null, orgId = null, session = null, req = null, tierHint = null } = {}) {
    // Request-path cache (mirrors license/middleware): memoised on the session
    // with a short TTL, versioned by the server-licence counter. Org/group grant
    // writes call bustSessionsForOrg (deletes the session) so the cache clears.
    const serverVer = license.getServerLicenseVersion ? license.getServerLicenseVersion() : 0;
    const cacheKey = `_ent:${userId}:o${orgId || ''}:v${serverVer}`;
    if (req && req.session && req.session[cacheKey] && req.session[cacheKey].expiresAt > Date.now()) {
        _metrics.recordCache('entitlements', true);
        return req.session[cacheKey].value;
    }
    if (req && req.session) _metrics.recordCache('entitlements', false);

    const mode = safeServerGoverns() ? 'self-hosted' : 'cloud';

    // Callers (/my-entitlements, requireCapability, /my-permissions) pass
    // orgId = session.user.organizationId, which is NULL for members whose session
    // holds only identity (e.g. OAuth login — role/org are resolved per-request, not
    // kept on the session). Without the real org a MEMBER falls through to the
    // consumer/no-org path = FULL ceiling, escaping the org access menu (org-admins +
    // normal members saw disabled features). Resolve their real org UP FRONT (before
    // the tier context) so the tier, ceiling, availability menu and grants all bind to
    // it. Super-admins keep the governingOrgId path below; genuine consumers (no org in
    // the DB) stay null.
    if (!orgId && !isSuperAdmin(session, null)) {
        try {
            const u = (session?.user?.id === userId && session.user.organizationId)
                ? session.user : await userStore().getUser(userId);
            orgId = u?.organizationId || null;
        } catch (_) { /* genuine consumer / lookup failure → stay null */ }
    }

    const tc = await resolveTierContext({ userId, orgId, session, req, tierHint });
    if (tc.degraded) {
        return { mode, tier: COMMUNITY, degraded: true, ceiling: kindSetsToArrays(emptyKindSets()), orgAvailable: kindSetsToArrays(emptyKindSets()), orgEnabled: kindSetsToArrays(emptyKindSets()), groupEffective: kindSetsToArrays(emptyKindSets()), effective: kindSetsToArrays(emptyKindSets()), reasons: {}, limits: {} };
    }

    const ceiling = await buildCeiling({ mode, tier: tc.tier, orgTier: tc.orgTier, orgId, orgIds: tc.orgIds, userId, superAdmin: tc.superAdmin });

    // Per-org access menu (super-admin controlled). Distribution (org/group
    // grants) is bounded by this, not the raw plan/license ceiling, so an
    // org-admin can only hand out what the org has been given access to.
    // null ⇒ no restriction (= full ceiling).
    //
    // governingOrgId: which org's access menu narrows THIS resolution. Normally the
    // user's own org. A super-admin with NO home org (a global platform admin,
    // organizationId=null) would otherwise escape every org menu — so bind them to
    // the org they're administering (the picker, session.adminSelectedOrgId) or, in
    // a single-tenant self-hosted install, the one org. The real `orgId` (possibly
    // null) still drives buildCeiling above, so the ceiling + MCP anti-leak are
    // unchanged — only the availability menu is governed here.
    let governingOrgId = orgId;
    if (!governingOrgId && tc.superAdmin) {
        governingOrgId = session?.adminSelectedOrgId || await singleOrgId();
    }
    let availStored = null;
    if (governingOrgId) { try { availStored = await userStore().getOrgAvailableCapabilities(governingOrgId); } catch (_) {} }
    const orgAvailable = buildOrgAvailable({ ceiling, storedList: availStored });

    let effectiveSets, orgGrant, groupGrant;
    if (tc.superAdmin) {
        // Super-admin: skip the org/group GRANT distribution layer (an admin needs
        // no per-group grant to use a feature). The per-org "Organisation access"
        // menu (orgAvailable) IS still honoured in SELF-HOSTED: there the platform
        // admin is also the org's operator, and the menu's promise — "everything
        // else is locked for them" — is meant to apply to everyone in the org,
        // admin included. They can never lock themselves out, since the admin
        // dashboard (incl. this menu) is role-gated, not capability-gated. In
        // CLOUD the super-admin is platform staff, not bound by a customer org's
        // menu, so they keep the full licence ceiling. buildOrgAvailable only
        // narrows userFacing+groupTogglable caps (infra/NC/exempt pass through),
        // and orgAvailable === ceiling when no menu is set, so unrestricted orgs
        // are unaffected. MCP ceiling is org-tier-derived above ⇒ no leak.
        const adminCeiling = (mode === 'self-hosted') ? orgAvailable : ceiling;
        orgGrant = cloneKindSets(adminCeiling);
        groupGrant = emptyKindSets();
        effectiveSets = cloneKindSets(adminCeiling);
    } else {
        // Grants + effective are clamped to the org's available menu.
        orgGrant = await buildOrgGrant({ mode, orgId, ceiling: orgAvailable });
        let allGroups = [];
        if (orgId) {
            try {
                const user = session?.user?.id === userId && Array.isArray(session.user.groups)
                    ? session.user : await userStore().getUser(userId);
                allGroups = await userStore().getAllGroups();
                groupGrant = buildGroupGrant({ orgId, user, ceiling: orgAvailable, allGroups });
            } catch (_) {
                groupGrant = emptyKindSets();
            }
        } else {
            groupGrant = emptyKindSets();
        }
        effectiveSets = intersectIntoEffective({ orgGrant, groupGrant, ceiling: orgAvailable });
    }

    const snapshot = {
        mode,
        tier: tc.tier,
        superAdmin: !!tc.superAdmin,
        degraded: false,
        ceiling: kindSetsToArrays(ceiling),
        orgAvailable: kindSetsToArrays(orgAvailable),
        orgEnabled: kindSetsToArrays(orgGrant),
        groupEffective: kindSetsToArrays(groupGrant),
        effective: kindSetsToArrays(effectiveSets),
        reasons: computeReasons({ ceiling, effective: effectiveSets }),
        limits: tiers.getLimitsForTier(tc.tier),
        // Set-backed lookup helpers (not serialised) for hot in-process callers.
        _sets: { ceiling, effective: effectiveSets },
    };

    if (req && req.session) {
        req.session[cacheKey] = { expiresAt: Date.now() + RESOLUTION_CACHE_TTL_MS, value: snapshot };
    }
    return snapshot;
}

function safeServerGoverns() {
    try { return !!(license.serverLicenseGovernsOrgs && license.serverLicenseGovernsOrgs()); }
    catch (_) { return false; }
}

/**
 * True iff the resolved snapshot grants `capId` to the user. Accepts a snapshot
 * (from resolveEntitlements) to avoid re-resolving in hot loops.
 */
function snapshotHas(snapshot, capId) {
    const cap = registry.getCapability(capId);
    if (!cap || !snapshot) return false;
    // Fast path: in-process Set-backed lookup. But a snapshot read back from the
    // session cache has round-tripped through the JSON session store, where Sets
    // serialise to `{}` (no `.has`); fall back to the arrayified form, which
    // serialises correctly.
    const set = snapshot._sets?.effective?.[cap.kind];
    if (set && typeof set.has === 'function') return set.has(capId);
    const arr = snapshot.effective?.[cap.kind];
    return Array.isArray(arr) && arr.includes(capId);
}

// Same Set-or-array fallback for a single kind bucket (handles cached snapshots
// whose `_sets` lost their Set-ness through session serialisation).
function snapshotBucketHas(bucketSets, arrayBuckets, kind, capId) {
    const set = bucketSets?.[kind];
    if (set && typeof set.has === 'function') return set.has(capId);
    const arr = arrayBuckets?.[kind];
    return Array.isArray(arr) && arr.includes(capId);
}

// ── public: requireCapability middleware ────────────────────────────────────
function requireCapability(capId) {
    const cap = registry.getCapability(capId);
    if (!cap) throw new Error(`requireCapability: unknown capability '${capId}'`);
    return async function capabilityGate(req, res, next) {
        if (!req.session?.isAuthenticated) return next(); // let auth middleware reject
        let snap;
        try {
            snap = await resolveEntitlements({
                userId: req.session.user?.id,
                orgId: req.session.user?.organizationId || req.session.user?.orgId || null,
                session: req.session,
                req,
            });
        } catch (e) {
            console.warn(`[entitlements] resolve_failed user=${req.session?.user?.id} cap=${capId} error=${e.message}`);
            res.set('Retry-After', '1');
            return res.status(503).json({ error: 'entitlement_unavailable', retry_after: 1 });
        }
        if (snap.degraded) {
            res.set('Retry-After', '1');
            return res.status(503).json({ error: 'entitlement_unavailable', retry_after: 1 });
        }
        if (snapshotHas(snap, capId)) return next();

        const inCeiling = snapshotBucketHas(snap._sets?.ceiling, snap.ceiling, cap.kind, capId);
        if (!inCeiling) {
            // Outside the plan/license ceiling → upgrade CTA. Keep the grep-able
            // telemetry line ops rely on. `required` makes this body a strict
            // superset of the legacy license-middleware feature_locked response
            // (so SPA call sites that read `required` keep working after the
            // requireFeature → requireCapability migration).
            const required = (cap.licenseFeature && middleware().findRequiredTierForFeature(cap.licenseFeature)) || 'enterprise';
            console.warn(`[entitlements] feature_locked user=${req.session?.user?.id} cap=${capId} kind=${cap.kind} tier=${snap.tier}`);
            return res.status(403).json({ error: 'feature_locked', feature: capId, required, current: snap.tier, upgrade_url: UPGRADE_URL });
        }
        // In ceiling but not granted → ask-your-admin CTA.
        console.warn(`[entitlements] feature_disabled user=${req.session?.user?.id} cap=${capId} kind=${cap.kind}`);
        return res.status(403).json({ error: 'feature_disabled', feature: capId });
    };
}

// ── public: programmatic capability check ───────────────────────────────────
// The non-middleware equivalent of requireCapability, for inline business-logic
// and background callers (automation/cron runners) that have no Express res to
// 403. THE single source of truth that requireBetaFeature/userHasBetaFeature/
// orgHasBetaFeature now delegate to — so the API gate, inline tool-selection,
// and background runners can never drift. Unlike the middleware factory it
// FAILS CLOSED on an unknown capId / degraded resolve (returns false) rather
// than throwing, because it runs in hot paths that must not crash a runner.
async function hasCapability(capId, { userId = null, orgId = null, session = null, req = null, tierHint = null } = {}) {
    const cap = registry.getCapability(capId);
    if (!cap) return false;
    let snap;
    try {
        snap = await resolveEntitlements({ userId, orgId, session, req, tierHint });
    } catch (_) {
        return false;
    }
    if (!snap || snap.degraded) return false;
    // Alias canonicalisation (mirrors betaFeatures.resolveFeatureAliases): a
    // deprecated alias id (e.g. email_knowledge_base) grants iff its canonical
    // target (itil_ticket_assistant) is effective. snapshotHas itself does not
    // expand aliases, so do it here.
    if (snapshotHas(snap, capId)) return true;
    if (cap.aliasOf && snapshotHas(snap, cap.aliasOf)) return true;
    return false;
}

// Batch helper for sites that test SEVERAL capabilities at once (tool-selection
// loops, e.g. skills/flow/swarm in one pass). One resolveEntitlements; `.has()`
// reuses the snapshot so callers don't re-resolve per capability.
async function resolveCapabilitySet({ userId = null, orgId = null, session = null, req = null, tierHint = null } = {}) {
    let snapshot;
    try {
        snapshot = await resolveEntitlements({ userId, orgId, session, req, tierHint });
    } catch (_) {
        snapshot = null;
    }
    const degraded = !snapshot || !!snapshot.degraded;
    return {
        degraded,
        snapshot,
        has(capId) {
            if (degraded) return false;
            const cap = registry.getCapability(capId);
            if (!cap) return false;
            if (snapshotHas(snapshot, capId)) return true;
            return !!(cap.aliasOf && snapshotHas(snapshot, cap.aliasOf));
        },
    };
}

// ── invalidation ────────────────────────────────────────────────────────────
// Authoritative bust is the Redis session bust (deletes sessions, which carry
// the per-request memo). Callers fire these after org/group grant writes.
async function invalidateForOrg(orgId) {
    try { await sessionCache().bustSessionsForOrg(orgId); } catch (e) { console.warn('[entitlements] bust org failed:', e.message); }
}
async function invalidateForUser(userId) {
    try { await sessionCache().bustSessionsForUser(userId); } catch (e) { console.warn('[entitlements] bust user failed:', e.message); }
}

module.exports = {
    resolveEntitlements,
    requireCapability,
    hasCapability,
    resolveCapabilitySet,
    snapshotHas,
    invalidateForOrg,
    invalidateForUser,
    registry,
    // test-only: clear the single-tenant detection cache between cases
    _resetSingleOrgCache: () => { _singleOrgCache = { value: null, expiresAt: 0 }; },
};
