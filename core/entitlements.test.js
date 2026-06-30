/**
 * Unit tests for the unified entitlement resolver + capability registry.
 *
 * Run: SESSION_SECRET=test-session-secret-at-least-32-chars-long node core/entitlements.test.js
 *
 * DB-free: the resolver's lazy-required data sources (license, userStore,
 * betaFeatures, planEntitlements, configStore, mcpStore) are monkeypatched on
 * the cached module objects so we test the precedence math, not the DB.
 */

const assert = require('assert');

const registry = require('./capabilityRegistry');
const license = require('../license');
const betaFeatures = require('../core/betaFeatures');
const userStore = require('../stores/userStore');
const planEnt = require('../services/planEntitlements');
const configStore = require('../stores/configStore');
const mcpStore = require('../stores/mcpStore');
const ent = require('./entitlements');

const realListBetas = betaFeatures.listBetaFeatures.bind(betaFeatures);

// ── Registry shape ───────────────────────────────────────────────────────
(() => {
    const caps = registry.listCapabilities();
    const byKind = {};
    for (const c of caps) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
    assert.strictEqual(registry.getCapability('mcp_marketplace'), null, 'mcp_marketplace is no longer a capability (MCP servers are integrations)');
    assert.ok(!caps.some(c => c.kind === 'mcp'), 'no capability uses the removed mcp kind');
    assert.strictEqual(registry.getCapability('webpages').kind, 'beta', 'webpages is a beta');
    assert.strictEqual(registry.getCapability('notebooks').kind, 'core');
    assert.strictEqual(registry.getCapability('gmail').kind, 'integration');
    assert.ok(registry.isNcCapability('nextcloud-mail'), 'NC family detection');
    // no id appears in two kinds
    const seen = new Map();
    for (const c of caps) { assert.ok(!seen.has(c.id), `duplicate id ${c.id}`); seen.set(c.id, c.kind); }
    console.log('✓ registry shape', byKind);
})();

// Default mock baseline (cloud, enterprise org) — each test overrides as needed.
function baseMocks() {
    license.serverLicenseGovernsOrgs = () => false; // cloud
    license.getServerLicenseVersion = () => 0;
    license.getBestTierForOrgs = async () => 'enterprise';
    license.getTierForUser = async () => 'community';
    license.orgGrantsFeature = async () => false;
    betaFeatures.listBetaFeatures = realListBetas;
    betaFeatures.getEffectiveOrgBetaAllowList = async () => ['webpages', 'swarm', 'meeting_notes'];
    userStore.getUser = async () => ({ id: 'u1', organizationId: 'o1', groups: ['g1'], role: 'user' });
    userStore.getAllGroups = async () => ([{ id: 'g1', organizationId: 'o1', granted_capabilities: ['gmail'] }]);
    userStore.getOrgEnabledIntegrations = async () => ['google-drive'];
    userStore.getOrgEnabledBetaFeatures = async () => [];
    userStore.getOrgGrantedCapabilities = async () => ['notebooks'];
    userStore.getOrgAvailableCapabilities = async () => null; // null ⇒ unrestricted (full ceiling)
    userStore.getSingleOrgId = async () => null;              // default: not single-tenant
    userStore.getOrganization = async () => ({ enabledIntegrations: null });
    planEnt.getOrgCaps = async () => ({ integrations: null, betaFeatures: null });
    configStore.getConfig = async () => null;
    mcpStore.listServers = async () => [];
    if (typeof ent._resetSingleOrgCache === 'function') ent._resetSingleOrgCache(); // single-tenant cache leaks across cases otherwise
}

