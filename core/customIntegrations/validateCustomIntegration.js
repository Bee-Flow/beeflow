/**
 * Validate an org-scoped custom-integration definition (specVersion 1).
 *
 * Two kinds:
 *   - 'rest'       — declarative toolset executed by the hardened generic runner
 *   - 'mcp_remote' — vendor-hosted HTTP MCP server
 *
 * Returns { ok, errors[], warnings[] } where each record is
 * `{ code, severity, path, message, hint }` — the same structured shape as
 * automation/validate.js, so the AI builder loop can feed specific failures
 * back to the LLM for self-correction.
 *
 * Security invariants enforced here (the runner relies on them):
 *   - api.baseUrl / mcp.url: https only, no userinfo, no query/fragment
 *     (REST), hostname not a private/forbidden literal (ssrfGuard).
 *   - '{{credential.' may ONLY appear in auth.valueTemplate / mcp.valueTemplate.
 *   - pathTemplate cannot escape the base origin/path ('//', '://', '..',
 *     '?', '#', whitespace, raw %2f/%2e sequences).
 *   - header names pass a deny-list (transport + proxy/forwarding headers);
 *     header values are literals — never parameter- or credential-templated.
 *   - parameters schema is restricted: scalar types + array-of-scalar only,
 *     no nested objects, additionalProperties forced false at derivation.
 *
 * Run-time argument caps (string <= 2000 chars, array <= 100 items) are
 * enforced by the runner, not here.
 *
 * `strict: true` (used at activation) additionally promotes the lint set
 * (description injection, undeclared pagination params) from warnings to
 * errors. `ok` is always `errors.length === 0`.
 */

let ssrfGuard = null;
try {
    ssrfGuard = require('./ssrfGuard');
} catch {
    // ssrfGuard ships alongside this module; until it is on disk we fall
    // back to URL-parse-only checks. The runner performs its own resolving
    // SSRF check before every request, so the runtime guarantee holds.
    ssrfGuard = null;
}

const MAX_DEF_CHARS = 131072;
const MIN_TOOLS = 1;
const MAX_TOOLS = 30;
const MAX_PROPERTIES_PER_TOOL = 20;
const MAX_QUERY_ENTRIES = 15;
const MAX_HEADER_ENTRIES = 15;
const MAX_CREDENTIALS = 8;
const MAX_NOTES_CHARS = 4000;
const MAX_DESCRIPTION_CHARS = 1024;
const MAX_ENUM_ENTRY_CHARS = 200;
const MAX_TOOL_ALLOW_LIST = 100;
const MAX_COMBINED_NAME_CHARS = 64;
const MAX_BODY_TEMPLATE_DEPTH = 8;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;
const MIN_RESPONSE_CHARS = 1000;
const MAX_RESPONSE_CHARS = 30000;

const SLUG_RE = /^[a-z0-9]{4,16}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;
const CREDENTIAL_KEY_RE = /^[a-z][a-z0-9_]{0,40}$/;
const PARAM_NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const QUERY_NAME_RE = /^[A-Za-z0-9_.[\]-]{1,64}$/;
const AUTH_QUERY_PARAM_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const RESULT_PATH_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const PATH_PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;
const EXACT_PLACEHOLDER_RE = /^\{([A-Za-z0-9_]+)\}$/;
const CREDENTIAL_REF_RE = /\{\{credential\.([A-Za-z0-9_]+)\}\}/g;

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const AUTH_TYPES = new Set(['bearer', 'header', 'query', 'basic', 'none']);
const MCP_AUTH_STYLES = new Set(['bearer', 'header', 'none']);
const PAGINATION_STYLES = new Set(['page', 'offset', 'cursor', 'none']);
const PARAM_SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);
const PARAM_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array']);

// Transport / auth / proxy headers the runner owns; definitions may never
// set them (case-insensitive; prefixes cover proxy-* and x-forwarded-*).
const DENIED_HEADERS = new Set([
    'host', 'authorization', 'cookie', 'set-cookie', 'content-length',
    'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer',
]);
const DENIED_HEADER_PREFIXES = ['proxy-', 'x-forwarded-'];

// Imperative-injection lint over model-visible prose (tool descriptions,
// meta.notes). Warning normally; promoted to error under strict (activation).
const INJECTION_PHRASES = [
    'ignore previous', 'ignore all previous', 'disregard', 'system prompt',
    'you must always', 'always call', 'always send', 'do not tell',
    'password', 'secret key', 'api key', 'credential', 'token',
];

// The only two paths where '{{credential.*}}' is legal.
const VALUE_TEMPLATE_PATHS = new Set(['auth.valueTemplate', 'mcp.valueTemplate']);

function isObject(x) { return x && typeof x === 'object' && !Array.isArray(x); }

function isDeniedHeader(name, { forAuth = false } = {}) {
    const n = String(name).toLowerCase();
    // auth.header / mcp.header is where the credential is injected, so
    // 'Authorization' is legal there (bearer is just a shorthand for it).
    if (forAuth && n === 'authorization') return false;
    if (DENIED_HEADERS.has(n)) return true;
    return DENIED_HEADER_PREFIXES.some(p => n.startsWith(p));
}

function findInjectionPhrases(text) {
    const lower = String(text).toLowerCase();
    return INJECTION_PHRASES.filter(p => lower.includes(p));
}

/**
 * Sync, DNS-less host screen. ssrfGuard.normalizeHostname classifies the
 * host as a literal IP ('ip4'/'ip6', canonical = normalized address or null
 * when numeric-but-malformed) or a DNS 'name'. Literal IPs are range-checked
 * via isForbiddenAddress (which is fail-closed and only accepts literals —
 * never feed it a DNS name). Names get the full resolving check at request
 * time; here we only reject ones that can never be public (no dot, e.g.
 * 'localhost'/'intranet', or *.localhost).
 */
function hostIsForbidden(hostname) {
    if (!ssrfGuard) return false;
    try {
        const norm = ssrfGuard.normalizeHostname(hostname);
        if (norm && typeof norm === 'object') {
            if (norm.kind === 'name') {
                const name = norm.canonical;
                return !name || !name.includes('.') || name.endsWith('.localhost');
            }
            return norm.canonical === null || !!ssrfGuard.isForbiddenAddress(norm.canonical);
        }
        // Defensive fallback for a string-returning normalize variant.
        const s = typeof norm === 'string' && norm ? norm : String(hostname).toLowerCase();
        if (/^[0-9.]+$/.test(s) || s.includes(':')) return !!ssrfGuard.isForbiddenAddress(s);
        return !s.includes('.') || s.endsWith('.localhost');
    } catch {
        // A guard that throws on this hostname is rejecting hostile input.
        return true;
    }
}

/**
 * Walk the whole definition and report every string (or key) containing
 * '{{credential.' outside the two sanctioned valueTemplate paths.
 */
