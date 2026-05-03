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
 * R3: cheap, deterministic topic extraction from a routine result. Looks for
 * markdown headings (### Topic) and numbered list items (1) Topic — summary)
 * — the two patterns the wizard's routines tend to emit. Falls back to
 * top-level headings only when no enumeration is found.
 *
 * Returns `[{ subject, title, summary }]`. `subject` is a stable slug used
 * as the dedupe key across runs.
 */
function _slugify(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}
function extractCoverageTopics(text) {
    if (!text || typeof text !== 'string') return [];
    const out = [];
    const seen = new Set();
    const push = (title, summary) => {
        const cleanTitle = String(title).replace(/\*\*|__|\[|\]\(.*?\)/g, '').trim();
        if (cleanTitle.length < 4 || cleanTitle.length > 200) return;
        const subject = _slugify(cleanTitle);
        if (!subject || seen.has(subject)) return;
        seen.add(subject);
        out.push({ subject, title: cleanTitle, summary: summary ? String(summary).trim().slice(0, 280) : null });
    };

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        // Numbered item:  "1) Title — summary"  or  "1. Title: summary"
        const numbered = line.match(/^\s*\d+[\.\)]\s+(.+?)(?:\s*[—:\-]\s+(.*))?$/);
        if (numbered) { push(numbered[1], numbered[2] || lines[i + 1]); continue; }
        // Bold-led bullet:  "**Title** — summary"
        const boldBullet = line.match(/^\s*[-*]\s+\*\*(.+?)\*\*\s*[—:\-]\s+(.+)$/);
        if (boldBullet) { push(boldBullet[1], boldBullet[2]); continue; }
        // Markdown heading at level 3+ (level 1/2 tend to be section names like "Beleid & defensie")
        const heading = line.match(/^\s*#{3,6}\s+(.+?)\s*$/);
        if (heading) { push(heading[1], lines[i + 1]); continue; }
    }
    return out;
}

/**
 * Build a minimal system prompt for task execution.
 */
