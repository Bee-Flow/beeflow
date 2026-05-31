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
    // The gate is a no-op only for features that live in
    // TIER_FEATURES.community (chat_basic / skills / kb_* / etc.). The
    // Studio-class features below were promoted to enterprise in the tier
    // tightening — see docs/docs/licensing/tiers.md — and now enforce on
    // every community install.
    '/components': { gate: 'component_designer', beta: null, notes: 'Enterprise tier; AI custom-UI component builder. Top-level (non-/api) path.' },
    '/api/automation/builder': { gate: 'automations', beta: null, notes: 'Enterprise tier' },
    '/api/automation': { gate: 'automations', beta: null, notes: 'Enterprise tier' },
    '/api/compliance': { gate: 'compliance_hub_gdpr', beta: null, notes: 'Enterprise tier' },
    '/api/dsr': { gate: null, beta: null, notes: 'Public DSR channel must stay reachable per GDPR Art. 12; admin endpoints inside the router enforce admin_compliance' },
    '/api/notebooks': { gate: 'notebooks', beta: null, notes: 'Enterprise tier; configStore.feature_notebooks_enabled remains as a per-deployment kill switch (runs AFTER the licence gate so the frontend sees the actionable feature_locked body first)' },
    '/api/webpages': { gate: 'webpages', beta: 'webpages', notes: 'Enterprise tier + beta opt-in' },
    '/api/transcriptions': { gate: 'meeting_notes', beta: 'meeting_notes', notes: 'Enterprise tier + beta opt-in' },
    '/api/skills': { gate: 'skills', beta: 'skills', notes: 'Community tier + beta opt-in (skills stays in community)' },
    '/api/ticket-assistant': { gate: 'ticket_assistant', beta: 'itil_ticket_assistant', notes: 'Enterprise tier + beta opt-in' },
    '/api/email-kb': { gate: 'ticket_assistant', beta: 'itil_ticket_assistant', notes: 'Alias of /api/ticket-assistant' },
    '/api/tests': { gate: 'playwright_tests', beta: 'playwright_tests', notes: 'Enterprise tier + beta opt-in — Studio Tests tab (Playwright generation + runs)' },

    // ── Intentionally ungated (community-tier core functionality) ────
    '/api/usage': { gate: 'advanced_usage_monitoring', beta: null, notes: 'Base /api/usage paths (summary/timeline/users/sources/agents/models/...) are ungated for the Overview tab. The /api/usage/{guardrails,integrations,azure-services}/* sub-paths are gated to advanced_usage_monitoring (enterprise+) via a path-aware middleware in server/index.js — Safety, Integrations, Azure-services tabs. Same gate applies to /api/terminations and /api/feedback (Terminations + Feedback tabs).' },
    '/api/terminations': { gate: 'advanced_usage_monitoring', beta: null, notes: 'Enterprise tier — Terminations tab in Usage & Monitoring' },
    '/api/feedback': { gate: 'advanced_usage_monitoring', beta: null, notes: 'Enterprise tier — Feedback tab in Usage & Monitoring' },
    '/api/documents': { gate: null, beta: null, notes: 'Core community feature' },
    '/api/notifications': { gate: null, beta: null, notes: 'Core community feature' },
    '/api/projects': { gate: 'projects', beta: null, notes: 'Enterprise tier (promoted in second-wave tightening). configStore.feature_projects_enabled remains as a per-deployment kill switch (runs AFTER the licence gate so the frontend sees feature_locked first).' },
    '/api/org-privacy-shield': { gate: null, beta: null, notes: 'Soft tier clamps applied in-handler: on community tier the PUT handler clamps piiDetectionAction → "block" (pii_tokenize gate) and forces webSearchGuardEnabled → false (web_search_guard gate). Stored row is preserved across upgrades. See server/routes/orgPrivacyShield.js.' },
    '/api/reminders': { gate: null, beta: null, notes: 'Core community feature' },
    '/api/ai-tasks': { gate: 'agent_routines', beta: 'agent_routines', notes: 'Enterprise tier + beta opt-in — Agent Routines (Studio → Routines), scheduled recurring agent runs. Gated at the mount in server/index.js.' },
    '/api/kb': { gate: null, beta: null, notes: 'Knowledge base is community-tier; max_kb_sources limit enforces caps' },

    // ── License / billing admin routes (auth + per-handler RBAC) ─────
    '/api/license': { gate: null, beta: null, notes: 'Activate/refresh/deactivate; per-handler isOrgAdmin checks. POST /activate splits org vs consumer vs server scope (server scope = install-wide override, super-admin + self-hosted only) and CANNOT be hoisted to router-level requireAdmin without breaking consumer self-activation. DELETE /deactivate?scope=server removes the server-wide override.' },
    '/api/admin/licenses': { gate: null, beta: null, notes: 'Admin-only license issuance; super-admin gate inside the router' },
    '/api/subscriptions': { gate: null, beta: null, notes: 'Mixed admin + org-member endpoints; per-handler requireAuthOrOrgMember' },
    '/api/stripe': { gate: null, beta: null, notes: 'Checkout/portal + webhook; webhook uses signature verification' },
    '/api/billing': { gate: null, beta: null, notes: 'Public plan listing' },
};
