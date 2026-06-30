/**
 * call_layer (inline Flowlet) collection + validation (§WS5, extracted verbatim
 * from validate.js).
 */

const { isObject, pickClosestId } = require('./helpers');

function collectCallLayerSteps(graph, pathPrefix = '') {
    const out = [];
    const walk = (steps, basePath) => {
        if (!Array.isArray(steps)) return;
        for (let i = 0; i < steps.length; i++) {
            const s = steps[i];
            if (!isObject(s)) continue;
            const at = `${basePath}[${i}]`;
            if (s.type === 'call_layer') out.push({ step: s, path: at });
            if (s.type === 'loop' && Array.isArray(s.body)) walk(s.body, `${at}.body`);
            if (s.type === 'parallel' && Array.isArray(s.branches)) {
                for (let b = 0; b < s.branches.length; b++) {
                    walk(s.branches[b], `${at}.branches[${b}]`);
                }
            }
        }
    };
    walk(graph?.steps, `${pathPrefix}steps`);
    return out;
}

/**
 * Validate a call_layer step against the root `layers` map. Run for every
 * call step (top-level AND inside loop bodies / parallel branches).
 */
function validateCallLayerStep(step, at, layers, pushE) {
    const stepId = step.id || '(no id)';
    if (!step.layerKey || typeof step.layerKey !== 'string') {
        if (step.layerId) {
            pushE({ code: 'call_layer.legacy_layerId', severity: 'error', path: at + '.layerId', message: `Step ${stepId}: call_layer carries a legacy \`layerId\` reference (layers are inline now).`, hint: 'This step predates the inline-layers migration (or was restored from an old version snapshot). Remove and re-add the call-layer node — or re-create the layer via builder_create_layer and point this step at its layerKey.' });
        } else {
            pushE({ code: 'call_layer.layerKey_missing', severity: 'error', path: at + '.layerKey', message: `Step ${stepId}: call_layer requires \`layerKey\`.`, hint: 'Pass the key of an entry in definition.layers (create one via builder_create_layer first).' });
        }
        return;
    }
    const keys = Object.keys(layers || {});
    const layer = (layers || {})[step.layerKey];
    if (!layer) {
        const suggestion = pickClosestId(step.layerKey, keys);
        pushE({
            code: 'call_layer.unknown_layer',
            severity: 'error',
            path: at + '.layerKey',
            message: `Step ${stepId}: refers to non-existent layer "${step.layerKey}".`,
            hint: suggestion
                ? `Did you mean "${suggestion}"? Available layer keys: ${keys.join(', ') || '(none yet)'}.`
                : `No layers exist yet — create one via builder_create_layer.`,
        });
        return;
    }
    if (step.inputs !== undefined && !isObject(step.inputs)) {
        pushE({ code: 'call_layer.inputs_shape', severity: 'error', path: at + '.inputs', message: `Step ${stepId}: call_layer.inputs must be an object map of {param: binding}.`, hint: 'Use { paramName: { kind: "ref", path: "..." }, ... }.' });
        return;
    }
    // Required-param check: every required layer param needs a binding.
    const params = Array.isArray(layer.trigger?.params) ? layer.trigger.params : [];
    const inputs = isObject(step.inputs) ? step.inputs : {};
    for (const param of params) {
        if (!param || !param.required || typeof param.name !== 'string') continue;
        const b = inputs[param.name];
        const absent = b === undefined || b === null;
        const emptyLiteral = isObject(b) && b.kind === 'literal'
            && (b.value === '' || b.value === undefined || b.value === null);
        if (absent || emptyLiteral) {
            pushE({ code: 'call_layer.param_missing', severity: 'error', path: at + '.inputs.' + param.name, message: `Step ${stepId}: layer "${step.layerKey}" requires input "${param.name}"${emptyLiteral ? ' but it is set to an empty value' : ''}.`, hint: `Bind "${param.name}" to an upstream field (kind:'ref'/'template') or set a non-empty literal.` });
        }
    }
}

module.exports = { collectCallLayerSteps, validateCallLayerStep };
