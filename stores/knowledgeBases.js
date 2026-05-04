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
            kb_version INT DEFAULT 1,
            embedding_model TEXT DEFAULT 'bge-m3',
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ DEFAULT now()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_kb_tenant ON knowledge_bases(tenant_id)`);
    // Drop the deprecated per-KB default_lang column on existing deployments
    // (no-op once applied). Idempotent.
    try { await require('../migrations/drop-kb-default-lang').up(); } catch (e) { /* tolerate */ }
    // Add usage_contexts + source_kind columns and backfill auto-created KBs.
    try { await require('../migrations/add-kb-usage-contexts').up(); } catch (e) { /* tolerate */ }
    // Add Dutch translations for the usage-context UI strings (idempotent).
    try { await require('../migrations/add-nl-kb-usage-translations').up(); } catch (e) { /* tolerate */ }

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
    // Publish lifecycle (mirrors agents.is_published / agents.shared_groups)
    let publishedColumnIsNew = false;
    try {
        // pg_attribute lookup so we know whether to backfill below
        const existing = await getOne(`SELECT 1 AS ok FROM information_schema.columns WHERE table_name = 'knowledge_bases' AND column_name = 'is_published'`);
        publishedColumnIsNew = !existing;
    } catch (_) { /* tolerate */ }
    try { await exec(`ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS is_published BOOLEAN DEFAULT FALSE`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS shared_groups TEXT DEFAULT '[]'`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS category_id TEXT`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS icon TEXT`); } catch (e) { /* column already exists */ }
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_kb_org_published ON knowledge_bases(organization_id, is_published) WHERE is_published = TRUE`); } catch (e) { /* index already exists */ }
    // First-deploy backfill: org KBs that already existed before the publish flow
    // were visible to the whole org; preserve that by marking them published.
    // Personal KBs (organization_id IS NULL) stay as drafts.
    if (publishedColumnIsNew) {
        try {
            await exec(`UPDATE knowledge_bases SET is_published = TRUE WHERE organization_id IS NOT NULL AND is_published = FALSE`);
            console.log('[KnowledgeBases] Backfilled is_published=TRUE for existing org KBs');
        } catch (e) { console.warn('[KnowledgeBases] Backfill failed:', e.message); }
    }
    // Org-level KB categories (mirrors agent_categories)
    await exec(`
        CREATE TABLE IF NOT EXISTS kb_categories (
            id TEXT PRIMARY KEY,
            organization_id TEXT,
            name TEXT NOT NULL,
            icon TEXT DEFAULT '📚',
            color TEXT DEFAULT '#6366f1',
            created_at TIMESTAMPTZ DEFAULT now()
        )
    `);
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_kb_categories_org ON kb_categories(organization_id)`); } catch (e) { /* index already exists */ }
    // Rich metadata on documents (sender, threadId, attachments, simhash, …)
    try { await exec(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`); } catch (e) { /* column already exists */ }
    // Duplicate tracking for content-hash / simhash dedup
    try { await exec(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS duplicate_of UUID`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS simhash BIGINT`); } catch (e) { /* column already exists */ }
    // GIN index for metadata lookups (sender/threadId filters)
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_documents_metadata ON documents USING GIN (metadata jsonb_path_ops)`); } catch (e) { /* index already exists */ }

    // Per-user KB favorites (replaces client-side localStorage `kb_favorites`)
    await exec(`
        CREATE TABLE IF NOT EXISTS kb_favorites (
            user_id TEXT NOT NULL,
            kb_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (user_id, kb_id)
        )
    `);
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_kb_favorites_user ON kb_favorites(user_id)`); } catch (e) { /* index already exists */ }

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
     * @param {string|null} organizationId - Organization this KB belongs to (null = personal)
     * @param {object} extra - Optional { categoryId, icon, sourceKind, usageContexts }
     *   - sourceKind: 'manual' | 'webpage_auto' | 'notebook_auto' (default 'manual')
     *   - usageContexts: array of 'agent' | 'direct_chat' | 'webpage' (default all three)
     */
    createKB: async (tenantId, name, description = '', organizationId = null, extra = {}) => {
        await initDB();
        const sourceKind = extra.sourceKind || 'manual';
        // Default for manual KBs: studio-managed contexts only. Webpage-owned KBs
        // pass usageContexts=['webpage'] explicitly via their auto-create paths.
        const usageContexts = Array.isArray(extra.usageContexts)
            ? extra.usageContexts
            : ['agent', 'direct_chat'];
        const row = await getOne(
            `INSERT INTO knowledge_bases (tenant_id, name, description, organization_id, category_id, icon, source_kind, usage_contexts)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
             RETURNING *`,
            [tenantId, name, description, organizationId || null, extra.categoryId || null, extra.icon || null, sourceKind, JSON.stringify(usageContexts)]
        );
        return row;
    },

    /**
     * List KBs accessible to the user.
     * @param {string} tenantId - The user's ID
     * @param {Set|null} orgIds - User's org IDs from resolveUserOrgIds().
     *   null = super admin (see all), Set with values = org member, empty Set = no org
     * @param {object} [opts]
     * @param {string|null} [opts.sourceKind='manual'] - Filter by source kind. Pass null to disable.
     * @param {string|null} [opts.usageContext=null] - When set, only KBs whose `usage_contexts`
     *   array contains this value are returned ('agent' | 'direct_chat' | 'webpage').
     * @param {string|null} [opts.excludeContext=null] - Inverse of `usageContext`. KBs whose
     *   `usage_contexts` array contains this value are excluded.
     */
    listKBs: async (tenantId, orgIds = undefined, opts = {}) => {
        await initDB();

        const sourceKind = opts.sourceKind === undefined ? 'manual' : opts.sourceKind;
        const usageContext = opts.usageContext || null;
        const excludeContext = opts.excludeContext || null;

        // Build optional filter clauses + their bound params. Each branch below
        // appends these so the marketplace, agent and direct-chat pickers all
        // narrow the same way.
        const buildFilters = (startIdx) => {
            const conds = [];
            const params = [];
            let idx = startIdx;
            if (sourceKind) {
                conds.push(`kb.source_kind = $${idx++}`);
                params.push(sourceKind);
            }
            if (usageContext) {
                conds.push(`kb.usage_contexts ? $${idx++}`);
                params.push(usageContext);
            }
            if (excludeContext) {
                conds.push(`NOT (kb.usage_contexts ? $${idx++})`);
                params.push(excludeContext);
            }
            return { sql: conds.length > 0 ? ' AND ' + conds.join(' AND ') : '', params };
        };

        const baseSelect = `
            SELECT kb.*,
                   COALESCE(d.doc_count, 0) AS document_count,
                   COALESCE(d.total_chunks, 0) AS total_chunks
            FROM knowledge_bases kb
            LEFT JOIN (
                SELECT knowledge_base_id,
                       COUNT(*) AS doc_count,
                       SUM(chunk_count) AS total_chunks
                FROM documents
                GROUP BY knowledge_base_id
            ) d ON d.knowledge_base_id = kb.id`;

        // Legacy fallback: if orgIds not provided, show only user's own KBs
        if (orgIds === undefined) {
            const f = buildFilters(2);
            return getAll(
                `${baseSelect} WHERE kb.tenant_id = $1${f.sql} ORDER BY kb.created_at DESC`,
                [tenantId, ...f.params]
            );
        }

        // Super admin — see all KBs
        if (orgIds === null) {
            const f = buildFilters(1);
            const where = f.sql ? ' WHERE ' + f.sql.replace(/^ AND /, '') : '';
            return getAll(`${baseSelect}${where} ORDER BY kb.created_at DESC`, f.params);
        }

        const orgIdArray = Array.from(orgIds);

        if (orgIdArray.length === 0) {
            // No org membership — only personal KBs
            const f = buildFilters(2);
            return getAll(
                `${baseSelect} WHERE kb.tenant_id = $1${f.sql} ORDER BY kb.created_at DESC`,
                [tenantId, ...f.params]
            );
        }

        // Org member — personal KBs (any state) + PUBLISHED KBs from user's org(s)
        // Group restriction (shared_groups) is applied in JS by callers via filterByGroupAccess.
        const f = buildFilters(3);
        return getAll(
            `${baseSelect}
             WHERE (kb.tenant_id = $1 OR (kb.organization_id = ANY($2) AND kb.is_published = TRUE))${f.sql}
             ORDER BY kb.created_at DESC`,
            [tenantId, orgIdArray, ...f.params]
        );
    },

    /**
     * Filter a KB list down to those the user is allowed to see based on
     * `shared_groups` group restrictions. Owner KBs (tenant_id = userId)
     * always pass. Drafts (is_published = false) always pass for the owner.
     *
     * @param {Array} kbs - Result of listKBs
     * @param {string} userId - The user's ID
     * @param {Array<string>} userGroups - Group IDs the user belongs to
     */
    filterByGroupAccess: (kbs, userId, userGroups = []) => {
        if (!Array.isArray(kbs)) return [];
        return kbs.filter(kb => KnowledgeBasesStore.canUserAccessKB(kb, userId, undefined, userGroups));
    },

    /**
     * Single source of truth for "is this user allowed to read this KB?".
     * Used both by the list filter and by per-id route guards so the two
     * paths can never drift.
     *
     * @param {object} kb - Row from knowledge_bases
     * @param {string} userId - The requesting user's id
     * @param {Set|null|undefined} orgIds - User's org ids; null = super admin.
     *   When undefined, org membership is not considered (list-path callers
     *   already constrained the query by org, so only group rules need to run).
     * @param {Array<string>} userGroups - Group ids the user belongs to
     */
    canUserAccessKB: (kb, userId, orgIds = undefined, userGroups = []) => {
        if (!kb) return false;
        // Owner always has access
        if (kb.tenant_id === userId) return true;
        // Super admin
        if (orgIds === null) return true;
        // Direct-fetch path: must be in the KB's org
        if (orgIds instanceof Set) {
            if (!kb.organization_id || !orgIds.has(kb.organization_id)) return false;
        }
        // Drafts hidden from non-owners
        if (!kb.is_published) return false;
        // shared_groups restriction
        let groups = [];
        try { groups = JSON.parse(kb.shared_groups || '[]'); } catch { groups = []; }
        if (!Array.isArray(groups) || groups.length === 0) return true;
        return groups.some(g => userGroups.includes(g));
    },

    getKB: async (id) => {
        await initDB();
        return getOne('SELECT * FROM knowledge_bases WHERE id = $1', [id]);
    },

    updateKB: async (id, { name, description, categoryId, icon, usageContexts }) => {
        await initDB();
        const usageJson = Array.isArray(usageContexts) ? JSON.stringify(usageContexts) : null;
        return getOne(
            `UPDATE knowledge_bases
             SET name = COALESCE($2, name),
                 description = COALESCE($3, description),
                 category_id = COALESCE($4, category_id),
                 icon = COALESCE($5, icon),
                 usage_contexts = COALESCE($6::jsonb, usage_contexts),
                 updated_at = now()
             WHERE id = $1
             RETURNING *`,
            [id, name, description, categoryId, icon, usageJson]
        );
    },

    /**
     * Toggle publish state and (optionally) shared groups. Owner-only operation
     * enforced at the route layer.
     *
     * When `sharedGroups` is undefined, the existing DB value is preserved —
     * a toggle-publish call without an explicit groups payload must NOT
     * silently flip a group-restricted KB to entire-org visibility. Mirrors
     * the same fix in agentCrud.setAgentPublished.
     */
    setPublished: async (id, isPublished, sharedGroups) => {
        await initDB();
        if (sharedGroups === undefined) {
            return getOne(
                `UPDATE knowledge_bases
                 SET is_published = $2,
                     updated_at = now()
                 WHERE id = $1
                 RETURNING *`,
                [id, !!isPublished]
            );
        }
        const groupsJson = JSON.stringify(Array.isArray(sharedGroups) ? sharedGroups : []);
        return getOne(
            `UPDATE knowledge_bases
             SET is_published = $2,
                 shared_groups = $3,
                 updated_at = now()
             WHERE id = $1
             RETURNING *`,
            [id, !!isPublished, groupsJson]
        );
    },

    // ── KB Categories (org-level, mirrors agent_categories) ─────────────

    listKBCategories: async (organizationId) => {
        await initDB();
        if (!organizationId) {
            return getAll(`SELECT * FROM kb_categories WHERE organization_id IS NULL ORDER BY name`);
        }
        return getAll(
            `SELECT * FROM kb_categories WHERE organization_id = $1 ORDER BY name`,
            [organizationId]
        );
    },

    createKBCategory: async ({ id, organizationId, name, icon, color }) => {
        await initDB();
        return getOne(
            `INSERT INTO kb_categories (id, organization_id, name, icon, color)
             VALUES ($1, $2, $3, COALESCE($4, '📚'), COALESCE($5, '#6366f1'))
             RETURNING *`,
            [id, organizationId || null, name, icon, color]
        );
    },

    deleteKBCategory: async (id) => {
        await initDB();
        // Detach any KBs from this category, then remove it
        await run(`UPDATE knowledge_bases SET category_id = NULL WHERE category_id = $1`, [id]);
        await run(`DELETE FROM kb_categories WHERE id = $1`, [id]);
        return true;
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
     * Change a document's source_uri — used by transactional category_merge
     * swap: ingest new under a temp uri, then rename to the canonical uri
     * once the embeddings land.
     */
    updateDocumentSourceUri: async (id, newSourceUri) => {
        await initDB();
        return run(
            `UPDATE documents SET source_uri = $2 WHERE id = $1`,
            [id, newSourceUri]
        );
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
    },

    // ── KB Favorites ────────────────────────────────────────────────────
    listFavorites: async (userId) => {
        await initDB();
        const rows = await getAll(
            `SELECT kb_id FROM kb_favorites WHERE user_id = $1 ORDER BY created_at ASC`,
            [userId]
        );
        return rows.map(r => r.kb_id);
    },
    addFavorite: async (userId, kbId) => {
        await initDB();
        await run(
            `INSERT INTO kb_favorites (user_id, kb_id) VALUES ($1, $2)
             ON CONFLICT (user_id, kb_id) DO NOTHING`,
            [userId, kbId]
        );
    },
    removeFavorite: async (userId, kbId) => {
        await initDB();
        await run(
            `DELETE FROM kb_favorites WHERE user_id = $1 AND kb_id = $2`,
            [userId, kbId]
        );
    },
};

module.exports = KnowledgeBasesStore;
