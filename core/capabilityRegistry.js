/**
 * Capability Registry — the single "what can exist" catalogue.
 *
 * A DERIVED, READ-ONLY FACADE over the four pre-existing registries. It does
 * NOT replace or mutate them — 40+ tool modules key on their exact IDs and the
 * license verifier reads tiers.js directly. This file projects all four into
 * ONE descriptor shape so the entitlement resolver (server/core/entitlements.js),
 * the admin Plan editor, and the org Access & Permissions matrix all read the
 * same list instead of three disjoint ones.
 *
 *   - core        ← server/license/featureMap.js gated mounts + tiers.js
 *   - beta        ← server/core/betaFeatures.js  BETA_FEATURES
 *   - integration ← the catalogue below (mirror of
 *                   agent-hub/src/config/integrationCatalog.js) ∪ NC catalogue
 *   - mcp         ← static `mcp_marketplace` umbrella + dynamic mcp:<id>
 *                   (enumerated at resolve time, not here)
 *
 * Descriptor shape (one shape, every kind):
 *   {
 *     id,             // canonical id, unique ACROSS kinds
 *     kind,           // 'core' | 'beta' | 'integration' | 'mcp'
 *     name, description,
 *     category,       // grouping label for the UI (integrations/betas)
 *     licenseFeature, // string|null — the tier feature this is gated by
 *                     //   (for beta: the compound AND term; for core: itself)
 *     lifecycle,      // 'stable'|'experimental'|'beta'|'ga'|'deprecated'
 *     defaultState,   // 'on'|'off' — GA betas + community integrations = 'on'
 *     userFacing,     // surfaced in the org Access & Permissions matrix
 *     groupTogglable, // org-admin may grant this per group
 *     aliasOf,        // deprecated beta aliases
 *     _ncFamily,      // nextcloud-* — keeps the existing orgActiveSet exemption
 *   }
 *
 * IDs are unique across kinds: each license-feature string is registered under
 * exactly ONE kind. Where a beta carries a `licenseFeature` (e.g. webpages),
 * the beta owns the id and the resolver ANDs the licenseFeature against the
 * tier directly — so the license term is never lost despite not being a
 * separate `core` row.
 */

const tiers = require('../license/tiers');
const featureMap = require('../license/featureMap');
const { NC_INTEGRATIONS, NC_INTEGRATION_ID_SET } = require('./ncIntegrationCatalog');

const CapabilityKind = Object.freeze({
    CORE: 'core',
    BETA: 'beta',
    INTEGRATION: 'integration',
});

// Lazy-require to break the betaFeatures ↔ license ↔ registry import cycle.
let _beta = null;
function betaModule() {
    if (!_beta) _beta = require('./betaFeatures');
    return _beta;
}

// Lazy-require mcpStore (DB layer) only when refreshing the dynamic MCP set.
let _mcpStore = null;
function mcpStore() {
    if (!_mcpStore) _mcpStore = require('../stores/mcpStore');
    return _mcpStore;
}

// Lazy-require the custom-integration store (DB layer) only when projecting
// an org's AI-built integrations — same pattern as mcpStore above.
let _customStore = null;
function customIntegrationStore() {
    if (!_customStore) _customStore = require('../stores/orgCustomIntegrationStore');
    return _customStore;
}

