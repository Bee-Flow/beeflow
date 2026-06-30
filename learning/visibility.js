// Server-side resolution of WHICH lessons a user can actually access, so badge
// and certificate eligibility is computed against the same lesson set the client
// shows (the client filters gated lessons out of courses; the server must not
// demand lessons the user can't even see).
//
// This is the only impure piece of the completion pipeline: it asks the
// permission system and the entitlements resolver for the session user, then
// hands a pure { [courseId]: lessonIds[] } map to completion.js.
//
// Fail-closed: when either lookup is degraded (Redis/DB trouble), we return
// `visibleByCourse: undefined`, which makes completion.js fall back to
// requiring ALL lessons — an outage can make badges temporarily stricter, but
// can never mint certificates.

const { getUserPermissions, isPermissionLookupDegraded } = require('../auth/permissions');
const { resolveCapabilitySet } = require('../core/entitlements');
const { buildVisibleByCourse } = require('./courseCatalog');

async function resolveVisibleByCourse({ userId, orgId = null, session = null, req = null }) {
    let perms = null;
    let capSet = null;
    try {
        [perms, capSet] = await Promise.all([
            getUserPermissions(userId, session),
            resolveCapabilitySet({ userId, orgId, session, req }),
        ]);
    } catch (_) {
        return { visibleByCourse: undefined, degraded: true };
    }
    if (!Array.isArray(perms) || !capSet || capSet.degraded || isPermissionLookupDegraded()) {
        return { visibleByCourse: undefined, degraded: true };
    }
    const hasFeature = (featureId) => capSet.has(featureId);
    return { visibleByCourse: buildVisibleByCourse(perms, hasFeature), degraded: false };
}

module.exports = { resolveVisibleByCourse };
