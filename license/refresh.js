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

let _timer = null;

/**
 * Fetch and apply the refresh result for one license.
 * Exported so the manual `POST /api/license/refresh` route can reuse it.
 */
async function refreshOne(lic) {
    if (!lic || !lic.id) throw new Error('refreshOne: missing license');
    // Admin-issued licenses have no upstream server to ping — they live or die
    // by expires_at alone. Skipping prevents the refresh-failure → grace →
    // expired cascade that would otherwise nuke every admin grant.
    if (lic.issuer === ADMIN_ISSUER) {
        return { skipped: true, reason: 'admin_issued_license' };
    }
    // Without a configured license server, refresh is a no-op — JWT exp/sig
    // remain the source of truth. The license is left in 'active' state.
    if (!REFRESH_URL) {
        return { skipped: true, reason: 'license_server_not_configured' };
    }
    // Skip non-monthly licenses — they are validated by JWT exp only.
    if (lic.billingInterval && lic.billingInterval !== 'monthly') {
        return { skipped: true, reason: 'non_monthly_license' };
    }

    let resp, body;
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
        body = await resp.json().catch(() => ({}));
    } catch (e) {
        await store.markRefreshFailure(lic.id, { graceWindowSeconds: GRACE_WINDOW_SEC });
        return { ok: false, reason: 'unreachable', error: e.message };
    }

    if (!resp.ok) {
        await store.markRefreshFailure(lic.id, { graceWindowSeconds: GRACE_WINDOW_SEC });
        return { ok: false, reason: 'http_error', status: resp.status };
    }

    if (body.status === 'revoked') {
        await store.markRevoked(lic.id, body.reason || null);
        return { ok: true, status: 'revoked' };
    }
    if (body.status === 'expired') {
        await store.markRefreshFailure(lic.id, { graceWindowSeconds: 0 });
        return { ok: true, status: 'expired' };
    }
    if (body.status === 'active') {
        let newExpiresAt = null;
        if (body.new_token) {
            const v = await verify.verifyToken(body.new_token);
            if (v.valid && v.payload.license_id === lic.id) {
                newExpiresAt = new Date(v.payload.exp * 1000).toISOString();
            }
        }
        await store.markRefreshSuccess(lic.id, {
            newToken: body.new_token || null,
            newExpiresAt,
        });
        return { ok: true, status: 'active', renewed: !!body.new_token };
    }
    // Unknown status — treat like a failed refresh
    await store.markRefreshFailure(lic.id, { graceWindowSeconds: GRACE_WINDOW_SEC });
    return { ok: false, reason: 'unknown_status', body };
}

async function tick() {
    try {
        const due = await store.getLicensesNeedingRefresh(STALE_AFTER_SEC);
        if (due.length === 0) return;
        console.log(`[License Refresh] Refreshing ${due.length} license(s)`);
        for (const lic of due) {
            try { await refreshOne(lic); } catch (e) {
                console.error(`[License Refresh] error for ${lic.id}:`, e.message);
            }
        }
    } catch (e) {
        console.error('[License Refresh] tick error:', e.message);
    }
}

function start() {
    if (_timer) return;
    if (process.env.LICENSE_REFRESH_DISABLED === 'true') {
        console.log('[License Refresh] Disabled via LICENSE_REFRESH_DISABLED=true');
        return;
    }
    if (!REFRESH_URL) {
        console.log('[License Refresh] Scheduler not started — LICENSE_REFRESH_URL not configured (JWT exp/sig is authoritative)');
        return;
    }
    // Run one tick shortly after boot so a freshly restarted server catches up
    setTimeout(() => { tick().catch(() => {}); }, 30000).unref();
    _timer = setInterval(() => { tick().catch(() => {}); }, TICK_INTERVAL_SEC * 1000);
    _timer.unref();
    console.log(`[License Refresh] Scheduler started — every ${TICK_INTERVAL_SEC}s, stale after ${STALE_AFTER_SEC}s, grace ${GRACE_WINDOW_SEC}s`);
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, tick, refreshOne };
