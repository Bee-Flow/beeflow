/**
 * Web-Search Inference Routing
 *
 * The search-service has three inference tasks: embedding, reranking,
 * and webpage-content cleanup. Configuration is intentionally minimal:
 *
 *   - **embed** inherits the global Embeddings settings (`embeddingProviderId`
 *     + `embeddingModel` from `/ai/config`). One source of truth, no
 *     duplicate picker in the web-search panel.
 *   - **rerank** is a method-only choice: cosine similarity (default),
 *     local cross-encoder, or disabled. Provider-agnostic.
 *   - **cleanup** picks any chat model from a configured provider via
 *     the same `SearchableModelSelect` UX used elsewhere in the admin.
 *
 * Stored shape (`web_search_inference_config`):
 *   {
 *     rerank:  { method: 'cosine' | 'local' | 'disabled' },
 *     cleanup: { providerId: string, modelId: string }   // empty -> disabled
 *   }
 */

const configStore = require('../stores/configStore');

const RERANK_METHODS = new Set(['cosine', 'local', 'disabled']);

const DEFAULTS = {
    rerank:  { method: 'cosine' },
    cleanup: { providerId: '', modelId: '' },
};

function sanitizeRerankConfig(raw) {
    if (!raw || typeof raw !== 'object') return { ...DEFAULTS.rerank };
    return { method: RERANK_METHODS.has(raw.method) ? raw.method : DEFAULTS.rerank.method };
}

function sanitizeCleanupConfig(raw) {
    if (!raw || typeof raw !== 'object') return { ...DEFAULTS.cleanup };
    const providerId = typeof raw.providerId === 'string' ? raw.providerId.slice(0, 200) : '';
    const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim().slice(0, 200) : '';
    // Either both set or both empty — half-configured is treated as disabled.
    if (!providerId || !modelId) return { providerId: '', modelId: '' };
    return { providerId, modelId };
}

async function readWebSearchInferenceConfig() {
    const stored = await configStore.getConfig('web_search_inference_config') || {};
    return {
        rerank:  sanitizeRerankConfig(stored.rerank),
        cleanup: sanitizeCleanupConfig(stored.cleanup),
    };
}

async function writeWebSearchInferenceConfig(body) {
    const cleaned = {
        rerank:  sanitizeRerankConfig(body?.rerank),
        cleanup: sanitizeCleanupConfig(body?.cleanup),
    };
    await configStore.setConfig('web_search_inference_config', cleaned);
    return cleaned;
}

// ── Embed summary (read from global config — no picker on the web-search panel) ──

async function readEmbedSummary() {
    const ai = await configStore.getConfig('ai') || {};
    const providerId = ai.embeddingProviderId || null;
    const modelId = ai.embeddingModel || null;
    let providerName = null;

    if (providerId) {
        const providers = ai.providers || [];
        const p = providers.find(x => x.id === providerId);
        if (p) providerName = p.name || null;
    }

    return { providerId, providerName, modelId };
}

// ── Resolve the provider type for a given providerId (so we can pick the right SDK) ──

async function lookupProvider(providerId) {
    if (!providerId) return null;
    const ai = await configStore.getConfig('ai') || {};
    const providers = ai.providers || [];
    const p = providers.find(x => x.id === providerId);
    return p ? { id: p.id, name: p.name, type: p.type, url: p.url || null } : null;
}

// ── Resolve to outbound payload (no secrets) ─────────────────────────

async function resolveInferenceTargets() {
    const cfg = await readWebSearchInferenceConfig();
    const embedSummary = await readEmbedSummary();

    // ── embed ──
    const embedEntry = {
        task: 'embed',
        providerId: embedSummary.providerId,
        modelId: embedSummary.modelId,
    };
    if (embedSummary.providerId && embedSummary.modelId) {
        const p = await lookupProvider(embedSummary.providerId);
        if (p) {
            embedEntry.providerType = p.type;
            embedEntry.providerName = p.name;
            if (p.url) embedEntry.endpoint = p.url;
        } else {
            embedEntry.unresolved = true;
            embedEntry.reason = 'provider_not_found';
        }
    } else {
        embedEntry.unresolved = true;
        embedEntry.reason = 'not_configured';
    }

    // ── rerank ──
    const rerankEntry = { task: 'rerank', method: cfg.rerank.method };

    // ── cleanup ──
    const cleanupEntry = {
        task: 'cleanup',
        providerId: cfg.cleanup.providerId || null,
        modelId: cfg.cleanup.modelId || null,
    };
    if (cfg.cleanup.providerId && cfg.cleanup.modelId) {
        const p = await lookupProvider(cfg.cleanup.providerId);
        if (p) {
            cleanupEntry.providerType = p.type;
            cleanupEntry.providerName = p.name;
            if (p.url) cleanupEntry.endpoint = p.url;
        } else {
            cleanupEntry.unresolved = true;
            cleanupEntry.reason = 'provider_not_found';
        }
    }
    // empty providerId/modelId is the "disabled" state — not an error.

    return { embed: embedEntry, rerank: rerankEntry, cleanup: cleanupEntry };
}

// ── Resolve + attach API keys (for outbound forwarding only) ─────────

async function fetchProviderApiKey(providerId) {
    if (!providerId) return null;
    const ai = await configStore.getConfig('ai') || {};
    const providers = ai.providers || [];
    const p = providers.find(x => x.id === providerId);
    return p?.apiKey || null;
}

async function resolveInferenceTargetsWithSecrets() {
    const resolved = await resolveInferenceTargets();
    for (const task of ['embed', 'cleanup']) {
        const t = resolved[task];
        if (!t.providerId || !t.modelId) continue;
        const key = await fetchProviderApiKey(t.providerId);
        if (key) t.apiKey = key;
    }
    return resolved;
}

module.exports = {
    DEFAULTS,
    readWebSearchInferenceConfig,
    writeWebSearchInferenceConfig,
    readEmbedSummary,
    resolveInferenceTargets,
    resolveInferenceTargetsWithSecrets,
};
