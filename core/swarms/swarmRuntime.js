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

const { mapWithConcurrency } = require('../concurrencyUtil');
const { resolveModelForTier, getTierConfig } = require('../modelResolver');
const { getProviderForModel } = require('../aiAgent');
const { getAdapter } = require('../providers');
const { buildDirectChatToolStack } = require('../directChatToolStack');
const { executeTool: dispatchTool } = require('../toolDispatcher');

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
}) {
    const startedAt = Date.now();
    const workerId = worker.id;
    let model;
    try {
        model = await resolveWorkerModel({ worker, fallbackModelId, userOrgId, userId });
    } catch (err) {
        send('swarm_worker_completed', {
            workerId, role: worker.role, status: 'failed',
            error: `Model resolution failed: ${err.message}`,
            durationMs: Date.now() - startedAt,
        });
        return { workerId, role: worker.role, status: 'failed', error: err.message };
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

    // ── Tool-call loop ───────────────────────────────────────────────
    let collectedToolHistory = [];
    let finalText = '';
    let lastError = null;

    try {
        for (let round = 0; round < MAX_TOOL_ROUNDS_PER_WORKER; round++) {
            const result = await model.adapter.chat(model.apiKey, model.apiUrl, model.modelId, messages, {
                maxTokens: WORKER_DEFAULT_MAX_TOKENS,
                temperature: isSynthesiser ? 0.4 : 0.3,
                tools: workerTools,
                toolChoice: 'auto',
            });

            const toolCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
            const content = typeof result?.content === 'string' ? result.content : '';

            if (toolCalls.length === 0) {
                // No more tools — this is the worker's final output.
                finalText = content;
                break;
            }

            // Echo the assistant tool-call message so the model has full history.
            messages.push({
                role: 'assistant',
                content: content || null,
                tool_calls: toolCalls,
            });

            // Execute each tool call (parallel within a round).
            const results = await Promise.all(toolCalls.map(async (tc) => {
                const name = tc.function?.name || tc.name;
                let args = {};
                try { args = JSON.parse(tc.function?.arguments || tc.arguments || '{}'); } catch (_) { /* default to {} */ }
                send('swarm_worker_tool', { workerId, role: worker.role, toolName: name, status: 'start' });
                let toolResult;
                try {
                    toolResult = await dispatchTool(name, args, toolContext);
                } catch (err) {
                    toolResult = { error: err.message };
                }
                collectedToolHistory.push({ name, status: toolResult?.error ? 'error' : 'done' });
                send('swarm_worker_tool', { workerId, role: worker.role, toolName: name, status: toolResult?.error ? 'error' : 'done' });
                return { tc, toolResult };
            }));

            // Push tool-result messages back so the next round sees them.
            for (const { tc, toolResult } of results) {
                messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    name: tc.function?.name || tc.name,
                    content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult || ''),
                });
            }
        }

        // ── Stream the final text chunk-by-chunk ─────────────────────
        // Researchers get a private content channel keyed by workerId.
        // The synthesiser streams as ordinary `content` so the chat
        // renderer treats it as the assistant's reply with no special
        // handling.
        if (finalText && finalText.length > 0) {
            const eventName = isSynthesiser ? 'content' : 'swarm_worker_content';
            const chunkSize = 256;
            for (let i = 0; i < finalText.length; i += chunkSize) {
                const delta = finalText.slice(i, i + chunkSize);
                send(eventName, isSynthesiser ? { content: delta } : { workerId, delta });
            }
        }
    } catch (err) {
        lastError = err.message;
    }

    const durationMs = Date.now() - startedAt;
    if (lastError) {
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
    send('swarm_started', {
        swarmId: MANIFEST.id,
        swarmName: MANIFEST.name,
        phases: MANIFEST.phases,
    });

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
            })
        ));

        const outcomes = settled.map((r, i) => r.status === 'fulfilled'
            ? r.value
            : { workerId: phase.workers[i].id, role: phase.workers[i].role, status: 'failed', error: r.reason?.message || 'unknown error' });
        lastResult = outcomes[outcomes.length - 1];

        send('swarm_phase_completed', {
            phaseId: phase.id,
            durationMs: Date.now() - phaseStartedAt,
        });
    }

    send('swarm_completed', { paused: false, durationMs: Date.now() - startedAt });
    return {
        paused: false,
        finalText: lastResult?.content || '',
        hiveMind: hive,
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
