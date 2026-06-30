'use strict';

/**
 * Run-log redaction at the persistence chokepoint (WS5.2).
 *
 * Step inputs/outputs/errors are persisted verbatim into
 * `automation_run_steps`, so any credential that flows through a step — a
 * {{secrets.*}} binding resolved into a header, a token echoed back by an
 * API, a connector error that quotes the request — lands in the database
 * and the run-history UI. Everything written through
 * `automationStore.recordRunStep()` passes through this module first.
 *
 * Scope decisions (deliberate):
 *  - Ordinary PII (emails, names, addresses) is intentionally NOT redacted:
 *    run payloads are the user's own data, and AI-step egress is already
 *    covered by the Privacy Shield pipeline (core/automationRunner/safety.js).
 *    This module only targets credential-shaped material.
 *  - The in-memory runState stays UNREDACTED — dry-run previews and the
 *    builder's self-correction loop keep operating on real values; only the
 *    persisted rows are masked.
 *  - Replay tradeoff: a replayed/pinned step output resolves the redaction
 *    MARKER, not the original token. Flows must bind credentials via
 *    {{secrets.*}} (re-resolved per run), never via a replayed step output.
 *
 * Public:
 *   redactForPersistence(value, { secretValues = [] }) → { value, redactions }
 *   SECRET_PATTERNS / SENSITIVE_KEY_RE / REDACTED_MARKER_RE  (for tests)
 *
 * Pure + dependency-free; non-mutating deep walk (sync sibling of
 * mapStringLeavesAsync in core/automationRunner/safety.js). Two passes per
 * string leaf: (a) exact-substring masking of the provided secretValues,
 * (b) secret-shaped pattern masking.
 */

const marker = (kind) => `«redacted:${kind}»`;

// A string that is already exactly a redaction marker — skipped by the
// sensitive-key pass so a second redaction is a no-op (idempotence).
const REDACTED_MARKER_RE = /^«redacted:[a-z-]+»$/;

// Key names whose values are replaced wholesale, whatever their content.
const SENSITIVE_KEY_RE = /^(authorization|x-api-key|api[-_]?key|password|passwd|secret|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|private[-_]?key)$/i;

// Ordered: the PEM block first (its base64 body would otherwise feed the
// token shapes below), auth-scheme values before raw token shapes so a
// `Bearer <jwt>` masks as `bearer`, not `jwt`. Each match is replaced by
// `«redacted:<kind>»`; `mask` overrides when part of the match must survive
// (Bearer/Basic keep the scheme word — only the value portion is masked).
const SECRET_PATTERNS = [
    // Unterminated blocks (truncated logs) are masked to end-of-string.
    { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
    { kind: 'bearer', re: /\b(Bearer)[ \t]+[A-Za-z0-9+/_=.\-]{8,}/gi, mask: (m, scheme) => `${scheme} ${marker('bearer')}` },
    { kind: 'basic', re: /\b(Basic)[ \t]+[A-Za-z0-9+/=]{8,}/gi, mask: (m, scheme) => `${scheme} ${marker('basic')}` },
    // sk- prefixed API keys (OpenAI/Anthropic/Stripe style, incl. sk-ant-…).
    { kind: 'sk-token', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
    { kind: 'github-token', re: /\b(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]{16,}\b/g },
    { kind: 'slack-token', re: /\bxox[bpars]-[A-Za-z0-9-]{8,}/g },
    { kind: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
    // Three-segment base64url with the canonical `{"`→`eyJ` JSON header; a
    // bare three-segment pattern would false-positive on hostnames.
    { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
];

function prepareSecretValues(secretValues) {
    // Drop tiny values (< 4 chars) — masking every occurrence of "ab" would
    // shred ordinary text. Longest-first so a secret that contains another
    // secret as a substring masks as one unit.
    const list = (Array.isArray(secretValues) ? secretValues : [])
        .filter((s) => typeof s === 'string' && s.length >= 4);
    return [...new Set(list)].sort((a, b) => b.length - a.length);
}

function redactString(str, secrets, counter) {
    let out = str;
    // Pass a — exact-substring masking of known secret values.
    for (const s of secrets) {
        if (!out.includes(s)) continue;
        const parts = out.split(s);
        counter.n += parts.length - 1;
        out = parts.join(marker('secret'));
    }
    // Pass b — secret-shaped patterns.
    for (const p of SECRET_PATTERNS) {
        out = out.replace(p.re, (...args) => {
            counter.n += 1;
            return p.mask ? p.mask(...args) : marker(p.kind);
        });
    }
    return out;
}

function isWholesaleRedactable(v) {
    // Strings and numbers under a sensitive key are replaced wholesale;
    // booleans/null stay (e.g. `secret: true` is config, not a credential)
    // and objects/arrays are walked so their own leaves get scanned.
    return typeof v === 'string' || typeof v === 'number';
}

function walk(value, secrets, counter) {
    if (value == null) return value;
    if (typeof value === 'string') return redactString(value, secrets, counter);
    if (Array.isArray(value)) return value.map((v) => walk(v, secrets, counter));
    if (typeof value === 'object') {
        // Only walk plain objects: Dates/Buffers/class instances would be
        // flattened to `{}` by a key walk — pass them through untouched.
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) return value;
        const out = {};
        for (const k of Object.keys(value)) {
            const v = value[k];
            if (SENSITIVE_KEY_RE.test(k) && isWholesaleRedactable(v)) {
                if (typeof v === 'string' && REDACTED_MARKER_RE.test(v)) {
                    out[k] = v; // already masked — keep redaction idempotent
                } else {
                    counter.n += 1;
                    out[k] = marker('key');
                }
            } else {
                out[k] = walk(v, secrets, counter);
            }
        }
        return out;
    }
    return value;
}

function redactForPersistence(value, opts = {}) {
    const secrets = prepareSecretValues(opts.secretValues);
    const counter = { n: 0 };
    return { value: walk(value, secrets, counter), redactions: counter.n };
}

module.exports = { redactForPersistence, SECRET_PATTERNS, SENSITIVE_KEY_RE, REDACTED_MARKER_RE };
