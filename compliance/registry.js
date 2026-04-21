/**
 * ComplianceCheckRegistry — holds every compliance check module.
 *
 * A check module exports:
 *   {
 *     id: 'GDPR-Art32-encryption-at-rest',
 *     regulation: 'GDPR' | 'AIA',
 *     article: '32',
 *     severity: 'critical' | 'high' | 'medium' | 'low',
 *     scope: 'global' | 'per-source',
 *     titleKey, descriptionKey, remediationKey,  // i18n keys
 *     remediationLink,                            // deep-link for "How to fix"
 *     evaluate(orgId, scope) -> { status, evidence, details }
 *   }
 */

const _checks = new Map();

function register(check) {
    if (!check || !check.id) throw new Error('Check must have an id');
    if (typeof check.evaluate !== 'function') throw new Error(`Check ${check.id} missing evaluate()`);
    if (_checks.has(check.id)) {
        console.warn(`[ComplianceRegistry] Duplicate check id "${check.id}" — overwriting`);
    }
    _checks.set(check.id, check);
}

function get(id) { return _checks.get(id); }
function getAll() { return Array.from(_checks.values()); }
function getByRegulation(regulation) {
    return getAll().filter(c => c.regulation === regulation);
}

module.exports = { register, get, getAll, getByRegulation };
