/**
 * NMBRS Tools — Built-in READ-ONLY tools for AI to read NMBRS (Visma Nmbrs)
 * payroll/HR data: debtors, companies, employees, contracts, salaries, wage
 * components and payslip summaries.
 *
 * NMBRS exposes two APIs and a connection may use either:
 *   - SOAP   (legacy; Visma discontinues it 2027-03-01): AuthHeaderWithDomain
 *            with Username (login email) + Token + Domain (subdomain). Services
 *            live at https://api.nmbrs.nl/soap/v3/<Service>.asmx.
 *   - REST   (modern): OAuth2 Bearer token against https://api.nmbrsapp.com,
 *            tenant selected by the subdomain.
 *
 * The tool surface is identical regardless of backend — each handler calls a
 * backend-agnostic per-entity fetcher that branches on the configured api mode.
 *
 * READ-ONLY BY CONSTRUCTION: only read tools exist, the REST path hard-codes
 * GET, and the SOAP path only emits methods in SOAP_METHODS_READONLY (all
 * *_Get*). There is no mutation code path anywhere in this module.
 *
 * Mirrors the conventions of ./afasTools.js (SSRF-guarded host building,
 * redirect rejection, timeouts, row truncation, leak-free error messages).
 * SOAP XML is parsed with fast-xml-parser (already a dependency).
 */

const configStore = require('../stores/configStore');
const { XMLParser } = require('fast-xml-parser');

const REQUEST_TIMEOUT_MS = 20000;
const MAX_RESPONSE_CHARS = 30000;
const MAX_ERROR_MESSAGE_CHARS = 300;

// Environment → request host. Fixed maps: the env value must never reach the
// hostname directly. NOTE: confirm the exact sandbox hostnames against current
// NMBRS docs at deploy time — the fixed-map pattern is the SSRF guard regardless
// of the literal strings.
const SOAP_HOST = { production: 'api.nmbrs.nl', sandbox: 'api-sandbox.nmbrs.nl' };
const REST_HOST = { production: 'api.nmbrsapp.com', sandbox: 'api-sandbox.nmbrsapp.com' };

// SOAP XML namespace base. Per-service namespace is `${SOAP_NS_BASE}/${service}`
// (also used to build the SOAPAction). This is a fixed identifier, independent
// of the request host (so it stays api.nmbrs.nl even for sandbox).
const SOAP_NS_BASE = 'https://api.nmbrs.nl/soap/v3';

const SOAP_SERVICES = new Set(['DebtorService', 'CompanyService', 'EmployeeService', 'ReportService']);

// The complete set of SOAP methods this module may ever call — all read-only.
// Belt-and-suspenders: soapRequest() refuses any method not in this set, so no
// mutation method can be reached even by a future bug.
// NOTE: verify exact method names against the live WSDL at deploy time.
const SOAP_METHODS_READONLY = new Set([
    'Debtor_GetList',
    'Company_List_GetAll',
    'Company_List_GetByDebtor',
    'Employee_GetByCompany',
    'Employee_GetAllByCompany',
    'PersonalInfo_GetCurrent',
    'Contract_GetAll',
    'Salary_GetList',
    'WageComponentFixed_Get',
    'WageComponentVar_Get',
    'Reports_GetEmployeePayslips',
]);

// Validation regexes. These are the load-bearing input guards.
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i; // single DNS label, no dots/slashes
const TOKEN_RE = /^[\x21-\x7E]{16,512}$/;                     // printable ASCII, no whitespace/CRLF
const EMAIL_RE = /^[^\s@,;]{1,128}@[^\s@,;]{1,128}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;                        // entity-id args (NMBRS ids are numeric)
const REST_PATH_RE = /^[A-Za-z0-9/_-]{1,200}$/;               // defence-in-depth on internally-built paths

const xmlParser = new XMLParser({
    ignoreAttributes: true,
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
});

/**
 * Tool definitions in OpenAI function-calling format. All read-only.
 */
