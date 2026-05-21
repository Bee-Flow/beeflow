/**
 * Memory API Routes
 * Manage user memories for AI agents
 */

const express = require('express');
const memoryStore = require('../stores/memoryStore');
const projectStore = require('../stores/projectStore');
const { resolveUserGroups } = require('../auth');
const { getEffectiveUserId } = require('./agents');
const { extractJSON } = require('../pipeline/llmHelpers');
const llmClient = require('../core/llmClient');
const { resolveModelForTier, getTierConfig } = require('../core/modelResolver');

const router = express.Router();

const MAX_IMPORT_BYTES = 50_000;
const VALID_TYPES = new Set(['instruction', 'person', 'project', 'preference', 'workflow', 'fact', 'context']);

// Memory type definitions
const MEMORY_TYPES = [
    { id: 'instruction', label: 'Instructions', icon: '📌', description: 'Standing instructions (always/never do X)' },
    { id: 'person', label: 'People', icon: '👤', description: 'People you know and work with' },
    { id: 'project', label: 'Projects', icon: '📁', description: 'Project details, tech stacks, URLs' },
    { id: 'preference', label: 'Preferences', icon: '⚙️', description: 'Your preferences and settings' },
    { id: 'workflow', label: 'Workflows', icon: '🔄', description: 'How you like to work' },
    { id: 'fact', label: 'Facts', icon: '📋', description: 'Facts about you or your work' },
    { id: 'context', label: 'Context', icon: '🏢', description: 'General background context' },
];

// Get memory type definitions
router.get('/types', (req, res) => {
    res.json({ types: MEMORY_TYPES });
});

// Get all memories for current user. For the user-global view (no agentId /
// projectId) supports `limit`, `offset`, and `search` so the Memory panel can
// page through the full backlog and find specific entries (BFSF-161).
router.get('/', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agentId = req.query.agentId || null;
    const projectId = req.query.projectId || null;
    const typeFilter = req.query.type || null;
    const search = req.query.search || null;
    const limit = req.query.limit;
    const offset = req.query.offset;

    try {
        if (projectId) {
            // Verify the caller can actually see this project before returning its
            // memories — every other project-scoped memory endpoint already does
            // this; the list endpoint was missing the check, letting any logged-in
            // user dump project memories by guessing the UUID.
            const groupIds = await resolveUserGroups(userId);
            const hasAccess = await projectStore.userHasAccess(userId, projectId, groupIds);
            if (!hasAccess) return res.status(403).json({ error: 'No access to this project' });
            const memories = await memoryStore.getMemoriesForProject(userId, projectId);
            const filtered = typeFilter ? memories.filter(m => m.type === typeFilter) : memories;
            return res.json({ memories: filtered });
        }
        if (agentId) {
            // Honor the agent's "use general memory" flag for per-agent agents.
            let includeGeneral = true;
            try {
                const agentStore = require('../stores/agentStore');
                const a = await agentStore.getAgent(agentId);
                const cfg = a?.config || {};
                if (cfg.memoryEnabled === true && cfg.useGeneralMemory === false) {
                    includeGeneral = false;
                }
            } catch (_) { /* default to true */ }
            const memories = await memoryStore.getMemoriesForAgent(userId, agentId, 50, { includeGeneral });
            const filtered = typeFilter ? memories.filter(m => m.type === typeFilter) : memories;
            return res.json({ memories: filtered });
        }

        // User-global view — paginate + search at the DB layer.
        const page = await memoryStore.searchUserMemories(userId, {
            limit: limit !== undefined ? limit : 50,
            offset: offset !== undefined ? offset : 0,
            search,
            type: typeFilter,
        });
        res.json({
            memories: page.items,
            total: page.total,
            limit: page.limit,
            offset: page.offset,
            hasMore: page.offset + page.items.length < page.total,
        });
    } catch (error) {
        console.error('Failed to get memories:', error);
        res.status(500).json({ error: error.message });
    }
});

