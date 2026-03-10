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

// ============ Chat ============

// Chat with agent
router.post('/:id/chat', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const { message } = req.body;
    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    // Allow access if published or if user is owner
    if (!agent.is_published && agent.owner_id !== userId) {
        return res.status(403).json({ error: 'Access denied' });
    }

    try {
        const userAuth = getUserAuth(req);
        const result = await agentRuntime.chatWithAgent(
            req.params.id,
            req.session.user.id,
            message,
            userAuth
        );
        res.json(result);
    } catch (error) {
        console.error('Agent chat error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ Embeddable Chat Widget ============

// Get agent metadata for embed widget (no auth required — public endpoint)
router.get('/:id/embed', async (req, res) => {
    const agent = await agentStore.getAgent(req.params.id);
    const swarm = !agent ? await swarmStore.getSwarm(req.params.id) : null;

    if (!agent && !swarm) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    // For regular agents: must be published AND embed_enabled
    if (agent) {
        if (!agent.is_published || !agent.embed_enabled) {
            return res.status(403).json({ error: 'This agent is not available for embedding' });
        }

        // Parse starter_prompts
        let starterPrompts = [];
        try {
            starterPrompts = typeof agent.starter_prompts === 'string'
                ? JSON.parse(agent.starter_prompts)
                : (agent.starter_prompts || []);
        } catch (e) { }

        return res.json({
            id: agent.id,
            name: agent.name,
            description: agent.description,
            avatar: agent.avatar,
            starterPrompts: starterPrompts.filter(p => p && p.trim()),
            copyEnabled: agent.copy_enabled !== 0,
            isSwarm: false
        });
    }

    // For swarm agents: must be enabled
    if (!swarm.enabled) {
        return res.status(403).json({ error: 'This agent is not available for embedding' });
    }

    res.json({
        id: swarm.id,
        name: swarm.name,
        description: swarm.description,
        avatar: null,
        starterPrompts: [],
        copyEnabled: true,
        isSwarm: true
    });
});

// Download file from terminal agent workspace
router.get('/:id/files/download', async (req, res) => {
    const agentId = req.params.id;
    const terminalAgent = await terminalAgentStore.getTerminalAgent(agentId);
    if (!terminalAgent) {
        return res.status(404).json({ error: 'Terminal agent not found' });
    }

    const filePath = req.query.path;
    if (!filePath) {
        return res.status(400).json({ error: 'File path query parameter is required' });
    }

    // Security: disallow path traversal
    if (filePath.includes('..')) {
        return res.status(403).json({ error: 'Access denied: path traversal not allowed' });
    }

    // Use conversationId (from query) or agentId as container key
    const containerKey = req.query.conversationId || agentId;

    try {
        // Copy file from container to a temp location on the host
        const containerPath = filePath.startsWith('/') ? filePath : `/workspace/${filePath}`;
        const tmpDir = path.join(__dirname, '..', 'data', 'tmp-downloads');
        const tmpFile = path.join(tmpDir, `${Date.now()}-${path.basename(filePath)}`);
        containerManager.copyFromContainer(containerKey, containerPath, tmpFile);

        const filename = path.basename(filePath);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.sendFile(path.resolve(tmpFile), (err) => {
            // Clean up temp file after sending
            try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
        });
    } catch (err) {
        res.status(404).json({ error: `File not found or container unavailable: ${err.message}` });
    }
});

// List files in terminal agent workspace (inside container)
router.get('/:id/files', async (req, res) => {
    const agentId = req.params.id;
    const terminalAgent = await terminalAgentStore.getTerminalAgent(agentId);
    if (!terminalAgent) {
        return res.status(404).json({ error: 'Terminal agent not found' });
    }

    const containerKey = req.query.conversationId || agentId;

    try {
        const filePaths = await containerManager.listFilesInContainer(containerKey);
        const files = filePaths.map(fp => ({
            name: path.basename(fp),
            path: fp.startsWith('/workspace/') ? fp.substring(11) : fp,
            size: 0
        }));
        res.json({ files, workingDirectory: '/workspace (container)' });
    } catch (err) {
        // Container might not exist yet
        res.json({ files: [], workingDirectory: '/workspace (no container)' });
    }
});

// ── Subscription limit enforcement (uses shared module) ──────────────────────
const checkSubscriptionLimits = checkSubLimits;

// Streaming chat with agent (SSE)
router.post('/:id/chat/stream', async (req, res) => {
    // Check group chat store FIRST — ensurePlaceholderAgent creates a stub in agentStore
    // that would otherwise shadow the real group chat
    const groupChat = await groupChatStore.getGroupChat(req.params.id);
    // Check terminal agent store
    const terminalAgent = !groupChat ? await terminalAgentStore.getTerminalAgent(req.params.id) : null;
    // Check security agent store
    const securityAgent = (!groupChat && !terminalAgent) ? await securityAgentStore.getSecurityAgent(req.params.id) : null;
    // Check browser agent store (before agentStore, because ensurePlaceholderAgent
    // creates a stub in agentStore that would otherwise shadow the real browser agent)
    const browserAgent = (!groupChat && !terminalAgent && !securityAgent) ? await browserAgentStore.getBrowserAgent(req.params.id) : null;
    const agent = (!groupChat && !terminalAgent && !securityAgent && !browserAgent) ? await agentStore.getAgent(req.params.id) : null;
    const swarm = (!groupChat && !terminalAgent && !securityAgent && !browserAgent && !agent) ? await swarmStore.getSwarm(req.params.id) : null;

    // ── Group chat handling ──────────────────────────────────────
    if (groupChat) {
        const { message, history, messageId, parentId, attachments, conversationId, ephemeral } = req.body;
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const userId = getEffectiveUserId(req);

        // ── Subscription limit enforcement ──
        const gcOrgIds = await resolveUserOrgIds(req);
        const gcOrgId = gcOrgIds && gcOrgIds.size > 0 ? Array.from(gcOrgIds)[0] : null;
        const gcLimitError = checkSubLimits(gcOrgId, 'chat');
        if (gcLimitError) {
            sendSSEError(res, gcLimitError);
            return;
        }

        // Set up SSE
        const { sendEvent, abortController, markEnded } = setupSSE(res);

        try {
            const userAuth = getUserAuth(req);
            const result = await groupChatRuntime.executeGroupChat(
                req.params.id,
                userId,
                message,
                userAuth,
                (type, data) => sendEvent(type, data),
                { conversationId, messageId, parentId, signal: abortController.signal }
            );

            sendEvent('done', {
                conversationId: result.conversationId,
                conversationLength: result.conversationLength,
                isRoundtable: true
            });

            // Generate title for new conversations
            if (result.conversationLength <= 3) {
                try {
                    const title = await agentRuntime.generateChatTitle(message, null, orgId);
                    if (title && title !== 'New Chat') {
                        await agentStore.updateConversationTitle(result.conversationId, title);
                        sendEvent('title_update', { title, conversationId: result.conversationId });
                    }
                } catch (e) { /* ignore title gen errors */ }
            }

            markEnded();
            res.end();
        } catch (error) {
            console.error('[GroupChat] Stream error:', error);
            sendEvent('error', { message: error.message });
            markEnded();
            res.end();
        }
        return;
    }

    if (!agent && !swarm && !browserAgent && !terminalAgent && !securityAgent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    // Swarm agents are always published/available; for regular agents check auth
    if (agent) {
        if (!agent.is_published && !req.session?.user?.id) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const userId = getEffectiveUserId(req);
        if (!agent.is_published && agent.owner_id !== userId) {
            return res.status(403).json({ error: 'Access denied' });
        }
    }

    const { message, history, messageId, parentId, attachments, conversationId, ephemeral } = req.body;
    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    const userId = getEffectiveUserId(req);

    // ── Subscription limit enforcement ──
    const orgIds = await resolveUserOrgIds(req);
    const orgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
    const agentType = securityAgent ? 'security' : terminalAgent ? 'terminal' : browserAgent ? 'browser' : swarm ? 'swarm' : 'chat';
    const limitError = checkSubscriptionLimits(orgId, agentType);
    if (limitError) {
        sendSSEError(res, limitError);
        return;
    }

    // Set up SSE
    const { sendEvent, abortController, markEnded } = setupSSE(res);

    try {
        const userAuth = getUserAuth(req);

        // Security Agent — delegate to security agent runtime
        if (securityAgent) {
            sendEvent('terminal_status', { status: 'starting', message: 'Starting security scanner...' });

            const conversation = await getOrCreateAgentConversation(securityAgent, conversationId, userId, userAuth.encryptionKey);

            const messages = [...(conversation.messages || [])];
            messages.push({ id: messageId, role: 'user', content: message, parentId: parentId || null });

            const result = await securityAgentRuntime.executeSecurityTask(
                req.params.id,
                message,
                userAuth,
                (type, data) => sendEvent(type, data),
                abortController.signal,
                conversation.messages || [],
                { conversationId: conversation.id }
            );

            messages.push({ role: 'assistant', content: result.result });
            await persistAndTitle({
                conversation, messages,
                encryptionKey: userAuth.encryptionKey,
                userId: userAuth.userId,
                userMessage: message,
                orgId,
                sendEvent,
                generateTitle: agentRuntime.generateChatTitle,
            });

            sendEvent('done', {
                message: result.result,
                conversationId: conversation.id,
                conversationLength: messages.length,
                actionsExecuted: result.actionsExecuted
            });

            markEnded();
            res.end();
            return;
        }

        // Terminal Agent — delegate to terminal agent runtime
        if (terminalAgent) {
            sendEvent('terminal_status', { status: 'starting', message: 'Starting terminal agent...' });

            const conversation = await getOrCreateAgentConversation(terminalAgent, conversationId, userId, userAuth.encryptionKey);

            const messages = [...(conversation.messages || [])];
            messages.push({ id: messageId, role: 'user', content: message, parentId: parentId || null });

            const result = await terminalAgentRuntime.executeTerminalTask(
                req.params.id,
                message,
                userAuth,
                (type, data) => sendEvent(type, data),
                abortController.signal,
                conversation.messages || [],
                { conversationId: conversation.id }
            );

            messages.push({ role: 'assistant', content: result.result });
            await persistAndTitle({
                conversation, messages,
                encryptionKey: userAuth.encryptionKey,
                userId: userAuth.userId,
                userMessage: message,
                orgId,
                sendEvent,
                generateTitle: agentRuntime.generateChatTitle,
            });

            sendEvent('done', {
                message: result.result,
                conversationId: conversation.id,
                conversationLength: messages.length,
                actionsExecuted: result.actionsExecuted
            });

            markEnded();
            res.end();
            return;
        }

        // Browser Agent — delegate to browser agent runtime
        if (browserAgent) {
            sendEvent('browser_status', { status: 'starting', message: 'Starting browser agent...' });

            const conversation = await getOrCreateAgentConversation(browserAgent, conversationId, userId, userAuth.encryptionKey);

            const messages = [...(conversation.messages || [])];
            messages.push({ id: messageId, role: 'user', content: message, parentId: parentId || null });

            const result = await browserAgentRuntime.executeBrowserTask(
                req.params.id,
                message,
                userAuth,
                (type, data) => sendEvent(type, data),
                abortController.signal
            );

            messages.push({ role: 'assistant', content: result.result });
            await persistAndTitle({
                conversation, messages,
                encryptionKey: userAuth.encryptionKey,
                userId: userAuth.userId,
                userMessage: message,
                orgId,
                sendEvent,
                generateTitle: agentRuntime.generateChatTitle,
            });

            sendEvent('done', {
                message: result.result,
                conversationId: conversation.id,
                conversationLength: messages.length,
                actionsExecuted: result.actionsExecuted
            });
            markEnded();
            res.end();
            return;
        }

        const result = await agentRuntime.chatWithAgentStream(
            req.params.id,
            userId,
            message,
            userAuth,
            // Callback for streaming events
            (type, data) => {
                sendEvent(type, data);
            },
            // Custom history override for thread context isolation
            history,
            // Message metadata for persistence (id, parentId, attachments, and conversationId)
            { messageId, parentId, attachments, conversationId, ephemeral, workspaceContent: req.body.workspaceContent, workspaceSelection: req.body.workspaceSelection, signal: abortController.signal, userOrgId: userAuth.userOrgId, timezone: req.body.timezone, projectId: req.body.projectId }
        );

        // Skip all post-stream persistence for ephemeral embed chats
        if (!ephemeral) {
            const conv = await agentStore.getConversationById(result.conversationId, req.session?.encryptionKey);

            // Generate/update title:
            // 1. If it's still "New Chat" (and we have at least 1 exchange), generate it immediately.
            //    This handles cases where tool calls might make the length > 2 on the first turn.
            // 2. Otherwise update at specific intervals (6, 10, 20) to refine context.
            const isNewChat = !conv?.title || conv.title === 'New Chat';
            const isUpdateInterval = [6, 10, 20].includes(result.conversationLength);

            const shouldUpdateTitle = !result.guardrailViolation && ((isNewChat && result.conversationLength >= 2) || isUpdateInterval);

            console.log('[Title Gen] Conv length:', result.conversationLength, 'shouldUpdate:', shouldUpdateTitle, 'isNew:', isNewChat);

            if (conv && shouldUpdateTitle) {
                // Get all user messages for better context
                const userMessages = conv.messages
                    .filter(m => m.role === 'user')
                    .map(m => {
                        if (typeof m.content === 'string') return m.content;
                        if (Array.isArray(m.content)) {
                            return m.content
                                .filter(c => c.type === 'text')
                                .map(c => c.text)
                                .join(' ');
                        }
                        return '';
                    })
                    .filter(Boolean)
                    .join(' | ');

                console.log('[Title Gen] Triggering title generation with context:', userMessages.slice(0, 100));
                // Use the System Agent's configured model (default behavior)
                try {
                    const title = await agentRuntime.generateChatTitle(userMessages, null, orgId);
                    console.log('[Title Gen] Generated title:', title);
                    if (title && title !== 'New Chat') {
                        await agentStore.updateConversationTitle(result.conversationId, title);
                        console.log('[Title Gen] Updated conversation:', result.conversationId);

                        // Optional: Send specific event for title update if we wanted to be fancy, 
                        // but waiting for 'done' is sufficient since frontend refetches context.
                        sendEvent('title_generated', { title });
                    }
                } catch (err) {
                    console.error('[Title Gen] Error:', err);
                }
            }
        }

        // Send final result
        sendEvent('done', result);
        markEnded();
        res.end();
    } catch (error) {
        if (error.name === 'AbortError' || abortController.signal.aborted) {
            console.log('[agents] Agent execution aborted by client');
        } else {
            console.error('Agent streaming chat error:', error);
            sendEvent('error', { error: error.message });
        }
        if (!res.writableEnded) {
            markEnded();
            res.end();
        }
    }
});

// Generate thread title
router.post('/thread/title', async (req, res) => {
    const { content } = req.body;
    if (!content) {
        return res.status(400).json({ error: 'Content is required' });
    }

    try {
        const threadOrgIds = await resolveUserOrgIds(req);
        const threadOrgId = threadOrgIds && threadOrgIds.size > 0 ? Array.from(threadOrgIds)[0] : null;
        const title = await agentRuntime.generateChatTitle(content, null, threadOrgId);
        res.json({ title });
    } catch (error) {
        console.error('Thread title generation error:', error);
        res.status(500).json({ error: 'Failed to generate title' });
    }
});

// Describe what's being built from partial code (uses fast model)
router.post('/describe-building', async (req, res) => {
    const { code, language } = req.body;
    if (!code) {
        return res.status(400).json({ error: 'Code is required' });
    }

    try {
        const config = await getAIConfig();
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`
        };

        // Use a fast model for quick descriptions
        const fastModel = 'Gemini 2.5 Flash-Lite - Fast';

        // Take first 1500 chars of code to keep prompt short
        const codePreview = code.slice(0, 1500);

        // Take the LAST 800 chars to see what's currently being generated
        const recentCode = code.slice(-800);

        const response = await fetch(`${config.url}/v1/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: fastModel,
                messages: [
                    {
                        role: 'system',
                        content: 'Reply with 3-6 words describing what PART is being built. Add subtle, witty humor. Examples: "Crafting buttons with pizzazz", "Teaching AI to think", "Making pixels dance gracefully", "Wiring up the magic", "Brewing some fresh logic"'
                    },
                    {
                        role: 'user',
                        content: `What part is being built now?\n\n${recentCode}`
                    }
                ],
                max_tokens: 25,
                temperature: 0.3
            })
        });

        if (!response.ok) {
            throw new Error(`AI request failed: ${response.status}`);
        }

        const data = await response.json();
        const description = data.choices?.[0]?.message?.content?.trim() || 'Building an interactive application...';

        res.json({ description });
    } catch (error) {
        console.error('Describe building error:', error);
        // Return a fallback description on error
        res.json({ description: 'Building an interactive application...' });
    }
});

// Get conversation history
router.get('/:id/history', async (req, res) => {
    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    // Use effective user ID (works for guests too)
    const userId = getEffectiveUserId(req);
    const conversation = await agentStore.getConversation(req.params.id, userId);
    res.json(conversation?.messages || []);
});

// Clear conversation history
router.delete('/:id/history', async (req, res) => {
    const userId = getEffectiveUserId(req);

    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    // Allow access if published or if user is owner
    if (!agent.is_published && agent.owner_id !== userId) {
        return res.status(403).json({ error: 'Access denied' });
    }

    await agentStore.clearConversation(req.params.id, userId);
    res.json({ success: true });
});


module.exports = router;
