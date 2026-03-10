/**
 * Knowledge Store — PostgreSQL with pgvector + tsvector
 *
 * Replaces SQLite FTS5 (keyword search) + sqlite-vec (vector search) with:
 * - pgvector extension for vector similarity search
 * - tsvector + GIN index for keyword search
 * - Reciprocal Rank Fusion for hybrid results
 */

const { v4: uuidv4 } = require('uuid');
const { run, getOne, getAll, exec, getClient } = require('../db');

let initialized = false;
async function initDB() {
    if (initialized) return;

    // Enable pgvector extension
    await exec('CREATE EXTENSION IF NOT EXISTS vector');

    // Metadata table (source of truth)
    await exec(`
        CREATE TABLE IF NOT EXISTS knowledge_metadata (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            content TEXT NOT NULL,
            metadata JSONB DEFAULT '{}',
            embedding_dimension INTEGER DEFAULT 1536,
            search_vector tsvector,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await exec('CREATE INDEX IF NOT EXISTS idx_knowledge_metadata_agent ON knowledge_metadata(agent_id)');
    await exec('CREATE INDEX IF NOT EXISTS idx_knowledge_metadata_search ON knowledge_metadata USING GIN(search_vector)');

    initialized = true;
}

// Chain: create table first, then add default vector column
initDB()
    .then(() => ensureVectorColumn(1536))
    .catch(err => console.error('[KnowledgeStore] Init error:', err.message));

// Track which vector columns have been created
const vectorColumnsCreated = new Set();

/**
 * Ensure a vector column exists for the given embedding dimension.
 * Uses ALTER TABLE to add typed vector(N) columns dynamically.
 */
async function ensureVectorColumn(dim) {
    await initDB();
    if (vectorColumnsCreated.has(dim)) return;

    const colName = `embedding_${dim}`;
    try {
        // Check if column already exists
        const col = await getOne(`SELECT column_name FROM information_schema.columns WHERE table_name = 'knowledge_metadata' AND column_name = $1`, [colName]);
        if (!col) {
            await exec(`ALTER TABLE knowledge_metadata ADD COLUMN "${colName}" vector(${dim})`);
            console.log(`[KnowledgeStore] Added vector column: ${colName}`);
        }
        // Create IVFFlat index if not exists (for tables with enough rows)
        // Using a simple index creation — IVFFlat needs lists param; use HNSW for small datasets
        try {
            await exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_vec_${dim} ON knowledge_metadata USING hnsw ("${colName}" vector_cosine_ops)`);
        } catch (e) {
            // HNSW index may fail on empty tables, that's fine — it'll be created lazily
            console.warn(`[KnowledgeStore] HNSW index for dim ${dim} deferred:`, e.message);
        }
    } catch (e) {
        console.error(`[KnowledgeStore] ensureVectorColumn(${dim}) error:`, e.message);
    }

    vectorColumnsCreated.add(dim);
}

// Default 1536 dimension column is created via the initDB().then() chain above

/**
 * Helper: Reciprocal Rank Fusion
 */
function reciprocalRankFusion(vectorResults, keywordResults, k = 60) {
    const scores = new Map();
    vectorResults.forEach((item, index) => {
        const rank = index + 1;
        scores.set(item.id, (scores.get(item.id) || 0) + 1 / (k + rank));
    });
    keywordResults.forEach((item, index) => {
        const rank = index + 1;
        scores.set(item.id, (scores.get(item.id) || 0) + 1 / (k + rank));
    });
    return Array.from(scores.entries())
        .map(([id, score]) => ({ id, score }))
        .sort((a, b) => b.score - a.score);
}

