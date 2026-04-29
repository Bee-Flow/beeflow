/**
 * Prompt Complexity Classifier — auto-tier model selection.
 *
 * Three-stage pipeline, evaluated in order:
 *   1. Universal heuristic shortcut — language-agnostic structural signals
 *      (length, code fences, math operators, URLs, lists). High-confidence
 *      cases (very short / very long / heavy code) return immediately with
 *      no LLM call.
 *   2. In-memory cache — repeat prompts (same message + same available
 *      tiers) reuse the previous decision. TTL 10 min, LRU eviction.
 *   3. LLM classifier — fallback for ambiguous cases. Multilingual prompt
 *      with few-shot examples in EN/NL/DE/ES so the model classifies by
 *      intent regardless of language. Model is admin-configurable via the
 *      `auto_classifier_model` config key (defaults to the fast tier).
 *
 * Tier-key normalisation maps the legacy `pro`/`smart` keys to their
 * modern equivalents (`deep_thinking`/`thinking`) when configured.
 */

const crypto = require('crypto');
const configStore = require('../stores/configStore');

// ─── Universal Heuristic Signals ──────────────────────────────────
// These patterns are deliberately language-independent: they look at
// punctuation, code/math syntax, URLs, list structure, and length.
// Any natural-language keyword detection is delegated to the LLM stage.

