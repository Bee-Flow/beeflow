/**
 * Swarms — discovery + (later) custom-swarm CRUD.
 *
 * v1 surface:
 *   GET /api/ai/swarms/available — list swarms the caller may use.
 *
 * v3 will add:
 *   POST   /api/ai/swarms/custom        — create a custom swarm
 *   PUT    /api/ai/swarms/custom/:id    — update
 *   DELETE /api/ai/swarms/custom/:id    — delete
 *
 * The whole router is mounted behind `requireBetaFeature('swarm')` in
 * routes/ai.js so unauthorised users see neither the endpoints nor the
 * sidebar section that consumes them.
 */

const express = require('express');
const router = express.Router();
const { listAvailableSwarms } = require('../../core/swarms/swarmRuntime');

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    return res.status(401).json({ error: 'Authentication required' });
}

router.get('/available', requireAuth, (req, res) => {
    try {
        const swarms = listAvailableSwarms();
        return res.json({ swarms });
    } catch (e) {
        console.error('[Swarms] available list failed:', e);
        return res.status(500).json({ error: 'Failed to list available swarms' });
    }
});

module.exports = router;
