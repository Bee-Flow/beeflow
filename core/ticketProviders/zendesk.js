/**
 * Zendesk — TicketSourceProvider
 *
 * v1 auth: email/token via Basic Auth (Zendesk API token auth).
 *
 * Endpoints used:
 *   GET /api/v2/users/me                                    — credential validation
 *   GET /api/v2/incremental/tickets/cursor.json            — primary list (cursor-based)
 *   GET /api/v2/tickets/{id}/comments.json                  — comments per ticket
 *
 * providerConfig:
 *   { subdomain: 'acme', brandIds?: number[] }
 *
 * Cursor:
 *   { afterCursor: '<opaque>', endOfStream: boolean, startTime?: unix }
 *
 * IMPORTANT: Zendesk enforces a 5-minute minimum cursor-age. The sync engine
 * or route should clamp sync_interval_minutes >= 5 when provider === 'zendesk'.
 */

const { httpJson, basicAuth } = require('./_http');

const ID = 'zendesk';

function baseUrl(subdomain) {
    const sub = (subdomain || '').replace(/^https?:\/\//, '').replace(/\.zendesk\.com.*$/, '');
    return `https://${sub}.zendesk.com`;
}

function authHeader(tokens) {
    // tokens: { kind:'api_token', email, token }
    return basicAuth(`${tokens.email}/token`, tokens.token);
}

function mapStatusBucket(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'solved') return 'resolved';
    if (s === 'closed') return 'closed';
    if (s === 'pending' || s === 'hold') return 'pending';
    return 'open'; // new, open
}

function mapPriority(p) {
    const s = String(p || '').toLowerCase();
    if (s === 'urgent') return 'urgent';
    if (s === 'high') return 'high';
    if (s === 'normal') return 'medium';
    return 'low';
}

async function completeAuth({ subdomain, email, apiToken, brandIds = [] }) {
    if (!subdomain || !email || !apiToken) {
        throw new Error('Missing required field: subdomain, email, or apiToken');
    }
    const base = baseUrl(subdomain);
    const me = await httpJson(`${base}/api/v2/users/me.json`, {
        headers: { Authorization: basicAuth(`${email}/token`, apiToken) },
    });
    return {
        tokens: { kind: 'api_token', email, token: apiToken },
        accountIdentifier: email,
        displayName: me?.user?.name || email,
        providerConfig: {
            subdomain: subdomain.replace(/\.zendesk\.com.*$/, ''),
            brandIds: Array.isArray(brandIds) ? brandIds : [],
        },
    };
}

async function* listTickets(connection, { since, max = 500 } = {}) {
    const tokens = connection.tokens;
    const cfg = connection.provider_config || {};
    const base = baseUrl(cfg.subdomain);
    const pc = connection.provider_cursor || {};

    let url;
    if (pc.afterCursor) {
        url = `${base}/api/v2/incremental/tickets/cursor.json?cursor=${encodeURIComponent(pc.afterCursor)}`;
    } else {
        const startTime = pc.startTime || Math.floor(new Date(since || Date.now() - 30 * 24 * 60 * 60 * 1000).getTime() / 1000);
        url = `${base}/api/v2/incremental/tickets/cursor.json?start_time=${startTime}`;
    }

    let emitted = 0;
    while (url && emitted < max) {
        const data = await httpJson(url, { headers: { Authorization: authHeader(tokens) } });
        const tickets = data.tickets || [];
        if (cfg.brandIds?.length) {
            for (const t of tickets) {
                if (cfg.brandIds.includes(t.brand_id)) {
                    yield t;
                    emitted += 1;
                    if (emitted >= max) return;
                }
            }
        } else {
            for (const t of tickets) {
                yield t;
                emitted += 1;
                if (emitted >= max) return;
            }
        }
        if (data.end_of_stream) return;
        url = data.after_url || null;
    }
}

async function fetchComments(connection, ticketId) {
    const tokens = connection.tokens;
    const base = baseUrl(connection.provider_config?.subdomain);
    const out = [];
    let url = `${base}/api/v2/tickets/${ticketId}/comments.json?include=users&sort_order=asc`;
    while (url) {
        const data = await httpJson(url, { headers: { Authorization: authHeader(tokens) } });
        for (const c of data.comments || []) {
            out.push({
                author_role: c.public === false ? 'agent' : (c.author_id ? 'agent' : 'requester'),
                at: c.created_at,
                body_markdown: c.plain_body || stripHtml(c.html_body || c.body || ''),
            });
        }
        url = data.next_page || null;
    }
    return out;
}

function stripHtml(s) {
    return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

async function fetchAttachments(_connection, _ticketId) {
    // Zendesk attachments are embedded in comment payloads. Callers that need
    // attachments should extract from fetchComments's source data; the sync
    // engine's normalise step wraps them via raw_meta.
    return [];
}

function normalize(raw, comments, _attachments) {
    const bucket = mapStatusBucket(raw.status);
    const subdomain = (raw.url || '').match(/https?:\/\/([^.]+)\.zendesk\.com/)?.[1];
    const browseUrl = subdomain ? `https://${subdomain}.zendesk.com/agent/tickets/${raw.id}` : `zendesk://ticket/${raw.id}`;

    let resolution;
    if (bucket === 'resolved' || bucket === 'closed') {
        const lastAgent = [...(comments || [])].reverse().find(c => c.author_role === 'agent' && c.body_markdown);
        if (lastAgent) {
            resolution = {
                body_markdown: lastAgent.body_markdown,
                resolved_at: raw.updated_at,
                by_role: 'agent',
            };
        }
    }

    return {
        source_system: ID,
        source_id: String(raw.id),
        source_uri: browseUrl,
        itil_type: 'incident', // Zendesk is primarily CX / incident-flavoured; refine via tags if needed
        subject: raw.subject || `Ticket #${raw.id}`,
        body_markdown: stripHtml(raw.description || ''),
        comments: comments || [],
        resolution,
        priority: mapPriority(raw.priority),
        status: raw.status,
        status_bucket: bucket,
        category: raw.type || undefined,
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        attachments: [],
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        resolved_at: bucket === 'resolved' || bucket === 'closed' ? raw.updated_at : undefined,
        raw_meta: {
            brand_id: raw.brand_id,
            type: raw.type,
            requester_id: raw.requester_id,
            assignee_id: raw.assignee_id,
        },
    };
}

async function ensureFreshTokens(_c) { return { ok: true }; }

function describeCursor(connection) {
    const pc = connection.provider_cursor || {};
    if (pc.afterCursor) return `cursor ${pc.afterCursor.slice(0, 16)}…`;
    if (pc.startTime) return `start_time ${new Date(pc.startTime * 1000).toISOString()}`;
    return 'never synced';
}

module.exports = {
    id: ID,
    defaultAuthMethod: 'api_token',
    completeAuth,
    ensureFreshTokens,
    listTickets,
    fetchComments,
    fetchAttachments,
    normalize,
    describeCursor,
};
