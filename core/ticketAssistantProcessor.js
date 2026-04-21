/**
 * Ticket Assistant Processor — Multi-stage ticket/email-to-KB-article pipeline
 *
 * Ported from n8n workflows:
 *   1.3 "Get Ticket Message"  → Stage 1 (HTML cleanup) + Stage 2 (PII redaction)
 *   1.1 "Ticketlist to Summary" → Stage 3 (AI summarization + categorization)
 *
 * Pipeline:
 *   Raw source text (email or ticket) → cleanEmail() → redactPII() → summarizeToArticle()
 */

// ──────────────────────────────────────────────
// Stage 1: HTML → Clean Text
// Ported directly from n8n Code node "Code: Cleanup HTML/Email"
// ──────────────────────────────────────────────

function decodeHtmlEntities(str) {
    if (!str) return '';
    const map = {
        '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
        '&quot;': '"', '&#34;': '"', '&#39;': "'", '&apos;': "'",
    };
    return str.replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#34;|&#39;|&apos;/g, m => map[m] ?? m);
}

function stripHtmlToText(input) {
    let s = String(input || '');

    s = s.replace(/<head[\s\S]*?<\/head>/gi, '');
    s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
    s = s.replace(/<style[\s\S]*?<\/style>/gi, '');

    // Remove images entirely
    s = s.replace(/<img\b[^>]*>/gi, '');

    // Links: keep link text only
    s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1');

    // Basic formatting
    s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
    s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');

    // Line breaks / blocks
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/(p|div|tr|table|thead|tbody|tfoot)>/gi, '\n');
    s = s.replace(/<(p|div|tr|table|thead|tbody|tfoot)\b[^>]*>/gi, '');

    // Lists
    s = s.replace(/<li\b[^>]*>/gi, '- ');
    s = s.replace(/<\/li>/gi, '\n');
    s = s.replace(/<\/?(ul|ol)\b[^>]*>/gi, '\n');

    // Remove remaining tags
    s = s.replace(/<\/?[^>]+>/g, '');

    // Decode entities + normalize whitespace
    s = decodeHtmlEntities(s);
    s = s.replace(/\r\n/g, '\n')
         .replace(/[ \t]+\n/g, '\n')
         .replace(/\n{3,}/g, '\n\n')
         .trim();

    return s;
}

function removeUrls(text) {
    let s = String(text || '');

    // Markdown image/link forms
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt) => (alt || '').trim());
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');

    // <https://...>
    s = s.replace(/<https?:\/\/[^>]+>/gi, '');

    // Bare URLs
    s = s.replace(/https?:\/\/\S+/gi, '');

    // mailto:
    s = s.replace(/\bmailto:\S+/gi, '');

    // cleanup
    s = s.replace(/[ \t]+\n/g, '\n')
         .replace(/\n{3,}/g, '\n\n')
         .trim();

    return s;
}

function looksLikePercentEncodedJunk(line) {
    const l = String(line || '');
    const matches = l.match(/%[0-9A-Fa-f]{2}/g);
    const pctCount = matches ? matches.length : 0;

    const trackingHints =
        /(\bexcomponenttype\b|\bsignature\b|&data=|reserved=0|safelinks|originalsrc|target="_blank")/i.test(l);

    if (l.length > 180 && (pctCount >= 6 || trackingHints)) return true;
    if (pctCount >= 10) return true;
    return false;
}

function cleanEmailNoise(text) {
    let s = String(text || '');

    // Remove common leftover HTML attribute fragments
    s = s.replace(/\boriginalsrc\s*=\s*["'][^"']*["']/gi, '');
    s = s.replace(/\btarget\s*=\s*["'][^"']*["']/gi, '');
    s = s.replace(/\brel\s*=\s*["'][^"']*["']/gi, '');
    s = s.replace(/"\s*>\s*/g, ' ');
    s = s.replace(/<"\s*>\s*/g, ' ');
    s = s.replace(/[ \t]+\n/g, '\n');

    let lines = s.split('\n').map(l => l.replace(/\s+$/g, ''));

    // Cut off quoted threads / disclaimers / signature blocks
    const CUT_FROM_LINE_PATTERNS = [
        /^\*\*\s*(van|from)\s*:\s*\*\*/i,
        /^\s*(van|from)\s*:/i,
        /^\*\*\s*(verzonden|sent)\s*:\s*\*\*/i,
        /^\*\*\s*(aan|to)\s*:\s*\*\*/i,
        /^\*\*\s*onderwerp\s*:\s*\*\*/i,
        /^-----\s*original message\s*-----/i,
        /^-----\s*oorspronkelijk bericht\s*-----/i,
        /^on .* wrote\s*:/i,
        /^op .* schreef.*:/i,
        /^de informatie in deze e-?mail kan vertrouwelijk zijn/i,
        /^this (e-?mail|message) (and any attachments )?may contain confidential/i,
        /^\s*disclaimer\b/i,
        /^\s*met vriendelijke groet\s*,?\s*$/i,
        /^\s*vriendelijke groet\s*,?\s*$/i,
        /^\s*kind regards\s*,?\s*$/i,
        /^\s*best regards\s*,?\s*$/i,
        /^\s*regards\s*,?\s*$/i,
        /^\s*mijn werkdagen zijn\s*:/i,
        /^\s*my working days are\s*:/i,
        /^\s*cordialement\s*,?\s*$/i,
        /^\s*mit freundlichen grüßen\s*,?\s*$/i,
    ];

    let cutIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] || '').trim();
        if (!line) continue;
        if (CUT_FROM_LINE_PATTERNS.some(re => re.test(line))) {
            cutIndex = i;
            break;
        }
    }
    if (cutIndex >= 0) lines = lines.slice(0, cutIndex);

    // Drop noisy lines
    const DROP_LINE_PATTERNS = [
        /^\s*\.{3,}\s*$/i,
        /^\s*-{3,}\s*$/i,
        /^\s*_{3,}\s*$/i,
        /^\s*is onderdeel van\s*$/i,
        /^\s*algemene voorwaarden\s*\|\s*$/i,
        /^\s*privacybeleid\s*$/i,
        /^\s*www\.\S+\s*$/i,
        /^\s*\d{2,4}\s*[--]\s*\d{2,4}\s*\d{2,4}\s*$/i,
    ];

    const cleaned = [];
    for (const rawLine of lines) {
        const line = (rawLine || '').trim();
        if (!line) { cleaned.push(''); continue; }
        if (DROP_LINE_PATTERNS.some(re => re.test(line))) continue;
        if (looksLikePercentEncodedJunk(line)) continue;
        cleaned.push(line);
    }

    let out = cleaned.join('\n');
    out = out.replace(/[ \t]+\n/g, '\n')
             .replace(/\n{3,}/g, '\n\n')
             .trim();

    return out;
}

/**
 * Stage 1: Full email cleanup pipeline.
 * HTML → Text → Remove URLs → Clean noise
 */
