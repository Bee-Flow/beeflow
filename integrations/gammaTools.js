/**
 * Gamma Tools - Built-in tools for AI to create Gamma presentations,
 * documents, webpages, and social posts via the Gamma API v1.0.
 *
 * Gamma v1.0 is asynchronous: create a generation, then poll until it
 * completes. The public API can create new Gammas, list themes/folders,
 * and generate from templates. It does not currently list all Gamma files
 * or edit existing Gammas in place.
 */

const configStore = require('../stores/configStore');

const GAMMA_API_BASE_URL = 'https://public-api.gamma.app/v1.0';
const DEFAULT_REQUEST_TIMEOUT_MS = 45000;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_SECONDS = 180;
const MAX_TIMEOUT_SECONDS = 300;

const TEXT_MODE_ALIASES = {
    cards: 'preserve',
};

const COMMON_GENERATION_PROPERTIES = {
    themeId: {
        type: 'string',
        description: 'Optional Gamma theme ID. Use gamma_list_themes to discover available theme IDs.'
    },
    folderIds: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 10,
        description: 'Optional Gamma folder IDs to place the generated item in. Use gamma_list_folders to discover folder IDs.'
    },
    imageSource: {
        type: 'string',
        enum: [
            'aiGenerated',
            'pictographic',
            'pexels',
            'giphy',
            'webAllImages',
            'webFreeToUse',
            'webFreeToUseCommercially',
            'themeAccent',
            'placeholder',
            'noImages'
        ],
        description: 'Image source for the Gamma. Default: aiGenerated.'
    },
    imageModel: {
        type: 'string',
        description: 'Optional Gamma image model. Only relevant when imageSource is aiGenerated.'
    },
    imageStyle: {
        type: 'string',
        description: 'Optional style direction for AI-generated images, e.g. "photorealistic", "minimal vector illustration".'
    },
    imageStylePreset: {
        type: 'string',
        enum: ['photorealistic', 'illustration', 'abstract', '3D', 'lineArt', 'custom'],
        description: 'Optional Gamma built-in image style preset. Use custom with imageStyle for a custom prompt.'
    },
    sharingOptions: {
        type: 'object',
        description: 'Optional Gamma sharing settings.',
        properties: {
            workspaceAccess: {
                type: 'string',
                enum: ['noAccess', 'view', 'comment', 'edit']
            },
            externalAccess: {
                type: 'string',
                enum: ['noAccess', 'view', 'comment', 'edit']
            },
            emailOptions: {
                type: 'object',
                properties: {
                    recipients: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Email addresses to share with.'
                    },
                    access: {
                        type: 'string',
                        enum: ['view', 'comment', 'edit']
                    }
                }
            }
        }
    },
    exportAs: {
        type: 'string',
        enum: ['pdf', 'pptx', 'png'],
        description: 'Optionally export as PDF, PPTX, or PNG. Gamma returns a temporary signed export URL.'
    },
    waitForCompletion: {
        type: 'boolean',
        description: 'Whether to poll until the Gamma is completed or failed before returning. Default: false to keep chat streaming reliable; use gamma_get_generation_status later to check completion.'
    },
    timeoutSeconds: {
        type: 'number',
        minimum: 10,
        maximum: MAX_TIMEOUT_SECONDS,
        description: `Maximum seconds to wait when waitForCompletion is true. Default: ${DEFAULT_TIMEOUT_SECONDS}.`
    }
};

/**
 * Tool definitions in OpenAI function-calling format.
 */
