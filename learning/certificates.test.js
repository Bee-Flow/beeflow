/**
 * Unit tests — certificate issuance + the migrate-once intro-tour shim.
 *
 * certificates.js is the issuance authority: it recomputes eligibility from
 * the server-side progress blob and never trusts client claims. We stub
 * ../stores/configStore and ../stores/certificateStore via Module._load
 * (same technique as core/betaFeatures.test.js) so no Postgres is needed;
 * courseCatalog/completion/certificateToken run for real. LEARNING_CERT_SECRET
 * is set before require so serial/token derivation is deterministic.
 *
 * Run: node --test server/learning/certificates.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

process.env.LEARNING_CERT_SECRET = 'x'.repeat(48);

// ── Mock injection ──────────────────────────────────────────────────────
// certificates.js requires '../stores/configStore' and '../stores/certificateStore';
// resolve those ids relative to learning/ (this dir) to absolute paths and swap
// them in Module._load BEFORE requiring the module under test.
const configStorePath = path.resolve(__dirname, '..', 'stores', 'configStore');
const certStorePath = path.resolve(__dirname, '..', 'stores', 'certificateStore');

let configData = {};
let setConfigCalls = [];
const configStoreStub = {
    async getConfig(key) {
        return Object.prototype.hasOwnProperty.call(configData, key) ? configData[key] : null;
    },
    async setConfig(key, value) {
        setConfigCalls.push({ key, value });
        configData[key] = value;
    },
};

let certData = {}; // `${userId}|${certId}` → record
let setLookupCalls = [];
let clearLookupCalls = [];
const certStoreStub = {
    async getCertificate(userId, certId) { return certData[`${userId}|${certId}`] || null; },
    async saveCertificate(userId, certId, record) {
        certData[`${userId}|${certId}`] = record;
        return record;
    },
    async setLookup(hash, userId, certId) { setLookupCalls.push({ hash, userId, certId }); },
    async clearLookup(hash) { clearLookupCalls.push({ hash }); },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    try {
        const resolved = Module._resolveFilename(request, parent, isMain);
        if (resolved === configStorePath + '.js' || resolved === configStorePath + '/index.js') return configStoreStub;
        if (resolved === certStorePath + '.js' || resolved === certStorePath + '/index.js') return certStoreStub;
    } catch (_) { /* ignore resolution errors, fall through */ }
    return originalLoad(request, parent, isMain);
};

const { readServerProgress, issueCertificate } = require('./certificates');
const { makeSerial, tokenHash } = require('../auth/certificateToken');

function resetMocks() {
    configData = {};
    setConfigCalls = [];
    certData = {};
    setLookupCalls = [];
    clearLookupCalls = [];
}

const at = (iso = '2026-06-01T10:00:00.000Z') => ({ completedAt: iso });

// Full foundations-track progress (course-foundations + course-prompting).
function foundationsProgress() {
    const map = {};
    for (const id of [
        'getting-started', 'using-memory',
        'prompt-basics', 'prompt-context', 'prompt-structure', 'prompt-iterating', 'prompt-advanced',
    ]) map[id] = at();
    return map;
}

// ── readServerProgress — migrate-once intro-tour shim ───────────────────

test('readServerProgress migrates the legacy intro-tour flag once, stamped now()', async () => {
    resetMocks();
    configData = { has_seen_intro_tour_user_u1: true }; // no progress blob, no marker
    const before = Date.now();
    const map = await readServerProgress('u1');
    const after = Date.now();

    const stamped = map['getting-started']?.completedAt;
    assert.equal(typeof stamped, 'string', 'getting-started injected from the intro-tour flag');
    const ts = Date.parse(stamped);
    assert.ok(ts >= before && ts <= after,
        'migration stamps a CURRENT date — epoch would freeze into badge earnedAt via earliest-wins');

    assert.ok(setConfigCalls.some((c) => c.key === 'learning_progress_user_u1'),
        'migrated map persisted');
    assert.ok(setConfigCalls.some((c) => c.key === 'learning_intro_migrated_user_u1' && c.value === true),
        'migration marker written so the flag is never consulted again');
});

test('readServerProgress does NOT re-inject getting-started once the marker is set', async () => {
    resetMocks();
    configData = {
        has_seen_intro_tour_user_u1: true,
        learning_intro_migrated_user_u1: true,
        // progress blob absent/empty — the user reset their progress
    };
    const map = await readServerProgress('u1');
    assert.ok(!map['getting-started'], 'reset progress stays reset after the one-time migration');
    assert.equal(setConfigCalls.length, 0, 'no writes on the steady-state read path');
});

