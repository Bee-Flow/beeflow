/**
 * Webpage DB Store — server-side SQLite engine for the Webpages feature.
 *
 * Each webpage has at most one SQLite database file (`data.db`) stored as a
 * blob in RustFS at the same prefix as the script files. This module owns the
 * live `better-sqlite3` handles: it lazy-loads the blob to a server-local file
 * on first access, runs queries in-process, then debounce-flushes the file
 * back to RustFS after writes.
 *
 *   ┌─ getHandle ─────────────┐
 *   │ load .db from RustFS    │
 *   │ → /tmp/beeflow-…/{id}.db│
 *   │ open with better-sqlite3│
 *   └────────┬────────────────┘
 *            │
 *   ┌────────▼─────────┐    write?    ┌──────────────────┐
 *   │ query / exec     │─── dirty ───▶│ scheduleFlush    │
 *   │ / batch / schema │              │ (5 s debounce)   │
 *   └──────────────────┘              └──────┬───────────┘
 *                                            │
 *                                ┌───────────▼─────────────┐
 *                                │ checkpoint WAL → upload │
 *                                │ to RustFS, write back   │
 *                                │ db_sha256 / db_size     │
 *                                └─────────────────────────┘
 *
 * Authorization is the caller's responsibility — this module never reaches
 * back to req.session. The userId argument is treated as a trust boundary:
 * the caller must have already verified the user owns the webpage.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const storageStore = require('./storageStore');
const { run } = require('../db');

const WORK_DIR = process.env.WEBPAGE_DB_WORK_DIR || path.join(os.tmpdir(), 'beeflow-webpage-dbs');
const FLUSH_DEBOUNCE_MS = 5000;
const MAX_OPEN_HANDLES = 32;
const MAX_SQL_BYTES = 500_000;
const MAX_RESULT_ROWS = 10_000;
const DB_SLOT = 'db';

// In-memory registry of open handles, keyed by webpageId.
// {
//   db: Database,
//   userId: string,
//   localPath: string,
//   lastAccess: number,
//   dirty: boolean,
//   flushTimer: NodeJS.Timeout | null,
//   flushing: Promise<void> | null,
// }
const handles = new Map();

let workDirReady = false;
async function ensureWorkDir() {
    if (workDirReady) return;
    await fsp.mkdir(WORK_DIR, { recursive: true });
    workDirReady = true;
}

function localPathFor(webpageId) {
    return path.join(WORK_DIR, `${webpageId}.db`);
}

function dbKey(userId, webpageId) {
    return storageStore.buildWebpageKey(userId, webpageId, DB_SLOT);
}

async function downloadIfExists(userId, webpageId, localPath) {
    if (!storageStore.isAvailable()) return false;
    try {
        const { stream } = await storageStore.streamFile(dbKey(userId, webpageId));
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        await fsp.writeFile(localPath, Buffer.concat(chunks));
        return true;
    } catch (err) {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return false;
        throw err;
    }
}

async function getHandle(userId, webpageId) {
    await ensureWorkDir();
    const existing = handles.get(webpageId);
    if (existing) {
        // Trust boundary: a different userId asking for the same webpageId
        // means an authorization bug upstream — refuse rather than serve it.
        if (existing.userId !== userId) {
            throw new Error('Webpage DB handle owned by another user — refusing to share');
        }
        existing.lastAccess = Date.now();
        return existing;
    }

    const localPath = localPathFor(webpageId);
    // Drop any stale local copy (and its rollback/WAL companions) from a
    // previous restore/eviction so we always start from the authoritative
    // RustFS state. We use journal_mode = DELETE below so the .db blob is
    // always self-contained — no -wal/-shm to upload — but earlier sessions
    // may have left stragglers if the process was killed mid-write.
    for (const ext of ['', '-journal', '-wal', '-shm']) {
        try { await fsp.unlink(localPath + ext); } catch (_) {}
    }
    await downloadIfExists(userId, webpageId, localPath);

    const db = new Database(localPath);
    // DELETE journaling keeps everything in a single .db file at rest — no
    // sidecar files to track between request lifetimes. This is strictly
    // single-process per webpage (the handle Map enforces it), so we don't
    // need WAL's concurrent-reader benefit.
    try { db.pragma('journal_mode = DELETE'); } catch (_) {}
    try { db.pragma('foreign_keys = ON'); } catch (_) {}

    const entry = {
        db,
        userId,
        localPath,
        lastAccess: Date.now(),
        dirty: false,
        flushTimer: null,
        flushing: null,
    };
    handles.set(webpageId, entry);
    await maybeEvict();
    return entry;
}

async function maybeEvict() {
    if (handles.size <= MAX_OPEN_HANDLES) return;
    const sorted = [...handles.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    const overflow = sorted.length - MAX_OPEN_HANDLES;
    for (let i = 0; i < overflow; i++) {
        const [wid, entry] = sorted[i];
        try {
            if (entry.dirty) await flushNow(wid);
        } catch (e) {
            console.warn(`[WebpageDB] Evict flush failed for ${wid}:`, e.message);
        }
        try { entry.db.close(); } catch (_) {}
        if (entry.flushTimer) clearTimeout(entry.flushTimer);
        handles.delete(wid);
    }
}

function scheduleFlush(webpageId) {
    const entry = handles.get(webpageId);
    if (!entry) return;
    entry.dirty = true;
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    entry.flushTimer = setTimeout(() => {
        entry.flushTimer = null;
        flushNow(webpageId).catch(err =>
            console.error(`[WebpageDB] Background flush failed for ${webpageId}:`, err.message));
    }, FLUSH_DEBOUNCE_MS);
}

/**
 * Force-flush the on-disk DB file back to RustFS and update Postgres metadata.
 * Coalesces concurrent callers onto a single in-flight upload.
 */
