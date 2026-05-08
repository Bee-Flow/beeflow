/**
 * Ticket Assistant Sync Engine — Background polling service
 *
 * Periodically syncs connected ticket sources (gmail, outlook, jira,
 * servicenow, zendesk, freshservice, topdesk), processes new items through
 * the AI pipeline, and ingests them into the knowledge base.
 *
 * Architecture:
 *   - Cron tick every 5 minutes
 *   - Picks connections where sync is due (based on sync_interval_minutes)
 *   - Max 3 concurrent syncs to avoid AI pipeline overload
 *   - Uses existing provider tooling (Gmail/Outlook/ticket-provider modules)
 *   - Uses existing KB ingestion pipeline for storage
 */

const EventEmitter = require('events');
const ticketAssistantStore = require('../stores/ticketAssistantStore');
const {
    processEmail,
    processEmailThread,
    mergeArticlesByCategory,
    buildPerEmailArticle,
    prepareEmailForLLM,
    assembleProcessedEmail,
    summarizeAndCategorize,
    summarizeAndCategorizeBatch,
    cleanEmail,
    redactPIIWithCounts,
} = require('../core/ticketAssistantProcessor');
const { ingestDocument, findDocumentBySourceUri, deleteDocumentChunks } = require('../core/kbIngestionHelpers');
const { extractGmailAttachments, extractOutlookAttachments, formatAttachmentsMarkdown } = require('../core/ticketAssistantAttachments');
const metrics = require('../core/ticketAssistantMetrics');

const { run } = require('../db');

const MAX_CONCURRENT = 3;
const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_EMAILS_PER_SYNC = 50;
const SYNC_TIMEOUT_MINUTES = 30;
const MAX_RETRIES = 2;             // generic transient-error retries (linear backoff)
const RETRY_DELAY_MS = 5000;
const MAX_429_RETRIES = 5;         // exponential backoff + jitter for rate limits
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 60_000;

/**
 * Extract Retry-After hint from a provider error (Gmail/Graph).
 * Supports header-style seconds or HTTP-date. Returns ms, or null.
 */
function parseRetryAfter(err) {
    const h = err?.response?.headers?.['retry-after']
        || err?.response?.headers?.get?.('retry-after')
        || err?.headers?.['retry-after'];
    if (!h) return null;
    const asSeconds = parseInt(String(h), 10);
    if (!Number.isNaN(asSeconds) && asSeconds >= 0) return Math.min(BACKOFF_MAX_MS, asSeconds * 1000);
    const asDate = Date.parse(String(h));
    if (!Number.isNaN(asDate)) return Math.max(0, Math.min(BACKOFF_MAX_MS, asDate - Date.now()));
    return null;
}

let tickTimer = null;
let isRunning = false;

// ──────────────────────────────────────────────
// Per-connection event bus (consumed by SSE route /connections/:id/sync/stream)
// Events emitted per connectionId:
//   sync_started   { connectionId, startedAt, totalEstimate? }
//   sync_progress  { processed, total, lastSubject, lastOutcome }
//   email_processed { bucket, detail }
//   sync_completed { stats }
// ──────────────────────────────────────────────
const syncEvents = new EventEmitter();
syncEvents.setMaxListeners(0); // many tabs may subscribe to the same connection

function emitSyncEvent(connectionId, event, data) {
    if (!connectionId) return;
    syncEvents.emit(connectionId, { event, data, at: new Date().toISOString() });
}

function subscribeSyncEvents(connectionId, handler) {
    syncEvents.on(connectionId, handler);
    return () => syncEvents.off(connectionId, handler);
}

/**
 * Build per-stage process options from connection's pipeline_config.
 */
function buildProcessOptions(connection) {
    const pc = connection.pipeline_config || {};
    return {
        orgId: connection.organization_id,
        senderBlacklist: connection.sender_blacklist || [],
        redactPII: connection.redact_pii !== false,
        language: pc.language || '',
        articleModelTier: pc.article?.modelTier || 'fast',
        articlePrompt: pc.article?.systemPrompt || connection.ai_system_prompt || '',
        categoryModelTier: pc.category?.modelTier || 'fast',
        categoryPrompt: pc.category?.systemPrompt || '',
    };
}

function buildMergeOptions(connection) {
    const pc = connection.pipeline_config || {};
    return {
        orgId: connection.organization_id,
        redactPII: connection.redact_pii !== false,
        modelTier: pc.merge?.modelTier || 'fast',
        // `customPrompt` is kept as a back-compat alias for the chunk-write
        // prompt — older callers that only know the single-pass merge use it.
        customPrompt: pc.merge?.systemPrompt || '',
        // Chunked-merge overrides (optional; fall back to `modelTier` / `customPrompt`).
        chunkWriteModelTier: pc.merge?.chunkWriteModelTier,
        chunkWriteSystemPrompt: pc.merge?.systemPrompt || '',
        dedupeModelTier: pc.dedupe?.modelTier,
        dedupeSystemPrompt: pc.dedupe?.systemPrompt || '',
        language: pc.language || '',
    };
}

/**
 * Pick sensible concurrency + batch size from pipeline_config.
 *
 * Defaults by model tier for the article stage:
 *   - fast           → concurrency 8  (provider tolerates high fan-out)
 *   - thinking/writer → concurrency 5
 *   - deep_thinking  → concurrency 3  (expensive, throttles fast)
 *
 * `batch_size` is opt-in (default 1 = one email per LLM call). When > 1,
 * multiple emails are sent in a single fused prompt — see
 * summarizeAndCategorizeBatch in ticketAssistantProcessor.js.
 */
function resolveParallelism(connection) {
    const art = connection.pipeline_config?.article || {};
    const tier = art.modelTier || 'fast';
    const tierDefault = tier === 'deep_thinking' ? 3 : tier === 'fast' ? 8 : 5;
    const concurrency = Math.max(1, Math.min(10, art.concurrency || tierDefault));
    const batchSize = Math.max(1, Math.min(5, art.batch_size || 1));
    return { concurrency, batchSize };
}

/**
 * Which ingestion mode is this connection using?
 *   - 'per_email'      → each email becomes its own KB doc, body preserved verbatim,
 *                        metadata header (From/To/Date/Subject/Message-Id) inside content.
 *                        Best retrieval signal. Default for connections created after this change.
 *   - 'category_merge' → emails AI-rewritten + merged into one doc per category.
 *                        Kept for backwards-compat with existing setups.
 */
function getIngestionMode(connection) {
    const mode = connection.pipeline_config?.ingestion_mode;
    if (mode === 'per_email' || mode === 'category_merge') return mode;
    // Older connections without the key fall back to legacy behaviour so we
    // don't silently rewrite their KB on next sync. New connections should set
    // pipeline_config.ingestion_mode = 'per_email' via ticketAssistantStore defaults.
    return 'category_merge';
}

/**
 * Run an async mapper across `items` with a concurrency cap.
 *
 * Each slot processes items sequentially; `concurrency` slots run in parallel.
 * Results preserve input order. Errors are captured per-item (returned as
 * `{ __error: err, __index: i }`) so one bad email doesn't abort the batch.
 *
 * If `shouldAbort()` starts returning true (e.g. persistent 429), in-flight
 * workers finish their current item but no new items are dispatched — the
 * remaining items come back as `{ __aborted: true }`.
 */
async function parallelMap(items, concurrency, fn, shouldAbort = () => false) {
    const out = new Array(items.length);
    let cursor = 0;
    const worker = async () => {
        while (true) {
            if (shouldAbort()) break;
            const i = cursor++;
            if (i >= items.length) break;
            try {
                out[i] = await fn(items[i], i);
            } catch (err) {
                out[i] = { __error: err, __index: i };
            }
        }
    };
    const n = Math.max(1, Math.min(concurrency, items.length));
    await Promise.all(Array.from({ length: n }, worker));
    for (let i = 0; i < items.length; i++) {
        if (out[i] === undefined) out[i] = { __aborted: true, __index: i };
    }
    return out;
}

// ──────────────────────────────────────────────
// Outcome accumulator (per-email outcomes, persisted to sync log)
// ──────────────────────────────────────────────

function createOutcomes() {
    return {
        ingested: { count: 0, samples: [] },
        skipped: { count: 0, byReason: {}, samples: [] },
        failed: { count: 0, samples: [] },
    };
}

const OUTCOME_SAMPLE_CAP = 20;

function recordOutcome(results, bucket, detail = {}) {
    if (!results || !results.outcomes) return;
    const slot = results.outcomes[bucket];
    if (!slot) return;
    slot.count += 1;
    if (bucket === 'skipped') {
        const reason = detail.reason || 'unknown';
        slot.byReason[reason] = (slot.byReason[reason] || 0) + 1;
    }
    if (slot.samples.length < OUTCOME_SAMPLE_CAP) {
        slot.samples.push({ at: new Date().toISOString(), ...detail });
    }
    // Broadcast to SSE subscribers (if syncConnection tagged the results with a connectionId).
    if (results.__connectionId) {
        const processed = results.outcomes.ingested.count
            + results.outcomes.skipped.count
            + results.outcomes.failed.count;
        emitSyncEvent(results.__connectionId, 'email_processed', { bucket, detail, processed, total: results.fetched || null });

        // Metrics counters (labels kept low-cardinality on purpose).
        const provider = results.__provider || 'unknown';
        const labels = { provider, connectionId: results.__connectionId };
        if (bucket === 'ingested') metrics.inc('ticket_assistant_items_ingested_total', labels);
        else if (bucket === 'skipped') metrics.inc('ticket_assistant_items_skipped_total', { ...labels, reason: detail.reason || 'unknown' });
        else if (bucket === 'failed') metrics.inc('ticket_assistant_items_failed_total', { ...labels, stage: detail.stage || 'unknown' });
    }
}

