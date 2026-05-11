/**
 * Skills API — CRUD routes for reusable instruction packs.
 *
 * Mounted at /api/skills (gated by requireBetaFeature('skills') in index.js).
 */

const express = require('express');
const router = express.Router();
const skillStore = require('../stores/skillStore');
const userStore = require('../stores/userStore');
const { requirePermission, validateSharedGroupsForOrg } = require('../auth');

// ── Auth guard (same pattern as other routes) ────────────────
function requireAuth(req, res, next) {
    if (!req.session?.isAuthenticated || !req.session?.user?.id) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    next();
}

router.use(requireAuth);

// Helper: resolve the user's org ID
async function getOrgId(req) {
    const userStore = require('../stores/userStore');
    const user = await userStore.getUser(req.session.user.id);
    return user?.organizationId || null;
}

// ── GET /api/skills — list available skills ──────────────────
router.get('/', async (req, res) => {
    try {
        const orgId = await getOrgId(req);
        if (!orgId) return res.json([]);
        const skills = await skillStore.getAvailableSkills(orgId, req.session.user.id);
        res.json(skills);
    } catch (err) {
        console.error('[Skills] GET / error:', err);
        res.status(500).json({ error: 'Failed to load skills' });
    }
});

// ── POST /api/skills — create a new skill ────────────────────
router.post('/', requirePermission('manage_skills'), async (req, res) => {
    try {
        const orgId = await getOrgId(req);
        if (!orgId) return res.status(400).json({ error: 'No organization found' });

        const { name, description, instructions, workflow, rules, examples, icon, isShared, dynamicActivation, sharedGroups, automationId } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Skill name is required' });
        }
        // Cap instructions at 4000 chars to prevent system prompt overflow
        if (instructions && instructions.length > 4000) {
            return res.status(400).json({ error: 'Instructions too long (max 4000 characters)' });
        }

        let cleanedGroups;
        try {
            cleanedGroups = await validateSharedGroupsForOrg(orgId, sharedGroups);
        } catch (e) {
            return res.status(e.status || 500).json({ error: e.message });
        }
        const skill = await skillStore.createSkill({
            orgId,
            userId: req.session.user.id,
            name: name.trim(),
            description,
            instructions,
            workflow,
            rules,
            examples,
            icon,
            isShared,
            dynamicActivation,
            sharedGroups: cleanedGroups || [],
            automationId: automationId || null,
        });
        res.status(201).json(skill);
    } catch (err) {
        console.error('[Skills] POST / error:', err);
        res.status(500).json({ error: 'Failed to create skill' });
    }
});

// ── GET /api/skills/:id — get skill details ──────────────────
router.get('/:id', async (req, res) => {
    try {
        const orgId = await getOrgId(req);
        if (!orgId) return res.status(404).json({ error: 'Not found' });

        const skill = await skillStore.getSkill(req.params.id, orgId, req.session.user.id);
        if (!skill) return res.status(404).json({ error: 'Skill not found' });
        res.json(skill);
    } catch (err) {
        console.error('[Skills] GET /:id error:', err);
        res.status(500).json({ error: 'Failed to load skill' });
    }
});

// ── PUT /api/skills/:id — update a skill ─────────────────────
router.put('/:id', requirePermission('manage_skills'), async (req, res) => {
    try {
        const { name, description, instructions, workflow, rules, examples, icon, isShared, dynamicActivation, sharedGroups, automationId } = req.body;
        if (instructions && instructions.length > 4000) {
            return res.status(400).json({ error: 'Instructions too long (max 4000 characters)' });
        }

        // Validate sharedGroups belong to the skill's org. `undefined` means
        // "leave as-is" — the store preserves the existing value.
        let cleanedGroups;
        if (sharedGroups !== undefined) {
            const orgId = await getOrgId(req);
            try {
                cleanedGroups = await validateSharedGroupsForOrg(orgId, sharedGroups);
            } catch (e) {
                return res.status(e.status || 500).json({ error: e.message });
            }
        }
        const updated = await skillStore.updateSkill(req.params.id, req.session.user.id, {
            name, description, instructions, workflow, rules, examples, icon, isShared, dynamicActivation,
            sharedGroups: cleanedGroups,
            automationId,
        });
        if (!updated) return res.status(404).json({ error: 'Skill not found or not owner' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Skills] PUT /:id error:', err);
        res.status(500).json({ error: 'Failed to update skill' });
    }
});

// ── DELETE /api/skills/:id — delete a skill ──────────────────
router.delete('/:id', async (req, res) => {
    try {
        const isAdmin = req.session?.isAdmin || req.session?.user?.role === 'admin';
        const orgId = await getOrgId(req);
        const deleted = await skillStore.deleteSkill(req.params.id, req.session.user.id, isAdmin);
        if (!deleted) return res.status(404).json({ error: 'Skill not found or not owner' });

        // Scrub the deleted skill id from every agent in this org that had it attached.
        // Non-fatal: a failure here leaves a dangling id that the runtime simply ignores.
        try {
            const agentStore = require('../stores/agentStore');
            const scrubbed = await agentStore.scrubSkillFromAllAgents(orgId, req.params.id);
            if (scrubbed > 0) console.log(`[Skills] Scrubbed deleted skill ${req.params.id} from ${scrubbed} agent(s)`);
        } catch (scrubErr) {
            console.warn('[Skills] Scrub after delete failed:', scrubErr.message);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[Skills] DELETE /:id error:', err);
        res.status(500).json({ error: 'Failed to delete skill' });
    }
});

module.exports = router;
