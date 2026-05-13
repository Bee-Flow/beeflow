/**
 * Server Geo-Location Resolver
 *
 * Resolves server endpoints (hostnames) to geo-location data (country, region, city)
 * using DNS resolution + geoip-lite, with ip-api.com fallback for CDN/Cloudflare IPs.
 *
 * Used at integration activity LOG TIME — geo data is stored directly in the DB row,
 * so the dashboard reads pre-resolved data with zero extra lookups.
 *
 * Flow: hostname → DNS resolve → geoip-lite → (fallback: ip-api.com) → return
 */

const dns = require('dns').promises;

let geoip = null;
try {
    geoip = require('geoip-lite');
} catch (e) {
    console.warn('[GeoResolver] geoip-lite not available:', e.message);
}

// EU/EEA country codes for GDPR jurisdiction highlighting
const EU_EEA_COUNTRIES = new Set([
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
    'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
    'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
    // EEA (non-EU)
    'IS', 'LI', 'NO',
    // Adequate (GDPR recognized)
    'CH', 'GB',
]);

// ISO 3166-1 country code → name (common ones, extended as needed)
const COUNTRY_NAMES = {
    US: 'United States', GB: 'United Kingdom', DE: 'Germany', NL: 'Netherlands',
    FR: 'France', IE: 'Ireland', BE: 'Belgium', SE: 'Sweden', FI: 'Finland',
    NO: 'Norway', DK: 'Denmark', CH: 'Switzerland', AT: 'Austria', IT: 'Italy',
    ES: 'Spain', PT: 'Portugal', PL: 'Poland', CZ: 'Czechia', RO: 'Romania',
    BG: 'Bulgaria', HR: 'Croatia', HU: 'Hungary', SK: 'Slovakia', SI: 'Slovenia',
    LT: 'Lithuania', LV: 'Latvia', EE: 'Estonia', LU: 'Luxembourg', MT: 'Malta',
    CY: 'Cyprus', GR: 'Greece', IS: 'Iceland', LI: 'Liechtenstein',
    CA: 'Canada', AU: 'Australia', NZ: 'New Zealand', JP: 'Japan',
    SG: 'Singapore', IN: 'India', BR: 'Brazil', KR: 'South Korea',
    CN: 'China', TW: 'Taiwan', HK: 'Hong Kong', RU: 'Russia',
    ZA: 'South Africa', IL: 'Israel', AE: 'UAE', SA: 'Saudi Arabia',
    MX: 'Mexico', AR: 'Argentina', CL: 'Chile', CO: 'Colombia',
};

