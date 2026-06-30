/**
 * Webpage Routes — CRUD for webpages + source management + versions.
 *
 * Endpoints:
 *   POST   /                    — create webpage
 *   GET    /                    — list user's webpages
 *   GET    /:id                 — get webpage detail (metadata + html/css/js bytes)
 *   PUT    /:id                 — update webpage (metadata and/or file slots)
 *   POST   /:id/clone           — duplicate webpage (skips publishing scope + external shares)
 *   DELETE /:id                 — delete webpage (purges DB rows + RustFS objects)
 *   POST   /:id/sources/file    — upload file source (pdf, docx, xlsx, txt, …)
 *   POST   /:id/sources/url     — add URL source
 *   POST   /:id/sources/text    — paste text source
 *   POST   /:id/sources/drive   — import from Google Drive / OneDrive
 *   GET    /:id/sources         — list sources
 *   POST   /:id/sources/:sid/retry  — retry a failed/cancelled source
 *   POST   /:id/sources/:sid/cancel — cancel a stuck source
 *   DELETE /:id/sources/:sid    — remove source
 *   GET    /:id/versions        — list version snapshots (metadata only)
 *   GET    /:id/versions/:vid   — get a single version (full file trio)
 *   POST   /:id/versions        — create a manual snapshot
 *   POST   /:id/versions/:vid/restore — restore a previous snapshot
 *   DELETE /:id/versions/:vid   — delete a version
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');

const webpageStore = require('../stores/webpageStore');
const storageStore = require('../stores/storageStore');
const webpageDbStore = require('../stores/webpageDbStore');
const publicShareStore = require('../stores/webpagePublicShareStore');
const webpageSnapshot = require('../services/webpageSnapshot');
const { issuePreviewToken, requirePreviewToken } = require('../auth/webpagePreviewToken');
const kbStore = require('../stores/knowledgeBases');
const { resolveAudienceContext } = require('../auth/audience');
const { hasPermission, validateSharedGroupsForOrg, requireActiveOrgForMutations } = require('../auth');
const userStore = require('../stores/userStore');
const {
    ingestFileSource,
    ingestUrlSource,
    ingestTextSource,
    ingestDriveSource,
} = require('../agents/webpages/sourceIngestion');
const { deleteDocumentChunks, findDocumentBySourceUri } = require('../core/kbIngestionHelpers');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function requireAuth(req, res, next) {
    if (req.session?.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// Re-snapshot every active public share for a webpage so published pages
// reflect the latest content. Fire-and-forget — never blocks the response.
// Originally only the primary-slot save (PUT /:id) triggered this, but a
// react-mui app lives ENTIRELY in extra files, so it must also run on
// extra-file edits or react shares would render the version captured at share
// creation forever. `ownerId` is the page owner (all callers here are
// owner-only mutations).
function reSnapshotWebpageShares(webpageId, ownerId) {
    (async () => {
        try {
            const shares = await publicShareStore.listSharesForWebpage(webpageId, ownerId);
            for (const sh of (shares || [])) {
                if (sh.revokedAt) continue;
                await webpageSnapshot.writeSnapshot({ shareId: sh.id, webpageId, ownerId })
                    .catch(e => console.warn(`[Webpages] re-snapshot failed for share ${sh.id}:`, e.message));
            }
        } catch (e) {
            console.warn('[Webpages] re-snapshot enumeration failed:', e.message);
        }
    })();
}

// Access control: the beta-feature gate at server/index.js (`requireBetaFeature('webpages')`)
// is the single source of truth. The previous `requirePermission('use_webpages')` here was
// redundant and blocked org members who had the beta enabled but not the legacy permission.

// Block writes when the caller's org is suspended/archived.
router.use(requireActiveOrgForMutations());

// ── Webpage CRUD ──────────────────────────────────────────────────

router.post('/', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { name, description, instructions, framework, runtime } = req.body;
        // Record the framework + runtime tier in settings so the chat handler and
        // preview pipeline know how to build this project. Absent/invalid values
        // fall back to the safe defaults (vanilla/light) — see webpageFramework.js.
        const { FRAMEWORKS, RUNTIMES, DEFAULT_NEW_FRAMEWORK, DEFAULT_RUNTIME } = require('../integrations/webpageFramework');
        const settings = {
            framework: FRAMEWORKS.includes(framework) ? framework : DEFAULT_NEW_FRAMEWORK,
            runtime: RUNTIMES.includes(runtime) ? runtime : DEFAULT_RUNTIME,
        };
        const webpage = await webpageStore.createWebpage({ userId, name, description, instructions, settings });
        res.json({ success: true, webpage });
    } catch (err) {
        console.error('[Webpages] Create failed:', err);
        res.status(500).json({ error: 'Failed to create webpage' });
    }
});

router.get('/', requireAuth, async (req, res) => {
    try {
        const { userId, orgIds, userGroups } = await resolveAudienceContext(req);
        // resolveUserOrgIds returns null for super-admin (sees everything in scope);
        // collapse to [] so the SQL ANY($orgIds) doesn't blow up — super-admins fall
        // through to their own webpages plus anything they own.
        const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
        const webpages = await webpageStore.getAccessibleWebpages(userId, userGroups, orgIdArr);
        res.json({ webpages });
    } catch (err) {
        console.error('[Webpages] List failed:', err);
        res.status(500).json({ error: 'Failed to list webpages' });
    }
});

router.get('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        // Try owner-scoped read first (preserves owner-only RustFS path).
        let webpage = await webpageStore.getWebpage(req.params.id, userId);
        if (!webpage) {
            // Owner mismatch — check published visibility.
            const raw = await webpageStore.getWebpageRaw(req.params.id);
            const { orgIds, userGroups } = await resolveAudienceContext(req);
            const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
            if (raw && webpageStore.canReadWebpage(raw, userId, userGroups, orgIdArr)) {
                webpage = raw;
            }
        }
        if (!webpage) return res.status(404).json({ error: 'Webpage not found' });
        // Files / sources / chat live under the OWNER's RustFS prefix, not the
        // caller's — read with webpage.userId so org-viewers see the same bytes.
        const ownerId = webpage.userId;
        // Avoid the rest of the handler still referencing `userId` for owner ops.
        var effectiveOwnerId = ownerId; // eslint-disable-line no-var

        await webpageStore.timeoutStuckSources(webpage.id).catch(() => {});

        const [sources, files, chatMessages, extraFiles] = await Promise.all([
            webpageStore.getSources(webpage.id),
            webpageStore.readAllSlots(effectiveOwnerId, webpage.id),
            // Chat history is per-owner; non-owner viewers get an empty array
            // (don't leak the owner's chat with the AI builder).
            webpage.userId === userId ? webpageStore.getChatMessages(webpage.id, userId) : Promise.resolve([]),
            webpageStore.listExtraFiles(webpage.id),
        ]);
        res.json({ webpage, sources, files, chatMessages, extraFiles, readOnly: webpage.userId !== userId });
    } catch (err) {
        console.error('[Webpages] Get failed:', err);
        res.status(500).json({ error: 'Failed to get webpage' });
    }
});

router.put('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const id = req.params.id;
        const {
            name, description, instructions, settings, knowledgeBaseIds,
            html, css, js,
        } = req.body;

        const wp = await webpageStore.getWebpage(id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        // Determine which slots actually changed (by sha256). Skip RustFS round-trip
        // for unchanged slots so a metadata-only PUT doesn't re-upload all three files.
        const incoming = { html, css, js };
        const current = { html: wp.htmlSha, css: wp.cssSha, js: wp.jsSha };
        const slotUpdates = {};
        for (const slot of webpageStore.SLOTS) {
            if (incoming[slot] === undefined) continue;
            const newSha = webpageStore.sha256(incoming[slot] || '');
            if (newSha !== current[slot]) {
                slotUpdates[slot] = { content: incoming[slot] || '', sha: newSha };
            }
        }

        // Auto-version: if any slot is changing AND debounce elapsed AND there's
        // existing content to snapshot, copy "current/*" → "versions/{vid}/*".
        if (Object.keys(slotUpdates).length > 0) {
            const hasExistingContent = wp.htmlSize + wp.cssSize + wp.jsSize > 0;
            if (hasExistingContent) {
                try {
                    const should = await webpageStore.shouldAutoVersion(id);
                    if (should) {
                        await webpageStore.createVersion(userId, id, 'Auto-save', {
                            htmlSha: wp.htmlSha,
                            cssSha: wp.cssSha,
                            jsSha: wp.jsSha,
                            contentLength: wp.htmlSize + wp.cssSize + wp.jsSize,
                        });
                    }
                } catch (vErr) {
                    console.warn('[Webpages] Auto-version failed:', vErr.message);
                }
            }
        }

        // Persist each changed slot to RustFS.
        const metadataUpdate = { name, description, instructions, settings, knowledgeBaseIds };
        for (const [slot, { content }] of Object.entries(slotUpdates)) {
            const { sha, size } = await webpageStore.writeSlot(userId, id, slot, content);
            metadataUpdate[`${slot}Sha`] = sha;
            metadataUpdate[`${slot}Size`] = size;
        }

        // Re-snapshot any active public shares so a published page reflects the
        // edit immediately. The snapshot used to be written only at share
        // creation, so recipients saw the stale version until they cleared their
        // browser cache (BFSF-190). Fire-and-forget — never blocks the save.
        if (Object.keys(slotUpdates).length > 0) {
            reSnapshotWebpageShares(id, userId);
        }

        const ok = await webpageStore.updateWebpageMetadata(id, userId, metadataUpdate);
        if (!ok && Object.keys(slotUpdates).length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[Webpages] Update failed:', err);
        res.status(500).json({ error: 'Failed to update webpage: ' + err.message });
    }
});

// ── Thumbnail (rendered preview) ────────────────────────────────────

router.get('/:id/thumbnail', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        // Same visibility logic as GET /:id — owner OR org/group-published.
        let webpage = await webpageStore.getWebpage(req.params.id, userId);
        if (!webpage) {
            const raw = await webpageStore.getWebpageRaw(req.params.id);
            const { orgIds, userGroups } = await resolveAudienceContext(req);
            const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
            if (raw && webpageStore.canReadWebpage(raw, userId, userGroups, orgIdArr)) {
                webpage = raw;
            }
        }
        if (!webpage) return res.status(404).end();
        if (!webpage.thumbnailSha) return res.status(404).end();
        const bytes = await webpageStore.readThumbnail(webpage.userId, webpage.id);
        if (!bytes) return res.status(404).end();
        // We may have written a JPEG (sharp path) or a raw PNG (no-sharp
        // fallback). Sniff the first byte to pick the right Content-Type.
        const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
        res.setHeader('Content-Type', isJpeg ? 'image/jpeg' : 'image/png');
        res.setHeader('Cache-Control', 'private, max-age=60');
        res.setHeader('ETag', `"${webpage.thumbnailSha}"`);
        if (req.headers['if-none-match'] === `"${webpage.thumbnailSha}"`) {
            return res.status(304).end();
        }
        return res.end(bytes);
    } catch (err) {
        console.error('[Webpages] Thumbnail fetch failed:', err);
        return res.status(500).end();
    }
});

// ── Publish (org/group visibility) ──────────────────────────────────

router.patch('/:id/publish', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpageRaw(req.params.id);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        // Non-owners need manage_webpages OR admin role.
        const isAdmin = req.session?.isAdmin || req.session?.user?.role === 'admin';
        if (wp.userId !== userId && !isAdmin) {
            const ok = await hasPermission(userId, 'manage_webpages', req.session);
            if (!ok) return res.status(403).json({ error: 'Permission denied' });
        }

        const { isPublished, sharedGroups } = req.body || {};

        // NOTE: React + Material UI pages ARE publishable to an org/group. That
        // audience views the page as authenticated users through the same
        // framework-aware, sandboxed preview the owner uses (WebpagePreview →
        // buildWebpagePreview), which bundles + runs the React app. The JS-
        // stripping that would blank a React page applies ONLY to the anonymous
        // `/share/:token` snapshot (webpageSnapshot.writeSnapshot omits JS by
        // design) — a separate, opt-in external-share flow, not this publish.

        // Stamp organization_id on first publish. When publishing to specific
        // groups, derive the org from THOSE groups — not from the owner's
        // primary org. The owner can be in multiple orgs; the groups define
        // which org's audience the page is visible to. Without this, group
        // members in a non-primary org of the owner silently never see the
        // page because the visibility SQL requires an exact org match.
        let organizationId;
        if (!!isPublished && !wp.organizationId) {
            const incomingGroups = Array.isArray(sharedGroups)
                ? sharedGroups.map(g => String(g)).filter(Boolean)
                : [];

            if (incomingGroups.length > 0) {
                // Specific-groups publish — the groups dictate the org. Validate
                // that every sharedGroup exists and that they all share a single
                // org; otherwise the visibility model breaks (one row = one org).
                const allGroups = await userStore.getAllGroups();
                const byId = new Map(allGroups.map(g => [g.id, g]));
                const orgs = new Set();
                for (const gid of incomingGroups) {
                    const g = byId.get(gid);
                    if (!g) return res.status(400).json({ error: `Unknown group: ${gid}` });
                    if (g.organizationId) orgs.add(g.organizationId);
                }
                if (orgs.size === 0) {
                    return res.status(400).json({ error: 'Cannot publish: shared groups have no organisation' });
                }
                if (orgs.size > 1) {
                    return res.status(400).json({ error: 'Cannot publish to groups across multiple organisations' });
                }
                organizationId = [...orgs][0];
            } else {
                // Entire-org publish (sharedGroups empty / undefined) — fall back
                // to the owner's primary org, then their first group's org if
                // the user record has no direct organizationId set.
                const owner = await userStore.getUser(wp.userId);
                organizationId = owner?.organizationId || null;
                if (!organizationId) {
                    const groups = Array.isArray(owner?.groups) ? owner.groups
                        : (() => { try { return JSON.parse(owner?.groups || '[]'); } catch { return []; } })();
                    if (groups.length > 0) {
                        const allGroups = await userStore.getAllGroups();
                        const g = allGroups.find(x => groups.includes(x.id) && x.organizationId);
                        organizationId = g?.organizationId || null;
                    }
                }
                if (!organizationId) {
                    return res.status(400).json({ error: 'Cannot publish: owner has no organisation' });
                }
            }
        }

        // Validate sharedGroups belong to the webpage's org (existing org
        // sticks; new org applies on first publish). Undefined → leave as-is.
        const effectiveOrg = wp.organizationId || organizationId || null;
        let cleanedGroups;
        try {
            cleanedGroups = await validateSharedGroupsForOrg(effectiveOrg, sharedGroups);
        } catch (e) {
            return res.status(e.status || 500).json({ error: e.message });
        }

        const ok = await webpageStore.setWebpagePublished(
            req.params.id, isPublished, wp.userId, cleanedGroups, organizationId
        );
        if (!ok) return res.status(500).json({ error: 'Failed to update published status' });
        res.json({ success: true, isPublished, sharedGroups: cleanedGroups });
    } catch (err) {
        console.error('[Webpages] Publish failed:', err);
        res.status(500).json({ error: 'Failed to update publish state' });
    }
});

// ── External (public) shares ────────────────────────────────────────
//
// Owner-managed share links that publish a sanitized snapshot of the page to
// anonymous viewers. Strictly opt-in per share: every link is a separate row
// with its own access mode, expiry, and audit trail. Recipients are NOT Bee
// Flow users; the public viewer route at /share/:token handles them.

const PUBLIC_SHARE_BASE_URL = process.env.PUBLIC_SHARE_BASE_URL || process.env.PUBLIC_APP_URL || '';
function buildShareUrl(req, rawToken) {
    // Prefer an explicit env override (e.g. https://beeflow.nl) so that
    // links emailed from server-side environments don't end up pointing at
    // localhost. Fall back to the request's own origin so dev works.
    const base = PUBLIC_SHARE_BASE_URL
        || `${req.protocol}://${req.get('host') || ''}`;
    return `${base.replace(/\/+$/, '')}/share/${rawToken}`;
}

function parseExpiresAt(input) {
    if (input === null || input === '' || input === undefined) return null;
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) throw new Error('Invalid expires_at');
    if (d.getTime() < Date.now() + 60_000) throw new Error('expires_at must be in the future');
    return d;
}

// List external shares for a webpage. The owner sees their own shares in full;
// a non-owner who can READ the page (org/group-published) sees that the page has
// links and their status, but not the owner's chosen recipient emails (BFSF-188).
// Creating/refreshing/revoking links stays owner-only (handlers below).
router.get('/:id/public-shares', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        // Owner-scoped first (preserves owner-only semantics); fall back to the
        // same read-visibility check used by GET /:id for published pages.
        let wp = await webpageStore.getWebpage(req.params.id, userId);
        let isOwner = !!wp;
        if (!wp) {
            const raw = await webpageStore.getWebpageRaw(req.params.id);
            const { orgIds, userGroups } = await resolveAudienceContext(req);
            const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
            if (raw && webpageStore.canReadWebpage(raw, userId, userGroups, orgIdArr)) wp = raw;
        }
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        const shares = await publicShareStore.listSharesForWebpage(req.params.id, isOwner ? userId : null);
        // Don't leak the owner's recipient allow-list to other org members.
        const safeShares = isOwner ? shares : shares.map(({ allowedEmails, ...rest }) => rest);
        // Attach the share URL where the raw token is recoverable (encrypted
        // at rest, BFSF-188). Legacy/revoked/expired shares get url: null —
        // findByToken independently rejects dead tokens at view time anyway.
        const tokens = await publicShareStore.getRetrievableTokens(req.params.id);
        const now = Date.now();
        const withUrls = safeShares.map(s => ({
            ...s,
            url: (tokens[s.id] && !s.revokedAt && !(s.expiresAt && new Date(s.expiresAt).getTime() < now))
                ? buildShareUrl(req, tokens[s.id])
                : null,
        }));
        res.json({ shares: withUrls });
    } catch (err) {
        console.error('[Webpages] List public shares failed:', err);
        res.status(500).json({ error: 'Failed to list public shares' });
    }
});

// Create a new external share. Body: { accessMode, password?, allowedEmails?, expiresAt?, title? }
// Returns the raw URL exactly once — the client must show it to the user;
// the server only stores its sha256.
router.post('/:id/public-shares', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const { accessMode = 'unlisted', password, allowedEmails, expiresAt, title } = req.body || {};
        let expiry;
        try { expiry = parseExpiresAt(expiresAt); }
        catch (e) { return res.status(400).json({ error: e.message }); }

        const { share, rawToken } = await publicShareStore.createShare({
            webpageId: wp.id,
            createdBy: userId,
            organizationId: wp.organizationId || null,
            accessMode,
            password,
            allowedEmails,
            expiresAt: expiry,
            title: title || wp.name || '',
        });

        // Capture the sanitized snapshot synchronously so the link works the
        // moment the publisher copies it. Owner of the bytes is wp.userId
        // (the webpage owner), which equals userId here — non-owner publishes
        // are blocked by the getWebpage owner-scoped lookup above.
        try {
            await webpageSnapshot.writeSnapshot({
                shareId: share.id,
                webpageId: wp.id,
                ownerId: wp.userId,
            });
        } catch (snapErr) {
            // Roll back the share row so we don't leave a token pointing at
            // a missing snapshot.
            await publicShareStore.deleteShare(share.id, userId).catch(() => {});
            console.error('[Webpages] Snapshot failed:', snapErr);
            return res.status(500).json({ error: 'Failed to snapshot webpage: ' + snapErr.message });
        }

        res.json({
            success: true,
            share,
            url: buildShareUrl(req, rawToken),
            // The raw token is shown to the user once for copy-to-clipboard.
            // Subsequent GETs return only the share metadata, never this.
            rawToken,
        });
    } catch (err) {
        console.error('[Webpages] Create public share failed:', err);
        res.status(400).json({ error: err.message || 'Failed to create public share' });
    }
});

// Re-snapshot an existing share so it reflects the current webpage. Keeps
// the same token (recipients' links stay valid) but refreshes the bytes.
router.post('/:id/public-shares/:shareId/refresh', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        const share = await publicShareStore.getShareById(req.params.shareId);
        if (!share || share.webpageId !== wp.id || share.createdBy !== userId) {
            return res.status(404).json({ error: 'Share not found' });
        }
        if (share.revokedAt) return res.status(400).json({ error: 'Cannot refresh a revoked share' });
        await webpageSnapshot.writeSnapshot({
            shareId: share.id,
            webpageId: wp.id,
            ownerId: wp.userId,
        });
        res.json({ success: true });
    } catch (err) {
        console.error('[Webpages] Refresh public share failed:', err);
        res.status(500).json({ error: 'Failed to refresh share' });
    }
});

// Update expiry. PATCH body: { expiresAt: ISO|null }
router.patch('/:id/public-shares/:shareId', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        const share = await publicShareStore.getShareById(req.params.shareId);
        if (!share || share.webpageId !== wp.id || share.createdBy !== userId) {
            return res.status(404).json({ error: 'Share not found' });
        }
        if (Object.prototype.hasOwnProperty.call(req.body || {}, 'expiresAt')) {
            let expiry;
            try { expiry = parseExpiresAt(req.body.expiresAt); }
            catch (e) { return res.status(400).json({ error: e.message }); }
            await publicShareStore.updateExpiry(share.id, userId, expiry);
        }
        const updated = await publicShareStore.getShareById(share.id);
        res.json({ success: true, share: updated });
    } catch (err) {
        console.error('[Webpages] Update public share failed:', err);
        res.status(500).json({ error: 'Failed to update share' });
    }
});

// Revoke (soft-delete: marks revoked_at, snapshot is also purged).
router.delete('/:id/public-shares/:shareId', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        const share = await publicShareStore.getShareById(req.params.shareId);
        if (!share || share.webpageId !== wp.id || share.createdBy !== userId) {
            return res.status(404).json({ error: 'Share not found' });
        }
        // Always revoke the row first so the token stops working immediately,
        // even if the snapshot purge takes time / fails.
        await publicShareStore.revokeShare(share.id, userId);
        await publicShareStore.deleteShare(share.id, userId).catch(() => {});
        res.json({ success: true });
    } catch (err) {
        console.error('[Webpages] Revoke public share failed:', err);
        res.status(500).json({ error: 'Failed to revoke share' });
    }
});

// ── Extra files (multi-file projects) ────────────────────────────────
// Read content of one extra file. Used by the frontend to fetch the bytes
// for the live preview and the file-explorer detail view.
router.get('/:id/files', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        // Owner OR org/group-published reader — same visibility as GET /:id, so
        // shared-page viewers can load the React src/ files their preview needs.
        let wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) {
            const raw = await webpageStore.getWebpageRaw(req.params.id);
            const { orgIds, userGroups } = await resolveAudienceContext(req);
            const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
            if (raw && webpageStore.canReadWebpage(raw, userId, userGroups, orgIdArr)) {
                wp = raw;
            }
        }
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        // Extra-file bytes live under the OWNER's RustFS prefix, not the caller's.
        const ownerId = wp.userId;
        const path = req.query.path;
        if (!path) {
            const list = await webpageStore.listExtraFiles(req.params.id);
            return res.json({ files: list });
        }
        const file = await webpageStore.readExtraFile({ webpageId: req.params.id, userId: ownerId, path });
        if (!file) return res.status(404).json({ error: 'File not found' });
        if (file.meta.isText) {
            return res.json({ meta: file.meta, content: file.text });
        }
        // Binary: return base64 so the frontend can build a data URL.
        return res.json({ meta: file.meta, contentBase64: file.bytes.toString('base64') });
    } catch (err) {
        console.error('[Webpages] Get extra file failed:', err);
        res.status(500).json({ error: 'Failed to get file' });
    }
});

// Upsert content of one extra text file. Owner-only — read-only viewers
// must keep using the AI tools to mutate files.
router.put('/:id/files', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        if (wp.userId !== userId) return res.status(403).json({ error: 'Read-only' });
        const { path, content } = req.body || {};
        if (typeof path !== 'string' || !path.trim()) return res.status(400).json({ error: 'path is required' });
        if (typeof content !== 'string') return res.status(400).json({ error: 'content is required (string)' });
        const file = await webpageStore.upsertExtraFile({
            webpageId: req.params.id,
            userId,
            path: path.trim(),
            content,
        });
        // React-mui apps live in extra files, so refresh public-share snapshots.
        reSnapshotWebpageShares(req.params.id, userId);
        res.json({ file });
    } catch (err) {
        // upsertExtraFile validates the path and surfaces clear messages
        // (reserved paths, traversal attempts) — pass those through as 400s.
        const status = /^(Reserved|Invalid|Path)/i.test(err.message) ? 400 : 500;
        if (status === 500) console.error('[Webpages] Put extra file failed:', err);
        res.status(status).json({ error: err.message || 'Failed to save file' });
    }
});

// Delete one extra file. Owner-only.
router.delete('/:id/files', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        if (wp.userId !== userId) return res.status(403).json({ error: 'Read-only' });
        const path = req.query.path;
        if (typeof path !== 'string' || !path.trim()) return res.status(400).json({ error: 'path is required' });
        const ok = await webpageStore.deleteExtraFile({ webpageId: req.params.id, userId, path: path.trim() });
        if (!ok) return res.status(404).json({ error: 'File not found' });
        reSnapshotWebpageShares(req.params.id, userId);
        res.json({ success: true });
    } catch (err) {
        console.error('[Webpages] Delete extra file failed:', err);
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

// Upload a BINARY asset (image, font, audio, …) as an extra file. Multipart so
// raw bytes never round-trip through JSON/base64 in the request. Owner-only.
// Returns the file meta + base64 content so the client can build a data: URL
// for the preview without a follow-up GET. The store derives the MIME from the
// path extension and stores it as a binary (is_text=false) extra.
router.post('/:id/assets', requireAuth, upload.single('file'), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        if (wp.userId !== userId) return res.status(403).json({ error: 'Read-only' });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const path = (req.body?.path || '').trim();
        if (!path) return res.status(400).json({ error: 'path is required' });
        const file = await webpageStore.upsertBinaryExtraFile({
            webpageId: req.params.id,
            userId,
            path,
            buffer: req.file.buffer,
            mimeType: req.file.mimetype,
        });
        // Binary assets are inlined into the react bundle, so refresh snapshots.
        reSnapshotWebpageShares(req.params.id, userId);
        res.json({ file, contentBase64: req.file.buffer.toString('base64') });
    } catch (err) {
        const status = /(primary slot|relative|may not|contains|too long|required|empty|segment)/i.test(err.message) ? 400 : 500;
        if (status === 500) console.error('[Webpages] Asset upload failed:', err);
        res.status(status).json({ error: err.message || 'Failed to upload asset' });
    }
});

// Move/rename an extra file server-side (text OR binary) without round-tripping
// bytes through the client. Owner-only. Reads the source, writes it at the new
// path, then deletes the source.
router.post('/:id/assets/move', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        if (wp.userId !== userId) return res.status(403).json({ error: 'Read-only' });
        const from = (req.body?.from || '').trim();
        const to = (req.body?.to || '').trim();
        if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
        if (from === to) return res.status(400).json({ error: 'from and to are identical' });
        const existingDest = await webpageStore.getExtraFile(req.params.id, to);
        if (existingDest) return res.status(409).json({ error: `A file already exists at "${to}"` });
        const src = await webpageStore.readExtraFile({ webpageId: req.params.id, userId, path: from });
        if (!src) return res.status(404).json({ error: 'Source file not found' });
        let file;
        if (src.meta.isText) {
            file = await webpageStore.upsertExtraFile({ webpageId: req.params.id, userId, path: to, content: src.text });
        } else {
            file = await webpageStore.upsertBinaryExtraFile({
                webpageId: req.params.id, userId, path: to, buffer: src.bytes, mimeType: src.meta.mimeType,
            });
        }
        await webpageStore.deleteExtraFile({ webpageId: req.params.id, userId, path: from });
        reSnapshotWebpageShares(req.params.id, userId);
        res.json({ file });
    } catch (err) {
        const status = /(primary slot|relative|may not|contains|too long|required|empty|segment)/i.test(err.message) ? 400 : 500;
        if (status === 500) console.error('[Webpages] Asset move failed:', err);
        res.status(status).json({ error: err.message || 'Failed to move file' });
    }
});

// ── Preview token (for sandboxed iframe → API calls) ────────────────
//
// The preview iframe runs with `sandbox="allow-scripts"` (no
// `allow-same-origin`) so it can't carry the user's session cookie. The
// editor calls this endpoint over the normal session-authenticated channel,
// receives a short-lived HMAC token, and bakes it into the iframe document.
// The iframe then sends `Authorization: Bearer <token>` on cross-origin
// calls to /api/webpages-preview/...
router.post('/:id/preview-token', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        // Owner OR org/group-published reader — same visibility as GET /:id, so
        // shared-page viewers get a token and their React preview can call the
        // bridges (without it, dbToken=null and the preview renders blank).
        let wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) {
            const raw = await webpageStore.getWebpageRaw(req.params.id);
            const { orgIds, userGroups } = await resolveAudienceContext(req);
            const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
            if (raw && webpageStore.canReadWebpage(raw, userId, userGroups, orgIdArr)) {
                wp = raw;
            }
        }
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        // Scope the token to the page OWNER so all authorized viewers read/write
        // the SAME per-page database (webpageDbStore keys by the token's userId).
        // AI/automations/integrations already act as the author independently.
        const { token, expiresAt } = issuePreviewToken({ userId: wp.userId, webpageId: wp.id });
        res.json({ token, expiresAt, webpageId: wp.id });
    } catch (err) {
        console.error('[Webpages] Preview token failed:', err);
        res.status(500).json({ error: 'Failed to issue preview token' });
    }
});

// ── DB reset (privileged: session-auth) ─────────────────────────────
//
// Drops the entire SQLite database for this webpage. The token-authenticated
// preview endpoints can write rows but can't reset the whole DB — that's a
// destructive admin action that lives behind the session.
router.delete('/:id/db', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        await webpageDbStore.reset(userId, wp.id);
        res.json({ success: true });
    } catch (err) {
        console.error('[Webpages] DB reset failed:', err);
        res.status(500).json({ error: 'Failed to reset database' });
    }
});

// ── DB viewer endpoints (session-auth) ──────────────────────────────
//
// Power the in-app DB viewer (Schema / Browse / SQL tabs). Each one mirrors
// the AI tool surface in webpageDbTools.js but lives behind the session
// instead of the LLM, so the auth boundary is the same as DB reset above.

router.get('/:id/db/schema', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        const result = await webpageDbStore.schema(userId, wp.id);
        res.json(result);
    } catch (err) {
        console.error('[Webpages] DB schema failed:', err);
        res.status(500).json({ error: `Schema lookup failed: ${err.message}` });
    }
});

router.post('/:id/db/query', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        const { sql, params } = req.body || {};
        if (typeof sql !== 'string' || !sql.trim()) {
            return res.status(400).json({ error: 'sql is required' });
        }
        const result = await webpageDbStore.query(userId, wp.id, sql, Array.isArray(params) ? params : []);
        res.json(result);
    } catch (err) {
        // Mutation-attempt errors come back here too — surface the message verbatim
        // so the SQL tab can render "use exec instead" inline.
        res.status(400).json({ error: err.message });
    }
});

router.post('/:id/db/exec', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        const { sql, params } = req.body || {};
        if (typeof sql !== 'string' || !sql.trim()) {
            return res.status(400).json({ error: 'sql is required' });
        }
        const result = await webpageDbStore.exec(userId, wp.id, sql, Array.isArray(params) ? params : []);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Chat history (per-webpage persistence) ───────────────────────────
// Decoupled from the file-update PUT so frequent chat saves don't trigger
// the file-PUT's sha256 + auto-versioning logic.
router.put('/:id/chat', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
        await webpageStore.setChatMessages(req.params.id, userId, messages);
        res.json({ success: true, count: messages.length });
    } catch (err) {
        console.error('[Webpages] Chat save failed:', err);
        res.status(500).json({ error: 'Failed to save chat history' });
    }
});

router.delete('/:id/chat', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        await webpageStore.setChatMessages(req.params.id, userId, []);
        res.json({ success: true });
    } catch (err) {
        console.error('[Webpages] Chat clear failed:', err);
        res.status(500).json({ error: 'Failed to clear chat history' });
    }
});

router.post('/:id/clone', requireAuth, async (req, res) => {
    try {
        const sourceId = req.params.id;
        const { name } = req.body || {};
        const { userId, orgIds, userGroups } = await resolveAudienceContext(req);
        const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);

        // Visibility gate: owner OR audience member of an org/group the source
        // is published to. Mirrors the GET /:id rules so anyone who can read
        // the page can also fork it onto their own account.
        const source = await webpageStore.getWebpageRaw(sourceId);
        if (!source || !webpageStore.canReadWebpage(source, userId, userGroups, orgIdArr)) {
            return res.status(404).json({ error: 'Webpage not found' });
        }

        // Flush as the SOURCE owner — they're the only one who can hold an
        // open SQLite handle. Best-effort: when the handle isn't loaded in
        // this server process the call rejects and we proceed regardless.
        try { await webpageDbStore.flush(source.userId, sourceId); } catch (_) { /* not loaded or not the owner — fine */ }

        const cloned = await webpageStore.cloneWebpage({ sourceId, newOwnerId: userId, newName: name });
        if (!cloned) return res.status(404).json({ error: 'Webpage not found' });
        res.json({ success: true, webpage: cloned });
    } catch (err) {
        console.error('[Webpages] Clone failed:', err);
        res.status(500).json({ error: 'Failed to clone webpage: ' + err.message });
    }
});

