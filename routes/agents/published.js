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

// ============ Published Agents (public access) ============

// Get all published agents (no auth required)
// Get all published agents (no auth required)
router.get('/published', async (req, res) => {
    try {
        // Get user's groups and direct org for org-scoped filtering
        const userId = req.session?.user?.id;
        let userGroups = [];
        let userDirectOrgId = null;
        if (userId) {
            const user = await userStore.getUser(userId);
            if (user) {
                userGroups = Array.isArray(user.groups) ? user.groups : (() => { try { return JSON.parse(user.groups || '[]'); } catch (_) { return []; } })();
                userDirectOrgId = user.organizationId || null;
            }
        }
        // Admin users see all published agents
        const isAdmin = req.session?.isAdmin || req.session?.user?.role === 'admin';

        // Resolve allowed agent types from user's groups
        let allowedAgentTypes = [];
        if (!isAdmin && userId) {
            const allGroups = await userStore.getAllGroups();
            const agentTypeSet = new Set();
            for (const gid of userGroups) {
                const group = allGroups.find(g => g.id === gid);
                const types = group?.allowedAgentTypes || [];
                for (const t of types) agentTypeSet.add(t);
            }
            allowedAgentTypes = [...agentTypeSet];
        }
        const hasTypeRestrictions = !isAdmin && allowedAgentTypes.length > 0;

        // Only load chat agents if allowed
        let allAgents = [];
        if (!hasTypeRestrictions || allowedAgentTypes.includes('chat')) {
            const agents = isAdmin ? await agentStore.getPublishedAgents() : await agentStore.getPublishedAgentsForUser(userGroups, userDirectOrgId);
            allAgents = [...agents];
        }

        // Resolve user org IDs for filtering other agent types
        const orgIds = isAdmin ? null : await resolveUserOrgIds(req);

        // Also fetch enabled swarms as virtual agents for the marketplace/chat
        if (!hasTypeRestrictions || allowedAgentTypes.includes('swarm')) {
            try {
                let swarms = await swarmStore.getAllSwarms();
                // Org-scope filter for non-admin users
                if (orgIds !== null) {
                    swarms = swarms.filter(s => orgIds.has(s.organization_id));
                }
                const swarmAgents = swarms
                    .filter(swarm => swarm.enabled)
                    .map(swarm => ({
                        id: swarm.id,
                        name: `${swarm.name}`,
                        description: swarm.description,
                        system_prompt: '',
                        model: null,
                        owner_id: 'system',
                        is_published: 1,
                        starter_prompts: [],
                        avatar: swarm.icon || '🔬',
                        threads_enabled: 1,
                        copy_enabled: 1,
                        workspace_enabled: 0,
                        config: swarm.config,
                        created_at: swarm.created_at,
                        updated_at: swarm.updated_at,
                        is_swarm: true
                    }));
                allAgents = [...swarmAgents, ...allAgents];
            } catch (e) {
                console.error('Failed to load swarms for published list:', e);
            }
        }

        // Also fetch enabled browser agents as virtual agents
        if (!hasTypeRestrictions || allowedAgentTypes.includes('browser')) {
            try {
                let browserAgents = await browserAgentStore.getAllBrowserAgents();
                // Org-scope filter for non-admin users
                if (orgIds !== null) {
                    browserAgents = browserAgents.filter(ba => orgIds.has(ba.organization_id));
                }
                const browserVirtualAgents = browserAgents
                    .filter(ba => ba.enabled)
                    .map(ba => ({
                        id: ba.id,
                        name: ba.name,
                        description: ba.description,
                        system_prompt: ba.system_prompt || '',
                        model: ba.model,
                        owner_id: 'system',
                        is_published: 1,
                        starter_prompts: [],
                        avatar: ba.icon || '🌐',
                        threads_enabled: 1,
                        copy_enabled: 1,
                        workspace_enabled: 0,
                        config: ba.config,
                        created_at: ba.created_at,
                        updated_at: ba.updated_at,
                        is_browser_agent: true
                    }));
                allAgents = [...browserVirtualAgents, ...allAgents];
            } catch (e) {
                console.error('Failed to load browser agents for published list:', e);
            }
        }

        // Also fetch enabled terminal agents as virtual agents
        if (!hasTypeRestrictions || allowedAgentTypes.includes('terminal')) {
            try {
                let terminalAgents = await terminalAgentStore.getAllTerminalAgents();
                // Org-scope filter for non-admin users
                if (orgIds !== null) {
                    terminalAgents = terminalAgents.filter(ta => orgIds.has(ta.organization_id));
                }
                const terminalVirtualAgents = terminalAgents
                    .filter(ta => ta.enabled)
                    .map(ta => ({
                        id: ta.id,
                        name: ta.name,
                        description: ta.description,
                        system_prompt: ta.system_prompt || '',
                        model: ta.model,
                        owner_id: 'system',
                        is_published: 1,
                        starter_prompts: [],
                        avatar: ta.icon || '💻',
                        threads_enabled: 1,
                        copy_enabled: 1,
                        workspace_enabled: 0,
                        config: ta.config,
                        created_at: ta.created_at,
                        updated_at: ta.updated_at,
                        is_terminal_agent: true
                    }));
                allAgents = [...terminalVirtualAgents, ...allAgents];
            } catch (e) {
                console.error('Failed to load terminal agents for published list:', e);
            }
        }

        // Also fetch enabled security agents as virtual agents
        if (!hasTypeRestrictions || allowedAgentTypes.includes('security')) {
            try {
                let securityAgents = await securityAgentStore.getAllSecurityAgents();
                if (orgIds !== null) {
                    securityAgents = securityAgents.filter(sa => !sa.organization_id || orgIds.has(sa.organization_id));
                }
                const securityVirtualAgents = securityAgents
                    .filter(sa => sa.enabled)
                    .map(sa => ({
                        id: sa.id,
                        name: sa.name,
                        description: sa.description,
                        system_prompt: sa.system_prompt || '',
                        model: sa.model,
                        owner_id: 'system',
                        is_published: 1,
                        starter_prompts: [],
                        avatar: sa.icon || '🛡️',
                        threads_enabled: 1,
                        copy_enabled: 1,
                        workspace_enabled: 0,
                        config: sa.config,
                        created_at: sa.created_at,
                        updated_at: sa.updated_at,
                        is_security_agent: true
                    }));
                allAgents = [...securityVirtualAgents, ...allAgents];
            } catch (e) {
                console.error('Failed to load security agents for published list:', e);
            }
        }

        res.json(allAgents);
    } catch (error) {
        console.error('Failed to get published agents:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get ALL agents (for Admin Dashboard)
router.get('/all', async (req, res) => {
    try {
        let agents = await agentStore.getAllAgents();

        const orgIds = await resolveUserOrgIds(req);
        if (orgIds !== null) {
            agents = agents.filter(a => orgIds.has(a.organization_id));
        }

        res.json(agents);
    } catch (error) {
        console.error('Failed to get all agents:', error);
        res.status(500).json({ error: error.message });
    }
});

// Toggle agent published status + set sharing scope
router.patch('/:id/publish', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agent = await agentStore.getAgent(req.params.id);
    if (!agent || agent.owner_id !== userId) {
        return res.status(404).json({ error: 'Agent not found or access denied' });
    }

    const { isPublished, sharedGroups } = req.body;
    const success = await agentStore.setAgentPublished(req.params.id, isPublished, userId, sharedGroups);

    if (!success) {
        return res.status(500).json({ error: 'Failed to update published status' });
    }

    res.json({ success: true, isPublished, sharedGroups });
});


module.exports = router;
