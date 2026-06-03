/**
 * Unit — per-locale translation merge + string extraction for the CMS.
 *
 * Guards the contract that makes manual translations safe:
 *   - mergeLocaleContent merges arrays BY INDEX (base owns structure), keeps
 *     non-text fields from base, and reverts cleared (empty) text to source.
 *   - cmsTranslate.extractPageEntries / extractSiteEntries pick up prose and
 *     skip structural keys (icons, links, styles, urls).
 *
 * DB-free (importing cmsStore logs a ConfigStore init notice but does no I/O).
 * Run:  node server/stores/cmsLocaleMerge.test.js
 */

const assert = require('assert');

const { mergeLocaleContent } = require('./cmsStore');
const cmsTranslate = require('../core/cmsTranslate');

// ── mergeLocaleContent ───────────────────────────────────────────────

(function arraysMergeByIndex() {
    const base = {
        eyebrow: 'Features',
        titleParts: [{ text: 'Build', gradient: false }, { text: 'faster', gradient: true }],
        items: [{ icon: 'Star', title: 'A', body: 'aa' }, { icon: 'Lock', title: 'B', body: 'bb' }],
        primaryCta: { label: 'Go', link: { kind: 'app', path: '/app' }, style: 'primary' },
    };
    const ov = {
        titleParts: [null, { text: 'sneller' }],   // only index 1, only text
        items: [{ title: 'AA' }],                   // only index 0, only title
        primaryCta: { label: 'Start' },             // only label
        eyebrow: '',                                // cleared → revert to source
    };
    const out = mergeLocaleContent(base, ov);

    assert.strictEqual(out.eyebrow, 'Features', 'empty string reverts to source');
    assert.strictEqual(out.titleParts[0].text, 'Build', 'untranslated array index keeps source');
    assert.strictEqual(out.titleParts[1].text, 'sneller', 'translated array index wins');
    assert.strictEqual(out.titleParts[1].gradient, true, 'non-text field preserved from base');
    assert.strictEqual(out.items[0].title, 'AA', 'item title translated');
    assert.strictEqual(out.items[0].icon, 'Star', 'item icon preserved');
    assert.strictEqual(out.items[0].body, 'aa', 'untranslated sibling preserved');
    assert.strictEqual(out.items[1].title, 'B', 'item beyond override length untouched');
    assert.strictEqual(out.primaryCta.label, 'Start', 'cta label translated');
    assert.strictEqual(out.primaryCta.link.kind, 'app', 'cta link preserved');
    assert.strictEqual(out.primaryCta.style, 'primary', 'cta style preserved');
})();

(function structureFromBaseNotOverride() {
    // Override can never ADD structure the base doesn't have.
    const base = { title: 'Hi', items: [{ title: 'one' }] };
    const ov = { title: 'Hoi', items: [{ title: 'een' }, { title: 'twee' }], extra: 'x' };
    const out = mergeLocaleContent(base, ov);
    assert.strictEqual(out.items.length, 1, 'base array length wins (extra override items ignored)');
    assert.strictEqual(out.items[0].title, 'een', 'present index translated');
    assert.strictEqual(out.extra, undefined, 'override-only keys are ignored');
})();

(function nullAndTypeGuards() {
    assert.strictEqual(mergeLocaleContent('Hi', null), 'Hi', 'null override → base');
    assert.strictEqual(mergeLocaleContent('Hi', '  '), 'Hi', 'whitespace override → base');
    assert.deepStrictEqual(mergeLocaleContent([1, 2], { 0: 'x' }), [1, 2], 'object over array → base');
    assert.deepStrictEqual(mergeLocaleContent({ a: 1 }, [1]), { a: 1 }, 'array over object → base');
})();

// ── extractPageEntries: prose in, structure out ──────────────────────

