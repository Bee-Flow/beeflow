// THE structural authority for the Learning Center course catalog.
//
// The server is the source of truth for STRUCTURE (course ids, lessonIds,
// tracks, prereqs, badges, certificate rules, lesson gates): it recomputes
// completion, badges and certificate eligibility from it, and serves it to the
// client via GET /ai/learning/catalog. The client copy in
// agent-hub/src/components/onboarding/courses.js carries presentation (i18n
// keys, icons, levels) and doubles as the offline fallback — a vitest lockstep
// test (catalogLockstep.test.js) fails the build if the two drift.

const TRACKS = ['foundations', 'builder', 'power'];

const COURSES = [
    {
        id: 'course-foundations', track: 'foundations',
        title: 'Bee Flow Foundations',
        lessonIds: ['getting-started', 'using-memory'],
        prereqCourseIds: [],
        badge: { id: 'badge-foundations', title: 'Hive Newcomer' },
    },
    {
        id: 'course-prompting', track: 'foundations',
        title: 'Prompt Engineering',
        lessonIds: ['prompt-basics', 'prompt-context', 'prompt-structure', 'prompt-iterating', 'prompt-advanced'],
        prereqCourseIds: [],
        badge: { id: 'badge-prompt-smith', title: 'Prompt Smith' },
    },
    {
        id: 'course-build-agent', track: 'builder',
        title: 'Build Your First Agent',
        lessonIds: ['creating-agents', 'refining-prompt', 'knowledge-bases'],
        prereqCourseIds: ['course-foundations'],
        badge: { id: 'badge-agent-architect', title: 'Agent Architect' },
    },
    {
        id: 'course-skills-automation', track: 'builder',
        title: 'Skills & Automation',
        lessonIds: ['creating-skills', 'automations'],
        prereqCourseIds: ['course-build-agent'],
        badge: { id: 'badge-automator', title: 'Automator' },
    },
    {
        id: 'course-power', track: 'power',
        title: 'Power Connections',
        lessonIds: ['connecting-integrations', 'org-usage'],
        prereqCourseIds: [],
        badge: { id: 'badge-connector', title: 'Connector' },
    },
    {
        id: 'course-automations-mastery', track: 'power',
        title: 'Automate Your Week',
        lessonIds: ['automation-anatomy', 'automation-practice'],
        prereqCourseIds: [],
        badge: { id: 'badge-routine-master', title: 'Routine Master' },
    },
    {
        id: 'course-admin-essentials', track: 'power',
        title: 'Admin Essentials',
        lessonIds: ['admin-access-control', 'admin-governance'],
        prereqCourseIds: [],
        badge: { id: 'badge-hive-steward', title: 'Hive Steward' },
    },
];

// Certificates: a track cert needs every course in the track; a count cert needs
// any N completed courses.
const CERTIFICATES = [
    { id: 'cert-foundations', track: 'foundations', title: 'Bee Flow AI Certified — Foundations', level: 'Foundations' },
    { id: 'cert-builder', track: 'builder', title: 'Bee Flow AI Certified — Agent Builder', level: 'Agent Builder' },
    { id: 'cert-practitioner', rule: { type: 'count', n: 4 }, title: 'Bee Flow AI Practitioner', level: 'Practitioner' },
];

// Lesson access gates — mirror of the `gate` field in lessons.js. A permission
// array is ANY-of (same as the client's checkPermission); permission AND feature
// on one gate must BOTH pass. Lessons absent from this map are open to everyone.
const LESSON_GATES = {
    'creating-agents': { permission: 'manage_agents' },
    'refining-prompt': { permission: 'manage_agents' },
    'creating-skills': { permission: 'manage_skills', feature: 'skills' },
    'knowledge-bases': { permission: ['manage_knowledge', 'manage_agents'] },
    'connecting-integrations': { feature: 'integrations' },
    'automations': { feature: 'automations' },
    'org-usage': { permission: 'manage_users' },
    'automation-anatomy': { feature: 'automations' },
    'automation-practice': { feature: 'automations' },
    'admin-access-control': { permission: 'manage_users' },
    'admin-governance': { permission: 'manage_users' },
};

// Every lesson id the client may legitimately persist progress for. Includes
// 'effective-prompts', which belongs to no course but is a real lesson.
const LESSON_IDS = [
    'getting-started', 'effective-prompts',
    'prompt-basics', 'prompt-context', 'prompt-structure', 'prompt-iterating', 'prompt-advanced',
    'creating-agents', 'refining-prompt', 'creating-skills', 'knowledge-bases',
    'connecting-integrations', 'using-memory', 'automations', 'org-usage',
    'automation-anatomy', 'automation-practice', 'admin-access-control', 'admin-governance',
];

// Which lesson each AI-coach exercise (rubrics.js) lives in — server-owned so
// exercise passes can be attributed to lessons without trusting the client.
const EXERCISE_LESSONS = {
    'ex-basics-specific': 'prompt-basics',
    'ex-context-add': 'prompt-context',
    'ex-structure-format': 'prompt-structure',
    'ex-iterating-refine': 'prompt-iterating',
    'ex-system-prompt': 'refining-prompt',
    'ex-advanced-technique': 'prompt-advanced',
    'ex-automation-brief': 'automation-practice',
    'ex-admin-rollout': 'admin-governance',
};

// True when a gate passes for the given permission list + feature predicate.
// Mirrors the client's checkPermission semantics: 'all' wildcard wins; a string
// permission must be present; an array is ANY-of.
function gatePasses(gate, perms, hasFeature) {
    if (!gate) return true;
    if (gate.permission) {
        const allowed = Array.isArray(perms) && perms.includes('all');
        if (!allowed) {
            const required = Array.isArray(gate.permission) ? gate.permission : [gate.permission];
            if (!required.some((p) => Array.isArray(perms) && perms.includes(p))) return false;
        }
    }
    if (gate.feature && typeof hasFeature === 'function' && !hasFeature(gate.feature)) return false;
    return true;
}

// { [courseId]: string[] } of the lessons this user can actually access — the
// `visibleByCourse` shape completion.js consumes. Matches the client's
// courseLessons(course, user, hasFeature) filtering.
function buildVisibleByCourse(perms, hasFeature) {
    const visible = {};
    for (const course of COURSES) {
        visible[course.id] = (course.lessonIds || [])
            .filter((id) => gatePasses(LESSON_GATES[id], perms, hasFeature));
    }
    return visible;
}

function getCourse(courseId) { return COURSES.find((c) => c.id === courseId) || null; }
function getCertificate(certId) { return CERTIFICATES.find((c) => c.id === certId) || null; }

// The structural payload served by GET /ai/learning/catalog. Version bumps when
// structure changes meaningfully (kept in step with certificates.CATALOG_VERSION).
const CATALOG = {
    version: '2026.1',
    tracks: TRACKS,
    courses: COURSES,
    certificates: CERTIFICATES,
    lessonGates: LESSON_GATES,
    lessonIds: LESSON_IDS,
};

module.exports = {
    TRACKS, COURSES, CERTIFICATES, CATALOG,
    LESSON_GATES, LESSON_IDS, EXERCISE_LESSONS,
    gatePasses, buildVisibleByCourse,
    getCourse, getCertificate,
};
