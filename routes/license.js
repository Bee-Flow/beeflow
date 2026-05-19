/**
 * License API Routes
 *
 *   GET    /api/license/status                     — current tier + active license
 *   POST   /api/license/activate                   — submit a license JWT to activate
 *   POST   /api/license/refresh                    — force a refresh-ping (admin)
 *   DELETE /api/license/deactivate                 — remove the current license (admin)
 *
 * Status is readable by any authenticated user (UI needs to know tier to gate
 * features). Mutations require admin or `admin_subscriptions` permission for
 * organization-scoped licenses; consumer-scoped activations only require the
 * user themselves.
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');

const license = require('../license');
const { hasPermission, resolveUserOrgIds, OrgRoles, SystemRoles, Permissions, isOrgAdminRole } = require('../auth/permissions');

// Self-host detection — server-wide licence activation is gated to
// self-hosted installs by default so a staff super-admin on cloud
// cannot accidentally re-tier every tenant in one click.
// LICENSE_ALLOW_SERVER_SCOPE_ON_CLOUD=true is an escape hatch (off by
// default) for the edge case where Bee Flow runs as a single-tenant
// managed-cloud deployment.
function isServerScopeAllowed() {
    if (process.env.LICENSE_ALLOW_SERVER_SCOPE_ON_CLOUD === 'true') return true;
    return (process.env.DEPLOYMENT_MODE || 'cloud') === 'self-hosted';
}

function isSuperAdmin(req) {
    return !!(req.session?.isAdmin || req.session?.user?.role === SystemRoles.SUPER_ADMIN);
}

// Rate-limit license status and activation. /status is polled by the UI on
// every page load; activation is a low-frequency operation but a useful
// target for enumeration of valid license_ids. 30/min/IP is generous for
// a normal SPA and tight for abuse.
const licenseLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: parseInt(process.env.LICENSE_API_RATE_PER_MIN || '30', 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many license requests' },
});

function getSessionUser(req) {
    return req.session?.user || null;
}

function getOrgId(req) {
    const u = getSessionUser(req);
    if (!u) return null;
    return u.organizationId || u.orgId || null;
}

function getUserId(req) {
    return getSessionUser(req)?.id || null;
}

async function isOrgAdmin(req) {
    if (req.session?.isAdmin || req.session?.user?.role === SystemRoles.SUPER_ADMIN) return true;
    const userId = getUserId(req);
    if (!userId) return false;
    if (isOrgAdminRole(req.session?.user?.orgRole)) return true;
    try {
        return await hasPermission(userId, Permissions.ADMIN_SUBSCRIPTIONS, req.session);
    } catch (_) { return false; }
}

// Router-level guard. Every endpoint requires authentication; individual
// endpoints assert their own additional access policy (isOrgAdmin for org
// scope, self-only for consumer scope) — we deliberately do NOT hoist
// isOrgAdmin to the router because POST /activate and DELETE /deactivate
// have different rules for the consumer-scope path (a consumer can self-
// activate but a non-admin org user cannot activate an org license).
//
// IMPORTANT for reviewers: when adding a new endpoint here, explicitly
// assert your access policy (isOrgAdmin, or scope-based equivalent) at
// the start of the handler. Document the gate in server/license/featureMap.js.
router.use((req, res, next) => {
    if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
    next();
});

// ── GET /status ─────────────────────────────────────────────────────────
router.get('/status', licenseLimiter, async (req, res) => {
    try {
        const orgId = getOrgId(req);
        const userId = getUserId(req);
        // Resolve every org the caller belongs to (direct organizationId +
        // group-based memberships). Status now reports the highest-tier
        // licence across all of them, so a member invited via a group sees
        // the same plan as the org admin.
        let orgIds = null;
        try {
            const resolved = await resolveUserOrgIds(req);
            if (resolved instanceof Set) orgIds = [...resolved];
        } catch (_) { /* ignore — fall back to direct org only */ }
        const status = await license.getLicenseStatus({ organizationId: orgId, userId, orgIds });
        res.json(status);
    } catch (e) {
        console.error('[License] status error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ── POST /activate ──────────────────────────────────────────────────────
// body: { token: '<jwt>', scope?: 'organization' | 'consumer' | 'server' }
//
// scope='server' applies the licence install-wide. It requires:
//   - super-admin caller (session.isAdmin or role='admin')
//   - DEPLOYMENT_MODE=self-hosted (or LICENSE_ALLOW_SERVER_SCOPE_ON_CLOUD=true)
//   - tier ≥ enterprise — a community-tier server licence is meaningless
//     (community is the default floor for every install). We refuse it
//     up-front rather than persist a row that does nothing.
router.post('/activate', licenseLimiter, async (req, res) => {
    try {
        const { token, scope } = req.body || {};
        if (!token || typeof token !== 'string') {
            return res.status(400).json({ error: 'token required' });
        }
        const orgId = getOrgId(req);
        const userId = getUserId(req);

        // Server-scope branch. Gated by self-host + super-admin checks; the
        // tier-floor check happens after activation by inspecting the
        // returned shape (we let activateLicense parse the token first
        // because that's where verification lives).
        if (scope === 'server') {
            if (!isServerScopeAllowed()) {
                return res.status(403).json({
                    error: 'server_scope_cloud_blocked',
                    message: 'Server-wide licences are only supported on self-hosted deployments.',
                });
            }
            if (!isSuperAdmin(req)) {
                return res.status(403).json({
                    error: 'super_admin_required',
                    message: 'Only super-admins can apply a server-wide licence.',
                });
            }
            const activated = await license.activateLicense({
                token,
                organizationId: null,
                userId: null,
                scope: 'server',
                activatedBy: userId,
            });
            // R2 from the plan: refuse community-tier server licences —
            // they're indistinguishable from "no licence" and just confuse
            // operators. Roll back the row we just inserted.
            if (license.tiers.normalizeTier(activated.tier) === license.COMMUNITY_FALLBACK) {
                await license.deactivateLicenseForScope({ scope: 'server', deactivatedBy: userId });
                return res.status(400).json({
                    error: 'community_server_license_pointless',
                    message: 'A community-tier server licence has no effect (community is the default floor).',
                });
            }
            const status = await license.getLicenseStatus({ organizationId: orgId, userId });
            return res.json({ activated, status });
        }

        const resolvedScope = scope === 'consumer' || !orgId ? 'consumer' : 'organization';

        if (resolvedScope === 'organization') {
            if (!(await isOrgAdmin(req))) {
                return res.status(403).json({ error: 'Only organization admins can activate org licenses' });
            }
        }

        const activated = await license.activateLicense({
            token,
            organizationId: resolvedScope === 'organization' ? orgId : null,
            userId: resolvedScope === 'consumer' ? userId : null,
            activatedBy: userId,
        });
        const status = await license.getLicenseStatus({
            organizationId: resolvedScope === 'organization' ? orgId : null,
            userId: resolvedScope === 'consumer' ? userId : null,
        });
        res.json({ activated, status });
    } catch (e) {
        // Verification failures carry a code we want to surface to the UI
        if (e.code) return res.status(400).json({ error: e.message, code: e.code });
        console.error('[License] activate error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ── POST /refresh ───────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
    try {
        if (!(await isOrgAdmin(req))) {
            return res.status(403).json({ error: 'Admin required' });
        }
        const orgId = getOrgId(req);
        const userId = getUserId(req);
        const lic = orgId
            ? await license.store.getActiveLicenseForOrg(orgId)
            : await license.store.getActiveLicenseForUser(userId);
        if (!lic) return res.status(404).json({ error: 'No active license' });

        // refresh.js may not be loaded in test environments; tolerate that.
        let refreshOne;
        try {
            ({ refreshOne } = require('../license/refresh'));
        } catch (_) { /* refresh module not present */ }
        if (typeof refreshOne !== 'function') {
            return res.status(503).json({ error: 'Refresh subsystem unavailable' });
        }
        const result = await refreshOne(lic);
        res.json(result);
    } catch (e) {
        console.error('[License] refresh error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ── GET /health ─────────────────────────────────────────────────────────
// Admin-only observability surface. Single endpoint for ops dashboards.
// Reports refresher tick health, CRL poll status, and dunning counts.
router.get('/health', async (req, res) => {
    try {
        if (!(await isOrgAdmin(req))) {
            return res.status(403).json({ error: 'Admin required' });
        }
        let refresherHealth = null;
        try {
            const refresh = require('../license/refresh');
            if (typeof refresh.getRefresherHealth === 'function') {
                refresherHealth = refresh.getRefresherHealth();
            }
        } catch (_) { /* refresh module not present */ }

        let dunning = { past_due_count: 0, suspended_count: 0 };
        try {
            const userStore = require('../stores/userStore');
            if (typeof userStore.getDunningCounts === 'function') {
                dunning = await userStore.getDunningCounts();
            }
        } catch (_) { }

        res.json({
            refresher: refresherHealth || { enabled: false },
            crl: refresherHealth?.crl || { enabled: false },
            dunning,
            now: new Date().toISOString(),
        });
    } catch (e) {
        console.error('[License] health error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ── DELETE /deactivate ──────────────────────────────────────────────────
// Query: ?scope=server removes the install-wide server licence. Same
// super-admin + self-host gates as activate. Org/consumer scope follows
// the legacy "infer from session" rule.
router.delete('/deactivate', async (req, res) => {
    try {
        const orgId = getOrgId(req);
        const userId = getUserId(req);
        if (req.query?.scope === 'server') {
            if (!isServerScopeAllowed()) {
                return res.status(403).json({ error: 'server_scope_cloud_blocked' });
            }
            if (!isSuperAdmin(req)) {
                return res.status(403).json({ error: 'super_admin_required' });
            }
            const ok = await license.deactivateLicenseForScope({
                scope: 'server',
                deactivatedBy: userId,
            });
            if (!ok) return res.status(404).json({ error: 'No active server licence to deactivate' });
            return res.json({ success: true, scope: 'server' });
        }
        if (orgId && !(await isOrgAdmin(req))) {
            return res.status(403).json({ error: 'Admin required for organization license' });
        }
        const ok = await license.deactivateLicenseForScope({
            organizationId: orgId,
            userId: orgId ? null : userId,
            deactivatedBy: userId,
        });
        if (!ok) return res.status(404).json({ error: 'No active license to deactivate' });
        res.json({ success: true });
    } catch (e) {
        console.error('[License] deactivate error:', e);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
