/**
 * versions.js — automationStore aggregate (§WS5, extracted verbatim).
 */

const crypto = require('crypto');
const { initDB, run, getOne, getAll, exec, getClient, pool } = require('./core');
const { rowToAutomation, rowToRun, rowToRunStep, safeParse, fromJsonb } = require('./rowMappers');

async function listVersions(automationId) {
    await initDB();
    // LEFT JOIN users so the panel can show who saved each version. The
    // users table lives in the same core DB; the join degrades gracefully
    // (savedByName = null) for system saves or deleted users.
    const rows = await getAll(
        `SELECT av.id, av.automation_id, av.version, av.saved_by_user_id, av.saved_at, av.change_summary,
                u."displayName" AS u_display_name, u."firstName" AS u_first_name,
                u."lastName" AS u_last_name, u.username AS u_username
           FROM automation_versions av
           LEFT JOIN users u ON u.id = av.saved_by_user_id
          WHERE av.automation_id = $1
          ORDER BY av.version DESC`,
        [automationId],
    );
    return rows.map(r => ({
        id: r.id, automationId: r.automation_id, version: r.version,
        savedByUserId: r.saved_by_user_id, savedAt: r.saved_at,
        changeSummary: r.change_summary || null,
        savedByName: resolveVersionAuthorName(r),
    }));
}

/** Best display name for a version author, given the joined user columns. */
function resolveVersionAuthorName(r) {
    if (r.u_display_name) return r.u_display_name;
    const full = [r.u_first_name, r.u_last_name].filter(Boolean).join(' ').trim();
    if (full) return full;
    return r.u_username || null;
}

/**
 * Fetch one version by id (the version row contains a JSONB definition).
 * Used by the restore endpoint to load the historical definition before
 * we apply it through the regular updateAutomation path (which also
 * validates and bumps the version counter).
 */
async function getVersion(versionId) {
    await initDB();
    const r = await getOne(
        'SELECT id, automation_id, version, definition_json, saved_by_user_id, saved_at FROM automation_versions WHERE id = $1',
        [versionId],
    );
    if (!r) return null;
    return {
        id: r.id,
        automationId: r.automation_id,
        version: r.version,
        definition: typeof r.definition_json === 'string' ? safeParse(r.definition_json, {}) : (r.definition_json || {}),
        savedByUserId: r.saved_by_user_id,
        savedAt: r.saved_at,
    };
}

// Definition snapshot for a specific (automation, version). Run history uses
// this to render each run with the steps as they were AT RUN TIME rather than
// the current definition. Returns the parsed definition, or null when that
// version wasn't snapshotted (e.g. legacy rows from before version seeding).
async function getVersionDefinition(automationId, versionNumber) {
    await initDB();
    const v = Number(versionNumber);
    if (!automationId || !Number.isInteger(v)) return null;
    const r = await getOne(
        'SELECT definition_json FROM automation_versions WHERE automation_id = $1 AND version = $2 ORDER BY saved_at DESC LIMIT 1',
        [automationId, v],
    );
    if (!r) return null;
    return typeof r.definition_json === 'string' ? safeParse(r.definition_json, null) : (r.definition_json || null);
}

module.exports = { listVersions, getVersion, getVersionDefinition };
