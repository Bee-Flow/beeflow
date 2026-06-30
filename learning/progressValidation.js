// Validation + merge for the client-written learning progress blob.
//
// The blob (configStore key learning_progress_user_${userId}) feeds badge and
// certificate eligibility, so the write path must not accept arbitrary JSON:
// lesson ids are whitelisted against the server catalog, entries are shape-
// checked and size-capped, and writes MERGE into the stored map instead of
// replacing it (a stale device can no longer erase another device's progress).
//
// Both functions are pure so they can be unit-tested without stores.

const { LESSON_IDS } = require('./courseCatalog');

const LESSON_ID_SET = new Set(LESSON_IDS);

// Org-authored lessons (learningContentStore) carry minted 'orgl-<hex>' ids.
// They're accepted by shape — checking actual existence would need a store
// read in this pure module; the id space is bounded and all size caps apply.
const ORG_LESSON_ID_RE = /^orgl-[a-f0-9]{6,16}$/;

function knownLessonId(id) {
    return LESSON_ID_SET.has(id) || ORG_LESSON_ID_RE.test(id);
}

// Caps chosen far above honest use: a lesson has well under 40 steps, a step's
// resume state (quiz choices / exercise verdict) is a few hundred bytes, and the
// full catalog's progress serializes to a few KB.
const MAX_STEPS_PER_LESSON = 40;
const MAX_STEP_STATE_BYTES = 2048;
const MAX_STEP_ID_LENGTH = 64;
const MAX_BLOB_BYTES = 64 * 1024;
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

function validCompletedAt(value) {
    if (typeof value !== 'string') return false;
    const ts = Date.parse(value);
    if (Number.isNaN(ts)) return false;
    return ts <= Date.now() + MAX_FUTURE_SKEW_MS;
}

// Sanitize an incoming progress map. Unknown lesson ids, malformed entries and
// oversized step states are DROPPED (returned in `dropped` for logging); an
// oversized payload overall is rejected with { error: 'too_large' } so the
// route can 400 instead of silently truncating.
function sanitizeLearningProgress(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { map: {}, dropped: [], error: null };
    }
    let raw;
    try { raw = JSON.stringify(input); } catch (_) { return { map: {}, dropped: [], error: 'unserializable' }; }
    if (raw.length > MAX_BLOB_BYTES) return { map: null, dropped: [], error: 'too_large' };

    const map = {};
    const dropped = [];
    for (const [lessonId, entry] of Object.entries(input)) {
        if (!knownLessonId(lessonId)) { dropped.push(lessonId); continue; }

        // Legacy client shape: `true` means complete with no timestamp.
        if (entry === true) { map[lessonId] = { completedAt: new Date().toISOString() }; continue; }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { dropped.push(lessonId); continue; }

        const clean = {};
        if (entry.completedAt !== undefined) {
            if (!validCompletedAt(entry.completedAt)) { dropped.push(lessonId); continue; }
            clean.completedAt = entry.completedAt;
        }
        if (entry.steps && typeof entry.steps === 'object' && !Array.isArray(entry.steps)) {
            const steps = {};
            for (const [stepId, state] of Object.entries(entry.steps)) {
                if (typeof stepId !== 'string' || stepId.length > MAX_STEP_ID_LENGTH) continue;
                if (Object.keys(steps).length >= MAX_STEPS_PER_LESSON) break;
                try {
                    if (JSON.stringify(state).length > MAX_STEP_STATE_BYTES) continue;
                } catch (_) { continue; }
                steps[stepId] = state;
            }
            if (Object.keys(steps).length) clean.steps = steps;
        }
        if (clean.completedAt || clean.steps) map[lessonId] = clean;
        else dropped.push(lessonId);
    }
    return { map, dropped, error: null };
}

// Merge an incoming (sanitized) map into the stored one. Per-lesson union:
//   • completedAt — earliest wins (a completion can't be un-done or re-dated)
//   • steps       — key-union, incoming wins per stepId (latest attempt state)
//   • lessons only present in `existing` are kept (the anti-clobber guarantee)
function mergeLearningProgress(existing, incoming) {
    const base = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? existing : {};
    const merged = {};
    const lessonIds = new Set([...Object.keys(base), ...Object.keys(incoming || {})]);
    for (const id of lessonIds) {
        const prevRaw = base[id];
        const next = (incoming && incoming[id] && typeof incoming[id] === 'object') ? incoming[id] : null;
        // Legacy `true` = complete with unknown date: adopt the incoming date if
        // there is one (never pin epoch — earliest-wins would freeze it forever).
        const prev = prevRaw === true
            ? { completedAt: (next && next.completedAt) || new Date().toISOString() }
            : (prevRaw && typeof prevRaw === 'object' ? prevRaw : null);
        if (!next) { if (prev || prevRaw === true) merged[id] = prevRaw; continue; }
        if (!prev) { merged[id] = next; continue; }

        const entry = {};
        if (prev.completedAt && next.completedAt) {
            entry.completedAt = prev.completedAt <= next.completedAt ? prev.completedAt : next.completedAt;
        } else if (prev.completedAt || next.completedAt) {
            entry.completedAt = prev.completedAt || next.completedAt;
        }
        const steps = { ...(prev.steps || {}), ...(next.steps || {}) };
        if (Object.keys(steps).length) entry.steps = steps;
        merged[id] = entry;
    }
    return merged;
}

module.exports = {
    sanitizeLearningProgress,
    mergeLearningProgress,
    MAX_BLOB_BYTES,
};
