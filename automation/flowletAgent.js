/**
 * flowletAgent.js — a focused sub-agent that builds (or refines) ONE inline
 * flowlet (a reusable sub-flow in definition.layers).
 *
 * This is the SINGLE primitive behind three user-facing features:
 *   1. the Flowlets-panel "Build a flowlet with AI" / "Refine with AI" endpoint,
 *   2. the main builder agent's `builder_generate_layer` delegation tool,
 *   3. `builder_generate_layers` — several flowlet agents running in parallel.
 *
 * One implementation, three callers → predictable behaviour ("not buggy").
 *
 * Design guarantees:
 *   - SCOPE LOCK: the sub-agent's tool calls are forced onto its own flowlet
 *     (args.scope = layerKey); it cannot touch the main flow or sibling
 *     flowlets. Trigger/finalize/dry-run tools are withheld.
 *   - ISOLATION (parallel): each parallel agent works on its OWN draft (a
 *     minimal valid root + a read-only copy of pre-existing flowlets + just
 *     its one flowlet skeleton), so concurrent agents never mutate a shared
 *     object. Distinct, pre-reserved keys make the merge conflict-free.
 *   - SCOPED FEEDBACK: after each mutation we validate the whole def but feed
 *     back only the records under `layers.<key>.` so the model self-corrects
 *     on its own flowlet without root noise.
 */

const llmClient = require('../core/llmClient');
const { resolveModelForTierName } = require('../core/modelResolver');
const { mapWithConcurrency } = require('../core/concurrencyUtil');
const { validateDefinition } = require('./validate');
const { getDeliverableEvents } = require('./deliverableEvents');
const {
    TOOL_SCHEMAS, MUTATING_TOOLS, SCOPED_GRAPH_TOOLS, applyToolCall,
    generateLayerKey, makeLayerSkeleton,
} = require('./builderTools');
const { renderCatalog } = require('./builderPrompt');

const MAX_LAYER_AGENT_ROUNDS = 12;
const DEFAULT_PARALLEL_CAP = 3;

// Tools a flowlet sub-agent may use: every scoped step builder + the flowlet
// contract tool + read-only tool inspection. NO trigger/finalize/dry-run/
// create_layer/metadata.
const LAYER_AGENT_TOOL_NAMES = new Set([
    ...SCOPED_GRAPH_TOOLS,
    'builder_set_layer_contract',
    'builder_inspect_tool',
]);

function layerAgentTools() {
    return TOOL_SCHEMAS.filter(t => LAYER_AGENT_TOOL_NAMES.has(t.function?.name));
}

// ── transient-error retry (local copy; layerAgent must not require the
//    route module — that would be a circular dependency) ──────────────────
function isTransientChatError(err) {
    const status = err?.status || err?.statusCode || err?.response?.status;
    if (status === 429 || (status >= 500 && status < 600)) return true;
    const msg = String(err?.message || '').toLowerCase();
    return /rate.?limit|overloaded|timeout|timed out|socket hang up|econnreset|etimedout|temporarily|try again|\b429\b|\b503\b/.test(msg);
}

async function chatWithRetry(modelId, messages, options, { retries = 2, baseDelayMs = 500 } = {}) {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            return await llmClient.chat(modelId, messages, options);
        } catch (e) {
            if (attempt >= retries || !isTransientChatError(e)) throw e;
            await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, attempt)));
            attempt++;
        }
    }
}

// ── derived state helpers ────────────────────────────────────────────────

/** Live {params, outputFields} contract of a flowlet, derived from its graph. */
function layerContract(def, layerKey) {
    const layer = def?.layers?.[layerKey];
    if (!layer) return { params: [], outputFields: [] };
    const params = Array.isArray(layer.trigger?.params) ? layer.trigger.params : [];
    const out = (layer.steps || []).find(s => s?.type === 'layer_output');
    const outputFields = out?.fields && typeof out.fields === 'object' ? Object.keys(out.fields) : [];
    return { params, outputFields };
}

