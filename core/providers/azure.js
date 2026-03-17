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
 *   - apiVersion: API version (e.g. 2024-04-01-preview)
 *   - deployment: The deployment name (same as model name for Azure)
 *
 * IMPORTANT:
 *   - Azure AI Foundry does NOT support the Responses API (client.responses.create)
 *   - Only client.chat.completions.create is supported
 *   - The deployment parameter must be passed to the AzureOpenAI constructor
 */

const OpenAIProvider = require('./openai');

class AzureProvider extends OpenAIProvider {
    constructor() {
        super();
        this.name = 'azure';
    }

    // ─── Azure NEVER uses Responses API ─────────────────────────────
    // Azure AI Foundry only supports Chat Completions API.
    // Override parent to always return false.
    shouldUseResponsesApi(model, options = {}) {
        return false;
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
        const apiVersion = options.apiVersion || process.env.AZURE_OPENAI_API_VERSION || '2024-04-01-preview';
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

        // Azure only supports Chat Completions API
        return this._chatCompletions(client, model, messages, options);
    }

    async stream(apiKey, baseUrl, model, messages, options = {}, onEvent) {
        const client = this.createClient(apiKey, {
            endpoint: baseUrl,
            apiVersion: options.apiVersion,
            deployment: model,
        });

        // Azure only supports Chat Completions API
        return this._streamCompletions(client, model, messages, options, onEvent);
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
