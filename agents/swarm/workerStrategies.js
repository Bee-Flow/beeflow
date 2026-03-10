/**
 * Worker Execution Strategies
 * 
 * Extracts the 3 worker type implementations (browser, terminal, LLM)
 * from swarmOrchestrator.js into a strategy pattern with shared lifecycle.
 */

const browserAgentStore = require('../../stores/browserAgentStore');
const { executeBrowserTask } = require('../../browser/orchestrator');
const terminalAgentStore = require('../../stores/terminalAgentStore');
const { executeTerminalTask } = require('../../terminal/orchestrator');
const { getAIConfig, getProviderForModel, resolveModelId } = require('../../core/aiAgent');
const configStore = require('../../stores/configStore');
const { classifyPromptComplexity } = require('../../core/promptClassifier');

/**
 * Resolve a tier-prefixed model to an actual model ID.
 * Handles 'tier:fast', 'tier:thinking', 'tier:pro', 'tier:auto'.
 * Falls back to the raw model or globalConfig default.
 */
function resolveWorkerModel(workerModel, instruction, globalConfig) {
    // Not a tier-based model — use legacy behavior
    if (!workerModel || !workerModel.startsWith('tier:')) {
        return resolveModelId(workerModel) || resolveModelId(globalConfig.model);
    }

    const tierName = workerModel.substring(5); // strip 'tier:'
    const tiers = configStore.getConfig('chat_model_tiers') || {};

    // Fixed tier (fast/thinking/pro) — just look up the model
    if (tierName !== 'auto') {
        const tier = tiers[tierName];
        if (tier?.modelId) {
            console.log(`[WorkerModel] Tier "${tierName}" → model: ${tier.modelId}`);
            return tier.modelId;
        }
        console.log(`[WorkerModel] Tier "${tierName}" not configured, using default`);
        return resolveModelId(globalConfig.model);
    }

    // Auto tier — use heuristic classifier (fast, avoids extra LLM call)
    const msgText = typeof instruction === 'string' ? instruction : '';
    const classification = classifyPromptComplexity(msgText);
    const fallbackModel = tiers[classification.tier]?.modelId || tiers.fast?.modelId || resolveModelId(globalConfig.model);
    console.log(`[WorkerModel] Auto (heuristic): tier="${classification.tier}" → model: ${fallbackModel}`);
    return fallbackModel;
}

// ─── Shared Lifecycle Helpers ─────────────────────────────────────────────

/**
 * Determine if a worker is the last agent in the last phase of a swarm.
 * Used to decide whether to stream output directly to the user.
 */
function isLastWorkerInSwarm(swarm, workerConfig, workerPhase) {
    const phases = swarm.phases || [];
    const lastPhaseIndex = phases.length - 1;
    const workerPhaseIndex = phases.indexOf(workerPhase);
    const lastPhaseAgents = phases[lastPhaseIndex]?.agents || [];
    const lastAgentInLastPhase = lastPhaseAgents[lastPhaseAgents.length - 1];

    return workerPhaseIndex === lastPhaseIndex &&
        lastAgentInLastPhase &&
        (lastAgentInLastPhase.role || lastAgentInLastPhase.name?.toLowerCase().replace(/\s+/g, '_')) ===
        (workerConfig.role || workerConfig.name?.toLowerCase().replace(/\s+/g, '_'));
}

/**
 * Write a worker's output to the Hive Mind brain (shared memory).
 */
function writeToHiveMind(brain, workerConfig, workerPhase, content, onEvent) {
    if (!brain || !content) return;

    const hiveMindAccess = workerConfig.hiveMindAccess || 'readwrite';
    const canWrite = hiveMindAccess === 'readwrite' || hiveMindAccess === 'write';
    if (!canWrite) return;

    brain.addEntry(
        workerPhase?.name || 'Unknown',
        workerConfig.name,
        content
    );
    onEvent('brain_update', {
        phase: workerPhase?.name,
        worker: workerConfig.name,
        content: content.slice(0, 200) + (content.length > 200 ? '...' : ''),
        totalEntries: brain.size
    });
}

/**
 * Emit the standard worker start events (phase + worker_start).
 */
function emitWorkerStart(workerConfig, workerPhase, instanceId, instruction, onEvent, type = null) {
    if (workerPhase) {
        onEvent('phase', { phase: workerPhase.name, message: `Entering phase: ${workerPhase.name}` });
    }
    onEvent('worker_start', {
        worker: workerConfig.name,
        instanceId,
        role: workerConfig.role,
        phase: workerPhase?.name,
        instruction,
        ...(type ? { type } : {})
    });
}