const CODE_FENCE = /```/;
const CODE_PUNCTUATION = /[{}();].*[{}();]/;            // any two of these on one line
const ARROW_FN = /=>/;
const SEMICOLON_DENSITY = /;.*;/;                       // ≥ 2 semicolons

const MATH_OPERATORS = /[∑∫≈≥≤≠±√π]/;
const MATH_SEQ_OPS = /[+\-*/^=]{2,}/;                   // **, ==, +=, ^=
const MATH_ARITHMETIC = /\d+\s*[+\-*/^]\s*\d+/;          // 12+34, 5*7

const URL_PATTERN = /\bhttps?:\/\/|www\./gi;
const LIST_LINE = /^\s*(?:[-*•]|\d+[.)])\s+\S/m;

// ─── Cache ────────────────────────────────────────────────────────

const CACHE_MAX = 500;
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // key → { value, ts }

function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
        cache.delete(key);
        return null;
    }
    // Refresh LRU position
    cache.delete(key);
    cache.set(key, entry);
    return entry.value;
}

function cacheSet(key, value) {
    if (cache.size >= CACHE_MAX) {
        // Evict oldest (Map iterates insertion order)
        const firstKey = cache.keys().next().value;
        if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(key, { value, ts: Date.now() });
}

function clearClassifierCache() {
    cache.clear();
}

function buildCacheKey(message, availableTiers, classifierModel) {
    const msg = typeof message === 'string' ? message : JSON.stringify(message);
    const shape = [...availableTiers].sort().join(',');
    const h = crypto.createHash('sha1');
    h.update(msg);
    h.update('');
    h.update(shape);
    h.update('');
    h.update(classifierModel || '');
    return h.digest('hex');
}

// ─── Heuristic Classifier ─────────────────────────────────────────

function classifyPromptComplexity(message) {
    if (!message || typeof message !== 'string') {
        return { tier: 'fast', score: 0, reason: 'empty input', confident: true };
    }

    const msg = message.trim();
    const len = msg.length;
    const reasons = [];
    let score = 0;

    // ── High-confidence shortcut: very short input ──
    // Any language: a 1–12 char input is a greeting/ack, never deep work.
    if (len <= 12) {
        return { tier: 'fast', score: 0, reason: 'very short input', confident: true };
    }

    // ── Code signals ──
    let codeHits = 0;
    if (CODE_FENCE.test(msg)) codeHits += 2;
    if (CODE_PUNCTUATION.test(msg)) codeHits += 1;
    if (ARROW_FN.test(msg)) codeHits += 1;
    if (SEMICOLON_DENSITY.test(msg)) codeHits += 1;
    if (codeHits >= 2) {
        score += 3;
        reasons.push('code');
    } else if (codeHits >= 1) {
        score += 1;
        reasons.push('code-ish');
    }

    // ── Math signals ──
    let mathHits = 0;
    if (MATH_OPERATORS.test(msg)) mathHits += 2;
    if (MATH_SEQ_OPS.test(msg)) mathHits += 1;
    if (MATH_ARITHMETIC.test(msg)) mathHits += 1;
    if (mathHits >= 2) {
        score += 2;
        reasons.push('math');
    } else if (mathHits >= 1) {
        score += 1;
        reasons.push('math-ish');
    }

    // ── URL / research signals ──
    const urls = (msg.match(URL_PATTERN) || []).length;
    if (urls >= 3) {
        score += 2;
        reasons.push('many URLs');
    } else if (urls >= 1) {
        score += 1;
        reasons.push('URL present');
    }

    // ── List structure (multi-step) ──
    if (LIST_LINE.test(msg)) {
        score += 1;
        reasons.push('list/steps');
    }

    // ── Multiple questions ──
    const questionMarks = (msg.match(/\?/g) || []).length;
    if (questionMarks >= 3) {
        score += 2;
        reasons.push('many questions');
    } else if (questionMarks >= 2) {
        score += 1;
        reasons.push('two questions');
    }

    // ── Length scaling ──
    if (len > 1500) {
        score += 3;
        reasons.push('very long');
    } else if (len > 500) {
        score += 2;
        reasons.push('long');
    } else if (len > 200) {
        score += 1;
        reasons.push('medium');
    }

    // ── High-confidence shortcuts ──
    // Very long messages, heavy URLs, or large code blocks → deep_thinking.
    const codeFenceLines = (msg.match(/```[\s\S]*?```/g) || [])
        .reduce((acc, block) => acc + block.split('\n').length, 0);
    if (len > 1500 || urls >= 3 || codeFenceLines > 40) {
        return {
            tier: 'deep_thinking',
            score,
            reason: reasons.join(', ') || 'heavy input',
            confident: true,
        };
    }

    // Tiny structural input (≤ 80 chars, no code/math/url) → fast.
    if (len <= 80 && score === 0) {
        return { tier: 'fast', score: 0, reason: 'short structural', confident: true };
    }

    // ── Score-based tier (medium confidence) ──
    let tier;
    if (score >= 6) tier = 'deep_thinking';
    else if (score >= 3) tier = 'thinking';
    else tier = 'fast';

    // 80 < len ≤ 1500 and no strong signals → ambiguous: defer to LLM.
    const confident = score >= 6 || (score === 0 && len <= 80);

    return { tier, score, reason: reasons.join(', ') || 'standard query', confident };
}

// ─── LLM Classifier ───────────────────────────────────────────────

function buildClassifierPrompt(availableTiers) {
    const tierDescriptions = {
        fast: 'fast — Greetings, simple questions, quick lookups, casual chat, short answers',
        thinking: 'thinking — Code writing/debugging, analysis, multi-step problems, explanations, comparisons, moderate research',
        writer: 'writer — Long-form content: essays, articles, blog posts, stories, poems, emails, reports, copywriting',
        deep_thinking: 'deep_thinking — Deep research, complex multi-domain reasoning, architecture design, advanced math/proofs, thorough investigation',
    };

    const descriptions = availableTiers
        .filter(t => tierDescriptions[t])
        .map(t => `• ${tierDescriptions[t]}`)
        .join('\n');

    return `You are a multilingual query classifier. The user message may be in ANY language (English, Dutch, German, Spanish, French, Italian, Portuguese, Polish, Turkish, Arabic, Chinese, Japanese, etc.). Classify by intent, NOT by language. Respond with ONLY the tier name — one word, nothing else.

Available tiers:
${descriptions}

Examples:
"hoi" → fast
"schrijf een uitgebreid rapport over klimaatverandering" → ${availableTiers.includes('writer') ? 'writer' : 'deep_thinking'}
"erkläre mir, wie ein neuronales Netz funktioniert" → thinking
"compara las arquitecturas de microservicios y monolitos" → thinking
"investiga a fondo el impacto regulatorio del AI Act" → deep_thinking
"fix this null pointer in my Java code" → thinking

