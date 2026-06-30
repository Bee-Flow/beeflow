/**
 * LLM Client — Unified facade for all LLM provider interactions.
 * 
 * Routes call this instead of touching provider adapters directly.
 * Handles: provider resolution, adapter selection, normalized event dispatching.
 */

const { getAdapter, GoogleProvider } = require('./providers');
const { getProviderForModel } = require('./aiAgent');

/**
 * Build the provider-correct `toolChoice` that forces the model to call exactly
 * one named tool. response_format/json_schema is NOT honoured by any adapter, so
 * forced structured output rides on a forced tool call instead.
 *
 * - openai / claude / mistral / generic OpenAI-compatible adapters all accept the
 *   OpenAI object form `{type:'function',function:{name}}`:
 *     · openai.js  → mapToolChoice passes objects through
 *     · claude.js  → maps an object with `.name` → {type:'tool',name}
 *     · mistral.js → mapToolChoice passes objects through (Mistral wire format
 *                    accepts {type:'function',function:{name}})
 *     · base.js    → tool_choice = options.toolChoice (object passthrough)
 * - GOOGLE (and google-vertex, which extends GoogleProvider) has NO object/name
 *   case — it only maps 'required'/'any' → functionCallingConfig.mode ANY. With a
 *   SINGLE-tool list, mode ANY is equivalent to forcing that one tool, so we pass
 *   the string 'required' instead of the object. Callers must also pass a
 *   single-tool list (tools:[toolDef]) for Google forcing to be deterministic.
 *
 * @param {object} adapter   - resolved provider adapter instance
 * @param {string} toolName  - the function name to force
 * @returns {object|string}  - object form, or 'required' for the Google family
 */
function forcedToolChoice(adapter, toolName) {
    // Isolated Google nuance: single-tool list + 'required' === force-that-tool.
    if (adapter instanceof GoogleProvider) {
        return 'required';
    }
    return { type: 'function', function: { name: toolName } };
}

/**
 * Best-effort parse of a forced tool call's arguments into a plain object.
 * Arguments arrive as a JSON string (OpenAI/Mistral/generic) or as an already
 * parsed object (Claude/Google `input`). Never throws — returns null on any
 * absence/parse failure so callers get untrusted-but-safe structured output.
 */
