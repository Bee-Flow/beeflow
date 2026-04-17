/**
 * OpenAI Provider Adapter
 *
 * 100% SDK-based — uses the official `openai` package for ALL API calls.
 * No raw fetch, no manual SSE parsing.
 *
 * Supports:
 * - Chat Completions API (standard models)
 * - Responses API (reasoning models with effort + summary)
 * - Streaming via SDK typed events
 * - Tool calling
 * - Model listing
 */

const BaseProvider = require('./base');

// Models that don't support custom temperature
const RESTRICTED_MODEL_PATTERNS = [
    /^o\d/,          // o1, o3, o4-mini, etc.
    /nano/,          // gpt-4.1-nano, gpt-5-nano, etc.
    /^gpt-5/,        // gpt-5.x via Responses API
];

// Models that support reasoning settings
const REASONING_MODEL_PATTERNS = [
    /^o\d/,          // o1, o3, o4-mini
    /^gpt-5/,        // GPT-5.x family
];

// Model-specific effort limits
const MODEL_EFFORT_OVERRIDES = {
    'gpt-5-pro': 'high',
    'gpt-5.2-pro': 'high',
};

class OpenAIProvider extends BaseProvider {
    constructor() {
        super('openai');
    }

    // ─── SDK Client ──────────────────────────────────────────────

    createClient(apiKey) {
        const OpenAI = require('openai');
        return new OpenAI({ apiKey });
    }

    // ─── Model Helpers ───────────────────────────────────────────

    normalizeEffort(model, effort) {
        if (!effort) return null;
        // Map any non-standard values to valid OpenAI values
        const EFFORT_MAP = {
            'minimal': 'low',   // 'minimal' is not valid for OpenAI, map to 'low'
            'xhigh': 'high',   // 'xhigh' maps to OpenAI's max effort level
        };
        effort = EFFORT_MAP[effort] || effort;
        for (const [pattern, fixed] of Object.entries(MODEL_EFFORT_OVERRIDES)) {
            if (model.startsWith(pattern)) return fixed;
        }
        return effort;
    }

    isRestrictedModel(modelId) {
        return RESTRICTED_MODEL_PATTERNS.some(p => p.test(modelId));
    }

    supportsReasoning(modelId) {
        return REASONING_MODEL_PATTERNS.some(p => p.test(modelId));
    }

    supportsVision(modelId) {
        // GPT-4o, GPT-4.1, GPT-4.5, GPT-4-turbo, GPT-4-vision, GPT-5.x, o4-series
        return /gpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|gpt-4-vision|gpt-5|o4/.test(modelId);
    }

    shouldUseResponsesApi(model, options = {}) {
        // Default to Responses API for all reasoning models unless explicitly disabled
        if (!this.supportsReasoning(model)) return false;
        if (options.reasoningEffort === 'none') return false;
        return true;
    }

    // ─── Responses API input normalization ────────────────────────

