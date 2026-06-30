/**
 * Shared store core (§WS5): DB handles + the self-applied migration runner.
 * Leaf module — aggregates require this; it requires nothing in automationStore/.
 */

const { run, getOne, getAll, exec, getClient, pool } = require('../../db');

let initialized = false;

// Ordered migration list. The first (init) is foundational; the rest are
// incremental ALTERs applied on top. §WS3.4: each is tolerated individually so
// one transient failure doesn't block the store, but every failure is now
// LOGGED LOUDLY with its name — the previous silent `catch {}` hid a
// half-migrated schema behind opaque runtime 500s with no breadcrumb.
const MIGRATIONS = [
    'automation-builder-2026-05-init',          // foundational — must succeed
    'automation-locking-and-session-2026-05',
    'automation-clear-first-run-confirm-2026-05',
    'automation-timeout-and-subs-2026-05',
    'automation-event-mode-2026-05',
    'automation-approval-and-parallel-2026-06',
    'automation-error-class-2026-06',
    'automation-approval-expiry-2026-06',
    'automation-heartbeat-2026-06',
    'automation-alerts-2026-06',
    'automation-extras-2026-06',
    'n8n-connections-2026-06',
    'automation-layers-2026-06',
    'automation-inline-layers-2026-06',
    'automation-version-summary-2026-06',
    'automation-steps-2026-06',
    'automation-runs-history-2026-06',
    'automation-fk-cascade-2026-06',            // §WS3.2 — child-table FK/CASCADE
    'automation-shared-groups-jsonb-2026-06',   // §WS3.6 — shared_groups TEXT→JSONB
];

async function initDB() {
    if (initialized) return;
    // The init migration creates the base tables — if it fails there is no
    // schema at all, so rethrow and do NOT mark initialized (the next call
    // retries rather than serving a store with no tables).
    await require(`../../migrations/${MIGRATIONS[0]}`).up();

    const failures = [];
    for (const name of MIGRATIONS.slice(1)) {
        try {
            await require(`../../migrations/${name}`).up();
        } catch (e) {
            failures.push(name);
            console.error(`[AutomationStore] migration ${name} FAILED: ${e.message}`);
        }
    }
    initialized = true;
    if (failures.length) {
        console.error(`[AutomationStore] ${failures.length} migration(s) failed to apply: ${failures.join(', ')} — the automation schema may be incomplete and queries referencing the missing columns will error. Fix the migration / ensure the DB is reachable and restart.`);
    } else {
        console.log('[AutomationStore] PostgreSQL initialized');
    }
}

initDB().catch(err => console.error('[AutomationStore] Init error (base schema):', err.message));

module.exports = { run, getOne, getAll, exec, getClient, pool, initDB };
