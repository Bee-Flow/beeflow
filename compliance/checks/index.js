/**
 * Check auto-registration — requires every check file under gdpr/ and aia/
 * and registers it with the compliance registry.
 */

const fs = require('fs');
const path = require('path');
const registry = require('../registry');

function _loadDir(dir) {
    const abs = path.join(__dirname, dir);
    if (!fs.existsSync(abs)) return;
    for (const file of fs.readdirSync(abs)) {
        if (!file.endsWith('.js')) continue;
        try {
            const check = require(path.join(abs, file));
            registry.register(check);
        } catch (e) {
            console.error(`[ComplianceChecks] Failed to load ${dir}/${file}:`, e.message);
        }
    }
}

_loadDir('gdpr');
_loadDir('aia');

console.log(`[ComplianceChecks] Registered ${registry.getAll().length} checks`);

module.exports = registry;
