/**
 * Branding Store — thin façade over configStore for the theming system.
 *
 *   Keys:
 *     branding.default              — instance-wide admin defaults (JSON)
 *     branding.wallpaperFilename    — filename of currently-active wallpaper (string|null)
 *     branding.user.<userId>        — per-user override (JSON|null)
 *
 *   All keys are global to the install (no org partitioning) so a super-user
 *   without an organizationId can still save and load defaults. The auth
 *   layer (requireAdmin in routes/branding.js) gates writes on the
 *   manage_users / all permission, not on org membership — see
 *   server/auth/permissions.js line ~399.
 *
 *   All theme state lives in the existing config table — no users-table
 *   schema migration required. This mirrors how per-user integration tokens
 *   are stored (see iconStore/configStore usage in userStore.deleteUser).
 */

const configStore = require('./configStore');

const PRESETS = new Set(['light', 'dark', 'glass', 'glass-dark', 'paper', 'obsidian', 'sepia', 'high-contrast', 'custom']);
const FONTS = new Set(['system', 'inter', 'plex', 'geist']);
const WALLPAPER_PRESETS = new Set(['mono', 'slate', 'sand', 'frost', 'sage', 'ash']);
const TINTS = new Set(['warm', 'neutral', 'cool']);
const LENS_MODES = new Set(['off', 'on']);
const ANIM_LEVELS = new Set(['off', 'subtle', 'lively']);
const GRAIN_LEVELS = new Set(['off', 'subtle', 'frosted']);
const BORDER_STYLES = new Set(['none', 'subtle', 'bright', 'iridescent']);
const HEX = /^#[0-9a-fA-F]{6}$/;

const DEFAULTS = Object.freeze({
    preset: 'light',
    accent: '#9ca3af',
    radiusScale: 1,
    font: 'system',
    wallpaperOverlay: 0.1,
    glassIntensity: 1,           // 0=subtle, 1=medium, 2=strong; admin-only
    // Glass v2 configuration — admin-only
    wallpaperPreset: 'mono',     // mono | slate | sand | frost | sage | ash
    glassTint: 'neutral',        // warm | neutral | cool
    glassLens: 'on',             // off | on  (SVG lensing)
    glassAnimation: 'off',       // off | subtle | lively
    glassGrain: 'subtle',        // off | subtle | frosted
    glassBorder: 'subtle',       // none | subtle | bright | iridescent
    // Per-tier overrides (null = use intensity-derived defaults)
    glassTierSubtle: null,       // { blur, saturate, brightness } | null
    glassTierDefault: null,
    glassTierOpaque: null,
    allowUserOverride: true,
});

function clamp(n, lo, hi) {
    const v = Number(n);
    if (!Number.isFinite(v)) return lo;
    return Math.min(hi, Math.max(lo, v));
}

/**
 * Sanitise a theme payload coming from an admin or user. Unknown fields are
 * dropped; invalid values fall back to the defaults. Returns a fresh object
 * with ONLY the keys that were valid in the input — useful for PATCH-style
 * merges in callers.
 */
function sanitize(input, { allowAllKnobs = true } = {}) {
    const out = {};
    if (!input || typeof input !== 'object') return out;

    if (typeof input.preset === 'string' && PRESETS.has(input.preset)) {
        out.preset = input.preset;
    }
    if (typeof input.accent === 'string' && HEX.test(input.accent)) {
        out.accent = input.accent.toLowerCase();
    }
    if (allowAllKnobs && input.radiusScale !== undefined) {
        out.radiusScale = clamp(input.radiusScale, 0.5, 1.5);
    }
    if (allowAllKnobs && typeof input.font === 'string' && FONTS.has(input.font)) {
        out.font = input.font;
    }
    if (allowAllKnobs && input.wallpaperOverlay !== undefined) {
        out.wallpaperOverlay = clamp(input.wallpaperOverlay, 0, 1);
    }
    if (allowAllKnobs && input.glassIntensity !== undefined) {
        // Clamp + snap to 0/1/2 — only three discrete intensity steps exist.
        out.glassIntensity = Math.round(clamp(input.glassIntensity, 0, 2));
    }
    // Wallpaper preset — allowed for both admin and user. It's a stylistic
    // choice ("mood" in the user UI), not a brand setting, so per-user
    // overrides are welcome. All other glass-v2 enums below remain admin-only.
    if (typeof input.wallpaperPreset === 'string' && WALLPAPER_PRESETS.has(input.wallpaperPreset)) {
        out.wallpaperPreset = input.wallpaperPreset;
    }
    // Other glass v2 enum fields — admin-only (allowAllKnobs gates them).
    if (allowAllKnobs && typeof input.glassTint === 'string' && TINTS.has(input.glassTint)) {
        out.glassTint = input.glassTint;
    }
    if (allowAllKnobs && typeof input.glassLens === 'string' && LENS_MODES.has(input.glassLens)) {
        out.glassLens = input.glassLens;
    }
    if (allowAllKnobs && typeof input.glassAnimation === 'string' && ANIM_LEVELS.has(input.glassAnimation)) {
        out.glassAnimation = input.glassAnimation;
    }
    if (allowAllKnobs && typeof input.glassGrain === 'string' && GRAIN_LEVELS.has(input.glassGrain)) {
        out.glassGrain = input.glassGrain;
    }
    if (allowAllKnobs && typeof input.glassBorder === 'string' && BORDER_STYLES.has(input.glassBorder)) {
        out.glassBorder = input.glassBorder;
    }
    // Per-tier overrides: { blur, saturate, brightness } or null to clear
    for (const tierKey of ['glassTierSubtle', 'glassTierDefault', 'glassTierOpaque']) {
        if (!allowAllKnobs || input[tierKey] === undefined) continue;
        if (input[tierKey] === null) { out[tierKey] = null; continue; }
        if (typeof input[tierKey] !== 'object') continue;
        const t = input[tierKey];
        out[tierKey] = {
            blur:       clamp(t.blur ?? 16, 0, 60),
            saturate:   clamp(t.saturate ?? 170, 100, 300),
            brightness: clamp(t.brightness ?? 1.05, 0.8, 1.3),
        };
    }
    if (typeof input.allowUserOverride === 'boolean') {
        out.allowUserOverride = input.allowUserOverride;
    }
    return out;
}

