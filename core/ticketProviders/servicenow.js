/**
 * ServiceNow — TicketSourceProvider
 *
 * v1 auth: username + password via Basic Auth. OAuth 2.0 in v2.
 *          Developer Instance at developer.servicenow.com uses Basic out-of-box.
 *
 * Endpoints used:
 *   GET /api/now/ui/user/current_user                               — credential validation
 *   GET /api/now/table/{table}?sysparm_query=sys_updated_on>=...    — list per ITIL table
 *   GET /api/now/table/sys_journal_field?sysparm_query=...          — comments + work notes
 *   GET /api/now/attachment?sysparm_query=...                       — attachment list
 *   GET /api/now/attachment/{id}/file                               — attachment bytes
 *
 * providerConfig:
 *   {
 *     instance: 'dev12345',  // or full URL
 *     tables: ['incident','problem','change_request','sc_request'],
 *     stateBuckets?: { [table]: { [stateInt]: 'open'|'pending'|'resolved'|'closed' } },
 *   }
 *
 * Cursor:
 *   { sysUpdatedOn: '2026-04-18 10:00:00', cursorTable: 'incident' }
 */

const { httpJson, basicAuth } = require('./_http');

const ID = 'servicenow';

const DEFAULT_TABLES = ['incident', 'problem', 'change_request', 'sc_request'];

