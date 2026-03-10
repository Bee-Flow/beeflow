/**
 * Shared Database Connections — PostgreSQL + Redis
 *
 *   - PostgreSQL via `pg` Pool for persistent data (beeflow_core)
 *   - Redis via `ioredis` for caching, rate limits, ephemeral state
 *     (session store uses a separate `node-redis` client in index.js)
 *
 * All stores should import { pool, getRedis, ... } from '../db';
 */

const { Pool } = require('pg');
const Redis = require('ioredis');

// ── PostgreSQL ──────────────────────────────────────────
// Core database for users, agents, configs, conversations, etc.
const pool = new Pool({
    connectionString: process.env.CORE_DATABASE_URL
        || 'postgresql://beeflow:beeflow@localhost:5432/beeflow_core',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
    console.error('[DB] Unexpected PG pool error:', err.message);
});

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
            }
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

/**
 * Execute a query (INSERT, UPDATE, DELETE, DDL).
 * @param {string} sql - SQL with $1, $2 placeholders
 * @param {any[]} params
 * @returns {Promise<{ rowCount: number, rows: any[] }>}
 */
async function run(sql, params = []) {
    return pool.query(sql, params);
}

/**
 * Get a single row.
 * @param {string} sql
 * @param {any[]} params
 * @returns {Promise<object|null>}
 */
async function getOne(sql, params = []) {
    const { rows } = await pool.query(sql, params);
    return rows[0] || null;
}

/**
 * Get all matching rows.
 * @param {string} sql
 * @param {any[]} params
 * @returns {Promise<object[]>}
 */
async function getAll(sql, params = []) {
    const { rows } = await pool.query(sql, params);
    return rows;
}

/**
 * Execute raw SQL (e.g., schema init).
 * @param {string} sql
 */
async function exec(sql) {
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
};