function cleanEmail(rawContent) {
    let text = stripHtmlToText(rawContent);
    text = removeUrls(text);
    text = cleanEmailNoise(text);
    return text;
}

// ──────────────────────────────────────────────
// Stage 2: PII Redaction
// ──────────────────────────────────────────────

const PII_PATTERNS = [
    { key: 'email', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL]' },
    { key: 'phone', regex: /(?:\+\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{2,4}/g, replacement: '[PHONE]' },
    { key: 'ip', regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: '[IP]' },
    { key: 'asset', regex: /\b[A-Z]{2,4}-\d{6,10}\b/g, replacement: '[ASSET]' },
];

// Dutch BSN 11-proof (elfproef).
// BSN is 9 digits; 9*d1 + 8*d2 + ... + 2*d8 - 1*d9 must be divisible by 11
// and the result must also be non-zero. This catches most false positives
// (order numbers, tracking codes) that happen to be 9 digits.
function isValidBsn(digits) {
    if (!/^\d{9}$/.test(digits)) return false;
    const weights = [9, 8, 7, 6, 5, 4, 3, 2, -1];
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += weights[i] * parseInt(digits[i], 10);
    return sum !== 0 && sum % 11 === 0;
}

// MAC match should be preceded (within 40 chars) by a word like MAC/hwaddr/ether
// — otherwise it's almost certainly an asset ID, which we already redact via [ASSET].
const MAC_ANCHOR_RE = /(?:mac|hwaddr|ether|bssid)[\s:=]{0,10}$/i;
const MAC_RE = /\b([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g;
const BSN_CANDIDATE_RE = /\b\d{9}\b/g;

function replaceWithContext(text, regex, replacement, accept) {
    let s = '';
    let lastIndex = 0;
    let count = 0;
    let m;
    regex.lastIndex = 0;
    while ((m = regex.exec(text)) !== null) {
        const before = text.slice(Math.max(0, m.index - 40), m.index);
        if (accept(m[0], before)) {
            s += text.slice(lastIndex, m.index) + replacement;
            lastIndex = m.index + m[0].length;
            count++;
        }
    }
    s += text.slice(lastIndex);
    return { text: s, count };
}

/**
 * Redact PII and return { text, counts } where counts is keyed by PII class.
 * The `disable` array can suppress specific classes: e.g. ['mac','bsn'].
 */
function redactPIIWithCounts(text, { disable = [] } = {}) {
    const disabled = new Set((disable || []).map(s => String(s).toLowerCase()));
    let s = String(text || '');
    const counts = { email: 0, phone: 0, ip: 0, asset: 0, bsn: 0, mac: 0 };

    for (const { key, regex, replacement } of PII_PATTERNS) {
        if (disabled.has(key)) continue;
        regex.lastIndex = 0;
        s = s.replace(regex, () => { counts[key]++; return replacement; });
    }

    if (!disabled.has('bsn')) {
        const r = replaceWithContext(s, BSN_CANDIDATE_RE, '[ID]', (match) => isValidBsn(match));
        s = r.text;
        counts.bsn = r.count;
    }

    if (!disabled.has('mac')) {
        const r = replaceWithContext(s, MAC_RE, '[MAC]', (_m, before) => MAC_ANCHOR_RE.test(before));
        s = r.text;
        counts.mac = r.count;
    }

    return { text: s, counts };
}

function redactPII(text, opts) {
    return redactPIIWithCounts(text, opts).text;
}

// ──────────────────────────────────────────────
// Stage 3: AI Summarization
// Adapted from n8n "AI: Rewrite to Article" + "AI: Select Category"
// ──────────────────────────────────────────────

/**
 * Default system prompt for article generation.
 * Adapted from the n8n workflow (originally in Dutch, now auto-detects language).
 */
const DEFAULT_ARTICLE_PROMPT = `You receive a support conversation — an email thread OR an ITSM ticket (with Description, Comments, and optionally a Resolution section). Rewrite it into a comprehensive, clear knowledge base article in **Markdown**, without duplicate or overlapping content and without contact information in the output.

ITIL handling (hard):
* If the input contains a "## Resolution" section (ticket with a known fix), the output MUST include an explicit "## Resolution" section with the actionable fix the helpdesk applied, AND a "## Root Cause" section if the cause is inferable from the source.
* If no Resolution section is present, omit Resolution; include Root Cause only when clearly inferable — never speculate.

Output rules (hard):
* Return only the rewritten Markdown.
* Use only \`##\` headers (no #, ###, bullets as headers).
* Do not add sections that are not relevant; if something does not apply: omit the entire section.
* Do not invent facts not present in the source. You may add general, safe clarification (e.g. "Check if the error still occurs") as long as it does not speculate about causes or systems.

Anti-duplication / anti-overlap (hard):
* Each instruction appears exactly once in the entire document.
* Place information in exactly one location:
  * Actions to be performed → under "Steps…"
  * Result/agreement after resolution → under "Solution"
  * Background/extra context → under "Notes"
  * Root cause → under "Root Cause"
* If the same message would end up in multiple sections: choose the most logical section and remove the other.
* Do not repeat sentences across sections; rephrase and refer implicitly.

IMPORTANT LANGUAGE RULE (hard):
* Never use persons or references to persons.
* Avoid words like: user, employee, person, customer, requester, reporter, colleague, secretary.
* Avoid pronouns referring to persons: he, she, him, her, their, someone.
* Write completely impersonally: describe actions without an actor ("Check…", "Request…", "Adjust…") or name only process entities ("Helpdesk", "IT management") without personal references.

Privacy & security (hard):
* Never include sensitive data or contact information. This includes at minimum:
  * Personal data and contact information: names, email addresses, phone numbers, addresses, usernames, customer/relation numbers.
  * Technical identifiers: IP addresses, MAC addresses, serial numbers, asset tags, tokens, session IDs.
  * Security information: passwords, PIN codes, MFA/2FA codes, recovery codes, API keys, client secrets, certificates, private keys, access/refresh tokens, login credentials (in any form).
* If such information appears: generalize or omit.

Writing style:
* Clear, concrete and task-oriented.
* Add sub-steps within numbered lists where useful (e.g. 1.1, 1.2) but avoid repetition.
* Add check/verification steps within existing sections (no new header) if it helps validate the issue is resolved.
* Use consistent terminology (same name for the same component).

Fixed structure (only include what exists in the input or is logically needed without speculation):

## {Subject (concise, improved)}

## Problem

## Solution

## Steps for end user

## Steps by IT administration

## Root Cause

## Resolution

## Notes

Task:
* Take the input one-to-one as source.
* Rewrite more extensively and better structured.
* Remove duplicates and overlap.
* Deliver only the final Markdown output.

IMPORTANT: Detect the language of the conversation/ticket and write the article in that SAME language.`;

const DEFAULT_CATEGORY_PROMPT = `The only thing you return is one ticket category (exactly one line), without any other detail.

Goal: Choose the best-fitting category for the ticket based on the root cause.

Method:
1) Determine the root cause from "Problem" and "Steps by IT administration" (this weighs heavier than "Solution").
2) Return one short category describing the domain of the root cause.

Rules (hard):
- Output = exactly one category string. No explanation, no JSON, no quotes.
- Category is singular: 1 concept, 1-3 words, Title Case.
- Never composite/comparative categories: no "/", "&", "+", "and", commas, brackets.
- Do not use full sentences or solutions ("Rights adjusted…" is wrong). Only the domain.

Preferred labels (soft guideline, pick what fits):
- Rights/roles/access/permissions → "Toegang" or "Autorisatie"
- Login/MFA/password → "Account"
- Email/spam/delivery → "E-mail"
- Network/VPN/WiFi → "Netwerk"
- Hardware/laptop/monitor → "Hardware"
- Printer/scanning → "Printer"
- Phone → "Telefonie"
- Teams/Webex/meetings → "Vergaderen"
- Performance/bug/error in app without permission issue → "Applicatie"
- Desktop/Windows/updates → "Werkplek"
- Other → use a fitting 1-2 word category

Tie-breaker:
If multiple domains are involved, choose the domain that was actually modified to resolve the issue.

Detect the language from the article and write the category in that same language.`;

// ── Shared: resolve model for a tier ──

async function resolveModel(tierName, orgId) {
    const { resolveModelForTierName } = require('./modelResolver');
    try {
        return await resolveModelForTierName(tierName, { userOrgId: orgId, fallback: 'gpt-4.1-mini' });
    } catch (resolveErr) {
        console.warn(`[TicketAssistantProcessor] Model resolution failed for tier "${tierName}", using fallback:`, resolveErr.message);
        return 'gpt-4.1-mini';
    }
}

// Per-stage default tiers (overridable by explicit caller argument).
// Config key migrated from 'email_kb_tier_config' → 'ticket_assistant_tier_config';
// first read migrates the legacy key in-place if present.
async function getTicketAssistantTierConfig() {
    const configStore = require('../stores/configStore');
    let cfg = await configStore.getConfig('ticket_assistant_tier_config');
    if (!cfg) {
        const legacy = await configStore.getConfig('email_kb_tier_config');
        if (legacy) {
            await configStore.setConfig('ticket_assistant_tier_config', legacy);
            try { await configStore.deleteConfig?.('email_kb_tier_config'); } catch (_) { /* ignore */ }
            cfg = legacy;
        }
    }
    cfg = cfg || {};
    return {
        article: typeof cfg.article === 'string' && cfg.article ? cfg.article : 'fast',
        category: typeof cfg.category === 'string' && cfg.category ? cfg.category : 'fast',
        merge: typeof cfg.merge === 'string' && cfg.merge ? cfg.merge : 'fast',
    };
}
// Legacy alias — retained for one release so older call sites keep working.
const getEmailKBTierConfig = getTicketAssistantTierConfig;

function appendLanguageInstruction(prompt, language) {
    if (!language) return prompt;
    return `${prompt}\n\nIMPORTANT: Write the output in ${language}. Do NOT auto-detect — use ${language} regardless of the input language.`;
}

/**
 * Generate a KB article from cleaned email text.
 *
 * @param {string} cleanedText — email text after HTML cleanup + PII redaction
 * @param {object} options
 * @param {string} [options.customPrompt] — override system prompt
 * @param {string} [options.orgId] — organization ID for model resolution
 * @param {string} [options.modelTier='fast'] — model tier to use
 * @param {string} [options.language] — force output language ('' = auto-detect)
 * @returns {Promise<{article: string|null, reason?: string}>}
 */
async function summarizeToArticle(cleanedText, options = {}) {
    const { customPrompt, orgId, modelTier = 'fast', language } = options;

    if (!cleanedText || cleanedText.trim().length < 20) {
        return { article: null, reason: 'Content too short' };
    }

    try {
        const modelId = await resolveModel(modelTier, orgId);
        console.log(`[TicketAssistantProcessor] Article stage: model=${modelId} tier=${modelTier}`);

        const { createChatCompletion } = require('../agents/providerAdapters');

        const prompt = appendLanguageInstruction(customPrompt || DEFAULT_ARTICLE_PROMPT, language);

        const articleResult = await createChatCompletion({
            model: modelId,
            messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: cleanedText }
            ],
            temperature: 0.3,
            max_tokens: 2000,
        });

        const article = articleResult?.choices?.[0]?.message?.content || '';

        if (!article || article.trim().length < 20) {
            return { article: null, reason: 'AI produced empty article' };
        }

        return { article: article.trim() };

    } catch (err) {
        console.error('[TicketAssistantProcessor] AI summarization failed:', err.message);
        return { article: null, reason: `AI error: ${err.message}` };
    }
}

/**
 * Categorize an article based on its content.
 *
 * @param {string} articleText — the generated KB article
 * @param {object} options
 * @param {string} [options.customPrompt] — override category prompt
 * @param {string} [options.orgId] — organization ID for model resolution
 * @param {string} [options.modelTier='fast'] — model tier to use
 * @param {string} [options.language] — force output language
 * @returns {Promise<string>} category name
 */
async function categorizeArticle(articleText, options = {}) {
    const { customPrompt, orgId, modelTier = 'fast', language } = options;

    try {
        const modelId = await resolveModel(modelTier, orgId);
        console.log(`[TicketAssistantProcessor] Category stage: model=${modelId} tier=${modelTier}`);

        const { createChatCompletion } = require('../agents/providerAdapters');

        const prompt = appendLanguageInstruction(customPrompt || DEFAULT_CATEGORY_PROMPT, language);

        const catResult = await createChatCompletion({
            model: modelId,
            messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: articleText }
            ],
            temperature: 0.1,
            max_tokens: 50,
        });
        const rawCat = (catResult?.choices?.[0]?.message?.content || '').trim();
        if (rawCat && rawCat.length < 50) {
            return rawCat;
        }
    } catch (catErr) {
        console.warn('[TicketAssistantProcessor] Category classification failed:', catErr.message);
    }

    return 'Uncategorized';
}

