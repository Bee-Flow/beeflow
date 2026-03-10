/**
 * Pipeline Orchestrator Evaluation
 * Asks the orchestrator to evaluate whether a phase goal was met.
 */

const { callLLM, extractJSON } = require('./llmHelpers');

/**
 * Ask the orchestrator to evaluate whether a phase goal was met.
 * Returns { decision: 'proceed'|'retry', reason: string, followUp?: { targetWorker, question } }
 */
async function askOrchestratorEvaluation(phaseKey, phaseResults, config, onEvent) {
    const agentStore = require('../stores/agentStore');
    const phase = await agentStore.getSwarmPhase(phaseKey);
    if (!phase) {
        console.warn(`[Swarm] No phase goal found for '${phaseKey}', auto-proceeding`);
        return { decision: 'proceed', reason: 'No phase goal defined' };
    }

    onEvent('orchestrator_eval', { phase: phaseKey, message: `Evaluating ${phase.name} phase...` });

    const evalPrompt = `## Phase Evaluation Request
**Phase:** ${phase.name} (Phase ${phase.phase_number})
**Goal:** ${phase.goal}

## Phase Results
${typeof phaseResults === 'string' ? phaseResults : JSON.stringify(phaseResults, null, 2)}

## Your Task
Evaluate whether the phase goal was met. Respond with ONLY JSON:
- If goal met: {"decision":"proceed","reason":"brief explanation"}
- If goal NOT met: {"decision":"retry","reason":"what's missing","followUp":{"targetWorker":"worker_key","question":"specific question"}}

Only request a retry if critical information is truly missing. Minor gaps are acceptable.`;

    try {
        const data = await callLLM({
            systemPrompt: config.orchestrator.systemPrompt,
            messages: [{ role: 'user', content: evalPrompt }],
            model: config.orchestrator.model,
            temperature: 0.2,
            maxTokens: 500
        });

        const evaluation = extractJSON(data.choices[0].message.content || '');
        if (!evaluation || !evaluation.decision) {
            console.warn('[Swarm] Orchestrator evaluation returned invalid JSON, auto-proceeding');
            return { decision: 'proceed', reason: 'Evaluation parse failed' };
        }

        console.log(`[Swarm] Phase '${phaseKey}' evaluation: ${evaluation.decision} — ${evaluation.reason}`);
        onEvent('orchestrator_eval_result', {
            phase: phaseKey,
            decision: evaluation.decision,
            reason: evaluation.reason
        });

        return evaluation;
    } catch (err) {
        console.error(`[Swarm] Orchestrator evaluation error for '${phaseKey}':`, err.message);
        return { decision: 'proceed', reason: `Evaluation error: ${err.message}` };
    }
}

module.exports = { askOrchestratorEvaluation };
