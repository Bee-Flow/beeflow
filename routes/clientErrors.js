/**
 * Client Errors API — receives error reports from the browser ErrorBoundary.
 *
 * Log-only (no DB persistence). The goal is to get minified production stack
 * traces + React component stacks into the server log so they can be decoded
 * against sourcemap CI artifacts. Fire-and-forget from the client side.
 */

const express = require('express');
const { requireAuth } = require('../auth/permissions');

const router = express.Router();

function truncate(s, max) {
    if (typeof s !== 'string') return '';
    return s.length > max ? s.slice(0, max) + '…[truncated]' : s;
}

router.post('/', requireAuth, (req, res) => {
    try {
        const body = req.body || {};
        const entry = {
            label: truncate(String(body.label || 'unknown'), 64),
            message: truncate(String(body.message || ''), 2000),
            stack: truncate(String(body.stack || ''), 8000),
            componentStack: truncate(String(body.componentStack || ''), 8000),
            url: truncate(String(body.url || ''), 512),
            userAgent: truncate(String(body.userAgent || ''), 512),
            at: truncate(String(body.at || new Date().toISOString()), 48),
            buildSha: truncate(String(body.buildSha || ''), 64),
            userRole: truncate(String(body.userRole || ''), 64),
            featureFlags: truncate(JSON.stringify(body.featureFlags || {}), 1024),
            userId: req.session?.user?.id || req.session?.user?.username || null,
        };
        console.error('[ClientError]', JSON.stringify(entry));
    } catch (e) {
        console.error('[ClientError] handler failed:', e);
    }
    res.status(204).end();
});

module.exports = router;
