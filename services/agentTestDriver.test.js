/**
 * Unit tests for agentTestDriver — focuses on pure functions and the tool
 * dispatcher. We mock playwright and the Anthropic SDK so the test doesn't
 * launch a real browser.
 *
 * Run: node server/services/agentTestDriver.test.js
 */

const assert = require('assert');

// Stub stores/configStore + testRunStore so requiring agentTestDriver doesn't
// touch the DB. Stubs are reassignable per-test.
const testRunStoreStub = {
    appendProgress: async () => {},
    publishEvent: () => {},
};
const configStoreStub = {
    getSecret: async (key) => (key === 'claude_api_key' ? 'sk-stub' : null),
    getConfig: async () => null,
};
const modelResolverStub = {
    resolveModelForTier: async () => 'claude-sonnet-4-6',
};

require.cache[require.resolve('../stores/testRunStore')] = { exports: testRunStoreStub };
require.cache[require.resolve('../stores/configStore')] = { exports: configStoreStub };
require.cache[require.resolve('../core/modelResolver')] = { exports: modelResolverStub };

const driver = require('./agentTestDriver');
const { TOOLS, _executeTool, _flattenA11y, _buildReport, _buildSeedMessage } = driver._internals;

// Capture the internal helpers via a re-require — they're not exported, but
// we exercise them indirectly through _executeTool's pw_type branch and
// _buildSeedMessage's credential-hint branch.

