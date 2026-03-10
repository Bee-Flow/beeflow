/**
 * Swarm Store - PostgreSQL management for Swarm Agent configurations
 * Stores different swarm types (Deep Research, Component Pipeline, etc.)
 * Each swarm has named phases with agent configs per phase.
 */

const { run, getOne, getAll, exec, getClient } = require('../db');
const { v4: uuidv4 } = require('uuid');

let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS swarm_configs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            icon TEXT DEFAULT '🔬',
            type TEXT DEFAULT 'custom',
            model TEXT DEFAULT NULL,
            system_prompt TEXT DEFAULT '',
            phases TEXT DEFAULT '[]',
            config TEXT DEFAULT '{}',
            is_builtin BOOLEAN DEFAULT FALSE,
            enabled BOOLEAN DEFAULT TRUE,
            organization_id TEXT DEFAULT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    initialized = true;
}

// ============ Seed Built-in Swarms ============

async function seedDefaults() {
    await initDB();
    const rows = await getAll('SELECT id FROM swarm_configs WHERE is_builtin = TRUE');
    if (rows.length >= 2) return;

    const deepResearch = {
        id: 'deep-research',
        name: 'Deep Research',
        description: 'Multi-agent web research pipeline. Decomposes a question into sub-queries, searches in parallel, and synthesizes a comprehensive report.',
        icon: '🔬',
        type: 'deep_research',
        is_builtin: true,
        enabled: true,
        phases: JSON.stringify([
            {
                id: 'decompose', name: 'Decompose',
                description: 'Break user query into 3-5 searchable sub-questions',
                color: '#8b5cf6', icon: '🧩',
                agents: [{
                    role: 'orchestrator', name: 'Query Planner', model: null, temperature: 0.3, maxTokens: 1000,
                    system_prompt: `You are a Senior Research Planner. Your goal is to break down a complex user request into distinct, high-value sub-questions that will yield a comprehensive answer.\n\n1.  **Analyze** the user's core intent.\n2.  **Identify** missing information gaps (definitions, statistics, comparisons, timelines).\n3.  **Formulate** 3-5 self-contained search queries. Each query must be specific enough to work on a search engine.\n    *   Avoid generic questions like "What is X?".\n    *   Prefer specific angles: "Market share of X in 2024", "Technical architecture comparison of X vs Y".\n4.  **Output** purely the list of questions.`
                }]
            },
            {
                id: 'search', name: 'Parallel Search',
                description: 'Search workers research each sub-question using tavily_search',
                color: '#3b82f6', icon: '🔍', parallel: true,
                agents: [{
                    role: 'searcher', name: 'Web Searcher', model: null, temperature: 0.3, maxTokens: 3000, tools: ['tavily_search'],
                    system_prompt: `You are an expert Web Researcher. Your goal is to find high-quality, empirical evidence for a specific sub-question.\n\n**Protocol:**\n1.  **EXECUTE** the \`tavily_search\` tool immediately to find data.\n2.  **ANALYZE** the search results. Look for hard data, dates, statistics, and direct quotes.\n3.  **SYNTHESIZE** a concise answer based *only* on the search results.\n4.  **CITE** your sources. Every claim must be backed by a URL from the search results.\n\nIf the first search yields poor results, you may try *one* refined search query.`
                }]
            },
            {
                id: 'synthesize', name: 'Synthesize',
                description: 'Combine findings into a structured markdown report',
                color: '#10b981', icon: '📝',
                agents: [{ role: 'synthesizer', name: 'Report Writer', model: null, temperature: 0.4, maxTokens: 8000, system_prompt: '' }]
            }
        ]),
        config: JSON.stringify({ maxSubQuestions: 5, maxSearchIterations: 5, searchTimeout: 30000, streamReport: true }),
        organization_id: null
    };

    const componentPipeline = {
        id: 'component-pipeline',
        name: 'Component Pipeline',
        description: 'Multi-agent component builder. Analyzes requirements, researches APIs, builds and tests components.',
        icon: '🏗️',
        type: 'component_pipeline',
        is_builtin: true,
        enabled: true,
        phases: JSON.stringify([
            {
                id: 'analyze', name: 'Analyze', description: 'Parse request, determine component type and requirements', color: '#3b82f6', icon: '❓',
                agents: [{ role: 'orchestrator', name: 'Orchestrator', model: null }, { role: 'clarify', name: 'Clarifier', model: null }]
            },
            {
                id: 'research', name: 'Research', description: 'Gather requirements, auth info, schemas, and API details', color: '#8b5cf6', icon: '📋', parallel: true,
                agents: [{ role: 'requirements', name: 'Requirements', model: null, tools: ['tavily_search'] }, { role: 'auth', name: 'Auth Researcher', model: null, tools: ['tavily_search'] }, { role: 'schema', name: 'Schema Designer', model: null }, { role: 'api', name: 'API Researcher', model: null, tools: ['tavily_search'] }]
            },
            {
                id: 'credentials', name: 'Credentials', description: 'Guide user through credential setup', color: '#f59e0b', icon: '🔑',
                agents: [{ role: 'credentials', name: 'Credentials Guide', model: null, tools: ['tavily_search'] }]
            },
            {
                id: 'build', name: 'Build & Test', description: 'Build the component and run QA tests', color: '#10b981', icon: '🔨',
                agents: [{ role: 'builder', name: 'Builder', model: null }, { role: 'qa', name: 'QA Tester', model: null }]
            },
            { id: 'deploy', name: 'Deploy', description: 'Finalize and deploy the component', color: '#06b6d4', icon: '🚀', agents: [] }
        ]),
        config: JSON.stringify({ workerTimeout: 180000, maxRetries: 3, autoTest: false, builderMaxIterations: 15 }),
        organization_id: null
    };

    for (const sw of [deepResearch, componentPipeline]) {
        await run(`
            INSERT INTO swarm_configs (id, name, description, icon, type, phases, config, is_builtin, enabled, organization_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT(id) DO NOTHING
        `, [sw.id, sw.name, sw.description, sw.icon, sw.type, sw.phases, sw.config, sw.is_builtin, sw.enabled, sw.organization_id]);

        await syncSwarmWorkers(sw.id, JSON.parse(sw.phases));
    }

    console.log('[SwarmStore] Seeded default swarm configs');
}

