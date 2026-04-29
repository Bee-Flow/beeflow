/**
 * Built-in swarm: Deep Research
 *
 * Manifest wrapper around the existing `server/agents/deepResearch` pipeline.
 * The swarm runtime treats this as a single opaque phase ("kind: native") that
 * produces the final answer directly — the heavy DAG, clarification loop,
 * synthesis, and citation work all live inside runDeepResearch().
 *
 * v1 Path A (per the plan): zero modifications to deepResearch internals.
 */

const { runDeepResearch, DEPTH_PRESETS } = require('../../../agents/deepResearch');

const MANIFEST = {
    id: 'builtin:deep_research',
    name: 'Deep Research',
    icon: '/BeeFlow-logo-Icon-2026.svg',
    description: 'A team of clarifier, planner, researcher, and writer workers produces a thorough, well-sourced answer with citations.',
    bestFor: 'Market research, competitive analysis, background briefings, "what does the literature say about X" questions.',
    notFor: 'Quick factual questions, short edits, fast back-and-forth chat.',
    // Depth presets (fast | normal | detailed) come from the deepResearch
    // module itself; surfaced to the UI so the user can override.
    depthPresets: Object.entries(DEPTH_PRESETS).map(([key, preset]) => ({
        key,
        label: preset.label || key,
        description: preset.description || '',
    })),
    defaultDepth: 'normal',
    // Phases the UI renders in its progress bar. Names match the events the
    // existing deepResearch agent emits (`phase` event, value of `phase`):
    //   clarify → planning → research → outline (detailed) → writing → review (≥normal)
    // The runtime maps these to swarm_phase_started / swarm_phase_completed
    // envelopes by listening to the inner events.
    phases: [
        { id: 'clarify',   name: 'Clarifying',  description: 'Checks if the question needs follow-up' },
        { id: 'planning',  name: 'Planning',    description: 'Splits the question into sub-questions' },
        { id: 'research',  name: 'Researching', description: 'Workers search web, KB, documents in parallel' },
        { id: 'outline',   name: 'Outlining',   description: 'Plans the report structure (detailed mode only)', optional: true },
        { id: 'writing',   name: 'Writing',     description: 'Drafts the final answer with citations' },
        { id: 'review',    name: 'Reviewing',   description: 'Checks accuracy & gaps (normal/detailed only)', optional: true },
    ],
    // Tells the swarm runtime to dispatch this swarm to the native runner
    // rather than the generic phase-by-phase worker loop.
    kind: 'native',
    nativeRunner: 'deepResearch',
};

/**
 * Execute the Deep Research pipeline on behalf of the swarm runtime.
 * Forwards the agent's internal events to the runtime's `send` callback,
 * mapping the relevant ones to `swarm_phase_*` envelopes so the SwarmTimeline
 * UI can render its progress bar without knowing about deepResearch internals.
 */
async function runNative({ message, options = {}, send, manifest }) {
    const phaseStartTimes = new Map();
    const seenPhases = new Set();

    const onEvent = (type, data) => {
        // Always forward the raw event so the UI / logs can use it if needed.
        send(`deep_research_${type}`, data);

        // Lift the inner phase events to swarm_* envelopes.
        if (type === 'phase' && data?.phase) {
            const phaseId = data.phase;
            if (!seenPhases.has(phaseId)) {
                seenPhases.add(phaseId);
                phaseStartTimes.set(phaseId, Date.now());
                send('swarm_phase_started', {
                    phaseId,
                    phaseName: manifest.phases.find(p => p.id === phaseId)?.name || phaseId,
                    workers: [],   // deepResearch's own DAG manages workers internally
                    message: data.message || null,
                });
            }
        }
        if (type === 'phase_done' && data?.phase) {
            const phaseId = data.phase;
            const startedAt = phaseStartTimes.get(phaseId);
            send('swarm_phase_completed', {
                phaseId,
                durationMs: startedAt ? (Date.now() - startedAt) : null,
            });
        }
        // Clarification needs to surface to the user as a chat message — emit
        // a dedicated event the frontend can render inline.
        if (type === 'clarification_needed') {
            send('swarm_clarification_required', {
                questions: data?.questions || [],
                refinedQuery: data?.refinedQuery || null,
            });
        }
    };

    const result = await runDeepResearch(message, {
        depth: options.depth || 'normal',
        model: options.model,
        userId: options.userId,
        clarificationAnswers: options.clarificationAnswers,
        researchScope: options.researchScope,
    }, onEvent);

    // If the pipeline paused for clarification, return the early-return shape
    // so the runtime knows not to stream a final answer this turn.
    if (result?.needsClarification) {
        return {
            paused: true,
            reason: 'clarification',
            payload: result,
        };
    }

    return {
        paused: false,
        finalText: result.report,
        sources: result.sources,
        metadata: result.metadata,
    };
}

module.exports = { MANIFEST, runNative };
