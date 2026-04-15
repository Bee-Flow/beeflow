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

const emailKBStore = require('../stores/emailKBStore');
const { processEmail, processEmailThread } = require('../core/emailKBProcessor');
const { ingestDocument } = require('../core/kbIngestionHelpers');

const { run } = require('../db');

const MAX_CONCURRENT = 3;
const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_EMAILS_PER_SYNC = 50;
const SYNC_TIMEOUT_MINUTES = 30;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5000;

let tickTimer = null;
let isRunning = false;

// ──────────────────────────────────────────────
// Retry helper for transient failures
// ──────────────────────────────────────────────

async function withRetry(fn, label = 'operation') {
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            // Don't retry auth failures or permanent errors
            const status = err.status || err.code;
            if (status === 401 || status === 403 || err.message?.includes('re-authenticat')) {
                throw err;
            }
            // Rate-limited — throw immediately so caller can handle
            if (status === 429 || err.message?.includes('429')) {
                throw err;
            }
            if (attempt < MAX_RETRIES) {
                console.warn(`[EmailKBSync] Retrying ${label} (attempt ${attempt + 2}/${MAX_RETRIES + 1}): ${err.message}`);
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
            }
        }
    }
    throw lastErr;
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

    const results = { fetched: messageIds.length, created: 0, skipped: 0, errors: 0, errorDetails: [], newestDate: null };

    if (connection.group_threads) {
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
                    break;
                }
                results.errors++;
                results.errorDetails.push(`Fetch msg ${msg.id}: ${fetchErr.message}`);
            }
        }

        // Process each thread
        for (const [threadId, thread] of threadMap) {
            try {
                const processed = await processEmailThread(thread.messages, {
                    subject: thread.subject,
                    from: thread.from,
                    date: thread.date,
                }, {
                    orgId: connection.organization_id,
                    customPrompt: connection.ai_system_prompt,
                    senderBlacklist: connection.sender_blacklist || [],
                    redactPII: connection.redact_pii !== false,
                });

                if (!processed.success) {
                    results.skipped++;
                    const skipLabel = processed.reason || 'unknown';
                    console.log(`[EmailKBSync] Skipped: ${skipLabel}`);
                    results.errorDetails.push(`Skipped: ${skipLabel}`);
                    continue;
                }

                // Ingest into KB
                await ingestDocument(
                    connection.created_by,
                    connection.knowledge_base_id,
                    processed.article,
                    processed.title,
                    'email',
                    `gmail://thread/${threadId}`,
                    { lang: 'auto' }
                );

                results.created++;
            } catch (procErr) {
                if (procErr.code === 'DUPLICATE') {
                    results.skipped++;
                } else {
                    results.errors++;
                    results.errorDetails.push(`Thread ${threadId}: ${procErr.message}`);
                }
            }
        }
    } else {
        // Process individual emails
        for (const msg of messageIds) {
            try {
                const detail = await withRetry(() => gmail.users.messages.get({
                    userId: 'me',
                    id: msg.id,
                    format: 'full',
                }), `gmail.get(${msg.id})`);

                const headers = detail.data.payload?.headers || [];
                const msgDate = getGmailHeader(headers, 'Date');
                if (msgDate && (!results.newestDate || new Date(msgDate) > new Date(results.newestDate))) {
                    results.newestDate = msgDate;
                }
                const body = extractGmailTextBody(detail.data.payload);

                const processed = await processEmail(body, {
                    subject: getGmailHeader(headers, 'Subject'),
                    from: getGmailHeader(headers, 'From'),
                    date: getGmailHeader(headers, 'Date'),
                    messageId: msg.id,
                }, {
                    orgId: connection.organization_id,
                    customPrompt: connection.ai_system_prompt,
                    senderBlacklist: connection.sender_blacklist || [],
                    redactPII: connection.redact_pii !== false,
                });

                if (!processed.success) {
                    results.skipped++;
                    const skipLabel = processed.reason || 'unknown';
                    console.log(`[EmailKBSync] Skipped: ${skipLabel}`);
                    results.errorDetails.push(`Skipped: ${skipLabel}`);
                    continue;
                }

                await ingestDocument(
                    connection.created_by,
                    connection.knowledge_base_id,
                    processed.article,
                    processed.title,
                    'email',
                    `gmail://message/${msg.id}`,
                    { lang: 'auto' }
                );

                results.created++;
            } catch (procErr) {
                if (procErr.code === 'DUPLICATE') {
                    results.skipped++;
                } else if (procErr.message?.includes('429') || procErr.code === 429) {
                    results.errorDetails.push('Rate limited by Gmail API — will retry next cycle');
                    break;
                } else {
                    results.errors++;
                    results.errorDetails.push(`Msg ${msg.id}: ${procErr.message}`);
                }
            }
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

    const results = { fetched: messages.length, created: 0, skipped: 0, errors: 0, errorDetails: [], newestDate: null };

    // Track newest message date for cursor
    if (messages.length > 0) {
        results.newestDate = messages[0].receivedDateTime; // Already sorted desc
    }

    if (connection.group_threads) {
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
                    orgId: connection.organization_id,
                    customPrompt: connection.ai_system_prompt,
                    senderBlacklist: connection.sender_blacklist || [],
                    redactPII: connection.redact_pii !== false,
                });

                if (!processed.success) {
                    results.skipped++;
                    const skipLabel = processed.reason || 'unknown';
                    console.log(`[EmailKBSync] Skipped: ${skipLabel}`);
                    results.errorDetails.push(`Skipped: ${skipLabel}`);
                    continue;
                }

                await ingestDocument(
                    connection.created_by,
                    connection.knowledge_base_id,
                    processed.article,
                    processed.title,
                    'email',
                    `outlook://conversation/${convId}`,
                    { lang: 'auto' }
                );

                results.created++;
            } catch (procErr) {
                if (procErr.code === 'DUPLICATE') {
                    results.skipped++;
                } else if (procErr.message?.includes('429')) {
                    results.errorDetails.push('Rate limited by Microsoft Graph — will retry next cycle');
                    break;
                } else {
                    results.errors++;
                    results.errorDetails.push(`Conv ${convId}: ${procErr.message}`);
                }
            }
        }
    } else {
        for (const msg of messages) {
            try {
                const fromStr = msg.from?.emailAddress
                    ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address}>`
                    : '';

                const processed = await processEmail(msg.body?.content || '', {
                    subject: msg.subject,
                    from: fromStr,
                    date: msg.receivedDateTime,
                    messageId: msg.id,
                }, {
                    orgId: connection.organization_id,
                    customPrompt: connection.ai_system_prompt,
                    senderBlacklist: connection.sender_blacklist || [],
                    redactPII: connection.redact_pii !== false,
                });

                if (!processed.success) {
                    results.skipped++;
                    const skipLabel = processed.reason || 'unknown';
                    console.log(`[EmailKBSync] Skipped: ${skipLabel}`);
                    results.errorDetails.push(`Skipped: ${skipLabel}`);
                    continue;
                }

                await ingestDocument(
                    connection.created_by,
                    connection.knowledge_base_id,
                    processed.article,
                    processed.title,
                    'email',
                    `outlook://message/${msg.id}`,
                    { lang: 'auto' }
                );

                results.created++;
            } catch (procErr) {
                if (procErr.code === 'DUPLICATE') {
                    results.skipped++;
                } else if (procErr.message?.includes('429')) {
                    results.errorDetails.push('Rate limited by Microsoft Graph — will retry next cycle');
                    break;
                } else {
                    results.errors++;
                    results.errorDetails.push(`Msg ${msg.id}: ${procErr.message}`);
                }
            }
        }
    }

    return results;
}

