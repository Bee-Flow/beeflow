/**
 * Storage Store — S3-compatible client for RustFS object storage,
 * with a local-disk fallback for dev environments without S3 infra.
 *
 * Two modes:
 *   's3'    — full feature set (presigned URLs, bucket listing, copy)
 *   'local' — uploadFile / streamFile / deleteFile only. Suitable for
 *             dev / single-host installs. Files land under
 *             server/data/storage/<key>; content types are persisted
 *             in a sidecar .meta file so streamFile can return the
 *             right MIME without re-guessing.
 */

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');
const { Readable } = require('stream');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const path = require('path');

const BUCKET = process.env.S3_BUCKET || 'beeflow-media';
const DEFAULT_EXPIRY = 3600; // 1 hour

let s3 = null;
let mode = null;          // null until init() runs; then 's3' | 'local'
let localRoot = null;     // absolute path to server/data/storage when mode==='local'

// Resolve a storage key to its on-disk path while guarding against
// path-traversal. Throws if the resolved path escapes localRoot.
function localPathFor(key) {
    if (!localRoot) throw new Error('StorageStore: local mode not initialized');
    if (typeof key !== 'string' || !key) throw new Error('StorageStore: invalid key');
    const resolved = path.resolve(localRoot, key);
    const rootWithSep = localRoot.endsWith(path.sep) ? localRoot : localRoot + path.sep;
    if (resolved !== localRoot && !resolved.startsWith(rootWithSep)) {
        throw new Error('StorageStore: key escapes storage root');
    }
    return resolved;
}

// Minimal extension → MIME map for fallback when no sidecar is present.
// Covers the common image types used by the CMS upload flow.
const MIME_BY_EXT = {
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.avif': 'image/avif',
};

/**
 * Initialize the S3 client and ensure the bucket exists.
 * Called during server startup.
 */
async function init() {
    const endpoint = process.env.RUSTFS_ENDPOINT;
    const accessKey = process.env.RUSTFS_ACCESS_KEY;
    const secretKey = process.env.RUSTFS_SECRET_KEY;

    if (!endpoint || !accessKey || !secretKey) {
        // Local-disk fallback. Enables uploadFile / streamFile / deleteFile
        // for dev environments where setting up RustFS / S3 isn't worth it.
        // Other features that require presigned URLs or bucket listing stay
        // gated and will throw "local mode doesn't support …" on use.
        try {
            localRoot = path.resolve(__dirname, '..', 'data', 'storage');
            fs.mkdirSync(localRoot, { recursive: true });
            mode = 'local';
            console.warn(`[StorageStore] RustFS not configured — using local-disk fallback at ${localRoot}`);
            return true;
        } catch (err) {
            console.error(`[StorageStore] Local fallback init failed: ${err.message}`);
            localRoot = null;
            mode = null;
            return false;
        }
    }

    s3 = new S3Client({
        endpoint,
        region: 'us-east-1', // Required by SDK but ignored by RustFS
        credentials: {
            accessKeyId: accessKey,
            secretAccessKey: secretKey,
        },
        forcePathStyle: true, // Required for non-AWS S3 (RustFS, MinIO)
    });

    // Ensure bucket exists
    try {
        await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
        console.log(`[StorageStore] Bucket "${BUCKET}" exists`);
    } catch (err) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
            console.log(`[StorageStore] Creating bucket "${BUCKET}"...`);
            await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
            console.log(`[StorageStore] Bucket "${BUCKET}" created`);
        } else {
            console.error(`[StorageStore] Failed to check bucket: ${err.name} — ${err.message}`);
            console.error(`[StorageStore] HTTP status: ${err.$metadata?.httpStatusCode}, endpoint: ${endpoint}`);
            s3 = null;
            return false;
        }
    }

    mode = 's3';
    console.log(`[StorageStore] Connected to RustFS at ${endpoint}`);
    return true;
}

/**
 * Check if storage is available — true when EITHER S3 is connected OR the
 * local-disk fallback is set up. Callers (e.g. /api/cms/admin/upload) gate
 * on this before accepting uploads.
 */
function isAvailable() {
    return mode !== null;
}

/**
 * Build a storage key with user-scoped prefix.
 * @param {string} userId - User ID for isolation
 * @param {string} category - File category: 'images', 'videos', 'audio', 'uploads', 'avatars'
 * @param {string} filename - The filename
 */
