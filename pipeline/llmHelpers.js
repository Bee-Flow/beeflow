/**
 * Pipeline LLM Helpers
 * Shared LLM call utilities and JSON extraction for the component pipeline.
 */

const { getAIConfig, getProviderForModel } = require('../core/aiAgent');

/**
 * Call the LLM with a system prompt, messages, and optional tools.
 * Resolves the provider and model automatically.
 */
async function callLLM({ systemPrompt, messages, tools = [], model = null, temperature = 0.7, maxTokens = 4000 }) {
    const baseConfig = await getAIConfig();
    const useModel = model || baseConfig.model;
    const providerConfig = await getProviderForModel(useModel);

    let apiUrl = providerConfig.url.replace(/\/+$/, '');
    if (!apiUrl.endsWith('/v1')) apiUrl = `${apiUrl}/v1`;

    const headers = { 'Content-Type': 'application/json' };
    if (providerConfig.apiKey) headers['Authorization'] = `Bearer ${providerConfig.apiKey}`;

    // Build messages — only include system message if systemPrompt is a non-empty string
    const allMessages = systemPrompt
        ? [{ role: 'system', content: systemPrompt }, ...messages]
        : messages;

    // Sanitize messages: ensure content is always a string (Mistral rejects null)
    const sanitizedMessages = allMessages.map(msg => ({
        ...msg,
        content: msg.content ?? ''
    }));

    const requestBody = {
        model: useModel,
        messages: sanitizedMessages,
        temperature,
        max_tokens: maxTokens
    };

    if (tools.length > 0) {
        requestBody.tools = tools;
        requestBody.tool_choice = 'auto';
    }

    const response = await fetch(`${apiUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`LLM API error: ${response.status} - ${error}`);
    }

    return await response.json();
}

/**
 * Extract JSON from LLM response text.
 * Tries code blocks first, then raw JSON, then object extraction.
 */
function extractJSON(text) {
    if (!text) return null;
    const codeBlockMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (codeBlockMatch) {
        try { return JSON.parse(codeBlockMatch[1]); } catch { }
    }
    try { return JSON.parse(text); } catch { }
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
        try { return JSON.parse(objMatch[0]); } catch { }
    }
    return null;
}

/**
 * Extract component JSON from LLM response text.
 * Handles the component code block format (with id, name, and code).
 */
function extractComponentFromResponse(text) {
    if (!text) return null;

    // Find JSON code blocks
    const matches = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
    for (const match of matches) {
        try {
            const parsed = JSON.parse(match[1]);
            if (parsed.id && parsed.name && parsed.code) {
                return parsed;
            }
        } catch { }
    }

    // Try the full text as JSON
    try {
        const parsed = JSON.parse(text);
        if (parsed.id && parsed.name && parsed.code) return parsed;
    } catch { }

    return null;
}

module.exports = {
    callLLM,
    extractJSON,
    extractComponentFromResponse
};
