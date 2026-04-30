/**
 * Swarm Runtime — phased multi-agent orchestrator built on the direct-chat
 * tool stack.
 *
 * Each worker is a direct-chat-style LLM agent: same adapter, same tools
 * (components + integrations + MCP, via buildDirectChatToolStack), same
 * dispatcher (toolDispatcher.executeTool). Workers run in parallel within
 * a phase; phases run sequentially; the final phase is a single synthesiser
 * whose tokens stream as ordinary `content` events so the regular chat
 * renderer handles the answer.
 *
 * v2 ships one built-in swarm — `builtin:research_swarm` — with a fixed
 * worker manifest (3 parallel researchers + 1 synthesiser). The runtime is
 * already generic over manifests, so v3 can drop in a dynamic LLM planner
 * (mirroring Flow's bootstrap) without touching anything else here.
 *
 * Hive Mind: a per-conversation shared bag of structured findings
 * persisted in `direct_conversations.meta_json.hiveMind`. Researcher
 * workers' summaries land in it; the synthesiser reads them all.
 */

const crypto = require('crypto');
const { mapWithConcurrency } = require('../concurrencyUtil');
const { resolveModelForTier, getTierConfig } = require('../modelResolver');
const { getProviderForModel } = require('../aiAgent');
const { getAdapter } = require('../providers');
const { buildDirectChatToolStack } = require('../directChatToolStack');
const { executeTool: dispatchTool } = require('../toolDispatcher');
const usageStore = require('../../stores/usageStore');

// ─── Built-in registry ───────────────────────────────────────────────────

const BUILTINS = {
    'builtin:research_swarm': require('./builtins/researchSwarm'),
};

function loadSwarmById(id) {
    if (!id || typeof id !== 'string') return null;
    if (BUILTINS[id]) return BUILTINS[id];
    return null;
}

function listAvailableSwarms() {
    return Object.values(BUILTINS).map(b => ({ ...b.MANIFEST }));
}

// ─── Hive Mind ───────────────────────────────────────────────────────────

function emptyHiveMind() {
    return { entries: [], updatedAt: null };
}

function appendHiveMindEntry(hive, entry) {
    if (!hive || !entry) return hive;
    hive.entries.push({
        at: Date.now(),
        byWorker: entry.byWorker || 'system',
        kind: entry.kind || 'note',
        title: entry.title || '',
        body: entry.body || '',
    });
    hive.updatedAt = Date.now();
    return hive;
}

function renderHiveMindForPrompt(hive, { excludeByWorker = null } = {}) {
    if (!hive || !Array.isArray(hive.entries) || hive.entries.length === 0) {
        return '(empty — you are the first worker to write to it)';
    }
    return hive.entries
        .filter(e => excludeByWorker == null || e.byWorker !== excludeByWorker)
        .map((e, i) => {
            const head = `## [${i + 1}] ${e.title || e.kind} — by ${e.byWorker}`;
            return `${head}\n${e.body}`;
        })
        .join('\n\n');
}

// ─── Worker execution ────────────────────────────────────────────────────

const MAX_TOOL_ROUNDS_PER_WORKER = 8;
const WORKER_DEFAULT_MAX_TOKENS = 6000;

/**
 * Resolve the model + adapter the worker should use for this run.
 * Falls back to the conversation-level synthesiser model when the worker's
 * tier can't be resolved.
 */
async function resolveWorkerModel({ worker, fallbackModelId, userOrgId, userId }) {
    const tier = worker.tier || 'auto';
    let modelId = fallbackModelId;
    try {
        const resolved = await resolveModelForTier(`tier:${tier === 'auto' ? 'fast' : tier}`, {
            userOrgId, userId, fallbackTier: 'fast',
        });
        if (resolved) modelId = resolved;
    } catch (_) { /* fall back to fallbackModelId */ }

    const config = await getProviderForModel(modelId);
    const adapter = getAdapter(config.providerType, (config.url || '').replace(/\/+$/, ''));
    return {
        modelId,
        adapter,
        apiKey: config.apiKey,
        apiUrl: (config.url || '').replace(/\/+$/, ''),
        config,
    };
}

/**
 * Execute one worker — tool-call loop, then stream the final response.
 * Streamed tokens go to either `swarm_worker_content` (research workers)
 * or ordinary `content` (the synthesiser worker).
 */
