/**
 * Sheets Export Routes — server-side XLSX, CSV, and PDF generation.
 *
 * POST /api/sheets/:id/export/xlsx  — generate Excel workbook
 * POST /api/sheets/:id/export/csv   — generate CSV file
 * POST /api/sheets/:id/export/pdf   — render sheet as PDF table via Playwright
 *
 * Mirrors notebookExport.js / slidesExport.js pattern.
 */

const express = require('express');
const router = express.Router();

function requireAuth(req, res, next) {
    if (req.session?.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Convert sheets_content JSON to a 2D array for export.
 * Returns { headers: string[], rows: any[][] }
 */
function sheetsContentToTable(sheetsContent, sheetIndex = 0) {
    const sheet = Array.isArray(sheetsContent) ? sheetsContent[sheetIndex] : null;
    if (!sheet || !sheet.cells) return { headers: [], rows: [], sheetName: 'Sheet 1' };

    const cells = sheet.cells;
    const refs = Object.keys(cells);
    if (refs.length === 0) return { headers: [], rows: [], sheetName: sheet.name || 'Sheet 1' };

    // Find the bounds of the data
    let maxCol = 0, maxRow = 0;
    const cellData = {};
    for (const ref of refs) {
        const match = ref.match(/^([A-Z]+)(\d+)$/i);
        if (!match) continue;
        const colStr = match[1].toUpperCase();
        const row = parseInt(match[2], 10) - 1;
        let col = 0;
        for (let i = 0; i < colStr.length; i++) {
            col = col * 26 + (colStr.charCodeAt(i) - 64);
        }
        col -= 1;
        maxCol = Math.max(maxCol, col);
        maxRow = Math.max(maxRow, row);
        const cell = cells[ref];
        cellData[`${col},${row}`] = typeof cell === 'object' && cell !== null ? (cell.value ?? '') : cell;
    }

    // Build 2D array
    const allRows = [];
    for (let r = 0; r <= maxRow; r++) {
        const row = [];
        for (let c = 0; c <= maxCol; c++) {
            row.push(cellData[`${c},${r}`] ?? '');
        }
        allRows.push(row);
    }

    return {
        headers: allRows[0] || [],
        rows: allRows,
        sheetName: sheet.name || 'Sheet 1',
    };
}

// ── CSV Export ───────────────────────────────────────────────────────────────

router.post('/:id/export/csv', requireAuth, async (req, res) => {
    try {
        const sheetStore = require('../stores/sheetStore');
        const sheet = await sheetStore.getSpreadsheet(req.params.id, req.session.user.id);
        if (!sheet) return res.status(404).json({ error: 'Spreadsheet not found' });

        const { rows, sheetName } = sheetsContentToTable(sheet.sheetsContent, req.body.sheetIndex || 0);

        // Convert to CSV
        const csvLines = rows.map(row =>
            row.map(cell => {
                const str = String(cell ?? '');
                // Escape cells containing commas, quotes, or newlines
                if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                    return `"${str.replace(/"/g, '""')}"`;
                }
                return str;
            }).join(',')
        );
        const csv = csvLines.join('\n');

        const safeFilename = (sheet.name || 'spreadsheet').replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim();
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.csv"`);
        res.send(csv);

    } catch (err) {
        console.error('[Sheets Export] CSV generation failed:', err);
        res.status(500).json({ error: 'CSV export failed: ' + err.message });
    }
});

// ── XLSX Export ──────────────────────────────────────────────────────────────

router.post('/:id/export/xlsx', requireAuth, async (req, res) => {
    try {
        const sheetStore = require('../stores/sheetStore');
        const sheet = await sheetStore.getSpreadsheet(req.params.id, req.session.user.id);
        if (!sheet) return res.status(404).json({ error: 'Spreadsheet not found' });

        let ExcelJS;
        try {
            ExcelJS = require('exceljs');
        } catch (e) {
            console.error('[Sheets Export] ExcelJS not available');
            return res.status(500).json({ error: 'XLSX export requires exceljs. Install with: npm install exceljs' });
        }

        const workbook = new ExcelJS.Workbook();
        workbook.creator = req.session.user.name || req.session.user.email || '';
        workbook.created = new Date();

        const sheetsContent = sheet.sheetsContent || [];
        for (let i = 0; i < sheetsContent.length; i++) {
            const { rows, sheetName } = sheetsContentToTable(sheetsContent, i);
            const worksheet = workbook.addWorksheet(sheetName);

            for (const row of rows) {
                worksheet.addRow(row);
            }

            // Auto-fit column widths (approximate)
            worksheet.columns.forEach(col => {
                let maxLen = 10;
                col.eachCell({ includeEmpty: false }, cell => {
                    const len = String(cell.value || '').length;
                    if (len > maxLen) maxLen = len;
                });
                col.width = Math.min(maxLen + 2, 50);
            });

            // Style header row
            if (rows.length > 0) {
                const headerRow = worksheet.getRow(1);
                headerRow.font = { bold: true };
                headerRow.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFE8E8E8' },
                };
            }
        }

        const buffer = await workbook.xlsx.writeBuffer();

        const safeFilename = (sheet.name || 'spreadsheet').replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.xlsx"`);
        res.setHeader('Content-Length', buffer.length);
        res.send(Buffer.from(buffer));

    } catch (err) {
        console.error('[Sheets Export] XLSX generation failed:', err);
        res.status(500).json({ error: 'XLSX export failed: ' + err.message });
    }
});

