/**
 * Unit tests for server/core/dlp/attachmentScanner.js
 *
 * Run: node server/core/dlp/__tests__/attachmentScanner.test.js
 *
 * Mocks the underlying PII detector so the test does not require Azure creds
 * or a running guard-service. We replace `detectPii` in the azurePiiDetection
 * module from inside Node's require cache.
 */

const assert = require('assert');
const Module = require('module');

process.env.NODE_ENV = 'test';

// ── Mock detectPii ─────────────────────────────────────────────────
// We install a tiny mock that pretends to detect every email-like and
// IBAN-like substring. The real Azure call would burn quota and need
// network — both unacceptable for unit tests.
const azurePii = require('../../azurePiiDetection');
const realDetectPii = azurePii.detectPii;

// `mockDelayMs` lets a single test inject artificial latency without
// re-requiring the scanner. The scanner captured `detectPii` via
// destructuring at require time, so we can't swap the function reference
// after the fact — we have to keep the same closure and toggle a flag.
let mockDelayMs = 0;
function mockDetectPii(text) {
    const entities = [];
    const emailRegex = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
    const ibanRegex = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g;
    let m;
    while ((m = emailRegex.exec(text))) {
        entities.push({ text: m[0], category: 'Email', offset: m.index, length: m[0].length, confidence: 0.95, label: 'Email Address' });
    }
    while ((m = ibanRegex.exec(text))) {
        entities.push({ text: m[0], category: 'InternationalBankingAccountNumber', offset: m.index, length: m[0].length, confidence: 0.95, label: 'IBAN' });
    }
    const payload = { hasPii: entities.length > 0, entities, redactedText: text };
    if (mockDelayMs > 0) {
        return new Promise(resolve => setTimeout(() => resolve(payload), mockDelayMs));
    }
    return Promise.resolve(payload);
}
azurePii.detectPii = mockDetectPii;
// `attachmentScanner` captured a reference to `detectPii` at require time
// — re-require it AFTER patching so it sees the mock.
delete require.cache[require.resolve('../attachmentScanner')];

const { scanAttachmentText, AttachmentPrivacyBlock } = require('../attachmentScanner');
const dlpRunner = require('../dlpRunner');

const SHIELD_TOKENIZE = {
    enabled: true,
    azurePiiEnabled: false,
    localPiiEnabled: true,
    piiDetectionAction: 'tokenize',
    piiDetectionCategories: [],
    privacyAction: 'redact',
    privacyScanEnabled: true,
};
const SHIELD_BLOCK = { ...SHIELD_TOKENIZE, piiDetectionAction: 'block', privacyAction: 'block' };
const SHIELD_OFF = { enabled: false, azurePiiEnabled: false, localPiiEnabled: false, privacyScanEnabled: false };

async function testPassThroughWhenDisabled() {
    const r = await scanAttachmentText({
        text: 'Contact me at john@example.com',
        filename: 'note.txt',
        orgShield: SHIELD_OFF,
    });
    assert.strictEqual(r.action, 'pass');
    assert.strictEqual(r.text, 'Contact me at john@example.com');
    assert.deepStrictEqual(r.findings, []);
}

async function testTokeniseWholeText() {
    const conversationId = 'conv-' + Date.now();
    dlpRunner.clearConversationState(conversationId);
    const r = await scanAttachmentText({
        text: 'Reach out to alice@x.com or bob@y.com',
        filename: 'mail.txt',
        orgShield: SHIELD_TOKENIZE,
        conversationId,
    });
    assert.strictEqual(r.action, 'tokenize');
    assert.ok(!/alice@x\.com/.test(r.text), 'tokenised text must not contain raw email');
    assert.ok(!/bob@y\.com/.test(r.text), 'tokenised text must not contain raw email');
    assert.strictEqual(r.findings.length, 2);
    // Tokens were merged into the conversation map.
    const map = dlpRunner.getConversationTokenMap(conversationId);
    const values = Object.values(map);
    assert.ok(values.includes('alice@x.com'));
    assert.ok(values.includes('bob@y.com'));
}

