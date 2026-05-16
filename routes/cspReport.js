/**
 * CSP violation report sink.
 *
 * When Content-Security-Policy is enabled in report-only mode (either at
 * the Express layer or upstream in Nginx), browsers POST violations here.
 * Log-only — the goal is to surface accidental violations during the
 * pre-rollout soak so we can adjust the policy before flipping to
 * enforcing.
 *
 * No auth: CSP reports are fired by the browser with the Origin set, often
 * without the user's session cookie attached. Rate-limiting + payload size
 * caps keep this endpoint safe to leave open.
 */

const express = require('express');

const router = express.Router();

const MAX_BODY = 16_384; // 16 KB cap per report.

function truncate(s, max) {
    if (typeof s !== 'string') return '';
    return s.length > max ? s.slice(0, max) + '…[truncated]' : s;
}

// Browsers send either `application/csp-report` (legacy) or
// `application/reports+json` (Reporting API v2). Accept both — express.json's
// strict parser is forgiving when the Content-Type is set explicitly.
const cspBody = express.json({
    type: ['application/csp-report', 'application/reports+json', 'application/json'],
    limit: '32kb',
});

router.post('/', cspBody, (req, res) => {
    try {
        const body = req.body || {};
        // Legacy shape: { "csp-report": {...} }
        // Reporting API shape: [{ type: 'csp-violation', body: {...} }, ...]
        const reports = Array.isArray(body) ? body.map(r => r.body || r) : [body['csp-report'] || body];
        for (const r of reports) {
            if (!r || typeof r !== 'object') continue;
            const entry = {
                blockedUri: truncate(String(r['blocked-uri'] || r.blockedURL || ''), 512),
                violatedDirective: truncate(String(r['violated-directive'] || r.effectiveDirective || ''), 128),
                documentUri: truncate(String(r['document-uri'] || r.documentURL || ''), 512),
                disposition: truncate(String(r.disposition || ''), 32),
                sourceFile: truncate(String(r['source-file'] || r.sourceFile || ''), 512),
                lineNumber: Number(r['line-number'] || r.lineNumber) || null,
                statusCode: Number(r['status-code'] || r.statusCode) || null,
                userAgent: truncate(String(req.get('user-agent') || ''), 256),
                at: new Date().toISOString(),
            };
            // Cap the cumulative payload so a malformed flood can't fill logs.
            const json = JSON.stringify(entry);
            console.warn('[csp-report]', json.length > MAX_BODY ? json.slice(0, MAX_BODY) : json);
        }
    } catch (e) {
        console.warn('[cspReport] parse failed', e);
    }
    res.sendStatus(204);
});

module.exports = router;
