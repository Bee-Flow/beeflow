/**
 * Unit tests for the custom MCP client's pure helpers.
 *
 * Run: node core/customIntegrations/customMcpClient.test.js
 *
 * No DB, no network — only the exported pure functions (normalize/intersect,
 * valueTemplate rendering, pool-key shape, scrubbing, result capping).
 */

const assert = require('assert');
const {
    normalizeAndFilterTools,
    renderValueTemplate,
    buildAuthHeaders,
    poolKeyFor,
    safeToolName,
    resolveRemoteToolName,
    scrubSecrets,
    capResultChars,
    extractTextContent,
    MAX_TOOLS,
    MAX_TOOL_SCHEMA_CHARS,
    MAX_RESULT_CHARS,
} = require('./customMcpClient');

function rawTool(name, extra = {}) {
    return {
        name,
        description: `does ${name}`,
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        ...extra,
    };
}

// ── normalizeAndFilterTools: basic normalization ────────────────────────
{
    const { tools, warnings } = normalizeAndFilterTools([rawTool('search'), rawTool('fetch')]);
    assert.strictEqual(tools.length, 2);
    assert.deepStrictEqual(tools.map(t => t.name), ['search', 'fetch']);
    assert.strictEqual(tools[0].description, 'does search');
    assert.deepStrictEqual(tools[0].inputSchema, { type: 'object', properties: { q: { type: 'string' } } });
    assert.deepStrictEqual(warnings, []);
}

// ── missing description / inputSchema get safe defaults ─────────────────
{
    const { tools } = normalizeAndFilterTools([{ name: 'bare' }]);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].description, '');
    assert.deepStrictEqual(tools[0].inputSchema, { type: 'object', properties: {} });
}

// ── nameless / malformed entries are skipped ─────────────────────────────
{
    const { tools } = normalizeAndFilterTools([null, {}, { name: '' }, 42, rawTool('ok')]);
    assert.deepStrictEqual(tools.map(t => t.name), ['ok']);
}

// ── allowlist intersection ───────────────────────────────────────────────
{
    const raw = [rawTool('search'), rawTool('fetch'), rawTool('delete_all')];
    const { tools, warnings } = normalizeAndFilterTools(raw, ['search', 'fetch']);
    assert.deepStrictEqual(tools.map(t => t.name), ['search', 'fetch']);
    assert.deepStrictEqual(warnings, []);
}

// ── allowlist entry the server never advertised → warning ───────────────
{
    const { tools, warnings } = normalizeAndFilterTools([rawTool('search')], ['search', 'ghost']);
    assert.deepStrictEqual(tools.map(t => t.name), ['search']);
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].includes('"ghost"'), `warning names the missing tool: ${warnings[0]}`);
}

// ── empty allowlist array means "allow none" (explicit empty ≠ omitted) ──
{
    const { tools } = normalizeAndFilterTools([rawTool('search')], []);
    assert.deepStrictEqual(tools, []);
}

// ── null allowlist means "allow all" ─────────────────────────────────────
{
    const { tools } = normalizeAndFilterTools([rawTool('a1'), rawTool('b2')], null);
    assert.strictEqual(tools.length, 2);
}

// ── oversize schema (> MAX_TOOL_SCHEMA_CHARS) → dropped with warning ─────
{
    const big = rawTool('bigone', {
        inputSchema: { type: 'object', properties: { blob: { type: 'string', description: 'x'.repeat(MAX_TOOL_SCHEMA_CHARS) } } },
    });
    const { tools, warnings } = normalizeAndFilterTools([rawTool('ok'), big]);
    assert.deepStrictEqual(tools.map(t => t.name), ['ok']);
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].includes('"bigone"'), `warning names the dropped tool: ${warnings[0]}`);
    assert.ok(warnings[0].includes(String(MAX_TOOL_SCHEMA_CHARS)), 'warning mentions the cap');
}

// ── allow-listed + advertised but oversize → only the drop warning ───────
{
    const big = rawTool('huge', {
        inputSchema: { type: 'object', properties: { blob: { type: 'string', description: 'x'.repeat(MAX_TOOL_SCHEMA_CHARS) } } },
    });
    const { tools, warnings } = normalizeAndFilterTools([big], ['huge']);
    assert.deepStrictEqual(tools, []);
    assert.strictEqual(warnings.length, 1, `expected only the drop warning, got: ${JSON.stringify(warnings)}`);
    assert.ok(warnings[0].includes('dropped'), 'warning is the schema-size drop, not "not advertised"');
}

// ── schema exactly at the cap survives ───────────────────────────────────
{
    const base = { type: 'object', properties: { d: { type: 'string', description: '' } } };
    const baseLen = JSON.stringify(base).length;
    base.properties.d.description = 'y'.repeat(MAX_TOOL_SCHEMA_CHARS - baseLen);
    assert.strictEqual(JSON.stringify(base).length, MAX_TOOL_SCHEMA_CHARS);
    const { tools, warnings } = normalizeAndFilterTools([rawTool('edge', { inputSchema: base })]);
    assert.deepStrictEqual(tools.map(t => t.name), ['edge']);
    assert.deepStrictEqual(warnings, []);
}

