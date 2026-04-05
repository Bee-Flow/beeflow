/**
 * Slides Source Ingestion — Ingest sources into a slide deck's knowledge base.
 *
 * Mirrors agents/notebooks/sourceIngestion.js exactly.
 * Reuses the shared kbIngestionHelpers pipeline.
 */

const slidesStore = require('../../stores/slidesStore');
const kbStore = require('../../stores/knowledgeBases');
const {
    extractFileContent,
    fetchUrlContent,
    ingestDocument,
} = require('../../core/kbIngestionHelpers');

/**
 * Ensure the slide deck has a linked KB — auto-create one if needed.
 */
async function ensureDeckKB(deckId, userId) {
    const deck = await slidesStore.getDeck(deckId, userId);
    if (!deck) throw new Error('Slide deck not found');

    let kbId = deck.knowledgeBaseIds?.[0];

    if (!kbId) {
        const kb = await kbStore.createKB(
            userId,
            `🎯 ${deck.name}`,
            `Auto-generated knowledge base for slide deck "${deck.name}"`
        );
        kbId = kb.id;
        await slidesStore.updateDeck(deckId, userId, {
            knowledgeBaseIds: [kbId]
        });
        console.log(`[SlidesIngestion] Auto-created KB "${kb.name}" for deck ${deckId}`);
    }

    return kbId;
}

/**
 * Core ingestion: push text content into the deck's KB.
 */
async function ingestTextIntoKB(deckId, sourceId, userId, text, sourceName) {
    if (!text || text.length < 10) {
        await slidesStore.updateSource(sourceId, { status: 'ready', word_count: 0 });
        return;
    }

    const wordCount = text.split(/\s+/).length;

    try {
        const kbId = await ensureDeckKB(deckId, userId);

        const result = await ingestDocument(
            userId, kbId, text, sourceName,
            'slide_source', sourceId,
            { skipDedup: false, lang: 'auto' }
        );

        await slidesStore.updateSource(sourceId, { status: 'ready', word_count: wordCount });
        console.log(`[SlidesIngestion] Source "${sourceName}" ingested: ${result.chunks} chunks, ${wordCount} words`);
    } catch (e) {
        if (e.code === 'DUPLICATE') {
            console.log(`[SlidesIngestion] Duplicate content for "${sourceName}", marking ready`);
            await slidesStore.updateSource(sourceId, { status: 'ready', word_count: wordCount });
            return;
        }
        console.error(`[SlidesIngestion] Failed to ingest "${sourceName}":`, e.message);
        await slidesStore.updateSource(sourceId, { status: 'error', error: e.message });
    }
}

/**
 * Ingest a file buffer (PDF, DOCX, XLSX, etc.)
 */
async function ingestFileSource(deckId, sourceId, userId, buffer, fileName, mimeType) {
    try {
        const text = await extractFileContent(buffer, mimeType, fileName);
        await ingestTextIntoKB(deckId, sourceId, userId, text, fileName);
    } catch (e) {
        console.error(`[SlidesIngestion] File parse failed for "${fileName}":`, e.message);
        await slidesStore.updateSource(sourceId, { status: 'error', error: e.message });
    }
}

/**
 * Ingest a URL
 */
async function ingestUrlSource(deckId, sourceId, userId, url) {
    try {
        const { content, title, resolvedUrl } = await fetchUrlContent(url);

        await slidesStore.updateSource(sourceId, {
            metadata: { url: resolvedUrl, charCount: content.length },
            name: title || url
        });

        await ingestTextIntoKB(deckId, sourceId, userId, content, resolvedUrl);
    } catch (e) {
        console.error(`[SlidesIngestion] URL fetch failed for "${url}":`, e.message);
        await slidesStore.updateSource(sourceId, { status: 'error', error: e.message });
    }
}

/**
 * Ingest pasted text directly.
 */
async function ingestTextSource(deckId, sourceId, userId, text, name) {
    await ingestTextIntoKB(deckId, sourceId, userId, text, name || 'Pasted text');
}

/**
 * Ingest content from Google Drive.
 */
async function ingestDriveSource(deckId, sourceId, userId, content, fileName) {
    await ingestTextIntoKB(deckId, sourceId, userId, content, fileName);
}

module.exports = {
    ingestFileSource,
    ingestUrlSource,
    ingestTextSource,
    ingestDriveSource,
    ingestTextIntoKB,
};
