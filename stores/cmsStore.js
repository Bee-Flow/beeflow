/**
 * CMS Store — persistence for the public product website CMS.
 *
 * Storage keys (all in the existing `config` table via configStore):
 *   cms_enabled              → boolean — master toggle (default: false)
 *   cms_default_locale       → string  — fallback locale (default: 'en')
 *   cms_content_{locale}     → object  — content tree for that locale
 */

const configStore = require('./configStore');
const { getAll } = require('../db');
const { CMS_DEFAULTS, SECTION_ORDER } = require('../i18n/defaults/cmsDefaults');

const KEY_ENABLED = 'cms_enabled';
const KEY_DEFAULT_LOCALE = 'cms_default_locale';
const KEY_CONTENT_PREFIX = 'cms_content_';

// ── Toggle / settings ───────────────────────────────────────────

async function getEnabled() {
    const v = await configStore.getConfig(KEY_ENABLED);
    return v === true;
}

async function setEnabled(enabled) {
    await configStore.setConfig(KEY_ENABLED, !!enabled);
}

async function getDefaultLocale() {
    const v = await configStore.getConfig(KEY_DEFAULT_LOCALE);
    return (typeof v === 'string' && v) ? v : 'en';
}

async function setDefaultLocale(locale) {
    if (!locale || typeof locale !== 'string') throw new Error('Locale required');
    await configStore.setConfig(KEY_DEFAULT_LOCALE, locale);
}

// ── Content per locale ──────────────────────────────────────────

async function getContentRaw(locale) {
    const v = await configStore.getConfig(`${KEY_CONTENT_PREFIX}${locale}`);
    return (v && typeof v === 'object') ? v : null;
}

async function setContent(locale, content) {
    if (!locale || typeof locale !== 'string') throw new Error('Locale required');
    if (!content || typeof content !== 'object') throw new Error('Content must be an object');
    // Only persist keys that exist in the schema — drop unknown sections.
    const sanitized = {};
    for (const section of SECTION_ORDER) {
        if (content[section] && typeof content[section] === 'object') {
            sanitized[section] = content[section];
        }
    }
    await configStore.setConfig(`${KEY_CONTENT_PREFIX}${locale}`, sanitized);
}

async function deleteContent(locale) {
    await configStore.deleteConfig(`${KEY_CONTENT_PREFIX}${locale}`);
}

/**
 * List locales that have any stored content.
 * Reads directly from the config table to find cms_content_* keys.
 */
async function listLocalesWithContent() {
    const rows = await getAll(
        `SELECT key FROM config WHERE key LIKE $1`,
        [`${KEY_CONTENT_PREFIX}%`]
    );
    return rows.map(r => r.key.substring(KEY_CONTENT_PREFIX.length)).sort();
}

// ── Effective content (deep-merged) ─────────────────────────────

/**
 * Recursively merge `override` onto `base`. Arrays from override fully replace
 * the base array (no per-index merge — too brittle for editorial content).
 * Plain objects are merged key-by-key. Primitives from override win when
 * truthy or explicitly false; null/undefined keep the base value.
 */
function deepMerge(base, override) {
    if (override === undefined || override === null) return base;
    if (Array.isArray(override)) return override;
    if (typeof override !== 'object') return override;
    if (typeof base !== 'object' || base === null || Array.isArray(base)) {
        return { ...override };
    }
    const out = { ...base };
    for (const [k, v] of Object.entries(override)) {
        out[k] = deepMerge(base[k], v);
    }
    return out;
}

/**
 * Compute the content the public site should render for a given locale.
 * Layered fallback: CMS_DEFAULTS  ←  default-locale stored content
 *                                ←  requested-locale stored content.
 */
async function getEffectiveContent(locale) {
    const defaultLocale = await getDefaultLocale();
    const layers = [CMS_DEFAULTS];

    if (defaultLocale) {
        const defaultContent = await getContentRaw(defaultLocale);
        if (defaultContent) layers.push(defaultContent);
    }
    if (locale && locale !== defaultLocale) {
        const localeContent = await getContentRaw(locale);
        if (localeContent) layers.push(localeContent);
    }

    return layers.reduce((acc, layer) => deepMerge(acc, layer), {});
}

module.exports = {
    getEnabled,
    setEnabled,
    getDefaultLocale,
    setDefaultLocale,
    getContentRaw,
    setContent,
    deleteContent,
    listLocalesWithContent,
    getEffectiveContent,
    SECTION_ORDER,
    CMS_DEFAULTS,
};