const NMBRS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nmbrs_list_debtors',
            description: 'List the NMBRS debtors (top-level payroll administrations) your account can access. Read-only. Call this first to find debtorId values. Works the same whether the connection uses the NMBRS SOAP or REST API.',
            parameters: { type: 'object', properties: {}, required: [] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nmbrs_list_companies',
            description: 'List NMBRS companies (employers), optionally restricted to one debtor. Read-only. Returns company IDs needed by nmbrs_list_employees.',
            parameters: {
                type: 'object',
                properties: {
                    debtorId: { type: 'string', description: 'Optional debtor ID from nmbrs_list_debtors to filter companies.' }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nmbrs_list_employees',
            description: 'List employees of an NMBRS company (read-only). Use companyId from nmbrs_list_companies. Returns employee IDs for the per-employee tools.',
            parameters: {
                type: 'object',
                properties: {
                    companyId: { type: 'string', description: 'Company ID from nmbrs_list_companies.' },
                    activeOnly: { type: 'boolean', description: 'When true (default), only currently-employed staff are returned.' }
                },
                required: ['companyId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nmbrs_get_employee',
            description: 'Get core NMBRS details for one employee: name, employee number, and current personal/employment info (read-only). Use employeeId from nmbrs_list_employees.',
            parameters: {
                type: 'object',
                properties: {
                    employeeId: { type: 'string', description: 'Employee ID from nmbrs_list_employees.' }
                },
                required: ['employeeId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nmbrs_list_employee_contracts',
            description: 'List the contract history for one NMBRS employee: start/end dates, weekly hours, contract type (read-only).',
            parameters: {
                type: 'object',
                properties: {
                    employeeId: { type: 'string', description: 'Employee ID from nmbrs_list_employees.' }
                },
                required: ['employeeId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nmbrs_list_employee_salaries',
            description: 'List salary records for one NMBRS employee: gross amount, salary type, effective date (read-only). Payroll data is sensitive — only retrieve what the user asked for.',
            parameters: {
                type: 'object',
                properties: {
                    employeeId: { type: 'string', description: 'Employee ID from nmbrs_list_employees.' }
                },
                required: ['employeeId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nmbrs_list_employee_wage_components',
            description: 'List fixed and variable wage components for one NMBRS employee in a given year (and optionally a period/month). Read-only. Payroll data is sensitive — only retrieve what was asked.',
            parameters: {
                type: 'object',
                properties: {
                    employeeId: { type: 'string', description: 'Employee ID from nmbrs_list_employees.' },
                    year: { type: 'integer', description: 'Calendar year, e.g. 2026.' },
                    period: { type: 'integer', description: 'Optional 1-based period/month (1-13). Omit for the whole year.' }
                },
                required: ['employeeId', 'year']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nmbrs_list_payslips',
            description: 'List payslip / payrun summaries for one NMBRS employee in a given year (and optionally a period/month). Read-only — returns metadata and totals, not the binary PDF.',
            parameters: {
                type: 'object',
                properties: {
                    employeeId: { type: 'string', description: 'Employee ID from nmbrs_list_employees.' },
                    year: { type: 'integer', description: 'Calendar year, e.g. 2026.' },
                    period: { type: 'integer', description: 'Optional 1-based period/month (1-13). Omit for the whole year.' }
                },
                required: ['employeeId', 'year']
            }
        }
    }
];

// ─── Pure helpers (exported for tests) ─────────────────────────

function escapeXml(value) {
    return String(value).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
    ));
}

function resolveEnv(env) {
    return String(env || 'production').trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
}

/**
 * Build a SOAP service endpoint. The subdomain is validated here (it travels in
 * the SOAP Domain header, not the host) and `service` must be allow-listed —
 * together these are the SSRF guard.
 */
function buildSoapUrl(subdomain, service, env) {
    if (!SUBDOMAIN_RE.test(String(subdomain || '').trim())) {
        throw new Error('Invalid NMBRS subdomain.');
    }
    if (!SOAP_SERVICES.has(service)) {
        throw new Error('Unknown NMBRS service.');
    }
    const host = SOAP_HOST[resolveEnv(env)];
    return `https://${host}/soap/v3/${service}.asmx`;
}

/**
 * Build a REST endpoint. `path` is always assembled internally from
 * encodeURIComponent'd, validated IDs; the regex is defence-in-depth.
 */
function buildRestUrl(subdomain, path, env) {
    if (!SUBDOMAIN_RE.test(String(subdomain || '').trim())) {
        throw new Error('Invalid NMBRS subdomain.');
    }
    if (!REST_PATH_RE.test(path)) {
        throw new Error('Invalid NMBRS REST path.');
    }
    const host = REST_HOST[resolveEnv(env)];
    return `https://${host}/${path}`;
}

/**
 * Coerce a parsed SOAP result node into an array of rows. NMBRS serializes a
 * list either flat under the Result element ({ Debtor: [..] }) or behind one
 * typed wrapper ({ Debtors: { Debtor: [..] } }); a single row collapses to an
 * object ({ Employee: {..} }). Unwrap single-key wrappers until we reach the
 * rows, but never unwrap a multi-field row object (a real entity).
 */
function coerceArray(node) {
    if (node == null || node === '') return [];
    if (Array.isArray(node)) return node;
    if (typeof node !== 'object') return [];
    const keys = Object.keys(node);
    if (keys.length !== 1) return [node];
    const inner = node[keys[0]];
    if (Array.isArray(inner)) return inner;
    if (inner && typeof inner === 'object') {
        // Single-key wrapper around another single-key list/wrapper → keep
        // unwrapping. Otherwise `inner` is the (single) row itself.
        const innerKeys = Object.keys(inner);
        if (innerKeys.length === 1) {
            const deep = inner[innerKeys[0]];
            if (Array.isArray(deep) || (deep && typeof deep === 'object')) {
                return coerceArray(inner);
            }
        }
        return [inner];
    }
    return [];
}

/** Pull rows out of a REST JSON body (array, {data:[]}, {items:[]} or single). */
function restListFrom(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.data)) return data.data;
    if (data && Array.isArray(data.items)) return data.items;
    if (data && typeof data === 'object') return [data];
    return [];
}

/**
 * Navigate Envelope→Body→{method}Response→{method}Result, throwing on a SOAP
 * Fault (NMBRS may return a Fault with HTTP 200).
 */
function extractSoapResult(parsed, method) {
    const env = parsed && parsed.Envelope;
    const body = env && env.Body;
    if (!body || typeof body !== 'object') {
        throw mapNmbrsError(502, 'NMBRS returned a malformed SOAP response.');
    }
    if (body.Fault) {
        const f = body.Fault;
        const raw = f.faultstring || (f.Reason && f.Reason.Text) || 'SOAP fault';
        const msg = String(raw).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_MESSAGE_CHARS);
        throw new Error(`NMBRS rejected the request: ${msg}`);
    }
    const resp = body[`${method}Response`];
    if (resp == null) return null;
    if (typeof resp === 'object' && Object.prototype.hasOwnProperty.call(resp, `${method}Result`)) {
        return resp[`${method}Result`];
    }
    return resp;
}

/**
 * Drop trailing rows until the serialized result fits the LLM-context budget.
 * Never truncates mid-row. (Mirrors afasTools.truncateRows.)
 */
function truncateRows(rows, maxChars = MAX_RESPONSE_CHARS) {
    if (!Array.isArray(rows)) return { rows: [], truncated: false };
    let kept = rows;
    let truncated = false;
    while (kept.length > 1 && JSON.stringify(kept).length > maxChars) {
        kept = kept.slice(0, Math.floor(kept.length / 2));
        truncated = true;
    }
    if (kept.length > 0 && JSON.stringify(kept).length > maxChars) {
        kept = [];
        truncated = true;
    }
    return { rows: kept, truncated };
}

function shapeList(rawRows, scope) {
    const arr = Array.isArray(rawRows) ? rawRows : [];
    const { rows, truncated } = truncateRows(arr);
    const result = { items: rows, count: rows.length };
    if (truncated) {
        result.truncated = true;
        result.message = `Response too large — showing ${rows.length} of ${arr.length} ${scope || 'records'}. Narrow by company, employee or period.`;
    }
    return result;
}

/**
 * Extract a short, sanitized error message from a NMBRS error body. We only
 * surface a human-readable message — never the raw body, URL, or credentials.
 */
function extractNmbrsErrorMessage(bodyText) {
    if (!bodyText || typeof bodyText !== 'string') return null;
    let message = null;
    const soap = bodyText.match(/<faultstring>([\s\S]*?)<\/faultstring>/i)
        || bodyText.match(/<Message>([\s\S]*?)<\/Message>/i);
    if (soap) {
        message = soap[1];
    } else if (bodyText.trim().startsWith('{')) {
        try {
            const data = JSON.parse(bodyText);
            message = data.message || data.title || (data.error && data.error.message) || null;
        } catch { /* not JSON after all */ }
    }
    if (!message) return null;
    return String(message).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_MESSAGE_CHARS) || null;
}

const STATUS_REASONS = {
    400: 'NMBRS rejected the request (check the IDs and parameters)',
    401: 'NMBRS credentials are invalid or the token was revoked',
    403: 'this NMBRS account lacks rights to that data',
    404: 'the requested NMBRS record was not found',
    429: 'NMBRS rate limit reached — try again shortly',
    500: 'NMBRS returned a server error',
};

function mapNmbrsError(status, bodyText) {
    const reason = STATUS_REASONS[status] || `NMBRS returned HTTP ${status}`;
    let detail = null;
    try {
        detail = extractNmbrsErrorMessage(bodyText);
    } catch { /* body unreadable — keep the mapped reason */ }
    return new Error(detail ? `${reason}: ${detail}` : reason);
}

// ─── Transport ─────────────────────────────────────────────────

async function nmbrsFetch(url, { method = 'GET', headers, body = null }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (typeof timeout.unref === 'function') timeout.unref();
    try {
        return await fetch(url, {
            method,
            headers,
            body,
            // Credentials must never follow a redirect off the pinned host.
            redirect: 'error',
            signal: controller.signal,
        });
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`NMBRS request timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`);
        }
        throw new Error('Could not reach NMBRS. Check the subdomain and environment.');
    } finally {
        clearTimeout(timeout);
    }
}

async function safeText(response) {
    try { return await response.text(); } catch { return ''; }
}

/** REST request — GET only (the verb is hard-coded; no caller can change it). */
async function restRequest(creds, path, query = null) {
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    const url = buildRestUrl(creds.subdomain, path, creds.env) + qs;
    const response = await nmbrsFetch(url, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${creds.token}`,
            'X-Subdomain': creds.subdomain,
            'Accept': 'application/json',
        },
    });
    if (!response.ok) throw mapNmbrsError(response.status, await safeText(response));
    try {
        return await response.json();
    } catch {
        throw new Error('NMBRS returned an unexpected non-JSON response.');
    }
}

function buildSoapEnvelope(creds, service, method, params) {
    const ns = `${SOAP_NS_BASE}/${service}`;
    const inner = Object.entries(params || {})
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `<tns:${k}>${escapeXml(v)}</tns:${k}>`)
        .join('');
    return `<?xml version="1.0" encoding="utf-8"?>` +
        `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${ns}">` +
        `<soap:Header>` +
        `<tns:AuthHeaderWithDomain>` +
        `<tns:Username>${escapeXml(creds.email)}</tns:Username>` +
        `<tns:Token>${escapeXml(creds.token)}</tns:Token>` +
        `<tns:Domain>${escapeXml(creds.subdomain)}</tns:Domain>` +
        `</tns:AuthHeaderWithDomain>` +
        `</soap:Header>` +
        `<soap:Body><tns:${method}>${inner}</tns:${method}></soap:Body>` +
        `</soap:Envelope>`;
}

/** SOAP request — only read methods (SOAP_METHODS_READONLY) may be issued. */
async function soapRequest(creds, service, method, params = {}) {
    if (!SOAP_METHODS_READONLY.has(method)) {
        throw new Error('Refused: non-read NMBRS method.');
    }
    const url = buildSoapUrl(creds.subdomain, service, creds.env);
    const response = await nmbrsFetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': `${SOAP_NS_BASE}/${service}/${method}`,
        },
        body: buildSoapEnvelope(creds, service, method, params),
    });
    const text = await safeText(response);
    if (!response.ok) throw mapNmbrsError(response.status, text);
    let parsed;
    try {
        parsed = xmlParser.parse(text);
    } catch {
        throw new Error('NMBRS returned an unexpected non-XML response.');
    }
    return extractSoapResult(parsed, method);
}