// ── circular (unserializable) schema → dropped, not thrown ───────────────
{
    const schema = { type: 'object', properties: {} };
    schema.properties.self = schema;
    const { tools, warnings } = normalizeAndFilterTools([rawTool('loopy', { inputSchema: schema })]);
    assert.deepStrictEqual(tools, []);
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].includes('"loopy"'));
}

// ── more than MAX_TOOLS → truncated with warning ─────────────────────────
{
    const raw = [];
    for (let i = 0; i < MAX_TOOLS + 7; i++) raw.push(rawTool(`tool_${i}`));
    const { tools, warnings } = normalizeAndFilterTools(raw);
    assert.strictEqual(tools.length, MAX_TOOLS);
    assert.strictEqual(tools[0].name, 'tool_0');
    assert.strictEqual(tools[MAX_TOOLS - 1].name, `tool_${MAX_TOOLS - 1}`);
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].includes(String(MAX_TOOLS)), 'truncation warning mentions the cap');
}

// ── exactly MAX_TOOLS → no truncation warning ────────────────────────────
{
    const raw = [];
    for (let i = 0; i < MAX_TOOLS; i++) raw.push(rawTool(`tool_${i}`));
    const { tools, warnings } = normalizeAndFilterTools(raw);
    assert.strictEqual(tools.length, MAX_TOOLS);
    assert.deepStrictEqual(warnings, []);
}

// ── duplicates: first kept, warning emitted ──────────────────────────────
{
    const { tools, warnings } = normalizeAndFilterTools([
        rawTool('dup', { description: 'first' }),
        rawTool('dup', { description: 'second' }),
    ]);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].description, 'first');
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].includes('"dup"'));
}

// ── non-array input is tolerated ─────────────────────────────────────────
{
    const { tools, warnings } = normalizeAndFilterTools(undefined);
    assert.deepStrictEqual(tools, []);
    assert.deepStrictEqual(warnings, []);
}

// ── renderValueTemplate: single + multiple refs, literals preserved ──────
{
    assert.strictEqual(
        renderValueTemplate('Bearer {{credential.api_key}}', { api_key: 'sk-123' }),
        'Bearer sk-123'
    );
    assert.strictEqual(
        renderValueTemplate('{{credential.id}}:{{credential.token}}', { id: 'abc', token: 't9' }),
        'abc:t9'
    );
    assert.strictEqual(renderValueTemplate('static-value', { api_key: 'x' }), 'static-value');
}

// ── renderValueTemplate: missing key throws, message never leaks values ──
{
    assert.throws(
        () => renderValueTemplate('Bearer {{credential.api_key}}', { other: 'supersecretvalue' }),
        /missing credential "api_key"/
    );
    try {
        renderValueTemplate('Bearer {{credential.api_key}}', { other: 'supersecretvalue' });
        assert.fail('should have thrown');
    } catch (err) {
        assert.ok(!err.message.includes('supersecretvalue'), 'error must not echo secret values');
    }
    // null/empty secret object also throws (template demands a credential)
    assert.throws(() => renderValueTemplate('Bearer {{credential.k}}', null), /missing credential/);
    assert.throws(() => renderValueTemplate('Bearer {{credential.k}}', { k: '' }), /missing credential/);
}

// ── buildAuthHeaders ─────────────────────────────────────────────────────
{
    // bearer → Authorization
    assert.deepStrictEqual(
        buildAuthHeaders({ authStyle: 'bearer', valueTemplate: 'Bearer {{credential.api_key}}' }, { api_key: 'k1' }),
        { Authorization: 'Bearer k1' }
    );
    // header → custom header name
    assert.deepStrictEqual(
        buildAuthHeaders({ authStyle: 'header', header: 'X-Api-Key', valueTemplate: '{{credential.api_key}}' }, { api_key: 'k2' }),
        { 'X-Api-Key': 'k2' }
    );
    // none → no headers
    assert.deepStrictEqual(buildAuthHeaders({ authStyle: 'none' }, { api_key: 'k' }), {});
    // null secret (unauthenticated discovery probe) → no headers, no throw
    assert.deepStrictEqual(
        buildAuthHeaders({ authStyle: 'bearer', valueTemplate: 'Bearer {{credential.api_key}}' }, null),
        {}
    );
    // missing mcp block → no headers
    assert.deepStrictEqual(buildAuthHeaders(null, { api_key: 'k' }), {});
}

// ── poolKeyFor shape ─────────────────────────────────────────────────────
{
    assert.strictEqual(poolKeyFor('11111111-2222-3333-4444-555555555555', 'user-9'),
        '11111111-2222-3333-4444-555555555555:user-9');
    // integration id first, user id second — distinct from mcpManager's `${userId}:${serverId}`
    assert.strictEqual(poolKeyFor('int', 'usr'), 'int:usr');
    assert.notStrictEqual(poolKeyFor('a', 'b'), poolKeyFor('b', 'a'));
}

