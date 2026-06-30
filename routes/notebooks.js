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
const notebookConversationStore = require('../stores/notebookConversationStore');
const storageStore = require('../stores/storageStore');
const transcriptionStore = require('../stores/transcriptionStore');
const kbStore = require('../stores/knowledgeBases');
const { ingestFileSource, ingestUrlSource, ingestTextSource, ingestDriveSource } = require('../agents/notebooks/sourceIngestion');
const { parseDocument, isSupportedDocument } = require('../core/documentParser');
const { deleteDocumentChunks, findDocumentBySourceUri } = require('../core/kbIngestionHelpers');
const { requirePermission } = require('../auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

function requireAuth(req, res, next) {
    if (req.session?.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// Every notebook route requires the `use_notebooks` permission. Ownership
// isolation is still enforced per-route via the user_id check in notebookStore.
router.use(requirePermission('use_notebooks'));

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

        // Flip any sources that have been "processing" for > 10 min to errored.
        // Protects users from yellow rows stuck forever after a worker crash.
        await notebookStore.timeoutStuckSources(notebook.id).catch(() => {});

        const sources = await notebookStore.getSources(notebook.id);
        res.json({ notebook, sources });
    } catch (err) {
        console.error('[Notebooks] Get failed:', err);
        res.status(500).json({ error: 'Failed to get notebook' });
    }
});

// ── In-notebook chat history (persistent, encrypted) ─────────────────────
// Returns the durable conversation for this notebook (regular or legal_matter)
// so the chat panel can rehydrate on page load / notebook switch instead of
// starting from an empty React state. Ownership is enforced via getNotebook.
router.get('/:id/conversation', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebook = await notebookStore.getNotebook(req.params.id, userId);
        if (!notebook) return res.status(404).json({ error: 'Notebook not found' });
        const encryptionKey = req.session.encryptionKey || null;
        const messages = await notebookConversationStore.getMessages(req.params.id, userId, encryptionKey);
        // Stored assistant content is TOKENIZED (defense-in-depth inside the
        // encrypted blob); restore `[person_1]` → real values for display, using
        // the notebook's persisted PII token map (hydrated from notebooks.pii_token_map).
        // User messages are stored real, so restore is a no-op for them.
        let outMessages = messages;
        try {
            const dlpRunner = require('../core/dlp/dlpRunner');
            const map = await dlpRunner.getConversationTokenMapAsync(req.params.id);
            if (map && Object.keys(map).length) {
                const { restoreTokens } = require('../core/piiDetection');
                outMessages = messages.map(m => (typeof m.content === 'string'
                    ? { ...m, content: restoreTokens(m.content, map) }
                    : m));
            }
        } catch (e) {
            console.warn('[Notebooks] token restore on conversation load failed:', e.message);
        }
        res.json({ messages: outMessages });
    } catch (err) {
        console.error('[Notebooks] Get conversation failed:', err);
        res.status(500).json({ error: 'Failed to load conversation' });
    }
});

// Clear the persisted in-notebook conversation ("new chat" in the panel).
router.delete('/:id/conversation', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebook = await notebookStore.getNotebook(req.params.id, userId);
        if (!notebook) return res.status(404).json({ error: 'Notebook not found' });
        await notebookConversationStore.deleteForNotebook(req.params.id, userId);
        // Drop the accumulated PII token map too, so a fresh chat doesn't inherit
        // stale `[person_1]` → value mappings from the cleared conversation.
        try { require('../core/dlp/dlpRunner').clearConversationState(req.params.id); } catch (_) { /* best-effort */ }
        res.json({ success: true });
    } catch (err) {
        console.error('[Notebooks] Clear conversation failed:', err);
        res.status(500).json({ error: 'Failed to clear conversation' });
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

        // Drop the persisted in-notebook conversation so a deleted notebook
        // leaves no orphaned chat history.
        try { await notebookConversationStore.deleteForNotebook(req.params.id); } catch (e) {
            console.warn('[Notebooks] Conversation cleanup failed:', e.message);
        }
        // Drop the in-process PII token map (the row's pii_token_map goes away with
        // the cascading notebook delete; this clears the cached copy + flag).
        try { require('../core/dlp/dlpRunner').clearConversationState(req.params.id); } catch (_) { /* best-effort */ }

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
        const { meetingId, mode } = req.body;
        if (!meetingId) return res.status(400).json({ error: 'Meeting ID required' });
        const ingestMode = mode === 'summary' ? 'summary' : 'full';

        const nb = await notebookStore.getNotebook(notebookId, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const meeting = await transcriptionStore.getTranscription(meetingId, userId);
        if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

        const fullTranscript = meeting.fullText || meeting.transcript || meeting.transcription || '';
        const summaryText = meeting.summary || '';
        // Prefer the requested mode; fall back to whichever is populated.
        const sourceText = ingestMode === 'summary'
            ? (summaryText.trim() ? summaryText : fullTranscript)
            : (fullTranscript.trim() ? fullTranscript : summaryText);

        const modeLabel = ingestMode === 'summary' && summaryText.trim() ? ' (summary)' : '';
        const sourceName = `Meeting Note: ${meeting.title || 'Untitled Meeting'}${modeLabel}`;

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

        await notebookStore.timeoutStuckSources(nb.id).catch(() => {});
        const sources = await notebookStore.getSources(nb.id);
        res.json({ sources });
    } catch (err) {
        console.error('[Notebooks] List sources failed:', err);
        res.status(500).json({ error: 'Failed to list sources' });
    }
});

