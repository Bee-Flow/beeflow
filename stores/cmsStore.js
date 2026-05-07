/**
 * CMS Store — multi-project website builder.
 *
 * The CMS is a standalone tool inside Bee Flow that lets users build their
 * own websites (a bakery's site, a consultancy's site, a portfolio, etc.) —
 * each one fully independent. There is no single "Bee Flow website" being
 * edited here; every key is scoped to a specific project (`siteId`).
 *
 * Storage keys (all in the `config` table via configStore):
 *   cms_default_locale                                    string   fallback locale (default 'en')
 *   cms_projects_index                                    array    ordered list of {id, name, createdAt, updatedAt}
 *   cms_project_{siteId}                                  SiteDoc  per-site settings + page index
 *   cms_project_{siteId}_locale_{xx}                      site-locale override
 *   cms_project_{siteId}_page_{pageId}                    PageDoc
 *   cms_project_{siteId}_page_{pageId}_locale_{xx}        page-locale override
 *
 * Effective content for a request = SITE_DEFAULTS / BLOCK_DEFAULTS  ←
 *                                   default-locale stored content   ←
 *                                   requested-locale overrides.
 *
 * Locale overrides for blocks are keyed by block ID (not array index) so
 * reordering blocks never breaks translations.
 *
 * Serving model (Option A): preview only inside the admin iframe. There is
 * no public route that serves a project — publishing/domains is a future
 * phase. Callers in the admin panel pass siteId explicitly on every call.
 */

const crypto = require('crypto');
const configStore = require('./configStore');
const { getAll } = require('../db');
const {
    SITE_DEFAULTS,
    BLOCK_DEFAULTS,
    BLOCK_TYPE_IDS,
    RESERVED_SLUGS,
    DESIGN_DEFAULTS,
} = require('../i18n/defaults/cmsDefaults');

const KEY_DEFAULT_LOCALE  = 'cms_default_locale';
const KEY_PROJECTS_INDEX  = 'cms_projects_index';
const KEY_PROJECT_PFX     = 'cms_project_';                  // cms_project_{siteId}
const KEY_LOCALE_INFIX    = '_locale_';                      // ..._locale_{xx}
const KEY_PAGE_INFIX      = '_page_';                        // cms_project_{siteId}_page_{pageId}

const SITE_VERSION = 1;
const PAGE_VERSION = 1;
const LOCALE_OVERRIDE_VERSION = 1;
const INDEX_VERSION = 1;

// ── Small helpers ────────────────────────────────────────────────────

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function deepMerge(base, override) {
    if (override === undefined || override === null) return base;
    if (Array.isArray(override)) return override;
    if (typeof override !== 'object') return override;
    if (!isPlainObject(base)) return { ...override };
    const out = { ...base };
    for (const [k, v] of Object.entries(override)) {
        out[k] = deepMerge(base[k], v);
    }
    return out;
}

function normalizeSlug(raw) {
    return String(raw || '')
        .toLowerCase()
        .trim()
        .replace(/^\/+/, '')
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, 64);
}

function isReservedSlug(slug) {
    return RESERVED_SLUGS.has(String(slug || '').toLowerCase());
}

function assertSiteId(siteId) {
    if (!siteId || typeof siteId !== 'string' || !/^pj_[a-f0-9]{4,}$/.test(siteId)) {
        throw new Error('Invalid siteId');
    }
}

