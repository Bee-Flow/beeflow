/**
 * Notification Store — PostgreSQL-backed notifications for task outcomes.
 *
 * Categories:
 *   - info:     Task completed, items processed
 *   - heads_up: Items awaiting approval, unusual patterns
 *   - urgent:   Task failed, auth expired, errors
 *
 * Uses the shared pg Pool from db.js rather than creating its own pool —
 * this prevents a hidden connection leak where a private Pool would silently
 * consume up to 10 extra connections outside of monitoring.
 */

const crypto = require('crypto');
const { pool } = require('../db');

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    task_id TEXT,
    category TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    message TEXT DEFAULT '',
    read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_notifications_task ON notifications(task_id);
`;

let initialized = false;

async function initDB() {
    if (initialized) return;
    try {
        await pool.query(INIT_SQL);
        initialized = true;
        console.log('[NotificationStore] PostgreSQL initialized');
    } catch (err) {
        console.error('[NotificationStore] Init error:', err.message);
        throw err;
    }
}

// Auto-init on import
initDB().catch(err => console.error('[NotificationStore] Failed to init:', err.message));

// ── CRUD ──────────────────────────────────────────────

/**
 * Create a notification.
 * @param {{ userId: string, taskId?: string, category?: string, title: string, message?: string }} data
 */
async function createNotification({ userId, taskId, category = 'info', title, message = '' }) {
    await initDB();
    const id = crypto.randomUUID();
    const validCategories = ['info', 'heads_up', 'urgent', 'ai_task'];
    const cat = validCategories.includes(category) ? category : 'info';

    await pool.query(
        `INSERT INTO notifications (id, user_id, task_id, category, title, message)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, userId, taskId || null, cat, title, message]
    );
    console.log(`[NotificationStore] Created [${cat}]: "${title}" for user ${userId}`);
    return { id, userId, taskId, category: cat, title, message, read: false, created_at: new Date().toISOString() };
}

/**
 * Get notifications for a user.
 * @param {string} userId
 * @param {{ unreadOnly?: boolean, limit?: number }} options
 */
async function getNotifications(userId, { unreadOnly = false, limit = 50 } = {}) {
    await initDB();
    let query = 'SELECT * FROM notifications WHERE user_id = $1';
    const params = [userId];

    if (unreadOnly) {
        query += ' AND read = FALSE';
    }

    query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);

    const { rows } = await pool.query(query, params);
    return rows.map(r => ({
        ...r,
        created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    }));
}

/**
 * Get unread count for a user.
 */
async function getUnreadCount(userId) {
    await initDB();
    const { rows } = await pool.query(
        'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read = FALSE',
        [userId]
    );
    return rows[0]?.count || 0;
}

/**
 * Mark a single notification as read.
 */
async function markRead(id) {
    await initDB();
    const { rowCount } = await pool.query(
        'UPDATE notifications SET read = TRUE WHERE id = $1',
        [id]
    );
    return rowCount > 0;
}

/**
 * Mark all notifications as read for a user.
 */
async function markAllRead(userId) {
    await initDB();
    const { rowCount } = await pool.query(
        'UPDATE notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE',
        [userId]
    );
    return rowCount;
}

/**
 * Delete a notification.
 */
async function deleteNotification(id) {
    await initDB();
    const { rowCount } = await pool.query('DELETE FROM notifications WHERE id = $1', [id]);
    return rowCount > 0;
}

/**
 * Delete all notifications for a user (used during user deletion).
 */
async function deleteUserNotifications(userId) {
    await initDB();
    const { rowCount } = await pool.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
    if (rowCount > 0) console.log(`[NotificationStore] Deleted ${rowCount} notification(s) for user ${userId}`);
    return rowCount;
}

module.exports = {
    createNotification,
    getNotifications,
    getUnreadCount,
    markRead,
    markAllRead,
    deleteNotification,
    deleteUserNotifications,
};
