/**
 * Human-readable diff between two automation definitions.
 *
 * Turns the raw JSON delta into plain phrases like "2 steps added",
 * "1 connection removed", "Description changed" — used both as the stored
 * per-version `change_summary` (automationStore) and, mirrored on the
 * frontend (Builder/diffSummary.js), as the primary content of the diff
 * modal. Keep the two implementations in sync by hand.
 *
 * Steps are matched by `id` (added / removed / changed); edges by their
 * from→to pair (added / removed); a handful of scalar/object fields are
 * reported as a single "X changed" phrase each. Order within `steps` /
 * `edges` is ignored — only membership and per-step content matter.
 */

function asArray(v) { return Array.isArray(v) ? v : []; }
function asObject(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
function plural(n, noun) { return `${n} ${noun}${n === 1 ? '' : 's'}`; }
function stableJson(v) {
    // Sorted-key stringify so a reordered-but-equal object isn't "changed".
    const sort = (x) => {
        if (Array.isArray(x)) return x.map(sort);
        if (x && typeof x === 'object') {
            const out = {};
            for (const k of Object.keys(x).sort()) out[k] = sort(x[k]);
            return out;
        }
        return x;
    };
    return JSON.stringify(sort(v ?? null));
}

function stepMap(def) {
    const m = new Map();
    for (const s of asArray(def.steps)) {
        if (s && s.id != null) m.set(String(s.id), s);
    }
    return m;
}
function edgeSet(def) {
    const s = new Set();
    for (const e of asArray(def.edges)) {
        if (e && e.from != null && e.to != null) s.add(`${e.from}→${e.to}`);
    }
    return s;
}

// Top-level definition fields surfaced as a single "X changed" phrase.
const FIELD_LABELS = [
    ['description', 'Description changed'],
    ['trigger', 'Trigger changed'],
    ['notificationSettings', 'Notification settings changed'],
    ['manualTriggerPayload', 'Manual trigger payload changed'],
    ['layers', 'Layers changed'],
];

/**
 * @returns {string[]} plain phrases describing prev → next (empty if equal)
 */
function summarizeDefinitionDiff(prevDef, nextDef) {
    const prev = asObject(prevDef);
    const next = asObject(nextDef);
    const phrases = [];

    // Steps (keyed by id)
    const prevSteps = stepMap(prev);
    const nextSteps = stepMap(next);
    let added = 0, removed = 0, changed = 0;
    for (const [id, s] of nextSteps) {
        if (!prevSteps.has(id)) added += 1;
        else if (stableJson(prevSteps.get(id)) !== stableJson(s)) changed += 1;
    }
    for (const id of prevSteps.keys()) if (!nextSteps.has(id)) removed += 1;
    if (added) phrases.push(`${plural(added, 'step')} added`);
    if (removed) phrases.push(`${plural(removed, 'step')} removed`);
    if (changed) phrases.push(`${plural(changed, 'step')} changed`);

    // Edges (connections)
    const prevEdges = edgeSet(prev);
    const nextEdges = edgeSet(next);
    let eAdded = 0, eRemoved = 0;
    for (const k of nextEdges) if (!prevEdges.has(k)) eAdded += 1;
    for (const k of prevEdges) if (!nextEdges.has(k)) eRemoved += 1;
    if (eAdded) phrases.push(`${plural(eAdded, 'connection')} added`);
    if (eRemoved) phrases.push(`${plural(eRemoved, 'connection')} removed`);

    // Scalar / object fields
    for (const [field, label] of FIELD_LABELS) {
        if (stableJson(prev[field]) !== stableJson(next[field])) phrases.push(label);
    }

    return phrases;
}

/**
 * One-line summary, e.g. "2 steps added · 1 connection removed".
 * Falls back to a "formatting only" note when nothing structural changed.
 */
function summarizeDefinitionDiffLine(prevDef, nextDef) {
    const phrases = summarizeDefinitionDiff(prevDef, nextDef);
    return phrases.length ? phrases.join(' · ') : 'No structural changes';
}

module.exports = { summarizeDefinitionDiff, summarizeDefinitionDiffLine };
