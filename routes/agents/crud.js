const express = require('express');
const path = require('path');
const fs = require('fs');
const agentStore = require('../../stores/agentStore');
const agentRuntime = require('../../core/agentRuntime');
const { getAIConfig, getProviderForModel } = require('../../core/aiAgent');
const configStore = require('../../stores/configStore');
const { requirePermission } = require('../../auth');
const MemoryStore = require('../../stores/memoryStore');
const { resolveUserOrgIds, canSeePublished, resolveUserGroups, assertUserCanUseOrg, validateSharedGroupsForOrg } = require('../../auth');
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

// Visibility gate — a user can read an agent only if they own it, it's a
// system/swarm agent, or `canSeePublished` accepts them given the agent's
// org + shared_groups. Without this gate any authenticated user could fetch
// any other user's drafts including the system_prompt, KB ids, and tool
// params (which often hold API keys / customer-specific config).
async function canReadAgent(agent, userId, req) {
    if (!agent) return false;
    if (agent.owner_id === userId) return true;
    if (agent.owner_id === 'system' || agent.owner_id === 'swarm') return true;
    const orgIds = await resolveUserOrgIds(req).catch(() => new Set());
    const userGroups = await resolveUserGroups(userId);
    return canSeePublished(agent, { userId, orgIds, userGroups });
}

router.get('/:id', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!(await canReadAgent(agent, userId, req))) {
        return res.status(404).json({ error: 'Agent not found' });
    }
    res.json(agent);
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

    // Validate that the user actually belongs to the requested organisation
    // (or auto-assign their primary org when none was provided). Trusting
    // organizationId from the body would let any member create agents in
    // other orgs.
    let assignOrgId;
    try {
        assignOrgId = await assertUserCanUseOrg(req, organizationId);
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message });
    }

    // Strip any shared_groups that don't belong to the agent's org. Empty/
    // unset on create is fine — publish endpoint is the canonical write path.
    let cleanedSharedGroups;
    try {
        cleanedSharedGroups = await validateSharedGroupsForOrg(assignOrgId, sharedGroups);
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message });
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
        cleanedSharedGroups || [],
        categoryId || null
    );

    // Set tools if provided
    if (tools && Array.isArray(tools)) {
        await agentStore.setAgentTools(agent.id, tools);
        agent.tools = tools;
    }

    res.json(agent);
});

