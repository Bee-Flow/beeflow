/**
 * Google Sheets Tools — Built-in tools for AI to create/read/update spreadsheets
 *
 * Provides:
 * - Create spreadsheets (draft → user approval)
 * - Read values from ranges (immediate)
 * - Append rows (draft → user approval)
 * - Update cells (draft → user approval)
 * - List sheets in a spreadsheet
 *
 * Write operations use a draft/approval flow: the AI proposes data,
 * the user can edit it in an inline table editor, then confirms.
 */

const { google } = require('googleapis');
const { loadConfig } = require('../auth/permissions');

// ─── Tool Definitions (for LLM tool-use) ──────────────────────

const SHEETS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'sheets_create',
            description: 'Create a new Google Spreadsheet with optional initial data. The user will review and edit the proposed data before the spreadsheet is created. Use initialData to propose headers and sample rows. Formulas (e.g. "=SUM(B2:B10)") are fully supported in cell values. ALWAYS specify columnTypes to define how each column should be formatted (e.g. currency_eur for euro amounts, percent for growth rates, date for dates).',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Title for the new spreadsheet' },
                    sheetNames: {
                        type: 'array', items: { type: 'string' },
                        description: 'Optional names for sheets (tabs) to create. Defaults to a single "Sheet1".'
                    },
                    initialData: {
                        type: 'array',
                        items: { type: 'array', items: { type: 'string' } },
                        description: 'Optional 2D array of initial data. First row is typically headers. Subsequent rows are data. Formulas like "=SUM(B2:B10)" are supported. Example: [["Name","Amount","Tax"],["Alice","500","=B2*0.21"],["Bob","750","=B3*0.21"],["Total","=SUM(B2:B3)","=SUM(C2:C3)"]]'
                    },
                    columnTypes: {
                        type: 'array',
                        items: { type: 'string', enum: ['text', 'integer', 'decimal', 'currency', 'currency_eur', 'percent', 'date'] },
                        description: 'REQUIRED: Data type for each column, matching the order of columns in initialData. Controls how cells are formatted in the UI. Examples: ["text","currency_eur","currency_eur","currency_eur","percent"] for a sales sheet with Month, Revenue(€), Expenses(€), Profit(€), Growth(%).'
                    },
                    folderId: { type: 'string', description: 'Optional Drive folder ID to move the spreadsheet into' },
                    chartConfig: {
                        type: 'object',
                        description: 'Optional chart configuration. Only include when the user asks for a chart or visualization. The AI picks the best chart type and column mapping.',
                        properties: {
                            type: { type: 'string', enum: ['bar', 'line', 'pie'], description: 'Chart type that best fits the data' },
                            title: { type: 'string', description: 'Chart title' },
                            labelColumn: { type: 'integer', description: 'Column index (0-based) for X-axis labels (typically the row names/categories column)' },
                            dataColumns: { type: 'array', items: { type: 'integer' }, description: 'Column indices (0-based) for data series to plot' },
                        },
                        required: ['type', 'labelColumn', 'dataColumns']
                    },
                },
                required: ['title']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'sheets_get_values',
            description: 'Read cell values from a spreadsheet range (e.g. "Sheet1!A1:D10").',
            parameters: {
                type: 'object',
                properties: {
                    spreadsheetId: { type: 'string', description: 'The spreadsheet ID' },
                    range: { type: 'string', description: 'A1 notation range, e.g. "Sheet1!A1:D10" or "Sheet1"' },
                },
                required: ['spreadsheetId', 'range']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'sheets_append_rows',
            description: 'Append one or more rows to an existing spreadsheet. The user reviews and can edit the proposed rows before they are added. Formulas are supported.',
            parameters: {
                type: 'object',
                properties: {
                    spreadsheetId: { type: 'string', description: 'The spreadsheet ID' },
                    range: { type: 'string', description: 'Target sheet/range, e.g. "Sheet1" or "Invoices!A:Z"' },
                    rows: {
                        type: 'array',
                        items: { type: 'array', items: { type: 'string' } },
                        description: 'Array of rows, each row is an array of cell values. Formulas like "=SUM(A1:A5)" are supported.'
                    },
                    chartConfig: {
                        type: 'object',
                        description: 'Optional chart configuration. Only include when the user asks for a chart.',
                        properties: {
                            type: { type: 'string', enum: ['bar', 'line', 'pie'], description: 'Chart type' },
                            title: { type: 'string', description: 'Chart title' },
                            labelColumn: { type: 'integer', description: 'Column index (0-based) for labels' },
                            dataColumns: { type: 'array', items: { type: 'integer' }, description: 'Column indices (0-based) for data series' },
                        },
                        required: ['type', 'labelColumn', 'dataColumns']
                    },
                },
                required: ['spreadsheetId', 'range', 'rows']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'sheets_update_values',
            description: 'Update specific cells in an existing spreadsheet range. The user reviews and can edit the proposed values before they are applied. Formulas are supported.',
            parameters: {
                type: 'object',
                properties: {
                    spreadsheetId: { type: 'string', description: 'The spreadsheet ID' },
                    range: { type: 'string', description: 'A1 notation range to update, e.g. "Sheet1!A1:D1"' },
                    values: {
                        type: 'array',
                        items: { type: 'array', items: { type: 'string' } },
                        description: 'Array of rows with cell values. Formulas are supported.'
                    },
                    chartConfig: {
                        type: 'object',
                        description: 'Optional chart configuration. Only include when the user asks for a chart.',
                        properties: {
                            type: { type: 'string', enum: ['bar', 'line', 'pie'], description: 'Chart type' },
                            title: { type: 'string', description: 'Chart title' },
                            labelColumn: { type: 'integer', description: 'Column index (0-based) for labels' },
                            dataColumns: { type: 'array', items: { type: 'integer' }, description: 'Column indices (0-based) for data series' },
                        },
                        required: ['type', 'labelColumn', 'dataColumns']
                    },
                },
                required: ['spreadsheetId', 'range', 'values']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'sheets_report',
            description: 'Generate a visual report/dashboard from spreadsheet data. Renders the report alongside the data. Use this when the user asks to analyze, visualize, or create a report from spreadsheet data. You can provide either a spreadsheetId to read data from Google Sheets, or provide the data directly via the values parameter. IMPORTANT: For KPI panels, ALWAYS use formula expressions like "=SUM(B2:B7)" or "=AVERAGE(E2:E7)" instead of hardcoded static values. Formulas make the report dynamic — values are computed from the data. Supported functions: SUM, AVERAGE, AVG, COUNT, MIN, MAX. Example formulas: "=SUM(B2:B7)" for total revenue, "=AVERAGE(D2:D7)" for average profit, "=MAX(E2:E7)" for peak growth.',
            parameters: {
                type: 'object',
                properties: {
                    spreadsheetId: { type: 'string', description: 'Optional: The Google Sheets spreadsheet ID to read data from. Skip if providing values directly.' },
                    range: { type: 'string', description: 'Optional: A1 notation range to read, e.g. "Sheet1". Required if spreadsheetId is provided.' },
                    values: {
                        type: 'array',
                        items: { type: 'array', items: { type: 'string' } },
                        description: 'Optional: Provide data directly as array of rows (first row = headers). Use this when you already have the data from a previous tool call.'
                    },
                    reportConfig: {
                        type: 'object',
                        description: 'Report configuration with title and array of panels',
                        properties: {
                            title: { type: 'string', description: 'Report title, e.g. "Q1 Sales Analysis"' },
                            panels: {
                                type: 'array',
                                description: 'Array of visualization panels. Pick panels that best represent the data. For KPIs, ALWAYS use formula expressions for the value (e.g. "=SUM(B2:B7)"), NEVER use static hardcoded numbers.',
                                items: {
                                    type: 'object',
                                    properties: {
                                        type: { type: 'string', enum: ['kpi', 'bar', 'line', 'pie', 'table'], description: 'Panel type' },
                                        title: { type: 'string', description: 'Panel title' },
                                        value: { type: 'string', description: 'For kpi: MUST be a formula like "=SUM(B2:B7)", "=AVERAGE(D2:D7)", "=MAX(E2:E7)". Do NOT put static numbers here — always use formulas so the report is dynamic.' },
                                        format: { type: 'string', enum: ['number', 'currency', 'currency_eur', 'percent'], description: 'For kpi: number format. Use currency_eur for euros (€), currency for dollars ($).' },
                                        color: { type: 'string', description: 'For kpi: accent color (hex)' },
                                        labelColumn: { type: 'integer', description: 'For charts: column index (0-based) for X-axis labels' },
                                        dataColumns: { type: 'array', items: { type: 'integer' }, description: 'For charts: column indices (0-based) for data series' },
                                        columns: { type: 'array', items: { type: 'integer' }, description: 'For table: column indices to show' },
                                        sortBy: { type: 'integer', description: 'For table: column index to sort by' },
                                        sortDir: { type: 'string', enum: ['asc', 'desc'], description: 'For table: sort direction' },
                                        limit: { type: 'integer', description: 'For table: max rows to show' },
                                    },
                                    required: ['type', 'title']
                                }
                            },
                            filters: {
                                type: 'array',
                                description: 'Optional: Columns users can filter by interactively (like Power BI slicers). Best for categorical text columns (e.g. Month, Region, Category). Filters are auto-detected if omitted.',
                                items: {
                                    type: 'object',
                                    properties: {
                                        column: { type: 'integer', description: 'Column index (0-based) to allow filtering on' },
                                        label: { type: 'string', description: 'Display label for the filter' }
                                    },
                                    required: ['column']
                                }
                            }
                        },
                        required: ['title', 'panels']
                    },
                },
                required: ['reportConfig']
            }
        }
    },
];

