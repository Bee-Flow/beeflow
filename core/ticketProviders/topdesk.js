/**
 * TopDesk — TicketSourceProvider
 *
 * v1 auth: operator login + application password via Basic Auth.
 *          (NB: The TopDesk admin must have enabled "REST API" and created an
 *          Application Password for the operator; using the operator's main
 *          password does NOT work.)
 *
 * Endpoints used:
 *   GET /tas/api/version                                  — credential validation
 *   GET /tas/api/incidents?modification_date_start=...    — incremental list
 *   GET /tas/api/incidents/id/{id}/actions                — comments / operator actions
 *   GET /tas/api/incidents/id/{id}/attachments            — attachments list
 *   GET /tas/api/attachments/id/{attId}/download          — attachment bytes
 *
 * providerConfig:
 *   {
 *     baseUrl: 'https://acme.topdesk.net',
 *     operatorGroupIds?: string[],
 *     branchIds?: string[],
 *     callTypeMap?: { [callTypeName]: 'incident'|'problem'|'change'|'service_request' },
 *   }
 *
 * Cursor:
 *   { modificationDateStart: '2026-04-18T10:00:00Z' }
 */

const { httpJson, basicAuth } = require('./_http');

const ID = 'topdesk';

function trimSlash(u) { return u.replace(/\/+$/, ''); }

function authHeader(tokens) {
    return basicAuth(tokens.username, tokens.password);
}

const DEFAULT_CALLTYPE_MAP = {
    incident: 'incident',
    'service request': 'service_request',
    rfc: 'change',
    change: 'change',
    'problem management': 'problem',
    problem: 'problem',
};

function mapItilType(callTypeName, customMap) {
    const key = String(callTypeName || '').trim().toLowerCase();
    const map = { ...DEFAULT_CALLTYPE_MAP, ...(customMap || {}) };
    return map[key] || 'incident';
}

function mapStatusBucket(processingStatusName) {
    const s = String(processingStatusName || '').toLowerCase();
    if (s.includes('closed') || s.includes('afgesloten')) return 'closed';
    if (s.includes('resolved') || s.includes('opgelost') || s.includes('closed')) return 'resolved';
    if (s.includes('wait') || s.includes('wachten')) return 'pending';
    return 'open';
}

function mapPriority(p) {
    const name = String(p?.name || p || '').toLowerCase();
    if (['p1', 'urgent'].some(x => name.includes(x))) return 'urgent';
    if (['p2', 'high', 'hoog'].some(x => name.includes(x))) return 'high';
    if (['p3', 'medium', 'normaal'].some(x => name.includes(x))) return 'medium';
    return 'low';
}

async function completeAuth({ baseUrl, username, password, operatorGroupIds = [], branchIds = [], callTypeMap = {} }) {
    if (!baseUrl || !username || !password) {
        throw new Error('Missing required field: baseUrl, username, or password');
    }
    const base = trimSlash(baseUrl);
    // /tas/api/version is a lightweight, unauthenticated-friendly endpoint —
    // but hitting /tas/api/operators/current with Basic Auth validates creds.
    await httpJson(`${base}/tas/api/operators/current`, {
        headers: { Authorization: basicAuth(username, password) },
    });
    return {
        tokens: { kind: 'basic', username, password },
        accountIdentifier: username,
        displayName: username,
        providerConfig: {
            baseUrl: base,
            operatorGroupIds: Array.isArray(operatorGroupIds) ? operatorGroupIds.filter(Boolean) : [],
            branchIds: Array.isArray(branchIds) ? branchIds.filter(Boolean) : [],
            callTypeMap: callTypeMap || {},
        },
    };
}

async function* listTickets(connection, { since, max = 500 } = {}) {
    const tokens = connection.tokens;
    const cfg = connection.provider_config || {};
    const base = trimSlash(cfg.baseUrl || '');
    const pc = connection.provider_cursor || {};
    const modStart = pc.modificationDateStart || since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const fields = [
        'id', 'number', 'briefDescription', 'request', 'action', 'category', 'subcategory',
        'callType', 'priority', 'status', 'processingStatus', 'caller', 'operator',
        'creationDate', 'modificationDate', 'closedDate',
    ].join(',');

    let start = 0;
    const pageSize = 100;
    let emitted = 0;

    while (emitted < max) {
        const params = new URLSearchParams({
            modification_date_start: modStart,
            fields,
            page_size: String(pageSize),
            start: String(start),
        });
        if (cfg.operatorGroupIds?.length) params.set('operator_group', cfg.operatorGroupIds.join(','));
        if (cfg.branchIds?.length) params.set('branch', cfg.branchIds.join(','));

        const url = `${base}/tas/api/incidents?${params.toString()}`;
        const data = await httpJson(url, { headers: { Authorization: authHeader(tokens) } });
        const items = Array.isArray(data) ? data : [];
        if (!items.length) return;
        for (const inc of items) {
            yield inc;
            emitted += 1;
            if (emitted >= max) return;
        }
        if (items.length < pageSize) return;
        start += pageSize;
        if (start > 20_000) return; // hard safety cap
    }
}

