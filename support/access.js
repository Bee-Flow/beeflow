/**
 * Per-inbox access control for the tenant Support studio.
 *
 * Two layers gate a support inbox:
 *   1. The org-level `support_inbox` permission (enforced by the router) — "may
 *      this user use the Support feature at all?"
 *   2. Per-inbox group access (this module) — "may this user work THIS inbox?"
 *
 * An inbox with empty `shared_groups` is open to any org member who passes layer
 * 1 (preserves the original behaviour). A non-empty `shared_groups` restricts it
 * to members of those organisation groups; org admins and the inbox owner always
 * retain access so an inbox can never be locked away from its own org's admins.
 *
 * Mirrors the proven KB pattern (KnowledgeBasesStore.canUserAccessKB) so the two
 * never drift — minus the `is_published` draft concept (an inbox is always live).
 */

const supportInboxStore = require('../stores/supportInboxStore');
const userStore = require('../stores/userStore');
const { resolveUserOrgIds, isOrgAdminRole } = require('../auth');

function getUserId(req) { return req.session?.user?.id || null; }

/** Resolve the caller's group ids (user.groups is a JSON string or array). */
async function resolveUserGroups(req) {
    const userId = getUserId(req);
    if (!userId) return [];
    try {
        const user = await userStore.getUser(userId);
        if (!user) return [];
        if (Array.isArray(user.groups)) return user.groups;
        if (typeof user.groups === 'string') {
            try { return JSON.parse(user.groups || '[]'); } catch { return []; }
        }
    } catch (_) { /* ignore */ }
    return [];
}

/** True when the caller is an organisation admin (org_admin / legacy admin). */
async function resolveIsOrgAdmin(req) {
    const userId = getUserId(req);
    if (!userId) return false;
    try {
        const user = await userStore.getUser(userId);
        return !!(user && isOrgAdminRole(user.orgRole));
    } catch (_) { return false; }
}

/**
 * Org ids the caller may act within. Mirrors supportInbox route's resolveOrgScope:
 * super admins (resolveUserOrgIds === null) fall back to their own org so they
 * see their own org's inboxes (not every tenant's).
 * @returns {{ orgIds: Set|null, scope: string[] }}
 */
async function resolveOrgScope(req) {
    const ids = await resolveUserOrgIds(req);
    if (ids === null) {
        const oid = req.session?.user?.organizationId;
        return { orgIds: null, scope: oid ? [oid] : [] };
    }
    return { orgIds: ids, scope: Array.from(ids) };
}

/**
 * Single source of truth: "may this user work this inbox?".
 * @param {object} inbox - support_inboxes row (must include organization_id,
 *   created_by, shared_groups)
 * @param {string} userId
 * @param {Set|null|undefined} orgIds - null = super admin; a Set = the user's
 *   org ids; undefined = skip org check (list-path callers already scoped by org)
 * @param {string[]} userGroups
 * @param {{isOrgAdmin?: boolean}} opts
 */
function canUserAccessInbox(inbox, userId, orgIds = undefined, userGroups = [], opts = {}) {
    if (!inbox) return false;
    // Owner (creator) always retains access.
    if (inbox.created_by && inbox.created_by === userId) return true;
    // Super admin.
    if (orgIds === null) return true;
    // Org admins see every inbox in their organisation.
    if (opts.isOrgAdmin && inbox.organization_id && orgIds instanceof Set && orgIds.has(inbox.organization_id)) {
        return true;
    }
    // Direct-fetch path: must be in the inbox's org.
    if (orgIds instanceof Set && (!inbox.organization_id || !orgIds.has(inbox.organization_id))) {
        return false;
    }
    // Group restriction. JSONB comes back as an array; tolerate a JSON string.
    let groups = inbox.shared_groups;
    if (!Array.isArray(groups)) {
        try { groups = JSON.parse(groups || '[]'); } catch { groups = []; }
    }
    if (!Array.isArray(groups) || groups.length === 0) return true; // open
    return groups.some(g => userGroups.includes(g));
}

/**
 * All inboxes (full public rows) the caller may work, across their in-scope
 * orgs. The list/threads/insights/stream routes build their inbox set from this
 * so a group-restricted inbox is never surfaced to a non-member.
 */
async function accessibleInboxes(req) {
    const userId = getUserId(req);
    if (!userId) return [];
    const { orgIds, scope } = await resolveOrgScope(req);
    if (!scope.length) return [];
    const [userGroups, isOrgAdmin] = await Promise.all([resolveUserGroups(req), resolveIsOrgAdmin(req)]);
    const out = [];
    for (const orgId of scope) {
        const inboxes = await supportInboxStore.listInboxes(orgId);
        for (const inbox of inboxes) {
            if (canUserAccessInbox(inbox, userId, orgIds, userGroups, { isOrgAdmin })) out.push(inbox);
        }
    }
    return out;
}

/** Convenience: just the ids. */
async function accessibleInboxIds(req) {
    return (await accessibleInboxes(req)).map(i => i.id);
}

/** Resolve a specific user's group ids (for operator-in-group validation). */
async function userGroupsFor(userId) {
    if (!userId) return [];
    try {
        const user = await userStore.getUser(userId);
        if (!user) return [];
        if (Array.isArray(user.groups)) return user.groups;
        if (typeof user.groups === 'string') { try { return JSON.parse(user.groups || '[]'); } catch { return []; } }
    } catch (_) { /* ignore */ }
    return [];
}

module.exports = {
    canUserAccessInbox,
    accessibleInboxes,
    accessibleInboxIds,
    resolveUserGroups,
    resolveIsOrgAdmin,
    resolveOrgScope,
    userGroupsFor,
};
