/**
 * Per-conversation kb_search result cache.
 *
 * Scope: a single BeeFlow server process. Shared across tool calls in the same
 * conversation so that when the agent re-asks the same question later in the
 * conversation, we skip the whole retrieval stack (embedding → vector search →
 * reranker) and return the cached chunks directly.
 *
 * Why conversation-scoped instead of global:
 *   - Conversations usually have a tight topic; same query repeated = high hit rate.
 *   - Different conversations may have different agents with different KB subsets.
 *     A global cache would serve stale results across agents.
 *   - Memory stays bounded: expired conversations release their whole sub-cache.
 *
 * Size limits:
 *   - Max 64 entries per conversation (LRU)
 *   - Conversations inactive for 1h → their cache is garbage-collected
 */

const crypto = require('crypto');
const _metrics = require('../httpMetrics');

const MAX_ENTRIES_PER_CONV = 64;
const CONV_IDLE_TTL_MS = 60 * 60 * 1000; // 1 hour
const GC_INTERVAL_MS = 10 * 60 * 1000;   // 10 minutes

// conversationId → { lastAccess: number, entries: Map<key, value>, chunks: Map<chunk_id, {title,section,content,source_uri}> }
// entries Map order is LRU-ordered (most-recently-used last).
const _cache = new Map();

const MAX_CHUNKS_PER_CONV = 256;

function normalizeQuery(q) {
    return String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function buildKey(query, kbIds) {
    const sortedIds = Array.isArray(kbIds) ? [...kbIds].sort().join(',') : String(kbIds || '');
    const material = `${normalizeQuery(query)}|${sortedIds}`;
    return crypto.createHash('sha1').update(material).digest('hex');
}

function get(conversationId, query, kbIds) {
    if (!conversationId) return null;
    const bucket = _cache.get(conversationId);
    if (!bucket) { _metrics.recordCache('kb_query', false); return null; }
    const key = buildKey(query, kbIds);
    const value = bucket.entries.get(key);
    if (!value) { _metrics.recordCache('kb_query', false); return null; }

    // Promote to LRU tail.
    bucket.entries.delete(key);
    bucket.entries.set(key, value);
    bucket.lastAccess = Date.now();
    _metrics.recordCache('kb_query', true);
    return value;
}

function set(conversationId, query, kbIds, result) {
    if (!conversationId) return;
    let bucket = _cache.get(conversationId);
    if (!bucket) {
        bucket = { lastAccess: Date.now(), entries: new Map() };
        _cache.set(conversationId, bucket);
    }
    const key = buildKey(query, kbIds);
    bucket.entries.set(key, result);
    bucket.lastAccess = Date.now();

    // Enforce per-conversation LRU cap.
    while (bucket.entries.size > MAX_ENTRIES_PER_CONV) {
        const oldestKey = bucket.entries.keys().next().value;
        bucket.entries.delete(oldestKey);
    }
}

/**
 * Explicitly drop a conversation's cache (e.g. when the user starts a "new chat").
 */
function invalidate(conversationId) {
    if (conversationId) _cache.delete(conversationId);
}

/**
 * Stash every chunk returned by a kb_search so a subsequent kb_fetch can
 * resolve full content by chunk_id without re-querying the DB / search-service.
 */
function setChunks(conversationId, chunks) {
    if (!conversationId || !Array.isArray(chunks)) return;
    let bucket = _cache.get(conversationId);
    if (!bucket) {
        bucket = { lastAccess: Date.now(), entries: new Map(), chunks: new Map() };
        _cache.set(conversationId, bucket);
    } else if (!bucket.chunks) {
        bucket.chunks = new Map();
    }
    for (const c of chunks) {
        if (!c?.chunk_id) continue;
        bucket.chunks.set(String(c.chunk_id), {
            title: c.title || c.source_uri || '',
            section: c.section || '',
            content: c.content || '',
            source_uri: c.source_uri || '',
        });
    }
    bucket.lastAccess = Date.now();

    // Cap memory per conversation.
    while (bucket.chunks.size > MAX_CHUNKS_PER_CONV) {
        const oldestKey = bucket.chunks.keys().next().value;
        bucket.chunks.delete(oldestKey);
    }
}

function getChunk(conversationId, chunkId) {
    if (!conversationId || !chunkId) return null;
    const bucket = _cache.get(conversationId);
    if (!bucket?.chunks) return null;
    const hit = bucket.chunks.get(String(chunkId));
    if (hit) bucket.lastAccess = Date.now();
    return hit || null;
}

function gc() {
    const cutoff = Date.now() - CONV_IDLE_TTL_MS;
    let dropped = 0;
    for (const [convId, bucket] of _cache) {
        if (bucket.lastAccess < cutoff) {
            _cache.delete(convId);
            dropped++;
        }
    }
    if (dropped > 0) {
        console.log(`[kbQueryCache] GC dropped ${dropped} idle conversation cache(s)`);
    }
}

setInterval(gc, GC_INTERVAL_MS).unref?.();

module.exports = { get, set, invalidate, setChunks, getChunk };
