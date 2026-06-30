/**
 * Lead Studio Store — lead-generation campaign lifecycle + collaborative leads.
 *
 * Three tables:
 *   • lead_campaigns        — one row per search brief + run state
 *   • leads                 — one compact lead row per company (collaborative)
 *   • lead_generation_jobs  — outbox the worker drains (claim_token, attempts, backoff)
 *
 * Pattern mirrors stores/securityScanStore.js: startCampaignRun() writes the
 * status flip + outbox row in one transaction, and the worker claims rows with
 * SELECT ... FOR UPDATE SKIP LOCKED under concurrent drains.
 *
 * Realtime collaboration: instead of per-run EventEmitter channels we expose a
 * single shared org-scoped bus `leadStudioEvents` (mirrors `supportEvents`).
 * Every event carries `organizationId` + `campaignId` so the route /stream
 * endpoint forwards only events the caller's org may see. Both the generation
 * runner (lead_created/lead_updated/run_progress) and the route layer
 * (lead_updated on PATCH/check-off) emit through it.
 *
 * AVG/GDPR: leads carry a legitimate-interest basis on their campaign and a
 * retention window; purgeExpiredLeads() deletes lead PII past that window while
 * keeping the campaign shell (criteria/audit trail).
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { run, getOne, getAll, exec, getClient } = require('../db');

let initialized = false;

const CAMPAIGN_STATUSES = new Set(['draft', 'queued', 'running', 'completed', 'error', 'cancelled']);
const CAMPAIGN_TERMINAL = new Set(['completed', 'error', 'cancelled']);
const LEAD_STATUSES = new Set(['new', 'contacted', 'qualified', 'disqualified', 'converted']);

// Shared org-scoped event bus (mirrors supportEvents). No per-id channels — the
// route /stream filters by organizationId. Many SSE connections subscribe, so
// lift the listener cap to avoid spurious MaxListeners warnings.
const leadStudioEvents = new EventEmitter();
leadStudioEvents.setMaxListeners(0);

function emitLeadEvent(event, data = {}) {
    try { leadStudioEvents.emit('event', { event, data: { ...data, at: Date.now() } }); }
    catch (e) { console.warn('[LeadStudioStore] emit failed:', e.message); }
}

async function initDB() {
    if (initialized) return;

    await exec(`
        CREATE TABLE IF NOT EXISTS lead_campaigns (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id TEXT NOT NULL,
            created_by TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            criteria JSONB NOT NULL DEFAULT '{}'::jsonb,
            model_tier TEXT,
            target_count INT NOT NULL DEFAULT 25,
            enrichment_providers JSONB NOT NULL DEFAULT '["web_search"]'::jsonb,
            status TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','queued','running','completed','error','cancelled')),
            last_run_error TEXT,
            leads_found INT NOT NULL DEFAULT 0,
            legal_basis TEXT NOT NULL DEFAULT 'legitimate_interest_b2b',
            retention_days INT NOT NULL DEFAULT 90,
            started_at TIMESTAMPTZ,
            finished_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_lead_campaigns_org ON lead_campaigns(organization_id);
        CREATE INDEX IF NOT EXISTS idx_lead_campaigns_org_status ON lead_campaigns(organization_id, status);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS leads (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            campaign_id UUID NOT NULL REFERENCES lead_campaigns(id) ON DELETE CASCADE,
            organization_id TEXT NOT NULL,
            company_name TEXT NOT NULL,
            kvk_number TEXT,
            address TEXT,
            website TEXT,
            branche TEXT,
            company_size TEXT,
            sbi_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
            owner_name TEXT,
            contact_title TEXT,
            email TEXT,
            phone TEXT,
            linkedin_url TEXT,
            status TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','contacted','qualified','disqualified','converted')),
            assignee_user_id TEXT,
            verified BOOLEAN NOT NULL DEFAULT FALSE,
            checked_by_user_id TEXT,
            checked_at TIMESTAMPTZ,
            notes TEXT,
            ai_confidence NUMERIC(3,2),
            provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
            dedup_key TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads(campaign_id);
        CREATE INDEX IF NOT EXISTS idx_leads_org_status ON leads(organization_id, status);
        CREATE INDEX IF NOT EXISTS idx_leads_assignee ON leads(assignee_user_id) WHERE assignee_user_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_campaign_dedup ON leads(campaign_id, dedup_key);
        CREATE INDEX IF NOT EXISTS idx_leads_provenance_gin ON leads USING GIN (provenance);
        CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS lead_generation_jobs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            campaign_id UUID UNIQUE NOT NULL REFERENCES lead_campaigns(id) ON DELETE CASCADE,
            claim_token TEXT,
            claimed_by TEXT,
            claimed_at TIMESTAMPTZ,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            last_attempt_at TIMESTAMPTZ,
            last_error TEXT,
            next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            delivered_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_lead_gen_jobs_next ON lead_generation_jobs(next_attempt_at) WHERE delivered_at IS NULL;
    `);

    // v2 additive columns (idempotent — safe on every boot + via db:migrate):
    //  • lead_campaigns.outreach_pitch — reason-for-outreach / offer, reused by AI email drafting
    //  • leads.email_draft_* — the latest persisted AI outreach draft (collaborative; never clobbered on re-run)
    //  • leads.last_research_* — when/who last ran an on-demand "research more" enrichment
    await exec(`
        ALTER TABLE lead_campaigns ADD COLUMN IF NOT EXISTS outreach_pitch TEXT;
        ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_draft_subject TEXT;
        ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_draft_body TEXT;
        ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_draft_at TIMESTAMPTZ;
        ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_draft_by_user_id TEXT;
        ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_research_at TIMESTAMPTZ;
        ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_research_by_user_id TEXT;
        CREATE INDEX IF NOT EXISTS idx_leads_org_dedup ON leads(organization_id, dedup_key);
    `);

    // v3 CRM columns (idempotent) — deal tracking + cached AI hotness (1:1 per lead).
    await exec(`
        ALTER TABLE leads ADD COLUMN IF NOT EXISTS deal_value NUMERIC(14,2);
        ALTER TABLE leads ADD COLUMN IF NOT EXISTS expected_close_at DATE;
        ALTER TABLE leads ADD COLUMN IF NOT EXISTS hotness_score INT;
        ALTER TABLE leads ADD COLUMN IF NOT EXISTS hotness_reason TEXT;
        ALTER TABLE leads ADD COLUMN IF NOT EXISTS hotness_at TIMESTAMPTZ;
    `);

    initialized = true;
    console.log('[LeadStudioStore] PostgreSQL initialized');
}

initDB().catch(err => console.error('[LeadStudioStore] Init error:', err.message));

// ── Cancellation ───────────────────────────────────────────────────
// The runner polls isCancelRequested() between companies; the route flips the
// flag and marks the campaign cancelled in the DB so the concurrency slot frees
// even if the worker has crashed.
const _cancelRequests = new Set();

function requestCancel(campaignId) { _cancelRequests.add(campaignId); }
function isCancelRequested(campaignId) { return _cancelRequests.has(campaignId); }
function _clearCancel(campaignId) { _cancelRequests.delete(campaignId); }

// ── Helpers ─────────────────────────────────────────────────────────

function parseJSON(v, fallback) {
    if (v === null || v === undefined) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fallback; }
}

function slugify(s) {
    return String(s || '')
        .toLowerCase()
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120);
}

function registrableDomain(website) {
    if (!website) return '';
    let host = String(website).trim().toLowerCase();
    host = host.replace(/^https?:\/\//, '').replace(/^www\./, '');
    host = host.split(/[\/?#]/)[0];
    return host;
}

/**
 * Stable dedup key for a lead within a campaign.
 * Precedence: KvK number (most authoritative) → registrable domain → name+locatie slug.
 */
