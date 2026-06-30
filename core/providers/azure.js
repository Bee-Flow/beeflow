/**
 * Azure AI Provider Adapter
 *
 * Uses the `openai` npm package's `AzureOpenAI` class.
 * Extends OpenAIProvider — inherits ALL tool calling, streaming, reasoning,
 * verbosity, cache-hint and Responses-API logic. The only Azure-specific
 * behaviour lives here:
 *   - SDK init uses an Azure endpoint + API key + api-version + deployment.
 *   - store: false on the Responses API (see responsesStore below).
 *
 * Authentication (per Azure AI Foundry docs):
 *   - endpoint: Azure OpenAI resource URL (e.g. https://resource.openai.azure.com/)
 *   - apiKey: Azure API key
 *   - apiVersion: API version. Defaults to a recent dated preview
 *     (2025-04-01-preview) on the dated Azure surface (`/openai/responses`,
 *     `/openai/deployments/...`). openai-node v5+ also routes the v1 GA surface
 *     ('preview' → `/openai/v1/...`); we keep the dated default for back-compat
 *     and can switch to 'preview' (globally or per provider) when desired.
 *   - deployment: The deployment name (same as model name for Azure)
 *
 * Responses API support:
 *   - v1 GA surface ('preview'/'v1') supports client.responses.create.
 *   - Dated versions require apiVersion >= 2025-03-01.
 *   - Enables reasoning summaries ("thinking" bubbles) for GPT-5/o-series.
 *   - Falls back to Chat Completions for older dated API versions.
 *
 * Performance:
 *   - responsesStore = false — disables server-side response storage to avoid
 *     the DB lookups that add latency on Azure. BeeFlow manages conversation
 *     history itself, so the inherited base methods send full history and skip
 *     response chaining when storage is off.
 */

const OpenAIProvider = require('./openai');

// Default api-version on the dated Azure surface. openai-node v5+ can also
// route the v1 GA surface via apiVersion 'preview' (/openai/v1/...); kept dated
// here for back-compat — switch to 'preview' to adopt v1 GA.
const DEFAULT_API_VERSION = '2025-04-01-preview';
// Oldest dated api-version that supports the Responses API.
const RESPONSES_API_MIN_VERSION = '2025-03-01';

class AzureProvider extends OpenAIProvider {
    constructor() {
        super();
        this.name = 'azure';
        // Azure charges latency for server-side state lookups (store:true). Since
        // BeeFlow manages conversation history itself, run store:false — the
        // inherited Responses methods then send full history and skip chaining.
        this.responsesStore = false;
    }

    /** Effective api-version: provider config → env → v1 GA default. */
    _resolveApiVersion(options = {}) {
        return options.apiVersion || process.env.AZURE_OPENAI_API_VERSION || DEFAULT_API_VERSION;
    }

    // ─── Responses API gate ─────────────────────────────────────────
    // v1 GA ('preview'/'v1') always supports Responses. Dated versions
    // (2024-*) only support Chat Completions; 2025-03-01+ support Responses.
    shouldUseResponsesApi(model, options = {}) {
        if (!this.supportsReasoning(model)) return false;
        if (options.reasoningEffort === 'none') return false;

        const apiVersion = this._resolveApiVersion(options);
        if (apiVersion === 'preview' || apiVersion === 'v1') return true;

        // Dated version back-compat: require >= 2025-03-01.
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
     * @param {string} [options.apiVersion] - API version string ('preview' for v1 GA)
     * @param {string} [options.deployment] - Deployment name (model name)
     */
    createClient(apiKey, options = {}) {
        const { AzureOpenAI } = require('openai');

        // endpoint comes from the provider URL field
        const endpoint = options.endpoint || process.env.AZURE_OPENAI_ENDPOINT;
        const apiVersion = this._resolveApiVersion(options);
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
    // The actual request building (Chat Completions vs Responses, reasoning,
    // verbosity, tools, cache hints, streaming event loop) is inherited from
    // OpenAIProvider and is store-aware via this.responsesStore.

    async chat(apiKey, baseUrl, model, messages, options = {}) {
        // For Azure, baseUrl IS the endpoint, model IS the deployment
        const client = this.createClient(apiKey, {
            endpoint: baseUrl,
            apiVersion: options.apiVersion,
            deployment: model,
        });

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

        if (this.shouldUseResponsesApi(model, options)) {
            console.log('[Azure] Using Responses API streaming for model:', model);
            return this._streamResponses(client, model, messages, options, onEvent);
        }
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
