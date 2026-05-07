/**
 * Nextcloud Tools — AI tools for files via WebDAV + OCS.
 *
 * Dual-mode auth:
 *   • Bearer (preferred when the user logged in via Nextcloud OAuth) —
 *     uses session.accessToken with automatic 401-refresh through
 *     nextcloudClient.ncFetch. Mirrors the Google/Microsoft pattern so
 *     tools are available in direct chat the moment the user logs in.
 *   • Basic (fallback) — username + app password from userStore. Used by
 *     users who didn't log in via Nextcloud OAuth (e.g. logged in via
 *     Google/Microsoft and connected Nextcloud as a side integration).
 *
 * The Nextcloud base URL is read from the global oauth.nextcloudUrl config,
 * so admins configure it once for the whole tenant — same place OAuth SSO
 * uses.
 */

const ncClient = require('./nextcloudClient');
const { XMLParser } = require('fast-xml-parser');

const MAX_TEXT_BYTES = 200 * 1024;          // 200 KB cap on file reads
const REQUEST_TIMEOUT_MS = ncClient.REQUEST_TIMEOUT_MS;

// Shared parser. removeNSPrefix collapses d:/oc:/nc:/s: namespace prefixes so
// <d:response> → response, <oc:fileid> → fileid. Tag values stay as strings;
// callers parseInt where needed.
const xmlParser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
});

// Normalize a WebDAV multistatus response into [{ href, props, status }] where
// props is the merged successful prop bag. Sabre/DAV returns either an array
// or a single object for response/propstat depending on cardinality, so this
// flattens both shapes.
function parseMultistatus(xml) {
    const parsed = xmlParser.parse(xml);
    const ms = parsed?.multistatus;
    if (!ms) return [];
    const responses = Array.isArray(ms.response) ? ms.response : (ms.response ? [ms.response] : []);
    return responses.map((r) => {
        const propstats = Array.isArray(r.propstat) ? r.propstat : (r.propstat ? [r.propstat] : []);
        const props = {};
        for (const ps of propstats) {
            // Only merge 2xx propstat blocks; 404s carry empty placeholders.
            const status = ps.status || '';
            if (status && !/\b2\d\d\b/.test(status)) continue;
            Object.assign(props, ps.prop || {});
        }
        return { href: r.href || '', props, status: r.status || '' };
    });
}

function isCollectionProp(props) {
    const rt = props.resourcetype;
    if (!rt) return false;
    // <d:resourcetype><d:collection/></d:resourcetype> → { collection: '' }
    return rt.collection !== undefined;
}
const PROPFIND_BODY = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:prop>
    <d:displayname/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
    <d:resourcetype/>
    <oc:fileid/>
    <oc:size/>
  </d:prop>
