// Org-authored Academy content over configStore (pattern: cmsStore — no new
// DB table, draft vs published snapshots).
//
//   learning_content_index_org_${orgId}            → [{ courseId, title, status, updatedAt }]
//   learning_course_org_${orgId}_${courseId}       → CourseDoc   (draft, admin-edited)
//   learning_lesson_org_${orgId}_${lessonId}       → LessonDoc   (draft)
//   learning_course_pub_org_${orgId}_${courseId}   → CourseDoc   (published snapshot)
//   learning_lesson_pub_org_${orgId}_${lessonId}   → LessonDoc   (published snapshot)
//
// Publishing copies the draft docs to the _pub_ keys, so an admin editing a
// draft never disturbs a member mid-lesson. Members only ever see published
// snapshots, and ONLY through publicLessonView(), which strips quiz answer
// keys and exercise rubrics — those never leave the server.
//
// Org docs use minted ids ('orgc-…' courses, 'orgl-…' lessons) so they can
// never collide with built-in lesson ids inside the shared per-user progress
// blob. Steps are restricted to slide/quiz/exercise — tour steps need
// code-bound DOM anchors and are not available to org authors.

const crypto = require('crypto');
const configStore = require('./configStore');

const indexKey = (orgId) => `learning_content_index_org_${orgId}`;
const courseKey = (orgId, courseId, published) => `learning_course_${published ? 'pub_' : ''}org_${orgId}_${courseId}`;
const lessonKey = (orgId, lessonId, published) => `learning_lesson_${published ? 'pub_' : ''}org_${orgId}_${lessonId}`;

const ORG_COURSE_PREFIX = 'orgc-';
const ORG_LESSON_PREFIX = 'orgl-';

const LIMITS = {
    maxCoursesPerOrg: 50,
    maxLessonsPerCourse: 20,
    maxStepsPerLesson: 30,
    maxTitleChars: 120,
    maxDescChars: 400,
    maxBodyChars: 8000,
    maxChoices: 6,
    maxChoiceChars: 200,
    maxCriteria: 6,
    maxCriterionChars: 300,
};

function mintCourseId() { return ORG_COURSE_PREFIX + crypto.randomBytes(6).toString('hex'); }
function mintLessonId() { return ORG_LESSON_PREFIX + crypto.randomBytes(6).toString('hex'); }
function isOrgCourseId(id) { return typeof id === 'string' && id.startsWith(ORG_COURSE_PREFIX); }
function isOrgLessonId(id) { return typeof id === 'string' && id.startsWith(ORG_LESSON_PREFIX); }

/* ── Validation (used by the admin routes before any write) ──────────────── */

function trimTo(value, max) { return String(value ?? '').slice(0, max).trim(); }

