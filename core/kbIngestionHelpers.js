/**
 * KB Ingestion Helpers — shared logic for both Knowledge Base routes
 * and Notebook source ingestion.
 *
 * Extracts common patterns:
 *   • File content extraction (with Azure Doc Intelligence + OCR fallbacks)
 *   • URL fetching → Markdown conversion
 *   • Document ingestion (dedup → search-service chunk+embed)
 *   • Azure embedding param resolution
 *   • Chunk cleanup via search-service
 */

const configStore = require('../stores/configStore');
const kbStore = require('../stores/knowledgeBases');
const { getServiceHeaders } = require('./serviceAuth');

const SEARCH_SERVICE_URL = process.env.SEARCH_SERVICE_URL || 'https://services.beeflow.ai';

/**
 * Read Azure embedding credentials from configStore.
 * Returns { use_azure, azure_endpoint?, azure_key?, azure_model? }
 */
async function getAzureIngestParams() {
    const useAzure = !!(await configStore.getConfig('use_azure_doc_processing'));
    if (!useAzure) return { use_azure: false };
    return {
        use_azure: true,
        azure_endpoint: await configStore.getConfig('azure_openai_embedding_endpoint') || '',
        azure_key: await configStore.getSecret('azure_openai_embedding_key') || '',
        azure_model: await configStore.getConfig('azure_openai_embedding_model') || 'text-embedding-3-small',
    };
}

/**
 * Extract text from a file buffer.
 *
 * Supports: PDF (pdfjs-dist + Mistral OCR fallback), DOCX, XLSX, CSV, TXT, MD.
 * When Azure Document Intelligence is enabled globally, all file types go through Azure.
 *
 * @param {Buffer}  buffer   — file bytes
 * @param {string}  mime     — MIME type
 * @param {string}  filename — original file name
 * @returns {Promise<string>} extracted text/markdown content
 */
async function extractFileContent(buffer, mime, filename) {
    const useAzure = !!(await configStore.getConfig('use_azure_doc_processing'));

    console.log(`[KBHelpers] ─── File: ${filename} (${(buffer.length / 1024).toFixed(1)} KB, ${mime}) ───`);
    console.log(`[KBHelpers] Mode: ${useAzure ? '☁️  AZURE' : '🖥️  LOCAL'}`);

    // ── Azure Document Intelligence path (all file types) ──
    if (useAzure) {
        const { extractWithAzure, isAzureDocIntelligenceConfigured } = require('./azureDocIntelligence');
        if (!(await isAzureDocIntelligenceConfigured())) {
            throw new Error('Azure Document Intelligence is not configured. Set endpoint and key in admin settings.');
        }
        console.log(`[KBHelpers] Extraction: Azure Document Intelligence (Layout → Markdown)`);
        return await extractWithAzure(buffer, filename);
    }

    // ── Local extraction path ──
    if (mime === 'text/plain' || mime === 'text/markdown') {
        console.log(`[KBHelpers] Extraction: Direct text read (${mime})`);
        return buffer.toString('utf-8');
    }

    if (mime === 'application/pdf') {
        let content = '';

        // Primary: pdfjs-dist for text-based PDFs
        try {
            const { extractTextFromPDF } = require('./pdfExtractor');
            content = await extractTextFromPDF(buffer, filename);
            if (content && content.trim().length >= 20) {
                console.log(`[KBHelpers] Extraction: pdfjs-dist (text-based PDF)`);
            }
        } catch (e) {
            console.warn('[KBHelpers] pdfExtractor failed:', e.message);
        }

        if (!content || content.trim().length < 10) {
            throw new Error('Could not extract text from PDF. Enable Azure Document Intelligence for scanned documents, or ensure the PDF has a text layer.');
        }
        return content;
    }

    // DOCX, CSV, XLSX, etc.
    if (
        mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        mime === 'text/csv' ||
        mime === 'application/csv' ||
        filename?.match(/\.(docx|csv|xlsx)$/i)
    ) {
        const { parseDocument } = require('./documentParser');
        console.log(`[KBHelpers] Extraction: documentParser (${filename.split('.').pop()})`);
        return await parseDocument(buffer, mime, filename);
    }

    // Generic fallback via documentParser
    try {
        const { parseDocument, isSupportedDocument } = require('./documentParser');
        if (isSupportedDocument && isSupportedDocument(mime, filename)) {
            console.log(`[KBHelpers] Extraction: documentParser (generic)`);
            return await parseDocument(buffer, mime, filename);
        }
    } catch (e) {
        console.warn('[KBHelpers] documentParser fallback failed:', e.message);
    }

    throw new Error(`Unsupported file type: ${mime}`);
}

/**
 * Fetch a URL and return its content as clean Markdown.
 *
 * Strategy:
 *   1. Simple HTTP fetch + htmlToMarkdown (fast, works for most sites)
 *   2. If content < 20 chars → Playwright headless browser fallback (handles SPAs)
 *
 * @param {string} url — the URL to fetch
 * @returns {Promise<{content: string, title: string, resolvedUrl: string}>}
 */
