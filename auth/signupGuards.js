/**
 * Signup access guards — connector-only mode + geo-blocking for account creation.
 *
 * Centralizes the access checks consulted at every signup choke point so the web
 * signup routes, the OAuth signup completion, and the Nextcloud connector's
 * new-user auto-provision branch all enforce the same admin-configured policy.
 *
 * Settings live in the `config` table via configStore (same place as the
 * org/consumer/waitlist signup toggles) — see /auth/admin/signup-settings:
 *   signup_connector_only        boolean   web signups blocked; connector + invites only
 *   signup_geo_mode              off|allowlist|blocklist
 *   signup_geo_countries         string[]  ISO-3166 alpha-2 codes for the active mode
 *   signup_geo_block_unknown     boolean   block when country can't be determined
 *   signup_geo_apply_connector   boolean   also gate new NC-user auto-provisioning
 *
 * Geo evaluation reuses geoFromIp() (geoip-lite + ip-api.com fallback) and the
 * EU/EEA set from serverGeoResolver — no extra dependency. Geo is best-effort:
 * VPNs bypass it and geoip-lite is approximate, so it fails OPEN on any lookup
 * error and never blocks on private/loopback IPs (dev / self-hosted internal).
 */

const configStore = require('../stores/configStore');
const { geoFromIp } = require('../core/serverGeoResolver');

const GEO_MODES = ['off', 'allowlist', 'blocklist'];

async function getSignupAccessConfig() {
    const connectorOnly = (await configStore.getConfig('signup_connector_only')) ?? false;
    const geoModeRaw = (await configStore.getConfig('signup_geo_mode')) ?? 'off';
    const geoMode = GEO_MODES.includes(geoModeRaw) ? geoModeRaw : 'off';
    const geoCountries = (await configStore.getConfig('signup_geo_countries')) ?? [];
    const geoBlockUnknown = (await configStore.getConfig('signup_geo_block_unknown')) ?? false;
    const geoApplyConnector = (await configStore.getConfig('signup_geo_apply_connector')) ?? true;
    return {
        connectorOnly: !!connectorOnly,
        geoMode,
        geoCountries: Array.isArray(geoCountries) ? geoCountries : [],
        geoBlockUnknown: !!geoBlockUnknown,
        geoApplyConnector: geoApplyConnector !== false,
    };
}

/**
 * Best-effort client IP. Express resolves req.ip honoring `trust proxy`
 * (set in server/index.js); fall back to the forwarded header / socket.
 * For connector requests this resolves to the connecting Nextcloud server.
 */