async function fetchComments(connection, incidentId) {
    const tokens = connection.tokens;
    const base = trimSlash(connection.provider_config?.baseUrl || '');
    const data = await httpJson(`${base}/tas/api/incidents/id/${encodeURIComponent(incidentId)}/actions`, {
        headers: { Authorization: authHeader(tokens) },
    });
    const items = Array.isArray(data) ? data : [];
    return items.map(a => ({
        author_role: a.operator ? 'agent' : 'requester',
        at: a.entryDate || a.creationDate,
        body_markdown: stripHtml(a.memoText || a.plainText || ''),
    }));
}

function stripHtml(s) {
    return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

async function fetchAttachments(connection, incidentId) {
    const tokens = connection.tokens;
    const base = trimSlash(connection.provider_config?.baseUrl || '');
    const data = await httpJson(`${base}/tas/api/incidents/id/${encodeURIComponent(incidentId)}/attachments`, {
        headers: { Authorization: authHeader(tokens) },
    });
    const items = Array.isArray(data) ? data : [];
    return items.map(att => ({
        filename: att.fileName || att.name || 'attachment',
        mime: att.mimeType || 'application/octet-stream',
        size: att.size || 0,
        fetchBlob: async () => {
            const res = await fetch(`${base}/tas/api/attachments/id/${att.id}/download`, {
                headers: { Authorization: authHeader(tokens) },
            });
            if (!res.ok) throw new Error(`TopDesk attachment download failed: HTTP ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
        },
    }));
}

function normalize(raw, comments, attachments) {
    const cfg = this && this.__cfg ? this.__cfg : {}; // normalize is usually called with no context
    const status = raw.processingStatus?.name || raw.status || 'Unknown';
    const bucket = mapStatusBucket(status);
    const callTypeMap = cfg.callTypeMap || {};

    let resolution;
    if (bucket === 'resolved' || bucket === 'closed') {
        const lastAgent = [...(comments || [])].reverse().find(c => c.author_role === 'agent' && c.body_markdown);
        if (lastAgent) {
            resolution = {
                body_markdown: lastAgent.body_markdown,
                resolved_at: raw.closedDate || raw.modificationDate,
                by_role: 'agent',
            };
        }
    }

    return {
        source_system: ID,
        source_id: String(raw.id || raw.number),
        source_uri: raw.number ? `topdesk://incident/${raw.number}` : `topdesk://incident/${raw.id}`,
        itil_type: mapItilType(raw.callType?.name, callTypeMap),
        subject: raw.briefDescription || raw.number || 'Incident',
        body_markdown: stripHtml(raw.request || ''),
        comments: comments || [],
        resolution,
        priority: mapPriority(raw.priority),
        status,
        status_bucket: bucket,
        category: raw.category?.name,
        tags: [raw.subcategory?.name].filter(Boolean),
        attachments: attachments || [],
        created_at: raw.creationDate,
        updated_at: raw.modificationDate,
        resolved_at: raw.closedDate || undefined,
        raw_meta: {
            number: raw.number,
            callType: raw.callType?.name,
            caller: raw.caller?.dynamicName,
            operator: raw.operator?.name,
        },
    };
}

async function ensureFreshTokens(_c) { return { ok: true }; }

function describeCursor(connection) {
    const pc = connection.provider_cursor || {};
    return pc.modificationDateStart ? `modified ≥ ${pc.modificationDateStart}` : 'never synced';
}

module.exports = {
    id: ID,
    defaultAuthMethod: 'basic',
    completeAuth,
    ensureFreshTokens,
    listTickets,
    fetchComments,
    fetchAttachments,
    normalize,
    describeCursor,
};
