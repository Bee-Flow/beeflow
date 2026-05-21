/**
 * Transcription Store — PostgreSQL-backed meeting transcription history.
 *
 * Stores transcription results so they can be listed, viewed, renamed,
 * deleted, and published to org groups (mirrors the KB / agent publish
 * model). Read access:
 *   - Owner always
 *   - Published to org: same-org member sees it
 *   - Published with shared_groups: only members of one of those groups
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');

let initialized = false;

async function initDB() {
    if (initialized) return;

    await exec(`
        CREATE TABLE IF NOT EXISTS transcriptions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            organization_id TEXT,
            title TEXT NOT NULL DEFAULT 'Untitled Transcription',
            file_name TEXT,
            language TEXT DEFAULT 'nl',
            duration_seconds INTEGER DEFAULT 0,
            speaker_count INTEGER DEFAULT 0,
            segment_count INTEGER DEFAULT 0,
            shared_with JSONB DEFAULT '[]'::jsonb,
            is_published BOOLEAN DEFAULT false,
            shared_groups JSONB DEFAULT '[]'::jsonb,
            full_text TEXT,
            transcript TEXT,
            segments JSONB DEFAULT '[]'::jsonb,
            speakers JSONB DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_transcriptions_user ON transcriptions(user_id);
        CREATE INDEX IF NOT EXISTS idx_transcriptions_created ON transcriptions(created_at DESC);
    `);

    // Migrations — additive, idempotent. Old deployments may pre-date some columns.
    try {
        await exec(`ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS shared_with JSONB DEFAULT '[]'::jsonb`);
        await exec(`ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS summary TEXT DEFAULT ''`);
        await exec(`ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'completed'`);
        await exec(`ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS audio_path TEXT DEFAULT ''`);
        await exec(`ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'voxtral'`);
        await exec(`ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS action_items JSONB DEFAULT '[]'::jsonb`);
        await exec(`ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb`);
        await exec(`ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS organization_id TEXT`);
        await exec(`ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS is_published BOOLEAN DEFAULT false`);
        await exec(`ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS shared_groups JSONB DEFAULT '[]'::jsonb`);
        await exec(`CREATE INDEX IF NOT EXISTS idx_transcriptions_shared ON transcriptions USING GIN (shared_with)`);
        await exec(`CREATE INDEX IF NOT EXISTS idx_transcriptions_org ON transcriptions(organization_id)`);
        await exec(`CREATE INDEX IF NOT EXISTS idx_transcriptions_published ON transcriptions(is_published) WHERE is_published = true`);
        await exec(`CREATE INDEX IF NOT EXISTS idx_transcriptions_shared_groups ON transcriptions USING GIN (shared_groups)`);
    } catch (e) {
        // Column might already exist — fine.
    }

    // One-shot cleanup of the retired meeting-bot table + secrets. Idempotent.
    try {
        await exec(`DROP TABLE IF EXISTS meet_bot_sessions`);
    } catch (_) {}

    initialized = true;
    console.log('[TranscriptionStore] PostgreSQL initialized');
}

initDB().catch(err => console.error('[TranscriptionStore] Init error:', err.message));

// ── CRUD ─────────────────────────────────────────────────

async function createTranscription({ userId, organizationId, title, fileName, language, durationSeconds, speakerCount, segmentCount, fullText, transcript, segments, speakers, summary, status, audioPath, provider, actionItems }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO transcriptions (id, user_id, organization_id, title, file_name, language, duration_seconds, speaker_count, segment_count, full_text, transcript, segments, speakers, summary, status, audio_path, provider, action_items)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [id, userId, organizationId || null, title || fileName || 'Untitled', fileName, language || 'nl', durationSeconds || 0, speakerCount || 0, segmentCount || 0, fullText || '', transcript || '', JSON.stringify(segments || []), JSON.stringify(speakers || []), summary || '', status || 'completed', audioPath || '', provider || 'voxtral', JSON.stringify(actionItems || [])]
    );
    console.log(`[TranscriptionStore] Created transcription "${title}" (${status || 'completed'}) via ${provider || 'voxtral'} for user ${userId}`);
    return { id, userId, organizationId: organizationId || null, title, fileName, language, durationSeconds, speakerCount, segmentCount, status: status || 'completed', provider: provider || 'voxtral', createdAt: new Date().toISOString() };
}

async function getTranscriptions(userId, { limit = 50, offset = 0, orgIds = [], userGroupIds = [], isSuperAdmin = false } = {}) {
    await initDB();
    // Super admins (resolveUserOrgIds === null) see every transcription
    // unconditionally — mirrors the bypass that exists in agents/KBs.
    if (isSuperAdmin) {
        const rows = await getAll(
            `SELECT id, user_id, organization_id, title, file_name, language, duration_seconds, speaker_count, segment_count,
                    shared_with, is_published, shared_groups, created_at, updated_at, provider, status,
                    LEFT(COALESCE(full_text, ''), 2000) AS full_text_snippet
             FROM transcriptions
             ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
            [limit, offset]
        );
        return rows.map(r => ({ ...mapRow(r), isOwner: r.user_id === userId, ownerId: r.user_id }));
    }
    // Normal user: own rows + legacy per-user shares + published-to-my-org rows.
    // We build the WHERE clause incrementally so an empty orgIds / userGroupIds
    // never reaches Postgres as ANY('{}'::text[]) / ?| ARRAY[]::text[] — both
    // of which the `pg` driver mishandles in some versions.
    const params = [userId, limit, offset, JSON.stringify([userId])];
    const clauses = [`user_id = $1`, `shared_with @> $4::jsonb`];
    if (Array.isArray(orgIds) && orgIds.length > 0) {
        params.push(orgIds);
        const orgParamIdx = params.length;
        if (Array.isArray(userGroupIds) && userGroupIds.length > 0) {
            params.push(userGroupIds);
            const groupParamIdx = params.length;
            clauses.push(
                `(is_published = true AND organization_id = ANY($${orgParamIdx}::text[]) AND (shared_groups = '[]'::jsonb OR shared_groups ?| $${groupParamIdx}::text[]))`
            );
        } else {
            clauses.push(
                `(is_published = true AND organization_id = ANY($${orgParamIdx}::text[]) AND shared_groups = '[]'::jsonb)`
            );
        }
    }
    const rows = await getAll(
        `SELECT id, user_id, organization_id, title, file_name, language, duration_seconds, speaker_count, segment_count,
                shared_with, is_published, shared_groups, created_at, updated_at, provider, status,
                LEFT(COALESCE(full_text, ''), 2000) AS full_text_snippet
         FROM transcriptions
         WHERE ${clauses.join(' OR ')}
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        params
    );
    return rows.map(r => ({ ...mapRow(r), isOwner: r.user_id === userId, ownerId: r.user_id }));
}

async function getTranscription(id, userId, { orgIds = [], userGroupIds = [], isSuperAdmin = false } = {}) {
    await initDB();
    if (isSuperAdmin) {
        const r = await getOne(`SELECT * FROM transcriptions WHERE id = $1`, [id]);
        if (!r) return null;
        return shapeRow(r, userId);
    }
    const params = [id, userId, JSON.stringify([userId])];
    const clauses = [`user_id = $2`, `shared_with @> $3::jsonb`];
    if (Array.isArray(orgIds) && orgIds.length > 0) {
        params.push(orgIds);
        const orgParamIdx = params.length;
        if (Array.isArray(userGroupIds) && userGroupIds.length > 0) {
            params.push(userGroupIds);
            const groupParamIdx = params.length;
            clauses.push(
                `(is_published = true AND organization_id = ANY($${orgParamIdx}::text[]) AND (shared_groups = '[]'::jsonb OR shared_groups ?| $${groupParamIdx}::text[]))`
            );
        } else {
            clauses.push(
                `(is_published = true AND organization_id = ANY($${orgParamIdx}::text[]) AND shared_groups = '[]'::jsonb)`
            );
        }
    }
    const r = await getOne(
        `SELECT * FROM transcriptions WHERE id = $1 AND (${clauses.join(' OR ')})`,
        params
    );
    if (!r) return null;
    return shapeRow(r, userId);
}

function shapeRow(r, userId) {
    return {
        ...mapRow(r),
        fullText: r.full_text || '',
        transcript: r.transcript || '',
        summary: r.summary || '',
        audioPath: r.audio_path || '',
        segments: typeof r.segments === 'string' ? JSON.parse(r.segments) : (r.segments || []),
        speakers: typeof r.speakers === 'string' ? JSON.parse(r.speakers) : (r.speakers || []),
        sharedWith: typeof r.shared_with === 'string' ? JSON.parse(r.shared_with) : (r.shared_with || []),
        sharedGroups: typeof r.shared_groups === 'string' ? JSON.parse(r.shared_groups) : (r.shared_groups || []),
        isPublished: !!r.is_published,
        organizationId: r.organization_id || null,
        actionItems: typeof r.action_items === 'string' ? JSON.parse(r.action_items) : (r.action_items || []),
        tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags || []),
        isOwner: r.user_id === userId,
        ownerId: r.user_id,
    };
}

async function updateTranscription(id, userId, updates) {
    await initDB();
    const setClauses = [];
    const params = [];
    let idx = 1;

    if (updates.title !== undefined) { setClauses.push(`title = $${idx++}`); params.push(updates.title); }
    if (updates.actionItems !== undefined) { setClauses.push(`action_items = $${idx++}`); params.push(JSON.stringify(updates.actionItems)); }
    if (updates.tags !== undefined) { setClauses.push(`tags = $${idx++}`); params.push(JSON.stringify(updates.tags)); }
    if (updates.summary !== undefined) { setClauses.push(`summary = $${idx++}`); params.push(updates.summary); }
    if (updates.speakers !== undefined) { setClauses.push(`speakers = $${idx++}`); params.push(JSON.stringify(updates.speakers)); }
    if (updates.segments !== undefined) {
        setClauses.push(`segments = $${idx++}`); params.push(JSON.stringify(updates.segments));
        setClauses.push(`speaker_count = $${idx++}`); params.push(new Set((updates.segments || []).map(s => s.speaker || s.speakerId)).size);
        setClauses.push(`segment_count = $${idx++}`); params.push((updates.segments || []).length);
    }
    if (updates.transcript !== undefined) { setClauses.push(`transcript = $${idx++}`); params.push(updates.transcript); }

    if (setClauses.length === 0) return false;
    setClauses.push(`updated_at = NOW()`);
    params.push(id, userId);
    const { rowCount } = await run(
        `UPDATE transcriptions SET ${setClauses.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}`,
        params
    );
    return rowCount > 0;
}

/**
 * Toggle publish state and shared groups for a transcription. Owner-only.
 * Mirrors `knowledgeBases.setPublished`.
 */
