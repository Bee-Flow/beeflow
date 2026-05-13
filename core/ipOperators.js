/**
 * IP → operator (cloud / hosting company) — small static table.
 *
 * geoip-lite ships country data but no ASN, so for the "operator" column on the
 * data-egress dashboard we use a hand-curated map of the IP ranges we care
 * about. Unknown IPs return null and surface in the UI as "Unknown operator" —
 * we never silently hide a destination.
 */

// Convert an IPv4 dotted string to a 32-bit number for range checks.
function ipv4ToInt(ip) {
    const parts = (ip || '').split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
        const o = Number(p);
        if (!Number.isInteger(o) || o < 0 || o > 255) return null;
        n = (n * 256) + o;
    }
    return n;
}

function cidrToRange(cidr) {
    const [ip, bitsStr] = cidr.split('/');
    const base = ipv4ToInt(ip);
    const bits = Number(bitsStr);
    if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    const size = 2 ** (32 - bits);
    return { start: base, end: base + size - 1 };
}

// Each operator is a list of CIDR blocks. These are intentionally coarse — the
// goal is "is this Google/MS/Cloudflare/AWS?", not exhaustive ASN routing.
const OPERATORS = [
    { name: 'Google', cidrs: ['8.8.4.0/24', '8.8.8.0/24', '34.0.0.0/9', '35.184.0.0/13', '64.233.160.0/19', '66.102.0.0/20', '66.249.64.0/19', '72.14.192.0/18', '74.125.0.0/16', '108.177.0.0/17', '142.250.0.0/15', '172.217.0.0/16', '173.194.0.0/16', '209.85.128.0/17', '216.58.192.0/19', '216.239.32.0/19'] },
    { name: 'Microsoft', cidrs: ['13.64.0.0/11', '13.96.0.0/13', '13.104.0.0/14', '20.0.0.0/8', '23.96.0.0/13', '40.64.0.0/10', '52.96.0.0/12', '52.112.0.0/14', '52.120.0.0/14', '65.52.0.0/14', '70.37.0.0/17', '104.40.0.0/13', '157.55.0.0/16', '168.61.0.0/16'] },
    { name: 'Cloudflare', cidrs: ['103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '104.16.0.0/13', '104.24.0.0/14', '108.162.192.0/18', '131.0.72.0/22', '141.101.64.0/18', '162.158.0.0/15', '172.64.0.0/13', '173.245.48.0/20', '188.114.96.0/20', '190.93.240.0/20', '197.234.240.0/22', '198.41.128.0/17'] },
    { name: 'Amazon AWS', cidrs: ['3.0.0.0/9', '13.32.0.0/15', '15.177.0.0/16', '15.181.0.0/16', '15.184.0.0/15', '15.193.0.0/16', '15.197.0.0/16', '15.200.0.0/14', '18.32.0.0/11', '34.192.0.0/10', '35.71.64.0/22', '35.180.0.0/16', '52.0.0.0/11', '52.84.0.0/15', '54.144.0.0/12', '54.224.0.0/12', '54.240.0.0/12', '99.78.0.0/18', '107.20.0.0/14', '184.72.0.0/15'] },
    { name: 'Fastly', cidrs: ['151.101.0.0/16', '199.27.72.0/21', '23.235.32.0/20'] },
    { name: 'Akamai', cidrs: ['23.32.0.0/11', '23.192.0.0/11', '104.64.0.0/10', '184.24.0.0/13'] },
    { name: 'OpenAI', cidrs: ['104.18.6.0/24', '104.18.7.0/24'] }, // OpenAI fronted via Cloudflare; partial coverage
    { name: 'Anthropic', cidrs: ['160.79.104.0/21'] },
];

// Precompute ranges once at load. We keep them in the original (specific-first)
// order so that overlapping ranges resolve to the more specific operator —
// e.g. OpenAI's /24 inside Cloudflare's /13 stays "OpenAI". Linear scan because
// the table is small (~70 entries) and overlapping ranges defeat binary search.
const RANGES = [];
for (const op of OPERATORS) {
    for (const cidr of op.cidrs || []) {
        const r = cidrToRange(cidr);
        if (r) RANGES.push({ ...r, name: op.name });
    }
}
// Sort by range size ascending so the most-specific match wins when scanning.
RANGES.sort((a, b) => (a.end - a.start) - (b.end - b.start));

/**
 * Look up the operator for an IPv4. Returns the operator name string, or null.
 */
function operatorForIp(ip) {
    const n = ipv4ToInt(ip);
    if (n === null) return null;
    for (const r of RANGES) {
        if (n >= r.start && n <= r.end) return r.name;
    }
    return null;
}

module.exports = { operatorForIp };
