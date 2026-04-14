/**
<<<<<<< test2
 * Email KB Processor — 3-stage email-to-article pipeline
 *
 * Stage 1: HTML cleanup — strip signatures, styles, scripts, quoted text
 * Stage 2: PII redaction — mask phone numbers, addresses, etc.
 * Stage 3: AI summarization — convert cleaned email to structured KB article
 */

// ── Stage 1: HTML Cleanup ──────────────────────────────────────────────────

function cleanEmailHtml(html) {
    if (!html) return '';
    let text = html;

    // Strip HTML tags
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n\n');
    text = text.replace(/<\/div>/gi, '\n');
    text = text.replace(/<\/li>/gi, '\n');
    text = text.replace(/<li[^>]*>/gi, '• ');
    text = text.replace(/<[^>]+>/g, '');

    // Decode HTML entities
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");

    // Remove email signatures (common patterns)
    text = text.replace(/^--\s*$/m, '\n---CUT---');
    text = text.replace(/^_{5,}/m, '\n---CUT---');
    text = text.replace(/^Sent from my (iPhone|iPad|Android|Galaxy|Pixel|mobile).*/gmi, '');
    text = text.replace(/^Get Outlook for.*/gmi, '');

    // Remove quoted replies
    text = text.replace(/^>.*$/gm, '');
    text = text.replace(/^On .+ wrote:$/gm, '---CUT---');
    text = text.replace(/^From:.*$/gm, '---CUT---');

    // Cut at first signature/reply marker
    const cutIdx = text.indexOf('---CUT---');
    if (cutIdx > 50) text = text.substring(0, cutIdx);

    // Normalize whitespace
    text = text.replace(/\r\n/g, '\n');
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.replace(/[ \t]+/g, ' ');
    text = text.trim();

    return text;
}

// ── Stage 2: PII Redaction ─────────────────────────────────────────────────

function redactPII(text) {
    // Phone numbers (various formats)
    text = text.replace(/(\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g, '[PHONE]');
    // SSN-like patterns
    text = text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]');
    // Credit card numbers
    text = text.replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, '[CARD]');
    // IP addresses
    text = text.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP]');
    return text;
}

// ── Stage 3: AI Summarization ──────────────────────────────────────────────

const ARTICLE_PROMPT = `You are a knowledge base article writer. Convert the following email content into a clear, structured Markdown knowledge base article.

Rules:
- Write a clear title as an H1 heading
- Organize into logical sections with H2 headings
- Extract key information, decisions, and action items
- Remove any greetings, pleasantries, and filler text
- Keep technical details and specifics intact
- If the email is a question/answer thread, format as Q&A
- Output ONLY the Markdown article, no explanations

Email metadata:
Subject: {subject}
From: {from}
Date: {date}

Email content:
{body}`;

const CATEGORY_PROMPT = `Classify this email article into one category. Respond with ONLY the category name (1-3 words).
Common categories: General, IT Support, HR, Sales, Product, Engineering, Customer Service, Finance, Legal, Marketing, Operations.

Title: {title}
First 200 chars: {preview}`;

