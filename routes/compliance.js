/**
 * Compliance API — AI Act & GDPR monitoring endpoints.
 *
 * All admin routes require the `admin_compliance` permission (org admins have
 * this by default; DPOs can be granted it without full admin rights).
 */

const express = require('express');
const router = express.Router();

const complianceStore = require('../stores/complianceStore');
const dpiaStore = require('../stores/dpiaStore');
const runner = require('../compliance/runner');
const registry = require('../compliance/registry');
const { requirePermission } = require('../auth/permissions');
const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');
const { getAll } = require('../db');

// Ensure checks are loaded (auto-register on require)
require('../compliance/checks');

async function resolveOrgId(req) {
    const userId = req.session?.user?.id;
    if (!userId) return 'default';
    try {
        const u = await userStore.getUser(userId);
        return u?.organizationId || 'default';
    } catch {
        return 'default';
    }
}

function requireAuth(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    next();
}

// ───────────────── Score model ─────────────────

const SEVERITY_WEIGHT = { critical: 3, high: 2, medium: 1, low: 0.5 };

function computeScore(results) {
    if (!results.length) return { score: 0, total: 0, pass: 0, warn: 0, fail: 0 };
    let earned = 0, max = 0;
    let pass = 0, warn = 0, fail = 0, na = 0;
    for (const r of results) {
        const check = registry.get(r.check_id);
        const w = SEVERITY_WEIGHT[check?.severity || r.severity] || 1;
        if (r.status === 'not_applicable') { na++; continue; }
        max += w;
        if (r.status === 'pass') { earned += w; pass++; }
        else if (r.status === 'warn') { earned += w * 0.5; warn++; }
        else fail++;
    }
    const score = max > 0 ? Math.round((earned / max) * 100) : 100;
    return { score, total: results.length, pass, warn, fail, na };
}

// Track which orgs have had an auto-run kicked off so we don't re-trigger on
// every overview call. Keyed by orgId, value = timestamp of last auto-run.
const _autoRunCache = new Map();
const AUTO_RUN_STALE_MS = 6 * 60 * 60 * 1000; // 6 hours

async function ensureFreshResults(orgId) {
    const last = _autoRunCache.get(orgId) || 0;
    if (Date.now() - last < AUTO_RUN_STALE_MS) return;
    _autoRunCache.set(orgId, Date.now());
    runner.runAll(orgId, { runType: 'scheduled' }).catch(e =>
        console.warn(`[Compliance] auto-run for org "${orgId}" failed:`, e.message)
    );
}

// ───────────────── Overview ─────────────────

