/**
 * Jira Service Management — TicketSourceProvider
 *
 * v1 auth: email + API token via Basic Auth (Atlassian Cloud).
 *          Zero OAuth-app registration needed. OAuth 3LO can be added in v2.
 *
 * Endpoints used:
 *   GET /rest/api/3/myself                       — credential validation
 *   GET /rest/api/3/search/jql                   — new keyset-paginated search
 *   GET /rest/api/3/issue/{id}/comment           — fallback when search comment list is truncated
 *   GET /rest/api/3/issue/{id}/attachments       — (usually embedded in search payload)
 *   GET {attachment.content}                     — download bytes (same Basic Auth)
 *
 * providerConfig shape:
 *   {
 *     siteUrl: 'https://acme.atlassian.net',
 *     projectKeys: ['PROJ','HELP'],
 *     jql?: 'status = Done AND resolution != Unresolved',
 *     includeDone?: boolean,
 *   }
 *
 * Cursor (stored in connection.provider_cursor):
 *   { updatedFrom: '2026-04-18T10:00:00.000Z' }
 */

const { httpJson, basicAuth } = require('./_http');
const { adfToMarkdown } = require('./_adfToMarkdown');

const ID = 'jira';

function authHeader(tokens) {
    // tokens: { kind:'api_token', email, token }
    return basicAuth(tokens.email, tokens.token);
}

function trimSlash(u) { return u.replace(/\/+$/, ''); }

function normalizeStatusBucket(statusCategoryKey) {
    // Jira's statusCategory.key is one of: new, indeterminate, done
    if (statusCategoryKey === 'done') return 'resolved';
    if (statusCategoryKey === 'indeterminate') return 'pending';
    return 'open';
}

function mapItilType(issuetypeName) {
    const name = String(issuetypeName || '').toLowerCase();
    if (name.includes('incident')) return 'incident';
    if (name.includes('problem')) return 'problem';
    if (name.includes('change')) return 'change';
    if (name.includes('service request') || name === 'task' || name.includes('request')) return 'service_request';
    return 'incident';
}

function mapPriority(priorityName) {
    const name = String(priorityName || '').toLowerCase();
    if (['highest', 'urgent', 'blocker'].includes(name)) return 'urgent';
    if (name === 'high' || name === 'critical' || name === 'major') return 'high';
    if (name === 'medium') return 'medium';
    return 'low';
}

// ──────────────────────────────────────────────────────────────
// completeAuth — validate credentials + pull identity info
// ──────────────────────────────────────────────────────────────
async function completeAuth({ email, token, siteUrl, projectKeys = [], jql = '', includeDone = true }) {
    if (!email || !token || !siteUrl) {
        throw new Error('Missing required field: email, token, or siteUrl');
    }
    const base = trimSlash(siteUrl);
    const me = await httpJson(`${base}/rest/api/3/myself`, {
        headers: { Authorization: basicAuth(email, token) },
    });
    return {
        tokens: { kind: 'api_token', email, token },
        accountIdentifier: email,
        displayName: me.displayName || email,
        providerConfig: {
            siteUrl: base,
            projectKeys: Array.isArray(projectKeys) ? projectKeys.filter(Boolean) : [],
            jql: String(jql || ''),
            includeDone: includeDone !== false,
        },
    };
}

// ──────────────────────────────────────────────────────────────
// listTickets — async iterator over updated issues
// ──────────────────────────────────────────────────────────────
async function* listTickets(connection, { since, cursor, max = 500 } = {}) {
    const tokens = connection.tokens;
    const pc = connection.provider_cursor || {};
    const cfg = connection.provider_config || {};
    const base = trimSlash(cfg.siteUrl || '');
    if (!base) throw new Error('Jira connection missing siteUrl in provider_config');

    const updatedFrom = pc.updatedFrom || since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Build JQL. Jira wants quoted timestamps in the format 'YYYY-MM-DD HH:mm'.
    const jqlParts = [];
    if (Array.isArray(cfg.projectKeys) && cfg.projectKeys.length) {
        jqlParts.push(`project in (${cfg.projectKeys.map(k => `"${k}"`).join(',')})`);
    }
    if (cfg.jql) jqlParts.push(`(${cfg.jql})`);
    const jqlDate = updatedFrom.replace('T', ' ').slice(0, 16);
    jqlParts.push(`updated >= "${jqlDate}"`);
    jqlParts.push('ORDER BY updated ASC');
    const jql = jqlParts.join(' AND ').replace(' AND ORDER BY', ' ORDER BY');

    const fields = [
        'summary', 'description', 'comment', 'attachment', 'status', 'priority',
        'issuetype', 'labels', 'resolution', 'resolutiondate', 'project', 'created', 'updated',
        'assignee', 'reporter',
    ].join(',');

    let pageToken = cursor || undefined;
    let emitted = 0;

    while (emitted < max) {
        const params = new URLSearchParams({
            jql,
            fields,
            maxResults: String(Math.min(50, max - emitted)),
        });
        if (pageToken) params.set('nextPageToken', pageToken);

        const url = `${base}/rest/api/3/search/jql?${params.toString()}`;
        const page = await httpJson(url, {
            headers: { Authorization: authHeader(tokens) },
        });

        const issues = Array.isArray(page.issues) ? page.issues : [];
        if (issues.length === 0) return;

        for (const issue of issues) {
            yield issue;
            emitted += 1;
            if (emitted >= max) return;
        }

        pageToken = page.nextPageToken || null;
        if (!pageToken) return;
    }
}