// Sanitize a `design` blob coming from the admin panel. Strict-but-tolerant:
// unknown fields are dropped, malformed values fall back to DESIGN_DEFAULTS.
// Always returns a complete shape so the renderer can rely on every field.
function sanitizeDesign(input) {
    const d = isPlainObject(input) ? input : {};
    const c = isPlainObject(d.colors) ? d.colors : {};
    const f = isPlainObject(d.fonts)  ? d.fonts  : {};
    const str = (v, fb) => (typeof v === 'string' ? v : fb);
    const numClamp = (v, lo, hi, fb) =>
        (typeof v === 'number' && v >= lo && v <= hi) ? Math.round(v) : fb;
    return {
        colors: {
            primary:       str(c.primary,       DESIGN_DEFAULTS.colors.primary),
            secondary:     str(c.secondary,     DESIGN_DEFAULTS.colors.secondary),
            accent:        str(c.accent,        DESIGN_DEFAULTS.colors.accent),
            background:    str(c.background,    DESIGN_DEFAULTS.colors.background),
            surface:       str(c.surface,       DESIGN_DEFAULTS.colors.surface),
            textPrimary:   str(c.textPrimary,   DESIGN_DEFAULTS.colors.textPrimary),
            textSecondary: str(c.textSecondary, DESIGN_DEFAULTS.colors.textSecondary),
        },
        fonts: {
            heading: str(f.heading, DESIGN_DEFAULTS.fonts.heading) || DESIGN_DEFAULTS.fonts.heading,
            body:    str(f.body,    DESIGN_DEFAULTS.fonts.body)    || DESIGN_DEFAULTS.fonts.body,
        },
        logo:     str(d.logo,    ''),
        favicon:  str(d.favicon, ''),
        radius:   numClamp(d.radius, 0, 24, DESIGN_DEFAULTS.radius),
        theme:    d.theme === 'dark' ? 'dark' : 'light',
        gradient: d.gradient === true,
    };
}

// ── Key builders (every key is project-scoped except the index) ──────

function projectKey(siteId)                        { return `${KEY_PROJECT_PFX}${siteId}`; }
function projectLocaleKey(siteId, locale)          { return `${KEY_PROJECT_PFX}${siteId}${KEY_LOCALE_INFIX}${locale}`; }
function pageKey(siteId, pageId)                   { return `${KEY_PROJECT_PFX}${siteId}${KEY_PAGE_INFIX}${pageId}`; }
function pageLocaleKey(siteId, pageId, locale)     { return `${KEY_PROJECT_PFX}${siteId}${KEY_PAGE_INFIX}${pageId}${KEY_LOCALE_INFIX}${locale}`; }

// ── Locale settings (org-wide) ───────────────────────────────────────

async function getDefaultLocale() {
    const v = await configStore.getConfig(KEY_DEFAULT_LOCALE);
    return (typeof v === 'string' && v) ? v : 'en';
}
async function setDefaultLocale(locale) {
    if (!locale || typeof locale !== 'string') throw new Error('Locale required');
    await configStore.setConfig(KEY_DEFAULT_LOCALE, locale);
}

// ── Projects index ───────────────────────────────────────────────────

function emptyIndex() {
    return { version: INDEX_VERSION, projects: [] };
}

async function getProjectsIndex() {
    const v = await configStore.getConfig(KEY_PROJECTS_INDEX);
    if (!isPlainObject(v) || !Array.isArray(v.projects)) return emptyIndex();
    return v;
}

async function setProjectsIndex(index) {
    await configStore.setConfig(KEY_PROJECTS_INDEX, {
        version: INDEX_VERSION,
        projects: Array.isArray(index.projects) ? index.projects : [],
    });
}

async function listProjects() {
    const index = await getProjectsIndex();
    return index.projects.map(p => ({
        id: p.id,
        name: p.name || 'Untitled site',
        createdAt: p.createdAt || null,
        updatedAt: p.updatedAt || null,
    }));
}

// ── Project CRUD ─────────────────────────────────────────────────────

function emptySite(siteId, name) {
    return {
        version: SITE_VERSION,
        id: siteId,
        name: name || 'Untitled site',
        homepageId: null,
        pages: [],
        header: clone(SITE_DEFAULTS.header),
        footer: clone(SITE_DEFAULTS.footer),
        design: clone(DESIGN_DEFAULTS),
    };
}

/**
 * Create a new project. Returns the freshly-registered project entry.
 * The new site is seeded with exactly one empty Home page (zero blocks);
 * the user adds blocks manually via the admin panel.
 */
