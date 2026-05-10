/**
 * PII Detection — detect personally identifiable information in text
 *
 * PRIMARY:  Azure AI Text Analytics (when endpoint + key are configured)
 * FALLBACK: guard-service /pii endpoint (GLiNER multi PII v1, CPU)
 *
 *   createClient() → Azure creds exist?
 *       YES → Azure Text Analytics (cloud)
 *       NO  → guard-service /pii (local CPU NER model)
 *
 * SDK: @azure/ai-text-analytics
 * Auth: AzureKeyCredential from @azure/core-auth
 * Method: recognizePiiEntities
 */

// Circular dep: azurePiiDetection ← aiAgent ← agentStore ← ... ← azurePiiDetection.
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
const { computePiiDetectionCost } = require('./azureServiceCosts');
const azureServiceUsageStore = require('../stores/azureServiceUsageStore');
const { detectPiiLocal } = require('./localPiiDetection');

// ── PII service — guard-service running GLiNER multi PII v1 (Apache 2.0)
// Set PII_SERVICE_URL in .env to point at the running guard-service instance.
// Defaults to localhost:8200 (the pii-service default port).
// Set PII_SERVICE_API_KEY if the remote service requires API key auth.
const PII_SERVICE_URL = process.env.PII_SERVICE_URL || 'http://localhost:8200';
const PII_SERVICE_API_KEY = process.env.PII_SERVICE_API_KEY || '';

// Simple HTTP helper — no extra dependency beyond Node built-ins
const http = require('http');
const https = require('https');

