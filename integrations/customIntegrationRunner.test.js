/**
 * Unit tests for the custom-integration runner's pure helpers.
 *
 * Run: node integrations/customIntegrationRunner.test.js
 *
 * No DB needed — only the exported pure helpers are exercised (stores are
 * required lazily inside executeCustomIntegrationTool, never at load).
 */

const assert = require('assert');
const {
    isCustomIntegrationTool,
    parsePrefixedName,
    buildToolUrl,
    renderAuthValue,
    validateArgsAgainstSchema,
    scrubSecrets,
    truncateBudget,
    _internals,
} = require('./customIntegrationRunner');

// ── isCustomIntegrationTool ──────────────────────────────────────────────
{
    assert.strictEqual(isCustomIntegrationTool('cint_ab12cd34ef5_list_invoices'), true);
    assert.strictEqual(isCustomIntegrationTool('afas_query'), false);
    assert.strictEqual(isCustomIntegrationTool('cint'), false);
    assert.strictEqual(isCustomIntegrationTool(null), false);
}

// ── parsePrefixedName: good slugs ────────────────────────────────────────
{
    assert.deepStrictEqual(
        parsePrefixedName('cint_ab12cd34ef5_list_invoices'),
        { slug: 'ab12cd34ef5', toolName: 'list_invoices' },
        '11-char slug + snake_case tool'
    );
    assert.deepStrictEqual(
        parsePrefixedName('cint_a1b2_get_x'),
        { slug: 'a1b2', toolName: 'get_x' },
        'minimal 4-char slug'
    );
    assert.deepStrictEqual(
        parsePrefixedName('cint_abcdefgh12345678_who'),
        { slug: 'abcdefgh12345678', toolName: 'who' },
        'maximal 16-char slug + minimal 3-char tool'
    );
}

// ── parsePrefixedName: bad inputs ────────────────────────────────────────
{
    assert.strictEqual(parsePrefixedName('afas_query'), null, 'no cint_ prefix');
    assert.strictEqual(parsePrefixedName('cint_abcd'), null, 'no tool segment');
    assert.strictEqual(parsePrefixedName('cint_abcd_'), null, 'empty tool name');
    assert.strictEqual(parsePrefixedName('cint_ab_c_tool'), null, 'slug too short (2 chars — underscores split there)');
    assert.strictEqual(parsePrefixedName('cint_ABCD_tool'), null, 'uppercase slug');
    assert.strictEqual(parsePrefixedName('cint_abcdefgh123456789_tool'), null, '17-char slug too long');
    assert.strictEqual(parsePrefixedName('cint_ab12_9tool'), null, 'tool name starting with a digit');
    assert.strictEqual(parsePrefixedName('cint_ab12_ab'), null, 'tool name too short');
    assert.strictEqual(parsePrefixedName('cint_ab-d_tool'), null, 'slug with hyphen');
    assert.strictEqual(parsePrefixedName(undefined), null, 'non-string');
}

// ── buildToolUrl: substitution + literals + base path preserved ──────────
{
    const def = { api: { baseUrl: 'https://api.example.com/v2' } };
    const tool = {
        pathTemplate: '/invoices/{invoice_id}',
        query: { status: '{status}', expand: 'customer' },
    };
    const url = buildToolUrl(def, tool, { invoice_id: 'INV 7/1', status: 'open' });
    assert.strictEqual(url.origin, 'https://api.example.com', 'origin pinned');
    assert.strictEqual(url.pathname, '/v2/invoices/INV%207%2F1', 'base path kept; arg encoded (space + slash)');
    assert.strictEqual(url.searchParams.get('status'), 'open', 'placeholder query param substituted');
    assert.strictEqual(url.searchParams.get('expand'), 'customer', 'literal query param always sent');
}

// ── buildToolUrl: omitted optional query params ──────────────────────────
{
    const def = { api: { baseUrl: 'https://api.example.com' } };
    const tool = { pathTemplate: '/invoices', query: { status: '{status}', expand: 'customer', limit: 50 } };
    const url = buildToolUrl(def, tool, {});
    assert.strictEqual(url.searchParams.has('status'), false, 'absent arg → param omitted');
    assert.strictEqual(url.searchParams.get('expand'), 'customer', 'literal still present');
    assert.strictEqual(url.searchParams.get('limit'), '50', 'non-string literal stringified');
}

