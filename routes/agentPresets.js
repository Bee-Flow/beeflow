/**
 * Agent Presets — list installable presets + one-click install into an org.
 *
 * Presets are pre-configured agent templates (system prompt + KB attachments)
 * defined in stores/agent/agentPresetRegistry.js. Installation creates a real,
 * tenant-owned, editable agent — no `agent_tools` rows are written because
 * the integration tools (Dutch legal stack) are auto-enabled via the
 * `dutch_legal_sources` beta feature, not via the agent_tools join table.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const { requireAuth, resolveUserOrgIds } = require('../auth');
const { getEffectiveUserId } = require('../utils/routeHelpers');
const agentStore = require('../stores/agentStore');
const userStore = require('../stores/userStore');
const kbStore = require('../stores/knowledgeBases');
const { getAll, getOne } = require('../db');
const { PRESETS, PRESETS_MAP, PRESETS_PROMPTS_DIR } = require('../stores/agent/agentPresetRegistry');
const { getOrgBetaFeatures, listBetaFeatures } = require('../core/betaFeatures');

function loadPromptFile(filename) {
    const full = path.join(PRESETS_PROMPTS_DIR, filename);
    return fs.readFileSync(full, 'utf-8');
}

async function resolveOrgContext(req) {
    const orgIds = await resolveUserOrgIds(req);
    const isSuperAdmin = orgIds === null
        || !!req.session?.isAdmin
        || req.session?.user?.role === 'admin';

    let orgId = null;
    if (orgIds instanceof Set && orgIds.size > 0) {
        orgId = Array.from(orgIds)[0];
    } else if (isSuperAdmin) {
        const all = await userStore.getAllOrganizations();
        if (Array.isArray(all) && all.length > 0) orgId = all[0].id;
    }
    return { orgId, isSuperAdmin };
}

// List installable presets for the current org. Each preset includes its
// `available` flag so the UI can render greyed-out rows when the underlying
// beta feature isn't active for the org yet.
router.get('/', requireAuth, async (req, res) => {
    try {
        const { orgId, isSuperAdmin } = await resolveOrgContext(req);

        const freeForAll = new Set(listBetaFeatures().filter(f => f.freeForAllOrgs).map(f => f.id));
        let orgAllowed = new Set();
        let orgActive = new Set();
        if (orgId) {
            try { orgAllowed = new Set(await getOrgBetaFeatures(orgId)); } catch (_) { /* */ }
            try { orgActive = new Set(await userStore.getOrgEnabledBetaFeatures(orgId)); } catch (_) { /* */ }
        }
        for (const id of freeForAll) orgAllowed.add(id);

        // Pre-load existing org agents by name so the UI can flag "already installed".
        let existingByName = new Map();
        if (orgId) {
            const rows = await getAll(
                'SELECT id, name FROM agents WHERE organization_id = $1',
                [orgId]
            );
            for (const r of rows) existingByName.set(r.name, r.id);
        }

        const items = PRESETS.map(p => {
            const featureActive = !p.betaFeature
                || isSuperAdmin
                || (orgAllowed.has(p.betaFeature) && orgActive.has(p.betaFeature));
            return {
                slug: p.slug,
                name: p.name,
                description: p.description,
                defaultModel: p.defaultModel,
                betaFeature: p.betaFeature || null,
                systemKbSlugs: p.systemKbSlugs || [],
                available: featureActive,
                installedAgentId: existingByName.get(p.name) || null,
            };
        });
        res.json({ items, orgId, isSuperAdmin });
    } catch (e) {
        console.error('[AgentPresets] list error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// One-click install. Idempotent: if an agent with the preset's name already
// exists in the org, return its id without creating a duplicate.
router.post('/:slug/install', requireAuth, async (req, res) => {
    try {
        const slug = String(req.params.slug || '').toLowerCase();
        const preset = PRESETS_MAP[slug];
        if (!preset) {
            return res.status(404).json({ error: `Unknown preset: ${slug}` });
        }

        const userId = getEffectiveUserId(req);
        const { orgId, isSuperAdmin } = await resolveOrgContext(req);
        if (!orgId) {
            return res.status(400).json({ error: 'No organisation context — cannot install preset.' });
        }

        // Gate on the preset's beta feature unless caller is super-admin.
        if (preset.betaFeature && !isSuperAdmin) {
            const freeForAll = new Set(listBetaFeatures().filter(f => f.freeForAllOrgs).map(f => f.id));
            const orgAllowed = new Set(await getOrgBetaFeatures(orgId).catch(() => []));
            for (const id of freeForAll) orgAllowed.add(id);
            const orgActive = new Set(await userStore.getOrgEnabledBetaFeatures(orgId).catch(() => []));
            if (!orgAllowed.has(preset.betaFeature) || !orgActive.has(preset.betaFeature)) {
                return res.status(403).json({
                    error: `Beta feature '${preset.betaFeature}' is not active for this organisation.`,
                });
            }
        }

        // Idempotency — return existing agent if a preset by this name was already installed.
        const existing = await getOne(
            'SELECT id FROM agents WHERE organization_id = $1 AND name = $2 LIMIT 1',
            [orgId, preset.name]
        );
        if (existing) {
            return res.json({ agentId: existing.id, alreadyExisted: true });
        }

        // Resolve system KB slugs → real UUIDs. Silently drop slugs that
        // don't resolve (system KB not seeded yet) — the agent is still
        // useful with whatever does resolve.
        const kbIds = [];
        for (const kbSlug of (preset.systemKbSlugs || [])) {
            try {
                const kb = await kbStore.getSystemKBBySlug(kbSlug);
                if (kb?.id) kbIds.push(kb.id);
            } catch (_) { /* missing system KB is non-fatal */ }
        }

        const systemPrompt = loadPromptFile(preset.promptFile);
        const config = { knowledge_base_ids: kbIds };

        const agent = await agentStore.createAgent(
            preset.name,
            preset.description,
            systemPrompt,
            userId,
            preset.defaultModel || null,
            [], // starterPrompts
            true,  // threadsEnabled
            true,  // copyEnabled
            false, // workspaceEnabled
            config,
            orgId,
            [],    // sharedGroups
            null,  // categoryId
        );

        res.json({ agentId: agent.id, alreadyExisted: false });
    } catch (e) {
        console.error('[AgentPresets] install error:', e.message, e.stack);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
