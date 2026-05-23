/**
 * Nextcloud Connector — auto-provisioning bootstrap.
 *
 * On first start, the Bee Flow Nextcloud ExApp connector calls this endpoint
 * with metadata about its NC instance. We split the trust model by branch:
 *
 *   - **Returning bind** (instance id already known): retourneer cached
 *     tenantKey direct. Bewijs: same instance id round-trips capabilities.
 *   - **Fresh org** (no SaaS user matches the NC admin email): create a new
 *     Bee Flow org keyed off this NC instance, mint a tenantKey, return it.
 *     One-click. There is no victim — the org is brand new.
 *   - **Adoption** (NC admin email matches an existing un-bound org):
 *     **Do NOT bind.** A `pending_nc_bindings` row is created and the
 *     caller receives 202 with a poll URL. The org-admin must explicitly
 *     approve the binding from inside the authenticated SaaS UI before the
 *     connector ever sees the tenantKey. This blocks the unauthenticated
 *     org-takeover where an attacker hosting a fake NC could otherwise
 *     adopt a victim's org by claiming the victim's email.
 *
 * The connector caches the returned key in its persistent storage volume so
 * subsequent restarts don't re-bootstrap.
 */

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');
const { invalidateTenantKeyCache } = require('./connectorJwt');

const TENANT_KEY_PREFIX = 'connector_tenant_key_';
const PENDING_TTL_SECONDS = 1800;
const MAX_PENDING_PER_ORG = 5;

// Bootstrap is unauthenticated by design (the connector has no SaaS creds
// at this point). Rate-limit per source IP so an attacker can't flood the
// pending-binding queue or fish for org-emails. The numbers below are
// generous enough for a real fleet rollout (multiple NC instances behind
// the same NAT) but tight enough to make brute-force/DoS impractical.
// `validate: { trustProxy: false }` silences express-rate-limit's strict
// trust-proxy validator. The server runs behind Nginx Proxy Manager which
// sets X-Forwarded-For; Express resolves req.ip via app.set('trust proxy').
// We accept that a determined attacker could spoof XFF to evade per-IP
// limiting — bootstrap is also gated by the NC capabilities round-trip,
// and the limiter's main job is slowing down org-email enumeration.
const bootstrapLimiter = rateLimit({
    windowMs: 15 * 60_000,        // 15 minutes
    max: 20,                       // 20 bootstrap attempts per IP per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many bootstrap attempts; try again later.' },
    validate: { trustProxy: false },
});

const pendingPollLimiter = rateLimit({
    windowMs: 60_000,              // 1 minute
    max: 60,                       // 1 poll/sec average — connector polls every ~5s
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many poll requests.' },
    validate: { trustProxy: false },
});

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
// the instance id round-trips. Necessary but not sufficient — an attacker
// can host a fake NC that returns whatever instance id they put in the
// header. The adoption gate (pending_nc_bindings + admin approval) closes
// that gap.
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

// Mint or fetch the tenantKey for an org. Idempotent — re-runs return the
// same key. Used by both the fresh-org branch here and the approval handler
// in ncBindingRoutes.js.
async function getOrMintTenantKey(orgId) {
    const cfgKey = `${TENANT_KEY_PREFIX}${orgId}`;
    let tenantKey = await configStore.getSecret(cfgKey);
    if (!tenantKey) {
        tenantKey = crypto.randomBytes(32).toString('base64url');
        await configStore.setSecret(cfgKey, tenantKey);
        invalidateTenantKeyCache(orgId);
        console.log(`[ConnectorBootstrap] Minted new tenant key for org ${orgId}`);
    }
    return tenantKey;
}

