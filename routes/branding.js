/**
 * Branding Routes — theming + wallpaper management.
 *
 *   GET    /api/branding/public               — unauthenticated, safe subset for login/marketing
 *   GET    /api/branding/effective            — auth, resolved theme for the current user
 *   GET    /api/branding/admin                — admin, raw org default
 *   PUT    /api/branding/admin                — admin, update org default
 *   PUT    /api/branding/user                 — auth, update or clear (body=null) user override
 *
 *   POST   /api/branding/wallpaper            — admin, multipart upload (field name: "wallpaper")
 *   DELETE /api/branding/wallpaper            — admin, clear wallpaper
 *   GET    /api/branding/wallpaper/:filename  — public static serve (Cache-Control 1d)
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAuth: _requireAuth, requireAdmin: _requireAdmin } = require('../auth/permissions');
const brandingStore = require('../stores/brandingStore');

// Async middleware in Node 22 — if `requireAdmin`'s internal hasPermission()
// rejects, the unhandled-rejection default exits the process, which produces
// ERR_EMPTY_RESPONSE on the open socket. Wrap auth middleware so any rejection
// becomes a 500 instead of taking the server down.
function safe(middleware) {
    return (req, res, next) => {
        Promise.resolve()
            .then(() => middleware(req, res, next))
            .catch(err => {
                console.error('[Branding API] auth middleware threw:', err);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Auth check failed: ' + (err.message || String(err)) });
                }
            });
    };
}
const requireAuth = safe(_requireAuth);
const requireAdmin = safe(_requireAdmin);

// Also wrap route handlers so any async throw is caught and reported.
function asyncRoute(fn) {
    return (req, res, next) => {
        Promise.resolve()
            .then(() => fn(req, res, next))
            .catch(err => {
                console.error('[Branding API] handler threw:', err);
                if (!res.headersSent) {
                    res.status(500).json({ error: err.message || 'Internal Server Error' });
                }
            });
    };
}

// ── Storage ─────────────────────────────────────────────────────

const uploadDir = path.join(__dirname, '..', 'data', 'wallpapers');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, 'wallpaper-' + uniqueSuffix + path.extname(file.originalname));
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files are allowed.'));
    },
});

// ── Public endpoints (no auth) ──────────────────────────────────

router.get('/public', async (req, res) => {
    try {
        const data = await brandingStore.getPublic();
        res.set('Cache-Control', 'public, max-age=60');
        res.json(data);
    } catch (e) {
        console.error('[Branding API] public', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Static serve for wallpapers — public so the login page can show the image.
router.get('/wallpaper/:filename', (req, res) => {
    const safe = path.basename(req.params.filename || '');
    if (!safe || safe.includes('..')) return res.status(400).end();
    const full = path.join(uploadDir, safe);
    if (!fs.existsSync(full)) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(full);
});

// ── Authenticated endpoints ─────────────────────────────────────

router.get('/effective', requireAuth, async (req, res) => {
    try {
        const userId = req.session?.user?.id || null;
        const data = await brandingStore.getEffective(userId);
        res.json(data);
    } catch (e) {
        console.error('[Branding API] effective', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.put('/user', requireAuth, async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const orgDefault = await brandingStore.getOrgDefault();
        if (!orgDefault.allowUserOverride) {
            return res.status(403).json({ error: 'User theme override is disabled by the administrator' });
        }

        const body = req.body;
        const next = await brandingStore.setUserOverride(userId, body === null ? null : body);
        const data = await brandingStore.getEffective(userId);
        res.json({ override: next, effective: data });
    } catch (e) {
        console.error('[Branding API] put user', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ── Admin endpoints ─────────────────────────────────────────────

/**
 * Diagnostic dump — shows the raw DB state alongside the resolved values so
 * we can see whether saves are actually persisting. Admin-only.
 */
router.get('/debug', requireAdmin, async (req, res) => {
    try {
        const configStore = require('../stores/configStore');
        const userId = req.session?.user?.id || null;
        const rawDefault = await configStore.getConfig('branding.default');
        const rawWallpaper = await configStore.getConfig('branding.wallpaperFilename');
        const rawUserOverride = userId ? await configStore.getConfig(`branding.user.${userId}`) : null;
        const orgDefault = await brandingStore.getOrgDefault();
        const effective = await brandingStore.getEffective(userId);
        res.json({
            session: {
                userId,
                hasOrganization: !!req.session?.user?.organizationId,
                organizationId: req.session?.user?.organizationId || null,
                role: req.session?.user?.role || null,
            },
            raw: {
                'branding.default': rawDefault,
                'branding.wallpaperFilename': rawWallpaper,
                [`branding.user.${userId}`]: rawUserOverride,
            },
            resolved: {
                orgDefault,
                effective,
            },
        });
    } catch (e) {
        console.error('[Branding API] debug', e);
        res.status(500).json({ error: e.message || 'debug failed' });
    }
});

router.get('/admin', requireAdmin, async (req, res) => {
    try {
        const data = await brandingStore.getOrgDefault();
        const wallpaperFilename = await brandingStore.getWallpaperFilename();
        res.json({
            ...data,
            wallpaperUrl: wallpaperFilename ? `/api/branding/wallpaper/${wallpaperFilename}` : null,
        });
    } catch (e) {
        console.error('[Branding API] get admin', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.put('/admin', requireAdmin, async (req, res) => {
    try {
        const next = await brandingStore.setOrgDefault(req.body || {});
        const wallpaperFilename = await brandingStore.getWallpaperFilename();
        res.json({
            ...next,
            wallpaperUrl: wallpaperFilename ? `/api/branding/wallpaper/${wallpaperFilename}` : null,
        });
    } catch (e) {
        console.error('[Branding API] put admin', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/wallpaper', requireAdmin, upload.single('wallpaper'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        // Delete the previous wallpaper file (single-wallpaper-per-org).
        const previous = await brandingStore.getWallpaperFilename();
        if (previous && previous !== req.file.filename) {
            const prevPath = path.join(uploadDir, previous);
            fs.promises.unlink(prevPath).catch(() => { /* missing is fine */ });
        }

        await brandingStore.setWallpaperFilename(req.file.filename);
        res.json({
            filename: req.file.filename,
            url: `/api/branding/wallpaper/${req.file.filename}`,
        });
    } catch (e) {
        console.error('[Branding API] wallpaper upload', e);
        res.status(500).json({ error: 'Upload failed' });
    }
});

router.delete('/wallpaper', requireAdmin, async (req, res) => {
    try {
        const previous = await brandingStore.getWallpaperFilename();
        if (previous) {
            const prevPath = path.join(uploadDir, previous);
            fs.promises.unlink(prevPath).catch(() => { /* missing is fine */ });
        }
        await brandingStore.setWallpaperFilename(null);
        res.json({ success: true });
    } catch (e) {
        console.error('[Branding API] wallpaper delete', e);
        res.status(500).json({ error: 'Delete failed' });
    }
});

module.exports = router;