function clientIp(req) {
    const fwd = req.headers?.['x-forwarded-for'];
    const first = typeof fwd === 'string' ? fwd.split(',')[0].trim() : null;
    return String(req.ip || first || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

/** Loopback / private / link-local ranges — always allowed (dev, internal networks). */
function isPrivateIp(ip) {
    if (!ip) return true; // unknown peer → treat as internal, never geo-block
    const a = String(ip).replace(/^::ffff:/, '').toLowerCase();
    if (a === '::1' || a === 'localhost') return true;
    if (a.startsWith('127.') || a.startsWith('10.') || a.startsWith('192.168.')) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(a)) return true;
    if (a.startsWith('169.254.')) return true;          // IPv4 link-local
    if (/^(fc|fd)[0-9a-f]{2}:/.test(a)) return true;    // fc00::/7 unique-local
    if (a.startsWith('fe80:')) return true;             // IPv6 link-local
    return false;
}

/**
 * Evaluate the geo policy for an IP. Returns { allowed, country }.
 * Fails OPEN on any error and always allows private/loopback IPs.
 */
async function evaluateGeo(ip, cfg) {
    if (!cfg || cfg.geoMode === 'off') return { allowed: true, country: null };
    if (isPrivateIp(ip)) return { allowed: true, country: null };
    try {
        const geo = await geoFromIp(ip);
        const country = geo?.country_code || null;
        if (!country) {
            // Unknown country — admin decides whether to fail open or closed.
            return { allowed: !cfg.geoBlockUnknown, country: null };
        }
        const inList = cfg.geoCountries.includes(country);
        if (cfg.geoMode === 'allowlist') return { allowed: inList, country };
        if (cfg.geoMode === 'blocklist') return { allowed: !inList, country };
        return { allowed: true, country };
    } catch (e) {
        console.warn('[SignupGuards] geo evaluation failed (allowing):', e.message);
        return { allowed: true, country: null };
    }
}

const CONNECTOR_ONLY_MSG = 'New accounts on this platform can only be created through the Nextcloud app. Please sign in from your Nextcloud, or ask your administrator for an invitation.';
const GEO_MSG = 'Account creation is not available in your region.';

/**
 * Gate a browser/web signup attempt — enforces connector-only mode and geo
 * policy against the end user's IP. Invited users should bypass this (call it
 * only when there is no invite). Returns { ok } or { ok, status, error, code }.
 */
async function checkWebSignupAllowed(req) {
    const cfg = await getSignupAccessConfig();
    if (cfg.connectorOnly) {
        return { ok: false, status: 403, error: CONNECTOR_ONLY_MSG, code: 'CONNECTOR_ONLY' };
    }
    const { allowed, country } = await evaluateGeo(clientIp(req), cfg);
    if (!allowed) {
        return { ok: false, status: 403, error: GEO_MSG, code: 'GEO_BLOCKED', country };
    }
    return { ok: true };
}

/**
 * Gate a Nextcloud connector new-user auto-provision. Geo only (connector-only
 * mode never blocks the connector — that is the whole point), evaluated against
 * the connecting Nextcloud server's IP, and only when geoApplyConnector is on.
 * Never throws — the connector must not break on a geo hiccup.
 */
async function checkConnectorSignupAllowed(req) {
    try {
        const cfg = await getSignupAccessConfig();
        if (!cfg.geoApplyConnector || cfg.geoMode === 'off') return { ok: true };
        const { allowed, country } = await evaluateGeo(clientIp(req), cfg);
        if (!allowed) {
            return { ok: false, status: 403, error: GEO_MSG, code: 'GEO_BLOCKED', country };
        }
        return { ok: true };
    } catch (e) {
        console.warn('[SignupGuards] connector geo check failed (allowing):', e.message);
        return { ok: true };
    }
}

// Resolve the locale to use for a new account's transactional emails.
// Priority: explicit body.locale (validated against configured locales) →
// org_default_locale → first language of the Accept-Language header → 'en'.
// Always returns a non-empty string; getEffectiveEmailTemplate falls back to
// English per field if the locale has no overrides.
async function resolveSignupLocale(req, explicitLocale) {
    try {
        const languageStore = require('../stores/languageStore');
        const locales = await languageStore.getAvailableLocales();
        const known = new Set((locales || []).map(l => l && l.code).filter(Boolean));

        const candidate = (explicitLocale ?? req?.body?.locale);
        if (typeof candidate === 'string' && known.has(candidate)) return candidate;

        const orgDefault = await configStore.getConfig('org_default_locale');
        if (typeof orgDefault === 'string' && known.has(orgDefault)) return orgDefault;

        const accept = req?.headers?.['accept-language'];
        if (typeof accept === 'string' && accept.trim()) {
            const first = accept.split(',')[0].trim().split('-')[0].toLowerCase();
            if (known.has(first)) return first;
        }
    } catch (e) {
        console.warn('[SignupGuards] resolveSignupLocale failed (falling back to en):', e.message);
    }
    return 'en';
}

module.exports = {
    getSignupAccessConfig,
    evaluateGeo,
    isPrivateIp,
    clientIp,
    checkWebSignupAllowed,
    checkConnectorSignupAllowed,
    resolveSignupLocale,
    GEO_MODES,
};
