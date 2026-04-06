const express = require('express');
const router = express.Router();
const knowledgeStore = require('../stores/knowledgeStore');
const { requirePermission, requireAuth } = require('../auth');
const multer = require('multer');
const { generateEmbedding, getOrCreateAgent, getAIConfig } = require('../core/aiAgent');
const agentStore = require('../stores/agentStore');
const { chunkMarkdownContent } = require('../core/chunkContent');
const usageStore = require('../stores/usageStore');
const { checkResourceLimits } = require('../core/limits');

// Helper to get user ID (returns null if not authenticated — stricter than agents.js)
const getEffectiveUserId = (req) => req.session?.user?.id || null;

/**
 * Verify the requesting user owns the agent (or it's a swarm/system agent).
 * Returns { ok: true, agent } or { ok: false, status, error }.
 */
async function verifyAgentOwnership(userId, agentId) {
    const agent = await agentStore.getAgent(agentId);
    if (!agent) return { ok: false, status: 404, error: 'Agent not found' };
    if (agent.owner_id !== userId && !['swarm', 'system'].includes(agent.owner_id)) {
        return { ok: false, status: 403, error: 'Access denied' };
    }
    return { ok: true, agent };
}

/**
 * Generate embeddings for multiple chunks concurrently (batched).
 * Processes up to `concurrency` chunks at a time to avoid overwhelming the API.
 */
async function batchGenerateEmbeddings(chunks, agentId, concurrency = 5) {
    const results = [];
    for (let i = 0; i < chunks.length; i += concurrency) {
        const batch = chunks.slice(i, i + concurrency);
        const embeddings = await Promise.all(
            batch.map(chunk => generateEmbedding(chunk.text, { agentId, source: 'knowledge_ingest' }))
        );
        for (let j = 0; j < batch.length; j++) {
            results.push({ chunk: batch[j], embedding: embeddings[j] });
        }
    }
    return results;
}

// ============ CRUD Routes ============

// Add knowledge to an agent
router.post('/agents/:id/knowledge', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agentId = req.params.id;
    const { content, metadata } = req.body;

    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const ownership = await verifyAgentOwnership(userId, agentId);
    if (!ownership.ok) return res.status(ownership.status).json({ error: ownership.error });

    if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'Content is required (string)' });
    }

    try {
        console.log(`[Knowledge] Generating embedding for agent ${agentId}...`);
        const embedding = await generateEmbedding(content, { agentId, source: 'knowledge_ingest' });
        const result = knowledgeStore.addKnowledge(agentId, content, embedding, metadata || {});
        res.json({ success: true, item: result });
    } catch (error) {
        console.error('Failed to add knowledge:', error);
        res.status(500).json({ error: error.message });
    }
});

