/**
 * Validate an automation definition before save / run.
 *
 * Checks:
 *   - Required top-level shape (trigger, steps[], edges[]).
 *   - Each step has a unique id (per graph).
 *   - DAG is acyclic via Kahn's algorithm.
 *   - condition.expr parses under the restricted grammar.
 *   - integration_action.tool is a string (catalog lookup happens at run time).
 *   - Inline layers (`definition.layers`, root-only map of mini-definitions):
 *     map shape + key format, per-layer graph rules (layer_input trigger,
 *     exactly one layer_output, no approval, no nesting), call_layer
 *     references resolve, required layer params are bound, and the
 *     layer-reference graph is acyclic and within the depth cap.
 *
 * Reference paths (`{{steps.x.output.y}}`) are NOT validated as blocking
 * errors. The runtime resolves missing refs to `undefined` safely, and
 * forward refs / typos there shouldn't stop the user from saving or
 * running their automation. They are returned as warnings instead.
 */

const { parseExpr } = require('./expr');

const VALID_STEP_TYPES = new Set([
    'trigger', 'integration_action', 'ai_step', 'condition', 'loop', 'code', 'notification',
    // Phase 2 flow primitives
    'approval', 'parallel',
    // n8n-style utility nodes (Phase A: data + control flow, Phase B: collection ops)
    'set', 'datetime', 'wait', 'stop_error', 'switch',
    'filter', 'limit', 'dedupe', 'aggregate', 'summarize',
    // Layers (inline sub-flows): call a layer / return from one.
    'call_layer', 'layer_output',
    // Steps (reusable building blocks, kind='block'): call an external Step.
    'call_block',
]);

// §WS4 — edge-label rules. The runner routes labelled edges (nextEdgesFor):
// unlabelled/'on_success' fire on success, 'then'/'else' on conditions,
// 'case:<name>' on switches, 'on_error' when the step exhausts its retries
// and fails. Anything else never fires — warn so a typo ("onerror",
// "success") doesn't silently dead-end a branch.
const KNOWN_EDGE_LABELS = new Set(['then', 'else', 'on_success', 'on_error']);
// Step types that can meaningfully FAIL at run time — the only legal
// sources for an 'on_error' edge.
const ON_ERROR_SOURCE_TYPES = new Set([
    'integration_action', 'ai_step', 'code', 'call_layer', 'call_block', 'loop', 'parallel', 'notification', 'wait',
]);
// Sources where an error branch is structurally wrong: the trigger never
// dispatches, condition/switch route by their own branch labels (an
// 'on_error' edge there would shadow the branch routing), approval pauses
// rather than fails, and stop_error's entire JOB is to fail the run.
const ON_ERROR_FORBIDDEN_SOURCE_TYPES = new Set(['trigger', 'condition', 'switch', 'approval', 'stop_error']);

const DATETIME_OPS = new Set(['now', 'parse', 'format', 'addDays', 'addHours', 'addMinutes', 'diff', 'extract']);
const SUMMARIZE_OPS = new Set(['sum', 'count', 'avg', 'min', 'max']);
const LIMIT_MODES = new Set(['first', 'last']);
const DATETIME_PARTS = new Set(['year', 'month', 'day', 'hour', 'minute', 'second', 'dayOfWeek']);
const DATETIME_DIFF_UNITS = new Set(['days', 'hours', 'minutes', 'seconds']);

// Inline-layer keys: lowercase snake, must start with a letter. Shared
// contract with the builder tools and the frontend layer helpers.
const LAYER_KEY_RE = /^[a-z][a-z0-9_]*$/;

// §WS1.4 — hard ceilings on graph size, independent of the 20MB body limit.
// Without these, a single authenticated save can submit a pathological
// definition (hundreds of thousands of trivial nodes) that bloats the JSONB
// column/version history and burns CPU on the O(steps+edges) topo-sort + the
// per-step Levenshtein suggestion work on every validate/activate/run. The
// caps are far above any real automation, so they only ever trip on abuse.
const MAX_STEPS = 500;          // per graph (root or a single layer)
const MAX_EDGES = 2000;         // per graph
const MAX_TOTAL_NODES = 3000;   // root + all layers combined

// §WS5 — pure graph/string helpers extracted into validate/helpers.js so this
// file holds the validation RULES, not the plumbing. Behaviour is unchanged.
const {
    isObject,
    validatePosition,
    topoOrder,
    collectRefPaths,
    collectLiteralBraces,
    rootOf,
    pickClosestId,
    secondSegment,
} = require('./validate/helpers');
const { collectCallLayerSteps, validateCallLayerStep } = require('./validate/callLayer');
const { collectCallBlockSteps, validateCallBlockStep } = require('./validate/callBlock');
const { validateLayerGraph } = require('./validate/layerGraph');

/**
 * Walk a graph (root definition or a layer mini-definition) collecting every
 * call_layer step — including those nested inside loop bodies and parallel
 * branches. Returns [{ step, path }] with builder-style paths.
 */

/**
 * Validate ONE graph — the root definition or a layer mini-definition.
 * Pushes records onto opts.errors / opts.warnings with `pathPrefix`
 * prepended to every path ('' for root, 'layers.<key>.' for layers).
 *
 * opts:
 *   errors / warnings   — shared record arrays (mutated)
 *   scope               — 'root' | 'layer'
 *   layers              — the ROOT layers map (for call_layer reference checks)
 *   availableTools / toolRequiredParams / deliverableEvents — as on
 *                         validateDefinition.
 *
 * Mirrors the original single-graph behaviour: stops validating THIS graph
 * at the same phase boundaries the original function early-returned at
 * (shape → ids/edges → DAG → per-step), without aborting sibling graphs.
 */
