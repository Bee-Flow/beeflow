/**
 * Tool Execution — Component/system tool management and execution
 * 
 * Extracted from agentRuntime.js.
 * Handles converting components to OpenAI tool format, executing component tools,
 * and managing system tools (for the AI Component Designer agent).
 */

const componentManager = require('./componentManager');
const executionEngine = require('./executionEngine');
const fs = require('fs');
const path = require('path');

// Convert a component to OpenAI tool format
// fixedParams is an object { paramName: value } - these params are hidden from AI
function componentToTool(component, fixedParams = null) {
    const rawInputs = component.definition?.inputs || {};
    const properties = {};
    const required = [];

    const isJsonSchemaFormat = rawInputs.type === 'object' && rawInputs.properties;
    const inputFields = isJsonSchemaFormat ? rawInputs.properties : rawInputs;
    const schemaRequired = isJsonSchemaFormat ? (rawInputs.required || []) : [];

    const fixedParamNames = fixedParams ? Object.keys(fixedParams) : [];

    for (const [name, config] of Object.entries(inputFields)) {
        if (fixedParamNames.includes(name)) continue;

        const type = typeof config === 'string' ? config : config.type;
        let jsonType = 'string';

        if (type === 'number' || type === 'integer') jsonType = 'number';
        else if (type === 'boolean') jsonType = 'boolean';
        else if (type === 'object' || type === 'json') jsonType = 'object';
        else if (type === 'array') jsonType = 'array';

        properties[name] = {
            type: jsonType,
            description: typeof config === 'object' && config.description
                ? config.description
                : `Input: ${name}`
        };

        if (isJsonSchemaFormat) {
            if (schemaRequired.includes(name)) {
                required.push(name);
            }
        } else if (typeof config !== 'object' || config.default === undefined) {
            required.push(name);
        }
    }

    return {
        type: 'function',
        function: {
            name: component.id.replace(/-/g, '_'),
            description: component.definition?.description || `Execute ${component.definition?.name || component.id}`,
            parameters: {
                type: 'object',
                properties,
                required
            }
        }
    };
}

