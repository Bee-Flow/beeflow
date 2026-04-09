/**
 * Azure AI Provider Adapter
 *
 * Uses the `openai` npm package's `AzureOpenAI` class.
 * Extends OpenAIProvider — inherits all tool calling, streaming,
 * reasoning logic. Only difference: SDK initialization uses
 * Azure endpoint + API key + API version + deployment.
 *
 * Authentication (per Azure AI Foundry docs):
 *   - endpoint: Azure OpenAI resource URL (e.g. https://resource.cognitiveservices.azure.com/)
 *   - apiKey: Azure API key
 *   - apiVersion: API version (e.g. 2025-04-01-preview)
 *   - deployment: The deployment name (same as model name for Azure)
 *
 * Responses API support:
 *   - Azure v1 API (GA August 2025) supports client.responses.create
 *   - Requires apiVersion >= 2025-03-01-preview
 *   - Enables reasoning summaries ("thinking" bubbles) for GPT-5/o-series
 *   - Falls back to Chat Completions for older API versions
 *
 * Performance optimizations (Azure-specific):
 *   - store: false — disables server-side response storage to avoid DB lookups
 *     that add latency on Azure. BeeFlow manages conversation history itself.
 *   - Tier-aware token defaults — uses TIER_DEFAULTS from modelResolver for
 *     optimised per-tier maxTokens instead of a flat 8192 fallback.
 */

const OpenAIProvider = require('./openai');
const { TIER_DEFAULTS } = require('../modelResolver');

// API versions that support the Responses API
const RESPONSES_API_MIN_VERSION = '2025-03-01';

class AzureProvider extends OpenAIProvider {
    constructor() {
        super();
        this.name = 'azure';
    }

    // ─── Responses API: enabled for new API versions ────────────────
    // Azure v1 API (2025+) supports Responses API with reasoning summaries.
    // Older versions (2024-*) only support Chat Completions.
    shouldUseResponsesApi(model, options = {}) {
        // First check if the model supports reasoning at all
        if (!this.supportsReasoning(model)) return false;
        if (options.reasoningEffort === 'none') return false;

        // Check API version — only use Responses API with 2025+ versions
        const apiVersion = options.apiVersion || '';
        if (!apiVersion) return false;

        // Extract the date portion (e.g. "2025-04-01" from "2025-04-01-preview")
        const versionDate = apiVersion.substring(0, 10);
        return versionDate >= RESPONSES_API_MIN_VERSION;
    }

    // ─── SDK Client (Azure mode) ─────────────────────────────────

    /**
     * Create an AzureOpenAI client.
     * Per Azure docs: new AzureOpenAI({ endpoint, apiKey, deployment, apiVersion })
     *
     * @param {string} apiKey - Azure API key
     * @param {object} [options] - Provider config options
     * @param {string} [options.endpoint] - Azure OpenAI endpoint URL
     * @param {string} [options.apiVersion] - API version string
     * @param {string} [options.deployment] - Deployment name (model name)
     */
    createClient(apiKey, options = {}) {
        const { AzureOpenAI } = require('openai');

        // endpoint comes from the provider URL field
        const endpoint = options.endpoint || process.env.AZURE_OPENAI_ENDPOINT;
        const apiVersion = options.apiVersion || process.env.AZURE_OPENAI_API_VERSION || '2025-04-01-preview';
        const deployment = options.deployment || undefined;

        if (!endpoint) {
            throw new Error('Azure AI requires an endpoint URL. Configure it in AI Settings → Providers.');
        }

        console.log(`[Azure] Creating client for endpoint=${endpoint}, apiVersion=${apiVersion}${deployment ? `, deployment=${deployment}` : ''}`);

        return new AzureOpenAI({
            endpoint,
            apiKey,
            apiVersion,
            deployment,
        });
    }

    // ─── Override chat/stream to pass endpoint + deployment ────────

    async chat(apiKey, baseUrl, model, messages, options = {}) {
        // For Azure, baseUrl IS the endpoint, model IS the deployment
        const client = this.createClient(apiKey, {
            endpoint: baseUrl,
            apiVersion: options.apiVersion,
            deployment: model,
        });

        // Choose API based on model capability and API version
        if (this.shouldUseResponsesApi(model, options)) {
            console.log('[Azure] Using Responses API for model:', model);
            return this._chatResponses(client, model, messages, options);
        }
        return this._chatCompletions(client, model, messages, options);
    }

    async stream(apiKey, baseUrl, model, messages, options = {}, onEvent) {
        const client = this.createClient(apiKey, {
            endpoint: baseUrl,
            apiVersion: options.apiVersion,
            deployment: model,
        });

        // Choose API based on model capability and API version
        if (this.shouldUseResponsesApi(model, options)) {
            console.log('[Azure] Using Responses API streaming for model:', model);
            return this._streamResponses(client, model, messages, options, onEvent);
        }
        return this._streamCompletions(client, model, messages, options, onEvent);
    }

