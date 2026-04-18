/**
 * Per-stage pipeline runner for the Email Knowledge Base.
 *
 * Supports the interactive "run a single stage" workflow in the admin UI:
 * fetches a sample email from the connection, runs exactly one stage with
 * optional overrides, and returns input + output + config so the user can
 * inspect and iterate.
 *
 * Also exposes a meta-prompting helper that asks a user-selected model
 * (via model tier) to propose an improved system prompt for a stage when
 * the user is unhappy with the output.
 */

const {
    cleanEmail,
    redactPIIWithCounts,
    summarizeToArticle,
    categorizeArticle,
    summarizeAndCategorize,
    mergeArticlesByCategory,
    dedupeMergedChunks,
} = require('./emailKBProcessor');

/**
 * Fetch the single most recent email from the connection's mailbox, honouring
 * folder_filter and sync_after_date. Returns {subject, from, date, body} or null.
 */
async function fetchLatestEmailSample(connection) {
    if (connection.provider === 'gmail') {
        return fetchGmailSample(connection);
    }
    return fetchOutlookSample(connection);
}

async function fetchGmailSample(connection) {
    const { google } = require('googleapis');
    const { loadConfig } = require('../auth/permissions');
    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};

    const oauth2Client = new google.auth.OAuth2(providerConfig.clientId, providerConfig.clientSecret);
    oauth2Client.setCredentials({
        access_token: connection.tokens.accessToken,
        refresh_token: connection.tokens.refreshToken,
    });

    const LABEL_MAP = {
        'inbox': 'INBOX', 'sent': 'SENT', 'drafts': 'DRAFT', 'draft': 'DRAFT',
        'starred': 'STARRED', 'important': 'IMPORTANT',
        'in:sent': 'SENT', 'in:inbox': 'INBOX',
    };
    const rawFilters = connection.folder_filter || ['INBOX'];
    const labelIds = rawFilters.map(f => LABEL_MAP[f.toLowerCase()] || f);

    const listParams = { userId: 'me', maxResults: 1 };
    if (labelIds.length > 0) listParams.labelIds = labelIds;
    if (connection.sync_after_date) {
        listParams.q = `after:${new Date(connection.sync_after_date).toISOString().split('T')[0].replace(/-/g, '/')}`;
    }

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const list = await gmail.users.messages.list(listParams);
    if (!list.data.messages?.length) return null;

    const detail = await gmail.users.messages.get({
        userId: 'me', id: list.data.messages[0].id, format: 'full',
    });
    const headers = detail.data.payload?.headers || [];
    const getHeader = (name) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
    const body = extractGmailBody(detail.data.payload);

    return {
        subject: getHeader('Subject'),
        from: getHeader('From'),
        date: getHeader('Date'),
        body,
    };
}

function extractGmailBody(payload) {
    if (!payload) return '';
    const decode = (data) => data ? Buffer.from(data, 'base64').toString('utf8') : '';
    if (payload.body?.data) return decode(payload.body.data);
    if (Array.isArray(payload.parts)) {
        const html = payload.parts.find(p => p.mimeType === 'text/html' && p.body?.data);
        if (html) return decode(html.body.data);
        const plain = payload.parts.find(p => p.mimeType === 'text/plain' && p.body?.data);
        if (plain) return decode(plain.body.data);
        for (const p of payload.parts) {
            const nested = extractGmailBody(p);
            if (nested) return nested;
        }
    }
    return '';
}

