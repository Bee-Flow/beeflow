/**
 * Deep Research Routes
 * 
 * Handles: deep research streaming pipeline
 */

const express = require('express');
const router = express.Router();
const { runDeepResearch } = require('../../agents/swarm/deepResearch');
const agentStore = require('../../stores/agentStore');

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

router.post('/deep-research', requireAuth, async (req, res) => {
    const { query, agentId, conversationId } = req.body;
    if (!query) {
        return res.status(400).json({ error: 'Query is required' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (type, data) => {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        // Validate research query with Llama Guard
        try {
            const { validateWithLlamaGuard } = require('../../core/moderation');
            await validateWithLlamaGuard([{ role: 'user', content: query }], true);
        } catch (guardErr) {
            if (guardErr.message?.includes('Safety Violation')) {
                console.warn(`[DeepResearch] Query BLOCKED by moderation: ${guardErr.message}`);
                return res.status(403).json({ error: 'Research query blocked by content safety. Please rephrase.' });
            }
            // Guard service unavailable — fail-open
        }

        const report = await runDeepResearch(query, { model: req.body.model || null }, sendEvent);

        if (agentId) {
            try {
                const userId = req.session.user.id;
                const encKey = req.session?.encryptionKey;

                let conv;
                if (conversationId) {
                    conv = await agentStore.getConversationById(conversationId, encKey);
                }
                if (!conv) {
                    conv = await agentStore.getOrCreateConversation(agentId, userId, encKey);
                }

                const messages = conv.messages || [];
                messages.push({ role: 'user', content: query, metadata: { type: 'deep_research_query' } });
                messages.push({ role: 'assistant', content: report, metadata: { type: 'deep_research_report' } });
                await agentStore.updateConversation(conv.id, messages, encKey, userId);

                sendEvent('saved', { conversationId: conv.id });
            } catch (saveErr) {
                console.error('[DeepResearch] Failed to save conversation:', saveErr.message);
            }
        }

        sendEvent('complete', { report });
        res.end();
    } catch (error) {
        console.error('[DeepResearch] Pipeline error:', error);
        sendEvent('error', { error: error.message });
        res.end();
    }
});

module.exports = router;