/**
 * Extract the first balanced JSON object/array from a string. Handles models
 * that wrap their JSON in ```json fences or add prefix/suffix prose.
 * Returns null if nothing parseable is found.
 */
function extractJson(text) {
    if (!text) return null;
    // Strip code fences
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenceMatch ? fenceMatch[1] : text;
    // Find the first balanced {...} or [...] block
    const startIdx = candidate.search(/[{[]/);
    if (startIdx === -1) return null;
    const open = candidate[startIdx];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = startIdx; i < candidate.length; i++) {
        const ch = candidate[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === open) depth++;
        else if (ch === close) {
            depth--;
            if (depth === 0) {
                const slice = candidate.slice(startIdx, i + 1);
                try { return JSON.parse(slice); } catch { return null; }
            }
        }
    }
    return null;
}

/**
 * Fused Stage 2 + Stage 3: generate the KB article AND its category label
 * in a single LLM round-trip. Halves the AI latency per email compared to
 * calling summarizeToArticle followed by categorizeArticle sequentially.
 *
 * Returns {article, category, reason?} matching the shape of the two
 * separate functions combined. Falls back gracefully: if the model refuses
 * to return valid JSON, caller can retry with separate calls.
 */
async function summarizeAndCategorize(cleanedText, options = {}) {
    const { articlePrompt, categoryPrompt, orgId, modelTier = 'fast', language } = options;

    if (!cleanedText || cleanedText.trim().length < 20) {
        return { article: null, category: null, reason: 'Content too short' };
    }

    try {
        const modelId = await resolveModel(modelTier, orgId);
        console.log(`[TicketAssistantProcessor] Fused article+category: model=${modelId} tier=${modelTier}`);

        const { createChatCompletion } = require('../agents/providerAdapters');

        const artSys = appendLanguageInstruction(articlePrompt || DEFAULT_ARTICLE_PROMPT, language);
        const catSys = appendLanguageInstruction(categoryPrompt || DEFAULT_CATEGORY_PROMPT, language);

        const fusedSystem =
            `You perform TWO tasks in one pass and return a single JSON object.\n\n` +
            `=== TASK 1 — ARTICLE ===\n${artSys}\n\n` +
            `=== TASK 2 — CATEGORY ===\n${catSys}\n\n` +
            `=== OUTPUT FORMAT (STRICT) ===\n` +
            `Return EXACTLY this JSON — no prose, no code fences, no comments:\n` +
            `{"article": "<TASK 1 markdown output as a single JSON string, escape newlines as \\n>", "category": "<TASK 2 single label, no quotes>"}\n`;

        const result = await createChatCompletion({
            model: modelId,
            messages: [
                { role: 'system', content: fusedSystem },
                { role: 'user', content: cleanedText },
            ],
            temperature: 0.3,
            max_tokens: 2100,
        });

        const raw = result?.choices?.[0]?.message?.content || '';
        const parsed = extractJson(raw);

        if (!parsed || typeof parsed.article !== 'string' || typeof parsed.category !== 'string') {
            return { article: null, category: null, reason: 'AI did not return parseable JSON' };
        }

        const article = parsed.article.trim();
        if (!article || article.length < 20) {
            return { article: null, category: null, reason: 'AI produced empty article' };
        }

        return {
            article,
            category: parsed.category.trim().slice(0, 80) || 'Uncategorized',
        };
    } catch (err) {
        console.error('[TicketAssistantProcessor] Fused article+category failed:', err.message);
        return { article: null, category: null, reason: `AI error: ${err.message}` };
    }
}

/**
 * Batched fused call: N emails in one LLM request, returning an array of
 * {article, category} entries in the same order as input. Opt-in via
 * `pipeline_config.article.batch_size` (default 1 = don't batch).
 *
 * Trade-off: ~2× additional speed-up over single-email fused calls, but the
 * model's attention is split across all N emails so very-long emails in the
 * batch can steal quality from shorter ones. Keep batch_size ≤ 5 in practice.
 *
 * Callers must handle the failure case (null entry / mismatched length)
 * by falling back to summarizeAndCategorize on each item individually.
 */
async function summarizeAndCategorizeBatch(emails, options = {}) {
    const { articlePrompt, categoryPrompt, orgId, modelTier = 'fast', language } = options;

    if (!Array.isArray(emails) || emails.length === 0) return [];
    if (emails.length === 1) {
        const r = await summarizeAndCategorize(emails[0], options);
        return [r];
    }

    try {
        const modelId = await resolveModel(modelTier, orgId);
        console.log(`[TicketAssistantProcessor] Batched article+category: model=${modelId}, batch=${emails.length}`);

        const { createChatCompletion } = require('../agents/providerAdapters');

        const artSys = appendLanguageInstruction(articlePrompt || DEFAULT_ARTICLE_PROMPT, language);
        const catSys = appendLanguageInstruction(categoryPrompt || DEFAULT_CATEGORY_PROMPT, language);

        const fusedSystem =
            `You will receive ${emails.length} emails separated by <<<EMAIL k>>> markers.\n` +
            `For EACH email, perform two tasks:\n\n` +
            `=== TASK 1 — ARTICLE ===\n${artSys}\n\n` +
            `=== TASK 2 — CATEGORY ===\n${catSys}\n\n` +
            `=== OUTPUT FORMAT (STRICT) ===\n` +
            `Return a single JSON array of length ${emails.length}, order matching input exactly. No prose, no code fences.\n` +
            `[{"article": "<markdown>", "category": "<label>"}, ...]\n`;

        const userContent = emails
            .map((body, i) => `<<<EMAIL ${i + 1}>>>\n${body}`)
            .join('\n\n');

        const result = await createChatCompletion({
            model: modelId,
            messages: [
                { role: 'system', content: fusedSystem },
                { role: 'user', content: userContent },
            ],
            temperature: 0.3,
            max_tokens: 2100 * emails.length,
        });

        const raw = result?.choices?.[0]?.message?.content || '';
        const parsed = extractJson(raw);

        if (!Array.isArray(parsed) || parsed.length !== emails.length) {
            // Tell caller to retry per-email
            return emails.map(() => ({ article: null, category: null, reason: 'Batch output malformed — falling back' }));
        }

        return parsed.map((entry) => {
            if (!entry || typeof entry.article !== 'string' || typeof entry.category !== 'string') {
                return { article: null, category: null, reason: 'Batch entry malformed' };
            }
            const article = entry.article.trim();
            if (!article || article.length < 20) {
                return { article: null, category: null, reason: 'AI produced empty article' };
            }
            return { article, category: entry.category.trim().slice(0, 80) || 'Uncategorized' };
        });
    } catch (err) {
        console.error('[TicketAssistantProcessor] Batched article+category failed:', err.message);
        return emails.map(() => ({ article: null, category: null, reason: `AI error: ${err.message}` }));
    }
}

/**
 * Everything `processEmail` does BEFORE the LLM call, extracted so batch mode
 * can run Stage 1 (clean/redact/header) across N emails synchronously and
 * then make a single batched LLM call.
 *
 * Returns { aiInput, subject, date, messageId } on success
 * or { skip: true, reason } on blacklist/empty content.
 */
function prepareEmailForLLM(rawContent, metadata = {}, options = {}) {
    const { subject, from, date, messageId } = metadata;
    const { senderBlacklist = [], redactPII: shouldRedact = true } = options;

    if (from && senderBlacklist.length > 0) {
        const senderEmail = (from.match(/<([^>]+)>/) || [, from])[1].toLowerCase();
        if (senderBlacklist.some(b => senderEmail.includes(b.toLowerCase()))) {
            return { skip: true, reason: 'Sender blacklisted' };
        }
    }

    const cleaned = cleanEmail(rawContent);
    if (!cleaned || cleaned.trim().length < 20) {
        return { skip: true, reason: 'No meaningful content after cleanup' };
    }

    const redacted = shouldRedact ? redactPII(cleaned) : cleaned;

    let aiInput = redacted;
    if (subject || date) {
        const header = [subject && `Subject: ${subject}`, date && `Date: ${date}`].filter(Boolean).join('\n');
        aiInput = `${header}\n---\n${redacted}`;
    }

    return { aiInput, subject, date, messageId };
}

/**
 * Build the final processed-email result after the LLM call(s). Shared between
 * the single-email and batched paths.
 */
function assembleProcessedEmail({ article, category, subject, date, messageId }) {
    if (!article) return { success: false, reason: 'AI produced empty article', skipped: true };
    const cat = category || 'Uncategorized';
    const cleanSubject = subject ? subject.replace(/^(re|fw|fwd):\s*/gi, '').trim() : '';
    const title = cleanSubject
        ? `${cat}: ${cleanSubject}`
        : `${cat}: ${article.split('\n')[0].replace(/^#+\s*/, '').substring(0, 80)}`;

    return {
        success: true,
        article,
        category: cat,
        title,
        sourceDate: date,
        sourceMessageId: messageId,
    };
}

// ──────────────────────────────────────────────
// Full Pipeline
// ──────────────────────────────────────────────

/**
 * Process a single email (or grouped thread) through the full pipeline.
 *
 * @param {string} rawContent — raw email HTML or text content
 * @param {object} metadata — { subject, from, date, messageId }
 * @param {object} options
 * @param {string} [options.orgId] — organization ID
 * @param {string[]} [options.senderBlacklist] — emails/domains to skip
 * @param {boolean} [options.redactPII=true] — enable PII redaction
 * @param {string} [options.language] — force output language
 * @param {string} [options.articleModelTier='fast'] — tier for article generation
 * @param {string} [options.articlePrompt] — override article system prompt
 * @param {string} [options.categoryModelTier='fast'] — tier for categorization
 * @param {string} [options.categoryPrompt] — override category system prompt
 * @returns {Promise<{success: boolean, article?: string, category?: string, title?: string, reason?: string}>}
 */
async function processEmail(rawContent, metadata = {}, options = {}) {
    const { subject, from, date, messageId } = metadata;
    const {
        senderBlacklist = [], redactPII: shouldRedact = true, language,
        articleModelTier: articleModelTierOpt, articlePrompt,
        categoryModelTier: categoryModelTierOpt, categoryPrompt,
        orgId,
    } = options;

    // Fall back to the configured per-stage tier when the caller didn't override
    const ekbTiers = await getEmailKBTierConfig();
    const articleModelTier = articleModelTierOpt || ekbTiers.article;
    const categoryModelTier = categoryModelTierOpt || ekbTiers.category;

    // Check sender blacklist
    if (from && senderBlacklist.length > 0) {
        const senderEmail = (from.match(/<([^>]+)>/) || [, from])[1].toLowerCase();
        if (senderBlacklist.some(b => senderEmail.includes(b.toLowerCase()))) {
            return { success: false, reason: 'Sender blacklisted', skipped: true };
        }
    }

    // Stage 1: Clean
    const cleaned = cleanEmail(rawContent);
    if (!cleaned || cleaned.trim().length < 20) {
        return { success: false, reason: 'No meaningful content after cleanup', skipped: true };
    }

    // PII redaction — single pre-AI pass. The old pipeline redacted twice
    // (before AND after AI); the post-AI pass catches only model hallucinations
    // and its cost isn't worth the wall-time. Redact once, trust the model.
    const redacted = shouldRedact ? redactPII(cleaned) : cleaned;

    // Prepend metadata for AI context
    let aiInput = redacted;
    if (subject || date) {
        const header = [subject && `Subject: ${subject}`, date && `Date: ${date}`].filter(Boolean).join('\n');
        aiInput = `${header}\n---\n${redacted}`;
    }

    // Stage 2 + 3: AI article generation AND categorization.
    // Fast path (shared model tier → one LLM call returning JSON).
    // Fallback path (different tiers) still does two calls in sequence.
    let article, category, reason;
    if (articleModelTier === categoryModelTier) {
        const fused = await summarizeAndCategorize(aiInput, {
            orgId, language,
            modelTier: articleModelTier,
            articlePrompt,
            categoryPrompt,
        });
        article = fused.article;
        category = fused.category;
        reason = fused.reason;

        // If fused call failed to produce parseable JSON, retry with the old
        // two-call path rather than dropping the email.
        if (!article) {
            const retry = await summarizeToArticle(aiInput, {
                orgId, language,
                modelTier: articleModelTier,
                customPrompt: articlePrompt,
            });
            article = retry.article;
            reason = retry.reason;
            if (article) {
                category = await categorizeArticle(article, {
                    orgId, language,
                    modelTier: categoryModelTier,
                    customPrompt: categoryPrompt,
                });
            }
        }
    } else {
        const r = await summarizeToArticle(aiInput, {
            orgId, language,
            modelTier: articleModelTier,
            customPrompt: articlePrompt,
        });
        article = r.article;
        reason = r.reason;
        if (article) {
            category = await categorizeArticle(article, {
                orgId, language,
                modelTier: categoryModelTier,
                customPrompt: categoryPrompt,
            });
        }
    }

    if (!article) {
        return { success: false, reason: reason || 'AI summarization failed', skipped: true };
    }
    if (!category) category = 'Uncategorized';

    // Build title
    const cleanSubject = subject ? subject.replace(/^(re|fw|fwd):\s*/gi, '').trim() : '';
    const title = cleanSubject
        ? `${category}: ${cleanSubject}`
        : `${category}: ${article.split('\n')[0].replace(/^#+\s*/, '').substring(0, 80)}`;

    return {
        success: true,
        article,
        category,
        title,
        sourceDate: date,
        sourceMessageId: messageId,
    };
}

/**
 * Process multiple email messages from a thread and merge them into one article.
 */
async function processEmailThread(messages, metadata = {}, options = {}) {
    const { subject, from, date } = metadata;
    const {
        senderBlacklist = [], redactPII: shouldRedact = true, language,
        articleModelTier: articleModelTierOpt, articlePrompt,
        categoryModelTier: categoryModelTierOpt, categoryPrompt,
        orgId,
    } = options;

    const ekbTiers = await getEmailKBTierConfig();
    const articleModelTier = articleModelTierOpt || ekbTiers.article;
    const categoryModelTier = categoryModelTierOpt || ekbTiers.category;

    // Check sender blacklist on the thread starter
    if (from && senderBlacklist.length > 0) {
        const senderEmail = (from.match(/<([^>]+)>/) || [, from])[1].toLowerCase();
        if (senderBlacklist.some(b => senderEmail.includes(b.toLowerCase()))) {
            return { success: false, reason: 'Sender blacklisted', skipped: true };
        }
    }

    // System message patterns to filter out (matches n8n "Filter: System Msgs")
    const SYSTEM_MSG_PATTERNS = [
        /^status gewijzigd naar/i,
        /^status changed to/i,
        /^ticket (gesloten|closed|reopened|heropend)/i,
        /^automatisch bericht/i,
        /^auto[- ]?reply/i,
    ];

    // Clean all messages, filter system messages and empties, sort chronologically
    const sortedMessages = [...messages].sort((a, b) =>
        new Date(a.date || 0) - new Date(b.date || 0)
    );

    const cleanedMessages = sortedMessages
        .map(msg => {
            const text = cleanEmail(msg.body || msg.content || '');
            if (!text || text.length < 10) return null;
            if (SYSTEM_MSG_PATTERNS.some(re => re.test(text.trim()))) return null;
            return { text: shouldRedact ? redactPII(text) : text, date: msg.date };
        })
        .filter(Boolean);

    if (cleanedMessages.length === 0) {
        return { success: false, reason: 'No meaningful messages in thread', skipped: true };
    }

    // Merge into single conversation text with date headers for context
    let merged = '';
    if (subject || date) {
        const header = [subject && `Subject: ${subject}`, date && `Date: ${date}`].filter(Boolean).join('\n');
        merged = `${header}\n---\n\n`;
    }
    merged += cleanedMessages.map((msg, i) => {
        const dateLabel = msg.date ? `[${new Date(msg.date).toLocaleString()}]` : `[Message ${i + 1}]`;
        return `${dateLabel}\n${msg.text}`;
    }).join('\n\n---\n\n');

    // AI Summarize the entire thread
    const { article, reason } = await summarizeToArticle(merged, {
        orgId, language,
        modelTier: articleModelTier,
        customPrompt: articlePrompt,
    });
    if (!article) {
        return { success: false, reason: reason || 'AI summarization failed', skipped: true };
    }

    // AI Categorization (separate tier + prompt)
    const category = await categorizeArticle(article, {
        orgId, language,
        modelTier: categoryModelTier,
        customPrompt: categoryPrompt,
    });

    // Post-AI PII pass — optional
    const sanitizedArticle = shouldRedact ? redactPII(article) : article;

    const cleanSubject = subject ? subject.replace(/^(re|fw|fwd):\s*/gi, '').trim() : '';
    const title = cleanSubject
        ? `${category}: ${cleanSubject}`
        : `${category}: ${sanitizedArticle.split('\n')[0].replace(/^#+\s*/, '').substring(0, 80)}`;

    return {
        success: true,
        article: sanitizedArticle,
        category,
        title,
        sourceDate: date,
        messageCount: cleanedMessages.length,
    };
}

// ──────────────────────────────────────────────
// Stage 5: Category Aggregation
// Adapted from n8n workflow 2.1 "Get Ticket summary Files"
// ──────────────────────────────────────────────

// ── Chunked-merge constants (match n8n reference workflow) ────────
//
// Large categories must be chunked before being fed to the LLM,
// otherwise the single-call merge overflows the model's context
// window silently. Values mirror the n8n "Email-support-V1" workflow.
const CHUNK_MAX_TOKENS = 40000;   // per-chunk token budget
const CHARS_PER_TOKEN = 3.5;      // heuristic — no tokeniser dependency
const CHUNK_PARALLELISM = 3;      // max chunk-write LLM calls in flight

const DEFAULT_DEDUPE_PROMPT = `You receive a merged knowledge-base article assembled from multiple separately-processed chunks about the same subject. There may be duplicates and overlap between the chunks.

Task:
Combine the parts into ONE coherent knowledge-base article in **Markdown**. Remove duplicates and overlap across chunks.

Source-bound (hard):
* Use ONLY information that appears in the input. Do not invent steps, causes, solutions or context.
* Do not add "general clarification" or best practices.
* If something is missing → leave it out.

Rules (hard):
* Deduplication: when the same instruction appears in multiple chunks, keep the most complete version and remove the rest.
* One place per fact. Every instruction appears exactly once.
* Conflicts: prefer the most specific version. Only combine when the versions are complementary.
* Self-contained sections: each \`##\` block must be understandable on its own — repeat the subject in the heading and the opening sentence.
* Descriptive headings: subject + action (e.g. "## Steps to restore VPN connection").
* Section length: 150–500 words. Combine sections that are too short, split ones that are too long.
* Keywords in the first two sentences of each section.
* No references like "see above" or "as mentioned earlier".
* Privacy: never include names, emails, phones, addresses, customer/order numbers, IPs, serial numbers, tokens, passwords or credentials.
* Only use \`##\` headers (no \`#\`, no \`###\`).
* Output ONLY the rewritten Markdown — no explanation, no code fences, no preamble.

IMPORTANT: Detect the language of the input chunks and write the output in the SAME language.`;

const DEFAULT_MERGE_PROMPT = `You receive multiple existing knowledge base articles from the same category. Rewrite them into ONE comprehensive, deduplicated knowledge base article in **Markdown**.

Output rules (hard):
* Return only the rewritten Markdown.
* Use only \`##\` headers (no #, ###).
* Do not add sections that are not relevant; if something does not apply: omit the entire section.
* Do not invent facts that are not in the source articles. You may add general, safe clarification as long as it does not speculate.

Anti-duplication (hard):
* Each instruction or piece of knowledge appears exactly once in the entire document.
* If multiple source articles describe the same problem or solution: merge them into one entry, combining the most complete details.
* Remove redundant or overlapping content — keep the most informative version.
* Use consistent terminology throughout.

Writing style:
* Clear, concrete and task-oriented.
* Write completely impersonally (no person references).
* Add sub-steps within numbered lists where useful (e.g. 1.1, 1.2).
* Group related problems/solutions together logically.

Privacy & security (hard):
* Never include sensitive data or contact information (names, emails, phones, IPs, credentials, tokens, etc.).
* If such information appears: generalize or omit.

Structure (use only sections that are relevant):

## {Category Name} — Knowledge Base

## Overview
Brief summary of what this category covers.

## Common Problems & Solutions
For each distinct problem, use a ### sub-header:
### Problem description (concise)
**Problem:** ...
**Solution:** ...
**Steps:** ...

## Notes
Only if relevant.

IMPORTANT: Detect the language of the source articles and write in that SAME language.`;

/**
 * Greedy-pack article strings into token-bounded chunks. A chunk is the
 * `\n\n---\n\n`-joined text ready to be fed to the LLM. A single article
 * larger than the budget becomes its own chunk (not split further).
 *
 * @param {string[]} articleTexts — raw article bodies, in ingestion order
 * @returns {string[]} — one chunk text per element
 */
function chunkArticlesByTokenBudget(articleTexts) {
    const SEPARATOR = '\n\n---\n\n';
    const maxChars = Math.floor(CHUNK_MAX_TOKENS * CHARS_PER_TOKEN);
    const chunks = [];
    let current = [];
    let currentChars = 0;

    for (const text of articleTexts) {
        const tLen = (text || '').length;
        if (tLen === 0) continue;

        // Oversized single article → flush current, keep article solo.
        if (tLen > maxChars) {
            if (current.length > 0) {
                chunks.push(current.join(SEPARATOR));
                current = [];
                currentChars = 0;
            }
            chunks.push(text);
            continue;
        }

        const projected = currentChars + (current.length > 0 ? SEPARATOR.length : 0) + tLen;
        if (projected > maxChars && current.length > 0) {
            chunks.push(current.join(SEPARATOR));
            current = [];
            currentChars = 0;
        }
        current.push(text);
        currentChars += (current.length > 1 ? SEPARATOR.length : 0) + tLen;
    }

    if (current.length > 0) chunks.push(current.join(SEPARATOR));
    return chunks;
}

/**
 * Run the per-chunk rewrite LLM call. Same prompt semantics as the old
 * single-pass merge (DEFAULT_MERGE_PROMPT) — the intent is the same:
 * consolidate N articles about one subject into one coherent Markdown doc.
 */
async function rewriteChunk(chunkText, { orgId, modelTier, customPrompt, language } = {}) {
    return summarizeToArticle(chunkText, {
        orgId,
        modelTier,
        language,
        customPrompt: customPrompt || DEFAULT_MERGE_PROMPT,
    });
}

/**
 * Cross-chunk dedupe pass. Feeds all per-chunk outputs (separated by `---`)
 * into one more LLM call with DEFAULT_DEDUPE_PROMPT. Used only when a
 * category was split into >1 chunks.
 *
 * @param {string[]} chunkOutputs — non-null per-chunk rewritten markdown
 * @returns {Promise<{article: string|null, reason?: string}>}
 */
async function dedupeMergedChunks(chunkOutputs, { orgId, modelTier, customPrompt, language } = {}) {
    const joined = (chunkOutputs || []).filter(Boolean).join('\n\n---\n\n');
    if (!joined || joined.trim().length < 20) {
        return { article: null, reason: 'No chunk outputs to dedupe' };
    }
    // Use summarizeToArticle but with a bigger ceiling — the final merged doc
    // is legitimately longer than a per-email article.
    try {
        const modelId = await resolveModel(modelTier || 'fast', orgId);
        const { createChatCompletion } = require('../agents/providerAdapters');
        const prompt = appendLanguageInstruction(customPrompt || DEFAULT_DEDUPE_PROMPT, language);
        const resp = await createChatCompletion({
            model: modelId,
            messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: joined },
            ],
            temperature: 0.2,
            max_tokens: 4000,
        });
        const text = resp?.choices?.[0]?.message?.content || '';
        if (!text || text.trim().length < 20) {
            return { article: null, reason: 'AI produced empty dedupe output' };
        }
        return { article: text.trim() };
    } catch (err) {
        console.error('[TicketAssistantProcessor] Dedupe pass failed:', err.message);
        return { article: null, reason: `AI error: ${err.message}` };
    }
}

