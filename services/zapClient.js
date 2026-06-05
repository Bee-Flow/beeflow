/**
 * ZAP REST Client — dependency-free wrapper over the OWASP ZAP daemon API.
 *
 * The security-scan AGENT mode drives a ZAP daemon (launched by
 * scanRunner.startZapDaemon) through its JSON REST API rather than the
 * one-shot zap-baseline/zap-full-scan scripts the container runner uses. This
 * module is the thin, deterministic transport layer for that: it builds query
 * strings, appends the api key on /action/ endpoints only, talks JSON, and
 * exposes the spider / passive-scan / active-scan / alerts surface the driver
 * needs — plus await* helpers that poll each phase to completion while
 * respecting a cancellation flag.
 *
 * Design notes mirroring the rest of the codebase (services/, core/_http.js):
 *   • No external deps — global fetch + AbortController, injectable as
 *     `fetchImpl` for tests.
 *   • Every request has a hard 15s timeout so a wedged daemon can't hang a
 *     poll loop forever (the await* loops layer their own maxMs on top).
 *   • The api key is a secret: _get appends it ONLY to action endpoints, and
 *     any thrown error message has the apikey query param scrubbed so it never
 *     lands in logs / the SSE 'terminal' stream / the durable progress tail.
 *   • Responses are parsed tolerantly — ZAP returns its numeric statuses and
 *     counts as strings, so we coerce. Garbage shapes degrade to []/0 rather
 *     than throwing, matching securityReportBuilder's "one flaky engine never
 *     sinks the scan" stance.
 *
 * ZAP risk strings are the canonical 'High'|'Medium'|'Low'|'Informational';
 * alertCounts buckets them onto the same four-key summary the report builder
 * and the 'scanstat' SSE event use.
 */

const REQUEST_TIMEOUT_MS = 15000;

// ── helpers ───────────────────────────────────────────────────────────

// Promise-wrapped setTimeout. The poll loops await this between status reads
// — no timestamp/random APIs, so the only clock in play is the loop's own
// elapsed budget (tracked via the resolved-count, not Date.now()).
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Strip any apikey token out of an arbitrary string so a secret never rides
// along in a thrown Error's message (which flows to logs + SSE). Matches both
// the query-param form (?apikey=… / &apikey=…) and a bare apikey=… token that
// the daemon might echo back inside a response body.
function scrubKey(s) {
    return String(s == null ? '' : s).replace(/apikey=[^&\s]*/gi, 'apikey=***');
}

// Coerce ZAP's string-typed numerics ("0".."100", "N") to a finite number, or 0.
function toNum(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
}

// Normalize whatever ZAP hands back into an array (it always wraps lists in a
// named key, but be defensive about nulls / single objects).
function toArray(v) {
    if (Array.isArray(v)) return v;
    if (v === null || v === undefined) return [];
    return [v];
}

// ── client factory ────────────────────────────────────────────────────

/**
 * Build a ZAP REST client bound to a running daemon.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl    — daemon base, e.g. "http://172.18.0.5:8080"
 * @param {string} opts.apiKey     — required on /action/ endpoints
 * @param {Function} [opts.fetchImpl] — fetch override for tests (defaults to global fetch)
 */
