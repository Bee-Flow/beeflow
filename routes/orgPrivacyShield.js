/**
 * Organization Privacy Shield API
 * 
 * Lets org admins manage regex guardrails that apply to ALL agents
 * and direct chat within their organization.
 */

const express = require('express');
const router = express.Router();
const configStore = require('../stores/configStore');
const userStore = require('../stores/userStore');
const { resolveUserOrgIds } = require('../auth');

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Check if the current user is an admin for the given org.
 * Super admins (platform role=admin) can manage any org.
 * Org admins = users whose group belongs to the org AND group has admin role/permission.
 */
async function isOrgAdmin(req, orgId) {
    // Platform super admin
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return true;

    const userId = req.session?.user?.id;
    if (!userId) return false;

    const user = await userStore.getUser(userId);
    if (!user) return false;

    // Check user's direct orgRole (set when user creates or is assigned to an org)
    if (user.organizationId === orgId && user.orgRole === 'org_admin') return true;

    let groupIds = [];
    if (Array.isArray(user.groups)) groupIds = user.groups;
    else { try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { } }

    const allGroups = await userStore.getAllGroups();
    for (const gid of groupIds) {
        const group = allGroups.find(g => g.id === gid);
        if (group?.organizationId === orgId) {
            // Check if group has admin role/permission
            const perms = Array.isArray(group.permissions) ? group.permissions : [];
            const roles = Array.isArray(group.roles) ? group.roles : [];
            if (perms.includes('all') || perms.includes('admin') ||
                roles.includes('admin') || roles.includes('org_admin')) {
                return true;
            }
        }
    }
    return false;
}

// GET /:orgId — get shield config
router.get('/:orgId', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.params;
        // Must be member of org or super admin
        const orgIds = await resolveUserOrgIds(req);
        const isMember = orgIds === null || (orgIds && orgIds.has(orgId));
        if (!isMember) return res.status(403).json({ error: 'Not a member of this organization' });

        const config = await configStore.getConfig(`org_privacy_shield_${orgId}`) || {
            enabled: false,
            collectionIds: [],
            scope: { userInput: true, agentOutput: true },
            action: 'delete',
            moderationEnabled: false,
            euModeEnabled: false,
            azurePiiEnabled: false,
            azureSeverityThreshold: 2,
            azureEnabledCategories: ['Hate', 'Violence', 'Sexual', 'SelfHarm'],
            piiDetectionCategories: [],
            piiDetectionConfidenceThreshold: 0.7,
            piiDetectionAction: 'block',
            webSearchGuardPiiCategories: [],
            monitorIntegrations: false,
        };

        // Also pull current global AI config values so the UI stays in sync
        const aiBlob = await configStore.getConfig('ai') || {};
        if (!config.azureSeverityThreshold && config.azureSeverityThreshold !== 0) {
            config.azureSeverityThreshold = aiBlob.azureContentSafetySeverityThreshold ?? 2;
        }
        if (!config.azureEnabledCategories?.length) {
            config.azureEnabledCategories = aiBlob.azureContentSafetyCategories || ['Hate', 'Violence', 'Sexual', 'SelfHarm'];
        }
        if (!config.piiDetectionCategories?.length) {
            config.piiDetectionCategories = aiBlob.piiDetectionCategories || [];
        }
        if (config.piiDetectionConfidenceThreshold === undefined) {
            config.piiDetectionConfidenceThreshold = aiBlob.piiDetectionConfidenceThreshold ?? 0.7;
        }
        if (!config.piiDetectionAction) {
            config.piiDetectionAction = aiBlob.piiDetectionAction || 'block';
        }
        res.json(config);
    } catch (e) {
        console.error('[OrgPrivacyShield] GET error:', e);
        res.status(500).json({ error: e.message });
    }
});

