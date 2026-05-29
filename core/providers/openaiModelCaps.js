/**
 * OpenAI / Azure model capability helpers.
 *
 * Single source of truth for GPT-5 / o-series parameter rules so the OpenAI
 * adapter and the Azure adapter (which extends it) stay in lock-step. Replaces
 * the old per-class `normalizeEffort` + inline `reasoning` blocks that drifted
 * apart between the two providers.
 *
 * Reference (Microsoft Learn, Azure OpenAI reasoning models, 2026):
 *   - reasoning_effort valid values: none | minimal | low | medium | high | xhigh
 *       · `minimal` is the fast/cheap path on the GPT-5 family (o-series has no
 *         `minimal` — it floors at `low`).
 *       · `xhigh` only exists on gpt-5.1-codex-max — elsewhere it caps at `high`.
 *       · `gpt-5-pro` / `gpt-5.2-pro` / `gpt-5.4-pro` support ONLY `high`.
 *   - reasoning.summary accepts `auto` | `detailed`. `concise` is NOT supported
 *     on the GPT-5 series, so we only ever emit a summary when one is requested.
 *   - `text.verbosity` (low | medium | high) is a GPT-5-only output-length knob.
 *   - `parallel_tool_calls` is not supported when reasoning_effort = `minimal`.
 */

const VALID_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

// Pro models are locked to high reasoning effort (gpt-5-pro, gpt-5.2-pro, gpt-5.4-pro, …)
const PRO_MODEL = /^gpt-5(\.\d+)?-pro$/;
// codex-max is the only model that accepts the `xhigh` effort tier
const CODEX_MAX = /codex-max/;
const GPT5_FAMILY = /^gpt-5/;
const O_SERIES = /^o\d/;

function isProModel(model) {
    return typeof model === 'string' && PRO_MODEL.test(model);
}

/** GPT-5 family supports the `text.verbosity` parameter; o-series does not. */
function supportsVerbosity(model) {
    return typeof model === 'string' && GPT5_FAMILY.test(model);
}

/**
 * Clamp a requested reasoning effort to what the given model actually supports,
 * passing through valid efforts rather than blanket-downgrading. Returns null
 * when no effort was requested (caller then applies its own default).
 */
function clampEffort(model, effort) {
    if (!effort) return null;
    const m = String(model || '');

    // Pro models only accept `high`.
    if (isProModel(m)) return 'high';

    if (effort === 'xhigh') {
        // Only codex-max understands xhigh; everywhere else cap at high.
        return CODEX_MAX.test(m) ? 'xhigh' : 'high';
    }

    if (effort === 'minimal') {
        // The GPT-5 family has a real `minimal` tier; o-series floors at `low`.
        if (GPT5_FAMILY.test(m)) return 'minimal';
        if (O_SERIES.test(m)) return 'low';
        return 'minimal';
    }

    return VALID_EFFORTS.has(effort) ? effort : 'medium';
}

/**
 * Build the Responses API `reasoning` object.
 * Always sets `effort`; only attaches `summary` when one was requested
 * (`'auto'` by default, `'detailed'` when explicitly asked) — never `'concise'`,
 * which the GPT-5 series rejects.
 */
function buildReasoningParams(model, options = {}) {
    const reasoning = {};
    const effort = clampEffort(model, options.reasoningEffort);
    reasoning.effort = effort || 'medium';

    if (options.reasoningSummary) {
        reasoning.summary = options.reasoningSummary === 'detailed' ? 'detailed' : 'auto';
    }
    return reasoning;
}

/**
 * Tier-appropriate default verbosity for GPT-5 models. Returns undefined for
 * non-GPT-5 models (parameter unsupported) so callers can omit it entirely.
 */
function defaultVerbosity(model, tierName) {
    if (!supportsVerbosity(model)) return undefined;
    if (tierName === 'fast' || tierName === 'swarm') return 'low';
    if (tierName === 'writer' || tierName === 'deep_thinking') return 'high';
    return 'medium';
}

/** parallel_tool_calls is incompatible with `minimal` reasoning effort. */
function supportsParallelToolCalls(effort) {
    return effort !== 'minimal';
}

/**
 * Map our internal toolChoice values to the Responses/Chat API `tool_choice`.
 * 'any'/'required' → 'required'; 'auto'/'none' pass through; objects pass through.
 */
function mapToolChoice(toolChoice) {
    if (!toolChoice) return undefined;
    if (typeof toolChoice === 'object') return toolChoice;
    if (toolChoice === 'any' || toolChoice === 'required') return 'required';
    if (toolChoice === 'auto' || toolChoice === 'none') return toolChoice;
    return 'auto';
}

module.exports = {
    clampEffort,
    buildReasoningParams,
    defaultVerbosity,
    supportsVerbosity,
    supportsParallelToolCalls,
    mapToolChoice,
    isProModel,
};
