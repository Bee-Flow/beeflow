/**
 * Binding resolver for automation step inputs.
 *
 * Each step input is one of:
 *   { kind: 'literal',  value: <any> }
 *   { kind: 'ref',      path:  'steps.s1.output.items[0].subject' }
 *   { kind: 'template', value: 'Found {{steps.s1.output.count}} invoices' }
 *   { kind: 'expr',     value: 'steps.s1.output.amount > 1000 ? "high" : "low"' }
 *
 * Bare values (numbers/strings/booleans/arrays/objects without a `kind` field)
 * are treated as literals — this is a tolerance for hand-authored definitions
 * and AI-generated bindings that skip the wrapper.
 *
 * Roots available in runState:
 *   trigger.output, steps.<id>.output, loop.<itemVar>, vars, secrets
 *   (`secrets` is excluded from `template` bindings — see resolveValue.)
 */

const { evaluate } = require('./expr');

const REF_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[(?:[0-9]+|"[^"]*"|'[^']*')\])*$/;

/**
 * Walk a dotted/bracketed path on an object. Used by both ref-resolution
 * and the inside of {{...}} templates. Tolerates undefined intermediates.
 */
function walkPath(path, root) {
    if (!path || typeof path !== 'string') return undefined;
    if (!REF_RE.test(path)) return undefined;
    let cur = root;
    let i = 0;
    let buf = '';
    const flush = () => {
        if (buf.length === 0) return;
        cur = cur == null ? undefined : cur[buf];
        buf = '';
    };
    while (i < path.length) {
        const c = path[i];
        if (c === '.') { flush(); i++; continue; }
        if (c === '[') {
            flush();
            const close = path.indexOf(']', i);
            if (close < 0) return undefined;
            const raw = path.slice(i + 1, close);
            let key;
            if (raw.startsWith('"') && raw.endsWith('"')) key = raw.slice(1, -1);
            else if (raw.startsWith("'") && raw.endsWith("'")) key = raw.slice(1, -1);
            else key = parseInt(raw, 10);
            cur = cur == null ? undefined : cur[key];
            i = close + 1;
            continue;
        }
        buf += c;
        i++;
    }
    flush();
    return cur;
}

/**
 * Resolve a single binding object against the runState.
 * @param {*} binding — { kind, ... } or a raw literal
 * @param {object} runState — { trigger, steps, loop, vars, secrets }
 * @param {object} opts
 * @param {boolean} opts.allowSecrets — when false, secrets root is replaced
 *                  with an empty object so user-visible templates can't
 *                  echo secrets back to the chat or notification body.
 */
function resolveValue(binding, runState, opts = {}) {
    const { allowSecrets = false } = opts;
    const safeState = allowSecrets ? runState : { ...runState, secrets: {} };

    if (binding == null || typeof binding !== 'object' || Array.isArray(binding) || !binding.kind) {
        // Bare literal — but recursively resolve nested objects/arrays so
        // hand-built inputs like { to: 'a@b', body: { kind: 'ref', ... } }
        // still work.
        return resolveDeep(binding, runState, opts);
    }

    switch (binding.kind) {
        case 'literal':
            return binding.value;
        case 'ref':
            return walkPath(binding.path, safeState);
        case 'template':
            return interpolateTemplate(binding.value || '', safeState);
        case 'expr':
            try { return evaluate(binding.value, safeState); }
            catch (e) { return undefined; }
        default:
            return undefined;
    }
}

/**
 * Resolve every binding inside a structure (objects, arrays).
 */
function resolveDeep(structure, runState, opts = {}) {
    if (structure == null) return structure;
    if (Array.isArray(structure)) return structure.map(s => resolveDeep(s, runState, opts));
    if (typeof structure === 'object') {
        // If this object is itself a binding wrapper, resolve it.
        if (typeof structure.kind === 'string' && ['literal', 'ref', 'template', 'expr'].includes(structure.kind)) {
            return resolveValue(structure, runState, opts);
        }
        const out = {};
        for (const k of Object.keys(structure)) out[k] = resolveDeep(structure[k], runState, opts);
        return out;
    }
    return structure;
}

/**
 * Resolve a step's `inputs` map. Returns plain object with concrete values.
 */
function resolveInputs(inputs, runState, opts = {}) {
    if (!inputs || typeof inputs !== 'object') return {};
    const out = {};
    for (const k of Object.keys(inputs)) out[k] = resolveValue(inputs[k], runState, opts);
    return out;
}

/**
 * Interpolate a template string with {{ path }} segments.
 */
function interpolateTemplate(template, runState) {
    return String(template).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path) => {
        const v = walkPath(path.trim(), runState);
        return v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    });
}

module.exports = { resolveValue, resolveDeep, resolveInputs, walkPath, interpolateTemplate };