const GAMMA_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'gamma_create_presentation',
            description: 'Start creating a new Gamma presentation, document, webpage, or social post from text. Returns a generationId quickly by default; call gamma_get_generation_status later to get gammaUrl/exportUrl. Use this for new presentations, pitch decks, reports, webpages, social posts, or fully regenerated replacements. Gamma does not edit existing items in place.',
            parameters: {
                type: 'object',
                properties: {
                    inputText: {
                        type: 'string',
                        description: 'The actual content, outline, notes, or topic to generate from. Image URLs can be included inline if they are publicly accessible.'
                    },
                    additionalInstructions: {
                        type: 'string',
                        description: 'Optional extra instructions for Gamma, e.g. "Keep headings short" or "Use bullet points".'
                    },
                    textMode: {
                        type: 'string',
                        enum: ['generate', 'condense', 'preserve', 'cards'],
                        description: 'How Gamma should interpret inputText. "generate" expands a topic, "condense" summarizes long text, "preserve" keeps provided text. "cards" is accepted as a deprecated alias for "preserve". Default: generate.'
                    },
                    format: {
                        type: 'string',
                        enum: ['presentation', 'document', 'social', 'webpage'],
                        description: 'Output format. Default: presentation.'
                    },
                    numCards: {
                        type: 'number',
                        minimum: 1,
                        description: 'Target number of cards/slides. Limits vary by Gamma plan.'
                    },
                    cardSplit: {
                        type: 'string',
                        enum: ['auto', 'inputTextBreaks'],
                        description: 'Use inputTextBreaks when inputText contains --- separators for specific card breaks. Default: auto.'
                    },
                    language: {
                        type: 'string',
                        description: 'Output language code, e.g. "en" for English, "nl" for Dutch, "de" for German. Default: en.'
                    },
                    audience: {
                        type: 'string',
                        description: 'Target audience, e.g. "executives", "developers", "business decision makers".'
                    },
                    tone: {
                        type: 'string',
                        description: 'Tone or voice, e.g. "professional, concise, upbeat".'
                    },
                    textAmount: {
                        type: 'string',
                        enum: ['brief', 'medium', 'detailed', 'extensive'],
                        description: 'How much text each card should contain when textMode is generate or condense.'
                    },
                    dimensions: {
                        type: 'string',
                        enum: ['fluid', '16x9', '4x3', 'pageless', 'letter', 'a4', '1x1', '4x5', '9x16'],
                        description: 'Card/page dimensions. Valid values depend on format: presentation supports fluid, 16x9, 4x3; document supports fluid, pageless, letter, a4; social supports 1x1, 4x5, 9x16.'
                    },
                    headerFooter: {
                        type: 'object',
                        description: 'Optional Gamma header/footer configuration. Pass through only when the user asks for page numbers, logo, or footer text.',
                        properties: {
                            topLeft: { type: 'object' },
                            topRight: { type: 'object' },
                            bottomLeft: { type: 'object' },
                            bottomRight: { type: 'object' },
                            hideFromFirstCard: { type: 'boolean' },
                            hideFromLastCard: { type: 'boolean' }
                        }
                    },
                    ...COMMON_GENERATION_PROPERTIES,
                },
                required: ['inputText']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'gamma_create_from_template',
            description: 'Start creating a new Gamma from an existing Gamma item used as a template. Use this when the user provides a Gamma template ID or a gamma.app/docs URL and wants a new item with the same layout/style but different content. This does not read or summarize the existing Gamma content; the prompt supplies the new content/instructions. Returns a generationId quickly by default; call gamma_get_generation_status later to get gammaUrl/exportUrl.',
            parameters: {
                type: 'object',
                properties: {
                    gammaId: {
                        type: 'string',
                        description: 'File ID of the template Gamma. The template must have exactly one Page in Gamma. If the user pasted a gamma.app/docs URL instead, use templateUrl.'
                    },
                    templateUrl: {
                        type: 'string',
                        description: 'Gamma share URL to use as a template source, e.g. https://gamma.app/docs/Title-abc123. The integration extracts the trailing URL ID as a template ID candidate. Prefer gammaId when the user explicitly provides one.'
                    },
                    gammaUrl: {
                        type: 'string',
                        description: 'Alias for templateUrl. Use this when the user pasted a Gamma URL and asks to create a new Gamma from it.'
                    },
                    prompt: {
                        type: 'string',
                        description: 'Text prompt or content describing what to generate from the template. Include the desired new content here; Gamma API does not read the current template content for you.'
                    },
                    ...COMMON_GENERATION_PROPERTIES,
                },
                required: ['prompt']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'gamma_revise_as_new',
            description: 'Workaround for editing: create a new revised Gamma from supplied existing content plus edit instructions. This does not modify an existing Gamma in place because Gamma API does not support in-place edits. Use when the user asks for partial edits and provides the current content or enough source material to regenerate.',
            parameters: {
                type: 'object',
                properties: {
                    originalContent: {
                        type: 'string',
                        description: 'Current deck/document content to preserve and revise. The API cannot read existing Gamma content by URL, so this must be supplied.'
                    },
                    editInstructions: {
                        type: 'string',
                        description: 'Specific requested changes, e.g. "Replace slide 3 with pricing details and keep the rest unchanged".'
                    },
                    sourceGammaId: {
                        type: 'string',
                        description: 'Optional source Gamma ID for traceability only. It is not edited.'
                    },
                    sourceGammaUrl: {
                        type: 'string',
                        description: 'Optional source Gamma URL for traceability only. It is not edited.'
                    },
                    format: {
                        type: 'string',
                        enum: ['presentation', 'document', 'social', 'webpage'],
                        description: 'Output format. Default: presentation.'
                    },
                    language: {
                        type: 'string',
                        description: 'Output language code, e.g. "en" or "nl". Default: en.'
                    },
                    dimensions: {
                        type: 'string',
                        enum: ['fluid', '16x9', '4x3', 'pageless', 'letter', 'a4', '1x1', '4x5', '9x16']
                    },
                    ...COMMON_GENERATION_PROPERTIES,
                },
                required: ['originalContent', 'editInstructions']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'gamma_get_generation_status',
            description: 'Check the status of an existing Gamma generation ID. Use this if a generation timed out or the user asks whether a Gamma job is done.',
            parameters: {
                type: 'object',
                properties: {
                    generationId: {
                        type: 'string',
                        description: 'Generation ID returned by Gamma.'
                    }
                },
                required: ['generationId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'gamma_list_themes',
            description: 'List available Gamma themes in the authenticated workspace. Use returned IDs as themeId when creating a Gamma.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Optional search query to filter themes by name.'
                    },
                    limit: {
                        type: 'number',
                        minimum: 1,
                        maximum: 50,
                        description: 'Maximum results to return. Default: 20.'
                    },
                    after: {
                        type: 'string',
                        description: 'Pagination cursor from a previous response.'
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'gamma_list_folders',
            description: 'List Gamma folders the authenticated user can access. Use returned IDs as folderIds when creating a Gamma.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Optional search query to filter folders by name.'
                    },
                    limit: {
                        type: 'number',
                        minimum: 1,
                        maximum: 50,
                        description: 'Maximum results to return. Default: 20.'
                    },
                    after: {
                        type: 'string',
                        description: 'Pagination cursor from a previous response.'
                    }
                }
            }
        }
    }
];

