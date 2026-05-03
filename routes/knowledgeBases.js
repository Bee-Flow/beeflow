/**
 * Knowledge Bases API Routes
 * 
 * KB CRUD, document management, ingestion via search-service, and search.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const kbStore = require('../stores/knowledgeBases');
const configStore = require('../stores/configStore');
const userStore = require('../stores/userStore');
const { requireAuth, resolveUserOrgIds, requirePermission, hasPermission } = require('../auth');

const SEARCH_SERVICE_URL = process.env.SEARCH_SERVICE_URL || 'https://services.beeflow.ai';
const { getServiceHeaders } = require('../core/serviceAuth');
const {
    getAzureIngestParams,
    extractFileContent,
    fetchUrlContent,
    ingestDocument,
    deleteDocumentChunks,
} = require('../core/kbIngestionHelpers');

// Auth helper
const getUserId = (req) => req.session?.user?.id || null;

// Resolve user's group IDs from userStore (used for shared_groups filtering)
async function resolveUserGroups(req) {
    const userId = getUserId(req);
    if (!userId) return [];
    try {
        const user = await userStore.getUser(userId);
        if (!user) return [];
        if (Array.isArray(user.groups)) return user.groups;
        if (typeof user.groups === 'string') {
            try { return JSON.parse(user.groups || '[]'); } catch { return []; }
        }
    } catch (_) { /* ignore */ }
    return [];
}

/**
 * Centralized KB access check. Mirrors `kbStore.canUserAccessKB` so that the
 * list filter and per-id route guards never drift.
 * - Owner (tenant_id) always has access
 * - Super admin (resolveUserOrgIds returns null) always has access
 * - Org member: KB must be in their org AND published AND, if shared_groups
 *   is set, the user must belong to at least one of those groups
 */
async function canAccessKB(req, kb) {
    const userId = getUserId(req);
    if (kb.tenant_id === userId) return true;
    const orgIds = await resolveUserOrgIds(req);
    const userGroups = await resolveUserGroups(req);
    return kbStore.canUserAccessKB(kb, userId, orgIds, userGroups);
}

// Multer for file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

// ── KB CRUD ─────────────────────────────────────────────────────────

/**
 * List all KBs accessible to the current user (personal + org-scoped)
 */