// Returns { doc, error } — a normalized LessonDoc or a human-readable error.
function validateLessonDoc(input) {
    if (!input || typeof input !== 'object') return { error: 'Lesson must be an object' };
    const title = trimTo(input.title, LIMITS.maxTitleChars);
    if (!title) return { error: 'Lesson title is required' };
    const rawSteps = Array.isArray(input.steps) ? input.steps : [];
    if (!rawSteps.length) return { error: 'A lesson needs at least one step' };
    if (rawSteps.length > LIMITS.maxStepsPerLesson) return { error: `A lesson can have at most ${LIMITS.maxStepsPerLesson} steps` };

    const steps = [];
    for (let i = 0; i < rawSteps.length; i += 1) {
        const s = rawSteps[i] || {};
        const id = trimTo(s.id, 64) || `step-${i + 1}`;
        if (s.type === 'slide') {
            const body = trimTo(s.bodyMd, LIMITS.maxBodyChars);
            if (!body) return { error: `Slide step ${i + 1} needs body text` };
            steps.push({ type: 'slide', id, icon: trimTo(s.icon, 8) || '📘', titleFallback: trimTo(s.title, LIMITS.maxTitleChars), bodyMdFallback: body });
        } else if (s.type === 'quiz') {
            const choices = (Array.isArray(s.choices) ? s.choices : []).slice(0, LIMITS.maxChoices)
                .map((c, j) => ({
                    id: trimTo(c?.id, 32) || `c${j + 1}`,
                    labelFallback: trimTo(c?.label ?? c?.labelFallback, LIMITS.maxChoiceChars),
                    correct: !!c?.correct,
                }))
                .filter((c) => c.labelFallback);
            if (choices.length < 2) return { error: `Quiz step ${i + 1} needs at least 2 choices` };
            if (!choices.some((c) => c.correct)) return { error: `Quiz step ${i + 1} needs a correct choice` };
            steps.push({
                type: 'quiz', id, icon: trimTo(s.icon, 8) || '❓',
                titleFallback: trimTo(s.title, LIMITS.maxTitleChars) || 'Quick check',
                questionFallback: trimTo(s.question, LIMITS.maxDescChars),
                multi: !!s.multi,
                choices,
                explanationFallback: trimTo(s.explanation, LIMITS.maxDescChars),
            });
        } else if (s.type === 'exercise') {
            const task = trimTo(s.task, LIMITS.maxDescChars);
            const criteria = (Array.isArray(s.criteria) ? s.criteria : [])
                .map((c) => trimTo(c, LIMITS.maxCriterionChars)).filter(Boolean).slice(0, LIMITS.maxCriteria);
            if (!task) return { error: `Exercise step ${i + 1} needs a task` };
            if (!criteria.length) return { error: `Exercise step ${i + 1} needs at least one rubric criterion` };
            const passScore = Number.isFinite(+s.passScore) ? Math.max(1, Math.min(100, Math.round(+s.passScore))) : 70;
            steps.push({
                type: 'exercise', id, icon: trimTo(s.icon, 8) || '✍️',
                titleFallback: trimTo(s.title, LIMITS.maxTitleChars) || 'Hands-on practice',
                instructionFallback: trimTo(s.instruction, LIMITS.maxDescChars) || task,
                placeholderFallback: trimTo(s.placeholder, LIMITS.maxDescChars),
                maxAttempts: Number.isFinite(+s.maxAttempts) ? Math.max(1, Math.min(10, Math.round(+s.maxAttempts))) : 3,
                rubric: { task, criteria, passScore, guidance: trimTo(s.guidance, LIMITS.maxDescChars) },
            });
        } else {
            return { error: `Step ${i + 1} has unsupported type '${s.type}' (allowed: slide, quiz, exercise)` };
        }
    }
    return {
        doc: {
            id: isOrgLessonId(input.id) ? input.id : mintLessonId(),
            title,
            desc: trimTo(input.desc, LIMITS.maxDescChars),
            icon: trimTo(input.icon, 8) || '📘',
            estMinutes: Number.isFinite(+input.estMinutes) ? Math.max(1, Math.min(120, Math.round(+input.estMinutes))) : 5,
            steps,
            updatedAt: new Date().toISOString(),
        },
    };
}

function validateCourseDoc(input) {
    if (!input || typeof input !== 'object') return { error: 'Course must be an object' };
    const title = trimTo(input.title, LIMITS.maxTitleChars);
    if (!title) return { error: 'Course title is required' };
    const lessonIds = (Array.isArray(input.lessonIds) ? input.lessonIds : [])
        .filter(isOrgLessonId).slice(0, LIMITS.maxLessonsPerCourse);
    // Mint the id first — the badge id derives from it, so it must be final.
    const id = isOrgCourseId(input.id) ? input.id : mintCourseId();
    return {
        doc: {
            id,
            title,
            desc: trimTo(input.desc, LIMITS.maxDescChars),
            icon: trimTo(input.icon, 8) || '📘',
            level: ['beginner', 'intermediate', 'advanced'].includes(input.level) ? input.level : 'beginner',
            lessonIds,
            badge: {
                id: `badge-${id.replace(ORG_COURSE_PREFIX, 'org-')}`,
                title: trimTo(input.badgeTitle ?? input.badge?.title, LIMITS.maxTitleChars) || title,
                icon: trimTo(input.badgeIcon ?? input.badge?.icon, 8) || '🏵️',
            },
            updatedAt: new Date().toISOString(),
        },
    };
}

/* ── Member-facing sanitizer ─────────────────────────────────────────────── */

// Strip everything a learner must not see: quiz answer keys (the step is
// marked serverGraded so the player calls POST /quiz/grade instead) and the
// whole exercise rubric (the coach endpoint resolves it server-side by
// `${lessonId}:${stepId}`).
function publicLessonView(lessonDoc) {
    if (!lessonDoc) return null;
    return {
        ...lessonDoc,
        steps: (lessonDoc.steps || []).map((s) => {
            if (s.type === 'quiz') {
                return { ...s, serverGraded: true, choices: (s.choices || []).map(({ correct, ...rest }) => rest) };
            }
            if (s.type === 'exercise') {
                const { rubric, ...rest } = s;
                return { ...rest, exerciseId: `${lessonDoc.id}:${s.id}` };
            }
            return s;
        }),
    };
}

/* ── CRUD ────────────────────────────────────────────────────────────────── */

async function listCourses(orgId) {
    const index = await configStore.getConfig(indexKey(orgId));
    return Array.isArray(index) ? index : [];
}

async function getCourse(orgId, courseId, { published = false } = {}) {
    if (!isOrgCourseId(courseId)) return null;
    return (await configStore.getConfig(courseKey(orgId, courseId, published))) || null;
}

