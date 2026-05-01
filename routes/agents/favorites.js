/**
 * Agent Favorites Routes
 *
 * Per-user favorited agents (DB-backed, replaces client-side localStorage).
 * Mounted before /:id routes so that GET /favorites does not collide with
 * GET /:id.
 */

const express = require('express');
const router = express.Router();
const agentStore = require('../../stores/agentStore');

function requireUser(req, res) {
    const userId = req.session?.user?.id;
    if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return null;
    }
    return userId;
}

// List the current user's favorite agent IDs
router.get('/favorites', async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    try {
        const ids = await agentStore.listAgentFavorites(userId);
        res.json(ids);
    } catch (err) {
        console.error('[agents/favorites] list failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Add favorite (idempotent)
router.put('/:id/favorite', async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    try {
        await agentStore.addAgentFavorite(userId, req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error('[agents/favorites] add failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Remove favorite (idempotent)
router.delete('/:id/favorite', async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    try {
        await agentStore.removeAgentFavorite(userId, req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error('[agents/favorites] remove failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Bulk add — used for one-time client→DB migration of legacy localStorage favorites
router.post('/favorites/bulk', async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const { agentIds } = req.body || {};
    if (!Array.isArray(agentIds)) {
        return res.status(400).json({ error: 'agentIds array required' });
    }
    try {
        for (const id of agentIds) {
            if (typeof id === 'string' && id) {
                try { await agentStore.addAgentFavorite(userId, id); } catch (_) { /* skip invalid */ }
            }
        }
        const ids = await agentStore.listAgentFavorites(userId);
        res.json(ids);
    } catch (err) {
        console.error('[agents/favorites] bulk add failed:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
