// §WS5 #4 — builder catalog endpoints, extracted verbatim from routes/automation.js.
const express = require('express');
const router = express.Router();
const automationStore = require('../../stores/automationStore');
const configStore = require('../../stores/configStore');
const { deliverabilityForCatalog } = require('../../automation/deliverableEvents');
const { TOOL_REGISTRY, loadTools } = require('../../automation/toolRegistry');
const { isSideEffect } = require('../../automation/sideEffectMap');
const { getOutputSchema, synthesizeDryRunOutput } = require('../../automation/outputSchemas');
const { resolveIntegration } = require('../../core/integrationToolMap');

// Catalog — auto-introspect existing TOOLS arrays.
router.get('/catalog', async (req, res) => {
    try {
        const userId = req.session.user.id;
        // Gather available apps for the user (best effort: present everything,
        // mark `available: true` if integrationTools.js would expose it).
        const session = req.session;
        const { getIntegrationTools } = require('../../core/integrationTools');
        // `available` is computed STRICTLY from getIntegrationTools — the same
        // authoritative gate the runtime uses (org grant ∩ group grant ∩
        // personal toggle ∩ credentials). An app counts as available only when a
        // tool it owns is actually in the user's resolved tool set, so the picker
        // never advertises an integration the user's org/group hasn't enabled.
        // Do NOT broaden this with getUserPermittedApps(): that helper fails OPEN
        // (no explicit org list → AUTO_ENABLED_APPS lets nearly everything
        // through) and would expose the whole server catalog. See memory
        // reference_routines_catalog_strict_gating.
        let userToolNames = new Set();
        try {
            const result = await getIntegrationTools({ userId, session, isAdmin: !!req.session?.isAdmin, routineStep: true });
            for (const t of (result.tools || [])) {
                if (t?.function?.name) userToolNames.add(t.function.name);
            }
        } catch (_) { /* user might not be fully set up */ }

        // Webpages aren't surfaced via getIntegrationTools (direct chat injects
        // them separately to avoid name collisions with its in-editor tools), so
        // check the beta gate directly to decide availability.
        let webpagesAvailable = false;
        try {
            const { userHasBetaFeature } = require('../../core/betaFeatures');
            webpagesAvailable = await userHasBetaFeature(userId, 'webpages', req.session);
        } catch (_) { /* default false */ }

        const apps = TOOL_REGISTRY.map(entry => {
            const tools = loadTools(entry);
            const actions = tools.map(t => {
                const name = t?.function?.name;
                if (!name) return null;
                // Resolve the integration that owns this tool so the visual
                // builder can render the brand logo on each action chip /
                // node. Falls back to the app id when no prefix matches.
                const resolved = resolveIntegration(name) || null;
                const os = getOutputSchema(name);
                return {
                    name,
                    label: name.replace(/_/g, ' '),
                    description: t.function?.description || '',
                    inputSchema: t.function?.parameters || null,
                    outputSchema: os,
                    // useUpstreamVariables (frontend) reads outputSample to seed
                    // the variable picker with realistic field names.
                    outputSample: os?.sample || null,
                    sideEffect: isSideEffect(name),
                    integrationId: resolved?.integration || entry.app,
                    integrationLabel: resolved?.label || entry.label,
                };
            }).filter(Boolean);
            const available = entry.app === 'webpages'
                ? webpagesAvailable
                : actions.some(a => userToolNames.has(a.name));
            return { id: entry.app, label: entry.label, available, actions };
        });

        // Reusable Steps (kind='block') the user may add to this automation.
        // A Step is available only when every integration it touches is
        // available to the user — otherwise the call_block would fail at run
        // time, so we hide it (matching the apps availability gate).
        let steps = [];
        try {
            const { resolveAudienceContext } = require('../../auth/audience');
            const { orgIds, userGroups } = await resolveAudienceContext(req);
            const orgIdList = orgIds === null ? [] : [...orgIds];
            const callable = await automationStore.getCallableStepsForUser(userId, { orgIds: orgIdList, userGroups: userGroups || [] });
            // Build the set of integration ids the user can use right now.
            const availableIntegrationIds = new Set();
            for (const app of apps) {
                if (!app.available) continue;
                availableIntegrationIds.add(app.id);
                for (const a of app.actions) if (a.integrationId) availableIntegrationIds.add(a.integrationId);
            }
            steps = callable.map(s => ({
                id: s.id,
                title: s.title,
                description: s.description,
                icon: s.icon || null,
                category: s.category || null,
                params: s.params,
                outputFields: s.outputFields,
                requiredIntegrations: s.requiredIntegrations,
                available: (s.requiredIntegrations || []).every(i => availableIntegrationIds.has(i)),
            }));
        } catch (e) { console.warn('[automation/catalog] steps load failed:', e.message); }

        const codeFlagRaw = await configStore.getConfig('automation_code_step_enabled');
        const codeFlag = codeFlagRaw === true || codeFlagRaw === 'true';
        // If we got here, the requireBetaFeature middleware already approved
        // the user — so this user's org has the automations feature on.
        const automationsFlag = true;
        // NOTE: layers are inline now (definition.layers) — there is no
        // catalog of standalone layer rows and no layers feature flag.

        // Trigger output field/sample catalog — useUpstreamVariables reads this
        // to expose `trigger.output.*` variables in the binding picker.
        let triggerOutputs = {};
        try { triggerOutputs = require('../../automation/builderTools').buildTriggerOutputsCatalog(); } catch (_) { /* keep empty */ }

        res.json({
            apps,
            // Reusable Steps (kind='block') addable as call_block nodes.
            steps,
            triggerOutputs,
            // Which app_event triggers fire today (pollerBacked) vs need the
            // pending Bee Flow ExApp connector (pushPending). Arrays, not Sets,
            // so the client can render honest "fires now" / "connector" hints.
            deliverability: deliverabilityForCatalog(),
            stepTypes: ['trigger', 'integration_action', 'ai_step', 'condition', 'loop', ...(codeFlag ? ['code'] : []), 'notification', ...(steps.length ? ['call_block'] : [])],
            triggers: [
                { kind: 'schedule', label: 'On a schedule' },
                { kind: 'manual', label: 'Run manually' },
                { kind: 'webhook', label: 'Webhook URL' },
                { kind: 'app_event', providers: ['gmail', 'google-calendar', 'google-drive', 'msgraph', 'github', 'nextcloud', 'ticket-assistant', 'support'] },
                { kind: 'agent_call', label: 'Callable by AI agent or direct chat (exposed as a tool)' },
            ],
            flags: { code: codeFlag, automations: automationsFlag },
        });
    } catch (e) {
        console.error('[automation/catalog] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.get('/catalog/sample/:tool', async (req, res) => {
    const tool = req.params.tool;
    const sample = synthesizeDryRunOutput(tool, {});
    res.json({ tool, sample });
});

// List automations

module.exports = router;