const KnowledgeStore = {
    /**
     * Add knowledge item with vector embedding + keyword search index
     */
    addKnowledge: async (agentId, content, embedding, metadata = {}) => {
        if (!embedding || embedding.length === 0) throw new Error("Invalid embedding: zero length");
        await initDB();

        const dim = embedding.length;
        await ensureVectorColumn(dim);

        const id = uuidv4();
        const colName = `embedding_${dim}`;
        const vectorStr = `[${embedding.join(',')}]`;

        const client = await getClient();
        try {
            await client.query('BEGIN');
            // 1. Insert metadata + vector + keyword search
            await client.query(
                `INSERT INTO knowledge_metadata (id, agent_id, content, metadata, embedding_dimension, "${colName}", search_vector)
                 VALUES ($1, $2, $3, $4, $5, $6::vector, to_tsvector('english', $7))`,
                [id, agentId, content, JSON.stringify(metadata), dim, vectorStr, content]
            );
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }

        return { id, agentId, content, metadata, embedding_dimension: dim };
    },

    /**
     * Delete knowledge item
     */
    deleteKnowledge: async (id) => {
        await initDB();
        await run('DELETE FROM knowledge_metadata WHERE id = $1', [id]);
        return true;
    },

    /**
     * Bulk delete all knowledge items matching a source URL
     */
    deleteBySource: async (agentId, source) => {
        await initDB();
        const rows = await getAll("SELECT id FROM knowledge_metadata WHERE agent_id = $1 AND metadata->>'source' = $2", [agentId, source]);
        if (rows.length === 0) return 0;

        let deleted = 0;
        for (const row of rows) {
            try {
                await KnowledgeStore.deleteKnowledge(row.id);
                deleted++;
            } catch (e) {
                console.error(`[KnowledgeStore] Failed to delete ${row.id}:`, e.message);
            }
        }
        console.log(`[KnowledgeStore] Bulk deleted ${deleted}/${rows.length} items from source: ${source}`);
        return deleted;
    },

    /**
     * Check if a source URL has already been imported for this agent
     */
    hasSource: async (agentId, source) => {
        await initDB();
        const rows = await getAll("SELECT id FROM knowledge_metadata WHERE agent_id = $1 AND metadata->>'source' = $2", [agentId, source]);
        return rows.length > 0 ? rows.length : 0;
    },

    /**
     * Fast check: does this agent have any knowledge entries?
     */
    hasKnowledge: async (agentId) => {
        await initDB();
        const row = await getOne('SELECT 1 FROM knowledge_metadata WHERE agent_id = $1 LIMIT 1', [agentId]);
        return !!row;
    },

    /**
     * List all knowledge for an agent
     */
    listKnowledge: async (agentId) => {
        await initDB();
        const rows = await getAll('SELECT * FROM knowledge_metadata WHERE agent_id = $1 ORDER BY created_at DESC', [agentId]);
        return rows.map(row => ({
            ...row,
            metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
        }));
    },

    /**
     * Hybrid search: Vector (semantic) + Keyword (lexical) with Reciprocal Rank Fusion
     */
    searchKnowledge: async (agentId, queryEmbedding, limit = 5, queryText = "") => {
        if (!queryEmbedding || queryEmbedding.length === 0) return [];
        await initDB();

        const dim = queryEmbedding.length;
        await ensureVectorColumn(dim);

        const colName = `embedding_${dim}`;
        const vectorStr = `[${queryEmbedding.join(',')}]`;

        // A. Vector Search (Semantic) — get 3x candidates for re-ranking
        let vectorCandidates = [];
        try {
            vectorCandidates = await getAll(
                `SELECT id, "${colName}" <=> $1::vector as distance
                 FROM knowledge_metadata
                 WHERE agent_id = $2 AND "${colName}" IS NOT NULL
                 ORDER BY "${colName}" <=> $1::vector
                 LIMIT $3`,
                [vectorStr, agentId, limit * 3]
            );
        } catch (e) {
            console.error('[KnowledgeStore] Vector search failed:', e.message);
        }

        // B. Keyword Search (Lexical) using tsvector
        let keywordCandidates = [];
        if (queryText && queryText.trim().length > 0) {
            try {
                const sanitizedQuery = queryText
                    .replace(/[\"'*^$(){}[\]\\]/g, '')
                    .split(/\s+/)
                    .filter(w => w.length > 1)
                    .filter(w => !/^(AND|OR|NOT|NEAR)$/i.test(w))
                    .join(' & ');

                if (sanitizedQuery.length > 0) {
                    keywordCandidates = await getAll(
                        `SELECT id, ts_rank(search_vector, to_tsquery('english', $1)) as rank
                         FROM knowledge_metadata
                         WHERE agent_id = $2 AND search_vector @@ to_tsquery('english', $1)
                         ORDER BY rank DESC
                         LIMIT 20`,
                        [sanitizedQuery, agentId]
                    );
                }
            } catch (e) {
                console.warn("[KnowledgeStore] Keyword search failed:", e.message);
            }
        }

        // C. Fusion / Scoring
        let fusedResults;
        if (keywordCandidates.length === 0) {
            fusedResults = vectorCandidates.map(c => ({ id: c.id, score: 1 / (1 + c.distance) }));
        } else {
            fusedResults = reciprocalRankFusion(vectorCandidates, keywordCandidates);
        }

        // D. Relevance threshold
        const MIN_SCORE_THRESHOLD = 0.01;
        fusedResults = fusedResults.filter(r => r.score > MIN_SCORE_THRESHOLD);

        // E. Limit to top K
        const topIds = fusedResults.slice(0, limit).map(r => r.id);
        if (topIds.length === 0) return [];

        // F. Fetch metadata
        const placeholders = topIds.map((_, i) => `$${i + 1}`).join(',');
        const items = await getAll(
            `SELECT * FROM knowledge_metadata WHERE id IN (${placeholders}) AND agent_id = $${topIds.length + 1}`,
            [...topIds, agentId]
        );

        // G. Deduplicate by source — max 3 results from the same source
        const sourceCount = {};
        const MAX_PER_SOURCE = 3;

        return items
            .map(item => {
                const match = fusedResults.find(r => r.id === item.id);
                const parsedMeta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
                return { ...item, metadata: parsedMeta, score: match ? match.score : 0 };
            })
            .sort((a, b) => b.score - a.score)
            .filter(item => {
                const source = item.metadata?.source || 'unknown';
                sourceCount[source] = (sourceCount[source] || 0) + 1;
                return sourceCount[source] <= MAX_PER_SOURCE;
            });
    }
};

module.exports = KnowledgeStore;
