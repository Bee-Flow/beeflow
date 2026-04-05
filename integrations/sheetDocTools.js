/**
 * Sheet Document Tools
 * Provides sheet_read_cells, sheet_write_cells, sheet_write_range, and sheet_add_source
 * tools for AI interaction with the spreadsheet grid editor.
 *
 * Unlike notebook tools (which operate on HTML), these operate on a JSON cell map:
 *   { "A1": { value: "Hello", formula: null, style: {} }, "B2": { value: 42, formula: "=SUM(B1:B1)" } }
 */

const SHEET_DOC_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'sheet_read_cells',
            description: 'Read the current content of the spreadsheet. Returns all cell data as a JSON object. Optionally specify a range like "A1:D10" to read a subset, or omit to read the entire active sheet.\n\nThe response contains cells as { "A1": { value, formula, style }, ... } plus sheet metadata.',
            parameters: {
                type: 'object',
                properties: {
                    range: {
                        type: 'string',
                        description: 'Optional cell range to read (e.g. "A1:D10", "B:B" for entire column, "3:3" for entire row). Omit to read all cells.'
                    },
                    sheetIndex: {
                        type: 'integer',
                        description: 'Optional 0-based sheet tab index. Defaults to 0 (first sheet).'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'sheet_write_cells',
            description: 'Write values to specific cells in the spreadsheet. Provide a map of cell references to values. Use this for targeted edits to individual cells.\n\nExamples:\n- { "cells": { "A1": "Name", "B1": "Age", "A2": "Alice", "B2": 30 } }\n- { "cells": { "C1": { "value": 100, "formula": "=A1+B1" } } }\n\nValues can be strings, numbers, booleans, or objects with { value, formula, style }.',
            parameters: {
                type: 'object',
                properties: {
                    cells: {
                        type: 'object',
                        description: 'Map of cell references to values. Keys are cell refs like "A1", "B2". Values can be primitives (string/number/boolean) or objects { value, formula, style }.'
                    },
                    sheetIndex: {
                        type: 'integer',
                        description: 'Optional 0-based sheet tab index. Defaults to 0.'
                    }
                },
                required: ['cells']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'sheet_write_range',
            description: 'Write a 2D array of data starting at a specific cell. Perfect for pasting tables, CSV data, or generating structured datasets.\n\nExample: { "startCell": "A1", "data": [["Name", "Age", "City"], ["Alice", 30, "NYC"], ["Bob", 25, "LA"]] }\n\nThe first row can be headers. Data fills right and down from startCell.',
            parameters: {
                type: 'object',
                properties: {
                    startCell: {
                        type: 'string',
                        description: 'The top-left cell reference to start writing from (e.g. "A1", "C5").'
                    },
                    data: {
                        type: 'array',
                        description: 'A 2D array of values. Each inner array is a row. Values can be strings, numbers, booleans, or null.',
                        items: {
                            type: 'array',
                            items: {}
                        }
                    },
                    sheetIndex: {
                        type: 'integer',
                        description: 'Optional 0-based sheet tab index. Defaults to 0.'
                    }
                },
                required: ['startCell', 'data']
            }
        }
    }
];

/**
 * Tool to add web search results or other text directly as a sheet source.
 */
const SHEET_ADD_SOURCE_TOOL = {
    type: 'function',
    function: {
        name: 'sheet_add_source',
        description: 'Add content as a new source to the spreadsheet. Use this to save web search results, research findings, or any text content as a spreadsheet source for future reference. The content will be indexed and available for AI queries.',
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'A short descriptive name for the source (e.g. "Web Search: Sales Data 2025", "Product Catalog")'
                },
                content: {
                    type: 'string',
                    description: 'The full text content to add as a source.'
                }
            },
            required: ['name', 'content']
        }
    }
};

// ─── Cell Reference Helpers ──────────────────────────────────────

/**
 * Parse a cell reference like "A1" into { col: 0, row: 0 }
 */
function parseCellRef(ref) {
    const match = ref.match(/^([A-Z]+)(\d+)$/i);
    if (!match) return null;
    const colStr = match[1].toUpperCase();
    const row = parseInt(match[2], 10) - 1; // 0-based
    let col = 0;
    for (let i = 0; i < colStr.length; i++) {
        col = col * 26 + (colStr.charCodeAt(i) - 64);
    }
    col -= 1; // 0-based
    return { col, row };
}

/**
 * Convert { col, row } (0-based) to cell reference like "A1"
 */
function toCellRef(col, row) {
    let colStr = '';
    let c = col + 1;
    while (c > 0) {
        c--;
        colStr = String.fromCharCode(65 + (c % 26)) + colStr;
        c = Math.floor(c / 26);
    }
    return `${colStr}${row + 1}`;
}

/**
 * Parse a range like "A1:D10" into { startCol, startRow, endCol, endRow }
 */
function parseRange(range) {
    const parts = range.split(':');
    if (parts.length !== 2) return null;
    const start = parseCellRef(parts[0]);
    const end = parseCellRef(parts[1]);
    if (!start || !end) return null;
    return {
        startCol: Math.min(start.col, end.col),
        startRow: Math.min(start.row, end.row),
        endCol: Math.max(start.col, end.col),
        endRow: Math.max(start.row, end.row),
    };
}

/**
 * Check if a cell ref falls within a range.
 */
function cellInRange(cellRef, range) {
    const cell = parseCellRef(cellRef);
    if (!cell) return false;
    return cell.col >= range.startCol && cell.col <= range.endCol &&
           cell.row >= range.startRow && cell.row <= range.endRow;
}

