/**
 * Runtime tool-shape cache.
 *
 * Each time the runner executes a real (non-dry-run) integration_action,
 * we record a *shape descriptor* of the actual return value, keyed by
 * (userId, toolName). The Builder agent reads this on its next turn and
 * prefers the real shape over the hand-curated outputSchemas.js entries.
 *
 * Storage: Redis (TTL 30d) when available; in-memory LRU fallback.
 *
 * Shapes are NOT actual data — they're field-name maps with type tags.
 * This means we never persist user content (PII, email bodies, etc.) to
 * the cache, only structural keys.
 */

const { getRedis } = require('../db');
const _metrics = require('../core/httpMetrics');

const REDIS_PREFIX = 'automation:shape:';
const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MEM_LIMIT = 500;
const _mem = new Map(); // key -> { shape, ts }

function cacheKey(userId, toolName) {
    return `${REDIS_PREFIX}${userId || 'anon'}:${toolName}`;
}

/**
 * Build a shape descriptor from a runtime value, recursively. Truncates
 * large arrays/objects so the descriptor stays compact and never leaks
 * actual content.
 */
function describeValue(value, depth = 0) {
    if (depth > 5) return '<deep>';
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') {
        // No content — just type + sample length
        return value.length > 200 ? 'long-string' : 'string';
    }
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (Array.isArray(value)) {
        if (value.length === 0) return 'array<empty>';
        const itemShape = describeValue(value[0], depth + 1);
        return { _array: itemShape, _length: value.length > 10 ? '10+' : value.length };
    }
    if (typeof value === 'object') {
        const out = {};
        const keys = Object.keys(value).slice(0, 30); // cap per object
        for (const k of keys) out[k] = describeValue(value[k], depth + 1);
        return out;
    }
    return typeof value;
}

/**
 * Record the shape of a tool's actual output. Best-effort: failures are
 * swallowed so a misbehaving cache never breaks a run.
 */
async function recordShape({ userId, toolName, output }) {
    try {
        if (!toolName || output == null) return;
        const shape = describeValue(output);
        const payload = JSON.stringify({ shape, recordedAt: Date.now() });
        const key = cacheKey(userId, toolName);
        const r = getRedis();
        if (r && r.status === 'ready') {
            await r.set(key, payload, 'EX', TTL_SECONDS);
        } else {
            // LRU-ish: drop oldest when over the cap
            if (_mem.size >= MEM_LIMIT) {
                const firstKey = _mem.keys().next().value;
                _mem.delete(firstKey);
            }
            _mem.set(key, { shape, ts: Date.now() });
        }
    } catch (e) {
        console.warn('[shapeCache] recordShape failed:', e.message);
    }
}

/**
 * Read the most recent shape for (userId, toolName). Returns the shape
 * descriptor or null if not cached.
 */
async function getShape({ userId, toolName }) {
    try {
        const key = cacheKey(userId, toolName);
        const r = getRedis();
        if (r && r.status === 'ready') {
            const raw = await r.get(key);
            if (!raw) { _metrics.recordCache('shape', false); return null; }
            try { _metrics.recordCache('shape', true); return JSON.parse(raw).shape; } catch { return null; }
        }
        const cached = _mem.get(key);
        _metrics.recordCache('shape', !!cached);
        return cached ? cached.shape : null;
    } catch {
        return null;
    }
}

/**
 * Render a shape descriptor as a one-line text hint for the AI.
 */
function renderShapeHint(shape) {
    if (!shape) return null;
    const flat = (v, prefix = '') => {
        if (v && typeof v === 'object' && v._array !== undefined) {
            const inner = typeof v._array === 'object'
                ? Object.keys(v._array).join(', ')
                : v._array;
            return `${prefix} array of { ${inner} }`;
        }
        if (typeof v === 'object' && v !== null) {
            const parts = Object.entries(v).map(([k, vv]) => {
                if (vv && typeof vv === 'object' && vv._array !== undefined) {
                    const inner = typeof vv._array === 'object'
                        ? Object.keys(vv._array).join(', ')
                        : vv._array;
                    return `${k}: array of { ${inner} }`;
                }
                if (typeof vv === 'object' && vv !== null) {
                    return `${k}: { ${Object.keys(vv).join(', ')} }`;
                }
                return `${k}: ${vv}`;
            });
            return parts.join('; ');
        }
        return String(v);
    };
    return flat(shape);
}

module.exports = { recordShape, getShape, renderShapeHint, describeValue };