// Promote / create the NC admin user inside an org. Used by the fresh-org
// branch and the approval handler.
async function ensureOrgAdminUser(org, { ncAdminEmail, ncAdminUid, ncAdminDisplayName }) {
    let user = await userStore.getUserByEmail(ncAdminEmail);
    if (!user) {
        const userId = `nc_${org.id}_${slugify(ncAdminUid)}`;
        const r = await userStore.createUserWithSeatCheck({
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
        }, { strict: false });
        if (!r.created) {
            console.warn(`[connectorBootstrap] could not create NC admin for org=${org.id} reason=${r.reason}`);
            return null;
        }
        return await userStore.getUser(userId);
    }
    if (user.organizationId && user.organizationId !== org.id) {
        const userOrg = await userStore.getOrganization(user.organizationId);
        if (!userOrg) {
            // Orphaned — rebind.
            await userStore.updateUser(user.id, {
                organizationId: org.id,
                orgRole: 'org_admin',
                ncUid: user.nc_uid || ncAdminUid,
                provider: user.provider || 'nextcloud_connector',
            });
            console.log(`[ConnectorBootstrap] Rebound orphaned user ${user.id} to org ${org.id}`);
            return await userStore.getUser(user.id);
        }
        const err = new Error('NC admin email is linked to another Bee Flow organization');
        err.statusCode = 409;
        throw err;
    }
    const updates = {};
    if (!user.organizationId) updates.organizationId = org.id;
    if (user.orgRole !== 'org_admin') updates.orgRole = 'org_admin';
    if (!user.ncUid) updates.ncUid = ncAdminUid;
    if (!user.provider) updates.provider = 'nextcloud_connector';
    if (Object.keys(updates).length > 0) await userStore.updateUser(user.id, updates);
    return await userStore.getUser(user.id);
}

// Bind an existing un-bound org to this NC instance. Used by the approval
// handler in ncBindingRoutes.js. Replaces what used to be the inline
// "adopt existing org" branch.
async function bindOrgToNcInstance(org, params) {
    const { ncInstanceId, ncBaseUrl, ncAdminUid, connectorCallbackUrl } = params;
    let existingIntegrations = [];
    if (Array.isArray(org.enabledIntegrations)) {
        existingIntegrations = org.enabledIntegrations;
    } else if (typeof org.enabledIntegrations === 'string' && org.enabledIntegrations) {
        try { existingIntegrations = JSON.parse(org.enabledIntegrations) || []; } catch (_) { existingIntegrations = []; }
    }
    const merged = Array.from(new Set([...existingIntegrations, ...NC_INTEGRATIONS]));
    await userStore.updateOrganization(org.id, {
        authMethod: 'nextcloud_connector',
        autoApproveSSO: true,
        connectorCallbackUrl: connectorCallbackUrl || null,
        ncInstanceId,
        ncBaseUrl,
        ncAdminUid,
        ncProvisionedAt: new Date().toISOString(),
        enabledIntegrations: merged,
    });
    return await userStore.getOrganizationByNcInstanceId(ncInstanceId);
}