// ── Integration catalogue ───────────────────────────────────────────────
// MUST stay in sync with agent-hub/src/config/integrationCatalog.js and the
// runtime gates in server/core/integrationTools.js. Non-NC entries here; the
// NC family is appended from ncIntegrationCatalog.js so there is one source.
const INTEGRATION_CATALOG = [
    { id: 'gmail',            name: 'Gmail',                 description: 'Send and read emails',                       category: 'Google Workspace' },
    { id: 'google-calendar',  name: 'Calendar',              description: 'Manage calendar events',                     category: 'Google Workspace' },
    { id: 'google-drive',     name: 'Drive',                 description: 'Access and manage files',                     category: 'Google Workspace' },
    { id: 'google-slides',    name: 'Slides',                description: 'Create presentations',                        category: 'Google Workspace' },
    { id: 'google-sheets',    name: 'Sheets',                description: 'Work with spreadsheets',                      category: 'Google Workspace' },
    { id: 'google-docs',      name: 'Docs',                  description: 'Create and edit documents',                  category: 'Google Workspace' },
    { id: 'google-contacts',  name: 'Contacts',              description: 'Search, create & update contacts',           category: 'Google Workspace' },
    { id: 'google-keep',      name: 'Keep',                  description: 'List, create & delete notes',                category: 'Google Workspace' },
    { id: 'google-groups',    name: 'Google Groups',         description: 'List and manage Google Workspace groups',    category: 'Google Workspace' },
    { id: 'maps',             name: 'Google Maps',           description: 'Places search, directions, geocoding',       category: 'Google Workspace' },
    { id: 'outlook',          name: 'Outlook',               description: 'Send and read emails',                       category: 'Microsoft 365' },
    { id: 'outlook-readonly', name: 'Outlook (Read-Only)',   description: 'Search and read emails only',                category: 'Microsoft 365' },
    { id: 'ms-calendar',      name: 'Calendar',              description: 'Manage calendar events',                     category: 'Microsoft 365' },
    { id: 'onedrive',         name: 'OneDrive',              description: 'Access and manage files',                     category: 'Microsoft 365' },
    { id: 'ms-contacts',      name: 'Contacts',              description: 'Search, create & update contacts',           category: 'Microsoft 365' },
    { id: 'image-gen',        name: 'Image Generation',      description: 'Generate images with AI',                    category: 'AI & Media' },
    { id: 'music-gen',        name: 'Music Generation',      description: 'Generate music with AI (ElevenLabs)',        category: 'AI & Media' },
    { id: 'video-gen',        name: 'Video Generation',      description: 'Generate short videos with AI (Veo)',        category: 'AI & Media' },
    { id: 'elevenlabs',       name: 'ElevenLabs',            description: 'Music with vocals, TTS & sound effects',     category: 'AI & Media' },
    { id: 'agent-search',     name: 'Agent Search',          description: 'AI-powered web search with reranking',       category: 'AI & Media' },
    { id: 'transcription',    name: 'Meeting Transcription',  description: 'Transcribe audio with speaker diarization',  category: 'AI & Media' },
    { id: 'kb-search',        name: 'Knowledge Base',        description: 'Search org knowledge bases',                 category: 'AI & Media' },
    { id: 'fireflies',        name: 'Fireflies',             description: 'Meeting transcripts',                        category: 'Productivity' },
    { id: 'gamma',            name: 'Gamma',                 description: 'Create presentations',                        category: 'Productivity' },
    { id: 'signrequest',      name: 'SignRequest',           description: 'E-signature requests',                       category: 'Productivity' },
    { id: 'afas-profit',      name: 'AFAS Profit',           description: 'Query AFAS Profit GetConnectors (read-only)', category: 'Productivity' },
    { id: 'nmbrs',            name: 'NMBRS',                 description: 'Read NMBRS payroll & HR data (read-only)',    category: 'Productivity' },
    { id: 'youtrack',         name: 'YouTrack',              description: 'Issue tracking',                             category: 'Developer' },
    { id: 'github',           name: 'GitHub',                description: 'Repository management, view code',           category: 'Developer' },
    { id: 'n8n',              name: 'n8n',                   description: 'Workflow automation',                        category: 'Automation' },
    { id: 'webpages',         name: 'Webpages',              description: 'Run user-authored webpage automations',      category: 'Automation' },
    { id: 'linkedin',         name: 'LinkedIn',              description: 'Post to LinkedIn',                           category: 'Social' },
];

