/**
 * Direct Conversations - Chat without an agent (direct LLM access)
 *
 * Phase 4: Dual-write architecture (same pattern as agentConversations.js).
 *   - Reads prefer conversation_messages table; fall back to messages_json blob.
 *   - Writes go to both; blob kept for rollback safety.
 */

const { v4: uuidv4 } = require('uuid');
const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./initSchema');
const convMessages = require('./conversationMessages');
const { decryptMessages } = require('./messageEncryption');
// Replace [email_N] / [phone_N] etc. tokens with the real values stored in
// the per-message tokenMap. Idempotent — messages without a tokenMap pass
// through unchanged. Only used on the UI-display read path; the LLM
// history loader passes restore=false so Claude keeps seeing tokens.
// Lazy-require inside the function: same circular-dep reason as
// azurePiiDetection.js→aiAgent — capturing a destructure at module load
// can grab a stale snapshot of the cycle's partial exports.
function _restoreTokensInMessages(messages) {
    if (!Array.isArray(messages)) return messages;
    const restoreTokens = require('../../core/azurePiiDetection').restoreTokens;
    if (typeof restoreTokens !== 'function') return messages;
    return messages.map(m => {
        if (m && m.role === 'user' && m.tokenMap && typeof m.content === 'string' && Object.keys(m.tokenMap).length > 0) {
            try {
                return { ...m, content: restoreTokens(m.content, m.tokenMap) };
            } catch (e) { /* fall through with original */ }
        }
        return m;
    });
}

async function createDirectConversation(userId, modelTier = 'fast') {
    await initDB();
    const id = uuidv4();
    await run("INSERT INTO direct_conversations (id, user_id, title, messages_json, model_tier, created_at, updated_at) VALUES ($1,$2,'New Chat','[]',$3,NOW(),NOW())", [id, userId, modelTier]);
    return { id, title: 'New Chat', messages: [], model_tier: modelTier };
}

