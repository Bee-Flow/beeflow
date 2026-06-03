/**
 * Security Report Builder — normalize, aggregate, render & persist scan output.
 *
 * The scan worker (server/workers/scanRunner.js) runs one or more engine
 * containers (ZAP / Nuclei / testssl.sh), each dropping a `report.json` in its
 * own sub-workdir. This module is the deterministic, side-effect-light back half
 * of that pipeline:
 *
 *   1. normalizeZap / normalizeNuclei / normalizeTestssl — turn each engine's
 *      native JSON into a flat array of findings with a single severity scale
 *      ('high' | 'medium' | 'low' | 'informational').
 *   2. aggregate — merge all engines' findings and roll up a severity summary.
 *   3. renderReportHtml — build a self-contained, accessible report page
 *      (exec summary, severity-grouped table, per-finding remediation, scope
 *      footer). NO purple/violet/indigo anywhere — neutral grays + red/amber/
 *      blue/slate for severities (hard project rule).
 *   4. persistReportWebpage — store the rendered page through webpageStore so
 *      it shows up in the user's Webpages list and can be shared like any other.
 *
 * Everything except persistReportWebpage is pure: same input → same output, no
 * network, no clock reads (timestamps are passed in by the caller). That keeps
 * the report reproducible and trivially unit-testable.
 */

const crypto = require('crypto');

// Canonical severity scale, ordered most→least severe. Used for sorting,
// bucketing and summary keys so every engine speaks the same language.
const SEVERITY_ORDER = ['high', 'medium', 'low', 'informational'];

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * HTML-escape a value for safe interpolation into the report. Findings come
 * from third-party scanners pointed at attacker-influenced targets, so every
 * scrap of engine text is treated as hostile and escaped before rendering.
 */
function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sha256(s) {
    return crypto.createHash('sha256').update(s || '', 'utf8').digest('hex');
}

// Coerce whatever the scanner handed us into a non-empty trimmed string, or ''.
function str(v) {
    if (v === null || v === undefined) return '';
    return String(v).trim();
}

// Pull the hostname out of a target URL for display + the webpage name. Falls
// back to the raw string if it doesn't parse as a URL (e.g. bare host:port).
function hostOf(targetUrl) {
    try {
        return new URL(targetUrl).host || str(targetUrl);
    } catch (_) {
        return str(targetUrl) || 'target';
    }
}

// Clamp arbitrary engine severity labels onto the canonical scale.
function clampSeverity(raw) {
    const s = str(raw).toLowerCase();
    if (s === 'high' || s === 'critical') return 'high';
    if (s === 'medium' || s === 'moderate') return 'medium';
    if (s === 'low') return 'low';
    // 'info', 'informational', 'ok', '', and anything unrecognized are
    // treated as informational so they're surfaced but never raise the count.
    return 'informational';
}

// ── Engine normalizers ─────────────────────────────────────────────────
//
// Each returns an array of findings shaped:
//   { engine, name, severity, confidence?, description, solution?, reference?,
//     instanceCount, sampleInstances? }
// All are tolerant of partial/garbage JSON — a broken report yields [] rather
// than throwing, so one flaky engine never sinks the whole scan.

/**
 * OWASP ZAP — JSON report has `site[].alerts[]`, each alert carrying a
 * `riskcode` (3=High, 2=Medium, 1=Low, 0=Informational), `confidence`,
 * `desc`/`solution`/`reference` (HTML fragments), and `instances[]`.
 */
