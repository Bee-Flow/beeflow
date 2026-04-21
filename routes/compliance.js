/**
 * Compliance API — AI Act & GDPR monitoring endpoints.
 *
 * All admin routes require the `admin_compliance` permission (org admins have
 * this by default; DPOs can be granted it without full admin rights).
 */

const express = require('express');
const router = express.Router();

const complianceStore = require('../stores/complianceStore');
const runner = require('../compliance/runner');
const registry = require('../compliance/registry');
const { requirePermission } = require('../auth/permissions');
const userStore = require('../stores/userStore');

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

// ───────────────── Overview ─────────────────

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
    // Fire-and-forget — don't block the request
    runner.runAll(orgId, { runType: 'scheduled' }).catch(e =>
        console.warn(`[Compliance] auto-run for org "${orgId}" failed:`, e.message)
    );
}

router.get('/overview', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const settings = await complianceStore.getSettings(orgId);
        let latest = await complianceStore.getLatestPerCheck(orgId);

        // If this org has never been scanned OR the newest result is older than
        // the 6-hour auto-run window, run checks synchronously so the very first
        // visit shows a populated dashboard instead of "never run".
        const newest = latest.length ? latest.reduce((m, r) => (r.run_at > m ? r.run_at : m), latest[0].run_at) : null;
        const staleMs = newest ? (Date.now() - new Date(newest).getTime()) : Infinity;
        if (latest.length === 0) {
            // Never run for this org → block briefly so the UI isn't empty.
            try { await runner.runAll(orgId, { runType: 'scheduled' }); } catch (e) {
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
        // Enrich with definition metadata for i18n/fix-links
        const byId = new Map(latest.map(r => [r.check_id, r]));
        const rows = registry.getAll().map(def => {
            const r = byId.get(def.id);
            return {
                check_id: def.id,
                regulation: def.regulation,
                article: def.article,
                severity: def.severity,
                scope: def.scope,
                titleKey: def.titleKey,
                descriptionKey: def.descriptionKey,
                remediationKey: def.remediationKey,
                remediationLink: def.remediationLink || null,
                status: r?.status || 'pending',
                details: r?.details || null,
                evidence: r?.evidence || null,
                run_at: r?.run_at || null,
            };
        });
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
        // Immediately re-run all checks so the UI reflects onboarded state
        runner.runAll(orgId, { runType: 'manual' }).catch(e =>
            console.warn('[Compliance] post-onboarding run failed:', e.message)
        );
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
    })));
});

module.exports = router;
