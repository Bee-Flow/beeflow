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
    // System-managed KBs (Bee Flow-provided content like Dutch legal sources).
    // `system_slug` ties the KB row to a beta-feature id; the listKBs filter
    // surfaces it to orgs whose beta toggle matches. NULL on user-created KBs.
    try { await exec(`ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS system_slug TEXT`); } catch (e) { /* column already exists */ }
    try { await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_system_slug ON knowledge_bases(system_slug) WHERE system_slug IS NOT NULL`); } catch (e) { /* index already exists */ }
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
    // ── KB versioning ──
    // Two-tier history: kb_versions captures full metadata snapshots of the
    // KB row on every meaningful edit (publish, rename, shared-group change);
    // kb_document_versions captures document content right before a delete so
    // an accidental drop can be recovered. Neither table is on the hot read
    // path — they're written from mutation handlers and read only from
    // admin/restore UIs.
    await exec(`
        CREATE TABLE IF NOT EXISTS kb_versions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            kb_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
            version_number INT NOT NULL,
            snapshot JSONB NOT NULL,
            changed_by TEXT,
            change_reason TEXT,
            created_at TIMESTAMPTZ DEFAULT now()
        )
    `);
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_kb_versions_kb ON kb_versions(kb_id, version_number DESC)`); } catch (_) { /* exists */ }
    try { await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_versions_unique ON kb_versions(kb_id, version_number)`); } catch (_) { /* exists */ }

    await exec(`
        CREATE TABLE IF NOT EXISTS kb_document_versions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            document_id UUID NOT NULL,
            knowledge_base_id UUID NOT NULL,
            tenant_id TEXT NOT NULL,
            title TEXT,
            source_type TEXT,
            source_uri TEXT,
            content_hash TEXT,
            payload JSONB,
            deleted_by TEXT,
            deleted_at TIMESTAMPTZ DEFAULT now()
        )
    `);
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_kb_doc_versions_kb ON kb_document_versions(knowledge_base_id, deleted_at DESC)`); } catch (_) { /* exists */ }
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_kb_doc_versions_doc ON kb_document_versions(document_id)`); } catch (_) { /* exists */ }

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
        const isPublished = extra.isPublished === true || sourceKind === 'system_managed';
        const row = await getOne(
            `INSERT INTO knowledge_bases (tenant_id, name, description, organization_id, category_id, icon, source_kind, usage_contexts, system_slug, is_published)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
             RETURNING *`,
            [tenantId, name, description, organizationId || null, extra.categoryId || null, extra.icon || null, sourceKind, JSON.stringify(usageContexts), extra.systemSlug || null, isPublished]
        );
        return row;
    },

    /**
     * Look up a system-managed KB by its `system_slug` (e.g. 'dutch_legal_sources').
     * Returns the row or null. Used by the ingest script for idempotent upserts
     * and by the chat layer to resolve enabled-beta-feature → KB id.
     */
    getSystemKBBySlug: async (slug) => {
        await initDB();
        if (!slug) return null;
        return getOne(
            `SELECT * FROM knowledge_bases
             WHERE source_kind = 'system_managed' AND system_slug = $1
             LIMIT 1`,
            [slug]
        );
    },

    /**
     * List every seeded system-managed KB. Cheap — at most a handful of rows.
     * Used by the admin status panel and by the chat KB resolver.
     */
    listSystemKBs: async () => {
        await initDB();
        return getAll(
            `SELECT kb.*,
                    COALESCE(d.doc_count, 0) AS document_count,
                    COALESCE(d.total_chunks, 0) AS total_chunks
             FROM knowledge_bases kb
             LEFT JOIN (
                 SELECT knowledge_base_id, COUNT(*) AS doc_count, SUM(chunk_count) AS total_chunks
                 FROM documents GROUP BY knowledge_base_id
             ) d ON d.knowledge_base_id = kb.id
             WHERE kb.source_kind = 'system_managed'
             ORDER BY kb.name`
        );
    },

    /** Lightweight predicate for guarding write paths in routes. */
    isSystemKB: (kb) => !!(kb && kb.source_kind === 'system_managed'),

    /**
     * List KBs accessible to the user.
     * @param {string} tenantId - The user's ID
     * @param {Set|null} orgIds - User's org IDs from resolveUserOrgIds().
     *   null = super admin (see all), Set with values = org member, empty Set = no org
     * @param {object} [opts]
     * @param {string|string[]|null} [opts.sourceKind='manual'] - Filter by source kind.
     *   Pass a string for one kind, an array for several, or null to include all kinds.
     * @param {string|null} [opts.usageContext=null] - When set, only KBs whose `usage_contexts`
     *   array contains this value are returned ('agent' | 'direct_chat' | 'webpage').
     * @param {string|null} [opts.excludeContext=null] - Inverse of `usageContext`. KBs whose
     *   `usage_contexts` array contains this value are excluded.
     * @param {string[]} [opts.systemSlugs=null] - When provided, system-managed KBs whose
     *   `system_slug` is in this list are included in addition to the normal personal/org
     *   results. Used by the chat layer to surface system KBs whose beta feature is enabled
     *   for the requesting user's org.
     */
    listKBs: async (tenantId, orgIds = undefined, opts = {}) => {
        await initDB();

        const sourceKindOpt = opts.sourceKind === undefined ? 'manual' : opts.sourceKind;
        const sourceKindList = sourceKindOpt === null
            ? null
            : (Array.isArray(sourceKindOpt) ? sourceKindOpt : [sourceKindOpt]);
        const usageContext = opts.usageContext || null;
        const excludeContext = opts.excludeContext || null;
        const systemSlugs = Array.isArray(opts.systemSlugs) ? opts.systemSlugs : null;

        // Build optional filter clauses + their bound params. Each branch below
        // appends these so the marketplace, agent and direct-chat pickers all
        // narrow the same way.
        const buildFilters = (startIdx) => {
            const conds = [];
            const params = [];
            let idx = startIdx;
            if (sourceKindList && sourceKindList.length > 0) {
                conds.push(`kb.source_kind = ANY($${idx++})`);
                params.push(sourceKindList);
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

        // System-managed KBs ride alongside personal + org-published results.
        // They are filtered by an explicit allow-list of system_slugs from the
        // caller (resolved from the org's enabled beta features). We OR them
        // into the visibility predicate AFTER the sourceKind/usageContext
        // filters so the same slug list always applies regardless of the kind
        // filter.
        const buildSystemUnion = (startIdx) => {
            if (!systemSlugs || systemSlugs.length === 0) return { sql: '', params: [] };
            const conds = [`kb.source_kind = 'system_managed'`, `kb.system_slug = ANY($${startIdx})`];
            const params = [systemSlugs];
            let idx = startIdx + 1;
            if (usageContext) {
                conds.push(`kb.usage_contexts ? $${idx++}`);
                params.push(usageContext);
            }
            if (excludeContext) {
                conds.push(`NOT (kb.usage_contexts ? $${idx++})`);
                params.push(excludeContext);
            }
            return { sql: ` UNION SELECT kb.*,
                       COALESCE(d.doc_count, 0) AS document_count,
                       COALESCE(d.total_chunks, 0) AS total_chunks
                FROM knowledge_bases kb
                LEFT JOIN (
                    SELECT knowledge_base_id, COUNT(*) AS doc_count, SUM(chunk_count) AS total_chunks
                    FROM documents GROUP BY knowledge_base_id
                ) d ON d.knowledge_base_id = kb.id
                WHERE ${conds.join(' AND ')}`, params };
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
            const u = buildSystemUnion(2 + f.params.length);
            return getAll(
                `${baseSelect} WHERE kb.tenant_id = $1${f.sql}${u.sql}
                 ORDER BY created_at DESC`,
                [tenantId, ...f.params, ...u.params]
            );
        }

        // Super admin — see all KBs. When the caller has narrowed by
        // sourceKind (e.g. 'manual' for the picker), system KBs whose slug is
        // on the systemSlugs allow-list are unioned back in so super admins
        // get the same chat UX as regular users.
        if (orgIds === null) {
            const f = buildFilters(1);
            const where = f.sql ? ' WHERE ' + f.sql.replace(/^ AND /, '') : '';
            const u = buildSystemUnion(1 + f.params.length);
            return getAll(
                `${baseSelect}${where}${u.sql} ORDER BY created_at DESC`,
                [...f.params, ...u.params]
            );
        }

        const orgIdArray = Array.from(orgIds);

        if (orgIdArray.length === 0) {
            // No org membership — only personal KBs (+ enabled system KBs, if any)
            const f = buildFilters(2);
            const u = buildSystemUnion(2 + f.params.length);
            return getAll(
                `${baseSelect} WHERE kb.tenant_id = $1${f.sql}${u.sql}
                 ORDER BY created_at DESC`,
                [tenantId, ...f.params, ...u.params]
            );
        }

        // Org member — personal KBs (any state) + PUBLISHED KBs from user's org(s)
        // + enabled system-managed KBs.
        // Group restriction (shared_groups) is applied in JS by callers via filterByGroupAccess.
        const f = buildFilters(3);
        const u = buildSystemUnion(3 + f.params.length);
        return getAll(
            `${baseSelect}
             WHERE (kb.tenant_id = $1 OR (kb.organization_id = ANY($2) AND kb.is_published = TRUE))${f.sql}${u.sql}
             ORDER BY created_at DESC`,
            [tenantId, orgIdArray, ...f.params, ...u.params]
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
        // System-managed KBs hold public reference content (e.g. Dutch
        // legislation). Read access is granted to any authenticated user; the
        // beta-feature toggle gates whether they appear in pickers / chat,
        // not whether the underlying public text is reachable.
        if (kb.source_kind === 'system_managed') return true;
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
        // Documents cascade-delete; chunks must be deleted via search-service.
        // Also scrub this KB from any project's knowledge_base_ids so projects
        // don't carry dangling references after the KB row is gone.
        try {
            await run(
                `UPDATE projects
                 SET knowledge_base_ids = COALESCE(
                     (SELECT jsonb_agg(elem) FROM jsonb_array_elements_text(knowledge_base_ids) elem WHERE elem <> $1),
                     '[]'::jsonb
                 )
                 WHERE knowledge_base_ids @> to_jsonb($1::text)`,
                [id]
            );
        } catch (e) { /* projects table may not exist yet on first boot */ }
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

    deleteDocument: async (id, { deletedBy = null, skipSnapshot = false } = {}) => {
        await initDB();
        // Snapshot first so the row can be recovered via listDeletedDocuments.
        // The route handlers used to do this themselves; moving the call here
        // guarantees the snapshot also runs for background callers (reindex
        // cleanup, legacy bulk paths). Pass skipSnapshot:true when the caller
        // has already snapshotted to avoid double-writes.
        if (!skipSnapshot) {
            try {
                await KnowledgeBasesStore.snapshotDocumentVersion(id, deletedBy);
            } catch (e) {
                console.warn('[KnowledgeBases] deleteDocument: snapshot failed', e.message);
            }
        }
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

    // ── KB Versioning ───────────────────────────────────────────────────
    // Snapshot the current state of a KB into kb_versions. Returns the new
    // version number, or null on failure. Best-effort: a failed snapshot
    // must never block the caller's mutation.
    snapshotKBVersion: async (kbId, changedBy, changeReason = null) => {
        await initDB();
        try {
            const kb = await getOne(`SELECT * FROM knowledge_bases WHERE id = $1`, [kbId]);
            if (!kb) return null;
            const next = await getOne(
                `SELECT COALESCE(MAX(version_number), 0) + 1 AS v FROM kb_versions WHERE kb_id = $1`,
                [kbId]
            );
            const versionNumber = next?.v || 1;
            await run(
                `INSERT INTO kb_versions (kb_id, version_number, snapshot, changed_by, change_reason)
                 VALUES ($1, $2, $3, $4, $5)`,
                [kbId, versionNumber, JSON.stringify(kb), changedBy || null, changeReason || null]
            );
            return versionNumber;
        } catch (e) {
            console.warn('[KnowledgeBases] snapshotKBVersion failed:', e.message);
            return null;
        }
    },

    listKBVersions: async (kbId, { limit = 50, offset = 0 } = {}) => {
        await initDB();
        return getAll(
            `SELECT id, version_number, changed_by, change_reason, created_at
             FROM kb_versions WHERE kb_id = $1
             ORDER BY version_number DESC LIMIT $2 OFFSET $3`,
            [kbId, limit, offset]
        );
    },

    getKBVersion: async (kbId, versionNumber) => {
        await initDB();
        return getOne(
            `SELECT * FROM kb_versions WHERE kb_id = $1 AND version_number = $2`,
            [kbId, versionNumber]
        );
    },

    // Snapshot a document BEFORE its row is deleted so a re-ingest can
    // recover the original metadata. Chunks themselves live in the
    // search-service; we record what's needed to reconstruct a re-ingest
    // request (title, source URI, content hash). Best-effort.
    snapshotDocumentVersion: async (documentId, deletedBy = null) => {
        await initDB();
        try {
            const doc = await getOne(`SELECT * FROM documents WHERE id = $1`, [documentId]);
            if (!doc) return null;
            await run(
                `INSERT INTO kb_document_versions
                    (document_id, knowledge_base_id, tenant_id, title, source_type,
                     source_uri, content_hash, payload, deleted_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                    doc.id, doc.knowledge_base_id, doc.tenant_id,
                    doc.title, doc.source_type, doc.source_uri,
                    doc.content_hash, JSON.stringify(doc), deletedBy,
                ]
            );
            return doc.id;
        } catch (e) {
            console.warn('[KnowledgeBases] snapshotDocumentVersion failed:', e.message);
            return null;
        }
    },

    listDeletedDocuments: async (kbId, { limit = 100 } = {}) => {
        await initDB();
        return getAll(
            `SELECT id, document_id, title, source_type, source_uri, deleted_at, deleted_by
             FROM kb_document_versions WHERE knowledge_base_id = $1
             ORDER BY deleted_at DESC LIMIT $2`,
            [kbId, limit]
        );
    },
};

module.exports = KnowledgeBasesStore;
