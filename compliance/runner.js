/**
 * Compliance Runner — executes checks and persists their results.
 *
 * Check contract (see registry.js for full docs):
 *   - `scope: 'global' | 'per-source'`
 *     Per-source checks must also export `listSubjects(orgId) -> [{ id, label }]`.
 *     The runner invokes evaluate() once per subject, persisting one row each.
 *   - Every result row is paired with an immutable evidence record
 *     (compliance_evidence) containing a SHA-256 hash of the payload. This is
 *     what makes the system defensible under GDPR Art. 5(2) accountability.
 */

const crypto = require('crypto');
const registry = require('./registry');
const complianceStore = require('../stores/complianceStore');

function _hashPayload(payload) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(payload || {}))
        .digest('hex');
}

async function _persistResult(check, orgId, result, runType, subject) {
    const scopeType = subject ? 'per-source' : 'global';
    const scopeId = subject?.id || null;
    await complianceStore.recordCheckResult({
        organization_id: orgId,
        check_id: check.id,
        regulation: check.regulation,
        article: check.article,
        severity: check.severity,
        status: result.status,
        evidence: result.evidence,
        details: result.details,
        scope_type: scopeType,
        scope_id: scopeId,
        run_type: runType,
    });
    // Immutable audit row — Art. 5(2) accountability.
    const payload = {
        status: result.status,
        evidence: result.evidence,
        details: result.details,
        run_type: runType,
        subject: subject || null,
    };
    await complianceStore.addEvidence({
        organization_id: orgId,
        check_id: check.id,
        subject_type: scopeType,
        subject_id: scopeId,
        hash: _hashPayload(payload),
        payload,
    });
}

async function _runSafe(check, orgId, subject) {
    try {
        const r = await check.evaluate(orgId, subject || null);
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

/**
 * Run every registered check for a given organization. Per-source checks
 * are expanded over their listSubjects() iterable.
 */
async function runAll(orgId, { runType = 'scheduled' } = {}) {
    const checks = registry.getAll();
    const results = [];
    for (const check of checks) {
        if (check.scope === 'per-source' && typeof check.listSubjects === 'function') {
            let subjects = [];
            try {
                subjects = await check.listSubjects(orgId) || [];
            } catch (e) {
                console.warn(`[ComplianceRunner] ${check.id} listSubjects failed:`, e.message);
            }
            if (!subjects.length) {
                const naResult = {
                    status: 'not_applicable',
                    evidence: { subjects: 0 },
                    details: 'No subjects to evaluate.',
                };
                results.push({ check_id: check.id, scope: 'per-source', subject: null, ...naResult });
                await _persistResult(check, orgId, naResult, runType, null);
                continue;
            }
            for (const subj of subjects) {
                const r = await _runSafe(check, orgId, subj);
                results.push({ check_id: check.id, scope: 'per-source', subject: subj, ...r });
                await _persistResult(check, orgId, r, runType, subj);
            }
        } else {
            const r = await _runSafe(check, orgId, null);
            results.push({ check_id: check.id, scope: 'global', subject: null, ...r });
            await _persistResult(check, orgId, r, runType, null);
        }
    }
    return results;
}

/**
 * Run a single check by id. For per-source checks, runs across all subjects
 * unless a `subjectId` is provided to scope down to one.
 */
async function runOne(orgId, checkId, { runType = 'manual', subjectId = null } = {}) {
    const check = registry.get(checkId);
    if (!check) throw new Error(`Unknown check: ${checkId}`);
    if (check.scope === 'per-source' && typeof check.listSubjects === 'function') {
        let subjects = await check.listSubjects(orgId) || [];
        if (subjectId) subjects = subjects.filter(s => String(s.id) === String(subjectId));
        if (!subjects.length) {
            const naResult = {
                status: 'not_applicable',
                evidence: { subjects: 0 },
                details: subjectId ? 'Subject not found.' : 'No subjects to evaluate.',
            };
            await _persistResult(check, orgId, naResult, runType, null);
            return { check_id: check.id, scope: 'per-source', subject: null, ...naResult };
        }
        const out = [];
        for (const subj of subjects) {
            const r = await _runSafe(check, orgId, subj);
            await _persistResult(check, orgId, r, runType, subj);
            out.push({ check_id: check.id, scope: 'per-source', subject: subj, ...r });
        }
        return out.length === 1 ? out[0] : { check_id: check.id, scope: 'per-source', results: out };
    }
    const r = await _runSafe(check, orgId, null);
    await _persistResult(check, orgId, r, runType, null);
    return { check_id: check.id, scope: 'global', subject: null, ...r };
}

/**
 * Invoke a check's autoFix(orgId, opts) handler if defined and persist an
 * evidence row capturing the action for audit. Returns the autofix output.
 */
async function autoFix(orgId, checkId, opts = {}) {
    const check = registry.get(checkId);
    if (!check) throw new Error(`Unknown check: ${checkId}`);
    if (typeof check.autoFix !== 'function') {
        throw new Error(`Check ${checkId} does not support auto-fix`);
    }
    const result = await check.autoFix(orgId, opts);
    const payload = {
        action: 'auto-fix',
        check_id: checkId,
        opts,
        result,
        actor: opts.actorId || null,
        at: new Date().toISOString(),
    };
    await complianceStore.addEvidence({
        organization_id: orgId,
        check_id: checkId,
        subject_type: 'auto-fix',
        subject_id: opts.subjectId || null,
        hash: _hashPayload(payload),
        payload,
    });
    return result;
}

module.exports = { runAll, runOne, autoFix };
