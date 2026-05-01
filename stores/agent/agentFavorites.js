/**
 * Agent Favorites - Per-user favorited agents.
 * Replaces the legacy client-side localStorage `agentFavorites` so that
 * favorites sync across devices and survive cache clears.
 */

const { run, getAll } = require('../../db');
const { initDB } = require('./initSchema');

async function listFavorites(userId) {
    await initDB();
    const rows = await getAll(
        `SELECT agent_id FROM agent_favorites WHERE user_id = $1 ORDER BY created_at ASC`,
        [userId]
    );
    return rows.map(r => r.agent_id);
}

async function addFavorite(userId, agentId) {
    await initDB();
    await run(
        `INSERT INTO agent_favorites (user_id, agent_id) VALUES ($1, $2)
         ON CONFLICT (user_id, agent_id) DO NOTHING`,
        [userId, agentId]
    );
}

async function removeFavorite(userId, agentId) {
    await initDB();
    await run(
        `DELETE FROM agent_favorites WHERE user_id = $1 AND agent_id = $2`,
        [userId, agentId]
    );
}

module.exports = { listFavorites, addFavorite, removeFavorite };
