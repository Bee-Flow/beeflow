/**
 * Catalog renderers for the builder system prompt (§WS5, extracted verbatim
 * from builderPrompt.js). Pure functions; lazy-require outputSchemas.
 */

function renderCatalog(catalog) {
    const { describeShape, producesList } = require('../outputSchemas');
    const apps = (catalog?.apps || [])
        .filter(a => a.available && a.actions.length)
        .map(a => {
            const actions = a.actions
                .map(act => {
                    const shape = describeShape(act.name);
                    const shapeNote = shape ? `\n      → output: ${shape}` : '';
                    // `[list]` flags actions whose output can be iterated with a
                    // per-step `forEach` (no wrapping loop). ~1 token; only on
                    // array-producing actions.
                    const listTag = producesList(act.name) ? ' [list]' : '';
                    return `  - ${act.name}${act.sideEffect ? ' [side-effect]' : ''}${listTag} — ${act.description?.split('\n')[0] || ''}${shapeNote}`;
                })
                .slice(0, 30) // cap so the prompt doesn't blow up
                .join('\n');
            return `### ${a.label} (${a.id})\n${actions}`;
        })
        .join('\n\n');
    return apps;
}

function renderCatalogLean(catalog) {
    // Strip output-shape annotations and action descriptions; small models
    // get tripped up by the volume. Just list app:action names.
    const apps = (catalog?.apps || [])
        .filter(a => a.available && a.actions.length)
        .map(a => {
            const actions = a.actions
                .slice(0, 20)
                .map(act => `  - ${act.name}${act.sideEffect ? ' [side-effect]' : ''}`)
                .join('\n');
            return `### ${a.label} (${a.id})\n${actions}`;
        })
        .join('\n\n');
    return apps;
}

/**
 * Slim catalog rendering used by BOTH prompt variants (§B progressive context).
 * Signals only that integrations exist — name, side-effect/[list] tags, a
 * one-line description, and an input COUNT — never the full input param schema
 * or the output shape. The agent fetches those on demand with
 * builder_inspect_tool right before binding. ~3-4x smaller than renderCatalog,
 * provider-agnostic (plain markdown).
 */
function renderCatalogSlim(catalog) {
    const { producesList } = require('../outputSchemas');
    const apps = (catalog?.apps || [])
        .filter(a => a.available && a.actions.length)
        .map(a => {
            const actions = a.actions
                .slice(0, 30) // cap so the prompt doesn't blow up
                .map(act => {
                    const props = act.inputSchema?.properties ? Object.keys(act.inputSchema.properties) : [];
                    const required = Array.isArray(act.inputSchema?.required) ? act.inputSchema.required : [];
                    const countTag = !props.length
                        ? 'no inputs'
                        : `${props.length} input${props.length === 1 ? '' : 's'}${required.length ? `, ${required.length} required` : ''}`;
                    const listTag = producesList(act.name) ? ' [list]' : '';
                    const desc = act.description?.split('\n')[0] || '';
                    return `  - ${act.name}${act.sideEffect ? ' [side-effect]' : ''}${listTag} — ${desc} (${countTag})`;
                })
                .join('\n');
            return `### ${a.label} (${a.id})\n${actions}`;
        })
        .join('\n\n');
    return apps;
}

module.exports = { renderCatalog, renderCatalogLean, renderCatalogSlim };