(function pageExtraction() {
    const pageDoc = {
        seo: { metaTitle: 'Meta', metaDescription: 'Desc', ogImage: 'cms/x.png', noIndex: false },
        blocks: [{
            id: 'blk_1',
            type: 'hero',
            content: {
                badge: { enabled: true, text: 'New', icon: 'Star' },
                titleParts: [{ text: 'Hello', gradient: false }],
                lead: 'Lead text',
                titleStyle: { fontFamily: 'Satoshi', color: '#fff', fontSize: 48 },
                primaryCta: { label: 'Go', link: { kind: 'app', path: '/app' }, style: 'primary' },
            },
        }],
    };
    const entries = cmsTranslate.extractPageEntries(pageDoc);
    const sources = entries.map(e => e.source).sort();
    assert.deepStrictEqual(
        sources,
        ['Desc', 'Go', 'Hello', 'Lead text', 'Meta', 'New'].sort(),
        'extracts prose only — no icon/style/url/path/color/fontFamily',
    );
    // SEO targets live under ['seo', …]; block text under ['blocks', id, 'content', …].
    const seoEntry = entries.find(e => e.source === 'Meta');
    assert.deepStrictEqual(seoEntry.targetPath, ['seo', 'metaTitle'], 'seo target path');
    const titleEntry = entries.find(e => e.source === 'Hello');
    assert.deepStrictEqual(titleEntry.targetPath, ['blocks', 'blk_1', 'content', 'titleParts', 0, 'text']);
})();

(function siteExtraction() {
    const siteDoc = {
        header: {
            logoText: 'Bee Flow',
            nav: [{ label: 'Pricing', link: { kind: 'page', pageId: 'pg_2' } }],
            ctas: [{ label: 'Log in', style: 'ghost', labelColor: '#000' }],
            navStyle: { color: '#111', fontSize: 14 },
        },
        footer: { brandText: 'Bee Flow', blurb: 'Privacy-first AI', copyright: '© 2026', columns: [{ heading: 'Product', links: [{ label: 'Features', link: {} }] }], socials: [{ platform: 'twitter', link: {} }] },
        pages: [{ id: 'pg_1', title: 'Home' }, { id: 'pg_2', title: 'Pricing' }],
    };
    const entries = cmsTranslate.extractSiteEntries(siteDoc);
    const sources = entries.map(e => e.source).sort();
    assert.deepStrictEqual(
        // 'Pricing' appears twice — once as the nav label, once as the page title.
        sources,
        ['Bee Flow', 'Bee Flow', 'Features', 'Home', 'Log in', 'Pricing', 'Pricing', 'Privacy-first AI', 'Product', '© 2026'].sort(),
        'header/footer prose + page titles; no platform/style/link',
    );
    const titleEntry = entries.find(e => e.source === 'Pricing' && e.targetPath[0] === 'pageTitles');
    assert.deepStrictEqual(titleEntry.targetPath, ['pageTitles', 'pg_2'], 'page title target path');
})();

// ── value guards ─────────────────────────────────────────────────────

(function valueGuards() {
    assert.strictEqual(cmsTranslate.isTranslatableValue('Hello world'), true);
    assert.strictEqual(cmsTranslate.isTranslatableValue('#ffaa00'), false, 'hex color excluded');
    assert.strictEqual(cmsTranslate.isTranslatableValue('https://x.io'), false, 'url excluded');
    assert.strictEqual(cmsTranslate.isTranslatableValue('/pricing'), false, 'path excluded');
    assert.strictEqual(cmsTranslate.isTranslatableValue('   '), false, 'blank excluded');
})();

// ── setAtPath builds index-aligned, null-padded arrays ───────────────

(function setAtPathPads() {
    const root = {};
    cmsTranslate.setAtPath(root, ['blocks', 'b1', 'content', 'items', 2, 'title'], 'X');
    assert.strictEqual(root.blocks.b1.content.items.length, 3, 'array padded to index');
    assert.strictEqual(root.blocks.b1.content.items[0], null, 'lower indices null-padded');
    assert.strictEqual(root.blocks.b1.content.items[2].title, 'X', 'value set at index');
    assert.strictEqual(cmsTranslate.getAtPath(root, ['blocks', 'b1', 'content', 'items', 2, 'title']), 'X');
})();

console.log('cmsLocaleMerge.test.js — all assertions passed');
