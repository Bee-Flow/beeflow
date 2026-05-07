/**
 * CMS Routes — public read endpoints + admin CRUD for the multi-site CMS.
 *
 * The store (cmsStore.js) is multi-project. The route layer exposes TWO
 * parallel admin APIs that share the same handler bodies:
 *
 *   /admin/*               — single-site bridge. attachSiteId middleware
 *                            resolves the org's "default" project (auto-
 *                            created on first call). Used by the current
 *                            admin panel until the project switcher lands.
 *
 *   /sites/:siteId/*       — explicit multi-site. attachSiteIdFromParam
 *                            validates the siteId from the URL and 404s
 *                            if the project doesn't exist. Plus site-CRUD
 *                            routes for managing the project list itself.
 *
 *   PUBLIC (no auth):
 *     GET  /api/cms/site                       legacy keyed-content shape
 *     GET  /api/cms/site?v=2[&slug=…&locale=…] new shape
 *     GET  /api/cms/asset/:key(*)              streams a CMS asset
 *
 *   ADMIN — site management (super-admin only):
 *     GET    /api/cms/sites                                    list sites
 *     POST   /api/cms/sites                                    create site
 *     GET    /api/cms/sites/:siteId                            full editor payload
 *     PUT    /api/cms/sites/:siteId                            replace SiteDoc
 *     PATCH  /api/cms/sites/:siteId                            { name } — rename
 *     DELETE /api/cms/sites/:siteId                            delete site + cascade
 *
 *   ADMIN — per-site content (mounted on both /admin and /sites/:siteId):
 *     GET    .../site                                          full editor payload (legacy)
 *     PUT    .../site                                          replace SiteDoc (legacy)
 *     GET    .../graph                                         page graph for sitemap
 *     PUT    .../site/locale/:locale                           replace site-locale override
 *     DELETE .../site/locale/:locale
 *     POST   .../pages                                         { slug?, title?, copyFromId? } → { id }
 *     PUT    .../pages/order                                   { orderedIds: [] }
 *     PUT    .../pages/:id/meta                                { slug?, title?, hideHeader?, hideFooter? }
 *     PUT    .../pages/:id/homepage                            promote to homepage
 *     DELETE .../pages/:id
 *     GET    .../pages/:id                                     full PageDoc
 *     PUT    .../pages/:id                                     replace PageDoc
 *     PUT    .../pages/:id/locale/:locale                      replace page-locale override
 *     DELETE .../pages/:id/locale/:locale
 *
 *   ADMIN — org-wide (only at /admin/*, not per-site):
 *     PUT    /api/cms/admin/enabled                            { enabled }
 *     PUT    /api/cms/admin/default-locale                     { locale }
 *     POST   /api/cms/admin/upload                             multipart file → { key, url }
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');

const cmsStore = require('../stores/cmsStore');
const configStore = require('../stores/configStore');
const languageStore = require('../stores/languageStore');
const storageStore = require('../stores/storageStore');
const { hasPermission } = require('../auth/permissions');

// ── Org-wide enabled flag ────────────────────────────────────────
//
// The store has no enabled concept (it's a per-project doc). The "Live"
// toggle in the admin panel is org-wide for now, so we keep it as a
// standalone config key managed here. Move into the SiteDoc once the UI
// supports per-project publishing.

const KEY_CMS_ENABLED = 'cms_enabled';

async function getCmsEnabled() {
    const v = await configStore.getConfig(KEY_CMS_ENABLED);
    return v === true;
}

async function setCmsEnabled(enabled) {
    await configStore.setConfig(KEY_CMS_ENABLED, !!enabled);
}

// ── Single-project bridge ────────────────────────────────────────
//
// Resolves the org's "default" CMS project. Pass { create: true } to
// auto-create it when none exists (used by /admin routes); reads return
// null when empty so public callers don't accidentally provision a
// project on cache-busting traffic.

async function getDefaultSiteId({ create = false } = {}) {
    const projects = await cmsStore.listProjects();
    if (projects.length > 0) return projects[0].id;
    if (!create) return null;
    const created = await cmsStore.createProject({ name: 'Default site' });
    return created.id;
}

// ── Middleware ───────────────────────────────────────────────────

async function requireAdmin(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
    if (req.session.isAdmin || req.session.user?.role === 'admin') return next();
    const userId = req.session.user?.id;
    if (userId && await hasPermission(userId, 'all', req.session)) return next();
    return res.status(403).json({ error: 'Admin access required' });
}

async function attachSiteId(req, res, next) {
    try {
        req.siteId = await getDefaultSiteId({ create: true });
        next();
    } catch (err) {
        console.error('[CMS] siteId resolution failed:', err.message);
        res.status(500).json({ error: 'Failed to resolve CMS project' });
    }
}

const SITE_ID_RE = /^pj_[a-f0-9]{4,}$/;

async function attachSiteIdFromParam(req, res, next) {
    try {
        const { siteId } = req.params;
        if (!siteId || !SITE_ID_RE.test(siteId)) {
            return res.status(400).json({ error: 'Invalid siteId format' });
        }
        const project = await cmsStore.getProject(siteId);
        if (!project) return res.status(404).json({ error: 'Site not found' });
        req.siteId = siteId;
        next();
    } catch (err) {
        console.error('[CMS] siteId param resolution failed:', err.message);
        res.status(500).json({ error: 'Failed to resolve site' });
    }
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image uploads are allowed'));
    },
});

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Convert the v2 effective payload into the legacy keyed `content` object
 * the older marketing renderer (and RootPathGate at "/") expect. Each
 * enabled block is added under its type key, and a `blocks[]` array is
 * also emitted so the new renderer can render in panel order.
 *
 * Per-block `style` overrides are preserved on the blocks[] entries so
 * the renderer can apply the same visual customizations on the public
 * site as inside the admin preview.
 */
