/**
 * Webpage row-insert / row-update triggers (§20 scaffolding).
 *
 * Lets a routine fire when a webpage's SQLite DB receives an INSERT or
 * UPDATE on a specific table — the back-channel that turns a webpage
 * from a one-way data sink into a two-way integration.
 *
 * Architecture (Phase 2):
 *   1. On first activation by a routine, install AFTER INSERT /
 *      AFTER UPDATE triggers on the target table that write rowid +
 *      op + ts into a `__webpage_changefeed` table.
 *   2. A 10-second poller scans `__webpage_changefeed` for unprocessed
 *      rows and emits `webpages.row.inserted` / `webpages.row.updated`
 *      events to triggerBus.dispatchEvent.
 *   3. After successful dispatch, the changefeed row is marked
 *      processed so it isn't re-fired.
 *
 * Phase 1 lands the module file + the event vocabulary so the trigger
 * picker UI and the catalog can list the event names. Actual changefeed
 * installation + polling arrives in Phase 2.
 */

const SUPPORTED_EVENTS = ['row.inserted', 'row.updated'];

async function installChangefeed(/* { webpageId, tableName } */) {
    // Phase 2: install SQLite triggers + ensure __webpage_changefeed exists.
    return { installed: false };
}

async function pollChangefeed(/* { webpageId } */) {
    // Phase 2: scan and dispatch.
    return { dispatched: 0 };
}

module.exports = { SUPPORTED_EVENTS, installChangefeed, pollChangefeed };