// ── Retry Source Ingestion ──────────────────────────────────────
// Re-runs ingestion for a failed or cancelled source without re-uploading.
// Only makes sense for source types whose raw content is recoverable:
//   - file: we fetch the buffer back from storageStore
//   - url:  we re-fetch from the saved URL
// text / gdrive / onedrive sources don't retain original content server-side,
// so retry is refused with a 422 and the UI falls back to re-adding the source.

router.post('/:id/sources/:sid/retry', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const source = await notebookStore.getSource(req.params.sid);
        if (!source || source.notebookId !== nb.id) return res.status(404).json({ error: 'Source not found' });

        // Reset state so the UI immediately shows the spinner.
        await notebookStore.updateSource(source.id, { status: 'processing', stage: 'queued', error: null });
        res.json({ success: true });

        // Dispatch retry in the background so the HTTP request doesn't stall.
        (async () => {
            try {
                if (source.type === 'url') {
                    const url = source.metadata?.url;
                    if (!url) throw new Error('Source has no URL to retry');
                    await ingestUrlSource(nb.id, source.id, userId, url);
                } else if (source.storageKey) {
                    // File source — re-fetch bytes from storage, re-ingest.
                    if (!storageStore.isAvailable()) throw new Error('Storage not configured');
                    const { stream } = await storageStore.streamFile(source.storageKey);
                    const chunks = [];
                    for await (const chunk of stream) chunks.push(chunk);
                    const buffer = Buffer.concat(chunks);
                    const mimeType = source.metadata?.mimeType || 'application/octet-stream';
                    await ingestFileSource(nb.id, source.id, userId, buffer, source.fileName || source.name, mimeType);
                } else {
                    // Text / meeting / drive sources now keep their extracted text,
                    // so retry re-ingests from the stored copy.
                    const stored = await notebookStore.getSourceContent(source.id);
                    if (stored && stored.trim()) {
                        await ingestTextSource(nb.id, source.id, userId, stored, source.name);
                    } else {
                        throw new Error('This source type cannot be retried — please re-add it.');
                    }
                }
            } catch (e) {
                console.error(`[Notebooks] Retry failed for source ${source.id}:`, e.message);
                await notebookStore.updateSource(source.id, { status: 'error', error: e.message }).catch(() => {});
            }
        })();
    } catch (err) {
        console.error('[Notebooks] Retry source route failed:', err);
        res.status(500).json({ error: 'Failed to retry source' });
    }
});

// ── Cancel / Dismiss Stuck Source ───────────────────────────────
// Flips a processing or error source to a terminal state without deleting.
// Useful when a worker silently died and the row is stuck yellow — the user
// can dismiss without losing the uploaded bytes (retry remains available).

router.post('/:id/sources/:sid/cancel', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const source = await notebookStore.getSource(req.params.sid);
        if (!source || source.notebookId !== nb.id) return res.status(404).json({ error: 'Source not found' });

        await notebookStore.updateSource(source.id, {
            status: 'error',
            stage: 'error',
            error: 'Cancelled by user',
        });
        res.json({ success: true });
    } catch (err) {
        console.error('[Notebooks] Cancel source failed:', err);
        res.status(500).json({ error: 'Failed to cancel source' });
    }
});

