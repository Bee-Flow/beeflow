/**
 * Pipeline Phase 0: Clarify
 * Orchestrator decomposes the request, then the clarify agent asks questions.
 */

const { callLLM, extractJSON } = require('../llmHelpers');
const { getSearchTools, executeToolCalls } = require('../toolHelpers');

/**
 * Run the orchestrator to decompose the user's request into a plan.
 */
async function runOrchestrator(userMessage, config, onEvent) {
    const orchestratorPrompt = config.orchestrator.systemPrompt ||
        `You are the Pipeline Orchestrator. Analyze the user's request and create a component plan.
Respond with ONLY JSON:
{
  "componentId": "kebab-case-id",
  "componentName": "Human Readable Name",
  "category": "Category",
  "intent": "What the component does",
  "activeResearchWorkers": ["requirements", "auth", "schema", "api"]
}`;

    const data = await callLLM({
        systemPrompt: orchestratorPrompt,
        messages: [{ role: 'user', content: userMessage }],
        model: config.orchestrator.model,
        temperature: config.orchestrator.temperature,
        maxTokens: config.orchestrator.maxTokens
    });

    const plan = extractJSON(data.choices[0].message.content || '');
    if (!plan || !plan.componentId) {
        throw new Error('Orchestrator failed to produce a valid plan');
    }

    // Ensure activeResearchWorkers has sensible defaults
    if (!plan.activeResearchWorkers || plan.activeResearchWorkers.length === 0) {
        plan.activeResearchWorkers = ['requirements', 'schema', 'api'];
    }

    onEvent('plan', {
        componentId: plan.componentId,
        componentName: plan.componentName,
        category: plan.category,
        intent: plan.intent,
        workers: plan.activeResearchWorkers,
        componentId: plan.componentId
    });
    console.log(`[Swarm] Plan: ${(plan.activeResearchWorkers || []).filter(k => k !== 'qa').length} research workers → builder. Intent: ${plan.intent}`);

    return plan;
}

/**
 * Run the clarification worker to determine if user input is needed before research.
 * Returns the clarify result (with .needed and .questions if clarification needed).
 */
async function runClarifier(userMessage, plan, config, onEvent) {
    const clarifyConfig = config.workers.clarify;
    if (clarifyConfig?.enabled === false) return null;

    const { runResearchWorker } = require('./research');
    const context = { userMessage, plan };
    const result = await runResearchWorker('clarify', clarifyConfig, context, onEvent);

    if (result.success && result.result?.needed && result.result?.questions?.length > 0) {
        // Normalize questions: frontend expects objects { name, label, placeholder }
        // Clarifier may return plain strings — convert them
        const normalizedQuestions = result.result.questions.map((q, i) => {
            if (typeof q === 'string') {
                const name = `q${i + 1}`;
                return { name, label: q, placeholder: `Your answer...`, type: 'text' };
            }
            // Already an object — ensure required fields
            return {
                name: q.name || `q${i + 1}`,
                label: q.label || q.question || q.text || `Question ${i + 1}`,
                placeholder: q.placeholder || 'Your answer...',
                type: q.type || 'text',
                ...(q.options ? { options: q.options } : {}),
                ...(q.default !== undefined ? { default: q.default } : {})
            };
        });
        return { ...result.result, questions: normalizedQuestions };
    }

    return null;
}

module.exports = { runOrchestrator, runClarifier };