// ─── Backend-agnostic entity fetchers ──────────────────────────
// Each returns an array of rows (or a single object for get_employee). The
// model never sees mode/service/path/method.

async function fetchDebtors(creds) {
    if (creds.mode === 'rest') {
        return restListFrom(await restRequest(creds, 'debtors'));
    }
    return coerceArray(await soapRequest(creds, 'DebtorService', 'Debtor_GetList'));
}

async function fetchCompanies(creds, debtorId) {
    if (creds.mode === 'rest') {
        const path = debtorId ? `debtors/${encodeURIComponent(debtorId)}/companies` : 'companies';
        return restListFrom(await restRequest(creds, path));
    }
    if (debtorId) {
        return coerceArray(await soapRequest(creds, 'CompanyService', 'Company_List_GetByDebtor', { DebtorId: debtorId }));
    }
    return coerceArray(await soapRequest(creds, 'CompanyService', 'Company_List_GetAll'));
}

async function fetchEmployees(creds, companyId, activeOnly) {
    if (creds.mode === 'rest') {
        return restListFrom(await restRequest(creds,
            `companies/${encodeURIComponent(companyId)}/employees`,
            activeOnly ? { active: 'true' } : null));
    }
    const method = activeOnly ? 'Employee_GetByCompany' : 'Employee_GetAllByCompany';
    return coerceArray(await soapRequest(creds, 'EmployeeService', method, { CompanyId: companyId }));
}

