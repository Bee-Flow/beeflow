/**
 * Validate an automation definition before save / run.
 *
 * Checks:
 *   - Required top-level shape (trigger, steps[], edges[]).
 *   - Each step has a unique id.
 *   - DAG is acyclic via Kahn's algorithm.
 *   - condition.expr parses under the restricted grammar.
 *   - integration_action.tool is a string (catalog lookup happens at run time).
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
]);

const DATETIME_OPS = new Set(['now', 'parse', 'format', 'addDays', 'addHours', 'addMinutes', 'diff', 'extract']);
const SUMMARIZE_OPS = new Set(['sum', 'count', 'avg', 'min', 'max']);
const LIMIT_MODES = new Set(['first', 'last']);
const DATETIME_PARTS = new Set(['year', 'month', 'day', 'hour', 'minute', 'second', 'dayOfWeek']);
const DATETIME_DIFF_UNITS = new Set(['days', 'hours', 'minutes', 'seconds']);

function isObject(x) { return x && typeof x === 'object' && !Array.isArray(x); }

/**
 * Optional canvas position (`{ x, y }`) — written by the drag-and-drop
 * builder, ignored by the runner. We reject only malformed shapes so a
 * typo on the UI side surfaces fast instead of silently round-tripping
 * garbage through the JSONB blob.
 */
function validatePosition(pos, at, push) {
    if (pos === undefined || pos === null) return;
    if (!isObject(pos)) {
        push({ code: 'position.shape', severity: 'error', path: at + '.position', message: 'position must be an object { x, y }.', hint: 'Pass { x: number, y: number } or omit the field entirely.' });
        return;
    }
    for (const k of ['x', 'y']) {
        const v = pos[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
            push({ code: 'position.coord', severity: 'error', path: at + `.position.${k}`, message: `position.${k} must be a finite number.`, hint: 'Use canvas coordinates from the visual editor.' });
        }
    }
}

function topoOrder(nodes, edges) {
    const inDeg = new Map();
    const adj = new Map();
    for (const n of nodes) { inDeg.set(n, 0); adj.set(n, []); }
    for (const e of edges) {
        if (!adj.has(e.from)) { adj.set(e.from, []); inDeg.set(e.from, inDeg.get(e.from) || 0); }
        if (!inDeg.has(e.to)) { inDeg.set(e.to, 0); adj.set(e.to, []); }
        adj.get(e.from).push(e.to);
        inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
    }
    const q = [];
    for (const [k, v] of inDeg) if (v === 0) q.push(k);
    const order = [];
    while (q.length) {
        const cur = q.shift();
        order.push(cur);
        for (const next of (adj.get(cur) || [])) {
            inDeg.set(next, inDeg.get(next) - 1);
            if (inDeg.get(next) === 0) q.push(next);
        }
    }
    if (order.length !== inDeg.size) return null; // cycle
    return order;
}

function collectRefPaths(value, out) {
    if (value == null) return;
    if (Array.isArray(value)) { value.forEach(v => collectRefPaths(v, out)); return; }
    if (typeof value !== 'object') return;
    if (typeof value.kind === 'string') {
        if (value.kind === 'ref' && typeof value.path === 'string') out.push({ kind: 'ref', path: value.path });
        if (value.kind === 'template' && typeof value.value === 'string') {
            const re = /\{\{\s*([^}]+?)\s*\}\}/g;
            let m; while ((m = re.exec(value.value))) out.push({ kind: 'ref', path: m[1].trim() });
        }
        if (value.kind === 'expr' && typeof value.value === 'string') {
            out.push({ kind: 'expr', src: value.value });
        }
        // literal: nothing
        return;
    }
    for (const k of Object.keys(value)) collectRefPaths(value[k], out);
}

/**
 * Collect `kind:'literal'` string values that contain `{{…}}` placeholders.
 * Only `kind:'template'` values are interpolated at runtime (see bind.js), so
 * a literal carrying `{{…}}` ships the braces verbatim — almost always a
 * mistake. Pushes the offending strings onto `out`.
 */
function collectLiteralBraces(value, out) {
    if (value == null) return;
    if (Array.isArray(value)) { value.forEach(v => collectLiteralBraces(v, out)); return; }
    if (typeof value !== 'object') return;
    if (typeof value.kind === 'string') {
        if (value.kind === 'literal' && typeof value.value === 'string' && /\{\{[^}]+\}\}/.test(value.value)) {
            out.push(value.value);
        }
        return;
    }
    for (const k of Object.keys(value)) collectLiteralBraces(value[k], out);
}

function rootOf(path) {
    const m = String(path).match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
    return m ? m[1] : null;
}

/**
 * Pick the closest candidate id to `target` by Levenshtein distance —
 * used to suggest "did you mean" in validation errors when an LLM
 * fabricates a step id like "step_1" that doesn't exist.
 */