// ──────────────────────────────────────────────
// Retry helper for transient failures
// ──────────────────────────────────────────────

async function withRetry(fn, label = 'operation') {
    let genericAttempts = 0;
    let rateAttempts = 0;
    // Single unified loop; generic and 429 retries have independent budgets.
    while (true) {
        try {
            return await fn();
        } catch (err) {
            const status = err.status || err.code;
            // Auth / permission failures — never retry; surface immediately.
            if (status === 401 || status === 403 || err.message?.includes('re-authenticat')) {
                throw err;
            }
            const is429 = status === 429 || err.message?.includes('429');
            if (is429) {
                if (rateAttempts >= MAX_429_RETRIES) throw err;
                const hinted = parseRetryAfter(err);
                const expo = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, rateAttempts));
                const jitter = Math.floor(Math.random() * 250);
                const delay = (hinted ?? expo) + jitter;
                console.warn(`[TicketAssistantSync] 429 on ${label} — backing off ${delay}ms (attempt ${rateAttempts + 1}/${MAX_429_RETRIES})`);
                await new Promise(r => setTimeout(r, delay));
                rateAttempts++;
                continue;
            }
            // Generic transient: keep the original linear backoff and budget.
            if (genericAttempts >= MAX_RETRIES) throw err;
            console.warn(`[TicketAssistantSync] Retrying ${label} (attempt ${genericAttempts + 2}/${MAX_RETRIES + 1}): ${err.message}`);
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (genericAttempts + 1)));
            genericAttempts++;
        }
    }
}

// ──────────────────────────────────────────────
// Gmail Sync
// ──────────────────────────────────────────────

