#!/usr/bin/env node
/**
 * One-time migration: Add Dutch translations for newly i18n'd settings,
 * integration, agent store, and organisation keys.
 * 
 * Usage:  node server/migrations/add-nl-settings-translations.js
 * 
 * This merges into the existing i18n_gui_nl config without overwriting
 * any translations that already exist.
 */

const NL_TRANSLATIONS = {
    // ── Settings sections ───────────────────────────────────────
    'settings.startup_section': 'Opstarten',
    'settings.language_section': 'Taal',
    'settings.interface_language': 'Interfacetaal',
    'settings.interface_language_desc': 'Kies de taal voor de BeeFlow-interface',
    'settings.privacy_section': 'Privacy',
    'settings.eu_only_models': 'Alleen EU-modellen',
    'settings.eu_only_models_org_forced': 'Je organisatie vereist EU-conforme AI-modellen voor alle verzoeken.',
    'settings.eu_only_models_desc': 'Stuur alle AI-verzoeken via EU-gehoste modellen voor gegevensbescherming.',
    'settings.enforced_by_org': 'Opgelegd door organisatie',
    'settings.session_section': 'Sessie',
    'settings.select_agent_label': 'Agent selecteren',
    'settings.click_avatar_hint': 'Klik op avatar om foto of emoji te wijzigen',

    // ── Chat History ────────────────────────────────────────────
    'settings.chat_history': 'Chatgeschiedenis',
    'settings.chat_history_desc': 'Kies hoe gesprekken in de zijbalk worden weergegeven',
    'settings.chat_history_per_agent': 'Per Agent',
    'settings.chat_history_per_agent_desc': 'Toon alleen gesprekken voor de actieve agent',
    'settings.chat_history_all_chats': 'Alle Chats',
    'settings.chat_history_all_chats_desc': 'Toon alle gesprekken in één gecombineerde tijdlijn',

    // ── Integration categories ──────────────────────────────────
    'settings.integrations_productivity': 'Productiviteit',
    'settings.integrations_social': 'Sociaal',
    'settings.integrations_developer': 'Ontwikkelaar',
    'settings.integrations_org_tools': 'Organisatietools',
    'settings.disconnect': 'Ontkoppelen',
    'settings.save': 'Opslaan',
    'settings.connected': 'Verbonden',
    'settings.github_sync': 'GitHub Sync',

    // ── Integration descriptions ────────────────────────────────
    'integ.fireflies_connected': 'AI kan je vergadernotities doorzoeken',
    'integ.fireflies_desc': 'Verbind om vergadernotities te doorzoeken en samen te vatten',
    'integ.youtrack_connected': 'AI kan je issues doorzoeken en beheren',
    'integ.youtrack_desc': 'Verbind om issues te doorzoeken, aan te maken en te beheren',
    'integ.signrequest_connected': 'Verstuur documenten ter ondertekening vanuit Notitieboeken',
    'integ.signrequest_desc': 'Verbind om documenten ter ondertekening te versturen',
    'integ.gamma_connected': 'AI kan presentaties genereren',
    'integ.gamma_desc': 'Verbind om presentaties en webpagina\'s te genereren',
    'integ.linkedin_connected': 'AI kan posten op LinkedIn',
    'integ.linkedin_connected_as': 'Verbonden als {name} — AI kan posten op LinkedIn',
    'integ.linkedin_desc': 'Verbind om via AI op LinkedIn te posten',
    'integ.linkedin_not_configured': 'LinkedIn is niet geconfigureerd. Vraag je beheerder om het in te stellen via Beheer → Integraties.',
    'integ.linkedin_connect': 'LinkedIn verbinden',
    'integ.linkedin_opening': 'Openen…',
    'integ.github_connected': 'Verbonden als {username} — AI kan repo\'s beheren en code bekijken',
    'integ.github_desc': 'Verbind om repo\'s te beheren, code te bekijken en branches te verkennen',
    'integ.mcp_connected': '{toolCount} tools beschikbaar — inloggegevens geconfigureerd',
    'integ.mcp_desc': 'Configureer je inloggegevens voor {toolCount} tools',
    'integ.n8n_desc': 'Workflowautomatisering met n8n-webhooks',

    // ── Common ──────────────────────────────────────────────────
    'common.saved': 'Opgeslagen',
    'common.saving': 'Opslaan…',

    // ── Organisation → Default Language ─────────────────────────
    'org.default_language': 'Standaardtaal',
    'org.default_language_desc': 'Stel de standaardtaal in voor nieuwe gebruikers in je organisatie',
    'org.new_user_language': 'Taal nieuwe gebruiker',
    'org.new_user_language_desc': 'Wanneer een nieuwe gebruiker voor het eerst inlogt, wordt de interface in deze taal weergegeven. Gebruikers kunnen hun taal op elk moment wijzigen in hun persoonlijke instellingen.',
    'org.default_language_info': 'Deze instelling geldt alleen voor nieuwe gebruikers die nog geen taal hebben gekozen. Bestaande gebruikers behouden hun huidige taalvoorkeur. Ga naar het beheerdersdashboard > Talen om meer talen aan BeeFlow toe te voegen.',
    'org.description': 'Beschrijving',

    // ── Agents ──────────────────────────────────────────────────
    'store.title': 'Agents',
    'store.count': '{visible} van {total} agents',
    'store.search_placeholder': 'Agents zoeken...',
    'store.tab_popular': 'Populair',
    'store.tab_last_used': 'Laatst gebruikt',
    'store.tab_favorites': 'Favorieten',
    'store.tab_all': 'Alles',
    'store.advanced': 'Geavanceerd',
    'store.popular_heading': 'POPULAIR',
    'store.agent_editor': 'Agent Ontwerper',
    'store.badge_agent': 'Agent',
    'store.no_agents': 'Geen agents gevonden',
    'store.no_agents_hint': 'Probeer je zoekopdracht of filters aan te passen.',
    'store.clear_filters': 'Filters wissen',
    'store.all_agents': 'Alle agents',
    'store.results': 'Resultaten',
};

async function run() {
    // Load config store (needs DB connection)
    const configStore = require('../stores/configStore');
    const languageStore = require('../stores/languageStore');

    console.log('Loading existing Dutch GUI translations...');
    const existing = await languageStore.getGUITranslations('nl');
    const existingCount = Object.keys(existing).length;
    console.log(`  Found ${existingCount} existing NL translations`);

    // Merge: only add keys that don't already exist
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
