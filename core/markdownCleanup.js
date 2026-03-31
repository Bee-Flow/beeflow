/**
 * markdownCleanup.js
 *
 * Post-processes Azure Document Intelligence (and other) output into
 * clean, LLM-friendly Markdown.
 *
 * Responsibilities:
 *   1. Strip Azure DI structural comments (PageBreak, PageHeader, etc.)
 *   2. Convert ALL <table> HTML → Markdown tables (no HTML left)
 *   3. Clean checkboxes, figure markers, excessive whitespace
 *
 * Design rule: zero HTML tags in the output — ever.
 */

// ── HTML Table → Markdown conversion ────────────────────────────────────────

/**
 * Parse a single <table>...</table> HTML string into a 2D array of rows/cells.
 * Handles colspan by repeating the cell value across merged columns.
 * Handles rowspan by carrying the value down across merged rows.
 *
 * @param {string} tableHtml
 * @returns {{ caption: string, rows: string[][] }}
 */
function parseHtmlTable(tableHtml) {
    // Extract optional caption
    const captionMatch = tableHtml.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
    const caption = captionMatch
        ? stripTags(captionMatch[1]).trim()
        : '';

    // Extract all <tr> blocks
    const trPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const rawRows = [];
    let trMatch;
    while ((trMatch = trPattern.exec(tableHtml)) !== null) {
        rawRows.push(trMatch[1]);
    }

    if (rawRows.length === 0) return { caption, rows: [] };

    // Parse cells out of each row, tracking th vs td and colspan/rowspan
    const parsedRows = rawRows.map(rowHtml => {
        const cells = [];
        const cellPattern = /<(th|td)([^>]*)>([\s\S]*?)<\/\1>/gi;
        let cellMatch;
        while ((cellMatch = cellPattern.exec(rowHtml)) !== null) {
            const attrs = cellMatch[2];
            const content = stripTags(cellMatch[3]).replace(/\s+/g, ' ').trim();
            const colspan = parseInt((attrs.match(/colspan\s*=\s*["']?(\d+)/i) || [])[1] || '1', 10);
            const rowspan = parseInt((attrs.match(/rowspan\s*=\s*["']?(\d+)/i) || [])[1] || '1', 10);
            cells.push({ content, colspan, rowspan });
        }
        return cells;
    });

    // Resolve colspan and rowspan into a flat 2D grid
    const grid = [];
    const pendingRowspans = {}; // col → { value, remaining }

    for (let r = 0; r < parsedRows.length; r++) {
        const row = parsedRows[r];
        const gridRow = [];
        let colIdx = 0;
        let cellIdx = 0;

        // Max columns: look ahead to determine grid width
        while (cellIdx < row.length || Object.keys(pendingRowspans).length > 0) {
            // Inject pending rowspans
            if (pendingRowspans[colIdx]) {
                const rs = pendingRowspans[colIdx];
                gridRow.push(rs.value);
                rs.remaining--;
                if (rs.remaining === 0) delete pendingRowspans[colIdx];
                colIdx++;
                continue;
            }

            if (cellIdx >= row.length) break;

            const cell = row[cellIdx++];
            for (let cs = 0; cs < cell.colspan; cs++) {
                gridRow.push(cell.content);
                if (cell.rowspan > 1) {
                    pendingRowspans[colIdx] = { value: cell.content, remaining: cell.rowspan - 1 };
                }
                colIdx++;
            }
        }

        if (gridRow.length > 0) grid.push(gridRow);
    }

    return { caption, rows: grid };
}

/**
 * Strip all HTML tags from a string.
 * Also decode common HTML entities.
 */
function stripTags(html) {
    return html
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

/**
 * Convert a parsed table grid to a Markdown table string.
 * Handles single-column tables (layout tables) as plain paragraphs.
 *
 * @param {{ caption: string, rows: string[][] }} parsed
 * @returns {string}
 */
function gridToMarkdown({ caption, rows }) {
    if (rows.length === 0) return '';

    const maxCols = Math.max(...rows.map(r => r.length));

    // Single-column layout table → plain paragraphs
    if (maxCols <= 1) {
        const text = rows.map(r => r.join(' ')).filter(Boolean).join('\n\n');
        return caption ? `**${caption}**\n\n${text}` : text;
    }

    // Normalize all rows to the same width
    const normalized = rows.map(row => {
        const r = [...row];
        while (r.length < maxCols) r.push('');
        return r;
    });

    const lines = [];
    if (caption) lines.push(`**${caption}**\n`);

    // First row = header
    lines.push('| ' + normalized[0].join(' | ') + ' |');
    lines.push('| ' + normalized[0].map(() => '---').join(' | ') + ' |');

    for (let i = 1; i < normalized.length; i++) {
        lines.push('| ' + normalized[i].join(' | ') + ' |');
    }

    return lines.join('\n');
}

/**
 * Replace all <table>...</table> blocks in text with clean Markdown tables.
 * No HTML tags remain in the output.
 *
 * @param {string} text
 * @returns {string}
 */
function convertAllHtmlTablesToMarkdown(text) {
    if (!text || !/<table/i.test(text)) return text;

    return text.replace(/<table[\s\S]*?<\/table>/gi, (tableHtml) => {
        try {
            const parsed = parseHtmlTable(tableHtml);
            if (parsed.rows.length === 0) return '';
            return '\n\n' + gridToMarkdown(parsed) + '\n\n';
        } catch (e) {
            // Last resort: strip all tags from the table block
            return '\n\n' + stripTags(tableHtml).replace(/\s+/g, ' ').trim() + '\n\n';
        }
    });
}

// ── Azure DI artifact cleanup ────────────────────────────────────────────────

/**
 * Clean Azure Document Intelligence Markdown output.
 *
 * Removes:
 *   - Structural comments: <!-- PageBreak -->, <!-- PageHeader -->, etc.
 *   - Checkbox markers: :selected:, :unselected:
 *   - Figure placeholder lines: :figureX:
 *   - Converts all HTML tables to Markdown
 *   - Normalises excessive blank lines (max 2 consecutive)
 *
 * @param {string} text — raw Azure DI content string
 * @returns {string} clean Markdown
 */
function cleanAzureDocMarkdown(text) {
    if (!text) return '';

    let out = text;

    // 1. Strip Azure DI structural HTML comments
    out = out.replace(/<!--\s*Page(?:Break|Header|Footer|Number)[^>]*-->/gi, '\n');

    // 2. Strip checkbox markers
    out = out.replace(/:(?:selected|unselected):/g, '');

    // 3. Strip figure markers (lines like ":figureX:" or ":figure1:" that are Azure placeholders)
    out = out.replace(/^:figure\w*:\s*$/gm, '');

    // 4. Convert ALL HTML tables → Markdown (zero HTML left)
    out = convertAllHtmlTablesToMarkdown(out);

    // 5. Ensure no residual HTML tags remain (strip any stragglers)
    out = out.replace(/<[a-zA-Z][^>]*>/g, '').replace(/<\/[a-zA-Z]+>/g, '');

    // 6. Normalise excessive blank lines (max 2 consecutive empty lines)
    out = out.replace(/\n{4,}/g, '\n\n\n');

    // 7. Strip orphaned single characters on their own line (Azure DI artifacts like lone 'S', 'A', etc.)
    out = out.replace(/^\s*[A-Z]\s*$/gm, '');

    // 8. Trim trailing whitespace per line
    out = out.replace(/[ \t]+$/gm, '');

    return out.trim();
}

module.exports = {
    cleanAzureDocMarkdown,
    convertAllHtmlTablesToMarkdown,
    stripTags,
};
