/**
 * Builder tools — function-calling schemas the conversational builder agent
 * uses to mutate a draft automation. Each tool has:
 *   - schema (OpenAI/Anthropic function-call format) injected into the LLM
 *   - apply() implementation that mutates a Draft instance and returns
 *     a small JSON snippet describing the change.
 *
 * Drafts are kept per (userId, builderSessionId) and persisted to
 * automations(is_draft=TRUE) after every successful mutation, so a
 * page refresh recovers the work.
 */

const crypto = require('crypto');
const automationStore = require('../stores/automationStore');
const { summariseDefinition } = require('./summarise');
const { validateDefinition, collectCallLayerSteps } = require('./validate');
const { getDeliverableEvents } = require('./deliverableEvents');
const { isSideEffect } = require('./sideEffectMap');

// §WS5 — trigger catalog data + tool schemas live in ./builderTools/.
const { TRIGGER_FIELDS_BY_EVENT, triggerFieldsFor, TRIGGER_OUTPUT_SAMPLES, buildTriggerOutputsCatalog } = require('./builderTools/triggerCatalog');
const { TOOL_SCHEMAS } = require('./builderTools/schemas');

function newId(prefix = 's') { return `${prefix}_${crypto.randomBytes(3).toString('hex')}`; }

function emptyDefinition() {
    return {
        schemaVersion: 1,
        trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
        steps: [],
        edges: [],
        vars: {},
    };
}

/**
 * Coerce a step's inputs into canonical binding form.
 *
 * Tolerates the AI's common mistakes:
 *   - raw strings/numbers/booleans/arrays passed where a binding wrapper
 *     was expected → wrapped as { kind: 'literal', value: ... }
 *   - strings that look like template paths "{{...}}" → upgraded to template
 *   - already-canonical bindings → passed through unchanged
 *
 * Lossless: anything already valid keeps its shape. Anything ambiguous
 * defaults to literal so the runtime won't crash on bad refs.
 */
function canonicalizeInputs(inputs) {
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return {};
    const out = {};
    for (const [k, v] of Object.entries(inputs)) {
        out[k] = canonicalizeBinding(v);
    }
    return out;
}

// Normalise a ref path the way weaker models tend to mangle it:
//   $steps.x.output.y   → steps.x.output.y     (leading $ for "expression")
//   steps[x].output[y]  → steps.x.output.y     (bracket access)
//   .steps.x.output.y   → steps.x.output.y     (leading dot)
//   steps . x . output  → steps.x.output       (stray whitespace)
function _normalizeRefPath(path) {
    if (typeof path !== 'string') return path;
    return path
        .trim()
        .replace(/^\$+/, '')
        .replace(/\[\s*['"]?([^\]'"]+)['"]?\s*\]/g, '.$1')
        .replace(/^\.+/, '')
        .replace(/\s*\.\s*/g, '.')
        .replace(/\.{2,}/g, '.');
}

function canonicalizeBinding(v) {
    // Already a binding wrapper with a recognised kind — normalise ref/template values then pass through.
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.kind === 'string'
        && ['literal', 'ref', 'template', 'expr'].includes(v.kind)) {
        if (v.kind === 'ref' && typeof v.path === 'string') {
            const normalised = _normalizeRefPath(v.path);
            if (normalised !== v.path) return { ...v, path: normalised };
        }
        return v;
    }
    // Wrapper with no kind but has a discriminating field — infer the kind.
    // Weaker models often emit { value: "..." } or { path: "..." } without
    // the kind tag; we recover those instead of silently flattening to literal.
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (typeof v.path === 'string') {
            return { kind: 'ref', path: _normalizeRefPath(v.path) };
        }
        if ('value' in v && Object.keys(v).every(k => k === 'value' || k === 'kind')) {
            const val = v.value;
            if (typeof val === 'string' && /\{\{[^}]+\}\}/.test(val)) {
                return { kind: 'template', value: val };
            }
            return { kind: 'literal', value: val };
        }
        // Unrecognised object shape → wrap as literal so the runtime
        // doesn't see an opaque blob. The LLM gets a repair hint via
        // validateAndFixBindings so it learns the right shape.
    }
    // String containing {{...}} → template.
    if (typeof v === 'string' && /\{\{[^}]+\}\}/.test(v)) {
        return { kind: 'template', value: v };
    }
    // Anything else → literal. This is the safe, runtime-friendly choice.
    return { kind: 'literal', value: v };
}

// Was the raw value already in canonical binding shape? Used by
// validateAndFixBindings to decide which inputs need a "you sent a bare
// string, I wrapped it as literal" repair hint sent back to the LLM.
function _isCanonicalBinding(v) {
    return v && typeof v === 'object' && !Array.isArray(v)
        && typeof v.kind === 'string'
        && ['literal', 'ref', 'template', 'expr'].includes(v.kind);
}

const VALID_REF_ROOTS = new Set(['trigger', 'steps', 'vars', 'secrets', 'loop']);

// Trigger output fields the LLM commonly mis-roots — when a ref path is bare
// ("from", "subject", …) we can confidently prepend `trigger.output.` instead
// of bouncing the call back to the model. Keyed by `<provider>.<event>`.
function validateAndFixBindings(rawInputs, draft) {
    const fixed = canonicalizeInputs(rawInputs || {});
    const triggerFields = new Set(triggerFieldsFor(draft));
    const errors = [];
    const repairs = [];

    // Record auto-wrapping: if the caller passed a bare value (string, number,
    // boolean, plain {value:...}) for a key, canonicalizeBinding already wrapped
    // it as literal. Surface this to the LLM as a repair hint so the next call
    // uses the binding shape directly.
    for (const [k, raw] of Object.entries(rawInputs || {})) {
        if (!_isCanonicalBinding(raw)) {
            const cur = fixed[k];
            if (cur && cur.kind === 'literal') {
                repairs.push(`inputs.${k}: wrapped bare value as {kind:"literal", value:…}. Use the binding shape next time.`);
            } else if (cur && cur.kind === 'template') {
                repairs.push(`inputs.${k}: detected {{…}} placeholders in a bare string; wrapped as {kind:"template", value:…}.`);
            } else if (cur && cur.kind === 'ref') {
                repairs.push(`inputs.${k}: inferred ref shape from {path:…}; wrapped as {kind:"ref", path:…}.`);
            }
        }
    }

    for (const [k, v] of Object.entries(fixed)) {
        if (!v || typeof v !== 'object') continue;

        if (v.kind === 'ref' && typeof v.path === 'string') {
            const cleaned = v.path.replace(/^\.+/, '').trim();
            const root = cleaned.split('.')[0];
            // Handle "trigger.<field>" (skipping the .output. segment) BEFORE the
            // VALID_REF_ROOTS short-circuit, because 'trigger' is itself a valid
            // root and the short-circuit would otherwise leave the path broken.
            const segments = cleaned.split('.');
            if (root === 'trigger' && segments.length === 2 && segments[1] !== 'output' && triggerFields.has(segments[1])) {
                v.path = `trigger.output.${segments[1]}`;
                repairs.push(`inputs.${k}: inserted .output. segment → "${v.path}".`);
                continue;
            }
            if (VALID_REF_ROOTS.has(root)) {
                if (cleaned !== v.path) {
                    v.path = cleaned;
                    repairs.push(`inputs.${k}: cleaned ref path to "${cleaned}".`);
                }
                continue;
            }
            if (triggerFields.has(cleaned)) {
                v.path = `trigger.output.${cleaned}`;
                repairs.push(`inputs.${k}: prepended root → "${v.path}". Always start ref paths with trigger/steps/vars/secrets/loop.`);
                continue;
            }
            // "output.foo" → "trigger.output.foo" (when foo is a known trigger field).
            if (cleaned.startsWith('output.') && triggerFields.has(cleaned.slice('output.'.length))) {
                v.path = `trigger.${cleaned}`;
                repairs.push(`inputs.${k}: prepended trigger root → "${v.path}".`);
                continue;
            }
            errors.push(
                `inputs.${k}: ref path "${v.path}" has unknown root "${root}". `
                + `Valid roots: trigger, steps, vars, secrets, loop. `
                + (triggerFields.size
                    ? `For this trigger use trigger.output.<field>, e.g. trigger.output.${triggerFields.has(cleaned) ? cleaned : 'subject'}.`
                    : 'Use e.g. trigger.output.<field> or steps.<id>.output.<field>.')
            );
        }

        if (v.kind === 'template' && typeof v.value === 'string') {
            // Re-write {{ from }} → {{ trigger.output.from }} when the bare
            // identifier matches a known trigger field. Reject anything else
            // that has an unknown root.
            const bad = [];
            const rewrites = [];
            v.value = v.value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, expr) => {
                const cleaned = expr.replace(/^\.+/, '').trim();
                const root = cleaned.split('.')[0];
                if (VALID_REF_ROOTS.has(root)) return `{{${cleaned}}}`;
                if (triggerFields.has(cleaned)) {
                    rewrites.push(cleaned);
                    return `{{trigger.output.${cleaned}}}`;
                }
                bad.push(expr);
                return full;
            });
            if (rewrites.length) {
                repairs.push(`inputs.${k}: template placeholders ${rewrites.map(s => `"${s}"`).join(', ')} prepended with trigger.output.`);
            }
            if (bad.length) {
                errors.push(
                    `inputs.${k}: template references ${bad.map(s => `"${s}"`).join(', ')} which has unknown root. `
                    + `Use {{trigger.output.<field>}} or {{steps.<id>.output.<field>}}.`
                );
            }
        }
    }

    return {
        inputs: fixed,
        error: errors.length ? errors.join(' ') : null,
        repairs: repairs.length ? repairs : undefined,
    };
}

