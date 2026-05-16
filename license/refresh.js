/**
 * License Refresh Scheduler
 *
 * Periodically pings license.beeflow.ai/v1/refresh for every monthly license
 * that hasn't been re-confirmed within the polling window. Yearly and
 * lifetime licenses are skipped — their JWT `exp` is the source of truth.
 *
 * Behaviour:
 *   - Successful response (status=active): reset last_refresh_at, mark active.
 *     A `new_token` field, when present, replaces the stored JWT so we can
 *     extend `expires_at` without re-activation by the user.
 *   - status=revoked  → markRevoked → tier falls back to community immediately.
 *   - status=expired  → markRefreshFailure with grace=0 → expired.
 *   - HTTP error / unreachable → markRefreshFailure → grace until window
 *     elapses, then expired.
 *
 * Scheduler frequency is controlled by LICENSE_REFRESH_INTERVAL_SECONDS
 * (default 3600 = once per hour). Each tick walks the set of monthly
 * licenses that haven't pinged in the last LICENSE_REFRESH_STALE_SECONDS
 * (default 86400 = 24h). Both knobs make it easy to test the flow without
 * waiting a real day.
 */

const fetch = require('node-fetch');
const store = require('./store');
const verify = require('./verify');
const { ADMIN_ISSUER } = require('./adminIssuance');

// Refresh is opt-in: leave LICENSE_REFRESH_URL unset and no pings happen at
// all. The JWT exp/signature remain the source of truth. This avoids the
// "freshly activated → grace → expired" failure mode when no real license
// server is reachable (e.g. dev installs, air-gapped customers, beta period
// before license.beeflow.ai is live).
const REFRESH_URL = process.env.LICENSE_REFRESH_URL || '';
const TICK_INTERVAL_SEC = parseInt(process.env.LICENSE_REFRESH_INTERVAL_SECONDS || '3600', 10);
const STALE_AFTER_SEC = parseInt(process.env.LICENSE_REFRESH_STALE_SECONDS || '86400', 10);
const GRACE_WINDOW_SEC = parseInt(process.env.LICENSE_GRACE_WINDOW_SECONDS || String(10 * 86400), 10);
const PER_REQUEST_TIMEOUT_MS = parseInt(process.env.LICENSE_REFRESH_TIMEOUT_MS || '10000', 10);

// CRL (revocation-list) poll — separate from the main refresh tick so it
// runs even when LICENSE_REFRESH_DISABLED=true. Use case: an air-gapped
// yearly license whose JWT exp is still in the future, but whose customer
// got refunded. The main refresh path is disabled; CRL is how we still
// learn about the revocation.
const CRL_URL = process.env.LICENSE_CRL_URL || '';
const CRL_INTERVAL_SEC = parseInt(process.env.LICENSE_CRL_INTERVAL_SECONDS || '900', 10);
const CRL_CONFIG_KEY = 'license_crl_last_since';

let _timer = null;
let _crlTimer = null;
const _health = {
    lastTickAt: null,
    lastTickDurationMs: null,
    lastTickError: null,
    lastTickProcessed: 0,
    disabledByEnv: false,
    enabled: false,
    crl: {
        lastTickAt: null,
        lastSince: null,
        lastError: null,
        lastProcessed: 0,
        enabled: false,
    },
};

/**
 * Fetch and apply the refresh result for one license.
 * Exported so the manual `POST /api/license/refresh` route can reuse it.
 */
