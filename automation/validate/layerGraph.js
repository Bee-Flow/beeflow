/**
 * Cross-graph layer-reference validation (§WS5, extracted verbatim from
 * validate.js): the layer call graph must be acyclic and within the depth cap.
 */

const { topoOrder } = require('./helpers');
const { collectCallLayerSteps } = require('./callLayer');

// Mirrors automationRunner.MAX_LAYER_DEPTH — the runtime backstop.
const MAX_LAYER_DEPTH = 8;

/**
 * Cross-graph layer checks: the layer-reference graph (root + every layer
 * key, edges = call_layer references) must be acyclic and within the depth
 * cap; never-referenced layers get an orphan warning.
 */
const ROOT_NODE = '__root__';

function validateLayerGraph(def, layersMap, pushE, pushW) {
    const keys = Object.keys(layersMap);
    if (keys.length === 0) return;

    const nodes = [ROOT_NODE, ...keys];
    const refEdges = [];
    const addRefs = (graph, fromNode) => {
        for (const { step } of collectCallLayerSteps(graph)) {
            if (step.layerKey && layersMap[step.layerKey]) {
                refEdges.push({ from: fromNode, to: step.layerKey });
            }
        }
    };
    addRefs(def, ROOT_NODE);
    for (const k of keys) addRefs(layersMap[k], k);

    const order = topoOrder(nodes, refEdges);
    if (!order) {
        pushE({ code: 'layers.cycle', severity: 'error', path: 'layers', message: 'Layers reference each other in a cycle (e.g. A → B → A).', hint: 'Break the cycle — a layer may call sibling layers, but the call chain must not loop back.' });
    } else {
        // Longest-chain depth via DP in topo order: root = 0, each layer hop
        // +1. Mirrors the runtime layerStack cap (MAX_LAYER_DEPTH nested
        // layer calls allowed; deeper chains throw at run time).
        const adj = new Map(nodes.map(n => [n, []]));
        for (const e of refEdges) adj.get(e.from).push(e.to);
        const depth = new Map(nodes.map(n => [n, 0]));
        for (const n of order) {
            for (const next of adj.get(n) || []) {
                depth.set(next, Math.max(depth.get(next) || 0, (depth.get(n) || 0) + 1));
            }
        }
        const maxDepth = Math.max(0, ...depth.values());
        if (maxDepth > MAX_LAYER_DEPTH) {
            pushE({ code: 'layers.depth_exceeded', severity: 'error', path: 'layers', message: `Layer call chain is ${maxDepth} levels deep — the maximum is ${MAX_LAYER_DEPTH}.`, hint: 'Flatten the composition: inline the deepest layers into their callers.' });
        }
    }

    // Orphans: keys never referenced from the root or any layer. Harmless
    // (never executed) but usually leftovers — surface them.
    const referenced = new Set(refEdges.map(e => e.to));
    for (const k of keys) {
        if (!referenced.has(k)) {
            pushW({ code: 'layers.orphaned', severity: 'warning', path: `layers.${k}`, message: `Layer "${k}" is never called by any call_layer step.`, hint: 'Add a call_layer step referencing it, or delete the layer.' });
        }
    }
}

module.exports = { validateLayerGraph, ROOT_NODE };
