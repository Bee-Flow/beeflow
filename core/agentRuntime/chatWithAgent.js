/**
 * Non-streaming agent chat — synchronous tool-calling loop
 */
const { getAIConfig, getProviderForModel, resolveModelId } = require('../aiAgent');
const { getAdapter } = require('../providers');
const agentStore = require('../../stores/agentStore');
const usageStore = require('../../stores/usageStore');
const { sanitizeToolResult } = require('../../utils/sanitize');
const { sanitizeMessages } = require('../../utils/messageUtils');
const { componentToTool, executeComponentTool } = require('../toolExecution');
const { resolveAgentModel } = require('./modelResolver');
const { getAgentTools } = require('./agentTools');
const { processSystemPrompt } = require('../promptUtils');
const { validateInputForPii } = require('../piiDetection');
const { resolveOrgShield } = require('../orgShield');
const dlpRunner = require('../dlp/dlpRunner');
const { buildTokenPreservationAddendum } = require('../dlp/tokenPreservationPrompt');
const { applyTokenMapToOutbound } = require('../dlp/applyTokenMapToOutbound');

async function chatWithAgent(agentId, userId, userMessage, userAuth = {}) {
    let agent = await agentStore.getAgent(agentId);

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
    const toolParamsMap = {};
    const toolConfigs = await agentStore.getAgentToolsWithParams(agentId);
    for (const tc of toolConfigs) {
        // Convert component ID to tool name format (replace hyphens with underscores)
        const toolName = tc.componentId.replace(/-/g, '_');
        toolParamsMap[toolName] = tc.params;
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

    // ── Unicode Smuggling Defense (must run FIRST) ───────────────────
    const { sanitizeMessagesUnicode } = require('../../utils/unicodeSanitizer');
    const unicodeResult = sanitizeMessagesUnicode(messages);
    if (unicodeResult.smugglingDetected) {
        console.warn(`[ChatWithAgent] 🚨 Unicode smuggling stripped: ${unicodeResult.totalStripped} hidden chars`);
    }

    // Content moderation (Hate/Violence/Sexual/Self-Harm) was removed when
    // the Azure Content Safety backend was dropped. PII detection still
    // runs in the block below.

    // ── PII Detection ─────────────────────────────────────────────────
    const aiConfigForPii = await getAIConfig();
    let piiTokenMap = null;
    const orgShield = await resolveOrgShield(agent.organization_id);
    // PII gate: the shield's master `enabled` flag is the only switch.
    // detectPii() in piiDetection.js routes between the in-process
    // Transformers.js detector and the optional GLiNER guard service.
    const orgPiiEnabled = !!orgShield?.enabled;
    if (aiConfigForPii?.piiDetectionEnabled || orgPiiEnabled) {
        try {
            const piiResult = await validateInputForPii(messages.slice(-3), orgPiiEnabled, orgShield);

            if (piiResult && piiResult.tokenizedText) {
                // Redact/tokenize mode: replace last user message with tokenized version
                const lastMsg = messages[messages.length - 1];
                if (typeof lastMsg.content === 'string') {
                    lastMsg.content = piiResult.tokenizedText;
                } else if (Array.isArray(lastMsg.content)) {
                    const textPart = lastMsg.content.find(p => p.type === 'text');
                    if (textPart) textPart.text = piiResult.tokenizedText;
                }
                piiTokenMap = piiResult.tokenMap;
                if (conversation?.id) dlpRunner.mergeTokenMap(conversation.id, piiTokenMap);
                console.warn(`[ChatWithAgent] 🔒 PII tokenized (${Object.keys(piiTokenMap).length} tokens)`);
            }
        } catch (piiError) {
            if (piiError.message?.includes('PII Detected')) {
                throw piiError; // Propagate to the route handler
            }
            // Service unavailable → fail-open
        }
    }

    // PII tokens: instruct the LLM to preserve & reuse them rather than invent new placeholders.
    {
        const _convTokenMap = conversation?.id
            ? dlpRunner.getConversationTokenMap(conversation.id)
            : (piiTokenMap || {});
        const _tokenAddendum = buildTokenPreservationAddendum(_convTokenMap);
        if (_tokenAddendum) systemPrompt += _tokenAddendum;
    }

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
            // Outbound-prompt guard — last-stop substitution of any real
            // values that may have crept into the prompt via memory, KB,
            // attachment hydration, or any other channel. Idempotent.
            const _guarded = applyTokenMapToOutbound({
                conversationId: conversation?.id,
                systemPrompt,
                messages: sanitize(messages),
            });
            const requestBody = adapter.buildRequestBody(modelToUse, [
                { role: 'system', content: _guarded.systemPrompt },
                ..._guarded.messages
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
                    agent_type: 'chat',
                    model: modelToUse,
                    prompt_tokens: data.usage.prompt_tokens || 0,
                    completion_tokens: data.usage.completion_tokens || 0,
                    total_tokens: data.usage.total_tokens || 0,
                    cached_tokens: data.usage.prompt_tokens_details?.cached_tokens || data.usage.cached_tokens || 0,
                    cache_creation_tokens: data.usage.cache_creation_input_tokens || 0,
                    reasoning_tokens: data.usage.completion_tokens_details?.reasoning_tokens || 0,
                    stop_reason: choice?.finish_reason || null,
                    source: 'agent_chat',
                    duration_ms: Date.now() - _callStart,
                    organization_id: agent.organization_id || null,
                    conversation_id: conversation?.id || null
                });
            }

            // Check if there are tool calls
            if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                // Add assistant message with tool calls
                messages.push(assistantMessage);

                // Execute tool calls in parallel
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
                        // Use unified tool dispatcher — supports integrations + components
                        const { executeTool: dispatchTool } = require('../toolDispatcher');
                        toolResult = await dispatchTool(toolName, toolArgs, {
                            userId,
                            session: userAuth?.session,
                            userAuth,
                            fixedParams: fixedParams,
                            agentId,
                        });
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

module.exports = { chatWithAgent };
