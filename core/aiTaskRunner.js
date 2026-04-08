/**
 * AI Task Runner — Background execution engine for scheduled AI tasks.
 *
 * Runs every 60 seconds, picks up due tasks, executes them via the
 * LLM (non-streaming), and delivers results as notifications.
 *
 * Tasks only have access to READ-ONLY tools (web search, etc.)
 * — they cannot send emails, create calendar events, etc.
 */

const aiTaskStore = require('../stores/aiTaskStore');
const { resolveModelForTier } = require('./modelResolver');
const { getProviderForModel } = require('./aiAgent');
const { getAdapter } = require('./providers');

const RUNNER_INTERVAL_MS = 60_000; // 60 seconds
const MAX_CONCURRENT = 5;
const MAX_TOOL_ITERATIONS = 3;

/**
 * Read-only tools whitelist.
 * Only these tool *prefixes* / exact names are allowed during background execution.
 */
const READ_ONLY_TOOL_NAMES = new Set([
    'agent_search',      // Web search (Tavily/Bing)
]);

/**
 * Build a minimal system prompt for task execution.
 */
function buildTaskSystemPrompt(task) {
    // Compute "Now:" in the task's timezone
    let nowStr;
    try {
        nowStr = new Date().toLocaleString('en-US', {
            timeZone: task.timezone || 'UTC',
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false,
        });
    } catch (_) {
        nowStr = new Date().toISOString();
    }

    return `You are BeeFlow AI Task Runner — executing a scheduled task on behalf of a user.
Your job is to complete the task described below concisely and deliver actionable results.

## Guidelines
- Be concise and structured. Use bullet points, headings, and numbered lists.
- Focus on the most important, relevant information.
- If the task requires web search, use the search tool proactively.
- Do NOT ask follow-up questions — this runs unattended.
- Include sources/links when available.
- Maximum response length: ~${task.maxResultLength || 2000} characters.

Now: ${nowStr} (${task.timezone || 'UTC'})`;
}

/**
 * Build the web search tool definition (the only tool available by default).
 */
function buildReadOnlyTools() {
    // We only inject agent_search for now
    try {
        const { buildAgentSearchTool } = require('../integrations/agentSearchTools');
        if (typeof buildAgentSearchTool === 'function') {
            return [buildAgentSearchTool()];
        }
    } catch (_) { /* not available */ }

    // Fallback: manual tool definition
    return [{
        type: 'function',
        function: {
            name: 'agent_search',
            description: 'Search the web for current information, news, facts, or data.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The search query' },
                    num_results: { type: 'integer', description: 'Number of results (default 5, max 10)' },
                },
                required: ['query'],
            },
        },
    }];
}

/**
 * Execute a tool call during task execution.
 * Only read-only tools are allowed.
 */
async function executeTaskToolCall(toolName, toolArgs) {
    if (!READ_ONLY_TOOL_NAMES.has(toolName)) {
        return { error: `Tool "${toolName}" is not available for AI Tasks (read-only mode)` };
    }

    try {
        const configStore = require('../stores/configStore');

        if (toolName === 'agent_search') {
            // Check if admin configured Bing as the search provider (resilient to transient DB failures)
            try {
                const searchProvider = await configStore.getConfig('search_provider');
                if (searchProvider === 'bing') {
                    const { executeBingSearchTool } = require('../integrations/bingSearchTools');
                    return await executeBingSearchTool(toolName, toolArgs);
                }
            } catch (cfgErr) {
                console.warn(`[AITaskRunner] Config lookup failed (search_provider), using default: ${cfgErr.message}`);
            }
            const { executeAgentSearchTool } = require('../integrations/agentSearchTools');
            return await executeAgentSearchTool(toolName, toolArgs);
        }

        return { error: `No handler for tool: ${toolName}` };
    } catch (err) {
        console.error(`[AITaskRunner] Tool execution error (${toolName}):`, err.message);
        return { error: err.message };
    }
}

/**
 * Execute a single AI task.
 */
