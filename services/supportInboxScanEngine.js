/**
 * Support Inbox Scan Engine — a one-off, on-demand "how fast did we answer in
 * the past?" scan over a connected support mailbox's HISTORY.
 *
 * Unlike the sync engine, this NEVER creates tickets. It reads historical email
 * thread metadata, pairs each first customer message with the first human reply
 * in the same thread, and stores AGGREGATE response-time stats on the inbox row
 * (support_inboxes.scan_result). Aggregate-only, crash-resumable via a lease,
 * and runs OFF the 90s sync tick so a long scan never blocks ingestion.
 *
 * Reuses the sessionless provider clients + parse helpers; mirrors the sync
 * engine's lock/SSE patterns. Tenancy is inherited: it only ever touches the one
 * inbox row it was asked to scan.
 */

const supportInboxStore = require('../stores/supportInboxStore');
const { gmailClientFromTokens, graphFetchFromTokens } = require('./email/providerClients');
const parse = require('./email/parse');

const SCAN_TICK_MS = parseInt(process.env.SUPPORT_SCAN_TICK_MS || '30000', 10);
const DEFAULT_WINDOW_DAYS = parseInt(process.env.SUPPORT_SCAN_WINDOW_DAYS || '180', 10);
const MAX_SCAN_THREADS = parseInt(process.env.SUPPORT_SCAN_MAX_THREADS || '2000', 10);
const PAGE_SIZE = 100;
const LEASE_MINUTES = 30;

let _timer = null;
let _emitEvent = null;

function _emit(event, inboxId, data = {}) {
    try {
        if (!_emitEvent) {
            const { supportEvents } = require('../routes/support');
            _emitEvent = (e, d) => supportEvents.emit('event', { event: e, data: d });
        }
        _emitEvent(event, { ...data, inboxId });
    } catch { /* never block the scan on the event bus */ }
}

function _percentile(sorted, p) {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[idx];
}

function _summarize(latencies) {
    const sorted = latencies.slice().sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
        p50Secs: _percentile(sorted, 0.5),
        p90Secs: _percentile(sorted, 0.9),
        avgSecs: sorted.length ? Math.round(sum / sorted.length) : null,
        minSecs: sorted.length ? sorted[0] : null,
        maxSecs: sorted.length ? sorted[sorted.length - 1] : null,
    };
}

function _isOutbound(fromAddress, labelIds, inboxAddress) {
    if (Array.isArray(labelIds) && labelIds.includes('SENT')) return true;
    const f = String(fromAddress || '').toLowerCase().trim();
    return !!(inboxAddress && f === String(inboxAddress).toLowerCase().trim());
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

async function scanGmail(inbox, onRefresh, onProgress) {
    const gmail = await gmailClientFromTokens(inbox.tokens, onRefresh);
    const afterTs = inbox.scan_after ? new Date(inbox.scan_after) : new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400000);
    const afterStr = afterTs.toISOString().split('T')[0].replace(/-/g, '/');

    const latencies = [];
    let threadsScanned = 0, threadsWithCustomer = 0, pairsFound = 0, noReply = 0, truncated = false;
    let pageToken = null;

    outer:
    do {
        const list = await gmail.users.threads.list({ userId: 'me', q: `after:${afterStr} -in:chats`, maxResults: PAGE_SIZE, pageToken: pageToken || undefined });
        const threads = list.data.threads || [];
        for (const th of threads) {
            if (threadsScanned >= MAX_SCAN_THREADS) { truncated = true; break outer; }
            threadsScanned++;
            try {
                const full = await gmail.users.threads.get({
                    userId: 'me', id: th.id, format: 'metadata', metadataHeaders: ['From', 'Date', 'Message-ID'],
                });
                const msgs = (full.data.messages || []).map(m => {
                    const headers = m.payload?.headers || [];
                    const from = parse.parseAddress(parse.getGmailHeader(headers, 'From'));
                    return {
                        ts: parseInt(m.internalDate, 10) || 0,
                        from,
                        outbound: _isOutbound(from, m.labelIds, inbox.email_address),
                        genuineInbound: !(m.labelIds || []).includes('SENT') && parse.isGenuineCustomerSender(from, inbox.email_address),
                    };
                }).sort((a, b) => a.ts - b.ts);

                const firstInbound = msgs.find(m => m.genuineInbound);
                if (!firstInbound) continue;
                threadsWithCustomer++;
                const firstReply = msgs.find(m => m.outbound && m.ts > firstInbound.ts);
                if (firstReply) { latencies.push(Math.round((firstReply.ts - firstInbound.ts) / 1000)); pairsFound++; }
                else noReply++;
            } catch (e) {
                console.warn(`[SupportScan] gmail thread ${th.id}:`, e.message);
            }
            if (threadsScanned % 25 === 0) onProgress?.({ processedThreads: threadsScanned, pairsFound });
        }
        pageToken = list.data.nextPageToken || null;
    } while (pageToken);

    return { threadsScanned, threadsWithCustomer, pairsFound, noReply, truncated, firstResponse: _summarize(latencies) };
}

// ── Outlook / Graph ───────────────────────────────────────────────────────────
// Weaker outbound detection than Gmail (no SENT label on a single message list):
// we group by conversationId and classify by sender == the mailbox address.