function buildKey(userId, category, filename) {
    if (category === 'avatars') {
        return `shared/avatars/${filename}`;
    }
    return `users/${userId}/${category}/${filename}`;
}

/**
 * Build a deterministic key for a webpage file slot.
 * Used by the Webpages feature to host index.html / style.css / script.js
 * (and their version snapshots) in RustFS at predictable paths.
 *
 * The 'db' slot stores a per-webpage SQLite database alongside the script
 * files — the engine runs server-side; this is just the at-rest blob.
 *
 * @param {string} userId
 * @param {string} webpageId
 * @param {'html'|'css'|'js'|'db'} slot
 * @param {string} [versionId] — when present, returns the version path
 */
function buildWebpageKey(userId, webpageId, slot, versionId = null) {
    const filename =
        slot === 'html' ? 'index.html' :
        slot === 'css'  ? 'style.css'  :
        slot === 'js'   ? 'script.js'  :
        slot === 'db'   ? 'data.db'    :
        null;
    if (!filename) throw new Error(`Unknown webpage slot: ${slot}`);
    const prefix = versionId
        ? `users/${userId}/webpages/${webpageId}/versions/${versionId}`
        : `users/${userId}/webpages/${webpageId}/current`;
    return `${prefix}/${filename}`;
}

/**
 * List all keys under a prefix (used to purge a webpage's entire object tree on delete).
 * Returns an array of keys.
 */
async function listKeys(prefix) {
    if (!s3) throw new Error('StorageStore not initialized');
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const keys = [];
    let continuationToken;
    do {
        const r = await s3.send(new ListObjectsV2Command({
            Bucket: BUCKET,
            Prefix: prefix,
            ContinuationToken: continuationToken,
        }));
        for (const obj of (r.Contents || [])) keys.push(obj.Key);
        continuationToken = r.IsTruncated ? r.NextContinuationToken : null;
    } while (continuationToken);
    return keys;
}

/**
 * Server-side copy of one object to another key. Used for snapshotting
 * a webpage's "current" trio into a versions/{vid}/ prefix without
 * round-tripping bytes through Node.
 */
async function copyObject(sourceKey, destKey) {
    if (mode === 'local') {
        const src = localPathFor(sourceKey);
        const dst = localPathFor(destKey);
        if (!fs.existsSync(src)) {
            // Mirror the S3 NoSuchKey shape so callers can use the same handling.
            const err = new Error(`NoSuchKey: ${sourceKey}`);
            err.name = 'NoSuchKey';
            err.$metadata = { httpStatusCode: 404 };
            throw err;
        }
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        // Carry the content-type and tags sidecars so streamFile returns the
        // same MIME on the copy. Best-effort — missing sidecars are fine.
        for (const ext of ['.meta', '.tags']) {
            if (fs.existsSync(src + ext)) {
                try { fs.copyFileSync(src + ext, dst + ext); } catch (_) { /* ignore */ }
            }
        }
        return;
    }
    if (!s3) throw new Error('StorageStore not initialized');
    const { CopyObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new CopyObjectCommand({
        Bucket: BUCKET,
        CopySource: `/${BUCKET}/${encodeURIComponent(sourceKey).replace(/%2F/g, '/')}`,
        Key: destKey,
    }));
}

/**
 * Upload a file to RustFS.
 * @param {string} key - S3 object key (use buildKey() to generate)
 * @param {Buffer} buffer - File content
 * @param {string} contentType - MIME type (e.g. 'image/png', 'video/mp4')
 * @param {Object} [metadata] - Optional flat string map persisted alongside
 *   the object. In S3 mode it lands in user-defined metadata (returned by
 *   HEAD/GET as `x-amz-meta-*`). In local mode it's written to a `.tags`
 *   sidecar next to the bytes. Used today to flag SVGs as sanitized.
 * @returns {{ key: string }} Uploaded object key
 */
async function uploadFile(key, buffer, contentType, metadata = null) {
    if (mode === 'local') {
        const filePath = localPathFor(key);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, buffer);
        // Sidecar holds the content type so streamFile can return the right
        // MIME without re-guessing from the extension.
        if (contentType) {
            try { fs.writeFileSync(filePath + '.meta', String(contentType), 'utf8'); }
            catch (_) { /* non-fatal — extension fallback covers this */ }
        }
        if (metadata && typeof metadata === 'object' && Object.keys(metadata).length > 0) {
            try { fs.writeFileSync(filePath + '.tags', JSON.stringify(metadata), 'utf8'); }
            catch (_) { /* non-fatal */ }
        }
        console.log(`[StorageStore:local] Uploaded: ${key} (${(buffer.length / 1024).toFixed(1)} KB)`);
        return { key };
    }
    if (!s3) throw new Error('StorageStore not initialized');

    await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        ...(metadata && typeof metadata === 'object' && Object.keys(metadata).length > 0
            ? { Metadata: metadata }
            : {}),
    }));

    console.log(`[StorageStore] Uploaded: ${key} (${(buffer.length / 1024).toFixed(1)} KB)`);
    return { key };
}

