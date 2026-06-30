/**
 * Lead CRM Store — the relationship layer on top of Lead Studio leads.
 *
 * Three tables (all org-scoped, cascade-deleted with their lead):
 *   • lead_contacts    — additional contacts per company (the lead's own
 *                        owner_name/email/… columns remain the canonical PRIMARY;
 *                        setPrimaryContact swaps a row into them).
 *   • lead_activities  — append-only timeline (note/call/email/meeting/stage_change/
 *                        task/ai/system); mirrors stores/projectStore.js.
 *   • lead_tasks       — follow-ups with a due date + assignee; a 60s scheduler
 *                        notifies the assignee when one comes due (mirrors
 *                        stores/reminderStore.js + notificationStore).
 *
 * Realtime: reuses leadStudioStore's shared `leadStudioEvents` bus via
 * emitLeadEvent (activity_created / task_created / task_updated /
 * contact_created / contact_updated / contact_deleted). The route /stream
 * already forwards any org-scoped event.
 */

const { run, getOne, getAll, exec } = require('../db');
const leadStudioStore = require('./leadStudioStore');

let initialized = false;

const ACTIVITY_TYPES = new Set(['note', 'call', 'email', 'meeting', 'stage_change', 'task', 'ai', 'system']);
const emit = (event, data) => leadStudioStore.emitLeadEvent(event, data);

async function initDB() {
    if (initialized) return;

    await exec(`
        CREATE TABLE IF NOT EXISTS lead_contacts (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
            organization_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            title TEXT,
            email TEXT,
            phone TEXT,
            linkedin_url TEXT,
            is_primary BOOLEAN NOT NULL DEFAULT FALSE,
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_lead_contacts_lead ON lead_contacts(lead_id);

        CREATE TABLE IF NOT EXISTS lead_activities (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
            organization_id TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'note'
                CHECK (type IN ('note','call','email','meeting','stage_change','task','ai','system')),
            body TEXT NOT NULL DEFAULT '',
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            actor_user_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_lead_activities_lead ON lead_activities(lead_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS lead_tasks (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
            organization_id TEXT NOT NULL,
            title TEXT NOT NULL,
            due_at TIMESTAMPTZ,
            assignee_user_id TEXT,
            completed_at TIMESTAMPTZ,
            completed_by TEXT,
            notified_at TIMESTAMPTZ,
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_lead_tasks_due ON lead_tasks(organization_id, due_at) WHERE completed_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_lead_tasks_assignee ON lead_tasks(assignee_user_id) WHERE assignee_user_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_lead_tasks_lead ON lead_tasks(lead_id);
    `);

    initialized = true;
    console.log('[LeadCrmStore] PostgreSQL initialized');
}

initDB().catch(err => console.error('[LeadCrmStore] Init error:', err.message));

// ── Mappers ─────────────────────────────────────────────────────────

function parseJSON(v, fallback) {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fallback; }
}
const iso = (d) => (d ? new Date(d).toISOString() : null);

function mapContact(r) {
    if (!r) return null;
    return {
        id: r.id, leadId: r.lead_id, organizationId: r.organization_id,
        name: r.name || '', title: r.title || null, email: r.email || null,
        phone: r.phone || null, linkedinUrl: r.linkedin_url || null,
        isPrimary: !!r.is_primary, createdBy: r.created_by || null,
        createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    };
}

function mapActivity(r) {
    if (!r) return null;
    return {
        id: r.id, leadId: r.lead_id, organizationId: r.organization_id,
        type: r.type, body: r.body || '', metadata: parseJSON(r.metadata, {}),
        actorUserId: r.actor_user_id || null, createdAt: iso(r.created_at),
    };
}

function mapTask(r) {
    if (!r) return null;
    return {
        id: r.id, leadId: r.lead_id, organizationId: r.organization_id,
        title: r.title, dueAt: iso(r.due_at), assigneeUserId: r.assignee_user_id || null,
        completedAt: iso(r.completed_at), completedBy: r.completed_by || null,
        createdBy: r.created_by || null, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
        // Present when the query JOINs the lead (TasksView shows the company).
        ...(r.company_name !== undefined ? { companyName: r.company_name || null } : {}),
    };
}

