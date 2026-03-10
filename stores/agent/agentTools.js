/**
 * Agent Tools - Manage which components an agent can use + param configs
 */

const { v4: uuidv4 } = require('uuid');
const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./initSchema');

async function addAgentTool(agentId, componentId, params = null) {
    await initDB();
    const id = uuidv4();
    console.log('[AgentTools] Adding tool:', componentId, 'with params:', params);
    await run('INSERT INTO agent_tools (id, agent_id, component_id, params_json) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id, agentId, componentId, params ? JSON.stringify(params) : null]);
}

async function removeAgentTool(agentId, componentId) {
    await initDB();
    await run('DELETE FROM agent_tools WHERE agent_id = $1 AND component_id = $2', [agentId, componentId]);
}

async function getAgentTools(agentId) {
    await initDB();
    const rows = await getAll('SELECT component_id, params_json FROM agent_tools WHERE agent_id = $1', [agentId]);
    return rows.map(row => row.component_id);
}

async function getAgentToolsWithParams(agentId) {
    await initDB();
    const rows = await getAll('SELECT component_id, params_json FROM agent_tools WHERE agent_id = $1', [agentId]);
    return rows.map(row => ({
        componentId: row.component_id,
        params: row.params_json ? JSON.parse(row.params_json) : null
    }));
}

async function updateAgentToolParams(agentId, componentId, params) {
    await initDB();
    await run('UPDATE agent_tools SET params_json = $1 WHERE agent_id = $2 AND component_id = $3', [params ? JSON.stringify(params) : null, agentId, componentId]);
}

async function setAgentTools(agentId, componentIds, toolParams = {}) {
    await initDB();
    await run('DELETE FROM agent_tools WHERE agent_id = $1', [agentId]);
    for (const componentId of componentIds) {
        const params = toolParams[componentId] || null;
        await addAgentTool(agentId, componentId, params);
    }
}

module.exports = {
    addAgentTool, removeAgentTool, getAgentTools,
    getAgentToolsWithParams, updateAgentToolParams, setAgentTools,
};
