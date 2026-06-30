'use strict';

/**
 * Automation import/export — the WS6 portability layer.
 *
 *   buildExport(automation)  → { envelope, warnings }
 *   sanitizeImport(envelope) → { automation, errors }
 *   rekeyDefinition(def)     → { definition, renameMap }
 *
 * All three are PURE (no DB, no network) so routes/automation.js stays the
 * only place with side effects and the functions are trivially testable.
 *
 * Export is an ALLOWLIST copy: only { title, description, triggerType,
 * scheduleCron, scheduleTz, definition } ever leave the server. Row ids,
 * userId/organizationId, builderSession (the full AI-chat transcript!),
 * createdFromChatId, run-lock columns, version counters and webhook rows are
 * deliberately never serialized. Pinned step outputs (`step.pinnedOutput`,
 * n8n-style captured live data) are stripped from the definition — they're
 * snapshots of THIS user's data and would otherwise ride into someone else's
 * install; each removal is reported in the returned warnings array.
 *
 * Import mirrors the allowlist (unknown fields are silently dropped) and
 * gates on the envelope format/schemaVersion. Step ids are re-keyed on
 * import (rekeyDefinition) so a file imported twice — or a file crafted to
 * collide with existing drafts — always lands with fresh ids.
 *
 * Inline layers (definition.layers) ride along naturally in the definition.
 * Re-keying runs PER GRAPH: the root document and every layers[key]
 * mini-definition get independent rename maps, because bindings inside a
 * layer reference same-layer step ids (see validate.js validateGraph). Layer
 * KEYS are stable identifiers (call_layer.layerKey) and stay unchanged.
 */

const crypto = require('crypto');

const EXPORT_FORMAT = 'beeflow.automation';
const EXPORT_SCHEMA_VERSION = 1;

function isObject(x) { return x && typeof x === 'object' && !Array.isArray(x); }

function deepClone(value) {
    if (value === null || typeof value !== 'object') return value;
    try { return structuredClone(value); }
    catch { return JSON.parse(JSON.stringify(value)); }
}

// ── Step walking (shared) ───────────────────────────────
//
// Steps nest inside loop bodies and parallel branches (same shapes
// validate.js collectCallLayerSteps walks); everything else is flat.

function walkSteps(steps, fn) {
    if (!Array.isArray(steps)) return;
    for (const s of steps) {
        if (!isObject(s)) continue;
        fn(s);
        if (s.type === 'loop') walkSteps(s.body, fn);
        if (s.type === 'parallel' && Array.isArray(s.branches)) {
            for (const branch of s.branches) walkSteps(branch, fn);
        }
    }
}

// ── Export ──────────────────────────────────────────────

/**
 * Strip `pinnedOutput` from every step of every graph (root + layers),
 * recording a warning per removal. Mutates `def`; returns nothing.
 */
function stripPinnedOutputs(def, warnings) {
    const stripGraph = (graph, layerKey) => {
        walkSteps(graph?.steps, (s) => {
            if (s.pinnedOutput === undefined) return;
            delete s.pinnedOutput;
            const where = layerKey ? ` (layer "${layerKey}")` : '';
            warnings.push(`Removed pinned output from step "${s.id || '(no id)'}"${where} — pinned data is captured from live runs and is not portable.`);
        });
    };
    stripGraph(def, null);
    if (isObject(def.layers)) {
        for (const [key, layer] of Object.entries(def.layers)) {
            if (isObject(layer)) stripGraph(layer, key);
        }
    }
}

/**
 * Build the export envelope for one automation row (the camelCase shape
 * automationStore.rowToAutomation returns).
 *
 * @returns {{ envelope: object, warnings: string[] }} — `warnings` lists
 *          non-blocking removals (today: stripped pinned outputs).
 */
function buildExport(automation) {
    const src = isObject(automation) ? automation : {};
    const warnings = [];
    const definition = deepClone(isObject(src.definition) ? src.definition : {});
    stripPinnedOutputs(definition, warnings);
    const envelope = {
        format: EXPORT_FORMAT,
        schemaVersion: EXPORT_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        automation: {
            title: typeof src.title === 'string' ? src.title : '',
            description: typeof src.description === 'string' ? src.description : '',
            triggerType: typeof src.triggerType === 'string' ? src.triggerType : 'manual',
            scheduleCron: typeof src.scheduleCron === 'string' ? src.scheduleCron : null,
            scheduleTz: typeof src.scheduleTz === 'string' ? src.scheduleTz : null,
            definition,
        },
    };
    return { envelope, warnings };
}

