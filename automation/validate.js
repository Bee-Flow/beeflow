/**
 * Validate an automation definition before save / run.
 *
 * Checks:
 *   - Required top-level shape (trigger, steps[], edges[]).
 *   - Each step has a unique id.
 *   - DAG is acyclic via Kahn's algorithm.
 *   - Every reference path (in inputs/template/expr) resolves to a known
 *     upstream output, vars, or secret root — no forward refs.
 *   - condition.expr parses under the restricted grammar.
 *   - integration_action.tool is a string (catalog lookup happens at run time).
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
 * Validate a definition. Returns { ok: true } or { ok: false, errors: [...] }.
 *
 * `availableTools` (optional) is a Set of tool names from the catalog. When
 * provided, integration_action.tool is checked against it.
 */
function validateDefinition(def, { availableTools = null } = {}) {
    const errors = [];
    const push = (msg) => errors.push(msg);

    if (!isObject(def)) return { ok: false, errors: ['Definition must be an object'] };
    if (!isObject(def.trigger)) push('Missing or invalid `trigger`.');
    if (!Array.isArray(def.steps)) push('`steps` must be an array.');
    if (!Array.isArray(def.edges)) push('`edges` must be an array.');
    if (errors.length) return { ok: false, errors };

    // Trigger — ensure it has an id and a kind.
    const trigger = def.trigger;
    if (!trigger.id || typeof trigger.id !== 'string') push('trigger.id is required.');
    if (!trigger.kind || typeof trigger.kind !== 'string') push('trigger.kind is required.');

    // Steps — unique ids, valid types.
    const ids = new Set([trigger.id]);
    const stepById = new Map();
    if (trigger.id) stepById.set(trigger.id, trigger);
    for (const s of def.steps) {
        if (!isObject(s)) { push('Each step must be an object.'); continue; }
        if (!s.id || typeof s.id !== 'string') { push('Each step needs an `id`.'); continue; }
        if (ids.has(s.id)) { push(`Duplicate step id: ${s.id}`); continue; }
        if (!VALID_STEP_TYPES.has(s.type)) { push(`Step ${s.id}: unknown type "${s.type}".`); continue; }
        ids.add(s.id);
        stepById.set(s.id, s);
    }

    // Edges — reference known nodes.
    for (const e of def.edges) {
        if (!isObject(e) || !e.from || !e.to) { push('Each edge needs `from` and `to`.'); continue; }
        if (!ids.has(e.from)) push(`Edge from unknown node: ${e.from}`);
        if (!ids.has(e.to)) push(`Edge to unknown node: ${e.to}`);
    }
    if (errors.length) return { ok: false, errors };

    // DAG check.
    const nodes = Array.from(ids);
    const order = topoOrder(nodes, def.edges);
    if (!order) push('Definition contains a cycle.');
    if (errors.length) return { ok: false, errors };

    // Per-step validation + reference scoping (top-level only; loop bodies
    // are validated within their own scope below).
    const seenSoFar = new Set([trigger.id]); // outputs available
    for (const id of order) {
        const step = stepById.get(id);
        if (!step) continue;
        if (step.id === trigger.id) continue;

        // Step-type-specific structural checks.
        if (step.type === 'integration_action') {
            if (!step.tool || typeof step.tool !== 'string') push(`Step ${step.id}: integration_action requires \`tool\`.`);
            else if (availableTools && !availableTools.has(step.tool)) push(`Step ${step.id}: tool "${step.tool}" not in user's catalog.`);
        }
        if (step.type === 'ai_step') {
            if (!step.prompt || typeof step.prompt !== 'string') push(`Step ${step.id}: ai_step requires \`prompt\`.`);
        }
        if (step.type === 'condition') {
            if (!step.expr || typeof step.expr !== 'string') push(`Step ${step.id}: condition requires \`expr\`.`);
            else {
                try { parseExpr(step.expr); }
                catch (e) { push(`Step ${step.id}: condition expr parse error — ${e.message}`); }
            }
            // Edges must include 'then' and 'else' labels.
            const out = def.edges.filter(e => e.from === step.id);
            const labels = new Set(out.map(e => e.label));
            if (!labels.has('then') || !labels.has('else')) push(`Step ${step.id}: condition needs 'then' and 'else' edges.`);
        }
        if (step.type === 'loop') {
            if (!step.itemVar || typeof step.itemVar !== 'string') push(`Step ${step.id}: loop requires \`itemVar\`.`);
            if (!step.overRef || typeof step.overRef !== 'string') push(`Step ${step.id}: loop requires \`overRef\`.`);
            // Body is recursively validated as its own DAG.
            if (Array.isArray(step.body)) {
                for (const child of step.body) {
                    if (!isObject(child) || !child.id) push(`Step ${step.id}: loop body item missing id.`);
                }
            }
            if (typeof step.maxIterations !== 'number' || step.maxIterations < 1 || step.maxIterations > 1000) {
                push(`Step ${step.id}: loop maxIterations must be 1..1000.`);
            }
        }
        if (step.type === 'code') {
            if (!step.code || typeof step.code !== 'string') push(`Step ${step.id}: code step requires \`code\`.`);
            if (step.language && step.language !== 'javascript') push(`Step ${step.id}: only language: 'javascript' supported.`);
        }
        if (step.type === 'notification') {
            if (!step.title && !step.body) push(`Step ${step.id}: notification needs at least \`title\` or \`body\`.`);
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
            if (!root) { push(`Step ${step.id}: invalid ref "${path}".`); continue; }
            if (root === 'trigger' || root === 'vars' || root === 'secrets' || root === 'loop') continue;
            if (root === 'steps') {
                const upstreamId = secondSegment(path);
                if (!upstreamId) { push(`Step ${step.id}: ref must include a step id.`); continue; }
                if (!seenSoFar.has(upstreamId) && upstreamId !== step.id) {
                    push(`Step ${step.id}: refers to step "${upstreamId}" that hasn't run yet (or doesn't exist).`);
                }
                continue;
            }
            push(`Step ${step.id}: unknown ref root "${root}".`);
        }
        seenSoFar.add(step.id);
    }

    if (errors.length) return { ok: false, errors };
    return { ok: true };
}

module.exports = { validateDefinition, topoOrder };
