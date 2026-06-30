/**
 * Unit tests for the NMBRS tool module.
 *
 * Run: node integrations/nmbrsTools.test.js
 *
 * No network/DB needed — `configStore` is stubbed (same trick as
 * afasTools.test.js) and `global.fetch` is scripted per case. Covers BOTH api
 * modes (soap + rest), SSRF/validation guards and error sanitization.
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
    executeNmbrsTool,
    isNmbrsTool,
    escapeXml,
    buildSoapUrl,
    buildRestUrl,
    buildSoapEnvelope,
    coerceArray,
    restListFrom,
    extractSoapResult,
    truncateRows,
    extractNmbrsErrorMessage,
    SUBDOMAIN_RE,
    TOKEN_RE,
    EMAIL_RE,
    SOAP_METHODS_READONLY,
} = require('./nmbrsTools');

const TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2'; // 24 printable chars

function setCreds(userId, { mode = 'soap', subdomain = 'acme', email = 'me@acme.nl', token = TOKEN, env = 'production' } = {}) {
    SECRETS[`nmbrs_api_mode_user_${userId}`] = mode;
    SECRETS[`nmbrs_subdomain_user_${userId}`] = subdomain;
    SECRETS[`nmbrs_email_user_${userId}`] = email;
    SECRETS[`nmbrs_token_user_${userId}`] = token;
    SECRETS[`nmbrs_env_user_${userId}`] = env;
}
function clearCreds(userId) {
    for (const k of ['api_mode', 'subdomain', 'email', 'token', 'env']) delete SECRETS[`nmbrs_${k}_user_${userId}`];
}

// ── fetch stub ─────────────────────────────────────────────────────────
let fetchCalls = [];
function scriptFetch(responses) {
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

// Build a SOAP response envelope wrapping the given inner XML as {method}Result.
function soapResponse(method, innerXml) {
    return `<?xml version="1.0" encoding="utf-8"?>` +
        `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
        `<soap:Body>` +
        `<${method}Response xmlns="https://api.nmbrs.nl/soap/v3/EmployeeService">` +
        `<${method}Result>${innerXml}</${method}Result>` +
        `</${method}Response>` +
        `</soap:Body></soap:Envelope>`;
}

(async () => {
    // ── validation regexes ────────────────────────────────────────────
    for (const ok of ['acme', 'a', 'my-company', 'ABC123']) assert.ok(SUBDOMAIN_RE.test(ok), `subdomain ok: ${ok}`);
    for (const bad of ['', 'a.b', 'evil.host/', 'a/b', '-x', 'x-', 'a b', 'a;rm']) assert.ok(!SUBDOMAIN_RE.test(bad), `subdomain rejected: ${JSON.stringify(bad)}`);
    assert.ok(TOKEN_RE.test(TOKEN));
    for (const bad of ['short', 'has space here xxxxxxx', `crlf\r\ninjection${TOKEN}`, '']) assert.ok(!TOKEN_RE.test(bad), `token rejected: ${JSON.stringify(bad)}`);
    assert.ok(EMAIL_RE.test('me@acme.nl'));
    for (const bad of ['noat', 'a@', '@b', 'a b@c', 'a@b,c']) assert.ok(!EMAIL_RE.test(bad), `email rejected: ${JSON.stringify(bad)}`);

    // ── escapeXml ─────────────────────────────────────────────────────
    assert.strictEqual(escapeXml(`<a>&"'`), '&lt;a&gt;&amp;&quot;&apos;');

    // ── buildSoapUrl / buildRestUrl: host pinning + SSRF guard ─────────
    assert.strictEqual(buildSoapUrl('acme', 'EmployeeService', 'production'), 'https://api.nmbrs.nl/soap/v3/EmployeeService.asmx');
    assert.strictEqual(buildSoapUrl('acme', 'EmployeeService', 'sandbox'), 'https://api-sandbox.nmbrs.nl/soap/v3/EmployeeService.asmx');
    assert.strictEqual(buildRestUrl('acme', 'companies/9/employees', 'production'), 'https://api.nmbrsapp.com/companies/9/employees');
    assert.strictEqual(buildRestUrl('acme', 'debtors', 'sandbox'), 'https://api-sandbox.nmbrsapp.com/debtors');
    for (const bad of ['a.b', 'evil/', '']) {
        assert.throws(() => buildSoapUrl(bad, 'EmployeeService', 'production'), /subdomain/, `soap url rejects subdomain ${JSON.stringify(bad)}`);
        assert.throws(() => buildRestUrl(bad, 'debtors', 'production'), /subdomain/, `rest url rejects subdomain ${JSON.stringify(bad)}`);
    }
    assert.throws(() => buildSoapUrl('acme', 'EvilService', 'production'), /service/, 'soap url rejects unknown service');
    assert.throws(() => buildRestUrl('acme', '../secrets', 'production'), /path/, 'rest url rejects bad path');

    // ── buildSoapEnvelope ─────────────────────────────────────────────
    {
        const env = buildSoapEnvelope({ email: 'me@acme.nl', token: TOKEN, subdomain: 'acme' }, 'EmployeeService', 'Employee_GetByCompany', { CompanyId: 9 });
        assert.ok(env.includes('<tns:Username>me@acme.nl</tns:Username>'));
        assert.ok(env.includes(`<tns:Token>${TOKEN}</tns:Token>`));
        assert.ok(env.includes('<tns:Domain>acme</tns:Domain>'));
        assert.ok(env.includes('<tns:Employee_GetByCompany><tns:CompanyId>9</tns:CompanyId></tns:Employee_GetByCompany>'));
        assert.ok(env.includes('xmlns:tns="https://api.nmbrs.nl/soap/v3/EmployeeService"'));
    }

    // ── coerceArray (flat, nested, single, empty) ─────────────────────
    assert.deepStrictEqual(coerceArray({ Debtor: [{ Id: 1 }, { Id: 2 }] }), [{ Id: 1 }, { Id: 2 }]);
    assert.deepStrictEqual(coerceArray({ Debtors: { Debtor: [{ Id: 1 }] } }), [{ Id: 1 }]);
    assert.deepStrictEqual(coerceArray({ Employee: { Id: 1, Name: 'A' } }), [{ Id: 1, Name: 'A' }]);
    assert.deepStrictEqual(coerceArray(''), []);
    assert.deepStrictEqual(coerceArray(null), []);
    assert.deepStrictEqual(coerceArray([{ a: 1 }]), [{ a: 1 }]);

    // ── restListFrom ──────────────────────────────────────────────────
    assert.deepStrictEqual(restListFrom([{ a: 1 }]), [{ a: 1 }]);
    assert.deepStrictEqual(restListFrom({ data: [{ a: 1 }] }), [{ a: 1 }]);
    assert.deepStrictEqual(restListFrom({ items: [{ a: 1 }] }), [{ a: 1 }]);
    assert.deepStrictEqual(restListFrom({ id: 1 }), [{ id: 1 }]);

    // ── extractSoapResult: result + fault ─────────────────────────────
    {
        const parsed = require('fast-xml-parser');
        const { XMLParser } = parsed;
        const p = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, trimValues: true });
        const r = extractSoapResult(p.parse(soapResponse('Debtor_GetList', '<Debtor><Id>1</Id></Debtor>')), 'Debtor_GetList');
        assert.deepStrictEqual(coerceArray(r), [{ Id: '1' }]);
        assert.throws(() => extractSoapResult(p.parse(
            `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultstring>Geen rechten</faultstring></soap:Fault></soap:Body></soap:Envelope>`
        ), 'Debtor_GetList'), /Geen rechten/);
    }

    // ── truncateRows ──────────────────────────────────────────────────
    {
        const small = [{ a: 1 }, { a: 2 }];
        assert.deepStrictEqual(truncateRows(small, 1000), { rows: small, truncated: false });
        const big = Array.from({ length: 100 }, (_, i) => ({ i, pad: 'x'.repeat(100) }));
        const r = truncateRows(big, 2000);
        assert.strictEqual(r.truncated, true);
        assert.ok(r.rows.length > 0 && r.rows.length < 100 && JSON.stringify(r.rows).length <= 2000);
    }

    // ── extractNmbrsErrorMessage ──────────────────────────────────────
    assert.strictEqual(extractNmbrsErrorMessage('<soap:Fault><faultstring>Token ongeldig</faultstring></soap:Fault>'), 'Token ongeldig');
    assert.strictEqual(extractNmbrsErrorMessage('{"message":"Not allowed"}'), 'Not allowed');
    assert.strictEqual(extractNmbrsErrorMessage('<html><body>dump</body></html>'), null);
    assert.strictEqual(extractNmbrsErrorMessage(`<faultstring>${'x'.repeat(500)}</faultstring>`).length, 300);

    // ── not configured / null user / unknown tool ─────────────────────
    assert.deepStrictEqual(await executeNmbrsTool('nmbrs_list_debtors', {}, null), { error: 'User context required for NMBRS.' });
    assert.ok((await executeNmbrsTool('nmbrs_list_debtors', {}, 'nobody')).error.includes('not configured'));
    // SOAP without email is treated as not configured.
    setCreds('noemail', { mode: 'soap', email: '' });
    SECRETS['nmbrs_email_user_noemail'] = null;
    assert.ok((await executeNmbrsTool('nmbrs_list_debtors', {}, 'noemail')).error.includes('not configured'));
    setCreds('u1');
    assert.ok((await executeNmbrsTool('nmbrs_nope', {}, 'u1')).error.includes('Unknown NMBRS tool'));

    // ── SOAP mode: list employees ─────────────────────────────────────
    setCreds('soapU', { mode: 'soap', subdomain: 'acme', email: 'me@acme.nl', token: TOKEN, env: 'production' });
    scriptFetch([{ text: soapResponse('Employee_GetByCompany', '<Employee><Id>1</Id><Name>Alice</Name></Employee><Employee><Id>2</Id><Name>Bob</Name></Employee>') }]);
    {
        const r = await executeNmbrsTool('nmbrs_list_employees', { companyId: '9' }, 'soapU');
        assert.strictEqual(fetchCalls.length, 1);
        assert.strictEqual(fetchCalls[0].url, 'https://api.nmbrs.nl/soap/v3/EmployeeService.asmx');
        assert.strictEqual(fetchCalls[0].opts.method, 'POST');
        assert.strictEqual(fetchCalls[0].opts.redirect, 'error');
        assert.strictEqual(fetchCalls[0].opts.headers.SOAPAction, 'https://api.nmbrs.nl/soap/v3/EmployeeService/Employee_GetByCompany');
        const body = fetchCalls[0].opts.body;
        assert.ok(body.includes('<tns:Username>me@acme.nl</tns:Username>') && body.includes('<tns:Domain>acme</tns:Domain>'));
        assert.ok(body.includes('Employee_GetByCompany') && body.includes('<tns:CompanyId>9</tns:CompanyId>'));
        // Read-only: the envelope must contain no mutation verb.
        assert.ok(!/Insert|Update|Delete|Create|Set_|_Save/.test(body), 'SOAP body contains no mutation verb');
        assert.strictEqual(r.count, 2);
        assert.deepStrictEqual(r.items, [{ Id: '1', Name: 'Alice' }, { Id: '2', Name: 'Bob' }]);
    }
    // activeOnly:false switches to Employee_GetAllByCompany.
    scriptFetch([{ text: soapResponse('Employee_GetAllByCompany', '<Employee><Id>3</Id></Employee>') }]);
    {
        await executeNmbrsTool('nmbrs_list_employees', { companyId: '9', activeOnly: false }, 'soapU');
        assert.ok(fetchCalls[0].opts.headers.SOAPAction.endsWith('Employee_GetAllByCompany'));
    }

    // ── REST mode: same logical call, backend-agnostic result shape ───
    setCreds('restU', { mode: 'rest', subdomain: 'acme', token: TOKEN, env: 'production' });
    scriptFetch([{ json: { data: [{ Id: '1', Name: 'Alice' }, { Id: '2', Name: 'Bob' }] } }]);
    {
        const r = await executeNmbrsTool('nmbrs_list_employees', { companyId: '9' }, 'restU');
        const u = new URL(fetchCalls[0].url);
        assert.strictEqual(u.origin, 'https://api.nmbrsapp.com');
        assert.strictEqual(u.pathname, '/companies/9/employees');
        assert.strictEqual(u.searchParams.get('active'), 'true');
        assert.strictEqual(fetchCalls[0].opts.method, 'GET');
        assert.strictEqual(fetchCalls[0].opts.redirect, 'error');
        assert.strictEqual(fetchCalls[0].opts.headers.Authorization, `Bearer ${TOKEN}`);
        assert.strictEqual(fetchCalls[0].opts.headers['X-Subdomain'], 'acme');
        // Mode isolation: identical normalized shape to the SOAP call above.
        assert.deepStrictEqual(r.items, [{ Id: '1', Name: 'Alice' }, { Id: '2', Name: 'Bob' }]);
    }
    // Sandbox env hits the sandbox host.
    setCreds('restSandbox', { mode: 'rest', subdomain: 'acme', token: TOKEN, env: 'sandbox' });
    scriptFetch([{ json: [] }]);
    {
        await executeNmbrsTool('nmbrs_list_debtors', {}, 'restSandbox');
        assert.strictEqual(new URL(fetchCalls[0].url).origin, 'https://api-sandbox.nmbrsapp.com');
        assert.strictEqual(new URL(fetchCalls[0].url).pathname, '/debtors');
    }

    // ── REST companies by debtor + year/period query ──────────────────
    scriptFetch([{ json: { items: [{ Id: '5' }] } }]);
    {
        await executeNmbrsTool('nmbrs_list_companies', { debtorId: '7' }, 'restU');
        assert.strictEqual(new URL(fetchCalls[0].url).pathname, '/debtors/7/companies');
    }
    scriptFetch([{ json: [] }]);
    {
        await executeNmbrsTool('nmbrs_list_payslips', { employeeId: '3', year: 2026, period: 5 }, 'restU');
        const u = new URL(fetchCalls[0].url);
        assert.strictEqual(u.pathname, '/employees/3/payslips');
        assert.strictEqual(u.searchParams.get('year'), '2026');
        assert.strictEqual(u.searchParams.get('period'), '5');
    }

    // ── SSRF / validation guards reject bad IDs before any fetch ──────
    for (const [tool, args] of [
        ['nmbrs_list_employees', { companyId: '../x' }],
        ['nmbrs_get_employee', { employeeId: 'a/b' }],
        ['nmbrs_list_companies', { debtorId: 'a;rm' }],
        ['nmbrs_list_employee_salaries', { employeeId: 'x'.repeat(80) }],
    ]) {
        scriptFetch([]);
        const r = await executeNmbrsTool(tool, args, 'restU');
        assert.ok(r.error && /Invalid/.test(r.error), `${tool} rejects bad id: ${r.error}`);
        assert.strictEqual(fetchCalls.length, 0, `${tool} made no upstream request`);
    }
    // Bad year / period.
    scriptFetch([]);
    assert.ok((await executeNmbrsTool('nmbrs_list_payslips', { employeeId: '3', year: 99 }, 'restU')).error.includes('year'));
    assert.strictEqual(fetchCalls.length, 0);
    scriptFetch([]);
    assert.ok((await executeNmbrsTool('nmbrs_list_payslips', { employeeId: '3', year: 2026, period: 99 }, 'restU')).error.includes('period'));
    assert.strictEqual(fetchCalls.length, 0);

    // ── error mapping: no body / URL / secret leakage ─────────────────
    scriptFetch([{ ok: false, status: 401, text: '<html>secret dump https://evil acme me@acme.nl</html>' }]);
    {
        const r = await executeNmbrsTool('nmbrs_list_debtors', {}, 'restU');
        assert.ok(r.error.includes('invalid or the token was revoked'), r.error);
        assert.ok(!r.error.includes('evil') && !r.error.includes('https://'), 'raw body/URL never surfaces');
    }
    scriptFetch([{ ok: false, status: 500, text: '<soap:Fault><faultstring>Index onbekend</faultstring></soap:Fault>' }]);
    {
        const r = await executeNmbrsTool('nmbrs_list_employees', { companyId: '9' }, 'soapU');
        assert.ok(r.error.includes('server error') && r.error.includes('Index onbekend'), r.error);
    }

    // ── isNmbrsTool / read-only method allow-list ─────────────────────
    assert.ok(isNmbrsTool('nmbrs_list_debtors') && isNmbrsTool('nmbrs_get_employee'));
    assert.ok(!isNmbrsTool('nmbrs_update_employee') && !isNmbrsTool('afas_query'));
    for (const m of SOAP_METHODS_READONLY) assert.ok(/Get|List|Reports_/.test(m), `read-only method name: ${m}`);

    clearCreds('noemail');
    console.log('nmbrsTools.test.js: all tests passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
