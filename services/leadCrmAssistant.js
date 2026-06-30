/**
 * Lead CRM Assistant — one-shot AI helpers for the CRM section. Reuses the exact
 * model/adapter path as the lead runner (resolveModelAndAdapter + chatOnce), so
 * usage is logged and EU-aware model tiers apply.
 *
 *   • suggestNextStep — given stage + timeline + open tasks, propose the single
 *     best next action (and a ready task/e-mail).
 *   • logFromNotes    — turn a raw call/meeting note into a structured timeline
 *     entry + a suggested stage move + follow-up task.
 *   • pipelineDigest  — summarise the pipeline: stalled deals, today's focus,
 *     hottest leads.
 *   • scoreHotness    — rank leads by likelihood-to-convert (0-100 + reason),
 *     persisted to the lead's hotness_* columns.
 *
 * All AI calls degrade gracefully: a parse failure returns an empty/neutral
 * result rather than throwing (the route still responds).
 */

const leadStudioStore = require('../stores/leadStudioStore');
const leadCrmStore = require('../stores/leadCrmStore');
const runner = require('./leadGenerationRunner');

const noopLog = () => {};
const STAGES = ['new', 'contacted', 'qualified', 'disqualified', 'converted'];
const OPEN_STAGES = ['new', 'contacted', 'qualified'];

function daysSince(iso) {
    if (!iso) return null;
    const ms = Date.now() - new Date(iso).getTime();
    return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 86400000)) : null;
}

async function resolveMc({ modelTier, orgId, userId, log }) {
    return runner.resolveModelAndAdapter({ modelTier: modelTier || null, orgId, userId, log });
}

// ── suggestNextStep ─────────────────────────────────────────────────

const NEXT_STEP_SYSTEM = `Je bent een Nederlandse B2B sales-assistent. Op basis van de leadgegevens, de fase in de pijplijn, de recente tijdlijn en openstaande taken stel je de ÉNE beste volgende actie voor.
Regels:
- Wees concreet en kort. Verzin geen feiten.
- Kies action.type uit: "email" (stuur/▸opvolgmail), "task" (plan een actie), "call" (bellen), "wait" (nog even wachten).
- Bij "task": geef taskTitle (kort) en taskDueInDays (geheel getal).
- Geef ALLEEN JSON terug: {"suggestion": string, "rationale": string, "action": {"type": "email|task|call|wait"}, "taskTitle": string|null, "taskDueInDays": number|null}`;

async function suggestNextStep({ leadId, orgId, userId, log = noopLog }) {
    const lead = await leadStudioStore.getLead(leadId);
    if (!lead) throw new Error('lead_not_found');
    const effectiveOrg = orgId || lead.organizationId;
    const campaign = await leadStudioStore.getCampaign(lead.campaignId);
    const [activities, openTasks] = await Promise.all([
        leadCrmStore.listActivities(leadId, { limit: 12 }),
        leadCrmStore.listTasks({ organizationIds: [effectiveOrg], leadId, status: 'open', limit: 20 }),
    ]);
    const mc = await resolveMc({ modelTier: campaign?.modelTier, orgId: effectiveOrg, userId, log });

    const ctx = {
        company: lead.companyName, contact: lead.ownerName, title: lead.contactTitle,
        branche: lead.branche, stage: lead.status, dealValue: lead.dealValue,
        daysSinceUpdate: daysSince(lead.updatedAt),
        hasEmailDraft: !!lead.emailDraftSubject,
        timeline: activities.map(a => ({ type: a.type, body: a.body, daysAgo: daysSince(a.createdAt) })),
        openTasks: openTasks.map(t => ({ title: t.title, dueAt: t.dueAt })),
    };
    const resp = await runner.chatOnce(mc, [
        { role: 'system', content: NEXT_STEP_SYSTEM },
        { role: 'user', content: `Lead:\n${JSON.stringify(ctx, null, 0)}\n\nGeef het JSON-object met de beste volgende stap.` },
    ], { maxTokens: 600, temperature: 0.3 }, { orgId: effectiveOrg, userId });

    const p = runner.extractJson(typeof resp.content === 'string' ? resp.content : '') || {};
    const type = ['email', 'task', 'call', 'wait'].includes(p?.action?.type) ? p.action.type : 'task';
    return {
        suggestion: String(p.suggestion || '').slice(0, 300) || 'Plan een opvolgactie.',
        rationale: String(p.rationale || '').slice(0, 600),
        action: { type },
        taskTitle: p.taskTitle ? String(p.taskTitle).slice(0, 200) : null,
        taskDueInDays: Number.isFinite(Number(p.taskDueInDays)) ? Math.max(0, Math.round(Number(p.taskDueInDays))) : null,
    };
}

