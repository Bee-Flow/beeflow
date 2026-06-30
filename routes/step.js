/**
 * Step Routes — REST API for reusable building blocks ("Steps", kind='block').
 *
 * A Step is a standalone Flowlet: a single layer_input trigger (params) + a
 * layer_output step, built in the same visual builder, then added to any
 * automation via a call_block node or exposed as a chat tool. Steps reuse the
 * automations table; this router keeps their lifecycle (publish-to-apply,
 * sharing, chat exposure) separate from the automation run/schedule surface.
 *
 *   GET    /                 list Steps the user can see (own + shared)
 *   POST   /                 create a Step (draft)
 *   GET    /:id              get one
 *   PUT    /:id              update the draft (title/description/definition)
 *   DELETE /:id              delete (409 if referenced by an automation)
 *   POST   /:id/publish      snapshot the draft → published version
 *   PUT    /:id/sharing      set is_published + shared_groups
 *   PUT    /:id/expose       toggle expose_as_tool (chat/agent tool)
 *   GET    /:id/versions     version history
 *   POST   /:id/test         dry-run the draft with sample inputs
 *
 * Gated by requireBetaFeature('automations') — the same gate as automations.
 */

const express = require('express');
const router = express.Router();

const automationStore = require('../stores/automationStore');
const userStore = require('../stores/userStore');
const { validateDefinition } = require('../automation/validate');
const { summariseDefinition } = require('../automation/summarise');
const { resolveAudienceContext } = require('../auth/audience');

function requireAuth(req, res, next) {
    if (req.session?.user?.id) return next();
    res.status(401).json({ error: 'Not authenticated' });
}
router.use(requireAuth);

const { requireBetaFeature } = require('../core/betaFeatures');
router.use(requireBetaFeature('automations'));

const { requireActiveOrgForMutations } = require('../auth');
router.use(requireActiveOrgForMutations());

// A fresh Step's root graph: layer_input trigger + a single layer_output.
function blockSkeleton() {
    return {
        schemaVersion: 2,
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
        steps: [{ id: 'out', type: 'layer_output', fields: {} }],
        edges: [],
    };
}

async function activeOrgId(userId) {
    try {
        const user = await userStore.getUser(userId);
        return user?.organizationId || null;
    } catch (_) { return null; }
}

