#!/usr/bin/env node
/**
 * Migration: Dutch translations for the new full-page signup wizard, MFA
 * (TOTP), self-service password reset, change-password, and the Security
 * settings section.
 *
 * Without this, users on a non-English locale see English for these keys
 * because the DB has no NL override and the client falls back to the English
 * default. Idempotent — only inserts keys that don't already have a NL value,
 * safe to re-run.
 *
 * Auto-runs from server boot (server/index.js). Manual usage:
 *   node server/migrations/add-nl-signup-mfa-reset-auth-translations.js
 */

const NL_TRANSLATIONS = {
    // ── Signup wizard: steps & chrome ───────────────────────────
    'signup.step_welcome': 'Welkom',
    'signup.step_type': 'Kies je account',
    'signup.step_org': 'Organisatiegegevens',
    'signup.step_auth': 'Inlogmethode',
    'signup.step_privacy': 'Privacy Shield',
    'signup.step_account': 'Je account',
    'signup.step_counter': 'Stap {n} van {total}',
    'signup.next': 'Volgende',
    'signup.continue': 'Doorgaan',
    'signup.back': 'Terug',
    'signup.back_to_signin': 'Terug naar inloggen',
    'signup.invited_to_join': 'Je bent uitgenodigd om lid te worden van {orgName}',
    'signup.wizard_welcome_org': 'Laten we je organisatie in een paar snelle stappen instellen op Bee Flow.',
    'signup.wizard_welcome_consumer': 'Laten we je persoonlijke Bee Flow-account in een paar snelle stappen aanmaken.',
    'signup.wizard_welcome_body': 'We leiden je door je accounttype, hoe je inlogt, privacy en je accountgegevens. Het meeste kun je later aanpassen in de instellingen.',

    // ── Signup wizard: account type ─────────────────────────────
    'signup.org_account': 'Organisatieaccount',
    'signup.org_account_desc': 'Voor teams & bedrijven',
    'signup.org_account_features': 'Werkruimte voor meerdere gebruikers met rollen, gedeelde agents en teamfacturatie',
    'signup.personal_account': 'Persoonlijk account',
    'signup.personal_account_desc': 'Voor individueel gebruik',
    'signup.personal_account_features': 'Begin snel met je eigen persoonlijke werkruimte. Sluit je later op elk moment aan bij een organisatie.',
    'signup.new_org': 'Nieuwe organisatie',
    'signup.joining_existing': 'Aansluiten bij bestaande organisatie',

    // ── Signup wizard: organisation details ─────────────────────
    'signup.company_name': 'Bedrijfsnaam',
    'signup.tagline': 'Slogan / Tagline',
    'signup.description_label': 'Beschrijving',
    'signup.what_does_org_do': 'Wat doet je organisatie?',
    'signup.address': 'Adres',
    'signup.phone': 'Telefoon',
    'signup.kvk': 'KVK-nummer',
    'signup.vat': 'Btw-nummer',

    // ── Signup wizard: account details ──────────────────────────
    'signup.first_name': 'Voornaam',
    'signup.last_name': 'Achternaam',
    'signup.username': 'Gebruikersnaam',
    'signup.email': 'E-mailadres',
    'signup.password': 'Wachtwoord',
    'signup.confirm_password': 'Bevestig wachtwoord',
    'signup.create_account_btn': 'Account aanmaken',

    // ── Signup wizard: auth method ──────────────────────────────
    'signup.choose_auth_carefully': 'Kies zorgvuldig:',
    'signup.choose_auth_carefully_desc': 'Eenmaal opgeslagen kan dit niet meer worden gewijzigd. De gegevens van elke gebruiker worden beschermd met een unieke sleutel die gekoppeld is aan hoe ze inloggen. Later wisselen maakt bestaande gesprekken onleesbaar.',
    'signup.sign_in_with_provider': 'Log in met {provider} om je account in te stellen. Je naam en e-mailadres worden automatisch geïmporteerd.',
    'signup.continue_with_provider': 'Doorgaan met {provider}',
    'org.password_auth': 'Gebruikersnaam & wachtwoord',
    'org.password_auth_desc': 'Gebruikers loggen in met een gebruikersnaam en wachtwoord.',
    'org.google_auth': 'Inloggen met Google',
    'org.google_auth_desc': 'Gebruikers loggen in met hun Google-account.',
    'org.microsoft_auth': 'Inloggen met Microsoft',
    'org.microsoft_auth_desc': 'Gebruikers loggen in met hun Microsoft-account.',

    // ── Signup wizard: privacy shield ───────────────────────────
    'signup.privacy_off': 'Geen bescherming',
    'signup.privacy_off_desc': 'Geen contentfiltering. Je kunt bescherming later inschakelen in de organisatie-instellingen.',
    'signup.privacy_basic': 'Basisbescherming',
    'signup.privacy_basic_desc': 'AI-gestuurde moderatie filtert schadelijke contentcategorieën (haatzaaien, geweld, zelfbeschadiging, enz.)',
    'signup.privacy_strict': 'Strikte bescherming',
    'signup.privacy_strict_desc': 'AI-moderatie plus filtering van persoonsgegevens. Blokkeert persoonlijke gegevens zoals namen, e-mailadressen, telefoonnummers en adressen.',
    'signup.privacy_tune_later': 'Je kunt deze instellingen later verfijnen in Organisatie-instellingen → Privacy Shield.',
    'signup.eu_only_models': 'Alleen EU-modellen',
    'signup.eu_only_models_desc': 'Beperk AI tot uitsluitend in de EU gehoste modellen',

    // ── Signup wizard: review summary ───────────────────────────
    'signup.review_title': 'Controleer je gegevens',
    'signup.review_account_type': 'Accounttype',
    'signup.review_organisation': 'Organisatie',
    'signup.review_signin': 'Inlogmethode',
    'signup.review_privacy': 'Privacy Shield',

    // ── MFA (TOTP) ──────────────────────────────────────────────
    'settings.security': 'Beveiliging',
    'mfa.title': 'Tweefactorauthenticatie',
    'mfa.section_desc': 'Voeg een tweede factor toe om je account te beschermen bij het inloggen.',
    'mfa.enter_code': 'Voer de 6-cijferige code uit je authenticator-app in',
    'mfa.enter_recovery_code': 'Voer een van je eenmalige herstelcodes in',
    'mfa.code': 'Verificatiecode',
    'mfa.recovery_code': 'Herstelcode',
    'mfa.verify': 'Verifiëren',
    'mfa.use_recovery': 'Een herstelcode gebruiken',
    'mfa.use_authenticator': 'Gebruik in plaats daarvan je authenticator-app',
    'mfa.invalid_code': 'Ongeldige code. Probeer het opnieuw.',
    'mfa.enable': 'Inschakelen',
    'mfa.disable': 'Uitschakelen',
    'mfa.regenerate': 'Opnieuw genereren',
    'mfa.regenerate_codes': 'Herstelcodes opnieuw genereren',
    'mfa.enabled_title': 'Tweefactorauthenticatie staat aan',
    'mfa.disabled_title': 'Tweefactorauthenticatie staat uit',
    'mfa.disabled_desc': 'Gebruik een authenticator-app voor een extra beveiligingslaag.',
    'mfa.codes_remaining': '{n} herstelcodes resterend',
    'mfa.confirm_with_code': 'Voer een huidige code in ter bevestiging',
    'mfa.scan_qr': 'Scan deze QR-code met je authenticator-app (Google Authenticator, Microsoft Authenticator, 1Password…) en voer dan de 6-cijferige code in ter bevestiging.',
    'mfa.cant_scan': 'Kun je niet scannen? Voer deze sleutel handmatig in',
    'mfa.save_recovery_codes': 'Bewaar deze eenmalige herstelcodes op een veilige plek. Elke code is één keer te gebruiken als je geen toegang meer hebt tot je authenticator. Ze worden niet opnieuw getoond.',
    'mfa.ive_saved_them': 'Ik heb ze opgeslagen',
    'mfa.required_title': 'Stel tweefactorauthenticatie in',
    'mfa.required_desc': 'Je beheerder vereist tweefactorauthenticatie voor wachtwoordaccounts. Stel het nu in om door te gaan.',

    // ── Password reset ──────────────────────────────────────────
    'login.forgot_password': 'Wachtwoord vergeten?',
    'reset.title': 'Stel je wachtwoord opnieuw in',
    'reset.forgot_title': 'Wachtwoord vergeten?',
    'reset.forgot_desc': 'Voer je e-mailadres in en we sturen je een link om je wachtwoord opnieuw in te stellen.',
    'reset.email': 'E-mailadres',
    'reset.send_link': 'Resetlink versturen',
    'reset.check_email': 'Als er een account bestaat voor dat e-mailadres, hebben we een link gestuurd om het wachtwoord opnieuw in te stellen. Controleer je inbox.',
    'reset.back_to_signin': 'Terug naar inloggen',
    'reset.choose_new': 'Kies een nieuw wachtwoord voor je account.',
    'reset.new_password': 'Nieuw wachtwoord',
    'reset.confirm_password': 'Bevestig nieuw wachtwoord',
    'reset.set_password': 'Nieuw wachtwoord instellen',
    'reset.success': 'Je wachtwoord is opnieuw ingesteld. Je kunt nu inloggen met je nieuwe wachtwoord.',
    'reset.go_signin': 'Naar inloggen',
    'reset.min_length': 'Wachtwoord moet minstens 8 tekens bevatten',
    'reset.failed': 'Het opnieuw instellen van het wachtwoord is mislukt.',

    // ── Change password (logged-in) ─────────────────────────────
    'changepw.title': 'Wachtwoord wijzigen',
    'changepw.current': 'Huidig wachtwoord',
    'changepw.new': 'Nieuw wachtwoord',
    'changepw.confirm': 'Bevestig nieuw wachtwoord',
    'changepw.update': 'Wachtwoord bijwerken',
    'changepw.success': 'Wachtwoord succesvol gewijzigd.',
    'changepw.failed': 'Wachtwoord wijzigen mislukt',

    // ── Signup wizard: Privacy Shield / PII detection ───────────
    'signup.shield_enable': 'Privacyschild',
    'signup.shield_enable_desc': 'Scan berichten op persoonsgegevens en blokkeer of vervang deze voordat ze de AI bereiken.',
    'signup.pii_categories': 'PII-categorieën',
    'signup.shield_on_summary': '{n} PII-categorieën',
    'signup.shield_off_summary': 'Uit',

    // ── PII action picker (shared with admin Privacy Shield) ────
    'pii.action_tokenize': 'Tokeniseren & terugplaatsen',
    'pii.action_tokenize_help': 'Vervang gevoelige waarden door plaatsaanduidingen zoals [email_1] voordat de AI ze ziet. De echte waarden worden nooit naar het model gestuurd; ze worden in het antwoord teruggeplaatst.',
    'pii.action_block': 'Bericht blokkeren',
    'pii.action_block_help': 'Weiger het bericht voordat het de organisatie verlaat. De gebruiker wordt gevraagd het te herformuleren zonder gevoelige gegevens.',

    // ── PII category labels (shared with admin Privacy Shield) ──
    'pii.person_name': 'Persoonsnamen',
    'pii.date_of_birth': 'Geboortedatum',
    'pii.phone_number': 'Telefoonnummers',
    'pii.email_address': 'E-mailadressen',
    'pii.physical_address': 'Fysieke adressen',
    'pii.credit_card': 'Creditcardnummers',
    'pii.bank_account': 'Bankrekeningnummers',
    'pii.iban': 'IBAN-nummers',
    'pii.ssn': 'Sociale-zekerheidsnummers',
    'pii.passport': 'Paspoortnummers',
    'pii.drivers_license': 'Rijbewijsnummers',
    'pii.ip_address': 'IP-adressen',
    'pii.url': 'URLs',
    'pii.api_key_or_secret': 'API-sleutels / secrets',
    'pii.organization': 'Organisaties',
    'pii.national_id': 'Nationaal ID (BSN / DNI / NIE / codice fiscale / Steuer-ID)',
    'pii.tax_id': 'Fiscale nummers (btw / RSIN / VAT)',
    'pii.health_insurance': 'Zorgverzekeringsnummers',
    'pii.medical_condition': 'Medische aandoeningen',
    'pii.medication': 'Medicatie',
    'pii.license_plate': 'Kentekens',
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
        console.log(`[Migration] add-nl-signup-mfa-reset-auth-translations applied (+${added} keys)`);
    }
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
