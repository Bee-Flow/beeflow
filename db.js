/**
 * Shared Database Connections — PostgreSQL + Redis
 *
 *   - PostgreSQL via `pg` Pool for persistent data (beeflow_core)
 *   - Redis via `ioredis` for caching, rate limits, ephemeral state
 *     (session store uses a separate `node-redis` client in index.js)
 *
 * All stores should import { pool, getRedis, ... } from '../db';
 *
 * Pool sizing rationale for 50 active users:
 *   - max:40  — allows concurrent AI streaming (long-held connections) +
 *               regular CRUD queries without timeouts.
 *   - statement_timeout:30s — kills runaway queries before they occupy
 *               a connection slot indefinitely.
 *   - idle_in_transaction_session_timeout:60s — guards against hung
 *               transactions that block pool slots.
 *   - application_name — visible in pg_stat_activity for monitoring.
 */

const { Pool } = require('pg');
const Redis = require('ioredis');

// ── PostgreSQL ──────────────────────────────────────────
// Core database for users, agents, configs, conversations, etc.
const pool = new Pool({
    connectionString: process.env.CORE_DATABASE_URL
        || 'postgresql://beeflow:beeflow@localhost:5432/beeflow_core',
    // 40 connections: comfortably handles 50 concurrent users with AI
    // streaming (which holds connections open for 30–120 s each).
    max: 40,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // Kill queries that run longer than 30 s — prevents stuck queries
    // from holding a pool slot and blocking other users.
    statement_timeout: 30000,
    // Kill transactions left open for > 60 s (e.g. a crashed request
    // that never committed/rolled back).
    idle_in_transaction_session_timeout: 60000,
    // Visible in pg_stat_activity so you can identify beeflow connections.
    application_name: 'beeflow-server',
});

pool.on('error', (err) => {
    console.error('[DB] Unexpected PG pool error:', err.message);
});

// ── Pool pressure monitoring ─────────────────────────────
// Log a warning when >10 queries are queued waiting for a free
// connection — an early signal that the pool is under pressure.
const POOL_WARN_THRESHOLD = 10;
let _poolWarnLogged = false;
setInterval(() => {
    const waiting = pool.waitingCount;
    if (waiting > POOL_WARN_THRESHOLD) {
        if (!_poolWarnLogged) {
            console.warn(`[DB] Pool pressure: ${waiting} queries waiting for a free connection (total=${pool.totalCount}, idle=${pool.idleCount}). Consider scaling.`);
            _poolWarnLogged = true;
        }
    } else {
        _poolWarnLogged = false; // reset so we warn again if it spikes again
    }
}, 5000).unref(); // unref so this timer doesn't keep the process alive

// ── Redis ───────────────────────────────────────────────
// Wrapped in an object so getRedis() always returns the current state,
// avoiding the export-by-value staleness bug with `let redis`.
const _redis = { client: null };

if (process.env.REDIS_URL) {
    try {
        _redis.client = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: 3,
            lazyConnect: true,
            retryStrategy(times) {
                if (times > 5) return null;
                return Math.min(times * 200, 2000);
            },
            // Scaleway managed Redis uses an internal CA — encryption stays on,
            // cert validation is scoped to this client only (not the whole
            // process). Set REDIS_TLS_STRICT=1 once a CA bundle is wired in.
            ...(process.env.REDIS_URL.startsWith('rediss://') ? {
                tls: { rejectUnauthorized: process.env.REDIS_TLS_STRICT === '1' }
            } : {})
        });
        _redis.client.on('error', (err) => {
            console.warn('[DB] Redis error:', err.message);
        });
        _redis.client.connect().catch(err => {
            console.warn('[DB] Redis connection failed:', err.message);
            _redis.client = null;
        });
    } catch (err) {
        console.warn('[DB] Redis unavailable:', err.message);
    }
} else {
    console.log('[DB] No REDIS_URL configured, Redis disabled');
}

/** Get the current Redis client (or null if unavailable). */
function getRedis() { return _redis.client; }