/**
 * Handle the result for the last worker — stream to user + emit completion.
 * Returns the special direct-streamed marker object.
 */
function finalizeLastWorker(workerConfig, instanceId, content, onEvent) {
    onEvent('worker_complete', { worker: workerConfig.name, instanceId, result: '(streaming directly to user)' });
    onEvent('content', { text: content });
    return { __direct_streamed__: true, content };
}

/**
 * Handle the result for a non-last worker — emit completion with truncated preview.
 */
function finalizeNonLastWorker(workerConfig, instanceId, content, onEvent) {
    onEvent('worker_complete', {
        worker: workerConfig.name,
        instanceId,
        result: content.slice(0, 100) + '...'
    });
    return content;
}


// ─── Browser Agent Strategy ──────────────────────────────────────────────

async function executeBrowserWorker(workerConfig, instruction, { swarm, workerPhase, instanceId, userAuth, onEvent, brain, signal }) {
    const browserAgentId = workerConfig.browserAgentId;
    const browserAgent = browserAgentStore.getBrowserAgent(browserAgentId);
    if (!browserAgent) throw new Error(`Browser agent ${browserAgentId} not found for worker ${workerConfig.name}`);

    console.log(`[WorkerExecutor] 🌐 ${workerConfig.name} is a browser agent — delegating to executeBrowserTask (agent: ${browserAgent.name})`);

    let result = '';
    try {
        const rawResult = await executeBrowserTask(browserAgentId, instruction, userAuth, (eventType, eventData) => {
            onEvent(eventType, { ...eventData, worker: workerConfig.name, instanceId });
        }, signal);

        if (typeof rawResult === 'string') {
            result = rawResult;
        } else if (rawResult?.result) {
            result = rawResult.result;
        } else {
            result = JSON.stringify(rawResult);
        }
    } catch (e) {
        console.error(`[WorkerExecutor] Browser agent ${workerConfig.name} failed:`, e);
        result = `Browser agent error: ${e.message}`;
        onEvent('worker_error', { worker: workerConfig.name, instanceId, error: e.message });
    }

    return result;
}


// ─── Terminal Agent Strategy ─────────────────────────────────────────────

async function executeTerminalWorker(workerConfig, instruction, { swarm, swarmId, workerPhase, instanceId, userAuth, onEvent, brain, signal }) {
    const terminalAgentId = workerConfig.terminalAgentId;
    const terminalAgent = terminalAgentStore.getTerminalAgent(terminalAgentId);
    if (!terminalAgent) throw new Error(`Terminal agent ${terminalAgentId} not found for worker ${workerConfig.name}`);

    console.log(`[WorkerExecutor] 💻 ${workerConfig.name} is a terminal agent — delegating to executeTerminalTask (agent: ${terminalAgent.name})`);

    // Determine container key: shared (one container per swarm) vs isolated (one per worker run)
    const swarmConfig = typeof swarm.config === 'string' ? JSON.parse(swarm.config) : (swarm.config || {});
    let containerKey;
    if (swarmConfig.sharedTerminalWorkspace) {
        containerKey = `swarm-${swarmId}`;
    } else {
        containerKey = `swarm-${swarmId}-${instanceId}`;
    }

    // Capture terminal output for the hive mind
    const terminalLog = [];

    let result = '';
    try {
        const rawResult = await executeTerminalTask(
            terminalAgentId,
            instruction,
            userAuth,
            (eventType, eventData) => {
                // Capture terminal commands and their outputs
                if (eventType === 'terminal_command') {
                    const tool = eventData.tool || 'command';
                    const args = eventData.args || {};
                    if (tool === 'run_command' && args.command) {
                        terminalLog.push(`$ ${args.command}`);
                    } else if (tool === 'python_exec' && args.code) {
                        terminalLog.push(`[python] ${args.description || args.code.slice(0, 100)}`);
                    } else if (tool === 'write_file') {
                        terminalLog.push(`[write] ${args.path}`);
                    } else if (tool === 'read_file') {
                        terminalLog.push(`[read] ${args.path}`);
                    }
                } else if (eventType === 'terminal_output' && eventData.content && !eventData.streaming) {
                    // Capture non-streaming output (final results of commands)
                    const output = eventData.content.trim();
                    if (output && output !== '(no output)') {
                        terminalLog.push(output);
                    }
                }
                // Forward terminal-specific events to the swarm UI, but suppress
                // 'content' and 'thinking' events — the terminal agent's LLM text
                // is internal and should NOT appear in the chat conversation.
                if (eventType !== 'content' && eventType !== 'thinking') {
                    onEvent(eventType, { ...eventData, worker: workerConfig.name, instanceId });
                }
            },
            signal,
            [], // no conversation history for swarm workers
            { containerKey }
        );
        if (typeof rawResult === 'string') {
            result = rawResult;
        } else if (rawResult?.result) {
            result = rawResult.result;
        } else {
            result = JSON.stringify(rawResult);
        }
    } catch (e) {
        console.error(`[WorkerExecutor] Terminal agent ${workerConfig.name} failed:`, e);
        result = `Terminal agent error: ${e.message}`;
        onEvent('worker_error', { worker: workerConfig.name, instanceId, error: e.message });
    }

    // Combine terminal log with LLM summary for richer hive mind content
    if (terminalLog.length > 0) {
        const logSection = terminalLog.join('\n');
        result = `## Terminal Output\n\`\`\`\n${logSection}\n\`\`\`\n\n## Summary\n${result}`;
        console.log(`[WorkerExecutor] 💻 ${workerConfig.name} captured ${terminalLog.length} terminal entries for hive mind`);
    }

    return result;
}