async function fetchEmployee(creds, employeeId) {
    if (creds.mode === 'rest') {
        return await restRequest(creds, `employees/${encodeURIComponent(employeeId)}`);
    }
    return await soapRequest(creds, 'EmployeeService', 'PersonalInfo_GetCurrent', { EmployeeId: employeeId });
}

async function fetchContracts(creds, employeeId) {
    if (creds.mode === 'rest') {
        return restListFrom(await restRequest(creds, `employees/${encodeURIComponent(employeeId)}/contracts`));
    }
    return coerceArray(await soapRequest(creds, 'EmployeeService', 'Contract_GetAll', { EmployeeId: employeeId }));
}

async function fetchSalaries(creds, employeeId) {
    if (creds.mode === 'rest') {
        return restListFrom(await restRequest(creds, `employees/${encodeURIComponent(employeeId)}/salaries`));
    }
    return coerceArray(await soapRequest(creds, 'EmployeeService', 'Salary_GetList', { EmployeeId: employeeId }));
}

async function fetchWageComponents(creds, employeeId, year, period) {
    if (creds.mode === 'rest') {
        const query = { year: String(year) };
        if (period) query.period = String(period);
        return restListFrom(await restRequest(creds, `employees/${encodeURIComponent(employeeId)}/wagecomponents`, query));
    }
    const params = { EmployeeId: employeeId, Year: year };
    if (period) params.Period = period;
    const fixed = coerceArray(await soapRequest(creds, 'EmployeeService', 'WageComponentFixed_Get', params));
    const variable = coerceArray(await soapRequest(creds, 'EmployeeService', 'WageComponentVar_Get', params));
    return [
        ...fixed.map((c) => ({ kind: 'fixed', ...c })),
        ...variable.map((c) => ({ kind: 'variable', ...c })),
    ];
}