async function syncGmailConnection(connection) {
    const { google } = require('googleapis');
    const { loadConfig } = require('../auth/permissions');

    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};

    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Google OAuth not configured');
    }

    const tokens = ticketAssistantStore.decryptTokens(connection.encrypted_tokens);
    if (!tokens || !tokens.accessToken) {
        throw new Error('No valid OAuth tokens — connection needs to be re-authenticated');
    }

    const oauth2Client = new google.auth.OAuth2(
        providerConfig.clientId,
        providerConfig.clientSecret
    );

    oauth2Client.setCredentials({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
    });

    // Handle token refresh
    oauth2Client.on('tokens', async (newTokens) => {
        const updated = { ...tokens };
        if (newTokens.access_token) updated.accessToken = newTokens.access_token;
        if (newTokens.refresh_token) updated.refreshToken = newTokens.refresh_token;
        await ticketAssistantStore.updateTokens(connection.id, updated);
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Build search query — prefer cursor, then last_sync_at, then sync_after_date, then 30 days back
    const syncAfter = connection.last_sync_cursor || connection.last_sync_at || connection.sync_after_date;
    const afterDate = syncAfter
        ? new Date(syncAfter).toISOString().split('T')[0].replace(/-/g, '/')
        : (() => {
            const d = new Date();
            d.setDate(d.getDate() - 30);
            return d.toISOString().split('T')[0].replace(/-/g, '/');
        })();

    // Normalize folder_filter: strip "in:" prefixes, map common names to Gmail label IDs
    const GMAIL_LABEL_MAP = {
        'inbox': 'INBOX', 'sent': 'SENT', 'drafts': 'DRAFT', 'draft': 'DRAFT',
        'starred': 'STARRED', 'important': 'IMPORTANT', 'trash': 'TRASH', 'spam': 'SPAM',
        'unread': 'UNREAD', 'in:sent': 'SENT', 'in:inbox': 'INBOX', 'in:drafts': 'DRAFT',
        'in:starred': 'STARRED', 'in:important': 'IMPORTANT', 'in:trash': 'TRASH', 'in:spam': 'SPAM',
    };
    const rawFilters = connection.folder_filter || ['INBOX'];
    const labelFilters = rawFilters.map(f => GMAIL_LABEL_MAP[f.toLowerCase()] || f);

    const query = `after:${afterDate}`;
    console.log(`[TicketAssistantSync] Gmail query: "${query}" labels: ${labelFilters.join(', ')}`);

    // P3.1: prefer Gmail History API when we have a stored historyId.
    // It returns messageAdded events since that point — more reliable than
    // date-cursor (no timezone drift, catches labelAdded changes).
    let messageIds = [];
    let newHistoryId = null;
    let syncMode = 'fallback_date';
    if (connection.gmail_history_id) {
        try {
            const historyRes = await withRetry(() => gmail.users.history.list({
                userId: 'me',
                startHistoryId: connection.gmail_history_id,
                historyTypes: ['messageAdded', 'labelAdded'],
                labelId: labelFilters.length === 1 ? labelFilters[0] : undefined,
                maxResults: connection.max_emails_per_sync || MAX_EMAILS_PER_SYNC,
            }), 'gmail.history.list');
            const histories = historyRes.data.history || [];
            const seen = new Set();
            for (const h of histories) {
                for (const ev of (h.messagesAdded || [])) {
                    const id = ev.message?.id;
                    if (id && !seen.has(id)) { seen.add(id); messageIds.push({ id }); }
                }
            }
            newHistoryId = historyRes.data.historyId || connection.gmail_history_id;
            syncMode = 'history';
            console.log(`[TicketAssistantSync] Gmail history API: ${messageIds.length} new messages (mode=${syncMode})`);
        } catch (err) {
            const status = err.status || err.code || err.response?.status;
            if (status === 404) {
                console.warn('[TicketAssistantSync] Gmail historyId too old, falling back to date cursor');
            } else {
                console.warn(`[TicketAssistantSync] Gmail history API error (${status}): ${err.message}`);
            }
            // Fall through to date-cursor path.
        }
    }

    if (syncMode !== 'history') {
        const response = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            labelIds: labelFilters.length > 0 ? labelFilters : undefined,
            maxResults: connection.max_emails_per_sync || MAX_EMAILS_PER_SYNC,
        });
        messageIds = response.data.messages || [];
        console.log(`[TicketAssistantSync] Gmail: ${messageIds.length} messages found (mode=${syncMode})`);

        // Capture a fresh historyId for the next tick. Prefer /profile — it
        // returns the current historyId at the mailbox level regardless of
        // query filters.
        try {
            const profile = await gmail.users.getProfile({ userId: 'me' });
            newHistoryId = profile.data.historyId || null;
        } catch (err) {
            console.warn('[TicketAssistantSync] Gmail getProfile failed:', err.message);
        }
    }

    if (newHistoryId && newHistoryId !== connection.gmail_history_id) {
        await ticketAssistantStore.updateIncrementalCursor(connection.id, { gmailHistoryId: newHistoryId }).catch(() => {});
    }

    const results = { fetched: messageIds.length, created: 0, skipped: 0, errors: 0, errorDetails: [], newestDate: null, processedArticles: [], outcomes: createOutcomes(), __connectionId: connection.id, __provider: 'gmail' };
    emitSyncEvent(connection.id, 'sync_fetch_complete', { total: messageIds.length, provider: 'gmail' });

    const ingestionMode = getIngestionMode(connection);
    // Per-email mode always treats each message individually — thread-merge is
    // meaningless because each email becomes its own addressable KB doc.
    const groupThreads = ingestionMode !== 'per_email' && connection.group_threads;

    if (groupThreads) {
        // Group by threadId
        const threadMap = new Map();
        for (const msg of messageIds) {
            try {
                const detail = await withRetry(() => gmail.users.messages.get({
                    userId: 'me',
                    id: msg.id,
                    format: 'full',
                }), `gmail.get(${msg.id})`);
                const threadId = detail.data.threadId;
                const msgDate = getGmailHeader(detail.data.payload?.headers, 'Date');
                if (msgDate && (!results.newestDate || new Date(msgDate) > new Date(results.newestDate))) {
                    results.newestDate = msgDate;
                }
                if (!threadMap.has(threadId)) {
                    threadMap.set(threadId, {
                        threadId,
                        subject: getGmailHeader(detail.data.payload?.headers, 'Subject'),
                        from: getGmailHeader(detail.data.payload?.headers, 'From'),
                        date: msgDate,
                        messages: [],
                    });
                }
                threadMap.get(threadId).messages.push({
                    body: extractGmailTextBody(detail.data.payload),
                    date: msgDate,
                });
            } catch (fetchErr) {
                if (fetchErr.message?.includes('429') || fetchErr.code === 429) {
                    results.errorDetails.push('Rate limited by Gmail API — will retry next cycle');
                    recordOutcome(results, 'skipped', { reason: 'rate_limited', messageId: msg.id, stage: 'fetch' });
                    break;
                }
                results.errors++;
                results.errorDetails.push(`Fetch msg ${msg.id}: ${fetchErr.message}`);
                recordOutcome(results, 'failed', { messageId: msg.id, stage: 'fetch', error: fetchErr.message });
            }
        }

        // Process each thread → collect articles (don't ingest yet)
        for (const [threadId, thread] of threadMap) {
            try {
                const processed = await processEmailThread(thread.messages, {
                    subject: thread.subject,
                    from: thread.from,
                    date: thread.date,
                }, {
                    ...buildProcessOptions(connection),
                });

                if (!processed.success) {
                    results.skipped++;
                    const skipLabel = processed.reason || 'unknown';
                    console.log(`[TicketAssistantSync] Skipped: ${skipLabel}`);
                    results.errorDetails.push(`Skipped: ${skipLabel}`);
                    recordOutcome(results, 'skipped', { reason: skipLabel, threadId, subject: thread.subject });
                    continue;
                }

                results.processedArticles.push(processed);
                results.created++;
            } catch (procErr) {
                results.errors++;
                results.errorDetails.push(`Thread ${threadId}: ${procErr.message}`);
                recordOutcome(results, 'failed', { threadId, stage: 'process', error: procErr.message });
            }
        }
    } else {
        // Process individual emails in parallel. The bottleneck is either the
        // Gmail API (per_email mode) or the AI provider (category_merge mode);
        // both tolerate a handful of concurrent callers. If we hit a hard 429
        // we set `rateLimited` so remaining workers finish their current item
        // and stop scheduling new ones — the next sync cycle picks up the rest.
        const { concurrency, batchSize } = resolveParallelism(connection);
        let rateLimited = false;
        const processOpts = buildProcessOptions(connection);
        const articleTier = connection.pipeline_config?.article?.modelTier || 'fast';
        const categoryTier = connection.pipeline_config?.category?.modelTier || 'fast';
        const useBatch = ingestionMode === 'category_merge' && batchSize > 1 && articleTier === categoryTier;

        // Fetch a single Gmail message into { body, metadata } form.
        const fetchOne = async (msg) => {
            const detail = await withRetry(() => gmail.users.messages.get({
                userId: 'me',
                id: msg.id,
                format: 'full',
            }), `gmail.get(${msg.id})`);
            const headers = detail.data.payload?.headers || [];

            let body = extractGmailTextBody(detail.data.payload);
            let attachments = [];
            if (connection.process_attachments !== false) {
                try {
                    attachments = await extractGmailAttachments(gmail, msg.id, detail.data.payload, connection.pipeline_config);
                    const attachmentText = formatAttachmentsMarkdown(attachments);
                    if (attachmentText) body = body + attachmentText;
                } catch (err) {
                    console.warn(`[TicketAssistantSync] Gmail attachment extraction failed for ${msg.id}: ${err.message}`);
                }
            }

            return {
                msgId: msg.id,
                body,
                metadata: {
                    subject: getGmailHeader(headers, 'Subject'),
                    from: getGmailHeader(headers, 'From'),
                    to: getGmailHeader(headers, 'To'),
                    cc: getGmailHeader(headers, 'Cc'),
                    date: getGmailHeader(headers, 'Date'),
                    messageId: msg.id,
                    threadId: detail.data.threadId,
                    labels: detail.data.labelIds,
                    hasAttachments: attachments.some(a => a.kind !== 'skipped'),
                    attachments: attachments.filter(a => a.kind !== 'skipped').map(a => ({
                        filename: a.filename, bytes: a.bytes, sha256: a.sha256, source: a.source, kind: a.kind,
                    })),
                },
            };
        };

        const perItem = async (msg) => {
            const { body, metadata } = await fetchOne(msg);
            const processed = ingestionMode === 'per_email'
                ? buildPerEmailArticle(body, metadata, processOpts)
                : await processEmail(body, metadata, processOpts);
            if (processed) processed.emailMetadata = metadata;
            return { msgId: msg.id, msgDate: metadata.date, processed };
        };

        // Batch mode (category_merge + batch_size > 1): fetch N emails, then
        // make ONE fused LLM call for all of them.
        const perChunk = async (chunk) => {
            const fetched = [];
            for (const msg of chunk) {
                fetched.push(await fetchOne(msg)); // sequential within a chunk; parallelism is across chunks
            }
            const prepped = fetched.map(f => prepareEmailForLLM(f.body, f.metadata, processOpts));
            const validIdx = [];
            for (let i = 0; i < prepped.length; i++) if (!prepped[i].skip) validIdx.push(i);
            const aiInputs = validIdx.map(i => prepped[i].aiInput);

            let llmResults = [];
            if (aiInputs.length > 0) {
                llmResults = await summarizeAndCategorizeBatch(aiInputs, {
                    orgId: processOpts.orgId,
                    language: processOpts.language,
                    modelTier: articleTier,
                    articlePrompt: processOpts.articlePrompt,
                    categoryPrompt: processOpts.categoryPrompt,
                });
                // If the whole batch failed (malformed JSON), fall back to individual fused calls.
                if (llmResults.every(r => !r.article && r.reason)) {
                    llmResults = await Promise.all(aiInputs.map(ai => summarizeAndCategorize(ai, {
                        orgId: processOpts.orgId,
                        language: processOpts.language,
                        modelTier: articleTier,
                        articlePrompt: processOpts.articlePrompt,
                        categoryPrompt: processOpts.categoryPrompt,
                    })));
                }
            }

            return fetched.map((f, i) => {
                const p = prepped[i];
                if (p.skip) {
                    return { msgId: f.msgId, msgDate: f.metadata.date, processed: { success: false, reason: p.reason, skipped: true } };
                }
                const llmIdx = validIdx.indexOf(i);
                const llm = llmResults[llmIdx] || { article: null };
                const processed = assembleProcessedEmail({
                    article: llm.article,
                    category: llm.category,
                    subject: p.subject,
                    date: p.date,
                    messageId: p.messageId,
                });
                if (!processed.success && llm.reason) processed.reason = llm.reason;
                return { msgId: f.msgId, msgDate: f.metadata.date, processed };
            });
        };

        let settled;
        if (useBatch) {
            console.log(`[TicketAssistantSync] Gmail batch mode: batch_size=${batchSize}, concurrency=${concurrency}, ${messageIds.length} msgs`);
            const chunks = [];
            for (let i = 0; i < messageIds.length; i += batchSize) chunks.push(messageIds.slice(i, i + batchSize));
            const settledChunks = await parallelMap(chunks, concurrency, perChunk, () => rateLimited);
            settled = settledChunks.flatMap(c => (Array.isArray(c) ? c : [c]));
        } else {
            settled = await parallelMap(messageIds, concurrency, perItem, () => rateLimited);
        }

        for (const r of settled) {
            if (r?.__aborted) {
                results.skipped++;
                recordOutcome(results, 'skipped', { reason: 'aborted_rate_limit', messageId: messageIds[r.__index]?.id });
                continue;
            }
            if (r?.__error) {
                const err = r.__error;
                if (err.message?.includes('429') || err.code === 429) {
                    rateLimited = true;
                    results.errorDetails.push('Rate limited — will retry next cycle');
                    recordOutcome(results, 'skipped', { reason: 'rate_limited', messageId: messageIds[r.__index]?.id, stage: 'fetch' });
                    continue;
                }
                results.errors++;
                results.errorDetails.push(`Msg ${messageIds[r.__index]?.id}: ${err.message}`);
                recordOutcome(results, 'failed', { messageId: messageIds[r.__index]?.id, stage: 'fetch', error: err.message });
                continue;
            }
            if (r.msgDate && (!results.newestDate || new Date(r.msgDate) > new Date(results.newestDate))) {
                results.newestDate = r.msgDate;
            }
            if (!r.processed.success) {
                results.skipped++;
                const reason = r.processed.reason || 'unknown';
                results.errorDetails.push(`Skipped: ${reason}`);
                recordOutcome(results, 'skipped', { reason, messageId: r.msgId });
                continue;
            }
            results.processedArticles.push(r.processed);
            results.created++;
        }
    }

    return results;
}

// Gmail helpers (reused from gmailTools.js patterns)
function getGmailHeader(headers, name) {
    const h = headers?.find(h => h.name.toLowerCase() === name.toLowerCase());
    return h?.value || '';
}

function decodeBase64Url(data) {
    if (!data) return '';
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64').toString('utf-8');
}

function extractGmailTextBody(payload) {
    if (!payload) return '';
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
        return decodeBase64Url(payload.body.data);
    }
    if (payload.parts) {
        for (const part of payload.parts) {
            if (part.mimeType === 'text/plain' && part.body?.data) {
                return decodeBase64Url(part.body.data);
            }
        }
        for (const part of payload.parts) {
            if (part.mimeType === 'text/html' && part.body?.data) {
                return decodeBase64Url(part.body.data); // Will be cleaned by processor
            }
        }
        for (const part of payload.parts) {
            if (part.parts) {
                const text = extractGmailTextBody(part);
                if (text) return text;
            }
        }
    }
    return '';
}

// ──────────────────────────────────────────────
// Outlook Sync
// ──────────────────────────────────────────────

