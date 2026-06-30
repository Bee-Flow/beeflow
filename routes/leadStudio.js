/**
 * Lead Studio API (Studio → Lead Studio).
 *
 * AI lead generation + enrichment with a collaborative, checkable lead list. A
 * user creates a campaign (criteria + model tier), runs it (async worker), and
 * the team collaborates on the resulting leads in real time (assign / status /
 * notes / verify-afvinken) over an org-scoped SSE stream.
 *
 * Mounted (server/index.js) behind requireCapability('lead_studio') — that folds
 * Enterprise tier + beta opt-in into one gate. The org-level 'lead_studio'
 * permission is enforced per-route below (mirrors supportInbox.js).
 *
 * Hard tenancy boundary: every route resolves the caller's org(s) and only ever
 * touches campaigns/leads belonging to those orgs.
 */

const express = require('express');
const router = express.Router();

const leadStudioStore = require('../stores/leadStudioStore');
const leadEnrichment = require('../integrations/leadEnrichment');
const { setupSSE } = require('../core/sseHelpers');
const { resolveUserOrgIds } = require('../auth/permissions');
const { checkSubscriptionLimits } = require('../core/limits');

const MODEL_TIER_RE = /^[a-zA-Z0-9_:-]{1,64}$/;

const CAPS = {
    perUser: Math.max(1, parseInt(process.env.LEAD_STUDIO_MAX_CONCURRENT_PER_USER || '1', 10)),
    org: Math.max(1, parseInt(process.env.LEAD_STUDIO_MAX_CONCURRENT_PER_ORG || '2', 10)),
    global: Math.max(1, parseInt(process.env.LEAD_STUDIO_MAX_CONCURRENT_GLOBAL || '3', 10)),
};

function getUserId(req) { return req.session?.user?.id || null; }

/**
 * Org ids the caller may act within. Org members → their org(s). Super-admins
 * (resolveUserOrgIds === null) → their session org if set, otherwise every org
 * (full access, so a no-org super-admin can still use + oversee Lead Studio).
 */
async function resolveOrgScope(req) {
    const ids = await resolveUserOrgIds(req);
    if (ids === null) {
        const oid = req.session?.user?.organizationId;
        if (oid) return [oid];
        try {
            const userStore = require('../stores/userStore');
            const orgs = await userStore.getAllOrganizations();
            return (orgs || []).map(o => o.id).filter(Boolean);
        } catch (_) { return []; }
    }
    return Array.from(ids);
}

/** Org a new campaign is created under: the session org if in scope, else first scope org. */
function resolveCreateOrg(req, scope) {
    const sessionOrg = req.session?.user?.organizationId || null;
    if (sessionOrg && scope.includes(sessionOrg)) return sessionOrg;
    return scope[0] || null;
}

// ── Auth gate (all routes) ────────────────────────────────────────────────────
// License × beta is enforced at mount via requireCapability('lead_studio'); here
// we only require an authenticated user. Tenancy is enforced per-route by
// resolveOrgScope + the loadInScope helpers. (No separate per-member permission
// — enabling the beta for the org is enough, matching Security/Tests/Webpages.)
router.use((req, res, next) => {
    if (!getUserId(req)) return res.status(401).json({ error: 'Not authenticated' });
    next();
});

async function loadCampaignInScope(req, res, id) {
    const scope = await resolveOrgScope(req);
    const campaign = await leadStudioStore.getCampaign(id);
    if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return null; }
    if (!scope.includes(campaign.organizationId)) { res.status(403).json({ error: 'Forbidden' }); return null; }
    return campaign;
}

async function loadLeadInScope(req, res, id) {
    const scope = await resolveOrgScope(req);
    const lead = await leadStudioStore.getLead(id);
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return null; }
    if (!scope.includes(lead.organizationId)) { res.status(403).json({ error: 'Forbidden' }); return null; }
    return lead;
}

