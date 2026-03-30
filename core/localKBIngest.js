/**
 * Local KB Ingestion — bypasses the search-service for chunking + embedding.
 *
 * Used when Azure Document Processing is enabled and the deployment
 * doesn't have a local search-service instance.
 *
 * Steps:
 *   1. Chunk text (token-aware, heading/paragraph boundaries)
 *   2. Generate embeddings via Azure OpenAI
 *   3. Store chunks directly in PostgreSQL `kb_chunks` table
 */

const { exec, getAll, getClient } = require('../db');
const configStore = require('../stores/configStore');

// ── Structure-aware text chunking ───────────────────────────────────

const CHUNK_SIZE = 500;    // tokens per chunk (larger = more context per hit)
const CHUNK_OVERLAP = 100; // token overlap (ensures continuity between chunks)
const CHUNK_SIZE_FLEX = Math.floor(CHUNK_SIZE * 1.8); // atomic blocks up to this size stay whole

/**
 * Simple token counter based on character-length heuristic.
 * Not as precise as tiktoken, but good enough for chunking.
 */
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

/**
 * Convert HTML tables (from Azure Document Intelligence) to markdown tables or plain text.
 * Azure Doc Intelligence v4.0+ outputs HTML tables in markdown mode for fidelity,
 * but also wraps regular paragraph text in table structures (layout tables).
 *
 * - Single-column tables → plain text (paragraphs)
 * - Multi-column data tables → markdown tables
 */
function convertHtmlTablesToMarkdown(text) {
    if (!text) return text;

    return text.replace(/<table[\s\S]*?<\/table>/gi, (tableHtml) => {
        try {
            // Extract all rows
            const rows = [];
            const trRegex = /<tr[\s\S]*?<\/tr>/gi;
            let trMatch;
            while ((trMatch = trRegex.exec(tableHtml)) !== null) {
                const cells = [];
                const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
                let cellMatch;
                while ((cellMatch = cellRegex.exec(trMatch[0])) !== null) {
                    // Strip inner HTML tags, trim whitespace
                    const cellText = cellMatch[1]
                        .replace(/<br\s*\/?>/gi, '\n')
                        .replace(/<[^>]+>/g, '')
                        .replace(/\s+/g, ' ')
                        .trim();
                    cells.push(cellText);
                }
                if (cells.length > 0) rows.push(cells);
            }

            if (rows.length === 0) return tableHtml; // can't parse, keep original

            // Detect layout tables: mostly single-cell rows or uniform 1-2 column text
            const maxCols = Math.max(...rows.map(r => r.length));
            const singleCellRows = rows.filter(r => r.length === 1 || r.filter(c => c).length <= 1).length;
            const isLayoutTable = maxCols <= 2 && singleCellRows > rows.length * 0.6;

            if (isLayoutTable) {
                // Layout table → extract as plain text paragraphs
                const paragraphs = rows
                    .map(r => r.filter(c => c).join(' '))
                    .filter(p => p.trim());
                return '\n\n' + paragraphs.join('\n\n') + '\n\n';
            }

            // Real data table → convert to markdown table
            const normalized = rows.map(r => {
                while (r.length < maxCols) r.push('');
                return r;
            });

            const lines = [];
            lines.push('| ' + normalized[0].join(' | ') + ' |');
            lines.push('| ' + normalized[0].map(() => '---').join(' | ') + ' |');
            for (let i = 1; i < normalized.length; i++) {
                lines.push('| ' + normalized[i].join(' | ') + ' |');
            }

            return '\n' + lines.join('\n') + '\n';
        } catch {
            return tableHtml; // on any error, keep original
        }
    });
}

/**
 * Extract structural blocks (HTML tables, markdown tables, fenced code blocks)
 * from text and replace them with placeholders. Returns the cleaned text and
 * a map of placeholder → original block.
 *
 * This ensures structural elements are treated as atomic units during chunking.
 */
