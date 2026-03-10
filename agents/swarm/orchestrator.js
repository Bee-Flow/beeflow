/**
 * Swarm Orchestrator Helper
 * generic logic for orchestrating swarm workers as tools
 */

const swarmStore = require('../../stores/swarmStore');
const crypto = require('crypto');
const {
    isLastWorkerInSwarm,
    writeToHiveMind,
    emitWorkerStart,
    finalizeLastWorker,
    finalizeNonLastWorker,
    executeBrowserWorker,
    executeTerminalWorker,
    executeLLMWorker
} = require('./workerStrategies');

// ─── Random Worker Name Generator ─────────────────────────────────────────
// Give each worker instance a human first name
const WORKER_NAMES = [
    'Alice', 'Max', 'Luna', 'Oscar', 'Emma', 'Leo', 'Mia', 'Finn',
    'Nora', 'Sam', 'Ivy', 'Kai', 'Zoe', 'Eli', 'Ruby', 'Theo',
    'Ava', 'Noah', 'Lily', 'Jack', 'Iris', 'Luca', 'Maya', 'Hugo',
    'Ella', 'Adam', 'Sara', 'Ryan', 'Cleo', 'Axel', 'Nina', 'Cole',
    'Eva', 'Milo', 'Jade', 'Owen', 'Rosa', 'Dean', 'Vera', 'Quinn',
    'Lena', 'Felix', 'Clara', 'Ravi', 'Lyra', 'Sven', 'Alma', 'Troy',
    'Aria', 'Vince', 'Petra', 'Blake', 'Stella', 'Rio', 'Freya', 'Miles',
    'Nadia', 'Dante', 'Elsa', 'Rex', 'Tara', 'Jasper', 'Wren', 'Piper',
    'Greta', 'Ruben', 'Flora', 'Cedric', 'Hana', 'Erik', 'Olive', 'Marco',
    'Daphne', 'Leon', 'Hazel', 'Silas', 'Thea', 'Lars', 'Poppy', 'Rowan'
];
const usedWorkerNames = new Set();

function generateWorkerInstanceName() {
    // Try to pick a unique name
    const shuffled = [...WORKER_NAMES].sort(() => Math.random() - 0.5);
    for (const name of shuffled) {
        if (!usedWorkerNames.has(name)) {
            usedWorkerNames.add(name);
            return name;
        }
    }
    // Fallback if all 80 names used
    return `Agent-${crypto.randomBytes(3).toString('hex')}`;
}

// Process template tags in prompts — replaces {tag} with actual swarm data
function processPromptTags(prompt, swarm) {
    const phases = swarm.phases || [];
    const allWorkers = [];
    phases.forEach(phase => {
        (phase.agents || []).forEach(a => {
            allWorkers.push({ name: a.name, role: a.role, phase: phase.name, description: a.description || '' });
        });
    });

    const lastPhase = phases[phases.length - 1];
    const lastWorker = lastPhase?.agents?.[lastPhase.agents.length - 1];

    const now = new Date();
    const dateOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const dateTimeOptions = { ...dateOptions, hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true };

    const replacements = {
        '{swarm_name}': swarm.name || 'Swarm',
        '{swarm_description}': swarm.description || '',
        '{workers}': allWorkers.map(w => `- ${w.name} (${w.role}): ${w.description} [Phase: ${w.phase}]`).join('\n'),
        '{worker_list}': allWorkers.map(w => w.name).join(', '),
        '{phases}': phases.map((p, i) => `${i + 1}. ${p.name}: ${p.description || 'No description'}`).join('\n'),
        '{phase_list}': phases.map(p => p.name).join(', '),
        '{last_worker}': lastWorker?.name || 'last worker',
        '{last_phase}': lastPhase?.name || 'last phase',
        '{phase_count}': String(phases.length),
        '{worker_count}': String(allWorkers.length),
        '{Date}': now.toLocaleDateString('en-US', dateOptions),
        '{Time}': now.toLocaleTimeString('en-US'),
        '{DateTime}': now.toLocaleString('en-US', dateTimeOptions),
    };

    let result = prompt;
    for (const [tag, value] of Object.entries(replacements)) {
        result = result.replaceAll(tag, value);
    }
    return result;
}

