/**
 * Notebook Routes — CRUD for notebooks + source management.
 *
 * Endpoints:
 *   POST   /                    — create notebook
 *   GET    /                    — list user's notebooks
 *   GET    /:id                 — get notebook detail
 *   PUT    /:id                 — update notebook
 *   DELETE /:id                 — delete notebook
 *   POST   /:id/sources/file    — upload file source (pdf, docx, xlsx, txt…)
 *   POST   /:id/sources/url     — add URL source
 *   POST   /:id/sources/text    — paste text source
 *   POST   /:id/sources/drive   — import from Google Drive / OneDrive
 *   GET    /:id/sources         — list sources
 *   DELETE /:id/sources/:sid    — remove source
 *
 * Template-fill endpoints (preserved for backwards compat):
 *   POST   /:id/upload-template — upload .docx template to a notebook
 *   POST   /:id/fill            — fill template with values
 *   POST   /:id/fill-and-store  — fill + store result
 *   GET    /:id/download        — download original template .docx
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');

const notebookStore = require('../stores/notebookStore');
const storageStore = require('../stores/storageStore');
const transcriptionStore = require('../stores/transcriptionStore');
const kbStore = require('../stores/knowledgeBases');
const { ingestFileSource, ingestUrlSource, ingestTextSource, ingestDriveSource } = require('../agents/notebooks/sourceIngestion');
const { parseDocument, isSupportedDocument } = require('../core/documentParser');
const { deleteDocumentChunks, findDocumentBySourceUri } = require('../core/kbIngestionHelpers');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

function requireAuth(req, res, next) {
    if (req.session?.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ── Notebook CRUD ──────────────────────────────────────────────────

router.post('/', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { name, description, instructions } = req.body;
        const notebook = await notebookStore.createNotebook({ userId, name, description, instructions });
        res.json({ success: true, notebook });
    } catch (err) {
        console.error('[Notebooks] Create failed:', err);
        res.status(500).json({ error: 'Failed to create notebook' });
    }
});

router.get('/', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebooks = await notebookStore.getNotebooks(userId);
        res.json({ notebooks });
    } catch (err) {
        console.error('[Notebooks] List failed:', err);
        res.status(500).json({ error: 'Failed to list notebooks' });
    }
});

router.get('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebook = await notebookStore.getNotebook(req.params.id, userId);
        if (!notebook) return res.status(404).json({ error: 'Notebook not found' });

        // Include sources
        const sources = await notebookStore.getSources(notebook.id);
        res.json({ notebook, sources });
    } catch (err) {
        console.error('[Notebooks] Get failed:', err);
        res.status(500).json({ error: 'Failed to get notebook' });
    }
});

router.put('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { name, description, instructions, settings, knowledgeBaseIds, documentContent } = req.body;

        // Auto-version: snapshot current content before overwriting (5-min debounce)
        if (documentContent !== undefined) {
            try {
                const nb = await notebookStore.getNotebook(req.params.id, userId);
                if (nb && nb.documentContent && nb.documentContent.trim() && nb.documentContent !== documentContent) {
                    const shouldSnapshot = await notebookStore.shouldAutoVersion(req.params.id);
                    if (shouldSnapshot) {
                        await notebookStore.createVersion(req.params.id, nb.documentContent, 'Auto-save');
                    }
                }
            } catch (vErr) {
                console.warn('[Notebooks] Auto-version failed:', vErr.message);
            }
        }

        const ok = await notebookStore.updateNotebook(req.params.id, userId, {
            name, description, instructions, settings, knowledgeBaseIds, documentContent
        });
        if (!ok) return res.status(404).json({ error: 'Notebook not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Notebooks] Update failed:', err);
        res.status(500).json({ error: 'Failed to update notebook' });
    }
});

router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const result = await notebookStore.deleteNotebook(req.params.id, userId);
        if (!result) return res.status(404).json({ error: 'Notebook not found' });

        // Clean up auto-created KBs
        if (result.knowledgeBaseIds?.length > 0) {
            for (const kbId of result.knowledgeBaseIds) {
                try { await kbStore.deleteKB(kbId); } catch (e) {
                    console.warn(`[Notebooks] KB cleanup for ${kbId}:`, e.message);
                }
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[Notebooks] Delete failed:', err);
        res.status(500).json({ error: 'Failed to delete notebook' });
    }
});

// ── Source: File Upload (PDF, DOCX, XLSX, CSV, TXT…) ────────────

router.post('/:id/sources/file', requireAuth, upload.single('file'), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebookId = req.params.id;

        // Verify notebook exists
        const nb = await notebookStore.getNotebook(notebookId, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const fileName = req.file.originalname;
        const mimeType = req.file.mimetype;
        const buffer = req.file.buffer;

        // Determine source type from file extension
        const ext = (fileName.split('.').pop() || '').toLowerCase();
        const typeMap = { pdf: 'pdf', docx: 'docx', doc: 'docx', xlsx: 'xlsx', xls: 'xlsx', csv: 'csv', txt: 'text', md: 'text' };
        const type = typeMap[ext] || 'file';

        // Store file in RustFS
        let storageKey = null;
        if (storageStore.isAvailable()) {
            const storageName = `nb_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
            storageKey = storageStore.buildKey(userId, 'notebooks', storageName);
            await storageStore.uploadFile(storageKey, buffer, mimeType);
        }

        // Create source record
        const source = await notebookStore.addSource({
            notebookId, type, name: fileName,
            storageKey, fileName, metadata: { mimeType, size: buffer.length }
        });

        res.json({ success: true, source });

        // Background: parse + ingest into KB
        ingestFileSource(notebookId, source.id, userId, buffer, fileName, mimeType).catch(err => {
            console.error(`[Notebooks] Background ingestion failed for ${fileName}:`, err.message);
        });

    } catch (err) {
        console.error('[Notebooks] File upload failed:', err);
        res.status(500).json({ error: 'Failed to upload file' });
    }
});

// ── Source: URL ──────────────────────────────────────────────────

router.post('/:id/sources/url', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebookId = req.params.id;
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'URL required' });

        const nb = await notebookStore.getNotebook(notebookId, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        // Derive name from URL
        let name;
        try { name = new URL(url).hostname + new URL(url).pathname; } catch { name = url; }
        if (name.length > 80) name = name.slice(0, 80) + '…';

        const source = await notebookStore.addSource({
            notebookId, type: 'url', name,
            metadata: { url }
        });

        res.json({ success: true, source });

        // Background: fetch + ingest
        ingestUrlSource(notebookId, source.id, userId, url).catch(err => {
            console.error(`[Notebooks] URL ingestion failed for ${url}:`, err.message);
        });

    } catch (err) {
        console.error('[Notebooks] URL source failed:', err);
        res.status(500).json({ error: 'Failed to add URL source' });
    }
});

// ── Source: Pasted Text ─────────────────────────────────────────

router.post('/:id/sources/text', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebookId = req.params.id;
        const { text, name } = req.body;
        if (!text) return res.status(400).json({ error: 'Text content required' });

        const nb = await notebookStore.getNotebook(notebookId, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const sourceName = name || 'Pasted text';
        const source = await notebookStore.addSource({
            notebookId, type: 'text', name: sourceName,
            wordCount: text.split(/\s+/).length
        });

        res.json({ success: true, source });

        // Background: ingest
        ingestTextSource(notebookId, source.id, userId, text, sourceName).catch(err => {
            console.error(`[Notebooks] Text ingestion failed:`, err.message);
        });

    } catch (err) {
        console.error('[Notebooks] Text source failed:', err);
        res.status(500).json({ error: 'Failed to add text source' });
    }
});

// ── Source: Meeting Notes ─────────────────────────────────────────

router.post('/:id/sources/meeting', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebookId = req.params.id;
        const { meetingId } = req.body;
        if (!meetingId) return res.status(400).json({ error: 'Meeting ID required' });

        const nb = await notebookStore.getNotebook(notebookId, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const meeting = await transcriptionStore.getTranscription(meetingId, userId);
        if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

        const sourceName = `Meeting Note: ${meeting.title || 'Untitled Meeting'}`;
        const sourceText = meeting.transcription || meeting.summary || '';
        
        if (!sourceText.trim()) return res.status(400).json({ error: 'Meeting has no transcription content' });

        const source = await notebookStore.addSource({
            notebookId, type: 'text', name: sourceName,
            wordCount: sourceText.split(/\s+/).length
        });

        res.json({ success: true, source });

        // Background: ingest
        ingestTextSource(notebookId, source.id, userId, sourceText, sourceName).catch(err => {
            console.error(`[Notebooks] Meeting source ingestion failed:`, err.message);
        });

    } catch (err) {
        console.error('[Notebooks] Meeting source failed:', err);
        res.status(500).json({ error: 'Failed to add meeting source' });
    }
});

// ── Source: Google Drive / OneDrive ──────────────────────────────

router.post('/:id/sources/drive', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebookId = req.params.id;
        const { files, provider } = req.body; // provider: 'google' | 'microsoft'

        if (!files || !Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ error: 'Files array required' });
        }

        const nb = await notebookStore.getNotebook(notebookId, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const sources = [];
        for (const file of files) {
            const type = provider === 'microsoft' ? 'onedrive' : 'gdrive';
            const source = await notebookStore.addSource({
                notebookId,
                type,
                name: file.name || 'Drive file',
                metadata: {
                    provider,
                    driveFileId: file.driveFileId,
                    charCount: file.content?.length
                },
                wordCount: file.content ? file.content.split(/\s+/).length : 0
            });
            sources.push(source);

            // Background: ingest
            if (file.content) {
                ingestDriveSource(notebookId, source.id, userId, file.content, file.name).catch(err => {
                    console.error(`[Notebooks] Drive ingestion failed for ${file.name}:`, err.message);
                });
            } else {
                notebookStore.updateSource(source.id, { status: 'error', error: 'No content received from Drive' });
            }
        }

        res.json({ success: true, sources });

    } catch (err) {
        console.error('[Notebooks] Drive source failed:', err);
        res.status(500).json({ error: 'Failed to add Drive source' });
    }
});

// ── List Sources ────────────────────────────────────────────────

router.get('/:id/sources', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const sources = await notebookStore.getSources(nb.id);
        res.json({ sources });
    } catch (err) {
        console.error('[Notebooks] List sources failed:', err);
        res.status(500).json({ error: 'Failed to list sources' });
    }
});

// ── Delete Source ───────────────────────────────────────────────

router.delete('/:id/sources/:sid', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const source = await notebookStore.deleteSource(req.params.sid);
        if (!source) return res.status(404).json({ error: 'Source not found' });

        // Clean up file storage
        if (source.storageKey) {
            try {
                if (!source.storageKey.startsWith('local:')) {
                    await storageStore.deleteFile(source.storageKey);
                }
            } catch (e) { console.warn('[Notebooks] Storage cleanup:', e.message); }
        }

        // Clean up KB document chunks (source ID was stored as source_uri during ingestion)
        const kbIds = nb.knowledgeBaseIds || [];
        if (kbIds.length > 0) {
            for (const kbId of kbIds) {
                try {
                    const doc = await findDocumentBySourceUri(kbId, source.id);
                    if (doc) {
                        await deleteDocumentChunks(kbId, doc.id, userId);
                        console.log(`[Notebooks] Cleaned up KB document ${doc.id} for source ${source.id}`);
                    }
                } catch (e) {
                    console.warn(`[Notebooks] KB chunk cleanup for source ${source.id}:`, e.message);
                }
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[Notebooks] Delete source failed:', err);
        res.status(500).json({ error: 'Failed to delete source' });
    }
});

// ── Studio: Generate Content (FAQ / Summary / Study Guide) ──────

router.post('/:id/generate/:type', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebookId = req.params.id;
        const type = req.params.type; // faq, summary, studyGuide
        const { modelTier, timezone } = req.body;

        const nb = await notebookStore.getNotebook(notebookId, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const sources = await notebookStore.getSources(notebookId);
        const readySources = sources.filter(s => s.status === 'ready');
        if (readySources.length === 0) {
            return res.status(400).json({ error: 'No ready sources to generate from' });
        }

        // Gather source content using shared KB search utility
        const { gatherNotebookContent } = require('../core/notebookKnowledgeSearch');
        const kbIds = nb.knowledgeBaseIds || [];

        const { content: allContent } = await gatherNotebookContent({
            userId,
            kbIds,
            sources: readySources,
            documentContent: nb.documentContent,
            options: { maxChars: 50000, topK: 25, minScore: 0.15 },
        });

        if (!allContent.trim()) {
            return res.status(400).json({ error: 'Could not retrieve source content from knowledge base' });
        }

        // Type-specific prompts
        const typePrompts = {
            faq: `Generate a comprehensive FAQ (Frequently Asked Questions) document based on the source material below. 
Format as a well-structured markdown document with clear Q&A pairs grouped by topic.`,
            summary: `Generate an executive summary based on the source material below. Include Key Findings and Conclusions.`,
            briefing_doc: `Generate a comprehensive Briefing Document based on the source material below. Include an Executive Summary, Detailed Analysis, and Strategic Recommendations.`,
            blog_post: `Draft an engaging, well-written Blog Post based on the core themes of the source material. Use a catchy title, headings, and an accessible tone.`,
            studyGuide: `Generate a comprehensive study guide based on the source material below. Include Learning Objectives, Key Concepts, Important Terms, and Review Questions.`,
            flashcards: `Generate a set of 10-15 Flashcards for studying the source material. Format them exactly like this:
**Q:** [Question]
**A:** [Answer]`,
            quiz: `Create a multiple-choice Knowledge Quiz based on the source material. Include 5-10 questions.
List the questions first with A/B/C/D options. Then provide an Answer Key at the very bottom.`,
            mind_map: `Extract the core concepts from the source material and generate a Mermaid.js mind map visualization.
Wrap your output in \`\`\`mermaid ... \`\`\` tags. Focus on hierarchical relationships between the main topics.`,
            data_table: `Extract the most important quantitative data, comparisons, or structured information from the source material and present it as a Markdown table.`,
            audio_overview: `You are an AI podcast producer. Write a short, engaging 2-host podcast script discussing the key takeaways from the provided source material.
The hosts are Host 1 (an enthusiastic learner) and Host 2 (the expert who explains things).
FORMAT RULE: You MUST format the script EXACTLY as pairs of lines like this:
Host 1: [Host 1's dialogue]
Host 2: [Host 2's dialogue]

Keep the total script length to around 300 words. Focus on the most interesting insights.`
        };

        const prompt = typePrompts[type] || typePrompts.summary;

        // Resolve model
        const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
        const configStore = require('../stores/configStore');
        const { getAdapter } = require('../core/providers');

        let tiers = await configStore.getConfig('chat_model_tiers') || {};
        let resolvedTier = modelTier || 'balanced';

        // Auto mode: classify using the generation type as a pseudo-message
        if (resolvedTier === 'auto') {
            try {
                const { classifyWithLLM } = require('../core/promptClassifier');
                const pseudoMessage = `Generate a comprehensive ${type.replace(/([A-Z])/g, ' $1').toLowerCase()} from my notebook sources`;
                const result = await classifyWithLLM(pseudoMessage, tiers);
                resolvedTier = result.tier;
                console.log(`[Notebooks] Auto: tier="${resolvedTier}" (${result.method}: ${result.reason}) for ${type}`);
            } catch (err) {
                console.log(`[Notebooks] Auto classification failed: ${err.message}, using balanced`);
                resolvedTier = 'balanced';
            }
        }

        const tier = tiers[resolvedTier] || {};
        let modelId = tier.modelId;
        if (!modelId) {
            const config = await getAIConfig();
            modelId = config.model;
            if (!modelId) throw new Error(`No model configured for tier "${resolvedTier}". Set up model tiers in Settings.`);
        }
        const config = await getProviderForModel(modelId);
        const apiKey = config.apiKey;
        const apiUrl = (config.url || '').replace(/\/+$/, '');
        const adapter = getAdapter(config.providerType, apiUrl);

        // Set SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

        const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const systemPrompt = `You are an expert content generator. Today is ${today}.

${prompt}

CRITICAL RULES:
- You MUST generate content ONLY based on the source material provided below.
- Do NOT use your own knowledge or training data — ONLY use the information in [SOURCE MATERIAL].
- If the source material doesn't contain enough information, generate what you can from it and note any gaps.
- All questions, answers, facts and claims must be directly traceable to the source text below.
- Cite sources using [Source Name] notation when referencing specific information.

[SOURCE MATERIAL]
${allContent.slice(0, 50000)}`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Generate the ${type === 'studyGuide' ? 'study guide' : type} now. Be thorough and comprehensive.` }
        ];

        const chatOptions = {
            maxTokens: (tier.maxTokens || 8192),
            temperature: 0.4,
        };

        let fullGeneratedText = '';

        await adapter.stream(apiKey, apiUrl, modelId, messages, chatOptions, (streamType, data) => {
            if (streamType === 'text') {
                fullGeneratedText += data.text;
                send('content', { text: data.text });
            } else if (streamType === 'thinking') {
                send('thinking', { text: data.text });
            } else if (streamType === 'error') {
                send('error', data);
            }
        });

        // If it's an audio overview, we pipe the generated script through ElevenLabs.
        if (type === 'audio_overview') {
            try {
                send('content', { text: '\n\n*🎙️ Generating audio podcast using ElevenLabs...*\n' });
                const scriptLines = fullGeneratedText.split('\\n').map(l => l.trim()).filter(l => l.length > 0);
                
                // Extract segments based on standard "Host X:" pattern
                const segments = [];
                for (const line of scriptLines) {
                    if (line.startsWith('Host 1:')) segments.push({ host: 1, text: line.replace('Host 1:', '').trim() });
                    else if (line.startsWith('Host 2:')) segments.push({ host: 2, text: line.replace('Host 2:', '').trim() });
                }

                if (segments.length > 0) {
                    const elevenlabsProvider = require('../core/providers/elevenlabs');
                    const elApiKey = await configStore.getSecret('elevenlabs_api_key');
                    if (!elApiKey) {
                        send('content', { text: '\n\n*(Error: ElevenLabs API Key is missing. Audio not generated.)*' });
                    } else {
                        // Voice IDs: Host 1 (George), Host 2 (Rachel)
                        const voice1 = 'JBFqnCBsd6RMkjVDRZzb'; 
                        const voice2 = '21m00Tcm4TlvDq8ikWAM'; 

                        const audioBuffers = [];
                        for (const seg of segments) {
                            const vId = seg.host === 1 ? voice1 : voice2;
                            const resAudio = await elevenlabsProvider.textToSpeech(elApiKey, seg.text, { voice_id: vId });
                            if (resAudio.audioBase64) {
                                audioBuffers.push(Buffer.from(resAudio.audioBase64, 'base64'));
                            }
                        }

                        if (audioBuffers.length > 0) {
                            const finalBuffer = Buffer.concat(audioBuffers);
                            const b64 = finalBuffer.toString('base64');
                            // Emit as a proper audio SSE event so the frontend can render it with AudioPlayer
                            send('audio', { url: `data:audio/mpeg;base64,${b64}`, mimeType: 'audio/mpeg', source: 'elevenlabs_tts' });
                            send('content', { text: '\n\n*✅ Audio podcast generated successfully! Check the player above.*' });
                        }
                    }
                }
            } catch (err) {
                console.error('[Notebooks] Audio Overview generation failed:', err);
                send('content', { text: `\n\n*(Audio generation failed: ${err.message})*` });
            }
        }

        send('done', {});
        res.end();

    } catch (err) {
        console.error(`[Notebooks] Generate ${req.params.type} failed:`, err);
        try {
            res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
            res.end();
        } catch { res.status(500).json({ error: 'Generation failed' }); }
    }
});


// ── AI Fill Parameters ────────────────────────────────────────────
// Extracts {{parameter}} placeholders from the document and fills them
// using the notebook's attached sources.
router.post('/:id/ai-fill', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const { documentContent, modelTier } = req.body;
        if (!documentContent?.trim()) return res.status(400).json({ error: 'No document content provided' });

        // Extract all {{parameter}} placeholders
        const paramRegex = /\{\{([^}]+)\}\}/g;
        const params = [];
        let match;
        while ((match = paramRegex.exec(documentContent)) !== null) {
            params.push(match[1].trim());
        }
        if (params.length === 0) return res.status(400).json({ error: 'No {{parameters}} found in the document' });

        // Gather source content from KB
        const kbIds = nb.knowledgeBaseIds || [];
        let sourceContent = '';

        if (kbIds.length > 0) {
            const configStore = require('../stores/configStore');
            const searchUrl = await configStore.getConfig('search_service_url') || 'https://services.beeflow.ai';
            const searchKey = await configStore.getSecret('search_service_api_key') || '';

            // Fetch all KB content using source names as queries
            const sources = await notebookStore.getSources(nb.id);
            for (const source of sources) {
                if (source.status !== 'ready') continue;
                try {
                    const searchRes = await fetch(`${searchUrl}/api/search`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-API-Key': searchKey },
                        body: JSON.stringify({
                            query: source.name || 'main content',
                            kb_ids: kbIds,
                            top_k: 30,
                        }),
                    });
                    if (searchRes.ok) {
                        const data = await searchRes.json();
                        if (data.results?.length > 0) {
                            sourceContent += `\n--- Source: ${source.name} ---\n`;
                            sourceContent += data.results.map(r => r.content || r.text).join('\n');
                        }
                    }
                } catch {}
            }
        }

        if (!sourceContent.trim()) {
            return res.status(400).json({ error: 'No source content available to fill parameters' });
        }

        // Resolve model  
        const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
        const configStore = require('../stores/configStore');
        const { getAdapter } = require('../core/providers');

        let tiers = await configStore.getConfig('chat_model_tiers') || {};
        let resolvedTier = modelTier || 'balanced';
        if (resolvedTier === 'auto') {
            try {
                const { classifyWithLLM } = require('../core/promptClassifier');
                const result = await classifyWithLLM('Fill in template parameters in a document using source information', tiers);
                resolvedTier = result.tier;
            } catch { resolvedTier = 'balanced'; }
        }

        const tier = tiers[resolvedTier] || {};
        let modelId = tier.modelId;
        if (!modelId) {
            const config = await getAIConfig();
            modelId = config.model;
            if (!modelId) throw new Error(`No model configured for tier "${resolvedTier}". Set up model tiers in Settings.`);
        }
        const config = await getProviderForModel(modelId);
        const apiKey = config.apiKey;
        const apiUrl = (config.url || '').replace(/\/+$/, '');
        const adapter = getAdapter(config.providerType, apiUrl);

        // SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

        const uniqueParams = [...new Set(params)];
        console.log(`[Notebooks] AI Fill: ${uniqueParams.length} unique parameters found for notebook "${nb.name}"`);

        const systemPrompt = `You are a document template filling assistant. Your task is to fill in template parameters in a document using ONLY the provided source material.

The document contains {{parameter_name: description}} placeholders. You must:
1. Read the source material carefully
2. Find the correct value for each parameter from the sources
3. Return the COMPLETE document with ALL {{parameters}} replaced by the correct values
4. Keep ALL other text, HTML formatting, and structure EXACTLY as-is
5. If you cannot find the value for a parameter in the sources, replace it with [UNKNOWN: parameter description]
6. Do NOT add, remove, or change any text outside of the {{parameter}} placeholders

PARAMETERS TO FILL:
${uniqueParams.map((p, i) => `${i + 1}. {{${p}}}`).join('\n')}

SOURCE MATERIAL:
${sourceContent.slice(0, 60000)}`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Here is the document. Replace ALL {{parameter}} placeholders with values from the sources. Return the complete document:\n\n${documentContent}` },
        ];

        const chatOptions = { maxTokens: tier.maxTokens || 8192, temperature: 0.1 };

        await adapter.stream(apiKey, apiUrl, modelId, messages, chatOptions, (streamType, data) => {
            if (streamType === 'text') {
                send('content', { text: data.text });
            } else if (streamType === 'error') {
                send('error', data);
            }
        });

        send('done', { params: uniqueParams.length });
        res.end();
    } catch (err) {
        console.error('[Notebooks] AI Fill failed:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'AI Fill failed: ' + err.message });
        } else {
            res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
            res.end();
        }
    }
});


// ── Notebook Image Upload (for TipTap Image extension) ───────────
//
//  POST /api/notebooks/:id/images
//  Accepts: multipart/form-data { image: File }
//  Returns: { url: "/api/storage/file/..." }
//
//  Images are stored in RustFS under users/{userId}/notebook-images/.
//  If RustFS is not configured the server falls back to a base64 data-URL
//  so the editor still works in local dev without object storage.

const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
    fileFilter: (_req, file, cb) => {
        if (/^image\//.test(file.mimetype)) cb(null, true);
        else cb(new Error('Only image files are allowed'));
    },
});

router.post('/:id/images', requireAuth, imageUpload.single('image'), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebookId = req.params.id;

        // Allow 'workspace' as a virtual notebook ID for the workspace notebook pane
        if (notebookId !== 'workspace') {
            const nb = await notebookStore.getNotebook(notebookId, userId);
            if (!nb) return res.status(404).json({ error: 'Notebook not found' });
        }
        if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

        const { buffer, mimetype, originalname } = req.file;
        const ext = originalname.split('.').pop().toLowerCase();
        const safeFilename = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;

        if (storageStore.isAvailable()) {
            // Store in RustFS and return a proxy URL (token-free, routed through Express)
            const key = storageStore.buildKey(userId, 'notebook-images', safeFilename);
            await storageStore.uploadFile(key, buffer, mimetype);
            const url = storageStore.buildProxyUrl(key);
            return res.json({ url });
        }

        // Fallback: base64 data-URL (works in local dev without RustFS)
        const b64 = buffer.toString('base64');
        const url = `data:${mimetype};base64,${b64}`;
        return res.json({ url });

    } catch (err) {
        console.error('[Notebooks] Image upload failed:', err);
        res.status(500).json({ error: 'Image upload failed: ' + err.message });
    }
});

// ── Import File to Editor (PDF, DOCX, TXT...) ────────────────────

router.post('/:id/import-file', requireAuth, upload.single('file'), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const { parseDocument } = require('../core/documentParser');
        const text = await parseDocument(req.file.buffer, req.file.mimetype, req.file.originalname, { returnHtml: true });

        res.json({ success: true, text });
    } catch (err) {
        console.error('[Notebooks] Import file failed:', err);
        res.status(500).json({ error: 'Failed to parse file for import' });
    }
});

// ── Version Control ─────────────────────────────────────────────────

// List versions (metadata only)
router.get('/:id/versions', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const versions = await notebookStore.getVersions(req.params.id);
        res.json({ versions });
    } catch (err) {
        console.error('[Notebooks] List versions failed:', err);
        res.status(500).json({ error: 'Failed to list versions' });
    }
});

// Get a single version with full content
router.get('/:id/versions/:vid', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const version = await notebookStore.getVersion(req.params.vid);
        if (!version || version.notebookId !== req.params.id) {
            return res.status(404).json({ error: 'Version not found' });
        }
        res.json({ version });
    } catch (err) {
        console.error('[Notebooks] Get version failed:', err);
        res.status(500).json({ error: 'Failed to get version' });
    }
});

// Create a manual snapshot
router.post('/:id/versions', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const summary = req.body.summary || 'Manual snapshot';
        const content = nb.documentContent || '';
        if (!content.trim()) {
            return res.status(400).json({ error: 'Notebook is empty — nothing to snapshot' });
        }

        const version = await notebookStore.createVersion(req.params.id, content, summary);
        res.json({ success: true, version });
    } catch (err) {
        console.error('[Notebooks] Create version failed:', err);
        res.status(500).json({ error: 'Failed to create version' });
    }
});

// Delete a version
router.delete('/:id/versions/:vid', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const ok = await notebookStore.deleteVersion(req.params.vid);
        if (!ok) return res.status(404).json({ error: 'Version not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Notebooks] Delete version failed:', err);
        res.status(500).json({ error: 'Failed to delete version' });
    }
});

module.exports = router;