// Helpers

function normalizeTextMode(textMode = 'generate') {
    return TEXT_MODE_ALIASES[textMode] || textMode;
}

function clampLimit(limit, fallback = 20) {
    const n = Number(limit || fallback);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(50, Math.floor(n)));
}

function clampTimeoutSeconds(timeoutSeconds) {
    const n = Number(timeoutSeconds || DEFAULT_TIMEOUT_SECONDS);
    if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_SECONDS;
    return Math.max(10, Math.min(MAX_TIMEOUT_SECONDS, Math.floor(n)));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function compactObject(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
        const items = value
            .map(compactObject)
            .filter(item => item !== undefined && item !== null && item !== '');
        return items.length > 0 ? items : undefined;
    }

    const out = {};
    for (const [key, item] of Object.entries(value)) {
        const compacted = compactObject(item);
        if (compacted !== undefined && compacted !== null && compacted !== '') {
            out[key] = compacted;
        }
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function buildQuery(params = {}) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
            search.set(key, String(value));
        }
    }
    const query = search.toString();
    return query ? `?${query}` : '';
}

function extractErrorMessage(errorBody) {
    if (!errorBody) return 'Unknown error';
    if (typeof errorBody === 'string') return errorBody;
    if (typeof errorBody.error === 'string') return errorBody.error;
    if (errorBody.error?.message) return errorBody.error.message;
    if (errorBody.message) return errorBody.message;
    return JSON.stringify(errorBody);
}

