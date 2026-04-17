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
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            return content.map(block => {
                // Convert OpenAI image_url → Claude native image block
                if (block.type === 'image_url') {
                    const url = typeof block.image_url === 'string'
                        ? block.image_url
                        : block.image_url?.url || '';
                    if (url.startsWith('data:')) {
                        const match = url.match(/^data:([^;]+);base64,(.+)$/s);
                        if (match) {
                            return {
                                type: 'image',
                                source: { type: 'base64', media_type: match[1], data: match[2] },
                            };
                        }
                    } else if (url.startsWith('http')) {
                        return {
                            type: 'image',
                            source: { type: 'url', url },
                        };
                    }
                    return null; // Skip if unresolvable
                }
                return block;
            }).filter(Boolean);
        }
        return JSON.stringify(content);
    }

    normalizeMessages(messages) {
        const normalized = messages
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
                    // Convert OpenAI assistant tool_calls → Claude tool_use content blocks.
                    // When the prior turn had extended thinking WITH signatures, Anthropic
                    // requires the thinking blocks to precede the tool_use blocks on replay
                    // or conversation integrity breaks. Unsigned thinking is dropped.
                    const contentBlocks = [];
                    const signedThinking = Array.isArray(m.thinking)
                        ? m.thinking.filter(t => t && t.signature && !t.redacted && t.text)
                        : [];
                    for (const t of signedThinking) {
                        contentBlocks.push({ type: "thinking", thinking: t.text, signature: t.signature });
                    }
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

        // ─── Prompt caching: mark the last genuine user text message for cache_control
        // This creates a cache breakpoint so the entire prefix (system + tools +
        // all history up to this point) can be reused on the next turn.
        // Only applies when there's enough history to benefit from caching (4+ messages).
        // Skips tool_result blocks (converted from tool role) — cache_control is only
        // valid on text-type content blocks.
        if (normalized.length >= 4) {
            for (let i = normalized.length - 1; i >= 0; i--) {
                const msg = normalized[i];
                if (msg.role !== 'user') continue;
                // Skip tool_result messages (originally role:"tool", converted to role:"user")
                if (Array.isArray(msg.content) && msg.content.some(b => b.type === 'tool_result')) {
                    continue;
                }
                if (typeof msg.content === 'string' && msg.content.trim()) {
                    // Convert string content to block format with cache_control
                    msg.content = [{
                        type: "text",
                        text: msg.content,
                        cache_control: { type: "ephemeral" },
                    }];
                } else if (Array.isArray(msg.content) && msg.content.length > 0) {
                    // Find the last text block and add cache_control to it
                    for (let j = msg.content.length - 1; j >= 0; j--) {
                        if (msg.content[j].type === 'text') {
                            msg.content[j].cache_control = { type: "ephemeral" };
                            break;
                        }
                    }
                }
                break; // Only mark one message
            }
        }

        return normalized;
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

        const effortRaw = options.reasoningEffort;
        if (effortRaw === 'none') return undefined; // Explicitly disabled

        // Opus 4.7 rejects manual budget_tokens — adaptive is the only supported mode.
        // Older 4.x models still accept budget_tokens but adaptive is recommended.
        const isOpus47 = /^claude-opus-4-7/.test(model);
        if (!isOpus47 && options.budgetTokens && options.budgetTokens > 0) {
            return { thinking: { type: "enabled", budget_tokens: options.budgetTokens } };
        }

        // Adaptive thinking: effort is passed via output_config (top-level), not nested in thinking.
        // Opus 4.7 supports: low, medium, high (default), xhigh, max
        // Opus 4.6 / Sonnet 4.6 support: low, medium, high, max (no xhigh — map it to max)
        const EFFORT_MAP_OPUS47 = { low: 'low', minimal: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
        const EFFORT_MAP_LEGACY = { low: 'low', minimal: 'low', medium: 'medium', high: 'high', xhigh: 'max', max: 'max' };
        const map = isOpus47 ? EFFORT_MAP_OPUS47 : EFFORT_MAP_LEGACY;
        const effort = map[effortRaw] || 'medium';
        return { thinking: { type: "adaptive" }, effort };
    }

    supportsReasoning(modelId) {
        // Opus 4.7, Opus 4.6, Sonnet 4.6 support adaptive thinking. Haiku 4.5 does not.
        if (/^claude-haiku-4-5/.test(modelId)) return false;
        return /^claude-(opus|sonnet)-4/.test(modelId);
    }

    supportsVision(modelId) {
        // Claude 3+ and Claude 4+ series all support image input
        return /claude-3|claude-3-5|claude-3-7|claude-opus-4|claude-sonnet-4|claude-haiku-4|claude-mythos/.test(modelId);
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

        const thinkingConfig = this.buildThinking(model, options);
        if (thinkingConfig) {
            params.thinking = thinkingConfig.thinking;
            // Anthropic requires temperature=1 when thinking is enabled
            params.temperature = 1;
            if (thinkingConfig.thinking.type === 'adaptive') {
                // effort belongs inside output_config per SDK v0.78.0 OutputConfig interface
                if (thinkingConfig.effort) {
                    params.output_config = { effort: thinkingConfig.effort };
                }
                // Ensure enough room for thinking + answer
                if (params.max_tokens < 16384) params.max_tokens = 16384;
            } else if (thinkingConfig.thinking.budget_tokens && params.max_tokens < thinkingConfig.thinking.budget_tokens + 1024) {
                // Legacy budget_tokens mode
                params.max_tokens = thinkingConfig.thinking.budget_tokens + 1024;
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
            output_config: params.output_config || 'n/a',
            tools: params.tools ? `${params.tools.length} tool(s)` : 'none',
            messageCount: params.messages?.length || 0,
        }));

        let textChunks = 0;
        let thinkingChunks = 0;
        let eventCount = 0;
        let currentToolUse = null; // Track in-progress tool_use block
        let currentThinking = null; // Track in-progress thinking / redacted_thinking block
        let thinkingPartCounter = 0;
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
                        onEvent('thinking', {
                            text: event.delta.thinking,
                            partId: currentThinking?.partId,
                        });
                    } else if (event.delta?.type === 'signature_delta' && event.delta?.signature) {
                        // Server-side only — signature is persisted onto the thinking block
                        // and echoed back to Anthropic on multi-turn tool flows. Never shown to UI.
                        if (currentThinking) {
                            currentThinking.signature = event.delta.signature;
                            onEvent('thinking_signature', {
                                partId: currentThinking.partId,
                                signature: event.delta.signature,
                            });
                        }
                    } else if (event.delta?.type === 'input_json_delta' && event.delta?.partial_json) {
                        // Accumulate tool call JSON arguments
                        if (currentToolUse) {
                            currentToolUse.arguments += event.delta.partial_json;
                        }
                    }
                } else if (event.type === 'content_block_start') {
                    const blockType = event.content_block?.type;
                    if (blockType === 'tool_use') {
                        // Start accumulating a new tool call
                        currentToolUse = {
                            id: event.content_block.id,
                            name: event.content_block.name,
                            arguments: '',
                        };
                        console.log('[Claude] Tool use block start:', event.content_block.name);
                    } else if (blockType === 'thinking') {
                        currentThinking = {
                            partId: `claude-${thinkingPartCounter++}`,
                            redacted: false,
                            signature: null,
                        };
                        onEvent('thinking_start', { partId: currentThinking.partId });
                    } else if (blockType === 'redacted_thinking') {
                        currentThinking = {
                            partId: `claude-${thinkingPartCounter++}`,
                            redacted: true,
                            signature: null,
                        };
                        onEvent('thinking_start', { partId: currentThinking.partId, redacted: true });
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
                    } else if (currentThinking) {
                        onEvent('thinking_stop', {
                            partId: currentThinking.partId,
                            redacted: currentThinking.redacted || undefined,
                        });
                        currentThinking = null;
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
                        // Cache metrics — track cache reads and creation for cost optimization
                        cached_tokens: finalMessage.usage.cache_read_input_tokens || 0,
                        cache_creation_tokens: finalMessage.usage.cache_creation_input_tokens || 0,
                    };
                    if (streamUsage.cached_tokens > 0) {
                        console.log(`[Claude] ⚡ Cache hit: ${streamUsage.cached_tokens} cached input tokens (saved ~${Math.round(streamUsage.cached_tokens * 0.9)} token-equivalents)`);
                    }
                    if (streamUsage.cache_creation_tokens > 0) {
                        console.log(`[Claude] 📦 Cache created: ${streamUsage.cache_creation_tokens} tokens cached for future requests`);
                    }
                }
            } catch (e) {
                // already consumed
            }
        } catch (err) {
            console.error('[Claude] Stream error:', err.message);
            if (err.status) console.error('[Claude] Error status:', err.status);
            if (err.error) console.error('[Claude] API error body:', JSON.stringify(err.error));
            // Enrich the error with status info for upstream retry classification
            if (err.status && !err.message.includes(`API error ${err.status}`)) {
                err.message = `API error ${err.status}: ${JSON.stringify(err.error || err.message)}`;
            }
            throw err;  // Let retryStreamCall handle retry/classify
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