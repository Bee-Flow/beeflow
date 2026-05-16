/**
 * Route → feature gating registry.
 *
 * Single source of truth for which Express mount paths are gated by which
 * license feature (and any companion beta-feature flag). Entries here are
 * documentation + a future regression target — they don't drive runtime
 * routing; the actual gates are applied at the `app.use(...)` site in
 * server/index.js so that mount order stays explicit.
 *
 * When you mount a new `/api/*` route, add an entry here. If the route
 * is intentionally NOT gated (e.g. /api/notifications, /api/usage), use
 * `gate: null` so reviewers can see the decision was deliberate.
 *
 * Format:
 *   '<mount path>': {
 *       gate: 'feature_name' | null,    // matches a key in TIER_FEATURES
 *       beta: 'beta_feature_key' | null,
 *       notes: '...'                    // brief rationale
 *   }
 *
 * To audit drift, compare `Object.keys(featureMap)` against the mount
 * paths registered in server/index.js (this is what the regression test
 * planned for Wave 3 will do once the harness exists).
 */

module.exports = {
    // ── Gated routes (require a license feature) ─────────────────────
    // Community-tier features still go through requireLicenseFeature so the
    // beta opt-in path stays consistent; the license gate itself is a no-op
    // for community installs (feature lives in TIER_FEATURES.community).
    '/api/automation/builder': { gate: 'automations', beta: null, notes: 'Community tier (license gate passes for everyone)' },
    '/api/automation': { gate: 'automations', beta: null, notes: 'Community tier' },
    '/api/compliance': { gate: 'compliance_hub_gdpr', beta: null, notes: 'Enterprise tier' },
    '/api/dsr': { gate: null, beta: null, notes: 'Public DSR channel must stay reachable per GDPR Art. 12; admin endpoints inside the router enforce admin_compliance' },
    '/api/webpages': { gate: 'webpages', beta: 'webpages', notes: 'Community tier + beta opt-in' },
    '/api/transcriptions': { gate: 'meeting_notes', beta: 'meeting_notes', notes: 'Community tier + beta opt-in' },
    '/api/meet-bot': { gate: 'meeting_notes', beta: 'meeting_notes', notes: 'Community tier + beta opt-in' },
    '/api/skills': { gate: 'skills', beta: 'skills', notes: 'Community tier + beta opt-in' },
    '/api/ticket-assistant': { gate: 'ticket_assistant', beta: 'itil_ticket_assistant', notes: 'Community tier + beta opt-in' },
    '/api/email-kb': { gate: 'ticket_assistant', beta: 'itil_ticket_assistant', notes: 'Alias of /api/ticket-assistant' },

    // ── Intentionally ungated (community-tier core functionality) ────
    '/api/usage': { gate: null, beta: null, notes: 'Usage reads are core; in-handler limits enforce caps' },
    '/api/documents': { gate: null, beta: null, notes: 'Core community feature' },
    '/api/notifications': { gate: null, beta: null, notes: 'Core community feature' },
    '/api/projects': { gate: null, beta: null, notes: 'Core feature; configStore.feature_projects_enabled is the on/off switch' },
    '/api/reminders': { gate: null, beta: null, notes: 'Core community feature' },
    '/api/ai-tasks': { gate: null, beta: null, notes: 'Core community feature' },
    '/api/notebooks': { gate: null, beta: null, notes: 'configStore.feature_notebooks_enabled gates per-deployment' },
    '/api/kb': { gate: null, beta: null, notes: 'Knowledge base is community-tier; max_kb_sources limit enforces caps' },

    // ── License / billing admin routes (auth + per-handler RBAC) ─────
    '/api/license': { gate: null, beta: null, notes: 'Activate/refresh/deactivate; per-handler isOrgAdmin checks. POST /activate splits org vs consumer scope and CANNOT be hoisted to router-level requireAdmin without breaking consumer self-activation.' },
    '/api/admin/licenses': { gate: null, beta: null, notes: 'Admin-only license issuance; super-admin gate inside the router' },
    '/api/subscriptions': { gate: null, beta: null, notes: 'Mixed admin + org-member endpoints; per-handler requireAuthOrOrgMember' },
    '/api/stripe': { gate: null, beta: null, notes: 'Checkout/portal + webhook; webhook uses signature verification' },
    '/api/billing': { gate: null, beta: null, notes: 'Public plan listing' },
};
