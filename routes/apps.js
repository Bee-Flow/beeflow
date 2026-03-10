/**
 * Apps API Routes - CRUD for App Marketplace
 */

const express = require('express');
const router = express.Router();
const appStore = require('../stores/appStore');

// Authentication middleware
const requireAuth = (req, res, next) => {
    if (!req.session?.user) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
};

// GET /apps - List all published apps
router.get('/', async (req, res) => {
    try {
        const apps = appStore.getPublishedApps();
        res.json(apps);
    } catch (err) {
        console.error('[Apps] Error fetching apps:', err);
        res.status(500).json({ error: 'Failed to fetch apps' });
    }
});

// GET /apps/mine - List apps created by current user
router.get('/mine', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const apps = appStore.getAppsByUser(userId);
        res.json(apps);
    } catch (err) {
        console.error('[Apps] Error fetching user apps:', err);
        res.status(500).json({ error: 'Failed to fetch apps' });
    }
});

// GET /apps/:id - Get a single app
router.get('/:id', async (req, res) => {
    try {
        const app = appStore.getApp(req.params.id);
        if (!app) {
            return res.status(404).json({ error: 'App not found' });
        }
        res.json(app);
    } catch (err) {
        console.error('[Apps] Error fetching app:', err);
        res.status(500).json({ error: 'Failed to fetch app' });
    }
});

// POST /apps - Create/publish a new app
router.post('/', requireAuth, async (req, res) => {
    try {
        const { name, description, code, thumbnail } = req.body;
        const userId = req.session.user.id;
        const username = req.session.user.username || userId;

        if (!name || !code) {
            return res.status(400).json({ error: 'Name and code are required' });
        }

        const app = appStore.createApp(name, description, code, userId, username, thumbnail);
        console.log(`[Apps] Created app: ${name} by user ${username}`);
        res.status(201).json(app);
    } catch (err) {
        console.error('[Apps] Error creating app:', err);
        res.status(500).json({ error: 'Failed to create app' });
    }
});

// PUT /apps/:id - Update an app
router.put('/:id', requireAuth, async (req, res) => {
    try {
        const { name, description, code, thumbnail, isPublished } = req.body;
        const appId = req.params.id;

        // Verify ownership
        const existing = appStore.getApp(appId);
        if (!existing) {
            return res.status(404).json({ error: 'App not found' });
        }
        if (existing.created_by !== req.session.user.id) {
            return res.status(403).json({ error: 'Not authorized to update this app' });
        }

        const success = appStore.updateApp(appId, name, description, code, thumbnail, isPublished);
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

// DELETE /apps/:id - Delete an app
router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const appId = req.params.id;

        // Verify ownership
        const existing = appStore.getApp(appId);
        if (!existing) {
            return res.status(404).json({ error: 'App not found' });
        }
        if (existing.created_by !== req.session.user.id) {
            return res.status(403).json({ error: 'Not authorized to delete this app' });
        }

        const success = appStore.deleteApp(appId);
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
