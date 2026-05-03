/**
 * Icon Routes — Appearance / icon-pack management.
 *
 *   GET    /api/icons                       — list user's packs + catalog + active id
 *   GET    /api/icons/catalog               — icon categories shared with frontend
 *   POST   /api/icons                       — create pack
 *   PUT    /api/icons/:id                   — update pack (name / icons)
 *   PATCH  /api/icons/:id/icons/:key        — set or clear a single icon override
 *   DELETE /api/icons/:id                   — delete pack
 *   POST   /api/icons/:id/activate          — set active pack for this user (id="default" clears)
 *
 *   POST   /api/icons/upload                — direct file upload (multipart)
 *   POST   /api/icons/generate              — AI-generate a single icon (returns saved url)
 *   POST   /api/icons/:id/bulk-generate     — AI-generate every missing icon in a pack
 *
 *   GET    /api/icons/:id/export            — download pack JSON
 *   POST   /api/icons/import                — import pack JSON (new pack)
 *
 *   GET    /api/icons/data/:filename        — static serve generated/uploaded icon
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { requireAuth } = require('../auth/permissions');
const iconStore = require('../stores/iconStore');
const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');
const { googleAdapter } = require('../core/providers');
const { ICON_CATEGORIES, ALL_ICON_KEYS } = require('../data/iconCatalog');

// ── Storage ─────────────────────────────────────────────────────

const uploadDir = path.join(__dirname, '..', 'data', 'icons');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files are allowed.'));
    },
});

router.use(requireAuth);

// ── Catalog (no DB hit, safe to cache aggressively) ──────────────

router.get('/catalog', (req, res) => {
    res.set('Cache-Control', 'private, max-age=3600');
    res.json({ categories: ICON_CATEGORIES, totalKeys: ALL_ICON_KEYS.length });
});

// ── List + active pack ──────────────────────────────────────────

router.get('/', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const packs = await iconStore.getIconPacks(userId);
        const user = await userStore.getUser(userId);
        res.json({
            packs,
            activeIconPackId: user ? user.activeIconPackId : null,
            categories: ICON_CATEGORIES,
            totalKeys: ALL_ICON_KEYS.length,
        });
    } catch (e) {
        console.error('[Icons API]', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ── Pack CRUD ───────────────────────────────────────────────────

router.post('/', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { name, icons } = req.body;
        if (!name) return res.status(400).json({ error: 'Name is required' });
        const newPack = await iconStore.createIconPack(userId, name, icons || {});
        res.status(201).json(newPack);
    } catch (e) {
        console.error('[Icons API]', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const ok = await iconStore.updateIconPack(req.params.id, userId, req.body);
        if (ok) res.json({ success: true });
        else res.status(404).json({ error: 'Pack not found or access denied' });
    } catch (e) {
        console.error('[Icons API]', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// PATCH /api/icons/:id/icons/:key — single-icon edit (no full-pack PUT race)
router.patch('/:id/icons/:key', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { type, value } = req.body || {};
        const data = (type && value !== undefined) ? { type, value } : null;
        const next = await iconStore.setIcon(req.params.id, userId, req.params.key, data);
        if (!next) return res.status(404).json({ error: 'Pack not found or access denied' });
        res.json({ success: true, icons: next });
    } catch (e) {
        console.error('[Icons API]', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const ok = await iconStore.deleteIconPack(req.params.id, userId);
        if (!ok) return res.status(404).json({ error: 'Pack not found or access denied' });
        const user = await userStore.getUser(userId);
        if (user && user.activeIconPackId === req.params.id) {
            await userStore.updateUser(userId, { activeIconPackId: null });
        }
        res.json({ success: true });
    } catch (e) {
        console.error('[Icons API]', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:id/activate', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const packId = req.params.id;

        if (packId === 'default' || packId === 'null') {
            await userStore.updateUser(userId, { activeIconPackId: null });
            return res.json({ success: true, activeIconPackId: null });
        }

        const pack = await iconStore.getIconPack(packId);
        if (!pack || pack.user_id !== userId) {
            return res.status(404).json({ error: 'Pack not found or access denied' });
        }
        await userStore.updateUser(userId, { activeIconPackId: packId });
        res.json({ success: true, activeIconPackId: packId });
    } catch (e) {
        console.error('[Icons API]', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ── Direct file upload ──────────────────────────────────────────

router.post('/upload', upload.single('icon'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        res.json({ url: `/api/icons/data/${req.file.filename}` });
    } catch (e) {
        console.error('[Icons API upload]', e);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// ── AI generation (Nano Banana) ─────────────────────────────────

/**
 * Build the prompt sent to Nano Banana. We always layer in our base style
 * so a customised pack stays visually coherent; the user prompt is appended.
 */
function buildIconPrompt(userPrompt, opts = {}) {
    const style = opts.style?.trim() || 'flat 2D vector icon, single subject centred, solid background, no text, no watermark, app-icon style';
    const subject = (userPrompt || '').trim();
    if (!subject) return style;
    return `${subject}. Style: ${style}.`;
}

