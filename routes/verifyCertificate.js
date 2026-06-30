// Public certificate verification — unauthenticated /verify/:token.
//
// Mounted before the SPA catch-all in index.js. Resolves a Bee Flow AI certificate
// from the public lookup index (only PUBLIC certs are indexed) and renders a small
// server-side page with og: meta so LinkedIn shows a rich preview. Also serves the
// certificate image (og:image) and a print PDF at the same token. Modeled on
// publicViewer.js: per-IP rate limiting, strict CSP, no React/LicenseProvider, and
// it NEVER exposes the recipient's email.

const express = require('express');
const router = express.Router();

const certStore = require('../stores/certificateStore');
const { tokenHash } = require('../auth/certificateToken');
const { getPublicBaseUrl } = require('../learning/certificates');
const { renderCertificatePng, renderCertificatePdf } = require('../services/certificateRenderer');
const { perUserRateLimit } = require('../utils/perUserRateLimit');

const limiter = perUserRateLimit({ windowMs: 60_000, max: 60, keyFn: (req) => req.ip });

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); }
    catch (_) { return ''; }
}

function setSecurityHeaders(res) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
}

async function resolve(token) {
    if (!token || typeof token !== 'string' || token.length < 16) return null;
    try { return await certStore.resolveByTokenHash(tokenHash(token)); }
    catch (_) { return null; }
}

function notFoundPage(res) {
    setSecurityHeaders(res);
    return res.status(404).send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Certificate not found · Bee Flow</title><style>body{font-family:system-ui,sans-serif;background:#FFFDF7;color:#1A1A1A;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}div{max-width:420px;padding:24px}h1{color:#B45309}</style></head><body><div><h1>🐝 Certificate not found</h1><p>This verification link isn’t valid, or the certificate is no longer shared publicly.</p></div></body></html>`);
}

// ── Image (og:image) ──────────────────────────────────────────────────────────
router.get('/:token/image.png', limiter, async (req, res) => {
    const record = await resolve(req.params.token);
    if (!record || !record.isPublic) { res.status(404).end(); return; }
    try {
        const base = getPublicBaseUrl();
        const verifyUrl = base ? `${base}/verify/${req.params.token}` : null;
        const png = await renderCertificatePng(record, { verifyUrl });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.send(png);
    } catch (e) {
        console.error('[verify image] failed:', e.message);
        res.status(500).end();
    }
});

// ── PDF ───────────────────────────────────────────────────────────────────────
router.get('/:token/certificate.pdf', limiter, async (req, res) => {
    const record = await resolve(req.params.token);
    if (!record || !record.isPublic) { res.status(404).end(); return; }
    try {
        const base = getPublicBaseUrl();
        const verifyUrl = base ? `${base}/verify/${req.params.token}` : null;
        const pdf = await renderCertificatePdf(record, { verifyUrl });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="beeflow-certificate-${record.serial}.pdf"`);
        res.send(pdf);
    } catch (e) {
        console.error('[verify pdf] failed:', e.message);
        res.status(500).end();
    }
});

// ── Verify page (HTML + og: meta) ───────────────────────────────────────────────
router.get('/:token', limiter, async (req, res) => {
    const record = await resolve(req.params.token);
    if (!record || !record.isPublic) return notFoundPage(res);

    const base = getPublicBaseUrl();
    const imgUrl = base ? `${base}/verify/${req.params.token}/image.png` : `/verify/${req.params.token}/image.png`;
    const pdfUrl = `/verify/${req.params.token}/certificate.pdf`;
    const courses = (record.courses || []).map((c) => `<li>${esc(c.title)}</li>`).join('');
    const desc = `${esc(record.recipientName)} earned the ${esc(record.title)} certificate from Bee Flow.`;

    setSecurityHeaders(res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(record.title)} · Bee Flow</title>
<meta property="og:title" content="${esc(record.title)}"/>
<meta property="og:description" content="${esc(desc)}"/>
<meta property="og:type" content="website"/>
<meta property="og:image" content="${esc(imgUrl)}"/>
<meta name="twitter:card" content="summary_large_image"/>
<style>
  body{font-family:Helvetica,Arial,sans-serif;background:radial-gradient(circle at 50% 0%,#FFF3D6,#FFFDF7 60%);color:#1A1A1A;margin:0;padding:32px 16px;}
  .card{max-width:760px;margin:0 auto;background:#fff;border:1px solid #E9C877;border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(180,83,9,.12)}
  .badge{background:#ECFDF5;color:#15803d;font-weight:700;font-size:13px;padding:10px 16px;text-align:center;border-bottom:1px solid #D1FAE5}
  .img{display:block;width:100%;height:auto;background:#FFFDF7}
  .meta{padding:22px 26px}
  .meta h1{font-size:20px;color:#B45309;margin:0 0 4px}
  .meta .who{font-size:15px;color:#1A1A1A;margin:0 0 2px}
  .meta .org{color:#6B7280;font-size:13px;margin:0}
  ul{margin:14px 0 0;padding-left:18px;color:#374151;font-size:14px}
  .foot{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-top:18px;font-size:12.5px;color:#6B7280}
  a.dl{color:#B45309;font-weight:700;text-decoration:none}
</style></head>
<body>
  <div class="card">
    <div class="badge">✓ Verified — issued by Bee Flow B.V.</div>
    <img class="img" src="${esc(imgUrl)}" alt="${esc(record.title)} certificate"/>
    <div class="meta">
      <h1>${esc(record.title)}${record.level ? ` · ${esc(record.level)}` : ''}</h1>
      <p class="who">Awarded to <strong>${esc(record.recipientName)}</strong></p>
      ${record.orgName ? `<p class="org">${esc(record.orgName)}</p>` : ''}
      <ul>${courses}</ul>
      <div class="foot">
        <span>Issued ${esc(fmtDate(record.issuedAt))} · Serial ${esc(record.serial)}</span>
        <a class="dl" href="${esc(pdfUrl)}">Download PDF</a>
      </div>
    </div>
  </div>
</body></html>`);
});

module.exports = router;
