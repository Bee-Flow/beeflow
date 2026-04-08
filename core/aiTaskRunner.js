/**
 * AI Task Runner — Background execution engine for scheduled AI tasks.
 *
 * Runs every 60 seconds, picks up due tasks, executes them via the
 * LLM (non-streaming), and delivers results as notifications.
 *
 * Tasks now use the owner's connected integrations (Gmail, Calendar,
 * Drive, etc.) by resolving their active session from the DB.
 */

const aiTaskStore = require('../stores/aiTaskStore');
const { resolveModelForTier } = require('./modelResolver');
const { getProviderForModel } = require('./aiAgent');
const { getAdapter } = require('./providers');
const { pool } = require('../db');

const RUNNER_INTERVAL_MS = 60_000; // 60 seconds
const MAX_CONCURRENT = 5;
const MAX_TOOL_ITERATIONS = 5;

/**
 * Build a minimal system prompt for task execution.
 */
function buildTaskSystemPrompt(task, toolHint) {
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
- Use the user's connected integrations when relevant to the task.
${toolHint ? '\n' + toolHint : ''}

Now: ${nowStr} (${task.timezone || 'UTC'})`;
}

/**
 * Resolve the user's active session from the PostgreSQL session store.
 * Returns a session-like object with oauthProvider, accessToken, refreshToken.
 */
async function resolveUserSession(userId) {
    try {
        const { rows } = await pool.query(
            `SELECT sess FROM user_sessions 
             WHERE sess::jsonb -> 'user' ->> 'id' = $1
             AND expire > NOW()
             ORDER BY expire DESC LIMIT 1`,
            [userId]
        );
        if (rows.length === 0) {
            console.log(`[AITaskRunner] No active session found for user ${userId}`);
            return null;
        }
        const sess = typeof rows[0].sess === 'string' ? JSON.parse(rows[0].sess) : rows[0].sess;
        return sess;
    } catch (err) {
        console.error(`[AITaskRunner] Session lookup error for user ${userId}:`, err.message);
        return null;
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

        // ── Resolve user session & integrations ─────────────────
        const session = await resolveUserSession(task.userId);
        let tools = [];
        let toolHint = '';

        try {
            const { getIntegrationTools, buildToolHint } = require('./integrationTools');
            const result = await getIntegrationTools({
                userId: task.userId,
                session: session,
                isAdmin: false,
            });
            tools = result.tools || [];
            toolHint = await buildToolHint(tools, task.userId);
            console.log(`[AITaskRunner] Loaded ${tools.length} integration tools for user ${task.userId}`);
        } catch (err) {
            console.warn(`[AITaskRunner] Failed to load integration tools: ${err.message}`);
            // Fallback: try to load at least web search
            try {
                const { buildAgentSearchTool } = require('../integrations/agentSearchTools');
                if (typeof buildAgentSearchTool === 'function') {
                    tools = [buildAgentSearchTool()];
                }
            } catch (_) { /* no search available */ }
        }

        const systemPrompt = buildTaskSystemPrompt(task, toolHint);

        let messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: task.prompt },
        ];

        let finalResponse = '';

        // Tool-calling loop (max iterations)
        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
            const response = await adapter.chat(config.apiKey, config.url, modelId, messages, {
                maxTokens: 16384,
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

                // Execute each tool call via the unified dispatcher
                const { executeTool } = require('./toolDispatcher');
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
                    
                    let result;
                    try {
                        result = await executeTool(toolName, toolArgs, {
                            userId: task.userId,
                            session: session,
                        });
                    } catch (toolErr) {
                        console.error(`[AITaskRunner]   ❌ Tool error (${toolName}):`, toolErr.message);
                        result = { error: toolErr.message };
                    }

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

        // Truncate if needed (safety net — ignore task.maxResultLength since DB defaults to 2000)
        const maxLen = 50000;
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
