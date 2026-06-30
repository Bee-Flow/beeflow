/**
 * Deterministic plain-English summary of an automation definition.
 *
 * Used by the Builder agent's `summarise_draft` tool and rendered in the
 * UI so the user can read what the automation will do. No LLM call —
 * cheap, predictable, diffable across drafts. Side-effect lines start
 * with **bold** so the user notices what the automation will write.
 */

const { isSideEffect } = require('./sideEffectMap');

function describeTrigger(trigger) {
    if (!trigger) return 'When triggered';
    switch (trigger.kind) {
        case 'schedule': {
            const cron = trigger.schedule?.cron || '';
            const tz = trigger.schedule?.tz || 'Europe/Amsterdam';
            return `On schedule (\`${cron}\`, ${tz})`;
        }
        case 'manual': return 'When run manually';
        case 'webhook': return 'When the webhook URL is called';
        case 'agent_call': {
            const name = trigger.toolName || `automation_${trigger.id || ''}`;
            return `When an AI agent calls it (\`${name}\`)`;
        }
        case 'app_event': {
            const provider = trigger.appEvent?.provider || 'app';
            const ev = trigger.appEvent?.event || 'event';
            const f = trigger.appEvent?.filter;
            const filt = f ? ` filtered by ${JSON.stringify(f)}` : '';
            return `When ${provider} emits "${ev}"${filt}`;
        }
        default: return `On trigger (${trigger.kind || 'unknown'})`;
    }
}

function describeRef(binding) {
    if (binding == null) return '∅';
    if (typeof binding !== 'object') return JSON.stringify(binding);
    if (binding.kind === 'literal') return JSON.stringify(binding.value);
    if (binding.kind === 'ref') return `\`${binding.path}\``;
    if (binding.kind === 'template') return `"${binding.value}"`;
    if (binding.kind === 'expr') return `\`${binding.value}\``;
    return JSON.stringify(binding);
}

function describeStep(step, idx) {
    const n = `${idx + 1}.`;
    switch (step.type) {
        case 'integration_action': {
            const sideEffect = isSideEffect(step.tool);
            const inputs = Object.entries(step.inputs || {})
                .map(([k, v]) => `${k}=${describeRef(v)}`)
                .join(', ');
            const line = `Call \`${step.tool}\`${inputs ? ` with ${inputs}` : ''}${step.label ? ` — ${step.label}` : ''}.`;
            return `${n} ${sideEffect ? '**' + line + '**' : line}`;
        }
        case 'ai_step': {
            const promptShort = (step.prompt || '').replace(/\s+/g, ' ').slice(0, 140) + ((step.prompt || '').length > 140 ? '…' : '');
            return `${n} Ask the AI (${step.modelTier || 'fast'}): "${promptShort}"`;
        }
        case 'condition':
            return `${n} If \`${step.expr}\` then go to "then"-branch, else "else"-branch.`;
        case 'loop':
            return `${n} For each item in \`${step.overRef}\` (as \`loop.${step.itemVar}\`), run a sub-flow of ${(step.body || []).length} step(s) (max ${step.maxIterations || 100}).`;
        case 'code':
            return `${n} **Run sandboxed JavaScript** (${(step.code || '').length} chars).`;
        case 'notification': {
            const channels = (step.channels || ['notification']).join(', ');
            const title = step.title ? ` titled "${step.title}"` : '';
            return `${n} Send notification on **${channels}**${title}.`;
        }
        case 'call_layer': {
            const key = step.layerKey || step.layerId || '?';
            const inputs = Object.entries(step.inputs || {})
                .map(([k, v]) => `${k}=${describeRef(v)}`)
                .join(', ');
            return `${n} Run flowlet \`${key}\`${inputs ? ` with ${inputs}` : ''}${step.label && step.label !== 'Call layer' ? ` — ${step.label}` : ''}.`;
        }
        default:
            return `${n} ${step.type} step (${step.id}).`;
    }
}

/**
 * Produce a markdown plain-English summary of the automation.
 *
 * Returns:
 *   { summary: string, hasSideEffects: boolean }
 */
function summariseDefinition(def) {
    if (!def || typeof def !== 'object') {
        return { summary: '_(empty draft)_', hasSideEffects: false };
    }
    const lines = [];
    lines.push(`**Trigger:** ${describeTrigger(def.trigger)}.`);
    lines.push('');
    lines.push('**Steps:**');

    let hasSideEffects = false;
    const steps = Array.isArray(def.steps) ? def.steps : [];
    if (steps.length === 0) {
        lines.push('_(no steps yet)_');
    } else {
        steps.forEach((s, i) => {
            const desc = describeStep(s, i);
            if (s.type === 'integration_action' && isSideEffect(s.tool)) hasSideEffects = true;
            if (s.type === 'code') hasSideEffects = true;
            if (s.type === 'notification') hasSideEffects = true;
            lines.push(desc);
        });
    }

    return { summary: lines.join('\n'), hasSideEffects };
}

