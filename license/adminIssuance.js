/**
 * Admin License Issuance — direct license minting from the admin console.
 *
 * Bypasses the license.beeflow.ai → JWT → activate flow so a super admin can
 * grant any tier without Stripe or an outbound license-server call. Trust
 * comes from the admin gate on the route, not from a signature.
 *
 * Rows are stamped with a distinct `issuer` (ADMIN_ISSUER) so they are
 * trivially distinguishable from paid/Stripe-issued licenses in the UI,
 * audit log, and refresh scheduler (which skips them).
 *
 * The exported "blob" is a self-contained, base64url-encoded JSON envelope
 * carrying everything needed to re-import this license on another install.
 * It is NOT a JWT — the leading `beeflow-admin-v1.` prefix prevents any
 * confusion with real signed tokens. There is no signature: re-import is
 * gated by the importing install's own admin authentication.
 */

const crypto = require('crypto');
const store = require('./store');
const tiers = require('./tiers');

const ADMIN_ISSUER = 'beeflow.admin.console';
const BLOB_PREFIX = 'beeflow-admin-v1.';

function base64UrlEncode(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Buffer.from(str, 'base64');
}

function encodeAdminLicenseBlob(payload) {
    const json = JSON.stringify(payload);
    return BLOB_PREFIX + base64UrlEncode(json);
}

function decodeAdminLicenseBlob(blob) {
    if (typeof blob !== 'string' || !blob.startsWith(BLOB_PREFIX)) {
        throw new Error('Not an admin license blob');
    }
    const body = blob.slice(BLOB_PREFIX.length);
    let parsed;
    try {
        parsed = JSON.parse(base64UrlDecode(body).toString('utf8'));
    } catch (e) {
        throw new Error(`Malformed admin license blob: ${e.message}`);
    }
    return parsed;
}

function isAdminIssuedLicense(license) {
    return !!license && license.issuer === ADMIN_ISSUER;
}

function normalizeExpiresAt(expiresAt) {
    const d = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    if (Number.isNaN(d.getTime())) throw new Error('Invalid expiresAt');
    if (d.getTime() <= Date.now()) throw new Error('expiresAt must be in the future');
    return d.toISOString();
}

/**
 * Mint a new admin-issued license for an organization.
 *
 * @param {object} args
 * @param {'organization'} args.scope                  — org-scope only in v1
 * @param {string}  args.organizationId
 * @param {string}  args.tier                          — community|pro|enterprise|full
 * @param {string|Date} args.expiresAt                 — ISO date or Date
 * @param {string}  [args.billingInterval='yearly']    — 'monthly' | 'yearly'
 * @param {string[]} [args.featuresOverride]           — optional, replaces tier defaults
 * @param {object}  [args.limitsOverride]              — optional, merged over tier defaults
 * @param {number|null} [args.maxSeats]
 * @param {string}  [args.notes]                       — free-text, audit only
 * @param {string}  [args.activatedBy]                 — admin user id
 */
async function issueAdminLicense({
    scope = 'organization',
    organizationId,
    tier,
    expiresAt,
    billingInterval = 'yearly',
    featuresOverride = null,
    limitsOverride = null,
    maxSeats = null,
    notes = null,
    activatedBy = null,
} = {}) {
    if (scope !== 'organization') {
        throw new Error('Only organization-scope admin grants are supported');
    }
    if (!organizationId) throw new Error('organizationId required');
    if (!tiers.isValidTier(tier)) throw new Error(`Invalid tier: ${tier}`);
    if (tier === 'full' && process.env.ALLOW_ADMIN_FULL_TIER !== 'true') {
        throw new Error('full tier admin grants disabled (set ALLOW_ADMIN_FULL_TIER=true to enable)');
    }
    if (billingInterval !== 'monthly' && billingInterval !== 'yearly') {
        throw new Error(`Invalid billingInterval: ${billingInterval}`);
    }

    const expiresAtIso = normalizeExpiresAt(expiresAt);
    const issuedAtIso = new Date().toISOString();
    const licenseId = crypto.randomUUID();

    const metadata = {
        features: Array.isArray(featuresOverride) ? featuresOverride : tiers.getFeaturesForTier(tier),
        limits: { ...tiers.getLimitsForTier(tier), ...(limitsOverride && typeof limitsOverride === 'object' ? limitsOverride : {}) },
        max_seats: maxSeats != null ? Number(maxSeats) : null,
        branding: {},
        admin_notes: notes || null,
        granted_by: activatedBy || null,
        admin_grant: true,
    };

    const blob = encodeAdminLicenseBlob({
        v: 1,
        license_id: licenseId,
        scope,
        organization_id: organizationId,
        tier,
        issuer: ADMIN_ISSUER,
        issued_at: issuedAtIso,
        expires_at: expiresAtIso,
        billing_interval: billingInterval,
        metadata,
    });

    const lic = await store.upsertLicense({
        licenseId,
        organizationId,
        userId: null,
        scope,
        rawToken: blob,
        tier,
        issuer: ADMIN_ISSUER,
        issuedAt: issuedAtIso,
        expiresAt: expiresAtIso,
        billingInterval,
        activatedBy,
        metadata,
    });

    return { license: publicLicenseShape(lic), blob };
}

/**
 * Import a previously-exported admin license blob into this install. Generates
 * a fresh license id so each install has its own row, but preserves tier,
 * expiry, billing interval, and metadata.
 */
async function importAdminLicense(blob, { activatedBy = null, organizationId = null } = {}) {
    const decoded = decodeAdminLicenseBlob(blob);
    if (decoded.v !== 1) throw new Error(`Unsupported blob version: ${decoded.v}`);
    if (!tiers.isValidTier(decoded.tier)) throw new Error(`Invalid tier in blob: ${decoded.tier}`);
    if (decoded.tier === 'full' && process.env.ALLOW_ADMIN_FULL_TIER !== 'true') {
        throw new Error('full tier admin imports disabled (set ALLOW_ADMIN_FULL_TIER=true to enable)');
    }

    const targetOrgId = organizationId || decoded.organization_id;
    if (!targetOrgId) throw new Error('organizationId required (not present in blob and not provided)');

    return issueAdminLicense({
        scope: 'organization',
        organizationId: targetOrgId,
        tier: decoded.tier,
        expiresAt: decoded.expires_at,
        billingInterval: decoded.billing_interval || 'yearly',
        featuresOverride: decoded.metadata?.features || null,
        limitsOverride: decoded.metadata?.limits || null,
        maxSeats: decoded.metadata?.max_seats ?? null,
        notes: decoded.metadata?.admin_notes || null,
        activatedBy,
    });
}

function publicLicenseShape(lic) {
    if (!lic) return null;
    return {
        id: lic.id,
        tier: lic.tier,
        issuer: lic.issuer,
        issuedAt: lic.issuedAt,
        expiresAt: lic.expiresAt,
        billingInterval: lic.billingInterval,
        lastRefreshAt: lic.lastRefreshAt,
        refreshStatus: lic.refreshStatus,
        revokedAt: lic.revokedAt,
        scope: lic.scope,
        organizationId: lic.organizationId,
        userId: lic.userId,
        activatedBy: lic.activatedBy,
        metadata: lic.metadata || {},
        adminGrant: isAdminIssuedLicense(lic),
    };
}

module.exports = {
    ADMIN_ISSUER,
    BLOB_PREFIX,
    issueAdminLicense,
    importAdminLicense,
    encodeAdminLicenseBlob,
    decodeAdminLicenseBlob,
    isAdminIssuedLicense,
    publicLicenseShape,
};
