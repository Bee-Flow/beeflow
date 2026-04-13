/**
 * GitHub Sync Routes — Configure and trigger sync of agent/skill configs to GitHub
 *
 * All routes require manage_agents permission.
 */

const express = require('express');
const router = express.Router();
const { requirePermission, resolveUserOrgIds } = require('../../auth');
const githubSyncStore = require('../../stores/githubSyncStore');
const githubSyncService = require('../../services/githubSyncService');
const configStore = require('../../stores/configStore');
const { getEffectiveUserId } = require('../../utils/routeHelpers');

// Helper: resolve the user's first org ID
async function getOrgId(req) {
    const orgIds = await resolveUserOrgIds(req);
    if (!orgIds || orgIds.size === 0) return null;
    return Array.from(orgIds)[0];
}

// ─── Status ──────────────────────────────────────────────────────
// Returns current sync configuration + pending change count
router.get('/status', requirePermission('manage_agents'), async (req, res) => {
    try {
        const orgId = await getOrgId(req);
        if (!orgId) return res.status(400).json({ error: 'No organisation found' });

        const config = await githubSyncStore.getOrgSyncConfig(orgId);
        const overview = config ? await githubSyncStore.getSyncOverview(orgId) : null;

        // Check if the configuring user's GitHub is still connected
        const userId = getEffectiveUserId(req);
        const hasGitHub = !!(await configStore.getSecret(`github_token_user_${userId}`));

        res.json({
            configured: !!config,
            githubConnected: hasGitHub,
            config: config || null,
            overview: overview || null,
        });
    } catch (err) {
        console.error('[GitHubSync] Status error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Configure ───────────────────────────────────────────────────
// Set the target GitHub repository and branch for sync
router.post('/configure', requirePermission('manage_agents'), async (req, res) => {
    try {
        const orgId = await getOrgId(req);
        if (!orgId) return res.status(400).json({ error: 'No organisation found' });

        const userId = getEffectiveUserId(req);
        const { repoOwner, repoName, branch, autoSync } = req.body;

        if (!repoOwner || !repoName) {
            return res.status(400).json({ error: 'Repository owner and name are required' });
        }

        // Verify the repo is accessible with the user's token
        const token = await githubSyncService.getToken(userId);
        const repoCheck = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            signal: AbortSignal.timeout(10000),
        });

        if (!repoCheck.ok) {
            return res.status(400).json({
                error: `Cannot access repository ${repoOwner}/${repoName}. Check the repo name and your GitHub permissions.`
            });
        }

        await githubSyncStore.setOrgSyncConfig(orgId, {
            repoOwner,
            repoName,
            branch: branch || 'main',
            autoSync: autoSync === true,
            configuredBy: userId,
        });

        console.log(`[GitHubSync] Configured for org ${orgId}: ${repoOwner}/${repoName} (${branch || 'main'})`);
        res.json({ success: true });
    } catch (err) {
        console.error('[GitHubSync] Configure error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Disconnect ──────────────────────────────────────────────────
router.delete('/configure', requirePermission('manage_agents'), async (req, res) => {
    try {
        const orgId = await getOrgId(req);
        if (!orgId) return res.status(400).json({ error: 'No organisation found' });

        await githubSyncStore.deleteOrgSyncConfig(orgId);
        console.log(`[GitHubSync] Disconnected for org ${orgId}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[GitHubSync] Disconnect error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Push All ────────────────────────────────────────────────────
// Trigger a full sync of all agents and skills to GitHub
router.post('/push', requirePermission('manage_agents'), async (req, res) => {
    try {
        const orgId = await getOrgId(req);
        if (!orgId) return res.status(400).json({ error: 'No organisation found' });

        const userId = getEffectiveUserId(req);
        const results = await githubSyncService.syncAll(orgId, userId);

        res.json({ success: true, results });
    } catch (err) {
        console.error('[GitHubSync] Push error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Push Pending ────────────────────────────────────────────────
// Push only resources that changed since last sync
router.post('/push-pending', requirePermission('manage_agents'), async (req, res) => {
    try {
        const orgId = await getOrgId(req);
        if (!orgId) return res.status(400).json({ error: 'No organisation found' });

        const userId = getEffectiveUserId(req);
        const results = await githubSyncService.syncPending(orgId, userId);

        res.json({ success: true, results });
    } catch (err) {
        console.error('[GitHubSync] Push pending error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Sync Details ────────────────────────────────────────────────
// Get detailed sync state for all resources
router.get('/details', requirePermission('manage_agents'), async (req, res) => {
    try {
        const orgId = await getOrgId(req);
        if (!orgId) return res.status(400).json({ error: 'No organisation found' });

        const states = await githubSyncStore.getAllSyncStates(orgId);
        res.json(states);
    } catch (err) {
        console.error('[GitHubSync] Details error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
