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
 * - Magistral native reasoning (thinking chunks)
 * - Adjustable reasoning (reasoning_effort for mistral-small)
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

    // ─── Helpers ─────────────────────────────────────────────────

    /**
     * Map the normalized cross-provider tool_choice to Mistral's vocabulary.
     * Mistral expects 'auto' | 'any' | 'none' | a specific function object. Our
     * stack emits 'required' (OpenAI's word) to mean "must call a tool" — Mistral
     * calls that 'any', so translate it; everything else passes through. Without
     * this, forceFirstToolCall (small Mistral models) sent an invalid value and
     * the forced-first-tool turn broke. Claude/OpenAI/Google already map it.
     */
    mapToolChoice(toolChoice) {
        if (!toolChoice) return 'auto';
        if (toolChoice === 'required') return 'any';
        return toolChoice;
    }

    /** Check if model is a native reasoning (Magistral) model */
    isReasoningModel(modelId) {
        return /magistral/i.test(modelId);
    }

    /**
     * Extract thinking and text content from Mistral's content block array.
     *
     * Magistral (-2509+) returns content as an array of typed blocks:
     *   [
     *     { type: 'thinking', thinking: [{ type: 'text', text: '...' }] },
     *     { type: 'text', text: 'final answer' }
     *   ]
     *
     * Non-reasoning models return content as a plain string.
     */
    parseContentBlocks(content) {
        if (typeof content === 'string') return { thinking: null, text: content };
        if (!Array.isArray(content)) return { thinking: null, text: String(content || '') };

        let thinking = '';
        let text = '';

        for (const block of content) {
            if (typeof block === 'string') {
                text += block;
                continue;
            }

            if (block.type === 'thinking') {
                // Thinking block contains nested array: block.thinking = [{ type: 'text', text: '...' }]
                if (Array.isArray(block.thinking)) {
                    thinking += block.thinking
                        .map(t => (typeof t === 'string' ? t : (t.text || '')))
                        .join('');
                } else if (typeof block.thinking === 'string') {
                    thinking += block.thinking;
                }
            } else if (block.type === 'text') {
                text += block.text || '';
            } else {
                // Unknown block — extract whatever text we can
                text += block.text || block.content || '';
            }
        }

        return { thinking: thinking || null, text };
    }

    // ─── Message Normalization ───────────────────────────────────
    // The Mistral SDK uses camelCase internally (toolCalls, toolCallId).
    // The rest of the codebase uses snake_case (tool_calls, tool_call_id).
    // Also: assistant messages MUST have content (not null/undefined).
    normalizeMessages(messages) {
        return messages.map(msg => {
            const normalized = { ...msg };

            // OpenAI-style image blocks → Mistral content chunks. The Mistral SDK
            // validates content with a Zod schema that expects { type:'image_url',
            // imageUrl: <string|{url}> } (camelCase) and rejects { image_url:{url} }
            // outright (ZodError). Convert user/assistant array content so vision
            // (pixtral) works and a stray image block never crashes the request.
            if (Array.isArray(normalized.content)) {
                normalized.content = normalized.content.map(block => {
                    if (block && block.type === 'image_url' && block.image_url !== undefined) {
                        const url = typeof block.image_url === 'string' ? block.image_url : (block.image_url?.url || '');
                        return { type: 'image_url', imageUrl: url };
                    }
                    return block;
                });
            }

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
            params.toolChoice = this.mapToolChoice(options.toolChoice);
        }

        // Adjustable reasoning for mistral-small
        if (options.reasoningEffort && !this.isReasoningModel(model)) {
            params.reasoningEffort = options.reasoningEffort;
        }

        console.log('[Mistral] SDK chat for model:', model);
        // Per-call timeout + retry policy. Mistral SDK retries by default on
        // connection errors; when the retry path receives an already-consumed
        // Request it surfaces as "Unexpected HTTP client error: TypeError:
        // Failed to parse URL from [object Request]" — confusing and floods
        // the logs. Callers (e.g. node-search cleanup) pass retries=none and
        // a sensible timeout to avoid both the hangs and the noisy retry bug.
        const requestOptions = {};
        if (options.timeoutMs !== undefined) requestOptions.timeoutMs = options.timeoutMs;
        if (options.retries !== undefined) requestOptions.retries = options.retries;
        const response = await client.chat.complete(params, requestOptions);

        const message = response.choices?.[0]?.message;
        const { thinking, text } = this.parseContentBlocks(message?.content);

        const result = {
            content: text || null,
            toolCalls: message?.toolCalls || null,
            usage: response.usage || null,
            raw: response,
        };
        if (thinking) result.thinking = thinking;

        return result;
    }

    /**
     * Streaming chat via SDK.
     * baseUrl accepted for interface compat but ignored.
     */
    async stream(apiKey, baseUrl, model, messages, options = {}, onEvent) {
        const client = this.createClient(apiKey);
        const isReasoning = this.isReasoningModel(model);

        const params = { model, messages: this.normalizeMessages(messages), stream: true };
        if (options.maxTokens !== undefined) params.maxTokens = options.maxTokens;
        if (options.temperature !== undefined) params.temperature = options.temperature;
        if (options.tools && options.tools.length > 0) {
            params.tools = options.tools;
            params.toolChoice = this.mapToolChoice(options.toolChoice);
        }

        // Adjustable reasoning for mistral-small
        if (options.reasoningEffort && !isReasoning) {
            params.reasoningEffort = options.reasoningEffort;
        }

        console.log('[Mistral] SDK streaming for model:', model, isReasoning ? '(reasoning)' : '');
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
                // Content can be a string or an array of typed content blocks
                if (typeof delta.content === 'string') {
                    onEvent('text', { text: delta.content });
                } else if (Array.isArray(delta.content)) {
                    // Magistral models: content is an array of { type, text/thinking } blocks
                    for (const block of delta.content) {
                        if (typeof block === 'string') {
                            onEvent('text', { text: block });
                        } else if (block.type === 'thinking') {
                            // Extract text from thinking block
                            let thinkText = '';
                            if (Array.isArray(block.thinking)) {
                                thinkText = block.thinking
                                    .map(t => (typeof t === 'string' ? t : (t.text || '')))
                                    .join('');
                            } else if (typeof block.thinking === 'string') {
                                thinkText = block.thinking;
                            }
                            if (thinkText) onEvent('thinking', { text: thinkText });
                        } else if (block.type === 'text') {
                            if (block.text) onEvent('text', { text: block.text });
                        } else {
                            // Unknown block type — try to extract text
                            const t = block.text || block.content || '';
                            if (t) onEvent('text', { text: t });
                        }
                    }
                } else {
                    onEvent('text', { text: String(delta.content) });
                }
            }
            // Accumulate tool call deltas
            if (delta?.toolCalls) {
                for (const tc of delta.toolCalls) {
                    const idx = tc.index ?? Object.keys(toolCallAccumulator).length;
                    if (!toolCallAccumulator[idx]) {
                        toolCallAccumulator[idx] = {
                            id: tc.id || '',
                            name: '',
                            arguments: '',
                        };
                    }
                    if (tc.id) toolCallAccumulator[idx].id = tc.id;
                    // Name comes once in the first chunk — set, don't append
                    if (tc.function?.name) toolCallAccumulator[idx].name = tc.function.name;
                    // Arguments stream in across multiple chunks — append
                    if (tc.function?.arguments) {
                        toolCallAccumulator[idx].arguments += tc.function.arguments;
                        // Surface in-progress args for live-streaming a tool arg
                        // (e.g. notebook_write content). Ignored if unhandled.
                        const _acc = toolCallAccumulator[idx];
                        if (_acc.name) onEvent('tool_args_delta', { name: _acc.name, partial: _acc.arguments });
                    }
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
