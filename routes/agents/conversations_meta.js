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
router.get('/conversations/search', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const { q, agentId, startDate, endDate, source } = req.query;

        if (!q || q.length < 2) {
            return res.json([]);
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
        res.json(tagged.slice(0, 50));
    } catch (error) {
        console.error('Failed to search conversations:', error);
        res.status(500).json({ error: error.message });
    }
});


module.exports = router;
