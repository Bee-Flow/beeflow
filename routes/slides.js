/**
 * Slides API Routes — CRUD for slide decks, sources, and AI generation.
 * Mirrors routes/notebooks.js architecture.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const slidesStore = require('../stores/slidesStore');
const { ingestFileSource, ingestUrlSource, ingestTextSource, ingestDriveSource } = require('../agents/slides/sourceIngestion');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ─── Deck CRUD ───────────────────────────────────────────────────

// Create deck
router.post('/', requireAuth, async (req, res) => {
    try {
        const { name, description } = req.body;
        const deck = await slidesStore.createDeck(req.session.user.id, name, description);
        res.json(deck);
    } catch (err) {
        console.error('[Slides] Create failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// List decks
router.get('/', requireAuth, async (req, res) => {
    try {
        const decks = await slidesStore.getDecks(req.session.user.id);
        res.json(decks);
    } catch (err) {
        console.error('[Slides] List failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get deck
router.get('/:id', requireAuth, async (req, res) => {
    try {
        const deck = await slidesStore.getDeck(req.params.id, req.session.user.id);
        if (!deck) return res.status(404).json({ error: 'Deck not found' });
        res.json(deck);
    } catch (err) {
        console.error('[Slides] Get failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Update deck
router.put('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const deckId = req.params.id;

        // Auto-version before updating slides content
        if (req.body.slides_content || req.body.slidesContent) {
            try {
                const shouldVersion = await slidesStore.shouldAutoVersion(deckId);
                if (shouldVersion) {
                    const current = await slidesStore.getDeck(deckId, userId);
                    if (current && current.slidesContent && current.slidesContent.length > 0) {
                        await slidesStore.createVersion(deckId, current.slidesContent, 'Auto-save');
                    }
                }
            } catch (vErr) {
                console.warn('[Slides] Auto-version failed:', vErr.message);
            }
        }

        // Normalize camelCase to snake_case for the store
        const updates = {};
        if (req.body.name !== undefined) updates.name = req.body.name;
        if (req.body.description !== undefined) updates.description = req.body.description;
        if (req.body.instructions !== undefined) updates.instructions = req.body.instructions;
        if (req.body.knowledgeBaseIds !== undefined) updates.knowledge_base_ids = req.body.knowledgeBaseIds;
        if (req.body.settings !== undefined) updates.settings = req.body.settings;
        if (req.body.slidesContent !== undefined) updates.slides_content = req.body.slidesContent;
        if (req.body.slides_content !== undefined) updates.slides_content = req.body.slides_content;

        const deck = await slidesStore.updateDeck(deckId, userId, updates);
        if (!deck) return res.status(404).json({ error: 'Deck not found' });
        res.json(deck);
    } catch (err) {
        console.error('[Slides] Update failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Delete deck
router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const deckId = req.params.id;

        // Clean up associated KB
        try {
            const deck = await slidesStore.getDeck(deckId, userId);
            if (deck?.knowledgeBaseIds?.length > 0) {
                const kbStore = require('../stores/knowledgeBases');
                for (const kbId of deck.knowledgeBaseIds) {
                    try { await kbStore.deleteKB(kbId, userId); } catch (e) { }
                }
            }
        } catch (e) { }

        const deleted = await slidesStore.deleteDeck(deckId, userId);
        if (!deleted) return res.status(404).json({ error: 'Deck not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Slides] Delete failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Sources ─────────────────────────────────────────────────────

// Upload file source
router.post('/:id/sources/file', requireAuth, upload.single('file'), async (req, res) => {
    try {
        const deckId = req.params.id;
        const userId = req.session.user.id;

        // Verify ownership
        const deck = await slidesStore.getDeck(deckId, userId);
        if (!deck) return res.status(404).json({ error: 'Deck not found' });

        const file = req.file;
        if (!file) return res.status(400).json({ error: 'No file uploaded' });

        const source = await slidesStore.addSource({
            deckId,
            type: 'file',
            name: file.originalname,
            fileName: file.originalname,
            wordCount: 0,
        });

        // Background ingestion
        ingestFileSource(deckId, source.id, userId, file.buffer, file.originalname, file.mimetype).catch(err => {
            console.error(`[Slides] File ingestion failed:`, err.message);
        });

        res.json(source);
    } catch (err) {
        console.error('[Slides] File upload failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Add URL source
router.post('/:id/sources/url', requireAuth, async (req, res) => {
    try {
        const deckId = req.params.id;
        const userId = req.session.user.id;
        const { url } = req.body;

        if (!url) return res.status(400).json({ error: 'URL required' });

        const deck = await slidesStore.getDeck(deckId, userId);
        if (!deck) return res.status(404).json({ error: 'Deck not found' });

        const source = await slidesStore.addSource({
            deckId,
            type: 'url',
            name: url,
            metadata: { url },
        });

        ingestUrlSource(deckId, source.id, userId, url).catch(err => {
            console.error(`[Slides] URL ingestion failed:`, err.message);
        });

        res.json(source);
    } catch (err) {
        console.error('[Slides] URL source failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Add text source
router.post('/:id/sources/text', requireAuth, async (req, res) => {
    try {
        const deckId = req.params.id;
        const userId = req.session.user.id;
        const { text, name } = req.body;

        if (!text?.trim()) return res.status(400).json({ error: 'Text content required' });

        const deck = await slidesStore.getDeck(deckId, userId);
        if (!deck) return res.status(404).json({ error: 'Deck not found' });

        const source = await slidesStore.addSource({
            deckId,
            type: 'text',
            name: name || 'Pasted text',
            wordCount: text.split(/\s+/).length,
        });

        ingestTextSource(deckId, source.id, userId, text, name).catch(err => {
            console.error(`[Slides] Text ingestion failed:`, err.message);
        });

        res.json(source);
    } catch (err) {
        console.error('[Slides] Text source failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Add meeting notes source
router.post('/:id/sources/meeting', requireAuth, async (req, res) => {
    try {
        const deckId = req.params.id;
        const userId = req.session.user.id;
        const { meetingId, content, title } = req.body;

        if (!content?.trim()) return res.status(400).json({ error: 'Meeting content required' });

        const deck = await slidesStore.getDeck(deckId, userId);
        if (!deck) return res.status(404).json({ error: 'Deck not found' });

        const source = await slidesStore.addSource({
            deckId,
            type: 'meeting',
            name: title || 'Meeting Notes',
            metadata: { meetingId },
            wordCount: content.split(/\s+/).length,
        });

        ingestTextSource(deckId, source.id, userId, content, title || 'Meeting Notes').catch(err => {
            console.error(`[Slides] Meeting ingestion failed:`, err.message);
        });

        res.json(source);
    } catch (err) {
        console.error('[Slides] Meeting source failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Import from Drive
router.post('/:id/sources/drive', requireAuth, async (req, res) => {
    try {
        const deckId = req.params.id;
        const userId = req.session.user.id;
        const { content, fileName, mimeType } = req.body;

        if (!content?.trim()) return res.status(400).json({ error: 'Content required' });

        const deck = await slidesStore.getDeck(deckId, userId);
        if (!deck) return res.status(404).json({ error: 'Deck not found' });

        const source = await slidesStore.addSource({
            deckId,
            type: 'gdrive',
            name: fileName || 'Google Drive Import',
            wordCount: content.split(/\s+/).length,
        });

        ingestDriveSource(deckId, source.id, userId, content, fileName).catch(err => {
            console.error(`[Slides] Drive ingestion failed:`, err.message);
        });

        res.json(source);
    } catch (err) {
        console.error('[Slides] Drive source failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// List sources
router.get('/:id/sources', requireAuth, async (req, res) => {
    try {
        const deck = await slidesStore.getDeck(req.params.id, req.session.user.id);
        if (!deck) return res.status(404).json({ error: 'Deck not found' });
        const sources = await slidesStore.getSources(req.params.id);
        res.json(sources);
    } catch (err) {
        console.error('[Slides] List sources failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Delete source
router.delete('/:id/sources/:sid', requireAuth, async (req, res) => {
    try {
        const deck = await slidesStore.getDeck(req.params.id, req.session.user.id);
        if (!deck) return res.status(404).json({ error: 'Deck not found' });

        const source = await slidesStore.getSource(req.params.sid);
        if (!source) return res.status(404).json({ error: 'Source not found' });

        // Clean up from KB
        try {
            if (deck.knowledgeBaseIds?.length > 0) {
                const kbStore = require('../stores/knowledgeBases');
                for (const kbId of deck.knowledgeBaseIds) {
                    try { await kbStore.deleteDocumentChunks(kbId, req.params.sid); } catch (e) { }
                }
            }
        } catch (e) { }

        await slidesStore.deleteSource(req.params.sid);
        res.json({ success: true });
    } catch (err) {
        console.error('[Slides] Delete source failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Versions ────────────────────────────────────────────────────

// List versions
router.get('/:id/versions', requireAuth, async (req, res) => {
    try {
        const deck = await slidesStore.getDeck(req.params.id, req.session.user.id);
        if (!deck) return res.status(404).json({ error: 'Deck not found' });
        const versions = await slidesStore.getVersions(req.params.id);
        res.json(versions);
    } catch (err) {
        console.error('[Slides] List versions failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get a specific version
router.get('/:id/versions/:vid', requireAuth, async (req, res) => {
    try {
        const version = await slidesStore.getVersion(req.params.vid);
        if (!version) return res.status(404).json({ error: 'Version not found' });
        res.json(version);
    } catch (err) {
        console.error('[Slides] Get version failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Create manual version (snapshot)
router.post('/:id/versions', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const deck = await slidesStore.getDeck(req.params.id, userId);
        if (!deck) return res.status(404).json({ error: 'Deck not found' });

        const version = await slidesStore.createVersion(
            req.params.id,
            deck.slidesContent,
            req.body.summary || 'Manual snapshot'
        );
        res.json(version);
    } catch (err) {
        console.error('[Slides] Create version failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── AI Generation (SSE) ────────────────────────────────────────

router.post('/:id/generate/:type', requireAuth, async (req, res) => {
    const deckId = req.params.id;
    const genType = req.params.type; // full_presentation, single_slide, outline, speaker_notes
    const userId = req.session.user.id;

    try {
        const deck = await slidesStore.getDeck(deckId, userId);
        if (!deck) return res.status(404).json({ error: 'Deck not found' });

        const sources = await slidesStore.getSources(deckId);
        const readySources = sources.filter(s => s.status === 'ready');

        // Set SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        const send = (event, data) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        send('status', { message: `Generating ${genType.replace(/_/g, ' ')}...` });

        // Get AI config
        const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
        const { getAdapter } = require('../core/providers');
        const configStore = require('../stores/configStore');

        let tiers = await configStore.getConfig('chat_model_tiers') || {};
        const tier = tiers['smart'] || tiers['fast'] || {};
        let modelId = tier.modelId;

        if (!modelId) {
            const config = await getAIConfig();
            modelId = config.model;
        }

        if (!modelId) {
            send('error', { error: 'No AI model configured.' });
            res.end();
            return;
        }

        const config = await getProviderForModel(modelId);
        const adapter = getAdapter(config.providerType, (config.url || '').replace(/\/+$/, ''));
        const apiKey = config.apiKey;
        const apiUrl = (config.url || '').replace(/\/+$/, '');

        // Build source context
        let sourceContext = '';
        if (readySources.length > 0) {
            // Search KB for content
            const { searchNotebookKB } = require('../core/notebookKnowledgeSearch');
            const kbIds = deck.knowledgeBaseIds || [];
            if (kbIds.length > 0) {
                try {
                    const topicPrompt = req.body.prompt || deck.name;
                    const kbResult = await searchNotebookKB({
                        userId, kbIds, query: topicPrompt,
                        options: { topK: 15, rerank: true, minScore: 0.1 },
                    });
                    if (kbResult.contextPrompt) {
                        sourceContext = kbResult.contextPrompt;
                    }
                } catch (e) {
                    console.warn('[Slides] KB search for generation failed:', e.message);
                }
            }
        }

        // Build generation prompt
        const theme = deck.settings?.theme || 'corporate';
        const prompt = req.body.prompt || '';
        const currentSlides = JSON.stringify(deck.slidesContent || [], null, 2);

        let systemPrompt = `You are an expert presentation designer. Generate professional, visually compelling slide content.

IMPORTANT: Your response must be a valid JSON array of slide objects. Do NOT wrap in markdown code fences.

Each slide object has this structure:
{
  "id": "unique-id",
  "layout": "title" | "content" | "two-column" | "image-full" | "section" | "blank",
  "elements": [
    {
      "id": "unique-id",
      "type": "heading" | "text" | "list" | "code" | "image",
      "content": "The text or HTML content",
      "position": { "x": 10, "y": 15, "width": 80, "height": 20 },
      "style": { "fontSize": "32px", "fontWeight": "bold", "textAlign": "center", "color": "#333" }
    }
  ],
  "notes": "Speaker notes for this slide",
  "background": null,
  "transition": "fade"
}

LAYOUT GUIDELINES:
- "title": Large centered heading (y:25-35) + subtitle below (y:55-65). Use for first and section divider slides.
- "content": Heading at top (y:8, height:12) + body content below (y:22, height:65).
- "two-column": Heading at top + two content areas side by side (left: x:5,width:42 / right: x:52,width:42).
- "section": Single large text, centered. Use between major topics.
- "blank": Flexible positioning — use for custom layouts.

CONTENT RULES:
- For "list" type elements, use HTML: "<ul><li>Point one</li><li>Point two</li></ul>"
- Keep text concise — max 6 bullet points per slide, max 8 words per bullet
- Use a mix of layouts for visual variety
- Always include speaker notes with talking points
- Include a title slide first and a summary/thank-you slide last

Current theme: "${theme}"
${sourceContext ? `\n\nSOURCE MATERIAL:\n${sourceContext}` : ''}`;

        let userPrompt;

        if (genType === 'full_presentation') {
            userPrompt = `Generate a complete presentation (8-12 slides) about: ${prompt || deck.name}\n\nReturn ONLY a JSON array of slide objects.`;
        } else if (genType === 'single_slide') {
            userPrompt = `Generate a single slide about: ${prompt}\n\nCurrent deck has ${(deck.slidesContent || []).length} slides.\nReturn a JSON array with exactly 1 slide object.`;
        } else if (genType === 'outline') {
            userPrompt = `Generate a presentation outline (slide titles and key points only) for: ${prompt || deck.name}\n\nReturn a JSON array where each slide has a heading element and a brief text or list element. Keep it to 8-12 slides.`;
        } else if (genType === 'speaker_notes') {
            userPrompt = `Generate detailed speaker notes for each slide in this deck:\n\n${currentSlides}\n\nReturn the same JSON array but with updated "notes" fields containing detailed talking points (2-4 sentences each).`;
        } else {
            userPrompt = `${prompt}\n\nReturn ONLY a JSON array of slide objects.`;
        }

        // Stream the response
        let fullContent = '';
        const streamCallback = (type, data) => {
            if (type === 'text') {
                fullContent += data.text;
                send('content', { text: data.text });
            } else if (type === 'thinking') {
                send('thinking', { text: data.text });
            }
        };

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];

        await adapter.stream(apiKey, apiUrl, modelId, messages, {
            maxTokens: 8192,
            temperature: 0.7,
        }, streamCallback);

        // Try to parse the result
        try {
            // Strip markdown code fences if present
            let jsonStr = fullContent.trim();
            jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

            const slides = JSON.parse(jsonStr);
            if (Array.isArray(slides)) {
                send('slides_generated', { slides, type: genType });
            }
        } catch (parseErr) {
            console.warn('[Slides] Failed to parse generated slides JSON:', parseErr.message);
            send('parse_warning', { message: 'Generated content may need manual review.' });
        }

        send('done', {});
        res.end();
    } catch (err) {
        console.error('[Slides] Generation error:', err);
        try {
            res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
            res.end();
        } catch (e) {
            res.status(500).json({ error: err.message });
        }
    }
});

// ─── Upload images for slides ────────────────────────────────────

router.post('/:id/images', requireAuth, upload.single('image'), async (req, res) => {
    try {
        const deckId = req.params.id;
        const userId = req.session.user.id;

        const deck = await slidesStore.getDeck(deckId, userId);
        if (!deck) return res.status(404).json({ error: 'Deck not found' });

        const file = req.file;
        if (!file) return res.status(400).json({ error: 'No image uploaded' });

        // Store via RustFS if available, otherwise base64
        try {
            const { uploadBuffer } = require('../core/rustfs');
            const key = `slides/${deckId}/${Date.now()}_${file.originalname}`;
            const url = await uploadBuffer(file.buffer, key, file.mimetype);
            res.json({ url });
        } catch (e) {
            // Fallback to base64 data URI
            const base64 = file.buffer.toString('base64');
            const dataUri = `data:${file.mimetype};base64,${base64}`;
            res.json({ url: dataUri });
        }
    } catch (err) {
        console.error('[Slides] Image upload failed:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
