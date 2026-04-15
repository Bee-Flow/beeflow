/**
 * Email KB Processor — Three-stage email-to-KB-article pipeline
 *
 * Ported from n8n workflows:
 *   1.3 "Get Ticket Message"  → Stage 1 (HTML cleanup) + Stage 2 (PII redaction)
 *   1.1 "Ticketlist to Summary" → Stage 3 (AI summarization + categorization)
 *
 * Pipeline:
 *   Raw email HTML/text → cleanEmail() → redactPII() → summarizeToArticle()
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
    // Email addresses
    { regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL]' },
    // Phone numbers (international + NL/EU formats)
    { regex: /(?:\+\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{2,4}/g, replacement: '[PHONE]' },
    // IP addresses
    { regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: '[IP]' },
    // Dutch BSN-like (9 digits)
    { regex: /\b\d{9}\b/g, replacement: '[ID]' },
    // Asset tags / serial numbers (common patterns)
    { regex: /\b[A-Z]{2,4}-\d{6,10}\b/g, replacement: '[ASSET]' },
    // MAC addresses
    { regex: /\b([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, replacement: '[MAC]' },
];

function redactPII(text) {
    let s = String(text || '');
    for (const { regex, replacement } of PII_PATTERNS) {
        // Reset lastIndex for global regexes
        regex.lastIndex = 0;
        s = s.replace(regex, replacement);
    }
    return s;
}

// ──────────────────────────────────────────────
// Stage 3: AI Summarization
// Adapted from n8n "AI: Rewrite to Article" + "AI: Select Category"
// ──────────────────────────────────────────────

/**
 * Default system prompt for article generation.
 * Adapted from the n8n workflow (originally in Dutch, now auto-detects language).
 */
const DEFAULT_ARTICLE_PROMPT = `You receive an email conversation (or a single email). Rewrite it into a comprehensive, clear knowledge base article in **Markdown**, without duplicate or overlapping content and without contact information in the output.

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

## Notes

Task:
* Take the input one-to-one as source.
* Rewrite more extensively and better structured.
* Remove duplicates and overlap.
* Deliver only the final Markdown output.

IMPORTANT: Detect the language of the email conversation and write the article in that SAME language.`;

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
        console.warn(`[EmailKBProcessor] Model resolution failed for tier "${tierName}", using fallback:`, resolveErr.message);
        return 'gpt-4.1-mini';
    }
}

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
        console.log(`[EmailKBProcessor] Article stage: model=${modelId} tier=${modelTier}`);

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
        console.error('[EmailKBProcessor] AI summarization failed:', err.message);
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
        console.log(`[EmailKBProcessor] Category stage: model=${modelId} tier=${modelTier}`);

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
        console.warn('[EmailKBProcessor] Category classification failed:', catErr.message);
    }

    return 'Uncategorized';
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
        articleModelTier = 'fast', articlePrompt,
        categoryModelTier = 'fast', categoryPrompt,
        orgId,
    } = options;

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

    // Stage 2: Redact PII (pre-AI pass) — optional
    const redacted = shouldRedact ? redactPII(cleaned) : cleaned;

    // Prepend metadata for AI context
    let aiInput = redacted;
    if (subject || date) {
        const header = [subject && `Subject: ${subject}`, date && `Date: ${date}`].filter(Boolean).join('\n');
        aiInput = `${header}\n---\n${redacted}`;
    }

    // Stage 3: AI Article generation
    const { article, reason } = await summarizeToArticle(aiInput, {
        orgId, language,
        modelTier: articleModelTier,
        customPrompt: articlePrompt,
    });
    if (!article) {
        return { success: false, reason: reason || 'AI summarization failed', skipped: true };
    }

    // Stage 4: AI Categorization (separate model tier + prompt)
    const category = await categorizeArticle(article, {
        orgId, language,
        modelTier: categoryModelTier,
        customPrompt: categoryPrompt,
    });

    // Stage 5: Post-AI PII pass — optional
    const sanitizedArticle = shouldRedact ? redactPII(article) : article;

    // Build title
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
        articleModelTier = 'fast', articlePrompt,
        categoryModelTier = 'fast', categoryPrompt,
        orgId,
    } = options;

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
 * Merge multiple processed articles by category into comprehensive KB documents.
 *
 * @param {Array<{article: string, category: string, title: string}>} articles — processed email articles
 * @param {object} options — { orgId, redactPII, modelTier, customPrompt, language }
 * @returns {Promise<Array<{category: string, article: string, title: string, sourceCount: number}>>}
 */
async function mergeArticlesByCategory(articles, options = {}) {
    const { redactPII: shouldRedact = true, modelTier = 'fast', customPrompt, language, orgId } = options;

    // Group by category
    const groups = {};
    for (const a of articles) {
        const cat = a.category || 'Uncategorized';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(a.article);
    }

    console.log(`[EmailKBProcessor] Merging ${articles.length} articles into ${Object.keys(groups).length} categories: ${Object.keys(groups).join(', ')}`);

    const results = [];
    for (const [category, articleTexts] of Object.entries(groups)) {
        try {
            const merged = articleTexts.join('\n\n---\n\n');

            console.log(`[EmailKBProcessor] Merging ${articleTexts.length} articles for category "${category}" (${merged.length} chars)`);

            const { article } = await summarizeToArticle(merged, {
                orgId,
                modelTier,
                language,
                customPrompt: customPrompt || DEFAULT_MERGE_PROMPT,
            });

            if (article) {
                const sanitized = shouldRedact ? redactPII(article) : article;
                results.push({
                    category,
                    article: sanitized,
                    title: category,
                    sourceCount: articleTexts.length,
                });
            } else {
                console.warn(`[EmailKBProcessor] Merge produced empty result for category "${category}"`);
            }
        } catch (err) {
            console.error(`[EmailKBProcessor] Merge failed for category "${category}":`, err.message);
        }
    }

    return results;
}

module.exports = {
    // Individual stages (for testing)
    cleanEmail,
    redactPII,
    summarizeToArticle,
    categorizeArticle,
    // Full pipelines
    processEmail,
    processEmailThread,
    mergeArticlesByCategory,
    // Constants
    DEFAULT_ARTICLE_PROMPT,
    DEFAULT_CATEGORY_PROMPT,
    DEFAULT_MERGE_PROMPT,
};
