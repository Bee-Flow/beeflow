/**
 * Session-token bridge for cross-context auth (embedded iframe, popup handoff).
 *
 * The browser's storage partitioning blocks the BeeFlow session cookie from
 * being shared between a top-level BeeFlow popup and a BeeFlow iframe embedded
 * inside another origin (e.g. Nextcloud). To bridge that gap we mint a random
 * `sessionToken` on the server, hand it to the iframe out-of-band, and let the
 * iframe present it via the `X-Session-Token` header on every request — the
 * middleware in server/index.js merges that into req.session.
 *
 * Two stores live here:
 *   - sessionTokens (`bf:stok:<token>`) — long-lived (default 1 h), used as the
 *     bearer the iframe sends with each request.
 *   - pickupTokens  (`bf:pickup:<id>`)  — short-lived (default 2 min), used
 *     once during the popup→iframe handoff right after OAuth completes.
 *
 * Both fall back to in-memory Maps if Redis isn't available, which is fine for
 * single-instance dev. Production should run with Redis so the popup process
 * and iframe process see the same store.
 */

const crypto = require('crypto');
const { getRedis } = require('../db');

const _sessionTokenFallback = new Map();
const _pickupFallback = new Map();

async function getSessionToken(token) {
    const r = getRedis();
    if (r) {
        const val = await r.get(`bf:stok:${token}`);
        return val ? JSON.parse(val) : null;
    }
    return _sessionTokenFallback.get(token) || null;
}

async function setSessionToken(token, data, ttlSeconds = 3600) {
    const r = getRedis();
    if (r) {
        await r.set(`bf:stok:${token}`, JSON.stringify(data), 'EX', ttlSeconds);
    } else {
        _sessionTokenFallback.set(token, data);
        setTimeout(() => _sessionTokenFallback.delete(token), ttlSeconds * 1000);
    }
}

// ── Pickup tokens (popup → iframe handoff after OAuth) ───────────────
// The popup deposits a sessionToken under a random pickupId; the iframe claims
// it once. Pickup IDs are short-lived (default 2 minutes — long enough to
// cover an OAuth round-trip but short enough that abandoned popups don't leak
// claimable tokens).

async function setPickup(pickupId, data, ttlSeconds = 120) {
    const r = getRedis();
    if (r) {
        await r.set(`bf:pickup:${pickupId}`, JSON.stringify(data), 'EX', ttlSeconds);
    } else {
        _pickupFallback.set(pickupId, data);
        setTimeout(() => _pickupFallback.delete(pickupId), ttlSeconds * 1000);
    }
}

async function claimPickup(pickupId) {
    const r = getRedis();
    if (r) {
        const key = `bf:pickup:${pickupId}`;
        const val = await r.get(key);
        if (val) await r.del(key);
        return val ? JSON.parse(val) : null;
    }
    const data = _pickupFallback.get(pickupId);
    if (data) _pickupFallback.delete(pickupId);
    return data || null;
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

module.exports = {
    getSessionToken,
    setSessionToken,
    setPickup,
    claimPickup,
    generateToken,
};