// Generate the system prompt for the main Orchestrator Agent
// This is a minimal identity prompt — generatePhasePrompt replaces it on every iteration
function generateOrchestratorPrompt(swarm) {
    let prompt = `You are the ${swarm.name} Orchestrator. ${swarm.description || ''}
You coordinate workers to fulfill the user's request. You will receive phase-specific instructions.`;

    if (swarm.system_prompt && swarm.system_prompt.trim()) {
        const processedCustomPrompt = processPromptTags(swarm.system_prompt.trim(), swarm);
        prompt = processedCustomPrompt + '\n\n' + prompt;
    }

    return prompt;
}



// Generate tool definitions for a SPECIFIC phase only
function getSwarmToolsForPhase(swarm, phaseIndex) {
    const phases = swarm.phases || [];
    const phase = phases[phaseIndex];
    if (!phase || !phase.agents) return [];

    return phase.agents.filter(a => a.enabled !== false).map(agent => {
        const workerKey = agent.role || agent.name.toLowerCase().replace(/\s+/g, '_');
        const toolName = `worker_${workerKey}`;
        const isBrowser = agent.type === 'browser';

        return {
            type: 'function',
            function: {
                name: toolName,
                description: isBrowser
                    ? `Call the ${agent.name} browser agent. It autonomously controls a web browser. Give it a clear browsing instruction.`
                    : `Call the ${agent.name} worker. ${agent.systemPrompt ? agent.systemPrompt.slice(0, 100) + '...' : agent.description || 'No description'}`,
                parameters: {
                    type: 'object',
                    properties: {
                        instruction: {
                            type: 'string',
                            description: isBrowser
                                ? `Browsing task for the ${agent.name}. Be specific about what URL to visit, what data to extract, or what actions to perform.`
                                : `Specific instruction for the ${agent.name}. Be detailed about the task but do NOT paste data — the worker pulls context from the Hive Mind.`
                        }
                    },
                    required: ['instruction']
                }
            }
        };
    });
}

// Generate a phase-specific system prompt for the orchestrator
// This is the ONLY prompt the orchestrator sees — scoped to the current phase only
function generatePhasePrompt(swarm, phaseIndex, previousPhaseResults = []) {
    const phases = swarm.phases || [];
    const currentPhase = phases[phaseIndex];
    const isLastPhase = phaseIndex === phases.length - 1;

    // Workers available in THIS phase only
    const workers = (currentPhase.agents || []).filter(a => a.enabled !== false).map(a => {
        const workerKey = a.role || a.name.toLowerCase().replace(/\s+/g, '_');
        return `  - worker_${workerKey}: ${a.name} — ${a.description || 'No description'}`;
    }).join('\n');

    // Hive Mind note for phases after the first
    let hiveMindNote = '';
    if (phaseIndex > 0) {
        hiveMindNote = `\n\n## 🐝 Hive Mind\nPrevious phases have stored findings in the Hive Mind.\nWorkers automatically receive this context — do NOT repeat or paste previous results.`;
    }

    // Phase completion instructions
    const completionInstructions = isLastPhase
        ? `\n\n## CRITICAL: Final Phase\nCall the worker with a short instruction — it already has all Hive Mind findings.\nAfter calling the worker, STOP. Do NOT write anything else.`
        : `\n\n## Phase Completion\nAfter dispatching all workers, respond with ONLY: "Phase complete."\nDo NOT summarize or elaborate.`;

    // Run-once instruction
    let runOnceNote = '';
    if (currentPhase.runOnce) {
        runOnceNote = `\n\n## IMPORTANT: Single Execution Mode\nEach worker in this phase must be called EXACTLY ONCE. Do NOT call any worker more than once. After all workers have been called once, immediately proceed to the next phase.`;
    }

    // Parallel execution instruction
    let parallelNote = '';
    if (currentPhase.parallel) {
        const workerCount = (currentPhase.agents || []).filter(a => a.enabled !== false).length;
        parallelNote = `\n\n## ⚡ PARALLEL EXECUTION MODE\nThis phase runs in parallel. You MUST call ALL ${workerCount} workers simultaneously in a SINGLE response.\nOutput ALL tool calls at once — do NOT wait for one worker to finish before calling the next.\nCall every worker in this phase in one batch.`;
    }

    let prompt = `You are the ${swarm.name} Orchestrator.\nPhase ${phaseIndex + 1} of ${phases.length}: ${currentPhase.name}\n${currentPhase.description || ''}\n\n## Workers\nYou can ONLY call these workers:\n${workers}\n\n## Rules\n- Give each worker a SHORT instruction (1-3 sentences). Be specific about what to do.\n- Do NOT paste data or context — workers pull from the Hive Mind.\n- No commentary between tool calls. Call workers, then stop.${hiveMindNote}${runOnceNote}${parallelNote}${completionInstructions}`;

    // Prepend custom system prompt if set
    if (swarm.system_prompt && swarm.system_prompt.trim()) {
        const processedCustomPrompt = processPromptTags(swarm.system_prompt.trim(), swarm);
        prompt = processedCustomPrompt + '\n\n' + prompt;
    }

    return prompt;
}

