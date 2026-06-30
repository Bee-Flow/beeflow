/**
 * Tenant Support Inbox API (Studio → Support).
 *
 * A NON-global-admin org runs its own customer-support desk here: connect a
 * support mailbox (Gmail/Outlook), inbound email becomes tickets, and replies
 * are drafted by an agent + knowledge base and sent from the connected mailbox.
 *
 * Hard tenancy boundary: every route resolves the caller's org(s) and only ever
 * touches support_threads WHERE inbox_id IS NOT NULL belonging to those orgs.
 * Bee Flow's own company inbox (/api/support, inbox_id IS NULL) is unreachable
 * from here, and the company inbox excludes inbox_id-set tenant threads.
 *
 * Mounted (server/index.js) behind requireLicenseFeature('support_inbox') +
 * requireBetaFeature('support_inbox'); the org-level 'support_inbox' permission
 * is enforced per-route below.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const supportInboxStore = require('../stores/supportInboxStore');
const supportStore = require('../stores/supportStore');
const { setupSSE } = require('../core/sseHelpers');
const { resolveUserOrgIds, hasPermission, validateSharedGroupsForOrg } = require('../auth/permissions');
const access = require('../support/access');
const audit = require('../support/audit');
const providerClients = require('../services/email/providerClients');
const supportMailer = require('../services/supportMailer');
const { runAiAutoResponder } = require('../services/supportAiResponder');
// supportEvents is a shared bus; tenant events carry inboxId so the company
// /api/support/stream skips them and our /stream forwards only in-scope inboxes.
const { supportEvents } = require('./support');

function getUserId(req) { return req.session?.user?.id || null; }

function emitInboxEvent(event, inboxId, data = {}) {
    try { supportEvents.emit('event', { event, data: { ...data, inboxId } }); } catch {}
}

async function _hasSupportInbox(req) {
    const uid = getUserId(req);
    if (!uid) return false;
    try {
        return (await hasPermission(uid, 'support_inbox', req.session))
            || (await hasPermission(uid, 'all', req.session));
    } catch (e) {
        console.warn('[SupportInbox] permission check failed:', e.message);
        return false;
    }
}

/** Org ids the caller may act within (super-admins fall back to their own org). */
async function resolveOrgScope(req) {
    const ids = await resolveUserOrgIds(req);
    if (ids === null) {
        const oid = req.session?.user?.organizationId;
        return oid ? [oid] : [];
    }
    return Array.from(ids);
}

function inboxToReplyConfig(inbox) {
    return {
        agentId: inbox.default_agent_id || null,
        kbIds: Array.isArray(inbox.kb_ids) ? inbox.kb_ids : [],
        replyMode: inbox.reply_mode || 'draft',
        autoresolveThreshold: Number(inbox.autoresolve_threshold) || 0.78,
        v2Enabled: !!inbox.tools_enabled,
        toolsEnabled: !!inbox.tools_enabled,
        enabledToolIds: Array.isArray(inbox.enabled_tool_ids) ? inbox.enabled_tool_ids : [],
        // Designated operator for integration tools. operatorOrgId is the inbox's
        // own org (the operator is validated to belong to it) — never the
        // requester's org — so integration entitlement gates against the support
        // team, not the customer.
        operatorUserId: inbox.operator_user_id || null,
        operatorOrgId: inbox.organization_id || null,
    };
}

// ── Permission gate (all routes) ──────────────────────────────────────────────
router.use(async (req, res, next) => {
    if (!getUserId(req)) return res.status(401).json({ error: 'Not authenticated' });
    if (!(await _hasSupportInbox(req))) {
        return res.status(403).json({ error: 'support_inbox permission required' });
    }
    next();
});

/**
 * Per-inbox access gate (org scope AND group ACL). The single source of truth
 * every inbox/thread-reaching route funnels through, so a group-restricted inbox
 * can never be opened by a non-member — not via the inbox list, nor by reaching
 * one of its tickets directly.
 */
async function userCanAccessInbox(req, inbox) {
    if (!inbox) return false;
    const scope = await resolveOrgScope(req);
    // Super admins are limited to their own org's inboxes (resolveOrgScope falls
    // back to their org); everyone else to their member orgs.
    if (!scope.includes(inbox.organization_id)) return false;
    const { orgIds } = await access.resolveOrgScope(req);
    const [userGroups, isOrgAdmin] = await Promise.all([
        access.resolveUserGroups(req), access.resolveIsOrgAdmin(req),
    ]);
    return access.canUserAccessInbox(inbox, getUserId(req), orgIds, userGroups, { isOrgAdmin });
}

// Resolve + scope/ACL-check an inbox; returns the public row or sends 403/404.
async function loadInboxInScope(req, res, id, { withTokens = false } = {}) {
    const inbox = withTokens
        ? await supportInboxStore.getInboxWithTokens(id)
        : await supportInboxStore.getInbox(id);
    if (!inbox) { res.status(404).json({ error: 'Inbox not found' }); return null; }
    if (!(await userCanAccessInbox(req, inbox))) {
        res.status(403).json({ error: 'You do not have access to this inbox.' }); return null;
    }
    return inbox;
}

// Resolve + scope/ACL-check a thread. Loads the thread's inbox and runs the same
// per-inbox group ACL — closes the cross-inbox-via-thread access gap.
async function loadThreadInScope(req, res, id) {
    const thread = await supportStore.getThread(id);
    if (!thread || !thread.inbox_id) { res.status(404).json({ error: 'Ticket not found' }); return null; }
    const inbox = await supportInboxStore.getInbox(thread.inbox_id);
    if (!inbox) { res.status(404).json({ error: 'Ticket not found' }); return null; }
    if (!(await userCanAccessInbox(req, inbox))) {
        res.status(403).json({ error: 'You do not have access to this ticket.' }); return null;
    }
    return thread;
}

// ── Inbox CRUD ────────────────────────────────────────────────────────────────

