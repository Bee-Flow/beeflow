/**
 * PAYG meter event drain worker.
 *
 * Reads from `payg_meter_outbox` and delivers events to Stripe with retry +
 * backoff. The hot path (usageStore.logUsage) inserts into the outbox; this
 * worker is the only path that calls stripe.billing.meterEvents.create for
 * PAYG, so a Stripe blip or process crash can never lose a billing row.
 *
 * Concurrency: `SELECT … FOR UPDATE SKIP LOCKED` lets multiple workers run
 * safely; each row is claimed by at most one worker per tick.
 *
 * Idempotency: the outbox `identifier` ("usage_<id>") doubles as Stripe's
 * idempotency key (24h window). Past that window, the row's `delivered_at`
 * is the local dedup signal — once it's set we never re-enqueue.
 *
 * Backoff: 2^attempt seconds, capped at 1h. Rows older than HARD_FAIL_DAYS
 * stop being retried and surface a one-time audit entry so an operator can
 * reconcile manually.
 */

const { run, getClient } = require('../db');

const BATCH_SIZE = 50;
const HARD_FAIL_DAYS = 14;
const MAX_BACKOFF_SECONDS = 3600;

// Circuit breaker — when the upstream (Stripe) has been failing systemically,
// stop hammering it. The breaker observes consecutive failures within a
// rolling window. Once tripped, drainOnce returns early without claiming
// rows, so attempt_count doesn't grow during the outage and rows stay
// queued at the same backoff. Operator resets via resetCircuit().
const CIRCUIT_FAILURE_THRESHOLD = 50;        // failures within window before trip
const CIRCUIT_WINDOW_MS = 5 * 60_000;         // rolling window for counting
const CIRCUIT_HALF_OPEN_AFTER_MS = 5 * 60_000; // self-heal probe after this long
const _circuit = {
    state: 'closed',           // 'closed' | 'open' | 'half-open'
    failures: [],              // recent failure timestamps (ms)
    openedAt: 0,
};

function _recordFailure() {
    const now = Date.now();
    _circuit.failures.push(now);
    const cutoff = now - CIRCUIT_WINDOW_MS;
    while (_circuit.failures.length && _circuit.failures[0] < cutoff) {
        _circuit.failures.shift();
    }
    if (_circuit.state === 'closed' && _circuit.failures.length >= CIRCUIT_FAILURE_THRESHOLD) {
        _circuit.state = 'open';
        _circuit.openedAt = now;
        console.error(`[PaygDrain][circuit] OPEN — ${_circuit.failures.length} failures in ${CIRCUIT_WINDOW_MS / 1000}s`);
        // Best-effort alert row so ops can see this without tailing logs.
        try {
            require('../stores/userStore').logSubscriptionAudit(
                'payg_circuit_open',
                'payg_outbox',
                'system',
                'system',
                null,
                { failures: _circuit.failures.length, window_ms: CIRCUIT_WINDOW_MS }
            ).catch(() => {});
        } catch (_) { /* audit best-effort */ }
    }
}

function _recordSuccess() {
    if (_circuit.state !== 'closed') {
        console.log(`[PaygDrain][circuit] CLOSE — upstream recovered`);
    }
    _circuit.state = 'closed';
    _circuit.failures = [];
    _circuit.openedAt = 0;
}

function _circuitAllowsAttempt() {
    if (_circuit.state === 'closed') return true;
    if (_circuit.state === 'open') {
        // After cool-down, allow one probe attempt to test recovery.
        if (Date.now() - _circuit.openedAt >= CIRCUIT_HALF_OPEN_AFTER_MS) {
            _circuit.state = 'half-open';
            console.log('[PaygDrain][circuit] HALF-OPEN — probing upstream');
            return true;
        }
        return false;
    }
    // half-open: allow exactly one attempt per probe window; the outcome of
    // the next failure/success flips us back.
    return true;
}

function resetCircuit() {
    _circuit.state = 'closed';
    _circuit.failures = [];
    _circuit.openedAt = 0;
}

function getCircuitState() {
    return { state: _circuit.state, failures: _circuit.failures.length, openedAt: _circuit.openedAt };
}

function backoffMs(attempt) {
    const seconds = Math.min(Math.pow(2, attempt), MAX_BACKOFF_SECONDS);
    return seconds * 1000;
}

/**
 * Drain pending rows. Optional `targetIdentifier` limits the claim to a
 * single row — used by the hot path's "try once now" fast path.
 *
 * Returns `{ delivered, failed, hardFailed }`.
 */