/** A compact view of a flowlet's steps for the model (refine mode + results). */
function layerStepsView(def, layerKey) {
    const layer = def?.layers?.[layerKey];
    const steps = Array.isArray(layer?.steps) ? layer.steps : [];
    return steps.map(s => ({ id: s.id, type: s.type, label: s.label || s.tool || s.type }));
}

/** Validation records scoped to ONE flowlet (paths under `layers.<key>.`). */
function layerValidation(def, layerKey) {
    let v;
    try { v = validateDefinition(def, { deliverableEvents: getDeliverableEvents() }); }
    catch (_) { return { errors: [], warnings: [] }; }
    const prefix = `layers.${layerKey}.`;
    const keep = (r) => typeof r?.path === 'string' && r.path.startsWith(prefix);
    return { errors: (v.errors || []).filter(keep), warnings: (v.warnings || []).filter(keep) };
}

function buildLayerAgentPrompt({ catalog, mode, layerKey, instruction, contract }) {
    const apps = renderCatalog(catalog);
    const contractLines = [];
    if (contract?.params?.length) {
        contractLines.push(`Inputs (already declared; bind inside the flowlet as trigger.output.<name>): ${contract.params.map(p => (typeof p === 'string' ? p : p.name)).join(', ')}`);
    }
    if (contract?.outputFields?.length) {
        contractLines.push(`Must return these output fields: ${contract.outputFields.join(', ')}`);
    }
    return `You are a focused sub-agent that builds ONE reusable automation "flowlet" (a sub-flow).
You are ${mode === 'refine' ? 'REFINING the existing' : 'building a NEW'} flowlet with key "${layerKey}".

RULES — follow exactly:
- This flowlet ALREADY exists with two FIXED endpoints: a layer_input trigger (its inputs) and ONE layer_output "Return" step. NEVER add another trigger, a return/stop step, or a "set" step to hold the result — those endpoints are managed for you.
- Every step you add is automatically wired in order BEFORE the Return step, so for a straight line you do NOT need afterStepId. You may ONLY edit THIS flowlet — the scope is fixed, so do NOT pass a "scope" argument and never touch the main flow or other flowlets.
- Inputs bind as trigger.output.<paramName>; a step's output binds as steps.<stepId>.output.<field>. Refs MUST start with: trigger, steps, vars, secrets, loop.
- ITERATION: to run ONE step once per item of an upstream array, set \`forEach:{overRef:"steps.<id>.output.<array>", itemVar:"item"}\` ON that step (integration_action / ai_step / code / notification / set) and reference the item as \`loop.<itemVar>\` — do NOT add a loop step for a single repeating step. Use a loop step ONLY when several steps must repeat together per item.
- Return data by WRITING the Return step directly: builder_set_layer_contract({ layerKey: "${layerKey}", outputs: { <field>: { kind:"ref", path:"steps.<id>.output.<field>" } } }). The flowlet's value to its caller IS these outputs — every one MUST be bound to a real step output, never left empty.
- Declare inputs the same way: builder_set_layer_contract({ layerKey: "${layerKey}", params: [{ name, type, required }] }). Build the SMALLEST correct flow. Never invent tool names — use only the catalog below.
- When the flowlet is complete and validates with no errors, STOP and reply with ONE short sentence describing what the flowlet does. Do not chat or ask questions.
${contractLines.length ? `\nCONTRACT:\n${contractLines.join('\n')}\n` : ''}
INSTRUCTION:
${instruction}

CATALOG (apps & actions you may use):
${apps}`;
}

/**
 * Run the flowlet sub-agent's tool loop against `draftWrap.def.layers[layerKey]`.
 * The flowlet skeleton must already exist on draftWrap.def. Streams every tool
 * call via `send('tool_call', { layerKey, name, arguments, result })`.
 *
 * @returns {Promise<{layerKey, outputFields, params, summary, validation}>}
 */