/**
 * Run `fn` over `items` with bounded parallelism. Preserves input order in the
 * returned array. Errors from `fn` are captured as `{ error: Error }` so one
 * failure doesn't reject the whole batch.
 */
async function mapWithConcurrency(items, concurrency, fn) {
    const out = new Array(items.length);
    let i = 0;
    const worker = async () => {
        while (true) {
            const idx = i++;
            if (idx >= items.length) return;
            try {
                out[idx] = await fn(items[idx], idx);
            } catch (err) {
                out[idx] = { error: err };
            }
        }
    };
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker());
    await Promise.all(workers);
    return out;
}

/**
 * Merge multiple processed articles by category into comprehensive KB documents.
 *
 * For each category:
 *   1. Chunk the articles by a fixed token budget (CHUNK_MAX_TOKENS).
 *   2. Rewrite each chunk in parallel via `rewriteChunk` (model tier =
 *      chunkWriteModelTier || modelTier; prompt = chunkWriteSystemPrompt ||
 *      customPrompt || DEFAULT_MERGE_PROMPT).
 *   3. If only 1 chunk → that's the final article, no dedupe pass.
 *      If ≥2 chunks → run `dedupeMergedChunks` (model tier =
 *      dedupeModelTier || modelTier; prompt = dedupeSystemPrompt ||
 *      DEFAULT_DEDUPE_PROMPT). If dedupe fails, fall back to the
 *      `---`-joined chunk outputs so the user still gets a doc.
 *
 * The optional `onProgress(event, data)` callback is invoked with:
 *   - 'merge_category_started'   { category, totalArticles, chunkCount }
 *   - 'merge_category_complete'  { category, chunkCount, finalChars, dedupeRan }
 *
 * @param {Array<{article: string, category: string, title?: string, sourceMessageId?: string}>} articles
 * @param {object} options
 * @param {string} [options.orgId]
 * @param {boolean} [options.redactPII=true]
 * @param {string} [options.modelTier]                — fallback tier for both passes
 * @param {string} [options.customPrompt]             — legacy alias for chunkWriteSystemPrompt
 * @param {string} [options.chunkWriteModelTier]      — override tier for per-chunk rewrite
 * @param {string} [options.chunkWriteSystemPrompt]   — override prompt for per-chunk rewrite
 * @param {string} [options.dedupeModelTier]          — override tier for the cross-chunk pass
 * @param {string} [options.dedupeSystemPrompt]       — override prompt for the cross-chunk pass
 * @param {string} [options.language]
 * @param {(event: string, data: object) => void} [options.onProgress]
 * @returns {Promise<Array<{category, article, title, sourceCount, chunkCount, dedupeRan}>>}
 */