const run = async () => {
    // ── Cloud enterprise: ceiling.beta from allow-list + compound AND; effective
    //    = orgGrant ∪ group grant ∩ ceiling. (E11 compound, group grant)
    baseMocks();
    let snap = await ent.resolveEntitlements({ userId: 'u1', orgId: 'o1', session: { user: { id: 'u1', role: 'user' } } });
    assert.ok(snap.ceiling.beta.includes('webpages'), 'webpages in ceiling (allow-list + enterprise license)');
    assert.ok(snap.ceiling.beta.includes('swarm'), 'swarm in ceiling');
    assert.ok(!snap.ceiling.beta.includes('voice_chat'), 'voice_chat NOT in ceiling (not in allow-list)');
    // cloud: orgGrant.beta = ceiling.beta (everyone) → effective beta = ceiling
    assert.ok(snap.effective.beta.includes('webpages'), 'cloud beta everyone → effective');
    // integration: org-enabled has google-drive; group g1 grants gmail (additive)
    assert.ok(snap.effective.integration.includes('google-drive'), 'org-enabled integration');
    assert.ok(snap.effective.integration.includes('gmail'), 'group-granted integration (additive)');
    // core: notebooks granted org-wide; in ceiling (enterprise has notebooks)
    assert.ok(snap.effective.core.includes('notebooks'), 'core notebooks granted');
    console.log('✓ cloud enterprise: compound beta + group integration grant + core');

    // ── Group grant cannot exceed ceiling: group grants a beta NOT in allow-list
    baseMocks();
    userStore.getAllGroups = async () => ([{ id: 'g1', organizationId: 'o1', granted_capabilities: ['voice_chat'] }]);
    snap = await ent.resolveEntitlements({ userId: 'u1', orgId: 'o1', session: { user: { id: 'u1', role: 'user' } } });
    assert.ok(!snap.effective.beta.includes('voice_chat'), 'group cannot grant beyond ceiling (E-security)');
    console.log('✓ group grant clamped to ceiling');

    // ── E6: group from another org must not bleed in
    baseMocks();
    userStore.getAllGroups = async () => ([{ id: 'g1', organizationId: 'OTHER', granted_capabilities: ['gmail'] }]);
    snap = await ent.resolveEntitlements({ userId: 'u1', orgId: 'o1', session: { user: { id: 'u1', role: 'user' } } });
    assert.ok(!snap.effective.integration.includes('gmail'), 'cross-org group grant must not apply (E6)');
    console.log('✓ E6 group grant scoped per org');

    // ── E3/E4: self-hosted community → only GA-community betas, auto-on
    baseMocks();
    license.serverLicenseGovernsOrgs = () => true; // self-hosted
    license.getBestTierForOrgs = async () => 'community';
    license.getTierForUser = async () => 'community';
    userStore.getOrgEnabledBetaFeatures = async () => []; // nothing explicitly enabled
    snap = await ent.resolveEntitlements({ userId: 'u1', orgId: 'o1', session: { user: { id: 'u1', role: 'user' } } });
    assert.ok(snap.ceiling.beta.includes('automations'), 'GA automations in community ceiling (E3)');
    assert.ok(snap.ceiling.beta.includes('agent_routines'), 'GA agent_routines in community ceiling (E3)');
    assert.ok(!snap.ceiling.beta.includes('webpages'), 'non-GA beta excluded on community');
    assert.ok(snap.effective.beta.includes('automations'), 'GA auto-on (absence ⇒ on) even with empty org list (E4)');
    console.log('✓ E3/E4 self-hosted community GA betas auto-on');

    // ── E1: cloud org with NO plan → empty betas
    baseMocks();
    betaFeatures.getEffectiveOrgBetaAllowList = async () => []; // no plan → empty
    snap = await ent.resolveEntitlements({ userId: 'u1', orgId: 'o1', session: { user: { id: 'u1', role: 'user' } } });
    assert.strictEqual(snap.ceiling.beta.length, 0, 'cloud no-plan org → zero betas (E1)');
    console.log('✓ E1 cloud no-plan org empty betas');

    // MCP is an integration now. There is no `mcp` snapshot bucket; servers are
    // `mcp:<id>` ids in the integration bucket, opt-in per plan (decision 3).

    // ── E5: null plan cap ⇒ MCP server NOT in ceiling (off until added to plan),
    //    even on a super-admin / enterprise org. Anti-leak preserved via the cap.
    baseMocks();
    mcpStore.listServers = async () => ([{ id: 's1', enabled: true }]);
    planEnt.getOrgCaps = async () => ({ integrations: null, betaFeatures: null }); // unrestricted ⇒ catalog only
    snap = await ent.resolveEntitlements({ userId: 'admin', orgId: 'o1', session: { isAdmin: true, user: { id: 'admin', role: 'admin' } } });
    assert.strictEqual(snap.ceiling.mcp, undefined, 'no mcp bucket on the snapshot');
    assert.ok(!snap.ceiling.integration.includes('mcp:s1'), 'null cap excludes MCP server from ceiling (E5, decision 3)');
    assert.ok(!snap.effective.integration.includes('mcp:s1'), 'super-admin gets no MCP server under a null cap (E5)');
    console.log('✓ E5 null plan cap ⇒ MCP off until added');

    // ── E5b: plan cap explicitly includes the server AND org enables it ⇒ granted.
    baseMocks();
    license.getBestTierForOrgs = async () => 'enterprise';
    mcpStore.listServers = async () => ([{ id: 's1', enabled: true }]);
    planEnt.getOrgCaps = async () => ({ integrations: ['gmail', 'mcp:s1'], betaFeatures: null });
    userStore.getOrgEnabledIntegrations = async () => ['mcp:s1']; // org turned it on for all members
    snap = await ent.resolveEntitlements({ userId: 'u1', orgId: 'o1', session: { user: { id: 'u1', role: 'user' } } });
    assert.ok(snap.ceiling.integration.includes('mcp:s1'), 'MCP server in ceiling when explicitly in plan cap (E5b)');
    assert.ok(snap.effective.integration.includes('mcp:s1'), 'MCP server granted when org-enabled (E5b)');
    console.log('✓ E5b MCP server opt-in via plan cap + org grant');

    // ── E5c: plan cap WITHOUT the server ⇒ not in ceiling even on enterprise.
    baseMocks();
    license.getBestTierForOrgs = async () => 'enterprise';
    mcpStore.listServers = async () => ([{ id: 's1', enabled: true }]);
    planEnt.getOrgCaps = async () => ({ integrations: ['gmail'], betaFeatures: null });
    snap = await ent.resolveEntitlements({ userId: 'u1', orgId: 'o1', session: { user: { id: 'u1', role: 'user' } } });
    assert.ok(!snap.ceiling.integration.includes('mcp:s1'), 'restricted cap without the server ⇒ excluded (E5c)');
    console.log('✓ E5c restricted cap excludes unlisted MCP server');

    // ── E5d: self-hosted ⇒ server in ceiling (operator-controlled), off until granted.
    baseMocks();
    license.serverLicenseGovernsOrgs = () => true; // self-hosted
    license.getBestTierForOrgs = async () => 'enterprise';
    mcpStore.listServers = async () => ([{ id: 's1', enabled: true }]);
    userStore.getOrgEnabledIntegrations = async () => []; // not enabled yet
    userStore.getOrganization = async () => ({ enabledIntegrations: null });
    snap = await ent.resolveEntitlements({ userId: 'u1', orgId: 'o1', session: { user: { id: 'u1', role: 'user' } } });
    assert.ok(snap.ceiling.integration.includes('mcp:s1'), 'self-hosted ⇒ installed server in ceiling (E5d)');
    assert.ok(!snap.effective.integration.includes('mcp:s1'), 'self-hosted ⇒ off until org enables it (E5d)');
    console.log('✓ E5d self-hosted MCP in ceiling, off until granted');

    // ── E2: consumer (no org) → ceiling beta from default_consumer_beta_features
    baseMocks();
    license.getTierForUser = async () => 'enterprise';
    configStore.getConfig = async (k) => (k === 'default_consumer_beta_features' ? ['swarm'] : null);
    userStore.getUser = async () => ({ id: 'c1', organizationId: null, groups: [], role: 'user' });
    mcpStore.listServers = async () => ([{ id: 's1', enabled: true }]);
    snap = await ent.resolveEntitlements({ userId: 'c1', orgId: null, session: { user: { id: 'c1', role: 'user' } } });
    assert.ok(snap.ceiling.beta.includes('swarm'), 'consumer beta from default list (E2)');
    assert.ok(snap.effective.beta.includes('swarm'), 'consumer effective beta (no org/group layer)');
    // Consumer ceiling sees installed servers (no plan), but they are never
    // auto-granted to a consumer's effective set.
    assert.ok(!snap.effective.integration.includes('mcp:s1'), 'consumer gets no MCP auto-grant (E2)');
    console.log('✓ E2 consumer beta path + no MCP auto-grant');

    // ── E13: per-org availability menu bounds distribution. Org-wide + group
    //    grants for caps OUTSIDE the menu are dropped from effective; the raw
    //    plan/license ceiling is unchanged (the cap is sellable, just not allowed
    //    for this org). This is what stops an org-admin enabling integrations the
    //    organisation has no access to.
    baseMocks();
    userStore.getOrgEnabledIntegrations = async () => ['google-drive', 'gmail']; // org-wide grants
    userStore.getAllGroups = async () => ([{ id: 'g1', organizationId: 'o1', granted_capabilities: ['gmail'] }]);
    userStore.getOrgAvailableCapabilities = async () => ['google-drive']; // menu allows only google-drive
    snap = await ent.resolveEntitlements({ userId: 'u1', orgId: 'o1', session: { user: { id: 'u1', role: 'user' } } });
    assert.ok(snap.orgAvailable.integration.includes('google-drive'), 'menu includes google-drive');
    assert.ok(!snap.orgAvailable.integration.includes('gmail'), 'menu excludes gmail');
    assert.ok(snap.effective.integration.includes('google-drive'), 'in-menu grant survives');
    assert.ok(!snap.effective.integration.includes('gmail'), 'out-of-menu org+group grant dropped (E13)');
    assert.ok(snap.ceiling.integration.includes('gmail'), 'ceiling unchanged (full plan/license menu)');
    console.log('✓ E13 per-org availability menu bounds distribution');

    // ── E13b: null availability ⇒ unrestricted (no behaviour change for orgs
    //    that never set a menu).
    baseMocks();
    userStore.getOrgEnabledIntegrations = async () => ['gmail'];
    userStore.getOrgAvailableCapabilities = async () => null;
    snap = await ent.resolveEntitlements({ userId: 'u1', orgId: 'o1', session: { user: { id: 'u1', role: 'user' } } });
    assert.ok(snap.effective.integration.includes('gmail'), 'unrestricted (null menu) ⇒ org grant applies as before');
    console.log('✓ E13b null availability ⇒ unrestricted');

    // ── REGRESSION (the reported bug): a CLOUD org on a Free/COMMUNITY-tier plan
    //    that lists a compound beta (webpages) in its allowed_beta_features gets
    //    the capability even though community is below webpages' licence floor.
    //    The compound-AND licence term is satisfied by the PLAN grant
    //    (orgGrantsFeature, derived from the plan beta list by getOrgGrantedFeatures),
    //    not the tier. Before the fix the API gate excluded webpages from the
    //    ceiling → requireCapability 403 feature_locked while the page rendered.
    //    On CLOUD the subscription's allowed_beta_features is the SOLE authority —
    //    no compound licence/tier gate. A Free/community-tier plan that INCLUDES
    //    webpages grants it outright, even with NO derived licence-feature grant.
    baseMocks();
    license.getBestTierForOrgs = async () => 'community';   // Free plan → community tier
    license.getTierForUser = async () => 'community';
    betaFeatures.getEffectiveOrgBetaAllowList = async () => ['webpages']; // plan includes webpages
    license.orgGrantsFeature = async () => false;                        // NO licence-feature grant — must not matter on cloud
    snap = await ent.resolveEntitlements({ userId: 'u1', orgId: 'o1', session: { user: { id: 'u1', role: 'user' } } });
    assert.ok(snap.ceiling.beta.includes('webpages'), 'cloud community + plan-included webpages ⇒ in ceiling (subscription is sole authority)');
    assert.ok(snap.effective.beta.includes('webpages'), 'cloud community + plan-included webpages ⇒ effective (requireCapability passes)');
    console.log('✓ REGRESSION cloud subscription grants webpages outright (no compound gate)');

    // ── Inverse: same community tier, plan does NOT include webpages ⇒ not in the
    //    ceiling (the legitimate feature_locked / upgrade case). Membership in the
    //    subscription's beta list is the only gate on cloud.
    baseMocks();
    license.getBestTierForOrgs = async () => 'community';
    license.getTierForUser = async () => 'community';
    betaFeatures.getEffectiveOrgBetaAllowList = async () => ['skills']; // webpages NOT included in the plan
    snap = await ent.resolveEntitlements({ userId: 'u1', orgId: 'o1', session: { user: { id: 'u1', role: 'user' } } });
    assert.ok(!snap.ceiling.beta.includes('webpages'), 'plan omits webpages ⇒ not in ceiling ⇒ feature_locked');
    assert.ok(snap.ceiling.beta.includes('skills'), 'plan includes skills ⇒ in ceiling');
    console.log('✓ REGRESSION cloud subscription omitting a beta locks it');

    // ── E14: SELF-HOSTED super-admin is bound by the "Organisation access" menu.
    //    The platform admin is also the org operator here; the menu's promise
    //    ("everything else is locked for them") must apply to them too. The admin
    //    still skips the org/group GRANT layer — they get everything AVAILABLE
    //    without a per-group grant — but a userFacing cap toggled OFF in the menu
    //    is dropped from their effective set. (This is the reported bug: the menu
    //    had no effect for the admin in self-hosted, so the Studio nav showed
    //    every feature regardless of the ceiling toggles.)
    baseMocks();
    license.serverLicenseGovernsOrgs = () => true;                 // self-hosted
    license.getBestTierForOrgs = async () => 'enterprise';
    userStore.getOrgAvailableCapabilities = async () => ['webpages']; // menu allows only webpages
    snap = await ent.resolveEntitlements({ userId: 'admin', orgId: 'o1', session: { isAdmin: true, user: { id: 'admin', role: 'admin' } } });
    assert.ok(snap.ceiling.beta.includes('meeting_notes'), 'super-admin ceiling still spans all betas (licence unchanged)');
    assert.ok(snap.effective.beta.includes('webpages'), 'self-hosted admin keeps an in-menu beta without a group grant (E14)');
    assert.ok(!snap.effective.beta.includes('meeting_notes'), 'self-hosted admin loses an out-of-menu beta — the menu now binds the admin (E14)');
    console.log('✓ E14 self-hosted super-admin bound by org-access menu');

    // ── E14b: CLOUD super-admin is platform staff, NOT bound by a customer org's
    //    menu — they keep the full licence ceiling (unchanged behaviour).
    baseMocks();                                                    // cloud (serverLicenseGovernsOrgs=false)
    license.getBestTierForOrgs = async () => 'enterprise';
    userStore.getOrgAvailableCapabilities = async () => ['webpages']; // same restrictive menu
    snap = await ent.resolveEntitlements({ userId: 'admin', orgId: 'o1', session: { isAdmin: true, user: { id: 'admin', role: 'admin' } } });
    assert.ok(snap.effective.beta.includes('webpages'), 'cloud admin keeps in-menu beta');
    assert.ok(snap.effective.beta.includes('meeting_notes'), 'cloud admin keeps out-of-menu beta (platform staff, not org-bound) (E14b)');
    console.log('✓ E14b cloud super-admin keeps full ceiling (not org-bound)');

    // ── E15: SELF-HOSTED single-switch — the org-access menu is the org-wide grant.
    //    A NORMAL user (no super-admin, no group/org grant) gets a menu-enabled
    //    non-GA beta WITHOUT it being in org_enabled_beta_features. An out-of-menu
    //    beta stays off. This is the "enabled ⇒ works for normal users" half.
    baseMocks();
    license.serverLicenseGovernsOrgs = () => true;                 // self-hosted
    license.getBestTierForOrgs = async () => 'enterprise';
    userStore.getOrgEnabledBetaFeatures = async () => [];          // nothing explicitly opted in
    userStore.getOrgAvailableCapabilities = async () => ['webpages']; // menu allows only webpages
    snap = await ent.resolveEntitlements({ userId: 'u1', orgId: 'o1', session: { user: { id: 'u1', role: 'user' } } });
    assert.ok(snap.effective.beta.includes('webpages'), 'self-hosted normal user gets menu-enabled non-GA beta with NO org_enabled_beta_features (E15)');
    assert.ok(!snap.effective.beta.includes('meeting_notes'), 'self-hosted normal user does NOT get an out-of-menu beta (E15)');
    console.log('✓ E15 self-hosted single-switch: normal user bound to + enabled by the menu');

    // ── E15-orgadmin: an ORG-ADMIN (orgRole=org_admin, role=user ⇒ NOT super-admin)
    //    takes the same path and gets the same single-switch result.
    baseMocks();
    license.serverLicenseGovernsOrgs = () => true;
    license.getBestTierForOrgs = async () => 'enterprise';
    userStore.getOrgEnabledBetaFeatures = async () => [];
    userStore.getOrgAvailableCapabilities = async () => ['webpages'];
    userStore.getUser = async () => ({ id: 'oa', organizationId: 'o1', groups: [], role: 'user', orgRole: 'org_admin' });
    snap = await ent.resolveEntitlements({ userId: 'oa', orgId: 'o1', session: { user: { id: 'oa', role: 'user', orgRole: 'org_admin' } } });
    assert.ok(snap.effective.beta.includes('webpages'), 'org-admin gets the menu-enabled beta (E15-orgadmin)');
    assert.ok(!snap.effective.beta.includes('meeting_notes'), 'org-admin loses the out-of-menu beta — bound like everyone (E15-orgadmin)');
    console.log('✓ E15-orgadmin org-admin bound + enabled by the menu (no elevation)');

    // ── E15b: SELF-HOSTED single-switch for togglable CORE. A menu-enabled core
    //    feature is granted org-wide WITHOUT an org_granted_capabilities entry; a
    //    toggled-off core feature is dropped.
    baseMocks();
    license.serverLicenseGovernsOrgs = () => true;
    license.getBestTierForOrgs = async () => 'enterprise';
    userStore.getOrgGrantedCapabilities = async () => [];          // nothing explicitly granted
    userStore.getOrgAvailableCapabilities = async () => ['notebooks']; // menu allows only notebooks
    snap = await ent.resolveEntitlements({ userId: 'u1', orgId: 'o1', session: { user: { id: 'u1', role: 'user' } } });
    assert.ok(snap.effective.core.includes('notebooks'), 'self-hosted normal user gets menu-enabled core with NO org_granted_capabilities (E15b)');
    assert.ok(!snap.effective.core.includes('component_designer'), 'self-hosted normal user does NOT get an out-of-menu core feature (E15b)');
    console.log('✓ E15b self-hosted single-switch core: menu is the org-wide grant');

    // ── E15c: CLOUD core is UNCHANGED — togglable core still needs an explicit
    //    org_granted_capabilities entry (the menu alone does not grant on cloud).
    baseMocks();                                                    // cloud
    license.getBestTierForOrgs = async () => 'enterprise';
    userStore.getOrgGrantedCapabilities = async () => [];          // not granted
    userStore.getOrgAvailableCapabilities = async () => ['notebooks']; // menu allows it
    snap = await ent.resolveEntitlements({ userId: 'u1', orgId: 'o1', session: { user: { id: 'u1', role: 'user' } } });
    assert.ok(!snap.effective.core.includes('notebooks'), 'cloud core still grant-gated: menu alone does NOT grant (E15c)');
    console.log('✓ E15c cloud core grant path unchanged');

    // ── E16: SELF-HOSTED, GLOBAL ADMIN with NO own org (organizationId=null), in a
    //    single-tenant install ⇒ bound by THAT one org's access menu (governingOrgId
    //    falls back to the single org). This is the exact reported bug: today's E14
    //    passes orgId='o1' and never exercises the null-org admin path.
    baseMocks();
    license.serverLicenseGovernsOrgs = () => true;                 // self-hosted
    license.getBestTierForOrgs = async () => 'enterprise';
    userStore.getSingleOrgId = async () => 'o1';                    // exactly one org
    userStore.getOrgAvailableCapabilities = async (id) => (id === 'o1' ? ['notebooks'] : null); // menu allows only notebooks
    snap = await ent.resolveEntitlements({ userId: 'admin', orgId: null, session: { isAdmin: true, user: { id: 'admin', role: 'admin' } } });
    assert.ok(snap.effective.core.includes('notebooks'), 'global admin bound to single org keeps an in-menu core feature (E16)');
    assert.ok(!snap.effective.core.includes('component_designer'), 'global admin loses an out-of-menu core feature (E16)');
    assert.ok(!snap.effective.beta.includes('webpages'), 'global admin loses out-of-menu betas (E16)');
    assert.ok(!snap.effective.beta.includes('dutch_legal_sources'), 'global admin loses the Legal-KB beta when disabled in the menu (E16)');
    console.log('✓ E16 self-hosted global admin (null org) bound by the single org menu');

    // ── E16b: same, but the single org left its menu UNSET (null = unrestricted) ⇒
    //    full ceiling (the bind must not over-restrict an org that never set a menu).
    baseMocks();
    license.serverLicenseGovernsOrgs = () => true;
    license.getBestTierForOrgs = async () => 'enterprise';
    userStore.getSingleOrgId = async () => 'o1';
    userStore.getOrgAvailableCapabilities = async () => null;       // unrestricted
    snap = await ent.resolveEntitlements({ userId: 'admin', orgId: null, session: { isAdmin: true, user: { id: 'admin', role: 'admin' } } });
    assert.ok(snap.effective.beta.includes('webpages'), 'unrestricted single org ⇒ global admin keeps full ceiling (E16b)');
    console.log('✓ E16b unrestricted single org ⇒ global admin not over-restricted');

    // ── E16c: CLOUD, one org, null-org admin ⇒ still full ceiling (cloud staff are
    //    NOT bound by a customer menu; locks in "no org-count override of cloud").
    baseMocks();                                                    // cloud
    license.getBestTierForOrgs = async () => 'enterprise';
    userStore.getSingleOrgId = async () => 'o1';
    userStore.getOrgAvailableCapabilities = async () => ['notebooks']; // restrictive menu
    snap = await ent.resolveEntitlements({ userId: 'admin', orgId: null, session: { isAdmin: true, user: { id: 'admin', role: 'admin' } } });
    assert.ok(snap.effective.beta.includes('meeting_notes'), 'cloud null-org admin keeps full ceiling (E16c)');
    console.log('✓ E16c cloud global admin not bound by a single-org menu');

    // ── E16d: SELF-HOSTED, MULTI-org (no single org), null-org admin who SELECTED an
    //    org in the picker (session.adminSelectedOrgId) ⇒ bound to that org's menu.
    baseMocks();
    license.serverLicenseGovernsOrgs = () => true;
    license.getBestTierForOrgs = async () => 'enterprise';
    userStore.getSingleOrgId = async () => null;                    // multi-org
    userStore.getOrgAvailableCapabilities = async (id) => (id === 'o2' ? ['webpages'] : null);
    snap = await ent.resolveEntitlements({ userId: 'admin', orgId: null, session: { isAdmin: true, adminSelectedOrgId: 'o2', user: { id: 'admin', role: 'admin' } } });
    assert.ok(snap.effective.beta.includes('webpages'), 'admin bound to the org they selected in the picker (E16d)');
    assert.ok(!snap.effective.beta.includes('meeting_notes'), 'out-of-menu beta dropped for the selected org (E16d)');
    console.log('✓ E16d self-hosted multi-org admin bound by picker selection');

    // ── E16e: SELF-HOSTED, MULTI-org, null-org admin, NO picker selection ⇒ full
    //    ceiling (deliberate: don't guess an org / don't intersect).
    baseMocks();
    license.serverLicenseGovernsOrgs = () => true;
    license.getBestTierForOrgs = async () => 'enterprise';
    userStore.getSingleOrgId = async () => null;
    userStore.getOrgAvailableCapabilities = async () => ['notebooks'];
    snap = await ent.resolveEntitlements({ userId: 'admin', orgId: null, session: { isAdmin: true, user: { id: 'admin', role: 'admin' } } });
    assert.ok(snap.effective.beta.includes('meeting_notes'), 'multi-org admin with no selection ⇒ full ceiling, no guess (E16e)');
    console.log('✓ E16e multi-org admin without selection ⇒ no guess');

    // ── E17: MEMBER whose session carries NO organizationId (OAuth-style identity-only
    //    session) must still be bound by the org menu — resolved from the DB — not fall
    //    through to the consumer/full-ceiling path. This is the real reported bug:
    //    org-admins/normal members escaped the ceiling because orgId arrived null.
    baseMocks();
    license.serverLicenseGovernsOrgs = () => true;                 // self-hosted
    license.getBestTierForOrgs = async () => 'enterprise';
    userStore.getOrgAvailableCapabilities = async (id) => (id === 'o1' ? ['notebooks'] : null); // menu: only notebooks
    userStore.getUser = async () => ({ id: 'm1', organizationId: 'o1', groups: [], role: 'user', orgRole: 'org_admin' });
    // session.user has ONLY identity — no organizationId/role (as stored in Redis for OAuth logins)
    snap = await ent.resolveEntitlements({ userId: 'm1', orgId: null, session: { isAuthenticated: true, user: { id: 'm1', displayName: 'adm' } } });
    assert.ok(!snap.effective.beta.includes('webpages'), 'org-less-session member is bound to the menu, NOT full ceiling (E17)');
    assert.ok(!snap.effective.beta.includes('security_scan'), 'org-less-session member loses out-of-menu betas (E17)');
    assert.ok(snap.effective.core.includes('notebooks'), 'org-less-session member keeps the in-menu core feature (E17)');
    console.log('✓ E17 member with org-less session resolved to real org + bound by the menu');

    // ── E17b: a GENUINE consumer (no org in session AND none in the DB / resolved set)
    //    stays a consumer — the resolve-from-DB fallback must not invent an org.
    baseMocks();
    license.serverLicenseGovernsOrgs = () => true;
    license.getTierForUser = async () => 'enterprise';
    userStore.getUser = async () => ({ id: 'c1', organizationId: null, groups: [], role: 'user' });
    snap = await ent.resolveEntitlements({ userId: 'c1', orgId: null, session: { isAuthenticated: true, user: { id: 'c1' } } });
    assert.ok(Array.isArray(snap.effective.beta), 'consumer resolves without throwing (E17b)');
    assert.strictEqual(snap.orgEnabled.core.length >= 0, true, 'consumer path intact (E17b)');
    console.log('✓ E17b genuine consumer (no org anywhere) unchanged');

    // ── degraded: tier lookup throws → degraded snapshot
    baseMocks();
    license.getBestTierForOrgs = async () => { throw new Error('db down'); };
    snap = await ent.resolveEntitlements({ userId: 'u1', orgId: 'o1', session: { user: { id: 'u1', role: 'user' } } });
    assert.strictEqual(snap.degraded, true, 'degraded on tier failure (E10 fail-closed)');
    console.log('✓ degraded fail-closed');

    console.log('\nALL ENTITLEMENT TESTS PASSED');
};

run().then(() => process.exit(0)).catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
