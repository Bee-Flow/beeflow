/**
 * Google Drive Tools — Built-in tools for AI to search, list, and manage files
 *
 * Injected into the LLM tool set when the user is logged in with Google,
 * allowing the AI to search files, list folder contents, get file details,
 * move files, and create folders.
 */

const { google } = require('googleapis');
const { Readable } = require('stream');
const { loadConfig } = require('../auth/permissions');

const DRIVE_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'drive_search',
            description: 'Search for files and folders in Google Drive. Supports Drive search operators like name contains, mimeType, modifiedTime, etc.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query. Examples: "name contains \'report\'", "mimeType = \'application/pdf\'", "modifiedTime > \'2026-01-01\'"'
                    },
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum number of results (1-50, default 20)'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'drive_list_files',
            description: 'List files in a specific folder or the root of Google Drive. Use folderId to browse folders.',
            parameters: {
                type: 'object',
                properties: {
                    folderId: {
                        type: 'string',
                        description: 'Folder ID to list. Use "root" for the root folder. Omit to list recent files.'
                    },
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum results (1-50, default 20)'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'drive_get_file',
            description: 'Get detailed metadata for a specific file including sharing permissions, size, and history.',
            parameters: {
                type: 'object',
                properties: {
                    fileId: {
                        type: 'string',
                        description: 'The file ID from drive_search or drive_list_files results'
                    }
                },
                required: ['fileId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'drive_move_file',
            description: 'Move a file to a different folder in Google Drive.',
            parameters: {
                type: 'object',
                properties: {
                    fileId: {
                        type: 'string',
                        description: 'The file ID to move'
                    },
                    destinationFolderId: {
                        type: 'string',
                        description: 'The destination folder ID'
                    }
                },
                required: ['fileId', 'destinationFolderId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'drive_create_folder',
            description: 'Create a new folder in Google Drive.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Folder name'
                    },
                    parentFolderId: {
                        type: 'string',
                        description: 'Parent folder ID. Use "root" for root. Omit for root.'
                    }
                },
                required: ['name']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'drive_upload_file',
            description:
                'Upload a file to Google Drive. Two input modes:\n' +
                '  1) sourceHandle — opaque handle from another tool (e.g. the `sourceHandle` returned by gmail_read_attachment) pointing at bytes the server already has. PREFERRED for mail attachments: no base64 ever passes through the AI context.\n' +
                '  2) content — inline string for AI-generated text files (UTF-8, or base64 with isBase64=true). Use only for small text payloads, never for forwarding binary attachments.\n' +
                'Returns { fileId, name, webViewLink, parents, bytesUploaded, updated }.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Filename to save as (include the extension, e.g. "factuur.pdf").'
                    },
                    parentFolderId: {
                        type: 'string',
                        description: 'Drive folder ID to place the file in. Omit (or "root") for My Drive root.'
                    },
                    mimeType: {
                        type: 'string',
                        description: 'MIME type. Inferred from sourceHandle.mimeType or the filename extension when omitted.'
                    },
                    sourceHandle: {
                        type: 'object',
                        description: 'Server-side reference to bytes from another tool. Currently supported: { kind: "gmail_attachment", messageId, attachmentId, filename?, mimeType?, size? }.',
                        properties: {
                            kind:         { type: 'string', enum: ['gmail_attachment'] },
                            messageId:    { type: 'string' },
                            attachmentId: { type: 'string' },
                            filename:     { type: 'string' },
                            mimeType:     { type: 'string' },
                            size:         { type: 'integer' }
                        }
                    },
                    content: {
                        type: 'string',
                        description: 'Inline content. Mutually exclusive with sourceHandle. UTF-8 string, or base64 when isBase64=true.'
                    },
                    isBase64: {
                        type: 'boolean',
                        description: 'If true, content is interpreted as base64-encoded binary.'
                    },
                    overwriteIfExists: {
                        type: 'boolean',
                        description: 'If true and a file with the same name already exists in parentFolderId, update it (new revision) instead of creating a duplicate. Default false.'
                    }
                },
                required: ['name']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'drive_get_content',
            description: 'Download and read the text content of a Google Drive file. Supports Google Docs (exported as plain text), Google Sheets (exported as CSV), PDFs (text extracted), and plain text files. Use this after drive_search to read the actual content of financial documents, invoices, or spreadsheets stored in Drive.',
            parameters: {
                type: 'object',
                properties: {
                    fileId: {
                        type: 'string',
                        description: 'The file ID from drive_search or drive_list_files results'
                    }
                },
                required: ['fileId']
            }
        }
    }
];