async function fetchPayslips(creds, employeeId, year, period) {
    if (creds.mode === 'rest') {
        const query = { year: String(year) };
        if (period) query.period = String(period);
        return restListFrom(await restRequest(creds, `employees/${encodeURIComponent(employeeId)}/payslips`, query));
    }
    const params = { EmployeeId: employeeId, Year: year };
    if (period) params.Period = period;
    return coerceArray(await soapRequest(creds, 'ReportService', 'Reports_GetEmployeePayslips', params));
}

// ─── Credentials & execution ───────────────────────────────────

async function getNmbrsCredentials(userId) {
    const mode = (await configStore.getSecret(`nmbrs_api_mode_user_${userId}`)) === 'rest' ? 'rest' : 'soap';
    const subdomain = await configStore.getSecret(`nmbrs_subdomain_user_${userId}`);
    const token = await configStore.getSecret(`nmbrs_token_user_${userId}`);
    const email = await configStore.getSecret(`nmbrs_email_user_${userId}`);
    const env = resolveEnv(await configStore.getSecret(`nmbrs_env_user_${userId}`));
    if (!subdomain || !token) return null;
    if (mode === 'soap' && !email) return null; // SOAP needs Username + Token + Domain
    return { mode, subdomain: String(subdomain).trim(), token, email: email || '', env };
}

function validId(value) {
    return ID_RE.test(String(value || '').trim());
}

function parseYear(value) {
    const y = parseInt(value, 10);
    return (Number.isInteger(y) && y >= 1900 && y <= 2100) ? y : null;
}

function parsePeriod(value) {
    if (value === undefined || value === null || value === '') return null;
    const p = parseInt(value, 10);
    return (Number.isInteger(p) && p >= 1 && p <= 13) ? p : 'invalid';
}

