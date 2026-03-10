/**
 * Google Docs Tools — Read and write Google Docs (no delete)
 *
 * Provides:
 * - Create a new document
 * - Read document content
 * - Append text to a document
 * - Replace text in a document
 */

const { google } = require('googleapis');
const { loadConfig } = require('../auth/permissions');

// ─── Tool Definitions (for LLM tool-use) ──────────────────────

const DOCS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'docs_create',
            description: 'Create a new Google Doc. Returns the document ID and URL.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Title for the new document' },
                    body: { type: 'string', description: 'Optional initial text content for the document' },
                    folderId: { type: 'string', description: 'Optional Drive folder ID to move the document into' },
                },
                required: ['title']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'docs_read',
            description: 'Read the text content of a Google Doc.',
            parameters: {
                type: 'object',
                properties: {
                    documentId: { type: 'string', description: 'The document ID' },
                },
                required: ['documentId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'docs_append',
            description: 'Append text to the end of an existing Google Doc.',
            parameters: {
                type: 'object',
                properties: {
                    documentId: { type: 'string', description: 'The document ID' },
                    text: { type: 'string', description: 'Text to append to the document' },
                },
                required: ['documentId', 'text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'docs_replace_text',
            description: 'Find and replace text in a Google Doc. Useful for updating templates.',
            parameters: {
                type: 'object',
                properties: {
                    documentId: { type: 'string', description: 'The document ID' },
                    findText: { type: 'string', description: 'Text to find' },
                    replaceText: { type: 'string', description: 'Text to replace with' },
                    matchCase: { type: 'boolean', description: 'Whether to match case (default: false)' },
                },
                required: ['documentId', 'findText', 'replaceText']
            }
        }
    },
];

// ─── Docs Client ───────────────────────────────────────────────

async function createDocsClient(session) {
    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};

    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Google OAuth not configured');
    }

    const accessToken = session?.accessToken;
    if (!accessToken) {
        throw new Error('Not connected to Google Docs — user must log in with Google');
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

    return { docs: google.docs({ version: 'v1', auth: oauth2Client }), oauth2Client };
}

// ─── Extract text from doc elements ────────────────────────────

function extractText(body) {
    if (!body?.content) return '';
    let text = '';
    for (const element of body.content) {
        if (element.paragraph) {
            for (const pe of (element.paragraph.elements || [])) {
                if (pe.textRun?.content) {
                    text += pe.textRun.content;
                }
            }
        } else if (element.table) {
            for (const row of (element.table.tableRows || [])) {
                for (const cell of (row.tableCells || [])) {
                    text += extractText(cell) + '\t';
                }
                text += '\n';
            }
        }
    }
    return text;
}

// ─── Tool Execution ────────────────────────────────────────────

async function executeDocsTool(toolName, args, session) {
    const { docs } = await createDocsClient(session);

    switch (toolName) {
        case 'docs_create': {
            const { title, body, folderId } = args;
            console.log(`[Docs] Creating document: "${title}"`);

            const res = await docs.documents.create({
                requestBody: { title },
            });

            const documentId = res.data.documentId;

            // Add initial body content if provided
            if (body) {
                await docs.documents.batchUpdate({
                    documentId,
                    requestBody: {
                        requests: [{
                            insertText: {
                                location: { index: 1 },
                                text: body,
                            },
                        }],
                    },
                });
            }

            // Move to folder if specified
            if (folderId) {
                try {
                    const { createDriveClient } = require('./driveTools');
                    const drive = await createDriveClient(session);
                    const file = await drive.files.get({ fileId: documentId, fields: 'parents', supportsAllDrives: true });
                    const prevParents = (file.data.parents || []).join(',');
                    await drive.files.update({
                        fileId: documentId,
                        addParents: folderId,
                        removeParents: prevParents,
                        supportsAllDrives: true,
                    });
                } catch (e) {
                    console.warn(`[Docs] Could not move to folder ${folderId}:`, e.message);
                }
            }

            return {
                documentId,
                url: `https://docs.google.com/document/d/${documentId}/edit`,
                title,
            };
        }

        case 'docs_read': {
            const { documentId } = args;
            console.log(`[Docs] Reading document: ${documentId}`);

            const res = await docs.documents.get({ documentId });
            const text = extractText(res.data.body);

            return {
                documentId,
                title: res.data.title,
                text: text.length > 10000 ? text.substring(0, 10000) + '\n... [truncated]' : text,
                characterCount: text.length,
            };
        }

        case 'docs_append': {
            const { documentId, text } = args;
            console.log(`[Docs] Appending to document: ${documentId}`);

            // Get end of document index
            const doc = await docs.documents.get({ documentId });
            const endIndex = doc.data.body.content.slice(-1)[0]?.endIndex || 1;

            await docs.documents.batchUpdate({
                documentId,
                requestBody: {
                    requests: [{
                        insertText: {
                            location: { index: endIndex - 1 },
                            text: '\n' + text,
                        },
                    }],
                },
            });

            return { documentId, appended: true, textLength: text.length };
        }

        case 'docs_replace_text': {
            const { documentId, findText, replaceText, matchCase } = args;
            console.log(`[Docs] Replace in ${documentId}: "${findText}" → "${replaceText}"`);

            const res = await docs.documents.batchUpdate({
                documentId,
                requestBody: {
                    requests: [{
                        replaceAllText: {
                            containsText: {
                                text: findText,
                                matchCase: matchCase || false,
                            },
                            replaceText: replaceText,
                        },
                    }],
                },
            });

            const occurrences = res.data.replies?.[0]?.replaceAllText?.occurrencesChanged || 0;
            return { documentId, replacements: occurrences };
        }

        default:
            throw new Error(`Unknown docs tool: ${toolName}`);
    }
}

function isDocsTool(toolName) {
    return toolName.startsWith('docs_');
}

module.exports = {
    DOCS_TOOLS,
    executeDocsTool,
    isDocsTool,
    createDocsClient,
};
