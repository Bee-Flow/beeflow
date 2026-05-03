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

// ============ Agent CRUD ============

// List all agents for current user
router.get('/', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agents = await agentStore.getAgents(userId);
    res.json(agents);
});

// ============ Agent Categories ============

// List categories for user's org
router.get('/categories', async (req, res) => {
    try {
        const orgIds = await resolveUserOrgIds(req);
        const orgId = orgIds !== null && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
        const categories = await agentStore.getAgentCategories(orgId);
        res.json(categories);
    } catch (error) {
        console.error('Failed to get agent categories:', error);
        res.status(500).json({ error: error.message });
    }
});

// Create a new category
router.post('/categories', requirePermission('manage_agents'), async (req, res) => {
    try {
        const { name, icon, color } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
        const orgIds = await resolveUserOrgIds(req);
        const orgId = orgIds !== null && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
        const category = await agentStore.createAgentCategory(orgId, name.trim(), icon, color);
        res.json(category);
    } catch (error) {
        console.error('Failed to create agent category:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete a category
router.delete('/categories/:id', requirePermission('manage_agents'), async (req, res) => {
    try {
        const deleted = await agentStore.deleteAgentCategory(req.params.id);
        if (!deleted) return res.status(404).json({ error: 'Category not found' });
        res.json({ success: true });
    } catch (error) {
        console.error('Failed to delete agent category:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get single agent
router.get('/:id', async (req, res) => {
    const id = req.params.id;
    const agent = await agentStore.getAgent(id);
    if (agent) {
        return res.json(agent);
    }

    return res.status(404).json({ error: 'Agent not found' });
});

// Delete agent - owner can delete own, admin/manage_agents can force-delete any
router.delete('/:id', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const agent = await agentStore.getAgent(req.params.id);
        if (!agent) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        let deleted;
        if (agent.owner_id === userId) {
            // Owner can always delete their own agent
            deleted = await agentStore.forceDeleteAgent(req.params.id);
        } else {
            // Non-owners need manage_agents permission
            const { hasPermission } = require('../../auth');
            const hasPerm = await hasPermission(userId, 'manage_agents', req.session);
            if (!hasPerm) {
                return res.status(403).json({ error: 'Permission denied' });
            }

            if (!(await canModifyAgent(agent, userId, req))) {
                return res.status(403).json({ error: 'Agent Editors cannot modify or delete unpublished drafts from others.' });
            }

            deleted = await agentStore.forceDeleteAgent(req.params.id);
        }

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
    const { name, description, systemPrompt, tools, model, starterPrompts, threadsEnabled, copyEnabled, workspaceEnabled, config, organizationId, sharedGroups, categoryId } = req.body;

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
        const limitErr = await checkResourceLimits(assignOrgId, 'agents', orgAgentCount);
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
        sharedGroups || [],
        categoryId || null
    );

    // Set tools if provided
    if (tools && Array.isArray(tools)) {
        await agentStore.setAgentTools(agent.id, tools);
        agent.tools = tools;
    }

    res.json(agent);
});

// Helper to enforce Agent Editor restriction
async function canModifyAgent(agent, userId, req) {
    if (agent.owner_id === userId) return true;
    
    // Super admin bypass
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return true;
    
    const user = await userStore.getUser(userId);
    const orgRole = user ? user.orgRole : null;
    
    // Agent Editor restriction: cannot modify unpublished drafts from others
    if (orgRole === 'agent_editor' && !agent.is_published) {
        return false;
    }
    
    return true;
}

// Update agent - requires manage_agents permission
router.put('/:id', requirePermission('manage_agents'), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const { name, description, systemPrompt, tools, toolParams, model, starterPrompts, avatar, threadsEnabled, copyEnabled, workspaceEnabled, config, embedEnabled, organizationId, sharedGroups, categoryId } = req.body;

    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    if (!(await canModifyAgent(agent, userId, req))) {
        return res.status(403).json({ error: 'Agent Editors cannot modify unpublished drafts from others.' });
    }

    // Tier gate: when the client sets a `tier:<key>` model, validate that the
    // user is actually allowed to use that tier. Custom tiers (`custom:*`) are
    // already gated by group membership at fetch time; we still allow non-tier
    // raw model strings (legacy) to pass through unchanged.
    if (typeof model === 'string' && model.startsWith('tier:')) {
        const tierKey = model.slice('tier:'.length);
        if (!tierKey.startsWith('custom:')) {
            const { getPermittedTierKeys } = require('../../core/userTiers');
            const allowed = await getPermittedTierKeys({ userId, session: req.session, taskType: 'direct_chat' });
            if (!allowed.has(tierKey)) {
                return res.status(403).json({ error: `Tier "${tierKey}" is not available on your account.` });
            }
        }
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
        sharedGroups !== undefined ? sharedGroups : existingSharedGroups,
        categoryId !== undefined ? categoryId : (agent.category_id || null)
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

module.exports = router;
module.exports.canModifyAgent = canModifyAgent;
