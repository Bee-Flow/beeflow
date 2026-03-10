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

// ============ Agent CRUD ============

// List all agents for current user (regular agents only — swarms are managed separately)
router.get('/', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agents = await agentStore.getAgents(userId);
    res.json(agents);
});

// Get single agent (or Swarm or Browser Agent)
router.get('/:id', async (req, res) => {
    const id = req.params.id;
    // Check Swarm first
    const swarm = await swarmStore.getSwarm(id);
    if (swarm) {
        return res.json({
            id: swarm.id,
            name: swarm.name,
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
        });
    }

    // Check Browser Agent
    const browserAgent = await browserAgentStore.getBrowserAgent(id);
    if (browserAgent) {
        return res.json({
            id: browserAgent.id,
            name: browserAgent.name,
            description: browserAgent.description,
            system_prompt: browserAgent.system_prompt || '',
            model: browserAgent.model,
            owner_id: 'system',
            is_published: 1,
            starter_prompts: [],
            avatar: browserAgent.icon || '🌐',
            threads_enabled: 1,
            copy_enabled: 1,
            workspace_enabled: 0,
            config: browserAgent.config,
            created_at: browserAgent.created_at,
            updated_at: browserAgent.updated_at,
            is_browser_agent: true
        });
    }

    // Check Terminal Agent
    const terminalAgent = await terminalAgentStore.getTerminalAgent(id);
    if (terminalAgent) {
        return res.json({
            id: terminalAgent.id,
            name: terminalAgent.name,
            description: terminalAgent.description,
            system_prompt: terminalAgent.system_prompt || '',
            model: terminalAgent.model,
            owner_id: 'system',
            is_published: 1,
            starter_prompts: [],
            avatar: terminalAgent.icon || '💻',
            threads_enabled: 1,
            copy_enabled: 1,
            workspace_enabled: 0,
            config: terminalAgent.config,
            created_at: terminalAgent.created_at,
            updated_at: terminalAgent.updated_at,
            is_terminal_agent: true
        });
    }

    // Check Security Agent
    const securityAgent = await securityAgentStore.getSecurityAgent(id);
    if (securityAgent) {
        return res.json({
            id: securityAgent.id,
            name: securityAgent.name,
            description: securityAgent.description,
            system_prompt: securityAgent.system_prompt || '',
            model: securityAgent.model,
            owner_id: 'system',
            is_published: 1,
            starter_prompts: [],
            avatar: securityAgent.icon || '🛡️',
            threads_enabled: 1,
            copy_enabled: 1,
            workspace_enabled: 0,
            config: securityAgent.config,
            created_at: securityAgent.created_at,
            updated_at: securityAgent.updated_at,
            is_security_agent: true
        });
    }

    const agent = await agentStore.getAgent(id);
    if (agent) {
        return res.json(agent);
    }

    return res.status(404).json({ error: 'Agent not found' });
});

// Delete agent - requires delete_agent permission
router.delete('/:id', requirePermission('delete_agent'), async (req, res) => {
    try {
        const agent = await agentStore.getAgent(req.params.id);
        if (!agent) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        // Admin mode - allow deletion (since Admin Dashboard shows all agents)
        const deleted = await agentStore.forceDeleteAgent(req.params.id);
        if (deleted) {
            res.json({ success: true });
        } else {
            res.status(500).json({ error: 'Failed to delete agent' });
        }
    } catch (error) {
        console.error('Failed to delete agent:', error);
        res.status(500).json({ error: error.message });
    }
});

// Create new agent - requires manage_agents permission
router.post('/', requirePermission('manage_agents'), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const { name, description, systemPrompt, tools, model, starterPrompts, threadsEnabled, copyEnabled, workspaceEnabled, config, organizationId, sharedGroups } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Name is required' });
    }

    // Auto-assign the user's first organization if none provided
    let assignOrgId = organizationId;
    if (!assignOrgId) {
        const orgIds = await resolveUserOrgIds(req);
        if (orgIds !== null && orgIds.size > 0) {
            assignOrgId = Array.from(orgIds)[0];
        }
    }

    // Check agent count limit
    if (assignOrgId) {
        const allAgents = await agentStore.getAllAgents();
        const orgAgentCount = allAgents.filter(a => a.organization_id === assignOrgId).length;
        const limitErr = checkResourceLimits(assignOrgId, 'agents', orgAgentCount);
        if (limitErr) {
            return res.status(403).json({ error: limitErr });
        }
    }

    const agent = await agentStore.createAgent(
        name,
        description,
        systemPrompt,
        userId,
        model,
        starterPrompts || [],
        threadsEnabled !== false,
        copyEnabled !== false,
        workspaceEnabled === true,
        config || {},
        assignOrgId || null,
        sharedGroups || []
    );

    // Set tools if provided
    if (tools && Array.isArray(tools)) {
        await agentStore.setAgentTools(agent.id, tools);
        agent.tools = tools;
    }

    res.json(agent);
});

