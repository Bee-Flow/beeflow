/**
 * Email KB Sync Engine — Background polling service
 *
 * Periodically syncs connected email mailboxes, processes new emails
 * through the AI pipeline, and ingests them into the knowledge base.
 *
<<<<<<< test2
 * Works for both org-scoped and consumer (no-org) accounts.
=======
 * Architecture:
 *   - Cron tick every 5 minutes
 *   - Picks connections where sync is due (based on sync_interval_minutes)
 *   - Max 3 concurrent syncs to avoid AI pipeline overload
 *   - Uses existing Gmail/Outlook tooling for email access
 *   - Uses existing KB ingestion pipeline for storage
>>>>>>> main
 */

const emailKBStore = require('../stores/emailKBStore');
const { processEmail, processEmailThread } = require('../core/emailKBProcessor');
const { ingestDocument } = require('../core/kbIngestionHelpers');

const MAX_CONCURRENT = 3;
const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_EMAILS_PER_SYNC = 50;

let tickTimer = null;
let isRunning = false;

<<<<<<< test2
// ── Gmail Sync ───────────────────────────────────────────────────────────────
=======
// ──────────────────────────────────────────────
// Gmail Sync
// ──────────────────────────────────────────────
>>>>>>> main

async function syncGmailConnection(connection) {
    const { google } = require('googleapis');
    const { loadConfig } = require('../auth/permissions');

    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};
<<<<<<< test2
=======

>>>>>>> main
    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Google OAuth not configured');
    }

    const tokens = emailKBStore.decryptTokens(connection.encrypted_tokens);
<<<<<<< test2
    if (!tokens?.accessToken) throw new Error('No valid OAuth tokens');

    const oauth2Client = new google.auth.OAuth2(providerConfig.clientId, providerConfig.clientSecret);
    oauth2Client.setCredentials({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken });

=======
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
>>>>>>> main
    oauth2Client.on('tokens', async (newTokens) => {
        const updated = { ...tokens };
        if (newTokens.access_token) updated.accessToken = newTokens.access_token;
        if (newTokens.refresh_token) updated.refreshToken = newTokens.refresh_token;
        await emailKBStore.updateTokens(connection.id, updated);
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

<<<<<<< test2
    const afterDate = connection.last_sync_at
        ? new Date(connection.last_sync_at).toISOString().split('T')[0].replace(/-/g, '/')
        : (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().split('T')[0].replace(/-/g, '/'); })();

    const response = await gmail.users.messages.list({
        userId: 'me', q: `after:${afterDate}`,
        labelIds: ['INBOX'], maxResults: MAX_EMAILS_PER_SYNC,
=======
    // Build search query
    const labelFilters = (connection.folder_filter || ['INBOX']);
    const afterDate = connection.last_sync_at
        ? new Date(connection.last_sync_at).toISOString().split('T')[0].replace(/-/g, '/')
        : (() => {
            const d = new Date();
            d.setDate(d.getDate() - 30); // Initial sync: last 30 days
            return d.toISOString().split('T')[0].replace(/-/g, '/');
        })();

    const query = `after:${afterDate}`;

    console.log(`[EmailKBSync] Gmail query: "${query}" labels: ${labelFilters.join(', ')}`);

    // Fetch message list
    const response = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        labelIds: labelFilters.includes('INBOX') ? ['INBOX'] : undefined,
        maxResults: MAX_EMAILS_PER_SYNC,
>>>>>>> main
    });

    const messageIds = response.data.messages || [];
    console.log(`[EmailKBSync] Gmail: ${messageIds.length} messages found`);

    const results = { fetched: messageIds.length, created: 0, skipped: 0, errors: 0, errorDetails: [] };

<<<<<<< test2
    for (const msg of messageIds) {
        try {
            const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
            const headers = detail.data.payload?.headers || [];
            const body = extractGmailTextBody(detail.data.payload);

            const processed = await processEmail(body, {
                subject: getHeader(headers, 'Subject'),
                from: getHeader(headers, 'From'),
                date: getHeader(headers, 'Date'),
                messageId: msg.id,
            }, {
                orgId: connection.organization_id,
                senderBlacklist: safeParse(connection.sender_blacklist, []),
            });

            if (!processed.success) { results.skipped++; continue; }

            await ingestDocument(
                connection.created_by, connection.knowledge_base_id,
                processed.article, processed.title, 'email',
                `gmail://message/${msg.id}`, { lang: 'auto' }
            );
            results.created++;
        } catch (err) {
            if (err.code === 'DUPLICATE') { results.skipped++; }
            else { results.errors++; results.errorDetails.push(`${msg.id}: ${err.message}`); }
        }
    }
    return results;
}