router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        // Drop any cached DB handle/local file before the row goes away —
        // purgeWebpageObjects (called inside deleteWebpage) wipes the RustFS
        // blob, so leaving a stale handle open would only confuse the next
        // access to the (now-deleted) webpage.
        try { await webpageDbStore.invalidate(req.params.id); } catch (_) {}
        const result = await webpageStore.deleteWebpage(req.params.id, userId);
        if (!result) return res.status(404).json({ error: 'Webpage not found' });

        // Clean up auto-created KBs
        if (result.knowledgeBaseIds?.length > 0) {
            for (const kbId of result.knowledgeBaseIds) {
                try { await kbStore.deleteKB(kbId); } catch (e) {
                    console.warn(`[Webpages] KB cleanup for ${kbId}:`, e.message);
                }
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[Webpages] Delete failed:', err);
        res.status(500).json({ error: 'Failed to delete webpage' });
    }
});

// ── Source: File Upload ────────────────────────────────────────────

router.post('/:id/sources/file', requireAuth, upload.single('file'), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const webpageId = req.params.id;

        const wp = await webpageStore.getWebpage(webpageId, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const fileName = req.file.originalname;
        const mimeType = req.file.mimetype;
        const buffer = req.file.buffer;

        const ext = (fileName.split('.').pop() || '').toLowerCase();
        const typeMap = { pdf: 'pdf', docx: 'docx', doc: 'docx', xlsx: 'xlsx', xls: 'xlsx', csv: 'csv', txt: 'text', md: 'text' };
        const type = typeMap[ext] || 'file';

        let storageKey = null;
        if (storageStore.isAvailable()) {
            const storageName = `wp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
            storageKey = storageStore.buildKey(userId, 'webpage-sources', storageName);
            await storageStore.uploadFile(storageKey, buffer, mimeType);
        }

        const source = await webpageStore.addSource({
            webpageId, type, name: fileName,
            storageKey, fileName, metadata: { mimeType, size: buffer.length },
        });

        res.json({ success: true, source });

        ingestFileSource(webpageId, source.id, userId, buffer, fileName, mimeType).catch(err => {
            console.error(`[Webpages] Background ingestion failed for ${fileName}:`, err.message);
        });
    } catch (err) {
        console.error('[Webpages] File upload failed:', err);
        res.status(500).json({ error: 'Failed to upload file' });
    }
});

router.post('/:id/sources/url', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const webpageId = req.params.id;
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'URL required' });

        const wp = await webpageStore.getWebpage(webpageId, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        // SSRF guard — reject internal/loopback/link-local hosts up-front so
        // the user sees a clear error instead of an ingestion task that
        // mysteriously transitions to "error" later.
        try {
            const { assertUrlIsPublic } = require('../core/kbIngestionHelpers');
            await assertUrlIsPublic(url);
        } catch (e) {
            return res.status(400).json({ error: e.message || 'URL is not allowed' });
        }

        let name;
        try { name = new URL(url).hostname + new URL(url).pathname; } catch { name = url; }
        if (name.length > 80) name = name.slice(0, 80) + '…';

        const source = await webpageStore.addSource({
            webpageId, type: 'url', name, metadata: { url },
        });

        res.json({ success: true, source });

        ingestUrlSource(webpageId, source.id, userId, url).catch(err => {
            console.error(`[Webpages] URL ingestion failed for ${url}:`, err.message);
        });
    } catch (err) {
        console.error('[Webpages] URL source failed:', err);
        res.status(500).json({ error: 'Failed to add URL source' });
    }
});

router.post('/:id/sources/text', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const webpageId = req.params.id;
        const { text, name } = req.body;
        if (!text) return res.status(400).json({ error: 'Text content required' });

        const wp = await webpageStore.getWebpage(webpageId, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const sourceName = name || 'Pasted text';
        const source = await webpageStore.addSource({
            webpageId, type: 'text', name: sourceName,
            wordCount: text.split(/\s+/).length,
        });

        res.json({ success: true, source });

        ingestTextSource(webpageId, source.id, userId, text, sourceName).catch(err => {
            console.error(`[Webpages] Text ingestion failed:`, err.message);
        });
    } catch (err) {
        console.error('[Webpages] Text source failed:', err);
        res.status(500).json({ error: 'Failed to add text source' });
    }
});

router.post('/:id/sources/drive', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const webpageId = req.params.id;
        const { files, provider } = req.body;
        if (!files || !Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ error: 'Files array required' });
        }

        const wp = await webpageStore.getWebpage(webpageId, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const sources = [];
        for (const file of files) {
            const type = provider === 'microsoft' ? 'onedrive' : 'gdrive';
            const source = await webpageStore.addSource({
                webpageId,
                type,
                name: file.name || 'Drive file',
                metadata: {
                    provider,
                    driveFileId: file.driveFileId,
                    charCount: file.content?.length,
                },
                wordCount: file.content ? file.content.split(/\s+/).length : 0,
            });
            sources.push(source);

            if (file.content) {
                ingestDriveSource(webpageId, source.id, userId, file.content, file.name).catch(err => {
                    console.error(`[Webpages] Drive ingestion failed for ${file.name}:`, err.message);
                });
            } else {
                webpageStore.updateSource(source.id, { status: 'error', error: 'No content received from Drive' });
            }
        }

        res.json({ success: true, sources });
    } catch (err) {
        console.error('[Webpages] Drive source failed:', err);
        res.status(500).json({ error: 'Failed to add Drive source' });
    }
});

router.get('/:id/sources', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        await webpageStore.timeoutStuckSources(wp.id).catch(() => {});
        const sources = await webpageStore.getSources(wp.id);
        res.json({ sources });
    } catch (err) {
        console.error('[Webpages] List sources failed:', err);
        res.status(500).json({ error: 'Failed to list sources' });
    }
});

router.post('/:id/sources/:sid/retry', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const source = await webpageStore.getSource(req.params.sid);
        if (!source || source.webpageId !== wp.id) return res.status(404).json({ error: 'Source not found' });

        await webpageStore.updateSource(source.id, { status: 'processing', error: null });
        res.json({ success: true });

        (async () => {
            try {
                if (source.type === 'url') {
                    const url = source.metadata?.url;
                    if (!url) throw new Error('Source has no URL to retry');
                    await ingestUrlSource(wp.id, source.id, userId, url);
                } else if (source.storageKey) {
                    if (!storageStore.isAvailable()) throw new Error('Storage not configured');
                    const { stream } = await storageStore.streamFile(source.storageKey);
                    const chunks = [];
                    for await (const chunk of stream) chunks.push(chunk);
                    const buffer = Buffer.concat(chunks);
                    const mimeType = source.metadata?.mimeType || 'application/octet-stream';
                    await ingestFileSource(wp.id, source.id, userId, buffer, source.fileName || source.name, mimeType);
                } else {
                    throw new Error('This source type cannot be retried — please re-add it.');
                }
            } catch (e) {
                console.error(`[Webpages] Retry failed for source ${source.id}:`, e.message);
                await webpageStore.updateSource(source.id, { status: 'error', error: e.message }).catch(() => {});
            }
        })();
    } catch (err) {
        console.error('[Webpages] Retry source route failed:', err);
        res.status(500).json({ error: 'Failed to retry source' });
    }
});

router.post('/:id/sources/:sid/cancel', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const source = await webpageStore.getSource(req.params.sid);
        if (!source || source.webpageId !== wp.id) return res.status(404).json({ error: 'Source not found' });

        await webpageStore.updateSource(source.id, {
            status: 'error',
            error: 'Cancelled by user',
        });
        res.json({ success: true });
    } catch (err) {
        console.error('[Webpages] Cancel source failed:', err);
        res.status(500).json({ error: 'Failed to cancel source' });
    }
});

router.delete('/:id/sources/:sid', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const source = await webpageStore.deleteSource(req.params.sid);
        if (!source) return res.status(404).json({ error: 'Source not found' });

        if (source.storageKey) {
            try {
                if (!source.storageKey.startsWith('local:')) {
                    await storageStore.deleteFile(source.storageKey);
                }
            } catch (e) { console.warn('[Webpages] Storage cleanup:', e.message); }
        }

        const kbIds = wp.knowledgeBaseIds || [];
        for (const kbId of kbIds) {
            try {
                const doc = await findDocumentBySourceUri(kbId, source.id);
                if (doc) await deleteDocumentChunks(kbId, doc.id, userId);
            } catch (e) {
                console.warn(`[Webpages] KB chunk cleanup for ${source.id}:`, e.message);
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[Webpages] Delete source failed:', err);
        res.status(500).json({ error: 'Failed to delete source' });
    }
});

// ── Version Control ─────────────────────────────────────────────────

router.get('/:id/versions', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const versions = await webpageStore.getVersions(req.params.id);
        res.json({ versions });
    } catch (err) {
        console.error('[Webpages] List versions failed:', err);
        res.status(500).json({ error: 'Failed to list versions' });
    }
});

router.get('/:id/versions/:vid', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const version = await webpageStore.getVersion(userId, req.params.vid);
        if (!version || version.webpageId !== req.params.id) {
            return res.status(404).json({ error: 'Version not found' });
        }
        res.json({ version });
    } catch (err) {
        console.error('[Webpages] Get version failed:', err);
        res.status(500).json({ error: 'Failed to get version' });
    }
});

router.post('/:id/versions', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const summary = req.body.summary || 'Manual snapshot';
        if (wp.htmlSize + wp.cssSize + wp.jsSize + (wp.dbSize || 0) === 0) {
            return res.status(400).json({ error: 'Webpage is empty — nothing to snapshot' });
        }

        // Flush any pending DB writes before snapshotting so the version
        // contains everything the user's done up to this moment.
        try { await webpageDbStore.flush(userId, req.params.id); } catch (e) {
            console.warn('[Webpages] Pre-snapshot DB flush failed:', e.message);
        }

        const version = await webpageStore.createVersion(userId, req.params.id, summary);
        res.json({ success: true, version });
    } catch (err) {
        console.error('[Webpages] Create version failed:', err);
        res.status(500).json({ error: 'Failed to create version' });
    }
});

/**
 * Restore a version: copy the snapshot's three slot objects back over
 * "current/*" and update the webpage's metadata hashes.
 */
router.post('/:id/versions/:vid/restore', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const version = await webpageStore.getVersion(userId, req.params.vid);
        if (!version || version.webpageId !== req.params.id) {
            return res.status(404).json({ error: 'Version not found' });
        }

        // Snapshot the *current* state first so the restore is itself reversible.
        // Flush the DB first so the pre-restore snapshot captures pending writes too.
        try { await webpageDbStore.flush(userId, req.params.id); } catch (e) {
            console.warn('[Webpages] Pre-restore DB flush failed:', e.message);
        }
        const hadContent = wp.htmlSize + wp.cssSize + wp.jsSize + (wp.dbSize || 0) > 0;
        if (hadContent) {
            try {
                await webpageStore.createVersion(userId, req.params.id, 'Pre-restore snapshot', {
                    htmlSha: wp.htmlSha,
                    cssSha: wp.cssSha,
                    jsSha: wp.jsSha,
                    contentLength: wp.htmlSize + wp.cssSize + wp.jsSize,
                });
            } catch (e) {
                console.warn('[Webpages] Pre-restore snapshot failed:', e.message);
            }
        }

        // Write the snapshot's contents back to "current/" via the store helpers
        // (which also recompute sha + size).
        const updates = {};
        for (const slot of webpageStore.SLOTS) {
            const content = version[slot] || '';
            const { sha, size } = await webpageStore.writeSlot(userId, req.params.id, slot, content);
            updates[`${slot}Sha`] = sha;
            updates[`${slot}Size`] = size;
        }

        // Restore the SQLite DB binary-side: copy the version's data.db over
        // current/data.db (or delete it if the version has none), then drop
        // the cached engine handle so the next access re-opens the restored bytes.
        const restored = await webpageStore.restoreSlotFromVersion(userId, req.params.id, req.params.vid, 'db');
        await webpageDbStore.invalidate(req.params.id);
        if (restored) {
            // Re-derive sha + size from the restored object so the metadata
            // matches the at-rest blob (we don't store db sha in the version row).
            const { stream } = await storageStore.streamFile(
                storageStore.buildWebpageKey(userId, req.params.id, 'db')
            );
            const chunks = [];
            for await (const c of stream) chunks.push(c);
            const buf = Buffer.concat(chunks);
            updates.dbSha = crypto.createHash('sha256').update(buf).digest('hex');
            updates.dbSize = buf.length;
        } else {
            updates.dbSha = '';
            updates.dbSize = 0;
        }

        await webpageStore.updateWebpageMetadata(req.params.id, userId, updates);

        res.json({
            success: true,
            files: { html: version.html, css: version.css, js: version.js },
        });
    } catch (err) {
        console.error('[Webpages] Restore version failed:', err);
        res.status(500).json({ error: 'Failed to restore version' });
    }
});

router.delete('/:id/versions/:vid', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const ok = await webpageStore.deleteVersion(userId, req.params.vid);
        if (!ok) return res.status(404).json({ error: 'Version not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Webpages] Delete version failed:', err);
        res.status(500).json({ error: 'Failed to delete version' });
    }
});

module.exports = router;
