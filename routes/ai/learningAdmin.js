// Academy Custom Courses — org-admin authoring routes (draft CRUD + publish).
//
// Mounted at /ai/learning/admin behind requireCapability('learning_custom_content')
// — see server/routes/ai.js, where this MUST be mounted BEFORE the '/learning'
// router (router.use('/learning') also matches '/learning/admin/*' paths).
//
// Every handler is org-admin gated and scoped to the caller's OWN primary org:
// orgId always comes from req.primaryOrgId (set by requirePrimaryOrgAdmin),
// NEVER from the request body or query.
//
// Everything here operates on DRAFT docs. Members only ever see published
// snapshots (copied by POST /courses/:courseId/publish), and only through the
// sanitized member-facing routes in learning.js — quiz answer keys and
// exercise rubrics returned here never reach non-admins.

const express = require('express');
const router = express.Router();

const { requirePrimaryOrgAdmin } = require('../../auth/permissions');
const store = require('../../stores/learningContentStore');

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

router.use(requireAuth, requirePrimaryOrgAdmin());

// GET /courses → the org's course index: [{ courseId, title, status, updatedAt }]
router.get('/courses', async (req, res) => {
    try {
        const courses = await store.listCourses(req.primaryOrgId);
        res.json({ courses });
    } catch (e) {
        console.error('[learning/admin] list courses failed:', e.message);
        res.status(500).json({ error: 'Failed to list courses' });
    }
});

// GET /courses/:courseId → draft CourseDoc + the draft LessonDocs it references.
router.get('/courses/:courseId', async (req, res) => {
    try {
        const course = await store.getCourse(req.primaryOrgId, req.params.courseId);
        if (!course) return res.status(404).json({ error: 'Course not found' });
        const lessons = [];
        for (const lessonId of course.lessonIds || []) {
            const lesson = await store.getLesson(req.primaryOrgId, lessonId);
            if (lesson) lessons.push(lesson);
        }
        res.json({ course, lessons });
    } catch (e) {
        console.error('[learning/admin] get course failed:', e.message);
        res.status(500).json({ error: 'Failed to load course' });
    }
});

// POST /courses → create. The id is always minted by the validator (a client
// can never choose its own course id).
router.post('/courses', async (req, res) => {
    try {
        const { doc, error } = store.validateCourseDoc({ ...(req.body || {}), id: undefined });
        if (error) return res.status(400).json({ error });
        const saved = await store.saveCourse(req.primaryOrgId, doc);
        if (saved.error) return res.status(400).json({ error: saved.error });
        res.json({ course: saved.doc });
    } catch (e) {
        console.error('[learning/admin] create course failed:', e.message);
        res.status(500).json({ error: 'Failed to create course' });
    }
});

// PUT /courses/:courseId → upsert. The URL param is authoritative for the id:
// when it is a valid org course id it overrides whatever the body says, so a
// body id mismatch can never overwrite a different course. A non-org param
// (e.g. 'new') makes the validator mint a fresh id — an effective create.
router.put('/courses/:courseId', async (req, res) => {
    try {
        const id = store.isOrgCourseId(req.params.courseId) ? req.params.courseId : undefined;
        const { doc, error } = store.validateCourseDoc({ ...(req.body || {}), id });
        if (error) return res.status(400).json({ error });
        const saved = await store.saveCourse(req.primaryOrgId, doc);
        if (saved.error) return res.status(400).json({ error: saved.error });
        res.json({ course: saved.doc });
    } catch (e) {
        console.error('[learning/admin] save course failed:', e.message);
        res.status(500).json({ error: 'Failed to save course' });
    }
});

// DELETE /courses/:courseId → removes the course and ALL its lessons, both
// draft and published snapshots (see learningContentStore.deleteCourse).
router.delete('/courses/:courseId', async (req, res) => {
    try {
        await store.deleteCourse(req.primaryOrgId, req.params.courseId);
        res.json({ success: true });
    } catch (e) {
        console.error('[learning/admin] delete course failed:', e.message);
        res.status(500).json({ error: 'Failed to delete course' });
    }
});

// PUT /lessons/:lessonId → upsert a draft lesson. The URL param is preserved
// when it is a valid org lesson id; anything else (e.g. 'new') makes the
// validator mint a fresh 'orgl-…' id.
//
// IMPORTANT for callers: lessons are stored standalone — saving a NEW lesson
// does NOT attach it to any course. After this returns, the client MUST follow
// up with PUT /courses/:courseId whose body lessonIds includes the returned
// lesson.id (in the desired position), otherwise the lesson is orphaned and
// will never publish.
router.put('/lessons/:lessonId', async (req, res) => {
    try {
        const id = store.isOrgLessonId(req.params.lessonId) ? req.params.lessonId : undefined;
        const { doc, error } = store.validateLessonDoc({ ...(req.body || {}), id });
        if (error) return res.status(400).json({ error });
        const saved = await store.saveLesson(req.primaryOrgId, doc);
        res.json({ lesson: saved.doc });
    } catch (e) {
        console.error('[learning/admin] save lesson failed:', e.message);
        res.status(500).json({ error: 'Failed to save lesson' });
    }
});

// POST /courses/:courseId/publish → copy the draft course + all its lessons to
// the published snapshot keys members read from.
router.post('/courses/:courseId/publish', async (req, res) => {
    try {
        const result = await store.publishCourse(req.primaryOrgId, req.params.courseId);
        if (result.error) return res.status(400).json({ error: result.error });
        res.json({ success: true, course: result.course });
    } catch (e) {
        console.error('[learning/admin] publish failed:', e.message);
        res.status(500).json({ error: 'Failed to publish course' });
    }
});

// POST /courses/:courseId/unpublish → remove the published snapshots; the
// drafts are untouched.
router.post('/courses/:courseId/unpublish', async (req, res) => {
    try {
        await store.unpublishCourse(req.primaryOrgId, req.params.courseId);
        res.json({ success: true });
    } catch (e) {
        console.error('[learning/admin] unpublish failed:', e.message);
        res.status(500).json({ error: 'Failed to unpublish course' });
    }
});

module.exports = router;