function extractAtomicBlocks(text) {
    const blocks = [];
    let cleaned = text;

    // 1. HTML tables: <table...>...</table> (dotAll via [\s\S])
    cleaned = cleaned.replace(/<table[\s\S]*?<\/table>/gi, (match) => {
        const idx = blocks.length;
        blocks.push(match);
        return `\n\n__ATOMIC_BLOCK_${idx}__\n\n`;
    });

    // 2. Fenced code blocks: ```...```
    cleaned = cleaned.replace(/```[\s\S]*?```/g, (match) => {
        const idx = blocks.length;
        blocks.push(match);
        return `\n\n__ATOMIC_BLOCK_${idx}__\n\n`;
    });

    // 3. Markdown tables: consecutive lines starting with |
    cleaned = cleaned.replace(/((?:^|\n)\|[^\n]+\n(?:\|[^\n]+\n?){2,})/g, (match) => {
        const idx = blocks.length;
        blocks.push(match.trim());
        return `\n\n__ATOMIC_BLOCK_${idx}__\n\n`;
    });

    return { cleaned, blocks };
}

/**
 * Split an HTML table that exceeds CHUNK_SIZE into row-based sub-chunks.
 * Preserves <table>, <caption>, and <thead> as a header for each sub-chunk.
 */
function splitHtmlTableByRows(tableHtml, chunkSize) {
    // Extract table wrapper (opening <table> + <caption> + <thead>) and rows
    const headerMatch = tableHtml.match(/^(<table[^>]*>(?:\s*<caption[^>]*>[\s\S]*?<\/caption>)?(?:\s*<thead[\s\S]*?<\/thead>)?)/i);
    const tableHeader = headerMatch ? headerMatch[1] : '<table>';
    const tableFooter = '</table>';

    // Extract all <tr>...</tr> blocks from the tbody area
    const rows = [];
    const trRegex = /<tr[\s\S]*?<\/tr>/gi;
    let rowMatch;
    // Skip rows already in thead
    const bodyStart = tableHtml.indexOf('</thead>');
    const searchArea = bodyStart >= 0 ? tableHtml.slice(bodyStart) : tableHtml;
    while ((rowMatch = trRegex.exec(searchArea)) !== null) {
        rows.push(rowMatch[0]);
    }

    if (rows.length === 0) return [tableHtml]; // Can't split further

    const subChunks = [];
    let currentRows = [];
    let currentSize = estimateTokens(tableHeader + tableFooter);

    for (const row of rows) {
        const rowTokens = estimateTokens(row);

        if (currentSize + rowTokens > chunkSize && currentRows.length > 0) {
            // Flush current sub-chunk
            subChunks.push(`${tableHeader}\n<tbody>\n${currentRows.join('\n')}\n</tbody>\n${tableFooter}`);
            currentRows = [];
            currentSize = estimateTokens(tableHeader + tableFooter);
        }

        currentRows.push(row);
        currentSize += rowTokens;
    }

    // Final sub-chunk
    if (currentRows.length > 0) {
        subChunks.push(`${tableHeader}\n<tbody>\n${currentRows.join('\n')}\n</tbody>\n${tableFooter}`);
    }

    return subChunks.length > 0 ? subChunks : [tableHtml];
}

/**
 * Split text into natural sections at heading and paragraph boundaries.
 */
