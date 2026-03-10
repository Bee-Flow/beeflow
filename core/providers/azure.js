/**
 * Azure AI Provider Adapter
 *
 * Uses the `openai` npm package's `AzureOpenAI` class.
 * Extends OpenAIProvider — inherits all tool calling, streaming,
 * reasoning logic. Only difference: SDK initialization uses
 * Azure endpoint + API key + API version.
 *
 * Authentication:
 *   - endpoint: Azure OpenAI resource URL (e.g. https://my-resource.openai.azure.com)
 *   - apiKey: Azure API key
 *   - apiVersion: API version (e.g. 2025-04-01-preview)
 *
 * Notes:
 *   - Same tool/message format as OpenAI
 *   - Reasoning models (o1, o3, o4-mini) use `developer` role + `max_completion_tokens`
 *   - Standard models use `system` role + `max_tokens` as normal
 */

const OpenAIProvider = require('./openai');

class AzureProvider extends OpenAIProvider {
    constructor() {
        super();
        this.name = 'azure';
    }

    // ─── SDK Client (Azure mode) ─────────────────────────────────

    /**
     * Create an AzureOpenAI client.
     * @param {string} apiKey - Azure API key
     * @param {object} [options] - Provider config options
     * @param {string} [options.endpoint] - Azure OpenAI endpoint URL
     * @param {string} [options.apiVersion] - API version string
     */
    createClient(apiKey, options = {}) {
        const { AzureOpenAI } = require('openai');

        // endpoint comes from the provider URL field
        const endpoint = options.endpoint || process.env.AZURE_OPENAI_ENDPOINT;
        const apiVersion = options.apiVersion || process.env.AZURE_OPENAI_API_VERSION || '2025-04-01-preview';

        if (!endpoint) {
            throw new Error('Azure AI requires an endpoint URL. Configure it in AI Settings → Providers.');
        }

        console.log(`[Azure] Creating client for endpoint=${endpoint}, apiVersion=${apiVersion}`);

        return new AzureOpenAI({
            endpoint,
            apiKey,
            apiVersion,
        });
    }

    // ─── Override chat/stream to pass endpoint from provider URL ──

    async chat(apiKey, baseUrl, model, messages, options = {}) {
        // For Azure, baseUrl IS the endpoint
        const client = this.createClient(apiKey, {
            endpoint: baseUrl,
            apiVersion: options.apiVersion,
        });

        if (this.shouldUseResponsesApi(model, options)) {
            return this._chatResponses(client, model, messages, options);
        }
        return this._chatCompletions(client, model, messages, options);
    }

    async stream(apiKey, baseUrl, model, messages, options = {}, onEvent) {
        const client = this.createClient(apiKey, {
            endpoint: baseUrl,
            apiVersion: options.apiVersion,
        });

        if (this.shouldUseResponsesApi(model, options)) {
            return this._streamResponses(client, model, messages, options, onEvent);
        }
        return this._streamCompletions(client, model, messages, options, onEvent);
    }

    // ─── List Models (Azure Deployments) ───────────────────────────

    /**
     * List deployed models via Azure REST API.
     * Azure OpenAI uses "deployments" — each deployment has a name and an underlying model.
     * The deployment name is what you use as the model ID when calling the API.
     */
    async listModels(apiKey, baseUrl, options = {}) {
        const endpoint = (baseUrl || '').replace(/\/+$/, '');
        const apiVersion = options.apiVersion || '2025-04-01-preview';

        if (!endpoint || !apiKey) {
            console.warn('[Azure] Cannot list models — missing endpoint or API key');
            return [];
        }

        try {
            // Azure OpenAI deployments REST API
            const url = `${endpoint}/openai/deployments?api-version=${apiVersion}`;
            console.log(`[Azure] Fetching deployments from: ${url}`);

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'api-key': apiKey,
                    'Content-Type': 'application/json',
                },
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[Azure] Deployments API error ${response.status}: ${errorText}`);
                // Fall back to SDK models.list()
                return this._listModelsViaSDK(apiKey, endpoint, options);
            }

            const data = await response.json();
            const deployments = data.data || data.value || [];

            const models = deployments.map(d => ({
                id: d.id || d.name || d.model,
                name: `${d.id || d.name} (${d.model || 'unknown'})`,
            }));

            console.log(`[Azure] Found ${models.length} deployments`);
            return models;
        } catch (e) {
            console.error('[Azure] Failed to list deployments:', e.message);
            // Fall back to SDK
            return this._listModelsViaSDK(apiKey, baseUrl, options);
        }
    }

    async _listModelsViaSDK(apiKey, endpoint, options = {}) {
        try {
            const client = this.createClient(apiKey, {
                endpoint,
                apiVersion: options.apiVersion,
            });
            const response = await client.models.list();
            const models = [];
            for await (const model of response) {
                models.push({ id: model.id, name: model.id });
            }
            console.log(`[Azure] Found ${models.length} models via SDK fallback`);
            return models;
        } catch (e) {
            console.error('[Azure] SDK listModels fallback failed:', e.message);
            return [];
        }
    }
}

module.exports = AzureProvider;