function parseToolCallArgs(toolCall) {
    if (!toolCall) return null;
    const rawArgs = toolCall.function?.arguments ?? toolCall.input;
    if (rawArgs == null) return null;
    if (typeof rawArgs === 'object') return rawArgs;
    if (typeof rawArgs !== 'string') return null;
    try {
        const parsed = JSON.parse(rawArgs);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

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
            // apiVersion is required by the Azure adapter (api-version query
            // param). The direct-chat tier path forwards it; dropping it here
            // silently broke Azure-hosted calls (e.g. title generation).
            apiVersion: config.apiVersion || null,
        };
    }

    /**
     * Non-streaming chat completion.
     * @returns {Promise<{content, toolCalls, usage}>}
     */
    async chat(modelId, messages, options = {}) {
        const { apiKey, baseUrl, adapter, project, location, serviceAccountKey, apiVersion } = await this._resolve(modelId);
        return adapter.chat(apiKey, baseUrl, modelId, messages, { ...options, project, location, serviceAccountKey, apiVersion });
    }

    /**
     * Forced structured output via a single forced tool call.
     *
     * No adapter honours response_format/json_schema, so the only reliable way to
     * get a typed object out of a model is to FORCE it to call one tool exactly
     * once and read that call's arguments. This resolves the provider, builds the
     * provider-correct forcing toolChoice (see forcedToolChoice), runs ONE
     * non-streaming chat with `tools:[toolDef]`, and parses the first tool call.
     *
     * The model's output is UNTRUSTED — `structured` is null when the model
     * declined the tool or emitted unparseable arguments. This never throws on
     * the parse path; callers must clamp/validate the returned object.
     *
     * @param {string} modelId
     * @param {Array}  messages  - chat messages
     * @param {object} toolDef   - OpenAI-format tool def: {type:'function',function:{name,description,parameters}}
     * @param {object} [options] - extra chat options (maxTokens, temperature, …); tools/toolChoice are overridden
     * @returns {Promise<{structured: object|null, content: string|null, usage: object|undefined, raw: any}>}
     */
    async chatForcedTool(modelId, messages, toolDef, options = {}) {
        const { apiKey, baseUrl, adapter, project, location, serviceAccountKey, apiVersion } = await this._resolve(modelId);
        const toolName = toolDef?.function?.name;
        const result = await adapter.chat(apiKey, baseUrl, modelId, messages, {
            ...options,
            project,
            location,
            serviceAccountKey,
            apiVersion,
            tools: [toolDef],
            toolChoice: forcedToolChoice(adapter, toolName),
        });
        const structured = parseToolCallArgs(result?.toolCalls?.[0]);
        return {
            structured,
            content: result?.content ?? null,
            usage: result?.usage,
            raw: result?.raw,
        };
    }

    /**
     * Streaming chat completion with normalized event callbacks.
     * @param {function} onEvent - Called with (type, data):
     *   text, thinking, tool_use, done, error
     */
    async stream(modelId, messages, options = {}, onEvent) {
        const { apiKey, baseUrl, adapter, project, location, serviceAccountKey, apiVersion } = await this._resolve(modelId);
        return adapter.stream(apiKey, baseUrl, modelId, messages, { ...options, project, location, serviceAccountKey, apiVersion }, onEvent);
    }

    /**
     * Build the tool-free [system, user] message pair for title generation.
     * Returns null when there's no usable user content.
     */
    _buildTitleMessages(userMessage, systemPrompt, maxInputChars = 500) {
        // Empty/whitespace user content is a fast no-op: Anthropic and others
        // reject `messages.0` with no content.
        const safeUserContent = typeof userMessage === 'string'
            ? userMessage.slice(0, maxInputChars)
            : (userMessage == null ? '' : JSON.stringify(userMessage).slice(0, maxInputChars));
        if (!safeUserContent || !safeUserContent.trim()) return null;
        // Title generation is a tool-free task. State that explicitly so the
        // model doesn't try to "use" tools or emit code blocks — observed when
        // a tool-heavy chat's transcript primes it toward code output.
        const toolFreeNote = 'You have NO tools and cannot browse the web or run code — only read the conversation and output a short title (no code blocks).';
        const defaultTitlePrompt = `You are naming a chat conversation. ${toolFreeNote} Output a short 2-5 word title (max ~40 characters) describing its topic. Output ONLY the title — no quotes, no extra text.`;
        // Ensure the tool-free guarantee is present even when an admin-edited
        // system-agent prompt (which predates this) is supplied.
        let titleSystemPrompt = defaultTitlePrompt;
        if (systemPrompt && systemPrompt.trim()) {
            titleSystemPrompt = /no tools/i.test(systemPrompt) ? systemPrompt : `${systemPrompt}\n\n${toolFreeNote}`;
        }
        return [
            { role: 'system', content: titleSystemPrompt },
            { role: 'user', content: safeUserContent },
        ];
    }

    /** Defensive title sanitisation — strip code fences/tags, collapse, cap. */
    _sanitiseTitle(raw) {
        let cleaned = (raw || '').trim().replace(/[\"']/g, '');
        // If it opens with a code fence it's almost certainly hallucinated code.
        if (/^```/.test(cleaned)) return 'New Chat';
        cleaned = cleaned.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return 'New Chat';
        if (cleaned.length > 80) cleaned = cleaned.slice(0, 80).trim();
        return cleaned;
    }

    /**
     * Generate a title using an ALREADY-RESOLVED provider/adapter — the exact
     * same primitives the direct-chat tier path uses (getProviderForModel +
     * getAdapter → adapter.chat(apiKey, apiUrl, modelId, msgs, { …, apiVersion })).
     * Callers that have already resolved the provider (e.g. directChat, which
     * shares the conversation's adapter) pass it in so there's no second
     * lookup and no chance of a divergent resolution.
     * @param {{adapter, apiKey, apiUrl, modelId, apiVersion}} provider
     */
    async generateTitleWithProvider(provider, userMessage, systemPrompt, options = {}) {
        const { adapter, apiKey, apiUrl, modelId, apiVersion } = provider || {};
        if (!adapter || !modelId) return 'New Chat';
        const { maxInputChars = 500, ...chatOpts } = options;
        const messages = this._buildTitleMessages(userMessage, systemPrompt, maxInputChars);
        if (!messages) return 'New Chat';
        try {
            const result = await adapter.chat(apiKey, apiUrl, modelId, messages, {
                maxTokens: 64,
                temperature: 0.3,
                budgetTokens: 0,           // Disable thinking — title gen is trivial
                reasoningEffort: 'none',   // Disable reasoning for OpenAI models too
                apiVersion: apiVersion || undefined,
                ...chatOpts,
            });
            return this._sanitiseTitle(result.content || '');
        } catch (e) {
            console.error('[LLMClient.generateTitle] inference failed:', e.message);
            return 'New Chat';
        }
    }

    /**
     * Generate a short title for a conversation. Resolves the provider the same
     * way the chat-tier path does (via _resolve → getProviderForModel +
     * getAdapter, now including apiVersion) and delegates to
     * generateTitleWithProvider, so a provider error returns 'New Chat' instead
     * of bubbling.
     */
    async generateTitle(modelId, userMessage, systemPrompt, options = {}) {
        let r;
        try {
            r = await this._resolve(modelId);
        } catch (e) {
            console.error('[LLMClient.generateTitle] provider resolution failed:', e.message);
            return 'New Chat';
        }
        return this.generateTitleWithProvider(
            { adapter: r.adapter, apiKey: r.apiKey, apiUrl: r.baseUrl, modelId: r.modelId || modelId, apiVersion: r.apiVersion },
            userMessage,
            systemPrompt,
            options,
        );
    }

    /**
     * Run a tool-calling loop: chat → check for tool calls → execute → repeat.
     * Returns { messages, content, toolCallRounds, structured }.
     *
     * @param {string} modelId
     * @param {Array} messages - Initial messages
     * @param {Array} tools - Tool definitions (OpenAI format)
     * @param {object} options - Chat options. Optional `options.finalTool` (an
     *   OpenAI-format tool def) FORCES the synthesis/final call to call that tool
     *   instead of dropping tools / emitting prose. Applies on BOTH exit paths:
     *   the model stopping its tool calls, and the max-rounds-hit final chat. When
     *   set, the return value's `structured` is the parsed finalTool args (or null
     *   when the model declined / emitted unparseable args — output is untrusted).
     *   When omitted, behaviour is IDENTICAL to before: toolChoice:'auto' loop and
     *   a final chat with tools:undefined, and `structured` is null.
     * @param {function} executeTool - async (name, args) => result string
     * @param {number} maxRounds - Max tool call rounds (default: 5)
     */
    async runToolLoop(modelId, messages, tools, options = {}, executeTool, maxRounds = 5) {
        const { finalTool, ...chatOptions } = options;
        let rounds = 0;
        const updatedMessages = [...messages];

        // Force the synthesis call to emit structured output via `finalTool`.
        // Reuses the same provider-aware forcing as chatForcedTool, so the
        // synthesis step yields parseable tool args on every provider.
        const runFinalSynthesis = async () => {
            const { adapter } = await this._resolve(modelId);
            const result = await this.chat(modelId, updatedMessages, {
                ...chatOptions,
                tools: [finalTool],
                toolChoice: forcedToolChoice(adapter, finalTool?.function?.name),
            });
            return {
                content: result.content ?? null,
                structured: parseToolCallArgs(result?.toolCalls?.[0]),
            };
        };

        while (rounds < maxRounds) {
            const result = await this.chat(modelId, updatedMessages, {
                ...chatOptions,
                tools,
                toolChoice: 'auto',
            });

            if (!result.toolCalls || result.toolCalls.length === 0) {
                // No tool calls — done. When a finalTool is requested, the model
                // "stopped" without producing structured output, so run one forced
                // synthesis call to extract it rather than returning prose.
                if (finalTool) {
                    const final = await runFinalSynthesis();
                    return {
                        messages: updatedMessages,
                        content: final.content,
                        toolCallRounds: rounds,
                        structured: final.structured,
                    };
                }
                return { messages: updatedMessages, content: result.content, toolCallRounds: rounds, structured: null };
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

        // Max rounds hit — synthesize a final answer. With a finalTool, force the
        // structured tool call; otherwise preserve the original behaviour of one
        // final chat with tools dropped.
        if (finalTool) {
            const final = await runFinalSynthesis();
            return {
                messages: updatedMessages,
                content: final.content,
                toolCallRounds: rounds,
                structured: final.structured,
            };
        }
        const finalResult = await this.chat(modelId, updatedMessages, {
            ...chatOptions,
            tools: undefined,
        });
        return { messages: updatedMessages, content: finalResult.content, toolCallRounds: rounds, structured: null };
    }
}

// Singleton
module.exports = new LLMClient();
