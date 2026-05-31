// User store for app passwords, user management, and groups
// PostgreSQL-backed with envelope encryption

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { run, getOne, getAll, exec, getClient } = require('../db');

let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            "displayName" TEXT,
            "firstName" TEXT,
            "lastName" TEXT,
            email TEXT,
            phone TEXT,
            avatar TEXT,
            "avatarType" TEXT,
            "passwordHash" TEXT,
            role TEXT DEFAULT 'user',
            groups TEXT DEFAULT '[]',
            "masterWrappedDEK" TEXT,
            "wrappedDEK" TEXT,
            "kekSalt" TEXT,
            "recoverySalt" TEXT,
            "recoveryWrappedDEK" TEXT,
            "ssoEncryptionSetup" INTEGER DEFAULT 0,
            "passwordResetRequired" INTEGER DEFAULT 0,
            "dekUnwrapFailures" INTEGER DEFAULT 0,
            "dekLockoutUntil" TEXT,
            "appPassword" TEXT,
            "appPasswordCreated" TEXT,
            "orgRole" TEXT DEFAULT '',
            "organizationId" TEXT DEFAULT '',
            "opaqueRecord" TEXT,
            "kdfMode" TEXT DEFAULT 'legacy_argon2',
            "createdAt" TEXT,
            status TEXT DEFAULT 'active',
            "activeIconPackId" TEXT
        );

        CREATE TABLE IF NOT EXISTS organizations (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            tagline TEXT,
            address TEXT,
            email TEXT,
            phone TEXT,
            website TEXT,
            kvk TEXT,
            vat TEXT,
            logo TEXT,
            "footerText" TEXT,
            "defaultGroups" TEXT DEFAULT '[]',
            "allowSignup" TEXT DEFAULT '0',
            "authMethod" TEXT,
            "autoApproveSSO" TEXT DEFAULT '0'
        );

        CREATE TABLE IF NOT EXISTS groups (
            id TEXT PRIMARY KEY,
            "organizationId" TEXT,
            name TEXT NOT NULL,
            description TEXT,
            permissions TEXT DEFAULT '[]',
            roles TEXT DEFAULT '[]',
            "userCount" INTEGER DEFAULT 0,
            "allowedAgentTypes" TEXT DEFAULT '[]',
            "allowedTiers" TEXT DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS roles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            permissions TEXT DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS subscription_plans (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            max_messages_per_month INTEGER,
            max_messages_by_type TEXT DEFAULT '{}',
            max_tokens_per_month INTEGER,
            max_cost_per_month REAL,
            max_users INTEGER,
            max_agents INTEGER,
            max_knowledge_sources INTEGER,
            allowed_features TEXT DEFAULT '[]',
            allowed_models TEXT DEFAULT '[]',
            is_default BOOLEAN DEFAULT FALSE,
            price REAL,
            currency TEXT DEFAULT 'EUR',
            billing_interval TEXT DEFAULT 'monthly',
            trial_days INTEGER DEFAULT 0,
            sort_order INTEGER DEFAULT 0,
            is_public BOOLEAN DEFAULT FALSE,
            stripe_price_id TEXT,
            stripe_product_id TEXT,
            created_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS organization_subscriptions (
            id TEXT PRIMARY KEY,
            organization_id TEXT REFERENCES organizations(id),
            plan_id TEXT REFERENCES subscription_plans(id),
            status TEXT DEFAULT 'active',
            max_messages_per_month INTEGER,
            max_messages_by_type TEXT,
            max_tokens_per_month INTEGER,
            max_cost_per_month REAL,
            max_users INTEGER,
            max_agents INTEGER,
            max_knowledge_sources INTEGER,
            allowed_features TEXT,
            allowed_models TEXT,
            billing_cycle_start TEXT,
            notes TEXT,
            trial_end_date TEXT,
            stripe_customer_id TEXT,
            stripe_subscription_id TEXT,
            payment_status TEXT DEFAULT 'none',
            created_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS subscription_audit_log (
            id TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            changed_by TEXT,
            old_values TEXT,
            new_values TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        -- Persistent audit trail for access-control changes (users, roles,
        -- groups, invitations, orgs). Mirrors subscription_audit_log but
        -- keeps the row count off the billing path. Querying by
        -- (organization_id, created_at) covers the "show me who changed
        -- access in org X over the last 90 days" GDPR Art. 30 / SOC 2 case.
        CREATE TABLE IF NOT EXISTS access_audit_log (
            id TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            organization_id TEXT,
            changed_by TEXT,
            old_values TEXT,
            new_values TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        -- One-shot notification ledger. Anything that is "send this email
        -- exactly once for this subscription/event" — trial-ending warnings,
        -- payment-failed notices, dunning warnings, breach notifications —
        -- registers a row keyed on (target_type, target_id, kind). The
        -- UNIQUE constraint is the idempotency primitive; re-delivered
        -- webhooks attempt the insert and bail on conflict.
        CREATE TABLE IF NOT EXISTS notifications_sent (
            id TEXT PRIMARY KEY,
            target_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            recipient TEXT,
            payload TEXT,
            sent_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (target_type, target_id, kind)
        )
    `);
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_access_audit_log_org_time ON access_audit_log (organization_id, created_at DESC)`); } catch (_) { /* exists */ }
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_access_audit_log_target ON access_audit_log (target_type, target_id, created_at DESC)`); } catch (_) { /* exists */ }

    // ── Column migrations (safe for existing DBs) ─────────────────────────────
    try { await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "activeIconPackId" TEXT`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "autoApproveSSO" TEXT DEFAULT '0'`); } catch (e) { /* column already exists */ }
    // Pooled vs per-user AI-usage budget. '1' = org-wide pool (default,
    // matches legacy behaviour); '0' = cost cap is split evenly across
    // active seats so each user gets their own slice.
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "usage_pooled" TEXT DEFAULT '1'`); } catch (e) { /* column already exists */ }
    // Org lifecycle state. 'active' is the default; 'suspended' blocks all
    // mutations (read-only) and is used for payment disputes / ToS holds;
    // 'archived' hides the org from listings and locks reads to owners.
    // Hard-delete remains a separate (irreversible) action.
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'active'`); } catch (e) { /* column already exists */ }
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_orgs_status ON organizations(status) WHERE status <> 'active'`); } catch (e) { /* index already exists */ }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "enabledIntegrations" TEXT DEFAULT NULL`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "allowed_domains" TEXT DEFAULT NULL`); } catch (e) { /* column already exists */ }
    // Org-admin "active" subsets of the super-admin allow-lists. The super
    // admin grants capabilities (enabledIntegrations / beta_features); the
    // org admin then chooses which of those to actually turn on for their
    // org. Empty array (default) = nothing on. The runtime gates intersect
    // these with the allow-list before letting tools/routes through.
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "org_enabled_integrations" TEXT DEFAULT '[]'`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "org_enabled_beta_features" TEXT DEFAULT '[]'`); } catch (e) { /* column already exists */ }

    // One-shot backfill: any org that already has a super-admin allow-list
    // gets that list copied into the new "enabled" column so today's
    // behaviour is preserved. Only rows still at the '[]' default are
    // touched, so this stays idempotent on subsequent boots.
    try {
        await exec(`UPDATE organizations
            SET "org_enabled_integrations" = "enabledIntegrations"
            WHERE "org_enabled_integrations" = '[]'
              AND "enabledIntegrations" IS NOT NULL
              AND "enabledIntegrations" != '[]'`);
    } catch (e) { /* non-fatal — column may not be ready yet on first boot */ }
    try {
        await exec(`UPDATE organizations
            SET "org_enabled_beta_features" = COALESCE("beta_features", '[]')
            WHERE "org_enabled_beta_features" = '[]'
              AND "beta_features" IS NOT NULL
              AND "beta_features" != '[]'`);
    } catch (e) { /* beta_features column is added lazily by betaFeatures.js; backfill will run next boot once it exists */ }

    // ── Azure AD Group Sync columns ──
    try { await exec(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS "azureGroupId" TEXT`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS "source" TEXT DEFAULT 'manual'`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS "lastSyncedAt" TEXT`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS "orgRole" TEXT DEFAULT ''`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS "allowedTiers" TEXT DEFAULT '[]'`); } catch (e) { /* column already exists */ }
    // Per-group NC integration opt-out (Fase G). Org-admin uses this to
    // disable specific Nextcloud tools for members of a group. Empty array
    // means "inherit org-wide setting".
    try { await exec(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS "disabled_integrations" TEXT DEFAULT '[]'`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "azureUserId" TEXT`); } catch (e) { /* column already exists */ }

    // ── Nextcloud connector binding (instance ↔ org, NC uid ↔ user) ──
    // Each NC instance maps 1-op-1 to an org via ocs/v2.php/cloud/capabilities `instanceid`.
    // Auto-provisioned users carry `nc_uid` for sync + dedup; `provider` distinguishes
    // 'nextcloud_connector' from 'oauth_google' / 'local' for downstream auth flows.
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_instance_id" TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_base_url" TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_admin_uid" TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_provisioned_at" TIMESTAMPTZ`); } catch (e) { }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "connector_callback_url" TEXT`); } catch (e) { }
    try { await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_nc_instance_id ON organizations ("nc_instance_id") WHERE "nc_instance_id" IS NOT NULL`); } catch (e) { }
    try { await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "nc_uid" TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "provider" TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "auto_provisioned" BOOLEAN DEFAULT FALSE`); } catch (e) { }
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_users_nc_uid_org ON users ("organizationId", "nc_uid") WHERE "nc_uid" IS NOT NULL`); } catch (e) { }

    // ── NC user/group sync configuration (per org) ──
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_sync_mode" TEXT DEFAULT 'mirror_all'`); } catch (e) { }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_sync_groups" TEXT DEFAULT '[]'`); } catch (e) { }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_sync_excluded_groups" TEXT DEFAULT '[]'`); } catch (e) { }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_new_user_default_status" TEXT DEFAULT 'active'`); } catch (e) { }
    // orgRole assigned to NC users auto-provisioned via the connector JWT path
    // ([server/auth/connectorJwt.js]). Without this column the default in
    // connectorJwt.js (agent_editor) applies, which gives standard agent/skill/
    // knowledge author rights. Operators can downgrade individual orgs by
    // updating this column directly (e.g. 'member' for chat-only deployments).
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_new_user_default_org_role" TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_last_sync_at" TIMESTAMPTZ`); } catch (e) { }
    // One-shot backfill: NC users provisioned before this column existed
    // landed with orgRole = '', which means the permission resolver gives them
    // only the page_chat fallback. Bump them to the agent_editor default so
    // Studio / Webpages / Meeting Notes routes stop 403-ing under their JWTs.
    try { await exec(`UPDATE users
                         SET "orgRole" = 'agent_editor'
                       WHERE provider = 'nextcloud_connector'
                         AND ("orgRole" IS NULL OR "orgRole" = '')`); } catch (e) { }
    // First-run wizard flag — null until org-admin completes the App Store
    // onboarding. connectorJwt.js gates auto-provision on this so other NC
    // users wait at a "Setup in progress" screen until the admin is done.
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_onboarding_completed_at" TIMESTAMPTZ`); } catch (e) { }

    // ── Onboarding-wizard outputs (deployment + selected plan) ──
    // Set once during the App Store wizard so the SaaS knows whether the org
    // intends to ride on Bee Flow Cloud vs self-hosted, and which subscription
    // the admin pre-selected. Neither activates a license — `selected_plan_id`
    // is a hint surfaced in License & Usage for the upsell flow.
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "deployment_mode" TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "selected_plan_id" TEXT`); } catch (e) { }

    // ── Pending NC bindings (deferred adoption) ──
    // When a connector bootstraps and the NC admin's email maps to an
    // existing Bee Flow org without nc_instance_id, we DO NOT bind
    // automatically — that would let an attacker hosting a fake NC adopt
    // someone else's org. Instead a pending row is created here and the
    // org-admin must explicitly approve the binding from the authenticated
    // SaaS UI.
    try {
        await exec(`CREATE TABLE IF NOT EXISTS pending_nc_bindings (
            id              TEXT PRIMARY KEY,
            org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            nc_instance_id  TEXT NOT NULL,
            nc_base_url     TEXT NOT NULL,
            nc_admin_uid    TEXT NOT NULL,
            nc_admin_email  TEXT NOT NULL,
            nc_admin_display_name TEXT,
            connector_callback_url TEXT,
            theming_name    TEXT,
            nc_version      TEXT,
            status          TEXT NOT NULL DEFAULT 'pending',
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at      TIMESTAMPTZ NOT NULL,
            approved_at     TIMESTAMPTZ,
            approved_by_user_id TEXT
        )`);
    } catch (e) { }
    try { await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_nc_bindings_active
        ON pending_nc_bindings (org_id, nc_instance_id) WHERE status = 'pending'`); } catch (e) { }
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_pending_nc_bindings_org_status
        ON pending_nc_bindings (org_id, status)`); } catch (e) { }

    // Phase-2 pairing-code branch: org-admin generates a code in Bee Flow,
    // hands it to whoever installs the connector on a new NC. The code lives
    // in the same table as email-match pending bindings so the lifecycle
    // (pending/approved/denied/expired) stays unified. Nullable NC fields
    // because we don't know the target NC until the code is redeemed.
    try { await exec(`ALTER TABLE pending_nc_bindings
        ADD COLUMN IF NOT EXISTS pairing_code             TEXT,
        ADD COLUMN IF NOT EXISTS pairing_code_consumed_at TIMESTAMPTZ`); } catch (e) { }
    try { await exec(`ALTER TABLE pending_nc_bindings
        ALTER COLUMN nc_instance_id  DROP NOT NULL,
        ALTER COLUMN nc_base_url     DROP NOT NULL,
        ALTER COLUMN nc_admin_uid    DROP NOT NULL,
        ALTER COLUMN nc_admin_email  DROP NOT NULL`); } catch (e) { }
    try { await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_nc_bindings_pairing_code_active
        ON pending_nc_bindings (pairing_code)
        WHERE pairing_code IS NOT NULL
          AND status = 'pending'
          AND pairing_code_consumed_at IS NULL`); } catch (e) { }

    // Email-code verification branch: when a connector bootstraps and the NC
    // admin email's DOMAIN matches an existing un-bound org (or exactly matches
    // a user), we send a one-time code to that mailbox and let the admin confirm
    // the binding from inside the embedded Nextcloud view — no external SaaS
    // login. The code is hashed at rest (salted with org_id:nc_instance_id);
    // attempts are capped. These rows always carry a real nc_instance_id, which
    // distinguishes them from pairing-code rows (nc_instance_id NULL until
    // redeemed) and from plain approval rows (verification_code_hash NULL).
    try { await exec(`ALTER TABLE pending_nc_bindings
        ADD COLUMN IF NOT EXISTS verification_code_hash TEXT,
        ADD COLUMN IF NOT EXISTS verification_email      TEXT,
        ADD COLUMN IF NOT EXISTS verification_attempts   INTEGER DEFAULT 0`); } catch (e) { }

    // ── Subscription schema migrations ──
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price REAL`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'EUR'`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS billing_interval TEXT DEFAULT 'monthly'`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS trial_days INTEGER DEFAULT 0`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT FALSE`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS stripe_price_id TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS stripe_product_id TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS trial_end_date TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'none'`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS plan_type TEXT DEFAULT 'organization'`); } catch (e) { }
    // One-shot trial gate — set when a trial is granted/started, never cleared.
    // Survives subscription churn so an org/user cannot start a second trial
    // after cancelling the first.
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS trial_used_at TIMESTAMPTZ`); } catch (e) { }
    try { await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_used_at TIMESTAMPTZ`); } catch (e) { }
    // Trial history — email-scoped, all-time. The trial_used_at column on
    // orgs/users is ephemeral (gone when the row is hard-deleted), so a
    // delete-and-recreate with the same email defeats the one-shot gate.
    // This table is the durable enforcement: a (scope, email) pair can
    // appear at most once, ever.
    await exec(`
        CREATE TABLE IF NOT EXISTS trial_history (
            id SERIAL PRIMARY KEY,
            scope TEXT NOT NULL CHECK (scope IN ('organization','consumer')),
            email_normalized TEXT NOT NULL,
            subscriber_id TEXT,
            plan_id TEXT,
            stripe_customer_id TEXT,
            stripe_subscription_id TEXT,
            trial_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            trial_end_date TIMESTAMPTZ
        )
    `);
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_trial_history_scope_email ON trial_history(scope, email_normalized)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_trial_history_customer ON trial_history(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL`);
    // Plan-bound integrations + beta-feature allow-lists. Both act as a cap
    // (org cannot enable anything not in this list) AND a default-on bundle
    // applied when the plan is assigned. NULL = unrestricted (legacy plans).
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS allowed_integrations TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS allowed_beta_features TEXT`); } catch (e) { }
    // Pay-as-you-go (PAYG) plans: bill per actual usage with a markup % on
    // top of raw AI provider cost. `billing_model='metered'` swings the
    // plan onto a Stripe Billing Meter price; `markup_percent` applies on
    // top of `computeCost(...)` before the meter event is reported.
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS billing_model TEXT DEFAULT 'fixed'`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS markup_percent REAL DEFAULT 0`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS stripe_meter_id TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS stripe_meter_event_name TEXT`); } catch (e) { }
    // Per-seat billing: when true, Stripe checkout uses quantity = active seat
    // count and the effective max_messages_per_month is computed as
    // max_messages_per_seat × seat_count in getEffectiveLimits.
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS per_seat BOOLEAN DEFAULT FALSE`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_messages_per_seat INTEGER`); } catch (e) { }
    // Track the Stripe-side seat quantity on the subscription row so the
    // effective-cap computation stays in sync with the bill even when the
    // local user count and Stripe drift transiently.
    try { await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS stripe_seat_quantity INTEGER`); } catch (e) { }
    try { await exec(`UPDATE subscription_plans SET billing_model = 'fixed' WHERE billing_model IS NULL`); } catch (e) { }
    // Surfaced in the NC App Store onboarding wizard as the "Recommended for
    // Nextcloud" card. Only one plan can carry this flag at a time — the
    // admin-CRUD route enforces uniqueness on write.
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS nc_recommended BOOLEAN DEFAULT FALSE`); } catch (e) { }
    // Short marketing line shown under the plan name in the wizard cards.
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS tagline TEXT`); } catch (e) { }
    // Explicit tier mapping so license/index.js doesn't have to fall back to
    // substring-matching the plan name. Backfill from name on first run; the
    // admin Plans editor lets future plans set this explicitly.
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS tier TEXT`); } catch (e) { }
    try { await exec(`UPDATE subscription_plans SET tier = 'enterprise' WHERE tier IS NULL AND LOWER(name) LIKE '%enterprise%'`); } catch (e) { }
    try { await exec(`UPDATE subscription_plans SET tier = 'pro'        WHERE tier IS NULL AND LOWER(name) LIKE '%pro%'`); } catch (e) { }
    try { await exec(`UPDATE subscription_plans SET tier = 'community'  WHERE tier IS NULL AND (LOWER(name) LIKE '%community%' OR name = '__consumer_default__')`); } catch (e) { }
    // 'community' and 'full' are license-key tier concepts, not subscription
    // tiers. Strip them from subscription_plans so the cloud catalogue stays
    // clean; tier resolution still falls back to the community floor for
    // free/null-tier subscriptions, so behaviour is preserved.
    try {
        const result = await run(`UPDATE subscription_plans SET tier = NULL WHERE tier IN ('community', 'full') AND name <> '__consumer_default__'`);
        const n = result?.rowCount ?? 0;
        if (n > 0) console.log(`[UserStore] migrated ${n} subscription plan(s) off license-only tiers (community/full → NULL)`);
    } catch (e) { /* non-fatal */ }
    // Auto-migrate legacy __consumer_default__ plan
    try { await exec(`UPDATE subscription_plans SET plan_type = 'consumer' WHERE name = '__consumer_default__' AND (plan_type IS NULL OR plan_type = 'organization')`); } catch (e) { }
    // Consumer subscriptions table (per-user, org-less)
    try {
        await exec(`CREATE TABLE IF NOT EXISTS consumer_subscriptions (
            id TEXT PRIMARY KEY,
            user_id TEXT REFERENCES users(id),
            plan_id TEXT REFERENCES subscription_plans(id),
            status TEXT DEFAULT 'active',
            stripe_customer_id TEXT,
            stripe_subscription_id TEXT,
            payment_status TEXT DEFAULT 'none',
            billing_cycle_start TEXT,
            trial_end_date TEXT,
            created_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ
        )`);
    } catch (e) { }

    // ── Phase 2: Indexes on hot auth/org query paths ──────────────────────────
    // getUserByEmail() is called on every login — must be index-scanned
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(LOWER(email)) WHERE email IS NOT NULL`); } catch (e) { /* ok */ }
    // org-scoped queries (getUsersByOrg, admin lists)
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_users_org ON users("organizationId") WHERE "organizationId" IS NOT NULL AND "organizationId" != ''`); } catch (e) { /* ok */ }
    // Audit log index
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_audit_target ON subscription_audit_log(target_type, target_id)`); } catch (e) { }

    // ── License keys (signed JWT activations) ──
    try {
        await exec(`CREATE TABLE IF NOT EXISTS license_keys (
            id TEXT PRIMARY KEY,
            organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
            user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
            scope TEXT NOT NULL DEFAULT 'organization',
            raw_token TEXT NOT NULL,
            tier TEXT NOT NULL,
            issuer TEXT,
            issued_at TIMESTAMPTZ NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            billing_interval TEXT NOT NULL DEFAULT 'monthly',
            last_refresh_at TIMESTAMPTZ,
            refresh_status TEXT DEFAULT 'pending',
            revoked_at TIMESTAMPTZ,
            activated_by TEXT,
            metadata TEXT DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )`);
    } catch (e) { /* table already exists */ }
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_license_keys_org ON license_keys(organization_id) WHERE organization_id IS NOT NULL`); } catch (e) { }
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_license_keys_user ON license_keys(user_id) WHERE user_id IS NOT NULL`); } catch (e) { }
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_license_keys_status ON license_keys(refresh_status)`); } catch (e) { }

    // Stripe webhook idempotency. Stripe retries on 5xx/timeout, so every
    // event handler runs through a dedup check keyed on event.id. Rows older
    // than ~30d can be pruned out-of-band; the index keeps that scan cheap.
    try {
        await exec(`CREATE TABLE IF NOT EXISTS stripe_processed_events (
            event_id     TEXT PRIMARY KEY,
            event_type   TEXT NOT NULL,
            processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            payload_hash TEXT
        )`);
    } catch (e) { }
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_stripe_evt_processed_at ON stripe_processed_events(processed_at)`); } catch (e) { }

    // Notification idempotency. Each (target_id, notif_kind) pair can fire
    // at most once. Used by trial/dunning/expiry warnings so retries don't
    // double-email customers.
    try {
        await exec(`CREATE TABLE IF NOT EXISTS license_notifications_sent (
            target_id   TEXT NOT NULL,
            notif_kind  TEXT NOT NULL,
            sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (target_id, notif_kind)
        )`);
    } catch (e) { }

    // Dunning / payment-failure escalation columns. The webhook bumps the
    // attempt counter; a periodic tick flips status='suspended' after the
    // configured grace expires. invoice.paid resets both.
    try { await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS payment_attempt_count INTEGER DEFAULT 0`); } catch (e) { }
    try { await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS last_payment_failure_at TIMESTAMPTZ`); } catch (e) { }
    try { await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS past_due_since TIMESTAMPTZ`); } catch (e) { }
    try { await exec(`ALTER TABLE consumer_subscriptions ADD COLUMN IF NOT EXISTS payment_attempt_count INTEGER DEFAULT 0`); } catch (e) { }
    try { await exec(`ALTER TABLE consumer_subscriptions ADD COLUMN IF NOT EXISTS last_payment_failure_at TIMESTAMPTZ`); } catch (e) { }
    try { await exec(`ALTER TABLE consumer_subscriptions ADD COLUMN IF NOT EXISTS past_due_since TIMESTAMPTZ`); } catch (e) { }

    // Manual-override window (PR 2.B). Admin sets manual_override_until to a
    // timestamp; Stripe webhooks honour it by skipping status/plan_id writes
    // until it elapses. Audit-logged on both ends.
    try { await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS manual_override_until TIMESTAMPTZ`); } catch (e) { }
    try { await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS manual_override_by TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE consumer_subscriptions ADD COLUMN IF NOT EXISTS manual_override_until TIMESTAMPTZ`); } catch (e) { }
    try { await exec(`ALTER TABLE consumer_subscriptions ADD COLUMN IF NOT EXISTS manual_override_by TEXT`); } catch (e) { }

    // In-app cancel + period tracking. cancel_at_period_end mirrors Stripe's
    // flag so the UI can show a "cancels on …" banner; cancel_at and
    // current_period_end carry the timestamps needed for that banner without
    // a round-trip to Stripe. Populated by the customer.subscription.updated
    // webhook and by the cancel/reactivate endpoints.
    try { await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE`); } catch (e) { }
    try { await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS cancel_at TIMESTAMPTZ`); } catch (e) { }
    try { await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ`); } catch (e) { }
    try { await exec(`ALTER TABLE consumer_subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE`); } catch (e) { }
    try { await exec(`ALTER TABLE consumer_subscriptions ADD COLUMN IF NOT EXISTS cancel_at TIMESTAMPTZ`); } catch (e) { }
    try { await exec(`ALTER TABLE consumer_subscriptions ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ`); } catch (e) { }

    // Deferred (end-of-period) downgrade. When an org downgrades to a cheaper
    // plan we don't switch immediately — a Stripe Subscription Schedule flips
    // the price at the cycle boundary. These two columns record the pending
    // target + effective date so the UI can show a "downgrade scheduled" banner;
    // the customer.subscription.updated webhook clears them once the new price
    // becomes active.
    try { await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS pending_plan_id TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS pending_plan_effective TIMESTAMPTZ`); } catch (e) { }
    try { await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS stripe_schedule_id TEXT`); } catch (e) { }

    // Seed a single €0 "Free" org plan once. New orgs auto-assign whichever
    // plan carries is_default (see loginRoutes/oauthRoutes), so Free becomes
    // the no-payment default tier and can be assigned from the admin Orgs view.
    // Only runs when no Free org plan exists yet — never clobbers admin edits.
    try {
        // Skip if ANY free org tier already exists (a plan named 'Free' OR any
        // €0 org plan) — avoids seeding a duplicate when the operator has
        // already created their own free plan (e.g. "Bee Flow Free").
        const existingFree = await getOne(
            `SELECT id FROM subscription_plans
              WHERE (plan_type = 'organization' OR plan_type IS NULL)
                AND (name = 'Free' OR price = 0)
              LIMIT 1`
        );
        if (!existingFree) {
            const freeId = crypto.randomUUID();
            // Preserve the single-default invariant the admin CRUD enforces.
            await run(`UPDATE subscription_plans SET is_default = FALSE WHERE is_default = TRUE`);
            await run(
                `INSERT INTO subscription_plans (
                    id, name, plan_type, description, price, currency, billing_interval, billing_model,
                    markup_percent, trial_days, max_cost_per_month, max_users, max_agents, max_knowledge_sources,
                    allowed_features, allowed_models, allowed_integrations, allowed_beta_features,
                    is_public, is_default, nc_recommended, sort_order, created_at, updated_at
                 ) VALUES (
                    $1, 'Free', 'organization', 'Free tier — limited AI usage, no payment required.', 0, 'EUR', 'monthly', 'fixed',
                    0, 0, 5, 3, 1, 5,
                    '[]', '[]', '[]', '[]',
                    FALSE, TRUE, FALSE, 0, NOW(), NOW()
                 )`,
                [freeId]
            );
            console.log('[UserStore] seeded default Free org plan', freeId);
        }
    } catch (e) { console.warn('[UserStore] Free plan seed skipped:', e.message); }

    // Seat-cap atomic enforcement support index (PR 1.C). The serializable
    // transaction in createUserWithSeatCheck reads a COUNT()...FOR UPDATE
    // and benefits from a covering partial index.
    try {
        await exec(`CREATE INDEX IF NOT EXISTS idx_users_org_status
            ON users ("organizationId", status)
            WHERE "organizationId" IS NOT NULL AND "organizationId" != ''`);
    } catch (e) { }

    initialized = true;
}

initDB().catch(err => console.error('[UserStore] Init error:', err.message));

// ── Dynamic UPDATE helper ─────────────────────────────
// PG has no COALESCE(?, col) trick so we build SET clauses dynamically
function dynamicUpdate(table, id, updates, columnMapping, whereCol = 'id') {
    const setClauses = [];
    const params = [];
    let idx = 1;
    for (const [jsKey, dbCol] of Object.entries(columnMapping)) {
        if (updates[jsKey] !== undefined) {
            setClauses.push(`"${dbCol}" = $${idx++}`);
            params.push(updates[jsKey]);
        }
    }
    if (setClauses.length === 0) return null;
    params.push(id);
    return { sql: `UPDATE ${table} SET ${setClauses.join(', ')} WHERE "${whereCol}" = $${idx}`, params };
}

// ── Migration from JSON ─────────────────────────────
const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const ROLES_FILE = path.join(DATA_DIR, 'roles.json');

async function migrateJsonToDb() {
    await initDB();
    if (fs.existsSync(USERS_FILE)) {
        try {
            const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
            for (const [id, u] of Object.entries(users)) {
                const existing = await getOne('SELECT id FROM users WHERE id = $1', [id]);
                if (!existing) {
                    const mwDek = u.masterWrappedDEK ? (typeof u.masterWrappedDEK === 'string' ? u.masterWrappedDEK : JSON.stringify(u.masterWrappedDEK)) : null;
                    const wDek = u.wrappedDEK ? (typeof u.wrappedDEK === 'string' ? u.wrappedDEK : JSON.stringify(u.wrappedDEK)) : null;
                    await run(`INSERT INTO users (id, username, "displayName", "passwordHash", role, groups, "masterWrappedDEK", "wrappedDEK", "orgRole", "organizationId", "createdAt")
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,

                        [id, u.username, u.displayName || u.username, u.passwordHash, u.role || 'user',
                            JSON.stringify(u.groups || []), mwDek, wDek, '', '',
                            u.createdAt || new Date().toISOString().split('T')[0]]);
                    if (u.appPassword) {
                        await run('UPDATE users SET "appPassword" = $1, "appPasswordCreated" = $2 WHERE id = $3',
                            [typeof u.appPassword === 'object' ? JSON.stringify(u.appPassword) : u.appPassword, u.appPasswordCreated || new Date().toISOString(), id]);
                    }
                }
            }
            fs.renameSync(USERS_FILE, `${USERS_FILE}.bak`);
            console.log('[UserStore] Migrated users.json to database');
        } catch (err) { console.error('[UserStore] Failed to migrate users.json:', err); }
    }
    if (fs.existsSync(GROUPS_FILE)) {
        try {
            const groups = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
            for (const [id, g] of Object.entries(groups)) {
                const ex = await getOne('SELECT id FROM groups WHERE id = $1', [id]);
                if (!ex) await run('INSERT INTO groups (id, "organizationId", name, description, permissions, roles, "userCount") VALUES ($1,$2,$3,$4,$5,$6,$7)',
                    [id, null, g.name, g.description || '', JSON.stringify(g.permissions || []), JSON.stringify(g.roles || []), g.userCount || 0]);
            }
            fs.renameSync(GROUPS_FILE, `${GROUPS_FILE}.bak`);
            console.log('[UserStore] Migrated groups.json to database');
        } catch (err) { console.error('[UserStore] Failed to migrate groups.json:', err); }
    }
    if (fs.existsSync(ROLES_FILE)) {
        try {
            const roles = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
            for (const [id, r] of Object.entries(roles)) {
                const ex = await getOne('SELECT id FROM roles WHERE id = $1', [id]);
                if (!ex) await run('INSERT INTO roles (id, name, description, permissions) VALUES ($1,$2,$3,$4)',
                    [id, r.name, r.description || '', JSON.stringify(r.permissions || [])]);
            }
            fs.renameSync(ROLES_FILE, `${ROLES_FILE}.bak`);
            console.log('[UserStore] Migrated roles.json to database');
        } catch (err) { console.error('[UserStore] Failed to migrate roles.json:', err); }
    }
}

