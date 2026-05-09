/**
 * Authenticated NC binding approval endpoints.
 *
 * When the connector bootstrap detects a candidate adoption (NC admin email
 * matches an existing un-bound Bee Flow org), it does NOT bind — it creates
 * a `pending_nc_bindings` row and returns 202 to the connector. The org
 * admin must visit the SaaS UI, log in with their existing credentials, and
 * approve/deny the binding here. Only on approval is the org bound and the
 * tenantKey minted.
 *
 * This blocks the unauthenticated org-takeover path where an attacker
 * hosting a fake Nextcloud could otherwise claim a victim's email and have
 * the bootstrap silently adopt the victim's org.
 */

const express = require('express');
const router = express.Router();

const userStore = require('../stores/userStore');
const { requireAuth } = require('./permissions');
const { helpers: bootstrapHelpers } = require('./connectorBootstrap');

const { ensureOrgAdminUser, bindOrgToNcInstance, getOrMintTenantKey } = bootstrapHelpers;

function isExpired(row) {
    return row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now();
}

async function loadAndAuthorize(req, res) {
    const id = String(req.params.id || '').trim();
    if (!id) { res.status(400).json({ error: 'Missing id' }); return null; }
    const row = await userStore.getPendingNcBinding(id);
    if (!row) { res.status(404).json({ error: 'Pending binding not found' }); return null; }

    const sessionUser = req.session?.user;
    if (!sessionUser?.id) { res.status(401).json({ error: 'Not authenticated' }); return null; }

    const freshUser = await userStore.getUser(sessionUser.id);
    if (!freshUser) { res.status(401).json({ error: 'Session user no longer exists' }); return null; }

    const isSuperAdmin = req.session.isAdmin || freshUser.role === 'admin';
    const isOrgAdmin = freshUser.orgRole === 'org_admin' && freshUser.organizationId === row.orgId;
    if (!isSuperAdmin && !isOrgAdmin) {
        res.status(403).json({ error: 'Organization admin access required' });
        return null;
    }
    return { row, freshUser };
}

// List the active pending binding for the caller's own org. Used by the SPA
// to render <NcBindingApprovalModal/>. /auth/user already surfaces the same
// row inline; this endpoint exists for direct refreshes.
router.get('/admin/nc-bindings/pending', requireAuth, async (req, res) => {
    const orgId = req.session.user?.organizationId
        || (await userStore.getUser(req.session.user.id))?.organizationId;
    if (!orgId) return res.json({ pending: null });
    const row = await userStore.getPendingNcBindingForOrg(orgId);
    if (!row || isExpired(row)) return res.json({ pending: null });
    return res.json({
        pending: {
            id: row.id,
            ncBaseUrl: row.ncBaseUrl,
            ncInstanceId: row.ncInstanceId,
            ncAdminUid: row.ncAdminUid,
            ncAdminEmail: row.ncAdminEmail,
            themingName: row.themingName,
            ncVersion: row.ncVersion,
            expiresAt: row.expiresAt,
        },
    });
});

router.post('/admin/nc-bindings/:id/approve', requireAuth, async (req, res) => {
    const ctx = await loadAndAuthorize(req, res);
    if (!ctx) return;
    const { row, freshUser } = ctx;

    if (row.status !== 'pending') {
        return res.status(409).json({ error: `Binding is ${row.status}` });
    }
    if (isExpired(row)) {
        try { await userStore.expirePendingNcBindings(); } catch (_) { }
        return res.status(410).json({ error: 'Pending binding expired' });
    }

    const org = await userStore.getOrganization(row.orgId);
    if (!org) return res.status(404).json({ error: 'Organization no longer exists' });
    if (org.nc_instance_id && org.nc_instance_id !== row.ncInstanceId) {
        return res.status(409).json({ error: 'Organization is already bound to a different NC instance' });
    }

    let boundOrg = org;
    if (!org.nc_instance_id) {
        boundOrg = await bindOrgToNcInstance(org, {
            ncInstanceId: row.ncInstanceId,
            ncBaseUrl: row.ncBaseUrl,
            ncAdminUid: row.ncAdminUid,
            connectorCallbackUrl: row.connectorCallbackUrl,
        });
    }

    try {
        await ensureOrgAdminUser(boundOrg, {
            ncAdminEmail: row.ncAdminEmail,
            ncAdminUid: row.ncAdminUid,
            ncAdminDisplayName: row.ncAdminDisplayName,
        });
    } catch (e) {
        if (e.statusCode === 409) return res.status(409).json({ error: e.message });
        throw e;
    }

    const tenantKey = await getOrMintTenantKey(boundOrg.id);
    await userStore.markPendingNcBindingApproved(row.id, freshUser.id);

    console.log(`[NcBindingRoutes] Approved binding ${row.id} → org ${boundOrg.id} by user ${freshUser.id}`);
    return res.json({
        tenantKey,
        organizationId: boundOrg.id,
        organizationName: boundOrg.name,
        isAdopted: true,
    });
});

router.post('/admin/nc-bindings/:id/deny', requireAuth, async (req, res) => {
    const ctx = await loadAndAuthorize(req, res);
    if (!ctx) return;
    const { row, freshUser } = ctx;
    if (row.status !== 'pending') {
        return res.status(409).json({ error: `Binding is ${row.status}` });
    }
    await userStore.markPendingNcBindingDenied(row.id, freshUser.id);
    console.log(`[NcBindingRoutes] Denied binding ${row.id} for org ${row.orgId} by user ${freshUser.id}`);
    return res.json({ status: 'denied' });
});

module.exports = router;
