/**
 * Server Geo-Location Resolver
 *
 * Resolves server endpoints (hostnames) to geo-location data (country, region, city)
 * using DNS resolution + geoip-lite, with Redis caching (7-day TTL).
 *
 * Used by the Integration Activity Monitor to show which country data flows to/from.
 *
 * Flow: hostname → Redis cache check → DNS resolve → geoip-lite lookup → cache & return
 */

const dns = require('dns').promises;
const { getRedis } = require('../db');

let geoip = null;
try {
    geoip = require('geoip-lite');
} catch (e) {
    console.warn('[GeoResolver] geoip-lite not available:', e.message);
}

const CACHE_PREFIX = 'geo:';
const CACHE_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

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
 * e.g. "google.com/search (via SerpAPI)" → "google.com"
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

    // Strip parenthetical labels like "(via SerpAPI)"
    host = host.replace(/\s*\(.*\)\s*$/, '').trim();

    // Must look like a hostname (has dots, not just a word like "smtp/imap")
    if (!host.includes('.') || host.includes(' ')) return null;

    return host.toLowerCase();
}

/**
 * Resolve a single server endpoint to geo-location data.
 * Returns null on any failure (fail-open — never blocks tool execution).
 *
 * @param {string} serverEndpoint - e.g. "google.com/search (via SerpAPI)"
 * @returns {Promise<object|null>} { ip, country_code, country_name, region, city, is_eu, flag, hostname }
 */
async function resolveServerGeo(serverEndpoint) {
    const hostname = extractHostname(serverEndpoint);
    if (!hostname) return null;

    try {
        // 1. Check Redis cache
        const redis = getRedis();
        if (redis) {
            try {
                const cached = await redis.get(`${CACHE_PREFIX}${hostname}`);
                if (cached) {
                    return JSON.parse(cached);
                }
            } catch (e) {
                // Redis read error — proceed without cache
            }
        }

        // 2. DNS resolve hostname → IP
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

        // 3. GeoIP lookup (local database)
        let countryCode = null;
        let region = null;
        let city = null;

        if (geoip) {
            const geo = geoip.lookup(ip);
            if (geo && geo.country) {
                countryCode = geo.country;
                region = geo.region || null;
                city = geo.city || null;
            }
        }

        // 4. Fallback: HTTP API for Cloudflare/CDN IPs where geoip-lite has no data
        if (!countryCode) {
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
                        console.log(`[GeoResolver] Fallback API: ${ip} → ${countryCode}`);
                    }
                }
            } catch (apiErr) {
                // Fallback failed — proceed with unknown
                console.warn(`[GeoResolver] Fallback API failed for ${ip}: ${apiErr.message}`);
            }
        }

        const result = {
            ip,
            hostname,
            country_code: countryCode || null,
            country_name: COUNTRY_NAMES[countryCode] || countryCode || 'Unknown',
            region: region || null,
            city: city || null,
            is_eu: EU_EEA_COUNTRIES.has(countryCode),
            flag: countryFlag(countryCode),
            resolved_at: new Date().toISOString(),
        };

        // 5. Cache in Redis (fire-and-forget)
        if (redis) {
            redis.setex(`${CACHE_PREFIX}${hostname}`, CACHE_TTL, JSON.stringify(result)).catch(() => {});
        }

        console.log(`[GeoResolver] ${hostname} → ${ip} → ${result.flag} ${result.country_name} (${result.country_code})`);
        return result;
    } catch (err) {
        console.warn(`[GeoResolver] Failed to resolve ${hostname}:`, err.message);
        return null;
    }
}

/**
 * Batch-resolve multiple server endpoints.
 * Returns a Map<endpoint, geoResult>.
 * Deduplicates hostnames so each is only resolved once.
 */
async function batchResolveServerGeo(endpoints) {
    const results = new Map();
    if (!endpoints || !Array.isArray(endpoints) || endpoints.length === 0) return results;

    // Deduplicate by hostname
    const hostnameMap = new Map(); // hostname → [endpoint1, endpoint2, ...]
    for (const ep of endpoints) {
        const hostname = extractHostname(ep);
        if (!hostname) continue;
        if (!hostnameMap.has(hostname)) hostnameMap.set(hostname, []);
        hostnameMap.get(hostname).push(ep);
    }

    // Resolve all unique hostnames in parallel (max 10 concurrent)
    const hostnames = [...hostnameMap.keys()];
    const BATCH_SIZE = 10;

    for (let i = 0; i < hostnames.length; i += BATCH_SIZE) {
        const batch = hostnames.slice(i, i + BATCH_SIZE);
        const geoResults = await Promise.all(
            batch.map(h => resolveServerGeo(h).catch(() => null))
        );

        for (let j = 0; j < batch.length; j++) {
            const geo = geoResults[j];
            if (geo) {
                // Map result back to all original endpoint strings that share this hostname
                for (const ep of hostnameMap.get(batch[j])) {
                    results.set(ep, geo);
                }
            }
        }
    }

    return results;
}

module.exports = {
    resolveServerGeo,
    batchResolveServerGeo,
    extractHostname,
    countryFlag,
    EU_EEA_COUNTRIES,
    COUNTRY_NAMES,
};
