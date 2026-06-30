/**
 * Unit tests for the AFAS Profit tool module.
 *
 * Run: node integrations/afasTools.test.js
 *
 * No network/DB needed — `configStore` is stubbed (same trick as
 * firefliesTools.test.js) and `global.fetch` is scripted per case.
 */

const assert = require('assert');

// Stub configStore before requiring the module under test.
const SECRETS = {};
const configStorePath = require.resolve('../stores/configStore');
require.cache[configStorePath] = {
    id: configStorePath,
    filename: configStorePath,
    loaded: true,
    exports: {
        getSecret: async (key) => SECRETS[key] ?? null,
    },
};

const {
    executeAfasTool,
    isAfasTool,
    buildBaseUrl,
    normalizeAfasToken,
    buildAuthHeader,
    buildFilterParams,
    buildOrderByParam,
    truncateRows,
    extractAfasErrorMessage,
} = require('./afasTools');

const HEX = '979D703A5D92417998F36ECE577E10CD2822304B4E687A46AAB4598889FA5804';
const XML = `<token><version>1</version><data>${HEX}</data></token>`;

function setCreds(userId, { token = HEX, member = '12345', env = 'production' } = {}) {
    SECRETS[`afas_token_user_${userId}`] = token;
    SECRETS[`afas_member_number_user_${userId}`] = member;
    SECRETS[`afas_env_type_user_${userId}`] = env;
}

// ── fetch stub ─────────────────────────────────────────────────────────
let fetchCalls = [];
function scriptFetch(responses) {
    // responses: one { ok, status, json | text } per expected request, in order.
    fetchCalls = [];
    global.fetch = async (url, opts) => {
        fetchCalls.push({ url, opts });
        const r = responses[fetchCalls.length - 1];
        if (r === undefined) throw new Error(`Unexpected upstream request #${fetchCalls.length}: ${url}`);
        return {
            ok: r.ok !== false,
            status: r.status || 200,
            json: async () => r.json,
            text: async () => r.text ?? JSON.stringify(r.json ?? {}),
        };
    };
}