async function fetchOutlookSample(connection) {
    const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
    const outlookFolders = connection.folder_filter || ['Inbox'];
    let filterQ = '';
    if (connection.sync_after_date) {
        filterQ = `$filter=${encodeURIComponent(`receivedDateTime ge ${new Date(connection.sync_after_date).toISOString()}`)}&`;
    }

    let msg;
    try {
        const resp = await fetch(`${GRAPH_BASE}/me/mailFolders/${encodeURIComponent(outlookFolders[0])}/messages?${filterQ}$top=1&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,body`, {
            headers: { 'Authorization': `Bearer ${connection.tokens.accessToken}` },
        });
        if (!resp.ok) throw new Error(resp.status);
        const data = await resp.json();
        msg = data.value?.[0];
    } catch {
        const resp = await fetch(`${GRAPH_BASE}/me/messages?${filterQ}$top=1&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,body`, {
            headers: { 'Authorization': `Bearer ${connection.tokens.accessToken}` },
        });
        if (!resp.ok) throw new Error(`Outlook fetch failed: ${resp.status}`);
        const data = await resp.json();
        msg = data.value?.[0];
    }

    if (!msg) return null;
    return {
        subject: msg.subject,
        from: msg.from?.emailAddress
            ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address || ''}>`.trim()
            : '',
        date: msg.receivedDateTime,
        body: msg.body?.content || '',
    };
}

/**
 * Run a single pipeline stage with optional config overrides.
 *
 * @param {object} args
 * @param {object} args.connection       Full connection (incl. tokens when sampling)
 * @param {string} args.stage            One of: cleanup, pii, article, category, summarize_and_categorize, merge
 * @param {string} [args.inputText]      Raw text to feed the stage. If omitted, fetches latest email sample.
 * @param {object} [args.overrides]      { systemPrompt, modelTier, language }
 * @returns {Promise<object>} { stage, source, input:{...}, output:{...}, config:{...}, tookMs }
 */
async function runStage({ connection, stage, inputText, overrides = {} }) {
    const t0 = Date.now();
    const pc = connection.pipeline_config || {};
    const orgId = connection.organization_id;
    const language = overrides.language ?? pc.language ?? '';

    // Resolve input: provided text OR latest sample email body.
    let source = 'provided';
    let sampleMeta = null;
    let rawInput = inputText;
    if (!rawInput) {
        const sample = await fetchLatestEmailSample(connection);
        if (!sample) {
            return {
                stage,
                source: 'sample',
                input: null,
                output: null,
                config: {},
                tookMs: Date.now() - t0,
                error: 'No emails found matching the connection filters',
            };
        }
        source = 'sample';
        sampleMeta = { subject: sample.subject, from: sample.from, date: sample.date };
        rawInput = sample.body;
    }

    const inputPayload = { source, sample: sampleMeta, body: rawInput };

    switch (stage) {
        case 'cleanup': {
            const output = cleanEmail(rawInput || '');
            return {
                stage, source, input: inputPayload,
                output: { cleaned: output, chars: output.length },
                config: {},
                tookMs: Date.now() - t0,
            };
        }
        case 'pii': {
            const cleaned = cleanEmail(rawInput || '');
            const disable = Array.isArray(pc.pii?.disable) ? pc.pii.disable : [];
            const redactEnabled = connection.redact_pii !== false;
            const { text, counts } = redactPIIWithCounts(cleaned, { disable });
            return {
                stage, source, input: inputPayload,
                output: { before: cleaned, after: text, counts, enabled: redactEnabled, disabled: disable },
                config: { disable, enabled: redactEnabled },
                tookMs: Date.now() - t0,
            };
        }
        case 'article': {
            // Ensure we run the AI on cleaned + redacted text (same as prod path).
            const cleaned = cleanEmail(rawInput || '');
            const disable = Array.isArray(pc.pii?.disable) ? pc.pii.disable : [];
            const redacted = (connection.redact_pii !== false)
                ? redactPIIWithCounts(cleaned, { disable }).text
                : cleaned;
            const customPrompt = overrides.systemPrompt ?? pc.article?.systemPrompt ?? connection.ai_system_prompt ?? '';
            const modelTier = overrides.modelTier ?? pc.article?.modelTier ?? 'fast';
            const result = await summarizeToArticle(redacted, { customPrompt, orgId, modelTier, language });
            return {
                stage, source, input: { ...inputPayload, preprocessed: redacted },
                output: result,
                config: { modelTier, systemPrompt: customPrompt || '(default)', language },
                tookMs: Date.now() - t0,
            };
        }
        case 'category': {
            // The "article" for categorisation may be either provided directly OR synthesised from the email.
            // If the caller passes rawInput that looks like an already-written article (starts with ##), use as-is.
            // Otherwise, run article stage first so category runs on the actual shape of real inputs.
            const looksLikeArticle = /^\s*#{1,3}\s/.test(rawInput || '');
            let articleText = rawInput || '';
            if (!looksLikeArticle) {
                const cleaned = cleanEmail(rawInput || '');
                const disable = Array.isArray(pc.pii?.disable) ? pc.pii.disable : [];
                const redacted = (connection.redact_pii !== false)
                    ? redactPIIWithCounts(cleaned, { disable }).text
                    : cleaned;
                const articleRes = await summarizeToArticle(redacted, {
                    customPrompt: pc.article?.systemPrompt || connection.ai_system_prompt || '',
                    orgId,
                    modelTier: pc.article?.modelTier || 'fast',
                    language,
                });
                articleText = articleRes.article || redacted;
            }
            const customPrompt = overrides.systemPrompt ?? pc.category?.systemPrompt ?? '';
            const modelTier = overrides.modelTier ?? pc.category?.modelTier ?? 'fast';
            const category = await categorizeArticle(articleText, { customPrompt, orgId, modelTier, language });
            return {
                stage, source, input: { ...inputPayload, articleText },
                output: { category },
                config: { modelTier, systemPrompt: customPrompt || '(default)', language },
                tookMs: Date.now() - t0,
            };
        }
        case 'summarize_and_categorize': {
            const cleaned = cleanEmail(rawInput || '');
            const disable = Array.isArray(pc.pii?.disable) ? pc.pii.disable : [];
            const redacted = (connection.redact_pii !== false)
                ? redactPIIWithCounts(cleaned, { disable }).text
                : cleaned;
            const articlePrompt = overrides.systemPrompt ?? pc.article?.systemPrompt ?? connection.ai_system_prompt ?? '';
            const categoryPrompt = pc.category?.systemPrompt ?? '';
            const modelTier = overrides.modelTier ?? pc.article?.modelTier ?? 'fast';
            const result = await summarizeAndCategorize(redacted, {
                articlePrompt, categoryPrompt, orgId, modelTier, language,
            });
            return {
                stage, source, input: { ...inputPayload, preprocessed: redacted },
                output: result,
                config: { modelTier, articlePrompt: articlePrompt || '(default)', language },
                tookMs: Date.now() - t0,
            };
        }
        case 'merge': {
            // For merge we expect the caller to pass a pre-built list of articles
            // in rawInput (one article per "---" separator). We fake a single-category bundle.
            const parts = (rawInput || '').split(/\n-{3,}\n/).map(s => s.trim()).filter(Boolean);
            if (parts.length === 0) {
                return {
                    stage, source, input: inputPayload, output: null, config: {},
                    tookMs: Date.now() - t0,
                    error: 'Merge requires one or more articles separated by "---"',
                };
            }
            const fakeArticles = parts.map((content, i) => ({
                article: content,
                category: 'Test',
                subject: `Article ${i + 1}`,
                messageId: `test-${i}`,
            }));
            const customPrompt = overrides.systemPrompt ?? pc.merge?.systemPrompt ?? '';
            const modelTier = overrides.modelTier ?? pc.merge?.modelTier ?? 'fast';
            const merged = await mergeArticlesByCategory(fakeArticles, {
                orgId, modelTier, customPrompt, language,
            });
            return {
                stage, source, input: inputPayload,
                output: { merged },
                config: { modelTier, systemPrompt: customPrompt || '(default)', language },
                tookMs: Date.now() - t0,
            };
        }
        case 'dedupe': {
            // Dedupe expects 2+ pre-merged chunk outputs separated by `---`.
            // It runs the cross-chunk dedupe pass directly, bypassing the
            // chunk-write phase — so the user can iterate on the dedupe prompt
            // without re-running the (expensive) chunk-write step.
            const parts = (rawInput || '').split(/\n-{3,}\n/).map(s => s.trim()).filter(Boolean);
            if (parts.length < 2) {
                return {
                    stage, source, input: inputPayload, output: null, config: {},
                    tookMs: Date.now() - t0,
                    error: 'Dedupe requires 2 or more pre-merged chunk outputs separated by "---"',
                };
            }
            const customPrompt = overrides.systemPrompt ?? pc.dedupe?.systemPrompt ?? '';
            const modelTier = overrides.modelTier ?? pc.dedupe?.modelTier ?? pc.merge?.modelTier ?? 'fast';
            const result = await dedupeMergedChunks(parts, {
                orgId, modelTier, customPrompt, language,
            });
            return {
                stage, source, input: { ...inputPayload, chunkCount: parts.length },
                output: { merged: result.article, reason: result.reason },
                config: { modelTier, systemPrompt: customPrompt || '(default)', language },
                tookMs: Date.now() - t0,
            };
        }
        default:
            throw new Error(`Unknown stage: ${stage}`);
    }
}

/**
 * Ask an LLM (selected by model tier) to propose an improved system prompt for
 * a given stage, based on a sample input/output and user feedback describing
 * what's wrong.
 *
 * @returns {Promise<{ proposedPrompt: string, reasoning: string, modelUsed: string }>}
 */
async function proposePromptImprovement({
    connection,
    stage,
    currentPrompt,
    sampleInput,
    sampleOutput,
    userFeedback,
    modelTier = 'thinking',
}) {
    const { resolveModelForTierName } = require('./modelResolver');
    const { createChatCompletion } = require('../agents/providerAdapters');

    const modelId = await resolveModelForTierName(modelTier, {
        userOrgId: connection.organization_id,
        fallback: 'gpt-4.1-mini',
    });

    const stageDescription = {
        article:   'turns a single cleaned email into a structured Markdown KB article',
        category:  'assigns a short category label (1–3 words) to a KB article',
        merge:     'merges several per-email articles of the same category into one consolidated KB document',
        dedupe:    'cross-chunk deduplication: merges multiple separately-processed chunks of the same category into one deduplicated KB article',
        usefulness:'classifies whether a conversation contains reusable knowledge (nuttig: true|false)',
    }[stage] || `runs pipeline stage "${stage}"`;

    const systemPrompt = `You are a senior prompt engineer. The user is tuning a production prompt for an email knowledge-base pipeline. Your job is to propose an improved system prompt that directly addresses the user's complaint — without over-reaching.

Stage: ${stage}
Stage purpose: ${stageDescription}

Rules:
- Respect the original intent: keep what works, change only what the feedback says is wrong.
- Output STRICT JSON with exactly two fields: { "proposedPrompt": string, "reasoning": string }
- "proposedPrompt" is the FULL replacement system prompt (multi-line). Do not include placeholders like "<your rules here>".
- "reasoning" is 1–3 sentences explaining the concrete change you made and why.
- Do NOT include code fences or markdown around the JSON.
- If the user's feedback is impossible to address without external info, still return a best-effort prompt and explain the limitation in "reasoning".`;

    const userContent = [
        `CURRENT SYSTEM PROMPT:`,
        currentPrompt?.trim() || '(using the default prompt — you must write the full new prompt from scratch)',
        ``,
        `SAMPLE INPUT (truncated to 3000 chars):`,
        (sampleInput || '').slice(0, 3000),
        ``,
        `CURRENT OUTPUT:`,
        (sampleOutput || '').slice(0, 2000),
        ``,
        `USER FEEDBACK:`,
        userFeedback || '(no specific feedback given — propose general improvements)',
    ].join('\n');

    const resp = await createChatCompletion({
        model: modelId,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
        ],
        temperature: 0.3,
        max_tokens: 2000,
    });

    const raw = resp?.choices?.[0]?.message?.content || '';
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // Try to extract the first balanced {...}
        const m = raw.match(/\{[\s\S]*\}/);
        parsed = m ? safeJson(m[0]) : null;
    }
    if (!parsed || typeof parsed.proposedPrompt !== 'string') {
        throw new Error('AI response could not be parsed as {proposedPrompt, reasoning} JSON');
    }

    return {
        proposedPrompt: parsed.proposedPrompt.trim(),
        reasoning: (parsed.reasoning || '').trim(),
        modelUsed: modelId,
    };
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

module.exports = {
    fetchLatestEmailSample,
    runStage,
    proposePromptImprovement,
};