// ── safeToolName: lowercases + maps illegal chars to '_' ────────────────
{
    assert.strictEqual(safeToolName('list_invoices'), 'list_invoices'); // already safe → unchanged
    assert.strictEqual(safeToolName('Search-Docs'), 'search_docs');
    assert.strictEqual(safeToolName('repos.list'), 'repos_list');
    assert.strictEqual(safeToolName('get user / by ID'), 'get_user_by_id'); // runs collapse to one '_'
}

// ── safeToolName: non-letter start gets the t_ prefix ────────────────────
{
    assert.strictEqual(safeToolName('123fetch'), 't_123fetch');
    assert.strictEqual(safeToolName('_private'), 't_private'); // prefix + collapse, no '__'
    assert.strictEqual(safeToolName('---'), 't'); // nothing usable → bare prefix, trailing '_' trimmed
    assert.strictEqual(safeToolName(''), 't');
    assert.strictEqual(safeToolName(null), 't');
}

// ── safeToolName: 40-char cap, no trailing underscore survives the cut ───
{
    const long = 'a'.repeat(39) + '_zz';
    const out = safeToolName(long);
    assert.ok(out.length <= 40, `capped at 40 (got ${out.length})`);
    assert.ok(!out.endsWith('_'), 'no trailing underscore after the cap');
    assert.strictEqual(safeToolName('x'.repeat(80)), 'x'.repeat(40));
    assert.strictEqual(safeToolName('Tool!!Name??'), 'tool_name', 'trailing separator runs are trimmed');
}

// ── resolveRemoteToolName: strips cint_<slug>_ prefix, passes bare names ─
{
    const integration = { slug: 'ab12cd34' };
    assert.strictEqual(resolveRemoteToolName(integration, 'cint_ab12cd34_list_invoices'), 'list_invoices');
    assert.strictEqual(resolveRemoteToolName(integration, 'list_invoices'), 'list_invoices');
    // other slugs' prefixes are NOT stripped
    assert.strictEqual(resolveRemoteToolName(integration, 'cint_zz99zz99_search'), 'cint_zz99zz99_search');
    assert.strictEqual(resolveRemoteToolName({}, 'cint_ab12cd34_x'), 'cint_ab12cd34_x');
}

// ── scrubSecrets: literal, base64, base64url, urlencoded forms ───────────
{
    const secret = { api_key: 'sk-live+abc/123', other: 'tokenXYZ' };
    const b64 = Buffer.from('sk-live+abc/123', 'utf8').toString('base64');
    const b64url = Buffer.from('sk-live+abc/123', 'utf8').toString('base64url');
    const enc = encodeURIComponent('sk-live+abc/123');
    const input = `literal=sk-live+abc/123 b64=${b64} b64url=${b64url} url=${enc} other=tokenXYZ keep=this`;
    const out = scrubSecrets(input, secret);
    assert.ok(!out.includes('sk-live+abc/123'), 'literal scrubbed');
    assert.ok(!out.includes(b64), 'base64 scrubbed');
    assert.ok(!out.includes(b64url), 'base64url scrubbed');
    assert.ok(!out.includes(enc), 'urlencoded scrubbed');
    assert.ok(!out.includes('tokenXYZ'), 'every secret value scrubbed');
    assert.ok(out.includes('[redacted:credential]'), 'redaction marker present');
    assert.ok(out.includes('keep=this'), 'non-secret text preserved');
}

// ── scrubSecrets: short values (< 6 chars) are NOT scrubbed ──────────────
{
    const out = scrubSecrets('status ok, id ok2', { pin: 'ok' });
    assert.strictEqual(out, 'status ok, id ok2');
    assert.strictEqual(scrubSecrets('code abcde', { pin: 'abcde' }), 'code abcde');
}

// ── scrubSecrets: null/absent secrets and non-string text are safe ───────
{
    assert.strictEqual(scrubSecrets('hello', null), 'hello');
    assert.strictEqual(scrubSecrets(null, { k: 'longsecret' }), '');
    assert.strictEqual(scrubSecrets(12345, { k: 'longsecret' }), '12345');
}

// ── capResultChars: under cap unchanged, over cap truncated w/ marker ────
{
    assert.strictEqual(capResultChars('short'), 'short');
    const exact = 'a'.repeat(MAX_RESULT_CHARS);
    assert.strictEqual(capResultChars(exact), exact);
    const over = 'b'.repeat(MAX_RESULT_CHARS + 500);
    const capped = capResultChars(over);
    assert.strictEqual(capped.length, MAX_RESULT_CHARS, 'marker fits inside the cap');
    assert.ok(capped.includes('[truncated'), 'truncation marker present');
}

// ── extractTextContent: mcpManager parity ────────────────────────────────
{
    assert.strictEqual(
        extractTextContent({ content: [{ type: 'text', text: 'one' }, { type: 'image', data: 'x' }, { type: 'text', text: 'two' }] }),
        'one\ntwo'
    );
    assert.strictEqual(extractTextContent({ structuredContent: { a: 1 } }), '{"structuredContent":{"a":1}}');
}

console.log('customMcpClient.test.js: all tests passed');