async function refreshOne(lic) {
    if (!lic || !lic.id) throw new Error('refreshOne: missing license');
    if (lic.issuer === ADMIN_ISSUER) {
        return { skipped: true, reason: 'admin_issued_license' };
    }
    if (!REFRESH_URL) {
        return { skipped: true, reason: 'license_server_not_configured' };
    }
    if (lic.billingInterval && lic.billingInterval !== 'monthly') {
        return { skipped: true, reason: 'non_monthly_license' };
    }

    let resp, rawBody, body;
    try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), PER_REQUEST_TIMEOUT_MS);
        try {
            resp = await fetch(`${REFRESH_URL}?license_id=${encodeURIComponent(lic.id)}`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: ctrl.signal,
            });
        } finally {
            clearTimeout(timeout);
        }
        rawBody = await resp.text();
    } catch (e) {
        await store.markRefreshFailure(lic.id, { graceWindowSeconds: GRACE_WINDOW_SEC });
        console.warn(`[License Refresh] license.refresh.unreachable license_id=${lic.id} error=${e.message}`);
        return { ok: false, reason: 'unreachable', error: e.message };
    }

    if (!resp.ok) {
        await store.markRefreshFailure(lic.id, { graceWindowSeconds: GRACE_WINDOW_SEC });
        console.warn(`[License Refresh] license.refresh.http_error license_id=${lic.id} status=${resp.status}`);
        return { ok: false, reason: 'http_error', status: resp.status };
    }

    try {
        body = JSON.parse(rawBody);
    } catch (e) {
        await store.markRefreshFailure(lic.id, { graceWindowSeconds: GRACE_WINDOW_SEC });
        console.warn(`[License Refresh] license.refresh.malformed_response license_id=${lic.id} bytes=${rawBody.length} status=${resp.status}`);
        return { ok: false, reason: 'malformed_response', bytes: rawBody.length };
    }

    if (body.status === 'revoked') {
        await store.markRevoked(lic.id, body.reason || null);
        return { ok: true, status: 'revoked' };
    }
    if (body.status === 'expired') {
        // Only zero out grace when the local JWT exp is *itself* in the past.
        // Otherwise honour the standard window so a single bad reply from the
        // license server doesn't immediately nuke the customer's access.
        let graceWindow = GRACE_WINDOW_SEC;
        try {
            const expMs = lic.expiresAt ? new Date(lic.expiresAt).getTime() : null;
            if (Number.isFinite(expMs) && expMs <= Date.now()) graceWindow = 0;
        } catch (_) { /* fall through to default grace */ }
        await store.markRefreshFailure(lic.id, { graceWindowSeconds: graceWindow });
        console.log(`[License Refresh] license.refresh.expired license_id=${lic.id} grace_window_s=${graceWindow}`);
        return { ok: true, status: 'expired', graceWindow };
    }
    if (body.status === 'active') {
        if (body.new_token) {
            const v = await verify.verifyToken(body.new_token);
            if (!v.valid || v.payload.license_id !== lic.id) {
                await store.markRefreshFailure(lic.id, { graceWindowSeconds: GRACE_WINDOW_SEC });
                console.warn(`[License Refresh] license.refresh.bad_new_token license_id=${lic.id} reason=${v.error || 'payload_mismatch'}`);
                return { ok: false, reason: 'bad_new_token', error: v.error || 'payload_mismatch' };
            }
            const newExpiresAt = new Date(v.payload.exp * 1000).toISOString();
            await store.markRefreshSuccess(lic.id, {
                newToken: body.new_token,
                newExpiresAt,
            });
            return { ok: true, status: 'active', renewed: true };
        }
        await store.markRefreshSuccess(lic.id, { newToken: null, newExpiresAt: null });
        return { ok: true, status: 'active', renewed: false };
    }
    await store.markRefreshFailure(lic.id, { graceWindowSeconds: GRACE_WINDOW_SEC });
    console.warn(`[License Refresh] license.refresh.unknown_status license_id=${lic.id} status=${body.status}`);
    return { ok: false, reason: 'unknown_status', body };
}

async function tick() {
    const startedAt = Date.now();
    _health.lastTickAt = new Date(startedAt).toISOString();
    _health.lastTickError = null;
    let processed = 0;
    try {
        const due = await store.getLicensesNeedingRefresh(STALE_AFTER_SEC);
        if (due.length === 0) {
            _health.lastTickProcessed = 0;
            _health.lastTickDurationMs = Date.now() - startedAt;
            return;
        }
        console.log(`[License Refresh] Refreshing ${due.length} license(s)`);
        for (const lic of due) {
            try {
                await refreshOne(lic);
                processed++;
            } catch (e) {
                console.error(`[License Refresh] error for ${lic.id}: ${e.message}`);
            }
        }
    } catch (e) {
        _health.lastTickError = e.message;
        console.error(`[License Refresh] license.refresh.tick_error error=${e.message}`);
    } finally {
        _health.lastTickProcessed = processed;
        _health.lastTickDurationMs = Date.now() - startedAt;
    }
}

