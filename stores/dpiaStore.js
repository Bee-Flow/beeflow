/**
 * DPIA Store — Data Protection Impact Assessment per agent (GDPR Art. 35).
 *
 * Two modes per agent (user choice):
 *   - 'attestation'   admin checks a box, captures who/when/expires_at.
 *   - 'questionnaire' structured answers JSON (data categories, automated
 *                     decision-making, mitigations).
 *
 * Art-35 compliance check is `per-source` scope: subjects = published agents
 * flagged high-risk; pass iff an unexpired DPIA row exists.
 */

const { run, getOne, getAll, exec } = require('../db');

let _initPromise = null;
async function initDB() {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
        await exec(`
            CREATE TABLE IF NOT EXISTS dpia_assessments (
                id SERIAL PRIMARY KEY,
                organization_id TEXT,
                agent_id TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'attestation',
                risk_level TEXT,
                answers JSONB DEFAULT '{}'::jsonb,
                mitigations JSONB DEFAULT '[]'::jsonb,
                approved_by TEXT,
                approved_at TIMESTAMPTZ,
                expires_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await exec(`CREATE INDEX IF NOT EXISTS idx_dpia_org_agent ON dpia_assessments(organization_id, agent_id, created_at DESC)`);
    })();
    return _initPromise;
}

initDB().catch(err => console.error('[DpiaStore] Init error:', err.message));

const VALID_MODES = new Set(['attestation', 'questionnaire']);

async function upsertAssessment(orgId, agentId, input) {
    await initDB();
    const mode = VALID_MODES.has(input?.mode) ? input.mode : 'attestation';
    const riskLevel = input?.risk_level || 'medium';
    const expiresAt = input?.expires_at || null;
    const answersJson = JSON.stringify(input?.answers || {});
    const mitigationsJson = JSON.stringify(input?.mitigations || []);
    await run(`
        INSERT INTO dpia_assessments
            (organization_id, agent_id, mode, risk_level, answers, mitigations,
             approved_by, approved_at, expires_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, NOW(), $8)
    `, [
        orgId || null,
        String(agentId),
        mode,
        riskLevel,
        answersJson,
        mitigationsJson,
        input?.approved_by || null,
        expiresAt,
    ]);
    return getLatestForAgent(orgId, agentId);
}

async function getLatestForAgent(orgId, agentId) {
    await initDB();
    return getOne(`
        SELECT * FROM dpia_assessments
        WHERE organization_id = $1 AND agent_id = $2
        ORDER BY created_at DESC
        LIMIT 1
    `, [orgId, agentId]);
}

async function listForOrg(orgId) {
    await initDB();
    return getAll(`
        SELECT DISTINCT ON (agent_id)
            id, agent_id, mode, risk_level, approved_by, approved_at, expires_at, created_at
        FROM dpia_assessments
        WHERE organization_id = $1
        ORDER BY agent_id, created_at DESC
    `, [orgId]);
}

function isCurrent(row) {
    if (!row || !row.approved_at) return false;
    if (!row.expires_at) return true;
    return new Date(row.expires_at).getTime() > Date.now();
}

module.exports = {
    initDB,
    upsertAssessment,
    getLatestForAgent,
    listForOrg,
    isCurrent,
};
