/**
 * Webpage Preview Routes — cross-origin endpoints callable from the
 * sandboxed preview iframe (no `allow-same-origin`, opaque origin, no cookies).
 *
 * All routes are guarded by `requirePreviewToken` (HMAC bearer token bound to
 * a specific `(userId, webpageId)` pair). Mounted in server/index.js without
 * the beta-feature gate because the gate is session-based and the iframe has
 * no session — the token is the trust anchor here, and it can only have been
 * issued by a session-authenticated request through the regular routes.
 *
 * Endpoints:
 *   POST /:id/db/query   — read-only SELECT
 *   POST /:id/db/exec    — INSERT/UPDATE/DELETE/CREATE/etc.
 *   POST /:id/db/batch   — array of statements in a single transaction
 *   GET  /:id/db/schema  — list tables + columns
 */

const express = require('express');
const router = express.Router();

const webpageDbStore = require('../stores/webpageDbStore');
const { requirePreviewToken } = require('../auth/webpagePreviewToken');

router.post('/:id/db/query', requirePreviewToken, async (req, res) => {
    const { userId, webpageId } = req.previewClaims;
    const { sql, params } = req.body || {};
    try {
        const result = await webpageDbStore.query(userId, webpageId, sql, params);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.post('/:id/db/exec', requirePreviewToken, async (req, res) => {
    const { userId, webpageId } = req.previewClaims;
    const { sql, params } = req.body || {};
    try {
        const result = await webpageDbStore.exec(userId, webpageId, sql, params);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.post('/:id/db/batch', requirePreviewToken, async (req, res) => {
    const { userId, webpageId } = req.previewClaims;
    const { statements } = req.body || {};
    try {
        const results = await webpageDbStore.batch(userId, webpageId, statements);
        res.json({ results });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.get('/:id/db/schema', requirePreviewToken, async (req, res) => {
    const { userId, webpageId } = req.previewClaims;
    try {
        const schema = await webpageDbStore.schema(userId, webpageId);
        res.json(schema);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
