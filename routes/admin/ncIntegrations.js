/**
 * Org-admin endpoints for Nextcloud integration management.
 *
 * Lets the NC org-admin toggle the 11 Nextcloud tools for the whole org and
 * opt specific groups out of specific tools (e.g. "Stagiairs cannot use Talk").
 *
 * Whitelist: only NC-prefix integration IDs may be written here. Non-NC
 * integrations stay super-admin only — see PUT /auth/organizations/:id in
 * server/auth/adminRoutes.js.
 *
 * Conflict resolution at tool-resolve time is "enable wins": a user only
 * loses access to a tool if EVERY group they belong to has the tool in its
 * disabled_integrations list. See server/core/integrationTools.js isAppOn().
 */

const express = require('express');
const router = express.Router();

const userStore = require('../../stores/userStore');
const guardrailEventStore = require('../../stores/guardrailEventStore');
const { requireAuth, requireOrgAdmin } = require('../../auth/permissions');
const { NC_INTEGRATIONS, NC_INTEGRATION_IDS, isNcIntegrationId, filterToNcIds } = require('../../core/ncIntegrationCatalog');

// Augment requireOrgAdmin with a "must be NC-bound" check so this whole
// surface is unreachable for standalone orgs even if a malicious caller
// guesses the URL.
async function requireNcOrg(req, res, next) {
    const orgId = req.params.orgId;
    const org = await userStore.getOrganization(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    if (!org.nc_instance_id) return res.status(400).json({ error: 'Organization is not bound to a Nextcloud instance' });
    req.org = org;
    next();
}

// ─── Org-level integration toggles ──────────────────────────────────────────

router.get('/admin/:orgId/nc-integrations', requireAuth, requireOrgAdmin('orgId'), requireNcOrg, async (req, res) => {
    const o = req.org;
    // org.enabledIntegrations may be NULL ("inherit defaults"), an array, or
    // a JSON string depending on store path. parseOrg in userStore does NOT
    // currently parse it, so be defensive here.
    let enabledRaw = o.enabledIntegrations;
    if (typeof enabledRaw === 'string') {
        try { enabledRaw = JSON.parse(enabledRaw); } catch { enabledRaw = null; }
    }
    // null = inherit defaults — for the UI we treat that as "all NC tools on"
    // so the org-admin sees a fresh-install state with everything enabled.
    const enabled = Array.isArray(enabledRaw)
        ? enabledRaw.filter(isNcIntegrationId)
        : NC_INTEGRATION_IDS.slice();
    res.json({
        organizationId: o.id,
        ncCatalog: NC_INTEGRATIONS,
        enabled,
        usingDefaults: !Array.isArray(enabledRaw),
    });
});

router.put('/admin/:orgId/nc-integrations', requireAuth, requireOrgAdmin('orgId'), requireNcOrg, express.json(), async (req, res) => {
    const o = req.org;
    const requested = filterToNcIds(req.body?.enabled);
    // Merge: keep any non-NC entries that may already be on the org (those
    // are super-admin territory) and replace only the NC slice with the new
    // request.
    let current = o.enabledIntegrations;
    if (typeof current === 'string') {
        try { current = JSON.parse(current); } catch { current = null; }
    }
    const nonNc = Array.isArray(current) ? current.filter(id => !isNcIntegrationId(id)) : [];
    const merged = [...nonNc, ...requested];
    await userStore.updateOrganization(o.id, { enabledIntegrations: merged });

    guardrailEventStore.logGuardrailEvent({
        organization_id: o.id,
        user_id: req.session?.user?.id || null,
        violation_type: 'admin_action',
        violation_categories: 'nc_integrations:org',
        direction: 'input',
        action_taken: `set:[${requested.join(',')}]`,
        source: 'org_admin',
    }).catch(() => {});

    res.json({ ok: true, enabled: requested });
});

// ─── Per-group exceptions ───────────────────────────────────────────────────

router.get('/admin/:orgId/nc-integrations/groups', requireAuth, requireOrgAdmin('orgId'), requireNcOrg, async (req, res) => {
    const orgId = req.params.orgId;
    const allGroups = await userStore.getAllGroups();
    // Only NC-source groups belong on this UI; org-local groups (Bee Flow
    // roles, manual groups) aren't part of the NC sync surface.
    const ncGroups = allGroups.filter(g => g.organizationId === orgId && g.source === 'nextcloud');
    // user-count is best-effort: walk users once.
    const allUsers = await userStore.getAllUsers();
    const countByGroup = new Map();
    for (const u of allUsers) {
        if (u.organizationId !== orgId) continue;
        const groups = Array.isArray(u.groups) ? u.groups : [];
        for (const gid of groups) countByGroup.set(gid, (countByGroup.get(gid) || 0) + 1);
    }
    res.json({
        groups: ncGroups.map(g => ({
            id: g.id,
            name: g.name,
            source: g.source,
            disabledIntegrations: Array.isArray(g.disabled_integrations) ? g.disabled_integrations : [],
            userCount: countByGroup.get(g.id) || 0,
        })),
    });
});

router.put('/admin/:orgId/nc-integrations/groups/:groupId', requireAuth, requireOrgAdmin('orgId'), requireNcOrg, express.json(), async (req, res) => {
    const { orgId, groupId } = req.params;
    const groups = await userStore.getAllGroups();
    const group = groups.find(g => g.id === groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (group.organizationId !== orgId) return res.status(403).json({ error: 'Group does not belong to this organisation' });

    const disabled = filterToNcIds(req.body?.disabledIntegrations);
    const ok = await userStore.updateGroup(groupId, { disabledIntegrations: disabled });
    if (!ok) return res.status(500).json({ error: 'Could not update group' });

    guardrailEventStore.logGuardrailEvent({
        organization_id: orgId,
        user_id: req.session?.user?.id || null,
        violation_type: 'admin_action',
        violation_categories: `nc_integrations:group:${groupId}`,
        direction: 'input',
        action_taken: `set:[${disabled.join(',')}]`,
        source: 'org_admin',
    }).catch(() => {});

    res.json({ ok: true, groupId, disabledIntegrations: disabled });
});

module.exports = router;