// ─── LLM Agent Strategy ─────────────────────────────────────────────────

async function executeLLMWorker(workerConfig, instruction, { swarm, workerPhase, instanceId, userAuth, toolExecutor, onEvent, brain, signal, processPromptTags, isLastWorker }) {
    // Prepare the worker's system prompt
    const rawSystemPrompt = workerConfig.system_prompt || workerConfig.systemPrompt ||
        `You are the ${workerConfig.name}, a specialized worker in the ${swarm.name} swarm.
Your Role: ${workerConfig.description}
Phase: ${workerPhase.name}

Perform the task requested by the Orchestrator efficiently and accurately.`;
    const systemPrompt = processPromptTags(rawSystemPrompt, swarm);

    // Inject brain context (only if worker has read access)
    const hiveMindAccess = workerConfig.hiveMindAccess || 'readwrite';
    const canRead = isLastWorker ? true : (hiveMindAccess === 'readwrite' || hiveMindAccess === 'read');
    let brainContext = '';
    if (brain && brain.size > 0 && canRead) {
        brainContext = '\n\n' + brain.toPromptContext();
        if (isLastWorker) {
            console.log(`[Worker: ${workerConfig.name}] 🎯 Last worker — full Hive Mind injected (${brain.size} entries)`);
        }
    } else if (!canRead) {
        console.log(`[Worker: ${workerConfig.name}] Hive Mind read disabled (access: ${hiveMindAccess})`);
    }

    // For last worker, add user-facing instruction
    let finalInstruction = instruction;
    if (isLastWorker) {
        finalInstruction = instruction + '\n\nIMPORTANT: Your response will be shown directly to the user. Write a clear, comprehensive, and well-formatted answer.';
    }

    let messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${brainContext ? 'Hive Mind Knowledge:' + brainContext + '\n\n' : ''}Task: ${finalInstruction}` }
    ];

    // Execution loop (with tools if enabled)
    const maxIterations = 5;
    let iterations = 0;

    const globalConfig = await getAIConfig();
    const modelToUse = resolveWorkerModel(workerConfig.model, instruction, globalConfig);
    const providerReq = await getProviderForModel(modelToUse);
    console.log(`[Worker: ${workerConfig.name}] Using model: ${modelToUse} (Provider: ${providerReq.providerName || 'default'})`);

    while (iterations < maxIterations) {
        iterations++;

        const headers = { 'Content-Type': 'application/json' };
        if (providerReq.apiKey) headers['Authorization'] = `Bearer ${providerReq.apiKey}`;

        let apiUrl = providerReq.url.replace(/\/$/, '');
        if (!apiUrl.endsWith('/v1')) apiUrl = `${apiUrl}/v1`;

        const requestBody = {
            model: modelToUse,
            messages,
            temperature: workerConfig.temperature || 0.7,
            max_tokens: isLastWorker ? (workerConfig.maxTokens || 8000) : (workerConfig.maxTokens || 2000)
        };

        const supportsTools = (workerConfig.use_tools || (workerConfig.tools && workerConfig.tools.length > 0));
        if (supportsTools && toolExecutor) {
            requestBody.tools = toolExecutor.definitions;
            requestBody.tool_choice = 'auto';
        }

        // Stream for last worker (when no tools)
        if (isLastWorker && !supportsTools) {
            requestBody.stream = true;
        }

        try {
            const response = await fetch(`${apiUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify(requestBody),
                signal: signal || undefined
            });

            if (!response.ok) {
                const err = await response.text();
                throw new Error(`Worker LLM error: ${err}`);
            }

            // Streaming path for last worker
            if (isLastWorker && requestBody.stream) {
                let fullContent = '';
                onEvent('worker_complete', { worker: workerConfig.name, instanceId, result: '(streaming directly to user)' });

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || !trimmed.startsWith('data: ')) continue;
                        const dataStr = trimmed.slice(6);
                        if (dataStr === '[DONE]') continue;

                        try {
                            const chunk = JSON.parse(dataStr);
                            const delta = chunk.choices?.[0]?.delta;
                            if (delta?.content !== undefined && delta?.content !== null) {
                                if (typeof delta.content === 'string') {
                                    // Standard model — plain string
                                    fullContent += delta.content;
                                    onEvent('content', { text: delta.content });
                                } else if (Array.isArray(delta.content)) {
                                    // Reasoning model — array of structured chunks
                                    for (const part of delta.content) {
                                        if (part.type === 'thinking' && Array.isArray(part.thinking)) {
                                            const text = part.thinking
                                                .filter(t => t.type === 'text' && t.text)
                                                .map(t => t.text)
                                                .join('');
                                            if (text) {
                                                onEvent('thinking', { text });
                                            }
                                        } else if (part.type === 'text' && part.text) {
                                            fullContent += part.text;
                                            onEvent('content', { text: part.text });
                                        }
                                    }
                                }
                            }
                        } catch (e) { /* skip invalid json */ }
                    }
                }

                return { __direct_streamed__: true, content: fullContent };
            }

            // Non-streaming path
            const data = await response.json();
            const choice = data.choices[0];
            const message = choice.message;

            // Normalize reasoning model content (array → string)
            // Reasoning models return content as [{type:"thinking",...},{type:"text",text:"..."}]
            const extractTextContent = (content) => {
                if (typeof content === 'string') return content;
                if (Array.isArray(content)) {
                    return content
                        .filter(c => c.type === 'text' && c.text)
                        .map(c => c.text)
                        .join('');
                }
                return content ?? '';
            };

            // Handle tool calls
            if (message.tool_calls && message.tool_calls.length > 0) {
                // Normalize content for message history (must be a string)
                messages.push({ ...message, content: extractTextContent(message.content) });

                const toolPromises = message.tool_calls.map(async (toolCall) => {
                    const name = toolCall.function.name;
                    let args = {};
                    try { args = JSON.parse(toolCall.function.arguments); } catch (e) { }

                    console.log(`[Worker: ${workerConfig.name}] Executing tool: ${name}`);
                    onEvent('worker_tool', { worker: workerConfig.name, instanceId, tool: name, args });

                    let result = { error: 'Tool execution failed' };
                    if (toolExecutor) {
                        try {
                            result = await toolExecutor.execute(name, args);
                        } catch (e) {
                            result = { error: e.message };
                        }
                    }

                    return {
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: JSON.stringify(result)
                    };
                });

                const toolResults = await Promise.all(toolPromises);
                messages.push(...toolResults);
                continue; // loop for next LLM call
            }

            // Final content — normalize reasoning model array to string
            const finalContent = extractTextContent(message.content);
            if (finalContent) {
                return finalContent;
            }

            return '(No response text)';

        } catch (e) {
            console.error(`Worker ${workerConfig.name} execution failed:`, e);
            onEvent('worker_error', { worker: workerConfig.name, instanceId, error: e.message });
            return `Error executing worker: ${e.message}`;
        }
    }

    return "Worker exceeded maximum iterations.";
}


// ─── Exports ─────────────────────────────────────────────────────────────

module.exports = {
    // Shared lifecycle
    isLastWorkerInSwarm,
    writeToHiveMind,
    emitWorkerStart,
    finalizeLastWorker,
    finalizeNonLastWorker,

    // Strategy implementations
    executeBrowserWorker,
    executeTerminalWorker,
    executeLLMWorker
};
