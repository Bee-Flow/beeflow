/**
 * Pure helper utilities for automation definition validation (§WS5).
 *
 * Extracted from validate.js so the orchestrator (validateGraph/validateDefinition)
 * stays focused on the rules rather than the graph/string plumbing. These are all
 * pure functions with no shared state — they take their inputs and return a value
 * or push onto a caller-supplied array.
 */

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

function secondSegment(path) {
    const m = String(path).match(/^[A-Za-z_$][A-Za-z0-9_$]*\.([A-Za-z_$][A-Za-z0-9_$]*)/);
    return m ? m[1] : null;
}

module.exports = {
    isObject,
    validatePosition,
    topoOrder,
    collectRefPaths,
    collectLiteralBraces,
    rootOf,
    levenshtein,
    pickClosestId,
    secondSegment,
};
