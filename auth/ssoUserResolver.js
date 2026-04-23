/**
 * SSO User Resolver
 *
 * Shared matching logic used by the OAuth callback to find an existing local
 * user for an SSO login before falling back to creating a new one.
 *
 * Resolution order:
 *   1. Azure OID  (users.azureUserId)      — authoritative for Microsoft SSO
 *   2. Email      (users.email, CI)        — handles users synced before the
 *                                            azureUserId column was populated
 *                                            and manually-created accounts
 *   3. Local id   (users.id)               — legacy/non-Azure providers only
 *
 * Extracted from oauthRoutes.js so it can be unit-tested in isolation and so
 * the directory sync and the login path share the same matching rules.
 */

const AZURE_OID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check whether a string looks like an Azure AD object id (GUID).
 * Used by the cleanup tool to identify duplicate users whose local id is a
 * raw OID — a telltale sign they were auto-created by the buggy OAuth path.
 */
function isAzureOid(value) {
    return typeof value === 'string' && AZURE_OID_REGEX.test(value);
}

/**
 * Derive a stable, human-readable local user id for a new SSO user.
 * Mirrors the slug used by azureGroupSync so a later directory sync does not
 * create a second duplicate for the same person.
 */
function deriveLocalUserId(email, azureUserId) {
    if (email && email.includes('@')) {
        const slug = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]+/g, '');
        if (slug) return slug;
    }
    if (azureUserId) return `azure-${String(azureUserId).substring(0, 8)}`;
    return `sso-${Date.now().toString(36)}`;
}

/**
 * Resolve the canonical local user for an incoming SSO identity.
 *
 * @param {object} identity
 *   - azureUserId: the Azure AD object id (oid) — null for non-Microsoft providers
 *   - email: from the SSO provider (mail or userPrincipalName for Microsoft)
 *   - localId: the provisional local id used by the caller (only used as a
 *              last-resort lookup for non-Azure providers)
 * @param {object} userStore  store with getUserByAzureId, getUserByEmail, getUser, updateUser
 * @returns {Promise<{user: object|null, branch: 'azureId'|'email'|'legacyId'|'none'}>}
 *
 * Side effect: on an email-branch match for a Microsoft user, backfills the
 * user's azureUserId so the next login takes the fast path.
 */
async function resolveExistingSSOUser(identity, userStore) {
    const { azureUserId, email, localId } = identity;

    if (azureUserId) {
        const byAzure = await userStore.getUserByAzureId(azureUserId);
        if (byAzure) return { user: byAzure, branch: 'azureId' };
    }

    if (email) {
        const byEmail = await userStore.getUserByEmail(email);
        if (byEmail) {
            if (azureUserId && !byEmail.azureUserId) {
                await userStore.updateUser(byEmail.id, { azureUserId });
                byEmail.azureUserId = azureUserId;
            }
            return { user: byEmail, branch: 'email' };
        }
    }

    // Non-Azure providers (e.g. Nextcloud) historically used the provider id
    // directly as the local id. Keep that lookup for backward compatibility,
    // but never for Microsoft — its OIDs would re-introduce the duplicate bug.
    if (!azureUserId && localId) {
        const byId = await userStore.getUser(localId);
        if (byId) return { user: byId, branch: 'legacyId' };
    }

    return { user: null, branch: 'none' };
}

/**
 * Find an organization whose allowedDomains (or email domain) matches the
 * email address. Returns null if nothing matches.
 */
function resolveOrgByEmailDomain(email, orgs) {
    if (!email || !email.includes('@')) return null;
    const userDomain = email.split('@')[1].toLowerCase();
    return orgs.find(org => {
        if (Array.isArray(org.allowedDomains) && org.allowedDomains.length > 0) {
            return org.allowedDomains.includes(userDomain);
        }
        if (!org.email || !org.email.includes('@')) return false;
        return org.email.split('@')[1].toLowerCase() === userDomain;
    }) || null;
}

module.exports = {
    isAzureOid,
    deriveLocalUserId,
    resolveExistingSSOUser,
    resolveOrgByEmailDomain,
    AZURE_OID_REGEX,
};
