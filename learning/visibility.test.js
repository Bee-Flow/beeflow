/**
 * Unit tests — server-side lesson visibility resolution.
 *
 * visibility.js is the impure edge of the completion pipeline: it asks the
 * permission system + entitlements resolver for the session user and hands a
 * pure { [courseId]: lessonIds[] } map to completion.js. We stub
 * ../auth/permissions and ../core/entitlements via Module._load (same
 * technique as core/betaFeatures.test.js) and pin the gate semantics
 * ('all' wildcard, ANY-of permission arrays, permission AND feature) plus the
 * fail-closed degraded paths (visibleByCourse: undefined → completion.js
 * requires ALL lessons; an outage can never mint certificates).
 *
 * Run: node --test server/learning/visibility.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

// ── Mock injection ──────────────────────────────────────────────────────
// visibility.js requires '../auth/permissions' and '../core/entitlements';
// resolve those relative to learning/ (this dir) and swap them BEFORE the
// module under test is required. courseCatalog runs for real.
const permissionsPath = path.resolve(__dirname, '..', 'auth', 'permissions');
const entitlementsPath = path.resolve(__dirname, '..', 'core', 'entitlements');

let mockPerms = [];
let mockPermsThrow = false;
let mockPermDegraded = false;
let mockCapDegraded = false;
let mockFeatures = new Set();

const permissionsStub = {
    async getUserPermissions(_userId, _session) {
        if (mockPermsThrow) throw new Error('simulated permission lookup failure');
        return mockPerms;
    },
    isPermissionLookupDegraded() { return mockPermDegraded; },
};
const entitlementsStub = {
    async resolveCapabilitySet(_ctx) {
        return { degraded: mockCapDegraded, has: (capId) => mockFeatures.has(capId) };
    },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    try {
        const resolved = Module._resolveFilename(request, parent, isMain);
        if (resolved === permissionsPath + '.js' || resolved === permissionsPath + '/index.js') return permissionsStub;
        if (resolved === entitlementsPath + '.js' || resolved === entitlementsPath + '/index.js') return entitlementsStub;
    } catch (_) { /* ignore resolution errors, fall through */ }
    return originalLoad(request, parent, isMain);
};

const { resolveVisibleByCourse } = require('./visibility');
const { COURSES } = require('./courseCatalog');

function resetMocks() {
    mockPerms = [];
    mockPermsThrow = false;
    mockPermDegraded = false;
    mockCapDegraded = false;
    mockFeatures = new Set();
}

const resolve = () => resolveVisibleByCourse({ userId: 'u1', orgId: 'org1' });

// ── Happy paths ─────────────────────────────────────────────────────────

test("perms ['all'] + every feature → every course fully visible", async () => {
    resetMocks();
    mockPerms = ['all'];
    mockFeatures = new Set(['skills', 'integrations', 'automations']);
    const { visibleByCourse, degraded } = await resolve();
    assert.equal(degraded, false);
    for (const course of COURSES) {
        assert.deepEqual(visibleByCourse[course.id], course.lessonIds,
            `${course.id} must list its full lesson set for an unrestricted user`);
    }
});

test('perms [] + no features → ungated courses visible, fully-gated course empty', async () => {
    resetMocks();
    const { visibleByCourse, degraded } = await resolve();
    assert.equal(degraded, false);
    // course-prompting and course-foundations carry no gates at all.
    assert.deepEqual(visibleByCourse['course-prompting'],
        ['prompt-basics', 'prompt-context', 'prompt-structure', 'prompt-iterating', 'prompt-advanced']);
    assert.deepEqual(visibleByCourse['course-foundations'], ['getting-started', 'using-memory']);
    // creating-skills needs manage_skills+skills feature; automations needs the feature.
    assert.deepEqual(visibleByCourse['course-skills-automation'], [],
        'every lesson in the skills course is gated away from a no-perm/no-feature user');
});

test("knowledge-bases is ANY-of ['manage_knowledge','manage_agents']", async () => {
    resetMocks();
    mockPerms = ['manage_knowledge'];
    let { visibleByCourse } = await resolve();
    assert.ok(visibleByCourse['course-build-agent'].includes('knowledge-bases'),
        'one of the listed permissions suffices');

    resetMocks();
    mockPerms = ['something_else'];
    ({ visibleByCourse } = await resolve());
    assert.ok(!visibleByCourse['course-build-agent'].includes('knowledge-bases'),
        'an unrelated permission does not pass the ANY-of gate');
});

test('creating-skills requires BOTH the manage_skills permission AND the skills feature', async () => {
    resetMocks();
    mockPerms = ['manage_skills']; // permission without the feature
    let { visibleByCourse } = await resolve();
    assert.ok(!visibleByCourse['course-skills-automation'].includes('creating-skills'),
        'permission alone is not enough');

    resetMocks();
    mockPerms = ['manage_skills'];
    mockFeatures = new Set(['skills']);
    ({ visibleByCourse } = await resolve());
    assert.ok(visibleByCourse['course-skills-automation'].includes('creating-skills'),
        'permission + feature together pass');
});

// ── Fail-closed degraded paths ──────────────────────────────────────────

test('capSet.degraded → { visibleByCourse: undefined, degraded: true }', async () => {
    resetMocks();
    mockPerms = ['all'];
    mockCapDegraded = true;
    assert.deepEqual(await resolve(), { visibleByCourse: undefined, degraded: true });
});

test('isPermissionLookupDegraded() → { visibleByCourse: undefined, degraded: true }', async () => {
    resetMocks();
    mockPerms = ['all'];
    mockFeatures = new Set(['skills', 'integrations', 'automations']);
    mockPermDegraded = true;
    assert.deepEqual(await resolve(), { visibleByCourse: undefined, degraded: true });
});

test('getUserPermissions throwing → { visibleByCourse: undefined, degraded: true }', async () => {
    resetMocks();
    mockPermsThrow = true;
    assert.deepEqual(await resolve(), { visibleByCourse: undefined, degraded: true });
});
