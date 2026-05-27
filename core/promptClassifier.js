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
    // Length alone is a weak signal of complexity — verbose questions are not
    // necessarily heavy reasoning tasks. Keep the contribution small so the
    // semantic signals (code, math, URLs) dominate.
    if (len > 1500) {
        score += 1;
        reasons.push('very long');
    } else if (len > 500) {
        score += 1;
        reasons.push('long');
    }

    // ── High-confidence shortcuts ──
    // Only extreme structural signals (lots of URLs to research, very large
    // code blocks to analyse) shortcut to deep_thinking. Long prose alone is
    // NOT enough — the LLM stage decides whether long = complex.
    const codeFenceLines = (msg.match(/```[\s\S]*?```/g) || [])
        .reduce((acc, block) => acc + block.split('\n').length, 0);
    if (urls >= 3 || codeFenceLines > 40) {
        return {
            tier: 'deep_thinking',
            score,
            reason: reasons.join(', ') || 'heavy input',
            confident: true,
        };
    }

    // ── Score-based tier (medium confidence) ──
    let tier;
    if (score >= 8) tier = 'deep_thinking';
    else if (score >= 3) tier = 'thinking';
    else tier = 'fast';

    // Confident heuristic verdicts:
    //   - very short input (handled at the top, len ≤ 12 → fast)
    //   - very heavy structural input (handled above → deep_thinking)
    //   - score ≥ 8 (overwhelming heavy signals → deep_thinking)
    // Everything else is ambiguous and should defer to the LLM, which knows
    // the user's language and can distinguish thinking vs flow vs writer.
    const confident = score >= 8;

    return { tier, score, reason: reasons.join(', ') || 'standard query', confident };
}

// ─── LLM Classifier ───────────────────────────────────────────────

function buildClassifierPrompt(availableTiers) {
    // Each tier description names a single, non-overlapping trigger. The
    // tiers are ordered from cheapest/simplest to heaviest so the model
    // reads them as an escalation ladder.
    const tierDescriptions = {
        fast:
            'fast — One-shot, low-effort answers. Greetings, acks, quick factual lookups, ' +
            'short translations, casual chat, single-sentence questions. Default for anything trivial.',
        thinking:
            'thinking — Single-pass reasoning on a focused problem. Code writing/debugging, ' +
            'one-topic explanations, comparisons, "how does X work", analysis of a single artefact. ' +
            'No multi-stage planning required.',
        standard:
            'standard — A multi-stage workflow tier (called "Flow") that runs a planner + tools + ' +
            'verifier pipeline. Use ONLY when the request clearly benefits from breaking the work ' +
            'into distinct phases the assistant must execute itself: e.g. "plan and then build X", ' +
            '"research topic Y, then write a structured report with sources", "design X, then ' +
            'implement it, then test it", or any task where the user expects the assistant to ' +
            'orchestrate several tools/skills end-to-end. Do NOT pick standard for ordinary ' +
            'questions, single-pass code help, or simple long-form writing.',
        writer:
            'writer — Pure long-form content production where the deliverable is the prose itself. ' +
            'Essays, articles, blog posts, stories, poems, emails, marketing copy, ghostwriting, ' +
            'rewrites/translations of long text. Pick writer over standard when the user just ' +
            'wants the text, not a multi-stage process.',
        deep_thinking:
            'deep_thinking — One careful, heavy single-pass answer. Deep research synthesis, ' +
            'complex multi-domain reasoning, advanced math/proofs, architecture trade-off ' +
            'analysis, "think carefully about X". Pick deep_thinking over standard when the ' +
            'user wants a single thorough answer, not an orchestrated workflow.',
    };

    const order = ['fast', 'thinking', 'standard', 'writer', 'deep_thinking'];
    const descriptions = order
        .filter(t => availableTiers.includes(t) && tierDescriptions[t])
        .map(t => `• ${tierDescriptions[t]}`)
        .join('\n');

    const longFormTier = availableTiers.includes('writer')
        ? 'writer'
        : (availableTiers.includes('deep_thinking') ? 'deep_thinking' : 'thinking');
    const flowExample = availableTiers.includes('standard')
        ? '\n"plan a 3-phase migration from MySQL to Postgres, then write the runbook" → standard'
        + '\n"research current EU AI Act articles, summarise findings, and produce a compliance checklist" → standard'
        : '';

    return `You are a multilingual query classifier. The user message may be in ANY language (English, Dutch, German, Spanish, French, Italian, Portuguese, Polish, Turkish, Arabic, Chinese, Japanese, etc.). Classify by intent, NOT by language. Respond with ONLY the tier name — one word, nothing else.

Available tiers (escalation ladder, cheapest first):
${descriptions}

Decision order — try each tier in turn and stop at the first match:
1. Trivial / one-line / greeting → fast
2. Single-pass technical or analytical question → thinking
3. Pure long-form writing deliverable → ${longFormTier}
4. Multi-stage orchestrated workflow (plan + execute + verify, multiple distinct phases) → ${availableTiers.includes('standard') ? 'standard' : longFormTier}
5. Heavy single-pass reasoning / deep research / architecture / proofs → ${availableTiers.includes('deep_thinking') ? 'deep_thinking' : 'thinking'}

Examples:
"hoi" → fast
"what is the capital of France?" → fast
"erkläre mir, wie ein neuronales Netz funktioniert" → thinking
"fix this null pointer in my Java code" → thinking
"compara las arquitecturas de microservicios y monolitos" → thinking
"schrijf een uitgebreid rapport over klimaatverandering" → ${longFormTier}${flowExample}
"investiga a fondo el impacto regulatorio del AI Act y dame un análisis" → ${availableTiers.includes('deep_thinking') ? 'deep_thinking' : 'thinking'}
"prove that the halting problem is undecidable" → ${availableTiers.includes('deep_thinking') ? 'deep_thinking' : 'thinking'}

Hard rules:
- Default to "fast" for anything ambiguous or short.
- "standard" is the WORKFLOW tier — only pick it when the user clearly asks the assistant to run multiple distinct phases (plan → do → verify, or research → write → check). When in doubt between standard and any other tier, do NOT pick standard.
- "deep_thinking" is for ONE big careful answer, not for multi-phase work.
- "writer" is for prose deliverables, not for analysis or planning.
- Respond with ONLY the tier name, no punctuation, no explanation.`;
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
