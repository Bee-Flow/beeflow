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
const planEntitlements = require('../services/planEntitlements');
const { sendNcVerificationCodeEmail } = require('../utils/emailService');

// Auto-apply the operator-flagged "Nextcloud recommended" plan to freshly
// provisioned or freshly-adopted NC orgs so they get enterprise-equivalent
// entitlements (Webpages, Meeting Notes, Automations, …) without manual
// intervention. Without this the org defaults to the community tier and the
// admin lands on a stripped-down SPA on their first visit. Best-effort — a
// failure logs and continues; the org is still usable on the community
// fallback.
async function applyNcDefaultPlanIfConfigured(orgId, source) {
    try {
        const plan = await userStore.getDefaultNcPlan();
        if (!plan) {
            console.log(`[ConnectorBootstrap] no NC-recommended plan configured; org ${orgId} will use community fallback (source=${source})`);
            return;
        }
        // Make it the org's ACTIVE subscription — createOrganization pre-assigns
        // the `is_default` plan, so without this the org would keep that plan and
        // only inherit this plan's integrations/features. setOrgSubscription
        // upserts the organization_subscriptions row so billing/limits read the
        // NC plan. Then applyPlanToOrg syncs the enabled integrations/features.
        await userStore.setOrgSubscription(orgId, { plan_id: plan.id, status: 'active' });
        await planEntitlements.applyPlanToOrg(orgId, plan.id, { mode: 'reset' });
        console.log(`[ConnectorBootstrap] Applied NC default plan ${plan.id} (${plan.name}) as active subscription for org ${orgId} (source=${source})`);
    } catch (err) {
        console.warn(`[ConnectorBootstrap] failed to apply NC default plan to org ${orgId}: ${err.message}`);
    }
}

const TENANT_KEY_PREFIX = 'connector_tenant_key_';
const PENDING_TTL_SECONDS = 1800;
const MAX_VERIFICATIONS_PER_ORG = 5;

// Free/public email providers. A shared domain here does NOT imply control of a
// Bee Flow org, so a domain-only match against one of these never routes into
// adoption — only an exact email match to an existing user does. Everything else
// (different free-provider local-part, or no match) creates a fresh org.
const FREE_EMAIL_DOMAINS = new Set([
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk',
    'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'icloud.com',
    'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com',
    'gmx.net', 'mail.com', 'aol.com', 'zoho.com', 'yandex.com', 'yandex.ru',
    'hey.com', 'fastmail.com', 'tutanota.com', 'tuta.com',
]);

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

