/**
 * Transactional Email Template Defaults
 *
 * Built-in English text for the admin-configurable lifecycle emails
 * (verification + welcome). These serve as the per-field fallback for any
 * locale — see languageStore.getEffectiveEmailTemplate().
 *
 * Each template is a flat object of structured fields rendered through the
 * shared branded shell (_renderEmailShell in utils/emailService.js):
 *   - subject  : email subject line (plain text)
 *   - title    : big heading in the email header
 *   - intro    : greeting line (e.g. "Hi Tom,")
 *   - body     : main paragraph(s)
 *   - ctaLabel : text on the call-to-action button
 *
 * Field values may contain {{variable}} placeholders (see
 * EMAIL_TEMPLATE_VARIABLES). The send functions HTML-escape the substituted
 * values, so admins author plain text here, not HTML.
 */

// Template identifiers (order = display order in the admin editor).
const EMAIL_TEMPLATE_IDS = ['verification', 'welcome'];

// The structured fields every template exposes.
const EMAIL_TEMPLATE_FIELDS = ['subject', 'title', 'intro', 'body', 'ctaLabel'];

// Placeholder tokens available per template (for the admin UI hint chips and
// so AI-translation can be told to preserve them).
const EMAIL_TEMPLATE_VARIABLES = {
    verification: ['name', 'verifyUrl', 'orgName'],
    welcome: ['name', 'loginUrl', 'learnUrl', 'orgName'],
};

// Human-readable labels for the editor.
const EMAIL_TEMPLATE_LABELS = {
    verification: 'Email verification',
    welcome: 'Welcome / confirmation',
};

// English defaults. The CTA URL is supplied at send time (verifyUrl /
// loginUrl), so ctaLabel is text-only and the URL is not part of the body.
const EMAIL_TEMPLATE_DEFAULTS = {
    verification: {
        subject: 'Confirm your email address',
        title: 'Confirm your email',
        intro: 'Hi {{name}},',
        body: 'Thanks for creating a BeeFlow account. Please confirm your email address to activate your account and get started. This link expires in 24 hours. If you didn\'t create an account, you can safely ignore this email.',
        ctaLabel: 'Confirm email address',
    },
    welcome: {
        subject: 'Welcome to BeeFlow',
        title: 'Welcome to BeeFlow 🎉',
        intro: 'Hi {{name}},',
        body: 'Your email address is confirmed and your account is ready. You can log in any time and start using the platform. New to Bee Flow? The Learning Center will get you up to speed fast — explore it here: {{learnUrl}}',
        ctaLabel: 'Log in',
    },
};

/**
 * Get the built-in English template for a given template ID.
 * Returns a fresh shallow copy so callers can mutate safely. Null if unknown.
 */
function getDefaultEmailTemplate(templateId) {
    const tpl = EMAIL_TEMPLATE_DEFAULTS[templateId];
    return tpl ? { ...tpl } : null;
}

module.exports = {
    EMAIL_TEMPLATE_IDS,
    EMAIL_TEMPLATE_FIELDS,
    EMAIL_TEMPLATE_VARIABLES,
    EMAIL_TEMPLATE_LABELS,
    EMAIL_TEMPLATE_DEFAULTS,
    getDefaultEmailTemplate,
};
