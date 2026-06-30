/**
 * Webpage Plan Tool — propose_webpage_plan
 *
 * The AI calls this BEFORE making changes when the requested work is
 * non-trivial (new page, multi-file edits, big rewrites). The handler emits
 * a `webpage_plan_proposed` SSE event so the frontend can render an
 * approval card. Once the user clicks "Approve & build" the chat handler
 * injects an authorising message and the AI proceeds with the regular
 * webpage_file_* tools.
 *
 * Single-purpose module — keeps the tool definition + executor in one place
 * for reuse from both webpageChat.js and directChat.js.
 */

const crypto = require('crypto');

const PROPOSE_WEBPAGE_PLAN_TOOL = {
    type: 'function',
    function: {
        name: 'propose_webpage_plan',
        description: 'Propose a plan describing what files you intend to create/edit and why, BEFORE making any changes. Use this when the user asks for a brand-new page, a multi-file change, or any rewrite touching more than ~80 lines. Do NOT call any webpage_file_* / create_webpage tool in the same turn — the system will pause and wait for the user to approve. After approval the system injects a follow-up authorisation and you can then execute. For tiny, surgical edits, skip planning and edit directly.',
        parameters: {
            type: 'object',
            properties: {
                title: {
                    type: 'string',
                    description: 'Short headline for the plan, e.g. "Build tip calculator" or "Refactor hero section".',
                },
                summary: {
                    type: 'string',
                    description: '1-3 sentence overview of what you intend to do and why.',
                },
                steps: {
                    type: 'array',
                    description: 'Ordered list of file-level steps. 1-6 steps is typical.',
                    items: {
                        type: 'object',
                        properties: {
                            file: {
                                type: 'string',
                                description: 'The file this step touches: "html", "css" or "js" for the three primary slots, OR an extra file path like "src/App.jsx", "src/components/Header.jsx", or "modules/state.js".',
                            },
                            action: {
                                type: 'string',
                                enum: ['edit', 'create', 'rewrite'],
                                description: 'What kind of change this step is. Default to "edit" for any change to an existing file (it maps to partial-edit tools — webpage_file_replace / webpage_file_patch — which preserve surrounding content). Use "create" only for brand-new files. Use "rewrite" ONLY when you genuinely intend to throw away ≥80% of an existing file — that\'s rare; if in doubt, say "edit".',
                            },
                            why: {
                                type: 'string',
                                description: 'One sentence on what this step accomplishes.',
                            },
                            preview: {
                                type: 'string',
                                description: 'Optional short snippet (max ~400 chars) showing the gist of the change. Helpful for the user to spot anything wrong before approving.',
                            },
                        },
                        required: ['file', 'action', 'why'],
                    },
                },
            },
            required: ['title', 'summary', 'steps'],
        },
    },
};

/**
 * Execute the plan proposal. Returns a result envelope with `_action:
 * 'webpage_plan_proposed'` so the chat handler knows to:
 *   1. Emit a `webpage_plan_proposed` SSE event with the same payload
 *   2. Stop the tool loop for this turn (do NOT continue making LLM calls)
 *
 * The plan id is generated server-side so it's stable across the round-trip
 * and the frontend can use it as a React key + the approval payload key.
 */
/**
 * Normalise a plan step's `file`. Keeps the three primary slots verbatim and
 * passes any other value through as a literal extra-file path (trimmed, capped),
 * so react/multi-file plans like "src/App.jsx" survive instead of collapsing to
 * "html". Falls back to "html" only when nothing usable was provided.
 */
function sanitizePlanFile(file) {
    if (file === 'html' || file === 'css' || file === 'js') return file;
    const p = String(file || '').trim().replace(/^\/+/, '').slice(0, 240);
    return p || 'html';
}

function executeProposeWebpagePlan(args) {
    const title = String(args?.title || '').trim().slice(0, 200);
    const summary = String(args?.summary || '').trim().slice(0, 1000);
    const stepsRaw = Array.isArray(args?.steps) ? args.steps : [];

    if (!title) return { error: 'plan title is required.' };
    if (!summary) return { error: 'plan summary is required.' };
    if (stepsRaw.length === 0) return { error: 'plan must include at least one step.' };

    const steps = stepsRaw.slice(0, 8).map(s => {
        // Normalise legacy `partial_edit` to the new `edit` label so older
        // models still produce well-formed plans during the transition.
        let action = s?.action;
        if (action === 'partial_edit') action = 'edit';
        if (!['edit', 'create', 'rewrite'].includes(action)) action = 'edit';
        return {
            file: sanitizePlanFile(s?.file),
            action,
            why: String(s?.why || '').trim().slice(0, 400),
            preview: s?.preview ? String(s.preview).slice(0, 400) : undefined,
        };
    });

    const planId = crypto.randomUUID();
    const plan = { title, summary, steps };

    return {
        _action: 'webpage_plan_proposed',
        planId,
        plan,
        message: `Proposed plan "${title}" with ${steps.length} step${steps.length === 1 ? '' : 's'}. Awaiting user approval before executing.`,
    };
}

module.exports = {
    PROPOSE_WEBPAGE_PLAN_TOOL,
    executeProposeWebpagePlan,
};
