/**
 * Webpage Public Shares — external/anonymous publishing of webpages.
 *
 * Separate from the internal Personal / Org / Groups visibility model on the
 * `webpages` table. A public share is an *immutable snapshot* of the page
 * (sanitized + stripped of internal bridges) addressable by a long random
 * token. Recipients are not Bee Flow users.
 *
 * Tables:
 *   • webpage_public_shares   — one row per external share link
 *   • webpage_public_share_views — append-only audit log per successful view
 *
 * Token model:
 *   • Raw token = base64url(32 bytes from crypto.randomBytes) — 256-bit entropy
 *   • Only sha256(token) is stored. The raw token is shown to the publisher
 *     exactly once at creation; lookup is by hash so a DB leak does not give
 *     an attacker working links.
 *   • Magic-link query parameter `k=...` (email-gated mode) is signed with
 *     HMAC by publicShareToken.js — separate concern from the share token.
 *
 * Access modes:
 *   • unlisted — token in URL is sufficient
 *   • password — argon2id-hashed password required, set by publisher
 *   • email    — recipient enters email from allowed list, receives magic link
 *
 * Expiry / revocation: expires_at can be NULL (no expiry); revoked_at flips
 * the row to dead permanently. Both are checked on every lookup.
 */

const crypto = require('crypto');
const argon2 = require('argon2');
const { run, getOne, getAll, exec } = require('../db');
const storageStore = require('./storageStore');

let initialized = false;

const ACCESS_MODES = ['unlisted', 'password', 'email'];

async function initDB() {
    if (initialized) return;

    await exec(`
        CREATE TABLE IF NOT EXISTS webpage_public_shares (
            id TEXT PRIMARY KEY,
            webpage_id TEXT NOT NULL REFERENCES webpages(id) ON DELETE CASCADE,
            created_by TEXT NOT NULL,
            organization_id TEXT,
            token_hash TEXT NOT NULL UNIQUE,
            access_mode TEXT NOT NULL DEFAULT 'unlisted',
            password_hash TEXT,
            allowed_emails JSONB,
            expires_at TIMESTAMPTZ,
            revoked_at TIMESTAMPTZ,
            snapshot_prefix TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            view_count INTEGER NOT NULL DEFAULT 0,
            last_viewed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_wpps_webpage ON webpage_public_shares(webpage_id);
        CREATE INDEX IF NOT EXISTS idx_wpps_created_by ON webpage_public_shares(created_by);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_wpps_token_hash ON webpage_public_shares(token_hash);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS webpage_public_share_views (
            id BIGSERIAL PRIMARY KEY,
            share_id TEXT NOT NULL REFERENCES webpage_public_shares(id) ON DELETE CASCADE,
            viewer_email TEXT,
            ip_hash TEXT,
            user_agent TEXT,
            viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_wppsv_share ON webpage_public_share_views(share_id, viewed_at DESC);
    `);

    initialized = true;
    console.log('[WebpagePublicShareStore] PostgreSQL initialized');
}

initDB().catch(err => console.error('[WebpagePublicShareStore] Init error:', err.message));

// ── Token helpers ───────────────────────────────────────────────────