async function createProject({ name } = {}) {
    const siteId = newId('pj');
    const now = new Date().toISOString();
    const site = emptySite(siteId, name);

    // Write the site doc first; if the index write fails the orphan
    // record is harmless and easy to garbage-collect later.
    await configStore.setConfig(projectKey(siteId), site);

    const index = await getProjectsIndex();
    index.projects.push({
        id: siteId,
        name: site.name,
        createdAt: now,
        updatedAt: now,
    });
    await setProjectsIndex(index);

    // Seed an empty Home page so a fresh site is immediately editable
    // (with no Bee-Flow-flavored block content). createPage handles the
    // homepage promotion since site.homepageId is currently null.
    await createPage(siteId, { slug: 'home', title: 'Home' });

    return { id: siteId, name: site.name, createdAt: now, updatedAt: now };
}

async function getProject(siteId) {
    assertSiteId(siteId);
    const v = await configStore.getConfig(projectKey(siteId));
    if (!isPlainObject(v)) return null;
    // Lazy migration — fill defaults for nav fields on pages stored
    // before showInNav / navOrder existed. Non-destructive: we don't
    // write back here. The next setProject call (any save through the
    // sanitizer) will persist the defaults to disk.
    if (Array.isArray(v.pages)) {
        v.pages = v.pages.map((p, i) => {
            if (!isPlainObject(p)) return p;
            const next = { ...p };
            if (next.showInNav === undefined) next.showInNav = true;
            if (typeof next.navOrder !== 'number' || !Number.isFinite(next.navOrder)) {
                next.navOrder = i;          // preserve current display order
            }
            return next;
        });
    }
    return v;
}

async function setProject(siteId, site) {
    assertSiteId(siteId);
    if (!isPlainObject(site)) throw new Error('Site must be an object');

    const sanitized = {
        version: SITE_VERSION,
        id: siteId,
        name: typeof site.name === 'string' && site.name ? site.name : 'Untitled site',
        homepageId: site.homepageId || null,
        pages: Array.isArray(site.pages) ? site.pages.map(sanitizePageIndexEntry).filter(Boolean) : [],
        header: isPlainObject(site.header) ? site.header : clone(SITE_DEFAULTS.header),
        footer: isPlainObject(site.footer) ? site.footer : clone(SITE_DEFAULTS.footer),
        design: sanitizeDesign(site.design),
    };

    if (sanitized.homepageId && !sanitized.pages.find(p => p.id === sanitized.homepageId)) {
        sanitized.homepageId = sanitized.pages[0]?.id || null;
    }
    sanitized.pages = sanitized.pages.map(p => ({
        ...p,
        isHomepage: p.id === sanitized.homepageId,
    }));

    await configStore.setConfig(projectKey(siteId), sanitized);

    // Touch the index so listProjects() reflects the new name + updatedAt.
    const index = await getProjectsIndex();
    const entry = index.projects.find(p => p.id === siteId);
    if (entry) {
        entry.name = sanitized.name;
        entry.updatedAt = new Date().toISOString();
        await setProjectsIndex(index);
    }
    return sanitized;
}

/**
 * Delete a project and every key associated with it. Idempotent: returns
 * silently if the site doesn't exist.
 */
async function deleteProject(siteId) {
    assertSiteId(siteId);
    const rows = await getAll(
        `SELECT key FROM config WHERE key = $1 OR key LIKE $2`,
        [projectKey(siteId), `${projectKey(siteId)}_%`]
    );
    for (const r of rows) await configStore.deleteConfig(r.key);

    const index = await getProjectsIndex();
    index.projects = index.projects.filter(p => p.id !== siteId);
    await setProjectsIndex(index);
}

async function renameProject(siteId, name) {
    const site = await getProject(siteId);
    if (!site) throw new Error('Project not found');
    site.name = name;
    return setProject(siteId, site);
}

