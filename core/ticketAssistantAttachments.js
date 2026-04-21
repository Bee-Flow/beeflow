/**
 * Ticket Assistant attachment extractor — walks Gmail / Microsoft Graph
 * message payloads (plus ticket-provider attachment payloads), pulls
 * attachment bytes, and delegates to the shared attachmentExtractor to turn
 * PDF/DOCX/XLSX bytes into text.
 *
 * Filters applied (from pipeline_config.attachments):
 *   - enabled (default true)
 *   - allow (default ['pdf','docx','xlsx','csv','txt'])
 *   - maxBytes per attachment (default 10_000_000)
 *   - maxCount per email (default 5)
 *   - perAttachmentTokenCap / aggregateTokenCap via tokenBudget.
 *
 * Returns an array of `{ filename, bytes, sha256, text, source, kind }` where
 * kind is 'text' | 'skipped' | 'failed'.
 */

const crypto = require('crypto');
const { extractAttachment } = require('./attachmentExtractor');
const { fitIntoTokenBudget } = require('./tokenBudget');

const DEFAULT_ALLOW = ['pdf', 'docx', 'xlsx', 'csv', 'txt'];
const DEFAULT_MAX_BYTES = 10_000_000;
const DEFAULT_MAX_COUNT = 5;
const DEFAULT_PER_ATT_TOKENS = 4000;
const DEFAULT_AGG_TOKENS = 12_000;

const EXT_TO_MIME = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    csv: 'text/csv',
    txt: 'text/plain',
};

function resolveConfig(pipelineConfig) {
    const cfg = pipelineConfig?.attachments || {};
    return {
        enabled: cfg.enabled !== false,
        allow: (cfg.allow && cfg.allow.length ? cfg.allow : DEFAULT_ALLOW).map(s => String(s).toLowerCase()),
        maxBytes: Number.isFinite(cfg.maxBytes) ? cfg.maxBytes : DEFAULT_MAX_BYTES,
        maxCount: Number.isFinite(cfg.maxCount) ? cfg.maxCount : DEFAULT_MAX_COUNT,
        perTokens: Number.isFinite(cfg.perAttachmentTokens) ? cfg.perAttachmentTokens : DEFAULT_PER_ATT_TOKENS,
        aggTokens: Number.isFinite(cfg.aggregateTokens) ? cfg.aggregateTokens : DEFAULT_AGG_TOKENS,
    };
}

function filenameExt(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
}

function guessMime(filename, providedMime) {
    if (providedMime && providedMime !== 'application/octet-stream') return providedMime;
    return EXT_TO_MIME[filenameExt(filename)] || providedMime || 'application/octet-stream';
}