// ── logFromNotes ────────────────────────────────────────────────────

const LOG_NOTES_SYSTEM = `Je zet een ruwe notitie (gesprek/meeting/e-mail) om in een gestructureerde CRM-activiteit.
Regels:
- Gebruik ALLEEN wat in de notitie staat. Verzin niets.
- type: "call" | "meeting" | "note" | "email".
- body: een nette, beknopte samenvatting (NL).
- suggestedStatus: één van new|contacted|qualified|disqualified|converted als de notitie een duidelijke faseverandering impliceert, anders null.
- suggestedTask: {"title": string, "dueInDays": number} als er een duidelijke opvolgactie is, anders null.
- Geef ALLEEN JSON terug: {"type": string, "body": string, "suggestedStatus": string|null, "suggestedTask": {"title": string, "dueInDays": number}|null}`;

async function logFromNotes({ leadId, orgId, userId, text, log = noopLog }) {
    const lead = await leadStudioStore.getLead(leadId);
    if (!lead) throw new Error('lead_not_found');
    if (!text || !String(text).trim()) throw new Error('text_required');
    const effectiveOrg = orgId || lead.organizationId;
    const campaign = await leadStudioStore.getCampaign(lead.campaignId);
    const mc = await resolveMc({ modelTier: campaign?.modelTier, orgId: effectiveOrg, userId, log });

    const resp = await runner.chatOnce(mc, [
        { role: 'system', content: LOG_NOTES_SYSTEM },
        { role: 'user', content: `Bedrijf: ${lead.companyName}\nHuidige fase: ${lead.status}\n\nNotitie:\n${String(text).slice(0, 6000)}\n\nGeef het JSON-object.` },
    ], { maxTokens: 800, temperature: 0.2 }, { orgId: effectiveOrg, userId });

    const p = runner.extractJson(typeof resp.content === 'string' ? resp.content : '') || {};
    const type = ['call', 'meeting', 'note', 'email'].includes(p.type) ? p.type : 'note';
    const body = String(p.body || text).slice(0, 8000);
    const activity = await leadCrmStore.logActivity({
        leadId, organizationId: effectiveOrg, type, body,
        metadata: { source: 'ai_notes' }, actorUserId: userId,
    });
    const suggestedStatus = STAGES.includes(p.suggestedStatus) && p.suggestedStatus !== lead.status ? p.suggestedStatus : null;
    let suggestedTask = null;
    if (p.suggestedTask && p.suggestedTask.title) {
        suggestedTask = {
            title: String(p.suggestedTask.title).slice(0, 200),
            dueInDays: Number.isFinite(Number(p.suggestedTask.dueInDays)) ? Math.max(0, Math.round(Number(p.suggestedTask.dueInDays))) : 3,
        };
    }
    return { activity, suggestedStatus, suggestedTask };
}

// ── pipelineDigest ──────────────────────────────────────────────────

const DIGEST_SYSTEM = `Je bent een sales-pijplijn analist. Vat de open pijplijn samen voor vandaag.
Regels:
- Gebruik alleen de meegeleverde data. Wees concreet en kort (Nederlands).
- "stalled": leads die te lang stil liggen (hoge daysSinceUpdate, niet in fase 'new').
- "today": de belangrijkste acties voor vandaag.
- "hottest": de meest kansrijke leads.
- Geef ALLEEN JSON terug: {"summary": string, "stalled": [{"company": string, "reason": string}], "today": [string], "hottest": [{"company": string, "reason": string}]}`;

