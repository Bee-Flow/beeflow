/**
 * Automations as agent tools — §28.
 *
 * When a routine declares trigger.kind === 'agent_call', it becomes
 * addressable from agents and direct chat as a function-calling tool.
 * The agent calls `automation_<id>` with structured arguments; this
 * module renders the per-tool schema from the automation's declared
 * input shape and invokes the runner with those arguments as the
 * trigger payload.
 *
 * Public API:
 *   - getAgentCallableToolsForUser(userId) → tool[] suitable for
 *     dropping into the agent runtime's tool list.
 *   - dispatchAgentCallableTool(toolName, args, ctx) → invokes the
 *     automation synchronously and returns the run's final output.
 *
 * The tool catalog (server/automation/toolRegistry.js) doesn't list
 * these — they're per-user and per-automation, so they're discovered
 * dynamically at agent-runtime construction time. Phase 2 work moves
 * them into the unified catalog (§15).
 */

const automationStore = require('../stores/automationStore');

/**
 * Convert an automation into the OpenAI/Anthropic-shaped function
 * schema the agent runtime expects.
 */
function automationToTool(automation) {
    if (!automation || !automation.definition) return null;
    const trigger = automation.definition.trigger;
    if (!trigger || trigger.kind !== 'agent_call') return null;

    const toolName = sanitizeToolName(trigger.toolName || `automation_${automation.id}`);
    const description = trigger.description
        || automation.description
        || `Run the "${automation.title || 'Untitled automation'}" routine.`;
    const parameters = normalizeParameters(trigger.parametersSchema);

    return {
        type: 'function',
        function: {
            name: toolName,
            description,
            parameters,
        },
        // Non-standard metadata used by the dispatcher to route the call
        // back to the right automation. Not sent to the LLM.
        __automation: {
            id: automation.id,
            userId: automation.userId,
            organizationId: automation.organizationId || null,
        },
    };
}

/**
 * List every agent-callable automation owned by the user (or shared
 * with their org, per the automation visibility rules), shaped as
 * function tools ready to register with the agent.
 */
async function getAgentCallableToolsForUser(userId) {
    if (!userId) return [];
    const list = await automationStore.getAutomationsForUser(userId).catch(() => []);
    const tools = [];
    for (const a of list) {
        if (!a?.isActive) continue;
        const tool = automationToTool(a);
        if (tool) tools.push(tool);
    }
    return tools;
}

/**
 * Invoke an agent-callable automation. The runner runs synchronously
 * (no scheduler hop) and the final step's output is returned verbatim
 * to the calling agent.
 *
 * `ctx` carries the caller identity — the user the agent is acting on
 * behalf of. Enforced by the runner's permission catalog re-check.
 */
async function dispatchAgentCallableTool(toolMeta, args, ctx) {
    if (!toolMeta?.id) throw new Error('dispatchAgentCallableTool: missing automation id');
    const automation = await automationStore.getAutomation(toolMeta.id);
    if (!automation) throw new Error(`Automation ${toolMeta.id} not found`);
    if (automation.userId !== (ctx?.userId || toolMeta.userId)) {
        throw new Error('Forbidden: caller does not own the automation');
    }
    if (!automation.isActive) {
        throw new Error('Automation is not active — activate it first or use the manual run endpoint.');
    }

    // Lazy-require the runner so this module stays loadable from any
    // path (the runner pulls in db connections that would otherwise
    // bind at module-load time).
    const automationRunner = require('../core/automationRunner');
    const result = await automationRunner.executeAutomation(automation, {
        triggerKind: 'agent_call',
        triggerPayload: args || {},
        mode: 'live',
    });
    return result?.lastOutput ?? null;
}

function sanitizeToolName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64) || 'automation_unnamed';
}

function normalizeParameters(schema) {
    // Builder gives us a JSON-schema-like object. Default to "any object"
    // when the routine author hasn't declared one yet — the agent will
    // still be able to call with arbitrary keys, validated downstream.
    if (schema && typeof schema === 'object' && schema.type === 'object') return schema;
    return {
        type: 'object',
        properties: {},
        additionalProperties: true,
    };
}

module.exports = {
    automationToTool,
    getAgentCallableToolsForUser,
    dispatchAgentCallableTool,
};
