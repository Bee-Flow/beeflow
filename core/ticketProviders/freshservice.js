/**
 * Freshservice — TicketSourceProvider
 *
 * v1 auth: API key via Basic Auth (apikey:X).
 *
 * Endpoints used:
 *   GET /api/v2/agents/me                                — credential validation
 *   GET /api/v2/tickets?updated_since=...&page=N         — list (newest first, 60/min limit on trial)
 *   GET /api/v2/tickets/{id}/conversations               — ticket comments / replies
 *
 * providerConfig:
 *   { domain: 'acme.freshservice.com' }
 *
 * Cursor:
 *   { updatedSince: '2026-04-18T10:00:00Z' }
 *
 * Native ITIL type lives in ticket.type (string) — preserved verbatim into category.
 * type field is mapped to itil_type via a small lookup.
 */

const { httpJson, basicAuth } = require('./_http');

const ID = 'freshservice';

function trimSlash(u) { return u.replace(/\/+$/, ''); }

function baseUrl(cfg) {
    const d = cfg.domain || '';
    if (/^https?:\/\//.test(d)) return trimSlash(d);
    return `https://${trimSlash(d)}`;
}

function authHeader(tokens) {
    return basicAuth(tokens.key, 'X');
}

function mapItilType(typeStr) {
    const t = String(typeStr || '').toLowerCase();
    if (t.includes('incident')) return 'incident';
    if (t.includes('problem')) return 'problem';
    if (t.includes('change')) return 'change';
    if (t.includes('service request') || t.includes('request')) return 'service_request';
    return 'incident';
}

function mapStatusBucket(statusInt) {
    // Freshservice default: 2=Open, 3=Pending, 4=Resolved, 5=Closed, 6=Waiting on Customer, 7=Waiting on Third Party
    if (statusInt === 4) return 'resolved';
    if (statusInt === 5) return 'closed';
    if ([3, 6, 7].includes(statusInt)) return 'pending';
    return 'open';
}

function mapPriority(priorityInt) {
    // 1=Low, 2=Medium, 3=High, 4=Urgent
    if (priorityInt === 4) return 'urgent';
    if (priorityInt === 3) return 'high';
    if (priorityInt === 2) return 'medium';
    return 'low';
}

async function completeAuth({ domain, apiKey }) {
    if (!domain || !apiKey) throw new Error('Missing required field: domain or apiKey');
    const base = baseUrl({ domain });
    const me = await httpJson(`${base}/api/v2/agents/me`, {
        headers: { Authorization: basicAuth(apiKey, 'X') },
    });
    const agent = me.agent || me;
    return {
        tokens: { kind: 'api_key', key: apiKey },
        accountIdentifier: agent.email || domain,
        displayName: [agent.first_name, agent.last_name].filter(Boolean).join(' ') || agent.email || domain,
        providerConfig: { domain: trimSlash(domain) },
    };
}

async function* listTickets(connection, { since, max = 500 } = {}) {
    const tokens = connection.tokens;
    const cfg = connection.provider_config || {};
    const base = baseUrl(cfg);
    const pc = connection.provider_cursor || {};
    const updatedSince = pc.updatedSince || since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    let page = 1;
    let emitted = 0;

    while (emitted < max) {
        const params = new URLSearchParams({
            updated_since: updatedSince,
            order_by: 'updated_at',
            order_type: 'asc',
            per_page: '100',
            page: String(page),
            include: 'description',
        });
        const url = `${base}/api/v2/tickets?${params.toString()}`;
        const data = await httpJson(url, { headers: { Authorization: authHeader(tokens) } });
        const tickets = data.tickets || [];
        if (!tickets.length) return;
        for (const t of tickets) {
            yield t;
            emitted += 1;
            if (emitted >= max) return;
        }
        if (tickets.length < 100) return;
        page += 1;
        if (page > 100) return; // hard safety cap
    }
}

async function fetchComments(connection, ticketId) {
    const tokens = connection.tokens;
    const base = baseUrl(connection.provider_config || {});
    const data = await httpJson(`${base}/api/v2/tickets/${ticketId}/conversations?per_page=100`, {
        headers: { Authorization: authHeader(tokens) },
    });
    const items = data.conversations || [];
    return items.map(c => ({
        author_role: c.incoming === true ? 'requester' : 'agent',
        at: c.created_at,
        body_markdown: stripHtml(c.body_text || c.body || ''),
    }));
}

function stripHtml(s) {
    return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

async function fetchAttachments(connection, ticketId) {
    // Freshservice embeds attachments in ticket + conversation payloads; this
    // method is rarely called standalone. Return empty — the sync engine will
    // rely on raw_meta.attachments from listTickets/fetchComments if needed.
    return [];
}

function wrapAttachment(att, tokens) {
    return {
        filename: att.name || 'attachment',
        mime: att.content_type || 'application/octet-stream',
        size: att.size || 0,
        fetchBlob: async () => {
            const res = await fetch(att.attachment_url, {
                headers: { Authorization: authHeader(tokens) },
            });
            if (!res.ok) throw new Error(`Freshservice attachment download failed: HTTP ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
        },
    };
}

function normalize(raw, comments, _attachments) {
    const cfg = {}; // not needed here
    const bucket = mapStatusBucket(raw.status);
    const host = raw.attachments?.[0]?.attachment_url?.split('/')[2] || null;
    const browseUrl = host ? `https://${host}/helpdesk/tickets/${raw.id}` : `/tickets/${raw.id}`;

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
        itil_type: mapItilType(raw.type),
        subject: raw.subject || `Ticket #${raw.id}`,
        body_markdown: stripHtml(raw.description_text || raw.description || ''),
        comments: comments || [],
        resolution,
        priority: mapPriority(raw.priority),
        status: String(raw.status),
        status_bucket: bucket,
        category: raw.category || raw.type || undefined,
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        attachments: (raw.attachments || []).map(a => wrapAttachment(a, { key: '' })).filter(Boolean),
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        resolved_at: raw.closed_at || undefined,
        raw_meta: {
            type: raw.type,
            requester_id: raw.requester_id,
            responder_id: raw.responder_id,
            group_id: raw.group_id,
        },
    };
}

async function ensureFreshTokens(_c) { return { ok: true }; }

function describeCursor(connection) {
    const pc = connection.provider_cursor || {};
    return pc.updatedSince ? `updated_since ${pc.updatedSince}` : 'never synced';
}

module.exports = {
    id: ID,
    defaultAuthMethod: 'api_key',
    completeAuth,
    ensureFreshTokens,
    listTickets,
    fetchComments,
    fetchAttachments,
    normalize,
    describeCursor,
};
