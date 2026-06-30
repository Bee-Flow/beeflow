// §WS5 #4 — automation version history endpoints, extracted verbatim from
// routes/automation.js. summariseDefinitionDiff (used only here) moved in.
const express = require('express');
const router = express.Router();
const automationStore = require('../../stores/automationStore');
const { validateDefinition } = require('../../automation/validate');

router.get('/:id/versions', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const versions = await automationStore.listVersions(a.id);
        res.json({ versions });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * §7 — Diff one stored version against another. Both must belong to
 * the same automation. Returns the two definitions plus a coarse
 * change summary the UI uses to seed its side-by-side viewer. Clients
 * compute the actual line/word diff locally.
 */
router.get('/:id/versions/:versionId/diff/:otherVersionId', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const [vA, vB] = await Promise.all([
            automationStore.getVersion(req.params.versionId),
            automationStore.getVersion(req.params.otherVersionId),
        ]);
        if (!vA || !vB) return res.status(404).json({ error: 'Version not found' });
        if (vA.automationId !== a.id || vB.automationId !== a.id) {
            return res.status(400).json({ error: 'Versions do not belong to this automation' });
        }
        const summary = summariseDefinitionDiff(vA.definition, vB.definition);
        res.json({ a: vA, b: vB, summary });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Read one version's full definition. Used by the version-history UI to
 * render a diff against the current row before the user commits a restore.
 * Listed metadata-only on /:id/versions; this endpoint loads the body.
 */
router.get('/:id/versions/:versionId', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const version = await automationStore.getVersion(req.params.versionId);
        if (!version) return res.status(404).json({ error: 'Version not found' });
        if (version.automationId !== a.id) return res.status(400).json({ error: 'Version does not belong to this automation' });
        res.json({ version });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Restore a historical version. Loads the version row, validates the
 * historical definition (could fail if step types or tool names have been
 * removed since), then writes it back through the regular updateAutomation
 * path so a new version row gets stamped with this user as the author.
 */
router.post('/:id/versions/:versionId/restore', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const version = await automationStore.getVersion(req.params.versionId);
        if (!version) return res.status(404).json({ error: 'Version not found' });
        if (version.automationId !== a.id) return res.status(400).json({ error: 'Version does not belong to this automation' });

        const v = validateDefinition(version.definition || {});
        if (!v.ok) return res.status(400).json({ error: 'Stored version no longer validates', details: v.errors });

        const updated = await automationStore.updateAutomation(a.id, { definition: version.definition }, userId);
        res.json({ automation: updated, restoredFromVersion: version.version });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


/**
 * Coarse structural diff between two automation definitions. Builds a
 * step-id → change-kind map so the UI can colour the diff viewer
 * without doing the JSON walk on the client. Phase 2 swaps this for a
 * proper jsondiffpatch payload — for now the summary covers ~90% of
 * what users want to see (added/removed/edited steps + edges).
 */
function summariseDefinitionDiff(defA, defB) {
    const stepsA = new Map();
    const stepsB = new Map();
    for (const s of (defA?.steps || [])) if (s?.id) stepsA.set(s.id, s);
    for (const s of (defB?.steps || [])) if (s?.id) stepsB.set(s.id, s);

    const added = [];
    const removed = [];
    const changed = [];
    for (const [id, sB] of stepsB) {
        const sA = stepsA.get(id);
        if (!sA) { added.push(id); continue; }
        if (JSON.stringify(sA) !== JSON.stringify(sB)) changed.push(id);
    }
    for (const id of stepsA.keys()) {
        if (!stepsB.has(id)) removed.push(id);
    }

    const edgesA = JSON.stringify(defA?.edges || []);
    const edgesB = JSON.stringify(defB?.edges || []);
    const triggerA = JSON.stringify(defA?.trigger || null);
    const triggerB = JSON.stringify(defB?.trigger || null);

    return {
        steps: { added, removed, changed },
        edgesChanged: edgesA !== edgesB,
        triggerChanged: triggerA !== triggerB,
    };
}

module.exports = router;