async function scanOutlook(inbox, onRefresh, onProgress) {
    const afterTs = inbox.scan_after ? new Date(inbox.scan_after) : new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400000);
    const convos = new Map(); // conversationId → [{ts, from, outbound, genuineInbound}]
    let url = `/me/messages?$filter=receivedDateTime ge ${afterTs.toISOString()}&$select=conversationId,from,sender,receivedDateTime,sentDateTime&$top=${PAGE_SIZE}&$orderby=receivedDateTime asc`;
    let fetched = 0;

    while (url) {
        const page = await graphFetchFromTokens(inbox.tokens, onRefresh, url);
        const items = page.value || [];
        for (const m of items) {
            const conv = m.conversationId || m.id;
            const from = String(m.from?.emailAddress?.address || m.sender?.emailAddress?.address || '').toLowerCase();
            const ts = new Date(m.sentDateTime || m.receivedDateTime || 0).getTime();
            const outbound = !!(inbox.email_address && from === String(inbox.email_address).toLowerCase().trim());
            const entry = { ts, from, outbound, genuineInbound: !outbound && parse.isGenuineCustomerSender(from, inbox.email_address) };
            if (!convos.has(conv)) convos.set(conv, []);
            convos.get(conv).push(entry);
            fetched++;
        }
        if (fetched >= MAX_SCAN_THREADS * 4) break; // bound message volume
        url = page['@odata.nextLink'] || null;
        onProgress?.({ processedThreads: convos.size, pairsFound: 0 });
    }

    const latencies = [];
    let threadsWithCustomer = 0, pairsFound = 0, noReply = 0;
    for (const msgs of convos.values()) {
        msgs.sort((a, b) => a.ts - b.ts);
        const firstInbound = msgs.find(m => m.genuineInbound);
        if (!firstInbound) continue;
        threadsWithCustomer++;
        const firstReply = msgs.find(m => m.outbound && m.ts > firstInbound.ts);
        if (firstReply) { latencies.push(Math.round((firstReply.ts - firstInbound.ts) / 1000)); pairsFound++; }
        else noReply++;
    }

    return {
        threadsScanned: convos.size, threadsWithCustomer, pairsFound, noReply,
        truncated: fetched >= MAX_SCAN_THREADS * 4, firstResponse: _summarize(latencies),
    };
}

// ── Orchestration ─────────────────────────────────────────────────────────────

async function runScanForInbox(inboxRow) {
    const lock = await supportInboxStore.acquireScanLock(inboxRow.id, LEASE_MINUTES);
    if (!lock.acquired) return false;
    const startedAt = new Date().toISOString();
    try {
        const inbox = await supportInboxStore.getInboxWithTokens(inboxRow.id);
        if (!inbox || !inbox.tokens || !inbox.tokens.accessToken) throw new Error('mailbox not connected (no tokens)');
        const onRefresh = (t) => supportInboxStore.updateTokens(inbox.id, t).catch(() => {});
        const onProgress = (p) => {
            supportInboxStore.setScanState(inbox.id, { progress: { ...p, startedAt } }).catch(() => {});
            _emit('scan_progress', inbox.id, p);
        };
        await supportInboxStore.setScanState(inbox.id, { status: 'running', progress: { processedThreads: 0, pairsFound: 0, startedAt } });

        let result;
        if (inbox.provider === 'gmail') result = await scanGmail(inbox, onRefresh, onProgress);
        else if (inbox.provider === 'outlook') result = await scanOutlook(inbox, onRefresh, onProgress);
        else throw new Error(`unsupported provider ${inbox.provider}`);

        const windowDays = inbox.scan_after
            ? Math.max(1, Math.round((Date.now() - new Date(inbox.scan_after).getTime()) / 86400000))
            : DEFAULT_WINDOW_DAYS;
        const finalResult = { ...result, provider: inbox.provider, windowDays, scannedAt: new Date().toISOString() };
        await supportInboxStore.setScanState(inbox.id, {
            status: 'done',
            progress: { processedThreads: result.threadsScanned, pairsFound: result.pairsFound, finishedAt: finalResult.scannedAt },
            result: finalResult,
        });
        _emit('scan_done', inbox.id, { ok: true });
        return true;
    } catch (e) {
        console.warn(`[SupportScan] inbox ${inboxRow.id}:`, e.message);
        await supportInboxStore.setScanState(inboxRow.id, { status: 'error', progress: { error: String(e.message).slice(0, 300), finishedAt: new Date().toISOString() } }).catch(() => {});
        _emit('scan_done', inboxRow.id, { ok: false, error: String(e.message).slice(0, 200) });
        return false;
    } finally {
        await supportInboxStore.releaseScanLock(inboxRow.id).catch(() => {});
    }
}

async function scanOneDue() {
    const due = await supportInboxStore.getDueScans();
    for (const row of due) {
        await runScanForInbox(row).catch(e => console.warn('[SupportScan] run error:', e.message));
    }
}

function startSupportInboxScan() {
    if (_timer) return;
    _timer = setInterval(() => { scanOneDue().catch(e => console.error('[SupportScan] tick error:', e.message)); }, SCAN_TICK_MS);
    if (_timer.unref) _timer.unref();
    console.log(`[SupportScan] started (interval=${SCAN_TICK_MS}ms)`);
}

function stopSupportInboxScan() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startSupportInboxScan, stopSupportInboxScan, scanOneDue, runScanForInbox, DEFAULT_WINDOW_DAYS };
