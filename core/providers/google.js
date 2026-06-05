/**
 * Google Provider Adapter
 *
 * 100% SDK-based — uses the official `@google/genai` package for ALL API calls.
 * No raw fetch, no manual SSE parsing.
 *
 * Supports:
 * - Text generation (Gemini 2.5 / 3.x Pro / Flash)
 * - Streaming via SDK
 * - Tool / function calling (OpenAI format ↔ Google functionDeclarations)
 * - Thinking / reasoning mode (thinkingBudget for 2.5, thinkingLevel for 3+)
 * - Image generation (Nano Banana 2 / gemini-3.1-flash-image-preview)
 * - Model listing
 */

const BaseProvider = require('./base');
const crypto = require('crypto');

// Models that support thinking/reasoning — Gemini 3.x uses thinkingLevel.
// Match any 3.x minor version (3, 3.1, 3.5, …) so new releases like
// gemini-3.5-flash don't silently fall through to "no thinking config".
const THINKING_MODEL_PATTERNS_3X = [
    /gemini-3(\.\d+)?-pro/,
    /gemini-3(\.\d+)?-flash/,
];

// Gemini 2.5 models use thinkingBudget instead
const THINKING_MODEL_PATTERNS_25 = [
    /gemini-2\.5-pro/,
    /gemini-2\.5-flash/,
];

// Thinking level mapping from generic effort labels
const THINKING_LEVEL_MAP = {
    low: 'low',
    minimal: 'minimal',
    medium: 'medium',
    high: 'high',
    xhigh: 'high',
    none: null,
};

// Budget mapping from reasoning effort labels → token budget
const THINKING_BUDGET_MAP = {
    minimal: 128,
    low: 1024,
    medium: 4096,
    high: 16384,
    xhigh: 32768,
    none: 0,
};

class GoogleProvider extends BaseProvider {
    constructor() {
        super('google');
        // In-memory cache for explicit context caching
        // Key: hash of model+system+tools → { cacheName, expiresAt }
        this._cacheMap = new Map();
    }

    // ─── SDK Client ──────────────────────────────────────────────

    createClient(apiKey) {
        const { GoogleGenAI } = require('@google/genai');
        return new GoogleGenAI({ apiKey });
    }

    // ─── Model Helpers ───────────────────────────────────────────

    supportsReasoning(modelId) {
        return THINKING_MODEL_PATTERNS_3X.some(p => p.test(modelId))
            || THINKING_MODEL_PATTERNS_25.some(p => p.test(modelId));
    }

    supportsVision(modelId) {
        // All Gemini models support vision/multimodal input
        return true;
    }

    _isGemini25(modelId) {
        return THINKING_MODEL_PATTERNS_25.some(p => p.test(modelId));
    }

    _isGemini3x(modelId) {
        return THINKING_MODEL_PATTERNS_3X.some(p => p.test(modelId));
    }

    isImageModel(modelId) {
        return /image-preview/.test(modelId);
    }

    // ─── Message Normalization ───────────────────────────────────
    // Convert from OpenAI message format to Google GenAI contents format