// ─── Sheets Client ─────────────────────────────────────────────

async function createSheetsClient(session) {
    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};

    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Google OAuth not configured');
    }

    const accessToken = session?.accessToken;
    if (!accessToken) {
        throw new Error('Not connected to Google Sheets — user must log in with Google');
    }

    const oauth2Client = new google.auth.OAuth2(
        providerConfig.clientId,
        providerConfig.clientSecret
    );

    oauth2Client.setCredentials({
        access_token: accessToken,
        refresh_token: session?.refreshToken,
    });

    oauth2Client.on('tokens', (tokens) => {
        if (tokens.access_token) session.accessToken = tokens.access_token;
        if (tokens.refresh_token) session.refreshToken = tokens.refresh_token;
        session.save?.();
    });

    return google.sheets({ version: 'v4', auth: oauth2Client });
}

// ─── Tool Execution (returns drafts for writes, immediate for reads) ────

async function executeSheetsTool(toolName, args, session) {
    switch (toolName) {
        case 'sheets_create': {
            const { title, sheetNames, initialData, columnTypes, folderId, chartConfig } = args;
            console.log(`[Sheets] Draft: create spreadsheet "${title}"`);

            return {
                _action: 'sheets_draft',
                _sheetsDraft: {
                    operation: 'create',
                    title,
                    sheetNames: (sheetNames && sheetNames.length > 0) ? sheetNames : ['Sheet1'],
                    initialData: initialData || [],
                    columnTypes: columnTypes || null,
                    folderId: folderId || null,
                    chartConfig: chartConfig || null,
                },
                message: `Spreadsheet "${title}" prepared for review. Edit the data below and confirm to create.`,
            };
        }

        case 'sheets_get_values': {
            // Read operations execute immediately — no draft needed
            const sheets = await createSheetsClient(session);
            const { spreadsheetId, range } = args;
            console.log(`[Sheets] Reading ${range} from ${spreadsheetId}`);

            const res = await sheets.spreadsheets.values.get({
                spreadsheetId,
                range,
            });

            const values = res.data.values || [];
            return {
                _action: 'sheets_result',
                _sheetsData: {
                    operation: 'read',
                    spreadsheetId,
                    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
                    range: res.data.range,
                    values: values.slice(0, 50),
                    totalRows: values.length,
                    truncated: values.length > 50,
                },
                range: res.data.range,
                values,
                rowCount: values.length,
            };
        }

        case 'sheets_append_rows': {
            const { spreadsheetId, range, rows, chartConfig } = args;
            console.log(`[Sheets] Draft: append ${rows.length} rows to ${range}`);

            return {
                _action: 'sheets_draft',
                _sheetsDraft: {
                    operation: 'append',
                    spreadsheetId,
                    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
                    range,
                    values: rows,
                    chartConfig: chartConfig || null,
                },
                message: `${rows.length} rows prepared for review. Edit the data and confirm to append.`,
            };
        }

        case 'sheets_update_values': {
            const { spreadsheetId, range, values, chartConfig } = args;
            console.log(`[Sheets] Draft: update ${range}`);

            return {
                _action: 'sheets_draft',
                _sheetsDraft: {
                    operation: 'update',
                    spreadsheetId,
                    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
                    range,
                    values,
                    chartConfig: chartConfig || null,
                },
                message: `Cell updates for ${range} prepared for review. Edit the data and confirm to apply.`,
            };
        }

        case 'sheets_report': {
            return handleSheetsReport(toolName, args, session);
        }

        default:
            throw new Error(`Unknown sheets tool: ${toolName}`);
    }
}

