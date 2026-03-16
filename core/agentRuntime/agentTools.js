/**
 * Agent tool loading — builds tool definitions for agents and swarms
 */
const componentManager = require('../componentManager');
const agentStore = require('../../stores/agentStore');
const swarmStore = require('../../stores/swarmStore');
const swarmOrchestrator = require('../../agents/swarm/orchestrator');
const { componentToTool, SYSTEM_TOOLS } = require('../toolExecution');


async function getAgentTools(agentId) {
    // Check if it's a swarm first
    const swarm = await swarmStore.getSwarm(agentId);
    if (swarm) {
        return swarmOrchestrator.getSwarmTools(swarm);
    }

    const componentIds = await agentStore.getAgentTools(agentId);
    const allComponents = componentManager.getComponents();
    const workflowStore = require('../../stores/workflowStore');

    // Filter to only agent-enabled components
    const agentEnabledComponents = allComponents.filter(c => c.definition?.agentEnabled !== false);

    // Get subworkflows as virtual components
    let subworkflowComponents = [];
    try {
        const allWorkflows = await workflowStore.getAllWorkflows();
        const subworkflows = allWorkflows.filter(wf => {
            return wf.nodes?.some(n =>
                n.type === 'trigger-subworkflow' ||
                n.data?.componentId === 'trigger-subworkflow'
            );
        });

        subworkflowComponents = subworkflows.map(wf => {
            const triggerNode = wf.nodes.find(n =>
                n.type === 'trigger-subworkflow' ||
                n.data?.componentId === 'trigger-subworkflow'
            );
            const triggerInputs = triggerNode?.data?.inputValues || {};
            const workflowDescription = triggerInputs.workflowDescription ||
                wf.description ||
                `Subworkflow: ${wf.name || wf.id}`;

            // Build inputs from defined parameters
            const inputs = {};
            if (Array.isArray(triggerInputs.inputs) && triggerInputs.inputs.length > 0) {
                for (const input of triggerInputs.inputs) {
                    if (input.name) {
                        inputs[input.name] = {
                            type: input.type || 'string',
                            description: input.description || `Input: ${input.name}`
                        };
                    }
                }
            } else {
                inputs.inputData = {
                    type: 'object',
                    description: 'Data to pass to the subworkflow'
                };
            }

            return {
                id: `subworkflow-${wf.id}`,
                definition: {
                    name: `📁 ${wf.name || 'Unnamed Workflow'}`,
                    description: workflowDescription,
                    inputs: inputs,
                    agentEnabled: true
                }
            };
        });
    } catch (e) {
        console.error('Failed to load subworkflows for agent:', e);
    }

    // Combine real components and subworkflow virtual components
    const allAvailable = [...agentEnabledComponents, ...subworkflowComponents];

    // Select components based on agent config
    // Also load fixed params to filter them from tool schema
    const toolConfigs = await agentStore.getAgentToolsWithParams(agentId);
    const fixedParamsMap = {};
    for (const tc of toolConfigs) {
        if (tc.params) {
            fixedParamsMap[tc.componentId] = tc.params;
        }
    }

    let tools = [];
    if (componentIds.length > 0) {
        const selectedComponents = allAvailable.filter(c => componentIds.includes(c.id));
        tools = selectedComponents.map(c => componentToTool(c, fixedParamsMap[c.id] || null));
    }

    // Inject System Tools (Restricted to AI Component Designer)
    // These tools allow modifications to the codebase and must be protected.
    const AI_COMPONENT_DESIGNER_AGENT_ID = 'system-component-designer';
    if (agentId === AI_COMPONENT_DESIGNER_AGENT_ID) {
        tools.push(...SYSTEM_TOOLS);
    }



    return tools;
}

async function getAvailableComponents() {
    const components = componentManager.getComponents();
    const workflowStore = require('../../stores/workflowStore');

    // Filter to only agent-enabled components
    const componentList = components
        .filter(c => c.definition?.agentEnabled !== false)
        .map(c => ({
            id: c.id,
            name: c.definition?.name || c.id,
            description: c.definition?.description || '',
            category: c.definition?.category || 'Uncategorized',
            inputs: c.definition?.inputs || {}
        }));

    // Get all workflows with subworkflow triggers (virtual components)
    try {
        const allWorkflows = await workflowStore.getAllWorkflows();
        const subworkflows = allWorkflows.filter(wf => {
            return wf.nodes?.some(n =>
                n.type === 'trigger-subworkflow' ||
                n.data?.componentId === 'trigger-subworkflow'
            );
        });

        // Add each subworkflow as a virtual component
        for (const wf of subworkflows) {
            // Find the trigger node to get input schema
            const triggerNode = wf.nodes.find(n =>
                n.type === 'trigger-subworkflow' ||
                n.data?.componentId === 'trigger-subworkflow'
            );

            // Extract user-defined description and input schema from trigger node
            const triggerInputs = triggerNode?.data?.inputValues || {};
            const workflowDescription = triggerInputs.workflowDescription ||
                wf.description ||
                `Subworkflow: ${wf.name || wf.id}. Runs this workflow with provided inputs.`;

            // Parse inputSchema if defined
            let inputsSchema = {
                inputData: {
                    type: 'object',
                    default: {},
                    description: 'Data to pass to the subworkflow'
                }
            };

            // Check for array-based inputs format (new visual builder)
            if (Array.isArray(triggerInputs.inputs) && triggerInputs.inputs.length > 0) {
                inputsSchema = {};
                for (const input of triggerInputs.inputs) {
                    if (input.name) {
                        inputsSchema[input.name] = {
                            type: input.type || 'string',
                            description: input.description || `Input parameter: ${input.name}`,
                            required: input.required || false
                        };
                    }
                }
            }
            // Legacy: JSON string format
            else if (triggerInputs.inputSchema) {
                try {
                    const userSchema = JSON.parse(triggerInputs.inputSchema);
                    inputsSchema = {};
                    for (const [key, valueType] of Object.entries(userSchema)) {
                        inputsSchema[key] = {
                            type: valueType,
                            description: `Input parameter: ${key} (${valueType})`
                        };
                    }
                } catch (e) {
                    // Keep default if parsing fails
                }
            }

            componentList.push({
                id: `subworkflow-${wf.id}`,
                name: `📁 ${wf.name || 'Unnamed Workflow'}`,
                description: workflowDescription,
                category: 'Subworkflows',
                inputs: inputsSchema,
                isSubworkflow: true,
                workflowId: wf.id
            });
        }
    } catch (e) {
        console.error('Failed to load subworkflows:', e);
    }

    return componentList;
}

module.exports = { getAgentTools, getAvailableComponents };
