/**
 * Nextcloud Notes Tools — JSON CRUD on /index.php/apps/notes/api/v1/notes.
 *
 * Auth handled by ./nextcloudClient. Notes are simple plain-text/markdown
 * documents with title, content, category, favorite flag — useful as an
 * AI scratchpad or personal knowledge store.
 */

const ncClient = require('./nextcloudClient');

const MAX_CONTENT_BYTES = 200 * 1024;

const NEXTCLOUD_NOTES_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_notes_list',
            description: 'List the user\'s Nextcloud notes (id, title, category, modified time, excerpt).',
            parameters: {
                type: 'object',
                properties: {
                    category: { type: 'string', description: 'Filter by category (folder).' },
                    favorite: { type: 'boolean', description: 'Only favorites.' },
                    limit: { type: 'integer', description: 'Max notes (default 100, max 500).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_notes_search',
            description: 'Search notes by case-insensitive substring match on title and content.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    limit: { type: 'integer', description: 'Max results (default 25, max 100).' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_notes_get',
            description: 'Fetch a single note (full content). Long content is truncated to ~200 KB.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'integer', description: 'Note id (from list).' }
                },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_notes_create',
            description: 'Create a new note. The user has approved this — go ahead.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string' },
                    content: { type: 'string', description: 'Full note body (plain text or markdown).' },
                    category: { type: 'string', description: 'Folder/category. Use "/" or omit for the root.' },
                    favorite: { type: 'boolean' }
                },
                required: ['title', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_notes_update',
            description: 'Update fields on a note. Only provided fields change. The user has approved this update.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    title: { type: 'string' },
                    content: { type: 'string' },
                    category: { type: 'string' },
                    favorite: { type: 'boolean' }
                },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_notes_delete',
            description: 'Delete a note. Always confirm with the user before calling.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'integer' }
                },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_notes_list_categories',
            description: 'List the distinct note categories (folders) the user has.',
            parameters: { type: 'object', properties: {} }
        }
    }
];

function notesApi(baseUrl) {
    return `${baseUrl}/index.php/apps/notes/api/v1/notes`;
}

async function readJsonSafe(res) {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text); } catch { return text; }
}

function trimContent(content) {
    if (!content) return content;
    if (content.length <= MAX_CONTENT_BYTES) return content;
    return content.slice(0, MAX_CONTENT_BYTES) + '\n\n... [truncated — note too large]';
}

function summarise(note) {
    return {
        id: note.id,
        title: note.title,
        category: note.category,
        modified: note.modified,
        favorite: note.favorite,
        excerpt: (note.content || '').slice(0, 200),
    };
}

