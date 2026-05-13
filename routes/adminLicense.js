/**
 * Admin License Routes — direct license issuance from the admin console.
 *
 *   GET    /api/admin/licenses                  — list admin-issued licenses (?organizationId)
 *   POST   /api/admin/licenses/grant            — mint a new license
 *   POST   /api/admin/licenses/:id/revoke       — revoke an existing license
 *   POST   /api/admin/licenses/:id/extend       — change expires_at on a license
 *   POST   /api/admin/licenses/import           — re-import a previously-exported blob
 *   GET    /api/admin/licenses/capabilities     — feature flags for the UI
 *
 * Super-admin only. No org-admin self-grant in v1.
 */

const express = require('express');
const router = express.Router();

const license = require('../license');
const tiers = require('../license/tiers');
const adminIssuance = require('../license/adminIssuance');
const store = require('../license/store');
const { requireAdmin } = require('../auth/permissions');
const userStore = require('../stores/userStore');
const { sendServiceEmail, getServiceEmailConfig } = require('../utils/emailService');

router.use((req, res, next) => {
    if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
    next();
});
router.use(requireAdmin);

function actorId(req) {
    return req.session?.user?.id || null;
}

// ── GET /capabilities ──────────────────────────────────────────────────
router.get('/capabilities', (_req, res) => {
    res.json({
        tiers: tiers.TIER_HIERARCHY.filter(t => t === 'full' ? process.env.ALLOW_ADMIN_FULL_TIER === 'true' : true),
        billingIntervals: ['monthly', 'yearly'],
        tierFeatures: tiers.TIER_FEATURES,
        tierLimits: tiers.TIER_LIMITS,
        fullTierEnabled: process.env.ALLOW_ADMIN_FULL_TIER === 'true',
    });
});

