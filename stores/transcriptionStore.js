/**
 * Transcription Store — PostgreSQL-backed meeting transcription history.
 *
 * Stores transcription results (per-user) so they can be listed,
 * viewed, renamed, and deleted from the Meeting Notes page.
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
            title TEXT NOT NULL DEFAULT 'Untitled Transcription',
            file_name TEXT,
            language TEXT DEFAULT 'nl',
            duration_seconds INTEGER DEFAULT 0,
            speaker_count INTEGER DEFAULT 0,
            segment_count INTEGER DEFAULT 0,
            shared_with JSONB DEFAULT '[]'::jsonb,
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

    // Migration: add columns if table existed before these features
    try {
        await exec(`ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS shared_with JSONB DEFAULT '[]'::jsonb`);
        await exec(`ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS summary TEXT DEFAULT ''`);
        await exec(`ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'completed'`);
        await exec(`ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS audio_path TEXT DEFAULT ''`);
        await exec(`ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'voxtral'`);
        await exec(`CREATE INDEX IF NOT EXISTS idx_transcriptions_shared ON transcriptions USING GIN (shared_with)`);
    } catch (e) {
        // Column might already exist, that's fine
    }

    initialized = true;
    console.log('[TranscriptionStore] PostgreSQL initialized');
}

initDB().catch(err => console.error('[TranscriptionStore] Init error:', err.message));

// ── CRUD ─────────────────────────────────────────────────

async function createTranscription({ userId, title, fileName, language, durationSeconds, speakerCount, segmentCount, fullText, transcript, segments, speakers, summary, status, audioPath, provider }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO transcriptions (id, user_id, title, file_name, language, duration_seconds, speaker_count, segment_count, full_text, transcript, segments, speakers, summary, status, audio_path, provider)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [id, userId, title || fileName || 'Untitled', fileName, language || 'nl', durationSeconds || 0, speakerCount || 0, segmentCount || 0, fullText || '', transcript || '', JSON.stringify(segments || []), JSON.stringify(speakers || []), summary || '', status || 'completed', audioPath || '', provider || 'voxtral']
    );
    console.log(`[TranscriptionStore] Created transcription "${title}" (${status || 'completed'}) via ${provider || 'voxtral'} for user ${userId}`);
    return { id, userId, title, fileName, language, durationSeconds, speakerCount, segmentCount, status: status || 'completed', provider: provider || 'voxtral', createdAt: new Date().toISOString() };
}

async function getTranscriptions(userId, { limit = 50, offset = 0 } = {}) {
    await initDB();
    // Show own transcriptions + ones shared with this user
    const rows = await getAll(
        `SELECT id, user_id, title, file_name, language, duration_seconds, speaker_count, segment_count, shared_with, created_at, updated_at
         FROM transcriptions
         WHERE user_id = $1 OR shared_with @> $4::jsonb
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [userId, limit, offset, JSON.stringify([userId])]
    );
    return rows.map(r => ({ ...mapRow(r), isOwner: r.user_id === userId, ownerId: r.user_id }));
}

async function getTranscription(id, userId) {
    await initDB();
    // Allow access if owner OR shared with
    const r = await getOne(
        `SELECT * FROM transcriptions WHERE id = $1 AND (user_id = $2 OR shared_with @> $3::jsonb)`,
        [id, userId, JSON.stringify([userId])]
    );
    if (!r) return null;
    return {
        ...mapRow(r),
        fullText: r.full_text || '',
        transcript: r.transcript || '',
        summary: r.summary || '',
        audioPath: r.audio_path || '',
        segments: typeof r.segments === 'string' ? JSON.parse(r.segments) : (r.segments || []),
        speakers: typeof r.speakers === 'string' ? JSON.parse(r.speakers) : (r.speakers || []),
        sharedWith: typeof r.shared_with === 'string' ? JSON.parse(r.shared_with) : (r.shared_with || []),
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
    if (updates.sharedWith !== undefined) { setClauses.push(`shared_with = $${idx++}`); params.push(JSON.stringify(updates.sharedWith)); }

    if (setClauses.length === 0) return false;
    setClauses.push(`updated_at = NOW()`);
    params.push(id, userId);
    const { rowCount } = await run(
        `UPDATE transcriptions SET ${setClauses.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}`,
        params
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
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

module.exports = {
    createTranscription,
    getTranscriptions,
    getTranscription,
    updateTranscription,
    deleteTranscription,
};