async function runLayerAgent({
    draftWrap, layerKey, instruction, contract = null, mode = 'create',
    modelId, userId, userOrgId = null, session = null, catalog = null,
    send = () => {}, maxRounds = MAX_LAYER_AGENT_ROUNDS,
}) {
    if (!draftWrap?.def?.layers?.[layerKey]) {
        throw new Error(`runLayerAgent: flowlet "${layerKey}" does not exist on the draft.`);
    }
    const tools = layerAgentTools();
    const sys = buildLayerAgentPrompt({ catalog, mode, layerKey, instruction, contract });
    const userMsg = mode === 'refine'
        ? `Refine flowlet "${layerKey}" per the instruction. Its current steps are:\n${JSON.stringify(layerStepsView(draftWrap.def, layerKey))}`
        : `Build flowlet "${layerKey}" per the instruction.`;
    const messages = [
        { role: 'system', content: sys },
        { role: 'user', content: userMsg },
    ];

    // Lock every tool call onto THIS flowlet, then dispatch through the shared
    // applyToolCall so binding validation / keying stays identical to chat.
    const execute = async (name, rawArgs) => {
        if (!LAYER_AGENT_TOOL_NAMES.has(name)) {
            return { error: `Tool "${name}" is not available to a flowlet sub-agent. Use the step builders + builder_set_layer_contract.` };
        }
        const args = { ...(rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) };
        if (SCOPED_GRAPH_TOOLS.has(name)) args.scope = layerKey;        // scope lock
        if (name === 'builder_set_layer_contract') args.layerKey = layerKey;
        let result;
        try { result = await applyToolCall(name, args, draftWrap); }
        catch (e) { result = { error: e.message }; }
        send('tool_call', { layerKey, name, arguments: args, result });
        return result;
    };

    let summary = '';
    let lastValidation = { errors: [], warnings: [] };
    for (let round = 0; round < maxRounds; round++) {
        let response;
        try {
            response = await chatWithRetry(modelId, messages, {
                maxTokens: 8192,
                temperature: 0.2,
                tools,
                toolChoice: 'auto',
            });
        } catch (e) {
            send('layer_agent_error', { layerKey, error: e.message });
            break;
        }
        if (response.content) summary = response.content;
        if (!response.toolCalls || response.toolCalls.length === 0) break; // model is done

        messages.push({
            role: 'assistant',
            content: response.content || null,
            tool_calls: response.toolCalls.map(tc => ({
                id: tc.id,
                type: 'function',
                function: {
                    name: tc.function.name,
                    arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments),
                },
                _thought_signature: tc._thought_signature || undefined,
                _raw_content_parts: tc._raw_content_parts || undefined,
            })),
        });

        let mutated = false;
        for (const tc of response.toolCalls) {
            const name = tc.function.name;
            let args = {};
            try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : (tc.function.arguments || {}); }
            catch { args = {}; }
            const result = await execute(name, args);
            if (MUTATING_TOOLS.has(name) && result && typeof result === 'object' && !result.error) mutated = true;
            messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: typeof result === 'string' ? result : JSON.stringify(result).slice(0, 30_000),
            });
        }

        if (mutated) {
            lastValidation = layerValidation(draftWrap.def, layerKey);
            if (lastValidation.errors.length || lastValidation.warnings.length) {
                messages.push({
                    role: 'system',
                    content: `Flowlet "${layerKey}" validation (machine-readable). Fix every \`error\` before you finish. Each record is {code, severity, path, message, hint}:\n${JSON.stringify(lastValidation)}`,
                });
            }
        }
    }

    const c = layerContract(draftWrap.def, layerKey);
    return { layerKey, outputFields: c.outputFields, params: c.params, summary: (summary || '').trim(), validation: lastValidation };
}

/**
 * Build SEVERAL flowlets concurrently (bounded by `cap`, hard-capped at 3) and
 * merge the finished mini-defs into `rootDef.layers`. Each spec gets a unique
 * key reserved UP FRONT (so two same-titled flowlets never collide) and its own
 * isolated draft (so the parallel agents never race on a shared object).
 *
 * @returns {Promise<Array<{ok, layerKey, title, outputFields?, summary?, error?}>>}
 */
