const express = require('express');
const path = require('path');
const fs = require('fs');
const agentStore = require('../../stores/agentStore');
const swarmStore = require('../../stores/swarmStore');
const browserAgentStore = require('../../stores/browserAgentStore');
const agentRuntime = require('../../core/agentRuntime');
const browserAgentRuntime = require('../../browser/orchestrator');
const groupChatStore = require('../../stores/groupChatStore');
const groupChatRuntime = require('../../agents/groupChat/runtime');
const terminalAgentStore = require('../../stores/terminalAgentStore');
const terminalAgentRuntime = require('../../terminal/orchestrator');
const containerManager = require('../../terminal/containerManager');
const securityAgentStore = require('../../stores/securityAgentStore');
const securityAgentRuntime = require('../../security/orchestrator');
const securityContainerManager = require('../../security/containerManager');
const { getAIConfig, getProviderForModel } = require('../../core/aiAgent');
const configStore = require('../../stores/configStore');
const { requirePermission } = require('../../auth');
const MemoryStore = require('../../stores/memoryStore');
const { resolveUserOrgIds } = require('../../auth');
const { getEffectiveUserId, getUserAuth } = require('../../utils/routeHelpers');
const { chatCompletion } = require('../../core/llmClient');
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

// Search all conversations
router.get('/conversations/search', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const { q, agentId, startDate, endDate } = req.query;

        if (!q || q.length < 2) {
            return res.json([]);
        }

        const filters = {};
        if (agentId) filters.agentId = agentId;
        if (startDate) filters.startDate = startDate;
        if (endDate) filters.endDate = endDate;

        const conversations = await agentStore.searchConversations(userId, q, filters, req.session?.encryptionKey);
        res.json(conversations);
    } catch (error) {
        console.error('Failed to search conversations:', error);
        res.status(500).json({ error: error.message });
    }
});


module.exports = router;