async function callAI(messages, temperature = 0.3, maxTokens = 2000) {
    const { getAIConfig, getProviderForModel } = require('./aiAgent');

    // Use the default model config
    const defaultConfig = await getAIConfig();
    const model = defaultConfig.model || 'gpt-4o-mini';

    let config;
    try {
        config = await getProviderForModel(model);
    } catch (_) {
        config = defaultConfig;
    }

    const apiUrl = (config.url || '').replace(/\/+$/, '');
    const baseUrl = apiUrl.endsWith('/v1') ? apiUrl : `${apiUrl}/v1`;

    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: config.model || model,
            messages,
            temperature,
            max_tokens: maxTokens,
        }),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`AI API error: ${res.status} — ${err.substring(0, 200)}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
}

async function summarizeWithAI(body, metadata, options = {}) {
    try {
        const prompt = (options.customPrompt || ARTICLE_PROMPT)
            .replace('{subject}', metadata.subject || 'No subject')
            .replace('{from}', metadata.from || 'Unknown')
            .replace('{date}', metadata.date || 'Unknown')
            .replace('{body}', body.substring(0, 8000));

        const article = await callAI([{ role: 'user', content: prompt }], 0.3, 2000);
        if (!article || article.length < 20) {
            return { success: false, reason: 'AI returned empty article' };
        }

        // Extract title from first H1
        const titleMatch = article.match(/^#\s+(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : metadata.subject || 'Email Article';

        // Get category
        let category = 'General';
        try {
            const catText = await callAI([{ role: 'user', content: CATEGORY_PROMPT
                .replace('{title}', title)
                .replace('{preview}', article.substring(0, 200))
            }], 0.1, 20);
            category = catText?.trim() || 'General';
        } catch (_) { /* category is optional */ }

        return { success: true, title, category, article };
    } catch (err) {
        console.error('[EmailKBProcessor] AI summarization error:', err.message);
        return { success: false, reason: err.message };
    }
}

// ── Public API ─────────────────────────────────────────────────────────────

async function processEmail(rawBody, metadata, options = {}) {
    // Check sender blacklist
    const from = (metadata.from || '').toLowerCase();
    for (const blocked of (options.senderBlacklist || [])) {
        if (from.includes(blocked.toLowerCase())) {
            return { success: false, reason: 'Sender blacklisted' };
=======
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
const DEFAULT_ARTICLE_PROMPT = `You receive a conversation from an email thread. Convert it into a compact, knowledge-base-suitable article in **Markdown**. Use **only \`##\` headers** and ensure **no contact information** appears in the output.

> **If a section is not applicable: show nothing** (no header, no "N/A"). Do not invent anything not in the conversation.

IMPORTANT LANGUAGE RULE (hard):
* Never use persons or references to persons.
* Avoid words like: user, employee, person, customer, requester, reporter, colleague.
* Avoid pronouns referring to persons: he, she, him, her, their, someone.
* Write completely impersonally: describe actions without an actor ("Check…", "Request…", "Adjust…") or name only process entities ("Helpdesk", "IT management") without personal references.

Privacy & security (hard):
* Never include sensitive data or contact information. This includes at minimum:
  * Personal data and contact information: names, email addresses, phone numbers, addresses, usernames, customer numbers.
  * Technical identifiers: IP addresses, MAC addresses, serial numbers, asset tags, tokens, session IDs.
  * Security information: passwords, PIN codes, MFA/2FA codes, recovery codes, API keys, client secrets, certificates, private keys, access tokens, refresh tokens, login credentials (in any form).
* If such information appears: generalize or omit.

## {Subject (concise)}

Describe the problem in 1-3 sentences, without personal references and without sensitive data.

## Solution

Briefly describe the solution and the desired end result.

## Steps

Write **specific, actionable steps** that need to be performed, numbered and in order.

## Root Cause

Only include if the root cause is explicitly clear from the conversation.

## Notes

Only include if relevant for reuse.

IMPORTANT: Detect the language of the email conversation and write the article in that SAME language.`;

const DEFAULT_CATEGORY_PROMPT = `The only thing you return is one category (exactly one line), without any other detail.

Goal: Choose the best-fitting category for the email based on the root cause.

Rules (hard):
- Output = exactly one category string. No explanation, no JSON, no quotes.
- Category is singular: 1 concept, 1-3 words, Title Case.
- Never composite/comparative categories: no "/", "&", "+", "and", commas, brackets.
- Do not use full sentences or solutions. Only the domain.

Preferred labels (soft guideline, pick what fits):
- Rights/roles/access/permissions → "Access"
- Login/MFA/password → "Account"
- Email/spam/delivery → "Email"
- Network/VPN/WiFi → "Network"
- Hardware/laptop/monitor → "Hardware"
- Printer/scanning → "Printer"
- Phone → "Phone"
- Teams/Webex/meetings → "Meetings"
- Performance/bug/error in app without permission issue → "Application"
- Desktop/Windows/updates → "Desktop"
- Other → use a fitting 1-2 word category

Detect the language from the article and write the category in that same language.`;

