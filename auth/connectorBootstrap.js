/**
 * Nextcloud Connector — auto-provisioning bootstrap.
 *
 * On first start, the Bee Flow Nextcloud ExApp connector calls this endpoint
 * with metadata about its NC instance. We:
 *   1. Verify the call really originates from that NC instance by calling
 *      `/ocs/v2.php/cloud/capabilities` ourselves and matching the instance
 *      id back. Only somebody actually behind that NC can win the race.
 *   2. Look up or create a Bee Flow organization keyed by `nc_instance_id`.
 *      Same instance id -> same org -> same tenant key (idempotent).
 *   3. Ensure the NC admin exists as a Bee Flow user with `org_admin` role.
 *   4. Mint a tenant key (HS256 secret) the connector uses to sign per-user
 *      JWTs. Store encrypted in `configStore`. Return plaintext to caller —
 *      that is the only moment it leaves the server unencrypted.
 *
 * The connector caches the returned key in its persistent storage volume so
 * subsequent restarts don't re-bootstrap.
 *
 * Authentication of the caller: the bootstrap request itself has no shared
 * secret yet (that's literally what we're handing back). We rely on the
 * NC-side capabilities check + DNS resolution of the supplied `ncBaseUrl`.
 * Anyone who can host an NC instance with a matching instance id is allowed
 * to provision against our SaaS — that's the same trust model App Store
 * customers operate under.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');
const { invalidateTenantKeyCache } = require('./connectorJwt');

const TENANT_KEY_PREFIX = 'connector_tenant_key_';

// All NC integrations Bee Flow ships with — auto-enabled on connector
// bootstrap so the agent can immediately reach Files, Calendar, Mail, etc.
// out-of-the-box without an org-admin having to flip toggles. The connector
// proxy handles auth via AppAPI shared-secret + impersonation, so no
// per-user app passwords are needed.
const NC_INTEGRATIONS = [
    'nextcloud', 'nextcloud-calendar', 'nextcloud-contacts', 'nextcloud-deck',
    'nextcloud-notifications', 'nextcloud-talk', 'nextcloud-tasks',
    'nextcloud-notes', 'nextcloud-activity', 'nextcloud-status',
];

function slugify(s) {
    return String(s || 'nc')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'nc';
}

function readBootstrapHeaders(req) {
    return {
        ncInstanceId: String(req.headers['x-beeflow-nc-instance-id'] || '').trim(),
        ncBaseUrl: String(req.headers['x-beeflow-nc-base-url'] || '').trim().replace(/\/+$/, ''),
        ncAdminUid: String(req.headers['x-beeflow-nc-admin-uid'] || '').trim(),
        ncAdminEmail: String(req.headers['x-beeflow-nc-admin-email'] || '').trim().toLowerCase(),
        ncAdminDisplayName: String(req.headers['x-beeflow-nc-admin-display-name'] || '').trim(),
        connectorCallbackUrl: String(req.headers['x-beeflow-connector-callback-url'] || '').trim().replace(/\/+$/, ''),
    };
}

// Spoofing defence: GET <ncBaseUrl>/ocs/v2.php/cloud/capabilities and verify
// the instance id round-trips. Without this, any caller could fabricate
// headers and force-create an org bound to a victim's NC instance.
async function verifyNcInstance(ncBaseUrl, expectedInstanceId) {
    const url = `${ncBaseUrl}/ocs/v2.php/cloud/capabilities?format=json`;
    let res;
    try {
        res = await fetch(url, {
            headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' },
            signal: AbortSignal.timeout(8000),
        });
    } catch (e) {
        throw new Error(`NC capabilities unreachable: ${e.message}`);
    }
    if (!res.ok) throw new Error(`NC capabilities HTTP ${res.status}`);
    const body = await res.json();
    const data = body?.ocs?.data;
    if (!data?.version) throw new Error('NC capabilities returned no version data');
    // NC's instance id lives in different places across versions; accept any.
    const reportedId = data?.capabilities?.theming?.instanceid
        || data?.capabilities?.core?.instanceid
        || data?.version?.string + ':' + (data?.capabilities?.theming?.name || 'nextcloud');
    if (reportedId !== expectedInstanceId) {
        throw new Error(`NC instance id mismatch: header=${expectedInstanceId} server=${reportedId}`);
    }
    return {
        themingName: data?.capabilities?.theming?.name || 'Nextcloud',
        ncVersion: data?.version?.string || 'unknown',
    };
}

router.post('/connector/bootstrap', async (req, res) => {
    const { ncInstanceId, ncBaseUrl, ncAdminUid, ncAdminEmail, ncAdminDisplayName, connectorCallbackUrl } = readBootstrapHeaders(req);
    if (!ncInstanceId || !ncBaseUrl || !ncAdminUid || !ncAdminEmail) {
        return res.status(400).json({ error: 'Missing required X-Beeflow-NC-* headers' });
    }
    if (!ncAdminEmail.includes('@')) {
        return res.status(400).json({ error: 'NC admin email is not a valid email' });
    }

    let nc;
    if (process.env.BEEFLOW_BOOTSTRAP_SKIP_VERIFY === 'true') {
        // Dev-only escape hatch: NC sandboxes that live on a docker network
        // are unreachable from the SaaS host. Trust the headers and use the
        // connector-supplied display name. Never enable in production.
        console.warn('[ConnectorBootstrap] BEEFLOW_BOOTSTRAP_SKIP_VERIFY=true — skipping capabilities check');
        nc = { themingName: 'Nextcloud (dev)', ncVersion: 'unverified' };
    } else {
        try {
            nc = await verifyNcInstance(ncBaseUrl, ncInstanceId);
        } catch (e) {
            console.warn(`[ConnectorBootstrap] Verify failed for ${ncBaseUrl}: ${e.message}`);
            return res.status(403).json({ error: 'Could not verify NC instance ownership: ' + e.message });
        }
    }

    let org = await userStore.getOrganizationByNcInstanceId(ncInstanceId);
    let isNew = false;
    let isAdopted = false;
    if (!org) {
        // Existing-org adoption path: if the NC admin's email already maps
        // to a Bee Flow user inside an org that hasn't been bound to any NC
        // instance yet, treat *that* org as the one this NC connects into.
        // Avoids the "email linked to another organization" rejection in
        // the common case where the customer signed up to Bee Flow first
        // and only later installs the connector from the App Store.
        const candidate = await userStore.getUserByEmail(ncAdminEmail);
        if (candidate?.organizationId) {
            const candidateOrg = await userStore.getOrganization(candidate.organizationId);
            if (candidateOrg && !candidateOrg.nc_instance_id) {
                // Merge existing integrations with NC defaults — never strip
                // anything the org-admin already enabled outside NC.
                const existingIntegrations = Array.isArray(candidateOrg.enabledIntegrations) ? candidateOrg.enabledIntegrations : [];
                const merged = Array.from(new Set([...existingIntegrations, ...NC_INTEGRATIONS]));
                await userStore.updateOrganization(candidateOrg.id, {
                    authMethod: 'nextcloud_connector',
                    autoApproveSSO: true,
                    connectorCallbackUrl: connectorCallbackUrl || null,
                    ncInstanceId,
                    ncBaseUrl,
                    ncAdminUid,
                    ncProvisionedAt: new Date().toISOString(),
                    enabledIntegrations: merged,
                });
                org = await userStore.getOrganizationByNcInstanceId(ncInstanceId);
                isAdopted = true;
                console.log(`[ConnectorBootstrap] Adopted existing org ${candidateOrg.id} for NC instance ${ncInstanceId}`);
            }
        }
    }
    if (!org) {
        const idSuffix = slugify(ncInstanceId.slice(0, 12)) || crypto.randomBytes(3).toString('hex');
        const orgId = `nc-${slugify(nc.themingName)}-${idSuffix}`;
        const created = await userStore.createOrganization({
            id: orgId,
            name: nc.themingName || 'Nextcloud',
            description: `Auto-provisioned from Nextcloud (${ncBaseUrl})`,
            authMethod: 'nextcloud_connector',
            autoApproveSSO: true,
            ncInstanceId,
            ncBaseUrl,
            ncAdminUid,
            ncProvisionedAt: new Date().toISOString(),
            connectorCallbackUrl: connectorCallbackUrl || null,
            enabledIntegrations: NC_INTEGRATIONS,
        });
        if (!created) {
            return res.status(500).json({ error: 'Failed to create organization' });
        }
        org = await userStore.getOrganizationByNcInstanceId(ncInstanceId);
        isNew = true;
        console.log(`[ConnectorBootstrap] Created org ${orgId} for NC instance ${ncInstanceId} (${ncBaseUrl})`);
    }

    let user = await userStore.getUserByEmail(ncAdminEmail);
    if (!user) {
        const userId = `nc_${org.id}_${slugify(ncAdminUid)}`;
        await userStore.createUser({
            id: userId,
            username: ncAdminEmail,
            email: ncAdminEmail,
            displayName: ncAdminDisplayName || ncAdminUid,
            role: 'user',
            orgRole: 'org_admin',
            organizationId: org.id,
            ncUid: ncAdminUid,
            provider: 'nextcloud_connector',
            autoProvisioned: true,
            status: 'active',
        });
        user = await userStore.getUser(userId);
    } else if (user.organizationId && user.organizationId !== org.id) {
        // Orphan check: the user might point at an organization that no
        // longer exists in the DB (deleted org leaves users dangling). If
        // so, rebind the user instead of rejecting.
        const userOrg = await userStore.getOrganization(user.organizationId);
        if (!userOrg) {
            await userStore.updateUser(user.id, {
                organizationId: org.id,
                orgRole: 'org_admin',
                ncUid: user.nc_uid || ncAdminUid,
                provider: user.provider || 'nextcloud_connector',
            });
            console.log(`[ConnectorBootstrap] Rebound orphaned user ${user.id} to org ${org.id}`);
        } else {
            return res.status(409).json({ error: 'NC admin email is linked to another Bee Flow organization' });
        }
    } else {
        // Existing local user — promote to org_admin and bind to this org if not yet bound.
        const updates = {};
        if (!user.organizationId) updates.organizationId = org.id;
        if (user.orgRole !== 'org_admin') updates.orgRole = 'org_admin';
        if (!user.ncUid) updates.ncUid = ncAdminUid;
        if (!user.provider) updates.provider = 'nextcloud_connector';
        if (Object.keys(updates).length > 0) {
            await userStore.updateUser(user.id, updates);
        }
    }

    const cfgKey = `${TENANT_KEY_PREFIX}${org.id}`;
    let tenantKey = await configStore.getSecret(cfgKey);
    if (!tenantKey) {
        tenantKey = crypto.randomBytes(32).toString('base64url');
        await configStore.setSecret(cfgKey, tenantKey);
        invalidateTenantKeyCache(org.id);
        console.log(`[ConnectorBootstrap] Minted new tenant key for org ${org.id}`);
    }

    if (connectorCallbackUrl && org.connector_callback_url !== connectorCallbackUrl) {
        await userStore.updateOrganization(org.id, { connectorCallbackUrl });
    }

    return res.json({
        tenantKey,
        organizationId: org.id,
        organizationName: org.name,
        isNew,
        ncVersion: nc.ncVersion,
    });
});

module.exports = router;