// ─── Sheets Report Handler ─────────────────────────────────────
// Reads spreadsheet data and returns it with the AI's report config

async function handleSheetsReport(toolName, args, session) {
    if (toolName !== 'sheets_report') return null;

    const { spreadsheetId, range, reportConfig, values: inlineValues } = args;

    let values;
    let sheetUrl = null;
    let dataRange = range || 'inline';

    if (inlineValues && inlineValues.length > 0) {
        // Use inline data provided by the AI
        console.log(`[Sheets] Report: using inline data (${inlineValues.length} rows)`);
        values = inlineValues;
    } else if (spreadsheetId && range) {
        // Read from Google Sheets
        const sheets = await createSheetsClient(session);
        console.log(`[Sheets] Report: reading ${range} from ${spreadsheetId}`);
        const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
        values = res.data.values || [];
        sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
        dataRange = res.data.range;
    } else {
        throw new Error('sheets_report requires either spreadsheetId+range or inline values');
    }

    const maxRows = 1000;
    const header = values[0] || [];
    const dataRows = values.slice(1);
    const truncated = dataRows.length > maxRows;
    const limitedValues = [header, ...dataRows.slice(0, maxRows)];

    return {
        _action: 'sheets_report',
        _sheetsReport: {
            spreadsheetId: spreadsheetId || null,
            url: sheetUrl,
            range: dataRange,
            values: limitedValues,
            totalRows: values.length,
            truncated,
            reportConfig,
        },
        range: dataRange,
        rowCount: values.length,
        message: `Report "${reportConfig.title}" generated with ${reportConfig.panels.length} panels from ${dataRows.length} rows.`,
    };
}

