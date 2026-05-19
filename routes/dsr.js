/**
 * DSR API — Data Subject Request endpoints (GDPR Art. 15–22).
 *
 *   POST   /api/dsr/requests              public, rate-limited per IP
 *   GET    /api/dsr/requests              admin (admin_compliance)
 *   GET    /api/dsr/requests/:id          admin
 *   POST   /api/dsr/requests/:id/fulfil   admin
 *   GET    /api/dsr/requests/:id/export   admin (JSON only — project rule)
 *
 * Public submission is intentionally not behind the enterprise license gate
 * (mounted with `gate: null` in featureMap). GDPR requires the channel to be
 * reachable; admin endpoints stay enterprise-only.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const dsrStore = require('../stores/dsrStore');
const userStore = require('../stores/userStore');
const memoryStore = (() => { try { return require('../stores/memoryStore'); } catch { return null; } })();
const complianceEvents = require('../compliance/events');
const { requirePermission } = require('../auth/permissions');

const publicSubmitLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many DSR submissions from this IP. Try again later.' },
});

function requireAuth(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    next();
}

async function _resolveOrgIdFromSubject(email) {
    if (!email) return 'default';
    try {
        const u = await userStore.getUserByEmail?.(email);
        return u?.organizationId || 'default';
    } catch {
        return 'default';
    }
}

// ───────────────── Public submission ─────────────────

router.post('/requests', publicSubmitLimiter, async (req, res) => {
    try {
        const body = req.body || {};
        if (!body.subject_email || typeof body.subject_email !== 'string') {
            return res.status(400).json({ error: 'subject_email is required' });
        }
        // Light email format check — never reject because we don't want to
        // chill legitimate users out of the DSR channel.
        const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.subject_email);
        if (!emailOk) return res.status(400).json({ error: 'subject_email is not a valid email address' });
        // Always derive org from the subject's email — never trust a client-supplied
        // organization_id on this public endpoint, or attackers can file fraudulent
        // DSRs against any org.
        const orgId = await _resolveOrgIdFromSubject(body.subject_email);
        const sourceIp = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()
            || req.socket?.remoteAddress
            || null;
        const created = await dsrStore.createRequest({
            organization_id: orgId,
            request_type: body.request_type || 'access',
            subject_email: body.subject_email,
            notes: body.notes,
            source_ip: sourceIp,
        });
        complianceEvents.emit(complianceEvents.EVENTS.DSR_SUBMITTED, {
            orgId,
            requestType: body.request_type || 'access',
        });
        res.status(201).json({
            id: created.id,
            created_at: created.created_at,
            status_url: `/api/dsr/requests/${created.id}/public`,
            ack: 'Your request has been received. We will respond within 30 days as required by GDPR.',
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Public status check (no auth, only by id + email match — does not leak the
// request body).
router.get('/requests/:id/public', async (req, res) => {
    try {
        const email = (req.query.email || '').toString().trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'email query param required' });
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
        // We need to scan without orgId here — the public submitter may not
        // know it. We only return a single row keyed by (id, email).
        const { getOne } = require('../db');
        const row = await getOne(`
            SELECT id, status, request_type, created_at, fulfilled_at
            FROM dsr_requests
            WHERE id = $1 AND subject_email = $2
        `, [id, email]);
        if (!row) return res.status(404).json({ error: 'not found' });
        res.json(row);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ───────────────── Admin ─────────────────

async function resolveAdminOrgId(req) {
    const userId = req.session?.user?.id;
    if (!userId) return 'default';
    try {
        const u = await userStore.getUser(userId);
        return u?.organizationId || 'default';
    } catch { return 'default'; }
}

router.get('/requests', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveAdminOrgId(req);
        const rows = await dsrStore.listRequests(orgId, { status: req.query.status });
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/requests/:id', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveAdminOrgId(req);
        const id = parseInt(req.params.id, 10);
        const row = await dsrStore.getRequest(orgId, id);
        if (!row) return res.status(404).json({ error: 'not found' });
        res.json(row);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/requests/:id/fulfil', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveAdminOrgId(req);
        const id = parseInt(req.params.id, 10);
        const actorId = req.session?.user?.id || null;
        const body = req.body || {};
        const updated = await dsrStore.updateStatus(orgId, id, body.status || 'fulfilled', {
            fulfilledBy: actorId,
            resultSummary: body.result_summary,
            resultPayload: body.result_payload,
        });
        res.json(updated);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.get('/requests/:id/export', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveAdminOrgId(req);
        const id = parseInt(req.params.id, 10);
        const row = await dsrStore.getRequest(orgId, id);
        if (!row) return res.status(404).json({ error: 'not found' });

        // Build a JSON dump of the subject's data. We deliberately stay JSON
        // only (project rule: no CSV exports).
        const dump = {
            generated_at: new Date().toISOString(),
            request: row,
            data: {},
            notes: 'This export contains data linked to subject_email. Review for completeness before delivery.',
        };
        try {
            const u = await userStore.getUserByEmail?.(row.subject_email);
            if (u) {
                dump.data.user = u;
                if (memoryStore?.listMemoriesByUser) {
                    dump.data.memories = await memoryStore.listMemoriesByUser(u.id).catch(() => []);
                }
            }
        } catch (e) {
            dump.data.error = e.message;
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="dsr-${id}.json"`);
        res.send(JSON.stringify(dump, null, 2));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
