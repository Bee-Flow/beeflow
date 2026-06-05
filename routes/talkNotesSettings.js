/**
 * Nextcloud Talk → Meeting Notes settings API.
 *
 * Org-level (admin-managed) and user-level (self-managed) toggles that gate
 * auto-transcription of Talk recordings and write-back of the summary into the
 * Talk conversation. Storage + resolution live in
 * `server/core/meetingNotes/talkNotesSettings.js`. Auth mirrors
 * `server/routes/orgPrivacyShield.js`.
 */

const express = require('express');
const router = express.Router();
const userStore = require('../stores/userStore');
const { resolveUserOrgIds, isOrgAdminRole } = require('../auth');
const talkNotes = require('../core/meetingNotes/talkNotesSettings');

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

async function isOrgAdmin(req, orgId) {
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return true;
    const userId = req.session?.user?.id;
    if (!userId) return false;
    const user = await userStore.getUser(userId);
    if (!user) return false;
    if (user.organizationId === orgId && isOrgAdminRole(user.orgRole)) return true;
    let groupIds = [];
    if (Array.isArray(user.groups)) groupIds = user.groups;
    else { try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { } }
    const allGroups = await userStore.getAllGroups();
    for (const gid of groupIds) {
        const group = allGroups.find(g => g.id === gid);
        if (group?.organizationId === orgId) {
            const perms = Array.isArray(group.permissions) ? group.permissions : [];
            const roles = Array.isArray(group.roles) ? group.roles : [];
            if (perms.includes('all') || perms.includes('admin') || roles.includes('admin') || roles.includes('org_admin')) return true;
        }
    }
    return false;
}

// ── User-level (consumer / self) ─────────────────────────
// Declared before /:orgId so "user" isn't captured as an orgId param.
router.get('/user/me', requireAuth, async (req, res) => {
    try {
        const config = await talkNotes.getUserSettings(req.session.user.id);
        res.json(config);
    } catch (e) {
        console.error('[TalkNotesSettings] user GET error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.put('/user/me', requireAuth, async (req, res) => {
    try {
        const config = await talkNotes.saveUserSettings(req.session.user.id, req.body || {});
        res.json({ ok: true, config });
    } catch (e) {
        console.error('[TalkNotesSettings] user PUT error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Org-level (admin) ────────────────────────────────────
router.get('/:orgId', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.params;
        const orgIds = await resolveUserOrgIds(req);
        const isMember = orgIds === null || (orgIds && orgIds.has(orgId));
        if (!isMember) return res.status(403).json({ error: 'Not a member of this organization' });
        const config = await talkNotes.getOrgSettings(orgId);
        res.json(config);
    } catch (e) {
        console.error('[TalkNotesSettings] org GET error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.put('/:orgId', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.params;
        if (!(await isOrgAdmin(req, orgId))) {
            return res.status(403).json({ error: 'Only organization admins can manage these settings' });
        }
        const config = await talkNotes.saveOrgSettings(orgId, req.body || {}, req.session.user.id);
        res.json({ ok: true, config });
    } catch (e) {
        console.error('[TalkNotesSettings] org PUT error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
