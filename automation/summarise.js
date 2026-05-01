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

module.exports = { summariseDefinition };