function generateRawToken() {
    return crypto.randomBytes(32).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hashToken(raw) {
    return crypto.createHash('sha256').update(String(raw || ''), 'utf8').digest('hex');
}

function hashIp(ip) {
    if (!ip) return null;
    return crypto.createHash('sha256').update(String(ip), 'utf8').digest('hex').slice(0, 24);
}

// ── Snapshot storage layout ─────────────────────────────────────────
//
// Public-share snapshots live under a path NOT prefixed by the owner's user_id
// so the owner can be deleted/transferred without orphaning the public asset.
//   webpage-public-shares/{share_id}/index.html
//   webpage-public-shares/{share_id}/style.css
//   webpage-public-shares/{share_id}/script.js
//   webpage-public-shares/{share_id}/extras/{path}

function snapshotPrefix(shareId) {
    return `webpage-public-shares/${shareId}/`;
}

function snapshotKey(shareId, slot) {
    if (slot === 'html') return `${snapshotPrefix(shareId)}index.html`;
    if (slot === 'css')  return `${snapshotPrefix(shareId)}style.css`;
    if (slot === 'js')   return `${snapshotPrefix(shareId)}script.js`;
    return `${snapshotPrefix(shareId)}${slot}`;
}

function snapshotExtraKey(shareId, path) {
    return `${snapshotPrefix(shareId)}extras/${path}`;
}

// ── Row mappers ─────────────────────────────────────────────────────

function parseJSON(v, fallback) {
    if (Array.isArray(v) || (typeof v === 'object' && v !== null)) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
    return fallback;
}

function mapRow(r) {
    if (!r) return null;
    return {
        id: r.id,
        webpageId: r.webpage_id,
        createdBy: r.created_by,
        organizationId: r.organization_id || null,
        accessMode: r.access_mode,
        hasPassword: !!r.password_hash,
        allowedEmails: parseJSON(r.allowed_emails, null),
        expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
        revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
        snapshotPrefix: r.snapshot_prefix,
        title: r.title || '',
        viewCount: parseInt(r.view_count) || 0,
        lastViewedAt: r.last_viewed_at ? new Date(r.last_viewed_at).toISOString() : null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

// ── CRUD ────────────────────────────────────────────────────────────

/**
 * Create a new public share row. The raw token is returned to the caller
 * exactly once — only its hash is persisted. Caller is responsible for
 * writing the sanitized snapshot bytes (use webpageSnapshot.writeSnapshot).
 *
 * @param {object} args
 * @param {string} args.webpageId
 * @param {string} args.createdBy
 * @param {string|null} args.organizationId
 * @param {'unlisted'|'password'|'email'} args.accessMode
 * @param {string} [args.password] — raw password, hashed with argon2id
 * @param {string[]} [args.allowedEmails] — lowercased emails
 * @param {Date|null} args.expiresAt — null means no expiry
 * @param {string} args.title — human-readable label for the publisher's list
 */
async function createShare({ webpageId, createdBy, organizationId, accessMode, password, allowedEmails, expiresAt, title }) {
    await initDB();
    if (!ACCESS_MODES.includes(accessMode)) {
        throw new Error(`Invalid access mode: ${accessMode}`);
    }
    if (accessMode === 'password' && (!password || password.length < 6)) {
        throw new Error('Password must be at least 6 characters');
    }
    if (accessMode === 'email') {
        if (!Array.isArray(allowedEmails) || allowedEmails.length === 0) {
            throw new Error('At least one allowed email is required for email-gated shares');
        }
    }

    const id = crypto.randomUUID();
    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);
    const passwordHash = accessMode === 'password'
        ? await argon2.hash(password, { type: argon2.argon2id })
        : null;
    const emails = accessMode === 'email'
        ? allowedEmails.map(e => String(e).trim().toLowerCase()).filter(Boolean)
        : null;
    const prefix = snapshotPrefix(id);

    await run(
        `INSERT INTO webpage_public_shares
            (id, webpage_id, created_by, organization_id, token_hash, access_mode,
             password_hash, allowed_emails, expires_at, snapshot_prefix, title)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, webpageId, createdBy, organizationId || null, tokenHash, accessMode,
         passwordHash, emails ? JSON.stringify(emails) : null,
         expiresAt || null, prefix, title || '']
    );

    const row = await getOne('SELECT * FROM webpage_public_shares WHERE id = $1', [id]);
    return { share: mapRow(row), rawToken };
}

/**
 * List active and revoked/expired shares for a given webpage, owner-scoped.
 */
async function listSharesForWebpage(webpageId, createdBy) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM webpage_public_shares
         WHERE webpage_id = $1 AND created_by = $2
         ORDER BY created_at DESC`,
        [webpageId, createdBy]
    );
    return rows.map(mapRow);
}

async function getShareById(id) {
    await initDB();
    const r = await getOne('SELECT * FROM webpage_public_shares WHERE id = $1', [id]);
    return mapRow(r);
}

/**
 * Look up a share by raw token. Returns null if not found, revoked, or
 * expired. Bumps view_count + last_viewed_at when `recordView` is true and
 * the share is otherwise valid. Used by the public viewer route.
 */
async function findByToken(rawToken) {
    await initDB();
    if (!rawToken) return null;
    const tokenHash = hashToken(rawToken);
    const r = await getOne(
        `SELECT * FROM webpage_public_shares WHERE token_hash = $1`,
        [tokenHash]
    );
    if (!r) return null;
    const share = mapRow(r);
    if (share.revokedAt) return null;
    if (share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()) return null;
    // Include the password_hash on the returned row so the viewer can verify;
    // we don't surface it in mapRow's public shape.
    share._passwordHash = r.password_hash || null;
    return share;
}

/**
 * Verify a recipient-supplied password against the stored argon2 hash.
 */
async function verifyPassword(share, rawPassword) {
    if (!share || !share._passwordHash) return false;
    if (typeof rawPassword !== 'string' || !rawPassword) return false;
    try {
        return await argon2.verify(share._passwordHash, rawPassword);
    } catch (_) {
        return false;
    }
}

/**
 * Check whether `email` (case-insensitive) is on a share's allow-list.
 */
function isEmailAllowed(share, email) {
    if (!share || share.accessMode !== 'email') return false;
    if (!email || typeof email !== 'string') return false;
    const list = Array.isArray(share.allowedEmails) ? share.allowedEmails : [];
    return list.includes(email.trim().toLowerCase());
}

async function revokeShare(id, createdBy) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE webpage_public_shares
            SET revoked_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND created_by = $2 AND revoked_at IS NULL`,
        [id, createdBy]
    );
    return rowCount > 0;
}

async function updateExpiry(id, createdBy, expiresAt) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE webpage_public_shares
            SET expires_at = $1, updated_at = NOW()
          WHERE id = $2 AND created_by = $3 AND revoked_at IS NULL`,
        [expiresAt || null, id, createdBy]
    );
    return rowCount > 0;
}