function makeZapClient({ baseUrl, apiKey, fetchImpl = fetch } = {}) {
    if (!baseUrl) throw new Error('makeZapClient: baseUrl required');
    const root = String(baseUrl).replace(/\/+$/, '');

    /**
     * Issue a GET against a ZAP JSON endpoint and return the parsed body.
     * The apikey is appended ONLY for /action/ paths (views are unauthenticated
     * on the daemon). Builds the query with URLSearchParams, enforces a 15s
     * AbortController timeout, throws on non-200, and scrubs the apikey out of
     * every error message it raises.
     *
     * @param {string} path   — e.g. "/JSON/spider/action/scan/"
     * @param {object} params — query params (values URL-encoded by URLSearchParams)
     */
    async function _get(path, params = {}) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
            if (v === undefined || v === null) continue;
            qs.set(k, String(v));
        }
        // This daemon is launched with a global api.key, so EVERY request
        // (views included) must carry it — ZAP 2.17 rejects keyless views with
        // "API key incorrect or not supplied". The key is scrubbed from any
        // thrown error message below so it never lands in logs / the SSE stream.
        if (apiKey) qs.set('apikey', apiKey);

        const query = qs.toString();
        const url = `${root}${path}${query ? `?${query}` : ''}`;

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        let res;
        try {
            res = await fetchImpl(url, { method: 'GET', signal: ctrl.signal });
        } catch (err) {
            // Network / abort failures: never echo the URL (it may carry the
            // apikey) — scrub the underlying message too.
            const e = new Error(`ZAP request to ${path} failed: ${scrubKey(err && err.message)}`);
            e.cause = err;
            throw e;
        } finally {
            clearTimeout(timer);
        }

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`ZAP ${res.status} at ${path}: ${scrubKey(text).slice(0, 400)}`);
        }

        const body = await res.text().catch(() => '');
        try {
            return body ? JSON.parse(body) : {};
        } catch (_) {
            throw new Error(`ZAP non-JSON response at ${path}: ${scrubKey(body).slice(0, 200)}`);
        }
    }

    // ── views / actions ────────────────────────────────────────────────

    // Readiness probe — the daemon answers this as soon as it's up. No apikey.
    async function getVersion() {
        const j = await _get('/JSON/core/view/version/');
        return j && j.version ? String(j.version) : '';
    }

    // Kick off a spider crawl; returns the spider scan id (ZAP gives it as a string).
    async function spiderScan(url) {
        const j = await _get('/JSON/spider/action/scan/', { url });
        return j && j.scan !== undefined ? String(j.scan) : '';
    }

    async function spiderStatus(spiderId) {
        const j = await _get('/JSON/spider/view/status/', { scanId: spiderId });
        return toNum(j && j.status);
    }

    async function spiderResults(spiderId) {
        const j = await _get('/JSON/spider/view/results/', { scanId: spiderId });
        return toArray(j && j.results).map(String);
    }

    // All URLs ZAP knows about (optionally scoped to a base url).
    async function listUrls(baseurl) {
        const j = await _get('/JSON/core/view/urls/', baseurl ? { baseurl } : {});
        return toArray(j && j.urls).map(String);
    }

    // Outstanding passive-scan queue depth — drains to 0 once ZAP has digested
    // every record the spider/proxy fed it.
    async function pscanRecordsToScan() {
        const j = await _get('/JSON/pscan/view/recordsToScan/');
        return toNum(j && j.recordsToScan);
    }

    // Launch the active scanner (recursing the whole tree under url).
    async function ascanScan(url) {
        const j = await _get('/JSON/ascan/action/scan/', { url, recurse: 'true' });
        return j && j.scan !== undefined ? String(j.scan) : '';
    }

    async function ascanStatus(ascanId) {
        const j = await _get('/JSON/ascan/view/status/', { scanId: ascanId });
        return toNum(j && j.status);
    }

    /**
     * Fetch alerts for a base url and project each onto the compact finding
     * shape the driver/report builder consume. `riskFilter` (a single risk
     * string or an array of them) optionally narrows to e.g. High+Medium.
     */
    async function listAlerts({ baseurl, riskFilter } = {}) {
        const j = await _get('/JSON/core/view/alerts/', baseurl ? { baseurl } : {});
        let alerts = toArray(j && j.alerts);

        if (riskFilter) {
            const wanted = new Set(
                (Array.isArray(riskFilter) ? riskFilter : [riskFilter])
                    .map(r => String(r).toLowerCase())
            );
            alerts = alerts.filter(a => a && wanted.has(String(a.risk).toLowerCase()));
        }

        return alerts.filter(Boolean).map(a => ({
            name: String(a.name || a.alert || '').trim() || 'Unnamed alert',
            risk: String(a.risk || 'Informational'),
            url: String(a.url || ''),
            confidence: a.confidence !== undefined ? String(a.confidence) : '',
            description: String(a.description || a.desc || ''),
            solution: String(a.solution || ''),
            reference: String(a.reference || ''),
        }));
    }

    /**
     * Bucket a list of (compact or raw) alerts into the four-key severity
     * summary used by the 'scanstat' SSE event. ZAP's risk strings map
     * directly: High/Medium/Low/Informational (anything else falls to
     * informational so nothing is silently dropped).
     */
    function alertCounts(alerts) {
        const counts = { high: 0, medium: 0, low: 0, informational: 0 };
        for (const a of toArray(alerts)) {
            if (!a) continue;
            const r = String(a.risk || '').toLowerCase();
            if (r === 'high') counts.high += 1;
            else if (r === 'medium') counts.medium += 1;
            else if (r === 'low') counts.low += 1;
            else counts.informational += 1;
        }
        return counts;
    }

    // ── phase pollers ──────────────────────────────────────────────────
    //
    // Each await* helper polls one phase to completion, reporting progress via
    // onProgress and bailing the instant isCancelled() returns truthy. They
    // resolve with the terminal observation ({ done, status/records }) rather
    // than throwing on cancel/timeout, so the driver decides how to react.

    /**
     * Poll spider status to 100. onProgress({ crawled, status }) fires each
     * tick with the live crawled-url count + percent. Resolves when complete,
     * cancelled, or the maxMs budget is exhausted.
     */
    async function awaitSpider(spiderId, { onProgress, isCancelled, pollMs = 2000, maxMs = 600000 } = {}) {
        const delay = Math.max(250, pollMs | 0);
        const ticks = Math.max(1, Math.ceil(maxMs / delay));
        for (let i = 0; i < ticks; i++) {
            if (typeof isCancelled === 'function' && isCancelled()) {
                return { done: false, cancelled: true, status: -1 };
            }
            const status = await spiderStatus(spiderId);
            let crawled = 0;
            try { crawled = (await spiderResults(spiderId)).length; } catch (_) { /* best-effort count */ }
            if (typeof onProgress === 'function') {
                try { onProgress({ crawled, status }); } catch (_) {}
            }
            if (status >= 100) return { done: true, status, crawled };
            await sleep(delay);
        }
        return { done: false, timedOut: true, status: await spiderStatus(spiderId).catch(() => 0) };
    }

    /**
     * Poll the passive-scan queue (recordsToScan) down to 0. onProgress({
     * records }) fires each tick. Resolves when drained, cancelled, or timed
     * out.
     */
    async function awaitPassive({ onProgress, isCancelled, pollMs = 2000, maxMs = 600000 } = {}) {
        const delay = Math.max(250, pollMs | 0);
        const ticks = Math.max(1, Math.ceil(maxMs / delay));
        for (let i = 0; i < ticks; i++) {
            if (typeof isCancelled === 'function' && isCancelled()) {
                return { done: false, cancelled: true, records: -1 };
            }
            const records = await pscanRecordsToScan();
            if (typeof onProgress === 'function') {
                try { onProgress({ records }); } catch (_) {}
            }
            if (records <= 0) return { done: true, records: 0 };
            await sleep(delay);
        }
        return { done: false, timedOut: true, records: await pscanRecordsToScan().catch(() => 0) };
    }

    /**
     * Poll active-scan status to 100. onProgress({ status }) fires each tick.
     * Resolves when complete, cancelled, or timed out.
     */
    async function awaitActive(ascanId, { onProgress, isCancelled, pollMs = 2000, maxMs = 600000 } = {}) {
        const delay = Math.max(250, pollMs | 0);
        const ticks = Math.max(1, Math.ceil(maxMs / delay));
        for (let i = 0; i < ticks; i++) {
            if (typeof isCancelled === 'function' && isCancelled()) {
                return { done: false, cancelled: true, status: -1 };
            }
            const status = await ascanStatus(ascanId);
            if (typeof onProgress === 'function') {
                try { onProgress({ status }); } catch (_) {}
            }
            if (status >= 100) return { done: true, status };
            await sleep(delay);
        }
        return { done: false, timedOut: true, status: await ascanStatus(ascanId).catch(() => 0) };
    }

    return {
        getVersion,
        spiderScan,
        spiderStatus,
        spiderResults,
        listUrls,
        pscanRecordsToScan,
        ascanScan,
        ascanStatus,
        listAlerts,
        alertCounts,
        awaitSpider,
        awaitPassive,
        awaitActive,
    };
}

module.exports = { makeZapClient };