/**
 * Validate an optional per-step `forEach` spec. A leaf step (integration_action
 * / ai_step / code / notification / set) can run once per item of an upstream
 * array WITHOUT a wrapping `loop` container — the runner iterates the step and
 * its body refers to the current item as `loop.<itemVar>`. The `overRef` is
 * validated exactly like an input ref (root must be trigger/steps/vars/secrets/
 * loop) so it self-repairs and errors consistently with everything else.
 *
 * Returns `{ forEach }` (forEach === undefined when `raw` is absent) or `{ error }`.
 */
function sanitizeForEach(raw, graph) {
    if (raw === undefined || raw === null) return { forEach: undefined };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { error: 'forEach must be an object { overRef, itemVar, maxIterations? }, or omitted.' };
    }
    if (!raw.overRef || typeof raw.overRef !== 'string') {
        return { error: 'forEach requires `overRef` — a ref to an upstream array, e.g. "steps.<id>.output.results".' };
    }
    const { inputs, error } = validateAndFixBindings({ overRef: { kind: 'ref', path: raw.overRef } }, graph);
    if (error) return { error: `forEach.overRef: ${error}` };
    const itemVar = (typeof raw.itemVar === 'string' && raw.itemVar.trim()) ? raw.itemVar.trim() : 'item';
    const forEach = { overRef: inputs.overRef.path, itemVar };
    if (raw.maxIterations !== undefined) {
        const n = Number(raw.maxIterations);
        if (!Number.isInteger(n) || n < 1 || n > 1000) {
            return { error: 'forEach.maxIterations must be an integer between 1 and 1000.' };
        }
        forEach.maxIterations = n;
    }
    return { forEach };
}

function lastStepId(def) {
    if (def.steps.length === 0) return def.trigger.id;
    return def.steps[def.steps.length - 1].id;
}

// ── Tool schemas (injected to the LLM) ─────────────────

// ─── Binding format reminder for the AI ──────────────────────────
// Every input value MUST be one of these shapes (or a plain JSON literal,
// which is treated as { kind: 'literal', value: ... }):
//   { "kind": "literal",  "value": <any> }
//   { "kind": "ref",      "path":  "steps.s1.output.items[0].subject" }
//   { "kind": "template", "value": "Found {{steps.s1.output.count}} items" }
//   { "kind": "expr",     "value": "steps.s1.output.amount > 1000" }
// §WS5 — BINDING_HINT moved to ./builderTools/schemas.js (its only consumer).

function applyTrigger(draft, args) {
    draft.trigger = { id: 'trg', type: 'trigger', kind: args.kind, output: {} };
    if (args.kind === 'schedule') draft.trigger.schedule = { cron: args.cron, tz: args.tz || 'Europe/Amsterdam' };
    if (args.kind === 'webhook') draft.trigger.webhook = {};
    if (args.kind === 'app_event') draft.trigger.appEvent = { provider: args.appProvider, event: args.appEvent, filter: args.filter || null };
    return { trigger: draft.trigger };
}

/**
 * Build the edge connecting `fromId` → `toId`, labelling it correctly when
 * `fromId` is a branching step. Appending a step after a condition (the
 * documented way to grow a branch) MUST produce a labelled edge — the runner
 * routes conditions with a strict `e.label === 'then'/'else'` match
 * (automationRunner.js nextEdgesFor), so an unlabelled edge would dead-end.
 * Auto-infers the label (then first, else second) and accepts an explicit
 * `branch` override; switches use `caseName`. Non-branching predecessors get
 * a plain `{from, to}` edge — identical to the previous behaviour.
 *
 * §WS4: `branch:'error'` labels the edge 'on_error' regardless of the
 * predecessor type — the runner only follows it when the source step
 * exhausts its retries and fails. Validation enforces which step types may
 * carry an error branch (edge.error_label_invalid / _unlikely).
 */
function branchEdgeFor(draft, fromId, toId, { branch, caseName } = {}) {
    const edge = { from: fromId, to: toId };
    if (branch === 'error') {
        edge.label = 'on_error';
        return edge;
    }
    const pred = (draft.steps || []).find(s => s.id === fromId);
    if (pred && pred.type === 'condition') {
        let label = (branch === 'then' || branch === 'else') ? branch : null;
        if (!label) {
            const labels = new Set((draft.edges || []).filter(e => e.from === fromId).map(e => e.label));
            label = labels.has('then') ? 'else' : 'then';
        }
        edge.label = label;
    } else if (pred && pred.type === 'switch' && typeof caseName === 'string' && caseName) {
        edge.label = caseName === 'default' ? 'case:default' : `case:${caseName}`;
        edge.caseName = caseName;
    }
    return edge;
}

/**
 * Resolve the predecessor id a freshly-built step (id `newStepId`) should be
 * wired FROM, keeping a flowlet's `layer_output` ("Return") step terminal.
 *
 * A flowlet skeleton wires `trigger → layer_output` straight away, so the naive
 * "append after the last step" lands every new step AFTER the output — the
 * flowlet then returns nothing and does its real work as dead code. Here, when
 * the natural anchor would be the output (no explicit afterStepId, or it points
 * AT the output), we splice the new step in just before it: re-point the
 * output's incoming edge to come from the new step and return the output's old
 * predecessor as the anchor. Non-flowlet graphs (no layer_output) are unaffected.
 */
function layerAwareAnchor(graph, afterStepId, newStepId) {
    const out = Array.isArray(graph.steps) ? graph.steps.find(s => s && s.type === 'layer_output') : null;
    // No output, or an explicit anchor on a real (non-output) step → respect it.
    if (!out || (afterStepId && afterStepId !== out.id)) {
        return afterStepId || lastStepId(graph);
    }
    const feed = Array.isArray(graph.edges) ? graph.edges.find(e => e && e.to === out.id) : null;
    const anchor = feed ? feed.from : (graph.trigger?.id || lastStepId(graph));
    if (feed) feed.from = newStepId;                       // out now follows the new step
    else (graph.edges = graph.edges || []).push({ from: newStepId, to: out.id });
    return anchor;
}

function appendAfter(draft, afterStepId, step, opts = {}) {
    const anchor = layerAwareAnchor(draft, afterStepId, step.id);
    draft.steps.push(step);
    draft.edges.push(branchEdgeFor(draft, anchor, step.id, opts));
    return step;
}

function applyAddAction(draft, args, draftWrap) {
    const gate = inspectGateError(args.tool, args.inputs, draftWrap);
    if (gate) return gate;
    const { inputs, error } = validateAndFixBindings(args.inputs || {}, draft);
    if (error) return { error };
    const { forEach, error: feErr } = sanitizeForEach(args.forEach, draft);
    if (feErr) return { error: feErr };
    const step = {
        id: newId('a'),
        type: 'integration_action',
        tool: args.tool,
        inputs,
        label: args.label || args.tool,
        sideEffect: isSideEffect(args.tool),
        ...(forEach ? { forEach } : {}),
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName });
    return { added: step };
}

function applyAddAi(draft, args) {
    const { inputs, error } = validateAndFixBindings(args.inputs || {}, draft);
    if (error) return { error };
    const { forEach, error: feErr } = sanitizeForEach(args.forEach, draft);
    if (feErr) return { error: feErr };
    const step = {
        id: newId('ai'),
        type: 'ai_step',
        prompt: args.prompt,
        // Optional override of the runner's default system prompt. When
        // omitted we use the safe baseline ("You are a step inside a
        // no-code automation..."). The user can edit this from the
        // inspector's Settings tab to set a tone or role.
        systemPrompt: typeof args.systemPrompt === 'string' && args.systemPrompt.trim() ? args.systemPrompt.trim() : null,
        inputs,
        outputSchema: args.outputSchema || null,
        // Default to 'auto' so the AI step honours the org's tier classifier
        // — same default as direct chat. Builder can override per step.
        modelTier: args.modelTier || 'auto',
        label: args.label || 'AI step',
        allowTools: !!args.allowTools,
        tools: Array.isArray(args.tools) ? args.tools.filter(t => typeof t === 'string') : null,
        ...(forEach ? { forEach } : {}),
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName });
    return { added: step };
}

function applyAddCondition(draft, args) {
    const step = { id: newId('cond'), type: 'condition', expr: args.expr, label: args.label || 'Condition' };
    const lastId = layerAwareAnchor(draft, args.afterStepId, step.id);
    draft.steps.push(step);
    // Route the incoming edge through branchEdgeFor so chaining a condition
    // directly after another condition/switch still labels the branch.
    draft.edges.push(branchEdgeFor(draft, lastId, step.id, { branch: args.branch, caseName: args.caseName }));
    if (args.thenStepId) draft.edges.push({ from: step.id, to: args.thenStepId, label: 'then' });
    if (args.elseStepId) draft.edges.push({ from: step.id, to: args.elseStepId, label: 'else' });
    return { added: step };
}

