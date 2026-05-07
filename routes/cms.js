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

const cmsStore = require('../stores/cmsStore');
const configStore = require('../stores/configStore');
const languageStore = require('../stores/languageStore');
const storageStore = require('../stores/storageStore');
const { hasPermission } = require('../auth/permissions');

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
            // target?, rel?} shape Header.jsx renders.
            ctas: (eff.header.ctas || []).map(cta => ({
                id: cta.id,
                label: cta.label,
                href:  cta.link?.href || '/app',
                style: cta.style || 'primary',
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

// Publish — same handler as the multi-site route, scoped to the bridge's
// default site.
router.post('/admin/publish', postSitePublish);

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

// Per-site Live toggle — mutually exclusive across projects (only one
// can be live at a time; setting one live takes the previous one offline).
router.put('/sites/:siteId/live', putSiteLive);

// Publish — snapshot the current draft into cms_published_{siteId}. The
// public /api/cms/site route reads from this snapshot, so visitors only
// see content the user has explicitly published.
router.post('/sites/:siteId/publish', postSitePublish);

// Site-level operations on the SiteDoc itself.
router.get('/sites/:siteId', getSitePayload);
router.put('/sites/:siteId', putSiteDoc);
router.patch('/sites/:siteId', renameSiteHandler);
router.delete('/sites/:siteId', deleteSiteHandler);

module.exports = router;
