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
 *     GET    /api/cms/sites                                    list sites + liveSiteId
 *     POST   /api/cms/sites                                    create site
 *     GET    /api/cms/sites/:siteId                            full editor payload
 *     PUT    /api/cms/sites/:siteId                            replace SiteDoc
 *     PATCH  /api/cms/sites/:siteId                            { name } — rename
 *     DELETE /api/cms/sites/:siteId                            delete site + cascade
 *     PUT    /api/cms/sites/:siteId/live                       { live } — set/clear live
 *     POST   /api/cms/sites/:siteId/duplicate                  deep-copy → new version
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
 *     PUT    /api/cms/admin/enabled                            { enabled, siteId? } — legacy
 *     PUT    /api/cms/admin/default-locale                     { locale }
 *     POST   /api/cms/admin/upload                             multipart file → { key, url }
 *
 *   "Live" model: at most one project can be live at a time. The public
 *   /api/cms/site reads the live siteId from cms_live_site_id; admins
 *   toggle it per-site via /sites/:siteId/live. The legacy
 *   /admin/enabled route reinterprets boolean toggles as "clear / set
 *   live to first project" so older clients keep working.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const bodyParser = require('body-parser');

const cmsStore = require('../stores/cmsStore');
const configStore = require('../stores/configStore');
const languageStore = require('../stores/languageStore');
const storageStore = require('../stores/storageStore');
const { hasPermission } = require('../auth/permissions');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const { sanitizeSvg } = require('../utils/svgSanitizer');

// Per-route body parser for /sites/import — caps the JSON payload at
// 2 MB. The global parser is 20 MB which is fine for chat/agent runs
// but too permissive for site imports (a real export is well under
// 500 KB). Caps memory pressure when a compromised admin session sends
// a deeply-nested or zip-bombed JSON.
const importJsonParser = bodyParser.json({ limit: '2mb' });

// Rate limiters for write-heavy admin endpoints. The threat model is a
// compromised admin session, not anonymous abuse — but a stolen session
// shouldn't be able to exhaust storage / DB capacity in seconds. Per-
// user windows are intentionally generous so a legit power user editing
// a site is never rate-limited.
const uploadLimiter    = perUserRateLimit({ windowMs: 60_000, max: 60 });
const importLimiter    = perUserRateLimit({ windowMs: 60_000, max: 10 });
const duplicateLimiter = perUserRateLimit({ windowMs: 60_000, max: 20 });
const publishLimiter   = perUserRateLimit({ windowMs: 60_000, max: 30 });

// ── Live-site selection ──────────────────────────────────────────
//
// "Live" used to be a global on/off flag (cms_enabled). Now it's per-
// project and mutually exclusive: at most one project can be live at a
// time, and the live URL serves *that* project. Other projects stay
// editable in the admin without affecting the public site.
//
// Storage:
//   cms_live_site_id : string | null   the live project's siteId, or null
//                                      when nothing is live (public site
//                                      is dark and "/" redirects to /app).
//
// Migration: legacy cms_enabled === true with no live id set → adopt
// projects[0] as live (preserves prior behavior). Done lazily inside
// getLiveSiteId so we don't add a startup ordering surprise.

const KEY_CMS_LIVE_SITE_ID = 'cms_live_site_id';
const KEY_CMS_ENABLED      = 'cms_enabled';   // legacy, read-only after migration

async function getLiveSiteId() {
    const stored = await configStore.getConfig(KEY_CMS_LIVE_SITE_ID);
    if (typeof stored === 'string' && SITE_ID_RE.test(stored)) {
        // Validate the project still exists; clear stale ids defensively.
        const project = await cmsStore.getProject(stored).catch(() => null);
        if (project) return stored;
        await configStore.setConfig(KEY_CMS_LIVE_SITE_ID, null);
        return null;
    }
    if (stored !== undefined && stored !== null) return null;

    // Lazy migration: legacy cms_enabled flag → adopt projects[0] if true.
    const legacyEnabled = await configStore.getConfig(KEY_CMS_ENABLED);
    if (legacyEnabled === true) {
        const projects = await cmsStore.listProjects();
        const adopted = projects[0]?.id || null;
        await configStore.setConfig(KEY_CMS_LIVE_SITE_ID, adopted);
        return adopted;
    }
    return null;
}

