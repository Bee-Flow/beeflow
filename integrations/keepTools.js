/**
 * Google Keep Tools — AI tools for managing Google Keep notes
 * 
 * Uses Google Keep API (v1) with the existing Google OAuth session.
 * Read operations execute directly; create/delete require user approval.
 * 
 * NOTE: Google Keep API is enterprise-only (Google Workspace).
 * Consumer accounts will receive a clear error message.
 */

const { google } = require('googleapis');
const { loadConfig } = require('../auth/permissions');

const KEEP_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'keep_list',
            description: 'List the user\'s Google Keep notes. Returns note titles, content previews, and whether they are list or text notes.',
            parameters: {
                type: 'object',
                properties: {
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum number of notes to return (1-50, default 20)'
                    },
                    filter: {
                        type: 'string',
                        description: 'Optional filter string (e.g. "is:pinned" or search keywords in title/body)'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'keep_get',
            description: 'Get the full content of a specific Google Keep note by its ID.',
            parameters: {
                type: 'object',
                properties: {
                    noteId: {
                        type: 'string',
                        description: 'The note ID (from keep_list results, e.g. "notes/abc123")'
                    }
                },
                required: ['noteId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'keep_create',
            description: 'Create a new Google Keep note. The user will see a preview and must approve before the note is created. Can create either a text note or a checklist (list note).',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Note title' },
                    content: { type: 'string', description: 'Note text content (for text notes)' },
                    listItems: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                text: { type: 'string', description: 'List item text' },
                                checked: { type: 'boolean', description: 'Whether item is checked (default false)' }
                            },
                            required: ['text']
                        },
                        description: 'List items (for checklist notes — if provided, content is ignored)'
                    }
                },
                required: ['title']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'keep_delete',
            description: 'Delete (trash) a Google Keep note. The user will see a confirmation and must approve before deletion.',
            parameters: {
                type: 'object',
                properties: {
                    noteId: {
                        type: 'string',
                        description: 'The note ID to delete (from keep_list results, e.g. "notes/abc123")'
                    }
                },
                required: ['noteId']
            }
        }
    }
];

// ─── Keep API Client ───────────────────────────────────────────

async function createKeepClient(session) {
    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};

    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Google OAuth not configured');
    }

    const accessToken = session?.accessToken;
    if (!accessToken) {
        throw new Error('Not connected to Google — user must log in with Google');
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

    return google.keep({ version: 'v1', auth: oauth2Client });
}

// ─── Format Note ───────────────────────────────────────────────

function formatNote(note) {
    const result = {
        noteId: note.name,
        title: note.title || '(untitled)',
        createTime: note.createTime,
        updateTime: note.updateTime,
        trashed: note.trashed || false,
    };

    // Determine type and extract content
    if (note.body?.list?.listItems) {
        result.type = 'list';
        result.items = note.body.list.listItems.map(item => ({
            text: item.text?.text || '',
            checked: item.checked || false,
        }));
    } else if (note.body?.text?.text) {
        result.type = 'text';
        result.content = note.body.text.text;
    } else {
        result.type = 'text';
        result.content = '';
    }

    return result;
}

// ─── Tool Execution ────────────────────────────────────────────

async function executeKeepTool(toolName, args, session) {
    let keep;
    try {
        keep = await createKeepClient(session);
    } catch (e) {
        return { error: e.message };
    }

    switch (toolName) {
        case 'keep_list': {
            const { maxResults = 20, filter } = args;
            const limit = Math.min(Math.max(maxResults, 1), 50);
            console.log(`[Keep] Listing notes (max ${limit})`);

            try {
                const params = { pageSize: limit };
                if (filter) params.filter = filter;

                const response = await keep.notes.list(params);
                const notes = (response.data.notes || [])
                    .filter(n => !n.trashed)
                    .map(formatNote);

                return {
                    results: notes.slice(0, limit),
                    count: notes.length,
                    message: notes.length > 0
                        ? `Found ${notes.length} note(s).`
                        : 'No notes found.',
                };
            } catch (e) {
                if (e.code === 403 || e.status === 403) {
                    return { error: 'Google Keep API is only available for Google Workspace accounts. Consumer Gmail accounts are not supported.' };
                }
                throw e;
            }
        }

        case 'keep_get': {
            const { noteId } = args;
            if (!noteId) return { error: 'noteId is required' };
            console.log(`[Keep] Getting note: ${noteId}`);

            try {
                const response = await keep.notes.get({ name: noteId });
                const note = formatNote(response.data);
                return {
                    note,
                    message: `Note "${note.title}" retrieved.`,
                };
            } catch (e) {
                if (e.code === 404 || e.status === 404) {
                    return { error: `Note "${noteId}" not found.` };
                }
                if (e.code === 403 || e.status === 403) {
                    return { error: 'Google Keep API is only available for Google Workspace accounts.' };
                }
                throw e;
            }
        }

        case 'keep_create': {
            const { title, content, listItems } = args;
            if (!title) return { error: 'title is required' };

            const draft = {
                action: 'create',
                title,
            };

            if (listItems && listItems.length > 0) {
                draft.type = 'list';
                draft.listItems = listItems.map(item => ({
                    text: item.text,
                    checked: item.checked || false,
                }));
            } else {
                draft.type = 'text';
                draft.content = content || '';
            }

            return {
                _action: 'keep_draft',
                draft,
                message: `Note "${title}" prepared (${draft.type}). Waiting for user approval.`,
            };
        }

        case 'keep_delete': {
            const { noteId } = args;
            if (!noteId) return { error: 'noteId is required' };

            // Fetch the note title for the confirmation card
            let noteTitle = noteId;
            try {
                const response = await keep.notes.get({ name: noteId });
                noteTitle = response.data.title || noteId;
            } catch (e) { /* use ID as fallback title */ }

            return {
                _action: 'keep_draft',
                draft: {
                    action: 'delete',
                    noteId,
                    title: noteTitle,
                },
                message: `Delete "${noteTitle}" prepared. Waiting for user approval.`,
            };
        }

        default:
            throw new Error(`Unknown Keep tool: ${toolName}`);
    }
}

// ─── Execute Action (after user approval) ──────────────────────

async function executeKeepAction(action, session) {
    const keep = await createKeepClient(session);

    if (action.action === 'create') {
        const body = { title: action.title || '' };

        if (action.type === 'list' && action.listItems) {
            body.body = {
                list: {
                    listItems: action.listItems.map(item => ({
                        text: { text: item.text },
                        checked: item.checked || false,
                    })),
                },
            };
        } else {
            body.body = {
                text: { text: action.content || '' },
            };
        }

        console.log(`[Keep] Creating note: "${action.title}"`);
        const response = await keep.notes.create({ requestBody: body });

        return {
            success: true,
            noteId: response.data.name,
            message: `Note "${action.title}" created!`,
        };
    }

    if (action.action === 'delete') {
        console.log(`[Keep] Deleting note: ${action.noteId}`);
        await keep.notes.delete({ name: action.noteId });

        return {
            success: true,
            message: `Note "${action.title || action.noteId}" deleted!`,
        };
    }

    throw new Error(`Unknown Keep action: ${action.action}`);
}

function isKeepTool(toolName) {
    return toolName.startsWith('keep_');
}

module.exports = {
    KEEP_TOOLS,
    executeKeepTool,
    executeKeepAction,
    isKeepTool,
};