async function fetchUrlContent(url) {
    // Validate URL
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error('Only HTTP/HTTPS URLs supported');
        }
    } catch (e) {
        if (e.message.includes('Only HTTP')) throw e;
        throw new Error('Invalid URL');
    }

    // ── Step 1: Simple HTTP fetch (fast path) ────────────────────
    let content = '', pageTitle = '', resolvedUrl = url;

    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BeeFlow/1.0)' },
            redirect: 'follow',
            signal: AbortSignal.timeout(30000)
        });

        if (!response.ok) {
            throw new Error(`Fetch failed: HTTP ${response.status}`);
        }

        resolvedUrl = response.url || url;
        const html = await response.text();
        const contentType = response.headers.get('content-type') || '';

        if (contentType.includes('text/html')) {
            const { htmlToMarkdown } = require('../../components/webpage-to-markdown/index');
            const result = htmlToMarkdown(html, resolvedUrl, { includeLinks: true, includeImages: false });
            content = result.markdown;
            pageTitle = result.title || parsedUrl.hostname;
            if (pageTitle && !content.startsWith(`# ${pageTitle}`)) {
                content = `# ${pageTitle}\n\n${content}`;
            }
        } else if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
            content = html;
            pageTitle = parsedUrl.hostname;
        } else {
            throw new Error(`Unsupported content type: ${contentType}`);
        }
    } catch (fetchErr) {
        // If even the basic fetch fails, try headless browser directly
        console.log(`[KBHelpers] Simple fetch failed for ${url}: ${fetchErr.message}, trying headless browser...`);
        content = '';
    }

    // ── Step 2: Playwright headless fallback (for SPAs / JS-rendered pages) ──
    if (!content || content.trim().length < 20) {
        console.log(`[KBHelpers] Content too short (${content.trim().length} chars), using Playwright headless browser for: ${url}`);
        try {
            const result = await fetchWithPlaywright(url);
            content = result.content;
            pageTitle = result.title || pageTitle || parsedUrl.hostname;
            resolvedUrl = result.resolvedUrl || resolvedUrl;
            console.log(`[KBHelpers] Playwright extracted ${content.length} chars from ${url}`);
        } catch (pwErr) {
            console.error(`[KBHelpers] Playwright fallback failed for ${url}:`, pwErr.message);
            throw new Error(`No meaningful content extracted from URL (simple fetch and headless browser both failed)`);
        }
    }

    if (!content || content.trim().length < 20) {
        throw new Error('No meaningful content extracted from URL');
    }

    // Truncate very long pages
    const maxChars = 200000;
    if (content.length > maxChars) {
        content = content.slice(0, maxChars);
    }

    return { content, title: pageTitle, resolvedUrl };
}

/**
 * Fetch URL content using Playwright headless Chromium.
 * Waits for the page to load + JS to render, then extracts the HTML.
 *
 * @param {string} url
 * @returns {Promise<{content: string, title: string, resolvedUrl: string}>}
 */
async function fetchWithPlaywright(url) {
    const { chromium } = require('playwright');

    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });

        const page = await context.newPage();

        // Navigate and wait for network to settle (JS rendering complete)
        await page.goto(url, {
            waitUntil: 'networkidle',
            timeout: 30000,
        });

        // Additional wait for late-rendering SPAs
        await page.waitForTimeout(2000);

        const pageTitle = await page.title();
        const resolvedUrl = page.url();

        // Get the fully rendered HTML
        const html = await page.content();

        await browser.close();
        browser = null;

        // Convert rendered HTML to markdown
        const { htmlToMarkdown } = require('../../components/webpage-to-markdown/index');
        const result = htmlToMarkdown(html, resolvedUrl, { includeLinks: true, includeImages: false });
        let content = result.markdown;

        if (pageTitle && !content.startsWith(`# ${pageTitle}`)) {
            content = `# ${pageTitle}\n\n${content}`;
        }

        return {
            content,
            title: result.title || pageTitle,
            resolvedUrl,
        };
    } catch (err) {
        if (browser) {
            try { await browser.close(); } catch (_) {}
        }
        throw err;
    }
}

/**
 * Ingest text content into a KB via the search-service.
 *
 * Handles: deduplication check → document record creation → chunking + embedding.
 *
 * @param {string}  tenantId  — user ID
 * @param {string}  kbId      — knowledge base ID
 * @param {string}  content   — text/markdown content
 * @param {string}  title     — document title
 * @param {string}  sourceType — 'text' | 'web' | 'upload' | 'notebook_source'
 * @param {string|null} sourceUri — source identifier (filename, URL, source ID)
 * @param {object}  [options]
 * @param {boolean} [options.skipDedup=false] — skip deduplication check
 * @param {string}  [options.lang='auto']    — language hint
 * @returns {Promise<{document: object, chunks: number}>}
 */
