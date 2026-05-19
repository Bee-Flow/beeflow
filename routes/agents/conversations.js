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

// Defensive limits applied at the route boundary. These are intentionally
// generous — they exist to stop runaway clients and prevent very large blobs
// from reaching the encrypted store, not to enforce product policy.
const MAX_TITLE_LEN = 500;
const MAX_LABEL_LEN = 64;
const MAX_LABELS = 50;
const MAX_THREAD_TITLES = 200;
const MAX_THREAD_TITLE_LEN = 500;
const MAX_WORKSPACE_BYTES = 10 * 1024 * 1024; // 10 MB

function validateLabels(labels) {
    if (!Array.isArray(labels)) return 'labels must be an array';
    if (labels.length > MAX_LABELS) return `labels: max ${MAX_LABELS}`;
    for (const l of labels) {
        if (typeof l !== 'string') return 'labels must be strings';
        if (l.length > MAX_LABEL_LEN) return `label too long (max ${MAX_LABEL_LEN})`;
    }
    return null;
}
function validateThreadTitles(threadTitles) {
    if (!threadTitles || typeof threadTitles !== 'object' || Array.isArray(threadTitles)) {
        return 'threadTitles must be an object';
    }
    const keys = Object.keys(threadTitles);
    if (keys.length > MAX_THREAD_TITLES) return `threadTitles: max ${MAX_THREAD_TITLES} entries`;
    for (const k of keys) {
        const v = threadTitles[k];
        if (typeof v !== 'string') return 'threadTitles values must be strings';
        if (v.length > MAX_THREAD_TITLE_LEN) return `threadTitle too long (max ${MAX_THREAD_TITLE_LEN})`;
    }
    return null;
}

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
        if (typeof title !== 'string' || title.length > MAX_TITLE_LEN) {
            return res.status(400).json({ error: 'invalid title' });
        }
        await agentStore.updateConversationTitle(req.params.convId, title);
    }
    if (pinned !== undefined) {
        if (typeof pinned !== 'boolean' && typeof pinned !== 'number') {
            return res.status(400).json({ error: 'pinned must be boolean' });
        }
        await agentStore.pinConversation(req.params.convId, pinned);
    }
    if (labels !== undefined) {
        const err = validateLabels(labels);
        if (err) return res.status(400).json({ error: err });
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
    const err = validateThreadTitles(threadTitles);
    if (err) return res.status(400).json({ error: err });

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
    const { restoreTokens } = require('../../core/piiDetection');
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
    if (content !== undefined && content !== null && typeof content !== 'string') {
        return res.status(400).json({ error: 'content must be a string' });
    }
    if (typeof content === 'string' && content.length > MAX_WORKSPACE_BYTES) {
        return res.status(413).json({ error: `content exceeds ${MAX_WORKSPACE_BYTES} bytes` });
    }
    await agentStore.updateConversationWorkspace(req.params.convId, content || '', notebookId !== undefined ? notebookId : null);
    res.json({ success: true });
});


module.exports = router;
