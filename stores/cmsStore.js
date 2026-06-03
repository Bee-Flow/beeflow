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
const KEY_PUBLISHED_PFX   = 'cms_published_';                // cms_published_{siteId} — last-published snapshot
// Templates are GLOBAL — not scoped to a site. A template saved from one
// site can be applied when creating a new page in any site. Stored under
// a single top-level key as an array; the writes are full-list replace
// so there is no race window where a partial entry can land.
const KEY_TEMPLATES       = 'cms_templates';

// SITE_VERSION 3: header now supports a `ctas` array (multiple action
// buttons with style: primary/secondary/ghost/link) instead of a single
// ctaLink+ctaLabel pair, and a `logo` block (image src + text + style).
// The lazy migration in getProject seeds header.ctas once from the old
// ctaLabel/ctaLink (+ loginLabel as a ghost button) so existing live
// sites don't lose their header buttons.
//
// SITE_VERSION 2: pages no longer auto-merge into header.nav at render
// time; nav is fully owned by the user via Site chrome.
const SITE_VERSION = 3;
const PAGE_VERSION = 1;
const LOCALE_OVERRIDE_VERSION = 1;
const INDEX_VERSION = 1;
const PUBLISHED_VERSION = 1;

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

// Merge a sparse, text-only locale OVERRIDE onto BASE content. Unlike
// deepMerge (which replaces arrays wholesale), this is purpose-built for the
// per-locale translation layer:
//   - Structure is driven entirely by BASE: arrays merge by index (base
//     length wins, missing/extra override slots fall back to base), objects
//     recurse over base's key set only. So icons/links/styles/order are never
//     lost — they always come from the default-locale base.
//   - Text wins from the override only when it's a NON-EMPTY string, so a
//     cleared translation (empty string) reverts to the source text.
// Keep this in sync with the client mirror in
// agent-hub/src/components/admin/ProductWebsite/localeMerge.js.
function mergeLocaleContent(base, override) {
    if (override === undefined || override === null) return base;
    if (Array.isArray(base)) {
        if (!Array.isArray(override)) return base;
        return base.map((el, i) =>
            i < override.length ? mergeLocaleContent(el, override[i]) : el);
    }
    if (Array.isArray(override)) return base;
    if (isPlainObject(base)) {
        if (!isPlainObject(override)) return base;
        const out = { ...base };
        for (const k of Object.keys(base)) {
            if (Object.prototype.hasOwnProperty.call(override, k)) {
                out[k] = mergeLocaleContent(base[k], override[k]);
            }
        }
        return out;
    }
    if (typeof override === 'string' && override.trim() !== '') return override;
    return base;
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
function publishedKey(siteId)                      { return `${KEY_PUBLISHED_PFX}${siteId}`; }

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
        // Versioning fields. Backfilled here for index entries that
        // pre-date versioning: such a site is its own version group
        // (groupId = its id) and is named "v1".
        versionGroupId: p.versionGroupId || p.id,
        versionName: p.versionName || 'v1',
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
        // A brand-new site founds its own version group. Duplicates copy
        // this groupId so every version of a site shares one identifier.
        versionGroupId: siteId,
        versionName: 'v1',
        homepageId: null,
        pages: [],
        header: clone(SITE_DEFAULTS.header),
        footer: clone(SITE_DEFAULTS.footer),
        cookieBanner: clone(SITE_DEFAULTS.cookieBanner),
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
        versionGroupId: site.versionGroupId,
        versionName: site.versionName,
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

    // Lazy v1 → v2 migration: pages used to auto-merge into the header
    // nav at render time. That merge was removed; without a one-shot
    // seed, existing live sites would lose their visible nav after the
    // deploy. Seed header.nav from the current page list — but only when
    // the user hasn't customised nav already (empty array or unset). Once
    // setProject persists the bumped version field this branch is inert
    // for that site, so opting back into "no nav at all" by clearing the
    // list later is preserved.
    const storedVersion = typeof v.version === 'number' ? v.version : 1;
    if (storedVersion < SITE_VERSION) {
        const header = isPlainObject(v.header) ? v.header : clone(SITE_DEFAULTS.header);
        const navEmpty = !Array.isArray(header.nav) || header.nav.length === 0;
        const pages = Array.isArray(v.pages) ? v.pages : [];
        if (navEmpty && pages.length > 0) {
            header.nav = pages
                .filter(p => isPlainObject(p) && !p.isHomepage)
                // Preserve the old auto-nav filtering so users who'd
                // already toggled "Show in nav" off don't suddenly see
                // those pages re-appear post-migration.
                .filter(p => p.showInNav !== false)
                .slice()
                .sort((a, b) => (a.navOrder ?? 0) - (b.navOrder ?? 0))
                .map(p => ({
                    id: newId('nav'),
                    label: p.title || p.slug,
                    link: { kind: 'page', pageId: p.id },
                }));
            v.header = header;
        }

        // v2 → v3: header now supports a `ctas` array. Seed it from the
        // legacy single-CTA fields once so existing sites keep rendering
        // both their Log in + Get started buttons exactly as before.
        // Order: Log in (ghost) first, primary CTA last — matches the old
        // Header.jsx layout. Skipped if the user already has ctas set
        // (idempotent: re-running the migration is a no-op).
        const ctasEmpty = !Array.isArray(header.ctas) || header.ctas.length === 0;
        if (ctasEmpty) {
            header.ctas = [
                // The old Header always rendered a Log in button with a
                // hard-coded `/app` href, falling back to the literal
                // "Log in" when loginLabel was empty. Match that exactly.
                {
                    id: newId('cta'),
                    label: (typeof header.loginLabel === 'string' && header.loginLabel.trim())
                        ? header.loginLabel
                        : 'Log in',
                    link: { kind: 'app', path: '/app' },
                    style: 'ghost',
                },
                // Primary CTA — derived from ctaLabel + ctaLink. Falls
                // back to a sensible default so a site with no legacy
                // CTA at all gets a starter "Get started" button rather
                // than a blank header.
                {
                    id: newId('cta'),
                    label: header.ctaLabel || 'Get started',
                    link: isPlainObject(header.ctaLink)
                        ? header.ctaLink
                        : { kind: 'app', path: '/app' },
                    style: 'primary',
                },
            ];
            v.header = header;
        }
    }

    // Versioning fields — ensured lazily so sites stored before versioning
    // existed still resolve a groupId. Such a site is its own group
    // (groupId = its id), named "v1". Persisted on the next setProject.
    if (typeof v.versionGroupId !== 'string' || !v.versionGroupId) {
        v.versionGroupId = v.id;
    }
    if (typeof v.versionName !== 'string' || !v.versionName) {
        v.versionName = 'v1';
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
        // Versioning: groupId is immutable once set (falls back to this
        // site's own id for sites that pre-date versioning); versionName
        // is a free-form label ("v1", "v2", …) capped to a sane length.
        versionGroupId: (typeof site.versionGroupId === 'string' && /^pj_[a-f0-9]+$/.test(site.versionGroupId))
            ? site.versionGroupId
            : siteId,
        versionName: (typeof site.versionName === 'string' && site.versionName.trim())
            ? site.versionName.trim().slice(0, 40)
            : 'v1',
        homepageId: site.homepageId || null,
        pages: Array.isArray(site.pages) ? site.pages.map(sanitizePageIndexEntry).filter(Boolean) : [],
        header: isPlainObject(site.header) ? site.header : clone(SITE_DEFAULTS.header),
        footer: isPlainObject(site.footer) ? site.footer : clone(SITE_DEFAULTS.footer),
        cookieBanner: isPlainObject(site.cookieBanner) ? site.cookieBanner : clone(SITE_DEFAULTS.cookieBanner),
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
        // Mirror versioning fields onto the index entry so listProjects()
        // can build the version switcher without reading every SiteDoc.
        entry.versionGroupId = sanitized.versionGroupId;
        entry.versionName = sanitized.versionName;
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
    // Published snapshot uses a separate prefix — clean it up explicitly.
    await configStore.deleteConfig(publishedKey(siteId));

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

/**
 * Duplicate a project into a new version of the same version group.
 *
 * Deep-copies the SiteDoc, every PageDoc, and every block — all with
 * fresh ids — and rewrites internal `{kind:'page', pageId}` link
 * references (header / footer chrome + block content) to the cloned
 * page ids so the copy's links stay self-contained.
 *
 * The new site shares the source's `versionGroupId`, is named the next
 * free "v{n}" within that group, and is NOT made live (live is the
 * single global cms_live_site_id, untouched here).
 */
async function duplicateProject(sourceSiteId) {
    const source = await getProject(sourceSiteId);
    if (!source) throw new Error('Project not found');

    const newSiteId = newId('pj');
    const now = new Date().toISOString();
    const versionGroupId = source.versionGroupId || sourceSiteId;

    // Pre-allocate the old→new page id mapping so links can be rewritten
    // before any PageDoc is written.
    const pageIdMap = new Map();
    for (const entry of source.pages || []) {
        if (entry && entry.id) pageIdMap.set(entry.id, newId('pg'));
    }

    // Rewrite {kind:'page', pageId} references onto the cloned page ids.
    // Non-page links and primitives pass through untouched.
    const remap = (node) => {
        if (Array.isArray(node)) return node.map(remap);
        if (!isPlainObject(node)) return node;
        if (node.kind === 'page' && node.pageId && pageIdMap.has(node.pageId)) {
            return { ...node, pageId: pageIdMap.get(node.pageId) };
        }
        const out = {};
        for (const [k, v] of Object.entries(node)) out[k] = remap(v);
        return out;
    };

    // Next free "v{n}" label within the group — max existing suffix + 1.
    const index = await getProjectsIndex();
    let maxN = 0;
    for (const p of index.projects) {
        if ((p.versionGroupId || p.id) !== versionGroupId) continue;
        const m = /^v(\d+)$/.exec(p.versionName || 'v1');
        maxN = Math.max(maxN, m ? parseInt(m[1], 10) : 1);
    }
    const versionName = `v${maxN + 1}`;

    const newSite = {
        version: SITE_VERSION,
        id: newSiteId,
        name: source.name,
        versionGroupId,
        versionName,
        homepageId: source.homepageId ? (pageIdMap.get(source.homepageId) || null) : null,
        pages: (source.pages || [])
            .filter(e => e && pageIdMap.has(e.id))
            .map(e => ({ ...clone(e), id: pageIdMap.get(e.id) })),
        header: remap(clone(source.header || {})),
        footer: remap(clone(source.footer || {})),
        // No internal page-links inside the banner (privacyUrl is a plain
        // URL string), so a straight clone is enough — no remap needed.
        cookieBanner: clone(source.cookieBanner || {}),
        design: clone(source.design || {}),
    };
    await configStore.setConfig(projectKey(newSiteId), newSite);

    // Deep-copy each PageDoc with a fresh page id + fresh block ids,
    // remapping any internal page links inside block content too.
    for (const entry of source.pages || []) {
        const doc = await getPage(sourceSiteId, entry.id);
        if (!doc) continue;
        const newPageId = pageIdMap.get(entry.id);
        await setPage(newSiteId, {
            ...clone(doc),
            id: newPageId,
            blocks: (doc.blocks || []).map(b => ({
                ...clone(b),
                id: newId('blk'),
                content: isPlainObject(b.content) ? remap(b.content) : (b.content || {}),
            })),
        });
    }

    index.projects.push({
        id: newSiteId,
        name: newSite.name,
        versionGroupId,
        versionName,
        createdAt: now,
        updatedAt: now,
    });
    await setProjectsIndex(index);

    return { id: newSiteId, name: newSite.name, versionGroupId, versionName, createdAt: now, updatedAt: now };
}

function sanitizePageIndexEntry(entry) {
    if (!isPlainObject(entry) || !entry.id) return null;
    // showInNav / navOrder were used by the old auto-merge of pages into
    // the header nav. Pages no longer drive the nav, so those fields are
    // intentionally omitted here — old persisted values are dropped on
    // the next save (lazy cleanup, no migration script needed).
    return {
        id: String(entry.id),
        slug: normalizeSlug(entry.slug || ''),
        title: typeof entry.title === 'string' ? entry.title : '',
        isHomepage: !!entry.isHomepage,
        hideHeader: !!entry.hideHeader,
        hideFooter: !!entry.hideFooter,
        isNotFound: !!entry.isNotFound,
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
    // Short-lived diagnostic so we can confirm block saves are landing in
    // the DB. Drop alongside the publish/site logs once verified.
    console.log(`[CMS] setPage siteId=${siteId} pageId=${sanitized.id} blocks=${sanitized.blocks.length}`);
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
    // SEO meta translations (metaTitle / metaDescription) live alongside the
    // block overrides on the page-locale key. Strings only — anything else is
    // dropped so the override stays a pure text patch.
    if (isPlainObject(override.seo)) {
        const seo = {};
        if (typeof override.seo.metaTitle === 'string') seo.metaTitle = override.seo.metaTitle;
        if (typeof override.seo.metaDescription === 'string') seo.metaDescription = override.seo.metaDescription;
        if (Object.keys(seo).length) sanitized.seo = seo;
    }
    await configStore.setConfig(pageLocaleKey(siteId, pageId, locale), sanitized);
}
async function deletePageLocaleOverride(siteId, pageId, locale) {
    assertSiteId(siteId);
    await configStore.deleteConfig(pageLocaleKey(siteId, pageId, locale));
}

// ── Page-list operations (mutate site doc atomically) ────────────────

async function createPage(siteId, { slug, title, copyFromId, templateId } = {}) {
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
    } else if (templateId) {
        // Apply a saved template — blocks come back already deep-cloned
        // with fresh ids, so we can drop them straight onto an empty page.
        const blocks = await applyTemplate(templateId);
        page = {
            ...emptyPage({ id, slug: finalSlug, title: title || finalSlug }),
            blocks,
        };
    } else {
        page = emptyPage({ id, slug: finalSlug, title: title || finalSlug });
    }
    await setPage(siteId, page);

    // New pages are NOT auto-added to the header nav. The user adds nav
    // items explicitly via Site chrome → Nav links and picks "Internal
    // page" if they want this page to appear there.
    site.pages.push({
        id, slug: finalSlug, title: page.title,
        isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false,
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
    // showInNav / navOrder removed — pages don't drive the nav anymore.

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

// Recursively walk a site-chrome subtree (header/footer) and strip any
// link references to the given pageId. The renderer's resolveLink already
// degrades broken page links gracefully ({ href: '#', broken: true }), but
// stored references also show up as ghost nav items in the editor, so we
// clean them at delete time.
//
// Two patterns are handled:
//   1. Array items keyed by `link` (nav items, ctas, footer column links):
//      drop the whole item when its link points at the deleted page.
//   2. Direct link objects on a parent property (e.g. logo.link): replace
//      with an inert anchor link so the parent's shape stays valid.
function stripPageRefsToDeleted(node, deletedPageId) {
    if (Array.isArray(node)) {
        return node
            .filter(item => !(isPlainObject(item)
                && isPlainObject(item.link)
                && item.link.kind === 'page'
                && item.link.pageId === deletedPageId))
            .map(item => stripPageRefsToDeleted(item, deletedPageId));
    }
    if (!isPlainObject(node)) return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
        if (isPlainObject(v) && v.kind === 'page' && v.pageId === deletedPageId) {
            out[k] = { kind: 'anchor', anchor: '' };
            continue;
        }
        out[k] = stripPageRefsToDeleted(v, deletedPageId);
    }
    return out;
}

async function removePage(siteId, pageId) {
    const site = await getProject(siteId);
    if (!site) throw new Error('Project not found');
    site.pages = site.pages.filter(p => p.id !== pageId);
    if (site.homepageId === pageId) site.homepageId = site.pages[0]?.id || null;
    if (isPlainObject(site.header)) site.header = stripPageRefsToDeleted(site.header, pageId);
    if (isPlainObject(site.footer)) site.footer = stripPageRefsToDeleted(site.footer, pageId);
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
        // The public site uses path-based routing: `/` for the homepage,
        // `/<slug>` for everything else. AppRoot in App.jsx routes any
        // non-reserved single-segment path into the marketing renderer.
        const base = page.isHomepage ? '/' : `/${encodeURIComponent(page.slug)}`;
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
    return resolveEffective(siteId, slug, locale, {
        getSite:                () => getProject(siteId),
        getPage:                (pageId) => getPage(siteId, pageId),
        getSiteLocaleOverride:  (loc) => getSiteLocaleOverride(siteId, loc),
        getPageLocaleOverride:  (pageId, loc) => getPageLocaleOverride(siteId, pageId, loc),
    });
}

/**
 * Same as getEffective, but reads from the last-published snapshot
 * (cms_published_{siteId}). Returns null when no snapshot exists yet so
 * the caller can fall back to draft content (preserves the pre-publish
 * behavior for sites that have never been published).
 */
async function getEffectivePublished(siteId, slug, locale) {
    const snap = await getPublishedSnapshot(siteId);
    if (!snap || !isPlainObject(snap.site)) return null;
    const pages = isPlainObject(snap.pages) ? snap.pages : {};
    const siteOv = isPlainObject(snap.siteLocaleOverrides) ? snap.siteLocaleOverrides : {};
    const pageOv = isPlainObject(snap.pageLocaleOverrides) ? snap.pageLocaleOverrides : {};
    return resolveEffective(siteId, slug, locale, {
        getSite:                async () => snap.site,
        getPage:                async (pageId) => pages[pageId] || null,
        getSiteLocaleOverride:  async (loc) => siteOv[loc] || null,
        getPageLocaleOverride:  async (pageId, loc) => pageOv[pageId]?.[loc] || null,
    });
}

async function resolveEffective(siteId, slug, locale, ctx) {
    const site = await ctx.getSite();
    if (!site) return { found: false, page: null, header: null, footer: null, cookieBanner: null, pages: [], design: clone(DESIGN_DEFAULTS) };

    const defaultLocale = await getDefaultLocale();
    const reqLocale = (locale || defaultLocale || 'en').toLowerCase().split('-')[0];

    // Design is global per site (no locale layer per call F).
    // sanitizeDesign also fills missing fields for sites that pre-date the
    // design system, so the renderer can rely on a complete shape.
    const design = sanitizeDesign(site.design);

    const publicPages = site.pages.map(p => ({
        id: p.id, slug: p.slug, title: p.title, isHomepage: !!p.isHomepage,
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
        ? await ctx.getSiteLocaleOverride(reqLocale)
        : null;
    let header = deepMerge(clone(SITE_DEFAULTS.header), site.header);
    let footer = deepMerge(clone(SITE_DEFAULTS.footer), site.footer);
    if (siteOverride) {
        // Locale chrome overrides are sparse text-only patches: merge by index
        // so nav/footer link structure (kind/url/style) stays owned by base.
        if (siteOverride.header) header = mergeLocaleContent(header, siteOverride.header);
        if (siteOverride.footer) footer = mergeLocaleContent(footer, siteOverride.footer);
    }
    header = resolveLinksInTree(header, site.pages);
    footer = resolveLinksInTree(footer, site.pages);
    // Cookie banner is global per site (no locale layer — text carries all
    // locales) and has no internal page-links, so no resolveLinksInTree.
    const cookieBanner = deepMerge(clone(SITE_DEFAULTS.cookieBanner), site.cookieBanner);

    if (!entry) {
        return { found: false, page: null, header, footer, cookieBanner, pages: publicPages, design };
    }

    const pageDoc = await ctx.getPage(entry.id);
    if (!pageDoc) {
        return { found: false, page: null, header, footer, cookieBanner, pages: publicPages, design };
    }

    let blocks = pageDoc.blocks.map(b => clone(b));
    // Fetched once and reused for block content + SEO translation below.
    const pageOverride = reqLocale !== defaultLocale
        ? await ctx.getPageLocaleOverride(entry.id, reqLocale)
        : null;
    if (pageOverride?.blocks) {
        blocks = blocks.map(b => {
            const ov = pageOverride.blocks[b.id];
            if (!ov) return b;
            return { ...b, content: mergeLocaleContent(b.content, ov.content || {}) };
        });
    }

    let title = pageDoc.title;
    if (siteOverride?.pageTitles?.[entry.id]) title = siteOverride.pageTitles[entry.id];

    // SEO meta is translatable too — merge the page override's `seo` patch.
    let seo = pageDoc.seo;
    if (pageOverride?.seo) seo = mergeLocaleContent(pageDoc.seo, pageOverride.seo);

    blocks = blocks.map(b => ({ ...b, content: resolveLinksInTree(b.content, site.pages) }));

    const page = {
        id: entry.id,
        slug: entry.slug,
        title,
        isHomepage: !!entry.isHomepage,
        hideHeader: !!entry.hideHeader,
        hideFooter: !!entry.hideFooter,
        isNotFound: !!entry.isNotFound,
        seo,
        blocks,
    };
    return { found: true, page, header, footer, cookieBanner, pages: publicPages, design };
}

// ── Publishing ───────────────────────────────────────────────────────
//
// Publishing snapshots the entire current state of a project (SiteDoc +
// every PageDoc + every locale override) into a single key:
//   cms_published_{siteId}
// The public /site route reads the snapshot when one exists, so admin
// edits stay invisible to visitors until the user clicks Publish again.
// Sites that have never been published serve their draft as before
// (caller falls back to getEffective).

async function getPublishedSnapshot(siteId) {
    assertSiteId(siteId);
    const v = await configStore.getConfig(publishedKey(siteId));
    return isPlainObject(v) ? v : null;
}

async function publishSite(siteId) {
    assertSiteId(siteId);
    const site = await getProject(siteId);
    if (!site) throw new Error('Project not found');

    const pages = {};
    for (const entry of site.pages) {
        const page = await getPage(siteId, entry.id);
        if (page) pages[entry.id] = page;
    }

    const allLocaleKeys = await getAll(
        `SELECT key FROM config WHERE key LIKE $1`,
        [`${projectKey(siteId)}%${KEY_LOCALE_INFIX}%`]
    );
    const siteLocaleOverrides = {};
    const pageLocaleOverrides = {};
    for (const r of allLocaleKeys) {
        const tail = r.key.substring(projectKey(siteId).length);
        if (tail.startsWith(KEY_PAGE_INFIX)) {
            const inner = tail.substring(KEY_PAGE_INFIX.length);
            const splitAt = inner.indexOf(KEY_LOCALE_INFIX);
            if (splitAt < 0) continue;
            const pageId = inner.substring(0, splitAt);
            const locale = inner.substring(splitAt + KEY_LOCALE_INFIX.length);
            pageLocaleOverrides[pageId] = pageLocaleOverrides[pageId] || {};
            pageLocaleOverrides[pageId][locale] = await configStore.getConfig(r.key);
        } else if (tail.startsWith(KEY_LOCALE_INFIX)) {
            const locale = tail.substring(KEY_LOCALE_INFIX.length);
            siteLocaleOverrides[locale] = await configStore.getConfig(r.key);
        }
    }

    const snapshot = {
        version: PUBLISHED_VERSION,
        publishedAt: new Date().toISOString(),
        site,
        pages,
        siteLocaleOverrides,
        pageLocaleOverrides,
    };
    await configStore.setConfig(publishedKey(siteId), snapshot);
    // Short-lived diagnostic so we can confirm publish is capturing the
    // latest blocks (not a stale read). Drop once draft/published parity
    // is verified end-to-end.
    const blockCounts = Object.entries(pages).map(
        ([id, p]) => `${id}:${(p.blocks || []).length}`
    ).join(', ');
    console.log(`[CMS] publish siteId=${siteId} pages=${Object.keys(pages).length} blocks={${blockCounts}}`);
    return { publishedAt: snapshot.publishedAt };
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

    const snap = await getPublishedSnapshot(siteId);

    return {
        defaultLocale,
        site,
        pages,
        localeOverrides: { siteByLocale, pagesByLocale },
        publishedAt: snap?.publishedAt || null,
    };
}

// ── Export / Import ──────────────────────────────────────────────────
//
// Export bundles the entire SiteDoc + every PageDoc (with blocks) into a
// single JSON payload. Locale overrides and the published snapshot are
// intentionally NOT included — they're presentation state that should
// be recomputed on the destination environment, not migrated as-is.
//
// Import generates fresh IDs for the site, every page, and every block,
// so a re-import never collides with an existing site or any future
// site that happens to share an old id. Header / footer link references
// of `kind: 'page'` are remapped to the new page IDs so the imported
// nav still points at the new pages, not the originals.

const EXPORT_MARKER  = '_beeflow_export';
const EXPORT_VERSION = 1;

async function exportSite(siteId) {
    const site = await getProject(siteId);
    if (!site) throw new Error('Site not found');

    // Pull every PageDoc by id (the site.pages array is just the index;
    // the actual block content lives in cms_project_{site}_page_{id}).
    // We carry both the index metadata (slug/title/isHomepage/hideHeader…)
    // AND the full PageDoc (seo + blocks) for each page so an import can
    // restore the page exactly. The exported page item is the union of
    // both shapes — duplicate fields like slug/title resolve to the
    // index entry's values (authoritative source).
    const exportedPages = [];
    for (const entry of site.pages || []) {
        const doc = await getPage(siteId, entry.id) || {};
        exportedPages.push({
            // Index-side fields:
            slug: entry.slug,
            title: entry.title,
            isHomepage: !!entry.isHomepage,
            hideHeader: !!entry.hideHeader,
            hideFooter: !!entry.hideFooter,
            isNotFound: !!entry.isNotFound,
            // PageDoc-side fields:
            seo: doc.seo || { metaTitle: '', metaDescription: '', ogImage: '', noIndex: false },
            blocks: Array.isArray(doc.blocks) ? doc.blocks : [],
        });
    }

    return {
        [EXPORT_MARKER]: true,
        version: EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        site: {
            name: site.name,
            // Settings = site-level toggles other than nav chrome / design,
            // surfaced under a single key for import-side clarity. Today
            // there's only `homepageSlug` (derived from the homepage page
            // index entry) — future flags can land here without breaking
            // import-compatibility.
            settings: {
                homepageSlug: (site.pages || []).find(p => p.isHomepage)?.slug || null,
            },
            design: site.design || {},
            chrome: {
                header: site.header || {},
                footer: site.footer || {},
                cookieBanner: site.cookieBanner || {},
            },
            pages: exportedPages,
        },
    };
}

// Structural caps on import payloads. Imports come from admin users, so
// the threat model isn't anonymous DoS — it's a compromised admin
// session pushing a deeply-nested or oversized payload that bloats the
// config table and the in-memory parse. Numbers are sized for "normal"
// marketing sites (a few dozen pages, a dozen blocks each); legitimate
// imports will never come close.
const IMPORT_MAX_PAGES        = 200;
const IMPORT_MAX_BLOCKS_PAGE  = 100;
const IMPORT_MAX_FIELD_BYTES  = 256 * 1024;  // 256 KB per stringified content/style blob

function approxByteSize(value) {
    try { return Buffer.byteLength(JSON.stringify(value) || '', 'utf8'); }
    catch (_) { return Infinity; }
}

async function importSite(exportData) {
    if (!isPlainObject(exportData)) throw new Error('Invalid export payload');
    if (exportData[EXPORT_MARKER] !== true) throw new Error('Not a Bee Flow site export');
    if (exportData.version !== EXPORT_VERSION) {
        throw new Error(`Unsupported export version: ${exportData.version}`);
    }
    const incoming = exportData.site;
    if (!isPlainObject(incoming)) throw new Error('Export payload is missing the `site` object');

    // Cap pages and blocks before the loop below allocates them. Bytes-
    // per-field is checked inside the block loop so we can reject early
    // with a clear message instead of silently truncating.
    const pagesPreview = Array.isArray(incoming.pages) ? incoming.pages : [];
    if (pagesPreview.length > IMPORT_MAX_PAGES) {
        throw new Error(`Too many pages in import (max ${IMPORT_MAX_PAGES})`);
    }
    for (const p of pagesPreview) {
        if (!isPlainObject(p)) continue;
        const blocks = Array.isArray(p.blocks) ? p.blocks : [];
        if (blocks.length > IMPORT_MAX_BLOCKS_PAGE) {
            throw new Error(`Too many blocks on one page (max ${IMPORT_MAX_BLOCKS_PAGE})`);
        }
    }

    // Fresh site id + a name suffix so the user can tell originals apart
    // from imports at a glance. The suffix is plain; users rename via
    // the Site Switcher right after import if they want.
    const newSiteId = newId('pj');
    const now = new Date().toISOString();
    const siteName = (typeof incoming.name === 'string' && incoming.name.trim())
        ? `${incoming.name} (imported)`
        : 'Imported site';

    // Remap page ids: keep slug/title/order, generate fresh page ids and
    // fresh block ids. Track old→new id mapping so we can rewrite any
    // page-kind link references that pointed at the OLD page ids inside
    // header/footer chrome and inside block content of every page.
    const pagesIn = Array.isArray(incoming.pages) ? incoming.pages : [];
    const pagesOut = [];
    const idMap = new Map();   // oldId → newId (oldId is the slug since exports don't carry the original page id)
    // We use slug as the lookup key because exports don't carry the
    // ORIGINAL page id — by design, they shouldn't leak runtime ids.
    // Internal link references (`{kind:'page', pageId: <oldId>}`) point
    // at the OLD ids; we don't have those, so we *also* support
    // `{kind:'page', slug: <slug>}` style remapping during import. If
    // the chrome / block content uses oldId only and the original
    // pageId isn't reachable, links resolve to '#' at render time
    // (graceful degradation; we never crash). To preserve perfect
    // fidelity, callers who depend on chrome page links should ensure
    // the export tool carries page ids alongside link references — for
    // now we remap by slug when available, leave old ids otherwise so
    // the renderer's fallback (`broken: true`) surfaces them clearly.
    const slugToNewId = new Map();

    for (const incomingPage of pagesIn) {
        if (!isPlainObject(incomingPage)) continue;
        const pageId = newId('pg');
        const slug = normalizeSlug(incomingPage.slug || incomingPage.title || 'page') || 'page';
        const finalSlug = ensureUniqueSlug(slug, pagesOut, null);
        pagesOut.push({
            id: pageId,
            slug: finalSlug,
            title: typeof incomingPage.title === 'string' ? incomingPage.title : finalSlug,
            isHomepage: !!incomingPage.isHomepage,
            hideHeader: !!incomingPage.hideHeader,
            hideFooter: !!incomingPage.hideFooter,
            isNotFound: !!incomingPage.isNotFound,
        });
        slugToNewId.set(finalSlug, pageId);
        // Stash the original slug too, so chrome links written with the
        // original slug still remap even if the import normalised it.
        if (incomingPage.slug && incomingPage.slug !== finalSlug) {
            slugToNewId.set(String(incomingPage.slug), pageId);
        }
        idMap.set(finalSlug, pageId);
    }

    // Walk a node tree and replace any `{kind:'page', pageId:'<old>'}`
    // references with the new id where we can resolve the target by
    // slug. This is a best-effort remap — if the old export carried no
    // slug hint and the old id is unknown, the link is left untouched
    // and the renderer will display it as broken until the user fixes
    // it manually.
    const remapPageLinks = (node) => {
        if (Array.isArray(node)) return node.map(remapPageLinks);
        if (!isPlainObject(node)) return node;
        if (node.kind === 'page') {
            // Prefer a slug hint if the export carried one alongside the
            // pageId. Fall through to no-op if neither matches.
            const slug = typeof node.slug === 'string' ? node.slug : null;
            if (slug && slugToNewId.has(slug)) {
                return { ...node, pageId: slugToNewId.get(slug) };
            }
            return { ...node };
        }
        const out = {};
        for (const [k, v] of Object.entries(node)) out[k] = remapPageLinks(v);
        return out;
    };

    // Build the new SiteDoc.
    const incomingChrome = isPlainObject(incoming.chrome) ? incoming.chrome : {};
    const homepageEntry = pagesOut.find(p => p.isHomepage) || pagesOut[0] || null;
    const newSite = {
        version: SITE_VERSION,
        id: newSiteId,
        name: siteName,
        homepageId: homepageEntry?.id || null,
        pages: pagesOut.map(p => ({
            ...p,
            isHomepage: !!(homepageEntry && p.id === homepageEntry.id),
        })),
        header: remapPageLinks(isPlainObject(incomingChrome.header) ? incomingChrome.header : clone(SITE_DEFAULTS.header)),
        footer: remapPageLinks(isPlainObject(incomingChrome.footer) ? incomingChrome.footer : clone(SITE_DEFAULTS.footer)),
        // No internal page-links inside the banner, so no remapPageLinks.
        cookieBanner: clone(isPlainObject(incomingChrome.cookieBanner) ? incomingChrome.cookieBanner : SITE_DEFAULTS.cookieBanner),
        design: sanitizeDesign(incoming.design),
    };
    await configStore.setConfig(projectKey(newSiteId), newSite);

    // Write each PageDoc with a fresh page id and fresh block ids,
    // remapping any internal page links inside block content too.
    for (let i = 0; i < pagesIn.length; i++) {
        const incomingPage = pagesIn[i];
        const indexEntry = pagesOut[i];
        if (!incomingPage || !indexEntry) continue;
        const blocks = Array.isArray(incomingPage.blocks) ? incomingPage.blocks : [];
        const pageDoc = {
            id: indexEntry.id,
            slug: indexEntry.slug,
            title: indexEntry.title,
            seo: isPlainObject(incomingPage.seo) ? incomingPage.seo : {
                metaTitle: '', metaDescription: '', ogImage: '', noIndex: false,
            },
            blocks: blocks.map(b => {
                if (!isPlainObject(b)) return null;
                const content = isPlainObject(b.content) ? remapPageLinks(b.content) : {};
                const style   = isPlainObject(b.style)   ? b.style   : {};
                // Reject pathologically large blobs. A legit block is a
                // few KB; 256 KB is already 10× the largest real-world
                // sample we've seen, so this only catches abuse.
                if (approxByteSize(content) > IMPORT_MAX_FIELD_BYTES
                    || approxByteSize(style) > IMPORT_MAX_FIELD_BYTES) {
                    throw new Error('Block content exceeds size limit');
                }
                return {
                    id: newId('blk'),
                    type: b.type,
                    enabled: b.enabled !== false,
                    content,
                    style,
                };
            }).filter(Boolean),
        };
        await setPage(newSiteId, pageDoc);
    }

    // Register the new project in the index so it shows up in the
    // listProjects() call the panel uses to refresh its switcher list.
    const index = await getProjectsIndex();
    index.projects.push({
        id: newSiteId,
        name: siteName,
        createdAt: now,
        updatedAt: now,
    });
    await setProjectsIndex(index);

    return { siteId: newSiteId, name: siteName };
}

// ── Page templates (global, not site-scoped) ─────────────────────────
//
// Templates are reusable page block-arrays a user can apply when creating
// a new page. Stored as one flat array under KEY_TEMPLATES. Each entry:
//   { id, name, description, createdAt, blocks: [...] }
// where `blocks` is a deep-cloned snapshot of a page's blocks taken at
// save time. IDs inside blocks are NOT regenerated at save — they are
// regenerated at APPLY time, so the saved entry is portable across sites
// and stable to delete-without-affecting copies.

async function getTemplates() {
    const raw = await configStore.getConfig(KEY_TEMPLATES);
    if (!Array.isArray(raw)) return [];
    return raw;
}

async function setTemplates(list) {
    const sanitized = Array.isArray(list) ? list : [];
    await configStore.setConfig(KEY_TEMPLATES, sanitized);
}

async function saveTemplate({ name, description, blocks } = {}) {
    const trimmedName = String(name || '').trim();
    if (!trimmedName) throw new Error('Template name is required');
    if (!Array.isArray(blocks)) throw new Error('Template blocks must be an array');
    const list = await getTemplates();
    const entry = {
        id: newId('tpl'),
        name: trimmedName.slice(0, 200),
        description: String(description || '').slice(0, 500),
        createdAt: new Date().toISOString(),
        blocks: clone(blocks),
    };
    list.push(entry);
    await setTemplates(list);
    return entry;
}

async function deleteTemplate(id) {
    if (!id) throw new Error('Template id is required');
    const list = await getTemplates();
    const next = list.filter(t => t.id !== id);
    await setTemplates(next);
}

// Returns a deep copy of the template's blocks with FRESH block IDs so
// it's safe to drop directly into a new page. Throws when the template
// doesn't exist so callers can surface a clear error to the user.
async function applyTemplate(id) {
    if (!id) throw new Error('Template id is required');
    const list = await getTemplates();
    const tpl = list.find(t => t.id === id);
    if (!tpl) throw new Error('Template not found');
    const blocks = Array.isArray(tpl.blocks) ? tpl.blocks : [];
    return blocks.map(b => ({ ...clone(b), id: newId('blk') }));
}

module.exports = {
    // locale settings
    getDefaultLocale, setDefaultLocale,
    // projects
    listProjects, createProject, getProject, setProject, deleteProject, renameProject, duplicateProject,
    // site-locale overrides
    getSiteLocaleOverride, setSiteLocaleOverride, deleteSiteLocaleOverride,
    // pages
    getPage, setPage, deletePage,
    getPageLocaleOverride, setPageLocaleOverride, deletePageLocaleOverride,
    createPage, removePage, updatePageMeta, setHomepage, reorderPages,
    // page templates (global)
    getTemplates, saveTemplate, deleteTemplate, applyTemplate,
    // preview / graph
    getEffective, getEffectivePublished, getSiteGraph,
    // publishing
    publishSite, getPublishedSnapshot,
    // admin
    getAdminPayload,
    // import / export
    exportSite, importSite,
    // helpers / constants for tests
    makeBlock, resolveLink, mergeLocaleContent,
    BLOCK_TYPE_IDS, RESERVED_SLUGS,
};
