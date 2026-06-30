/**
 * steps.js — automationStore aggregate (§WS5, extracted verbatim).
 */

const crypto = require('crypto');
const { initDB, run, getOne, getAll, exec, getClient, pool } = require('./core');
const { rowToAutomation, rowToRun, rowToRunStep, safeParse, fromJsonb } = require('./rowMappers');
const { getAutomation } = require('./automations');

// ── Steps (reusable building blocks, kind='block') ─────
//
// Steps reuse the automations table + automation_versions + builder_session.
// Sharing mirrors Agents/KBs (is_published + shared_groups); publish-to-apply
// uses published_version → the automation_versions snapshot consumers run.

/** A Step is visible to a user when they own it, or it's shared into one of
 *  their orgs and either published-for-sharing or they're an org admin, and
 *  (when group-restricted) they belong to one of the shared groups. */
function userCanSeeStep(row, { userId, userGroups = [], isOrgAdmin = false }) {
    if (row.user_id === userId) return true;
    if (!row.is_published && !isOrgAdmin) return false;
    const groups = typeof row.shared_groups === 'string' ? safeParse(row.shared_groups, []) : (row.shared_groups || []);
    if (Array.isArray(groups) && groups.length > 0 && !isOrgAdmin) {
        return groups.some(g => userGroups.includes(g));
    }
    return true;
}

/** Steps the user can manage/see in the Steps tab (own + shared, incl drafts
 *  for owners and org admins). orgIds = the user's org ids. */
async function getStepsForUser(userId, { orgIds = [], userGroups = [], isOrgAdmin = false } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM automations
          WHERE kind = 'block'
            AND (user_id = $1 OR organization_id = ANY($2::text[]))
          ORDER BY updated_at DESC`,
        [userId, orgIds],
    );
    return rows
        .filter(r => userCanSeeStep(r, { userId, userGroups, isOrgAdmin }))
        .map(rowToAutomation);
}

/** Published + accessible Steps with their contract + required integrations,
 *  for the builder palette and chat-tool exposure. Resolves the published
 *  version's definition (publish-to-apply), not the working draft. */
async function getCallableStepsForUser(userId, { orgIds = [], userGroups = [] } = {}) {
    await initDB();
    const { stepContract, requiredIntegrations } = require('../../automation/stepContract');
    const rows = await getAll(
        `SELECT a.id, a.user_id, a.organization_id, a.title, a.description, a.icon, a.category,
                a.is_published, a.shared_groups, a.published_version, a.expose_as_tool,
                av.definition_json AS published_def
           FROM automations a
           JOIN automation_versions av
             ON av.automation_id = a.id AND av.version = a.published_version
          WHERE a.kind = 'block'
            AND a.published_version IS NOT NULL
            AND (a.user_id = $1 OR a.organization_id = ANY($2::text[]))
          ORDER BY a.title ASC`,
        [userId, orgIds],
    );
    return rows
        .filter(r => userCanSeeStep(r, { userId, userGroups, isOrgAdmin: false }))
        .map(r => {
            const def = typeof r.published_def === 'string' ? safeParse(r.published_def, {}) : (r.published_def || {});
            const { params, outputFields } = stepContract(def);
            return {
                id: r.id,
                title: r.title,
                description: r.description || '',
                icon: r.icon ?? null,
                category: r.category ?? null,
                publishedVersion: r.published_version,
                exposeAsTool: r.expose_as_tool ?? false,
                ownerId: r.user_id,
                organizationId: r.organization_id,
                params,
                outputFields,
                requiredIntegrations: requiredIntegrations(def),
            };
        });
}

async function createStep({ userId, organizationId = null, title, description = '', definition, icon = null, category = null }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO automations (id, user_id, organization_id, kind, title, description, icon, category, definition_json,
            version, is_active, is_draft, needs_first_run_confirm, trigger_type, schedule_tz)
         VALUES ($1,$2,$3,'block',$4,$5,$6,$7,$8,1,FALSE,TRUE,FALSE,'manual','Europe/Amsterdam')`,
        [id, userId, organizationId, title, description, icon || null, category || null, JSON.stringify(definition || {})],
    );
    await run(
        `INSERT INTO automation_versions (id, automation_id, version, definition_json, saved_by_user_id, change_summary)
         VALUES ($1, $2, 1, $3, $4, $5)
         ON CONFLICT (automation_id, version) DO NOTHING`,
        [crypto.randomUUID(), id, JSON.stringify(definition || {}), userId, 'Created'],
    );
    return getAutomation(id);
}

