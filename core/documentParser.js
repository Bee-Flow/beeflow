/**
 * Document Parser — Central module for extracting text from uploaded documents.
 * 
 * Supports: PDF (via Mistral OCR / pdf-parse), DOCX (mammoth), CSV/XLSX (xlsx).
 * All binary formats are converted to readable text/markdown for LLM consumption.
 */

const mammoth = require('mammoth');
const XLSX = require('xlsx');

/**
 * Parse a document buffer into plain text based on its MIME type.
 * 
 * @param {Buffer} buffer - Raw file content
 * @param {string} mimeType - File MIME type
 * @param {string} filename - Original filename (for logging / headers)
 * @param {Object} [options] - Parsing options (e.g. returnHtml)
 * @returns {Promise<string>} Extracted text content
 */
async function parseDocument(buffer, mimeType, filename, options = {}) {
    const type = (mimeType || '').toLowerCase();

    // ── DOCX ──
    if (
        type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        filename?.toLowerCase().endsWith('.docx')
    ) {
        return parseDocx(buffer, filename, options);
    }

    // ── XLSX / XLS ──
    if (
        type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        type === 'application/vnd.ms-excel' ||
        filename?.toLowerCase().endsWith('.xlsx') ||
        filename?.toLowerCase().endsWith('.xls')
    ) {
        return parseSpreadsheet(buffer, filename);
    }

    // ── CSV ──
    if (
        type === 'text/csv' ||
        type === 'application/csv' ||
        filename?.toLowerCase().endsWith('.csv')
    ) {
        return parseSpreadsheet(buffer, filename);
    }

    // ── PDF ── (fallback parser using pdf-parse; Mistral OCR handled upstream)
    if (type === 'application/pdf' || filename?.toLowerCase().endsWith('.pdf')) {
        return parsePdf(buffer, filename);
    }

    // ── Text-based (txt, md, json, code, etc.) ──
    return buffer.toString('utf-8');
}

// ── DOCX Parser ─────────────────────────────────────────────────
async function parseDocx(buffer, filename, options = {}) {
    try {
        const result = options.returnHtml 
            ? await mammoth.convertToHtml({ buffer }) 
            : await mammoth.extractRawText({ buffer });
        const text = result.value || '';
        if (!text.trim()) {
            console.log(`[DocumentParser] DOCX file "${filename}" is empty or contains only images`);
            return `[Document: ${filename} — no extractable text content]`;
        }
        console.log(`[DocumentParser] Extracted ${text.length} chars from DOCX: ${filename}`);
        return text;
    } catch (err) {
        console.error(`[DocumentParser] Failed to parse DOCX "${filename}":`, err.message);
        return `[Document: ${filename} — failed to parse DOCX: ${err.message}]`;
    }
}

// ── Spreadsheet Parser (XLSX / XLS / CSV) ───────────────────────
function parseSpreadsheet(buffer, filename) {
    try {
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const sheets = workbook.SheetNames;

        if (sheets.length === 0) {
            return `[Spreadsheet: ${filename} — no sheets found]`;
        }

        const parts = [];

        for (const sheetName of sheets) {
            const sheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

            if (jsonData.length === 0) {
                parts.push(`### Sheet: ${sheetName}\n(empty)`);
                continue;
            }

            // Convert to Markdown table
            const headers = jsonData[0].map(h => String(h || '').trim() || '—');
            const divider = headers.map(() => '---');
            const rows = jsonData.slice(1);

            let table = `| ${headers.join(' | ')} |\n| ${divider.join(' | ')} |\n`;

            // Cap at 200 rows to avoid token explosion
            const maxRows = Math.min(rows.length, 200);
            for (let i = 0; i < maxRows; i++) {
                const cells = rows[i].map(c => String(c ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '));
                // Pad to match header length
                while (cells.length < headers.length) cells.push('');
                table += `| ${cells.join(' | ')} |\n`;
            }

            if (rows.length > maxRows) {
                table += `\n*...and ${rows.length - maxRows} more rows (truncated)*\n`;
            }

            if (sheets.length > 1) {
                parts.push(`### Sheet: ${sheetName}\n${table}`);
            } else {
                parts.push(table);
            }
        }

        const result = parts.join('\n\n');
        console.log(`[DocumentParser] Parsed spreadsheet "${filename}": ${sheets.length} sheet(s), ${result.length} chars`);
        return result;
    } catch (err) {
        console.error(`[DocumentParser] Failed to parse spreadsheet "${filename}":`, err.message);
        return `[Spreadsheet: ${filename} — failed to parse: ${err.message}]`;
    }
}

// ── PDF Fallback Parser (when Mistral OCR is unavailable) ───────
async function parsePdf(buffer, filename) {
    try {
        const { PDFParse } = require('pdf-parse');
        const parser = new PDFParse({ verbosity: 0 });
        await parser.load(buffer);
        const text = await parser.getText();
        if (!text || !text.trim()) {
            return `[PDF: ${filename} — no extractable text (may be image-based)]`;
        }
        console.log(`[DocumentParser] Extracted ${text.length} chars from PDF: ${filename}`);
        return text;
    } catch (err) {
        console.error(`[DocumentParser] Failed to parse PDF "${filename}":`, err.message);
        return `[PDF: ${filename} — failed to parse: ${err.message}]`;
    }
}

/**
 * Check if a MIME type / filename represents a document we can parse.
 * Useful for UI hints and validation.
 */
function isSupportedDocument(mimeType, filename) {
    const type = (mimeType || '').toLowerCase();
    const name = (filename || '').toLowerCase();

    return (
        type === 'application/pdf' ||
        type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        type === 'application/vnd.ms-excel' ||
        type === 'text/csv' ||
        type === 'application/csv' ||
        type.startsWith('text/') ||
        name.endsWith('.pdf') ||
        name.endsWith('.docx') ||
        name.endsWith('.xlsx') ||
        name.endsWith('.xls') ||
        name.endsWith('.csv')
    );
}

module.exports = {
    parseDocument,
    isSupportedDocument
};