async function setLiveSiteId(siteId) {
    if (siteId === null) {
        await configStore.setConfig(KEY_CMS_LIVE_SITE_ID, null);
        return null;
    }
    if (typeof siteId !== 'string' || !SITE_ID_RE.test(siteId)) {
        throw new Error('Invalid siteId');
    }
    const project = await cmsStore.getProject(siteId);
    if (!project) throw new Error('Site not found');
    await configStore.setConfig(KEY_CMS_LIVE_SITE_ID, siteId);
    return siteId;
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

// Accepted MIME types for the CMS uploader. Images cover the regular
// hero/feature/logo case; image/gif + image/apng + image/webp cover
// animated graphics; video/mp4 + video/webm cover the "silent loop"
// video kind used by Media + Text. Anything outside this list is
// rejected as 400 by the wrapper middleware below (NOT 500 — fileFilter
// errors used to bubble up uncaught and surface as a generic Internal
// Server Error).
//
// SVG is accepted, but only after server-side sanitization (see
// handleUpload below). The asset endpoint serves the cleaned bytes
// inline with a strict CSP; unsanitized legacy SVGs are still
// force-downloaded by the isScriptableMime branch.
const UPLOAD_MIME_WHITELIST = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/apng',
    'image/svg+xml',
    'video/mp4',
    'video/webm',
]);

const upload = multer({
    storage: multer.memoryStorage(),
    // 25 MB ceiling — high enough for short demo-loop MP4s / animated GIFs
    // (the typical sim.ai-style screen recording is well under this), low
    // enough that we don't silently accept multi-hundred-MB uploads.
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (UPLOAD_MIME_WHITELIST.has(file.mimetype)) cb(null, true);
        else cb(new Error(`Unsupported file type: ${file.mimetype}`));
    },
});

