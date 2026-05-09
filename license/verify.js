/**
 * License JWT Verification
 *
 * Verifies RS256-signed license tokens issued by license.beeflow.ai.
 * Implemented with Node's built-in `crypto` (no external JWT lib) so we
 * don't add a dependency for one signature scheme.
 *
 * Trust model:
 *   - The Beeflow public key is shipped in the binary via env var
 *     `LICENSE_PUBLIC_KEY` (PEM, multi-line) or `LICENSE_PUBLIC_KEY_FILE`
 *     (path to a .pem file). For dev/testing a generated dev key is used
 *     when neither is set, but tier resolution then refuses to upgrade
 *     beyond `community`.
 *
 * Full-tier guard:
 *   The token's `tier` claim MUST be backed by an issuer string we expect.
 *   Even though RS256 alone is sufficient (you can't forge without the
 *   private key), we double-lock so a leaked Pro/Enterprise signing key
 *   can't issue Full licenses without also matching the internal issuer.
 */

const crypto = require('crypto');
const fs = require('fs');
const { isValidTier, TIER_HIERARCHY } = require('./tiers');

const EXPECTED_ISSUER = 'license.beeflow.ai';
const FULL_TIER_ISSUER = 'license.beeflow.ai/internal';
const ALG = 'RS256';

let _cachedKey = null;
let _cachedKeySource = null;

function loadPublicKey() {
    if (_cachedKey) return { key: _cachedKey, source: _cachedKeySource };

    const inline = process.env.LICENSE_PUBLIC_KEY;
    if (inline && inline.includes('BEGIN PUBLIC KEY')) {
        _cachedKey = inline.replace(/\\n/g, '\n');
        _cachedKeySource = 'env';
        return { key: _cachedKey, source: _cachedKeySource };
    }

    const fromFile = process.env.LICENSE_PUBLIC_KEY_FILE;
    if (fromFile) {
        try {
            _cachedKey = fs.readFileSync(fromFile, 'utf8');
            _cachedKeySource = 'file';
            return { key: _cachedKey, source: _cachedKeySource };
        } catch (e) {
            console.error('[License Verify] Could not read LICENSE_PUBLIC_KEY_FILE:', e.message);
        }
    }

    return { key: null, source: null };
}

function base64UrlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Buffer.from(str, 'base64');
}

function decodeJwtUnverified(token) {
    if (typeof token !== 'string') throw new Error('Token must be a string');
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Malformed JWT');
    const header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8'));
    const payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
    return { header, payload, parts };
}

/**
 * Verify the JWT signature and required claims.
 * @returns {{ valid: true, payload: object } | { valid: false, error: string }}
 */
function verifyToken(token, { now = Math.floor(Date.now() / 1000), publicKeyOverride = null } = {}) {
    let decoded;
    try {
        decoded = decodeJwtUnverified(token);
    } catch (e) {
        return { valid: false, error: `decode_failed: ${e.message}` };
    }

    const { header, payload, parts } = decoded;

    if (header.alg !== ALG) {
        return { valid: false, error: `unexpected_alg: ${header.alg}` };
    }
    if (header.typ && header.typ !== 'JWT') {
        return { valid: false, error: `unexpected_typ: ${header.typ}` };
    }

    const publicKey = publicKeyOverride || loadPublicKey().key;
    if (!publicKey) {
        return { valid: false, error: 'no_public_key_configured' };
    }

    const signingInput = `${parts[0]}.${parts[1]}`;
    const signature = base64UrlDecode(parts[2]);
    let sigOk = false;
    try {
        sigOk = crypto.verify(
            'RSA-SHA256',
            Buffer.from(signingInput),
            { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
            signature
        );
    } catch (e) {
        return { valid: false, error: `signature_check_failed: ${e.message}` };
    }
    if (!sigOk) return { valid: false, error: 'invalid_signature' };

    // Required claims
    if (typeof payload.iss !== 'string') return { valid: false, error: 'missing_iss' };
    if (!isExpectedIssuer(payload.iss)) return { valid: false, error: `untrusted_issuer: ${payload.iss}` };
    if (typeof payload.tier !== 'string' || !isValidTier(payload.tier)) {
        return { valid: false, error: `invalid_tier: ${payload.tier}` };
    }
    if (typeof payload.license_id !== 'string' || !payload.license_id) {
        return { valid: false, error: 'missing_license_id' };
    }
    if (typeof payload.exp !== 'number') return { valid: false, error: 'missing_exp' };
    if (payload.exp <= now) return { valid: false, error: 'token_expired' };
    if (typeof payload.nbf === 'number' && payload.nbf > now + 60) {
        return { valid: false, error: 'token_not_yet_valid' };
    }

    // Hard lock: 'full' tier requires internal issuer.
    if (payload.tier === 'full' && !isFullTierIssuer(payload.iss)) {
        return { valid: false, error: 'full_tier_requires_internal_issuer' };
    }

    return { valid: true, payload };
}

function isExpectedIssuer(iss) {
    return iss === EXPECTED_ISSUER || iss === FULL_TIER_ISSUER;
}

function isFullTierIssuer(iss) {
    return iss === FULL_TIER_ISSUER;
}

/**
 * For tests: replace the cached public key. Pass null to clear.
 */
function _setPublicKeyForTesting(pem) {
    _cachedKey = pem;
    _cachedKeySource = pem ? 'test' : null;
}

module.exports = {
    verifyToken,
    decodeJwtUnverified,
    isExpectedIssuer,
    isFullTierIssuer,
    loadPublicKey,
    EXPECTED_ISSUER,
    FULL_TIER_ISSUER,
    TIER_HIERARCHY,
    _setPublicKeyForTesting,
};