(async () => {
    // ── Tool schemas: required fields are well-formed ──────────────
    {
        const names = TOOLS.map(t => t.name);
        for (const required of ['pw_navigate', 'pw_click', 'pw_type', 'pw_snapshot', 'pw_get_text', 'pw_record_finding', 'pw_done']) {
            assert.ok(names.includes(required), `missing tool: ${required}`);
        }
        for (const tool of TOOLS) {
            assert.strictEqual(tool.input_schema.type, 'object');
            assert.ok(typeof tool.description === 'string' && tool.description.length > 10);
        }
    }

    // ── pw_navigate: cross-origin blocked, records skipped finding ─
    {
        const findings = [];
        const sameOriginGuard = (url) => false; // refuse all
        const fakePage = {};
        const r = await _executeTool(fakePage, 'pw_navigate', { url: 'https://evil.com' }, { findings, sameOriginGuard });
        assert.strictEqual(r.ok, false);
        assert.match(r.error, /navigation_blocked/);
        assert.strictEqual(findings.length, 1);
        assert.strictEqual(findings[0].status, 'skipped');
        assert.strictEqual(findings[0].category, 'security');
    }

    // ── pw_navigate: same-origin allowed, page.goto called ────────
    {
        const findings = [];
        const sameOriginGuard = () => true;
        let gotoUrl;
        const fakePage = {
            goto: async (u) => { gotoUrl = u; },
            url: () => 'https://example.com/x',
            title: async () => 'Hello',
        };
        const r = await _executeTool(fakePage, 'pw_navigate', { url: 'https://example.com/x' }, { findings, sameOriginGuard });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(gotoUrl, 'https://example.com/x');
        assert.strictEqual(r.title, 'Hello');
        assert.strictEqual(findings.length, 0);
    }

    // ── pw_record_finding: validates enum values, falls back safely ─
    {
        const findings = [];
        const r = await _executeTool({}, 'pw_record_finding', {
            name: 'X',
            status: 'bogus',
            category: 'nonsense',
            severity: 'critical',
            description: 'desc',
        }, { findings, sameOriginGuard: () => true });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(findings.length, 1);
        assert.strictEqual(findings[0].status, 'warning');         // bogus → warning
        assert.strictEqual(findings[0].category, 'functionality'); // nonsense → functionality
        assert.strictEqual(findings[0].severity, 'critical');
    }

    // ── pw_done: signals loop termination ─────────────────────────
    {
        const r = await _executeTool({}, 'pw_done', { summary: 'all good' }, { findings: [], sameOriginGuard: () => true });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.done, true);
        assert.strictEqual(r.summary, 'all good');
    }

    // ── unknown tool: returns structured error ────────────────────
    {
        const r = await _executeTool({}, 'pw_nope', {}, { findings: [], sameOriginGuard: () => true });
        assert.strictEqual(r.ok, false);
        assert.match(r.error, /unknown_tool/);
    }

    // ── _flattenA11y: nested tree → indented string ───────────────
    {
        const tree = {
            role: 'WebArea', name: 'page',
            children: [
                { role: 'heading', name: 'Welcome' },
                { role: 'button', name: 'Submit', focusable: true },
            ],
        };
        const out = _flattenA11y(tree);
        assert.match(out, /WebArea "page"/);
        assert.match(out, /heading "Welcome"/);
        assert.match(out, /button "Submit" \[focusable\]/);
    }

    // ── _buildReport: counts findings into summary correctly ──────
    {
        const findings = [
            { status: 'passed' },
            { status: 'failed' },
            { status: 'skipped' },
            { status: 'warning' },
            { status: 'passed' },
        ];
        const { status, reportJson } = _buildReport({
            targetUrl: 'https://example.com',
            findings,
            stepLog: [{ tool: 'pw_navigate' }],
            sourceMeta: { type: 'text', label: 'spec' },
        });
        assert.strictEqual(status, 'failed'); // any failed → failed
        assert.deepStrictEqual(reportJson.summary, { passed: 2, failed: 1, skipped: 1, warnings: 1 });
        assert.strictEqual(reportJson.url, 'https://example.com');
        assert.strictEqual(reportJson.metadata.stepCount, 1);
        assert.strictEqual(reportJson.metadata.sourceMeta.label, 'spec');
        assert.match(reportJson.notes, /spec/);
    }

    // ── _buildReport: pass + warning → passed (at least one real check went green) ─
    {
        const { status } = _buildReport({
            targetUrl: 'https://example.com',
            findings: [{ status: 'passed' }, { status: 'warning' }],
            stepLog: [],
            sourceMeta: null,
        });
        assert.strictEqual(status, 'passed');
    }

    // ── _buildReport: only warnings/skips → error (agent did nothing useful) ─
    {
        const { status } = _buildReport({
            targetUrl: 'https://example.com',
            findings: [{ status: 'warning' }, { status: 'skipped' }],
            stepLog: [],
            sourceMeta: null,
        });
        assert.strictEqual(status, 'error');
    }

    // ── _buildReport: empty findings → error (agent never recorded anything) ─
    {
        const { status } = _buildReport({
            targetUrl: 'https://example.com',
            findings: [],
            stepLog: [],
            sourceMeta: null,
        });
        assert.strictEqual(status, 'error');
    }

    // ── _buildSeedMessage: includes target URL + instructions + origin warning ─
    {
        const msg = _buildSeedMessage({
            targetUrl: 'https://example.com/login',
            instructions: 'Verify the email field rejects "x"',
            sourceMeta: { type: 'youtrack', label: 'PROJ-123' },
        });
        assert.match(msg, /https:\/\/example\.com\/login/);
        assert.match(msg, /Verify the email field/);
        assert.match(msg, /PROJ-123/);
        assert.match(msg, /https:\/\/example\.com/); // origin in cross-origin warning
        assert.doesNotMatch(msg, /\{\{USERNAME\}\}/); // no creds → no placeholder hint
    }

    // ── _buildSeedMessage: lists available placeholders + real secret never present ─
    {
        const msg = _buildSeedMessage({
            targetUrl: 'https://example.com/login',
            instructions: 'Log in and verify the dashboard loads',
            sourceMeta: null,
            availablePlaceholders: ['USERNAME', 'PASSWORD'],
        });
        assert.match(msg, /\{\{USERNAME\}\}/);
        assert.match(msg, /\{\{PASSWORD\}\}/);
        assert.match(msg, /placeholder/i);
    }

    // ── pw_type: substitutes {{PASSWORD}} placeholder before fill() ─
    {
        const findings = [];
        let filledWith = null;
        const fakePage = {
            locator: () => ({
                first: () => ({
                    fill: async (t) => { filledWith = t; },
                    press: async () => {},
                }),
            }),
        };
        const r = await _executeTool(fakePage, 'pw_type', { selector: 'input[type=password]', text: '{{PASSWORD}}' }, {
            findings,
            sameOriginGuard: () => true,
            credentials: { password: 'super-secret-123' },
        });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(filledWith, 'super-secret-123');
        assert.strictEqual(r.usedCredential, true);
    }

    // ── pw_type: unknown placeholder passes through unchanged (no silent empty fill) ─
    {
        const findings = [];
        let filledWith = null;
        const fakePage = {
            locator: () => ({ first: () => ({ fill: async (t) => { filledWith = t; }, press: async () => {} }) }),
        };
        const r = await _executeTool(fakePage, 'pw_type', { selector: 'input', text: '{{API_KEY}}' }, {
            findings,
            sameOriginGuard: () => true,
            credentials: { password: 'pw' },
        });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(filledWith, '{{API_KEY}}');     // preserved
        assert.strictEqual(r.usedCredential, false);        // nothing substituted
    }

    // ── pw_type: missing credentials map → placeholder also passes through ─
    {
        let filledWith = null;
        const firstLoc = {
            fill: async (t) => { filledWith = t; },
            press: async () => {},
        };
        // Cover both the role+selector path (returns a Locator with .first())
        // and the no-locator fallback path (returns a Locator directly with .first()).
        const fakePage = {
            locator: () => ({ first: () => firstLoc, fill: firstLoc.fill, press: firstLoc.press }),
        };
        const r = await _executeTool(fakePage, 'pw_type', { selector: 'input', text: '{{USERNAME}}' }, {
            findings: [],
            sameOriginGuard: () => true,
            credentials: null,
        });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(filledWith, '{{USERNAME}}');
        assert.strictEqual(r.usedCredential, false);
    }

    console.log('✓ server/services/agentTestDriver.test.js — all assertions passed');
})().catch(err => {
    console.error('✗ agentTestDriver.test.js failed:', err);
    process.exit(1);
});
