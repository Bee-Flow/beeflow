/**
 * Email KB Sync Engine — Background polling service
 *
 * Periodically syncs connected email mailboxes, processes new emails
 * through the AI pipeline, and ingests them into the knowledge base.
 *
 * Works for both org-scoped and consumer (no-org) accounts.
 */

const emailKBStore = require('../stores/emailKBStore');
const { processEmail, processEmailThread } = require('../core/emailKBProcessor');
const { ingestDocument } = require('../core/kbIngestionHelpers');

const MAX_CONCURRENT = 3;
const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_EMAILS_PER_SYNC = 50;

let tickTimer = null;
let isRunning = false;

// ── Gmail Sync ───────────────────────────────────────────────────────────────

async function syncGmailConnection(connection) {
    const { google } = require('googleapis');
    const { loadConfig } = require('../auth/permissions');

    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};
    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Google OAuth not configured');
    }

    const tokens = emailKBStore.decryptTokens(connection.encrypted_tokens);
    if (!tokens?.accessToken) throw new Error('No valid OAuth tokens');

    const oauth2Client = new google.auth.OAuth2(providerConfig.clientId, providerConfig.clientSecret);
    oauth2Client.setCredentials({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken });

    oauth2Client.on('tokens', async (newTokens) => {
        const updated = { ...tokens };
        if (newTokens.access_token) updated.accessToken = newTokens.access_token;
        if (newTokens.refresh_token) updated.refreshToken = newTokens.refresh_token;
        await emailKBStore.updateTokens(connection.id, updated);
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const afterDate = connection.last_sync_at
        ? new Date(connection.last_sync_at).toISOString().split('T')[0].replace(/-/g, '/')
        : (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().split('T')[0].replace(/-/g, '/'); })();

    const response = await gmail.users.messages.list({
        userId: 'me', q: `after:${afterDate}`,
        labelIds: ['INBOX'], maxResults: MAX_EMAILS_PER_SYNC,
    });

    const messageIds = response.data.messages || [];
    console.log(`[EmailKBSync] Gmail: ${messageIds.length} messages found`);

    const results = { fetched: messageIds.length, created: 0, skipped: 0, errors: 0, errorDetails: [] };

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
}

function decodeBase64Url(data) {
    if (!data) return '';
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function extractGmailTextBody(payload) {
    if (!payload) return '';
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
        }
    }
    return '';
}

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
    const messages = data.value || [];
    console.log(`[EmailKBSync] Outlook: ${messages.length} messages found`);

    const results = { fetched: messages.length, created: 0, skipped: 0, errors: 0, errorDetails: [] };

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
    await emailKBStore.updateSyncState(connection.id, { syncStatus: 'syncing', syncError: null });

    let results;
    try {
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
        }
    } catch (err) {
        console.error('[EmailKBSync] Tick error:', err.message);
    } finally {
        isRunning = false;
    }
}

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
