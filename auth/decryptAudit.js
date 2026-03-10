/**
 * Decrypt Anomaly Detection
 * 
 * Tracks decrypt operations per user and alerts on suspicious patterns:
 * - Bulk decrypt (50+ ops/minute = potential data exfiltration)
 * - Rapid conversation scanning
 * 
 * Lightweight in-memory — resets on server restart (acceptable for alerting).
 */

const ALERT_THRESHOLD = 50;     // decrypts per minute before alerting
const WINDOW_MS = 60000;        // 1 minute sliding window
const CLEANUP_INTERVAL = 300000; // Clean old entries every 5 min

// Map<userId, { count: number, windowStart: number, alerted: boolean }>
const decryptCounts = new Map();

/**
 * Track a decrypt operation for a user.
 * Call this from decryptMessages or at the route level.
 * 
 * @param {string} userId
 * @param {string} [conversationId] - For logging context
 */
function trackDecrypt(userId, conversationId = null) {
    if (!userId) return;

    const now = Date.now();
    let entry = decryptCounts.get(userId);

    if (!entry || now - entry.windowStart > WINDOW_MS) {
        // New window
        entry = { count: 1, windowStart: now, alerted: false };
        decryptCounts.set(userId, entry);
        return;
    }

    entry.count++;

    if (entry.count >= ALERT_THRESHOLD && !entry.alerted) {
        entry.alerted = true;
        console.error(
            `[ALERT] Bulk decrypt detected: user ${userId} performed ${entry.count} decrypts in ` +
            `${Math.ceil((now - entry.windowStart) / 1000)}s` +
            (conversationId ? ` (last: ${conversationId})` : '')
        );
    }
}

/**
 * Get current decrypt stats for a user (for monitoring/admin endpoints).
 * @param {string} userId
 * @returns {{ count: number, windowStart: number } | null}
 */
function getDecryptStats(userId) {
    return decryptCounts.get(userId) || null;
}

// Periodic cleanup of stale entries
setInterval(() => {
    const now = Date.now();
    for (const [userId, entry] of decryptCounts) {
        if (now - entry.windowStart > WINDOW_MS * 2) {
            decryptCounts.delete(userId);
        }
    }
}, CLEANUP_INTERVAL);

module.exports = { trackDecrypt, getDecryptStats };