function sanitizePageIndexEntry(entry) {
    if (!isPlainObject(entry) || !entry.id) return null;
    return {
        id: String(entry.id),
        slug: normalizeSlug(entry.slug || ''),
        title: typeof entry.title === 'string' ? entry.title : '',
        isHomepage: !!entry.isHomepage,
        hideHeader: !!entry.hideHeader,
        hideFooter: !!entry.hideFooter,
        isNotFound: !!entry.isNotFound,
        // Nav controls — every page is in the nav by default. navOrder
        // lets the user reorder nav items independently of array order.
        showInNav: entry.showInNav === undefined ? true : !!entry.showInNav,
        navOrder:  typeof entry.navOrder === 'number' && Number.isFinite(entry.navOrder)
            ? Math.round(entry.navOrder)
            : 0,
    };
}

// ── Site-locale overrides (header/footer text per locale) ────────────

async function getSiteLocaleOverride(siteId, locale) {
    assertSiteId(siteId);
    const v = await configStore.getConfig(projectLocaleKey(siteId, locale));
    return isPlainObject(v) ? v : null;
}
async function setSiteLocaleOverride(siteId, locale, override) {
    assertSiteId(siteId);
    if (!locale) throw new Error('Locale required');
    if (!isPlainObject(override)) throw new Error('Override must be an object');
    const sanitized = {
        version: LOCALE_OVERRIDE_VERSION,
        header:     isPlainObject(override.header) ? override.header : undefined,
        footer:     isPlainObject(override.footer) ? override.footer : undefined,
        pageTitles: isPlainObject(override.pageTitles) ? override.pageTitles : undefined,
    };
    await configStore.setConfig(projectLocaleKey(siteId, locale), sanitized);
}
async function deleteSiteLocaleOverride(siteId, locale) {
    assertSiteId(siteId);
    await configStore.deleteConfig(projectLocaleKey(siteId, locale));
}

// ── Pages ────────────────────────────────────────────────────────────

function emptyPage({ id, slug, title }) {
    return {
        version: PAGE_VERSION,
        id,
        slug,
        title: title || '',
        seo: { metaTitle: '', metaDescription: '', ogImage: '', noIndex: false },
        blocks: [],
    };
}

function makeBlock(type, contentOverride) {
    if (!BLOCK_TYPE_IDS.includes(type)) throw new Error(`Unknown block type: ${type}`);
    return {
        id: newId('blk'),
        type,
        enabled: true,
        content: contentOverride !== undefined
            ? contentOverride
            : clone(BLOCK_DEFAULTS[type]),
        style: {},
    };
}

async function getPage(siteId, pageId) {
    assertSiteId(siteId);
    const v = await configStore.getConfig(pageKey(siteId, pageId));
    return isPlainObject(v) ? v : null;
}

async function setPage(siteId, page) {
    assertSiteId(siteId);
    if (!isPlainObject(page) || !page.id) throw new Error('page.id required');
    const sanitized = {
        version: PAGE_VERSION,
        id: String(page.id),
        slug: normalizeSlug(page.slug || ''),
        title: typeof page.title === 'string' ? page.title : '',
        seo: isPlainObject(page.seo) ? {
            metaTitle:       typeof page.seo.metaTitle === 'string' ? page.seo.metaTitle : '',
            metaDescription: typeof page.seo.metaDescription === 'string' ? page.seo.metaDescription : '',
            ogImage:         typeof page.seo.ogImage === 'string' ? page.seo.ogImage : '',
            noIndex:         !!page.seo.noIndex,
        } : { metaTitle: '', metaDescription: '', ogImage: '', noIndex: false },
        blocks: Array.isArray(page.blocks)
            ? page.blocks.map(sanitizeBlock).filter(Boolean)
            : [],
    };
    await configStore.setConfig(pageKey(siteId, sanitized.id), sanitized);
    return sanitized;
}

function sanitizeBlock(block) {
    if (!isPlainObject(block) || !block.id || !BLOCK_TYPE_IDS.includes(block.type)) return null;
    return {
        id: String(block.id),
        type: block.type,
        enabled: block.enabled !== false,
        content: isPlainObject(block.content) ? block.content : {},
        style:   isPlainObject(block.style)   ? block.style   : {},
    };
}

