/**
 * Builder tools — function-calling schemas the conversational builder agent
 * uses to mutate a draft automation. Each tool has:
 *   - schema (OpenAI/Anthropic function-call format) injected into the LLM
 *   - apply() implementation that mutates a Draft instance and returns
 *     a small JSON snippet describing the change.
 *
 * Drafts are kept per (userId, builderSessionId) and persisted to
 * automations(is_draft=TRUE) after every successful mutation, so a
 * page refresh recovers the work.
 */

const crypto = require('crypto');
const automationStore = require('../stores/automationStore');
const { summariseDefinition } = require('./summarise');
const { validateDefinition } = require('./validate');
const { isSideEffect } = require('./sideEffectMap');

function newId(prefix = 's') { return `${prefix}_${crypto.randomBytes(3).toString('hex')}`; }

function emptyDefinition() {
    return {
        schemaVersion: 1,
        trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
        steps: [],
        edges: [],
        vars: {},
    };
}

/**
 * Coerce a step's inputs into canonical binding form.
 *
 * Tolerates the AI's common mistakes:
 *   - raw strings/numbers/booleans/arrays passed where a binding wrapper
 *     was expected → wrapped as { kind: 'literal', value: ... }
 *   - strings that look like template paths "{{...}}" → upgraded to template
 *   - already-canonical bindings → passed through unchanged
 *
 * Lossless: anything already valid keeps its shape. Anything ambiguous
 * defaults to literal so the runtime won't crash on bad refs.
 */
function canonicalizeInputs(inputs) {
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return {};
    const out = {};
    for (const [k, v] of Object.entries(inputs)) {
        out[k] = canonicalizeBinding(v);
    }
    return out;
}

function canonicalizeBinding(v) {
    // Already a binding wrapper — pass through.
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.kind === 'string'
        && ['literal', 'ref', 'template', 'expr'].includes(v.kind)) {
        return v;
    }
    // String containing {{...}} → template.
    if (typeof v === 'string' && /\{\{[^}]+\}\}/.test(v)) {
        return { kind: 'template', value: v };
    }
    // Anything else → literal. This is the safe, runtime-friendly choice.
    return { kind: 'literal', value: v };
}

function lastStepId(def) {
    if (def.steps.length === 0) return def.trigger.id;
    return def.steps[def.steps.length - 1].id;
}

// ── Tool schemas (injected to the LLM) ─────────────────

// ─── Binding format reminder for the AI ──────────────────────────
// Every input value MUST be one of these shapes (or a plain JSON literal,
// which is treated as { kind: 'literal', value: ... }):
//   { "kind": "literal",  "value": <any> }
//   { "kind": "ref",      "path":  "steps.s1.output.items[0].subject" }
//   { "kind": "template", "value": "Found {{steps.s1.output.count}} items" }
//   { "kind": "expr",     "value": "steps.s1.output.amount > 1000" }
const BINDING_HINT = 'Each input value must be a binding: {"kind":"literal","value":...} OR {"kind":"ref","path":"steps.<id>.output.<field>"} OR {"kind":"template","value":"... {{steps.x.output.y}} ..."} OR {"kind":"expr","value":"<restricted-js>"}.';