    normalizeMessages(messages) {
        let systemInstruction = null;
        const contents = [];

        for (const msg of messages) {
            if (msg.role === 'system') {
                // Collect system messages into systemInstruction
                const text = typeof msg.content === 'string'
                    ? msg.content
                    : Array.isArray(msg.content)
                        ? msg.content.map(p => p.text || '').join('\n')
                        : JSON.stringify(msg.content);
                systemInstruction = systemInstruction
                    ? `${systemInstruction}\n\n${text}`
                    : text;
                continue;
            }

            // ─── Tool result messages (role: 'tool') ──────────────
            if (msg.role === 'tool') {
                // Convert OpenAI tool result → Google functionResponse part
                // Find the matching tool call to get the function name
                const toolCallId = msg.tool_call_id;
                let functionName = msg.name || 'unknown';

                // Try to find the function name from previous assistant tool_calls
                if (toolCallId) {
                    for (let i = contents.length - 1; i >= 0; i--) {
                        const prev = contents[i];
                        if (prev.role === 'model' && prev.parts) {
                            for (const part of prev.parts) {
                                if (part.functionCall && part._toolCallId === toolCallId) {
                                    functionName = part.functionCall.name;
                                    break;
                                }
                            }
                        }
                    }
                }

                // Parse the tool result content
                let responseData;
                try {
                    responseData = JSON.parse(msg.content);
                } catch (e) {
                    responseData = { result: msg.content };
                }

                // Google expects functionResponse parts with role: 'user'
                contents.push({
                    role: 'user',
                    parts: [{
                        functionResponse: {
                            name: functionName,
                            response: responseData,
                        },
                    }],
                });
                continue;
            }

            // ─── Assistant messages ────────────────────────────────
            if (msg.role === 'assistant') {
                // Gemini 3.x: when the previous response captured its raw
                // SDK parts on the first tool call, replay them verbatim.
                // This preserves thought parts + signatures exactly as
                // received, which is what the docs require for multi-turn
                // tool calling. We only re-attach our internal _toolCallId
                // marker so subsequent tool-result messages can match up.
                const rawParts = msg.tool_calls?.[0]?._raw_content_parts;
                if (Array.isArray(rawParts) && rawParts.length > 0) {
                    let fcIdx = 0;
                    const replay = rawParts.map((p) => {
                        if (!p || typeof p !== 'object') return p;
                        const clone = { ...p };
                        if (clone.functionCall) {
                            const tc = msg.tool_calls[fcIdx++];
                            if (tc?.id) clone._toolCallId = tc.id;
                        }
                        return clone;
                    });
                    contents.push({ role: 'model', parts: replay });
                    continue;
                }

                const parts = [];

                // Add text content if present and non-empty
                if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
                    parts.push({ text: msg.content });
                }

                // Convert OpenAI tool_calls → Google functionCall parts
                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    for (const tc of msg.tool_calls) {
                        let args = {};
                        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (e) { }
                        const fcPart = {
                            functionCall: {
                                name: tc.function?.name || tc.name,
                                args,
                            },
                        };
                        // Restore thoughtSignature if saved (required by Gemini 3.x)
                        if (tc._thought_signature) {
                            fcPart.thoughtSignature = tc._thought_signature;
                        }
                        // Store tool_call_id for matching tool results later
                        fcPart._toolCallId = tc.id;
                        parts.push(fcPart);
                    }
                }

                if (parts.length > 0) {
                    contents.push({ role: 'model', parts });
                }
                continue;
            }

            // ─── User messages ─────────────────────────────────────
            const role = 'user';

