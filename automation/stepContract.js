/**
 * Step contract helpers.
 *
 * A "Step" (UI name) is a kind='block' automation row whose definition is a
 * root-level Flowlet: a `layer_input` trigger (params) + a `layer_output` step
 * (fields). These pure helpers read that contract and the set of integrations
 * the Step touches, so the catalog/palette can show inputs/outputs and hide a
 * Step when the caller lacks one of its integrations.
 *
 * Intentionally dependency-light: only the tool→integration resolver is
 * required lazily, so this is safe to require from stores and routes.
 */

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

// Walk a graph's steps, descending into loop bodies and parallel branches —
// the same nesting validate.js/portability.js walk. Flat for everything else.
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

// Coarse fallback when the static tool→integration map can't resolve a tool.
function coarseIntegration(tool) {
    if (!tool) return null;
    if (tool.startsWith('nextcloud')) return 'nextcloud';
    if (tool.startsWith('gmail')) return 'gmail';
    if (tool.startsWith('drive')) return 'google-drive';
    if (tool.startsWith('gcal') || tool.startsWith('calendar')) return 'google-calendar';
    if (tool.startsWith('webpage')) return 'webpages';
    return String(tool).split('_')[0] || null;
}

/** The declared input params of a Step (root layer_input trigger). */
function stepParams(definition) {
    const params = definition?.trigger?.params;
    if (!Array.isArray(params)) return [];
    return params
        .filter(isObject)
        .map(p => ({ name: p.name, type: p.type || 'string', required: !!p.required, description: p.description || '' }))
        .filter(p => p.name);
}

/** The output field names a Step returns (its single layer_output step). */
function stepOutputFields(definition) {
    const out = (definition?.steps || []).find(s => s && s.type === 'layer_output');
    const fields = out && isObject(out.fields) ? out.fields : {};
    return Object.keys(fields);
}

/** Both halves of the contract in one call. */
function stepContract(definition) {
    return { params: stepParams(definition), outputFields: stepOutputFields(definition) };
}

/**
 * The set of integration ids a Step touches (every integration_action tool,
 * plus any app_event trigger provider — Steps normally have none). Walks the
 * root graph and any nested layers. Returns a sorted unique array.
 */
function requiredIntegrations(definition) {
    if (!isObject(definition)) return [];
    let resolveIntegration = null;
    try { ({ resolveIntegration } = require('../core/integrationToolMap')); } catch { /* optional */ }
    const ids = new Set();
    const provider = definition?.trigger?.appEvent?.provider;
    if (provider) ids.add(provider);
    const collect = (graph) => {
        walkSteps(graph?.steps, (s) => {
            if (s.type === 'integration_action' && s.tool) {
                const resolved = resolveIntegration ? resolveIntegration(s.tool) : null;
                const id = resolved?.integration || coarseIntegration(s.tool);
                if (id) ids.add(id);
            }
        });
    };
    collect(definition);
    if (isObject(definition.layers)) {
        for (const layer of Object.values(definition.layers)) collect(layer);
    }
    return [...ids].sort();
}

module.exports = { walkSteps, stepParams, stepOutputFields, stepContract, requiredIntegrations };
