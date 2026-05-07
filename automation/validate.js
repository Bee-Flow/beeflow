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
]);

function isObject(x) { return x && typeof x === 'object' && !Array.isArray(x); }

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

function rootOf(path) {
    const m = String(path).match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
    return m ? m[1] : null;
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
 */
function validateDefinition(def, { availableTools = null } = {}) {
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
    if (!trigger.kind || typeof trigger.kind !== 'string') pushE({ code: 'trigger.kind_missing', severity: 'error', path: 'trigger.kind', message: 'trigger.kind is required.', hint: 'Use one of: schedule, manual, webhook, app_event.' });

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

        // Reference scoping — collect all ref paths used in this step's
        // inputs / prompt / expr / template fields, ensure their roots
        // resolve to known sources, and any "steps.<id>.output" is for
        // a step that has run before this one.
        const refs = [];
        collectRefPaths(step.inputs, refs);
        if (step.type === 'ai_step') collectRefPaths({ kind: 'template', value: step.prompt || '' }, refs);
        if (step.type === 'notification') {
            collectRefPaths({ kind: 'template', value: step.title || '' }, refs);
            collectRefPaths({ kind: 'template', value: step.body || '' }, refs);
        }
        if (step.type === 'condition') refs.push({ kind: 'expr', src: step.expr || '' });
        if (step.type === 'loop' && step.overRef) refs.push({ kind: 'ref', path: step.overRef });

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