router.get('/overview', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const settings = await complianceStore.getSettings(orgId);
        let latest = await complianceStore.getLatestPerCheck(orgId);

        const newest = latest.length ? latest.reduce((m, r) => (r.run_at > m ? r.run_at : m), latest[0].run_at) : null;
        const staleMs = newest ? (Date.now() - new Date(newest).getTime()) : Infinity;
        let firstScanRan = false;
        if (latest.length === 0) {
            try {
                await runner.runAll(orgId, { runType: 'scheduled' });
                firstScanRan = true;
            } catch (e) {
                console.warn('[Compliance] initial run failed:', e.message);
            }
            latest = await complianceStore.getLatestPerCheck(orgId);
            _autoRunCache.set(orgId, Date.now());
        } else if (staleMs > AUTO_RUN_STALE_MS) {
            ensureFreshResults(orgId);
        }

        const gdpr = latest.filter(r => r.regulation === 'GDPR');
        const aia = latest.filter(r => r.regulation === 'AIA');
        const lastRunAt = latest.length ? latest.reduce((m, r) => (r.run_at > m ? r.run_at : m), latest[0].run_at) : null;
        res.json({
            organization_id: orgId,
            onboarded: !!settings.onboarded_at,
            settings,
            overall: computeScore(latest),
            gdpr: computeScore(gdpr),
            aia: computeScore(aia),
            last_run_at: lastRunAt,
            total_checks: registry.getAll().length,
            first_scan_ran: firstScanRan,
            score_formula: {
                weights: SEVERITY_WEIGHT,
                rule: 'score = round(sum(weight × statusFactor) / sum(weight) × 100), where statusFactor is 1.0 (pass), 0.5 (warn), 0 (fail). "not_applicable" rows are excluded from the denominator.',
            },
        });
    } catch (e) {
        console.error('[Compliance] overview error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ───────────────── Checks ─────────────────

router.get('/checks', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const latest = await complianceStore.getLatestPerCheck(orgId);
        const definitions = registry.getAll();
        const rows = [];

        // For global checks: one row per check def.
        // For per-source checks: one row per latest result so the UI can show each subject.
        for (const def of definitions) {
            const matches = latest.filter(r => r.check_id === def.id);
            if (def.scope === 'per-source' && matches.length > 0) {
                for (const r of matches) {
                    rows.push({
                        check_id: def.id,
                        regulation: def.regulation,
                        article: def.article,
                        severity: def.severity,
                        scope: def.scope,
                        scope_id: r.scope_id,
                        titleKey: def.titleKey,
                        descriptionKey: def.descriptionKey,
                        remediationKey: def.remediationKey,
                        remediationLink: def.remediationLink || null,
                        autoFixId: def.autoFixId || null,
                        status: r.status,
                        details: r.details,
                        evidence: r.evidence,
                        run_at: r.run_at,
                    });
                }
            } else {
                const r = matches[0];
                rows.push({
                    check_id: def.id,
                    regulation: def.regulation,
                    article: def.article,
                    severity: def.severity,
                    scope: def.scope,
                    scope_id: r?.scope_id || null,
                    titleKey: def.titleKey,
                    descriptionKey: def.descriptionKey,
                    remediationKey: def.remediationKey,
                    remediationLink: def.remediationLink || null,
                    autoFixId: def.autoFixId || null,
                    status: r?.status || 'pending',
                    details: r?.details || null,
                    evidence: r?.evidence || null,
                    run_at: r?.run_at || null,
                });
            }
        }
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/checks/:id/history', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const rows = await complianceStore.getCheckHistory(orgId, req.params.id, 100);
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/checks/run', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const results = await runner.runAll(orgId, { runType: 'manual' });
        res.json({ ran: results.length, score: computeScore(results) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/checks/:id/run', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const result = await runner.runOne(orgId, req.params.id);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/checks/:id/auto-fix', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const actorId = req.session?.user?.id || null;
        const result = await runner.autoFix(orgId, req.params.id, {
            ...(req.body || {}),
            actorId,
        });
        // Re-run the check so the UI shows the fresh result.
        await runner.runOne(orgId, req.params.id).catch(() => {});
        res.json({ ok: true, result });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ───────────────── Settings / onboarding ─────────────────

router.get('/settings', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const s = await complianceStore.getSettings(orgId);
        res.json(s);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.put('/settings', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const body = req.body || {};
        const saved = await complianceStore.saveSettings(orgId, body);
        res.json(saved);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/settings/onboarded', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const patch = { ...(req.body || {}), onboarded_at: new Date().toISOString() };
        const saved = await complianceStore.saveSettings(orgId, patch);
        runner.runAll(orgId, { runType: 'manual' }).catch(e =>
            console.warn('[Compliance] post-onboarding run failed:', e.message)
        );
        res.json(saved);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/settings/scc', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const { operator, confirmed } = req.body || {};
        if (!operator) return res.status(400).json({ error: 'operator is required' });
        const actorId = req.session?.user?.id || null;
        const next = await complianceStore.setSccConfirmed(orgId, operator, !!confirmed, actorId);
        runner.runOne(orgId, 'GDPR-Art44-external-transfers').catch(() => {});
        res.json({ scc_confirmed_operators: next });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ───────────────── Auto-detect settings ─────────────────
//
// Reads existing org config to pre-fill the onboarding wizard. No persistence
// happens here — the wizard PUTs the result back to /settings after the user
// confirms.

router.post('/auto-detect-settings', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const ai = (await configStore.getConfig('ai')) || {};
        const hasProviders = Array.isArray(ai.providers) && ai.providers.length > 0;
        const shield = (await configStore.getConfig(`org_privacy_shield_${orgId}`)) || {};

        // Legal bases — start with contract + legitimate interests if any agent
        // is published; add consent if Privacy Shield requires user opt-in.
        const legalBases = ['contract', 'legitimate_interests'];
        if (shield.requireConsent) legalBases.push('consent');

        // Residency: 'internal' if no external providers, 'hybrid' otherwise.
        const dataResidency = hasProviders ? 'hybrid' : 'internal';

        // Retention: 365 days default unless the org already set one.
        const existing = await complianceStore.getSettings(orgId);
        const defaultRetentionDays = existing.default_retention_days || 365;

        // Breach recipients: requester email + org admins.
        const requesterEmail = req.session?.user?.email || null;
        let admins = [];
        try {
            admins = await getAll(
                // 'org_admin' is the canonical orgRole. The legacy 'admin'
                // value is kept in the IN-list to cover historical rows
                // that pre-date the rename (matches the normalisation in
                // server/auth/permissions.js).
                `SELECT email FROM users WHERE "organizationId" = $1 AND (role = 'admin' OR "orgRole" IN ('org_admin', 'admin'))`,
                [orgId],
            );
        } catch { admins = []; }
        const breachRecipients = Array.from(new Set(
            [requesterEmail, ...(admins || []).map(a => a.email)].filter(Boolean)
        ));

        // Privacy URL: pass-through if already set.
        const privacyNoticeUrl = existing.privacy_notice_url || null;

        res.json({
            legal_bases: legalBases,
            data_residency: dataResidency,
            default_retention_days: defaultRetentionDays,
            privacy_notice_url: privacyNoticeUrl,
            breach_recipients: breachRecipients,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ───────────────── Evidence ─────────────────

router.get('/evidence/:checkId', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const rows = await complianceStore.getEvidenceHistory(orgId, req.params.checkId, 100);
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ───────────────── RoPA ─────────────────
//
// Auto-generated Records of Processing Activities. We synthesise the document
// from the system's existing knowledge (agents = purposes; integrations =
// processors; settings = controller + retention) so the admin only has to
// review and mark-as-reviewed rather than type it from scratch.

router.get('/ropa', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const settings = await complianceStore.getSettings(orgId);
        const org = await userStore.getOrganization(orgId).catch(() => null);

        let agents = [];
        try {
            agents = await getAll(`
                SELECT id, name, description, model, system_prompt, organization_id, config, is_published
                FROM agents WHERE is_published = TRUE
            `);
        } catch { /* fresh */ }
        agents = agents.filter(a => !a.organization_id || a.organization_id === orgId);

        let processors = [];
        try {
            processors = await getAll(`
                SELECT operator,
                       MAX(country_code) AS country_code,
                       MAX(country_name) AS country_name,
                       BOOL_OR(is_eu) AS is_eu,
                       COUNT(*)::int AS calls,
                       MIN(timestamp) AS first_seen,
                       MAX(timestamp) AS last_seen
                FROM integration_activity_log
                WHERE organization_id = $1
                  AND timestamp >= NOW() - INTERVAL '180 days'
                GROUP BY operator
                ORDER BY calls DESC
            `, [orgId]);
        } catch { /* fresh */ }

        const activities = agents.map(a => ({
            activity_id: a.id,
            name: a.name,
            purpose: a.description || 'AI-assisted user interaction',
            data_categories: ['Conversation content', 'User profile (when supplied)'],
            data_subjects: ['Authenticated users', 'External data subjects whose data is entered into conversations'],
            recipients: 'Processors listed below',
            transfers: processors.filter(p => !p.is_eu).map(p => p.operator),
            retention: settings.default_retention_days
                ? `${settings.default_retention_days} days from last interaction`
                : 'Org default not set',
            security_measures: [
                'Encryption at rest (envelope AES-256-GCM)',
                'Encryption in transit (TLS)',
                'Access logging via guardrail_events',
                'DLP / PII redaction (where enabled)',
            ],
        }));

        res.json({
            organization_id: orgId,
            controller: {
                name: org?.name || orgId,
                dpo_name: settings.dpo_name,
                dpo_email: settings.dpo_email,
                dpo_phone: settings.dpo_phone,
            },
            legal_bases: settings.legal_bases || [],
            data_residency: settings.data_residency || 'eu',
            generated_at: new Date().toISOString(),
            last_reviewed_at: settings.ropa_reviewed_at,
            last_reviewed_by: settings.ropa_reviewed_by,
            activities,
            processors,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/ropa/review', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const actorId = req.session?.user?.id || null;
        await complianceStore.markRopaReviewed(orgId, actorId);
        runner.runOne(orgId, 'GDPR-Art30-ropa-reviewed').catch(() => {});
        res.json({ ok: true, reviewed_at: new Date().toISOString(), reviewer: actorId });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ───────────────── DPIA ─────────────────

router.get('/dpia', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const rows = await dpiaStore.listForOrg(orgId);
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/dpia/:agentId', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const row = await dpiaStore.getLatestForAgent(orgId, req.params.agentId);
        res.json(row || null);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/dpia/:agentId', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const actorId = req.session?.user?.id || null;
        const body = req.body || {};
        const saved = await dpiaStore.upsertAssessment(orgId, req.params.agentId, {
            ...body,
            approved_by: actorId,
        });
        runner.runOne(orgId, 'GDPR-Art35-dpia-high-risk', { subjectId: req.params.agentId }).catch(() => {});
        res.json(saved);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ───────────────── Meta ─────────────────

router.get('/registry', requireAuth, requirePermission('admin_compliance'), async (_req, res) => {
    res.json(registry.getAll().map(c => ({
        id: c.id, regulation: c.regulation, article: c.article,
        severity: c.severity, scope: c.scope,
        titleKey: c.titleKey, descriptionKey: c.descriptionKey,
        remediationKey: c.remediationKey, remediationLink: c.remediationLink || null,
        autoFixId: c.autoFixId || null,
    })));
});

module.exports = router;