// Shared cleanup for a deleted source: storage bytes + KB document chunks.
async function cleanupSourceArtifacts(nb, source, userId) {
    if (source.storageKey) {
        try {
            if (!source.storageKey.startsWith('local:')) await storageStore.deleteFile(source.storageKey);
        } catch (e) { console.warn('[Notebooks] Storage cleanup:', e.message); }
    }
    const kbIds = nb.knowledgeBaseIds || [];
    for (const kbId of kbIds) {
        try {
            const doc = await findDocumentBySourceUri(kbId, source.id);
            if (doc) await deleteDocumentChunks(kbId, doc.id, userId);
        } catch (e) { console.warn(`[Notebooks] KB chunk cleanup for source ${source.id}:`, e.message); }
    }
}

// ── Source content (preview) ────────────────────────────────────
router.get('/:id/sources/:sid/content', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });
        const source = await notebookStore.getSource(req.params.sid);
        if (!source || source.notebookId !== nb.id) return res.status(404).json({ error: 'Source not found' });
        const content = await notebookStore.getSourceContent(source.id);
        res.json({ content: content || '', name: source.name, type: source.type });
    } catch (err) {
        console.error('[Notebooks] Get source content failed:', err);
        res.status(500).json({ error: 'Failed to load source content' });
    }
});

// ── Reorder sources (must precede the /:sid rename route) ────────
router.patch('/:id/sources/reorder', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });
        const { orderedIds } = req.body || {};
        if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds must be an array' });
        await notebookStore.reorderSources(nb.id, orderedIds);
        res.json({ success: true });
    } catch (err) {
        console.error('[Notebooks] Reorder sources failed:', err);
        res.status(500).json({ error: 'Failed to reorder sources' });
    }
});

// ── Rename a source ─────────────────────────────────────────────
router.patch('/:id/sources/:sid', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });
        const source = await notebookStore.getSource(req.params.sid);
        if (!source || source.notebookId !== nb.id) return res.status(404).json({ error: 'Source not found' });
        const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!name) return res.status(400).json({ error: 'Name is required' });
        await notebookStore.updateSource(source.id, { name });
        res.json({ success: true, name });
    } catch (err) {
        console.error('[Notebooks] Rename source failed:', err);
        res.status(500).json({ error: 'Failed to rename source' });
    }
});

// ── Bulk delete sources ─────────────────────────────────────────
router.post('/:id/sources/bulk-delete', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });
        const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
        let deleted = 0;
        for (const sid of ids) {
            const source = await notebookStore.deleteSource(sid);
            if (source && source.notebookId === nb.id) { await cleanupSourceArtifacts(nb, source, userId); deleted++; }
        }
        res.json({ success: true, deleted });
    } catch (err) {
        console.error('[Notebooks] Bulk delete sources failed:', err);
        res.status(500).json({ error: 'Failed to delete sources' });
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

        await cleanupSourceArtifacts(nb, source, userId);
        res.json({ success: true });
    } catch (err) {
        console.error('[Notebooks] Delete source failed:', err);
        res.status(500).json({ error: 'Failed to delete source' });
    }
});

// ── Studio: Generate Content (FAQ / Summary / Study Guide) ──────

// Studio generation types. The study-aid / podcast gimmicks were removed
// so older clients calling those types fail loud instead of wasting an LLM
// round-trip for a result nothing renders nicely anymore.
const VALID_GEN_TYPES = new Set([
    'summary', 'briefing_doc', 'blog_post', 'faq',
    'mind_map', 'data_table',
]);
const REMOVED_GEN_TYPES = new Set(['studyGuide', 'flashcards', 'quiz', 'audio_overview']);

// ── Legal Studio generators (only for notebooks of type 'legal_matter') ──
const VALID_LEGAL_GEN_TYPES = new Set([
    'juridisch_advies', 'dagvaarding', 'conclusie_van_antwoord', 'pleitnota', 'verzoekschrift',
    'bezwaar_beroep', 'sommatie', 'vaststellingsovereenkomst', 'processtuk_analyse', 'chronologie', 'issue_list',
]);
// Formal court documents — these honour the per-matter strict citation mode.
const LEGAL_PROCESSTUK_TYPES = new Set(['dagvaarding', 'conclusie_van_antwoord', 'pleitnota', 'verzoekschrift', 'bezwaar_beroep']);