function getHeader(headers, name) {
    return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
=======
    if (connection.group_threads) {
        // Group by threadId
        const threadMap = new Map();
        for (const msg of messageIds) {
            try {
                const detail = await gmail.users.messages.get({
                    userId: 'me',
                    id: msg.id,
                    format: 'full',
                });
                const threadId = detail.data.threadId;
                if (!threadMap.has(threadId)) {
                    threadMap.set(threadId, {
                        threadId,
                        subject: getGmailHeader(detail.data.payload?.headers, 'Subject'),
                        from: getGmailHeader(detail.data.payload?.headers, 'From'),
                        date: getGmailHeader(detail.data.payload?.headers, 'Date'),
                        messages: [],
                    });
                }
                threadMap.get(threadId).messages.push({
                    body: extractGmailTextBody(detail.data.payload),
                    date: getGmailHeader(detail.data.payload?.headers, 'Date'),
                });
            } catch (fetchErr) {
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
                });

                if (!processed.success) {
                    results.skipped++;
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
                const detail = await gmail.users.messages.get({
                    userId: 'me',
                    id: msg.id,
                    format: 'full',
                });

                const headers = detail.data.payload?.headers || [];
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
                });

                if (!processed.success) {
                    results.skipped++;
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
>>>>>>> main
}

function decodeBase64Url(data) {
    if (!data) return '';
<<<<<<< test2
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
=======
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64').toString('utf-8');
>>>>>>> main
}

function extractGmailTextBody(payload) {
    if (!payload) return '';
<<<<<<< test2
    if (payload.mimeType === 'text/plain' && payload.body?.data) return decodeBase64Url(payload.body.data);
    if (payload.parts) {
        for (const p of payload.parts) {
            if (p.mimeType === 'text/plain' && p.body?.data) return decodeBase64Url(p.body.data);
        }
        for (const p of payload.parts) {
            if (p.mimeType === 'text/html' && p.body?.data) return decodeBase64Url(p.body.data);
        }
        for (const p of payload.parts) {
            if (p.parts) { const t = extractGmailTextBody(p); if (t) return t; }
=======
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
>>>>>>> main
        }
    }
    return '';
}

<<<<<<< test2
// ── Outlook Sync ─────────────────────────────────────────────────────────────

async function syncOutlookConnection(connection) {
    const { loadConfig } = require('../auth/permissions');
    const config = await loadConfig();
    const providerConfig = config.providers?.microsoft || {};
    if (!providerConfig.clientId || !providerConfig.clientSecret) throw new Error('Microsoft OAuth not configured');

    const tokens = emailKBStore.decryptTokens(connection.encrypted_tokens);
    if (!tokens?.accessToken) throw new Error('No valid OAuth tokens');

    const GRAPH = 'https://graph.microsoft.com/v1.0';

    async function graphCall(path) {
        let res = await fetch(`${GRAPH}${path}`, { headers: { 'Authorization': `Bearer ${tokens.accessToken}` } });
        if (res.status === 401 && tokens.refreshToken) {
            const tenantId = providerConfig.tenantId || 'common';
            const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'refresh_token', refresh_token: tokens.refreshToken,
                    client_id: providerConfig.clientId, client_secret: providerConfig.clientSecret,
                    scope: 'openid email profile User.Read Mail.Read offline_access',
                }).toString(),
            });
            if (tokenRes.ok) {
                const td = await tokenRes.json();
                tokens.accessToken = td.access_token;
                if (td.refresh_token) tokens.refreshToken = td.refresh_token;
                await emailKBStore.updateTokens(connection.id, tokens);
                res = await fetch(`${GRAPH}${path}`, { headers: { 'Authorization': `Bearer ${tokens.accessToken}` } });
            } else throw new Error('Token refresh failed');
        }
        if (!res.ok) throw new Error(`Graph API ${res.status}`);
        return res.json();
    }

    const afterDate = connection.last_sync_at
        ? new Date(connection.last_sync_at).toISOString()
        : (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString(); })();

    const data = await graphCall(`/me/messages?$filter=${encodeURIComponent(`receivedDateTime ge ${afterDate}`)}&$top=${MAX_EMAILS_PER_SYNC}&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,body`);
