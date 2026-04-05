/**
 * Sheets Source Ingestion — Ingest sources into a spreadsheet's knowledge base.
 *
 * Mirrors agents/slides/sourceIngestion.js exactly.
 * Reuses the shared kbIngestionHelpers pipeline.
 */

const sheetStore = require('../../stores/sheetStore');
const kbStore = require('../../stores/knowledgeBases');
const {
    extractFileContent,
    fetchUrlContent,
    ingestDocument,
} = require('../../core/kbIngestionHelpers');

/**
 * Ensure the spreadsheet has a linked KB — auto-create one if needed.
 */
async function ensureSpreadsheetKB(spreadsheetId, userId) {
    const sheet = await sheetStore.getSpreadsheet(spreadsheetId, userId);
    if (!sheet) throw new Error('Spreadsheet not found');

    let kbId = sheet.knowledgeBaseIds?.[0];

    if (!kbId) {
        const kb = await kbStore.createKB(
            userId,
            `📊 ${sheet.name}`,
            `Auto-generated knowledge base for spreadsheet "${sheet.name}"`
        );
        kbId = kb.id;
        await sheetStore.updateSpreadsheet(spreadsheetId, userId, {
            knowledgeBaseIds: [kbId]
        });
        console.log(`[SheetsIngestion] Auto-created KB "${kb.name}" for spreadsheet ${spreadsheetId}`);
    }

    return kbId;
}

/**
 * Core ingestion: push text content into the spreadsheet's KB.
 */
async function ingestTextIntoKB(spreadsheetId, sourceId, userId, text, sourceName) {
    if (!text || text.length < 10) {
        await sheetStore.updateSource(sourceId, { status: 'ready', word_count: 0 });
        return;
    }

    const wordCount = text.split(/\s+/).length;

    try {
        const kbId = await ensureSpreadsheetKB(spreadsheetId, userId);

        const result = await ingestDocument(
            userId, kbId, text, sourceName,
            'sheet_source', sourceId,
            { skipDedup: false, lang: 'auto' }
        );

        await sheetStore.updateSource(sourceId, { status: 'ready', word_count: wordCount });
        console.log(`[SheetsIngestion] Source "${sourceName}" ingested: ${result.chunks} chunks, ${wordCount} words`);
    } catch (e) {
        if (e.code === 'DUPLICATE') {
            console.log(`[SheetsIngestion] Duplicate content for "${sourceName}", marking ready`);
            await sheetStore.updateSource(sourceId, { status: 'ready', word_count: wordCount });
            return;
        }
        console.error(`[SheetsIngestion] Failed to ingest "${sourceName}":`, e.message);
        await sheetStore.updateSource(sourceId, { status: 'error', error: e.message });
    }
}

/**
 * Ingest a file buffer (PDF, DOCX, XLSX, CSV, etc.)
 */
async function ingestFileSource(spreadsheetId, sourceId, userId, buffer, fileName, mimeType) {
    try {
        const text = await extractFileContent(buffer, mimeType, fileName);
        await ingestTextIntoKB(spreadsheetId, sourceId, userId, text, fileName);
    } catch (e) {
        console.error(`[SheetsIngestion] File parse failed for "${fileName}":`, e.message);
        await sheetStore.updateSource(sourceId, { status: 'error', error: e.message });
    }
}

/**
 * Ingest a URL
 */
async function ingestUrlSource(spreadsheetId, sourceId, userId, url) {
    try {
        const { content, title, resolvedUrl } = await fetchUrlContent(url);

        await sheetStore.updateSource(sourceId, {
            metadata: { url: resolvedUrl, charCount: content.length },
            name: title || url
        });

        await ingestTextIntoKB(spreadsheetId, sourceId, userId, content, resolvedUrl);
    } catch (e) {
        console.error(`[SheetsIngestion] URL fetch failed for "${url}":`, e.message);
        await sheetStore.updateSource(sourceId, { status: 'error', error: e.message });
    }
}

/**
 * Ingest pasted text directly.
 */
async function ingestTextSource(spreadsheetId, sourceId, userId, text, name) {
    await ingestTextIntoKB(spreadsheetId, sourceId, userId, text, name || 'Pasted text');
}

/**
 * Ingest content from Google Drive.
 */
async function ingestDriveSource(spreadsheetId, sourceId, userId, content, fileName) {
    await ingestTextIntoKB(spreadsheetId, sourceId, userId, content, fileName);
}

module.exports = {
    ingestFileSource,
    ingestUrlSource,
    ingestTextSource,
    ingestDriveSource,
    ingestTextIntoKB,
};