async function deletePage(siteId, pageId) {
    assertSiteId(siteId);
    await configStore.deleteConfig(pageKey(siteId, pageId));
    const rows = await getAll(
        `SELECT key FROM config WHERE key LIKE $1`,
        [`${pageKey(siteId, pageId)}${KEY_LOCALE_INFIX}%`]
    );
    for (const r of rows) await configStore.deleteConfig(r.key);
}

async function getPageLocaleOverride(siteId, pageId, locale) {
    assertSiteId(siteId);
    const v = await configStore.getConfig(pageLocaleKey(siteId, pageId, locale));
    return isPlainObject(v) ? v : null;
}
async function setPageLocaleOverride(siteId, pageId, locale, override) {
    assertSiteId(siteId);
    if (!pageId) throw new Error('pageId required');
    if (!locale) throw new Error('Locale required');
    if (!isPlainObject(override)) throw new Error('Override must be an object');
    const sanitized = {
        version: LOCALE_OVERRIDE_VERSION,
        blocks: isPlainObject(override.blocks) ? override.blocks : {},
    };
    await configStore.setConfig(pageLocaleKey(siteId, pageId, locale), sanitized);
}
async function deletePageLocaleOverride(siteId, pageId, locale) {
    assertSiteId(siteId);
    await configStore.deleteConfig(pageLocaleKey(siteId, pageId, locale));
}

// ── Page-list operations (mutate site doc atomically) ────────────────

async function createPage(siteId, { slug, title, copyFromId } = {}) {
    const site = await getProject(siteId);
    if (!site) throw new Error('Project not found');

    const id = newId('pg');
    const baseSlug = normalizeSlug(slug || title || 'untitled') || 'untitled';
    const finalSlug = ensureUniqueSlug(baseSlug, site.pages, null);
    if (isReservedSlug(finalSlug)) throw new Error(`Slug "${finalSlug}" is reserved`);

    let page;
    if (copyFromId) {
        const source = await getPage(siteId, copyFromId);
        if (!source) throw new Error('Source page not found');
        page = {
            ...clone(source),
            id,
            slug: finalSlug,
            title: title || `${source.title} (copy)`,
            blocks: source.blocks.map(b => ({ ...clone(b), id: newId('blk') })),
        };
    } else {
        page = emptyPage({ id, slug: finalSlug, title: title || finalSlug });
    }
    await setPage(siteId, page);

    site.pages.push({
        id, slug: finalSlug, title: page.title,
        isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false,
        // Nav defaults: every new page is in the nav. navOrder is the
        // current array length so new pages append to the end of the
        // nav. The first page created (which becomes the homepage when
        // homepageId is still null) lands at index 0.
        showInNav: true,
        navOrder: site.pages.length,
    });
    if (!site.homepageId) site.homepageId = id;
    await setProject(siteId, site);
    return { id, slug: finalSlug };
}

function ensureUniqueSlug(slug, pages, ignoreId) {
    let candidate = slug;
    let i = 2;
    while (pages.some(p => p.id !== ignoreId && p.slug === candidate)) {
        candidate = `${slug}-${i++}`;
    }
    return candidate;
}

async function updatePageMeta(siteId, pageId, patch = {}) {
    const site = await getProject(siteId);
    if (!site) throw new Error('Project not found');
    const idx = site.pages.findIndex(p => p.id === pageId);
    if (idx < 0) throw new Error('Page not found');
    const current = site.pages[idx];

    if (patch.slug !== undefined) {
        const next = normalizeSlug(patch.slug) || current.slug;
        if (isReservedSlug(next)) throw new Error(`Slug "${next}" is reserved`);
        current.slug = ensureUniqueSlug(next, site.pages, pageId);
    }
    if (typeof patch.title === 'string') current.title = patch.title;
    if (typeof patch.hideHeader === 'boolean') current.hideHeader = patch.hideHeader;
    if (typeof patch.hideFooter === 'boolean') current.hideFooter = patch.hideFooter;
    if (typeof patch.isNotFound === 'boolean') current.isNotFound = patch.isNotFound;
    if (typeof patch.showInNav  === 'boolean') current.showInNav  = patch.showInNav;
    if (typeof patch.navOrder   === 'number' && Number.isFinite(patch.navOrder)) {
        current.navOrder = Math.round(patch.navOrder);
    }

    site.pages[idx] = current;

    const page = await getPage(siteId, pageId);
    if (page) {
        if (patch.slug  !== undefined) page.slug  = current.slug;
        if (patch.title !== undefined) page.title = current.title;
        await setPage(siteId, page);
    }
    await setProject(siteId, site);
    return current;
}