router.get('/inboxes', async (req, res) => {
    try {
        const inboxes = await access.accessibleInboxes(req);
        res.json({ inboxes });
    } catch (err) {
        console.error('[SupportInbox] GET /inboxes error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

router.post('/inboxes', async (req, res) => {
    try {
        const scope = await resolveOrgScope(req);
        const organizationId = req.body.organizationId || scope[0];
        if (!organizationId || !scope.includes(organizationId)) {
            return res.status(403).json({ error: 'No organization in scope' });
        }
        const { provider, displayName, defaultAgentId, kbIds, replyMode, autoresolveThreshold, toolsEnabled, signature, folderFilter } = req.body;
        if (!['gmail', 'outlook'].includes(provider)) return res.status(400).json({ error: 'provider must be gmail or outlook' });
        const inbox = await supportInboxStore.createInbox({
            organizationId, createdBy: getUserId(req), provider,
            displayName: displayName || '', defaultAgentId: defaultAgentId || null,
            kbIds: Array.isArray(kbIds) ? kbIds : [],
            replyMode: ['draft', 'auto_confident', 'autonomous'].includes(replyMode) ? replyMode : 'draft',
            autoresolveThreshold: autoresolveThreshold != null ? Number(autoresolveThreshold) : 0.78,
            toolsEnabled: !!toolsEnabled, signature: signature || null,
            folderFilter: Array.isArray(folderFilter) ? folderFilter : ['INBOX'],
        });
        audit.emit(req, { organizationId, inboxId: inbox.id, action: 'inbox_created', payload: { provider, displayName: inbox.display_name || null } });
        res.json({ inbox });
    } catch (err) {
        console.error('[SupportInbox] POST /inboxes error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.patch('/inboxes/:id', async (req, res) => {
    try {
        const inbox = await loadInboxInScope(req, res, req.params.id);
        if (!inbox) return;
        // A designated operator must be support-capable staff in THIS inbox's
        // org: integration tools execute under their identity, so a cross-org
        // operator would expose another org's credentials/entitlements. Empty
        // string / null clears the operator (allowed).
        if (typeof req.body?.operator_user_id === 'string' && req.body.operator_user_id.trim()) {
            const { _eligibleStaffForOrg } = require('../services/supportAutoAssigner');
            const eligible = await _eligibleStaffForOrg(inbox.organization_id).catch(() => []);
            const op = req.body.operator_user_id.trim();
            if (!Array.isArray(eligible) || !eligible.includes(op)) {
                return res.status(400).json({ error: "Operator must be a support-capable member of this inbox's organisation." });
            }
            // When the inbox is group-restricted, the operator must also belong to
            // a group that has access — its integrations execute under their
            // identity, so the operator must be a legitimate worker of this inbox.
            const groups = Array.isArray(inbox.shared_groups) ? inbox.shared_groups : [];
            if (groups.length) {
                const opGroups = await access.userGroupsFor(op);
                if (!opGroups.some(g => groups.includes(g))) {
                    return res.status(400).json({ error: 'Operator must belong to a group that has access to this inbox.' });
                }
            }
            req.body.operator_user_id = op;
        } else if (req.body && (req.body.operator_user_id === '' )) {
            req.body.operator_user_id = null; // explicit clear
        }
        // shared_groups is access-controlled — only the dedicated /access endpoint
        // may change it; ignore any value smuggled into a settings PATCH.
        if (req.body && 'shared_groups' in req.body) delete req.body.shared_groups;
        const changedKeys = Object.keys(req.body || {});
        const updated = await supportInboxStore.updateInbox(req.params.id, req.body, inbox.organization_id);
        audit.emit(req, { organizationId: inbox.organization_id, inboxId: inbox.id, action: 'inbox_settings_changed', payload: { changed: changedKeys } });
        res.json({ inbox: updated });
    } catch (err) {
        console.error('[SupportInbox] PATCH /inboxes error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/inboxes/:id', async (req, res) => {
    try {
        const inbox = await loadInboxInScope(req, res, req.params.id);
        if (!inbox) return;
        // Tear down the per-inbox KB-ingestion routine first so it can't keep
        // firing on a dead inbox_id filter after the mailbox is gone.
        if (inbox.kb_ingest_routine_id) {
            const { teardownRoutine } = require('../automation/provisionRoutine');
            await teardownRoutine(inbox.kb_ingest_routine_id).catch(() => {});
        }
        await supportInboxStore.deleteInbox(req.params.id, inbox.organization_id);
        audit.emit(req, { organizationId: inbox.organization_id, inboxId: inbox.id, action: 'inbox_deleted', payload: { provider: inbox.provider, emailAddress: inbox.email_address || null } });
        res.json({ ok: true });
    } catch (err) {
        console.error('[SupportInbox] DELETE /inboxes error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── KB ingestion: provision/enable/disable the resolved-tickets→KB routine ────
// straight from the Support settings panel (no trip to Routines).

/**
 * Build (or update) the per-inbox "resolved tickets → KB" routine from the
 * support-ticket-to-kb template, bound to this inbox + chosen KB, and activate
 * it. Idempotent: re-uses the stored routine id when present. Returns the
 * routine id + any non-blocking warnings.
 */
async function ensureKbAutomation(inbox, userId, session, kbId) {
    const templates = require('../automation/templates');
    const automationStore = require('../stores/automationStore');
    const { activateRoutine } = require('../automation/provisionRoutine');

    const tmpl = templates.getTemplate('support-ticket-to-kb');
    if (!tmpl) throw new Error('KB-ingestion template not found');
    const def = JSON.parse(JSON.stringify(tmpl.definition));
    // Bind the trigger to THIS inbox so the routine only fires for its tickets.
    def.trigger.appEvent = def.trigger.appEvent || {};
    def.trigger.appEvent.filter = { ...(def.trigger.appEvent.filter || {}), inboxId: inbox.id };
    // Fill the KB on the ingest step.
    const ingestStep = (def.steps || []).find(s => s.tool === 'knowledge_base_ingest');
    if (!ingestStep) throw new Error('KB-ingestion template is missing its ingest step');
    ingestStep.inputs = ingestStep.inputs || {};
    ingestStep.inputs.knowledgeBaseId = { kind: 'literal', value: kbId };

    let routineId = inbox.kb_ingest_routine_id || null;
    const existing = routineId ? await automationStore.getAutomation(routineId).catch(() => null) : null;
    if (existing) {
        await automationStore.updateAutomation(routineId, { definition: def, triggerType: 'app_event', isDraft: false }, userId);
    } else {
        const created = await automationStore.createAutomation({
            userId, organizationId: inbox.organization_id,
            title: `Support → KB: ${inbox.email_address || inbox.display_name || inbox.provider}`,
            description: 'Auto-provisioned from Support settings — distils resolved tickets into the knowledge base.',
            definition: def, triggerType: 'app_event',
        });
        routineId = created.id;
    }
    const { warnings } = await activateRoutine(routineId, { userId, session, isAdmin: !!session?.isAdmin });
    return { routineId, warnings };
}

router.put('/inboxes/:id/kb-automation', async (req, res) => {
    try {
        const inbox = await loadInboxInScope(req, res, req.params.id);
        if (!inbox) return;
        const userId = getUserId(req);
        const enabled = !!req.body.enabled;
        const { teardownRoutine } = require('../automation/provisionRoutine');

        if (!enabled) {
            if (inbox.kb_ingest_routine_id) await teardownRoutine(inbox.kb_ingest_routine_id).catch(() => {});
            // Keep kb id so re-enabling pre-selects the previous KB.
            const updated = await supportInboxStore.setKbAutomation(req.params.id, { enabled: false, routineId: null }, inbox.organization_id);
            audit.emit(req, { organizationId: inbox.organization_id, inboxId: inbox.id, action: 'kb_automation_changed', payload: { enabled: false } });
            return res.json({ inbox: updated });
        }

        const knowledgeBaseId = req.body.knowledgeBaseId;
        if (!knowledgeBaseId) return res.status(400).json({ error: 'knowledgeBaseId is required to enable knowledge ingestion.' });
        // Validate the KB is in this org and not a system KB.
        const knowledgeBases = require('../stores/knowledgeBases');
        const kb = await knowledgeBases.getKB(knowledgeBaseId);
        if (!kb) return res.status(400).json({ error: 'Knowledge base not found.' });
        if (kb.tenant_id === 'system') return res.status(400).json({ error: 'Cannot ingest into a system knowledge base.' });
        if (kb.organization_id && kb.organization_id !== inbox.organization_id) {
            return res.status(403).json({ error: 'Knowledge base does not belong to this organisation.' });
        }

        let provisioned;
        try {
            provisioned = await ensureKbAutomation(inbox, userId, req.session, knowledgeBaseId);
        } catch (e) {
            // Activation/validation failure — do NOT mark enabled (keep state consistent).
            return res.status(400).json({ error: e.message, details: e.details || null });
        }
        const updated = await supportInboxStore.setKbAutomation(
            req.params.id, { enabled: true, kbId: knowledgeBaseId, routineId: provisioned.routineId }, inbox.organization_id
        );
        audit.emit(req, { organizationId: inbox.organization_id, inboxId: inbox.id, action: 'kb_automation_changed', payload: { enabled: true, knowledgeBaseId, routineId: provisioned.routineId } });
        res.json({ inbox: updated, routineId: provisioned.routineId, warnings: provisioned.warnings || [] });
    } catch (err) {
        console.error('[SupportInbox] PUT /kb-automation error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Historical response-time scan (aggregate-only, on-demand) ─────────────────

router.post('/inboxes/:id/scan', async (req, res) => {
    try {
        const inbox = await loadInboxInScope(req, res, req.params.id);
        if (!inbox) return;
        if (!inbox.connected) return res.status(400).json({ error: 'Connect the mailbox before scanning.' });
        if (['queued', 'running'].includes(inbox.scan_status)) {
            return res.status(409).json({ error: 'A scan is already in progress.', scan_status: inbox.scan_status });
        }
        const { DEFAULT_WINDOW_DAYS, scanOneDue } = require('../services/supportInboxScanEngine');
        let days = parseInt(req.body?.windowDays, 10);
        if (!Number.isFinite(days) || days < 1) days = DEFAULT_WINDOW_DAYS;
        days = Math.min(days, 730);
        const scanAfter = new Date(Date.now() - days * 86400000).toISOString();
        const updated = await supportInboxStore.queueScan(req.params.id, { scanAfter });
        audit.emit(req, { organizationId: inbox.organization_id, inboxId: inbox.id, action: 'scan_started', payload: { windowDays: days } });
        // Best-effort immediate kick (the lease prevents double-run with the drain
        // tick); only when this process is the configured scan runner.
        if (process.env.SUPPORT_SCAN_IN_API !== 'false') { scanOneDue().catch(() => {}); }
        res.json({ inbox: updated });
    } catch (err) {
        console.error('[SupportInbox] POST /scan error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.get('/inboxes/:id/scan', async (req, res) => {
    try {
        const inbox = await loadInboxInScope(req, res, req.params.id);
        if (!inbox) return;
        res.json({ scan_status: inbox.scan_status, scan_progress: inbox.scan_progress, scan_result: inbox.scan_result });
    } catch (err) {
        res.status(500).json({ error: 'Internal error' });
    }
});

// ── OAuth connect (dedicated per-mailbox flow — NOT the login OAuth) ──────────

/**
 * Build the OAuth callback URL. Mirrors the login flow (server/auth/oauthRoutes.js):
 * prefer the explicit SERVER_PUBLIC_HOST/SERVER_PROTOCOL (set in every deploy,
 * incl. local where it is localhost:3001), then the proxy's X-Forwarded-Host,
 * then the Referer origin, and only finally the bare Host header — which behind
 * the agent-hub nginx is `localhost` WITHOUT the port (that produced the broken
 * `http://localhost/...:80` redirect that 404'd). The resolved value is stashed
 * in the session at /oauth/start and reused verbatim at /oauth/callback so the
 * two redirect_uri values Google compares are always identical.
 */
function redirectUriFor(req) {
    let host = process.env.SERVER_PUBLIC_HOST;
    let protocol = process.env.SERVER_PROTOCOL || req.protocol || 'https';
    if (!host) {
        host = req.get('X-Forwarded-Host') || null;
        if (!host) {
            const ref = req.get('Referer');
            if (ref) { try { const u = new URL(ref); host = u.host; protocol = u.protocol.replace(':', ''); } catch { /* ignore */ } }
        }
        if (!host) host = req.get('host');
    }
    return `${protocol}://${host}/api/support-inbox/oauth/callback`;
}

router.get('/inboxes/:id/oauth/start', async (req, res) => {
    try {
        const inbox = await loadInboxInScope(req, res, req.params.id);
        if (!inbox) return;
        const state = crypto.randomBytes(24).toString('hex');
        const redirectUri = redirectUriFor(req);
        req.session.supportMailbox = {
            state, inboxId: inbox.id, orgId: inbox.organization_id, provider: inbox.provider, ts: Date.now(), redirectUri,
        };
        const url = await providerClients.buildAuthUrl(inbox.provider, { redirectUri, state });
        await new Promise((r) => req.session.save(() => r()));
        res.json({ url });
    } catch (err) {
        console.error('[SupportInbox] oauth/start error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

function _oauthClosePage(ok, message) {
    const payload = JSON.stringify({ type: 'support-mailbox-oauth', ok, message: message || '' });
    return `<!doctype html><html><head><meta charset="utf-8"><title>Mailbox connected</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px;text-align:center;color:#0f172a">
<p>${ok ? 'Mailbox connected. You can close this window.' : `Connection failed: ${String(message || '').slice(0, 200)}`}</p>
<script>try{window.opener&&window.opener.postMessage(${JSON.stringify(payload)},'*');}catch(e){}setTimeout(function(){window.close();},800);</script>
</body></html>`;
}

function _serviceEmailClosePage(ok, message) {
    const payload = JSON.stringify({ type: 'service-email-oauth', ok, message: message || '' });
    return `<!doctype html><html><head><meta charset="utf-8"><title>Service email connected</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px;text-align:center;color:#0f172a">
<p>${ok ? 'Service email connected. You can close this window.' : `Connection failed: ${String(message || '').slice(0, 200)}`}</p>
<script>try{window.opener&&window.opener.postMessage(${JSON.stringify(payload)},'*');}catch(e){}setTimeout(function(){window.close();},800);</script>
</body></html>`;
}

/**
 * Handle the OAuth callback for the platform Service Email (Gmail API) connect.
 * This reuses the registered support-inbox redirect URI; the start route
 * (server/routes/ai/config.js, admin-gated) set req.session.serviceEmailConnect,
 * so holding a matching state is the proof this was an admin-initiated connect.
 */
async function _handleServiceEmailCallback(req, res) {
    const sess = req.session.serviceEmailConnect;
    try {
        const { code, state, error } = req.query;
        if (error) return res.status(400).send(_serviceEmailClosePage(false, String(error)));
        if (!sess || !state || state !== sess.state) {
            return res.status(400).send(_serviceEmailClosePage(false, 'Invalid or expired connect session'));
        }
        const emailService = require('../utils/emailService');
        const { address } = await emailService.completeOAuthConnect({
            code, redirectUri: sess.redirectUri || redirectUriFor(req),
        });
        delete req.session.serviceEmailConnect;
        await new Promise((r) => req.session.save(() => r()));
        res.send(_serviceEmailClosePage(true, address));
    } catch (err) {
        console.error('[ServiceEmail] oauth/callback error:', err.message);
        delete req.session.serviceEmailConnect;
        res.status(500).send(_serviceEmailClosePage(false, err.message));
    }
}

router.get('/oauth/callback', async (req, res) => {
    // Dispatch: the platform Service Email connect reuses this registered
    // redirect URI. Route to it only when the returned state matches the
    // service-email connect session, so a lingering support-mailbox connect in
    // the same session is never mis-handled.
    if (req.session?.serviceEmailConnect && req.query.state === req.session.serviceEmailConnect.state) {
        return _handleServiceEmailCallback(req, res);
    }
    const sess = req.session?.supportMailbox;
    try {
        const { code, state, error } = req.query;
        if (error) return res.status(400).send(_oauthClosePage(false, String(error)));
        if (!sess || !state || state !== sess.state) {
            return res.status(400).send(_oauthClosePage(false, 'Invalid or expired connect session'));
        }
        // Re-validate the inbox is still in scope for this user.
        const scope = await resolveOrgScope(req);
        if (!scope.includes(sess.orgId)) {
            return res.status(403).send(_oauthClosePage(false, 'Organization not in scope'));
        }
        const { tokens, emailAddress } = await providerClients.exchangeCode(sess.provider, {
            code, redirectUri: sess.redirectUri || redirectUriFor(req),
        });
        await supportInboxStore.updateTokens(sess.inboxId, tokens, { emailAddress });
        audit.emit(req, { organizationId: sess.orgId, inboxId: sess.inboxId, action: 'inbox_connected', payload: { provider: sess.provider, emailAddress: emailAddress || null } });
        delete req.session.supportMailbox;
        await new Promise((r) => req.session.save(() => r()));
        res.send(_oauthClosePage(true));
    } catch (err) {
        console.error('[SupportInbox] oauth/callback error:', err.message);
        res.status(500).send(_oauthClosePage(false, err.message));
    }
});

// ── Threads (tenant-scoped) ───────────────────────────────────────────────────

router.get('/threads', async (req, res) => {
    try {
        const inboxes = await access.accessibleInboxes(req);
        let inboxIds = inboxes.map(i => i.id);
        const { inbox, status, q, assignee, limit, offset } = req.query;
        if (inbox) {
            if (!inboxIds.includes(inbox)) return res.json({ threads: [], counts: {} });
            inboxIds = [inbox];
        }
        if (!inboxIds.length) return res.json({ threads: [], counts: {} });
        const statusList = status ? status.split(',').map(s => s.trim()).filter(Boolean) : null;
        const { NOT_SUPPORT_TAG } = require('../services/supportClassifier');
        const { tag, excludeFiltered } = req.query;
        const viewingNotSupport = tag === NOT_SUPPORT_TAG;
        const listOpts = {
            inboxIdIn: inboxIds,
            statusIn: statusList && statusList.length ? statusList : null,
            q: q || null,
            assigneeUserId: assignee || null,
            limit: limit ? parseInt(limit, 10) : 100,
            offset: offset ? parseInt(offset, 10) : 0,
        };
        // Default views hide non-support tickets; the dedicated tab shows only them.
        if (viewingNotSupport) listOpts.tagsIn = [NOT_SUPPORT_TAG];
        else if (excludeFiltered !== '0') listOpts.excludeTags = [NOT_SUPPORT_TAG];
        const threads = await supportStore.listThreads(listOpts);
        // Status-tab counts exclude filtered tickets; expose the filtered total separately.
        const counts = await supportStore.countThreadsByStatus({ inboxIdIn: inboxIds, excludeTags: [NOT_SUPPORT_TAG] });
        const nsCounts = await supportStore.countThreadsByStatus({ inboxIdIn: inboxIds, tagsIn: [NOT_SUPPORT_TAG] });
        counts.not_support = Object.values(nsCounts).reduce((a, b) => a + b, 0);
        res.json({ threads, counts });
    } catch (err) {
        console.error('[SupportInbox] GET /threads error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

router.get('/threads/:id', async (req, res) => {
    try {
        const thread = await loadThreadInScope(req, res, req.params.id);
        if (!thread) return;
        const messages = await supportStore.getThreadMessages(thread.id, { includeInternal: true });
        res.json({ thread, messages });
    } catch (err) {
        console.error('[SupportInbox] GET /threads/:id error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Read-only customer context for the ticket sidebar (reuses the support read
// tools so staff see the same lookup data the AI can).
router.get('/threads/:id/context', async (req, res) => {
    try {
        const thread = await loadThreadInScope(req, res, req.params.id);
        if (!thread) return;
        const { executeSupportTool } = require('../integrations/supportTools');
        const ctx = { supportThreadId: thread.id };
        const [profile, organization, subscription, recent] = await Promise.all([
            executeSupportTool('support_get_requester_profile', {}, ctx).catch(() => null),
            executeSupportTool('support_get_organization_info', {}, ctx).catch(() => null),
            executeSupportTool('support_get_subscription_status', {}, ctx).catch(() => null),
            executeSupportTool('support_list_recent_threads_for_requester', { limit: 5 }, ctx).catch(() => []),
        ]);
        res.json({ profile, organization, subscription, recentThreads: Array.isArray(recent) ? recent : [] });
    } catch (err) {
        res.status(500).json({ error: 'Internal error' });
    }
});

// Per-ticket audit timeline — reads the unified audit log so AI / automation /
// staff / system / requester events are distinguished precisely (the legacy
// support_thread_events collapses ai/automation to 'system'). Newest-first.
router.get('/threads/:id/events', async (req, res) => {
    try {
        const thread = await loadThreadInScope(req, res, req.params.id);
        if (!thread) return;
        const { events } = await supportStore.listAuditEvents({ threadId: thread.id, limit: 200 });
        res.json({ events });
    } catch (err) {
        res.status(500).json({ error: 'Internal error' });
    }
});

// Staff reply — sends from the connected mailbox into the customer conversation.
router.post('/threads/:id/reply', async (req, res) => {
    try {
        const thread = await loadThreadInScope(req, res, req.params.id);
        if (!thread) return;
        const { body, bodyHtml, internalNote } = req.body;
        if (!body || !body.trim()) return res.status(400).json({ error: 'body required' });
        const userId = getUserId(req);
        const display = req.session?.user?.displayName || req.session?.user?.email || 'Support';

        // Internal note — staff-only, never delivered.
        if (internalNote) {
            const msg = await supportStore.appendMessage({
                threadId: thread.id, authorKind: 'staff', authorUserId: userId,
                authorDisplay: display, body, bodyHtml: bodyHtml || null, internalNote: true,
            });
            await supportStore.recordThreadEvent({ threadId: thread.id, actorUserId: userId, actorKind: 'staff', action: 'internal_note' });
            return res.json({ message: msg });
        }

        // Build threading headers from the latest inbound message.
        const msgs = await supportStore.getThreadMessages(thread.id, { includeInternal: false });
        const lastInbound = [...msgs].reverse().find(m => m.author_kind === 'requester');
        const inReplyTo = lastInbound?.rfc822_message_id || null;
        const references = [lastInbound?.email_references, lastInbound?.rfc822_message_id].filter(Boolean).join(' ').trim() || null;
        const sourceProviderMessageId = lastInbound?.provider_message_id || null;

        // Persist first (queued), then send, then mark sent/failed — so a send
        // failure leaves a visible message the agent can retry.
        const msg = await supportStore.appendMessage({
            threadId: thread.id, authorKind: 'staff', authorUserId: userId,
            authorDisplay: display, body, bodyHtml: bodyHtml || null,
            emailSendStatus: { state: 'queued' },
        });
        try {
            const sent = await supportMailer.sendReply(thread.inbox_id, thread, {
                bodyText: body, bodyHtml: bodyHtml || null, inReplyTo, references, sourceProviderMessageId,
            });
            await supportStore.setMessageDelivery(msg.id, {
                emailSendStatus: sent.status,
                rfc822MessageId: sent.rfc822MessageId || null,
                providerMessageId: sent.providerMessageId || null,
            });
            await supportStore.firstStaffReplyTransition(thread.id, userId);
            await supportStore.recordThreadEvent({ threadId: thread.id, actorUserId: userId, actorKind: 'staff', action: 'staff_reply', payload: { provider_message_id: sent.providerMessageId } });
            emitInboxEvent('thread_updated', thread.inbox_id, { threadId: thread.id });
            res.json({ message: { ...msg, email_send_status: sent.status } });
        } catch (sendErr) {
            console.error('[SupportInbox] send failed:', sendErr.message);
            await supportStore.setMessageEmailStatus(msg.id, { ok: false, error: sendErr.message, at: new Date().toISOString() });
            res.status(502).json({ error: `Reply saved but sending failed: ${sendErr.message}`, messageId: msg.id });
        }
    } catch (err) {
        console.error('[SupportInbox] POST /reply error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// AI draft — generate a KB-grounded draft (never sends), for the composer.
router.post('/threads/:id/draft', async (req, res) => {
    try {
        const thread = await loadThreadInScope(req, res, req.params.id);
        if (!thread) return;
        const inbox = await supportInboxStore.getInbox(thread.inbox_id);
        if (!inbox || !inbox.default_agent_id) {
            return res.status(400).json({ error: 'This inbox has no support agent configured.' });
        }
        const result = await runAiAutoResponder(thread.id, {
            config: { ...inboxToReplyConfig(inbox), replyMode: 'draft' },
        });
        emitInboxEvent('thread_updated', thread.inbox_id, { threadId: thread.id });
        res.json({ message: result?.message || null, escalated: !!result?.escalated });
    } catch (err) {
        console.error('[SupportInbox] POST /draft error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Update status / priority / assignee / category / tags.
router.patch('/threads/:id', async (req, res) => {
    try {
        const thread = await loadThreadInScope(req, res, req.params.id);
        if (!thread) return;
        const userId = getUserId(req);
        const { status, priority, assignee_user_id, category, tags, markNotSupport, unfilter } = req.body;
        const patch = {};
        if (status !== undefined) patch.status = status;
        if (priority !== undefined) patch.priority = priority;
        if (assignee_user_id !== undefined) patch.assignee_user_id = assignee_user_id;
        if (category !== undefined) patch.category = category;
        if (status === 'resolved' && thread.status !== 'resolved') patch.resolved_at = new Date().toISOString();
        let updated = thread;
        if (Object.keys(patch).length) updated = await supportStore.updateThread(thread.id, patch);
        if (Array.isArray(tags)) updated = await supportStore.setThreadTags(thread.id, tags);

        // ── Non-support routing: hide or restore a ticket (reversible, audited) ──
        const { NOT_SUPPORT_TAG } = require('../services/supportClassifier');
        if (markNotSupport === true) {
            updated = await supportStore.addThreadTag(thread.id, NOT_SUPPORT_TAG);
            await supportStore.recordThreadEvent({ threadId: thread.id, actorUserId: userId, actorKind: 'staff', action: 'marked_not_support' });
        }
        if (unfilter === true) {
            const current = Array.isArray(updated.tags) ? updated.tags : (Array.isArray(thread.tags) ? thread.tags : []);
            updated = await supportStore.setThreadTags(thread.id, current.filter(tg => tg !== NOT_SUPPORT_TAG));
            // Re-queue for a human (deliberately do NOT re-run the AI) + remember the sender.
            if (updated.status === 'open' || updated.status === 'closed') {
                updated = await supportStore.updateThread(thread.id, { status: 'awaiting_agent' });
            }
            const addr = String(thread.requester_email || '').toLowerCase().trim();
            if (addr) {
                const inbox = await supportInboxStore.getInbox(thread.inbox_id).catch(() => null);
                const list = Array.isArray(inbox?.known_good_senders) ? inbox.known_good_senders : [];
                if (!list.includes(addr)) {
                    await supportInboxStore.updateInbox(thread.inbox_id, { known_good_senders: [...list, addr] }, thread.organization_id).catch(() => {});
                }
            }
            await supportStore.recordThreadEvent({ threadId: thread.id, actorUserId: userId, actorKind: 'staff', action: 'restored_to_support' });
        }
        if (Object.keys(patch).length) {
            await supportStore.recordThreadEvent({ threadId: thread.id, actorUserId: userId, actorKind: 'staff', action: 'updated', payload: patch });
        }

        // On resolve, fire the internal automation trigger (fire-and-forget).
        if (status === 'resolved' && thread.status !== 'resolved') {
            _dispatchResolved(updated, userId).catch(() => {});
        }
        emitInboxEvent('thread_updated', thread.inbox_id, { threadId: thread.id });
        res.json({ thread: updated });
    } catch (err) {
        console.error('[SupportInbox] PATCH /threads error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Emit support.ticket.resolved into the automation trigger bus (org-scoped).
 * Carries a trimmed transcript so the KB-ingest template is self-contained.
 * Lazy-required + fully guarded so a missing dispatcher never breaks resolve.
 */
async function _dispatchResolved(thread, resolvedByUserId) {
    try {
        const { dispatchSupportEvent } = require('../automation/triggerBus');
        if (typeof dispatchSupportEvent !== 'function') return;
        const inbox = thread.inbox_id ? await supportInboxStore.getInbox(thread.inbox_id).catch(() => null) : null;
        const inboxAddress = inbox?.email_address || null;
        const msgs = await supportStore.getThreadMessages(thread.id, { includeInternal: false });
        // Only genuine customer conversations feed the KB (see supportTranscript).
        const { buildCustomerTranscript, evaluateGenuineContact } = require('../services/supportTranscript');
        const gate = evaluateGenuineContact(msgs, { inboxAddress, requesterEmail: thread.requester_email });
        if (!gate.genuine) {
            console.log('[SupportInbox] resolved ticket skipped KB dispatch — not genuine customer contact', { threadId: thread.id, gate });
            return;
        }
        const transcript = buildCustomerTranscript(msgs);
        if (!transcript || transcript.trim().length < 20) return;
        await dispatchSupportEvent('ticket.resolved', {
            threadId: thread.id, inboxId: thread.inbox_id || null,
            subject: thread.subject, category: thread.category || null,
            priority: thread.priority, tags: thread.tags || [],
            resolvedBy: resolvedByUserId ? 'staff' : 'ai',
            requesterEmail: thread.requester_email, messageCount: msgs.length,
            transcript, genuineContact: true,
        }, thread.organization_id || null);
    } catch (e) {
        console.warn('[SupportInbox] dispatchSupportEvent failed:', e.message);
    }
}

// ── Org-scoped helpers for the settings UI (canned / tags / sla / insights) ───

router.get('/canned', async (req, res) => {
    try {
        const scope = await resolveOrgScope(req);
        const out = [];
        for (const orgId of scope) out.push(...await supportStore.listCannedResponses(orgId));
        res.json({ canned: out });
    } catch (err) { res.status(500).json({ error: 'Internal error' }); }
});

router.get('/tags', async (req, res) => {
    try {
        const scope = await resolveOrgScope(req);
        const out = [];
        for (const orgId of scope) out.push(...await supportStore.listTags(orgId));
        res.json({ tags: out });
    } catch (err) { res.status(500).json({ error: 'Internal error' }); }
});

router.get('/insights', async (req, res) => {
    try {
        const inboxes = await access.accessibleInboxes(req);
        const inboxIds = inboxes.map(i => i.id);
        if (!inboxIds.length) return res.json({});
        const { NOT_SUPPORT_TAG } = require('../services/supportClassifier');
        const { inbox } = req.query;
        // Optional single-inbox scope (validated like GET /threads); insights
        // always exclude non-support tickets so the numbers reflect real support.
        let opts;
        if (inbox) {
            if (!inboxIds.includes(inbox)) return res.json({});
            opts = { inboxId: inbox };
        } else {
            opts = { inboxIdIn: inboxIds };
        }
        opts.excludeTags = [NOT_SUPPORT_TAG];
        const insights = await supportStore.getInsights(opts);
        res.json(insights);
    } catch (err) { res.status(500).json({ error: 'Internal error' }); }
});

// Eligible teammates for assignment (read-only) — powers the ticket assignee
// picker. Returns the union of in-scope orgs' support-capable staff with names.
router.get('/teammates', async (req, res) => {
    try {
        const scope = await resolveOrgScope(req);
        const { _eligibleStaffForOrg } = require('../services/supportAutoAssigner');
        const userStore = require('../stores/userStore');
        const seen = new Set();
        const out = [];
        for (const orgId of scope) {
            const ids = await _eligibleStaffForOrg(orgId).catch(() => []);
            for (const id of ids) {
                if (seen.has(id)) continue;
                seen.add(id);
                const u = await userStore.getUser(id).catch(() => null);
                out.push({
                    id,
                    name: u?.displayName || u?.display_name || u?.name || null,
                    email: u?.email || null,
                });
            }
        }
        res.json({ teammates: out });
    } catch (err) {
        console.error('[SupportInbox] GET /teammates error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Integrations the support AI can be GRANTED for this inbox — scoped to what
// the designated operator is actually entitled to (the same gate the compose
// path uses), so "give the AI the integrations that user has access to" is
// literal. The frontend joins these ids with its INTEGRATION_CATALOG for
// labels/icons. Pass ?operator=<userId> to preview a not-yet-saved choice.
router.get('/inboxes/:id/available-integrations', async (req, res) => {
    try {
        const inbox = await loadInboxInScope(req, res, req.params.id);
        if (!inbox) return;
        const operatorUserId = String(req.query.operator || inbox.operator_user_id || '').trim() || null;
        if (!operatorUserId) return res.json({ integrations: [], operatorUserId: null });

        const userStore = require('../stores/userStore');
        const { _eligibleStaffForOrg } = require('../services/supportAutoAssigner');
        const eligible = await _eligibleStaffForOrg(inbox.organization_id).catch(() => []);
        if (!Array.isArray(eligible) || !eligible.includes(operatorUserId)) {
            return res.status(400).json({ error: "Operator must be a member of this inbox's organisation." });
        }

        // Authoritative: the operator's resolved integration entitlement
        // (ceiling ∩ org grant ∩ per-group). Falls back to the org-admin active
        // list only if the resolver is unavailable.
        let effective = new Set();
        try {
            const entitlements = require('../core/entitlements');
            const snap = await entitlements.resolveEntitlements({ userId: operatorUserId, orgId: inbox.organization_id });
            if (snap && !snap.degraded && Array.isArray(snap.effective?.integration)) {
                effective = new Set(snap.effective.integration);
            }
        } catch (_) { /* fall through */ }
        if (!effective.size) {
            const active = await userStore.getOrgEnabledIntegrations(inbox.organization_id).catch(() => []);
            effective = new Set(Array.isArray(active) ? active : []);
        }

        // Only surface catalog integrations that actually expose agent tools,
        // and never Nextcloud (its own panel + connector own that surface).
        const { TOOL_REGISTRY } = require('../automation/toolRegistry');
        const toolApps = new Set(TOOL_REGISTRY.map(e => e.app));
        const ids = Array.from(effective)
            .filter(id => typeof id === 'string' && toolApps.has(id) && !id.startsWith('nextcloud'))
            .sort();
        res.json({ integrations: ids, operatorUserId });
    } catch (err) {
        console.error('[SupportInbox] GET /available-integrations error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ── SSE live updates (tenant inboxes only) ────────────────────────────────────

router.get('/stream', async (req, res) => {
    let listener = null, heartbeat = null, markEnded = () => {};
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return; cleaned = true;
        try { if (heartbeat) clearInterval(heartbeat); } catch {}
        try { if (listener) supportEvents.off('event', listener); } catch {}
        try { markEnded(); } catch {}
    };
    try {
        const inboxes = await access.accessibleInboxes(req);
        const inboxIds = new Set(inboxes.map(i => i.id));
        const sse = setupSSE(res);
        markEnded = sse.markEnded;
        sse.sendEvent('ready', { at: Date.now() });
        listener = ({ event, data }) => {
            // Only forward events for inboxes this caller can see.
            if (!data || !data.inboxId || !inboxIds.has(data.inboxId)) return;
            try { sse.sendEvent(event, { ...data, at: Date.now() }); } catch { cleanup(); }
        };
        supportEvents.on('event', listener);
        let pingFailures = 0;
        heartbeat = setInterval(() => {
            if (res.writableEnded) return cleanup();
            try { res.write(': ping\n\n'); pingFailures = 0; }
            catch { if (++pingFailures >= 3) cleanup(); }
        }, 25000);
        req.on('close', cleanup); req.on('error', cleanup); res.on('error', cleanup);
    } catch (err) {
        cleanup();
        if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
});

// ── Per-inbox grouped settings (single read for the tabbed settings UI) ───────

function inboxToSettings(inbox) {
    return {
        general: {
            display_name: inbox.display_name || '',
            provider: inbox.provider,
            email_address: inbox.email_address || null,
            connected: !!inbox.connected,
            default_agent_id: inbox.default_agent_id || null,
            kb_ids: Array.isArray(inbox.kb_ids) ? inbox.kb_ids : [],
        },
        ai: {
            reply_mode: inbox.reply_mode || 'draft',
            autoresolve_threshold: Number(inbox.autoresolve_threshold) || 0.78,
            signature: inbox.signature || '',
            enabled_tool_ids: Array.isArray(inbox.enabled_tool_ids) ? inbox.enabled_tool_ids : [],
            operator_user_id: inbox.operator_user_id || null,
        },
        classification: {
            classify_non_support_enabled: !!inbox.classify_non_support_enabled,
            classify_sensitivity: Number(inbox.classify_sensitivity) || 0.85,
            classify_suppress_autoreply: inbox.classify_suppress_autoreply !== false,
        },
        kbIngest: {
            enabled: !!inbox.kb_ingest_enabled,
            kb_id: inbox.kb_ingest_kb_id || null,
            routine_id: inbox.kb_ingest_routine_id || null,
        },
        access: {
            shared_groups: Array.isArray(inbox.shared_groups) ? inbox.shared_groups : [],
        },
        scan: {
            scan_status: inbox.scan_status,
            scan_result: inbox.scan_result || null,
        },
    };
}

router.get('/inboxes/:id/settings', async (req, res) => {
    try {
        const inbox = await loadInboxInScope(req, res, req.params.id);
        if (!inbox) return;
        res.json({ inbox, settings: inboxToSettings(inbox) });
    } catch (err) {
        console.error('[SupportInbox] GET /settings error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ── Per-inbox group access ────────────────────────────────────────────────────

// Resolve which support-capable members an access list grants the inbox to.
// Empty groups → all eligible org staff; non-empty → eligible staff in a granted
// group. Capped so a huge org never blows up the response.
async function _resolveAccessMembers(inbox, sharedGroups) {
    try {
        const userStore = require('../stores/userStore');
        const { _eligibleStaffForOrg } = require('../services/supportAutoAssigner');
        const eligible = await _eligibleStaffForOrg(inbox.organization_id).catch(() => []);
        let memberIds = Array.isArray(eligible) ? eligible : [];
        if (Array.isArray(sharedGroups) && sharedGroups.length) {
            const filtered = [];
            for (const id of memberIds) {
                const g = await access.userGroupsFor(id);
                if (g.some(x => sharedGroups.includes(x))) filtered.push(id);
            }
            memberIds = filtered;
        }
        const out = [];
        for (const id of memberIds.slice(0, 50)) {
            const u = await userStore.getUser(id).catch(() => null);
            out.push({ id, name: u?.displayName || u?.display_name || u?.name || null, email: u?.email || null });
        }
        return out;
    } catch { return []; }
}

router.get('/inboxes/:id/access', async (req, res) => {
    try {
        const inbox = await loadInboxInScope(req, res, req.params.id);
        if (!inbox) return;
        const userStore = require('../stores/userStore');
        const allGroups = await userStore.getAllGroups().catch(() => []);
        const availableGroups = (Array.isArray(allGroups) ? allGroups : [])
            .filter(g => g.organizationId === inbox.organization_id)
            .map(g => ({ id: g.id, name: g.name }));
        const sharedGroups = Array.isArray(inbox.shared_groups) ? inbox.shared_groups : [];
        const resolvedMembers = await _resolveAccessMembers(inbox, sharedGroups);
        res.json({
            mode: sharedGroups.length ? 'groups' : 'everyone',
            sharedGroups, availableGroups, resolvedMembers,
        });
    } catch (err) {
        console.error('[SupportInbox] GET /access error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

router.put('/inboxes/:id/access', async (req, res) => {
    try {
        const inbox = await loadInboxInScope(req, res, req.params.id);
        if (!inbox) return;
        // Only org admins (or super admins / the inbox owner) may change access —
        // org admins always pass loadInboxInScope, so an inbox can't be locked
        // away from its own org's admins.
        const isOrgAdmin = await access.resolveIsOrgAdmin(req);
        const { orgIds } = await access.resolveOrgScope(req);
        const isOwner = inbox.created_by && inbox.created_by === getUserId(req);
        if (!(isOrgAdmin || orgIds === null || isOwner)) {
            return res.status(403).json({ error: 'Only an organisation admin can change inbox access.' });
        }
        let groups;
        try {
            groups = await validateSharedGroupsForOrg(inbox.organization_id, req.body.sharedGroups || []);
        } catch (err) {
            return res.status(err.status || 400).json({ error: err.message });
        }
        const updated = await supportInboxStore.setSharedGroups(req.params.id, groups || [], inbox.organization_id);
        audit.emit(req, { organizationId: inbox.organization_id, inboxId: inbox.id, action: 'inbox_access_changed', payload: { sharedGroups: groups || [] } });
        const resolvedMembers = await _resolveAccessMembers(updated, updated.shared_groups || []);
        res.json({
            mode: (groups && groups.length) ? 'groups' : 'everyone',
            sharedGroups: updated.shared_groups || [], resolvedMembers, inbox: updated,
        });
    } catch (err) {
        console.error('[SupportInbox] PUT /access error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Audit feed ────────────────────────────────────────────────────────────────

router.get('/inboxes/:id/audit', async (req, res) => {
    try {
        const inbox = await loadInboxInScope(req, res, req.params.id);
        if (!inbox) return;
        const { actor, action, from, to, cursor, limit } = req.query;
        const out = await supportStore.listAuditEvents({
            inboxId: inbox.id,
            actorKind: actor || undefined, action: action || undefined,
            since: from || undefined, until: to || undefined,
            cursor: cursor || undefined, limit: limit ? parseInt(limit, 10) : 50,
        });
        res.json(out);
    } catch (err) {
        console.error('[SupportInbox] GET /inboxes/:id/audit error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Org-wide audit feed. Restricted to the caller's accessible inboxes plus
// config events (inbox_id IS NULL) within their org scope — a forbidden inbox's
// events can never leak here.
router.get('/audit', async (req, res) => {
    try {
        const inboxes = await access.accessibleInboxes(req);
        const inboxIds = inboxes.map(i => i.id);
        const { scope } = await access.resolveOrgScope(req);
        const { inbox, actor, action, from, to, cursor, limit } = req.query;
        let inboxIdIn = inboxIds;
        if (inbox) {
            if (!inboxIds.includes(inbox)) return res.json({ events: [], nextCursor: null });
            inboxIdIn = [inbox];
        }
        const out = await supportStore.listAuditEvents({
            organizationIdIn: scope,
            inboxIdIn,
            actorKind: actor || undefined, action: action || undefined,
            since: from || undefined, until: to || undefined,
            cursor: cursor || undefined, limit: limit ? parseInt(limit, 10) : 50,
        });
        res.json(out);
    } catch (err) {
        console.error('[SupportInbox] GET /audit error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ── Org-scoped Templates & SLA writes (tenant-owned) ──────────────────────────
// The tenant Support studio owns its own tag taxonomy, canned replies and SLA
// policies. (Reads live on GET /tags, /canned, /sla-policies; the super-admin
// /api/support/* namespace is for Bee Flow's own company inbox only.)

async function _firstWritableOrg(req) {
    const { scope } = await access.resolveOrgScope(req);
    return scope[0] || null;
}

router.post('/tags', async (req, res) => {
    try {
        const orgId = await _firstWritableOrg(req);
        if (!orgId) return res.status(403).json({ error: 'No organisation in scope' });
        const { name, color, description } = req.body || {};
        if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
        const tag = await supportStore.createTag({ organizationId: orgId, name: name.trim(), color: color || null, description: description || null });
        audit.emit(req, { organizationId: orgId, action: 'tag_created', payload: { name: tag.name } });
        res.json({ tag });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/tags/:id', async (req, res) => {
    try {
        const orgId = await _firstWritableOrg(req);
        if (!orgId) return res.status(403).json({ error: 'No organisation in scope' });
        await supportStore.deleteTag(req.params.id, orgId);
        audit.emit(req, { organizationId: orgId, action: 'tag_deleted', payload: { id: req.params.id } });
        res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/canned', async (req, res) => {
    try {
        const orgId = await _firstWritableOrg(req);
        if (!orgId) return res.status(403).json({ error: 'No organisation in scope' });
        const { title, body, shortcut } = req.body || {};
        const canned = await supportStore.createCannedResponse({ organizationId: orgId, title, body, shortcut: shortcut || null, createdBy: getUserId(req) });
        audit.emit(req, { organizationId: orgId, action: 'canned_created', payload: { id: canned.id, title: canned.title } });
        res.json({ canned });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/canned/:id', async (req, res) => {
    try {
        const orgId = await _firstWritableOrg(req);
        if (!orgId) return res.status(403).json({ error: 'No organisation in scope' });
        const { title, body, shortcut } = req.body || {};
        const canned = await supportStore.updateCannedResponse(req.params.id, { title, body, shortcut }, orgId);
        if (!canned) return res.status(404).json({ error: 'Canned response not found' });
        audit.emit(req, { organizationId: orgId, action: 'canned_updated', payload: { id: req.params.id } });
        res.json({ canned });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/canned/:id', async (req, res) => {
    try {
        const orgId = await _firstWritableOrg(req);
        if (!orgId) return res.status(403).json({ error: 'No organisation in scope' });
        await supportStore.deleteCannedResponse(req.params.id, orgId);
        audit.emit(req, { organizationId: orgId, action: 'canned_deleted', payload: { id: req.params.id } });
        res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/sla-policies', async (req, res) => {
    try {
        const { scope } = await access.resolveOrgScope(req);
        const orgId = scope[0] || null;
        const policies = await supportStore.listSlaPolicies(orgId);
        res.json({ policies });
    } catch (err) { res.status(500).json({ error: 'Internal error' }); }
});

router.put('/sla-policies', async (req, res) => {
    try {
        const orgId = await _firstWritableOrg(req);
        if (!orgId) return res.status(403).json({ error: 'No organisation in scope' });
        const { priority, firstResponseMinutes, resolutionMinutes, enabled } = req.body || {};
        const policy = await supportStore.upsertSlaPolicy({
            organizationId: orgId, priority,
            firstResponseMinutes: parseInt(firstResponseMinutes, 10),
            resolutionMinutes: parseInt(resolutionMinutes, 10),
            enabled: enabled !== false,
        });
        audit.emit(req, { organizationId: orgId, action: 'sla_policy_changed', payload: { priority } });
        res.json({ policy });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