initDB().then(() => seedDefaults()).catch(err => console.error('[SwarmStore] Init error:', err.message));

// ============ CRUD Functions ============

async function getAllSwarms() {
    await initDB();
    const rows = await getAll('SELECT * FROM swarm_configs ORDER BY is_builtin DESC, name ASC');
    return rows.map(parseSwarmRow);
}

async function getSwarm(id) {
    await initDB();
    const row = await getOne('SELECT * FROM swarm_configs WHERE id = $1', [id]);
    if (!row) return null;
    return parseSwarmRow(row);
}

async function createSwarm(data) {
    await initDB();
    const id = data.id || uuidv4();
    const phases = data.phases || [];
    const client = await getClient();
    try {
        await client.query('BEGIN');
        await client.query(`
            INSERT INTO swarm_configs (id, name, description, icon, type, model, system_prompt, phases, config, is_builtin, enabled, organization_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE, $10, $11)
        `, [
            id, data.name || 'New Swarm', data.description || '', data.icon || '🤖',
            data.type || 'custom', data.model || null, data.system_prompt || '',
            JSON.stringify(phases), JSON.stringify(data.config || {}),
            data.enabled !== false, data.organization_id || null
        ]);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
    await syncSwarmWorkers(id, phases);
    return getSwarm(id);
}

async function updateSwarm(id, data) {
    await initDB();
    const existing = await getSwarm(id);
    if (!existing) return null;

    try {
        const versionStore = require('./versionStore');
        await versionStore.createVersion(id, 'swarm', existing);
    } catch (e) { console.error('[SwarmStore] Version snapshot failed:', e.message); }

    const newPhases = data.phases || existing.phases;

    await run(`
        UPDATE swarm_configs SET
            name = $1, description = $2, icon = $3, type = $4,
            model = $5, system_prompt = $6,
            phases = $7, config = $8, enabled = $9,
            organization_id = $10, updated_at = NOW()
        WHERE id = $11
    `, [
        data.name ?? existing.name,
        data.description ?? existing.description,
        data.icon ?? existing.icon,
        data.type ?? existing.type,
        data.model !== undefined ? (data.model || null) : (existing.model || null),
        data.system_prompt !== undefined ? data.system_prompt : (existing.system_prompt || ''),
        JSON.stringify(newPhases),
        data.config ? JSON.stringify(data.config) : JSON.stringify(existing.config),
        data.enabled !== undefined ? !!data.enabled : !!existing.enabled,
        data.organization_id !== undefined ? (data.organization_id || null) : (existing.organization_id || null),
        id
    ]);

    if (data.phases) {
        await syncSwarmWorkers(id, newPhases);
    }
    return getSwarm(id);
}

async function deleteSwarm(id) {
    await initDB();
    const existing = await getOne('SELECT is_builtin FROM swarm_configs WHERE id = $1', [id]);
    if (existing?.is_builtin) {
        throw new Error('Cannot delete built-in swarm');
    }
    const client = await getClient();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM swarm_configs WHERE id = $1 AND is_builtin = FALSE', [id]);
        await client.query('DELETE FROM swarm_workers WHERE swarm_id = $1', [id]);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
    return true;
}

// ============ Helpers ============

async function syncSwarmWorkers(swarmId, phases) {
    if (!phases || !Array.isArray(phases)) return;
    try {
        await run('DELETE FROM swarm_workers WHERE swarm_id = $1', [swarmId]);
        let globalSort = 0;
        for (const phase of phases) {
            if (!phase.agents) continue;
            for (const agent of phase.agents) {
                await run(`
                    INSERT INTO swarm_workers (id, swarm_id, phase_id, worker_key, name, icon, color, description, model, temperature, max_tokens, use_tools, system_prompt, sort_order)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                `, [
                    uuidv4(), swarmId,
                    phase.id || 'default',
                    agent.role || agent.name.toLowerCase().replace(/\s+/g, '_'),
                    agent.name,
                    agent.icon || phase.icon || '🤖',
                    agent.color || phase.color || '#3b82f6',
                    agent.description || phase.description || '',
                    agent.model || null,
                    agent.temperature || 0.3,
                    agent.maxTokens || 2000,
                    (agent.tools && agent.tools.length > 0),
                    agent.system_prompt || '',
                    globalSort++
                ]);
            }
        }
    } catch (err) {
        console.error(`[SwarmStore] Failed to sync workers for swarm ${swarmId}:`, err.message);
    }
}

function parseSwarmRow(row) {
    return {
        ...row,
        phases: safeParseJSON(row.phases, []),
        config: safeParseJSON(row.config, {}),
        is_builtin: !!row.is_builtin,
        enabled: !!row.enabled
    };
}

function safeParseJSON(str, fallback) {
    try { return typeof str === 'string' ? JSON.parse(str) : (str || fallback); } catch { return fallback; }
}

module.exports = {
    getAllSwarms,
    getSwarm,
    createSwarm,
    updateSwarm,
    deleteSwarm
};
