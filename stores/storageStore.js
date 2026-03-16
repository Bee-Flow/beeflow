/**
 * Storage Store — S3-compatible client for RustFS object storage
 * 
 * Provides file upload, download (presigned URLs), and deletion.
 * Uses per-user key prefixes for file isolation.
 */

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');
const { Readable } = require('stream');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET = 'beeflow-media';
const DEFAULT_EXPIRY = 3600; // 1 hour

let s3 = null;

/**
 * Initialize the S3 client and ensure the bucket exists.
 * Called during server startup.
 */
async function init() {
    const endpoint = process.env.RUSTFS_ENDPOINT;
    const accessKey = process.env.RUSTFS_ACCESS_KEY;
    const secretKey = process.env.RUSTFS_SECRET_KEY;

    if (!endpoint || !accessKey || !secretKey) {
        console.warn('[StorageStore] RustFS not configured — file storage will fall back to local disk.');
        return false;
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
            console.error('[StorageStore] Failed to check bucket:', err.message);
            s3 = null;
            return false;
        }
    }

    console.log(`[StorageStore] Connected to RustFS at ${endpoint}`);
    return true;
}

/**
 * Check if RustFS storage is available.
 */
function isAvailable() {
    return s3 !== null;
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
 * Upload a file to RustFS.
 * @param {string} key - S3 object key (use buildKey() to generate)
 * @param {Buffer} buffer - File content
 * @param {string} contentType - MIME type (e.g. 'image/png', 'video/mp4')
 * @returns {{ key: string }} Uploaded object key
 */
async function uploadFile(key, buffer, contentType) {
    if (!s3) throw new Error('StorageStore not initialized');

    await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType,
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
 * @returns {{ stream: Readable, contentType: string, contentLength: number }}
 */
async function streamFile(key) {
    if (!s3) throw new Error('StorageStore not initialized');

    const response = await s3.send(new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
    }));

    return {
        stream: response.Body,
        contentType: response.ContentType || 'application/octet-stream',
        contentLength: response.ContentLength,
    };
}

/**
 * Build a proxy URL for a stored file.
 * @param {string} key - S3 object key
 * @returns {string} Proxy URL path
 */
function buildProxyUrl(key) {
    return `/api/storage/file/${encodeURIComponent(key)}`;
}

module.exports = {
    init,
    isAvailable,
    buildKey,
    uploadFile,
    getPresignedUrl,
    streamFile,
    buildProxyUrl,
    deleteFile,
    BUCKET,
};
