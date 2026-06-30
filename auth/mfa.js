/**
 * MFA (TOTP) helpers — shared by mfaRoutes.js (enroll/manage) and the login
 * flow in loginRoutes.js (verify the second factor before a session is
 * established).
 *
 * Storage model (columns on `users`, see userStore migration):
 *   - mfa_enabled (bool)
 *   - mfa_secret  — base32 TOTP secret, ENCRYPTED at rest via the configStore
 *                   AES-256-GCM envelope (never stored in plaintext).
 *   - mfa_recovery_codes — JSON array of { hash, usedAt } where `hash` is a
 *                   bcrypt hash of a one-time recovery code.
 *
 * TOTP is verified with a ±1 step (30s) window to tolerate clock drift.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const configStore = require('../stores/configStore');

// Tolerate one 30s step of clock drift on either side.
authenticator.options = { window: 1 };

const ISSUER = 'Bee Flow';
const RECOVERY_CODE_COUNT = 10;

function generateSecret() {
    return authenticator.generateSecret(); // base32
}

function otpauthUrl(secret, accountLabel) {
    return authenticator.keyuri(accountLabel || 'user', ISSUER, secret);
}

async function qrDataUrl(otpauth) {
    return QRCode.toDataURL(otpauth, { margin: 1, width: 220 });
}

function verifyTotp(secretPlain, token) {
    if (!secretPlain || !token) return false;
    const clean = String(token).replace(/\s+/g, '');
    if (!/^\d{6}$/.test(clean)) return false;
    try {
        return authenticator.verify({ token: clean, secret: secretPlain });
    } catch (_) {
        return false;
    }
}

// Encrypt / decrypt the TOTP secret at rest using the configStore envelope.
function encryptSecret(secretPlain) {
    return configStore.encryptValue(secretPlain);
}
function decryptSecret(stored) {
    if (!stored) return null;
    return configStore.decryptValue(stored);
}

// ── Recovery codes ───────────────────────────────────────────────────────
// Human-friendly one-time codes ("a1b2-c3d4"). Stored only as bcrypt hashes.
function _randomCode() {
    const raw = crypto.randomBytes(4).toString('hex'); // 8 hex chars
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

async function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
    const plain = Array.from({ length: count }, () => _randomCode());
    const stored = await Promise.all(plain.map(async (c) => ({
        hash: await bcrypt.hash(c.replace('-', ''), 10),
        usedAt: null,
    })));
    return { plain, stored };
}

function parseRecoveryCodes(json) {
    if (!json) return [];
    try {
        const arr = typeof json === 'string' ? JSON.parse(json) : json;
        return Array.isArray(arr) ? arr : [];
    } catch (_) {
        return [];
    }
}

/**
 * Verify a recovery code against the stored hashes. Returns the updated
 * codes array (with the matched entry marked used) when valid, or null when
 * no unused code matches. The caller persists the returned array.
 */
async function consumeRecoveryCode(storedCodesJson, inputCode) {
    const codes = parseRecoveryCodes(storedCodesJson);
    const clean = String(inputCode || '').replace(/[\s-]/g, '').toLowerCase();
    if (!clean) return null;
    for (const entry of codes) {
        if (entry.usedAt) continue;
        try {
            if (await bcrypt.compare(clean, entry.hash)) {
                entry.usedAt = new Date().toISOString();
                return codes;
            }
        } catch (_) { /* skip malformed entry */ }
    }
    return null;
}

function remainingRecoveryCodes(storedCodesJson) {
    return parseRecoveryCodes(storedCodesJson).filter(c => !c.usedAt).length;
}

module.exports = {
    generateSecret,
    otpauthUrl,
    qrDataUrl,
    verifyTotp,
    encryptSecret,
    decryptSecret,
    generateRecoveryCodes,
    parseRecoveryCodes,
    consumeRecoveryCode,
    remainingRecoveryCodes,
    RECOVERY_CODE_COUNT,
};
