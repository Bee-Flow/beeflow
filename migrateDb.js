#!/usr/bin/env node
/**
 * Database Migration Runner
 * 
 * Loads all store modules to trigger their built-in schema migrations
 * (CREATE TABLE IF NOT EXISTS, ALTER TABLE ADD COLUMN, etc.)
 * 
 * All stores use PostgreSQL via DATABASE_URL.
 * 
 * Usage:
 *   node migrateDb.js          # Run all migrations
 *   npm run db:migrate         # Same via npm script
 *   docker exec beeflow-server node migrateDb.js  # Inside container
 */

const path = require('path');

// Safety timeout: force exit after 30s in case store modules keep the event loop alive
setTimeout(() => {
    console.error('[migrate] ⚠️ Timeout — forcing exit');
    process.exit(1);
}, 30000).unref();

// All store modules that contain database migrations
const STORE_MODULES = [
    { name: 'userStore', file: './stores/userStore' },
    { name: 'watcherStateStore', file: './stores/watcherStateStore' },
    { name: 'workflowStore', file: './stores/workflowStore' },
    { name: 'configStore', file: './stores/configStore' },
    { name: 'agentStore', file: './stores/agentStore' },
    { name: 'appStore', file: './stores/appStore' },
    { name: 'swarmStore', file: './stores/swarmStore' },
    { name: 'memoryStore', file: './stores/memoryStore' },
    { name: 'usageStore', file: './stores/usageStore' },
    { name: 'knowledgeStore', file: './stores/knowledgeStore' },
    { name: 'groupChatStore', file: './stores/groupChatStore' },
    { name: 'browserAgentStore', file: './stores/browserAgentStore' },
    { name: 'terminalAgentStore', file: './stores/terminalAgentStore' },
    { name: 'securityAgentStore', file: './stores/securityAgentStore' },
    { name: 'taskStore', file: './stores/taskStore' },
    { name: 'notificationStore', file: './stores/notificationStore' },
    { name: 'projectStore', file: './stores/projectStore' },
    { name: 'reminderStore', file: './stores/reminderStore' },
    { name: 'templateStore', file: './stores/templateStore' },
    { name: 'monitoringStore', file: './stores/monitoringStore' },
    { name: 'transcriptionStore', file: './stores/transcriptionStore' },
    { name: 'mcpStore', file: './stores/mcpStore' },
    { name: 'importStore', file: './stores/importStore' },
    { name: 'iconStore', file: './stores/iconStore' },
];

console.log('');
console.log('═══════════════════════════════════════');
console.log('  Bee Flow — Database Migration Runner');
console.log('═══════════════════════════════════════');
console.log('');

const dbUrl = process.env.CORE_DATABASE_URL || 'not set';
console.log(`[migrate] Database: ${dbUrl.replace(/:[^:@]+@/, ':***@')}`);
console.log('');

// Pre-create user_sessions table (connect-pg-simple uses its own pool.query
// which bypasses our serialized exec(), so we create it first)
const { pool } = require('./db');
pool.query(`
    CREATE TABLE IF NOT EXISTS "user_sessions" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL,
        CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("sid")
    );
    CREATE INDEX IF NOT EXISTS "IDX_user_sessions_expire" ON "user_sessions" ("expire");
`).then(() => {
    console.log('  ✅ user_sessions (pre-created)');
}).catch(err => {
    console.error('  ❌ user_sessions:', err.message);
});

let success = 0;
let failed = 0;

for (const store of STORE_MODULES) {
    try {
        require(store.file);
        console.log(`  ✅ ${store.name}`);
        success++;
    } catch (err) {
        console.error(`  ❌ ${store.name}: ${err.message}`);
        failed++;
    }
}

console.log('');

if (failed > 0) {
    console.error(`[migrate] ❌ ${failed} store(s) failed, ${success} succeeded`);
    process.exit(1);
} else {
    console.log(`[migrate] ✅ All ${success} stores migrated successfully`);
    process.exit(0);
}
