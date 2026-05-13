/**
 * Google Sheets Tools — list, read, append, update, create.
 *
 * Mirrors the auth/client pattern of docsTools.js so a Google-OAuth user
 * gets the same OAuth refresh handling. Sheets shares the Drive OAuth
 * scopes (drive.readonly + drive.file are sufficient for these calls).
 *
 * Tool surface kept small on purpose — automations need read/append/update
 * for tracking-sheet patterns, plus list/create for the discovery cases.
 * Anything richer (charts, formatting, named ranges) lives in the chat
 * agent path via free-form Drive queries until a real use case lands.
 */

const { google } = require('googleapis');
const { loadConfig } = require('../auth/permissions');

// ─── Tool Definitions (for LLM tool-use) ──────────────────────

const SHEETS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'sheets_list',
            description: 'List Google Sheets the user owns or has access to. Returns id + name + URL. Use this when the user asks to "find a spreadsheet" or before reading.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Optional Drive search query (e.g. name contains "invoices").' },
                    pageSize: { type: 'integer', description: 'Default 25, max 100.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sheets_get_values',
            description: 'Read a range from a Google Sheet. Returns a 2D array of values plus the resolved range. Empty cells come back as empty strings.',
            parameters: {
                type: 'object',
                properties: {
                    spreadsheetId: { type: 'string', description: 'The spreadsheet ID (from sheets_list or the sheet URL).' },
                    range: { type: 'string', description: 'A1 notation, e.g. "Sheet1!A1:D" or "A:D". Default: first sheet, all data.' },
                },
                required: ['spreadsheetId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sheets_append_rows',
            description: 'Append rows to the end of a sheet. Each row is an array of cell values (strings, numbers, or booleans). Returns updated range + row count.',
            parameters: {
                type: 'object',
                properties: {
                    spreadsheetId: { type: 'string' },
                    range: { type: 'string', description: 'Target sheet/range, e.g. "Sheet1!A:D". Append happens at the first empty row beneath this.' },
                    values: { type: 'array', description: 'Array of rows; each row is an array of cell values.', items: { type: 'array' } },
                    valueInputOption: { type: 'string', enum: ['RAW', 'USER_ENTERED'], description: 'USER_ENTERED parses formulas and dates; RAW writes literal strings. Default USER_ENTERED.' },
                },
                required: ['spreadsheetId', 'range', 'values'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sheets_update_range',
            description: 'Overwrite cells in a range. The values array dimensions should match the range — extras are ignored, missing cells stay untouched.',
            parameters: {
                type: 'object',
                properties: {
                    spreadsheetId: { type: 'string' },
                    range: { type: 'string', description: 'Exact A1 range, e.g. "Sheet1!B2:D5".' },
                    values: { type: 'array', items: { type: 'array' } },
                    valueInputOption: { type: 'string', enum: ['RAW', 'USER_ENTERED'], description: 'Default USER_ENTERED.' },
                },
                required: ['spreadsheetId', 'range', 'values'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sheets_create',
            description: 'Create a new spreadsheet. Returns its id and URL. Optionally seed it with named tabs.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Spreadsheet title.' },
                    tabs: { type: 'array', description: 'Optional initial sheet (tab) names. First entry is the active sheet.', items: { type: 'string' } },
                    folderId: { type: 'string', description: 'Optional Drive folder ID to place the file in.' },
                },
                required: ['title'],
            },
        },
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
        providerConfig.clientSecret,
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

    return {
        sheets: google.sheets({ version: 'v4', auth: oauth2Client }),
        drive: google.drive({ version: 'v3', auth: oauth2Client }),
        oauth2Client,
    };
}

// ─── Tool Execution ────────────────────────────────────────────

async function executeSheetsTool(toolName, args, session) {
    const { sheets, drive } = await createSheetsClient(session);

    switch (toolName) {
        case 'sheets_list': {
            const { query, pageSize } = args || {};
            const baseQ = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
            const q = query ? `${baseQ} and (${query})` : baseQ;
            const res = await drive.files.list({
                q,
                pageSize: Math.min(Math.max(Number(pageSize) || 25, 1), 100),
                fields: 'files(id,name,modifiedTime,webViewLink)',
                orderBy: 'modifiedTime desc',
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
            });
            const results = (res.data.files || []).map(f => ({
                id: f.id,
                name: f.name,
                url: f.webViewLink || `https://docs.google.com/spreadsheets/d/${f.id}/edit`,
                modifiedTime: f.modifiedTime,
            }));
            return { results, total: results.length };
        }

        case 'sheets_get_values': {
            const { spreadsheetId, range } = args || {};
            if (!spreadsheetId) throw new Error('spreadsheetId required');
            // Default to the first sheet's full data if no range provided.
            let effectiveRange = range;
            if (!effectiveRange) {
                const meta = await sheets.spreadsheets.get({ spreadsheetId, includeGridData: false });
                const firstTitle = meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
                effectiveRange = firstTitle;
            }
            const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: effectiveRange });
            const values = res.data.values || [];
            return {
                spreadsheetId,
                range: res.data.range || effectiveRange,
                values,
                rowCount: values.length,
                colCount: values.reduce((m, r) => Math.max(m, r.length), 0),
            };
        }

        case 'sheets_append_rows': {
            const { spreadsheetId, range, values, valueInputOption } = args || {};
            if (!spreadsheetId || !range) throw new Error('spreadsheetId and range required');
            if (!Array.isArray(values) || values.length === 0) throw new Error('values must be a non-empty 2D array');
            const res = await sheets.spreadsheets.values.append({
                spreadsheetId,
                range,
                valueInputOption: valueInputOption || 'USER_ENTERED',
                insertDataOption: 'INSERT_ROWS',
                requestBody: { values },
            });
            return {
                spreadsheetId,
                updatedRange: res.data.updates?.updatedRange || null,
                rowsAppended: res.data.updates?.updatedRows || 0,
                cellsAppended: res.data.updates?.updatedCells || 0,
            };
        }

        case 'sheets_update_range': {
            const { spreadsheetId, range, values, valueInputOption } = args || {};
            if (!spreadsheetId || !range) throw new Error('spreadsheetId and range required');
            if (!Array.isArray(values)) throw new Error('values must be a 2D array');
            const res = await sheets.spreadsheets.values.update({
                spreadsheetId,
                range,
                valueInputOption: valueInputOption || 'USER_ENTERED',
                requestBody: { values },
            });
            return {
                spreadsheetId,
                updatedRange: res.data.updatedRange,
                rowsUpdated: res.data.updatedRows || 0,
                cellsUpdated: res.data.updatedCells || 0,
            };
        }

        case 'sheets_create': {
            const { title, tabs, folderId } = args || {};
            if (!title) throw new Error('title required');
            const tabList = Array.isArray(tabs) && tabs.length
                ? tabs.map((name, i) => ({ properties: { title: String(name), index: i } }))
                : undefined;
            const res = await sheets.spreadsheets.create({
                requestBody: { properties: { title }, sheets: tabList },
            });
            const spreadsheetId = res.data.spreadsheetId;
            // Optional: move to folder. Same pattern as docs_create.
            if (folderId) {
                try {
                    const file = await drive.files.get({ fileId: spreadsheetId, fields: 'parents', supportsAllDrives: true });
                    const prevParents = (file.data.parents || []).join(',');
                    await drive.files.update({
                        fileId: spreadsheetId,
                        addParents: folderId,
                        removeParents: prevParents,
                        supportsAllDrives: true,
                    });
                } catch (e) {
                    console.warn(`[Sheets] Could not move to folder ${folderId}: ${e.message}`);
                }
            }
            return {
                spreadsheetId,
                url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
                title,
            };
        }

        default:
            throw new Error(`Unknown sheets tool: ${toolName}`);
    }
}

function isSheetsTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('sheets_');
}

module.exports = {
    SHEETS_TOOLS,
    executeSheetsTool,
    isSheetsTool,
    createSheetsClient,
};
