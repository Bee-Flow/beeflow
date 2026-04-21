/**
 * Compliance Runner — executes checks and persists their results.
 */

const registry = require('./registry');
const complianceStore = require('../stores/complianceStore');

/**
 * Run every registered check for a given organization.
 * Returns an array of evaluation results (also persisted).
 */
async function runAll(orgId, { runType = 'scheduled' } = {}) {
    const checks = registry.getAll().filter(c => c.scope !== 'per-source');
    const results = [];
    for (const check of checks) {
        const result = await _runSafe(check, orgId);
        results.push(result);
        await complianceStore.recordCheckResult({
            organization_id: orgId,
            check_id: check.id,
            regulation: check.regulation,
            article: check.article,
            severity: check.severity,
            status: result.status,
            evidence: result.evidence,
            details: result.details,
            scope_type: 'global',
            scope_id: null,
            run_type: runType,
        });
    }
    return results;
}

/**
 * Run a single check by id.
 */
async function runOne(orgId, checkId, { runType = 'manual' } = {}) {
    const check = registry.get(checkId);
    if (!check) throw new Error(`Unknown check: ${checkId}`);
    const result = await _runSafe(check, orgId);
    await complianceStore.recordCheckResult({
        organization_id: orgId,
        check_id: check.id,
        regulation: check.regulation,
        article: check.article,
        severity: check.severity,
        status: result.status,
        evidence: result.evidence,
        details: result.details,
        scope_type: 'global',
        scope_id: null,
        run_type: runType,
    });
    return { check_id: check.id, ...result };
}

async function _runSafe(check, orgId) {
    try {
        const r = await check.evaluate(orgId, null);
        return {
            status: r?.status || 'not_applicable',
            evidence: r?.evidence || {},
            details: r?.details || null,
        };
    } catch (e) {
        console.error(`[ComplianceRunner] ${check.id} threw:`, e.message);
        return {
            status: 'fail',
            evidence: { error: e.message },
            details: `Check raised an exception: ${e.message}`,
        };
    }
}

module.exports = { runAll, runOne };