function baseUrl(cfg) {
    const i = cfg.instance || '';
    if (/^https?:\/\//.test(i)) return i.replace(/\/+$/, '');
    return `https://${i}.service-now.com`;
}

function authHeader(tokens) {
    return basicAuth(tokens.username, tokens.password);
}

const DEFAULT_STATE_BUCKETS = {
    incident: { 1: 'open', 2: 'open', 3: 'pending', 6: 'resolved', 7: 'closed', 8: 'closed' },
    problem: { 1: 'open', 2: 'open', 3: 'pending', 4: 'resolved', 5: 'closed' },
    change_request: { '-5': 'open', '-4': 'open', '-3': 'pending', '-2': 'pending', '-1': 'pending', 0: 'open', 3: 'resolved', 4: 'closed' },
    sc_request: { 1: 'open', 2: 'pending', 3: 'resolved', 4: 'closed' },
};

function resolveBucket(table, stateInt, customMap) {
    const map = {
        ...(DEFAULT_STATE_BUCKETS[table] || {}),
        ...((customMap && customMap[table]) || {}),
    };
    return map[String(stateInt)] || map[stateInt] || 'open';
}

function mapItilType(table) {
    if (table === 'incident') return 'incident';
    if (table === 'problem') return 'problem';
    if (table === 'change_request') return 'change';
    if (table === 'sc_request') return 'service_request';
    return 'incident';
}

function mapPriority(priorityInt) {
    // SNow: 1=critical, 2=high, 3=moderate, 4=low, 5=planning
    if (priorityInt === 1) return 'urgent';
    if (priorityInt === 2) return 'high';
    if (priorityInt === 3) return 'medium';
    return 'low';
}

async function completeAuth({ instance, username, password, tables = DEFAULT_TABLES, stateBuckets = {} }) {
    if (!instance || !username || !password) {
        throw new Error('Missing required field: instance, username, or password');
    }
    const base = baseUrl({ instance });
    // /api/now/table/sys_user?sysparm_limit=1 works as a validation ping;
    // /api/now/ui/user/current_user isn't universal.
    await httpJson(`${base}/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=user_name`, {
        headers: { Authorization: basicAuth(username, password) },
    });
    return {
        tokens: { kind: 'basic', username, password },
        accountIdentifier: username,
        displayName: username,
        providerConfig: {
            instance: instance.replace(/^https?:\/\//, '').replace(/\.service-now\.com.*$/, ''),
            tables: tables.filter(t => DEFAULT_TABLES.includes(t)),
            stateBuckets: stateBuckets || {},
        },
    };
}

function iso(t) {
    // Convert "2026-04-18 10:00:00" (SNow) ↔ ISO-8601.
    if (!t) return null;
    if (t.includes('T')) return t;
    return t.replace(' ', 'T') + 'Z';
}

function snowFormat(isoTs) {
    return isoTs.replace('T', ' ').replace(/\..*$/, '').replace('Z', '');
}

async function* listTickets(connection, { since, max = 500 } = {}) {
    const tokens = connection.tokens;
    const cfg = connection.provider_config || {};
    const base = baseUrl(cfg);
    const pc = connection.provider_cursor || {};
    const tables = Array.isArray(cfg.tables) && cfg.tables.length ? cfg.tables : DEFAULT_TABLES;

    const sysUpdatedOn = pc.sysUpdatedOn || snowFormat(since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

    const fields = [
        'sys_id', 'number', 'short_description', 'description', 'priority', 'state',
        'category', 'subcategory', 'sys_created_on', 'sys_updated_on', 'resolved_at',
        'close_notes', 'close_code', 'opened_by', 'assigned_to',
    ].join(',');

    let emitted = 0;

    for (const table of tables) {
        if (emitted >= max) return;
        let offset = 0;
        const pageSize = 100;
        while (emitted < max) {
            const params = new URLSearchParams({
                sysparm_query: `sys_updated_on>=${sysUpdatedOn}^ORDERBYsys_updated_on`,
                sysparm_limit: String(pageSize),
                sysparm_offset: String(offset),
                sysparm_fields: fields,
                sysparm_display_value: 'all',
            });
            const url = `${base}/api/now/table/${table}?${params.toString()}`;
            const data = await httpJson(url, { headers: { Authorization: authHeader(tokens) } });
            const items = Array.isArray(data?.result) ? data.result : [];
            if (!items.length) break;
            for (const item of items) {
                item.__table = table;
                yield item;
                emitted += 1;
                if (emitted >= max) return;
            }
            if (items.length < pageSize) break;
            offset += pageSize;
            if (offset > 20_000) break;
        }
    }
}

function extractVal(field) {
    // SNow returns fields as { display_value, value } with sysparm_display_value=all.
    if (field == null) return null;
    if (typeof field === 'string' || typeof field === 'number') return field;
    if (typeof field === 'object') return field.display_value ?? field.value ?? null;
    return null;
}

async function fetchComments(connection, sysId) {
    const tokens = connection.tokens;
    const base = baseUrl(connection.provider_config || {});
    const params = new URLSearchParams({
        sysparm_query: `element_id=${sysId}^elementINcomments,work_notes^ORDERBYsys_created_on`,
        sysparm_fields: 'sys_created_on,value,element,sys_created_by',
        sysparm_limit: '200',
    });
    const url = `${base}/api/now/table/sys_journal_field?${params.toString()}`;
    const data = await httpJson(url, { headers: { Authorization: authHeader(tokens) } });
    const items = Array.isArray(data?.result) ? data.result : [];
    return items.map(j => ({
        author_role: 'agent',
        at: iso(extractVal(j.sys_created_on)),
        body_markdown: stripHtml(extractVal(j.value) || ''),
    }));
}

function stripHtml(s) {
    return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

async function fetchAttachments(connection, sysId) {
    const tokens = connection.tokens;
    const base = baseUrl(connection.provider_config || {});
    const params = new URLSearchParams({
        sysparm_query: `table_sys_id=${sysId}`,
        sysparm_limit: '50',
    });
    const url = `${base}/api/now/attachment?${params.toString()}`;
    const data = await httpJson(url, { headers: { Authorization: authHeader(tokens) } });
    const items = Array.isArray(data?.result) ? data.result : [];
    return items.map(a => ({
        filename: a.file_name || 'attachment',
        mime: a.content_type || 'application/octet-stream',
        size: parseInt(a.size_bytes, 10) || 0,
        fetchBlob: async () => {
            const res = await fetch(`${base}/api/now/attachment/${a.sys_id}/file`, {
                headers: { Authorization: authHeader(tokens) },
            });
            if (!res.ok) throw new Error(`ServiceNow attachment download failed: HTTP ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
        },
    }));
}

function normalize(raw, comments, attachments) {
    const table = raw.__table || 'incident';
    const stateInt = extractVal(raw.state);
    const bucket = resolveBucket(table, stateInt);
    const sysId = extractVal(raw.sys_id);
    const number = extractVal(raw.number);
    const instanceHost = (raw.sys_domain_path || '').match(/\/([^.]+\.service-now\.com)/)?.[1]
        || (raw.link || '').match(/https?:\/\/([^/]+)/)?.[1]
        || null;
    const browseUrl = instanceHost
        ? `https://${instanceHost}/nav_to.do?uri=${table}.do?sys_id=${sysId}`
        : `servicenow://${table}/${sysId}`;

    const closeNotes = extractVal(raw.close_notes);
    let resolution;
    if (closeNotes && (bucket === 'resolved' || bucket === 'closed')) {
        resolution = {
            body_markdown: stripHtml(closeNotes),
            resolved_at: iso(extractVal(raw.resolved_at)) || iso(extractVal(raw.sys_updated_on)),
            by_role: 'agent',
        };
    } else if (bucket === 'resolved' || bucket === 'closed') {
        const lastAgent = [...(comments || [])].reverse().find(c => c.body_markdown);
        if (lastAgent) {
            resolution = {
                body_markdown: lastAgent.body_markdown,
                resolved_at: iso(extractVal(raw.resolved_at)) || iso(extractVal(raw.sys_updated_on)),
                by_role: 'agent',
            };
        }
    }

    return {
        source_system: ID,
        source_id: number || sysId,
        source_uri: browseUrl,
        itil_type: mapItilType(table),
        subject: extractVal(raw.short_description) || number || 'ServiceNow record',
        body_markdown: stripHtml(extractVal(raw.description) || ''),
        comments: comments || [],
        resolution,
        priority: mapPriority(parseInt(extractVal(raw.priority), 10)),
        status: String(stateInt || 'unknown'),
        status_bucket: bucket,
        category: extractVal(raw.category) || undefined,
        tags: [extractVal(raw.subcategory)].filter(Boolean),
        attachments: attachments || [],
        created_at: iso(extractVal(raw.sys_created_on)),
        updated_at: iso(extractVal(raw.sys_updated_on)),
        resolved_at: iso(extractVal(raw.resolved_at)) || undefined,
        raw_meta: {
            table,
            number,
            assigned_to: extractVal(raw.assigned_to),
            opened_by: extractVal(raw.opened_by),
            close_code: extractVal(raw.close_code),
        },
    };
}

async function ensureFreshTokens(_c) { return { ok: true }; }

function describeCursor(connection) {
    const pc = connection.provider_cursor || {};
    return pc.sysUpdatedOn ? `sys_updated_on ≥ ${pc.sysUpdatedOn}` : 'never synced';
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
