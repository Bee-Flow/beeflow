/**
 * Apps API Routes - CRUD for App Marketplace.
 *
 * Apps follow the same publish/audience model as agents and KBs: an app
 * belongs to an organisation and is optionally restricted to specific
 * groups within that organisation. The list and single-read endpoints
 * MUST filter by the caller's org/group membership — without this, a
 * published app from one tenant leaks (incl. its full code) to every
 * other tenant on the deployment.
 */

const express = require('express');
const router = express.Router();
const appStore = require('../stores/appStore');
const userStore = require('../stores/userStore');
const { resolveUserOrgIds, canSeePublished, resolveUserGroups } = require('../auth');

const requireAuth = (req, res, next) => {
    if (!req.session?.user) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
};

// Build the audience entity shape that `canSeePublished` expects, mapping
// the apps schema (`created_by`) to the generic `owner_id` field.
function asAudienceEntity(app) {
    return {
        owner_id: app.created_by,
        organization_id: app.organization_id,
        is_published: app.is_published,
        shared_groups: app.shared_groups,
    };
}

// GET /apps — list apps the current user is allowed to see
router.get('/', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const orgIds = await resolveUserOrgIds(req);
        const userGroups = await resolveUserGroups(userId);
        const apps = await appStore.getPublishedAppsForUser(orgIds, userGroups, userId);
        res.json(apps);
    } catch (err) {
        console.error('[Apps] Error fetching apps:', err);
        res.status(500).json({ error: 'Failed to fetch apps' });
    }
});

// GET /apps/mine — list apps created by current user (drafts included)
router.get('/mine', requireAuth, async (req, res) => {
    try {
        const apps = await appStore.getAppsByUser(req.session.user.id);
        res.json(apps);
    } catch (err) {
        console.error('[Apps] Error fetching user apps:', err);
        res.status(500).json({ error: 'Failed to fetch apps' });
    }
});

// GET /apps/:id — single-app read, audience-gated
router.get('/:id', requireAuth, async (req, res) => {
    try {
        const app = await appStore.getApp(req.params.id);
        if (!app) {
            return res.status(404).json({ error: 'App not found' });
        }
        const userId = req.session.user.id;
        const orgIds = await resolveUserOrgIds(req);
        const userGroups = await resolveUserGroups(userId);
        if (!canSeePublished(asAudienceEntity(app), { userId, orgIds, userGroups })) {
            return res.status(404).json({ error: 'App not found' });
        }
        res.json(app);
    } catch (err) {
        console.error('[Apps] Error fetching app:', err);
        res.status(500).json({ error: 'Failed to fetch app' });
    }
});

// POST /apps — create/publish a new app, scoped to the caller's org
router.post('/', requireAuth, async (req, res) => {
    try {
        const { name, description, code, thumbnail, sharedGroups } = req.body;
        const userId = req.session.user.id;
        const username = req.session.user.username || userId;

        if (!name || !code) {
            return res.status(400).json({ error: 'Name and code are required' });
        }

        // Auto-assign the user's first organization. Apps without an org are
        // only visible to super admins, so the marketplace would feel broken
        // for the creator if we left it null.
        const orgIds = await resolveUserOrgIds(req);
        let assignOrgId = null;
        if (orgIds === null) {
            const user = await userStore.getUser(userId);
            assignOrgId = user?.organizationId || null;
        } else if (orgIds.size > 0) {
            assignOrgId = Array.from(orgIds)[0];
        }

        const app = await appStore.createApp(
            name, description, code, userId, username, thumbnail, true,
            assignOrgId,
            Array.isArray(sharedGroups) ? sharedGroups : []
        );
        console.log(`[Apps] Created app: ${name} by user ${username} in org ${assignOrgId || 'none'}`);
        res.status(201).json(app);
    } catch (err) {
        console.error('[Apps] Error creating app:', err);
        res.status(500).json({ error: 'Failed to create app' });
    }
});

// PUT /apps/:id — update an app (owner only, must stay in same org)
router.put('/:id', requireAuth, async (req, res) => {
    try {
        const { name, description, code, thumbnail, isPublished, sharedGroups } = req.body;
        const appId = req.params.id;
        const userId = req.session.user.id;

        const existing = await appStore.getApp(appId);
        if (!existing) {
            return res.status(404).json({ error: 'App not found' });
        }
        if (existing.created_by !== userId) {
            return res.status(403).json({ error: 'Not authorized to update this app' });
        }

        // Defensive cross-org check: even if the owner moves orgs, they
        // shouldn't be able to keep editing apps that no longer belong to
        // any org they're a member of.
        const orgIds = await resolveUserOrgIds(req);
        if (orgIds !== null && existing.organization_id) {
            if (!(orgIds instanceof Set) || !orgIds.has(existing.organization_id)) {
                return res.status(403).json({ error: 'App belongs to an organisation you are no longer a member of' });
            }
        }

        const success = await appStore.updateApp(
            appId, name, description, code, thumbnail,
            isPublished === undefined ? existing.is_published : isPublished,
            sharedGroups
        );
        if (success) {
            res.json({ success: true });
        } else {
            res.status(500).json({ error: 'Failed to update app' });
        }
    } catch (err) {
        console.error('[Apps] Error updating app:', err);
        res.status(500).json({ error: 'Failed to update app' });
    }
});

// DELETE /apps/:id — delete an app (owner only)
router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const appId = req.params.id;
        const existing = await appStore.getApp(appId);
        if (!existing) {
            return res.status(404).json({ error: 'App not found' });
        }
        if (existing.created_by !== req.session.user.id) {
            return res.status(403).json({ error: 'Not authorized to delete this app' });
        }

        const success = await appStore.deleteApp(appId);
        if (success) {
            console.log(`[Apps] Deleted app: ${appId}`);
            res.json({ success: true });
        } else {
            res.status(500).json({ error: 'Failed to delete app' });
        }
    } catch (err) {
        console.error('[Apps] Error deleting app:', err);
        res.status(500).json({ error: 'Failed to delete app' });
    }
});

module.exports = router;