</d:propfind>`;

const NEXTCLOUD_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_list_files',
            description: 'List files and folders in a Nextcloud directory. Returns name, type (file/folder), size, and last-modified date. Use path "/" for the root of the user\'s files.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Folder path relative to the user\'s files root (e.g. "/", "/Documents", "/Photos/2024").' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_search_files',
            description: 'Search for files and folders by name in the user\'s Nextcloud. Matches partial names case-insensitively.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query (matched against file/folder names).' },
                    limit: { type: 'integer', description: 'Maximum number of results (default 25, max 100).' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_read_file',
            description: 'Read the contents of a file from Nextcloud. Handles plain text, PDFs (text layer plus Azure / Mistral OCR fallback), DOCX, and XLSX/CSV — the same extraction pipeline used when a user uploads a file directly to chat. Extracted text larger than ~200 KB is truncated.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Full path to the file (e.g. "/Documents/notes.md", "/Invoices/2026/invoice.pdf").' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_upload_file',
            description: 'Upload or overwrite a text file in Nextcloud. Parent folders must already exist.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Destination file path (e.g. "/Documents/draft.md").' },
                    content: { type: 'string', description: 'File content (UTF-8 text).' },
                    contentType: { type: 'string', description: 'MIME type (default: text/plain).' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_create_folder',
            description: 'Create a new folder in Nextcloud. Parent folders must already exist.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Folder path to create (e.g. "/Projects/2026").' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_delete',
            description: 'Delete a file or folder from Nextcloud (moves it to the trash).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path of the file or folder to delete.' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_move',
            description: 'Move or rename a file or folder in Nextcloud (server-side WebDAV MOVE — no download/re-upload). Works for both files and folders. Renaming is just moving to the same parent with a new filename. The user has approved this — go ahead.',
            parameters: {
                type: 'object',
                properties: {
                    source: { type: 'string', description: 'Current path (e.g. "/Invoices/foo.pdf").' },
                    destination: { type: 'string', description: 'Target path (e.g. "/Invoices/2026-01/foo.pdf"). Parent folders must already exist.' },
                    overwrite: { type: 'boolean', description: 'If true, overwrite an existing file at the destination. Default false (fails with 412 if target exists).' }
                },
                required: ['source', 'destination']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_copy',
            description: 'Copy a file or folder in Nextcloud (server-side WebDAV COPY — no download/re-upload). Works for both files and folders. The user has approved this — go ahead.',
            parameters: {
                type: 'object',
                properties: {
                    source: { type: 'string', description: 'Source path (e.g. "/Documents/template.docx").' },
                    destination: { type: 'string', description: 'Target path. Parent folders must already exist.' },
                    overwrite: { type: 'boolean', description: 'If true, overwrite an existing file at the destination. Default false.' }
                },
                required: ['source', 'destination']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_create_share',
            description: 'Create a public share link for a file or folder. Returns the share URL. Permissions default to read-only.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path of the file or folder to share.' },
                    password: { type: 'string', description: 'Optional password to protect the share link.' },
                    expireDate: { type: 'string', description: 'Optional expiration date in YYYY-MM-DD format.' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_share_with_user',
            description: 'Share a file or folder with a specific Nextcloud user. The user has approved this. permissions: 1=read, 2=update, 4=create, 8=delete, 16=share — combine with bitwise OR (e.g. 31 = full).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path of the file or folder.' },
                    shareWith: { type: 'string', description: 'Target user uid.' },
                    permissions: { type: 'integer', description: 'Permission bitmask, default 1 (read).' },
                    expireDate: { type: 'string', description: 'Optional YYYY-MM-DD.' },
                    note: { type: 'string', description: 'Optional note shown to the recipient.' }
                },
                required: ['path', 'shareWith']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_share_with_group',
            description: 'Share a file or folder with a Nextcloud group. The user has approved this. permissions bitmask same as share_with_user (1=read, 2=update, 4=create, 8=delete, 16=share).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    shareWith: { type: 'string', description: 'Target group id.' },
                    permissions: { type: 'integer', description: 'Permission bitmask, default 1 (read).' },
                    expireDate: { type: 'string' },
                    note: { type: 'string' }
                },
                required: ['path', 'shareWith']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_share_by_email',
            description: 'Share a file or folder by email (creates a hidden public link emailed to the recipient). The user has approved this.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    shareWith: { type: 'string', description: 'Recipient email address.' },
                    password: { type: 'string', description: 'Optional access password.' },
                    expireDate: { type: 'string' },
                    note: { type: 'string' }
                },
                required: ['path', 'shareWith']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_list_shares',
            description: 'List shares. Defaults to outgoing shares. Pass shared_with_me=true for incoming, or path=… for shares of a specific path.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Optional path filter — list shares for this exact file/folder.' },
                    shared_with_me: { type: 'boolean', description: 'true = shares shared with the user (incoming).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_update_share',
            description: 'Update an existing share — change permissions, password, expiry, or note. The user has approved this.',
            parameters: {
                type: 'object',
                properties: {
                    shareId: { type: 'integer' },
                    permissions: { type: 'integer' },
                    password: { type: 'string', description: 'New password (empty string clears).' },
                    expireDate: { type: 'string' },
                    note: { type: 'string' }
                },
                required: ['shareId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_delete_share',
            description: 'Revoke a share by id. Always confirm with the user before calling.',
            parameters: {
                type: 'object',
                properties: {
                    shareId: { type: 'integer' }
                },
                required: ['shareId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_list_file_comments',
            description: 'List comments on a file. fileId is the numeric id (from nextcloud_list_files).',
            parameters: {
                type: 'object',
                properties: {
                    fileId: { type: 'integer' },
                    limit: { type: 'integer', description: 'Max comments (default 50, max 200).' }
                },
                required: ['fileId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_add_file_comment',
            description: 'Add a comment to a file. The user has approved this.',
            parameters: {
                type: 'object',
                properties: {
                    fileId: { type: 'integer' },
                    message: { type: 'string', description: 'Plain-text comment body.' }
                },
                required: ['fileId', 'message']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_list_tags',
            description: 'List system tags available on this Nextcloud (id, name, visibility, assignable flag).',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_create_tag',
            description: 'Create a new system tag. The user has approved this. Most servers require admin rights for visible tags.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    userVisible: { type: 'boolean', description: 'Visible to all users (default true).' },
                    userAssignable: { type: 'boolean', description: 'Assignable by all users (default true).' }
                },
                required: ['name']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tag_file',
            description: 'Attach a system tag to a file or folder.',
            parameters: {
                type: 'object',
                properties: {
                    fileId: { type: 'integer' },
                    tagId: { type: 'integer' }
                },
                required: ['fileId', 'tagId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_untag_file',
            description: 'Remove a system tag from a file.',
            parameters: {
                type: 'object',
                properties: {
                    fileId: { type: 'integer' },
                    tagId: { type: 'integer' }
                },
                required: ['fileId', 'tagId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_find_files_by_tag',
            description: 'Find all files and folders that carry a given system tag.',
            parameters: {
                type: 'object',
                properties: {
                    tagId: { type: 'integer' },
                    limit: { type: 'integer', description: 'Max results (default 100, max 500).' }
                },
                required: ['tagId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_list_trash',
            description: 'List items in the user\'s Nextcloud trash bin (deleted files awaiting permanent removal).',
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'integer', description: 'Max items (default 200, max 1000).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_restore_from_trash',
            description: 'Restore a single item from the trash to its original location. Use the trashPath returned by list_trash.',
            parameters: {
                type: 'object',
                properties: {
                    trashPath: { type: 'string', description: 'Trash item path (from list_trash).' },
                    originalPath: { type: 'string', description: 'Optional override for the destination — defaults to the original location.' }
                },
                required: ['trashPath']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_permanent_delete_trash',
            description: 'Permanently remove an item from the trash bin. Always confirm with the user before calling — this is unrecoverable.',
            parameters: {
                type: 'object',
                properties: {
                    trashPath: { type: 'string', description: 'Trash item path (from list_trash).' }
                },
                required: ['trashPath']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_list_versions',
            description: 'List previous versions of a file (by fileId).',
            parameters: {
                type: 'object',
                properties: {
                    fileId: { type: 'integer' }
                },
                required: ['fileId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_restore_version',
            description: 'Restore a previous version of a file. The user has approved this.',
            parameters: {
                type: 'object',
                properties: {
                    fileId: { type: 'integer' },
                    versionId: { type: 'string', description: 'Version id (from list_versions).' }
                },
                required: ['fileId', 'versionId']
            }
        }
    }
];

// ─── Helpers ──────────────────────────────────────────────────────

function joinDavPath(root, path) {
    const cleaned = String(path || '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!cleaned) return root + '/';
    const encoded = cleaned.split('/').map(encodeURIComponent).join('/');
    return `${root}/${encoded}`;
}

function relativeFromRoot(href, baseUrl, uid) {
    // Convert WebDAV href like "/remote.php/dav/files/alice/Documents/foo.md"
    // to "/Documents/foo.md" (the user-facing path).
    try {
        const decoded = decodeURIComponent(href);
        const rootPath = `/remote.php/dav/files/${decodeURIComponent(uid)}`;
        const idx = decoded.indexOf(rootPath);
        if (idx === -1) return decoded;
        return decoded.slice(idx + rootPath.length) || '/';
    } catch (_) {
        return href;
    }
}

function parsePropfind(xml, baseUrl, uid) {
    return parseMultistatus(xml).map(({ href, props }) => {
        if (!href) return null;
        const isCollection = isCollectionProp(props);
        const size = parseInt(props.getcontentlength || '0', 10);
        const contentType = props.getcontenttype || null;
        const lastMod = props.getlastmodified || null;
        const fileId = props.fileid || null;
        const path = relativeFromRoot(href, baseUrl, uid);
        const name = path.replace(/\/$/, '').split('/').pop() || '/';
        return {
            name,
            path: path.replace(/\/$/, '') || '/',
            type: isCollection ? 'folder' : 'file',
            size: isCollection ? undefined : size,
            contentType: isCollection ? undefined : contentType,
            modified: lastMod,
            fileId,
        };
    }).filter(Boolean);
}

// ─── Tool Execution ───────────────────────────────────────────────

async function executeNextcloudTool(toolName, args, userId, session) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const { baseUrl, fetch: ncFetch, authError, uid } = ctx;
    const root = ncClient.webdavRoot(baseUrl, uid);

    switch (toolName) {
        case 'nextcloud_list_files': {
            const url = joinDavPath(root, args.path) + (joinDavPath(root, args.path).endsWith('/') ? '' : '/');
            const res = await ncFetch(url, {
                method: 'PROPFIND',
                headers: {
                    'Depth': '1',
                    'Content-Type': 'application/xml; charset=utf-8',
                    'Accept': 'application/xml',
                },
                body: PROPFIND_BODY,
            });
            if (res.status === 404) return { error: `Folder not found: ${args.path}` };
            if (res.status === 401) return { error: authError };
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return { error: `Nextcloud PROPFIND failed (${res.status}): ${text.slice(0, 200)}` };
            }
            const xml = await res.text();
            const all = parsePropfind(xml, baseUrl, uid);
            // First entry is the folder itself — drop it.
            const folderPath = (args.path || '/').replace(/\/+$/, '') || '/';
            const items = all.filter(item => item.path !== folderPath);
            return { path: folderPath, count: items.length, items };
        }

        case 'nextcloud_search_files': {
            const limit = Math.min(Math.max(args.limit || 25, 1), 100);
            const query = String(args.query || '').trim();
            if (!query) return { error: 'query is required' };
            // OCS Files API search endpoint (works on Nextcloud 12+).
            const url = `${baseUrl}/ocs/v2.php/search/providers/files/search?term=${encodeURIComponent(query)}&limit=${limit}&format=json`;
            const res = await ncFetch(url, {
                headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' },
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Nextcloud search failed (${res.status})` };
            const data = await res.json();
            const entries = data?.ocs?.data?.entries || [];
            return {
                query,
                count: entries.length,
                items: entries.slice(0, limit).map(e => ({
                    name: e.title,
                    path: e.attributes?.path || (e.resourceUrl || '').split('dir=').pop() || null,
                    subline: e.subline || null,
                    url: e.resourceUrl || null,
                })),
            };
        }

        case 'nextcloud_read_file': {
            if (!args.path) return { error: 'path is required' };
            const url = joinDavPath(root, args.path);
            const res = await ncFetch(url, {});
            if (res.status === 404) return { error: `File not found: ${args.path}` };
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Nextcloud read failed (${res.status})` };
            const contentType = res.headers.get('content-type') || '';
            const buf = Buffer.from(await res.arrayBuffer());
            const filename = args.path.split('/').pop() || args.path;
            const att = { name: filename, type: contentType };

            // Rich-document extraction — PDF, DOCX, XLSX/CSV go through the
            // same pipeline used for chat uploads (pdfjs → Azure DI → Mistral
            // OCR for PDFs; Azure DI → mammoth/xlsx for Office docs).
            const { extractAttachment, isPdf, isDocx, isSpreadsheet } = require('../core/attachmentExtractor');
            if (isPdf(att) || isDocx(att) || isSpreadsheet(att)) {
                const result = await extractAttachment({
                    name: filename,
                    type: contentType,
                    content: buf.toString('base64'),
                });
                if (result.kind === 'text') {
                    const truncated = result.text.length > MAX_TEXT_BYTES;
                    const text = truncated
                        ? result.text.slice(0, MAX_TEXT_BYTES) + '\n\n... [truncated — extracted text too large]'
                        : result.text;
                    return {
                        path: args.path,
                        size: buf.length,
                        contentType,
                        extractedVia: result.source,
                        truncated,
                        content: text,
                        meta: result.meta,
                    };
                }
                if (result.kind === 'images') {
                    return {
                        error: `${filename} appears to be an image-only document (${result.meta?.numPages || '?'} pages) with no extractable text. Configure Azure Document Intelligence or Mistral OCR to read scanned PDFs from Nextcloud.`,
                        size: buf.length,
                        contentType,
                    };
                }
                return {
                    error: `Could not extract text from ${filename}: ${result.reason}.`,
                    size: buf.length,
                    contentType,
                };
            }

            // Plain text path — UTF-8 decode with binary-safety probe.
            const isText = /^(text\/|application\/(json|xml|x-yaml|x-sh|javascript))/i.test(contentType) || buf.slice(0, 1024).every(b => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127));
            if (!isText) {
                return { error: `File appears to be binary (${contentType || 'unknown type'}). Reading binary files of this type is not supported.`, size: buf.length, contentType };
            }
            const truncated = buf.length > MAX_TEXT_BYTES;
            const content = buf.slice(0, MAX_TEXT_BYTES).toString('utf-8');
            return {
                path: args.path,
                size: buf.length,
                contentType: contentType || 'text/plain',
                truncated,
                content: truncated ? content + '\n\n... [truncated — file too large]' : content,
            };
        }

        case 'nextcloud_upload_file': {
            if (!args.path || args.content === undefined) return { error: 'path and content are required' };
            const url = joinDavPath(root, args.path);
            const res = await ncFetch(url, {
                method: 'PUT',
                headers: {
                    'Content-Type': args.contentType || 'text/plain; charset=utf-8',
                },
                body: args.content,
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 409) return { error: `Parent folder for ${args.path} does not exist. Create it first with nextcloud_create_folder.` };
            if (!res.ok && res.status !== 201 && res.status !== 204) {
                const text = await res.text().catch(() => '');
                return { error: `Upload failed (${res.status}): ${text.slice(0, 200)}` };
            }
            return { success: true, path: args.path, created: res.status === 201, updated: res.status === 204 };
        }

        case 'nextcloud_create_folder': {
            if (!args.path) return { error: 'path is required' };
            const url = joinDavPath(root, args.path);
            const res = await ncFetch(url, { method: 'MKCOL' });
            if (res.status === 401) return { error: authError };
            if (res.status === 405) return { error: `Folder already exists: ${args.path}` };
            if (res.status === 409) return { error: `Parent folder for ${args.path} does not exist.` };
            if (!res.ok) return { error: `Folder creation failed (${res.status})` };
            return { success: true, path: args.path };
        }

        case 'nextcloud_delete': {
            if (!args.path) return { error: 'path is required' };
            const url = joinDavPath(root, args.path);
            const res = await ncFetch(url, { method: 'DELETE' });
            if (res.status === 404) return { error: `Not found: ${args.path}` };
            if (res.status === 401) return { error: authError };
            if (!res.ok && res.status !== 204) return { error: `Delete failed (${res.status})` };
            return { success: true, path: args.path };
        }

        case 'nextcloud_move':
        case 'nextcloud_copy': {
            if (!args.source || !args.destination) return { error: 'source and destination are required' };
            const method = toolName === 'nextcloud_move' ? 'MOVE' : 'COPY';
            const sourceUrl = joinDavPath(root, args.source);
            const destinationUrl = joinDavPath(root, args.destination);
            const res = await ncFetch(sourceUrl, {
                method,
                headers: {
                    'Destination': destinationUrl,
                    'Overwrite': args.overwrite ? 'T' : 'F',
                },
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Source not found: ${args.source}` };
            if (res.status === 409) return { error: `Destination parent folder doesn't exist: ${args.destination}. Create it first.` };
            if (res.status === 412) return { error: `Destination already exists: ${args.destination}. Pass overwrite=true to replace it.` };
            if (!res.ok && res.status !== 201 && res.status !== 204) {
                const text = await res.text().catch(() => '');
                return { error: `${method} failed (${res.status}): ${text.slice(0, 200)}` };
            }
            return {
                success: true,
                operation: method.toLowerCase(),
                source: args.source,
                destination: args.destination,
                overwritten: res.status === 204,
            };
        }

        case 'nextcloud_create_share': {
            if (!args.path) return { error: 'path is required' };
            const params = new URLSearchParams();
            params.set('path', args.path);
            params.set('shareType', '3'); // 3 = public link
            params.set('permissions', '1'); // 1 = read
            if (args.password) params.set('password', args.password);
            if (args.expireDate) params.set('expireDate', args.expireDate);
            const url = `${baseUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`;
            const res = await ncFetch(url, {
                method: 'POST',
                headers: {
                    'OCS-APIRequest': 'true',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                },
                body: params.toString(),
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return { error: `Share creation failed (${res.status}): ${text.slice(0, 200)}` };
            }
            const data = await res.json();
            const meta = data?.ocs?.meta;
            const share = data?.ocs?.data;
            if (meta?.statuscode && meta.statuscode >= 400) {
                return { error: `Nextcloud rejected share: ${meta.message || 'unknown error'}` };
            }
            return {
                success: true,
                url: share?.url || null,
                token: share?.token || null,
                id: share?.id || null,
                path: args.path,
                expiration: share?.expiration || null,
            };
        }

        case 'nextcloud_share_with_user':
        case 'nextcloud_share_with_group':
        case 'nextcloud_share_by_email': {
            if (!args.path || !args.shareWith) return { error: 'path and shareWith are required' };
            const shareType = toolName === 'nextcloud_share_with_user' ? 0
                : toolName === 'nextcloud_share_with_group' ? 1
                : 4;
            const params = new URLSearchParams();
            params.set('path', args.path);
            params.set('shareType', String(shareType));
            params.set('shareWith', args.shareWith);
            if (args.permissions !== undefined) params.set('permissions', String(args.permissions));
            if (args.password) params.set('password', args.password);
            if (args.expireDate) params.set('expireDate', args.expireDate);
            if (args.note) params.set('note', args.note);
            const res = await ncFetch(`${baseUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`, {
                method: 'POST',
                headers: {
                    'OCS-APIRequest': 'true',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                },
                body: params.toString(),
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return { error: `Share create failed (${res.status}): ${text.slice(0, 200)}` };
            }
            const data = await res.json().catch(() => ({}));
            const meta = data?.ocs?.meta;
            const share = data?.ocs?.data;
            if (meta?.statuscode && meta.statuscode >= 400) {
                return { error: `Nextcloud rejected share: ${meta.message || 'unknown error'}` };
            }
            return {
                success: true,
                shareId: share?.id || null,
                shareType,
                shareWith: args.shareWith,
                path: args.path,
                permissions: share?.permissions,
                expiration: share?.expiration || null,
            };
        }

        case 'nextcloud_list_shares': {
            const params = new URLSearchParams({ format: 'json' });
            if (args.path) params.set('path', args.path);
            if (args.shared_with_me) params.set('shared_with_me', 'true');
            const res = await ncFetch(`${baseUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares?${params.toString()}`, {
                headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' },
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Share list failed (${res.status})` };
            const data = await res.json().catch(() => ({}));
            const shares = (data?.ocs?.data || []).map(s => ({
                id: s.id,
                shareType: s.share_type,
                shareWith: s.share_with,
                shareWithDisplayName: s.share_with_displayname,
                path: s.path,
                fileTarget: s.file_target,
                permissions: s.permissions,
                expiration: s.expiration,
                token: s.token,
                url: s.url,
                stime: s.stime,
                note: s.note,
            }));
            return { count: shares.length, shares };
        }

        case 'nextcloud_update_share': {
            if (!args.shareId) return { error: 'shareId is required' };
            // Run each provided field through its own PUT — Nextcloud expects
            // one property per request on this endpoint.
            const fields = [];
            if (args.permissions !== undefined) fields.push(['permissions', String(args.permissions)]);
            if (args.password !== undefined) fields.push(['password', args.password]);
            if (args.expireDate !== undefined) fields.push(['expireDate', args.expireDate]);
            if (args.note !== undefined) fields.push(['note', args.note]);
            if (fields.length === 0) return { error: 'no fields to update' };
            for (const [key, val] of fields) {
                const params = new URLSearchParams();
                params.set(key, val);
                const res = await ncFetch(`${baseUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares/${encodeURIComponent(args.shareId)}?format=json`, {
                    method: 'PUT',
                    headers: {
                        'OCS-APIRequest': 'true',
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json',
                    },
                    body: params.toString(),
                });
                if (res.status === 401) return { error: authError };
                if (!res.ok) {
                    const text = await res.text().catch(() => '');
                    return { error: `Share update (${key}) failed (${res.status}): ${text.slice(0, 200)}` };
                }
            }
            return { success: true, shareId: args.shareId };
        }

        case 'nextcloud_delete_share': {
            if (!args.shareId) return { error: 'shareId is required' };
            const res = await ncFetch(`${baseUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares/${encodeURIComponent(args.shareId)}?format=json`, {
                method: 'DELETE',
                headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' },
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Share not found: ${args.shareId}` };
            if (!res.ok) return { error: `Share delete failed (${res.status})` };
            return { success: true, shareId: args.shareId };
        }

        case 'nextcloud_list_file_comments': {
            if (!args.fileId) return { error: 'fileId is required' };
            const limit = Math.min(Math.max(args.limit || 50, 1), 200);
            const body = `<?xml version="1.0" encoding="utf-8" ?>
<oc:filter-comments xmlns:oc="http://owncloud.org/ns" xmlns:d="DAV:">
  <oc:limit>${limit}</oc:limit>
  <oc:offset>0</oc:offset>
</oc:filter-comments>`;
            const res = await ncFetch(`${baseUrl}/remote.php/dav/comments/files/${encodeURIComponent(args.fileId)}/`, {
                method: 'REPORT',
                headers: { 'Content-Type': 'application/xml; charset=utf-8' },
                body,
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `File not found or no comments support: ${args.fileId}` };
            if (!res.ok) return { error: `Comments fetch failed (${res.status})` };
            const xml = await res.text();
            const comments = [];
            for (const { href, props } of parseMultistatus(xml)) {
                const idMatch = (href || '').match(/\/(\d+)\/?$/);
                if (!idMatch) continue;
                comments.push({
                    id: parseInt(idMatch[1], 10),
                    message: props.message || '',
                    actor: props.actorDisplayName || null,
                    actorId: props.actorId || null,
                    created: props.creationDateTime || null,
                });
            }
            return { fileId: args.fileId, count: comments.length, comments };
        }

        case 'nextcloud_add_file_comment': {
            if (!args.fileId || !args.message) return { error: 'fileId and message are required' };
            const res = await ncFetch(`${baseUrl}/remote.php/dav/comments/files/${encodeURIComponent(args.fileId)}/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ actorType: 'users', verb: 'comment', message: args.message }),
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `File not found: ${args.fileId}` };
            if (!res.ok && res.status !== 201) {
                const text = await res.text().catch(() => '');
                return { error: `Comment failed (${res.status}): ${text.slice(0, 200)}` };
            }
            return { success: true, fileId: args.fileId };
        }

        case 'nextcloud_list_tags': {
            const body = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <oc:id/>
    <oc:display-name/>
    <oc:user-visible/>
    <oc:user-assignable/>
    <oc:can-assign/>
  </d:prop>
</d:propfind>`;
            const res = await ncFetch(`${baseUrl}/remote.php/dav/systemtags/`, {
                method: 'PROPFIND',
                headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
                body,
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Tags list failed (${res.status})` };
            const xml = await res.text();
            const tags = [];
            const isTrue = (v) => v === 'true' || v === '1' || v === true || v === 1;
            for (const { props } of parseMultistatus(xml)) {
                if (props.id === undefined || props.id === null || props.id === '') continue;
                tags.push({
                    id: parseInt(props.id, 10),
                    name: props['display-name'] || null,
                    userVisible: isTrue(props['user-visible']),
                    userAssignable: isTrue(props['user-assignable']),
                });
            }
            return { count: tags.length, tags };
        }

        case 'nextcloud_create_tag': {
            if (!args.name) return { error: 'name is required' };
            const res = await ncFetch(`${baseUrl}/remote.php/dav/systemtags/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: args.name,
                    userVisible: args.userVisible !== false,
                    userAssignable: args.userAssignable !== false,
                    canAssign: args.userAssignable !== false,
                }),
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 403) return { error: 'Tag creation requires admin privileges on this Nextcloud server.' };
            if (res.status === 409) return { error: `Tag already exists: ${args.name}` };
            if (!res.ok && res.status !== 201) {
                const text = await res.text().catch(() => '');
                return { error: `Tag create failed (${res.status}): ${text.slice(0, 200)}` };
            }
            // Tag id comes back in the Content-Location header.
            const loc = res.headers.get('content-location') || '';
            const id = parseInt((loc.match(/\/(\d+)\/?$/) || [])[1] || '0', 10) || null;
            return { success: true, id, name: args.name };
        }

        case 'nextcloud_tag_file': {
            if (!args.fileId || !args.tagId) return { error: 'fileId and tagId are required' };
            const res = await ncFetch(`${baseUrl}/remote.php/dav/systemtags-relations/files/${encodeURIComponent(args.fileId)}/${encodeURIComponent(args.tagId)}`, {
                method: 'PUT',
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: 'File or tag not found.' };
            if (res.status === 409) return { error: 'File already has this tag.' };
            if (!res.ok && res.status !== 201 && res.status !== 204) {
                return { error: `Tag attach failed (${res.status})` };
            }
            return { success: true, fileId: args.fileId, tagId: args.tagId };
        }

        case 'nextcloud_untag_file': {
            if (!args.fileId || !args.tagId) return { error: 'fileId and tagId are required' };
            const res = await ncFetch(`${baseUrl}/remote.php/dav/systemtags-relations/files/${encodeURIComponent(args.fileId)}/${encodeURIComponent(args.tagId)}`, {
                method: 'DELETE',
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: 'File or tag relation not found.' };
            if (!res.ok && res.status !== 204) return { error: `Untag failed (${res.status})` };
            return { success: true, fileId: args.fileId, tagId: args.tagId };
        }

        case 'nextcloud_find_files_by_tag': {
            if (!args.tagId) return { error: 'tagId is required' };
            const limit = Math.min(Math.max(args.limit || 100, 1), 500);
            const body = `<?xml version="1.0" encoding="utf-8" ?>
<oc:filter-files xmlns:oc="http://owncloud.org/ns" xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns">
  <d:prop>
    <d:displayname/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
    <d:resourcetype/>
    <oc:fileid/>
  </d:prop>
  <oc:filter-rules>
    <oc:systemtag>${args.tagId}</oc:systemtag>
  </oc:filter-rules>
</oc:filter-files>`;
            const res = await ncFetch(`${root}/`, {
                method: 'REPORT',
                headers: { 'Content-Type': 'application/xml; charset=utf-8' },
                body,
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Tag search failed (${res.status})` };
            const xml = await res.text();
            const items = parsePropfind(xml, baseUrl, uid).slice(0, limit);
            return { tagId: args.tagId, count: items.length, items };
        }

        case 'nextcloud_list_trash': {
            const limit = Math.min(Math.max(args.limit || 200, 1), 1000);
            const body = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:prop>
    <d:displayname/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
    <d:resourcetype/>
    <oc:fileid/>
    <nc:trashbin-original-location/>
    <nc:trashbin-deletion-time/>
  </d:prop>
</d:propfind>`;
            const url = `${baseUrl}/remote.php/dav/trashbin/${encodeURIComponent(uid)}/trash/`;
            const res = await ncFetch(url, {
                method: 'PROPFIND',
                headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
                body,
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Trash list failed (${res.status})` };
            const xml = await res.text();
            const responses = [];
            for (const { href, props } of parseMultistatus(xml)) {
                if (!href) continue;
                const trashPath = decodeURIComponent(href).replace(`/remote.php/dav/trashbin/${decodeURIComponent(uid)}/`, '/');
                if (trashPath.replace(/\/$/, '') === '/trash') continue;
                const isCollection = isCollectionProp(props);
                const size = parseInt(props.getcontentlength || '0', 10);
                const deletionTime = props['trashbin-deletion-time'] || null;
                responses.push({
                    name: props.displayname || '',
                    trashPath,
                    type: isCollection ? 'folder' : 'file',
                    size: isCollection ? undefined : size,
                    fileId: props.fileid || null,
                    originalLocation: props['trashbin-original-location'] || null,
                    deletionTime: deletionTime ? new Date(parseInt(deletionTime, 10) * 1000).toISOString() : null,
                });
                if (responses.length >= limit) break;
            }
            return { count: responses.length, items: responses };
        }

        case 'nextcloud_restore_from_trash': {
            if (!args.trashPath) return { error: 'trashPath is required' };
            // The trashbin path returned by list_trash starts with "/trash/<file>" — strip leading /.
            const cleaned = String(args.trashPath).replace(/^\/+/, '');
            const sourceUrl = `${baseUrl}/remote.php/dav/trashbin/${encodeURIComponent(uid)}/${cleaned.split('/').map(encodeURIComponent).join('/')}`;
            const destPath = args.originalPath || cleaned.replace(/^trash\//, '');
            const destUrl = `${baseUrl}/remote.php/dav/trashbin/${encodeURIComponent(uid)}/restore/${destPath.split('/').map(encodeURIComponent).join('/')}`;
            const res = await ncFetch(sourceUrl, {
                method: 'MOVE',
                headers: { 'Destination': destUrl },
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Trash item not found: ${args.trashPath}` };
            if (!res.ok && res.status !== 201 && res.status !== 204) {
                return { error: `Restore failed (${res.status})` };
            }
            return { success: true, restoredFrom: args.trashPath };
        }

        case 'nextcloud_permanent_delete_trash': {
            if (!args.trashPath) return { error: 'trashPath is required' };
            const cleaned = String(args.trashPath).replace(/^\/+/, '');
            const url = `${baseUrl}/remote.php/dav/trashbin/${encodeURIComponent(uid)}/${cleaned.split('/').map(encodeURIComponent).join('/')}`;
            const res = await ncFetch(url, { method: 'DELETE' });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Trash item not found: ${args.trashPath}` };
            if (!res.ok && res.status !== 204) return { error: `Permanent delete failed (${res.status})` };
            return { success: true, deleted: args.trashPath };
        }

        case 'nextcloud_list_versions': {
            if (!args.fileId) return { error: 'fileId is required' };
            const url = `${baseUrl}/remote.php/dav/versions/${encodeURIComponent(uid)}/versions/${encodeURIComponent(args.fileId)}/`;
            const body = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
  </d:prop>
</d:propfind>`;
            const res = await ncFetch(url, {
                method: 'PROPFIND',
                headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
                body,
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `No version history for fileId ${args.fileId}` };
            if (!res.ok) return { error: `Version list failed (${res.status})` };
            const xml = await res.text();
            const versions = [];
            for (const { href, props } of parseMultistatus(xml)) {
                if (!href) continue;
                // The first response is the version container itself — skip.
                const decodedHref = decodeURIComponent(href);
                const segments = decodedHref.split('/').filter(Boolean);
                const versionId = segments[segments.length - 1];
                if (versionId === String(args.fileId)) continue;
                versions.push({
                    versionId,
                    size: parseInt(props.getcontentlength || '0', 10),
                    modified: props.getlastmodified || null,
                    contentType: props.getcontenttype || null,
                    href: decodedHref,
                });
            }
            return { fileId: args.fileId, count: versions.length, versions };
        }

        case 'nextcloud_restore_version': {
            if (!args.fileId || !args.versionId) return { error: 'fileId and versionId are required' };
            const sourceUrl = `${baseUrl}/remote.php/dav/versions/${encodeURIComponent(uid)}/versions/${encodeURIComponent(args.fileId)}/${encodeURIComponent(args.versionId)}`;
            const destUrl = `${baseUrl}/remote.php/dav/versions/${encodeURIComponent(uid)}/restore/target`;
            const res = await ncFetch(sourceUrl, {
                method: 'MOVE',
                headers: { 'Destination': destUrl },
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Version not found: ${args.versionId}` };
            if (!res.ok && res.status !== 204) {
                const text = await res.text().catch(() => '');
                return { error: `Version restore failed (${res.status}): ${text.slice(0, 200)}` };
            }
            return { success: true, fileId: args.fileId, versionId: args.versionId };
        }

        default:
            return { error: `Unknown Nextcloud tool: ${toolName}` };
    }
}

function isNextcloudTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_');
}

module.exports = {
    NEXTCLOUD_TOOLS,
    executeNextcloudTool,
    isNextcloudTool,
};
