/**
 * Source Ingestion — Ingest various source types into a notebook's knowledge base.
 *
 * Supported types: pdf, docx, url, text, xlsx, csv, gdrive, onedrive
 * Each source is parsed → text extracted → chunked + embedded into the notebook's KB.
 *
 * Uses shared kbIngestionHelpers for extraction and ingestion, ensuring notebooks
 * get the same quality pipeline as standalone Knowledge Bases (Azure support,
 * OCR fallbacks, URL→Markdown, deduplication, etc.).
 */

const notebookStore = require('../../stores/notebookStore');
const kbStore = require('../../stores/knowledgeBases');
const {
    extractFileContent,
    fetchUrlContent,
    ingestDocument,
} = require('../../core/kbIngestionHelpers');

/**
 * Ensure the notebook has a linked KB — auto-create one if needed.
 * Returns the KB ID.
 */
async function ensureNotebookKB(notebookId, userId) {
    const notebook = await notebookStore.getNotebook(notebookId, userId);
    if (!notebook) throw new Error('Notebook not found');

    let kbId = notebook.knowledgeBaseIds?.[0];

    if (!kbId) {
        const kb = await kbStore.createKB(
            userId,
            `📓 ${notebook.name}`,
            `Auto-generated knowledge base for notebook "${notebook.name}"`,
            null,
            { sourceKind: 'notebook_auto', usageContexts: ['webpage'] }
        );
        kbId = kb.id;
        await notebookStore.updateNotebook(notebookId, userId, {
            knowledgeBaseIds: [kbId]
        });
        console.log(`[SourceIngestion] Auto-created KB "${kb.name}" for notebook ${notebookId}`);
    }

    return kbId;
}

/**
 * Core ingestion: push text content into the notebook's KB via shared helpers.
 *
 * @param {string} notebookId
 * @param {string} sourceId   — already created in notebook_sources
 * @param {string} userId
 * @param {string} text       — extracted text content
 * @param {string} sourceName — human label for the source
 */
// Normalize the human label used for a source — trim and collapse internal
// whitespace so names like "  My\tDoc \n " don't appear with stray tabs or
// newlines in the source list UI.
function normalizeSourceName(name, fallback = 'Untitled source') {
    if (!name) return fallback;
    const cleaned = String(name).replace(/\s+/g, ' ').trim();
    return cleaned.length > 0 ? cleaned.slice(0, 200) : fallback;
}

// Map raw extraction/ingestion errors to short, actionable messages. The raw
// message is still logged; only the friendly one is shown to the user.
function friendlyError(e) {
    const m = (e && e.message ? e.message : 'Unknown error').toString();
    if (/timeout|timed out|ETIMEDOUT/i.test(m)) return 'Timed out while processing — try again.';
    if (/ENOTFOUND|ECONNREFUSED|getaddrinfo|fetch failed|network/i.test(m)) return 'Could not reach the URL — check the link and try again.';
    if (/\b(401|403|unauthor|forbidden)\b/i.test(m)) return 'The URL refused access (login or paywall).';
    if (/password|encrypted/i.test(m)) return 'This file looks password-protected — remove protection and re-upload.';
    if (/unsupported|cannot read|parse|extract/i.test(m)) return 'Could not read this file format.';
    return m.length > 160 ? `${m.slice(0, 157)}…` : m;
}

// Cap stored extracted text so a giant upload can't bloat a DB row; enough for
// preview + text/meeting retry.
const MAX_STORED_TEXT = 1_000_000;

