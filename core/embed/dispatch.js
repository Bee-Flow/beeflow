/**
 * Shared embedding dispatcher.
 *
 * Single Azure-aware embedding chain used by BOTH KB ingestion and the
 * node-search web-search pipeline, so both resolve embeddings identically:
 *   1. Global Embeddings provider (`ai.embeddingProviderId` / `embeddingModel`)
 *      — OpenAI-compatible APIs (OpenAI, Mistral, generic) and Azure.
 *   2. Legacy `azure_openai_embedding_*` configStore keys.
 *   3. In-process CPU embedder (Xenova/multilingual-e5-small, 384-dim).
 *
 * Returns { vectors, source, model } where vectors is [][] aligned with input
 * order. `source` is one of 'provider' | 'azure' | 'cpu' | null.
 */

const configStore = require('../../stores/configStore');

/**
 * Generate embeddings via Azure OpenAI (legacy direct config).
 *
 * @param {string[]} texts — array of text strings to embed
 * @param {string} endpoint — Azure OpenAI endpoint
 * @param {string} apiKey — Azure OpenAI API key
 * @param {string} model — deployment name (e.g. 'text-embedding-3-small')
 * @returns {Promise<number[][]>} — array of embedding vectors
 */
async function azureEmbed(texts, endpoint, apiKey, model) {
    const cleanEndpoint = endpoint.replace(/\/$/, '');
    const url = `${cleanEndpoint}/openai/deployments/${model}/embeddings?api-version=2024-06-01`;

    // Batch in groups of 16 to avoid rate limits
    const BATCH_SIZE = 16;
    const allEmbeddings = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);

        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'api-key': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ input: batch }),
            signal: AbortSignal.timeout(30000),
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Azure embedding failed (${res.status}): ${errText}`);
        }

        const data = await res.json();
        const sorted = data.data
            .sort((a, b) => a.index - b.index)
            .map(item => item.embedding);
        allEmbeddings.push(...sorted);
    }

    return allEmbeddings;
}

/**
 * Dispatch an embedding call through the configured chain (provider → Azure → CPU).
 */
async function dispatchEmbedTexts(texts) {
    if (!Array.isArray(texts) || texts.length === 0) return { vectors: [], source: null, model: null };

    // (1) Configured global provider via resolveEmbedTarget
    try {
        const { resolveEmbedTarget } = require('./resolveTarget');
        const target = await resolveEmbedTarget();
        if (target?.endpoint && target?.modelId && target?.apiKey) {
            const root = target.endpoint.replace(/\/+$/, '');
            const isAzure = target.providerType === 'azure';
            const url = isAzure
                ? `${root}/openai/deployments/${encodeURIComponent(target.modelId)}/embeddings?api-version=2024-06-01`
                : (root.endsWith('/v1') ? `${root}/embeddings` : `${root}/v1/embeddings`);

            const BATCH = 16;
            const out = [];
            for (let i = 0; i < texts.length; i += BATCH) {
                const batch = texts.slice(i, i + BATCH);
                const headers = isAzure
                    ? { 'Content-Type': 'application/json', 'api-key': target.apiKey }
                    : { 'Content-Type': 'application/json', Authorization: `Bearer ${target.apiKey}` };
                const body = isAzure
                    ? JSON.stringify({ input: batch })
                    : JSON.stringify({ model: target.modelId, input: batch });
                const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) });
                if (!res.ok) {
                    const errTxt = await res.text();
                    throw new Error(`${target.providerName || target.providerType || 'provider'} embed ${res.status}: ${errTxt.slice(0, 200)}`);
                }
                const data = await res.json();
                const sorted = (data.data || []).sort((a, b) => a.index - b.index).map(e => e.embedding);
                out.push(...sorted);
            }
            console.log(`[Embed] Embeddings via ${target.providerName || target.providerType} / ${target.modelId} (dim=${out[0]?.length})`);
            return { vectors: out, source: 'provider', model: target.modelId };
        }
    } catch (err) {
        console.warn(`[Embed] Configured provider embed failed (${err.message}); falling through to Azure/CPU`);
    }

    // (2) Legacy azure_openai_embedding_* config
    const azureEndpoint = await configStore.getConfig('azure_openai_embedding_endpoint');
    const azureKey = await configStore.getSecret('azure_openai_embedding_key');
    const azureModel = await configStore.getConfig('azure_openai_embedding_model') || 'text-embedding-3-small';
    if (azureEndpoint && azureKey) {
        try {
            const out = await azureEmbed(texts, azureEndpoint, azureKey, azureModel);
            console.log(`[Embed] Embeddings via legacy Azure config / ${azureModel} (dim=${out[0]?.length})`);
            return { vectors: out, source: 'azure', model: azureModel };
        } catch (err) {
            console.warn(`[Embed] Legacy Azure embed failed (${err.message}); falling through to CPU`);
        }
    }

    // (3) CPU in-process fallback (Xenova/multilingual-e5-small, 384-dim)
    try {
        const { cpuEmbed } = require('./cpuEmbed');
        const vectors = await cpuEmbed(texts, { kind: 'passage' });
        if (vectors.length > 0) {
            console.log(`[Embed] Embeddings via in-process CPU embedder (dim=${vectors[0]?.length})`);
            return { vectors, source: 'cpu', model: 'multilingual-e5-small' };
        }
    } catch (err) {
        console.warn(`[Embed] CPU embed failed (${err.message})`);
    }

    return { vectors: [], source: null, model: null };
}

module.exports = { dispatchEmbedTexts, azureEmbed };
