/**
 * Unit tests for the webpage post-generation validator (BFSF-222).
 *
 * Run: node services/webpageValidation.test.js
 *
 * The module is pure (regex over in-memory strings, no DB/IO), so no store
 * stubs are needed.
 */

const assert = require('assert');

const {
    DEFAULT_ALLOWED_IMG_HOSTS,
    MAX_VIOLATIONS,
    mergeAllowedImgHosts,
    stripHtmlComments,
    collectAnchorTargets,
    collectFragmentHrefs,
    extractImgRefs,
    classifyImgSrc,
    validateWebpageProject,
    buildRepairMessage,
    formatToolWarning,
} = require('./webpageValidation');

function vanilla({ html = '', scriptTexts = [], assetPaths = [], allowedHosts } = {}) {
    return validateWebpageProject({ framework: 'vanilla', html, scriptTexts, assetPaths, allowedHosts }).violations;
}

(() => {
    // ── Anchors ──────────────────────────────────────────────────────────

    // Matching anchor passes.
    {
        const v = vanilla({ html: '<nav><a href="#pricing">Go</a></nav>\n<section id="pricing"></section>' });
        assert.deepStrictEqual(v, []);
    }

    // Legacy <a name> counts as a target.
    {
        const v = vanilla({ html: '<a href="#top">Up</a>\n<a name="top"></a>' });
        assert.deepStrictEqual(v, []);
    }

    // Missing id flagged with the correct line number.
    {
        const html = '<header>\n<nav>\n<a href="#pricing">Pricing</a>\n</nav>\n</header>';
        const v = vanilla({ html });
        assert.strictEqual(v.length, 1);
        assert.strictEqual(v[0].type, 'broken-anchor');
        assert.strictEqual(v[0].severity, 'error');
        assert.strictEqual(v[0].fragment, 'pricing');
        assert.strictEqual(v[0].line, 3);
        assert.ok(v[0].detail.includes('href="#pricing"'));
        assert.ok(v[0].detail.includes('line 3'));
    }

    // Fragment present as a quoted string in scriptTexts suppresses (ids
    // created dynamically at runtime).
    {
        const html = '<a href="#tab-2">Tab 2</a>';
        assert.strictEqual(vanilla({ html }).length, 1);
        assert.deepStrictEqual(vanilla({ html, scriptTexts: ["el.id = 'tab-2';"] }), []);
        assert.deepStrictEqual(vanilla({ html, scriptTexts: ['document.getElementById("tab-2")'] }), []);
        assert.deepStrictEqual(vanilla({ html, scriptTexts: ['const sel = `tab-2`;'] }), []);
    }

    // Bare href="#" (JS-button idiom) is ignored.
    {
        assert.deepStrictEqual(vanilla({ html: '<a href="#">Menu</a>' }), []);
    }

    // Commented-out href is ignored; comment stripping preserves line numbers.
    {
        const html = '<!-- <a href="#old">old</a> -->\n<a href="#gone">x</a>';
        const v = vanilla({ html });
        assert.strictEqual(v.length, 1);
        assert.strictEqual(v[0].fragment, 'gone');
        assert.strictEqual(v[0].line, 2);
    }
    {
        // Multi-line comment — following content keeps its original line.
        const stripped = stripHtmlComments('<!--\nline2\nline3\n-->\n<p id="x"></p>');
        assert.strictEqual(stripped.split('\n').length, 5);
        assert.ok(!stripped.includes('line2'));
        assert.ok(stripped.includes('id="x"'));
    }

    // collectAnchorTargets / collectFragmentHrefs basics.
    {
        const targets = collectAnchorTargets('<div id="a"></div><a name=\'b\'></a>');
        assert.ok(targets.has('a') && targets.has('b'));
        const hrefs = collectFragmentHrefs("<a href='#a'>x</a><a href=\"#\">y</a>");
        assert.strictEqual(hrefs.length, 1);
        assert.strictEqual(hrefs[0].fragment, 'a');
    }

    // ── Images ───────────────────────────────────────────────────────────

    // Relative img matching a TEXT extra (AI-created SVG) passes; binary
    // PNG extras pass too; leading ./ and / are normalized.
    {
        const assetPaths = ['assets/logo.svg', 'assets/photo.png'];
        assert.deepStrictEqual(vanilla({ html: '<img src="assets/logo.svg">', assetPaths }), []);
        assert.deepStrictEqual(vanilla({ html: '<img src="./assets/photo.png">', assetPaths }), []);
        assert.deepStrictEqual(vanilla({ html: '<img src="/assets/photo.png">', assetPaths }), []);
    }

    // Missing relative img flagged with a closest-asset suggestion.
    {
        const v = vanilla({ html: '<img src="assets/hero.png">', assetPaths: ['images/hero.png', 'assets/logo.svg'] });
        assert.strictEqual(v.length, 1);
        assert.strictEqual(v[0].type, 'missing-asset');
        assert.strictEqual(v[0].severity, 'error');
        assert.strictEqual(v[0].suggestion, 'images/hero.png');
        assert.ok(v[0].detail.includes('assets/hero.png'));
    }

    // placehold.co (default allowlist) passes; data:/blob: pass.
    {
        assert.deepStrictEqual(vanilla({ html: '<img src="https://placehold.co/600x400">' }), []);
        assert.deepStrictEqual(vanilla({ html: '<img src="data:image/png;base64,AAAA">' }), []);
        assert.deepStrictEqual(vanilla({ html: '<img src="blob:https://x/123">' }), []);
    }

    // External host without onerror → warn; with onerror → info.
    {
        const warn = vanilla({ html: '<img src="https://images.unsplash.com/photo-1.jpg">' });
        assert.strictEqual(warn.length, 1);
        assert.strictEqual(warn[0].type, 'external-img');
        assert.strictEqual(warn[0].severity, 'warn');
        const info = vanilla({ html: '<img src="https://images.unsplash.com/photo-1.jpg" onerror="this.style.visibility=\'hidden\'">' });
        assert.strictEqual(info.length, 1);
        assert.strictEqual(info[0].severity, 'info');
    }

    // Admin allowlist (comma-separated) merges with the defaults; subdomains
    // of an allowed host pass.
    {
        const hosts = mergeAllowedImgHosts(' cdn.example.com , brand.io ');
        assert.deepStrictEqual(hosts, [...DEFAULT_ALLOWED_IMG_HOSTS, 'cdn.example.com', 'brand.io']);
        assert.deepStrictEqual(vanilla({ html: '<img src="https://cdn.example.com/a.png">', allowedHosts: hosts }), []);
        assert.deepStrictEqual(vanilla({ html: '<img src="https://eu.brand.io/a.png">', allowedHosts: hosts }), []);
        assert.strictEqual(classifyImgSrc('https://evil.com/a.png', { assetPathSet: new Set(), allowedHosts: hosts }), 'external-img');
    }

    // srcset candidates are parsed (each URL checked, first token per entry).
    {
        const refs = extractImgRefs('<img src="a.png" srcset="b.png 1x, c.png 2x">');
        assert.deepStrictEqual(refs.map(r => r.src), ['a.png', 'b.png', 'c.png']);
        const v = vanilla({ html: '<img src="a.png" srcset="b.png 1x, c.png 2x">', assetPaths: ['a.png', 'b.png'] });
        assert.strictEqual(v.length, 1);
        assert.strictEqual(v[0].src, 'c.png');
    }

    // Empty src → missing-asset; lazy-load data-src is NOT treated as src.
    {
        assert.strictEqual(classifyImgSrc('', { assetPathSet: new Set(), allowedHosts: DEFAULT_ALLOWED_IMG_HOSTS }), 'missing-asset');
        assert.deepStrictEqual(extractImgRefs('<img data-src="lazy.png" class="lazy">'), []);
    }

    // ── react-mui (degraded literal-only scan) ───────────────────────────

    {
        const sources = {
            'src/App.jsx': [
                'export default function App() {',
                '  return (<div>',
                '    <a href="#contact">Contact</a>',   // no id literal anywhere → flag
                '    <a href="#about">About</a>',        // id literal exists → pass
                '    <a href={`#${section}`}>Dyn</a>',   // dynamic → not a literal, skipped
                '  </div>);',
                '}',
            ].join('\n'),
            'src/About.jsx': '<section id="about" />\nconst tpl = `jump to #faq now`;\n<a href="#faq">FAQ</a>',
        };
        const { violations } = validateWebpageProject({ framework: 'react-mui', sources, assetPaths: [] });
        // "#faq" appears inside a template literal → suppressed; only #contact flags.
        assert.strictEqual(violations.length, 1);
        assert.strictEqual(violations[0].type, 'broken-anchor');
        assert.strictEqual(violations[0].fragment, 'contact');
        assert.strictEqual(violations[0].file, 'src/App.jsx');
        assert.strictEqual(violations[0].line, 3);
    }

    // react-mui images: only string-literal relative srcs are checked;
    // externals and data: URIs are skipped entirely.
    {
        const sources = {
            'src/App.jsx': '<img src="assets/hero.png" />\n<img src="https://anything.example/x.png" />\n<img src="assets/logo.svg" />',
        };
        const { violations } = validateWebpageProject({ framework: 'react-mui', sources, assetPaths: ['assets/logo.svg'] });
        assert.strictEqual(violations.length, 1);
        assert.strictEqual(violations[0].type, 'missing-asset');
        assert.strictEqual(violations[0].src, 'assets/hero.png');
    }

    // ── Cap + message builders ───────────────────────────────────────────

    // Violations are capped at 12.
    {
        const html = Array.from({ length: 20 }, (_, i) => `<a href="#missing-${i}">x</a>`).join('\n');
        const v = vanilla({ html });
        assert.strictEqual(v.length, MAX_VIOLATIONS);
        assert.strictEqual(MAX_VIOLATIONS, 12);
    }

    // buildRepairMessage shape.
    {
        const v = vanilla({ html: '<a href="#pricing">x</a>\n<img src="assets/hero.png">', assetPaths: ['assets/logo.svg'] });
        const msg = buildRepairMessage(v, { assetPaths: ['assets/logo.svg'] });
        assert.ok(msg.startsWith('AUTOMATED POST-GENERATION VALIDATION'));
        assert.ok(msg.includes('href="#pricing"'));
        assert.ok(msg.includes('webpage_file_replace'));
        assert.ok(msg.includes('Existing assets: assets/logo.svg'));
        assert.ok(msg.includes('placehold.co'));
        assert.ok(msg.includes('briefly tell the user why instead'));
    }

    // formatToolWarning: '' when clean (or info-only), single compact line otherwise.
    {
        assert.strictEqual(formatToolWarning([]), '');
        const infoOnly = vanilla({ html: '<img src="https://ext.example/x.png" onerror="this.remove()">' });
        assert.strictEqual(formatToolWarning(infoOnly), '');
        const v = vanilla({ html: '<a href="#gone">x</a>' });
        const w = formatToolWarning(v);
        assert.ok(w.startsWith('\nVALIDATION: '));
        assert.ok(w.includes('href="#gone"'));
        assert.ok(w.includes('If you are about to add those sections/assets in your next calls, proceed; otherwise fix the hrefs/srcs.'));
        assert.strictEqual(w.trim().split('\n').length, 1);
    }

    console.log('✓ server/services/webpageValidation.test.js — all assertions passed');
})();