async function getLesson(orgId, lessonId, { published = false } = {}) {
    if (!isOrgLessonId(lessonId)) return null;
    return (await configStore.getConfig(lessonKey(orgId, lessonId, published))) || null;
}

async function _writeIndex(orgId, mutate) {
    const index = await listCourses(orgId);
    const next = mutate(index);
    await configStore.setConfig(indexKey(orgId), next);
    return next;
}

async function saveCourse(orgId, doc) {
    const index = await listCourses(orgId);
    const exists = index.some((e) => e.courseId === doc.id);
    if (!exists && index.length >= LIMITS.maxCoursesPerOrg) {
        return { error: `An organisation can have at most ${LIMITS.maxCoursesPerOrg} custom courses` };
    }
    await configStore.setConfig(courseKey(orgId, doc.id, false), doc);
    await _writeIndex(orgId, (idx) => {
        const entry = { courseId: doc.id, title: doc.title, status: idx.find((e) => e.courseId === doc.id)?.status || 'draft', updatedAt: doc.updatedAt };
        const rest = idx.filter((e) => e.courseId !== doc.id);
        return [...rest, entry];
    });
    return { doc };
}

async function saveLesson(orgId, doc) {
    await configStore.setConfig(lessonKey(orgId, doc.id, false), doc);
    return { doc };
}

async function deleteCourse(orgId, courseId) {
    const course = await getCourse(orgId, courseId);
    for (const lessonId of course?.lessonIds || []) {
        await configStore.deleteConfig(lessonKey(orgId, lessonId, false));
        await configStore.deleteConfig(lessonKey(orgId, lessonId, true));
    }
    await configStore.deleteConfig(courseKey(orgId, courseId, false));
    await configStore.deleteConfig(courseKey(orgId, courseId, true));
    await _writeIndex(orgId, (idx) => idx.filter((e) => e.courseId !== courseId));
    return true;
}

// Copy the draft course + all its lessons to the published snapshot keys.
async function publishCourse(orgId, courseId) {
    const course = await getCourse(orgId, courseId);
    if (!course) return { error: 'Course not found' };
    if (!course.lessonIds?.length) return { error: 'A course needs at least one lesson before publishing' };
    for (const lessonId of course.lessonIds) {
        const lesson = await getLesson(orgId, lessonId);
        if (!lesson) return { error: `Lesson ${lessonId} is missing` };
        await configStore.setConfig(lessonKey(orgId, lessonId, true), lesson);
    }
    await configStore.setConfig(courseKey(orgId, courseId, true), course);
    await _writeIndex(orgId, (idx) => idx.map((e) => (e.courseId === courseId ? { ...e, status: 'published', updatedAt: new Date().toISOString() } : e)));
    return { course };
}

async function unpublishCourse(orgId, courseId) {
    const course = await getCourse(orgId, courseId, { published: true });
    for (const lessonId of course?.lessonIds || []) {
        await configStore.deleteConfig(lessonKey(orgId, lessonId, true));
    }
    await configStore.deleteConfig(courseKey(orgId, courseId, true));
    await _writeIndex(orgId, (idx) => idx.map((e) => (e.courseId === courseId ? { ...e, status: 'draft', updatedAt: new Date().toISOString() } : e)));
    return true;
}

// All published courses with their published lessons — the catalog overlay's
// input. Returns [{ course, lessons: LessonDoc[] }].
async function getPublishedCourses(orgId) {
    const index = await listCourses(orgId);
    const out = [];
    for (const entry of index.filter((e) => e.status === 'published')) {
        const course = await getCourse(orgId, entry.courseId, { published: true });
        if (!course) continue;
        const lessons = [];
        for (const lessonId of course.lessonIds || []) {
            const lesson = await getLesson(orgId, lessonId, { published: true });
            if (lesson) lessons.push(lesson);
        }
        if (lessons.length) out.push({ course, lessons });
    }
    return out;
}

// Resolve an org exercise rubric by its public exerciseId `${lessonId}:${stepId}`
// — always from the PUBLISHED snapshot (drafts are never gradeable).
async function findRubric(orgId, exerciseId) {
    const [lessonId, stepId] = String(exerciseId || '').split(':');
    if (!isOrgLessonId(lessonId) || !stepId) return null;
    const lesson = await getLesson(orgId, lessonId, { published: true });
    const step = (lesson?.steps || []).find((s) => s.type === 'exercise' && s.id === stepId);
    return step?.rubric || null;
}

module.exports = {
    LIMITS,
    isOrgCourseId,
    isOrgLessonId,
    mintCourseId,
    mintLessonId,
    validateCourseDoc,
    validateLessonDoc,
    publicLessonView,
    listCourses,
    getCourse,
    getLesson,
    saveCourse,
    saveLesson,
    deleteCourse,
    publishCourse,
    unpublishCourse,
    getPublishedCourses,
    findRubric,
};