function sha256Hex(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Walk a Gmail full-format payload, collect attachment descriptors.
 * Returns [{ filename, attachmentId, partId, mimeType, size }]
 */
function listGmailAttachmentDescriptors(payload, out = []) {
    if (!payload) return out;
    if (payload.filename && payload.body?.attachmentId) {
        out.push({
            filename: payload.filename,
            attachmentId: payload.body.attachmentId,
            partId: payload.partId,
            mimeType: payload.mimeType || 'application/octet-stream',
            size: payload.body.size || 0,
        });
    }
    if (Array.isArray(payload.parts)) {
        for (const p of payload.parts) listGmailAttachmentDescriptors(p, out);
    }
    return out;
}

/**
 * Fetch + extract Gmail attachments for a message.
 *
 * @param {Object} gmail  googleapis gmail.users object (v1, authed)
 * @param {string} messageId
 * @param {Object} payload  detail.data.payload (already fetched)
 * @param {Object} pipelineConfig  connection.pipeline_config
 * @returns {Promise<Array<{filename, bytes, sha256, text?, source?, kind}>>}
 */
async function extractGmailAttachments(gmail, messageId, payload, pipelineConfig) {
    const cfg = resolveConfig(pipelineConfig);
    if (!cfg.enabled) return [];

    const descriptors = listGmailAttachmentDescriptors(payload).slice(0, cfg.maxCount);
    const out = [];
    let aggregateTokens = 0;

    for (const d of descriptors) {
        const ext = filenameExt(d.filename);
        if (!cfg.allow.includes(ext)) {
            out.push({ filename: d.filename, bytes: d.size, sha256: null, kind: 'skipped', reason: 'disallowed_type' });
            continue;
        }
        if (d.size > cfg.maxBytes) {
            out.push({ filename: d.filename, bytes: d.size, sha256: null, kind: 'skipped', reason: 'too_large' });
            continue;
        }
        try {
            const resp = await gmail.users.messages.attachments.get({
                userId: 'me',
                messageId,
                id: d.attachmentId,
            });
            const data = resp.data?.data;
            if (!data) {
                out.push({ filename: d.filename, bytes: d.size, sha256: null, kind: 'failed', reason: 'empty_response' });
                continue;
            }
            // Gmail uses URL-safe base64. attachmentExtractor decodes standard base64.
            const buf = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
            const sha = sha256Hex(buf);
            const ext = await extractAttachment({
                name: d.filename,
                type: guessMime(d.filename, d.mimeType),
                content: buf.toString('base64'),
            });
            out.push(...finalizeExtraction(d, buf, sha, ext, cfg, aggregateTokens));
            if (out.length && out[out.length - 1].kind === 'text') {
                aggregateTokens += Math.ceil((out[out.length - 1].text || '').length / 4);
            }
        } catch (err) {
            out.push({ filename: d.filename, bytes: d.size, sha256: null, kind: 'failed', reason: err.message });
        }
    }
    return out;
}

/**
 * Fetch + extract Outlook (Microsoft Graph) attachments for a message.
 *
 * @param {string} accessToken
 * @param {string} messageId
 * @param {Object} pipelineConfig
 */
async function extractOutlookAttachments(accessToken, messageId, pipelineConfig) {
    const cfg = resolveConfig(pipelineConfig);
    if (!cfg.enabled) return [];

    const GRAPH = 'https://graph.microsoft.com/v1.0';
    let descriptors = [];
    try {
        const resp = await fetch(`${GRAPH}/me/messages/${messageId}/attachments?$top=${cfg.maxCount}&$select=id,name,contentType,size,@odata.type`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!resp.ok) return [];
        const data = await resp.json();
        descriptors = (data.value || []).filter(a => a['@odata.type'] === '#microsoft.graph.fileAttachment');
    } catch {
        return [];
    }

    const out = [];
    let aggregateTokens = 0;

    for (const d of descriptors.slice(0, cfg.maxCount)) {
        const ext = filenameExt(d.name);
        if (!cfg.allow.includes(ext)) {
            out.push({ filename: d.name, bytes: d.size, sha256: null, kind: 'skipped', reason: 'disallowed_type' });
            continue;
        }
        if (d.size > cfg.maxBytes) {
            out.push({ filename: d.name, bytes: d.size, sha256: null, kind: 'skipped', reason: 'too_large' });
            continue;
        }
        try {
            const resp = await fetch(`${GRAPH}/me/messages/${messageId}/attachments/${d.id}?$select=contentBytes,name,contentType`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (!resp.ok) {
                out.push({ filename: d.name, bytes: d.size, sha256: null, kind: 'failed', reason: `graph_${resp.status}` });
                continue;
            }
            const body = await resp.json();
            const b64 = body.contentBytes;
            if (!b64) {
                out.push({ filename: d.name, bytes: d.size, sha256: null, kind: 'failed', reason: 'empty_response' });
                continue;
            }
            const buf = Buffer.from(b64, 'base64');
            const sha = sha256Hex(buf);
            const extResult = await extractAttachment({
                name: d.name,
                type: guessMime(d.name, d.contentType),
                content: b64,
            });
            out.push(...finalizeExtraction({ filename: d.name, size: d.size, mimeType: d.contentType }, buf, sha, extResult, cfg, aggregateTokens));
            if (out.length && out[out.length - 1].kind === 'text') {
                aggregateTokens += Math.ceil((out[out.length - 1].text || '').length / 4);
            }
        } catch (err) {
            out.push({ filename: d.name, bytes: d.size, sha256: null, kind: 'failed', reason: err.message });
        }
    }
    return out;
}

function finalizeExtraction(descriptor, buf, sha, extResult, cfg, aggregateTokensSoFar) {
    const base = {
        filename: descriptor.filename || descriptor.name,
        bytes: descriptor.size || buf.length,
        sha256: sha,
    };
    if (extResult.kind !== 'text' || !extResult.text) {
        return [{ ...base, kind: 'failed', reason: extResult.reason || 'no_text' }];
    }
    const remainingAgg = Math.max(0, cfg.aggTokens - aggregateTokensSoFar);
    if (remainingAgg <= 0) {
        return [{ ...base, kind: 'skipped', reason: 'aggregate_budget_exhausted' }];
    }
    const perCap = Math.min(cfg.perTokens, remainingAgg);
    const fit = fitIntoTokenBudget(extResult.text, perCap, { marker: '…[attachment truncated]…' });
    return [{
        ...base,
        kind: 'text',
        source: extResult.source || 'unknown',
        text: fit.text,
        truncated: fit.truncated,
    }];
}

/**
 * Format extracted attachments as a Markdown tail to append to the per-email
 * article body. Empty string if nothing extracted.
 */
function formatAttachmentsMarkdown(extracted) {
    if (!extracted || !extracted.length) return '';
    const textOnes = extracted.filter(a => a.kind === 'text' && a.text);
    if (!textOnes.length) return '';
    return textOnes.map(a => {
        const header = `## Attachment: ${a.filename} (${a.source || 'unknown'}${a.truncated ? ', truncated' : ''})`;
        return `\n\n${header}\n\n${a.text}`;
    }).join('');
}

module.exports = {
    extractGmailAttachments,
    extractOutlookAttachments,
    formatAttachmentsMarkdown,
    listGmailAttachmentDescriptors,
    resolveConfig,
};