async function runLayersInParallel({
    rootDef, specs, modelId, userId, userOrgId = null, session = null,
    catalog = null, send = () => {}, cap = DEFAULT_PARALLEL_CAP, inputSchemasByTool = null,
}) {
    const preexisting = (rootDef.layers && typeof rootDef.layers === 'object' && !Array.isArray(rootDef.layers)) ? rootDef.layers : {};
    const reserved = { ...preexisting };
    const prepared = (Array.isArray(specs) ? specs : []).map(spec => {
        const title = String(spec?.title || 'New layer');
        const layerKey = generateLayerKey(title, reserved);
        reserved[layerKey] = true; // reserve so the next spec can't reuse it
        return { spec: spec || {}, layerKey, title };
    });

    const effCap = Math.max(1, Math.min(cap || DEFAULT_PARALLEL_CAP, DEFAULT_PARALLEL_CAP, prepared.length || 1));
    const results = await mapWithConcurrency(prepared, effCap, async ({ spec, layerKey, title }) => {
        // Isolated draft: minimal valid root + read-only pre-existing flowlets
        // (so this agent may CALL them) + this one new flowlet skeleton.
        const isoDef = {
            schemaVersion: 2,
            trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
            steps: [],
            edges: [],
            layers: { ...preexisting, [layerKey]: makeLayerSkeleton(title, spec.params) },
        };
        const isoWrap = {
            userId, orgId: userOrgId, def: isoDef, automationId: null,
            // §B: carry the inspect map + a fresh inspected-set so the
            // add-action gate and builder_inspect_tool work inside parallel
            // flowlet sub-agents too.
            _inputSchemasByTool: inputSchemasByTool || {},
            _inspectedTools: new Set(),
        };
        send('layer_agent_start', { layerKey, title });
        try {
            const r = await runLayerAgent({
                draftWrap: isoWrap,
                layerKey,
                instruction: spec.instruction || title,
                contract: { params: spec.params, outputFields: spec.outputFields },
                mode: 'create',
                modelId, userId, userOrgId, session, catalog,
                send,
            });
            send('layer_agent_done', { layerKey, outputFields: r.outputFields, summary: r.summary });
            return { ok: true, layerKey, title, layer: isoDef.layers[layerKey], outputFields: r.outputFields, summary: r.summary };
        } catch (e) {
            send('layer_agent_error', { layerKey, error: e.message });
            return { ok: false, layerKey, title, error: e.message };
        }
    });

    // Merge finished flowlets back (distinct keys → conflict-free).
    if (!rootDef.layers || typeof rootDef.layers !== 'object' || Array.isArray(rootDef.layers)) rootDef.layers = {};
    for (const res of results) {
        if (res && res.ok && res.layer) rootDef.layers[res.layerKey] = res.layer;
    }
    rootDef.schemaVersion = 2;
    return results.map(r => r.ok
        ? { ok: true, layerKey: r.layerKey, title: r.title, outputFields: r.outputFields, summary: r.summary }
        : { ok: false, layerKey: r.layerKey, title: r.title, error: r.error });
}

/** Resolve the thinking-tier model for sub-agents (fast fallback). */
async function resolveLayerAgentModel({ userOrgId = null, userId = null } = {}) {
    try {
        const m = await resolveModelForTierName('thinking', { userOrgId, userId });
        if (m) return m;
    } catch (_) { /* fall through */ }
    return resolveModelForTierName('fast', { userOrgId, userId });
}

module.exports = {
    runLayerAgent,
    runLayersInParallel,
    resolveLayerAgentModel,
    MAX_LAYER_AGENT_ROUNDS,
    DEFAULT_PARALLEL_CAP,
    // exported for tests
    _layerValidation: layerValidation,
    _layerContract: layerContract,
};
