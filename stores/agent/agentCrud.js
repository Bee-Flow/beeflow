/**
 * Agent CRUD - Create, Read, Update, Delete for agents + publish/org filtering
 */

const { v4: uuidv4 } = require('uuid');
const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./initSchema');
const { getAgentTools, getAgentToolsWithParams } = require('./agentTools');

function parseConfig(agent) {
    return {
        ...agent,
        config: agent.config ? (typeof agent.config === 'string' ? JSON.parse(agent.config) : agent.config) : {},
        shared_groups: (() => { try { return JSON.parse(agent.shared_groups || '[]'); } catch (_) { return []; } })()
    };
}

async function buildToolParams(agentId) {
    const toolsWithParams = await getAgentToolsWithParams(agentId);
    const tool_params = {};
    for (const t of toolsWithParams) {
        if (t.params) {
            tool_params[t.componentId] = {};
            for (const [paramName, value] of Object.entries(t.params)) {
                tool_params[t.componentId][paramName] = { value, fixed: true };
            }
        }
    }
    return tool_params;
}

async function createAgent(name, description, systemPrompt, ownerId, model = null, starterPrompts = [], threadsEnabled = true, copyEnabled = true, workspaceEnabled = false, config = {}, organizationId = null, sharedGroups = [], categoryId = null) {
    await initDB();
    const id = uuidv4();
    await run(`INSERT INTO agents (id, name, description, system_prompt, model, starter_prompts, threads_enabled, copy_enabled, workspace_enabled, config, organization_id, shared_groups, category_id, owner_id, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW())`,
        [id, name, description || '', systemPrompt || '', model, JSON.stringify(starterPrompts), !!threadsEnabled, !!copyEnabled, !!workspaceEnabled, JSON.stringify(config || {}), organizationId || null, JSON.stringify(sharedGroups || []), categoryId || null, ownerId]);
    return { id, name, description, system_prompt: systemPrompt, model, starter_prompts: starterPrompts, threads_enabled: threadsEnabled, copy_enabled: copyEnabled, workspace_enabled: workspaceEnabled, config, organization_id: organizationId, shared_groups: sharedGroups, category_id: categoryId, owner_id: ownerId };
}

async function getAgents(ownerId) {
    await initDB();
    const agents = await getAll("SELECT * FROM agents WHERE owner_id = $1 OR owner_id = 'system' ORDER BY updated_at DESC", [ownerId]);
    const result = [];
    for (const agent of agents) {
        const tools = await getAgentTools(agent.id);
        result.push({ ...parseConfig(agent), tools });
    }
    return result;
}

async function getAgent(id) {
    await initDB();
    const agent = await getOne('SELECT * FROM agents WHERE id = $1', [id]);
    if (!agent) return null;
    const tools = await getAgentTools(id);
    const tool_params = await buildToolParams(id);
    return { ...parseConfig(agent), tools, tool_params };
}

async function updateAgent(id, name, description, systemPrompt, ownerId, model = null, starterPrompts = [], avatar = null, threadsEnabled = true, copyEnabled = true, workspaceEnabled = false, config = {}, embedEnabled = false, organizationId = undefined, sharedGroups = undefined, categoryId = undefined) {
    await initDB();
    // Snapshot current state for version history
    try {
        const existing = await getOne('SELECT * FROM agents WHERE id = $1', [id]);
        if (existing) {
            const versionStore = require('../versionStore');
            await versionStore.createVersion(id, 'agent', existing, ownerId);
        }
    } catch (e) { console.error('[AgentCrud] Version snapshot failed:', e.message); }

    const orgId = organizationId !== undefined ? (organizationId || null) : null;
    const sharedGroupsJson = sharedGroups !== undefined ? JSON.stringify(sharedGroups || []) : '[]';
    const catId = categoryId !== undefined ? (categoryId || null) : null;
    const { rowCount } = await run(`UPDATE agents SET name=$1, description=$2, system_prompt=$3, model=$4, starter_prompts=$5, avatar=$6, threads_enabled=$7, copy_enabled=$8, workspace_enabled=$9, config=$10, embed_enabled=$11, organization_id=$12, shared_groups=$13, category_id=$14, updated_at=NOW()
        WHERE id=$15 AND owner_id=$16`,
        [name, description || '', systemPrompt || '', model, JSON.stringify(starterPrompts), avatar, !!threadsEnabled, !!copyEnabled, !!workspaceEnabled, JSON.stringify(config || {}), !!embedEnabled, orgId, sharedGroupsJson, catId, id, ownerId]);
    return rowCount > 0;
}

async function deleteAgent(id, ownerId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM agents WHERE id = $1 AND owner_id = $2', [id, ownerId]);
    return rowCount > 0;
}

async function forceDeleteAgent(id) {
    await initDB();
    await run('DELETE FROM agent_tools WHERE agent_id = $1', [id]);
    await run('DELETE FROM agent_conversations WHERE agent_id = $1', [id]);
    const { rowCount } = await run('DELETE FROM agents WHERE id = $1', [id]);
    return rowCount > 0;
}

