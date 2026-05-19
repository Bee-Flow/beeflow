/**
 * License Store — DB layer for the `license_keys` table.
 *
 * Stores the activated license JWT alongside its decoded metadata so we can
 * answer "what is the active tier for this org/user?" without re-verifying the
 * token on every request. Verification still runs at activation time and on
 * each refresh-ping.
 *
 * Scope:
 *   - 'organization'  — bound to an organizationId (multi-user installs)
 *   - 'consumer'      — bound to a userId (single-user / consumer plans)
 *
 * Refresh status:
 *   active   — token is valid and (if monthly) recently re-confirmed
 *   pending  — just activated, no refresh attempted yet
 *   grace    — refresh failed but still inside the grace window
 *   expired  — past `expires_at` or grace window
 *   revoked  — license server returned status=revoked
 */

const crypto = require('crypto');
const { run, getOne, getAll } = require('../db');
const userStore = require('../stores/userStore');

function parseJSON(s, fallback) {
    if (!s) return fallback;
    if (typeof s === 'object') return s;
    try { return JSON.parse(s); } catch (_) { return fallback; }
}

function rowToLicense(row) {
    if (!row) return null;
    return {
        id: row.id,
        organizationId: row.organization_id,
        userId: row.user_id,
        scope: row.scope,
        rawToken: row.raw_token,
        tier: row.tier,
        issuer: row.issuer,
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
        billingInterval: row.billing_interval,
        lastRefreshAt: row.last_refresh_at,
        refreshStatus: row.refresh_status,
        revokedAt: row.revoked_at,
        activatedBy: row.activated_by,
        metadata: parseJSON(row.metadata, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/**
 * Insert or replace a license activation. Older active licenses for the same
 * scope target are marked expired so only one is "current".
 */
async function upsertLicense({
    licenseId,
    organizationId = null,
    userId = null,
    scope,
    rawToken,
    tier,
    issuer,
    issuedAt,
    expiresAt,
    billingInterval,
    activatedBy,
    metadata = {},
}) {
    if (!licenseId || !rawToken || !tier || !scope) {
        throw new Error('upsertLicense: missing required fields');
    }
    if (scope === 'organization' && !organizationId) {
        throw new Error('upsertLicense: organizationId required for organization scope');
    }
    if (scope === 'consumer' && !userId) {
        throw new Error('upsertLicense: userId required for consumer scope');
    }
    // scope='server' has no id binding — admin-issued exportable blob only.

    // Mark previous active licenses for this scope target as superseded.
    if (scope === 'organization') {
        await run(
            `UPDATE license_keys SET refresh_status = 'expired', updated_at = NOW()
             WHERE organization_id = $1 AND id != $2 AND refresh_status NOT IN ('expired', 'revoked')`,
            [organizationId, licenseId]
        );
    } else if (scope === 'consumer') {
        await run(
            `UPDATE license_keys SET refresh_status = 'expired', updated_at = NOW()
             WHERE user_id = $1 AND id != $2 AND refresh_status NOT IN ('expired', 'revoked')`,
            [userId, licenseId]
        );
    } else if (scope === 'server' && !organizationId && !userId) {
        // Server-scope rows are now BOTH exportable artefacts AND the active
        // server-wide licence on this install (super-admin can apply one via
        // POST /api/license/activate {scope:'server'}). Only one active row
        // at a time — supersede older server-scope rows so the resolver's
        // "highest issued" query always returns the latest activation.
        // Skip the sweep when an admin-issued blob with scope='server' is
        // re-bound to an org on import (still scope='server' historically
        // in early adminIssuance paths; new code uses scope='organization').
        await run(
            `UPDATE license_keys SET refresh_status = 'expired', updated_at = NOW()
             WHERE scope = 'server' AND organization_id IS NULL AND user_id IS NULL
               AND id != $1 AND refresh_status NOT IN ('expired', 'revoked')`,
            [licenseId]
        );
    }

    // Upsert by primary key. Newly activated licenses start as 'active' —
    // the RS256 signature is the proof of validity. The refresh scheduler
    // exists to *catch* later revocations on monthly subs, not to gate
    // initial trust. Status flips to 'grace'/'expired' only on refresh
    // failures, and to 'revoked' when the license server says so.
    await run(
        `INSERT INTO license_keys
            (id, organization_id, user_id, scope, raw_token, tier, issuer,
             issued_at, expires_at, billing_interval, refresh_status,
             activated_by, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11, $12, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
            raw_token = EXCLUDED.raw_token,
            tier = EXCLUDED.tier,
            issuer = EXCLUDED.issuer,
            expires_at = EXCLUDED.expires_at,
            billing_interval = EXCLUDED.billing_interval,
            refresh_status = 'active',
            activated_by = EXCLUDED.activated_by,
            metadata = EXCLUDED.metadata,
            revoked_at = NULL,
            updated_at = NOW()`,
        [
            licenseId, organizationId, userId, scope, rawToken, tier, issuer,
            issuedAt, expiresAt, billingInterval || 'monthly',
            activatedBy || null, JSON.stringify(metadata || {}),
        ]
    );

    const auditTarget = scope === 'organization' ? organizationId
        : scope === 'consumer' ? userId
        : null; // server-scope: no binding target
    await logLicenseAudit('license_activated', auditTarget, activatedBy, null, {
        license_id: licenseId, scope, tier, billing_interval: billingInterval, expires_at: expiresAt,
    });

    return getLicenseById(licenseId);
}

async function getLicenseById(licenseId) {
    const row = await getOne(`SELECT * FROM license_keys WHERE id = $1`, [licenseId]);
    return rowToLicense(row);
}

/**
 * Returns the most recently issued non-revoked license for an org.
 * "Active" here means `refresh_status` ∈ {active, pending, grace}; expired
 * and revoked licenses are excluded.
 */
async function getActiveLicenseForOrg(organizationId) {
    if (!organizationId) return null;
    const row = await getOne(
        `SELECT * FROM license_keys
         WHERE organization_id = $1
           AND refresh_status NOT IN ('expired', 'revoked')
         ORDER BY issued_at DESC LIMIT 1`,
        [organizationId]
    );
    return rowToLicense(row);
}

async function getActiveLicenseForUser(userId) {
    if (!userId) return null;
    const row = await getOne(
        `SELECT * FROM license_keys
         WHERE user_id = $1
           AND refresh_status NOT IN ('expired', 'revoked')
         ORDER BY issued_at DESC LIMIT 1`,
        [userId]
    );
    return rowToLicense(row);
}

/**
 * Server-wide licence: a single unbound row (organization_id IS NULL AND
 * user_id IS NULL) with scope='server'. When present and active, the
 * resolver treats this as the authoritative tier for the whole install,
 * overriding every per-org and per-user row. Returns null when no active
 * server-scope row exists.
 *
 * Only ONE active server row should ever exist; upsertLicense supersedes
 * older server rows via a sweep added alongside this getter.
 */
async function getActiveLicenseForServer() {
    const row = await getOne(
        `SELECT * FROM license_keys
         WHERE scope = 'server'
           AND organization_id IS NULL
           AND user_id IS NULL
           AND refresh_status NOT IN ('expired', 'revoked')
         ORDER BY issued_at DESC LIMIT 1`,
        []
    );
    return rowToLicense(row);
}

/**
 * Find every active license that is either
 *   (a) scoped directly to one of the given orgs, OR
 *   (b) scoped to a user whose primary organizationId is one of the given orgs.
 *
 * Used by the license middleware to spread a single org/admin licence across
 * every member of that org — including members who joined the org via a
 * group (no direct user.organizationId set on their record).
 *
 * NB: group-based licensee org-spread (where the licensee themselves has no
 * direct organizationId but is in the org via a group) is not handled by
 * this query — that's a much rarer case and would need a JSON contains query
 * on users.groups. The common case (org-admin holds the license) is covered.
 */
async function getActiveLicensesForOrgs(orgIds = []) {
    if (!Array.isArray(orgIds) || orgIds.length === 0) return [];
    const rows = await getAll(
        `SELECT lk.* FROM license_keys lk
         LEFT JOIN users u ON u.id = lk.user_id
         WHERE lk.refresh_status NOT IN ('expired', 'revoked')
           AND (
             lk.organization_id = ANY($1::text[])
             OR u."organizationId" = ANY($1::text[])
           )
         ORDER BY lk.issued_at DESC`,
        [orgIds]
    );
    return rows.map(rowToLicense);
}

/**
 * Returns all monthly licenses that have not been refreshed within the
 * given window (in seconds). The refresh scheduler walks this set.
 */
async function getLicensesNeedingRefresh(stalerThanSeconds = 86400) {
    const rows = await getAll(
        `SELECT * FROM license_keys
         WHERE billing_interval = 'monthly'
           AND refresh_status NOT IN ('expired', 'revoked')
           AND (last_refresh_at IS NULL OR last_refresh_at < NOW() - ($1 || ' seconds')::interval)`,
        [String(stalerThanSeconds)]
    );
    return rows.map(rowToLicense);
}

async function markRefreshSuccess(licenseId, { newToken = null, newExpiresAt = null } = {}) {
    if (newToken) {
        await run(
            `UPDATE license_keys
             SET raw_token = $1, expires_at = COALESCE($2, expires_at),
                 last_refresh_at = NOW(), refresh_status = 'active', updated_at = NOW()
             WHERE id = $3`,
            [newToken, newExpiresAt, licenseId]
        );
    } else {
        await run(
            `UPDATE license_keys
             SET last_refresh_at = NOW(), refresh_status = 'active', updated_at = NOW()
             WHERE id = $1`,
            [licenseId]
        );
    }
}

async function markRefreshFailure(licenseId, { graceWindowSeconds = 10 * 86400 } = {}) {
    // Falls into 'grace' until the grace window passes since last successful refresh.
    const lic = await getLicenseById(licenseId);
    if (!lic) return;
    const lastOk = lic.lastRefreshAt ? new Date(lic.lastRefreshAt).getTime() : new Date(lic.issuedAt).getTime();
    const ageSec = (Date.now() - lastOk) / 1000;
    const newStatus = ageSec > graceWindowSeconds ? 'expired' : 'grace';
    await run(
        `UPDATE license_keys SET refresh_status = $1, updated_at = NOW() WHERE id = $2`,
        [newStatus, licenseId]
    );
    if (newStatus === 'expired') {
        await logLicenseAudit('license_expired_after_grace', lic.organizationId || lic.userId, null, null, { license_id: licenseId });
    }
}

async function markRevoked(licenseId, reason = null) {
    const lic = await getLicenseById(licenseId);
    if (!lic) return;
    await run(
        `UPDATE license_keys
         SET refresh_status = 'revoked', revoked_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [licenseId]
    );
    await logLicenseAudit('license_revoked', lic.organizationId || lic.userId, null, null, { license_id: licenseId, reason });

    // Session bust: without this, existing cookies still validate for up to
    // 30 days. Tier resolution would catch the revocation on the next
    // request, but the user remains technically authenticated. Forcing a
    // re-login closes that window and matches the operator's intent.
    try {
        const { bustSessionsForOrg, bustSessionsForUser } = require('../auth/sessionCache');
        if (lic.scope === 'organization' && lic.organizationId) {
            await bustSessionsForOrg(lic.organizationId);
        } else if (lic.scope === 'consumer' && lic.userId) {
            await bustSessionsForUser(lic.userId);
        }
    } catch (e) {
        console.warn('[License Store] markRevoked session bust failed:', e.message);
    }
}

/**
 * List licenses issued by the admin console (issuer = 'beeflow.admin.console').
 * Pass `organizationId` to scope to a single org. Includes expired/revoked rows
 * by default so the admin UI can show full grant history.
 */
async function getAdminIssuedLicenses({ organizationId = null, includeInactive = true } = {}) {
    const params = ['beeflow.admin.console'];
    let where = `issuer = $1`;
    if (organizationId) {
        params.push(organizationId);
        where += ` AND organization_id = $${params.length}`;
    }
    if (!includeInactive) {
        where += ` AND refresh_status NOT IN ('expired', 'revoked')`;
    }
    const rows = await getAll(
        `SELECT * FROM license_keys WHERE ${where} ORDER BY issued_at DESC`,
        params
    );
    return rows.map(rowToLicense);
}

/**
 * Extend (or shorten) the expiry on an existing license. Audited.
 */
async function extendExpiry(licenseId, newExpiresAt, changedBy) {
    const lic = await getLicenseById(licenseId);
    if (!lic) return null;
    const iso = newExpiresAt instanceof Date ? newExpiresAt.toISOString() : new Date(newExpiresAt).toISOString();
    await run(
        `UPDATE license_keys
         SET expires_at = $1,
             refresh_status = CASE WHEN refresh_status IN ('expired') THEN 'active' ELSE refresh_status END,
             updated_at = NOW()
         WHERE id = $2`,
        [iso, licenseId]
    );
    await logLicenseAudit('license_extended', lic.organizationId || lic.userId, changedBy, { expires_at: lic.expiresAt }, { expires_at: iso, license_id: licenseId });
    return getLicenseById(licenseId);
}

async function deactivateLicense(licenseId, deactivatedBy) {
    const lic = await getLicenseById(licenseId);
    if (!lic) return false;
    await run(
        `UPDATE license_keys SET refresh_status = 'expired', updated_at = NOW() WHERE id = $1`,
        [licenseId]
    );
    await logLicenseAudit('license_deactivated', lic.organizationId || lic.userId, deactivatedBy, null, { license_id: licenseId });
    return true;
}

/**
 * Audit log entries are stored alongside subscription audits in
 * `subscription_audit_log`. Action names use the `license_*` prefix.
 */
async function logLicenseAudit(action, targetId, changedBy, oldValues, newValues) {
    if (!targetId) {
        // Still log it as system-scoped — useful when activating before an
        // organization exists (rare, but possible in single-user installs).
        targetId = 'system';
    }
    try {
        await userStore.logSubscriptionAudit(action, 'license', targetId, changedBy, oldValues, newValues);
    } catch (e) {
        console.error('[License Store] Audit log error:', e.message);
    }
}

module.exports = {
    upsertLicense,
    getLicenseById,
    getActiveLicenseForOrg,
    getActiveLicenseForUser,
    getActiveLicenseForServer,
    getActiveLicensesForOrgs,
    getLicensesNeedingRefresh,
    markRefreshSuccess,
    markRefreshFailure,
    markRevoked,
    deactivateLicense,
    getAdminIssuedLicenses,
    extendExpiry,
    logLicenseAudit,
    // exported for tests
    _internal: { rowToLicense, parseJSON },
};