function applyAddLoop(draft, args) {
    // Sanitize child body steps: every child must have an id, type, and any
    // type-specific required fields. Missing ids would crash the runner with
    // a null step_id DB constraint.
    const rawBody = Array.isArray(args.body) ? args.body : [];
    const childErrors = [];
    const body = rawBody.map((child, idx) => {
        if (!child || typeof child !== 'object') return null;
        const fixed = { ...child };
        if (!fixed.id || typeof fixed.id !== 'string') fixed.id = newId('lb');
        if (!fixed.type || typeof fixed.type !== 'string') fixed.type = 'ai_step';
        if (fixed.inputs) {
            const v = validateAndFixBindings(fixed.inputs, draft);
            if (v.error) childErrors.push(`body[${idx}] (${fixed.id}): ${v.error}`);
            fixed.inputs = v.inputs;
        }
        return fixed;
    }).filter(Boolean);
    if (childErrors.length) return { error: childErrors.join(' ') };

    const step = {
        id: newId('loop'),
        type: 'loop',
        overRef: args.overRef,
        itemVar: args.itemVar,
        body,
        maxIterations: args.maxIterations || 100,
        label: args.label || `Loop over ${args.overRef}`,
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName });
    return { added: step };
}

function applyAddCode(draft, args) {
    const { inputs, error } = validateAndFixBindings(args.inputs || {}, draft);
    if (error) return { error };
    const { forEach, error: feErr } = sanitizeForEach(args.forEach, draft);
    if (feErr) return { error: feErr };
    const step = {
        id: newId('code'),
        type: 'code',
        language: 'javascript',
        code: args.code,
        codeHash: crypto.createHash('sha256').update(args.code || '').digest('hex'),
        inputs,
        outputSchema: args.outputSchema || null,
        allowedTools: Array.isArray(args.allowedTools) ? args.allowedTools : [],
        limits: { cpuMs: 1000, memoryMb: 64, wallMs: 5000 },
        label: args.label || 'Custom code',
        ...(forEach ? { forEach } : {}),
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName });
    return { added: step };
}

function applyAddNotification(draft, args) {
    const { forEach, error: feErr } = sanitizeForEach(args.forEach, draft);
    if (feErr) return { error: feErr };
    const step = {
        id: newId('notif'),
        type: 'notification',
        title: args.title,
        body: args.body || '',
        channels: Array.isArray(args.channels) ? args.channels : ['notification'],
        label: args.label || 'Notify',
        ...(forEach ? { forEach } : {}),
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName });
    return { added: step };
}

// ── n8n-style utility step appliers ─────────────────────

function applyAddSet(draft, args) {
    const { inputs: fields, error } = validateAndFixBindings(args.fields || {}, draft);
    if (error) return { error };
    const { forEach, error: feErr } = sanitizeForEach(args.forEach, draft);
    if (feErr) return { error: feErr };
    const step = { id: newId('set'), type: 'set', fields, label: args.label || 'Edit fields', ...(forEach ? { forEach } : {}) };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName });
    return { added: step };
}

// ── Inline-flowlet helpers ──────────────────────────────

const LAYER_KEY_RE = /^[a-z][a-z0-9_]*$/;

/** slug a title into a valid flowlet key; uniquify against existing keys. */
function generateLayerKey(title, layers) {
    let slug = String(title || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40)
        .replace(/^_+|_+$/g, '');
    if (!slug) slug = 'layer';
    else if (/^[0-9]/.test(slug)) slug = `layer_${slug}`;
    let key = slug;
    let n = 2;
    while (layers && Object.prototype.hasOwnProperty.call(layers, key)) key = `${slug}_${n++}`;
    return key;
}

function sanitizeLayerParams(params) {
    if (!Array.isArray(params)) return [];
    return params
        .filter(p => p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim())
        .map(p => ({
            name: p.name.trim(),
            type: typeof p.type === 'string' && p.type ? p.type : 'string',
            ...(p.required ? { required: true } : {}),
        }));
}

/**
 * Every flowlet key transitively reachable from `startKey` via call_layer
 * steps (including startKey itself). Used to reject recursive wiring:
 * adding a call to T from inside flowlet S is illegal when closure(T) ∋ S.
 */
function layerClosureKeys(layers, startKey) {
    const seen = new Set();
    const stack = [startKey];
    while (stack.length) {
        const k = stack.pop();
        if (seen.has(k)) continue;
        seen.add(k);
        const g = layers?.[k];
        if (!g) continue;
        for (const { step } of collectCallLayerSteps(g)) {
            if (typeof step.layerKey === 'string' && !seen.has(step.layerKey)) stack.push(step.layerKey);
        }
    }
    return seen;
}

/**
 * The empty skeleton for a new inline flowlet: a layer_input trigger wired
 * straight to a layer_output "Return". Extracted so the flowlet sub-agent
 * (flowletAgent.js) seeds isolated drafts with the EXACT same shape this
 * tool produces — no drift between the two creation paths.
 */
function makeLayerSkeleton(title, params) {
    return {
        title: (typeof title === 'string' && title.trim()) ? title.trim() : 'New layer',
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: sanitizeLayerParams(params) },
        steps: [{ id: 'out', type: 'layer_output', fields: {}, label: 'Return' }],
        edges: [{ from: 'trg', to: 'out' }],
    };
}

function applyCreateLayer(draft, args) {
    const title = (typeof args.title === 'string' && args.title.trim()) ? args.title.trim() : 'New layer';
    if (!draft.layers || typeof draft.layers !== 'object' || Array.isArray(draft.layers)) draft.layers = {};
    const layerKey = generateLayerKey(title, draft.layers);
    draft.layers[layerKey] = makeLayerSkeleton(title, args.params);
    // Inline flowlets are the schemaVersion 2 marker.
    draft.schemaVersion = 2;
    return { layerKey, layer: draft.layers[layerKey] };
}

function applySetLayerContract(draft, args) {
    const layerKey = typeof args.layerKey === 'string' ? args.layerKey : null;
    const layer = layerKey ? draft.layers?.[layerKey] : null;
    if (!layer) {
        return { error: `Unknown layerKey "${layerKey || ''}". Existing flowlets: ${Object.keys(draft.layers || {}).join(', ') || '(none — create one with builder_create_layer)'}.` };
    }
    if (args.params !== undefined) {
        if (!Array.isArray(args.params)) return { error: 'params must be an array of { name, type, required? }.' };
        layer.trigger = layer.trigger || { id: 'trg', type: 'trigger', kind: 'layer_input' };
        layer.trigger.params = sanitizeLayerParams(args.params);
    }
    if (args.outputFields !== undefined) {
        if (!Array.isArray(args.outputFields) || args.outputFields.some(f => typeof f !== 'string' || !f.trim())) {
            return { error: 'outputFields must be an array of non-empty field-name strings.' };
        }
        layer.steps = Array.isArray(layer.steps) ? layer.steps : [];
        layer.edges = Array.isArray(layer.edges) ? layer.edges : [];
        let outStep = layer.steps.find(s => s && s.type === 'layer_output');
        if (!outStep) {
            outStep = { id: 'out', type: 'layer_output', fields: {}, label: 'Return' };
            const prevLast = lastStepId(layer);
            layer.steps.push(outStep);
            layer.edges.push({ from: prevLast, to: outStep.id });
        }
        const old = (outStep.fields && typeof outStep.fields === 'object' && !Array.isArray(outStep.fields)) ? outStep.fields : {};
        outStep.fields = {};
        for (const f of args.outputFields) {
            const name = f.trim();
            // Keep an existing binding for retained keys; new keys start as
            // empty literals the user (or AI, with scope) binds afterwards.
            outStep.fields[name] = old[name] || { kind: 'literal', value: '' };
        }
    }
    // Bind the flowlet's return values directly (declare + bind in ONE call):
    // `outputs` maps fieldName → binding ({kind:'ref',path:'steps.<id>.output.<f>'}).
    // This is THE way a flowlet returns data — never via a separate `set` step.
    if (args.outputs !== undefined) {
        if (!args.outputs || typeof args.outputs !== 'object' || Array.isArray(args.outputs)) {
            return { error: 'outputs must be a map of fieldName → binding, e.g. { invoices: { kind:"ref", path:"steps.agg1.output.values" } }.' };
        }
        layer.steps = Array.isArray(layer.steps) ? layer.steps : [];
        layer.edges = Array.isArray(layer.edges) ? layer.edges : [];
        let outStep = layer.steps.find(s => s && s.type === 'layer_output');
        if (!outStep) {
            outStep = { id: 'out', type: 'layer_output', fields: {}, label: 'Return' };
            const prevLast = lastStepId(layer);
            layer.steps.push(outStep);
            layer.edges.push({ from: prevLast, to: outStep.id });
        }
        const { inputs: bound, error } = validateAndFixBindings(args.outputs, layer);
        if (error) return { error };
        outStep.fields = {
            ...(outStep.fields && typeof outStep.fields === 'object' && !Array.isArray(outStep.fields) ? outStep.fields : {}),
            ...bound,
        };
    }
    const outStep = (layer.steps || []).find(s => s && s.type === 'layer_output');
    return {
        layerKey,
        params: layer.trigger?.params || [],
        outputFields: Object.keys(outStep?.fields || {}),
    };
}

