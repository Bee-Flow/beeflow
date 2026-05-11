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

const license = require('../license');
const { hasPermission, resolveUserOrgIds } = require('../auth/permissions');

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
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return true;
    const userId = getUserId(req);
    if (!userId) return false;
    if (req.session?.user?.orgRole === 'org_admin') return true;
    try {
        return await hasPermission(userId, 'admin_subscriptions', req.session);
    } catch (_) { return false; }
}

router.use((req, res, next) => {
    if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
    next();
});

// ── GET /status ─────────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
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
// body: { token: '<jwt>', scope?: 'organization' | 'consumer' }
router.post('/activate', async (req, res) => {
    try {
        const { token, scope } = req.body || {};
        if (!token || typeof token !== 'string') {
            return res.status(400).json({ error: 'token required' });
        }
        const orgId = getOrgId(req);
        const userId = getUserId(req);
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

// ── DELETE /deactivate ──────────────────────────────────────────────────
router.delete('/deactivate', async (req, res) => {
    try {
        const orgId = getOrgId(req);
        const userId = getUserId(req);
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
