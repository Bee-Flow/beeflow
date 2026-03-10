/**
 * Browser Agent — LLM Caller
 */

async function callLLM(providerConfig, model, messages, tools, temperature = 0, maxTokens = 800, signal = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (providerConfig.apiKey) {
        headers['Authorization'] = `Bearer ${providerConfig.apiKey}`;
    }

    let apiUrl = providerConfig.url.replace(/\/$/, '');
    if (!apiUrl.endsWith('/v1')) {
        apiUrl = `${apiUrl}/v1`;
    }

    const requestBody = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens
    };

    // Only include tools if provided and non-empty
    if (tools && tools.length > 0) {
        requestBody.tools = tools;
        requestBody.tool_choice = 'auto';
    }

    const response = await fetch(`${apiUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: signal || undefined
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`LLM API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return {
        message: data.choices?.[0]?.message || null,
        usage: data.usage || null
    };
}

module.exports = { callLLM };