/**
 * Append a call_layer step. `graph` is where the step lands (the root, or
 * the flowlet selected via scope); `draft` is always the root document
 * (flowlets live there); `scope` is the calling flowlet key (null at root) —
 * needed for the recursion check.
 */
function applyAddCallLayer(draft, args, { graph = draft, scope = null } = {}) {
    if (!args.layerKey || typeof args.layerKey !== 'string') {
        if (args.layerId) return { error: 'call_layer now takes a layerKey (inline flowlets) — layerId is no longer supported. Create the flowlet with builder_create_layer and pass its layerKey.' };
        return { error: 'call_layer requires a layerKey.' };
    }
    const layers = draft.layers || {};
    const target = layers[args.layerKey];
    if (!target) {
        return { error: `Unknown layerKey "${args.layerKey}". Existing flowlets: ${Object.keys(layers).join(', ') || '(none — create one with builder_create_layer)'}.` };
    }
    // Recursion guard: from inside flowlet `scope`, the target's transitive
    // call closure must not reach back to `scope` (and a flowlet can never
    // call itself). Root-scope calls can't recurse by construction.
    if (scope && layerClosureKeys(layers, args.layerKey).has(scope)) {
        return { error: `Recursive flowlet call rejected: flowlet "${args.layerKey}" (transitively) calls "${scope}", which is the flowlet you are adding this step to.` };
    }
    const { inputs, error } = validateAndFixBindings(args.inputs || {}, graph);
    if (error) return { error };
    const step = {
        id: newId('cl'),
        type: 'call_layer',
        layerKey: args.layerKey,
        inputs,
        label: args.label || target.title || 'Call layer',
    };
    appendAfter(graph, args.afterStepId, step, { branch: args.branch, caseName: args.caseName });
    return { added: step };
}

function applyAddDateTime(draft, args) {
    const step = {
        id: newId('dt'),
        type: 'datetime',
        op: args.op,
        input: typeof args.input === 'string' ? args.input : undefined,
        input2: typeof args.input2 === 'string' ? args.input2 : undefined,
        amount: typeof args.amount === 'number' ? args.amount : undefined,
        format: typeof args.format === 'string' ? args.format : undefined,
        part: typeof args.part === 'string' ? args.part : undefined,
        unit: typeof args.unit === 'string' ? args.unit : undefined,
        label: args.label || 'Date & Time',
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName });
    return { added: step };
}

function applyAddWait(draft, args) {
    const step = { id: newId('wait'), type: 'wait', seconds: Math.max(1, Math.min(86400, Number(args.seconds) || 1)), label: args.label || 'Wait' };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName });
    return { added: step };
}

function applyAddStopError(draft, args) {
    const step = { id: newId('stop'), type: 'stop_error', message: args.message, label: args.label || 'Stop and error' };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName });
    return { added: step };
}

function applyAddSwitch(draft, args) {
    const step = {
        id: newId('sw'),
        type: 'switch',
        expr: args.expr,
        cases: Array.isArray(args.cases) ? args.cases.map(c => ({ name: c.name, value: c.value })) : [],
        defaultBranch: typeof args.defaultBranch === 'string' ? args.defaultBranch : null,
        label: args.label || 'Switch',
    };
    const lastId = layerAwareAnchor(draft, args.afterStepId, step.id);
    draft.steps.push(step);
    // Route the incoming edge through branchEdgeFor so chaining a switch
    // directly after a condition/switch still labels the branch.
    draft.edges.push(branchEdgeFor(draft, lastId, step.id, { branch: args.branch, caseName: args.caseName }));
    // Wire any provided case targets in one shot.
    const next = args.nextStepIds || {};
    for (const caseName of Object.keys(next)) {
        const target = next[caseName];
        if (typeof target !== 'string') continue;
        const label = caseName === 'default' ? 'case:default' : `case:${caseName}`;
        draft.edges.push({ from: step.id, to: target, label, caseName });
    }
    return { added: step };
}

function applyAddFilter(draft, args) {
    const step = { id: newId('filt'), type: 'filter', arrayRef: args.arrayRef, expr: args.expr, label: args.label || 'Filter' };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName });
    return { added: step };
}

function applyAddLimit(draft, args) {
    const step = {
        id: newId('lim'),
        type: 'limit',
        arrayRef: args.arrayRef,
        count: Math.max(0, Math.floor(Number(args.count) || 0)),
        mode: args.mode === 'last' ? 'last' : 'first',
        label: args.label || 'Limit',
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName });
    return { added: step };
}

function applyAddDedupe(draft, args) {
    const step = { id: newId('ded'), type: 'dedupe', arrayRef: args.arrayRef, keyField: typeof args.keyField === 'string' ? args.keyField : undefined, label: args.label || 'Remove duplicates' };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName });
    return { added: step };
}

function applyAddAggregate(draft, args) {
    const step = { id: newId('agg'), type: 'aggregate', arrayRef: args.arrayRef, field: args.field, label: args.label || 'Aggregate' };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName });
    return { added: step };
}

function applyAddSummarize(draft, args) {
    const step = { id: newId('sum'), type: 'summarize', arrayRef: args.arrayRef, field: args.field, op: args.op, label: args.label || 'Summarize' };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName });
    return { added: step };
}

// Unified entry point for the five legacy array-op tools. Translates the
// flatter `builder_add_array_op` schema (op + a handful of optional fields)
// into the per-op apply* call. Lets the LLM use a single tool name across
// the array-handling cases — drops the tool-surface by 4 entries which
// matters on weaker models that get overwhelmed by big tool menus.
function applyAddArrayOp(draft, args) {
    const op = args && typeof args.op === 'string' ? args.op : null;
    if (!op) return { error: 'op is required (filter|limit|dedupe|aggregate|summarize)' };
    const common = { afterStepId: args.afterStepId, arrayRef: args.arrayRef, label: args.label, branch: args.branch, caseName: args.caseName };
    switch (op) {
        case 'filter':
            if (typeof args.expr !== 'string') return { error: 'filter op requires expr (restricted JS, references item.<field>)' };
            return applyAddFilter(draft, { ...common, expr: args.expr });
        case 'limit':
            if (args.count === undefined || args.count === null) return { error: 'limit op requires count (integer)' };
            return applyAddLimit(draft, { ...common, count: args.count, mode: args.mode });
        case 'dedupe':
            return applyAddDedupe(draft, { ...common, keyField: args.keyField });
        case 'aggregate':
            if (typeof args.field !== 'string') return { error: 'aggregate op requires field (the per-item field to pull)' };
            return applyAddAggregate(draft, { ...common, field: args.field });
        case 'summarize':
            if (typeof args.field !== 'string') return { error: 'summarize op requires field (numeric per-item field)' };
            if (!args.fn) return { error: 'summarize op requires fn (sum|count|avg|min|max)' };
            return applyAddSummarize(draft, { ...common, field: args.field, op: args.fn });
        default:
            return { error: `Unknown array op "${op}". Use one of: filter, limit, dedupe, aggregate, summarize.` };
    }
}

/**
 * §WS4 — wire an on_error edge between two EXISTING steps of `graph` (the
 * root, or a flowlet via scope). The source-type gate mirrors validate.js's
 * edge.error_label_invalid set so the LLM gets immediate feedback instead
 * of a validation bounce on the next persist.
 */
const ERROR_BRANCH_FORBIDDEN_SOURCES = new Set(['condition', 'switch', 'approval', 'stop_error']);

function applyWireErrorBranch(graph, args) {
    const from = typeof args.fromStepId === 'string' ? args.fromStepId : null;
    const to = typeof args.toStepId === 'string' ? args.toStepId : null;
    if (!from || !to) return { error: 'fromStepId and toStepId are both required.' };
    if (from === to) return { error: 'fromStepId and toStepId must be different steps.' };
    const stepIds = (graph.steps || []).map(s => s.id);
    if (from === graph.trigger?.id) {
        return { error: 'Triggers cannot fail — an error branch must start from a step, not the trigger.' };
    }
    const fromStep = (graph.steps || []).find(s => s.id === from);
    if (!fromStep) return { error: `Unknown fromStepId "${from}". Existing step ids: ${stepIds.join(', ') || '(none)'}.` };
    if (!stepIds.includes(to) && to !== graph.trigger?.id) {
        return { error: `Unknown toStepId "${to}". Existing step ids: ${stepIds.join(', ') || '(none)'}.` };
    }
    if (to === graph.trigger?.id) return { error: 'toStepId cannot be the trigger.' };
    if (ERROR_BRANCH_FORBIDDEN_SOURCES.has(fromStep.type)) {
        return { error: `A "${fromStep.type}" step cannot have an error branch — only failure-capable steps can (integration_action, ai_step, code, call_layer, loop, parallel, notification, wait).` };
    }
    const existing = (graph.edges || []).find(e => e.from === from && e.to === to && e.label === 'on_error');
    if (existing) return { wired: existing, note: 'edge already existed' };
    const edge = { from, to, label: 'on_error' };
    graph.edges.push(edge);
    return { wired: edge };
}

