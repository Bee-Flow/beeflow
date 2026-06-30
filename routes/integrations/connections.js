/**
 * Integration Connections API — named connections + sharing.
 *
 * Lets a user manage MULTIPLE named credentials per integration and LEND a
 * specific connection to a user / group / org (full delegation). Default for
 * any shared resource is bring-your-own (no grant). Org isolation is enforced
 * here AND structurally in the resolver: a grant can never cross orgs.
 *
 * Secrets are never returned by any endpoint — only presence/metadata.
 */

const express = require('express');
const store = require('../../stores/integrationConnectionStore');
const userStore = require('../../stores/userStore');
const { requireActiveOrgForMutations } = require('../../auth/permissions');

const router = express.Router();

// Suspended orgs can read their connections but not mutate them.
router.use(requireActiveOrgForMutations());

function requireAuth(req, res, next) {
    if (req.session && req.session.user && req.session.user.id) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

function isAdmin(req) {
    return !!(req.session?.isAdmin || req.session?.user?.role === 'admin');
}

const PROVIDER_RE = /^[a-z0-9][a-z0-9_:-]{0,63}$/i;
const VALID_KINDS = new Set(['oauth', 'api_key', 'basic', 'mcp']);
const VALID_GRANTEE_TYPES = new Set(['user', 'group', 'org']);
const VALID_RESOURCE_TYPES = new Set(['agent', 'webpage', 'skill', 'routine']);

// Resolve the caller's org (sentinel-normalized) + group ids.
async function callerContext(req) {
    const userId = req.session.user.id;
    const user = await userStore.getUser(userId).catch(() => null);
    const orgId = store.resolveOrgId(user?.organizationId);
    const groups = Array.isArray(user?.groups) ? user.groups : [];
    return { userId, orgId, groups, user };
}

async function ownsConnection(req, conn) {
    if (!conn) return false;
    return conn.ownerUserId === req.session.user.id || isAdmin(req);
}

// ── CRUD ────────────────────────────────────────────────────────────

// List the caller's named connections (presence-only; no secrets).
router.get('/', requireAuth, async (req, res) => {
    try {
        const provider = req.query.provider ? String(req.query.provider) : null;
        const connections = await store.listConnectionsForUser(req.session.user.id, provider);
        res.json({ connections });
    } catch (err) {
        console.error('[ConnectionsAPI] list error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Pre-flight for a recipient: which providers must they connect (BYO) vs are
// lent to them. Phase 2 takes an explicit `?providers=a,b`; Phase 3 derives the
// provider list from the resource server-side.
router.get('/required', requireAuth, async (req, res) => {
    try {
        const { userId, orgId, groups } = await callerContext(req);
        const providers = String(req.query.providers || '')
            .split(',').map(s => s.trim()).filter(Boolean);
        const resourceType = req.query.resourceType ? String(req.query.resourceType) : null;
        const resourceId = req.query.resourceId ? String(req.query.resourceId) : null;
        const requiresConnection = [];
        const lent = [];
        for (const provider of providers) {
            const r = await store.resolveConnectionForRun({
                runningUserId: userId, runningUserOrgId: orgId, runningUserGroups: groups,
                provider, resourceType, resourceId,
            });
            if (r.mode === 'delegated') lent.push({ provider, connectionLabel: r.connectionLabel });
            else if (!r.available) requiresConnection.push({ provider });
        }
        res.json({ requiresConnection, lent });
    } catch (err) {
        console.error('[ConnectionsAPI] required error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// List grants — outgoing (I lent), incoming (lent to me), or for a resource.
router.get('/grants', requireAuth, async (req, res) => {
    try {
        const { userId } = await callerContext(req);
        const mine = req.query.mine ? String(req.query.mine) : null;
        const filter = {};
        if (mine === 'outgoing') filter.grantorUserId = userId;
        else if (mine === 'incoming') filter.granteeId = userId;
        if (req.query.resourceType) filter.resourceType = String(req.query.resourceType);
        if (req.query.resourceId) filter.resourceId = String(req.query.resourceId);
        if (req.query.connectionId) filter.connectionId = String(req.query.connectionId);
        // Default to "what I lent" so we never expose others' grants.
        if (!mine && !filter.connectionId) filter.grantorUserId = userId;
        const grants = await store.listGrants(filter);
        res.json({ grants });
    } catch (err) {
        console.error('[ConnectionsAPI] grants list error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Revoke a grant — only the grantor (or admin) may.
router.delete('/grants/:grantId', requireAuth, async (req, res) => {
    try {
        const grants = await store.listGrants({ includeRevoked: true });
        const grant = grants.find(g => g.id === req.params.grantId);
        if (!grant) return res.status(404).json({ error: 'Grant not found' });
        if (grant.grantor_user_id !== req.session.user.id && !isAdmin(req)) {
            return res.status(403).json({ error: 'Only the grantor can revoke this grant' });
        }
        const ok = await store.revokeGrant(req.params.grantId);
        res.json({ revoked: ok });
    } catch (err) {
        console.error('[ConnectionsAPI] revoke error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Create a named connection.
router.post('/', requireAuth, async (req, res) => {
    try {
        const { provider, label, kind = 'api_key', secret = null, makeDefault = false } = req.body || {};
        if (!provider || !PROVIDER_RE.test(String(provider))) {
            return res.status(400).json({ error: 'Invalid provider' });
        }
        if (!VALID_KINDS.has(kind)) return res.status(400).json({ error: 'Invalid kind' });
        if (secret !== null && (typeof secret !== 'object' || Array.isArray(secret))) {
            return res.status(400).json({ error: 'secret must be an object of fields' });
        }
        const { orgId } = await callerContext(req);
        const conn = await store.createConnection({
            ownerUserId: req.session.user.id, orgId, provider: String(provider),
            label: label ? String(label).slice(0, 120) : 'Default', kind,
            secretObject: secret, makeDefault: !!makeDefault,
        });
        res.status(201).json({ connection: conn });
    } catch (err) {
        console.error('[ConnectionsAPI] create error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Rename / set-default / update secret.
router.patch('/:id', requireAuth, async (req, res) => {
    try {
        const conn = await store.getConnection(req.params.id);
        if (!conn) return res.status(404).json({ error: 'Connection not found' });
        if (!(await ownsConnection(req, conn))) return res.status(403).json({ error: 'Forbidden' });

        const { label, makeDefault, secret } = req.body || {};
        if (typeof label === 'string') await store.renameConnection(conn.id, label.slice(0, 120));
        if (secret && typeof secret === 'object' && !Array.isArray(secret)) {
            await store.updateConnectionSecret(conn.id, secret);
        }
        if (makeDefault === true) await store.setDefault(conn.id);

        res.json({ connection: await store.getConnection(conn.id) });
    } catch (err) {
        console.error('[ConnectionsAPI] patch error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Delete — blocked if it backs an active grant unless ?force=1.
router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const conn = await store.getConnection(req.params.id);
        if (!conn) return res.status(404).json({ error: 'Connection not found' });
        if (!(await ownsConnection(req, conn))) return res.status(403).json({ error: 'Forbidden' });

        const activeGrants = await store.listGrants({ connectionId: conn.id });
        if (activeGrants.length > 0 && req.query.force !== '1') {
            return res.status(409).json({ error: 'Connection is shared', grants: activeGrants.length });
        }
        const ok = await store.deleteConnection(conn.id); // ON DELETE CASCADE drops grants
        res.json({ deleted: ok });
    } catch (err) {
        console.error('[ConnectionsAPI] delete error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Share (lend) a connection — org isolation enforced.
router.post('/:id/grants', requireAuth, async (req, res) => {
    try {
        const conn = await store.getConnection(req.params.id);
        if (!conn) return res.status(404).json({ error: 'Connection not found' });
        if (!(await ownsConnection(req, conn))) return res.status(403).json({ error: 'Forbidden' });

        let { granteeType, granteeId = null, granteeEmail = null, resourceType = null, resourceId = null, expiresAt = null } = req.body || {};
        if (!VALID_GRANTEE_TYPES.has(granteeType)) return res.status(400).json({ error: 'Invalid granteeType' });

        // Convenience: resolve a teammate by email → userId (org isolation is
        // still enforced below against the resolved user).
        if (granteeType === 'user' && !granteeId && granteeEmail) {
            const byEmail = await userStore.getUserByEmail(String(granteeEmail).trim()).catch(() => null);
            if (!byEmail) return res.status(404).json({ error: 'No user with that email' });
            granteeId = byEmail.id;
        }
        if (resourceType !== null && !VALID_RESOURCE_TYPES.has(resourceType)) {
            return res.status(400).json({ error: 'Invalid resourceType' });
        }
        if ((resourceType === null) !== (resourceId === null)) {
            return res.status(400).json({ error: 'resourceType and resourceId must be set together' });
        }

        const ownerOrg = conn.orgId; // authoritative owner org (sentinel-normalized at create)

        // ── Org isolation: the grantee must live in the connection's org ──
        if (granteeType === 'user') {
            if (!granteeId) return res.status(400).json({ error: 'granteeId required for a user grant' });
            const grantee = await userStore.getUser(granteeId).catch(() => null);
            if (!grantee) return res.status(404).json({ error: 'Grantee user not found' });
            if (store.resolveOrgId(grantee.organizationId) !== ownerOrg) {
                return res.status(403).json({ error: 'Cross-org sharing is not allowed' });
            }
        } else if (granteeType === 'group') {
            if (!granteeId) return res.status(400).json({ error: 'granteeId required for a group grant' });
            const groups = await userStore.getAllGroups().catch(() => []);
            const group = groups.find(g => g.id === granteeId);
            if (!group) return res.status(404).json({ error: 'Grantee group not found' });
            if (store.resolveOrgId(group.organizationId) !== ownerOrg) {
                return res.status(403).json({ error: 'Cross-org sharing is not allowed' });
            }
        } else if (granteeType === 'org') {
            // Only the owner's own org. granteeId is the org id (or null = own org).
            granteeId = null;
        }

        const grant = await store.shareConnection({
            connectionId: conn.id, grantorUserId: req.session.user.id,
            granteeType, granteeId, resourceType, resourceId,
            expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        });
        res.status(201).json({ grant });
    } catch (err) {
        console.error('[ConnectionsAPI] share error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