// Wrap upload.single('file') so multer errors (LIMIT_FILE_SIZE, fileFilter
// rejections) come back as 400 with a useful message instead of the
// default 500 the upstream client sees today.
function uploadFile(req, res, next) {
    upload.single('file')(req, res, (err) => {
        if (!err) return next();
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? 'File too large (max 25 MB)'
            : (err.message || 'Upload rejected');
        res.status(400).json({ error: message });
    });
}

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
        // navLinks / ctaHref: Header.jsx reads flat `{label, href}` and
        // `data.ctaHref`, but resolveLinksInTree leaves the storage shape
        // (`link: {href, target?, rel?}`) on each entry. Flatten here so
        // the public site sees the same shape the admin preview produces
        // via buildPreviewContent — otherwise every nav link would be
        // silently dropped and the CTA would fall back to '/app'.
        //
        // The page list is no longer attached: nav is fully owned by the
        // user via Site chrome → Nav links, so Header.jsx never reads
        // data.pages anymore.
        out.header = {
            ...eff.header,
            // logo passes through via the spread; Header.jsx prefers
            // logo.text and logo.src when present, falling back to the
            // legacy logoText / letter-avatar otherwise.
            navLinks: (eff.header.nav || []).map(n => ({
                label: n.label,
                href:  n.link?.href || '#',
                ...(n.link?.target ? { target: n.link.target } : {}),
                ...(n.link?.rel    ? { rel:    n.link.rel    } : {}),
                // Dropdown children get the same flat shape; their
                // `link.href` was already resolved by resolveLinksInTree
                // when getEffective walked the header tree.
                children: (n.children || []).map(c => ({
                    label: c.label,
                    href:  c.link?.href || '#',
                    ...(c.link?.target ? { target: c.link.target } : {}),
                    ...(c.link?.rel    ? { rel:    c.link.rel    } : {}),
                })),
            })),
            // Header buttons (multi-CTA) — same flat {label, href, style,
            // target?, rel?} shape Header.jsx renders. Per-button label
            // typography (labelFont / labelSize / labelColor) is forwarded
            // verbatim so the renderer can apply inline overrides without
            // re-reading the storage shape.
            ctas: (eff.header.ctas || []).map(cta => ({
                id: cta.id,
                label: cta.label,
                href:  cta.link?.href || '/app',
                style: cta.style || 'primary',
                labelFont:  cta.labelFont  || '',
                labelSize:  Number.isFinite(cta.labelSize) ? cta.labelSize : 0,
                labelColor: cta.labelColor || '',
                ...(cta.link?.target ? { target: cta.link.target } : {}),
                ...(cta.link?.rel    ? { rel:    cta.link.rel    } : {}),
            })),
            activeSlug: eff.page?.isHomepage ? '' : (eff.page?.slug || ''),
        };
    }
    if (eff.footer) {
        // Flatten column links + socials the same way buildPreviewContent
        // does for the admin preview — Footer.jsx reads `link.href` and
        // `social.href` directly. Without this, every footer link would
        // ship to live with `href` undefined and render as a non-clickable
        // <a>.
        out.footer = {
            ...eff.footer,
            brand: { logoText: eff.footer.brandText, blurb: eff.footer.blurb },
            columns: (eff.footer.columns || []).map(c => ({
                heading: c.heading,
                links: (c.links || []).map(l => ({
                    label: l.label,
                    href:  l.link?.href || '#',
                    ...(l.link?.target ? { target: l.link.target } : {}),
                    ...(l.link?.rel    ? { rel:    l.link.rel    } : {}),
                })),
            })),
            socials: (eff.footer.socials || []).map(s => ({
                platform: s.platform,
                href:     s.link?.href || '#',
                ...(s.link?.target ? { target: s.link.target } : {}),
                ...(s.link?.rel    ? { rel:    s.link.rel    } : {}),
            })),
        };
    }
    // Embed design inside content so the public-site renderer at "/" picks
    // it up via the existing RootPathGate pass-through (no App.jsx change
    // needed). The renderer reads initialContent.design for non-preview
    // mounts; preview mode still uses the postMessage payload's design.
    if (eff.design) out.design = eff.design;
    // Per-page chrome visibility. Stored on the page index entry by
    // updatePageMeta; the renderer hides Header/Footer when set. Default
    // false so pages that pre-date the flag still show both.
    out.hideHeader = !!eff.page?.hideHeader;
    out.hideFooter = !!eff.page?.hideFooter;
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
        const [payload, locales, liveSiteId] = await Promise.all([
            cmsStore.getAdminPayload(req.siteId),
            languageStore.getAvailableLocales(),
            getLiveSiteId(),
        ]);
        // `enabled` is derived (true iff some site is live). Kept for any
        // legacy panel code still reading it; new code should branch on
        // liveSiteId === activeSiteId to know if *this* site is live.
        res.json({
            ...payload,
            locales,
            enabled: liveSiteId !== null,
            liveSiteId,
        });
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
        const { slug, title, copyFromId, templateId } = req.body || {};
        const result = await cmsStore.createPage(req.siteId, { slug, title, copyFromId, templateId });
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

// ── Page templates (global, org-wide) ────────────────────────────────
// The "apply" path doesn't need its own endpoint — callers pass
// templateId on POST /pages and the store walks the template's blocks
// into the new page with fresh block ids.
async function listTemplates(req, res) {
    try {
        const templates = await cmsStore.getTemplates();
        // Strip block payloads from the list response — they can be large
        // and the list view only needs name/description/blockCount/date.
        // The blocks land in the new page via templateId on POST /pages,
        // so the client never needs the blocks array on the list.
        const summary = templates.map(t => ({
            id:          t.id,
            name:        t.name,
            description: t.description || '',
            createdAt:   t.createdAt,
            blockCount:  Array.isArray(t.blocks) ? t.blocks.length : 0,
        }));
        res.json({ templates: summary });
    } catch (err) { res.status(500).json({ error: err.message }); }
}

