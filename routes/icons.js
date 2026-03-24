const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../auth/permissions');
const iconStore = require('../stores/iconStore');
const userStore = require('../stores/userStore');

// Set up multer for icon uploads
const uploadDir = path.join(__dirname, '..', 'data', 'icons');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed.'));
        }
    }
});

router.use(requireAuth);

// Get user's icon packs and active pack
router.get('/', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const packs = await iconStore.getIconPacks(userId);
        const user = await userStore.getUser(userId);
        res.json({ packs, activeIconPackId: user ? user.activeIconPackId : null });
    } catch (e) {
        console.error('[Icons API]', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Create an icon pack
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

// Update an icon pack
router.put('/:id', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const success = await iconStore.updateIconPack(req.params.id, userId, req.body);
        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Pack not found or access denied' });
        }
    } catch (e) {
        console.error('[Icons API]', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Delete an icon pack
router.delete('/:id', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const success = await iconStore.deleteIconPack(req.params.id, userId);
        if (success) {
            // Unset activeIconPackId if it was the deleted one
            const user = await userStore.getUser(userId);
            if (user && user.activeIconPackId === req.params.id) {
                await userStore.updateUser(userId, { activeIconPackId: null });
            }
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Pack not found or access denied' });
        }
    } catch (e) {
        console.error('[Icons API]', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Set active icon pack
router.post('/:id/activate', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const packId = req.params.id;
        const pack = await iconStore.getIconPack(packId);
        
        if (packId === 'default' || packId === null) {
            await userStore.updateUser(userId, { activeIconPackId: null });
            return res.json({ success: true, activeIconPackId: null });
        }

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

// Upload an icon image
router.post('/upload', upload.single('icon'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        const fileUrl = `/api/icons/data/${req.file.filename}`;
        res.json({ url: fileUrl });
    } catch (e) {
        console.error('[Icons API upload]', e);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Serve uploaded icons
router.use('/data', express.static(uploadDir));

module.exports = router;
