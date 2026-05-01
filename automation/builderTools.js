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

function lastStepId(def) {
    if (def.steps.length === 0) return def.trigger.id;
    return def.steps[def.steps.length - 1].id;
}

// ── Tool schemas (injected to the LLM) ─────────────────

const TOOL_SCHEMAS = [
    {
        type: 'function',
        function: {
            name: 'builder_propose_trigger',
            description: 'Set the automation trigger. Call this first when starting a new draft.',
            parameters: {
                type: 'object',
                properties: {
                    kind: { type: 'string', enum: ['schedule', 'manual', 'webhook', 'app_event'] },
                    cron: { type: 'string', description: '5-field cron expression (when kind=schedule)' },
                    tz: { type: 'string', description: 'IANA timezone (when kind=schedule)' },
                    appProvider: { type: 'string', description: 'Provider id (when kind=app_event), e.g. gmail' },
                    appEvent: { type: 'string', description: 'Event name (when kind=app_event), e.g. mail.new' },
                    filter: { type: 'object', description: 'Optional filter object to match on payload (kind=app_event)' },
                },
                required: ['kind'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_action',
            description: 'Append an integration action step that calls a tool the user has connected.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string', description: 'Insert after this step id (default: last step)' },
                    tool: { type: 'string', description: 'Tool name from the catalog' },
                    inputs: { type: 'object', description: 'Map of input-name to binding ({kind:"literal"|"ref"|"template"|"expr",...})' },
                    label: { type: 'string' },
                },
                required: ['tool'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_ai_step',
            description: 'Append an AI reasoning step that processes upstream data. No tool calls allowed.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    prompt: { type: 'string', description: 'Prompt for the model' },
                    inputs: { type: 'object', description: 'Map of binding-name to {kind,...}' },
                    outputSchema: { type: 'object', description: 'Optional JSON schema; the runner will request structured output' },
                    modelTier: { type: 'string', enum: ['fast', 'standard', 'thinking'], description: 'Default: fast' },
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
            description: 'Append an if/else branch on a restricted JS expression.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    expr: { type: 'string', description: 'Expression like "steps.s1.output.amount > 1000"' },
                    thenStepId: { type: 'string' },
                    elseStepId: { type: 'string' },
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
            description: 'Append a for-each loop over an upstream array.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    overRef: { type: 'string', description: 'Path to the array, e.g. steps.s1.output.items' },
                    itemVar: { type: 'string', description: 'Variable name; available inside body as loop.<itemVar>' },
                    body: { type: 'array', description: 'Sub-DAG step objects (linear)' },
                    maxIterations: { type: 'integer', description: 'Cap, default 100' },
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
            description: 'Append a sandboxed JavaScript step. Use ONLY when no integration fits. Disabled when code is gated off.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    code: { type: 'string', description: 'JavaScript source. Define `function main(inputs, ctx)` for a clean entry-point.' },
                    inputs: { type: 'object' },
                    outputSchema: { type: 'object' },
                    allowedTools: { type: 'array', items: { type: 'string' }, description: 'Tools this step is allowed to call via ctx.integrations.<tool>(args).' },
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
            description: 'Append a notification step to deliver the result to the user.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    title: { type: 'string' },
                    body: { type: 'string', description: 'Supports {{steps.<id>.output.<path>}} interpolation' },
                    channels: { type: 'array', items: { type: 'string' } },
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
            description: 'Remove a step from the draft.',
            parameters: { type: 'object', properties: { stepId: { type: 'string' } }, required: ['stepId'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_set_metadata',
            description: 'Set the title and/or description of the automation.',
            parameters: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' } } },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_summarise',
            description: 'Return a deterministic plain-English summary of the current draft.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_request_dry_run',
            description: 'Run the current draft in dry-run mode and return the run record + per-step output. Use to preview before activating.',
            parameters: { type: 'object', properties: { triggerPayload: { type: 'object' } } },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_finalize',
            description: 'Mark the draft as finalised (still inactive). User must explicitly activate after seeing the dry-run.',
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
        inputs: args.inputs || {},
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
        inputs: args.inputs || {},
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
    const step = {
        id: newId('loop'),
        type: 'loop',
        overRef: args.overRef,
        itemVar: args.itemVar,
        body: Array.isArray(args.body) ? args.body : [],
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
        inputs: args.inputs || {},
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

// ── Public API ──────────────────────────────────────────

/**
 * Apply a tool call, mutating the in-memory draft. Returns a small JSON
 * report describing what changed (becomes the `tool` message back to the
 * LLM and feeds the SSE update to the frontend).
 */
async function applyToolCall(name, args, draftWrap) {
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
        case 'builder_request_dry_run': {
            const automation = await persistDraft(draftWrap);
            const runner = require('../core/automationRunner');
            const run = await runner.executeAutomation(automation, { triggerKind: 'dry_run', triggerPayload: args.triggerPayload || null, mode: 'dry_run' });
            const steps = await automationStore.getRunSteps(run.id);
            return { run, steps };
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