router.post('/connector/bootstrap', bootstrapLimiter, async (req, res) => {
    const { ncInstanceId, ncBaseUrl, ncAdminUid, ncAdminEmail, ncAdminDisplayName, connectorCallbackUrl } = readBootstrapHeaders(req);
    if (!ncInstanceId || !ncBaseUrl || !ncAdminUid || !ncAdminEmail) {
        return res.status(400).json({
            error: 'Missing required X-Beeflow-NC-* headers',
            code: 'missing_headers',
            remediation: 'The Bee Flow connector must send X-Beeflow-NC-Instance-Id, -Base-Url, -Admin-Uid and -Admin-Email. Re-deploy the connector or upgrade to the latest release.',
        });
    }
    if (!ncAdminEmail.includes('@')) {
        return res.status(400).json({
            error: 'NC admin email is not a valid email',
            code: 'invalid_admin_email',
            remediation: 'Configure an email address on your Nextcloud admin user and re-deploy the connector.',
        });
    }

    let nc;
    if (process.env.BEEFLOW_BOOTSTRAP_SKIP_VERIFY === 'true') {
        console.warn('[ConnectorBootstrap] BEEFLOW_BOOTSTRAP_SKIP_VERIFY=true — skipping capabilities check');
        nc = { themingName: 'Nextcloud (dev)', ncVersion: 'unverified' };
    } else {
        try {
            nc = await verifyNcInstance(ncBaseUrl, ncInstanceId);
        } catch (e) {
            console.warn(`[ConnectorBootstrap] verify_failed url=${ncBaseUrl} ncInstance=${ncInstanceId} reason=${e.message}`);
            const isUnreachable = /unreachable|fetch failed|timeout|ENOTFOUND|ECONNREFUSED/i.test(e.message);
            return res.status(403).json({
                error: 'Could not verify NC instance ownership: ' + e.message,
                code: isUnreachable ? 'nc_capabilities_unreachable' : 'nc_capabilities_mismatch',
                remediation: isUnreachable
                    ? 'Bee Flow Cloud could not reach your Nextcloud at ' + ncBaseUrl + '. Your Nextcloud must be publicly reachable for SaaS-to-NC callbacks. Either expose it publicly, or set BEEFLOW_NC_PUBLIC_URL in the connector to an HTTPS tunnel or reverse-proxy URL we can reach.'
                    : 'Your Nextcloud responded but its instance id does not match the one the connector sent. This usually means the connector was reinstalled while the SaaS still tracked the old instance. Contact support if it persists.',
            });
        }
    }

    // 1. Returning bind — instance id already mapped → idempotent return.
    let org = await userStore.getOrganizationByNcInstanceId(ncInstanceId);
    if (org) {
        try {
            await ensureOrgAdminUser(org, { ncAdminEmail, ncAdminUid, ncAdminDisplayName });
        } catch (e) {
            if (e.statusCode === 409) return res.status(409).json({
                error: e.message,
                code: 'admin_email_conflict',
                remediation: 'The Nextcloud admin email is already used by a user in a different Bee Flow organization. Either use a different admin user on Nextcloud, or contact support to merge the accounts.',
            });
            throw e;
        }
        const tenantKey = await getOrMintTenantKey(org.id);
        if (connectorCallbackUrl && org.connector_callback_url !== connectorCallbackUrl) {
            await userStore.updateOrganization(org.id, { connectorCallbackUrl });
        }
        console.log(`[ConnectorBootstrap] returning_bind org=${org.id} ncInstance=${ncInstanceId} ncBaseUrl=${ncBaseUrl}`);
        return res.json({
            tenantKey,
            organizationId: org.id,
            organizationName: org.name,
            isNew: false,
            ncVersion: nc.ncVersion,
            code: 'returning_bind',
        });
    }

    // 2. Adoption candidate — defer to authenticated approval.
    const candidate = await userStore.getUserByEmail(ncAdminEmail);
    if (candidate?.organizationId) {
        const candidateOrg = await userStore.getOrganization(candidate.organizationId);
        if (candidateOrg && !candidateOrg.nc_instance_id) {
            // Cap pending bindings per org to prevent attacker spam from
            // flooding the admin UI with rotating fake instance ids.
            const activeCount = await userStore.countActivePendingNcBindingsForOrg(candidateOrg.id);
            if (activeCount >= MAX_PENDING_PER_ORG) {
                console.warn(`[ConnectorBootstrap] too_many_pending org=${candidateOrg.id} ncInstance=${ncInstanceId}`);
                return res.status(429).json({
                    error: 'Too many pending NC bindings for this organization. Try again later.',
                    code: 'too_many_pending_bindings',
                    remediation: 'Sign in to Bee Flow and either approve or dismiss the existing pending Nextcloud bindings for this organization, then retry from the connector.',
                });
            }
            const pending = await userStore.createPendingNcBinding({
                orgId: candidateOrg.id,
                ncInstanceId,
                ncBaseUrl,
                ncAdminUid,
                ncAdminEmail,
                ncAdminDisplayName,
                connectorCallbackUrl,
                themingName: nc.themingName,
                ncVersion: nc.ncVersion,
            }, PENDING_TTL_SECONDS);
            console.log(`[ConnectorBootstrap] pending_claim org=${candidateOrg.id} pendingId=${pending.id} ncInstance=${ncInstanceId} expiresAt=${pending.expiresAt}`);
            return res.status(202).json({
                status: 'pending_claim',
                code: 'pending_admin_approval',
                pendingId: pending.id,
                pollUrl: `/auth/connector/bootstrap/pending/${pending.id}`,
                expiresAt: pending.expiresAt,
                message: 'Awaiting org-admin confirmation in Bee Flow UI',
                remediation: 'An admin of the matching Bee Flow organization must approve this binding from the Bee Flow web UI before the connector receives a tenant key.',
            });
        }
    }

    // 3. Fresh-org branch — no victim, no risk. One-click.
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
        return res.status(500).json({
            error: 'Failed to create organization',
            code: 'org_create_failed',
            remediation: 'Bee Flow could not provision a new organization. This is usually a transient database issue — wait a minute and the connector will retry automatically. If it persists, contact support with the connector logs.',
        });
    }
    org = await userStore.getOrganizationByNcInstanceId(ncInstanceId);
    console.log(`[ConnectorBootstrap] fresh_org org=${orgId} ncInstance=${ncInstanceId} ncBaseUrl=${ncBaseUrl} adminEmail=${ncAdminEmail}`);

    try {
        await ensureOrgAdminUser(org, { ncAdminEmail, ncAdminUid, ncAdminDisplayName });
    } catch (e) {
        if (e.statusCode === 409) return res.status(409).json({
            error: e.message,
            code: 'admin_email_conflict',
            remediation: 'The Nextcloud admin email is already used by a user in another Bee Flow organization. Use a different admin user on Nextcloud, or contact support.',
        });
        throw e;
    }
    const tenantKey = await getOrMintTenantKey(org.id);
    return res.json({
        tenantKey,
        organizationId: org.id,
        organizationName: org.name,
        isNew: true,
        ncVersion: nc.ncVersion,
        code: 'fresh_org',
    });
});

