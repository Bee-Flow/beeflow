/**
 * Email KB Sync Engine — Background polling service
 *
 * Periodically syncs connected email mailboxes, processes new emails
 * through the AI pipeline, and ingests them into the knowledge base.
 *
 * Architecture:
 *   - Cron tick every 5 minutes
 *   - Picks connections where sync is due (based on sync_interval_minutes)
 *   - Max 3 concurrent syncs to avoid AI pipeline overload
 *   - Uses existing Gmail/Outlook tooling for email access
 *   - Uses existing KB ingestion pipeline for storage
 */

const EventEmitter = require('events');
const emailKBStore = require('../stores/emailKBStore');
const {
    processEmail,
    processEmailThread,
    mergeArticlesByCategory,
    buildPerEmailArticle,
    prepareEmailForLLM,
    assembleProcessedEmail,
    summarizeAndCategorize,
    summarizeAndCategorizeBatch,
} = require('../core/emailKBProcessor');
const { ingestDocument, findDocumentBySourceUri, deleteDocumentChunks } = require('../core/kbIngestionHelpers');

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
        customPrompt: pc.merge?.systemPrompt || '',
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
 * summarizeAndCategorizeBatch in emailKBProcessor.js.
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
    // pipeline_config.ingestion_mode = 'per_email' via emailKBStore defaults.
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
                console.warn(`[EmailKBSync] 429 on ${label} — backing off ${delay}ms (attempt ${rateAttempts + 1}/${MAX_429_RETRIES})`);
                await new Promise(r => setTimeout(r, delay));
                rateAttempts++;
                continue;
            }
            // Generic transient: keep the original linear backoff and budget.
            if (genericAttempts >= MAX_RETRIES) throw err;
            console.warn(`[EmailKBSync] Retrying ${label} (attempt ${genericAttempts + 2}/${MAX_RETRIES + 1}): ${err.message}`);
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

    const tokens = emailKBStore.decryptTokens(connection.encrypted_tokens);
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
        await emailKBStore.updateTokens(connection.id, updated);
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
    console.log(`[EmailKBSync] Gmail query: "${query}" labels: ${labelFilters.join(', ')}`);

    // Fetch message list — pass folder_filter as Gmail labelIds
    const response = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        labelIds: labelFilters.length > 0 ? labelFilters : undefined,
        maxResults: connection.max_emails_per_sync || MAX_EMAILS_PER_SYNC,
    });

    const messageIds = response.data.messages || [];
    console.log(`[EmailKBSync] Gmail: ${messageIds.length} messages found`);

    const results = { fetched: messageIds.length, created: 0, skipped: 0, errors: 0, errorDetails: [], newestDate: null, processedArticles: [], outcomes: createOutcomes(), __connectionId: connection.id };
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
                    console.log(`[EmailKBSync] Skipped: ${skipLabel}`);
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
            return {
                msgId: msg.id,
                body: extractGmailTextBody(detail.data.payload),
                metadata: {
                    subject: getGmailHeader(headers, 'Subject'),
                    from: getGmailHeader(headers, 'From'),
                    to: getGmailHeader(headers, 'To'),
                    cc: getGmailHeader(headers, 'Cc'),
                    date: getGmailHeader(headers, 'Date'),
                    messageId: msg.id,
                    threadId: detail.data.threadId,
                    labels: detail.data.labelIds,
                },
            };
        };

        const perItem = async (msg) => {
            const { body, metadata } = await fetchOne(msg);
            const processed = ingestionMode === 'per_email'
                ? buildPerEmailArticle(body, metadata, processOpts)
                : await processEmail(body, metadata, processOpts);
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
            console.log(`[EmailKBSync] Gmail batch mode: batch_size=${batchSize}, concurrency=${concurrency}, ${messageIds.length} msgs`);
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

    const tokens = emailKBStore.decryptTokens(connection.encrypted_tokens);
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
                await emailKBStore.updateTokens(connection.id, tokens);
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

    console.log(`[EmailKBSync] Outlook filter: "${filter}" folders: ${outlookFolders.join(', ')}`);

    // Fetch from each folder and merge results
    let allMessages = [];
    for (const folder of outlookFolders) {
        try {
            const perFolder = Math.ceil(maxEmails / outlookFolders.length);
            const data = await graphCall(
                `/me/mailFolders/${encodeURIComponent(folder)}/messages?$filter=${encodeURIComponent(filter)}&$top=${perFolder}&$orderby=receivedDateTime desc&$select=${selectFields}`
            );
            allMessages.push(...(data.value || []));
        } catch (folderErr) {
            console.warn(`[EmailKBSync] Outlook folder "${folder}" failed: ${folderErr.message}`);
            // Fallback: try without folder path (searches all mail)
            if (outlookFolders.length === 1) {
                const data = await graphCall(
                    `/me/messages?$filter=${encodeURIComponent(filter)}&$top=${maxEmails}&$orderby=receivedDateTime desc&$select=${selectFields}`
                );
                allMessages.push(...(data.value || []));
            }
        }
    }

    // Deduplicate by message ID (same message could appear in multiple folder views)
    const seen = new Set();
    const messages = allMessages.filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
    }).slice(0, maxEmails);

    console.log(`[EmailKBSync] Outlook: ${messages.length} messages found`);

    const results = { fetched: messages.length, created: 0, skipped: 0, errors: 0, errorDetails: [], newestDate: null, processedArticles: [], outcomes: createOutcomes(), __connectionId: connection.id };
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
                    console.log(`[EmailKBSync] Skipped: ${skipLabel}`);
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

        const perItem = async (msg) => {
            const metadata = buildMeta(msg);
            const body = msg.body?.content || '';
            const processed = ingestionMode === 'per_email'
                ? buildPerEmailArticle(body, metadata, processOpts)
                : await processEmail(body, metadata, processOpts);
            return { msgId: msg.id, processed };
        };

        const perChunk = async (chunk) => {
            const fetched = chunk.map(msg => ({ msgId: msg.id, body: msg.body?.content || '', metadata: buildMeta(msg) }));
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
            console.log(`[EmailKBSync] Outlook batch mode: batch_size=${batchSize}, concurrency=${concurrency}, ${messages.length} msgs`);
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
// Sync Orchestrator
// ──────────────────────────────────────────────

async function syncConnection(connection) {
    // Acquire sync lock first — prevents concurrent tick + manual sync from racing
    // on the same connection. TTL is a safety net in case the process crashes.
    const lock = await emailKBStore.acquireSyncLock(connection.id, SYNC_TIMEOUT_MINUTES);
    if (!lock.acquired) {
        console.log(`[EmailKBSync] Skipping ${connection.email_address} — lock held (retry in ${lock.retryAfterSeconds}s)`);
        return { skipped: true, reason: 'locked', retryAfterSeconds: lock.retryAfterSeconds };
    }

    const log = await emailKBStore.createSyncLog(connection.id);

    await emailKBStore.updateSyncState(connection.id, { syncStatus: 'syncing', syncError: null });

    emitSyncEvent(connection.id, 'sync_started', {
        connectionId: connection.id,
        provider: connection.provider,
        emailAddress: connection.email_address,
        logId: log?.id,
    });

    let results;
    try {
        // Phase 1: Fetch + process individual emails (get article + category per email)
        if (connection.provider === 'gmail') {
            results = await syncGmailConnection(connection);
        } else if (connection.provider === 'outlook') {
            results = await syncOutlookConnection(connection);
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
            console.log(`[EmailKBSync] Phase 2: Ingesting ${processedArticles.length} per-email articles (skip-if-exists)...`);

            for (const processed of processedArticles) {
                try {
                    const messageId = processed.sourceMessageId;
                    if (!messageId) {
                        results.skipped++;
                        results.errorDetails.push('Skipped: per-email article without messageId');
                        recordOutcome(results, 'skipped', { reason: 'missing_message_id', subject: processed.title });
                        continue;
                    }
                    const sourceUri = `email-kb://message/${encodeURIComponent(messageId)}`;

                    const existing = await findDocumentBySourceUri(connection.knowledge_base_id, sourceUri);
                    if (existing) {
                        results.skipped++;
                        recordOutcome(results, 'skipped', { reason: 'already_ingested', messageId, subject: processed.title });
                        continue; // Already ingested — per-email archive is append-only.
                    }

                    await ingestDocument(
                        connection.created_by,
                        connection.knowledge_base_id,
                        processed.article,
                        processed.title,
                        'email',
                        sourceUri,
                        { skipDedup: false, lang: (connection.pipeline_config?.language || 'auto') }
                    );
                    categoryDocsCreated++;
                    recordOutcome(results, 'ingested', { messageId, subject: processed.title });
                } catch (ingestErr) {
                    results.errors++;
                    results.errorDetails.push(`Ingest message ${processed.sourceMessageId}: ${ingestErr.message}`);
                    recordOutcome(results, 'failed', { messageId: processed.sourceMessageId, subject: processed.title, stage: 'ingest', error: ingestErr.message });
                    console.error(`[EmailKBSync] ❌ Failed to ingest per-email doc:`, ingestErr.message);
                }
            }

            console.log(`[EmailKBSync] Per-email ingest: ${categoryDocsCreated} new docs, ${results.skipped} already present`);
        } else if (processedArticles.length > 0) {
            console.log(`[EmailKBSync] Phase 2: Merging ${processedArticles.length} articles by category...`);

            const mergedCategories = await mergeArticlesByCategory(processedArticles, buildMergeOptions(connection));

            // Upsert: for each category, find existing doc → delete → re-ingest
            for (const { category, article, sourceCount } of mergedCategories) {
                try {
                    const sourceUri = `email-kb://category/${encodeURIComponent(category)}`;

                    // Remove existing category document if present
                    const existing = await findDocumentBySourceUri(connection.knowledge_base_id, sourceUri);
                    if (existing) {
                        console.log(`[EmailKBSync] Replacing existing category doc: "${category}" (${existing.id})`);
                        await deleteDocumentChunks(connection.knowledge_base_id, existing.id, connection.created_by);
                    }

                    // Ingest merged category article
                    await ingestDocument(
                        connection.created_by,
                        connection.knowledge_base_id,
                        article,
                        category,
                        'email',
                        sourceUri,
                        { skipDedup: true, lang: 'auto' }
                    );

                    categoryDocsCreated++;
                    recordOutcome(results, 'ingested', { category, sourceCount });
                    console.log(`[EmailKBSync] ✅ Category "${category}" ingested (${sourceCount} emails merged)`);
                } catch (ingestErr) {
                    results.errors++;
                    results.errorDetails.push(`Ingest category "${category}": ${ingestErr.message}`);
                    recordOutcome(results, 'failed', { category, stage: 'ingest', error: ingestErr.message });
                    console.error(`[EmailKBSync] ❌ Failed to ingest category "${category}":`, ingestErr.message);
                }
            }
        }

        await emailKBStore.updateSyncState(connection.id, {
            syncStatus: 'idle',
            syncError: null,
            lastSyncAt: new Date().toISOString(),
            lastSyncCursor: results.newestDate || undefined,
            emailsProcessed: results.fetched,
            articlesCreated: categoryDocsCreated,
        });

        await emailKBStore.completeSyncLog(log.id, {
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

        console.log(`[EmailKBSync] ✅ ${connection.provider} ${connection.email_address}: ${processedArticles.length} emails → ${categoryDocsCreated} category docs, ${results.skipped} skipped, ${results.errors} errors`);

    } catch (err) {
        console.error(`[EmailKBSync] ❌ ${connection.provider} ${connection.email_address}:`, err.message);

        await emailKBStore.updateSyncState(connection.id, {
            syncStatus: 'error',
            syncError: err.message,
            lastSyncAt: new Date().toISOString(),
        });

        const fatalOutcomes = results?.outcomes || createOutcomes();
        recordOutcome({ outcomes: fatalOutcomes }, 'failed', { stage: 'sync', error: err.message });

        await emailKBStore.completeSyncLog(log.id, {
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
    } finally {
        // Release the sync lock so the next tick/manual sync can run.
        await emailKBStore.releaseSyncLock(connection.id).catch((e) => {
            console.warn('[EmailKBSync] Failed to release sync lock:', e.message);
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
                `UPDATE email_kb_connections
                 SET sync_status = 'error', sync_error = 'Sync timed out', updated_at = now()
                 WHERE sync_status = 'syncing' AND updated_at < now() - interval '${SYNC_TIMEOUT_MINUTES} minutes'`
            );
        } catch (err) {
            console.warn('[EmailKBSync] Timeout recovery query failed:', err.message);
        }

        const dueConnections = await emailKBStore.getDueConnections();
        if (dueConnections.length === 0) return;

        console.log(`[EmailKBSync] ${dueConnections.length} connection(s) due for sync`);

        // Process in batches of MAX_CONCURRENT
        for (let i = 0; i < dueConnections.length; i += MAX_CONCURRENT) {
            const batch = dueConnections.slice(i, i + MAX_CONCURRENT);
            await Promise.allSettled(batch.map(conn => syncConnection(conn)));
        }
    } catch (err) {
        console.error('[EmailKBSync] Tick error:', err.message);
    } finally {
        isRunning = false;
    }
}

/**
 * Start the background sync engine.
 */
function startEmailKBSync() {
    if (tickTimer) return;

    console.log(`[EmailKBSync] Starting sync engine (interval: ${TICK_INTERVAL_MS / 1000}s)`);

    // Delay initial tick to let the server finish booting
    setTimeout(() => {
        tick();
        tickTimer = setInterval(tick, TICK_INTERVAL_MS);
    }, 30000);
}

/**
 * Stop the background sync engine.
 */
function stopEmailKBSync() {
    if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
        console.log('[EmailKBSync] Sync engine stopped');
    }
}

/**
 * Manually trigger a sync for a specific connection.
 *
 * Returns a { conflict:true, retryAfterSeconds } structure when another sync
 * is already in-flight — callers (HTTP route) should map that to 409.
 */
async function triggerManualSync(connectionId) {
    const connection = await emailKBStore.getConnectionWithTokens(connectionId);
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
    syncConnection({ ...connection, encrypted_tokens: emailKBStore.encryptTokens(connection.tokens) })
        .catch(err => console.error(`[EmailKBSync] Manual sync error:`, err.message));

    return { message: 'Sync started' };
}

/**
 * Test a connection by processing 1 email without ingesting.
 * Works regardless of enabled status — uses connection's folder/date settings.
 */
async function testConnection(connectionId) {
    const connection = await emailKBStore.getConnectionWithTokens(connectionId);
    if (!connection) throw new Error('Connection not found');

    let testEmail;

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
            const resp = await fetch(`${GRAPH_BASE}/me/mailFolders/${encodeURIComponent(outlookFolders[0])}/messages?${filterQ}$top=1&$orderby=receivedDateTime desc&$select=subject,from,receivedDateTime,body`, {
                headers: { 'Authorization': `Bearer ${connection.tokens.accessToken}` },
            });
            if (!resp.ok) throw new Error(resp.status);
            const data = await resp.json();
            msg = data.value?.[0];
        } catch {
            const resp = await fetch(`${GRAPH_BASE}/me/messages?${filterQ}$top=1&$orderby=receivedDateTime desc&$select=subject,from,receivedDateTime,body`, {
                headers: { 'Authorization': `Bearer ${connection.tokens.accessToken}` },
            });
            if (!resp.ok) throw new Error(`Outlook test failed: ${resp.status}`);
            const data = await resp.json();
            msg = data.value?.[0];
        }

        if (!msg) return { success: true, message: 'No emails found matching your filters', preview: null };

        testEmail = {
            subject: msg.subject,
            from: msg.from?.emailAddress ? `${msg.from.emailAddress.name} <${msg.from.emailAddress.address}>` : '',
            date: msg.receivedDateTime,
            body: msg.body?.content || '',
        };
    }

    // Process through the full pipeline (but don't ingest)
    const result = await processEmail(testEmail.body, {
        subject: testEmail.subject,
        from: testEmail.from,
        date: testEmail.date,
    }, buildProcessOptions(connection));

    return {
        success: true,
        originalSubject: testEmail.subject,
        originalFrom: testEmail.from,
        preview: result,
    };
}

module.exports = {
    startEmailKBSync,
    stopEmailKBSync,
    triggerManualSync,
    testConnection,
    subscribeSyncEvents,
    tick, // exported for testing
};
