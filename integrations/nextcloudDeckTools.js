/**
 * Nextcloud Deck Tools — kanban boards / stacks / cards / labels / comments.
 *
 * Uses the Deck app's REST API at /index.php/apps/deck/api/v1.0/. Auth handled
 * by ./nextcloudClient (Bearer when the user logged in via Nextcloud OAuth,
 * app-password Basic otherwise).
 *
 * Coverage: list boards, list stacks, list/search cards, get card, create card,
 * update card (title/desc/duedate/labels), move card across stacks, archive,
 * delete, and add comments.
 */

const ncClient = require('./nextcloudClient');

const NEXTCLOUD_DECK_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_list_boards',
            description: 'List Deck boards the user has access to. Returns id, title, color, archived state, and label/permission summary.',
            parameters: {
                type: 'object',
                properties: {
                    includeArchived: { type: 'boolean', description: 'Include archived boards (default false).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_get_board',
            description: 'Fetch a single Deck board with its full label set, ACL, and stack/card counts.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer', description: 'Numeric board id (from list_boards).' }
                },
                required: ['boardId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_list_stacks',
            description: 'List the columns ("stacks") of a Deck board. Each stack carries the cards currently in that column.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' }
                },
                required: ['boardId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_create_stack',
            description: 'Create a new column ("stack") on a Deck board. Use this to set up board structure (e.g. "New", "In Progress", "Done") before adding cards. The user has approved this — go ahead.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer', description: 'Board id from nextcloud_deck_list_boards.' },
                    title: { type: 'string', description: 'Column title (e.g. "In Wait", "To Verify").' },
                    order: { type: 'integer', description: 'Optional sort order. Lower numbers appear first; defaults to 999 (rightmost).' }
                },
                required: ['boardId', 'title']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_update_stack',
            description: 'Rename a stack or change its order. Only provided fields change. The user has approved this update.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    stackId: { type: 'integer' },
                    title: { type: 'string' },
                    order: { type: 'integer' }
                },
                required: ['boardId', 'stackId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_delete_stack',
            description: 'Delete a stack (column) from a Deck board. This also removes the stack\'s cards. Always confirm with the user before calling — deletion cannot be undone via the API.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    stackId: { type: 'integer' }
                },
                required: ['boardId', 'stackId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_list_cards',
            description: 'List cards on a board, optionally filtered by stack, label, due date, or assigned user. Combine multiple filters to narrow the result.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    stackId: { type: 'integer', description: 'Filter to a single stack.' },
                    labelTitle: { type: 'string', description: 'Filter to cards carrying a label whose title matches (case-insensitive).' },
                    assignedUid: { type: 'string', description: 'Filter to cards assigned to a specific Nextcloud user.' },
                    dueBefore: { type: 'string', description: 'ISO 8601 — keep only cards with duedate <= this.' },
                    dueAfter: { type: 'string', description: 'ISO 8601 — keep only cards with duedate >= this.' },
                    includeArchived: { type: 'boolean' },
                    limit: { type: 'integer', description: 'Max cards (default 200, max 1000).' }
                },
                required: ['boardId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_search_cards',
            description: 'Search cards on a board by case-insensitive substring match against title and description.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    query: { type: 'string' },
                    limit: { type: 'integer', description: 'Max results (default 50, max 200).' }
                },
                required: ['boardId', 'query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_get_card',
            description: 'Fetch a single Deck card with full description, labels, assigned users, comments, and attachments.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    stackId: { type: 'integer' },
                    cardId: { type: 'integer' }
                },
                required: ['boardId', 'stackId', 'cardId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_create_card',
            description: 'Create a new Deck card. The user has approved this — go ahead and create it. Use list_boards / list_stacks first if you need ids.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    stackId: { type: 'integer', description: 'Column the card lands in.' },
                    title: { type: 'string' },
                    description: { type: 'string' },
                    duedate: { type: 'string', description: 'ISO 8601 due date (optional).' },
                    type: { type: 'string', description: 'Card type, defaults to "plain".' }
                },
                required: ['boardId', 'stackId', 'title']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_update_card',
            description: 'Update fields on a Deck card. Only provided fields change. Pass `targetStackId` to move the card between columns. The user has approved this update.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    stackId: { type: 'integer', description: 'Current stack the card lives in.' },
                    cardId: { type: 'integer' },
                    title: { type: 'string' },
                    description: { type: 'string' },
                    duedate: { type: 'string', description: 'ISO 8601, or empty string to clear.' },
                    targetStackId: { type: 'integer', description: 'If set, move the card to this stack on the same board.' },
                    order: { type: 'integer', description: 'Position within the (target) stack. 0 = top.' }
                },
                required: ['boardId', 'stackId', 'cardId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_archive_card',
            description: 'Archive (or unarchive) a Deck card. Confirm with the user before calling.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    stackId: { type: 'integer' },
                    cardId: { type: 'integer' },
                    archived: { type: 'boolean', description: 'true = archive, false = unarchive (default true).' }
                },
                required: ['boardId', 'stackId', 'cardId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_delete_card',
            description: 'Delete a Deck card permanently. Always confirm with the user before calling.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    stackId: { type: 'integer' },
                    cardId: { type: 'integer' }
                },
                required: ['boardId', 'stackId', 'cardId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_assign_label',
            description: 'Attach a label (by id) to a card. Get label ids via get_board.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    stackId: { type: 'integer' },
                    cardId: { type: 'integer' },
                    labelId: { type: 'integer' }
                },
                required: ['boardId', 'stackId', 'cardId', 'labelId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_remove_label',
            description: 'Detach a label from a card.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    stackId: { type: 'integer' },
                    cardId: { type: 'integer' },
                    labelId: { type: 'integer' }
                },
                required: ['boardId', 'stackId', 'cardId', 'labelId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_add_comment',
            description: 'Add a comment to a Deck card.',
            parameters: {
                type: 'object',
                properties: {
                    cardId: { type: 'integer' },
                    message: { type: 'string', description: 'Plain-text comment body.' },
                    parentId: { type: 'integer', description: 'Optional parent comment id (reply).' }
                },
                required: ['cardId', 'message']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_list_comments',
            description: 'List comments on a Deck card (newest first).',
            parameters: {
                type: 'object',
                properties: {
                    cardId: { type: 'integer' },
                    limit: { type: 'integer', description: 'Max comments (default 50, max 200).' }
                },
                required: ['cardId']
            }
        }
    }
];

