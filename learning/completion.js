// Pure completion / badge / certificate-eligibility computation.
//
// The server is the authority for badges and certificates: it recomputes these
// from the user's progress blob (configStore key learning_progress_user_${userId},
// shape { [lessonId]: { completedAt } }) and never trusts client claims.
//
// `requiredLessonIds` lets a caller pass the subset of a course's lessons the user
// can actually access (permission/feature gated). When omitted, every lessonId in
// the course is required. A course with no required lessons is never "complete".

const { COURSES, CERTIFICATES, getCertificate } = require('./courseCatalog');

function lessonDone(progressMap, lessonId) {
    const entry = progressMap && progressMap[lessonId];
    return !!(entry && (entry.completedAt || entry === true));
}

// Course completion against the required (visible) lessons. `visibleByCourse` is
// an optional { [courseId]: string[] } of accessible lesson ids per course.
function courseComplete(course, progressMap, visibleByCourse) {
    if (!course) return false;
    const required = (visibleByCourse && visibleByCourse[course.id]) || course.lessonIds || [];
    if (!required.length) return false;
    return required.every((id) => lessonDone(progressMap, id));
}

// The completedAt of the last lesson finished in a course — a stable, reproducible
// "earnedAt" for the badge with no extra write needed.
function courseEarnedAt(course, progressMap, visibleByCourse) {
    const required = (visibleByCourse && visibleByCourse[course.id]) || course.lessonIds || [];
    let latest = null;
    for (const id of required) {
        const at = progressMap?.[id]?.completedAt;
        if (at && (!latest || at > latest)) latest = at;
    }
    return latest;
}

// `extraCourses` (org-authored, Phase 3) participate in course completion and
// badge math but NEVER in certificates — see the note on certificateEligible.
function completedCourses(progressMap, visibleByCourse, extraCourses = []) {
    return [...COURSES, ...extraCourses].filter((c) => courseComplete(c, progressMap, visibleByCourse));
}

function computeEarnedBadges(progressMap, visibleByCourse, version = '2026.1', extraCourses = []) {
    return completedCourses(progressMap, visibleByCourse, extraCourses)
        .filter((c) => c.badge && c.badge.id)
        .map((c) => ({
            badgeId: c.badge.id,
            courseId: c.id,
            title: c.badge.title,
            earnedAt: courseEarnedAt(c, progressMap, visibleByCourse),
            version,
        }));
}

// Certificates are deliberately computed WITHOUT extraCourses: org-authored
// content must never satisfy a count-rule cert (an org could otherwise mint
// "Bee Flow AI Practitioner" with trivial custom courses). Built-in only.
function certificateEligible(certId, progressMap, visibleByCourse) {
    const cert = getCertificate(certId);
    if (!cert) return false;
    const doneIds = completedCourses(progressMap, visibleByCourse).map((c) => c.id);
    if (cert.rule?.type === 'count') return doneIds.length >= cert.rule.n;
    if (cert.track) {
        const trackCourses = COURSES.filter((c) => c.track === cert.track);
        if (!trackCourses.length) return false;
        return trackCourses.every((c) => doneIds.includes(c.id));
    }
    return false;
}

// The courses that satisfy a certificate (for snapshotting onto an issued cert).
function certificateCourses(certId, progressMap, visibleByCourse) {
    const cert = getCertificate(certId);
    if (!cert) return [];
    const done = completedCourses(progressMap, visibleByCourse);
    if (cert.rule?.type === 'count') return done.slice(0, cert.rule.n);
    if (cert.track) return done.filter((c) => c.track === cert.track);
    return [];
}

// Progress toward a certificate: { done, total } completed courses.
function certificateProgress(certId, progressMap, visibleByCourse) {
    const cert = getCertificate(certId);
    if (!cert) return { done: 0, total: 0 };
    const doneIds = completedCourses(progressMap, visibleByCourse).map((c) => c.id);
    if (cert.rule?.type === 'count') return { done: Math.min(doneIds.length, cert.rule.n), total: cert.rule.n };
    if (cert.track) {
        const trackCourses = COURSES.filter((c) => c.track === cert.track);
        return { done: trackCourses.filter((c) => doneIds.includes(c.id)).length, total: trackCourses.length };
    }
    return { done: 0, total: 0 };
}

module.exports = {
    lessonDone,
    courseComplete,
    courseEarnedAt,
    completedCourses,
    computeEarnedBadges,
    certificateEligible,
    certificateProgress,
    certificateCourses,
    CERTIFICATES,
};
