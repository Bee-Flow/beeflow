/**
 * Webpage Routes — CRUD for webpages + source management + versions.
 *
 * Endpoints:
 *   POST   /                    — create webpage
 *   GET    /                    — list user's webpages
 *   GET    /:id                 — get webpage detail (metadata + html/css/js bytes)
 *   PUT    /:id                 — update webpage (metadata and/or file slots)
 *   DELETE /:id                 — delete webpage (purges DB rows + RustFS objects)
 *   POST   /:id/sources/file    — upload file source (pdf, docx, xlsx, txt, …)
 *   POST   /:id/sources/url     — add URL source
 *   POST   /:id/sources/text    — paste text source
 *   POST   /:id/sources/drive   — import from Google Drive / OneDrive
 *   GET    /:id/sources         — list sources
 *   POST   /:id/sources/:sid/retry  — retry a failed/cancelled source
 *   POST   /:id/sources/:sid/cancel — cancel a stuck source
 *   DELETE /:id/sources/:sid    — remove source
 *   GET    /:id/versions        — list version snapshots (metadata only)
 *   GET    /:id/versions/:vid   — get a single version (full file trio)
 *   POST   /:id/versions        — create a manual snapshot
 *   POST   /:id/versions/:vid/restore — restore a previous snapshot
 *   DELETE /:id/versions/:vid   — delete a version
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');

const webpageStore = require('../stores/webpageStore');
const storageStore = require('../stores/storageStore');
const kbStore = require('../stores/knowledgeBases');
const {
    ingestFileSource,
    ingestUrlSource,
    ingestTextSource,
    ingestDriveSource,
} = require('../agents/webpages/sourceIngestion');
const { deleteDocumentChunks, findDocumentBySourceUri } = require('../core/kbIngestionHelpers');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function requireAuth(req, res, next) {
    if (req.session?.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// Access control: the beta-feature gate at server/index.js (`requireBetaFeature('webpages')`)
// is the single source of truth. The previous `requirePermission('use_webpages')` here was
// redundant and blocked org members who had the beta enabled but not the legacy permission.

// ── Webpage CRUD ──────────────────────────────────────────────────

router.post('/', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { name, description, instructions } = req.body;
        const webpage = await webpageStore.createWebpage({ userId, name, description, instructions });
        res.json({ success: true, webpage });
    } catch (err) {
        console.error('[Webpages] Create failed:', err);
        res.status(500).json({ error: 'Failed to create webpage' });
    }
});

router.get('/', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const webpages = await webpageStore.getWebpages(userId);
        res.json({ webpages });
    } catch (err) {
        console.error('[Webpages] List failed:', err);
        res.status(500).json({ error: 'Failed to list webpages' });
    }
});

router.get('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const webpage = await webpageStore.getWebpage(req.params.id, userId);
        if (!webpage) return res.status(404).json({ error: 'Webpage not found' });

        await webpageStore.timeoutStuckSources(webpage.id).catch(() => {});

        const [sources, files, chatMessages, extraFiles] = await Promise.all([
            webpageStore.getSources(webpage.id),
            webpageStore.readAllSlots(userId, webpage.id),
            webpageStore.getChatMessages(webpage.id, userId),
            webpageStore.listExtraFiles(webpage.id),
        ]);
        res.json({ webpage, sources, files, chatMessages, extraFiles });
    } catch (err) {
        console.error('[Webpages] Get failed:', err);
        res.status(500).json({ error: 'Failed to get webpage' });
    }
});

router.put('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const id = req.params.id;
        const {
            name, description, instructions, settings, knowledgeBaseIds,
            html, css, js,
        } = req.body;

        const wp = await webpageStore.getWebpage(id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        // Determine which slots actually changed (by sha256). Skip RustFS round-trip
        // for unchanged slots so a metadata-only PUT doesn't re-upload all three files.
        const incoming = { html, css, js };
        const current = { html: wp.htmlSha, css: wp.cssSha, js: wp.jsSha };
        const slotUpdates = {};
        for (const slot of webpageStore.SLOTS) {
            if (incoming[slot] === undefined) continue;
            const newSha = webpageStore.sha256(incoming[slot] || '');
            if (newSha !== current[slot]) {
                slotUpdates[slot] = { content: incoming[slot] || '', sha: newSha };
            }
        }

        // Auto-version: if any slot is changing AND debounce elapsed AND there's
        // existing content to snapshot, copy "current/*" → "versions/{vid}/*".
        if (Object.keys(slotUpdates).length > 0) {
            const hasExistingContent = wp.htmlSize + wp.cssSize + wp.jsSize > 0;
            if (hasExistingContent) {
                try {
                    const should = await webpageStore.shouldAutoVersion(id);
                    if (should) {
                        await webpageStore.createVersion(userId, id, 'Auto-save', {
                            htmlSha: wp.htmlSha,
                            cssSha: wp.cssSha,
                            jsSha: wp.jsSha,
                            contentLength: wp.htmlSize + wp.cssSize + wp.jsSize,
                        });
                    }
                } catch (vErr) {
                    console.warn('[Webpages] Auto-version failed:', vErr.message);
                }
            }
        }

        // Persist each changed slot to RustFS.
        const metadataUpdate = { name, description, instructions, settings, knowledgeBaseIds };
        for (const [slot, { content }] of Object.entries(slotUpdates)) {
            const { sha, size } = await webpageStore.writeSlot(userId, id, slot, content);
            metadataUpdate[`${slot}Sha`] = sha;
            metadataUpdate[`${slot}Size`] = size;
        }

        const ok = await webpageStore.updateWebpageMetadata(id, userId, metadataUpdate);
        if (!ok && Object.keys(slotUpdates).length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[Webpages] Update failed:', err);
        res.status(500).json({ error: 'Failed to update webpage: ' + err.message });
    }
});

// ── Extra files (multi-file projects) ────────────────────────────────
// Read content of one extra file. Used by the frontend to fetch the bytes
// for the live preview and the file-explorer detail view.
router.get('/:id/files', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        const path = req.query.path;
        if (!path) {
            const list = await webpageStore.listExtraFiles(req.params.id);
            return res.json({ files: list });
        }
        const file = await webpageStore.readExtraFile({ webpageId: req.params.id, userId, path });
        if (!file) return res.status(404).json({ error: 'File not found' });
        if (file.meta.isText) {
            return res.json({ meta: file.meta, content: file.text });
        }
        // Binary: return base64 so the frontend can build a data URL.
        return res.json({ meta: file.meta, contentBase64: file.bytes.toString('base64') });
    } catch (err) {
        console.error('[Webpages] Get extra file failed:', err);
        res.status(500).json({ error: 'Failed to get file' });
    }
});

// ── Chat history (per-webpage persistence) ───────────────────────────
// Decoupled from the file-update PUT so frequent chat saves don't trigger
// the file-PUT's sha256 + auto-versioning logic.
router.put('/:id/chat', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
        await webpageStore.setChatMessages(req.params.id, userId, messages);
        res.json({ success: true, count: messages.length });
    } catch (err) {
        console.error('[Webpages] Chat save failed:', err);
        res.status(500).json({ error: 'Failed to save chat history' });
    }
});

router.delete('/:id/chat', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        await webpageStore.setChatMessages(req.params.id, userId, []);
        res.json({ success: true });
    } catch (err) {
        console.error('[Webpages] Chat clear failed:', err);
        res.status(500).json({ error: 'Failed to clear chat history' });
    }
});

router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const result = await webpageStore.deleteWebpage(req.params.id, userId);
        if (!result) return res.status(404).json({ error: 'Webpage not found' });

        // Clean up auto-created KBs
        if (result.knowledgeBaseIds?.length > 0) {
            for (const kbId of result.knowledgeBaseIds) {
                try { await kbStore.deleteKB(kbId); } catch (e) {
                    console.warn(`[Webpages] KB cleanup for ${kbId}:`, e.message);
                }
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[Webpages] Delete failed:', err);
        res.status(500).json({ error: 'Failed to delete webpage' });
    }
});

// ── Source: File Upload ────────────────────────────────────────────

router.post('/:id/sources/file', requireAuth, upload.single('file'), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const webpageId = req.params.id;

        const wp = await webpageStore.getWebpage(webpageId, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const fileName = req.file.originalname;
        const mimeType = req.file.mimetype;
        const buffer = req.file.buffer;

        const ext = (fileName.split('.').pop() || '').toLowerCase();
        const typeMap = { pdf: 'pdf', docx: 'docx', doc: 'docx', xlsx: 'xlsx', xls: 'xlsx', csv: 'csv', txt: 'text', md: 'text' };
        const type = typeMap[ext] || 'file';

        let storageKey = null;
        if (storageStore.isAvailable()) {
            const storageName = `wp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
            storageKey = storageStore.buildKey(userId, 'webpage-sources', storageName);
            await storageStore.uploadFile(storageKey, buffer, mimeType);
        }

        const source = await webpageStore.addSource({
            webpageId, type, name: fileName,
            storageKey, fileName, metadata: { mimeType, size: buffer.length },
        });

        res.json({ success: true, source });

        ingestFileSource(webpageId, source.id, userId, buffer, fileName, mimeType).catch(err => {
            console.error(`[Webpages] Background ingestion failed for ${fileName}:`, err.message);
        });
    } catch (err) {
        console.error('[Webpages] File upload failed:', err);
        res.status(500).json({ error: 'Failed to upload file' });
    }
});

router.post('/:id/sources/url', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const webpageId = req.params.id;
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'URL required' });

        const wp = await webpageStore.getWebpage(webpageId, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        let name;
        try { name = new URL(url).hostname + new URL(url).pathname; } catch { name = url; }
        if (name.length > 80) name = name.slice(0, 80) + '…';

        const source = await webpageStore.addSource({
            webpageId, type: 'url', name, metadata: { url },
        });

        res.json({ success: true, source });

        ingestUrlSource(webpageId, source.id, userId, url).catch(err => {
            console.error(`[Webpages] URL ingestion failed for ${url}:`, err.message);
        });
    } catch (err) {
        console.error('[Webpages] URL source failed:', err);
        res.status(500).json({ error: 'Failed to add URL source' });
    }
});

router.post('/:id/sources/text', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const webpageId = req.params.id;
        const { text, name } = req.body;
        if (!text) return res.status(400).json({ error: 'Text content required' });

        const wp = await webpageStore.getWebpage(webpageId, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const sourceName = name || 'Pasted text';
        const source = await webpageStore.addSource({
            webpageId, type: 'text', name: sourceName,
            wordCount: text.split(/\s+/).length,
        });

        res.json({ success: true, source });

        ingestTextSource(webpageId, source.id, userId, text, sourceName).catch(err => {
            console.error(`[Webpages] Text ingestion failed:`, err.message);
        });
    } catch (err) {
        console.error('[Webpages] Text source failed:', err);
        res.status(500).json({ error: 'Failed to add text source' });
    }
});

router.post('/:id/sources/drive', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const webpageId = req.params.id;
        const { files, provider } = req.body;
        if (!files || !Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ error: 'Files array required' });
        }

        const wp = await webpageStore.getWebpage(webpageId, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const sources = [];
        for (const file of files) {
            const type = provider === 'microsoft' ? 'onedrive' : 'gdrive';
            const source = await webpageStore.addSource({
                webpageId,
                type,
                name: file.name || 'Drive file',
                metadata: {
                    provider,
                    driveFileId: file.driveFileId,
                    charCount: file.content?.length,
                },
                wordCount: file.content ? file.content.split(/\s+/).length : 0,
            });
            sources.push(source);

            if (file.content) {
                ingestDriveSource(webpageId, source.id, userId, file.content, file.name).catch(err => {
                    console.error(`[Webpages] Drive ingestion failed for ${file.name}:`, err.message);
                });
            } else {
                webpageStore.updateSource(source.id, { status: 'error', error: 'No content received from Drive' });
            }
        }

        res.json({ success: true, sources });
    } catch (err) {
        console.error('[Webpages] Drive source failed:', err);
        res.status(500).json({ error: 'Failed to add Drive source' });
    }
});

router.get('/:id/sources', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        await webpageStore.timeoutStuckSources(wp.id).catch(() => {});
        const sources = await webpageStore.getSources(wp.id);
        res.json({ sources });
    } catch (err) {
        console.error('[Webpages] List sources failed:', err);
        res.status(500).json({ error: 'Failed to list sources' });
    }
});

router.post('/:id/sources/:sid/retry', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const source = await webpageStore.getSource(req.params.sid);
        if (!source || source.webpageId !== wp.id) return res.status(404).json({ error: 'Source not found' });

        await webpageStore.updateSource(source.id, { status: 'processing', error: null });
        res.json({ success: true });

        (async () => {
            try {
                if (source.type === 'url') {
                    const url = source.metadata?.url;
                    if (!url) throw new Error('Source has no URL to retry');
                    await ingestUrlSource(wp.id, source.id, userId, url);
                } else if (source.storageKey) {
                    if (!storageStore.isAvailable()) throw new Error('Storage not configured');
                    const { stream } = await storageStore.streamFile(source.storageKey);
                    const chunks = [];
                    for await (const chunk of stream) chunks.push(chunk);
                    const buffer = Buffer.concat(chunks);
                    const mimeType = source.metadata?.mimeType || 'application/octet-stream';
                    await ingestFileSource(wp.id, source.id, userId, buffer, source.fileName || source.name, mimeType);
                } else {
                    throw new Error('This source type cannot be retried — please re-add it.');
                }
            } catch (e) {
                console.error(`[Webpages] Retry failed for source ${source.id}:`, e.message);
                await webpageStore.updateSource(source.id, { status: 'error', error: e.message }).catch(() => {});
            }
        })();
    } catch (err) {
        console.error('[Webpages] Retry source route failed:', err);
        res.status(500).json({ error: 'Failed to retry source' });
    }
});

router.post('/:id/sources/:sid/cancel', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const source = await webpageStore.getSource(req.params.sid);
        if (!source || source.webpageId !== wp.id) return res.status(404).json({ error: 'Source not found' });

        await webpageStore.updateSource(source.id, {
            status: 'error',
            error: 'Cancelled by user',
        });
        res.json({ success: true });
    } catch (err) {
        console.error('[Webpages] Cancel source failed:', err);
        res.status(500).json({ error: 'Failed to cancel source' });
    }
});

router.delete('/:id/sources/:sid', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const source = await webpageStore.deleteSource(req.params.sid);
        if (!source) return res.status(404).json({ error: 'Source not found' });

        if (source.storageKey) {
            try {
                if (!source.storageKey.startsWith('local:')) {
                    await storageStore.deleteFile(source.storageKey);
                }
            } catch (e) { console.warn('[Webpages] Storage cleanup:', e.message); }
        }

        const kbIds = wp.knowledgeBaseIds || [];
        for (const kbId of kbIds) {
            try {
                const doc = await findDocumentBySourceUri(kbId, source.id);
                if (doc) await deleteDocumentChunks(kbId, doc.id, userId);
            } catch (e) {
                console.warn(`[Webpages] KB chunk cleanup for ${source.id}:`, e.message);
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[Webpages] Delete source failed:', err);
        res.status(500).json({ error: 'Failed to delete source' });
    }
});

// ── Version Control ─────────────────────────────────────────────────

router.get('/:id/versions', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const versions = await webpageStore.getVersions(req.params.id);
        res.json({ versions });
    } catch (err) {
        console.error('[Webpages] List versions failed:', err);
        res.status(500).json({ error: 'Failed to list versions' });
    }
});

router.get('/:id/versions/:vid', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const version = await webpageStore.getVersion(userId, req.params.vid);
        if (!version || version.webpageId !== req.params.id) {
            return res.status(404).json({ error: 'Version not found' });
        }
        res.json({ version });
    } catch (err) {
        console.error('[Webpages] Get version failed:', err);
        res.status(500).json({ error: 'Failed to get version' });
    }
});

router.post('/:id/versions', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const summary = req.body.summary || 'Manual snapshot';
        if (wp.htmlSize + wp.cssSize + wp.jsSize === 0) {
            return res.status(400).json({ error: 'Webpage is empty — nothing to snapshot' });
        }

        const version = await webpageStore.createVersion(userId, req.params.id, summary);
        res.json({ success: true, version });
    } catch (err) {
        console.error('[Webpages] Create version failed:', err);
        res.status(500).json({ error: 'Failed to create version' });
    }
});

/**
 * Restore a version: copy the snapshot's three slot objects back over
 * "current/*" and update the webpage's metadata hashes.
 */