// User-global memory stats (total + type distribution + importance buckets).
// Must be registered before `/:id` or Express will route "stats" as an id.
router.get('/stats', async (req, res) => {
    const userId = getEffectiveUserId(req);
    try {
        const stats = await memoryStore.getMemoryStats(userId);
        res.json(stats);
    } catch (error) {
        console.error('Failed to get memory stats:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get a single memory
router.get('/:id', async (req, res) => {
    const userId = getEffectiveUserId(req);

    try {
        const memory = await memoryStore.getMemoryById(req.params.id);
        if (!memory) return res.status(404).json({ error: 'Memory not found' });
        if (memory.project_id) {
            const hasAccess = await projectStore.userHasAccess(userId, memory.project_id);
            if (!hasAccess) return res.status(403).json({ error: 'Access denied' });
        } else if (memory.user_id !== userId) {
            return res.status(403).json({ error: 'Access denied' });
        }
        res.json({ memory });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create a memory manually
router.post('/', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const { content, type, agentId, importance, projectId } = req.body;

    if (!content) return res.status(400).json({ error: 'Content is required' });

    // Validate project access before creating project-scoped memory
    if (projectId) {
        const hasAccess = await projectStore.userHasAccess(userId, projectId);
        if (!hasAccess) return res.status(403).json({ error: 'No access to this project' });
    }

    try {
        const id = await memoryStore.createMemory(
            userId, agentId || null, type || 'fact',
            content, null, importance || 0.5, null, null, null, null, projectId || null
        );
        res.json({ success: true, id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update a memory
router.put('/:id', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const { content, summary, importance } = req.body;

    try {
        const memory = await memoryStore.getMemoryById(req.params.id);
        if (!memory) return res.status(404).json({ error: 'Memory not found' });
        if (memory.project_id) {
            const hasAccess = await projectStore.userHasAccess(userId, memory.project_id);
            if (!hasAccess) return res.status(403).json({ error: 'Access denied' });
        } else if (memory.user_id !== userId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        await memoryStore.updateMemory(req.params.id, content || memory.content, summary, importance);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Bulk delete memories
router.post('/bulk-delete', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'ids array is required' });
    }

    try {
        let deleted = 0;
        for (const id of ids) {
            const memory = await memoryStore.getMemoryById(id);
            if (!memory) continue;
            if (memory.project_id) {
                const hasAccess = await projectStore.userHasAccess(userId, memory.project_id);
                if (!hasAccess) continue;
            } else if (memory.user_id !== userId) {
                continue;
            }
            await memoryStore.deleteMemory(id);
            deleted++;
        }
        res.json({ success: true, deleted });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete a memory
router.delete('/:id', async (req, res) => {
    const userId = getEffectiveUserId(req);

    try {
        const memory = await memoryStore.getMemoryById(req.params.id);
        if (!memory) return res.status(404).json({ error: 'Memory not found' });
        if (memory.project_id) {
            const hasAccess = await projectStore.userHasAccess(userId, memory.project_id);
            if (!hasAccess) return res.status(403).json({ error: 'Access denied' });
        } else if (memory.user_id !== userId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        await memoryStore.deleteMemory(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Clear all memories for user
router.post('/clear', async (req, res) => {
    const userId = getEffectiveUserId(req);

    try {
        await memoryStore.clearAllMemories(userId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Export memories as JSON
router.get('/export/all', async (req, res) => {
    const userId = getEffectiveUserId(req);

    try {
        const memories = await memoryStore.getMemories(userId, 1000);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename=memories.json');
        res.json({ exportDate: new Date().toISOString(), userId, memories });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Import memories from pasted text (e.g. an export from another AI provider).
// Uses the fast-tier LLM to extract a typed list of memories from free-form
// text, then inserts each one through the normal createMemory path.
router.post('/import', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

    if (!text) return res.status(400).json({ error: 'text is required' });
    if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) {
        return res.status(400).json({ error: `text exceeds ${MAX_IMPORT_BYTES} byte limit` });
    }

    try {
        const userOrgId = req.user?.organizationId || null;
        const modelId = await resolveModelForTier('tier:fast', { userOrgId, userId, fallbackTier: 'fast' });
        const tierConfig = await getTierConfig('fast', { userOrgId, userId });

        const systemPrompt = `You extract structured memories from free-form text exported from an AI assistant.

Return ONLY a JSON object of the form {"memories": [{"type": "...", "content": "..."}]}.

"type" must be exactly one of: instruction, person, project, preference, workflow, fact, context.
- instruction: standing instructions (always/never do X)
- person: people the user knows or works with
- project: projects, tech stacks, URLs
- preference: settings, formatting, tone preferences
- workflow: how the user likes to work
- fact: specific facts about the user or their work
- context: general background context
If unsure, use "fact".

"content" must be a single concise sentence in the user's voice, preserving their wording where possible. One memory per distinct fact — do not bundle multiple facts into one entry. Skip filler text, greetings, and meta-commentary. If nothing useful can be extracted, return {"memories": []}.`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Extract memories from this text:\n\n${text}` },
        ];

        const result = await llmClient.chat(modelId, messages, {
            temperature: tierConfig?.temperature ?? 0.2,
            maxTokens: Math.min(tierConfig?.maxTokens ?? 2000, 4000),
            budgetTokens: 0,
            reasoningEffort: 'none',
        });

        const parsed = extractJSON(result?.content || '');
        const items = Array.isArray(parsed?.memories) ? parsed.memories : [];

        let imported = 0;
        let skipped = 0;
        const inserted = [];
        for (const item of items) {
            const type = VALID_TYPES.has(item?.type) ? item.type : 'fact';
            const content = typeof item?.content === 'string' ? item.content.trim() : '';
            if (!content) { skipped++; continue; }
            try {
                await memoryStore.createMemory(userId, null, type, content);
                imported++;
                inserted.push({ type, content });
            } catch (e) {
                skipped++;
                console.warn('[memory/import] insert failed:', e.message);
            }
        }

        res.json({ imported, skipped, items: inserted });
    } catch (error) {
        console.error('Memory import failed:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
