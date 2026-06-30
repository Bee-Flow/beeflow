/**
 * umamiClient unit tests.
 *
 * configStore is pre-mocked via the require cache to return nothing, so the
 * client resolves its endpoint from env vars (no DB needed). global.fetch is
 * stubbed per-test to assert request shape + exercise the find-or-create and
 * auth paths.
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// No DB in tests — config reads return empty so env vars drive the client.
mock('../stores/configStore', {
    getConfig: async () => null,
    getSecret: async () => '',
});

const umami = require('./umamiClient');

const origFetch = global.fetch;

// Install a fetch stub that records calls and replies from `handler`.
function stubFetch(handler) {
    const calls = [];
    global.fetch = async (url, opts = {}) => {
        calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers || {} });
        const r = handler({ url: String(url), opts }) || {};
        const status = r.status ?? 200;
        const payload = r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? '');
        return { ok: status >= 200 && status < 300, status, text: async () => payload };
    };
    return calls;
}

function resetEnv({ token } = {}) {
    process.env.UMAMI_URL = 'http://umami.test';
    process.env.UMAMI_USERNAME = 'admin';
    process.env.UMAMI_PASSWORD = 'secret';
    if (token) process.env.UMAMI_API_TOKEN = token;
    else delete process.env.UMAMI_API_TOKEN;
    umami.invalidateEndpointCache();
}

test.afterEach(() => { global.fetch = origFetch; });

test('isConfigured() true when url + api token present', async () => {
    resetEnv({ token: 'tok123' });
    stubFetch(() => ({ json: {} }));
    assert.equal(await umami.isConfigured(), true);
});

test('isConfigured() false when url missing', async () => {
    process.env.UMAMI_URL = '';
    process.env.UMAMI_API_TOKEN = 'tok';
    umami.invalidateEndpointCache();
    assert.equal(await umami.isConfigured(), false);
});

test('api token is sent as Bearer (no login round-trip)', async () => {
    resetEnv({ token: 'tok123' });
    const calls = stubFetch(({ url }) => {
        if (url.includes('/stats')) return { json: { pageviews: { value: 5 }, visitors: { value: 3 } } };
        return { json: {} };
    });
    const stats = await umami.getStats('w1', { startAt: 1000, endAt: 2000 });
    assert.equal(stats.pageviews.value, 5);
    // No login call when an api token is configured.
    assert.equal(calls.some(c => c.url.includes('/api/auth/login')), false);
    const statsCall = calls.find(c => c.url.includes('/stats'));
    assert.ok(statsCall.url.includes('/api/websites/w1/stats'));
    assert.ok(statsCall.url.includes('startAt=1000') && statsCall.url.includes('endAt=2000'));
    assert.equal(statsCall.headers.Authorization, 'Bearer tok123');
});

test('ensureWebsite reuses an existing website matched by domain', async () => {
    resetEnv({ token: 'tok123' });
    const calls = stubFetch(({ url, opts }) => {
        if (url.includes('/api/websites') && (opts.method || 'GET') === 'GET') {
            return { json: { data: [{ id: 'w-existing', domain: 'acme.com' }] } };
        }
        return { json: { id: 'should-not-be-created' } };
    });
    const id = await umami.ensureWebsite({ name: 'Acme', domain: 'https://Acme.com/' });
    assert.equal(id, 'w-existing');
    // Must NOT have POSTed a new website.
    assert.equal(calls.some(c => c.method === 'POST'), false);
});

test('ensureWebsite creates a website when none matches', async () => {
    resetEnv({ token: 'tok123' });
    const calls = stubFetch(({ url, opts }) => {
        if (url.includes('/api/websites') && (opts.method || 'GET') === 'GET') return { json: { data: [] } };
        if (url.includes('/api/websites') && opts.method === 'POST') return { json: { id: 'w-new', domain: 'new.com' } };
        return { json: {} };
    });
    const id = await umami.ensureWebsite({ name: 'New site', domain: 'new.com' });
    assert.equal(id, 'w-new');
    const post = calls.find(c => c.method === 'POST');
    assert.ok(post, 'expected a POST to create the website');
    assert.equal(post.body.domain, 'new.com');
});

test('username/password path logs in and caches the token', async () => {
    resetEnv(); // no api token → login flow
    let loginCount = 0;
    const calls = stubFetch(({ url }) => {
        if (url.includes('/api/auth/login')) { loginCount++; return { json: { token: 'jwt-abc' } }; }
        if (url.includes('/active')) return { json: [{ x: 7 }] };
        return { json: {} };
    });
    await umami.getActive('w1');
    await umami.getActive('w1'); // second call reuses the cached token
    assert.equal(loginCount, 1, 'should log in once and reuse the token');
    const activeCall = calls.find(c => c.url.includes('/active'));
    assert.equal(activeCall.headers.Authorization, 'Bearer jwt-abc');
});

test('metrics builds the typed breakdown URL', async () => {
    resetEnv({ token: 'tok123' });
    const calls = stubFetch(() => ({ json: [{ x: '/', y: 12 }] }));
    const rows = await umami.getMetrics('w9', { type: 'url', startAt: 1, endAt: 2, limit: 5 });
    assert.deepEqual(rows, [{ x: '/', y: 12 }]);
    const c = calls[0];
    assert.ok(c.url.includes('/api/websites/w9/metrics'));
    assert.ok(c.url.includes('type=url') && c.url.includes('limit=5'));
});
