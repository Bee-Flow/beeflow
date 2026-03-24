/**
 * Base Provider Adapter
 * 
 * Shared interface that all provider adapters implement.
 * Provides default implementations using fetch + SSE parsing for OpenAI-compatible APIs.
 * 
 * Subclasses can override:
 * - buildRequestBody() — provider-specific request format
 * - getHeaders() — auth header format
 * - getChatCompletionsPath() — endpoint path
 * - chat() — non-streaming completion
 * - stream() — streaming completion with normalized events
 * - listModels() — fetch available models
 */

class BaseProvider {
    constructor(name) {
        this.name = name;
    }

    // ─── Request Building ───────────────────────────────────────────

    /**
     * Build a provider-specific request body for chat completions.
     */
    buildRequestBody(model, messages, options = {}) {
        const body = { model, messages };

        if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
        if (options.temperature !== undefined) body.temperature = options.temperature;
        if (options.stream !== undefined) body.stream = options.stream;
        if (options.tools && options.tools.length > 0) {
            body.tools = options.tools;
            body.tool_choice = options.toolChoice || 'auto';
        }
        if (options.extraBody) Object.assign(body, options.extraBody);

        return body;
    }

    /**
     * Get auth headers for this provider.
     */
    getHeaders(apiKey) {
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        return headers;
    }

    /**
     * Get the API endpoint path for chat completions.
     */
    getChatCompletionsPath() {
        return '/chat/completions';
    }

    // ─── Model capabilities ──────────────────────────────────────────

    isRestrictedModel(modelId) { return false; }
    supportsReasoning(modelId) { return false; }
    supportsVision(modelId) { return false; }

    // ─── High-Level API ──────────────────────────────────────────────

    /**
     * Non-streaming chat completion.
     * @param {string} apiKey
     * @param {string} baseUrl - Provider base URL (e.g. https://api.openai.com/v1)
     * @param {string} model
     * @param {Array} messages
     * @param {object} options - Same as buildRequestBody options
     * @returns {Promise<{content: string|null, toolCalls: Array|null, usage: object}>}
     */
    async chat(apiKey, baseUrl, model, messages, options = {}) {
        const headers = this.getHeaders(apiKey);
        const body = this.buildRequestBody(model, messages, { ...options, stream: false });
        const normalizedUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
        const url = `${normalizedUrl}${this.getChatCompletionsPath()}`;

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`${this.name} API error ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        return this._parseNonStreamingResponse(data);
    }

    /**
     * Parse a non-streaming response into normalized format.
     * Override in subclasses for different response shapes.
     */
    _parseNonStreamingResponse(data) {
        const message = data.choices?.[0]?.message;
        return {
            content: message?.content || null,
            toolCalls: message?.tool_calls || null,
            usage: data.usage || null,
            raw: data,
        };
    }

    /**
     * Streaming chat completion with normalized event callbacks.
     * @param {string} apiKey
     * @param {string} baseUrl
     * @param {string} model
     * @param {Array} messages
     * @param {object} options
     * @param {function} onEvent - Called with (eventType, data):
     *   - ('text', { text }) — text content delta
     *   - ('thinking', { text }) — reasoning/thinking delta
     *   - ('tool_use', { id, name, input }) — tool call
     *   - ('done', { usage }) — stream complete
     *   - ('error', { error }) — stream error
     */
    async stream(apiKey, baseUrl, model, messages, options = {}, onEvent) {
        const headers = this.getHeaders(apiKey);
        const body = this.buildRequestBody(model, messages, { ...options, stream: true });
        const normalizedUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
        const url = `${normalizedUrl}${this.getChatCompletionsPath()}`;

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`${this.name} API error ${response.status}: ${errorText}`);
        }

        await this._parseSseStream(response.body, onEvent);
    }

    /**
     * Parse an SSE stream (Chat Completions format).
     * Override in subclasses for different SSE event formats.
     */
    async _parseSseStream(body, onEvent) {
        const decoder = new TextDecoder();
        let buffer = '';

        for await (const chunk of body) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    onEvent('done', {});
                    return;
                }

                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.delta;
                    if (!delta) continue;

                    if (delta.content !== undefined && delta.content !== null) {
                        if (typeof delta.content === 'string') {
                            onEvent('text', { text: delta.content });
                        } else if (Array.isArray(delta.content)) {
                            // Mistral reasoning model — array of structured chunks
                            for (const block of delta.content) {
                                if (block.type === 'thinking' && Array.isArray(block.thinking)) {
                                    const text = block.thinking
                                        .filter(t => t.type === 'text' && t.text)
                                        .map(t => t.text)
                                        .join('');
                                    if (text) onEvent('thinking', { text });
                                } else if (block.type === 'text' && block.text) {
                                    onEvent('text', { text: block.text });
                                }
                            }
                        }
                    }

                    // Tool calls in streaming
                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            onEvent('tool_use', {
                                id: tc.id,
                                name: tc.function?.name,
                                input: tc.function?.arguments,
                            });
                        }
                    }
                } catch (e) {
                    // Skip malformed JSON chunks
                }
            }
        }

        onEvent('done', {});
    }

    /**
     * Fetch available models from this provider.
     * @param {string} apiKey
     * @param {string} baseUrl
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    async listModels(apiKey, baseUrl) {
        const headers = this.getHeaders(apiKey);
        const modelsUrl = baseUrl.endsWith('/v1')
            ? `${baseUrl}/models`
            : `${baseUrl}/v1/models`;

        const response = await fetch(modelsUrl, { headers });
        if (!response.ok) return [];

        const data = await response.json();
        return (data.data || []).map(m => ({ id: m.id, name: m.id }));
    }
}

module.exports = BaseProvider;
