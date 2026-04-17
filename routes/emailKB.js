/**
 * Email KB Routes — REST API for managing email-to-KB connections
 *
 * All routes gated behind requireBetaFeature('email_knowledge_base')
 * (applied at mount in index.js).
 */

const express = require('express');
const router = express.Router();
const emailKBStore = require('../stores/emailKBStore');
const kbStore = require('../stores/knowledgeBases');
const { triggerManualSync, testConnection, subscribeSyncEvents } = require('../services/emailKBSyncEngine');
const { setupSSE } = require('../core/sseHelpers');
const { resolveUserOrgIds } = require('../auth');

// ──────────────────────────────────────────────
// Helpers: resolve user's org (same pattern as knowledgeBases.js)
// ──────────────────────────────────────────────
async function getOrgId(req) {
    const orgIds = await resolveUserOrgIds(req);
    if (orgIds === null) {
        // Super admin — use session org if available, or first org from user record
        return req.session?.user?.organizationId || null;
    }
    if (orgIds.size > 0) return Array.from(orgIds)[0];
    return null;
}

function getUserId(req) {
    return req.session?.user?.id || req.session?.userId || null;
}

function isSuperAdmin(req) {
    return req.session?.isAdmin || req.session?.user?.role === 'admin';
}

// ──────────────────────────────────────────────
// GET /connections — List all email connections for this org
// ──────────────────────────────────────────────
router.get('/connections', async (req, res) => {
    try {
        const orgId = await getOrgId(req);
        if (!orgId) return res.status(400).json({ error: 'No organization context' });

        const connections = await emailKBStore.listConnections(orgId);
        res.json({ connections });
    } catch (err) {
        console.error('[EmailKB] List error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
// POST /connections — Create a new email connection
// Body: { knowledgeBaseId, provider ('gmail'|'outlook'), displayName? }
// Uses current session OAuth tokens
// ──────────────────────────────────────────────
router.post('/connections', async (req, res) => {
    try {
        const orgId = await getOrgId(req);
        const userId = getUserId(req);
        if (!orgId || !userId) return res.status(400).json({ error: 'No organization or user context' });

        const { knowledgeBaseId, provider, displayName } = req.body;

        if (!knowledgeBaseId || !provider) {
            return res.status(400).json({ error: 'knowledgeBaseId and provider are required' });
        }

        if (!['gmail', 'outlook'].includes(provider)) {
            return res.status(400).json({ error: 'Provider must be "gmail" or "outlook"' });
        }

        // Verify the KB exists
        const kb = await kbStore.getKB(knowledgeBaseId);
        if (!kb) return res.status(404).json({ error: 'Knowledge base not found' });

        // Extract OAuth tokens from session
        const session = req.session;
        const tokens = {};
        let emailAddress = '';

        if (provider === 'gmail') {
            if (session.oauthProvider !== 'google' || !session.accessToken) {
                return res.status(400).json({
                    error: 'You must be logged in with Google to connect Gmail. Please sign in with your Google account first.'
                });
            }
            tokens.accessToken = session.accessToken;
            tokens.refreshToken = session.refreshToken;
            emailAddress = session.email || session.user?.email || '';
        } else if (provider === 'outlook') {
            if (session.oauthProvider !== 'microsoft' || !session.accessToken) {
                return res.status(400).json({
                    error: 'You must be logged in with Microsoft to connect Outlook. Please sign in with your Microsoft account first.'
                });
            }
            tokens.accessToken = session.accessToken;
            tokens.refreshToken = session.refreshToken;
            emailAddress = session.email || session.user?.email || '';
        }

        if (!emailAddress) {
            return res.status(400).json({ error: 'Could not determine email address from session' });
        }

        const connection = await emailKBStore.createConnection({
            organizationId: orgId,
            knowledgeBaseId,
            createdBy: userId,
            provider,
            emailAddress,
            displayName: displayName || emailAddress,
            tokens,
        });

        console.log(`[EmailKB] Created connection: ${provider} ${emailAddress} → KB ${knowledgeBaseId}`);

        res.status(201).json({ connection });
    } catch (err) {
        console.error('[EmailKB] Create error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
// GET /connections/:id — Get connection details + recent sync logs
// ──────────────────────────────────────────────
router.get('/connections/:id', async (req, res) => {
    try {
        const connection = await emailKBStore.getConnection(req.params.id);
        if (!connection) return res.status(404).json({ error: 'Connection not found' });

        // Verify org access
        const orgId = await getOrgId(req);
        if (connection.organization_id !== orgId && !isSuperAdmin(req)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const logs = await emailKBStore.getRecentSyncLogs(connection.id, 10);

        res.json({ connection, syncLogs: logs });
    } catch (err) {
        console.error('[EmailKB] Get error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
// PATCH /connections/:id — Update connection settings
// ──────────────────────────────────────────────
router.patch('/connections/:id', async (req, res) => {
    try {
        const connection = await emailKBStore.getConnection(req.params.id);
        if (!connection) return res.status(404).json({ error: 'Connection not found' });

        const orgId = await getOrgId(req);
        if (connection.organization_id !== orgId && !isSuperAdmin(req)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const updated = await emailKBStore.updateConnection(req.params.id, req.body);
        res.json({ connection: updated });
    } catch (err) {
        console.error('[EmailKB] Update error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
// DELETE /connections/:id — Remove a connection
// ──────────────────────────────────────────────
router.delete('/connections/:id', async (req, res) => {
    try {
        const connection = await emailKBStore.getConnection(req.params.id);
        if (!connection) return res.status(404).json({ error: 'Connection not found' });

        const orgId = await getOrgId(req);
        if (connection.organization_id !== orgId && !isSuperAdmin(req)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        await emailKBStore.deleteConnection(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error('[EmailKB] Delete error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
// POST /connections/:id/sync — Trigger manual sync
// ──────────────────────────────────────────────
router.post('/connections/:id/sync', async (req, res) => {
    try {
        const connection = await emailKBStore.getConnection(req.params.id);
        if (!connection) return res.status(404).json({ error: 'Connection not found' });

        const orgId = await getOrgId(req);
        if (connection.organization_id !== orgId && !isSuperAdmin(req)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const result = await triggerManualSync(req.params.id);
        if (result && result.conflict) {
            res.set('Retry-After', String(result.retryAfterSeconds));
            return res.status(409).json({
                error: result.message || 'Sync already in progress',
                retryAfterSeconds: result.retryAfterSeconds,
            });
        }
        res.json(result);
    } catch (err) {
        console.error('[EmailKB] Sync trigger error:', err.message);
        const status = err.status || 400;
        res.status(status).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
// POST /connections/:id/test — Test connection (process 1 email)
// ──────────────────────────────────────────────
router.post('/connections/:id/test', async (req, res) => {
    try {
        const connection = await emailKBStore.getConnection(req.params.id);
        if (!connection) return res.status(404).json({ error: 'Connection not found' });

        const orgId = await getOrgId(req);
        if (connection.organization_id !== orgId && !isSuperAdmin(req)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const result = await testConnection(req.params.id);
        res.json(result);
    } catch (err) {
        console.error('[EmailKB] Test error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
// GET /connections/:id/logs — Get sync history
// ──────────────────────────────────────────────
router.get('/connections/:id/logs', async (req, res) => {
    try {
        const connection = await emailKBStore.getConnection(req.params.id);
        if (!connection) return res.status(404).json({ error: 'Connection not found' });

        const orgId = await getOrgId(req);
        if (connection.organization_id !== orgId && !isSuperAdmin(req)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const logs = await emailKBStore.getRecentSyncLogs(connection.id, limit);

        res.json({ logs });
    } catch (err) {
        console.error('[EmailKB] Logs error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