// ──────────────────────────────────────────────────────────────
// fetchComments — preferred path is search-embedded comment list;
// this function is the fallback when truncated or when called directly.
// ──────────────────────────────────────────────────────────────
async function fetchComments(connection, issueIdOrKey) {
    const tokens = connection.tokens;
    const base = trimSlash(connection.provider_config?.siteUrl || '');
    const url = `${base}/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/comment?maxResults=200&orderBy=created`;
    const data = await httpJson(url, {
        headers: { Authorization: authHeader(tokens) },
    });
    return (data.comments || []).map(c => formatComment(c));
}

function formatComment(c) {
    return {
        author_role: 'agent', // Jira doesn't reliably distinguish; treat as agent
        at: c.created,
        body_markdown: adfToMarkdown(c.body) || '',
    };
}

// ──────────────────────────────────────────────────────────────
// fetchAttachments — wraps provider attachments in fetchBlob closures
// ──────────────────────────────────────────────────────────────
function toAttachment(att, tokens) {
    return {
        filename: att.filename || 'attachment',
        mime: att.mimeType || 'application/octet-stream',
        size: att.size || 0,
        fetchBlob: async () => {
            const res = await fetch(att.content, {
                headers: { Authorization: authHeader(tokens) },
            });
            if (!res.ok) throw new Error(`Attachment download failed: HTTP ${res.status}`);
            const buf = await res.arrayBuffer();
            return Buffer.from(buf);
        },
    };
}

async function fetchAttachments(connection, issueIdOrKey) {
    const tokens = connection.tokens;
    const base = trimSlash(connection.provider_config?.siteUrl || '');
    const url = `${base}/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}?fields=attachment`;
    const data = await httpJson(url, {
        headers: { Authorization: authHeader(tokens) },
    });
    const items = data?.fields?.attachment || [];
    return items.map(att => toAttachment(att, tokens));
}

// ──────────────────────────────────────────────────────────────
// normalize — raw Jira issue → canonical NormalizedTicket
// ──────────────────────────────────────────────────────────────
function normalize(issue, comments, attachments) {
    const f = issue.fields || {};
    const base = issue.self ? issue.self.split('/rest/')[0] : '';
    const browseUrl = base ? `${base}/browse/${issue.key}` : issue.key;

    const embeddedComments = (f.comment?.comments || []).map(formatComment);
    const finalComments = (Array.isArray(comments) && comments.length) ? comments : embeddedComments;

    const status = f.status?.name || 'Unknown';
    const bucket = normalizeStatusBucket(f.status?.statusCategory?.key);

    const descMd = adfToMarkdown(f.description);

    // If resolved, look for the most recent status-change-to-resolved comment as resolution.
    // Cheap heuristic: last comment authored after resolutiondate OR last comment if resolved.
    let resolution;
    if (bucket === 'resolved' && f.resolutiondate) {
        const lastAgentComment = [...finalComments].reverse().find(c => c.body_markdown);
        if (lastAgentComment) {
            resolution = {
                body_markdown: lastAgentComment.body_markdown,
                resolved_at: f.resolutiondate,
                by_role: 'agent',
            };
        } else {
            resolution = {
                body_markdown: `Issue resolved. Resolution: ${f.resolution?.name || 'Done'}.`,
                resolved_at: f.resolutiondate,
                by_role: 'agent',
            };
        }
    }

    return {
        source_system: ID,
        source_id: issue.key,
        source_uri: browseUrl,
        project_key: f.project?.key,
        itil_type: mapItilType(f.issuetype?.name),
        subject: f.summary || issue.key,
        body_markdown: descMd,
        comments: finalComments,
        resolution,
        priority: mapPriority(f.priority?.name),
        status,
        status_bucket: bucket,
        category: f.issuetype?.name,
        tags: Array.isArray(f.labels) ? f.labels : [],
        attachments: Array.isArray(attachments) && attachments.length ? attachments : (f.attachment || []).map(a => toAttachment(a, null)),
        created_at: f.created,
        updated_at: f.updated,
        resolved_at: f.resolutiondate || undefined,
        raw_meta: {
            issuetype: f.issuetype?.name,
            assignee: f.assignee?.displayName,
            reporter: f.reporter?.displayName,
            resolution: f.resolution?.name,
        },
    };
}

// ──────────────────────────────────────────────────────────────
// ensureFreshTokens — no-op for API token auth
// ──────────────────────────────────────────────────────────────
async function ensureFreshTokens(_connection) {
    return { ok: true };
}

function describeCursor(connection) {
    const pc = connection.provider_cursor || {};
    return pc.updatedFrom ? `updated ≥ ${pc.updatedFrom}` : 'never synced';
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
