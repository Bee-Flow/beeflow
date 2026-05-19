/**
 * Routes for the termination monitor.
 *
 * Mirrors the auth/org-scoping pattern used by routes/usage.js so the same
 * admin/org filtering applies. Returns JSON with metadata only — no message
 * bodies or user content are read or returned.
 */

const express = require('express');
const router = express.Router();
const terminationStore = require('../stores/terminationStore');
const { resolveUserOrgIds, isOrgAdminRole } = require('../auth');
const userStore = require('../stores/userStore');

function getDateFilters(daysParam) {
    if (daysParam === 'all') return {};
    const days = parseInt(daysParam, 10);
    if (!Number.isFinite(days) || days <= 0) return {};
    const now = new Date();
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return { startDate: start.toISOString(), endDate: now.toISOString() };
}

function buildRequestFilters(req) {
    const filters = {};
    if (req.query.startDate) filters.startDate = req.query.startDate;
    if (req.query.endDate) filters.endDate = req.query.endDate;
    if (!filters.startDate && !filters.endDate) {
        Object.assign(filters, getDateFilters(req.query.days || '30'));
    }
    if (req.query.agent) filters.agentId = req.query.agent;
    if (req.query.user) filters.userId = req.query.user;
    if (req.query.type) filters.type = req.query.type;
    return filters;
}

async function attachOrgFilter(req, res, next) {
    if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
    const orgIds = await resolveUserOrgIds(req);
    req.termFilters = buildRequestFilters(req);
    if (orgIds === null) {
        // null = unrestricted (super admin) → no org filter
    } else if (orgIds.size === 0) {
        req.termFilters.organizationId = '__none__';
    } else {
        req.termFilters.organizationId = Array.from(orgIds)[0];
    }
    next();
}

// ── Org-scoped routes (org admin only) ─────────────────────────────────────
// Mounted before the generic attachOrgFilter so /org/* is gated explicitly to
// the caller's own organisation and to org_admin role. Super admin also passes.
async function requireOwnOrgAdminScope(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';

    const orgIds = await resolveUserOrgIds(req);
    const orgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
    if (!orgId) return res.status(403).json({ error: 'No organisation context' });

    if (!isSuperAdmin) {
        const user = await userStore.getUser(req.session.user.id);
        if (!user || !isOrgAdminRole(user.orgRole)) {
            return res.status(403).json({ error: 'Organization admin access required' });
        }
    }
    req.termFilters = buildRequestFilters(req);
    req.termFilters.organizationId = orgId;
    next();
}

router.get('/org', requireOwnOrgAdminScope, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
        const rows = await terminationStore.getList(req.termFilters, limit);
        res.json({ rows });
    } catch (e) {
        console.error('[Terminations] org list error:', e.message);
        res.status(500).json({ error: 'Failed to load terminations' });
    }
});

router.get('/org/summary', requireOwnOrgAdminScope, async (req, res) => {
    try {
        const summary = await terminationStore.getSummary(req.termFilters);
        res.json(summary);
    } catch (e) {
        console.error('[Terminations] org summary error:', e.message);
        res.status(500).json({ error: 'Failed to load summary' });
    }
});

router.get('/org/timeline', requireOwnOrgAdminScope, async (req, res) => {
    try {
        const interval = req.query.interval === 'hour' ? 'hour' : 'day';
        const rows = await terminationStore.getTimeline(req.termFilters, interval);
        res.json({ rows, interval });
    } catch (e) {
        console.error('[Terminations] org timeline error:', e.message);
        res.status(500).json({ error: 'Failed to load timeline' });
    }
});

router.get('/org/by-agent', requireOwnOrgAdminScope, async (req, res) => {
    try {
        const rows = await terminationStore.getByAgent(req.termFilters);
        res.json({ rows });
    } catch (e) {
        console.error('[Terminations] org by-agent error:', e.message);
        res.status(500).json({ error: 'Failed to load by-agent' });
    }
});

// ── Default routes (admin / generic org-scoped) ────────────────────────────
router.use(attachOrgFilter);

router.get('/', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
        const rows = await terminationStore.getList(req.termFilters, limit);
        res.json({ rows });
    } catch (e) {
        console.error('[Terminations] list error:', e.message);
        res.status(500).json({ error: 'Failed to load terminations' });
    }
});

router.get('/summary', async (req, res) => {
    try {
        const summary = await terminationStore.getSummary(req.termFilters);
        res.json(summary);
    } catch (e) {
        console.error('[Terminations] summary error:', e.message);
        res.status(500).json({ error: 'Failed to load summary' });
    }
});

router.get('/timeline', async (req, res) => {
    try {
        const interval = req.query.interval === 'hour' ? 'hour' : 'day';
        const rows = await terminationStore.getTimeline(req.termFilters, interval);
        res.json({ rows, interval });
    } catch (e) {
        console.error('[Terminations] timeline error:', e.message);
        res.status(500).json({ error: 'Failed to load timeline' });
    }
});

router.get('/by-agent', async (req, res) => {
    try {
        const rows = await terminationStore.getByAgent(req.termFilters);
        res.json({ rows });
    } catch (e) {
        console.error('[Terminations] by-agent error:', e.message);
        res.status(500).json({ error: 'Failed to load by-agent' });
    }
});

module.exports = router;