router.post('/:id/versions/:vid/restore', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const version = await webpageStore.getVersion(userId, req.params.vid);
        if (!version || version.webpageId !== req.params.id) {
            return res.status(404).json({ error: 'Version not found' });
        }

        // Snapshot the *current* state first so the restore is itself reversible.
        const hadContent = wp.htmlSize + wp.cssSize + wp.jsSize > 0;
        if (hadContent) {
            try {
                await webpageStore.createVersion(userId, req.params.id, 'Pre-restore snapshot', {
                    htmlSha: wp.htmlSha,
                    cssSha: wp.cssSha,
                    jsSha: wp.jsSha,
                    contentLength: wp.htmlSize + wp.cssSize + wp.jsSize,
                });
            } catch (e) {
                console.warn('[Webpages] Pre-restore snapshot failed:', e.message);
            }
        }

        // Write the snapshot's contents back to "current/" via the store helpers
        // (which also recompute sha + size).
        const updates = {};
        for (const slot of webpageStore.SLOTS) {
            const content = version[slot] || '';
            const { sha, size } = await webpageStore.writeSlot(userId, req.params.id, slot, content);
            updates[`${slot}Sha`] = sha;
            updates[`${slot}Size`] = size;
        }
        await webpageStore.updateWebpageMetadata(req.params.id, userId, updates);

        res.json({
            success: true,
            files: { html: version.html, css: version.css, js: version.js },
        });
    } catch (err) {
        console.error('[Webpages] Restore version failed:', err);
        res.status(500).json({ error: 'Failed to restore version' });
    }
});

router.delete('/:id/versions/:vid', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const ok = await webpageStore.deleteVersion(userId, req.params.vid);
        if (!ok) return res.status(404).json({ error: 'Version not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Webpages] Delete version failed:', err);
        res.status(500).json({ error: 'Failed to delete version' });
    }
});

module.exports = router;