// ── Activities ──────────────────────────────────────────────────────

async function logActivity({ leadId, organizationId, type = 'note', body = '', metadata = {}, actorUserId = null }) {
    await initDB();
    if (!leadId || !organizationId) throw new Error('leadId + organizationId required');
    const t = ACTIVITY_TYPES.has(type) ? type : 'note';
    const row = await getOne(
        `INSERT INTO lead_activities (lead_id, organization_id, type, body, metadata, actor_user_id)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
        [leadId, organizationId, t, String(body || '').slice(0, 8000), JSON.stringify(metadata || {}), actorUserId || null]
    );
    const activity = mapActivity(row);
    emit('activity_created', { organizationId, leadId, activity });
    return activity;
}

async function listActivities(leadId, { limit = 100, offset = 0 } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM lead_activities WHERE lead_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [leadId, Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500), Math.max(parseInt(offset, 10) || 0, 0)]
    );
    return rows.map(mapActivity);
}

// ── Contacts ────────────────────────────────────────────────────────

async function listContacts(leadId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM lead_contacts WHERE lead_id = $1 ORDER BY is_primary DESC, created_at ASC`,
        [leadId]
    );
    return rows.map(mapContact);
}

async function addContact({ leadId, organizationId, name = '', title = null, email = null, phone = null, linkedinUrl = null, createdBy = null }) {
    await initDB();
    if (!leadId || !organizationId) throw new Error('leadId + organizationId required');
    const row = await getOne(
        `INSERT INTO lead_contacts (lead_id, organization_id, name, title, email, phone, linkedin_url, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [leadId, organizationId, String(name || '').slice(0, 200), title || null, email || null, phone || null, linkedinUrl || null, createdBy || null]
    );
    const contact = mapContact(row);
    emit('contact_created', { organizationId, leadId, contact });
    return contact;
}

const CONTACT_PATCHABLE = ['name', 'title', 'email', 'phone', 'linkedin_url'];
async function updateContact(id, updates = {}) {
    await initDB();
    const map = { name: 'name', title: 'title', email: 'email', phone: 'phone', linkedinUrl: 'linkedin_url' };
    const sets = []; const params = [];
    for (const [k, col] of Object.entries(map)) {
        if (!(k in updates)) continue;
        params.push(updates[k] == null ? null : String(updates[k]).slice(0, 500));
        sets.push(`${col} = $${params.length}`);
    }
    if (!sets.length) return getOne(`SELECT * FROM lead_contacts WHERE id = $1`, [id]).then(mapContact);
    params.push(id);
    const row = await getOne(`UPDATE lead_contacts SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`, params);
    const contact = mapContact(row);
    if (contact) emit('contact_updated', { organizationId: contact.organizationId, leadId: contact.leadId, contact });
    return contact;
}

async function getContact(id) {
    await initDB();
    return mapContact(await getOne(`SELECT * FROM lead_contacts WHERE id = $1`, [id]));
}

async function deleteContact(id) {
    await initDB();
    const row = await getOne(`DELETE FROM lead_contacts WHERE id = $1 RETURNING *`, [id]);
    const contact = mapContact(row);
    if (contact) emit('contact_deleted', { organizationId: contact.organizationId, leadId: contact.leadId, contactId: id });
    return contact;
}

/**
 * Promote a lead_contacts row to the lead's canonical primary contact: the
 * lead's current primary is demoted into a contact row, and the chosen contact's
 * values are written onto the lead (so board/table/AI keep using lead columns).
 */
async function setPrimaryContact(leadId, contactId) {
    await initDB();
    const lead = await leadStudioStore.getLead(leadId);
    const contact = await getContact(contactId);
    if (!lead || !contact || contact.leadId !== leadId) return null;

    // Demote the current primary (if it has any data) into a contact row.
    if (lead.ownerName || lead.email || lead.phone || lead.linkedinUrl) {
        await addContact({
            leadId, organizationId: lead.organizationId,
            name: lead.ownerName || lead.companyName, title: lead.contactTitle,
            email: lead.email, phone: lead.phone, linkedinUrl: lead.linkedinUrl,
        });
    }
    // Promote the chosen contact onto the lead, then remove its row.
    await leadStudioStore.updatePrimaryContact(leadId, {
        ownerName: contact.name, contactTitle: contact.title,
        email: contact.email, phone: contact.phone, linkedinUrl: contact.linkedinUrl,
    });
    await run(`DELETE FROM lead_contacts WHERE id = $1`, [contactId]);
    emit('contact_deleted', { organizationId: lead.organizationId, leadId, contactId });
    return leadStudioStore.getLead(leadId);
}

// ── Tasks ───────────────────────────────────────────────────────────

async function createTask({ leadId, organizationId, title, dueAt = null, assigneeUserId = null, createdBy = null }) {
    await initDB();
    if (!leadId || !organizationId) throw new Error('leadId + organizationId required');
    if (!title || !String(title).trim()) throw new Error('title required');
    const row = await getOne(
        `INSERT INTO lead_tasks (lead_id, organization_id, title, due_at, assignee_user_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [leadId, organizationId, String(title).slice(0, 300), dueAt || null, assigneeUserId || null, createdBy || null]
    );
    const task = mapTask(row);
    emit('task_created', { organizationId, leadId, task });
    await logActivity({ leadId, organizationId, type: 'task', body: `Taak: ${task.title}`, metadata: { taskId: task.id, dueAt: task.dueAt }, actorUserId: createdBy });
    return task;
}

const TASK_SELECT = `SELECT t.*, l.company_name FROM lead_tasks t JOIN leads l ON l.id = t.lead_id`;

async function listTasks({ organizationIds, leadId = null, assignee = null, status = 'open', limit = 200, offset = 0 } = {}) {
    await initDB();
    const ids = Array.isArray(organizationIds) ? organizationIds : (organizationIds ? [organizationIds] : []);
    if (!ids.length) return [];
    const where = ['t.organization_id = ANY($1::text[])'];
    const params = [ids];
    if (leadId) { params.push(leadId); where.push(`t.lead_id = $${params.length}`); }
    if (assignee) { params.push(assignee); where.push(`t.assignee_user_id = $${params.length}`); }
    if (status === 'open') where.push('t.completed_at IS NULL');
    else if (status === 'done') where.push('t.completed_at IS NOT NULL');
    else if (status === 'overdue') where.push("t.completed_at IS NULL AND t.due_at IS NOT NULL AND t.due_at < NOW()");
    else if (status === 'today') where.push("t.completed_at IS NULL AND t.due_at::date = NOW()::date");
    else if (status === 'upcoming') where.push("t.completed_at IS NULL AND t.due_at IS NOT NULL AND t.due_at > NOW()");
    params.push(Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000));
    params.push(Math.max(parseInt(offset, 10) || 0, 0));
    const rows = await getAll(
        `${TASK_SELECT} WHERE ${where.join(' AND ')}
         ORDER BY (t.due_at IS NULL), t.due_at ASC, t.created_at ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return rows.map(mapTask);
}

async function getTask(id) {
    await initDB();
    return mapTask(await getOne(`${TASK_SELECT} WHERE t.id = $1`, [id]));
}

async function updateTask(id, updates = {}) {
    await initDB();
    const map = { title: 'title', dueAt: 'due_at', assigneeUserId: 'assignee_user_id' };
    const sets = []; const params = [];
    for (const [k, col] of Object.entries(map)) {
        if (!(k in updates)) continue;
        let v = updates[k];
        if (k === 'title') v = String(v || '').slice(0, 300);
        else v = v || null;
        params.push(v);
        sets.push(`${col} = $${params.length}`);
    }
    // Editing the due date re-arms the "due" notification.
    if ('dueAt' in updates) sets.push('notified_at = NULL');
    if (!sets.length) return getTask(id);
    params.push(id);
    await run(`UPDATE lead_tasks SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`, params);
    const task = await getTask(id);
    if (task) emit('task_updated', { organizationId: task.organizationId, leadId: task.leadId, task });
    return task;
}

async function completeTask(id, userId = null) {
    await initDB();
    await run(`UPDATE lead_tasks SET completed_at = NOW(), completed_by = $2, updated_at = NOW() WHERE id = $1 AND completed_at IS NULL`, [id, userId || null]);
    const task = await getTask(id);
    if (task) {
        emit('task_updated', { organizationId: task.organizationId, leadId: task.leadId, task });
        await logActivity({ leadId: task.leadId, organizationId: task.organizationId, type: 'task', body: `Taak afgerond: ${task.title}`, metadata: { taskId: task.id }, actorUserId: userId });
    }
    return task;
}

async function reopenTask(id) {
    await initDB();
    await run(`UPDATE lead_tasks SET completed_at = NULL, completed_by = NULL, notified_at = NULL, updated_at = NOW() WHERE id = $1`, [id]);
    const task = await getTask(id);
    if (task) emit('task_updated', { organizationId: task.organizationId, leadId: task.leadId, task });
    return task;
}

async function deleteTask(id) {
    await initDB();
    const row = await getOne(`SELECT * FROM lead_tasks WHERE id = $1`, [id]);
    if (!row) return false;
    await run(`DELETE FROM lead_tasks WHERE id = $1`, [id]);
    emit('task_updated', { organizationId: row.organization_id, leadId: row.lead_id, task: null, deletedId: id });
    return true;
}

// ── Pipeline aggregation ────────────────────────────────────────────

async function pipelineSummary(organizationIds, { campaignId = null } = {}) {
    await initDB();
    const ids = Array.isArray(organizationIds) ? organizationIds : [organizationIds];
    if (!ids.length) return { stages: {}, totalValue: 0, totalCount: 0 };
    const params = [ids];
    let extra = '';
    if (campaignId) { params.push(campaignId); extra = ` AND campaign_id = $${params.length}`; }
    const rows = await getAll(
        `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(deal_value),0)::numeric AS value
           FROM leads WHERE organization_id = ANY($1::text[])${extra} GROUP BY status`,
        params
    );
    const stages = {};
    let totalValue = 0; let totalCount = 0;
    for (const r of rows) {
        stages[r.status] = { count: r.n, value: Number(r.value) };
        totalValue += Number(r.value); totalCount += r.n;
    }
    return { stages, totalValue, totalCount };
}

// ── Due-task scheduler (mirrors reminderStore) ──────────────────────

async function processDueTasks() {
    try {
        await initDB();
        const notificationStore = require('./notificationStore');
        const rows = await getAll(
            `${TASK_SELECT} WHERE t.completed_at IS NULL AND t.notified_at IS NULL
               AND t.due_at IS NOT NULL AND t.due_at <= NOW() AND t.assignee_user_id IS NOT NULL
             LIMIT 200`
        );
        for (const r of rows) {
            const task = mapTask(r);
            try {
                await notificationStore.createNotification({
                    userId: task.assigneeUserId,
                    category: 'heads_up',
                    title: `Opvolgtaak: ${task.title}`,
                    message: task.companyName ? `Lead: ${task.companyName}` : '',
                    link: 'studio/lead-studio',
                });
            } catch (e) { console.warn('[LeadCrmStore] notify failed:', e.message); }
            await run(`UPDATE lead_tasks SET notified_at = NOW() WHERE id = $1`, [task.id]);
            emit('task_updated', { organizationId: task.organizationId, leadId: task.leadId, task: { ...task, notified: true } });
        }
    } catch (e) { console.warn('[LeadCrmStore] processDueTasks error:', e.message); }
}

if (process.env.LEAD_CRM_TASK_TICK !== 'false') {
    setTimeout(() => { processDueTasks().catch(() => {}); }, 8000).unref?.();
    setInterval(() => { processDueTasks().catch(() => {}); }, 60000).unref?.();
}

module.exports = {
    initDB,
    // activities
    logActivity, listActivities,
    // contacts
    listContacts, addContact, updateContact, getContact, deleteContact, setPrimaryContact,
    // tasks
    createTask, listTasks, getTask, updateTask, completeTask, reopenTask, deleteTask,
    // pipeline + scheduler
    pipelineSummary, processDueTasks,
    // test helpers
    _internals: { ACTIVITY_TYPES, mapTask, mapActivity, mapContact },
};