// ── PDF Export (Playwright) ──────────────────────────────────────────────────

router.post('/:id/export/pdf', requireAuth, async (req, res) => {
    try {
        const sheetStore = require('../stores/sheetStore');
        const sheet = await sheetStore.getSpreadsheet(req.params.id, req.session.user.id);
        if (!sheet) return res.status(404).json({ error: 'Spreadsheet not found' });

        let playwright;
        try {
            playwright = require('playwright');
        } catch (e) {
            return res.status(500).json({ error: 'PDF export requires Playwright.' });
        }

        const { rows, sheetName } = sheetsContentToTable(sheet.sheetsContent, req.body.sheetIndex || 0);

        // Build HTML table
        let tableHtml = '';
        if (rows.length > 0) {
            tableHtml += '<table>';
            // Header row
            tableHtml += '<thead><tr>';
            for (const cell of rows[0]) {
                tableHtml += `<th>${String(cell ?? '').replace(/</g, '&lt;')}</th>`;
            }
            tableHtml += '</tr></thead>';
            // Data rows
            tableHtml += '<tbody>';
            for (let i = 1; i < rows.length; i++) {
                tableHtml += '<tr>';
                for (const cell of rows[i]) {
                    const val = String(cell ?? '');
                    const isNum = !isNaN(cell) && cell !== '' && cell !== null;
                    tableHtml += `<td${isNum ? ' class="num"' : ''}>${val.replace(/</g, '&lt;')}</td>`;
                }
                tableHtml += '</tr>';
            }
            tableHtml += '</tbody></table>';
        }

        const title = sheet.name || 'Spreadsheet';
        const exportHTML = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>${title}</title>
<style>
    body { font-family: 'Calibri', Arial, sans-serif; font-size: 10pt; color: #1a1a1a; margin: 0; padding: 20px; }
    h1 { font-size: 16pt; color: #111; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #d0d0d0; padding: 6px 10px; text-align: left; }
    th { background: #f0f0f0; font-weight: 600; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.3px; }
    td { font-size: 10pt; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    tr:nth-child(even) { background: #fafafa; }
</style>
</head><body>
<h1>${title}</h1>
${tableHtml}
</body></html>`;

        let browser = null;
        try {
            browser = await playwright.chromium.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            });

            const context = await browser.newContext();
            const page = await context.newPage();
            await page.setContent(exportHTML, { waitUntil: 'networkidle' });

            const pdfBuffer = await page.pdf({
                format: 'Letter',
                landscape: rows[0]?.length > 6, // landscape for wide tables
                margin: { top: '0.5in', right: '0.5in', bottom: '0.7in', left: '0.5in' },
                printBackground: true,
                displayHeaderFooter: true,
                headerTemplate: `<div style="font-size:8px;color:#999;width:100%;padding:0 0.5in;display:flex;justify-content:space-between;">
                    <span>${title.replace(/"/g, '&quot;')}</span><span></span>
                </div>`,
                footerTemplate: `<div style="font-size:8px;color:#bbb;width:100%;padding:0 0.5in;display:flex;justify-content:space-between;">
                    <span>Generated by BeeFlow</span>
                    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
                </div>`,
            });

            const safeFilename = title.replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim();
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.pdf"`);
            res.setHeader('Content-Length', pdfBuffer.length);
            res.send(pdfBuffer);
        } finally {
            if (browser) try { await browser.close(); } catch (e) { }
        }

    } catch (err) {
        console.error('[Sheets Export] PDF generation failed:', err);
        res.status(500).json({ error: 'PDF export failed: ' + err.message });
    }
});

module.exports = router;