function computeDedupKey(lead = {}) {
    const kvk = String(lead.kvk_number || lead.kvkNumber || '').replace(/\D/g, '');
    if (kvk.length >= 7) return `kvk:${kvk}`;
    const domain = registrableDomain(lead.website);
    if (domain) return `dom:${domain}`;
    const name = slugify(lead.company_name || lead.companyName);
    const loc = slugify(lead.locatie || lead.location || (lead.criteria && lead.criteria.locatie) || '');
    return `nm:${name}${loc ? `@${loc}` : ''}`;
}

function clampInt(v, min, max, dflt) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(Math.max(n, min), max);
}

// ── Mappers ─────────────────────────────────────────────────────────

function mapCampaignRow(r) {
    if (!r) return null;
    return {
        id: r.id,
        organizationId: r.organization_id,
        createdBy: r.created_by,
        title: r.title || '',
        criteria: parseJSON(r.criteria, {}),
        outreachPitch: r.outreach_pitch || null,
        modelTier: r.model_tier || null,
        targetCount: r.target_count != null ? Number(r.target_count) : 25,
        enrichmentProviders: parseJSON(r.enrichment_providers, ['web_search']),
        status: r.status,
        lastRunError: r.last_run_error || null,
        leadsFound: r.leads_found != null ? Number(r.leads_found) : 0,
        legalBasis: r.legal_basis || 'legitimate_interest_b2b',
        retentionDays: r.retention_days != null ? Number(r.retention_days) : 90,
        startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
        finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

function mapLeadRow(r) {
    if (!r) return null;
    return {
        id: r.id,
        campaignId: r.campaign_id,
        organizationId: r.organization_id,
        companyName: r.company_name,
        kvkNumber: r.kvk_number || null,
        address: r.address || null,
        website: r.website || null,
        branche: r.branche || null,
        companySize: r.company_size || null,
        sbiCodes: parseJSON(r.sbi_codes, []),
        ownerName: r.owner_name || null,
        contactTitle: r.contact_title || null,
        email: r.email || null,
        phone: r.phone || null,
        linkedinUrl: r.linkedin_url || null,
        status: r.status,
        assigneeUserId: r.assignee_user_id || null,
        verified: !!r.verified,
        checkedByUserId: r.checked_by_user_id || null,
        checkedAt: r.checked_at ? new Date(r.checked_at).toISOString() : null,
        notes: r.notes || null,
        aiConfidence: r.ai_confidence != null ? Number(r.ai_confidence) : null,
        provenance: parseJSON(r.provenance, {}),
        dedupKey: r.dedup_key,
        emailDraftSubject: r.email_draft_subject || null,
        emailDraftBody: r.email_draft_body || null,
        emailDraftAt: r.email_draft_at ? new Date(r.email_draft_at).toISOString() : null,
        emailDraftByUserId: r.email_draft_by_user_id || null,
        lastResearchAt: r.last_research_at ? new Date(r.last_research_at).toISOString() : null,
        lastResearchByUserId: r.last_research_by_user_id || null,
        // CRM (v3)
        dealValue: r.deal_value != null ? Number(r.deal_value) : null,
        expectedCloseAt: r.expected_close_at ? new Date(r.expected_close_at).toISOString().slice(0, 10) : null,
        hotnessScore: r.hotness_score != null ? Number(r.hotness_score) : null,
        hotnessReason: r.hotness_reason || null,
        hotnessAt: r.hotness_at ? new Date(r.hotness_at).toISOString() : null,
        // Present only on cross-campaign queries (listAllLeads JOINs the title).
        ...(r.campaign_title !== undefined ? { campaignTitle: r.campaign_title || null } : {}),
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

// ── Campaign CRUD ───────────────────────────────────────────────────

async function createCampaign({ organizationId, createdBy, title = '', criteria = {}, outreachPitch = null, modelTier = null, targetCount = 25, enrichmentProviders = ['web_search'], retentionDays = 90 }) {
    await initDB();
    if (!organizationId) throw new Error('organizationId required');
    if (!createdBy) throw new Error('createdBy required');
    const providers = Array.isArray(enrichmentProviders) && enrichmentProviders.length
        ? Array.from(new Set(['web_search', ...enrichmentProviders]))
        : ['web_search'];
    const row = await getOne(
        `INSERT INTO lead_campaigns
            (organization_id, created_by, title, criteria, outreach_pitch, model_tier, target_count, enrichment_providers, retention_days, status)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8::jsonb,$9,'draft')
         RETURNING *`,
        [organizationId, createdBy, String(title || '').slice(0, 200), JSON.stringify(criteria || {}),
         outreachPitch ? String(outreachPitch).slice(0, 4000) : null,
         modelTier || null, clampInt(targetCount, 1, 200, 25), JSON.stringify(providers), clampInt(retentionDays, 1, 365, 90)]
    );
    const campaign = mapCampaignRow(row);
    emitLeadEvent('campaign_created', { organizationId, campaignId: campaign.id, campaign });
    return campaign;
}

async function listCampaigns(organizationIds, { limit = 100, offset = 0 } = {}) {
    await initDB();
    const ids = Array.isArray(organizationIds) ? organizationIds : [organizationIds];
    if (!ids.length) return [];
    const rows = await getAll(
        `SELECT * FROM lead_campaigns WHERE organization_id = ANY($1::text[])
         ORDER BY updated_at DESC LIMIT $2 OFFSET $3`,
        [ids, clampInt(limit, 1, 500, 100), clampInt(offset, 0, 1e9, 0)]
    );
    return rows.map(mapCampaignRow);
}

async function getCampaign(id) {
    await initDB();
    return mapCampaignRow(await getOne(`SELECT * FROM lead_campaigns WHERE id = $1`, [id]));
}

// Only criteria/title/model_tier/providers/retention are editable, and only
// while the campaign is still a draft (a queued/running campaign is locked).
const CAMPAIGN_UPDATABLE = {
    title: { col: 'title', xform: v => String(v || '').slice(0, 200) },
    criteria: { col: 'criteria', json: true, xform: v => v || {} },
    outreachPitch: { col: 'outreach_pitch', xform: v => (v == null || v === '' ? null : String(v).slice(0, 4000)) },
    modelTier: { col: 'model_tier', xform: v => (v == null ? null : String(v).slice(0, 64)) },
    targetCount: { col: 'target_count', xform: v => clampInt(v, 1, 200, 25) },
    enrichmentProviders: { col: 'enrichment_providers', json: true, xform: v => Array.from(new Set(['web_search', ...(Array.isArray(v) ? v : [])])) },
    retentionDays: { col: 'retention_days', xform: v => clampInt(v, 1, 365, 90) },
};

async function updateCampaign(id, updates = {}) {
    await initDB();
    const sets = [];
    const params = [];
    for (const [key, spec] of Object.entries(CAMPAIGN_UPDATABLE)) {
        if (!(key in updates)) continue;
        params.push(spec.json ? JSON.stringify(spec.xform(updates[key])) : spec.xform(updates[key]));
        sets.push(`${spec.col} = $${params.length}${spec.json ? '::jsonb' : ''}`);
    }
    if (!sets.length) return getCampaign(id);
    params.push(id);
    // Editable any time the campaign isn't actively running/queued (draft,
    // completed, error, cancelled) — so users can tweak criteria and re-run.
    const row = await getOne(
        `UPDATE lead_campaigns SET ${sets.join(', ')}, updated_at = NOW()
          WHERE id = $${params.length} AND status NOT IN ('queued','running')
          RETURNING *`,
        params
    );
    const campaign = mapCampaignRow(row);
    if (campaign) emitLeadEvent('campaign_updated', { organizationId: campaign.organizationId, campaignId: campaign.id, campaign });
    return campaign;
}

async function deleteCampaign(id) {
    await initDB();
    const { rowCount } = await run(`DELETE FROM lead_campaigns WHERE id = $1`, [id]);
    return rowCount > 0;
}

/**
 * Atomically flip the campaign to queued + create its outbox row (one per
 * campaign — UNIQUE on campaign_id, re-runs reset the existing row). Mirrors
 * securityScanStore.createScan's transactional entity+outbox write.
 */
async function startCampaignRun(campaignId) {
    await initDB();
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `UPDATE lead_campaigns
                SET status = 'queued', last_run_error = NULL, started_at = NULL, finished_at = NULL, updated_at = NOW()
              WHERE id = $1 AND status NOT IN ('queued','running')
              RETURNING *`,
            [campaignId]
        );
        if (!rows.length) { await client.query('ROLLBACK'); return null; }
        await client.query(
            `INSERT INTO lead_generation_jobs (campaign_id, attempt_count, next_attempt_at, claim_token, claimed_by, claimed_at, delivered_at, last_error)
             VALUES ($1, 0, NOW(), NULL, NULL, NULL, NULL, NULL)
             ON CONFLICT (campaign_id) DO UPDATE
                SET attempt_count = 0, next_attempt_at = NOW(),
                    claim_token = NULL, claimed_by = NULL, claimed_at = NULL,
                    delivered_at = NULL, last_error = NULL`,
            [campaignId]
        );
        await client.query('COMMIT');
        _clearCancel(campaignId);
        const campaign = mapCampaignRow(rows[0]);
        emitLeadEvent('run_status', { organizationId: campaign.organizationId, campaignId, status: 'queued' });
        return campaign;
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
    } finally {
        client.release();
    }
}

// ── Worker-facing claim / finalize API ──────────────────────────────
// Concurrency caps partition on created_by (the "user") and organization_id.
// Copied from securityScanStore.claimDueJobs, table/column names swapped.
async function claimDueJobs({ batchSize = 5, perUserCap = 1e9, orgCap = 1e9, globalCap = 1e9, targetCampaignId = null, workerId = 'inproc' } = {}) {
    await initDB();
    const client = await getClient();
    let claimed = [];
    try {
        await client.query('BEGIN');
        const params = [perUserCap, orgCap, globalCap];
        let targetFilter = '';
        if (targetCampaignId) {
            params.push(targetCampaignId);
            targetFilter = ` AND j.campaign_id = $${params.length}`;
        }
        const q = `
            WITH active AS (
                SELECT c.created_by, c.organization_id
                  FROM lead_generation_jobs j
                  JOIN lead_campaigns c ON c.id = j.campaign_id
                 WHERE j.delivered_at IS NULL AND j.claim_token IS NOT NULL
            ),
            active_user AS (SELECT created_by, COUNT(*) cc FROM active GROUP BY created_by),
            active_org AS (SELECT organization_id, COUNT(*) cc FROM active WHERE organization_id IS NOT NULL GROUP BY organization_id),
            active_total AS (SELECT COUNT(*) cc FROM active),
            candidates AS (
                SELECT j.id AS job_id, j.campaign_id, j.attempt_count, j.next_attempt_at,
                       c.created_by, c.organization_id,
                       COALESCE(au.cc, 0) AS user_active,
                       COALESCE(ao.cc, 0) AS org_active,
                       ROW_NUMBER() OVER (PARTITION BY c.created_by ORDER BY j.next_attempt_at ASC) AS user_rank,
                       ROW_NUMBER() OVER (PARTITION BY c.organization_id ORDER BY j.next_attempt_at ASC) AS org_rank
                  FROM lead_generation_jobs j
                  JOIN lead_campaigns c ON c.id = j.campaign_id
                  LEFT JOIN active_user au ON au.created_by = c.created_by
                  LEFT JOIN active_org ao ON ao.organization_id = c.organization_id
                 WHERE j.delivered_at IS NULL
                   AND c.status = 'queued'
                   AND (j.claimed_at IS NULL OR j.claimed_at < NOW() - INTERVAL '10 minutes')
                   AND (j.last_attempt_at IS NULL
                        OR j.last_attempt_at < NOW() - (POWER(2, LEAST(j.attempt_count, 12)) * INTERVAL '1 second'))
                   ${targetFilter}
            ),
            eligible AS (
                SELECT job_id
                  FROM candidates
                 WHERE user_active + user_rank <= $1::int
                   AND (organization_id IS NULL OR org_active + org_rank <= $2::int)
                 ORDER BY next_attempt_at ASC
                 LIMIT GREATEST(0, $3::int - (SELECT cc FROM active_total))::int
            )
            SELECT j.id AS job_id, j.campaign_id, j.attempt_count,
                   c.created_by, c.organization_id
              FROM lead_generation_jobs j
              JOIN lead_campaigns c ON c.id = j.campaign_id
             WHERE j.id IN (SELECT job_id FROM eligible)
             ORDER BY j.next_attempt_at ASC
             LIMIT ${Math.max(1, batchSize | 0)}
             FOR UPDATE OF j SKIP LOCKED`;
        const result = await client.query(q, params);
        claimed = result.rows;
        if (claimed.length > 0) {
            const token = crypto.randomBytes(8).toString('hex');
            const ids = claimed.map(c => c.job_id);
            await client.query(
                `UPDATE lead_generation_jobs SET claim_token = $1, claimed_by = $2, claimed_at = NOW()
                  WHERE id = ANY($3::uuid[])`,
                [token, workerId, ids]
            );
        }
        await client.query('COMMIT');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('[LeadStudioStore] claim failed:', e.message);
        return [];
    } finally {
        client.release();
    }
    return claimed;
}

async function countActiveByScope({ createdBy = null, organizationId = null } = {}) {
    await initDB();
    const r = await getOne(
        `SELECT
            COUNT(*)::int AS global_active,
            COUNT(*) FILTER (WHERE c.created_by = $1)::int AS user_active,
            COUNT(*) FILTER (WHERE $2::text IS NOT NULL AND c.organization_id = $2)::int AS org_active
          FROM lead_generation_jobs j
          JOIN lead_campaigns c ON c.id = j.campaign_id
         WHERE j.delivered_at IS NULL AND j.claim_token IS NOT NULL`,
        [createdBy, organizationId]
    );
    return { global: r?.global_active || 0, user: r?.user_active || 0, org: r?.org_active || 0 };
}

async function markRunning(campaignId) {
    await initDB();
    const cur = await getOne(`SELECT status, organization_id FROM lead_campaigns WHERE id = $1`, [campaignId]);
    if (!cur) return false;
    if (CAMPAIGN_TERMINAL.has(cur.status)) return false;
    if (cur.status === 'running') return true;
    const { rowCount } = await run(
        `UPDATE lead_campaigns SET status = 'running', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
          WHERE id = $1 AND status = 'queued'`,
        [campaignId]
    );
    if (rowCount > 0) emitLeadEvent('run_status', { organizationId: cur.organization_id, campaignId, status: 'running' });
    return rowCount > 0;
}

/** Recompute leads_found from the leads table + emit run_progress. */
async function recountLeads(campaignId) {
    await initDB();
    const r = await getOne(
        `UPDATE lead_campaigns
            SET leads_found = (SELECT COUNT(*) FROM leads WHERE campaign_id = $1), updated_at = NOW()
          WHERE id = $1
          RETURNING organization_id, leads_found`,
        [campaignId]
    );
    if (r) emitLeadEvent('run_progress', { organizationId: r.organization_id, campaignId, leadsFound: Number(r.leads_found) });
    return r ? Number(r.leads_found) : 0;
}

async function markFinished(campaignId, { status, error = null } = {}) {
    await initDB();
    if (!CAMPAIGN_TERMINAL.has(status)) throw new Error(`invalid terminal status: ${status}`);
    const cur = await getOne(`SELECT status, organization_id FROM lead_campaigns WHERE id = $1`, [campaignId]);
    if (!cur) return false;
    if (CAMPAIGN_TERMINAL.has(cur.status)) return false;
    await run(
        `UPDATE lead_campaigns
            SET status = $2,
                last_run_error = $3,
                leads_found = (SELECT COUNT(*) FROM leads WHERE campaign_id = $1),
                finished_at = NOW(),
                updated_at = NOW()
          WHERE id = $1`,
        [campaignId, status, error ? String(error).slice(0, 1000) : null]
    );
    await run(`UPDATE lead_generation_jobs SET delivered_at = NOW(), last_error = $2 WHERE campaign_id = $1`,
        [campaignId, status === 'error' ? String(error || 'error').slice(0, 500) : null]);
    _clearCancel(campaignId);
    emitLeadEvent('run_status', { organizationId: cur.organization_id, campaignId, status, error: error || null });
    return true;
}

async function markRetryable(campaignId, errorMessage) {
    await initDB();
    await run(
        `UPDATE lead_generation_jobs
            SET attempt_count = attempt_count + 1, last_attempt_at = NOW(), last_error = $2,
                claim_token = NULL, claimed_by = NULL, claimed_at = NULL
          WHERE campaign_id = $1`,
        [campaignId, String(errorMessage || '').slice(0, 500)]
    );
    // Return the campaign to queued so the next drain re-claims it.
    await run(`UPDATE lead_campaigns SET status = 'queued', updated_at = NOW() WHERE id = $1 AND status = 'running'`, [campaignId]);
}

async function markCancelled(campaignId, userId) {
    await initDB();
    const cur = await getOne(`SELECT created_by, status, organization_id FROM lead_campaigns WHERE id = $1`, [campaignId]);
    if (!cur) return { ok: false, error: 'not_found' };
    if (userId && cur.created_by !== userId) return { ok: false, error: 'forbidden' };
    if (CAMPAIGN_TERMINAL.has(cur.status)) return { ok: false, error: 'already_terminal', status: cur.status };
    requestCancel(campaignId);
    await run(
        `UPDATE lead_campaigns
            SET status = 'cancelled', finished_at = NOW(),
                last_run_error = COALESCE(last_run_error, 'Cancelled by user'), updated_at = NOW()
          WHERE id = $1 AND status NOT IN ('completed','error','cancelled')`,
        [campaignId]
    );
    await run(`UPDATE lead_generation_jobs SET delivered_at = NOW(), last_error = 'cancelled' WHERE campaign_id = $1`, [campaignId]);
    emitLeadEvent('run_status', { organizationId: cur.organization_id, campaignId, status: 'cancelled' });
    return { ok: true };
}

// ── Lead CRUD ───────────────────────────────────────────────────────

const LEAD_AI_FIELDS = ['company_name', 'kvk_number', 'address', 'website', 'branche', 'company_size', 'owner_name', 'contact_title', 'email', 'phone', 'linkedin_url'];

/**
 * Insert or merge a lead. On conflict (same campaign + dedup_key) we update ONLY
 * the AI-populated company/contact fields + provenance + confidence — never the
 * collaboration columns (status, assignee, verified, checked_by, notes), so a re-run
 * cannot clobber a teammate's edits. New non-null values win; provenance merges.
 */
async function upsertLead({ campaignId, organizationId, dedupKey, provenance = {}, aiConfidence = null, ...fields }) {
    await initDB();
    if (!campaignId || !organizationId) throw new Error('campaignId + organizationId required');
    const key = dedupKey || computeDedupKey(fields);
    const cols = {
        company_name: fields.company_name || fields.companyName || 'Onbekend',
        kvk_number: fields.kvk_number ?? fields.kvkNumber ?? null,
        address: fields.address ?? null,
        website: fields.website ?? null,
        branche: fields.branche ?? null,
        company_size: fields.company_size ?? fields.companySize ?? null,
        sbi_codes: fields.sbi_codes ?? fields.sbiCodes ?? [],
        owner_name: fields.owner_name ?? fields.ownerName ?? null,
        contact_title: fields.contact_title ?? fields.contactTitle ?? null,
        email: fields.email ?? null,
        phone: fields.phone ?? null,
        linkedin_url: fields.linkedin_url ?? fields.linkedinUrl ?? null,
    };
    // Build the DO UPDATE clause: COALESCE(EXCLUDED.col, leads.col) for each AI
    // field (incoming non-null wins), provenance concat, confidence max.
    const updateSets = LEAD_AI_FIELDS.map(c => `${c} = COALESCE(EXCLUDED.${c}, leads.${c})`)
        .concat([
            'sbi_codes = CASE WHEN EXCLUDED.sbi_codes = \'[]\'::jsonb THEN leads.sbi_codes ELSE EXCLUDED.sbi_codes END',
            'provenance = leads.provenance || EXCLUDED.provenance',
            'ai_confidence = GREATEST(COALESCE(EXCLUDED.ai_confidence, 0), COALESCE(leads.ai_confidence, 0))',
            'updated_at = NOW()',
        ]).join(', ');
    const row = await getOne(
        `INSERT INTO leads
            (campaign_id, organization_id, company_name, kvk_number, address, website, branche, company_size, sbi_codes,
             owner_name, contact_title, email, phone, linkedin_url, ai_confidence, provenance, dedup_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)
         ON CONFLICT (campaign_id, dedup_key) DO UPDATE SET ${updateSets}
         RETURNING *`,
        [campaignId, organizationId, cols.company_name, cols.kvk_number, cols.address, cols.website,
         cols.branche, cols.company_size, JSON.stringify(cols.sbi_codes || []), cols.owner_name,
         cols.contact_title, cols.email, cols.phone, cols.linkedin_url,
         aiConfidence != null ? Number(aiConfidence) : null, JSON.stringify(provenance || {}), key]
    );
    const lead = mapLeadRow(row);
    // created vs updated: xmax = 0 on a fresh INSERT row.
    const created = row && (row.xmax === '0' || row.xmax === 0);
    emitLeadEvent(created ? 'lead_created' : 'lead_updated', { organizationId, campaignId, lead });
    return { lead, created };
}

async function listLeads({ campaignId, organizationId, status = null, assignee = null, verified = null, q = null, limit = 200, offset = 0 }) {
    await initDB();
    const where = ['campaign_id = $1', 'organization_id = $2'];
    const params = [campaignId, organizationId];
    if (status && LEAD_STATUSES.has(status)) { params.push(status); where.push(`status = $${params.length}`); }
    if (assignee) { params.push(assignee); where.push(`assignee_user_id = $${params.length}`); }
    if (verified === true || verified === false) { params.push(verified); where.push(`verified = $${params.length}`); }
    if (q) { params.push(`%${String(q).slice(0, 100)}%`); where.push(`(company_name ILIKE $${params.length} OR owner_name ILIKE $${params.length} OR email ILIKE $${params.length})`); }
    params.push(clampInt(limit, 1, 1000, 200));
    params.push(clampInt(offset, 0, 1e9, 0));
    const rows = await getAll(
        `SELECT * FROM leads WHERE ${where.join(' AND ')}
         ORDER BY ai_confidence DESC NULLS LAST, created_at ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return rows.map(mapLeadRow);
}

/**
 * Cross-campaign overview for an org. Collapses duplicate companies to one row
 * per dedup_key (DISTINCT ON keeps the highest-confidence / verified / freshest
 * row) so the same company never appears twice "in totality" across campaigns.
 * Each lead carries its campaign id + title for the overview's Campagne column.
 */
async function listAllLeads(organizationIds, { status = null, assignee = null, verified = null, q = null, limit = 500, offset = 0 } = {}) {
    await initDB();
    const ids = Array.isArray(organizationIds) ? organizationIds : [organizationIds];
    if (!ids.length) return [];
    const where = ['l.organization_id = ANY($1::text[])'];
    const params = [ids];
    if (status && LEAD_STATUSES.has(status)) { params.push(status); where.push(`l.status = $${params.length}`); }
    if (assignee) { params.push(assignee); where.push(`l.assignee_user_id = $${params.length}`); }
    if (verified === true || verified === false) { params.push(verified); where.push(`l.verified = $${params.length}`); }
    if (q) { params.push(`%${String(q).slice(0, 100)}%`); where.push(`(l.company_name ILIKE $${params.length} OR l.owner_name ILIKE $${params.length} OR l.email ILIKE $${params.length})`); }
    params.push(clampInt(limit, 1, 2000, 500));
    params.push(clampInt(offset, 0, 1e9, 0));
    const rows = await getAll(
        `SELECT * FROM (
            SELECT DISTINCT ON (l.dedup_key) l.*, c.title AS campaign_title
              FROM leads l
              JOIN lead_campaigns c ON c.id = l.campaign_id
             WHERE ${where.join(' AND ')}
             ORDER BY l.dedup_key, l.ai_confidence DESC NULLS LAST, l.verified DESC, l.updated_at DESC
         ) t
         ORDER BY t.ai_confidence DESC NULLS LAST, t.created_at ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return rows.map(mapLeadRow);
}

async function getLead(id) {
    await initDB();
    return mapLeadRow(await getOne(`SELECT * FROM leads WHERE id = $1`, [id]));
}

/** Persist the latest AI outreach e-mail draft on a lead. Collaborative — emits lead_updated. */
async function saveEmailDraft(leadId, { subject = null, body = null, userId = null } = {}) {
    await initDB();
    const row = await getOne(
        `UPDATE leads
            SET email_draft_subject = $2, email_draft_body = $3,
                email_draft_at = NOW(), email_draft_by_user_id = $4, updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [leadId, subject ? String(subject).slice(0, 500) : null, body ? String(body).slice(0, 20000) : null, userId || null]
    );
    const lead = mapLeadRow(row);
    if (lead) emitLeadEvent('lead_updated', { organizationId: lead.organizationId, campaignId: lead.campaignId, lead });
    return lead;
}

/** Stamp who/when last ran on-demand "research more" on a lead. Emits lead_updated. */
async function markResearched(leadId, userId = null) {
    await initDB();
    const row = await getOne(
        `UPDATE leads SET last_research_at = NOW(), last_research_by_user_id = $2, updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [leadId, userId || null]
    );
    const lead = mapLeadRow(row);
    if (lead) emitLeadEvent('lead_updated', { organizationId: lead.organizationId, campaignId: lead.campaignId, lead });
    return lead;
}

/** Cache the AI hotness/priority score on a lead (CRM). Emits lead_updated. */
async function setHotness(leadId, { score = null, reason = null } = {}) {
    await initDB();
    const s = score == null ? null : Math.max(0, Math.min(100, Math.round(Number(score))));
    const row = await getOne(
        `UPDATE leads SET hotness_score = $2, hotness_reason = $3, hotness_at = NOW(), updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [leadId, Number.isFinite(s) ? s : null, reason ? String(reason).slice(0, 500) : null]
    );
    const lead = mapLeadRow(row);
    if (lead) emitLeadEvent('lead_updated', { organizationId: lead.organizationId, campaignId: lead.campaignId, lead });
    return lead;
}

/**
 * Overwrite a lead's canonical primary-contact columns (used when the CRM
 * "set primary contact" swaps a lead_contacts row into the lead). Emits lead_updated.
 */
async function updatePrimaryContact(leadId, { ownerName = null, contactTitle = null, email = null, phone = null, linkedinUrl = null } = {}) {
    await initDB();
    const row = await getOne(
        `UPDATE leads
            SET owner_name = $2, contact_title = $3, email = $4, phone = $5, linkedin_url = $6, updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [leadId, ownerName || null, contactTitle || null, email || null, phone || null, linkedinUrl || null]
    );
    const lead = mapLeadRow(row);
    if (lead) emitLeadEvent('lead_updated', { organizationId: lead.organizationId, campaignId: lead.campaignId, lead });
    return lead;
}

const LEAD_PATCHABLE = {
    status: { col: 'status', valid: v => LEAD_STATUSES.has(v) },
    assigneeUserId: { col: 'assignee_user_id', xform: v => (v ? String(v).slice(0, 128) : null) },
    notes: { col: 'notes', xform: v => (v == null ? null : String(v).slice(0, 4000)) },
    dealValue: { col: 'deal_value', xform: v => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null)) },
    expectedCloseAt: { col: 'expected_close_at', xform: v => (v ? String(v).slice(0, 10) : null) },
};

async function patchLead(id, updates = {}) {
    await initDB();
    const sets = [];
    const params = [];
    for (const [key, spec] of Object.entries(LEAD_PATCHABLE)) {
        if (!(key in updates)) continue;
        if (spec.valid && !spec.valid(updates[key])) continue;
        params.push(spec.xform ? spec.xform(updates[key]) : updates[key]);
        sets.push(`${spec.col} = $${params.length}`);
    }
    if (!sets.length) return getLead(id);
    params.push(id);
    const row = await getOne(
        `UPDATE leads SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
        params
    );
    const lead = mapLeadRow(row);
    if (lead) emitLeadEvent('lead_updated', { organizationId: lead.organizationId, campaignId: lead.campaignId, lead });
    return lead;
}

/** Bulk afvinken/verify. Sets verified + checked_by/checked_at; emits per lead. */
async function checkOffLeads({ leadIds, organizationId, userId, verified = true }) {
    await initDB();
    if (!Array.isArray(leadIds) || !leadIds.length) return [];
    const rows = await getAll(
        `UPDATE leads
            SET verified = $4,
                checked_by_user_id = CASE WHEN $4 THEN $3 ELSE NULL END,
                checked_at = CASE WHEN $4 THEN NOW() ELSE NULL END,
                updated_at = NOW()
          WHERE id = ANY($1::uuid[]) AND organization_id = $2
          RETURNING *`,
        [leadIds, organizationId, userId || null, !!verified]
    );
    const leads = rows.map(mapLeadRow);
    for (const lead of leads) emitLeadEvent('lead_updated', { organizationId, campaignId: lead.campaignId, lead });
    return leads;
}

async function countLeadsByStatus(campaignId) {
    await initDB();
    const rows = await getAll(
        `SELECT status, COUNT(*)::int AS n FROM leads WHERE campaign_id = $1 GROUP BY status`,
        [campaignId]
    );
    const out = { total: 0, verified: 0 };
    for (const r of rows) { out[r.status] = r.n; out.total += r.n; }
    const v = await getOne(`SELECT COUNT(*)::int AS n FROM leads WHERE campaign_id = $1 AND verified = TRUE`, [campaignId]);
    out.verified = v?.n || 0;
    return out;
}

// ── AVG / GDPR retention ────────────────────────────────────────────
// Delete lead PII whose row is older than its campaign's retention window.
// Campaign shells are kept (criteria/audit). Returns the purged count.
async function purgeExpiredLeads() {
    await initDB();
    const { rowCount } = await run(
        `DELETE FROM leads l USING lead_campaigns c
          WHERE l.campaign_id = c.id
            AND l.created_at < NOW() - (c.retention_days || ' days')::interval`
    );
    if (rowCount > 0) console.log(`[LeadStudioStore] purged ${rowCount} expired lead(s)`);
    return rowCount;
}

module.exports = {
    initDB,
    leadStudioEvents,
    emitLeadEvent,
    // campaigns
    createCampaign,
    listCampaigns,
    getCampaign,
    updateCampaign,
    deleteCampaign,
    startCampaignRun,
    // worker
    claimDueJobs,
    countActiveByScope,
    markRunning,
    recountLeads,
    markFinished,
    markRetryable,
    // cancellation
    requestCancel,
    isCancelRequested,
    markCancelled,
    // leads
    upsertLead,
    listLeads,
    listAllLeads,
    getLead,
    patchLead,
    checkOffLeads,
    saveEmailDraft,
    markResearched,
    setHotness,
    updatePrimaryContact,
    countLeadsByStatus,
    // gdpr
    purgeExpiredLeads,
    // helpers (also exported for tests)
    computeDedupKey,
    slugify,
    registrableDomain,
    _internals: { CAMPAIGN_STATUSES, CAMPAIGN_TERMINAL, LEAD_STATUSES },
};