/** True when Redis is connected and ready for commands. */
function redisHealthy() { return _redis.client?.status === 'ready'; }

/** Gracefully disconnect Redis (call during shutdown). */
async function disconnectRedis() {
    if (_redis.client) {
        try { await _redis.client.quit(); } catch (_) { /* ignore */ }
        _redis.client = null;
    }
}

// ── Async Query Helpers ─────────────────────────────────

// Lightweight query instrumentation: records duration into httpMetrics and
// logs slow queries. We log ONLY a sanitized SQL prefix + the param COUNT —
// never param values, which can contain PII or secrets.
const metrics = require('./core/httpMetrics');
const DB_SLOW_MS = metrics.DB_SLOW_MS;

function _sanitizeSql(sql) {
    return String(sql).replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function _timedQuery(sql, params) {
    const start = process.hrtime.bigint();
    try {
        return await pool.query(sql, params);
    } finally {
        try {
            const ms = Number(process.hrtime.bigint() - start) / 1e6;
            metrics.recordQuery(ms);
            if (ms > DB_SLOW_MS) {
                console.warn(`[DB] Slow query ${ms.toFixed(0)}ms (params=${Array.isArray(params) ? params.length : 0}): ${_sanitizeSql(sql)}`);
            }
        } catch (_) { /* instrumentation must never break a query */ }
    }
}

/**
 * Execute a query (INSERT, UPDATE, DELETE, DDL).
 * @param {string} sql - SQL with $1, $2 placeholders
 * @param {any[]} params
 * @returns {Promise<{ rowCount: number, rows: any[] }>}
 */
async function run(sql, params = []) {
    return _timedQuery(sql, params);
}

/**
 * Get a single row.
 * @param {string} sql
 * @param {any[]} params
 * @returns {Promise<object|null>}
 */
async function getOne(sql, params = []) {
    const { rows } = await _timedQuery(sql, params);
    return rows[0] || null;
}

/**
 * Get all matching rows.
 * @param {string} sql
 * @param {any[]} params
 * @returns {Promise<object[]>}
 */
async function getAll(sql, params = []) {
    const { rows } = await _timedQuery(sql, params);
    return rows;
}

/**
 * Execute raw SQL (e.g., schema init).
 * Uses a PostgreSQL advisory lock for CREATE TABLE/ALTER TABLE statements
 * to prevent pg_type_typname_nsp_index race conditions on fresh databases.
 * @param {string} sql
 */
let _schemaQueue = Promise.resolve();
async function exec(sql) {
    // CREATE TABLE / ALTER TABLE statements must be serialized to prevent
    // PostgreSQL implicit row-type creation races on fresh DBs.
    // We use a JS-level queue + a dedicated client connection so we don't
    // exhaust the pool with concurrent DDL calls.
    if (sql.includes('CREATE TABLE') || sql.includes('ALTER TABLE') || sql.includes('CREATE INDEX')) {
        return new Promise((resolve, reject) => {
            _schemaQueue = _schemaQueue.then(async () => {
                const client = await pool.connect();
                try {
                    return await client.query(sql);
                } finally {
                    client.release();
                }
            }).then(resolve, reject);
        });
    }
    return pool.query(sql);
}

/**
 * Get a client from the pool for transactions.
 * Usage:
 *   const client = await getClient();
 *   try {
 *     await client.query('BEGIN');
 *     ... 
 *     await client.query('COMMIT');
 *   } catch (e) {
 *     await client.query('ROLLBACK');
 *     throw e;
 *   } finally {
 *     client.release();
 *   }
 */
async function getClient() {
    return pool.connect();
}

/**
 * Returns current pool statistics for health checks and monitoring.
 */
function getPoolStats() {
    return {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
    };
}

module.exports = {
    pool,
    getRedis,
    redisHealthy,
    disconnectRedis,
    run,
    getOne,
    getAll,
    exec,
    getClient,
    getPoolStats,
};
