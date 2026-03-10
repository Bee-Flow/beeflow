/**
 * Markdown-aware content chunking utility.
 * Splits text into token-bounded chunks, respecting header hierarchy,
 * paragraph boundaries, and table structures.
 * Used by knowledge ingestion (file upload, URL import, swarm import).
 */

function chunkMarkdownContent(content, {
    maxTokensPerChunk = 400,
    charsPerToken = 4,
    overlapSentences = 2  // Number of sentences to repeat from previous chunk
} = {}) {
    if (!content || typeof content !== 'string') return [];

    // Clean up whitespace but preserve newlines for markdown structure
    content = content.replace(/[ \t]+/g, ' ').trim();

    const estimateTokens = (text) => Math.ceil(text.length / charsPerToken);

    const chunks = [];
    let sectionStack = []; // [{ level: 1, title: "Overview" }, ...]
    let currentChunkLines = [];
    let currentChunkTokens = 0;
    let currentChunkStartPath = [];
    let previousChunkTailSentences = []; // For overlap

    const flushChunk = () => {
        if (currentChunkLines.length === 0) return;
        let chunkText = currentChunkLines.join('\n').trim();
        if (chunkText.length === 0) return;

        // Prepend overlap from previous chunk if available
        if (previousChunkTailSentences.length > 0) {
            const overlapText = previousChunkTailSentences.join(' ');
            if (overlapText.length > 0 && overlapText.length < 300) {
                chunkText = overlapText + '\n\n' + chunkText;
            }
        }

        // Detect table content: 3+ lines containing | characters
        const lines = chunkText.split('\n');
        const pipeLines = lines.filter(l => l.includes('|') && l.trim().length > 2);
        const isTable = pipeLines.length >= 3;

        chunks.push({
            text: chunkText,
            tokens: estimateTokens(chunkText),
            metadata: {
                section_path: [...currentChunkStartPath],
                content_type: isTable ? 'table' : 'text'
            }
        });

        // Extract tail sentences for overlap with next chunk
        const plainText = currentChunkLines
            .filter(l => !l.startsWith('#'))  // Skip headers
            .join(' ')
            .trim();
        // Split by sentence boundaries (. ! ? followed by space or end)
        const sentences = plainText
            .split(/(?<=[.!?])\s+/)
            .filter(s => s.length > 10);
        previousChunkTailSentences = sentences.slice(-overlapSentences);

        currentChunkLines = [];
        currentChunkTokens = 0;
    };

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const tokenCount = estimateTokens(line);
        const headerMatch = line.match(/^(#{1,6})\s+(.*)/);

        if (headerMatch) {
            // Flush current chunk before starting new section
            if (currentChunkLines.length > 0) flushChunk();

            const level = headerMatch[1].length;
            const title = headerMatch[2].trim();

            // Adjust stack: remove entries at same or deeper level
            sectionStack = sectionStack.filter(s => s.level < level);
            sectionStack.push({ level, title });

            currentChunkStartPath = sectionStack.map(s => s.title);
            currentChunkLines.push(line);
            currentChunkTokens += tokenCount;
            continue;
        }

        // Normal line
        if (currentChunkLines.length === 0) {
            currentChunkStartPath = sectionStack.map(s => s.title);
        }

        // Check if adding this line exceeds limit
        if (currentChunkTokens + tokenCount > maxTokensPerChunk && currentChunkLines.length > 0) {
            // Prefer splitting at paragraph boundaries (blank lines)
            // Look backwards for a blank line within the last ~25% of the chunk
            const searchStart = Math.max(0, currentChunkLines.length - Math.ceil(currentChunkLines.length * 0.25));
            let splitAt = -1;

            for (let j = currentChunkLines.length - 1; j >= searchStart; j--) {
                if (currentChunkLines[j].trim() === '') {
                    splitAt = j;
                    break;
                }
            }

            if (splitAt > 0) {
                // Split at the paragraph boundary
                const overflow = currentChunkLines.splice(splitAt + 1);
                const overflowTokens = overflow.reduce((sum, l) => sum + estimateTokens(l), 0);

                flushChunk();
                currentChunkStartPath = sectionStack.map(s => s.title);

                // Re-add overflow lines to the new chunk
                currentChunkLines = overflow;
                currentChunkTokens = overflowTokens;
            } else {
                // No good paragraph boundary found, flush at line boundary
                flushChunk();
                currentChunkStartPath = sectionStack.map(s => s.title);
            }
        }

        currentChunkLines.push(line);
        currentChunkTokens += tokenCount;
    }

    // Final flush
    flushChunk();

    return chunks;
}

module.exports = { chunkMarkdownContent };