// Branching step types — they route via labelled outgoing edges
// (then/else, case:*). Used by the in-place edit/delete reconcilers.
const BRANCHING_TYPES = new Set(['condition', 'switch']);

/** Plain-text id list for "step not found" errors (mirrors applyWireErrorBranch). */
function listStepIds(graph) {
    return (graph.steps || []).map(s => s.id).join(', ') || '(none)';
}

/**
 * Locate a step by id within a graph (the root or a flowlet — `scope` is
 * already resolved to `graph` by the dispatcher). Also finds steps nested in a
 * `loop.body[]`. Branch members (then/else/case targets) live in `graph.steps`
 * wired by edge labels, so the top-level scan already covers them.
 *
 * Returns { step, container, index, kind, graph[, parentLoop] } or null.
 *   kind 'graph' → container is graph.steps; 'loop' → container is loop.body.
 */
function findStepAnywhere(graph, stepId) {
    const steps = Array.isArray(graph.steps) ? graph.steps : [];
    const top = steps.findIndex(s => s && s.id === stepId);
    if (top >= 0) return { step: steps[top], container: steps, index: top, kind: 'graph', graph };
    for (const s of steps) {
        if (s && s.type === 'loop' && Array.isArray(s.body)) {
            const i = s.body.findIndex(b => b && b.id === stepId);
            if (i >= 0) return { step: s.body[i], container: s.body, index: i, kind: 'loop', parentLoop: s, graph };
        }
    }
    return null;
}

// Per-type allow-list of fields a builder_update_step patch may change. `inputs`
// / `fields` / `forEach` get special merge+revalidate handling; everything else
// is copied through normalizePatchField (which mirrors the apply* clamps).
const PATCHABLE_FIELDS = {
    integration_action: ['tool', 'inputs', 'label', 'forEach'],
    ai_step: ['prompt', 'systemPrompt', 'inputs', 'outputSchema', 'modelTier', 'allowTools', 'tools', 'label', 'forEach'],
    condition: ['expr', 'label'],
    switch: ['expr', 'cases', 'defaultBranch', 'label'],
    loop: ['overRef', 'itemVar', 'maxIterations', 'label'],   // body steps are edited by their own id
    code: ['code', 'inputs', 'outputSchema', 'allowedTools', 'label', 'forEach'],
    notification: ['title', 'body', 'channels', 'label', 'forEach'],
    set: ['fields', 'label', 'forEach'],
    datetime: ['op', 'input', 'input2', 'amount', 'format', 'part', 'unit', 'label'],
    wait: ['seconds', 'label'],
    stop_error: ['message', 'label'],
    filter: ['arrayRef', 'expr', 'label'],
    limit: ['arrayRef', 'count', 'mode', 'label'],
    dedupe: ['arrayRef', 'keyField', 'label'],
    aggregate: ['arrayRef', 'field', 'label'],
    summarize: ['arrayRef', 'field', 'op', 'label'],
    call_layer: ['inputs', 'label'],   // layerKey change = builder_replace_step (recursion guard re-runs)
};

/**
 * Normalize a scalar/structured patch field to the exact shape the matching
 * apply* builder would produce, so a patched step is byte-identical to a
 * freshly-added one. Returns `undefined` to mean "clear this optional field"
 * (the caller keeps an existing label instead of clearing it).
 */
function normalizePatchField(type, key, value) {
    if (key === 'label') return (typeof value === 'string' && value.trim()) ? value : undefined;
    if (type === 'ai_step') {
        if (key === 'systemPrompt') return (typeof value === 'string' && value.trim()) ? value.trim() : null;
        if (key === 'modelTier') return value || 'auto';
        if (key === 'allowTools') return !!value;
        if (key === 'tools') return Array.isArray(value) ? value.filter(t => typeof t === 'string') : null;
        if (key === 'outputSchema') return value || null;
    }
    if (type === 'code') {
        if (key === 'outputSchema') return value || null;
        if (key === 'allowedTools') return Array.isArray(value) ? value : [];
    }
    if (type === 'notification' && key === 'channels') return Array.isArray(value) ? value : ['notification'];
    if (type === 'switch') {
        if (key === 'cases') return Array.isArray(value) ? value.map(c => ({ name: c.name, value: c.value })) : [];
        if (key === 'defaultBranch') return typeof value === 'string' ? value : null;
    }
    if (type === 'loop' && key === 'maxIterations') return value || 100;
    if (type === 'wait' && key === 'seconds') return Math.max(1, Math.min(86400, Number(value) || 1));
    if (type === 'limit') {
        if (key === 'count') return Math.max(0, Math.floor(Number(value) || 0));
        if (key === 'mode') return value === 'last' ? 'last' : 'first';
    }
    if (type === 'dedupe' && key === 'keyField') return typeof value === 'string' ? value : undefined;
    if (type === 'datetime') {
        if (['input', 'input2', 'format', 'part', 'unit'].includes(key)) return typeof value === 'string' ? value : undefined;
        if (key === 'amount') return typeof value === 'number' ? value : undefined;
    }
    return value;
}

/**
 * §B3 inspect-before-bind gate. When the route has attached the per-turn
 * `_inputSchemasByTool` map and the agent hasn't inspected `tool` this session,
 * block adding a non-trivial integration_action (≥1 required input, or >1 total
 * input) unless every required param is already bound. The reject is a
 * self-correcting tool error — the loop then runs inspect → add automatically.
 * No-op when no catalog is attached (tests / older callers) or the tool has no
 * declared inputSchema.
 */
function inspectGateError(tool, rawInputs, draftWrap) {
    if (!tool || typeof tool !== 'string' || !draftWrap) return null;
    const schemas = draftWrap._inputSchemasByTool;
    if (!schemas) return null;
    const schema = schemas[tool];
    if (!schema || !schema.properties) return null;        // unknown / declarationless tool → exempt
    const props = Object.keys(schema.properties);
    const required = Array.isArray(schema.required) ? schema.required : [];
    const nonTrivial = required.length >= 1 || props.length > 1;
    if (!nonTrivial) return null;                          // trivial tool → stays one-shot
    const inspected = draftWrap._inspectedTools instanceof Set ? draftWrap._inspectedTools : null;
    if (inspected && inspected.has(tool)) return null;     // already inspected this session
    const bound = (rawInputs && typeof rawInputs === 'object') ? Object.keys(rawInputs) : [];
    if (required.length && required.every(r => bound.includes(r))) return null;   // escape hatch
    return {
        error: `Inspect "${tool}" before adding it: call builder_inspect_tool({tool:"${tool}"}) to get its exact input params, then add the action with the correct param names.${required.length ? ` Required params: ${required.join(', ')}.` : ''}`,
        _needsInspect: tool,
    };
}

/**
 * builder_update_step — patch an existing step in place (same type, same id,
 * wiring preserved). Reuses validateAndFixBindings / sanitizeForEach so the
 * patched step is identical to a freshly-added one.
 */
function applyUpdateStep(graph, args, draftWrap) {
    const stepId = typeof args.stepId === 'string' ? args.stepId : null;
    if (!stepId) return { error: 'stepId is required.' };
    const patch = (args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) ? args.patch : null;
    if (!patch) return { error: 'patch must be an object of fields to change.' };
    if ('type' in patch) return { error: 'Cannot change a step\'s type via builder_update_step — use builder_replace_step.' };
    if ('id' in patch) return { error: 'Cannot change a step id.' };

    const found = findStepAnywhere(graph, stepId);
    if (!found) return { error: `Unknown stepId "${stepId}". Existing step ids: ${listStepIds(graph)}.` };
    const step = found.step;
    const allowed = PATCHABLE_FIELDS[step.type];
    if (!allowed) return { error: `Step type "${step.type}" cannot be patched.` };
    const bad = Object.keys(patch).filter(k => !allowed.includes(k));
    if (bad.length) return { error: `Field(s) ${bad.join(', ')} not patchable on a ${step.type} step. Allowed: ${allowed.join(', ')}.` };

    // §B3 gate: re-pointing an integration_action at a new tool re-arms inspect.
    if (step.type === 'integration_action' && 'tool' in patch) {
        const mergedInputs = ('inputs' in patch) ? { ...(step.inputs || {}), ...(patch.inputs || {}) } : (step.inputs || {});
        const gate = inspectGateError(patch.tool, mergedInputs, draftWrap);
        if (gate) return gate;
    }

    const next = { ...step };

    // inputs / fields: merge-by-key (null deletes) unless inputsMode:'replace'.
    const bindKey = step.type === 'set' ? 'fields' : 'inputs';
    if (bindKey in patch) {
        const mode = args.inputsMode === 'replace' ? 'replace' : 'merge';
        let raw = (patch[bindKey] && typeof patch[bindKey] === 'object') ? patch[bindKey] : {};
        if (mode === 'merge') {
            const merged = { ...(step[bindKey] || {}) };
            for (const [k, v] of Object.entries(raw)) { if (v === null) delete merged[k]; else merged[k] = v; }
            raw = merged;
        }
        const { inputs, error } = validateAndFixBindings(raw, graph);
        if (error) return { error };
        next[bindKey] = inputs;
    }

    // forEach: re-validate; null clears it.
    if ('forEach' in patch) {
        if (patch.forEach === null) { delete next.forEach; }
        else {
            const { forEach, error } = sanitizeForEach(patch.forEach, graph);
            if (error) return { error };
            if (forEach) next.forEach = forEach; else delete next.forEach;
        }
    }

    // Scalar / structured fields.
    for (const k of allowed) {
        if (k === 'inputs' || k === 'fields' || k === 'forEach') continue;
        if (!(k in patch)) continue;
        const norm = normalizePatchField(step.type, k, patch[k]);
        if (norm === undefined) { if (k !== 'label') delete next[k]; }
        else next[k] = norm;
    }

    // Derived fields the apply* builders compute.
    if (step.type === 'code' && 'code' in patch) {
        next.codeHash = crypto.createHash('sha256').update(next.code || '').digest('hex');
    }
    if (step.type === 'integration_action' && 'tool' in patch) {
        next.sideEffect = isSideEffect(next.tool);
        if (!('label' in patch) && (step.label === step.tool)) next.label = next.tool; // keep auto-label tracking the tool
    }

    found.container[found.index] = next;
    return { updated: next };
}

