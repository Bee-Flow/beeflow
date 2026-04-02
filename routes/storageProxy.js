/**
 * Storage Proxy — Auth-protected file streaming from RustFS
 * 
 * GET /api/storage/file/{key...}
 * - Requires authenticated session
 * - Validates user owns the file (key starts with users/{userId}/ or shared/)
 * - Streams file directly from S3 with correct Content-Type
 * 
 * GET /api/storage/tmp/:token
 * - No auth required — used by external services (e.g. Azure Whisper batch)
 * - Token is an HMAC-signed, time-limited URL with the key embedded
 * - Only works for keys under transcription-tmp/ prefix
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const storageStore = require('../stores/storageStore');

// ── Temporary public download (for Azure Whisper batch) ────────────────────

const HMAC_SECRET = process.env.SESSION_SECRET || 'beeflow-tmp-download';

/**
 * Generate a time-limited, HMAC-signed public URL for a RustFS key.
 * Allowed key prefixes:
 *   - `transcription-tmp/`            — audio files for Azure Whisper batch
 *   - `users/{userId}/attachments/`   — images uploaded for AI inference (agent)
 *   - `users/{userId}/uploads/`       — images uploaded for AI inference (direct chat)
 *
 * @param {string} key - RustFS object key
 * @param {number} ttlSeconds - URL lifetime (default: 900 = 15 min)
 * @returns {string} Full public URL
 */
function generateTempDownloadUrl(key, ttlSeconds = 900) {
    if (!key.startsWith('transcription-tmp/') && !key.match(/^users\/[^/]+\/(attachments|uploads)\//)) {
        throw new Error('Temp download URLs only allowed for transcription-tmp/ or users/{id}/attachments|uploads/ keys');
    }
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload = `${key}:${expires}`;
    const token = crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
    const encodedKey = encodeURIComponent(key);

    // Build full public URL from server config
    const protocol = process.env.SERVER_PROTOCOL || 'https';
    const host = process.env.SERVER_PUBLIC_HOST || 'localhost:3002';
    return `${protocol}://${host}/api/storage/tmp/${token}?key=${encodedKey}&expires=${expires}`;
}

// GET /api/storage/tmp/:token — unauthenticated, HMAC-verified temp download
router.get('/tmp/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const key = req.query.key;
        const expires = parseInt(req.query.expires, 10);

        console.log(`[StorageProxy] Temp download request: key=${key}, UA=${req.get('User-Agent')?.substring(0, 80)}, IP=${req.ip}`);

        if (!key || !expires || !token) {
            console.warn('[StorageProxy] Temp download: missing parameters');
            return res.status(400).json({ error: 'Missing parameters' });
        }

        // Only allow permitted prefixes
        if (!key.startsWith('transcription-tmp/') && !key.match(/^users\/[^/]+\/(attachments|uploads)\//)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        // Check expiry
        if (Math.floor(Date.now() / 1000) > expires) {
            console.warn(`[StorageProxy] Temp download: URL expired for key=${key}`);
            return res.status(410).json({ error: 'URL expired' });
        }

        // Verify HMAC token
        const payload = `${key}:${expires}`;
        const expected = crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
        if (!crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'))) {
            return res.status(403).json({ error: 'Invalid token' });
        }

        if (!storageStore.isAvailable()) {
            return res.status(503).json({ error: 'Storage not available' });
        }

        const { stream, contentType, contentLength } = await storageStore.streamFile(key);

        // Set proper Content-Type (default to octet-stream, not audio/wav which was the old transcription default)
        res.setHeader('Content-Type', contentType || 'application/octet-stream');
        if (contentLength) res.setHeader('Content-Length', contentLength);
        res.setHeader('Cache-Control', 'no-store');
        // Allow cross-origin image fetching (Azure AI, etc.)
        res.setHeader('Access-Control-Allow-Origin', '*');

        console.log(`[StorageProxy] Serving temp file: key=${key}, type=${contentType}, size=${contentLength || 'unknown'}`);
        stream.pipe(res);
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            return res.status(404).json({ error: 'File not found' });
        }
        console.error('[StorageProxy] Temp download error:', err.message);
        res.status(500).json({ error: 'Failed to retrieve file' });
    }
});

// Export the URL generator for use in transcription tools
router.generateTempDownloadUrl = generateTempDownloadUrl;

// GET /api/storage/file/* — stream a file from RustFS
router.get('/file/{*fileKey}', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        // Extract key from the wildcard path (everything after /file/)
        // path-to-regexp v8 returns wildcard params as an array of segments
        const rawKey = req.params.fileKey;
        let key = Array.isArray(rawKey) ? rawKey.join('/') : (rawKey || '');
        key = decodeURIComponent(key);
        
        // Express wildcard captures often include the leading slash, which breaks prefix checking!
        if (key.startsWith('/')) {
            key = key.substring(1);
        }
        if (!key) {
            return res.status(400).json({ error: 'File key required' });
        }

        // Security: user can only access their own files or shared assets
        const isOwnFile = key.startsWith(`users/${userId}/`);
        const isSharedFile = key.startsWith('shared/');
        if (!isOwnFile && !isSharedFile) {
            console.warn(`[StorageProxy] Access denied: sessionUserId="${userId}" key="${key}"`);
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