async function executeTask(task) {
    const startTime = Date.now();
    console.log(`[AITaskRunner] ▶ Executing task "${task.title}" (${task.id})`);

    try {
        await aiTaskStore.markRunning(task.id);

        // Resolve the model for this task's tier
        const modelId = await resolveModelForTier(`tier:${task.modelTier || 'fast'}`);
        if (!modelId) {
            throw new Error(`Could not resolve model for tier: ${task.modelTier || 'fast'}`);
        }

        const config = await getProviderForModel(modelId);
        const adapter = getAdapter(config.providerType, config.url);

        if (!adapter || typeof adapter.chat !== 'function') {
            throw new Error(`Provider adapter does not support non-streaming chat`);
        }

        const systemPrompt = buildTaskSystemPrompt(task);
        const tools = buildReadOnlyTools();

        let messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: task.prompt },
        ];

        let finalResponse = '';

        // Tool-calling loop (max iterations)
        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
            const response = await adapter.chat(config.apiKey, config.url, modelId, messages, {
                maxTokens: 4096,
                temperature: 0.7,
                tools: tools.length > 0 ? tools : undefined,
                toolChoice: tools.length > 0 ? 'auto' : undefined,
            });

            // Handle tool calls if present
            if (response.toolCalls && response.toolCalls.length > 0) {
                // Add assistant message with tool calls
                // Preserve _thought_signature — required by Gemini 3.x for multi-turn tool calls
                messages.push({
                    role: 'assistant',
                    content: response.content || null,
                    tool_calls: response.toolCalls.map(tc => ({
                        id: tc.id,
                        type: 'function',
                        function: {
                            name: tc.function.name,
                            arguments: typeof tc.function.arguments === 'string'
                                ? tc.function.arguments
                                : JSON.stringify(tc.function.arguments),
                        },
                        _thought_signature: tc._thought_signature || undefined,
                    })),
                });

                // Execute each tool call
                for (const tc of response.toolCalls) {
                    const toolName = tc.function.name;
                    let toolArgs;
                    try {
                        toolArgs = typeof tc.function.arguments === 'string'
                            ? JSON.parse(tc.function.arguments)
                            : tc.function.arguments;
                    } catch (_) {
                        toolArgs = {};
                    }

                    console.log(`[AITaskRunner]   🔧 Tool call: ${toolName}(${JSON.stringify(toolArgs).substring(0, 100)})`);
                    const result = await executeTaskToolCall(toolName, toolArgs);

                    messages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: typeof result === 'string' ? result : JSON.stringify(result),
                    });
                }
                // Continue the loop to let the model process tool results
                continue;
            }

            // No tool calls — this is the final response
            finalResponse = response.content || '';
            break;
        }

        // Truncate if needed
        const maxLen = task.maxResultLength || 2000;
        if (finalResponse.length > maxLen) {
            finalResponse = finalResponse.substring(0, maxLen) + '\n\n… (truncated)';
        }

        // Store result
        await aiTaskStore.markCompleted(task.id, finalResponse);

        // Create notification
        const notificationStore = require('../stores/notificationStore');
        await notificationStore.createNotification({
            userId: task.userId,
            category: 'ai_task',
            title: `🤖 ${task.title}`,
            message: finalResponse,
        });

        // Advance schedule
        if (task.repeatInterval) {
            const next = await aiTaskStore.advanceSchedule(task.id, task.nextRunAt, task.repeatInterval);
            console.log(`[AITaskRunner] ✅ Task "${task.title}" completed (${Date.now() - startTime}ms), next run: ${next}`);
        } else {
            // One-time task → deactivate
            await aiTaskStore.updateTask(task.id, { isActive: false });
            console.log(`[AITaskRunner] ✅ Task "${task.title}" completed (one-time, ${Date.now() - startTime}ms)`);
        }
    } catch (err) {
        console.error(`[AITaskRunner] ❌ Task "${task.title}" failed:`, err.message);
        await aiTaskStore.markError(task.id, err);

        // Still advance schedule on error (don't let errors block future runs)
        if (task.repeatInterval) {
            await aiTaskStore.advanceSchedule(task.id, task.nextRunAt, task.repeatInterval);
        }

        // Notify user about failure
        try {
            const notificationStore = require('../stores/notificationStore');
            await notificationStore.createNotification({
                userId: task.userId,
                category: 'urgent',
                title: `⚠️ AI Task Failed: ${task.title}`,
                message: `The scheduled task "${task.title}" failed to execute: ${err.message}`,
            });
        } catch (_) { /* don't fail on notification failure */ }
    }
}

/**
 * Process all due tasks (called every 60s by setInterval).
 */
async function processDueTasks() {
    try {
        const dueTasks = await aiTaskStore.getDueTasks();
        if (dueTasks.length === 0) return;

        console.log(`[AITaskRunner] Found ${dueTasks.length} due task(s)`);

        // Process with concurrency limit
        const batches = [];
        for (let i = 0; i < dueTasks.length; i += MAX_CONCURRENT) {
            batches.push(dueTasks.slice(i, i + MAX_CONCURRENT));
        }

        for (const batch of batches) {
            await Promise.allSettled(batch.map(task => executeTask(task)));
        }
    } catch (err) {
        console.error('[AITaskRunner] Background checker error:', err.message);
    }
}

// ── Start background runner ──────────────────────────────
const _interval = setInterval(processDueTasks, RUNNER_INTERVAL_MS);
// First run after 10s (let stores initialize)
setTimeout(processDueTasks, 10_000);

console.log('[AITaskRunner] Background runner started (60s interval)');

module.exports = {
    processDueTasks,
    executeTask,
};
