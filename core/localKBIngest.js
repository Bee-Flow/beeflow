/**
 * Local KB Ingestion — bypasses the search-service for chunking + embedding.
 *
 * Used when Azure Document Processing is enabled and the deployment
 * doesn't have a local search-service instance.
 *
 * Steps:
 *   1. Chunk text (token-aware, heading/paragraph boundaries)
 *   2. Generate embeddings via Azure OpenAI
 *   3. Store chunks directly in PostgreSQL `kb_chunks` table
 */

const { exec, getAll, getClient } = require('../db');
const configStore = require('../stores/configStore');

// ── Token-aware text chunking ───────────────────────────────────────

const CHUNK_SIZE = 200;    // tokens per chunk
const CHUNK_OVERLAP = 50;  // token overlap

/**
 * Simple token counter based on whitespace + punctuation splitting.
 * Not as precise as tiktoken, but good enough for chunking.
 */
function estimateTokens(text) {
    if (!text) return 0;
    // Rough approximation: ~4 chars per token for English
    return Math.ceil(text.length / 4);
}

/**
 * Split text into natural sections at heading and paragraph boundaries.
 */
function splitIntoSections(text) {
    // Split on markdown headings or double newlines
    const parts = text.split(/(?=(?:^|\n)#{1,6}\s)|(?:\n\n)+/);
    return parts.filter(p => p && p.trim());
}

/**
 * Split a long section by sentence boundaries.
 */
function splitLongSection(text, chunkSize) {
    const sentences = text.split(/(?<=[.!?])\s+/);
    const parts = [];
    let current = [];
    let currentCount = 0;

    for (const sentence of sentences) {
        const sentTokens = estimateTokens(sentence);

        if (currentCount + sentTokens > chunkSize && current.length > 0) {
            parts.push(current.join(' '));
            // Keep overlap
            const overlapText = current.slice(-1).join(' ');
            current = [overlapText, sentence];
            currentCount = estimateTokens(current.join(' '));
        } else {
            current.push(sentence);
            currentCount += sentTokens;
        }
    }

    if (current.length > 0) {
        parts.push(current.join(' '));
    }

    return parts.length > 0 ? parts : [text];
}

/**
 * Chunk text into token-aware pieces with overlap.
 * Port of the Python splitter.py logic.
 *
 * @param {string} text — input text to chunk
 * @returns {Array<{chunk_id: number, text: string, token_count: number}>}
 */
function chunkText(text) {
    if (!text || !text.trim()) return [];

    const sections = splitIntoSections(text);
    const chunks = [];
    let currentParts = [];
    let currentTokenCount = 0;
    let chunkId = 0;

    for (const section of sections) {
        const sectionTokens = estimateTokens(section);

        // If this single section exceeds chunk_size, split it further
        if (sectionTokens > CHUNK_SIZE) {
            // Flush current buffer first
            if (currentParts.length > 0) {
                const chunkText = currentParts.join('').trim();
                if (chunkText) {
                    chunks.push({ chunk_id: chunkId, text: chunkText, token_count: currentTokenCount });
                    chunkId++;
                }
                currentParts = [];
                currentTokenCount = 0;
            }

            // Split the long section by sentences
            const subParts = splitLongSection(section, CHUNK_SIZE);
            for (const sp of subParts) {
                const spTokens = estimateTokens(sp);
                chunks.push({ chunk_id: chunkId, text: sp.trim(), token_count: spTokens });
                chunkId++;
            }
            continue;
        }

        // Check if adding this section exceeds chunk_size
        if (currentTokenCount + sectionTokens > CHUNK_SIZE) {
            // Flush current chunk
            const chunkText = currentParts.join('').trim();
            if (chunkText) {
                chunks.push({ chunk_id: chunkId, text: chunkText, token_count: currentTokenCount });
                chunkId++;
            }
            // Keep overlap (last portion)
            if (currentParts.length > 0) {
                const lastPart = currentParts[currentParts.length - 1];
                const overlapTokens = estimateTokens(lastPart);
                if (overlapTokens <= CHUNK_OVERLAP) {
                    currentParts = [lastPart];
                    currentTokenCount = overlapTokens;
                } else {
                    currentParts = [];
                    currentTokenCount = 0;
                }
            } else {
                currentParts = [];
                currentTokenCount = 0;
            }
        }

        currentParts.push(section);
        currentTokenCount += sectionTokens;
    }

    // Final chunk
    if (currentParts.length > 0) {
        const chunkText = currentParts.join('').trim();
        if (chunkText) {
            chunks.push({ chunk_id: chunkId, text: chunkText, token_count: currentTokenCount });
        }
    }

    // Filter out tiny chunks (< 30 tokens)
    const MIN_TOKENS = 30;
    const filtered = chunks.filter(c => c.token_count >= MIN_TOKENS);

    // Re-number chunk IDs
    filtered.forEach((c, i) => { c.chunk_id = i; });

    return filtered;
}

// ── Azure OpenAI Embeddings ─────────────────────────────────────────

/**
 * Generate embeddings via Azure OpenAI.
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

// ── Database schema bootstrap ───────────────────────────────────────

let schemaInitialized = false;
let pgvectorAvailable = true;

async function ensureKBChunksTable(vectorDim = 1536) {
    if (schemaInitialized) return;

    try {
        // Try to enable pgvector
        await exec('CREATE EXTENSION IF NOT EXISTS vector');
        pgvectorAvailable = true;
    } catch (e) {
        console.warn('[LocalKBIngest] pgvector extension not available — vector search disabled, keyword search will still work. Install postgresql-XX-pgvector to enable.');
        pgvectorAvailable = false;
    }

    // Create kb_chunks table matching the search-service schema
    if (pgvectorAvailable) {
        await exec(`
            CREATE TABLE IF NOT EXISTS kb_chunks (
                id            BIGSERIAL PRIMARY KEY,
                tenant_id     TEXT NOT NULL,
                knowledge_base_id TEXT NOT NULL,
                document_id   TEXT NOT NULL,
                chunk_id      INT NOT NULL,
                lang          TEXT,
                title         TEXT,
                content       TEXT NOT NULL,
                tsv           TSVECTOR,
                embedding     VECTOR(${vectorDim}),
                source_uri    TEXT,
                created_at    TIMESTAMPTZ DEFAULT now()
            )
        `);
    } else {
        await exec(`
            CREATE TABLE IF NOT EXISTS kb_chunks (
                id            BIGSERIAL PRIMARY KEY,
                tenant_id     TEXT NOT NULL,
                knowledge_base_id TEXT NOT NULL,
                document_id   TEXT NOT NULL,
                chunk_id      INT NOT NULL,
                lang          TEXT,
                title         TEXT,
                content       TEXT NOT NULL,
                tsv           TSVECTOR,
                source_uri    TEXT,
                created_at    TIMESTAMPTZ DEFAULT now()
            )
        `);
    }

    // Create indexes
    try { await exec('CREATE INDEX IF NOT EXISTS idx_kb_chunks_tsv ON kb_chunks USING GIN (tsv)'); } catch (_) {}
    if (pgvectorAvailable) {
        try { await exec(`CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding ON kb_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 200)`); } catch (_) {}
    }
    try { await exec('CREATE INDEX IF NOT EXISTS idx_kb_chunks_tenant_kb ON kb_chunks (tenant_id, knowledge_base_id)'); } catch (_) {}
    try { await exec('CREATE INDEX IF NOT EXISTS idx_kb_chunks_tenant_kb_doc ON kb_chunks (tenant_id, knowledge_base_id, document_id)'); } catch (_) {}

    schemaInitialized = true;
    console.log('[LocalKBIngest] kb_chunks table ensured');
}

// ── Main ingestion function ─────────────────────────────────────────

/**
 * Ingest content locally — chunk, embed via Azure, store in PostgreSQL.
 *
 * @param {string} tenantId — user ID
 * @param {string} kbId — knowledge base ID
 * @param {string} docId — document ID
 * @param {string} content — text content to ingest
 * @param {object} options
 * @param {string} [options.title]
 * @param {string} [options.sourceUri]
 * @param {string} [options.lang='auto']
 * @returns {Promise<{chunks_created: number}>}
 */
async function ingestLocally(tenantId, kbId, docId, content, options = {}) {
    const { title = '', sourceUri = '', lang = 'auto' } = options;

    // Get Azure credentials
    const endpoint = await configStore.getConfig('azure_openai_embedding_endpoint');
    const apiKey = await configStore.getSecret('azure_openai_embedding_key');
    const model = await configStore.getConfig('azure_openai_embedding_model') || 'text-embedding-3-small';

    if (!endpoint || !apiKey) {
        throw new Error('Azure OpenAI embedding not configured (endpoint or key missing)');
    }

    // Ensure table exists
    await ensureKBChunksTable(1536);

    // 1. Chunk
    const chunks = chunkText(content);
    if (chunks.length === 0) {
        throw new Error('Document produced no chunks');
    }

    console.log(`[LocalKBIngest] Chunked into ${chunks.length} pieces`);

    // 2. Embed
    const chunkTexts = chunks.map(c => c.text);
    let embeddings = [];
    if (pgvectorAvailable) {
        console.log(`[LocalKBIngest] Generating Azure embeddings (${model})...`);
        try {
            embeddings = await azureEmbed(chunkTexts, endpoint, apiKey, model);
        } catch (err) {
            console.warn(`[LocalKBIngest] Azure embedding failed: ${err.message}. Falling back to keyword search only.`);
        }
    } else {
        console.log('[LocalKBIngest] Skipping embedding generation (pgvector disabled)');
    }

    // 3. Store in PostgreSQL
    const client = await getClient();
    try {
        await client.query('BEGIN');

        // Delete old chunks for this document (re-ingestion)
        await client.query(
            'DELETE FROM kb_chunks WHERE tenant_id = $1 AND knowledge_base_id = $2 AND document_id = $3',
            [tenantId, kbId, docId]
        );

        // Insert new chunks
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            
            if (pgvectorAvailable && embeddings[i]) {
                const vectorStr = `[${embeddings[i].join(',')}]`;
                await client.query(
                    `INSERT INTO kb_chunks (
                        tenant_id, knowledge_base_id, document_id,
                        chunk_id, lang, title, content, tsv, embedding, source_uri
                    ) VALUES (
                        $1, $2, $3,
                        $4, $5, $6, $7,
                        setweight(to_tsvector('dutch', $7), 'A') ||
                        setweight(to_tsvector('english', $7), 'B') ||
                        setweight(to_tsvector('simple', $7), 'C'),
                        $8::vector,
                        $9
                    )`,
                    [tenantId, kbId, docId, chunk.chunk_id, lang, title, chunk.text, vectorStr, sourceUri]
                );
            } else {
                await client.query(
                    `INSERT INTO kb_chunks (
                        tenant_id, knowledge_base_id, document_id,
                        chunk_id, lang, title, content, tsv, source_uri
                    ) VALUES (
                        $1, $2, $3,
                        $4, $5, $6, $7,
                        setweight(to_tsvector('dutch', $7), 'A') ||
                        setweight(to_tsvector('english', $7), 'B') ||
                        setweight(to_tsvector('simple', $7), 'C'),
                        $8
                    )`,
                    [tenantId, kbId, docId, chunk.chunk_id, lang, title, chunk.text, sourceUri]
                );
            }
        }

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }

    console.log(`[LocalKBIngest] Stored ${chunks.length} chunks in PostgreSQL`);
    return { chunks_created: chunks.length };
}

/**
 * Delete chunks for a document locally.
 */
async function deleteChunksLocally(tenantId, kbId, docId) {
    await ensureKBChunksTable();

    const client = await getClient();
    try {
        await client.query(
            'DELETE FROM kb_chunks WHERE tenant_id = $1 AND knowledge_base_id = $2 AND document_id = $3',
            [tenantId, kbId, docId]
        );
    } finally {
        client.release();
    }
}

/**
 * Search locally-ingested KB chunks using hybrid (vector + FTS) search.
 *
 * @param {string} tenantId — user ID
 * @param {string[]} kbIds — knowledge base IDs to search
 * @param {string} query — user query text
 * @param {object} options
 * @param {number} [options.topK=10]
 * @returns {Promise<Array<{content: string, title: string, source_uri: string, score: number}>>}
 */
async function searchLocally(tenantId, kbIds, query, options = {}) {
    const { topK = 10 } = options;

    // Get Azure credentials for embedding the query
    const endpoint = await configStore.getConfig('azure_openai_embedding_endpoint');
    const apiKey = await configStore.getSecret('azure_openai_embedding_key');
    const model = await configStore.getConfig('azure_openai_embedding_model') || 'text-embedding-3-small';
    if (pgvectorAvailable && (!endpoint || !apiKey)) {
        throw new Error('Azure OpenAI embedding not configured');
    }

    await ensureKBChunksTable(1536);

    let vectorResults = { rows: [] };
    const client = await getClient();

    try {
        // A. Vector search
        if (pgvectorAvailable) {
            try {
                // Embed the query
                const queryEmbedding = await azureEmbed([query], endpoint, apiKey, model);
                const vectorStr = `[${queryEmbedding[0].join(',')}]`;

                vectorResults = await client.query(
                    `SELECT id, title, content, source_uri,
                            1 - (embedding <=> $1::vector) AS vec_score
                     FROM kb_chunks
                     WHERE tenant_id = $2
                       AND knowledge_base_id = ANY($3::text[])
                     ORDER BY embedding <=> $1::vector
                     LIMIT $4`,
                    [vectorStr, tenantId, kbIds, topK * 3]
                );
            } catch (err) {
                console.warn(`[LocalKBIngest] Vector search failed: ${err.message}`);
            }
        }

        // B. Full-text search
        let ftsResults = { rows: [] };
        const sanitizedQuery = query
            .replace(/[\\\"'*^$(){}[\]\\\\]/g, '')
            .split(/\s+/)
            .filter(w => w.length > 1)
            .filter(w => !/^(AND|OR|NOT|NEAR)$/i.test(w))
            .join(' & ');

        if (sanitizedQuery.length > 0) {
            try {
                ftsResults = await client.query(
                    `SELECT id, title, content, source_uri,
                            GREATEST(
                                ts_rank_cd(tsv, websearch_to_tsquery('dutch', $1)),
                                ts_rank_cd(tsv, websearch_to_tsquery('english', $1)),
                                ts_rank_cd(tsv, websearch_to_tsquery('simple', $1))
                            ) AS fts_score
                     FROM kb_chunks
                     WHERE tenant_id = $2
                       AND knowledge_base_id = ANY($3::text[])
                       AND (
                           tsv @@ websearch_to_tsquery('dutch', $1)
                           OR tsv @@ websearch_to_tsquery('english', $1)
                           OR tsv @@ websearch_to_tsquery('simple', $1)
                       )
                     ORDER BY fts_score DESC
                     LIMIT 20`,
                    [sanitizedQuery, tenantId, kbIds]
                );
            } catch (e) {
                console.warn('[LocalKBSearch] FTS query failed:', e.message);
            }
        }

        // C. Reciprocal Rank Fusion
        const scores = new Map();
        const contentMap = new Map();
        const K = 60;

        vectorResults.rows.forEach((row, idx) => {
            const rank = idx + 1;
            scores.set(row.id, (scores.get(row.id) || 0) + 1 / (K + rank));
            contentMap.set(row.id, row);
        });

        ftsResults.rows.forEach((row, idx) => {
            const rank = idx + 1;
            scores.set(row.id, (scores.get(row.id) || 0) + 1 / (K + rank));
            if (!contentMap.has(row.id)) contentMap.set(row.id, row);
        });

        // D. Sort by fused score and return
        const results = Array.from(scores.entries())
            .map(([id, score]) => {
                const row = contentMap.get(id);
                return {
                    content: row.content,
                    title: row.title || '',
                    source_uri: row.source_uri || '',
                    score,
                };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);

        console.log(`[LocalKBSearch] Found ${results.length} results (vec=${vectorResults.rows.length}, fts=${ftsResults.rows.length})`);
        return results;
    } finally {
        client.release();
    }
}

/**
 * Retrieve concatenated chunk content for a document from kb_chunks.
 * Used by the re-index endpoint to recover existing content when Azure mode is active.
 *
 * @param {string} tenantId
 * @param {string} kbId
 * @param {string} docId
 * @returns {Promise<string>} concatenated content
 */
async function getDocumentContent(tenantId, kbId, docId) {
    const pool = require('../db').pool;
    const client = await pool.connect();
    try {
        const { rows } = await client.query(
            `SELECT content FROM kb_chunks
             WHERE tenant_id = $1 AND knowledge_base_id = $2 AND document_id = $3
             ORDER BY chunk_index ASC`,
            [tenantId, kbId, docId]
        );
        return rows.map(r => r.content).join('\n\n');
    } finally {
        client.release();
    }
}

module.exports = { ingestLocally, deleteChunksLocally, searchLocally, getDocumentContent, chunkText, azureEmbed };