=======
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

    // Build date filter
    const afterDate = connection.last_sync_at
        ? new Date(connection.last_sync_at).toISOString()
        : (() => {
            const d = new Date();
            d.setDate(d.getDate() - 30);
            return d.toISOString();
        })();

    const filter = `receivedDateTime ge ${afterDate}`;

    console.log(`[EmailKBSync] Outlook filter: "${filter}"`);

    const data = await graphCall(
        `/me/messages?$filter=${encodeURIComponent(filter)}&$top=${MAX_EMAILS_PER_SYNC}&$orderby=receivedDateTime desc&$select=id,subject,from,toRecipients,receivedDateTime,body,conversationId,bodyPreview`
    );

>>>>>>> main
    const messages = data.value || [];
    console.log(`[EmailKBSync] Outlook: ${messages.length} messages found`);

    const results = { fetched: messages.length, created: 0, skipped: 0, errors: 0, errorDetails: [] };

<<<<<<< test2
    for (const msg of messages) {
        try {
            const fromStr = msg.from?.emailAddress ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address}>` : '';
            const processed = await processEmail(msg.body?.content || '', {
                subject: msg.subject, from: fromStr, date: msg.receivedDateTime, messageId: msg.id,
            }, {
                orgId: connection.organization_id,
                senderBlacklist: safeParse(connection.sender_blacklist, []),
            });

            if (!processed.success) { results.skipped++; continue; }

            await ingestDocument(
                connection.created_by, connection.knowledge_base_id,
                processed.article, processed.title, 'email',
                `outlook://message/${msg.id}`, { lang: 'auto' }
            );
            results.created++;
        } catch (err) {
            if (err.code === 'DUPLICATE') { results.skipped++; }
            else { results.errors++; results.errorDetails.push(`${msg.id}: ${err.message}`); }
        }
    }
    return results;
}

// ── Sync Orchestrator ────────────────────────────────────────────────────────

function safeParse(val, fallback) {
    if (Array.isArray(val)) return val;
    try { return JSON.parse(val || '[]'); } catch { return fallback; }
}

async function syncConnection(connection) {
    const log = await emailKBStore.createSyncLog(connection.id);
=======
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
                });

                if (!processed.success) {
                    results.skipped++;
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
                });

                if (!processed.success) {
                    results.skipped++;
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

>>>>>>> main
    await emailKBStore.updateSyncState(connection.id, { syncStatus: 'syncing', syncError: null });

    let results;
    try {
<<<<<<< test2
        if (connection.provider === 'gmail') results = await syncGmailConnection(connection);
        else if (connection.provider === 'outlook') results = await syncOutlookConnection(connection);
        else throw new Error(`Unknown provider: ${connection.provider}`);

        await emailKBStore.updateSyncState(connection.id, {
            syncStatus: 'idle', syncError: null, lastSyncAt: new Date().toISOString(),
            emailsProcessed: results.fetched, articlesCreated: results.created,
        });
        await emailKBStore.completeSyncLog(log.id, {
            emailsFetched: results.fetched, articlesCreated: results.created,
            articlesSkipped: results.skipped, errors: results.errors,
            errorDetails: results.errorDetails.length > 0 ? results.errorDetails.join('\n') : null,
        });
        console.log(`[EmailKBSync] ✅ ${connection.email_address}: ${results.created} articles, ${results.skipped} skipped`);
    } catch (err) {
        console.error(`[EmailKBSync] ❌ ${connection.email_address}:`, err.message);
        await emailKBStore.updateSyncState(connection.id, {
            syncStatus: 'error', syncError: err.message, lastSyncAt: new Date().toISOString(),
        });
        await emailKBStore.completeSyncLog(log.id, {
            emailsFetched: results?.fetched || 0, articlesCreated: results?.created || 0,
            articlesSkipped: results?.skipped || 0, errors: (results?.errors || 0) + 1, errorDetails: err.message,
        });
    }
}

