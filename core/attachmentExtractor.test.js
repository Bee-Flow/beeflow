/**
 * Unit tests for the content-type routing in the unified attachment
 * extractor. Pure logic for the detectors + the dependency-free plain-text
 * branch — the PDF/Office/image branches need external services and are
 * exercised elsewhere / manually.
 *
 * Run: node core/attachmentExtractor.test.js   (or: node --test)
 */

const assert = require('assert');

const {
    extractAttachment,
    isPdf,
    isDocx,
    isSpreadsheet,
    isImage,
    isPlainText,
} = require('./attachmentExtractor');

(async () => {
    // ── type detectors ─────────────────────────────────────────────────
    assert.ok(isPdf({ type: 'application/pdf', name: 'a.pdf' }));
    assert.ok(isDocx({ type: '', name: 'a.docx' }));
    assert.ok(isSpreadsheet({ type: 'text/csv', name: 'a.csv' }), 'csv routes to the spreadsheet branch');
    assert.ok(isSpreadsheet({ type: '', name: 'a.xlsx' }));

    assert.ok(isImage({ type: 'image/png', name: 'a.png' }), 'image/* by mime');
    assert.ok(isImage({ type: '', name: 'photo.JPG' }), 'image by extension, case-insensitive');
    assert.ok(!isImage({ type: 'application/pdf', name: 'a.pdf' }), 'pdf is not an image');

    assert.ok(isPlainText({ type: 'text/plain', name: 'a.txt' }));
    assert.ok(isPlainText({ type: '', name: 'notes.md' }));
    assert.ok(isPlainText({ type: 'application/json', name: 'data.json' }));
    assert.ok(!isPlainText({ type: 'application/pdf', name: 'a.pdf' }), 'pdf is not plain text');

    // ── plain-text extraction (no external services) ───────────────────
    {
        const content = Buffer.from('hello world', 'utf-8').toString('base64');
        const res = await extractAttachment({ name: 'a.txt', type: 'text/plain', content });
        assert.strictEqual(res.kind, 'text');
        assert.strictEqual(res.text, 'hello world');
        assert.strictEqual(res.source, 'utf8');
    }

    // ── NUL / control chars are stripped (Postgres jsonb can't store NUL) ─
    {
        const raw = 'Invoice \u0000 Q850\u0000OU0P\tline2\nline3';
        const content = Buffer.from(raw, 'utf-8').toString('base64');
        const res = await extractAttachment({ name: 'a.txt', type: 'text/plain', content });
        assert.strictEqual(res.kind, 'text');
        assert.ok(!res.text.includes('\u0000'), 'NUL bytes stripped from extracted text');
        assert.ok(res.text.includes('\t') && res.text.includes('\n'), 'tab/newline preserved');
        assert.strictEqual(res.text, 'Invoice  Q850OU0P\tline2\nline3');
    }

    // ── data-URL prefixed content is decoded ───────────────────────────
    {
        const b64 = Buffer.from('inline', 'utf-8').toString('base64');
        const res = await extractAttachment({ name: 'b.md', type: 'text/markdown', content: `data:text/markdown;base64,${b64}` });
        assert.strictEqual(res.kind, 'text');
        assert.strictEqual(res.text, 'inline');
    }

    // ── unknown binary type → failed (caller surfaces a clear message) ──
    {
        const content = Buffer.from('\x00\x01\x02', 'binary').toString('base64');
        const res = await extractAttachment({ name: 'x.bin', type: 'application/octet-stream', content });
        assert.strictEqual(res.kind, 'failed');
    }

    // ── missing content → failed ───────────────────────────────────────
    {
        const res = await extractAttachment({ name: 'x.txt', type: 'text/plain', content: '' });
        assert.strictEqual(res.kind, 'failed');
    }

    console.log('core/attachmentExtractor.test.js — all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