// PUT /:orgId — save shield config (org admin or super admin only)
router.put('/:orgId', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.params;
        if (!(await isOrgAdmin(req, orgId))) {
            return res.status(403).json({ error: 'Only organization admins can manage the privacy shield' });
        }

        const { enabled, collectionIds, scope, action, moderationEnabled, moderationCategories, euModeEnabled, webSearchGuardEnabled, disableSearchOnUpload, azurePiiEnabled, azureSeverityThreshold, azureEnabledCategories, piiDetectionCategories, piiDetectionConfidenceThreshold, piiDetectionAction, webSearchGuardPiiCategories, monitorIntegrations } = req.body;
        const config = {
            enabled: !!enabled,
            collectionIds: Array.isArray(collectionIds) ? collectionIds : [],
            scope: scope || { userInput: true, agentOutput: true },
            action: action === 'redact' ? 'redact' : 'delete',
            moderationEnabled: !!moderationEnabled,
            moderationCategories: Array.isArray(moderationCategories) ? moderationCategories : [],
            euModeEnabled: !!euModeEnabled,
            webSearchGuardEnabled: !!webSearchGuardEnabled,
            disableSearchOnUpload: !!disableSearchOnUpload,
            azurePiiEnabled: !!azurePiiEnabled,
            azureSeverityThreshold: typeof azureSeverityThreshold === 'number' ? azureSeverityThreshold : 2,
            azureEnabledCategories: Array.isArray(azureEnabledCategories) ? azureEnabledCategories : ['Hate', 'Violence', 'Sexual', 'SelfHarm'],
            piiDetectionCategories: Array.isArray(piiDetectionCategories) ? piiDetectionCategories : [],
            piiDetectionConfidenceThreshold: typeof piiDetectionConfidenceThreshold === 'number' ? piiDetectionConfidenceThreshold : 0.7,
            piiDetectionAction: ['block', 'tokenize', 'warn'].includes(piiDetectionAction) ? piiDetectionAction : 'block',
            webSearchGuardPiiCategories: Array.isArray(webSearchGuardPiiCategories) ? webSearchGuardPiiCategories : [],
            monitorIntegrations: !!monitorIntegrations,
            updatedAt: new Date().toISOString(),
            updatedBy: req.session.user.id,
        };

        await configStore.setConfig(`org_privacy_shield_${orgId}`, config);

        // Sync shield settings → global AI config so the runtime uses these values
        const aiBlob = await configStore.getConfig('ai') || {};
        if (azurePiiEnabled !== undefined) aiBlob.piiDetectionEnabled = !!azurePiiEnabled;
        if (typeof azureSeverityThreshold === 'number') aiBlob.azureContentSafetySeverityThreshold = azureSeverityThreshold;
        if (Array.isArray(azureEnabledCategories)) aiBlob.azureContentSafetyCategories = azureEnabledCategories;
        if (Array.isArray(piiDetectionCategories)) aiBlob.piiDetectionCategories = piiDetectionCategories;
        if (typeof piiDetectionConfidenceThreshold === 'number') aiBlob.piiDetectionConfidenceThreshold = piiDetectionConfidenceThreshold;
        if (piiDetectionAction) aiBlob.piiDetectionAction = piiDetectionAction;
        await configStore.setConfig('ai', aiBlob);
        console.log(`[OrgPrivacyShield] Synced shield settings to global AI config`);

        console.log(`[OrgPrivacyShield] Saved config for org ${orgId} by ${req.session.user.id}`);
        res.json({ ok: true, config });
    } catch (e) {
        console.error('[OrgPrivacyShield] PUT error:', e);
        res.status(500).json({ error: e.message });
    }
});


// ═══════════════════════════════════════
//  User-level Privacy Shield (Consumer Accounts)
// ═══════════════════════════════════════

// GET /user/me — get user-level shield config (consumer accounts)
router.get('/user/me', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const config = await configStore.getConfig(`user_privacy_shield_${userId}`) || {
            enabled: false,
            euModeEnabled: false,
            disableSearchOnUpload: false,
        };
        res.json(config);
    } catch (e) {
        console.error('[UserPrivacyShield] GET error:', e);
        res.status(500).json({ error: e.message });
    }
});

// PUT /user/me — save user-level shield config (consumer accounts)
router.put('/user/me', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { enabled, euModeEnabled, disableSearchOnUpload } = req.body;
        const config = {
            enabled: !!enabled,
            euModeEnabled: !!euModeEnabled,
            disableSearchOnUpload: !!disableSearchOnUpload,
            updatedAt: new Date().toISOString(),
            updatedBy: userId,
        };

        await configStore.setConfig(`user_privacy_shield_${userId}`, config);
        console.log(`[UserPrivacyShield] Saved config for user ${userId}`);
        res.json({ ok: true, config });
    } catch (e) {
        console.error('[UserPrivacyShield] PUT error:', e);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