/** builder_update_steps — batch, all-or-nothing (snapshot + rollback). */
function applyUpdateSteps(graph, args, draftWrap) {
    const updates = Array.isArray(args.updates) ? args.updates : null;
    if (!updates || !updates.length) return { error: 'updates must be a non-empty array of { stepId, patch }.' };
    const snapSteps = structuredClone(graph.steps);
    const snapEdges = structuredClone(graph.edges);
    const applied = [];
    for (const u of updates) {
        const r = applyUpdateStep(graph, u || {}, draftWrap);
        if (r.error) {
            graph.steps = snapSteps;
            graph.edges = snapEdges;
            return { error: `update for "${u && u.stepId}": ${r.error}`, _rolledBack: true };
        }
        applied.push(r.updated.id);
    }
    return { updated: applied };
}

// Map a step type to the apply* builder that constructs it — reused by
// builder_replace_step so a type swap inherits every per-type validation/clamp.
const ADD_FOR_TYPE = {
    integration_action: applyAddAction, ai_step: applyAddAi, condition: applyAddCondition,
    switch: applyAddSwitch, code: applyAddCode, notification: applyAddNotification, set: applyAddSet,
    datetime: applyAddDateTime, wait: applyAddWait, stop_error: applyAddStopError,
    filter: applyAddFilter, limit: applyAddLimit, dedupe: applyAddDedupe,
    aggregate: applyAddAggregate, summarize: applyAddSummarize, call_layer: applyAddCallLayer, loop: applyAddLoop,
};

/**
 * After a type swap (same id), reconcile the OUTGOING edges so the runner never
 * dead-ends. Strips now-invalid branch labels, drops on_error edges from step
 * types that can't carry them, and returns a human note when the agent must
 * finish wiring (validation surfaces dead_branch/partial_branch as the signal).
 */
function reconcileOutgoingEdges(graph, oldStep, newStep) {
    const id = newStep.id;
    const wasBranching = BRANCHING_TYPES.has(oldStep.type);
    const nowBranching = BRANCHING_TYPES.has(newStep.type);
    const out = (graph.edges || []).filter(e => e.from === id);
    const stripped = [];
    const dropIdx = new Set();
    for (const e of out) {
        const lbl = e.label;
        if (lbl === 'on_error') {
            if (ERROR_BRANCH_FORBIDDEN_SOURCES.has(newStep.type)) dropIdx.add(e);
            continue;
        }
        const isBranchLabel = lbl === 'then' || lbl === 'else' || (typeof lbl === 'string' && lbl.startsWith('case:'));
        if (!isBranchLabel) continue;
        // Labels are invalid when the step is no longer branching, or when the
        // branch class changed (condition then/else ↔ switch case:*).
        if (!nowBranching || (wasBranching && oldStep.type !== newStep.type)) {
            delete e.label; delete e.caseName; stripped.push(`${lbl}→${e.to}`);
        }
    }
    if (dropIdx.size) graph.edges = graph.edges.filter(e => !dropIdx.has(e));
    const notes = [];
    if (stripped.length) notes.push(`Stripped now-invalid branch labels on outgoing edges: ${stripped.join(', ')}.`);
    if (dropIdx.size) notes.push(`Dropped on_error edge(s) — a ${newStep.type} step cannot carry one.`);
    if (!wasBranching && nowBranching) {
        notes.push(`This step is now branching (${newStep.type}) but its outgoing edge(s) are unlabelled — set branch targets so they don't dead-end (re-wire with builder_add_* branch/caseName, or builder_remove_step + re-add).`);
    }
    return notes.length ? notes.join(' ') : null;
}

/**
 * builder_replace_step — change a step's TYPE in place, keeping its id and
 * surrounding wiring. Builds the new step on a throwaway graph (so every apply*
 * validation runs without touching real edges), grafts the old id, then
 * reconciles outgoing branch edges.
 */
function applyReplaceStep(graph, args, { draft, scope = null } = {}, draftWrap) {
    const stepId = typeof args.stepId === 'string' ? args.stepId : null;
    if (!stepId) return { error: 'stepId is required.' };
    const newType = typeof args.newType === 'string' ? args.newType : null;
    const builder = newType && ADD_FOR_TYPE[newType];
    if (!builder) return { error: `Cannot replace into type "${newType}". Allowed: ${Object.keys(ADD_FOR_TYPE).join(', ')}.` };
    const spec = (args.spec && typeof args.spec === 'object' && !Array.isArray(args.spec)) ? args.spec : null;
    if (!spec) return { error: 'spec must be an object with the new step\'s fields (same shape as builder_add_<newType>).' };

    const found = findStepAnywhere(graph, stepId);
    if (!found) return { error: `Unknown stepId "${stepId}". Existing step ids: ${listStepIds(graph)}.` };
    if (found.kind === 'loop') {
        return { error: 'Cannot replace a loop-body step\'s type in place — patch it with builder_update_step, or remove + add it inside the loop body.' };
    }
    const oldStep = found.step;

    if (newType === 'integration_action') {
        const gate = inspectGateError(spec.tool, spec.inputs, draftWrap);
        if (gate) return gate;
    }

    // Throwaway graph: shares the real trigger (for ref validation) but its own
    // empty steps/edges arrays so appendAfter wiring is discarded.
    const scratch = { trigger: graph.trigger, steps: [], edges: [], layers: draft && draft.layers };
    const buildArgs = { ...spec };
    delete buildArgs.afterStepId; delete buildArgs.branch; delete buildArgs.caseName; delete buildArgs.scope;
    const res = newType === 'call_layer'
        ? builder(draft, buildArgs, { graph: scratch, scope })
        : builder(scratch, buildArgs);
    if (res.error) return res;
    const built = res.added;
    built.id = oldStep.id;                       // keep id → every edge still targets it

    found.container[found.index] = built;
    const rewired = reconcileOutgoingEdges(graph, oldStep, built);
    return { replaced: built, ...(rewired ? { rewired } : {}) };
}

function applyRemoveStep(graph, args) {
    const id = args.stepId;
    const found = findStepAnywhere(graph, id);
    if (!found) return { error: `Unknown stepId "${id}". Existing step ids: ${listStepIds(graph)}.` };

    // Loop-body steps have no top-level edges — just splice them out.
    if (found.kind === 'loop') {
        found.container.splice(found.index, 1);
        return { removed: id };
    }

    const reconnect = args.reconnect !== false;   // default true
    const step = found.step;
    const incoming = (graph.edges || []).filter(e => e.to === id);
    const outgoing = (graph.edges || []).filter(e => e.from === id);
    const bridges = [];

    if (reconnect && incoming.length && outgoing.length) {
        const branching = BRANCHING_TYPES.has(step.type);
        // Successor targets to bridge to: prefer the success path (skip on_error).
        let targets;
        if (!branching) {
            const succ = outgoing.filter(e => e.label !== 'on_error').map(e => e.to);
            targets = succ.length ? succ : outgoing.map(e => e.to);
        } else {
            // Branching anchor: pick a single primary successor; the rest are dropped.
            const primary = outgoing.find(e => e.label === 'then')
                || outgoing.find(e => e.label === 'case:default')
                || outgoing.find(e => e.label !== 'on_error')
                || outgoing[0];
            targets = primary ? [primary.to] : [];
        }
        for (const inc of incoming) {
            for (const to of targets) {
                if (inc.from === to) continue;
                const e = { from: inc.from, to };
                if (inc.label) { e.label = inc.label; if (inc.caseName) e.caseName = inc.caseName; }
                const dup = (graph.edges || []).some(x => x.from === e.from && x.to === e.to && x.label === e.label);
                if (!dup) { graph.edges.push(e); bridges.push(`${e.from}→${e.to}`); }
            }
        }
    }

    found.container.splice(found.index, 1);
    graph.edges = graph.edges.filter(e => e.from !== id && e.to !== id);

    const parts = [];
    if (bridges.length) parts.push(`reconnected ${bridges.join(', ')}`);
    if (reconnect && BRANCHING_TYPES.has(step.type) && outgoing.filter(e => e.label !== 'on_error').length > 1) {
        parts.push('removed a branching step — only its primary branch was reconnected; re-wire the other branch targets if still needed');
    }
    return { removed: id, ...(parts.length ? { note: parts.join('; ') } : {}) };
}

