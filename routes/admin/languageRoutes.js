/**
 * Language Routes — Admin API for managing i18n locales, GUI translations, and prompt translations
 * 
 * All admin routes require authentication + admin permissions.
 * User-facing routes (GET effective strings) require only authentication.
 */

const express = require('express');
const router = express.Router();
const languageStore = require('../../stores/languageStore');
const { PROMPT_IDS, PROMPT_LABELS, PROMPT_CATEGORIES, getAllDefaults } = require('../../i18n/defaults/promptDefaults');
const { GUI_DEFAULTS, getGUINamespaces } = require('../../i18n/defaults/en');
const {
    EMAIL_TEMPLATE_IDS, EMAIL_TEMPLATE_FIELDS, EMAIL_TEMPLATE_VARIABLES,
    EMAIL_TEMPLATE_LABELS, EMAIL_TEMPLATE_DEFAULTS,
} = require('../../i18n/defaults/emailTemplates');
const { LEGAL_DOC_IDS, getLegalDefault } = require('../../i18n/defaults/legalDocs');

// ── Middleware ───────────────────────────────────────────────────

const { hasPermission } = require('../../auth/permissions');

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

async function requireAdmin(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
    if (req.session.isAdmin || req.session.user?.role === 'admin') return next();
    // Check RBAC permissions
    const userId = req.session.user?.id;
    if (userId && await hasPermission(userId, 'all', req.session)) return next();
    return res.status(403).json({ error: 'Admin access required' });
}

// ══════════════════════════════════════════════════════════════════
// ADMIN ROUTES (require admin)
// ══════════════════════════════════════════════════════════════════

// ── Locale Management ───────────────────────────────────────────

