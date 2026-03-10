/**
 * Knowledge Bases Store — Multi-KB management
 * 
 * Tables: knowledge_bases, documents
 * Chunks are managed by the search-service (kb_chunks table).
 */

const { run, getOne, getAll, exec, getClient } = require('../db');
const crypto = require('crypto');

let initialized = false;

async function initDB() {
    if (initialized) return;

    await exec(`
        CREATE TABLE IF NOT EXISTS knowledge_bases (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            default_lang TEXT DEFAULT 'unknown',
            kb_version INT DEFAULT 1,
            embedding_model TEXT DEFAULT 'bge-m3',
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ DEFAULT now()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_kb_tenant ON knowledge_bases(tenant_id)`);

    await exec(`
        CREATE TABLE IF NOT EXISTS documents (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id TEXT NOT NULL,
            knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
            title TEXT,
            source_type TEXT DEFAULT 'text',
            source_uri TEXT,
            lang TEXT DEFAULT 'unknown',
            content_hash TEXT,
            chunk_count INT DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT now()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_documents_kb ON documents(knowledge_base_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_documents_tenant ON documents(tenant_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(knowledge_base_id, content_hash)`);

    initialized = true;
    console.log('[KnowledgeBases] Tables initialized');
}

// Auto-init
initDB().catch(err => console.error('[KnowledgeBases] Init error:', err.message));

const KnowledgeBasesStore = {
    // ── KB CRUD ─────────────────────────────────────────────────────────

    createKB: async (tenantId, name, description = '', defaultLang = 'unknown') => {
        await initDB();
        const row = await getOne(
            `INSERT INTO knowledge_bases (tenant_id, name, description, default_lang)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [tenantId, name, description, defaultLang]
        );
        return row;
    },

    listKBs: async (tenantId) => {
        await initDB();
        return getAll(
            `SELECT kb.*, 
                    COALESCE(d.doc_count, 0) AS document_count,
                    COALESCE(d.total_chunks, 0) AS total_chunks
             FROM knowledge_bases kb
             LEFT JOIN (
                 SELECT knowledge_base_id, 
                        COUNT(*) AS doc_count,
                        SUM(chunk_count) AS total_chunks
                 FROM documents 
                 GROUP BY knowledge_base_id
             ) d ON d.knowledge_base_id = kb.id
             WHERE kb.tenant_id = $1
             ORDER BY kb.created_at DESC`,
            [tenantId]
        );
    },

    getKB: async (id) => {
        await initDB();
        return getOne('SELECT * FROM knowledge_bases WHERE id = $1', [id]);
    },

    updateKB: async (id, { name, description, defaultLang }) => {
        await initDB();
        return getOne(
            `UPDATE knowledge_bases 
             SET name = COALESCE($2, name),
                 description = COALESCE($3, description),
                 default_lang = COALESCE($4, default_lang),
                 updated_at = now()
             WHERE id = $1
             RETURNING *`,
            [id, name, description, defaultLang]
        );
    },

    deleteKB: async (id) => {
        await initDB();
        // Documents cascade-delete; chunks must be deleted via search-service
        await run('DELETE FROM knowledge_bases WHERE id = $1', [id]);
        return true;
    },

    bumpKBVersion: async (id) => {
        await initDB();
        return getOne(
            `UPDATE knowledge_bases SET kb_version = kb_version + 1, updated_at = now()
             WHERE id = $1 RETURNING kb_version`,
            [id]
        );
    },

    // ── Document CRUD ───────────────────────────────────────────────────

    createDocument: async (tenantId, kbId, title, sourceType, sourceUri, contentHash, chunkCount = 0) => {
        await initDB();
        const row = await getOne(
            `INSERT INTO documents (tenant_id, knowledge_base_id, title, source_type, source_uri, content_hash, chunk_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [tenantId, kbId, title, sourceType, sourceUri, contentHash, chunkCount]
        );
        return row;
    },

    listDocuments: async (kbId) => {
        await initDB();
        return getAll(
            `SELECT * FROM documents WHERE knowledge_base_id = $1 ORDER BY created_at DESC`,
            [kbId]
        );
    },

    getDocument: async (id) => {
        await initDB();
        return getOne('SELECT * FROM documents WHERE id = $1', [id]);
    },

    deleteDocument: async (id) => {
        await initDB();
        await run('DELETE FROM documents WHERE id = $1', [id]);
        return true;
    },

    /**
     * Check if content with same hash already exists in this KB (for deduplication).
     */
    hasContentHash: async (kbId, contentHash) => {
        await initDB();
        const row = await getOne(
            `SELECT id FROM documents WHERE knowledge_base_id = $1 AND content_hash = $2`,
            [kbId, contentHash]
        );
        return row ? row.id : null;
    },

    /**
     * Update chunk count for a document after ingestion.
     */
    updateChunkCount: async (docId, chunkCount) => {
        await initDB();
        return run('UPDATE documents SET chunk_count = $2 WHERE id = $1', [docId, chunkCount]);
    },

    /**
     * Compute content hash for deduplication.
     */
    hashContent: (content) => {
        return crypto.createHash('sha256').update(content).digest('hex');
    }
};

module.exports = KnowledgeBasesStore;