async function getOrgDefault() {
    const raw = await configStore.getConfig('branding.default');
    return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
}

async function setOrgDefault(patch) {
    const current = await getOrgDefault();
    const clean = sanitize(patch, { allowAllKnobs: true });
    const next = { ...current, ...clean };
    await configStore.setConfig('branding.default', next);
    return next;
}

async function getWallpaperFilename() {
    const v = await configStore.getConfig('branding.wallpaperFilename');
    return typeof v === 'string' && v ? v : null;
}

async function setWallpaperFilename(filename) {
    await configStore.setConfig('branding.wallpaperFilename', filename || '');
    return filename || null;
}

async function getUserOverride(userId) {
    if (!userId) return null;
    const raw = await configStore.getConfig(`branding.user.${userId}`);
    if (!raw || typeof raw !== 'object') return null;
    return raw;
}

async function setUserOverride(userId, patch) {
    if (!userId) return null;
    if (patch === null) {
        await configStore.deleteConfig(`branding.user.${userId}`);
        return null;
    }
    const clean = sanitize(patch, { allowAllKnobs: false });
    const existing = (await configStore.getConfig(`branding.user.${userId}`)) || {};
    if (Object.keys(clean).length === 0) {
        // Nothing valid in the patch — leave the prior override untouched.
        // (Use PUT body=null to actually clear.)
        return Object.keys(existing).length ? existing : null;
    }
    // Merge: partial PATCHes like `{wallpaperPreset: 'sand'}` must not blow
    // away the user's previously-saved `preset` / `accent`. The old replace
    // behaviour caused Mood picks to silently revert the theme to the org
    // default because `preset` disappeared from the override record.
    const merged = { ...existing, ...clean };
    await configStore.setConfig(`branding.user.${userId}`, merged);
    return merged;
}

/**
 * Compose the effective theme for a given user. Resolution: user override
 * (if admin allows) → org default → hardcoded defaults. Wallpaper URL is
 * built from the stored filename + the API_BASE-relative serve path.
 */
async function getEffective(userId) {
    const orgDefault = await getOrgDefault();
    let theme = { ...orgDefault };
    let source = 'default';

    const userOverride = userId ? await getUserOverride(userId) : null;
    if (userOverride && orgDefault.allowUserOverride) {
        theme = { ...theme, ...userOverride };
        source = 'user';
    } else if (await configStore.getConfig('branding.default')) {
        source = 'admin';
    }

    const wallpaperFilename = await getWallpaperFilename();
    return {
        preset: theme.preset,
        accent: theme.accent,
        radiusScale: theme.radiusScale,
        font: theme.font,
        wallpaperOverlay: theme.wallpaperOverlay,
        glassIntensity: theme.glassIntensity,
        wallpaperPreset: theme.wallpaperPreset,
        glassTint: theme.glassTint,
        glassLens: theme.glassLens,
        glassAnimation: theme.glassAnimation,
        glassGrain: theme.glassGrain,
        glassBorder: theme.glassBorder,
        glassTierSubtle: theme.glassTierSubtle,
        glassTierDefault: theme.glassTierDefault,
        glassTierOpaque: theme.glassTierOpaque,
        wallpaperUrl: wallpaperFilename ? `/api/branding/wallpaper/${wallpaperFilename}` : null,
        allowUserOverride: orgDefault.allowUserOverride,
        source,
    };
}

/**
 * Public theme — for unauthenticated pages (login, marketing). Returns the
 * full visual set (no user override, no admin-only toggles like
 * allowUserOverride). Includes radiusScale, glassIntensity, wallpaperOverlay
 * so the 401 fallback in the frontend doesn't lose half the styling.
 */
async function getPublic() {
    const orgDefault = await getOrgDefault();
    const wallpaperFilename = await getWallpaperFilename();
    return {
        preset: orgDefault.preset,
        accent: orgDefault.accent,
        font: orgDefault.font,
        radiusScale: orgDefault.radiusScale,
        glassIntensity: orgDefault.glassIntensity,
        wallpaperOverlay: orgDefault.wallpaperOverlay,
        wallpaperPreset: orgDefault.wallpaperPreset,
        glassTint: orgDefault.glassTint,
        glassLens: orgDefault.glassLens,
        glassAnimation: orgDefault.glassAnimation,
        glassGrain: orgDefault.glassGrain,
        glassBorder: orgDefault.glassBorder,
        wallpaperUrl: wallpaperFilename ? `/api/branding/wallpaper/${wallpaperFilename}` : null,
    };
}

module.exports = {
    DEFAULTS,
    sanitize,
    getOrgDefault,
    setOrgDefault,
    getUserOverride,
    setUserOverride,
    getWallpaperFilename,
    setWallpaperFilename,
    getEffective,
    getPublic,
};
