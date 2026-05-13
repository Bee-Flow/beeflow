/**
 * Memory Store - PostgreSQL management for user memories
 * Stores facts, preferences, and instructions extracted from conversations.
 *
 * Embedding dispatch (in order):
 *   1. Configured global embedding provider (preferred — same model used
 *      by KB / web-search inference)
 *   2. In-process CPU embedder (Xenova/multilingual-e5-small, MIT, 384-dim)
 *   3. Optional self-hosted GPU service via `EMBED_API_URL` (legacy path)
 *   4. Null — caller falls back to keyword retrieval
 *
 * Switching providers changes the vector dimension; existing memories
 * remain readable but won't rank against new embeddings (cosineSimilarity
 * returns 0 across mismatched dims). A re-embed migration is future work.
 */

const { run, getOne, getAll, exec } = require('../db');
const { v4: uuidv4 } = require('uuid');
const { resolveEmbedTarget } = require('../core/embed/resolveTarget');

// Optional self-hosted GPU embedding service (legacy). Disabled when
// the env var is unset — admins relying on it must set it explicitly.
const EMBED_API_URL = process.env.EMBED_API_URL || null;
const EMBED_MODEL = process.env.EMBED_MODEL || 'Qwen/Qwen3-Embedding-4B';

let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS user_memories (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            agent_id TEXT,
            type TEXT NOT NULL,
            content TEXT NOT NULL,
            subject TEXT,
            attribute TEXT,
            value TEXT,
            confidence REAL DEFAULT 1.0,
            status TEXT DEFAULT 'active',
            superseded_by TEXT,
            source_message_id TEXT,
            evidence_quote TEXT,
            last_confirmed_at TIMESTAMPTZ,
            summary TEXT,
            importance REAL DEFAULT 0.5,
            access_count INTEGER DEFAULT 0,
            last_accessed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            project_id TEXT
        )
    `);
    // Add embedding column if not present
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS embedding JSONB`);
    // Add project_id column if not present from older migrations
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS project_id TEXT`);
    // R3: tag memories that came out of an agent routine so the routine
    // system-prompt addendum can list "previously covered" topics for the
    // SAME routine and we can prune them on a schedule.
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS source_routine_id TEXT`);
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_memories_routine ON user_memories(source_routine_id) WHERE source_routine_id IS NOT NULL`);
    await exec(`
        CREATE TABLE IF NOT EXISTS memory_sources (
            id TEXT PRIMARY KEY,
            memory_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            message_content TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_memories_user ON user_memories(user_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_memories_agent ON user_memories(agent_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_memories_type ON user_memories(type)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_memories_status ON user_memories(status)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_memories_project ON user_memories(project_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_memories_dedupe ON user_memories(user_id, type, subject, attribute)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_memory_sources ON memory_sources(memory_id)`);
    // Phase 2: composite index for the hot retrieve path (user_id+status filter)
    await exec(`CREATE INDEX IF NOT EXISTS idx_memories_user_status_type ON user_memories(user_id, status, type)`);
    initialized = true;
}


initDB().catch(err => console.error('[MemoryStore] Init error:', err.message));

// ============ Embedding Helpers ============

/**
 * Get embedding vector for text. Tries (1) configured global provider,
 * then (2) in-process CPU embedder, then (3) optional self-hosted GPU
 * service. Returns the float array on success or null on full failure
 * so callers can degrade to keyword-only retrieval.
 */
async function getEmbedding(text) {
    if (!text) return null;

    // (1) Configured global embedding provider — OpenAI-compatible /v1/embeddings.
    try {
        const target = await resolveEmbedTarget();
        if (target?.endpoint && target?.modelId && target?.apiKey) {
            const root = target.endpoint.replace(/\/+$/, '');
            const isAzure = target.providerType === 'azure';
            const url = isAzure
                ? `${root}/openai/deployments/${encodeURIComponent(target.modelId)}/embeddings?api-version=2024-06-01`
                : (root.endsWith('/v1') ? `${root}/embeddings` : `${root}/v1/embeddings`);
            const headers = isAzure
                ? { 'Content-Type': 'application/json', 'api-key': target.apiKey }
                : { 'Content-Type': 'application/json', Authorization: `Bearer ${target.apiKey}` };
            const body = isAzure
                ? JSON.stringify({ input: [text] })
                : JSON.stringify({ model: target.modelId, input: [text] });
            const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
            if (res.ok) {
                const data = await res.json();
                const vec = data?.data?.[0]?.embedding;
                if (Array.isArray(vec)) return vec;
            }
        }
    } catch (_) { /* try next tier */ }

    // (2) CPU embedder — in-process, no external call.
    try {
        const { cpuEmbed } = require('../core/embed/cpuEmbed');
        const vecs = await cpuEmbed([text], { kind: 'passage' });
        if (vecs.length > 0) return vecs[0];
    } catch (_) { /* try next tier */ }

    // (3) Legacy self-hosted GPU service (`EMBED_API_URL`).
    if (EMBED_API_URL) {
        try {
            const res = await fetch(EMBED_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: EMBED_MODEL, input: [text] }),
                signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
                const data = await res.json();
                return data?.data?.[0]?.embedding || null;
            }
        } catch (_) { /* fall through */ }
    }

    return null;
}

/** Cosine similarity between two vectors. */
function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
}

// ============ Memory CRUD Functions ============

async function createMemory(userId, agentId, type, content, summary = null, importance = 0.5, subject = null, attribute = null, value = null, evidenceQuote = null, projectId = null) {
    await initDB();
    const confidence = 1.0;

    // 1. Try Canonical Deduplication
    if (subject && attribute) {
        // Find existing canonical memory (matching user OR project)
        let query = `
            SELECT * FROM user_memories WHERE type = $1 AND subject = $2 AND attribute = $3 AND status = 'active'
        `;
        let params = [type, subject, attribute];
        if (projectId) {
            query += ` AND project_id = $4 LIMIT 1`;
            params.push(projectId);
        } else {
            query += ` AND user_id = $4 AND project_id IS NULL LIMIT 1`;
            params.push(userId);
        }
        
        const existing = await getOne(query, params);

        if (existing) {
            if (existing.value === value) {
                console.log(`[MemoryStore] Canonical duplicate found (confirmed): ${type}:${subject}.${attribute} = ${value}`);
                await confirmMemory(existing.id);
                return existing.id;
            }

            console.log(`[MemoryStore] Superseding memory ${existing.id} (${existing.value}) with new value: ${value}`);
            const newId = uuidv4();
            await run(`
                INSERT INTO user_memories (id, user_id, agent_id, type, content, subject, attribute, value, confidence, summary, importance, evidence_quote, last_confirmed_at, status, project_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), 'active', $13)
            `, [newId, userId, agentId, type, content, subject, attribute, value, confidence, summary || content.slice(0, 50), importance, evidenceQuote, projectId]);

            await run(`UPDATE user_memories SET status = 'superseded', superseded_by = $1, updated_at = NOW() WHERE id = $2`, [newId, existing.id]);
            embedAndStore(newId, content);
            return newId;
        }
    }

    // 2. Create new memory
    const id = uuidv4();
    await run(`
        INSERT INTO user_memories (id, user_id, agent_id, type, content, subject, attribute, value, confidence, summary, importance, evidence_quote, last_confirmed_at, status, project_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), 'active', $13)
    `, [id, userId, agentId, type, content, subject || null, attribute || null, value || null, confidence, summary || content.slice(0, 50), importance, evidenceQuote, projectId]);

    // Embed async (fire-and-forget)
    embedAndStore(id, content);

    console.log(`[MemoryStore] Created memory: ${content.slice(0, 50)}...`);
    return id;
}

/** Embed content and store vector in DB (fire-and-forget). */
async function embedAndStore(memoryId, content) {
    try {
        const embedding = await getEmbedding(content);
        if (embedding) {
            await run(`UPDATE user_memories SET embedding = $1 WHERE id = $2`, [JSON.stringify(embedding), memoryId]);
        }
    } catch (e) {
        console.warn('[MemoryStore] Embedding failed for', memoryId, e.message);
    }
}

async function findByKey(userId, type, subject, attribute, projectId = null) {
    await initDB();
    
    let query = `SELECT * FROM user_memories WHERE type = $1 AND subject = $2 AND attribute = $3 AND status = 'active'`;
    let params = [type, subject, attribute];
    if (projectId) {
        query += ` AND project_id = $4 LIMIT 1`;
        params.push(projectId);
    } else {
        query += ` AND user_id = $4 AND project_id IS NULL LIMIT 1`;
        params.push(userId);
    }
    
    return getOne(query, params);
}

async function updateMemoryValue(memoryId, newValue, newContent, evidenceQuote) {
    await initDB();
    await run(`
        UPDATE user_memories SET value = $1, content = $2, evidence_quote = $3, last_confirmed_at = NOW(), updated_at = NOW() WHERE id = $4
    `, [newValue, newContent, evidenceQuote, memoryId]);
    console.log(`[MemoryStore] Updated memory ${memoryId} with new value: ${newValue}`);
}

async function confirmMemory(memoryId) {
    await initDB();
    await run(`
        UPDATE user_memories SET last_confirmed_at = NOW(), confidence = LEAST(1.0, confidence + 0.05), access_count = access_count + 1 WHERE id = $1
    `, [memoryId]);
}

async function getMemories(userId, limit = 50) {
    await initDB();
    return getAll(`
        SELECT * FROM user_memories WHERE user_id = $1 AND status = 'active' AND project_id IS NULL
        ORDER BY importance DESC, updated_at DESC LIMIT $2
    `, [userId, limit]);
}

/**
 * Paginated + searchable user-global memory list. Returns the page plus the
 * total count so the UI can show "Load more" / progress.
 *
 * Search matches against content, subject, attribute, value (case-insensitive).
 * Type filter is applied at the DB level so pagination is consistent.
 */
async function searchUserMemories(userId, { limit = 50, offset = 0, search = null, type = null } = {}) {
    await initDB();
    const where = [`user_id = $1`, `status = 'active'`, `project_id IS NULL`];
    const params = [userId];
    if (type) {
        params.push(type);
        where.push(`type = $${params.length}`);
    }
    if (search && String(search).trim()) {
        params.push(`%${String(search).trim()}%`);
        const idx = params.length;
        where.push(`(content ILIKE $${idx} OR subject ILIKE $${idx} OR attribute ILIKE $${idx} OR value ILIKE $${idx})`);
    }
    const whereSql = where.join(' AND ');
    const safeLimit = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
    const safeOffset = Math.max(0, parseInt(offset, 10) || 0);
    params.push(safeLimit);
    params.push(safeOffset);
    const items = await getAll(`
        SELECT * FROM user_memories WHERE ${whereSql}
        ORDER BY importance DESC, updated_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    const countRow = await getOne(`SELECT COUNT(*)::int AS total FROM user_memories WHERE ${whereSql}`, params.slice(0, -2));
    return { items, total: countRow?.total || 0, limit: safeLimit, offset: safeOffset };
}

async function getMemoriesForProject(userId, projectId, limit = 50) {
    await initDB();
    return getAll(`
        SELECT m.*, u."displayName" as created_by_name, u.username as created_by_username 
        FROM user_memories m
        LEFT JOIN users u ON m.user_id = u.id
        WHERE m.project_id = $1 AND m.status = 'active'
        ORDER BY m.importance DESC, m.updated_at DESC LIMIT $2
    `, [projectId, limit]);
}

async function getMemoriesForAgent(userId, agentId, limit = 20, { includeGeneral = true } = {}) {
    await initDB();
    // includeGeneral=true (default): return agent-specific + user-global memories.
    // includeGeneral=false: only this agent's bucket — used when an agent has
    // memoryEnabled and explicitly opts out of reading the user's general memory.
    if (includeGeneral) {
        return getAll(`
            SELECT * FROM user_memories
            WHERE user_id = $1 AND status = 'active' AND (agent_id = $2 OR agent_id IS NULL)
            ORDER BY importance DESC, updated_at DESC LIMIT $3
        `, [userId, agentId, limit]);
    }
    return getAll(`
        SELECT * FROM user_memories
        WHERE user_id = $1 AND status = 'active' AND agent_id = $2
        ORDER BY importance DESC, updated_at DESC LIMIT $3
    `, [userId, agentId, limit]);
}

async function getMemoryById(id) {
    await initDB();
    return getOne('SELECT * FROM user_memories WHERE id = $1', [id]);
}

async function updateMemory(id, content, summary = null, importance = null) {
    await initDB();
    const existing = await getMemoryById(id);
    if (!existing) return false;
    await run(`
        UPDATE user_memories SET content = $1, summary = $2, importance = $3, updated_at = NOW() WHERE id = $4
    `, [content, summary || content.slice(0, 50), importance !== null ? importance : existing.importance, id]);
    return true;
}

async function deleteMemory(id) {
    await initDB();
    await run('DELETE FROM user_memories WHERE id = $1', [id]);
    return true;
}

async function clearAllMemories(userId) {
    await initDB();
    await run('DELETE FROM user_memories WHERE user_id = $1 AND project_id IS NULL', [userId]);
    return true;
}

async function addMemorySource(memoryId, conversationId, messageContent) {
    await initDB();
    const id = uuidv4();
    await run(`
        INSERT INTO memory_sources (id, memory_id, conversation_id, message_content)
        VALUES ($1, $2, $3, $4)
    `, [id, memoryId, conversationId, messageContent]);
}

async function findSimilarMemory(userId, content, projectId = null) {
    await initDB();
    
    let query = `
        SELECT * FROM user_memories WHERE status = 'active' 
    `;
    let params = [];
    if (projectId) {
        query += ` AND project_id = $1`;
        params.push(projectId);
    } else {
        query += ` AND user_id = $1 AND project_id IS NULL`;
        params.push(userId);
    }
    query += ` ORDER BY importance DESC, updated_at DESC`;
    
    const memories = await getAll(query, params);

    const normalize = (text) => text.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const normalizedNew = normalize(content);
    const getWords = (text) => normalize(text).split(/\s+/).filter(w => w.length > 2);
    const newWords = getWords(content);

    for (const memory of memories) {
        const normalizedExisting = normalize(memory.content);
        if (normalizedNew === normalizedExisting) return memory;
        if (normalizedNew.includes(normalizedExisting) || normalizedExisting.includes(normalizedNew)) return memory;

        const existingWords = getWords(memory.content);
        if (newWords.length > 0 && existingWords.length > 0) {
            const matchingWords = newWords.filter(w => existingWords.includes(w));
            const overlapRatio = matchingWords.length / Math.min(newWords.length, existingWords.length);
            if (overlapRatio > 0.8) return memory;
        }
    }
    return null;
}

// ============ Memory Retrieval ============

async function findRelevantMemories(userId, agentId, userMessage, tokenLimit = 800, projectId = null, { includeGeneral = true } = {}) {
    await initDB();

    // When the agent has its own bucket and opts out of reading the user's
    // general memory, restrict to agent-specific rows only.
    let query;
    let params;
    if (!includeGeneral && agentId) {
        query = `
            SELECT * FROM user_memories
            WHERE status = 'active' AND agent_id = $1
        `;
        params = [agentId];
    } else {
        query = `
            SELECT * FROM user_memories
            WHERE status = 'active' AND (agent_id = $1 OR agent_id IS NULL)
        `;
        params = [agentId || null];
    }
    
    // Strict project isolation: only project memories in project context, only global in non-project
    if (projectId) {
        query += ` AND project_id = $2`;
        params.push(projectId);
    } else {
        query += ` AND user_id = $2 AND project_id IS NULL`;
        params.push(userId);
    }
    
    query += ` ORDER BY importance DESC, updated_at DESC`;
    
    let memories = await getAll(query, params);

    // ── Suggestion A: Hybrid retrieval ────────────────────────────────────────
    // When inside a project context, ALSO inject the user's global instructions
    // and preferences (e.g. "always use TypeScript", "respond concisely").
    // These are behavioural settings that should apply everywhere.
    // Project-specific data is still strictly isolated — only instruction/preference
    // types cross the boundary.
    if (projectId && includeGeneral) {
        const userGlobalBehaviour = await getAll(`
            SELECT * FROM user_memories
            WHERE user_id = $1 AND project_id IS NULL AND status = 'active'
              AND type IN ('instruction', 'preference')
            ORDER BY importance DESC, updated_at DESC LIMIT 15
        `, [userId]);
        // Merge, deduplicating by id
        const existingIds = new Set(memories.map(m => m.id));
        for (const m of userGlobalBehaviour) {
            if (!existingIds.has(m.id)) {
                memories.push(m);
                existingIds.add(m.id);
            }
        }
    }

    if (memories.length === 0) return [];

    // Get embedding of user message for semantic scoring
    const queryEmbedding = await getEmbedding(userMessage);

    const scoredMemories = [];
    const lowerMsg = userMessage.toLowerCase();

    for (const memory of memories) {
        let score = 0;

        // 1. Type base score
        const typeScores = { instruction: 100, person: 80, project: 70, preference: 60, workflow: 60, fact: 40, context: 20 };
        score += typeScores[memory.type] || 20;

        // 2. Semantic similarity (replaces keyword matching)
        let memEmbedding = memory.embedding;
        if (typeof memEmbedding === 'string') {
            try { memEmbedding = JSON.parse(memEmbedding); } catch { memEmbedding = null; }
        }
        if (queryEmbedding && memEmbedding) {
            const similarity = cosineSimilarity(queryEmbedding, memEmbedding);
            score += similarity * 100; // 0-100 points from semantic match
        } else {
            // Fallback: keyword matching when embeddings unavailable
            const lowerContent = memory.content.toLowerCase();
            const words = lowerContent.split(/\s+/).filter(w => w.length > 3);
            const matches = words.filter(w => lowerMsg.includes(w));
            score += matches.length * 10;
        }

        // 3. Recency bonus
        const daysOld = (Date.now() - new Date(memory.updated_at).getTime()) / (1000 * 60 * 60 * 24);
        score += Math.max(0, 20 - daysOld * 2);

        // 4. Importance bonus
        score += (memory.importance || 0.5) * 20;

        scoredMemories.push({ memory, score });
    }

    scoredMemories.sort((a, b) => b.score - a.score);

    const selected = [];
    let currentChars = 0;
    const charLimit = tokenLimit * 4;

    for (const item of scoredMemories) {
        // Instructions always included
        if (item.memory.type === 'instruction') {
            selected.push(item.memory);
            currentChars += item.memory.content.length;
            continue;
        }
        if (item.score > 30 && (currentChars + item.memory.content.length) < charLimit) {
            selected.push(item.memory);
            currentChars += item.memory.content.length;
        }
    }
    return selected;
}

function formatMemoriesForPrompt(memories) {
    if (!memories || memories.length === 0) return '';

    const instructions = memories.filter(m => m.type === 'instruction');
    const persons = memories.filter(m => m.type === 'person');
    const projects = memories.filter(m => m.type === 'project');
    const preferences = memories.filter(m => m.type === 'preference');
    const workflows = memories.filter(m => m.type === 'workflow');
    const facts = memories.filter(m => m.type === 'fact');
    const context = memories.filter(m => m.type === 'context');

    let prompt = '## Active Memory\n';
    prompt += 'Long-term memory about this user. Use to personalize responses.\n\n';

    if (instructions.length > 0) {
        prompt += '### Instructions (MUST FOLLOW)\n';
        instructions.forEach(m => { prompt += `- ${m.content}\n`; });
        prompt += '\n';
    }
    if (persons.length > 0) {
        prompt += '### People\n';
        persons.forEach(m => {
            prompt += m.subject && m.attribute && m.value ? `- ${m.subject}: ${m.attribute} = ${m.value}\n` : `- ${m.content}\n`;
        });
        prompt += '\n';
    }
    if (projects.length > 0) {
        prompt += '### Projects\n';
        projects.forEach(m => {
            prompt += m.subject && m.attribute && m.value ? `- ${m.subject}: ${m.attribute} = ${m.value}\n` : `- ${m.content}\n`;
        });
        prompt += '\n';
    }
    if (preferences.length > 0) {
        prompt += '### Preferences\n';
        preferences.forEach(m => {
            prompt += m.subject && m.attribute && m.value ? `- ${m.attribute}: ${m.value}\n` : `- ${m.content}\n`;
        });
        prompt += '\n';
    }
    if (workflows.length > 0) {
        prompt += '### Workflows\n';
        workflows.forEach(m => { prompt += `- ${m.content}\n`; });
        prompt += '\n';
    }
    if (facts.length > 0) {
        prompt += '### Facts\n';
        facts.forEach(m => {
            prompt += m.subject && m.attribute && m.value ? `- ${m.subject}.${m.attribute}: ${m.value}\n` : `- ${m.content}\n`;
        });
        prompt += '\n';
    }
    if (context.length > 0) {
        prompt += '### Context\n';
        context.forEach(m => { prompt += `- ${m.content}\n`; });
    }
    return prompt;
}

// ============ Stats ============

async function getMemoryStats(userId) {
    await initDB();
    const total = await getOne('SELECT COUNT(*) as count FROM user_memories WHERE user_id = $1 AND project_id IS NULL', [userId]);
    const byType = await getAll('SELECT type, COUNT(*) as count FROM user_memories WHERE user_id = $1 AND project_id IS NULL GROUP BY type', [userId]);
    const byImportance = await getAll(`
        SELECT
            CASE WHEN importance >= 0.8 THEN 'high' WHEN importance >= 0.5 THEN 'medium' ELSE 'low' END as level,
            COUNT(*) as count
        FROM user_memories WHERE user_id = $1 AND project_id IS NULL GROUP BY level
    `, [userId]);

    const typeDistribution = { labels: byType.map(r => r.type), data: byType.map(r => parseInt(r.count)) };
    const importanceDistribution = { high: 0, medium: 0, low: 0 };
    byImportance.forEach(r => { if (importanceDistribution[r.level] !== undefined) importanceDistribution[r.level] = parseInt(r.count); });

    return { total: parseInt(total.count), typeDistribution, importanceDistribution };
}

// ============ R3: Routine Coverage Memories ============
// A "routine_coverage" memory tracks one topic the agent has surfaced in a
// past run of a specific routine. Used to de-dupe daily/weekly digests
// (e.g. AI-news routine: don't re-cover "openai-gpt-5" unless there's an
// update). Indexed by `(user_id, source_routine_id, subject)` so each topic
// has exactly one row per routine and updating a topic supersedes the prior
// value rather than duplicating.

const ROUTINE_COVERAGE_TYPE = 'routine_coverage';
const ROUTINE_COVERAGE_TTL_DAYS = 30;

/**
 * Insert-or-update a coverage memory for one topic of one routine.
 * - subject: stable topic key (e.g. "openai-gpt-5")
 * - title: human-readable title used in the addendum (e.g. "OpenAI GPT-5 launch")
 * - summary: short one-line description ("Released …")
 */
async function upsertRoutineCoverage({ userId, agentId, routineId, subject, title, summary }) {
    if (!userId || !routineId || !subject) return null;
    await initDB();
    const expiresAt = new Date(Date.now() + ROUTINE_COVERAGE_TTL_DAYS * 24 * 3600 * 1000).toISOString();
    const content = title ? `${title}${summary ? ' — ' + summary : ''}` : (summary || subject);
    const existing = await getOne(
        `SELECT id FROM user_memories
         WHERE user_id = $1 AND source_routine_id = $2 AND subject = $3 AND status = 'active'
         LIMIT 1`,
        [userId, routineId, subject]
    );
    if (existing) {
        await run(
            `UPDATE user_memories
             SET content = $1, summary = $2, value = $3,
                 last_confirmed_at = NOW(), expires_at = $4, updated_at = NOW()
             WHERE id = $5`,
            [content, summary || null, title || null, expiresAt, existing.id]
        );
        return existing.id;
    }
    const id = uuidv4();
    await run(
        `INSERT INTO user_memories
            (id, user_id, agent_id, type, content, subject, value, summary, importance,
             last_confirmed_at, status, source_routine_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), 'active', $10, $11)`,
        [id, userId, agentId || null, ROUTINE_COVERAGE_TYPE, content, subject,
         title || null, summary || null, 0.5, routineId, expiresAt]
    );
    embedAndStore(id, content);
    return id;
}

/** List active coverage memories for a routine, newest-first. */
async function getRoutineCoverage(routineId, { limit = 50 } = {}) {
    if (!routineId) return [];
    await initDB();
    return getAll(
        `SELECT id, subject, summary, value, last_confirmed_at
         FROM user_memories
         WHERE source_routine_id = $1 AND status = 'active'
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY last_confirmed_at DESC LIMIT $2`,
        [routineId, limit]
    );
}

/** Delete coverage memories whose TTL has elapsed. Returns rowCount. */
async function pruneExpiredCoverage() {
    await initDB();
    const { rowCount } = await run(
        `UPDATE user_memories SET status = 'expired', updated_at = NOW()
         WHERE type = $1 AND status = 'active' AND expires_at IS NOT NULL AND expires_at < NOW()`,
        [ROUTINE_COVERAGE_TYPE]
    );
    return rowCount || 0;
}

module.exports = {
    createMemory, getMemories, searchUserMemories, getMemoriesForAgent, getMemoriesForProject, getMemoryById,
    updateMemory, deleteMemory, clearAllMemories,
    addMemorySource, findSimilarMemory, findRelevantMemories,
    formatMemoriesForPrompt, getMemoryStats,
    findByKey, updateMemoryValue, confirmMemory,
    upsertRoutineCoverage, getRoutineCoverage, pruneExpiredCoverage,
    ROUTINE_COVERAGE_TYPE,
};