// ── Import ──────────────────────────────────────────────

/**
 * Sanitize an uploaded import body. Accepts the full export envelope or a
 * bare `{ automation: {...} }` body (hand-built files). Returns
 * `{ automation, errors }` — `automation` is null whenever errors exist.
 *
 * The copy is allowlist-only: id/userId/organizationId/builderSession/
 * isActive/version/webhooks and any other field an older (or hostile) file
 * carries are dropped, never echoed into the create path.
 */
function sanitizeImport(envelope) {
    const errors = [];
    if (!isObject(envelope)) {
        return { automation: null, errors: ['Import body must be a JSON object.'] };
    }
    if (envelope.format !== undefined && envelope.format !== EXPORT_FORMAT) {
        errors.push(`Unknown format "${envelope.format}" — expected "${EXPORT_FORMAT}".`);
    }
    if (envelope.schemaVersion !== undefined && envelope.schemaVersion !== EXPORT_SCHEMA_VERSION) {
        if (typeof envelope.schemaVersion === 'number' && envelope.schemaVersion > EXPORT_SCHEMA_VERSION) {
            errors.push(`This file uses schemaVersion ${envelope.schemaVersion}, which is newer than this server supports (${EXPORT_SCHEMA_VERSION}). Update Bee Flow, or re-export the automation from a matching version.`);
        } else {
            errors.push(`Unsupported schemaVersion ${JSON.stringify(envelope.schemaVersion)} — expected ${EXPORT_SCHEMA_VERSION}.`);
        }
    }
    const src = isObject(envelope.automation) ? envelope.automation : null;
    if (!src) {
        errors.push('Missing `automation` object — expected a file produced by the automation Export action.');
    }
    if (errors.length > 0) return { automation: null, errors };

    const title = typeof src.title === 'string' ? src.title.trim() : '';
    if (!title) errors.push('automation.title must be a non-empty string.');
    if (!isObject(src.definition)) errors.push('automation.definition must be an object.');
    if (src.triggerType !== undefined && typeof src.triggerType !== 'string') {
        errors.push('automation.triggerType must be a string when present.');
    }
    if (src.scheduleCron !== undefined && src.scheduleCron !== null && typeof src.scheduleCron !== 'string') {
        errors.push('automation.scheduleCron must be a string or null.');
    }
    if (src.scheduleTz !== undefined && src.scheduleTz !== null && typeof src.scheduleTz !== 'string') {
        errors.push('automation.scheduleTz must be a string or null.');
    }
    if (errors.length > 0) return { automation: null, errors };

    return {
        automation: {
            title,
            description: typeof src.description === 'string' ? src.description : '',
            triggerType: (typeof src.triggerType === 'string' && src.triggerType.trim()) ? src.triggerType.trim() : 'manual',
            scheduleCron: (typeof src.scheduleCron === 'string' && src.scheduleCron.trim()) ? src.scheduleCron.trim() : null,
            scheduleTz: (typeof src.scheduleTz === 'string' && src.scheduleTz.trim()) ? src.scheduleTz.trim() : null,
            definition: deepClone(src.definition),
        },
        errors: [],
    };
}

// ── Re-keying ───────────────────────────────────────────
//
// Reference surfaces that carry step ids (enumerated from bind.js, expr.js
// and validate.js collectRefPaths):
//   - edges[].from / edges[].to and trigger.id
//   - binding wrappers anywhere in a step:  {kind:'ref', path:'steps.<id>…'},
//     {kind:'template', value:'…{{steps.<id>…}}…'}, {kind:'expr', value:'…'}
//   - bare ref-path strings:  loop.overRef, collection-op arrayRef
//     (filter/limit/dedupe/aggregate/summarize), datetime.input/.input2
//   - bare expr strings:      condition.expr, switch.expr, filter.expr
//   - bare template strings:  notification.title/.body, stop_error.message
//     (interpolateTemplate'd at run time — ai_step.prompt is NOT: the runner
//     passes it verbatim, its {{…}} placeholders name the step's own inputs)

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';
const PATH_HEAD_DOT_RE = new RegExp(`^steps\\.(${IDENT})([\\s\\S]*)$`);
const PATH_HEAD_BRACKET_RE = new RegExp(`^steps\\[(["'])(${IDENT})\\1\\]([\\s\\S]*)$`);
// In exprs `steps` may appear mid-string; the leading char class rejects
// `vars.steps.x` / `mysteps.x` lookalikes.
const EXPR_STEPS_DOT_RE = new RegExp(`(^|[^A-Za-z0-9_$.])steps\\.(${IDENT})`, 'g');
const EXPR_STEPS_BRACKET_RE = new RegExp(`(^|[^A-Za-z0-9_$.])steps\\[\\s*(["'])(${IDENT})\\2\\s*\\]`, 'g');