// Resending a verification code emails the org's admin mailbox; cap it tightly
// per source IP so a held pendingId can't be used to mail-bomb the address.
const verificationResendLimiter = rateLimit({
    windowMs: 15 * 60_000,         // 15 minutes
    max: 5,                        // 5 resends per IP per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many code requests; try again later.' },
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

// 6-digit numeric one-time code, zero-padded. crypto.randomInt is uniform.
function generateVerificationCode() {
    return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

// Mask an email for display in the connector / SPA without leaking the full
// local-part: tomkooy@beeflow.nl → t•••y@beeflow.nl.
function maskEmail(email) {
    const [local = '', domain = ''] = String(email || '').split('@');
    if (!domain) return '***';
    const first = local.slice(0, 1) || '*';
    const last = local.length > 1 ? local.slice(-1) : '';
    return `${first}${'•'.repeat(3)}${last}@${domain}`;
}

function readBootstrapHeaders(req) {
    return {
        ncInstanceId: String(req.headers['x-beeflow-nc-instance-id'] || '').trim(),
        ncBaseUrl: String(req.headers['x-beeflow-nc-base-url'] || '').trim().replace(/\/+$/, ''),
        ncAdminUid: String(req.headers['x-beeflow-nc-admin-uid'] || '').trim(),
        ncAdminEmail: String(req.headers['x-beeflow-nc-admin-email'] || '').trim().toLowerCase(),
        ncAdminDisplayName: String(req.headers['x-beeflow-nc-admin-display-name'] || '').trim(),
        connectorCallbackUrl: String(req.headers['x-beeflow-connector-callback-url'] || '').trim().replace(/\/+$/, ''),
        pairingCode: String(req.headers['x-beeflow-pairing-code'] || '').trim().toUpperCase(),
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
    const { ncInstanceId, ncBaseUrl, ncAdminUid, ncAdminEmail, ncAdminDisplayName, connectorCallbackUrl, pairingCode } = readBootstrapHeaders(req);
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

    // 0. Pairing-code branch — wins over auto-detect when present. The org
    //    admin has handed out a one-shot code; whoever holds it gets to bind
    //    this NC instance to that specific org. No fresh-org creation, no
    //    pending approval queue — the code already IS the approval. Code is
    //    consumed atomically on success so it can't be reused.
    if (pairingCode) {
        const pending = await userStore.getPendingBindingByPairingCode(pairingCode);
        if (!pending) {
            console.warn(`[ConnectorBootstrap] pairing_code_invalid code=${pairingCode.slice(0, 4)}*** ncInstance=${ncInstanceId}`);
            return res.status(401).json({
                error: 'Pairing code is invalid, expired, or already used',
                code: 'pairing_code_invalid',
                remediation: 'Ask the Bee Flow organisation admin to generate a fresh pairing code from Settings → Organisation → Pair a new Nextcloud, then set it as the BEEFLOW_PAIRING_CODE env var on this connector and reinstall.',
            });
        }
        const targetOrg = await userStore.getOrganization(pending.orgId);
        if (!targetOrg) {
            return res.status(410).json({
                error: 'Organisation for this pairing code no longer exists',
                code: 'pairing_code_org_gone',
            });
        }
        // Refuse to redeem a code against an org that's already bound to a
        // different NC — a misissued code shouldn't be able to steal an
        // existing binding.
        if (targetOrg.nc_instance_id && targetOrg.nc_instance_id !== ncInstanceId) {
            return res.status(409).json({
                error: 'Target organisation is already bound to a different Nextcloud instance',
                code: 'pairing_code_org_already_bound',
            });
        }
        const consumed = await userStore.consumePairingCode(pending.id, {
            ncInstanceId,
            ncBaseUrl,
            ncAdminUid,
            ncAdminEmail,
            ncAdminDisplayName,
            connectorCallbackUrl,
            themingName: nc.themingName,
            ncVersion: nc.ncVersion,
        });
        if (!consumed) {
            // Lost the race against another connector consuming the same code
            // — rare but possible.
            return res.status(409).json({
                error: 'Pairing code was just consumed by another request',
                code: 'pairing_code_race',
            });
        }
        let boundOrg = targetOrg;
        const wasFreshlyBound = !targetOrg.nc_instance_id;
        if (wasFreshlyBound) {
            boundOrg = await bindOrgToNcInstance(targetOrg, {
                ncInstanceId, ncBaseUrl, ncAdminUid, connectorCallbackUrl,
            });
            // Apply default plan only on the first NC binding so we don't
            // overwrite an existing direct-SaaS org's plan when it's adopting
            // an NC tenant for the first time.
            await applyNcDefaultPlanIfConfigured(boundOrg.id, 'pairing_code');
        }
        try {
            await ensureOrgAdminUser(boundOrg, { ncAdminEmail, ncAdminUid, ncAdminDisplayName });
        } catch (e) {
            if (e.statusCode === 409) return res.status(409).json({
                error: e.message,
                code: 'admin_email_conflict',
            });
            throw e;
        }
        const tenantKey = await getOrMintTenantKey(boundOrg.id);
        console.log(`[ConnectorBootstrap] pairing_code_redeemed org=${boundOrg.id} ncInstance=${ncInstanceId}`);
        return res.json({
            tenantKey,
            organizationId: boundOrg.id,
            organizationName: boundOrg.name,
            isNew: false,
            isAdopted: true,
            ncVersion: nc.ncVersion,
            code: 'pairing_code_redeemed',
        });
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

    // 2. Same-domain match → confirm via an emailed one-time code, entered in
    //    the embedded Bee Flow view (no external SaaS login). The code proves
    //    control of a mailbox at the matching domain, which is what stops a
    //    rogue Nextcloud from silently adopting someone else's org.
    //      - Exact email match to an existing user (any domain): always eligible.
    //      - Domain-only match: corporate domains only — a shared free-provider
    //        domain (gmail.com, …) does not imply org control.
    //    No match → fall through to a fresh org (branch 3).
    const emailDomain = ncAdminEmail.split('@')[1] || '';
    let verifyOrg = null;
    const candidate = await userStore.getUserByEmail(ncAdminEmail);
    if (candidate?.organizationId) {
        const candidateOrg = await userStore.getOrganization(candidate.organizationId);
        if (candidateOrg && !candidateOrg.nc_instance_id) verifyOrg = candidateOrg;
    }
    if (!verifyOrg && emailDomain && !FREE_EMAIL_DOMAINS.has(emailDomain)) {
        verifyOrg = await userStore.findUnboundOrgByEmailDomain(emailDomain);
    }
    if (verifyOrg) {
        const activeCount = await userStore.countActivePendingNcVerificationsForOrg(verifyOrg.id);
        if (activeCount >= MAX_VERIFICATIONS_PER_ORG) {
            console.warn(`[ConnectorBootstrap] too_many_verifications org=${verifyOrg.id} ncInstance=${ncInstanceId}`);
            return res.status(429).json({
                error: 'Too many pending Nextcloud connection attempts for this organisation. Try again later.',
                code: 'too_many_pending_bindings',
                remediation: 'Wait for the existing verification codes to expire (15 minutes) and retry from the connector.',
            });
        }
        // Create the pending verification but DON'T email a code here. Bootstrap
        // runs at connector startup with no user context, so `ncAdminEmail` is
        // just the arbitrary first admin. The code is sent to whichever admin
        // actually opens the embedded view (see /retarget), so it reaches the
        // person doing the setup — who also becomes the org admin on success.
        const code = generateVerificationCode();
        const pending = await userStore.createPendingNcVerification({
            orgId: verifyOrg.id,
            ncInstanceId,
            ncBaseUrl,
            ncAdminUid,
            ncAdminEmail,
            ncAdminDisplayName,
            connectorCallbackUrl,
            themingName: nc.themingName,
            ncVersion: nc.ncVersion,
            verificationEmail: ncAdminEmail,
        }, { code });
        console.log(`[ConnectorBootstrap] email_verification_required org=${verifyOrg.id} pendingId=${pending.id} ncInstance=${ncInstanceId} expiresAt=${pending.expiresAt}`);
        return res.status(202).json({
            status: 'pending_verification',
            code: 'email_verification_required',
            pendingId: pending.id,
            verifyUrl: `/auth/connector/bootstrap/pending/${pending.id}/verify`,
            resendUrl: `/auth/connector/bootstrap/pending/${pending.id}/resend`,
            retargetUrl: `/auth/connector/bootstrap/pending/${pending.id}/retarget`,
            expiresAt: pending.expiresAt,
            organizationName: verifyOrg.name,
            message: 'Awaiting in-app verification by a Nextcloud admin.',
        });
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

    await applyNcDefaultPlanIfConfigured(org.id, 'fresh_org');

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
    // Email-verification rows are confirmed via the /verify endpoint, not by
    // polling. Don't expose them here — that would hand the tenant key to anyone
    // holding the id once the code is accepted.
    if (row.hasVerification) return res.status(404).json({ status: 'not_found' });

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

// Submit the emailed verification code. Possession of the code (delivered to a
// mailbox at the matching domain) is the proof of authority; on success we bind
// the org, mint the tenant key and hand it straight back so the connector can
// cache it without a separate poll. Unauthenticated by design — the connector
// has no SaaS creds yet — but attempt-capped (in verifyPendingNcCode) and
// IP-rate-limited.
router.post('/connector/bootstrap/pending/:id/verify', pendingPollLimiter, async (req, res) => {
    const id = String(req.params.id || '').trim();
    const code = String(req.body?.code || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });
    if (!/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: 'Enter the 6-digit code from the email.', code: 'invalid_code' });
    }

    const result = await userStore.verifyPendingNcCode(id, code);
    switch (result.status) {
        case 'not_found': return res.status(404).json({ status: 'not_found', code: 'not_found' });
        case 'not_verification': return res.status(409).json({ error: 'This connection does not use email verification.', code: 'not_verification' });
        case 'denied': return res.status(410).json({ status: 'denied', code: 'denied' });
        case 'expired': return res.status(410).json({ status: 'expired', code: 'expired', remediation: 'The code expired. Request a new one and try again.' });
        case 'too_many': return res.status(429).json({ error: 'Too many incorrect attempts. Request a new code.', code: 'too_many_attempts' });
        case 'invalid': return res.status(400).json({ error: 'That code is not correct.', code: 'invalid_code', attemptsLeft: result.attemptsLeft });
        case 'ok': break;
        default: return res.status(500).json({ error: 'Verification failed' });
    }

    const row = result.row;
    const org = await userStore.getOrganization(row.orgId);
    if (!org) return res.status(410).json({ status: 'expired', code: 'org_gone' });
    if (org.nc_instance_id && org.nc_instance_id !== row.ncInstanceId) {
        return res.status(409).json({ error: 'Organisation is already bound to a different Nextcloud instance', code: 'already_bound' });
    }

    let boundOrg = org;
    if (!org.nc_instance_id) {
        boundOrg = await bindOrgToNcInstance(org, {
            ncInstanceId: row.ncInstanceId,
            ncBaseUrl: row.ncBaseUrl,
            ncAdminUid: row.ncAdminUid,
            connectorCallbackUrl: row.connectorCallbackUrl,
        });
        await applyNcDefaultPlanIfConfigured(boundOrg.id, 'email_verification');
    }
    try {
        await ensureOrgAdminUser(boundOrg, {
            ncAdminEmail: row.ncAdminEmail,
            ncAdminUid: row.ncAdminUid,
            ncAdminDisplayName: row.ncAdminDisplayName,
        });
    } catch (e) {
        if (e.statusCode === 409) return res.status(409).json({ error: e.message, code: 'admin_email_conflict' });
        throw e;
    }
    const tenantKey = await getOrMintTenantKey(boundOrg.id);
    await userStore.markPendingNcBindingApproved(row.id, null);
    console.log(`[ConnectorBootstrap] verification_succeeded org=${boundOrg.id} ncInstance=${row.ncInstanceId}`);
    return res.json({
        tenantKey,
        organizationId: boundOrg.id,
        organizationName: boundOrg.name,
        ncVersion: row.ncVersion,
        isAdopted: true,
        code: 'verified',
    });
});

// Re-send the verification code (new code, attempts reset, TTL extended). Goes
// to the same mailbox the original was sent to, so a held pendingId can't
// redirect the code elsewhere.
router.post('/connector/bootstrap/pending/:id/resend', verificationResendLimiter, async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const code = generateVerificationCode();
    const row = await userStore.resetNcVerificationCode(id, code);
    if (!row) return res.status(410).json({ status: 'expired', code: 'expired' });
    const to = row.verificationEmail || row.ncAdminEmail;
    let emailSent = false;
    try {
        const org = await userStore.getOrganization(row.orgId);
        const r = await sendNcVerificationCodeEmail({ to, code, orgName: org?.name, expiresAt: row.expiresAt });
        emailSent = !!r?.success;
    } catch (e) {
        console.warn(`[ConnectorBootstrap] resend_email_error pendingId=${id} reason=${e.message}`);
    }
    console.log(`[ConnectorBootstrap] verification_resent pendingId=${id} emailSent=${emailSent} expiresAt=${row.expiresAt}`);
    return res.json({ ok: true, maskedEmail: maskEmail(to), expiresAt: row.expiresAt, emailSent });
});

// Re-point a pending verification at the admin who is actually performing the
// setup (the NC user in the embedded view), then email them the code. The
// connector supplies the current user's email/uid; we re-validate that the
// email qualifies for the org before redirecting the code, so a held pendingId
// can't be used to send the code to an unrelated mailbox.
router.post('/connector/bootstrap/pending/:id/retarget', verificationResendLimiter, async (req, res) => {
    const id = String(req.params.id || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const uid = String(req.body?.uid || '').trim();
    const displayName = String(req.body?.displayName || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });
    if (!email.includes('@')) return res.status(400).json({ error: 'A valid email is required', code: 'invalid_email' });

    const row = await userStore.getPendingNcBinding(id);
    if (!row) return res.status(404).json({ status: 'not_found', code: 'not_found' });
    if (!row.hasVerification || row.status !== 'pending') {
        return res.status(409).json({ error: 'No pending verification for this connection', code: 'not_verification' });
    }
    const expired = row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now();
    if (expired) return res.status(410).json({ status: 'expired', code: 'expired' });

    // The target email must itself qualify for the org being linked — exact
    // user match, or a matching corporate domain. Mirrors the bootstrap routing.
    const domain = email.split('@')[1] || '';
    let qualifies = false;
    const exact = await userStore.getUserByEmail(email);
    if (exact?.organizationId === row.orgId) qualifies = true;
    if (!qualifies && domain && !FREE_EMAIL_DOMAINS.has(domain)) {
        const o = await userStore.findUnboundOrgByEmailDomain(domain);
        if (o?.id === row.orgId) qualifies = true;
    }
    if (!qualifies) {
        return res.status(403).json({
            error: 'This Nextcloud account is not part of the Bee Flow organisation this connection is being linked to.',
            code: 'email_not_in_org',
        });
    }

    const code = generateVerificationCode();
    const updated = await userStore.retargetNcVerification(id, { email, uid, displayName, code });
    if (!updated) return res.status(410).json({ status: 'expired', code: 'expired' });

    let emailSent = false;
    try {
        const org = await userStore.getOrganization(row.orgId);
        const r = await sendNcVerificationCodeEmail({ to: email, code, orgName: org?.name, expiresAt: updated.expiresAt });
        emailSent = !!r?.success;
        if (!emailSent) console.warn(`[ConnectorBootstrap] retarget_email_failed pendingId=${id} reason=${r?.error}`);
    } catch (e) {
        console.warn(`[ConnectorBootstrap] retarget_email_error pendingId=${id} reason=${e.message}`);
    }
    console.log(`[ConnectorBootstrap] verification_retargeted pendingId=${id} org=${row.orgId} emailSent=${emailSent}`);
    return res.json({ ok: true, maskedEmail: maskEmail(email), expiresAt: updated.expiresAt, emailSent });
});

// Diagnostic endpoint — connector calls this when /api/license/* keeps
// returning "no matching tenant key" and we need to know why without
// kubectl-ing into the server pod. Authentication is the same NC-ownership
// proof as bootstrap (round-trip the instanceid via /ocs capabilities), so
// possession of a fake header set isn't enough. Returns NO secret material —
// only fingerprints (first 16 hex chars of sha256) so the caller can compare
// against its own locally cached key.
router.post('/connector/diagnose', bootstrapLimiter, async (req, res) => {
    const h = readBootstrapHeaders(req);
    if (!h.ncInstanceId || !h.ncBaseUrl) {
        return res.status(400).json({
            error: 'Missing X-Beeflow-NC-Instance-Id or X-Beeflow-NC-Base-Url header',
        });
    }
    try {
        await verifyNcInstance(h.ncBaseUrl, h.ncInstanceId);
    } catch (e) {
        return res.status(403).json({
            error: 'NC ownership verification failed',
            detail: e.message,
        });
    }

    const out = {
        ncInstanceId: h.ncInstanceId,
        ncBaseUrl: h.ncBaseUrl,
        org: null,
        tenantKey: { exists: false },
    };

    let org;
    try {
        org = await userStore.getOrganizationByNcInstanceId(h.ncInstanceId);
    } catch (e) {
        return res.status(500).json({ ...out, error: 'org lookup failed: ' + e.message });
    }
    if (!org) {
        return res.json({
            ...out,
            note: 'No organization bound to this NC instance — bootstrap has not run, or it failed before persisting the binding.',
        });
    }
    out.org = {
        id: org.id,
        name: org.name,
        ncOnboardingCompletedAt: org.nc_onboarding_completed_at || null,
    };

    const cfgKey = TENANT_KEY_PREFIX + org.id;
    let decrypted = null;
    let decryptError = null;
    try {
        decrypted = await configStore.getSecret(cfgKey);
    } catch (e) {
        decryptError = e.message;
    }
    out.tenantKey.exists = !!decrypted;
    out.tenantKey.decryptOk = !decryptError;
    if (decryptError) out.tenantKey.decryptError = decryptError;
    if (decrypted) {
        out.tenantKey.fingerprint = crypto.createHash('sha256')
            .update(decrypted)
            .digest('hex')
            .slice(0, 16);
    }

    // Look up the raw row's updated_at so the caller can see how stale the
    // stored key is relative to when it last bootstrapped. Direct DB read —
    // configStore has no metadata helper.
    try {
        const { getOne } = require('../db');
        const row = await getOne('SELECT updated_at FROM config WHERE key = $1', [cfgKey]);
        if (row?.updated_at) out.tenantKey.updatedAt = row.updated_at;
    } catch (_) { /* tolerate — informational only */ }

    // If the caller sent a test JWT, try to verify it against the stored
    // key. This is the smoking-gun check: connector says "this is what I'm
    // signing with", SaaS says "and this is what verification gives".
    const testToken = typeof req.body?.testToken === 'string' ? req.body.testToken.trim() : '';
    if (testToken) {
        if (!decrypted) {
            out.tenantKey.testVerify = { ok: false, error: 'no stored key to verify against' };
        } else {
            try {
                const { _verifyHs256 } = require('./connectorJwt');
                const payload = _verifyHs256(testToken, decrypted);
                out.tenantKey.testVerify = {
                    ok: true,
                    sub: payload.sub || null,
                    email: payload.email || null,
                    exp: payload.exp || null,
                };
            } catch (e) {
                out.tenantKey.testVerify = { ok: false, error: e.message };
            }
        }
    }

    return res.json(out);
});

module.exports = router;
module.exports.helpers = {
    NC_INTEGRATIONS,
    PENDING_TTL_SECONDS,
    getOrMintTenantKey,
    ensureOrgAdminUser,
    bindOrgToNcInstance,
};
