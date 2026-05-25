/**
 * Trigger-filter primitives that aren't tied to a specific provider.
 *
 * `matchFilter` is the shallow structural matcher used for app events
 * with stable scalar payloads (Microsoft Graph subscriptions, GitHub
 * webhooks): every key in the filter must match the corresponding key
 * on the payload, arrays act as "any of", nested objects recurse.
 *
 * `applyDslFilter` wraps a per-event matcher with the Power-Automate-
 * style rich combinators (Phase 1.4): `any` / `none` / `expr` / `age`.
 * Combinators always AND with the structured per-event match — they
 * narrow, never broaden.
 *
 * Carved out of triggerBus.js as the first phase of §23 — the original
 * file re-imports these so its existing matchers keep working without
 * touching call sites.
 */

function matchFilter(payload, filter) {
    if (!filter) return true;
    if (typeof filter !== 'object') return true;
    for (const k of Object.keys(filter)) {
        const want = filter[k];
        const got = payload?.[k];
        if (Array.isArray(want)) {
            if (!want.includes(got)) return false;
        } else if (typeof want === 'object' && want !== null) {
            if (!matchFilter(got, want)) return false;
        } else if (got !== want) {
            return false;
        }
    }
    return true;
}

/**
 * Combine the rich-filter DSL (any/none/expr/age) with a per-event
 * structured matcher. The matcher is responsible for fields specific
 * to the provider/event; this wrapper handles cross-provider logic.
 *
 * Fails closed on invalid `expr` strings — same defensive choice as
 * the Gmail subjectRegex matcher.
 */
function applyDslFilter(payload, filter, perEventMatcher) {
    if (!filter || typeof filter !== 'object') return perEventMatcher(payload, filter);

    if (Array.isArray(filter.any) && filter.any.length > 0) {
        const ok = filter.any.some(sub => perEventMatcher(payload, sub));
        if (!ok) return false;
    }
    if (Array.isArray(filter.none) && filter.none.length > 0) {
        const hit = filter.none.some(sub => perEventMatcher(payload, sub));
        if (hit) return false;
    }
    if (typeof filter.expr === 'string' && filter.expr.trim()) {
        try {
            const { evaluate } = require('../expr');
            // Single-arg evaluator: payload accessible as `trigger`.
            // Restricted grammar already forbids function calls, so this
            // is safe to run on tenant-supplied strings.
            const result = evaluate(filter.expr, { trigger: payload });
            if (!result) return false;
        } catch {
            return false;
        }
    }
    if (filter.age && typeof filter.age === 'object') {
        const ts = payload?.datetime || payload?.timestamp || payload?.date;
        const t = ts ? Date.parse(ts) : NaN;
        if (Number.isFinite(t)) {
            const ageMin = (Date.now() - t) / 60_000;
            if (typeof filter.age.olderThanMinutes === 'number' && ageMin < filter.age.olderThanMinutes) return false;
            if (typeof filter.age.newerThanMinutes === 'number' && ageMin > filter.age.newerThanMinutes) return false;
        }
    }

    // Strip DSL keys before delegating; the per-event matcher would
    // see them as unknown structured fields. We don't mutate the
    // caller's filter object.
    const stripped = { ...filter };
    delete stripped.any;
    delete stripped.none;
    delete stripped.expr;
    delete stripped.age;
    return perEventMatcher(payload, stripped);
}

module.exports = { matchFilter, applyDslFilter };
