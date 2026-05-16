/**
 * Mirror Nextcloud users + groups into Bee Flow.
 *
 * Two trigger paths share the same apply* helpers:
 *
 *   1. Webhook (real-time) — server/routes/webhooks/ncEvents.js. The Bee
 *      Flow ExApp connector subscribes to OCP\User and OCP\Group events
 *      via NC's AppAPI events_listener and forwards each fire here.
 *
 *   2. Periodic backstop — server/jobs/ncSyncBackstop.js. Catches gaps
 *      from missed webhooks (NC restart, event listener drift) by doing
 *      a full diff every 6 hours.
 *
 * Sync mode per org (organizations.nc_sync_mode):
 *   - 'mirror_all'        Every NC user gets a Bee Flow account on creation.
 *                         Default for newly bootstrapped orgs.
 *   - 'selective_groups'  Only users in nc_sync_groups[] are mirrored.
 *   - 'manual'            No auto-sync. Org-admin invites users one by one.
 *
 * Excluded groups (nc_sync_excluded_groups[]) opt members out of mirroring
 * regardless of mode. New-user default status (nc_new_user_default_status)
 * controls whether mirrored users land 'active' or 'pending' for admin
 * approval — set to 'pending' for high-trust enterprise orgs.
 */

const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');

function slugifyId(s) {
    return String(s || '').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 40) || 'user';
}