async function saveBase64Png(base64, mimeType) {
    const ext = (mimeType || '').includes('jpeg') ? 'jpg' : 'png';
    const filename = `icon_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const fullPath = path.join(uploadDir, filename);
    await fs.promises.writeFile(fullPath, Buffer.from(base64, 'base64'));
    return `/api/icons/data/${filename}`;
}

// POST /api/icons/generate — single-icon generation, returns the saved URL
router.post('/generate', async (req, res) => {
    try {
        const { prompt, style, aspectRatio, model } = req.body || {};
        if (!prompt || !prompt.trim()) {
            return res.status(400).json({ error: 'prompt is required' });
        }

        const apiKey = await configStore.getSecret('google_api_key');
        if (!apiKey) {
            return res.status(503).json({ error: 'Image generation unavailable — Google API key not configured.' });
        }

        const fullPrompt = buildIconPrompt(prompt, { style });
        const result = await googleAdapter.generateImage(apiKey, fullPrompt, {
            aspectRatio: aspectRatio || '1:1',
            model: model || 'gemini-3.1-flash-image-preview',
        });

        if (!result?.imageBase64) {
            return res.status(502).json({ error: 'Generation returned no image' });
        }

        const url = await saveBase64Png(result.imageBase64, result.mimeType);
        res.json({ url, prompt: fullPrompt });
    } catch (e) {
        console.error('[Icons API generate]', e);
        res.status(500).json({ error: e.message || 'Generation failed' });
    }
});

// POST /api/icons/:id/bulk-generate — generate every missing icon in a pack
//   body: { style?: string, model?: string, overwrite?: boolean, only?: string[] }
router.post('/:id/bulk-generate', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const pack = await iconStore.getIconPack(req.params.id);
        if (!pack || pack.user_id !== userId) {
            return res.status(404).json({ error: 'Pack not found or access denied' });
        }

        const apiKey = await configStore.getSecret('google_api_key');
        if (!apiKey) {
            return res.status(503).json({ error: 'Image generation unavailable — Google API key not configured.' });
        }

        const { style, model, overwrite = false, only } = req.body || {};
        const targetKeys = (Array.isArray(only) && only.length ? only : ALL_ICON_KEYS)
            .filter(k => overwrite || !(pack.icons || {})[k]);

        if (targetKeys.length === 0) {
            return res.json({ success: true, generated: 0, total: 0, message: 'No missing icons to generate.' });
        }

        const next = { ...(pack.icons || {}) };
        let generated = 0;
        let errors = 0;

        // Cap concurrency — Gemini image gen is rate-limited.
        const CONCURRENCY = 3;
        for (let i = 0; i < targetKeys.length; i += CONCURRENCY) {
            const batch = targetKeys.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(batch.map(async (key) => {
                const subject = `An icon representing "${key}"`;
                const fullPrompt = buildIconPrompt(subject, { style });
                const r = await googleAdapter.generateImage(apiKey, fullPrompt, {
                    aspectRatio: '1:1',
                    model: model || 'gemini-3.1-flash-image-preview',
                });
                if (!r?.imageBase64) throw new Error('no image');
                const url = await saveBase64Png(r.imageBase64, r.mimeType);
                return { key, url };
            }));

            for (const r of results) {
                if (r.status === 'fulfilled') {
                    next[r.value.key] = { type: 'image', value: r.value.url };
                    generated++;
                } else {
                    errors++;
                    console.warn('[Icons bulk-generate] failed:', r.reason?.message);
                }
            }
        }

        await iconStore.updateIconPack(pack.id, userId, { icons: next });

        res.json({
            success: true,
            generated,
            total: targetKeys.length,
            errors,
            message: errors > 0
                ? `Generated ${generated} icons (${errors} failed).`
                : `Generated ${generated} icons.`,
        });
    } catch (e) {
        console.error('[Icons API bulk-generate]', e);
        res.status(500).json({ error: e.message || 'Bulk generation failed' });
    }
});

// ── Import / Export ─────────────────────────────────────────────

router.get('/:id/export', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const pack = await iconStore.getIconPack(req.params.id);
        if (!pack || pack.user_id !== userId) {
            return res.status(404).json({ error: 'Pack not found or access denied' });
        }
        const bundle = {
            kind: 'beeflow.iconpack',
            version: 1,
            name: pack.name,
            exportedAt: new Date().toISOString(),
            icons: pack.icons || {},
        };
        res.setHeader('Content-Disposition', `attachment; filename="beeflow-iconpack-${pack.name.replace(/[^a-z0-9]/gi, '_')}.json"`);
        res.setHeader('Content-Type', 'application/json');
        res.json(bundle);
    } catch (e) {
        console.error('[Icons API export]', e);
        res.status(500).json({ error: 'Export failed' });
    }
});

router.post('/import', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const data = req.body || {};
        if (!data.icons || typeof data.icons !== 'object') {
            return res.status(400).json({ error: 'Invalid bundle: missing icons object' });
        }
        const name = (data.name || 'Imported Pack').toString().slice(0, 100);
        const newPack = await iconStore.createIconPack(userId, name, data.icons);
        res.status(201).json(newPack);
    } catch (e) {
        console.error('[Icons API import]', e);
        res.status(500).json({ error: 'Import failed' });
    }
});

// ── Static serve ────────────────────────────────────────────────

router.use('/data', express.static(uploadDir));

module.exports = router;