async function testPerPageOffsets() {
    const pages = [
        { pageNumber: 1, text: 'cover page no pii' },
        { pageNumber: 2, text: 'contact: jane@example.org for invoices' },
        { pageNumber: 3, text: 'IBAN NL91ABNA0417164300 attached' },
    ];
    const flat = pages.map(p => p.text).join('\n\n');
    const r = await scanAttachmentText({
        text: flat,
        pages,
        filename: 'invoice.pdf',
        orgShield: SHIELD_TOKENIZE,
        conversationId: 'conv-pp-' + Date.now(),
    });
    assert.strictEqual(r.action, 'tokenize');
    assert.strictEqual(r.findings.length, 2);
    const byPage = {};
    for (const f of r.findings) byPage[f.page] = (byPage[f.page] || 0) + 1;
    assert.strictEqual(byPage[2], 1, 'email expected on page 2');
    assert.strictEqual(byPage[3], 1, 'IBAN expected on page 3');
    // Tokens replaced in the flat text at the correct positions.
    assert.ok(!r.text.includes('jane@example.org'));
    assert.ok(!r.text.includes('NL91ABNA0417164300'));
    // Per-page summary populated.
    assert.ok(r.summary.pages[2]);
    assert.ok(r.summary.pages[3]);
}

async function testBlockShortCircuit() {
    const pages = Array.from({ length: 10 }, (_, i) => ({
        pageNumber: i + 1,
        text: i === 1 ? 'leak: dan@oops.com' : `page ${i + 1} no pii`,
    }));
    const flat = pages.map(p => p.text).join('\n\n');
    const r = await scanAttachmentText({
        text: flat,
        pages,
        filename: 'report.pdf',
        orgShield: SHIELD_BLOCK,
        conversationId: 'conv-blk-' + Date.now(),
    });
    assert.strictEqual(r.action, 'block');
    assert.strictEqual(r.text, null);
    assert.ok(r.findings.length >= 1);
    // First hit is on page 2; scanner should not have walked past it.
    assert.ok(r.findings.every(f => f.page <= 2), 'block-mode scanner should short-circuit on first hit');
}

async function testOverflowFlag() {
    const pages = Array.from({ length: 55 }, (_, i) => ({ pageNumber: i + 1, text: `page ${i + 1}` }));
    const flat = pages.map(p => p.text).join('\n\n');
    const r = await scanAttachmentText({
        text: flat,
        pages,
        filename: 'big.pdf',
        orgShield: SHIELD_TOKENIZE,
        maxPages: 50,
    });
    assert.strictEqual(r.action, 'pass');
    assert.strictEqual(r.summary.overflow, true);
}

async function testEmptyPagesDontDriftOffsets() {
    // Mimic the pdfExtractor return shape exactly: empty pages are kept in
    // the `pages` array, but `text` only contains non-empty pages joined by
    // '\n\n'. The scanner must walk only the non-empty pages so the rebuilt
    // offsets match `text` — otherwise tokenizeText would splice into the
    // wrong characters.
    const pages = [
        { pageNumber: 1, text: 'first page no pii' },
        { pageNumber: 2, text: '' }, // empty (image-only / blank)
        { pageNumber: 3, text: '' },
        { pageNumber: 4, text: 'real content with kate@x.com inside' },
    ];
    const flat = pages.filter(p => p.text).map(p => p.text).join('\n\n');
    const r = await scanAttachmentText({
        text: flat,
        pages,
        filename: 'sparse.pdf',
        orgShield: SHIELD_TOKENIZE,
        conversationId: 'conv-sparse-' + Date.now(),
    });
    assert.strictEqual(r.action, 'tokenize');
    assert.strictEqual(r.findings.length, 1);
    assert.strictEqual(r.findings[0].page, 4);
    // The token must replace the email exactly — meaning offsets line up with
    // `flat`. If empty pages had drifted the offset, the email substring
    // would remain in r.text.
    assert.ok(!r.text.includes('kate@x.com'), 'email must be replaced (offset must match flat text)');
}

