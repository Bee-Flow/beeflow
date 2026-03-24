/**
 * Mistral Provider Adapter
 *
 * 100% SDK-based — uses the official `@mistralai/mistralai` package.
 * No raw fetch, no manual SSE parsing.
 *
 * Supports:
 * - Chat completions (non-streaming + streaming)
 * - Tool calling
 * - Model listing
 */

const BaseProvider = require('./base');

class MistralProvider extends BaseProvider {
    constructor() {
        super('mistral');
    }

    // ─── SDK Client ──────────────────────────────────────────────

    createClient(apiKey) {
        const { Mistral } = require('@mistralai/mistralai');
        return new Mistral({ apiKey });
    }

    // ─── Message Normalization ───────────────────────────────────
    // The Mistral SDK uses camelCase internally (toolCalls, toolCallId).
    // The rest of the codebase uses snake_case (tool_calls, tool_call_id).
    // Also: assistant messages MUST have content (not null/undefined).
    normalizeMessages(messages) {
        return messages.map(msg => {
            const normalized = { ...msg };

            if (normalized.role === 'assistant') {
                // Ensure content is never null (Mistral rejects it)
                if (normalized.content === null || normalized.content === undefined) {
                    normalized.content = '';
                }
                // Convert snake_case tool_calls → camelCase toolCalls
                if (normalized.tool_calls && !normalized.toolCalls) {
                    normalized.toolCalls = normalized.tool_calls;
                    delete normalized.tool_calls;
                }
            }

            if (normalized.role === 'tool') {
                // SDK expects camelCase toolCallId — convert from snake_case
                const id = normalized.toolCallId || normalized.tool_call_id;
                if (id) {
                    normalized.toolCallId = id;
                    delete normalized.tool_call_id;
                } else {
                    normalized.toolCallId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                }
            }

            return normalized;
        });
    }

    supportsVision(modelId) {
        // Only Pixtral models support vision in the Mistral family
        return /pixtral/.test(modelId);
    }

    // ─── High-Level API (all SDK) ────────────────────────────────

    /**
     * Non-streaming chat via SDK.
     * baseUrl accepted for interface compat but ignored — SDK handles it.
     */
    async chat(apiKey, baseUrl, model, messages, options = {}) {
        const client = this.createClient(apiKey);

        const params = { model, messages: this.normalizeMessages(messages) };
        if (options.maxTokens !== undefined) params.maxTokens = options.maxTokens;
        if (options.temperature !== undefined) params.temperature = options.temperature;
        if (options.tools && options.tools.length > 0) {
            params.tools = options.tools;
            params.toolChoice = options.toolChoice || 'auto';
        }

        console.log('[Mistral] SDK chat for model:', model);
        const response = await client.chat.complete(params);

        const message = response.choices?.[0]?.message;
        // Content can be a string or an array of content blocks
        let content = message?.content;
        if (Array.isArray(content)) {
            content = content
                .map(block => typeof block === 'string' ? block : (block.text || block.content || ''))
                .join('');
        }
        return {
            content: content || null,
            toolCalls: message?.toolCalls || null,
            usage: response.usage || null,
            raw: response,
        };
    }

    /**
     * Streaming chat via SDK.
     * baseUrl accepted for interface compat but ignored.
     */
    async stream(apiKey, baseUrl, model, messages, options = {}, onEvent) {
        const client = this.createClient(apiKey);

        const params = { model, messages: this.normalizeMessages(messages), stream: true };
        if (options.maxTokens !== undefined) params.maxTokens = options.maxTokens;
        if (options.temperature !== undefined) params.temperature = options.temperature;
        if (options.tools && options.tools.length > 0) {
            params.tools = options.tools;
            params.toolChoice = options.toolChoice || 'auto';
        }

        console.log('[Mistral] SDK streaming for model:', model);
        const stream = await client.chat.stream(params);

        // Accumulate tool calls across streaming chunks
        const toolCallAccumulator = {};
        let streamUsage = null;

        for await (const event of stream) {
            // Capture usage from streaming chunks
            if (event.data?.usage) {
                streamUsage = {
                    prompt_tokens: event.data.usage.promptTokens || event.data.usage.prompt_tokens || 0,
                    completion_tokens: event.data.usage.completionTokens || event.data.usage.completion_tokens || 0,
                    total_tokens: event.data.usage.totalTokens || event.data.usage.total_tokens || 0,
                };
            }
            const delta = event.data?.choices?.[0]?.delta;
            if (delta?.content) {
                // Content can be a string or an array of content blocks
                let text;
                if (typeof delta.content === 'string') {
                    text = delta.content;
                } else if (Array.isArray(delta.content)) {
                    text = delta.content
                        .map(block => typeof block === 'string' ? block : (block.text || block.content || ''))
                        .join('');
                } else {
                    text = String(delta.content);
                }
                if (text) onEvent('text', { text });
            }
            // Accumulate tool call deltas
            if (delta?.toolCalls) {
                for (const tc of delta.toolCalls) {
                    const idx = tc.index ?? Object.keys(toolCallAccumulator).length;
                    if (!toolCallAccumulator[idx]) {
                        toolCallAccumulator[idx] = {
                            id: tc.id || '',
                            name: tc.function?.name || '',
                            arguments: '',
                        };
                    }
                    if (tc.id) toolCallAccumulator[idx].id = tc.id;
                    if (tc.function?.name) toolCallAccumulator[idx].name += tc.function.name;
                    if (tc.function?.arguments) toolCallAccumulator[idx].arguments += tc.function.arguments;
                }
            }
            // Emit accumulated tool calls on finish
            const finishReason = event.data?.choices?.[0]?.finishReason || event.data?.choices?.[0]?.finish_reason;
            if (finishReason === 'tool_calls' || finishReason === 'stop') {
                for (const [, tc] of Object.entries(toolCallAccumulator)) {
                    if (tc.name) {
                        let input = {};
                        try { input = JSON.parse(tc.arguments || '{}'); } catch (e) { }
                        onEvent('tool_use', {
                            id: tc.id,
                            name: tc.name,
                            input,
                        });
                        console.log(`[Mistral] Stream tool_use: ${tc.name}`);
                    }
                }
            }
        }

        onEvent('done', streamUsage || {});
    }

    /**
     * List models via SDK.
     * baseUrl accepted for interface compat but ignored.
     */
    async listModels(apiKey, baseUrl) {
        try {
            const client = this.createClient(apiKey);
            const response = await client.models.list();
            return (response.data || []).map(m => ({ id: m.id, name: m.id }));
        } catch (e) {
            console.error('[Mistral] SDK listModels failed:', e.message);
            return [];
        }
    }
}

module.exports = MistralProvider;