function extractGammaIdFromUrl(value) {
    if (!value || typeof value !== 'string') return null;
    const input = value.trim();
    if (!input) return null;

    try {
        const url = new URL(input);
        const host = url.hostname.replace(/^www\./, '').toLowerCase();
        if (!host.endsWith('gamma.app') && !host.endsWith('gamma.site')) return null;

        const segments = url.pathname
            .split('/')
            .map(segment => decodeURIComponent(segment).trim())
            .filter(Boolean);
        if (segments.length === 0) return null;

        const lastSegment = segments[segments.length - 1].replace(/\.[a-z0-9]+$/i, '');
        if (!lastSegment) return null;
        if (/^g_[A-Za-z0-9_-]+$/.test(lastSegment)) return lastSegment;

        const parts = lastSegment.split('-').filter(Boolean);
        const candidate = parts[parts.length - 1] || lastSegment;
        if (/^[A-Za-z0-9_-]{6,}$/.test(candidate)) return candidate;
    } catch {
        // Not a URL. Fall through and treat a bare ID as a possible candidate.
    }

    if (/^g_[A-Za-z0-9_-]+$/.test(input)) return input;
    return null;
}

function resolveTemplateGammaId(args) {
    if (args.gammaId) {
        return {
            gammaId: String(args.gammaId).trim(),
            templateUrl: args.templateUrl || args.gammaUrl || null,
            usedUrlCandidate: false,
        };
    }

    const templateUrl = args.templateUrl || args.gammaUrl;
    const gammaId = extractGammaIdFromUrl(templateUrl);
    return {
        gammaId,
        templateUrl: templateUrl || null,
        usedUrlCandidate: !!gammaId && !!templateUrl,
    };
}

function buildImageOptions(args) {
    const imageOptions = compactObject({
        source: args.imageSource,
        model: args.imageModel,
        style: args.imageStyle,
        stylePreset: args.imageStylePreset,
    });
    return imageOptions;
}

function buildTextOptions(args) {
    return compactObject({
        language: args.language || 'en',
        audience: args.audience,
        tone: args.tone,
        amount: args.textAmount,
    });
}

function buildCardOptions(args) {
    return compactObject({
        dimensions: args.dimensions,
        headerFooter: args.headerFooter,
    });
}

function buildCreateBody(args) {
    const body = compactObject({
        inputText: args.inputText,
        additionalInstructions: args.additionalInstructions,
        textMode: normalizeTextMode(args.textMode),
        format: args.format || 'presentation',
        numCards: args.numCards,
        cardSplit: args.cardSplit,
        themeId: args.themeId,
        textOptions: buildTextOptions(args),
        imageOptions: buildImageOptions(args),
        cardOptions: buildCardOptions(args),
        sharingOptions: args.sharingOptions,
        folderIds: args.folderIds,
        exportAs: args.exportAs,
    });
    return body;
}

function buildTemplateBody(args) {
    return compactObject({
        prompt: args.prompt,
        gammaId: args.gammaId,
        themeId: args.themeId,
        imageOptions: buildImageOptions(args),
        sharingOptions: args.sharingOptions,
        folderIds: args.folderIds,
        exportAs: args.exportAs,
    });
}