// GET /admin/languages — List all configured locales
router.get('/', requireAdmin, async (req, res) => {
    try {
        const locales = await languageStore.getAvailableLocales();
        res.json({
            locales,
            catalog: languageStore.AVAILABLE_LOCALE_CATALOG,
        });
    } catch (err) {
        console.error('[Languages] List error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /admin/languages — Add a new locale
router.post('/', requireAdmin, async (req, res) => {
    try {
        const { code, name } = req.body;
        if (!code || !name) {
            return res.status(400).json({ error: 'Language code and name are required' });
        }
        const locales = await languageStore.addLocale(code.toLowerCase(), name);
        res.json({ success: true, locales });
    } catch (err) {
        console.error('[Languages] Add error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// DELETE /admin/languages/:code — Delete a locale and all its translations
router.delete('/:code', requireAdmin, async (req, res) => {
    try {
        const locales = await languageStore.deleteLocale(req.params.code);
        res.json({ success: true, locales });
    } catch (err) {
        console.error('[Languages] Delete error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// PUT /admin/languages/:code/default — Set a locale as the default
router.put('/:code/default', requireAdmin, async (req, res) => {
    try {
        const locales = await languageStore.setDefaultLocale(req.params.code);
        res.json({ success: true, locales });
    } catch (err) {
        console.error('[Languages] Set default error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// ── GUI Translations ────────────────────────────────────────────

// GET /admin/languages/defaults/gui — Get English default GUI strings
router.get('/defaults/gui', requireAdmin, async (req, res) => {
    try {
        res.json({
            defaults: GUI_DEFAULTS,
            namespaces: getGUINamespaces(),
            totalKeys: Object.keys(GUI_DEFAULTS).length,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /admin/languages/:code/gui — Get GUI translations for a locale
router.get('/:code/gui', requireAdmin, async (req, res) => {
    try {
        const translations = await languageStore.getGUITranslations(req.params.code);
        const totalKeys = Object.keys(GUI_DEFAULTS).length;
        const translatedKeys = Object.keys(translations).length;

        res.json({
            translations,
            defaults: GUI_DEFAULTS,
            namespaces: getGUINamespaces(),
            stats: {
                total: totalKeys,
                translated: translatedKeys,
                missing: totalKeys - translatedKeys,
                progress: totalKeys > 0 ? Math.round((translatedKeys / totalKeys) * 100) : 0,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /admin/languages/:code/gui — Save GUI translations for a locale
router.put('/:code/gui', requireAdmin, async (req, res) => {
    try {
        const { translations } = req.body;
        if (!translations || typeof translations !== 'object') {
            return res.status(400).json({ error: 'translations object is required' });
        }
        await languageStore.setGUITranslations(req.params.code, translations);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH /admin/languages/:code/gui — Update individual GUI translations (merge)
router.patch('/:code/gui', requireAdmin, async (req, res) => {
    try {
        const { updates } = req.body; // { "key": "value", ... }
        if (!updates || typeof updates !== 'object') {
            return res.status(400).json({ error: 'updates object is required' });
        }
        const existing = await languageStore.getGUITranslations(req.params.code);
        const merged = { ...existing, ...updates };

        // Remove keys set to empty string (treat as "reset to default")
        for (const [key, val] of Object.entries(updates)) {
            if (val === '' || val === null) delete merged[key];
        }

        await languageStore.setGUITranslations(req.params.code, merged);
        res.json({ success: true, translations: merged });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Email Templates (verification + welcome) ─────────────────────
// Per-locale, structured-field transactional email templates. Stored as
// overrides; getEffectiveEmailTemplate merges per-field over the English
// defaults so a partially translated locale still renders.

// GET /admin/languages/:code/email-templates — overrides + defaults + meta
router.get('/:code/email-templates', requireAdmin, async (req, res) => {
    try {
        const code = req.params.code;
        const templates = await languageStore.getAllEmailTemplates(code);
        // Per-template effective view (defaults merged with this locale's overrides).
        const effective = {};
        for (const id of EMAIL_TEMPLATE_IDS) {
            effective[id] = await languageStore.getEffectiveEmailTemplate(id, code);
        }
        res.json({
            templates,            // raw overrides for this locale
            effective,            // defaults + overrides, per template
            defaults: EMAIL_TEMPLATE_DEFAULTS,
            templateIds: EMAIL_TEMPLATE_IDS,
            fields: EMAIL_TEMPLATE_FIELDS,
            variables: EMAIL_TEMPLATE_VARIABLES,
            labels: EMAIL_TEMPLATE_LABELS,
        });
    } catch (err) {
        console.error('[Languages] Email templates get error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// PUT /admin/languages/:code/email-templates — save one template's fields
// (empty/blank field = reset that field to the English default)
router.put('/:code/email-templates', requireAdmin, async (req, res) => {
    try {
        const { templateId, fields } = req.body || {};
        if (!templateId || !EMAIL_TEMPLATE_IDS.includes(templateId)) {
            return res.status(400).json({ error: 'Valid templateId is required' });
        }
        if (!fields || typeof fields !== 'object') {
            return res.status(400).json({ error: 'fields object is required' });
        }
        const templates = await languageStore.setEmailTemplate(req.params.code, templateId, fields);
        res.json({ success: true, templates });
    } catch (err) {
        console.error('[Languages] Email templates save error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /admin/languages/:code/email-templates/:templateId/preview
// Render a branded HTML preview WITHOUT sending. Accepts optional in-progress
// `fields` in the body so the admin sees unsaved edits; otherwise uses the
// effective (saved/merged) template.
router.post('/:code/email-templates/:templateId/preview', requireAdmin, async (req, res) => {
    try {
        const { code, templateId } = req.params;
        if (!EMAIL_TEMPLATE_IDS.includes(templateId)) {
            return res.status(400).json({ error: 'Unknown templateId' });
        }
        const { renderEmailFromTemplate } = require('../../utils/emailService');
        const base = await languageStore.getEffectiveEmailTemplate(templateId, code);
        // Merge in-progress fields (non-empty) over the effective template.
        const incoming = (req.body && typeof req.body.fields === 'object') ? req.body.fields : {};
        const tpl = { ...base };
        for (const f of EMAIL_TEMPLATE_FIELDS) {
            if (typeof incoming[f] === 'string' && incoming[f].trim()) tpl[f] = incoming[f];
        }
        const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
        const vars = {
            name: 'Alex Example',
            orgName: 'Bee Flow',
            ...(templateId === 'verification' ? { verifyUrl: `${clientHost}/auth/verify-email/preview` } : { loginUrl: clientHost }),
        };
        const { subject, html } = renderEmailFromTemplate(tpl, vars);
        res.json({ subject, html });
    } catch (err) {
        console.error('[Languages] Email template preview error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /admin/languages/:code/email-templates/:templateId/test
// Send the REAL rendered template to a recipient for a true end-to-end check.
router.post('/:code/email-templates/:templateId/test', requireAdmin, async (req, res) => {
    try {
        const { code, templateId } = req.params;
        const { testRecipient } = req.body || {};
        if (!EMAIL_TEMPLATE_IDS.includes(templateId)) {
            return res.status(400).json({ error: 'Unknown templateId' });
        }
        if (!testRecipient || !String(testRecipient).trim()) {
            return res.status(400).json({ error: 'Test recipient email is required' });
        }
        const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
        const { sendVerificationEmail, sendWelcomeEmail } = require('../../utils/emailService');
        const common = { email: String(testRecipient).trim(), displayName: 'Alex Example', orgName: 'Bee Flow', locale: code };
        const result = templateId === 'verification'
            ? await sendVerificationEmail({ ...common, verifyUrl: `${clientHost}/auth/verify-email/preview` })
            : await sendWelcomeEmail({ ...common, loginUrl: clientHost });
        if (result.success) return res.json({ success: true, messageId: result.messageId });
        return res.status(500).json({ error: result.error || 'Failed to send test email' });
    } catch (err) {
        console.error('[Languages] Email template test error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /admin/languages/:code/ai-translate-emails — AI-translate the email
// template fields for a locale (preserves {{variables}}). Mirrors the GUI
// ai-translate handler.
router.post('/:code/ai-translate-emails', requireAdmin, async (req, res) => {
    const locale = req.params.code;
    const { modelTier = 'fast' } = req.body || {};
    if (locale === 'en') {
        return res.status(400).json({ error: 'Cannot AI-translate the base English locale' });
    }
    try {
        const llmClient = require('../../core/llmClient');
        const { resolveModelForTierName } = require('../../core/modelResolver');

        let modelId;
        try {
            modelId = await resolveModelForTierName(modelTier || 'fast', { fallback: 'mistral-small-latest' });
        } catch (_) {
            const { getAIConfig } = require('../../core/aiAgent');
            modelId = (await getAIConfig()).model || 'mistral-small-latest';
        }

        const locales = await languageStore.getAvailableLocales();
        const languageName = (locales.find(l => l.code === locale)?.name) || locale;

        const systemPrompt = `You are a professional translator. Translate the following English transactional-email fields to ${languageName} (${locale}).
Return ONLY a valid JSON object with the same shape: { "<templateId>": { "subject": "...", "title": "...", "intro": "...", "body": "...", "ctaLabel": "..." }, ... }.
Keep it natural and concise — these are customer emails.
CRITICAL: preserve placeholder tokens EXACTLY as written, e.g. {{name}}, {{orgName}}, {{verifyUrl}}, {{loginUrl}}. Do not translate or alter them.
Do NOT translate the JSON keys (templateId / field names), only the values.
Do NOT add explanation, markdown, or code fences — output raw JSON only.`;

        const payload = {};
        for (const id of EMAIL_TEMPLATE_IDS) payload[id] = EMAIL_TEMPLATE_DEFAULTS[id];

        const result = await llmClient.chat(modelId, [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(payload, null, 2) },
        ], { maxTokens: 2048, temperature: 0.3 });

        let responseText = (result.content || '').trim();
        responseText = responseText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
        const translated = JSON.parse(responseText);

        let count = 0;
        for (const id of EMAIL_TEMPLATE_IDS) {
            const t = translated[id];
            if (!t || typeof t !== 'object') continue;
            const fields = {};
            for (const f of EMAIL_TEMPLATE_FIELDS) {
                if (typeof t[f] === 'string' && t[f].trim()) fields[f] = t[f];
            }
            if (Object.keys(fields).length) {
                await languageStore.setEmailTemplate(locale, id, fields);
                count++;
            }
        }
        res.json({ success: true, translated: count, message: `Translated ${count} email template(s)` });
    } catch (err) {
        console.error('[Languages AI] Email translate error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── AI Translation ──────────────────────────────────────────────

// POST /admin/languages/:code/ai-translate — Use AI to auto-translate GUI strings
router.post('/:code/ai-translate', requireAdmin, async (req, res) => {
    const locale = req.params.code;
    const { modelTier = 'fast' } = req.body;

    if (locale === 'en') {
        return res.status(400).json({ error: 'Cannot AI-translate the base English locale' });
    }

    try {
        const llmClient = require('../../core/llmClient');
        const { resolveModelForTierName } = require('../../core/modelResolver');

        // ── Resolve model from tier (centralized, admin context — no EU override) ─────────
        const resolvedTier = modelTier || 'fast';
        let modelId;
        try {
            modelId = await resolveModelForTierName(resolvedTier, { fallback: 'mistral-small-latest' });
        } catch (_) {
            const { getAIConfig } = require('../../core/aiAgent');
            const config = await getAIConfig();
            modelId = config.model || 'mistral-small-latest';
        }

        console.log(`[Languages AI] Translating to ${locale} using model ${modelId} (tier: ${resolvedTier})`);

        // ── Gather untranslated keys ────────────────────────────────
        const existing = await languageStore.getGUITranslations(locale);
        const allKeys = Object.keys(GUI_DEFAULTS);
        const untranslated = allKeys.filter(key => !existing[key]);

        if (untranslated.length === 0) {
            return res.json({ success: true, translated: 0, total: allKeys.length, message: 'All keys are already translated' });
        }

        // ── Resolve locale name ─────────────────────────────────────
        const locales = await languageStore.getAvailableLocales();
        const localeInfo = locales.find(l => l.code === locale);
        const languageName = localeInfo?.name || locale;

        // ── Batch translate ─────────────────────────────────────────
        const BATCH_SIZE = 40;
        const batches = [];
        for (let i = 0; i < untranslated.length; i += BATCH_SIZE) {
            batches.push(untranslated.slice(i, i + BATCH_SIZE));
        }

        let translatedCount = 0;
        let errors = 0;
        const merged = { ...existing };

        const systemPrompt = `You are a professional translator. Translate the following English UI strings to ${languageName} (${locale}).
Return ONLY a valid JSON object mapping each key to its translated value.
Keep translations concise — these are UI labels, buttons, and short messages.
Preserve any placeholder tokens like {name}, {count}, etc.
Do NOT translate keys, only values.
For keys whose name contains "placeholder_" the value is an example shown as a form-field hint. Localize these examples to match the conventions of the target locale's primary country: phone numbers in local dialling format, addresses in local format, email domains, and tax/registration IDs (e.g. VAT/KVK) in the local equivalent. Keep company names that are proper nouns (e.g. "Bee Flow B.V.") unchanged.
Do NOT add any explanation, markdown formatting, or code fences — output raw JSON only.`;

        // Run all batches in parallel
        const batchResults = await Promise.allSettled(batches.map(async (batch, batchIdx) => {
            const batchObj = {};
            for (const key of batch) {
                batchObj[key] = GUI_DEFAULTS[key];
            }

            const result = await llmClient.chat(modelId, [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: JSON.stringify(batchObj, null, 2) },
            ], { maxTokens: 4096, temperature: 0.3 });

            // Parse the response — handle possible markdown code fences
            let responseText = (result.content || '').trim();
            responseText = responseText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

            const translations = JSON.parse(responseText);
            console.log(`[Languages AI] Batch ${batchIdx + 1}/${batches.length}: ${Object.keys(translations).length} translations`);
            return translations;
        }));

        // Merge all results
        for (const result of batchResults) {
            if (result.status === 'fulfilled') {
                for (const [key, value] of Object.entries(result.value)) {
                    if (typeof value === 'string' && value.trim() && GUI_DEFAULTS[key]) {
                        merged[key] = value;
                        translatedCount++;
                    }
                }
            } else {
                console.error(`[Languages AI] Batch failed:`, result.reason?.message);
                errors++;
            }
        }

        // ── Save merged translations ────────────────────────────────
        await languageStore.setGUITranslations(locale, merged);

        const totalKeys = allKeys.length;
        const totalTranslated = Object.keys(merged).length;

        console.log(`[Languages AI] Done: ${translatedCount} new translations for ${locale} (${errors} batch errors)`);

        res.json({
            success: true,
            translated: translatedCount,
            total: totalKeys,
            totalTranslated,
            progress: totalKeys > 0 ? Math.round((totalTranslated / totalKeys) * 100) : 0,
            errors,
            message: errors > 0
                ? `Translated ${translatedCount} strings with ${errors} batch error(s)`
                : `Successfully translated ${translatedCount} strings`,
        });
    } catch (err) {
        console.error('[Languages AI] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /admin/languages/:code/ai-translate-prompts — Use AI to auto-translate system prompts
router.post('/:code/ai-translate-prompts', requireAdmin, async (req, res) => {
    const locale = req.params.code;
    const { modelTier = 'fast', promptIds: requestedIds } = req.body;

    if (locale === 'en') {
        return res.status(400).json({ error: 'Cannot AI-translate the base English locale' });
    }

    try {
        const llmClient = require('../../core/llmClient');
        const { resolveModelForTierName } = require('../../core/modelResolver');

        // ── Resolve model ───────────────────────────────────────────
        const resolvedTier = modelTier || 'fast';
        let modelId;
        try {
            modelId = await resolveModelForTierName(resolvedTier, { fallback: 'mistral-small-latest' });
        } catch (_) {
            const { getAIConfig } = require('../../core/aiAgent');
            const config = await getAIConfig();
            modelId = config.model || 'mistral-small-latest';
        }

        console.log(`[Languages AI] Translating prompts to ${locale} using model ${modelId} (tier: ${resolvedTier})`);

        // ── Resolve locale name ─────────────────────────────────────
        const locales = await languageStore.getAvailableLocales();
        const localeInfo = locales.find(l => l.code === locale);
        const languageName = localeInfo?.name || locale;

        // ── Gather untranslated prompts ──────────────────────────────
        const existingTranslations = await languageStore.getAllPromptTranslations(locale);
        const defaults = await getAllDefaults();
        const idsToTranslate = (requestedIds || PROMPT_IDS).filter(id =>
            !existingTranslations[id] && defaults[id]
        );

        if (idsToTranslate.length === 0) {
            return res.json({ success: true, translated: 0, total: PROMPT_IDS.length, message: 'All prompts are already translated' });
        }

        // ── Translate each prompt individually (they are long-form) ──
        const systemPrompt = `You are a professional translator specializing in AI system prompts and technical documentation.
Translate the following system prompt from English to ${languageName} (${locale}).

RULES:
- Translate the ENTIRE prompt faithfully. Do not summarize or skip sections.
- Preserve ALL Markdown formatting (headings, lists, bold, code blocks, etc).
- Preserve placeholder tokens like {name}, {count}, {{variable}}, etc — do NOT translate these.
- Preserve technical terms, tool names, function names, and API references exactly as-is (e.g. "notebook_read", "json-research", "vega-lite").
- Keep code examples and JSON structures unchanged.
- Maintain the same tone and instruction style.
- Output ONLY the translated prompt text — no explanations, no wrapping, no code fences.`;

        let translatedCount = 0;
        let errors = 0;

        // Process prompts in parallel (max 3 concurrent to avoid rate limits)
        const CONCURRENCY = 3;
        for (let i = 0; i < idsToTranslate.length; i += CONCURRENCY) {
            const batch = idsToTranslate.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(batch.map(async (promptId) => {
                const defaultText = defaults[promptId];
                if (!defaultText || defaultText.trim().length < 10) return null; // Skip empty/tiny prompts

                const result = await llmClient.chat(modelId, [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: defaultText },
                ], { maxTokens: 8192, temperature: 0.3 });

                const translated = (result.content || '').trim();
                if (translated && translated.length > 20) {
                    await languageStore.setPromptTranslation(locale, promptId, translated);
                    console.log(`[Languages AI] Translated prompt "${promptId}" (${translated.length} chars)`);
                    return promptId;
                }
                return null;
            }));

            for (const result of results) {
                if (result.status === 'fulfilled' && result.value) {
                    translatedCount++;
                } else if (result.status === 'rejected') {
                    console.error(`[Languages AI] Prompt translation failed:`, result.reason?.message);
                    errors++;
                }
            }
        }

        // ── Clear prompt cache ──────────────────────────────────────
        const { clearDefaultsCache } = require('../../i18n/defaults/promptDefaults');
        clearDefaultsCache();

        const totalPrompts = PROMPT_IDS.filter(id => defaults[id]).length;
        const totalTranslated = Object.keys(existingTranslations).length + translatedCount;

        console.log(`[Languages AI] Prompt translation done: ${translatedCount} new for ${locale} (${errors} errors)`);

        res.json({
            success: true,
            translated: translatedCount,
            total: totalPrompts,
            totalTranslated,
            progress: totalPrompts > 0 ? Math.round((totalTranslated / totalPrompts) * 100) : 0,
            errors,
            message: errors > 0
                ? `Translated ${translatedCount} prompts with ${errors} error(s)`
                : `Successfully translated ${translatedCount} prompts`,
        });
    } catch (err) {
        console.error('[Languages AI] Prompt translation error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /admin/languages/:code/ai-translate-legal — Use AI to auto-translate legal documents
// Long-form, markdown-preserving (mirrors ai-translate-prompts). Re-translates any
// document whose stored translation is missing or built from an older version.
router.post('/:code/ai-translate-legal', requireAdmin, async (req, res) => {
    const locale = req.params.code;
    const { modelTier = 'fast', docIds: requestedIds } = req.body;

    if (locale === 'en') {
        return res.status(400).json({ error: 'Cannot AI-translate the base English locale' });
    }

    try {
        const llmClient = require('../../core/llmClient');
        const { resolveModelForTierName } = require('../../core/modelResolver');

        // ── Resolve model ───────────────────────────────────────────
        const resolvedTier = modelTier || 'fast';
        let modelId;
        try {
            modelId = await resolveModelForTierName(resolvedTier, { fallback: 'mistral-small-latest' });
        } catch (_) {
            const { getAIConfig } = require('../../core/aiAgent');
            const config = await getAIConfig();
            modelId = config.model || 'mistral-small-latest';
        }

        console.log(`[Languages AI] Translating legal docs to ${locale} using model ${modelId} (tier: ${resolvedTier})`);

        // ── Resolve locale name ─────────────────────────────────────
        const locales = await languageStore.getAvailableLocales();
        const localeInfo = locales.find(l => l.code === locale);
        const languageName = localeInfo?.name || locale;

        // ── Gather docs needing (re)translation (missing OR stale version) ──
        const idsToTranslate = [];
        for (const docId of (requestedIds || LEGAL_DOC_IDS)) {
            const meta = getLegalDefault(docId);
            if (!meta || !meta.markdown) continue;
            const stored = await languageStore.getLegalDocTranslation(locale, docId);
            if (!stored || !stored.markdown || Number(stored.version) !== Number(meta.version)) {
                idsToTranslate.push(docId);
            }
        }

        if (idsToTranslate.length === 0) {
            return res.json({ success: true, translated: 0, total: LEGAL_DOC_IDS.length, message: 'All legal documents are already translated for the current version' });
        }

        // ── Translate each document individually (long-form, markdown) ──
        const systemPrompt = `You are a professional legal translator. Translate the following legal document from English to ${languageName} (${locale}).

RULES:
- Translate the ENTIRE document faithfully and precisely. Do not summarize, omit, reorder, or add anything.
- Preserve ALL Markdown formatting exactly (headings, numbered sections, lists, tables, bold, blockquotes, links).
- Keep legal and statutory citations EXACTLY as written, untranslated (e.g. "BW art. 6:233", "GDPR Art. 28", "Article 50 of the EU AI Act", "Regulation (EU) 2024/1689", "§5 DDG", "Commission Implementing Decision (EU) 2021/914").
- Keep proper nouns, company names, product names, registration identifiers and contact details unchanged (e.g. "Bee Flow B.V.", "KvK 97632430", "NL868147011B01", "info@beeflow.nl", "Scaleway", "Anthropic", "OpenAI", "Stripe", "Mistral").
- Keep all URLs and Markdown link targets unchanged.
- Preserve placeholder tokens like {name}, {{variable}}.
- This is a convenience translation; the English version remains the legally authoritative text. Where the document states that the English version prevails, translate that statement faithfully — do not weaken it.
- Output ONLY the translated Markdown — no explanations, no commentary, no code fences.`;

        let translatedCount = 0;
        let errors = 0;

        const CONCURRENCY = 3;
        for (let i = 0; i < idsToTranslate.length; i += CONCURRENCY) {
            const batch = idsToTranslate.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(batch.map(async (docId) => {
                const meta = getLegalDefault(docId);
                const defaultText = meta.markdown;
                if (!defaultText || defaultText.trim().length < 10) return null;

                const result = await llmClient.chat(modelId, [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: defaultText },
                ], { maxTokens: 16384, temperature: 0.2 });

                const translated = (result.content || '').trim();
                if (translated && translated.length > 20) {
                    await languageStore.setLegalDoc(locale, docId, translated, meta.version);
                    console.log(`[Languages AI] Translated legal doc "${docId}" → ${locale} (${translated.length} chars)`);
                    return docId;
                }
                return null;
            }));

            for (const result of results) {
                if (result.status === 'fulfilled' && result.value) {
                    translatedCount++;
                } else if (result.status === 'rejected') {
                    console.error(`[Languages AI] Legal doc translation failed:`, result.reason?.message);
                    errors++;
                }
            }
        }

        console.log(`[Languages AI] Legal translation done: ${translatedCount} new/updated for ${locale} (${errors} errors)`);

        res.json({
            success: true,
            translated: translatedCount,
            total: LEGAL_DOC_IDS.length,
            errors,
            message: errors > 0
                ? `Translated ${translatedCount} documents with ${errors} error(s)`
                : `Successfully translated ${translatedCount} documents`,
        });
    } catch (err) {
        console.error('[Languages AI] Legal translation error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Prompt Translations ─────────────────────────────────────────

// GET /admin/languages/defaults/prompts — Get all default prompt texts
router.get('/defaults/prompts', requireAdmin, async (req, res) => {
    try {
        const defaults = await getAllDefaults();
        res.json({
            defaults,
            labels: PROMPT_LABELS,
            categories: PROMPT_CATEGORIES,
            promptIds: PROMPT_IDS,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /admin/languages/:code/prompts — Get all prompt translations for a locale
router.get('/:code/prompts', requireAdmin, async (req, res) => {
    try {
        const translations = await languageStore.getAllPromptTranslations(req.params.code);
        const defaults = await getAllDefaults();

        res.json({
            translations,
            defaults,
            labels: PROMPT_LABELS,
            categories: PROMPT_CATEGORIES,
            promptIds: PROMPT_IDS,
            stats: {
                total: PROMPT_IDS.length,
                translated: Object.keys(translations).length,
                missing: PROMPT_IDS.length - Object.keys(translations).length,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /admin/languages/:code/prompts/:promptId — Get a single prompt translation
router.get('/:code/prompts/:promptId', requireAdmin, async (req, res) => {
    try {
        const { code, promptId } = req.params;
        const translation = await languageStore.getPromptTranslation(code, promptId);
        const { getDefaultPrompt } = require('../../i18n/defaults/promptDefaults');
        const defaultText = await getDefaultPrompt(promptId);

        res.json({
            promptId,
            label: PROMPT_LABELS[promptId] || promptId,
            translation: translation || '',
            default: defaultText || '',
            hasTranslation: !!translation,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /admin/languages/:code/prompts/:promptId — Save a single prompt translation
router.put('/:code/prompts/:promptId', requireAdmin, async (req, res) => {
    try {
        const { code, promptId } = req.params;
        const { text } = req.body;

        if (!PROMPT_IDS.includes(promptId)) {
            return res.status(400).json({ error: `Unknown prompt ID: ${promptId}` });
        }

        if (text === '' || text === null || text === undefined) {
            // Empty = remove translation (fall back to default)
            const configStore = require('../../stores/configStore');
            await configStore.deleteConfig(`i18n_prompt_${code}_${promptId}`);
        } else {
            await languageStore.setPromptTranslation(code, promptId, text);
        }

        // Clear prompt cache so changes take effect immediately
        const { clearDefaultsCache } = require('../../i18n/defaults/promptDefaults');
        clearDefaultsCache();

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Legal Document Translations ─────────────────────────────────

// GET /admin/languages/:code/legal — List legal docs + translation status for a locale
router.get('/:code/legal', requireAdmin, async (req, res) => {
    try {
        const docs = await languageStore.listLegalDocs(req.params.code);
        res.json({
            docs,
            stats: {
                total: docs.length,
                translated: docs.filter(d => d.hasTranslation && !d.stale).length,
                stale: docs.filter(d => d.stale).length,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /admin/languages/:code/legal/:docId — Get a single legal doc translation + default
router.get('/:code/legal/:docId', requireAdmin, async (req, res) => {
    try {
        const { code, docId } = req.params;
        if (!LEGAL_DOC_IDS.includes(docId)) {
            return res.status(404).json({ error: `Unknown legal document: ${docId}` });
        }
        const meta = getLegalDefault(docId);
        const stored = await languageStore.getLegalDocTranslation(code, docId);
        res.json({
            docId,
            title: meta.title,
            version: meta.version,
            default: meta.markdown || '',
            translation: stored?.markdown || '',
            translationVersion: stored?.version ?? null,
            hasTranslation: !!(stored && stored.markdown),
            stale: !!(stored && stored.markdown && Number(stored.version) !== Number(meta.version)),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /admin/languages/:code/legal/:docId — Save/override or clear a legal doc translation
router.put('/:code/legal/:docId', requireAdmin, async (req, res) => {
    try {
        const { code, docId } = req.params;
        const { text } = req.body;

        if (!LEGAL_DOC_IDS.includes(docId)) {
            return res.status(400).json({ error: `Unknown legal document: ${docId}` });
        }

        if (text === '' || text === null || text === undefined) {
            // Empty = remove the override (fall back to English).
            const configStore = require('../../stores/configStore');
            await configStore.deleteConfig(`i18n_legal_${code}_${docId}`);
        } else {
            const meta = getLegalDefault(docId);
            await languageStore.setLegalDoc(code, docId, text, meta.version);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Import / Export ─────────────────────────────────────────────

// GET /admin/languages/:code/export — Export locale as JSON
router.get('/:code/export', requireAdmin, async (req, res) => {
    try {
        const data = await languageStore.exportLocale(req.params.code);
        res.setHeader('Content-Disposition', `attachment; filename="beeflow-i18n-${req.params.code}.json"`);
        res.setHeader('Content-Type', 'application/json');
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /admin/languages/:code/import — Import locale from JSON
router.post('/:code/import', requireAdmin, async (req, res) => {
    try {
        const data = req.body;
        if (!data || typeof data !== 'object') {
            return res.status(400).json({ error: 'Invalid import data' });
        }
        const result = await languageStore.importLocale(req.params.code, data);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════════
// ORG ADMIN ROUTES (require org admin or platform admin)
// ══════════════════════════════════════════════════════════════════

function requireOrgAdmin(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
    // Platform admin can always manage
    if (req.session.isAdmin || req.session.user?.role === 'admin') return next();
    // Org admin check
    const perms = req.session.user?.permissions || [];
    const orgRole = req.session.user?.orgRole;
    if (perms.includes('all') || perms.includes('org_admin') || perms.some(p => p.startsWith('admin_')) ||
        orgRole === 'admin' || orgRole === 'org_admin') {
        return next();
    }
    res.status(403).json({ error: 'Organisation admin access required' });
}

// GET /api/languages/org/default — Get the org default locale for new users
router.get('/org/default', requireOrgAdmin, async (req, res) => {
    try {
        const configStore = require('../../stores/configStore');
        const defaultLocale = await configStore.getConfig('org_default_locale') || 'en';
        const locales = await languageStore.getAvailableLocales();
        res.json({ defaultLocale, locales });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/languages/org/default — Set the org default locale for new users
router.put('/org/default', requireOrgAdmin, async (req, res) => {
    try {
        const { defaultLocale } = req.body;
        if (!defaultLocale || typeof defaultLocale !== 'string') {
            return res.status(400).json({ error: 'defaultLocale is required' });
        }
        // Validate that the locale exists
        const locales = await languageStore.getAvailableLocales();
        if (!locales.find(l => l.code === defaultLocale)) {
            return res.status(400).json({ error: `Locale '${defaultLocale}' is not available` });
        }
        const configStore = require('../../stores/configStore');
        await configStore.setConfig('org_default_locale', defaultLocale);
        console.log(`[Languages] Org default locale set to: ${defaultLocale}`);
        res.json({ success: true, defaultLocale });
    } catch (err) {
        console.error('[Languages] Set org default error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════════
// USER-FACING ROUTES (require only auth)
// ══════════════════════════════════════════════════════════════════

// GET /api/languages/user/locales — Get available locales for language picker
router.get('/user/locales', requireAuth, async (req, res) => {
    try {
        const locales = await languageStore.getAvailableLocales();
        // Include org default locale info so the frontend can use it for new users
        const configStore = require('../../stores/configStore');
        const defaultLocale = await configStore.getConfig('org_default_locale') || null;
        // Attach default info to the response — the frontend already expects an array,
        // so we annotate each locale with isOrgDefault
        const withDefaults = locales.map(l => ({
            ...l,
            isOrgDefault: l.code === defaultLocale,
        }));
        res.json(withDefaults);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/languages/user/strings/:locale — Get effective GUI strings for a locale
router.get('/user/strings/:locale', requireAuth, async (req, res) => {
    try {
        const strings = await languageStore.getEffectiveGUIStrings(req.params.locale);
        res.json(strings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Public (no-auth) endpoints for pre-login language detection ───

// GET /api/languages/public/locales — List available locales without auth
// Used by login page language picker
router.get('/public/locales', async (req, res) => {
    try {
        const locales = await languageStore.getAvailableLocales();
        res.set('Cache-Control', 'public, max-age=600');
        res.json(locales.map(l => ({ code: l.code, name: l.name })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/languages/public/strings/:locale — Get effective GUI strings without auth
// Used by the login page to serve translations before user authenticates
router.get('/public/strings/:locale', async (req, res) => {
    try {
        const locale = req.params.locale;
        // Only serve locales that are actually configured
        const locales = await languageStore.getAvailableLocales();
        if (!locales.find(l => l.code === locale)) {
            return res.status(404).json({ error: 'Locale not available' });
        }
        const strings = await languageStore.getEffectiveGUIStrings(locale);
        res.set('Cache-Control', 'public, max-age=600');
        res.json(strings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/languages/public/legal/:docId/:locale — Localized legal document, no auth
// Used by the public legal pages and the pre-auth signup/consent screen (and the
// links on the OAuth consent screen). Falls back to authoritative English when the
// locale isn't configured or no current-version translation exists.
router.get('/public/legal/:docId/:locale', async (req, res) => {
    try {
        const { docId } = req.params;
        let locale = req.params.locale;
        if (!LEGAL_DOC_IDS.includes(docId)) {
            return res.status(404).json({ error: 'Unknown legal document' });
        }
        // Fall back to English rather than 404 when the locale isn't configured,
        // so a not-yet-translated locale still renders the document.
        const locales = await languageStore.getAvailableLocales();
        if (!locales.find(l => l.code === locale)) locale = 'en';

        const doc = await languageStore.getEffectiveLegalDoc(docId, locale);
        if (!doc) return res.status(404).json({ error: 'Unknown legal document' });

        res.set('Cache-Control', 'public, max-age=600');
        res.json(doc);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
