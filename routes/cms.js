/**
 * CMS Routes — public read endpoint + admin CRUD for the product website.
 *
 *   PUBLIC (no auth):
 *     GET  /api/cms/site?locale=xx     → { enabled, defaultLocale, content }
 *     GET  /api/cms/asset/:key(*)      → streams a CMS asset from RustFS
 *
 *   ADMIN (super-admin only):
 *     GET  /api/cms/admin              → full editor payload
 *     PUT  /api/cms/admin/enabled      → { enabled }
 *     PUT  /api/cms/admin/default-locale → { locale }
 *     PUT  /api/cms/admin/content/:locale → { content }
 *     POST /api/cms/admin/upload       → multipart file → { key, url }
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');

const cmsStore = require('../stores/cmsStore');
const languageStore = require('../stores/languageStore');
const storageStore = require('../stores/storageStore');
const { hasPermission } = require('../auth/permissions');
const { CMS_DEFAULTS } = require('../i18n/defaults/cmsDefaults');

// ── Middleware ───────────────────────────────────────────────────

async function requireAdmin(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
    if (req.session.isAdmin || req.session.user?.role === 'admin') return next();
    const userId = req.session.user?.id;
    if (userId && await hasPermission(userId, 'all', req.session)) return next();
    return res.status(403).json({ error: 'Admin access required' });
}

// Multer: in-memory, 5MB limit, image-only.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image uploads are allowed'));
    },
});

// ══════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ══════════════════════════════════════════════════════════════════

/**
 * GET /api/cms/site?locale=xx
 * Anonymous read endpoint — what the marketing site fetches on load.
 * When disabled, returns only { enabled: false } so no draft content leaks.
 */
router.get('/site', async (req, res) => {
    try {
        const enabled = await cmsStore.getEnabled();
        if (!enabled) {
            res.setHeader('Cache-Control', 'public, max-age=60');
            return res.json({ enabled: false });
        }

        const defaultLocale = await cmsStore.getDefaultLocale();
        const requestedLocale = (req.query.locale || defaultLocale).toString().toLowerCase().split('-')[0];
        const content = await cmsStore.getEffectiveContent(requestedLocale);

        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json({ enabled: true, defaultLocale, locale: requestedLocale, content });
    } catch (err) {
        console.error('[CMS] /site error:', err.message);
        res.status(500).json({ error: 'Failed to load CMS content' });
    }
});

/**
 * GET /api/cms/asset/*
 * Public passthrough for CMS images stored in RustFS under the cms/ prefix.
 * The key is everything after /asset/ — slashes preserved.
 */
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
// ADMIN ROUTES (super-admin only)
// ══════════════════════════════════════════════════════════════════

router.use('/admin', requireAdmin);

/**
 * GET /api/cms/admin — full editor payload.
 */
router.get('/admin', async (req, res) => {
    try {
        const [enabled, defaultLocale, locales, withContent] = await Promise.all([
            cmsStore.getEnabled(),
            cmsStore.getDefaultLocale(),
            languageStore.getAvailableLocales(),
            cmsStore.listLocalesWithContent(),
        ]);

        const contentByLocale = {};
        for (const code of new Set([defaultLocale, ...withContent, ...locales.map(l => l.code)])) {
            contentByLocale[code] = (await cmsStore.getContentRaw(code)) || {};
        }

        res.json({
            enabled,
            defaultLocale,
            locales,
            contentByLocale,
            defaults: CMS_DEFAULTS,
        });
    } catch (err) {
        console.error('[CMS] /admin GET error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.put('/admin/enabled', async (req, res) => {
    try {
        const { enabled } = req.body || {};
        if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
        await cmsStore.setEnabled(enabled);
        res.json({ success: true, enabled });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/admin/default-locale', async (req, res) => {
    try {
        const { locale } = req.body || {};
        if (!locale || typeof locale !== 'string') return res.status(400).json({ error: 'locale required' });
        await cmsStore.setDefaultLocale(locale.toLowerCase());
        res.json({ success: true, defaultLocale: locale.toLowerCase() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/admin/content/:locale', async (req, res) => {
    try {
        const { content } = req.body || {};
        if (!content || typeof content !== 'object') return res.status(400).json({ error: 'content object required' });
        await cmsStore.setContent(req.params.locale.toLowerCase(), content);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.delete('/admin/content/:locale', async (req, res) => {
    try {
        await cmsStore.deleteContent(req.params.locale.toLowerCase());
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/cms/admin/upload — image upload.
 * Returns the storage key and the public asset URL; the client stores
 * either in the content tree (the URL is what the public site renders).
 */
router.post('/admin/upload', upload.single('file'), async (req, res) => {
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

        // Public URL via the /api/cms/asset/* passthrough — stable, no expiry.
        const url = `/api/cms/asset/${key.split('/').map(encodeURIComponent).join('/')}`;
        res.json({ success: true, key, url });
    } catch (err) {
        console.error('[CMS] /upload error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