// ── buildToolUrl: array arg joins, special chars stay encoded ────────────
{
    const def = { api: { baseUrl: 'https://api.example.com' } };
    const tool = { pathTemplate: '/items/{id}', query: { ids: '{ids}' } };
    const url = buildToolUrl(def, tool, { id: 'a#b?c', ids: ['x', 'y'] });
    assert.strictEqual(url.hash, '', 'no fragment smuggled via arg');
    assert.ok(url.pathname.includes('a%23b%3Fc'), '# and ? percent-encoded in path');
    assert.strictEqual(url.searchParams.get('ids'), 'x,y', 'array arg comma-joined');
}

// ── buildToolUrl: hostile inputs rejected, origin pin holds ──────────────
{
    const def = { api: { baseUrl: 'https://api.example.com/v2' } };
    // traversal via arg value
    assert.throws(
        () => buildToolUrl(def, { pathTemplate: '/invoices/{invoice_id}' }, { invoice_id: '../admin' }),
        /traversal/, 'arg "../admin" rejected'
    );
    // '..' in the template itself
    assert.throws(
        () => buildToolUrl(def, { pathTemplate: '/a/../b' }, {}),
        /traversal/, "'..' template rejected"
    );
    // protocol-relative escape
    assert.throws(
        () => buildToolUrl(def, { pathTemplate: '//evil.com/x' }, {}),
        /invalid/, "'//evil.com' rejected"
    );
    // backslash escape ('/\evil.com' parses as '//evil.com' in WHATWG URLs)
    assert.throws(
        () => buildToolUrl(def, { pathTemplate: '/\\evil.com/x' }, {}),
        /invalid/, 'backslash path rejected'
    );
    // absolute URL in template
    assert.throws(
        () => buildToolUrl(def, { pathTemplate: 'https://evil.com/x' }, {}),
        /invalid/, 'absolute URL rejected'
    );
    // missing required path arg
    assert.throws(
        () => buildToolUrl(def, { pathTemplate: '/invoices/{invoice_id}' }, {}),
        /Missing required path parameter/, 'missing path arg rejected'
    );
    // query string / fragment in template
    assert.throws(() => buildToolUrl(def, { pathTemplate: '/a?x=1' }, {}), /invalid/);
    assert.throws(() => buildToolUrl(def, { pathTemplate: '/a#frag' }, {}), /invalid/);
}

// ── buildToolUrl: origin pin holds for benign calls ──────────────────────
{
    const def = { api: { baseUrl: 'https://api.example.com:8443/base/' } };
    const url = buildToolUrl(def, { pathTemplate: '/things' }, {});
    assert.strictEqual(url.origin, 'https://api.example.com:8443', 'port part of the pinned origin');
    assert.strictEqual(url.pathname, '/base/things', 'trailing base slash collapsed');
}