// Connector polls this endpoint while a pending binding awaits admin
// approval. Possession of the random `id` lets the caller read status only —
// no privileges are granted by the token alone. The tenantKey is only
// returned once an authenticated org-admin has approved the binding.
router.get('/connector/bootstrap/pending/:id', pendingPollLimiter, async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const row = await userStore.getPendingNcBinding(id);
    if (!row) return res.status(404).json({ status: 'not_found' });

    const expired = row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now();
    if (row.status === 'denied') return res.status(410).json({ status: 'denied' });
    if (row.status === 'expired' || (row.status === 'pending' && expired)) {
        // Lazy expiry — sweep this row too.
        if (row.status === 'pending') {
            try { await userStore.expirePendingNcBindings(); } catch (_) { /* tolerate */ }
        }
        return res.status(410).json({ status: 'expired' });
    }
    if (row.status === 'approved') {
        const org = await userStore.getOrganization(row.orgId);
        if (!org) return res.status(410).json({ status: 'expired' });
        const tenantKey = await getOrMintTenantKey(org.id);
        return res.json({
            tenantKey,
            organizationId: org.id,
            organizationName: org.name,
            ncVersion: row.ncVersion,
            isAdopted: true,
        });
    }
    // status === 'pending'
    return res.status(202).json({
        status: 'pending',
        expiresAt: row.expiresAt,
    });
});

module.exports = router;
module.exports.helpers = {
    NC_INTEGRATIONS,
    PENDING_TTL_SECONDS,
    getOrMintTenantKey,
    ensureOrgAdminUser,
    bindOrgToNcInstance,
};