function validateGraph(graph, pathPrefix, opts) {
    const { errors, warnings, scope = 'root', layers = {}, availableTools = null, toolRequiredParams = null, deliverableEvents = null, availableBlocks = null } = opts;
    const pushE = (rec) => errors.push(rec);
    const pushW = (rec) => warnings.push(rec);
    const startErrors = errors.length;
    const p = (s) => pathPrefix + s;
    // Contract scopes (layer + block) share the input/output-contract rules:
    // a fixed layer_input trigger, exactly one layer_output, no approval, no
    // nested layers. 'block' is a standalone Step (kind='block') validated at
    // the document root; 'layer' is an inline flowlet.
    const isContractScope = scope === 'layer' || scope === 'block';
    const contractNoun = scope === 'block' ? 'Step' : 'Layer';

    if (!isObject(graph.trigger)) pushE({ code: 'trigger.missing', severity: 'error', path: p('trigger'), message: 'Missing or invalid `trigger`.', hint: isContractScope ? `Every ${contractNoun} needs a layer_input trigger declaring its params.` : 'Call builder_propose_trigger before adding any steps.' });
    if (!Array.isArray(graph.steps)) pushE({ code: 'steps.not_array', severity: 'error', path: p('steps'), message: '`steps` must be an array.', hint: 'Initialise the draft via builder_propose_trigger so the shape is correct.' });
    if (!Array.isArray(graph.edges)) pushE({ code: 'edges.not_array', severity: 'error', path: p('edges'), message: '`edges` must be an array.', hint: 'Initialise the draft via builder_propose_trigger so the shape is correct.' });
    if (errors.length > startErrors) return;

    // Trigger — ensure it has an id and a kind.
    const trigger = graph.trigger;
    if (!trigger.id || typeof trigger.id !== 'string') pushE({ code: 'trigger.id_missing', severity: 'error', path: p('trigger.id'), message: 'trigger.id is required.', hint: 'Re-run builder_propose_trigger; it generates a stable id.' });
    if (isContractScope) {
        // Layer/Step graphs: the trigger is the input contract — kind is fixed.
        if (trigger.kind !== 'layer_input') {
            pushE({ code: 'layer.trigger_kind', severity: 'error', path: p('trigger.kind'), message: `${contractNoun} trigger kind must be 'layer_input' (got "${trigger.kind}").`, hint: `${contractNoun}s are invoked by their callers, not by their own triggers — set trigger.kind to 'layer_input' and declare params.` });
        }
        if (trigger.params !== undefined && !Array.isArray(trigger.params)) {
            pushE({ code: 'layer.params_shape', severity: 'error', path: p('trigger.params'), message: `${contractNoun} trigger.params must be an array of { name, type, required? }.`, hint: 'Use builder_set_layer_contract to declare the inputs.' });
        }
        // No document nesting — layers/Steps don't contain inline layers.
        if (graph.layers !== undefined) {
            pushE({ code: 'layers.nested', severity: 'error', path: p('layers'), message: `A ${contractNoun} cannot contain a nested \`layers\` map.`, hint: 'Move the nested layer up to definition.layers and reference it by key (sibling calls are allowed).' });
        }
    } else {
        if (!trigger.kind || typeof trigger.kind !== 'string') pushE({ code: 'trigger.kind_missing', severity: 'error', path: p('trigger.kind'), message: 'trigger.kind is required.', hint: 'Use one of: schedule, manual, webhook, app_event, agent_call.' });
    }
    validatePosition(trigger.position, p('trigger'), pushE);

    // Deliverability warning (opt-in; root only — layer triggers are
    // layer_input): an app_event trigger whose event has no producer on this
    // install — neither a triggerBus poller nor a connector push subscription
    // — will activate but never fire. Non-blocking: push-only events are
    // deliverable on connector installs but not OAuth-only ones, so we warn
    // rather than block.
    if (scope === 'root' && deliverableEvents && trigger.kind === 'app_event') {
        const prov = trigger.appEvent?.provider;
        const ev = trigger.appEvent?.event;
        const set = prov && deliverableEvents[prov];
        if (set && ev && !set.has(ev)) {
            // Nextcloud push-only events need the Bee Flow ExApp connector push
            // pipeline (pending live validation). Surface that precisely so the
            // user isn't surprised; keep it a non-blocking warning.
            let pushPending = false;
            try { pushPending = prov === 'nextcloud' && require('./deliverableEvents').isPushPending(prov, ev); } catch { /* fall back to generic */ }
            const message = pushPending
                ? `Trigger event "${prov}.${ev}" requires the Bee Flow ExApp connector and is pending live validation — it will activate but may not fire yet.`
                : `Trigger event "${prov}.${ev}" has no delivery path on this install — it will activate but may never fire.`;
            pushW({ code: 'trigger.app_event_undeliverable', severity: 'warning', path: p('trigger.appEvent.event'), message, hint: 'Pick a poller-backed event (e.g. file.new, calendar.event.upcoming) to fire today, or wait for the connector validation before relying on this event.' });
        }
    }

    // Steps — unique ids (per graph), valid types.
    const ids = new Set([trigger.id]);
    const stepById = new Map();
    if (trigger.id) stepById.set(trigger.id, trigger);
    for (let i = 0; i < graph.steps.length; i++) {
        const s = graph.steps[i];
        const at = p(`steps[${i}]`);
        if (!isObject(s)) { pushE({ code: 'step.not_object', severity: 'error', path: at, message: 'Each step must be an object.', hint: 'Remove the malformed entry and add a fresh step via builder_add_*.' }); continue; }
        if (!s.id || typeof s.id !== 'string') { pushE({ code: 'step.id_missing', severity: 'error', path: at + '.id', message: 'Each step needs an `id`.', hint: 'Use the id returned from the previous builder_add_* tool result.' }); continue; }
        if (ids.has(s.id)) { pushE({ code: 'step.id_duplicate', severity: 'error', path: at + '.id', message: `Duplicate step id: ${s.id}`, hint: 'Remove the duplicate or call builder_remove_step on one of them.' }); continue; }
        if (!VALID_STEP_TYPES.has(s.type)) { pushE({ code: 'step.unknown_type', severity: 'error', path: at + '.type', message: `Step ${s.id}: unknown type "${s.type}".`, hint: `Use one of: ${[...VALID_STEP_TYPES].join(', ')}.` }); continue; }
        // Approval steps pause the run and resume by PARENT-graph step id —
        // a pause inside a layer/Step sub-graph has no resumable address. The
        // runner enforces this too (execApproval throws inside layers).
        if (isContractScope && s.type === 'approval') {
            pushE({ code: 'layer.approval_forbidden', severity: 'error', path: at + '.type', message: `Step ${s.id}: approval steps are not supported inside a ${contractNoun}.`, hint: `Move the approval to the parent flow, before or after the call to this ${contractNoun}.` });
            continue;
        }
        // v1: a Step cannot call another Step (cross-row recursion can't be
        // statically checked). Inline flowlets and nested-in-automation calls
        // remain fine; only scope='block' forbids it.
        if (scope === 'block' && s.type === 'call_block') {
            pushE({ code: 'block.nested_call_forbidden', severity: 'error', path: at + '.type', message: `Step ${s.id}: a Step cannot contain another Step (call_block) yet.`, hint: 'Inline the logic, or compose Steps at the automation level instead.' });
            continue;
        }
        validatePosition(s.position, at, pushE);
        ids.add(s.id);
        stepById.set(s.id, s);
    }

    // Layer output contract: exactly one layer_output per layer. Zero is a
    // degenerate-but-runnable layer (returns the last step's output) →
    // warning; more than one is ambiguous → error. At the ROOT, layer_output
    // steps stay legal (orphan layers converted to automations keep theirs).
    if (isContractScope) {
        const outs = graph.steps.filter(s => isObject(s) && s.type === 'layer_output');
        if (outs.length === 0) {
            pushW({ code: 'layer.no_output', severity: 'warning', path: p('steps'), message: `${contractNoun} has no layer_output step — callers receive the last step\'s raw output.`, hint: 'Add a layer_output step with explicit fields so it has a stable output contract.' });
        } else if (outs.length > 1) {
            pushE({ code: 'layer.multiple_outputs', severity: 'error', path: p('steps'), message: `${contractNoun} has ${outs.length} layer_output steps — the output contract is ambiguous.`, hint: 'Keep exactly one layer_output step; merge the branches into it.' });
        }
    }

    // Edges — reference known nodes; labels are known + on_error sources legal.
    for (let i = 0; i < graph.edges.length; i++) {
        const e = graph.edges[i];
        const at = p(`edges[${i}]`);
        if (!isObject(e) || !e.from || !e.to) { pushE({ code: 'edge.shape', severity: 'error', path: at, message: 'Each edge needs `from` and `to`.', hint: 'Re-add the edge via the relevant builder_add_* tool which fills both fields.' }); continue; }
        if (!ids.has(e.from)) pushE({ code: 'edge.unknown_from', severity: 'error', path: at + '.from', message: `Edge from unknown node: ${e.from}`, hint: 'Either remove the edge or add the missing step.' });
        if (!ids.has(e.to))   pushE({ code: 'edge.unknown_to',   severity: 'error', path: at + '.to',   message: `Edge to unknown node: ${e.to}`,   hint: 'Either remove the edge or add the missing step.' });
        if (typeof e.label === 'string' && e.label) {
            // 'case:<name>' labels are validated against the switch's case
            // names by the switch-step block below; everything else must be
            // one of the runner's routed labels or it never fires.
            if (!KNOWN_EDGE_LABELS.has(e.label) && !e.label.startsWith('case:')) {
                pushW({ code: 'edge.label_unknown', severity: 'warning', path: at + '.label', message: `Edge ${e.from} → ${e.to} has unknown label "${e.label}" — it will never fire.`, hint: 'Use one of: then, else, on_success, on_error, case:<switch-case-name>, or remove the label so the edge fires on success.' });
            }
            if (e.label === 'on_error' && ids.has(e.from)) {
                const srcType = e.from === trigger.id ? 'trigger' : stepById.get(e.from)?.type;
                if (ON_ERROR_FORBIDDEN_SOURCE_TYPES.has(srcType)) {
                    pushE({ code: 'edge.error_label_invalid', severity: 'error', path: at + '.label', message: `Edge ${e.from} → ${e.to}: a ${srcType === 'trigger' ? 'trigger' : `"${srcType}" step`} cannot have an on_error branch.`, hint: 'Error branches start from steps that can fail at run time (integration_action, ai_step, code, call_layer, loop, parallel, notification, wait). Remove this edge or move it to the failing step.' });
                } else if (!ON_ERROR_SOURCE_TYPES.has(srcType)) {
                    pushW({ code: 'edge.error_label_unlikely', severity: 'warning', path: at + '.label', message: `Edge ${e.from} → ${e.to}: "${srcType}" steps are pure data operations that rarely fail — this error branch will likely never run.`, hint: 'Error branches are meant for steps that talk to external systems (integration_action, ai_step, code, call_layer, …). Keep it only if you rely on a structured failure like collection_too_large.' });
                }
            }
        }
    }
    if (errors.length > startErrors) return;

    // DAG check.
    const nodes = Array.from(ids);
    const order = topoOrder(nodes, graph.edges);
    if (!order) pushE({ code: 'graph.cycle', severity: 'error', path: p('edges'), message: 'Definition contains a cycle.', hint: 'Inspect the edges array; remove the back-edge that closes the loop.' });
    if (errors.length > startErrors) return;

    // call_layer reference checks — run over EVERY call step in this graph,
    // including those nested inside loop bodies / parallel branches.
    for (const { step, path: at } of collectCallLayerSteps(graph, pathPrefix)) {
        validateCallLayerStep(step, at, layers, pushE);
    }

    // call_block reference checks — external Step references. availableBlocks
    // (when provided) is the caller's published-Steps catalog.
    for (const { step, path: at } of collectCallBlockSteps(graph, pathPrefix)) {
        validateCallBlockStep(step, at, availableBlocks, pushE);
    }

    // Per-step validation + reference scoping (top-level only; loop bodies
    // are validated within their own scope below).
    const seenSoFar = new Set([trigger.id]); // outputs available
    for (const id of order) {
        const step = stepById.get(id);
        if (!step) continue;
        if (step.id === trigger.id) continue;
        const at = p(`steps[${id}]`);

        // Step-type-specific structural checks.
        if (step.type === 'integration_action') {
            if (!step.tool || typeof step.tool !== 'string') pushE({ code: 'integration_action.tool_missing', severity: 'error', path: at + '.tool', message: `Step ${step.id}: integration_action requires \`tool\`.`, hint: 'Pick a tool from the catalog and pass it as a string.' });
            else if (availableTools && !availableTools.has(step.tool)) pushE({ code: 'integration_action.tool_unknown', severity: 'error', path: at + '.tool', message: `Step ${step.id}: tool "${step.tool}" not in user\'s catalog.`, hint: 'Either pick a tool the user has connected or ask them to connect the integration.' });
            // Required-input check (only when caller supplied the schema map).
            // Absent or empty-string-literal required inputs would fail at run
            // time with a tool-side "X is required" error; catch it at activate.
            else if (toolRequiredParams && Array.isArray(toolRequiredParams[step.tool])) {
                const inputs = isObject(step.inputs) ? step.inputs : {};
                for (const param of toolRequiredParams[step.tool]) {
                    const b = inputs[param];
                    const absent = b === undefined || b === null;
                    const emptyLiteral = isObject(b) && b.kind === 'literal'
                        && (b.value === '' || b.value === undefined || b.value === null);
                    if (absent || emptyLiteral) {
                        pushE({ code: 'integration_action.param_missing', severity: 'error', path: at + '.inputs.' + param, message: `Step ${step.id}: tool "${step.tool}" requires input "${param}"${emptyLiteral ? ' but it is set to an empty value' : ''}.`, hint: `Provide "${param}" — bind it to an upstream field (kind:'ref'/'template') or set a non-empty literal.` });
                    }
                }
            }
        }
        if (step.type === 'ai_step') {
            if (!step.prompt || typeof step.prompt !== 'string') pushE({ code: 'ai_step.prompt_missing', severity: 'error', path: at + '.prompt', message: `Step ${step.id}: ai_step requires \`prompt\`.`, hint: 'Provide a non-empty prompt string.' });
        }
        if (step.type === 'condition') {
            if (!step.expr || typeof step.expr !== 'string') pushE({ code: 'condition.expr_missing', severity: 'error', path: at + '.expr', message: `Step ${step.id}: condition requires \`expr\`.`, hint: 'Provide a restricted-grammar expression like `steps.x.output.count > 0`.' });
            else {
                try { parseExpr(step.expr); }
                catch (e) { pushE({ code: 'condition.expr_parse', severity: 'error', path: at + '.expr', message: `Step ${step.id}: condition expr parse error — ${e.message}`, hint: 'Restricted grammar only — no function calls, assignments, or templates.' }); }
            }
            // A condition with no `then` and no `else` outgoing edges
            // dead-ends at runtime — promote from warning to error so
            // the builder cannot finalize a definitionally broken graph.
            const out = graph.edges.filter(e => e.from === step.id);
            const labels = new Set(out.map(e => e.label));
            if (!labels.has('then') && !labels.has('else')) {
                pushE({ code: 'condition.dead_branch', severity: 'error', path: at + '.edges', message: `Step ${step.id}: condition has no 'then' or 'else' edges — both branches dead-end.`, hint: 'Append the next step with afterStepId set to this condition id (the edge auto-labels then, then else), or pass thenStepId/elseStepId to wire existing steps.' });
            } else if (!labels.has('then') || !labels.has('else')) {
                pushW({ code: 'condition.partial_branch', severity: 'warning', path: at + '.edges', message: `Step ${step.id}: condition has only one branch wired — the other will dead-end.`, hint: 'Wire both then and else, or remove the condition if a one-sided check is intended.' });
            }
        }
        if (step.type === 'loop') {
            if (!step.itemVar || typeof step.itemVar !== 'string') pushE({ code: 'loop.itemVar_missing', severity: 'error', path: at + '.itemVar', message: `Step ${step.id}: loop requires \`itemVar\`.`, hint: 'Choose a short variable name like `item` or `email`.' });
            if (!step.overRef || typeof step.overRef !== 'string') pushE({ code: 'loop.overRef_missing', severity: 'error', path: at + '.overRef', message: `Step ${step.id}: loop requires \`overRef\`.`, hint: 'Bind to an upstream array, e.g. `steps.<id>.output.items`.' });
            if (Array.isArray(step.body)) {
                for (const child of step.body) {
                    if (!isObject(child) || !child.id) pushE({ code: 'loop.body_item_id_missing', severity: 'error', path: at + '.body', message: `Step ${step.id}: loop body item missing id.`, hint: 'Re-add the body step via the relevant builder_add_* tool.' });
                }
            }
            if (typeof step.maxIterations !== 'number' || step.maxIterations < 1 || step.maxIterations > 1000) {
                pushE({ code: 'loop.max_iterations_range', severity: 'error', path: at + '.maxIterations', message: `Step ${step.id}: loop maxIterations must be 1..1000.`, hint: 'Pick a small integer; 100 is a sensible default.' });
            }
        }
        // Per-step iteration ("run once per item"). A leaf executable step
        // may carry `step.forEach = { overRef, itemVar, maxIterations }` to
        // fan out over an upstream array — the runner runs the step once per
        // element with `loop.<itemVar>` bound (see execForEachStep). Control /
        // container types iterate via their own mechanics, so forEach there is
        // rejected (default-deny allow-list).
        if (step.forEach !== undefined && step.forEach !== null) {
            const FOREACH_ALLOWED = new Set(['integration_action', 'ai_step', 'code', 'notification', 'set']);
            if (!isObject(step.forEach)) {
                pushE({ code: 'foreach.shape', severity: 'error', path: at + '.forEach', message: `Step ${step.id}: forEach must be an object { overRef, itemVar, maxIterations }.`, hint: 'Remove it, or provide overRef + itemVar.' });
            } else if (!FOREACH_ALLOWED.has(step.type)) {
                pushE({ code: 'foreach.type_unsupported', severity: 'error', path: at + '.forEach', message: `Step ${step.id}: "${step.type}" steps cannot use forEach iteration.`, hint: 'Only integration_action / ai_step / code / notification / set can run once per item. Use a loop step, or remove forEach.' });
            } else {
                if (!step.forEach.overRef || typeof step.forEach.overRef !== 'string') pushE({ code: 'foreach.overRef_missing', severity: 'error', path: at + '.forEach.overRef', message: `Step ${step.id}: forEach requires \`overRef\`.`, hint: 'Bind to an upstream array, e.g. `steps.<id>.output.results`.' });
                if (!step.forEach.itemVar || typeof step.forEach.itemVar !== 'string') pushE({ code: 'foreach.itemVar_missing', severity: 'error', path: at + '.forEach.itemVar', message: `Step ${step.id}: forEach requires \`itemVar\`.`, hint: 'Choose a short name like `item` or `result`; reference each element as loop.<itemVar>.' });
                if (step.forEach.maxIterations !== undefined && (typeof step.forEach.maxIterations !== 'number' || step.forEach.maxIterations < 1 || step.forEach.maxIterations > 1000)) {
                    pushE({ code: 'foreach.max_iterations_range', severity: 'error', path: at + '.forEach.maxIterations', message: `Step ${step.id}: forEach maxIterations must be 1..1000.`, hint: 'Pick a small integer; 100 is a sensible default.' });
                }
            }
        }
        if (step.type === 'code') {
            if (!step.code || typeof step.code !== 'string') pushE({ code: 'code.code_missing', severity: 'error', path: at + '.code', message: `Step ${step.id}: code step requires \`code\`.`, hint: 'Provide the JS source as a string.' });
            if (step.language && step.language !== 'javascript') pushE({ code: 'code.language_unsupported', severity: 'error', path: at + '.language', message: `Step ${step.id}: only language: 'javascript' supported.`, hint: 'Either omit `language` or set it to "javascript".' });
        }
        if (step.type === 'notification') {
            if (!step.title && !step.body) pushE({ code: 'notification.empty', severity: 'error', path: at, message: `Step ${step.id}: notification needs at least \`title\` or \`body\`.`, hint: 'Provide one (or both) so the user has something to read.' });
        }
        // call_layer reference checks ran above (collectCallLayerSteps pass —
        // covers loop bodies / parallel branches too). Leftover denormalized
        // contract fields (inputContract/outputContract/version) are tolerated
        // and ignored.
        if (step.type === 'layer_output') {
            if (step.fields !== undefined && !isObject(step.fields)) pushE({ code: 'layer_output.fields_shape', severity: 'error', path: at + '.fields', message: `Step ${step.id}: layer_output.fields must be an object map of {key: binding}.`, hint: 'Use { result: { kind: "ref", path: "..." }, ... }.' });
        }
        // ── n8n-style utility nodes ───────────────────────────────────
        if (step.type === 'set') {
            // Set is "edit fields" — every entry is a binding shape. An
            // empty `fields` map IS allowed (degenerate but not invalid)
            // so we only check the shape of what's provided.
            if (step.fields !== undefined && !isObject(step.fields)) {
                pushE({ code: 'set.fields_shape', severity: 'error', path: at + '.fields', message: `Step ${step.id}: set.fields must be an object map of {key: binding}.`, hint: 'Use { name: { kind: "literal", value: "..." }, ... }.' });
            }
        }
        if (step.type === 'datetime') {
            const op = step.op;
            if (!op || typeof op !== 'string') pushE({ code: 'datetime.op_missing', severity: 'error', path: at + '.op', message: `Step ${step.id}: datetime requires \`op\`.`, hint: `One of: ${Array.from(DATETIME_OPS).join(', ')}.` });
            else if (!DATETIME_OPS.has(op)) pushE({ code: 'datetime.op_unknown', severity: 'error', path: at + '.op', message: `Step ${step.id}: unknown datetime op "${op}".`, hint: `Use one of: ${Array.from(DATETIME_OPS).join(', ')}.` });
            // Per-op required fields.
            if (op === 'format' && !step.format) pushE({ code: 'datetime.format_missing', severity: 'error', path: at + '.format', message: `Step ${step.id}: datetime op "format" requires \`format\` string.`, hint: 'e.g. "yyyy-MM-dd HH:mm".' });
            if ((op === 'addDays' || op === 'addHours' || op === 'addMinutes') && typeof step.amount !== 'number') pushE({ code: 'datetime.amount_missing', severity: 'error', path: at + '.amount', message: `Step ${step.id}: datetime op "${op}" requires numeric \`amount\`.`, hint: 'Positive or negative integer.' });
            if (op === 'extract' && (!step.part || !DATETIME_PARTS.has(step.part))) pushE({ code: 'datetime.part_invalid', severity: 'error', path: at + '.part', message: `Step ${step.id}: datetime op "extract" requires \`part\` in ${Array.from(DATETIME_PARTS).join('/')}.`, hint: 'Pick one of the supported parts.' });
            if (op === 'diff' && (!step.unit || !DATETIME_DIFF_UNITS.has(step.unit))) pushE({ code: 'datetime.unit_invalid', severity: 'error', path: at + '.unit', message: `Step ${step.id}: datetime op "diff" requires \`unit\` in ${Array.from(DATETIME_DIFF_UNITS).join('/')}.`, hint: 'Pick the unit you want the difference reported in.' });
        }
        if (step.type === 'wait') {
            const s = step.seconds;
            if (typeof s !== 'number' || s < 1 || s > 86400 || !Number.isFinite(s)) {
                pushE({ code: 'wait.seconds_range', severity: 'error', path: at + '.seconds', message: `Step ${step.id}: wait.seconds must be 1..86400.`, hint: 'Pick a reasonable duration (max 24h).' });
            }
        }
        if (step.type === 'stop_error') {
            if (!step.message || typeof step.message !== 'string') pushE({ code: 'stop_error.message_missing', severity: 'error', path: at + '.message', message: `Step ${step.id}: stop_error requires \`message\` string.`, hint: 'Surface a human-readable reason for halting the run.' });
        }
        if (step.type === 'switch') {
            if (!step.expr || typeof step.expr !== 'string') pushE({ code: 'switch.expr_missing', severity: 'error', path: at + '.expr', message: `Step ${step.id}: switch requires \`expr\`.`, hint: 'Restricted-grammar expression whose value is matched against each case.' });
            else { try { parseExpr(step.expr); } catch (e) { pushE({ code: 'switch.expr_parse', severity: 'error', path: at + '.expr', message: `Step ${step.id}: switch expr parse error — ${e.message}`, hint: 'Restricted grammar only.' }); } }
            if (!Array.isArray(step.cases) || step.cases.length === 0) pushE({ code: 'switch.cases_missing', severity: 'error', path: at + '.cases', message: `Step ${step.id}: switch requires at least one case.`, hint: 'cases: [{ name: "...", value: ... }].' });
            else {
                const seenNames = new Set();
                for (let i = 0; i < step.cases.length; i++) {
                    const c = step.cases[i];
                    if (!isObject(c) || !c.name || typeof c.name !== 'string') { pushE({ code: 'switch.case_shape', severity: 'error', path: at + `.cases[${i}]`, message: `Step ${step.id}: switch case ${i} missing name.`, hint: 'Each case needs { name, value }.' }); continue; }
                    if (c.name === 'default') { pushE({ code: 'switch.case_name_reserved', severity: 'error', path: at + `.cases[${i}].name`, message: `Step ${step.id}: case name "default" is reserved; use \`defaultBranch\` instead.`, hint: 'Set defaultBranch on the switch step to route unmatched values.' }); continue; }
                    if (seenNames.has(c.name)) pushE({ code: 'switch.case_name_duplicate', severity: 'error', path: at + `.cases[${i}].name`, message: `Step ${step.id}: duplicate switch case name "${c.name}".`, hint: 'Each case name must be unique.' });
                    seenNames.add(c.name);
                }
                const out = graph.edges.filter(e => e.from === step.id);
                const caseLabels = new Set(out.map(e => e.caseName).filter(Boolean));
                const wired = step.cases.filter(c => caseLabels.has(c.name)).length;
                if (wired === 0) pushE({ code: 'switch.no_branches', severity: 'error', path: at + '.edges', message: `Step ${step.id}: switch has no case edges wired — all branches dead-end.`, hint: 'Add edges from this switch with caseName matching each case.' });
                else if (wired < step.cases.length) pushW({ code: 'switch.partial_branches', severity: 'warning', path: at + '.edges', message: `Step ${step.id}: only ${wired}/${step.cases.length} switch cases have outgoing edges.`, hint: 'Wire each case to its next step, or remove unused cases.' });
            }
        }
        // Phase B: collection ops — every type takes `arrayRef`.
        if (step.type === 'filter' || step.type === 'limit' || step.type === 'dedupe' || step.type === 'aggregate' || step.type === 'summarize') {
            if (!step.arrayRef || typeof step.arrayRef !== 'string') pushE({ code: `${step.type}.arrayRef_missing`, severity: 'error', path: at + '.arrayRef', message: `Step ${step.id}: ${step.type} requires \`arrayRef\`.`, hint: 'Bind to an upstream array, e.g. `steps.<id>.output.items`.' });
            // Optional input cap — the runner enforces min(maxItems, platform
            // ceiling), so a value above 10000 is legal but ineffective.
            if (step.maxItems !== undefined) {
                if (typeof step.maxItems !== 'number' || !Number.isInteger(step.maxItems) || step.maxItems < 1) {
                    pushE({ code: `${step.type}.maxItems_invalid`, severity: 'error', path: at + '.maxItems', message: `Step ${step.id}: maxItems must be a positive integer.`, hint: 'Set a positive integer, or omit it to use the platform default cap.' });
                } else if (step.maxItems > 10000) {
                    pushW({ code: `${step.type}.maxItems_exceeds_cap`, severity: 'warning', path: at + '.maxItems', message: `Step ${step.id}: maxItems ${step.maxItems} exceeds the platform cap (10000) — the cap still wins at runtime.`, hint: 'Lower maxItems to 10000 or below, or raise AUTOMATION_COLLECTION_MAX_ITEMS server-side.' });
                }
            }
        }
        if (step.type === 'filter') {
            if (!step.expr || typeof step.expr !== 'string') pushE({ code: 'filter.expr_missing', severity: 'error', path: at + '.expr', message: `Step ${step.id}: filter requires \`expr\`.`, hint: 'Use the current element as `item`, e.g. `item.amount > 1000`.' });
            else { try { parseExpr(step.expr); } catch (e) { pushE({ code: 'filter.expr_parse', severity: 'error', path: at + '.expr', message: `Step ${step.id}: filter expr parse error — ${e.message}`, hint: 'Restricted grammar only.' }); } }
        }
        if (step.type === 'limit') {
            if (typeof step.count !== 'number' || step.count < 0 || !Number.isFinite(step.count)) pushE({ code: 'limit.count_missing', severity: 'error', path: at + '.count', message: `Step ${step.id}: limit requires non-negative numeric \`count\`.`, hint: '0 returns no items, 10 returns first/last 10.' });
            if (step.mode !== undefined && !LIMIT_MODES.has(step.mode)) pushE({ code: 'limit.mode_invalid', severity: 'error', path: at + '.mode', message: `Step ${step.id}: limit.mode must be "first" or "last".`, hint: 'Default is "first".' });
        }
        if (step.type === 'aggregate' || step.type === 'summarize') {
            if (!step.field || typeof step.field !== 'string') pushE({ code: `${step.type}.field_missing`, severity: 'error', path: at + '.field', message: `Step ${step.id}: ${step.type} requires \`field\` name to read from each item.`, hint: 'e.g. "amount" or "email".' });
        }
        if (step.type === 'summarize') {
            if (!step.op || !SUMMARIZE_OPS.has(step.op)) pushE({ code: 'summarize.op_invalid', severity: 'error', path: at + '.op', message: `Step ${step.id}: summarize requires \`op\` in ${Array.from(SUMMARIZE_OPS).join('/')}.`, hint: 'Pick the aggregation operator.' });
        }

        // Reference scoping — collect all ref paths used in this step's
        // inputs / prompt / expr / template fields, ensure their roots
        // resolve to known sources, and any "steps.<id>.output" is for
        // a step that has run before this one. Inside a layer the same
        // roots apply: `trigger` is the layer_input (so bindings stay
        // {{trigger.output.<param>}}), `steps` are the layer's own steps.
        const refs = [];
        collectRefPaths(step.inputs, refs);
        // NOTE: ai_step.prompt is NOT a runtime template — the runner passes
        // it to the model as literal instruction text alongside a separate
        // JSON `inputs` section. So `{{from}}` in a prompt is a placeholder
        // referring to that step's `inputs.from` key, not a cross-step ref.
        // Treating it as a ref produced spurious "unknown ref root" warnings
        // for every well-formed automation that paraphrased its inputs in
        // the prompt body.
        if (step.type === 'notification') {
            collectRefPaths({ kind: 'template', value: step.title || '' }, refs);
            collectRefPaths({ kind: 'template', value: step.body || '' }, refs);
        }
        if (step.type === 'condition') refs.push({ kind: 'expr', src: step.expr || '' });
        if (step.type === 'loop' && step.overRef) refs.push({ kind: 'ref', path: step.overRef });
        // forEach iteration source resolves like a loop's overRef.
        if (step.forEach && typeof step.forEach.overRef === 'string' && step.forEach.overRef) refs.push({ kind: 'ref', path: step.forEach.overRef });
        if (step.type === 'set') collectRefPaths(step.fields, refs);
        if (step.type === 'layer_output') collectRefPaths(step.fields, refs);
        if (step.type === 'datetime') {
            if (typeof step.input === 'string' && step.input) refs.push({ kind: 'ref', path: step.input });
            if (typeof step.input2 === 'string' && step.input2) refs.push({ kind: 'ref', path: step.input2 });
        }
        if (step.type === 'stop_error') collectRefPaths({ kind: 'template', value: step.message || '' }, refs);
        if (step.type === 'switch') refs.push({ kind: 'expr', src: step.expr || '' });
        if ((step.type === 'filter' || step.type === 'limit' || step.type === 'dedupe' || step.type === 'aggregate' || step.type === 'summarize') && step.arrayRef) {
            refs.push({ kind: 'ref', path: step.arrayRef });
        }
        // Filter's expr references `item` (loop-style scalar). The
        // runtime injects item per element so we don't validate sub-paths
        // here; the runtime returns undefined for typos. Same shortcut
        // condition/switch already use for their exprs.

        // Uninterpolated-literal lint: a kind:'literal' input carrying {{…}}
        // ships verbatim (only kind:'template' interpolates), so the user
        // gets raw braces in their file path / message instead of a value.
        const litBraces = [];
        collectLiteralBraces(step.inputs, litBraces);
        if (step.type === 'set') collectLiteralBraces(step.fields, litBraces);
        for (const lit of litBraces) {
            const shown = lit.length > 48 ? lit.slice(0, 48) + '…' : lit;
            pushW({ code: 'literal.uninterpolated', severity: 'warning', path: at, message: `Step ${step.id}: literal input "${shown}" contains {{…}} but is kind:'literal', so it ships verbatim instead of being interpolated.`, hint: "Set kind:'template' on that input so {{trigger.output.…}} / {{steps.…}} placeholders are substituted at runtime." });
        }

        for (const r of refs) {
            const path = r.kind === 'ref' ? r.path : null;
            // For exprs, we don't statically check sub-paths — runtime will
            // safely return undefined for unknown lookups.
            if (!path) continue;
            const root = rootOf(path);
            if (!root) { pushW({ code: 'ref.invalid', severity: 'warning', path: at, message: `Step ${step.id}: invalid ref "${path}".`, hint: 'Refs must start with one of: trigger, steps, vars, secrets, loop.' }); continue; }
            if (root === 'trigger' || root === 'vars' || root === 'secrets' || root === 'loop') continue;
            if (root === 'steps') {
                const upstreamId = secondSegment(path);
                if (!upstreamId) { pushW({ code: 'ref.no_step_id', severity: 'warning', path: at, message: `Step ${step.id}: ref must include a step id.`, hint: 'Use the form steps.<id>.output.<field>.' }); continue; }
                if (!ids.has(upstreamId) && upstreamId !== step.id) {
                    // Promote unknown-step refs to errors with a "did you mean"
                    // suggestion so the LLM gets the actual id in its hint
                    // and self-corrects on the next turn instead of repeating
                    // the fabricated id.
                    const candidates = Array.from(ids).filter(id => id !== trigger.id && id !== step.id);
                    const suggestion = pickClosestId(upstreamId, candidates);
                    pushE({
                        code: 'ref.unknown_step',
                        severity: 'error',
                        path: at,
                        message: `Step ${step.id}: refers to non-existent step "${upstreamId}".`,
                        hint: suggestion
                            ? `Did you mean "${suggestion}"? Available step ids: ${candidates.join(', ') || '(none yet)'}.`
                            : `No matching step exists. Available step ids: ${candidates.join(', ') || '(none yet)'}.`,
                    });
                    continue;
                }
                if (!seenSoFar.has(upstreamId) && upstreamId !== step.id) {
                    pushW({ code: 'ref.forward', severity: 'warning', path: at, message: `Step ${step.id}: refers to step "${upstreamId}" — will resolve to undefined at runtime if it doesn't produce output by then.`, hint: `Wire an edge from "${upstreamId}" to "${step.id}" so the upstream output is available.` });
                }
                continue;
            }
            pushW({ code: 'ref.unknown_root', severity: 'warning', path: at, message: `Step ${step.id}: unknown ref root "${root}".`, hint: 'Refs must start with one of: trigger, steps, vars, secrets, loop.' });
        }
        seenSoFar.add(step.id);
    }
}


