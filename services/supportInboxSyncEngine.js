/**
 * Support Inbox Sync Engine — turns inbound mailbox email into support tickets.
 *
 * Polls each connected, active support_inboxes row, fetches new messages
 * (Gmail / Microsoft Graph), threads them into support_threads/support_messages,
 * and kicks the per-inbox AI responder. Auto-send reply modes are delivered
 * back out through supportMailer.
 *
 * Safety:
 *   - Idempotent: a provider message is recorded at most once per thread (unique
 *     index uq_support_messages_provider_msg + ON CONFLICT DO NOTHING).
 *   - Loop/bounce-safe: auto-replies, mailing lists, bounces and self-sent mail
 *     are skipped before any ticket is created.
 *   - Per-inbox row-level lock so the tick and a manual sync never double-run.
 *
 * Distinct from ticketAssistantSyncEngine (which ingests into a KB). Shares only
 * the low-level provider helpers in services/email/.
 */

const supportInboxStore = require('../stores/supportInboxStore');
const supportStore = require('../stores/supportStore');
const { gmailClientFromTokens, graphFetchFromTokens } = require('./email/providerClients');
const parse = require('./email/parse');
const supportMailer = require('./supportMailer');
const { runAiAutoResponder } = require('./supportAiResponder');

const TICK_INTERVAL_MS = parseInt(process.env.SUPPORT_INBOX_TICK_MS || '90000', 10);
const MAX_CONCURRENT = parseInt(process.env.SUPPORT_INBOX_MAX_CONCURRENT || '3', 10);
const MAX_PER_TICK = parseInt(process.env.SUPPORT_INBOX_MAX_PER_TICK || '25', 10);
const LOOKBACK_OVERLAP_MS = 5 * 60 * 1000; // re-scan window; dedupe makes it safe

let _timer = null;
let _emitEvent = null; // injected lazily to avoid a require cycle with routes/support

function _emit(event, inboxId, data = {}) {
    try {
        if (!_emitEvent) {
            const { supportEvents } = require('../routes/support');
            _emitEvent = (e, d) => supportEvents.emit('event', { event: e, data: d });
        }
        _emitEvent(event, { ...data, inboxId });
    } catch { /* never block sync on the event bus */ }
}

function startSupportInboxSync() {
    if (_timer) return;
    const run = () => { tickOnce().catch(e => console.error('[SupportInboxSync] tick error:', e.message)); };
    _timer = setInterval(run, TICK_INTERVAL_MS);
    if (_timer.unref) _timer.unref();
    setTimeout(run, 12000).unref?.();
    console.log(`[SupportInboxSync] started (interval=${TICK_INTERVAL_MS}ms)`);
}

function stopSupportInboxSync() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

async function tickOnce() {
    const due = await supportInboxStore.getDueInboxes();
    if (!due.length) return { processed: 0 };
    let idx = 0;
    let total = 0;
    const worker = async () => {
        while (idx < due.length) {
            const row = due[idx++];
            try { total += await syncOneInbox(row); }
            catch (e) { console.warn(`[SupportInboxSync] inbox ${row.id}:`, e.message); }
        }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, due.length) }, worker));
    return { processed: total };
}

async function syncOneInbox(inboxRow) {
    const lock = await supportInboxStore.acquireSyncLock(inboxRow.id, 10);
    if (!lock.acquired) return 0;
    let count = 0;
    try {
        await supportInboxStore.updateSyncState(inboxRow.id, { syncStatus: 'syncing' });
        const inbox = await supportInboxStore.getInboxWithTokens(inboxRow.id);
        if (!inbox || !inbox.tokens || !inbox.tokens.accessToken) {
            throw new Error('mailbox not connected (no tokens)');
        }
        const onRefresh = (t) => supportInboxStore.updateTokens(inbox.id, t).catch(() => {});
        if (inbox.provider === 'gmail') count = await syncGmail(inbox, onRefresh);
        else if (inbox.provider === 'outlook') count = await syncOutlook(inbox, onRefresh);
        await supportInboxStore.updateSyncState(inbox.id, { syncStatus: 'idle', syncError: null, lastSyncAt: new Date().toISOString() });
    } catch (e) {
        await supportInboxStore.updateSyncState(inboxRow.id, { syncStatus: 'error', syncError: String(e.message).slice(0, 500), lastSyncAt: new Date().toISOString() });
    } finally {
        await supportInboxStore.releaseSyncLock(inboxRow.id);
    }
    return count;
}