// ── issueCertificate ────────────────────────────────────────────────────

test('issueCertificate refuses when the server-side progress is not eligible', async () => {
    resetMocks();
    const result = await issueCertificate('u1', 'cert-foundations', { recipientName: 'Tom' });
    assert.deepEqual(result, { error: 'not_eligible' });
    assert.deepEqual(certData, {}, 'nothing persisted on refusal');
});

test('issueCertificate mints a record with serial + verifyTokenHash when eligible', async () => {
    resetMocks();
    configData = { learning_progress_user_u1: foundationsProgress() };
    const { record, verifyToken, error } = await issueCertificate('u1', 'cert-foundations', {
        recipientName: 'Tom', makePublic: false,
    });
    assert.equal(error, undefined);
    assert.match(record.serial, /^BF-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.equal(record.serial, makeSerial('cert-foundations', 'u1', record.issuedDayUTC),
        'serial derives from the canonical issuance tuple');
    assert.equal(record.verifyTokenHash, tokenHash(verifyToken),
        'record stores the token HASH, the plaintext token is only returned to the caller');
    assert.equal(record.certificateId, 'cert-foundations');
    assert.equal(record.userId, 'u1');
    assert.ok(certData['u1|cert-foundations'], 'record persisted via certStore');
});

test('re-issue preserves the original issuedAt / issuedDayUTC (idempotent serial)', async () => {
    resetMocks();
    configData = { learning_progress_user_u1: foundationsProgress() };
    const first = await issueCertificate('u1', 'cert-foundations', {});
    assert.ok(first.record);

    // Simulate an older original issuance on file, then re-issue.
    const originalIssuedAt = '2026-01-02T03:04:05.000Z';
    certData['u1|cert-foundations'] = {
        ...first.record,
        issuedAt: originalIssuedAt,
        issuedDayUTC: '2026-01-02',
    };
    const second = await issueCertificate('u1', 'cert-foundations', {});
    assert.equal(second.record.issuedAt, originalIssuedAt, 'original issuedAt preserved');
    assert.equal(second.record.issuedDayUTC, '2026-01-02');
    assert.equal(second.record.serial, makeSerial('cert-foundations', 'u1', '2026-01-02'),
        'serial recomputed from the ORIGINAL issuance day');
});

test('makePublic toggles the reverse lookup index: true → setLookup, false → clearLookup', async () => {
    resetMocks();
    configData = { learning_progress_user_u1: foundationsProgress() };

    const pub = await issueCertificate('u1', 'cert-foundations', { makePublic: true });
    assert.equal(pub.record.isPublic, true);
    assert.equal(setLookupCalls.length, 1);
    assert.deepEqual(setLookupCalls[0], {
        hash: tokenHash(pub.verifyToken), userId: 'u1', certId: 'cert-foundations',
    });
    assert.equal(clearLookupCalls.length, 0);

    const priv = await issueCertificate('u1', 'cert-foundations', { makePublic: false });
    assert.equal(priv.record.isPublic, false);
    assert.equal(clearLookupCalls.length, 1);
    assert.equal(clearLookupCalls[0].hash, tokenHash(priv.verifyToken),
        'going private clears the public index entry');
    assert.equal(setLookupCalls.length, 1, 'no new lookup written for a private cert');
});

test('issueCertificate honours visibleByCourse for gated lessons (cert-practitioner)', async () => {
    resetMocks();
    // Three full courses + only the 'automations' half of course-skills-automation.
    const progress = {
        ...foundationsProgress(),                       // course-foundations + course-prompting
        'connecting-integrations': at(), 'org-usage': at(), // course-power
        'automations': at(),                            // course-skills-automation, gated half only
    };
    configData = { learning_progress_user_u1: progress };

    // Strict semantics (no visibleByCourse): creating-skills missing → 3 of 4 courses.
    const strict = await issueCertificate('u1', 'cert-practitioner', {});
    assert.deepEqual(strict, { error: 'not_eligible' });

    // The caller resolved that this user can only see 'automations' in that course.
    const visibleByCourse = { 'course-skills-automation': ['automations'] };
    const visible = await issueCertificate('u1', 'cert-practitioner', { visibleByCourse });
    assert.ok(visible.record, 'visible-aware eligibility: 4 of 4 accessible courses complete');
    assert.equal(visible.record.certificateId, 'cert-practitioner');
    assert.equal(visible.record.courses.length, 4);
});