async function postTemplate(req, res) {
    try {
        const { name, description, blocks } = req.body || {};
        const entry = await cmsStore.saveTemplate({ name, description, blocks });
        res.json({
            success: true,
            template: {
                id:          entry.id,
                name:        entry.name,
                description: entry.description || '',
                createdAt:   entry.createdAt,
                blockCount:  Array.isArray(entry.blocks) ? entry.blocks.length : 0,
            },
        });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function deleteTemplateHandler(req, res) {
    try {
        await cmsStore.deleteTemplate(req.params.id);
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

// Export the active site as a downloadable JSON file. The handler reads
// the full project doc + every PageDoc via cmsStore.exportSite, then
// streams it back with a Content-Disposition header so the browser
// triggers a file save dialog.
async function exportSiteHandler(req, res) {
    try {
        const payload = await cmsStore.exportSite(req.siteId);
        const safeName = (payload.site?.name || 'site')
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40) || 'site';
        const dateStr = new Date().toISOString().slice(0, 10);    // YYYY-MM-DD
        const filename = `site-${safeName}-${dateStr}.json`;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        // Pretty-print so diffs against re-exports are reviewable. The
        // file is small enough (a few hundred KB max in practice) that
        // the size overhead doesn't matter.
        res.send(JSON.stringify(payload, null, 2));
    } catch (err) {
        console.error('[CMS] export error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

// Import a site from an export payload. Generates fresh ids for the
// site, every page, and every block — re-import is always safe and
// never collides with existing data.
async function importSiteHandler(req, res) {
    try {
        const exportData = req.body;
        if (!exportData || typeof exportData !== 'object') {
            return res.status(400).json({ error: 'Request body must be a JSON object' });
        }
        const result = await cmsStore.importSite(exportData);
        res.status(201).json(result);
    } catch (err) {
        console.error('[CMS] import error:', err.message);
        res.status(400).json({ error: err.message });
    }
}

async function listSitesHandler(req, res) {
    try {
        const [sites, liveSiteId] = await Promise.all([
            cmsStore.listProjects(),
            getLiveSiteId(),
        ]);
        res.json({ sites, liveSiteId });
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

// Duplicate a site into a new version of the same version group. Deep-
// copies the SiteDoc + every PageDoc + every block with fresh ids. The
// copy is never live — live stays on whatever cms_live_site_id points at.
async function duplicateSiteHandler(req, res) {
    try {
        const created = await cmsStore.duplicateProject(req.siteId);
        res.status(201).json(created);
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function deleteSiteHandler(req, res) {
    try {
        await cmsStore.deleteProject(req.siteId);
        // If the deleted project was the live one, take the public site
        // dark rather than letting getLiveSiteId silently lazy-clear later.
        const liveSiteId = await configStore.getConfig(KEY_CMS_LIVE_SITE_ID);
        if (liveSiteId === req.siteId) {
            await configStore.setConfig(KEY_CMS_LIVE_SITE_ID, null);
        }
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function postSitePublish(req, res) {
    try {
        const result = await cmsStore.publishSite(req.siteId);
        res.json({ success: true, ...result });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function putSiteLive(req, res) {
    try {
        const { live } = req.body || {};
        if (typeof live !== 'boolean') {
            return res.status(400).json({ error: 'live must be a boolean' });
        }
        if (live) {
            // Setting this site live implicitly takes any other live site
            // offline — only one project can be live at a time.
            await setLiveSiteId(req.siteId);
            return res.json({ success: true, liveSiteId: req.siteId });
        }
        // Clearing only matters when *this* site is the currently-live
        // one; otherwise toggling it off is a no-op (avoids accidentally
        // dark-ing the public site from an inactive editor tab).
        const current = await getLiveSiteId();
        if (current === req.siteId) {
            await setLiveSiteId(null);
            return res.json({ success: true, liveSiteId: null });
        }
        res.json({ success: true, liveSiteId: current });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

// Org-wide handlers (only mounted on /admin/*).

async function putEnabled(req, res) {
    try {
        const { enabled, siteId } = req.body || {};
        if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
        if (!enabled) {
            // Org-wide off: clear the live id so the public site goes dark.
            await setLiveSiteId(null);
            return res.json({ success: true, enabled: false, liveSiteId: null });
        }
        // Org-wide on: callers may name a specific siteId to make live, or
        // omit it to keep the currently-live one (or fall back to the
        // first project if none has ever been live before).
        if (siteId) {
            const next = await setLiveSiteId(siteId);
            return res.json({ success: true, enabled: true, liveSiteId: next });
        }
        let next = await getLiveSiteId();
        if (!next) {
            const projects = await cmsStore.listProjects();
            next = projects[0]?.id || null;
            if (next) await setLiveSiteId(next);
        }
        res.json({ success: true, enabled: next !== null, liveSiteId: next });
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

        // SVGs are sanitized server-side (script / on*= / external href
        // stripped). Only the cleaned bytes ever reach storage, and we
        // tag the object as `sanitized` so the asset endpoint knows it
        // can serve it inline instead of force-downloading. A bad SVG
        // (parse fails, no <svg> root) returns 400 here.
        let body = req.file.buffer;
        let metadata = null;
        if (req.file.mimetype === 'image/svg+xml') {
            const clean = sanitizeSvg(req.file.buffer);
            if (!clean) return res.status(400).json({ error: 'Invalid or unsafe SVG' });
            body = clean;
            metadata = { sanitized: '1' };
        }

        await storageStore.uploadFile(key, body, req.file.mimetype, metadata);

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
 * `?slug=…` selects a page. When omitted the homepage is returned.
 * `?locale=…` picks a locale; falls back to default.
 *
 * Reads from whichever project is currently marked Live (cms_live_site_id).
 * When nothing is live the response is `{ enabled: false }` and the front-end
 * redirects "/" to /app.
 */
router.get('/site', async (req, res) => {
    try {
        // Public site serves whatever project is marked Live. If nothing is
        // live the public URL stays dark (RootPathGate redirects to /app).
        // Note: this is decoupled from the admin's active project — admins
        // can edit a different site without affecting what the public sees.
        const siteId = await getLiveSiteId();
        // Disable caching here — content updates from the admin should
        // appear immediately. Re-introduce a short TTL once edits push a
        // version bump or cache key.
        res.setHeader('Cache-Control', 'no-store');
        if (!siteId) {
            return res.json({ enabled: false });
        }

        const defaultLocale = await cmsStore.getDefaultLocale();
        const locale = (req.query.locale || defaultLocale).toString().toLowerCase().split('-')[0];
        const v2 = req.query.v === '2';
        const slug = (req.query.slug || '').toString();

        // Prefer the last-published snapshot. Sites that have never been
        // published fall through to the draft so existing live sites don't
        // suddenly go blank when this code ships.
        const eff = await cmsStore.getEffectivePublished(siteId, slug || null, locale)
                 || await cmsStore.getEffective(siteId, slug || null, locale);

        // Canonical URL for the served page: '' for the homepage, otherwise
        // its slug. The client uses this to redirect e.g. `/home` → `/` so
        // every page has exactly one URL.
        const canonicalSlug = eff.page?.isHomepage
            ? ''
            : (eff.page?.slug || '');

        // Diagnostic: short-lived log so we can see which site/slug was
        // resolved when the public site looks empty. Drop once stable.
        // `source` distinguishes published-snapshot reads from the draft
        // fallback used for sites that have never been published.
        const source = await cmsStore.getPublishedSnapshot(siteId).then(s => s ? 'published' : 'draft').catch(() => 'unknown');
        console.log(`[CMS] /site siteId=${siteId} slug="${slug}" source=${source} found=${eff.found} blocks=${eff.page?.blocks?.length ?? 0}`);

        if (v2) {
            return res.json({
                enabled: true,
                defaultLocale,
                locale,
                found: eff.found,
                canonicalSlug,
                page: eff.page,
                header: eff.header,
                footer: eff.footer,
                pages: eff.pages,
                design: eff.design,
            });
        }
        return res.json({
            enabled: true,
            // `found` lets the front-end distinguish "slug exists but has no
            // blocks" (render anyway) from "slug doesn't match any page"
            // (fall through to the BeeFlow app router) when path-routing.
            found: eff.found,
            canonicalSlug,
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

// MIME types that browsers would happily execute as script in the page
// origin if served inline. The upload whitelist already blocks new
// SVG/HTML uploads, but pre-existing assets and any future expansion of
// the whitelist must NOT be able to surprise us — so we force-download
// these by setting Content-Disposition: attachment regardless of what
// the storage layer reports.
const SCRIPTABLE_MIME_PREFIXES = ['image/svg', 'text/html', 'text/xml', 'application/xhtml', 'application/xml'];
function isScriptableMime(mime) {
    if (typeof mime !== 'string') return false;
    const lower = mime.toLowerCase();
    return SCRIPTABLE_MIME_PREFIXES.some(p => lower.startsWith(p));
}

router.get(/^\/asset\/(.+)$/, async (req, res) => {
    try {
        const key = req.params[0];
        if (!key.startsWith('cms/')) return res.status(404).json({ error: 'Not found' });
        if (!storageStore.isAvailable()) return res.status(503).json({ error: 'Storage unavailable' });

        const { stream, contentType, contentLength, metadata } = await storageStore.streamFile(key);
        const sanitized = metadata && (metadata.sanitized === '1' || metadata.Sanitized === '1');

        // Defense in depth: if the stored Content-Type would execute in
        // the browser when served inline (SVG, HTML, XML), force the
        // browser to download it — UNLESS it's a sanitized SVG, in which
        // case we serve it inline with a strict CSP that blocks scripts
        // and external network fetches even if the sanitizer ever
        // misses something. Legacy SVGs without the `sanitized` flag
        // still force-download.
        if (isScriptableMime(contentType)) {
            if (sanitized && /^image\/svg/i.test(contentType)) {
                res.setHeader('Content-Type', 'image/svg+xml');
                res.setHeader('Content-Security-Policy',
                    "default-src 'none'; style-src 'unsafe-inline'");
                res.setHeader('X-Content-Type-Options', 'nosniff');
            } else {
                res.setHeader('Content-Type', 'application/octet-stream');
                res.setHeader('Content-Disposition', 'attachment');
                res.setHeader('X-Content-Type-Options', 'nosniff');
            }
        } else {
            res.setHeader('Content-Type', contentType);
        }
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

// Publish — same handler as the multi-site route, scoped to the bridge's
// default site.
router.post('/admin/publish', publishLimiter, postSitePublish);

// Org-wide flags (not per-site — only available here).
router.put('/admin/enabled', putEnabled);
router.put('/admin/default-locale', putDefaultLocale);

// File uploads (org-wide bucket prefix).
router.post('/admin/upload', uploadLimiter, uploadFile, handleUpload);

// Page templates — global, shared across all sites. List/save/delete
// only; "apply" happens implicitly by passing `templateId` to POST page.
router.get('/admin/templates',        listTemplates);
router.post('/admin/templates',       postTemplate);
router.delete('/admin/templates/:id', deleteTemplateHandler);

// ══════════════════════════════════════════════════════════════════
// ADMIN — /sites and /sites/:siteId/* (explicit multi-site)
// ══════════════════════════════════════════════════════════════════

router.use('/sites', requireAdmin);

// Site-CRUD (no siteId yet, no attachSiteIdFromParam needed).
router.get('/sites', listSitesHandler);
router.post('/sites', createSiteHandler);
// IMPORTANT: `/sites/import` must register BEFORE the siteId param
// middleware below — otherwise `import` gets matched as a siteId and
// rejected by the `pj_[a-f0-9]+` format check.
router.post('/sites/import', importLimiter, importJsonParser, importSiteHandler);

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

// Site export — returns a JSON file (Content-Disposition: attachment)
// containing the full SiteDoc + every PageDoc + blocks. The
// counterpart `POST /sites/import` (registered earlier, before the
// siteId middleware) restores an export into a fresh siteId.
router.get('/sites/:siteId/export', exportSiteHandler);

// Per-site Live toggle — mutually exclusive across projects (only one
// can be live at a time; setting one live takes the previous one offline).
router.put('/sites/:siteId/live', putSiteLive);

// Duplicate a site into a new version (same versionGroupId, next "v{n}"
// name). Returns the new site's { id, name, versionGroupId, versionName }.
router.post('/sites/:siteId/duplicate', duplicateLimiter, duplicateSiteHandler);

// Publish — snapshot the current draft into cms_published_{siteId}. The
// public /api/cms/site route reads from this snapshot, so visitors only
// see content the user has explicitly published.
router.post('/sites/:siteId/publish', publishLimiter, postSitePublish);

// Site-level operations on the SiteDoc itself.
router.get('/sites/:siteId', getSitePayload);
router.put('/sites/:siteId', putSiteDoc);
router.patch('/sites/:siteId', renameSiteHandler);
router.delete('/sites/:siteId', deleteSiteHandler);

module.exports = router;
