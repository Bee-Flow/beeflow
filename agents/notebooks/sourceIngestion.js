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
            `Auto-generated knowledge base for notebook "${notebook.name}"`
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
async function ingestTextIntoKB(notebookId, sourceId, userId, text, sourceName) {
    if (!text || text.length < 10) {
        await notebookStore.updateSource(sourceId, { status: 'ready', wordCount: 0 });
        return;
    }

    const wordCount = text.split(/\s+/).length;

    try {
        const kbId = await ensureNotebookKB(notebookId, userId);

        // Use shared ingestion (dedup + chunk + embed)
        const result = await ingestDocument(
            userId, kbId, text, sourceName,
            'notebook_source', sourceId,
            { skipDedup: false, lang: 'auto' }
        );

        await notebookStore.updateSource(sourceId, { status: 'ready', wordCount });
        console.log(`[SourceIngestion] Source "${sourceName}" ingested: ${result.chunks} chunks, ${wordCount} words`);
    } catch (e) {
        // Duplicates are not fatal for notebook sources — mark as ready
        if (e.code === 'DUPLICATE') {
            console.log(`[SourceIngestion] Duplicate content for "${sourceName}", marking ready`);
            await notebookStore.updateSource(sourceId, { status: 'ready', wordCount });
            return;
        }
        console.error(`[SourceIngestion] Failed to ingest "${sourceName}":`, e.message);
        await notebookStore.updateSource(sourceId, { status: 'error', error: e.message });
    }
}

/**
 * Ingest a file buffer (PDF, DOCX, XLSX, etc.) — uses shared extraction
 * which includes Azure Document Intelligence + Mistral OCR fallbacks.
 */
async function ingestFileSource(notebookId, sourceId, userId, buffer, fileName, mimeType) {
    try {
        const text = await extractFileContent(buffer, mimeType, fileName);
        await ingestTextIntoKB(notebookId, sourceId, userId, text, fileName);
    } catch (e) {
        console.error(`[SourceIngestion] File parse failed for "${fileName}":`, e.message);
        await notebookStore.updateSource(sourceId, { status: 'error', error: e.message });
    }
}

/**
 * Ingest a URL — uses shared URL→Markdown conversion (htmlToMarkdown)
 * instead of naive HTML stripping.
 */
async function ingestUrlSource(notebookId, sourceId, userId, url) {
    try {
        const { content, title, resolvedUrl } = await fetchUrlContent(url);

        await notebookStore.updateSource(sourceId, {
            metadata: { url: resolvedUrl, charCount: content.length },
            name: title || url
        });

        await ingestTextIntoKB(notebookId, sourceId, userId, content, resolvedUrl);
    } catch (e) {
        console.error(`[SourceIngestion] URL fetch failed for "${url}":`, e.message);
        await notebookStore.updateSource(sourceId, { status: 'error', error: e.message });
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
