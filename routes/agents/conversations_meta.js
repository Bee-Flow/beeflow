const express = require('express');
const path = require('path');
const fs = require('fs');
const agentStore = require('../../stores/agentStore');
const agentRuntime = require('../../core/agentRuntime');
const { getAIConfig, getProviderForModel } = require('../../core/aiAgent');
const configStore = require('../../stores/configStore');
const { requirePermission } = require('../../auth');
const MemoryStore = require('../../stores/memoryStore');
const { resolveUserOrgIds } = require('../../auth');
const { getEffectiveUserId, getUserAuth } = require('../../utils/routeHelpers');

const userStore = require('../../stores/userStore');
const usageStore = require('../../stores/usageStore');
const { checkSubscriptionLimits: checkSubLimits, checkResourceLimits } = require('../../core/limits');
const { setupSSE, sendSSEError, persistAndTitle, getOrCreateAgentConversation } = require('../../core/sseHelpers');

const router = express.Router();

// ============ All Conversations ============

// Get all conversations for the current user across all agents
router.get('/conversations/all', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const conversations = await agentStore.listAllConversations(userId);
        res.json(conversations);
    } catch (error) {
        console.error('Failed to get all conversations:', error);
        res.status(500).json({ error: error.message });
    }
});

// Search all conversations (agent + direct)
const SEARCH_MAX_LIMIT = 200;
const SEARCH_DEFAULT_LIMIT = 50;
router.get('/conversations/search', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const { q, agentId, startDate, endDate, source } = req.query;

        if (!q || q.length < 2) {
            return res.json([]);
        }

        // If a specific agentId is supplied, gate it on access — otherwise the
        // endpoint can be used to enumerate agents the user can't read.
        if (agentId) {
            const { canReadAgent } = require('./crud');
            const agent = await agentStore.getAgent(agentId);
            if (!agent || !(await canReadAgent(agent, userId, req))) {
                return res.status(404).json({ error: 'Agent not found' });
            }
        }

        const filters = {};
        if (agentId) filters.agentId = agentId;
        if (startDate) filters.startDate = startDate;
        if (endDate) filters.endDate = endDate;

        const encryptionKey = req.session?.encryptionKey;
        const includeAgents = source !== 'direct';
        const includeDirect = source !== 'agent' && !agentId; // direct chats have no agent

        const [agentResults, directResults] = await Promise.all([
            includeAgents ? agentStore.searchConversations(userId, q, filters, encryptionKey) : Promise.resolve([]),
            includeDirect ? agentStore.searchDirectConversations(userId, q, filters, encryptionKey) : Promise.resolve([]),
        ]);

        const tagged = [
            ...agentResults.map(r => ({ ...r, kind: 'agent' })),
            ...directResults,
        ];

        tagged.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

        // Backwards-compatible: still return a plain array (the existing
        // SearchOverlay consumer expects this). Pagination is surfaced via
        // X-Total-Count / X-Has-More headers for new callers.
        const rawLimit = Number.parseInt(req.query.limit, 10);
        const rawOffset = Number.parseInt(req.query.offset, 10);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, SEARCH_MAX_LIMIT) : SEARCH_DEFAULT_LIMIT;
        const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
        const items = tagged.slice(offset, offset + limit);
        res.set('X-Total-Count', String(tagged.length));
        res.set('X-Has-More', String(offset + items.length < tagged.length));
        res.json(items);
    } catch (error) {
        console.error('Failed to search conversations:', error);
        res.status(500).json({ error: error.message });
    }
});


module.exports = router;