// Execute a specific worker
// Thin dispatcher that delegates to the appropriate strategy (browser, terminal, or LLM)
async function executeWorker(workerKey, instruction, context, swarmId, userAuth, toolExecutor, onEvent = () => { }, brain = null, signal = null) {
    // 1. Resolve swarm and worker config
    const swarm = swarmStore.getSwarm(swarmId);
    if (!swarm) throw new Error(`Swarm ${swarmId} not found`);

    let workerConfig = null;
    let workerPhase = null;

    // Find the worker — try direct key, then with 'worker_' prefix stripped
    for (const key of [workerKey, workerKey.replace(/^worker_/, '')]) {
        for (const phase of swarm.phases || []) {
            const found = phase.agents?.find(a =>
                (a.role === key) ||
                (a.name.toLowerCase().replace(/\s+/g, '_') === key)
            );
            if (found) {
                workerConfig = found;
                workerPhase = phase;
                break;
            }
        }
        if (workerConfig) break;
    }

    if (!workerConfig) throw new Error(`Worker ${workerKey} not found in swarm ${swarm.name}`);

    // 2. Shared lifecycle: detect last worker, generate instance ID, emit start events
    const isLastWorkerByPosition = isLastWorkerInSwarm(swarm, workerConfig, workerPhase);
    // Terminal and browser workers should never stream directly to the user —
    // only LLM workers get that behavior. Terminal/browser always write to hive mind.
    const isNonLLMWorker = workerConfig.type === 'browser' || workerConfig.type === 'terminal';
    const isLastWorker = isLastWorkerByPosition && !isNonLLMWorker;
    const instanceId = generateWorkerInstanceName();
    const workerType = workerConfig.type === 'browser' ? 'browser'
        : workerConfig.type === 'terminal' ? 'terminal'
            : null;

    if (isLastWorker) {
        console.log(`[WorkerExecutor] 🎯 ${workerConfig.name} is the LAST worker in the LAST phase — will stream directly to user`);
    } else if (isLastWorkerByPosition && isNonLLMWorker) {
        console.log(`[WorkerExecutor] ${workerConfig.name} is last by position but is a ${workerConfig.type} worker — will write to hive mind instead of streaming`);
    } else {
        const phases = swarm.phases || [];
        console.log(`[WorkerExecutor] ${workerConfig.name} — not last worker (phaseIdx: ${phases.indexOf(workerPhase)}, lastPhaseIdx: ${phases.length - 1})`);
    }

    emitWorkerStart(workerConfig, workerPhase, instanceId, instruction, onEvent, workerType);

    // 3. Delegate to the appropriate strategy
    const strategyContext = {
        swarm, swarmId, workerPhase, instanceId, userAuth,
        toolExecutor, onEvent, brain, signal,
        processPromptTags, isLastWorker
    };

    let result;
    if (workerConfig.type === 'browser' && workerConfig.browserAgentId) {
        result = await executeBrowserWorker(workerConfig, instruction, strategyContext);
    } else if (workerConfig.type === 'terminal' && workerConfig.terminalAgentId) {
        result = await executeTerminalWorker(workerConfig, instruction, strategyContext);
    } else {
        result = await executeLLMWorker(workerConfig, instruction, strategyContext);
    }

    // 4. Shared lifecycle: write to Hive Mind, finalize result
    // For LLM workers that already returned a direct-streamed marker, handle brain write
    if (result?.__direct_streamed__) {
        writeToHiveMind(brain, workerConfig, workerPhase, result.content, onEvent);
        return result;
    }

    // For browser/terminal strategies (and non-last LLM workers) — always write to hive mind
    writeToHiveMind(brain, workerConfig, workerPhase, result, onEvent);

    if (isLastWorker) {
        return finalizeLastWorker(workerConfig, instanceId, result, onEvent);
    }

    return finalizeNonLastWorker(workerConfig, instanceId, result, onEvent);
}

module.exports = {
    generateOrchestratorPrompt,
    getSwarmToolsForPhase,
    generatePhasePrompt,
    executeWorker
};
