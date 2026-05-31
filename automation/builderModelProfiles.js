/**
 * Model-class capability profiles for the automation builder.
 *
 * The builder behaves the same across every supported provider (the tool
 * schemas are OpenAI-function-calling format and the provider adapters
 * normalise input/output). What DIFFERS is how reliably each model class
 * holds onto the structured tool-calling protocol:
 *
 *   - Frontier (Opus, GPT-5-pro, o3, Mistral Large) handles the full
 *     220-line prompt + 26 tools and consistently emits well-formed
 *     bindings on the first try.
 *   - Mid (Sonnet, GPT-4o, GPT-4.1, Mistral Medium) is reliable but
 *     wastes turns when the catalogue is enormous.
 *   - Small (Haiku, GPT-5-mini, Mistral Small, Ministral 8B) drops to
 *     prose if not pinned with tool_choice, picks the wrong tool from a
 *     26-item menu, and emits bare-string inputs that don't match the
 *     binding shape.
 *   - Reasoning (Magistral, o3) think hard but produce terse outputs and
 *     need lower temperature to keep tool-call JSON stable.
 *
 * This module centralises those decisions so the rest of the builder
 * route (server/routes/ai/automationBuilder.js) doesn't grow a tree of
 * if/else on model IDs.
 */

// Regex bands ordered from most-specific to most-generic. First match
// wins. Anchored to lowercased modelId.
const FRONTIER_PATTERNS = [
    /opus/i,
    /\bo3\b/i,
    /gpt-?5\.?2-?pro/i,
    /gpt-?5-?pro/i,
    /mistral-large/i,
    /gemini-3\.1-pro/i,
];

const REASONING_PATTERNS = [
    /magistral/i,
    /^o3/i,        // o3 (frontier overlaps; we tag it as reasoning when both fire)
    /^o4/i,
    /thinking/i,
];

const SMALL_PATTERNS = [
    /haiku/i,
    /\bmini\b/i,
    /-mini-/i,
    /\b(small|nano)\b/i,
    /\b\d{1,2}b\b/i,             // matches 3b / 8b / 14b model sizes
    /ministral/i,
    /flash/i,
];

/**
 * Classify a resolved model ID into a capability band.
 * @returns {'frontier'|'mid'|'small'|'reasoning'}
 *
 * 'reasoning' is an overlay: models that fit both reasoning AND
 * (frontier|small) get tagged as reasoning so the temperature drops to
 * 0 — reasoning models are sensitive to noise in tool-call JSON.
 */
function classifyModel(modelId) {
    const id = String(modelId || '').toLowerCase();
    if (!id) return 'mid';
    const isReasoning = REASONING_PATTERNS.some(rx => rx.test(id));
    if (isReasoning) return 'reasoning';
    if (FRONTIER_PATTERNS.some(rx => rx.test(id))) return 'frontier';
    if (SMALL_PATTERNS.some(rx => rx.test(id))) return 'small';
    return 'mid';
}

const PROFILES = {
    frontier: {
        promptVariant: 'full',
        toolset: 'full',
        temperature: 0.2,
        maxIterations: 16,
        forceFirstToolCall: false,
        catalogMode: 'full',
        fewShots: 0,
    },
    mid: {
        promptVariant: 'full',
        toolset: 'full',
        temperature: 0.2,
        maxIterations: 20,
        forceFirstToolCall: false,
        catalogMode: 'full',
        fewShots: 1,
    },
    small: {
        promptVariant: 'lean',
        toolset: 'core',
        temperature: 0.1,
        maxIterations: 24,
        forceFirstToolCall: true,
        catalogMode: 'filtered',
        // 3 so the lean-prompt profile (which most needs worked examples) also
        // sees the Nextcloud file.new → read → AI → Talk example (index 2).
        fewShots: 3,
    },
    reasoning: {
        promptVariant: 'lean',
        toolset: 'full',
        temperature: 0.0,
        maxIterations: 20,
        forceFirstToolCall: false,
        catalogMode: 'full',
        fewShots: 1,
    },
};

function getProfile(modelClass) {
    return PROFILES[modelClass] || PROFILES.mid;
}

function getProfileForModel(modelId) {
    return getProfile(classifyModel(modelId));
}

// Tools the 'core' subset exposes. Everything else stays available under
// 'full' (frontier / mid / reasoning). The DAG-structural tools (loop,
// condition) stay in core; only array ops are folded into the unified
// builder_add_array_op. This list is deliberately small so a Ministral-
// class model isn't picking from 26 choices.
const CORE_TOOL_NAMES = new Set([
    'builder_propose_trigger',
    'builder_add_action',
    'builder_add_ai_step',
    'builder_add_condition',
    'builder_add_loop',
    'builder_add_notification',
    'builder_add_array_op',
    'builder_remove_step',
    'builder_set_metadata',
    'builder_inspect_tool',
    'builder_summarise',
    'builder_request_dry_run',
    'builder_finalize',
]);

module.exports = {
    classifyModel,
    getProfile,
    getProfileForModel,
    CORE_TOOL_NAMES,
};
