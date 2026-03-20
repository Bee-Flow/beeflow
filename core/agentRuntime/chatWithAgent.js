/**
 * Non-streaming agent chat — synchronous tool-calling loop
 */
const { getAIConfig, getProviderForModel, resolveModelId } = require('../aiAgent');
const { getAdapter } = require('../providers');
const agentStore = require('../../stores/agentStore');
const swarmStore = require('../../stores/swarmStore');
const swarmOrchestrator = require('../../agents/swarm/orchestrator');
const HiveMind = require('../../agents/swarm/hiveMind');
const usageStore = require('../../stores/usageStore');
const { sanitizeToolResult } = require('../../utils/sanitize');
const { sanitizeMessages } = require('../../utils/messageUtils');
const { componentToTool, executeComponentTool } = require('../toolExecution');
const { resolveAgentModel } = require('./modelResolver');
const { getAgentTools } = require('./agentTools');
const { executeWorkerTool } = require('./workerExecution');
const { processSystemPrompt } = require('../promptUtils');
const { validateInput } = require('../moderation');
const { validateInputForPii } = require('../azurePiiDetection');

async function chatWithAgent(agentId, userId, userMessage, userAuth = {}) {
    // Check swarm first to prioritize virtual agent definition
    const swarm = await swarmStore.getSwarm(agentId);
    let agent = null;
    let isSwarm = false;
    let brain = null;

    if (swarm) {
        isSwarm = true;
        brain = new HiveMind(agentId);
        // Ensure placeholder exists for FKs
        await agentStore.ensurePlaceholderAgent(swarm.id, swarm.name, swarm.description);

        // Create Virtual Agent for the Swarm Orchestrator
        agent = {
            id: swarm.id,
            name: swarm.name,
            model: swarm.model || null, // Use swarm config or default
            system_prompt: swarmOrchestrator.generateOrchestratorPrompt(swarm),
            config: swarm.config
        };
    } else {
        agent = await agentStore.getAgent(agentId);
    }

    if (!agent) {
        throw new Error('Agent not found');
    }

    // Get the model to use - supports tier-based selection (tier:auto, tier:fast, etc.)
    const modelToUse = await resolveAgentModel(agent.model, userMessage, { ...(await getAIConfig()), organizationId: agent.organization_id, userOrgId: userAuth?.userOrgId });

    // Get the correct provider config for this model
    const config = await getProviderForModel(modelToUse);
    console.log(`[AgentRuntime] Using model: ${modelToUse} from provider: ${config.providerName || 'default'}`);

    const tools = await getAgentTools(agentId);

    // Load tool configs with fixed params
    // For Swarms, we don't have this yet, so empty map
    let toolParamsMap = {};
    if (!isSwarm) {
        const toolConfigs = await agentStore.getAgentToolsWithParams(agentId);
        for (const tc of toolConfigs) {
            // Convert component ID to tool name format (replace hyphens with underscores)
            const toolName = tc.componentId.replace(/-/g, '_');
            toolParamsMap[toolName] = tc.params;
        }
    }

    // Get or create conversation
    // For swarms, we use the same table but the ID is the swarm ID
    if (isSwarm) {
        await agentStore.ensurePlaceholderAgent(agent.id, agent.name, agent.description);
    }
    const conversation = await agentStore.getOrCreateConversation(agentId, userId);
    let messages = [...conversation.messages];

    // Add user message
    messages.push({ role: 'user', content: userMessage });

    // Build system prompt
    let systemPrompt = agent.system_prompt ||
        `You are a helpful AI assistant. You have access to various tools to help accomplish tasks. Use them when appropriate.`;

    // Process dynamic tags in system prompt
    systemPrompt = processSystemPrompt(systemPrompt);

    // Tool execution loop (max 10 iterations to prevent infinite loops)
    let iterations = 0;
    const maxIterations = 10;
    let toolCalls = [];

    if (agent.config?.llamaGuardEnabled || (await getAIConfig()).llamaGuardConfig?.enabled) {
        console.log(`[AgentRuntime] Validating input with active guardrails...`);
        const validationRequest = [
            { role: 'system', content: systemPrompt },
            ...messages
        ];



        // 2. Llama Guard Moderation
        await validateInput(validationRequest, agent.config?.llamaGuardEnabled);
    }

    // ── PII Detection ─────────────────────────────────────────────────
    const aiConfigForPii = await getAIConfig();
    if (aiConfigForPii?.piiDetectionEnabled) {
        try {
            await validateInputForPii(messages.slice(-3), false);
        } catch (piiError) {
            if (piiError.message?.includes('PII Detected')) {
                throw piiError; // Propagate to the route handler
            }
            // Service unavailable → fail-open
        }
    }

    // Enrich messages with form data context
    messages = enrichMessagesWithFormData(messages);

    while (iterations < maxIterations) {
        iterations++;

        try {
            const headers = { 'Content-Type': 'application/json' };
            const apiKey = config.apiKey;
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }

            // Build API URL - handle providers with /v1 in URL
            let apiUrl = config.url.replace(/\/$/, '');
            if (!apiUrl.endsWith('/v1')) {
                apiUrl = `${apiUrl}/v1`;
            }

            // Sanitize messages — Mistral rejects extra fields like parentId, id, etc.
            const sanitize = sanitizeMessages;

            // Use provider adapter for correct request body
            const adapter = getAdapter(null, apiUrl);
            const requestBody = adapter.buildRequestBody(modelToUse, [
                { role: 'system', content: systemPrompt },
                ...sanitize(messages)
            ], {
                maxTokens: 4000,
                temperature: 0.7,
                tools: tools.length > 0 ? tools : undefined,
                toolChoice: tools.length > 0 ? 'auto' : undefined,
            });

            const _callStart = Date.now();
            const response = await fetch(`${apiUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`AI API error: ${response.status} - ${error}`);
            }

            const data = await response.json();
            const choice = data.choices[0];
            const assistantMessage = choice.message;

            // Track usage
            if (data.usage) {
                await usageStore.logUsage({
                    user_id: userId,
                    agent_id: agentId,
                    agent_name: agent.name,
                    agent_type: isSwarm ? 'swarm' : 'chat',
                    model: modelToUse,
                    prompt_tokens: data.usage.prompt_tokens || 0,
                    completion_tokens: data.usage.completion_tokens || 0,
                    total_tokens: data.usage.total_tokens || 0,
                    source: isSwarm ? 'swarm_orchestrator' : 'agent_chat',
                    duration_ms: Date.now() - _callStart,
                    organization_id: agent.organization_id || null,
                    conversation_id: conversation?.id || null
                });
            }

            // Check if there are tool calls
            if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                // Add assistant message with tool calls
                messages.push(assistantMessage);

                // Execute each tool call
                // Execute tool calls in parallel to support swarm concurrency
                // We map each tool call to a promise that resolves to its result message
                const toolExecutionPromises = assistantMessage.tool_calls.map(async (toolCall) => {
                    const toolName = toolCall.function.name;
                    let toolArgs = {};

                    try {
                        toolArgs = JSON.parse(toolCall.function.arguments || '{}');
                    } catch (e) {
                        toolArgs = {};
                    }

                    // Get fixed params for this tool if any
                    const fixedParams = toolParamsMap[toolName] || null;

                    console.log(`[Agent] Executing tool: ${toolName}`, toolArgs, fixedParams ? `(with fixed: ${JSON.stringify(fixedParams)})` : '');

                    let toolResult;
                    try {
                        if (isSwarm && toolName.startsWith('worker_')) {
                            // Workers might take time, so parallel execution is key here
                            toolResult = await executeWorkerTool(toolName, toolArgs, agentId, userAuth, undefined, brain, signal);
                        } else {
                            // Use unified tool dispatcher — supports integrations + components
                            const { executeTool: dispatchTool } = require('../toolDispatcher');
                            toolResult = await dispatchTool(toolName, toolArgs, {
                                userId,
                                session: userAuth?.session,
                                userAuth,
                                fixedParams: fixedParams,
                                agentId,
                            });
                        }
                    } catch (err) {
                        console.error(`[Agent] Tool execution failed for ${toolName}:`, err);
                        toolResult = { error: err.message };
                    }

                    // Return the standardized tool result object and the tool message
                    return {
                        toolCallInfo: {
                            name: toolName,
                            args: toolArgs,
                            result: sanitizeToolResult(toolResult)
                        },
                        message: {
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
                        }
                    };
                });

                // Wait for all tools to complete
                const results = await Promise.all(toolExecutionPromises);

                // Add results to history and toolCalls array in order
                results.forEach(res => {
                    toolCalls.push(res.toolCallInfo);
                    messages.push(res.message);
                });

                // Continue the loop to get the final response
                continue;
            }

            // No tool calls - we have the final response
            messages.push({
                role: 'assistant',
                content: assistantMessage.content
            });

            // Save conversation
            await agentStore.updateConversation(conversation.id, messages, userAuth.encryptionKey, userAuth.userId);

            return {
                message: assistantMessage.content,
                toolCalls,
                conversationLength: messages.length
            };

        } catch (error) {
            console.error('[Agent] Error:', error);
            throw error;
        }
    }

    throw new Error('Agent exceeded maximum tool call iterations');
}

function enrichMessagesWithFormData(messages) {
    if (!messages || !Array.isArray(messages)) return messages;

    return messages.map(msg => {
        if (msg.savedFormData && Object.keys(msg.savedFormData).length > 0) {
            // Clone message to avoid mutating the original persistent object
            const newMsg = { ...msg };

            // Format form data
            const formDataStr = Object.entries(msg.savedFormData)
                .map(([key, value]) => `  - ${key}: ${value}`)
                .join('\n');

            // Append to content
            // If content is array (multi-modal), append to last text block or add new one
            if (Array.isArray(newMsg.content)) {
                newMsg.content = [...newMsg.content]; // Clone array
                const lastTextBlock = newMsg.content.slice().reverse().find(c => c.type === 'text');
                const injection = `\n\n[USER SUBMITTED FORM DATA]:\n${formDataStr}`;

                if (lastTextBlock) {
                    // We modify the cloned array's object... wait, we need to shallow copy the text block too
                    // Actually, simpler to just append a new text block
                    newMsg.content.push({ type: 'text', text: injection });
                } else {
                    newMsg.content.push({ type: 'text', text: injection });
                }
            } else {
                // String content
                newMsg.content = (newMsg.content || '') + `\n\n[USER SUBMITTED FORM DATA]:\n${formDataStr}`;
            }
            return newMsg;
        }
        return msg;
    });
}

module.exports = { chatWithAgent, enrichMessagesWithFormData };
