/**
 * Unit tests — configurable transactional email templates.
 *
 * Covers:
 *   - emailTemplates defaults + getDefaultEmailTemplate
 *   - languageStore.getEffectiveEmailTemplate per-field English fallback
 *     (full default, partial override, unknown locale, 'en' override)
 *   - emailService.renderEmailFromTemplate: {{var}} substitution, HTML
 *     escaping of user-supplied values, multiline body → <br>, CTA wiring
 *
 * No Postgres: configStore is swapped for an in-memory stub via a Module._load
 * hook (same approach as core/betaFeatures.test.js).
 *
 * Run: node utils/emailTemplates.test.js
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');

// ── In-memory configStore stub ──────────────────────────────────────────
const store = new Map();
const configStorePath = path.resolve(__dirname, '..', 'stores', 'configStore');
const configStoreStub = {
    async getConfig(key) { return store.has(key) ? store.get(key) : null; },
    async setConfig(key, val) { store.set(key, val); },
    async deleteConfig(key) { store.delete(key); },
    async getSecret() { return null; },
    async setSecret() { },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    try {
        const resolved = Module._resolveFilename(request, parent, isMain);
        if (resolved === configStorePath + '.js' || resolved === configStorePath + '/index.js') return configStoreStub;
    } catch (_) { /* fall through */ }
    return originalLoad(request, parent, isMain);
};

const {
    EMAIL_TEMPLATE_IDS, EMAIL_TEMPLATE_FIELDS, EMAIL_TEMPLATE_DEFAULTS, getDefaultEmailTemplate,
} = require('../i18n/defaults/emailTemplates');
const languageStore = require('../stores/languageStore');
const { renderEmailFromTemplate } = require('./emailService');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

(async () => {
    // ── defaults ────────────────────────────────────────────────────────
    ok(EMAIL_TEMPLATE_IDS.includes('verification') && EMAIL_TEMPLATE_IDS.includes('welcome'), 'template ids present');
    for (const id of EMAIL_TEMPLATE_IDS) {
        const d = getDefaultEmailTemplate(id);
        for (const f of EMAIL_TEMPLATE_FIELDS) ok(typeof d[f] === 'string' && d[f].length, `default ${id}.${f} non-empty`);
    }
    ok(getDefaultEmailTemplate('nope') === null, 'unknown template id → null');

    // ── getEffectiveEmailTemplate: no overrides → English defaults ────────
    store.clear();
    const effEn = await languageStore.getEffectiveEmailTemplate('verification', 'en');
    assert.deepStrictEqual(effEn, EMAIL_TEMPLATE_DEFAULTS.verification, 'en with no override = defaults');
    passed++;

    const effNlNone = await languageStore.getEffectiveEmailTemplate('verification', 'nl');
    assert.deepStrictEqual(effNlNone, EMAIL_TEMPLATE_DEFAULTS.verification, 'nl with no override = defaults');
    passed++;

    // ── partial override merges per-field over defaults ──────────────────
    await languageStore.setEmailTemplate('nl', 'verification', { subject: 'Bevestig je e-mail', body: '   ' });
    const effNl = await languageStore.getEffectiveEmailTemplate('verification', 'nl');
    ok(effNl.subject === 'Bevestig je e-mail', 'nl subject overridden');
    ok(effNl.title === EMAIL_TEMPLATE_DEFAULTS.verification.title, 'nl title falls back to English default');
    ok(effNl.body === EMAIL_TEMPLATE_DEFAULTS.verification.body, 'blank override field ignored (falls back)');

    // blank-only override removes the template entry entirely
    await languageStore.setEmailTemplate('nl', 'welcome', { subject: '   ', title: '' });
    const all = await languageStore.getAllEmailTemplates('nl');
    ok(!all.welcome, 'all-blank override drops the template');

    // ── 'en' overrides are honoured (admin can customise base copy) ──────
    await languageStore.setEmailTemplate('en', 'welcome', { subject: 'Custom EN subject' });
    const effEn2 = await languageStore.getEffectiveEmailTemplate('welcome', 'en');
    ok(effEn2.subject === 'Custom EN subject', 'en override honoured');
    ok(effEn2.title === EMAIL_TEMPLATE_DEFAULTS.welcome.title, 'en non-overridden field = default');

    // ── deleteLocale wipes email overrides ──────────────────────────────
    await languageStore.deleteLocale('nl');
    const afterDel = await languageStore.getAllEmailTemplates('nl');
    assert.deepStrictEqual(afterDel, {}, 'deleteLocale clears nl email overrides');
    passed++;

    // ── renderEmailFromTemplate: substitution + escaping + multiline ─────
    const tpl = {
        subject: 'Hi {{name}}',
        title: 'Welcome {{name}}',
        intro: 'Hello {{name}},',
        body: 'Line one for {{orgName}}.\nLine two.',
        ctaLabel: 'Confirm',
    };
    const out = renderEmailFromTemplate(tpl, { name: '<b>Eve</b>', orgName: 'Bee Flow', verifyUrl: 'https://x.test/v/abc' });
    ok(out.subject === 'Hi <b>Eve</b>', 'subject keeps raw value (plain text, not HTML context)');
    ok(out.html.includes('Welcome &lt;b&gt;Eve&lt;/b&gt;'), 'name is HTML-escaped in the rendered title');
    ok(!out.html.includes('<b>Eve</b>'), 'no unescaped user HTML leaks into the email');
    ok(out.html.includes('Line one for Bee Flow.<br>Line two.'), 'body newlines become <br>');
    ok(out.html.includes('href="https://x.test/v/abc"'), 'CTA url wired from verifyUrl');
    ok(out.text.includes('https://x.test/v/abc'), 'plaintext includes the link');

    // welcome uses loginUrl as the CTA
    const out2 = renderEmailFromTemplate(getDefaultEmailTemplate('welcome'), { name: 'A', loginUrl: 'https://x.test' });
    ok(out2.html.includes('href="https://x.test"'), 'welcome CTA url wired from loginUrl');

    console.log(`\n✅ emailTemplates: all ${passed} assertions passed`);
    Module._load = originalLoad;
})().catch(err => {
    console.error('\n❌ emailTemplates test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
});
