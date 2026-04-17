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

    // ── Column migrations ──
    try { await exec(`ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS organization_id TEXT`); } catch (e) { /* column already exists */ }
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_kb_org ON knowledge_bases(organization_id) WHERE organization_id IS NOT NULL`); } catch (e) { /* index already exists */ }
    // Rich metadata on documents (sender, threadId, attachments, simhash, …)
    try { await exec(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`); } catch (e) { /* column already exists */ }
    // Duplicate tracking for content-hash / simhash dedup
    try { await exec(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS duplicate_of UUID`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS simhash BIGINT`); } catch (e) { /* column already exists */ }
    // GIN index for metadata lookups (sender/threadId filters)
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_documents_metadata ON documents USING GIN (metadata jsonb_path_ops)`); } catch (e) { /* index already exists */ }

    initialized = true;
    console.log('[KnowledgeBases] Tables initialized');
}

// Auto-init
initDB().catch(err => console.error('[KnowledgeBases] Init error:', err.message));

const KnowledgeBasesStore = {
    // ── KB CRUD ─────────────────────────────────────────────────────────

    /**
     * Create a new KB.
     * @param {string} tenantId - Owner user ID
     * @param {string} name
     * @param {string} description
     * @param {string} defaultLang
     * @param {string|null} organizationId - Organization this KB belongs to (null = personal)
     */
    createKB: async (tenantId, name, description = '', defaultLang = 'unknown', organizationId = null) => {
        await initDB();
        const row = await getOne(
            `INSERT INTO knowledge_bases (tenant_id, name, description, default_lang, organization_id)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [tenantId, name, description, defaultLang, organizationId || null]
        );
        return row;
    },

    /**
     * List KBs accessible to the user.
     * @param {string} tenantId - The user's ID
     * @param {Set|null} orgIds - User's org IDs from resolveUserOrgIds().
     *   null = super admin (see all), Set with values = org member, empty Set = no org
     */
    listKBs: async (tenantId, orgIds = undefined) => {
        await initDB();

        // Legacy fallback: if orgIds not provided, show only user's own KBs
        if (orgIds === undefined) {
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
        }

        // Super admin — see all KBs
        if (orgIds === null) {
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
                 ORDER BY kb.created_at DESC`
            );
        }

        const orgIdArray = Array.from(orgIds);

        if (orgIdArray.length === 0) {
            // No org membership — only personal KBs
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
        }

        // Org member — personal KBs + KBs from user's org(s)
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
             WHERE kb.tenant_id = $1 OR kb.organization_id = ANY($2)
             ORDER BY kb.created_at DESC`,
            [tenantId, orgIdArray]
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

    createDocument: async (tenantId, kbId, title, sourceType, sourceUri, contentHash, chunkCount = 0, metadata = null, simhash = null) => {
        await initDB();
        const row = await getOne(
            `INSERT INTO documents (tenant_id, knowledge_base_id, title, source_type, source_uri, content_hash, chunk_count, metadata, simhash)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
             RETURNING *`,
            [tenantId, kbId, title, sourceType, sourceUri, contentHash, chunkCount, metadata ? JSON.stringify(metadata) : '{}', simhash]
        );
        return row;
    },

    /**
     * Record a duplicate relationship: `dupId` is an alias for `canonicalId`.
     * No new chunks are embedded — the row just points to the canonical doc.
     */
    recordDuplicate: async (tenantId, kbId, title, sourceType, sourceUri, contentHash, canonicalId, metadata = null) => {
        await initDB();
        return getOne(
            `INSERT INTO documents (tenant_id, knowledge_base_id, title, source_type, source_uri, content_hash, chunk_count, duplicate_of, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8::jsonb)
             RETURNING *`,
            [tenantId, kbId, title, sourceType, sourceUri, contentHash, canonicalId, metadata ? JSON.stringify(metadata) : '{}']
        );
    },

    /**
     * Find a near-duplicate by simhash within a given Hamming distance.
     * Returns the first match or null. `distance` defaults to 3.
     */
    findNearDuplicateBySimhash: async (kbId, simhash, distance = 3) => {
        await initDB();
        if (simhash == null) return null;
        // Count set bits in the XOR to compute Hamming distance.
        return getOne(
            `SELECT id, title, simhash FROM documents
             WHERE knowledge_base_id = $1
               AND simhash IS NOT NULL
               AND length(replace((($2::bigint # simhash)::bit(64))::text, '0', '')) <= $3
             ORDER BY created_at DESC
             LIMIT 1`,
            [kbId, simhash, distance]
        );
    },

    listDocuments: async (kbId, opts = {}) => {
        await initDB();
        const { limit = 200, offset = 0, filters = {} } = opts;
        const clauses = [`knowledge_base_id = $1`];
        const vals = [kbId];
        let idx = 2;
        if (filters.sender) {
            clauses.push(`metadata->>'from' ILIKE $${idx}`);
            vals.push(`%${filters.sender}%`); idx++;
        }
        if (filters.threadId) {
            clauses.push(`metadata->>'threadId' = $${idx}`);
            vals.push(filters.threadId); idx++;
        }
        if (filters.hasAttachment) {
            clauses.push(`(metadata->>'hasAttachments')::boolean = true`);
        }
        if (filters.dateFrom) {
            clauses.push(`(metadata->>'date')::timestamptz >= $${idx}`);
            vals.push(filters.dateFrom); idx++;
        }
        if (filters.dateTo) {
            clauses.push(`(metadata->>'date')::timestamptz <= $${idx}`);
            vals.push(filters.dateTo); idx++;
        }
        if (filters.sourceType) {
            clauses.push(`source_type = $${idx}`);
            vals.push(filters.sourceType); idx++;
        }
        vals.push(limit); const limitIdx = idx; idx++;
        vals.push(offset); const offsetIdx = idx;
        return getAll(
            `SELECT * FROM documents
             WHERE ${clauses.join(' AND ')}
             ORDER BY created_at DESC
             LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
            vals
        );
    },

    countDocuments: async (kbId, filters = {}) => {
        await initDB();
        const clauses = [`knowledge_base_id = $1`];
        const vals = [kbId];
        let idx = 2;
        if (filters.sender) { clauses.push(`metadata->>'from' ILIKE $${idx}`); vals.push(`%${filters.sender}%`); idx++; }
        if (filters.threadId) { clauses.push(`metadata->>'threadId' = $${idx}`); vals.push(filters.threadId); idx++; }
        if (filters.hasAttachment) clauses.push(`(metadata->>'hasAttachments')::boolean = true`);
        if (filters.dateFrom) { clauses.push(`(metadata->>'date')::timestamptz >= $${idx}`); vals.push(filters.dateFrom); idx++; }
        if (filters.dateTo) { clauses.push(`(metadata->>'date')::timestamptz <= $${idx}`); vals.push(filters.dateTo); idx++; }
        if (filters.sourceType) { clauses.push(`source_type = $${idx}`); vals.push(filters.sourceType); idx++; }
        const row = await getOne(`SELECT COUNT(*)::int AS n FROM documents WHERE ${clauses.join(' AND ')}`, vals);
        return row?.n || 0;
    },

    /**
     * Return distinct threadIds + sibling counts for a KB — for the thread explorer UI.
     */
    listThreads: async (kbId, opts = {}) => {
        await initDB();
        const { limit = 100 } = opts;
        return getAll(
            `SELECT metadata->>'threadId' AS thread_id,
                    COUNT(*)::int AS message_count,
                    MAX(created_at) AS latest
             FROM documents
             WHERE knowledge_base_id = $1
               AND metadata ? 'threadId'
               AND metadata->>'threadId' IS NOT NULL
             GROUP BY thread_id
             ORDER BY latest DESC
             LIMIT $2`,
            [kbId, limit]
        );
    },

    listDocumentsByThread: async (kbId, threadId) => {
        await initDB();
        return getAll(
            `SELECT * FROM documents
             WHERE knowledge_base_id = $1 AND metadata->>'threadId' = $2
             ORDER BY (metadata->>'date')::timestamptz NULLS LAST, created_at`,
            [kbId, threadId]
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