    // ─── Azure-specific Responses API overrides ──────────────────────
    // Azure charges latency for server-side state lookups (store: true).
    // Since BeeFlow manages conversation history on its own backend,
    // we override store to false — eliminates DB lookup overhead on every request.

    async _chatResponses(client, model, messages, options = {}) {
        const params = {
            model,
            store: false, // Azure perf: skip server-side state storage
        };

        // Send full message history (no chaining without store)
        params.input = this.toResponsesInput(messages);

        if (options.maxTokens !== undefined) params.max_output_tokens = options.maxTokens;

        const reasoning = { summary: options.reasoningSummary ? 'auto' : 'concise' };
        const effort = this.normalizeEffort(model, options.reasoningEffort);
        reasoning.effort = effort || 'medium';
        params.reasoning = reasoning;

        console.log('[Azure] SDK chat (responses, store=false) for model:', model);
        const response = await client.responses.create(params);

        return {
            content: response.output_text || null,
            toolCalls: null,
            usage: response.usage || null,
            responseId: null, // No chaining without store
            raw: response,
        };
    }

    async _streamResponses(client, model, messages, options, onEvent) {
        const params = {
            model,
            stream: true,
            store: false, // Azure perf: skip server-side state storage
        };

        // Always send full history (no previous_response_id without store)
        params.input = this.toResponsesInput(messages);

        if (options.maxTokens !== undefined) params.max_output_tokens = options.maxTokens;

        const reasoning = { summary: options.reasoningSummary ? 'auto' : 'concise' };
        const effort = this.normalizeEffort(model, options.reasoningEffort);
        reasoning.effort = effort || 'medium';
        params.reasoning = reasoning;

        if (options.tools && options.tools.length > 0) {
            params.tools = options.tools.map(t => ({
                type: 'function',
                name: t.function?.name || t.name,
                description: t.function?.description || t.description || '',
                parameters: t.function?.parameters || t.parameters || {},
            }));
        }

        console.log('[Azure] SDK streaming (responses, store=false) for model:', model, 'reasoning:', JSON.stringify(reasoning));
        const stream = await client.responses.create(params);

        // Track current function call being accumulated
        let currentFnCall = null;
        let streamUsage = null;

        for await (const event of stream) {
            if (event.type === 'response.output_text.delta') {
                if (event.delta) onEvent('text', { text: event.delta });
            } else if (event.type === 'response.reasoning_summary_text.delta') {
                if (event.delta) onEvent('thinking', { text: event.delta });
            } else if (event.type === 'response.output_item.added') {
                // New output item — could be a function call
                if (event.item?.type === 'function_call') {
                    currentFnCall = {
                        id: event.item.call_id || event.item.id,
                        name: event.item.name || '',
                        arguments: '',
                    };
                }
            } else if (event.type === 'response.function_call_arguments.delta') {
                if (currentFnCall && event.delta) {
                    currentFnCall.arguments += event.delta;
                }
            } else if (event.type === 'response.function_call_arguments.done') {
                if (currentFnCall) {
                    let input = {};
                    try { input = JSON.parse(currentFnCall.arguments || '{}'); } catch (e) { }
                    onEvent('tool_use', {
                        id: currentFnCall.id,
                        name: currentFnCall.name,
                        input,
                    });
                    console.log(`[Azure] Responses stream tool_use: ${currentFnCall.name}`);
                    currentFnCall = null;
                }
            } else if (event.type === 'response.completed') {
                // Capture usage from completed response
                const usage = event.response?.usage;
                if (usage) {
                    streamUsage = {
                        prompt_tokens: usage.input_tokens || 0,
                        completion_tokens: usage.output_tokens || 0,
                        total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
                        cached_tokens: usage.input_tokens_details?.cached_tokens || 0,
                    };
                    if (streamUsage.cached_tokens > 0) {
                        console.log(`[Azure] ⚡ Responses API cache hit: ${streamUsage.cached_tokens} cached tokens`);
                    }
                }
                // No responseId capture — store is disabled
            }
        }

        onEvent('done', streamUsage || {});
    }

    // ─── List Models (Static from config) ──────────────────────────

    /**
     * Return models from the admin-configured static list.
     * No auto-discovery — user enters deployment names in the UI.
     */
    async listModels(apiKey, baseUrl, options = {}) {
        try {
            const configStore = require('../../stores/configStore');
            const raw = await configStore.getConfig('azure_models') || '';
            const names = raw.split(',').map(s => s.trim()).filter(Boolean);

            if (names.length === 0) {
                console.log('[Azure] No static models configured');
                return [];
            }

            const models = names.map(name => ({
                id: name,
                name: name,
            }));

            console.log(`[Azure] Returning ${models.length} static models: ${names.join(', ')}`);
            return models;
        } catch (e) {
            console.error('[Azure] Failed to read static models:', e.message);
            return [];
        }
    }
}

module.exports = AzureProvider;

