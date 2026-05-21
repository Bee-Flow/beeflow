/**
 * Unit tests for the testGenerator service.
 *
 * Covers the source-fetch + LLM-output-parsing logic without touching DB,
 * GitHub, YouTrack, or any LLM. Run:
 *
 *   node server/services/testGenerator.test.js
 */

const assert = require('assert');

// Stub out the upstream modules so requiring testGenerator never hits a real
// network / DB. The stubs are swappable per-test by reassigning their fields.
const githubStub = { executeGitHubTool: async () => ({ error: 'no_call_recorded' }) };
const youtrackStub = { executeYouTrackTool: async () => ({ error: 'no_call_recorded' }) };
const conversationsStub = { getConversationById: async () => null };
const aiAgentStub = { getAIConfig: async () => ({ url: '', apiKey: '', model: '' }) };

require.cache[require.resolve('../integrations/githubTools')] = { exports: githubStub };
require.cache[require.resolve('../integrations/youtrackTools')] = { exports: youtrackStub };
require.cache[require.resolve('../stores/agent/agentConversations')] = { exports: conversationsStub };
require.cache[require.resolve('../core/aiAgent')] = { exports: aiAgentStub };

const { _internals, generate } = require('./testGenerator');
const { fetchSources, _buildUserMessage, _extractCode, _extractManifest } = _internals;

(async () => {
    // ── fetchSources: text + url pass-through ─────────────────────
    {
        const { collected, errors } = await fetchSources([
            { type: 'text', label: 'Spec', body: 'Login should reject empty email.' },
            { type: 'url', url: 'https://example.com/login' },
        ], 'u1');
        assert.strictEqual(errors.length, 0);
        assert.strictEqual(collected.length, 2);
        assert.strictEqual(collected[0].kind, 'text');
        assert.strictEqual(collected[1].kind, 'target_url');
    }

    // ── fetchSources: missing GitHub integration surfaces structured error ─
    {
        githubStub.executeGitHubTool = async () => ({ error: 'No GitHub token configured' });
        const { errors } = await fetchSources([
            { type: 'github_file', owner: 'a', repo: 'b', path: 'src/x.ts' },
        ], 'u1');
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(errors[0].error, 'missing_integration');
        assert.strictEqual(errors[0].integration, 'github');
    }

    // ── fetchSources: GitHub file body normalized ─────────────────
    {
        githubStub.executeGitHubTool = async (tool, args) => {
            assert.strictEqual(tool, 'github_get_file');
            assert.strictEqual(args.path, 'src/x.ts');
            return { content: 'export const X = 1;', path: 'src/x.ts' };
        };
        const { collected, errors } = await fetchSources([
            { type: 'github_file', owner: 'a', repo: 'b', path: 'src/x.ts' },
        ], 'u1');
        assert.strictEqual(errors.length, 0);
        assert.strictEqual(collected.length, 1);
        assert.strictEqual(collected[0].kind, 'github_file');
        assert.match(collected[0].body, /export const X/);
    }

    // ── fetchSources: YouTrack issue + missing integration ────────
    {
        youtrackStub.executeYouTrackTool = async () => ({ error: 'YouTrack not configured' });
        const { errors } = await fetchSources([
            { type: 'youtrack', issueId: 'P-1' },
        ], 'u1');
        assert.strictEqual(errors[0].error, 'missing_integration');
        assert.strictEqual(errors[0].integration, 'youtrack');
    }

    // ── _buildUserMessage shape ──────────────────────────────────
    {
        const msg = _buildUserMessage(
            [{ kind: 'text', title: 'Spec', body: 'Hello' }],
            { targetUrl: 'https://x.test' }
        );
        assert.match(msg, /Source 1 \(text\) — Spec/);
        assert.match(msg, /Target URL .*https:\/\/x\.test/);
        assert.match(msg, /typescript code block/);
    }

    // ── _extractCode + _extractManifest ───────────────────────────
    {
        const raw = "```typescript\nimport { test } from '@playwright/test';\ntest('a', () => {});\n```\n\n```json\n{\"items\":[{\"name\":\"a\"}]}\n```";
        const code = _extractCode(raw);
        assert.match(code, /import \{ test \}/);
        const manifest = _extractManifest(raw);
        assert.deepStrictEqual(manifest, [{ name: 'a' }]);
    }
    {
        // Manifest may be { items: [...] } OR a bare array — both supported.
        const arr = _extractManifest('```json\n[{"name":"x"}]\n```');
        assert.deepStrictEqual(arr, [{ name: 'x' }]);
    }
    {
        // Missing code block returns null.
        assert.strictEqual(_extractCode('no fences here'), null);
        assert.deepStrictEqual(_extractManifest('no fences here'), []);
    }

    // ── generate(): no sources → error ────────────────────────────
    {
        const r = await generate('u1', [], {});
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'no_sources');
    }

    // ── generate(): missing integration short-circuits before LLM ─
    {
        githubStub.executeGitHubTool = async () => ({ error: 'No GitHub token configured' });
        const r = await generate('u1', [{ type: 'github_file', owner: 'a', repo: 'b', path: 'x' }], {});
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'missing_integration');
        assert.strictEqual(r.integration, 'github');
    }

    // ── generate(): all sources fail → no_sources ─────────────────
    {
        // Restore github stub so it returns a generic fetch_failed (not missing
        // integration) so we exercise the "all failed" path rather than the
        // short-circuit.
        githubStub.executeGitHubTool = async () => ({ error: 'unexpected upstream 500' });
        const r = await generate('u1', [{ type: 'github_file', owner: 'a', repo: 'b', path: 'x' }], {});
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'no_sources');
    }

    // ── generate(): LLM not configured ────────────────────────────
    {
        aiAgentStub.getAIConfig = async () => ({ url: '', apiKey: '', model: '' });
        const r = await generate('u1', [{ type: 'text', label: 't', body: 'spec' }], {});
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'llm_not_configured');
    }

    // ── generate(): happy path mocked LLM ─────────────────────────
    {
        // Stub global fetch for this assertion only.
        const origFetch = global.fetch;
        global.fetch = async () => ({
            ok: true,
            json: async () => ({
                choices: [{
                    message: {
                        content: "```typescript\nimport { test, expect } from '@playwright/test';\ntest('smoke', async ({ page }) => { await page.goto('/'); });\n```\n```json\n{\"items\":[{\"name\":\"smoke\",\"category\":\"functionality\"}]}\n```",
                    },
                }],
            }),
        });
        aiAgentStub.getAIConfig = async () => ({ url: 'https://api.example.com', apiKey: 'sk', model: 'm' });
        try {
            const r = await generate('u1', [{ type: 'text', label: 'Spec', body: 'login' }], {});
            assert.strictEqual(r.ok, true);
            assert.match(r.playwrightCode, /test\('smoke'/);
            assert.deepStrictEqual(r.manifest, [{ name: 'smoke', category: 'functionality' }]);
            assert.strictEqual(r.modelUsed, 'm');
        } finally {
            global.fetch = origFetch;
        }
    }

    console.log('✓ server/services/testGenerator.test.js — all assertions passed');
})().catch(err => {
    console.error('✗ testGenerator.test.js failed:', err);
    process.exit(1);
});
