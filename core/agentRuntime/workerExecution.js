/**
 * Worker execution — runs individual swarm workers with their tools
 */
const componentManager = require('../componentManager');
// Legacy swarm modules removed — worker execution is dead code
// but kept as a stub to avoid breaking the import in chatStream.js
const { executeComponentTool } = require('../toolExecution');

async function executeWorkerTool(toolName, args, swarmId, userAuth, onEvent, brain = null, signal = null) {
    // Swarm workers have been removed — this function should never be called
    // since isSwarm is always false in chatStream.js and chatWithAgent.js
    console.warn(`[WorkerExecutor] Swarm worker execution called but swarms are removed: ${toolName}`);
    return { error: 'Swarm agents have been removed from this platform.' };
}

module.exports = { executeWorkerTool };
