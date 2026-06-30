/**
 * Shared SSRF guard — single source of truth for the private-address
 * blocklist used by the Playwright test runner, the security-scan worker
 * and the code-step sandbox.
 *
 * Layers (defence in depth):
 *   1. isPrivateHostname(host)  — cheap literal/regex screen on the URL host
 *      before any network activity (localhost, raw private IPs, metadata
 *      hostnames). Catches the obvious cases and gives a fast, clean error.
 *   2. validatingLookup         — a dns.lookup-compatible function that
 *      resolves the name and rejects when ANY returned address is private.
 *      Wired into the socket connector so it runs on EVERY connect: this is
 *      the DNS-rebinding defence (a hostname that screens clean but resolves
 *      to 10.0.0.5 is refused at connect time), and because redirects open
 *      fresh connections it also covers every redirect hop.
 *   3. The connector itself re-screens the hostname, because net.connect()
 *      bypasses the custom lookup entirely for IP-literal hosts — without
 *      this, a redirect to https://127.0.0.1/ would never hit layer 2.
 *
 * safeFetch(url, opts) = undici fetch through an Agent built from those
 * layers. Use it anywhere user-controlled URLs are fetched.
 */

const dns = require('dns');
const net = require('net');
const { fetch: undiciFetch, Agent, buildConnector } = require('undici');

const PRIVATE_ADDRESS_ERROR_CODE = 'EPRIVATEADDRESS';
const PRIVATE_ADDRESS_ERROR_MESSAGE = 'Refused: target resolves to a private/internal address.';

// Literal screen — kept regex-shaped for parity with the original
// testRunner blocklist; isPrivateHostname() additionally runs full
// net.isIP() + range checks so exotic-but-valid IP spellings are caught.
const PRIVATE_HOST_REGEXES = [
    /^localhost$/i,
    /^127(?:\.\d{1,3}){3}$/,
    /^10(?:\.\d{1,3}){3}$/,
    /^192\.168(?:\.\d{1,3}){2}$/,
    /^172\.(1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/,
    /^169\.254(?:\.\d{1,3}){2}$/,
    /^::1$/,
    /^fc[0-9a-f]{2}:/i,
    /^fd[0-9a-f]{2}:/i,
    /^fe80:/i,
    /^metadata\.google\.internal$/i,
];

function privateAddressError(host) {
    const err = new Error(PRIVATE_ADDRESS_ERROR_MESSAGE);
    err.code = PRIVATE_ADDRESS_ERROR_CODE;
    err.host = host;
    return err;
}

/** True when `err` (or anything in its cause chain) is our refusal. */
function isPrivateAddressError(err) {
    for (let e = err, depth = 0; e && depth < 6; e = e.cause, depth++) {
        if (e.code === PRIVATE_ADDRESS_ERROR_CODE) return true;
        if (Array.isArray(e.errors) && e.errors.some(inner => isPrivateAddressError(inner))) return true;
    }
    return false;
}

function isPrivateIpv4(addr) {
    const parts = addr.split('.').map(Number);
    // Syntactically odd dotted quads shouldn't reach here (net.isIP gates),
    // but if they do, refuse rather than allow.
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0) return true;                            // 0.0.0.0/8 ("this network")
    if (a === 10) return true;                           // 10/8
    if (a === 127) return true;                          // 127/8 loopback
    if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64/10 CGNAT
    if (a === 169 && b === 254) return true;             // 169.254/16 link-local (incl. metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16/12
    if (a === 192 && b === 168) return true;             // 192.168/16
    return false;
}

// Expand a syntactically valid IPv6 (net.isIP === 6, zone stripped) into its
// 8 hextets, folding a trailing dotted-quad (::ffff:127.0.0.1) into hex form.
function ipv6Hextets(addr) {
    let s = addr.toLowerCase();
    const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (v4) {
        const p = v4[1].split('.').map(Number);
        if (p.some(n => n > 255)) return null;
        s = s.slice(0, -v4[1].length)
            + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
    }
    const dbl = s.split('::');
    if (dbl.length > 2) return null;
    const head = dbl[0] ? dbl[0].split(':') : [];
    const tail = dbl.length === 2 && dbl[1] ? dbl[1].split(':') : [];
    const fill = dbl.length === 2 ? new Array(Math.max(0, 8 - head.length - tail.length)).fill('0') : [];
    const hextets = [...head, ...fill, ...tail];
    if (hextets.length !== 8) return null;
    const nums = hextets.map(h => parseInt(h, 16));
    return nums.some(n => !Number.isInteger(n) || n < 0 || n > 0xffff) ? null : nums;
}

/**
 * True when `ip` is a private / internal / non-routable address. Non-IP
 * input returns false — use isPrivateHostname() for hostnames.
 */
