/**
 * Feedback API Routes — Submit and query user feedback on AI responses
 */

const express = require('express');
const feedbackStore = require('../stores/feedbackStore');
const { resolveUserOrgIds } = require('../auth');
const { getAll } = require('../db');

const router = express.Router();

// Best-effort lookup of the concrete model + agent_name used for the most
// recent assistant call in this conversation. Lets us surface the actual
// resolved model in the feedback UI when the agent is configured with a
// tier (e.g. tier:auto). Returns { model, agent_name } or {}.
async function lookupConversationContext(conversationId) {
    if (!conversationId) return {};
    try {
        const rows = await getAll(
            `SELECT model, agent_name FROM ai_usage_log
             WHERE conversation_id = $1 AND tool_name IS NULL
             ORDER BY timestamp DESC LIMIT 1`,
            [conversationId]
        );
        return rows?.[0] || {};
    } catch (_) { return {}; }
}

// POST / — submit feedback
router.post('/', async (req, res) => {
    try {
        const {
            conversationId, messageId, agentId, agentName,
            model, modelTier,
            rating, comment, source, conversationSnapshot,
        } = req.body;

        if (!rating || !['up', 'down'].includes(rating)) {
            return res.status(400).json({ error: 'rating must be "up" or "down"' });
        }

        const userId = req.session?.user?.id || req.session?.user?.username || null;
        // Resolve org from user's groups
        const orgIds = await resolveUserOrgIds(req);
        const organizationId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;

        // Backfill: when the frontend doesn't know the concrete model that
        // served the message (typical for tier:auto), look it up from the
        // most recent assistant call on this conversation. agent_name is
        // also pulled from there if the client didn't send it.
        let resolvedModel = model || null;
        let resolvedAgentName = agentName || null;
        if (!resolvedModel || !resolvedAgentName) {
            const ctx = await lookupConversationContext(conversationId);
            if (!resolvedModel) resolvedModel = ctx.model || null;
            if (!resolvedAgentName) resolvedAgentName = ctx.agent_name || null;
        }

        const result = await feedbackStore.saveFeedback({
            conversationId,
            messageId,
            agentId,
            agentName: resolvedAgentName,
            model: resolvedModel,
            modelTier: modelTier || null,
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
