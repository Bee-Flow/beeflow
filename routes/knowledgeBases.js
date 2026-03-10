/**
 * Knowledge Bases API Routes
 * 
 * KB CRUD, document management, ingestion via search-service, and search.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const kbStore = require('../stores/knowledgeBases');
const { requireAuth } = require('../auth');

const SEARCH_SERVICE_URL = process.env.SEARCH_SERVICE_URL || 'http://search-service:8000';

// Auth helper
const getUserId = (req) => req.session?.user?.id || null;

// Multer for file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

// ── KB CRUD ─────────────────────────────────────────────────────────

/**
 * List all KBs for the current user
 */
router.get('/', requireAuth, async (req, res) => {
    try {
        const userId = getUserId(req);
        const kbs = await kbStore.listKBs(userId);
        res.json(kbs);
    } catch (e) {
        console.error('[KB] List error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Create a new KB
 */
router.post('/', requireAuth, async (req, res) => {
    try {
        const userId = getUserId(req);
        const { name, description, defaultLang } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Name is required' });
        }
        const kb = await kbStore.createKB(userId, name.trim(), description || '', defaultLang);
        res.status(201).json(kb);
    } catch (e) {
        console.error('[KB] Create error:', e.message);
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
        if (kb.tenant_id !== getUserId(req)) return res.status(403).json({ error: 'Access denied' });

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
router.patch('/:id', requireAuth, async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (kb.tenant_id !== getUserId(req)) return res.status(403).json({ error: 'Access denied' });

        const updated = await kbStore.updateKB(kb.id, req.body);
        res.json(updated);
    } catch (e) {
        console.error('[KB] Update error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Delete a KB (cascades documents, chunks via search-service)
 */
router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (kb.tenant_id !== getUserId(req)) return res.status(403).json({ error: 'Access denied' });

        // Delete chunks from search-service
        try {
            await fetch(`${SEARCH_SERVICE_URL}/kb/${kb.id}/chunks`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tenant_id: kb.tenant_id }),
                signal: AbortSignal.timeout(10000)
            });
        } catch (e) {
            console.warn('[KB] Search-service chunk cleanup failed:', e.message);
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
        if (kb.tenant_id !== getUserId(req)) return res.status(403).json({ error: 'Access denied' });

        const docs = await kbStore.listDocuments(kb.id);
        res.json(docs);
    } catch (e) {
        console.error('[KB] List docs error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Delete a document (and its chunks)
 */
router.delete('/:id/documents/:docId', requireAuth, async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (kb.tenant_id !== getUserId(req)) return res.status(403).json({ error: 'Access denied' });

        const doc = await kbStore.getDocument(req.params.docId);
        if (!doc || doc.knowledge_base_id !== kb.id) {
            return res.status(404).json({ error: 'Document not found' });
        }

        // Delete chunks from search-service
        try {
            await fetch(`${SEARCH_SERVICE_URL}/kb/${kb.id}/documents/${doc.id}/chunks`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tenant_id: kb.tenant_id }),
                signal: AbortSignal.timeout(10000)
            });
        } catch (e) {
            console.warn('[KB] Search-service chunk cleanup failed:', e.message);
        }

        await kbStore.deleteDocument(doc.id);
        await kbStore.bumpKBVersion(kb.id);
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
router.post('/:id/ingest/text', requireAuth, async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (kb.tenant_id !== getUserId(req)) return res.status(403).json({ error: 'Access denied' });

        const { content, title } = req.body;
        if (!content || typeof content !== 'string' || content.trim().length < 3) {
            return res.status(400).json({ error: 'Content is required (min 3 chars)' });
        }

        // Dedupe check
        const hash = kbStore.hashContent(content);
        const existing = await kbStore.hasContentHash(kb.id, hash);
        if (existing) {
            return res.status(409).json({ error: 'Duplicate content already exists in this KB', documentId: existing });
        }

        // Create document record
        const doc = await kbStore.createDocument(
            kb.tenant_id, kb.id,
            title || 'Text snippet',
            'text', null, hash
        );

        // Send to search-service for ingestion (chunking + embedding + storage)
        const ingestRes = await fetch(`${SEARCH_SERVICE_URL}/kb/ingest/json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tenant_id: kb.tenant_id,
                knowledge_base_id: kb.id,
                document_id: doc.id,
                content,
                title: title || 'Text snippet',
                source_uri: null,
                lang: kb.default_lang
            }),
            signal: AbortSignal.timeout(60000)
        });

        if (!ingestRes.ok) {
            const err = await ingestRes.text();
            console.error('[KB] Search-service ingest error:', err);
            // Cleanup document record
            await kbStore.deleteDocument(doc.id);
            return res.status(502).json({ error: `Ingestion failed: ${err}` });
        }

        const result = await ingestRes.json();
        await kbStore.updateChunkCount(doc.id, result.chunks_created || 0);
        await kbStore.bumpKBVersion(kb.id);

        res.status(201).json({
            success: true,
            document: doc,
            chunks: result.chunks_created || 0
        });
    } catch (e) {
        console.error('[KB] Ingest text error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Ingest file into a KB
 */
router.post('/:id/ingest/file', requireAuth, upload.single('file'), async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (kb.tenant_id !== getUserId(req)) return res.status(403).json({ error: 'Access denied' });

        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        // Extract text from file
        let content = '';
        const mime = req.file.mimetype;
        const filename = req.file.originalname;

        if (mime === 'text/plain' || mime === 'text/markdown') {
            content = req.file.buffer.toString('utf-8');
        } else if (mime === 'application/pdf') {
            // Primary: use pdfExtractor (pdfjs-dist) for text-based PDFs
            try {
                const { extractTextFromPDF } = require('../core/pdfExtractor');
                content = await extractTextFromPDF(req.file.buffer, filename);
            } catch (e) {
                console.warn('[KB] pdfExtractor failed:', e.message);
            }
            // Fallback: Mistral OCR for scanned PDFs (if configured)
            if (!content || content.trim().length < 20) {
                try {
                    const { getMistralOCRApiKey, mistralOCR } = require('../core/ocr');
                    if (await getMistralOCRApiKey()) {
                        const base64 = req.file.buffer.toString('base64');
                        content = await mistralOCR(base64, mime, filename);
                    }
                } catch (e) {
                    console.warn('[KB] Mistral OCR fallback failed:', e.message);
                }
            }
            if (!content || content.trim().length < 10) {
                return res.status(400).json({ error: 'Could not extract text from PDF. The file may be a scanned document without a text layer.' });
            }
        } else if (
            mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            mime === 'text/csv' ||
            mime === 'application/csv' ||
            filename?.match(/\.(docx|csv|xlsx)$/i)
        ) {
            const { parseDocument } = require('../core/documentParser');
            content = await parseDocument(req.file.buffer, mime, filename);
        } else {
            return res.status(400).json({ error: 'Unsupported file type' });
        }

        if (!content || content.trim().length < 10) {
            return res.status(400).json({ error: 'Could not extract text from file' });
        }

        // Dedupe
        const hash = kbStore.hashContent(content);
        const existing = await kbStore.hasContentHash(kb.id, hash);
        if (existing) {
            return res.status(409).json({ error: 'Duplicate content', documentId: existing });
        }

        // Create document
        const doc = await kbStore.createDocument(
            kb.tenant_id, kb.id,
            filename, 'upload', filename, hash
        );

        // Ingest via search-service
        const ingestRes = await fetch(`${SEARCH_SERVICE_URL}/kb/ingest/json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tenant_id: kb.tenant_id,
                knowledge_base_id: kb.id,
                document_id: doc.id,
                content,
                title: filename,
                source_uri: filename,
                lang: kb.default_lang
            }),
            signal: AbortSignal.timeout(120000)
        });

        if (!ingestRes.ok) {
            await kbStore.deleteDocument(doc.id);
            const err = await ingestRes.text();
            return res.status(502).json({ error: `Ingestion failed: ${err}` });
        }

        const result = await ingestRes.json();
        await kbStore.updateChunkCount(doc.id, result.chunks_created || 0);
        await kbStore.bumpKBVersion(kb.id);

        res.status(201).json({
            success: true,
            document: doc,
            chunks: result.chunks_created || 0
        });
    } catch (e) {
        console.error('[KB] Ingest file error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Ingest URL into a KB
 */
router.post('/:id/ingest/url', requireAuth, async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (kb.tenant_id !== getUserId(req)) return res.status(403).json({ error: 'Access denied' });

        const { url } = req.body;
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

        // Fetch and convert to markdown
        const { htmlToMarkdown } = require('../../components/webpage-to-markdown/index');
        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BeeFlow/1.0)' },
            redirect: 'follow',
            signal: AbortSignal.timeout(30000)
        });

        if (!response.ok) {
            return res.status(502).json({ error: `Fetch failed: ${response.status}` });
        }

        const html = await response.text();
        const contentType = response.headers.get('content-type') || '';
        let content = '', pageTitle = '';

        if (contentType.includes('text/html')) {
            const result = htmlToMarkdown(html, response.url || url, { includeLinks: true, includeImages: false });
            content = result.markdown;
            pageTitle = result.title || parsedUrl.hostname;
            if (pageTitle && !content.startsWith(`# ${pageTitle}`)) {
                content = `# ${pageTitle}\n\n${content}`;
            }
        } else if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
            content = html;
            pageTitle = parsedUrl.hostname;
        } else {
            return res.status(400).json({ error: `Unsupported content type: ${contentType}` });
        }

        if (!content || content.trim().length < 20) {
            return res.status(400).json({ error: 'No meaningful content extracted' });
        }

        // Dedupe
        const hash = kbStore.hashContent(content);
        const existing = await kbStore.hasContentHash(kb.id, hash);
        if (existing) {
            return res.status(409).json({ error: 'This URL content already exists', documentId: existing });
        }

        const doc = await kbStore.createDocument(
            kb.tenant_id, kb.id,
            pageTitle, 'web', response.url || url, hash
        );

        // Ingest
        const ingestRes = await fetch(`${SEARCH_SERVICE_URL}/kb/ingest/json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tenant_id: kb.tenant_id,
                knowledge_base_id: kb.id,
                document_id: doc.id,
                content,
                title: pageTitle,
                source_uri: response.url || url,
                lang: kb.default_lang
            }),
            signal: AbortSignal.timeout(120000)
        });

        if (!ingestRes.ok) {
            await kbStore.deleteDocument(doc.id);
            const err = await ingestRes.text();
            return res.status(502).json({ error: `Ingestion failed: ${err}` });
        }

        const result = await ingestRes.json();
        await kbStore.updateChunkCount(doc.id, result.chunks_created || 0);
        await kbStore.bumpKBVersion(kb.id);

        res.status(201).json({
            success: true,
            document: doc,
            chunks: result.chunks_created || 0,
            source: response.url || url
        });
    } catch (e) {
        console.error('[KB] Ingest URL error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Ingest all pages from a website sitemap into a KB
 */
router.post('/:id/ingest/sitemap', requireAuth, async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (kb.tenant_id !== getUserId(req)) return res.status(403).json({ error: 'Access denied' });

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

                // Create document
                const doc = await kbStore.createDocument(
                    kb.tenant_id, kb.id,
                    pageTitle, 'web', response.url || pageUrl, hash
                );

                // Ingest via search-service
                const ingestRes = await fetch(`${SEARCH_SERVICE_URL}/kb/ingest/json`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        tenant_id: kb.tenant_id,
                        knowledge_base_id: kb.id,
                        document_id: doc.id,
                        content,
                        title: pageTitle,
                        source_uri: response.url || pageUrl,
                        lang: kb.default_lang
                    }),
                    signal: AbortSignal.timeout(60000)
                });

                if (!ingestRes.ok) {
                    await kbStore.deleteDocument(doc.id);
                    results.errors++;
                    results.details.push({ url: pageUrl, status: 'error', reason: 'Ingest failed' });
                    continue;
                }

                const ingestResult = await ingestRes.json();
                await kbStore.updateChunkCount(doc.id, ingestResult.chunks_created || 0);
                results.ingested++;
                results.details.push({ url: pageUrl, status: 'ingested', chunks: ingestResult.chunks_created || 0 });

                console.log(`[KB] Sitemap page ${i + 1}/${pageUrls.length}: ${pageTitle} (${ingestResult.chunks_created} chunks)`);
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

        // Verify ownership of all KBs
        for (const kbId of kb_ids) {
            const kb = await kbStore.getKB(kbId);
            if (!kb || kb.tenant_id !== userId) {
                return res.status(403).json({ error: `Access denied for KB ${kbId}` });
            }
        }

        const searchRes = await fetch(`${SEARCH_SERVICE_URL}/tools/kb-search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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

        const results = await searchRes.json();
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
router.post('/:id/reindex', requireAuth, async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (kb.tenant_id !== getUserId(req)) return res.status(403).json({ error: 'Access denied' });

        const docs = await kbStore.listDocuments(kb.id);
        if (docs.length === 0) {
            return res.json({ success: true, reindexed: 0, failed: 0, details: [] });
        }

        console.log(`[KB] Re-indexing KB "${kb.name}" (${docs.length} docs)...`);
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
                    const contentRes = await fetch(
                        `${SEARCH_SERVICE_URL}/kb/${kb.id}/documents/${doc.id}/content?tenant_id=${encodeURIComponent(kb.tenant_id)}`,
                        { signal: AbortSignal.timeout(15000) }
                    );
                    if (!contentRes.ok) {
                        throw new Error(`Failed to get existing content: ${contentRes.status}`);
                    }
                    const contentData = await contentRes.json();
                    content = contentData.content;
                }

                if (!content || content.trim().length < 10) {
                    results.failed++;
                    results.details.push({ doc_id: doc.id, title, status: 'skipped', reason: 'No content' });
                    continue;
                }

                // ── Re-ingest (delete old chunks → re-chunk → re-embed → insert) ──
                const ingestRes = await fetch(`${SEARCH_SERVICE_URL}/kb/ingest/json`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        tenant_id: kb.tenant_id,
                        knowledge_base_id: kb.id,
                        document_id: doc.id,
                        content,
                        title,
                        source_uri: doc.source_uri || null,
                        lang: kb.default_lang
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