function findCredentialLeaks(value, path, out) {
    if (typeof value === 'string') {
        if (!VALUE_TEMPLATE_PATHS.has(path) && value.includes('{{credential.')) out.push(path || '(root)');
        return;
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) findCredentialLeaks(value[i], `${path}[${i}]`, out);
        return;
    }
    if (value && typeof value === 'object') {
        for (const k of Object.keys(value)) {
            const childPath = path ? `${path}.${k}` : k;
            if (k.includes('{{credential.')) out.push(childPath);
            findCredentialLeaks(value[k], childPath, out);
        }
    }
}

/**
 * Collect exact-match "{param}" string leaves from a JSON body template.
 * Strings that merely *contain* braces are literals per the spec.
 */
function collectBodyPlaceholders(node, path, depth, out) {
    if (depth > MAX_BODY_TEMPLATE_DEPTH) { out.tooDeep.push(path); return; }
    if (typeof node === 'string') {
        const m = node.match(EXACT_PLACEHOLDER_RE);
        if (m) out.placeholders.push({ name: m[1], path });
        return;
    }
    if (Array.isArray(node)) {
        node.forEach((v, i) => collectBodyPlaceholders(v, `${path}[${i}]`, depth + 1, out));
        return;
    }
    if (node && typeof node === 'object') {
        for (const k of Object.keys(node)) collectBodyPlaceholders(node[k], `${path}.${k}`, depth + 1, out);
    }
    // number / boolean / null leaves are literals.
}

/**
 * Validate a definition for an org-scoped custom integration.
 *
 * @param {object} def                 the JSONB definition blob
 * @param {object} [opts]
 * @param {string} [opts.kind='rest']  'rest' | 'mcp_remote'
 * @param {boolean} [opts.strict]      promote lint findings to errors (activation)
 * @param {string} [opts.slug]         integration slug; enables the combined
 *                                     cint_<slug>_<tool> length check
 */
