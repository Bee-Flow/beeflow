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

const REF_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[(?:[0-9]+|\*|"[^"]*"|'[^']*')\])*$/;

// Defensive deep-clone for binding values. Without this, an object literal
// in a definition (`{kind:'literal', value:{...}}`) would be returned by
// reference — a downstream step mutating its inputs would silently corrupt
// the definition's binding for every subsequent run. Primitives are
// returned as-is to keep the hot path cheap.
function cloneLiteral(value) {
    if (value === null || typeof value !== 'object') return value;
    try { return structuredClone(value); }
    catch { return JSON.parse(JSON.stringify(value)); }
}

/**
 * Tokenize a dotted/bracketed path into prop / index / wildcard tokens.
 * Returns null on a malformed path (unclosed bracket).
 */
function tokenizePath(path) {
    const tokens = [];
    let i = 0;
    let buf = '';
    const flush = () => { if (buf.length) { tokens.push({ type: 'prop', key: buf }); buf = ''; } };
    while (i < path.length) {
        const c = path[i];
        if (c === '.') { flush(); i++; continue; }
        if (c === '[') {
            flush();
            const close = path.indexOf(']', i);
            if (close < 0) return null;
            const raw = path.slice(i + 1, close);
            if (raw === '*') tokens.push({ type: 'wild' });
            else if (raw.startsWith('"') && raw.endsWith('"')) tokens.push({ type: 'prop', key: raw.slice(1, -1) });
            else if (raw.startsWith("'") && raw.endsWith("'")) tokens.push({ type: 'prop', key: raw.slice(1, -1) });
            else tokens.push({ type: 'prop', key: parseInt(raw, 10) });
            i = close + 1;
            continue;
        }
        buf += c;
        i++;
    }
    flush();
    return tokens;
}

/**
 * Resolve a token list against a value. A `[*]` wildcard maps the rest of
 * the path over each element of the current array and flattens the result
 * one level — so `steps.read.output.results[*].output.attachments` (each
 * element yielding an array) collapses into a single flat array of
 * attachments, which is exactly what a downstream "for each" needs.
 */
function resolveTokens(tokens, cur) {
    for (let t = 0; t < tokens.length; t++) {
        const tok = tokens[t];
        if (tok.type === 'wild') {
            if (!Array.isArray(cur)) return undefined;
            const rest = tokens.slice(t + 1);
            const out = [];
            for (const el of cur) {
                const m = resolveTokens(rest, el);
                if (m === undefined) continue;
                if (Array.isArray(m)) out.push(...m);
                else out.push(m);
            }
            return out;
        }
        if (cur == null) return undefined;
        cur = cur[tok.key];
    }
    return cur;
}

/**
 * Walk a dotted/bracketed path on an object. Used by both ref-resolution
 * and the inside of {{...}} templates. Tolerates undefined intermediates,
 * and supports `[*]` wildcards for flattening across arrays.
 */
function walkPath(path, root) {
    if (!path || typeof path !== 'string') return undefined;
    if (!REF_RE.test(path)) return undefined;
    const tokens = tokenizePath(path);
    if (!tokens) return undefined;
    return resolveTokens(tokens, root);
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
            return cloneLiteral(binding.value);
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
 * Interpolate a template string with {{ path }} segments. `undefined` and
 * `null` paths render as the empty string (callers historically depend on
 * this — e.g. notification bodies and prompt prefixes). To make the silent
 * failure mode discoverable, when a path resolves to `undefined` we record
 * it on `runState._templateWarnings` (if the array exists) so the runner
 * can surface a per-run warning summary; `AUTOMATION_DEBUG_BINDINGS=1`
 * additionally logs to the server console.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.leaveUnresolved] — when true, a `{{token}}` whose
 *   path resolves to `undefined` is returned VERBATIM (braces and all)
 *   rather than blanked. Used for AI-step prompts so a literal `{{...}}`
 *   the builder typed (and any not-yet-available reference) isn't silently
 *   deleted from the instruction text. Default false keeps the historical
 *   blank-on-miss behaviour for notification/stop_error callers.
 */
function interpolateTemplate(template, runState, opts = {}) {
    const { leaveUnresolved = false } = opts;
    return String(template).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, path) => {
        const trimmed = path.trim();
        const v = walkPath(trimmed, runState);
        if (v === undefined) {
            if (runState && Array.isArray(runState._templateWarnings)) {
                runState._templateWarnings.push(trimmed);
            }
            if (process.env.AUTOMATION_DEBUG_BINDINGS) {
                console.warn(`[bind] template path "${trimmed}" resolved to undefined`);
            }
            return leaveUnresolved ? whole : '';
        }
        return v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    });
}

module.exports = { resolveValue, resolveDeep, resolveInputs, walkPath, interpolateTemplate, cloneLiteral };