// ─── Drive Client ──────────────────────────────────────────────

async function createDriveClient(session) {
    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};

    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Google OAuth not configured');
    }

    const accessToken = session?.accessToken;
    if (!accessToken) {
        throw new Error('Not connected to Google Drive — user must log in with Google');
    }

    const oauth2Client = new google.auth.OAuth2(
        providerConfig.clientId,
        providerConfig.clientSecret
    );

    oauth2Client.setCredentials({
        access_token: accessToken,
        refresh_token: session?.refreshToken
    });

    oauth2Client.on('tokens', (tokens) => {
        if (tokens.access_token) session.accessToken = tokens.access_token;
        if (tokens.refresh_token) session.refreshToken = tokens.refresh_token;
        session.save?.();
    });

    return google.drive({ version: 'v3', auth: oauth2Client });
}

// ─── MIME inference ────────────────────────────────────────────

const EXT_TO_MIME = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    csv: 'text/csv',
    txt: 'text/plain',
    md: 'text/markdown',
    html: 'text/html',
    json: 'application/json',
    xml: 'application/xml',
    zip: 'application/zip',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function inferMimeType({ mimeArg, handleMime, filename }) {
    if (mimeArg) return mimeArg;
    if (handleMime) return handleMime;
    const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    return (ext && EXT_TO_MIME[ext]) || 'application/octet-stream';
}

// ─── Format File ───────────────────────────────────────────────

function formatFile(file) {
    return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size ? `${(parseInt(file.size) / 1024).toFixed(1)} KB` : null,
        modifiedTime: file.modifiedTime,
        createdTime: file.createdTime,
        webViewLink: file.webViewLink,
        iconLink: file.iconLink,
        parents: file.parents,
        shared: file.shared,
        owners: file.owners?.map(o => o.emailAddress),
        sharingUser: file.sharingUser?.emailAddress,
    };
}

// ─── Tool Execution ────────────────────────────────────────────

