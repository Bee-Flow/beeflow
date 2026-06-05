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
const { resolveUserOrgIds, hasPermission } = require('../auth/permissions');
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

// Resolve + scope-check an inbox; returns the public row or sends 403/404.
async function loadInboxInScope(req, res, id, { withTokens = false } = {}) {
    const scope = await resolveOrgScope(req);
    const inbox = withTokens
        ? await supportInboxStore.getInboxWithTokens(id)
        : await supportInboxStore.getInbox(id);
    if (!inbox) { res.status(404).json({ error: 'Inbox not found' }); return null; }
    if (!scope.includes(inbox.organization_id)) { res.status(403).json({ error: 'Forbidden' }); return null; }
    return inbox;
}

// Resolve + scope-check a thread (must be a tenant inbox thread in scope).
async function loadThreadInScope(req, res, id) {
    const scope = await resolveOrgScope(req);
    const thread = await supportStore.getThread(id);
    if (!thread || !thread.inbox_id) { res.status(404).json({ error: 'Ticket not found' }); return null; }
    if (!scope.includes(thread.organization_id)) { res.status(403).json({ error: 'Forbidden' }); return null; }
    return thread;
}

// ── Inbox CRUD ────────────────────────────────────────────────────────────────

router.get('/inboxes', async (req, res) => {
    try {
        const scope = await resolveOrgScope(req);
        const all = [];
        for (const orgId of scope) all.push(...await supportInboxStore.listInboxes(orgId));
        res.json({ inboxes: all });
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
        const updated = await supportInboxStore.updateInbox(req.params.id, req.body, inbox.organization_id);
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
        res.json({ inbox: updated, routineId: provisioned.routineId, warnings: provisioned.warnings || [] });
    } catch (err) {
        console.error('[SupportInbox] PUT /kb-automation error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── OAuth connect (dedicated per-mailbox flow — NOT the login OAuth) ──────────

function redirectUriFor(req) {
    return `${req.protocol}://${req.get('host')}/api/support-inbox/oauth/callback`;
}

router.get('/inboxes/:id/oauth/start', async (req, res) => {
    try {
        const inbox = await loadInboxInScope(req, res, req.params.id);
        if (!inbox) return;
        const state = crypto.randomBytes(24).toString('hex');
        req.session.supportMailbox = {
            state, inboxId: inbox.id, orgId: inbox.organization_id, provider: inbox.provider, ts: Date.now(),
        };
        const url = await providerClients.buildAuthUrl(inbox.provider, { redirectUri: redirectUriFor(req), state });
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

router.get('/oauth/callback', async (req, res) => {
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
            code, redirectUri: redirectUriFor(req),
        });
        await supportInboxStore.updateTokens(sess.inboxId, tokens, { emailAddress });
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
        const scope = await resolveOrgScope(req);
        const inboxes = [];
        for (const orgId of scope) inboxes.push(...await supportInboxStore.listInboxes(orgId));
        let inboxIds = inboxes.map(i => i.id);
        const { inbox, status, q, assignee, limit, offset } = req.query;
        if (inbox) {
            if (!inboxIds.includes(inbox)) return res.json({ threads: [], counts: {} });
            inboxIds = [inbox];
        }
        if (!inboxIds.length) return res.json({ threads: [], counts: {} });
        const statusList = status ? status.split(',').map(s => s.trim()).filter(Boolean) : null;
        const threads = await supportStore.listThreads({
            inboxIdIn: inboxIds,
            statusIn: statusList && statusList.length ? statusList : null,
            q: q || null,
            assigneeUserId: assignee || null,
            limit: limit ? parseInt(limit, 10) : 100,
            offset: offset ? parseInt(offset, 10) : 0,
        });
        const counts = await supportStore.countThreadsByStatus({ inboxIdIn: inboxIds });
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

router.get('/threads/:id/events', async (req, res) => {
    try {
        const thread = await loadThreadInScope(req, res, req.params.id);
        if (!thread) return;
        const events = await supportStore.listThreadEvents(thread.id);
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
        const { status, priority, assignee_user_id, category, tags } = req.body;
        const patch = {};
        if (status !== undefined) patch.status = status;
        if (priority !== undefined) patch.priority = priority;
        if (assignee_user_id !== undefined) patch.assignee_user_id = assignee_user_id;
        if (category !== undefined) patch.category = category;
        if (status === 'resolved' && thread.status !== 'resolved') patch.resolved_at = new Date().toISOString();
        let updated = thread;
        if (Object.keys(patch).length) updated = await supportStore.updateThread(thread.id, patch);
        if (Array.isArray(tags)) updated = await supportStore.setThreadTags(thread.id, tags);
        await supportStore.recordThreadEvent({ threadId: thread.id, actorUserId: userId, actorKind: 'staff', action: 'updated', payload: patch });

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
        const scope = await resolveOrgScope(req);
        const inboxes = [];
        for (const orgId of scope) inboxes.push(...await supportInboxStore.listInboxes(orgId));
        const inboxIds = inboxes.map(i => i.id);
        if (!inboxIds.length) return res.json({});
        const insights = await supportStore.getInsights({ inboxIdIn: inboxIds });
        res.json(insights);
    } catch (err) { res.status(500).json({ error: 'Internal error' }); }
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
        const scope = await resolveOrgScope(req);
        const inboxes = [];
        for (const orgId of scope) inboxes.push(...await supportInboxStore.listInboxes(orgId));
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

module.exports = router;
