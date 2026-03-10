/**
 * Claude/Anthropic Provider Adapter
 *
 * 100% SDK-based — uses @anthropic-ai/sdk for ALL API calls.
 * No raw fetch, no base URL needed. The SDK handles endpoints internally.
 */

const BaseProvider = require("./base");

const DEFAULT_MAX_TOKENS = 8192;

class ClaudeProvider extends BaseProvider {
    constructor() {
        super("claude");
    }

    // ─── SDK Client ──────────────────────────────────────────────

    createClient(apiKey) {
        const Anthropic = require('@anthropic-ai/sdk');
        return new Anthropic({ apiKey });
    }

    // ─── Message Normalization ───────────────────────────────────

    normalizeContent(content) {
        if (content == null) return "";
        if (Array.isArray(content)) return content;
        if (typeof content === "string") return content;
        return JSON.stringify(content);
    }

    normalizeMessages(messages) {
        return messages
            .filter((m) => m && m.role && m.role !== "system")
            .map((m) => {
                if (m.role === "tool") {
                    // Convert OpenAI tool response → Claude tool_result block
                    const toolUseId = m.tool_call_id || m.toolCallId || m.id;
                    return {
                        role: "user",
                        content: [{
                            type: "tool_result",
                            tool_use_id: toolUseId || "unknown_tool_use_id",
                            content: this.normalizeContent(m.content),
                        }],
                    };
                }
                if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
                    // Convert OpenAI assistant tool_calls → Claude tool_use content blocks
                    const contentBlocks = [];
                    if (m.content) {
                        contentBlocks.push({ type: "text", text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) });
                    }
                    for (const tc of m.tool_calls) {
                        const fn = tc.function || tc;
                        let input = {};
                        try { input = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : (fn.arguments || fn.input || {}); } catch (e) { }
                        contentBlocks.push({
                            type: "tool_use",
                            id: tc.id,
                            name: fn.name,
                            input,
                        });
                    }
                    return { role: "assistant", content: contentBlocks };
                }
                return {
                    role: m.role,
                    content: this.normalizeContent(m.content),
                };
            });
    }

    extractSystem(messages) {
        const systemMessages = messages.filter((m) => m?.role === "system");
        if (!systemMessages.length) return undefined;
        const text = systemMessages
            .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
            .join("\n\n");
        // Return as array of content blocks with cache_control on the last block
        // This enables Anthropic prompt caching — 90% cost reduction on cached prefix
        return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
    }

    // ─── Thinking/Reasoning ──────────────────────────────────────

    buildThinking(model, options = {}) {
        if (!this.supportsReasoning(model)) return undefined;

        // Direct budget_tokens override from UI takes priority
        if (options.budgetTokens && options.budgetTokens > 0) {
            return { type: "enabled", budget_tokens: options.budgetTokens };
        }

        // Fall back to label-based effort mapping
        const effortRaw = options.reasoningEffort;
        if (!effortRaw || effortRaw === "none") return undefined;

        // Claude API uses { type: "enabled", budget_tokens: N }
        const BUDGET_MAP = {
            low: 5000,
            minimal: 5000,
            medium: 10000,
            high: 20000,
            xhigh: 50000,
        };
        const budget = BUDGET_MAP[effortRaw] || 10000;
        return { type: "enabled", budget_tokens: budget };
    }

    supportsReasoning(modelId) {
        return /^claude-(opus|sonnet|haiku)-4/.test(modelId);
    }

    // ─── Tool Normalization ──────────────────────────────────────

    normalizeTools(tools = []) {
        return tools.map((t) => {
            const fn = t.function || t;
            return {
                name: fn.name,
                description: fn.description || "",
                input_schema: fn.parameters || fn.input_schema || {},
            };
        });
    }

    // ─── SDK Params Builder ──────────────────────────────────────

    _buildSdkParams(model, messages, options = {}) {
        const params = {
            model,
            messages: this.normalizeMessages(messages),
            max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        };

        const system = this.extractSystem(messages);
        if (system) params.system = system;

        if (options.temperature !== undefined) params.temperature = options.temperature;

        if (options.tools && options.tools.length > 0) {
            const normalizedTools = this.normalizeTools(options.tools);
            // Add cache_control on the last tool for prompt caching
            if (normalizedTools.length > 0) {
                normalizedTools[normalizedTools.length - 1].cache_control = { type: "ephemeral" };
            }
            params.tools = normalizedTools;
            if (options.toolChoice === "auto") params.tool_choice = { type: "auto" };
            if (options.toolChoice === "any" || options.toolChoice === "required") {
                params.tool_choice = { type: "any" };
            }
            if (options.toolChoice && typeof options.toolChoice === "object" && options.toolChoice.name) {
                params.tool_choice = { type: "tool", name: options.toolChoice.name };
            }
        }

        const thinking = this.buildThinking(model, options);
        if (thinking) {
            params.thinking = thinking;
            // Anthropic requires temperature=1 when thinking is enabled
            params.temperature = 1;
            // Ensure max_tokens covers budget + answer room
            if (thinking.budget_tokens && params.max_tokens < thinking.budget_tokens + 1024) {
                params.max_tokens = thinking.budget_tokens + 1024;
            }
        }

        return params;
    }

    // ─── High-Level API (all SDK) ────────────────────────────────

    /**
     * Non-streaming chat via SDK.
     * baseUrl is accepted for interface compatibility but ignored — SDK handles it.
     */
    async chat(apiKey, baseUrl, model, messages, options = {}) {
        const client = this.createClient(apiKey);
        const params = this._buildSdkParams(model, messages, options);

        console.log('[Claude] SDK chat for model:', model);
        const response = await client.messages.create(params);

        const textContent = response.content
            ?.filter(c => c.type === 'text')
            .map(c => c.text)
            .join('') || null;

        const toolCalls = response.content
            ?.filter(c => c.type === 'tool_use')
            .map(c => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.input) },
            }));

        return {
            content: textContent,
            toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : null,
            stopReason: response.stop_reason,
            usage: response.usage || null,
            raw: response,
        };
    }

    /**
     * Streaming chat via SDK.
     * baseUrl is accepted for interface compatibility but ignored.
     */
    async stream(apiKey, baseUrl, model, messages, options = {}, onEvent) {
        const client = this.createClient(apiKey);
        const params = this._buildSdkParams(model, messages, options);

        console.log('[Claude] SDK streaming for model:', model);
        console.log('[Claude] Params:', JSON.stringify({
            model: params.model,
            max_tokens: params.max_tokens,
            temperature: params.temperature,
            thinking: params.thinking || 'disabled',
            tools: params.tools ? `${params.tools.length} tool(s)` : 'none',
            messageCount: params.messages?.length || 0,
        }));

        let textChunks = 0;
        let thinkingChunks = 0;
        let eventCount = 0;
        let currentToolUse = null; // Track in-progress tool_use block
        let streamUsage = null;

        try {
            const stream = await client.messages.stream(params);

            for await (const event of stream) {
                eventCount++;
                if (event.type === 'content_block_delta') {
                    if (event.delta?.type === 'text_delta' && event.delta?.text) {
                        textChunks++;
                        onEvent('text', { text: event.delta.text });
                    } else if (event.delta?.type === 'thinking_delta' && event.delta?.thinking) {
                        thinkingChunks++;
                        onEvent('thinking', { text: event.delta.thinking });
                    } else if (event.delta?.type === 'input_json_delta' && event.delta?.partial_json) {
                        // Accumulate tool call JSON arguments
                        if (currentToolUse) {
                            currentToolUse.arguments += event.delta.partial_json;
                        }
                    }
                } else if (event.type === 'content_block_start') {
                    if (event.content_block?.type === 'tool_use') {
                        // Start accumulating a new tool call
                        currentToolUse = {
                            id: event.content_block.id,
                            name: event.content_block.name,
                            arguments: '',
                        };
                        console.log('[Claude] Tool use block start:', event.content_block.name);
                    }
                } else if (event.type === 'content_block_stop') {
                    // Emit accumulated tool call when block ends
                    if (currentToolUse) {
                        let input = {};
                        try { input = JSON.parse(currentToolUse.arguments || '{}'); } catch (e) { }
                        onEvent('tool_use', {
                            id: currentToolUse.id,
                            name: currentToolUse.name,
                            input,
                        });
                        console.log(`[Claude] Stream tool_use: ${currentToolUse.name}`);
                        currentToolUse = null;
                    }
                } else if (event.type === 'message_start') {
                    // normal start
                } else if (event.type === 'message_delta') {
                    // normal delta
                } else if (event.type === 'message_stop') {
                    // normal stop
                } else if (event.type === 'error') {
                    console.error('[Claude] Stream error event:', JSON.stringify(event));
                    onEvent('error', { error: event.error?.message || 'Unknown stream error' });
                }
            }

            // Try to get the final message for usage info
            try {
                const finalMessage = await stream.finalMessage();
                console.log('[Claude] Final message — stop_reason:', finalMessage.stop_reason,
                    'usage:', JSON.stringify(finalMessage.usage));
                if (finalMessage.usage) {
                    streamUsage = {
                        prompt_tokens: finalMessage.usage.input_tokens || 0,
                        completion_tokens: finalMessage.usage.output_tokens || 0,
                        total_tokens: (finalMessage.usage.input_tokens || 0) + (finalMessage.usage.output_tokens || 0),
                    };
                }
            } catch (e) {
                // already consumed
            }
        } catch (err) {
            console.error('[Claude] Stream error:', err.message);
            if (err.status) console.error('[Claude] Error status:', err.status);
            if (err.error) console.error('[Claude] API error body:', JSON.stringify(err.error));
            onEvent('error', { error: `Claude API error: ${err.message}` });
        }

        console.log(`[Claude] Stream complete — ${eventCount} events, ${textChunks} text chunks, ${thinkingChunks} thinking chunks`);
        onEvent('done', streamUsage || {});
    }

    /**
     * List models via SDK.
     * baseUrl is accepted for interface compatibility but ignored.
     */
    async listModels(apiKey, baseUrl) {
        try {
            const client = this.createClient(apiKey);
            const response = await client.models.list();
            return (response.data || []).map(m => ({ id: m.id, name: m.display_name || m.id }));
        } catch (e) {
            console.error('[Claude] SDK listModels failed:', e.message);
            return [];
        }
    }
}

module.exports = ClaudeProvider;