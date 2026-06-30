/**
 * Unit tests — learning progress blob validation + merge.
 *
 * progressValidation.js is pure (no stores, no network), so these tests pin
 * its behaviour directly: lesson-id whitelisting against the server catalog,
 * legacy `true` normalization, completedAt sanity checks, the per-step and
 * whole-blob size caps, and the anti-clobber merge semantics (earliest
 * completedAt wins, steps key-union with incoming winning per stepId).
 *
 * Run: node --test server/learning/progressValidation.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { sanitizeLearningProgress, mergeLearningProgress, MAX_BLOB_BYTES } = require('./progressValidation');

const VALID_AT = '2026-06-01T10:00:00.000Z';

// ── sanitizeLearningProgress ────────────────────────────────────────────

test('sanitize drops unknown lesson ids and keeps catalog ones (incl. effective-prompts)', () => {
    const { map, dropped, error } = sanitizeLearningProgress({
        'fake-lesson': { completedAt: VALID_AT },
        'effective-prompts': { completedAt: VALID_AT },
    });
    assert.equal(error, null);
    assert.ok(!('fake-lesson' in map), 'unknown lesson id must not survive');
    assert.ok(dropped.includes('fake-lesson'), 'unknown lesson id reported in dropped');
    assert.deepEqual(map['effective-prompts'], { completedAt: VALID_AT },
        'effective-prompts is a real catalog lesson (course-less) and must be accepted');
});

test('sanitize normalizes legacy `true` entries to { completedAt: now-ish }', () => {
    const before = Date.now();
    const { map } = sanitizeLearningProgress({ 'getting-started': true });
    const after = Date.now();
    const stamped = map['getting-started']?.completedAt;
    assert.equal(typeof stamped, 'string');
    const ts = Date.parse(stamped);
    assert.ok(!Number.isNaN(ts), 'normalized completedAt must parse');
    assert.ok(ts >= before && ts <= after, 'legacy true is stamped with the current time, not epoch');
});

test('sanitize drops entries with invalid completedAt (garbage or far-future)', () => {
    const farFuture = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString(); // > now + 24h skew
    const { map, dropped } = sanitizeLearningProgress({
        'getting-started': { completedAt: 'not-a-date' },
        'using-memory': { completedAt: farFuture },
        'prompt-basics': { completedAt: VALID_AT },
    });
    assert.ok(!('getting-started' in map), 'garbage completedAt entry dropped');
    assert.ok(!('using-memory' in map), 'completedAt beyond now+24h dropped');
    assert.ok(dropped.includes('getting-started') && dropped.includes('using-memory'));
    assert.deepEqual(map['prompt-basics'], { completedAt: VALID_AT }, 'valid past date kept');
});

test('sanitize truncates steps to 40 keys per lesson', () => {
    const steps = {};
    for (let i = 1; i <= 45; i += 1) steps[`step-${i}`] = { seen: true };
    const { map } = sanitizeLearningProgress({ 'getting-started': { steps } });
    assert.equal(Object.keys(map['getting-started'].steps).length, 40,
        'only the first 40 step keys survive');
});

test('sanitize drops a single step state larger than 2KB but keeps the rest', () => {
    const { map } = sanitizeLearningProgress({
        'getting-started': {
            steps: {
                small: { ok: true },
                big: 'y'.repeat(3000), // JSON length > 2048
            },
        },
    });
    const kept = map['getting-started'].steps;
    assert.deepEqual(Object.keys(kept), ['small'], 'oversized step state dropped, small one kept');
});

test('sanitize drops step ids longer than 64 chars', () => {
    const longId = 'a'.repeat(65);
    const { map } = sanitizeLearningProgress({
        'getting-started': { steps: { [longId]: { seen: true }, ok: { seen: true } } },
    });
    const kept = map['getting-started'].steps;
    assert.ok(!(longId in kept), 'over-long step id dropped');
    assert.ok('ok' in kept);
});

test('sanitize rejects a payload over 64KB with { error: too_large, map: null }', () => {
    const huge = { 'getting-started': { steps: { s: 'x'.repeat(MAX_BLOB_BYTES + 1000) } } };
    const result = sanitizeLearningProgress(huge);
    assert.equal(result.error, 'too_large');
    assert.equal(result.map, null);
});

test('sanitize returns an empty map for non-object input', () => {
    for (const input of [null, undefined, 'progress', 42, [1, 2, 3], true]) {
        assert.deepEqual(sanitizeLearningProgress(input), { map: {}, dropped: [], error: null },
            `input ${JSON.stringify(input)} must yield an empty map`);
    }
});

// ── mergeLearningProgress ───────────────────────────────────────────────

test('merge: earliest completedAt wins regardless of which side is older', () => {
    const early = '2026-01-01T00:00:00.000Z';
    const late = '2026-02-01T00:00:00.000Z';
    let merged = mergeLearningProgress(
        { 'getting-started': { completedAt: early } },
        { 'getting-started': { completedAt: late } },
    );
    assert.equal(merged['getting-started'].completedAt, early, 'existing earlier date kept');
    merged = mergeLearningProgress(
        { 'getting-started': { completedAt: late } },
        { 'getting-started': { completedAt: early } },
    );
    assert.equal(merged['getting-started'].completedAt, early, 'incoming earlier date adopted');
});

test('merge: lesson only present in existing is kept (anti-clobber)', () => {
    const merged = mergeLearningProgress(
        { 'using-memory': { completedAt: VALID_AT } },
        { 'getting-started': { completedAt: VALID_AT } },
    );
    assert.deepEqual(merged['using-memory'], { completedAt: VALID_AT },
        'a stale device writing a partial map must not erase other-device progress');
});

test('merge: lesson only present in incoming is added', () => {
    const merged = mergeLearningProgress(
        {},
        { 'prompt-basics': { completedAt: VALID_AT } },
    );
    assert.deepEqual(merged['prompt-basics'], { completedAt: VALID_AT });
});

test('merge: steps key-union with incoming winning per stepId', () => {
    const merged = mergeLearningProgress(
        { 'getting-started': { steps: { s1: { a: 1 }, s2: { b: 1 } } } },
        { 'getting-started': { steps: { s2: { b: 2 }, s3: { c: 1 } } } },
    );
    assert.deepEqual(merged['getting-started'].steps, { s1: { a: 1 }, s2: { b: 2 }, s3: { c: 1 } });
});

test('merge: completedAt present on only one side is kept', () => {
    // Existing has the completion, incoming only has resume state.
    let merged = mergeLearningProgress(
        { 'getting-started': { completedAt: VALID_AT } },
        { 'getting-started': { steps: { s1: { seen: true } } } },
    );
    assert.equal(merged['getting-started'].completedAt, VALID_AT);
    assert.deepEqual(merged['getting-started'].steps, { s1: { seen: true } });
    // Incoming has the completion, existing only has resume state.
    merged = mergeLearningProgress(
        { 'getting-started': { steps: { s1: { seen: true } } } },
        { 'getting-started': { completedAt: VALID_AT } },
    );
    assert.equal(merged['getting-started'].completedAt, VALID_AT);
    assert.deepEqual(merged['getting-started'].steps, { s1: { seen: true } });
});

test('merge: legacy `true` in existing adopts the incoming completedAt (never epoch)', () => {
    const incomingAt = '2026-03-05T00:00:00.000Z';
    const merged = mergeLearningProgress(
        { 'getting-started': true },
        { 'getting-started': { completedAt: incomingAt } },
    );
    assert.equal(merged['getting-started'].completedAt, incomingAt,
        'legacy true must take the incoming date, not pin 1970 via earliest-wins');
});