function synthesizeLegacyContent(eff) {
    const out = {};
    if (eff.header) {
        // Attach the page list + active-page slug so Header.jsx's auto-nav
        // fallback works on the public site too (it already gets the same
        // shape from buildPreviewContent in the admin preview).
        out.header = {
            ...eff.header,
            pages: (eff.pages || []).map(p => ({
                slug: p.slug,
                title: p.title,
                isHomepage: !!p.isHomepage,
                showInNav: p.showInNav !== false,
                navOrder:  typeof p.navOrder === 'number' ? p.navOrder : 0,
            })),
            activeSlug: eff.page?.isHomepage ? '' : (eff.page?.slug || ''),
        };
    }
    if (eff.footer) {
        out.footer = {
            ...eff.footer,
            brand: { logoText: eff.footer.brandText, blurb: eff.footer.blurb },
        };
    }
    // Embed design inside content so the public-site renderer at "/" picks
    // it up via the existing RootPathGate pass-through (no App.jsx change
    // needed). The renderer reads initialContent.design for non-preview
    // mounts; preview mode still uses the postMessage payload's design.
    if (eff.design) out.design = eff.design;
    const enabledBlocks = (eff.page?.blocks || []).filter(b => b.enabled !== false);
    out.blocks = enabledBlocks.map(b => ({
        id: b.id,
        type: b.type,
        enabled: true,
        content: b.content || {},
        style: b.style || {},
    }));
    for (const b of enabledBlocks) {
        out[b.type] = { enabled: true, ...(b.content || {}) };
    }
    return out;
}

// ── Shared handler bodies ────────────────────────────────────────
//
// Each handler reads req.siteId (set by attachSiteId or attachSiteIdFromParam)
// and req.params.{id,locale} (where applicable). The same function is wired
// to both /admin/* and /sites/:siteId/* routes below.