(async () => {
    // ── buildBaseUrl ──────────────────────────────────────────────────
    assert.strictEqual(buildBaseUrl('12345', 'production'), 'https://12345.rest.afas.online/profitrestservices');
    assert.strictEqual(buildBaseUrl('12345', 'test'), 'https://12345.resttest.afas.online/profitrestservices');
    assert.strictEqual(buildBaseUrl('12345', 'accept'), 'https://12345.restaccept.afas.online/profitrestservices');
    assert.strictEqual(buildBaseUrl(' 12345 ', undefined), 'https://12345.rest.afas.online/profitrestservices', 'default env is production, number trimmed');
    for (const bad of ['12345; rm', '12.attacker.com', '', 'abc', '12345678901', '12345.evil', null]) {
        assert.throws(() => buildBaseUrl(bad, 'production'), /member number/, `rejects member number: ${JSON.stringify(bad)}`);
    }
    assert.throws(() => buildBaseUrl('12345', 'evil.host/'), /environment type/, 'rejects unknown env type');

    // ── normalizeAfasToken ────────────────────────────────────────────
    assert.strictEqual(normalizeAfasToken(XML), XML, 'canonical XML passes through');
    assert.strictEqual(normalizeAfasToken(`  ${XML}  `), XML, 'XML is trimmed');
    assert.strictEqual(normalizeAfasToken(HEX.toLowerCase()), XML, 'bare hex is wrapped and uppercased');
    assert.strictEqual(normalizeAfasToken(`${HEX.slice(0, 32)} ${HEX.slice(32)}`), XML, 'whitespace inside hex tolerated');
    for (const bad of ['', null, 'not-a-token', '<token><data>zz</data></token>', 'abc123', `<token><version>1</version><data>XYZ</data></token>`]) {
        assert.strictEqual(normalizeAfasToken(bad), null, `rejects token: ${JSON.stringify(bad)}`);
    }

    // ── buildAuthHeader ───────────────────────────────────────────────
    assert.strictEqual(buildAuthHeader(HEX), `AfasToken ${Buffer.from(XML, 'utf8').toString('base64')}`);
    assert.throws(() => buildAuthHeader('garbage'), /AppConnector token/);

    // ── buildFilterParams ─────────────────────────────────────────────
    assert.strictEqual(buildFilterParams(undefined), null);
    assert.strictEqual(buildFilterParams([]), null);
    {
        const p = buildFilterParams([
            { field: 'ItemCode', operator: 'equals', value: 'A1' },
            { field: 'Name', operator: 'contains', value: 'bee' },
            { field: 'Modified', operator: 'greater_or_equal', value: '2026-01-01' },
            { field: 'Note', operator: 'empty' },
        ]);
        assert.deepStrictEqual(p, {
            filterfieldids: 'ItemCode,Name,Modified,Note',
            filtervalues: 'A1,bee,2026-01-01,',
            operatortypes: '1,6,2,8',
        });
    }
    assert.deepStrictEqual(
        buildFilterParams([{ field: 'X', value: 'y' }]).operatortypes, '1',
        'operator defaults to equals');
    // All operator names map to their AFAS codes.
    {
        const names = ['equals', 'greater_or_equal', 'less_or_equal', 'greater_than', 'less_than', 'contains', 'not_equals', 'empty', 'not_empty', 'starts_with', 'ends_with'];
        const p = buildFilterParams(names.map(op => ({ field: 'F', operator: op, value: 'v' })));
        assert.strictEqual(p.operatortypes, '1,2,3,4,5,6,7,8,9,10,13');
    }
    assert.throws(() => buildFilterParams([{ field: 'A', operator: 'like', value: 'x' }]), /Unknown filter operator/);
    assert.throws(() => buildFilterParams([{ field: 'A', value: 'x,y' }]), /may not contain/);
    assert.throws(() => buildFilterParams([{ field: 'A', value: 'x;y' }]), /may not contain/);
    assert.throws(() => buildFilterParams([{ field: 'A;B', value: 'x' }]), /Invalid filter field/);
    assert.throws(() => buildFilterParams([{ field: '', value: 'x' }]), /Invalid filter field/);
    assert.throws(() => buildFilterParams([{ field: 'A=1&take', value: 'x' }]), /Invalid filter field/);

    // ── buildOrderByParam ─────────────────────────────────────────────
    assert.strictEqual(buildOrderByParam(undefined), null);
    assert.strictEqual(buildOrderByParam([{ field: 'A' }, { field: 'B', direction: 'desc' }]), 'A,-B');
    assert.throws(() => buildOrderByParam([{ field: 'A;B' }]), /Invalid orderBy field/);

    // ── truncateRows ──────────────────────────────────────────────────
    {
        const small = [{ a: 1 }, { a: 2 }];
        assert.deepStrictEqual(truncateRows(small, 1000), { rows: small, truncated: false });
        const big = Array.from({ length: 100 }, (_, i) => ({ i, pad: 'x'.repeat(100) }));
        const r = truncateRows(big, 2000);
        assert.strictEqual(r.truncated, true);
        assert.ok(r.rows.length > 0 && r.rows.length < 100);
        assert.ok(JSON.stringify(r.rows).length <= 2000);
        const oneHuge = [{ blob: 'x'.repeat(5000) }];
        assert.deepStrictEqual(truncateRows(oneHuge, 100), { rows: [], truncated: true }, 'a single oversized row is dropped');
    }

    // ── extractAfasErrorMessage ───────────────────────────────────────
    assert.strictEqual(extractAfasErrorMessage('<error><message>Veld bestaat niet</message></error>'), 'Veld bestaat niet');
    assert.strictEqual(extractAfasErrorMessage('{"externalMessage":"Geen rechten"}'), 'Geen rechten');
    assert.strictEqual(extractAfasErrorMessage('<html><body>huge dump</body></html>'), null, 'unstructured bodies are not surfaced');
    assert.strictEqual(extractAfasErrorMessage(`<message>${'x'.repeat(500)}</message>`).length, 300, 'capped at 300 chars');

    // ── executeAfasTool: not configured / unknown tool ────────────────
    assert.deepStrictEqual(await executeAfasTool('afas_query', {}, null), { error: 'User context required for AFAS Profit.' });
    assert.ok((await executeAfasTool('afas_query', { connectorId: 'X' }, 'nobody')).error.includes('not configured'));
    setCreds('u1');
    assert.ok((await executeAfasTool('afas_nope', {}, 'u1')).error.includes('Unknown AFAS tool'));

    // ── afas_list_connectors ──────────────────────────────────────────
    scriptFetch([{ json: { getConnectors: [{ id: 'Profit_Article', description: 'Artikelen' }, { id: 'Custom_HR' }], updateConnectors: [] } }]);
    {
        const r = await executeAfasTool('afas_list_connectors', {}, 'u1');
        assert.strictEqual(fetchCalls.length, 1);
        assert.strictEqual(fetchCalls[0].url, 'https://12345.rest.afas.online/profitrestservices/metainfo');
        assert.strictEqual(fetchCalls[0].opts.redirect, 'error', 'redirects are refused');
        assert.strictEqual(fetchCalls[0].opts.headers.Authorization, buildAuthHeader(HEX));
        assert.deepStrictEqual(r.connectors, [
            { id: 'Profit_Article', description: 'Artikelen' },
            { id: 'Custom_HR', description: '' },
        ]);
        assert.strictEqual(r.truncated, undefined);
    }
    // List cap.
    scriptFetch([{ json: { getConnectors: Array.from({ length: 250 }, (_, i) => ({ id: `C${i}` })) } }]);
    {
        const r = await executeAfasTool('afas_list_connectors', {}, 'u1');
        assert.strictEqual(r.connectors.length, 200);
        assert.strictEqual(r.truncated, true);
        assert.strictEqual(r.total, 250);
    }

    // ── afas_describe_connector ───────────────────────────────────────
    scriptFetch([{ json: { fields: [{ id: 'ItemCode', label: 'Artikelcode', dataType: 'string', length: 20 }] } }]);
    {
        const r = await executeAfasTool('afas_describe_connector', { connectorId: 'Profit_Article' }, 'u1');
        assert.strictEqual(fetchCalls[0].url, 'https://12345.rest.afas.online/profitrestservices/metainfo/get/Profit_Article');
        assert.deepStrictEqual(r.fields, [{ id: 'ItemCode', label: 'Artikelcode', dataType: 'string', length: 20 }]);
    }
    {
        const r = await executeAfasTool('afas_describe_connector', { connectorId: '../otherpath' }, 'u1');
        assert.ok(r.error.includes('Invalid connectorId'));
        const r2 = await executeAfasTool('afas_describe_connector', { connectorId: 'a/b' }, 'u1');
        assert.ok(r2.error.includes('Invalid connectorId'));
    }

    // ── afas_query: URL assembly ──────────────────────────────────────
    setCreds('u2', { token: XML, member: '99', env: 'test' });
    scriptFetch([{ json: { skip: 5, take: 2, rows: [{ a: 1 }, { a: 2 }] } }]);
    {
        const r = await executeAfasTool('afas_query', {
            connectorId: 'Custom_HR',
            skip: 5,
            take: 2,
            filters: [{ field: 'Name', operator: 'contains', value: 'bee' }],
            orderBy: [{ field: 'Name', direction: 'desc' }],
        }, 'u2');
        const u = new URL(fetchCalls[0].url);
        assert.strictEqual(u.origin, 'https://99.resttest.afas.online');
        assert.strictEqual(u.pathname, '/profitrestservices/connectors/Custom_HR');
        assert.strictEqual(u.searchParams.get('skip'), '5');
        assert.strictEqual(u.searchParams.get('take'), '2');
        assert.strictEqual(u.searchParams.get('filterfieldids'), 'Name');
        assert.strictEqual(u.searchParams.get('filtervalues'), 'bee');
        assert.strictEqual(u.searchParams.get('operatortypes'), '6');
        assert.strictEqual(u.searchParams.get('orderbyfieldids'), '-Name');
        assert.strictEqual(r.count, 2);
        assert.strictEqual(r.hasMore, true, 'rows.length === take means there may be more');
    }
    // take clamped to 100, skip floored at 0.
    scriptFetch([{ json: { rows: [] } }]);
    {
        const r = await executeAfasTool('afas_query', { connectorId: 'C', take: 5000, skip: -3 }, 'u1');
        const u = new URL(fetchCalls[0].url);
        assert.strictEqual(u.searchParams.get('take'), '100');
        assert.strictEqual(u.searchParams.get('skip'), '0');
        assert.strictEqual(r.hasMore, false);
    }
    // Filter validation errors come back as tool errors, before any fetch.
    scriptFetch([]);
    {
        const r = await executeAfasTool('afas_query', { connectorId: 'C', filters: [{ field: 'A', value: 'x;y' }] }, 'u1');
        assert.ok(r.error.includes('may not contain'));
        assert.strictEqual(fetchCalls.length, 0, 'no upstream request on invalid filters');
    }

    // ── error mapping: no body/URL leakage ────────────────────────────
    scriptFetch([{ ok: false, status: 401, text: '<html>full secret dump https://evil</html>' }]);
    {
        const r = await executeAfasTool('afas_query', { connectorId: 'C' }, 'u1');
        assert.ok(r.error.includes('invalid or has been revoked'), r.error);
        assert.ok(!r.error.includes('evil'), 'raw body never surfaces');
        assert.ok(!r.error.includes('12345'), 'request URL never surfaces');
    }
    scriptFetch([{ ok: false, status: 403, text: '{"externalMessage":"Geen rechten op connector"}' }]);
    {
        const r = await executeAfasTool('afas_query', { connectorId: 'C' }, 'u1');
        assert.ok(r.error.includes('lacks rights'), r.error);
        assert.ok(r.error.includes('Geen rechten op connector'), 'structured AFAS message is surfaced');
    }
    scriptFetch([{ ok: false, status: 500, text: '<error><message>Index veld onbekend</message></error>' }]);
    {
        const r = await executeAfasTool('afas_query', { connectorId: 'C' }, 'u1');
        assert.ok(r.error.includes('HTTP 500'));
        assert.ok(r.error.includes('Index veld onbekend'));
    }

    // ── oversized response truncation ─────────────────────────────────
    scriptFetch([{ json: { rows: Array.from({ length: 100 }, (_, i) => ({ i, pad: 'x'.repeat(1000) })) } }]);
    {
        const r = await executeAfasTool('afas_query', { connectorId: 'C', take: 100 }, 'u1');
        assert.strictEqual(r.truncated, true);
        assert.ok(r.rows.length < 100);
        assert.ok(r.message.includes('Narrow with filters'));
    }

    // ── isAfasTool ────────────────────────────────────────────────────
    assert.ok(isAfasTool('afas_query') && isAfasTool('afas_list_connectors') && isAfasTool('afas_describe_connector'));
    assert.ok(!isAfasTool('afas_update') && !isAfasTool('youtrack_get_issue'));

    console.log('afasTools.test.js: all tests passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