// ── Providers (which enrichment sources are configured for this org) ──────────
router.get('/providers', async (req, res) => {
    try {
        const scope = await resolveOrgScope(req);
        const orgId = resolveCreateOrg(req, scope);
        const providers = await leadEnrichment.getProviderStatus({ orgId });
        res.json({ providers });
    } catch (err) {
        console.error('[LeadStudio] GET /providers error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ── Campaign CRUD ─────────────────────────────────────────────────────────────
router.get('/campaigns', async (req, res) => {
    try {
        const scope = await resolveOrgScope(req);
        const campaigns = await leadStudioStore.listCampaigns(scope, {
            limit: parseInt(req.query.limit, 10) || 100,
            offset: parseInt(req.query.offset, 10) || 0,
        });
        res.json({ campaigns });
    } catch (err) {
        console.error('[LeadStudio] GET /campaigns error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

router.post('/campaigns', async (req, res) => {
    try {
        const scope = await resolveOrgScope(req);
        const orgId = resolveCreateOrg(req, scope);
        if (!orgId) return res.status(403).json({ error: 'No organization in scope' });
        const body = req.body || {};
        if (body.modelTier && !MODEL_TIER_RE.test(String(body.modelTier))) {
            return res.status(400).json({ error: 'invalid_model_tier' });
        }
        if (body.criteria != null && (typeof body.criteria !== 'object' || Array.isArray(body.criteria))) {
            return res.status(400).json({ error: 'criteria must be an object' });
        }
        const campaign = await leadStudioStore.createCampaign({
            organizationId: orgId,
            createdBy: getUserId(req),
            title: body.title,
            criteria: body.criteria || {},
            outreachPitch: body.outreachPitch || null,
            modelTier: body.modelTier || null,
            targetCount: body.targetCount,
            enrichmentProviders: body.enrichmentProviders,
            retentionDays: body.retentionDays,
        });
        res.json({ campaign });
    } catch (err) {
        console.error('[LeadStudio] POST /campaigns error:', err.message);
        res.status(500).json({ error: 'Failed to create campaign' });
    }
});

router.get('/campaigns/:id', async (req, res) => {
    const campaign = await loadCampaignInScope(req, res, req.params.id);
    if (!campaign) return;
    try {
        const counts = await leadStudioStore.countLeadsByStatus(campaign.id);
        res.json({ campaign, counts });
    } catch (err) {
        console.error('[LeadStudio] GET /campaigns/:id error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

router.patch('/campaigns/:id', async (req, res) => {
    const campaign = await loadCampaignInScope(req, res, req.params.id);
    if (!campaign) return;
    if (campaign.status === 'queued' || campaign.status === 'running') {
        return res.status(409).json({ error: 'campaign_not_editable', message: 'Cannot edit a campaign while it is running.' });
    }
    if (req.body?.modelTier && !MODEL_TIER_RE.test(String(req.body.modelTier))) {
        return res.status(400).json({ error: 'invalid_model_tier' });
    }
    try {
        const updated = await leadStudioStore.updateCampaign(campaign.id, req.body || {});
        res.json({ campaign: updated });
    } catch (err) {
        console.error('[LeadStudio] PATCH /campaigns/:id error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

router.delete('/campaigns/:id', async (req, res) => {
    const campaign = await loadCampaignInScope(req, res, req.params.id);
    if (!campaign) return;
    try {
        await leadStudioStore.deleteCampaign(campaign.id);
        res.json({ ok: true });
    } catch (err) {
        console.error('[LeadStudio] DELETE /campaigns/:id error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ── Run / cancel ───────────────────────────────────────────────────────────────
router.post('/campaigns/:id/run', async (req, res) => {
    const campaign = await loadCampaignInScope(req, res, req.params.id);
    if (!campaign) return;
    if (campaign.status === 'queued' || campaign.status === 'running') {
        return res.status(409).json({ error: 'already_running' });
    }
    try {
        const limitError = await checkSubscriptionLimits(campaign.organizationId, 'lead_studio', getUserId(req));
        if (limitError) return res.status(403).json({ error: 'limit_reached', message: limitError });

        const started = await leadStudioStore.startCampaignRun(campaign.id);
        if (!started) return res.status(409).json({ error: 'could_not_start' });

        // Fast-path kick so the user doesn't wait for the periodic tick.
        if (process.env.LEAD_STUDIO_DRAIN_IN_API !== 'false') {
            require('../workers/leadGenerationWorker').drainOne(campaign.id)
                .catch(err => console.warn('[LeadStudio] drainOne failed:', err.message));
        }

        let queued = false;
        try {
            const active = await leadStudioStore.countActiveByScope({ createdBy: getUserId(req), organizationId: campaign.organizationId });
            queued = active.user >= CAPS.perUser || active.org >= CAPS.org || active.global >= CAPS.global;
        } catch (_) { /* best-effort hint */ }

        res.json({ campaignId: campaign.id, queued });
    } catch (err) {
        console.error('[LeadStudio] POST /campaigns/:id/run error:', err.message);
        res.status(500).json({ error: 'Failed to start campaign' });
    }
});

router.post('/campaigns/:id/cancel', async (req, res) => {
    const campaign = await loadCampaignInScope(req, res, req.params.id);
    if (!campaign) return;
    try {
        const result = await leadStudioStore.markCancelled(campaign.id, getUserId(req));
        if (!result.ok) {
            const code = result.error === 'not_found' ? 404 : result.error === 'forbidden' ? 403 : 409;
            return res.status(code).json({ error: result.error, status: result.status });
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('[LeadStudio] POST /campaigns/:id/cancel error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ── Leads ───────────────────────────────────────────────────────────────────────

// Combined cross-campaign overview for the caller's org(s). Duplicate companies
// are collapsed to one row (highest confidence wins) so the same company never
// appears twice "in totality". Each lead carries its campaignId + campaignTitle.
router.get('/leads', async (req, res) => {
    try {
        const scope = await resolveOrgScope(req);
        if (!scope.length) return res.json({ leads: [] });
        const verifiedQ = req.query.verified;
        const verified = verifiedQ === 'true' ? true : verifiedQ === 'false' ? false : null;
        const leads = await leadStudioStore.listAllLeads(scope, {
            status: req.query.status || null,
            assignee: req.query.assignee || null,
            verified,
            q: req.query.q || null,
            limit: parseInt(req.query.limit, 10) || 500,
            offset: parseInt(req.query.offset, 10) || 0,
        });
        res.json({ leads });
    } catch (err) {
        console.error('[LeadStudio] GET /leads error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

router.get('/campaigns/:id/leads', async (req, res) => {
    const campaign = await loadCampaignInScope(req, res, req.params.id);
    if (!campaign) return;
    try {
        const verifiedQ = req.query.verified;
        const verified = verifiedQ === 'true' ? true : verifiedQ === 'false' ? false : null;
        const leads = await leadStudioStore.listLeads({
            campaignId: campaign.id,
            organizationId: campaign.organizationId,
            status: req.query.status || null,
            assignee: req.query.assignee || null,
            verified,
            q: req.query.q || null,
            limit: parseInt(req.query.limit, 10) || 200,
            offset: parseInt(req.query.offset, 10) || 0,
        });
        res.json({ leads });
    } catch (err) {
        console.error('[LeadStudio] GET /campaigns/:id/leads error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Single lead (used by the CRM detail panel / tasks view to open a record).
router.get('/leads/:id', async (req, res) => {
    const lead = await loadLeadInScope(req, res, req.params.id);
    if (!lead) return;
    res.json({ lead });
});

router.patch('/leads/:id', async (req, res) => {
    const lead = await loadLeadInScope(req, res, req.params.id);
    if (!lead) return;
    try {
        const prevStatus = lead.status;
        const updated = await leadStudioStore.patchLead(lead.id, req.body || {});
        // Auto-log a stage move on the CRM timeline (the pipeline drag goes through here).
        if (updated && req.body && 'status' in req.body && updated.status !== prevStatus) {
            require('../stores/leadCrmStore').logActivity({
                leadId: lead.id, organizationId: lead.organizationId, type: 'stage_change',
                body: `Fase: ${prevStatus} → ${updated.status}`,
                metadata: { from: prevStatus, to: updated.status }, actorUserId: getUserId(req),
            }).catch(() => {});
        }
        res.json({ lead: updated });
    } catch (err) {
        console.error('[LeadStudio] PATCH /leads/:id error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Map known runner/assistant failures to friendly, actionable messages.
function aiErrorPayload(err) {
    const msg = String(err?.message || '');
    if (/provider_api_key_not_configured/.test(msg)) {
        return { code: 502, body: { error: 'provider_api_key_not_configured', message: 'No LLM provider is configured — set one up in Admin → AI Config.' } };
    }
    if (/web_search_unavailable|no_search_results/.test(msg)) {
        return { code: 502, body: { error: 'web_search_unavailable', message: 'Web search returned nothing (no Serper key / service unreachable). Configure it in Admin → AI Config → Agent Search.' } };
    }
    return { code: 500, body: { error: 'ai_action_failed', message: msg.slice(0, 200) } };
}

// On-demand "research more": deep-enrich this one lead in place (AI + providers +
// deeper web search), then emit lead_updated so all collaborators see it refresh.
router.post('/leads/:id/research', async (req, res) => {
    const lead = await loadLeadInScope(req, res, req.params.id);
    if (!lead) return;
    try {
        const focus = ['owner', 'company', 'all'].includes(req.body?.focus) ? req.body.focus : 'all';
        const result = await require('../services/leadAiAssistant').researchLead({
            leadId: lead.id, focus, orgId: lead.organizationId, userId: getUserId(req),
        });
        res.json({ lead: result.lead, usedSearch: result.usedSearch, changed: result.changed });
    } catch (err) {
        console.error('[LeadStudio] POST /leads/:id/research error:', err.message);
        const { code, body } = aiErrorPayload(err);
        res.status(code).json(body);
    }
});

// Generate (and persist) a personalized AI outreach e-mail draft for this lead.
router.post('/leads/:id/draft-email', async (req, res) => {
    const lead = await loadLeadInScope(req, res, req.params.id);
    if (!lead) return;
    try {
        const result = await require('../services/leadAiAssistant').draftEmail({
            leadId: lead.id,
            orgId: lead.organizationId,
            userId: getUserId(req),
            extraInstructions: req.body?.instructions || null,
            tone: req.body?.tone || null,
            save: true,
        });
        res.json({ subject: result.subject, body: result.body, usedSearch: result.usedSearch, lead: result.lead });
    } catch (err) {
        console.error('[LeadStudio] POST /leads/:id/draft-email error:', err.message);
        const { code, body } = aiErrorPayload(err);
        res.status(code).json(body);
    }
});

// Persist a user-edited e-mail draft without regenerating.
router.put('/leads/:id/draft-email', async (req, res) => {
    const lead = await loadLeadInScope(req, res, req.params.id);
    if (!lead) return;
    try {
        const updated = await leadStudioStore.saveEmailDraft(lead.id, {
            subject: req.body?.subject || null,
            body: req.body?.body || null,
            userId: getUserId(req),
        });
        res.json({ lead: updated });
    } catch (err) {
        console.error('[LeadStudio] PUT /leads/:id/draft-email error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ── CRM: activities / contacts / tasks / pipeline / AI ────────────────────────
const leadCrmStore = require('../stores/leadCrmStore');

async function loadContactInScope(req, res, id) {
    const scope = await resolveOrgScope(req);
    const contact = await leadCrmStore.getContact(id);
    if (!contact) { res.status(404).json({ error: 'Contact not found' }); return null; }
    if (!scope.includes(contact.organizationId)) { res.status(403).json({ error: 'Forbidden' }); return null; }
    return contact;
}
async function loadTaskInScope(req, res, id) {
    const scope = await resolveOrgScope(req);
    const task = await leadCrmStore.getTask(id);
    if (!task) { res.status(404).json({ error: 'Task not found' }); return null; }
    if (!scope.includes(task.organizationId)) { res.status(403).json({ error: 'Forbidden' }); return null; }
    return task;
}

// Activity timeline
router.get('/leads/:id/activities', async (req, res) => {
    const lead = await loadLeadInScope(req, res, req.params.id);
    if (!lead) return;
    try {
        const activities = await leadCrmStore.listActivities(lead.id, { limit: parseInt(req.query.limit, 10) || 100, offset: parseInt(req.query.offset, 10) || 0 });
        res.json({ activities });
    } catch (err) { console.error('[LeadStudio] GET activities:', err.message); res.status(500).json({ error: 'Internal error' }); }
});
router.post('/leads/:id/activities', async (req, res) => {
    const lead = await loadLeadInScope(req, res, req.params.id);
    if (!lead) return;
    try {
        const activity = await leadCrmStore.logActivity({
            leadId: lead.id, organizationId: lead.organizationId,
            type: req.body?.type || 'note', body: req.body?.body || '', actorUserId: getUserId(req),
        });
        res.json({ activity });
    } catch (err) { console.error('[LeadStudio] POST activity:', err.message); res.status(500).json({ error: 'Internal error' }); }
});

// Contacts (multiple per company; lead columns stay the canonical primary)
router.get('/leads/:id/contacts', async (req, res) => {
    const lead = await loadLeadInScope(req, res, req.params.id);
    if (!lead) return;
    try { res.json({ contacts: await leadCrmStore.listContacts(lead.id) }); }
    catch (err) { console.error('[LeadStudio] GET contacts:', err.message); res.status(500).json({ error: 'Internal error' }); }
});
router.post('/leads/:id/contacts', async (req, res) => {
    const lead = await loadLeadInScope(req, res, req.params.id);
    if (!lead) return;
    try {
        const b = req.body || {};
        const contact = await leadCrmStore.addContact({
            leadId: lead.id, organizationId: lead.organizationId,
            name: b.name, title: b.title, email: b.email, phone: b.phone, linkedinUrl: b.linkedinUrl, createdBy: getUserId(req),
        });
        res.json({ contact });
    } catch (err) { console.error('[LeadStudio] POST contact:', err.message); res.status(500).json({ error: 'Internal error' }); }
});
router.patch('/contacts/:id', async (req, res) => {
    const contact = await loadContactInScope(req, res, req.params.id);
    if (!contact) return;
    try { res.json({ contact: await leadCrmStore.updateContact(contact.id, req.body || {}) }); }
    catch (err) { console.error('[LeadStudio] PATCH contact:', err.message); res.status(500).json({ error: 'Internal error' }); }
});
router.delete('/contacts/:id', async (req, res) => {
    const contact = await loadContactInScope(req, res, req.params.id);
    if (!contact) return;
    try { await leadCrmStore.deleteContact(contact.id); res.json({ ok: true }); }
    catch (err) { console.error('[LeadStudio] DELETE contact:', err.message); res.status(500).json({ error: 'Internal error' }); }
});
router.post('/contacts/:id/primary', async (req, res) => {
    const contact = await loadContactInScope(req, res, req.params.id);
    if (!contact) return;
    try { res.json({ lead: await leadCrmStore.setPrimaryContact(contact.leadId, contact.id) }); }
    catch (err) { console.error('[LeadStudio] POST contact primary:', err.message); res.status(500).json({ error: 'Internal error' }); }
});

// Tasks / follow-ups
router.get('/tasks', async (req, res) => {
    try {
        const scope = await resolveOrgScope(req);
        if (!scope.length) return res.json({ tasks: [] });
        const tasks = await leadCrmStore.listTasks({
            organizationIds: scope,
            leadId: req.query.leadId || null,
            assignee: req.query.assignee || null,
            status: req.query.status || 'open',
            limit: parseInt(req.query.limit, 10) || 200,
        });
        res.json({ tasks });
    } catch (err) { console.error('[LeadStudio] GET tasks:', err.message); res.status(500).json({ error: 'Internal error' }); }
});
router.post('/leads/:id/tasks', async (req, res) => {
    const lead = await loadLeadInScope(req, res, req.params.id);
    if (!lead) return;
    try {
        const b = req.body || {};
        const task = await leadCrmStore.createTask({
            leadId: lead.id, organizationId: lead.organizationId,
            title: b.title, dueAt: b.dueAt || null, assigneeUserId: b.assigneeUserId || getUserId(req), createdBy: getUserId(req),
        });
        res.json({ task });
    } catch (err) {
        if (/title required/.test(err.message)) return res.status(400).json({ error: 'title_required' });
        console.error('[LeadStudio] POST task:', err.message); res.status(500).json({ error: 'Internal error' });
    }
});
router.patch('/tasks/:id', async (req, res) => {
    const task = await loadTaskInScope(req, res, req.params.id);
    if (!task) return;
    try { res.json({ task: await leadCrmStore.updateTask(task.id, req.body || {}) }); }
    catch (err) { console.error('[LeadStudio] PATCH task:', err.message); res.status(500).json({ error: 'Internal error' }); }
});
router.post('/tasks/:id/complete', async (req, res) => {
    const task = await loadTaskInScope(req, res, req.params.id);
    if (!task) return;
    try {
        const done = req.body?.completed === false
            ? await leadCrmStore.reopenTask(task.id)
            : await leadCrmStore.completeTask(task.id, getUserId(req));
        res.json({ task: done });
    } catch (err) { console.error('[LeadStudio] POST task complete:', err.message); res.status(500).json({ error: 'Internal error' }); }
});
router.delete('/tasks/:id', async (req, res) => {
    const task = await loadTaskInScope(req, res, req.params.id);
    if (!task) return;
    try { await leadCrmStore.deleteTask(task.id); res.json({ ok: true }); }
    catch (err) { console.error('[LeadStudio] DELETE task:', err.message); res.status(500).json({ error: 'Internal error' }); }
});

// Pipeline summary (per-stage count + € totals)
router.get('/pipeline', async (req, res) => {
    try {
        const scope = await resolveOrgScope(req);
        if (!scope.length) return res.json({ stages: {}, totalValue: 0, totalCount: 0 });
        res.json(await leadCrmStore.pipelineSummary(scope, { campaignId: req.query.campaignId || null }));
    } catch (err) { console.error('[LeadStudio] GET pipeline:', err.message); res.status(500).json({ error: 'Internal error' }); }
});
router.post('/pipeline/digest', async (req, res) => {
    try {
        const scope = await resolveOrgScope(req);
        if (!scope.length) return res.json({ summary: '', stalled: [], today: [], hottest: [] });
        const digest = await require('../services/leadCrmAssistant').pipelineDigest({ orgIds: scope, campaignId: req.body?.campaignId || null, userId: getUserId(req) });
        res.json(digest);
    } catch (err) { console.error('[LeadStudio] POST digest:', err.message); const { code, body } = aiErrorPayload(err); res.status(code).json(body); }
});
router.post('/pipeline/score', async (req, res) => {
    try {
        const scope = await resolveOrgScope(req);
        if (!scope.length) return res.json({ scored: [] });
        const scored = await require('../services/leadCrmAssistant').scoreHotness({ orgIds: scope, campaignId: req.body?.campaignId || null, stage: req.body?.stage || null, userId: getUserId(req) });
        res.json({ scored });
    } catch (err) { console.error('[LeadStudio] POST score:', err.message); const { code, body } = aiErrorPayload(err); res.status(code).json(body); }
});

// AI per-lead CRM helpers
router.post('/leads/:id/next-step', async (req, res) => {
    const lead = await loadLeadInScope(req, res, req.params.id);
    if (!lead) return;
    try {
        const out = await require('../services/leadCrmAssistant').suggestNextStep({ leadId: lead.id, orgId: lead.organizationId, userId: getUserId(req) });
        res.json(out);
    } catch (err) { console.error('[LeadStudio] POST next-step:', err.message); const { code, body } = aiErrorPayload(err); res.status(code).json(body); }
});
router.post('/leads/:id/log-from-notes', async (req, res) => {
    const lead = await loadLeadInScope(req, res, req.params.id);
    if (!lead) return;
    if (!req.body?.text || !String(req.body.text).trim()) return res.status(400).json({ error: 'text_required' });
    try {
        const out = await require('../services/leadCrmAssistant').logFromNotes({ leadId: lead.id, orgId: lead.organizationId, userId: getUserId(req), text: req.body.text });
        res.json(out);
    } catch (err) { console.error('[LeadStudio] POST log-from-notes:', err.message); const { code, body } = aiErrorPayload(err); res.status(code).json(body); }
});

// Bulk afvinken/verify. Body: { campaignId, leadIds: [], verified: true }
router.post('/leads/check-off', async (req, res) => {
    const body = req.body || {};
    if (!body.campaignId || !Array.isArray(body.leadIds) || !body.leadIds.length) {
        return res.status(400).json({ error: 'campaignId and leadIds[] required' });
    }
    const campaign = await loadCampaignInScope(req, res, body.campaignId);
    if (!campaign) return;
    try {
        const leads = await leadStudioStore.checkOffLeads({
            leadIds: body.leadIds,
            organizationId: campaign.organizationId,
            userId: getUserId(req),
            verified: body.verified !== false,
        });
        res.json({ leads });
    } catch (err) {
        console.error('[LeadStudio] POST /leads/check-off error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Eligible teammates for assignment (read-only) — powers the lead assignee
// picker. Returns members of the caller's in-scope orgs with display names.
router.get('/teammates', async (req, res) => {
    try {
        const scope = new Set(await resolveOrgScope(req));
        const userStore = require('../stores/userStore');
        const all = await userStore.getAllUsers().catch(() => []);
        const out = all
            .filter(u => u.organizationId && scope.has(u.organizationId))
            .map(u => ({ id: u.id, name: u.displayName || u.firstName || u.username || null, email: u.email || null }));
        res.json({ teammates: out });
    } catch (err) {
        console.error('[LeadStudio] GET /teammates error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ── SSE live updates (org-scoped) ─────────────────────────────────────────────
router.get('/stream', async (req, res) => {
    let listener = null, heartbeat = null, markEnded = () => {};
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return; cleaned = true;
        try { if (heartbeat) clearInterval(heartbeat); } catch {}
        try { if (listener) leadStudioStore.leadStudioEvents.off('event', listener); } catch {}
        try { markEnded(); } catch {}
    };
    try {
        const scope = new Set(await resolveOrgScope(req));
        const campaignFilter = req.query.campaignId || null;
        const sse = setupSSE(res);
        markEnded = sse.markEnded;
        sse.sendEvent('ready', { at: Date.now() });
        listener = ({ event, data }) => {
            if (!data || !data.organizationId || !scope.has(data.organizationId)) return;
            if (campaignFilter && data.campaignId && data.campaignId !== campaignFilter) return;
            try { sse.sendEvent(event, data); } catch { cleanup(); }
        };
        leadStudioStore.leadStudioEvents.on('event', listener);
        let pingFailures = 0;
        heartbeat = setInterval(() => {
            if (res.writableEnded) return cleanup();
            try { res.write(': ping\n\n'); pingFailures = 0; }
            catch { if (++pingFailures >= 3) cleanup(); }
        }, 25000);
        req.on('close', cleanup); req.on('error', cleanup); res.on('error', cleanup);
    } catch (err) {
        cleanup();
        if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
});

module.exports = router;
module.exports.leadStudioEvents = leadStudioStore.leadStudioEvents;