async function runWorker({
    worker,
    userMessage,
    hive,
    send,
    tools,
    toolContext,
    fallbackModelId,
    userOrgId,
    userId,
    isSynthesiser = false,
    runSnapshot = null,
    swarmRunId = null,
    organizationId = null,
    conversationId = null,
}) {
    const startedAt = Date.now();
    const workerId = worker.id;
    // Seed the snapshot entry early so a model-resolution failure still
    // shows up as a failed worker card after refresh.
    if (runSnapshot) {
        runSnapshot.workers[workerId] = {
            workerId,
            role: worker.role,
            name: worker.name,
            tier: worker.tier || 'auto',
            modelId: null,
            status: 'running',
            content: '',
            tools: [],
            startedAt,
            durationMs: null,
            error: null,
        };
    }

    let model;
    try {
        model = await resolveWorkerModel({ worker, fallbackModelId, userOrgId, userId });
    } catch (err) {
        const durationMs = Date.now() - startedAt;
        if (runSnapshot?.workers?.[workerId]) {
            runSnapshot.workers[workerId].status = 'failed';
            runSnapshot.workers[workerId].error = `Model resolution failed: ${err.message}`;
            runSnapshot.workers[workerId].durationMs = durationMs;
        }
        send('swarm_worker_completed', {
            workerId, role: worker.role, status: 'failed',
            error: `Model resolution failed: ${err.message}`,
            durationMs,
        });
        return { workerId, role: worker.role, status: 'failed', error: err.message };
    }

    if (runSnapshot?.workers?.[workerId]) {
        runSnapshot.workers[workerId].modelId = model.modelId;
    }

    send('swarm_worker_started', {
        workerId, role: worker.role, name: worker.name,
        tier: worker.tier || 'auto', modelId: model.modelId,
    });

    // Filter the global tool stack down to this worker's allowlist (if any).
    // Empty allowlist = all tools available; tagged allowlist = whitelist.
    const allowed = Array.isArray(worker.toolAllowlist) && worker.toolAllowlist.length > 0
        ? new Set(worker.toolAllowlist)
        : null;
    const workerTools = allowed
        ? tools.filter(t => allowed.has(t.function.name))
        : tools;

    // Build messages: per-worker system prompt + Hive Mind context + user request.
    const hiveBlock = renderHiveMindForPrompt(hive, { excludeByWorker: workerId });
    const systemPrompt = [
        worker.systemPrompt || '',
        '',
        '── HIVE MIND (shared scratchpad written by sibling workers) ──',
        hiveBlock,
        '',
        '── User request ──',
        '(Reply by completing your specific role. Use the tools available — they are the same integrations the user has in direct chat. When you have enough material to deliver your role\'s output, stop calling tools and write your final response.)',
    ].join('\n');

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
    ];

    // ── Tool-call loop with real token streaming ────────────────────
    // adapter.stream() pipes deltas through a streamCallback. We forward
    // text deltas to either `content` (synthesiser → goes straight to the
    // chat bubble) or `swarm_worker_content` (researcher → goes to its
    // own card). Tool calls are accumulated and, once the stream ends,
    // dispatched in parallel; the loop continues until the model produces
    // a tool-call-free response.
    let collectedToolHistory = [];
    let finalText = '';
    let lastError = null;
    // Accumulate per-round usage so we log one row per worker stream call.
    let workerTotalUsage = null;

    try {
        outer: for (let round = 0; round < MAX_TOOL_ROUNDS_PER_WORKER; round++) {
            let roundText = '';
            const roundToolCalls = [];

            let streamErrorMessage = null;
            const streamCallback = async (type, data) => {
                if (type === 'text' && typeof data?.text === 'string') {
                    roundText += data.text;
                    if (runSnapshot?.workers?.[workerId]) {
                        runSnapshot.workers[workerId].content += data.text;
                    }
                    if (isSynthesiser) {
                        send('content', { text: data.text });
                    } else {
                        send('swarm_worker_content', { workerId, delta: data.text });
                    }
                } else if (type === 'tool_use' && data) {
                    // Providers emit { id, name, input } — `input` is the
                    // parsed args object. Echo back into OpenAI-shape so
                    // adapters (incl. the Claude one which converts internally)
                    // get a consistent assistant tool_calls history.
                    roundToolCalls.push({
                        id: data.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                        type: 'function',
                        function: {
                            name: data.name,
                            arguments: typeof data.input === 'string'
                                ? data.input
                                : JSON.stringify(data.input || {}),
                        },
                    });
                } else if (type === 'error') {
                    streamErrorMessage = data?.error || 'Stream error';
                } else if (type === 'done' && data) {
                    // Adapters emit final usage on `done`. Log per worker per
                    // round so swarm dashboards see real token counts (workers
                    // were previously invisible because the runtime ignored
                    // this event).
                    const roundStart = Date.now();
                    try {
                        await usageStore.logUsage({
                            user_id: userId,
                            agent_id: workerId,
                            agent_name: worker.name || workerId,
                            agent_type: 'swarm',
                            model: model.modelId,
                            prompt_tokens: data.prompt_tokens || 0,
                            completion_tokens: data.completion_tokens || 0,
                            total_tokens: data.total_tokens || 0,
                            cached_tokens: data.cached_tokens || 0,
                            cache_creation_tokens: data.cache_creation_tokens || 0,
                            reasoning_tokens: data.reasoning_tokens || 0,
                            cache_ttl: data.cache_ttl || null,
                            stop_reason: data.stop_reason || null,
                            swarm_run_id: swarmRunId,
                            parent_call_id: swarmRunId,  // worker's parent is the swarm run itself
                            source: 'swarm_orchestrator',
                            organization_id: organizationId,
                            conversation_id: conversationId,
                            duration_ms: Date.now() - startedAt,
                        });
                    } catch (e) { /* ignore logging errors */ }
                    // Track totals for snapshot
                    workerTotalUsage = workerTotalUsage || { prompt: 0, completion: 0, reasoning: 0 };
                    workerTotalUsage.prompt += data.prompt_tokens || 0;
                    workerTotalUsage.completion += data.completion_tokens || 0;
                    workerTotalUsage.reasoning += data.reasoning_tokens || 0;
                }
                // thinking_* and image events are intentionally ignored for
                // workers — the synthesiser's reasoning surfaces in its
                // streamed text either way.
            };

            try {
                await model.adapter.stream(model.apiKey, model.apiUrl, model.modelId, messages, {
                    maxTokens: WORKER_DEFAULT_MAX_TOKENS,
                    temperature: isSynthesiser ? 0.4 : 0.3,
                    tools: workerTools.length > 0 ? workerTools : undefined,
                    toolChoice: workerTools.length > 0 ? 'auto' : undefined,
                }, streamCallback);
            } catch (streamErr) {
                streamErrorMessage = streamErr?.error?.message || streamErr?.message || 'Stream failed';
            }

            if (streamErrorMessage) {
                console.error(`[Swarm/${workerId}] stream error round ${round}: ${streamErrorMessage}`);
                throw new Error(streamErrorMessage);
            }
            console.log(`[Swarm/${workerId}] round ${round}: ${roundText.length} text chars, ${roundToolCalls.length} tool calls`);

            if (roundToolCalls.length === 0) {
                // No more tools — this round's text IS the final output. The
                // tokens already streamed live via the callback; we just
                // record the buffer so persistence + Hive Mind have it.
                finalText = roundText;
                break outer;
            }

            // Echo the assistant message (including any text emitted alongside
            // tool calls) so the model has full conversational history.
            messages.push({
                role: 'assistant',
                content: roundText || null,
                tool_calls: roundToolCalls,
            });

            // Execute the round's tool calls in parallel.
            const results = await Promise.all(roundToolCalls.map(async (tc) => {
                const name = tc.function.name;
                let args = {};
                try { args = JSON.parse(tc.function.arguments || '{}'); } catch (_) { /* default to {} */ }
                const toolEntry = { name, status: 'running', at: Date.now() };
                if (runSnapshot?.workers?.[workerId]) runSnapshot.workers[workerId].tools.push(toolEntry);
                send('swarm_worker_tool', { workerId, role: worker.role, toolName: name, status: 'start' });
                let toolResult;
                try {
                    toolResult = await dispatchTool(name, args, toolContext);
                } catch (err) {
                    toolResult = { error: err.message };
                }
                const finalStatus = toolResult?.error ? 'error' : 'done';
                toolEntry.status = finalStatus;
                collectedToolHistory.push({ name, status: finalStatus });
                send('swarm_worker_tool', { workerId, role: worker.role, toolName: name, status: finalStatus });
                return { tc, toolResult };
            }));

            for (const { tc, toolResult } of results) {
                messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    name: tc.function.name,
                    content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult || ''),
                });
            }
        }
    } catch (err) {
        lastError = err.message;
    }

    const durationMs = Date.now() - startedAt;
    if (lastError) {
        if (runSnapshot?.workers?.[workerId]) {
            runSnapshot.workers[workerId].status = 'failed';
            runSnapshot.workers[workerId].error = lastError;
            runSnapshot.workers[workerId].durationMs = durationMs;
        }
        send('swarm_worker_completed', { workerId, role: worker.role, status: 'failed', error: lastError, durationMs });
        return { workerId, role: worker.role, status: 'failed', error: lastError, content: finalText };
    }

    // Researchers append a Hive Mind entry. The synthesiser doesn't (its
    // output already streamed live as the assistant reply).
    if (!isSynthesiser && finalText) {
        appendHiveMindEntry(hive, {
            byWorker: workerId,
            kind: 'finding',
            title: `${worker.name} (${worker.role})`,
            body: finalText,
        });
    }

    if (runSnapshot?.workers?.[workerId]) {
        runSnapshot.workers[workerId].status = 'done';
        runSnapshot.workers[workerId].durationMs = durationMs;
    }
    send('swarm_worker_completed', {
        workerId, role: worker.role, status: 'done',
        durationMs,
        toolCount: collectedToolHistory.length,
    });
    return { workerId, role: worker.role, status: 'done', content: finalText, toolHistory: collectedToolHistory };
}

