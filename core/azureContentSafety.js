/**
 * Azure AI Content Safety — cloud-based content moderation
 *
 * Uses the @azure-rest/ai-content-safety SDK to check text for harmful content.
 * Provides the same interface as the Llama Guard moderation (moderation.js)
 * so it can be used as a drop-in alternative.
 *
 * Categories detected:
 *   - Hate       (Hate and Fairness)
 *   - Violence   (Physical harm, weapons)
 *   - Sexual     (Sexual content, nudity)
 *   - SelfHarm   (Self-injury, suicide)
 *
 * SDK: @azure-rest/ai-content-safety v1.0.1
 * Auth: AzureKeyCredential from @azure/core-auth
 * API:  POST /text:analyze
 */

const { getAIConfig } = require('./aiAgent');
const configStore = require('../stores/configStore');
const { computeContentSafetyCost } = require('./azureServiceCosts');
const azureServiceUsageStore = require('../stores/azureServiceUsageStore');

// ── Cache (LRU, 5-min TTL) — shared structure with moderation.js ──────
const CACHE_MAX = 200;
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function cacheKey(channel, text) {
    return `azure:${channel}:${text.length}:${text.slice(0, 200)}`;
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

// ── Azure Content Safety categories (native, no mapping) ─────────────
const AZURE_CATEGORIES = {
    'Hate':     { label: 'Hate and Fairness' },
    'Violence': { label: 'Violence' },
    'Sexual':   { label: 'Sexual' },
    'SelfHarm': { label: 'Self-Harm' },
};

// All category IDs — used as default when none are configured
const ALL_AZURE_CATEGORY_IDS = Object.keys(AZURE_CATEGORIES);

// Default: block severity >= 2 (out of 0-7 scale)
const DEFAULT_SEVERITY_THRESHOLD = 2;

/**
 * Create an Azure Content Safety client.
 * Lazily loaded to avoid import issues if package not installed.
 */
async function createClient() {
    const endpoint = await configStore.getConfig('azure_content_safety_endpoint');
    const apiKey = await configStore.getSecret('azure_content_safety_key');

    if (!endpoint || !apiKey) {
        return null;
    }

    const ContentSafetyClient = require('@azure-rest/ai-content-safety').default;
    const { AzureKeyCredential } = require('@azure/core-auth');

    return ContentSafetyClient(endpoint, new AzureKeyCredential(apiKey));
}

/**
 * Analyze text with Azure Content Safety API.
 * Returns { allowed, category, severity, label } or null on failure.
 */
async function analyzeText(text, severityThreshold, enabledCategories = null) {
    const client = await createClient();
    if (!client) {
        console.warn('[AzureContentSafety] No endpoint/key configured, skipping');
        return null;
    }

    const { isUnexpected } = require('@azure-rest/ai-content-safety');

    // Only request analysis for enabled categories
    const categoriesToCheck = enabledCategories && enabledCategories.length > 0
        ? enabledCategories
        : ALL_AZURE_CATEGORY_IDS;

    const result = await client.path('/text:analyze').post({
        body: {
            text,
            categories: categoriesToCheck,
        },
    });

    if (isUnexpected(result)) {
        throw new Error(`Azure Content Safety API error: ${result.status} - ${JSON.stringify(result.body)}`);
    }

    const categories = result.body.categoriesAnalysis || [];
    const threshold = severityThreshold ?? DEFAULT_SEVERITY_THRESHOLD;

    // ── Track usage cost (fire-and-forget) ──
    const charCount = text.length;
    const cost = computeContentSafetyCost(charCount);
    azureServiceUsageStore.logAzureServiceUsage({
        service_type: 'content_safety',
        input_chars: charCount,
        estimated_cost: cost,
        source: 'unknown',
    }).catch(() => {});
    if (cost > 0) console.log(`[AzureContentSafety] 💰 Est. cost: $${cost.toFixed(6)} (${charCount} chars)`);

    // Find the highest-severity violation
    let worstViolation = null;
    for (const cat of categories) {
        if (cat.severity >= threshold) {
            if (!worstViolation || cat.severity > worstViolation.severity) {
                worstViolation = cat;
            }
        }
    }

    if (!worstViolation) {
        return { allowed: true, category: 'none', severity: 0, label: 'None' };
    }

    const catInfo = AZURE_CATEGORIES[worstViolation.category] || {
        label: worstViolation.category,
    };

    return {
        allowed: false,
        category: worstViolation.category,
        severity: worstViolation.severity,
        label: catInfo.label,
        confidence: worstViolation.severity / 7, // Normalize to 0-1 range for compatibility
    };
}

/**
 * Validate user input messages against Azure Content Safety.
 * Same interface as validateWithGuardService in moderation.js.
 *
 * @param {Array} messages - Chat messages array
 * @param {boolean} [agentModerationEnabled=false] - Per-agent override
 * @param {Array|null} [allowedCategories=null] - Only enforce these categories
 * @throws {Error} If content violates moderation policies
 */
async function validateWithAzureContentSafety(messages, agentModerationEnabled = false, allowedCategories = null) {
    const aiConfig = await getAIConfig();

    // Check if Azure Content Safety is the active provider
    if (aiConfig.moderationProvider !== 'azure') return;

    const config = aiConfig.llamaGuardConfig; // Reuse same enabled/threshold structure
    if (!config || (!config.enabled && !agentModerationEnabled)) return;

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
        console.log(`[AzureContentSafety] Cache hit → ${cached.allowed ? '✅ safe' : '🚫 blocked'} | ${cached.category} (${cached.label})`);
        if (!cached.allowed) {
            const err = new Error(`Safety Violation: Request blocked due to ${cached.label} (severity: ${cached.severity}).`);
            err.outcome = JSON.stringify([{ category: cached.category, label: cached.label, score: (cached.confidence || 0).toFixed(3) }]);
            err.violationCodes = [cached.category];
            throw err;
        }
        return;
    }

    console.log(`[AzureContentSafety] Analyzing input (${inputText.length} chars)...`);
    const start = Date.now();

    try {
        const severityThreshold = aiConfig.azureContentSafetySeverityThreshold ?? DEFAULT_SEVERITY_THRESHOLD;
        const enabledCategories = aiConfig.azureContentSafetyCategories || ALL_AZURE_CATEGORY_IDS;
        const result = await analyzeText(inputText, severityThreshold, enabledCategories);
        if (!result) return; // No client configured, fail-open

        const ms = Date.now() - start;

        // Cache the result
        cacheSet(key, result);

        if (result.allowed) {
            console.log(`[AzureContentSafety] ✅ Input safe | ${ms}ms`);
            return;
        }

        // Check if category is in allowed list (org/agent filtering)
        if (allowedCategories && allowedCategories.length > 0) {
            if (!allowedCategories.includes(result.category)) {
                console.log(`[AzureContentSafety] Category ${result.category} not in enforcement list, allowing`);
                return;
            }
        }

        console.warn(`[AzureContentSafety] 🚫 Input BLOCKED | ${result.category} (${result.label}) | severity: ${result.severity} | ${ms}ms`);

        const err = new Error(`Safety Violation: Request blocked due to ${result.label} (severity: ${result.severity}).`);
        err.outcome = JSON.stringify([{ category: result.category, label: result.label, score: (result.confidence || 0).toFixed(3) }]);
        err.violationCodes = [result.category];
        throw err;

    } catch (e) {
        if (e.message.includes('Safety Violation')) throw e;
        console.error('[AzureContentSafety] Validation failed:', e.message);
        console.warn('[AzureContentSafety] Service unavailable, allowing content (fail-open)');
    }
}

