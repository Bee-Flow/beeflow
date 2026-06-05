/**
 * Language Store - Manages i18n locales, GUI translations, and prompt translations
 * 
 * Uses the existing configStore for persistence in the PostgreSQL config table.
 * 
 * Storage keys:
 *   i18n_locales                         → [{code, name, isDefault}]
 *   i18n_gui_{locale}                    → {key: "translated string", ...}
 *   i18n_prompt_{locale}_{promptId}      → "full prompt text"
 */

const configStore = require('./configStore');

// ── Default locale list (seeded on first access) ────────────────

// Seed the four baseline locales so the Preferences "Interface Language" row
// (gated on locales.length > 1) is visible out of the box. Untranslated locales
// degrade gracefully — useTranslation falls back to English per key (BFSF-200).
const DEFAULT_LOCALES = [
    { code: 'en', name: 'English', isDefault: true },
    { code: 'nl', name: 'Nederlands' },
    { code: 'de', name: 'Deutsch' },
    { code: 'fr', name: 'Français' },
];

// ── Common locale catalog for the "Add Language" dropdown ───────

const AVAILABLE_LOCALE_CATALOG = [
    { code: 'en', name: 'English' },
    { code: 'nl', name: 'Nederlands' },
    { code: 'de', name: 'Deutsch' },
    { code: 'fr', name: 'Français' },
    { code: 'es', name: 'Español' },
    { code: 'pt', name: 'Português' },
    { code: 'it', name: 'Italiano' },
    { code: 'ja', name: '日本語' },
    { code: 'zh', name: '中文' },
    { code: 'ko', name: '한국어' },
    { code: 'ar', name: 'العربية' },
    { code: 'ru', name: 'Русский' },
    { code: 'pl', name: 'Polski' },
    { code: 'tr', name: 'Türkçe' },
    { code: 'sv', name: 'Svenska' },
    { code: 'da', name: 'Dansk' },
    { code: 'fi', name: 'Suomi' },
    { code: 'nb', name: 'Norsk Bokmål' },
    { code: 'uk', name: 'Українська' },
    { code: 'cs', name: 'Čeština' },
    { code: 'ro', name: 'Română' },
    { code: 'hu', name: 'Magyar' },
    { code: 'el', name: 'Ελληνικά' },
    { code: 'he', name: 'עברית' },
    { code: 'th', name: 'ไทย' },
    { code: 'vi', name: 'Tiếng Việt' },
    { code: 'id', name: 'Bahasa Indonesia' },
    { code: 'ms', name: 'Bahasa Melayu' },
    { code: 'hi', name: 'हिन्दी' },
];

// ── Locale Management ───────────────────────────────────────────

/**
 * Get all configured locales. Seeds default if none exist.
 */
async function getAvailableLocales() {
    let locales = await configStore.getConfig('i18n_locales');
    if (!locales || !Array.isArray(locales) || locales.length === 0) {
        await configStore.setConfig('i18n_locales', DEFAULT_LOCALES);
        return DEFAULT_LOCALES;
    }
    // Non-destructive merge for existing deployments seeded with English-only:
    // ensure the baseline locales (en/nl/de/fr) are always present so the
    // language selector becomes visible, without removing/overriding any
    // admin-added locale or the chosen default (BFSF-200). Idempotent.
    const have = new Set(locales.map(l => l && l.code));
    const missing = DEFAULT_LOCALES
        .filter(l => !have.has(l.code))
        .map(l => ({ code: l.code, name: l.name }));  // drop isDefault — never introduce a 2nd default
    if (missing.length) {
        locales = [...locales, ...missing];
        await configStore.setConfig('i18n_locales', locales);
    }
    return locales;
}

/**
 * Save the full locale list.
 */
async function setAvailableLocales(locales) {
    await configStore.setConfig('i18n_locales', locales);
}

/**
 * Add a new locale. Returns updated list or throws if already exists.
 */
async function addLocale(code, name) {
    const locales = await getAvailableLocales();
    if (locales.find(l => l.code === code)) {
        throw new Error(`Locale '${code}' already exists`);
    }
    locales.push({ code, name, isDefault: false });
    await setAvailableLocales(locales);
    return locales;
}

/**
 * Delete a locale and all its translations.
 */
async function deleteLocale(code) {
    if (code === 'en') throw new Error('Cannot delete the English (en) default locale');

    const locales = await getAvailableLocales();
    const filtered = locales.filter(l => l.code !== code);
    if (filtered.length === locales.length) {
        throw new Error(`Locale '${code}' not found`);
    }
    await setAvailableLocales(filtered);

    // Delete GUI translations
    await configStore.deleteConfig(`i18n_gui_${code}`);

    // Delete all prompt translations for this locale
    // We store prompt translations with keys like i18n_prompt_{locale}_{promptId}
    // Since configStore doesn't have a prefix-delete, we list known prompt IDs
    const { PROMPT_IDS } = require('../i18n/defaults/promptDefaults');
    for (const promptId of PROMPT_IDS) {
        await configStore.deleteConfig(`i18n_prompt_${code}_${promptId}`);
    }

    return filtered;
}

