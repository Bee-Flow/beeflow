/**
 * Knowledge Bases API Routes
 * 
 * KB CRUD, document management, ingestion via search-service, and search.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const kbStore = require('../stores/knowledgeBases');
const configStore = require('../stores/configStore');
const { requireAuth } = require('../auth');

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
                headers: getServiceHeaders(),
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
router.post('/:id/ingest/text', requireAuth, async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (kb.tenant_id !== getUserId(req)) return res.status(403).json({ error: 'Access denied' });

        const { content, title } = req.body;
        if (!content || typeof content !== 'string' || content.trim().length < 3) {
            return res.status(400).json({ error: 'Content is required (min 3 chars)' });
        }

        const result = await ingestDocument(
            kb.tenant_id, kb.id, content,
            title || 'Text snippet', 'text', null,
            { lang: kb.default_lang }
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
router.post('/:id/ingest/file', requireAuth, upload.single('file'), async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (kb.tenant_id !== getUserId(req)) return res.status(403).json({ error: 'Access denied' });

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
            { lang: kb.default_lang }
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
router.post('/:id/ingest/url', requireAuth, async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (kb.tenant_id !== getUserId(req)) return res.status(403).json({ error: 'Access denied' });

        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'URL is required' });

        // Fetch and convert to markdown via shared helper
        const { content, title: pageTitle, resolvedUrl } = await fetchUrlContent(url);

        const result = await ingestDocument(
            kb.tenant_id, kb.id, content,
            pageTitle, 'web', resolvedUrl,
            { lang: kb.default_lang }
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

                const result = await ingestDocument(
                    kb.tenant_id,
                    kb.id,
                    content,
                    pageTitle,
                    'web',
                    response.url || pageUrl,
                    { skipDedup: true, lang: kb.default_lang }
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
router.post('/:id/ingest/n8n', requireAuth, async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (kb.tenant_id !== getUserId(req)) return res.status(403).json({ error: 'Access denied' });

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
                    sourceUri: `n8n://workflow/${workflowId}/run/${Date.now()}/${idx}`
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
                    { lang: kb.default_lang }
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

        // Verify ownership of all KBs
        for (const kbId of kb_ids) {
            const kb = await kbStore.getKB(kbId);
            if (!kb || kb.tenant_id !== userId) {
                return res.status(403).json({ error: `Access denied for KB ${kbId}` });
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
router.post('/:id/reindex', requireAuth, async (req, res) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (kb.tenant_id !== getUserId(req)) return res.status(403).json({ error: 'Access denied' });

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
                        // Retrieve existing content from local kb_chunks
                        const { getDocumentContent } = require('../core/localKBIngest');
                        content = await getDocumentContent(kb.tenant_id, kb.id, doc.id);
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
                        lang: kb.default_lang,
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
                            lang: kb.default_lang,
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
