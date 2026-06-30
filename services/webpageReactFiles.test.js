/**
 * Unit tests for webpageReactFiles.loadReactFiles — the shared helper that
 * builds the esbuild virtual-FS file map + binary asset map for a react-mui
 * page (used by both the headless render and the public-share snapshot).
 *
 * Run: node services/webpageReactFiles.test.js
 *
 * webpageStore is mocked (no DB) so the helper's shape + owner-scoping are
 * tested in isolation.
 */

const assert = require('assert');

// ── Mock webpageStore ──────────────────────────────────────────────
const reads = [];
const mockWebpageStore = {
    listExtraFiles: async () => ([
        { path: 'src/main.jsx', isText: true, mimeType: 'text/javascript' },
        { path: 'assets/logo.png', isText: false, mimeType: 'image/png' },
        { path: 'src/gone.jsx', isText: true, mimeType: 'text/javascript' },
    ]),
    readExtraFile: async ({ webpageId, userId, path }) => {
        reads.push({ webpageId, userId, path });
        if (path === 'src/main.jsx') return { text: "export default 1;", meta: { isText: true } };
        if (path === 'assets/logo.png') return { bytes: Buffer.from([1, 2, 3, 4]), meta: { isText: false, mimeType: 'image/png' } };
        return null; // src/gone.jsx — missing bytes, must be skipped
    },
};

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === '../stores/webpageStore') return 'mock-webpageStore';
    return originalResolve.call(this, request, parent, ...rest);
};
require.cache['mock-webpageStore'] = { id: 'mock-webpageStore', exports: mockWebpageStore };

const { loadReactFiles } = require('./webpageReactFiles');

async function run() {
    let passed = 0, failed = 0;
    async function t(name, fn) {
        try { await fn(); console.log(`  ✅ ${name}`); passed++; }
        catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); failed++; }
    }

    const { files, assetMap } = await loadReactFiles('wp1', 'owner1');

    await t('text files keep their content', () => {
        assert.strictEqual(files['src/main.jsx'].isText, true);
        assert.strictEqual(files['src/main.jsx'].content, 'export default 1;');
    });

    await t('binary files become data: URLs and enter the assetMap', () => {
        assert.strictEqual(files['assets/logo.png'].isText, false);
        assert.match(files['assets/logo.png'].dataUrl, /^data:image\/png;base64,AQIDBA==$/);
        assert.strictEqual(assetMap['assets/logo.png'], files['assets/logo.png'].dataUrl);
    });

    await t('a file whose bytes are missing is skipped (no blank entry)', () => {
        assert.ok(!('src/gone.jsx' in files));
    });

    await t('every read is scoped to the OWNER id, never the caller', () => {
        assert.ok(reads.length >= 2);
        assert.ok(reads.every(r => r.userId === 'owner1'), JSON.stringify(reads));
        assert.ok(reads.every(r => r.webpageId === 'wp1'));
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

run().catch(e => { console.error(e); process.exit(1); });
