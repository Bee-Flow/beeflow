#!/usr/bin/env node
/**
 * Migration: Dutch translations for the new KB "usage contexts" UI keys.
 *
 * Adds NL strings for the checkboxes that let a user pick where a KB is
 * available (Agents / Direct chat / Webpages). Without this migration,
 * users on a non-English locale would see raw keys like
 * "kb_detail.usage_label" because the DB has no NL override yet — the
 * client only falls back to the English default when its bundle is up to
 * date AND the key happens to live in `agent-hub/src/i18n/en-defaults.js`.
 *
 * Idempotent — only inserts keys that don't already have a NL value, and
 * is safe to re-run.
 *
 * Auto-runs from `stores/knowledgeBases.js initDB()`. Manual usage:
 *   node server/migrations/add-nl-kb-usage-translations.js
 */

const NL_TRANSLATIONS = {
    'kb_detail.usage_label': 'Gebruik deze kennisbank in',
    'kb_detail.usage_agents': 'Agents',
    'kb_detail.usage_agents_hint': 'Beschikbaar in de KB-kiezer van de Agent Designer',
    'kb_detail.usage_direct_chat': 'Directe chat',
    'kb_detail.usage_direct_chat_hint': 'Selecteerbaar vanuit de KB-kiezer in het chatvenster',
    'kb_detail.usage_webpages': 'Webpagina\'s',
    'kb_detail.usage_webpages_hint': 'Te koppelen aan een webpagina als kennisbron',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    const existing = await languageStore.getGUITranslations('nl');
    let added = 0;
    const merged = { ...existing };
    for (const [key, value] of Object.entries(NL_TRANSLATIONS)) {
        if (!merged[key]) {
            merged[key] = value;
            added++;
        }
    }
    if (added > 0) {
        await languageStore.setGUITranslations('nl', merged);
        console.log(`[Migration] add-nl-kb-usage-translations applied (+${added} keys)`);
    }
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