// ── Agent-facing structured draft state ──────────────────────────────────
// Unlike summariseDefinition (human prose, root-only, no IDs), this renders a
// compact but COMPLETE view for the builder AGENT: every step's real id, type,
// tool/op, label, key settings AND its input bindings (the mapping between
// steps) — for the main flow AND every inline flowlet, plus the edge wiring.
// The agent reads step IDs + current bindings here instead of asking the user.

function bindingMap(map) {
    const entries = Object.entries(map || {});
    if (!entries.length) return '∅';
    return `{ ${entries.map(([k, v]) => `${k}=${describeRef(v)}`).join(', ')} }`;
}

/** One line per step: `id` type detail — label [forEach] ← inputs. */
function renderStepState(step) {
    const id = `\`${step.id}\``;
    let detail = '';
    let inputs = '';
    switch (step.type) {
        case 'integration_action': detail = ` ${step.tool || '?'}`; inputs = bindingMap(step.inputs); break;
        case 'ai_step':            detail = ` (${step.modelTier || 'auto'})`; inputs = bindingMap(step.inputs); break;
        case 'condition':          detail = ` if \`${step.expr}\``; break;
        case 'switch':             detail = ` on \`${step.expr}\` cases=[${(step.cases || []).map(c => c.name).join(', ')}]`; break;
        case 'loop':               detail = ` over \`${step.overRef}\` as loop.${step.itemVar} (${(step.body || []).length} body step(s))`; break;
        case 'set':                detail = ` fields=${bindingMap(step.fields)}`; break;
        case 'layer_output':       detail = ` returns=${bindingMap(step.fields)}`; break;
        case 'call_layer':         detail = ` layer=\`${step.layerKey || '?'}\``; inputs = bindingMap(step.inputs); break;
        case 'notification':       detail = ` ${(step.channels || ['notification']).join(',')}${step.title ? ` "${step.title}"` : ''}`; break;
        case 'code':               detail = ` (${(step.code || '').length} chars)`; break;
        case 'datetime':           detail = ` op=${step.op || 'now'}`; break;
        case 'wait':               detail = ` ${step.seconds || 0}s`; break;
        case 'stop_error':         detail = ` "${step.message || ''}"`; break;
        case 'filter': case 'limit': case 'dedupe': case 'aggregate': case 'summarize':
            detail = ` over \`${step.arrayRef || ''}\`${step.field ? ` field=${step.field}` : ''}${step.op ? ` op=${step.op}` : ''}`; break;
        default: detail = '';
    }
    const fe = step.forEach?.overRef ? `  [forEach over \`${step.forEach.overRef}\` as loop.${step.forEach.itemVar || 'item'}]` : '';
    const label = step.label ? `  — ${step.label}` : '';
    const inLine = inputs && inputs !== '∅' ? `  ← inputs ${inputs}` : '';
    return `  - ${id} ${step.type}${detail}${label}${fe}${inLine}`;
}

function renderGraphState(graph, out) {
    const t = graph.trigger;
    if (t) {
        if (t.kind === 'layer_input') {
            const params = (t.params || []).map(p => (typeof p === 'string' ? p : p.name)).filter(Boolean);
            out.push(`  - \`${t.id || 'trg'}\` trigger:layer_input  inputs: ${params.join(', ') || '(none)'}  (bind inside as trigger.output.<name>)`);
        } else {
            out.push(`  - \`${t.id || 'trg'}\` trigger:${t.kind || 'manual'}`);
        }
    }
    for (const s of (Array.isArray(graph.steps) ? graph.steps : [])) out.push(renderStepState(s));
    const edges = Array.isArray(graph.edges) ? graph.edges : [];
    if (edges.length) {
        out.push(`  wiring: ${edges.map(e => `${e.from}→${e.to}${e.label ? `(${e.label})` : ''}`).join(', ')}`);
    }
}

function renderAgentDraftState(def) {
    if (!def || typeof def !== 'object') return '_(empty draft)_';
    const out = ['MAIN FLOW:'];
    renderGraphState(def, out);
    const layers = (def.layers && typeof def.layers === 'object' && !Array.isArray(def.layers)) ? def.layers : {};
    for (const [key, g] of Object.entries(layers)) {
        if (!g || typeof g !== 'object') continue;
        out.push('');
        out.push(`FLOWLET \`${key}\`${g.title ? ` — "${g.title}"` : ''}:`);
        renderGraphState(g, out);
    }
    return out.join('\n');
}

module.exports = { summariseDefinition, renderAgentDraftState };