async function executeDriveTool(toolName, args, session) {
    const drive = await createDriveClient(session);

    switch (toolName) {
        case 'drive_search': {
            const maxResults = Math.min(Math.max(args.maxResults || 20, 1), 50);
            // Sanitize: if query doesn't contain Drive operators, wrap as name search
            let query = args.query;
            const driveOps = /\b(contains|=|!=|<|>|in\b|not\b|and\b|or\b|has\b)/i;
            if (!driveOps.test(query)) {
                // Strip surrounding quotes if present
                query = query.replace(/^["']|["']$/g, '').trim();
                query = `name contains '${query.replace(/'/g, "\\'")}'`;
            }
            const res = await drive.files.list({
                q: query,
                pageSize: maxResults,
                fields: 'files(id, name, mimeType, size, modifiedTime, createdTime, webViewLink, parents, shared, owners)',
                orderBy: 'modifiedTime desc',
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
            });
            return {
                query: args.query,
                resultCount: res.data.files?.length || 0,
                results: (res.data.files || []).map(formatFile),
            };
        }

        case 'drive_list_files': {
            const maxResults = Math.min(Math.max(args.maxResults || 20, 1), 50);
            const q = args.folderId
                ? `'${args.folderId}' in parents and trashed = false`
                : 'trashed = false';
            const res = await drive.files.list({
                q,
                pageSize: maxResults,
                fields: 'files(id, name, mimeType, size, modifiedTime, createdTime, webViewLink, parents, shared)',
                orderBy: 'modifiedTime desc',
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
            });
            return {
                folderId: args.folderId || 'recent',
                resultCount: res.data.files?.length || 0,
                results: (res.data.files || []).map(formatFile),
            };
        }

        case 'drive_get_file': {
            const res = await drive.files.get({
                fileId: args.fileId,
                fields: 'id, name, mimeType, size, modifiedTime, createdTime, webViewLink, parents, shared, owners, sharingUser, permissions, description',
                supportsAllDrives: true,
            });
            const file = formatFile(res.data);
            // Add permissions detail
            if (res.data.permissions) {
                file.permissions = res.data.permissions.map(p => ({
                    role: p.role,
                    type: p.type,
                    email: p.emailAddress,
                    displayName: p.displayName,
                }));
            }
            file.description = res.data.description;
            return file;
        }

        case 'drive_move_file': {
            // Get current parents
            const current = await drive.files.get({
                fileId: args.fileId,
                fields: 'parents',
                supportsAllDrives: true,
            });
            const previousParents = (current.data.parents || []).join(',');

            const res = await drive.files.update({
                fileId: args.fileId,
                addParents: args.destinationFolderId,
                removeParents: previousParents,
                fields: 'id, name, parents',
                supportsAllDrives: true,
            });
            return {
                success: true,
                file: res.data.name,
                movedTo: args.destinationFolderId,
            };
        }

        case 'drive_create_folder': {
            const res = await drive.files.create({
                requestBody: {
                    name: args.name,
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: args.parentFolderId ? [args.parentFolderId] : undefined,
                },
                fields: 'id, name, webViewLink',
                supportsAllDrives: true,
            });
            return {
                success: true,
                folderId: res.data.id,
                name: res.data.name,
                link: res.data.webViewLink,
            };
        }

        case 'drive_upload_file': {
            if (!args.name) return { error: 'name is required' };
            const hasHandle = args.sourceHandle && typeof args.sourceHandle === 'object';
            const hasContent = typeof args.content === 'string';
            if (hasHandle && hasContent) {
                return { error: 'Pass either sourceHandle or content, not both.' };
            }
            if (!hasHandle && !hasContent) {
                return { error: 'Either sourceHandle (preferred for binary) or content (for inline text) is required.' };
            }

            // Resolve bytes. Handles stay opaque to the AI; the only currently
            // supported kind is gmail_attachment.
            let buffer;
            let handleMime;
            if (hasHandle) {
                const kind = args.sourceHandle.kind;
                if (kind === 'gmail_attachment') {
                    const { fetchAttachmentBuffer } = require('./gmailTools');
                    const res = await fetchAttachmentBuffer(session, {
                        messageId: args.sourceHandle.messageId,
                        attachmentId: args.sourceHandle.attachmentId,
                    });
                    buffer = res.buffer;
                    handleMime = args.sourceHandle.mimeType;
                } else {
                    return { error: `Unsupported sourceHandle.kind: ${kind}` };
                }
            } else {
                buffer = Buffer.from(args.content, args.isBase64 ? 'base64' : 'utf-8');
            }

            const mimeType = inferMimeType({ mimeArg: args.mimeType, handleMime, filename: args.name });

            // Idempotent overwrite: look for an existing file with the same name
            // in the target folder and update it in place rather than creating a
            // duplicate. Off by default — duplicates are safer than surprise
            // overwrites in invoice-archive flows.
            let existingId = null;
            if (args.overwriteIfExists && args.parentFolderId) {
                const escapedName = String(args.name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                const listRes = await drive.files.list({
                    q: `name = '${escapedName}' and '${args.parentFolderId}' in parents and trashed = false`,
                    pageSize: 1,
                    fields: 'files(id, name)',
                    supportsAllDrives: true,
                    includeItemsFromAllDrives: true,
                });
                existingId = listRes.data.files?.[0]?.id || null;
            }

            const media = { mimeType, body: Readable.from(buffer) };
            let res;
            if (existingId) {
                res = await drive.files.update({
                    fileId: existingId,
                    media,
                    fields: 'id, name, webViewLink, parents',
                    supportsAllDrives: true,
                });
            } else {
                res = await drive.files.create({
                    requestBody: {
                        name: args.name,
                        parents: args.parentFolderId ? [args.parentFolderId] : undefined,
                        mimeType,
                    },
                    media,
                    fields: 'id, name, webViewLink, parents',
                    supportsAllDrives: true,
                });
            }

            return {
                success: true,
                fileId: res.data.id,
                name: res.data.name,
                webViewLink: res.data.webViewLink,
                parents: res.data.parents,
                mimeType,
                bytesUploaded: buffer.length,
                updated: !!existingId,
            };
        }

        case 'drive_get_content': {
            if (!args.fileId) return { error: 'fileId is required' };

            // Get file metadata first to determine how to read it
            const fileMeta = await drive.files.get({
                fileId: args.fileId,
                fields: 'id, name, mimeType, size',
                supportsAllDrives: true,
            });
            const mimeType = fileMeta.data.mimeType;
            const fileName = fileMeta.data.name;
            const MAX_CHARS = 80000;

            let content = '';

            // Google Docs → export as plain text
            if (mimeType === 'application/vnd.google-apps.document') {
                const exp = await drive.files.export({
                    fileId: args.fileId,
                    mimeType: 'text/plain',
                });
                content = typeof exp.data === 'string' ? exp.data : String(exp.data);
            }
            // Google Sheets → export as CSV
            else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
                const exp = await drive.files.export({
                    fileId: args.fileId,
                    mimeType: 'text/csv',
                });
                content = typeof exp.data === 'string' ? exp.data : String(exp.data);
            }
            // Google Slides → export as plain text
            else if (mimeType === 'application/vnd.google-apps.presentation') {
                const exp = await drive.files.export({
                    fileId: args.fileId,
                    mimeType: 'text/plain',
                });
                content = typeof exp.data === 'string' ? exp.data : String(exp.data);
            }
            // PDF → download + extract text via the unified attachment pipeline
            // (pdfjs → Azure DI → Mistral OCR, with the garbage-text fallback
            // that catches CID-font junk). Keeps Drive in lockstep with
            // Nextcloud and chat uploads — one place to fix PDF quirks.
            else if (mimeType === 'application/pdf') {
                try {
                    const dlRes = await drive.files.get({
                        fileId: args.fileId,
                        alt: 'media',
                        supportsAllDrives: true,
                    }, { responseType: 'arraybuffer' });
                    const pdfBuffer = Buffer.from(dlRes.data);

                    const { extractAttachment } = require('../core/attachmentExtractor');
                    const result = await extractAttachment({
                        name: fileName,
                        type: 'application/pdf',
                        content: pdfBuffer.toString('base64'),
                    });
                    if (result.kind === 'text') {
                        content = result.text;
                    } else if (result.kind === 'images') {
                        return {
                            error: `${fileName} appears to be an image-only PDF (${result.meta?.numPages || '?'} pages) with no extractable text. Configure Azure Document Intelligence or Mistral OCR to read scanned PDFs from Drive.`,
                            fileName,
                        };
                    } else {
                        content = `[PDF: ${fileName} — could not extract text: ${result.reason || 'unknown reason'}]`;
                    }
                } catch (dlErr) {
                    return { error: `Failed to download PDF: ${dlErr.message}`, fileName };
                }
            }
            // Plain text / CSV / other downloadable formats
            else if (
                mimeType?.startsWith('text/') ||
                mimeType === 'application/json' ||
                mimeType === 'application/csv' ||
                mimeType === 'application/xml'
            ) {
                const dlRes = await drive.files.get({
                    fileId: args.fileId,
                    alt: 'media',
                    supportsAllDrives: true,
                }, { responseType: 'text' });
                content = typeof dlRes.data === 'string' ? dlRes.data : String(dlRes.data);
            }
            // Unsupported format
            else {
                return {
                    error: `Cannot read content of ${mimeType} files. Supported: Google Docs, Sheets, Slides, PDF, and text files.`,
                    fileName, mimeType,
                };
            }

            return {
                fileId: args.fileId,
                fileName,
                mimeType,
                content: content.length > MAX_CHARS
                    ? content.substring(0, MAX_CHARS) + '\n\n[... truncated, file too large ...]'
                    : content,
                charCount: content.length,
                truncated: content.length > MAX_CHARS,
            };
        }

        default:
            return { error: `Unknown drive tool: ${toolName}` };
    }
}

function isDriveTool(toolName) {
    return ['drive_search', 'drive_list_files', 'drive_get_file', 'drive_get_content', 'drive_move_file', 'drive_create_folder', 'drive_upload_file'].includes(toolName);
}

module.exports = {
    DRIVE_TOOLS,
    executeDriveTool,
    isDriveTool,
    createDriveClient,
};