async function setHomepage(siteId, pageId) {
    const site = await getProject(siteId);
    if (!site) throw new Error('Project not found');
    if (!site.pages.find(p => p.id === pageId)) throw new Error('Page not found');
    site.homepageId = pageId;
    await setProject(siteId, site);
}

async function reorderPages(siteId, orderedIds) {
    const site = await getProject(siteId);
    if (!site) throw new Error('Project not found');
    const byId = new Map(site.pages.map(p => [p.id, p]));
    const next = [];
    for (const id of orderedIds) {
        if (byId.has(id)) {
            next.push(byId.get(id));
            byId.delete(id);
        }
    }
    for (const p of site.pages) if (byId.has(p.id)) next.push(p);
    site.pages = next;
    await setProject(siteId, site);
}

async function removePage(siteId, pageId) {
    const site = await getProject(siteId);
    if (!site) throw new Error('Project not found');
    site.pages = site.pages.filter(p => p.id !== pageId);
    if (site.homepageId === pageId) site.homepageId = site.pages[0]?.id || null;
    await setProject(siteId, site);
    await deletePage(siteId, pageId);
}

// ── Effective content (preview-time render) ──────────────────────────

/**
 * Resolve a stored Link object against the live page list. Returns
 *   { href, target?: '_blank', rel?, broken? }
 *
 * Note: `kind: 'app'` and `kind: 'page'` resolve relative to the website
 * being previewed — the renderer must interpret these inside the iframe's
 * own URL space, not Bee Flow's. (For a live site published at a custom
 * domain, these become real navigation; in the admin iframe, they stay
 * inside the preview route.)
 */
function resolveLink(link, pages) {
    if (!link || typeof link !== 'object') return { href: '#' };
    if (link.kind === 'external') {
        const out = { href: link.url || '#' };
        if (link.newTab) { out.target = '_blank'; out.rel = 'noopener noreferrer'; }
        return out;
    }
    if (link.kind === 'anchor') {
        return { href: `#${link.anchor || ''}` };
    }
    if (link.kind === 'app') {
        return { href: link.path || '/' };
    }
    if (link.kind === 'page') {
        const page = pages.find(p => p.id === link.pageId);
        if (!page) return { href: '#', broken: true };
        // The public site is served at `/` (RootPathGate in App.jsx). To stay
        // inside the product-website renderer, non-homepage pages route via
        // `/?slug=<slug>` so the browser keeps `pathname === '/'` and the
        // BeeFlow app router doesn't intercept the path.
        const base = page.isHomepage ? '/' : `/?slug=${encodeURIComponent(page.slug)}`;
        return { href: link.anchor ? `${base}#${link.anchor}` : base };
    }
    return { href: '#' };
}

