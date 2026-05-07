/**
 * Nextcloud Connector — admin routes
 *
 * Endpoints for super-admins (or org admins of the target org) to mint and
 * rotate the per-tenant key the Bee Flow Nextcloud connector uses to sign
 * its JWTs. The customer's NC admin pastes this key into AppAPI's app
 * settings via:
 *
 *     occ app_api:app:setenv bee_flow BEEFLOW_TENANT_KEY <key>
 *
 * Keys are stored encrypted at rest in configStore under
 * `connector_tenant_key_<orgId>` (see auth/connectorJwt.js).
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const configStore = require('../stores/configStore');
const userStore = require('../stores/userStore');
const { requireAuth } = require('./permissions');
const { invalidateTenantKeyCache } = require('./connectorJwt');

const TENANT_KEY_PREFIX = 'connector_tenant_key_';

async function isOrgAdminForOrg(req, orgId) {
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return true;
    const userId = req.session?.user?.id;
    if (!userId) return false;
    const user = await userStore.getUser(userId);
    if (!user || user.orgRole !== 'org_admin') return false;
    return user.organizationId === orgId;
}

// Issue (or rotate) the tenant key for a given org. Returns the key in the
// response body — this is the ONLY moment it's visible in plaintext over
// the wire. Caller must capture it and hand it to the customer admin.
router.post('/admin/connector/tenants/:orgId/key', requireAuth, async (req, res) => {
    const { orgId } = req.params;
    if (!orgId) return res.status(400).json({ error: 'orgId required' });
    if (!await isOrgAdminForOrg(req, orgId)) {
        return res.status(403).json({ error: 'Organization admin access required' });
    }

    // 32 random bytes, base64url-encoded — long enough for HS256 with comfortable margin.
    const key = crypto.randomBytes(32).toString('base64url');
    try {
        await configStore.setSecret(TENANT_KEY_PREFIX + orgId, key);
        invalidateTenantKeyCache(orgId);
        console.log(`[ConnectorAdmin] Tenant key issued for org=${orgId} by user=${req.session.user.id}`);
        res.json({
            orgId,
            tenantKey: key,
            instructions: 'Have your Nextcloud admin run: occ app_api:app:setenv bee_flow BEEFLOW_TENANT_KEY <tenantKey>',
        });
    } catch (err) {
        console.error(`[ConnectorAdmin] Failed to mint tenant key: ${err.message}`);
        res.status(500).json({ error: 'Failed to mint tenant key' });
    }
});

// Whether a key currently exists for this org. Never returns the key
// itself — this is for the admin UI to show "Configured / Not configured".
router.get('/admin/connector/tenants/:orgId/key', requireAuth, async (req, res) => {
    const { orgId } = req.params;
    if (!orgId) return res.status(400).json({ error: 'orgId required' });
    if (!await isOrgAdminForOrg(req, orgId)) {
        return res.status(403).json({ error: 'Organization admin access required' });
    }
    try {
        const existing = await configStore.getSecret(TENANT_KEY_PREFIX + orgId);
        res.json({ orgId, configured: !!existing });
    } catch (err) {
        console.error(`[ConnectorAdmin] Failed to read tenant key state: ${err.message}`);
        res.status(500).json({ error: 'Failed to read tenant key state' });
    }
});

router.delete('/admin/connector/tenants/:orgId/key', requireAuth, async (req, res) => {
    const { orgId } = req.params;
    if (!orgId) return res.status(400).json({ error: 'orgId required' });
    if (!await isOrgAdminForOrg(req, orgId)) {
        return res.status(403).json({ error: 'Organization admin access required' });
    }
    try {
        // setSecret('') effectively clears since configStore stores empty as
        // null; deleteConfig would also work if available.
        await configStore.setSecret(TENANT_KEY_PREFIX + orgId, '');
        invalidateTenantKeyCache(orgId);
        console.log(`[ConnectorAdmin] Tenant key revoked for org=${orgId} by user=${req.session.user.id}`);
        res.json({ orgId, revoked: true });
    } catch (err) {
        console.error(`[ConnectorAdmin] Failed to revoke tenant key: ${err.message}`);
        res.status(500).json({ error: 'Failed to revoke tenant key' });
    }
});

module.exports = router;