function normalizeZap(json) {
    const out = [];
    const sites = Array.isArray(json?.site) ? json.site : (json?.site ? [json.site] : []);
    for (const site of sites) {
        const alerts = Array.isArray(site?.alerts) ? site.alerts : [];
        for (const a of alerts) {
            if (!a) continue;
            const riskcode = parseInt(a.riskcode, 10);
            const severity = riskcode === 3 ? 'high'
                : riskcode === 2 ? 'medium'
                : riskcode === 1 ? 'low'
                : 'informational';
            const instances = Array.isArray(a.instances) ? a.instances : [];
            out.push({
                engine: 'zap',
                name: str(a.alert || a.name) || 'Unnamed alert',
                severity,
                confidence: str(a.confidence) || undefined,
                // ZAP descriptions/solutions are HTML; we strip tags so they're
                // safe to re-escape and read as plain text in the table.
                description: stripTags(a.desc || a.description),
                solution: stripTags(a.solution) || undefined,
                reference: stripTags(a.reference) || undefined,
                instanceCount: instances.length || parseInt(a.count, 10) || 0,
                sampleInstances: instances.slice(0, 5).map(i => str(i.uri)).filter(Boolean),
            });
        }
    }
    return out;
}

/**
 * Nuclei — `-je` writes either a JSON array or newline-delimited JSON objects.
 * Each entry has `info.severity`, `info.name`, `info.description`,
 * `info.remediation`, `info.reference`, and a `matched-at`/`host` locator.
 */
function normalizeNuclei(json) {
    const entries = coerceJsonLines(json);
    // Nuclei emits one row per match; collapse duplicates of the same template
    // into a single finding with an instance count + sample locators.
    const byKey = new Map();
    for (const e of entries) {
        if (!e || typeof e !== 'object') continue;
        const info = e.info && typeof e.info === 'object' ? e.info : {};
        const name = str(info.name) || str(e['template-id']) || str(e.templateID) || 'Nuclei finding';
        const severity = clampSeverity(info.severity);
        const key = `${e['template-id'] || e.templateID || name}|${severity}`;
        const locator = str(e['matched-at'] || e.matched || e.host || e.url);
        const ref = Array.isArray(info.reference) ? info.reference.filter(Boolean).join(', ') : str(info.reference);
        if (byKey.has(key)) {
            const f = byKey.get(key);
            f.instanceCount += 1;
            if (locator && f.sampleInstances.length < 5 && !f.sampleInstances.includes(locator)) {
                f.sampleInstances.push(locator);
            }
        } else {
            byKey.set(key, {
                engine: 'nuclei',
                name,
                severity,
                description: str(info.description) || undefined,
                solution: str(info.remediation) || undefined,
                reference: ref || undefined,
                instanceCount: 1,
                sampleInstances: locator ? [locator] : [],
            });
        }
    }
    return [...byKey.values()];
}

/**
 * testssl.sh — `--jsonfile` writes a flat array of { id, severity, finding }
 * objects (severity ∈ HIGH/MEDIUM/LOW/OK/INFO/WARN). We drop the OK rows —
 * they're "this is fine" noise — and surface everything that flags a concern.
 */
function normalizeTestssl(json) {
    const rows = Array.isArray(json) ? json : (Array.isArray(json?.scanResult) ? json.scanResult : []);
    const out = [];
    for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        const rawSev = str(r.severity).toUpperCase();
        // OK / DEBUG rows are passing checks — not findings.
        if (rawSev === 'OK' || rawSev === 'DEBUG' || rawSev === '') continue;
        const severity = rawSev === 'HIGH' || rawSev === 'CRITICAL' ? 'high'
            : rawSev === 'MEDIUM' ? 'medium'
            : rawSev === 'LOW' || rawSev === 'WARN' ? 'low'
            : 'informational';
        out.push({
            engine: 'testssl',
            name: str(r.id) || 'TLS finding',
            severity,
            description: str(r.finding) || undefined,
            instanceCount: 1,
        });
    }
    return out;
}

// ── Normalizer utilities ───────────────────────────────────────────────

