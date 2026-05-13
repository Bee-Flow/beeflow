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

// Reuse the agent visibility gate so list/create endpoints can't be used to
// touch agents the caller has no audience for. Without this, an org-B user
// who knows an org-A agent ID could create orphan conversation rows even
// though the chat-stream endpoint correctly blocks them from sending.
const { canReadAgent } = require('./crud');

async function requireAgentReadAccess(req, res, agent) {
    const userId = getEffectiveUserId(req);
    if (!agent.is_published && !req.session?.user?.id) {
        res.status(401).json({ error: 'Not authenticated' });
        return false;
    }
    if (!(await canReadAgent(agent, userId, req))) {
        res.status(403).json({ error: 'Access denied' });
        return false;
    }
    return true;
}

// ============ Multi-Conversation Management ============

// List all conversations for an agent
router.get('/:id/conversations', async (req, res) => {
    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    if (!(await requireAgentReadAccess(req, res, agent))) return;

    const conversations = await agentStore.listConversations(req.params.id, getEffectiveUserId(req));
    res.json(conversations);
});

// Create a new conversation
router.post('/:id/conversations', async (req, res) => {
    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    if (!(await requireAgentReadAccess(req, res, agent))) return;

    const { title } = req.body;
    const conversation = await agentStore.createConversation(req.params.id, getEffectiveUserId(req), title || 'New Chat');
    res.json(conversation);
});

// Get a specific conversation
router.get('/:id/conversations/:convId', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const conversation = await agentStore.getConversationById(req.params.convId, req.session?.encryptionKey);
    if (!conversation || conversation.user_id !== userId) {
        return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json(conversation);
});

// Update conversation title / pin / labels
router.patch('/:id/conversations/:convId', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const conversation = await agentStore.getConversationById(req.params.convId, req.session?.encryptionKey);

    if (!conversation || conversation.user_id !== userId) {
        return res.status(404).json({ error: 'Conversation not found' });
    }

    const { title, pinned, labels } = req.body;
    if (title !== undefined) {
        await agentStore.updateConversationTitle(req.params.convId, title);
    }
    if (pinned !== undefined) {
        await agentStore.pinConversation(req.params.convId, pinned);
    }
    if (labels !== undefined) {
        await agentStore.setConversationLabels(req.params.convId, labels);
    }
    res.json({ success: true });
});

// Delete a conversation
router.delete('/:id/conversations/:convId', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const conversation = await agentStore.getConversationById(req.params.convId, req.session?.encryptionKey);

    if (!conversation || conversation.user_id !== userId) {
        return res.status(404).json({ error: 'Conversation not found' });
    }

    await agentStore.deleteConversationById(req.params.convId);
    res.json({ success: true });
});

// Update thread titles for a conversation
router.patch('/:id/conversations/:convId/thread-titles', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const conversation = await agentStore.getConversationById(req.params.convId, req.session?.encryptionKey);
    if (!conversation || conversation.user_id !== userId) {
        return res.status(404).json({ error: 'Conversation not found' });
    }

    const { threadTitles } = req.body;
    if (!threadTitles || typeof threadTitles !== 'object') {
        return res.status(400).json({ error: 'Thread titles object required' });
    }

    await agentStore.updateThreadTitles(req.params.convId, threadTitles);
    res.json({ success: true });
});

// Get workspace content for a conversation
router.get('/:id/conversations/:convId/workspace', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const conversation = await agentStore.getConversationById(req.params.convId, req.session?.encryptionKey);
    if (!conversation || conversation.user_id !== userId) {
        return res.status(404).json({ error: 'Conversation not found' });
    }

    // Render-time un-tokenisation — stored content keeps raw tokens so the
    // AI can re-read them via notebook_read; the user-facing API restores
    // them to real values. Mirror of directChat.js workspace GET.
    const { restoreTokens } = require('../../core/azurePiiDetection');
    const _convMap = await require('../../core/dlp/dlpRunner').getConversationTokenMapAsync(req.params.convId);
    res.json({
        content: restoreTokens(conversation.workspace_content || '', _convMap),
        notebookId: conversation.workspace_notebook_id || null,
    });
});

// Update workspace content for a conversation
router.put('/:id/conversations/:convId/workspace', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const conversation = await agentStore.getConversationById(req.params.convId, req.session?.encryptionKey);
    if (!conversation || conversation.user_id !== userId) {
        return res.status(404).json({ error: 'Conversation not found' });
    }

    const { content, notebookId } = req.body;
    await agentStore.updateConversationWorkspace(req.params.convId, content || '', notebookId !== undefined ? notebookId : null);
    res.json({ success: true });
});


module.exports = router;
