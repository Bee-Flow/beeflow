/**
 * Swarm Pipeline Config - Legacy swarm orchestrator/worker/phase config CRUD
 */

const { v4: uuidv4 } = require('uuid');
const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./initSchema');

// ============ Seeding ============

const SEED_WORKERS = [
    { key: 'requirements', name: '📋 Requirements', icon: '📋', color: '#8b5cf6', desc: 'Extracts requirements, constraints, and acceptance criteria', phase: 'research', temp: 0.3, maxTok: 2000, tools: false },
    { key: 'research', name: '🔍 Research', icon: '🔍', color: '#3b82f6', desc: 'Searches for frameworks, libraries, and API docs', phase: 'research', temp: 0.3, maxTok: 2000, tools: true },
    { key: 'architecture', name: '🏗️ Architecture', icon: '🏗️', color: '#10b981', desc: 'Designs component architecture and data flow', phase: 'design', temp: 0.3, maxTok: 2000, tools: false },
    { key: 'builder', name: '🔨 Builder', icon: '🔨', color: '#f59e0b', desc: 'Generates the component code and tests it', phase: 'build', temp: 0.2, maxTok: 4000, tools: true },
    { key: 'test', name: '🧪 Tester', icon: '🧪', color: '#ef4444', desc: 'Runs tests and validates the component output', phase: 'test', temp: 0.1, maxTok: 2000, tools: true },
    { key: 'docs', name: '📚 Documentation', icon: '📚', color: '#6366f1', desc: 'Generates usage documentation and examples', phase: 'finalize', temp: 0.3, maxTok: 2000, tools: false },
    { key: 'reviewer', name: '👀 Reviewer', icon: '👀', color: '#ec4899', desc: 'Reviews finalized component for best practices and edge cases', phase: 'finalize', temp: 0.2, maxTok: 2000, tools: false },
    { key: 'credentials', name: '🔑 Credentials Guide', icon: '🔑', color: '#f59e0b', desc: 'Researches how to obtain required credentials and generates a form with instructions', phase: 'credentials', temp: 0.4, maxTok: 4000, tools: true },
    { key: 'clarify', name: '❓ Clarify', icon: '❓', color: '#3b82f6', desc: 'Asks targeted clarification questions before research begins', phase: 'clarify', temp: 0.3, maxTok: 1500, tools: true },
];

const SEED_PHASES = [
    { key: 'clarify', num: 0, name: 'Clarify', goal: 'Ask targeted questions to clarify ambiguous requirements' },
    { key: 'research', num: 1, name: 'Research', goal: 'Gather technical details, API docs, and best practices' },
    { key: 'credentials', num: 2, name: 'Credentials', goal: 'Identify required credentials and generate user-facing form' },
    { key: 'design', num: 3, name: 'Design', goal: 'Create component architecture and data flow' },
    { key: 'build', num: 4, name: 'Build', goal: 'Generate working component code' },
    { key: 'test', num: 5, name: 'Test', goal: 'Validate component with test execution' },
    { key: 'finalize', num: 6, name: 'Finalize', goal: 'Review, document, and package' },
];

