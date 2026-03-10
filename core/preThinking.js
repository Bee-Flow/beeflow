/**
 * Pre-Thinking Module
 * 
 * Runs a separate thinking model BEFORE the main agent responds.
 * Collects sequential thoughts and returns them as context.
 * 
 * Extracted from agentRuntime.js to avoid circular dependency with
 * terminal/orchestrator.js.
 */

const { getProviderForModel } = require('./aiAgent');
const { SEQUENTIAL_THINKING_TOOL, executeSequentialThinking } = require('./sequentialThinkingTool');

/**
 * Run pre-thinking step with a separate model before the main agent responds.
 *
 * @param {string} thinkingModel - Model ID for thinking
 * @param {Array} messages - Conversation messages (user/assistant only, system is built here)
 * @param {string} sessionId - Unique session ID for thought tracking
 * @param {Function} onEvent - SSE event emitter for streaming thinking steps to the UI
 * @param {AbortSignal} [signal] - Optional abort signal
 * @param {string} [agentSystemPrompt] - The agent's own system prompt (used as base context)
 * @returns {Promise<{thoughts: Array, context: string}>}
 */
async function runPreThinking(thinkingModel, messages, sessionId, onEvent, signal, agentSystemPrompt) {
    const thinkingConfig = await getProviderForModel(thinkingModel);
    let thinkingApiUrl = thinkingConfig.url.replace(/\/$/, '');
    if (!thinkingApiUrl.endsWith('/v1')) thinkingApiUrl = `${thinkingApiUrl}/v1`;

    const headers = { 'Content-Type': 'application/json' };
    const apiKey = thinkingConfig.apiKey;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const thinkingTools = [SEQUENTIAL_THINKING_TOOL];

    // Build thinking system prompt: agent's own prompt + thinking instruction
    const thinkingDirective = `[IMPORTANT: THINKING MODE ACTIVE]\nYou MUST use the sequentialthinking tool to analyze the user's request step by step. Think in the voice, personality, and perspective of the character described in your system prompt below — your thoughts should sound like YOU, not a generic reasoner. Break the problem down into concise steps (1-2 sentences each). When done, set nextThoughtNeeded to false. Do NOT produce any final answer — only think.\n\n`;
    const thinkingSystemPrompt = agentSystemPrompt
        ? thinkingDirective + agentSystemPrompt
        : thinkingDirective + `You are a reasoning engine.`;

    let thinkingMessages = [
        { role: 'system', content: thinkingSystemPrompt },
        ...messages.filter(m => m.role !== 'system')
    ];

    const collectedThoughts = [];
    const maxThinkingIterations = 15;

    console.log(`[PreThinking] Starting with model: ${thinkingModel}`);

    for (let i = 0; i < maxThinkingIterations; i++) {
        if (signal?.aborted) break;

        const requestBody = {
            model: thinkingModel,
            messages: thinkingMessages,
            temperature: 0.5,
            tools: thinkingTools,
            // Force the first call to use the thinking tool, then auto for the rest
            tool_choice: i === 0
                ? { type: 'function', function: { name: 'sequentialthinking' } }
                : 'auto'
        };

        const response = await fetch(`${thinkingApiUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
            signal: signal || undefined
        });

        if (!response.ok) {
            console.error(`[PreThinking] API error: ${response.status}`);
            break;
        }

        const result = await response.json();
        const choice = result.choices?.[0];
        if (!choice) break;

        const msg = choice.message;

        // Add assistant message to history
        thinkingMessages.push(msg);

        // If no tool calls, thinking is done
        if (!msg.tool_calls || msg.tool_calls.length === 0) break;

        // Process each tool call
        for (const tc of msg.tool_calls) {
            if (tc.function?.name === 'sequentialthinking') {
                let args;
                try {
                    args = JSON.parse(tc.function.arguments || '{}');
                } catch { args = {}; }

                // Emit SSE events so the UI shows thinking steps
                onEvent('tool_start', { name: 'sequentialthinking', args });

                const toolResult = executeSequentialThinking(args, sessionId);

                onEvent('tool_end', { name: 'sequentialthinking', result: toolResult });

                collectedThoughts.push({
                    thoughtNumber: args.thoughtNumber,
                    totalThoughts: args.totalThoughts,
                    thought: args.thought,
                    isRevision: args.isRevision,
                    branchFromThought: args.branchFromThought
                });

                // Add tool result to conversation
                thinkingMessages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: toolResult
                });

                // If thinking is complete, stop
                if (!args.nextThoughtNeeded) {
                    i = maxThinkingIterations; // break outer loop
                    break;
                }
            }
        }
    }

    // Format thoughts as context for the main model
    let context = '';
    if (collectedThoughts.length > 0) {
        const thoughtLines = collectedThoughts.map(t => {
            let prefix = `Step ${t.thoughtNumber}`;
            if (t.isRevision) prefix += ' (revision)';
            if (t.branchFromThought) prefix += ` (branch from #${t.branchFromThought})`;
            return `${prefix}: ${t.thought}`;
        }).join('\n');

        context = `\n\n[REASONING CONTEXT — produced by a separate thinking model]\n${thoughtLines}\n[END REASONING CONTEXT]\n\nUse the reasoning above to inform your response, but respond naturally to the user.`;
    }

    console.log(`[PreThinking] Completed: ${collectedThoughts.length} thoughts collected`);
    return { thoughts: collectedThoughts, context };
}

module.exports = { runPreThinking };
