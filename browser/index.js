/**
 * Browser Agent — Public API
 *
 * All imports should go through this index module.
 */

const { executeBrowserTask } = require('./orchestrator');
const { BROWSER_TOOLS } = require('./tools');
const { createElementMap } = require('./observation');

module.exports = {
    executeBrowserTask,
    BROWSER_TOOLS,
    createElementMap
};
