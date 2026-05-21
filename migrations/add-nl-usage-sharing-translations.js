#!/usr/bin/env node
/**
 * One-time migration: Add Dutch translations for the AI-usage sharing
 * toggle, the Change-plan picker, and the customer-view monitoring
 * breakdowns.
 *
 * Usage:  node server/migrations/add-nl-usage-sharing-translations.js
 *
 * Merges into the existing i18n_gui_nl config without overwriting
 * any translations that already exist.
 */

const NL_TRANSLATIONS = {
    // ── Organisatie-info: AI usage sharing toggle ──────────────
    'org.share_usage': 'AI-verbruik delen',
    'org.share_usage_desc': 'Kies of je team één AI-budget deelt, of dat elke gebruiker zijn eigen deel krijgt.',
    'org.share_usage_label': 'AI-verbruik delen binnen de organisatie',
    'org.share_usage_explainer': 'Aan: alle gebruikers delen het kostenbudget van het abonnement. Uit: het budget wordt gelijk verdeeld over actieve gebruikers — iedereen krijgt zijn eigen deel voor deze periode.',
    'org.share_usage_on': 'Gedeeld binnen de organisatie',
    'org.share_usage_off': 'Elke gebruiker heeft een eigen budget',

    // ── License & Usage: Change plan picker ─────────────────────
    'org.change_plan': 'Plan wijzigen',
    'org.change_plan_close': 'Sluiten',
    'org.change_plan_hint': 'Een planwijziging is direct van kracht. Stripe verrekent het verschil pro rata op je volgende factuur.',
    'org.switch_to': 'Overschakelen',

    // ── Gebruik & Monitoring: customer-view breakdowns ─────────
    'usage.top_users_by_cost': 'Topgebruikers op kosten',
    'usage.by_app_area': 'Per app-gebied',
    'usage.no_usage_recorded': 'Nog geen verbruik geregistreerd',
};

async function run() {
    const languageStore = require('../stores/languageStore');

    console.log('Loading existing Dutch GUI translations...');
    const existing = await languageStore.getGUITranslations('nl');
    const existingCount = Object.keys(existing).length;
    console.log(`  Found ${existingCount} existing NL translations`);

    let added = 0;
    const merged = { ...existing };
    for (const [key, value] of Object.entries(NL_TRANSLATIONS)) {
        if (!merged[key]) {
            merged[key] = value;
            added++;
        }
    }

    if (added === 0) {
        console.log('All translations already exist. Nothing to do.');
        process.exit(0);
    }

    console.log(`Adding ${added} new Dutch translations (keeping ${existingCount} existing)...`);
    await languageStore.setGUITranslations('nl', merged);
    console.log(`✓ Done! Total NL translations: ${Object.keys(merged).length}`);
    process.exit(0);
}

run().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
