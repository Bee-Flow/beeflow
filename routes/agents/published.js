const express = require('express');
const path = require('path');
const fs = require('fs');
const agentStore = require('../../stores/agentStore');
const agentRuntime = require('../../core/agentRuntime');
const { getAIConfig, getProviderForModel } = require('../../core/aiAgent');
const configStore = require('../../stores/configStore');
const { requirePermission } = require('../../auth');
const MemoryStore = require('../../stores/memoryStore');
const { resolveUserOrgIds, validateSharedGroupsForOrg } = require('../../auth');
const { getEffectiveUserId, getUserAuth } = require('../../utils/routeHelpers');

const userStore = require('../../stores/userStore');
const usageStore = require('../../stores/usageStore');
const { checkSubscriptionLimits: checkSubLimits, checkResourceLimits } = require('../../core/limits');
const { setupSSE, sendSSEError, persistAndTitle, getOrCreateAgentConversation } = require('../../core/sseHelpers');
const { canModifyAgent } = require('./crud');

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

        // Resolve user org IDs ONCE for consistent filtering across all agent types
        const orgIds = isAdmin ? null : await resolveUserOrgIds(req);

        // Only load chat agents if allowed
        let allAgents = [];
        if (!hasTypeRestrictions || allowedAgentTypes.includes('chat')) {
            const agents = isAdmin ? await agentStore.getPublishedAgents() : await agentStore.getPublishedAgentsForUser(userGroups, userDirectOrgId, orgIds);
            allAgents = [...agents];
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
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    // Non-owners additionally need manage_agents permission. Ownership, super-admin
    // bypass, and the agent_editor/unpublished-draft rule are handled by canModifyAgent.
    if (!(await canModifyAgent(agent, userId, req))) {
        return res.status(403).json({ error: 'Agent Editors cannot modify unpublished drafts from others.' });
    }
    if (agent.owner_id !== userId && !req.session?.isAdmin && req.session?.user?.role !== 'admin') {
        const { hasPermission } = require('../../auth');
        const hasPerm = await hasPermission(userId, 'manage_agents', req.session);
        if (!hasPerm) {
            return res.status(403).json({ error: 'Permission denied' });
        }
    }

    const { isPublished, sharedGroups } = req.body;

    // Validate sharedGroups belong to the agent's org. Undefined → leave as-is.
    let cleanedGroups;
    try {
        cleanedGroups = await validateSharedGroupsForOrg(agent.organization_id, sharedGroups);
    } catch (e) {
        return res.status(e.status || 500).json({ error: e.message });
    }

    // Use agent.owner_id (not userId) so the SQL WHERE owner_id matches even when
    // a non-owner (org admin, agent admin) is toggling publish.
    const success = await agentStore.setAgentPublished(req.params.id, isPublished, agent.owner_id, cleanedGroups);

    if (!success) {
        return res.status(500).json({ error: 'Failed to update published status' });
    }

    res.json({ success: true, isPublished, sharedGroups: cleanedGroups });
});


module.exports = router;