function validateCustomIntegration(def, { kind = 'rest', strict = false, slug = null } = {}) {
    const errors = [];
    const warnings = [];
    const pushE = (rec) => errors.push({ ...rec, severity: 'error' });
    const pushW = (rec) => warnings.push({ ...rec, severity: 'warning' });
    // Promotable lint set: warnings normally, blocking errors under strict.
    const pushLint = (rec) => (strict ? pushE(rec) : pushW(rec));

    if (kind !== 'rest' && kind !== 'mcp_remote') {
        return {
            ok: false,
            errors: [{ code: 'def.kind_invalid', severity: 'error', path: '', message: `Unknown integration kind "${kind}".`, hint: "Use 'rest' or 'mcp_remote'." }],
            warnings: [],
        };
    }
    if (slug !== null && slug !== undefined && (typeof slug !== 'string' || !SLUG_RE.test(slug))) {
        pushE({ code: 'def.slug_invalid', path: '', message: `Slug "${slug}" must match ^[a-z0-9]{4,16}$ (no underscores).`, hint: 'Pick 4-16 lowercase letters/digits; underscores are reserved as the tool-name separator.' });
    }
    if (!isObject(def)) {
        pushE({ code: 'def.not_object', path: '', message: 'Definition must be a JSON object.', hint: 'Pass the definition blob, e.g. { specVersion: 1, api: {...}, auth: {...}, tools: [...] }.' });
        return { ok: false, errors, warnings };
    }

    // Serializability + size cap — bail out on circular structures before
    // any tree walk would recurse forever.
    let serialized;
    try {
        serialized = JSON.stringify(def);
    } catch {
        pushE({ code: 'def.not_serializable', path: '', message: 'Definition must be JSON-serializable (no circular references).', hint: 'Build the definition as plain JSON data.' });
        return { ok: false, errors, warnings };
    }
    if (serialized.length > MAX_DEF_CHARS) {
        pushE({ code: 'def.too_large', path: '', message: `Definition is ${serialized.length} chars; the cap is ${MAX_DEF_CHARS}.`, hint: 'Trim notes/descriptions or split the integration into smaller ones.' });
    }

    if (def.specVersion !== 1) {
        pushE({ code: 'def.spec_version_unsupported', path: 'specVersion', message: `specVersion must be 1 (got ${JSON.stringify(def.specVersion)}).`, hint: 'Set "specVersion": 1.' });
    }

    // Global credential ban — '{{credential.' is only legal in the auth/mcp
    // value template. Anything else would exfiltrate the secret into URLs,
    // bodies, headers or model-visible text.
    const leaks = [];
    findCredentialLeaks(def, '', leaks);
    for (const p of leaks) {
        pushE({ code: 'auth.credential_ref_outside_auth', path: p, message: `'{{credential.*}}' found outside ${kind === 'rest' ? 'auth.valueTemplate' : 'mcp.valueTemplate'}.`, hint: 'Credentials are injected exclusively via the auth value template. Remove the reference; pass request data through tool parameters instead.' });
    }

    // Kind/shape cross-checks + unknown top-level keys.
    const allowedTop = kind === 'rest'
        ? new Set(['specVersion', 'meta', 'api', 'auth', 'tools'])
        : new Set(['specVersion', 'meta', 'mcp']);
    const mismatched = kind === 'rest'
        ? ['mcp'].filter(k => def[k] !== undefined)
        : ['api', 'auth', 'tools'].filter(k => def[k] !== undefined);
    for (const k of mismatched) {
        pushE({ code: 'def.kind_mismatch', path: k, message: `Key "${k}" does not belong in a ${kind} definition.`, hint: kind === 'rest' ? "REST definitions use api/auth/tools; 'mcp' is only valid for kind mcp_remote." : "mcp_remote definitions use only the 'mcp' block; api/auth/tools are REST-only." });
    }
    for (const k of Object.keys(def)) {
        if (!allowedTop.has(k) && !mismatched.includes(k)) {
            pushW({ code: 'def.unknown_key', path: k, message: `Unknown top-level key "${k}" is ignored.`, hint: `Allowed keys for kind ${kind}: ${[...allowedTop].join(', ')}.` });
        }
    }

    // ── meta (informational) ─────────────────────────────────────────────
    if (def.meta !== undefined) {
        if (!isObject(def.meta)) {
            pushE({ code: 'meta.invalid', path: 'meta', message: 'meta must be an object.', hint: 'Use { docsUrl, notes } or omit meta entirely.' });
        } else {
            if (def.meta.docsUrl !== undefined) {
                let okUrl = false;
                if (typeof def.meta.docsUrl === 'string') {
                    try { const u = new URL(def.meta.docsUrl); okUrl = u.protocol === 'https:' || u.protocol === 'http:'; } catch { okUrl = false; }
                }
                if (!okUrl) pushE({ code: 'meta.docs_url_invalid', path: 'meta.docsUrl', message: 'meta.docsUrl must be an http(s) URL.', hint: 'Link the vendor API docs, or omit the field.' });
            }
            if (def.meta.notes !== undefined) {
                if (typeof def.meta.notes !== 'string') {
                    pushE({ code: 'meta.notes_invalid', path: 'meta.notes', message: 'meta.notes must be a string.', hint: 'Free-text notes for reviewers, max 4000 chars.' });
                } else {
                    if (def.meta.notes.length > MAX_NOTES_CHARS) {
                        pushE({ code: 'meta.notes_too_long', path: 'meta.notes', message: `meta.notes is ${def.meta.notes.length} chars; the cap is ${MAX_NOTES_CHARS}.`, hint: 'Shorten the notes.' });
                    }
                    const phrases = findInjectionPhrases(def.meta.notes);
                    if (phrases.length) {
                        pushLint({ code: 'meta.notes_injection', path: 'meta.notes', message: `meta.notes contains instruction-like or secret-related phrasing (${phrases.map(p => `"${p}"`).join(', ')}).`, hint: 'Notes may be shown to the model; describe the API factually and never include instructions or secret material.' });
                    }
                }
            }
        }
    }

    // ── shared field validators (close over pushE/pushW) ─────────────────
    const checkHttpsUrl = (raw, { path, codePrefix, allowQuery, requiredLabel }) => {
        if (typeof raw !== 'string' || !raw) {
            pushE({ code: `${codePrefix}_invalid`, path, message: `${requiredLabel} is required and must be a string URL.`, hint: 'Provide an absolute https URL.' });
            return;
        }
        let u;
        try { u = new URL(raw); } catch {
            pushE({ code: `${codePrefix}_invalid`, path, message: `${requiredLabel} "${raw}" is not a valid URL.`, hint: 'Provide an absolute https URL like https://api.example.com/v2.' });
            return;
        }
        if (u.protocol !== 'https:') {
            pushE({ code: `${codePrefix}_not_https`, path, message: `${requiredLabel} must use https (got ${u.protocol.replace(':', '')}).`, hint: 'Plain-text transports are not allowed for credentialed requests.' });
        }
        if (!u.hostname) {
            pushE({ code: `${codePrefix}_invalid`, path, message: `${requiredLabel} has no hostname.`, hint: 'Provide a full origin like https://api.example.com.' });
        }
        if (u.username || u.password) {
            pushE({ code: `${codePrefix}_userinfo`, path, message: `${requiredLabel} must not embed userinfo (user:pass@).`, hint: 'Move credentials into auth.credentials; they are stored encrypted per connection.' });
        }
        if (!allowQuery && (u.search || u.hash)) {
            pushE({ code: `${codePrefix}_query_fragment`, path, message: `${requiredLabel} must not contain a query string or fragment.`, hint: 'Put query parameters on individual tools instead.' });
        }
        if (u.hostname && hostIsForbidden(u.hostname)) {
            pushE({ code: `${codePrefix}_forbidden_host`, path, message: `${requiredLabel} host "${u.hostname}" resolves to a private/forbidden address class.`, hint: 'Only public vendor hosts are allowed; localhost, private ranges and link-local addresses are blocked.' });
        }
    };

    const checkHeaderMap = (map, basePath, codes, labelPrefix) => {
        const names = Object.keys(map);
        if (names.length > MAX_HEADER_ENTRIES) {
            pushE({ code: codes.tooMany, path: basePath, message: `${labelPrefix} has ${names.length} headers; the cap is ${MAX_HEADER_ENTRIES}.`, hint: 'Remove headers the API does not strictly need.' });
        }
        for (const name of names) {
            const at = `${basePath}.${name}`;
            if (!HEADER_NAME_RE.test(name)) {
                pushE({ code: codes.name, path: at, message: `${labelPrefix} header name "${name}" is invalid.`, hint: 'Header names must match ^[A-Za-z0-9-]{1,64}$.' });
            } else if (isDeniedHeader(name)) {
                pushE({ code: codes.denied, path: at, message: `${labelPrefix} header "${name}" is not allowed.`, hint: 'Transport, auth, cookie and proxy/forwarding headers are managed by the runner and cannot be set in a definition.' });
            }
            const v = map[name];
            if (typeof v !== 'string') {
                pushE({ code: codes.value, path: at, message: `${labelPrefix} header "${name}" value must be a literal string.`, hint: 'Headers cannot reference parameters or credentials.' });
            } else if (v.includes('{{') || EXACT_PLACEHOLDER_RE.test(v)) {
                pushE({ code: codes.value, path: at, message: `${labelPrefix} header "${name}" value must be a literal — no {{…}} or {param} templating.`, hint: 'Only auth.valueTemplate may carry a credential reference; parameter values belong in query or body.' });
            }
        }
    };

    const checkValueTemplate = (vt, declaredKeys, path, codePrefix) => {
        const refs = [];
        const leftover = vt.replace(CREDENTIAL_REF_RE, (m, key) => { refs.push(key); return ''; });
        if (leftover.includes('{{') || leftover.includes('}}')) {
            pushE({ code: `${codePrefix}.value_template_invalid`, path, message: 'valueTemplate may only contain literal text plus {{credential.<key>}} references.', hint: 'Check for typos in the {{credential.…}} syntax; keys must match ^[a-z][a-z0-9_]{0,40}$.' });
        }
        for (const key of refs) {
            if (!declaredKeys.has(key)) {
                pushE({ code: `${codePrefix}.credential_key_undeclared`, path, message: `valueTemplate references undeclared credential key "${key}".`, hint: `Declare it in ${codePrefix}.credentials, or fix the reference. Declared keys: ${[...declaredKeys].join(', ') || '(none)'}.` });
            }
        }
        if (refs.length === 0) {
            pushW({ code: `${codePrefix}.value_template_static`, path, message: 'valueTemplate references no {{credential.*}} key — a literal secret embedded here would be stored unencrypted in the definition.', hint: 'Declare a credential and reference it, e.g. "Bearer {{credential.api_key}}".' });
        }
    };

    const checkCredentialList = (creds, basePath, codePrefix) => {
        const declared = new Set();
        if (creds === undefined) return declared;
        if (!Array.isArray(creds)) {
            pushE({ code: `${codePrefix}.credentials_invalid`, path: `${basePath}.credentials`, message: 'credentials must be an array of { key, label, description }.', hint: 'List the secrets the user must supply when connecting.' });
            return declared;
        }
        if (creds.length > MAX_CREDENTIALS) {
            pushE({ code: `${codePrefix}.credentials_too_many`, path: `${basePath}.credentials`, message: `${creds.length} credentials declared; the cap is ${MAX_CREDENTIALS}.`, hint: 'Most APIs need 1-2 secrets; remove the rest.' });
        }
        creds.forEach((c, i) => {
            const at = `${basePath}.credentials[${i}]`;
            if (!isObject(c)) {
                pushE({ code: `${codePrefix}.credentials_invalid`, path: at, message: 'Each credential must be an object { key, label, description }.', hint: 'Example: { "key": "api_key", "label": "API key" }.' });
                return;
            }
            if (typeof c.key !== 'string' || !CREDENTIAL_KEY_RE.test(c.key)) {
                pushE({ code: `${codePrefix}.credential_key_invalid`, path: `${at}.key`, message: `Credential key ${JSON.stringify(c.key)} must match ^[a-z][a-z0-9_]{0,40}$.`, hint: 'Lowercase snake_case, starting with a letter.' });
            } else if (declared.has(c.key)) {
                pushE({ code: `${codePrefix}.credential_key_duplicate`, path: `${at}.key`, message: `Duplicate credential key "${c.key}".`, hint: 'Keys must be unique.' });
            } else {
                declared.add(c.key);
            }
            if (typeof c.label !== 'string' || !c.label.trim() || c.label.length > 200) {
                pushE({ code: `${codePrefix}.credential_label_invalid`, path: `${at}.label`, message: 'Each credential needs a non-empty label (max 200 chars).', hint: 'The label is shown on the connect form.' });
            }
            if (c.description !== undefined && (typeof c.description !== 'string' || c.description.length > 1000)) {
                pushE({ code: `${codePrefix}.credential_description_invalid`, path: `${at}.description`, message: 'Credential description must be a string of at most 1000 chars.', hint: 'Explain where the user finds this secret, or omit it.' });
            }
        });
        return declared;
    };

    const checkIntRange = (v, lo, hi, path, code, label) => {
        if (v === undefined) return;
        if (!Number.isInteger(v) || v < lo || v > hi) {
            pushE({ code, path, message: `${label} must be an integer between ${lo} and ${hi} (got ${JSON.stringify(v)}).`, hint: `Pick a value in [${lo}, ${hi}] or omit it for the default.` });
        }
    };

    if (kind === 'rest') {
        // ── api ──────────────────────────────────────────────────────────
        if (!isObject(def.api)) {
            pushE({ code: 'api.missing', path: 'api', message: 'Missing or invalid `api` block.', hint: 'Provide { baseUrl, defaultHeaders?, timeoutMs?, maxResponseChars? }.' });
        } else {
            checkHttpsUrl(def.api.baseUrl, { path: 'api.baseUrl', codePrefix: 'api.base_url', allowQuery: false, requiredLabel: 'api.baseUrl' });
            if (def.api.defaultHeaders !== undefined) {
                if (!isObject(def.api.defaultHeaders)) {
                    pushE({ code: 'api.default_headers_invalid', path: 'api.defaultHeaders', message: 'api.defaultHeaders must be an object map of literal strings.', hint: 'Example: { "Accept": "application/json" }.' });
                } else {
                    checkHeaderMap(def.api.defaultHeaders, 'api.defaultHeaders', {
                        tooMany: 'api.default_headers_too_many',
                        name: 'api.default_header_name_invalid',
                        denied: 'api.default_header_denied',
                        value: 'api.default_header_value_not_literal',
                    }, 'api.defaultHeaders');
                }
            }
            checkIntRange(def.api.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, 'api.timeoutMs', 'api.timeout_invalid', 'api.timeoutMs');
            checkIntRange(def.api.maxResponseChars, MIN_RESPONSE_CHARS, MAX_RESPONSE_CHARS, 'api.maxResponseChars', 'api.max_response_chars_invalid', 'api.maxResponseChars');
        }

        // ── auth ─────────────────────────────────────────────────────────
        let declaredCreds = new Set();
        if (!isObject(def.auth)) {
            pushE({ code: 'auth.missing', path: 'auth', message: 'Missing or invalid `auth` block.', hint: 'Provide { type, … }; use { "type": "none" } for unauthenticated APIs.' });
        } else {
            const auth = def.auth;
            if (!AUTH_TYPES.has(auth.type)) {
                pushE({ code: 'auth.type_invalid', path: 'auth.type', message: `auth.type must be one of bearer|header|query|basic|none (got ${JSON.stringify(auth.type)}).`, hint: 'Pick the scheme the vendor documents.' });
            }
            declaredCreds = checkCredentialList(auth.credentials, 'auth', 'auth');

            const needsTemplate = auth.type === 'bearer' || auth.type === 'header' || auth.type === 'query';
            if (needsTemplate) {
                if (typeof auth.valueTemplate !== 'string' || !auth.valueTemplate) {
                    pushE({ code: 'auth.value_template_missing', path: 'auth.valueTemplate', message: `auth.type "${auth.type}" requires auth.valueTemplate.`, hint: 'Example: "Bearer {{credential.api_key}}".' });
                } else {
                    checkValueTemplate(auth.valueTemplate, declaredCreds, 'auth.valueTemplate', 'auth');
                }
            }
            if (auth.type === 'basic') {
                if (!declaredCreds.has('username') || !declaredCreds.has('password')) {
                    pushE({ code: 'auth.basic_credentials_missing', path: 'auth.credentials', message: 'auth.type "basic" requires credentials with keys "username" and "password".', hint: 'Declare both; the runner builds the Basic header from them.' });
                }
                if (auth.valueTemplate !== undefined) {
                    if (typeof auth.valueTemplate !== 'string') {
                        pushE({ code: 'auth.value_template_invalid', path: 'auth.valueTemplate', message: 'auth.valueTemplate must be a string when present.', hint: 'Omit it for basic auth; the runner derives the header.' });
                    } else {
                        checkValueTemplate(auth.valueTemplate, declaredCreds, 'auth.valueTemplate', 'auth');
                    }
                }
            }
            if (auth.type === 'none' && auth.valueTemplate !== undefined) {
                pushE({ code: 'auth.value_template_unexpected', path: 'auth.valueTemplate', message: 'auth.type "none" must not carry a valueTemplate.', hint: 'Remove auth.valueTemplate or pick an auth type that injects it.' });
            }
            if (auth.type === 'header') {
                if (typeof auth.header !== 'string' || !HEADER_NAME_RE.test(auth.header)) {
                    pushE({ code: 'auth.header_invalid', path: 'auth.header', message: 'auth.type "header" requires a valid auth.header name.', hint: 'Example: "X-Api-Key" (must match ^[A-Za-z0-9-]{1,64}$).' });
                } else if (isDeniedHeader(auth.header, { forAuth: true })) {
                    pushE({ code: 'auth.header_denied', path: 'auth.header', message: `auth.header "${auth.header}" is a managed transport header.`, hint: 'Use the vendor\'s API-key header, or auth.type "bearer" for Authorization.' });
                }
            }
            if (auth.type === 'query') {
                if (typeof auth.queryParam !== 'string' || !AUTH_QUERY_PARAM_RE.test(auth.queryParam)) {
                    pushE({ code: 'auth.query_param_invalid', path: 'auth.queryParam', message: 'auth.type "query" requires a valid auth.queryParam name.', hint: 'Example: "api_key".' });
                }
                pushW({ code: 'auth.query_secret', path: 'auth.type', message: 'Query-string auth places the secret in URLs, where logs, proxies and referrers can capture it.', hint: 'Prefer a header-based scheme if the vendor supports one.' });
            }
        }

        // ── tools ────────────────────────────────────────────────────────
        if (!Array.isArray(def.tools) || def.tools.length < MIN_TOOLS) {
            pushE({ code: 'tools.missing', path: 'tools', message: 'Definition needs a non-empty `tools` array.', hint: 'Declare 1 to 30 tools.' });
        } else {
            if (def.tools.length > MAX_TOOLS) {
                pushE({ code: 'tools.too_many', path: 'tools', message: `${def.tools.length} tools declared; the cap is ${MAX_TOOLS}.`, hint: 'Split into multiple integrations or drop rarely used endpoints.' });
            }
            const seenNames = new Set();
            def.tools.forEach((tool, i) => {
                const at = `tools[${i}]`;
                if (!isObject(tool)) {
                    pushE({ code: 'tool.not_object', path: at, message: 'Each tool must be an object.', hint: 'See the specVersion 1 tool shape: { name, description, method, pathTemplate, … }.' });
                    return;
                }
                const label = typeof tool.name === 'string' && tool.name ? tool.name : `#${i}`;

                // name
                if (typeof tool.name !== 'string' || !TOOL_NAME_RE.test(tool.name)) {
                    pushE({ code: 'tool.name_invalid', path: `${at}.name`, message: `Tool ${label}: name must match ^[a-z][a-z0-9_]{2,40}$.`, hint: 'Lowercase snake_case, 3-41 chars, starting with a letter.' });
                } else if (seenNames.has(tool.name)) {
                    pushE({ code: 'tool.name_duplicate', path: `${at}.name`, message: `Duplicate tool name "${tool.name}".`, hint: 'Tool names must be unique within the integration.' });
                } else {
                    seenNames.add(tool.name);
                }
                if (typeof slug === 'string' && typeof tool.name === 'string') {
                    const combined = `cint_${slug}_${tool.name}`;
                    if (combined.length > MAX_COMBINED_NAME_CHARS) {
                        pushE({ code: 'tool.name_too_long', path: `${at}.name`, message: `Tool ${label}: combined name "${combined}" is ${combined.length} chars; the cap is ${MAX_COMBINED_NAME_CHARS}.`, hint: 'Shorten the tool name.' });
                    }
                }

                // description (+ injection lint)
                if (typeof tool.description !== 'string' || tool.description.length < 1 || tool.description.length > MAX_DESCRIPTION_CHARS) {
                    pushE({ code: 'tool.description_invalid', path: `${at}.description`, message: `Tool ${label}: description must be a string of 1..${MAX_DESCRIPTION_CHARS} chars.`, hint: 'One or two sentences describing what the endpoint does.' });
                } else {
                    const phrases = findInjectionPhrases(tool.description);
                    if (phrases.length) {
                        pushLint({ code: 'tool.description_injection', path: `${at}.description`, message: `Tool ${label}: description contains instruction-like or secret-related phrasing (${phrases.map(p => `"${p}"`).join(', ')}).`, hint: 'Descriptions are read by the model; describe the endpoint factually and never give the model instructions or mention secrets.' });
                    }
                }

                // method
                if (!METHODS.has(tool.method)) {
                    pushE({ code: 'tool.method_invalid', path: `${at}.method`, message: `Tool ${label}: method must be one of GET|POST|PUT|PATCH|DELETE (got ${JSON.stringify(tool.method)}).`, hint: 'Use the uppercase HTTP verb.' });
                }

                // parameters schema first — path/query/body cross-check against it.
                const declaredParams = new Set();
                const requiredParams = new Set();
                if (tool.parameters !== undefined) {
                    const params = tool.parameters;
                    if (!isObject(params)) {
                        pushE({ code: 'tool.param_schema_invalid', path: `${at}.parameters`, message: `Tool ${label}: parameters must be a JSON-schema object.`, hint: 'Use { "type": "object", "properties": {…}, "required": […] }.' });
                    } else {
                        if (params.type !== 'object') {
                            pushE({ code: 'tool.param_schema_invalid', path: `${at}.parameters.type`, message: `Tool ${label}: parameters.type must be "object".`, hint: 'The schema root is always an object of named arguments.' });
                        }
                        const allowedRoot = new Set(['type', 'properties', 'required', 'additionalProperties', 'description']);
                        for (const k of Object.keys(params)) {
                            if (!allowedRoot.has(k)) {
                                pushE({ code: 'tool.param_schema_invalid', path: `${at}.parameters.${k}`, message: `Tool ${label}: unsupported schema keyword "${k}".`, hint: `Allowed root keywords: ${[...allowedRoot].join(', ')}.` });
                            }
                        }
                        if (params.additionalProperties !== undefined && params.additionalProperties !== false) {
                            pushE({ code: 'tool.param_schema_invalid', path: `${at}.parameters.additionalProperties`, message: `Tool ${label}: additionalProperties must be false.`, hint: 'Omit it — it is forced to false at activation.' });
                        }
                        if (params.properties !== undefined) {
                            if (!isObject(params.properties)) {
                                pushE({ code: 'tool.param_schema_invalid', path: `${at}.parameters.properties`, message: `Tool ${label}: parameters.properties must be an object.`, hint: 'Map of parameter name → schema.' });
                            } else {
                                const names = Object.keys(params.properties);
                                if (names.length > MAX_PROPERTIES_PER_TOOL) {
                                    pushE({ code: 'tool.params_too_many', path: `${at}.parameters.properties`, message: `Tool ${label}: ${names.length} parameters declared; the cap is ${MAX_PROPERTIES_PER_TOOL}.`, hint: 'Drop parameters the model does not need.' });
                                }
                                for (const pname of names) {
                                    const pAt = `${at}.parameters.properties.${pname}`;
                                    if (!PARAM_NAME_RE.test(pname)) {
                                        pushE({ code: 'tool.param_name_invalid', path: pAt, message: `Tool ${label}: parameter name "${pname}" must match ^[a-z][a-z0-9_]{0,40}$.`, hint: 'Lowercase snake_case, starting with a letter.' });
                                    }
                                    declaredParams.add(pname);
                                    const schema = params.properties[pname];
                                    if (!isObject(schema)) {
                                        pushE({ code: 'tool.param_schema_invalid', path: pAt, message: `Tool ${label}: parameter "${pname}" schema must be an object.`, hint: 'Example: { "type": "string", "description": "…" }.' });
                                        continue;
                                    }
                                    const allowedProp = new Set(['type', 'description', 'enum', 'items']);
                                    for (const k of Object.keys(schema)) {
                                        if (!allowedProp.has(k)) {
                                            pushE({ code: 'tool.param_schema_invalid', path: `${pAt}.${k}`, message: `Tool ${label}: parameter "${pname}" uses unsupported keyword "${k}".`, hint: `Allowed keywords: ${[...allowedProp].join(', ')}.` });
                                        }
                                    }
                                    if (!PARAM_TYPES.has(schema.type)) {
                                        const nested = schema.type === 'object';
                                        pushE({ code: 'tool.param_schema_invalid', path: `${pAt}.type`, message: nested ? `Tool ${label}: parameter "${pname}" is a nested object — not allowed.` : `Tool ${label}: parameter "${pname}" type must be string|number|integer|boolean|array.`, hint: nested ? 'Flatten nested data into scalar parameters, or accept a JSON string.' : 'Pick one of the supported scalar types or array-of-scalar.' });
                                    }
                                    if (schema.description !== undefined && (typeof schema.description !== 'string' || schema.description.length > MAX_DESCRIPTION_CHARS)) {
                                        pushE({ code: 'tool.param_description_invalid', path: `${pAt}.description`, message: `Tool ${label}: parameter "${pname}" description must be a string of at most ${MAX_DESCRIPTION_CHARS} chars.`, hint: 'Keep parameter descriptions short.' });
                                    }
                                    if (schema.enum !== undefined) {
                                        if (schema.type !== 'string') {
                                            pushE({ code: 'tool.param_enum_invalid', path: `${pAt}.enum`, message: `Tool ${label}: enum is only supported on string parameters.`, hint: 'Change the type to string or drop the enum.' });
                                        } else if (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.some(e => typeof e !== 'string' || e.length > MAX_ENUM_ENTRY_CHARS)) {
                                            pushE({ code: 'tool.param_enum_invalid', path: `${pAt}.enum`, message: `Tool ${label}: enum must be a non-empty array of strings, each at most ${MAX_ENUM_ENTRY_CHARS} chars.`, hint: 'List the allowed literal values.' });
                                        }
                                    }
                                    if (schema.type === 'array') {
                                        const items = schema.items;
                                        if (!isObject(items) || !PARAM_SCALAR_TYPES.has(items.type)) {
                                            pushE({ code: 'tool.param_schema_invalid', path: `${pAt}.items`, message: `Tool ${label}: array parameter "${pname}" items must be scalar (string|number|integer|boolean).`, hint: 'Arrays of objects are not supported; accept a JSON string instead.' });
                                        } else {
                                            const allowedItems = new Set(['type', 'description', 'enum']);
                                            for (const k of Object.keys(items)) {
                                                if (!allowedItems.has(k)) {
                                                    pushE({ code: 'tool.param_schema_invalid', path: `${pAt}.items.${k}`, message: `Tool ${label}: items uses unsupported keyword "${k}".`, hint: `Allowed item keywords: ${[...allowedItems].join(', ')}.` });
                                                }
                                            }
                                            if (items.enum !== undefined && (items.type !== 'string' || !Array.isArray(items.enum) || items.enum.length === 0 || items.enum.some(e => typeof e !== 'string' || e.length > MAX_ENUM_ENTRY_CHARS))) {
                                                pushE({ code: 'tool.param_enum_invalid', path: `${pAt}.items.enum`, message: `Tool ${label}: items.enum must be a non-empty array of strings (string items only), each at most ${MAX_ENUM_ENTRY_CHARS} chars.`, hint: 'List the allowed literal values.' });
                                            }
                                        }
                                    } else if (schema.items !== undefined) {
                                        pushE({ code: 'tool.param_schema_invalid', path: `${pAt}.items`, message: `Tool ${label}: "items" is only valid on array parameters.`, hint: 'Remove items or set type to array.' });
                                    }
                                }
                            }
                        }
                        if (params.required !== undefined) {
                            if (!Array.isArray(params.required)) {
                                pushE({ code: 'tool.param_schema_invalid', path: `${at}.parameters.required`, message: `Tool ${label}: parameters.required must be an array of property names.`, hint: 'Example: ["invoice_id"].' });
                            } else {
                                params.required.forEach((rname, j) => {
                                    if (typeof rname !== 'string' || !declaredParams.has(rname)) {
                                        pushE({ code: 'tool.param_required_unknown', path: `${at}.parameters.required[${j}]`, message: `Tool ${label}: required entry ${JSON.stringify(rname)} is not a declared property.`, hint: `Declared properties: ${[...declaredParams].join(', ') || '(none)'}.` });
                                    } else {
                                        requiredParams.add(rname);
                                    }
                                });
                            }
                        }
                    }
                }

                // pathTemplate
                const pt = tool.pathTemplate;
                if (typeof pt !== 'string' || !/^\/(?!\/)/.test(pt)) {
                    pushE({ code: 'tool.path_invalid', path: `${at}.pathTemplate`, message: `Tool ${label}: pathTemplate must start with a single '/'.`, hint: "Use a relative path like '/invoices/{invoice_id}' — the origin comes from api.baseUrl." });
                } else {
                    if (pt.includes('://')) {
                        pushE({ code: 'tool.path_invalid', path: `${at}.pathTemplate`, message: `Tool ${label}: pathTemplate must not contain '://'.`, hint: 'Absolute URLs are not allowed; all requests stay on api.baseUrl.' });
                    }
                    if (/[?#]/.test(pt)) {
                        pushE({ code: 'tool.path_invalid', path: `${at}.pathTemplate`, message: `Tool ${label}: pathTemplate must not contain '?' or '#'.`, hint: 'Declare query parameters in the `query` map instead.' });
                    }
                    if (/\s/.test(pt)) {
                        pushE({ code: 'tool.path_invalid', path: `${at}.pathTemplate`, message: `Tool ${label}: pathTemplate must not contain whitespace.`, hint: 'Percent-encode literal segments if needed.' });
                    }
                    if (pt.includes('\\')) {
                        // WHATWG URL parsing turns '\' into '/' ('/\evil.com'
                        // → '//evil.com'), which would escape the origin pin.
                        pushE({ code: 'tool.path_invalid', path: `${at}.pathTemplate`, message: `Tool ${label}: pathTemplate must not contain '\\'.`, hint: 'URL parsers treat backslashes as slashes; use forward slashes only.' });
                    }
                    if (/%2f|%2e/i.test(pt)) {
                        pushE({ code: 'tool.path_traversal', path: `${at}.pathTemplate`, message: `Tool ${label}: pathTemplate contains raw %2f/%2e sequences.`, hint: 'Encoded slash/dot sequences can smuggle traversal past the origin pin; spell the path out literally.' });
                    }
                    if (pt.includes('..')) {
                        pushE({ code: 'tool.path_traversal', path: `${at}.pathTemplate`, message: `Tool ${label}: pathTemplate contains '..'.`, hint: 'Parent-directory segments are not allowed.' });
                    }
                    PATH_PLACEHOLDER_RE.lastIndex = 0;
                    let m;
                    while ((m = PATH_PLACEHOLDER_RE.exec(pt))) {
                        const p = m[1];
                        if (!declaredParams.has(p)) {
                            pushE({ code: 'tool.path_param_undeclared', path: `${at}.pathTemplate`, message: `Tool ${label}: path placeholder {${p}} is not a declared parameter.`, hint: `Add "${p}" to parameters.properties and parameters.required.` });
                        } else if (!requiredParams.has(p)) {
                            pushE({ code: 'tool.path_param_not_required', path: `${at}.pathTemplate`, message: `Tool ${label}: path placeholder {${p}} must be listed in parameters.required.`, hint: 'A path segment cannot be omitted, so its parameter must be required.' });
                        }
                    }
                    const stripped = pt.replace(PATH_PLACEHOLDER_RE, '');
                    if (stripped.includes('{') || stripped.includes('}')) {
                        pushE({ code: 'tool.path_invalid', path: `${at}.pathTemplate`, message: `Tool ${label}: pathTemplate has malformed placeholder braces.`, hint: 'Placeholders must look like {param_name}.' });
                    }
                }

                // query map
                if (tool.query !== undefined) {
                    if (!isObject(tool.query)) {
                        pushE({ code: 'tool.query_invalid', path: `${at}.query`, message: `Tool ${label}: query must be an object map.`, hint: 'Each value is either a single "{param}" placeholder or a literal.' });
                    } else {
                        const qKeys = Object.keys(tool.query);
                        if (qKeys.length > MAX_QUERY_ENTRIES) {
                            pushE({ code: 'tool.query_too_many', path: `${at}.query`, message: `Tool ${label}: ${qKeys.length} query entries; the cap is ${MAX_QUERY_ENTRIES}.`, hint: 'Drop parameters the API does not strictly need.' });
                        }
                        for (const qk of qKeys) {
                            const qAt = `${at}.query.${qk}`;
                            if (!QUERY_NAME_RE.test(qk)) {
                                pushE({ code: 'tool.query_name_invalid', path: qAt, message: `Tool ${label}: query parameter name "${qk}" is invalid.`, hint: 'Names must match ^[A-Za-z0-9_.[\\]-]{1,64}$.' });
                            }
                            const qv = tool.query[qk];
                            if (typeof qv === 'string') {
                                const pm = qv.match(EXACT_PLACEHOLDER_RE);
                                if (pm) {
                                    if (!declaredParams.has(pm[1])) {
                                        pushE({ code: 'tool.query_param_undeclared', path: qAt, message: `Tool ${label}: query placeholder {${pm[1]}} is not a declared parameter.`, hint: `Add "${pm[1]}" to parameters.properties.` });
                                    }
                                } else if (qv.includes('{') || qv.includes('}')) {
                                    pushE({ code: 'tool.query_value_invalid', path: qAt, message: `Tool ${label}: query value for "${qk}" must be a single "{param}" placeholder or a brace-free literal.`, hint: 'Partial templating like "a-{x}" is not supported.' });
                                }
                            } else if (typeof qv !== 'number' && typeof qv !== 'boolean') {
                                pushE({ code: 'tool.query_value_invalid', path: qAt, message: `Tool ${label}: query value for "${qk}" must be a string, number or boolean.`, hint: 'Objects/arrays are not valid query values.' });
                            }
                        }
                    }
                }

                // headers map
                if (tool.headers !== undefined) {
                    if (!isObject(tool.headers)) {
                        pushE({ code: 'tool.headers_invalid', path: `${at}.headers`, message: `Tool ${label}: headers must be an object map of literal strings.`, hint: 'Example: { "X-Tenant": "main" }.' });
                    } else {
                        checkHeaderMap(tool.headers, `${at}.headers`, {
                            tooMany: 'tool.headers_too_many',
                            name: 'tool.header_name_invalid',
                            denied: 'tool.header_denied',
                            value: 'tool.header_value_not_literal',
                        }, `Tool ${label}:`);
                    }
                }

                // body
                if (tool.body !== undefined) {
                    if (!isObject(tool.body)) {
                        pushE({ code: 'tool.body_invalid', path: `${at}.body`, message: `Tool ${label}: body must be an object { mode, template? }.`, hint: 'Use { "mode": "none" } or { "mode": "json", "template": {…} }.' });
                    } else {
                        const mode = tool.body.mode;
                        if (mode !== 'none' && mode !== 'json') {
                            pushE({ code: 'tool.body_mode_invalid', path: `${at}.body.mode`, message: `Tool ${label}: body.mode must be "none" or "json" (got ${JSON.stringify(mode)}).`, hint: 'Only JSON request bodies are supported.' });
                        }
                        if (mode === 'none' && tool.body.template !== undefined) {
                            pushE({ code: 'tool.body_template_unexpected', path: `${at}.body.template`, message: `Tool ${label}: body.mode "none" must not carry a template.`, hint: 'Remove the template or switch the mode to "json".' });
                        }
                        if (mode === 'json') {
                            if (!isObject(tool.body.template) && !Array.isArray(tool.body.template)) {
                                pushE({ code: 'tool.body_template_invalid', path: `${at}.body.template`, message: `Tool ${label}: body.mode "json" requires an object (or array) template.`, hint: '"{param}" at string leaves substitutes the typed argument; everything else is sent literally.' });
                            } else {
                                const found = { placeholders: [], tooDeep: [] };
                                collectBodyPlaceholders(tool.body.template, `${at}.body.template`, 0, found);
                                if (found.tooDeep.length) {
                                    pushE({ code: 'tool.body_template_too_deep', path: found.tooDeep[0], message: `Tool ${label}: body template nests deeper than ${MAX_BODY_TEMPLATE_DEPTH} levels.`, hint: 'Flatten the payload.' });
                                }
                                for (const ph of found.placeholders) {
                                    if (!declaredParams.has(ph.name)) {
                                        pushE({ code: 'tool.body_param_undeclared', path: ph.path, message: `Tool ${label}: body placeholder {${ph.name}} is not a declared parameter.`, hint: `Add "${ph.name}" to parameters.properties.` });
                                    }
                                }
                                if (tool.method === 'GET' || tool.method === 'DELETE') {
                                    pushW({ code: 'tool.body_on_read_method', path: `${at}.body`, message: `Tool ${label}: a JSON body on ${tool.method} is unusual and some servers reject it.`, hint: 'Move the data into query parameters, or double-check the vendor docs.' });
                                }
                            }
                        }
                    }
                }

                // readOnly
                if (tool.readOnly !== undefined && typeof tool.readOnly !== 'boolean') {
                    pushE({ code: 'tool.read_only_invalid', path: `${at}.readOnly`, message: `Tool ${label}: readOnly must be a boolean.`, hint: 'true for safe reads, false for mutations.' });
                }

                // pagination (hint only, but shape-checked; undeclared params lint)
                if (tool.pagination !== undefined) {
                    const pg = tool.pagination;
                    const pgAt = `${at}.pagination`;
                    if (!isObject(pg)) {
                        pushE({ code: 'tool.pagination_invalid', path: pgAt, message: `Tool ${label}: pagination must be an object.`, hint: 'Example: { "style": "page", "pageParam": "page", "sizeParam": "limit", "maxPageSize": 100 }.' });
                    } else {
                        if (!PAGINATION_STYLES.has(pg.style)) {
                            pushE({ code: 'tool.pagination_invalid', path: `${pgAt}.style`, message: `Tool ${label}: pagination.style must be page|offset|cursor|none (got ${JSON.stringify(pg.style)}).`, hint: 'Pick the style the vendor documents.' });
                        }
                        if (pg.maxPageSize !== undefined && (!Number.isInteger(pg.maxPageSize) || pg.maxPageSize < 1 || pg.maxPageSize > 1000)) {
                            pushE({ code: 'tool.pagination_invalid', path: `${pgAt}.maxPageSize`, message: `Tool ${label}: pagination.maxPageSize must be an integer 1..1000.`, hint: 'Use the vendor\'s documented page-size cap.' });
                        }
                        for (const f of ['pageParam', 'sizeParam']) {
                            const v = pg[f];
                            if (v === undefined) continue;
                            if (typeof v !== 'string' || !v) {
                                pushE({ code: 'tool.pagination_invalid', path: `${pgAt}.${f}`, message: `Tool ${label}: pagination.${f} must be a non-empty string.`, hint: 'Name the parameter that carries the page/size value.' });
                                continue;
                            }
                            if (pg.style !== 'none' && !declaredParams.has(v)) {
                                pushLint({ code: 'tool.pagination_param_undeclared', path: `${pgAt}.${f}`, message: `Tool ${label}: pagination.${f} "${v}" is not a declared parameter.`, hint: `Declare "${v}" in parameters.properties (and map it in query) so the model can actually page.` });
                            }
                        }
                    }
                }

                // resultPath
                if (tool.resultPath !== undefined && (typeof tool.resultPath !== 'string' || !RESULT_PATH_RE.test(tool.resultPath))) {
                    pushE({ code: 'tool.result_path_invalid', path: `${at}.resultPath`, message: `Tool ${label}: resultPath must be a dot-path like "data.items".`, hint: 'Segments match [A-Za-z0-9_]+ joined by dots; omit the field to return the whole response.' });
                }
            });
        }
    } else {
        // ── kind === 'mcp_remote' ────────────────────────────────────────
        if (!isObject(def.mcp)) {
            pushE({ code: 'mcp.missing', path: 'mcp', message: 'Missing or invalid `mcp` block.', hint: 'Provide { url, authStyle, valueTemplate?, credentials?, toolAllowList? }.' });
        } else {
            const mcp = def.mcp;
            checkHttpsUrl(mcp.url, { path: 'mcp.url', codePrefix: 'mcp.url', allowQuery: true, requiredLabel: 'mcp.url' });
            if (!MCP_AUTH_STYLES.has(mcp.authStyle)) {
                pushE({ code: 'mcp.auth_style_invalid', path: 'mcp.authStyle', message: `mcp.authStyle must be bearer|header|none (got ${JSON.stringify(mcp.authStyle)}).`, hint: 'Pick the auth scheme the MCP server documents.' });
            }
            const declared = checkCredentialList(mcp.credentials, 'mcp', 'mcp');
            if (mcp.authStyle === 'header') {
                if (typeof mcp.header !== 'string' || !HEADER_NAME_RE.test(mcp.header)) {
                    pushE({ code: 'mcp.header_invalid', path: 'mcp.header', message: 'mcp.authStyle "header" requires a valid mcp.header name.', hint: 'Example: "X-Api-Key" (must match ^[A-Za-z0-9-]{1,64}$).' });
                } else if (isDeniedHeader(mcp.header, { forAuth: true })) {
                    pushE({ code: 'mcp.header_denied', path: 'mcp.header', message: `mcp.header "${mcp.header}" is a managed transport header.`, hint: 'Use the vendor\'s key header, or authStyle "bearer" for Authorization.' });
                }
            }
            if (mcp.authStyle === 'bearer' || mcp.authStyle === 'header') {
                if (typeof mcp.valueTemplate !== 'string' || !mcp.valueTemplate) {
                    pushE({ code: 'mcp.value_template_missing', path: 'mcp.valueTemplate', message: `mcp.authStyle "${mcp.authStyle}" requires mcp.valueTemplate.`, hint: 'Example: "Bearer {{credential.api_key}}".' });
                } else {
                    checkValueTemplate(mcp.valueTemplate, declared, 'mcp.valueTemplate', 'mcp');
                }
            } else if (mcp.valueTemplate !== undefined) {
                pushE({ code: 'mcp.value_template_unexpected', path: 'mcp.valueTemplate', message: 'mcp.authStyle "none" must not carry a valueTemplate.', hint: 'Remove mcp.valueTemplate or pick an auth style that injects it.' });
            }
            if (mcp.toolAllowList !== undefined) {
                if (!Array.isArray(mcp.toolAllowList)) {
                    pushE({ code: 'mcp.tool_allow_list_invalid', path: 'mcp.toolAllowList', message: 'mcp.toolAllowList must be an array of tool-name strings.', hint: 'Example: ["search", "fetch"]. Omit it to allow all advertised tools.' });
                } else {
                    if (mcp.toolAllowList.length > MAX_TOOL_ALLOW_LIST) {
                        pushE({ code: 'mcp.tool_allow_list_too_many', path: 'mcp.toolAllowList', message: `${mcp.toolAllowList.length} allow-list entries; the cap is ${MAX_TOOL_ALLOW_LIST}.`, hint: 'List only the tools the org actually needs.' });
                    }
                    mcp.toolAllowList.forEach((t, j) => {
                        if (typeof t !== 'string' || !t || t.length > 128) {
                            pushE({ code: 'mcp.tool_allow_list_invalid', path: `mcp.toolAllowList[${j}]`, message: `toolAllowList entry ${j} must be a non-empty string of at most 128 chars.`, hint: 'Use the tool names the MCP server advertises.' });
                        }
                    });
                }
            }
        }
    }

    return { ok: errors.length === 0, errors, warnings };
}

/**
 * Derive the OpenAI tool array for a validated REST definition — used to
 * build tools_cache at activation. Pure transform, no validation: call
 * validateCustomIntegration(def, { strict: true, slug }) first.
 *
 * additionalProperties is forced to false on every derived schema, and the
 * output never aliases the input (safe to mutate / persist independently).
 */
function deriveOpenAiTools(def, slug) {
    const tools = isObject(def) && Array.isArray(def.tools) ? def.tools : [];
    return tools.filter(isObject).map((t) => {
        const src = isObject(t.parameters) ? t.parameters : {};
        const properties = {};
        if (isObject(src.properties)) {
            for (const [pname, schema] of Object.entries(src.properties)) {
                if (!isObject(schema)) continue;
                const prop = { type: schema.type };
                if (typeof schema.description === 'string') prop.description = schema.description;
                if (Array.isArray(schema.enum)) prop.enum = schema.enum.slice();
                if (schema.type === 'array' && isObject(schema.items)) {
                    prop.items = { type: schema.items.type };
                    if (typeof schema.items.description === 'string') prop.items.description = schema.items.description;
                    if (Array.isArray(schema.items.enum)) prop.items.enum = schema.items.enum.slice();
                }
                properties[pname] = prop;
            }
        }
        return {
            type: 'function',
            function: {
                name: `cint_${slug}_${t.name}`,
                description: typeof t.description === 'string' ? t.description : '',
                parameters: {
                    type: 'object',
                    properties,
                    required: Array.isArray(src.required) ? src.required.filter(r => typeof r === 'string') : [],
                    additionalProperties: false,
                },
            },
        };
    });
}

module.exports = { validateCustomIntegration, deriveOpenAiTools };
