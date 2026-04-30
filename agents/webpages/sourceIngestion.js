/**
 * Webpage Source Ingestion — mirror of agents/notebooks/sourceIngestion.js
 * but talks to webpageStore so each webpage owns its own KB and source rows.
 *
 * Supported types: pdf, docx, url, text, xlsx, csv, gdrive, onedrive
 */

const webpageStore = require('../../stores/webpageStore');
const kbStore = require('../../stores/knowledgeBases');
const {
    extractFileContent,
    fetchUrlContent,
    ingestDocument,
} = require('../../core/kbIngestionHelpers');

/**
 * Ensure the webpage has a linked KB — auto-create one if needed.
 */
async function ensureWebpageKB(webpageId, userId) {
    const webpage = await webpageStore.getWebpage(webpageId, userId);
    if (!webpage) throw new Error('Webpage not found');

    let kbId = webpage.knowledgeBaseIds?.[0];

    if (!kbId) {
        const kb = await kbStore.createKB(
            userId,
            `🌐 ${webpage.name}`,
            `Auto-generated knowledge base for webpage "${webpage.name}"`
        );
        kbId = kb.id;
        await webpageStore.updateWebpageMetadata(webpageId, userId, {
            knowledgeBaseIds: [kbId]
        });
        console.log(`[WebpageSourceIngestion] Auto-created KB "${kb.name}" for webpage ${webpageId}`);
    }

    return kbId;
}

async function ingestTextIntoKB(webpageId, sourceId, userId, text, sourceName) {
    if (!text || text.length < 10) {
        await webpageStore.updateSource(sourceId, { status: 'ready', wordCount: 0 });
        return;
    }

    const wordCount = text.split(/\s+/).length;

    try {
        const kbId = await ensureWebpageKB(webpageId, userId);
        const result = await ingestDocument(
            userId, kbId, text, sourceName,
            'webpage_source', sourceId,
            { skipDedup: false, lang: 'auto' }
        );
        await webpageStore.updateSource(sourceId, { status: 'ready', wordCount });
        console.log(`[WebpageSourceIngestion] Source "${sourceName}" ingested: ${result.chunks} chunks, ${wordCount} words`);
    } catch (e) {
        if (e.code === 'DUPLICATE') {
            await webpageStore.updateSource(sourceId, { status: 'ready', wordCount });
            return;
        }
        console.error(`[WebpageSourceIngestion] Failed to ingest "${sourceName}":`, e.message);
        await webpageStore.updateSource(sourceId, { status: 'error', error: e.message });
    }
}

async function ingestFileSource(webpageId, sourceId, userId, buffer, fileName, mimeType) {
    try {
        const text = await extractFileContent(buffer, mimeType, fileName);
        await ingestTextIntoKB(webpageId, sourceId, userId, text, fileName);
    } catch (e) {
        console.error(`[WebpageSourceIngestion] File parse failed for "${fileName}":`, e.message);
        await webpageStore.updateSource(sourceId, { status: 'error', error: e.message });
    }
}

async function ingestUrlSource(webpageId, sourceId, userId, url) {
    try {
        const { content, title, resolvedUrl } = await fetchUrlContent(url);
        await webpageStore.updateSource(sourceId, {
            metadata: { url: resolvedUrl, charCount: content.length },
            name: title || url,
        });
        await ingestTextIntoKB(webpageId, sourceId, userId, content, resolvedUrl);
    } catch (e) {
        console.error(`[WebpageSourceIngestion] URL fetch failed for "${url}":`, e.message);
        await webpageStore.updateSource(sourceId, { status: 'error', error: e.message });
    }
}

async function ingestTextSource(webpageId, sourceId, userId, text, name) {
    await ingestTextIntoKB(webpageId, sourceId, userId, text, name || 'Pasted text');
}

async function ingestDriveSource(webpageId, sourceId, userId, content, fileName) {
    await ingestTextIntoKB(webpageId, sourceId, userId, content, fileName);
}

module.exports = {
    ingestFileSource,
    ingestUrlSource,
    ingestTextSource,
    ingestDriveSource,
    ingestTextIntoKB,
};
