/**
 * Guard Service Moderation — AI-powered content safety validation
 * 
 * Calls the self-hosted Guard Service (Llama Guard) instead of external APIs.
 * No API key needed — fully self-hosted.
 * 
 * Includes an in-memory LRU cache to skip redundant guard calls for
 * identical inputs within a 5-minute window.
 */

const { getAIConfig } = require('./aiAgent');

// ── Guard Result Cache (LRU, 5-min TTL) ──────────────────────────────
const GUARD_CACHE_MAX = 200;
const GUARD_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const guardCache = new Map(); // key → { result, timestamp }

function guardCacheKey(channel, text) {
    // Use first 200 chars + length as a low-collision key
    return `${channel}:${text.length}:${text.slice(0, 200)}`;
}

function guardCacheGet(key) {
    const entry = guardCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > GUARD_CACHE_TTL_MS) {
        guardCache.delete(key);
        return null;
    }
    // Move to end (LRU refresh)
    guardCache.delete(key);
    guardCache.set(key, entry);
    return entry.result;
}

function guardCacheSet(key, result) {
    // Evict oldest if at capacity
    if (guardCache.size >= GUARD_CACHE_MAX) {
        const oldest = guardCache.keys().next().value;
        guardCache.delete(oldest);
    }
    guardCache.set(key, { result, timestamp: Date.now() });
}

const GUARD_CATEGORIES = {
    "S1": "Violent Crimes",
    "S2": "Non-Violent Crimes",
    "S3": "Sex-Related Crimes",
    "S4": "Child Sexual Exploitation",
    "S5": "Defamation",
    "S6": "Specialized Advice",
    "S7": "Privacy",
    "S8": "Intellectual Property",
    "S9": "Indiscriminate Weapons",
    "S10": "Hate",
    "S11": "Suicide & Self-Harm",
    "S12": "Sexual Content",
    "S13": "Elections",
    "S14": "Code Interpreter Abuse",
    "none": "None"
};

const DEFAULT_MODERATION_THRESHOLD = 0.7;

// Map old Privacy Shield category IDs → Llama Guard S-codes
const LEGACY_CATEGORY_MAP = {
    'violence_and_threats': 'S1',
    'dangerous_and_criminal_content': 'S2',
    'hate_and_discrimination': 'S10',
    'selfharm': 'S11',
    'sexual': 'S12',
    'health': 'S6',
    'financial': 'S6',
    'law': 'S6',
    'pii': 'S7',
};

/**
 * Normalize category list — convert any legacy IDs to S-codes,
 * pass through S-codes as-is, deduplicate.
 */
function normalizeCategories(categories) {
    if (!categories || categories.length === 0) return null;
    const normalized = new Set();
    for (const cat of categories) {
        if (cat.startsWith('S') && /^S\d+$/.test(cat)) {
            normalized.add(cat); // Already an S-code
        } else if (LEGACY_CATEGORY_MAP[cat]) {
            normalized.add(LEGACY_CATEGORY_MAP[cat]);
        }
        // Unknown legacy IDs are dropped
    }
    return normalized.size > 0 ? Array.from(normalized) : null;
}

/**
 * Get the Guard Service URL from config or environment.
 */
function getGuardServiceUrl() {
    return process.env.GUARD_SERVICE_URL || 'http://guard-service:8100';
}

/**
 * Validate messages against the self-hosted Guard Service (Llama Guard).
 * Throws on safety violations (catch has special handling for "Safety Violation").
 * 
 * @param {Array} messages - Chat messages array
 * @param {boolean} [agentModerationEnabled=false] - Per-agent override
 * @param {Array|null} [allowedCategories=null] - Only enforce these categories
 * @throws {Error} If content violates moderation policies
 */
