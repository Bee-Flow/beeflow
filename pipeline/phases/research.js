/**
 * Pipeline Phase 1: Research
 * Parallel research workers + orchestrator synthesis.
 */

const { callLLM, extractJSON } = require('../llmHelpers');
const { getSearchTools, executeToolCalls } = require('../toolHelpers');

/**
 * Summarize a worker's result into a short human-readable string.
 */
function summarizeWorkerResult(workerKey, result) {
    if (!result) return 'No results produced';
    try {
        switch (workerKey) {
            case 'auth': {
                const method = result.authMethod || 'unknown';
                const credCount = (result.credentials || result.formFields || []).length;
                return `Auth method: ${method}, ${credCount} credential field(s)`;
            }
            case 'api': {
                const endpoints = (result.endpoints || []).length;
                const baseUrl = result.baseUrl || result.baseURL || 'N/A';
                return `${endpoints} endpoint(s) found, base URL: ${baseUrl}`;
            }
            case 'schema': {
                const inputs = Object.keys(result.inputs || {}).length;
                const outputs = Object.keys(result.outputs || {}).length;
                return `${inputs} input(s), ${outputs} output(s) defined`;
            }
            case 'requirements': {
                const criteria = (result.acceptanceCriteria || result.requirements || []).length;
                const edges = (result.edgeCases || []).length;
                return `${criteria} requirement(s), ${edges} edge case(s)`;
            }
            case 'credentials': {
                const fields = (result.fields || []).length;
                const links = (result.helpLinks || []).length;
                return `${fields} credential field(s), ${links} help link(s)`;
            }
            case 'clarify': {
                const qCount = (result.questions || []).length;
                return `${qCount} clarification question(s), needed: ${result.needed || false}`;
            }
            case 'qa': {
                const tests = (result.testCases || []).length;
                const edges = (result.edgeCaseTests || []).length;
                return `${tests} test case(s), ${edges} edge case test(s)`;
            }
            default: {
                const keys = Object.keys(result);
                return `Returned ${keys.length} field(s): ${keys.slice(0, 5).join(', ')}`;
            }
        }
    } catch {
        return 'Results produced (could not summarize)';
    }
}

/**
 * Run a single research worker with optional tool loop.
 */
async function runResearchWorker(workerKey, workerConfig, context, onEvent) {
    const startTime = Date.now();
    onEvent('worker_start', { worker: workerKey, name: workerConfig.name });

    try {
        let tools = [];
        if (workerConfig.useTools) tools = getSearchTools();

        // Build the instruction from orchestrator → worker
        const instruction = `## User Request\n${context.userMessage}\n\n## Orchestrator Plan\n${JSON.stringify(context.plan, null, 2)}${context.priorResearch ? `\n\n## Prior Research\n${context.priorResearch}` : ''}\n\n${workerConfig.useTools ? 'IMPORTANT: You MUST call your available tools (e.g. tavily_search) FIRST to research the topic before responding. After researching, respond with ONLY JSON as specified in your system prompt.' : 'Respond with ONLY JSON as specified in your system prompt.'}`;

        // Worker-specific task descriptions
        const workerTasks = {
            requirements: `Analyze "${context.plan.componentName || context.plan.componentId}" and extract acceptance criteria, edge cases, and validation rules.`,
            auth: `Investigate authentication methods for "${context.plan.componentName || context.plan.componentId}". Find credential types, form fields, and documentation URLs.`,
            schema: `Define input/output schema for "${context.plan.componentName || context.plan.componentId}" with types, labels, defaults, and validation rules.`,
            api: `Research API endpoints for "${context.plan.componentName || context.plan.componentId}". Find URLs, request/response formats, headers, and error codes.`,
            credentials: `Research how to obtain the required credentials. Find step-by-step setup instructions and direct URLs.`,
            qa: `Define test cases and sample inputs for "${context.plan.componentName || context.plan.componentId}".`,
            clarify: `Analyze the user request and determine if clarification questions are needed before research.`
        };

        // Emit what the orchestrator sends to this worker
        onEvent('orchestrator_to_worker', {
            worker: workerKey,
            name: workerConfig.name,
            instruction: workerTasks[workerKey] || `Process "${context.plan.componentId}" for ${workerKey} analysis.`,
            context: `Component: ${context.plan.componentId} | Category: ${context.plan.category || 'Custom'}`
        });

        const messages = [{ role: 'user', content: instruction }];

        let result = null;
        let iterations = 0;
        const maxIter = workerConfig.useTools ? 5 : 1;

        while (iterations < maxIter) {
            iterations++;
            const data = await callLLM({
                systemPrompt: workerConfig.systemPrompt,
                messages,
                tools,
                model: workerConfig.model,
                temperature: workerConfig.temperature,
                maxTokens: workerConfig.maxTokens
            });

            const assistantMsg = data.choices[0].message;

            if (assistantMsg.tool_calls?.length > 0) {
                messages.push({ ...assistantMsg, content: assistantMsg.content ?? '' });
                const toolResults = await executeToolCalls(assistantMsg.tool_calls, onEvent, workerKey, workerConfig.phase);
                for (const { tc, result: toolRes } of toolResults) {
                    messages.push({ role: 'tool', tool_call_id: tc.id, content: toolRes });
                }
                continue;
            }

            result = extractJSON(assistantMsg.content || '') || { rawResponse: (assistantMsg.content || '').slice(0, 500) };
            break;
        }

        const elapsed = Date.now() - startTime;

        // Summarize key findings for visibility
        const summary = summarizeWorkerResult(workerKey, result);
        const fullResult = result ? JSON.stringify(result, null, 2) : null;
        onEvent('worker_to_orchestrator', {
            worker: workerKey,
            name: workerConfig.name,
            summary,
            resultKeys: result ? Object.keys(result) : [],
            fullResult: fullResult && fullResult.length > 3000 ? fullResult.slice(0, 3000) + '\n... (truncated)' : fullResult
        });

        onEvent('worker_done', { worker: workerKey, name: workerConfig.name, elapsed, output: result });
        console.log(`[Swarm] ${workerKey} done in ${elapsed}ms`);
        return { worker: workerKey, result, elapsed, success: true };

    } catch (error) {
        const elapsed = Date.now() - startTime;
        console.error(`[Swarm] ${workerKey} failed:`, error.message);
        onEvent('worker_error', { worker: workerKey, name: workerConfig.name, error: error.message });
        return { worker: workerKey, result: null, elapsed, success: false, error: error.message };
    }
}

/**
 * Synthesize all research worker outputs into a brief for the builder.
 */
function synthesizeResearch(plan, workerOutputs) {
    const sections = [];

    sections.push(`# Component Brief: ${plan.componentName || plan.componentId}`);
    sections.push(`**Intent:** ${plan.intent}`);
    sections.push(`**Component ID:** ${plan.componentId}`);
    sections.push(`**Category:** ${plan.category || 'Custom'}`);
    sections.push('');

    for (const w of workerOutputs) {
        if (!w.success || !w.result) continue;
        sections.push(`## ${w.worker.toUpperCase()} Worker Research`);
        sections.push(JSON.stringify(w.result, null, 2));
        sections.push('');
    }

    return sections.join('\n');
}

module.exports = {
    runResearchWorker,
    synthesizeResearch,
    summarizeWorkerResult
};
