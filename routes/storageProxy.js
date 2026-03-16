/**
 * Storage Proxy — Auth-protected file streaming from RustFS
 * 
 * GET /api/storage/file/:key
 * - Requires authenticated session
 * - Validates user owns the file (key starts with users/{userId}/ or shared/)
 * - Streams file directly from S3 with correct Content-Type
 */

const express = require('express');
const router = express.Router();
const storageStore = require('../stores/storageStore');

// GET /api/storage/file/:key — stream a file from RustFS
router.get('/file/:key', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        // The key is everything after /file/ in the original URL (supports slashes)
        const prefix = '/file/';
        const idx = req.originalUrl.indexOf(prefix);
        const key = idx >= 0 ? decodeURIComponent(req.originalUrl.substring(idx + prefix.length)) : req.params.key;
        if (!key) {
            return res.status(400).json({ error: 'File key required' });
        }

        // Security: user can only access their own files or shared assets
        const isOwnFile = key.startsWith(`users/${userId}/`);
        const isSharedFile = key.startsWith('shared/');
        if (!isOwnFile && !isSharedFile) {
            return res.status(403).json({ error: 'Access denied' });
        }

        if (!storageStore.isAvailable()) {
            return res.status(503).json({ error: 'Storage not available' });
        }

        const { stream, contentType, contentLength } = await storageStore.streamFile(key);

        res.setHeader('Content-Type', contentType);
        if (contentLength) res.setHeader('Content-Length', contentLength);
        // Cache for 1 day — files are immutable (unique filenames)
        res.setHeader('Cache-Control', 'private, max-age=86400');

        stream.pipe(res);
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            return res.status(404).json({ error: 'File not found' });
        }
        console.error('[StorageProxy] Error streaming file:', err.message);
        res.status(500).json({ error: 'Failed to retrieve file' });
    }
});

module.exports = router;