async function testParallelScanProducesSameResults() {
    // Each page contains exactly one email; the scanner must find one
    // finding per page regardless of execution order under concurrency.
    const pages = Array.from({ length: 8 }, (_, i) => ({
        pageNumber: i + 1,
        text: `page ${i + 1} content email user${i + 1}@x.com here`,
    }));
    const flat = pages.map(p => p.text).join('\n\n');
    const r = await scanAttachmentText({
        text: flat,
        pages,
        filename: 'parallel.pdf',
        orgShield: SHIELD_TOKENIZE,
        conversationId: 'conv-par-' + Date.now(),
        concurrency: 4,
    });
    assert.strictEqual(r.action, 'tokenize');
    assert.strictEqual(r.findings.length, 8);
    const pagesHit = new Set(r.findings.map(f => f.page));
    assert.strictEqual(pagesHit.size, 8, 'every page should have exactly one finding');
    for (let i = 1; i <= 8; i++) assert.ok(pagesHit.has(i), `page ${i} missing from findings`);
}

async function testDeadlineTimeoutPassesUnderTokenize() {
    // Inject 200 ms latency per page. With concurrency=2 and a 100 ms
    // deadline, every page should overshoot the budget and trip the
    // `pass + timeout=true` branch.
    mockDelayMs = 200;
    try {
        const pages = Array.from({ length: 4 }, (_, i) => ({ pageNumber: i + 1, text: `page ${i + 1}` }));
        const flat = pages.map(p => p.text).join('\n\n');
        const r = await scanAttachmentText({
            text: flat,
            pages,
            filename: 'slow.pdf',
            orgShield: SHIELD_TOKENIZE,
            conversationId: 'conv-deadline-' + Date.now(),
            concurrency: 2,
            maxScanMs: 100,
        });
        assert.strictEqual(r.action, 'pass');
        assert.strictEqual(r.summary.timeout, true);
        assert.strictEqual(r.text, flat, 'text returned unchanged on timeout');
    } finally {
        mockDelayMs = 0;
    }
}

async function testCacheHit() {
    const text = 'Repeat scan: zoe@cache.com';
    const filename = 'cache.txt';
    const conversationA = 'conv-cache-a';
    const conversationB = 'conv-cache-b';
    dlpRunner.clearConversationState(conversationA);
    dlpRunner.clearConversationState(conversationB);

    const r1 = await scanAttachmentText({ text, filename, orgShield: SHIELD_TOKENIZE, conversationId: conversationA });
    assert.strictEqual(r1.action, 'tokenize');
    assert.ok(!r1.summary.cacheHit, 'first scan must be a miss');

    const r2 = await scanAttachmentText({ text, filename, orgShield: SHIELD_TOKENIZE, conversationId: conversationB });
    assert.strictEqual(r2.action, 'tokenize');
    assert.strictEqual(r2.summary.cacheHit, true, 'second scan must be a cache hit');
    // Cache hit still propagates tokens to the new conversation's map.
    const mapB = dlpRunner.getConversationTokenMap(conversationB);
    assert.ok(Object.values(mapB).includes('zoe@cache.com'));
}

async function testBlockErrorShape() {
    const err = new AttachmentPrivacyBlock({
        filename: 'x.pdf',
        summary: { byCategory: { Email: 2 }, count: 2 },
        findings: [],
    });
    assert.strictEqual(err.code, 'ATTACHMENT_PII_BLOCKED');
    assert.ok(err.message.includes('x.pdf'));
}

(async () => {
    const tests = [
        ['passes when shield disabled', testPassThroughWhenDisabled],
        ['tokenises whole-text path', testTokeniseWholeText],
        ['per-page offsets resolve correctly', testPerPageOffsets],
        ['empty pages do not drift later-page offsets', testEmptyPagesDontDriftOffsets],
        ['parallel scan yields the same findings as sequential', testParallelScanProducesSameResults],
        ['scan deadline triggers pass+timeout under Tokenize', testDeadlineTimeoutPassesUnderTokenize],
        ['block-mode short-circuits', testBlockShortCircuit],
        ['overflow flag set past maxPages', testOverflowFlag],
        ['cache hit reuses prior scan + merges tokens to new conv', testCacheHit],
        ['block error carries metadata', testBlockErrorShape],
    ];
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log(`  ✓ ${name}`);
        } catch (err) {
            failed++;
            console.error(`  ✗ ${name}`);
            console.error(err);
        }
    }
    // Restore so other suites in the same process see the real fn.
    azurePii.detectPii = realDetectPii;
    if (failed > 0) {
        console.error(`\n${failed} test(s) failed`);
        process.exit(1);
    } else {
        console.log(`\nAll ${tests.length} tests passed`);
    }
})();