// ── validateArgsAgainstSchema ────────────────────────────────────────────
{
    const schema = {
        type: 'object',
        properties: {
            q: { type: 'string', enum: ['open', 'paid'] },
            note: { type: 'string' },
            n: { type: 'integer' },
            amt: { type: 'number' },
            flag: { type: 'boolean' },
            tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['q'],
    };

    // happy path
    let r = validateArgsAgainstSchema(schema, { q: 'open', n: 3, amt: 1.5, flag: true, tags: ['a', 'b'] });
    assert.strictEqual(r.ok, true, `valid args accepted: ${r.errors.join(' ')}`);

    // missing required
    r = validateArgsAgainstSchema(schema, {});
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('"q"')), 'missing required q reported');

    // unknown prop
    r = validateArgsAgainstSchema(schema, { q: 'open', nope: 1 });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('Unknown argument "nope"')), 'unknown prop rejected');

    // wrong types — never coerced
    assert.strictEqual(validateArgsAgainstSchema(schema, { q: 'open', n: '5' }).ok, false, 'string for integer rejected');
    assert.strictEqual(validateArgsAgainstSchema(schema, { q: 'open', n: 1.5 }).ok, false, 'float for integer rejected');
    assert.strictEqual(validateArgsAgainstSchema(schema, { q: 'open', flag: 'true' }).ok, false, 'string for boolean rejected');
    assert.strictEqual(validateArgsAgainstSchema(schema, { q: 'open', amt: 'x' }).ok, false, 'string for number rejected');
    assert.strictEqual(validateArgsAgainstSchema(schema, { q: 'open', note: null }).ok, false, 'null rejected');
    assert.strictEqual(validateArgsAgainstSchema(schema, { q: 'open', tags: 'a' }).ok, false, 'scalar for array rejected');
    assert.strictEqual(validateArgsAgainstSchema(schema, { q: 'open', tags: [1] }).ok, false, 'wrong item type rejected');

    // enum mismatch
    assert.strictEqual(validateArgsAgainstSchema(schema, { q: 'overdue' }).ok, false, 'enum mismatch rejected');

    // oversize string / array
    assert.strictEqual(validateArgsAgainstSchema(schema, { q: 'open', note: 'x'.repeat(2001) }).ok, false, 'string > 2000 rejected');
    assert.strictEqual(validateArgsAgainstSchema(schema, { q: 'open', note: 'x'.repeat(2000) }).ok, true, 'string == 2000 accepted');
    assert.strictEqual(validateArgsAgainstSchema(schema, { q: 'open', tags: Array(101).fill('a') }).ok, false, 'array > 100 rejected');
    assert.strictEqual(validateArgsAgainstSchema(schema, { q: 'open', tags: Array(100).fill('a') }).ok, true, 'array == 100 accepted');

    // non-object args
    assert.strictEqual(validateArgsAgainstSchema(schema, ['x']).ok, false, 'array args rejected');

    // no schema → no args accepted, but {} / undefined fine
    assert.strictEqual(validateArgsAgainstSchema(undefined, {}).ok, true, 'empty args + no schema ok');
    assert.strictEqual(validateArgsAgainstSchema(undefined, undefined).ok, true, 'undefined args ok');
    assert.strictEqual(validateArgsAgainstSchema(undefined, { a: 1 }).ok, false, 'unknown arg with no schema rejected');
}

// ── renderAuthValue ──────────────────────────────────────────────────────
{
    // bearer
    assert.strictEqual(
        renderAuthValue({ type: 'bearer', valueTemplate: 'Bearer {{credential.api_key}}' }, { api_key: 'sk_live_123456' }),
        'Bearer sk_live_123456'
    );
    // header (raw key + multiple refs in one template)
    assert.strictEqual(
        renderAuthValue({ type: 'header', header: 'X-Api-Key', valueTemplate: '{{credential.id}}:{{credential.api_key}}' }, { id: 'tenant1', api_key: 'k123456' }),
        'tenant1:k123456'
    );
    // query
    assert.strictEqual(
        renderAuthValue({ type: 'query', queryParam: 'api_key', valueTemplate: '{{credential.api_key}}' }, { api_key: 'qk_998877' }),
        'qk_998877'
    );
    // basic
    assert.strictEqual(
        renderAuthValue({ type: 'basic' }, { username: 'user', password: 'pass' }),
        'Basic ' + Buffer.from('user:pass', 'utf8').toString('base64')
    );
    // missing credential key → throws WITHOUT echoing other secret values
    assert.throws(
        () => renderAuthValue({ type: 'bearer', valueTemplate: 'Bearer {{credential.api_key}}' }, { other: 'topsecret99' }),
        (err) => err instanceof Error && !err.message.includes('topsecret99'),
        'missing key throws without leaking secrets'
    );
    // basic with missing password → throws
    assert.throws(() => renderAuthValue({ type: 'basic' }, { username: 'u' }), /incomplete/);
    // missing template → throws
    assert.throws(() => renderAuthValue({ type: 'bearer' }, { api_key: 'x' }), /template/);
}

