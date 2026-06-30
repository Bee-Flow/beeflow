// Org-wide Learning Center aggregation for the admin Academy panel.
//
// Members are the org's users (direct organizationId plus group-based
// membership — same filter the admin /users route applies); their progress and
// certificate blobs are read in TWO batched SQL round-trips via
// configStore.getConfigsByKeys regardless of org size, then reduced with the
// pure completion math. Serials and verify-token hashes never leave this
// module — the panel only sees certificate ids, levels and issue dates.

const configStore = require('../stores/configStore');
const userStore = require('../stores/userStore');
const { getUserPermissions } = require('../auth/permissions');
const { resolveCapabilitySet } = require('../core/entitlements');
const { COURSES, buildVisibleByCourse } = require('./courseCatalog');
const { completedCourses, computeEarnedBadges, lessonDone } = require('./completion');

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // orgId → { value, ts }

// The org's human members: direct organizationId match or membership of one of
// the org's groups. Excludes the system admin row and pending invites.
async function orgMembers(orgId) {
    const [users, allGroups] = await Promise.all([
        userStore.getAllUsers(),
        userStore.getAllGroups(),
    ]);
    const orgGroupIds = new Set(
        (allGroups || []).filter((g) => g.organizationId === orgId).map((g) => g.id),
    );
    return (users || []).filter((u) => {
        if (!u || u.isSystem || u.id === 'admin') return false;
        if (u.status === 'pending') return false;
        if (u.organizationId === orgId) return true;
        let groups = [];
        try { groups = Array.isArray(u.groups) ? u.groups : JSON.parse(u.groups || '[]'); } catch (_) { /* ignore */ }
        return groups.some((gid) => orgGroupIds.has(gid));
    });
}

function lastActivity(progress) {
    let latest = null;
    for (const entry of Object.values(progress || {})) {
        const at = entry?.completedAt;
        if (at && (!latest || at > latest)) latest = at;
    }
    return latest;
}

async function buildOrgOverview(orgId) {
    const members = await orgMembers(orgId);
    const ids = members.map((u) => u.id);

    // Two batched reads: all progress blobs, all certificate blobs.
    const [progressByKey, certsByKey] = await Promise.all([
        configStore.getConfigsByKeys(ids.map((id) => `learning_progress_user_${id}`)),
        configStore.getConfigsByKeys(ids.map((id) => `learning_certificate_user_${id}`)),
    ]);

    // Same visible-lesson semantics as the member-facing achievements endpoint:
    // the plan/feature set is org-level (resolved once); permissions are
    // per-member but Redis-cached, so this is cheap. Falls back to strict
    // all-lessons math per member when a lookup fails.
    let hasFeature = null;
    try {
        const capSet = await resolveCapabilitySet({ orgId });
        if (capSet && !capSet.degraded) hasFeature = (id) => capSet.has(id);
    } catch (_) { /* strict fallback */ }
    const visibleByUser = {};
    await Promise.all(members.map(async (u) => {
        try {
            const perms = await getUserPermissions(u.id);
            if (Array.isArray(perms) && hasFeature) {
                visibleByUser[u.id] = buildVisibleByCourse(perms, hasFeature);
            }
        } catch (_) { /* strict fallback for this member */ }
    }));

    const totals = { members: members.length, coursesCompleted: 0, badges: 0, certificatesIssued: 0, activeLast30d: 0 };
    const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const rows = members.map((u) => {
        const progressRaw = progressByKey[`learning_progress_user_${u.id}`];
        const progress = (progressRaw && typeof progressRaw === 'object') ? progressRaw : {};
        const certsRaw = certsByKey[`learning_certificate_user_${u.id}`];
        const certBlob = (certsRaw && typeof certsRaw === 'object') ? certsRaw : {};

        const visible = visibleByUser[u.id];
        const coursesDone = completedCourses(progress, visible).map((c) => c.id);
        const badges = computeEarnedBadges(progress, visible).map((b) => b.badgeId);
        const lessonsDone = Object.keys(progress).filter((id) => lessonDone(progress, id)).length;
        const certificates = Object.values(certBlob)
            .filter((r) => r && r.certificateId)
            .map((r) => ({ certificateId: r.certificateId, level: r.level || null, issuedAt: r.issuedAt || null }));
        const last = lastActivity(progress);

        totals.coursesCompleted += coursesDone.length;
        totals.badges += badges.length;
        totals.certificatesIssued += certificates.length;
        if (last && last >= cutoff30d) totals.activeLast30d += 1;

        return {
            userId: u.id,
            displayName: u.displayName || u.username || u.id,
            email: u.email || null,
            avatar: u.avatar || null,
            avatarType: u.avatarType || null,
            lessonsDone,
            coursesDone,
            badges,
            certificates,
            lastActivity: last,
        };
    });

    return {
        orgId,
        generatedAt: new Date().toISOString(),
        courses: COURSES.map((c) => ({ id: c.id, title: c.title, lessonCount: (c.lessonIds || []).length })),
        totals,
        members: rows,
    };
}

// 60s TTL cache — the panel polls/re-mounts freely and the underlying data
// changes at human learning speed. No invalidation needed at this staleness.
async function getOrgOverview(orgId) {
    const hit = cache.get(orgId);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.value;
    const value = await buildOrgOverview(orgId);
    cache.set(orgId, { value, ts: Date.now() });
    return value;
}

module.exports = { getOrgOverview, buildOrgOverview };