async function mergeArticlesByCategory(articles, options = {}) {
    const {
        redactPII: shouldRedact = true,
        modelTier: modelTierOpt,
        customPrompt,
        chunkWriteModelTier,
        chunkWriteSystemPrompt,
        dedupeModelTier,
        dedupeSystemPrompt,
        language,
        orgId,
        onProgress,
    } = options;

    const ekbTiers = await getEmailKBTierConfig();
    const fallbackTier = modelTierOpt || ekbTiers.merge;
    const writeTier = chunkWriteModelTier || fallbackTier;
    const dedupeTier = dedupeModelTier || fallbackTier;
    const writePrompt = chunkWriteSystemPrompt || customPrompt || '';
    const dedupePrompt = dedupeSystemPrompt || '';

    // Group by category
    const groups = {};
    for (const a of articles) {
        const cat = a.category || 'Uncategorized';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(a.article);
    }

    const categoryNames = Object.keys(groups);
    console.log(`[TicketAssistantProcessor] Merging ${articles.length} articles into ${categoryNames.length} categories: ${categoryNames.join(', ')}`);

    const notify = (event, data) => {
        try { onProgress && onProgress(event, data); } catch { /* never break sync */ }
    };

    const results = [];
    for (const category of categoryNames) {
        const articleTexts = groups[category];
        const chunks = chunkArticlesByTokenBudget(articleTexts);
        console.log(`[TicketAssistantProcessor] "${category}": ${articleTexts.length} articles → ${chunks.length} chunks`);
        notify('merge_category_started', {
            category,
            totalArticles: articleTexts.length,
            chunkCount: chunks.length,
        });

        try {
            // Pass 1 — rewrite each chunk in parallel (bounded fan-out)
            const chunkResults = await mapWithConcurrency(chunks, CHUNK_PARALLELISM, (chunkText) =>
                rewriteChunk(chunkText, {
                    orgId,
                    modelTier: writeTier,
                    customPrompt: writePrompt,
                    language,
                })
            );
            const chunkOutputs = chunkResults
                .map((r) => {
                    if (r?.error) {
                        console.warn(`[TicketAssistantProcessor] Chunk rewrite errored in "${category}":`, r.error.message);
                        return null;
                    }
                    if (!r?.article) {
                        console.warn(`[TicketAssistantProcessor] Chunk rewrite empty in "${category}": ${r?.reason || 'unknown'}`);
                        return null;
                    }
                    return r.article;
                })
                .filter(Boolean);

            if (chunkOutputs.length === 0) {
                console.warn(`[TicketAssistantProcessor] All chunks failed for category "${category}"`);
                notify('merge_category_complete', { category, chunkCount: chunks.length, finalChars: 0, dedupeRan: false, ok: false });
                continue;
            }

            // Pass 2 — dedupe only if we had >1 chunks
            let finalArticle;
            let dedupeRan = false;
            if (chunkOutputs.length === 1) {
                finalArticle = chunkOutputs[0];
            } else {
                dedupeRan = true;
                const dedupe = await dedupeMergedChunks(chunkOutputs, {
                    orgId,
                    modelTier: dedupeTier,
                    customPrompt: dedupePrompt,
                    language,
                });
                if (dedupe.article) {
                    finalArticle = dedupe.article;
                } else {
                    console.warn(`[TicketAssistantProcessor] Dedupe pass failed for "${category}" (${dedupe.reason}) — falling back to chunk concat`);
                    finalArticle = chunkOutputs.join('\n\n---\n\n');
                }
            }

            const sanitized = shouldRedact ? redactPII(finalArticle) : finalArticle;
            results.push({
                category,
                article: sanitized,
                title: category,
                sourceCount: articleTexts.length,
                chunkCount: chunks.length,
                dedupeRan,
            });
            notify('merge_category_complete', {
                category,
                chunkCount: chunks.length,
                finalChars: sanitized.length,
                dedupeRan,
                ok: true,
            });
        } catch (err) {
            console.error(`[TicketAssistantProcessor] Merge failed for category "${category}":`, err.message);
            notify('merge_category_complete', { category, chunkCount: chunks.length, finalChars: 0, dedupeRan: false, ok: false, error: err.message });
        }
    }

    return results;
}