// ─── Run a turn ──────────────────────────────────────────────────────────

/**
 * Execute one swarm turn for a chat conversation.
 *
 * Required args:
 *   swarmId, message, hiveMind, send, userId, session, fallbackModelId
 *
 * Optional:
 *   userOrgId, isAdmin, resolvedTier (for tier-tools filtering)
 */
async function runSwarmTurn({
    swarmId,
    message,
    hiveMind: incomingHive,
    send,
    userId,
    session = null,
    isAdmin = false,
    fallbackModelId,
    userOrgId = null,
    resolvedTier = 'swarm',
    organizationId = null,
    conversationId = null,
}) {
    const entry = loadSwarmById(swarmId);
    if (!entry) {
        const err = new Error(`Unknown swarm id: ${swarmId}`);
        err.code = 'SWARM_NOT_FOUND';
        throw err;
    }
    const { MANIFEST, getWorkerManifest } = entry;
    const hive = incomingHive && typeof incomingHive === 'object' && Array.isArray(incomingHive.entries)
        ? incomingHive
        : emptyHiveMind();

    const startedAt = Date.now();
    // Group every worker's usage row under one id so per-swarm spend is queryable.
    const swarmRunId = crypto.randomUUID();
    send('swarm_started', {
        swarmId: MANIFEST.id,
        swarmName: MANIFEST.name,
        phases: MANIFEST.phases,
        swarmRunId,
    });

    // Live snapshot of the run — mirrors the shape useChatEngine builds
    // from SSE events on the assistant message. Persisted server-side so
    // a page refresh re-renders the timeline without replaying SSE.
    const runSnapshot = {
        state: 'running',
        swarmId: MANIFEST.id,
        swarmName: MANIFEST.name,
        phases: MANIFEST.phases,
        phaseStates: {},
        workers: {},
        startedAt,
        durationMs: null,
    };

    // Build the directChat tool stack ONCE per turn — every worker shares
    // the same view of available integrations.
    const { tools, n8nOrgId } = await buildDirectChatToolStack({
        userId, session, isAdmin, resolvedTier,
    });
    const toolContext = {
        userId,
        session,
        userAuth: session?.user || null,
        n8nOrgId,
        send,    // some tools (image gen) stream their own SSE events
    };

    // Resolve the per-turn worker manifest from the swarm's planner.
    // For v2 builtins this is a deterministic function; v3's dynamic
    // planner returns workers based on the user message.
    const phases = await getWorkerManifest({ message, hive });

    let lastResult = null;
    for (const phase of phases) {
        runSnapshot.activePhaseId = phase.id;
        runSnapshot.phaseStates[phase.id] = { status: 'active', startedAt: Date.now(), durationMs: null };

        send('swarm_phase_started', {
            phaseId: phase.id, phaseName: phase.name,
            workers: phase.workers.map(w => ({ id: w.id, role: w.role, name: w.name, tier: w.tier || 'auto' })),
        });
        const phaseStartedAt = Date.now();

        // Workers in a phase run in parallel via Promise.allSettled so a
        // single failure doesn't kill the rest of the phase.
        const settled = await Promise.allSettled(phase.workers.map(worker =>
            runWorker({
                worker,
                userMessage: message,
                hive,
                send,
                tools,
                toolContext,
                fallbackModelId,
                userOrgId,
                userId,
                isSynthesiser: !!phase.synthesiser,
                runSnapshot,
                swarmRunId,
                organizationId: organizationId || userOrgId || null,
                conversationId,
            })
        ));

        const outcomes = settled.map((r, i) => r.status === 'fulfilled'
            ? r.value
            : { workerId: phase.workers[i].id, role: phase.workers[i].role, status: 'failed', error: r.reason?.message || 'unknown error' });
        lastResult = outcomes[outcomes.length - 1];

        const phaseDurationMs = Date.now() - phaseStartedAt;
        runSnapshot.phaseStates[phase.id] = { status: 'done', startedAt: phaseStartedAt, durationMs: phaseDurationMs };
        send('swarm_phase_completed', {
            phaseId: phase.id,
            durationMs: phaseDurationMs,
        });
    }

    runSnapshot.state = 'done';
    runSnapshot.durationMs = Date.now() - startedAt;
    send('swarm_completed', { paused: false, durationMs: runSnapshot.durationMs });
    return {
        paused: false,
        finalText: lastResult?.content || '',
        hiveMind: hive,
        snapshot: runSnapshot,
    };
}

module.exports = {
    runSwarmTurn,
    loadSwarmById,
    listAvailableSwarms,
    emptyHiveMind,
    appendHiveMindEntry,
    mapWithConcurrency,
};