// Update agent - requires manage_agents permission
router.put('/:id', requirePermission('manage_agents'), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const { name, description, systemPrompt, tools, toolParams, model, starterPrompts, avatar, threadsEnabled, copyEnabled, workspaceEnabled, config, embedEnabled, organizationId, sharedGroups } = req.body;

    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    // Parse existing starter_prompts if stored as JSON string
    const existingStarterPrompts = typeof agent.starter_prompts === 'string'
        ? JSON.parse(agent.starter_prompts || '[]')
        : (agent.starter_prompts || []);

    // Parse existing shared_groups
    const existingSharedGroups = typeof agent.shared_groups === 'string'
        ? (() => { try { return JSON.parse(agent.shared_groups || '[]'); } catch (_) { return []; } })()
        : (agent.shared_groups || []);

    // Auto-assign the user's first organization if none provided and agent doesn't have one
    let assignOrgId = organizationId !== undefined ? organizationId : agent.organization_id;
    if (!assignOrgId) {
        const orgIds = await resolveUserOrgIds(req);
        if (orgIds !== null && orgIds.size > 0) {
            assignOrgId = Array.from(orgIds)[0];
        }
    }

    const updated = await agentStore.updateAgent(
        req.params.id,
        name || agent.name,
        description,
        systemPrompt,
        agent.owner_id,
        model !== undefined ? model : agent.model,
        starterPrompts !== undefined ? starterPrompts : existingStarterPrompts,
        avatar !== undefined ? avatar : agent.avatar,
        threadsEnabled !== undefined ? threadsEnabled : (agent.threads_enabled !== 0),
        copyEnabled !== undefined ? copyEnabled : (agent.copy_enabled !== 0),
        workspaceEnabled !== undefined ? workspaceEnabled : (agent.workspace_enabled !== 0),
        config !== undefined ? config : (agent.config || {}),
        embedEnabled !== undefined ? embedEnabled : (agent.embed_enabled !== 0),
        assignOrgId || null,
        sharedGroups !== undefined ? sharedGroups : existingSharedGroups
    );
    console.log('[AgentUpdate] workspaceEnabled received:', workspaceEnabled, 'type:', typeof workspaceEnabled);

    if (!updated) {
        return res.status(500).json({ error: 'Failed to update agent' });
    }

    // Update tools if provided (also pass toolParams)
    if (tools && Array.isArray(tools)) {
        // Transform toolParams from frontend format { param: { value, fixed } } 
        // to storage format { param: value } (only fixed params)
        const transformedParams = {};
        console.log('[AgentSave] Received toolParams:', JSON.stringify(toolParams, null, 2));
        if (toolParams) {
            for (const [componentId, params] of Object.entries(toolParams)) {
                const fixedParams = {};
                for (const [paramName, config] of Object.entries(params || {})) {
                    if (config && config.fixed && config.value !== undefined) {
                        fixedParams[paramName] = config.value;
                    }
                }
                if (Object.keys(fixedParams).length > 0) {
                    transformedParams[componentId] = fixedParams;
                }
            }
        }
        console.log('[AgentSave] Transformed params:', JSON.stringify(transformedParams, null, 2));
        await agentStore.setAgentTools(req.params.id, tools, transformedParams);
    }

    res.json({ success: true });
});

// Get tools with their fixed params
router.get('/:id/tools', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agent = await agentStore.getAgent(req.params.id);
    if (!agent || (agent.owner_id !== userId && !agent.is_published)) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    const toolsWithParams = await agentStore.getAgentToolsWithParams(req.params.id);
    res.json(toolsWithParams);
});

// Update params for a specific tool
router.put('/:id/tools/:componentId/params', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agent = await agentStore.getAgent(req.params.id);
    if (!agent || agent.owner_id !== userId) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    const { params } = req.body;
    await agentStore.updateAgentToolParams(req.params.id, req.params.componentId, params);
    res.json({ success: true });
});

// Delete agent
router.delete('/:id', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const deleted = await agentStore.deleteAgent(req.params.id, userId);
    if (!deleted) {
        return res.status(404).json({ error: 'Agent not found or access denied' });
    }

    res.json({ success: true });
});


module.exports = router;