// Integrations that are on-by-default at the user level (mirror of
// integrationTools.AUTO_ENABLED_APPS, intersected with this catalogue). These
// get defaultState:'on'; the rest require an explicit OAuth/credential anyway.
const AUTO_ON_INTEGRATIONS = new Set([
    'agent-search', 'image-gen', 'music-gen', 'video-gen', 'elevenlabs', 'maps',
    'linkedin', 'github', 'google-contacts', 'google-keep', 'outlook',
    'outlook-readonly', 'ms-calendar', 'onedrive', 'ms-contacts', 'google-groups',
    'n8n', 'webpages',
]);

// MCP servers are NOT a separate kind. Each installed MCP server is projected
// as a dynamic INTEGRATION capability (`mcp:<id>`) — see _mcpDynamic below and
// refreshMcpIntegrationDescriptors(). `mcp_marketplace` stays a pure license
// string (tiers.js / betaFeatures.js) that gates ONLY the super-admin install
// Marketplace surface; it is deliberately NOT a capability row here.
const MCP_SERVER_CATEGORY = 'MCP servers';

// Pure-core capabilities that are user-facing toggles (have plan chips and/or
// per-deployment kill switches). Other tier features (sso_saml, compliance_*,
// guardrails_dlp, audit_log_export, pii_tokenize, web_search_guard,
// automation_sharing, white_label, …) are infra/admin and are NOT surfaced in
// the per-group matrix — they remain pure ceiling gates.
const USER_FACING_CORE = new Set(['notebooks', 'projects', 'component_designer']);

let _cache = null;

// ── Dynamic MCP-as-integration projection ───────────────────────────────
// Installed MCP servers live in the DB, so they can't be part of the sync,
// cached static registry. We keep them in a process-global cache that async
// entry points (entitlements resolver, the admin matrix/availability builders)
// refresh BEFORE they read the registry. listCapabilities()/getCapability()
// stay synchronous; sync-only callers simply don't see MCP servers (harmless —
// they don't care about per-server integrations).
let _mcpDynamic = [];        // integration descriptors for installed servers
let _mcpById = new Map();    // id → descriptor

function setMcpIntegrationDescriptors(list) {
    _mcpDynamic = Array.isArray(list) ? list : [];
    _mcpById = new Map(_mcpDynamic.map(c => [c.id, c]));
}

/** Re-read mcpStore and project enabled servers as integration capabilities. */
async function refreshMcpIntegrationDescriptors() {
    try {
        const servers = await mcpStore().listServers();
        setMcpIntegrationDescriptors((servers || [])
            .filter(s => s && s.enabled !== false)
            .map(s => ({
                id: `mcp:${s.id}`,
                kind: CapabilityKind.INTEGRATION,
                name: s.name || s.id,
                description: s.description || '',
                category: MCP_SERVER_CATEGORY,
                licenseFeature: null,
                lifecycle: 'stable',
                defaultState: 'off',
                userFacing: true,
                groupTogglable: true,
                _mcpServer: true,
            })));
    } catch (_) {
        // mcpStore unavailable — keep whatever was last cached (or empty).
    }
}

// ── Org-scoped custom-integration projection (AI Integration Builder) ───
// Active org_custom_integrations rows projected as 'custom:<uuid>' integration
// capabilities. CRITICAL DESIGN RULE: these per-org descriptors must NEVER
// enter listCapabilities()/listByKind() — that is a GLOBAL enumeration, and
// surfacing org-local names/ids there would leak them across orgs (the admin
// matrix, /auth/my-permissions registry dump, etc. all read it). Access goes
// ONLY through the org-scoped accessor below, or by exact id via
// getCapability() (safe: a uuid is unguessable and never enumerated).
const CUSTOM_INTEGRATION_CATEGORY = 'Custom integrations';
const CUSTOM_INTEGRATION_TTL_MS = 15_000;
const _customByOrg = new Map();  // orgKey → { at, list } (TTL-cached per org)
const _customById = new Map();   // capId → descriptor, across orgs — safe:
                                 // reachable only by exact uuid, never listed.

// Normalize the org key through the store's own resolveOrgId (the
// '__default_org__' sentinel funnel) so cache keys agree with the rows.
function customOrgKey(orgId) {
    try { return customIntegrationStore().resolveOrgId(orgId); }
    catch (_) { return (orgId && String(orgId).trim()) || '__default_org__'; }
}