async function flushNow(webpageId) {
    const entry = handles.get(webpageId);
    if (!entry) return;
    if (entry.flushing) return entry.flushing;

    entry.flushing = (async () => {
        try {
            const buf = await fsp.readFile(entry.localPath);
            const sha = crypto.createHash('sha256').update(buf).digest('hex');
            if (storageStore.isAvailable()) {
                await storageStore.uploadFile(dbKey(entry.userId, webpageId), buf, 'application/vnd.sqlite3');
            }
            await run(
                'UPDATE webpages SET db_sha256 = $1, db_size = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4',
                [sha, buf.length, webpageId, entry.userId]
            );
            entry.dirty = false;
        } finally {
            entry.flushing = null;
        }
    })();
    return entry.flushing;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Run a read-only SELECT. Errors if the SQL isn't read-only (per
 * better-sqlite3's `prepare().readonly` check) so write paths can't sneak
 * in via the query endpoint.
 */
async function query(userId, webpageId, sql, params = []) {
    validateSql(sql);
    const entry = await getHandle(userId, webpageId);
    const stmt = entry.db.prepare(sql);
    if (!stmt.readonly) {
        throw new Error('query() refuses to run a statement that mutates the database — use exec() instead');
    }
    const safeParams = normalizeParams(params);
    const rows = safeParams.length ? stmt.all(...safeParams) : stmt.all();
    if (rows.length > MAX_RESULT_ROWS) {
        rows.length = MAX_RESULT_ROWS;
    }
    const columns = (stmt.columns?.() || []).map(c => c.name);
    return { rows, columns, truncated: rows.length === MAX_RESULT_ROWS };
}

/**
 * Run a write or DDL statement. With `params` empty, accepts multi-statement
 * SQL (e.g. several CREATE TABLEs at once) via `db.exec`. With `params`, runs
 * a single prepared statement and returns `{ changes, lastInsertRowid }`.
 */
async function exec(userId, webpageId, sql, params = []) {
    validateSql(sql);
    const entry = await getHandle(userId, webpageId);
    const safeParams = normalizeParams(params);

    let result;
    if (safeParams.length === 0 && /;\s*\S/.test(sql.trim())) {
        // Multi-statement script (no params): use db.exec which doesn't
        // return per-statement counts but can run several statements.
        entry.db.exec(sql);
        result = { changes: 0, lastInsertRowid: 0, multi: true };
    } else {
        const r = entry.db.prepare(sql).run(...safeParams);
        result = {
            changes: r.changes,
            lastInsertRowid: typeof r.lastInsertRowid === 'bigint' ? Number(r.lastInsertRowid) : r.lastInsertRowid,
        };
    }
    scheduleFlush(webpageId);
    return result;
}

/**
 * Run a series of statements in a single transaction. Each statement is
 * `{ sql, params? }`. Returns an array of per-statement results.
 */
async function batch(userId, webpageId, statements) {
    if (!Array.isArray(statements) || statements.length === 0) {
        throw new Error('batch() requires a non-empty statements array');
    }
    if (statements.length > 500) {
        throw new Error('batch() supports at most 500 statements per call');
    }
    const entry = await getHandle(userId, webpageId);
    const tx = entry.db.transaction((stmts) => {
        const results = [];
        for (const s of stmts) {
            validateSql(s?.sql);
            const params = normalizeParams(s?.params);
            const stmt = entry.db.prepare(s.sql);
            if (stmt.readonly) {
                const rows = params.length ? stmt.all(...params) : stmt.all();
                results.push({ rows: rows.slice(0, MAX_RESULT_ROWS) });
            } else {
                const r = params.length ? stmt.run(...params) : stmt.run();
                results.push({
                    changes: r.changes,
                    lastInsertRowid: typeof r.lastInsertRowid === 'bigint' ? Number(r.lastInsertRowid) : r.lastInsertRowid,
                });
            }
        }
        return results;
    });
    const results = tx(statements);
    scheduleFlush(webpageId);
    return results;
}

/**
 * Inspect the schema — tables, their columns, and column types. Useful for
 * the AI to ground its SQL on the actual structure before generating queries.
 */
async function schema(userId, webpageId) {
    const entry = await getHandle(userId, webpageId);
    const tables = entry.db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all();
    const out = [];
    for (const t of tables) {
        const cols = entry.db.prepare(`PRAGMA table_info(${quoteIdent(t.name)})`).all();
        out.push({
            name: t.name,
            sql: t.sql,
            columns: cols.map(c => ({
                name: c.name,
                type: c.type,
                notNull: !!c.notnull,
                defaultValue: c.dflt_value,
                primaryKey: !!c.pk,
            })),
        });
    }
    return { tables: out };
}

/**
 * Wipe the DB entirely — close the handle, delete the local file and the
 * RustFS object, and zero the Postgres metadata.
 */
async function reset(userId, webpageId) {
    const entry = handles.get(webpageId);
    if (entry) {
        if (entry.userId !== userId) {
            throw new Error('Webpage DB handle owned by another user — refusing to reset');
        }
        if (entry.flushTimer) clearTimeout(entry.flushTimer);
        try { entry.db.close(); } catch (_) {}
        handles.delete(webpageId);
    }
    try { await fsp.unlink(localPathFor(webpageId)); } catch (_) {}
    if (storageStore.isAvailable()) {
        try { await storageStore.deleteFile(dbKey(userId, webpageId)); } catch (_) {}
    }
    await run(
        "UPDATE webpages SET db_sha256 = '', db_size = 0, updated_at = NOW() WHERE id = $1 AND user_id = $2",
        [webpageId, userId]
    );
}

/**
 * Force any pending writes to RustFS and close the local handle. Used before
 * version snapshotting so the snapshot includes everything the user's done.
 */
async function flush(userId, webpageId) {
    const entry = handles.get(webpageId);
    if (!entry) return;
    if (entry.userId !== userId) {
        throw new Error('Webpage DB handle owned by another user — refusing to flush');
    }
    if (entry.flushTimer) {
        clearTimeout(entry.flushTimer);
        entry.flushTimer = null;
    }
    // Loop: a write that lands during an in-flight flush re-marks dirty, and
    // we want flush() to only return once everything's actually on RustFS.
    while (entry.dirty || entry.flushing) {
        await flushNow(webpageId);
    }
}

/**
 * Drop the cached handle + local file without touching RustFS. Used after a
 * version restore overwrites the RustFS object out-of-band so the next access
 * re-downloads the restored bytes.
 */
async function invalidate(webpageId) {
    const entry = handles.get(webpageId);
    if (entry) {
        if (entry.flushTimer) clearTimeout(entry.flushTimer);
        // If a flush is in flight, let it finish so we don't tear it down
        // mid-upload — but we'll still drop the handle afterward.
        if (entry.flushing) {
            try { await entry.flushing; } catch (_) {}
        }
        try { entry.db.close(); } catch (_) {}
        handles.delete(webpageId);
    }
    try { await fsp.unlink(localPathFor(webpageId)); } catch (_) {}
}

/**
 * Flush all dirty handles and close everything. Wire to SIGINT/SIGTERM so we
 * don't lose recent writes on a graceful shutdown.
 */
async function closeAll() {
    const ids = [...handles.keys()];
    for (const wid of ids) {
        const entry = handles.get(wid);
        if (!entry) continue;
        try {
            if (entry.flushTimer) clearTimeout(entry.flushTimer);
            if (entry.dirty) await flushNow(wid);
        } catch (e) {
            console.warn(`[WebpageDB] Shutdown flush failed for ${wid}:`, e.message);
        }
        try { entry.db.close(); } catch (_) {}
        handles.delete(wid);
    }
}

// ── Helpers ─────────────────────────────────────────────────────────

function validateSql(sql) {
    if (typeof sql !== 'string' || !sql.trim()) {
        throw new Error('sql must be a non-empty string');
    }
    if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) {
        throw new Error(`sql is larger than the ${MAX_SQL_BYTES}-byte limit`);
    }
}

function normalizeParams(params) {
    if (params === undefined || params === null) return [];
    if (!Array.isArray(params)) {
        throw new Error('params must be an array (positional ? placeholders)');
    }
    return params.map(v => {
        if (v === null || v === undefined) return null;
        const t = typeof v;
        if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') return v;
        if (Buffer.isBuffer(v)) return v;
        // Objects/arrays are not natively supported by SQLite — stringify so
        // the caller doesn't have to remember to JSON.stringify themselves.
        return JSON.stringify(v);
    });
}

function quoteIdent(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
}

// Best-effort flush on shutdown. The handlers must not throw or the process
// will exit non-zero on SIGTERM.
let shutdownWired = false;
function wireShutdown() {
    if (shutdownWired) return;
    shutdownWired = true;
    const handler = () => {
        closeAll().catch(() => {}).finally(() => {
            // Don't process.exit() — let the rest of the app's shutdown finish.
        });
    };
    process.on('SIGTERM', handler);
    process.on('SIGINT', handler);
    process.on('beforeExit', handler);
}
wireShutdown();

module.exports = {
    query,
    exec,
    batch,
    schema,
    reset,
    flush,
    invalidate,
    closeAll,
    // Test-only
    _handles: handles,
};
