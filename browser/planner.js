/**
 * Browser Agent — Planner
 */

const { callLLM } = require('./llm');
const { formatObservation } = require('./observation');
const { processSystemPrompt } = require('../core/promptUtils');

async function runPlanner(providerConfig, model, coordinator, observation, agentConfig, errorContext = '', maxMilestones = 6, signal = null) {
    const obsText = formatObservation(observation);
    const prompt = `You are a planning assistant for a browser automation agent.

## User Goal
${coordinator.goal}

## Current Page
${obsText}
${coordinator.memorySummary ? `\n## Memory (what has been done so far)\n${coordinator.memorySummary}` : ''}
${errorContext ? `\n## Problem\n${errorContext}` : ''}

## Instructions
Create a concise plan with 3-${maxMilestones} numbered steps (milestones) to accomplish the user's goal from the current page state.
For each step, describe what action to take and what success looks like.
If you notice forms, specify which fields to fill.
If you see relevant buttons, mention them by their element IDs (btn_N, input_N).
If a cookie banner, ad overlay, or popup appears, include a step to dismiss it (accept/close).
Be efficient — use the fewest steps possible.

Respond with ONLY the plan, no preamble.`;

    try {
        const { message: resp } = await callLLM(providerConfig, model, [
            { role: 'system', content: processSystemPrompt(agentConfig.system_prompt || 'You are a browser automation planner.') },
            { role: 'user', content: prompt }
        ], [], 0, 800, signal);  // No tools for planner
        const plan = resp?.content || 'No plan generated. Proceed with best effort.';
        console.log('[BrowserAgent] Plan:', plan.slice(0, 200) + '...');
        return plan;
    } catch (e) {
        console.error('[BrowserAgent] Planner failed:', e.message);
        return 'Planner failed. Proceed with best effort based on page observation.';
    }
}

module.exports = { runPlanner };
