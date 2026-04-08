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

module.exports = router;
