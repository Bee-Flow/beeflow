/**
 * Unit tests — builder system-prompt rendering (§B/§C).
 *
 * Plain assert-based suite (no jest/mocha in this repo).
 * Run: node automation/builderPrompt.test.js
 *
 * builderPrompt is pure (it only require()s outputSchemas lazily) — no DB.
 */

const assert = require('assert');
const {
    renderCatalog,
    renderCatalogSlim,
    buildFullSystemPrompt,
    buildLeanSystemPrompt,
    buildFewShotMessages,
} = require('./builderPrompt');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const CATALOG = {
    apps: [
        {
            id: 'gmail', label: 'Gmail', available: true, actions: [
                { name: 'gmail_search', description: 'Search Gmail\n(second line ignored)', sideEffect: false, inputSchema: { type: 'object', properties: { q: {}, maxResults: {} }, required: ['q'] } },
                { name: 'gmail_compose', description: 'Send an email', sideEffect: true, inputSchema: { type: 'object', properties: { to: {}, subject: {}, body: {}, cc: {} }, required: ['to', 'body'] } },
            ],
        },
        { id: 'hidden', label: 'Hidden', available: false, actions: [{ name: 'hidden_tool', description: 'x', sideEffect: false, inputSchema: null }] },
    ],
};

// ─── renderCatalogSlim ──────────────────────────────────────────────────────
console.log('renderCatalogSlim');

t('emits one line per action with name + input count, grouped by app', () => {
    const out = renderCatalogSlim(CATALOG);
    assert.ok(out.includes('### Gmail (gmail)'), 'app header present');
    assert.ok(out.includes('gmail_search [list] — Search Gmail (2 inputs, 1 required)'), 'search line with count + required');
    assert.ok(out.includes('gmail_compose [side-effect] — Send an email (4 inputs, 2 required)'), 'compose line with side-effect + counts');
});

t('does NOT leak output shapes or param names', () => {
    const out = renderCatalogSlim(CATALOG);
    assert.ok(!out.includes('→ output:'), 'no output-shape annotation');
    assert.ok(!/\bproperties\b/.test(out), 'no raw schema');
    // param names must not appear — only counts
    assert.ok(!/\bmaxResults\b/.test(out), 'param names withheld (fetched via inspect)');
});

t('excludes unavailable apps', () => {
    const out = renderCatalogSlim(CATALOG);
    assert.ok(!out.includes('Hidden'), 'available:false app excluded');
});

t('is materially shorter than the full renderCatalog', () => {
    const slim = renderCatalogSlim(CATALOG);
    const full = renderCatalog(CATALOG);
    assert.ok(slim.length < full.length, `slim (${slim.length}) should be shorter than full (${full.length})`);
});

t('renders "no inputs" when an action declares none', () => {
    const cat = { apps: [{ id: 'a', label: 'A', available: true, actions: [{ name: 'ping', description: 'p', sideEffect: false, inputSchema: { type: 'object', properties: {} } }] }] };
    assert.ok(renderCatalogSlim(cat).includes('ping — p (no inputs)'), 'no-inputs tag');
});

// ─── full prompt: slim catalog + gated sections + new rules ──────────────────
console.log('buildFullSystemPrompt');

t('uses the slim catalog (no output-shape arrows)', () => {
    const p = buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
    assert.ok(!p.includes('→ output:'), 'full prompt no longer dumps output shapes');
});

t('teaches in-place editing and inspect-before-bind', () => {
    const p = buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
    assert.ok(p.includes('builder_update_step'), 'mentions builder_update_step');
    assert.ok(p.includes('builder_inspect_tool'), 'mentions builder_inspect_tool');
    assert.ok(/never delete and recreate/i.test(p), 'has the never-delete-to-edit rule');
});

t('gates the Webpages section behind catalog presence', () => {
    const without = buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
    assert.ok(!without.includes('Inspecting webpages'), 'no Webpages prose when not in catalog');
    const withWp = buildFullSystemPrompt({
        catalog: { apps: [{ id: 'webpages', label: 'Webpages', available: true, actions: [{ name: 'webpage_db_exec', description: 'SQL', sideEffect: true, inputSchema: { type: 'object', properties: { webpageId: {}, sql: {} }, required: ['webpageId', 'sql'] } }] }] },
        codeStepEnabled: false,
    });
    assert.ok(withWp.includes('Inspecting webpages'), 'Webpages prose present when webpage tools exist');
});

t('gates the Drive sourceHandle section behind drive_upload_file', () => {
    const without = buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
    assert.ok(!without.includes('Mail attachments → Google Drive'), 'no Drive prose without drive_upload_file');
    const withDrive = buildFullSystemPrompt({
        catalog: { apps: [{ id: 'gdrive', label: 'Drive', available: true, actions: [{ name: 'drive_upload_file', description: 'Upload', sideEffect: true, inputSchema: { type: 'object', properties: { name: {} } } }] }] },
        codeStepEnabled: false,
    });
    assert.ok(withDrive.includes('Mail attachments → Google Drive'), 'Drive prose present when drive_upload_file exists');
});

// ─── lean prompt mirrors the new rules ──────────────────────────────────────
console.log('buildLeanSystemPrompt');

t('lean prompt mentions inspect + update_step', () => {
    const p = buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
    assert.ok(p.includes('builder_inspect_tool'), 'lean mentions inspect');
    assert.ok(p.includes('builder_update_step'), 'lean mentions update_step');
    assert.ok(!p.includes('→ output:'), 'lean uses slim catalog');
});

// ─── few-shots: small models (count=3) get inspect + update examples ─────────
console.log('buildFewShotMessages');

t('count=3 includes the inspect-then-bind and update-in-place examples', () => {
    const msgs = JSON.stringify(buildFewShotMessages(3));
    assert.ok(msgs.includes('builder_inspect_tool'), 'inspect-then-bind example present');
    assert.ok(msgs.includes('builder_update_step'), 'update-in-place example present');
});

t('count=1 is just the binding-basics example (no inspect/update yet)', () => {
    const msgs = JSON.stringify(buildFewShotMessages(1));
    assert.ok(!msgs.includes('builder_inspect_tool'), 'count=1 omits inspect example');
    assert.ok(!msgs.includes('builder_update_step'), 'count=1 omits update example');
});

console.log(`\nbuilderPrompt.test.js: ${passed} assertions passed`);
