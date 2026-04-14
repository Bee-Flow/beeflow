/**
 * Email KB API Routes
 *
 * CRUD for email connections, manual sync trigger, test endpoint.
 * Works for both org-scoped and consumer (no-org) accounts.
 */

const express = require('express');
const router = express.Router();
const { requireAuth, resolveUserOrgIds } = require('../auth');
const emailKBStore = require('../stores/emailKBStore');
const { triggerManualSync, testConnection } = require('../services/emailKBSyncEngine');

// Helper: resolve user + orgId (null for consumer accounts)
async function getUserContext(req) {
    const userId = req.session.user?.id;
    if (!userId) throw new Error('Not authenticated');

    let orgId = null;
    try {
        const orgIds = await resolveUserOrgIds(req);
        if (orgIds === null) {
            // Super admin — use session org if available
            orgId = req.session.user?.organizationId || null;
        } else if (orgIds.size > 0) {
            orgId = Array.from(orgIds)[0];
        }
    } catch (_) { }

    return { userId, orgId };
}

// ── List connections ─────────────────────────────────────────────────────────
router.get('/connections', requireAuth, async (req, res) => {
    try {
        const { userId, orgId } = await getUserContext(req);
        const connections = await emailKBStore.getConnections(userId, orgId);
        // Parse JSON fields for the frontend
        const parsed = connections.map(c => ({
            ...c,
            folder_filter: safeParse(c.folder_filter, ['INBOX']),
            sender_blacklist: safeParse(c.sender_blacklist, []),
            enabled: !!c.enabled,
            group_threads: !!c.group_threads,
            process_attachments: !!c.process_attachments,
        }));
        res.json({ connections: parsed });
    } catch (err) {
        console.error('[EmailKB] List error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Create connection ────────────────────────────────────────────────────────
router.post('/connections', requireAuth, async (req, res) => {
    try {
        const { userId, orgId } = await getUserContext(req);
        const { provider, knowledgeBaseId } = req.body;

        if (!provider || !['gmail', 'outlook'].includes(provider)) {
            return res.status(400).json({ error: 'Invalid provider. Must be gmail or outlook.' });
        }
        if (!knowledgeBaseId) {
            return res.status(400).json({ error: 'Knowledge base ID is required' });
        }

        // Get OAuth tokens from the user's session
        const tokens = {
            accessToken: req.session.accessToken,
            refreshToken: req.session.refreshToken,
        };
        if (!tokens.accessToken) {
            return res.status(400).json({ error: 'No OAuth tokens available. Please log in with your email provider.' });
        }

        const emailAddress = req.session.user?.email || 'unknown';

        const connection = await emailKBStore.createConnection({
            userId, orgId, provider, email: emailAddress, tokens, kbId: knowledgeBaseId,
        });

        res.json(connection);
    } catch (err) {
        console.error('[EmailKB] Create error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Update connection ────────────────────────────────────────────────────────
router.patch('/connections/:id', requireAuth, async (req, res) => {
    try {
        const conn = await emailKBStore.getConnection(req.params.id);
        if (!conn) return res.status(404).json({ error: 'Connection not found' });

        // Verify ownership
        const { userId } = await getUserContext(req);
        if (conn.created_by !== userId && !req.session.isAdmin) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        await emailKBStore.updateConnection(req.params.id, req.body);
        res.json({ success: true });
    } catch (err) {
        console.error('[EmailKB] Update error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Delete connection ────────────────────────────────────────────────────────
router.delete('/connections/:id', requireAuth, async (req, res) => {
    try {
        const conn = await emailKBStore.getConnection(req.params.id);
        if (!conn) return res.status(404).json({ error: 'Connection not found' });

        const { userId } = await getUserContext(req);
        if (conn.created_by !== userId && !req.session.isAdmin) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        await emailKBStore.deleteConnection(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error('[EmailKB] Delete error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Trigger manual sync ──────────────────────────────────────────────────────
router.post('/connections/:id/sync', requireAuth, async (req, res) => {
    try {
        const result = await triggerManualSync(req.params.id);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Test connection ──────────────────────────────────────────────────────────
router.post('/connections/:id/test', requireAuth, async (req, res) => {
    try {
        const result = await testConnection(req.params.id);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Get sync logs ────────────────────────────────────────────────────────────
router.get('/connections/:id/logs', requireAuth, async (req, res) => {
    try {
        const logs = await emailKBStore.getSyncLogs(req.params.id);
        res.json({ logs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function safeParse(val, fallback) {
    if (Array.isArray(val)) return val;
    try { return JSON.parse(val || '[]'); } catch { return fallback; }
}

module.exports = router;