router.get('/', requireAuth, async (req, res) => {
    try {
        const userId = getUserId(req);
        const orgIds = await resolveUserOrgIds(req);
        const kbs = await kbStore.listKBs(userId, orgIds);
        const userGroups = await resolveUserGroups(req);
        // Owners always see drafts; org members see only published KBs that pass
        // shared_groups restriction.
        const filtered = kbStore.filterByGroupAccess(kbs, userId, userGroups);
        res.json(filtered);
    } catch (e) {
        console.error('[KB] List error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * List org-published KBs (mirrors /api/agents/published). Drafts are excluded.
 */
router.get('/published', requireAuth, async (req, res) => {
    try {
        const userId = getUserId(req);
        const orgIds = await resolveUserOrgIds(req);
        const userGroups = await resolveUserGroups(req);
        const kbs = await kbStore.listKBs(userId, orgIds);
        const accessible = kbStore.filterByGroupAccess(kbs, userId, userGroups);
        // Only KBs that are explicitly published (drafts owned by the user are dropped here)
        res.json(accessible.filter(kb => !!kb.is_published));
    } catch (e) {
        console.error('[KB] Published list error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── KB Categories (org-level, mirrors agent_categories) ─────────────

router.get('/categories', requireAuth, async (req, res) => {
    try {
        const orgIds = await resolveUserOrgIds(req);
        const orgId = orgIds !== null && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
        const categories = await kbStore.listKBCategories(orgId);
        res.json(categories);
    } catch (e) {
        console.error('[KB] Categories list error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.post('/categories', requireAuth, requirePermission('manage_knowledge'), async (req, res) => {
    try {
        const { name, icon, color } = req.body || {};
        if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
        const orgIds = await resolveUserOrgIds(req);
        const orgId = orgIds !== null && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
        const id = crypto.randomUUID();
        const category = await kbStore.createKBCategory({ id, organizationId: orgId, name: name.trim(), icon, color });
        res.status(201).json(category);
    } catch (e) {
        console.error('[KB] Category create error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.delete('/categories/:id', requireAuth, requirePermission('manage_knowledge'), async (req, res) => {
    try {
        await kbStore.deleteKBCategory(req.params.id);
        res.json({ success: true });
    } catch (e) {
        console.error('[KB] Category delete error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Create a new KB (auto-assigns to user's organization)
 */
router.post('/', requireAuth, requirePermission('manage_knowledge'), async (req, res) => {
    try {
        const userId = getUserId(req);
        const { name, description, organizationId, categoryId, icon } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Name is required' });
        }

        // Auto-assign the user's first organization if none provided
        let assignOrgId = organizationId;
        if (!assignOrgId) {
            const orgIds = await resolveUserOrgIds(req);
            if (orgIds !== null && orgIds.size > 0) {
                assignOrgId = Array.from(orgIds)[0];
            }
        }

        const kb = await kbStore.createKB(
            userId,
            name.trim(),
            description || '',
            assignOrgId || null,
            { categoryId: categoryId || null, icon: icon || null }
        );
        res.status(201).json(kb);
    } catch (e) {
        console.error('[KB] Create error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── KB Favorites ────────────────────────────────────────────────────
// Per-user favorited KBs (DB-backed; replaces client-side localStorage).
// Defined before /:id routes so GET /favorites is not captured by GET /:id.

router.get('/favorites', requireAuth, async (req, res) => {
    try {
        const userId = getUserId(req);
        const ids = await kbStore.listFavorites(userId);
        res.json(ids);
    } catch (e) {
        console.error('[KB] List favorites error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.post('/favorites/bulk', requireAuth, async (req, res) => {
    try {
        const userId = getUserId(req);
        const { kbIds } = req.body || {};
        if (!Array.isArray(kbIds)) {
            return res.status(400).json({ error: 'kbIds array required' });
        }
        for (const id of kbIds) {
            if (typeof id === 'string' && id) {
                try { await kbStore.addFavorite(userId, id); } catch (_) { /* skip invalid */ }
            }
        }
        const ids = await kbStore.listFavorites(userId);
        res.json(ids);
    } catch (e) {
        console.error('[KB] Bulk favorite add error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.put('/:id/favorite', requireAuth, async (req, res) => {
    try {
        const userId = getUserId(req);
        await kbStore.addFavorite(userId, req.params.id);
        res.json({ success: true });
    } catch (e) {
        console.error('[KB] Add favorite error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.delete('/:id/favorite', requireAuth, async (req, res) => {
    try {
        const userId = getUserId(req);
        await kbStore.removeFavorite(userId, req.params.id);
        res.json({ success: true });
    } catch (e) {
        console.error('[KB] Remove favorite error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Get a single KB with documents
 */
router.get('/:id', requireAuth, async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

        const documents = await kbStore.listDocuments(kb.id);
        res.json({ ...kb, documents });
    } catch (e) {
        console.error('[KB] Get error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Update KB metadata
 */
router.patch('/:id', requireAuth, requirePermission('manage_knowledge'), async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

        const updated = await kbStore.updateKB(kb.id, req.body);
        res.json(updated);
    } catch (e) {
        console.error('[KB] Update error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Toggle publish state + set sharing scope. Mirrors PATCH /api/agents/:id/publish.
 * Owner can always publish/unpublish; non-owners need manage_knowledge.
 */
router.patch('/:id/publish', requireAuth, async (req, res) => {
    try {
        const userId = getUserId(req);
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });

        const isOwner = kb.tenant_id === userId;
        const isAdmin = req.session?.isAdmin || req.session?.user?.role === 'admin';
        if (!isOwner && !isAdmin) {
            const hasPerm = await hasPermission(userId, 'manage_knowledge', req.session);
            if (!hasPerm) return res.status(403).json({ error: 'Permission denied' });
        }

        // A KB must be attached to an organization to be published.
        if (req.body.isPublished && !kb.organization_id) {
            return res.status(400).json({ error: 'KB must belong to an organization before publishing' });
        }

        const { isPublished, sharedGroups } = req.body || {};
        const updated = await kbStore.setPublished(kb.id, !!isPublished, sharedGroups || []);
        res.json({ success: true, kb: updated });
    } catch (e) {
        console.error('[KB] Publish error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Delete a KB (cascades documents, chunks via search-service)
 */
router.delete('/:id', requireAuth, requirePermission('manage_knowledge'), async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

        // Delete chunks from search-service
        try {
            await fetch(`${SEARCH_SERVICE_URL}/kb/${kb.id}/chunks`, {
                method: 'DELETE',
                headers: getServiceHeaders(),
                body: JSON.stringify({ tenant_id: kb.tenant_id }),
                signal: AbortSignal.timeout(10000)
            });
        } catch (e) {
            console.warn('[KB] Search-service chunk cleanup failed:', e.message);
        }

        // Delete chunks from local vector store
        try {
            const { deleteChunksLocally } = require('../core/localKBIngest');
            await deleteChunksLocally(kb.tenant_id, kb.id);
        } catch (e) {
            console.warn('[KB] Local chunk cleanup failed:', e.message);
        }

        await kbStore.deleteKB(kb.id);
        res.json({ success: true });
    } catch (e) {
        console.error('[KB] Delete error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Documents ───────────────────────────────────────────────────────

/**
 * List documents for a KB
 */
router.get('/:id/documents', requireAuth, async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);
        const filters = {
            sender: req.query.sender || undefined,
            threadId: req.query.threadId || undefined,
            hasAttachment: req.query.hasAttachment === 'true',
            dateFrom: req.query.dateFrom || undefined,
            dateTo: req.query.dateTo || undefined,
            sourceType: req.query.sourceType || undefined,
        };

        const [docs, total] = await Promise.all([
            kbStore.listDocuments(kb.id, { limit, offset, filters }),
            kbStore.countDocuments(kb.id, filters),
        ]);
        res.json({ documents: docs, total, limit, offset });
    } catch (e) {
        console.error('[KB] List docs error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Bulk-delete documents (up to 200 per call).
 */
router.post('/:id/documents/bulk-delete', requireAuth, requirePermission('manage_knowledge'), async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

        const ids = Array.isArray(req.body?.documentIds) ? req.body.documentIds.slice(0, 200) : [];
        if (ids.length === 0) return res.status(400).json({ error: 'documentIds required' });

        let deleted = 0;
        const errors = [];
        for (const docId of ids) {
            try {
                const doc = await kbStore.getDocument(docId);
                if (!doc || doc.knowledge_base_id !== kb.id) continue;
                await deleteDocumentChunks(kb.id, doc.id, kb.tenant_id);
                deleted++;
            } catch (err) {
                errors.push({ docId, error: err.message });
            }
        }
        res.json({ deleted, errors });
    } catch (e) {
        console.error('[KB] Bulk delete error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * List unique thread IDs for the KB (for the thread explorer).
 */
router.get('/:id/threads', requireAuth, async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const threads = kbStore.listThreads ? await kbStore.listThreads(kb.id, { limit }) : [];
        res.json({ threads });
    } catch (e) {
        console.error('[KB] List threads error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * List documents in a specific thread, sorted by date.
 */
router.get('/:id/threads/:threadId/documents', requireAuth, async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

        const docs = kbStore.listDocumentsByThread ? await kbStore.listDocumentsByThread(kb.id, req.params.threadId) : [];
        res.json({ documents: docs });
    } catch (e) {
        console.error('[KB] Thread docs error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * List chunks for a document. Reads from the local kb_chunks table; rows
 * stored only in the remote search-service won't appear here, so we
 * surface that as a soft empty state in the UI.
 */
router.get('/:id/documents/:docId/chunks', requireAuth, async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

        const doc = await kbStore.getDocument(req.params.docId);
        if (!doc || doc.knowledge_base_id !== kb.id) {
            return res.status(404).json({ error: 'Document not found' });
        }

        const limit = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 500);

        let chunks = [];
        try {
            const { getAll } = require('../db');
            chunks = await getAll(
                `SELECT chunk_id, content, chunk_type, source_uri, title, lang
                 FROM kb_chunks
                 WHERE tenant_id = $1
                   AND knowledge_base_id = $2
                   AND document_id = $3
                 ORDER BY chunk_id ASC
                 LIMIT $4`,
                [kb.tenant_id, kb.id, doc.id, limit]
            );
        } catch (e) {
            // kb_chunks table may not exist if no Azure ingest has happened yet
            chunks = [];
        }

        res.json({
            document: { id: doc.id, title: doc.title, source_type: doc.source_type, source_uri: doc.source_uri, chunk_count: doc.chunk_count || 0 },
            chunks,
            total: chunks.length,
            // When the doc was ingested via the remote search-service, chunks live there and
            // aren't readable from the main DB. Tell the UI so it can explain the empty state.
            remote_only: chunks.length === 0 && (doc.chunk_count || 0) > 0,
        });
    } catch (e) {
        console.error('[KB] List chunks error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Delete a document (and its chunks)
 */
router.delete('/:id/documents/:docId', requireAuth, requirePermission('manage_knowledge'), async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

        const doc = await kbStore.getDocument(req.params.docId);
        if (!doc || doc.knowledge_base_id !== kb.id) {
            return res.status(404).json({ error: 'Document not found' });
        }

        await deleteDocumentChunks(kb.id, doc.id, kb.tenant_id);
        res.json({ success: true });
    } catch (e) {
        console.error('[KB] Delete doc error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Ingestion ───────────────────────────────────────────────────────

/**
 * Ingest text content into a KB
 */
router.post('/:id/ingest/text', requireAuth, requirePermission('manage_knowledge'), async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

        const { content, title } = req.body;
        if (!content || typeof content !== 'string' || content.trim().length < 3) {
            return res.status(400).json({ error: 'Content is required (min 3 chars)' });
        }

        const result = await ingestDocument(
            kb.tenant_id, kb.id, content,
            title || 'Text snippet', 'text', null,
            {}
        );

        res.status(201).json({
            success: true,
            document: result.document,
            chunks: result.chunks
        });
    } catch (e) {
        if (e.code === 'DUPLICATE') {
            return res.status(409).json({ error: e.message, documentId: e.documentId });
        }
        console.error('[KB] Ingest text error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Ingest file into a KB
 */
router.post('/:id/ingest/file', requireAuth, requirePermission('manage_knowledge'), upload.single('file'), async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const mime = req.file.mimetype;
        const filename = req.file.originalname;

        // Extract text from file via shared helpers
        const content = await extractFileContent(req.file.buffer, mime, filename);

        if (!content || content.trim().length < 10) {
            return res.status(400).json({ error: 'Could not extract text from file' });
        }

        const result = await ingestDocument(
            kb.tenant_id, kb.id, content,
            filename, 'upload', filename,
            {}
        );

        res.status(201).json({
            success: true,
            document: result.document,
            chunks: result.chunks
        });
    } catch (e) {
        if (e.code === 'DUPLICATE') {
            return res.status(409).json({ error: 'Duplicate content', documentId: e.documentId });
        }
        console.error('[KB] Ingest file error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Ingest URL into a KB
 */
router.post('/:id/ingest/url', requireAuth, requirePermission('manage_knowledge'), async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'URL is required' });

        // Fetch and convert to markdown via shared helper
        const { content, title: pageTitle, resolvedUrl } = await fetchUrlContent(url);

        const result = await ingestDocument(
            kb.tenant_id, kb.id, content,
            pageTitle, 'web', resolvedUrl,
            {}
        );

        res.status(201).json({
            success: true,
            document: result.document,
            chunks: result.chunks,
            source: resolvedUrl
        });
    } catch (e) {
        if (e.code === 'DUPLICATE') {
            return res.status(409).json({ error: 'This URL content already exists', documentId: e.documentId });
        }
        if (e.message.includes('Invalid URL') || e.message.includes('Only HTTP')) {
            return res.status(400).json({ error: e.message });
        }
        if (e.message.includes('Fetch failed')) {
            return res.status(502).json({ error: e.message });
        }
        console.error('[KB] Ingest URL error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Ingest all pages from a website sitemap into a KB
 */
router.post('/:id/ingest/sitemap', requireAuth, requirePermission('manage_knowledge'), async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

        const { url, maxPages = 50 } = req.body;
        if (!url) return res.status(400).json({ error: 'URL is required' });

        // Validate URL
        let parsedUrl;
        try {
            parsedUrl = new URL(url);
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                return res.status(400).json({ error: 'Only HTTP/HTTPS URLs supported' });
            }
        } catch {
            return res.status(400).json({ error: 'Invalid URL' });
        }

        // ── Step 1: Fetch sitemap URLs using the sitemap-fetcher component ──
        const baseUrl = parsedUrl.origin;
        const { fetchUrl: fetchSitemapUrl } = (() => {
            // Inline the core sitemap logic from website-sitemap-fetcher
            async function fetchUrl(targetUrl, timeout = 10000, userAgent = 'Mozilla/5.0 (compatible; BeeFlow/1.0)') {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeout);
                try {
                    const response = await fetch(targetUrl, {
                        headers: { 'User-Agent': userAgent },
                        signal: controller.signal,
                        redirect: 'follow',
                    });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return await response.text();
                } finally {
                    clearTimeout(timer);
                }
            }

            return { fetchUrl };
        })();

        const { parseString } = require('xml2js');

        async function parseSitemap(xml, sitemapBaseUrl) {
            return new Promise((resolve, reject) => {
                parseString(xml, (err, result) => {
                    if (err) return reject(err);
                    const urls = [];
                    const sitemaps = [];
                    if (result.urlset && Array.isArray(result.urlset.url)) {
                        result.urlset.url.forEach(u => {
                            if (u.loc && u.loc[0]) urls.push(new URL(u.loc[0], sitemapBaseUrl).href);
                        });
                    }
                    if (result.sitemapindex && Array.isArray(result.sitemapindex.sitemap)) {
                        result.sitemapindex.sitemap.forEach(sm => {
                            if (sm.loc && sm.loc[0]) sitemaps.push(new URL(sm.loc[0], sitemapBaseUrl).href);
                        });
                    }
                    resolve({ urls, sitemaps });
                });
            });
        }

        async function processSitemap(sitemapUrl, allUrls, visitedSitemaps, limit) {
            if (visitedSitemaps.has(sitemapUrl) || allUrls.size >= limit) return;
            visitedSitemaps.add(sitemapUrl);
            try {
                const xml = await fetchSitemapUrl(sitemapUrl);
                const { urls, sitemaps } = await parseSitemap(xml, sitemapUrl);
                for (const u of urls) {
                    if (allUrls.size >= limit) return;
                    allUrls.add(u);
                }
                for (const nested of sitemaps) {
                    if (allUrls.size >= limit) break;
                    await processSitemap(nested, allUrls, visitedSitemaps, limit);
                }
            } catch (e) {
                console.warn(`[KB] Sitemap fetch failed for ${sitemapUrl}: ${e.message}`);
            }
        }

        // Try robots.txt first for sitemap locations
        const sitemapUrls = new Set([
            `${baseUrl}/sitemap.xml`,
            `${baseUrl}/sitemap_index.xml`,
        ]);

        try {
            const robotsTxt = await fetchSitemapUrl(`${baseUrl}/robots.txt`);
            const matches = robotsTxt.match(/^sitemap:\s*(.+)$/gim);
            if (matches) {
                matches.forEach(line => {
                    const smUrl = line.replace(/^sitemap:\s*/i, '').trim();
                    try { sitemapUrls.add(new URL(smUrl, baseUrl).href); } catch { }
                });
            }
        } catch { }

        const allPageUrls = new Set();
        const visitedSitemaps = new Set();
        for (const smUrl of sitemapUrls) {
            if (allPageUrls.size >= maxPages) break;
            await processSitemap(smUrl, allPageUrls, visitedSitemaps, maxPages);
        }

        const pageUrls = Array.from(allPageUrls);
        if (pageUrls.length === 0) {
            return res.status(404).json({ error: 'No pages found in sitemap. Make sure the URL has a valid sitemap.xml' });
        }

        console.log(`[KB] Sitemap: found ${pageUrls.length} pages from ${url}`);

        // ── Step 2: Ingest each page ──
        const { htmlToMarkdown } = require('../../components/webpage-to-markdown/index');
        const results = { ingested: 0, skipped: 0, errors: 0, details: [] };

        for (let i = 0; i < pageUrls.length; i++) {
            const pageUrl = pageUrls[i];
            try {
                // Fetch page
                const response = await fetch(pageUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BeeFlow/1.0)' },
                    redirect: 'follow',
                    signal: AbortSignal.timeout(15000)
                });

                if (!response.ok) {
                    results.errors++;
                    results.details.push({ url: pageUrl, status: 'error', reason: `HTTP ${response.status}` });
                    continue;
                }

                const html = await response.text();
                const contentType = response.headers.get('content-type') || '';
                let content = '', pageTitle = '';

                if (contentType.includes('text/html')) {
                    const result = htmlToMarkdown(html, response.url || pageUrl, { includeLinks: true, includeImages: false });
                    content = result.markdown;
                    pageTitle = result.title || new URL(pageUrl).pathname;
                    if (pageTitle && !content.startsWith(`# ${pageTitle}`)) {
                        content = `# ${pageTitle}\n\n${content}`;
                    }
                } else if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
                    content = html;
                    pageTitle = new URL(pageUrl).pathname;
                } else {
                    results.skipped++;
                    results.details.push({ url: pageUrl, status: 'skipped', reason: `Unsupported: ${contentType}` });
                    continue;
                }

                if (!content || content.trim().length < 20) {
                    results.skipped++;
                    results.details.push({ url: pageUrl, status: 'skipped', reason: 'No content' });
                    continue;
                }

                // Dedupe check
                const hash = kbStore.hashContent(content);
                const existing = await kbStore.hasContentHash(kb.id, hash);
                if (existing) {
                    results.skipped++;
                    results.details.push({ url: pageUrl, status: 'skipped', reason: 'Duplicate' });
                    continue;
                }

                const result = await ingestDocument(
                    kb.tenant_id,
                    kb.id,
                    content,
                    pageTitle,
                    'web',
                    response.url || pageUrl,
                    { skipDedup: true }
                );

                results.ingested++;
                results.details.push({ url: pageUrl, status: 'ingested', chunks: result.chunks || 0 });

                console.log(`[KB] Sitemap page ${i + 1}/${pageUrls.length}: ${pageTitle} (${result.chunks} chunks)`);
            } catch (e) {
                results.errors++;
                results.details.push({ url: pageUrl, status: 'error', reason: e.message });
            }
        }

        await kbStore.bumpKBVersion(kb.id);

        res.json({
            success: true,
            totalPages: pageUrls.length,
            ingested: results.ingested,
            skipped: results.skipped,
            errors: results.errors,
            details: results.details
        });
    } catch (e) {
        console.error('[KB] Sitemap ingest error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Get n8n workflows that are configured with allowKbIngestion=true
 */
router.get('/n8n/ingestible', requireAuth, async (req, res) => {
    try {
        const userStore = require('../stores/userStore');
        const user = await userStore.getUser(getUserId(req));
        if (!user || !user.organizationId) {
            return res.json([]);
        }
        
        const orgWorkflows = await configStore.getConfig(`n8n_workflows_org_${user.organizationId}`);
        if (!orgWorkflows || !Array.isArray(orgWorkflows)) {
            return res.json([]);
        }

        const ingestible = orgWorkflows.filter(wf => wf.allowKbIngestion === true);
        res.json(ingestible);
    } catch (e) {
        console.error('[KB] Error fetching ingestible n8n workflows:', e);
        res.status(500).json({ error: e.message });
    }
});


/**
 * Ingest an n8n workflow definition into a KB
 * 
 * Fetches the workflow from the connected n8n instance, converts it
 * to structured Markdown, and ingests it as a KB document.
 */
router.post('/:id/ingest/n8n', requireAuth, requirePermission('manage_knowledge'), async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

        const { workflowId, mode = 'data' } = req.body;
        if (!workflowId) {
            return res.status(400).json({ error: 'workflowId is required' });
        }

        // Get org-level n8n config
        const userStore = require('../stores/userStore');
        const user = await userStore.getUser(getUserId(req));
        const orgId = user?.organizationId;
        if (!orgId) {
            return res.status(400).json({ error: 'No organization configured' });
        }

        const n8nUrl = await configStore.getConfig(`n8n_url_org_${orgId}`);
        const n8nApiKey = await configStore.getSecret(`n8n_api_key_org_${orgId}`);
        if (!n8nUrl || !n8nApiKey) {
            return res.status(400).json({ error: 'n8n is not configured for your organisation' });
        }

        const orgWorkflows = await configStore.getConfig(`n8n_workflows_org_${orgId}`) || [];
        const configuredWf = orgWorkflows.find(w => w.id === workflowId);
        if (!configuredWf || !configuredWf.allowKbIngestion) {
            return res.status(403).json({ error: 'This n8n workflow has not been enabled for KB ingestion by your Organisation administrator' });
        }

        // Fetch the full workflow definition from n8n
        const { fetchWorkflowById, triggerWebhookWorkflow } = require('../integrations/n8nTools');
        const workflow = await fetchWorkflowById(n8nUrl, n8nApiKey, workflowId);

        if (!workflow || !workflow.nodes) {
            return res.status(400).json({ error: 'Invalid workflow data received from n8n' });
        }

        let documentsToIngest = [];

        if (mode === 'definition') {
            // Convert Workflow Definition to Markdown
            const { convertN8nWorkflowToMarkdown } = require('../core/n8nWorkflowConverter');
            const markdown = convertN8nWorkflowToMarkdown(workflow);
            const title = `n8n Workflow Structure: ${workflow.name || 'Untitled'}`;
            const sourceUri = `n8n://workflow/${workflowId}/definition`;
            
            if (!markdown || markdown.trim().length < 10) {
                return res.status(400).json({ error: 'Workflow produced no meaningful content' });
            }
            documentsToIngest.push({ title, markdown, sourceUri });
        } else {
            // Execute Webhook and use Data
            const webhookNode = workflow.nodes.find(n => n.type === 'n8n-nodes-base.webhook');
            if (!webhookNode || !webhookNode.parameters || !webhookNode.parameters.path) {
                return res.status(400).json({ error: 'Execution failed: No active webhook trigger node found in this workflow.' });
            }

            const webhookPath = webhookNode.parameters.path;
            const httpMethod = webhookNode.parameters.httpMethod || 'GET';
            
            console.log(`[KB] Executing n8n workflow webhook for real-time ingestion: ${webhookPath}`);
            const resultContent = await triggerWebhookWorkflow(n8nUrl, webhookPath, httpMethod, null, []);

            let parsedArray = [];
            if (typeof resultContent === 'string') {
                try {
                    const parsed = JSON.parse(resultContent);
                    // Check if it's an error bubble from triggerWebhookWorkflow
                    if (parsed.error && Object.keys(parsed).length === 1) {
                         return res.status(400).json({ error: parsed.error });
                    }
                    parsedArray = Array.isArray(parsed) ? parsed : [parsed];
                } catch (e) {
                    // Pure markdown or text
                    parsedArray = [{ text: resultContent }];
                }
            } else if (typeof resultContent === 'object') {
                if (resultContent.error && Object.keys(resultContent).length === 1) {
                     return res.status(400).json({ error: resultContent.error });
                }
                parsedArray = Array.isArray(resultContent) ? resultContent : [resultContent];
            }

            parsedArray.forEach((item, idx) => {
                let itemMarkdown = item.markdown || item.text || item.content || `\`\`\`json\n${JSON.stringify(item, null, 2)}\n\`\`\``;
                let itemTitle = item.fileName || item.filename || item.title || item.name || `n8n Output: ${workflow.name} (Item ${idx + 1})`;
                documentsToIngest.push({
                    title: itemTitle,
                    markdown: itemMarkdown,
                    sourceUri: itemTitle
                });
            });
        }

        if (documentsToIngest.length === 0) {
            return res.status(400).json({ error: 'n8n workflow executed successfully, but returned no content for the KB' });
        }

        // Ingest into KB
        let totalChunks = 0;
        let lastResult = null;
        let ingestedDocs = 0;

        for (const doc of documentsToIngest) {
            if (!doc.markdown || doc.markdown.trim().length === 0) continue;
            
            try {
                const result = await ingestDocument(
                    kb.tenant_id, kb.id, doc.markdown,
                    doc.title, 'n8n', doc.sourceUri,
                    {}
                );
                totalChunks += result.chunks;
                ingestedDocs++;
                lastResult = result;
            } catch (err) {
                console.error(`[KB] Failed to ingest item ${doc.title}:`, err.message);
                if (documentsToIngest.length === 1) throw err; // Throw if it's the only one
            }
        }

        if (totalChunks === 0) {
            return res.status(400).json({ error: `Execution succeeded, but no chunks were produced. Raw payload extracted from ${documentsToIngest.length} item(s) was not chunkable.` });
        }

        console.log(`[KB] n8n workflow "${workflow.name}" ingested [mode=${mode}]: ${ingestedDocs} docs, ${totalChunks} chunks`);

        res.status(201).json({
            success: true,
            document: lastResult ? lastResult.document : null,
            chunks: totalChunks,
            workflowName: workflow.name,
        });
    } catch (e) {
        if (e.code === 'DUPLICATE') {
            return res.status(409).json({ error: 'This workflow is already imported in this KB', documentId: e.documentId });
        }
        console.error('[KB] n8n ingest error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Search ──────────────────────────────────────────────────────────

/**
 * Search across one or more KBs via search-service
 */
router.post('/search', requireAuth, async (req, res) => {
    try {
        const userId = getUserId(req);
        const { kb_ids, query, top_k } = req.body;

        if (!query || !kb_ids || !Array.isArray(kb_ids) || kb_ids.length === 0) {
            return res.status(400).json({ error: 'query and kb_ids[] are required' });
        }

        // Verify access to all KBs in a single round-trip
        const orgIds = await resolveUserOrgIds(req);
        const userGroups = await resolveUserGroups(req);
        const { getAll } = require('../db');
        const kbRows = await getAll(
            `SELECT * FROM knowledge_bases WHERE id = ANY($1::uuid[])`,
            [kb_ids]
        );
        const foundIds = new Set(kbRows.map(r => String(r.id)));
        const missing = kb_ids.find(id => !foundIds.has(String(id)));
        if (missing) {
            return res.status(403).json({ error: `Access denied for KB ${missing}` });
        }
        for (const kb of kbRows) {
            if (!kbStore.canUserAccessKB(kb, userId, orgIds, userGroups)) {
                return res.status(403).json({ error: `Access denied for KB ${kb.id}` });
            }
        }

        const useAzure = !!(await configStore.getConfig('use_azure_doc_processing'));

        let results;
        if (useAzure) {
            const { searchLocally } = require('../core/localKBIngest');
            const localResults = await searchLocally(userId, kb_ids, query, { topK: top_k || 8 });
            results = {
                chunks: localResults,
                results: localResults
            };
        } else {
            const searchRes = await fetch(`${SEARCH_SERVICE_URL}/tools/kb-search`, {
                method: 'POST',
                headers: getServiceHeaders(),
                body: JSON.stringify({
                    tenant_id: userId,
                    kb_ids,
                    query,
                    top_k: top_k || 8,
                    rerank: true
                }),
                signal: AbortSignal.timeout(30000)
            });

            if (!searchRes.ok) {
                const err = await searchRes.text();
                return res.status(502).json({ error: `Search failed: ${err}` });
            }

            results = await searchRes.json();
            
            // Format chunks correctly regardless of what key the search-service uses
            if (!results.chunks && results.results) {
                results.chunks = results.results;
            }
        }

        // ── Filter Orphaned Chunks ────────────────────────────────────
        // searchLocally() already filters orphans (._orphanFiltered = true).
        // Only run this for the search-service path.
        const allChunks = [...(results.chunks || []), ...(results.results || [])];
        const alreadyFiltered = (results.chunks || results.results || [])?._orphanFiltered;
        if (!alreadyFiltered && allChunks.length > 0 && allChunks.some(c => c.document_id)) {
            try {
                const { getAll } = require('../db');
                const dbDocs = await getAll('SELECT id FROM documents WHERE knowledge_base_id = ANY($1::uuid[])', [kb_ids]);
                const validDocIds = new Set(dbDocs.map(d => String(d.id).toLowerCase()));
                const filterFn = c => !c.document_id || validDocIds.has(String(c.document_id).toLowerCase());
                
                if (results.chunks && Array.isArray(results.chunks)) {
                    results.chunks = results.chunks.filter(filterFn);
                }
                if (results.results && Array.isArray(results.results)) {
                    results.results = results.results.filter(filterFn);
                }
            } catch (filterErr) {
                console.warn('[KB] Orphan filter failed, skipping:', filterErr.message);
            }
        }

        res.json(results);
    } catch (e) {
        console.error('[KB] Search error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Re-index ────────────────────────────────────────────────────────

/**
 * Re-index all documents in a KB (re-fetch URLs, re-embed all chunks)
 * Used after switching embedding models.
 */
router.post('/:id/reindex', requireAuth, requirePermission('manage_knowledge'), async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

        const docs = await kbStore.listDocuments(kb.id);
        if (docs.length === 0) {
            return res.json({ success: true, reindexed: 0, failed: 0, details: [] });
        }

        const useAzure = !!(await configStore.getConfig('use_azure_doc_processing'));
        console.log(`[KB] Re-indexing KB "${kb.name}" (${docs.length} docs, azure: ${useAzure})...`);
        const results = { reindexed: 0, failed: 0, details: [] };

        for (let i = 0; i < docs.length; i++) {
            const doc = docs[i];
            let content = '';
            let title = doc.title || 'Untitled';

            try {
                // ── Web docs: re-fetch URL ──
                if (doc.source_type === 'web' && doc.source_uri) {
                    console.log(`[KB] Reindex [${i + 1}/${docs.length}] Re-fetching URL: ${doc.source_uri}`);
                    try {
                        const { htmlToMarkdown } = require('../../components/webpage-to-markdown/index');
                        const response = await fetch(doc.source_uri, {
                            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BeeFlow/1.0)' },
                            redirect: 'follow',
                            signal: AbortSignal.timeout(30000)
                        });

                        if (!response.ok) {
                            throw new Error(`HTTP ${response.status}`);
                        }

                        const html = await response.text();
                        const contentType = response.headers.get('content-type') || '';

                        if (contentType.includes('text/html')) {
                            const result = htmlToMarkdown(html, response.url || doc.source_uri, {
                                includeLinks: true, includeImages: false
                            });
                            content = result.markdown;
                            title = result.title || title;
                            if (title && !content.startsWith(`# ${title}`)) {
                                content = `# ${title}\n\n${content}`;
                            }
                        } else if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
                            content = html;
                        }
                    } catch (fetchErr) {
                        console.warn(`[KB] Reindex: URL fetch failed for "${doc.source_uri}": ${fetchErr.message}, falling back to existing content`);
                        // Fall back to existing chunk content
                        content = '';
                    }
                }

                // ── Fallback / text / upload: get existing chunk content ──
                if (!content || content.trim().length < 20) {
                    console.log(`[KB] Reindex [${i + 1}/${docs.length}] Using existing content for: ${title}`);

                    if (useAzure) {
                        // Issue #11: Try stored original_content first (fast path)
                        try {
                            const { getOne } = require('../db');
                            const row = await getOne('SELECT original_content FROM documents WHERE id = $1::uuid', [doc.id]);
                            if (row?.original_content && row.original_content.trim().length >= 20) {
                                content = row.original_content;
                                console.log(`[KB] Reindex [${i + 1}/${docs.length}] Using stored original_content`);
                            }
                        } catch (_) {}

                        // Fallback: reconstruct from chunks
                        if (!content || content.trim().length < 20) {
                            const { getDocumentContent } = require('../core/localKBIngest');
                            content = await getDocumentContent(kb.tenant_id, kb.id, doc.id);
                        }
                    } else {
                        const contentRes = await fetch(
                            `${SEARCH_SERVICE_URL}/kb/${kb.id}/documents/${doc.id}/content?tenant_id=${encodeURIComponent(kb.tenant_id)}`,
                            { headers: getServiceHeaders(), signal: AbortSignal.timeout(15000) }
                        );
                        if (!contentRes.ok) {
                            throw new Error(`Failed to get existing content: ${contentRes.status}`);
                        }
                        const contentData = await contentRes.json();
                        content = contentData.content;
                    }
                }

                if (!content || content.trim().length < 10) {
                    results.failed++;
                    results.details.push({ doc_id: doc.id, title, status: 'skipped', reason: 'No content' });
                    continue;
                }

                // ── Re-ingest (delete old chunks → re-chunk → re-embed → insert) ──
                if (useAzure) {
                    // Local Azure path: delete old chunks then re-ingest locally
                    const { deleteChunksLocally, ingestLocally } = require('../core/localKBIngest');
                    await deleteChunksLocally(kb.tenant_id, kb.id, doc.id);
                    const ingestResult = await ingestLocally(kb.tenant_id, kb.id, doc.id, content, {
                        title,
                        source_uri: doc.source_uri || null,
                    });
                    await kbStore.updateChunkCount(doc.id, ingestResult.chunks_created || 0);
                    results.reindexed++;
                    results.details.push({
                        doc_id: doc.id, title,
                        status: doc.source_type === 'web' ? 'refetched' : 'reembedded',
                        chunks: ingestResult.chunks_created || 0
                    });
                    console.log(`[KB] Reindex [${i + 1}/${docs.length}] ✓ ${title}: ${ingestResult.chunks_created} chunks (azure)`);
                } else {
                    // Search-service path
                    const azureParams = await getAzureIngestParams();
                    const ingestRes = await fetch(`${SEARCH_SERVICE_URL}/kb/ingest/json`, {
                        method: 'POST',
                        headers: getServiceHeaders(),
                        body: JSON.stringify({
                            tenant_id: kb.tenant_id,
                            knowledge_base_id: kb.id,
                            document_id: doc.id,
                            content,
                            title,
                            source_uri: doc.source_uri || null,
                            ...azureParams,
                        }),
                        signal: AbortSignal.timeout(120000)
                    });

                    if (!ingestRes.ok) {
                        throw new Error(`Ingest failed: ${await ingestRes.text()}`);
                    }

                    const ingestResult = await ingestRes.json();
                    await kbStore.updateChunkCount(doc.id, ingestResult.chunks_created || 0);
                    results.reindexed++;
                    results.details.push({
                        doc_id: doc.id, title,
                        status: doc.source_type === 'web' ? 'refetched' : 'reembedded',
                        chunks: ingestResult.chunks_created || 0
                    });
                    console.log(`[KB] Reindex [${i + 1}/${docs.length}] ✓ ${title}: ${ingestResult.chunks_created} chunks`);
                }
            } catch (docErr) {
                console.error(`[KB] Reindex failed for doc "${title}":`, docErr.message);
                results.failed++;
                results.details.push({ doc_id: doc.id, title, status: 'error', reason: docErr.message });
            }
        }

        await kbStore.bumpKBVersion(kb.id);
        console.log(`[KB] Re-index complete: ${results.reindexed} ok, ${results.failed} failed`);

        res.json({
            success: true,
            reindexed: results.reindexed,
            failed: results.failed,
            total: docs.length,
            details: results.details
        });
    } catch (e) {
        console.error('[KB] Reindex error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