// Service-level call to the connector's NC reverse proxy. Used to fetch
// NC user / group metadata when mirroring. Mirrors the HMAC scheme in
// nextcloudClient.resolveConnectorAuth.
async function ncProxyFetch(org, ncPath, ncUid = '') {
    const callbackUrl = org?.connector_callback_url;
    if (!callbackUrl) throw new Error(`Org ${org?.id} has no connector_callback_url`);
    const tenantKey = await configStore.getSecret(`connector_tenant_key_${org.id}`);
    if (!tenantKey) throw new Error(`Org ${org.id} has no tenant key`);
    const crypto = require('crypto');
    const ts = Math.floor(Date.now() / 1000);
    const path = ncPath.startsWith('/') ? `/nc${ncPath}` : `/nc/${ncPath}`;
    const message = `${ts}\nGET\n${path}\n${ncUid}`;
    const sig = crypto.createHmac('sha256', tenantKey).update(message).digest('hex');
    const url = `${callbackUrl.replace(/\/+$/, '')}${path}`;
    const res = await fetch(url, {
        headers: {
            'X-Beeflow-Sig': `${ts}.${sig}`,
            'X-Beeflow-NC-Uid': ncUid,
            'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
        throw new Error(`NC proxy ${path} HTTP ${res.status}`);
    }
    return res.json();
}

async function fetchNcUser(org, ncUid) {
    const body = await ncProxyFetch(org, `/ocs/v2.php/cloud/users/${encodeURIComponent(ncUid)}?format=json`, ncUid);
    return body?.ocs?.data || null;
}

async function fetchNcUserGroups(org, ncUid) {
    const body = await ncProxyFetch(org, `/ocs/v2.php/cloud/users/${encodeURIComponent(ncUid)}/groups?format=json`, ncUid);
    return body?.ocs?.data?.groups || [];
}

function shouldMirrorUser(org, userGroups) {
    const mode = org.nc_sync_mode || 'mirror_all';
    if (mode === 'manual') return false;
    if (org.ncSyncExcludedGroups?.length) {
        if (userGroups.some(g => org.ncSyncExcludedGroups.includes(g))) return false;
    }
    if (mode === 'selective_groups') {
        if (!org.ncSyncGroups?.length) return false;
        return userGroups.some(g => org.ncSyncGroups.includes(g));
    }
    return true; // mirror_all
}

async function applyUserCreated(org, ncUid) {
    const existing = await userStore.getUserByNcUid(org.id, ncUid);
    if (existing) {
        const updates = {};
        if (existing.status === 'inactive') updates.status = 'active';
        // Refresh metadata from NC on every sync so admin-side changes (rename,
        // email, group membership) propagate without manual user-edit. Each
        // fetch is wrapped so a transient OCS failure doesn't drop the rest.
        try {
            const ncUser = await fetchNcUser(org, ncUid);
            if (ncUser) {
                if (ncUser.email && ncUser.email !== existing.email) updates.email = ncUser.email;
                const ncDisplay = ncUser.displayname || ncUser.displayName;
                if (ncDisplay && ncDisplay !== existing.displayName) updates.displayName = ncDisplay;
            }
        } catch { /* leave identity untouched on transient errors */ }
        try {
            const groups = await fetchNcUserGroups(org, ncUid);
            const expected = groups.filter(g => g !== 'admin').map(g => ncGroupToBfId(org.id, g));
            const current = Array.isArray(existing.groups) ? existing.groups.slice().sort() : [];
            const next = expected.slice().sort();
            if (current.join(',') !== next.join(',')) updates.groups = expected;
        } catch { /* leave groups untouched on transient errors */ }
        if (Object.keys(updates).length > 0) {
            await userStore.updateUser(existing.id, updates);
        }
        return { action: 'update', userId: existing.id, changed: Object.keys(updates) };
    }
    let ncUser, ncGroups;
    try {
        ncUser = await fetchNcUser(org, ncUid);
        ncGroups = await fetchNcUserGroups(org, ncUid);
    } catch (e) {
        console.warn(`[ncSync] Could not fetch NC user ${ncUid} for org ${org.id}: ${e.message}`);
        return { action: 'error', error: e.message };
    }
    if (!ncUser?.email) {
        console.warn(`[ncSync] Skipping NC user ${ncUid} — no email`);
        return { action: 'skip', reason: 'no_email' };
    }
    if (!shouldMirrorUser(org, ncGroups)) {
        return { action: 'skip', reason: 'sync_mode_excludes' };
    }
    const status = (org.nc_new_user_default_status === 'pending') ? 'pending' : 'active';
    const userId = `nc_${org.id}_${slugifyId(ncUid)}`;
    // Map NC group memberships to Bee Flow group ids — relies on mirrorGroups
    // having populated the groups table for this org. NC's `admin` group is
    // intentionally not mirrored, so it gets dropped here.
    const bfGroupIds = (ncGroups || [])
        .filter(g => g !== 'admin')
        .map(g => ncGroupToBfId(org.id, g));
    const r = await userStore.createUserWithSeatCheck({
        id: userId,
        username: ncUser.email,
        email: ncUser.email,
        displayName: ncUser.displayname || ncUid,
        role: 'user',
        orgRole: '',
        organizationId: org.id,
        ncUid,
        provider: 'nextcloud_connector',
        autoProvisioned: true,
        status,
        groups: bfGroupIds,
    }, { strict: false });
    if (!r.created) {
        if (r.reason === 'seat_cap') {
            console.warn(`[ncSync] seat.cap.skipped org=${org.id} nc_uid=${ncUid} current=${r.current} max=${r.max}`);
            return { action: 'skip', reason: 'seat_cap' };
        }
        console.warn(`[ncSync] createUser failed for ${ncUid}: ${r.reason}`);
        return { action: 'skip', reason: r.reason };
    }
    console.log(`[ncSync] Mirrored NC user ${ncUid} → ${userId} (status=${status}, groups=${bfGroupIds.length})`);
    return { action: 'create', userId, status, groups: bfGroupIds };
}

async function applyUserDeleted(org, ncUid) {
    const user = await userStore.getUserByNcUid(org.id, ncUid);
    if (!user) return { action: 'noop' };
    // Soft-delete: set status=inactive so audit + history is preserved.
    // Hard-delete only on org-admin explicit purge (separate endpoint).
    await userStore.updateUser(user.id, { status: 'inactive' });
    console.log(`[ncSync] Soft-deleted user ${user.id} after NC delete of ${ncUid}`);
    return { action: 'deactivate', userId: user.id };
}

async function applyGroupMemberChange(org, ncUid /* , groupId */) {
    // Re-evaluate membership: user may have entered/left a group that
    // changes their inclusion under selective_groups / excluded_groups.
    // Always also propagates the NC group set to the BF user.groups[] so
    // group-based access in Bee Flow tracks NC.
    const user = await userStore.getUserByNcUid(org.id, ncUid);
    let groups;
    try { groups = await fetchNcUserGroups(org, ncUid); } catch { return { action: 'noop' }; }
    const shouldExist = shouldMirrorUser(org, groups);
    if (shouldExist && !user) {
        return applyUserCreated(org, ncUid);
    }
    const expectedGroups = (groups || []).filter(g => g !== 'admin').map(g => ncGroupToBfId(org.id, g));
    if (!shouldExist && user && user.status === 'active') {
        await userStore.updateUser(user.id, { status: 'inactive', groups: expectedGroups });
        return { action: 'deactivate', userId: user.id };
    }
    if (shouldExist && user && user.status === 'inactive') {
        await userStore.updateUser(user.id, { status: 'active', groups: expectedGroups });
        return { action: 'reactivate', userId: user.id };
    }
    if (shouldExist && user) {
        const current = Array.isArray(user.groups) ? user.groups.slice().sort() : [];
        const next = expectedGroups.slice().sort();
        if (current.join(',') !== next.join(',')) {
            await userStore.updateUser(user.id, { groups: expectedGroups });
            return { action: 'groups_updated', userId: user.id, groups: expectedGroups };
        }
    }
    return { action: 'noop' };
}

function ncGroupToBfId(orgId, ncGroupName) {
    return `nc_${orgId}_${String(ncGroupName).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;
}

async function mirrorGroups(org) {
    const userStore = require('../stores/userStore');
    let ncGroupNames = [];
    try {
        ncGroupNames = await listNcGroups(org);
    } catch (e) {
        return { created: 0, errors: [{ error: e.message }] };
    }
    const existing = await userStore.getAllGroups();
    const existingByNcName = new Map();
    for (const g of existing) {
        if (g.organizationId === org.id && g.source === 'nextcloud') {
            existingByNcName.set(g.name, g);
        }
    }
    let created = 0;
    const errors = [];
    for (const name of ncGroupNames) {
        // Skip the NC `admin` group — it shouldn't gate Bee Flow capabilities.
        if (name === 'admin') continue;
        if (existingByNcName.has(name)) continue;
        try {
            await userStore.createGroup({
                id: ncGroupToBfId(org.id, name),
                name,
                organizationId: org.id,
                source: 'nextcloud',
                lastSyncedAt: new Date().toISOString(),
            });
            created++;
        } catch (e) { errors.push({ name, error: e.message }); }
    }
    return { created, total: ncGroupNames.length, errors };
}

// Periodic backstop: list all NC users + groups, diff against Bee Flow
// users.nc_uid, apply create/deactivate. Idempotent, safe to run on cron.
async function runFullSync(org) {
    if (!org?.id) return { error: 'no_org' };
    if ((org.nc_sync_mode || 'mirror_all') === 'manual') return { skipped: 'manual_mode' };
    const result = { created: 0, deactivated: 0, groupsCreated: 0, errors: [] };

    // 1. Mirror groups first so user-membership sync below can resolve names.
    const groupResult = await mirrorGroups(org);
    result.groupsCreated = groupResult.created;
    if (groupResult.errors?.length) result.errors.push(...groupResult.errors);

    let ncUsers = [];
    try {
        // AppAPI's own users-list endpoint accepts service-level shared-secret
        // auth (empty userId), unlike the standard /cloud/users which needs an
        // admin uid. Returns a flat array of NC uids.
        const body = await ncProxyFetch(org, '/ocs/v2.php/apps/app_api/api/v1/users?format=json');
        ncUsers = Array.isArray(body?.ocs?.data) ? body.ocs.data : [];
    } catch (e) { return { error: e.message }; }

    for (const ncUid of ncUsers) {
        try {
            const r = await applyUserCreated(org, ncUid);
            if (r.action === 'create') result.created++;
        } catch (e) { result.errors.push({ ncUid, error: e.message }); }
    }

    // Deactivate Bee Flow users whose NC counterpart no longer exists.
    const ncSet = new Set(ncUsers);
    const bfUsers = await userStore.getAllUsers();
    for (const u of bfUsers) {
        if (u.organizationId !== org.id) continue;
        if (!u.nc_uid || u.provider !== 'nextcloud_connector') continue;
        if (u.status === 'inactive') continue;
        if (!ncSet.has(u.nc_uid)) {
            try { await userStore.updateUser(u.id, { status: 'inactive' }); result.deactivated++; }
            catch (e) { result.errors.push({ userId: u.id, error: e.message }); }
        }
    }

    await userStore.updateOrganization(org.id, { ncLastSyncAt: new Date().toISOString() });
    console.log(`[ncSync] Full sync for org ${org.id}: created=${result.created} deactivated=${result.deactivated} errors=${result.errors.length}`);
    return result;
}

async function listNcGroups(org) {
    // /cloud/groups requires NC admin context; impersonate the org's stored
    // nc_admin_uid (captured during bootstrap) so the call resolves.
    const adminUid = org?.nc_admin_uid || '';
    const body = await ncProxyFetch(org, '/ocs/v2.php/cloud/groups?format=json', adminUid);
    return body?.ocs?.data?.groups || [];
}

module.exports = {
    applyUserCreated,
    applyUserDeleted,
    applyGroupMemberChange,
    runFullSync,
    listNcGroups,
    ncProxyFetch,
};