function isPrivateIp(ip) {
    if (typeof ip !== 'string') return false;
    let addr = ip.trim().replace(/^\[/, '').replace(/\]$/, '');
    const zone = addr.indexOf('%');
    if (zone !== -1) addr = addr.slice(0, zone);
    const version = net.isIP(addr);
    if (version === 4) return isPrivateIpv4(addr);
    if (version !== 6) return false;
    const h = ipv6Hextets(addr);
    if (!h) return true; // valid per net.isIP but unparseable by us → refuse
    const firstFiveZero = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0;
    if (firstFiveZero && h[5] === 0xffff) {
        // IPv4-mapped (::ffff:a.b.c.d) — unwrap and apply the IPv4 ranges.
        return isPrivateIpv4(`${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`);
    }
    if (firstFiveZero && h[5] === 0 && h[6] === 0 && (h[7] === 0 || h[7] === 1)) return true; // :: and ::1
    if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    return false;
}

/**
 * Literal screen on a URL hostname (no DNS). Empty / non-string hosts are
 * treated as private (refuse). Normalises brackets and the FQDN trailing dot.
 */
function isPrivateHostname(host) {
    if (typeof host !== 'string') return true;
    let h = host.trim().toLowerCase()
        .replace(/^\[/, '').replace(/\]$/, '')
        .replace(/\.$/, '');
    if (!h) return true;
    if (PRIVATE_HOST_REGEXES.some(re => re.test(h))) return true;
    if (net.isIP(h) !== 0 && isPrivateIp(h)) return true;
    return false;
}

/**
 * Build a dns.lookup-compatible function that resolves via `baseLookup`
 * (default: real dns.lookup) and fails with EPRIVATEADDRESS when the name
 * screens private or ANY resolved address is private. Handles both the
 * single-address and `all: true` (Happy Eyeballs) callback shapes.
 */
function makeValidatingLookup(baseLookup = dns.lookup) {
    return function validatingLookup(hostname, options, callback) {
        if (typeof options === 'function') { callback = options; options = {}; }
        if (isPrivateHostname(hostname)) {
            process.nextTick(callback, privateAddressError(hostname));
            return;
        }
        baseLookup(hostname, options, (err, address, family) => {
            if (err) return callback(err);
            const entries = Array.isArray(address) ? address : [{ address, family }];
            for (const entry of entries) {
                const ip = typeof entry === 'string' ? entry : entry && entry.address;
                if (typeof ip !== 'string' || net.isIP(ip) === 0 || isPrivateIp(ip)) {
                    return callback(privateAddressError(hostname));
                }
            }
            callback(null, address, family);
        });
    };
}

const validatingLookup = makeValidatingLookup();

/**
 * Agent whose connector (a) re-screens the hostname — net.connect() skips
 * custom lookups for IP literals, so redirect hops to e.g. https://10.0.0.5/
 * must be refused here — and (b) resolves names through validatingLookup.
 * `lookup` is injectable for tests.
 */
function makeSafeDispatcher({ lookup } = {}) {
    const baseConnect = buildConnector({ lookup: makeValidatingLookup(lookup) });
    const connect = (opts, callback) => {
        const host = String(opts.hostname || '').replace(/^\[/, '').replace(/\]$/, '');
        if (isPrivateHostname(host)) {
            process.nextTick(callback, privateAddressError(host), null);
            return null;
        }
        return baseConnect(opts, callback);
    };
    return new Agent({ connect });
}

let _defaultDispatcher = null;
function defaultDispatcher() {
    if (!_defaultDispatcher) _defaultDispatcher = makeSafeDispatcher();
    return _defaultDispatcher;
}

/**
 * fetch() that can't reach private/internal addresses — every socket
 * connect (initial request AND each redirect hop) revalidates the target,
 * so DNS rebinding and redirect laundering both fail with an error whose
 * cause chain satisfies isPrivateAddressError(). Throws on refusal; callers
 * that need a structured error catch + translate (see codeSandbox).
 */
async function safeFetch(url, opts = {}) {
    const parsed = new URL(typeof url === 'string' ? url : String(url));
    if (isPrivateHostname(parsed.hostname)) throw privateAddressError(parsed.hostname);
    const { dispatcher, ...init } = opts || {};
    return undiciFetch(url, { ...init, dispatcher: dispatcher || defaultDispatcher() });
}

module.exports = {
    PRIVATE_HOST_REGEXES,
    PRIVATE_ADDRESS_ERROR_CODE,
    PRIVATE_ADDRESS_ERROR_MESSAGE,
    isPrivateIp,
    isPrivateHostname,
    isPrivateAddressError,
    makeValidatingLookup,
    validatingLookup,
    makeSafeDispatcher,
    safeFetch,
};
