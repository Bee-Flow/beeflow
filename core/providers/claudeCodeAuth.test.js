const test = require('node:test');
const assert = require('node:assert');
const ccoa = require('./claudeCodeAuth');
const ClaudeProvider = require('./claude');

test('needsRefresh: false when the token is comfortably valid', () => {
    assert.equal(ccoa.needsRefresh({ refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }), false);
});

test('needsRefresh: true when expired or within the skew window', () => {
    assert.equal(ccoa.needsRefresh({ refreshToken: 'r', expiresAt: Date.now() - 1 }), true);
    assert.equal(ccoa.needsRefresh({ refreshToken: 'r', expiresAt: Date.now() + 1_000 }), true); // < 60s skew
});

test('needsRefresh: false without a refresh token (nothing to refresh with)', () => {
    assert.equal(ccoa.needsRefresh({ expiresAt: Date.now() - 1 }), false);
});

test('_injectClaudeCodeIdentity prepends identity and preserves the existing breakpoint', () => {
    const p = new ClaudeProvider();
    const params = { system: [{ type: 'text', text: 'real prompt', cache_control: { type: 'ephemeral', ttl: '1h' } }] };
    p._injectClaudeCodeIdentity(params);
    assert.equal(params.system.length, 2);
    assert.match(params.system[0].text, /^You are Claude Code/);
    assert.equal(params.system[1].text, 'real prompt');
    assert.deepEqual(params.system[1].cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('_injectClaudeCodeIdentity creates a system array when none exists', () => {
    const p = new ClaudeProvider();
    const params = {};
    p._injectClaudeCodeIdentity(params);
    assert.equal(params.system.length, 1);
    assert.match(params.system[0].text, /^You are Claude Code/);
});

test('_injectClaudeCodeIdentity is idempotent', () => {
    const p = new ClaudeProvider();
    const params = { system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }] };
    p._injectClaudeCodeIdentity(params);
    assert.equal(params.system.length, 1);
});

test('_resolveAuth: plain api key stays in x-api-key mode', async () => {
    const p = new ClaudeProvider();
    const r = await p._resolveAuth('sk-ant-api03-abc');
    assert.deepEqual(r, { token: 'sk-ant-api03-abc', oauth: false });
});

test('_resolveAuth: a pasted oat token flips to oauth mode', async () => {
    const p = new ClaudeProvider();
    const r = await p._resolveAuth('sk-ant-oat01-abc');
    assert.equal(r.oauth, true);
    assert.equal(r.token, 'sk-ant-oat01-abc');
});

test('isExpired: false when valid, true within the skew window, false when unknown', () => {
    assert.equal(ccoa.isExpired({ expiresAt: Date.now() + 3_600_000 }), false);
    assert.equal(ccoa.isExpired({ expiresAt: Date.now() - 1 }), true);
    assert.equal(ccoa.isExpired({ expiresAt: Date.now() + 1_000 }), true); // < 60s skew
    assert.equal(ccoa.isExpired({}), false); // no expiresAt → assume usable
});

test('getAccessToken: returns the dedicated CLAUDE_CODE_OAUTH_TOKEN verbatim (no file read)', async () => {
    const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-dedicated-xyz';
    try {
        assert.equal(await ccoa.getAccessToken(), 'sk-ant-oat01-dedicated-xyz');
    } finally {
        if (prev === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev;
    }
});