/**
 * Generate a KB article from cleaned email text using the org's AI model.
 *
 * @param {string} cleanedText — email text after HTML cleanup + PII redaction
 * @param {object} options
 * @param {string} [options.customPrompt] — override system prompt
 * @param {string} [options.orgId] — organization ID for model resolution
 * @returns {Promise<{article: string, category: string}>}
 */
async function summarizeToArticle(cleanedText, options = {}) {
    const { customPrompt, orgId } = options;

    if (!cleanedText || cleanedText.trim().length < 20) {
        return { article: null, category: null, reason: 'Content too short' };
    }

    try {
        const configStore = require('../stores/configStore');

        // Resolve AI model — use org default or global default
        let modelId = 'gpt-4.1-mini'; // sensible default
        if (orgId) {
            const orgModel = await configStore.getConfig(`default_model_org_${orgId}`);
            if (orgModel) modelId = orgModel;
        }
        if (!modelId) {
            const globalModel = await configStore.getConfig('default_model');
            if (globalModel) modelId = globalModel;
        }

        // Use direct API call via provider adapters
        const { createChatCompletion } = require('../agents/providerAdapters');

        // Step 1: Generate article
        const articleResult = await createChatCompletion({
            model: modelId,
            messages: [
                { role: 'system', content: customPrompt || DEFAULT_ARTICLE_PROMPT },
                { role: 'user', content: cleanedText }
            ],
            temperature: 0.3,
            max_tokens: 2000,
        });

        const article = articleResult?.choices?.[0]?.message?.content || '';

        if (!article || article.trim().length < 20) {
            return { article: null, category: null, reason: 'AI produced empty article' };
        }

        // Step 2: Categorize
        let category = 'Uncategorized';
        try {
            const catResult = await createChatCompletion({
                model: modelId,
                messages: [
                    { role: 'system', content: DEFAULT_CATEGORY_PROMPT },
                    { role: 'user', content: article }
                ],
                temperature: 0.1,
                max_tokens: 50,
            });
            const rawCat = (catResult?.choices?.[0]?.message?.content || '').trim();
            if (rawCat && rawCat.length < 50) {
                category = rawCat;
            }
        } catch (catErr) {
            console.warn('[EmailKBProcessor] Category classification failed:', catErr.message);
        }

        return { article: article.trim(), category };

    } catch (err) {
        console.error('[EmailKBProcessor] AI summarization failed:', err.message);
        return { article: null, category: null, reason: `AI error: ${err.message}` };
    }
}

// ──────────────────────────────────────────────
// Full Pipeline
// ──────────────────────────────────────────────

/**
 * Process a single email (or grouped thread) through the full pipeline.
 *
 * @param {string} rawContent — raw email HTML or text content
 * @param {object} metadata — { subject, from, date, messageId }
 * @param {object} options — { customPrompt, orgId, senderBlacklist }
 * @returns {Promise<{success: boolean, article?: string, category?: string, title?: string, reason?: string}>}
 */
async function processEmail(rawContent, metadata = {}, options = {}) {
    const { subject, from, date, messageId } = metadata;
    const { senderBlacklist = [] } = options;

    // Check sender blacklist
    if (from && senderBlacklist.length > 0) {
        const senderEmail = (from.match(/<([^>]+)>/) || [, from])[1].toLowerCase();
        if (senderBlacklist.some(b => senderEmail.includes(b.toLowerCase()))) {
            return { success: false, reason: 'Sender blacklisted', skipped: true };
>>>>>>> main
        }
    }

    // Stage 1: Clean
<<<<<<< test2
    let cleaned = cleanEmailHtml(rawBody);
    if (cleaned.length < 30) {
        return { success: false, reason: 'Email body too short after cleanup' };
    }

    // Stage 2: Redact PII
    cleaned = redactPII(cleaned);

    // Stage 3: AI summarize
    return summarizeWithAI(cleaned, metadata, options);
}