/**
 * Generate a presigned download URL for a file.
 * @param {string} key - S3 object key
 * @param {number} expiresIn - URL lifetime in seconds (default: 1 hour)
 * @returns {string} Presigned URL
 */
async function getPresignedUrl(key, expiresIn = DEFAULT_EXPIRY) {
    if (mode === 'local') {
        // No signing in local mode — return the proxy URL. Callers that
        // truly need short-lived signed URLs (private buckets, etc.) need
        // S3 mode and should treat this as a soft fallback.
        return buildProxyUrl(key);
    }
    if (!s3) throw new Error('StorageStore not initialized');

    const url = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
    }), { expiresIn });

    return url;
}

/**
 * Delete a file from RustFS.
 * @param {string} key - S3 object key
 */
async function deleteFile(key) {
    if (mode === 'local') {
        const filePath = localPathFor(key);
        try { fs.unlinkSync(filePath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        try { fs.unlinkSync(filePath + '.meta'); } catch (_) { /* ignore */ }
        try { fs.unlinkSync(filePath + '.tags'); } catch (_) { /* ignore */ }
        console.log(`[StorageStore:local] Deleted: ${key}`);
        return;
    }
    if (!s3) throw new Error('StorageStore not initialized');

    await s3.send(new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: key,
    }));

    console.log(`[StorageStore] Deleted: ${key}`);
}

/**
 * Stream a file from RustFS.
 * @param {string} key - S3 object key
 * @returns {{ stream: Readable, contentType: string, contentLength: number, metadata: Object }}
 *   `metadata` is the same flat string map passed to uploadFile (read back
 *   from S3 user-metadata or the .tags sidecar). Always an object — empty
 *   when nothing was stored.
 */
async function streamFile(key) {
    if (mode === 'local') {
        const filePath = localPathFor(key);
        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch (err) {
            if (err.code === 'ENOENT') {
                // Surface the same shape S3 throws on miss so the asset
                // route's existing 404 branch catches it.
                const e = new Error(`Object not found: ${key}`);
                e.name = 'NoSuchKey';
                throw e;
            }
            throw err;
        }
        // Sidecar wins; fall back to extension lookup; finally octet-stream.
        let contentType = 'application/octet-stream';
        try {
            const meta = fs.readFileSync(filePath + '.meta', 'utf8').trim();
            if (meta) contentType = meta;
        } catch (_) { /* no sidecar */ }
        if (contentType === 'application/octet-stream') {
            const ext = path.extname(filePath).toLowerCase();
            if (MIME_BY_EXT[ext]) contentType = MIME_BY_EXT[ext];
        }
        let metadata = {};
        try {
            const raw = fs.readFileSync(filePath + '.tags', 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') metadata = parsed;
        } catch (_) { /* no sidecar */ }
        return {
            stream: fs.createReadStream(filePath),
            contentType,
            contentLength: stat.size,
            metadata,
        };
    }
    if (!s3) throw new Error('StorageStore not initialized');

    const response = await s3.send(new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
    }));

    return {
        stream: response.Body,
        contentType: response.ContentType || 'application/octet-stream',
        contentLength: response.ContentLength,
        metadata: response.Metadata || {},
    };
}

/**
 * Build a proxy URL for a stored file.
 * @param {string} key - S3 object key
 * @returns {string} Proxy URL path
 */
function buildProxyUrl(key) {
    // Encode each path segment individually so slashes remain real /
    // (avoids %2F issues with nginx proxy and browser URL handling)
    return `/api/storage/file/${key.split('/').map(encodeURIComponent).join('/')}`;
}

module.exports = {
    init,
    isAvailable,
    buildKey,
    buildWebpageKey,
    uploadFile,
    getPresignedUrl,
    streamFile,
    buildProxyUrl,
    deleteFile,
    listKeys,
    copyObject,
    BUCKET,
};