async function pipelineDigest({ orgIds, campaignId = null, userId = null, modelTier = null, log = noopLog }) {
    const ids = Array.isArray(orgIds) ? orgIds : [orgIds];
    if (!ids.length) return { summary: '', stalled: [], today: [], hottest: [] };
    const all = await leadStudioStore.listAllLeads(ids, { limit: 200 });
    const open = all.filter(l => OPEN_STAGES.includes(l.status) && (!campaignId || l.campaignId === campaignId));
    if (!open.length) return { summary: 'Geen open leads in de pijplijn.', stalled: [], today: [], hottest: [] };
    const overdue = await leadCrmStore.listTasks({ organizationIds: ids, status: 'overdue', limit: 50 });
    const today = await leadCrmStore.listTasks({ organizationIds: ids, status: 'today', limit: 50 });

    const mc = await resolveMc({ modelTier, orgId: ids[0], userId, log });
    const leadsCtx = open.slice(0, 60).map(l => ({
        company: l.companyName, stage: l.status, dealValue: l.dealValue,
        daysSinceUpdate: daysSince(l.updatedAt), hotness: l.hotnessScore,
    }));
    const tasksCtx = [...overdue, ...today].slice(0, 40).map(t => ({ title: t.title, company: t.companyName, dueAt: t.dueAt, overdue: !!(t.dueAt && new Date(t.dueAt) < new Date()) }));

    const resp = await runner.chatOnce(mc, [
        { role: 'system', content: DIGEST_SYSTEM },
        { role: 'user', content: `Open leads:\n${JSON.stringify(leadsCtx, null, 0)}\n\nOpenstaande taken (te laat + vandaag):\n${JSON.stringify(tasksCtx, null, 0)}\n\nGeef het JSON-object.` },
    ], { maxTokens: 1200, temperature: 0.3 }, { orgId: ids[0], userId });

    const p = runner.extractJson(typeof resp.content === 'string' ? resp.content : '') || {};
    return {
        summary: String(p.summary || '').slice(0, 1200),
        stalled: Array.isArray(p.stalled) ? p.stalled.slice(0, 10) : [],
        today: Array.isArray(p.today) ? p.today.slice(0, 10).map(s => String(s).slice(0, 200)) : [],
        hottest: Array.isArray(p.hottest) ? p.hottest.slice(0, 10) : [],
    };
}

// ── scoreHotness ────────────────────────────────────────────────────

const SCORE_SYSTEM = `Je beoordeelt B2B-leads op kans-tot-conversie (0-100). Gebruik alleen de meegeleverde data.
Hoger = warmer (compleet contact, recente activiteit, goede fit, hogere fase). Geef per lead een score + 1 korte reden (NL).
Geef ALLEEN een JSON-array terug: [{"id": string, "score": number, "reason": string}]`;

async function scoreHotness({ orgIds, campaignId = null, stage = null, userId = null, modelTier = null, log = noopLog }) {
    const ids = Array.isArray(orgIds) ? orgIds : [orgIds];
    if (!ids.length) return [];
    const all = await leadStudioStore.listAllLeads(ids, { status: stage || null, limit: 200 });
    const leads = all.filter(l => (!campaignId || l.campaignId === campaignId)).slice(0, 60);
    if (!leads.length) return [];
    const mc = await resolveMc({ modelTier, orgId: ids[0], userId, log });

    const ctx = leads.map(l => ({
        id: l.id, company: l.companyName, stage: l.status, branche: l.branche,
        dealValue: l.dealValue, hasEmail: !!l.email, hasPhone: !!l.phone,
        aiConfidence: l.aiConfidence, daysSinceUpdate: daysSince(l.updatedAt),
    }));
    const resp = await runner.chatOnce(mc, [
        { role: 'system', content: SCORE_SYSTEM },
        { role: 'user', content: `Leads:\n${JSON.stringify(ctx, null, 0)}\n\nGeef de JSON-array met scores.` },
    ], { maxTokens: 2000, temperature: 0.2 }, { orgId: ids[0], userId });

    const parsed = runner.extractJson(typeof resp.content === 'string' ? resp.content : '');
    const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.scores) ? parsed.scores : []);
    const valid = new Set(leads.map(l => l.id));
    const out = [];
    for (const s of arr) {
        if (!s || !valid.has(s.id)) continue;
        const score = Math.max(0, Math.min(100, Math.round(Number(s.score) || 0)));
        const reason = String(s.reason || '').slice(0, 300);
        try { await leadStudioStore.setHotness(s.id, { score, reason }); } catch (_) {}
        out.push({ id: s.id, score, reason });
    }
    return out;
}

module.exports = {
    suggestNextStep, logFromNotes, pipelineDigest, scoreHotness,
    _internals: { daysSince, STAGES, OPEN_STAGES },
};