function applySetMetadata(draft, args) {
    if (typeof args.title === 'string') draft.title = args.title;
    if (typeof args.description === 'string') draft.description = args.description;
    return { title: draft.title, description: draft.description };
}

function applySummarise(draft) {
    const { summary, hasSideEffects } = summariseDefinition(draft);
    return { summary, hasSideEffects };
}

async function applyInspectTool(args, draftWrap) {
    const tool = args && typeof args.tool === 'string' ? args.tool : null;
    if (!tool) return { error: 'tool name required' };
    const shapeCache = require('./shapeCache');
    const { describeShape, getOutputSchema, iterableFieldsOf } = require('./outputSchemas');

    // §B3: record that the agent inspected this tool this session so the
    // add-action gate lets the subsequent builder_add_action through.
    if (draftWrap && draftWrap._inspectedTools instanceof Set) draftWrap._inspectedTools.add(tool);

    // §B2: INPUT params (names/types/required) from the per-turn catalog map the
    // route attaches — so the agent binds the exact param names without guessing.
    // The slim catalog only advertises an input COUNT; this is the on-demand detail.
    let inputs = null;
    let requiredInputs = [];
    const inSchema = (draftWrap && draftWrap._inputSchemasByTool) ? draftWrap._inputSchemasByTool[tool] : null;
    if (inSchema && inSchema.properties && typeof inSchema.properties === 'object') {
        const required = new Set(Array.isArray(inSchema.required) ? inSchema.required : []);
        inputs = {};
        for (const [name, spec] of Object.entries(inSchema.properties)) {
            inputs[name] = {
                type: (spec && spec.type) || 'any',
                required: required.has(name),
                ...(spec && spec.description ? { description: String(spec.description).split('\n')[0] } : {}),
                ...(spec && Array.isArray(spec.enum) ? { enum: spec.enum.slice(0, 20) } : {}),
            };
        }
        requiredInputs = [...required];
    }

    // Prefer runtime-cached output shape (the source of truth from real runs).
    let shapeHint = null;
    let source = 'curated';
    try {
        const cached = await shapeCache.getShape({ userId: draftWrap.userId, toolName: tool });
        if (cached) {
            shapeHint = shapeCache.renderShapeHint(cached);
            source = 'runtime';
        }
    } catch (_) {}
    if (!shapeHint) {
        shapeHint = describeShape(tool);
    }
    if (!shapeHint) {
        return {
            tool,
            inputs,
            requiredInputs,
            shape: null,
            source: 'unknown',
            note: 'No declared output schema and no runtime sample. Run the tool once via dry-run / live to learn its shape, or just bind defensively.',
        };
    }
    const schema = getOutputSchema(tool);
    // `iterableFields` names the array outputs a per-step `forEach` can run over
    // (overRef = steps.<id>.output.<field>) — so the model picks the right one
    // on demand instead of from a bloated always-on prompt.
    const iterableFields = iterableFieldsOf(tool);
    return {
        tool,
        inputs,
        requiredInputs,
        shape: shapeHint,
        source,
        sample: schema?.sample ?? null,
        ...(iterableFields.length ? { iterableFields } : {}),
    };
}

// ── Public API ──────────────────────────────────────────

/**
 * Apply a tool call, mutating the in-memory draft. Returns a small JSON
 * report describing what changed (becomes the `tool` message back to the
 * LLM and feeds the SSE update to the frontend).
 */
/**
 * Build a tiny summary of the current draft's step IDs so every mutation
 * result reminds the LLM of the exact ids it must use for downstream
 * `afterStepId` / refs / template paths. Without this the model
 * fabricated short ids like "step_1" that didn't exist in the draft —
 * the dry-run then ran with broken bindings and the AI had to spend
 * extra iterations un-tangling its own mistake.
 */
function summariseDraftSteps(draft) {
    const list = [];
    if (draft?.trigger?.id) list.push({ id: draft.trigger.id, type: 'trigger', kind: draft.trigger.kind });
    for (const s of (draft?.steps || [])) {
        list.push({
            id: s.id,
            type: s.type,
            tool: s.tool || undefined,
            layerKey: s.type === 'call_layer' ? (s.layerKey || undefined) : undefined,
            forEach: s.forEach?.overRef ? `over ${s.forEach.overRef} as loop.${s.forEach.itemVar || 'item'}` : undefined,
            label: s.label || undefined,
        });
    }
    // Per-flowlet sections so the model can target scoped mutations: each
    // entry reminds it of the flowlet key, its input params (bound inside as
    // trigger.output.<param>) and the live step ids within that scope.
    for (const [key, g] of Object.entries(draft?.layers || {})) {
        if (!g || typeof g !== 'object') continue;
        const steps = [{
            id: g.trigger?.id || 'trg',
            type: 'trigger',
            kind: 'layer_input',
            params: (Array.isArray(g.trigger?.params) ? g.trigger.params : []).map(p => p?.name).filter(Boolean),
        }];
        for (const s of (g.steps || [])) {
            steps.push({
                id: s.id,
                type: s.type,
                tool: s.tool || undefined,
                layerKey: s.type === 'call_layer' ? (s.layerKey || undefined) : undefined,
                forEach: s.forEach?.overRef ? `over ${s.forEach.overRef} as loop.${s.forEach.itemVar || 'item'}` : undefined,
                label: s.label || undefined,
            });
        }
        list.push({ layer: key, title: g.title || undefined, steps });
    }
    return list;
}

const MUTATING_TOOLS = new Set([
    'builder_propose_trigger', 'builder_add_action', 'builder_add_ai_step',
    'builder_add_condition', 'builder_add_loop', 'builder_add_code_step',
    'builder_add_notification', 'builder_remove_step', 'builder_set_metadata',
    // §A in-place editing (no destroy-to-update)
    'builder_update_step', 'builder_update_steps', 'builder_replace_step',
    // n8n-style utility nodes
    'builder_add_set', 'builder_add_datetime', 'builder_add_wait',
    'builder_add_stop_error', 'builder_add_switch', 'builder_add_call_layer',
    'builder_add_filter', 'builder_add_limit', 'builder_add_dedupe',
    'builder_add_aggregate', 'builder_add_summarize',
    'builder_add_array_op',
    // inline flowlets
    'builder_create_layer', 'builder_set_layer_contract',
    // §WS4 on-error branches
    'builder_wire_error_branch',
]);

// Step-graph mutators that accept scope:'<layerKey>' to operate inside
// definition.layers[<key>] instead of the root flow. Excludes the root-only
// tools (propose_trigger, set_metadata) and the flowlet-management tools
// (create_layer / set_layer_contract take layerKey explicitly).
const SCOPED_GRAPH_TOOLS = new Set(
    [...MUTATING_TOOLS].filter(n => ![
        'builder_propose_trigger', 'builder_set_metadata',
        'builder_create_layer', 'builder_set_layer_contract',
    ].includes(n)),
);

// Inject the shared `scope` parameter into every scoped tool's schema so
// the model discovers it without 18 hand-edited copies drifting apart.
for (const t of TOOL_SCHEMAS) {
    if (!SCOPED_GRAPH_TOOLS.has(t.function?.name)) continue;
    t.function.parameters = t.function.parameters || { type: 'object', properties: {} };
    t.function.parameters.properties = t.function.parameters.properties || {};
    t.function.parameters.properties.scope = {
        type: 'string',
        description: "Optional inline-flowlet key — apply this mutation inside definition.layers[<scope>] (that flowlet's own sub-flow) instead of the main flow. Omit for the main flow.",
    };
}

// Per-step iteration: a leaf step can run once per item of an upstream array
// via `forEach` — no wrapping `loop` container. Injected (single source of
// truth) only into the five step types the validator permits; validate.js's
// `foreach.type_unsupported` guards everything else.
const FOREACH_CAPABLE_TOOLS = new Set([
    'builder_add_action', 'builder_add_ai_step', 'builder_add_code_step',
    'builder_add_notification', 'builder_add_set',
]);
for (const t of TOOL_SCHEMAS) {
    if (!FOREACH_CAPABLE_TOOLS.has(t.function?.name)) continue;
    t.function.parameters = t.function.parameters || { type: 'object', properties: {} };
    t.function.parameters.properties = t.function.parameters.properties || {};
    t.function.parameters.properties.forEach = {
        type: 'object',
        description: 'Run this ONE step once per item of an upstream array (no wrapping loop needed). Reference the current item inside this step as `loop.<itemVar>`. Prefer this over builder_add_loop whenever only a single step repeats per item.',
        properties: {
            overRef: { type: 'string', description: 'Ref to the upstream array, e.g. "steps.<id>.output.results". Must start with trigger/steps/vars/secrets/loop.' },
            itemVar: { type: 'string', description: 'Name for the current item (default "item"); reference it as loop.<itemVar> inside this step.' },
            maxIterations: { type: 'number', description: 'Optional cap, 1..1000 (default 100).' },
        },
        required: ['overRef'],
    };
}