async function syncOutlookConnection(connection) {
    const { loadConfig } = require('../auth/permissions');

    const config = await loadConfig();
    const providerConfig = config.providers?.microsoft || {};

    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Microsoft OAuth not configured');
    }

    const tokens = ticketAssistantStore.decryptTokens(connection.encrypted_tokens);
    if (!tokens || !tokens.accessToken) {
        throw new Error('No valid OAuth tokens — connection needs to be re-authenticated');
    }

    const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

    // Helper for Graph API calls with auto-refresh
    async function graphCall(path, opts = {}) {
        const doFetch = async (token) => {
            const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;
            return fetch(url, {
                ...opts,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    ...(opts.headers || {}),
                },
            });
        };

        let response = await doFetch(tokens.accessToken);

        if (response.status === 401 && tokens.refreshToken) {
            // Refresh token
            const tenantId = providerConfig.tenantId || 'common';
            const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
            const tokenResp = await fetch(tokenUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: tokens.refreshToken,
                    client_id: providerConfig.clientId,
                    client_secret: providerConfig.clientSecret,
                    scope: 'openid email profile User.Read Mail.Read offline_access',
                }).toString(),
            });

            if (tokenResp.ok) {
                const tokenData = await tokenResp.json();
                tokens.accessToken = tokenData.access_token;
                if (tokenData.refresh_token) tokens.refreshToken = tokenData.refresh_token;
                await ticketAssistantStore.updateTokens(connection.id, tokens);
                response = await doFetch(tokens.accessToken);
            } else {
                throw new Error('Token refresh failed — connection needs re-authentication');
            }
        }

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`Graph API ${response.status}: ${errText.substring(0, 200)}`);
        }

        if (response.status === 204) return {};
        return response.json();
    }

    // Build date filter — prefer cursor, then last_sync_at, then sync_after_date
    const syncAfter = connection.last_sync_cursor || connection.last_sync_at || connection.sync_after_date;
    const afterDate = syncAfter
        ? new Date(syncAfter).toISOString()
        : (() => {
            const d = new Date();
            d.setDate(d.getDate() - 30);
            return d.toISOString();
        })();

    const filter = `receivedDateTime ge ${afterDate}`;
    const outlookFolders = connection.folder_filter || ['Inbox'];
    const maxEmails = connection.max_emails_per_sync || MAX_EMAILS_PER_SYNC;
    const selectFields = 'id,subject,from,toRecipients,receivedDateTime,body,conversationId,bodyPreview';

    console.log(`[TicketAssistantSync] Outlook filter: "${filter}" folders: ${outlookFolders.join(', ')}`);

    // P3.1: prefer /me/mailFolders('inbox')/messages/delta with stored deltaLink.
    // Graph returns changes since the link was issued; fall back to $filter on
    // first sync or when the deltaLink is invalidated.
    let allMessages = [];
    let newDeltaLink = null;
    let outlookSyncMode = 'fallback_date';

    async function runDelta(url) {
        let next = url;
        let collected = [];
        let finalDelta = null;
        // Follow @odata.nextLink pagination until we hit a @odata.deltaLink.
        while (next) {
            try {
                const data = await graphCall(next);
                collected.push(...(data.value || []));
                if (data['@odata.deltaLink']) { finalDelta = data['@odata.deltaLink']; next = null; break; }
                if (data['@odata.nextLink']) { next = data['@odata.nextLink']; }
                else next = null;
                if (collected.length >= maxEmails) break;
            } catch (err) {
                // 410 Gone → deltaLink expired; caller should fall back.
                if (err.message?.includes('410') || err.code === 410) {
                    throw Object.assign(new Error('deltaLink expired'), { code: 410 });
                }
                throw err;
            }
        }
        return { messages: collected, deltaLink: finalDelta };
    }

    if (connection.graph_delta_link) {
        try {
            const result = await runDelta(connection.graph_delta_link);
            allMessages = result.messages;
            newDeltaLink = result.deltaLink || connection.graph_delta_link;
            outlookSyncMode = 'delta';
            console.log(`[TicketAssistantSync] Outlook delta: ${allMessages.length} changes (mode=${outlookSyncMode})`);
        } catch (err) {
            console.warn(`[TicketAssistantSync] Outlook delta query failed (${err.code || ''}): ${err.message} — falling back to date`);
        }
    }

    if (outlookSyncMode !== 'delta') {
        // Fetch from each folder and merge results
        for (const folder of outlookFolders) {
            try {
                const perFolder = Math.ceil(maxEmails / outlookFolders.length);
                const data = await graphCall(
                    `/me/mailFolders/${encodeURIComponent(folder)}/messages?$filter=${encodeURIComponent(filter)}&$top=${perFolder}&$orderby=receivedDateTime desc&$select=${selectFields}`
                );
                allMessages.push(...(data.value || []));
            } catch (folderErr) {
                console.warn(`[TicketAssistantSync] Outlook folder "${folder}" failed: ${folderErr.message}`);
                // Fallback: try without folder path (searches all mail)
                if (outlookFolders.length === 1) {
                    const data = await graphCall(
                        `/me/messages?$filter=${encodeURIComponent(filter)}&$top=${maxEmails}&$orderby=receivedDateTime desc&$select=${selectFields}`
                    );
                    allMessages.push(...(data.value || []));
                }
            }
        }

        // Seed a deltaLink for the next tick (on inbox, which is the common case).
        try {
            const firstFolder = outlookFolders[0] || 'Inbox';
            const seedData = await graphCall(
                `/me/mailFolders/${encodeURIComponent(firstFolder)}/messages/delta?$select=${selectFields}&$top=1`
            );
            newDeltaLink = seedData['@odata.deltaLink'] || null;
        } catch (err) {
            console.warn('[TicketAssistantSync] Outlook delta seed failed:', err.message);
        }
    }

    if (newDeltaLink && newDeltaLink !== connection.graph_delta_link) {
        await ticketAssistantStore.updateIncrementalCursor(connection.id, { graphDeltaLink: newDeltaLink }).catch(() => {});
    }

    // Deduplicate by message ID (same message could appear in multiple folder views)
    const seen = new Set();
    const messages = allMessages.filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
    }).slice(0, maxEmails);

    console.log(`[TicketAssistantSync] Outlook: ${messages.length} messages found`);

    const results = { fetched: messages.length, created: 0, skipped: 0, errors: 0, errorDetails: [], newestDate: null, processedArticles: [], outcomes: createOutcomes(), __connectionId: connection.id, __provider: 'outlook' };
    emitSyncEvent(connection.id, 'sync_fetch_complete', { total: messages.length, provider: 'outlook' });

    // Track newest message date for cursor
    if (messages.length > 0) {
        results.newestDate = messages[0].receivedDateTime; // Already sorted desc
    }

    const ingestionMode = getIngestionMode(connection);
    const groupThreads = ingestionMode !== 'per_email' && connection.group_threads;

    if (groupThreads) {
        // Group by conversationId
        const threadMap = new Map();
        for (const msg of messages) {
            const convId = msg.conversationId || msg.id;
            if (!threadMap.has(convId)) {
                threadMap.set(convId, {
                    conversationId: convId,
                    subject: msg.subject,
                    from: msg.from?.emailAddress ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address}>` : '',
                    date: msg.receivedDateTime,
                    messages: [],
                });
            }
            threadMap.get(convId).messages.push({
                body: msg.body?.content || '',
                date: msg.receivedDateTime,
            });
        }

        for (const [convId, thread] of threadMap) {
            try {
                const processed = await processEmailThread(thread.messages, {
                    subject: thread.subject,
                    from: thread.from,
                    date: thread.date,
                }, {
                    ...buildProcessOptions(connection),
                });

                if (!processed.success) {
                    results.skipped++;
                    const skipLabel = processed.reason || 'unknown';
                    console.log(`[TicketAssistantSync] Skipped: ${skipLabel}`);
                    results.errorDetails.push(`Skipped: ${skipLabel}`);
                    recordOutcome(results, 'skipped', { reason: skipLabel, threadId: convId, subject: thread.subject });
                    continue;
                }

                results.processedArticles.push(processed);
                results.created++;
            } catch (procErr) {
                if (procErr.message?.includes('429')) {
                    results.errorDetails.push('Rate limited by Microsoft Graph — will retry next cycle');
                    recordOutcome(results, 'skipped', { reason: 'rate_limited', threadId: convId, stage: 'process' });
                    break;
                } else {
                    results.errors++;
                    results.errorDetails.push(`Conv ${convId}: ${procErr.message}`);
                    recordOutcome(results, 'failed', { threadId: convId, stage: 'process', error: procErr.message });
                }
            }
        }
    } else {
        // Process individual messages in parallel (see syncGmailConnection for rationale).
        const { concurrency, batchSize } = resolveParallelism(connection);
        let rateLimited = false;
        const processOpts = buildProcessOptions(connection);
        const articleTier = connection.pipeline_config?.article?.modelTier || 'fast';
        const categoryTier = connection.pipeline_config?.category?.modelTier || 'fast';
        const useBatch = ingestionMode === 'category_merge' && batchSize > 1 && articleTier === categoryTier;

        const buildMeta = (msg) => {
            const fromStr = msg.from?.emailAddress
                ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address}>`
                : '';
            const toStr = Array.isArray(msg.toRecipients)
                ? msg.toRecipients.map(r => r.emailAddress?.address).filter(Boolean).join(', ')
                : '';
            return {
                subject: msg.subject,
                from: fromStr,
                to: toStr,
                date: msg.receivedDateTime,
                messageId: msg.id,
                threadId: msg.conversationId,
            };
        };

        const enrichWithAttachments = async (msg) => {
            const metadata = buildMeta(msg);
            let body = msg.body?.content || '';
            let attachments = [];
            if (connection.process_attachments !== false) {
                try {
                    attachments = await extractOutlookAttachments(tokens.accessToken, msg.id, connection.pipeline_config);
                    const md = formatAttachmentsMarkdown(attachments);
                    if (md) body = body + md;
                } catch (err) {
                    console.warn(`[TicketAssistantSync] Outlook attachment extraction failed for ${msg.id}: ${err.message}`);
                }
            }
            metadata.hasAttachments = attachments.some(a => a.kind !== 'skipped');
            metadata.attachments = attachments.filter(a => a.kind !== 'skipped').map(a => ({
                filename: a.filename, bytes: a.bytes, sha256: a.sha256, source: a.source, kind: a.kind,
            }));
            return { msgId: msg.id, body, metadata };
        };

        const perItem = async (msg) => {
            const { body, metadata } = await enrichWithAttachments(msg);
            const processed = ingestionMode === 'per_email'
                ? buildPerEmailArticle(body, metadata, processOpts)
                : await processEmail(body, metadata, processOpts);
            if (processed) processed.emailMetadata = metadata;
            return { msgId: msg.id, processed };
        };

        const perChunk = async (chunk) => {
            const fetched = [];
            for (const msg of chunk) fetched.push(await enrichWithAttachments(msg));
            const prepped = fetched.map(f => prepareEmailForLLM(f.body, f.metadata, processOpts));
            const validIdx = [];
            for (let i = 0; i < prepped.length; i++) if (!prepped[i].skip) validIdx.push(i);
            const aiInputs = validIdx.map(i => prepped[i].aiInput);

            let llmResults = [];
            if (aiInputs.length > 0) {
                llmResults = await summarizeAndCategorizeBatch(aiInputs, {
                    orgId: processOpts.orgId,
                    language: processOpts.language,
                    modelTier: articleTier,
                    articlePrompt: processOpts.articlePrompt,
                    categoryPrompt: processOpts.categoryPrompt,
                });
                if (llmResults.every(r => !r.article && r.reason)) {
                    llmResults = await Promise.all(aiInputs.map(ai => summarizeAndCategorize(ai, {
                        orgId: processOpts.orgId,
                        language: processOpts.language,
                        modelTier: articleTier,
                        articlePrompt: processOpts.articlePrompt,
                        categoryPrompt: processOpts.categoryPrompt,
                    })));
                }
            }

            return fetched.map((f, i) => {
                const p = prepped[i];
                if (p.skip) {
                    return { msgId: f.msgId, processed: { success: false, reason: p.reason, skipped: true } };
                }
                const llmIdx = validIdx.indexOf(i);
                const llm = llmResults[llmIdx] || { article: null };
                const processed = assembleProcessedEmail({
                    article: llm.article,
                    category: llm.category,
                    subject: p.subject,
                    date: p.date,
                    messageId: p.messageId,
                });
                if (!processed.success && llm.reason) processed.reason = llm.reason;
                return { msgId: f.msgId, processed };
            });
        };

        let settled;
        if (useBatch) {
            console.log(`[TicketAssistantSync] Outlook batch mode: batch_size=${batchSize}, concurrency=${concurrency}, ${messages.length} msgs`);
            const chunks = [];
            for (let i = 0; i < messages.length; i += batchSize) chunks.push(messages.slice(i, i + batchSize));
            const settledChunks = await parallelMap(chunks, concurrency, perChunk, () => rateLimited);
            settled = settledChunks.flatMap(c => (Array.isArray(c) ? c : [c]));
        } else {
            settled = await parallelMap(messages, concurrency, perItem, () => rateLimited);
        }

        for (const r of settled) {
            if (r?.__aborted) {
                results.skipped++;
                recordOutcome(results, 'skipped', { reason: 'aborted_rate_limit', messageId: messages[r.__index]?.id });
                continue;
            }
            if (r?.__error) {
                const err = r.__error;
                if (err.message?.includes('429')) {
                    rateLimited = true;
                    results.errorDetails.push('Rate limited by Microsoft Graph — will retry next cycle');
                    recordOutcome(results, 'skipped', { reason: 'rate_limited', messageId: messages[r.__index]?.id, stage: 'fetch' });
                    continue;
                }
                results.errors++;
                results.errorDetails.push(`Msg ${messages[r.__index]?.id}: ${err.message}`);
                recordOutcome(results, 'failed', { messageId: messages[r.__index]?.id, stage: 'fetch', error: err.message });
                continue;
            }
            if (!r.processed.success) {
                results.skipped++;
                const reason = r.processed.reason || 'unknown';
                results.errorDetails.push(`Skipped: ${reason}`);
                recordOutcome(results, 'skipped', { reason, messageId: r.msgId });
                continue;
            }
            results.processedArticles.push(r.processed);
            results.created++;
        }
    }

    return results;
}

// ──────────────────────────────────────────────
// Ticket-provider Sync (jira, freshservice, topdesk, zendesk, servicenow)
//
// These providers all live behind the TicketSourceProvider interface in
// server/core/ticketProviders/. This function drives the shared contract and
// hands normalized tickets to the same AI pipeline + KB ingestion code path
// used by email providers.
// ──────────────────────────────────────────────

function assembleTicketMarkdown(normalized) {
    const lines = [];
    if (normalized.subject) lines.push(`# ${normalized.subject}`, '');
    if (normalized.body_markdown) lines.push('## Description', normalized.body_markdown, '');
    if (Array.isArray(normalized.comments) && normalized.comments.length) {
        lines.push('## Comments');
        for (const c of normalized.comments) {
            const who = c.author_role || 'user';
            const when = c.at || '';
            lines.push(`### ${when} — ${who}`);
            lines.push(c.body_markdown || '');
            lines.push('');
        }
    }
    if (normalized.resolution?.body_markdown) {
        lines.push('## Resolution', normalized.resolution.body_markdown, '');
    }
    return lines.join('\n').trim();
}

async function syncTicketProviderConnection(connection, provider) {
    const { processEmail } = require('../core/ticketAssistantProcessor');
    const results = {
        fetched: 0,
        created: 0,
        skipped: 0,
        errors: 0,
        errorDetails: [],
        newestDate: null,
        processedArticles: [],
        outcomes: createOutcomes(),
        __connectionId: connection.id,
        __provider: connection.provider,
    };

    // Credential health-check (no-op for API token / basic providers)
    const fresh = await provider.ensureFreshTokens(connection);
    if (!fresh || !fresh.ok) {
        const msg = fresh?.needsReauth ? 'Credentials rejected — please update' : 'Provider auth failed';
        results.errors += 1;
        results.errorDetails.push(msg);
        return results;
    }

    // Iterate items from the provider's paginated list
    const maxItems = Math.min(500, connection.max_emails_per_sync || 50);
    const sinceIso = connection.sync_after_date
        ? new Date(connection.sync_after_date).toISOString()
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    let latestUpdate = null;
    let zendeskAfterCursor;
    let zendeskEndOfStream;

    try {
        for await (const raw of provider.listTickets(connection, { since: sinceIso, max: maxItems })) {
            results.fetched += 1;
            let comments = [];
            let attachments = [];
            try {
                // Jira + Freshservice often embed comments in the list payload — the
                // providers still expose fetchComments, but calling it is cheap when
                // the embedded list is truncated and skipped when it isn't. For v1
                // we always call it to keep the code simple.
                comments = await provider.fetchComments(connection, raw.id || raw.key || raw.sys_id || raw.number);
            } catch (err) {
                results.errorDetails.push(`Comments fetch failed: ${err.message}`);
            }
            try {
                if (connection.process_attachments !== false) {
                    attachments = await provider.fetchAttachments(connection, raw.id || raw.key || raw.sys_id || raw.number);
                }
            } catch (err) {
                results.errorDetails.push(`Attachments fetch failed: ${err.message}`);
            }

            const normalized = provider.normalize(raw, comments, attachments);
            if (normalized.updated_at && (!latestUpdate || normalized.updated_at > latestUpdate)) {
                latestUpdate = normalized.updated_at;
            }
            // Zendesk-specific: capture cursor for next tick
            if (connection.provider === 'zendesk' && raw.generated_timestamp) {
                zendeskAfterCursor = raw.generated_timestamp;
            }

            const rawContent = assembleTicketMarkdown(normalized);
            if (!rawContent || rawContent.length < 20) {
                results.skipped += 1;
                recordOutcome(results, 'skipped', { reason: 'empty_after_assembly', subject: normalized.subject });
                continue;
            }

            try {
                const processed = await processEmail(rawContent, {
                    subject: normalized.subject,
                    date: normalized.updated_at,
                    messageId: `${connection.provider}:${normalized.source_id}`,
                    from: normalized.raw_meta?.requester_id || normalized.raw_meta?.opened_by || '',
                }, buildProcessOptions(connection));

                if (!processed.success) {
                    results.skipped += 1;
                    recordOutcome(results, 'skipped', { reason: processed.reason || 'unknown', subject: normalized.subject });
                    continue;
                }

                // Attach ticket-aware metadata so the KB document carries full provenance.
                processed.sourceMessageId = `${connection.provider}:${normalized.source_id}`;
                processed.emailMetadata = {
                    ...(processed.emailMetadata || {}),
                    source_type: 'ticket',
                    source_system: normalized.source_system,
                    source_id: normalized.source_id,
                    source_uri: normalized.source_uri,
                    project_key: normalized.project_key,
                    itil_type: normalized.itil_type,
                    priority: normalized.priority,
                    status: normalized.status,
                    status_bucket: normalized.status_bucket,
                    category: normalized.category || processed.category,
                    tags: normalized.tags || [],
                    resolved_at: normalized.resolved_at,
                    created_at: normalized.created_at,
                    updated_at: normalized.updated_at,
                };
                results.processedArticles.push(processed);
                results.created += 1;
            } catch (procErr) {
                results.errors += 1;
                results.errorDetails.push(`Ticket ${normalized.source_id}: ${procErr.message}`);
                recordOutcome(results, 'failed', { stage: 'process', error: procErr.message, subject: normalized.subject });
            }
        }
    } catch (err) {
        // Fatal — likely auth or base-URL misconfig. Mark connection as errored via
        // the existing error path by throwing back up to the orchestrator.
        results.errors += 1;
        results.errorDetails.push(`List/fetch failed: ${err.message}`);
        if (err.needsReauth) throw err;
    }

    // Update provider_cursor for next tick
    try {
        const newCursor = {};
        if (connection.provider === 'zendesk') {
            if (zendeskAfterCursor) newCursor.afterCursor = null; // after_cursor read from response; tracked in engine if needed
            if (latestUpdate) newCursor.startTime = Math.floor(new Date(latestUpdate).getTime() / 1000) + 1;
        } else if (connection.provider === 'jira' && latestUpdate) {
            newCursor.updatedFrom = latestUpdate;
        } else if (connection.provider === 'freshservice' && latestUpdate) {
            newCursor.updatedSince = latestUpdate;
        } else if (connection.provider === 'topdesk' && latestUpdate) {
            newCursor.modificationDateStart = latestUpdate;
        } else if (connection.provider === 'servicenow' && latestUpdate) {
            // SNow uses "YYYY-MM-DD HH:mm:ss" not ISO
            newCursor.sysUpdatedOn = latestUpdate.replace('T', ' ').replace(/\..*$/, '').replace('Z', '');
        }
        if (Object.keys(newCursor).length > 0) {
            await ticketAssistantStore.updateIncrementalCursor(connection.id, { providerCursor: newCursor });
        }
    } catch (e) {
        console.warn('[TicketAssistantSync] Provider cursor update failed:', e.message);
    }

    return results;
}

// ──────────────────────────────────────────────
// Sync Orchestrator
// ──────────────────────────────────────────────

async function syncConnection(connection) {
    // Acquire sync lock first — prevents concurrent tick + manual sync from racing
    // on the same connection. TTL is a safety net in case the process crashes.
    const lock = await ticketAssistantStore.acquireSyncLock(connection.id, SYNC_TIMEOUT_MINUTES);
    if (!lock.acquired) {
        console.log(`[TicketAssistantSync] Skipping ${connection.email_address} — lock held (retry in ${lock.retryAfterSeconds}s)`);
        return { skipped: true, reason: 'locked', retryAfterSeconds: lock.retryAfterSeconds };
    }

    const log = await ticketAssistantStore.createSyncLog(connection.id);
    const syncStartedAt = Date.now();

    await ticketAssistantStore.updateSyncState(connection.id, { syncStatus: 'syncing', syncError: null });

    emitSyncEvent(connection.id, 'sync_started', {
        connectionId: connection.id,
        provider: connection.provider,
        emailAddress: connection.email_address,
        logId: log?.id,
    });

    let results;
    try {
        // Phase 1: Fetch + process individual items (get article + category per item).
        // Email providers take the legacy specialised path; ticket providers
        // (jira, freshservice, topdesk, zendesk, servicenow) go through the
        // shared provider abstraction in ticketProviders/ + processNormalizedTickets.
        const ticketProviders = require('../core/ticketProviders');
        if (connection.provider === 'gmail') {
            results = await syncGmailConnection(connection);
        } else if (connection.provider === 'outlook') {
            results = await syncOutlookConnection(connection);
        } else if (ticketProviders.isTicketProvider(connection.provider)) {
            results = await syncTicketProviderConnection(connection, ticketProviders.getProvider(connection.provider));
        } else {
            throw new Error(`Unknown provider: ${connection.provider}`);
        }

        // Phase 2: Ingest articles into KB.
        // Mode decides the grouping: per_email → one doc per message (unique
        // source_uri, skip-if-exists); category_merge → AI-merge by category,
        // replace old category doc.
        const processedArticles = results.processedArticles || [];
        const ingestionMode = getIngestionMode(connection);
        let categoryDocsCreated = 0;

        if (processedArticles.length > 0 && ingestionMode === 'per_email') {
            console.log(`[TicketAssistantSync] Phase 2: Ingesting ${processedArticles.length} per-email articles (skip-if-exists)...`);

            for (const processed of processedArticles) {
                try {
                    const messageId = processed.sourceMessageId;
                    if (!messageId) {
                        results.skipped++;
                        results.errorDetails.push('Skipped: per-email article without messageId');
                        recordOutcome(results, 'skipped', { reason: 'missing_message_id', subject: processed.title });
                        continue;
                    }
                    const em = processed.emailMetadata || {};
                    // Ticket-sourced docs: prefer the canonical provider browse URL as
                    // source_uri so dedup works across mailboxes and an updated ticket
                    // re-ingests (deletes + re-creates) instead of duplicating.
                    // Email-sourced docs keep the synthetic email-kb:// URI so existing
                    // ingested rows continue to dedupe correctly.
                    const isTicket = em.source_type === 'ticket';
                    const sourceUri = isTicket && em.source_uri
                        ? em.source_uri
                        : `email-kb://message/${encodeURIComponent(messageId)}`;

                    const existing = await findDocumentBySourceUri(connection.knowledge_base_id, sourceUri);
                    if (existing) {
                        if (isTicket) {
                            // Tickets evolve (new comments, resolution) — refresh the doc.
                            await deleteDocumentChunks(existing.id).catch(() => {});
                        } else {
                            results.skipped++;
                            recordOutcome(results, 'skipped', { reason: 'already_ingested', messageId, subject: processed.title });
                            continue; // Per-email archive is append-only.
                        }
                    }

                    const docMetadata = isTicket ? {
                        connectionId: connection.id,
                        provider: connection.provider,
                        source_type: em.source_type,
                        source_system: em.source_system,
                        source_id: em.source_id,
                        source_uri: em.source_uri,
                        project_key: em.project_key || null,
                        itil_type: em.itil_type || null,
                        priority: em.priority || null,
                        status: em.status || null,
                        status_bucket: em.status_bucket || null,
                        category: em.category || processed.category || null,
                        tags: em.tags || [],
                        resolved_at: em.resolved_at || null,
                        created_at: em.created_at || null,
                        updated_at: em.updated_at || null,
                    } : {
                        connectionId: connection.id,
                        provider: connection.provider,
                        mailbox: connection.email_address,
                        from: em.from || null,
                        to: em.to || null,
                        subject: em.subject || null,
                        date: em.date || null,
                        threadId: em.threadId || null,
                        messageId: em.messageId || messageId,
                        labels: em.labels || null,
                        hasAttachments: !!em.hasAttachments,
                        attachments: em.attachments || [],
                        category: processed.category || null,
                    };
                    await ingestDocument(
                        connection.created_by,
                        connection.knowledge_base_id,
                        processed.article,
                        processed.title,
                        isTicket ? 'ticket' : 'email',
                        sourceUri,
                        {
                            skipDedup: false,
                            lang: (connection.pipeline_config?.language || 'auto'),
                            metadata: docMetadata,
                        }
                    );
                    categoryDocsCreated++;
                    recordOutcome(results, 'ingested', { messageId, subject: processed.title });

                    // Fan out to the automation trigger bus so routines can
                    // react to each ingested ticket. Wrapped in try/catch so
                    // a triggerBus failure NEVER blocks the sync engine —
                    // the SSE stream + DB state stay correct even if the
                    // trigger dispatch hiccups.
                    try {
                        const triggerBus = require('../automation/triggerBus');
                        triggerBus.dispatchTicketAssistantEvent('ticket.new', {
                            ticketId: em.source_id || em.messageId || messageId,
                            connectionId: connection.id,
                            provider: connection.provider,
                            subject: processed.title,
                            body: processed.article,
                            status: em.status || null,
                            status_bucket: em.status_bucket || null,
                            priority: em.priority || null,
                            category: em.category || processed.category || null,
                            sourceUri,
                            attachments: (em.attachments || []).map(a => ({ filename: a.filename, mime: a.mime, size: a.size })),
                            ingestedAt: new Date().toISOString(),
                        }, connection.organization_id).catch(e => {
                            console.warn('[TicketAssistantSync] triggerBus dispatch (ticket.new) failed:', e.message);
                        });
                    } catch (e) {
                        console.warn('[TicketAssistantSync] triggerBus require/dispatch (ticket.new) failed:', e.message);
                    }
                } catch (ingestErr) {
                    if (ingestErr.code === 'DUPLICATE' || ingestErr.code === 'NEAR_DUPLICATE') {
                        results.skipped++;
                        const reason = ingestErr.code === 'DUPLICATE' ? 'content_hash_dup' : 'simhash_near_dup';
                        recordOutcome(results, 'skipped', { reason, messageId: processed.sourceMessageId, subject: processed.title });
                        continue;
                    }
                    results.errors++;
                    results.errorDetails.push(`Ingest message ${processed.sourceMessageId}: ${ingestErr.message}`);
                    recordOutcome(results, 'failed', { messageId: processed.sourceMessageId, subject: processed.title, stage: 'ingest', error: ingestErr.message });
                    console.error(`[TicketAssistantSync] ❌ Failed to ingest per-email doc:`, ingestErr.message);
                }
            }

            console.log(`[TicketAssistantSync] Per-email ingest: ${categoryDocsCreated} new docs, ${results.skipped} already present`);
        } else if (processedArticles.length > 0) {
            console.log(`[TicketAssistantSync] Phase 2: Merging ${processedArticles.length} articles by category...`);

            const mergeOpts = buildMergeOptions(connection);
            mergeOpts.onProgress = (event, data) => emitSyncEvent(connection.id, event, data);
            const mergedCategories = await mergeArticlesByCategory(processedArticles, mergeOpts);

            // Transactional swap: ingest new under a temp source_uri, verify
            // success, then delete the old canonical doc and rename the new
            // one. On failure, only the temp doc is cleaned up — the prior
            // category doc remains intact and retrievable.
            const kbStoreLocal = require('../stores/knowledgeBases');
            for (const { category, article, sourceCount } of mergedCategories) {
                const canonicalUri = `email-kb://category/${encodeURIComponent(category)}`;
                const tempUri = `${canonicalUri}#pending-${Date.now()}`;
                let newDoc = null;
                try {
                    const categoryMetadata = {
                        connectionId: connection.id,
                        provider: connection.provider,
                        mailbox: connection.email_address,
                        category,
                        sourceCount,
                        ingestionMode: 'category_merge',
                    };
                    const result = await ingestDocument(
                        connection.created_by,
                        connection.knowledge_base_id,
                        article,
                        category,
                        'email',
                        tempUri,
                        { skipDedup: true, lang: 'auto', metadata: categoryMetadata }
                    );
                    newDoc = result.document;

                    // New doc landed. Now swap: remove old canonical + rename temp.
                    const existing = await findDocumentBySourceUri(connection.knowledge_base_id, canonicalUri);
                    if (existing) {
                        console.log(`[TicketAssistantSync] Swapping category doc "${category}" (${existing.id} → ${newDoc.id})`);
                        await deleteDocumentChunks(connection.knowledge_base_id, existing.id, connection.created_by);
                    }
                    await kbStoreLocal.updateDocumentSourceUri(newDoc.id, canonicalUri);

                    categoryDocsCreated++;
                    recordOutcome(results, 'ingested', { category, sourceCount });
                    console.log(`[TicketAssistantSync] ✅ Category "${category}" ingested (${sourceCount} emails merged)`);
                } catch (ingestErr) {
                    // Clean up the failed temp doc so it doesn't leave orphans.
                    if (newDoc) {
                        try {
                            await deleteDocumentChunks(connection.knowledge_base_id, newDoc.id, connection.created_by);
                        } catch (_) { /* best-effort cleanup */ }
                    }
                    results.errors++;
                    results.errorDetails.push(`Ingest category "${category}": ${ingestErr.message}`);
                    recordOutcome(results, 'failed', { category, stage: 'ingest', error: ingestErr.message });
                    console.error(`[TicketAssistantSync] ❌ Failed to ingest category "${category}":`, ingestErr.message);
                }
            }
        }

        await ticketAssistantStore.updateSyncState(connection.id, {
            syncStatus: 'idle',
            syncError: null,
            lastSyncAt: new Date().toISOString(),
            lastSyncCursor: results.newestDate || undefined,
            emailsProcessed: results.fetched,
            articlesCreated: categoryDocsCreated,
        });

        await ticketAssistantStore.completeSyncLog(log.id, {
            emailsFetched: results.fetched,
            articlesCreated: categoryDocsCreated,
            articlesSkipped: results.skipped,
            errors: results.errors,
            errorDetails: results.errorDetails.length > 0 ? results.errorDetails.join('\n') : null,
            outcomes: results.outcomes,
        });

        emitSyncEvent(connection.id, 'sync_completed', {
            success: true,
            stats: {
                emailsFetched: results.fetched,
                articlesCreated: categoryDocsCreated,
                articlesSkipped: results.skipped,
                errors: results.errors,
            },
            outcomes: results.outcomes,
        });

        // Fire the automation `sync.completed` event alongside the SSE one.
        try {
            const triggerBus = require('../automation/triggerBus');
            triggerBus.dispatchTicketAssistantEvent('sync.completed', {
                connectionId: connection.id,
                provider: connection.provider,
                outcome: results.errors > 0 ? 'partial' : 'success',
                stats: {
                    emailsFetched: results.fetched,
                    articlesCreated: categoryDocsCreated,
                    articlesSkipped: results.skipped,
                    errors: results.errors,
                },
            }, connection.organization_id).catch(e => {
                console.warn('[TicketAssistantSync] triggerBus dispatch (sync.completed/success) failed:', e.message);
            });
        } catch (e) {
            console.warn('[TicketAssistantSync] triggerBus dispatch (sync.completed/success) require failed:', e.message);
        }

        console.log(`[TicketAssistantSync] ✅ ${connection.provider} ${connection.email_address}: ${processedArticles.length} emails → ${categoryDocsCreated} category docs, ${results.skipped} skipped, ${results.errors} errors`);

    } catch (err) {
        console.error(`[TicketAssistantSync] ❌ ${connection.provider} ${connection.email_address}:`, err.message);

        await ticketAssistantStore.updateSyncState(connection.id, {
            syncStatus: 'error',
            syncError: err.message,
            lastSyncAt: new Date().toISOString(),
        });

        const fatalOutcomes = results?.outcomes || createOutcomes();
        recordOutcome({ outcomes: fatalOutcomes }, 'failed', { stage: 'sync', error: err.message });

        await ticketAssistantStore.completeSyncLog(log.id, {
            emailsFetched: results?.fetched || 0,
            articlesCreated: 0,
            articlesSkipped: results?.skipped || 0,
            errors: (results?.errors || 0) + 1,
            errorDetails: err.message,
            outcomes: fatalOutcomes,
        });

        emitSyncEvent(connection.id, 'sync_completed', {
            success: false,
            error: err.message,
            stats: {
                emailsFetched: results?.fetched || 0,
                articlesCreated: 0,
                articlesSkipped: results?.skipped || 0,
                errors: (results?.errors || 0) + 1,
            },
            outcomes: fatalOutcomes,
        });

        try {
            const triggerBus = require('../automation/triggerBus');
            triggerBus.dispatchTicketAssistantEvent('sync.completed', {
                connectionId: connection.id,
                provider: connection.provider,
                outcome: 'error',
                error: err.message,
                stats: {
                    emailsFetched: results?.fetched || 0,
                    articlesCreated: 0,
                    articlesSkipped: results?.skipped || 0,
                    errors: (results?.errors || 0) + 1,
                },
            }, connection.organization_id).catch(e => {
                console.warn('[TicketAssistantSync] triggerBus dispatch (sync.completed/error) failed:', e.message);
            });
        } catch (e) {
            console.warn('[TicketAssistantSync] triggerBus dispatch (sync.completed/error) require failed:', e.message);
        }
    } finally {
        metrics.recordSyncDuration(connection.provider || 'unknown', (Date.now() - syncStartedAt) / 1000);
        // Release the sync lock so the next tick/manual sync can run.
        await ticketAssistantStore.releaseSyncLock(connection.id).catch((e) => {
            console.warn('[TicketAssistantSync] Failed to release sync lock:', e.message);
        });
    }
}

/**
 * Single tick of the sync loop.
 */
async function tick() {
    if (isRunning) return;
    isRunning = true;

    try {
        // Recover stuck syncs (timeout protection)
        try {
            await run(
                `UPDATE ticket_assistant_connections
                 SET sync_status = 'error', sync_error = 'Sync timed out', updated_at = now()
                 WHERE sync_status = 'syncing' AND updated_at < now() - interval '${SYNC_TIMEOUT_MINUTES} minutes'`
            );
        } catch (err) {
            console.warn('[TicketAssistantSync] Timeout recovery query failed:', err.message);
        }

        const dueConnections = await ticketAssistantStore.getDueConnections();
        if (dueConnections.length === 0) return;

        console.log(`[TicketAssistantSync] ${dueConnections.length} connection(s) due for sync`);

        // Process in batches of MAX_CONCURRENT
        for (let i = 0; i < dueConnections.length; i += MAX_CONCURRENT) {
            const batch = dueConnections.slice(i, i + MAX_CONCURRENT);
            await Promise.allSettled(batch.map(conn => syncConnection(conn)));
        }
    } catch (err) {
        console.error('[TicketAssistantSync] Tick error:', err.message);
    } finally {
        isRunning = false;
    }
}

/**
 * Start the background sync engine.
 */
function startTicketAssistantSync() {
    if (tickTimer) return;

    console.log(`[TicketAssistantSync] Starting sync engine (interval: ${TICK_INTERVAL_MS / 1000}s)`);

    // Delay initial tick to let the server finish booting
    setTimeout(() => {
        tick();
        tickTimer = setInterval(tick, TICK_INTERVAL_MS);
    }, 30000);
}

/**
 * Stop the background sync engine.
 */
function stopTicketAssistantSync() {
    if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
        console.log('[TicketAssistantSync] Sync engine stopped');
    }
}

