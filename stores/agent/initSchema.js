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
    await exec(`
        CREATE TABLE IF NOT EXISTS swarm_orchestrator (
            id INTEGER PRIMARY KEY DEFAULT 1,
            model TEXT,
            temperature REAL DEFAULT 0.3,
            max_tokens INTEGER DEFAULT 2000,
            system_prompt TEXT,
            worker_timeout INTEGER DEFAULT 180000,
            max_retries INTEGER DEFAULT 3,
            auto_test BOOLEAN DEFAULT TRUE,
            skip_form_simple BOOLEAN DEFAULT TRUE,
            builder_max_iterations INTEGER DEFAULT 15,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await exec(`
        CREATE TABLE IF NOT EXISTS swarm_workers (
            id TEXT PRIMARY KEY,
            swarm_id TEXT NOT NULL,
            phase_id TEXT DEFAULT 'research',
            worker_key TEXT NOT NULL,
            enabled BOOLEAN DEFAULT TRUE,
            name TEXT NOT NULL,
            icon TEXT DEFAULT '',
            color TEXT DEFAULT '#888',
            description TEXT DEFAULT '',
            model TEXT,
            temperature REAL DEFAULT 0.3,
            max_tokens INTEGER DEFAULT 2000,
            use_tools BOOLEAN DEFAULT FALSE,
            system_prompt TEXT,
            sort_order INTEGER DEFAULT 0,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`
        CREATE TABLE IF NOT EXISTS swarm_phases (
            phase_key TEXT PRIMARY KEY,
            phase_number INTEGER NOT NULL,
            name TEXT NOT NULL,
            goal TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0
        )
    `);
    await exec('CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_id)');
    await exec('CREATE INDEX IF NOT EXISTS idx_agent_tools_agent ON agent_tools(agent_id)');
    await exec('CREATE INDEX IF NOT EXISTS idx_agent_conversations_agent ON agent_conversations(agent_id)');
    await exec('CREATE INDEX IF NOT EXISTS idx_agent_conversations_user ON agent_conversations(user_id)');
    await exec('CREATE INDEX IF NOT EXISTS idx_direct_conversations_user ON direct_conversations(user_id)');

    // Migration: Fix stale system agent model values (display labels → tier:fast)
    await exec(`UPDATE agents SET model = 'tier:fast' WHERE owner_id = 'system' AND model IS NOT NULL AND model != '' AND model NOT LIKE 'tier:%'`);

    // Migration: Add workspace_content column to direct_conversations if missing
    try { await exec(`ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS workspace_content TEXT DEFAULT ''`); } catch (e) { /* already exists */ }
    // Migration: Add meta_json column for provider-specific state (e.g. OpenAI lastResponseId)
    try { await exec(`ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS meta_json TEXT DEFAULT '{}'`); } catch (e) { /* already exists */ }

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
}

module.exports = { initDB };