async function seedSwarmConfig() {
    await initDB();
    const orchRow = await getOne('SELECT id FROM swarm_orchestrator WHERE id = 1');
    if (orchRow) return;

    await run(`INSERT INTO swarm_orchestrator (id, model, temperature, max_tokens, system_prompt, worker_timeout, max_retries, auto_test, skip_form_simple, builder_max_iterations)
        VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9)`, [null, 0.3, 2000, null, 180000, 3, true, true, 15]);

    for (let i = 0; i < SEED_WORKERS.length; i++) {
        const w = SEED_WORKERS[i];
        await run(`INSERT INTO swarm_workers (id, swarm_id, worker_key, enabled, name, icon, color, description, model, temperature, max_tokens, phase_id, use_tools, system_prompt, sort_order)
            VALUES ($1,'component-pipeline',$2,TRUE,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12) ON CONFLICT DO NOTHING`,
            [uuidv4(), w.key, w.name, w.icon, w.color, w.desc, null, w.temp, w.maxTok, w.phase, w.tools, i]);
    }

    const existing = await getOne('SELECT COUNT(*) as cnt FROM swarm_phases');
    if (!existing || existing.cnt === 0) {
        for (let i = 0; i < SEED_PHASES.length; i++) {
            const p = SEED_PHASES[i];
            await run('INSERT INTO swarm_phases (phase_key, phase_number, name, goal, sort_order) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [p.key, p.num, p.name, p.goal, i]);
        }
        console.log(`[SwarmPipelineConfig] Seeded ${SEED_PHASES.length} swarm phase goals`);
    }

    console.log(`[SwarmPipelineConfig] Seeded swarm config: orchestrator + ${SEED_WORKERS.length} workers`);
}

seedSwarmConfig().catch(err => console.error('[SwarmPipelineConfig] Seed error:', err.message));

// ============ Config CRUD ============

async function getSwarmConfig() {
    await initDB();
    const row = await getOne('SELECT * FROM swarm_orchestrator WHERE id = 1');
    if (!row) return null;

    const orchestrator = { model: row.model, temperature: row.temperature, maxTokens: row.max_tokens, systemPrompt: row.system_prompt };
    const pipeline = { workerTimeout: row.worker_timeout, maxRetries: row.max_retries, autoTest: !!row.auto_test, skipFormForSimpleComponents: !!row.skip_form_simple, builderMaxIterations: row.builder_max_iterations };

    const workerRows = await getAll("SELECT * FROM swarm_workers WHERE swarm_id = 'component-pipeline' ORDER BY sort_order");
    const workers = {};
    for (const w of workerRows) {
        workers[w.worker_key] = { enabled: !!w.enabled, name: w.name, icon: w.icon, color: w.color, description: w.description, model: w.model, temperature: w.temperature, maxTokens: w.max_tokens, phase: w.phase_id, useTools: !!w.use_tools, systemPrompt: w.system_prompt };
    }

    const phaseRows = await getAll('SELECT * FROM swarm_phases ORDER BY sort_order');
    const phases = phaseRows.map(p => ({ key: p.phase_key, number: p.phase_number, name: p.name, goal: p.goal }));

    return { orchestrator, workers, pipeline, phases };
}

async function saveSwarmConfig(config) {
    await initDB();
    const orch = config.orchestrator || {};
    const pipe = config.pipeline || {};

    await run(`UPDATE swarm_orchestrator SET model=$1, temperature=$2, max_tokens=$3, system_prompt=$4, worker_timeout=$5, max_retries=$6, auto_test=$7, skip_form_simple=$8, builder_max_iterations=$9, updated_at=NOW() WHERE id=1`,
        [orch.model || null, orch.temperature ?? 0.3, orch.maxTokens ?? 2000, orch.systemPrompt || null, pipe.workerTimeout ?? 180000, pipe.maxRetries ?? 3, pipe.autoTest !== false, pipe.skipFormForSimpleComponents !== false, pipe.builderMaxIterations ?? 15]);

    if (config.workers) {
        const keys = Object.keys(config.workers);
        for (let idx = 0; idx < keys.length; idx++) {
            const key = keys[idx];
            const w = config.workers[key];
            const existing = await getOne("SELECT id FROM swarm_workers WHERE swarm_id = 'component-pipeline' AND worker_key = $1", [key]);
            if (existing) {
                await run(`UPDATE swarm_workers SET enabled=$1, name=$2, icon=$3, color=$4, description=$5, model=$6, temperature=$7, max_tokens=$8, phase_id=$9, use_tools=$10, system_prompt=$11, sort_order=$12, updated_at=NOW() WHERE id=$13`,
                    [w.enabled !== false, w.name || key, w.icon || '', w.color || '#888', w.description || '', w.model || null, w.temperature ?? 0.3, w.maxTokens ?? 2000, w.phase || 'research', !!w.useTools, w.systemPrompt || null, idx, existing.id]);
            } else {
                await run(`INSERT INTO swarm_workers (id, swarm_id, worker_key, enabled, name, icon, color, description, model, temperature, max_tokens, phase_id, use_tools, system_prompt, sort_order, updated_at)
                    VALUES ($1,'component-pipeline',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())`,
                    [uuidv4(), key, w.enabled !== false, w.name || key, w.icon || '', w.color || '#888', w.description || '', w.model || null, w.temperature ?? 0.3, w.maxTokens ?? 2000, w.phase || 'research', !!w.useTools, w.systemPrompt || null, idx]);
            }
        }
    }

    if (config.phases && Array.isArray(config.phases)) {
        for (let idx = 0; idx < config.phases.length; idx++) {
            const p = config.phases[idx];
            if (p.key && p.goal) {
                await run(`INSERT INTO swarm_phases (phase_key, phase_number, name, goal, sort_order) VALUES ($1,$2,$3,$4,$5)
                    ON CONFLICT(phase_key) DO UPDATE SET phase_number=EXCLUDED.phase_number, name=EXCLUDED.name, goal=EXCLUDED.goal, sort_order=EXCLUDED.sort_order`,
                    [p.key, p.number || idx + 1, p.name || p.key, p.goal, idx]);
            }
        }
    }

    return getSwarmConfig();
}

async function getSwarmPhases() {
    await initDB();
    return getAll('SELECT * FROM swarm_phases ORDER BY sort_order');
}

async function getSwarmPhase(phaseKey) {
    await initDB();
    return getOne('SELECT * FROM swarm_phases WHERE phase_key = $1', [phaseKey]);
}

module.exports = {
    getSwarmConfig, saveSwarmConfig, getSwarmPhases, getSwarmPhase,
};
