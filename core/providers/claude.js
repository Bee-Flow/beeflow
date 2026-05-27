/**
 * Claude/Anthropic Provider Adapter
 *
 * 100% SDK-based — uses @anthropic-ai/sdk for ALL API calls.
 * No raw fetch, no base URL needed. The SDK handles endpoints internally.
 */

const BaseProvider = require("./base");
const { downscaleClaudeMessages } = require("../imageDownscale");

const DEFAULT_MAX_TOKENS = 8192;

/**
 * Drop orphan tool_use/tool_result blocks so Anthropic doesn't reject the
 * request. After compaction or aggressive history pruning, the message array
 * can contain a `tool_result` whose matching `tool_use` has been summarised
 * away — Claude returns "unexpected tool_use_id found in tool_result blocks".
 *
 * Rules enforced (mirrors the API's contract):
 *   1. tool_result.tool_use_id must reference a tool_use emitted in the
 *      immediately previous assistant message.
 *   2. Every tool_use must have a matching tool_result in the immediately
 *      following user message.
 *
 * Anything that violates either rule is dropped. Messages that become empty
 * after dropping orphans are removed from the array entirely.
 */
function repairToolPairs(messages) {
    const out = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        // user/tool_result message — keep only tool_result blocks whose id
        // appears in the previous assistant's tool_use blocks.
        if (msg.role === 'user' && Array.isArray(msg.content) && msg.content.some(b => b?.type === 'tool_result')) {
            const prev = out[out.length - 1];
            const prevToolUseIds = new Set(
                (prev?.role === 'assistant' && Array.isArray(prev.content)
                    ? prev.content.filter(b => b?.type === 'tool_use').map(b => b.id)
                    : [])
            );
            const cleaned = msg.content.filter(b => {
                if (b?.type !== 'tool_result') return true; // keep non-tool blocks (rare but legal)
                return prevToolUseIds.has(b.tool_use_id);
            });
            if (cleaned.length === 0) continue; // entire message was orphaned — drop
            out.push({ ...msg, content: cleaned });
            continue;
        }

        // assistant message with tool_use blocks — drop any tool_use whose
        // matching tool_result isn't in the next message. If all tool_uses
        // are orphaned and no other content remains, drop the message.
        if (msg.role === 'assistant' && Array.isArray(msg.content) && msg.content.some(b => b?.type === 'tool_use')) {
            const next = messages[i + 1];
            const nextResultIds = new Set(
                (next?.role === 'user' && Array.isArray(next.content)
                    ? next.content.filter(b => b?.type === 'tool_result').map(b => b.tool_use_id)
                    : [])
            );
            const cleaned = msg.content.filter(b => {
                if (b?.type !== 'tool_use') return true;
                return nextResultIds.has(b.id);
            });
            const hasMeaningful = cleaned.some(b => b?.type === 'text' || b?.type === 'tool_use' || b?.type === 'thinking');
            if (!hasMeaningful) continue; // assistant turn was nothing but orphan tool_uses — drop
            out.push({ ...msg, content: cleaned });
            continue;
        }

        out.push(msg);
    }
    return out;
}

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
                // Convert OpenAI image_url → Claude native image block.
                // Preserve cache_control if the caller marked it (directChat
                // tags the last attachment block to extend the cache prefix).
                if (block.type === 'image_url') {
                    const url = typeof block.image_url === 'string'
                        ? block.image_url
                        : block.image_url?.url || '';
                    const preserved = block.cache_control ? { cache_control: block.cache_control } : {};
                    if (url.startsWith('data:')) {
                        const match = url.match(/^data:([^;]+);base64,(.+)$/s);
                        if (match) {
                            return {
                                type: 'image',
                                source: { type: 'base64', media_type: match[1], data: match[2] },
                                ...preserved,
                            };
                        }
                    } else if (url.startsWith('http')) {
                        return {
                            type: 'image',
                            source: { type: 'url', url },
                            ...preserved,
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

        // ─── Prompt caching ──────────────────────────────────────────
        // Anthropic allows up to 4 cache_control breakpoints per request and
        // requires longer TTLs to appear earlier in the wire order. The
        // adapter already places one 1h breakpoint on the first system block
        // (extractSystem) which caches "tools + stable system" together.
        // Here we add up to three 5-min breakpoints further down the request:
        //
        //   (a) Immediately after the compaction summary block, if present.
        //       This lets Anthropic cache (tools + system + summary) as a
        //       durable prefix that stays stable across many turns, even as
        //       the recent-window messages keep changing.
        //
        //   (b) On the last genuine user text message. This creates a
        //       shorter-lived breakpoint so the next turn can still hit the
        //       cache for "system + tools + summary + full recent history".
        //       Skipped if the message already has a cache_control marker
        //       set upstream (e.g. directChat attaches one to the last file
        //       block so the document content gets cached).
        //
        //   (c) On the last tool_result in a multi-turn agent loop. Each
        //       extra round otherwise re-tokenises the full tool history at
        //       full price. Tool_result blocks DO support cache_control per
        //       Anthropic docs.
        //
        // Total breakpoints used: 1 (system, 1h) + up to 3 (5-min) = 4 max,
        // exactly at the 4-breakpoint cap.
        //
        // All skipped for very short conversations (<4 messages) where
        // caching overhead isn't worth it.
        const hasCacheControl = (msg) => {
            if (!Array.isArray(msg.content)) return false;
            return msg.content.some(b => b && typeof b === 'object' && b.cache_control);
        };

        const markLastTextBlock = (msg) => {
            if (typeof msg.content === 'string' && msg.content.trim()) {
                msg.content = [{
                    type: "text",
                    text: msg.content,
                    cache_control: { type: "ephemeral" },
                }];
                return true;
            }
            if (Array.isArray(msg.content) && msg.content.length > 0) {
                for (let j = msg.content.length - 1; j >= 0; j--) {
                    if (msg.content[j].type === 'text') {
                        msg.content[j].cache_control = { type: "ephemeral" };
                        return true;
                    }
                }
            }
            return false;
        };

        const markLastToolResultBlock = (msg) => {
            if (!Array.isArray(msg.content) || msg.content.length === 0) return false;
            for (let j = msg.content.length - 1; j >= 0; j--) {
                if (msg.content[j].type === 'tool_result') {
                    msg.content[j].cache_control = { type: "ephemeral" };
                    return true;
                }
            }
            return false;
        };

        const isSummaryMessage = (msg) => {
            if (msg.role !== 'user') return false;
            const text = typeof msg.content === 'string'
                ? msg.content
                : Array.isArray(msg.content)
                    ? (msg.content.find(b => b.type === 'text')?.text || '')
                    : '';
            return text.startsWith('[Conversation Summary');
        };

        if (normalized.length >= 4) {
            let breakpointsUsed = 0;
            const BREAKPOINT_BUDGET = 3; // (a) summary, (b) last-user-text, (c) last-tool_result

            // Count pre-existing markers (e.g. attachment caching set in directChat).
            for (const msg of normalized) {
                if (hasCacheControl(msg)) breakpointsUsed += 1;
            }

            // (a) Breakpoint on the summary message, if the compactor inserted one.
            const summaryIdx = normalized.findIndex(isSummaryMessage);
            if (summaryIdx >= 0 && !hasCacheControl(normalized[summaryIdx]) && breakpointsUsed < BREAKPOINT_BUDGET) {
                if (markLastTextBlock(normalized[summaryIdx])) breakpointsUsed += 1;
            }

            // (b) Breakpoint on the last genuine user text message — skipped
            //     if the message already carries a marker (attachment cache).
            if (breakpointsUsed < BREAKPOINT_BUDGET) {
                for (let i = normalized.length - 1; i >= 0; i--) {
                    const msg = normalized[i];
                    if (msg.role !== 'user') continue;
                    if (i === summaryIdx) continue; // already marked above
                    if (hasCacheControl(msg)) continue; // upstream already marked
                    if (Array.isArray(msg.content) && msg.content.some(b => b.type === 'tool_result')) continue;
                    if (markLastTextBlock(msg)) { breakpointsUsed += 1; break; }
                }
            }

            // (c) Breakpoint on the latest tool_result, if any. Multi-turn
            //     agent loops re-send the full tool-call chain every round;
            //     caching the last tool_result lets the next iteration read
            //     the prior context at 10% cost.
            if (breakpointsUsed < BREAKPOINT_BUDGET) {
                for (let i = normalized.length - 1; i >= 0; i--) {
                    const msg = normalized[i];
                    if (msg.role !== 'user') continue;
                    if (hasCacheControl(msg)) continue;
                    if (!Array.isArray(msg.content) || !msg.content.some(b => b.type === 'tool_result')) continue;
                    if (markLastToolResultBlock(msg)) { breakpointsUsed += 1; break; }
                }
            }
        }

        // ─── Drop orphan tool_use / tool_result pairs ───────────────────
        // Anthropic rejects the request with `messages.N.content.0:
        // unexpected tool_use_id` whenever a tool_result references a
        // tool_use_id that doesn't appear in the immediately previous
        // assistant message. This happens after compaction collapses an
        // assistant(tool_use) into a summary while leaving its matching
        // tool_result in the recent window, or when conversation persistence
        // strips tool_calls but keeps the tool messages.
        //
        // We walk the array in order, tracking which tool_use ids the latest
        // assistant message emitted, and drop any tool_result block that
        // references an unknown id. Symmetrically, drop any tool_use block
        // whose result isn't in the immediately following user message — an
        // assistant turn ending in tool_use without a matching result is
        // also rejected by the API. Empty messages get filtered out.
        return repairToolPairs(normalized);
    }

    extractSystem(messages) {
        const systemMessages = messages.filter((m) => m?.role === "system");
        if (!systemMessages.length) return undefined;

        // Per-message blocks let the caller layer caching by stability:
        //   - First system message = stable identity + tooling + project
        //     context. Gets a 1-hour ephemeral breakpoint so an active user
        //     hitting the same agent for an afternoon reads from cache for
        //     hours at -90%, paying the +100% write only once. Min prefix
        //     length per Opus 4.x is 4096 tokens; shorter prefixes silently
        //     bypass caching.
        //   - Subsequent system messages (e.g. the volatile timestamp emitted
        //     by directChat) get NO cache_control so they don't churn writes.
        //     Anthropic still serves cached prefix from the first breakpoint.
        const blocks = systemMessages.map((m, i) => {
            const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            const block = { type: "text", text };
            if (i === 0) {
                block.cache_control = { type: "ephemeral", ttl: "1h" };
            }
            return block;
        });
        return blocks;
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
            // Tools come before system in Anthropic's wire format. Per the
            // mixed-TTL rule ("longer TTL must appear first"), placing a
            // 5-min breakpoint on tools while system has a 1-hour breakpoint
            // would violate ordering. The system block-1 1h breakpoint
            // already caches "tools + system" as a single prefix, so the
            // standalone tools breakpoint is redundant — drop it.
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
        await downscaleClaudeMessages(params.messages);

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
        await downscaleClaudeMessages(params.messages);

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
                    const u = finalMessage.usage;
                    const cacheCreate5m = u.cache_creation?.ephemeral_5m_input_tokens || 0;
                    const cacheCreate1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
                    const cacheCreateTotal = u.cache_creation_input_tokens
                        || (cacheCreate5m + cacheCreate1h)
                        || 0;
                    // When both TTLs were written, attribute the row to the
                    // dominant TTL so cost stays approximately right. Mixed
                    // writes are rare in this codebase (only system gets 1h).
                    let cacheTtl = null;
                    if (cacheCreate1h > 0 && cacheCreate1h >= cacheCreate5m) cacheTtl = '1h';
                    else if (cacheCreate5m > 0) cacheTtl = '5m';
                    else if (cacheCreateTotal > 0) cacheTtl = '1h';  // fallback: extractSystem places a 1h breakpoint
                    streamUsage = {
                        prompt_tokens: u.input_tokens || 0,
                        completion_tokens: u.output_tokens || 0,
                        total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
                        cached_tokens: u.cache_read_input_tokens || 0,
                        cache_creation_tokens: cacheCreateTotal,
                        cache_ttl: cacheTtl,
                        stop_reason: finalMessage.stop_reason || null,
                    };
                    if (streamUsage.cached_tokens > 0) {
                        console.log(`[Claude] ⚡ Cache hit: ${streamUsage.cached_tokens} cached input tokens (saved ~${Math.round(streamUsage.cached_tokens * 0.9)} token-equivalents)`);
                    }
                    if (streamUsage.cache_creation_tokens > 0) {
                        console.log(`[Claude] 📦 Cache created: ${streamUsage.cache_creation_tokens} tokens (ttl=${streamUsage.cache_ttl}, 5m=${cacheCreate5m}, 1h=${cacheCreate1h})`);
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