// Best-effort HTML→text: drop tags, collapse whitespace. ZAP ships HTML in its
// text fields; we don't want markup leaking into an escaped plain-text cell.
function stripTags(v) {
    const s = str(v);
    if (!s) return '';
    return s
        .replace(/<\s*br\s*\/?>/gi, ' ')
        .replace(/<\/p>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Accept an already-parsed array, a parsed object, or a raw string that is
// either JSON or newline-delimited JSON (Nuclei's `-je` default). Returns a
// flat array of parsed entries; never throws.
function coerceJsonLines(json) {
    if (Array.isArray(json)) return json;
    if (json && typeof json === 'object') return [json];
    if (typeof json !== 'string') return [];
    const trimmed = json.trim();
    if (!trimmed) return [];
    // Whole-string JSON first (array or single object).
    try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch (_) { /* fall through to line-delimited */ }
    const out = [];
    for (const line of trimmed.split('\n')) {
        const l = line.trim();
        if (!l) continue;
        try { out.push(JSON.parse(l)); } catch (_) { /* skip malformed line */ }
    }
    return out;
}

// ── Aggregation ─────────────────────────────────────────────────────────

/**
 * Merge findings from every engine into one list and roll up a severity
 * summary. `findingArrays` is an array-of-arrays (one per engine). Findings
 * are sorted high→informational, then by instance count desc, so the report's
 * table leads with what matters.
 */
function aggregate(findingArrays) {
    const findings = [];
    for (const arr of (Array.isArray(findingArrays) ? findingArrays : [])) {
        if (Array.isArray(arr)) findings.push(...arr);
    }

    const severitySummary = { high: 0, medium: 0, low: 0, informational: 0 };
    for (const f of findings) {
        const sev = SEVERITY_ORDER.includes(f.severity) ? f.severity : 'informational';
        severitySummary[sev] += 1;
    }

    findings.sort((a, b) => {
        const sa = SEVERITY_ORDER.indexOf(a.severity);
        const sb = SEVERITY_ORDER.indexOf(b.severity);
        if (sa !== sb) return sa - sb;
        return (b.instanceCount || 0) - (a.instanceCount || 0);
    });

    return { findings, severitySummary };
}

// ── HTML rendering ───────────────────────────────────────────────────────

// Severity → palette. Strictly red / amber / blue / slate — never purple,
// violet or indigo (hard project rule). These are the only colored accents in
// the whole report; everything else is neutral gray.
const SEVERITY_STYLE = {
    high: { label: 'High', color: '#b91c1c', bg: '#fef2f2', border: '#fecaca' },
    medium: { label: 'Medium', color: '#b45309', bg: '#fffbeb', border: '#fde68a' },
    low: { label: 'Low', color: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe' },
    informational: { label: 'Informational', color: '#475569', bg: '#f8fafc', border: '#e2e8f0' },
};

const ENGINE_LABEL = {
    zap: 'OWASP ZAP',
    nuclei: 'Nuclei',
    testssl: 'testssl.sh',
};

function fmtTimestamp(ts) {
    if (!ts) return '—';
    try {
        const d = new Date(ts);
        if (isNaN(d.getTime())) return esc(ts);
        return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    } catch (_) {
        return esc(ts);
    }
}

/**
 * Render the self-contained report page. Returns { html, css } as separate
 * strings so they can be written to the html/css slots independently — the
 * <link> is wired up by the webpage runtime, matching every other webpage.
 *
 * @param {object} p
 * @param {string} p.targetUrl
 * @param {Array}  p.engines           — engine descriptors [{engine, intensity?}]
 * @param {Array}  p.findings          — aggregated, sorted findings
 * @param {object} p.severitySummary   — { high, medium, low, informational }
 * @param {string} p.startedAt
 * @param {string} p.finishedAt
 */
function renderReportHtml({ targetUrl, engines, findings, severitySummary, startedAt, finishedAt }) {
    const host = hostOf(targetUrl);
    const safeFindings = Array.isArray(findings) ? findings : [];
    const summary = severitySummary || { high: 0, medium: 0, low: 0, informational: 0 };
    const engineList = Array.isArray(engines) ? engines : [];

    const totalFindings = safeFindings.length;
    const engineNames = engineList
        .map(e => `${ENGINE_LABEL[e.engine] || e.engine}${e.engine === 'zap' && e.intensity ? ` (${e.intensity})` : ''}`)
        .filter(Boolean);

    // Severity summary cards — one per bucket, colored only by its accent.
    const cards = SEVERITY_ORDER.map(sev => {
        const s = SEVERITY_STYLE[sev];
        const count = summary[sev] || 0;
        return `
        <div class="card card--${sev}">
            <div class="card__count">${count}</div>
            <div class="card__label">${esc(s.label)}</div>
        </div>`;
    }).join('');

    // Finding rows — table for scanability, with a remediation block per row.
    const rows = safeFindings.length === 0
        ? `<tr><td colspan="4" class="empty">No findings — the selected engines reported nothing actionable for this target.</td></tr>`
        : safeFindings.map((f, i) => {
            const sev = SEVERITY_ORDER.includes(f.severity) ? f.severity : 'informational';
            const s = SEVERITY_STYLE[sev];
            const samples = Array.isArray(f.sampleInstances) && f.sampleInstances.length
                ? `<div class="finding__samples"><span class="finding__samples-label">Sample locations</span><ul>${
                    f.sampleInstances.map(loc => `<li><code>${esc(loc)}</code></li>`).join('')
                  }</ul></div>`
                : '';
            const remediation = f.solution
                ? `<div class="finding__remediation"><span class="finding__remediation-label">Remediation</span><p>${esc(f.solution)}</p></div>`
                : '';
            const reference = f.reference
                ? `<div class="finding__ref"><span class="finding__ref-label">Reference</span> <span>${esc(f.reference)}</span></div>`
                : '';
            const confidence = f.confidence
                ? `<span class="finding__confidence">Confidence: ${esc(f.confidence)}</span>`
                : '';
            return `
        <tr class="finding finding--${sev}">
            <td class="finding__sev"><span class="badge badge--${sev}">${esc(s.label)}</span></td>
            <td class="finding__engine">${esc(ENGINE_LABEL[f.engine] || f.engine)}</td>
            <td class="finding__count">${parseInt(f.instanceCount, 10) || 0}</td>
            <td class="finding__detail">
                <div class="finding__name">${i + 1}. ${esc(f.name)} ${confidence}</div>
                ${f.description ? `<p class="finding__desc">${esc(f.description)}</p>` : ''}
                ${samples}
                ${remediation}
                ${reference}
            </td>
        </tr>`;
        }).join('');

    const durationMs = (() => {
        const a = startedAt ? new Date(startedAt).getTime() : NaN;
        const b = finishedAt ? new Date(finishedAt).getTime() : NaN;
        if (isNaN(a) || isNaN(b) || b < a) return null;
        return b - a;
    })();
    const durationLabel = durationMs === null ? '—'
        : durationMs < 1000 ? `${durationMs} ms`
        : `${(durationMs / 1000).toFixed(1)} s`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Security report — ${esc(host)}</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <main class="report" role="main">
        <header class="report__header">
            <div class="report__title">
                <span class="report__icon" aria-hidden="true">🛡️</span>
                <div>
                    <h1>Security scan report</h1>
                    <p class="report__target"><span class="report__target-label">Target</span> <code>${esc(targetUrl)}</code></p>
                </div>
            </div>
            <dl class="report__meta">
                <div><dt>Engines</dt><dd>${engineNames.length ? esc(engineNames.join(', ')) : '—'}</dd></div>
                <div><dt>Started</dt><dd>${fmtTimestamp(startedAt)}</dd></div>
                <div><dt>Finished</dt><dd>${fmtTimestamp(finishedAt)}</dd></div>
                <div><dt>Duration</dt><dd>${esc(durationLabel)}</dd></div>
            </dl>
        </header>

        <section class="summary" aria-label="Executive summary">
            <h2>Executive summary</h2>
            <p class="summary__lead">
                ${totalFindings === 0
                    ? `The scan completed with <strong>no actionable findings</strong> across ${engineNames.length || 'the selected'} engine${engineNames.length === 1 ? '' : 's'}.`
                    : `The scan surfaced <strong>${totalFindings}</strong> finding${totalFindings === 1 ? '' : 's'} across ${engineNames.length || 'the selected'} engine${engineNames.length === 1 ? '' : 's'}, including <strong>${summary.high || 0}</strong> high-severity item${(summary.high || 0) === 1 ? '' : 's'}.`}
            </p>
            <div class="cards">${cards}</div>
        </section>

        <section class="findings" aria-label="Findings">
            <h2>Findings</h2>
            <table class="findings__table">
                <thead>
                    <tr>
                        <th scope="col">Severity</th>
                        <th scope="col">Engine</th>
                        <th scope="col">Count</th>
                        <th scope="col">Detail &amp; remediation</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </section>

        <footer class="report__footer">
            <p>
                This report was produced by an <strong>authorized</strong> automated security scan of
                <code>${esc(host)}</code>, run only against assets the requester confirmed they are
                permitted to test. Findings are point-in-time and may include false positives — validate
                before acting. Do not redistribute outside the authorized scope.
            </p>
            <p class="report__footer-meta">Generated ${fmtTimestamp(finishedAt)} · Bee Flow Security Scan</p>
        </footer>
    </main>
</body>
</html>`;

    const css = `/* Security report — self-contained styling.
   Palette: neutral grays + red(#b91c1c)/amber(#b45309)/blue(#1d4ed8)/slate(#475569)
   for severities only. Cool blue/red accents — never any warm-magenta family. */
:root {
    --ink: #0f172a;
    --ink-soft: #334155;
    --muted: #64748b;
    --line: #e2e8f0;
    --line-strong: #cbd5e1;
    --bg: #f8fafc;
    --panel: #ffffff;
    --high: #b91c1c;
    --medium: #b45309;
    --low: #1d4ed8;
    --informational: #475569;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9em;
    background: #f1f5f9;
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0.05em 0.4em;
    word-break: break-all;
}
.report { max-width: 960px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }

.report__header {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 1.5rem;
    margin-bottom: 1.5rem;
}
.report__title { display: flex; gap: 1rem; align-items: flex-start; }
.report__icon { font-size: 2rem; line-height: 1; }
.report__title h1 { margin: 0 0 0.35rem; font-size: 1.5rem; letter-spacing: -0.01em; }
.report__target { margin: 0; color: var(--ink-soft); font-size: 0.95rem; }
.report__target-label { color: var(--muted); margin-right: 0.35rem; }
.report__meta {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 0.75rem 1.5rem;
    margin: 1.25rem 0 0;
    padding-top: 1.25rem;
    border-top: 1px solid var(--line);
}
.report__meta div { margin: 0; }
.report__meta dt { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
.report__meta dd { margin: 0.15rem 0 0; font-weight: 600; color: var(--ink); }

.summary, .findings { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
h2 { margin: 0 0 1rem; font-size: 1.15rem; letter-spacing: -0.01em; }
.summary__lead { margin: 0 0 1.25rem; color: var(--ink-soft); }

.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 0.85rem; }
.card { border: 1px solid var(--line); border-radius: 10px; padding: 1rem; text-align: center; background: var(--bg); }
.card__count { font-size: 2rem; font-weight: 700; line-height: 1; }
.card__label { margin-top: 0.35rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
.card--high { border-color: #fecaca; background: #fef2f2; } .card--high .card__count { color: var(--high); }
.card--medium { border-color: #fde68a; background: #fffbeb; } .card--medium .card__count { color: var(--medium); }
.card--low { border-color: #bfdbfe; background: #eff6ff; } .card--low .card__count { color: var(--low); }
.card--informational { border-color: var(--line); background: var(--bg); } .card--informational .card__count { color: var(--informational); }

.findings__table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
.findings__table thead th {
    text-align: left;
    padding: 0.5rem 0.75rem;
    border-bottom: 2px solid var(--line-strong);
    color: var(--muted);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
}
.findings__table td { padding: 0.85rem 0.75rem; border-bottom: 1px solid var(--line); vertical-align: top; }
.finding__sev { white-space: nowrap; }
.finding__engine { color: var(--ink-soft); white-space: nowrap; }
.finding__count { text-align: center; color: var(--ink-soft); font-variant-numeric: tabular-nums; }
.finding__detail { width: 100%; }
.finding__name { font-weight: 600; }
.finding__desc { margin: 0.4rem 0 0; color: var(--ink-soft); }
.finding__confidence { font-weight: 400; font-size: 0.78rem; color: var(--muted); margin-left: 0.4rem; }

.finding__samples, .finding__remediation, .finding__ref { margin-top: 0.6rem; font-size: 0.88rem; }
.finding__samples-label, .finding__remediation-label, .finding__ref-label {
    display: inline-block;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin-bottom: 0.15rem;
}
.finding__samples ul { margin: 0.15rem 0 0; padding-left: 1.1rem; }
.finding__samples li { margin: 0.1rem 0; }
.finding__remediation p { margin: 0.15rem 0 0; color: var(--ink-soft); }
.finding__ref { color: var(--ink-soft); }

.badge {
    display: inline-block;
    padding: 0.15rem 0.55rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 700;
    border: 1px solid;
}
.badge--high { color: var(--high); background: #fef2f2; border-color: #fecaca; }
.badge--medium { color: var(--medium); background: #fffbeb; border-color: #fde68a; }
.badge--low { color: var(--low); background: #eff6ff; border-color: #bfdbfe; }
.badge--informational { color: var(--informational); background: var(--bg); border-color: var(--line); }

.empty { text-align: center; color: var(--muted); padding: 2rem 0.75rem; }

.report__footer { color: var(--muted); font-size: 0.85rem; border-top: 1px solid var(--line); padding-top: 1.25rem; }
.report__footer p { margin: 0 0 0.5rem; }
.report__footer code { background: transparent; border: none; padding: 0; }
.report__footer-meta { color: var(--line-strong); }

@media (max-width: 640px) {
    .findings__table, .findings__table tbody, .findings__table tr, .findings__table td { display: block; width: 100%; }
    .findings__table thead { display: none; }
    .findings__table tr { border: 1px solid var(--line); border-radius: 10px; margin-bottom: 0.85rem; padding: 0.5rem; }
    .findings__table td { border-bottom: none; padding: 0.3rem 0.5rem; }
    .finding__count::before { content: "Instances: "; color: var(--muted); }
}`;

    return { html, css };
}

// ── Persistence ─────────────────────────────────────────────────────────

/**
 * Persist the rendered report as a webpage so it lands in the user's Webpages
 * list and can be viewed/shared like any other page. Mirrors the routes/
 * webpages.js PUT handler's sha/size recording: writeSlot returns { sha, size },
 * and those are folded straight into updateWebpageMetadata.
 *
 * @returns {Promise<string>} the new webpage id.
 */
async function persistReportWebpage({ userId, targetUrl, html, css }) {
    const webpageStore = require('../stores/webpageStore');
    const host = hostOf(targetUrl);

    const webpage = await webpageStore.createWebpage({
        userId,
        name: 'Security report — ' + host,
        description: `Automated security scan report for ${targetUrl}`,
    });
    const webpageId = webpage.id;

    // Write each slot and capture its sha/size exactly as the PUT handler does.
    const { sha: htmlSha, size: htmlSize } = await webpageStore.writeSlot(userId, webpageId, 'html', html);
    const { sha: cssSha, size: cssSize } = await webpageStore.writeSlot(userId, webpageId, 'css', css);

    await webpageStore.updateWebpageMetadata(webpageId, userId, {
        icon: '🛡️',
        accentColor: '#b91c1c',
        tagline: 'Automated security scan report',
        htmlSha,
        htmlSize,
        cssSha,
        cssSize,
    });

    console.log(`[SecurityReportBuilder] Persisted report webpage ${webpageId} for user ${userId} (${host})`);
    return webpageId;
}

module.exports = {
    normalizeZap,
    normalizeNuclei,
    normalizeTestssl,
    aggregate,
    renderReportHtml,
    persistReportWebpage,
};