async function ingestDocument(tenantId, kbId, content, title, sourceType, sourceUri, options = {}) {
    const { skipDedup = false, lang = 'auto' } = options;

    if (!content || content.trim().length < 3) {
        throw new Error('Content is too short (min 3 chars)');
    }

    // Deduplication
    const hash = kbStore.hashContent(content);
    if (!skipDedup) {
        const existing = await kbStore.hasContentHash(kbId, hash);
        if (existing) {
            throw Object.assign(new Error('Duplicate content already exists in this KB'), {
                code: 'DUPLICATE', documentId: existing
            });
        }
    }

    // Create document record
    const doc = await kbStore.createDocument(
        tenantId, kbId, title, sourceType, sourceUri, hash
    );

    // Send for chunking + embedding
    const azureParams = await getAzureIngestParams();

    if (azureParams.use_azure) {
        // ── Local ingestion path (Azure) ─────────────────────────────
        // When Azure Document Processing is enabled, chunk + embed locally
        // using Azure OpenAI — bypasses the external search-service.
        console.log(`[KBHelpers] Embedding: Azure OpenAI (local path)`);
        console.log(`[KBHelpers] Chunking + embedding ${content.length} chars locally`);

        try {
            const { ingestLocally } = require('./localKBIngest');
            const result = await ingestLocally(tenantId, kbId, doc.id, content, {
                title,
                sourceUri,
                lang,
            });
            await kbStore.updateChunkCount(doc.id, result.chunks_created || 0);
            await kbStore.bumpKBVersion(kbId);

            return {
                document: doc,
                chunks: result.chunks_created || 0,
            };
        } catch (localErr) {
            console.error('[KBHelpers] Local ingestion failed:', localErr.message);
            // Cleanup the document record on failure
            await kbStore.deleteDocument(doc.id);
            throw new Error(`Local ingestion failed: ${localErr.message}`);
        }
    }

    // ── Search-service path (non-Azure) ──────────────────────────
    console.log(`[KBHelpers] Embedding: Local vLLM (bge-m3) via search-service`);
    console.log(`[KBHelpers] Sending ${content.length} chars to search-service`);

    const ingestRes = await fetch(`${SEARCH_SERVICE_URL}/kb/ingest/json`, {
        method: 'POST',
        headers: getServiceHeaders(),
        body: JSON.stringify({
            tenant_id: tenantId,
            knowledge_base_id: kbId,
            document_id: doc.id,
            content,
            title,
            source_uri: sourceUri,
            lang,
            ...azureParams,
        }),
        signal: AbortSignal.timeout(120000)
    });

    if (!ingestRes.ok) {
        // Cleanup the document record on failure
        await kbStore.deleteDocument(doc.id);
        const err = await ingestRes.text();
        throw new Error(`Search-service ingestion failed: ${err}`);
    }

    const result = await ingestRes.json();
    await kbStore.updateChunkCount(doc.id, result.chunks_created || 0);
    await kbStore.bumpKBVersion(kbId);

    return {
        document: doc,
        chunks: result.chunks_created || 0,
    };
}

/**
 * Delete a document's chunks from the search-service, then remove
 * the document record from the DB.
 *
 * @param {string} kbId     — knowledge base ID
 * @param {string} docId    — document ID
 * @param {string} tenantId — user ID
 */
async function deleteDocumentChunks(kbId, docId, tenantId) {
    // Clean up local kb_chunks (for Azure-path ingested docs)
    try {
        const { deleteChunksLocally } = require('./localKBIngest');
        await deleteChunksLocally(tenantId, kbId, docId);
    } catch (_) { /* table may not exist yet — that's fine */ }

    // Also clean up via search-service (for search-service-path ingested docs)
    try {
        await fetch(`${SEARCH_SERVICE_URL}/kb/${kbId}/documents/${docId}/chunks`, {
            method: 'DELETE',
            headers: getServiceHeaders(),
            body: JSON.stringify({ tenant_id: tenantId }),
            signal: AbortSignal.timeout(10000)
        });
    } catch (e) {
        console.warn('[KBHelpers] Search-service chunk cleanup failed:', e.message);
    }

    await kbStore.deleteDocument(docId);
    await kbStore.bumpKBVersion(kbId);
}

/**
 * Find the KB document record that was created for a notebook source.
 * During ingestion, notebook sources store the source ID as `source_uri`.
 *
 * @param {string} kbId     — knowledge base ID
 * @param {string} sourceId — notebook source ID
 * @returns {Promise<object|null>} document row or null
 */
async function findDocumentBySourceUri(kbId, sourceId) {
    const { getOne } = require('../db');
    return await getOne(
        'SELECT * FROM documents WHERE knowledge_base_id = $1 AND source_uri = $2',
        [kbId, sourceId]
    );
}

module.exports = {
    getAzureIngestParams,
    extractFileContent,
    fetchUrlContent,
    ingestDocument,
    deleteDocumentChunks,
    findDocumentBySourceUri,
};