// List Steps visible to the caller (own + shared into their orgs).
router.get('/', async (req, res) => {
    try {
        const { userId, orgIds, userGroups } = await resolveAudienceContext(req);
        const orgIdList = orgIds === null ? [] : [...orgIds];
        const isOrgAdmin = orgIds === null; // super admin sees drafts too
        const steps = await automationStore.getStepsForUser(userId, { orgIds: orgIdList, userGroups, isOrgAdmin });
        res.json({ steps });
    } catch (e) {
        console.error('[step list] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Create a Step (draft).
router.post('/', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { title, description } = req.body;
        if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
        const definition = (req.body.definition && typeof req.body.definition === 'object') ? req.body.definition : blockSkeleton();
        const v = validateDefinition(definition, { scope: 'block' });
        if (!v.ok) return res.status(400).json({ error: 'Invalid Step definition', details: v.errors });
        const organizationId = await activeOrgId(userId);
        const icon = typeof req.body.icon === 'string' ? req.body.icon : null;
        const category = typeof req.body.category === 'string' ? req.body.category.trim().slice(0, 60) : null;
        const step = await automationStore.createStep({ userId, organizationId, title: title.trim(), description: description || '', definition, icon, category });
        res.json({ step });
    } catch (e) {
        console.error('[step create] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Steps the caller exposed as chat tools — for the chat "Apps" picker so the
// user can see/discover them. Owner-only + published + expose_as_tool (the same
// set the agent actually gets injected). Registered before /:id so the literal
// path wins. Lightweight projection (no definition).
router.get('/chat-tools', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const callable = await automationStore.getCallableStepsForUser(userId, { orgIds: [] }).catch(() => []);
        const tools = callable
            .filter(s => s.ownerId === userId && s.exposeAsTool)
            .map(s => ({ id: s.id, title: s.title, description: s.description || '', icon: s.icon || null, category: s.category || null }));
        res.json({ tools });
    } catch (e) {
        console.error('[step chat-tools] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Helper: load a Step the caller can VIEW (own or shared), or null.
async function loadVisibleStep(req) {
    const row = await automationStore.getAutomation(req.params.id);
    if (!row || row.kind !== 'block') return { row: null };
    const { userId, orgIds, userGroups } = await resolveAudienceContext(req);
    const isOwner = row.userId === userId;
    const orgSet = orgIds === null ? null : orgIds;
    let canView = isOwner || orgIds === null;
    if (!canView && row.isPublished && row.organizationId && orgSet?.has?.(row.organizationId)) {
        const groups = Array.isArray(row.sharedGroups) ? row.sharedGroups : [];
        canView = groups.length === 0 || groups.some(g => userGroups.includes(g));
    }
    return { row, isOwner, canView };
}

router.get('/:id', async (req, res) => {
    try {
        const { row, canView } = await loadVisibleStep(req);
        if (!row) return res.status(404).json({ error: 'Not found' });
        if (!canView) return res.status(403).json({ error: 'Forbidden' });
        res.json({ step: row, summary: summariseDefinition(row.definition || {}).summary });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const existing = await automationStore.getAutomation(req.params.id);
        if (!existing || existing.kind !== 'block') return res.status(404).json({ error: 'Not found' });
        if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

        const updates = {};
        for (const f of ['title', 'description', 'icon', 'category', 'definition']) if (req.body[f] !== undefined) updates[f] = req.body[f];
        // Normalise category — trim + cap, '' clears it.
        if (updates.category !== undefined) {
            updates.category = typeof updates.category === 'string' && updates.category.trim()
                ? updates.category.trim().slice(0, 60) : null;
        }
        if (updates.definition) {
            const v = validateDefinition(updates.definition, { scope: 'block' });
            if (!v.ok) return res.status(400).json({ error: 'Invalid Step definition', details: v.errors });
        }
        const updated = await automationStore.updateAutomation(req.params.id, updates, userId);
        res.json({ step: updated });
    } catch (e) {
        console.error('[step update] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const existing = await automationStore.getAutomation(req.params.id);
        if (!existing || existing.kind !== 'block') return res.status(404).json({ error: 'Not found' });
        if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const consumers = await automationStore.getStepConsumers(req.params.id);
        if (consumers.length > 0) {
            return res.status(409).json({ error: 'Step is in use', code: 'step_in_use', consumers });
        }
        await automationStore.deleteAutomation(req.params.id);
        res.json({ success: true });
    } catch (e) {
        console.error('[step delete] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Publish: snapshot the current draft so consumers pick up the change.
router.post('/:id/publish', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const existing = await automationStore.getAutomation(req.params.id);
        if (!existing || existing.kind !== 'block') return res.status(404).json({ error: 'Not found' });
        if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const v = validateDefinition(existing.definition || {}, { scope: 'block' });
        if (!v.ok) return res.status(400).json({ error: 'Cannot publish an invalid Step', details: v.errors });
        const step = await automationStore.publishStep(req.params.id, userId);
        res.json({ step });
    } catch (e) {
        console.error('[step publish] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.put('/:id/sharing', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const existing = await automationStore.getAutomation(req.params.id);
        if (!existing || existing.kind !== 'block') return res.status(404).json({ error: 'Not found' });
        if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const { isPublished, sharedGroups } = req.body;
        const step = await automationStore.setStepSharing(req.params.id, { isPublished, sharedGroups });
        res.json({ step });
    } catch (e) {
        console.error('[step sharing] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.put('/:id/expose', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const existing = await automationStore.getAutomation(req.params.id);
        if (!existing || existing.kind !== 'block') return res.status(404).json({ error: 'Not found' });
        if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const step = await automationStore.setStepExpose(req.params.id, !!req.body.exposeAsTool);
        res.json({ step });
    } catch (e) {
        console.error('[step expose] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.get('/:id/versions', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const existing = await automationStore.getAutomation(req.params.id);
        if (!existing || existing.kind !== 'block') return res.status(404).json({ error: 'Not found' });
        if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const versions = await automationStore.listVersions(req.params.id);
        res.json({ versions, publishedVersion: existing.publishedVersion });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Test the DRAFT with sample inputs (dry-run, owner-only, runs as the owner).
router.post('/:id/test', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const existing = await automationStore.getAutomation(req.params.id);
        if (!existing || existing.kind !== 'block') return res.status(404).json({ error: 'Not found' });
        if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const v = validateDefinition(existing.definition || {}, { scope: 'block' });
        if (!v.ok) return res.status(400).json({ error: 'Invalid Step definition', details: v.errors });
        const synthetic = {
            id: existing.id, userId: existing.userId, organizationId: existing.organizationId || null,
            title: existing.title, version: existing.version, definition: existing.definition, kind: 'block',
        };
        const runner = require('../core/automationRunner');
        const run = await runner.executeAutomation(synthetic, {
            triggerKind: 'dry_run', triggerPayload: req.body?.inputs || {}, mode: 'dry_run',
        });
        const steps = await automationStore.getRunSteps(run.id);
        res.json({ run, steps });
    } catch (e) {
        console.error('[step test] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
