/**
 * Gamma Tools — Built-in tools for AI to generate presentations via Gamma API
 * 
 * These tools are injected into the LLM tool set when a Gamma API key is configured,
 * allowing the AI to create presentations, documents, and web pages.
 */

const configStore = require('../stores/configStore');

const GAMMA_API_URL = 'https://api.gamma.app/api/generate';

/**
 * Tool definitions in OpenAI function-calling format.
 */
const GAMMA_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'gamma_create_presentation',
            description: 'Create a presentation, document, or web page using Gamma AI. Provide a prompt or detailed content and Gamma will generate a polished presentation. Returns a shareable URL and optional PDF/PPTX export link. Use this when the user asks to create, generate, or make a presentation, slides, pitch deck, or report.',
            parameters: {
                type: 'object',
                properties: {
                    inputText: {
                        type: 'string',
                        description: 'The content or prompt for the presentation. Can be a brief prompt (e.g. "Benefits of AI in healthcare") or detailed markdown content.'
                    },
                    textMode: {
                        type: 'string',
                        enum: ['generate', 'cards'],
                        description: 'How to process the input. "generate" = AI generates full content from a short prompt. "cards" = structures provided content into slides. Default: "generate"'
                    },
                    language: {
                        type: 'string',
                        description: 'Output language code, e.g. "en" for English, "nl" for Dutch, "de" for German. Default: "en"'
                    },
                    audience: {
                        type: 'string',
                        description: 'Target audience for the presentation, e.g. "marketing managers", "developers", "executives"'
                    },
                    imageSource: {
                        type: 'string',
                        enum: ['aiGenerated', 'pexels', 'noImages'],
                        description: 'Image source for slides. "aiGenerated" = AI-generated images, "pexels" = stock photos, "noImages" = text only. Default: "aiGenerated"'
                    },
                    imageStyle: {
                        type: 'string',
                        description: 'Style for AI-generated images, e.g. "photorealistic", "cinematic", "minimalist", "watercolor"'
                    },
                    exportAs: {
                        type: 'string',
                        enum: ['pdf', 'pptx'],
                        description: 'Optionally export the presentation as PDF or PPTX. Returns a temporary download URL.'
                    }
                },
                required: ['inputText']
            }
        }
    }
];

// ─── API Client ────────────────────────────────────────────────

async function gammaRequest(apiKey, body) {
    console.log(`[Gamma] Creating presentation: "${(body.inputText || '').substring(0, 80)}..."`);

    const response = await fetch(GAMMA_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errorText = await response.text();
        let errorMsg;
        try {
            const errorJson = JSON.parse(errorText);
            errorMsg = errorJson.error || errorJson.message || errorText;
        } catch {
            errorMsg = errorText;
        }
        throw new Error(`Gamma API error ${response.status}: ${errorMsg}`);
    }

    return response.json();
}

// ─── Tool Execution ────────────────────────────────────────────

async function executeGammaTool(toolName, args, userId) {
    const apiKey = await configStore.getSecret(`gamma_api_key_user_${userId}`);
    if (!apiKey) {
        return { error: 'Gamma API key not configured. Add it in Settings → Gamma.' };
    }

    if (toolName !== 'gamma_create_presentation') {
        return { error: `Unknown Gamma tool: ${toolName}` };
    }

    const {
        inputText,
        textMode = 'generate',
        language = 'en',
        audience,
        imageSource = 'aiGenerated',
        imageStyle,
        exportAs,
    } = args;

    if (!inputText) {
        return { error: 'inputText is required' };
    }

    const requestBody = {
        inputText,
        textMode,
        textOptions: {
            language,
        },
        imageOptions: {
            source: imageSource,
        },
    };

    if (audience) {
        requestBody.textOptions.audience = audience;
    }

    if (imageStyle && imageSource === 'aiGenerated') {
        requestBody.imageOptions.style = imageStyle;
    }

    if (exportAs) {
        requestBody.exportAs = exportAs;
    }

    try {
        const result = await gammaRequest(apiKey, requestBody);

        console.log(`[Gamma] Result: status=${result.status}, gammaId=${result.gammaId}`);

        const response = {
            status: result.status,
            gammaId: result.gammaId || null,
            gammaUrl: result.gammaUrl || null,
        };

        if (result.exportUrl) {
            response.exportUrl = result.exportUrl;
        }

        if (result.status === 'failed') {
            response.error = result.error || 'Generation failed';
        }

        return response;
    } catch (err) {
        console.error('[Gamma] Error:', err.message);
        return { error: err.message };
    }
}

function isGammaTool(toolName) {
    return toolName === 'gamma_create_presentation';
}

module.exports = {
    GAMMA_TOOLS,
    executeGammaTool,
    isGammaTool,
};
