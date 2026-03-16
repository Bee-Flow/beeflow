/**
 * LLM Client — Unified facade for all LLM provider interactions.
 * 
 * Routes call this instead of touching provider adapters directly.
 * Handles: provider resolution, adapter selection, normalized event dispatching.
 */

const { getAdapter } = require('./providers');
const { getProviderForModel } = require('./aiAgent');

class LLMClient {
    /**
     * Resolve the provider config + adapter for a model.
     * @returns {{ apiKey, baseUrl, adapter, providerType, modelId }}
     */
    async _resolve(modelId) {
        const config = await getProviderForModel(modelId);
        const baseUrl = (config.url || '').replace(/\/+$/, '');
        const adapter = getAdapter(config.providerType, baseUrl);
        return {
            apiKey: config.apiKey || '',
            baseUrl,
            adapter,
            providerType: config.providerType || adapter.name,
            modelId: config.model || modelId,
            project: config.project || null,
            location: config.location || null,
            serviceAccountKey: config.serviceAccountKey || null,
        };
    }

    /**
     * Non-streaming chat completion.
     * @returns {Promise<{content, toolCalls, usage}>}
     */
    async chat(modelId, messages, options = {}) {
        const { apiKey, baseUrl, adapter, project, location, serviceAccountKey } = await this._resolve(modelId);
        return adapter.chat(apiKey, baseUrl, modelId, messages, { ...options, project, location, serviceAccountKey });
    }

    /**
     * Streaming chat completion with normalized event callbacks.
     * @param {function} onEvent - Called with (type, data):
     *   text, thinking, tool_use, done, error
     */
    async stream(modelId, messages, options = {}, onEvent) {
        const { apiKey, baseUrl, adapter, project, location, serviceAccountKey } = await this._resolve(modelId);
        return adapter.stream(apiKey, baseUrl, modelId, messages, { ...options, project, location, serviceAccountKey }, onEvent);
    }

    /**
     * Generate a short title for a conversation.
     */
    async generateTitle(modelId, userMessage, systemPrompt, options = {}) {
        const messages = [
            { role: 'system', content: systemPrompt || 'Generate a short 2-4 word title for this conversation. Output only the title.' },
            { role: 'user', content: typeof userMessage === 'string' ? userMessage.slice(0, 500) : JSON.stringify(userMessage).slice(0, 500) },
        ];
        const result = await this.chat(modelId, messages, {
            maxTokens: 60,
            temperature: 0.3,
            budgetTokens: 0,           // Disable thinking — title gen is trivial
            reasoningEffort: 'none',   // Disable reasoning for OpenAI models too
            ...options,
        });
        const raw = result.content || '';
        return raw.trim().replace(/[\"']/g, '') || 'New Chat';
    }

    /**
     * Run a tool-calling loop: chat → check for tool calls → execute → repeat.
     * Returns { messages, content, toolCallRounds }.
     * 
     * @param {string} modelId
     * @param {Array} messages - Initial messages
     * @param {Array} tools - Tool definitions (OpenAI format)
     * @param {object} options - Chat options
     * @param {function} executeTool - async (name, args) => result string
     * @param {number} maxRounds - Max tool call rounds (default: 5)
     */
    async runToolLoop(modelId, messages, tools, options = {}, executeTool, maxRounds = 5) {
        let rounds = 0;
        const updatedMessages = [...messages];

        while (rounds < maxRounds) {
            const result = await this.chat(modelId, updatedMessages, {
                ...options,
                tools,
                toolChoice: 'auto',
            });

            if (!result.toolCalls || result.toolCalls.length === 0) {
                // No tool calls — done
                return { messages: updatedMessages, content: result.content, toolCallRounds: rounds };
            }

            // Add assistant message with tool calls
            updatedMessages.push({
                role: 'assistant',
                content: result.content || null,
                tool_calls: result.toolCalls,
            });

            // Execute each tool call and add results
            for (const tc of result.toolCalls) {
                const fnName = tc.function?.name || tc.name;
                const fnArgs = tc.function?.arguments || tc.input;
                let args;
                try {
                    args = typeof fnArgs === 'string' ? JSON.parse(fnArgs) : fnArgs;
                } catch {
                    args = {};
                }

                let toolResult;
                try {
                    toolResult = await executeTool(fnName, args);
                } catch (e) {
                    toolResult = `Error: ${e.message}`;
                }

                updatedMessages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
                });
            }

            rounds++;
        }

        // Max rounds hit — do one final chat without tools
        const finalResult = await this.chat(modelId, updatedMessages, {
            ...options,
            tools: undefined,
        });
        return { messages: updatedMessages, content: finalResult.content, toolCallRounds: rounds };
    }
}

// Singleton
module.exports = new LLMClient();
