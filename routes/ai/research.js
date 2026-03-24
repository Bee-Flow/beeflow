/**
 * Deep Research Routes
 * 
 * Handles: deep research streaming pipeline with depth presets
 *   ⚡ fast     — 3 questions, 1 round, single-pass draft (1-2 min)
 *   📋 normal   — 5 questions, 2 rounds, draft + review   (3-5 min)
 *   🔬 detailed — 8-10 questions, 3 rounds, outline + draft + review (5-15 min)
 */

const express = require('express');
const router = express.Router();
const { runDeepResearch, DEPTH_PRESETS } = require('../../agents/deepResearch');
const agentStore = require('../../stores/agentStore');

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ─── Available depth presets ─────────────────────────────────────────────

router.get('/deep-research/presets', requireAuth, (req, res) => {
    res.json({
        presets: Object.entries(DEPTH_PRESETS).map(([key, preset]) => ({
            key,
            ...preset
        }))
    });
});

// ─── Main deep research endpoint ─────────────────────────────────────────

router.post('/deep-research', requireAuth, async (req, res) => {
    const { query, agentId, conversationId, depth, clarificationAnswers, researchScope } = req.body;
    if (!query) {
        return res.status(400).json({ error: 'Query is required' });
    }

    // Validate depth preset
    const validDepths = ['fast', 'normal', 'detailed'];
    const selectedDepth = validDepths.includes(depth) ? depth : 'normal';

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

        const result = await runDeepResearch(query, {
            depth: selectedDepth,
            model: req.body.model || null,
            userId: req.session.user.id,
            clarificationAnswers: clarificationAnswers || null,
            researchScope: researchScope || null,
        }, sendEvent);

        // Handle clarification response (Phase 1A pause)
        if (result.needsClarification) {
            sendEvent('clarification_needed', {
                questions: result.questions,
                refinedQuery: result.refinedQuery,
                researchScope: result.researchScope
            });
            res.end();
            return;
        }

        // Full report completed
        const report = result.report;

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
                messages.push({ role: 'user', content: query, metadata: { type: 'deep_research_query', depth: selectedDepth } });
                messages.push({
                    role: 'assistant', content: report,
                    metadata: {
                        type: 'deep_research_report',
                        depth: selectedDepth,
                        sources: result.sources,
                        researchMeta: result.metadata
                    }
                });
                await agentStore.updateConversation(conv.id, messages, encKey, userId);

                sendEvent('saved', { conversationId: conv.id });
            } catch (saveErr) {
                console.error('[DeepResearch] Failed to save conversation:', saveErr.message);
            }
        }

        sendEvent('complete', { report, sources: result.sources, metadata: result.metadata });
        res.end();
    } catch (error) {
        console.error('[DeepResearch] Pipeline error:', error);
        sendEvent('error', { error: error.message });
        res.end();
    }
});

module.exports = router;
