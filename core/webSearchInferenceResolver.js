/**
 * Web-Search Inference Routing
 *
 * The search pipeline has three inference tasks — embedding, reranking,
 * and webpage-content cleanup — each independently configurable:
 *
 *   - **embed**   picks any embedding model. Empty -> inherit the global
 *                 Embeddings settings (`embeddingProviderId` + `embeddingModel`).
 *   - **rerank**  is either method-only (cosine similarity, local cross-encoder,
 *                 disabled) or provider-based (LLM-as-rerank / Cohere rerank).
 *   - **cleanup** picks any chat model from a configured provider.
 *
 * Stored shape (`web_search_inference_config`):
 *   {
 *     embed:   { providerId: string, modelId: string },                          // empty -> inherit global
 *     rerank:  { method: 'cosine'|'provider'|'local'|'disabled',
 *                providerId: string, modelId: string },                          // ids only meaningful when method='provider'
 *     cleanup: { providerId: string, modelId: string }                           // empty -> disabled
 *   }
 */

const configStore = require('../stores/configStore');

const RERANK_METHODS = new Set(['cosine', 'cpu', 'provider', 'local', 'disabled']);

const DEFAULTS = {
    embed:   { providerId: '', modelId: '' },
    rerank:  { method: 'cosine', providerId: '', modelId: '' },
    cleanup: { providerId: '', modelId: '' },
};

function sanitizeProviderModel(raw) {
    if (!raw || typeof raw !== 'object') return { providerId: '', modelId: '' };
    const providerId = typeof raw.providerId === 'string' ? raw.providerId.slice(0, 200) : '';
    const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim().slice(0, 200) : '';
    // Either both set or both empty — half-configured is treated as unset.
    if (!providerId || !modelId) return { providerId: '', modelId: '' };
    return { providerId, modelId };
}

function sanitizeEmbedConfig(raw) {
    return sanitizeProviderModel(raw);
}

function sanitizeRerankConfig(raw) {
    if (!raw || typeof raw !== 'object') return { ...DEFAULTS.rerank };
    const method = RERANK_METHODS.has(raw.method) ? raw.method : DEFAULTS.rerank.method;
    if (method !== 'provider') return { method, providerId: '', modelId: '' };
    const { providerId, modelId } = sanitizeProviderModel(raw);
    // Provider method without a target falls back to cosine — half-configured is invalid.
    if (!providerId || !modelId) return { method: 'cosine', providerId: '', modelId: '' };
    return { method, providerId, modelId };
}

function sanitizeCleanupConfig(raw) {
    return sanitizeProviderModel(raw);
}

async function readWebSearchInferenceConfig() {
    const stored = await configStore.getConfig('web_search_inference_config') || {};
    return {
        embed:   sanitizeEmbedConfig(stored.embed),
        rerank:  sanitizeRerankConfig(stored.rerank),
        cleanup: sanitizeCleanupConfig(stored.cleanup),
    };
}

async function writeWebSearchInferenceConfig(body) {
    const cleaned = {
        embed:   sanitizeEmbedConfig(body?.embed),
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
    return p ? { id: p.id, name: p.name, type: p.type, url: p.url || null, apiVersion: p.apiVersion || null } : null;
}

// ── Resolve to outbound payload (no secrets) ─────────────────────────

async function resolveInferenceTargets() {
    const cfg = await readWebSearchInferenceConfig();
    const embedSummary = await readEmbedSummary();

    // ── embed: per-feature override wins; otherwise inherit global ──
    const embedProviderId = cfg.embed.providerId || embedSummary.providerId;
    const embedModelId = cfg.embed.modelId || embedSummary.modelId;
    const embedSource = cfg.embed.providerId && cfg.embed.modelId ? 'override' : 'global';
    const embedEntry = {
        task: 'embed',
        providerId: embedProviderId,
        modelId: embedModelId,
        source: embedSource,
    };
    if (embedProviderId && embedModelId) {
        const p = await lookupProvider(embedProviderId);
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
    const rerankEntry = {
        task: 'rerank',
        method: cfg.rerank.method,
        providerId: cfg.rerank.providerId || null,
        modelId: cfg.rerank.modelId || null,
    };
    if (cfg.rerank.method === 'provider' && cfg.rerank.providerId && cfg.rerank.modelId) {
        const p = await lookupProvider(cfg.rerank.providerId);
        if (p) {
            rerankEntry.providerType = p.type;
            rerankEntry.providerName = p.name;
            if (p.url) rerankEntry.endpoint = p.url;
            rerankEntry.apiVersion = p.apiVersion; // honour provider's pinned api-version (Azure)
        } else {
            rerankEntry.unresolved = true;
            rerankEntry.reason = 'provider_not_found';
        }
    }

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
            cleanupEntry.apiVersion = p.apiVersion; // honour provider's pinned api-version (Azure)
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
    for (const task of ['embed', 'rerank', 'cleanup']) {
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