async function tick() {
    if (isRunning) return;
    isRunning = true;
    try {
        const due = await emailKBStore.getDueConnections();
        if (due.length === 0) return;
        console.log(`[EmailKBSync] ${due.length} connection(s) due`);
        for (let i = 0; i < due.length; i += MAX_CONCURRENT) {
            await Promise.allSettled(due.slice(i, i + MAX_CONCURRENT).map(c => syncConnection(c)));
=======
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
        const dueConnections = await emailKBStore.getDueConnections();
        if (dueConnections.length === 0) return;

        console.log(`[EmailKBSync] ${dueConnections.length} connection(s) due for sync`);

        // Process in batches of MAX_CONCURRENT
        for (let i = 0; i < dueConnections.length; i += MAX_CONCURRENT) {
            const batch = dueConnections.slice(i, i + MAX_CONCURRENT);
            await Promise.allSettled(batch.map(conn => syncConnection(conn)));
>>>>>>> main
        }
    } catch (err) {
        console.error('[EmailKBSync] Tick error:', err.message);
    } finally {
        isRunning = false;
    }
}

<<<<<<< test2
function startEmailKBSync() {
    if (tickTimer) return;
    console.log('[EmailKBSync] Starting sync engine');
    setTimeout(() => { tick(); tickTimer = setInterval(tick, TICK_INTERVAL_MS); }, 30000);
}

function stopEmailKBSync() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

async function triggerManualSync(connectionId) {
    const conn = await emailKBStore.getConnectionWithTokens(connectionId);
    if (!conn) throw new Error('Connection not found');
    if (!conn.enabled) throw new Error('Connection is disabled');
    if (conn.sync_status === 'syncing') throw new Error('Sync already in progress');
    syncConnection(conn).catch(err => console.error('[EmailKBSync] Manual sync error:', err.message));
    return { message: 'Sync started' };
}

async function testConnection(connectionId) {
    const conn = await emailKBStore.getConnectionWithTokens(connectionId);
    if (!conn) throw new Error('Connection not found');

    let testEmail;
    if (conn.provider === 'gmail') {
        const { google } = require('googleapis');
        const { loadConfig } = require('../auth/permissions');
        const config = await loadConfig();
        const pc = config.providers?.google || {};
        const oauth2Client = new google.auth.OAuth2(pc.clientId, pc.clientSecret);
        oauth2Client.setCredentials({ access_token: conn.tokens.accessToken, refresh_token: conn.tokens.refreshToken });
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const list = await gmail.users.messages.list({ userId: 'me', maxResults: 1 });
        if (!list.data.messages?.length) return { success: true, message: 'Mailbox is empty' };
        const detail = await gmail.users.messages.get({ userId: 'me', id: list.data.messages[0].id, format: 'full' });
        const headers = detail.data.payload?.headers || [];
        testEmail = {
            subject: getHeader(headers, 'Subject'), from: getHeader(headers, 'From'),
            date: getHeader(headers, 'Date'), body: extractGmailTextBody(detail.data.payload),
        };
    } else {
        const res = await fetch('https://graph.microsoft.com/v1.0/me/messages?$top=1&$select=subject,from,receivedDateTime,body', {
            headers: { 'Authorization': `Bearer ${conn.tokens.accessToken}` },
        });
        if (!res.ok) throw new Error(`Outlook test failed: ${res.status}`);
        const data = await res.json();
        if (!data.value?.length) return { success: true, message: 'Mailbox is empty' };
        const msg = data.value[0];
        testEmail = {
            subject: msg.subject, from: msg.from?.emailAddress ? `${msg.from.emailAddress.name} <${msg.from.emailAddress.address}>` : '',
            date: msg.receivedDateTime, body: msg.body?.content || '',
        };
    }

    const result = await processEmail(testEmail.body, testEmail, { orgId: conn.organization_id });
    return { success: true, originalSubject: testEmail.subject, originalFrom: testEmail.from, preview: result };
}

module.exports = { startEmailKBSync, stopEmailKBSync, triggerManualSync, testConnection };
=======
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
 */
async function testConnection(connectionId) {
    const connection = await emailKBStore.getConnectionWithTokens(connectionId);
    if (!connection) throw new Error('Connection not found');

    // Temporarily create a session-like object for the tools
    const fakeSession = {
        accessToken: connection.tokens.accessToken,
        refreshToken: connection.tokens.refreshToken,
        oauthProvider: connection.provider === 'outlook' ? 'microsoft' : 'google',
    };

    let testEmail;

    if (connection.provider === 'gmail') {
        const { google } = require('googleapis');
        const { loadConfig } = require('../auth/permissions');
        const config = await loadConfig();
        const providerConfig = config.providers?.google || {};

        const oauth2Client = new google.auth.OAuth2(providerConfig.clientId, providerConfig.clientSecret);
        oauth2Client.setCredentials({
            access_token: fakeSession.accessToken,
            refresh_token: fakeSession.refreshToken,
        });

        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const list = await gmail.users.messages.list({ userId: 'me', maxResults: 1 });
        if (!list.data.messages?.length) return { success: true, message: 'Mailbox is empty', preview: null };

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
        const resp = await fetch(`${GRAPH_BASE}/me/messages?$top=1&$select=subject,from,receivedDateTime,body`, {
            headers: { 'Authorization': `Bearer ${fakeSession.accessToken}` },
        });
        if (!resp.ok) throw new Error(`Outlook test failed: ${resp.status}`);
        const data = await resp.json();
        if (!data.value?.length) return { success: true, message: 'Mailbox is empty', preview: null };

        const msg = data.value[0];
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
>>>>>>> main