// Validate that every cross-element ID referenced from an agent's config is
// accessible to the AGENT'S OWNER (not the requesting user). This closes the
// leak path where an editor in org A could attach a KB/skill that belongs to
// a different org — once the agent is published, anyone who can see the
// agent would receive cross-org data through it.
async function validateAgentConfigReferences(agent, config) {
    if (!config || typeof config !== 'object') return;
    const errors = [];

    const ownerId = agent.owner_id;
    const agentOrgId = agent.organization_id || null;
    const owner = await userStore.getUser(ownerId).catch(() => null);
    const ownerOrgIds = new Set();
    if (owner?.organizationId) ownerOrgIds.add(owner.organizationId);
    let ownerGroups = [];
    if (owner) {
        ownerGroups = Array.isArray(owner.groups)
            ? owner.groups
            : (() => { try { return JSON.parse(owner.groups || '[]'); } catch { return []; } })();
        if (ownerGroups.length > 0) {
            const allGroups = await userStore.getAllGroups().catch(() => []);
            for (const gid of ownerGroups) {
                const g = allGroups.find(x => x.id === gid);
                if (g?.organizationId) ownerOrgIds.add(g.organizationId);
            }
        }
    }

    // ── Knowledge base references ──
    const kbIds = Array.isArray(config.knowledge_base_ids) ? config.knowledge_base_ids.filter(Boolean) : [];
    if (kbIds.length > 0) {
        const kbStore = require('../../stores/knowledgeBases');
        for (const kbId of kbIds) {
            const kb = await kbStore.getKB(kbId).catch(() => null);
            if (!kb || !kbStore.canUserAccessKB(kb, ownerId, ownerOrgIds, ownerGroups)) {
                errors.push(`knowledge base ${kbId}`);
            }
        }
    }

    // ── Skill references (wizard stores them as attachedSkillIds) ──
    const skillIds = Array.isArray(config.attachedSkillIds) ? config.attachedSkillIds.filter(Boolean) : [];
    if (skillIds.length > 0 && agentOrgId) {
        const skillStore = require('../../stores/skillStore');
        for (const sid of skillIds) {
            const skill = await skillStore.getSkill(sid, agentOrgId, ownerId).catch(() => null);
            if (!skill) errors.push(`skill ${sid}`);
        }
    } else if (skillIds.length > 0 && !agentOrgId) {
        // Agent has no org but is referencing skills — block since skills are
        // strictly org-scoped.
        for (const sid of skillIds) errors.push(`skill ${sid}`);
    }

    if (errors.length > 0) {
        const err = new Error(`Agent owner cannot access: ${errors.join(', ')}`);
        err.status = 400;
        throw err;
    }
}

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
    // `organizationId` and `sharedGroups` are intentionally NOT destructured
    // here. organization is set on creation and only an org-admin should be
    // able to move an agent across orgs (no UI surface today). sharedGroups is
    // managed via the dedicated `PATCH /:id/publish` endpoint to keep the
    // group-membership check in one place. Either field arriving here is
    // silently dropped (the existing values are reused from `agent.*`).
    const { name, description, systemPrompt, tools, toolParams, model, starterPrompts, avatar, threadsEnabled, copyEnabled, workspaceEnabled, config, embedEnabled, categoryId } = req.body;

    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    if (!(await canModifyAgent(agent, userId, req))) {
        return res.status(403).json({ error: 'Agent Editors cannot modify unpublished drafts from others.' });
    }

    // Tier gate: when the client sets a `tier:<key>` model, validate that the
    // user is actually allowed to use that tier. Both standard and custom tiers
    // are checked — getPermittedTierKeys returns all keys (standard + custom)
    // permitted for this user's groups + beta features. Non-tier raw model
    // strings (legacy) pass through unchanged.
    if (typeof model === 'string' && model.startsWith('tier:')) {
        const tierKey = model.slice('tier:'.length);
        const { getPermittedTierKeys } = require('../../core/userTiers');
        const allowed = await getPermittedTierKeys({ userId, session: req.session, taskType: 'direct_chat' });
        if (!allowed.has(tierKey)) {
            return res.status(403).json({ error: `Tier "${tierKey}" is not available on your account.` });
        }
    }

    // Parse existing starter_prompts if stored as JSON string
    const existingStarterPrompts = typeof agent.starter_prompts === 'string'
        ? JSON.parse(agent.starter_prompts || '[]')
        : (agent.starter_prompts || []);

    // Parse existing shared_groups (preserved verbatim — only the publish
    // endpoint may mutate this).
    const existingSharedGroups = typeof agent.shared_groups === 'string'
        ? (() => { try { return JSON.parse(agent.shared_groups || '[]'); } catch (_) { return []; } })()
        : (agent.shared_groups || []);

    // Organization is sticky — only set on first save if the agent has none.
    let assignOrgId = agent.organization_id || null;
    if (!assignOrgId) {
        const orgIds = await resolveUserOrgIds(req);
        if (orgIds !== null && orgIds.size > 0) {
            assignOrgId = Array.from(orgIds)[0];
        }
    }

    // Validate cross-element references in config (KB / skill IDs). Done
    // BEFORE the DB write so a bad config doesn't half-commit.
    if (config !== undefined && config !== null) {
        try {
            // Use the *new* config to validate, plus the agent's existing
            // organization_id so skill lookups scope correctly.
            await validateAgentConfigReferences(
                { ...agent, organization_id: assignOrgId },
                config
            );
        } catch (e) {
            return res.status(e.status || 500).json({ error: e.message });
        }
    }

    // Validate categoryId belongs to the user's org. Users may not legitimately
    // attach an agent to a category in another org. Null is always allowed
    // (clears the category).
    let resolvedCategoryId = categoryId !== undefined ? categoryId : (agent.category_id || null);
    if (resolvedCategoryId && resolvedCategoryId !== agent.category_id) {
        try {
            const cats = await agentStore.getAgentCategories(assignOrgId);
            const valid = Array.isArray(cats) && cats.some(c => c.id === resolvedCategoryId);
            if (!valid) {
                return res.status(400).json({ error: 'Category does not belong to your organization.' });
            }
        } catch (_) {
            // If the category list can't be loaded, fall back to existing value
            // rather than silently moving to an unverified category.
            resolvedCategoryId = agent.category_id || null;
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
        assignOrgId,
        existingSharedGroups,
        resolvedCategoryId
    );

    if (!updated) {
        return res.status(500).json({ error: 'Failed to update agent' });
    }

    // Update tools if provided (also pass toolParams)
    if (tools && Array.isArray(tools)) {
        // Transform toolParams from frontend format { param: { value, fixed } }
        // to storage format { param: value } (only fixed params)
        const transformedParams = {};
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
        await agentStore.setAgentTools(req.params.id, tools, transformedParams);
    }

    // Return the freshly persisted agent (including server-derived fields like
    // updated_at, parsed config, etc.) so the client can refresh its local
    // shell without a second GET round-trip. The previous `{success:true}`
    // shape silently corrupted the editor's `agent` state and broke every
    // auto-save after the first.
    const fresh = await agentStore.getAgent(req.params.id);
    res.json(fresh || { success: true });
});

// Get tools with their fixed params — visibility-gated like GET /:id, since
// fixed tool params often hold credentials or customer-specific config.
router.get('/:id/tools', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!(await canReadAgent(agent, userId, req))) {
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
module.exports.canReadAgent = canReadAgent;