// ──────────────────────────────────────────────
// Sync Orchestrator
// ──────────────────────────────────────────────

async function syncConnection(connection) {
    const log = await emailKBStore.createSyncLog(connection.id);

    await emailKBStore.updateSyncState(connection.id, { syncStatus: 'syncing', syncError: null });

    let results;
    try {
        if (connection.provider === 'gmail') {
            results = await syncGmailConnection(connection);
        } else if (connection.provider === 'outlook') {
            results = await syncOutlookConnection(connection);
        } else {
            throw new Error(`Unknown provider: ${connection.provider}`);
        }

        await emailKBStore.updateSyncState(connection.id, {
            syncStatus: 'idle',
            syncError: null,
            lastSyncAt: new Date().toISOString(),
            lastSyncCursor: results.newestDate || undefined,
            emailsProcessed: results.fetched,
            articlesCreated: results.created,
        });

        await emailKBStore.completeSyncLog(log.id, {
            emailsFetched: results.fetched,
            articlesCreated: results.created,
            articlesSkipped: results.skipped,
            errors: results.errors,
            errorDetails: results.errorDetails.length > 0 ? results.errorDetails.join('\n') : null,
        });

        console.log(`[EmailKBSync] ✅ ${connection.provider} ${connection.email_address}: ${results.created} articles, ${results.skipped} skipped, ${results.errors} errors`);

    } catch (err) {
        console.error(`[EmailKBSync] ❌ ${connection.provider} ${connection.email_address}:`, err.message);

        await emailKBStore.updateSyncState(connection.id, {
            syncStatus: 'error',
            syncError: err.message,
            lastSyncAt: new Date().toISOString(),
        });

        await emailKBStore.completeSyncLog(log.id, {
            emailsFetched: results?.fetched || 0,
            articlesCreated: results?.created || 0,
            articlesSkipped: results?.skipped || 0,
            errors: (results?.errors || 0) + 1,
            errorDetails: err.message,
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
 */
async function triggerManualSync(connectionId) {
    const connection = await emailKBStore.getConnectionWithTokens(connectionId);
    if (!connection) throw new Error('Connection not found');
    if (!connection.enabled) throw new Error('Connection is disabled');
    if (connection.sync_status === 'syncing') throw new Error('Sync already in progress');

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
    }, {
        orgId: connection.organization_id,
        customPrompt: connection.ai_system_prompt,
        senderBlacklist: connection.sender_blacklist || [],
        redactPII: connection.redact_pii !== false,
    });

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
    tick, // exported for testing
};
