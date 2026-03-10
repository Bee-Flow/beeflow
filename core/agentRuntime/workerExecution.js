/**
 * Worker execution — runs individual swarm workers with their tools
 */
const componentManager = require('../componentManager');
const swarmStore = require('../../stores/swarmStore');
const swarmOrchestrator = require('../../agents/swarm/orchestrator');
const { executeComponentTool } = require('../toolExecution');

async function executeWorkerTool(toolName, args, swarmId, userAuth, onEvent, brain = null, signal = null) {
    // Expected toolName format: worker_{workerKey}
    const workerKey = toolName.replace(/^worker_/, '');
    const { instruction, context } = args;

    // Look up the worker config to get its configured tools list and params
    const swarm = await swarmStore.getSwarm(swarmId);
    let workerToolIds = null;
    let workerToolParams = {}; // { 'tavily-search': { apiKey: '...' } }
    if (swarm) {
        for (const phase of swarm.phases || []) {
            const found = phase.agents?.find(a =>
                (a.role === workerKey) ||
                (a.name.toLowerCase().replace(/\s+/g, '_') === workerKey)
            );
            if (found) {
                if (found.tools && found.tools.length > 0) {
                    workerToolIds = found.tools; // e.g. ['tavily-search']
                }
                if (found.toolParams) {
                    workerToolParams = found.toolParams; // e.g. { 'tavily-search': { apiKey: '...' } }
                }
                break;
            }
        }
    }

    let components = [];

    // Only give the worker its configured tools — no tools configured means no tools available
    if (workerToolIds && workerToolIds.length > 0) {
        const allComponents = componentManager.getComponents();
        components = allComponents.filter(c => workerToolIds.includes(c.id));
        console.log(`[WorkerExecutor] Filtered tools for ${workerKey}: ${components.map(c => c.id).join(', ')}`);
    } else {
        console.log(`[WorkerExecutor] No tools configured for ${workerKey} — running without tools`);
    }

    // Convert components to OpenAI tool definitions
    // Strip out any params that are pre-configured (fixedParams) so the AI doesn't see them
    // toolParams format: { 'tavily-search': { apiKey: { value: '...', fixed: true }, query: { fixed: false } } }
    // We need to flatten: only include params with fixed === true, using their .value
    const flattenFixedParams = (rawParams) => {
        const flat = {};
        for (const [key, conf] of Object.entries(rawParams || {})) {
            if (conf && conf.fixed && conf.value !== undefined) {
                flat[key] = conf.value;
            }
        }
        return flat;
    };

    const toolDefinitions = components.map(c => {
        const rawParamsForTool = workerToolParams[c.id] || {};
        const fixedFlat = flattenFixedParams(rawParamsForTool);
        const fixedParamNames = Object.keys(fixedFlat);

        return {
            type: 'function',
            function: {
                name: c.id,
                description: c.description || c.name,
                parameters: {
                    type: 'object',
                    properties: c.definition?.inputs ?
                        Object.entries(c.definition.inputs)
                            .filter(([key]) => !fixedParamNames.includes(key)) // hide fixed params from AI
                            .reduce((acc, [key, conf]) => {
                                acc[key] = {
                                    type: conf.type || 'string',
                                    description: conf.description || ''
                                };
                                return acc;
                            }, {})
                        : {},
                    required: c.definition?.inputs ?
                        Object.entries(c.definition.inputs)
                            .filter(([key, conf]) => conf.required && !fixedParamNames.includes(key))
                            .map(([key]) => key)
                        : []
                }
            }
        };
    });

    const toolExecutor = {
        definitions: toolDefinitions,
        execute: async (name, args) => {
            const rawParamsForTool = workerToolParams[name] || {};
            const fixedParams = flattenFixedParams(rawParamsForTool);
            console.log(`[WorkerExecutor] Calling component: ${name}`, Object.keys(fixedParams).length > 0 ? `(with ${Object.keys(fixedParams).length} fixed params: ${Object.keys(fixedParams).join(', ')})` : '');
            return await executeComponentTool(name, args, userAuth, fixedParams, swarmId);
        }
    };

    // Use the orchestrator helper — pass brain for shared knowledge
    return await swarmOrchestrator.executeWorker(workerKey, instruction, context, swarmId, userAuth, toolExecutor, onEvent, brain, signal);
}

module.exports = { executeWorkerTool };
