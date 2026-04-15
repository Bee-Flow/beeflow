/**
 * Personal Access Token API Routes
 *
 * Lets users create, list, and revoke PATs for external clients.
 * All routes require session auth (you can't manage PATs via PAT).
 */

const express = require('express');
const router = express.Router();
const patStore = require('../stores/patStore');

function getUserId(req) {
    return req.session?.user?.id || null;
}

function requireSessionAuth(req, res, next) {
    // PAT-authed requests have req.patAuth set — block them from managing PATs
    if (req.patAuth) return res.status(403).json({ error: 'PATs cannot be managed via API token' });
    if (!req.session?.isAuthenticated || !req.session?.user?.id) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    next();
}

// GET /api/pat — list user's tokens (without raw values)
router.get('/', requireSessionAuth, async (req, res) => {
    try {
        const tokens = await patStore.listTokens(getUserId(req));
        res.json({ tokens });
    } catch (err) {
        console.error('[PAT] List error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/pat — create a new token
// Body: { name: string, expiresAt?: ISO string }
router.post('/', requireSessionAuth, async (req, res) => {
    try {
        const { name, expiresAt } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Token name is required' });
        }

        const token = await patStore.createToken(getUserId(req), name.trim(), expiresAt || null);
        // token.token is the raw value — only returned ONCE
        res.status(201).json({ token });
    } catch (err) {
        console.error('[PAT] Create error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/pat/:id — revoke a token
router.delete('/:id', requireSessionAuth, async (req, res) => {
    try {
        await patStore.revokeToken(req.params.id, getUserId(req));
        res.json({ success: true });
    } catch (err) {
        console.error('[PAT] Revoke error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
