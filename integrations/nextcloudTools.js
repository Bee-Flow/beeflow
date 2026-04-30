/**
 * Nextcloud Tools — AI tools for files via WebDAV + OCS.
 *
 * App-password based (users set username + app password in Settings → Integrations,
 * generated in Nextcloud → Settings → Security → Devices & sessions). Auth is
 * HTTP Basic. The Nextcloud base URL is read from the global oauth.nextcloudUrl
 * config, so admins configure it once for the whole tenant — same place OAuth
 * SSO uses.
 */

const configStore = require('../stores/configStore');
const userStore = require('../stores/userStore');

const MAX_TEXT_BYTES = 200 * 1024;          // 200 KB cap on file reads
const REQUEST_TIMEOUT_MS = 20000;
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
            description: 'Read the text contents of a file from Nextcloud. Files larger than ~200 KB are truncated. Binary files are not supported.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Full path to the file (e.g. "/Documents/notes.md").' }
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
    }
];

// ─── Helpers ──────────────────────────────────────────────────────

async function getCreds(userId) {
    const oauth = (await configStore.getConfig('oauth')) || {};
    const baseUrl = (oauth.nextcloudUrl || '').replace(/\/+$/, '');
    if (!baseUrl) {
        throw new Error('Nextcloud URL not configured. Ask an admin to set it under Admin → Authentication.');
    }
    const creds = await userStore.getAppPassword(userId);
    if (!creds || !creds.username || !creds.password) {
        throw new Error('Nextcloud not connected. Add your username and app password in Settings → Integrations.');
    }
    return { baseUrl, username: creds.username, password: creds.password };
}

function basicAuth(username, password) {
    return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

function webdavRoot(baseUrl, username) {
    return `${baseUrl}/remote.php/dav/files/${encodeURIComponent(username)}`;
}

function joinDavPath(root, path) {
    const cleaned = String(path || '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!cleaned) return root + '/';
    const encoded = cleaned.split('/').map(encodeURIComponent).join('/');
    return `${root}/${encoded}`;
}

async function ncFetch(url, options = {}) {
    return fetch(url, {
        ...options,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
}

function relativeFromRoot(href, baseUrl, username) {
    // Convert WebDAV href like "/remote.php/dav/files/alice/Documents/foo.md"
    // to "/Documents/foo.md" (the user-facing path).
    try {
        const decoded = decodeURIComponent(href);
        const rootPath = `/remote.php/dav/files/${decodeURIComponent(username)}`;
        const idx = decoded.indexOf(rootPath);
        if (idx === -1) return decoded;
        return decoded.slice(idx + rootPath.length) || '/';
    } catch (_) {
        return href;
    }
}

// Minimal PROPFIND XML parser — extracts <d:response> blocks. Avoids pulling
// in a heavy XML dep; the response shape is well-defined and stable.
function parsePropfind(xml, baseUrl, username) {
    const responses = [];
    const respRegex = /<d:response[\s>][\s\S]*?<\/d:response>/g;
    const matches = xml.match(respRegex) || [];
    for (const block of matches) {
        const href = (block.match(/<d:href>([^<]+)<\/d:href>/) || [])[1];
        if (!href) continue;
        const isCollection = /<d:resourcetype>\s*<d:collection\s*\/>\s*<\/d:resourcetype>/.test(block);
        const size = parseInt((block.match(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/) || [])[1] || '0', 10);
        const contentType = (block.match(/<d:getcontenttype>([^<]*)<\/d:getcontenttype>/) || [])[1] || null;
        const lastMod = (block.match(/<d:getlastmodified>([^<]+)<\/d:getlastmodified>/) || [])[1] || null;
        const fileId = (block.match(/<oc:fileid>([^<]+)<\/oc:fileid>/) || [])[1] || null;
        const path = relativeFromRoot(href, baseUrl, username);
        const name = path.replace(/\/$/, '').split('/').pop() || '/';
        responses.push({
            name,
            path: path.replace(/\/$/, '') || '/',
            type: isCollection ? 'folder' : 'file',
            size: isCollection ? undefined : size,
            contentType: isCollection ? undefined : contentType,
            modified: lastMod,
            fileId,
        });
    }
    return responses;
}

// ─── Tool Execution ───────────────────────────────────────────────

async function executeNextcloudTool(toolName, args, userId) {
    const { baseUrl, username, password } = await getCreds(userId);
    const auth = basicAuth(username, password);
    const root = webdavRoot(baseUrl, username);

    switch (toolName) {
        case 'nextcloud_list_files': {
            const url = joinDavPath(root, args.path) + (joinDavPath(root, args.path).endsWith('/') ? '' : '/');
            const res = await ncFetch(url, {
                method: 'PROPFIND',
                headers: {
                    'Authorization': auth,
                    'Depth': '1',
                    'Content-Type': 'application/xml; charset=utf-8',
                    'Accept': 'application/xml',
                },
                body: PROPFIND_BODY,
            });
            if (res.status === 404) return { error: `Folder not found: ${args.path}` };
            if (res.status === 401) return { error: 'Nextcloud rejected credentials. Re-save your app password in Settings → Integrations.' };
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return { error: `Nextcloud PROPFIND failed (${res.status}): ${text.slice(0, 200)}` };
            }
            const xml = await res.text();
            const all = parsePropfind(xml, baseUrl, username);
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
                headers: { 'Authorization': auth, 'OCS-APIRequest': 'true', 'Accept': 'application/json' },
            });
            if (res.status === 401) return { error: 'Nextcloud rejected credentials.' };
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
            const res = await ncFetch(url, { headers: { 'Authorization': auth } });
            if (res.status === 404) return { error: `File not found: ${args.path}` };
            if (res.status === 401) return { error: 'Nextcloud rejected credentials.' };
            if (!res.ok) return { error: `Nextcloud read failed (${res.status})` };
            const contentType = res.headers.get('content-type') || '';
            const buf = Buffer.from(await res.arrayBuffer());
            const isText = /^(text\/|application\/(json|xml|x-yaml|x-sh|javascript))/i.test(contentType) || buf.slice(0, 1024).every(b => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127));
            if (!isText) {
                return { error: `File appears to be binary (${contentType || 'unknown type'}). Reading binary files is not supported.`, size: buf.length, contentType };
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
                    'Authorization': auth,
                    'Content-Type': args.contentType || 'text/plain; charset=utf-8',
                },
                body: args.content,
            });
            if (res.status === 401) return { error: 'Nextcloud rejected credentials.' };
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
            const res = await ncFetch(url, { method: 'MKCOL', headers: { 'Authorization': auth } });
            if (res.status === 401) return { error: 'Nextcloud rejected credentials.' };
            if (res.status === 405) return { error: `Folder already exists: ${args.path}` };
            if (res.status === 409) return { error: `Parent folder for ${args.path} does not exist.` };
            if (!res.ok) return { error: `Folder creation failed (${res.status})` };
            return { success: true, path: args.path };
        }

        case 'nextcloud_delete': {
            if (!args.path) return { error: 'path is required' };
            const url = joinDavPath(root, args.path);
            const res = await ncFetch(url, { method: 'DELETE', headers: { 'Authorization': auth } });
            if (res.status === 404) return { error: `Not found: ${args.path}` };
            if (res.status === 401) return { error: 'Nextcloud rejected credentials.' };
            if (!res.ok && res.status !== 204) return { error: `Delete failed (${res.status})` };
            return { success: true, path: args.path };
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
                    'Authorization': auth,
                    'OCS-APIRequest': 'true',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                },
                body: params.toString(),
            });
            if (res.status === 401) return { error: 'Nextcloud rejected credentials.' };
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