Rules:
- Default to "fast" for anything simple or ambiguous
- Use "thinking" for technical/analytical tasks that need reasoning
- Use "deep_thinking" only for complex multi-step problems, deep research, or requests asking to think carefully/deeply
- When in doubt between thinking and deep_thinking, choose thinking
- Respond with ONLY the tier name, no punctuation, no explanation`;
}

// Map legacy tier keys to current ones if the modern key is configured.
function normaliseTierKey(suggested, tiers) {
    if (!suggested) return suggested;
    if (suggested === 'pro' && tiers.deep_thinking?.modelId) return 'deep_thinking';
    if (suggested === 'smart' && tiers.thinking?.modelId) return 'thinking';
    if (suggested === 'deep_thinking' && !tiers.deep_thinking?.modelId && tiers.pro?.modelId) return 'pro';
    return suggested;
}

/**
 * Classify a message using heuristic shortcut → cache → LLM.
 *
 * @param {string} message
 * @param {Object} tiers - Tier config map (key → { modelId, ... })
 * @param {Object} [opts]
 * @param {string|null} opts.userOrgId - Org ID for EU-mode tier overrides
 * @returns {Promise<{tier: string, method: string, reason: string}>}
 */
async function classifyWithLLM(message, tiers, { userOrgId = null } = {}) {
    if (!tiers) {
        const { getEUAwareTiers } = require('./modelResolver');
        tiers = await getEUAwareTiers({ userOrgId });
    }

    const availableTiers = Object.entries(tiers)
        .filter(([_, t]) => t.modelId)
        .map(([key]) => key);

    if (availableTiers.length === 0) {
        return { tier: 'fast', method: 'fallback', reason: 'no tiers configured' };
    }

    const msgText = typeof message === 'string' ? message : JSON.stringify(message);

    // Stage 1: heuristic shortcut for high-confidence cases.
    const heuristic = classifyPromptComplexity(msgText);
    if (heuristic.confident) {
        const tier = tiers[heuristic.tier]?.modelId
            ? heuristic.tier
            : (tiers[normaliseTierKey(heuristic.tier, tiers)]?.modelId
                ? normaliseTierKey(heuristic.tier, tiers)
                : 'fast');
        const finalTier = tiers[tier]?.modelId ? tier : 'fast';
        console.log(`[Classifier] shortcut: tier="${finalTier}" (${heuristic.reason})`);
        return { tier: finalTier, method: 'shortcut', reason: heuristic.reason };
    }

    // Resolve classifier model: admin override → fast tier → bail.
    const adminModel = await configStore.getConfig('auto_classifier_model').catch(() => null);
    const classifyModel = (typeof adminModel === 'string' && adminModel.trim())
        ? adminModel.trim()
        : tiers.fast?.modelId;

    if (!classifyModel) {
        const tier = tiers[heuristic.tier]?.modelId ? heuristic.tier : 'fast';
        console.log(`[Classifier] heuristic (no classifier model): tier="${tier}" (${heuristic.reason})`);
        return { tier, method: 'heuristic', reason: heuristic.reason };
    }

    // Stage 2: cache lookup.
    const cacheKey = buildCacheKey(msgText, availableTiers, classifyModel);
    const cached = cacheGet(cacheKey);
    if (cached) {
        console.log(`[Classifier] cache: tier="${cached.tier}"`);
        return { tier: cached.tier, method: 'cache', reason: cached.reason };
    }

    // Stage 3: LLM call.
    try {
        const llmClient = require('./llmClient');
        const prompt = buildClassifierPrompt(availableTiers);

        const result = await llmClient.chat(classifyModel, [
            { role: 'system', content: prompt },
            { role: 'user', content: msgText },
        ], { maxTokens: 8, temperature: 0 });

        const raw = (result.content || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
        const suggested = normaliseTierKey(raw, tiers);

        if (suggested && tiers[suggested]?.modelId) {
            const preview = msgText.substring(0, 80);
            console.log(`[Classifier] llm (model=${classifyModel}): tier="${suggested}" for: "${preview}"`);
            const out = { tier: suggested, method: 'llm', reason: `LLM classified as ${suggested}` };
            cacheSet(cacheKey, { tier: out.tier, reason: out.reason });
            return out;
        }

        console.log(`[Classifier] LLM returned invalid tier: "${raw}", falling back`);
    } catch (err) {
        console.log(`[Classifier] LLM failed: ${err.message}, falling back to heuristic`);
    }

    // Stage 4: heuristic fallback (when LLM fails or returns garbage).
    const fallbackKey = normaliseTierKey(heuristic.tier, tiers);
    const fallbackTier = tiers[fallbackKey]?.modelId ? fallbackKey : 'fast';
    console.log(`[Classifier] heuristic fallback: tier="${fallbackTier}" (score=${heuristic.score}, ${heuristic.reason})`);
    return { tier: fallbackTier, method: 'heuristic', reason: heuristic.reason };
}

module.exports = {
    classifyPromptComplexity,
    classifyWithLLM,
    clearClassifierCache,
    normaliseTierKey,
};
