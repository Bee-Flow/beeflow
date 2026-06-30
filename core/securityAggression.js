/**
 * Security-scan aggression policy — a single ordered scale shared by the route
 * (validation + UI policy) and the driver (per-tool gating).
 *
 *   recon      — crawl + passive recon only (httpx, subfinder, whatweb, dig,
 *                curl, nmap TCP-connect). No scanning traffic beyond discovery.
 *   passive    — + ZAP passive alerts, safe nuclei templates, testssl.
 *   active     — + ZAP active scan, intrusive nuclei tags, ffuf/feroxbuster
 *                fuzzing, nmap -sS / masscan.
 *   offensive  — + sqlmap attacks and exploit-confirmation probes.
 *
 * The per-scan level the user picks is CLAMPED to a server ceiling
 * (SECURITY_MAX_AGGRESSION) so the same selector can later be plan/subscription
 * gated by simply lowering the ceiling — see project_unified_entitlements.
 * Default ceiling is 'offensive' (internal Bee Flow use).
 */

const LEVELS = ['recon', 'passive', 'active', 'offensive'];
const DEFAULT_AGGRESSION = 'passive';

function rank(level) {
    return LEVELS.indexOf(String(level || '').toLowerCase());
}

function isValid(level) {
    return LEVELS.includes(String(level || '').toLowerCase());
}

/** The org/install ceiling — the highest level any scan may reach. */
function ceiling() {
    const c = String(process.env.SECURITY_MAX_AGGRESSION || 'offensive').toLowerCase();
    return isValid(c) ? c : 'offensive';
}

/** Validate + clamp a requested level to the ceiling. */
function clamp(chosen) {
    const base = isValid(chosen) ? String(chosen).toLowerCase() : DEFAULT_AGGRESSION;
    return rank(base) > rank(ceiling()) ? ceiling() : base;
}

/** True when `effective` is at least as aggressive as `required`. */
function atLeast(effective, required) {
    return rank(effective) >= rank(required);
}

module.exports = {
    LEVELS,
    DEFAULT_AGGRESSION,
    rank,
    isValid,
    ceiling,
    clamp,
    atLeast,
};
