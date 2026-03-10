/**
 * Pipeline Tool Helpers
 * Tool definitions and execution for component pipeline workers.
 */

const { executeComponentTool, SYSTEM_TOOLS, componentToTool } = require('../core/agentRuntime');
const agentStore = require('../stores/agentStore');
const componentManager = require('../core/componentManager');

/**
 * Get search tools (tavily_search) for research workers.
 */
function getSearchTools() {
    const allComponents = componentManager.getComponents();
    const tavilyComponent = allComponents.find(c => c.id === 'tavily_search' || c.id === 'tavily-search');
    return tavilyComponent ? [componentToTool(tavilyComponent)] : [];
}

/**
 * Get all builder tools (system tools + designer-agent component tools).
 */
async function getBuilderTools() {
    let tools = [...SYSTEM_TOOLS];

    try {
        const designerAgentId = 'system-component-designer';
        const agentToolIds = await agentStore.getAgentTools(designerAgentId);
        if (agentToolIds && agentToolIds.length > 0) {
            const allComponents = componentManager.getComponents();
            const designerComponents = allComponents.filter(c =>
                agentToolIds.includes(c.id) && c.definition?.agentEnabled !== false
            );
            tools.push(...designerComponents.map(componentToTool));
        }
    } catch (e) {
        console.warn('[Swarm] Failed to load designer tools:', e.message);
    }
    return tools;
}

/**
 * Execute tool calls from an LLM response in parallel.
 * Returns array of { tc, result } objects.
 */
async function executeToolCalls(toolCalls, onEvent, workerKey, phase = null) {
    const toolPromises = toolCalls.map(async (tc) => {
        const toolName = tc.function.name;
        let toolArgs = {};
        try { toolArgs = JSON.parse(tc.function.arguments || '{}'); } catch { }

        onEvent('worker_tool', { worker: workerKey, tool: toolName, args: toolArgs, phase });
        console.log(`[Swarm] ${workerKey} (Phase: ${phase || 'unknown'}) → tool: ${toolName}`);

        try {
            const result = await executeComponentTool(toolName, toolArgs, {}, null);
            const resultStr = JSON.stringify(result);
            onEvent('worker_tool_result', {
                worker: workerKey,
                tool: toolName,
                preview: resultStr.length > 500 ? resultStr.slice(0, 500) + '…' : resultStr,
                length: resultStr.length,
                phase
            });
            return { tc, result: resultStr };
        } catch (e) {
            onEvent('worker_tool_result', {
                worker: workerKey,
                tool: toolName,
                preview: `Error: ${e.message}`,
                length: 0,
                isError: true,
                phase
            });
            return { tc, result: JSON.stringify({ error: e.message }) };
        }
    });

    return await Promise.all(toolPromises);
}

module.exports = {
    getSearchTools,
    getBuilderTools,
    executeToolCalls,
    // Re-export for convenience
    executeComponentTool,
    componentToTool
};