async function processEmailThread(messages, metadata, options = {}) {
    // Check sender blacklist
    const from = (metadata.from || '').toLowerCase();
    for (const blocked of (options.senderBlacklist || [])) {
        if (from.includes(blocked.toLowerCase())) {
            return { success: false, reason: 'Sender blacklisted' };
        }
    }

    // Combine thread messages
    const combined = messages.map((msg, i) => {
        const cleaned = cleanEmailHtml(msg.body);
        return `--- Message ${i + 1} (${msg.date || 'unknown date'}) ---\n${cleaned}`;
    }).join('\n\n');

    if (combined.length < 30) {
        return { success: false, reason: 'Thread too short after cleanup' };
    }

    const redacted = redactPII(combined);
    return summarizeWithAI(redacted, metadata, options);
}

module.exports = {
    processEmail,
    processEmailThread,
    cleanEmailHtml,
    redactPII,
=======
    const cleaned = cleanEmail(rawContent);
    if (!cleaned || cleaned.trim().length < 20) {
        return { success: false, reason: 'No meaningful content after cleanup', skipped: true };
    }

    // Stage 2: Redact PII
    const redacted = redactPII(cleaned);

    // Stage 3: AI Summarize
    const { article, category, reason } = await summarizeToArticle(redacted, options);
    if (!article) {
        return { success: false, reason: reason || 'AI summarization failed', skipped: true };
    }

    // Build title from subject or first line
    const title = subject
        ? `${category}: ${subject.replace(/^(re|fw|fwd):\s*/gi, '').trim()}`
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
    const { senderBlacklist = [] } = options;

    // Check sender blacklist on the thread starter
    if (from && senderBlacklist.length > 0) {
        const senderEmail = (from.match(/<([^>]+)>/) || [, from])[1].toLowerCase();
        if (senderBlacklist.some(b => senderEmail.includes(b.toLowerCase()))) {
            return { success: false, reason: 'Sender blacklisted', skipped: true };
        }
    }

    // Clean all messages, filter out system messages and empties
    const cleanedMessages = messages
        .map(msg => {
            const text = cleanEmail(msg.body || msg.content || '');
            // Skip system status changes (from the n8n filter)
            if (text === 'Status gewijzigd naar Gesloten' || text.length < 10) return null;
            return redactPII(text);
        })
        .filter(Boolean);

    if (cleanedMessages.length === 0) {
        return { success: false, reason: 'No meaningful messages in thread', skipped: true };
    }

    // Merge into single conversation text
    const merged = cleanedMessages.join('\n\n---\n\n');

    // AI Summarize the entire thread
    const { article, category, reason } = await summarizeToArticle(merged, options);
    if (!article) {
        return { success: false, reason: reason || 'AI summarization failed', skipped: true };
    }

    const title = subject
        ? `${category}: ${subject.replace(/^(re|fw|fwd):\s*/gi, '').trim()}`
        : `${category}: ${article.split('\n')[0].replace(/^#+\s*/, '').substring(0, 80)}`;

    return {
        success: true,
        article,
        category,
        title,
        sourceDate: date,
        messageCount: cleanedMessages.length,
    };
}

module.exports = {
    // Individual stages (for testing)
    cleanEmail,
    redactPII,
    summarizeToArticle,
    // Full pipelines
    processEmail,
    processEmailThread,
    // Constants
    DEFAULT_ARTICLE_PROMPT,
    DEFAULT_CATEGORY_PROMPT,
>>>>>>> main
};