async function setPublished(id, ownerId, isPublished, sharedGroups) {
    await initDB();
    const groupsJson = JSON.stringify(Array.isArray(sharedGroups) ? sharedGroups : []);
    const { rowCount } = await run(
        `UPDATE transcriptions
         SET is_published = $3,
             shared_groups = $4,
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [id, ownerId, !!isPublished, groupsJson]
    );
    return rowCount > 0;
}

async function deleteTranscription(id, userId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM transcriptions WHERE id = $1 AND user_id = $2', [id, userId]);
    return rowCount > 0;
}

function mapRow(r) {
    return {
        id: r.id,
        title: r.title,
        fileName: r.file_name,
        language: r.language,
        durationSeconds: r.duration_seconds,
        speakerCount: r.speaker_count,
        segmentCount: r.segment_count,
        status: r.status || 'completed',
        provider: r.provider || 'voxtral',
        isPublished: !!r.is_published,
        sharedGroups: typeof r.shared_groups === 'string' ? JSON.parse(r.shared_groups || '[]') : (r.shared_groups || []),
        organizationId: r.organization_id || null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
        // Short transcript prefix surfaced for client-side search; only present
        // on list payloads (full text comes through getTranscription).
        ...(r.full_text_snippet !== undefined ? { transcriptSnippet: r.full_text_snippet || '' } : {}),
    };
}

module.exports = {
    createTranscription,
    getTranscriptions,
    getTranscription,
    updateTranscription,
    setPublished,
    deleteTranscription,
};