// ─── Helpers ──────────────────────────────────────────────────────

function deckRoot(baseUrl) {
    return `${baseUrl}/index.php/apps/deck/api/v1.0`;
}

function commentsRoot(baseUrl) {
    return `${baseUrl}/ocs/v2.php/apps/deck/api/v1.0`;
}

async function readJsonSafe(res) {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text); } catch { return text; }
}

async function deckJson(ncFetch, url, options = {}) {
    const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json', ...(options.headers || {}) };
    const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    return ncFetch(url, { ...options, headers, body });
}

function compareDates(iso, opIso, op) {
    if (!iso || !opIso) return false;
    const a = new Date(iso).getTime();
    const b = new Date(opIso).getTime();
    if (isNaN(a) || isNaN(b)) return false;
    return op === 'lte' ? a <= b : a >= b;
}

// ─── Tool execution ──────────────────────────────────────────────

// Deck splits its surface across two URL families:
//   - REST  /index.php/apps/deck/api/v1.0/...  → no OCS-APIRequest header
//   - OCS   /ocs/v2.php/apps/deck/api/v1.0/... → OCS-APIRequest required
// Sending OCS-APIRequest on the REST family triggers a 401 in some Nextcloud
// versions because NC's framework switches to the OCS auth middleware mid-flight.
const REST_HEADERS = { 'Accept': 'application/json' };
const OCS_HEADERS  = { 'Accept': 'application/json', 'OCS-APIRequest': 'true' };

