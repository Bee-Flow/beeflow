/**
 * PII Detection — detect personally identifiable information in text
 *
 * Single backend: the PII Guard service (GLiNER multi-PII), a Python sidecar
 * installed via the admin dashboard. Runs locally — same Docker host, no
 * outbound calls per request. Covers all 20 categories in the picker.
 *
 * When the guard isn't installed, detectPii() returns null and the chat path
 * fails open. The admin UI surfaces this state with "Install the PII Guard
 * service to activate detection."
 *
 * Public surface: validateInputForPii, validateOutputForPii, detectPii,
 * tokenizeText, restoreTokens, PII_CATEGORIES, ALL_PII_CATEGORY_IDS,
 * LEGACY_CATEGORY_ALIASES, DEFAULT_PII_CONFIDENCE_THRESHOLD,
 * getGuardEndpoint, invalidateGuardEndpointCache.
 */

// Circular dep: piiDetection ← aiAgent ← agentStore ← ... ← piiDetection.
// During the cycle aiAgent.js does `module.exports = { ... }` at the END
// (full object replacement). If we capture `require('./aiAgent')` at module
// load, we get a snapshot of the EMPTY pre-cycle exports object that never
// gets updated — `module.exports = {...}` rebinds the new object in the
// require cache but our captured reference points at the abandoned old one.
// Calling `require('./aiAgent')` fresh on each invocation fetches the
// up-to-date cached exports from Node's module cache. By the time
// validateInputForPii runs (request time, not load time) aiAgent has long
// finished initialising.
function getAIConfig() {
    return require('./aiAgent').getAIConfig();
}
const configStore = require('../stores/configStore');

// ── Guard service endpoint resolution ────────────────────────────────────
// Resolved at request time so an admin installing the guard from the
// dashboard takes effect immediately (no server restart). Order of
// precedence:
//   1. configStore `pii_guard_url` / `pii_guard_api_key` (admin install action)
//   2. env `PII_SERVICE_URL` / `PII_SERVICE_API_KEY` (legacy / k8s manifest)

let _endpointCache = null;
let _endpointCacheAt = 0;
const ENDPOINT_CACHE_TTL_MS = 10_000;

async function getGuardEndpoint() {
    const now = Date.now();
    if (_endpointCache && (now - _endpointCacheAt) < ENDPOINT_CACHE_TTL_MS) {
        return _endpointCache;
    }
    let url = null;
    let apiKey = '';
    try {
        url = await configStore.getConfig('pii_guard_url') || null;
        if (url) {
            apiKey = await configStore.getSecret('pii_guard_api_key') || '';
        }
    } catch (_) { /* fall through to env */ }
    if (!url) {
        url = process.env.PII_SERVICE_URL || null;
        apiKey = process.env.PII_SERVICE_API_KEY || '';
    }
    _endpointCache = { url, apiKey };
    _endpointCacheAt = now;
    return _endpointCache;
}

function invalidateGuardEndpointCache() {
    _endpointCache = null;
    _endpointCacheAt = 0;
}

// Simple HTTP helper — no extra dependency beyond Node built-ins
const http = require('http');
const https = require('https');

