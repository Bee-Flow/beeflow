/**
 * Org-admin endpoints for Nextcloud user/group sync configuration.
 *
 * The org-admin UI (agent-hub/src/components/admin/NextcloudSyncPanel.jsx)
 * calls these to read & update the org-level sync settings, list NC groups,
 * trigger an on-demand full sync, and inspect mirrored users.
 */

const express = require('express');
const router = express.Router();

const userStore = require('../../stores/userStore');
const sync = require('../../services/ncUserGroupSync');
const { requireAuth, requireOrgAdmin } = require('../../auth/permissions');

// All routes require an authenticated org-admin (or global admin) for the
// requested orgId. We resolve org from URL param.
async function checkOrgAdmin(req, res, next) {
    const orgId = req.params.orgId;
    if (!orgId) return res.status(400).json({ error: 'orgId required' });
    const isGlobalAdmin = req.session?.isAdmin || req.session?.user?.role === 'admin';
    const isOrgAdmin = req.session?.user?.organizationId === orgId
        && (req.session?.user?.orgRole === 'org_admin' || req.session?.user?.role === 'org_admin');
    if (!isGlobalAdmin && !isOrgAdmin) {
        return res.status(403).json({ error: 'Org admin access required' });
    }
    const org = await userStore.getOrganization(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    if (!org.nc_instance_id) return res.status(400).json({ error: 'Organization is not bound to a Nextcloud instance' });
    req.org = org;
    next();
}

router.get('/admin/:orgId/nc-sync', requireAuth, checkOrgAdmin, async (req, res) => {
    const o = req.org;
    res.json({
        organizationId: o.id,
        ncInstanceId: o.nc_instance_id,
        ncBaseUrl: o.nc_base_url,
        mode: o.nc_sync_mode || 'mirror_all',
        syncGroups: o.ncSyncGroups || [],
        excludedGroups: o.ncSyncExcludedGroups || [],
        newUserDefaultStatus: o.nc_new_user_default_status || 'active',
        lastSyncAt: o.nc_last_sync_at,
    });
});

router.put('/admin/:orgId/nc-sync', requireAuth, checkOrgAdmin, express.json(), async (req, res) => {
    const updates = {};
    const { mode, syncGroups, excludedGroups, newUserDefaultStatus } = req.body || {};
    if (mode !== undefined) {
        if (!['mirror_all', 'selective_groups', 'manual'].includes(mode)) {
            return res.status(400).json({ error: 'Invalid mode' });
        }
        updates.ncSyncMode = mode;
    }
    if (Array.isArray(syncGroups)) updates.ncSyncGroups = syncGroups;
    if (Array.isArray(excludedGroups)) updates.ncSyncExcludedGroups = excludedGroups;
    if (newUserDefaultStatus !== undefined) {
        if (!['active', 'pending'].includes(newUserDefaultStatus)) {
            return res.status(400).json({ error: 'Invalid newUserDefaultStatus' });
        }
        updates.ncNewUserDefaultStatus = newUserDefaultStatus;
    }
    await userStore.updateOrganization(req.params.orgId, updates);
    res.json({ ok: true });
});

router.post('/admin/:orgId/nc-sync/run', requireAuth, checkOrgAdmin, async (req, res) => {
    try {
        const result = await sync.runFullSync(req.org);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/admin/:orgId/nc-sync/groups', requireAuth, checkOrgAdmin, async (req, res) => {
    try {
        const groups = await sync.listNcGroups(req.org);
        res.json({ groups });
    } catch (e) {
        res.status(502).json({ error: 'Could not reach Nextcloud: ' + e.message });
    }
});

router.get('/admin/:orgId/nc-sync/users', requireAuth, checkOrgAdmin, async (req, res) => {
    const users = await userStore.getAllUsers();
    const orgUsers = users
        .filter(u => u.organizationId === req.params.orgId && u.provider === 'nextcloud_connector')
        .map(u => ({
            id: u.id, email: u.email, displayName: u.displayName,
            ncUid: u.nc_uid, status: u.status, autoProvisioned: u.auto_provisioned,
        }));
    res.json({ users: orgUsers });
});

// Onboarding wizard completion. Single endpoint that persists every choice
// from the 4-step App Store wizard in one transaction, then flips the
// onboarding flag so future loads skip the wizard. Once this returns the
// other NC users in this org are unblocked from auto-provisioning.
router.post('/admin/:orgId/nc-onboarding/complete', requireAuth, checkOrgAdmin, express.json(), async (req, res) => {
    const configStore = require('../../stores/configStore');
    const { syncMode, syncGroups, excludedGroups, newUserDefaultStatus, privacyShield } = req.body || {};

    if (!['mirror_all', 'selective_groups', 'manual'].includes(syncMode)) {
        return res.status(400).json({ error: 'Invalid syncMode' });
    }
    if (!['active', 'pending'].includes(newUserDefaultStatus)) {
        return res.status(400).json({ error: 'Invalid newUserDefaultStatus' });
    }
    if (syncMode === 'selective_groups' && (!Array.isArray(syncGroups) || syncGroups.length === 0)) {
        return res.status(400).json({ error: 'selective_groups mode requires at least one group' });
    }

    try {
        // 1. Sync settings on the org row.
        await userStore.updateOrganization(req.params.orgId, {
            ncSyncMode: syncMode,
            ncSyncGroups: Array.isArray(syncGroups) ? syncGroups : [],
            ncSyncExcludedGroups: Array.isArray(excludedGroups) ? excludedGroups : [],
            ncNewUserDefaultStatus: newUserDefaultStatus,
        });

        // 2. Privacy Shield in configStore (same shape GuardrailsPanel writes).
        const shield = privacyShield || {};
        const existingShield = (await configStore.getConfig(`org_privacy_shield_${req.params.orgId}`)) || {};
        await configStore.setConfig(`org_privacy_shield_${req.params.orgId}`, {
            ...existingShield,
            enabled: shield.enabled !== false,
            scope: existingShield.scope || { userInput: true, agentOutput: true },
            localPiiEnabled: shield.localPiiEnabled !== false,
            azurePiiEnabled: !!existingShield.azurePiiEnabled, // unchanged by wizard
            piiDetectionAction: shield.piiDetectionAction === 'block' ? 'block' : 'tokenize',
            piiDetectionCategories: Array.isArray(shield.piiDetectionCategories) ? shield.piiDetectionCategories : [],
            piiDetectionConfidenceThreshold: typeof existingShield.piiDetectionConfidenceThreshold === 'number'
                ? existingShield.piiDetectionConfidenceThreshold : 0.7,
        });

        // 3. Flip the flag — order matters: settings first so a refresh
        //    after a partial completion can't unblock users with stale config.
        await userStore.updateOrganization(req.params.orgId, {
            ncOnboardingCompletedAt: new Date().toISOString(),
        });

        console.log(`[NcOnboarding] Completed for org ${req.params.orgId} (syncMode=${syncMode}, defaultStatus=${newUserDefaultStatus})`);
        res.json({ ok: true });
    } catch (err) {
        console.error('[NcOnboarding] complete failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Re-export so server/auth/index.js or routes/index.js can mount it under /auth.
module.exports = router;