async function executeNextcloudDeckTool(toolName, args, userId, session) {
    // Deck's REST controllers (BoardApiController, StackApiController, etc.)
    // are #[CORS]-annotated, so Nextcloud's CORS middleware rejects OAuth
    // Bearer auth (logs the session out, demands HTTP Basic). Prefer the
    // user's app password when available; fall back to OAuth only for
    // environments where Bearer happens to work (some older NC versions).
    let ctx = await ncClient.resolveBasicAuthOrNull(userId);
    if (!ctx) {
        if (ncClient.isNextcloudOAuthSession(session)) {
            return { error: ncClient.CORS_AUTH_ERROR };
        }
        ctx = await ncClient.resolveAuth(session, userId);
    }
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    const api = deckRoot(baseUrl);

    switch (toolName) {
        case 'nextcloud_deck_list_boards': {
            const url = `${api}/boards${args.includeArchived ? '?details=true' : ''}`;
            const res = await ncFetch(url, { headers: REST_HEADERS });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Deck boards list failed (${res.status})` };
            const boards = await readJsonSafe(res);
            const list = Array.isArray(boards)
                ? boards.filter(b => args.includeArchived || !b.archived).map(b => ({
                    id: b.id, title: b.title, color: b.color, archived: b.archived,
                    labels: (b.labels || []).map(l => ({ id: l.id, title: l.title, color: l.color })),
                    permissions: b.permissions, owner: b.owner?.uid || b.owner,
                }))
                : [];
            return { count: list.length, boards: list };
        }

        case 'nextcloud_deck_get_board': {
            if (!args.boardId) return { error: 'boardId is required' };
            const res = await ncFetch(`${api}/boards/${args.boardId}`, { headers: REST_HEADERS });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Board not found: ${args.boardId}` };
            if (!res.ok) return { error: `Deck board fetch failed (${res.status})` };
            return await readJsonSafe(res);
        }

        case 'nextcloud_deck_list_stacks': {
            if (!args.boardId) return { error: 'boardId is required' };
            const res = await ncFetch(`${api}/boards/${args.boardId}/stacks`, { headers: REST_HEADERS });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Stack list failed (${res.status})` };
            const stacks = await readJsonSafe(res);
            return Array.isArray(stacks)
                ? { count: stacks.length, stacks: stacks.map(s => ({ id: s.id, title: s.title, order: s.order, cardCount: (s.cards || []).length })) }
                : stacks;
        }

        case 'nextcloud_deck_create_stack': {
            if (!args.boardId || !args.title) return { error: 'boardId and title are required' };
            const res = await deckJson(ncFetch, `${api}/boards/${args.boardId}/stacks`, {
                method: 'POST',
                headers: REST_HEADERS,
                body: {
                    title: String(args.title),
                    order: args.order !== undefined ? Number(args.order) : 999,
                },
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Board not found: ${args.boardId}` };
            if (!res.ok) {
                const detail = await readJsonSafe(res);
                return { error: `Stack create failed (${res.status})`, detail };
            }
            const stack = await readJsonSafe(res);
            return {
                success: true,
                stack: { id: stack.id, title: stack.title, order: stack.order, boardId: args.boardId },
            };
        }

        case 'nextcloud_deck_update_stack': {
            if (!args.boardId || !args.stackId) return { error: 'boardId and stackId are required' };
            // Deck's PUT is a replace — fetch current then merge.
            const listRes = await ncFetch(`${api}/boards/${args.boardId}/stacks`, { headers: REST_HEADERS });
            if (listRes.status === 401) return { error: authError };
            if (!listRes.ok) return { error: `Could not load stacks for update (${listRes.status})` };
            const stacks = await readJsonSafe(listRes);
            const current = Array.isArray(stacks) ? stacks.find(s => s.id === Number(args.stackId)) : null;
            if (!current) return { error: `Stack not found: ${args.stackId}` };

            const merged = {
                title: args.title !== undefined ? String(args.title) : current.title,
                order: args.order !== undefined ? Number(args.order) : current.order,
            };
            const putRes = await deckJson(ncFetch, `${api}/boards/${args.boardId}/stacks/${args.stackId}`, {
                method: 'PUT',
                headers: REST_HEADERS,
                body: merged,
            });
            if (!putRes.ok) {
                const detail = await readJsonSafe(putRes);
                return { error: `Stack update failed (${putRes.status})`, detail };
            }
            const updated = await readJsonSafe(putRes);
            return { success: true, stack: { id: updated.id, title: updated.title, order: updated.order } };
        }

        case 'nextcloud_deck_delete_stack': {
            if (!args.boardId || !args.stackId) return { error: 'boardId and stackId are required' };
            const res = await ncFetch(`${api}/boards/${args.boardId}/stacks/${args.stackId}`, {
                method: 'DELETE',
                headers: REST_HEADERS,
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Stack not found: ${args.stackId}` };
            if (!res.ok && res.status !== 200 && res.status !== 204) {
                return { error: `Stack delete failed (${res.status})` };
            }
            return { success: true, stackId: args.stackId };
        }

        case 'nextcloud_deck_list_cards':
        case 'nextcloud_deck_search_cards': {
            if (!args.boardId) return { error: 'boardId is required' };
            const res = await ncFetch(`${api}/boards/${args.boardId}/stacks${args.includeArchived ? '/archived' : ''}`, {
                headers: REST_HEADERS,
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Card list failed (${res.status})` };
            const stacks = await readJsonSafe(res);
            if (!Array.isArray(stacks)) return { error: 'Unexpected Deck response shape' };

            const labelFilter = args.labelTitle ? args.labelTitle.toLowerCase() : null;
            const queryFilter = args.query ? args.query.toLowerCase() : null;
            const cards = [];
            for (const stack of stacks) {
                if (args.stackId && stack.id !== args.stackId) continue;
                for (const c of (stack.cards || [])) {
                    if (queryFilter) {
                        const haystack = `${c.title || ''} ${c.description || ''}`.toLowerCase();
                        if (!haystack.includes(queryFilter)) continue;
                    }
                    if (labelFilter && !(c.labels || []).some(l => (l.title || '').toLowerCase().includes(labelFilter))) continue;
                    if (args.assignedUid && !(c.assignedUsers || []).some(u => (u.participant?.uid || u.uid) === args.assignedUid)) continue;
                    if (args.dueBefore && !compareDates(c.duedate, args.dueBefore, 'lte')) continue;
                    if (args.dueAfter && !compareDates(c.duedate, args.dueAfter, 'gte')) continue;
                    cards.push({
                        id: c.id, stackId: stack.id, stackTitle: stack.title,
                        title: c.title, description: c.description, duedate: c.duedate,
                        labels: (c.labels || []).map(l => ({ id: l.id, title: l.title, color: l.color })),
                        assignedUsers: (c.assignedUsers || []).map(u => u.participant?.uid || u.uid),
                        archived: c.archived, order: c.order, type: c.type,
                    });
                }
            }
            const limit = Math.min(Math.max(args.limit || (toolName === 'nextcloud_deck_search_cards' ? 50 : 200), 1), toolName === 'nextcloud_deck_search_cards' ? 200 : 1000);
            return { boardId: args.boardId, count: Math.min(cards.length, limit), cards: cards.slice(0, limit) };
        }

        case 'nextcloud_deck_get_card': {
            if (!args.boardId || !args.stackId || !args.cardId) return { error: 'boardId, stackId, cardId required' };
            const res = await ncFetch(`${api}/boards/${args.boardId}/stacks/${args.stackId}/cards/${args.cardId}`, {
                headers: REST_HEADERS,
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Card not found: ${args.cardId}` };
            if (!res.ok) return { error: `Card fetch failed (${res.status})` };
            return await readJsonSafe(res);
        }

        case 'nextcloud_deck_create_card': {
            if (!args.boardId || !args.stackId || !args.title) return { error: 'boardId, stackId, title required' };
            const res = await deckJson(ncFetch, `${api}/boards/${args.boardId}/stacks/${args.stackId}/cards`, {
                method: 'POST',
                headers: REST_HEADERS,
                body: {
                    title: args.title,
                    type: args.type || 'plain',
                    order: 999,
                    description: args.description || '',
                    duedate: args.duedate || null,
                },
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) {
                const body = await readJsonSafe(res);
                return { error: `Card create failed (${res.status})`, detail: body };
            }
            return await readJsonSafe(res);
        }

        case 'nextcloud_deck_update_card': {
            if (!args.boardId || !args.stackId || !args.cardId) return { error: 'boardId, stackId, cardId required' };
            // Deck's PUT replaces the card — fetch first and merge.
            const cardRes = await ncFetch(`${api}/boards/${args.boardId}/stacks/${args.stackId}/cards/${args.cardId}`, {
                headers: REST_HEADERS,
            });
            if (cardRes.status === 401) return { error: authError };
            if (cardRes.status === 404) return { error: `Card not found: ${args.cardId}` };
            if (!cardRes.ok) return { error: `Could not load card for update (${cardRes.status})` };
            const current = await readJsonSafe(cardRes);

            const merged = {
                title: args.title !== undefined ? args.title : current.title,
                description: args.description !== undefined ? args.description : current.description,
                duedate: args.duedate !== undefined ? (args.duedate === '' ? null : args.duedate) : current.duedate,
                type: current.type || 'plain',
                owner: current.owner?.uid || current.owner,
                order: args.order !== undefined ? args.order : current.order,
            };
            const putRes = await deckJson(ncFetch, `${api}/boards/${args.boardId}/stacks/${args.stackId}/cards/${args.cardId}`, {
                method: 'PUT',
                headers: REST_HEADERS,
                body: merged,
            });
            if (putRes.status === 401) return { error: authError };
            if (!putRes.ok) {
                const body = await readJsonSafe(putRes);
                return { error: `Card update failed (${putRes.status})`, detail: body };
            }
            const updated = await readJsonSafe(putRes);

            // Move to a different stack if requested.
            if (args.targetStackId && args.targetStackId !== args.stackId) {
                const moveRes = await deckJson(ncFetch, `${api}/boards/${args.boardId}/stacks/${args.stackId}/cards/${args.cardId}/reorder`, {
                    method: 'PUT',
                    headers: REST_HEADERS,
                    body: { order: args.order !== undefined ? args.order : 0, stackId: args.targetStackId },
                });
                if (!moveRes.ok) {
                    const body = await readJsonSafe(moveRes);
                    return { success: true, updated, moveError: `Card update succeeded but move failed (${moveRes.status})`, moveDetail: body };
                }
            }
            return { success: true, card: updated };
        }

        case 'nextcloud_deck_archive_card': {
            if (!args.boardId || !args.stackId || !args.cardId) return { error: 'boardId, stackId, cardId required' };
            const archived = args.archived === false ? false : true;
            const cardRes = await ncFetch(`${api}/boards/${args.boardId}/stacks/${args.stackId}/cards/${args.cardId}`, {
                headers: REST_HEADERS,
            });
            if (!cardRes.ok) return { error: `Could not load card (${cardRes.status})` };
            const current = await readJsonSafe(cardRes);
            const putRes = await deckJson(ncFetch, `${api}/boards/${args.boardId}/stacks/${args.stackId}/cards/${args.cardId}`, {
                method: 'PUT',
                headers: REST_HEADERS,
                body: {
                    title: current.title,
                    description: current.description || '',
                    duedate: current.duedate || null,
                    type: current.type || 'plain',
                    owner: current.owner?.uid || current.owner,
                    order: current.order,
                    archived,
                },
            });
            if (!putRes.ok) {
                const body = await readJsonSafe(putRes);
                return { error: `Archive toggle failed (${putRes.status})`, detail: body };
            }
            return { success: true, archived };
        }

        case 'nextcloud_deck_delete_card': {
            if (!args.boardId || !args.stackId || !args.cardId) return { error: 'boardId, stackId, cardId required' };
            const res = await ncFetch(`${api}/boards/${args.boardId}/stacks/${args.stackId}/cards/${args.cardId}`, {
                method: 'DELETE',
                headers: REST_HEADERS,
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Card not found: ${args.cardId}` };
            if (!res.ok && res.status !== 200 && res.status !== 204) return { error: `Card delete failed (${res.status})` };
            return { success: true, cardId: args.cardId };
        }

        case 'nextcloud_deck_assign_label':
        case 'nextcloud_deck_remove_label': {
            if (!args.boardId || !args.stackId || !args.cardId || !args.labelId) return { error: 'boardId, stackId, cardId, labelId required' };
            const op = toolName === 'nextcloud_deck_assign_label' ? 'assignLabel' : 'removeLabel';
            const res = await deckJson(ncFetch, `${api}/boards/${args.boardId}/stacks/${args.stackId}/cards/${args.cardId}/${op}`, {
                method: 'PUT',
                headers: REST_HEADERS,
                body: { labelId: args.labelId },
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) {
                const body = await readJsonSafe(res);
                return { error: `${op} failed (${res.status})`, detail: body };
            }
            return { success: true };
        }

        case 'nextcloud_deck_add_comment': {
            if (!args.cardId || !args.message) return { error: 'cardId and message required' };
            // Deck comments live under OCS, not the v1.0 REST path.
            const url = `${commentsRoot(baseUrl)}/cards/${args.cardId}/comments`;
            const res = await deckJson(ncFetch, url, {
                method: 'POST',
                headers: OCS_HEADERS,
                body: {
                    message: args.message,
                    parentId: args.parentId || 0,
                },
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) {
                const body = await readJsonSafe(res);
                return { error: `Comment failed (${res.status})`, detail: body };
            }
            const data = await readJsonSafe(res);
            return { success: true, comment: data?.ocs?.data || data };
        }

        case 'nextcloud_deck_list_comments': {
            if (!args.cardId) return { error: 'cardId is required' };
            const limit = Math.min(Math.max(args.limit || 50, 1), 200);
            const url = `${commentsRoot(baseUrl)}/cards/${args.cardId}/comments?limit=${limit}`;
            const res = await ncFetch(url, { headers: OCS_HEADERS });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Comment list failed (${res.status})` };
            const data = await readJsonSafe(res);
            const list = data?.ocs?.data || data || [];
            return { count: Array.isArray(list) ? list.length : 0, comments: list };
        }

        default:
            return { error: `Unknown Nextcloud Deck tool: ${toolName}` };
    }
}

function isNextcloudDeckTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_deck_');
}

module.exports = {
    NEXTCLOUD_DECK_TOOLS,
    executeNextcloudDeckTool,
    isNextcloudDeckTool,
};