// ─── Execute Confirmed Draft ───────────────────────────────────
// Called from /api/integrations/sheets/execute after user approval

async function executeSheetsAction(action, session) {
    const sheets = await createSheetsClient(session);

    if (action.operation === 'create') {
        const sheetProps = (action.sheetNames && action.sheetNames.length > 0)
            ? action.sheetNames.map(name => ({ properties: { title: name } }))
            : [{ properties: { title: 'Sheet1' } }];

        const res = await sheets.spreadsheets.create({
            requestBody: {
                properties: { title: action.title },
                sheets: sheetProps,
            },
        });

        const spreadsheetId = res.data.spreadsheetId;
        const spreadsheetUrl = res.data.spreadsheetUrl;

        // Move to folder if specified
        if (action.folderId) {
            try {
                const { createDriveClient } = require('./driveTools');
                const drive = await createDriveClient(session);
                const file = await drive.files.get({ fileId: spreadsheetId, fields: 'parents', supportsAllDrives: true });
                const prevParents = (file.data.parents || []).join(',');
                await drive.files.update({
                    fileId: spreadsheetId,
                    addParents: action.folderId,
                    removeParents: prevParents,
                    supportsAllDrives: true,
                });
            } catch (e) {
                console.warn(`[Sheets] Could not move to folder ${action.folderId}:`, e.message);
            }
        }

        // Populate initial data if provided
        if (action.initialData && action.initialData.length > 0) {
            const targetSheet = (action.sheetNames && action.sheetNames.length > 0) ? action.sheetNames[0] : 'Sheet1';
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${targetSheet}!A1`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: action.initialData },
            });
        }

        return {
            spreadsheetId,
            url: spreadsheetUrl,
            title: action.title,
            sheets: action.sheetNames || ['Sheet1'],
            rowsWritten: action.initialData?.length || 0,
        };

    } else if (action.operation === 'append') {
        const res = await sheets.spreadsheets.values.append({
            spreadsheetId: action.spreadsheetId,
            range: action.range,
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values: action.values },
        });

        return {
            updatedRange: res.data.updates?.updatedRange,
            updatedRows: res.data.updates?.updatedRows,
            updatedCells: res.data.updates?.updatedCells,
        };

    } else if (action.operation === 'update') {
        const res = await sheets.spreadsheets.values.update({
            spreadsheetId: action.spreadsheetId,
            range: action.range,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: action.values },
        });

        return {
            updatedRange: res.data.updatedRange,
            updatedRows: res.data.updatedRows,
            updatedCells: res.data.updatedCells,
        };

    } else {
        throw new Error(`Unknown sheets action: ${action.operation}`);
    }
}

function isSheetsTool(toolName) {
    return toolName.startsWith('sheets_');
}

module.exports = {
    SHEETS_TOOLS,
    executeSheetsTool,
    executeSheetsAction,
    isSheetsTool,
    createSheetsClient,
};
