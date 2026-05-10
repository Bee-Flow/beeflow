/**
 * Embedding-target resolver — picks the right provider/model for an
 * embedding call based on global AI config (`ai.embeddingProviderId` +
 * `ai.embeddingModel`). Mirrors the logic in webSearchInferenceResolver
 * but exposed as a reusable helper so memoryStore, KB ingest, and any
 * future embedding caller can dispatch the same way.
 *
 * Returned shape (or null when nothing is configured):
 *   { providerId, providerName, providerType, modelId, endpoint, apiKey }
 */

const configStore = require('../../stores/configStore');

async function resolveEmbedTarget() {
    const ai = (await configStore.getConfig('ai')) || {};
    const providerId = ai.embeddingProviderId;
    const modelId = ai.embeddingModel;
    if (!providerId || !modelId) return null;

    const providers = ai.providers || [];
    const provider = providers.find(p => p.id === providerId);
    if (!provider) return null;

    return {
        providerId,
        providerName: provider.name || providerId,
        providerType: provider.type || null,
        modelId,
        endpoint: provider.url || null,
        apiKey: provider.apiKey || null,
    };
}

module.exports = { resolveEmbedTarget };