// Per-step-type bare string surfaces (everything else rides in binding
// wrappers which the deep walk below catches).
const REF_STRING_FIELDS = {
    loop: ['overRef'],
    filter: ['arrayRef'],
    limit: ['arrayRef'],
    dedupe: ['arrayRef'],
    aggregate: ['arrayRef'],
    summarize: ['arrayRef'],
    datetime: ['input', 'input2'],
};
const EXPR_STRING_FIELDS = {
    condition: ['expr'],
    switch: ['expr'],
    filter: ['expr'],
};
const TEMPLATE_STRING_FIELDS = {
    notification: ['title', 'body'],
    stop_error: ['message'],
};

/** Rewrite a whole ref-path string (`steps.<id>.output.x` / `steps["<id>"]…`). */
function rewritePath(path, map) {
    if (typeof path !== 'string') return path;
    let m = PATH_HEAD_DOT_RE.exec(path);
    if (m && map[m[1]]) return `steps.${map[m[1]]}${m[2]}`;
    m = PATH_HEAD_BRACKET_RE.exec(path);
    if (m && map[m[2]]) return `steps[${m[1]}${map[m[2]]}${m[1]}]${m[3]}`;
    return path;
}

/** Rewrite every `{{ … }}` body of a template string, preserving spacing. */
function rewriteTemplate(str, map) {
    return String(str).replace(/\{\{([^}]*)\}\}/g, (_, raw) => {
        const lead = /^\s*/.exec(raw)[0];
        const inner = raw.trim();
        const trail = raw.slice(lead.length + inner.length);
        return `{{${lead}${rewritePath(inner, map)}${trail}}}`;
    });
}

/**
 * Rewrite `steps.<id>` / `steps["<id>"]` lookups inside an expression while
 * leaving quoted string literals untouched (an expr like
 * `status == "steps.s1 failed"` must not have its message rewritten).
 * Quote/escape handling mirrors the expr.js tokenizer.
 */
function rewriteExpr(src, map) {
    if (typeof src !== 'string') return src;
    let out = '';
    let buf = '';
    const flush = () => {
        if (!buf) return;
        let seg = buf.replace(EXPR_STEPS_DOT_RE, (m, pre, id) => (map[id] ? `${pre}steps.${map[id]}` : m));
        seg = seg.replace(EXPR_STEPS_BRACKET_RE, (m, pre, q, id) => (map[id] ? `${pre}steps[${q}${map[id]}${q}]` : m));
        out += seg;
        buf = '';
    };
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '"' || c === "'") {
            flush();
            let j = i + 1;
            while (j < src.length && src[j] !== c) {
                if (src[j] === '\\' && j + 1 < src.length) j += 2;
                else j++;
            }
            out += src.slice(i, Math.min(j + 1, src.length));
            i = j + 1;
            continue;
        }
        buf += c;
        i++;
    }
    flush();
    return out;
}

/**
 * Deep-walk arbitrary structures rewriting binding wrappers in place.
 * Mirrors bind.js resolveDeep: only objects whose `kind` is one of the four
 * binding kinds are wrappers; `literal` payloads ship verbatim at run time,
 * so we leave them untouched too.
 */
function rewriteBindingsDeep(value, map) {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        for (const v of value) rewriteBindingsDeep(v, map);
        return;
    }
    if (typeof value.kind === 'string' && ['literal', 'ref', 'template', 'expr'].includes(value.kind)) {
        if (value.kind === 'ref' && typeof value.path === 'string') value.path = rewritePath(value.path, map);
        if (value.kind === 'template' && typeof value.value === 'string') value.value = rewriteTemplate(value.value, map);
        if (value.kind === 'expr' && typeof value.value === 'string') value.value = rewriteExpr(value.value, map);
        return;
    }
    for (const k of Object.keys(value)) rewriteBindingsDeep(value[k], map);
}

/**
 * Fresh id preserving the old id's readable prefix (`ai_3f2a1b` → `ai_…`,
 * builderTools newId idiom) so re-keyed graphs stay debuggable.
 */