/**
 * Manually trigger a sync for a specific connection.
 *
 * Returns a { conflict:true, retryAfterSeconds } structure when another sync
 * is already in-flight — callers (HTTP route) should map that to 409.
 */
async function triggerManualSync(connectionId) {
    const connection = await ticketAssistantStore.getConnectionWithTokens(connectionId);
    if (!connection) {
        const err = new Error('Connection not found');
        err.status = 404;
        throw err;
    }
    if (!connection.enabled) {
        const err = new Error('Connection is disabled');
        err.status = 400;
        throw err;
    }

    // Pre-flight lock probe: if locked or actively syncing, return 409-style
    // payload without attempting the sync. The real lock is still acquired
    // inside syncConnection — this just gives a clean UX for the common case.
    if (connection.sync_status === 'syncing' || (connection.sync_locked_until && new Date(connection.sync_locked_until) > new Date())) {
        const retryAfterSeconds = connection.sync_locked_until
            ? Math.max(1, Math.ceil((new Date(connection.sync_locked_until).getTime() - Date.now()) / 1000))
            : 60;
        return { conflict: true, retryAfterSeconds, message: 'Sync already in progress' };
    }

    // Run sync without waiting
    syncConnection({ ...connection, encrypted_tokens: ticketAssistantStore.encryptTokens(connection.tokens) })
        .catch(err => console.error(`[TicketAssistantSync] Manual sync error:`, err.message));

    return { message: 'Sync started' };
}

