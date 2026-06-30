/**
 * webhooks.js — automationStore aggregate (§WS5, extracted verbatim).
 */

const crypto = require('crypto');
const { initDB, run, getOne, getAll, exec, getClient, pool } = require('./core');
const { rowToAutomation, rowToRun, rowToRunStep, safeParse, fromJsonb } = require('./rowMappers');

// ── Webhooks ──────────────────────────────────────────

async function createWebhook(automationId) {
    await initDB();
    // WS5.1 — the slug is the only auth on /webhook/:slug, so give new ones
    // 192 bits of entropy (was 96). Both lengths stay valid: TEXT PK with
    // exact lookup, so pre-existing 24-hex slugs keep working.
    const id = crypto.randomBytes(24).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    await run(
        `INSERT INTO automation_webhooks (id, automation_id, secret) VALUES ($1, $2, $3)`,
        [id, automationId, secret],
    );
    return { id, automationId, secret };
}

async function getWebhook(id) {
    await initDB();
    const r = await getOne('SELECT * FROM automation_webhooks WHERE id = $1', [id]);
    if (!r) return null;
    return { id: r.id, automationId: r.automation_id, secret: r.secret, allowMethods: r.allow_methods, lastSeenAt: r.last_seen_at };
}

async function getWebhooksForAutomation(automationId) {
    await initDB();
    const rows = await getAll('SELECT id, automation_id, allow_methods, last_seen_at, created_at FROM automation_webhooks WHERE automation_id = $1', [automationId]);
    return rows.map(r => ({ id: r.id, automationId: r.automation_id, allowMethods: r.allow_methods, lastSeenAt: r.last_seen_at, createdAt: r.created_at }));
}

async function touchWebhook(id) {
    await initDB();
    await run(`UPDATE automation_webhooks SET last_seen_at = NOW() WHERE id = $1`, [id]);
}

/**
 * Rotate the HMAC secret for a webhook. The webhook's URL stays the same;
 * only the secret used for signature verification changes — so any caller
 * still using the old secret immediately starts getting 401s, while a
 * newly-issued secret takes effect on the next inbound request.
 */
async function rotateWebhookSecret(webhookId, automationId) {
    await initDB();
    const newSecret = crypto.randomBytes(32).toString('hex');
    const { rowCount } = await run(
        `UPDATE automation_webhooks
            SET secret = $1
          WHERE id = $2 AND automation_id = $3`,
        [newSecret, webhookId, automationId],
    );
    if (rowCount === 0) return null;
    return { id: webhookId, automationId, secret: newSecret };
}

async function deleteWebhook(webhookId, automationId) {
    await initDB();
    const { rowCount } = await run(
        `DELETE FROM automation_webhooks WHERE id = $1 AND automation_id = $2`,
        [webhookId, automationId],
    );
    return rowCount > 0;
}

async function checkAndStoreNonce(nonce) {
    await initDB();
    // Garbage-collect old nonces (> 24h) opportunistically.
    await run(`DELETE FROM automation_webhook_seen_nonces WHERE seen_at < NOW() - INTERVAL '24 hours'`).catch(() => {});
    try {
        await run(`INSERT INTO automation_webhook_seen_nonces (nonce) VALUES ($1)`, [nonce]);
        return true;
    } catch {
        return false; // duplicate
    }
}

module.exports = { createWebhook, getWebhook, getWebhooksForAutomation, touchWebhook, rotateWebhookSecret, deleteWebhook, checkAndStoreNonce };