// List knowledge for an agent
router.get('/agents/:id/knowledge', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agentId = req.params.id;

    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const ownership = await verifyAgentOwnership(userId, agentId);
    if (!ownership.ok) return res.status(ownership.status).json({ error: ownership.error });

    try {
        const items = knowledgeStore.listKnowledge(agentId);
        res.json(items);
    } catch (error) {
        console.error('Failed to list knowledge:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete knowledge item
router.delete('/agents/:id/knowledge/:itemId', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agentId = req.params.id;
    const itemId = req.params.itemId;

    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const ownership = await verifyAgentOwnership(userId, agentId);
    if (!ownership.ok) return res.status(ownership.status).json({ error: ownership.error });

    try {
        knowledgeStore.deleteKnowledge(itemId);
        res.json({ success: true });
    } catch (error) {
        console.error('Failed to delete knowledge:', error);
        res.status(500).json({ error: error.message });
    }
});

// Test Search (Internal/Debug)
router.post('/agents/:id/knowledge/search', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agentId = req.params.id;
    const { query } = req.body;

    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    try {
        const embedding = await generateEmbedding(query, { agentId, source: 'knowledge_query' });
        const results = knowledgeStore.searchKnowledge(agentId, embedding);
        res.json(results);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============ File Upload ============

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 } // 20MB limit
});

router.post('/agents/:id/knowledge/upload', requireAuth, upload.single('file'), async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const agentId = req.params.id;
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // Verify ownership
        const ownership = await verifyAgentOwnership(userId, agentId);
        if (!ownership.ok) return res.status(ownership.status).json({ error: ownership.error });

        // Check knowledge source limit
        const agentOrgId = ownership.agent?.organization_id;
        if (agentOrgId) {
            const existingCount = knowledgeStore.listKnowledge(agentId)?.length || 0;
            const limitErr = await checkResourceLimits(agentOrgId, 'knowledge_sources', existingCount);
            if (limitErr) {
                return res.status(403).json({ error: limitErr });
            }
        }

        let content = '';

        if (req.file.mimetype === 'text/plain' || req.file.mimetype === 'text/markdown') {
            content = req.file.buffer.toString('utf-8');
        }
        else if (req.file.mimetype === 'application/pdf' || req.file.mimetype.startsWith('image/')) {
            const base64Data = req.file.buffer.toString('base64');
            const mode = req.body.mode || 'exact';

            const config = await getAIConfig();
            const { mistralOCR, getMistralOCRApiKey } = require('../core/ocr');

            if (getMistralOCRApiKey() && req.file.mimetype === 'application/pdf') {
                console.log(`[Knowledge] Using Mistral OCR to extract text from PDF...`);

                try {
                    const ocrContent = await mistralOCR(base64Data, req.file.mimetype, req.file.originalname);

                    if (ocrContent) {
                        content = ocrContent;
                        console.log(`[Knowledge] Mistral OCR extracted content from ${req.file.originalname}`);

                        if (mode !== 'exact' && content) {
                            console.log(`[Knowledge] Mode is ${mode}, processing OCR content with LLM...`);

                            try {
                                const pdfAgent = await agentStore.getSystemAgent('system-pdf-extractor');
                                const summaryConfig = { ...config };
                                if (pdfAgent?.model) summaryConfig.model = pdfAgent.model;

                                const tempSessionId = `sys-summarize-${Date.now()}`;
                                const ai = getOrCreateAgent(tempSessionId);
                                ai.clearHistory();

                                let instruction;
                                if (mode === 'formatted') {
                                    instruction = "Reformat the following document text into clean, well-structured Markdown. Keep ALL content - do not summarize or remove anything. Use proper headers, lists, tables, and formatting. Keep the SAME LANGUAGE as the source. DO NOT translate.";
                                } else if (mode === 'detailed') {
                                    instruction = "Generate a **DETAILED SUMMARY** of the following document text. Keep the SAME LANGUAGE as the source. DO NOT translate. Include all important details, sections, and key information.";
                                } else {
                                    instruction = "Generate a **COMPACT SUMMARY** of the following document text. Keep the SAME LANGUAGE as the source. Focus on the main points and key takeaways only.";
                                }

                                ai.conversationHistory = [
                                    { role: 'user', content: `${instruction}\n\n---\n\n${content}` }
                                ];

                                ai.currentContext = { systemPrompt: pdfAgent?.system_prompt || 'You are a professional document summarizer. Summarize documents accurately while preserving the original language.' };

                                const summaryResult = await ai._chatLoop(summaryConfig);

                                if (summaryResult && summaryResult.message) {
                                    content = summaryResult.message;
                                    if (summaryResult.usage) {
                                        await usageStore.logUsage({
                                            agent_id: agentId,
                                            agent_name: 'knowledge_processor',
                                            model: summaryConfig.model || 'unknown',
                                            prompt_tokens: summaryResult.usage?.prompt_tokens || 0,
                                            completion_tokens: summaryResult.usage?.completion_tokens || 0,
                                            total_tokens: summaryResult.usage?.total_tokens || 0,
                                            source: 'knowledge_summarization',
                                        });
                                    }
                                } else {
                                    console.error('[Knowledge] Summarization returned empty result, keeping OCR content');
                                }
                            } catch (summaryError) {
                                console.error('[Knowledge] Summarization failed:', summaryError.message);
                            }
                        }
                    }
                } catch (ocrError) {
                    console.error('[Knowledge] Mistral OCR failed:', ocrError.message);
                }
            }

            if (!content && req.file.mimetype === 'application/pdf') {
                return res.status(400).json({
                    error: 'PDF extraction requires Mistral OCR. Please configure your Mistral API key in Admin → AI Config → Document OCR.',
                    hint: 'Get an API key from console.mistral.ai'
                });
            }

            if (!content && req.file.mimetype.startsWith('image/')) {
                console.log(`[Knowledge] Using Vision Model to extract text from image...`);

                const pdfAgent = await agentStore.getSystemAgent('system-pdf-extractor');
                if (!pdfAgent) {
                    return res.status(500).json({ error: 'PDF Extractor Agent not found' });
                }

                const tempSessionId = `sys-extract-${Date.now()}`;
                const ai = getOrCreateAgent(tempSessionId);
                const dataUri = `data:${req.file.mimetype};base64,${base64Data}`;

                ai.clearHistory();

                const filePart = {
                    type: "image_url",
                    image_url: { url: dataUri }
                };

                let instruction = "Please extract all text from this image verbatim. Do not translate.";

                if (mode === 'detailed') {
                    instruction = "Generate a **DETAILED SUMMARY** of this image. Keep the SAME LANGUAGE. DO NOT translate.";
                } else if (mode === 'compact') {
                    instruction = "Generate a **COMPACT SUMMARY** of this image. Keep the SAME LANGUAGE. DO NOT translate.";
                }

                ai.conversationHistory = [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: instruction },
                            filePart
                        ]
                    }
                ];

                ai.currentContext = { systemPrompt: pdfAgent.system_prompt };

                const result = await ai._chatLoop({ ...config });

                content = result.message;
                if (result.usage) {
                    await usageStore.logUsage({
                        agent_id: agentId,
                        agent_name: 'knowledge_processor',
                        model: config.model || 'unknown',
                        prompt_tokens: result.usage?.prompt_tokens || 0,
                        completion_tokens: result.usage?.completion_tokens || 0,
                        total_tokens: result.usage?.total_tokens || 0,
                        source: 'knowledge_vision_extraction',
                    });
                }
                if (content.includes('NO_CONTENT')) {
                    return res.status(400).json({ error: 'Could not extract text (image might be empty or unreadable)' });
                }
            }
        }
        else if (
            req.file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            req.file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
            req.file.mimetype === 'application/vnd.ms-excel' ||
            req.file.mimetype === 'text/csv' ||
            req.file.mimetype === 'application/csv' ||
            req.file.originalname?.match(/\.(docx|xlsx|xls|csv)$/i)
        ) {
            // DOCX / CSV / XLSX — use central document parser
            const { parseDocument } = require('../core/documentParser');
            content = await parseDocument(req.file.buffer, req.file.mimetype, req.file.originalname);
            console.log(`[Knowledge] Parsed document "${req.file.originalname}" via documentParser: ${content.length} chars`);
        }
        else {
            return res.status(400).json({ error: 'Unsupported file type. Please upload PDF, DOCX, CSV, XLSX, or Text files.' });
        }

        if (!content || !content.trim()) {
            return res.status(400).json({ error: 'Could not extract text from file' });
        }

        // Chunk content
        const chunks = chunkMarkdownContent(content);
        const validChunks = chunks.filter(c => c.text.length >= 10);

        // Batch embed all chunks
        const embeddedChunks = await batchGenerateEmbeddings(validChunks, agentId);

        let addedCount = 0;
        for (const { chunk, embedding } of embeddedChunks) {
            const finalMetadata = {
                source: req.file.originalname,
                type: 'file_upload',
                section_path: chunk.metadata.section_path.join(' > '),
                content_type: chunk.metadata.content_type,
                token_est: chunk.tokens
            };
            knowledgeStore.addKnowledge(agentId, chunk.text, embedding, finalMetadata);
            addedCount++;
        }

        res.status(201).json({ success: true, message: `Processed ${addedCount} chunks from ${req.file.originalname}` });

    } catch (error) {
        console.error('Knowledge upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ URL Knowledge Extraction ============

router.post('/agents/:id/knowledge/url', requireAuth, async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agentId = req.params.id;
    const { url, mode } = req.body;

    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const agent = await agentStore.getAgent(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (agent.owner_id !== userId && !['swarm', 'system'].includes(agent.owner_id)) {
        return res.status(403).json({ error: 'Access denied' });
    }

    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'URL is required' });
    }


    // Basic URL validation
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return res.status(400).json({ error: 'Only HTTP/HTTPS URLs are supported' });
        }
    } catch {
        return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Duplicate detection — warn if already imported
    const existingCount = knowledgeStore.hasSource(agentId, url);
    if (existingCount > 0) {
        console.log(`[Knowledge:URL] URL "${url}" already has ${existingCount} chunks for agent ${agentId}`);
        // Don't block, just warn — user may want to re-import with different settings
    }

    try {
        console.log(`[Knowledge:URL] Fetching ${url}...`);

        // Use the proper webpage-to-markdown converter
        const { htmlToMarkdown } = require('../../components/webpage-to-markdown/index');

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; BeeFlow/1.0; Knowledge Extractor)',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(30000)
        });

        if (!response.ok) {
            return res.status(502).json({ error: `Failed to fetch URL: ${response.status} ${response.statusText}` });
        }

        // Use the resolved URL after redirects
        const resolvedUrl = response.url || url;
        const resolvedParsed = new URL(resolvedUrl);
        const contentType = response.headers.get('content-type') || '';
        const html = await response.text();

        if (!html || html.trim().length === 0) {
            return res.status(400).json({ error: 'URL returned empty content' });
        }

        // Extract content using proper HTML-to-Markdown converter
        let content = '';
        let pageTitle = '';

        if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
            const result = htmlToMarkdown(html, resolvedUrl, { includeLinks: true, includeImages: false });
            content = result.markdown;
            pageTitle = result.title;

            // Prepend title if available and not already in content
            if (pageTitle && !content.startsWith(`# ${pageTitle}`)) {
                content = `# ${pageTitle}\n\n${content}`;
            }
        } else if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
            content = html;
        } else {
            return res.status(400).json({ error: `Unsupported content type: ${contentType}. Only HTML and text pages are supported.` });
        }

        if (!content || content.trim().length < 20) {
            return res.status(400).json({ error: 'Could not extract meaningful content from URL' });
        }

        console.log(`[Knowledge:URL] Extracted ${content.length} chars from ${resolvedParsed.hostname}`);

        // Optional AI processing
        const extractionMode = mode || 'exact';
        if (extractionMode !== 'exact' && content.length > 50) {
            console.log(`[Knowledge:URL] Processing with AI (mode: ${extractionMode})...`);

            try {
                const config = await getAIConfig();
                const pdfAgent = await agentStore.getSystemAgent('system-pdf-extractor');
                const summaryConfig = { ...config };
                if (pdfAgent?.model) summaryConfig.model = pdfAgent.model;

                const tempSessionId = `sys-url-extract-${Date.now()}`;
                const ai = getOrCreateAgent(tempSessionId);
                ai.clearHistory();

                let instruction;
                if (extractionMode === 'formatted') {
                    instruction = "Reformat the following web page content into clean, well-structured Markdown. Keep ALL content — do not summarize or remove anything. Use proper headers, lists, tables, and formatting. Keep the SAME LANGUAGE as the source. DO NOT translate.";
                } else if (extractionMode === 'detailed') {
                    instruction = "Generate a **DETAILED SUMMARY** of the following web page content. Keep the SAME LANGUAGE as the source. DO NOT translate. Include all important details, sections, and key information.";
                } else {
                    instruction = "Generate a **COMPACT SUMMARY** of the following web page content. Keep the SAME LANGUAGE as the source. Focus on the main points and key takeaways only.";
                }

                ai.conversationHistory = [
                    { role: 'user', content: `${instruction}\n\nSource URL: ${resolvedUrl}\n\n---\n\n${content.slice(0, 50000)}` }
                ];

                ai.currentContext = {
                    systemPrompt: pdfAgent?.system_prompt || 'You are a professional content extractor. Extract and organize content accurately while preserving the original language.'
                };

                const summaryResult = await ai._chatLoop(summaryConfig);
                if (summaryResult?.message) {
                    console.log(`[Knowledge:URL] AI processing complete, result: ${summaryResult.message.length} chars`);
                    content = summaryResult.message;
                    if (summaryResult.usage) {
                        await usageStore.logUsage({
                            agent_id: agentId,
                            agent_name: 'knowledge_processor',
                            model: summaryConfig.model || 'unknown',
                            prompt_tokens: summaryResult.usage?.prompt_tokens || 0,
                            completion_tokens: summaryResult.usage?.completion_tokens || 0,
                            total_tokens: summaryResult.usage?.total_tokens || 0,
                            source: 'knowledge_summarization',
                        });
                    }
                }
            } catch (aiError) {
                console.error('[Knowledge:URL] AI processing failed, keeping raw content:', aiError.message);
            }
        }

        // Chunk content
        const chunks = chunkMarkdownContent(content);
        const validChunks = chunks.filter(c => c.text.length >= 10);

        // Batch embed all chunks
        const embeddedChunks = await batchGenerateEmbeddings(validChunks, agentId);

        let addedCount = 0;
        for (const { chunk, embedding } of embeddedChunks) {
            // Build a clean slug from the URL path (e.g. "/veelgestelde-vragen")
            const slug = resolvedParsed.pathname !== '/' ? resolvedParsed.pathname.replace(/\/+$/, '') : '';
            const finalMetadata = {
                source: resolvedUrl,
                source_domain: resolvedParsed.hostname,
                source_slug: slug,
                type: 'url_import',
                extraction_mode: extractionMode,
                section_path: chunk.metadata.section_path.join(' > '),
                content_type: chunk.metadata.content_type,
                token_est: chunk.tokens
            };

            knowledgeStore.addKnowledge(agentId, chunk.text, embedding, finalMetadata);
            addedCount++;
        }

        console.log(`[Knowledge:URL] Stored ${addedCount} chunks from ${resolvedParsed.hostname}`);
        res.status(201).json({
            success: true,
            message: `Imported ${addedCount} knowledge chunks from ${resolvedParsed.hostname}`,
            chunks: addedCount,
            source: resolvedParsed.hostname,
            sourceUrl: resolvedUrl,
            duplicateWarning: existingCount > 0 ? `Note: ${existingCount} chunks from this URL already existed` : undefined
        });

    } catch (error) {
        console.error('[Knowledge:URL] Error:', error);
        res.status(500).json({ error: error.message || 'Failed to extract knowledge from URL' });
    }
});

module.exports = router;
