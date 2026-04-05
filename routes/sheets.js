/**
 * Sheets API Routes — CRUD for spreadsheets, sources, versions, and AI generation.
 * Mirrors routes/slides.js / routes/notebooks.js architecture.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const sheetStore = require('../stores/sheetStore');
const { ingestFileSource, ingestUrlSource, ingestTextSource, ingestDriveSource } = require('../agents/sheets/sourceIngestion');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ─── Spreadsheet CRUD ────────────────────────────────────────────

// Create spreadsheet
router.post('/', requireAuth, async (req, res) => {
    try {
        const { name, description } = req.body;
        const spreadsheet = await sheetStore.createSpreadsheet(req.session.user.id, name, description);
        res.json({ spreadsheet });
    } catch (err) {
        console.error('[Sheets] Create failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// List spreadsheets
router.get('/', requireAuth, async (req, res) => {
    try {
        const spreadsheets = await sheetStore.getSpreadsheets(req.session.user.id);
        res.json({ spreadsheets });
    } catch (err) {
        console.error('[Sheets] List failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get spreadsheet with sources
router.get('/:id', requireAuth, async (req, res) => {
    try {
        const spreadsheet = await sheetStore.getSpreadsheet(req.params.id, req.session.user.id);
        if (!spreadsheet) return res.status(404).json({ error: 'Spreadsheet not found' });
        const sources = await sheetStore.getSources(req.params.id);
        res.json({ spreadsheet, sources });
    } catch (err) {
        console.error('[Sheets] Get failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Update spreadsheet
router.put('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const spreadsheetId = req.params.id;

        // Auto-version before updating sheets content
        if (req.body.sheetsContent || req.body.sheets_content) {
            try {
                const shouldVersion = await sheetStore.shouldAutoVersion(spreadsheetId);
                if (shouldVersion) {
                    const current = await sheetStore.getSpreadsheet(spreadsheetId, userId);
                    if (current && current.sheetsContent && current.sheetsContent.length > 0) {
                        await sheetStore.createVersion(spreadsheetId, current.sheetsContent, 'Auto-save');
                    }
                }
            } catch (vErr) {
                console.warn('[Sheets] Auto-version failed:', vErr.message);
            }
        }

        // Normalize camelCase to snake_case for the store
        const updates = {};
        if (req.body.name !== undefined) updates.name = req.body.name;
        if (req.body.description !== undefined) updates.description = req.body.description;
        if (req.body.instructions !== undefined) updates.instructions = req.body.instructions;
        if (req.body.knowledgeBaseIds !== undefined) updates.knowledge_base_ids = req.body.knowledgeBaseIds;
        if (req.body.settings !== undefined) updates.settings = req.body.settings;
        if (req.body.sheetsContent !== undefined) updates.sheets_content = req.body.sheetsContent;
        if (req.body.sheets_content !== undefined) updates.sheets_content = req.body.sheets_content;

        const spreadsheet = await sheetStore.updateSpreadsheet(spreadsheetId, userId, updates);
        if (!spreadsheet) return res.status(404).json({ error: 'Spreadsheet not found' });
        res.json({ spreadsheet });
    } catch (err) {
        console.error('[Sheets] Update failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Delete spreadsheet
router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const spreadsheetId = req.params.id;

        // Clean up associated KB
        try {
            const sheet = await sheetStore.getSpreadsheet(spreadsheetId, userId);
            if (sheet?.knowledgeBaseIds?.length > 0) {
                const kbStore = require('../stores/knowledgeBases');
                for (const kbId of sheet.knowledgeBaseIds) {
                    try { await kbStore.deleteKB(kbId, userId); } catch (e) { }
                }
            }
        } catch (e) { }

        const deleted = await sheetStore.deleteSpreadsheet(spreadsheetId, userId);
        if (!deleted) return res.status(404).json({ error: 'Spreadsheet not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Sheets] Delete failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Sources ─────────────────────────────────────────────────────

// Upload file source
router.post('/:id/sources/file', requireAuth, upload.single('file'), async (req, res) => {
    try {
        const spreadsheetId = req.params.id;
        const userId = req.session.user.id;

        const sheet = await sheetStore.getSpreadsheet(spreadsheetId, userId);
        if (!sheet) return res.status(404).json({ error: 'Spreadsheet not found' });

        const file = req.file;
        if (!file) return res.status(400).json({ error: 'No file uploaded' });

        const source = await sheetStore.addSource({
            spreadsheetId,
            type: 'file',
            name: file.originalname,
            fileName: file.originalname,
            wordCount: 0,
        });

        // Background ingestion
        ingestFileSource(spreadsheetId, source.id, userId, file.buffer, file.originalname, file.mimetype).catch(err => {
            console.error(`[Sheets] File ingestion failed:`, err.message);
        });

        res.json(source);
    } catch (err) {
        console.error('[Sheets] File upload failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Add URL source
router.post('/:id/sources/url', requireAuth, async (req, res) => {
    try {
        const spreadsheetId = req.params.id;
        const userId = req.session.user.id;
        const { url } = req.body;

        if (!url) return res.status(400).json({ error: 'URL required' });

        const sheet = await sheetStore.getSpreadsheet(spreadsheetId, userId);
        if (!sheet) return res.status(404).json({ error: 'Spreadsheet not found' });

        const source = await sheetStore.addSource({
            spreadsheetId,
            type: 'url',
            name: url,
            metadata: { url },
        });

        ingestUrlSource(spreadsheetId, source.id, userId, url).catch(err => {
            console.error(`[Sheets] URL ingestion failed:`, err.message);
        });

        res.json(source);
    } catch (err) {
        console.error('[Sheets] URL source failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Add text source
router.post('/:id/sources/text', requireAuth, async (req, res) => {
    try {
        const spreadsheetId = req.params.id;
        const userId = req.session.user.id;
        const { text, name } = req.body;

        if (!text?.trim()) return res.status(400).json({ error: 'Text content required' });

        const sheet = await sheetStore.getSpreadsheet(spreadsheetId, userId);
        if (!sheet) return res.status(404).json({ error: 'Spreadsheet not found' });

        const source = await sheetStore.addSource({
            spreadsheetId,
            type: 'text',
            name: name || 'Pasted text',
            wordCount: text.split(/\s+/).length,
        });

        ingestTextSource(spreadsheetId, source.id, userId, text, name).catch(err => {
            console.error(`[Sheets] Text ingestion failed:`, err.message);
        });

        res.json(source);
    } catch (err) {
        console.error('[Sheets] Text source failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Add meeting notes source
router.post('/:id/sources/meeting', requireAuth, async (req, res) => {
    try {
        const spreadsheetId = req.params.id;
        const userId = req.session.user.id;
        const { meetingId, content, title } = req.body;

        if (!content?.trim()) return res.status(400).json({ error: 'Meeting content required' });

        const sheet = await sheetStore.getSpreadsheet(spreadsheetId, userId);
        if (!sheet) return res.status(404).json({ error: 'Spreadsheet not found' });

        const source = await sheetStore.addSource({
            spreadsheetId,
            type: 'meeting',
            name: title || 'Meeting Notes',
            metadata: { meetingId },
            wordCount: content.split(/\s+/).length,
        });

        ingestTextSource(spreadsheetId, source.id, userId, content, title || 'Meeting Notes').catch(err => {
            console.error(`[Sheets] Meeting ingestion failed:`, err.message);
        });

        res.json(source);
    } catch (err) {
        console.error('[Sheets] Meeting source failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Import from Drive
router.post('/:id/sources/drive', requireAuth, async (req, res) => {
    try {
        const spreadsheetId = req.params.id;
        const userId = req.session.user.id;
        const { content, fileName, mimeType } = req.body;

        if (!content?.trim()) return res.status(400).json({ error: 'Content required' });

        const sheet = await sheetStore.getSpreadsheet(spreadsheetId, userId);
        if (!sheet) return res.status(404).json({ error: 'Spreadsheet not found' });

        const source = await sheetStore.addSource({
            spreadsheetId,
            type: 'gdrive',
            name: fileName || 'Google Drive Import',
            wordCount: content.split(/\s+/).length,
        });

        ingestDriveSource(spreadsheetId, source.id, userId, content, fileName).catch(err => {
            console.error(`[Sheets] Drive ingestion failed:`, err.message);
        });

        res.json(source);
    } catch (err) {
        console.error('[Sheets] Drive source failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// List sources
router.get('/:id/sources', requireAuth, async (req, res) => {
    try {
        const sheet = await sheetStore.getSpreadsheet(req.params.id, req.session.user.id);
        if (!sheet) return res.status(404).json({ error: 'Spreadsheet not found' });
        const sources = await sheetStore.getSources(req.params.id);
        res.json({ sources });
    } catch (err) {
        console.error('[Sheets] List sources failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Delete source
router.delete('/:id/sources/:sid', requireAuth, async (req, res) => {
    try {
        const sheet = await sheetStore.getSpreadsheet(req.params.id, req.session.user.id);
        if (!sheet) return res.status(404).json({ error: 'Spreadsheet not found' });

        const source = await sheetStore.getSource(req.params.sid);
        if (!source) return res.status(404).json({ error: 'Source not found' });

        // Clean up from KB
        try {
            if (sheet.knowledgeBaseIds?.length > 0) {
                const kbStore = require('../stores/knowledgeBases');
                for (const kbId of sheet.knowledgeBaseIds) {
                    try { await kbStore.deleteDocumentChunks(kbId, req.params.sid); } catch (e) { }
                }
            }
        } catch (e) { }

        await sheetStore.deleteSource(req.params.sid);
        res.json({ success: true });
    } catch (err) {
        console.error('[Sheets] Delete source failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Versions ────────────────────────────────────────────────────

// List versions
router.get('/:id/versions', requireAuth, async (req, res) => {
    try {
        const sheet = await sheetStore.getSpreadsheet(req.params.id, req.session.user.id);
        if (!sheet) return res.status(404).json({ error: 'Spreadsheet not found' });
        const versions = await sheetStore.getVersions(req.params.id);
        res.json({ versions });
    } catch (err) {
        console.error('[Sheets] List versions failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get a specific version
router.get('/:id/versions/:vid', requireAuth, async (req, res) => {
    try {
        const version = await sheetStore.getVersion(req.params.vid);
        if (!version) return res.status(404).json({ error: 'Version not found' });
        res.json({ version });
    } catch (err) {
        console.error('[Sheets] Get version failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Create manual version (snapshot)
router.post('/:id/versions', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const sheet = await sheetStore.getSpreadsheet(req.params.id, userId);
        if (!sheet) return res.status(404).json({ error: 'Spreadsheet not found' });

        const version = await sheetStore.createVersion(
            req.params.id,
            sheet.sheetsContent,
            req.body.summary || 'Manual snapshot'
        );
        res.json({ version });
    } catch (err) {
        console.error('[Sheets] Create version failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── AI Generation (SSE) ────────────────────────────────────────

router.post('/:id/generate/:type', requireAuth, async (req, res) => {
    const spreadsheetId = req.params.id;
    const genType = req.params.type; // fill_data, analyze, clean_data, formula_fill, chart_config
    const userId = req.session.user.id;

    try {
        const sheet = await sheetStore.getSpreadsheet(spreadsheetId, userId);
        if (!sheet) return res.status(404).json({ error: 'Spreadsheet not found' });

        const sources = await sheetStore.getSources(spreadsheetId);
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
            const { searchNotebookKB } = require('../core/notebookKnowledgeSearch');
            const kbIds = sheet.knowledgeBaseIds || [];
            if (kbIds.length > 0) {
                try {
                    const topicPrompt = req.body.prompt || sheet.name;
                    const kbResult = await searchNotebookKB({
                        userId, kbIds, query: topicPrompt,
                        options: { topK: 15, rerank: true, minScore: 0.1 },
                    });
                    if (kbResult.contextPrompt) {
                        sourceContext = kbResult.contextPrompt;
                    }
                } catch (e) {
                    console.warn('[Sheets] KB search for generation failed:', e.message);
                }
            }
        }

        // Current spreadsheet data for context
        const currentData = JSON.stringify(sheet.sheetsContent || [], null, 2);
        const prompt = req.body.prompt || '';

        let systemPrompt = `You are an expert data analyst and spreadsheet specialist. Help the user with their spreadsheet data.

IMPORTANT: Your response must be valid JSON. Do NOT wrap in markdown code fences.

The spreadsheet uses this data format:
{
  "sheets": [
    {
      "id": "unique-id",
      "name": "Sheet 1",
      "cells": { "A1": { "value": "Header", "formula": null, "style": {} } },
      "colWidths": {},
      "rowHeights": {}
    }
  ]
}

Cell reference format: "A1", "B2", etc. (column letter + row number).
Values can be strings, numbers, booleans.
Formulas start with "=" (e.g., "=SUM(A1:A10)", "=AVERAGE(B2:B5)").

${sourceContext ? `\nSOURCE MATERIAL:\n${sourceContext}` : ''}

CURRENT SPREADSHEET DATA:
${currentData}`;

        let userPrompt;

        if (genType === 'fill_data') {
            userPrompt = `Fill the spreadsheet with relevant data based on the sources and this request: ${prompt || sheet.name}\n\nReturn a JSON object with a "cells" key mapping cell references to values:\n{"cells": {"A1": "Header", "A2": "Data", "B1": "Header2", "B2": 42}}`;
        } else if (genType === 'analyze') {
            userPrompt = `Analyze the current spreadsheet data and provide insights. ${prompt}\n\nReturn a JSON object with:\n{"analysis": "Your analysis text", "suggestions": ["suggestion1", "suggestion2"], "cells": {"A1": "optional updated cells"}}`;
        } else if (genType === 'clean_data') {
            userPrompt = `Review the spreadsheet data for quality issues and suggest/apply cleaning operations: ${prompt}\n\nReturn a JSON object with:\n{"issues": ["list of issues found"], "cells": {"A1": "cleaned value"}}`;
        } else if (genType === 'formula_fill') {
            userPrompt = `Generate formulas for the spreadsheet: ${prompt}\n\nReturn a JSON object with formula cells:\n{"cells": {"C2": {"value": null, "formula": "=A2+B2"}}}`;
        } else if (genType === 'chart_config') {
            userPrompt = `Generate a chart/visualization configuration from the spreadsheet data: ${prompt}\n\nReturn a JSON object with:\n{"chartType": "bar|line|pie", "title": "Chart Title", "dataRange": "A1:D10", "xAxis": "A", "series": [{"column": "B", "label": "Series 1"}]}`;
        } else {
            userPrompt = `${prompt}\n\nReturn your response as valid JSON.`;
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
            let jsonStr = fullContent.trim();
            jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

            const result = JSON.parse(jsonStr);
            send('generation_result', { result, type: genType });
        } catch (parseErr) {
            console.warn('[Sheets] Failed to parse generated JSON:', parseErr.message);
            send('parse_warning', { message: 'Generated content may need manual review.' });
        }

        send('done', {});
        res.end();
    } catch (err) {
        console.error('[Sheets] Generation error:', err);
        try {
            res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
            res.end();
        } catch (e) {
            res.status(500).json({ error: err.message });
        }
    }
});

// ─── Upload images for sheets ────────────────────────────────────

router.post('/:id/images', requireAuth, upload.single('image'), async (req, res) => {
    try {
        const spreadsheetId = req.params.id;
        const userId = req.session.user.id;

        const sheet = await sheetStore.getSpreadsheet(spreadsheetId, userId);
        if (!sheet) return res.status(404).json({ error: 'Spreadsheet not found' });

        const file = req.file;
        if (!file) return res.status(400).json({ error: 'No image uploaded' });

        try {
            const { uploadBuffer } = require('../core/rustfs');
            const key = `sheets/${spreadsheetId}/${Date.now()}_${file.originalname}`;
            const url = await uploadBuffer(file.buffer, key, file.mimetype);
            res.json({ url });
        } catch (e) {
            const base64 = file.buffer.toString('base64');
            const dataUri = `data:${file.mimetype};base64,${base64}`;
            res.json({ url: dataUri });
        }
    } catch (err) {
        console.error('[Sheets] Image upload failed:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