// Country code → flag emoji
function countryFlag(code) {
    if (!code || code.length !== 2) return '🌐';
    return String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

/**
 * Extract a resolvable hostname from a server endpoint label.
 * e.g. "api.serper.dev (Google Search)" → "api.serper.dev"
 *      "graph.microsoft.com" → "graph.microsoft.com"
 *      "mcp-server://filesystem" → null (not resolvable)
 */
function extractHostname(endpoint) {
    if (!endpoint || typeof endpoint !== 'string') return null;

    // Strip protocol prefix
    let host = endpoint.replace(/^https?:\/\//, '').replace(/^mcp-server:\/\//, '');

    // Strip path and anything after
    host = host.split('/')[0];

    // Strip port
    host = host.split(':')[0];

    // Strip parenthetical labels like "(Google Search)"
    host = host.replace(/\s*\(.*\)\s*$/, '').trim();

    // Must look like a hostname (has dots, not just a word like "smtp/imap")
    if (!host.includes('.') || host.includes(' ')) return null;

    return host.toLowerCase();
}

/**
 * Resolve a single server endpoint to geo-location data.
 * Returns null on any failure (fail-open — never blocks tool execution).
 *
 * Called at log time (fire-and-forget), so latency doesn't affect the user.
 *
 * @param {string} serverEndpoint - e.g. "api.fireflies.ai"
 * @returns {Promise<object|null>} { ip, country_code, country_name, region, city, is_eu, flag, hostname }
 */
async function resolveServerGeo(serverEndpoint) {
    const hostname = extractHostname(serverEndpoint);
    if (!hostname) return null;

    try {
        // 1. DNS resolve hostname → IP
        let ip;
        try {
            const addresses = await dns.resolve4(hostname);
            ip = addresses?.[0];
        } catch (dnsErr) {
            // Try dns.lookup as fallback (uses OS resolver)
            try {
                const result = await dns.lookup(hostname, { family: 4 });
                ip = result?.address;
            } catch (_) {
                return null;
            }
        }

        if (!ip) return null;

        // 2. GeoIP lookup (local database — instant, ~0.1ms)
        let countryCode = null;
        let region = null;
        let city = null;
        let lowConfidence = false;

        if (geoip) {
            const geo = geoip.lookup(ip);
            if (geo && geo.country) {
                countryCode = geo.country;
                region = geo.region || null;
                city = geo.city || null;
                // Treat country-only matches as low-confidence — geoip-lite
                // buckets entire CSPs under one country (e.g. GCP 34.x → US)
                // even when the actual region is European. See geoFromIp().
                if (!region && !city) lowConfidence = true;
            }
        }

        // 3. Fallback: HTTP API for Cloudflare/CDN IPs where geoip-lite has no data
        if (!countryCode || lowConfidence) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 3000);
                const resp = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode,regionName,city`, { signal: controller.signal });
                clearTimeout(timeout);
                if (resp.ok) {
                    const apiGeo = await resp.json();
                    if (apiGeo.countryCode) {
                        countryCode = apiGeo.countryCode;
                        region = apiGeo.regionName || null;
                        city = apiGeo.city || null;
                    }
                }
            } catch (apiErr) {
                // Fallback failed — proceed with unknown
            }
        }

        return {
            ip,
            hostname,
            country_code: countryCode || null,
            country_name: COUNTRY_NAMES[countryCode] || countryCode || 'Unknown',
            region: region || null,
            city: city || null,
            is_eu: EU_EEA_COUNTRIES.has(countryCode),
            flag: countryFlag(countryCode),
        };
    } catch (err) {
        console.warn(`[GeoResolver] Failed to resolve ${hostname}:`, err.message);
        return null;
    }
}

/**
 * Geo-lookup for a known IP — no DNS step. Used when we already captured the
 * peer IP at the socket (see outboundProbe.js).
 *
 * @param {string} ip
 * @returns {Promise<object|null>} { country_code, country_name, region, city, is_eu, flag }
 */
async function geoFromIp(ip) {
    if (!ip) return null;
    let countryCode = null, region = null, city = null;
    let lowConfidence = false;
    if (geoip) {
        const g = geoip.lookup(ip);
        if (g && g.country) {
            countryCode = g.country;
            region = g.region || null;
            city = g.city || null;
            // geoip-lite returns country with empty region+city when its DB
            // doesn't actually know the location — that's its "default
            // bucket" pattern (e.g. 34.x.x.x all bucketed as US even though
            // Google Cloud has EU regions in those ranges). Treat as a miss
            // and let the live lookup correct it.
            if (!region && !city) lowConfidence = true;
        }
    }
    if (!countryCode || lowConfidence) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            const resp = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode,regionName,city`, { signal: controller.signal });
            clearTimeout(timeout);
            if (resp.ok) {
                const apiGeo = await resp.json();
                if (apiGeo.countryCode) {
                    countryCode = apiGeo.countryCode;
                    region = apiGeo.regionName || null;
                    city = apiGeo.city || null;
                }
            }
        } catch (_) { /* ignore */ }
    }
    return {
        country_code: countryCode || null,
        country_name: COUNTRY_NAMES[countryCode] || countryCode || 'Unknown',
        region: region || null,
        city: city || null,
        is_eu: EU_EEA_COUNTRIES.has(countryCode),
        flag: countryFlag(countryCode),
    };
}

module.exports = {
    resolveServerGeo,
    geoFromIp,
    extractHostname,
    countryFlag,
    EU_EEA_COUNTRIES,
    COUNTRY_NAMES,
};