async function ingestTextIntoKB(notebookId, sourceId, userId, text, sourceName) {
    if (!text || text.length < 10) {
        await notebookStore.updateSource(sourceId, { status: 'ready', stage: 'ready', wordCount: 0, contentText: text || '' });
        return;
    }

    sourceName = normalizeSourceName(sourceName);
    const wordCount = text.split(/\s+/).length;

    try {
        // Store the extracted text first (powers the preview panel + retry) and
        // flip to the embedding stage so the UI shows real progress.
        await notebookStore.updateSource(sourceId, { stage: 'embedding', contentText: text.slice(0, MAX_STORED_TEXT) });
        const kbId = await ensureNotebookKB(notebookId, userId);

        // ── Privacy Shield: build the notebook's PII token map at INGEST ──────
        // The stored source text + embeddings stay REAL (search recall and the
        // data-owner preview depend on it). We scan the WHOLE source ONCE to mint
        // and PERSIST a token for every PII entity into the notebook's map
        // (notebooks.pii_token_map, keyed on notebookId). Previously the map was
        // built piecemeal at query time from whatever chunks a search happened to
        // retrieve, so a person who never landed in a retrieved chunk had no token
        // — and the model's `[person_N]` for them leaked into the drafted document
        // because the restore map didn't contain it. Building it here makes the map
        // complete + stable up front: later turns tokenise retrieved chunks
        // consistently (seeded from this map) and the AI-written document/chat
        // de-tokenise fully. Best-effort — never block ingestion on it.
        try {
            const { resolveShieldFor } = require('../../core/orgShield');
            const shield = await resolveShieldFor({ userId });
            if (shield?.enabled) {
                // Hydrate any existing notebook map first so a second source in the
                // same dossier reuses tokens (one [person_1] across all sources).
                try { await require('../../core/dlp/dlpRunner').getConversationTokenMapAsync(notebookId); } catch (_) { /* best-effort */ }
                const { scanAttachmentText } = require('../../core/dlp/attachmentScanner');
                // We deliberately discard the tokenised text — only the side-effect
                // (mint + mergeTokenMap → persist) matters; storage stays REAL.
                const scan = await scanAttachmentText({ text, filename: sourceName, orgShield: shield, conversationId: notebookId });
                if (scan?.action === 'tokenize') {
                    const n = Array.isArray(scan.findings) ? scan.findings.length : 0;
                    console.warn(`[SourceIngestion] 🔒 Built PII token map for "${sourceName}" (${n} spans) → notebook ${notebookId}`);
                }
            }
        } catch (piiErr) {
            console.warn(`[SourceIngestion] PII map build failed for "${sourceName}": ${piiErr.message}`);
        }

        // Use shared ingestion (dedup + chunk + embed)
        const result = await ingestDocument(
            userId, kbId, text, sourceName,
            'notebook_source', sourceId,
            { skipDedup: false, lang: 'auto' }
        );

        await notebookStore.updateSource(sourceId, { status: 'ready', stage: 'ready', wordCount });
        console.log(`[SourceIngestion] Source "${sourceName}" ingested: ${result.chunks} chunks, ${wordCount} words`);
    } catch (e) {
        // Duplicates are not fatal for notebook sources — mark ready, but flag it
        // so the UI can show a "duplicate" badge.
        if (e.code === 'DUPLICATE') {
            console.log(`[SourceIngestion] Duplicate content for "${sourceName}", marking ready`);
            const cur = await notebookStore.getSource(sourceId).catch(() => null);
            await notebookStore.updateSource(sourceId, { status: 'ready', stage: 'ready', wordCount, metadata: { ...(cur?.metadata || {}), duplicate: true } });
            return;
        }
        console.error(`[SourceIngestion] Failed to ingest "${sourceName}":`, e.message);
        await notebookStore.updateSource(sourceId, { status: 'error', stage: 'error', error: friendlyError(e) });
    }
}

/**
 * Ingest a file buffer (PDF, DOCX, XLSX, etc.) — uses shared extraction
 * which includes Azure Document Intelligence + Mistral OCR fallbacks.
 */
async function ingestFileSource(notebookId, sourceId, userId, buffer, fileName, mimeType) {
    try {
        await notebookStore.updateSource(sourceId, { stage: 'extracting' });
        const text = await extractFileContent(buffer, mimeType, fileName);
        await ingestTextIntoKB(notebookId, sourceId, userId, text, fileName);
    } catch (e) {
        console.error(`[SourceIngestion] File parse failed for "${fileName}":`, e.message);
        await notebookStore.updateSource(sourceId, { status: 'error', stage: 'error', error: friendlyError(e) });
    }
}

/**
 * Ingest a URL — uses shared URL→Markdown conversion (htmlToMarkdown)
 * instead of naive HTML stripping.
 */
async function ingestUrlSource(notebookId, sourceId, userId, url) {
    try {
        await notebookStore.updateSource(sourceId, { stage: 'fetching' });
        const { content, title, resolvedUrl } = await fetchUrlContent(url);

        await notebookStore.updateSource(sourceId, {
            metadata: { url: resolvedUrl, charCount: content.length },
            name: normalizeSourceName(title || url, url)
        });

        await ingestTextIntoKB(notebookId, sourceId, userId, content, resolvedUrl);
    } catch (e) {
        console.error(`[SourceIngestion] URL fetch failed for "${url}":`, e.message);
        await notebookStore.updateSource(sourceId, { status: 'error', stage: 'error', error: friendlyError(e) });
    }
}

/**
 * Ingest pasted text directly.
 */
async function ingestTextSource(notebookId, sourceId, userId, text, name) {
    await ingestTextIntoKB(notebookId, sourceId, userId, text, name || 'Pasted text');
}

/**
 * Ingest content from Google Drive (already exported as text by the frontend picker).
 */
async function ingestDriveSource(notebookId, sourceId, userId, content, fileName) {
    await ingestTextIntoKB(notebookId, sourceId, userId, content, fileName);
}

module.exports = {
    ingestFileSource,
    ingestUrlSource,
    ingestTextSource,
    ingestDriveSource,
    ingestTextIntoKB,
};