/**
 * Validate a definition. Returns { ok, errors[], warnings[] } where each
 * record is `{ code, severity, path, message, hint }`. The structured
 * shape lets the SSE builder loop feed *specific* failures back to the
 * LLM so it can self-correct instead of guessing what the free-text
 * meant.
 *
 *   code        — short, stable identifier (e.g. 'condition.dead_branch')
 *   severity    — 'error' | 'warning'
 *   path        — JSON-pointer-ish path into the def (e.g. 'steps[3].expr',
 *                 'layers.enrich.steps[2].expr' for layer-scoped records)
 *   message     — human-readable, for UI display
 *   hint        — actionable next step, written for the LLM
 *
 * `availableTools` (optional) is a Set of tool names from the catalog. When
 * provided, integration_action.tool is checked against it.
 *
 * `toolRequiredParams` (optional) is an object map { toolName: ['p1', …] } of
 * each tool's required input names. When provided, an integration_action whose
 * required input is absent (or bound to an empty-string literal) is flagged —
 * this is what stops a Talk-send-with-no-room or calendar-event-with-no-date
 * from activating green and then failing silently.
 */
function validateDefinition(def, { availableTools = null, toolRequiredParams = null, deliverableEvents = null, scope = 'root', availableBlocks = null } = {}) {
    const errors = [];
    const warnings = [];
    const pushE = (rec) => errors.push(rec);
    const pushW = (rec) => warnings.push(rec);

    if (!isObject(def)) {
        return {
            ok: false,
            errors: [{ code: 'shape.not_object', severity: 'error', path: '', message: 'Definition must be an object.', hint: 'Pass a JSON object with trigger, steps, and edges keys.' }],
            warnings: [],
        };
    }

    // ── Inline layers map: root-only, plain object, snake-case keys ──────
    // Validated FIRST so call_layer reference checks inside the graphs can
    // resolve against the well-formed subset.
    const layersMap = {};
    if (def.layers !== undefined) {
        if (!isObject(def.layers)) {
            pushE({ code: 'layers.shape', severity: 'error', path: 'layers', message: '`layers` must be an object map of { key: miniDefinition }.', hint: 'Each entry is { title, trigger (kind layer_input), steps (incl. a layer_output), edges }.' });
        } else {
            for (const [key, value] of Object.entries(def.layers)) {
                if (!LAYER_KEY_RE.test(key)) {
                    pushE({ code: 'layers.key_invalid', severity: 'error', path: `layers.${key}`, message: `Invalid layer key "${key}".`, hint: 'Keys must match ^[a-z][a-z0-9_]*$ (lowercase snake_case, starting with a letter).' });
                    continue;
                }
                if (!isObject(value)) {
                    pushE({ code: 'layers.value_shape', severity: 'error', path: `layers.${key}`, message: `Layer "${key}" must be an object (a mini-definition).`, hint: 'Use { title, trigger, steps, edges } — same shape as the root document.' });
                    continue;
                }
                layersMap[key] = value;
            }
        }
    }

    // §WS1.4 — graph-size ceilings (DoS guard, independent of the body limit).
    // Counted up front and failed fast so the O(n) graph passes (topo-sort +
    // Levenshtein id suggestions) never run on a pathologically large blob.
    {
        const rootSteps = Array.isArray(def.steps) ? def.steps.length : 0;
        const rootEdges = Array.isArray(def.edges) ? def.edges.length : 0;
        if (rootSteps > MAX_STEPS) {
            pushE({ code: 'shape.too_many_steps', severity: 'error', path: 'steps', message: `Definition has ${rootSteps} steps — the maximum is ${MAX_STEPS}.`, hint: 'Split the work into reusable Steps/Flowlets or multiple automations.' });
        }
        if (rootEdges > MAX_EDGES) {
            pushE({ code: 'shape.too_many_edges', severity: 'error', path: 'edges', message: `Definition has ${rootEdges} edges — the maximum is ${MAX_EDGES}.`, hint: 'Simplify the graph or split it into multiple automations.' });
        }
        let totalNodes = rootSteps;
        for (const layer of Object.values(layersMap)) {
            totalNodes += Array.isArray(layer.steps) ? layer.steps.length : 0;
            if (Array.isArray(layer.steps) && layer.steps.length > MAX_STEPS) {
                pushE({ code: 'layers.too_many_steps', severity: 'error', path: 'layers', message: `A layer has ${layer.steps.length} steps — the maximum is ${MAX_STEPS} per layer.`, hint: 'Flatten or split the layer.' });
            }
        }
        if (totalNodes > MAX_TOTAL_NODES) {
            pushE({ code: 'shape.too_many_nodes', severity: 'error', path: '', message: `Definition has ${totalNodes} total steps across all layers — the maximum is ${MAX_TOTAL_NODES}.`, hint: 'Reduce the number of steps or split into multiple automations.' });
        }
        if (errors.length) return { ok: false, errors, warnings };
    }

    const graphOpts = { errors, warnings, layers: layersMap, availableTools, toolRequiredParams, deliverableEvents, availableBlocks };

    // Root graph. Preserve the original early-return semantics: a root
    // whose basic shape is broken returns immediately (the layer graphs
    // would only add noise on top of a fundamentally malformed document).
    // scope is 'root' for automations or 'block' for a standalone Step (whose
    // root IS the input/output contract — validateGraph applies the layer
    // rules and flags any nested `layers` itself).
    validateGraph(def, '', { ...graphOpts, scope });
    if (!isObject(def.trigger) || !Array.isArray(def.steps) || !Array.isArray(def.edges)) {
        return { ok: false, errors, warnings };
    }

    // Steps (scope='block') don't carry inline layers — skip the per-layer and
    // layer-reference passes entirely (validateGraph already flagged any).
    if (scope !== 'block') {
        // Each layer mini-definition gets the SAME per-graph validation under
        // its own path prefix, plus the layer-scope rules (layer_input trigger,
        // single layer_output, no approval, no nested layers).
        for (const [key, layer] of Object.entries(layersMap)) {
            validateGraph(layer, `layers.${key}.`, { ...graphOpts, scope: 'layer' });
        }

        // Layer-reference graph: cycles, depth cap, orphans.
        validateLayerGraph(def, layersMap, pushE, pushW);
    }

    return { ok: errors.length === 0, errors, warnings };
}

module.exports = { validateDefinition, topoOrder, collectCallLayerSteps, collectCallBlockSteps, LAYER_KEY_RE, MAX_STEPS, MAX_EDGES, MAX_TOTAL_NODES };