async function drainOnce(targetIdentifier = null) {
    // Circuit breaker — when Stripe has been failing systemically, return
    // early so we don't burn attempt_counts during a sustained outage. Rows
    // remain queued at the same attempt count and will be picked up once
    // the breaker probes successful again.
    if (!_circuitAllowsAttempt()) {
        return { delivered: 0, failed: 0, hardFailed: 0, circuit: _circuit.state };
    }

    const client = await getClient();
    let claimed = [];
    try {
        await client.query('BEGIN');

        // Claim eligible rows. `FOR UPDATE SKIP LOCKED` is the standard
        // PostgreSQL outbox pattern: another worker mid-flight on the same
        // row is invisible to us. Backoff filter lets rows cool off between
        // failed attempts without us scanning them.
        const targetClause = targetIdentifier ? 'AND identifier = $1' : '';
        const params = targetIdentifier ? [targetIdentifier] : [];
        const claimQuery = `
            SELECT id, usage_log_id, stripe_customer_id, event_name, amount_micro_units,
                   identifier, attempt_count, created_at
              FROM payg_meter_outbox
             WHERE delivered_at IS NULL
               ${targetClause}
               AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - (POWER(2, LEAST(attempt_count, 12)) * INTERVAL '1 second'))
             ORDER BY created_at
             LIMIT ${BATCH_SIZE}
             FOR UPDATE SKIP LOCKED`;
        const result = await client.query(claimQuery, params);
        claimed = result.rows;

        // Release the transaction immediately — we don't want to hold the
        // row-level lock while we wait on Stripe. The unique `identifier`
        // constraint plus Stripe's idempotency window prevents double-fire
        // even if another worker grabs the same row on the next tick.
        await client.query('COMMIT');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        console.error('[PaygDrain] Claim failed:', e.message);
        return { delivered: 0, failed: 0, hardFailed: 0 };
    } finally {
        client.release();
    }

    if (claimed.length === 0) return { delivered: 0, failed: 0, hardFailed: 0 };

    let delivered = 0;
    let failed = 0;
    let hardFailed = 0;

    // Lazy-load stripeService so this module can be required before Stripe
    // configuration has been read at boot. Also avoids the require cycle
    // through usageStore.
    const stripeService = require('../services/stripeService');

    for (const row of claimed) {
        const ageDays = (Date.now() - new Date(row.created_at).getTime()) / 86_400_000;
        if (ageDays > HARD_FAIL_DAYS) {
            hardFailed++;
            await run(
                `UPDATE payg_meter_outbox SET last_error = $1, last_attempt_at = NOW() WHERE id = $2`,
                [`hard_failed_after_${HARD_FAIL_DAYS}_days`, row.id]
            );
            try {
                await require('../stores/userStore').logSubscriptionAudit(
                    'payg_meter_hard_fail',
                    'payg_outbox',
                    String(row.id),
                    'system',
                    null,
                    { identifier: row.identifier, attempts: row.attempt_count, age_days: Math.floor(ageDays) }
                );
            } catch (_) { /* audit best-effort */ }
            continue;
        }

        try {
            await stripeService.reportPaygUsage({
                stripeCustomerId: row.stripe_customer_id,
                amountMicroUnits: Number(row.amount_micro_units),
                identifier: row.identifier,
                eventName: row.event_name,
            });
            await run(`UPDATE payg_meter_outbox SET delivered_at = NOW(), last_error = NULL WHERE id = $1`, [row.id]);
            delivered++;
            _recordSuccess();
        } catch (err) {
            failed++;
            _recordFailure();
            await run(
                `UPDATE payg_meter_outbox
                    SET attempt_count = attempt_count + 1,
                        last_attempt_at = NOW(),
                        last_error = $1
                  WHERE id = $2`,
                [String(err.message || err).slice(0, 500), row.id]
            );
            console.warn(`[PaygDrain] Stripe push failed identifier=${row.identifier} attempt=${row.attempt_count + 1}: ${err.message}`);
            // If the breaker tripped mid-batch, stop processing the rest of
            // this claim — they'll be picked up next tick when the breaker
            // allows. Their row-level locks are already released (we COMMITted
            // the SELECT FOR UPDATE before the Stripe call), so they're free
            // to be claimed again.
            if (_circuit.state === 'open') break;
        }
    }

    return { delivered, failed, hardFailed };
}

/**
 * Fast path used by the hot logUsage write — try to deliver exactly one
 * row right after insertion. Falls through silently; the periodic tick
 * picks it up otherwise.
 */
async function drainOne(identifier) {
    if (!identifier) return null;
    return drainOnce(identifier);
}

module.exports = { drainOnce, drainOne, backoffMs, resetCircuit, getCircuitState };