async function recordView(shareId, { viewerEmail, ip, userAgent }) {
    await initDB();
    await run(
        `INSERT INTO webpage_public_share_views (share_id, viewer_email, ip_hash, user_agent)
         VALUES ($1, $2, $3, $4)`,
        [shareId, viewerEmail || null, hashIp(ip), (userAgent || '').slice(0, 500)]
    );
    await run(
        `UPDATE webpage_public_shares
            SET view_count = view_count + 1, last_viewed_at = NOW()
          WHERE id = $1`,
        [shareId]
    );
}

/**
 * Purge a share's RustFS objects. Called from the public-shares delete route
 * and from the parent webpage's ON DELETE CASCADE cleanup.
 */
async function purgeSnapshotObjects(shareId) {
    if (!storageStore.isAvailable()) return 0;
    const prefix = snapshotPrefix(shareId);
    try {
        const keys = await storageStore.listKeys(prefix);
        for (const k of keys) {
            try { await storageStore.deleteFile(k); } catch (_) {}
        }
        return keys.length;
    } catch (err) {
        console.warn('[WebpagePublicShareStore] Purge failed:', err.message);
        return 0;
    }
}

async function deleteShare(id, createdBy) {
    await initDB();
    const share = await getShareById(id);
    if (!share || share.createdBy !== createdBy) return false;
    await run('DELETE FROM webpage_public_shares WHERE id = $1', [id]);
    purgeSnapshotObjects(id).catch(() => {});
    return true;
}

module.exports = {
    ACCESS_MODES,
    createShare,
    listSharesForWebpage,
    getShareById,
    findByToken,
    verifyPassword,
    isEmailAllowed,
    revokeShare,
    updateExpiry,
    recordView,
    deleteShare,
    purgeSnapshotObjects,
    snapshotKey,
    snapshotExtraKey,
    snapshotPrefix,
    hashToken,
};