/**
 * Descriptor array for THIS org's ACTIVE custom integrations — and only this
 * org's. 15s TTL per org; on store failure the last cached list (or []) is
 * returned so a flaky DB never widens or crashes an entitlement resolve.
 */
async function listCustomIntegrationCapabilities(orgId) {
    const orgKey = customOrgKey(orgId);
    const cached = _customByOrg.get(orgKey);
    if (cached && (Date.now() - cached.at) < CUSTOM_INTEGRATION_TTL_MS) return cached.list;
    try {
        const rows = await customIntegrationStore().listActiveForOrg(orgKey);
        const list = (rows || []).map(row => ({
            id: `custom:${row.id}`,
            kind: CapabilityKind.INTEGRATION,
            name: row.name,
            description: row.description || '',
            category: CUSTOM_INTEGRATION_CATEGORY,
            licenseFeature: null,
            lifecycle: 'stable',
            defaultState: 'off',
            userFacing: true,
            groupTogglable: true,
            _custom: true,
            _customOrgId: row.orgId,
            _customSlug: row.slug,
            _customKind: row.kind,
        }));
        _customByOrg.set(orgKey, { at: Date.now(), list });
        for (const c of list) _customById.set(c.id, c);
        return list;
    } catch (_) {
        // Store unavailable — keep serving whatever was last cached.
        return cached ? cached.list : [];
    }
}

/** Drop one org's TTL entry (e.g. after activate/deactivate) or all of them. */
function invalidateCustomIntegrationCache(orgId = null) {
    if (orgId == null) { _customByOrg.clear(); return; }
    _customByOrg.delete(customOrgKey(orgId));
}

function build() {
    if (_cache) return _cache;

    const byId = new Map();
    const list = [];
    const add = (cap) => {
        if (byId.has(cap.id)) return; // first kind to claim an id wins
        byId.set(cap.id, cap);
        list.push(cap);
    };

    // ── BETA ───────────────────────────────────────────────────────────
    // Betas own their id outright (so webpages/meeting_notes/etc. are beta
    // rows, not core rows). The resolver ANDs `licenseFeature` against tier.
    const betaIds = new Set();
    const betaLicenseFeatures = new Set();
    for (const f of betaModule().listBetaFeatures()) {
        // mcp_marketplace is modelled as its own MCP kind (it has distinct
        // tier-only ceiling math), not as a beta row — skip it here so the
        // MCP umbrella below claims the id.
        if (f.id === 'mcp_marketplace') continue;
        betaIds.add(f.id);
        if (f.licenseFeature) betaLicenseFeatures.add(f.licenseFeature);
        add({
            id: f.id,
            kind: CapabilityKind.BETA,
            name: f.name,
            description: f.description,
            category: 'Beta',
            licenseFeature: f.licenseFeature || null,
            lifecycle: f.lifecycle || 'beta',
            defaultState: f.lifecycle === 'ga' ? 'on' : 'off',
            userFacing: !f.deprecated && f.lifecycle !== 'experimental',
            groupTogglable: !f.deprecated,
            aliasOf: f.aliasOf || null,
            deprecated: !!f.deprecated,
        });
    }

    // ── CORE ───────────────────────────────────────────────────────────
    // Route-gated license features from featureMap, plus every tier feature,
    // EXCLUDING any string already owned by a beta id / beta licenseFeature /
    // the mcp umbrella, so no capability is double-listed.
    const claimedElsewhere = new Set([...betaIds, ...betaLicenseFeatures, 'mcp_marketplace']);

    const coreFeatureNames = new Set();
    for (const entry of Object.values(featureMap)) {
        if (entry && entry.gate) coreFeatureNames.add(entry.gate);
    }
    for (const tier of tiers.TIER_HIERARCHY) {
        for (const f of (tiers.TIER_FEATURES[tier] || [])) coreFeatureNames.add(f);
    }

    for (const f of coreFeatureNames) {
        if (claimedElsewhere.has(f)) continue;
        add({
            id: f,
            kind: CapabilityKind.CORE,
            name: prettyName(f),
            description: '',
            category: 'Core',
            licenseFeature: f,
            lifecycle: 'stable',
            defaultState: 'on',
            userFacing: USER_FACING_CORE.has(f),
            groupTogglable: USER_FACING_CORE.has(f),
        });
    }

    // ── INTEGRATION ────────────────────────────────────────────────────
    for (const i of INTEGRATION_CATALOG) {
        add({
            id: i.id,
            kind: CapabilityKind.INTEGRATION,
            name: i.name,
            description: i.description,
            category: i.category,
            licenseFeature: null,
            lifecycle: 'stable',
            defaultState: AUTO_ON_INTEGRATIONS.has(i.id) ? 'on' : 'off',
            userFacing: true,
            groupTogglable: true,
        });
    }
    for (const i of NC_INTEGRATIONS) {
        add({
            id: i.id,
            kind: CapabilityKind.INTEGRATION,
            name: i.name,
            description: i.description,
            category: 'Nextcloud',
            licenseFeature: null,
            lifecycle: 'stable',
            defaultState: 'on',
            // NC stays managed by its dedicated Nextcloud panel + the transitional
            // per-group opt-out — NOT the generic Access matrix. The resolver still
            // grants NC to everyone via its isNcCapability() bypass (independent of
            // these flags), so agents keep their NC tools.
            userFacing: false,
            groupTogglable: false,
            _ncFamily: true,
        });
    }

    _cache = { list, byId };
    return _cache;
}