async function getPublishedAgents() {
    await initDB();
    const agents = await getAll("SELECT * FROM agents WHERE is_published = TRUE AND owner_id NOT IN ('system', 'swarm') ORDER BY name ASC");
    const result = [];
    for (const agent of agents) {
        const tools = await getAgentTools(agent.id);
        const tool_params = await buildToolParams(agent.id);
        result.push({ ...parseConfig(agent), tools, tool_params });
    }
    return result;
}

async function setAgentPublished(id, isPublished, ownerId, sharedGroups = undefined) {
    await initDB();
    const sharedGroupsJson = sharedGroups !== undefined ? JSON.stringify(sharedGroups || []) : '[]';
    const { rowCount } = await run('UPDATE agents SET is_published = $1, shared_groups = $2, updated_at = NOW() WHERE id = $3 AND owner_id = $4', [!!isPublished, sharedGroupsJson, id, ownerId]);
    return rowCount > 0;
}

async function getPublishedAgentsForUser(userGroups = [], userOrgId = null) {
    await initDB();
    const allPublished = await getAll("SELECT * FROM agents WHERE is_published = TRUE AND owner_id NOT IN ('system', 'swarm') ORDER BY name ASC");

    // Pre-load group→org mapping
    const groupsData = await getAll('SELECT id, "organizationId" FROM groups');
    const groupOrgMap = {};
    for (const g of groupsData) { groupOrgMap[g.id] = g.organizationId || null; }

    const userOrgIds = new Set();
    if (userOrgId) userOrgIds.add(userOrgId);
    for (const gid of userGroups) { const orgId = groupOrgMap[gid]; if (orgId) userOrgIds.add(orgId); }
    const hasOrgMembership = userOrgIds.size > 0;

    const filtered = allPublished.filter(agent => {
        if (hasOrgMembership) {
            if (!agent.organization_id) return false;
            if (!userOrgIds.has(agent.organization_id)) return false;
        } else {
            if (agent.organization_id) return false;
        }
        let sharedGroups = [];
        try { sharedGroups = JSON.parse(agent.shared_groups || '[]'); } catch (_) { }
        if (sharedGroups.length > 0) return sharedGroups.some(sg => userGroups.includes(sg));
        return true;
    });

    const result = [];
    for (const agent of filtered) {
        const tools = await getAgentTools(agent.id);
        const tool_params = await buildToolParams(agent.id);
        result.push({ ...parseConfig(agent), tools, tool_params });
    }
    return result;
}

async function getAllAgents() {
    await initDB();
    const agents = await getAll("SELECT * FROM agents WHERE owner_id NOT IN ('system', 'swarm') ORDER BY updated_at DESC");
    const result = [];
    for (const agent of agents) {
        const tools = await getAgentTools(agent.id);
        result.push({ ...parseConfig(agent), tools });
    }
    return result;
}

async function getSystemAgents() {
    await initDB();
    const agents = await getAll("SELECT * FROM agents WHERE owner_id = 'system' ORDER BY name ASC");
    const result = [];
    for (const agent of agents) {
        const tools = await getAgentTools(agent.id);
        result.push({ ...parseConfig(agent), tools });
    }
    return result;
}

async function ensurePlaceholderAgent(id, name, description) {
    await initDB();
    const existing = await getOne('SELECT id FROM agents WHERE id = $1', [id]);
    if (!existing) {
        await run(`INSERT INTO agents (id, name, description, system_prompt, model, owner_id, is_published, created_at, updated_at)
            VALUES ($1,$2,$3,'','virtual','swarm',TRUE,NOW(),NOW())`, [id, name, description || 'Swarm Virtual Agent']);
    }
}

// ============ Agent Categories CRUD ============

async function getAgentCategories(orgId) {
    await initDB();
    if (orgId) {
        return getAll('SELECT * FROM agent_categories WHERE organization_id = $1 ORDER BY name ASC', [orgId]);
    }
    return getAll('SELECT * FROM agent_categories ORDER BY name ASC');
}

async function createAgentCategory(orgId, name, icon, color) {
    await initDB();
    const id = uuidv4();
    await run('INSERT INTO agent_categories (id, organization_id, name, icon, color) VALUES ($1,$2,$3,$4,$5)',
        [id, orgId || null, name, icon || '📁', color || '#6366f1']);
    return { id, organization_id: orgId, name, icon: icon || '📁', color: color || '#6366f1' };
}

async function deleteAgentCategory(id) {
    await initDB();
    // Unset category_id on agents that use this category
    await run('UPDATE agents SET category_id = NULL WHERE category_id = $1', [id]);
    const { rowCount } = await run('DELETE FROM agent_categories WHERE id = $1', [id]);
    return rowCount > 0;
}

module.exports = {
    createAgent, getAgents, getAgent, updateAgent, deleteAgent, forceDeleteAgent,
    getPublishedAgents, setAgentPublished, getPublishedAgentsForUser,
    getAllAgents, getSystemAgents, ensurePlaceholderAgent,
    getAgentCategories, createAgentCategory, deleteAgentCategory,
};