async function validateWithGuardService(messages, agentModerationEnabled = false, allowedCategories = null) {
    const aiConfig = await getAIConfig();
    const config = aiConfig.llamaGuardConfig;

    if (!config || (!config.enabled && !agentModerationEnabled)) return;

    const lastUserMessage = messages.slice().reverse().find(m => m.role === 'user');
    if (!lastUserMessage) return;

    let inputText = lastUserMessage.content;
    if (Array.isArray(inputText)) {
        const textBlock = inputText.find(b => b.type === 'text');
        inputText = textBlock ? textBlock.text : '';
    }
    if (!inputText || inputText.length < 3) return;

    // Check cache first
    const cacheKey = guardCacheKey('user_input', inputText);
    const cached = guardCacheGet(cacheKey);
    if (cached) {
        console.log(`[GuardService] Cache hit (${inputText.length} chars) — ${cached.allowed ? 'safe' : 'blocked'}`);
        if (!cached.allowed) {
            // Replay the cached violation
            const label = GUARD_CATEGORIES[cached.category] || cached.category;
            const violations = `${label} (${cached.confidence.toFixed(3)})`;
            const err = new Error(`Safety Violation: Request blocked due to ${violations}.`);
            err.outcome = JSON.stringify([{ category: cached.category, label, score: cached.confidence.toFixed(3) }]);
            err.violationCodes = [cached.category];
            throw err;
        }
        return;
    }

    console.log(`[GuardService] Validating input (${inputText.length} chars)...`);
    const guardStart = Date.now();

    try {
        const guardUrl = getGuardServiceUrl();

        const response = await fetch(`${guardUrl}/moderate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                channel: 'user_input',
                lang: 'unknown',
                content: inputText,
                metadata: {}
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Guard Service Error: ${response.status} - ${errText}`);
        }

        const result = await response.json();
        const guardMs = Date.now() - guardStart;

        // Cache the result
        guardCacheSet(cacheKey, result);

        // Allowed → safe
        if (result.allowed) {
            console.log(`[GuardService] Content is safe (category=${result.category}, confidence=${result.confidence}, latency=${guardMs}ms)`);
            return;
        }

        // Blocked — check if category is in allowed list
        const normalizedAllowed = normalizeCategories(allowedCategories);
        if (normalizedAllowed && normalizedAllowed.length > 0) {
            if (!normalizedAllowed.includes(result.category)) {
                console.log(`[GuardService] Category ${result.category} not in enforcement list [${normalizedAllowed.join(',')}], allowing`);
                return;
            }
        }

        // Check threshold
        const threshold = config.threshold || DEFAULT_MODERATION_THRESHOLD;
        if (result.confidence < threshold) {
            console.log(`[GuardService] Confidence ${result.confidence} below threshold ${threshold}, allowing`);
            return;
        }

        // Violation detected
        const label = GUARD_CATEGORIES[result.category] || result.category;
        const violations = `${label} (${result.confidence.toFixed(3)})`;
        console.warn(`[GuardService] Blocked content. Violations: ${violations}`);

        const err = new Error(`Safety Violation: Request blocked due to ${violations}.`);
        err.outcome = JSON.stringify([{
            category: result.category,
            label,
            score: result.confidence.toFixed(3)
        }]);
        err.violationCodes = [result.category];
        throw err;

    } catch (e) {
        if (e.message.includes("Safety Violation")) throw e;
        // Guard service unavailable — log and allow (fail-open)
        console.error("[GuardService] Validation failed:", e.message);
        console.warn("[GuardService] Guard service unavailable, allowing content (fail-open)");
    }
}

/**
 * Validate agent output against the Guard Service.
 * Same as input validation but uses 'assistant_output' channel.
 */
async function validateOutputWithGuardService(content, allowedCategories = null) {
    const aiConfig = await getAIConfig();
    const config = aiConfig.llamaGuardConfig;

    if (!config || !config.enabled) return;
    if (!content || content.length < 3) return;

    // Check cache
    const cacheKey = guardCacheKey('assistant_output', content);
    const cached = guardCacheGet(cacheKey);
    if (cached) {
        if (cached.allowed) return;
        // Replay violation
        const label = GUARD_CATEGORIES[cached.category] || cached.category;
        const violations = `${label} (${cached.confidence.toFixed(3)})`;
        const err = new Error(`Safety Violation: Response blocked due to ${violations}.`);
        err.outcome = JSON.stringify([{ category: cached.category, label, score: cached.confidence.toFixed(3) }]);
        err.violationCodes = [cached.category];
        throw err;
    }

    try {
        const guardUrl = getGuardServiceUrl();
        const guardStart = Date.now();

        const response = await fetch(`${guardUrl}/moderate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                channel: 'assistant_output',
                lang: 'unknown',
                content,
                metadata: {}
            })
        });

        if (!response.ok) return; // Fail-open

        const result = await response.json();
        const guardMs = Date.now() - guardStart;

        // Cache the result
        guardCacheSet(cacheKey, result);

        if (result.allowed) {
            console.log(`[GuardService] Output is safe (${guardMs}ms)`);
            return;
        }

        if (normalizeCategories(allowedCategories)?.length > 0) {
            if (!normalizeCategories(allowedCategories).includes(result.category)) return;
        }

        const threshold = config.threshold || DEFAULT_MODERATION_THRESHOLD;
        if (result.confidence < threshold) return;

        const label = GUARD_CATEGORIES[result.category] || result.category;
        const violations = `${label} (${result.confidence.toFixed(3)})`;
        console.warn(`[GuardService] Output blocked: ${violations}`);

        const err = new Error(`Safety Violation: Response blocked due to ${violations}.`);
        err.outcome = JSON.stringify([{ category: result.category, label, score: result.confidence.toFixed(3) }]);
        err.violationCodes = [result.category];
        throw err;

    } catch (e) {
        if (e.message.includes("Safety Violation")) throw e;
        console.warn("[GuardService] Output validation unavailable, allowing (fail-open)");
    }
}

// Alias for convenience
const validateWithLlamaGuard = validateWithGuardService;

module.exports = {
    validateWithGuardService,
    validateWithLlamaGuard,
    validateOutputWithGuardService,
    GUARD_CATEGORIES,
    DEFAULT_MODERATION_THRESHOLD
};