// ── scrubSecrets ─────────────────────────────────────────────────────────
{
    const secret = 'p@ss word42';
    const b64 = Buffer.from(secret, 'utf8').toString('base64');
    const enc = encodeURIComponent(secret);

    // literal form, all occurrences
    let out = scrubSecrets(`a ${secret} b ${secret}`, [secret]);
    assert.strictEqual(out, 'a [redacted:credential] b [redacted:credential]', 'literal scrubbed everywhere');

    // base64 form
    out = scrubSecrets(`token=${b64};`, [secret]);
    assert.strictEqual(out, 'token=[redacted:credential];', 'base64 form scrubbed');

    // base64url form (no padding, -/_ alphabet)
    const b64url = Buffer.from(secret, 'utf8').toString('base64url');
    out = scrubSecrets(`jwtish=${b64url}.`, [secret]);
    assert.strictEqual(out, 'jwtish=[redacted:credential].', 'base64url form scrubbed');

    // URL-encoded form
    out = scrubSecrets(`https://h/?k=${enc}`, [secret]);
    assert.strictEqual(out, 'https://h/?k=[redacted:credential]', 'urlencoded form scrubbed');

    // short values (< 6 chars) are left alone (would shred normal text)
    assert.strictEqual(scrubSecrets('abc abc', ['abc']), 'abc abc', 'short secret not scrubbed');

    // multiple secrets at once
    out = scrubSecrets('k1=alphasecret k2=betasecret9', ['alphasecret', 'betasecret9']);
    assert.strictEqual(out, 'k1=[redacted:credential] k2=[redacted:credential]');

    // non-string passthrough + empty values list
    assert.strictEqual(scrubSecrets(null, ['whatever']), null);
    assert.strictEqual(scrubSecrets('hello', []), 'hello');
    assert.strictEqual(scrubSecrets('hello', undefined), 'hello');
}

// ── truncateBudget ───────────────────────────────────────────────────────
{
    assert.deepStrictEqual(truncateBudget('short', 100), { text: 'short', truncated: false });
    const r = truncateBudget('x'.repeat(150), 100);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.text.length, 100);
    // exact fit is not truncated
    assert.strictEqual(truncateBudget('x'.repeat(100), 100).truncated, false);
    // non-positive / missing max falls back to the 30000 default
    assert.strictEqual(truncateBudget('x'.repeat(30001)).truncated, true);
    assert.strictEqual(truncateBudget('x'.repeat(29999)).truncated, false);
}

// ── _internals.buildJsonBody: typed substitution ─────────────────────────
{
    const { buildJsonBody } = _internals;
    const template = {
        amount: '{amount}',
        currency: 'EUR',
        note: 'about {amount} euros',   // contains-but-not-exact → literal
        memo: '{memo}',                  // optional, absent → key dropped
        nested: { flag: '{flag}' },
        list: ['{amount}', 'lit'],
    };
    const out = buildJsonBody(template, { amount: 12.5, flag: true });
    assert.strictEqual(out.amount, 12.5, 'numeric arg stays a number');
    assert.strictEqual(out.currency, 'EUR', 'literal kept');
    assert.strictEqual(out.note, 'about {amount} euros', 'partial placeholder is literal');
    assert.ok(!('memo' in out), 'absent optional arg drops the key');
    assert.strictEqual(out.nested.flag, true, 'boolean arg stays boolean');
    assert.deepStrictEqual(out.list, [12.5, 'lit'], 'array leaves substituted');
}

// ── _internals.extractErrorMessage: sanitized, short, never raw body ─────
{
    const { extractErrorMessage } = _internals;
    assert.strictEqual(extractErrorMessage('{"message":"Invoice not found"}'), 'Invoice not found');
    assert.strictEqual(extractErrorMessage('{"error":{"message":"Bad <b>thing</b>"}}'), 'Bad thing', 'tags stripped');
    assert.strictEqual(extractErrorMessage('<response><message>Nope</message></response>'), 'Nope');
    assert.strictEqual(extractErrorMessage('plain text garbage'), null, 'unstructured body → null (mapped reason only)');
    assert.strictEqual(extractErrorMessage(''), null);
    const long = JSON.stringify({ message: 'x'.repeat(500) });
    assert.strictEqual(extractErrorMessage(long).length, 300, 'capped at 300 chars');
}

console.log('customIntegrationRunner.test.js: all tests passed');