// §WS4: extend every `branch` enum with 'error' in one place (same
// no-drift rationale as the scope injection above). branch:'error' wires
// the new step onto afterStepId's on_error branch — it runs only when
// that step fails after exhausting its retries.
for (const t of TOOL_SCHEMAS) {
    const b = t.function?.parameters?.properties?.branch;
    if (!b || !Array.isArray(b.enum)) continue;
    if (!b.enum.includes('error')) b.enum.push('error');
    b.description = `${b.description || ''} Pass "error" to wire this step onto afterStepId's on_error branch instead (runs only when that step fails after retries; bind the failure via steps.<afterStepId>.error.message).`.trim();
}

async function applyToolCall(name, args, draftWrap) {
    const result = await _applyToolCallRaw(name, args, draftWrap);
    // For every mutation, append a `_draftSteps` reminder so the LLM has
    // the live id list in front of it on the next turn. Tools that read
    // (summarise/inspect/dry_run/finalize) don't need this — their own
    // result is already the relevant shape.
    if (MUTATING_TOOLS.has(name) && result && typeof result === 'object' && !result.error) {
        result._draftSteps = summariseDraftSteps(draftWrap.def);
    }
    // When a mutator rejected the call due to bad bindings, prefix the
    // error with a structured marker so the system prompt's "common
    // pitfalls" section catches the model's attention. Without this the
    // model sometimes ignores the error entirely and re-tries the same
    // call.
    if (result && typeof result === 'object' && result.error && !result._fixHint) {
        result._fixHint = 'Reject reason: invalid input binding. Fix the path/value and call the tool again. Refs MUST start with: trigger, steps, vars, secrets, loop.';
    }
    return result;
}

async function _applyToolCallRaw(name, args, draftWrap) {
    const draft = draftWrap.def;
    // Central scope resolution (inline flowlets): scoped tools may pass
    // scope:'<layerKey>' to operate on definition.layers[<key>]'s graph
    // instead of the root flow. Resolved ONCE here so every apply function
    // below just works on `graph` (mini-definitions share the root shape).
    const scope = (args && typeof args.scope === 'string' && args.scope) ? args.scope : null;
    let graph = draft;
    if (scope) {
        if (!SCOPED_GRAPH_TOOLS.has(name)) {
            return { error: `Tool ${name} does not accept a scope. Flowlet triggers/contracts are managed via builder_create_layer / builder_set_layer_contract.` };
        }
        graph = draft.layers?.[scope];
        if (!graph) {
            return { error: `Unknown flowlet scope "${scope}". Existing flowlets: ${Object.keys(draft.layers || {}).join(', ') || '(none — create one with builder_create_layer)'}.` };
        }
    }
    switch (name) {
        case 'builder_propose_trigger':    return applyTrigger(draft, args);
        case 'builder_add_action':         return applyAddAction(graph, args, draftWrap);
        case 'builder_add_ai_step':        return applyAddAi(graph, args);
        case 'builder_add_condition':      return applyAddCondition(graph, args);
        case 'builder_add_loop':           return applyAddLoop(graph, args);
        case 'builder_add_code_step':      return applyAddCode(graph, args);
        case 'builder_add_notification':   return applyAddNotification(graph, args);
        case 'builder_add_set':            return applyAddSet(graph, args);
        case 'builder_add_call_layer':     return applyAddCallLayer(draft, args, { graph, scope });
        case 'builder_create_layer':       return applyCreateLayer(draft, args);
        case 'builder_set_layer_contract': return applySetLayerContract(draft, args);
        case 'builder_add_datetime':       return applyAddDateTime(graph, args);
        case 'builder_add_wait':           return applyAddWait(graph, args);
        case 'builder_add_stop_error':     return applyAddStopError(graph, args);
        case 'builder_add_switch':         return applyAddSwitch(graph, args);
        case 'builder_add_filter':         return applyAddFilter(graph, args);
        case 'builder_add_limit':          return applyAddLimit(graph, args);
        case 'builder_add_dedupe':         return applyAddDedupe(graph, args);
        case 'builder_add_aggregate':      return applyAddAggregate(graph, args);
        case 'builder_add_summarize':      return applyAddSummarize(graph, args);
        case 'builder_add_array_op':       return applyAddArrayOp(graph, args);
        case 'builder_wire_error_branch':  return applyWireErrorBranch(graph, args);
        case 'builder_remove_step':        return applyRemoveStep(graph, args);
        case 'builder_update_step':        return applyUpdateStep(graph, args, draftWrap);
        case 'builder_update_steps':       return applyUpdateSteps(graph, args, draftWrap);
        case 'builder_replace_step':       return applyReplaceStep(graph, args, { draft, scope }, draftWrap);
        case 'builder_set_metadata':       return applySetMetadata(draftWrap, args);
        case 'builder_summarise':          return applySummarise(draft);
        case 'builder_inspect_tool':       return applyInspectTool(args, draftWrap);
        case 'builder_request_dry_run': {
            const automation = await persistDraft(draftWrap);
            const runner = require('../core/automationRunner');
            const run = await runner.executeAutomation(automation, { triggerKind: 'dry_run', triggerPayload: args.triggerPayload || null, mode: 'dry_run' });
            const steps = await automationStore.getRunSteps(run.id);
            // Annotate each step with a top-level field hint so the AI
            // immediately sees what keys are available for binding.
            const shapeCache = require('./shapeCache');
            const annotated = steps.map(s => {
                const out = s.output;
                const topKeys = (out && typeof out === 'object' && !Array.isArray(out)) ? Object.keys(out) : null;
                const shapeHint = topKeys ? shapeCache.renderShapeHint(shapeCache.describeValue(out)) : null;
                return {
                    ...s,
                    _hint: {
                        outputType: Array.isArray(out) ? 'array' : (out === null ? 'null' : typeof out),
                        topKeys,
                        shape: shapeHint,
                    },
                };
            });
            return { run, steps: annotated };
        }
        case 'builder_finalize': {
            const automation = await persistDraft(draftWrap, { finalize: true });
            return { automation };
        }
        default:
            return { error: `Unknown builder tool: ${name}` };
    }
}

/**
 * Persist the draft to the automations table. Creates a row on the first
 * call and updates thereafter. Setting `finalize:true` flips is_draft to
 * false (still inactive — user must Activate explicitly).
 */
async function persistDraft(draftWrap, { finalize = false } = {}) {
    const def = draftWrap.def;
    const validation = validateDefinition(def, { deliverableEvents: getDeliverableEvents() });
    const triggerType = def.trigger?.kind || 'manual';
    const scheduleCron = def.trigger?.schedule?.cron || null;
    const scheduleTz = def.trigger?.schedule?.tz || 'Europe/Amsterdam';

    if (!draftWrap.automationId) {
        // Create a draft row.
        const a = await automationStore.createAutomation({
            userId: draftWrap.userId,
            organizationId: draftWrap.orgId || null,
            title: draftWrap.title || 'Untitled automation',
            description: draftWrap.description || '',
            definition: def,
            triggerType,
            scheduleCron,
            scheduleTz,
            createdFromChatId: draftWrap.builderSessionId,
        });
        draftWrap.automationId = a.id;
        if (finalize) {
            return automationStore.updateAutomation(a.id, { isDraft: false }, draftWrap.userId);
        }
        return a;
    }
    // Update existing draft row.
    const updates = {
        title: draftWrap.title || undefined,
        description: draftWrap.description || undefined,
        definition: def,
        triggerType,
        scheduleCron,
        scheduleTz,
    };
    if (finalize) updates.isDraft = false;
    const u = await automationStore.updateAutomation(draftWrap.automationId, updates, draftWrap.userId);
    if (!validation.ok) {
        // Persist anyway (it's a draft) but expose the errors to the caller.
        u.validationErrors = validation.errors;
    }
    return u;
}

module.exports = {
    TOOL_SCHEMAS, MUTATING_TOOLS, SCOPED_GRAPH_TOOLS, applyToolCall, persistDraft, emptyDefinition,
    // Flowlet-creation primitives reused by the flowlet sub-agent (flowletAgent.js)
    // so its isolated drafts seed the EXACT same skeleton / keying.
    generateLayerKey, makeLayerSkeleton, sanitizeLayerParams,
    TRIGGER_FIELDS_BY_EVENT, TRIGGER_OUTPUT_SAMPLES, buildTriggerOutputsCatalog,
    _test_validateAndFixBindings: validateAndFixBindings,
    // §A in-place-edit internals (exported for tests)
    findStepAnywhere, PATCHABLE_FIELDS,
};