function buildRevisionBody(args) {
    const trace = [
        args.sourceGammaId ? `Source Gamma ID: ${args.sourceGammaId}` : null,
        args.sourceGammaUrl ? `Source Gamma URL: ${args.sourceGammaUrl}` : null,
    ].filter(Boolean).join('\n');

    const additionalInstructions = [
        'Create a new revised Gamma. Preserve all supplied content unless the edit instructions explicitly change it.',
        args.editInstructions,
        trace ? `Traceability only; do not imply the source was edited in place.\n${trace}` : null,
    ].filter(Boolean).join('\n\n');

    return compactObject({
        inputText: args.originalContent,
        additionalInstructions,
        textMode: 'preserve',
        format: args.format || 'presentation',
        themeId: args.themeId,
        textOptions: compactObject({ language: args.language || 'en' }),
        imageOptions: buildImageOptions(args),
        cardOptions: buildCardOptions(args),
        sharingOptions: args.sharingOptions,
        folderIds: args.folderIds,
        exportAs: args.exportAs,
    });
}

function formatGenerationResult(result, meta = {}) {
    const response = {
        generationId: result.generationId || meta.generationId || null,
        status: result.status || 'pending',
        gammaId: result.gammaId || null,
        gammaUrl: result.gammaUrl || null,
    };

    if (result.exportUrl) response.exportUrl = result.exportUrl;
    if (result.credits) response.credits = result.credits;
    if (result.warnings) response.warnings = result.warnings;
    if (result.error) response.error = extractErrorMessage(result.error);
    if (meta.note) response.note = meta.note;
    if (meta.sourceGammaId) response.sourceGammaId = meta.sourceGammaId;
    if (meta.sourceGammaUrl) response.sourceGammaUrl = meta.sourceGammaUrl;
    if (meta.templateGammaId) response.templateGammaId = meta.templateGammaId;
    if (meta.templateUrl) response.templateUrl = meta.templateUrl;
    return response;
}

// API Client

