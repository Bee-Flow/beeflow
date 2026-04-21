/**
 * Ticket Assistant Routes — REST API for managing ticket-source connections
 * (gmail, outlook, jira, servicenow, zendesk, freshservice, topdesk).
 *
 * All routes gated behind requireBetaFeature('itil_ticket_assistant')
 * (applied at mount in index.js).
 */

const express = require('express');
const router = express.Router();
const ticketAssistantStore = require('../stores/ticketAssistantStore');
const kbStore = require('../stores/knowledgeBases');
const { triggerManualSync, testConnection, subscribeSyncEvents } = require('../services/ticketAssistantSyncEngine');
const { runStage, proposePromptImprovement } = require('../core/ticketAssistantStageRunner');
const { setupSSE } = require('../core/sseHelpers');
const ticketAssistantMetrics = require('../core/ticketAssistantMetrics');
const { resolveUserOrgIds } = require('../auth');

const ALLOWED_STAGES = new Set(['cleanup', 'pii', 'article', 'category', 'summarize_and_categorize', 'merge', 'dedupe']);
const AI_ASSIST_STAGES = new Set(['article', 'category', 'merge', 'dedupe', 'usefulness']);
const ALLOWED_TIERS = new Set(['fast', 'thinking', 'writer', 'deep_thinking']);

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

        const connections = await ticketAssistantStore.listConnections(orgId);
        res.json({ connections });
    } catch (err) {
        console.error('[TicketAssistant] List error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
// POST /connections — Create a new email connection
// Body: { knowledgeBaseId, provider ('gmail'|'outlook'), displayName? }
// Uses current session OAuth tokens
// ──────────────────────────────────────────────
const EMAIL_PROVIDERS = ['gmail', 'outlook'];
const TICKET_PROVIDERS = ['jira', 'servicenow', 'zendesk', 'freshservice', 'topdesk'];
const ALL_PROVIDERS = [...EMAIL_PROVIDERS, ...TICKET_PROVIDERS];

router.post('/connections', async (req, res) => {
    try {
        const orgId = await getOrgId(req);
        const userId = getUserId(req);
        if (!orgId || !userId) return res.status(400).json({ error: 'No organization or user context' });

        const { knowledgeBaseId, provider, displayName, credentials } = req.body;

        if (!knowledgeBaseId || !provider) {
            return res.status(400).json({ error: 'knowledgeBaseId and provider are required' });
        }

        if (!ALL_PROVIDERS.includes(provider)) {
            return res.status(400).json({ error: `Provider must be one of: ${ALL_PROVIDERS.join(', ')}` });
        }

        // Verify the KB exists
        const kb = await kbStore.getKB(knowledgeBaseId);
        if (!kb) return res.status(404).json({ error: 'Knowledge base not found' });

        let tokens = {};
        let emailAddress = '';
        let providerConfig = {};
        let authMethod = 'oauth';

        if (provider === 'gmail' || provider === 'outlook') {
            // Email providers: OAuth token capture from session
            const session = req.session;
            const requiredOauth = provider === 'gmail' ? 'google' : 'microsoft';
            if (session.oauthProvider !== requiredOauth || !session.accessToken) {
                return res.status(400).json({
                    error: `You must be logged in with ${requiredOauth === 'google' ? 'Google' : 'Microsoft'} to connect ${provider}. Please sign in first.`,
                });
            }
            tokens = { accessToken: session.accessToken, refreshToken: session.refreshToken };
            emailAddress = session.email || session.user?.email || '';
        } else {
            // Ticket providers: API-token / basic-auth credentials in the body
            const ticketProviders = require('../core/ticketProviders');
            const impl = ticketProviders.getProvider(provider);
            if (!impl) return res.status(400).json({ error: `Unknown ticket provider: ${provider}` });
            if (!credentials || typeof credentials !== 'object') {
                return res.status(400).json({ error: 'credentials object required for ticket providers' });
            }
            try {
                const result = await impl.completeAuth(credentials);
                tokens = result.tokens;
                emailAddress = result.accountIdentifier;
                providerConfig = result.providerConfig || {};
                authMethod = impl.defaultAuthMethod;
            } catch (authErr) {
                return res.status(400).json({ error: `Credential validation failed: ${authErr.message}` });
            }
        }

        if (!emailAddress) {
            return res.status(400).json({ error: 'Could not determine account identifier' });
        }

        const connection = await ticketAssistantStore.createConnection({
            organizationId: orgId,
            knowledgeBaseId,
            createdBy: userId,
            provider,
            emailAddress,
            displayName: displayName || emailAddress,
            tokens,
            providerConfig,
            authMethod,
        });

        console.log(`[TicketAssistant] Created connection: ${provider} ${emailAddress} → KB ${knowledgeBaseId}`);

        res.status(201).json({ connection });
    } catch (err) {
        console.error('[TicketAssistant] Create error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
// POST /connections/test — validate credentials without creating the connection
// Body: { provider, credentials }
// ──────────────────────────────────────────────
router.post('/connections/test', async (req, res) => {
    try {
        const { provider, credentials } = req.body || {};
        if (!provider) return res.status(400).json({ error: 'provider is required' });
        if (!TICKET_PROVIDERS.includes(provider)) {
            return res.status(400).json({ error: 'Test endpoint only valid for ticket providers. Email providers validate via OAuth session.' });
        }
        const ticketProviders = require('../core/ticketProviders');
        const impl = ticketProviders.getProvider(provider);
        if (!impl) return res.status(400).json({ error: `Unknown ticket provider: ${provider}` });
        try {
            const r = await impl.completeAuth(credentials || {});
            res.json({
                success: true,
                accountIdentifier: r.accountIdentifier,
                displayName: r.displayName,
                providerConfig: r.providerConfig,
            });
        } catch (authErr) {
            res.status(400).json({ success: false, error: authErr.message });
        }
    } catch (err) {
        console.error('[TicketAssistant] Test error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
// GET /connections/:id — Get connection details + recent sync logs
// ──────────────────────────────────────────────
router.get('/connections/:id', async (req, res) => {
    try {
        const connection = await ticketAssistantStore.getConnection(req.params.id);
        if (!connection) return res.status(404).json({ error: 'Connection not found' });

        // Verify org access
        const orgId = await getOrgId(req);
        if (connection.organization_id !== orgId && !isSuperAdmin(req)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const logs = await ticketAssistantStore.getRecentSyncLogs(connection.id, 10);

        res.json({ connection, syncLogs: logs });
    } catch (err) {
        console.error('[TicketAssistant] Get error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
// PATCH /connections/:id — Update connection settings
// ──────────────────────────────────────────────
router.patch('/connections/:id', async (req, res) => {
    try {
        const connection = await ticketAssistantStore.getConnection(req.params.id);
        if (!connection) return res.status(404).json({ error: 'Connection not found' });

        const orgId = await getOrgId(req);
        if (connection.organization_id !== orgId && !isSuperAdmin(req)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const updated = await ticketAssistantStore.updateConnection(req.params.id, req.body);
        res.json({ connection: updated });
    } catch (err) {
        console.error('[TicketAssistant] Update error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
// DELETE /connections/:id — Remove a connection
// ──────────────────────────────────────────────
router.delete('/connections/:id', async (req, res) => {
    try {
        const connection = await ticketAssistantStore.getConnection(req.params.id);
        if (!connection) return res.status(404).json({ error: 'Connection not found' });

        const orgId = await getOrgId(req);
        if (connection.organization_id !== orgId && !isSuperAdmin(req)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        await ticketAssistantStore.deleteConnection(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error('[TicketAssistant] Delete error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
// POST /connections/:id/sync — Trigger manual sync
// ──────────────────────────────────────────────
router.post('/connections/:id/sync', async (req, res) => {
    try {
        const connection = await ticketAssistantStore.getConnection(req.params.id);
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
        console.error('[TicketAssistant] Sync trigger error:', err.message);
        const status = err.status || 400;
        res.status(status).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
// POST /connections/:id/test — Test connection (process 1 email)
// ──────────────────────────────────────────────
router.post('/connections/:id/test', async (req, res) => {
    try {
        const connection = await ticketAssistantStore.getConnection(req.params.id);
        if (!connection) return res.status(404).json({ error: 'Connection not found' });

        const orgId = await getOrgId(req);
        if (connection.organization_id !== orgId && !isSuperAdmin(req)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const result = await testConnection(req.params.id);
        res.json(result);
    } catch (err) {
        console.error('[TicketAssistant] Test error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
// POST /connections/:id/pipeline/run-stage
// Runs a single pipeline stage (cleanup|pii|article|category|
// summarize_and_categorize|merge) on either provided text or the latest
// email sample. Does NOT ingest or persist anything. Supports per-call
// overrides so the admin can tweak a prompt / tier before saving.
// ──────────────────────────────────────────────
router.post('/connections/:id/pipeline/run-stage', async (req, res) => {
    try {
        const { stage, input, overrides } = req.body || {};
        if (!ALLOWED_STAGES.has(stage)) {
            return res.status(400).json({ error: `Invalid stage. Allowed: ${Array.from(ALLOWED_STAGES).join(', ')}` });
        }
        if (overrides?.modelTier && !ALLOWED_TIERS.has(overrides.modelTier)) {
            return res.status(400).json({ error: `Invalid modelTier. Allowed: ${Array.from(ALLOWED_TIERS).join(', ')}` });
        }
        const connection = await ticketAssistantStore.getConnectionWithTokens(req.params.id);
        if (!connection) return res.status(404).json({ error: 'Connection not found' });

        const orgId = await getOrgId(req);
        if (connection.organization_id !== orgId && !isSuperAdmin(req)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const result = await runStage({
            connection,
            stage,
            inputText: typeof input === 'string' ? input : undefined,
            overrides: overrides || {},
        });
        res.json(result);
    } catch (err) {
        console.error('[TicketAssistant] run-stage error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
// POST /connections/:id/pipeline/ai-assist
// Uses the caller-chosen model tier to propose an improved system prompt
// for a given stage, based on a sample input/output and user feedback.
// ──────────────────────────────────────────────
router.post('/connections/:id/pipeline/ai-assist', async (req, res) => {
    try {
        const { stage, currentPrompt, sampleInput, sampleOutput, userFeedback, modelTier } = req.body || {};
        if (!AI_ASSIST_STAGES.has(stage)) {
            return res.status(400).json({ error: `AI assist not supported for stage "${stage}"` });
        }
        const tier = modelTier && ALLOWED_TIERS.has(modelTier) ? modelTier : 'thinking';
        if (!userFeedback || typeof userFeedback !== 'string' || userFeedback.trim().length < 3) {
            return res.status(400).json({ error: 'userFeedback is required' });
        }

        const connection = await ticketAssistantStore.getConnection(req.params.id);
        if (!connection) return res.status(404).json({ error: 'Connection not found' });

        const orgId = await getOrgId(req);
        if (connection.organization_id !== orgId && !isSuperAdmin(req)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const result = await proposePromptImprovement({
            connection,
            stage,
            currentPrompt: currentPrompt || '',
            sampleInput: sampleInput || '',
            sampleOutput: sampleOutput || '',
            userFeedback: userFeedback.trim(),
            modelTier: tier,
        });
        res.json(result);
    } catch (err) {
        console.error('[TicketAssistant] ai-assist error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
// GET /connections/:id/sync/stream — SSE stream of sync progress events
// Event names: sync_started, sync_fetch_complete, email_processed, sync_completed
// ──────────────────────────────────────────────
router.get('/connections/:id/sync/stream', async (req, res) => {
    try {
        const connection = await ticketAssistantStore.getConnection(req.params.id);
        if (!connection) return res.status(404).json({ error: 'Connection not found' });

        const orgId = await getOrgId(req);
        if (connection.organization_id !== orgId && !isSuperAdmin(req)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const { sendEvent, markEnded } = setupSSE(res);

        // Initial hello so the client knows the stream is live (and proxies don't buffer).
        sendEvent('ready', { connectionId: connection.id, syncStatus: connection.sync_status });

        const unsubscribe = subscribeSyncEvents(connection.id, ({ event, data, at }) => {
            sendEvent(event, { ...data, at });
            if (event === 'sync_completed') {
                // Give the client a beat to receive the final event, then close.
                setTimeout(() => {
                    unsubscribe();
                    markEnded();
                    if (!res.writableEnded) res.end();
                }, 250);
            }
        });

        // Heartbeat every 25s keeps reverse-proxies (nginx default 60s idle) from
        // killing the connection during quiet periods.
        const heartbeat = setInterval(() => {
            if (res.writableEnded) return clearInterval(heartbeat);
            res.write(': ping\n\n');
        }, 25000);

        req.on('close', () => {
            clearInterval(heartbeat);
            unsubscribe();
            markEnded();
        });
    } catch (err) {
        console.error('[TicketAssistant] Sync stream error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
// GET /connections/:id/logs — Get sync history
// ──────────────────────────────────────────────
router.get('/connections/:id/logs', async (req, res) => {
    try {
        const connection = await ticketAssistantStore.getConnection(req.params.id);
        if (!connection) return res.status(404).json({ error: 'Connection not found' });

        const orgId = await getOrgId(req);
        if (connection.organization_id !== orgId && !isSuperAdmin(req)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const logs = await ticketAssistantStore.getRecentSyncLogs(connection.id, limit);

        res.json({ logs });
    } catch (err) {
        console.error('[TicketAssistant] Logs error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
// GET /metrics — Prometheus-compatible metrics dump (admin only)
// ──────────────────────────────────────────────
router.get('/metrics', async (req, res) => {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Admin only' });
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(ticketAssistantMetrics.renderTextFormat());
});

// ──────────────────────────────────────────────
// GET /connections/:id/cost — last-30d cost estimate for a connection
// ──────────────────────────────────────────────
router.get('/connections/:id/cost', async (req, res) => {
    try {
        const connection = await ticketAssistantStore.getConnection(req.params.id);
        if (!connection) return res.status(404).json({ error: 'Connection not found' });
        const orgId = await getOrgId(req);
        if (connection.organization_id !== orgId && !isSuperAdmin(req)) {
            return res.status(403).json({ error: 'Access denied' });
        }
        res.json({ connectionId: connection.id, cost30dUsd: ticketAssistantMetrics.getCost30d(connection.id) });
    } catch (err) {
        console.error('[TicketAssistant] Cost error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