/** Publish the current draft: snapshot definition_json into a fresh
 *  automation_versions row and point published_version at it. Reuses the
 *  version counter so the snapshot and pointer never collide. */
async function publishStep(id, savedByUserId) {
    await initDB();
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const cur = await client.query(`SELECT definition_json, version FROM automations WHERE id = $1 AND kind = 'block' FOR UPDATE`, [id]);
        if (!cur.rows[0]) { await client.query('ROLLBACK'); return null; }
        const nextVersion = (cur.rows[0].version || 1) + 1;
        const def = cur.rows[0].definition_json;
        const defJson = typeof def === 'string' ? def : JSON.stringify(def || {});
        await client.query(
            `INSERT INTO automation_versions (id, automation_id, version, definition_json, saved_by_user_id, change_summary)
             VALUES ($1,$2,$3,$4,$5,'Published')
             ON CONFLICT (automation_id, version) DO NOTHING`,
            [crypto.randomUUID(), id, nextVersion, defJson, savedByUserId],
        );
        const upd = await client.query(
            `UPDATE automations SET version = $2, published_version = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
            [id, nextVersion],
        );
        await client.query('COMMIT');
        return rowToAutomation(upd.rows[0]);
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

async function setStepSharing(id, { isPublished, sharedGroups }) {
    await initDB();
    const groups = Array.isArray(sharedGroups) ? sharedGroups : [];
    const r = await run(
        `UPDATE automations SET is_published = $2, shared_groups = $3, updated_at = NOW()
          WHERE id = $1 AND kind = 'block' RETURNING id`,
        [id, !!isPublished, JSON.stringify(groups)],
    );
    return r.rowCount > 0 ? getAutomation(id) : null;
}

async function setStepExpose(id, exposeAsTool) {
    await initDB();
    const r = await run(
        `UPDATE automations SET expose_as_tool = $2, updated_at = NOW()
          WHERE id = $1 AND kind = 'block' RETURNING id`,
        [id, !!exposeAsTool],
    );
    return r.rowCount > 0 ? getAutomation(id) : null;
}

/** Automations (kind='automation') that reference a Step via a call_block step.
 *  Used to refuse delete/unpublish while in use. Coarse JSONB-text prefilter +
 *  exact JSON walk. */
async function getStepConsumers(blockId) {
    await initDB();
    const rows = await getAll(
        `SELECT id, title, definition_json FROM automations
          WHERE kind = 'automation' AND definition_json::text LIKE $1`,
        [`%${blockId}%`],
    );
    const { walkSteps } = require('../../automation/stepContract');
    const consumers = [];
    for (const r of rows) {
        const def = typeof r.definition_json === 'string' ? safeParse(r.definition_json, {}) : (r.definition_json || {});
        let hit = false;
        const scan = (graph) => walkSteps(graph?.steps, (s) => { if (s.type === 'call_block' && s.blockId === blockId) hit = true; });
        scan(def);
        if (def && typeof def.layers === 'object') for (const l of Object.values(def.layers)) scan(l);
        if (hit) consumers.push({ id: r.id, title: r.title });
    }
    return consumers;
}

module.exports = { getStepsForUser, getCallableStepsForUser, createStep, publishStep, setStepSharing, setStepExpose, getStepConsumers };
