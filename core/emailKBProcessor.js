/**
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
        }
    }

    // Stage 1: Clean
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
};