async function getDirectConversation(id, userId, options = {}) {
    await initDB();
    // `restore` defaults to true: most callers (UI render, listings, search)
    // expect tokens already mapped back to real values. The LLM-history
    // loader in directChat.js passes `restore: false` so Claude continues
    // to see [email_N] tokens on follow-up turns.
    const restore = options.restore !== false;
    const row = await getOne('SELECT * FROM direct_conversations WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!row) return null;
    const meta = JSON.parse(row.meta_json || '{}');
    let messages = await _readDirectMessages(row);
    if (restore) messages = _restoreTokensInMessages(messages);
    return { ...row, messages, meta, ...meta };
}

async function updateDirectConversationMeta(id, userId, partial) {
    if (!partial || typeof partial !== 'object' || Object.keys(partial).length === 0) return false;
    await initDB();
    const existing = await getOne('SELECT meta_json FROM direct_conversations WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!existing) return false;
    let existingMeta = {};
    try { existingMeta = JSON.parse(existing.meta_json || '{}'); } catch (_) { /* noop */ }
    const merged = { ...existingMeta, ...partial };
    const { rowCount } = await run('UPDATE direct_conversations SET meta_json = $1 WHERE id = $2 AND user_id = $3', [JSON.stringify(merged), id, userId]);
    return rowCount > 0;
}

async function listDirectConversations(userId) {
    await initDB();
    return getAll('SELECT id, title, model_tier, project_id, pinned, labels_json, created_at, updated_at FROM direct_conversations WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
}

async function searchDirectConversations(userId, query, filters = {}, encryptionKey) {
    await initDB();

    const likeQuery = `%${query}%`;
    const lowerQuery = query.toLowerCase();

    const filterParams = [userId];
    let filterClauses = '';
    let filterIdx = 2;
    if (filters.startDate) { filterClauses += ` AND c.updated_at >= $${filterIdx++}`; filterParams.push(filters.startDate); }
    const likeIdx = filterIdx;

    // Strategy A: title OR migrated message content
    const stratA = await getAll(`
        SELECT DISTINCT
            c.id, c.user_id, c.title, c.updated_at, c.model_tier,
            c.messages_migrated
        FROM direct_conversations c
        LEFT JOIN conversation_messages cm
            ON cm.conversation_id = c.id
           AND cm.conversation_type = 'direct'
           AND c.messages_migrated = TRUE
        WHERE c.user_id = $1
          AND (c.title ILIKE $${likeIdx} OR cm.content ILIKE $${likeIdx})
          ${filterClauses}
        ORDER BY c.updated_at DESC
        LIMIT 50
    `, [...filterParams, likeQuery]);

    const results = [...stratA];
    const matchedIds = new Set(results.map(r => r.id));

    if (results.length < 50) {
        if (!encryptionKey) {
            const remaining = 50 - results.length;
            const stratB = await getAll(`
                SELECT
                    c.id, c.user_id, c.title, c.updated_at, c.model_tier,
                    c.messages_migrated
                FROM direct_conversations c
                WHERE c.user_id = $1
                  AND c.messages_migrated = FALSE
                  AND c.messages_json ILIKE $${likeIdx}
                  ${filterClauses}
                ORDER BY c.updated_at DESC
                LIMIT ${remaining}
            `, [...filterParams, likeQuery]);
            for (const r of stratB) {
                if (!matchedIds.has(r.id)) { results.push(r); matchedIds.add(r.id); }
            }
        } else {
            const encCandidates = await getAll(`
                SELECT
                    c.id, c.user_id, c.title, c.updated_at, c.model_tier,
                    c.messages_json, c.messages_migrated
                FROM direct_conversations c
                WHERE c.user_id = $1
                  AND c.messages_migrated = FALSE
                  ${filterClauses}
                ORDER BY c.updated_at DESC
                LIMIT 200
            `, filterParams);
            for (const conv of encCandidates) {
                if (matchedIds.has(conv.id) || results.length >= 50) break;
                try {
                    const decrypted = decryptMessages(conv.messages_json || '[]', encryptionKey, conv.id, userId);
                    if (decrypted.toLowerCase().includes(lowerQuery)) {
                        results.push({ ...conv, messages_json: decrypted });
                        matchedIds.add(conv.id);
                    }
                } catch (e) {
                    console.error('[DirectConversations] Search decrypt error:', e);
                }
            }
        }
    }

    return results
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
        .slice(0, 50)
        .map(r => ({
            id: r.id,
            user_id: r.user_id,
            title: r.title,
            updated_at: r.updated_at,
            model_tier: r.model_tier,
            kind: 'direct',
            agent_name: 'Direct Chat',
            agent_avatar: null,
        }));
}

async function pinDirectConversation(id, pinned, userId) {
    await initDB();
    const { rowCount } = await run('UPDATE direct_conversations SET pinned = $1 WHERE id = $2 AND user_id = $3', [!!pinned, id, userId]);
    return rowCount > 0;
}

async function setDirectConversationLabels(id, labels, userId) {
    await initDB();
    const { rowCount } = await run('UPDATE direct_conversations SET labels_json = $1 WHERE id = $2 AND user_id = $3', [JSON.stringify(labels), id, userId]);
    return rowCount > 0;
}

/**
 * Phase 4 dual-write: write to conversation_messages (new) + messages_json blob (legacy).
 */
async function updateDirectConversation(id, messages, userId, meta = null) {
    await initDB();

    // ── New table write (Phase 4) — fire and forget ───────────────────────────
    convMessages.replaceMessages(id, 'direct', messages).catch(err =>
        console.error('[DirectConversations] conversation_messages write error:', err.message)
    );

    // ── Legacy blob write ─────────────────────────────────────────────────────
    if (meta && Object.keys(meta).length > 0) {
        const existing = await getOne('SELECT meta_json FROM direct_conversations WHERE id = $1 AND user_id = $2', [id, userId]);
        const existingMeta = JSON.parse(existing?.meta_json || '{}');
        const merged = { ...existingMeta, ...meta };
        const { rowCount } = await run('UPDATE direct_conversations SET messages_json = $1, meta_json = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4',
            [JSON.stringify(messages), JSON.stringify(merged), id, userId]);
        return rowCount > 0;
    }
    const { rowCount } = await run('UPDATE direct_conversations SET messages_json = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3', [JSON.stringify(messages), id, userId]);
    return rowCount > 0;
}

async function updateDirectConversationTitle(id, title, userId) {
    await initDB();
    const { rowCount } = await run('UPDATE direct_conversations SET title = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3', [title, id, userId]);
    return rowCount > 0;
}

async function deleteDirectConversation(id, userId) {
    await initDB();
    await run('DELETE FROM conversation_messages WHERE conversation_id = $1', [id]).catch(() => {});
    const { rowCount } = await run('DELETE FROM direct_conversations WHERE id = $1 AND user_id = $2', [id, userId]);
    // Drop any cached DLP state for this conversation.
    try { require('../../core/dlp/dlpRunner').clearConversationState(id); } catch (_) { /* module not loaded yet */ }
    return rowCount > 0;
}

async function updateDirectConversationWorkspace(id, content, notebookId = null) {
    await initDB();
    if (notebookId !== null) {
        await run('UPDATE direct_conversations SET workspace_content = $1, workspace_notebook_id = $2, updated_at = NOW() WHERE id = $3', [content, notebookId, id]);
    } else {
        await run('UPDATE direct_conversations SET workspace_content = $1, updated_at = NOW() WHERE id = $2', [content, id]);
    }
}

async function getDirectConversationWorkspace(id) {
    await initDB();
    const row = await getOne('SELECT workspace_content, workspace_notebook_id FROM direct_conversations WHERE id = $1', [id]);
    return row ? { content: row.workspace_content || '', notebookId: row.workspace_notebook_id || null } : null;
}

// ── Internal: read from new table first, lazy-migrate from blob if needed ────

async function _readDirectMessages(row) {
    // Phase 7a: row.messages_migrated is already fetched on the parent SELECT *,
    // so we check the flag directly — no extra SELECT LIMIT 1 round-trip.
    if (row.messages_migrated) {
        try {
            return await convMessages.getMessages(row.id);
        } catch (e) {
            console.warn('[DirectConversations] New table read failed, using blob fallback:', e.message);
        }
    }

    // Legacy blob fallback
    const messages = JSON.parse(row.messages_json || '[]');

    // Lazy migration (non-blocking)
    convMessages.migrateConversationIfNeeded(row.id, 'direct', messages).catch(err =>
        console.error('[DirectConversations] Lazy migration error:', err.message)
    );

    return messages;
}

module.exports = {
    createDirectConversation, getDirectConversation, listDirectConversations,
    updateDirectConversation, updateDirectConversationTitle, pinDirectConversation, setDirectConversationLabels, deleteDirectConversation,
    updateDirectConversationWorkspace, getDirectConversationWorkspace,
    searchDirectConversations, updateDirectConversationMeta,
};
