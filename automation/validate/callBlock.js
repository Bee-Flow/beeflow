/**
 * call_block (reusable Step) collection + validation (§WS5, extracted verbatim
 * from validate.js).
 */

const { isObject, pickClosestId } = require('./helpers');

/**
 * Collect every call_block step in a graph, including those nested in loop
 * bodies / parallel branches. Mirror of collectCallLayerSteps for the
 * external-Step reference (a call_block points at a stored kind='block' row
 * by blockId rather than an inline layers key).
 */
function collectCallBlockSteps(graph, pathPrefix = '') {
    const out = [];
    const walk = (steps, basePath) => {
        if (!Array.isArray(steps)) return;
        for (let i = 0; i < steps.length; i++) {
            const s = steps[i];
            if (!isObject(s)) continue;
            const at = `${basePath}[${i}]`;
            if (s.type === 'call_block') out.push({ step: s, path: at });
            if (s.type === 'loop' && Array.isArray(s.body)) walk(s.body, `${at}.body`);
            if (s.type === 'parallel' && Array.isArray(s.branches)) {
                for (let b = 0; b < s.branches.length; b++) walk(s.branches[b], `${at}.branches[${b}]`);
            }
        }
    };
    walk(graph?.steps, `${pathPrefix}steps`);
    return out;
}

/**
 * Validate a call_block step. `availableBlocks` (optional) is a map
 * { blockId: { title, params:[{name,type,required}], outputFields:[...] } }
 * built from the caller's callable-Steps catalog. When provided, the blockId
 * must resolve and every required Step param must be bound; when absent (a
 * catalog-free pass, e.g. import), only structural checks run — same pattern
 * as availableTools for integration_action.
 */
function validateCallBlockStep(step, at, availableBlocks, pushE) {
    const stepId = step.id || '(no id)';
    if (!step.blockId || typeof step.blockId !== 'string') {
        pushE({ code: 'call_block.blockId_missing', severity: 'error', path: at + '.blockId', message: `Step ${stepId}: call_block requires \`blockId\`.`, hint: 'Pick a published Step from the palette (it sets blockId), or re-add the node.' });
        return;
    }
    if (step.inputs !== undefined && !isObject(step.inputs)) {
        pushE({ code: 'call_block.inputs_shape', severity: 'error', path: at + '.inputs', message: `Step ${stepId}: call_block.inputs must be an object map of {param: binding}.`, hint: 'Use { paramName: { kind: "ref", path: "..." }, ... }.' });
        return;
    }
    if (!availableBlocks) return; // catalog-free pass — structural only
    const block = availableBlocks[step.blockId];
    if (!block) {
        const keys = Object.keys(availableBlocks);
        const suggestion = pickClosestId(step.blockId, keys);
        pushE({ code: 'call_block.unknown_block', severity: 'error', path: at + '.blockId', message: `Step ${stepId}: refers to a Step that isn't available ("${step.blockId}").`, hint: suggestion ? `Did you mean "${suggestion}"?` : 'The Step may be unpublished, deleted, or not shared with you. Re-pick it from the palette.' });
        return;
    }
    const params = Array.isArray(block.params) ? block.params : [];
    const inputs = isObject(step.inputs) ? step.inputs : {};
    for (const param of params) {
        if (!param || !param.required || typeof param.name !== 'string') continue;
        const b = inputs[param.name];
        const absent = b === undefined || b === null;
        const emptyLiteral = isObject(b) && b.kind === 'literal' && (b.value === '' || b.value === undefined || b.value === null);
        if (absent || emptyLiteral) {
            pushE({ code: 'call_block.param_missing', severity: 'error', path: at + '.inputs.' + param.name, message: `Step ${stepId}: Step "${block.title || step.blockId}" requires input "${param.name}"${emptyLiteral ? ' but it is set to an empty value' : ''}.`, hint: `Bind "${param.name}" to an upstream field (kind:'ref'/'template') or set a non-empty literal.` });
        }
    }
}

module.exports = { collectCallBlockSteps, validateCallBlockStep };
