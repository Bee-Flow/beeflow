/**
 * Support auto-assignment — round-robin assignment of escalated threads to
 * staff who hold the `admin_support` permission.
 *
 * Eligibility for a thread's org:
 *   • super-admins (role === 'admin' / 'all' permission) are always eligible;
 *   • org-scoped support staff are eligible only for their own org's threads.
 * Anonymous/marketing threads (no org) are assignable to super-admins only.
 *
 * The round-robin cursor lives in support_assignment_state and is advanced
 * atomically (SELECT … FOR UPDATE) so concurrent escalations don't collide.
 */

const userStore = require('../stores/userStore');
const supportStore = require('../stores/supportStore');
const { getUserPermissions } = require('../auth/permissions');

// Short cache of eligible-staff lists per org — escalations can burst.
const _cache = new Map(); // orgKey → { ids, ts }
const CACHE_TTL_MS = 60_000;

function _hasSupport(perms) {
    if (!perms) return false;
    if (Array.isArray(perms)) return perms.includes('admin_support') || perms.includes('all');
    if (perms instanceof Set) return perms.has('admin_support') || perms.has('all');
    return false;
}

async function _eligibleStaffForOrg(orgId) {
    const key = orgId || '__global__';
    const cached = _cache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.ids;

    const users = await userStore.getAllUsers();
    const ids = [];
    for (const u of users || []) {
        if (u.disabled || u.suspended) continue;
        const isSuper = u.role === 'admin';
        // Org-scoped staff only handle their own org's threads.
        const inOrg = orgId ? (u.organizationId === orgId) : false;
        if (!isSuper && !inOrg) continue;
        try {
            const perms = await getUserPermissions(u.id, isSuper ? { isAdmin: true } : null);
            if (_hasSupport(perms)) ids.push(u.id);
        } catch { /* skip on lookup failure */ }
    }
    // Stable order so the round-robin cursor is meaningful across calls.
    ids.sort();
    _cache.set(key, { ids, ts: Date.now() });
    return ids;
}

async function _userGroups(userId) {
    try {
        const u = await userStore.getUser(userId);
        if (!u) return [];
        if (Array.isArray(u.groups)) return u.groups;
        if (typeof u.groups === 'string') { try { return JSON.parse(u.groups || '[]'); } catch { return []; } }
    } catch { /* ignore */ }
    return [];
}

/**
 * Return the next staff user id to assign for an org, advancing the cursor.
 * Returns null when no eligible staff exist.
 *
 * When the inbox is group-restricted (`sharedGroups` non-empty), candidates are
 * narrowed to members of those groups so a ticket is never auto-assigned to
 * someone who would then be denied access to it. Falls back to all eligible
 * staff if no group member is support-capable (a stranded ticket is worse than a
 * slightly out-of-policy assignment).
 */
async function pickNextAssignee(orgId, { sharedGroups = [] } = {}) {
    let candidates = await _eligibleStaffForOrg(orgId || null);
    if (!candidates.length) return null;
    if (Array.isArray(sharedGroups) && sharedGroups.length) {
        const inGroup = [];
        for (const id of candidates) {
            const g = await _userGroups(id);
            if (g.some(x => sharedGroups.includes(x))) inGroup.push(id);
        }
        if (inGroup.length) candidates = inGroup;
    }
    return supportStore.getAndAdvanceRoundRobin(orgId || null, candidates);
}

module.exports = { pickNextAssignee, _eligibleStaffForOrg };