async function crlTick() {
    if (!CRL_URL) return;
    const startedAt = Date.now();
    _health.crl.lastTickAt = new Date(startedAt).toISOString();
    _health.crl.lastError = null;
    try {
        const configStore = require('../stores/configStore');
        const since = parseInt(await configStore.getConfig(CRL_CONFIG_KEY), 10) || 0;

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), PER_REQUEST_TIMEOUT_MS);
        let resp;
        try {
            resp = await fetch(`${CRL_URL}?since=${since}`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: ctrl.signal,
            });
        } finally {
            clearTimeout(timer);
        }
        if (!resp.ok) {
            _health.crl.lastError = `http_${resp.status}`;
            console.warn(`[License CRL] license.crl.http_error status=${resp.status}`);
            return;
        }
        const text = await resp.text();
        let body;
        try { body = JSON.parse(text); } catch (_e) {
            _health.crl.lastError = 'malformed_response';
            console.warn(`[License CRL] license.crl.malformed_response bytes=${text.length}`);
            return;
        }
        const list = Array.isArray(body.revoked) ? body.revoked : [];
        let processed = 0;
        for (const r of list) {
            if (!r || !r.license_id) continue;
            try {
                await store.markRevoked(r.license_id, r.reason || 'crl_revoked');
                processed++;
            } catch (e) {
                console.warn(`[License CRL] markRevoked failed license_id=${r.license_id} error=${e.message}`);
            }
        }
        const newSince = Number.isFinite(body.next_since) ? body.next_since : since;
        if (newSince > since) {
            try { await configStore.setConfig(CRL_CONFIG_KEY, newSince); } catch (_e) { /* best effort */ }
        }
        _health.crl.lastSince = newSince;
        _health.crl.lastProcessed = processed;
        if (processed > 0) console.log(`[License CRL] license.crl.processed revocations=${processed} next_since=${newSince}`);
    } catch (e) {
        _health.crl.lastError = e.name === 'AbortError' ? `timeout_${PER_REQUEST_TIMEOUT_MS}ms` : e.message;
        console.error(`[License CRL] license.crl.tick_error error=${_health.crl.lastError}`);
    } finally {
        _health.crl.lastTickDurationMs = Date.now() - startedAt;
    }
}

let _envWarnTimer = null;
function start() {
    // CRL poll first — it runs even when LICENSE_REFRESH_DISABLED=true so
    // air-gapped customers can still pull revocations for yearly licenses.
    if (CRL_URL && !_crlTimer) {
        _health.crl.enabled = true;
        setTimeout(() => { crlTick().catch(err => console.error('[License CRL] license.crl.tick_unhandled error=' + err.message)); }, 45000).unref();
        _crlTimer = setInterval(() => {
            crlTick().catch(err => console.error('[License CRL] license.crl.tick_unhandled error=' + err.message));
        }, CRL_INTERVAL_SEC * 1000);
        _crlTimer.unref();
        console.log(`[License CRL] Scheduler started — every ${CRL_INTERVAL_SEC}s, url=${CRL_URL}`);
    }

    if (_timer) return;
    if (process.env.LICENSE_REFRESH_DISABLED === 'true') {
        _health.disabledByEnv = true;
        console.log('[License Refresh] license.refresh.disabled_by_env reason=LICENSE_REFRESH_DISABLED=true');
        // Re-log once per 24h so ops dashboards don't lose track of the fact
        // that revocations are not being pulled from the license server.
        _envWarnTimer = setInterval(() => {
            console.log('[License Refresh] license.refresh.disabled_by_env reason=LICENSE_REFRESH_DISABLED=true');
        }, 24 * 60 * 60 * 1000);
        _envWarnTimer.unref();
        return;
    }
    if (!REFRESH_URL) {
        console.log('[License Refresh] Scheduler not started — LICENSE_REFRESH_URL not configured (JWT exp/sig is authoritative)');
        return;
    }
    _health.enabled = true;
    // Run one tick shortly after boot so a freshly restarted server catches up
    setTimeout(() => { tick().catch(err => console.error('[License Refresh] license.refresh.tick_unhandled error=' + err.message)); }, 30000).unref();
    _timer = setInterval(() => {
        tick().catch(err => console.error('[License Refresh] license.refresh.tick_unhandled error=' + err.message));
    }, TICK_INTERVAL_SEC * 1000);
    _timer.unref();
    console.log(`[License Refresh] Scheduler started — every ${TICK_INTERVAL_SEC}s, stale after ${STALE_AFTER_SEC}s, grace ${GRACE_WINDOW_SEC}s`);
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
    if (_crlTimer) { clearInterval(_crlTimer); _crlTimer = null; }
    if (_envWarnTimer) { clearInterval(_envWarnTimer); _envWarnTimer = null; }
}

function getRefresherHealth() {
    return { ..._health };
}

module.exports = { start, stop, tick, crlTick, refreshOne, getRefresherHealth };