/**
 * Test a connection by processing 1 email without ingesting.
 * Works regardless of enabled status — uses connection's folder/date settings.
 */
async function testConnection(connectionId) {
    const connection = await ticketAssistantStore.getConnectionWithTokens(connectionId);
    if (!connection) throw new Error('Connection not found');

    let testEmail;
    let gmailForTest = null;
    let gmailDetailForTest = null;
    let gmailMessageIdForTest = null;
    let outlookMsgIdForTest = null;

    if (connection.provider === 'gmail') {
        const { google } = require('googleapis');
        const { loadConfig } = require('../auth/permissions');
        const config = await loadConfig();
        const providerConfig = config.providers?.google || {};

        const oauth2Client = new google.auth.OAuth2(providerConfig.clientId, providerConfig.clientSecret);
        oauth2Client.setCredentials({
            access_token: connection.tokens.accessToken,
            refresh_token: connection.tokens.refreshToken,
        });

        // Use connection's folder filter and date settings
        const LABEL_MAP = {
            'inbox': 'INBOX', 'sent': 'SENT', 'drafts': 'DRAFT', 'draft': 'DRAFT',
            'starred': 'STARRED', 'important': 'IMPORTANT', 'in:sent': 'SENT', 'in:inbox': 'INBOX',
        };
        const rawFilters = connection.folder_filter || ['INBOX'];
        const labelIds = rawFilters.map(f => LABEL_MAP[f.toLowerCase()] || f);

        const listParams = { userId: 'me', maxResults: 1 };
        if (labelIds.length > 0) listParams.labelIds = labelIds;
        if (connection.sync_after_date) {
            listParams.q = `after:${new Date(connection.sync_after_date).toISOString().split('T')[0].replace(/-/g, '/')}`;
        }

        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const list = await gmail.users.messages.list(listParams);
        if (!list.data.messages?.length) return { success: true, message: 'No emails found matching your filters', preview: null };

        const detail = await gmail.users.messages.get({ userId: 'me', id: list.data.messages[0].id, format: 'full' });
        gmailForTest = gmail;
        gmailDetailForTest = detail;
        gmailMessageIdForTest = list.data.messages[0].id;
        const headers = detail.data.payload?.headers || [];
        testEmail = {
            subject: getGmailHeader(headers, 'Subject'),
            from: getGmailHeader(headers, 'From'),
            date: getGmailHeader(headers, 'Date'),
            body: extractGmailTextBody(detail.data.payload),
        };
    } else {
        const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
        const outlookFolders = connection.folder_filter || ['Inbox'];
        let filterQ = '';
        if (connection.sync_after_date) {
            filterQ = `$filter=${encodeURIComponent(`receivedDateTime ge ${new Date(connection.sync_after_date).toISOString()}`)}&`;
        }

        // Try first folder, fallback to all messages
        let msg;
        try {
            const resp = await fetch(`${GRAPH_BASE}/me/mailFolders/${encodeURIComponent(outlookFolders[0])}/messages?${filterQ}$top=1&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,body`, {
                headers: { 'Authorization': `Bearer ${connection.tokens.accessToken}` },
            });
            if (!resp.ok) throw new Error(resp.status);
            const data = await resp.json();
            msg = data.value?.[0];
        } catch {
            const resp = await fetch(`${GRAPH_BASE}/me/messages?${filterQ}$top=1&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,body`, {
                headers: { 'Authorization': `Bearer ${connection.tokens.accessToken}` },
            });
            if (!resp.ok) throw new Error(`Outlook test failed: ${resp.status}`);
            const data = await resp.json();
            msg = data.value?.[0];
        }

        if (!msg) return { success: true, message: 'No emails found matching your filters', preview: null };

        outlookMsgIdForTest = msg.id;
        testEmail = {
            subject: msg.subject,
            from: msg.from?.emailAddress ? `${msg.from.emailAddress.name} <${msg.from.emailAddress.address}>` : '',
            date: msg.receivedDateTime,
            body: msg.body?.content || '',
        };
    }

    // Process through the full pipeline (but don't ingest)
    const opts = buildProcessOptions(connection);
    const result = await processEmail(testEmail.body, {
        subject: testEmail.subject,
        from: testEmail.from,
        date: testEmail.date,
    }, opts);

    // PII diff (before/after + counts). Runs independently of the article
    // pipeline so the UI can show what redaction did regardless of success.
    let pii = null;
    try {
        const cleaned = cleanEmail(testEmail.body || '');
        if (cleaned) {
            const disable = Array.isArray(connection.pipeline_config?.pii?.disable)
                ? connection.pipeline_config.pii.disable : [];
            const { text: redacted, counts } = redactPIIWithCounts(cleaned, { disable });
            pii = {
                enabled: opts.redactPII,
                before: cleaned,
                after: redacted,
                counts,
                disabled: disable,
            };
        }
    } catch (err) {
        console.warn('[TicketAssistantSync] PII diff failed for test:', err.message);
    }

    // Attachment preview (Phase 3.3): list extracted attachment names + first 500 chars.
    let attachments = null;
    try {
        if (connection.process_attachments !== false) {
            if (connection.provider === 'gmail' && gmailDetailForTest) {
                attachments = await extractGmailAttachments(gmailForTest, gmailMessageIdForTest, gmailDetailForTest.data.payload, connection.pipeline_config);
            } else if (connection.provider === 'outlook' && outlookMsgIdForTest) {
                attachments = await extractOutlookAttachments(connection.tokens.accessToken, outlookMsgIdForTest, connection.pipeline_config);
            }
            if (attachments) {
                attachments = attachments.map(a => ({
                    filename: a.filename, bytes: a.bytes, kind: a.kind,
                    reason: a.reason || null, source: a.source || null, truncated: !!a.truncated,
                    preview: a.text ? a.text.slice(0, 500) : null,
                }));
            }
        }
    } catch (err) {
        console.warn('[TicketAssistantSync] Attachment preview failed:', err.message);
    }

    return {
        success: true,
        originalSubject: testEmail.subject,
        originalFrom: testEmail.from,
        preview: result,
        pii,
        attachments,
    };
}

module.exports = {
    startTicketAssistantSync,
    stopTicketAssistantSync,
    // Legacy aliases — retained for 1 release so external callers don't break.
    startEmailKBSync: startTicketAssistantSync,
    stopEmailKBSync: stopTicketAssistantSync,
    triggerManualSync,
    testConnection,
    subscribeSyncEvents,
    tick, // exported for testing
};