const _legalPromptCache = {};
function getLegalGenPrompt(type) {
    if (_legalPromptCache[type] === undefined) {
        try { _legalPromptCache[type] = require('fs').readFileSync(require('path').join(__dirname, `../prompts/legal-${type}.md`), 'utf-8'); }
        catch (e) { _legalPromptCache[type] = null; }
    }
    return _legalPromptCache[type];
}

function buildLegalGenSystemPrompt(docPrompt, sourceMaterial, today, nb) {
    const legal = (nb.settings && nb.settings.legal) || {};
    const meta = [
        legal.clientName ? `Cliënt: ${legal.clientName}` : null,
        legal.wederpartij ? `Wederpartij: ${legal.wederpartij}` : null,
        legal.rechtsgebied ? `Rechtsgebied: ${legal.rechtsgebied}` : null,
        legal.zaaknummer ? `Zaaknummer: ${legal.zaaknummer}` : null,
    ].filter(Boolean).join(' · ');
    return `Je bent een ervaren Nederlandse jurist die een juridisch document opstelt. Vandaag is ${today}.
${meta ? `\n[DOSSIER] ${meta}\n` : ''}
${docPrompt}

KRITIEKE REGELS:
- Schrijf in correct, formeel Nederlands.
- Baseer je UITSLUITEND op het onderstaande [BRONMATERIAAL] (dossierstukken + geconsolideerde wetgeving). Gebruik geen feiten van buiten deze bronnen.
- Verzin NOOIT een ECLI, CELEX-nummer of zaaknummer. Noem alleen vindplaatsen die in het bronmateriaal staan of die je zeker weet uit de aangeleverde stukken. Bij twijfel: laat de verwijzing weg of markeer haar als "[vindplaats nog te verifiëren]".
- Verwijs naar jurisprudentie met het volledige ECLI en, waar mogelijk, de rechtsoverweging (r.o.); naar wetgeving met het concrete artikel (bv. "art. 6:162 BW"); naar EU-recht met het CELEX-nummer. Deze worden automatisch omgezet in klikbare links.
- Onderscheid duidelijk de feiten, het juridisch kader en jouw analyse/standpunt.
- Sluit het document af met de zin: "AI-gegenereerd — controleer bronnen en juistheid zelf voordat u hierop handelt."

OPMAAK:
- Lever het document in Markdown met heldere kopjes en opsommingen. Compacte, professionele stijl; geen overbodige inleidingen of dubbele witregels.
- Het document wordt op A4 gepagineerd, dus schrijf ruimte-efficiënt.

[BRONMATERIAAL]
${sourceMaterial.slice(0, 50000)}`;
}