    toResponsesInput(messages) {
        const result = [];
        // Remap call_* IDs to fc_* IDs (Responses API requires fc_ prefix)
        const idMap = {};
        const remapId = (id) => {
            if (!id) return id;
            if (id.startsWith('fc_')) return id;
            if (!idMap[id]) {
                idMap[id] = 'fc_' + id.replace(/^call_/, '');
            }
            return idMap[id];
        };

        for (const m of messages) {
            // Tool result messages → function_call_output items
            if (m.role === 'tool') {
                result.push({
                    type: 'function_call_output',
                    call_id: remapId(m.tool_call_id),
                    output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
                });
                continue;
            }

            // Responses API uses 'developer' role instead of 'system'
            const role = m.role === 'system' ? 'developer' : m.role;

            // Convert content to Responses API format
            let content = m.content;

            // Handle null/undefined content (e.g. assistant messages with only tool calls)
            if (content === null || content === undefined) {
                content = '';
            }

            if (Array.isArray(content)) {
                content = content.map(part => {
                    if (part.type === 'text') {
                        return { type: 'input_text', text: part.text };
                    }
                    if (part.type === 'image_url') {
                        const imgObj = part.image_url;
                        const url = typeof imgObj === 'string' ? imgObj : (imgObj?.url || '');
                        const detail = typeof imgObj === 'object' ? imgObj?.detail : undefined;
                        const result = { type: 'input_image', image_url: url };
                        if (detail) result.detail = detail;
                        return result;
                    }
                    return part;
                });
            } else if (typeof content === 'string' && role === 'user') {
                content = [{ type: 'input_text', text: content }];
            }

            result.push({ role, content });

            // If assistant message had tool_calls, emit function_call items after it
            if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
                for (const tc of m.tool_calls) {
                    const mappedId = remapId(tc.id);
                    result.push({
                        type: 'function_call',
                        id: mappedId,
                        call_id: mappedId,
                        name: tc.function?.name || tc.name,
                        arguments: tc.function?.arguments || JSON.stringify(tc.input || {}),
                    });
                }
            }
        }
        return result;
    }

    // ─── High-Level API (all SDK) ────────────────────────────────

    /**
     * Non-streaming chat via SDK.
     * Uses Responses API for reasoning models, Chat Completions for standard.
     */
    async chat(apiKey, baseUrl, model, messages, options = {}) {
        const client = this.createClient(apiKey);

        if (this.shouldUseResponsesApi(model, options)) {
            return this._chatResponses(client, model, messages, options);
        }
        return this._chatCompletions(client, model, messages, options);
    }

    async _chatCompletions(client, model, messages, options = {}) {
        const params = { model, messages };

        if (options.maxTokens !== undefined) params.max_completion_tokens = options.maxTokens;
        if (options.temperature !== undefined && !this.isRestrictedModel(model)) {
            params.temperature = options.temperature;
        }
        if (options.tools && options.tools.length > 0) {
            params.tools = options.tools;
            params.tool_choice = options.toolChoice || 'auto';
        }
        const effort = this.normalizeEffort(model, options.reasoningEffort);
        if (effort && effort !== 'none' && this.supportsReasoning(model)) {
            params.reasoning_effort = effort;
        }

        console.log('[OpenAI] SDK chat (completions) for model:', model);
        const response = await client.chat.completions.create(params);

        const message = response.choices?.[0]?.message;
        return {
            content: message?.content || null,
            toolCalls: message?.tool_calls || null,
            usage: response.usage || null,
            raw: response,
        };
    }

    async _chatResponses(client, model, messages, options = {}) {
        const params = {
            model,
            store: true, // Enable server-side storage for response chaining
        };

        // If we have a previous response ID, chain from it — only send new message
        if (options.previousResponseId) {
            params.previous_response_id = options.previousResponseId;
            // Only send the last user message as input
            const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
            params.input = lastUserMsg
                ? this.toResponsesInput([lastUserMsg])
                : this.toResponsesInput(messages);
            console.log('[OpenAI] Using previous_response_id:', options.previousResponseId);
        } else {
            params.input = this.toResponsesInput(messages);
        }

        if (options.maxTokens !== undefined) params.max_output_tokens = options.maxTokens;
        // Note: temperature is not supported in the Responses API for reasoning models

        const reasoning = { summary: options.reasoningSummary ? 'auto' : 'concise' };
        const effort = this.normalizeEffort(model, options.reasoningEffort);
        reasoning.effort = effort || 'medium';
        params.reasoning = reasoning;

        console.log('[OpenAI] SDK chat (responses) for model:', model);
        const response = await client.responses.create(params);

        return {
            content: response.output_text || null,
            toolCalls: null,
            usage: response.usage || null,
            responseId: response.id || null, // Return for chaining
            raw: response,
        };
    }

    /**
     * Streaming chat via SDK.
     * Uses Responses API for reasoning models, Chat Completions for standard.
     */
    async stream(apiKey, baseUrl, model, messages, options = {}, onEvent) {
        const client = this.createClient(apiKey);

        if (this.shouldUseResponsesApi(model, options)) {
            return this._streamResponses(client, model, messages, options, onEvent);
        }
        return this._streamCompletions(client, model, messages, options, onEvent);
    }

    async _streamCompletions(client, model, messages, options, onEvent) {
        const params = { model, messages, stream: true, stream_options: { include_usage: true } };

        if (options.maxTokens !== undefined) params.max_completion_tokens = options.maxTokens;
        if (options.temperature !== undefined && !this.isRestrictedModel(model)) {
            params.temperature = options.temperature;
        }
        if (options.tools && options.tools.length > 0) {
            params.tools = options.tools;
            params.tool_choice = options.toolChoice || 'auto';
        }
        const effort = this.normalizeEffort(model, options.reasoningEffort);
        if (effort && effort !== 'none' && this.supportsReasoning(model)) {
            params.reasoning_effort = effort;
        }

        console.log('[OpenAI] SDK streaming (completions) for model:', model);
        const stream = await client.chat.completions.create(params);

        // Accumulate tool calls across streaming chunks
        const toolCallAccumulator = {};
        let streamUsage = null;

        for await (const chunk of stream) {
            // Capture usage from final chunk
            if (chunk.usage) {
                streamUsage = {
                    prompt_tokens: chunk.usage.prompt_tokens || 0,
                    completion_tokens: chunk.usage.completion_tokens || 0,
                    total_tokens: chunk.usage.total_tokens || 0,
                    // OpenAI automatic prompt caching — track cache hits
                    cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens || 0,
                };
                if (streamUsage.cached_tokens > 0) {
                    console.log(`[OpenAI] ⚡ Cache hit: ${streamUsage.cached_tokens} cached prompt tokens`);
                }
            }
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
                onEvent('text', { text: delta.content });
            }
            // Accumulate tool call deltas
            if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const idx = tc.index;
                    if (!toolCallAccumulator[idx]) {
                        toolCallAccumulator[idx] = {
                            id: tc.id || '',
                            name: tc.function?.name || '',
                            arguments: '',
                        };
                    }
                    if (tc.id) toolCallAccumulator[idx].id = tc.id;
                    if (tc.function?.name) toolCallAccumulator[idx].name = tc.function.name;
                    if (tc.function?.arguments) toolCallAccumulator[idx].arguments += tc.function.arguments;
                }
            }
            // Check for finish_reason to emit accumulated tool calls
            const finishReason = chunk.choices?.[0]?.finish_reason;
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
                        console.log(`[OpenAI] Stream tool_use: ${tc.name}`);
                    }
                }
            }
        }

        onEvent('done', streamUsage || {});
    }

    async _streamResponses(client, model, messages, options, onEvent) {
        const params = {
            model,
            stream: true,
            store: true, // Enable server-side storage for response chaining
        };

        // If we have a previous response ID, chain from it — only send new message
        if (options.previousResponseId) {
            params.previous_response_id = options.previousResponseId;
            // Only send the last user message + any trailing tool results
            const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
            const newMessages = lastUserIdx >= 0 ? messages.slice(lastUserIdx) : messages;
            params.input = this.toResponsesInput(newMessages);
            console.log('[OpenAI] Streaming with previous_response_id:', options.previousResponseId);
        } else {
            params.input = this.toResponsesInput(messages);
        }

        if (options.maxTokens !== undefined) params.max_output_tokens = options.maxTokens;
        // Note: temperature is not supported in the Responses API

        const reasoning = { summary: options.reasoningSummary ? 'auto' : 'concise' };
        const effort = this.normalizeEffort(model, options.reasoningEffort);
        reasoning.effort = effort || 'medium';
        params.reasoning = reasoning;

        if (options.tools && options.tools.length > 0) {
            params.tools = options.tools.map(t => ({
                type: 'function',
                name: t.function?.name || t.name,
                description: t.function?.description || t.description || '',
                parameters: t.function?.parameters || t.parameters || {},
            }));
        }

        console.log('[OpenAI] SDK streaming (responses) for model:', model, 'reasoning:', JSON.stringify(reasoning));
        const stream = await client.responses.create(params);

        // Track current function call being accumulated
        let currentFnCall = null;
        let streamUsage = null;
        const openThinkingParts = new Set();

        for await (const event of stream) {
            if (event.type === 'response.output_text.delta') {
                if (event.delta) onEvent('text', { text: event.delta });
            } else if (event.type === 'response.reasoning_summary_text.added') {
                const partId = `openai-${event.summary_index ?? 0}`;
                if (!openThinkingParts.has(partId)) {
                    openThinkingParts.add(partId);
                    onEvent('thinking_start', { partId });
                }
            } else if (event.type === 'response.reasoning_summary_text.delta') {
                if (event.delta) {
                    const partId = `openai-${event.summary_index ?? 0}`;
                    if (!openThinkingParts.has(partId)) {
                        // Some stream flavours skip the `.added` event — open on first delta.
                        openThinkingParts.add(partId);
                        onEvent('thinking_start', { partId });
                    }
                    onEvent('thinking', { text: event.delta, partId });
                }
            } else if (event.type === 'response.reasoning_summary_text.done') {
                const partId = `openai-${event.summary_index ?? 0}`;
                if (openThinkingParts.has(partId)) {
                    openThinkingParts.delete(partId);
                    onEvent('thinking_stop', { partId });
                }
            } else if (event.type === 'response.output_item.added') {
                // New output item — could be a function call
                if (event.item?.type === 'function_call') {
                    currentFnCall = {
                        id: event.item.call_id || event.item.id,
                        name: event.item.name || '',
                        arguments: '',
                    };
                }
            } else if (event.type === 'response.function_call_arguments.delta') {
                if (currentFnCall && event.delta) {
                    currentFnCall.arguments += event.delta;
                }
            } else if (event.type === 'response.function_call_arguments.done') {
                if (currentFnCall) {
                    let input = {};
                    try { input = JSON.parse(currentFnCall.arguments || '{}'); } catch (e) { }
                    onEvent('tool_use', {
                        id: currentFnCall.id,
                        name: currentFnCall.name,
                        input,
                    });
                    console.log(`[OpenAI] Responses stream tool_use: ${currentFnCall.name}`);
                    currentFnCall = null;
                }
            } else if (event.type === 'response.completed') {
                // Close any thinking parts that didn't receive an explicit `.done` event.
                for (const partId of openThinkingParts) {
                    onEvent('thinking_stop', { partId });
                }
                openThinkingParts.clear();
                // Capture usage and response ID from completed response
                const usage = event.response?.usage;
                if (usage) {
                    streamUsage = {
                        prompt_tokens: usage.input_tokens || 0,
                        completion_tokens: usage.output_tokens || 0,
                        total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
                        // Responses API: cache hits are in input_tokens_details
                        cached_tokens: usage.input_tokens_details?.cached_tokens || 0,
                    };
                    if (streamUsage.cached_tokens > 0) {
                        console.log(`[OpenAI] ⚡ Responses API cache hit: ${streamUsage.cached_tokens} cached tokens`);
                    }
                }
                // Capture response ID for chaining
                if (event.response?.id) {
                    streamUsage = streamUsage || {};
                    streamUsage.responseId = event.response.id;
                }
            }
        }

        onEvent('done', streamUsage || {});
    }

    /**
     * List models via SDK.
     */
    async listModels(apiKey, baseUrl) {
        try {
            const client = this.createClient(apiKey);
            const response = await client.models.list();
            const models = [];
            for await (const model of response) {
                models.push({ id: model.id, name: model.id });
            }
            return models;
        } catch (e) {
            console.error('[OpenAI] SDK listModels failed:', e.message);
            return [];
        }
    }
}

module.exports = OpenAIProvider;