migrateJsonToDb().catch(err => console.error('[UserStore] Migration error:', err.message));

// ── Encryption (app passwords) ─────────────────────────────
const ALGORITHM = 'aes-256-gcm';
const APP_PWD_IV_LENGTH = 12;

function getEncryptionKey() {
    const secret = process.env.MASTER_ENCRYPTION_KEY || process.env.SESSION_SECRET;
    if (!secret) throw new Error('MASTER_ENCRYPTION_KEY or SESSION_SECRET env var is required');
    return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(text) {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(APP_PWD_IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return { iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex'), data: encrypted };
}

function decrypt(encrypted) {
    if (typeof encrypted === 'string') { try { encrypted = JSON.parse(encrypted); } catch (e) { return null; } }
    try {
        const key = getEncryptionKey();
        const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, 'hex'));
        decipher.setAuthTag(Buffer.from(encrypted.authTag, 'hex'));
        let decrypted = decipher.update(encrypted.data, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (err) { console.error('Decryption failed:', err.message); return null; }
}

function parseJSON(str, fallback) { if (!str) return fallback; try { return JSON.parse(str); } catch (e) { return fallback; } }

// ── Users ─────────────────────────────
async function getAllUsers() {
    await initDB();
    // Phase 2: exclude avatar (base64 blob, up to 200 KB per user) from list
    // queries — callers that need the avatar should use getUser(id) instead.
    const rows = await getAll(`
        SELECT id, username, "displayName", "firstName", "lastName", email, phone,
               "avatarType", role, groups, "orgRole", "organizationId",
               "masterWrappedDEK", "wrappedDEK", "kekSalt", "recoverySalt",
               "recoveryWrappedDEK", "ssoEncryptionSetup", "passwordResetRequired",
               "dekUnwrapFailures", "dekLockoutUntil", "kdfMode", "createdAt",
               status, "activeIconPackId", "azureUserId",
               "nc_uid", "provider", "auto_provisioned"
        FROM users
    `);
    return rows.map(u => {
        return { ...u, groups: parseJSON(u.groups, []), masterWrappedDEK: parseJSON(u.masterWrappedDEK, u.masterWrappedDEK), wrappedDEK: parseJSON(u.wrappedDEK, u.wrappedDEK) };
    });
}

// Lightweight list that *does* include the avatar blob. Use only when callers
// need to render avatars for many users (e.g. the usage / monitoring page).
async function getAllUserAvatars() {
    await initDB();
    return getAll(`SELECT id, username, "displayName", "avatarType", avatar FROM users`);
}


async function getUser(userId) {
    await initDB();
    const u = await getOne('SELECT * FROM users WHERE id = $1', [userId]);
    if (!u) return null;
    return {
        ...u, groups: parseJSON(u.groups, []), appPassword: parseJSON(u.appPassword, u.appPassword),
        masterWrappedDEK: parseJSON(u.masterWrappedDEK, u.masterWrappedDEK), wrappedDEK: parseJSON(u.wrappedDEK, u.wrappedDEK),
        recoveryWrappedDEK: parseJSON(u.recoveryWrappedDEK, u.recoveryWrappedDEK),
        dekUnwrapFailures: u.dekUnwrapFailures || 0, ssoEncryptionSetup: u.ssoEncryptionSetup || 0,
        passwordResetRequired: u.passwordResetRequired || 0
    };
}

async function getUserByEmail(email) {
    await initDB();
    const u = await getOne('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (!u) return null;
    return {
        ...u, groups: parseJSON(u.groups, []), appPassword: parseJSON(u.appPassword, u.appPassword),
        masterWrappedDEK: parseJSON(u.masterWrappedDEK, u.masterWrappedDEK), wrappedDEK: parseJSON(u.wrappedDEK, u.wrappedDEK),
        recoveryWrappedDEK: parseJSON(u.recoveryWrappedDEK, u.recoveryWrappedDEK),
        dekUnwrapFailures: u.dekUnwrapFailures || 0, ssoEncryptionSetup: u.ssoEncryptionSetup || 0,
        passwordResetRequired: u.passwordResetRequired || 0
    };
}

async function createUser(userData) {
    await initDB();
    const { id, username, passwordHash, displayName, firstName, lastName, email, phone, avatar, avatarType, role, groups, orgRole, organizationId, ncUid, provider, autoProvisioned } = userData;
    const existing = await getOne('SELECT id FROM users WHERE id = $1', [id]);
    if (existing) return false;
    try {
        const mwDek = userData.masterWrappedDEK ? (typeof userData.masterWrappedDEK === 'string' ? userData.masterWrappedDEK : JSON.stringify(userData.masterWrappedDEK)) : null;
        const wDek = userData.wrappedDEK ? (typeof userData.wrappedDEK === 'string' ? userData.wrappedDEK : JSON.stringify(userData.wrappedDEK)) : null;
        await run(`INSERT INTO users (id, username, "displayName", "firstName", "lastName", email, phone, avatar, "avatarType", "passwordHash", role, groups, "masterWrappedDEK", "wrappedDEK", "orgRole", "organizationId", "createdAt", status, "azureUserId", "nc_uid", "provider", "auto_provisioned")
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
            [id, username, displayName || username, firstName || null, lastName || null, email || null, phone || null,
                avatar || null, avatarType || null, passwordHash, role || 'user',
                JSON.stringify(groups || []), mwDek, wDek, orgRole || '', organizationId || '',
                new Date().toISOString().split('T')[0], userData.status || 'active', userData.azureUserId || null,
                ncUid || null, provider || null, autoProvisioned ? true : false]);
        return true;
    } catch (e) { console.error(e); return false; }
}

async function getUserByNcUid(organizationId, ncUid) {
    if (!organizationId || !ncUid) return null;
    await initDB();
    const u = await getOne('SELECT * FROM users WHERE "organizationId" = $1 AND "nc_uid" = $2', [organizationId, ncUid]);
    if (!u) return null;
    // Match the shape produced by getUser/getUserByEmail — JSON columns are
    // parsed so callers can rely on `groups` being an array. Without this
    // ncUserGroupSync's group-diff comparisons silently rewrite every sync.
    return { ...u, groups: parseJSON(u.groups, []), appPassword: parseJSON(u.appPassword, u.appPassword) };
}

async function deleteUser(userId) {
    await initDB();
    // Capture the org before DELETE so we can sync Stripe seat quantity
    // afterwards. NULL orgId users (consumer accounts) skip the sync.
    let orgIdForSeatSync = null;
    try {
        const owner = await getOne('SELECT "organizationId" FROM users WHERE id = $1', [userId]);
        orgIdForSeatSync = owner?.organizationId || null;
    } catch (_) { /* best-effort */ }
    const { rowCount } = await run('DELETE FROM users WHERE id = $1', [userId]);
    if (rowCount === 0) return false;

    console.log(`[UserStore] Cleaning up data for deleted user '${userId}'...`);
    try {
        const configStore = require('./configStore');
        const configKeys = [
            `fireflies_api_key_user_${userId}`, `youtrack_url_user_${userId}`, `youtrack_token_user_${userId}`,
            `signrequest_subdomain_user_${userId}`, `signrequest_token_user_${userId}`,
            `gamma_api_key_user_${userId}`, `gads_developer_token_user_${userId}`, `gads_manager_id_user_${userId}`,
            `gads_customer_id_user_${userId}`, `enabled_apps_user_${userId}`,
        ];
        for (const key of configKeys) await configStore.deleteConfig(key);
    } catch (e) { console.error('[UserStore] Failed to clean user config keys:', e.message); }

    try { await run('DELETE FROM user_memories WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }
    try { await run('DELETE FROM agent_conversations WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }
    try { await run('DELETE FROM direct_conversations WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }
    try { await run('DELETE FROM execution_history WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }
    // OAuth refresh tokens for long-running routines. If we leave these
    // behind, the encrypted secret is still in the DB after user delete,
    // and a future user with the same id (rare but possible) could inherit
    // it. App passwords live on the users row itself and are dropped by
    // the DELETE FROM users above.
    try { await run('DELETE FROM routine_credentials WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }
    // Projects: drop the user's owned projects (cascades shares + activity via FK)
    // and remove any shares that target this user directly.
    try { await run('DELETE FROM projects WHERE owner_id = $1', [userId]); } catch (e) { /* table may not exist */ }
    try { await run(`DELETE FROM project_shares WHERE shared_with_type = 'user' AND shared_with_id = $1`, [userId]); } catch (e) { /* table may not exist */ }

    try {
        const notificationStore = require('./notificationStore');
        if (notificationStore.deleteUserNotifications) await notificationStore.deleteUserNotifications(userId);
    } catch (e) { /* PG store may not be initialized */ }

    console.log(`[UserStore] Cleanup complete for user '${userId}'`);
    // Per-seat plans rebill on user count change. Fire-and-forget — Stripe
    // outages don't block the delete; the webhook reconciles afterwards.
    if (orgIdForSeatSync) {
        Promise.resolve().then(async () => {
            try {
                const { syncSeatQuantityForOrg } = require('../services/stripeService');
                await syncSeatQuantityForOrg(orgIdForSeatSync);
            } catch (_) { /* best-effort */ }
        });
    }
    return true;
}

async function updateUser(userId, updates) {
    await initDB();
    const existing = await getOne('SELECT * FROM users WHERE id = $1', [userId]);
    if (!existing) return false;

    const serializeDek = (val) => {
        if (val === null) return null;
        if (val === undefined) return undefined;
        return typeof val === 'string' ? val : JSON.stringify(val);
    };

    // Build update map: jsKey → dbCol
    const updateMap = {};
    const colMap = {
        username: 'username', displayName: 'displayName', firstName: 'firstName', lastName: 'lastName',
        email: 'email', phone: 'phone', avatar: 'avatar', avatarType: 'avatarType',
        passwordHash: 'passwordHash', role: 'role', orgRole: 'orgRole', organizationId: 'organizationId',
        kekSalt: 'kekSalt', recoverySalt: 'recoverySalt', ssoEncryptionSetup: 'ssoEncryptionSetup',
        passwordResetRequired: 'passwordResetRequired', dekUnwrapFailures: 'dekUnwrapFailures',
        dekLockoutUntil: 'dekLockoutUntil', opaqueRecord: 'opaqueRecord', kdfMode: 'kdfMode',
        status: 'status', activeIconPackId: 'activeIconPackId', azureUserId: 'azureUserId',
        ncUid: 'nc_uid', provider: 'provider', autoProvisioned: 'auto_provisioned',
    };

    for (const [jsKey, dbCol] of Object.entries(colMap)) {
        if (updates[jsKey] !== undefined) updateMap[jsKey] = updates[jsKey];
    }

    // Special serialization
    if (updates.groups !== undefined) updateMap.groups = JSON.stringify(updates.groups);
    if (updates.wrappedDEK !== undefined) updateMap.wrappedDEK = serializeDek(updates.wrappedDEK);
    if (updates.masterWrappedDEK !== undefined) updateMap.masterWrappedDEK = serializeDek(updates.masterWrappedDEK);
    if (updates.recoveryWrappedDEK !== undefined) updateMap.recoveryWrappedDEK = serializeDek(updates.recoveryWrappedDEK);

    try {
        const fullColMap = { ...colMap, groups: 'groups', wrappedDEK: 'wrappedDEK', masterWrappedDEK: 'masterWrappedDEK', recoveryWrappedDEK: 'recoveryWrappedDEK' };
        const q = dynamicUpdate('users', userId, updateMap, fullColMap);
        if (q) await run(q.sql, q.params);
        return true;
    } catch (e) { console.error(e); return false; }
}

// ── Organizations ─────────────────────────────
function parseOrg(o) {
    return {
        ...o,
        defaultGroups: parseJSON(o.defaultGroups, []),
        allowSignup: o.allowSignup === '1' || o.allowSignup === true,
        autoApproveSSO: o.autoApproveSSO === '1' || o.autoApproveSSO === true,
        // Default '1' = pooled (matches legacy behaviour) when the column
        // is null on rows older than the migration.
        usagePooled: (o.usage_pooled ?? '1') !== '0',
        allowedDomains: parseJSON(o.allowed_domains, []),
        ncSyncGroups: parseJSON(o.nc_sync_groups, []),
        ncSyncExcludedGroups: parseJSON(o.nc_sync_excluded_groups, []),
        orgEnabledIntegrations: parseJSON(o.org_enabled_integrations, []),
        orgEnabledBetaFeatures: parseJSON(o.org_enabled_beta_features, []),
    };
}

async function getOrganizationByNcInstanceId(ncInstanceId) {
    if (!ncInstanceId) return null;
    await initDB();
    const o = await getOne('SELECT * FROM organizations WHERE nc_instance_id = $1', [ncInstanceId]);
    return o ? parseOrg(o) : null;
}

async function getAllOrganizations() {
    await initDB();
    const rows = await getAll('SELECT * FROM organizations');
    return rows.map(parseOrg);
}

// Find an un-bound organisation that "owns" an email domain, used by the
// connector bootstrap to route a same-domain Nextcloud install into the
// email-code verification flow (vs. creating a fresh org). Matches either an
// org_admin user whose email is at the domain, or an org whose admin-configured
// allowed_domains lists it. Callers MUST exclude free/public email providers
// before calling — this does not (a corporate domain implies the company
// controls its mailboxes). Returns null when nothing matches.
async function findUnboundOrgByEmailDomain(domain) {
    const d = String(domain || '').toLowerCase().trim();
    if (!d || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return null;
    await initDB();
    const byAdmin = await getOne(
        `SELECT o.* FROM organizations o
         JOIN users u ON u."organizationId" = o.id
         WHERE u."orgRole" = 'org_admin'
           AND LOWER(u.email) LIKE '%@' || $1
           AND o.nc_instance_id IS NULL
         ORDER BY o.id ASC
         LIMIT 1`,
        [d]
    );
    if (byAdmin) return parseOrg(byAdmin);
    // allowed_domains is a JSON array string; match the quoted element so a
    // domain can't accidentally match as a substring of a longer one.
    const byAllowed = await getOne(
        `SELECT * FROM organizations
         WHERE nc_instance_id IS NULL
           AND allowed_domains IS NOT NULL
           AND allowed_domains ILIKE '%"' || $1 || '"%'
         ORDER BY id ASC
         LIMIT 1`,
        [d]
    );
    return byAllowed ? parseOrg(byAllowed) : null;
}

async function getOrganization(id) {
    await initDB();
    const o = await getOne('SELECT * FROM organizations WHERE id = $1', [id]);
    if (!o) return null;
    return parseOrg(o);
}

async function createOrganization(orgData) {
    await initDB();
    const { id, name, description, tagline, address, email, phone, website, kvk, vat, logo, footerText, defaultGroups, allowSignup, authMethod, autoApproveSSO, enabledIntegrations, allowedDomains, ncInstanceId, ncBaseUrl, ncAdminUid, ncProvisionedAt, connectorCallbackUrl } = orgData;
    const ex = await getOne('SELECT id FROM organizations WHERE id = $1', [id]);
    if (ex) return false;
    try {
        await run(`INSERT INTO organizations (id, name, description, tagline, address, email, phone, website, kvk, vat, logo, "footerText", "defaultGroups", "allowSignup", "authMethod", "autoApproveSSO", "enabledIntegrations", "allowed_domains", "nc_instance_id", "nc_base_url", "nc_admin_uid", "nc_provisioned_at", "connector_callback_url")
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
            [id, name, description || '', tagline || '', address || '', email || '', phone || '', website || '', kvk || '', vat || '', logo || '', footerText || '', JSON.stringify(defaultGroups || []), allowSignup ? '1' : '0', authMethod || null, autoApproveSSO ? '1' : '0', enabledIntegrations ? JSON.stringify(enabledIntegrations) : null, allowedDomains ? JSON.stringify(allowedDomains) : null, ncInstanceId || null, ncBaseUrl || null, ncAdminUid || null, ncProvisionedAt || null, connectorCallbackUrl || null]);
        // Auto-assign default subscription plan if one exists — cloud only.
        // Self-hosted (incl. the retired 'private-cloud' value) never seeds a
        // Stripe subscription row; tier is server-licence or Community, resolved
        // without ever consulting subscriptions.
        try {
            const subscriptionsEnabled = (process.env.DEPLOYMENT_MODE || 'cloud') === 'cloud';
            const defaultPlan = subscriptionsEnabled
                ? await getOne('SELECT id FROM subscription_plans WHERE is_default = TRUE LIMIT 1')
                : null;
            if (defaultPlan) {
                await setOrgSubscription(id, { plan_id: defaultPlan.id, status: 'active' });
                console.log(`[UserStore] Auto-assigned default plan '${defaultPlan.id}' to new org '${id}'`);
                // Seed integrations + beta-feature enablement from the plan
                // so new orgs immediately have the right defaults switched on.
                try {
                    await require('../services/planEntitlements').applyPlanToOrg(id, defaultPlan.id, { mode: 'reset' });
                } catch (e) { console.warn('[UserStore] applyPlanToOrg (default plan) failed:', e.message); }
            }
        } catch (e) { console.warn('[UserStore] Failed to auto-assign default plan:', e.message); }
        // Fire-and-forget: if a global trial-offer plan is configured for orgs,
        // start the trial in Stripe asynchronously. Failure must not block org
        // creation; trialService swallows errors and logs warnings.
        setImmediate(() => {
            require('../services/trialService').maybeAutoGrantOrgTrial(id);
        });
        // Pre-generate the outbound webhook signing key so the very first
        // outbound webhook for this org carries a valid signature. Lazy
        // generation in webhookSigner.js remains as a safety net, but should
        // not be the primary path. Failures here are logged and ignored —
        // the lazy generator will fill in.
        setImmediate(async () => {
            try {
                const configStore = require('./configStore');
                const key = `org_webhook_signing_key_${id}`;
                const existing = await configStore.getSecret(key).catch(() => null);
                if (existing && typeof existing === 'string' && existing.length >= 32) return;
                const crypto = require('crypto');
                const fresh = crypto.randomBytes(32).toString('hex');
                await configStore.setSecret(key, fresh, { auditCtx: { actor: 'system', org: id } }).catch(() => {});
            } catch (e) {
                console.warn('[UserStore] failed to pre-generate webhook signing key:', e.message);
            }
        });
        return true;
    } catch (e) { console.error(e); return false; }
}

async function updateOrganization(orgId, updates) {
    await initDB();
    const ex = await getOne('SELECT id FROM organizations WHERE id = $1', [orgId]);
    if (!ex) return false;
    const colMap = { name: 'name', description: 'description', tagline: 'tagline', address: 'address', email: 'email', phone: 'phone', website: 'website', kvk: 'kvk', vat: 'vat', logo: 'logo', footerText: 'footerText', authMethod: 'authMethod', connectorCallbackUrl: 'connector_callback_url', ncSyncMode: 'nc_sync_mode', ncNewUserDefaultStatus: 'nc_new_user_default_status', ncLastSyncAt: 'nc_last_sync_at', ncInstanceId: 'nc_instance_id', ncBaseUrl: 'nc_base_url', ncAdminUid: 'nc_admin_uid', ncProvisionedAt: 'nc_provisioned_at', ncOnboardingCompletedAt: 'nc_onboarding_completed_at', deploymentMode: 'deployment_mode', selectedPlanId: 'selected_plan_id', status: 'status' };
    const updateMap = {};
    for (const [k, v] of Object.entries(colMap)) { if (updates[k] !== undefined) updateMap[k] = updates[k]; }
    if (updates.defaultGroups !== undefined) updateMap.defaultGroups = JSON.stringify(updates.defaultGroups);
    if (updates.allowSignup !== undefined) updateMap.allowSignup = updates.allowSignup ? '1' : '0';
    if (updates.autoApproveSSO !== undefined) updateMap.autoApproveSSO = updates.autoApproveSSO ? '1' : '0';
    if (updates.usagePooled !== undefined) updateMap.usage_pooled = updates.usagePooled ? '1' : '0';
    if (updates.enabledIntegrations !== undefined) updateMap.enabledIntegrations = updates.enabledIntegrations === null ? null : JSON.stringify(updates.enabledIntegrations);
    if (updates.allowedDomains !== undefined) updateMap.allowed_domains = updates.allowedDomains === null ? null : JSON.stringify(updates.allowedDomains);
    if (updates.ncSyncGroups !== undefined) updateMap.nc_sync_groups = JSON.stringify(updates.ncSyncGroups);
    if (updates.ncSyncExcludedGroups !== undefined) updateMap.nc_sync_excluded_groups = JSON.stringify(updates.ncSyncExcludedGroups);
    const fullColMap = { ...colMap, defaultGroups: 'defaultGroups', allowSignup: 'allowSignup', autoApproveSSO: 'autoApproveSSO', usage_pooled: 'usage_pooled', enabledIntegrations: 'enabledIntegrations', allowed_domains: 'allowed_domains', nc_sync_groups: 'nc_sync_groups', nc_sync_excluded_groups: 'nc_sync_excluded_groups' };
    try {
        const q = dynamicUpdate('organizations', orgId, updateMap, fullColMap);
        if (q) await run(q.sql, q.params);
        return true;
    } catch (e) { console.error(e); return false; }
}

// ── Org-admin "active" subsets ────────────────────────────────────
// These are the per-org enablement lists the ORG admin controls (as
// opposed to enabledIntegrations / beta_features which the SUPER admin
// controls). Runtime gates intersect with the super-admin lists, so a
// stale entry here cannot grant access to something the super admin
// hasn't allowed.

async function getOrgEnabledIntegrations(orgId) {
    await initDB();
    const o = await getOne('SELECT "org_enabled_integrations" FROM organizations WHERE id = $1', [orgId]);
    return parseJSON(o?.org_enabled_integrations, []);
}

async function setOrgEnabledIntegrations(orgId, ids) {
    await initDB();
    const clean = Array.isArray(ids) ? Array.from(new Set(ids.filter(Boolean))) : [];
    const { rowCount } = await run(
        'UPDATE organizations SET "org_enabled_integrations" = $1 WHERE id = $2',
        [JSON.stringify(clean), orgId]
    );
    return rowCount > 0;
}

async function getOrgEnabledBetaFeatures(orgId) {
    await initDB();
    const o = await getOne('SELECT "org_enabled_beta_features" FROM organizations WHERE id = $1', [orgId]);
    return parseJSON(o?.org_enabled_beta_features, []);
}

async function setOrgEnabledBetaFeatures(orgId, ids) {
    await initDB();
    const clean = Array.isArray(ids) ? Array.from(new Set(ids.filter(Boolean))) : [];
    const { rowCount } = await run(
        'UPDATE organizations SET "org_enabled_beta_features" = $1 WHERE id = $2',
        [JSON.stringify(clean), orgId]
    );
    return rowCount > 0;
}

async function deleteOrganization(orgId) {
    await initDB();
    const org = await getOne('SELECT id, nc_instance_id FROM organizations WHERE id = $1', [orgId]);
    if (!org) return false;
    console.log(`[UserStore] Deleting organization '${orgId}' and all related data...`);

    try {
        const orgUsers = await getAll('SELECT id FROM users WHERE "organizationId" = $1', [orgId]);
        for (const u of orgUsers) await deleteUser(u.id);
        if (orgUsers.length > 0) console.log(`[UserStore] Deleted ${orgUsers.length} user(s) from org '${orgId}'`);
    } catch (e) { console.error('[UserStore] Failed to delete org users:', e.message); }

    try { await run('DELETE FROM groups WHERE "organizationId" = $1', [orgId]); } catch (e) { }
    try { await run('DELETE FROM organization_subscriptions WHERE organization_id = $1', [orgId]); } catch (e) { }

    // Wipe the per-org tenant key so a stale connector cache can't keep
    // presenting JWTs signed by the deleted org's key after the admin nukes
    // the org row.
    try {
        await run(`DELETE FROM config WHERE key = $1`, [`connector_tenant_key_${orgId}`]);
    } catch (e) { console.warn('[UserStore] connector tenant key cleanup failed:', e.message); }
    // Wipe every per-org row in the config store. Pre-M3 this was a curated
    // list of known suffixes (privacy shield only); now that secrets are
    // keyed under `org_<orgId>_*` consistently, delete everything matching.
    try {
        const { rowCount: cfgDeleted } = await run(`DELETE FROM config WHERE key LIKE $1`, [`org_${orgId}_%`]);
        if (cfgDeleted > 0) console.log(`[UserStore] Deleted ${cfgDeleted} per-org config row(s) for '${orgId}'`);
        const configStore = require('./configStore');
        // Legacy suffix pattern (`org_privacy_shield_<id>`) — keep deleting
        // by exact key for one release window so older deploys clean up.
        await configStore.deleteConfig(`org_privacy_shield_${orgId}`);
    } catch (e) { console.warn('[UserStore] config cleanup for org failed:', e.message); }

    try {
        const orgAgents = await getAll('SELECT id FROM agents WHERE organization_id = $1', [orgId]);
        for (const agent of orgAgents) { try { await run('DELETE FROM agent_conversations WHERE agent_id = $1', [agent.id]); } catch (_) { } }
        await run('DELETE FROM agents WHERE organization_id = $1', [orgId]);
    } catch (e) { }

    // Knowledge bases cleanup
    try { await run('DELETE FROM knowledge_bases WHERE organization_id = $1', [orgId]); } catch (e) { }

    // Projects (cascades shares + activity via FK). Group shares targeting this
    // org's groups are wiped by the groups DELETE above; user shares targeting
    // org users were cleaned up when those users were deleted.
    try { await run('DELETE FROM projects WHERE organization_id = $1', [orgId]); } catch (e) { }

    try { await run('DELETE FROM group_chats WHERE organization_id = $1', [orgId]); } catch (e) { }

    // Tasks DB cleanup (same PG pool now)
    try { await run('DELETE FROM tasks WHERE organization_id = $1', [orgId]); } catch (e) { }
    try {
        const customTables = await getAll('SELECT table_name FROM custom_tables WHERE organization_id = $1', [orgId]);
        for (const ct of customTables) { const safeName = ct.table_name.replace(/[^a-zA-Z0-9_]/g, ''); try { await run(`DROP TABLE IF EXISTS "${safeName}"`); } catch (_) { } }
        await run('DELETE FROM custom_tables WHERE organization_id = $1', [orgId]);
    } catch (e) { }
    try {
        const dashboards = await getAll('SELECT id FROM dashboards WHERE organization_id = $1', [orgId]);
        if (dashboards.length > 0) { const ids = dashboards.map(d => d.id); await run('DELETE FROM dashboard_panels WHERE dashboard_id = ANY($1)', [ids]); }
        await run('DELETE FROM dashboards WHERE organization_id = $1', [orgId]);
    } catch (e) { }
    try { await run('DELETE FROM import_configs WHERE organization_id = $1', [orgId]); } catch (e) { }

    await run('DELETE FROM organizations WHERE id = $1', [orgId]);
    console.log(`[UserStore] Organization '${orgId}' deleted successfully`);
    return true;
}

// ── Groups ─────────────────────────────
// ── Pending NC bindings ───────────────────────────────────────────────────

function parsePendingBinding(row) {
    if (!row) return null;
    return {
        id: row.id,
        orgId: row.org_id,
        ncInstanceId: row.nc_instance_id,
        ncBaseUrl: row.nc_base_url,
        ncAdminUid: row.nc_admin_uid,
        ncAdminEmail: row.nc_admin_email,
        ncAdminDisplayName: row.nc_admin_display_name,
        connectorCallbackUrl: row.connector_callback_url,
        themingName: row.theming_name,
        ncVersion: row.nc_version,
        status: row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        approvedAt: row.approved_at,
        approvedByUserId: row.approved_by_user_id,
        pairingCode: row.pairing_code || null,
        pairingCodeConsumedAt: row.pairing_code_consumed_at || null,
        verificationEmail: row.verification_email || null,
        verificationAttempts: row.verification_attempts || 0,
        hasVerification: !!row.verification_code_hash,
    };
}

// ── Email-code verification helpers ──
const NC_VERIFICATION_TTL_SECONDS = 15 * 60;
const NC_VERIFICATION_MAX_ATTEMPTS = 5;

// Salt the code hash with org_id:nc_instance_id (both stable across the
// createPendingNcVerification upsert) rather than the row id — ON CONFLICT keeps
// the original row id, so an id-based salt would desync on re-bootstrap.
function _hashNcVerificationCode(orgId, ncInstanceId, code) {
    return crypto.createHash('sha256')
        .update(`${orgId}:${ncInstanceId}:${code}`)
        .digest('hex');
}

function _ncCodeMatches(row, code) {
    if (!row?.verification_code_hash || !code) return false;
    const expected = _hashNcVerificationCode(row.org_id, row.nc_instance_id, code);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(String(row.verification_code_hash), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Pairing-code helpers (Phase 2 branch B) ──

// Generate a human-friendly 8-char code split with a dash (e.g. "BEEF-FL0W").
// Excludes ambiguous glyphs (0/O, 1/I/L, etc.) so the admin can read it off a
// screen and type it on another machine without mistakes.
function _generatePairingCodeString() {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
    const pickN = (n) => Array.from(crypto.randomBytes(n))
        .map(b => alphabet[b % alphabet.length])
        .join('');
    return `${pickN(4)}-${pickN(4)}`;
}

// Mint a new pairing code for an org. Caller (the SaaS endpoint) is responsible
// for org-admin auth. We always create a fresh row — the unique index on
// pairing_code (active) prevents two unused codes from colliding by chance.
async function createOrgPairingCode(orgId, { mintedByUserId, ttlSeconds = 900 } = {}) {
    if (!orgId) throw new Error('orgId required');
    await initDB();
    const id = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    // Retry on the (extremely rare) collision against an active code.
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = _generatePairingCodeString();
        try {
            const row = await getOne(`
                INSERT INTO pending_nc_bindings
                    (id, org_id, pairing_code, expires_at, approved_by_user_id)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *
            `, [id, orgId, code, expiresAt, mintedByUserId || null]);
            return parsePendingBinding(row);
        } catch (e) {
            if (/idx_pending_nc_bindings_pairing_code_active/i.test(e.message)) continue;
            throw e;
        }
    }
    throw new Error('Failed to mint pairing code after 5 attempts');
}

async function getPendingBindingByPairingCode(code) {
    if (!code) return null;
    await initDB();
    const row = await getOne(`
        SELECT * FROM pending_nc_bindings
        WHERE pairing_code = $1
          AND status = 'pending'
          AND pairing_code_consumed_at IS NULL
          AND expires_at > NOW()
        LIMIT 1
    `, [String(code).trim().toUpperCase()]);
    return parsePendingBinding(row);
}

// Mark code consumed. Returns false if the row was already consumed or no
// longer pending — caller treats that as "code already used".
async function consumePairingCode(id, { ncInstanceId, ncBaseUrl, ncAdminUid, ncAdminEmail, ncAdminDisplayName, connectorCallbackUrl, themingName, ncVersion } = {}) {
    if (!id) return false;
    await initDB();
    const res = await run(`
        UPDATE pending_nc_bindings SET
            pairing_code_consumed_at = NOW(),
            status = 'approved',
            approved_at = NOW(),
            nc_instance_id = COALESCE($2, nc_instance_id),
            nc_base_url    = COALESCE($3, nc_base_url),
            nc_admin_uid   = COALESCE($4, nc_admin_uid),
            nc_admin_email = COALESCE($5, nc_admin_email),
            nc_admin_display_name = COALESCE($6, nc_admin_display_name),
            connector_callback_url = COALESCE($7, connector_callback_url),
            theming_name   = COALESCE($8, theming_name),
            nc_version     = COALESCE($9, nc_version)
        WHERE id = $1
          AND status = 'pending'
          AND pairing_code_consumed_at IS NULL
    `, [
        id,
        ncInstanceId || null,
        ncBaseUrl || null,
        ncAdminUid || null,
        ncAdminEmail || null,
        ncAdminDisplayName || null,
        connectorCallbackUrl || null,
        themingName || null,
        ncVersion || null,
    ]);
    return (res?.rowCount || 0) > 0;
}

async function getActivePairingCodesForOrg(orgId) {
    if (!orgId) return [];
    await initDB();
    const rows = await getAll(`
        SELECT * FROM pending_nc_bindings
        WHERE org_id = $1
          AND pairing_code IS NOT NULL
          AND status = 'pending'
          AND pairing_code_consumed_at IS NULL
          AND expires_at > NOW()
        ORDER BY created_at DESC
    `, [orgId]);
    return rows.map(parsePendingBinding);
}

async function deletePairingCode(id, orgId) {
    if (!id) return false;
    await initDB();
    const res = await run(`
        DELETE FROM pending_nc_bindings
        WHERE id = $1
          AND ($2::text IS NULL OR org_id = $2)
          AND pairing_code IS NOT NULL
          AND pairing_code_consumed_at IS NULL
    `, [id, orgId || null]);
    return (res?.rowCount || 0) > 0;
}

async function createPendingNcBinding(data, ttlSeconds = 1800) {
    await initDB();
    const id = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    // ON CONFLICT on the partial unique index (org_id, nc_instance_id) WHERE status='pending'.
    // PG requires repeating the index predicate for index inference.
    const sql = `
        INSERT INTO pending_nc_bindings
            (id, org_id, nc_instance_id, nc_base_url, nc_admin_uid, nc_admin_email,
             nc_admin_display_name, connector_callback_url, theming_name, nc_version, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (org_id, nc_instance_id) WHERE status = 'pending'
        DO UPDATE SET
            nc_base_url = EXCLUDED.nc_base_url,
            nc_admin_uid = EXCLUDED.nc_admin_uid,
            nc_admin_email = EXCLUDED.nc_admin_email,
            nc_admin_display_name = EXCLUDED.nc_admin_display_name,
            connector_callback_url = EXCLUDED.connector_callback_url,
            theming_name = EXCLUDED.theming_name,
            nc_version = EXCLUDED.nc_version,
            expires_at = GREATEST(pending_nc_bindings.expires_at, EXCLUDED.expires_at)
        RETURNING *
    `;
    const row = await getOne(sql, [
        id,
        data.orgId,
        data.ncInstanceId,
        data.ncBaseUrl,
        data.ncAdminUid,
        data.ncAdminEmail,
        data.ncAdminDisplayName || null,
        data.connectorCallbackUrl || null,
        data.themingName || null,
        data.ncVersion || null,
        expiresAt,
    ]);
    return parsePendingBinding(row);
}

// Create (or refresh) a pending email-verification binding and store the hash of
// the supplied one-time `code`. Returns the row (incl. expiresAt) so the caller
// can email the code and report the expiry to the connector. ON CONFLICT on the
// (org_id, nc_instance_id) partial unique index means a re-bootstrap from the
// same instance refreshes the existing row's code + resets attempts.
async function createPendingNcVerification(data, { ttlSeconds = NC_VERIFICATION_TTL_SECONDS, code } = {}) {
    if (!data?.orgId || !data?.ncInstanceId || !code) throw new Error('orgId, ncInstanceId and code required');
    await initDB();
    const id = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const hash = _hashNcVerificationCode(data.orgId, data.ncInstanceId, code);
    const sql = `
        INSERT INTO pending_nc_bindings
            (id, org_id, nc_instance_id, nc_base_url, nc_admin_uid, nc_admin_email,
             nc_admin_display_name, connector_callback_url, theming_name, nc_version,
             expires_at, verification_code_hash, verification_email, verification_attempts)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0)
        ON CONFLICT (org_id, nc_instance_id) WHERE status = 'pending'
        DO UPDATE SET
            nc_base_url = EXCLUDED.nc_base_url,
            nc_admin_uid = EXCLUDED.nc_admin_uid,
            nc_admin_email = EXCLUDED.nc_admin_email,
            nc_admin_display_name = EXCLUDED.nc_admin_display_name,
            connector_callback_url = EXCLUDED.connector_callback_url,
            theming_name = EXCLUDED.theming_name,
            nc_version = EXCLUDED.nc_version,
            expires_at = EXCLUDED.expires_at,
            verification_code_hash = EXCLUDED.verification_code_hash,
            verification_email = EXCLUDED.verification_email,
            verification_attempts = 0
        RETURNING *
    `;
    const row = await getOne(sql, [
        id,
        data.orgId,
        data.ncInstanceId,
        data.ncBaseUrl || null,
        data.ncAdminUid || null,
        data.ncAdminEmail || null,
        data.ncAdminDisplayName || null,
        data.connectorCallbackUrl || null,
        data.themingName || null,
        data.ncVersion || null,
        expiresAt,
        hash,
        data.verificationEmail || data.ncAdminEmail || null,
    ]);
    return parsePendingBinding(row);
}

// Verify a submitted code against a pending verification row. Atomically counts
// the attempt. Returns a discriminated result; on 'ok' the row is left 'pending'
// — the caller binds the org and marks it approved (mirrors the approve handler)
// so a mid-flight failure doesn't burn the binding.
async function verifyPendingNcCode(id, code) {
    if (!id) return { status: 'not_found' };
    await initDB();
    const existing = await getOne(`SELECT * FROM pending_nc_bindings WHERE id = $1`, [id]);
    if (!existing) return { status: 'not_found' };
    if (!existing.verification_code_hash) return { status: 'not_verification' };

    const expired = existing.expires_at && new Date(existing.expires_at).getTime() <= Date.now();
    // Idempotent re-verify after a successful approval (e.g. the connector lost
    // the first response): accept the matching code and hand the row back.
    if (existing.status === 'approved') {
        return _ncCodeMatches(existing, code)
            ? { status: 'ok', row: parsePendingBinding(existing) }
            : { status: 'invalid', attemptsLeft: 0 };
    }
    if (existing.status === 'denied') return { status: 'denied' };
    if (existing.status === 'expired' || (existing.status === 'pending' && expired)) {
        return { status: 'expired' };
    }

    // Count this attempt atomically against a still-valid pending row.
    const row = await getOne(
        `UPDATE pending_nc_bindings SET verification_attempts = verification_attempts + 1
         WHERE id = $1 AND status = 'pending' AND expires_at > NOW()
           AND verification_code_hash IS NOT NULL
         RETURNING *`,
        [id]
    );
    if (!row) return { status: 'expired' };
    if ((row.verification_attempts || 0) > NC_VERIFICATION_MAX_ATTEMPTS) {
        return { status: 'too_many' };
    }
    if (!_ncCodeMatches(row, code)) {
        return { status: 'invalid', attemptsLeft: Math.max(0, NC_VERIFICATION_MAX_ATTEMPTS - (row.verification_attempts || 0)) };
    }
    return { status: 'ok', row: parsePendingBinding(row) };
}

// Resend: mint a new code for an existing pending verification row, reset the
// attempt counter and extend the TTL. Returns the refreshed row (with
// verificationEmail) or null if the row isn't an eligible pending verification.
async function resetNcVerificationCode(id, code, ttlSeconds = NC_VERIFICATION_TTL_SECONDS) {
    if (!id || !code) return null;
    await initDB();
    const existing = await getOne(`SELECT * FROM pending_nc_bindings WHERE id = $1`, [id]);
    if (!existing || !existing.verification_code_hash || existing.status !== 'pending') return null;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const hash = _hashNcVerificationCode(existing.org_id, existing.nc_instance_id, code);
    const row = await getOne(
        `UPDATE pending_nc_bindings
            SET verification_code_hash = $2, verification_attempts = 0, expires_at = $3
          WHERE id = $1 AND status = 'pending' AND verification_code_hash IS NOT NULL
          RETURNING *`,
        [id, hash, expiresAt]
    );
    return parsePendingBinding(row);
}

// Re-point a pending verification at a different admin (the NC user actually
// performing the setup, rather than the arbitrary first admin chosen at
// bootstrap): swap the target email + admin identity, mint a fresh code, reset
// attempts and extend the TTL. The caller MUST first validate that `email`
// qualifies for the row's org (exact user match or matching corporate domain).
async function retargetNcVerification(id, { email, uid, displayName, code, ttlSeconds = NC_VERIFICATION_TTL_SECONDS }) {
    if (!id || !email || !code) return null;
    await initDB();
    const existing = await getOne(`SELECT * FROM pending_nc_bindings WHERE id = $1`, [id]);
    if (!existing || !existing.verification_code_hash || existing.status !== 'pending') return null;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const hash = _hashNcVerificationCode(existing.org_id, existing.nc_instance_id, code);
    const row = await getOne(
        `UPDATE pending_nc_bindings
            SET verification_email = $2,
                nc_admin_email = $2,
                nc_admin_uid = COALESCE($3, nc_admin_uid),
                nc_admin_display_name = COALESCE($4, nc_admin_display_name),
                verification_code_hash = $5,
                verification_attempts = 0,
                expires_at = $6
          WHERE id = $1 AND status = 'pending' AND verification_code_hash IS NOT NULL
          RETURNING *`,
        [id, String(email).toLowerCase(), uid || null, displayName || null, hash, expiresAt]
    );
    return parsePendingBinding(row);
}

async function countActivePendingNcVerificationsForOrg(orgId) {
    if (!orgId) return 0;
    await initDB();
    const row = await getOne(
        `SELECT COUNT(*)::int AS n FROM pending_nc_bindings
         WHERE org_id = $1
           AND status = 'pending'
           AND expires_at > NOW()
           AND verification_code_hash IS NOT NULL`,
        [orgId]
    );
    return row?.n || 0;
}

async function getPendingNcBinding(id) {
    if (!id) return null;
    await initDB();
    const row = await getOne(`SELECT * FROM pending_nc_bindings WHERE id = $1`, [id]);
    return parsePendingBinding(row);
}

async function getPendingNcBindingForOrg(orgId) {
    if (!orgId) return null;
    await initDB();
    // Email-match approval rows only. Pairing-code rows live in the same
    // table but are a different flow (the connector redeems them on
    // bootstrap, never the SPA), so they must not surface in the approval
    // modal. Distinguishing column: pairing_code IS NULL for approval rows.
    const row = await getOne(
        `SELECT * FROM pending_nc_bindings
         WHERE org_id = $1
           AND status = 'pending'
           AND expires_at > NOW()
           AND pairing_code IS NULL
           AND verification_code_hash IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [orgId]
    );
    return parsePendingBinding(row);
}

async function countActivePendingNcBindingsForOrg(orgId) {
    if (!orgId) return 0;
    await initDB();
    // Mirror getPendingNcBindingForOrg — count only approval rows so the
    // bootstrap rate-limit "too many pending bindings" check doesn't false-
    // trip on accumulated unused pairing codes.
    const row = await getOne(
        `SELECT COUNT(*)::int AS n FROM pending_nc_bindings
         WHERE org_id = $1
           AND status = 'pending'
           AND expires_at > NOW()
           AND pairing_code IS NULL
           AND verification_code_hash IS NULL`,
        [orgId]
    );
    return row?.n || 0;
}

async function markPendingNcBindingApproved(id, userId) {
    await initDB();
    await run(
        `UPDATE pending_nc_bindings SET status = 'approved', approved_at = NOW(), approved_by_user_id = $2
         WHERE id = $1 AND status = 'pending'`,
        [id, userId || null]
    );
}

async function markPendingNcBindingDenied(id, userId) {
    await initDB();
    await run(
        `UPDATE pending_nc_bindings SET status = 'denied', approved_at = NOW(), approved_by_user_id = $2
         WHERE id = $1 AND status = 'pending'`,
        [id, userId || null]
    );
}

async function expirePendingNcBindings() {
    await initDB();
    const res = await run(
        `UPDATE pending_nc_bindings SET status = 'expired'
         WHERE status = 'pending' AND expires_at <= NOW()`
    );
    return res?.rowCount || 0;
}

async function getAllGroups() {
    await initDB();
    const rows = await getAll('SELECT * FROM groups');
    return rows.map(g => ({
        ...g,
        permissions: parseJSON(g.permissions, []),
        roles: parseJSON(g.roles, []),
        allowedAgentTypes: parseJSON(g.allowedAgentTypes, []),
        allowedTiers: parseJSON(g.allowedTiers, []),
        disabled_integrations: parseJSON(g.disabled_integrations, []),
    }));
}

async function createGroup(groupData) {
    await initDB();
    const { id, organizationId, name, description, permissions, roles, allowedAgentTypes, azureGroupId, source, lastSyncedAt, orgRole } = groupData;
    const ex = await getOne('SELECT id FROM groups WHERE id = $1', [id]);
    if (ex) return false;
    try {
        // Default groups to orgRole='member' so freshly-mirrored groups
        // immediately have a sensible role baseline. The legacy default of
        // '' meant org-admins had to manually pick a role for every synced
        // group before users in those groups could do anything.
        await run('INSERT INTO groups (id, "organizationId", name, description, permissions, roles, "userCount", "allowedAgentTypes", "azureGroupId", "source", "lastSyncedAt", "orgRole") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
            [id, organizationId || null, name, description || '', JSON.stringify(permissions || []), JSON.stringify(roles || []), 0, JSON.stringify(allowedAgentTypes || []), azureGroupId || null, source || 'manual', lastSyncedAt || null, orgRole || 'member']);
        return true;
    } catch (e) { console.error(e); return false; }
}

async function updateGroup(groupId, updates) {
    await initDB();
    const ex = await getOne('SELECT id FROM groups WHERE id = $1', [groupId]);
    if (!ex) return false;
    const colMap = { name: 'name', description: 'description', azureGroupId: 'azureGroupId', source: 'source', lastSyncedAt: 'lastSyncedAt', orgRole: 'orgRole' };
    const updateMap = {};
    for (const [k, v] of Object.entries(colMap)) { if (updates[k] !== undefined) updateMap[k] = updates[k]; }
    if (updates.organizationId !== undefined) updateMap.organizationId = updates.organizationId;
    if (updates.permissions !== undefined) updateMap.permissions = JSON.stringify(updates.permissions);
    if (updates.roles !== undefined) updateMap.roles = JSON.stringify(updates.roles);
    if (updates.allowedAgentTypes !== undefined) updateMap.allowedAgentTypes = JSON.stringify(updates.allowedAgentTypes);
    if (updates.allowedTiers !== undefined) updateMap.allowedTiers = JSON.stringify(updates.allowedTiers);
    if (updates.disabledIntegrations !== undefined) updateMap.disabledIntegrations = JSON.stringify(updates.disabledIntegrations);
    const fullColMap = { ...colMap, organizationId: 'organizationId', permissions: 'permissions', roles: 'roles', allowedAgentTypes: 'allowedAgentTypes', allowedTiers: 'allowedTiers', disabledIntegrations: 'disabled_integrations' };
    try {
        const q = dynamicUpdate('groups', groupId, updateMap, fullColMap);
        if (q) await run(q.sql, q.params);
        return true;
    } catch (e) { console.error(e); return false; }
}

async function deleteGroup(groupId) {
    await initDB();

    // Phase 7b: Replace 3 full-table-scan + JS loops with targeted SQL UPDATEs.
    //
    // Old approach: SELECT * FROM table → JS loop → N individual UPDATE round-trips
    // New approach: single UPDATE per table using chained REPLACE on the JSON text.
    //
    // Four REPLACE passes handle all comma-adjacency edge cases:
    //   ["a","b","c"] → delete "b" → "a","c" → ["a","c"]   (middle: fix ,,)
    //   ["a","b"]     → delete "a" → ,"b"    → ["b"]        (first: fix [,)
    //   ["a","b"]     → delete "b" → "a",    → ["a"]        (last: fix ,])
    //   ["a"]         → delete "a" → ""      → []           (only: ,] + [, both clean)

    const entry = `"${groupId}"`;       // e.g. "admins"
    const like  = `%"${groupId}"%`;     // LIKE filter — only update rows that contain it

    const replaceChain = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(${col}, $1, ''), ',,', ','), ',]', ']'), '[,', '[')`;

    // Remove groupId from users.groups
    await run(`UPDATE users SET groups = ${replaceChain('groups')} WHERE groups LIKE $2`, [entry, like]);

    // Remove groupId from agents.shared_groups
    await run(`UPDATE agents SET shared_groups = ${replaceChain('shared_groups')} WHERE shared_groups LIKE $2`, [entry, like]);

    // Remove groupId from organizations.defaultGroups
    await run(`UPDATE organizations SET "defaultGroups" = ${replaceChain('"defaultGroups"')} WHERE "defaultGroups" LIKE $2`, [entry, like]);

    const { rowCount } = await run('DELETE FROM groups WHERE id = $1', [groupId]);
    return rowCount > 0;
}

// ── Azure AD Lookup Helpers ─────────────────────────────
async function getGroupByAzureId(azureGroupId) {
    await initDB();
    return await getOne('SELECT * FROM groups WHERE "azureGroupId" = $1', [azureGroupId]);
}

async function getUserByAzureId(azureUserId) {
    await initDB();
    const row = await getOne('SELECT * FROM users WHERE "azureUserId" = $1', [azureUserId]);
    if (!row) return null;
    return { ...row, groups: parseJSON(row.groups, []) };
}

async function initDefaultGroups() {
    await initDB();
    if (!(await getOne('SELECT id FROM groups WHERE id = $1', ['admins']))) await createGroup({ id: 'admins', name: 'Administrators', description: 'Full system access', permissions: ['all'] });
    if (!(await getOne('SELECT id FROM groups WHERE id = $1', ['users']))) await createGroup({ id: 'users', name: 'Users', description: 'Standard user access', permissions: ['read', 'chat'] });
}
initDefaultGroups().catch(err => console.error('[UserStore] initDefaultGroups error:', err.message));

// ── App Password (Nextcloud / WebDAV) ─────────────────
// Stores `{username, password}` as encrypted JSON in users.appPassword. The username is
// the Nextcloud uid used for WebDAV Basic auth, which may differ from the BeeFlow login
// (e.g. SSO email vs Nextcloud uid). Reads tolerate the legacy plain-password format.
async function storeAppPassword(userId, username, appPassword) {
    await initDB();
    const user = await getUser(userId);
    if (!user) await createUser({ id: userId, username });
    try {
        const payload = JSON.stringify({ username, password: appPassword });
        await run('UPDATE users SET "appPassword" = $1, "appPasswordCreated" = $2 WHERE id = $3',
            [JSON.stringify(encrypt(payload)), new Date().toISOString(), userId]);
        return true;
    } catch (e) { console.error(e); return false; }
}

async function getAppPassword(userId) {
    const user = await getUser(userId);
    if (!user || !user.appPassword) return null;
    const decrypted = decrypt(user.appPassword);
    if (!decrypted) return null;
    // New format: encrypted JSON { username, password }. Legacy: encrypted password only.
    try {
        const parsed = JSON.parse(decrypted);
        if (parsed && typeof parsed === 'object' && parsed.password) {
            return {
                username: parsed.username || user.username,
                password: parsed.password,
                createdAt: user.appPasswordCreated
            };
        }
    } catch (_) { /* legacy bare-password path */ }
    return { username: user.username, password: decrypted, createdAt: user.appPasswordCreated };
}

async function hasAppPassword(userId) { const user = await getUser(userId); return !!(user && user.appPassword); }

async function deleteAppPassword(userId) {
    await initDB();
    const { rowCount } = await run('UPDATE users SET "appPassword" = NULL, "appPasswordCreated" = NULL WHERE id = $1', [userId]);
    return rowCount > 0;
}

// ── Roles ─────────────────────────────
async function getAllRoles() {
    await initDB();
    const rows = await getAll('SELECT * FROM roles');
    return rows.map(r => ({ ...r, permissions: parseJSON(r.permissions, []) }));
}

async function createRole(roleData) {
    await initDB();
    const { id, name, description, permissions } = roleData;
    const ex = await getOne('SELECT id FROM roles WHERE id = $1', [id]);
    if (ex) return false;
    try { await run('INSERT INTO roles (id, name, description, permissions) VALUES ($1,$2,$3,$4)', [id, name, description || '', JSON.stringify(permissions || [])]); return true; } catch (e) { console.error(e); return false; }
}

async function updateRole(roleId, updates) {
    await initDB();
    const ex = await getOne('SELECT id FROM roles WHERE id = $1', [roleId]);
    if (!ex) return false;
    const updateMap = {};
    if (updates.name !== undefined) updateMap.name = updates.name;
    if (updates.description !== undefined) updateMap.description = updates.description;
    if (updates.permissions !== undefined) updateMap.permissions = JSON.stringify(updates.permissions);
    const colMap = { name: 'name', description: 'description', permissions: 'permissions' };
    try { const q = dynamicUpdate('roles', roleId, updateMap, colMap); if (q) await run(q.sql, q.params); return true; } catch (e) { console.error(e); return false; }
}

async function deleteRole(roleId) { await initDB(); const { rowCount } = await run('DELETE FROM roles WHERE id = $1', [roleId]); return rowCount > 0; }

async function initDefaultRoles() {
    await initDB();
    const defaults = [
        { id: 'admin', name: 'Administrator', description: 'Full system access', permissions: ['all'] },
        { id: 'user', name: 'User', description: 'Standard user access', permissions: ['read', 'chat'] },
        { id: 'org_admin', name: 'Organisation Admin', description: 'Edit org settings, manage users/groups/permissions, set Privacy Shield, plus all agent permissions', permissions: ['org.manage', 'org.users', 'org.privacy_shield', 'agents.create', 'agents.edit_published', 'agents.edit_unpublished'] },
        { id: 'agent_admin', name: 'Agent Admin', description: 'Create and edit all published and unpublished agents', permissions: ['agents.create', 'agents.edit_published', 'agents.edit_unpublished'] },
        { id: 'agent_editor', name: 'Agent Editor', description: 'Create and edit all published agents', permissions: ['agents.create', 'agents.edit_published'] },
    ];
    for (const r of defaults) { if (!(await getOne('SELECT id FROM roles WHERE id = $1', [r.id]))) await createRole(r); }
}
initDefaultRoles().catch(err => console.error('[UserStore] initDefaultRoles error:', err.message));

// ── Subscription Plans ─────────────────────────────
function parsePlan(p) {
    return {
        ...p,
        allowed_features: parseJSON(p.allowed_features, []),
        allowed_models: parseJSON(p.allowed_models, []),
        // null in DB = unrestricted; only parse when explicitly set so the
        // distinction between "all integrations" and "zero integrations"
        // survives a round-trip.
        allowed_integrations: p.allowed_integrations == null ? null : parseJSON(p.allowed_integrations, null),
        allowed_beta_features: p.allowed_beta_features == null ? null : parseJSON(p.allowed_beta_features, null),
        max_messages_by_type: parseJSON(p.max_messages_by_type, {}),
        is_default: !!p.is_default,
        is_public: !!p.is_public,
        plan_type: p.plan_type || 'organization',
        nc_recommended: !!p.nc_recommended,
        tagline: p.tagline || null,
        billing_model: p.billing_model || 'fixed',
        markup_percent: p.markup_percent == null ? 0 : Number(p.markup_percent),
        stripe_meter_id: p.stripe_meter_id || null,
        stripe_meter_event_name: p.stripe_meter_event_name || null,
        per_seat: !!p.per_seat,
        max_messages_per_seat: p.max_messages_per_seat ?? null,
    };
}

function serializeAllowList(v) {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (!Array.isArray(v)) throw new Error('allow-list must be an array or null');
    return JSON.stringify(v);
}

async function getAllPlans() {
    await initDB();
    const rows = await getAll('SELECT * FROM subscription_plans ORDER BY sort_order ASC, name ASC');
    return rows.map(parsePlan);
}

async function getPlan(planId) {
    await initDB();
    const p = await getOne('SELECT * FROM subscription_plans WHERE id = $1', [planId]);
    if (!p) return null;
    return parsePlan(p);
}

// Used by the Nextcloud connector bootstrap to grant freshly-provisioned NC
// orgs the entitlements the SaaS operator has flagged as "NC default" (via
// the nc_recommended boolean on subscription_plans). Returns null when no
// plan is flagged — caller treats that as graceful degradation to the
// community fallback.
async function getDefaultNcPlan() {
    await initDB();
    const p = await getOne(`SELECT * FROM subscription_plans
                              WHERE nc_recommended = TRUE
                           ORDER BY price ASC NULLS LAST, sort_order ASC
                              LIMIT 1`);
    if (!p) return null;
    return parsePlan(p);
}

async function createPlan(data) {
    await initDB();
    if (!data.name || typeof data.name !== 'string' || !data.name.trim()) {
        throw new Error('Plan name is required');
    }
    if (data.tier !== undefined && data.tier !== null && data.tier !== '' && !['pro', 'enterprise'].includes(data.tier)) {
        // 'community' and 'full' are reserved for license-key activations on
        // self-hosted installs. Cloud subscription plans use 'pro',
        // 'enterprise', or NULL (Free); the resolver's community floor still
        // covers NULL-tier subscribers transparently.
        throw new Error(`Invalid tier '${data.tier}' for subscription plan. Allowed: 'pro', 'enterprise', or empty. ('community' and 'full' are license-key only.)`);
    }
    if (data.tier === '') data.tier = null;
    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString();
    try {
        if (data.is_default) await run('UPDATE subscription_plans SET is_default = FALSE WHERE is_default = TRUE');
        if (data.nc_recommended) await run('UPDATE subscription_plans SET nc_recommended = FALSE WHERE nc_recommended = TRUE');
        await run(`INSERT INTO subscription_plans (id, name, description, max_messages_per_month, max_messages_by_type, max_tokens_per_month, max_cost_per_month, max_users, max_agents, max_knowledge_sources, allowed_features, allowed_models, allowed_integrations, allowed_beta_features, is_default, price, currency, billing_interval, trial_days, sort_order, is_public, stripe_price_id, stripe_product_id, plan_type, nc_recommended, tagline, tier, billing_model, markup_percent, stripe_meter_id, stripe_meter_event_name, per_seat, max_messages_per_seat, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35)`,
            [id, data.name.trim(), data.description || '', data.max_messages_per_month ?? null, JSON.stringify(data.max_messages_by_type || {}),
                data.max_tokens_per_month ?? null, data.max_cost_per_month ?? null, data.max_users ?? null, data.max_agents ?? null,
                data.max_knowledge_sources ?? null, JSON.stringify(data.allowed_features || []), JSON.stringify(data.allowed_models || []),
                serializeAllowList(data.allowed_integrations) ?? null,
                serializeAllowList(data.allowed_beta_features) ?? null,
                !!data.is_default, data.price ?? null, data.currency || 'EUR', data.billing_interval || 'monthly',
                data.trial_days ?? 0, data.sort_order ?? 0, !!data.is_public,
                data.stripe_price_id || null, data.stripe_product_id || null, data.plan_type || 'organization',
                !!data.nc_recommended, data.tagline || null, data.tier || null,
                data.billing_model || 'fixed', data.markup_percent ?? 0,
                data.stripe_meter_id || null, data.stripe_meter_event_name || null,
                !!data.per_seat, data.max_messages_per_seat ?? null,
                now, now]);
        return parsePlan(await getOne('SELECT * FROM subscription_plans WHERE id = $1', [id]));
    } catch (e) { console.error('[UserStore] createPlan error:', e); return null; }
}

async function updatePlan(planId, data) {
    await initDB();
    if (!(await getOne('SELECT id FROM subscription_plans WHERE id = $1', [planId]))) return false;
    if (data.name !== undefined && (!data.name || typeof data.name !== 'string' || !data.name.trim())) {
        throw new Error('Plan name cannot be empty');
    }
    const now = new Date().toISOString();
    try {
        if (data.is_default) await run('UPDATE subscription_plans SET is_default = FALSE WHERE is_default = TRUE');
        if (data.nc_recommended) await run('UPDATE subscription_plans SET nc_recommended = FALSE WHERE nc_recommended = TRUE AND id <> $1', [planId]);
        const updateMap = {};
        if (data.name !== undefined) updateMap.name = data.name.trim();
        if (data.description !== undefined) updateMap.description = data.description;
        if (data.max_messages_per_month !== undefined) updateMap.max_messages_per_month = data.max_messages_per_month;
        if (data.max_messages_by_type !== undefined) updateMap.max_messages_by_type = JSON.stringify(data.max_messages_by_type);
        if (data.max_tokens_per_month !== undefined) updateMap.max_tokens_per_month = data.max_tokens_per_month;
        if (data.max_cost_per_month !== undefined) updateMap.max_cost_per_month = data.max_cost_per_month;
        if (data.max_users !== undefined) updateMap.max_users = data.max_users;
        if (data.max_agents !== undefined) updateMap.max_agents = data.max_agents;
        if (data.max_knowledge_sources !== undefined) updateMap.max_knowledge_sources = data.max_knowledge_sources;
        if (data.allowed_features !== undefined) updateMap.allowed_features = JSON.stringify(data.allowed_features);
        if (data.allowed_models !== undefined) updateMap.allowed_models = JSON.stringify(data.allowed_models);
        if (data.allowed_integrations !== undefined) updateMap.allowed_integrations = serializeAllowList(data.allowed_integrations);
        if (data.allowed_beta_features !== undefined) updateMap.allowed_beta_features = serializeAllowList(data.allowed_beta_features);
        if (data.billing_model !== undefined) updateMap.billing_model = data.billing_model;
        if (data.markup_percent !== undefined) updateMap.markup_percent = data.markup_percent;
        if (data.stripe_meter_id !== undefined) updateMap.stripe_meter_id = data.stripe_meter_id;
        if (data.stripe_meter_event_name !== undefined) updateMap.stripe_meter_event_name = data.stripe_meter_event_name;
        if (data.per_seat !== undefined) updateMap.per_seat = !!data.per_seat;
        if (data.max_messages_per_seat !== undefined) updateMap.max_messages_per_seat = data.max_messages_per_seat;
        if (data.is_default !== undefined) updateMap.is_default = !!data.is_default;
        if (data.price !== undefined) updateMap.price = data.price;
        if (data.currency !== undefined) updateMap.currency = data.currency;
        if (data.billing_interval !== undefined) updateMap.billing_interval = data.billing_interval;
        if (data.trial_days !== undefined) updateMap.trial_days = data.trial_days;
        if (data.sort_order !== undefined) updateMap.sort_order = data.sort_order;
        if (data.is_public !== undefined) updateMap.is_public = !!data.is_public;
        if (data.stripe_price_id !== undefined) updateMap.stripe_price_id = data.stripe_price_id;
        if (data.stripe_product_id !== undefined) updateMap.stripe_product_id = data.stripe_product_id;
        if (data.nc_recommended !== undefined) updateMap.nc_recommended = !!data.nc_recommended;
        if (data.tagline !== undefined) updateMap.tagline = data.tagline;
        if (data.tier !== undefined) {
            if (data.tier !== null && data.tier !== '' && !['pro', 'enterprise'].includes(data.tier)) {
                throw new Error(`Invalid tier '${data.tier}' for subscription plan. Allowed: 'pro', 'enterprise', or empty. ('community' and 'full' are license-key only.)`);
            }
            updateMap.tier = data.tier === '' ? null : data.tier;
        }
        updateMap.updated_at = now;
        if (data.plan_type !== undefined) updateMap.plan_type = data.plan_type;
        const colMap = { name: 'name', description: 'description', max_messages_per_month: 'max_messages_per_month', max_messages_by_type: 'max_messages_by_type', max_tokens_per_month: 'max_tokens_per_month', max_cost_per_month: 'max_cost_per_month', max_users: 'max_users', max_agents: 'max_agents', max_knowledge_sources: 'max_knowledge_sources', allowed_features: 'allowed_features', allowed_models: 'allowed_models', allowed_integrations: 'allowed_integrations', allowed_beta_features: 'allowed_beta_features', is_default: 'is_default', price: 'price', currency: 'currency', billing_interval: 'billing_interval', trial_days: 'trial_days', sort_order: 'sort_order', is_public: 'is_public', stripe_price_id: 'stripe_price_id', stripe_product_id: 'stripe_product_id', plan_type: 'plan_type', nc_recommended: 'nc_recommended', tagline: 'tagline', tier: 'tier', billing_model: 'billing_model', markup_percent: 'markup_percent', stripe_meter_id: 'stripe_meter_id', stripe_meter_event_name: 'stripe_meter_event_name', per_seat: 'per_seat', max_messages_per_seat: 'max_messages_per_seat', updated_at: 'updated_at' };
        const q = dynamicUpdate('subscription_plans', planId, updateMap, colMap);
        if (q) await run(q.sql, q.params);
        return true;
    } catch (e) { console.error('[UserStore] updatePlan error:', e); return false; }
}

class PlanInUseError extends Error {
    constructor(planId, affectedOrgs, affectedConsumers) {
        super(`Plan ${planId} is in use by ${affectedOrgs.length} org(s) and ${affectedConsumers.length} consumer(s)`);
        this.name = 'PlanInUseError';
        this.planId = planId;
        this.affectedOrgs = affectedOrgs;
        this.affectedConsumers = affectedConsumers;
    }
}

async function deletePlan(planId) {
    await initDB();
    // Refuse to delete a plan that has live subscriptions. Previously this
    // nulled plan_id on org_subscriptions and orphaned the rows so
    // getEffectiveLimits returned a partially-populated shape — which then
    // cascades into undefined gating behaviour. Force the admin to migrate
    // affected subscriptions first.
    const orgs = await getAll(
        `SELECT organization_id FROM organization_subscriptions
          WHERE plan_id = $1 AND COALESCE(status,'active') IN ('active','trialing','past_due')`,
        [planId]
    );
    const consumers = await getAll(
        `SELECT user_id FROM consumer_subscriptions
          WHERE plan_id = $1 AND COALESCE(status,'active') IN ('active','trialing','past_due')`,
        [planId]
    );
    if (orgs.length > 0 || consumers.length > 0) {
        throw new PlanInUseError(planId, orgs.map(r => r.organization_id), consumers.map(r => r.user_id));
    }
    const { rowCount } = await run('DELETE FROM subscription_plans WHERE id = $1', [planId]);
    return rowCount > 0;
}

// ── Organization Subscriptions ─────────────────────────────
async function getAllOrgSubscriptions() {
    await initDB();
    const rows = await getAll('SELECT os.*, sp.name as plan_name, sp.tier as plan_tier FROM organization_subscriptions os LEFT JOIN subscription_plans sp ON os.plan_id = sp.id ORDER BY os.created_at DESC');
    return rows.map(s => ({ ...s, allowed_features: parseJSON(s.allowed_features, null), allowed_models: parseJSON(s.allowed_models, null), max_messages_by_type: parseJSON(s.max_messages_by_type, null) }));
}

async function getOrgSubscription(orgId) {
    await initDB();
    const s = await getOne('SELECT os.*, sp.name as plan_name, sp.tier as plan_tier, sp.billing_model as plan_billing_model FROM organization_subscriptions os LEFT JOIN subscription_plans sp ON os.plan_id = sp.id WHERE os.organization_id = $1', [orgId]);
    if (!s) return null;
    return { ...s, billing_model: s.plan_billing_model || 'fixed', allowed_features: parseJSON(s.allowed_features, null), allowed_models: parseJSON(s.allowed_models, null), max_messages_by_type: parseJSON(s.max_messages_by_type, null) };
}

const VALID_SUB_STATUSES = ['active', 'suspended', 'cancelled', 'trialing', 'past_due', 'incomplete', 'paused'];

async function setOrgSubscription(orgId, data) {
    await initDB();
    if (data.status && !VALID_SUB_STATUSES.includes(data.status)) {
        throw new Error(`Invalid subscription status: ${data.status}`);
    }
    const existing = await getOrgSubscription(orgId);
    const now = new Date().toISOString();
    try {
        if (existing) {
            const updateMap = {};
            if (data.plan_id !== undefined) updateMap.plan_id = data.plan_id;
            if (data.status !== undefined) updateMap.status = data.status;
            if (data.max_messages_per_month !== undefined) updateMap.max_messages_per_month = data.max_messages_per_month;
            if (data.max_messages_by_type !== undefined) updateMap.max_messages_by_type = JSON.stringify(data.max_messages_by_type);
            if (data.max_tokens_per_month !== undefined) updateMap.max_tokens_per_month = data.max_tokens_per_month;
            if (data.max_cost_per_month !== undefined) updateMap.max_cost_per_month = data.max_cost_per_month;
            if (data.max_users !== undefined) updateMap.max_users = data.max_users;
            if (data.max_agents !== undefined) updateMap.max_agents = data.max_agents;
            if (data.max_knowledge_sources !== undefined) updateMap.max_knowledge_sources = data.max_knowledge_sources;
            if (data.allowed_features !== undefined) updateMap.allowed_features = JSON.stringify(data.allowed_features);
            if (data.allowed_models !== undefined) updateMap.allowed_models = JSON.stringify(data.allowed_models);
            if (data.billing_cycle_start !== undefined) updateMap.billing_cycle_start = data.billing_cycle_start;
            if (data.notes !== undefined) updateMap.notes = data.notes;
            if (data.trial_end_date !== undefined) updateMap.trial_end_date = data.trial_end_date;
            if (data.stripe_customer_id !== undefined) updateMap.stripe_customer_id = data.stripe_customer_id;
            if (data.stripe_subscription_id !== undefined) updateMap.stripe_subscription_id = data.stripe_subscription_id;
            if (data.payment_status !== undefined) updateMap.payment_status = data.payment_status;
            if (data.manual_override_until !== undefined) updateMap.manual_override_until = data.manual_override_until;
            if (data.manual_override_by !== undefined) updateMap.manual_override_by = data.manual_override_by;
            if (data.stripe_seat_quantity !== undefined) updateMap.stripe_seat_quantity = data.stripe_seat_quantity;
            if (data.cancel_at_period_end !== undefined) updateMap.cancel_at_period_end = data.cancel_at_period_end;
            if (data.cancel_at !== undefined) updateMap.cancel_at = data.cancel_at;
            if (data.current_period_end !== undefined) updateMap.current_period_end = data.current_period_end;
            if (data.pending_plan_id !== undefined) updateMap.pending_plan_id = data.pending_plan_id;
            if (data.pending_plan_effective !== undefined) updateMap.pending_plan_effective = data.pending_plan_effective;
            if (data.stripe_schedule_id !== undefined) updateMap.stripe_schedule_id = data.stripe_schedule_id;
            if (data.payment_attempt_count !== undefined) updateMap.payment_attempt_count = data.payment_attempt_count;
            if (data.last_payment_failure_at !== undefined) updateMap.last_payment_failure_at = data.last_payment_failure_at;
            if (data.past_due_since !== undefined) updateMap.past_due_since = data.past_due_since;
            updateMap.updated_at = now;
            const colMap = { plan_id: 'plan_id', status: 'status', max_messages_per_month: 'max_messages_per_month', max_messages_by_type: 'max_messages_by_type', max_tokens_per_month: 'max_tokens_per_month', max_cost_per_month: 'max_cost_per_month', max_users: 'max_users', max_agents: 'max_agents', max_knowledge_sources: 'max_knowledge_sources', allowed_features: 'allowed_features', allowed_models: 'allowed_models', billing_cycle_start: 'billing_cycle_start', notes: 'notes', trial_end_date: 'trial_end_date', stripe_customer_id: 'stripe_customer_id', stripe_subscription_id: 'stripe_subscription_id', payment_status: 'payment_status', manual_override_until: 'manual_override_until', manual_override_by: 'manual_override_by', stripe_seat_quantity: 'stripe_seat_quantity', cancel_at_period_end: 'cancel_at_period_end', cancel_at: 'cancel_at', current_period_end: 'current_period_end', pending_plan_id: 'pending_plan_id', pending_plan_effective: 'pending_plan_effective', stripe_schedule_id: 'stripe_schedule_id', payment_attempt_count: 'payment_attempt_count', last_payment_failure_at: 'last_payment_failure_at', past_due_since: 'past_due_since', updated_at: 'updated_at' };
            const q = dynamicUpdate('organization_subscriptions', orgId, updateMap, colMap, 'organization_id');
            if (q) await run(q.sql, q.params);
        } else {
            const id = crypto.randomUUID();
            await run(`INSERT INTO organization_subscriptions (id, organization_id, plan_id, status, max_messages_per_month, max_messages_by_type, max_tokens_per_month, max_cost_per_month, max_users, max_agents, max_knowledge_sources, allowed_features, allowed_models, billing_cycle_start, notes, trial_end_date, stripe_customer_id, stripe_subscription_id, payment_status, created_at, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
                [id, orgId, data.plan_id || null, data.status || 'active',
                    data.max_messages_per_month ?? null, data.max_messages_by_type ? JSON.stringify(data.max_messages_by_type) : null,
                    data.max_tokens_per_month ?? null, data.max_cost_per_month ?? null, data.max_users ?? null,
                    data.max_agents ?? null, data.max_knowledge_sources ?? null,
                    data.allowed_features ? JSON.stringify(data.allowed_features) : null,
                    data.allowed_models ? JSON.stringify(data.allowed_models) : null,
                    data.billing_cycle_start || now, data.notes || '',
                    data.trial_end_date || null, data.stripe_customer_id || null,
                    data.stripe_subscription_id || null, data.payment_status || 'none', now, now]);
        }
        // Bust the PAYG hot-path cache so the next usage event sees the new
        // plan / customer / status immediately instead of waiting for TTL.
        try { require('./usageStore').invalidatePaygCache(orgId, null); } catch (_) { /* circular-load safe */ }
        return true;
    } catch (e) { console.error('[UserStore] setOrgSubscription error:', e); return false; }
}

async function deleteOrgSubscription(orgId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM organization_subscriptions WHERE organization_id = $1', [orgId]);
    return rowCount > 0;
}

/**
 * Compute the billing period start/end dates for an org subscription.
 * Uses billing_cycle_start (day of month) to determine period boundaries,
 * falling back to calendar month if not set.
 */
function getBillingPeriod(sub) {
    const now = new Date();
    if (sub?.billing_cycle_start) {
        const cycleStart = new Date(sub.billing_cycle_start);
        const cycleDay = cycleStart.getDate();
        // Clamp the cycle day to the target month's last day. `new Date(y, m, d)`
        // silently rolls forward when d > month length (e.g. Feb 31 → Mar 3),
        // which would attribute Feb usage to March for any subscription billing
        // on the 29th/30th/31st.
        const clampedDate = (y, m, d) => {
            const last = new Date(y, m + 1, 0).getDate();
            return new Date(y, m, Math.min(d, last));
        };
        let periodStart = clampedDate(now.getFullYear(), now.getMonth(), cycleDay);
        if (periodStart > now) {
            // Haven't reached the cycle day this month — period started last month.
            periodStart = clampedDate(now.getFullYear(), now.getMonth() - 1, cycleDay);
        }
        const periodEnd = clampedDate(periodStart.getFullYear(), periodStart.getMonth() + 1, cycleDay);
        return { startDate: periodStart.toISOString(), endDate: periodEnd.toISOString() };
    }
    // Fallback: calendar month
    return {
        startDate: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
        endDate: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(),
    };
}

// Active seat count for an org — the number of users currently billable on a
// per-seat plan. Matches the FOR UPDATE query used by the seat-cap enforcer
// in createUserWithSeatCheck (without the lock).
async function getActiveSeatCount(orgId) {
    await initDB();
    const row = await getOne(
        `SELECT COUNT(*)::int AS n FROM users WHERE "organizationId" = $1 AND COALESCE(status, 'active') = 'active'`,
        [orgId]
    );
    return row?.n ?? 0;
}

async function getEffectiveLimits(orgId) {
    const sub = await getOrgSubscription(orgId);
    if (!sub) return null;
    // Read-only: the trial-expiry tick (server/index.js) persists transitions
    // to the DB. Reading-time mutation here used to TOCTOU with concurrent
    // webhooks. The authoritative gate is resolveTierFromSubscription in
    // server/license/index.js, which also handles trialing → no-tier.
    const plan = sub.plan_id ? await getPlan(sub.plan_id) : null;
    const LIMIT_FIELDS = ['max_messages_per_month', 'max_tokens_per_month', 'max_cost_per_month', 'max_users', 'max_agents', 'max_knowledge_sources'];
    const effective = { status: sub.status, billing_cycle_start: sub.billing_cycle_start };
    for (const field of LIMIT_FIELDS) {
        effective[field] = sub[field] !== null && sub[field] !== undefined ? sub[field] : (plan ? plan[field] : null);
    }
    // Per-seat plans: the org-wide message cap is computed as
    // per_seat_cap × seat_count. Prefer the Stripe-billed quantity (kept in
    // sync by the customer.subscription.updated webhook) so the cap matches
    // the bill even when the local user count drifts; fall back to the live
    // active-user count if no Stripe quantity is recorded yet.
    if (plan?.per_seat && plan?.max_messages_per_seat != null) {
        const billedSeats = sub.stripe_seat_quantity ?? null;
        const seats = billedSeats ?? await getActiveSeatCount(orgId);
        effective.max_messages_per_month = Number(plan.max_messages_per_seat) * Number(seats);
        effective.seat_count = seats;
        effective.per_seat = true;
        effective.max_messages_per_seat = plan.max_messages_per_seat;
    }
    const planByType = plan?.max_messages_by_type || {};
    const subByType = sub.max_messages_by_type || {};
    const mergedByType = { ...planByType, ...subByType };
    for (const key of Object.keys(mergedByType)) { if (mergedByType[key] === null || mergedByType[key] === undefined) delete mergedByType[key]; }
    effective.max_messages_by_type = Object.keys(mergedByType).length > 0 ? mergedByType : null;
    effective.allowed_features = sub.allowed_features || (plan ? plan.allowed_features : []);
    effective.allowed_models = sub.allowed_models || (plan ? plan.allowed_models : []);
    return effective;
}

// ── Consumer Subscriptions (per-user, org-less) ─────────────────────────────
async function getConsumerSubscription(userId) {
    await initDB();
    const s = await getOne('SELECT cs.*, sp.name as plan_name, sp.tier as plan_tier, sp.billing_model as plan_billing_model FROM consumer_subscriptions cs LEFT JOIN subscription_plans sp ON cs.plan_id = sp.id WHERE cs.user_id = $1', [userId]);
    if (!s) return null;
    return { ...s, billing_model: s.plan_billing_model || 'fixed' };
}

async function setConsumerSubscription(userId, data) {
    await initDB();
    if (data.status && !VALID_SUB_STATUSES.includes(data.status)) {
        throw new Error(`Invalid subscription status: ${data.status}`);
    }
    const existing = await getConsumerSubscription(userId);
    const now = new Date().toISOString();
    try {
        if (existing) {
            const updateMap = {};
            if (data.plan_id !== undefined) updateMap.plan_id = data.plan_id;
            if (data.status !== undefined) updateMap.status = data.status;
            if (data.stripe_customer_id !== undefined) updateMap.stripe_customer_id = data.stripe_customer_id;
            if (data.stripe_subscription_id !== undefined) updateMap.stripe_subscription_id = data.stripe_subscription_id;
            if (data.payment_status !== undefined) updateMap.payment_status = data.payment_status;
            if (data.billing_cycle_start !== undefined) updateMap.billing_cycle_start = data.billing_cycle_start;
            if (data.trial_end_date !== undefined) updateMap.trial_end_date = data.trial_end_date;
            if (data.manual_override_until !== undefined) updateMap.manual_override_until = data.manual_override_until;
            if (data.manual_override_by !== undefined) updateMap.manual_override_by = data.manual_override_by;
            if (data.cancel_at_period_end !== undefined) updateMap.cancel_at_period_end = data.cancel_at_period_end;
            if (data.cancel_at !== undefined) updateMap.cancel_at = data.cancel_at;
            if (data.current_period_end !== undefined) updateMap.current_period_end = data.current_period_end;
            updateMap.updated_at = now;
            const colMap = { plan_id: 'plan_id', status: 'status', stripe_customer_id: 'stripe_customer_id', stripe_subscription_id: 'stripe_subscription_id', payment_status: 'payment_status', billing_cycle_start: 'billing_cycle_start', trial_end_date: 'trial_end_date', manual_override_until: 'manual_override_until', manual_override_by: 'manual_override_by', cancel_at_period_end: 'cancel_at_period_end', cancel_at: 'cancel_at', current_period_end: 'current_period_end', updated_at: 'updated_at' };
            const q = dynamicUpdate('consumer_subscriptions', userId, updateMap, colMap, 'user_id');
            if (q) await run(q.sql, q.params);
        } else {
            const id = crypto.randomUUID();
            await run(`INSERT INTO consumer_subscriptions (id, user_id, plan_id, status, stripe_customer_id, stripe_subscription_id, payment_status, billing_cycle_start, trial_end_date, created_at, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                [id, userId, data.plan_id || null, data.status || 'active',
                    data.stripe_customer_id || null, data.stripe_subscription_id || null,
                    data.payment_status || 'none', data.billing_cycle_start || now,
                    data.trial_end_date || null, now, now]);
        }
        try { require('./usageStore').invalidatePaygCache(null, userId); } catch (_) { /* circular-load safe */ }
        return true;
    } catch (e) { console.error('[UserStore] setConsumerSubscription error:', e); return false; }
}

async function deleteConsumerSubscription(userId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM consumer_subscriptions WHERE user_id = $1', [userId]);
    return rowCount > 0;
}

async function getAllConsumerSubscriptions() {
    await initDB();
    const rows = await getAll('SELECT cs.*, sp.name as plan_name, sp.tier as plan_tier, u.username, u.email, u."displayName" FROM consumer_subscriptions cs LEFT JOIN subscription_plans sp ON cs.plan_id = sp.id LEFT JOIN users u ON cs.user_id = u.id ORDER BY cs.created_at DESC');
    return rows;
}

// ── Trial gate ─────────────────────────────
// Marks an org or user as having used its one-time trial. Idempotent —
// callers can re-invoke safely; the column only moves forward in time.
async function markTrialUsed(targetType, targetId) {
    await initDB();
    if (!targetId) return false;
    const now = new Date().toISOString();
    if (targetType === 'organization') {
        const r = await run('UPDATE organizations SET trial_used_at = $1 WHERE id = $2 AND trial_used_at IS NULL', [now, targetId]);
        return (r.rowCount || 0) > 0;
    }
    if (targetType === 'consumer' || targetType === 'user') {
        const r = await run('UPDATE users SET trial_used_at = $1 WHERE id = $2 AND trial_used_at IS NULL', [now, targetId]);
        return (r.rowCount || 0) > 0;
    }
    return false;
}

async function hasOrgUsedTrial(orgId) {
    await initDB();
    const r = await getOne('SELECT trial_used_at FROM organizations WHERE id = $1', [orgId]);
    return !!(r && r.trial_used_at);
}

// Email-scoped trial history check. Durable across delete + recreate of the
// same orgs/users so the trial gate survives row deletion. Caller normalises
// case + trims; we mirror the same normalisation in INSERT and SELECT.
async function hasEmailUsedTrial(scope, email) {
    await initDB();
    if (!email) return false;
    const norm = String(email).trim().toLowerCase();
    if (!norm) return false;
    const row = await getOne(
        `SELECT 1 FROM trial_history WHERE scope = $1 AND email_normalized = $2 LIMIT 1`,
        [scope, norm]
    );
    return !!row;
}

async function recordTrialHistory({ scope, email, subscriberId, planId, stripeCustomerId, stripeSubscriptionId, trialEndDate } = {}) {
    await initDB();
    if (!email || !scope) return;
    const norm = String(email).trim().toLowerCase();
    if (!norm) return;
    await run(
        `INSERT INTO trial_history (scope, email_normalized, subscriber_id, plan_id, stripe_customer_id, stripe_subscription_id, trial_end_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (scope, email_normalized) DO NOTHING`,
        [scope, norm, subscriberId || null, planId || null, stripeCustomerId || null, stripeSubscriptionId || null, trialEndDate || null]
    );
}

// Idempotent one-shot backfill: for every existing org/user with a non-null
// `trial_used_at` that doesn't yet have a trial_history row, insert one.
// Run after initDB(); safe to call on every boot — the unique index makes
// it a no-op once populated.
async function backfillTrialHistory() {
    await initDB();
    try {
        await run(`
            INSERT INTO trial_history (scope, email_normalized, subscriber_id, trial_started_at)
            SELECT 'organization', LOWER(TRIM(email)), id, trial_used_at
              FROM organizations
             WHERE trial_used_at IS NOT NULL AND email IS NOT NULL AND TRIM(email) <> ''
            ON CONFLICT (scope, email_normalized) DO NOTHING`);
        await run(`
            INSERT INTO trial_history (scope, email_normalized, subscriber_id, trial_started_at)
            SELECT 'consumer', LOWER(TRIM(email)), id, trial_used_at
              FROM users
             WHERE trial_used_at IS NOT NULL AND email IS NOT NULL AND TRIM(email) <> ''
            ON CONFLICT (scope, email_normalized) DO NOTHING`);
    } catch (e) {
        console.warn('[UserStore] backfillTrialHistory failed:', e.message);
    }
}

// One-shot idempotent backfill: rename connector-provisioned organisations that
// are still on the generic default name "Nextcloud" to a self-describing
// "Nextcloud (<host>)" so they're distinguishable in the admin list. Safe —
// org id is the stable key, name is display-only. After a row is renamed it no
// longer matches the predicate, so subsequent boots are no-ops.
async function backfillAutoProvisionedNcOrgNames() {
    await initDB();
    try {
        const { buildAutoOrgName } = require('../auth/orgNaming');
        const orgs = await getAllOrganizations();
        let updated = 0;
        for (const org of orgs) {
            if (org.authMethod !== 'nextcloud_connector') continue;
            if (org.name !== 'Nextcloud') continue;
            if (!org.nc_base_url) continue;
            const newName = buildAutoOrgName(org.name, org.nc_base_url);
            if (newName === org.name) continue;
            if (await updateOrganization(org.id, { name: newName })) updated++;
        }
        if (updated > 0) console.log(`[UserStore] Backfilled ${updated} auto-provisioned NC org name(s)`);
    } catch (e) {
        console.warn('[UserStore] backfillAutoProvisionedNcOrgNames failed:', e.message);
    }
}

async function hasUserUsedTrial(userId) {
    await initDB();
    const r = await getOne('SELECT trial_used_at FROM users WHERE id = $1', [userId]);
    return !!(r && r.trial_used_at);
}

// ── Audit Logging ─────────────────────────────
async function logSubscriptionAudit(action, targetType, targetId, changedBy, oldValues, newValues) {
    try {
        await initDB();
        const id = crypto.randomUUID();
        await run(`INSERT INTO subscription_audit_log (id, action, target_type, target_id, changed_by, old_values, new_values) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [id, action, targetType, targetId, changedBy || 'system',
                oldValues ? JSON.stringify(oldValues) : null,
                newValues ? JSON.stringify(newValues) : null]);
    } catch (e) { console.error('[UserStore] Audit log error:', e.message); }
}

// Try to claim a one-shot notification slot. Returns true if this caller
// is the one that gets to send (row inserted); false if the (target,
// kind) tuple has already been claimed. The ON CONFLICT DO NOTHING +
// rowCount check is the atomic primitive — no race between webhook
// retries.
async function claimNotification(targetType, targetId, kind, recipient = null, payload = null) {
    try {
        await initDB();
        const id = crypto.randomUUID();
        const result = await run(
            `INSERT INTO notifications_sent (id, target_type, target_id, kind, recipient, payload)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (target_type, target_id, kind) DO NOTHING`,
            [id, targetType, targetId, kind, recipient, payload ? JSON.stringify(payload) : null]
        );
        return (result?.rowCount ?? 0) > 0;
    } catch (e) {
        console.error('[UserStore] claimNotification error:', e.message);
        return false;
    }
}

// Access-control audit logger. Best-effort: writes a row to the access
// audit table and never throws on failure (logging must not break the
// caller's mutation). Pass the organization_id when known so org-scoped
// queries can find the row; pass null for global super-admin events.
async function logAccessAudit(action, targetType, targetId, changedBy, oldValues, newValues, organizationId = null) {
    try {
        await initDB();
        const id = crypto.randomUUID();
        await run(
            `INSERT INTO access_audit_log (id, action, target_type, target_id, organization_id, changed_by, old_values, new_values)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
                id,
                action,
                targetType,
                targetId,
                organizationId,
                changedBy || 'system',
                oldValues ? JSON.stringify(oldValues) : null,
                newValues ? JSON.stringify(newValues) : null,
            ]
        );
    } catch (e) { console.error('[UserStore] Access audit log error:', e.message); }
}

async function getAccessAuditLog(opts = {}) {
    await initDB();
    const { targetType, targetId, organizationId, limit = 50, offset = 0 } = opts;
    let sql = 'SELECT * FROM access_audit_log';
    const params = [];
    const conditions = [];
    let idx = 1;
    if (targetType) { conditions.push(`target_type = $${idx++}`); params.push(targetType); }
    if (targetId) { conditions.push(`target_id = $${idx++}`); params.push(targetId); }
    if (organizationId) { conditions.push(`organization_id = $${idx++}`); params.push(organizationId); }
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);
    const rows = await getAll(sql, params);
    return rows.map(r => ({ ...r, old_values: parseJSON(r.old_values, null), new_values: parseJSON(r.new_values, null) }));
}

async function getAuditLog(opts = {}) {
    await initDB();
    const { targetType, targetId, limit = 50, offset = 0 } = opts;
    let sql = 'SELECT * FROM subscription_audit_log';
    const params = [];
    const conditions = [];
    let idx = 1;
    if (targetType) { conditions.push(`target_type = $${idx++}`); params.push(targetType); }
    if (targetId) { conditions.push(`target_id = $${idx++}`); params.push(targetId); }
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);
    const rows = await getAll(sql, params);
    return rows.map(r => ({ ...r, old_values: parseJSON(r.old_values, null), new_values: parseJSON(r.new_values, null) }));
}

// `license_issuance_failed` rows for which the same (target_type, target_id)
// pair has NO later `license_issuance_succeeded` row. Drives the admin
// sidebar badge and the audit-view Retry button. Bounded by `limit` for the
// list view; counters get the row count back from the same query.
async function getUnresolvedLicenseIssuanceFailures(limit = 50) {
    await initDB();
    const rows = await getAll(
        `SELECT f.* FROM subscription_audit_log f
          WHERE f.action = 'license_issuance_failed'
            AND NOT EXISTS (
              SELECT 1 FROM subscription_audit_log s
               WHERE s.action = 'license_issuance_succeeded'
                 AND s.target_type = f.target_type
                 AND s.target_id = f.target_id
                 AND s.created_at > f.created_at
            )
          ORDER BY f.created_at DESC
          LIMIT $1`,
        [Math.max(1, Number(limit) || 50)]
    );
    return rows.map(r => ({ ...r, old_values: parseJSON(r.old_values, null), new_values: parseJSON(r.new_values, null) }));
}

// ── Notification idempotency ─────────────────────────────
// Returns true when we have NOT yet sent this kind to this target — caller
// should then send. Atomic via PK conflict so two cron ticks can't race.
async function claimNotificationSlot(targetId, notifKind) {
    if (!targetId || !notifKind) return false;
    await initDB();
    try {
        const result = await run(
            `INSERT INTO license_notifications_sent (target_id, notif_kind)
             VALUES ($1, $2)
             ON CONFLICT (target_id, notif_kind) DO NOTHING`,
            [String(targetId), String(notifKind)]
        );
        return (result.rowCount || 0) > 0;
    } catch (e) {
        console.error('[UserStore] claimNotificationSlot error:', e.message);
        return false;
    }
}

async function getDunningCounts() {
    await initDB();
    try {
        const o = await getOne(`SELECT
            COUNT(*) FILTER (WHERE status = 'past_due')::int AS past_due_count,
            COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended_count
            FROM organization_subscriptions`);
        const c = await getOne(`SELECT
            COUNT(*) FILTER (WHERE status = 'past_due')::int AS past_due_count,
            COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended_count
            FROM consumer_subscriptions`);
        return {
            past_due_count: (o?.past_due_count || 0) + (c?.past_due_count || 0),
            suspended_count: (o?.suspended_count || 0) + (c?.suspended_count || 0),
        };
    } catch (_e) {
        return { past_due_count: 0, suspended_count: 0 };
    }
}

// ── Stripe webhook idempotency ─────────────────────────────
// Records that an event has been processed. Returns true on first insert,
// false if the event_id was already present (i.e. a duplicate delivery).
async function recordStripeEventProcessed(eventId, eventType, payloadHash = null) {
    if (!eventId) return true;
    await initDB();
    try {
        const result = await run(
            `INSERT INTO stripe_processed_events (event_id, event_type, payload_hash)
             VALUES ($1, $2, $3)
             ON CONFLICT (event_id) DO NOTHING`,
            [eventId, eventType || 'unknown', payloadHash]
        );
        return (result.rowCount || 0) > 0;
    } catch (e) {
        console.error('[UserStore] recordStripeEventProcessed error:', e.message);
        return true;
    }
}

// ── Dunning counters ─────────────────────────────
// Increment payment_attempt_count and stamp past_due_since on the first
// failure. Used by the Stripe invoice.payment_failed handler.
async function recordPaymentFailureForOrg(orgId) {
    await initDB();
    await run(
        `UPDATE organization_subscriptions
            SET payment_attempt_count = COALESCE(payment_attempt_count, 0) + 1,
                last_payment_failure_at = NOW(),
                past_due_since = COALESCE(past_due_since, NOW()),
                updated_at = $2
          WHERE organization_id = $1`,
        [orgId, new Date().toISOString()]
    );
    try { require('./usageStore').invalidatePaygCache(orgId, null); } catch (_) { /* circular-load safe */ }
    const row = await getOne(
        'SELECT payment_attempt_count, past_due_since FROM organization_subscriptions WHERE organization_id = $1',
        [orgId]
    );
    return row || null;
}

async function recordPaymentFailureForConsumer(userId) {
    await initDB();
    await run(
        `UPDATE consumer_subscriptions
            SET payment_attempt_count = COALESCE(payment_attempt_count, 0) + 1,
                last_payment_failure_at = NOW(),
                past_due_since = COALESCE(past_due_since, NOW()),
                updated_at = $2
          WHERE user_id = $1`,
        [userId, new Date().toISOString()]
    );
    try { require('./usageStore').invalidatePaygCache(null, userId); } catch (_) { /* circular-load safe */ }
    const row = await getOne(
        'SELECT payment_attempt_count, past_due_since FROM consumer_subscriptions WHERE user_id = $1',
        [userId]
    );
    return row || null;
}

async function resetPaymentFailureForOrg(orgId) {
    await initDB();
    await run(
        `UPDATE organization_subscriptions
            SET payment_attempt_count = 0,
                past_due_since = NULL,
                updated_at = $2
          WHERE organization_id = $1`,
        [orgId, new Date().toISOString()]
    );
    try { require('./usageStore').invalidatePaygCache(orgId, null); } catch (_) { /* circular-load safe */ }
}

async function resetPaymentFailureForConsumer(userId) {
    await initDB();
    await run(
        `UPDATE consumer_subscriptions
            SET payment_attempt_count = 0,
                past_due_since = NULL,
                updated_at = $2
          WHERE user_id = $1`,
        [userId, new Date().toISOString()]
    );
    try { require('./usageStore').invalidatePaygCache(null, userId); } catch (_) { /* circular-load safe */ }
}

// Run a sweep that suspends any org/consumer sub whose past_due_since is
// older than graceDays. Returns counts so the caller (scheduler) can log
// activity. Idempotent: re-running flips nothing once the sub is suspended.
async function suspendPastDueSubscriptions(graceDays = 7) {
    await initDB();
    const graceMs = Math.max(0, Number(graceDays)) * 86400 * 1000;
    const cutoffIso = new Date(Date.now() - graceMs).toISOString();

    const orgsToSuspend = await getAll(
        `SELECT organization_id, payment_attempt_count, past_due_since
           FROM organization_subscriptions
          WHERE past_due_since IS NOT NULL
            AND past_due_since < $1
            AND status NOT IN ('suspended', 'cancelled')`,
        [cutoffIso]
    );
    for (const row of orgsToSuspend) {
        try {
            await run(
                `UPDATE organization_subscriptions
                    SET status = 'suspended', payment_status = 'failed', updated_at = $2
                  WHERE organization_id = $1`,
                [row.organization_id, new Date().toISOString()]
            );
            try { require('./usageStore').invalidatePaygCache(row.organization_id, null); } catch (_) { /* circular-load safe */ }
            await logSubscriptionAudit(
                'dunning_suspend', 'organization', row.organization_id, 'system', null,
                { reason: 'past_due_grace_exceeded', attempt_count: row.payment_attempt_count, past_due_since: row.past_due_since, grace_days: graceDays }
            );
        } catch (e) {
            console.error('[UserStore] suspendPastDueSubscriptions org error:', row.organization_id, e.message);
        }
    }

    const consumersToSuspend = await getAll(
        `SELECT user_id, payment_attempt_count, past_due_since
           FROM consumer_subscriptions
          WHERE past_due_since IS NOT NULL
            AND past_due_since < $1
            AND status NOT IN ('suspended', 'cancelled')`,
        [cutoffIso]
    );
    for (const row of consumersToSuspend) {
        try {
            await run(
                `UPDATE consumer_subscriptions
                    SET status = 'suspended', payment_status = 'failed', updated_at = $2
                  WHERE user_id = $1`,
                [row.user_id, new Date().toISOString()]
            );
            try { require('./usageStore').invalidatePaygCache(null, row.user_id); } catch (_) { /* circular-load safe */ }
            await logSubscriptionAudit(
                'dunning_suspend', 'consumer', row.user_id, 'system', null,
                { reason: 'past_due_grace_exceeded', attempt_count: row.payment_attempt_count, past_due_since: row.past_due_since, grace_days: graceDays }
            );
        } catch (e) {
            console.error('[UserStore] suspendPastDueSubscriptions consumer error:', row.user_id, e.message);
        }
    }

    return { orgs: orgsToSuspend.length, consumers: consumersToSuspend.length };
}

// Persist trial-end transitions. Called by the trial-expiry scheduler.
// Subs whose trial_end_date has passed and that aren't paid get flipped to
// status='suspended', payment_status='trial_expired'. Idempotent.
async function expireOverdueTrials() {
    await initDB();
    const nowIso = new Date().toISOString();

    const orgsExpiring = await getAll(
        `SELECT organization_id, trial_end_date
           FROM organization_subscriptions
          WHERE status = 'trialing'
            AND trial_end_date IS NOT NULL
            AND trial_end_date < $1
            AND COALESCE(payment_status, '') NOT IN ('paid', 'trialing')`,
        [nowIso]
    );
    for (const row of orgsExpiring) {
        try {
            await run(
                `UPDATE organization_subscriptions
                    SET status = 'suspended', payment_status = 'trial_expired', updated_at = $2
                  WHERE organization_id = $1`,
                [row.organization_id, nowIso]
            );
            try { require('./usageStore').invalidatePaygCache(row.organization_id, null); } catch (_) { /* circular-load safe */ }
            await logSubscriptionAudit(
                'trial_expired', 'organization', row.organization_id, 'system', null,
                { trial_end_date: row.trial_end_date, transitioned_to: 'suspended' }
            );
        } catch (e) {
            console.error('[UserStore] expireOverdueTrials org error:', row.organization_id, e.message);
        }
    }

    const consumersExpiring = await getAll(
        `SELECT user_id, trial_end_date
           FROM consumer_subscriptions
          WHERE status = 'trialing'
            AND trial_end_date IS NOT NULL
            AND trial_end_date < $1
            AND COALESCE(payment_status, '') NOT IN ('paid', 'trialing')`,
        [nowIso]
    );
    for (const row of consumersExpiring) {
        try {
            await run(
                `UPDATE consumer_subscriptions
                    SET status = 'suspended', payment_status = 'trial_expired', updated_at = $2
                  WHERE user_id = $1`,
                [row.user_id, nowIso]
            );
            try { require('./usageStore').invalidatePaygCache(null, row.user_id); } catch (_) { /* circular-load safe */ }
            await logSubscriptionAudit(
                'trial_expired', 'consumer', row.user_id, 'system', null,
                { trial_end_date: row.trial_end_date, transitioned_to: 'suspended' }
            );
        } catch (e) {
            console.error('[UserStore] expireOverdueTrials consumer error:', row.user_id, e.message);
        }
    }

    return { orgs: orgsExpiring.length, consumers: consumersExpiring.length };
}

// Stripe transitions a subscription from `incomplete` → `incomplete_expired`
// after ~14 days when no payment method is added. If that webhook is missed
// (Stripe outage, misconfig), the local row stays `incomplete` forever and
// admins see a stuck subscription. Sweep + flip to `cancelled` matches
// Stripe's own expiry semantics. Idempotent and safe to call from a tick.
async function cancelStaleIncompleteSubscriptions(thresholdDays = 14) {
    await initDB();
    const cutoffIso = new Date(Date.now() - Math.max(0, Number(thresholdDays)) * 86400 * 1000).toISOString();

    const orgs = await getAll(
        `SELECT organization_id FROM organization_subscriptions
          WHERE status = 'incomplete' AND created_at < $1`,
        [cutoffIso]
    );
    for (const r of orgs) {
        try {
            // setOrgSubscription validates status, audits via the column-update
            // path, and busts the PAYG cache; reuse it for consistency.
            await setOrgSubscription(r.organization_id, { status: 'cancelled', payment_status: 'failed' });
            await logSubscriptionAudit(
                'cancel_stale_incomplete', 'organization', r.organization_id, 'system', null,
                { threshold_days: thresholdDays }
            );
        } catch (e) {
            console.error('[UserStore] cancelStaleIncompleteSubscriptions org error:', r.organization_id, e.message);
        }
    }

    const consumers = await getAll(
        `SELECT user_id FROM consumer_subscriptions
          WHERE status = 'incomplete' AND created_at < $1`,
        [cutoffIso]
    );
    for (const r of consumers) {
        try {
            await setConsumerSubscription(r.user_id, { status: 'cancelled', payment_status: 'failed' });
            await logSubscriptionAudit(
                'cancel_stale_incomplete', 'consumer', r.user_id, 'system', null,
                { threshold_days: thresholdDays }
            );
        } catch (e) {
            console.error('[UserStore] cancelStaleIncompleteSubscriptions consumer error:', r.user_id, e.message);
        }
    }

    return { orgs: orgs.length, consumers: consumers.length };
}

// Returns true if the subscription has a manual_override_until in the
// future. The Stripe webhook checks this before writing status/plan_id so
// admin-set state isn't immediately clobbered by a Stripe update.
function isManualOverrideActive(sub) {
    if (!sub || !sub.manual_override_until) return false;
    const t = new Date(sub.manual_override_until).getTime();
    return Number.isFinite(t) && t > Date.now();
}

// Override-aware atomic update. The naive pattern
//   const sub = await getOrgSubscription(orgId);
//   const safe = isManualOverrideActive(sub) ? stripOverridden(data) : data;
//   await setOrgSubscription(orgId, safe);
// is a TOCTOU — two concurrent webhooks both see override=false, both write.
// This wrapper resolves the override decision while the row is row-locked
// (FOR UPDATE), so concurrent webhooks serialise and the override state
// they see matches the state at the moment of their write.
//
// `fullUpdate`     — the update payload to apply when no override is active.
// `strippedUpdate` — the update payload to apply when override is active
//                    (typically the full payload with status / plan_id /
//                    payment_status removed; the caller knows which fields
//                    are admin-controlled).
//
// Returns { applied: 'full'|'stripped'|'none', overrideActive: bool }.
/**
 * Atomically apply an admin-initiated subscription update. Wraps the
 * read-modify-write in a SELECT … FOR UPDATE so two admins racing on the
 * same org serialise rather than last-write-wins. Returns the pre-image
 * snapshot for the caller's audit row, plus a `displaced` flag set when
 * this write overwrote a still-active override set by a different admin
 * within the last 60 seconds (the loser of the race).
 *
 * @param {string} orgId
 * @param {object} payload  fields to write through to setOrgSubscription
 */
async function setOrgSubscriptionWithLock(orgId, payload) {
    await initDB();
    const client = await getClient();
    let snapshot = null;
    let displaced = false;
    try {
        await client.query('BEGIN');
        const lockResult = await client.query(
            'SELECT * FROM organization_subscriptions WHERE organization_id = $1 FOR UPDATE',
            [orgId]
        );
        if (lockResult.rowCount > 0) {
            snapshot = lockResult.rows[0];
            // Race detection: if a different admin set an override within the
            // last 60 seconds and this write changes manual_override_*, the
            // existing override is being clobbered. Surface that to the
            // caller so both attempts can be audited.
            const prevOverrideBy = snapshot.manual_override_by;
            const prevOverrideUntil = snapshot.manual_override_until;
            const newOverrideBy = payload.manual_override_by;
            const isNewOverrideRequest = Object.prototype.hasOwnProperty.call(payload, 'manual_override_until');
            if (
                isNewOverrideRequest &&
                prevOverrideBy &&
                prevOverrideUntil &&
                new Date(prevOverrideUntil).getTime() > Date.now() &&
                prevOverrideBy !== newOverrideBy
            ) {
                displaced = true;
            }
        }
        await client.query('COMMIT');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw e;
    } finally {
        client.release();
    }
    const ok = await setOrgSubscription(orgId, payload);
    return { ok, snapshot, displaced };
}

async function setOrgSubscriptionRespectingOverride(orgId, fullUpdate, strippedUpdate) {
    await initDB();
    const client = await getClient();
    let overrideActive = false;
    try {
        await client.query('BEGIN');
        const lockResult = await client.query(
            'SELECT manual_override_until FROM organization_subscriptions WHERE organization_id = $1 FOR UPDATE',
            [orgId]
        );
        if (lockResult.rowCount === 0) {
            // No existing row — setOrgSubscription will INSERT. We can't
            // lock a row that doesn't exist; concurrent inserts will collide
            // on the org id and the second one will fall through to the
            // update branch on its retry. Safe to release the txn here.
            await client.query('COMMIT');
        } else {
            const until = lockResult.rows[0].manual_override_until;
            overrideActive = !!until && new Date(until).getTime() > Date.now();
            await client.query('COMMIT');
        }
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw e;
    } finally {
        client.release();
    }
    const payload = overrideActive ? strippedUpdate : fullUpdate;
    // Empty payload (stripped removed everything) → don't write.
    if (!payload || Object.keys(payload).length === 0) {
        return { applied: 'none', overrideActive };
    }
    await setOrgSubscription(orgId, payload);
    return { applied: overrideActive ? 'stripped' : 'full', overrideActive };
}

async function setConsumerSubscriptionRespectingOverride(userId, fullUpdate, strippedUpdate) {
    await initDB();
    const client = await getClient();
    let overrideActive = false;
    try {
        await client.query('BEGIN');
        const lockResult = await client.query(
            'SELECT manual_override_until FROM consumer_subscriptions WHERE user_id = $1 FOR UPDATE',
            [userId]
        );
        if (lockResult.rowCount === 0) {
            await client.query('COMMIT');
        } else {
            const until = lockResult.rows[0].manual_override_until;
            overrideActive = !!until && new Date(until).getTime() > Date.now();
            await client.query('COMMIT');
        }
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw e;
    } finally {
        client.release();
    }
    const payload = overrideActive ? strippedUpdate : fullUpdate;
    if (!payload || Object.keys(payload).length === 0) {
        return { applied: 'none', overrideActive };
    }
    await setConsumerSubscription(userId, payload);
    return { applied: overrideActive ? 'stripped' : 'full', overrideActive };
}

// Locate a subscription row by stripe_customer_id so customer.deleted can
// null the local mapping. Returns { scope: 'organization'|'consumer', id }
// or null.
async function findSubscriptionByStripeCustomerId(stripeCustomerId) {
    if (!stripeCustomerId) return null;
    await initDB();
    const org = await getOne(
        'SELECT organization_id FROM organization_subscriptions WHERE stripe_customer_id = $1 LIMIT 1',
        [stripeCustomerId]
    );
    if (org) return { scope: 'organization', id: org.organization_id };
    const consumer = await getOne(
        'SELECT user_id FROM consumer_subscriptions WHERE stripe_customer_id = $1 LIMIT 1',
        [stripeCustomerId]
    );
    if (consumer) return { scope: 'consumer', id: consumer.user_id };
    return null;
}

async function clearStripeCustomerIdForOrg(orgId) {
    await initDB();
    await run(
        `UPDATE organization_subscriptions
            SET stripe_customer_id = NULL, updated_at = $2
          WHERE organization_id = $1`,
        [orgId, new Date().toISOString()]
    );
}

async function clearStripeCustomerIdForConsumer(userId) {
    await initDB();
    await run(
        `UPDATE consumer_subscriptions
            SET stripe_customer_id = NULL, updated_at = $2
          WHERE user_id = $1`,
        [userId, new Date().toISOString()]
    );
}

// ── Atomic seat-cap user creation ─────────────────────────────
// Wraps createUser in a serializable transaction so that two concurrent
// admin-add-user requests cannot both pass a "we have room" check and both
// commit. The cap is computed inside the transaction from the live row
// count + the org's effective max_users + the license seat cap. Throws
// SeatCapExceededError when the cap is hit; the caller maps that to 403.
//
// strict=true (default): throw on cap exceed.
// strict=false: return { created: false, reason: 'seat_cap' } so bulk sync
//   paths (Azure, NC) can log+skip without crashing the batch.
class SeatCapExceededError extends Error {
    constructor(current, max, organizationId) {
        super(`seat_cap_exceeded org=${organizationId} current=${current} max=${max}`);
        this.name = 'SeatCapExceededError';
        this.current = current;
        this.max = max;
        this.organizationId = organizationId;
    }
}

async function createUserWithSeatCheck(userData, { strict = true } = {}) {
    await initDB();
    const orgId = userData.organizationId || '';
    if (!orgId) {
        const ok = await createUser(userData);
        return { created: ok, reason: ok ? null : 'create_failed' };
    }

    let max = null;
    try {
        const limits = await getEffectiveLimits(orgId);
        max = limits?.max_users ?? null;
    } catch (_e) { /* ignore */ }
    try {
        const license = require('../license');
        const seatCap = typeof license.getMaxSeatsForOrg === 'function'
            ? await license.getMaxSeatsForOrg(orgId)
            : null;
        if (seatCap != null && (max == null || seatCap < max)) max = seatCap;
    } catch (_e) { /* license module optional during early boot */ }

    const insertParams = (() => {
        const mwDek = userData.masterWrappedDEK
            ? (typeof userData.masterWrappedDEK === 'string' ? userData.masterWrappedDEK : JSON.stringify(userData.masterWrappedDEK))
            : null;
        const wDek = userData.wrappedDEK
            ? (typeof userData.wrappedDEK === 'string' ? userData.wrappedDEK : JSON.stringify(userData.wrappedDEK))
            : null;
        return [
            userData.id, userData.username, userData.displayName || userData.username,
            userData.firstName || null, userData.lastName || null, userData.email || null,
            userData.phone || null, userData.avatar || null, userData.avatarType || null,
            userData.passwordHash, userData.role || 'user',
            JSON.stringify(userData.groups || []), mwDek, wDek,
            userData.orgRole || '', orgId,
            new Date().toISOString().split('T')[0], userData.status || 'active',
            userData.azureUserId || null, userData.ncUid || null,
            userData.provider || null, userData.autoProvisioned ? true : false,
        ];
    })();

    for (let attempt = 0; attempt < 2; attempt++) {
        const client = await getClient();
        try {
            await client.query('BEGIN');
            await client.query("SET LOCAL TRANSACTION ISOLATION LEVEL SERIALIZABLE");

            if (max != null) {
                // PG rejects FOR UPDATE alongside aggregate functions
                // ("FOR UPDATE is not allowed with aggregate functions"),
                // so we count rows under SERIALIZABLE isolation instead.
                // Concurrent INSERTs that would push us over the cap raise
                // a 40001 serialization failure on COMMIT, which the
                // attempt-retry below already handles.
                const countRow = await client.query(
                    `SELECT COUNT(*)::int AS n FROM users WHERE "organizationId" = $1 AND COALESCE(status, 'active') = 'active'`,
                    [orgId]
                );
                const current = countRow.rows[0]?.n ?? 0;
                if (current >= max) {
                    await client.query('ROLLBACK');
                    client.release();
                    console.warn(`[seat.cap] ${strict ? 'blocked' : 'skipped'} org=${orgId} current=${current} max=${max}`);
                    if (strict) throw new SeatCapExceededError(current, max, orgId);
                    return { created: false, reason: 'seat_cap', current, max };
                }
            }

            const existing = await client.query('SELECT id FROM users WHERE id = $1', [userData.id]);
            if (existing.rowCount > 0) {
                await client.query('ROLLBACK');
                client.release();
                return { created: false, reason: 'duplicate_id' };
            }

            await client.query(
                `INSERT INTO users (id, username, "displayName", "firstName", "lastName", email, phone, avatar, "avatarType", "passwordHash", role, groups, "masterWrappedDEK", "wrappedDEK", "orgRole", "organizationId", "createdAt", status, "azureUserId", "nc_uid", "provider", "auto_provisioned")
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
                insertParams
            );
            await client.query('COMMIT');
            client.release();
            // Fire-and-forget Stripe seat-quantity sync. Per-seat plans rebill
            // when the active user count changes; we don't await so a Stripe
            // outage can't block user creation. The webhook will reconcile
            // stripe_seat_quantity once the update is processed.
            if (orgId) {
                Promise.resolve().then(async () => {
                    try {
                        const { syncSeatQuantityForOrg } = require('../services/stripeService');
                        await syncSeatQuantityForOrg(orgId);
                    } catch (_) { /* best-effort */ }
                });
            }
            return { created: true, reason: null };
        } catch (e) {
            try { await client.query('ROLLBACK'); } catch (_) { }
            client.release();
            if (e && e.code === '40001' && attempt < 1) continue;
            if (e instanceof SeatCapExceededError) throw e;
            console.error('[UserStore] createUserWithSeatCheck error:', e.message);
            return { created: false, reason: 'create_failed', error: e.message };
        }
    }
    return { created: false, reason: 'create_failed' };
}

module.exports = {
    getAllUsers, getAllUserAvatars, getUser, getUserByEmail, createUser, updateUser, deleteUser,
    createUserWithSeatCheck, SeatCapExceededError, PlanInUseError,
    getAllOrganizations, getOrganization, getOrganizationByNcInstanceId, createOrganization, updateOrganization, deleteOrganization,
    findUnboundOrgByEmailDomain,
    getOrgEnabledIntegrations, setOrgEnabledIntegrations, getOrgEnabledBetaFeatures, setOrgEnabledBetaFeatures,
    getUserByNcUid,
    createPendingNcBinding, getPendingNcBinding, getPendingNcBindingForOrg,
    createPendingNcVerification, verifyPendingNcCode, resetNcVerificationCode,
    retargetNcVerification, countActivePendingNcVerificationsForOrg,
    createOrgPairingCode, getPendingBindingByPairingCode, consumePairingCode,
    getActivePairingCodesForOrg, deletePairingCode,
    countActivePendingNcBindingsForOrg, markPendingNcBindingApproved,
    markPendingNcBindingDenied, expirePendingNcBindings,
    getAllGroups, createGroup, updateGroup, deleteGroup, getGroupByAzureId, getUserByAzureId,
    storeAppPassword, getAppPassword, hasAppPassword, deleteAppPassword,
    getAllRoles, createRole, updateRole, deleteRole,
    getAllPlans, getPlan, getDefaultNcPlan, createPlan, updatePlan, deletePlan,
    getAllOrgSubscriptions, getOrgSubscription, setOrgSubscription, deleteOrgSubscription, getEffectiveLimits, getActiveSeatCount,
    getConsumerSubscription, setConsumerSubscription, deleteConsumerSubscription, getAllConsumerSubscriptions,
    getBillingPeriod, logSubscriptionAudit, getAuditLog, getUnresolvedLicenseIssuanceFailures,
    logAccessAudit, getAccessAuditLog, claimNotification,
    markTrialUsed, hasOrgUsedTrial, hasUserUsedTrial,
    hasEmailUsedTrial, recordTrialHistory, backfillTrialHistory, backfillAutoProvisionedNcOrgNames,
    recordStripeEventProcessed,
    recordPaymentFailureForOrg, recordPaymentFailureForConsumer,
    resetPaymentFailureForOrg, resetPaymentFailureForConsumer,
    suspendPastDueSubscriptions, expireOverdueTrials, cancelStaleIncompleteSubscriptions,
    findSubscriptionByStripeCustomerId, clearStripeCustomerIdForOrg, clearStripeCustomerIdForConsumer,
    isManualOverrideActive,
    setOrgSubscriptionRespectingOverride, setConsumerSubscriptionRespectingOverride,
    setOrgSubscriptionWithLock,
    claimNotificationSlot, getDunningCounts,
};