async function executeNmbrsTool(toolName, args = {}, userId) {
    if (!userId) return { error: 'User context required for NMBRS.' };
    const creds = await getNmbrsCredentials(userId);
    if (!creds) {
        return { error: 'NMBRS not configured. Add your subdomain, token (and login email for the SOAP API) in Settings.' };
    }

    try {
        switch (toolName) {
            case 'nmbrs_list_debtors': {
                console.log('[NMBRS] Listing debtors');
                return shapeList(await fetchDebtors(creds), 'debtors');
            }
            case 'nmbrs_list_companies': {
                const debtorId = args.debtorId != null ? String(args.debtorId).trim() : '';
                if (debtorId && !validId(debtorId)) return { error: 'Invalid debtorId.' };
                console.log(`[NMBRS] Listing companies${debtorId ? ` for debtor ${debtorId}` : ''}`);
                return shapeList(await fetchCompanies(creds, debtorId || null), 'companies');
            }
            case 'nmbrs_list_employees': {
                const companyId = String(args.companyId || '').trim();
                if (!validId(companyId)) return { error: 'Invalid companyId. Use an ID from nmbrs_list_companies.' };
                const activeOnly = args.activeOnly !== false;
                console.log(`[NMBRS] Listing employees for company ${companyId} (activeOnly=${activeOnly})`);
                return shapeList(await fetchEmployees(creds, companyId, activeOnly), 'employees');
            }
            case 'nmbrs_get_employee': {
                const employeeId = String(args.employeeId || '').trim();
                if (!validId(employeeId)) return { error: 'Invalid employeeId. Use an ID from nmbrs_list_employees.' };
                console.log(`[NMBRS] Getting employee ${employeeId}`);
                const employee = await fetchEmployee(creds, employeeId);
                return { employee: employee ?? null };
            }
            case 'nmbrs_list_employee_contracts': {
                const employeeId = String(args.employeeId || '').trim();
                if (!validId(employeeId)) return { error: 'Invalid employeeId. Use an ID from nmbrs_list_employees.' };
                console.log(`[NMBRS] Listing contracts for employee ${employeeId}`);
                return shapeList(await fetchContracts(creds, employeeId), 'contracts');
            }
            case 'nmbrs_list_employee_salaries': {
                const employeeId = String(args.employeeId || '').trim();
                if (!validId(employeeId)) return { error: 'Invalid employeeId. Use an ID from nmbrs_list_employees.' };
                console.log(`[NMBRS] Listing salaries for employee ${employeeId}`);
                return shapeList(await fetchSalaries(creds, employeeId), 'salaries');
            }
            case 'nmbrs_list_employee_wage_components': {
                const employeeId = String(args.employeeId || '').trim();
                if (!validId(employeeId)) return { error: 'Invalid employeeId. Use an ID from nmbrs_list_employees.' };
                const year = parseYear(args.year);
                if (!year) return { error: 'Invalid year. Provide a 4-digit calendar year, e.g. 2026.' };
                const period = parsePeriod(args.period);
                if (period === 'invalid') return { error: 'Invalid period. Use a number 1-13 or omit it.' };
                console.log(`[NMBRS] Listing wage components for employee ${employeeId} (${year}${period ? `/${period}` : ''})`);
                return shapeList(await fetchWageComponents(creds, employeeId, year, period), 'wage components');
            }
            case 'nmbrs_list_payslips': {
                const employeeId = String(args.employeeId || '').trim();
                if (!validId(employeeId)) return { error: 'Invalid employeeId. Use an ID from nmbrs_list_employees.' };
                const year = parseYear(args.year);
                if (!year) return { error: 'Invalid year. Provide a 4-digit calendar year, e.g. 2026.' };
                const period = parsePeriod(args.period);
                if (period === 'invalid') return { error: 'Invalid period. Use a number 1-13 or omit it.' };
                console.log(`[NMBRS] Listing payslips for employee ${employeeId} (${year}${period ? `/${period}` : ''})`);
                return shapeList(await fetchPayslips(creds, employeeId, year, period), 'payslips');
            }
            default:
                return { error: `Unknown NMBRS tool: ${toolName}` };
        }
    } catch (err) {
        console.warn(`[NMBRS] ${toolName} failed: ${err.message}`);
        return { error: `NMBRS: ${err.message}` };
    }
}

function isNmbrsTool(toolName) {
    return NMBRS_TOOLS.some((t) => t.function.name === toolName);
}

module.exports = {
    NMBRS_TOOLS,
    executeNmbrsTool,
    isNmbrsTool,
    getNmbrsCredentials,
    // Pure helpers exported for unit tests.
    escapeXml,
    buildSoapUrl,
    buildRestUrl,
    buildSoapEnvelope,
    coerceArray,
    restListFrom,
    extractSoapResult,
    truncateRows,
    extractNmbrsErrorMessage,
    // Validation surfaces / constants for tests.
    SUBDOMAIN_RE,
    TOKEN_RE,
    EMAIL_RE,
    SOAP_METHODS_READONLY,
};