function buildTaskSystemPrompt(task, toolHint) {
    // Compute "Now:" in the task's timezone with explicit offset
    const tz = task.timezone || 'Europe/Amsterdam';
    let nowStr;
    try {
        const now = new Date();
        // Format: "Tuesday, April 8, 2026, 15:12:30" 
        const datePart = now.toLocaleString('en-US', {
            timeZone: tz,
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false,
        });
        // Compute explicit UTC offset like "+02:00"
        const localParts = new Date(now.toLocaleString('en-US', { timeZone: tz }));
        const offsetMin = Math.round((localParts - now) / 60000);
        const sign = offsetMin >= 0 ? '+' : '-';
        const absOff = Math.abs(offsetMin);
        const offStr = `${sign}${String(Math.floor(absOff / 60)).padStart(2, '0')}:${String(absOff % 60).padStart(2, '0')}`;
        nowStr = `${datePart} (UTC${offStr}, ${tz})`;
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
- IMPORTANT: The current time shown below is in the USER'S local timezone. Use this time for all time references.
${toolHint ? '\n' + toolHint : ''}

Now: ${nowStr}`;
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
 *
 * Two execution modes:
 *   - Legacy user-scoped task (`task.agentId == null`): inline LLM loop with
 *     the user's integration tools, no agent context.
 *   - Agent routine (`task.agentId` set): dispatch through the full agent
 *     runtime so the agent's system prompt, attached skills, knowledge bases,
 *     guardrails, memory, and integrations all participate. Result lands in a
 *     persistent conversation thread on that agent.
 */
async function executeTask(task, { manual = false } = {}) {
    if (task.agentId) {
        return executeAgentRoutine(task, { manual });
    }
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

        // Advance schedule (skip if this was a manual run-now trigger)
        if (task.repeatInterval && !manual) {
            const next = await aiTaskStore.advanceSchedule(task.id, task.nextRunAt, task.repeatInterval, task.daysOfWeek);
            console.log(`[AITaskRunner] ✅ Task "${task.title}" completed (${Date.now() - startTime}ms), next run: ${next}`);
        } else if (task.repeatInterval && manual) {
            console.log(`[AITaskRunner] ✅ Task "${task.title}" completed manually (${Date.now() - startTime}ms), next scheduled run unchanged: ${task.nextRunAt}`);
        } else {
            // One-time task → deactivate
            await aiTaskStore.updateTask(task.id, { isActive: false });
            console.log(`[AITaskRunner] ✅ Task "${task.title}" completed (one-time, ${Date.now() - startTime}ms)`);
        }
    } catch (err) {
        console.error(`[AITaskRunner] ❌ Task "${task.title}" failed:`, err.message);
        await aiTaskStore.markError(task.id, err);

        // Still advance schedule on error (don't let errors block future runs) — but not for manual runs
        if (task.repeatInterval && !manual) {
            await aiTaskStore.advanceSchedule(task.id, task.nextRunAt, task.repeatInterval, task.daysOfWeek);
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
 * Execute an agent-scoped routine: dispatch through the full agent runtime so
 * the agent's system prompt, attached skills, knowledge bases, integrations,
 * and guardrails all participate. Result lands in a persistent conversation
 * thread so the user can open it from the notification and continue chatting.
 */
async function executeAgentRoutine(task, { manual = false } = {}) {
    const startTime = Date.now();
    console.log(`[AITaskRunner] ▶ Executing routine "${task.title}" (${task.id}) for agent ${task.agentId}`);

    try {
        await aiTaskStore.markRunning(task.id);

        const agentStore = require('../stores/agentStore');
        const agent = await agentStore.getAgent(task.agentId);
        if (!agent) throw new Error(`Linked agent ${task.agentId} no longer exists`);
        if (agent.owner_id !== task.userId) throw new Error('Routine agent owner mismatch — refusing to run');

        // Resolve OAuth credentials for this routine. Default path: long-lived
        // encrypted vault (`routine_credentials`) with auto-refresh, so the
        // routine works even when the user is offline. The legacy
        // session-borrow path is kept behind ROUTINE_AUTH_LEGACY=1 for one
        // release in case of regressions.
        const useLegacy = process.env.ROUTINE_AUTH_LEGACY === '1';
        let userAuth;
        if (useLegacy) {
            const session = await resolveUserSession(task.userId);
            userAuth = {
                accessToken: session?.accessToken || null,
                nextcloudUrl: null,
                appPasswordUsername: session?.appPassword?.username || null,
                appPassword: session?.appPassword?.password || null,
                encryptionKey: session?.encryptionKey || null,
                userId: task.userId,
                session,
                userOrgId: session?.user?.organizationId || agent.organization_id || null,
            };
        } else {
            const routineAuth = require('./routineAuth');
            const enabledIntegrations = Array.isArray(agent?.config?.enabledIntegrations)
                ? agent.config.enabledIntegrations
                : [];
            const built = await routineAuth.buildUserAuth(task.userId, { enabledIntegrations });
            if (!built) {
                // buildUserAuth already paused dependent routines + emitted a
                // reauth notification. Surface the error on this run so the
                // task row reflects the failure.
                throw new Error('needs_reauth: required OAuth provider expired or revoked');
            }
            userAuth = {
                accessToken: built.accessToken,
                refreshToken: built.refreshToken,
                oauthProvider: built.oauthProvider,
                routineProviders: built.routineProviders,
                nextcloudUrl: null,
                appPasswordUsername: null,
                appPassword: null,
                encryptionKey: null,
                userId: task.userId,
                userOrgId: agent.organization_id || null,
            };
        }

        const { chatWithAgentStream } = require('./agentRuntime');

        // Per-routine tier override (optional). Falls back to whatever the
        // agent itself is configured with.
        const modelTier = task.modelTier && task.modelTier !== 'fast'
            ? task.modelTier
            : (typeof agent.model === 'string' && agent.model.startsWith('tier:') ? agent.model.slice(5) : (task.modelTier || null));

        const messageMetadata = {
            conversationId: task.conversationId || undefined,
            timezone: task.timezone || 'Europe/Amsterdam',
            modelTier: modelTier || undefined,
            userOrgId: userAuth.userOrgId,
            orgId: userAuth.userOrgId,
            // R3: contextBuilder reads this to inject the "previously covered"
            // addendum from past runs of the SAME routine.
            routineId: task.id,
            // Routines are unattended — never block on streaming back to a UI.
            ephemeral: false,
        };

        const collectedChunks = [];
        const result = await chatWithAgentStream(
            task.agentId,
            task.userId,
            task.prompt,
            userAuth,
            (type, data) => {
                if (type === 'content' && data?.text) collectedChunks.push(data.text);
            },
            null,
            messageMetadata,
        );

        const finalResponse = (result?.message && result.message.length > 0)
            ? result.message
            : collectedChunks.join('');
        const truncated = finalResponse.length > 50000
            ? finalResponse.substring(0, 50000) + '\n\n… (truncated)'
            : finalResponse;

        // Persist conversation id back onto the task so future runs append to
        // the same chat thread.
        if (result?.conversationId && result.conversationId !== task.conversationId) {
            try { await aiTaskStore.updateTask(task.id, { conversationId: result.conversationId }); }
            catch (_) { /* non-fatal */ }
        }

        await aiTaskStore.markCompleted(task.id, truncated);

        // R3: extract topics this run surfaced and write them to the routine's
        // coverage memory bucket so the next run knows not to repeat them.
        // Only fires when the agent has memory enabled — opt-in by design.
        if (agent?.config?.memoryEnabled === true) {
            try {
                const topics = extractCoverageTopics(truncated);
                if (topics.length > 0) {
                    const memoryStore = require('../stores/memoryStore');
                    await Promise.all(topics.slice(0, 30).map(t => memoryStore.upsertRoutineCoverage({
                        userId: task.userId,
                        agentId: task.agentId,
                        routineId: task.id,
                        subject: t.subject,
                        title: t.title,
                        summary: t.summary,
                    })));
                    console.log(`[AITaskRunner] R3: stored ${Math.min(topics.length, 30)} coverage memorie(s) for routine ${task.id}`);
                }
            } catch (err) {
                console.warn(`[AITaskRunner] R3 coverage extraction failed: ${err.message}`);
            }
        }

        // Notification with deep link to the conversation so the user can open
        // it and continue chatting.
        try {
            const notificationStore = require('../stores/notificationStore');
            await notificationStore.createNotification({
                userId: task.userId,
                taskId: task.id,
                category: 'ai_task',
                title: `🤖 ${agent.name || 'Agent'}: ${task.title}`,
                message: truncated,
            });
        } catch (_) { /* non-fatal */ }

        // Schedule advance — same rules as legacy tasks.
        if ((task.repeatInterval || (Array.isArray(task.daysOfWeek) && task.daysOfWeek.length > 0)) && !manual) {
            const next = await aiTaskStore.advanceSchedule(task.id, task.nextRunAt, task.repeatInterval, task.daysOfWeek);
            console.log(`[AITaskRunner] ✅ Routine "${task.title}" completed (${Date.now() - startTime}ms), next run: ${next}`);
        } else if (task.repeatInterval && manual) {
            console.log(`[AITaskRunner] ✅ Routine "${task.title}" completed manually (${Date.now() - startTime}ms)`);
        } else {
            await aiTaskStore.updateTask(task.id, { isActive: false });
            console.log(`[AITaskRunner] ✅ Routine "${task.title}" completed (one-time, ${Date.now() - startTime}ms)`);
        }
    } catch (err) {
        console.error(`[AITaskRunner] ❌ Routine "${task.title}" failed:`, err.message);
        await aiTaskStore.markError(task.id, err);
        if ((task.repeatInterval || (Array.isArray(task.daysOfWeek) && task.daysOfWeek.length > 0)) && !manual) {
            await aiTaskStore.advanceSchedule(task.id, task.nextRunAt, task.repeatInterval, task.daysOfWeek);
        }
        try {
            const notificationStore = require('../stores/notificationStore');
            await notificationStore.createNotification({
                userId: task.userId,
                category: 'urgent',
                title: `⚠️ Routine failed: ${task.title}`,
                message: `The scheduled routine "${task.title}" failed to execute: ${err.message}`,
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

// R3: prune expired routine_coverage memories once per hour. Keeps the
// "previously covered" addendum from suppressing topics forever (default TTL
// is 30 days inside memoryStore).
const _coveragePruneInterval = setInterval(async () => {
    try {
        const memoryStore = require('../stores/memoryStore');
        const expired = await memoryStore.pruneExpiredCoverage();
        if (expired > 0) console.log(`[AITaskRunner] R3: pruned ${expired} expired coverage memorie(s)`);
    } catch (err) {
        console.warn(`[AITaskRunner] R3 prune failed: ${err.message}`);
    }
}, 60 * 60_000);
if (_coveragePruneInterval.unref) _coveragePruneInterval.unref();

console.log('[AITaskRunner] Background runner started (60s interval)');

module.exports = {
    processDueTasks,
    executeTask,
};
