/**
 * Custom-integrations kill switch (dark-ship gate).
 *
 * Unlike feature_notebooks_enabled (default ON, `=== false` disables, fail
 * open), this feature ships DARK: the flag must be explicitly truthy to enable,
 * and any lookup failure fails CLOSED. The same flag is checked at every layer
 * — route mount, tool injection, the REST runner, and the MCP client — so
 * flipping it off removes the feature everywhere at once.
 */

const FLAG_KEY = 'feature_custom_integrations_enabled';

async function isCustomIntegrationsEnabled() {
    try {
        const configStore = require('../../stores/configStore');
        const raw = await configStore.getConfig(FLAG_KEY);
        return raw === true || raw === 'true' || raw === '1' || raw === 1;
    } catch (_) {
        return false; // fail closed — feature ships dark
    }
}

async function customIntegrationsFeatureGate(req, res, next) {
    if (await isCustomIntegrationsEnabled()) return next();
    return res.status(404).json({ error: 'not_found' });
}

module.exports = { isCustomIntegrationsEnabled, customIntegrationsFeatureGate, FLAG_KEY };
