/**
 * Currency conversion helpers.
 *
 * LiteLLM pricing data is in USD; subscription plans default to EUR. Without
 * conversion, a $0.01 USD AI call would be billed as €0.01 in the plan's
 * meter, mis-stating cost by the FX spread.
 *
 * Rates are stored in configStore under `currency_fx_usd_<lowercase-3letter>`
 * keys (e.g. `currency_fx_usd_eur` = 0.92 means 1 USD = 0.92 EUR). Admin
 * UI / API can set these; the resolver caches them for 5 minutes to keep
 * the AI hot path fast.
 *
 * Rate of `1.0` (the safe default) means "no conversion" — costs flow
 * through as USD numbers labelled as the target currency. Logs a warning
 * the first time a currency without a configured rate is requested.
 */

const configStore = require('../stores/configStore');

const FX_TTL_MS = 5 * 60_000;
const FX_STALE_TTL_MS = 24 * 60 * 60_000; // last-good rate retained for 24h
const _fxCache = new Map();        // upperCurrencyCode → { rate, expiresAt }
const _fxLastGoodCache = new Map(); // upperCurrencyCode → { rate, savedAt }
const _missingRateWarned = new Set();
const _alertThrottle = new Map();  // key → lastAt
const ALERT_THROTTLE_MS = 5 * 60_000;

function _configKeyFor(currencyCode) {
    return `currency_fx_usd_${currencyCode.toLowerCase()}`;
}

function _emitAlert(kind, payload) {
    const key = `${kind}:${JSON.stringify(payload)}`;
    const last = _alertThrottle.get(key) || 0;
    if (Date.now() - last < ALERT_THROTTLE_MS) return;
    _alertThrottle.set(key, Date.now());
    console.error(`[Currency][ALERT] ${kind}`, payload);
}

/**
 * Resolve the multiplier that converts a USD amount into `targetCurrency`.
 *
 *   USD → USD                      → 1 (always)
 *   Currency with configured rate  → that rate, cached for 5 min, also
 *                                    stamped into the last-good cache
 *   Currency with no rate config   → 1 + one-time warning
 *   configStore read throws        → return last-good rate if within 24h,
 *                                    otherwise throw `fx_rate_unavailable`
 *
 * The strict mode is opt-in via `{ strict: true }` for billing paths that
 * must refuse to write than guess. Best-effort callers (display, logging)
 * keep the historical "return 1 on missing" behaviour.
 */
async function getUsdToCurrencyRate(targetCurrency, opts = {}) {
    const c = String(targetCurrency || 'USD').toUpperCase();
    if (c === 'USD') return 1;
    const strict = !!opts.strict;
    const hit = _fxCache.get(c);
    if (hit && hit.expiresAt > Date.now()) return hit.rate;

    let rate = null;
    let lookupFailed = false;
    try {
        const raw = await configStore.getConfig(_configKeyFor(c));
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed > 0) rate = parsed;
    } catch (e) {
        lookupFailed = true;
        _emitAlert('fx_rate_lookup_failed', { currency: c, error: e.message });
    }

    if (rate !== null) {
        _fxCache.set(c, { rate, expiresAt: Date.now() + FX_TTL_MS });
        _fxLastGoodCache.set(c, { rate, savedAt: Date.now() });
        return rate;
    }

    // No rate from configStore. Two paths:
    //   1. Lookup threw (DB down, transient I/O failure) — try last-good
    //      cache; if no cached rate exists and `strict` is set, throw.
    //   2. Lookup returned null/empty — currency simply isn't configured.
    if (lookupFailed) {
        const stale = _fxLastGoodCache.get(c);
        if (stale && (Date.now() - stale.savedAt) <= FX_STALE_TTL_MS) {
            console.warn(`[Currency] using stale-cache rate for USD→${c} (saved ${Math.round((Date.now() - stale.savedAt) / 1000)}s ago)`);
            return stale.rate;
        }
        if (strict) {
            throw new Error(`fx_rate_unavailable: USD→${c}`);
        }
    }

    if (!_missingRateWarned.has(c)) {
        _missingRateWarned.add(c);
        console.warn(`[Currency] No FX rate configured for USD→${c}; using 1.0 — set ${_configKeyFor(c)} in admin config.`);
    }
    _fxCache.set(c, { rate: 1, expiresAt: Date.now() + FX_TTL_MS });
    return 1;
}

/**
 * Bulk-fetch the full rate table for admin display. Returns an object keyed
 * by lowercase config-key suffix (e.g. `{ eur: 0.92, gbp: 0.78 }`). Skips
 * keys that don't look like valid 3-letter currency codes.
 */
async function getAllConfiguredRates() {
    const keys = await configStore.searchConfigKeys?.('currency_fx_usd_%').catch(() => null);
    if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) {
            const suffix = k.replace(/^currency_fx_usd_/, '');
            if (!/^[a-z]{3}$/.test(suffix)) continue;
            const raw = await configStore.getConfig(k);
            const n = Number(raw);
            if (Number.isFinite(n) && n > 0) out[suffix] = n;
        }
        return out;
    }
    // Fallback path when configStore lacks search: probe common currencies.
    const candidates = ['eur', 'gbp', 'usd', 'sek', 'nok', 'dkk', 'chf', 'cad', 'aud', 'jpy'];
    const out = {};
    for (const code of candidates) {
        const raw = await configStore.getConfig(_configKeyFor(code.toUpperCase()));
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) out[code] = n;
    }
    return out;
}

/**
 * Admin helper: persist a USD→<currency> rate. `currencyCode` is a 3-letter
 * ISO code; `rate` is a positive Number. Caller is responsible for audit
 * logging and PAYG-cache invalidation.
 */
async function setUsdToCurrencyRate(currencyCode, rate) {
    const c = String(currencyCode || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw new Error(`Invalid currency code: ${currencyCode}`);
    const r = Number(rate);
    if (!Number.isFinite(r) || r <= 0) throw new Error(`Invalid FX rate: ${rate}`);
    await configStore.setConfig(_configKeyFor(c), String(r));
    _fxCache.delete(c);
    return { currency: c, rate: r };
}

function invalidateFxCache() {
    _fxCache.clear();
}

module.exports = {
    getUsdToCurrencyRate,
    getAllConfiguredRates,
    setUsdToCurrencyRate,
    invalidateFxCache,
};