/**
 * Set the default locale.
 */
async function setDefaultLocale(code) {
    const locales = await getAvailableLocales();
    const updated = locales.map(l => ({ ...l, isDefault: l.code === code }));
    if (!updated.find(l => l.isDefault)) {
        throw new Error(`Locale '${code}' not found`);
    }
    await setAvailableLocales(updated);
    return updated;
}

// ── GUI Translations ────────────────────────────────────────────

/**
 * Get GUI translations for a locale (raw, no fallback).
 */
async function getGUITranslations(locale) {
    return await configStore.getConfig(`i18n_gui_${locale}`) || {};
}

/**
 * Save GUI translations for a locale (full replace).
 */
async function setGUITranslations(locale, translations) {
    await configStore.setConfig(`i18n_gui_${locale}`, translations);
}

/**
 * Get effective GUI strings for a locale, merged with English defaults.
 * Missing keys fall back to the English value.
 */
async function getEffectiveGUIStrings(locale) {
    const { GUI_DEFAULTS } = require('../i18n/defaults/en');
    if (locale === 'en') return GUI_DEFAULTS;

    const overrides = await getGUITranslations(locale);
    return { ...GUI_DEFAULTS, ...overrides };
}

// ── Prompt Translations ─────────────────────────────────────────

/**
 * Get a single prompt translation for a locale (raw, no fallback).
 */
async function getPromptTranslation(locale, promptId) {
    return await configStore.getConfig(`i18n_prompt_${locale}_${promptId}`) || null;
}

/**
 * Save a single prompt translation for a locale.
 */
async function setPromptTranslation(locale, promptId, text) {
    await configStore.setConfig(`i18n_prompt_${locale}_${promptId}`, text);
}

/**
 * Get all prompt translations for a locale.
 * Returns { promptId: "text", ... } for all prompts that have translations.
 */
async function getAllPromptTranslations(locale) {
    const { PROMPT_IDS } = require('../i18n/defaults/promptDefaults');
    const result = {};
    for (const promptId of PROMPT_IDS) {
        const text = await getPromptTranslation(locale, promptId);
        if (text) result[promptId] = text;
    }
    return result;
}

/**
 * Get the effective prompt for an agent, resolving locale fallback.
 * Returns locale-specific prompt if available, otherwise the English default.
 */
async function getEffectivePrompt(promptId, locale) {
    if (locale && locale !== 'en') {
        const override = await getPromptTranslation(locale, promptId);
        if (override) return override;
    }
    // Fall back to English default
    const { getDefaultPrompt } = require('../i18n/defaults/promptDefaults');
    return getDefaultPrompt(promptId);
}

// ── Import / Export ─────────────────────────────────────────────

/**
 * Export a complete locale as a JSON bundle.
 */
async function exportLocale(locale) {
    const gui = await getGUITranslations(locale);
    const prompts = await getAllPromptTranslations(locale);
    const locales = await getAvailableLocales();
    const localeInfo = locales.find(l => l.code === locale);

    return {
        locale: locale,
        name: localeInfo?.name || locale,
        exportedAt: new Date().toISOString(),
        gui,
        prompts
    };
}

/**
 * Import a locale from a JSON bundle.
 * Creates the locale if it doesn't exist.
 */
async function importLocale(locale, data) {
    // Ensure locale exists
    const locales = await getAvailableLocales();
    if (!locales.find(l => l.code === locale)) {
        const name = data.name || locale;
        locales.push({ code: locale, name, isDefault: false });
        await setAvailableLocales(locales);
    }

    // Import GUI translations
    if (data.gui && typeof data.gui === 'object') {
        await setGUITranslations(locale, data.gui);
    }

    // Import prompt translations
    if (data.prompts && typeof data.prompts === 'object') {
        for (const [promptId, text] of Object.entries(data.prompts)) {
            if (typeof text === 'string' && text.trim()) {
                await setPromptTranslation(locale, promptId, text);
            }
        }
    }

    return { imported: true, locale };
}

// ── Module Exports ──────────────────────────────────────────────

module.exports = {
    AVAILABLE_LOCALE_CATALOG,
    // Locale management
    getAvailableLocales,
    setAvailableLocales,
    addLocale,
    deleteLocale,
    setDefaultLocale,
    // GUI translations
    getGUITranslations,
    setGUITranslations,
    getEffectiveGUIStrings,
    // Prompt translations
    getPromptTranslation,
    setPromptTranslation,
    getAllPromptTranslations,
    getEffectivePrompt,
    // Import/export
    exportLocale,
    importLocale,
};
