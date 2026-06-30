/**
 * Public Webpage Viewer — unauthenticated route at /share/:token.
 *
 * This is the only route in the app that serves user-supplied HTML to
 * anonymous visitors, so it carries the bulk of the external-publishing
 * security surface. Defence layers (all active simultaneously):
 *
 *   1. Token entropy        — 256 bits, lookup by sha256, so a leaked DB
 *                             dump doesn't yield working URLs.
 *   2. Rate limiting        — per-IP and per-token caps on the /share prefix
 *                             slow scraping and brute-forcing.
 *   3. Access gating        — unlisted (token only), password (argon2id),
 *                             or email-allowlist with HMAC magic links.
 *   4. Sanitization         — already applied at snapshot time
 *                             (webpageSnapshot.js). The bytes stored under
 *                             webpage-public-shares/{id}/ are pre-cleaned.
 *   5. Iframe sandbox       — `sandbox="allow-scripts allow-forms"` on the
 *                             outer content frame. No `allow-same-origin`,
 *                             so the document gets an opaque origin and
 *                             cannot reach back into the host page. The
 *                             user's HTML is pre-sanitized at snapshot
 *                             time (no <script>, no on* handlers, no
 *                             javascript: URLs), so allow-scripts only
 *                             benefits whitelisted nested iframes (the
 *                             Bee Flow chat embed at /chat/<agentId>),
 *                             which run with their own real origin and
 *                             their own CSP. DOMPurify is the trust
 *                             boundary for the outer document.
 *   6. Strict CSP           — default-src 'none' with narrow allowlist;
 *                             frame-ancestors 'none' to block embedding.
 *   7. Cookie isolation     — unlock cookie is scoped to /share, HttpOnly,
 *                             SameSite=Lax, and bound to share ID + HMAC.
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const publicShareStore = require('../stores/webpagePublicShareStore');
const webpageSnapshot = require('../services/webpageSnapshot');
const publicShareToken = require('../auth/publicShareToken');
const userStore = require('../stores/userStore');
const { sendServiceEmail } = require('../utils/emailService');

// ── Rate limits ─────────────────────────────────────────────────────
//
// Two-tier: a permissive cap on the viewer GET so legitimate readers can
// load assets, and a tight cap on unlock-form POSTs to throttle brute force.

const viewLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many requests. Please try again in a minute.',
});

const unlockLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many unlock attempts. Please try again in a minute.',
});

// ── Response helpers ────────────────────────────────────────────────

const UNLOCK_COOKIE_NAME = 'bf_unlock';

function setSecurityHeaders(res, { allowFraming = false, nonce = '' } = {}) {
    // Strict CSP for the chrome page. The iframe inside gets its own meta CSP
    // via composeViewerIframeDoc(); the sandbox is the primary script barrier.
    const csp = [
        "default-src 'none'",
        `script-src 'self' 'nonce-${nonce}'`,
        `style-src 'self' 'nonce-${nonce}' 'unsafe-inline'`,
        "img-src 'self' data: https:",
        "font-src 'self' data:",
        "frame-src 'self' data:",
        "connect-src 'self'",
        "form-action 'self'",
        "base-uri 'none'",
        allowFraming ? null : "frame-ancestors 'none'",
    ].filter(Boolean).join('; ');
    res.setHeader('Content-Security-Policy', csp);
    if (!allowFraming) res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
}

function htmlEscape(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function isHttpsRequest(req) {
    if (req.secure) return true;
    const xf = req.headers['x-forwarded-proto'];
    return typeof xf === 'string' && xf.split(',')[0].trim().toLowerCase() === 'https';
}

function setUnlockCookie(req, res, shareId, email) {
    const token = publicShareToken.issueUnlockCookie({ shareId, email });
    res.cookie(UNLOCK_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: isHttpsRequest(req),
        path: '/share',
        maxAge: publicShareToken.UNLOCK_COOKIE_TTL_MS,
    });
}

function getUnlockClaim(req, shareId) {
    const cookieHeader = req.headers.cookie || '';
    const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${UNLOCK_COOKIE_NAME}=([^;]+)`));
    if (!m) return null;
    return publicShareToken.verifyUnlockCookie(decodeURIComponent(m[1]), shareId);
}

// ── Chrome + iframe document composition ───────────────────────────

const FOOTER_REPORT_EMAIL = process.env.PUBLIC_SHARE_ABUSE_EMAIL || 'info@beeflow.nl';

function composeViewerChrome({ share, publisher, nonce, rawToken }) {
    // Server-rendered HTML page. No client JS bundle is loaded.
    const title = htmlEscape(share.title || 'Shared page');
    const publisherName = htmlEscape(publisher?.name || publisher?.displayName || 'a Bee Flow user');
    const publisherOrg = htmlEscape(publisher?.orgName || '');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<style nonce="${nonce}">
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif; background: #f6f7f9; color: #111827; }
  .bf-header { display:flex; align-items:center; gap:10px; padding:10px 16px; border-bottom:1px solid rgba(0,0,0,.08); background:#fff; color:#111827; }
  .bf-brand { font-weight:700; letter-spacing:.2px; display:flex; align-items:center; gap:6px; }
  .bf-bee { width:28px; height:28px; border-radius:6px; object-fit:contain; display:block; }
  .bf-title { font-weight:600; font-size:14px; opacity:.9; margin-left:6px; }
  .bf-spacer { flex:1; }
  .bf-meta { font-size:12px; opacity:.65; }
  .bf-frame-wrap { height: calc(100% - 92px); padding: 12px; }
  .bf-frame { width:100%; height:100%; border:1px solid rgba(0,0,0,.08); border-radius:10px; background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.04); }
  .bf-footer { padding: 8px 16px; font-size: 12px; opacity:.65; text-align:center; color:#111827; background:#f6f7f9; }
  .bf-footer a { color: inherit; }
</style>
</head>
<body>
<header class="bf-header">
  <span class="bf-brand">
    <img class="bf-bee" src="/share/_brand/icon.svg" alt="" aria-hidden="true">
    Bee Flow
  </span>
  <span class="bf-title">${title}</span>
  <span class="bf-spacer"></span>
  <span class="bf-meta">Shared by ${publisherName}${publisherOrg ? ' · ' + publisherOrg : ''}</span>
</header>
<main class="bf-frame-wrap">
  <iframe class="bf-frame" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" src="/share/${encodeURIComponent(rawToken)}/content"></iframe>
</main>
<footer class="bf-footer">
  This page was shared via Bee Flow.
  <a href="mailto:${htmlEscape(FOOTER_REPORT_EMAIL)}?subject=${encodeURIComponent('Report public share ' + share.id)}">Report abuse</a>
</footer>
</body>
</html>`;
}

function composeIframeContent({ html, css, rawToken }) {
    // Build a self-contained document. Inline CSS in <style> so we don't have
    // to add another fetch round-trip. No <script> ever, regardless of source.
    // Inline meta CSP belt-and-braces: even inside the sandboxed iframe we
    // forbid scripts entirely.
    //
    // <base href> points relative URLs at the extras prefix so that
    // <img src="logo.png"> in the user's HTML resolves to
    // /share/:token/extras/logo.png. The sandbox has an opaque origin so the
    // browser performs a CORS-less GET against our same-origin route, which
    // returns the snapshot bytes after re-checking the gate.
    const extrasBase = `/share/${encodeURIComponent(rawToken)}/extras/`;
    return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self' data: https: 'unsafe-inline'; script-src 'none'; object-src 'none'; frame-ancestors 'self';">
<base href="${extrasBase}" target="_blank">
<style>${css || ''}</style>
</head><body>
${html || ''}
</body></html>`;
}

function composeGate({ share, csrf, error, mode, nonce, rawToken }) {
    const isPassword = mode === 'password';
    const isEmail = mode === 'email';
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Enter ${isPassword ? 'password' : 'email'} — Bee Flow</title>
<style nonce="${nonce}">
  :root { color-scheme: light; }
  html, body { margin:0; min-height:100%; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif; background:#f6f7f9; color:#111827; }
  .wrap { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
  .card { width:100%; max-width:380px; background:#fff; border:1px solid rgba(0,0,0,.08); border-radius:14px; padding:24px; box-shadow:0 8px 32px rgba(0,0,0,.06); color:#111827; }
  h1 { font-size:18px; margin:0 0 4px; }
  p { margin:0 0 16px; font-size:13px; opacity:.7; }
  label { display:block; font-size:12px; margin:8px 0 4px; opacity:.8; }
  input { width:100%; padding:10px 12px; border-radius:8px; border:1px solid rgba(0,0,0,.15); background:#fff; color:#111827; font-size:14px; }
  button { width:100%; margin-top:14px; padding:10px 14px; border:0; border-radius:8px; background:#111827; color:#fff; font-weight:600; cursor:pointer; }
  .err { color:#b91c1c; font-size:13px; margin-top:10px; }
  .brand { display:flex; align-items:center; gap:8px; font-weight:700; margin-bottom:12px; }
  .bee { width:20px; height:20px; }
</style>
</head>
<body>
<div class="wrap"><div class="card">
  <div class="brand">
    <svg class="bee" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#f59e0b"/><path d="M6 12h12" stroke="#111827" stroke-width="1.4"/></svg>
    Bee Flow
  </div>
  <h1>${isPassword ? 'Enter password' : 'Verify your email'}</h1>
  <p>${isPassword
        ? 'This shared page is password-protected. Ask the sender if you don\'t have one.'
        : 'Enter the email you received this link from to continue. We\'ll send you a one-time access link.'}</p>
  <form method="POST" action="/share/${encodeURIComponent(rawToken)}/unlock" autocomplete="off">
    <input type="hidden" name="_csrf" value="${htmlEscape(csrf)}">
    ${isPassword ? `
      <label for="pw">Password</label>
      <input id="pw" name="password" type="password" required autofocus>
    ` : ''}
    ${isEmail ? `
      <label for="em">Email</label>
      <input id="em" name="email" type="email" required autofocus>
    ` : ''}
    <button type="submit">${isPassword ? 'Unlock' : 'Send link'}</button>
    ${error ? `<div class="err">${htmlEscape(error)}</div>` : ''}
  </form>
</div></div>
</body></html>`;
}

function composeMagicSent({ nonce }) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Check your email</title>
<style nonce="${nonce}">body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:#f6f7f9;color:#111827;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}.card{max-width:380px;background:#fff;border-radius:14px;padding:24px;border:1px solid rgba(0,0,0,.08);text-align:center}:root{color-scheme:light}</style>
</head><body><div class="card"><h2>Check your email</h2><p>If the address is on the allow-list, a one-time link is on its way. The link expires in 24 hours.</p></div></body></html>`;
}

function composeNotFound({ nonce }) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Link not available</title>
<style nonce="${nonce}">body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:#f6f7f9;color:#111827;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}.card{max-width:380px;background:#fff;border-radius:14px;padding:24px;border:1px solid rgba(0,0,0,.08);text-align:center}:root{color-scheme:light}</style>
</head><body><div class="card"><h2>Link not available</h2><p>This shared page is no longer accessible. It may have expired or been revoked by the sender.</p></div></body></html>`;
}

// ── Routes ──────────────────────────────────────────────────────────

// Brand icon — same asset as the collapsed sidebar in the app, so external
// recipients see a consistent Bee Flow mark. Loaded once at module init and
// served with an immutable cache header so the rate limiter below never
// sees repeat fetches from the same browser. Registered BEFORE viewLimiter
// so the static asset never consumes a share-viewer rate budget.
const BRAND_ICON_PATH = path.resolve(__dirname, '../assets/brand/bee-icon.svg');
const BRAND_ICON_BUF = fs.readFileSync(BRAND_ICON_PATH);
const BRAND_ICON_ETAG = '"' + crypto.createHash('sha256').update(BRAND_ICON_BUF).digest('base64').slice(0, 27) + '"';

router.get('/_brand/icon.svg', (req, res) => {
    if (req.headers['if-none-match'] === BRAND_ICON_ETAG) {
        return res.status(304).end();
    }
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('ETag', BRAND_ICON_ETAG);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(BRAND_ICON_BUF);
});

router.use(viewLimiter);

// Body parser for the unlock form — we need urlencoded form bodies but no
// JSON. Limit aggressively so this endpoint can't be used as a sink.
const formParser = express.urlencoded({ extended: false, limit: '4kb' });

// Helper: look up share by raw token, send 404 page if missing/expired.
async function resolveShareOr404(req, res) {
    const rawToken = req.params.token;
    if (!rawToken || rawToken.length < 16 || rawToken.length > 128) {
        const nonce = crypto.randomBytes(12).toString('base64');
        setSecurityHeaders(res, { nonce });
        res.status(404).type('html').send(composeNotFound({ nonce }));
        return null;
    }
    const share = await publicShareStore.findByToken(rawToken);
    if (!share) {
        const nonce = crypto.randomBytes(12).toString('base64');
        setSecurityHeaders(res, { nonce });
        res.status(404).type('html').send(composeNotFound({ nonce }));
        return null;
    }
    return { share, rawToken };
}

// Race a promise against a timeout. Returns `fallback` if `ms` ms elapse
// before the promise settles. Used so a slow DB query never holds the
// public-viewer response open for tens of seconds — the chrome can be
// rendered without publisher metadata if userStore is unreachable.
function withTimeout(p, ms, fallback) {
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve(fallback), ms);
        Promise.resolve(p).then(
            (v) => { clearTimeout(t); resolve(v); },
            () => { clearTimeout(t); resolve(fallback); }
        );
    });
}

async function lookupPublisher(share) {
    const PUBLISHER_TIMEOUT_MS = 3000;
    const fallback = { name: 'a Bee Flow user', orgName: '' };
    const u = await withTimeout(userStore.getUser(share.createdBy), PUBLISHER_TIMEOUT_MS, null);
    if (!u) return fallback;
    let orgName = '';
    if (share.organizationId && typeof userStore.getAllOrganizations === 'function') {
        const orgs = await withTimeout(
            userStore.getAllOrganizations(),
            PUBLISHER_TIMEOUT_MS,
            null
        );
        const org = Array.isArray(orgs) ? orgs.find(o => o.id === share.organizationId) : null;
        if (org?.name) orgName = org.name;
    }
    return { name: u.name || u.displayName || u.email || 'a Bee Flow user', orgName };
}

// GET /share/:token — chrome + gate (or direct content if unlocked / unlisted).
router.get('/:token', async (req, res) => {
    try {
        const ctx = await resolveShareOr404(req, res);
        if (!ctx) return;
        const { share, rawToken } = ctx;
        const nonce = crypto.randomBytes(12).toString('base64');

        // Magic-link redemption: ?k=<signed payload>
        if (req.query.k && share.accessMode === 'email') {
            const claim = publicShareToken.verifyMagicLink(String(req.query.k), share.id);
            if (claim && publicShareStore.isEmailAllowed(share, claim.email)) {
                setUnlockCookie(req, res, share.id, claim.email);
                // Redirect to clean URL (strip the ?k param) so the link can't
                // be re-shared with the credential embedded.
                return res.redirect(302, `/share/${encodeURIComponent(rawToken)}`);
            }
        }

        // Unlisted: no gate. Show chrome directly.
        if (share.accessMode === 'unlisted') {
            return renderChrome(req, res, share, rawToken, nonce);
        }

        // Check unlock cookie for password / email modes.
        const unlock = getUnlockClaim(req, share.id);
        if (unlock) {
            // For email mode, double-check that the email is still on the
            // allow-list (publisher may have edited it since unlock).
            if (share.accessMode === 'email' && !publicShareStore.isEmailAllowed(share, unlock.email)) {
                // Drop the stale cookie and re-gate.
                res.clearCookie(UNLOCK_COOKIE_NAME, { path: '/share' });
            } else {
                return renderChrome(req, res, share, rawToken, nonce, unlock.email);
            }
        }

        // Gate required.
        setSecurityHeaders(res, { nonce });
        const csrf = publicShareToken.issueCsrf(share.id);
        return res.status(200).type('html').send(composeGate({
            share, csrf, mode: share.accessMode, nonce, rawToken,
        }));
    } catch (err) {
        console.error('[PublicViewer] GET failed:', err);
        const nonce = crypto.randomBytes(12).toString('base64');
        setSecurityHeaders(res, { nonce });
        res.status(500).type('html').send(composeNotFound({ nonce }));
    }
});

async function renderChrome(req, res, share, rawToken, nonce, viewerEmail) {
    const publisher = await lookupPublisher(share);
    setSecurityHeaders(res, { nonce });
    // Record an audit row per chrome render — distinct visits, not per asset.
    // Fire-and-forget with a 2s ceiling so a slow INSERT can never delay the
    // response. The bookkeeping is best-effort; missing rows are acceptable.
    withTimeout(
        publicShareStore.recordView(share.id, {
            viewerEmail: viewerEmail || null,
            ip: req.ip,
            userAgent: req.headers['user-agent'] || '',
        }),
        2000,
        null
    );
    res.status(200).type('html').send(composeViewerChrome({ share, publisher, nonce, rawToken }));
}

// GET /share/:token/content — the iframe-loaded content document. Same auth
// rules as the chrome page; we re-check on each request so the iframe
// cannot be hot-linked from another origin to bypass the gate.
router.get('/:token/content', async (req, res) => {
    try {
        const ctx = await resolveShareOr404(req, res);
        if (!ctx) return;
        const { share } = ctx;

        // Same gate logic as the chrome route (sans magic-link redemption,
        // which only makes sense at top-level navigation).
        if (share.accessMode !== 'unlisted') {
            const unlock = getUnlockClaim(req, share.id);
            if (!unlock) {
                return res.status(401).type('html').send('Unauthorized');
            }
            if (share.accessMode === 'email' && !publicShareStore.isEmailAllowed(share, unlock.email)) {
                return res.status(401).type('html').send('Unauthorized');
            }
        }

        // React-mui shares store a self-contained, server-bundled document
        // (inline ES module + esm.sh import map + STUBBED bridges). A React app
        // renders nothing without JS, so this branch RELAXES the iframe CSP to
        // allow inline scripts + esm.sh. The trust boundary stays the outer
        // sandbox: `allow-scripts allow-forms` with NO allow-same-origin, so the
        // executing JS runs in an opaque origin and cannot reach beeflow.nl
        // cookies/session. Live data bridges are stubbed at bundle time.
        if (share.snapshotKind === 'react') {
            const doc = await webpageSnapshot.readSnapshotSlot(share.id, 'reactdoc');
            const reactCsp = [
                "default-src 'self' data: https: 'unsafe-inline'",
                "script-src 'unsafe-inline' https://esm.sh",
                "style-src 'unsafe-inline' https:",
                "img-src 'self' data: https:",
                "font-src 'self' data: https:",
                "connect-src https:",
                "object-src 'none'",
                "frame-ancestors 'self'",
            ].join('; ');
            res.setHeader('Content-Security-Policy', reactCsp);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Referrer-Policy', 'no-referrer');
            res.setHeader('Cache-Control', 'private, no-store');
            return res.type('html').send(doc || composeIframeContent({ html: '', css: '', rawToken: ctx.rawToken }));
        }

        const [html, css] = await Promise.all([
            webpageSnapshot.readSnapshotSlot(share.id, 'html'),
            webpageSnapshot.readSnapshotSlot(share.id, 'css'),
        ]);

        // Iframe-specific CSP: stricter than the chrome page since this is
        // where untrusted user HTML lives. Sandbox already blocks scripts;
        // CSP belt-and-braces. Frame-ancestors limits it to our own origin
        // so other sites can't iframe-include the content document directly.
        const csp = [
            "default-src 'self' data: https:",
            "script-src 'none'",
            "style-src 'unsafe-inline'",
            "img-src 'self' data: https:",
            "font-src 'self' data: https:",
            "object-src 'none'",
            "frame-ancestors 'self'",
        ].join('; ');
        res.setHeader('Content-Security-Policy', csp);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cache-Control', 'private, no-store');
        res.type('html').send(composeIframeContent({ html, css, rawToken: ctx.rawToken }));
    } catch (err) {
        console.error('[PublicViewer] content GET failed:', err);
        res.status(500).type('text').send('Error');
    }
});

// GET /share/:token/extras/* — serve a sanitized/binary extra file from
// the snapshot. Same auth check as content. Express 5 requires a named
// wildcard for path-to-regexp, hence `:path(*)`.
router.get('/:token/extras/*path', async (req, res) => {
    try {
        const ctx = await resolveShareOr404(req, res);
        if (!ctx) return;
        const { share } = ctx;

        if (share.accessMode !== 'unlisted') {
            const unlock = getUnlockClaim(req, share.id);
            if (!unlock) return res.status(401).end();
            if (share.accessMode === 'email' && !publicShareStore.isEmailAllowed(share, unlock.email)) {
                return res.status(401).end();
            }
        }

        // Express 5 named splat captures into req.params.path (array of segments
        // for `*path`). Join segments with '/' to reconstruct the relative path.
        const raw = req.params.path;
        const subPath = Array.isArray(raw) ? raw.join('/') : String(raw || '');
        if (!subPath || subPath.includes('..') || subPath.startsWith('/')) {
            return res.status(400).end();
        }

        const obj = await webpageSnapshot.readSnapshotExtra(share.id, subPath);
        if (!obj) return res.status(404).end();

        res.setHeader('Content-Type', obj.contentType || 'application/octet-stream');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // Revalidate instead of blindly caching for 5 minutes: after an owner
        // re-snapshots an updated page, returning viewers were stuck with the old
        // extra assets (images/fonts) until the window lapsed (BFSF-190). An
        // ETag on the snapshot bytes lets unchanged assets still 304 cheaply.
        const _etag = obj.etag || (obj.bytes ? `"${require('crypto').createHash('sha1').update(obj.bytes).digest('hex')}"` : null);
        if (_etag) {
            res.setHeader('ETag', _etag);
            if (req.headers['if-none-match'] === _etag) return res.status(304).end();
        }
        res.setHeader('Cache-Control', 'private, no-cache, must-revalidate');
        res.send(obj.bytes);
    } catch (err) {
        console.error('[PublicViewer] extras GET failed:', err);
        res.status(500).end();
    }
});

// POST /share/:token/unlock — password or email gate submission.
router.post('/:token/unlock', unlockLimiter, formParser, async (req, res) => {
    try {
        const ctx = await resolveShareOr404(req, res);
        if (!ctx) return;
        const { share, rawToken } = ctx;
        const nonce = crypto.randomBytes(12).toString('base64');

        const csrfOk = publicShareToken.verifyCsrf(req.body?._csrf || '', share.id);
        if (!csrfOk) {
            setSecurityHeaders(res, { nonce });
            const csrf = publicShareToken.issueCsrf(share.id);
            return res.status(400).type('html').send(composeGate({
                share, csrf, mode: share.accessMode, nonce, rawToken,
                error: 'Session expired — please try again.',
            }));
        }

        if (share.accessMode === 'password') {
            const ok = await publicShareStore.verifyPassword(share, String(req.body?.password || ''));
            setSecurityHeaders(res, { nonce });
            if (!ok) {
                const csrf = publicShareToken.issueCsrf(share.id);
                return res.status(401).type('html').send(composeGate({
                    share, csrf, mode: 'password', nonce, rawToken,
                    error: 'Incorrect password.',
                }));
            }
            setUnlockCookie(req, res, share.id, null);
            return res.redirect(302, `/share/${encodeURIComponent(rawToken)}`);
        }

        if (share.accessMode === 'email') {
            const email = String(req.body?.email || '').trim().toLowerCase();
            const allowed = publicShareStore.isEmailAllowed(share, email);
            // Always render the "check your email" page — don't leak whether
            // the address was on the allow-list. Only actually send a mail
            // when it is allowed.
            if (allowed) {
                const magic = publicShareToken.issueMagicLink({ shareId: share.id, email });
                const base = process.env.PUBLIC_SHARE_BASE_URL
                    || `${req.protocol}://${req.get('host') || ''}`;
                const link = `${base.replace(/\/+$/, '')}/share/${encodeURIComponent(rawToken)}?k=${encodeURIComponent(magic)}`;
                sendServiceEmail({
                    to: email,
                    subject: `Your access link for "${share.title || 'shared page'}"`,
                    text: `Hi,\n\nYou requested access to "${share.title || 'a shared page'}" on Bee Flow.\n\nOpen this link to view it (expires in 24 hours):\n${link}\n\nIf you did not request this, you can ignore this email.\n\n— Bee Flow`,
                    html: `<p>Hi,</p><p>You requested access to <strong>${htmlEscape(share.title || 'a shared page')}</strong> on Bee Flow.</p><p><a href="${htmlEscape(link)}">Open the page</a> (link expires in 24 hours).</p><p>If you did not request this, you can ignore this email.</p><p>— Bee Flow</p>`,
                }).catch(err => console.warn('[PublicViewer] magic-link email failed:', err.message));
            }
            setSecurityHeaders(res, { nonce });
            return res.status(200).type('html').send(composeMagicSent({ nonce }));
        }

        // Unlisted shouldn't POST here — bounce to GET.
        return res.redirect(302, `/share/${encodeURIComponent(rawToken)}`);
    } catch (err) {
        console.error('[PublicViewer] unlock failed:', err);
        const nonce = crypto.randomBytes(12).toString('base64');
        setSecurityHeaders(res, { nonce });
        res.status(500).type('html').send(composeNotFound({ nonce }));
    }
});

module.exports = router;