/**
 * Validate agent output against Azure Content Safety.
 * Same interface as validateOutputWithGuardService in moderation.js.
 */
async function validateOutputWithAzureContentSafety(content, allowedCategories = null) {
    const aiConfig = await getAIConfig();

    if (aiConfig.moderationProvider !== 'azure') return;

    const config = aiConfig.llamaGuardConfig;
    if (!config || !config.enabled) return;
    if (!content || content.length < 3) return;

    const key = cacheKey('assistant_output', content);
    const cached = cacheGet(key);
    if (cached) {
        console.log(`[AzureContentSafety] Cache hit (output) → ${cached.allowed ? '✅ safe' : '🚫 blocked'}`);
        if (cached.allowed) return;
        const err = new Error(`Safety Violation: Response blocked due to ${cached.label} (severity: ${cached.severity}).`);
        err.outcome = JSON.stringify([{ category: cached.category, label: cached.label, score: (cached.confidence || 0).toFixed(3) }]);
        err.violationCodes = [cached.category];
        throw err;
    }

    try {
        const severityThreshold = aiConfig.azureContentSafetySeverityThreshold ?? DEFAULT_SEVERITY_THRESHOLD;
        const enabledCategories = aiConfig.azureContentSafetyCategories || ALL_AZURE_CATEGORY_IDS;
        const result = await analyzeText(content, severityThreshold, enabledCategories);
        if (!result) return;

        cacheSet(key, result);

        if (result.allowed) {
            console.log(`[AzureContentSafety] ✅ Output safe`);
            return;
        }

        if (allowedCategories && allowedCategories.length > 0) {
            if (!allowedCategories.includes(result.category)) return;
        }

        console.warn(`[AzureContentSafety] 🚫 Output BLOCKED | ${result.category} (${result.label}) | severity: ${result.severity}`);

        const err = new Error(`Safety Violation: Response blocked due to ${result.label} (severity: ${result.severity}).`);
        err.outcome = JSON.stringify([{ category: result.category, label: result.label, score: (result.confidence || 0).toFixed(3) }]);
        err.violationCodes = [result.category];
        throw err;

    } catch (e) {
        if (e.message.includes('Safety Violation')) throw e;
        console.warn('[AzureContentSafety] Output validation unavailable, allowing (fail-open)');
    }
}

module.exports = {
    validateWithAzureContentSafety,
    validateOutputWithAzureContentSafety,
    AZURE_CATEGORIES,
    ALL_AZURE_CATEGORY_IDS,
    DEFAULT_SEVERITY_THRESHOLD,
};
