/**
 * Web Vitals API — receives Core Web Vitals beacons from the browser.
 *
 * Log-only (no DB persistence). Each beacon represents one metric reading
 * (CLS, INP, LCP, FCP, TTFB) for one page load, sent fire-and-forget by
 * the client. The goal is to get a real-user perf baseline into the server
 * log so it can be aggregated downstream (Loki / a follow-up dashboard)
 * and so refactor PRs can be compared against a known starting point.
 *
 * Intentionally unauthenticated — TTFB / FCP fire before the session is
 * established and any auth gate produces a 500/401 cascade that never
 * reaches the log. Best-effort userId capture from req.session when one
 * happens to be present.
 */

const express = require('express');

const router = express.Router();

const VALID_METRICS = new Set(['CLS', 'INP', 'LCP', 'FCP', 'TTFB']);
const VALID_RATINGS = new Set(['good', 'needs-improvement', 'poor']);

function truncate(s, max) {
    if (typeof s !== 'string') return '';
    return s.length > max ? s.slice(0, max) + '…[truncated]' : s;
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

router.post('/', (req, res) => {
    try {
        const body = req.body || {};
        const name = String(body.name || '');
        if (!VALID_METRICS.has(name)) {
            // Silently drop unknown metric names — no point in logging spam.
            res.status(204).end();
            return;
        }
        const rating = String(body.rating || '');
        const entry = {
            name,
            value: num(body.value),
            delta: num(body.delta),
            id: truncate(String(body.id || ''), 64),
            rating: VALID_RATINGS.has(rating) ? rating : '',
            navigationType: truncate(String(body.navigationType || ''), 32),
            url: truncate(String(body.url || ''), 512),
            at: truncate(String(body.at || new Date().toISOString()), 48),
            buildSha: truncate(String(body.buildSha || ''), 64),
            userId: req.session?.user?.id || req.session?.user?.username || null,
        };
        console.info('[WebVitals]', JSON.stringify(entry));
    } catch (e) {
        console.error('[WebVitals] handler failed:', e);
    }
    res.status(204).end();
});

module.exports = router;
