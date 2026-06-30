/**
 * Unit tests — Learning Center completion / badge / certificate math.
 *
 * completion.js is pure (no stores, no network), so these tests pin its
 * behaviour directly: course completion with and without `visibleByCourse`,
 * badge derivation, earnedAt stamping, and both certificate rule shapes
 * (track-complete and count-N).
 *
 * Run: node --test server/learning/completion.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    lessonDone,
    courseComplete,
    courseEarnedAt,
    completedCourses,
    computeEarnedBadges,
    certificateEligible,
    certificateProgress,
    certificateCourses,
} = require('./completion');
const { COURSES, getCourse } = require('./courseCatalog');

// Progress helpers — the stored shape is { [lessonId]: { completedAt } }.
const done = (at = '2026-06-01T10:00:00.000Z') => ({ completedAt: at });

function progressFor(lessonIds, at) {
    const map = {};
    lessonIds.forEach((id, i) => { map[id] = done(at || `2026-06-0${(i % 8) + 1}T10:00:00.000Z`); });
    return map;
}

const allLessonIds = COURSES.flatMap((c) => c.lessonIds);

test('lessonDone accepts { completedAt } and legacy true; rejects resume-only entries', () => {
    assert.equal(lessonDone({ a: done() }, 'a'), true);
    assert.equal(lessonDone({ a: true }, 'a'), true);
    assert.equal(lessonDone({ a: { steps: { s1: { status: 'passed' } } } }, 'a'), false);
    assert.equal(lessonDone({}, 'a'), false);
    assert.equal(lessonDone(null, 'a'), false);
});

test('courseComplete requires every lessonId when visibleByCourse is omitted', () => {
    const course = getCourse('course-skills-automation'); // creating-skills + automations
    assert.equal(courseComplete(course, progressFor(['automations'])), false);
    assert.equal(courseComplete(course, progressFor(['creating-skills', 'automations'])), true);
});

test('courseComplete honours visibleByCourse subset (permission-gated lessons excluded)', () => {
    const course = getCourse('course-skills-automation');
    const visible = { 'course-skills-automation': ['automations'] };
    assert.equal(courseComplete(course, progressFor(['automations']), visible), true);
    // An empty visible set can never complete.
    assert.equal(courseComplete(course, progressFor(allLessonIds), { 'course-skills-automation': [] }), false);
});

test('courseComplete is false for unknown course or course with no lessons', () => {
    assert.equal(courseComplete(null, progressFor(allLessonIds)), false);
    assert.equal(courseComplete({ id: 'x', lessonIds: [] }, progressFor(allLessonIds)), false);
});

test('courseEarnedAt is the latest completedAt among required lessons', () => {
    const course = getCourse('course-foundations'); // getting-started + using-memory
    const progress = {
        'getting-started': done('2026-01-01T00:00:00.000Z'),
        'using-memory': done('2026-03-01T00:00:00.000Z'),
    };
    assert.equal(courseEarnedAt(course, progress), '2026-03-01T00:00:00.000Z');
});

test('computeEarnedBadges returns one badge per completed course with earnedAt', () => {
    const progress = progressFor(['getting-started', 'using-memory']);
    const badges = computeEarnedBadges(progress);
    assert.equal(badges.length, 1);
    assert.equal(badges[0].badgeId, 'badge-foundations');
    assert.equal(badges[0].courseId, 'course-foundations');
    assert.ok(badges[0].earnedAt);
});

test('track certificate needs every course in the track', () => {
    // foundations track = course-foundations + course-prompting
    const partial = progressFor(['getting-started', 'using-memory']);
    assert.equal(certificateEligible('cert-foundations', partial), false);
    const full = progressFor([
        'getting-started', 'using-memory',
        'prompt-basics', 'prompt-context', 'prompt-structure', 'prompt-iterating', 'prompt-advanced',
    ]);
    assert.equal(certificateEligible('cert-foundations', full), true);
});

test('count certificate needs any N completed courses', () => {
    const threeCourses = progressFor([
        'getting-started', 'using-memory',
        'prompt-basics', 'prompt-context', 'prompt-structure', 'prompt-iterating', 'prompt-advanced',
        'connecting-integrations', 'org-usage',
    ]);
    assert.equal(completedCourses(threeCourses).length, 3);
    assert.equal(certificateEligible('cert-practitioner', threeCourses), false); // needs 4
    const fourCourses = { ...threeCourses, ...progressFor(['creating-skills', 'automations']) };
    assert.equal(certificateEligible('cert-practitioner', fourCourses), true);
});

test('certificate eligibility respects visibleByCourse', () => {
    // User who can only see 'automations' in skills course and 'connecting-integrations' in power course.
    const visible = {
        'course-skills-automation': ['automations'],
        'course-power': ['connecting-integrations'],
    };
    const progress = progressFor([
        'getting-started', 'using-memory',
        'prompt-basics', 'prompt-context', 'prompt-structure', 'prompt-iterating', 'prompt-advanced',
        'automations', 'connecting-integrations',
    ]);
    assert.equal(certificateEligible('cert-practitioner', progress), false); // strict: 3 of 4
    assert.equal(certificateEligible('cert-practitioner', progress, visible), true); // visible-aware: 4 of 4
});

test('certificateProgress reports { done, total } for both rule shapes', () => {
    const progress = progressFor(['getting-started', 'using-memory']);
    assert.deepEqual(certificateProgress('cert-foundations', progress), { done: 1, total: 2 });
    assert.deepEqual(certificateProgress('cert-practitioner', progress), { done: 1, total: 4 });
    assert.deepEqual(certificateProgress('nope', progress), { done: 0, total: 0 });
});

test('certificateCourses snapshots the satisfying courses', () => {
    const progress = progressFor([
        'getting-started', 'using-memory',
        'prompt-basics', 'prompt-context', 'prompt-structure', 'prompt-iterating', 'prompt-advanced',
    ]);
    const courses = certificateCourses('cert-foundations', progress);
    assert.deepEqual(courses.map((c) => c.id).sort(), ['course-foundations', 'course-prompting']);
});
