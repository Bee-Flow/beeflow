/**
 * MiniMax Provider — extends BaseProvider with:
 * - Hardcoded model list (MiniMax has no /v1/models endpoint)
 * - `reasoning_split: true` for clean thinking output via `reasoning_details`
 * - Temperature clamping to (0.0, 1.0] (MiniMax requirement)
 * - Fallback `<think>` tag handling for non-streaming responses
 *
 * API reference: https://platform.minimax.io/docs/api-reference/text-openai-api
 *
 * MiniMax's OpenAI-compatible API at https://api.minimax.io/v1 supports:
 * - `reasoning_split: true` → thinking in `delta.reasoning_details` (streaming)
 *   or `message.reasoning_details` (non-streaming)
 * - Without it → thinking embedded as `<think>...</think>` tags in `content`
 */
const BaseProvider = require('./base');

const MINIMAX_MODELS = [
    { id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
    { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed' },
    { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' },
    { id: 'MiniMax-M2.5-highspeed', name: 'MiniMax M2.5 Highspeed' },
    { id: 'MiniMax-M2.1', name: 'MiniMax M2.1' },
    { id: 'MiniMax-M2.1-highspeed', name: 'MiniMax M2.1 Highspeed' },
    { id: 'MiniMax-M2', name: 'MiniMax M2' },
    { id: 'MiniMax-M2-her', name: 'MiniMax M2 Her' },
];

class MiniMaxProvider extends BaseProvider {

    constructor() {
        super('minimax');
    }

    async listModels(apiKey, baseUrl) {
        // MiniMax has no /v1/models endpoint (returns 404).
        // Return the hardcoded list directly.
        return MINIMAX_MODELS;
    }

    /**
     * Override request body to:
     * 1. Inject `reasoning_split: true` for clean thinking extraction
     * 2. Clamp temperature to (0.0, 1.0] — MiniMax rejects values outside this range
     */
    buildRequestBody(model, messages, options = {}) {
        // Clamp temperature: MiniMax requires (0.0, 1.0]
        if (options.temperature !== undefined) {
            if (options.temperature <= 0) options.temperature = 0.01;
            if (options.temperature > 1) options.temperature = 1.0;
        }

        // Sanitize tool_calls arguments in message history.
        // MiniMax sometimes generates tool calls with invalid JSON arguments,
        // then rejects the same messages on follow-up requests with
        // "invalid function arguments json string".
        const sanitizedMessages = messages.map(msg => {
            if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
                return {
                    ...msg,
                    tool_calls: msg.tool_calls.map(tc => {
                        if (!tc.function?.arguments) return tc;
                        let args = tc.function.arguments;
                        // Ensure arguments is a valid JSON string
                        if (typeof args === 'string') {
                            try {
                                JSON.parse(args);
                            } catch {
                                // Invalid JSON — wrap as empty object
                                console.warn(`[MiniMax] Sanitized invalid tool_call arguments for ${tc.function?.name}`);
                                args = '{}';
                            }
                        } else if (typeof args === 'object') {
                            args = JSON.stringify(args);
                        } else {
                            args = '{}';
                        }
                        return {
                            ...tc,
                            function: { ...tc.function, arguments: args },
                        };
                    }),
                };
            }
            return msg;
        });

        // Inject reasoning_split for clean thinking output
        const extraBody = { ...(options.extraBody || {}), reasoning_split: true };
        return super.buildRequestBody(model, sanitizedMessages, { ...options, extraBody });
    }

    /**
     * Override SSE stream parser to handle MiniMax reasoning content.
     * With `reasoning_split: true`, thinking comes via `delta.reasoning_details`.
     * Falls back to `<think>` tag parsing for robustness.
     * Also intercepts XML tool call patterns (minimax:tool_call) in content.
     */
    async _parseSseStream(body, onEvent) {
        const decoder = new TextDecoder();
        let buffer = '';
        let insideThinkTag = false;  // Track if we're inside <think> tags (fallback)
        let reasoningBuffer = '';    // Track cumulative reasoning text
        let xmlToolBuffer = '';      // Buffer for detecting XML tool calls in content
        let insideXmlToolCall = false;
        let activeCloseTag = '';      // Which close tag we're looking for

        const flushXmlToolBuffer = () => {
            if (xmlToolBuffer) {
                // Emit any buffered text that wasn't an XML tool call
                const processed = this._processThinkTags(xmlToolBuffer, insideThinkTag, onEvent);
                insideThinkTag = processed.insideThinkTag;
                xmlToolBuffer = '';
            }
        };

        const processContent = (text) => {
            xmlToolBuffer += text;

            // Detect XML tool call patterns:
            // 1. <minimax:tool_call>...<invoke name="...">...</invoke>...</minimax:tool_call>
            // 2. <tool_calls>{"name":"...","arguments":{...}}</tool_calls>
            const TOOL_PATTERNS = [
                { open: '<minimax:tool_call', close: '</minimax:tool_call>', partial: '<minimax' },
                { open: '<tool_calls',        close: '</tool_calls>',        partial: '<tool_call' },
            ];

            while (xmlToolBuffer.length > 0) {
                if (insideXmlToolCall) {
                    // Find the matching close tag
                    const closeIdx = xmlToolBuffer.indexOf(activeCloseTag);
                    if (closeIdx !== -1) {
                        const xmlContent = xmlToolBuffer.substring(0, closeIdx);
                        xmlToolBuffer = xmlToolBuffer.substring(closeIdx + activeCloseTag.length);
                        insideXmlToolCall = false;
                        activeCloseTag = '';

                        this._parseXmlToolCall(xmlContent, onEvent);
                    } else {
                        // Still accumulating — wait for more chunks
                        return;
                    }
                } else {
                    // Look for any opening tag
                    let earliestIdx = -1;
                    let matchedPattern = null;

                    for (const pat of TOOL_PATTERNS) {
                        const idx = xmlToolBuffer.indexOf(pat.open);
                        if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) {
                            earliestIdx = idx;
                            matchedPattern = pat;
                        }
                    }

                    if (matchedPattern && earliestIdx !== -1) {
                        // Flush text before the tag
                        const textBefore = xmlToolBuffer.substring(0, earliestIdx);
                        if (textBefore) {
                            const processed = this._processThinkTags(textBefore, insideThinkTag, onEvent);
                            insideThinkTag = processed.insideThinkTag;
                        }
                        // Find end of opening tag
                        const tagEnd = xmlToolBuffer.indexOf('>', earliestIdx);
                        if (tagEnd !== -1) {
                            xmlToolBuffer = xmlToolBuffer.substring(tagEnd + 1);
                            insideXmlToolCall = true;
                            activeCloseTag = matchedPattern.close;
                        } else {
                            xmlToolBuffer = xmlToolBuffer.substring(earliestIdx);
                            return;
                        }
                    } else {
                        // Check for partial tag at end of buffer
                        const hasPartial = TOOL_PATTERNS.some(p => xmlToolBuffer.includes(p.partial));
                        if (hasPartial && xmlToolBuffer.length < 30) {
                            // Might be a tag split across chunks — wait
                            return;
                        }
                        // No tool call detected — flush as normal text
                        const processed = this._processThinkTags(xmlToolBuffer, insideThinkTag, onEvent);
                        insideThinkTag = processed.insideThinkTag;
                        xmlToolBuffer = '';
                    }
                }
            }
        };

        for await (const chunk of body) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    flushXmlToolBuffer();
                    onEvent('done', {});
                    return;
                }

                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.delta;
                    if (!delta) continue;

                    // 1. Handle reasoning_details (from reasoning_split: true)
                    //    MiniMax sends cumulative text — extract only the new portion
                    if (delta.reasoning_details && Array.isArray(delta.reasoning_details)) {
                        for (const detail of delta.reasoning_details) {
                            if (detail.text) {
                                const newText = detail.text.substring(reasoningBuffer.length);
                                reasoningBuffer = detail.text;
                                if (newText) onEvent('thinking', { text: newText });
                            }
                        }
                    }

                    // 2. Handle dedicated reasoning_content field (legacy)
                    if (delta.reasoning_content) {
                        onEvent('thinking', { text: delta.reasoning_content });
                    }

                    // 3. Handle content — with reasoning_split this should be clean text,
                    //    but also intercept XML tool calls (minimax:tool_call) and
                    //    fall back to <think> tag stripping for robustness
                    if (delta.content !== undefined && delta.content !== null) {
                        if (typeof delta.content === 'string') {
                            processContent(delta.content);
                        } else if (Array.isArray(delta.content)) {
                            // Structured content array
                            for (const block of delta.content) {
                                if (block.type === 'thinking' && Array.isArray(block.thinking)) {
                                    const text = block.thinking
                                        .filter(t => t.type === 'text' && t.text)
                                        .map(t => t.text)
                                        .join('');
                                    if (text) onEvent('thinking', { text });
                                } else if (block.type === 'text' && block.text) {
                                    processContent(block.text);
                                }
                            }
                        }
                    }

                    // 4. Tool calls in streaming (standard OpenAI format)
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

        flushXmlToolBuffer();
        onEvent('done', {});
    }

    /**
     * Parse an XML tool call body and emit as a tool_use event.
     * Handles formats like:
     *   <invoke name="tool_name"><parameter name="key">value</parameter></invoke>
     *   <invoke name="tool_name">{"key": "value"}</invoke>
     */
    _parseXmlToolCall(xmlContent, onEvent) {
        try {
            // Format 1: <invoke name="tool_name">...</invoke> (Anthropic-style)
            const invokeMatch = xmlContent.match(/<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/);
            if (invokeMatch) {
                const toolName = invokeMatch[1];
                const invokeBody = invokeMatch[2].trim();
                let toolArgs = {};

                if (invokeBody.startsWith('{')) {
                    try { toolArgs = JSON.parse(invokeBody); } catch (e) {}
                }
                if (Object.keys(toolArgs).length === 0) {
                    const paramRegex = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
                    let pm;
                    while ((pm = paramRegex.exec(invokeBody)) !== null) {
                        toolArgs[pm[1]] = pm[2];
                    }
                }

                const toolId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                console.log(`[MiniMax] Intercepted XML tool call: ${toolName}(${JSON.stringify(toolArgs).substring(0, 100)})`);
                onEvent('tool_use', { id: toolId, name: toolName, input: JSON.stringify(toolArgs) });
                return;
            }

            // Format 2: {"name": "tool_name", "arguments": {...}} (native MiniMax)
            //   May contain multiple JSON objects separated by whitespace
            const jsonMatches = xmlContent.match(/\{[^{}]*"name"\s*:\s*"[^"]+"[\s\S]*?\}/g);
            if (jsonMatches) {
                for (const jsonStr of jsonMatches) {
                    try {
                        const parsed = JSON.parse(jsonStr);
                        if (parsed.name) {
                            const toolId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                            const args = parsed.arguments || {};
                            console.log(`[MiniMax] Intercepted native tool call: ${parsed.name}(${JSON.stringify(args).substring(0, 100)})`);
                            onEvent('tool_use', {
                                id: toolId,
                                name: parsed.name,
                                input: typeof args === 'string' ? args : JSON.stringify(args),
                            });
                        }
                    } catch (e) {
                        // Try extracting with a more lenient approach
                    }
                }
                return;
            }

            console.warn('[MiniMax] Could not parse XML tool call:', xmlContent.substring(0, 200));
        } catch (err) {
            console.warn('[MiniMax] XML tool call parse error:', err.message);
        }
    }

    /**
     * Process text content, stripping <think>...</think> tags and routing
     * their content as 'thinking' events while emitting the rest as 'text'.
     *
     * Handles tags split across multiple SSE chunks by tracking state.
     *
     * @param {string} text - Raw text from delta.content
     * @param {boolean} insideThinkTag - Whether we're currently inside a <think> block
     * @param {function} onEvent - Event emitter
     * @returns {{ insideThinkTag: boolean }} Updated state
     */
    _processThinkTags(text, insideThinkTag, onEvent) {
        let remaining = text;

        while (remaining.length > 0) {
            if (insideThinkTag) {
                const closeIdx = remaining.indexOf('</think>');
                if (closeIdx !== -1) {
                    const thinkText = remaining.substring(0, closeIdx);
                    if (thinkText) onEvent('thinking', { text: thinkText });
                    remaining = remaining.substring(closeIdx + 8);
                    insideThinkTag = false;
                } else {
                    onEvent('thinking', { text: remaining });
                    remaining = '';
                }
            } else {
                const openIdx = remaining.indexOf('<think>');
                if (openIdx !== -1) {
                    const textBefore = remaining.substring(0, openIdx);
                    if (textBefore) onEvent('text', { text: textBefore });
                    remaining = remaining.substring(openIdx + 7);
                    insideThinkTag = true;
                } else {
                    onEvent('text', { text: remaining });
                    remaining = '';
                }
            }
        }

        return { insideThinkTag };
    }

    /**
     * Override chat to handle reasoning_details, strip <think> tags,
     * and parse XML tool calls from non-streaming responses.
     */
    async chat(apiKey, baseUrl, model, messages, options = {}) {
        const result = await super.chat(apiKey, baseUrl, model, messages, options);

        // Extract thinking from reasoning_details (from reasoning_split: true)
        const rawMessage = result.raw?.choices?.[0]?.message;
        if (rawMessage?.reasoning_details && Array.isArray(rawMessage.reasoning_details)) {
            const thinkingText = rawMessage.reasoning_details
                .filter(d => d.text)
                .map(d => d.text)
                .join('');
            if (thinkingText) {
                result.thinking = thinkingText;
            }
        }

        // Fallback: strip <think> tags from content (if reasoning_split didn't work)
        if (result.content && typeof result.content === 'string') {
            const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
            const thinkingParts = [];
            let match;
            while ((match = thinkRegex.exec(result.content)) !== null) {
                thinkingParts.push(match[1]);
            }
            result.content = result.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            if (thinkingParts.length > 0 && !result.thinking) {
                result.thinking = thinkingParts.join('\n');
            }

            // Strip XML tool calls from content and add to toolCalls
            // Handle both <minimax:tool_call> and <tool_calls> formats
            const xmlPatterns = [
                /<minimax:tool_call[^>]*>([\s\S]*?)<\/minimax:tool_call>/g,
                /<tool_calls>([\s\S]*?)<\/tool_calls>/g,
            ];
            for (const regex of xmlPatterns) {
                let xmlMatch;
                while ((xmlMatch = regex.exec(result.content)) !== null) {
                    const body = xmlMatch[1].trim();
                    // Anthropic-style <invoke>
                    const invokeMatch = body.match(/<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/);
                    if (invokeMatch) {
                        const toolName = invokeMatch[1];
                        const invokeBody = invokeMatch[2].trim();
                        let toolArgs = {};
                        if (invokeBody.startsWith('{')) { try { toolArgs = JSON.parse(invokeBody); } catch (_) {} }
                        if (Object.keys(toolArgs).length === 0) {
                            const pr = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
                            let pm; while ((pm = pr.exec(invokeBody)) !== null) { toolArgs[pm[1]] = pm[2]; }
                        }
                        if (!result.toolCalls) result.toolCalls = [];
                        result.toolCalls.push({ id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`, type: 'function', function: { name: toolName, arguments: JSON.stringify(toolArgs) } });
                        console.log(`[MiniMax] Extracted XML tool call: ${toolName}`);
                    } else {
                        // Native MiniMax JSON format
                        const jsonMatches = body.match(/\{[^{}]*"name"\s*:\s*"[^"]+"[\s\S]*?\}/g);
                        if (jsonMatches) {
                            for (const js of jsonMatches) {
                                try {
                                    const p = JSON.parse(js);
                                    if (p.name) {
                                        if (!result.toolCalls) result.toolCalls = [];
                                        result.toolCalls.push({ id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.arguments || {}) } });
                                        console.log(`[MiniMax] Extracted native tool call: ${p.name}`);
                                    }
                                } catch (_) {}
                            }
                        }
                    }
                }
                result.content = result.content.replace(regex, '').trim();
            }
        }

        return result;
    }
}

module.exports = MiniMaxProvider;
