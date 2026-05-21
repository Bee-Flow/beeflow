#!/usr/bin/env node
/**
 * One-time migration: Add Dutch translations for the subscription /
 * License & Usage page keys introduced with the cloud Subscription card,
 * cost-cap display, and customer-facing usage hero.
 *
 * Usage:  node server/migrations/add-nl-subscription-translations.js
 *
 * Merges into the existing i18n_gui_nl config without overwriting
 * any translations that already exist.
 */

const NL_TRANSLATIONS = {
    // ── License & Usage page (cloud org admin view) ─────────────
    'org.ai_usage_this_period': 'AI-verbruik deze periode',
    'org.ai_usage_vs_cap': 'AI-verbruik t.o.v. limiet',
    'org.subscription': 'Abonnement',
    'org.billed_per_cycle': 'Gefactureerd per cyclus',
    'org.per_seat': '/ seat',
    'org.seat': 'seat',
    'org.seats': 'seats',
    'org.month': 'maand',
    'org.year': 'jaar',
    'org.no_plans_configured': 'Er zijn momenteel geen abonnementen beschikbaar.',
    'org.contact_for_plan': 'Neem contact op met',
    'org.to_get_started': 'om te beginnen.',
    'org.choose_plan': 'Kies een abonnement',
    'org.subscribe': 'Abonneren',
    'org.manage_billing': 'Facturatie beheren',
    'org.active_users': 'Actieve gebruikers',
    'org.cost_trend': 'Kostenontwikkeling',

    // ── Pre-existing org.* used on the License page (kept here so
    //    a fresh install gets the proper Dutch on first boot too) ─
    'org.license_usage': 'Licentie & Gebruik',
    'org.license_subtitle': 'Uw huidige abonnement en gebruik voor deze factureringsperiode',
    'org.no_license': 'Geen licentie toegewezen',
    'org.no_license_desc': 'Neem contact op met de beheerder om een abonnement in te stellen voor uw organisatie.',
    'org.billing_started': 'Factureringscyclus gestart op {date}',
    'org.cost_cap_month': 'kostenlimiet / maand',
    'org.cost': 'Kosten',
    'org.usage_this_period': 'Gebruik deze periode',
    'org.plan_limits': 'Abonnementslimieten',
    'org.users': 'Gebruikers',
    'org.agents': 'Agenten',
    'org.knowledge_sources': 'Kennisbronnen',
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