function splitIntoSections(text) {
    const parts = text.split(/(?=(?:^|\n)#{1,6}\s)|(?:\n\n)+/);
    return parts.filter(p => p && p.trim());
}

/**
 * Split a long section by sentence boundaries (for regular text, not tables).
 */
function splitLongSection(text, chunkSize) {
    // If this is an HTML table, split by rows instead of sentences
    if (/<table[\s\S]*<\/table>/i.test(text)) {
        return splitHtmlTableByRows(text, chunkSize);
    }

    const sentences = text.split(/(?<=[.!?])\s+/);
    const parts = [];
    let current = [];
    let currentCount = 0;

    for (const sentence of sentences) {
        const sentTokens = estimateTokens(sentence);

        if (currentCount + sentTokens > chunkSize && current.length > 0) {
            parts.push(current.join(' '));
            const overlapText = current.slice(-1).join(' ');
            current = [overlapText, sentence];
            currentCount = estimateTokens(current.join(' '));
        } else {
            current.push(sentence);
            currentCount += sentTokens;
        }
    }

    if (current.length > 0) {
        parts.push(current.join(' '));
    }

    return parts.length > 0 ? parts : [text];
}

/**
 * Chunk text into token-aware pieces with overlap.
 * Structure-aware: HTML tables, markdown tables, and code blocks are
 * extracted as atomic units so they are never split mid-element.
 *
 * @param {string} text — input text to chunk
 * @returns {Array<{chunk_id: number, text: string, token_count: number}>}
 */
function chunkText(text) {
    if (!text || !text.trim()) return [];

    // Phase 0: Convert HTML tables → Markdown tables (Azure Doc Intelligence outputs HTML)
    text = convertHtmlTablesToMarkdown(text);

    // Phase 1: Extract atomic blocks (tables, code blocks) → placeholders
    const { cleaned, blocks } = extractAtomicBlocks(text);

    // Phase 2: Split into natural sections (headings, paragraphs)
    const rawSections = splitIntoSections(cleaned);

    // Phase 3: Restore atomic blocks into the section stream
    const sections = [];
    for (const section of rawSections) {
        const blockMatch = section.trim().match(/^__ATOMIC_BLOCK_(\d+)__$/);
        if (blockMatch) {
            // This section is an atomic block — restore original content
            sections.push(blocks[parseInt(blockMatch[1], 10)]);
        } else if (/__ATOMIC_BLOCK_\d+__/.test(section)) {
            // Section contains a mix of text and placeholder(s) — split them apart
            const parts = section.split(/(__ATOMIC_BLOCK_\d+__)/);
            for (const part of parts) {
                const innerMatch = part.match(/^__ATOMIC_BLOCK_(\d+)__$/);
                if (innerMatch) {
                    sections.push(blocks[parseInt(innerMatch[1], 10)]);
                } else if (part.trim()) {
                    sections.push(part);
                }
            }
        } else {
            sections.push(section);
        }
    }

    // Phase 4: Build chunks, respecting atomic block boundaries
    const chunks = [];
    let currentParts = [];
    let currentTokenCount = 0;
    let chunkId = 0;

    for (const section of sections) {
        const sectionTokens = estimateTokens(section);
        const isAtomicBlock = /<table[\s\S]*<\/table>/i.test(section) ||
                              /^```[\s\S]*```$/.test(section) ||
                              /^(\|[^\n]+\n){2,}/.test(section);

        // Atomic blocks up to CHUNK_SIZE_FLEX stay whole (even if > CHUNK_SIZE)
        if (isAtomicBlock && sectionTokens <= CHUNK_SIZE_FLEX) {
            // Flush current buffer first
            if (currentParts.length > 0) {
                const ct = currentParts.join('\n\n').trim();
                if (ct) {
                    chunks.push({ chunk_id: chunkId, text: ct, token_count: currentTokenCount });
                    chunkId++;
                }
                currentParts = [];
                currentTokenCount = 0;
            }
            // Emit the atomic block as its own chunk
            chunks.push({ chunk_id: chunkId, text: section.trim(), token_count: sectionTokens });
            chunkId++;
            continue;
        }

        // If this single section exceeds chunk_size, split it further
        if (sectionTokens > CHUNK_SIZE) {
            // Flush current buffer first
            if (currentParts.length > 0) {
                const ct = currentParts.join('\n\n').trim();
                if (ct) {
                    chunks.push({ chunk_id: chunkId, text: ct, token_count: currentTokenCount });
                    chunkId++;
                }
                currentParts = [];
                currentTokenCount = 0;
            }

            // Split the long section (tables by row, text by sentence)
            const subParts = splitLongSection(section, CHUNK_SIZE);
            for (const sp of subParts) {
                const spTokens = estimateTokens(sp);
                chunks.push({ chunk_id: chunkId, text: sp.trim(), token_count: spTokens });
                chunkId++;
            }
            continue;
        }

        // Check if adding this section exceeds chunk_size
        if (currentTokenCount + sectionTokens > CHUNK_SIZE) {
            // Flush current chunk
            const ct = currentParts.join('\n\n').trim();
            if (ct) {
                chunks.push({ chunk_id: chunkId, text: ct, token_count: currentTokenCount });
                chunkId++;
            }
            // Keep overlap (last portion)
            if (currentParts.length > 0) {
                const lastPart = currentParts[currentParts.length - 1];
                const overlapTokens = estimateTokens(lastPart);
                if (overlapTokens <= CHUNK_OVERLAP) {
                    currentParts = [lastPart];
                    currentTokenCount = overlapTokens;
                } else {
                    currentParts = [];
                    currentTokenCount = 0;
                }
            } else {
                currentParts = [];
                currentTokenCount = 0;
            }
        }

        currentParts.push(section);
        currentTokenCount += sectionTokens;
    }

    // Final chunk
    if (currentParts.length > 0) {
        const ct = currentParts.join('\n\n').trim();
        if (ct) {
            chunks.push({ chunk_id: chunkId, text: ct, token_count: currentTokenCount });
        }
    }

    // Filter out tiny chunks (< 30 tokens)
    const MIN_TOKENS = 30;
    const filtered = chunks.filter(c => c.token_count >= MIN_TOKENS);

    // Re-number chunk IDs
    filtered.forEach((c, i) => { c.chunk_id = i; });

    return filtered;
}

// ── Azure OpenAI Embeddings ─────────────────────────────────────────

/**
 * Generate embeddings via Azure OpenAI.
 *
 * @param {string[]} texts — array of text strings to embed
 * @param {string} endpoint — Azure OpenAI endpoint
 * @param {string} apiKey — Azure OpenAI API key
 * @param {string} model — deployment name (e.g. 'text-embedding-3-small')
 * @returns {Promise<number[][]>} — array of embedding vectors
 */
async function azureEmbed(texts, endpoint, apiKey, model) {
    const cleanEndpoint = endpoint.replace(/\/$/, '');
    const url = `${cleanEndpoint}/openai/deployments/${model}/embeddings?api-version=2024-06-01`;

    // Batch in groups of 16 to avoid rate limits
    const BATCH_SIZE = 16;
    const allEmbeddings = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);

        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'api-key': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ input: batch }),
            signal: AbortSignal.timeout(30000),
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Azure embedding failed (${res.status}): ${errText}`);
        }

        const data = await res.json();
        const sorted = data.data
            .sort((a, b) => a.index - b.index)
            .map(item => item.embedding);
        allEmbeddings.push(...sorted);
    }

    return allEmbeddings;
}

// ── Database schema bootstrap ───────────────────────────────────────

let schemaInitialized = false;
let pgvectorAvailable = true;

async function ensureKBChunksTable(vectorDim = 1536) {
    if (schemaInitialized) return;

    try {
        // Try to enable pgvector
        await exec('CREATE EXTENSION IF NOT EXISTS vector');
        pgvectorAvailable = true;
    } catch (e) {
        console.warn('[LocalKBIngest] pgvector extension not available — vector search disabled, keyword search will still work. Install postgresql-XX-pgvector to enable.');
        pgvectorAvailable = false;
    }

    // Create kb_chunks table matching the search-service schema
    if (pgvectorAvailable) {
        await exec(`
            CREATE TABLE IF NOT EXISTS kb_chunks (
                id            BIGSERIAL PRIMARY KEY,
                tenant_id     TEXT NOT NULL,
                knowledge_base_id TEXT NOT NULL,
                document_id   TEXT NOT NULL,
                chunk_id      INT NOT NULL,
                lang          TEXT,
                title         TEXT,
                content       TEXT NOT NULL,
                tsv           TSVECTOR,
                embedding     VECTOR(${vectorDim}),
                source_uri    TEXT,
                created_at    TIMESTAMPTZ DEFAULT now()
            )
        `);
    } else {
        await exec(`
            CREATE TABLE IF NOT EXISTS kb_chunks (
                id            BIGSERIAL PRIMARY KEY,
                tenant_id     TEXT NOT NULL,
                knowledge_base_id TEXT NOT NULL,
                document_id   TEXT NOT NULL,
                chunk_id      INT NOT NULL,
                lang          TEXT,
                title         TEXT,
                content       TEXT NOT NULL,
                tsv           TSVECTOR,
                source_uri    TEXT,
                created_at    TIMESTAMPTZ DEFAULT now()
            )
        `);
    }

    // Create indexes
    try { await exec('CREATE INDEX IF NOT EXISTS idx_kb_chunks_tsv ON kb_chunks USING GIN (tsv)'); } catch (_) {}
    if (pgvectorAvailable) {
        try { await exec(`CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding ON kb_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 200)`); } catch (_) {}
    }
    try { await exec('CREATE INDEX IF NOT EXISTS idx_kb_chunks_tenant_kb ON kb_chunks (tenant_id, knowledge_base_id)'); } catch (_) {}
    try { await exec('CREATE INDEX IF NOT EXISTS idx_kb_chunks_tenant_kb_doc ON kb_chunks (tenant_id, knowledge_base_id, document_id)'); } catch (_) {}

    schemaInitialized = true;
    console.log('[LocalKBIngest] kb_chunks table ensured');
}

// ── Main ingestion function ─────────────────────────────────────────

/**
 * Ingest content locally — chunk, embed via Azure, store in PostgreSQL.
 *
 * @param {string} tenantId — user ID
 * @param {string} kbId — knowledge base ID
 * @param {string} docId — document ID
 * @param {string} content — text content to ingest
 * @param {object} options
 * @param {string} [options.title]
 * @param {string} [options.sourceUri]
 * @param {string} [options.lang='auto']
 * @returns {Promise<{chunks_created: number}>}
 */
async function ingestLocally(tenantId, kbId, docId, content, options = {}) {
    const { title = '', sourceUri = '', lang = 'auto' } = options;

    // Get Azure credentials
    const endpoint = await configStore.getConfig('azure_openai_embedding_endpoint');
    const apiKey = await configStore.getSecret('azure_openai_embedding_key');
    const model = await configStore.getConfig('azure_openai_embedding_model') || 'text-embedding-3-small';

    if (!endpoint || !apiKey) {
        throw new Error('Azure OpenAI embedding not configured (endpoint or key missing)');
    }

    // Ensure table exists
    await ensureKBChunksTable(1536);

    // 1. Chunk
    const chunks = chunkText(content);
    if (chunks.length === 0) {
        throw new Error('Document produced no chunks');
    }

    console.log(`[LocalKBIngest] Chunked into ${chunks.length} pieces`);

    // 2. Embed
    const chunkTexts = chunks.map(c => c.text);
    let embeddings = [];
    if (pgvectorAvailable) {
        console.log(`[LocalKBIngest] Generating Azure embeddings (${model})...`);
        try {
            embeddings = await azureEmbed(chunkTexts, endpoint, apiKey, model);
        } catch (err) {
            console.warn(`[LocalKBIngest] Azure embedding failed: ${err.message}. Falling back to keyword search only.`);
        }
    } else {
        console.log('[LocalKBIngest] Skipping embedding generation (pgvector disabled)');
    }

    // 3. Store in PostgreSQL
    const client = await getClient();
    try {
        await client.query('BEGIN');

        // Delete old chunks for this document (re-ingestion)
        await client.query(
            'DELETE FROM kb_chunks WHERE tenant_id = $1 AND knowledge_base_id = $2 AND document_id = $3',
            [tenantId, kbId, docId]
        );

        // Insert new chunks
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            
            if (pgvectorAvailable && embeddings[i]) {
                const vectorStr = `[${embeddings[i].join(',')}]`;
                await client.query(
                    `INSERT INTO kb_chunks (
                        tenant_id, knowledge_base_id, document_id,
                        chunk_id, lang, title, content, tsv, embedding, source_uri
                    ) VALUES (
                        $1, $2, $3,
                        $4, $5, $6, $7,
                        setweight(to_tsvector('dutch', $7), 'A') ||
                        setweight(to_tsvector('english', $7), 'B') ||
                        setweight(to_tsvector('simple', $7), 'C'),
                        $8::vector,
                        $9
                    )`,
                    [tenantId, kbId, docId, chunk.chunk_id, lang, title, chunk.text, vectorStr, sourceUri]
                );
            } else {
                await client.query(
                    `INSERT INTO kb_chunks (
                        tenant_id, knowledge_base_id, document_id,
                        chunk_id, lang, title, content, tsv, source_uri
                    ) VALUES (
                        $1, $2, $3,
                        $4, $5, $6, $7,
                        setweight(to_tsvector('dutch', $7), 'A') ||
                        setweight(to_tsvector('english', $7), 'B') ||
                        setweight(to_tsvector('simple', $7), 'C'),
                        $8
                    )`,
                    [tenantId, kbId, docId, chunk.chunk_id, lang, title, chunk.text, sourceUri]
                );
            }
        }

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }

    console.log(`[LocalKBIngest] Stored ${chunks.length} chunks in PostgreSQL`);
    return { chunks_created: chunks.length };
}

/**
 * Delete chunks for a document locally.
 */
async function deleteChunksLocally(tenantId, kbId, docId) {
    await ensureKBChunksTable();

    const client = await getClient();
    try {
        await client.query(
            'DELETE FROM kb_chunks WHERE tenant_id = $1 AND knowledge_base_id = $2 AND document_id = $3',
            [tenantId, kbId, docId]
        );
    } finally {
        client.release();
    }
}

/**
 * Search locally-ingested KB chunks using hybrid (vector + FTS) search.
 *
 * @param {string} tenantId — user ID
 * @param {string[]} kbIds — knowledge base IDs to search
 * @param {string} query — user query text
 * @param {object} options
 * @param {number} [options.topK=10]
 * @returns {Promise<Array<{content: string, title: string, source_uri: string, score: number}>>}
 */
async function searchLocally(tenantId, kbIds, query, options = {}) {
    const { topK = 10 } = options;

    // Get Azure credentials for embedding the query
    const endpoint = await configStore.getConfig('azure_openai_embedding_endpoint');
    const apiKey = await configStore.getSecret('azure_openai_embedding_key');
    const model = await configStore.getConfig('azure_openai_embedding_model') || 'text-embedding-3-small';
    if (pgvectorAvailable && (!endpoint || !apiKey)) {
        throw new Error('Azure OpenAI embedding not configured');
    }

    await ensureKBChunksTable(1536);

    let vectorResults = { rows: [] };
    const client = await getClient();

    try {
        // A. Vector search
        if (pgvectorAvailable) {
            try {
                // Embed the query
                const queryEmbedding = await azureEmbed([query], endpoint, apiKey, model);
                const vectorStr = `[${queryEmbedding[0].join(',')}]`;

                vectorResults = await client.query(
                    `SELECT id, title, content, source_uri, document_id, chunk_id,
                            1 - (embedding <=> $1::vector) AS vec_score
                     FROM kb_chunks
                     WHERE tenant_id = $2
                       AND knowledge_base_id = ANY($3::text[])
                     ORDER BY embedding <=> $1::vector
                     LIMIT $4`,
                    [vectorStr, tenantId, kbIds, topK * 3]
                );
            } catch (err) {
                console.warn(`[LocalKBIngest] Vector search failed: ${err.message}`);
            }
        }

        // B. Full-text search
        // websearch_to_tsquery expects natural language — just sanitize special chars
        let ftsResults = { rows: [] };
        const sanitizedQuery = query
            .replace(/[\\\"'*^$(){}[\]\\\\]/g, '')
            .trim();

        if (sanitizedQuery.length > 0) {
            try {
                ftsResults = await client.query(
                    `SELECT id, title, content, source_uri, document_id, chunk_id,
                            GREATEST(
                                ts_rank_cd(tsv, websearch_to_tsquery('dutch', $1)),
                                ts_rank_cd(tsv, websearch_to_tsquery('english', $1)),
                                ts_rank_cd(tsv, websearch_to_tsquery('simple', $1))
                            ) AS fts_score
                     FROM kb_chunks
                     WHERE tenant_id = $2
                       AND knowledge_base_id = ANY($3::text[])
                       AND (
                           tsv @@ websearch_to_tsquery('dutch', $1)
                           OR tsv @@ websearch_to_tsquery('english', $1)
                           OR tsv @@ websearch_to_tsquery('simple', $1)
                       )
                     ORDER BY fts_score DESC
                     LIMIT 20`,
                    [sanitizedQuery, tenantId, kbIds]
                );
            } catch (e) {
                console.warn('[LocalKBSearch] FTS query failed:', e.message);
            }
        }

        // C. Reciprocal Rank Fusion
        const scores = new Map();
        const contentMap = new Map();
        const K = 60;

        vectorResults.rows.forEach((row, idx) => {
            const rank = idx + 1;
            scores.set(row.id, (scores.get(row.id) || 0) + 1 / (K + rank));
            contentMap.set(row.id, row);
        });

        ftsResults.rows.forEach((row, idx) => {
            const rank = idx + 1;
            scores.set(row.id, (scores.get(row.id) || 0) + 1 / (K + rank));
            if (!contentMap.has(row.id)) contentMap.set(row.id, row);
        });

        // D. Sort by fused score and take top candidates for reranking
        let results = Array.from(scores.entries())
            .map(([id, score]) => {
                const row = contentMap.get(id);
                return {
                    id: row.id,
                    content: row.content,
                    title: row.title || '',
                    source_uri: row.source_uri || '',
                    score,
                    document_id: row.document_id,
                    chunk_id: row.chunk_id,
                };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, Math.max(topK, 20)); // Take extra candidates for reranking

        // D2. Context window expansion: fetch adjacent chunks for table completeness
        //     When a table chunk is found, we also pull its neighbors (chunk_id ± 1)
        //     from the same document to give the agent the full picture.
        if (results.length > 0) {
            try {
                const existingIds = new Set(results.map(r => r.id));
                const adjacentRows = await client.query(
                    `SELECT DISTINCT ON (c.id) c.id, c.title, c.content, c.source_uri, c.document_id, c.chunk_id
                     FROM kb_chunks c
                     INNER JOIN (
                         SELECT document_id, chunk_id FROM kb_chunks WHERE id = ANY($1::bigint[])
                     ) h ON c.document_id = h.document_id
                        AND c.chunk_id BETWEEN h.chunk_id - 1 AND h.chunk_id + 1
                     WHERE c.tenant_id = $2
                       AND c.id != ALL($1::bigint[])
                     LIMIT 30`,
                    [results.map(r => r.id), tenantId]
                );

                for (const adj of adjacentRows.rows) {
                    if (!existingIds.has(adj.id)) {
                        existingIds.add(adj.id);
                        results.push({
                            id: adj.id,
                            content: adj.content,
                            title: adj.title || '',
                            source_uri: adj.source_uri || '',
                            score: 0, // will be scored by reranker
                            document_id: adj.document_id,
                            chunk_id: adj.chunk_id,
                        });
                    }
                }

                if (adjacentRows.rows.length > 0) {
                    console.log(`[LocalKBSearch] Context window: added ${adjacentRows.rows.length} adjacent chunks`);
                }
            } catch (adjErr) {
                console.warn(`[LocalKBSearch] Context window expansion failed: ${adjErr.message}`);
            }
        }

        // E. Rerank via Azure Cohere or local cross-encoder sidecar
        const azureRerankerEndpoint = await configStore.getConfig('azure_reranker_endpoint') || process.env.AZURE_RERANKER_ENDPOINT;
        const azureRerankerKey = await configStore.getSecret('azure_reranker_key') || process.env.AZURE_RERANKER_KEY;
        const azureRerankerModel = await configStore.getConfig('azure_reranker_model') || process.env.AZURE_RERANKER_MODEL || 'Cohere-rerank-v4.0-fast';
        const localRerankerUrl = process.env.RERANKER_URL;

        if (azureRerankerEndpoint && azureRerankerKey && results.length > 0) {
            // ── Azure Cohere rerank (auto-discover correct path) ──
            try {
                const endpoint = azureRerankerEndpoint.replace(/\/+$/, '');
                const requestBody = JSON.stringify({
                    model: azureRerankerModel,
                    query,
                    documents: results.map(r => r.content),
                    top_n: topK,
                });
                const headers = {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${azureRerankerKey}`,
                };

                // Try paths in order of likelihood — cache the working one
                const RERANK_PATHS = ['/providers/cohere/v2/rerank', '/v1/rerank', '/v2/rerank'];
                if (!global._azureRerankerPath) global._azureRerankerPath = null;

                const pathsToTry = global._azureRerankerPath
                    ? [global._azureRerankerPath]
                    : RERANK_PATHS;

                let rerankerData = null;
                for (const path of pathsToTry) {
                    const url = `${endpoint}${path}`;
                    console.log(`[LocalKBSearch] Trying Azure reranker: ${url} (model=${azureRerankerModel}, docs=${results.length})`);
                    const res = await fetch(url, {
                        method: 'POST',
                        headers,
                        body: requestBody,
                        signal: AbortSignal.timeout(15000),
                    });
                    if (res.ok) {
                        rerankerData = await res.json();
                        global._azureRerankerPath = path;  // cache for future calls
                        break;
                    }
                    const errBody = await res.text().catch(() => '');
                    console.warn(`[LocalKBSearch] Azure reranker ${path} → ${res.status}: ${errBody.slice(0, 200)}`);
                    if (res.status === 401 || res.status === 403) break; // auth issue, no point trying other paths
                }

                if (rerankerData?.results?.length > 0) {
                    results = rerankerData.results.map(rr => ({
                        content: results[rr.index].content,
                        title: results[rr.index].title,
                        source_uri: results[rr.index].source_uri,
                        score: rr.relevance_score,
                    }));
                    console.log(`[LocalKBSearch] Azure Cohere reranked ${rerankerData.results.length} results (top=${results[0]?.score})`);
                } else if (!rerankerData) {
                    console.warn(`[LocalKBSearch] All Azure reranker paths failed, falling back to RRF`);
                }
            } catch (rerankerErr) {
                console.warn(`[LocalKBSearch] Azure reranker error (${rerankerErr.message}), falling back to RRF`);
            }
        } else if (localRerankerUrl && results.length > 0) {
            // ── Local cross-encoder sidecar ──
            try {
                const rerankerRes = await fetch(`${localRerankerUrl}/rerank`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        query,
                        documents: results.map(r => r.content),
                        top_n: topK,
                    }),
                    signal: AbortSignal.timeout(10000),
                });

                if (rerankerRes.ok) {
                    const rerankerData = await rerankerRes.json();
                    if (rerankerData.results && rerankerData.results.length > 0) {
                        results = rerankerData.results.map(rr => ({
                            content: results[rr.index].content,
                            title: results[rr.index].title,
                            source_uri: results[rr.index].source_uri,
                            score: rr.relevance_score,
                        }));
                        console.log(`[LocalKBSearch] Reranked ${rerankerData.results.length} results in ${rerankerData.latency_ms || '?'}ms (top=${results[0]?.score})`);
                    }
                } else {
                    console.warn(`[LocalKBSearch] Reranker responded ${rerankerRes.status}, falling back to RRF`);
                }
            } catch (rerankerErr) {
                console.warn(`[LocalKBSearch] Reranker unavailable (${rerankerErr.message}), falling back to RRF`);
            }
        }

        results = results.slice(0, topK);

        console.log(`[LocalKBSearch] Found ${results.length} results (vec=${vectorResults.rows.length}, fts=${ftsResults.rows.length})`);
        return results;
    } finally {
        client.release();
    }
}

/**
 * Retrieve concatenated chunk content for a document from kb_chunks.
 * Used by the re-index endpoint to recover existing content when Azure mode is active.
 *
 * @param {string} tenantId
 * @param {string} kbId
 * @param {string} docId
 * @returns {Promise<string>} concatenated content
 */
async function getDocumentContent(tenantId, kbId, docId) {
    const pool = require('../db').pool;
    const client = await pool.connect();
    try {
        const { rows } = await client.query(
            `SELECT content FROM kb_chunks
             WHERE tenant_id = $1 AND knowledge_base_id = $2 AND document_id = $3
             ORDER BY chunk_index ASC`,
            [tenantId, kbId, docId]
        );
        return rows.map(r => r.content).join('\n\n');
    } finally {
        client.release();
    }
}

module.exports = { ingestLocally, deleteChunksLocally, searchLocally, getDocumentContent, chunkText, azureEmbed };