async function executeNextcloudNotesTool(toolName, args, userId, session) {
    // The Notes API's controller methods are #[CORS]-annotated, which forces
    // Nextcloud to demand HTTP Basic auth even when an OAuth session is
    // active (the CORS middleware logs the Bearer session out before checking
    // creds — see CORSMiddleware::beforeController). So we must use the
    // user's saved app password, never the Bearer token.
    let ctx = await ncClient.resolveBasicAuthOrNull(userId);
    if (!ctx) {
        // No app password saved. If they're on OAuth, give them a CORS-specific
        // hint; otherwise, fall through to the generic resolveAuth which will
        // surface a "not connected" error.
        if (ncClient.isNextcloudOAuthSession(session)) {
            return { error: ncClient.CORS_AUTH_ERROR };
        }
        ctx = await ncClient.resolveAuth(session, userId);
    }
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    const api = notesApi(baseUrl);

    const baseHeaders = { 'Accept': 'application/json' };

    switch (toolName) {
        case 'nextcloud_notes_list': {
            const params = new URLSearchParams();
            if (args.category !== undefined) params.set('category', args.category);
            if (args.favorite !== undefined) params.set('favorite', args.favorite ? 'true' : 'false');
            params.set('exclude', 'content'); // Keep payload small for list view.
            const url = `${api}${params.toString() ? '?' + params.toString() : ''}`;
            const res = await ncFetch(url, { headers: baseHeaders });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: 'Notes app is not installed/enabled on this Nextcloud server.' };
            if (!res.ok) return { error: `Notes list failed (${res.status})` };
            const data = await readJsonSafe(res);
            const limit = Math.min(Math.max(args.limit || 100, 1), 500);
            const list = Array.isArray(data) ? data.slice(0, limit).map(summarise) : [];
            return { count: list.length, notes: list };
        }

        case 'nextcloud_notes_search': {
            const q = String(args.query || '').toLowerCase().trim();
            if (!q) return { error: 'query is required' };
            const limit = Math.min(Math.max(args.limit || 25, 1), 100);
            // Notes API has no native search endpoint, but it supports chunked
            // pagination (Notes app v1.2+) — page through with chunkSize=50 and
            // break as soon as `limit` matches are found. Keeps any single
            // response under ~2 MB even for accounts with thousands of notes.
            const matches = [];
            let cursor = null;
            const MAX_CHUNKS = 40; // Safety net: scans up to 2000 notes if no match.
            let chunks = 0;
            while (chunks < MAX_CHUNKS && matches.length < limit) {
                const params = new URLSearchParams();
                params.set('chunkSize', '50');
                if (cursor) params.set('chunkCursor', cursor);
                const res = await ncFetch(`${api}?${params.toString()}`, { headers: baseHeaders });
                if (res.status === 401) return { error: authError };
                if (!res.ok) return { error: `Notes search failed (${res.status})` };
                const data = await readJsonSafe(res);
                if (!Array.isArray(data)) return { error: 'Unexpected Notes response' };
                for (const note of data) {
                    const haystack = `${note.title || ''}\n${note.content || ''}`.toLowerCase();
                    if (haystack.includes(q)) {
                        matches.push(summarise(note));
                        if (matches.length >= limit) break;
                    }
                }
                cursor = res.headers.get('X-Notes-Chunk-Cursor');
                const pending = res.headers.get('X-Notes-Chunk-Pending');
                chunks += 1;
                // No cursor → server returned everything in one chunk (Notes < v1.2 or small store).
                if (!cursor || pending === '0' || pending === null) break;
            }
            return { query: args.query, count: matches.length, notes: matches };
        }

        case 'nextcloud_notes_get': {
            if (!args.id) return { error: 'id is required' };
            const res = await ncFetch(`${api}/${encodeURIComponent(args.id)}`, { headers: baseHeaders });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Note not found: ${args.id}` };
            if (!res.ok) return { error: `Note fetch failed (${res.status})` };
            const note = await readJsonSafe(res);
            if (!note || typeof note !== 'object') return { error: 'Unexpected Notes response' };
            const truncated = (note.content || '').length > MAX_CONTENT_BYTES;
            return {
                id: note.id,
                title: note.title,
                category: note.category,
                modified: note.modified,
                favorite: note.favorite,
                etag: note.etag,
                truncated,
                content: trimContent(note.content || ''),
            };
        }

        case 'nextcloud_notes_create': {
            if (!args.title || args.content === undefined) return { error: 'title and content are required' };
            const body = {
                title: args.title,
                content: args.content,
                category: args.category || '',
                favorite: !!args.favorite,
                modified: Math.floor(Date.now() / 1000),
            };
            const res = await ncFetch(api, {
                method: 'POST',
                headers: { ...baseHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) {
                const err = await readJsonSafe(res);
                return { error: `Note create failed (${res.status})`, detail: err };
            }
            const note = await readJsonSafe(res);
            return { success: true, note: summarise(note) };
        }

        case 'nextcloud_notes_update': {
            if (!args.id) return { error: 'id is required' };
            // Notes' PUT does a partial update — only send the fields the LLM provided.
            const body = {};
            if (args.title !== undefined) body.title = args.title;
            if (args.content !== undefined) body.content = args.content;
            if (args.category !== undefined) body.category = args.category;
            if (args.favorite !== undefined) body.favorite = !!args.favorite;
            if (Object.keys(body).length === 0) return { error: 'no fields to update' };
            body.modified = Math.floor(Date.now() / 1000);

            const res = await ncFetch(`${api}/${encodeURIComponent(args.id)}`, {
                method: 'PUT',
                headers: { ...baseHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Note not found: ${args.id}` };
            if (!res.ok) {
                const err = await readJsonSafe(res);
                return { error: `Note update failed (${res.status})`, detail: err };
            }
            const note = await readJsonSafe(res);
            return { success: true, note: summarise(note) };
        }

        case 'nextcloud_notes_delete': {
            if (!args.id) return { error: 'id is required' };
            const res = await ncFetch(`${api}/${encodeURIComponent(args.id)}`, {
                method: 'DELETE',
                headers: baseHeaders,
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Note not found: ${args.id}` };
            if (!res.ok && res.status !== 200 && res.status !== 204) return { error: `Note delete failed (${res.status})` };
            return { success: true, id: args.id };
        }

        case 'nextcloud_notes_list_categories': {
            const res = await ncFetch(api + '?exclude=content', { headers: baseHeaders });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Notes fetch failed (${res.status})` };
            const data = await readJsonSafe(res);
            if (!Array.isArray(data)) return { error: 'Unexpected Notes response' };
            const counts = new Map();
            for (const note of data) {
                const cat = note.category || '';
                counts.set(cat, (counts.get(cat) || 0) + 1);
            }
            const categories = [...counts.entries()].map(([category, count]) => ({ category, count }));
            categories.sort((a, b) => a.category.localeCompare(b.category));
            return { count: categories.length, categories };
        }

        default:
            return { error: `Unknown Nextcloud notes tool: ${toolName}` };
    }
}

function isNextcloudNotesTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_notes_');
}

module.exports = {
    NEXTCLOUD_NOTES_TOOLS,
    executeNextcloudNotesTool,
    isNextcloudNotesTool,
};
