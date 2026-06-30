/**
 * Unit tests for the open MCP Registry client + install-config mapper.
 *
 * Run: node integrations/mcpRegistryClient.test.js
 *
 * Pure module — no DB. `global.fetch` is scripted per case (same trick as
 * afasTools.test.js).
 */

const assert = require('assert');

const {
    searchOfficial,
    registryEntryToInstallConfig,
    isActiveLatest,
    pickPackage,
    argTokens,
    credsFromEnv,
    humanize,
    identWithVersion,
} = require('./mcpRegistryClient');

// ── fetch stub ──────────────────────────────────────────────────────────
let fetchCalls = [];
function scriptFetch(responses) {
    fetchCalls = [];
    global.fetch = async (url, opts) => {
        fetchCalls.push({ url, opts });
        const r = responses[fetchCalls.length - 1];
        if (r === undefined) throw new Error(`Unexpected request #${fetchCalls.length}: ${url}`);
        return {
            ok: r.ok !== false,
            status: r.status || 200,
            json: async () => r.json,
            text: async () => r.text ?? JSON.stringify(r.json ?? {}),
        };
    };
}

const meta = (overrides = {}) => ({
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true, ...overrides } },
});

(async () => {
    // ── humanize ──────────────────────────────────────────────────────
    assert.strictEqual(humanize('GITHUB_PERSONAL_ACCESS_TOKEN'), 'Github Personal Access Token');
    assert.strictEqual(humanize('dataforseo_password'), 'Dataforseo Password');
    assert.strictEqual(humanize(''), '');

    // ── identWithVersion ──────────────────────────────────────────────
    assert.strictEqual(identWithVersion({ identifier: 'pkg', version: '1.2.3' }), 'pkg@1.2.3');
    assert.strictEqual(identWithVersion({ identifier: 'pkg', version: 'latest' }), 'pkg', 'latest is not pinned');
    assert.strictEqual(identWithVersion({ identifier: 'pkg' }), 'pkg', 'no version → bare identifier');

    // ── pickPackage preference npm → pypi → oci ───────────────────────
    assert.strictEqual(pickPackage([{ registryType: 'pypi' }, { registryType: 'npm' }]).registryType, 'npm');
    assert.strictEqual(pickPackage([{ registryType: 'oci' }, { registryType: 'pypi' }]).registryType, 'pypi');
    assert.strictEqual(pickPackage([{ registryType: 'oci' }]).registryType, 'oci');
    assert.strictEqual(pickPackage([]), null);
    assert.strictEqual(pickPackage(undefined), null);

    // ── argTokens ─────────────────────────────────────────────────────
    assert.deepStrictEqual(argTokens(['a', 'b']), ['a', 'b'], 'bare strings pass through');
    assert.deepStrictEqual(argTokens([{ type: 'positional', value: '/data' }]), ['/data']);
    assert.deepStrictEqual(argTokens([{ type: 'named', name: '--port', value: '8080' }]), ['--port', '8080']);
    assert.deepStrictEqual(argTokens([{ type: 'named', name: '--flag' }]), ['--flag'], 'named flag w/o value');
    assert.deepStrictEqual(argTokens([{ type: 'positional', default: 'def' }]), ['def'], 'falls back to default');
    assert.deepStrictEqual(argTokens(undefined), []);

    // ── credsFromEnv filters to secret/required only ──────────────────
    const creds = credsFromEnv([
        { name: 'API_KEY', isSecret: true },
        { name: 'REQUIRED_HOST', isRequired: true },
        { name: 'OPTIONAL', isSecret: false, isRequired: false },
        { name: 'SNAKE', is_secret: true },
        { noName: true },
    ]);
    assert.deepStrictEqual(creds, [
        { key: 'API_KEY', label: 'Api Key' },
        { key: 'REQUIRED_HOST', label: 'Required Host' },
        { key: 'SNAKE', label: 'Snake' },
    ]);

    // ── registryEntryToInstallConfig: npm ─────────────────────────────
    {
        const cfg = registryEntryToInstallConfig({
            server: {
                name: 'io.example/server', title: 'Example', description: 'demo',
                version: '2.0.0',
                repository: { url: 'https://github.com/example/server' },
                packages: [{
                    registryType: 'npm', identifier: '@example/mcp', version: '2.0.0',
                    packageArguments: [{ type: 'positional', value: '/tmp' }],
                    environmentVariables: [{ name: 'TOKEN', isSecret: true }, { name: 'NOPE' }],
                }],
            },
            ...meta(),
        });
        assert.strictEqual(cfg.transport, 'stdio');
        assert.strictEqual(cfg.command, 'npx');
        assert.deepStrictEqual(cfg.args, ['-y', '@example/mcp@2.0.0', '/tmp']);
        assert.deepStrictEqual(cfg.required_credentials, [{ key: 'TOKEN', label: 'Token' }]);
        assert.strictEqual(cfg.repository, 'https://github.com/example/server');
        assert.strictEqual(cfg.source, 'registry');
        assert.strictEqual(cfg.installable, true);
        assert.strictEqual(cfg.verified, true);
        assert.strictEqual(cfg.name, 'Example');
    }

    // ── pypi → uvx ────────────────────────────────────────────────────
    {
        const cfg = registryEntryToInstallConfig({
            server: { name: 'x', title: 'Py', packages: [{ registryType: 'pypi', identifier: 'mcp-thing', version: '1.0.0' }] },
            ...meta(),
        });
        assert.strictEqual(cfg.command, 'uvx');
        assert.deepStrictEqual(cfg.args, ['mcp-thing@1.0.0']);
    }

    // ── oci → docker ──────────────────────────────────────────────────
    {
        const cfg = registryEntryToInstallConfig({
            server: { name: 'x', title: 'Oci', packages: [{ registryType: 'oci', identifier: 'ghcr.io/x/y:1' }] },
            ...meta(),
        });
        assert.strictEqual(cfg.command, 'docker');
        assert.deepStrictEqual(cfg.args, ['run', '-i', '--rm', 'ghcr.io/x/y:1']);
    }

    // ── remote-only → http ────────────────────────────────────────────
    {
        const cfg = registryEntryToInstallConfig({
            server: {
                name: 'x', title: 'Remote',
                remotes: [{ type: 'sse', url: 'https://a/sse' }, { type: 'streamable-http', url: 'https://a/mcp' }],
            },
            ...meta(),
        });
        assert.strictEqual(cfg.transport, 'http');
        assert.strictEqual(cfg.url, 'https://a/mcp', 'prefers streamable-http remote');
        assert.strictEqual(cfg.command, null);
        assert.deepStrictEqual(cfg.required_credentials, []);
    }

    // ── unmappable → viewOnly ─────────────────────────────────────────
    {
        const cfg = registryEntryToInstallConfig({ server: { name: 'x', title: 'Empty' }, ...meta() });
        assert.strictEqual(cfg.installable, false);
        assert.strictEqual(cfg.viewOnly, true);
        assert.strictEqual(cfg.reason, 'no_installable_package');
    }

    // ── garbage / verified flag ───────────────────────────────────────
    assert.strictEqual(registryEntryToInstallConfig({ server: {} }), null, 'no name → null');
    assert.strictEqual(registryEntryToInstallConfig(null), null);
    {
        const cfg = registryEntryToInstallConfig({ server: { name: 'x', title: 'Del', packages: [{ registryType: 'npm', identifier: 'p' }] }, ...meta({ status: 'deleted' }) });
        assert.strictEqual(cfg.verified, false, 'non-active status → not verified');
    }

    // ── isActiveLatest ────────────────────────────────────────────────
    assert.strictEqual(isActiveLatest(meta()), true);
    assert.strictEqual(isActiveLatest(meta({ status: 'deprecated' })), false);
    assert.strictEqual(isActiveLatest(meta({ isLatest: false })), false);
    assert.strictEqual(isActiveLatest({}), false);

    // ── searchOfficial: URL assembly + pagination parsing ─────────────
    scriptFetch([{ json: { servers: [{ server: { name: 'a' } }], metadata: { next_cursor: 'CUR2' } } }]);
    {
        const r = await searchOfficial({ q: 'seo', cursor: 'CUR1', limit: 25 });
        const u = new URL(fetchCalls[0].url);
        assert.strictEqual(u.origin + u.pathname, 'https://registry.modelcontextprotocol.io/v0/servers');
        assert.strictEqual(u.searchParams.get('search'), 'seo');
        assert.strictEqual(u.searchParams.get('cursor'), 'CUR1');
        assert.strictEqual(u.searchParams.get('limit'), '25');
        assert.strictEqual(r.servers.length, 1);
        assert.strictEqual(r.nextCursor, 'CUR2');
    }
    // No next cursor → null. Also tolerate camelCase nextCursor at top level.
    scriptFetch([{ json: { servers: [], nextCursor: 'TOP' } }]);
    {
        const r = await searchOfficial({});
        assert.strictEqual(r.nextCursor, 'TOP');
        assert.deepStrictEqual(r.servers, []);
    }
    // Upstream error surfaces.
    scriptFetch([{ ok: false, status: 503 }]);
    await assert.rejects(() => searchOfficial({}), /HTTP 503/);

    console.log('mcpRegistryClient.test.js: all tests passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
