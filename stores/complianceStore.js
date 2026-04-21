/**
 * Compliance Store — AI Act & GDPR monitoring persistence.
 *
 * Tables (Phase 1 MVP):
 *   compliance_settings    org-wide onboarding answers (DPO, legal bases, residency, retention)
 *   compliance_checks      time-series check results (one row per check run)
 *   compliance_evidence    append-only audit trail (hash + payload)
 *
 * Phase 2 adds processing_activities, ai_risk_assessments;
 * Phase 3 adds data_subject_requests.
 */

const { run, getOne, getAll, exec } = require('../db');

let _initPromise = null;
async function initDB() {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
        await exec(`
            CREATE TABLE IF NOT EXISTS compliance_settings (
                organization_id TEXT PRIMARY KEY,
                dpo_name TEXT,
                dpo_email TEXT,
                dpo_phone TEXT,
                legal_bases JSONB DEFAULT '[]'::jsonb,
                data_residency TEXT DEFAULT 'eu',
                breach_recipients JSONB DEFAULT '[]'::jsonb,
                default_retention_days INTEGER,
                privacy_notice_url TEXT,
                onboarded_at TIMESTAMPTZ,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await exec(`
            CREATE TABLE IF NOT EXISTS compliance_checks (
                id SERIAL PRIMARY KEY,
                organization_id TEXT,
                check_id TEXT NOT NULL,
                regulation TEXT NOT NULL,
                article TEXT,
                severity TEXT NOT NULL DEFAULT 'medium',
                status TEXT NOT NULL,
                evidence JSONB DEFAULT '{}'::jsonb,
                details TEXT,
                scope_type TEXT DEFAULT 'global',
                scope_id TEXT,
                run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                run_type TEXT DEFAULT 'scheduled'
            )
        `);
        await exec(`CREATE INDEX IF NOT EXISTS idx_compliance_checks_org_run ON compliance_checks(organization_id, run_at DESC)`);
        await exec(`CREATE INDEX IF NOT EXISTS idx_compliance_checks_check_id ON compliance_checks(organization_id, check_id, run_at DESC)`);
        await exec(`CREATE INDEX IF NOT EXISTS idx_compliance_checks_scope ON compliance_checks(scope_type, scope_id)`);

        await exec(`
            CREATE TABLE IF NOT EXISTS compliance_evidence (
                id SERIAL PRIMARY KEY,
                organization_id TEXT,
                check_id TEXT,
                subject_type TEXT,
                subject_id TEXT,
                captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                hash TEXT,
                payload JSONB DEFAULT '{}'::jsonb
            )
        `);
        await exec(`CREATE INDEX IF NOT EXISTS idx_compliance_evidence_org ON compliance_evidence(organization_id, captured_at DESC)`);
    })();
    return _initPromise;
}

initDB().catch(err => console.error('[ComplianceStore] Init error:', err.message));
console.log('[ComplianceStore] Initialized (PostgreSQL)');

// ───────────────────────── Settings ─────────────────────────

async function getSettings(orgId) {
    await initDB();
    const row = await getOne(`SELECT * FROM compliance_settings WHERE organization_id = $1`, [orgId || 'default']);
    if (!row) {
        return {
            organization_id: orgId || 'default',
            dpo_name: null, dpo_email: null, dpo_phone: null,
            legal_bases: [], data_residency: 'eu',
            breach_recipients: [], default_retention_days: null,
            privacy_notice_url: null, onboarded_at: null,
        };
    }
    return row;
}

async function saveSettings(orgId, patch) {
    await initDB();
    const existing = await getOne(`SELECT organization_id FROM compliance_settings WHERE organization_id = $1`, [orgId]);
    const safe = {
        dpo_name: patch.dpo_name ?? null,
        dpo_email: patch.dpo_email ?? null,
        dpo_phone: patch.dpo_phone ?? null,
        legal_bases: JSON.stringify(patch.legal_bases ?? []),
        data_residency: patch.data_residency ?? 'eu',
        breach_recipients: JSON.stringify(patch.breach_recipients ?? []),
        default_retention_days: patch.default_retention_days ?? null,
        privacy_notice_url: patch.privacy_notice_url ?? null,
        onboarded_at: patch.onboarded_at ?? null,
    };
    if (existing) {
        await run(`
            UPDATE compliance_settings SET
                dpo_name = $2, dpo_email = $3, dpo_phone = $4,
                legal_bases = $5::jsonb, data_residency = $6,
                breach_recipients = $7::jsonb, default_retention_days = $8,
                privacy_notice_url = $9,
                onboarded_at = COALESCE($10, onboarded_at),
                updated_at = NOW()
            WHERE organization_id = $1
        `, [orgId, safe.dpo_name, safe.dpo_email, safe.dpo_phone,
            safe.legal_bases, safe.data_residency, safe.breach_recipients,
            safe.default_retention_days, safe.privacy_notice_url, safe.onboarded_at]);
    } else {
        await run(`
            INSERT INTO compliance_settings
                (organization_id, dpo_name, dpo_email, dpo_phone, legal_bases, data_residency,
                 breach_recipients, default_retention_days, privacy_notice_url, onboarded_at)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10)
        `, [orgId, safe.dpo_name, safe.dpo_email, safe.dpo_phone,
            safe.legal_bases, safe.data_residency, safe.breach_recipients,
            safe.default_retention_days, safe.privacy_notice_url, safe.onboarded_at]);
    }
    return getSettings(orgId);
}

async function markOnboarded(orgId) {
    await initDB();
    await run(`
        UPDATE compliance_settings SET onboarded_at = NOW(), updated_at = NOW()
        WHERE organization_id = $1 AND onboarded_at IS NULL
    `, [orgId]);
}

// ───────────────────────── Check results ─────────────────────────

async function recordCheckResult(row) {
    await initDB();
    await run(`
        INSERT INTO compliance_checks
            (organization_id, check_id, regulation, article, severity, status,
             evidence, details, scope_type, scope_id, run_type)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
    `, [
        row.organization_id || null,
        row.check_id,
        row.regulation,
        row.article || null,
        row.severity || 'medium',
        row.status,
        JSON.stringify(row.evidence || {}),
        row.details || null,
        row.scope_type || 'global',
        row.scope_id || null,
        row.run_type || 'scheduled',
    ]);
}

async function getLatestPerCheck(orgId) {
    await initDB();
    return getAll(`
        SELECT DISTINCT ON (check_id, scope_type, scope_id)
            check_id, regulation, article, severity, status, evidence, details,
            scope_type, scope_id, run_at, run_type
        FROM compliance_checks
        WHERE organization_id = $1
        ORDER BY check_id, scope_type, scope_id, run_at DESC
    `, [orgId]);
}

async function getCheckHistory(orgId, checkId, limit = 100) {
    await initDB();
    return getAll(`
        SELECT status, details, run_at, run_type, evidence, scope_type, scope_id
        FROM compliance_checks
        WHERE organization_id = $1 AND check_id = $2
        ORDER BY run_at DESC
        LIMIT $3
    `, [orgId, checkId, limit]);
}

// ───────────────────────── Evidence ─────────────────────────

async function addEvidence(row) {
    await initDB();
    await run(`
        INSERT INTO compliance_evidence
            (organization_id, check_id, subject_type, subject_id, hash, payload)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `, [
        row.organization_id || null,
        row.check_id || null,
        row.subject_type || null,
        row.subject_id || null,
        row.hash || null,
        JSON.stringify(row.payload || {}),
    ]);
}

module.exports = {
    initDB,
    getSettings,
    saveSettings,
    markOnboarded,
    recordCheckResult,
    getLatestPerCheck,
    getCheckHistory,
    addEvidence,
};
