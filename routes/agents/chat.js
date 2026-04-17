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

/**
 * Re-validates that an authenticated user still has group/org access to a
 * published agent at message-send time — not just when the page loaded.
 *
 * Mirrors the filtering logic in agentCrud.getPublishedAgentsForUser so that
 * revoking group membership or changing org scope takes effect immediately,
 * even for users who already have the agent open in their browser.
 *
 * @param {Object} agent   - Parsed agent record (shared_groups already an array)
 * @param {string} userId  - Authenticated user ID
 * @param {Object} req     - Express request (for resolveUserOrgIds)
 * @returns {Promise<boolean>}
 */
async function userCanAccessPublishedAgent(agent, userId, req) {
    // Agent must be published for anyone other than the owner
    if (!agent.is_published) return false;

    // Owner always has access to their own agent
    if (agent.owner_id === userId) return true;

    // Load current group membership and direct org from DB (not from session/cache)
    let userGroups = [];
    let userDirectOrgId = null;
    try {
        const user = await userStore.getUser(userId);
        if (user) {
            userGroups = Array.isArray(user.groups)
                ? user.groups
                : (() => { try { return JSON.parse(user.groups || '[]'); } catch (_) { return []; } })();
            userDirectOrgId = user.organizationId || null;
        }
    } catch (_) { /* treat as no groups */ }

    // Resolve the full set of org IDs the user belongs to
    const resolvedOrgIds = await resolveUserOrgIds(req);
    let userOrgIds;
    if (resolvedOrgIds instanceof Set) {
        userOrgIds = resolvedOrgIds;
    } else {
        userOrgIds = new Set();
        if (userDirectOrgId) userOrgIds.add(userDirectOrgId);
    }
    const hasOrgMembership = userOrgIds.size > 0;

    // ── Org isolation (same logic as getPublishedAgentsForUser) ─────────────
    if (hasOrgMembership) {
        // Org users can ONLY access agents that belong to one of their orgs
        if (!agent.organization_id) return false;
        if (!userOrgIds.has(agent.organization_id)) return false;
    } else {
        // Users with no org can only access global (non-org-scoped) agents
        if (agent.organization_id) return false;
    }

    // ── Group restriction ────────────────────────────────────────────────────
    // shared_groups is already parsed as an array by agentCrud.parseConfig
    const sharedGroups = agent.shared_groups || [];
    if (sharedGroups.length > 0) {
        return sharedGroups.some(sg => userGroups.includes(sg));
    }

    return true;
}

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

    if (!agent.is_published) {
        // Unpublished agents: only the owner can access
        if (!req.session?.user?.id || agent.owner_id !== userId) {
            return res.status(403).json({ error: 'Access denied' });
        }
    } else if (userId) {
        // Published agents: re-validate current group/org permissions on every request
        const canAccess = await userCanAccessPublishedAgent(agent, userId, req);
        if (!canAccess) {
            console.warn(`[AgentChat] User ${userId} attempted to chat with agent ${agent.id} — access denied (permissions revoked)`);
            return res.status(403).json({ error: 'Access denied' });
        }
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

    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    // For regular agents: must be published AND embed_enabled
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
});

// ── Subscription limit enforcement (uses shared module) ──────────────────────
const checkSubscriptionLimits = checkSubLimits;

// Streaming chat with agent (SSE)
router.post('/:id/chat/stream', async (req, res) => {
    const agent = await agentStore.getAgent(req.params.id);

    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    // Access control — re-validated on every request so revoked permissions take
    // effect immediately, even for users who already have the agent open.
    {
        const userId = getEffectiveUserId(req);

        if (!agent.is_published) {
            // Unpublished: require authentication and ownership
            if (!req.session?.user?.id) {
                return res.status(401).json({ error: 'Not authenticated' });
            }
            if (agent.owner_id !== userId) {
                return res.status(403).json({ error: 'Access denied' });
            }
        } else if (userId) {
            // Published: re-validate group/org membership from DB on every message.
            // This prevents a user whose permissions were revoked from continuing to
            // chat just because they haven't refreshed the page yet.
            const canAccess = await userCanAccessPublishedAgent(agent, userId, req);
            if (!canAccess) {
                console.warn(`[AgentChat] User ${userId} attempted to stream agent ${agent.id} — access denied (permissions revoked)`);
                return res.status(403).json({ error: 'Access denied' });
            }
        }
        // No userId (unauthenticated embed guest) + is_published → allow (embed flow)
    }

    const { message, history, messageId, parentId, attachments, conversationId, ephemeral, modelTier, activeSkillIds, reasoningEffort } = req.body;
    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    const userId = getEffectiveUserId(req);

    // ── Subscription limit enforcement ──
    const orgIds = await resolveUserOrgIds(req);
    const orgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
    const agentType = 'chat';
    const limitError = await checkSubscriptionLimits(orgId, agentType, userId);
    if (limitError) {
        sendSSEError(res, limitError);
        return;
    }

    // Set up SSE
    const { sendEvent, abortController, markEnded } = setupSSE(res);

    try {
        const userAuth = getUserAuth(req);

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
            { messageId, parentId, attachments, conversationId, ephemeral, workspaceContent: req.body.workspaceContent, workspaceSelection: req.body.workspaceSelection, signal: abortController.signal, userOrgId: userAuth.userOrgId, timezone: req.body.timezone, projectId: req.body.projectId, modelTier, activeSkillIds, orgId, reasoningEffort }
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
                    const title = await agentRuntime.generateChatTitle(userMessages, null, orgId, userId);
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
            const classified = error._classified || {};
            sendEvent('error', {
                error: error.message,
                errorType: classified.retryable ? 'transient' : 'permanent'
            });
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
        const title = await agentRuntime.generateChatTitle(content, null, threadOrgId, req.session?.user?.id || null);
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