router.post('/:id/generate/:type', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebookId = req.params.id;
        const type = req.params.type;
        const { modelTier, timezone } = req.body;

        if (REMOVED_GEN_TYPES.has(type)) {
            return res.status(400).json({
                error: `Generation type "${type}" was removed. Use Executive Summary, Briefing Doc, FAQ, Mind Map, or Data Table instead.`,
                code: 'generation_type_removed',
            });
        }

        const nb = await notebookStore.getNotebook(notebookId, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        // Legal matters get the Dutch legal document generators; plain notebooks
        // get the existing content types.
        const isLegal = nb.type === 'legal_matter';
        const validTypes = isLegal ? VALID_LEGAL_GEN_TYPES : VALID_GEN_TYPES;
        if (!validTypes.has(type)) {
            return res.status(400).json({ error: `Unknown generation type "${type}"`, code: 'generation_type_unknown' });
        }

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

        // Type-specific prompts. Only the types in VALID_GEN_TYPES reach here —
        // the check above rejects everything else.
        const typePrompts = {
            faq: `Generate a focused FAQ (Frequently Asked Questions) document based on the source material below.
Format as a well-structured markdown document with clear Q&A pairs grouped by topic. Keep answers concise (2-3 sentences each).`,
            summary: `Generate an executive summary based on the source material below. Include Key Findings and Conclusions.`,
            briefing_doc: `Generate a Briefing Document based on the source material below. Include an Executive Summary, Key Analysis, and Recommendations. Write concisely — prioritize substance over volume.`,
            blog_post: `Draft an engaging, well-written Blog Post based on the core themes of the source material. Use a catchy title, headings, and an accessible tone.`,
            mind_map: `Extract the core concepts from the source material and generate a Mermaid.js mind map visualization.
Wrap your output in \`\`\`mermaid ... \`\`\` tags. Focus on hierarchical relationships between the main topics.`,
            data_table: `Extract the most important quantitative data, comparisons, or structured information from the source material and present it as a Markdown table.`,
        };

        const prompt = isLegal
            ? (getLegalGenPrompt(type) || `Stel een juridisch document op van het type "${type}".`)
            : (typePrompts[type] || typePrompts.summary);

        // Resolve model
        const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
        const { resolveModelForTier, getEUAwareTiers } = require('../core/modelResolver');
        const { getAdapter } = require('../core/providers');

        // Resolve user's org for EU-mode tier overrides
        let userOrgId = null;
        try {
            const { resolveUserOrgIds } = require('../auth');
            const orgIds = await resolveUserOrgIds(req);
            if (orgIds && orgIds.size > 0) userOrgId = Array.from(orgIds)[0];
            if (!userOrgId) {
                const userStore = require('../stores/userStore');
                const dbUser = await userStore.getUser(userId);
                if (dbUser?.organizationId) userOrgId = dbUser.organizationId;
            }
        } catch (_) {}

        let resolvedTier = modelTier || 'balanced';

        // Auto mode: classify using the generation type as a pseudo-message
        if (resolvedTier === 'auto') {
            try {
                const tiers = await getEUAwareTiers({ userOrgId, userId });
                const { classifyWithLLM } = require('../core/promptClassifier');
                const pseudoMessage = `Generate a comprehensive ${type.replace(/([A-Z])/g, ' $1').toLowerCase()} from my notebook sources`;
                const result = await classifyWithLLM(pseudoMessage, tiers, { userOrgId, userId });
                resolvedTier = result.tier;
                console.log(`[Notebooks] Auto: tier="${resolvedTier}" (${result.method}: ${result.reason}) for ${type}`);
            } catch (err) {
                console.log(`[Notebooks] Auto classification failed: ${err.message}, using balanced`);
                resolvedTier = 'balanced';
            }
        }

        let modelId = await resolveModelForTier(`tier:${resolvedTier}`, { userOrgId, userId, fallbackTier: 'fast' });
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
        const systemPrompt = isLegal ? buildLegalGenSystemPrompt(prompt, allContent, today, nb) : `You are an expert content generator. Today is ${today}.

${prompt}

CRITICAL RULES:
- You MUST generate content ONLY based on the source material provided below.
- Do NOT use your own knowledge or training data — ONLY use the information in [SOURCE MATERIAL].
- If the source material doesn't contain enough information, generate what you can from it and note any gaps.
- All questions, answers, facts and claims must be directly traceable to the source text below.
- Cite sources using [Source Name] notation when referencing specific information.

MERMAID DIAGRAMS:
- When it adds value (e.g. architecture overviews, process flows, timelines, relationships), include Mermaid.js diagrams using fenced code blocks:
  \`\`\`mermaid
  graph TD
      A[Start] --> B{Decision}
  \`\`\`
- Use diagram types like: graph/flowchart, sequenceDiagram, mindmap, gantt, pie, classDiagram, stateDiagram, erDiagram, timeline.
- Keep diagrams clean and focused — avoid excessive nodes or overly complex layouts.
- Always place diagrams in their own paragraph, not inline with text.

FORMATTING & SPACING:
- Write in a compact, professional style. Avoid filler phrases and redundant introductions.
- NEVER insert double blank lines between sections. Use a single blank line between headings and paragraphs.
- Keep paragraphs concise: 2-4 sentences max. Prefer short, direct sentences.
- Use bullet points and tables where they convey information more efficiently than paragraphs.
- Do NOT add excessive whitespace, padding paragraphs, or "fluff" content.
- Start sections directly with substantive content — skip generic opening sentences like "In this section we will..."
- The output will be rendered on paginated A4/Letter pages, so space-efficient writing is critical.

[SOURCE MATERIAL]
${allContent.slice(0, 50000)}`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: isLegal
                ? `Stel nu het document "${type.replace(/_/g, ' ')}" op. Wees juridisch precies en bondig, baseer je uitsluitend op het bronmateriaal, en verwijs naar wetgeving en jurisprudentie met correcte vindplaatsen (ECLI / artikel / CELEX).`
                : `Generate the ${type} now. Be thorough but concise — prioritize substance over volume. Use compact formatting with minimal whitespace. Where appropriate, include Mermaid diagrams to visualize key concepts, processes, or relationships.` }
        ];

        const { TIER_DEFAULTS } = require('../core/modelResolver');
        const _tierDefaults = TIER_DEFAULTS[resolvedTier] || TIER_DEFAULTS['fast'];
        const chatOptions = {
            maxTokens: _tierDefaults.maxTokens,
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

        // (Removed audio_overview ElevenLabs post-processing — the Audio Podcast
        // generation type was retired. Any cached/legacy callers now hit the
        // REMOVED_GEN_TYPES 400 at the top of this route.)

        // Legal matters: verify every citation in the generated document against
        // the authoritative sources, record outcomes in the bronnenlijst, and —
        // for formal court documents in strict mode — return a redacted version
        // that withholds citations we couldn't confirm.
        if (isLegal) {
            try {
                const { verifyText } = require('../core/legalCitationVerifier');
                const report = await verifyText(fullGeneratedText, { notebookId });
                const strict = ((nb.settings?.legal?.citationMode) === 'strict_formal') && LEGAL_PROCESSTUK_TYPES.has(type);
                let redactedContent = null;
                if (strict && (report.notFound.length || report.unverified.length)) {
                    redactedContent = fullGeneratedText;
                    for (const e of [...report.notFound, ...report.unverified]) {
                        redactedContent = redactedContent.split(e.token).join('[bron niet geverifieerd — controleer]');
                    }
                }
                send('citation_report', {
                    total: report.total,
                    verified: report.verified,
                    notFound: report.notFound,
                    unverified: report.unverified,
                    strict,
                    redactedContent,
                });
            } catch (e) {
                console.warn('[Notebooks] legal citation verification failed:', e.message);
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
            const useAzure = !!(await configStore.getConfig('use_azure_doc_processing'));
            
            if (useAzure) {
                const { searchLocally } = require('../core/localKBIngest');
                const sources = await notebookStore.getSources(nb.id);
                for (const source of sources) {
                    if (source.status !== 'ready') continue;
                    try {
                        const localResults = await searchLocally(userId, kbIds, source.name || 'main content', { topK: 30 });
                        if (localResults.length > 0) {
                            sourceContent += `\n--- Source: ${source.name} ---\n`;
                            sourceContent += localResults.map(r => r.content || r.text).join('\n');
                        }
                    } catch (err) {
                        console.warn('[Notebooks] Local search err:', err.message);
                    }
                }
            } else {
                const searchUrl = await configStore.getConfig('search_service_url') || 'https://services.beeflow.nl';
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
        }

        if (!sourceContent.trim()) {
            return res.status(400).json({ error: 'No source content available to fill parameters' });
        }

        // Resolve model  
        const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
        const { resolveModelForTier, getEUAwareTiers } = require('../core/modelResolver');
        const { getAdapter } = require('../core/providers');

        // Resolve user's org for EU-mode tier overrides
        let userOrgId = null;
        try {
            const { resolveUserOrgIds } = require('../auth');
            const orgIds = await resolveUserOrgIds(req);
            if (orgIds && orgIds.size > 0) userOrgId = Array.from(orgIds)[0];
            if (!userOrgId) {
                const userStore = require('../stores/userStore');
                const dbUser = await userStore.getUser(userId);
                if (dbUser?.organizationId) userOrgId = dbUser.organizationId;
            }
        } catch (_) {}

        let resolvedTier = modelTier || 'balanced';
        if (resolvedTier === 'auto') {
            try {
                const tiers = await getEUAwareTiers({ userOrgId, userId });
                const { classifyWithLLM } = require('../core/promptClassifier');
                const result = await classifyWithLLM('Fill in template parameters in a document using source information', tiers, { userOrgId, userId });
                resolvedTier = result.tier;
            } catch { resolvedTier = 'balanced'; }
        }

        let modelId = await resolveModelForTier(`tier:${resolvedTier}`, { userOrgId, userId, fallbackTier: 'fast' });
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

        const _fillDefaults = TIER_DEFAULTS[resolvedTier] || TIER_DEFAULTS['fast'];
        const chatOptions = { maxTokens: _fillDefaults.maxTokens, temperature: 0.1 };

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