// System Tools — only available to AI Component Designer agent
const SYSTEM_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'read_component_files',
            description: 'Read all source files of a component. Use this before updating a component to understand its structure.',
            parameters: {
                type: 'object',
                properties: {
                    componentId: { type: 'string', description: 'The ID of the component to read' }
                },
                required: ['componentId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'update_component',
            description: 'Update the files of an existing component. Replaces content of specified files.',
            parameters: {
                type: 'object',
                properties: {
                    componentId: { type: 'string', description: 'The ID of the component to update' },
                    files: {
                        type: 'object',
                        description: 'Map of filename to new content. e.g. { "index.js": "..." }',
                        additionalProperties: { type: 'string' }
                    }
                },
                required: ['componentId', 'files']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'update_component_outputs',
            description: 'Update the outputs schema and sample output for a component. Use this after executing a component to define its structured output.',
            parameters: {
                type: 'object',
                properties: {
                    componentId: { type: 'string', description: 'The ID of the component to update' },
                    outputs: {
                        type: 'object',
                        description: 'JSON Schema object defining the outputs (e.g. { "summary": { "type": "string" } })'
                    },
                    sampleOutput: {
                        type: 'object',
                        description: 'The actual JSON output sample from a test run'
                    }
                },
                required: ['componentId', 'outputs']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'execute_component',
            description: 'Execute any available component by ID. Use this to test a component after creating it.',
            parameters: {
                type: 'object',
                properties: {
                    componentId: { type: 'string', description: 'The ID of the component to execute' },
                    inputs: {
                        type: 'object',
                        description: 'Input values for the component execution'
                    }
                },
                required: ['componentId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'configure_outputs_interaction',
            description: 'Trigger an interactive UI for the user to select and rename component outputs. Use this immediately after getting an execution result.',
            parameters: {
                type: 'object',
                properties: {
                    componentId: { type: 'string', description: 'The ID of the component' },
                    sampleOutput: {
                        type: 'object',
                        description: 'The JSON result from the execution'
                    }
                },
                required: ['componentId', 'sampleOutput']
            }
        }
    }
];

// Execute System Tools
async function executeSystemTool(name, args) {
    console.log(`[AgentRuntime] Executing system tool: ${name}`);

    if (name === 'read_component_files') {
        try {
            const files = componentManager.readComponentFiles(args.componentId);
            return {
                message: `Successfully read ${Object.keys(files).length} files from ${args.componentId}`,
                files: files
            };
        } catch (e) {
            return { error: e.message };
        }
    }

    if (name === 'update_component') {
        try {
            const result = await componentManager.updateComponent(args.componentId, args.files);
            return result;
        } catch (e) {
            return { error: e.message };
        }
    }

    if (name === 'execute_component') {
        try {
            const result = await executeComponentTool(args.componentId.replace(/-/g, '_'), args.inputs || {});
            return result;
        } catch (e) {
            return { error: e.message };
        }
    }

    if (name === 'update_component_outputs') {
        try {
            const { componentId, outputs, sampleOutput } = args;

            const componentPath = componentManager.getComponentPath(componentId);
            if (!componentPath) {
                return { error: `Component ${componentId} not found` };
            }

            const componentJsonPath = path.join(componentPath, 'component.json');
            if (!fs.existsSync(componentJsonPath)) {
                return { error: `component.json not found for ${componentId}` };
            }

            const componentDef = JSON.parse(fs.readFileSync(componentJsonPath, 'utf8'));
            componentDef.outputs = outputs;
            if (sampleOutput) {
                componentDef.sampleOutput = sampleOutput;
            }

            fs.writeFileSync(componentJsonPath, JSON.stringify(componentDef, null, 2));
            componentManager.reloadComponent(componentId);

            return { success: true, message: `Updated outputs for component ${componentId}` };
        } catch (e) {
            return { error: e.message };
        }
    }

    if (name === 'configure_outputs_interaction') {
        return {
            success: true,
            _action: 'SHOW_OUTPUT_SELECTOR',
            message: 'Interactive output selection UI triggered for user.'
        };
    }

    return { error: `System tool ${name} not found` };
}

// Execute a component as a tool
// fixedParams are merged on top of AI-chosen args (fixed params override)
async function executeComponentTool(toolName, args, userAuth = {}, fixedParams = null, agentId = null) {
    // Check for System Tools first
    if (SYSTEM_TOOLS.some(t => t.function.name === toolName)) {
        const AI_COMPONENT_DESIGNER_AGENT_ID = 'system-component-designer';
        if (agentId && agentId !== AI_COMPONENT_DESIGNER_AGENT_ID) {
            return { error: `Access Denied: Agent '${agentId}' is not authorized to use system tool '${toolName}'.` };
        }
        return executeSystemTool(toolName, args);
    }

    // Check for MCP tools (prefixed with "mcp_")
    if (toolName.startsWith('mcp_')) {
        try {
            const mcpManager = require('./mcpManager');
            const userId = userAuth?.userId || userAuth?.user_id || null;
            const result = await mcpManager.callToolByPrefixedName(toolName, args || {}, userId);
            return { result: typeof result === 'string' ? result : JSON.stringify(result) };
        } catch (err) {
            console.error(`[MCP] Tool call failed for ${toolName}:`, err.message);
            return { error: `MCP tool error: ${err.message}` };
        }
    }

    const componentId = toolName.replace(/_/g, '-');

    // Check if this is a subworkflow (virtual component)
    if (componentId.startsWith('subworkflow-')) {
        const workflowId = componentId.replace('subworkflow-', '');
        const workflowStore = require('../stores/workflowStore');

        try {
            const workflow = workflowStore.getWorkflowById(workflowId);
            if (!workflow) {
                return { error: `Subworkflow '${workflowId}' not found` };
            }

            const finalArgs = { ...(args || {}), ...(fixedParams || {}) };
            const workflowCopy = JSON.parse(JSON.stringify(workflow));
            const triggerNode = workflowCopy.nodes.find(n =>
                n.type === 'trigger-subworkflow' ||
                n.data?.componentId === 'trigger-subworkflow'
            );

            if (triggerNode) {
                triggerNode.data = triggerNode.data || {};
                triggerNode.data.inputValues = {
                    ...(triggerNode.data.inputValues || {}),
                    inputData: finalArgs.inputData || finalArgs,
                    _triggerType: 'agent',
                    _callerId: 'ai-agent'
                };
            }

            const result = await executionEngine.executeWorkflow(workflowCopy, userAuth);
            return { success: true, result };
        } catch (error) {
            return { error: error.message };
        }
    }

    const components = componentManager.getComponents();
    const component = components.find(c => c.id === componentId);

    if (!component) {
        // Common hallucination when no web-search tool is registered: the
        // model invents a `search` / `web_search` / `google_search` call.
        // Convert that into actionable feedback instead of leaking the
        // internal "Component" abstraction.
        const SEARCH_HALLUCINATIONS = new Set(['search', 'web-search', 'google-search', 'bing-search', 'serper-search']);
        if (SEARCH_HALLUCINATIONS.has(componentId)) {
            return { error: `No web-search tool is currently available. An admin needs to configure Agent Search (Admin → AI Config → Agent Search) — either set SEARCH_SERVICE_URL, or set search_provider=node-search with a serper_api_key.` };
        }
        return { error: `Unknown tool '${toolName}'. The agent attempted to call a tool that is not registered for this session.` };
    }

    // Start with default values from component definition
    const defaultArgs = {};
    const inputDefs = component.definition?.inputs || {};
    for (const [name, config] of Object.entries(inputDefs)) {
        if (typeof config === 'object' && config.default !== undefined) {
            defaultArgs[name] = config.default;
        }
    }

    // Merge: defaults -> AI args -> fixed params (later overrides earlier)
    const finalArgs = { ...defaultArgs, ...(args || {}), ...(fixedParams || {}) };

    const workflow = {
        nodes: [{
            id: 'tool-node',
            type: componentId,
            data: { inputs: finalArgs }
        }],
        edges: []
    };

    try {
        const result = await executionEngine.executeWorkflow(workflow, userAuth);
        return result['tool-node'] || { success: true };
    } catch (error) {
        return { error: error.message };
    }
}

module.exports = {
    componentToTool,
    executeComponentTool,
    executeSystemTool,
    SYSTEM_TOOLS
};
