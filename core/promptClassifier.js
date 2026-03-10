/**
 * Prompt Complexity Classifier
 * 
 * Two-layer classification:
 * 1. Heuristic-based (zero latency) — regex pattern scoring
 * 2. LLM-based (one fast API call) — uses llmClient for accurate classification
 * 
 * Supports 4 tiers: fast / thinking / writer / pro (Deep Thinking)
 */

const configStore = require('../stores/configStore');

// ─── Pattern Definitions ──────────────────────────────────────────

const CODE_PATTERNS = [
    /```/,                          // code blocks
    /\b(function|const|let|var|class|def|import|return|async|await)\b/,
    /\b(if|else|for|while|switch|try|catch)\b.*[{(]/,
    /=>/,                           // arrow functions
    /\b(npm|pip|apt|git|docker|kubectl)\b/,
    /[{}\[\]();].*[{}\[\]();]/,     // multiple code-like punctuation
    /\b(API|REST|GraphQL|SQL|JSON|XML|HTML|CSS)\b/i,
    /\b(debug|refactor|compile|deploy|migrate)\b/i
];

const MATH_PATTERNS = [
    /\b(calculate|compute|solve|equation|formula|integral|derivative|matrix)\b/i,
    /\b(algorithm|complexity|O\(n\)|recursion|dynamic programming)\b/i,
    /\b(prove|theorem|hypothesis|probability|statistics)\b/i,
    /[+\-*/^=]{2,}/,               // multiple math operators
    /\d+\s*[+\-*/^]\s*\d+/         // arithmetic expressions
];

const ANALYTICAL_PATTERNS = [
    /\b(explain|analyze|analyse|compare|contrast|evaluate|assess|critique|review|investigate)\b/i,
    /\b(why|how does|how do|what causes|what is the difference)\b/i,
    /\b(advantages?|disadvantages?|pros?\b.*\bcons?|trade.?offs?)\b/i,
    /\b(in.depth|comprehensive|thorough|detailed analysis|deep.?dive)\b/i,
];

const RESEARCH_PATTERNS = [
    /deep\s*research|in.depth research|thorough research/i,
    /(research|investigate|explore|study|examine)\b.*\b(about|into|on|regarding)\b/i,
    /\b(find out|look into|dig into|dive into)\b/i,
    /\b(white.?paper|literature review|case study)\b/i
];

const MULTISTEP_PATTERNS = [
    /\b(step by step|step-by-step|walk me through|guide me)\b/i,
    /\b(first|then|next|finally|after that)\b/i,
    /\b(plan|strategy|roadmap|architecture|design)\b/i,
    /\b(implement|build|create|develop)\b.*\b(system|application|app|service|pipeline)\b/i
];

const WRITER_PATTERNS = [
    /\b(write|compose|draft|create|generate)\b.*\b(story|poem|essay|article|blog|song|script|email|letter|report|post|chapter|novel|copy|description|content)\b/i,
    /\b(rewrite|rephrase|paraphrase|edit|proofread|polish)\b/i,
    /\b(long.?form|long form)\b/i,
    /\b(creative writing|copywriting|content writing|ghost.?writ)\b/i,
    /\b(in the style of|write like|tone of voice)\b/i,
    /\b(summarize|summarise|synopsis|overview|recap)\b.*\b(article|book|paper|document|report|text)\b/i,
    /\b(translate)\b.*\b(to|into)\b/i,
];

const SIMPLE_PATTERNS = [
    /^(hi|hello|hey|thanks|thank you|ok|yes|no|sure|got it|bye|yo|sup)\b/i,
    /^what (time|day|date) is it/i,
    /^(who|what|when|where) (is|are|was|were) \w+\??$/i,
    /^define /i,
    /^(how are you|what's up|how's it going)/i,
];

const INTENSITY_MODIFIERS = [
    /\b(deep|deeply|thorough|thoroughly|comprehensive|comprehensively|extensive|extensively|detailed|in.depth|carefully|rigorously)\b/i
];

// ─── Heuristic Classifier ─────────────────────────────────────────

function classifyPromptComplexity(message) {
    if (!message || typeof message !== 'string') {
        return { tier: 'fast', score: 0, reason: 'empty input' };
    }

    const msg = message.trim();
    let score = 0;
    const reasons = [];
    let isWriterTask = false;

    // Check for simple patterns first (early exit)
    if (msg.length < 50 && SIMPLE_PATTERNS.some(p => p.test(msg))) {
        return { tier: 'fast', score: 0, reason: 'simple greeting/query' };
    }

    // ── Writer detection (checked early to set flag) ──
    const writerMatches = WRITER_PATTERNS.filter(p => p.test(msg)).length;
    if (writerMatches >= 2) {
        isWriterTask = true;
        score += 3;
        reasons.push('writing task');
    } else if (writerMatches >= 1) {
        isWriterTask = true;
        score += 2;
        reasons.push('content creation');
    }

    // ── Length scoring ──
    if (msg.length > 500) {
        score += 2;
        reasons.push('long message');
    } else if (msg.length > 200) {
        score += 1;
        reasons.push('medium length');
    }

    // ── Code detection ──
    const codeMatches = CODE_PATTERNS.filter(p => p.test(msg)).length;
    if (codeMatches >= 3) {
        score += 3;
        reasons.push('heavy code context');
    } else if (codeMatches >= 1) {
        score += 2;
        reasons.push('code detected');
    }

    // ── Math/logic detection ──
    const mathMatches = MATH_PATTERNS.filter(p => p.test(msg)).length;
    if (mathMatches >= 2) {
        score += 3;
        reasons.push('math/logic problem');
    } else if (mathMatches >= 1) {
        score += 2;
        reasons.push('math element');
    }

    // ── Analytical keywords ──
    const analyticalMatches = ANALYTICAL_PATTERNS.filter(p => p.test(msg)).length;
    if (analyticalMatches >= 2) {
        score += 2;
        reasons.push('analytical query');
    } else if (analyticalMatches >= 1) {
        score += 1;
        reasons.push('analytical element');
    }

    // ── Research requests ──
    const researchMatches = RESEARCH_PATTERNS.filter(p => p.test(msg)).length;
    if (researchMatches >= 2) {
        score += 3;
        reasons.push('deep research request');
    } else if (researchMatches >= 1) {
        score += 2;
        reasons.push('research request');
    }

    // ── Multi-step indicators ──
    const multiStepMatches = MULTISTEP_PATTERNS.filter(p => p.test(msg)).length;
    if (multiStepMatches >= 2) {
        score += 2;
        reasons.push('multi-step task');
    } else if (multiStepMatches >= 1) {
        score += 1;
        reasons.push('structured request');
    }

    // ── Intensity modifiers amplify the score ──
    if (INTENSITY_MODIFIERS.some(p => p.test(msg)) && score > 0) {
        score += 1;
        reasons.push('intensity modifier');
    }

    // ── Multiple questions ──
    const questionMarks = (msg.match(/\?/g) || []).length;
    if (questionMarks >= 3) {
        score += 2;
        reasons.push('multiple questions');
    } else if (questionMarks >= 2) {
        score += 1;
        reasons.push('two questions');
    }

    // ── Determine tier from score + writer flag ──
    let tier;
    if (isWriterTask && score >= 3) {
        tier = 'writer';
    } else if (score >= 6) {
        tier = 'pro';
    } else if (score >= 3) {
        tier = 'thinking';
    } else {
        tier = 'fast';
    }

    return {
        tier,
        score,
        reason: reasons.join(', ') || 'standard query'
    };
}

// ─── LLM-based Classifier ────────────────────────────────────────

/**
 * Build a classification prompt that's tailored to the available tiers.
 */
function buildClassifierPrompt(availableTiers) {
    const tierDescriptions = {
        fast: 'fast — Simple questions, greetings, translations, quick factual lookups, casual chat, short answers',
        thinking: 'thinking — Code writing/debugging, analysis, multi-step problems, explanations, comparisons, moderate research',
        writer: 'writer — Long-form content: essays, articles, blog posts, stories, poems, emails, reports, copywriting, rewrites, translations of long text',
        pro: 'pro — Deep research, complex multi-domain reasoning, architecture design, advanced math/proofs, thorough investigation, anything demanding maximum quality or careful thought',
    };

    const descriptions = availableTiers
        .filter(t => tierDescriptions[t])
        .map(t => `• ${tierDescriptions[t]}`)
        .join('\n');

    return `You are a query classifier. Given a user message, respond with ONLY the tier name — one word, nothing else.

Available tiers:
${descriptions}

Rules:
- Default to "fast" for anything simple or ambiguous
- Use "writer" when the user asks to write, draft, compose, or create text content
- Use "thinking" for technical/analytical tasks that need reasoning
- Use "pro" only for complex multi-step problems, deep research, or requests asking to think carefully/deeply
- When in doubt between thinking and pro, choose thinking
- Respond with ONLY the tier name, no punctuation, no explanation`;
}

/**
 * Classify a message using LLM + heuristic fallback.
 * Uses llmClient for proper provider resolution.
 * 
 * @param {string} message - User message to classify
 * @param {Object} tiers - Tier config from configStore (or pass directly)
 * @returns {Promise<{tier: string, method: string, reason: string}>}
 */
async function classifyWithLLM(message, tiers) {
    if (!tiers) tiers = configStore.getConfig('chat_model_tiers') || {};

    const availableTiers = Object.entries(tiers)
        .filter(([_, t]) => t.modelId)
        .map(([key]) => key);

    if (availableTiers.length === 0) {
        return { tier: 'fast', method: 'fallback', reason: 'no tiers configured' };
    }

    // Use the fast tier model for classification (cheapest/fastest)
    const classifyModel = tiers.fast?.modelId;
    if (!classifyModel) {
        const heuristic = classifyPromptComplexity(message);
        return { tier: heuristic.tier, method: 'heuristic', reason: heuristic.reason };
    }

    try {
        const llmClient = require('./llmClient');
        const prompt = buildClassifierPrompt(availableTiers);
        const msgText = typeof message === 'string' ? message : JSON.stringify(message);

        const result = await llmClient.chat(classifyModel, [
            { role: 'system', content: prompt },
            { role: 'user', content: msgText }
        ], { maxTokens: 20, temperature: 0 });

        const suggested = (result.content || '').trim().toLowerCase().replace(/[^a-z]/g, '');

        if (suggested && tiers[suggested]?.modelId) {
            const msgPreview = typeof message === 'string' ? message.substring(0, 80) : '(multimodal)';
            console.log(`[Classifier] LLM: tier="${suggested}" for: "${msgPreview}"`);
            return { tier: suggested, method: 'llm', reason: `LLM classified as ${suggested}` };
        }

        // LLM returned invalid tier — fall through to heuristic
        console.log(`[Classifier] LLM returned invalid tier: "${suggested}", falling back`);
    } catch (err) {
        console.log(`[Classifier] LLM failed: ${err.message}, falling back to heuristics`);
    }

    // Heuristic fallback
    const heuristic = classifyPromptComplexity(typeof message === 'string' ? message : '');
    const fallbackTier = tiers[heuristic.tier]?.modelId ? heuristic.tier : 'fast';
    console.log(`[Classifier] Heuristic: tier="${fallbackTier}" (score=${heuristic.score}, ${heuristic.reason})`);
    return { tier: fallbackTier, method: 'heuristic', reason: heuristic.reason };
}

module.exports = { classifyPromptComplexity, classifyWithLLM };