const TOOL_SCHEMAS = [
    {
        type: 'function',
        function: {
            name: 'builder_propose_trigger',
            description: 'Set or replace the automation trigger. ALWAYS call this first when starting a new draft. Cron uses standard 5-field syntax (minute hour dom month dow). EXAMPLES: weekly Monday 9am Europe/Amsterdam → {kind:"schedule",cron:"0 9 * * 1",tz:"Europe/Amsterdam"}. First Monday of the month → {kind:"schedule",cron:"0 9 1-7 * 1",tz:"Europe/Amsterdam"}. New Gmail event → {kind:"app_event",appProvider:"gmail",appEvent:"mail.new",filter:{label:"Invoices"}}.',
            parameters: {
                type: 'object',
                properties: {
                    kind: { type: 'string', enum: ['schedule', 'manual', 'webhook', 'app_event'] },
                    cron: { type: 'string', description: 'Standard 5-field cron, REQUIRED when kind=schedule. Use exact format: minute hour day-of-month month day-of-week. Example: "0 9 * * 1" = every Monday at 9:00.' },
                    tz: { type: 'string', description: 'IANA timezone, e.g. Europe/Amsterdam (when kind=schedule).' },
                    appProvider: { type: 'string', description: 'Provider id (when kind=app_event): gmail | google-calendar | msgraph | github' },
                    appEvent: { type: 'string', description: 'Event name (when kind=app_event), e.g. mail.new for Gmail.' },
                    filter: { type: 'object', description: 'Optional filter object that must shallowly match the event payload.' },
                },
                required: ['kind'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_action',
            description: `Append an integration action that calls a real connected tool. The tool name MUST match the catalog exactly. ${BINDING_HINT} EXAMPLE — search Gmail for unread invoices: {tool:"gmail_search",inputs:{query:{kind:"literal",value:"label:Invoices is:unread"},maxResults:{kind:"literal",value:20}},label:"Find invoices"}. EXAMPLE — read a specific email: {tool:"gmail_read",inputs:{messageId:{kind:"ref",path:"loop.email.id"}}}. NEVER pass plain strings as input values; ALWAYS wrap in {kind,...}.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string', description: 'Insert after this step id. Default: last step.' },
                    tool: { type: 'string', description: 'Exact tool name from the catalog (e.g. gmail_search, gmail_compose, calendar_create_event).' },
                    inputs: { type: 'object', description: `Map of input-name to a binding object. ${BINDING_HINT}` },
                    label: { type: 'string', description: 'Short human-readable label for the diagram.' },
                },
                required: ['tool'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_ai_step',
            description: `Append an AI reasoning step that transforms or summarises upstream data. No tool calls allowed inside an ai_step. Use this for: extracting structured fields from text, summarising, classifying, drafting reply text, etc. ${BINDING_HINT} EXAMPLE — extract invoice fields: {prompt:"Extract amount, currency, vendor, dueDate from this invoice email.",inputs:{emailBody:{kind:"ref",path:"loop.email.body"},emailSubject:{kind:"ref",path:"loop.email.subject"}},outputSchema:{type:"object",properties:{amount:{type:"number"},currency:{type:"string"},vendor:{type:"string"},dueDate:{type:"string"}}},modelTier:"fast"}.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    prompt: { type: 'string', description: 'The instruction for the AI. Reference the inputs by name.' },
                    inputs: { type: 'object', description: `Map of binding-name to a binding object. ${BINDING_HINT}` },
                    outputSchema: { type: 'object', description: 'JSON schema describing the desired structured output. Strongly recommended so downstream steps can reference fields.' },
                    modelTier: { type: 'string', enum: ['auto', 'fast', 'standard', 'thinking'], description: 'Default: fast. Use "thinking" only for complex multi-step reasoning.' },
                    label: { type: 'string' },
                },
                required: ['prompt'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_condition',
            description: 'Append an if/else branch. The expr is a restricted JS expression — supports member access, comparisons, &&, ||, ?:, math. NO function calls. EXAMPLES: "steps.parse.output.amount > 1000", "steps.s1.output.count == 0", "loop.email.subject == \\"Urgent\\"". After adding, call builder_add_action / builder_add_ai_step / builder_add_notification with afterStepId pointing to this condition\'s id to grow the "then" branch; the "else" branch is built by passing thenStepId/elseStepId on this same call.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    expr: { type: 'string', description: 'Restricted JS expression (no function calls).' },
                    thenStepId: { type: 'string', description: 'Optional id of an existing step to wire as the "then" branch.' },
                    elseStepId: { type: 'string', description: 'Optional id of an existing step to wire as the "else" branch.' },
                    label: { type: 'string' },
                },
                required: ['expr'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_loop',
            description: `Append a for-each loop over an upstream array. The body is a SUB-DAG of steps that runs once per item. Inside the body, refer to the current item as loop.<itemVar>. ${BINDING_HINT} EXAMPLE — for each invoice email, extract fields and create YouTrack issue: {overRef:"steps.search.output.items",itemVar:"email",maxIterations:50,body:[{type:"ai_step",prompt:"Extract amount and vendor.",inputs:{body:{kind:"ref",path:"loop.email.body"}}},{type:"integration_action",tool:"youtrack_create_issue",inputs:{summary:{kind:"template",value:"Invoice {{loop.email.subject}}"}}}]}. IMPORTANT: every body step MUST have a "type" field; the system will assign ids if missing.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    overRef: { type: 'string', description: 'Path to the array, e.g. steps.search.output.items.' },
                    itemVar: { type: 'string', description: 'Loop variable name; available inside body as loop.<itemVar>.' },
                    body: { type: 'array', description: 'Sub-DAG step objects (linear). Each must include "type". "id" is auto-assigned if missing.' },
                    maxIterations: { type: 'integer', description: 'Cap, default 100, max 1000.' },
                    label: { type: 'string' },
                },
                required: ['overRef', 'itemVar'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_code_step',
            description: 'Append a sandboxed JavaScript step. Use ONLY when no integration fits. Code receives `inputs` and `ctx` (with ctx.log, ctx.http, ctx.integrations.<tool>, ctx.secrets). Define `function main(inputs, ctx)` and return the result. Code is gated by org policy; only propose this when the catalog clearly lacks a fitting tool.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    code: { type: 'string', description: 'JavaScript source. Define `async function main(inputs, ctx) { ... return result; }`.' },
                    inputs: { type: 'object' },
                    outputSchema: { type: 'object' },
                    allowedTools: { type: 'array', items: { type: 'string' }, description: 'Tool names this step may call via ctx.integrations.<tool>(args).' },
                    label: { type: 'string' },
                },
                required: ['code'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_notification',
            description: `Append a notification step that delivers a result to the user. The title and body are TEMPLATES — interpolate upstream data with double curly braces. EXAMPLE: {title:"Monthly invoice report",body:"Found {{steps.search.output.count}} invoices totalling €{{steps.sum.output.total}}",channels:["notification"]}. For Gmail-delivered notifications, instead use builder_add_action with tool gmail_compose.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    title: { type: 'string', description: 'Template string. Supports {{steps.<id>.output.<path>}}.' },
                    body: { type: 'string', description: 'Template string. Supports {{steps.<id>.output.<path>}}.' },
                    channels: { type: 'array', items: { type: 'string' }, description: 'Default: ["notification"].' },
                    label: { type: 'string' },
                },
                required: ['title'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_remove_step',
            description: 'Remove a step from the draft by id, including its incident edges.',
            parameters: { type: 'object', properties: { stepId: { type: 'string' } }, required: ['stepId'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_set_metadata',
            description: 'Set the user-visible title and/or description for this automation.',
            parameters: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' } } },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_inspect_tool',
            description: 'Look up the EXACT output shape of an integration tool. Use this BEFORE adding actions whose output you need to chain — so you know whether the field is "results" or "items" or "events" without guessing. Returns a one-line shape descriptor (e.g. "results: array of { id, from, subject, ... }; total: integer") sourced from runtime samples when available, otherwise from the curated schema.',
            parameters: {
                type: 'object',
                properties: { tool: { type: 'string', description: 'Exact tool name from the catalog.' } },
                required: ['tool'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_summarise',
            description: 'Return a deterministic plain-English summary of the current draft. Call after every batch of mutations so the user sees what changed.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_request_dry_run',
            description: 'Execute the draft in dry-run mode. Side-effect actions are simulated (no real emails sent, no real issues created); read-only and AI steps run for real. Returns the run row + per-step output. ALWAYS dry-run after building a complete draft, then read the per-step output. If any step errored, fix it (remove_step + add_*) and dry-run again. Only after a clean dry-run should you call builder_finalize.',
            parameters: { type: 'object', properties: { triggerPayload: { type: 'object', description: 'Optional fake trigger payload (used to feed app_event triggers a sample).' } } },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_finalize',
            description: 'Mark the draft as finalised (is_draft=false). The automation remains INACTIVE until the user clicks Activate in the UI. Only call this after a successful dry-run.',
            parameters: { type: 'object', properties: {} },
        },
    },
];

// ── Apply mutations ─────────────────────────────────────

function applyTrigger(draft, args) {
    draft.trigger = { id: 'trg', type: 'trigger', kind: args.kind, output: {} };
    if (args.kind === 'schedule') draft.trigger.schedule = { cron: args.cron, tz: args.tz || 'Europe/Amsterdam' };
    if (args.kind === 'webhook') draft.trigger.webhook = {};
    if (args.kind === 'app_event') draft.trigger.appEvent = { provider: args.appProvider, event: args.appEvent, filter: args.filter || null };
    return { trigger: draft.trigger };
}

function appendAfter(draft, afterStepId, step) {
    const lastId = afterStepId || lastStepId(draft);
    draft.steps.push(step);
    draft.edges.push({ from: lastId, to: step.id });
    return step;
}

function applyAddAction(draft, args) {
    const step = {
        id: newId('a'),
        type: 'integration_action',
        tool: args.tool,
        inputs: canonicalizeInputs(args.inputs || {}),
        label: args.label || args.tool,
        sideEffect: isSideEffect(args.tool),
    };
    appendAfter(draft, args.afterStepId, step);
    return { added: step };
}

function applyAddAi(draft, args) {
    const step = {
        id: newId('ai'),
        type: 'ai_step',
        prompt: args.prompt,
        inputs: canonicalizeInputs(args.inputs || {}),
        outputSchema: args.outputSchema || null,
        modelTier: args.modelTier || 'fast',
        label: args.label || 'AI step',
        allowTools: false,
    };
    appendAfter(draft, args.afterStepId, step);
    return { added: step };
}

function applyAddCondition(draft, args) {
    const step = { id: newId('cond'), type: 'condition', expr: args.expr, label: args.label || 'Condition' };
    const lastId = args.afterStepId || lastStepId(draft);
    draft.steps.push(step);
    draft.edges.push({ from: lastId, to: step.id });
    if (args.thenStepId) draft.edges.push({ from: step.id, to: args.thenStepId, label: 'then' });
    if (args.elseStepId) draft.edges.push({ from: step.id, to: args.elseStepId, label: 'else' });
    return { added: step };
}

function applyAddLoop(draft, args) {
    // Sanitize child body steps: every child must have an id, type, and any
    // type-specific required fields. Missing ids would crash the runner with
    // a null step_id DB constraint.
    const rawBody = Array.isArray(args.body) ? args.body : [];
    const body = rawBody.map((child) => {
        if (!child || typeof child !== 'object') return null;
        const fixed = { ...child };
        if (!fixed.id || typeof fixed.id !== 'string') fixed.id = newId('lb');
        if (!fixed.type || typeof fixed.type !== 'string') fixed.type = 'ai_step';
        if (fixed.inputs) fixed.inputs = canonicalizeInputs(fixed.inputs);
        return fixed;
    }).filter(Boolean);

    const step = {
        id: newId('loop'),
        type: 'loop',
        overRef: args.overRef,
        itemVar: args.itemVar,
        body,
        maxIterations: args.maxIterations || 100,
        label: args.label || `Loop over ${args.overRef}`,
    };
    appendAfter(draft, args.afterStepId, step);
    return { added: step };
}

function applyAddCode(draft, args) {
    const step = {
        id: newId('code'),
        type: 'code',
        language: 'javascript',
        code: args.code,
        codeHash: crypto.createHash('sha256').update(args.code || '').digest('hex'),
        inputs: canonicalizeInputs(args.inputs || {}),
        outputSchema: args.outputSchema || null,
        allowedTools: Array.isArray(args.allowedTools) ? args.allowedTools : [],
        limits: { cpuMs: 1000, memoryMb: 64, wallMs: 5000 },
        label: args.label || 'Custom code',
    };
    appendAfter(draft, args.afterStepId, step);
    return { added: step };
}

function applyAddNotification(draft, args) {
    const step = {
        id: newId('notif'),
        type: 'notification',
        title: args.title,
        body: args.body || '',
        channels: Array.isArray(args.channels) ? args.channels : ['notification'],
        label: args.label || 'Notify',
    };
    appendAfter(draft, args.afterStepId, step);
    return { added: step };
}

function applyRemoveStep(draft, args) {
    const id = args.stepId;
    draft.steps = draft.steps.filter(s => s.id !== id);
    draft.edges = draft.edges.filter(e => e.from !== id && e.to !== id);
    return { removed: id };
}

function applySetMetadata(draft, args) {
    if (typeof args.title === 'string') draft.title = args.title;
    if (typeof args.description === 'string') draft.description = args.description;
    return { title: draft.title, description: draft.description };
}

function applySummarise(draft) {
    const { summary, hasSideEffects } = summariseDefinition(draft);
    return { summary, hasSideEffects };
}

async function applyInspectTool(args, draftWrap) {
    const tool = args && typeof args.tool === 'string' ? args.tool : null;
    if (!tool) return { error: 'tool name required' };
    const shapeCache = require('./shapeCache');
    const { describeShape, getOutputSchema } = require('./outputSchemas');

    // Prefer runtime-cached shape (the source of truth from real runs).
    let shapeHint = null;
    let source = 'curated';
    try {
        const cached = await shapeCache.getShape({ userId: draftWrap.userId, toolName: tool });
        if (cached) {
            shapeHint = shapeCache.renderShapeHint(cached);
            source = 'runtime';
        }
    } catch (_) {}
    if (!shapeHint) {
        shapeHint = describeShape(tool);
    }
    if (!shapeHint) {
        return { tool, shape: null, source: 'unknown', note: 'No declared schema and no runtime sample. Run the tool once via dry-run / live to learn its shape, or just bind defensively.' };
    }
    const schema = getOutputSchema(tool);
    return { tool, shape: shapeHint, source, sample: schema?.sample ?? null };
}

// ── Public API ──────────────────────────────────────────

/**
 * Apply a tool call, mutating the in-memory draft. Returns a small JSON
 * report describing what changed (becomes the `tool` message back to the
 * LLM and feeds the SSE update to the frontend).
 */
/**
 * Build a tiny summary of the current draft's step IDs so every mutation
 * result reminds the LLM of the exact ids it must use for downstream
 * `afterStepId` / refs / template paths. Without this the model
 * fabricated short ids like "step_1" that didn't exist in the draft —
 * the dry-run then ran with broken bindings and the AI had to spend
 * extra iterations un-tangling its own mistake.
 */
function summariseDraftSteps(draft) {
    const list = [];
    if (draft?.trigger?.id) list.push({ id: draft.trigger.id, type: 'trigger', kind: draft.trigger.kind });
    for (const s of (draft?.steps || [])) {
        list.push({
            id: s.id,
            type: s.type,
            tool: s.tool || undefined,
            label: s.label || undefined,
        });
    }
    return list;
}

const MUTATING_TOOLS = new Set([
    'builder_propose_trigger', 'builder_add_action', 'builder_add_ai_step',
    'builder_add_condition', 'builder_add_loop', 'builder_add_code_step',
    'builder_add_notification', 'builder_remove_step', 'builder_set_metadata',
]);

async function applyToolCall(name, args, draftWrap) {
    const result = await _applyToolCallRaw(name, args, draftWrap);
    // For every mutation, append a `_draftSteps` reminder so the LLM has
    // the live id list in front of it on the next turn. Tools that read
    // (summarise/inspect/dry_run/finalize) don't need this — their own
    // result is already the relevant shape.
    if (MUTATING_TOOLS.has(name) && result && typeof result === 'object' && !result.error) {
        result._draftSteps = summariseDraftSteps(draftWrap.def);
    }
    return result;
}

async function _applyToolCallRaw(name, args, draftWrap) {
    const draft = draftWrap.def;
    switch (name) {
        case 'builder_propose_trigger':    return applyTrigger(draft, args);
        case 'builder_add_action':         return applyAddAction(draft, args);
        case 'builder_add_ai_step':        return applyAddAi(draft, args);
        case 'builder_add_condition':      return applyAddCondition(draft, args);
        case 'builder_add_loop':           return applyAddLoop(draft, args);
        case 'builder_add_code_step':      return applyAddCode(draft, args);
        case 'builder_add_notification':   return applyAddNotification(draft, args);
        case 'builder_remove_step':        return applyRemoveStep(draft, args);
        case 'builder_set_metadata':       return applySetMetadata(draftWrap, args);
        case 'builder_summarise':          return applySummarise(draft);
        case 'builder_inspect_tool':       return applyInspectTool(args, draftWrap);
        case 'builder_request_dry_run': {
            const automation = await persistDraft(draftWrap);
            const runner = require('../core/automationRunner');
            const run = await runner.executeAutomation(automation, { triggerKind: 'dry_run', triggerPayload: args.triggerPayload || null, mode: 'dry_run' });
            const steps = await automationStore.getRunSteps(run.id);
            // Annotate each step with a top-level field hint so the AI
            // immediately sees what keys are available for binding.
            const shapeCache = require('./shapeCache');
            const annotated = steps.map(s => {
                const out = s.output;
                const topKeys = (out && typeof out === 'object' && !Array.isArray(out)) ? Object.keys(out) : null;
                const shapeHint = topKeys ? shapeCache.renderShapeHint(shapeCache.describeValue(out)) : null;
                return {
                    ...s,
                    _hint: {
                        outputType: Array.isArray(out) ? 'array' : (out === null ? 'null' : typeof out),
                        topKeys,
                        shape: shapeHint,
                    },
                };
            });
            return { run, steps: annotated };
        }
        case 'builder_finalize': {
            const automation = await persistDraft(draftWrap, { finalize: true });
            return { automation };
        }
        default:
            return { error: `Unknown builder tool: ${name}` };
    }
}

/**
 * Persist the draft to the automations table. Creates a row on the first
 * call and updates thereafter. Setting `finalize:true` flips is_draft to
 * false (still inactive — user must Activate explicitly).
 */
async function persistDraft(draftWrap, { finalize = false } = {}) {
    const def = draftWrap.def;
    const validation = validateDefinition(def);
    const triggerType = def.trigger?.kind || 'manual';
    const scheduleCron = def.trigger?.schedule?.cron || null;
    const scheduleTz = def.trigger?.schedule?.tz || 'Europe/Amsterdam';

    if (!draftWrap.automationId) {
        // Create a draft row.
        const a = await automationStore.createAutomation({
            userId: draftWrap.userId,
            organizationId: draftWrap.orgId || null,
            title: draftWrap.title || 'Untitled automation',
            description: draftWrap.description || '',
            definition: def,
            triggerType,
            scheduleCron,
            scheduleTz,
            createdFromChatId: draftWrap.builderSessionId,
        });
        draftWrap.automationId = a.id;
        if (finalize) {
            return automationStore.updateAutomation(a.id, { isDraft: false }, draftWrap.userId);
        }
        return a;
    }
    // Update existing draft row.
    const updates = {
        title: draftWrap.title || undefined,
        description: draftWrap.description || undefined,
        definition: def,
        triggerType,
        scheduleCron,
        scheduleTz,
    };
    if (finalize) updates.isDraft = false;
    const u = await automationStore.updateAutomation(draftWrap.automationId, updates, draftWrap.userId);
    if (!validation.ok) {
        // Persist anyway (it's a draft) but expose the errors to the caller.
        u.validationErrors = validation.errors;
    }
    return u;
}

module.exports = { TOOL_SCHEMAS, applyToolCall, persistDraft, emptyDefinition };