/**
 * Parse a "From" field into display name and email parts.
 * Accepts: `"Sven Hogervorst" <sven@example.com>`, `Sven Hogervorst <sven@example.com>`, or bare `sven@example.com`.
 */
function parseFromField(from) {
    if (!from) return { name: '', email: '' };
    const match = from.match(/^(.*?)\s*<([^>]+)>\s*$/);
    if (match) {
        return {
            name: match[1].replace(/^["']|["']$/g, '').trim(),
            email: match[2].trim(),
        };
    }
    return { name: '', email: from.trim() };
}

/**
 * Per-email KB ingestion — preserves retrieval signal.
 *
 * Unlike `processEmail`, this does NOT rewrite the body through an AI model.
 * Each email becomes its own KB document whose content starts with a rich
 * metadata block (From/To/Date/Subject/Message-Id/Thread-Id). The metadata
 * block lives inside `content`, so tsvector FTS matches on sender/subject
 * and the vector embeddings see the natural body text.
 *
 * Returns { success, article, title, sourceMessageId, sourceDate } on success.
 */
function buildPerEmailArticle(rawContent, metadata = {}, options = {}) {
    const { subject, from, to, cc, date, messageId, threadId, labels } = metadata;
    const {
        senderBlacklist = [],
        redactPII: shouldRedact = true,
        category,    // optional: caller may pre-compute
    } = options;

    // Blacklist — same check as processEmail
    if (from && senderBlacklist.length > 0) {
        const senderEmail = (from.match(/<([^>]+)>/) || [, from])[1].toLowerCase();
        if (senderBlacklist.some(b => senderEmail.includes(b.toLowerCase()))) {
            return { success: false, reason: 'Sender blacklisted', skipped: true };
        }
    }

    // Stage 1: Clean
    const cleaned = cleanEmail(rawContent);
    if (!cleaned || cleaned.trim().length < 20) {
        return { success: false, reason: 'No meaningful content after cleanup', skipped: true };
    }

    // Stage 2: PII redaction (optional)
    const body = shouldRedact ? redactPII(cleaned) : cleaned;

    // Stage 3: Metadata header
    const { name: fromName, email: fromEmail } = parseFromField(from);
    const headerLines = [
        from && `From: ${from}`,
        to && `To: ${to}`,
        cc && `Cc: ${cc}`,
        date && `Date: ${date}`,
        subject && `Subject: ${subject}`,
        messageId && `Message-Id: ${messageId}`,
        threadId && `Thread-Id: ${threadId}`,
        labels && (Array.isArray(labels) ? labels.join(', ') : labels) && `Labels: ${Array.isArray(labels) ? labels.join(', ') : labels}`,
        category && `Category: ${category}`,
    ].filter(Boolean);

    const article = `${headerLines.join('\n')}\n\n---\n\n${body}`;

    // Title — "{sender} — {subject without Re:/Fwd:}"
    const cleanSubject = subject ? subject.replace(/^(re|fw|fwd):\s*/gi, '').trim() : '';
    const displayName = fromName || fromEmail || '';
    const title = displayName && cleanSubject
        ? `${displayName} — ${cleanSubject}`
        : (cleanSubject || displayName || 'Email');

    return {
        success: true,
        article,
        title,
        category: category || null,
        sourceMessageId: messageId,
        sourceDate: date,
    };
}

module.exports = {
    // Individual stages (for testing)
    cleanEmail,
    redactPII,
    redactPIIWithCounts,
    isValidBsn,
    summarizeToArticle,
    categorizeArticle,
    summarizeAndCategorize,
    summarizeAndCategorizeBatch,
    parseFromField,
    // Split-step helpers (for batch pipelines)
    prepareEmailForLLM,
    assembleProcessedEmail,
    // Full pipelines
    processEmail,
    processEmailThread,
    mergeArticlesByCategory,
    dedupeMergedChunks,
    buildPerEmailArticle,
    // Tier configuration
    getTicketAssistantTierConfig,
    getEmailKBTierConfig, // legacy alias
    // Constants
    DEFAULT_ARTICLE_PROMPT,
    DEFAULT_CATEGORY_PROMPT,
    DEFAULT_MERGE_PROMPT,
    DEFAULT_DEDUPE_PROMPT,
};