function freshId(oldId, used) {
    const m = /^([A-Za-z][A-Za-z0-9]*)_/.exec(String(oldId));
    const prefix = m ? m[1]
        : (/^[A-Za-z][A-Za-z0-9]{0,7}$/.test(String(oldId)) ? String(oldId) : 's');
    let id;
    do { id = `${prefix}_${crypto.randomBytes(3).toString('hex')}`; } while (used.has(id));
    used.add(id);
    return id;
}

/** Rename one step (and its nested loop/parallel children) + rewrite its reference surfaces. */
function rekeyStep(step, map) {
    if (typeof step.id === 'string' && map[step.id]) step.id = map[step.id];

    // Bare string surfaces — handled by type so e.g. notification.body (a
    // template) is never confused with loop.body (nested steps).
    const handled = new Set(['id', 'type', 'layerKey', 'position']);
    for (const f of REF_STRING_FIELDS[step.type] || []) {
        if (typeof step[f] === 'string') step[f] = rewritePath(step[f], map);
        handled.add(f);
    }
    for (const f of EXPR_STRING_FIELDS[step.type] || []) {
        if (typeof step[f] === 'string') step[f] = rewriteExpr(step[f], map);
        handled.add(f);
    }
    for (const f of TEMPLATE_STRING_FIELDS[step.type] || []) {
        if (typeof step[f] === 'string') step[f] = rewriteTemplate(step[f], map);
        handled.add(f);
    }
    if (step.type === 'loop' && Array.isArray(step.body)) {
        for (const child of step.body) { if (isObject(child)) rekeyStep(child, map); }
        handled.add('body');
    }
    if (step.type === 'parallel' && Array.isArray(step.branches)) {
        for (const branch of step.branches) {
            if (!Array.isArray(branch)) continue;
            for (const child of branch) { if (isObject(child)) rekeyStep(child, map); }
        }
        handled.add('branches');
    }
    // Everything else (inputs, fields, cases, call_layer.inputs, …) may carry
    // binding wrappers at any depth.
    for (const k of Object.keys(step)) {
        if (!handled.has(k)) rewriteBindingsDeep(step[k], map);
    }
}

/**
 * Re-key ONE graph (root document or a layer mini-definition) in place.
 * Returns the oldId → newId map for the graph.
 */
function rekeyGraph(graph) {
    if (!isObject(graph)) return {};
    const oldIds = [];
    if (isObject(graph.trigger) && typeof graph.trigger.id === 'string' && graph.trigger.id) {
        oldIds.push(graph.trigger.id);
    }
    walkSteps(graph.steps, (s) => {
        if (typeof s.id === 'string' && s.id) oldIds.push(s.id);
    });
    // Seed `used` with the old ids so a fresh id can never alias a
    // not-yet-renamed step mid-rewrite.
    const used = new Set(oldIds);
    const map = {};
    for (const oldId of oldIds) {
        if (!map[oldId]) map[oldId] = freshId(oldId, used);
    }

    if (isObject(graph.trigger) && map[graph.trigger.id]) graph.trigger.id = map[graph.trigger.id];
    if (Array.isArray(graph.steps)) {
        for (const s of graph.steps) { if (isObject(s)) rekeyStep(s, map); }
    }
    if (Array.isArray(graph.edges)) {
        for (const e of graph.edges) {
            if (!isObject(e)) continue;
            if (typeof e.from === 'string' && map[e.from]) e.from = map[e.from];
            if (typeof e.to === 'string' && map[e.to]) e.to = map[e.to];
        }
    }
    // `vars` may carry binding wrappers referencing steps.
    if (isObject(graph.vars)) rewriteBindingsDeep(graph.vars, map);
    return map;
}

/**
 * Re-key a whole definition: fresh step ids for the root graph AND each
 * inline layer, each under its OWN rename map (a binding inside a layer
 * references same-layer ids, never root ids). Layer keys and
 * call_layer.layerKey references are left untouched.
 *
 * @returns {{ definition: object, renameMap: { root: object, layers: object } }}
 */
function rekeyDefinition(def) {
    const definition = deepClone(isObject(def) ? def : {});
    const renameMap = { root: rekeyGraph(definition), layers: {} };
    if (isObject(definition.layers)) {
        for (const [key, layer] of Object.entries(definition.layers)) {
            if (isObject(layer)) renameMap.layers[key] = rekeyGraph(layer);
        }
    }
    return { definition, renameMap };
}

module.exports = {
    EXPORT_FORMAT,
    EXPORT_SCHEMA_VERSION,
    buildExport,
    sanitizeImport,
    rekeyDefinition,
};
