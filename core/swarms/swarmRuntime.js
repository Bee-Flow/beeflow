/**
 * Swarm Runtime — phased multi-agent orchestrator.
 *
 * Loads a swarm manifest (`builtin:*` for now; `swarm:*` custom swarms in v3)
 * and executes its phases. Two execution kinds:
 *
 *   - `kind: 'native'` — delegates the entire run to a hand-written module
 *     (e.g. the existing deepResearch pipeline). Used as a low-risk path so
 *     v1 ships Deep Research without rewriting it.
 *
 *   - `kind: 'generic'` — runs `swarm.phases` sequentially, with each phase's
 *     `workers` running in parallel via `mapWithConcurrency`. v2 lands this
 *     for Component Pipeline + custom swarms.
 *
 * Hive Mind: a per-conversation shared bag of structured findings. v1 stores
 * it in `direct_conversations.meta_json.hiveMind`; v2 will mirror it into the
 * user-facing notebook drawer.
 */

const { mapWithConcurrency } = require('../concurrencyUtil');

// ─── Built-in registry ───────────────────────────────────────────────────

const BUILTINS = {
    'builtin:deep_research': require('./builtins/deepResearch'),
};

function loadSwarmById(id) {
    if (!id || typeof id !== 'string') return null;
    if (BUILTINS[id]) return BUILTINS[id];
    // v3: custom swarms loaded from DB go here.
    return null;
}

function listAvailableSwarms() {
    return Object.values(BUILTINS).map(b => ({
        id: b.MANIFEST.id,
        name: b.MANIFEST.name,
        icon: b.MANIFEST.icon,
        description: b.MANIFEST.description,
        bestFor: b.MANIFEST.bestFor,
        notFor: b.MANIFEST.notFor,
        depthPresets: b.MANIFEST.depthPresets,
        defaultDepth: b.MANIFEST.defaultDepth,
        phases: b.MANIFEST.phases,
    }));
}

// ─── Hive Mind ───────────────────────────────────────────────────────────

/**
 * Initialize a Hive Mind from existing conversation state. v1 keeps it as a
 * plain object: { entries: [{ at, byWorker, kind, title, body }], summary }.
 * Workers don't write to it directly in v1 (the native deepResearch path
 * manages its own state internally); the runtime captures the run's outputs
 * into the Hive Mind on completion so the next turn / UI / future workers
 * can see what's been done.
 */
function emptyHiveMind() {
    return { entries: [], summary: null, updatedAt: null };
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

// ─── Run a turn ──────────────────────────────────────────────────────────

/**
 * Execute one swarm turn for a chat conversation.
 *
 * @param {object}   args
 * @param {string}   args.swarmId           — Swarm manifest id (e.g. 'builtin:deep_research')
 * @param {string}   args.message           — Current user message
 * @param {object}   args.options           — Per-swarm runtime options (e.g. { depth: 'normal' })
 * @param {object}   args.hiveMind          — Existing Hive Mind state from prior turns (or empty)
 * @param {function} args.send              — SSE emitter: (eventName, payload) => void
 * @param {string}   args.userId
 * @param {string|null} args.userOrgId
 * @param {string|null} args.modelOverride  — Optional concrete model to pass through
 *
 * @returns {Promise<{ paused: boolean, finalText?: string, sources?: array,
 *                     metadata?: object, hiveMind: object,
 *                     clarification?: object }>}
 */
async function runSwarmTurn({
    swarmId,
    message,
    options = {},
    hiveMind: incomingHive,
    send,
    userId,
    userOrgId = null,
    modelOverride = null,
}) {
    const entry = loadSwarmById(swarmId);
    if (!entry) {
        const err = new Error(`Unknown swarm id: ${swarmId}`);
        err.code = 'SWARM_NOT_FOUND';
        throw err;
    }
    const { MANIFEST, runNative } = entry;
    const hive = incomingHive && typeof incomingHive === 'object'
        ? incomingHive
        : emptyHiveMind();

    const startedAt = Date.now();
    send('swarm_started', {
        swarmId: MANIFEST.id,
        swarmName: MANIFEST.name,
        phases: MANIFEST.phases,
        depth: options.depth || MANIFEST.defaultDepth,
    });

    // v1 only ships native swarms (Deep Research). Generic phase-by-phase
    // execution lands in v2 for Component Pipeline + custom swarms.
    if (MANIFEST.kind !== 'native' || typeof runNative !== 'function') {
        send('swarm_completed', { error: `Generic swarm execution is not implemented yet (manifest kind: ${MANIFEST.kind})` });
        const err = new Error(`Swarm kind "${MANIFEST.kind}" is not implemented yet.`);
        err.code = 'SWARM_NOT_IMPLEMENTED';
        throw err;
    }

    let result;
    try {
        result = await runNative({
            message,
            options: { ...options, model: modelOverride, userId },
            send,
            manifest: MANIFEST,
        });
    } catch (err) {
        send('swarm_completed', { error: err.message, durationMs: Date.now() - startedAt });
        throw err;
    }

    // Clarification path: the swarm asked the user a follow-up. Don't stream
    // a final answer; the chat UI renders the clarification questions inline
    // and the user's reply re-enters this function with `clarificationAnswers`.
    if (result.paused && result.reason === 'clarification') {
        send('swarm_completed', {
            paused: true,
            reason: 'clarification',
            durationMs: Date.now() - startedAt,
        });
        return {
            paused: true,
            clarification: result.payload,
            hiveMind: hive,
        };
    }

    // Persist the run's headline output into the Hive Mind so the next turn
    // (and the UI) can see what the swarm produced.
    appendHiveMindEntry(hive, {
        byWorker: 'deep_research',
        kind: 'final_report',
        title: result.metadata?.topic || 'Deep Research',
        body: result.finalText || '',
    });
    if (Array.isArray(result.sources) && result.sources.length > 0) {
        appendHiveMindEntry(hive, {
            byWorker: 'deep_research',
            kind: 'sources',
            title: `${result.sources.length} sources`,
            body: JSON.stringify(result.sources.slice(0, 50)),
        });
    }

    // Stream the final answer as ordinary `content` events so the existing
    // chat renderer handles it with no special UI mode. Chunked so the SSE
    // looks like a normal streamed reply (some clients buffer huge single
    // events and re-render less smoothly).
    if (typeof result.finalText === 'string' && result.finalText.length > 0) {
        const chunkSize = 256;
        for (let i = 0; i < result.finalText.length; i += chunkSize) {
            send('content', { content: result.finalText.slice(i, i + chunkSize) });
        }
    }

    send('swarm_completed', {
        paused: false,
        durationMs: Date.now() - startedAt,
        sourceCount: Array.isArray(result.sources) ? result.sources.length : 0,
        metadata: result.metadata || null,
    });

    return {
        paused: false,
        finalText: result.finalText || '',
        sources: result.sources || [],
        metadata: result.metadata || null,
        hiveMind: hive,
    };
}

module.exports = {
    runSwarmTurn,
    loadSwarmById,
    listAvailableSwarms,
    emptyHiveMind,
    appendHiveMindEntry,
    // Re-exported for downstream consumers that want bounded parallelism.
    mapWithConcurrency,
};
