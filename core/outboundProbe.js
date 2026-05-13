/**
 * Outbound Probe — captures the real destination IP for integration tool calls.
 *
 * Why this exists: post-call DNS resolution (the legacy path) can return a different
 * IP than the one the SDK actually connected to, especially for CDN-fronted services.
 * This module replaces "we'll figure it out later" with "we record where the socket
 * actually went, at connect time."
 *
 * Two capture modes:
 *   1. socket        — undici Agent with a custom DNS lookup. The address returned
 *                      by lookup is the address the socket connects to, so we know
 *                      exactly where the bytes went.
 *   2. dns_pre_call  — for callers we can't route through undici (some SDKs). We do
 *                      a dns.lookup() immediately before the call. Less authoritative
 *                      but still per-call.
 *
 * NEVER fires unprompted. No cron, no health checks. A probe only happens when a
 * real tool call is in flight.
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const dns = require('node:dns');
const { Agent, fetch: undiciFetch } = require('undici');

const probeStore = new AsyncLocalStorage();

function emptyProbe() {
    return {
        hostname: null,
        peer_ip: null,
        peer_ip_source: null, // 'socket' | 'dns_pre_call' | 'local'
        tls_servername: null,
        connect_ms: null,
        is_local: false,
    };
}

function currentProbe() {
    return probeStore.getStore() || null;
}

/**
 * Run `fn` inside a probe context. After `fn` resolves, the probe object
 * contains whatever the underlying integration captured.
 */
async function runWithProbe(fn) {
    const probe = emptyProbe();
    const result = await probeStore.run(probe, async () => {
        return await fn();
    });
    return { result, probe };
}

// A single shared Agent — undici pools per-origin, so this is the cheapest design.
// The lookup callback records the resolved IP into the active probe (if any).
const probeAgent = new Agent({
    connect: {
        lookup(hostname, opts, cb) {
            const t0 = Date.now();
            dns.lookup(hostname, opts || {}, (err, address, family) => {
                if (!err) {
                    const probe = probeStore.getStore();
                    if (probe) {
                        // dns.lookup returns an array of {address, family} when
                        // opts.all is set, else a single string. undici asks for
                        // all addresses; the socket will use the first.
                        const ip = Array.isArray(address) ? (address[0]?.address || null) : address;
                        probe.hostname = hostname;
                        probe.peer_ip = ip;
                        probe.peer_ip_source = 'socket';
                        probe.tls_servername = hostname;
                        probe.connect_ms = Date.now() - t0;
                    }
                }
                cb(err, address, family);
            });
        },
    },
});

/**
 * fetch() that captures the destination IP. Drop-in replacement for global fetch.
 * Must be called inside a runWithProbe() context to be useful.
 */
async function probedFetch(input, init) {
    return undiciFetch(input, { ...init, dispatcher: probeAgent });
}

/**
 * For callers that can't route through undici (third-party SDKs that don't accept
 * a custom dispatcher). Resolves the hostname now and writes the IP to the active
 * probe. Returns the resolved IP so the caller can pin it if it wants to.
 */
async function dnsPreCallProbe(hostname) {
    return new Promise((resolve) => {
        dns.lookup(hostname, {}, (err, address) => {
            if (err) return resolve(null);
            const probe = probeStore.getStore();
            if (probe) {
                probe.hostname = hostname;
                probe.peer_ip = address;
                probe.peer_ip_source = 'dns_pre_call';
                probe.tls_servername = hostname;
            }
            resolve(address);
        });
    });
}

/**
 * Mark the current call as a local-only integration (kb_search, on-host Nextcloud,
 * local Whisper). Skips network capture but keeps the probe row honest.
 */
function markLocal(label) {
    const probe = probeStore.getStore();
    if (probe) {
        probe.is_local = true;
        probe.hostname = label || 'local';
        probe.peer_ip_source = 'local';
    }
}

/**
 * Install a global fetch shim that routes through the probe agent when a probe
 * context is active. This means every integration's existing `fetch(...)` call
 * captures the destination IP automatically — no per-file changes required.
 * Outside a probe context the shim is a no-op pass-through to the native fetch
 * (so background tasks, healthchecks, the AI provider, etc. are unaffected).
 */
function installGlobalFetchShim() {
    if (globalThis.__beeflowProbeFetchInstalled) return;
    globalThis.__beeflowProbeFetchInstalled = true;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function probedGlobalFetch(input, init) {
        const probe = probeStore.getStore();
        if (!probe) return originalFetch(input, init);
        // Don't clobber an explicit dispatcher the caller passed in.
        if (init && init.dispatcher) return originalFetch(input, init);
        return undiciFetch(input, { ...(init || {}), dispatcher: probeAgent });
    };
}

installGlobalFetchShim();

module.exports = {
    probedFetch,
    runWithProbe,
    currentProbe,
    dnsPreCallProbe,
    markLocal,
    probeAgent,
    installGlobalFetchShim,
};