function pickClosestId(target, candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    let best = null;
    let bestDist = Infinity;
    for (const c of candidates) {
        const d = levenshtein(String(target), String(c));
        if (d < bestDist) { bestDist = d; best = c; }
    }
    // Only suggest when the distance is short enough that the suggestion
    // is actually useful — otherwise return the first candidate as a hint
    // so the LLM at least sees a real id.
    if (bestDist <= Math.max(3, Math.floor(String(target).length / 2))) return best;
    return candidates[0];
}

function levenshtein(a, b) {
    if (a === b) return 0;
    const al = a.length, bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;
    const v0 = new Array(bl + 1);
    const v1 = new Array(bl + 1);
    for (let j = 0; j <= bl; j++) v0[j] = j;
    for (let i = 0; i < al; i++) {
        v1[0] = i + 1;
        for (let j = 0; j < bl; j++) {
            const cost = a[i] === b[j] ? 0 : 1;
            v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
        }
        for (let j = 0; j <= bl; j++) v0[j] = v1[j];
    }
    return v1[bl];
}

function secondSegment(path) {
    const m = String(path).match(/^[A-Za-z_$][A-Za-z0-9_$]*\.([A-Za-z_$][A-Za-z0-9_$]*)/);
    return m ? m[1] : null;
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
 *   path        — JSON-pointer-ish path into the def (e.g. 'steps[3].expr')
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
function validateDefinition(def, { availableTools = null, toolRequiredParams = null, deliverableEvents = null } = {}) {
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
    if (!isObject(def.trigger)) pushE({ code: 'trigger.missing', severity: 'error', path: 'trigger', message: 'Missing or invalid `trigger`.', hint: 'Call builder_propose_trigger before adding any steps.' });
    if (!Array.isArray(def.steps)) pushE({ code: 'steps.not_array', severity: 'error', path: 'steps', message: '`steps` must be an array.', hint: 'Initialise the draft via builder_propose_trigger so the shape is correct.' });
    if (!Array.isArray(def.edges)) pushE({ code: 'edges.not_array', severity: 'error', path: 'edges', message: '`edges` must be an array.', hint: 'Initialise the draft via builder_propose_trigger so the shape is correct.' });
    if (errors.length) return { ok: false, errors, warnings };

    // Trigger — ensure it has an id and a kind.
    const trigger = def.trigger;
    if (!trigger.id || typeof trigger.id !== 'string') pushE({ code: 'trigger.id_missing', severity: 'error', path: 'trigger.id', message: 'trigger.id is required.', hint: 'Re-run builder_propose_trigger; it generates a stable id.' });
    if (!trigger.kind || typeof trigger.kind !== 'string') pushE({ code: 'trigger.kind_missing', severity: 'error', path: 'trigger.kind', message: 'trigger.kind is required.', hint: 'Use one of: schedule, manual, webhook, app_event, agent_call.' });
    validatePosition(trigger.position, 'trigger', pushE);

    // Deliverability warning (opt-in): an app_event trigger whose event has no
    // producer on this install — neither a triggerBus poller nor a connector
    // push subscription — will activate but never fire. Non-blocking: push-only
    // events are deliverable on connector installs but not OAuth-only ones, so
    // we warn rather than block.
    if (deliverableEvents && trigger.kind === 'app_event') {
        const prov = trigger.appEvent?.provider;
        const ev = trigger.appEvent?.event;
        const set = prov && deliverableEvents[prov];
        if (set && ev && !set.has(ev)) {
            pushW({ code: 'trigger.app_event_undeliverable', severity: 'warning', path: 'trigger.appEvent.event', message: `Trigger event "${prov}.${ev}" has no delivery path on this install — it will activate but may never fire.`, hint: 'Pick an event that has a poller or is pushed by the connector, or add a producer for this event before relying on it.' });
        }
    }

    // Steps — unique ids, valid types.
    const ids = new Set([trigger.id]);
    const stepById = new Map();
    if (trigger.id) stepById.set(trigger.id, trigger);
    for (let i = 0; i < def.steps.length; i++) {
        const s = def.steps[i];
        const at = `steps[${i}]`;
        if (!isObject(s)) { pushE({ code: 'step.not_object', severity: 'error', path: at, message: 'Each step must be an object.', hint: 'Remove the malformed entry and add a fresh step via builder_add_*.' }); continue; }
        if (!s.id || typeof s.id !== 'string') { pushE({ code: 'step.id_missing', severity: 'error', path: at + '.id', message: 'Each step needs an `id`.', hint: 'Use the id returned from the previous builder_add_* tool result.' }); continue; }
        if (ids.has(s.id)) { pushE({ code: 'step.id_duplicate', severity: 'error', path: at + '.id', message: `Duplicate step id: ${s.id}`, hint: 'Remove the duplicate or call builder_remove_step on one of them.' }); continue; }
        if (!VALID_STEP_TYPES.has(s.type)) { pushE({ code: 'step.unknown_type', severity: 'error', path: at + '.type', message: `Step ${s.id}: unknown type "${s.type}".`, hint: `Use one of: ${[...VALID_STEP_TYPES].join(', ')}.` }); continue; }
        validatePosition(s.position, at, pushE);
        ids.add(s.id);
        stepById.set(s.id, s);
    }

    // Edges — reference known nodes.
    for (let i = 0; i < def.edges.length; i++) {
        const e = def.edges[i];
        const at = `edges[${i}]`;
        if (!isObject(e) || !e.from || !e.to) { pushE({ code: 'edge.shape', severity: 'error', path: at, message: 'Each edge needs `from` and `to`.', hint: 'Re-add the edge via the relevant builder_add_* tool which fills both fields.' }); continue; }
        if (!ids.has(e.from)) pushE({ code: 'edge.unknown_from', severity: 'error', path: at + '.from', message: `Edge from unknown node: ${e.from}`, hint: 'Either remove the edge or add the missing step.' });
        if (!ids.has(e.to))   pushE({ code: 'edge.unknown_to',   severity: 'error', path: at + '.to',   message: `Edge to unknown node: ${e.to}`,   hint: 'Either remove the edge or add the missing step.' });
    }
    if (errors.length) return { ok: false, errors, warnings };

    // DAG check.
    const nodes = Array.from(ids);
    const order = topoOrder(nodes, def.edges);
    if (!order) pushE({ code: 'graph.cycle', severity: 'error', path: 'edges', message: 'Definition contains a cycle.', hint: 'Inspect the edges array; remove the back-edge that closes the loop.' });
    if (errors.length) return { ok: false, errors, warnings };

    // Per-step validation + reference scoping (top-level only; loop bodies
    // are validated within their own scope below).
    const seenSoFar = new Set([trigger.id]); // outputs available
    for (const id of order) {
        const step = stepById.get(id);
        if (!step) continue;
        if (step.id === trigger.id) continue;
        const at = `steps[${id}]`;

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
            const out = def.edges.filter(e => e.from === step.id);
            const labels = new Set(out.map(e => e.label));
            if (!labels.has('then') && !labels.has('else')) {
                pushE({ code: 'condition.dead_branch', severity: 'error', path: at + '.edges', message: `Step ${step.id}: condition has no 'then' or 'else' edges — both branches dead-end.`, hint: 'Pass thenStepId and/or elseStepId on the condition, or use builder_add_* with afterStepId set to this condition id and an explicit edge label.' });
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
        if (step.type === 'code') {
            if (!step.code || typeof step.code !== 'string') pushE({ code: 'code.code_missing', severity: 'error', path: at + '.code', message: `Step ${step.id}: code step requires \`code\`.`, hint: 'Provide the JS source as a string.' });
            if (step.language && step.language !== 'javascript') pushE({ code: 'code.language_unsupported', severity: 'error', path: at + '.language', message: `Step ${step.id}: only language: 'javascript' supported.`, hint: 'Either omit `language` or set it to "javascript".' });
        }
        if (step.type === 'notification') {
            if (!step.title && !step.body) pushE({ code: 'notification.empty', severity: 'error', path: at, message: `Step ${step.id}: notification needs at least \`title\` or \`body\`.`, hint: 'Provide one (or both) so the user has something to read.' });
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
                const out = def.edges.filter(e => e.from === step.id);
                const caseLabels = new Set(out.map(e => e.caseName).filter(Boolean));
                const wired = step.cases.filter(c => caseLabels.has(c.name)).length;
                if (wired === 0) pushE({ code: 'switch.no_branches', severity: 'error', path: at + '.edges', message: `Step ${step.id}: switch has no case edges wired — all branches dead-end.`, hint: 'Add edges from this switch with caseName matching each case.' });
                else if (wired < step.cases.length) pushW({ code: 'switch.partial_branches', severity: 'warning', path: at + '.edges', message: `Step ${step.id}: only ${wired}/${step.cases.length} switch cases have outgoing edges.`, hint: 'Wire each case to its next step, or remove unused cases.' });
            }
        }
        // Phase B: collection ops — every type takes `arrayRef`.
        if (step.type === 'filter' || step.type === 'limit' || step.type === 'dedupe' || step.type === 'aggregate' || step.type === 'summarize') {
            if (!step.arrayRef || typeof step.arrayRef !== 'string') pushE({ code: `${step.type}.arrayRef_missing`, severity: 'error', path: at + '.arrayRef', message: `Step ${step.id}: ${step.type} requires \`arrayRef\`.`, hint: 'Bind to an upstream array, e.g. `steps.<id>.output.items`.' });
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
        // a step that has run before this one.
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
        if (step.type === 'set') collectRefPaths(step.fields, refs);
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

    return { ok: errors.length === 0, errors, warnings };
}

module.exports = { validateDefinition, topoOrder };
