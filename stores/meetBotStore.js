/**
 * Meet Bot Store — PostgreSQL-backed session tracking for the Google Meet bot.
 *
 * Tracks bot sessions: joining, recording, processing, completed, failed.
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');

let initialized = false;

async function initDB() {
    if (initialized) return;

    await exec(`
        CREATE TABLE IF NOT EXISTS meet_bot_sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            meet_link TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT 'Untitled Meeting',
            status TEXT NOT NULL DEFAULT 'pending',
            audio_path TEXT DEFAULT '',
            transcription_id TEXT DEFAULT '',
            error TEXT DEFAULT '',
            platform TEXT DEFAULT 'google',
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ended_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        ALTER TABLE meet_bot_sessions ADD COLUMN IF NOT EXISTS platform TEXT DEFAULT 'google';

        CREATE INDEX IF NOT EXISTS idx_meet_bot_user ON meet_bot_sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_meet_bot_status ON meet_bot_sessions(status);
        CREATE INDEX IF NOT EXISTS idx_meet_bot_created ON meet_bot_sessions(created_at DESC);
    `);

    initialized = true;
}

async function createSession(userId, meetLink, title, platform = 'google') {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO meet_bot_sessions (id, user_id, meet_link, title, platform, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [id, userId, meetLink, title || 'Untitled Meeting', platform]
    );
    return { id, userId, meetLink, title: title || 'Untitled Meeting', platform, status: 'pending' };
}

async function updateSession(id, updates) {
    await initDB();
    const fields = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
        const col = key.replace(/([A-Z])/g, '_$1').toLowerCase(); // camelCase → snake_case
        fields.push(`${col} = $${idx}`);
        values.push(value);
        idx++;
    }

    if (fields.length === 0) return;
    values.push(id);
    await run(`UPDATE meet_bot_sessions SET ${fields.join(', ')} WHERE id = $${idx}`, values);
}

async function getSession(id) {
    await initDB();
    const row = await getOne('SELECT * FROM meet_bot_sessions WHERE id = $1', [id]);
    return row ? mapRow(row) : null;
}

async function getUserSessions(userId, limit = 20) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM meet_bot_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
        [userId, limit]
    );
    return rows.map(mapRow);
}

async function deleteSession(id) {
    await initDB();
    await run('DELETE FROM meet_bot_sessions WHERE id = $1', [id]);
}

function mapRow(row) {
    return {
        id: row.id,
        userId: row.user_id,
        meetLink: row.meet_link,
        title: row.title,
        status: row.status,
        platform: row.platform || 'google',
        audioPath: row.audio_path || '',
        transcriptionId: row.transcription_id || '',
        error: row.error || '',
        startedAt: row.started_at,
        endedAt: row.ended_at,
        createdAt: row.created_at,
    };
}

module.exports = {
    createSession,
    updateSession,
    getSession,
    getUserSessions,
    deleteSession,
};