async function getSitePayload(req, res) {
    try {
        const [payload, locales, enabled] = await Promise.all([
            cmsStore.getAdminPayload(req.siteId),
            languageStore.getAvailableLocales(),
            getCmsEnabled(),
        ]);
        res.json({ ...payload, locales, enabled });
    } catch (err) {
        console.error('[CMS] getSitePayload error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

async function getGraph(req, res) {
    try {
        const graph = await cmsStore.getSiteGraph(req.siteId);
        res.json(graph);
    } catch (err) {
        console.error('[CMS] getGraph error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

async function putSiteDoc(req, res) {
    try {
        const { site } = req.body || {};
        if (!site) return res.status(400).json({ error: 'site object required' });
        const saved = await cmsStore.setProject(req.siteId, site);
        res.json({ success: true, site: saved });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function putSiteLocale(req, res) {
    try {
        const { override } = req.body || {};
        if (!override) return res.status(400).json({ error: 'override object required' });
        await cmsStore.setSiteLocaleOverride(req.siteId, req.params.locale.toLowerCase(), override);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function deleteSiteLocale(req, res) {
    try {
        await cmsStore.deleteSiteLocaleOverride(req.siteId, req.params.locale.toLowerCase());
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
}

async function postPage(req, res) {
    try {
        const { slug, title, copyFromId } = req.body || {};
        const result = await cmsStore.createPage(req.siteId, { slug, title, copyFromId });
        res.json({ success: true, ...result });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function putPagesOrder(req, res) {
    try {
        const { orderedIds } = req.body || {};
        if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds array required' });
        await cmsStore.reorderPages(req.siteId, orderedIds);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function putPageMeta(req, res) {
    try {
        const updated = await cmsStore.updatePageMeta(req.siteId, req.params.id, req.body || {});
        res.json({ success: true, page: updated });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function putPageHomepage(req, res) {
    try {
        await cmsStore.setHomepage(req.siteId, req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function deletePageHandler(req, res) {
    try {
        await cmsStore.removePage(req.siteId, req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function getPageById(req, res) {
    try {
        const page = await cmsStore.getPage(req.siteId, req.params.id);
        if (!page) return res.status(404).json({ error: 'Page not found' });
        res.json(page);
    } catch (err) { res.status(500).json({ error: err.message }); }
}

async function putPage(req, res) {
    try {
        const incoming = req.body?.page;
        if (!incoming) return res.status(400).json({ error: 'page object required' });
        // Force the URL id onto the body so callers can't quietly write to a
        // different page than the one they targeted.
        const saved = await cmsStore.setPage(req.siteId, { ...incoming, id: req.params.id });
        res.json({ success: true, page: saved });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function putPageLocale(req, res) {
    try {
        const { override } = req.body || {};
        if (!override) return res.status(400).json({ error: 'override object required' });
        await cmsStore.setPageLocaleOverride(req.siteId, req.params.id, req.params.locale.toLowerCase(), override);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function deletePageLocale(req, res) {
    try {
        await cmsStore.deletePageLocaleOverride(req.siteId, req.params.id, req.params.locale.toLowerCase());
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
}

// Site-CRUD handlers (no /admin equivalent).

async function listSitesHandler(req, res) {
    try {
        const sites = await cmsStore.listProjects();
        res.json({ sites });
    } catch (err) { res.status(500).json({ error: err.message }); }
}

async function createSiteHandler(req, res) {
    try {
        const { name } = req.body || {};
        const created = await cmsStore.createProject({ name });
        res.status(201).json(created);
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function renameSiteHandler(req, res) {
    try {
        const { name } = req.body || {};
        if (typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'name required' });
        }
        const updated = await cmsStore.renameProject(req.siteId, name.trim());
        res.json({ success: true, site: updated });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function deleteSiteHandler(req, res) {
    try {
        await cmsStore.deleteProject(req.siteId);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

// Org-wide handlers (only mounted on /admin/*).

async function putEnabled(req, res) {
    try {
        const { enabled } = req.body || {};
        if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
        await setCmsEnabled(enabled);
        res.json({ success: true, enabled });
    } catch (err) { res.status(500).json({ error: err.message }); }
}

async function putDefaultLocale(req, res) {
    try {
        const { locale } = req.body || {};
        if (!locale || typeof locale !== 'string') return res.status(400).json({ error: 'locale required' });
        await cmsStore.setDefaultLocale(locale.toLowerCase());
        res.json({ success: true, defaultLocale: locale.toLowerCase() });
    } catch (err) { res.status(500).json({ error: err.message }); }
}

async function handleUpload(req, res) {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file provided' });
        if (!storageStore.isAvailable()) return res.status(503).json({ error: 'Storage unavailable' });

        const ext = path.extname(req.file.originalname || '').toLowerCase() || '';
        const safeBase = (req.file.originalname || 'upload')
            .replace(/[^a-zA-Z0-9._-]/g, '_')
            .replace(/\.[^.]+$/, '');
        const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeBase}${ext}`;
        const key = `cms/${filename}`;

        await storageStore.uploadFile(key, req.file.buffer, req.file.mimetype);

        const url = `/api/cms/asset/${key.split('/').map(encodeURIComponent).join('/')}`;
        res.json({ success: true, key, url });
    } catch (err) {
        console.error('[CMS] /upload error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

// ══════════════════════════════════════════════════════════════════
// PUBLIC
// ══════════════════════════════════════════════════════════════════

/**
 * GET /api/cms/site
 *   v=2 → { enabled, defaultLocale, locale, found, page, header, footer, pages }
 *   no v → legacy shape: { enabled, defaultLocale, locale, content }
 *
 * `?slug=…` selects a page (only honored with v=2). When omitted the homepage
 * is returned. `?locale=…` picks a locale; falls back to default.
 *
 * Reads from the org's default site (the bridge target). Multi-site public
 * routing (per-domain or path-prefix) is a future phase.
 */
router.get('/site', async (req, res) => {
    try {
        const enabled = await getCmsEnabled();
        if (!enabled) {
            res.setHeader('Cache-Control', 'public, max-age=60');
            return res.json({ enabled: false });
        }

        const siteId = await getDefaultSiteId();
        if (!siteId) {
            // Enabled but no project provisioned yet (admin hasn't visited
            // the panel). Return enabled:false so the public site stays dark.
            res.setHeader('Cache-Control', 'public, max-age=60');
            return res.json({ enabled: false });
        }

        const defaultLocale = await cmsStore.getDefaultLocale();
        const locale = (req.query.locale || defaultLocale).toString().toLowerCase().split('-')[0];
        const v2 = req.query.v === '2';
        const slug = (req.query.slug || '').toString();

        const eff = await cmsStore.getEffective(siteId, slug || null, locale);

        res.setHeader('Cache-Control', 'public, max-age=60');
        if (v2) {
            return res.json({
                enabled: true,
                defaultLocale,
                locale,
                found: eff.found,
                page: eff.page,
                header: eff.header,
                footer: eff.footer,
                pages: eff.pages,
                design: eff.design,
            });
        }
        return res.json({
            enabled: true,
            defaultLocale,
            locale,
            content: synthesizeLegacyContent(eff),
            design: eff.design,
        });
    } catch (err) {
        console.error('[CMS] /site error:', err.message);
        res.status(500).json({ error: 'Failed to load CMS content' });
    }
});

router.get(/^\/asset\/(.+)$/, async (req, res) => {
    try {
        const key = req.params[0];
        if (!key.startsWith('cms/')) return res.status(404).json({ error: 'Not found' });
        if (!storageStore.isAvailable()) return res.status(503).json({ error: 'Storage unavailable' });

        const { stream, contentType, contentLength } = await storageStore.streamFile(key);
        res.setHeader('Content-Type', contentType);
        if (contentLength) res.setHeader('Content-Length', contentLength);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        stream.pipe(res);
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            return res.status(404).json({ error: 'Asset not found' });
        }
        console.error('[CMS] /asset error:', err.message);
        res.status(500).json({ error: 'Failed to load asset' });
    }
});

// ══════════════════════════════════════════════════════════════════
// ADMIN — /admin/* (single-site bridge, back-compat)
// ══════════════════════════════════════════════════════════════════

router.use('/admin', requireAdmin);
router.use('/admin', attachSiteId);

// Per-site content (default-bridge target).
router.get('/admin/site', getSitePayload);
router.put('/admin/site', putSiteDoc);
router.get('/admin/graph', getGraph);
router.put('/admin/site/locale/:locale', putSiteLocale);
router.delete('/admin/site/locale/:locale', deleteSiteLocale);

// Pages — order matters: literal '/order' before ':id' wildcard.
router.post('/admin/pages', postPage);
router.put('/admin/pages/order', putPagesOrder);
router.put('/admin/pages/:id/locale/:locale', putPageLocale);
router.delete('/admin/pages/:id/locale/:locale', deletePageLocale);
router.put('/admin/pages/:id/meta', putPageMeta);
router.put('/admin/pages/:id/homepage', putPageHomepage);
router.delete('/admin/pages/:id', deletePageHandler);
router.get('/admin/pages/:id', getPageById);
router.put('/admin/pages/:id', putPage);

// Org-wide flags (not per-site — only available here).
router.put('/admin/enabled', putEnabled);
router.put('/admin/default-locale', putDefaultLocale);

// File uploads (org-wide bucket prefix).
router.post('/admin/upload', upload.single('file'), handleUpload);

// ══════════════════════════════════════════════════════════════════
// ADMIN — /sites and /sites/:siteId/* (explicit multi-site)
// ══════════════════════════════════════════════════════════════════

router.use('/sites', requireAdmin);

// Site-CRUD (no siteId yet, no attachSiteIdFromParam needed).
router.get('/sites', listSitesHandler);
router.post('/sites', createSiteHandler);

// Validate :siteId for everything below before running handlers.
router.use('/sites/:siteId', attachSiteIdFromParam);

// Pages — literal '/order' before ':id' wildcard.
router.post('/sites/:siteId/pages', postPage);
router.put('/sites/:siteId/pages/order', putPagesOrder);
router.put('/sites/:siteId/pages/:id/locale/:locale', putPageLocale);
router.delete('/sites/:siteId/pages/:id/locale/:locale', deletePageLocale);
router.put('/sites/:siteId/pages/:id/meta', putPageMeta);
router.put('/sites/:siteId/pages/:id/homepage', putPageHomepage);
router.delete('/sites/:siteId/pages/:id', deletePageHandler);
router.get('/sites/:siteId/pages/:id', getPageById);
router.put('/sites/:siteId/pages/:id', putPage);

// Site chrome (header/footer) and locale overrides.
router.put('/sites/:siteId/site/locale/:locale', putSiteLocale);
router.delete('/sites/:siteId/site/locale/:locale', deleteSiteLocale);

// Page graph for the sitemap diagram.
router.get('/sites/:siteId/graph', getGraph);

// Site-level operations on the SiteDoc itself.
router.get('/sites/:siteId', getSitePayload);
router.put('/sites/:siteId', putSiteDoc);
router.patch('/sites/:siteId', renameSiteHandler);
router.delete('/sites/:siteId', deleteSiteHandler);

module.exports = router;
