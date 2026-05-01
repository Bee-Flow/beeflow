/**
 * Gamma Integration Routes
 *
 * Small authenticated helpers for frontend previews. Generation itself still
 * happens through the AI tool dispatcher; this route only lets the UI poll
 * a known generationId without exposing the user's Gamma API key.
 */

const express = require('express');
const { executeGammaTool } = require('../../integrations/gammaTools');

const router = express.Router();

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

router.get('/generations/:generationId', requireAuth, async (req, res) => {
    try {
        const result = await executeGammaTool(
            'gamma_get_generation_status',
            { generationId: req.params.generationId },
            req.session.user.id,
        );

        if (result?.error) {
            return res.status(502).json(result);
        }

        res.json(result);
    } catch (err) {
        console.error('[GammaRoutes] Status error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