// ─── Tool Executor ───────────────────────────────────────────────

/**
 * Execute a sheet document tool call.
 * @param {string} toolName - The tool function name
 * @param {object} args - Tool arguments
 * @param {Array} sheetsContent - The sheets_content JSON array from the store
 * @returns {object} Tool result
 */
function executeSheetDocTool(toolName, args, sheetsContent) {
    const sheets = Array.isArray(sheetsContent) ? sheetsContent : [];
    const sheetIdx = args.sheetIndex || 0;
    const activeSheet = sheets[sheetIdx];

    if (toolName === 'sheet_read_cells') {
        if (!activeSheet) {
            return { cells: {}, message: 'The spreadsheet is empty — no sheets exist yet.' };
        }

        const cells = activeSheet.cells || {};
        const range = args.range;

        if (!range) {
            // Return all cells
            const cellCount = Object.keys(cells).length;
            if (cellCount === 0) {
                return {
                    sheetName: activeSheet.name,
                    cells: {},
                    message: 'The sheet is empty — no cells have data yet.'
                };
            }

            // Build a simplified view for the AI
            const simpleCells = {};
            for (const [ref, cell] of Object.entries(cells)) {
                if (typeof cell === 'object' && cell !== null) {
                    simpleCells[ref] = cell.formula || cell.value;
                } else {
                    simpleCells[ref] = cell;
                }
            }

            return {
                sheetName: activeSheet.name,
                cells: simpleCells,
                cellCount,
                message: `Sheet "${activeSheet.name}" has ${cellCount} cells with data.`
            };
        }

        // Filter by range
        const parsed = parseRange(range);
        if (!parsed) {
            return { error: `Invalid range format: "${range}". Use format like "A1:D10".` };
        }

        const filteredCells = {};
        for (const [ref, cell] of Object.entries(cells)) {
            if (cellInRange(ref, parsed)) {
                if (typeof cell === 'object' && cell !== null) {
                    filteredCells[ref] = cell.formula || cell.value;
                } else {
                    filteredCells[ref] = cell;
                }
            }
        }

        return {
            sheetName: activeSheet.name,
            range,
            cells: filteredCells,
            cellCount: Object.keys(filteredCells).length,
        };
    }

    if (toolName === 'sheet_write_cells') {
        const inputCells = args.cells;
        if (!inputCells || typeof inputCells !== 'object') {
            return { error: 'cells parameter is required and must be an object.' };
        }

        // Normalize cell values
        const normalizedCells = {};
        for (const [ref, val] of Object.entries(inputCells)) {
            const upperRef = ref.toUpperCase();
            if (!parseCellRef(upperRef)) {
                return { error: `Invalid cell reference: "${ref}". Use format like "A1", "B2".` };
            }
            if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
                normalizedCells[upperRef] = {
                    value: val.value ?? '',
                    formula: val.formula || null,
                    style: val.style || {},
                };
            } else {
                normalizedCells[upperRef] = {
                    value: val ?? '',
                    formula: null,
                    style: {},
                };
            }
        }

        const cellCount = Object.keys(normalizedCells).length;
        return {
            _action: 'sheet_doc_update',
            cells: normalizedCells,
            sheetIndex: sheetIdx,
            message: `Updated ${cellCount} cell${cellCount !== 1 ? 's' : ''} in the spreadsheet.`
        };
    }

    if (toolName === 'sheet_write_range') {
        const startCell = args.startCell;
        const data = args.data;

        if (!startCell || !data || !Array.isArray(data)) {
            return { error: 'startCell and data (2D array) are required.' };
        }

        const start = parseCellRef(startCell.toUpperCase());
        if (!start) {
            return { error: `Invalid start cell: "${startCell}". Use format like "A1".` };
        }

        // Convert 2D array to cell map
        const normalizedCells = {};
        let cellCount = 0;
        for (let rowIdx = 0; rowIdx < data.length; rowIdx++) {
            const row = data[rowIdx];
            if (!Array.isArray(row)) continue;
            for (let colIdx = 0; colIdx < row.length; colIdx++) {
                const val = row[colIdx];
                if (val === null || val === undefined) continue;
                const ref = toCellRef(start.col + colIdx, start.row + rowIdx);
                normalizedCells[ref] = {
                    value: val,
                    formula: null,
                    style: {},
                };
                cellCount++;
            }
        }

        const endRef = toCellRef(
            start.col + (data[0]?.length || 1) - 1,
            start.row + data.length - 1
        );

        return {
            _action: 'sheet_doc_update',
            cells: normalizedCells,
            sheetIndex: sheetIdx,
            message: `Wrote ${data.length} rows × ${data[0]?.length || 0} columns (${cellCount} cells) to range ${startCell.toUpperCase()}:${endRef}.`
        };
    }

    if (toolName === 'sheet_add_source') {
        const name = args.name;
        const content = args.content;
        if (!name || !content) {
            return { error: 'Both name and content are required.' };
        }
        return {
            _action: 'sheet_add_source',
            name,
            content,
            message: `Source "${name}" will be added to the spreadsheet's knowledge base.`
        };
    }

    return { error: `Unknown sheet document tool: ${toolName}` };
}

module.exports = { SHEET_DOC_TOOLS, SHEET_ADD_SOURCE_TOOL, executeSheetDocTool, parseCellRef, toCellRef, parseRange };
