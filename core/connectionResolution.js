/**
 * Connection Resolution — the per-tool chokepoint that decides whether a tool
 * call should run under a LENT connection (full delegation) instead of the
 * running user's own credentials.
 *
 * It maps a tool name → integration provider (via integrationToolMap), asks
 * integrationConnectionStore.resolveConnectionForRun, and — only when a lend
 * grant applies — returns an "effective identity" the dispatcher projects onto
 * the existing `userAuth.integrationUserId` / `integrationOrgId` mechanism.
 *
 * GATED: lending is inert unless INTEGRATION_CONNECTION_LENDING_ENABLED is
 * truthy. With the flag off, resolveEffectiveIdentity() returns null without
 * touching the DB, so dispatch behavior is byte-for-byte unchanged (pure
 * bring-your-own, exactly as today). This lets the wiring land safely and be
 * enabled only after a security review + local-stack verification.
 */

const { resolveIntegration } = require('./integrationToolMap');

// Tool-family integration names that map onto a single OAuth routine provider.
// (resolveIntegration returns 'gmail'/'google_calendar'/… but the connection
// provider for those is 'google'.)
const INTEGRATION_TO_PROVIDER = {
    gmail: 'google', google_calendar: 'google', google_drive: 'google',
    google_docs: 'google', google_contacts: 'google', google_keep: 'google',
    google_groups: 'google', maps: 'google',
    outlook: 'microsoft', ms_calendar: 'microsoft', ms_contacts: 'microsoft', onedrive: 'microsoft',
};

function isLendingEnabled() {
    const v = process.env.INTEGRATION_CONNECTION_LENDING_ENABLED;
    return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Map a tool name to the connection provider it draws credentials from, or null
 * for internal/non-integration tools.
 */
function providerForTool(toolName) {
    const meta = resolveIntegration(toolName);
    if (!meta || !meta.integration) return null;
    return INTEGRATION_TO_PROVIDER[meta.integration] || meta.integration;
}

/**
 * Decide the effective integration identity for a single tool call.
 *
 * Returns null when lending is disabled, the tool isn't an integration tool,
 * an explicit acting identity is already set (Support inbox), or the resolver
 * says the running user should use their OWN connection / bring their own. In
 * all those cases the caller keeps its existing identity → no behavior change.
 *
 * Returns { integrationUserId, integrationOrgId, connectionId, grantId,
 * provider, connectionLabel } only when a LEND grant applies.
 */
async function resolveEffectiveIdentity({
    toolName, runningUserId, runningUserOrgId, runningUserGroups = [],
    ownerUserId = null, resourceType = null, resourceId = null,
    alreadyActingAs = null,
}) {
    if (!isLendingEnabled()) return null;
    // Never override an explicit acting identity (e.g. Support operator).
    if (alreadyActingAs) return null;
    const provider = providerForTool(toolName);
    if (!provider) return null;
    // A run on one's own resource never needs to borrow from oneself.
    if (ownerUserId && ownerUserId === runningUserId) return null;

    try {
        const store = require('../stores/integrationConnectionStore');
        const r = await store.resolveConnectionForRun({
            runningUserId, runningUserOrgId, runningUserGroups,
            ownerUserId, provider, resourceType, resourceId,
        });
        if (r && r.mode === 'delegated') {
            return {
                integrationUserId: r.effectiveUserId,
                integrationOrgId: r.effectiveOrgId,
                connectionId: r.connectionId,
                connectionLabel: r.connectionLabel,
                grantId: r.grantId,
                provider,
            };
        }
    } catch (err) {
        console.warn('[connectionResolution] resolve failed, falling back to BYO:', err.message);
    }
    return null;
}

/**
 * Best-effort fetch of the running user's org + group ids (resolver inputs).
 * Returns { orgId, groups }. Cheap to memoize on the run's userAuth.
 */
async function runningUserContext(userId) {
    try {
        const userStore = require('../stores/userStore');
        const u = await userStore.getUser(userId);
        return {
            orgId: u?.organizationId || null,
            groups: Array.isArray(u?.groups) ? u.groups : [],
        };
    } catch (_) {
        return { orgId: null, groups: [] };
    }
}

module.exports = {
    isLendingEnabled,
    providerForTool,
    resolveEffectiveIdentity,
    runningUserContext,
    _internals: { INTEGRATION_TO_PROVIDER },
};
