/**
 * Azure PII Detection — detect personally identifiable information in text
 *
 * Uses the @azure/ai-text-analytics SDK to detect PII entities like
 * names, credit cards, phone numbers, emails, bank accounts, etc.
 *
 * Runs as a separate guardrail alongside Content Safety / Llama Guard.
 *
 * SDK: @azure/ai-text-analytics
 * Auth: AzureKeyCredential from @azure/core-auth
 * Method: recognizePiiEntities
 */

const { getAIConfig } = require('./aiAgent');
const configStore = require('../stores/configStore');

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
 * Detect PII entities in text.
 * Returns { hasPii, entities[] } or null on failure.
 *
 * Azure detects ALL PII types, then we filter client-side by the
 * admin's enabled categories. This avoids "Invalid Request" errors
 * from unsupported categoriesFilter values.
 */
async function detectPii(text, enabledCategories = null, confidenceThreshold = DEFAULT_PII_CONFIDENCE_THRESHOLD) {
    const client = await createClient();
    if (!client) {
        console.warn('[PiiDetection] No endpoint/key configured, skipping');
        return null;
    }

    const documents = [text];

    // Pass categoriesFilter to only scan for admin-enabled categories
    const options = {};
    if (enabledCategories && enabledCategories.length > 0) {
        options.categoriesFilter = enabledCategories;
    }

    // Auto-detect language (supports Dutch, German, French, etc.)
    const results = await client.recognizePiiEntities(documents, undefined, options);
    const result = results[0];

    if (result.error) {
        console.error(`[PiiDetection] API error:`, JSON.stringify(result.error));
        throw new Error(`PII Detection API error: ${result.error.code} - ${result.error.message}`);
    }

    // Filter by confidence threshold
    const detectedEntities = (result.entities || [])
        .filter(entity => entity.confidenceScore >= confidenceThreshold)
        .map(entity => ({
            text: entity.text,
            category: entity.category,
            subCategory: entity.subCategory || null,
            confidence: entity.confidenceScore,
            offset: entity.offset,
            length: entity.length,
            label: PII_CATEGORIES[entity.category]?.label || entity.category,
        }));

    return {
        hasPii: detectedEntities.length > 0,
        entities: detectedEntities,
        redactedText: result.redactedText || text,
    };
}

/**
 * Validate user input for PII.
 * Throws an error if PII is detected (blocking the message).
 *
 * @param {Array} messages - Chat messages array
 * @param {boolean} [agentPiiEnabled=false] - Per-agent override
 */
async function validateInputForPii(messages, agentPiiEnabled = false) {
    const aiConfig = await getAIConfig();

    // Check if PII detection is enabled
    const piiEnabled = aiConfig.piiDetectionEnabled || agentPiiEnabled;
    if (!piiEnabled) return;

    const lastUserMessage = messages.slice().reverse().find(m => m.role === 'user');
    if (!lastUserMessage) return;

    let inputText = lastUserMessage.content;
    if (Array.isArray(inputText)) {
        const textBlock = inputText.find(b => b.type === 'text');
        inputText = textBlock ? textBlock.text : '';
    }
    if (!inputText || inputText.length < 3) return;

    // Check cache
    const key = cacheKey('user_input', inputText);
    const cached = cacheGet(key);
    if (cached) {
        console.log(`[PiiDetection] Cache hit → ${cached.hasPii ? '🚫 PII found' : '✅ clean'}`);
        if (cached.hasPii) {
            const categoryList = [...new Set(cached.entities.map(e => e.label))].join(', ');
            const err = new Error(`PII Detected: Message contains sensitive personal information (${categoryList}). Please remove PII before sending.`);
            err.piiEntities = cached.entities;
            err.violationCodes = cached.entities.map(e => `PII:${e.category}`);
            throw err;
        }
        return;
    }

    console.log(`[PiiDetection] Scanning input (${inputText.length} chars)...`);
    const start = Date.now();

    try {
        const enabledCategories = aiConfig.piiDetectionCategories || ALL_PII_CATEGORY_IDS;
        const confidenceThreshold = aiConfig.piiDetectionConfidenceThreshold ?? DEFAULT_PII_CONFIDENCE_THRESHOLD;
        const result = await detectPii(inputText, enabledCategories, confidenceThreshold);
        if (!result) return; // No client configured, fail-open

        const ms = Date.now() - start;

        // Cache the result
        cacheSet(key, result);

        if (!result.hasPii) {
            console.log(`[PiiDetection] ✅ Input clean | ${ms}ms`);
            return;
        }

        const categoryList = [...new Set(result.entities.map(e => e.label))].join(', ');
        console.warn(`[PiiDetection] 🚫 PII found | ${categoryList} | ${result.entities.length} entities | ${ms}ms`);

        const err = new Error(`PII Detected: Message contains sensitive personal information (${categoryList}). Please remove PII before sending.`);
        err.piiEntities = result.entities;
        err.violationCodes = result.entities.map(e => `PII:${e.category}`);
        throw err;

    } catch (e) {
        if (e.message.includes('PII Detected')) throw e;
        console.error('[PiiDetection] Validation failed:', e.message);
        console.warn('[PiiDetection] Service unavailable, allowing content (fail-open)');
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
    PII_CATEGORIES,
    ALL_PII_CATEGORY_IDS,
    DEFAULT_PII_CONFIDENCE_THRESHOLD,
};