function _sinceDate(inbox) {
    const base = inbox.last_sync_at ? new Date(inbox.last_sync_at).getTime() - LOOKBACK_OVERLAP_MS
        : (inbox.sync_after ? new Date(inbox.sync_after).getTime() : Date.now() - 24 * 3600 * 1000);
    return new Date(base);
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

async function syncGmail(inbox, onRefresh) {
    const gmail = await gmailClientFromTokens(inbox.tokens, onRefresh);
    const since = _sinceDate(inbox);
    const after = since.toISOString().split('T')[0].replace(/-/g, '/');
    const list = await gmail.users.messages.list({
        userId: 'me', q: `after:${after} -in:chats -in:sent`, labelIds: ['INBOX'], maxResults: MAX_PER_TICK,
    });
    const ids = (list.data.messages || []).map(m => m.id).reverse(); // oldest first
    let processed = 0;
    for (const id of ids) {
        try {
            const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
            if (await ingestGmail(inbox, full.data)) processed++;
        } catch (e) {
            console.warn(`[SupportInboxSync] gmail msg ${id}:`, e.message);
        }
    }
    return processed;
}

async function ingestGmail(inbox, msg) {
    const labels = msg.labelIds || [];
    if (labels.includes('SENT') || labels.includes('DRAFT')) return false; // our own / drafts
    const headers = msg.payload?.headers || [];
    const getHeader = (n) => parse.getGmailHeader(headers, n);
    const fromAddress = parse.parseAddress(getHeader('From'));
    const auto = parse.detectAutoOrBulk(getHeader, { fromAddress, inboxAddress: inbox.email_address });
    if (auto.skip) return false;
    const { text, html } = parse.extractGmailBodies(msg.payload);
    const normalized = {
        providerMessageId: msg.id,
        providerThreadId: msg.threadId || null,
        rfc822MessageId: getHeader('Message-ID') || getHeader('Message-Id') || null,
        inReplyTo: getHeader('In-Reply-To') || null,
        references: parse.splitMessageIds(getHeader('References')),
        from: fromAddress || 'unknown@unknown.invalid',
        fromName: parse.parseDisplayName(getHeader('From')),
        subject: getHeader('Subject') || '(no subject)',
        text, html,
        attachments: extractGmailAttachmentMeta(msg.payload),
    };
    return ingestNormalized(inbox, normalized);
}

function extractGmailAttachmentMeta(payload, acc = []) {
    if (!payload) return acc;
    if (payload.filename && payload.body?.attachmentId) {
        acc.push({ filename: payload.filename, mimeType: payload.mimeType || '', size: payload.body.size || 0, providerAttachmentId: payload.body.attachmentId });
    }
    if (Array.isArray(payload.parts)) payload.parts.forEach(p => extractGmailAttachmentMeta(p, acc));
    return acc;
}

// ── Outlook / Graph ───────────────────────────────────────────────────────────

async function syncOutlook(inbox, onRefresh) {
    const since = _sinceDate(inbox).toISOString();
    const select = 'id,conversationId,internetMessageId,subject,from,receivedDateTime,bodyPreview,body,hasAttachments';
    const path = `/me/mailFolders/Inbox/messages?$select=${encodeURIComponent(select)}`
        + `&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`
        + `&$orderby=${encodeURIComponent('receivedDateTime asc')}&$top=${MAX_PER_TICK}`;
    const data = await graphFetchFromTokens(inbox.tokens, onRefresh, path);
    const items = data.value || [];
    let processed = 0;
    for (const m of items) {
        try { if (await ingestOutlook(inbox, m)) processed++; }
        catch (e) { console.warn(`[SupportInboxSync] graph msg ${m.id}:`, e.message); }
    }
    return processed;
}

async function ingestOutlook(inbox, m) {
    const fromAddress = (m.from?.emailAddress?.address || '').toLowerCase();
    // Graph doesn't surface raw internet headers cheaply; use what we have.
    const getHeader = (n) => {
        const key = String(n).toLowerCase();
        if (key === 'from') return m.from?.emailAddress?.address || '';
        return '';
    };
    const auto = parse.detectAutoOrBulk(getHeader, { fromAddress, inboxAddress: inbox.email_address });
    if (auto.skip) return false;
    const html = m.body?.contentType === 'html' ? (m.body?.content || '') : '';
    const text = m.body?.contentType === 'text' ? (m.body?.content || '') : (m.bodyPreview || '');
    const normalized = {
        providerMessageId: m.id,
        providerThreadId: m.conversationId || null,
        rfc822MessageId: m.internetMessageId || null,
        inReplyTo: null,
        references: [],
        from: fromAddress || 'unknown@unknown.invalid',
        fromName: m.from?.emailAddress?.name || '',
        subject: m.subject || '(no subject)',
        text, html,
        attachments: m.hasAttachments ? [{ note: 'has attachments' }] : [],
    };
    return ingestNormalized(inbox, normalized);
}

// ── Shared: normalized inbound → ticket ───────────────────────────────────────

async function ingestNormalized(inbox, n) {
    // Thread resolution (org+inbox scoped): reply-correlation → provider thread → new.
    let thread = null;
    const refIds = [n.inReplyTo, ...(n.references || [])].filter(Boolean);
    if (refIds.length) thread = await supportStore.findThreadByRfcMessageId(inbox.id, refIds);
    if (!thread && n.providerThreadId) thread = await supportStore.findThreadByProviderThread(inbox.id, n.providerThreadId);

    let isNew = false;
    if (!thread) {
        thread = await supportStore.createThread({
            organizationId: inbox.organization_id,
            requesterEmail: n.from,
            requesterName: n.fromName || null,
            source: 'email',
            subject: n.subject,
            inboxId: inbox.id,
            rfc822MessageId: n.rfc822MessageId,
            providerThreadId: n.providerThreadId,
        });
        isNew = true;
        try {
            const { computeSlaDueAt } = require('./supportSlaEnforcer');
            const due = await computeSlaDueAt(thread);
            if (due && (due.first || due.resolution)) {
                await supportStore.setThreadSla(thread.id, { firstDueAt: due.first, resolutionDueAt: due.resolution });
            }
        } catch { /* SLA is best-effort */ }
    }

    const bodyText = n.text || supportMailer.htmlToText(n.html) || '(no content)';
    const appended = await supportStore.appendMessage({
        threadId: thread.id,
        authorKind: 'requester',
        authorDisplay: n.fromName || n.from,
        body: bodyText,
        bodyHtml: n.html || null,
        rfc822MessageId: n.rfc822MessageId,
        inReplyTo: n.inReplyTo,
        emailReferences: (n.references || []).join(' ') || null,
        providerMessageId: n.providerMessageId,
        attachments: n.attachments || [],
    });
    if (!appended) return false; // duplicate (already ingested) — no-op

    if (!isNew) {
        // A new inbound message always returns the ticket to the agent queue.
        // If it was resolved/closed, the customer's reply REOPENS it (clear the
        // resolution timestamp + audit), so an autonomously-closed ticket comes
        // back to life when the customer writes again.
        const wasClosed = thread.status === 'resolved' || thread.status === 'closed';
        await supportStore.updateThread(thread.id, wasClosed
            ? { status: 'awaiting_agent', resolved_at: null }
            : { status: 'awaiting_agent' });
        if (wasClosed) {
            await supportStore.recordThreadEvent({
                threadId: thread.id, actorKind: 'requester', action: 'reopened',
                payload: { from: thread.status },
            }).catch(() => {});
        }
    }
    _emit(isNew ? 'thread_created' : 'thread_updated', inbox.id, { threadId: thread.id });

    // Per-inbox AI responder (fire-and-forget; delivery handled below).
    triggerAi(inbox, thread).catch(e => console.warn('[SupportInboxSync] AI trigger failed:', e.message));
    return true;
}

async function triggerAi(inbox, thread) {
    if (!inbox.default_agent_id) return; // no agent → stays awaiting_agent for a human
    const cfg = {
        agentId: inbox.default_agent_id,
        kbIds: Array.isArray(inbox.kb_ids) ? inbox.kb_ids : [],
        replyMode: inbox.reply_mode || 'draft',
        autoresolveThreshold: Number(inbox.autoresolve_threshold) || 0.78,
        v2Enabled: !!inbox.tools_enabled,
        toolsEnabled: !!inbox.tools_enabled,
    };
    const result = await runAiAutoResponder(thread.id, { config: cfg });
    _emit('thread_updated', inbox.id, { threadId: thread.id });
    // Deliver only when the responder signalled an auto-send (auto_confident /
    // autonomous, non-escalated). 'draft' mode returns sent:false → human sends.
    if (result && result.sent && result.message) {
        await deliverAiReply(inbox, thread.id, result.message);
    }
    // AI auto-resolved the ticket → fire the resolved trigger (the responder
    // transitioned status without going through the route, so dispatch here).
    if (result && result.resolved) {
        dispatchResolved(inbox, thread.id).catch(() => {});
    }
}

/** Fire support.ticket.resolved into the automation bus (org-scoped). Guarded. */
async function dispatchResolved(inbox, threadId) {
    try {
        const { dispatchSupportEvent } = require('../automation/triggerBus');
        if (typeof dispatchSupportEvent !== 'function') return;
        const thread = await supportStore.getThread(threadId);
        if (!thread) return;
        const msgs = await supportStore.getThreadMessages(threadId, { includeInternal: false });
        // Only genuine customer conversations feed the KB (see supportTranscript).
        const { buildCustomerTranscript, evaluateGenuineContact } = require('./supportTranscript');
        const gate = evaluateGenuineContact(msgs, { inboxAddress: inbox.email_address, requesterEmail: thread.requester_email });
        if (!gate.genuine) {
            console.log('[SupportInboxSync] AI-resolved ticket skipped KB dispatch — not genuine customer contact', { threadId, gate });
            return;
        }
        const transcript = buildCustomerTranscript(msgs);
        if (!transcript || transcript.trim().length < 20) return;
        await dispatchSupportEvent('ticket.resolved', {
            threadId: thread.id, inboxId: thread.inbox_id || null, subject: thread.subject,
            category: thread.category || null, priority: thread.priority, tags: thread.tags || [],
            resolvedBy: 'ai', requesterEmail: thread.requester_email, messageCount: msgs.length,
            transcript, genuineContact: true,
        }, thread.organization_id || null);
    } catch (e) {
        console.warn('[SupportInboxSync] dispatchResolved failed:', e.message);
    }
}

async function deliverAiReply(inbox, threadId, message) {
    const fresh = await supportStore.getThread(threadId);
    const msgs = await supportStore.getThreadMessages(threadId, { includeInternal: false });
    const lastInbound = [...msgs].reverse().find(m => m.author_kind === 'requester');
    const inReplyTo = lastInbound?.rfc822_message_id || null;
    const references = [lastInbound?.email_references, lastInbound?.rfc822_message_id].filter(Boolean).join(' ').trim() || null;
    const sourceProviderMessageId = lastInbound?.provider_message_id || null;
    try {
        const sent = await supportMailer.sendReply(inbox.id, fresh, {
            bodyText: message.body, inReplyTo, references, sourceProviderMessageId,
            isAiReply: true, // automatic AI send → append the AI-disclosure footer
        });
        await supportStore.setMessageDelivery(message.id, {
            emailSendStatus: sent.status,
            rfc822MessageId: sent.rfc822MessageId || null,
            providerMessageId: sent.providerMessageId || null,
        });
    } catch (e) {
        console.error('[SupportInboxSync] AI auto-send failed:', e.message);
        await supportStore.setMessageEmailStatus(message.id, { ok: false, error: e.message, at: new Date().toISOString() });
    }
}

module.exports = { startSupportInboxSync, stopSupportInboxSync, tickOnce, syncOneInbox, deliverAiReply };