function prettyName(id) {
    return String(id)
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
}

function listCapabilities() {
    // Static registry + dynamically-projected MCP server integrations.
    return build().list.concat(_mcpDynamic);
}

function listByKind(kind) {
    return listCapabilities().filter(c => c.kind === kind);
}

function getCapability(id) {
    const hit = build().byId.get(id) || _mcpById.get(id) || _customById.get(id);
    if (hit) return hit;
    if (String(id).startsWith('custom:')) {
        // Synthetic minimal descriptor for a custom integration this process
        // hasn't projected yet. It keeps hasCapability('custom:<uuid>')
        // RESOLVABLE before any ceiling build has warmed _customById (e.g. a
        // background runner racing a fresh boot) — getCapability returning
        // null would fail the check before the resolver even ran. This is
        // SAFE, not a grant: the entitlement grant still requires ceiling
        // membership, and the ceiling only ever admits customs through the
        // org-scoped listCustomIntegrationCapabilities() accessor — so an id
        // from another org resolves here but is never granted. userFacing is
        // false so the synthetic row can't surface in any matrix/UI listing.
        return {
            id,
            kind: CapabilityKind.INTEGRATION,
            name: 'Custom integration',
            description: '',
            category: CUSTOM_INTEGRATION_CATEGORY,
            licenseFeature: null,
            lifecycle: 'stable',
            defaultState: 'off',
            userFacing: false,
            groupTogglable: true,
            _custom: true,
            _customOrgId: null,
        };
    }
    return null;
}

/** True when `id` is the nextcloud-* family (special group/exempt semantics). */
function isNcCapability(id) {
    return NC_INTEGRATION_ID_SET.has(id);
}

/** Reverse index: license feature → the capability that carries it (if any). */
function capabilityForLicenseFeature(feature) {
    return build().list.find(c => c.licenseFeature === feature) || null;
}

module.exports = {
    CapabilityKind,
    listCapabilities,
    listByKind,
    getCapability,
    isNcCapability,
    capabilityForLicenseFeature,
    refreshMcpIntegrationDescriptors,
    setMcpIntegrationDescriptors,
    listCustomIntegrationCapabilities,
    invalidateCustomIntegrationCache,
    MCP_SERVER_CATEGORY,
    CUSTOM_INTEGRATION_CATEGORY,
    INTEGRATION_CATALOG,
    AUTO_ON_INTEGRATIONS,
};