            if (typeof msg.content === 'string') {
                if (msg.content.trim()) {
                    contents.push({ role, parts: [{ text: msg.content }] });
                } else {
                    // Skip empty user messages — Gemini rejects them
                    continue;
                }
            } else if (Array.isArray(msg.content)) {
                const parts = [];
                for (const part of msg.content) {
                    if (part.type === 'text') {
                        parts.push({ text: part.text });
                    } else if (part.type === 'image_url') {
                        // Convert image: data URL → inlineData, https URL → fileData
                        const imgObj = part.image_url;
                        const url = typeof imgObj === 'string' ? imgObj : (imgObj?.url || '');
                        if (url.startsWith('data:')) {
                            const match = url.match(/^data:([^;]+);base64,(.+)$/);

                            if (match) {
                                parts.push({
                                    inlineData: {
                                        mimeType: match[1],
                                        data: match[2],
                                    },
                                });
                            }
                        } else if (url.startsWith('http')) {
                            // Use fileData for URLs — Gemini fetches the image from the URL
                            parts.push({
                                fileData: {
                                    fileUri: url,
                                    mimeType: imgObj?.mimeType || 'image/png',
                                },
                            });
                        }
                    }
                }
                if (parts.length > 0) {
                    contents.push({ role, parts });
                }
            }
        }

        // Clean up internal _toolCallId markers before sending to API
        for (const content of contents) {
            if (content.parts) {
                for (const part of content.parts) {
                    delete part._toolCallId;
                }
            }
        }

        // Merge consecutive same-role messages — Gemini rejects them
        const merged = [];
        for (const entry of contents) {
            const prev = merged[merged.length - 1];
            if (prev && prev.role === entry.role) {
                prev.parts = [...prev.parts, ...entry.parts];
            } else {
                merged.push({ ...entry, parts: [...entry.parts] });
            }
        }

        return { systemInstruction, contents: merged };
    }

    // ─── Tool Conversion ─────────────────────────────────────────
    // Convert OpenAI-format tools to Google functionDeclarations

    _convertTools(options) {
        if (!options.tools || options.tools.length === 0) return null;

        const functionDeclarations = [];
        for (const tool of options.tools) {
            if (tool.type === 'function' && tool.function) {
                functionDeclarations.push({
                    name: tool.function.name,
                    description: tool.function.description || '',
                    parametersJsonSchema: tool.function.parameters || undefined,
                });
            }
        }

        if (functionDeclarations.length === 0) return null;

        return [{ functionDeclarations }];
    }

    // ─── Explicit Context Caching ────────────────────────────────
    // Cache system instruction + tools server-side for 90% token savings

    async _getOrCreateCache(ai, model, systemInstruction, tools) {
        if (!systemInstruction) return null;

        // Build cache key from model + system + tools
        const cacheContent = JSON.stringify({ model, systemInstruction, tools: tools || [] });
        const hash = crypto.createHash('md5').update(cacheContent).digest('hex');

        // Check if we have a valid cached entry
        const cached = this._cacheMap.get(hash);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.cacheName;
        }

        // Estimate token count (rough: ~4 chars per token)
        const estimatedTokens = Math.ceil(cacheContent.length / 4);
        const minTokens = model.includes('pro') ? 4096 : 1024;

        if (estimatedTokens < minTokens) {
            // Too small for explicit caching — implicit caching handles this
            return null;
        }

        try {
            const cacheConfig = {
                model,
                config: {
                    displayName: `beeflow-${hash.substring(0, 8)}`,
                    systemInstruction,
                    ttl: '3600s', // 1 hour — matches Anthropic's longest TTL
                },
                contents: [], // Empty — we only cache system instruction + tools
            };

            if (tools) {
                cacheConfig.config.tools = tools;
            }

            const cache = await ai.caches.create(cacheConfig);
            const cacheName = cache.name;

            // Store in memory expiring slightly before the server-side TTL so
            // we don't try to read a cache that has just been GC'd. Active
            // users hitting the same agent for an afternoon now amortize a
            // single cache write across many reads at -90%.
            this._cacheMap.set(hash, {
                cacheName,
                expiresAt: Date.now() + 59 * 60 * 1000,
            });

            console.log(`[Google] Created explicit cache: ${cacheName} (~${estimatedTokens} tokens)`);
            return cacheName;
        } catch (err) {
            console.warn('[Google] Explicit cache creation failed (using inline):', err.message);
            return null;
        }
    }

    // ─── Build Config ────────────────────────────────────────────

    _buildGenerateConfig(model, options = {}) {
        const config = {};

        if (options.maxTokens !== undefined) {
            config.maxOutputTokens = options.maxTokens;
        }

        if (options.temperature !== undefined) {
            config.temperature = options.temperature;
        }

        // ─── Tools ───────────────────────────────────────────────
        const googleTools = this._convertTools(options);
        if (googleTools) {
            config.tools = googleTools;
            // toolConfig for function calling mode
            if (options.toolChoice === 'none') {
                config.toolConfig = {
                    functionCallingConfig: { mode: 'NONE' },
                };
            } else if (options.toolChoice === 'required' || options.toolChoice === 'any') {
                config.toolConfig = {
                    functionCallingConfig: { mode: 'ANY' },
                };
            }
            // 'auto' is the default — no toolConfig needed
        }

        // ─── Thinking / Reasoning ────────────────────────────────

        // Gemini 3.x models: use thinkingLevel
        if (this._isGemini3x(model)) {
            let level = null;

            // 1. Explicit thinkingLevel from options
            if (options.thinkingLevel) {
                level = THINKING_LEVEL_MAP[options.thinkingLevel] || options.thinkingLevel;
            }
            // 2. Map reasoningEffort label to thinkingLevel
            else if (options.reasoningEffort && options.reasoningEffort !== 'none') {
                level = THINKING_LEVEL_MAP[options.reasoningEffort] || 'medium';
            }
            // 3. Map budgetTokens to thinkingLevel
            else if (options.budgetTokens !== undefined) {
                if (options.budgetTokens === 0) {
                    level = 'minimal'; // Gemini 3 Flash can't fully disable, minimal is closest
                } else if (options.budgetTokens <= 1024) {
                    level = 'low';
                } else if (options.budgetTokens <= 4096) {
                    level = 'medium';
                } else {
                    level = 'high';
                }
            }

            if (level) {
                config.thinkingConfig = {
                    includeThoughts: true,
                    thinkingLevel: level,
                };
                console.log(`[Google] Gemini 3.x thinking: level=${level}`);
            }
            // If no thinking config set, Gemini 3 defaults to 'high' thinking
        }
        // Gemini 2.5 models: use thinkingBudget
        else if (this._isGemini25(model)) {
            if (options.budgetTokens !== undefined && options.budgetTokens >= 0) {
                // Explicit budget from tier settings (0 = disable, >0 = specific budget)
                config.thinkingConfig = {
                    includeThoughts: options.budgetTokens > 0,
                    thinkingBudget: options.budgetTokens,
                };
                console.log(`[Google] Gemini 2.5 thinking: budget=${options.budgetTokens}`);
            } else if (options.reasoningEffort && options.reasoningEffort !== 'none') {
                // Convert effort label → budget
                const budget = THINKING_BUDGET_MAP[options.reasoningEffort] || 4096;
                if (budget > 0) {
                    config.thinkingConfig = {
                        includeThoughts: true,
                        thinkingBudget: budget,
                    };
                }
            }
            // If no thinking config set, Gemini 2.5 uses dynamic thinking by default
        }

        return config;
    }

    // ─── Extract tool calls from response ────────────────────────

    _extractToolCalls(response) {
        const parts = response.candidates?.[0]?.content?.parts;
        if (!parts) return null;

        // Gemini 3.x can attach the thought_signature to an adjacent thought
        // part instead of the functionCall part. The docs require replaying
        // the FULL content as received, so we fall back to a part-wide scan.
        let fallbackSig = null;
        for (const part of parts) {
            const sig = part.thoughtSignature || part.thought_signature;
            if (sig) { fallbackSig = sig; break; }
        }

        const toolCalls = [];
        for (const part of parts) {
            if (part.functionCall) {
                const tc = {
                    id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    type: 'function',
                    function: {
                        name: part.functionCall.name,
                        arguments: JSON.stringify(part.functionCall.args || {}),
                    },
                };
                const sig = part.thoughtSignature || part.thought_signature || (toolCalls.length === 0 ? fallbackSig : null);
                if (sig) {
                    tc._thought_signature = sig;
                }
                toolCalls.push(tc);
            }
        }

        if (toolCalls.length > 0) {
            // Capture the raw SDK parts on the first tool call. normalizeMessages
            // replays these verbatim on the next turn so Gemini 3.x signatures
            // (which may live on a thought part, not the functionCall) survive
            // our OpenAI-shaped bridge.
            toolCalls[0]._raw_content_parts = parts;
        }

        return toolCalls.length > 0 ? toolCalls : null;
    }

    // ─── High-Level API (all SDK) ────────────────────────────────

    /**
     * Non-streaming chat via SDK.
     * baseUrl is accepted for interface compatibility but ignored — SDK handles it.
     */
    async chat(apiKey, baseUrl, model, messages, options = {}) {
        const ai = this.createClient(apiKey);
        const { systemInstruction, contents } = this.normalizeMessages(messages);
        const config = this._buildGenerateConfig(model, options);

        console.log('[Google] SDK chat for model:', model);

        const params = {
            model,
            contents,
            config,
        };
        if (systemInstruction) {
            params.config = { ...config, systemInstruction };
        }

        // Try explicit context caching for large system prompts
        const cacheName = await this._getOrCreateCache(ai, model, systemInstruction, config.tools);
        if (cacheName) {
            params.config.cachedContent = cacheName;
            // Remove inline system instruction — it's in the cache
            delete params.config.systemInstruction;
            delete params.config.tools;
            delete params.config.toolConfig;
        }

        const response = await ai.models.generateContent(params);

        // Extract text from response (skip thinking parts)
        let textContent = '';
        if (response.candidates?.[0]?.content?.parts) {
            for (const part of response.candidates[0].content.parts) {
                if (part.text && !part.thought) {
                    textContent += part.text;
                }
            }
        } else if (response.text) {
            textContent = response.text;
        }

        // Extract tool calls (functionCall parts → OpenAI format)
        const toolCalls = this._extractToolCalls(response);

        return {
            content: textContent || null,
            toolCalls,
            usage: response.usageMetadata || null,
            raw: response,
        };
    }

    /**
     * Streaming chat via SDK.
     * baseUrl is accepted for interface compatibility but ignored.
     */
    async stream(apiKey, baseUrl, model, messages, options = {}, onEvent) {
        const ai = this.createClient(apiKey);
        const { systemInstruction, contents } = this.normalizeMessages(messages);
        const config = this._buildGenerateConfig(model, options);

        console.log('[Google] SDK streaming for model:', model);

        const params = {
            model,
            contents,
            config,
        };
        if (systemInstruction) {
            params.config = { ...config, systemInstruction };
        }

        // Try explicit context caching for large system prompts
        const cacheName = await this._getOrCreateCache(ai, model, systemInstruction, config.tools);
        if (cacheName) {
            params.config.cachedContent = cacheName;
            delete params.config.systemInstruction;
            delete params.config.tools;
            delete params.config.toolConfig;
        }

        let textChunks = 0;
        let thinkingChunks = 0;
        let streamUsage = null;
        let streamFinishReason = null;
        let thinkingOpen = false;
        const thinkingPartId = 'gemini-0';

        try {
            const response = await ai.models.generateContentStream(params);

            for await (const chunk of response) {
                // Capture usage metadata (available on chunks, last one has totals)
                if (chunk.usageMetadata) {
                    const thoughts = chunk.usageMetadata.thoughtsTokenCount || 0;
                    const candidates = chunk.usageMetadata.candidatesTokenCount || 0;
                    streamUsage = {
                        prompt_tokens: chunk.usageMetadata.promptTokenCount || 0,
                        // Gemini reports candidatesTokenCount = visible output only.
                        // thoughts are billed at output rate but not counted in
                        // candidates, so add them for cost-accurate completion.
                        completion_tokens: candidates + thoughts,
                        total_tokens: chunk.usageMetadata.totalTokenCount || 0,
                        cached_tokens: chunk.usageMetadata.cachedContentTokenCount || 0,
                        reasoning_tokens: thoughts,
                    };
                    // Log cache hits for monitoring
                    if (chunk.usageMetadata.cachedContentTokenCount > 0) {
                        console.log(`[Google] ⚡ Cache hit: ${chunk.usageMetadata.cachedContentTokenCount} cached tokens`);
                    }
                    if (thoughts > 0) {
                        console.log(`[Google] 🧠 Thinking: ${thoughts} thought tokens (visible: ${candidates})`);
                    }
                }
                // Capture finish reason from final candidate
                const finishReason = chunk.candidates?.[0]?.finishReason;
                if (finishReason) streamFinishReason = finishReason;
                if (chunk.candidates?.[0]?.content?.parts) {
                    for (const part of chunk.candidates[0].content.parts) {
                        if (part.thought && part.text) {
                            if (!thinkingOpen) {
                                thinkingOpen = true;
                                onEvent('thinking_start', { partId: thinkingPartId });
                            }
                            thinkingChunks++;
                            onEvent('thinking', { text: part.text, partId: thinkingPartId });
                        } else if (part.functionCall) {
                            // Tool call in streaming response
                            const sig = part.thoughtSignature || part.thought_signature;
                            onEvent('tool_use', {
                                id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                                name: part.functionCall.name,
                                input: part.functionCall.args || {},
                                thought_signature: sig || undefined,
                            });
                            if (sig) console.log(`[Google] Stream: captured thought_signature for ${part.functionCall.name}`);
                        } else if (part.text) {
                            // Closing thinking on first text token is correct: Gemini interleaves
                            // thought parts and answer parts, but once answer tokens start, thinking
                            // has finished for this turn.
                            if (thinkingOpen) {
                                thinkingOpen = false;
                                onEvent('thinking_stop', { partId: thinkingPartId });
                            }
                            textChunks++;
                            onEvent('text', { text: part.text });
                        } else if (part.inlineData) {
                            // Image response from image models
                            onEvent('image', {
                                data: part.inlineData.data,
                                mimeType: part.inlineData.mimeType,
                            });
                        }
                    }
                }
            }
        } catch (err) {
            console.error('[Google] Stream error:', err.message);
            if (err.status) console.error('[Google] Error status:', err.status);
            // Log full error details for debugging
            if (err.errorDetails) console.error('[Google] Error details:', JSON.stringify(err.errorDetails));
            onEvent('error', { error: `Google API error: ${err.message}` });
        }

        // Ensure thinking is closed — covers streams that end while still in thinking phase.
        if (thinkingOpen) {
            onEvent('thinking_stop', { partId: thinkingPartId });
        }

        if (streamFinishReason) {
            streamUsage = streamUsage || {};
            streamUsage.stop_reason = streamFinishReason;
        }
        console.log(`[Google] Stream complete — ${textChunks} text chunks, ${thinkingChunks} thinking chunks`);
        onEvent('done', streamUsage || {});
    }

    /**
     * Generate an image using Nano Banana 2 (gemini-3.1-flash-image-preview).
     * This is a standalone method — not part of the standard chat flow.
     *
     * @param {string} apiKey
     * @param {string} prompt
     * @param {object} options - { aspectRatio, thinkingLevel }
     * @returns {Promise<{ text: string|null, imageBase64: string|null, mimeType: string|null }>}
     */
    async generateImage(apiKey, prompt, options = {}) {
        const ai = this.createClient(apiKey);
        const model = options.model || 'gemini-3.1-flash-image-preview';

        console.log('[Google] Image generation for prompt:', prompt.substring(0, 80));

        const config = {
            responseModalities: ['TEXT', 'IMAGE'],
        };

        if (options.aspectRatio) {
            config.imageConfig = { aspectRatio: options.aspectRatio };
        }

        if (options.thinkingLevel) {
            config.thinkingConfig = {
                includeThoughts: true,
                thinkingLevel: options.thinkingLevel,
            };
        }

        const response = await ai.models.generateContent({
            model,
            contents: prompt,
            config,
        });

        let text = null;
        let imageBase64 = null;
        let mimeType = null;

        if (response.candidates?.[0]?.content?.parts) {
            for (const part of response.candidates[0].content.parts) {
                if (part.text && !part.thought) {
                    text = (text || '') + part.text;
                } else if (part.inlineData) {
                    imageBase64 = part.inlineData.data;
                    mimeType = part.inlineData.mimeType || 'image/png';
                }
            }
        }

        return { text, imageBase64, mimeType };
    }

    /**
     * Generate music using Lyria RealTime (lyria-realtime-exp).
     * Uses callbacks-based WebSocket session, collects PCM audio chunks,
     * and returns a WAV buffer encoded as base64.
     *
     * @param {string} apiKey
     * @param {string} prompt - Music description (e.g. "lofi hiphop, chill vibes")
     * @param {object} options - { bpm, durationSeconds, temperature, weightedPrompts }
     * @returns {Promise<{ audioBase64: string|null, mimeType: string }>}
     */
    async generateMusic(apiKey, prompt, options = {}) {
        const { GoogleGenAI } = require('@google/genai');

        // Lyria RealTime requires v1alpha API version
        const ai = new GoogleGenAI({
            apiKey,
            httpOptions: { apiVersion: 'v1alpha' },
        });

        const durationMs = (options.durationSeconds || 10) * 1000;
        const bpm = options.bpm || 90;
        const temperature = options.temperature || 1.0;
        const density = options.density;
        const brightness = options.brightness;
        const guidance = options.guidance;
        const musicGenerationMode = options.musicGenerationMode;
        const muteBass = options.muteBass;
        const muteDrums = options.muteDrums;

        console.log(`[Google] Music generation: "${prompt.substring(0, 80)}" (${durationMs / 1000}s, ${bpm} BPM)`);

        const audioChunks = [];

        return new Promise(async (resolve, reject) => {
            let sessionClosed = false;
            let timeoutHandle;

            try {
                // Connect to Lyria RealTime with callbacks (official JS SDK pattern)
                const session = await ai.live.music.connect({
                    model: 'models/lyria-realtime-exp',
                    callbacks: {
                        onmessage: (message) => {
                            if (message.serverContent?.audioChunks) {
                                for (const chunk of message.serverContent.audioChunks) {
                                    if (chunk.data) {
                                        audioChunks.push(Buffer.from(chunk.data, 'base64'));
                                    }
                                }
                            }
                        },
                        onerror: (error) => {
                            console.error('[Google] Lyria RealTime error:', error);
                            if (!sessionClosed) {
                                sessionClosed = true;
                                clearTimeout(timeoutHandle);
                                if (audioChunks.length > 0) {
                                    console.warn('[Google] Returning partial audio after error');
                                    finalize();
                                } else {
                                    reject(new Error(`Music generation failed: ${error}`));
                                }
                            }
                        },
                        onclose: () => {
                            console.log('[Google] Lyria RealTime stream closed');
                            if (!sessionClosed) {
                                sessionClosed = true;
                                clearTimeout(timeoutHandle);
                                finalize();
                            }
                        },
                    },
                });

                // Set weighted prompts
                const weightedPrompts = options.weightedPrompts || [
                    { text: prompt, weight: 1.0 },
                ];
                await session.setWeightedPrompts({ weightedPrompts });

                // Build generation config — include all Nano Banana settings
                const musicConfig = { bpm, temperature };
                if (density !== undefined && density !== null) musicConfig.density = density;
                if (brightness !== undefined && brightness !== null) musicConfig.brightness = brightness;
                if (guidance !== undefined && guidance !== null) musicConfig.guidance = guidance;
                if (musicGenerationMode) musicConfig.musicGenerationMode = musicGenerationMode;
                if (muteBass) musicConfig.muteBass = true;
                if (muteDrums) musicConfig.muteDrums = true;

                await session.setMusicGenerationConfig({ musicGenerationConfig: musicConfig });

                // Start playback
                await session.play();

                // Close session after the specified duration
                timeoutHandle = setTimeout(() => {
                    if (!sessionClosed) {
                        sessionClosed = true;
                        try { session.close(); } catch (e) { /* ignore */ }
                        finalize();
                    }
                }, durationMs);

            } catch (err) {
                console.error('[Google] Lyria RealTime connection error:', err.message);
                reject(new Error(`Music generation failed: ${err.message}`));
            }

            const finalize = () => {
                if (audioChunks.length === 0) {
                    resolve({ audioBase64: null, mimeType: 'audio/wav' });
                    return;
                }

                const pcmData = Buffer.concat(audioChunks);
                const wavBuffer = this._writeWavHeader(pcmData);

                console.log(`[Google] Music generated: ${audioChunks.length} chunks, ${(wavBuffer.length / 1024).toFixed(0)} KB`);

                resolve({
                    audioBase64: wavBuffer.toString('base64'),
                    mimeType: 'audio/wav',
                });
            };
        });
    }

    /**
     * Write a WAV header around raw PCM data (16-bit, stereo).
     * @param {Buffer} pcmData
     * @param {number} [sampleRate=48000] - Sample rate (48000 for default, 44100 for Lyria)
     * @returns {Buffer}
     */
    _writeWavHeader(pcmData, sampleRate = 48000) {
        const numChannels = 2;
        const bitDepth = 16;
        const byteRate = (sampleRate * numChannels * bitDepth) / 8;
        const blockAlign = (numChannels * bitDepth) / 8;
        const dataSize = pcmData.length;
        const header = Buffer.alloc(44);

        header.write('RIFF', 0);
        header.writeUInt32LE(36 + dataSize, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);            // PCM format
        header.writeUInt16LE(numChannels, 22);
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(byteRate, 28);
        header.writeUInt16LE(blockAlign, 32);
        header.writeUInt16LE(bitDepth, 34);
        header.write('data', 36);
        header.writeUInt32LE(dataSize, 40);

        return Buffer.concat([header, pcmData]);
    }

    /**
     * Generate a video using Veo 3.1.
     * This is a long-running operation — polls until complete.
     * Based on official docs: https://ai.google.dev/gemini-api/docs/video
     *
     * @param {string} apiKey
     * @param {string} prompt - Video description
     * @param {object} options - { aspectRatio, durationSeconds, resolution, model }
     * @returns {Promise<{ videoBase64: string|null, mimeType: string }>}
     */
    async generateVideo(apiKey, prompt, options = {}) {
        const { GoogleGenAI } = require('@google/genai');
        const ai = new GoogleGenAI({ apiKey });
        const model = options.model || 'veo-3.1-generate-preview';

        console.log(`[Google] Video generation: "${prompt.substring(0, 80)}" (model: ${model})`);

        // Start the long-running operation
        let operation = await ai.models.generateVideos({
            model,
            prompt,
            config: {
                aspectRatio: options.aspectRatio || '16:9',
                numberOfVideos: 1,
            },
        });

        // Poll until complete (max ~10 minutes for complex videos)
        const maxPollTime = 10 * 60 * 1000;
        const pollInterval = 10000;
        const startTime = Date.now();

        while (!operation.done) {
            if (Date.now() - startTime > maxPollTime) {
                throw new Error('Video generation timed out after 10 minutes');
            }
            await new Promise(r => setTimeout(r, pollInterval));
            operation = await ai.operations.getVideosOperation({ operation });
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            console.log(`[Google] Video polling... ${elapsed}s elapsed`);
        }

        // Download the generated video
        const generatedVideo = operation.response?.generatedVideos?.[0];
        if (!generatedVideo?.video) {
            console.error('[Google] Video generation completed but no video in response');
            return { videoBase64: null, mimeType: 'video/mp4' };
        }

        // Download video file using the SDK
        const fs = require('fs');
        const path = require('path');
        const crypto = require('crypto');
        const genDir = path.join(__dirname, '..', '..', 'data', 'uploads', 'generated');
        if (!fs.existsSync(genDir)) fs.mkdirSync(genDir, { recursive: true });
        const filename = `video_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.mp4`;
        const filePath = path.join(genDir, filename);

        await ai.files.download({
            file: generatedVideo.video,
            downloadPath: filePath,
        });

        // Read the downloaded file as base64
        const videoBuffer = fs.readFileSync(filePath);
        console.log(`[Google] Video generated: ${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB, saved to ${filePath}`);

        return {
            videoBase64: videoBuffer.toString('base64'),
            mimeType: 'video/mp4',
        };
    }

    /**
     * List models via SDK.
     * baseUrl is accepted for interface compatibility but ignored.
     */
    async listModels(apiKey, baseUrl) {
        try {
            const ai = this.createClient(apiKey);
            const result = await ai.models.list();
            const models = [];
            // The SDK returns a PagedIterable
            for await (const model of result) {
                // model.name is like "models/gemini-3.1-pro-preview"
                const id = model.name?.replace('models/', '') || model.name;
                models.push({
                    id,
                    name: model.displayName || id,
                });
            }
            console.log(`[Google] Found ${models.length} models`);
            return models;
        } catch (e) {
            console.error('[Google] SDK listModels failed:', e.message);
            return [];
        }
    }
}

module.exports = GoogleProvider;
