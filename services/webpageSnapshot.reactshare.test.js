/**
 * Unit tests for webpageSnapshot.writeSnapshot framework branching — the core
 * of the "shared React pages render empty" fix.
 *
 * Run: node services/webpageSnapshot.reactshare.test.js
 *
 * The DB + RustFS deps are mocked. reactBundleServer (real esbuild) bundles the
 * tiny React app so we assert the stored artifact is self-contained, and that
 * the share row is tagged with the right snapshot_kind.
 */

const assert = require('assert');

// ── Captured side effects ──────────────────────────────────────────
const uploads = [];        // { slot, contentType, body }
const kindCalls = [];       // 'react' | 'static'

// ── Mocks (keyed by the require strings used inside the modules) ────
const REACT_SRC = "import { createRoot } from 'react-dom/client'; "
    + "createRoot(document.getElementById('root')).render('hi');";

let frameworkSetting = 'react-mui';

const mockWebpageStore = {
    getWebpageRaw: async () => ({ id: 'wp1', userId: 'owner1', settings: { framework: frameworkSetting } }),
    readAllSlots: async () => ({ html: '<h1>vanilla</h1>', css: 'h1{color:red}', js: '' }),
    listExtraFiles: async () => (frameworkSetting === 'react-mui'
        ? [{ path: 'src/main.jsx', isText: true, mimeType: 'text/javascript' }]
        : []),
    readExtraFile: async ({ path }) => (path === 'src/main.jsx'
        ? { text: REACT_SRC, meta: { isText: true } }
        : null),
};

const mockShareStore = {
    // Mirror the real key shape enough to assert which slot was written.
    snapshotKey: (shareId, slot) => `slot:${slot}`,
    snapshotExtraKey: (shareId, path) => `extra:${path}`,
    setSnapshotKind: async (shareId, kind) => { kindCalls.push(kind); },
};

const mockStorageStore = {
    isAvailable: () => true,
    uploadFile: async (key, buf, contentType) => {
        uploads.push({ slot: key, contentType, body: buf.toString('utf8') });
    },
};

const Module = require('module');
const originalResolve = Module._resolveFilename;
const cacheKey = (name) => `mock-${name}`;
const overrides = {
    '../stores/webpageStore': mockWebpageStore,
    '../stores/webpagePublicShareStore': mockShareStore,
    '../stores/storageStore': mockStorageStore,
};
Module._resolveFilename = function (request, parent, ...rest) {
    if (Object.prototype.hasOwnProperty.call(overrides, request)) return cacheKey(request);
    return originalResolve.call(this, request, parent, ...rest);
};
for (const [req, exp] of Object.entries(overrides)) {
    require.cache[cacheKey(req)] = { id: cacheKey(req), exports: exp };
}

const webpageSnapshot = require('./webpageSnapshot');

async function run() {
    let passed = 0, failed = 0;
    async function t(name, fn) {
        try { await fn(); console.log(`  ✅ ${name}`); passed++; }
        catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); failed++; }
    }

    // ── react-mui ──────────────────────────────────────────────────
    frameworkSetting = 'react-mui';
    uploads.length = 0; kindCalls.length = 0;
    await webpageSnapshot.writeSnapshot({ shareId: 's1', webpageId: 'wp1', ownerId: 'owner1' });

    await t('react page writes the self-contained doc to the reactdoc slot', () => {
        const doc = uploads.find(u => u.slot === 'slot:reactdoc');
        assert.ok(doc, 'reactdoc slot not written: ' + JSON.stringify(uploads.map(u => u.slot)));
        assert.ok(doc.body.includes('<script type="importmap">'), 'no import map');
        assert.ok(doc.body.includes('<script type="module">'), 'no module script');
        assert.ok(doc.body.includes('https://esm.sh'), 'no esm.sh import');
        assert.ok(doc.body.includes('window.beeflowDB'), 'no stubbed bridge');
    });

    await t('react page does NOT write the static html/css slots', () => {
        assert.ok(!uploads.some(u => u.slot === 'slot:html'));
        assert.ok(!uploads.some(u => u.slot === 'slot:css'));
    });

    await t("react page tags the share snapshot_kind = 'react'", () => {
        assert.deepStrictEqual(kindCalls, ['react']);
    });

    // ── vanilla ────────────────────────────────────────────────────
    frameworkSetting = 'vanilla';
    uploads.length = 0; kindCalls.length = 0;
    await webpageSnapshot.writeSnapshot({ shareId: 's2', webpageId: 'wp1', ownerId: 'owner1' });

    await t('vanilla page writes the sanitized html slot, never reactdoc', () => {
        const html = uploads.find(u => u.slot === 'slot:html');
        assert.ok(html, 'html slot not written');
        assert.ok(html.body.includes('<h1>vanilla</h1>'));
        assert.ok(!uploads.some(u => u.slot === 'slot:reactdoc'));
    });

    await t("vanilla page tags the share snapshot_kind = 'static'", () => {
        assert.deepStrictEqual(kindCalls, ['static']);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

run().catch(e => { console.error(e); process.exit(1); });