function resolveLinksInTree(node, pages) {
    if (Array.isArray(node)) return node.map(n => resolveLinksInTree(n, pages));
    if (!isPlainObject(node)) return node;
    if (typeof node.kind === 'string' && ['page', 'external', 'anchor', 'app'].includes(node.kind)) {
        return resolveLink(node, pages);
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = resolveLinksInTree(v, pages);
    return out;
}

/**
 * Resolve the effective response for a preview request.
 *   siteId — the project being previewed
 *   slug   — the page slug, or null/'' for the homepage
 *   locale — requested locale
 *
 * Returns { found, page, header, footer, pages } where `page` is the
 * fully-merged page (block content already locale-merged, links resolved)
 * or null when no match. `pages` is the public sitemap (id+slug+title).
 */
async function getEffective(siteId, slug, locale) {
    const site = await getProject(siteId);
    if (!site) return { found: false, page: null, header: null, footer: null, pages: [], design: clone(DESIGN_DEFAULTS) };

    const defaultLocale = await getDefaultLocale();
    const reqLocale = (locale || defaultLocale || 'en').toLowerCase().split('-')[0];

    // Design is global per site (no locale layer per call F).
    // sanitizeDesign also fills missing fields for sites that pre-date the
    // design system, so the renderer can rely on a complete shape.
    const design = sanitizeDesign(site.design);

    const publicPages = site.pages.map(p => ({
        id: p.id, slug: p.slug, title: p.title, isHomepage: !!p.isHomepage,
        showInNav: p.showInNav !== false,
        navOrder:  typeof p.navOrder === 'number' ? p.navOrder : 0,
    }));

    let entry = null;
    if (!slug) {
        // Three-layer fallback so the live site lands on the homepage even
        // if `homepageId` got nulled by an old migration or external edit:
        //   1. id-based lookup via site.homepageId (canonical)
        //   2. flag-based lookup via isHomepage (derived from homepageId on
        //      every save, but a safety net for stale data)
        //   3. first page in the array (last resort — same as before)
        entry = site.pages.find(p => p.id === site.homepageId)
             || site.pages.find(p => p.isHomepage)
             || site.pages[0]
             || null;
    } else {
        const norm = normalizeSlug(slug);
        entry = site.pages.find(p => p.slug === norm) || null;
    }

    const siteOverride = reqLocale && reqLocale !== defaultLocale
        ? await getSiteLocaleOverride(siteId, reqLocale)
        : null;
    let header = deepMerge(clone(SITE_DEFAULTS.header), site.header);
    let footer = deepMerge(clone(SITE_DEFAULTS.footer), site.footer);
    if (siteOverride) {
        if (siteOverride.header) header = deepMerge(header, siteOverride.header);
        if (siteOverride.footer) footer = deepMerge(footer, siteOverride.footer);
    }
    header = resolveLinksInTree(header, site.pages);
    footer = resolveLinksInTree(footer, site.pages);

    if (!entry) {
        return { found: false, page: null, header, footer, pages: publicPages, design };
    }

    const pageDoc = await getPage(siteId, entry.id);
    if (!pageDoc) {
        return { found: false, page: null, header, footer, pages: publicPages, design };
    }

    let blocks = pageDoc.blocks.map(b => clone(b));
    if (reqLocale !== defaultLocale) {
        const override = await getPageLocaleOverride(siteId, entry.id, reqLocale);
        if (override?.blocks) {
            blocks = blocks.map(b => {
                const ov = override.blocks[b.id];
                if (!ov) return b;
                return { ...b, content: deepMerge(b.content, ov.content || {}) };
            });
        }
    }

    let title = pageDoc.title;
    if (siteOverride?.pageTitles?.[entry.id]) title = siteOverride.pageTitles[entry.id];

    blocks = blocks.map(b => ({ ...b, content: resolveLinksInTree(b.content, site.pages) }));

    const page = {
        id: entry.id,
        slug: entry.slug,
        title,
        isHomepage: !!entry.isHomepage,
        hideHeader: !!entry.hideHeader,
        hideFooter: !!entry.hideFooter,
        isNotFound: !!entry.isNotFound,
        seo: pageDoc.seo,
        blocks,
    };
    return { found: true, page, header, footer, pages: publicPages, design };
}

/**
 * Compute the page graph for the sitemap diagram.
 * Edges are deduped per (source, target).
 */
async function getSiteGraph(siteId) {
    const site = await getProject(siteId);
    if (!site) return { nodes: [], edges: [] };

    const nodes = site.pages.map(p => ({
        id: p.id, slug: p.slug, title: p.title, isHomepage: !!p.isHomepage,
    }));

    const seen = new Set();
    const edges = [];
    const addEdge = (source, target) => {
        if (!source || !target || source === target) return;
        const k = `${source}->${target}`;
        if (seen.has(k)) return;
        seen.add(k);
        edges.push({ source, target });
    };

    const collectPageLinks = (sourceId, node) => {
        if (Array.isArray(node)) { node.forEach(n => collectPageLinks(sourceId, n)); return; }
        if (!isPlainObject(node)) return;
        if (node.kind === 'page' && node.pageId) addEdge(sourceId, node.pageId);
        for (const v of Object.values(node)) collectPageLinks(sourceId, v);
    };

    const chromeTargets = new Set();
    const collectChrome = (node) => {
        if (Array.isArray(node)) { node.forEach(collectChrome); return; }
        if (!isPlainObject(node)) return;
        if (node.kind === 'page' && node.pageId) chromeTargets.add(node.pageId);
        for (const v of Object.values(node)) collectChrome(v);
    };
    collectChrome(site.header);
    collectChrome(site.footer);

    for (const entry of site.pages) {
        const page = await getPage(siteId, entry.id);
        if (page) collectPageLinks(entry.id, page.blocks);
        for (const target of chromeTargets) addEdge(entry.id, target);
    }

    return { nodes, edges };
}

// ── Admin payload (full editor state for one project) ────────────────

async function getAdminPayload(siteId) {
    const site = await getProject(siteId);
    if (!site) throw new Error('Project not found');

    // Lazily fill design defaults on read so panel doesn't have to special-case
    // sites stored before the design system existed. The next save persists it
    // through setProject's sanitizer (no extra write here).
    site.design = sanitizeDesign(site.design);

    const defaultLocale = await getDefaultLocale();

    const pages = [];
    for (const entry of site.pages) {
        const page = await getPage(siteId, entry.id);
        if (page) pages.push(page);
    }

    // Collect all locale-override keys for this project. The like-pattern
    // matches both site-locale and page-locale rows; we sort them out by
    // checking for `_page_` in the key.
    const allLocaleKeys = await getAll(
        `SELECT key FROM config WHERE key LIKE $1`,
        [`${projectKey(siteId)}%${KEY_LOCALE_INFIX}%`]
    );
    const siteByLocale = {};
    const pagesByLocale = {};
    for (const r of allLocaleKeys) {
        const tail = r.key.substring(projectKey(siteId).length);
        // tail is one of:
        //   _locale_{xx}                          → site-locale override
        //   _page_{pageId}_locale_{xx}            → page-locale override
        if (tail.startsWith(KEY_PAGE_INFIX)) {
            const inner = tail.substring(KEY_PAGE_INFIX.length);
            const splitAt = inner.indexOf(KEY_LOCALE_INFIX);
            if (splitAt < 0) continue;
            const pageId = inner.substring(0, splitAt);
            const locale = inner.substring(splitAt + KEY_LOCALE_INFIX.length);
            pagesByLocale[pageId] = pagesByLocale[pageId] || {};
            pagesByLocale[pageId][locale] = await configStore.getConfig(r.key);
        } else if (tail.startsWith(KEY_LOCALE_INFIX)) {
            const locale = tail.substring(KEY_LOCALE_INFIX.length);
            siteByLocale[locale] = await configStore.getConfig(r.key);
        }
    }

    return {
        defaultLocale,
        site,
        pages,
        localeOverrides: { siteByLocale, pagesByLocale },
    };
}

module.exports = {
    // locale settings
    getDefaultLocale, setDefaultLocale,
    // projects
    listProjects, createProject, getProject, setProject, deleteProject, renameProject,
    // site-locale overrides
    getSiteLocaleOverride, setSiteLocaleOverride, deleteSiteLocaleOverride,
    // pages
    getPage, setPage, deletePage,
    getPageLocaleOverride, setPageLocaleOverride, deletePageLocaleOverride,
    createPage, removePage, updatePageMeta, setHomepage, reorderPages,
    // preview / graph
    getEffective, getSiteGraph,
    // admin
    getAdminPayload,
    // helpers / constants for tests
    makeBlock, resolveLink,
    BLOCK_TYPE_IDS, RESERVED_SLUGS,
};