async function gammaApiRequest(apiKey, path, { method = 'GET', body, query } = {}) {
    const url = `${GAMMA_API_BASE_URL}${path}${buildQuery(query)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
    if (typeof timeout.unref === 'function') timeout.unref();

    let response;
    try {
        response = await fetch(url, {
            method,
            headers: {
                'X-API-KEY': apiKey,
                'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`Gamma API request timed out after ${Math.round(DEFAULT_REQUEST_TIMEOUT_MS / 1000)}s`);
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }

    const text = await response.text();
    let data = null;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = text;
        }
    }

    if (!response.ok) {
        throw new Error(`Gamma API error ${response.status}: ${extractErrorMessage(data)}`);
    }

    return data || {};
}

async function pollGeneration(apiKey, generationId, timeoutSeconds) {
    const started = Date.now();
    const timeoutMs = timeoutSeconds * 1000;

    while (Date.now() - started <= timeoutMs) {
        const status = await gammaApiRequest(apiKey, `/generations/${encodeURIComponent(generationId)}`);
        if (status.status === 'completed' || status.status === 'failed') {
            return status;
        }
        await sleep(DEFAULT_POLL_INTERVAL_MS);
    }

    const latest = await gammaApiRequest(apiKey, `/generations/${encodeURIComponent(generationId)}`);
    if (latest.status === 'completed' || latest.status === 'failed') {
        return latest;
    }
    return {
        ...latest,
        timedOut: true,
    };
}

async function createAndMaybePoll(apiKey, path, body, args, meta = {}) {
    const waitForCompletion = args.waitForCompletion === true;
    const timeoutSeconds = clampTimeoutSeconds(args.timeoutSeconds);
    const created = await gammaApiRequest(apiKey, path, { method: 'POST', body });
    const generationId = created.generationId;

    if (!generationId) {
        return created;
    }

    if (!waitForCompletion) {
        const startNote = 'Generation started. Use gamma_get_generation_status with this generationId to check completion and retrieve gammaUrl/exportUrl.';
        return formatGenerationResult(created, {
            ...meta,
            generationId,
            note: meta.note ? `${meta.note} ${startNote}` : startNote,
        });
    }

    const result = await pollGeneration(apiKey, generationId, timeoutSeconds);
    const note = result.timedOut
        ? `Generation is still ${result.status || 'pending'} after ${timeoutSeconds}s. Use gamma_get_generation_status with this generationId to check again.`
        : meta.note;

    return formatGenerationResult(result, {
        ...meta,
        generationId,
        note,
    });
}

// Tool Execution

async function executeGammaTool(toolName, args = {}, userId) {
    const apiKey = await configStore.getSecret(`gamma_api_key_user_${userId}`);
    if (!apiKey) {
        return { error: 'Gamma API key not configured. Add it in Settings -> Gamma.' };
    }

    try {
        if (toolName === 'gamma_create_presentation') {
            if (!args.inputText) return { error: 'inputText is required' };
            const body = buildCreateBody(args);
            console.log(`[Gamma] Starting generation (${body.format || 'presentation'}): "${(body.inputText || '').substring(0, 80)}..."`);
            return await createAndMaybePoll(apiKey, '/generations', body, args);
        }

        if (toolName === 'gamma_create_from_template') {
            if (!args.prompt) return { error: 'prompt is required' };
            const template = resolveTemplateGammaId(args);
            if (!template.gammaId) {
                return {
                    error: 'gammaId or templateUrl is required. If using a Gamma URL, paste a gamma.app/docs link or copy the template gammaId from Gamma.',
                };
            }

            const body = buildTemplateBody({ ...args, gammaId: template.gammaId });
            const note = template.usedUrlCandidate
                ? 'Started from a Gamma URL by using the trailing URL ID as the template ID candidate. If Gamma returns not found, copy the exact gammaId from Gamma and retry.'
                : undefined;
            console.log(`[Gamma] Starting template generation from ${template.gammaId}: "${(args.prompt || '').substring(0, 80)}..."`);
            return await createAndMaybePoll(apiKey, '/generations/from-template', body, args, {
                templateGammaId: template.gammaId,
                templateUrl: template.templateUrl,
                note,
            });
        }

        if (toolName === 'gamma_revise_as_new') {
            if (!args.originalContent) return { error: 'originalContent is required because Gamma API cannot read existing Gamma content by URL.' };
            if (!args.editInstructions) return { error: 'editInstructions is required' };
            const body = buildRevisionBody(args);
            console.log(`[Gamma] Starting revised copy generation: "${(args.editInstructions || '').substring(0, 80)}..."`);
            return await createAndMaybePoll(apiKey, '/generations', body, args, {
                sourceGammaId: args.sourceGammaId || null,
                sourceGammaUrl: args.sourceGammaUrl || null,
                note: 'Created a new revised Gamma. The source Gamma was not edited in place because Gamma API does not support in-place edits.',
            });
        }

        if (toolName === 'gamma_get_generation_status') {
            if (!args.generationId) return { error: 'generationId is required' };
            const result = await gammaApiRequest(apiKey, `/generations/${encodeURIComponent(args.generationId)}`);
            return formatGenerationResult(result, { generationId: args.generationId });
        }

        if (toolName === 'gamma_list_themes') {
            return await gammaApiRequest(apiKey, '/themes', {
                query: {
                    query: args.query,
                    limit: clampLimit(args.limit),
                    after: args.after,
                }
            });
        }

        if (toolName === 'gamma_list_folders') {
            return await gammaApiRequest(apiKey, '/folders', {
                query: {
                    query: args.query,
                    limit: clampLimit(args.limit),
                    after: args.after,
                }
            });
        }

        return { error: `Unknown Gamma tool: ${toolName}` };
    } catch (err) {
        console.error('[Gamma] Error:', err.message);
        if (
            toolName === 'gamma_create_from_template'
            && (args.templateUrl || args.gammaUrl)
            && /Gamma API error 404|not found/i.test(err.message)
        ) {
            return {
                error: `${err.message}. I tried to use the trailing ID from the Gamma URL as the template gammaId. Gamma did not accept it, so copy the exact template gammaId from Gamma and retry.`,
            };
        }
        return { error: err.message };
    }
}

function isGammaTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('gamma_');
}

module.exports = {
    GAMMA_TOOLS,
    executeGammaTool,
    isGammaTool,
};