function httpPost(url, body, apiKey) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? https : http;
        const data = JSON.stringify(body);
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
        };
        if (apiKey) {
            headers['X-API-Key'] = apiKey;
        }
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname,
            method: 'POST',
            headers,
            timeout: 90000,
        };
        const req = lib.request(options, (res) => {
            let chunks = '';
            res.on('data', (c) => { chunks += c; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(JSON.parse(chunks));
                } else {
                    reject(new Error(`guard-service /pii returned ${res.statusCode}: ${chunks}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('guard-service /pii timeout')); });
        req.write(data);
        req.end();
    });
}

/**
 * Detect PII using the CPU model via the guard service (GLiNER multi-PII).
 * Maps response shapes back to the same format as detectPii().
 */
async function detectPiiViaCpuModel(text, enabledCategories, confidenceThreshold, endpoint) {
    const body = {
        text,
        confidence_threshold: confidenceThreshold,
        enabled_categories: enabledCategories || null,
    };
    const result = await httpPost(`${endpoint.url}/pii`, body, endpoint.apiKey);
    // result = { hasPii, entities: [{ text, category, label, confidence, offset, length }] }
    const entities = (result.entities || []).map(e => ({
        text:        e.text,
        category:    e.category,
        subCategory: null,
        confidence:  e.confidence,
        offset:      e.offset,
        length:      e.length,
        label:       e.label || PII_CATEGORIES[e.category]?.label || e.category,
    }));
    return {
        hasPii:      entities.length > 0,
        entities,
        redactedText: text,  // CPU model does not redact
    };
}

// ── Cache (LRU, 5-min TTL) ───────────────────────────────────────────
const CACHE_MAX = 200;
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function cacheKey(channel, text) {
    return `pii:${channel}:${text.length}:${text.slice(0, 200)}`;
}

function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
        cache.delete(key);
        return null;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry.result;
}

function cacheSet(key, result) {
    if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
    cache.set(key, { result, timestamp: Date.now() });
}

// ── PII Categories ──────────────────────────────────────────────────────
// Only categories the PII Guard service (GLiNER) can emit. Adding rows
// here without a corresponding label mapping in
// guard-service/app/services/pii.py means admins will see toggles that
// silently never fire.
const PII_CATEGORIES = {
    // Personal
    'Person':           { label: 'Person Name',          group: 'Personal',   icon: '👤' },
    'DateOfBirth':      { label: 'Date of Birth',        group: 'Personal',   icon: '📅' },

    // Contact
    'PhoneNumber':      { label: 'Phone Number',         group: 'Contact',    icon: '📱' },
    'Email':            { label: 'Email Address',        group: 'Contact',    icon: '📧' },
    'Address':          { label: 'Physical Address',     group: 'Contact',    icon: '🏠' },

    // Financial
    'CreditCardNumber':                    { label: 'Credit Card Number',  group: 'Financial',  icon: '💳' },
    'BankAccountNumber':                   { label: 'Bank Account Number', group: 'Financial',  icon: '🏦' },
    'InternationalBankingAccountNumber':   { label: 'IBAN',                group: 'Financial',  icon: '🌐' },

    // Identity / Government
    'USSocialSecurityNumber':              { label: 'SSN (US)',            group: 'Identity',   icon: '🆔' },
    'PassportNumber':                      { label: 'Passport Number',     group: 'Identity',   icon: '🛂' },
    'DriversLicenseNumber':                { label: "Driver's License",    group: 'Identity',   icon: '🪪' },

    // Digital / Secrets
    'IPAddress':         { label: 'IP Address',     group: 'Digital',  icon: '🌐' },
    'URL':               { label: 'URL',            group: 'Digital',  icon: '🔗' },
    'ApiKeyOrSecret':    { label: 'API key / secret', group: 'Digital', icon: '🔑' },

    // Organization
    'Organization':   { label: 'Organization',   group: 'Organization',  icon: '🏢' },

    // EU / Netherlands — labels the GLiNER multi-PII model returns natively.
    // No regex used; we trust the model's recall for these categories.
    'NationalIdentificationNumber':  { label: 'National ID (BSN / DNI / NIE / codice fiscale / Steuer-ID / INSEE / rijksregister)', group: 'EU / Netherlands', icon: '🆔' },
    'TaxIdentificationNumber':       { label: 'Tax ID (BTW / RSIN / VAT)',  group: 'EU / Netherlands', icon: '🧾' },
    'HealthInsuranceNumber':         { label: 'Health Insurance Number',     group: 'EU / Netherlands', icon: '🏥' },
    'MedicalCondition':              { label: 'Medical Condition',           group: 'EU / Netherlands', icon: '❤️‍🩹' },
    'Medication':                    { label: 'Medication',                  group: 'EU / Netherlands', icon: '💊' },
    'LicensePlateNumber':            { label: 'License Plate',               group: 'EU / Netherlands', icon: '🚗' },
};

const ALL_PII_CATEGORY_IDS = Object.keys(PII_CATEGORIES);

// Legacy → canonical category aliases. Existing org Privacy Shield configs
// may reference IDs from earlier releases; map them to the current canonical
// ID so a rename never requires a config migration.
const LEGACY_CATEGORY_ALIASES = {
    'EUNationalIdentificationNumber': 'NationalIdentificationNumber',
    // AzureStorageAccountKey collapsed to the generic ApiKeyOrSecret when
    // the Azure PII backend was removed. Kept here so old shield configs
    // that reference the Azure-branded id continue to resolve.
    'AzureStorageAccountKey': 'ApiKeyOrSecret',
};

// Default confidence threshold for PII detection
const DEFAULT_PII_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Tokenize PII in text — replace each detected entity with a reversible token.
 *
 * Tokens look like: [PII:iban:1], [PII:email:1], [PII:name:1]
 *
 * Returns { tokenizedText, tokenMap } where tokenMap maps each token → real value.
 * Call restoreTokens(text, tokenMap) to reverse.
 *
 * When `existingTokenMap` is passed (the conversation's accumulated token map),
 * the per-category counter is seeded from it and known values reuse their
 * existing token. Without this, turn 2 of a redacted conversation would
 * restart counters at 1 and silently overwrite turn 1's mappings — same value
 * gets a duplicate token, two different values collide on the same token.
 */
function tokenizeText(text, entities, existingTokenMap = null) {
    if (!entities || entities.length === 0) return { tokenizedText: text, tokenMap: {} };

    // Seed counters + value→token reverse index from the conversation's
    // accumulated map so subsequent turns extend instead of restart.
    const counters = {};
    const existingByValue = new Map();
    if (existingTokenMap && typeof existingTokenMap === 'object') {
        for (const [tok, real] of Object.entries(existingTokenMap)) {
            const m = /^\[([a-z0-9_]+)_(\d+)\]$/.exec(tok);
            if (!m) continue;
            const cat = m[1];
            const idx = parseInt(m[2], 10);
            if (Number.isFinite(idx)) counters[cat] = Math.max(counters[cat] || 0, idx);
            const dedupKey = `${cat}|${(real || '').trim()}`;
            if (!existingByValue.has(dedupKey)) existingByValue.set(dedupKey, tok);
        }
    }

    // Sort by offset descending so we can splice from end without shifting offsets
    const sorted = [...entities].sort((a, b) => b.offset - a.offset);
    const tokenMap = {};
    // Dedup within a category (this call): identical real values share one token. Without
    // this, the same name appearing 5 times in an email becomes [person_2..6]
    // — five rows in the token-map UI, all pointing at "Jack". Match is
    // case-sensitive + whitespace-trimmed: "Jack" and "Jack " collapse, but
    // "Jack" and "jack" stay separate so restoration preserves original casing
    // at every site.
    const seenByCategory = new Map();

    let tokenized = text;
    for (const entity of sorted) {
        // Human-friendly token format — `[email_1]`, `[phone_2]`, … — easier
        // for the LLM to echo back verbatim than the old `[PII:email:1]`.
        // The restore path is format-agnostic (see server/core/dlp/untokeniseStream.js),
        // so this change is backwards-compatible with any tokens still in flight.
        const catKey = (entity.category || 'data').toLowerCase().replace(/[^a-z0-9]/g, '_');
        const dedupKey = `${catKey}|${(entity.text || '').trim()}`;
        // Reuse priority: within-call dedup → conversation-wide reuse → mint fresh.
        let token = seenByCategory.get(dedupKey) || existingByValue.get(dedupKey);
        if (!token) {
            counters[catKey] = (counters[catKey] || 0) + 1;
            token = `[${catKey}_${counters[catKey]}]`;
        }
        seenByCategory.set(dedupKey, token);
        // Record every token used in this call (new or reused) so the caller's
        // per-message tokenMap and the conv-map merge both stay complete — a
        // reused token still needs to appear in the per-message map for the
        // user-side restore path (_restoreTokensInMessages).
        tokenMap[token] = entity.text;
        // Replace the exact span (using offset if available, else string replace)
        if (entity.offset !== undefined && entity.offset >= 0) {
            tokenized = tokenized.slice(0, entity.offset) + token + tokenized.slice(entity.offset + entity.length);
        } else {
            tokenized = tokenized.replace(entity.text, token);
        }
    }

    return { tokenizedText: tokenized, tokenMap };
}

/**
 * Restore PII tokens in text back to real values.
 * Call on AI response before displaying to user.
 */
function restoreTokens(text, tokenMap) {
    if (!tokenMap || !text) return text;
    let restored = text;
    for (const [token, realValue] of Object.entries(tokenMap)) {
        // Use a global replace in case the AI echoed the token multiple times
        restored = restored.split(token).join(realValue);
    }
    return restored;
}

/**
 * Detect PII entities in text via the PII Guard service.
 * Returns { hasPii, entities[] } or null when:
 *   - the guard isn't installed (configStore `pii_guard_url` is unset), or
 *   - the guard is unreachable / returns an error.
 *
 * Either failure mode fails open — the chat path still completes. The
 * admin UI surfaces guard-not-installed state on the Privacy Shield page.
 */
async function detectPii(text, enabledCategories = null, confidenceThreshold = DEFAULT_PII_CONFIDENCE_THRESHOLD) {
    const guardEndpoint = await getGuardEndpoint();
    if (!guardEndpoint.url) {
        console.log('[PiiDetection] guard endpoint not configured — install the PII Guard service to activate detection');
        return null;
    }
    try {
        return await detectPiiViaCpuModel(text, enabledCategories, confidenceThreshold, guardEndpoint);
    } catch (err) {
        console.warn('[PiiDetection] guard-service unavailable:', err.message);
        return null;
    }
}

async function validateInputForPii(messages, agentPiiEnabled = false, orgShieldConfig = null) {
    const aiConfig = await getAIConfig();

    // Loud entry trace so admins can see PII gates firing in logs.
    console.log(`[PiiDetection] validateInputForPii called: agentPiiEnabled=${agentPiiEnabled} aiCfgEnabled=${!!aiConfig.piiDetectionEnabled} shield={enabled:${!!orgShieldConfig?.enabled}, action:${orgShieldConfig?.piiDetectionAction || 'default'}}`);

    // PII detection switches on if any of:
    //   1. Global AI config flag (admin-set via /ai/config)
    //   2. Per-agent override (rare; specific agent configs)
    //   3. Org Privacy Shield's master `enabled` flag — the only switch a
    //      non-developer typically uses, exposed at /app/settings/organisation/privacy
    const piiEnabled =
        aiConfig.piiDetectionEnabled ||
        agentPiiEnabled ||
        !!orgShieldConfig?.enabled;
    if (!piiEnabled) {
        console.log('[PiiDetection] gate=DISABLED (aiConfig + agent + shield all off)');
        return null;
    }

    const piiAction = orgShieldConfig?.piiDetectionAction || aiConfig.piiDetectionAction || 'block';

    const lastUserMessage = messages.slice().reverse().find(m => m.role === 'user');
    if (!lastUserMessage) {
        console.log('[PiiDetection] no user message in batch');
        return null;
    }

    let inputText = lastUserMessage.content;
    if (Array.isArray(inputText)) {
        const textBlock = inputText.find(b => b.type === 'text');
        inputText = textBlock ? textBlock.text : '';
    }
    if (!inputText || inputText.length < 3) {
        console.log(`[PiiDetection] input too short (${inputText?.length || 0} chars), skipping`);
        return null;
    }

    // Check cache
    const key = cacheKey('user_input', inputText);
    const cached = cacheGet(key);
    if (cached) {
        console.log(`[PiiDetection] Cache hit → ${cached.hasPii ? '🚫 PII found' : '✅ clean'}`);
        if (cached.hasPii) {
            const categoryList = [...new Set(cached.entities.map(e => e.label))].join(', ');
            if (piiAction === 'tokenize') {
                const { tokenizedText, tokenMap } = tokenizeText(inputText, cached.entities);
                console.warn(`[PiiDetection] 🔒 Tokenizing ${cached.entities.length} entities (cached): ${categoryList}`);
                return { tokenizedText, tokenMap, entities: cached.entities };
            }
            const err = new Error(`PII Detected: Message contains sensitive personal information (${categoryList}). Please remove PII before sending.`);
            err.piiEntities = cached.entities;
            err.violationCodes = cached.entities.map(e => `PII:${e.category}`);
            throw err;
        }
        return null;
    }

    console.log(`[PiiDetection] Scanning input (${inputText.length} chars)...`);
    const start = Date.now();

    // ── Load enabled categories & confidence threshold
    // Priority: 1) Passed-in org shield config (callers already resolved the correct org)
    //           2) Fallback: scan configStore for any org shield (legacy/generic callers)
    //           3) Global AI config categories
    //           4) All categories (default)
    let enabledCategories = ALL_PII_CATEGORY_IDS;
    let confidenceThreshold = aiConfig.piiDetectionConfidenceThreshold ?? DEFAULT_PII_CONFIDENCE_THRESHOLD;
    try {
        const shieldConfig = orgShieldConfig || await (async () => {
            // Legacy fallback: scan configStore for an org shield (when caller doesn't pass one)
            const allConfigs = await configStore.getAllConfig() || {};
            const shieldKey = Object.keys(allConfigs).find(k => k.startsWith('org_privacy_shield_'));
            return shieldKey ? allConfigs[shieldKey] : null;
        })();
        if (shieldConfig) {
            if (Array.isArray(shieldConfig.piiDetectionCategories) && shieldConfig.piiDetectionCategories.length > 0) {
                enabledCategories = shieldConfig.piiDetectionCategories
                    .map(id => LEGACY_CATEGORY_ALIASES[id] || id)
                    .filter(id => ALL_PII_CATEGORY_IDS.includes(id));
            }
            if (typeof shieldConfig.piiDetectionConfidenceThreshold === 'number') {
                confidenceThreshold = shieldConfig.piiDetectionConfidenceThreshold;
            }
            console.log(`[PiiDetection] Using org shield: ${enabledCategories.length}/${ALL_PII_CATEGORY_IDS.length} categories (Email=${enabledCategories.includes('Email')}), confidence ≥ ${confidenceThreshold}`);
        } else if (aiConfig.piiDetectionCategories?.length > 0) {
            enabledCategories = aiConfig.piiDetectionCategories
                .map(id => LEGACY_CATEGORY_ALIASES[id] || id)
                .filter(id => ALL_PII_CATEGORY_IDS.includes(id));
            console.log(`[PiiDetection] Using AI config: ${enabledCategories.length}/${ALL_PII_CATEGORY_IDS.length} categories, confidence ≥ ${confidenceThreshold}`);
        } else {
            console.log(`[PiiDetection] No org shield found, using all ${ALL_PII_CATEGORY_IDS.length} categories`);
        }
    } catch (shieldErr) {
        console.warn(`[PiiDetection] Could not load org shield:`, shieldErr.message);
    }

    try {
        const result = await detectPii(inputText, enabledCategories, confidenceThreshold);
        if (!result) return null; // No detector available, fail-open

        const ms = Date.now() - start;

        // Cache the result
        cacheSet(key, result);

        if (!result.hasPii) {
            console.log(`[PiiDetection] ✅ Input clean | ${ms}ms | threshold ≥ ${confidenceThreshold}`);
            // A very common misconfiguration: admin slid the confidence threshold
            // to 0.9+ which filters out almost every detection for short prompts
            // (typical confidence range: 0.70–0.85). Emit a loud hint when the
            // prompt *looks* like it contains PII but the scan came back clean
            // with a high threshold, so operators can diagnose the "PII works on
            // dev but not on customer" class of tickets.
            if (confidenceThreshold >= 0.85) {
                const looksLikeEmail = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(inputText);
                const looksLikePhone = /(?:\+?\d[\s-]?){8,}/.test(inputText);
                const looksLikeIban  = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/.test(inputText);
                const looksLikePii   = looksLikeEmail || looksLikePhone || looksLikeIban;
                if (looksLikePii) {
                    const hints = [];
                    if (looksLikeEmail) hints.push('email');
                    if (looksLikePhone) hints.push('phone');
                    if (looksLikeIban) hints.push('IBAN');
                    console.warn(`[PiiDetection] ⚠️  Input contains likely PII (${hints.join(', ')}) but threshold is ${confidenceThreshold}. Detectors typically return 0.70–0.85 confidence for short texts; lower the threshold to 0.70 if you expect detections. (Org Privacy Shield → PII Detection → Confidence Threshold)`);
                }
            }
            return null;
        }

        const categoryList = [...new Set(result.entities.map(e => e.label))].join(', ');
        const snippets = result.entities.map(e => `"${e.text.slice(0, 20).trim()}" (${e.label}, ${Math.round(e.confidence * 100)}%)`).join(' | ');
        console.warn(`[PiiDetection] 🚫 PII detected | categories: ${categoryList} | ${result.entities.length} entities | ${ms}ms`);
        console.warn(`[PiiDetection] 🚫 Entities: ${snippets}`);
        console.warn(`[PiiDetection] Action: ${piiAction} (source: ${orgShieldConfig?.piiDetectionAction ? 'org-shield' : aiConfig.piiDetectionAction ? 'ai-config' : 'default'})`);

        if (piiAction === 'tokenize' || piiAction === 'redact') {
            const { tokenizedText, tokenMap } = tokenizeText(inputText, result.entities);
            console.warn(`[PiiDetection] 🔒 Tokenizing — sending redacted text to AI`);
            return { tokenizedText, tokenMap, entities: result.entities };
        }

        // Default: block
        const err = new Error(`PII Detected: Message contains sensitive personal information (${categoryList}). Please remove PII before sending.`);
        err.piiEntities = result.entities;
        err.violationCodes = result.entities.map(e => `PII:${e.category}`);
        throw err;

    } catch (e) {
        if (e.message?.includes('PII Detected')) throw e;
        console.error('[PiiDetection] Validation failed:', e.message);
        console.warn('[PiiDetection] Service unavailable, allowing content (fail-open)');
        return null;
    }
}

/**
 * Validate agent output for PII.
 */
async function validateOutputForPii(content) {
    const aiConfig = await getAIConfig();

    if (!aiConfig.piiDetectionEnabled) return;
    if (!content || content.length < 3) return;

    const key = cacheKey('assistant_output', content);
    const cached = cacheGet(key);
    if (cached) {
        if (!cached.hasPii) return;
        const categoryList = [...new Set(cached.entities.map(e => e.label))].join(', ');
        const err = new Error(`PII Detected: Response contains sensitive personal information (${categoryList}).`);
        err.piiEntities = cached.entities;
        err.violationCodes = cached.entities.map(e => `PII:${e.category}`);
        throw err;
    }

    try {
        const enabledCategories = aiConfig.piiDetectionCategories || ALL_PII_CATEGORY_IDS;
        const confidenceThreshold = aiConfig.piiDetectionConfidenceThreshold ?? DEFAULT_PII_CONFIDENCE_THRESHOLD;
        const result = await detectPii(content, enabledCategories, confidenceThreshold);
        if (!result) return;

        cacheSet(key, result);

        if (!result.hasPii) {
            console.log(`[PiiDetection] ✅ Output clean`);
            return;
        }

        const categoryList = [...new Set(result.entities.map(e => e.label))].join(', ');
        console.warn(`[PiiDetection] 🚫 PII in output | ${categoryList}`);

        const err = new Error(`PII Detected: Response contains sensitive personal information (${categoryList}).`);
        err.piiEntities = result.entities;
        err.violationCodes = result.entities.map(e => `PII:${e.category}`);
        throw err;

    } catch (e) {
        if (e.message.includes('PII Detected')) throw e;
        console.warn('[PiiDetection] Output validation unavailable, allowing (fail-open)');
    }
}

module.exports = {
    validateInputForPii,
    validateOutputForPii,
    detectPii,
    tokenizeText,
    restoreTokens,
    PII_CATEGORIES,
    ALL_PII_CATEGORY_IDS,
    LEGACY_CATEGORY_ALIASES,
    DEFAULT_PII_CONFIDENCE_THRESHOLD,
    getGuardEndpoint,
    invalidateGuardEndpointCache,
};