// ── GET / ──────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const { organizationId, includeInactive } = req.query;
        const list = await store.getAdminIssuedLicenses({
            organizationId: organizationId || null,
            includeInactive: includeInactive !== 'false',
        });
        // Decorate with org name for UI display.
        const orgs = await userStore.getAllOrganizations();
        const orgsById = new Map((orgs || []).map(o => [o.id, o]));
        const licenses = list.map(l => ({
            ...adminIssuance.publicLicenseShape(l),
            organizationName: orgsById.get(l.organizationId)?.name || null,
            // Include the original blob so the UI can offer "Copy blob" on any row.
            blob: l.rawToken && l.rawToken.startsWith(adminIssuance.BLOB_PREFIX) ? l.rawToken : null,
        }));
        res.json({ licenses });
    } catch (e) {
        console.error('[Admin License] list error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ── POST /grant ────────────────────────────────────────────────────────
router.post('/grant', async (req, res) => {
    try {
        const {
            organizationId, tier, expiresAt,
            billingInterval, featuresOverride, limitsOverride,
            maxSeats, notes, deliverEmail,
        } = req.body || {};
        const result = await adminIssuance.issueAdminLicense({
            scope: 'organization',
            organizationId,
            tier,
            expiresAt,
            billingInterval: billingInterval || 'yearly',
            featuresOverride: featuresOverride || null,
            limitsOverride: limitsOverride || null,
            maxSeats: maxSeats != null ? maxSeats : null,
            notes: notes || null,
            activatedBy: actorId(req),
        });

        // Optional: email the blob straight to the customer. Failure here
        // is non-fatal — the admin still gets the blob in the response and
        // can deliver it manually.
        if (deliverEmail && typeof deliverEmail === 'string' && deliverEmail.includes('@')) {
            const delivery = await deliverBlobByEmail({
                to: deliverEmail.trim(),
                tier,
                expiresAt: result.license.expiresAt,
                organizationId,
                blob: result.blob,
            }).catch(e => ({ success: false, error: e.message }));
            result.emailDelivery = delivery;
        }

        res.json(result);
    } catch (e) {
        console.error('[Admin License] grant error:', e);
        res.status(400).json({ error: e.message });
    }
});

async function deliverBlobByEmail({ to, tier, expiresAt, organizationId, blob }) {
    const cfg = await getServiceEmailConfig();
    if (!cfg.configured) {
        return { success: false, error: 'service_email_not_configured' };
    }
    const tierLabel = tier ? tier[0].toUpperCase() + tier.slice(1) : 'Pro';
    const expiry = expiresAt ? new Date(expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : 'n/a';
    const subject = `Your Bee Flow ${tierLabel} license key`;
    const text = [
        `Hi,`,
        ``,
        `Your Bee Flow ${tierLabel} license is ready.`,
        ``,
        `Expires: ${expiry}`,
        organizationId ? `Organization: ${organizationId}` : null,
        ``,
        `Paste the block below into Settings → Organisation → License → "Enter license key".`,
        ``,
        blob,
        ``,
        `Keep this email — the same key can be re-imported on a new install if needed.`,
        ``,
        `— Bee Flow`,
    ].filter(Boolean).join('\n');
    const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;line-height:1.55;max-width:560px;margin:24px auto;padding:0 16px">
        <h2 style="margin:0 0 12px">Your Bee Flow ${tierLabel} license</h2>
        <p>Expires: <strong>${expiry}</strong>${organizationId ? `<br/>Organization: <code>${organizationId}</code>` : ''}</p>
        <p>Paste the block below into <em>Settings → Organisation → License → "Enter license key"</em>.</p>
        <pre style="background:#f4f4f5;border:1px solid #e4e4e7;border-radius:8px;padding:12px;word-break:break-all;white-space:pre-wrap;font-size:12px">${blob}</pre>
        <p style="font-size:12px;color:#666">Keep this email — the same key can be re-imported on a new install if needed.</p>
    </body></html>`;
    return sendServiceEmail({ to, subject, text, html });
}

// ── POST /:id/revoke ───────────────────────────────────────────────────
router.post('/:id/revoke', async (req, res) => {
    try {
        const { reason } = req.body || {};
        const lic = await store.getLicenseById(req.params.id);
        if (!lic) return res.status(404).json({ error: 'License not found' });
        if (!adminIssuance.isAdminIssuedLicense(lic)) {
            return res.status(400).json({ error: 'Only admin-issued licenses can be revoked here' });
        }
        await store.markRevoked(req.params.id, reason || `revoked_by:${actorId(req) || 'admin'}`);
        const fresh = await store.getLicenseById(req.params.id);
        res.json({ license: adminIssuance.publicLicenseShape(fresh) });
    } catch (e) {
        console.error('[Admin License] revoke error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ── POST /:id/extend ───────────────────────────────────────────────────
router.post('/:id/extend', async (req, res) => {
    try {
        const { expiresAt } = req.body || {};
        if (!expiresAt) return res.status(400).json({ error: 'expiresAt required' });
        const lic = await store.getLicenseById(req.params.id);
        if (!lic) return res.status(404).json({ error: 'License not found' });
        if (!adminIssuance.isAdminIssuedLicense(lic)) {
            return res.status(400).json({ error: 'Only admin-issued licenses can be extended here' });
        }
        const d = new Date(expiresAt);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid expiresAt' });
        const updated = await store.extendExpiry(req.params.id, d.toISOString(), actorId(req));
        res.json({ license: adminIssuance.publicLicenseShape(updated) });
    } catch (e) {
        console.error('[Admin License] extend error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ── POST /import ───────────────────────────────────────────────────────
router.post('/import', async (req, res) => {
    try {
        const { blob, organizationId } = req.body || {};
        if (!blob) return res.status(400).json({ error: 'blob required' });
        const result = await adminIssuance.importAdminLicense(blob, {
            activatedBy: actorId(req),
            organizationId: organizationId || null,
        });
        res.json(result);
    } catch (e) {
        console.error('[Admin License] import error:', e);
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;
