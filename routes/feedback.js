/**
 * Feedback API Routes — Submit and query user feedback on AI responses
 */

const express = require('express');
const feedbackStore = require('../stores/feedbackStore');
const { resolveUserOrgIds } = require('../auth');

const router = express.Router();

// POST / — submit feedback
router.post('/', async (req, res) => {
    try {
        const { conversationId, messageId, agentId, rating, comment, source, conversationSnapshot } = req.body;

        if (!rating || !['up', 'down'].includes(rating)) {
            return res.status(400).json({ error: 'rating must be "up" or "down"' });
        }

        const userId = req.session?.user?.id || req.session?.user?.username || null;
        // Resolve org from user's groups
        const orgIds = await resolveUserOrgIds(req);
        const organizationId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;

        const result = await feedbackStore.saveFeedback({
            conversationId,
            messageId,
            agentId,
            userId,
            organizationId,
            rating,
            comment,
            source: source || 'agent',
            conversationSnapshot: conversationSnapshot || null,
        });

        res.json({ ok: true, id: result.id });
    } catch (e) {
        console.error('[Feedback API] POST error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET / — list feedback (admin)
router.get('/', async (req, res) => {
    try {
        const { startDate, endDate, rating, agentId, source, limit } = req.query;
        const data = await feedbackStore.getFeedback(
            { startDate, endDate, rating, agentId, source },
            limit ? parseInt(limit, 10) : 200
        );
        res.json(data);
    } catch (e) {
        console.error('[Feedback API] GET error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /summary — aggregated stats (admin)
router.get('/summary', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const data = await feedbackStore.getFeedbackSummary({ startDate, endDate });
        res.json(data);
    } catch (e) {
        console.error('[Feedback API] summary error:', e);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