function httpPost(url, body) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? https : http;
        const data = JSON.stringify(body);
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
        };
        if (PII_SERVICE_API_KEY) {
            headers['X-API-Key'] = PII_SERVICE_API_KEY;
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
 * Detect PII using the CPU model via the PII service (GLiNER multi PII v1).
 * Maps response shapes back to the same format as detectPii().
 */
async function detectPiiViaCpuModel(text, enabledCategories, confidenceThreshold) {
    const body = {
        text,
        confidence_threshold: confidenceThreshold,
        enabled_categories: enabledCategories || null,
    };
    const result = await httpPost(`${PII_SERVICE_URL}/pii`, body);
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

// ── PII Categories (Azure AI Language — verified supported IDs) ──────
// Only categories that are accepted by the Azure Text Analytics API as
// categoriesFilter values or returned as entity.category results.
const PII_CATEGORIES = {
    // Personal
    'Person':           { label: 'Person Name',          group: 'Personal',   icon: '👤' },
    'PersonType':       { label: 'Person Type / Role',   group: 'Personal',   icon: '👥' },
    'Age':              { label: 'Age',                  group: 'Personal',   icon: '🎂' },
    'DateOfBirth':      { label: 'Date of Birth',        group: 'Personal',   icon: '📅' },

    // Contact
    'PhoneNumber':      { label: 'Phone Number',         group: 'Contact',    icon: '📱' },
    'Email':            { label: 'Email Address',        group: 'Contact',    icon: '📧' },
    'Address':          { label: 'Physical Address',     group: 'Contact',    icon: '🏠' },

    // Financial
    'CreditCardNumber':                    { label: 'Credit Card Number',  group: 'Financial',  icon: '💳' },
    'BankAccountNumber':                   { label: 'Bank Account Number', group: 'Financial',  icon: '🏦' },
    'InternationalBankingAccountNumber':   { label: 'IBAN',                group: 'Financial',  icon: '🌐' },
    'ABARoutingNumber':                    { label: 'ABA Routing Number',  group: 'Financial',  icon: '🔢' },
    'SWIFTCode':                           { label: 'SWIFT Code',          group: 'Financial',  icon: '🏧' },

    // Identity / Government
    'USSocialSecurityNumber':              { label: 'SSN (US)',            group: 'Identity',   icon: '🆔' },
    'PassportNumber':                      { label: 'Passport Number',    group: 'Identity',   icon: '🛂' },
    'DriversLicenseNumber':                { label: "Driver's License",   group: 'Identity',   icon: '🪪' },

    // Digital / Secrets
    'IPAddress':                { label: 'IP Address',           group: 'Digital',    icon: '🌐' },
    'URL':                      { label: 'URL',                  group: 'Digital',    icon: '🔗' },
    'AzureDocumentDBAuthKey':   { label: 'Azure CosmosDB Key',   group: 'Digital',    icon: '☁️' },
    'AzureStorageAccountKey':   { label: 'Azure Storage Key',    group: 'Digital',    icon: '☁️' },

    // Organization
    'Organization':   { label: 'Organization',   group: 'Organization',  icon: '🏢' },

    // Netherlands 🇳🇱
    'EUNationalIdentificationNumber': { label: 'BSN / National ID (EU)',  group: 'Netherlands',  icon: '🇳🇱' },
};

const ALL_PII_CATEGORY_IDS = Object.keys(PII_CATEGORIES);

// Default confidence threshold for PII detection
const DEFAULT_PII_CONFIDENCE_THRESHOLD = 0.7;

// ── Client creation (reuses Content Safety endpoint + key) ───────────
let _client = null;
let _clientConfig = null;

async function createClient() {
    const endpoint = await configStore.getConfig('azure_content_safety_endpoint');
    const apiKey = await configStore.getSecret('azure_content_safety_key');

    if (!endpoint || !apiKey) {
        return null;
    }

    // Cache client if config hasn't changed
    const configKey = `${endpoint}:${apiKey}`;
    if (_client && _clientConfig === configKey) {
        return _client;
    }

    const { TextAnalyticsClient, AzureKeyCredential } = require('@azure/ai-text-analytics');
    _client = new TextAnalyticsClient(endpoint, new AzureKeyCredential(apiKey));
    _clientConfig = configKey;
    return _client;
}

/**
 * Tokenize PII in text — replace each detected entity with a reversible token.
 *
 * Tokens look like: [PII:iban:1], [PII:email:1], [PII:name:1]
 *
 * Returns { tokenizedText, tokenMap } where tokenMap maps each token → real value.
 * Call restoreTokens(text, tokenMap) to reverse.
 */
function tokenizeText(text, entities) {
    if (!entities || entities.length === 0) return { tokenizedText: text, tokenMap: {} };

    // Sort by offset descending so we can splice from end without shifting offsets
    const sorted = [...entities].sort((a, b) => b.offset - a.offset);
    const tokenMap = {};
    const counters = {};
    // Dedup within a category: identical real values share one token. Without
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
        let token = seenByCategory.get(dedupKey);
        if (!token) {
            counters[catKey] = (counters[catKey] || 0) + 1;
            token = `[${catKey}_${counters[catKey]}]`;
            seenByCategory.set(dedupKey, token);
            tokenMap[token] = entity.text;
        }
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
 * Detect PII via Azure AI Language REST API.
 * Uses the /language/:analyze-text endpoint with PiiEntityRecognition kind.
 * This works with Azure AI Foundry / multi-service endpoints (same as Content Safety).
 */
async function detectPiiViaRestApi(text, endpoint, apiKey, enabledCategories, confidenceThreshold) {
    const url = `${endpoint.replace(/\/$/, '')}/language/:analyze-text?api-version=2023-04-01`;

    const body = {
        kind: 'PiiEntityRecognition',
        parameters: {
            modelVersion: 'latest',
        },
        analysisInput: {
            documents: [
                { id: '1', text }
            ]
        }
    };

    // NOTE: We do NOT send piiCategories to Azure — the API expects SCREAMING_SNAKE_CASE
    // enum values (e.g. CREDIT_CARD_NUMBER) but our config stores PascalCase (CreditCardNumber).
    // Instead, we let Azure scan for everything and post-filter the results server-side
    // against the enabled categories. This is safer and decouples us from Azure's enum format.

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Ocp-Apim-Subscription-Key': apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Azure Language API ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const doc = data.results?.documents?.[0];

    // ── Track usage cost (fire-and-forget) ──
    const charCount = text.length;
    const cost = computePiiDetectionCost(charCount);
    azureServiceUsageStore.logAzureServiceUsage({
        service_type: 'pii_detection',
        input_chars: charCount,
        estimated_cost: cost,
        source: 'unknown',
    }).catch(() => {});
    if (cost > 0) console.log(`[PiiDetection] 💰 Est. cost: $${cost.toFixed(6)} (${charCount} chars)`);

    if (!doc) {
        const errors = data.results?.errors;
        if (errors?.length) {
            throw new Error(`Azure Language API error: ${JSON.stringify(errors[0])}`);
        }
        throw new Error('Azure Language API returned no documents');
    }

    // Filter by confidence threshold
    let detectedEntities = (doc.entities || [])
        .filter(entity => entity.confidenceScore >= confidenceThreshold)
        .map(entity => ({
            text: entity.text,
            category: entity.category,
            subCategory: entity.subcategory || null,
            confidence: entity.confidenceScore,
            offset: entity.offset,
            length: entity.length,
            label: PII_CATEGORIES[entity.category]?.label || entity.category,
        }));

    // Post-filter: enforce enabled categories on the results
    // Azure may ignore piiCategories or return extra categories
    if (enabledCategories && enabledCategories.length > 0) {
        const enabledSet = new Set(enabledCategories);
        const before = detectedEntities.length;
        detectedEntities = detectedEntities.filter(e => enabledSet.has(e.category));
        if (before !== detectedEntities.length) {
            console.log(`[PiiDetection] Post-filter: ${before} → ${detectedEntities.length} entities (filtered by ${enabledCategories.length} enabled categories)`);
        }
    }

    return {
        hasPii: detectedEntities.length > 0,
        entities: detectedEntities,
        redactedText: doc.redactedText || text,
    };
}

/**
 * Detect PII entities in text.
 * Returns { hasPii, entities[] } or null on failure.
 *
 * Routing:
 *   - Azure Content Safety endpoint + key configured → REST API /language/:analyze-text
 *   - No Azure creds, `localPiiEnabled` on shield → in-process Transformers.js detector
 *   - No Azure creds, local disabled → CPU guard-service /pii endpoint (HTTP)
 */
async function detectPii(text, enabledCategories = null, confidenceThreshold = DEFAULT_PII_CONFIDENCE_THRESHOLD) {
    const endpoint = await configStore.getConfig('azure_content_safety_endpoint');
    const apiKey = await configStore.getSecret('azure_content_safety_key');

    if (endpoint && apiKey) {
        return await detectPiiViaRestApi(text, endpoint, apiKey, enabledCategories, confidenceThreshold);
    }

    // No Azure creds — pick a CPU backend. Default to in-process Transformers.js
    // unless an admin has explicitly disabled it on the org Privacy Shield.
    const localEnabled = await isLocalPiiEnabled();

    if (localEnabled) {
        try {
            const result = await detectPiiLocal(text, enabledCategories, confidenceThreshold);
            if (result) return result;
            // Model unavailable → fall through to guard-service HTTP path.
            console.log('[PiiDetection] Local model unavailable, trying guard-service');
        } catch (localErr) {
            console.warn('[PiiDetection] Local model error:', localErr.message);
        }
    }

    try {
        return await detectPiiViaCpuModel(text, enabledCategories, confidenceThreshold);
    } catch (cpuErr) {
        console.warn('[PiiDetection] guard-service unavailable:', cpuErr.message);
        return null; // fail-open
    }
}

/**
 * Resolve the `localPiiEnabled` flag from any stored org Privacy Shield.
 * Returns true by default so a fresh install with no Azure config still
 * gets working PII detection out of the box. Admins disable via the
 * Privacy Shield panel.
 */
async function isLocalPiiEnabled() {
    try {
        const all = await configStore.getAllConfig() || {};
        for (const key of Object.keys(all)) {
            if (!key.startsWith('org_privacy_shield_')) continue;
            const shield = all[key];
            if (shield && typeof shield.localPiiEnabled === 'boolean') {
                return shield.localPiiEnabled;
            }
        }
    } catch (_) { /* fail open */ }
    return true;
}

/**
 * Validate user input for PII.
 *
 * Behaviour depends on piiDetectionAction config:
 *   'block'    — throws an error if PII found (existing behaviour)
 *   'tokenize' — returns { tokenizedText, tokenMap } replacing PII with tokens like [PII:iban:1]
 *
 * Returns null if PII detection is disabled or no PII found.
 * Returns { tokenizedText, tokenMap } when action=tokenize and PII is found.
 * Throws when action=block and PII is found.
 *
 * @param {Array} messages - Chat messages array
 * @param {boolean} [agentPiiEnabled=false] - Per-agent override
 */
async function validateInputForPii(messages, agentPiiEnabled = false, orgShieldConfig = null) {
    const aiConfig = await getAIConfig();

    // Loud entry trace so admins can see PII gates firing in logs.
    console.log(`[PiiDetection] validateInputForPii called: agentPiiEnabled=${agentPiiEnabled} aiCfgEnabled=${!!aiConfig.piiDetectionEnabled} shield={enabled:${!!orgShieldConfig?.enabled}, azurePii:${!!orgShieldConfig?.azurePiiEnabled}, localPii:${orgShieldConfig?.localPiiEnabled !== false}, action:${orgShieldConfig?.piiDetectionAction || 'default'}}`);

    // Check if PII detection is enabled
    const piiEnabled = aiConfig.piiDetectionEnabled || agentPiiEnabled;
    if (!piiEnabled) {
        console.log('[PiiDetection] gate=DISABLED (neither aiConfig nor agentPiiEnabled true)');
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
                enabledCategories = shieldConfig.piiDetectionCategories.filter(id => ALL_PII_CATEGORY_IDS.includes(id));
            }
            if (typeof shieldConfig.piiDetectionConfidenceThreshold === 'number') {
                confidenceThreshold = shieldConfig.piiDetectionConfidenceThreshold;
            }
            console.log(`[PiiDetection] Using org shield: ${enabledCategories.length}/${ALL_PII_CATEGORY_IDS.length} categories (Email=${enabledCategories.includes('Email')}), confidence ≥ ${confidenceThreshold}`);
        } else if (aiConfig.piiDetectionCategories?.length > 0) {
            enabledCategories = aiConfig.piiDetectionCategories.filter(id => ALL_PII_CATEGORY_IDS.includes(id));
            console.log(`[PiiDetection] Using AI config: ${enabledCategories.length}/${ALL_PII_CATEGORY_IDS.length} categories, confidence ≥ ${confidenceThreshold}`);
        } else {
            console.log(`[PiiDetection] No org shield found, using all ${ALL_PII_CATEGORY_IDS.length} categories`);
        }
    } catch (shieldErr) {
        console.warn(`[PiiDetection] Could not load org shield:`, shieldErr.message);
    }

    try {
        const result = await detectPii(inputText, enabledCategories, confidenceThreshold);
        if (!result) return null; // No client configured, fail-open

        const ms = Date.now() - start;

        // Cache the result
        cacheSet(key, result);

        if (!result.hasPii) {
            console.log(`[PiiDetection] ✅ Input clean | ${ms}ms | threshold ≥ ${confidenceThreshold}`);
            // A very common misconfiguration: admin slid the confidence threshold
            // to 0.9+ which filters out almost every detection Azure returns for
            // short prompts (typical confidence range: 0.70–0.85). Emit a loud
            // hint when the prompt *looks* like it contains PII but the scan
            // came back clean with a high threshold, so operators can diagnose
            // the "PII works on dev but not on customer" class of tickets.
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
                    console.warn(`[PiiDetection] ⚠️  Input contains likely PII (${hints.join(', ')}) but threshold is ${confidenceThreshold}. Azure typically returns 0.70–0.85 confidence for short texts; lower the threshold to 0.70 if you expect detections. (Org Privacy Shield → PII Detection → Confidence Threshold)`);
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
    DEFAULT_PII_CONFIDENCE_THRESHOLD,
};
