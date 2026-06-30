/**
 * Automation Store — PostgreSQL-backed automation definitions, runs, and triggers.
 *
 * §WS5 facade: the implementation lives in ./automationStore/* aggregates behind
 * this stable path (migrateDb.js + every require('../stores/automationStore')
 * caller is unchanged). Each aggregate re-exports its public functions; this file
 * spreads them into the identical module.exports surface this file had before.
 */

const core = require('./automationStore/core');
const { rowToRunStep, fromJsonb } = require('./automationStore/rowMappers');

module.exports = {
    initDB: core.initDB,
    ...require('./automationStore/automations'),
    ...require('./automationStore/builderSessions'),
    ...require('./automationStore/versions'),
    ...require('./automationStore/steps'),
    ...require('./automationStore/runs'),
    ...require('./automationStore/webhooks'),
    ...require('./automationStore/subscriptions'),
    // Exported for unit tests.
    rowToRunStep,
    fromJsonb,
};
