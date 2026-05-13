/**
 * Agent Schema Init - Shared PostgreSQL table creation for all agent sub-modules
 * Uses a promise singleton to prevent concurrent CREATE TABLE races.
 */

const { exec } = require('../../db');

let initPromise = null;

async function initDB() {
    if (initPromise) return initPromise;
    initPromise = _doInit();
    return initPromise;
}

async function _doInit() {
    await exec(`
        CREATE TABLE IF NOT EXISTS agents (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            system_prompt TEXT,
            model TEXT,
            owner_id TEXT NOT NULL,
            is_published BOOLEAN DEFAULT FALSE,
            starter_prompts TEXT DEFAULT '[]',
            avatar TEXT,
            threads_enabled BOOLEAN DEFAULT TRUE,
            copy_enabled BOOLEAN DEFAULT TRUE,
            workspace_enabled BOOLEAN DEFAULT FALSE,
            embed_enabled BOOLEAN DEFAULT FALSE,
            config TEXT DEFAULT '{}',
            organization_id TEXT,
            shared_groups TEXT DEFAULT '[]',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`
        CREATE TABLE IF NOT EXISTS agent_tools (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            component_id TEXT NOT NULL,
            params_json TEXT,
            FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
            UNIQUE(agent_id, component_id)
        )
    `);
    await exec(`
        CREATE TABLE IF NOT EXISTS agent_conversations (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            title TEXT DEFAULT 'New Chat',
            messages_json TEXT DEFAULT '[]',
            workspace_content TEXT DEFAULT '',
            thread_titles_json TEXT DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
        )
    `);
    await exec(`
        CREATE TABLE IF NOT EXISTS direct_conversations (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            title TEXT DEFAULT 'New Chat',
            messages_json TEXT DEFAULT '[]',
            workspace_content TEXT DEFAULT '',
            model_tier TEXT DEFAULT 'fast',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec('CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_id)');
    await exec('CREATE INDEX IF NOT EXISTS idx_agent_tools_agent ON agent_tools(agent_id)');
    await exec('CREATE INDEX IF NOT EXISTS idx_agent_conversations_agent ON agent_conversations(agent_id)');
    await exec('CREATE INDEX IF NOT EXISTS idx_agent_conversations_user ON agent_conversations(user_id)');
    await exec('CREATE INDEX IF NOT EXISTS idx_direct_conversations_user ON direct_conversations(user_id)');

    // ── Phase 2: Composite indexes for hot listing queries ─────────────────────
    // listAllConversations(userId) → ORDER BY updated_at DESC
    await exec('CREATE INDEX IF NOT EXISTS idx_agent_conv_user_updated ON agent_conversations(user_id, updated_at DESC)');
    // listDirectConversations(userId) → ORDER BY updated_at DESC
    await exec('CREATE INDEX IF NOT EXISTS idx_direct_conv_user_updated ON direct_conversations(user_id, updated_at DESC)');
    // listConversations(agentId, userId) → WHERE agent_id=$1 AND user_id=$2 ORDER BY updated_at DESC
    await exec('CREATE INDEX IF NOT EXISTS idx_agent_conv_agent_user_updated ON agent_conversations(agent_id, user_id, updated_at DESC)');

    // ── Phase 6: pg_trgm GIN indexes for fast ILIKE search ────────────────────
    // pg_trgm accelerates ILIKE '%term%' queries from full-scan to index lookup.
    // Wrapped in try/catch: CREATE EXTENSION requires superuser; if unavailable
    // the ILIKE queries in searchConversations() still work, just without the
    // index acceleration (~10–50x slower, but only affects the search endpoint).
    try { await exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm`); } catch (e) {
        console.warn('[initSchema] pg_trgm unavailable (superuser needed) — search will use full scans');
    }
    try {
        // Accelerates: conversation_messages.content ILIKE '%query%'
        await exec(`CREATE INDEX IF NOT EXISTS idx_conv_messages_content_trgm
            ON conversation_messages USING GIN (content gin_trgm_ops)`);
    } catch (e) { /* pg_trgm not available — index skipped */ }
    try {
        // Accelerates: agent_conversations.title ILIKE '%query%'
        await exec(`CREATE INDEX IF NOT EXISTS idx_agent_conv_title_trgm
            ON agent_conversations USING GIN (title gin_trgm_ops)`);
    } catch (e) { /* pg_trgm not available — index skipped */ }

    // Migration: Fix stale system agent model values (display labels → tier:fast)
    await exec(`UPDATE agents SET model = 'tier:fast' WHERE owner_id = 'system' AND model IS NOT NULL AND model != '' AND model NOT LIKE 'tier:%'`);

    // Migration: Add workspace_content column to direct_conversations if missing
    try { await exec(`ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS workspace_content TEXT DEFAULT ''`); } catch (e) { /* already exists */ }
    // Migration: Add meta_json column for provider-specific state (e.g. OpenAI lastResponseId, compactionSummary)
    try { await exec(`ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS meta_json TEXT DEFAULT '{}'`); } catch (e) { /* already exists */ }
    try { await exec(`ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS meta_json TEXT DEFAULT '{}'`); } catch (e) { /* already exists */ }

    // Migration: Add project_id for Projects feature
    try { await exec(`ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS project_id TEXT`); } catch (e) { /* already exists */ }
    try { await exec(`ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS project_id TEXT`); } catch (e) { /* already exists */ }
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_direct_conversations_project ON direct_conversations(project_id)`); } catch (e) { /* already exists */ }
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_agent_conversations_project ON agent_conversations(project_id)`); } catch (e) { /* already exists */ }

    // Migration: Add pinned column for pin/unpin feature
    try { await exec(`ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE`); } catch (e) { /* already exists */ }
    try { await exec(`ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE`); } catch (e) { /* already exists */ }

    // Migration: Add labels_json column for conversation labels
    try { await exec(`ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS labels_json TEXT DEFAULT '[]'`); } catch (e) { /* already exists */ }
    try { await exec(`ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS labels_json TEXT DEFAULT '[]'`); } catch (e) { /* already exists */ }

    // Migration: Add pii_token_map column for Privacy Shield token round-trip
    // across server restarts. Stores `{ "[person_1]": "Gerard …", … }` so that
    // notebook content / tool history / saved messages with raw tokens can be
    // restored to real values on conversation reload even after the in-memory
    // map at server/core/dlp/dlpRunner.js has been wiped.
    try { await exec(`ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS pii_token_map JSONB`); } catch (e) { /* already exists */ }
    try { await exec(`ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS pii_token_map JSONB`); } catch (e) { /* already exists */ }

    // Migration: Add workspace_notebook_id to link workspace notebook to conversation
    try { await exec(`ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS workspace_notebook_id TEXT`); } catch (e) { /* already exists */ }
    try { await exec(`ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS workspace_notebook_id TEXT`); } catch (e) { /* already exists */ }

    // Agent categories (org-level)
    await exec(`CREATE TABLE IF NOT EXISTS agent_categories (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        name TEXT NOT NULL,
        icon TEXT DEFAULT '📁',
        color TEXT DEFAULT '#6366f1',
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_agent_categories_org ON agent_categories(organization_id)`); } catch (e) { /* already exists */ }

    // Migration: Add category_id column to agents
    try { await exec(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS category_id TEXT`); } catch (e) { /* already exists */ }

    // User-defined conversation labels
    await exec(`CREATE TABLE IF NOT EXISTS conversation_labels (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#6366f1',
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_conversation_labels_user ON conversation_labels(user_id)`); } catch (e) { /* already exists */ }

    // Per-user agent favorites (replaces client-side localStorage `agentFavorites`)
    await exec(`CREATE TABLE IF NOT EXISTS agent_favorites (
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, agent_id),
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    )`);
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_agent_favorites_user ON agent_favorites(user_id)`); } catch (e) { /* already exists */ }

    // ── R4 backfill: legacy `enabledIntegrations: null` → explicit catalog ──
    // Wizard-created agents historically stored `null`, which the runtime
    // interpreted as "everything enabled". The new default is OFF — empty
    // arrays mean nothing. Convert legacy null/missing rows to an explicit
    // list mirroring every named integration in the wizard catalog so
    // existing agents keep the access they had. Per-credential gating in
    // integrationTools.js still filters tools the user can't actually call.
    // Idempotent: only touches rows whose key is null or missing.
    try {
        const LEGACY_FULL = JSON.stringify([
            'gmail','google-calendar','google-drive','google-sheets','google-docs','google-slides',
            'google-contacts','google-keep','google-groups','outlook','ms-calendar','onedrive',
            'ms-contacts','fireflies','youtrack','gamma','linkedin','n8n','agent-search','image-gen',
        ]);
        await exec(`
            UPDATE agents
            SET config = jsonb_set(
                COALESCE(config, '{}'::jsonb),
                '{enabledIntegrations}',
                '${LEGACY_FULL}'::jsonb,
                true
            )
            WHERE
                config IS NULL
                OR NOT (config ? 'enabledIntegrations')
                OR config -> 'enabledIntegrations' = 'null'::jsonb
        `);
    } catch (e) { console.warn('[agentStore] R4 backfill skipped:', e.message); }
}

module.exports = { initDB };
