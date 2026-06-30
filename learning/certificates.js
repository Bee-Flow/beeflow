// Certificate issuance + lookup — the authority that the auth endpoints and the
// public /verify route both call. Eligibility is ALWAYS recomputed from the
// server-side progress blob; client claims are never trusted.

const configStore = require('../stores/configStore');
const certStore = require('../stores/certificateStore');
const { getCertificate: getCatalogCert } = require('./courseCatalog');
const { certificateEligible, certificateCourses } = require('./completion');
const { makeSerial, makeVerifyToken, tokenHash } = require('../auth/certificateToken');

const CATALOG_VERSION = '2026.1';

// Read the user's server-side completion map. The legacy intro-tour flag
// (predates per-lesson tracking) is migrated ONCE into a real getting-started
// completion entry, then never consulted again — so "Reset progress" actually
// resets, and the flag keeps serving only as the first-login auto-start guard.
// The migration stamps now() (not epoch): earliest-wins merging would pin an
// epoch date into badge earnedAt forever.
async function readServerProgress(userId) {
    const progress = (await configStore.getConfig(`learning_progress_user_${userId}`)) || {};
    const map = (progress && typeof progress === 'object') ? { ...progress } : {};
    if (!map['getting-started']) {
        const migrated = !!(await configStore.getConfig(`learning_intro_migrated_user_${userId}`));
        if (!migrated) {
            const introSeen = !!(await configStore.getConfig(`has_seen_intro_tour_user_${userId}`));
            if (introSeen) {
                map['getting-started'] = { completedAt: new Date().toISOString() };
                await configStore.setConfig(`learning_progress_user_${userId}`, map);
            }
            await configStore.setConfig(`learning_intro_migrated_user_${userId}`, true);
        }
    }
    return map;
}

// Public base URL for verify links / og:image. Null on deployments without a known
// public domain — the caller then hides the public/LinkedIn affordances.
function getPublicBaseUrl() {
    const base = process.env.PUBLIC_BASE_URL || process.env.SERVER_PUBLIC_URL || null;
    return base ? base.replace(/\/+$/, '') : null;
}

function isEligible(certId, progress, visibleByCourse) {
    return certificateEligible(certId, progress, visibleByCourse);
}

// Issue (or re-issue, idempotently) a certificate. Recomputes eligibility first,
// against the lessons the user can actually access when the caller resolved them
// (visibleByCourse undefined → strict all-lessons semantics).
// Returns { record, verifyToken } or { error } when not eligible.
async function issueCertificate(userId, certId, { recipientName, orgName, makePublic = false, visibleByCourse } = {}) {
    const cert = getCatalogCert(certId);
    if (!cert) return { error: 'unknown_certificate' };

    const progress = await readServerProgress(userId);
    if (!isEligible(certId, progress, visibleByCourse)) return { error: 'not_eligible' };

    const existing = await certStore.getCertificate(userId, certId);
    const issuedAt = existing?.issuedAt || new Date().toISOString();
    const issuedDayUTC = existing?.issuedDayUTC || issuedAt.slice(0, 10);
    const serial = makeSerial(certId, userId, issuedDayUTC);
    const verifyToken = makeVerifyToken(certId, userId);
    const hash = tokenHash(verifyToken);

    const courses = certificateCourses(certId, progress, visibleByCourse).map((c) => ({
        courseId: c.id,
        title: c.title,
        completedAt: progress[c.lessonIds?.[c.lessonIds.length - 1]]?.completedAt || null,
    }));

    const record = {
        certificateId: certId,
        title: cert.title,
        level: cert.level || null,
        userId,
        recipientName: recipientName || 'Bee Flow learner',
        orgName: orgName || null,
        courses,
        serial,
        verifyTokenHash: hash,
        issuedAt,
        issuedDayUTC,
        isPublic: !!makePublic,
        version: CATALOG_VERSION,
    };

    await certStore.saveCertificate(userId, certId, record);

    // The public reverse index exists ONLY for public certs.
    if (makePublic) await certStore.setLookup(hash, userId, certId);
    else await certStore.clearLookup(hash);

    return { record, verifyToken };
}

// Build the owner-facing + (when public) shareable URL set for a record.
function buildUrls(record, verifyToken) {
    const base = getPublicBaseUrl();
    const out = {
        // Authenticated owner preview/download (always available).
        imageUrl: `/ai/learning/certificate/${record.certificateId}/image.png`,
        pdfUrl: `/ai/learning/certificate/${record.certificateId}/certificate.pdf`,
        verifyUrl: null,
        linkedInUrl: null,
        serial: record.serial,
    };
    if (record.isPublic && base && verifyToken) {
        const verifyUrl = `${base}/verify/${verifyToken}`;
        out.verifyUrl = verifyUrl;
        const issued = new Date(record.issuedAt);
        const params = new URLSearchParams({
            startTask: 'CERTIFICATION_NAME',
            name: record.title,
            organizationName: 'Bee Flow',
            issueYear: String(issued.getUTCFullYear()),
            issueMonth: String(issued.getUTCMonth() + 1),
            certUrl: verifyUrl,
            certId: record.serial,
        });
        out.linkedInUrl = `https://www.linkedin.com/profile/add?${params.toString()}`;
    }
    return out;
}

module.exports = {
    CATALOG_VERSION,
    readServerProgress,
    getPublicBaseUrl,
    isEligible,
    issueCertificate,
    buildUrls,
};
